import { ByteSource } from './byteSource';
import { CodePage } from './codepage';
import { CursorProblem, CursorSettings, resolveSettings, unescapeLineRecord } from './recordCursor';
import { Cancellable, RecordIndex, ScanProgress } from './recordIndex';
import { ReadingOptions, RecordRow } from './types';

export interface SearchSpec {
    /** `text` is searched in the file's code page; `hex` is a byte string such as `40 C1 c2`. */
    kind: 'text' | 'hex';
    value: string;
    caseInsensitive?: boolean;
    /** First record to look at. */
    from?: number;
    /** Give up after this many matches, so a search for a space does not return the whole file. */
    limit?: number;
}

export interface SearchOutcome {
    /** Indexes of the matching records, in order. */
    matches: number[];
    /** False when the search stopped on the limit or on cancellation. */
    complete: boolean;
    /** Records looked at. */
    scanned: number;
    /** Said out loud rather than silently ignored - an unmappable character, mostly. */
    warning?: string;
}

export type SearchProgress = (scanned: number, matches: number) => void;

/**
 * A data file read as records: the object the editor talks to.
 *
 * It owns the file handle, the resolved reading options and the index, and is thrown away and rebuilt
 * when the user changes how the file should be read - which is the whole point of the settings panel,
 * and is cheap because nothing but the index was ever derived from the old options.
 */
export class RecordFile {
    private constructor(
        /** What the file is called, for the editor to show: a path, or a URI for a remote one. */
        readonly name: string,
        private readonly source: ByteSource,
        readonly options: ReadingOptions,
        readonly settings: CursorSettings,
        readonly codePage: CodePage,
        private readonly index: RecordIndex,
    ) {}

    /** A file on this machine's disk, read where it lies. */
    static async open(filePath: string, options: ReadingOptions): Promise<RecordFile> {
        return RecordFile.fromSource(filePath, await ByteSource.open(filePath), options);
    }

    /**
     * A file from wherever the caller got it - the disk, or the bytes of a file the editor fetched
     * over its own file system. The record layer never learns the difference.
     */
    static async fromSource(name: string, source: ByteSource, options: ReadingOptions): Promise<RecordFile> {
        try {
            const settings = await resolveSettings(source, options);
            const codePage = CodePage.resolve(options.codePage);
            return new RecordFile(name, source, options, settings, codePage, new RecordIndex(source, settings));
        } catch (error) {
            await source.close();
            throw error;
        }
    }

    async close(): Promise<void> {
        await this.source.close();
    }

    get size(): number { return this.source.size; }
    get knownCount(): number { return this.index.known; }
    get isCounted(): boolean { return this.index.isComplete; }
    get bytesScanned(): number { return this.index.bytesScanned; }
    get problem(): CursorProblem | undefined { return this.index.problem; }

    async ensureCount(count: number, progress?: ScanProgress, token?: Cancellable): Promise<void> {
        await this.index.ensure(count, progress, token);
    }

    async countAll(progress?: ScanProgress, token?: Cancellable): Promise<number> {
        await this.index.ensureAll(progress, token);
        return this.index.known;
    }

    /** `count` records from `first`, with their bytes. Short at the end of the file. */
    async read(first: number, count: number): Promise<RecordRow[]> {
        const raw = await this.index.slice(first, count);
        const rows: RecordRow[] = [];

        for (let i = 0; i < raw.length; i++) {
            const record = raw[i];
            let data = await this.source.read(record.offset, record.length);
            if (record.escaped) data = unescapeLineRecord(data);

            rows.push({ index: first + i, offset: record.offset, data, truncated: record.truncated });
        }

        return rows;
    }

    /** One record, or undefined past the end of the file. */
    async readOne(index: number): Promise<RecordRow | undefined> {
        return (await this.read(index, 1))[0];
    }

    /**
     * The records that carry `spec.value`, in file order.
     *
     * Text is matched on the decoded characters rather than on the bytes, which is what makes
     * "ignore case" mean anything at all on an EBCDIC file: the two cases are not one bit apart there
     * the way they are in ASCII.
     */
    async search(spec: SearchSpec, progress?: SearchProgress, token?: Cancellable): Promise<SearchOutcome> {
        const limit = spec.limit ?? 5000;
        const from = Math.max(0, spec.from ?? 0);

        let needleBytes: Buffer | undefined;
        let needleText: string | undefined;
        let warning: string | undefined;

        if (spec.kind === 'hex') {
            needleBytes = parseHex(spec.value);
            if (!needleBytes) return { matches: [], complete: true, scanned: 0, warning: 'Not a hexadecimal value.' };
        } else {
            const encoded = this.codePage.encode(spec.value);
            if (encoded.unmapped.length > 0) {
                warning = 'Code page ' + this.codePage.id + ' has no byte for '
                    + encoded.unmapped.map(ch => JSON.stringify(ch)).join(', ')
                    + '; a record containing it cannot exist in this file.';
            }
            needleText = spec.caseInsensitive ? spec.value.toUpperCase() : spec.value;
        }

        const matches: number[] = [];
        const { cursor, index: startedAt } = await this.index.cursorAt(from);

        let at = startedAt;
        let scanned = 0;
        let complete = true;

        for (;;) {
            const record = await cursor.next();
            if (record === null) break;

            let data = await this.source.read(record.offset, record.length);
            if (record.escaped) data = unescapeLineRecord(data);

            const hit = needleBytes
                ? data.includes(needleBytes)
                : hasText(this.codePage.decode(data), needleText!, spec.caseInsensitive === true);

            if (hit) {
                matches.push(at);
                if (matches.length >= limit) { complete = false; break; }
            }

            at++;
            scanned++;

            if (scanned % 5000 === 0) {
                progress?.(scanned, matches.length);
                if (token?.isCancellationRequested) { complete = false; break; }
            }
        }

        progress?.(scanned, matches.length);
        return { matches, complete, scanned, warning };
    }
}

function hasText(haystack: string, needle: string, caseInsensitive: boolean): boolean {
    return (caseInsensitive ? haystack.toUpperCase() : haystack).includes(needle);
}

/** `C1C2`, `c1 c2`, `0xC1,0xC2` - all the ways a hex string gets typed. Undefined if it is not one. */
export function parseHex(value: string): Buffer | undefined {
    const digits = value.replace(/0x/gi, '').replace(/[\s,:-]/g, '');
    if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(digits)) return undefined;

    return Buffer.from(digits, 'hex');
}
