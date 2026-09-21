import { ByteSource } from './byteSource';
import { CodePage } from './codepage';
import { ReadingOptions, SplitKind, VbHeaderFormat, splitKindOf } from './types';

/** One record as the file holds it: where its data starts, how long it is, and what was odd about it. */
export interface RawRecord {
    /** Offset of the record itself - its header, for a variable record. */
    start: number;
    /** Offset of the data. */
    offset: number;
    length: number;
    /** The record ends short of what its header or the record length promised. */
    truncated?: boolean;
    /** Line-sequential with escaping on: the data still carries its escape bytes. */
    escaped?: boolean;
}

/** Something the file does not say clearly. The cursor stops afterwards; the viewer shows the reason. */
export interface CursorProblem {
    offset: number;
    message: string;
}

/**
 * What a cursor needs, once the reading options have been resolved against the file: `auto` has become
 * a real header format, and the code page has become the two bytes line reading depends on.
 */
export interface CursorSettings {
    kind: SplitKind;
    recordLength: number;
    vbHeader: Exclude<VbHeaderFormat, 'auto'>;
    lineSeqEscape: boolean;
    lf: number;
    cr: number;
    ebcdic: boolean;
    startOffset: number;
}

/** A line with no terminator in this many bytes is not a line - see the scan below. */
const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Walks a file record by record, the way the runtime's own sequential read does
 * (RainCodeLegacyFileDriver's DotNetFH_IO): same headers, same alignment, same line terminators.
 *
 * It hands back offsets and lengths rather than data, because most of what the viewer does with it -
 * counting records, indexing, finding the page that holds record 40 000 - never needs the bytes.
 */
export class RecordCursor {
    private at: number;
    private failure: CursorProblem | undefined;

    constructor(private readonly source: ByteSource, private readonly settings: CursorSettings, start?: number) {
        this.at = start ?? settings.startOffset;
    }

    /** Where the next record will be read from. */
    get position(): number { return this.at; }

    /** Set once the file stopped making sense; the cursor returns null from then on. */
    get problem(): CursorProblem | undefined { return this.failure; }

    async next(): Promise<RawRecord | null> {
        if (this.failure) return null;
        if (this.at >= this.source.size) return null;

        switch (this.settings.kind) {
            case 'fixed': return this.nextFixed();
            case 'variable': return this.nextVariable();
            case 'line': return this.nextLine();
        }
    }

    private nextFixed(): RawRecord {
        const start = this.at;
        const wanted = Math.max(1, this.settings.recordLength);
        const length = Math.min(wanted, this.source.size - start);

        this.at = start + length;
        return { start, offset: start, length, truncated: length < wanted ? true : undefined };
    }

    private async nextVariable(): Promise<RawRecord | null> {
        // A Micro Focus file marks non-data records with a cleared flag bit; they are skipped, which is
        // why this is a loop rather than a single read.
        for (;;) {
            const start = this.at;
            const headerLength = this.settings.vbHeader === 'mf-short' ? 2 : 4;
            const header = await this.source.read(start, headerLength);

            if (header.length < headerLength) {
                // Trailing bytes too short to be a header. Not worth an error: a file padded to a block
                // boundary ends exactly like this.
                this.at = this.source.size;
                return null;
            }

            let dataLength: number;
            let padding: number;
            let isData = true;

            if (this.settings.vbHeader === 'mainframe') {
                const declared = (header[0] << 8) | header[1];
                if (declared < 4) {
                    return this.fail(start, 'Record descriptor word says ' + declared + ' bytes, which cannot hold itself.');
                }
                dataLength = declared - 4;
                // Bytes 2 and 3 are zero in a well-formed RDW; the driver reads anything else as extra
                // bytes to step over, so the viewer does the same rather than losing the rest of the file.
                padding = (header[2] << 8) | header[3];
            } else if (this.settings.vbHeader === 'mf-short') {
                isData = (header[0] & 0x40) !== 0;
                dataLength = ((header[0] & 0x0f) << 8) | header[1];
                padding = (8 - ((start + 2 + dataLength) % 8)) % 8;
            } else {
                isData = (header[0] & 0x40) !== 0;
                dataLength = ((header[0] & 0x0f) << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
                padding = (8 - ((start + 4 + dataLength) % 8)) % 8;
            }

            const offset = start + headerLength;
            const available = Math.max(0, this.source.size - offset);
            const truncated = dataLength > available;

            this.at = truncated ? this.source.size : offset + dataLength + padding;

            if (!isData) {
                if (truncated) return null;
                continue;
            }

            return {
                start,
                offset,
                length: truncated ? available : dataLength,
                truncated: truncated ? true : undefined,
            };
        }
    }

    private async nextLine(): Promise<RawRecord | null> {
        const start = this.at;
        const limit = Math.min(this.source.size, start + MAX_LINE_LENGTH);

        const terminator = await (this.settings.lineSeqEscape
            ? this.findTerminatorEscaped(start, limit)
            : this.findTerminator(start, limit));

        if (terminator === undefined) {
            // No terminator within a line's worth of bytes. Reading on would build one enormous record
            // out of what is almost certainly not a line-sequential file, so stop and say so.
            if (limit < this.source.size) {
                return this.fail(start, 'No line terminator in the first ' + MAX_LINE_LENGTH
                    + ' bytes of the record. The file is probably not line sequential.');
            }

            // The last line of a file that does not end with a terminator is still a line.
            this.at = this.source.size;
            const length = this.source.size - start;
            return length > 0
                ? { start, offset: start, length, escaped: this.settings.lineSeqEscape || undefined }
                : null;
        }

        let end = terminator;
        if (end > start && await this.source.byteAt(end - 1) === this.settings.cr) end--;

        this.at = terminator + 1;
        return { start, offset: start, length: end - start, escaped: this.settings.lineSeqEscape || undefined };
    }

    /** The offset of the terminator byte, scanned window by window rather than byte by byte. */
    private async findTerminator(from: number, limit: number): Promise<number | undefined> {
        let at = from;

        while (at < limit) {
            const { buffer, start } = await this.source.windowAt(at);
            if (buffer.length === 0) return undefined;

            const scanEnd = Math.min(buffer.length, limit - start);
            for (let i = at - start; i < scanEnd; i++) {
                if (this.isTerminator(buffer[i])) return start + i;
            }

            at = start + buffer.length;
        }

        return undefined;
    }

    /** The same, byte by byte, because a zero byte hides the byte that follows it. */
    private async findTerminatorEscaped(from: number, limit: number): Promise<number | undefined> {
        for (let at = from; at < limit; at++) {
            const byte = await this.source.byteAt(at);
            if (byte < 0) return undefined;
            if (byte === 0) { at++; continue; }
            if (this.isTerminator(byte)) return at;
        }

        return undefined;
    }

    private isTerminator(byte: number): boolean {
        if (byte === this.settings.lf) return true;

        // An EBCDIC line-sequential file may carry the ASCII LF, or NL, as its terminator - both of
        // which the driver accepts, having met them in the wild.
        return this.settings.ebcdic && (byte === 0x0a || byte === 0x15);
    }

    private fail(offset: number, message: string): null {
        this.failure = { offset, message };
        return null;
    }
}

/**
 * Resolves the options against the file: which variable header it really uses, and where its first
 * record starts.
 *
 * A Micro Focus variable file opens with a 128-byte header that says which of the two layouts it uses
 * (DotNetFH.CheckMicrofocusVBFile); anything else is read as mainframe RDW from byte zero.
 */
export async function resolveSettings(source: ByteSource, options: ReadingOptions): Promise<CursorSettings> {
    const codePage = CodePage.resolve(options.codePage);
    const kind = splitKindOf(options.recordFormat);

    let vbHeader = options.vbHeader;
    let startOffset = Math.max(0, options.startOffset ?? 0);

    if (kind === 'variable') {
        const detected = await detectVbHeader(source, startOffset);

        if (vbHeader === 'auto') {
            vbHeader = detected.format;
            startOffset = detected.dataStart;
        } else if (detected.format === vbHeader) {
            // The user named the format the file announces: still step over the announcement.
            startOffset = detected.dataStart;
        }
    } else if (vbHeader === 'auto') {
        vbHeader = 'mainframe';
    }

    return {
        kind,
        recordLength: options.recordLength,
        vbHeader: vbHeader as Exclude<VbHeaderFormat, 'auto'>,
        lineSeqEscape: options.lineSeqEscape,
        lf: codePage.lf,
        cr: codePage.cr,
        ebcdic: codePage.isEbcdic,
        startOffset,
    };
}

/** The Micro Focus file header, if the file opens with one. */
export async function detectVbHeader(
    source: ByteSource,
    from = 0,
): Promise<{ format: Exclude<VbHeaderFormat, 'auto'>; dataStart: number }> {
    const header = await source.read(from, 128);

    if (header.length === 128 && header[0] === 0x30) {
        if (header[1] === 0x7e && header[2] === 0x00 && header[3] === 0x00) {
            return { format: 'mf-short', dataStart: from + 128 };
        }
        if (header[1] === 0x00 && header[2] === 0x00 && header[3] === 0x7c) {
            return { format: 'mf-long', dataStart: from + 128 };
        }
    }

    return { format: 'mainframe', dataStart: from };
}

/** Strips the escape bytes a line-sequential file with escaping on writes before a control byte. */
export function unescapeLineRecord(data: Buffer): Buffer {
    if (!data.includes(0)) return data;

    const out = Buffer.alloc(data.length);
    let length = 0;

    for (let i = 0; i < data.length; i++) {
        if (data[i] === 0 && i + 1 < data.length) i++;
        out[length++] = data[i];
    }

    return out.subarray(0, length);
}
