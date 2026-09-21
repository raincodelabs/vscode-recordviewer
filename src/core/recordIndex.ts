import { ByteSource } from './byteSource';
import { CursorProblem, CursorSettings, RawRecord, RecordCursor } from './recordCursor';

/** Told how far a scan has got, so the editor can show it moving. */
export type ScanProgress = (known: number, bytesScanned: number, complete: boolean) => void;

export interface Cancellable {
    isCancellationRequested: boolean;
}

/**
 * Where record N starts, without keeping an entry per record.
 *
 * A fixed-length file needs no index at all: arithmetic gives the offset and the count. For the
 * others the file has to be walked, and a 4 GB file of 40-byte records holds a hundred million of
 * them - too many to keep one offset each. So only every STRIDE-th offset is kept, and reading record
 * N means starting from the anchor below it and stepping forward at most STRIDE times. That is one
 * short sequential walk through bytes that are already in the window.
 */
export class RecordIndex {
    /** 256 anchors' worth of stepping is a few microseconds; 256 times less memory is megabytes. */
    static readonly STRIDE = 256;

    private readonly anchors: number[] = [];
    private scanCursor: RecordCursor | undefined;
    private scanned = 0;
    private finished = false;
    private failure: CursorProblem | undefined;
    private running: Promise<void> | undefined;

    constructor(private readonly source: ByteSource, private readonly settings: CursorSettings) {
        this.anchors.push(settings.startOffset);

        if (this.isFixed) {
            const body = Math.max(0, source.size - settings.startOffset);
            const length = Math.max(1, settings.recordLength);
            this.scanned = Math.ceil(body / length);
            this.finished = true;
        }
    }

    private get isFixed(): boolean {
        return this.settings.kind === 'fixed' && this.settings.recordLength > 0;
    }

    /** How many records are known so far - the total, once `isComplete`. */
    get known(): number { return this.scanned; }

    get isComplete(): boolean { return this.finished; }

    get problem(): CursorProblem | undefined { return this.failure; }

    /** Bytes walked so far, for a progress bar. */
    get bytesScanned(): number {
        if (this.finished) return this.source.size;
        return this.scanCursor ? this.scanCursor.position : this.settings.startOffset;
    }

    /**
     * Walks far enough to know whether record `count - 1` exists. Concurrent calls share one walk:
     * the editor asks for a page and a scroll bar at the same time, and the file is read once.
     */
    async ensure(count: number, progress?: ScanProgress, token?: Cancellable): Promise<void> {
        while (!this.finished && this.scanned < count) {
            if (token?.isCancellationRequested) return;

            if (!this.running) {
                this.running = this.scan(count, progress, token).finally(() => { this.running = undefined; });
            }

            await this.running;
        }
    }

    /** Walks the whole file. Cancellation leaves what has been found so far usable. */
    async ensureAll(progress?: ScanProgress, token?: Cancellable): Promise<void> {
        await this.ensure(Number.MAX_SAFE_INTEGER, progress, token);
    }

    /**
     * A cursor positioned at record `index`, and the index it is actually at - which is lower when the
     * file has fewer records than that.
     */
    async cursorAt(index: number): Promise<{ cursor: RecordCursor; index: number }> {
        if (this.isFixed) {
            const offset = this.settings.startOffset + Math.max(1, this.settings.recordLength) * index;
            return { cursor: new RecordCursor(this.source, this.settings, offset), index };
        }

        await this.ensure(index + 1);

        const anchor = Math.min(Math.floor(index / RecordIndex.STRIDE), this.anchors.length - 1);
        const cursor = new RecordCursor(this.source, this.settings, this.anchors[anchor]);
        let at = anchor * RecordIndex.STRIDE;

        while (at < index) {
            if (await cursor.next() === null) break;
            at++;
        }

        return { cursor, index: at };
    }

    /** Reads `count` records from `first`, without their data. */
    async slice(first: number, count: number): Promise<RawRecord[]> {
        const { cursor, index } = await this.cursorAt(first);
        if (index < first) return [];

        const records: RawRecord[] = [];
        for (let i = 0; i < count; i++) {
            const record = await cursor.next();
            if (record === null) break;
            records.push(record);
        }

        return records;
    }

    private async scan(upTo: number, progress?: ScanProgress, token?: Cancellable): Promise<void> {
        if (!this.scanCursor) this.scanCursor = new RecordCursor(this.source, this.settings);

        // A batch, rather than the whole walk: this yields to the editor often enough to stay
        // responsive, and reports progress on the way.
        const batch = 20000;

        for (let i = 0; i < batch && this.scanned < upTo; i++) {
            const record = await this.scanCursor.next();

            if (record === null) {
                this.finished = true;
                this.failure = this.scanCursor.problem;
                break;
            }

            this.scanned++;
            if (this.scanned % RecordIndex.STRIDE === 0) this.anchors.push(this.scanCursor.position);

            if (token?.isCancellationRequested) break;
        }

        progress?.(this.scanned, this.bytesScanned, this.finished);
    }
}
