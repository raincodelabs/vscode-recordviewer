import * as fs from 'fs/promises';

/**
 * Random access to the file, through one sliding window.
 *
 * Nothing in this viewer ever holds a whole file: a dataset is routinely larger than the editor's
 * memory, and the only access patterns here are "walk forward" (indexing, searching) and "read this
 * page" - both of which one window serves well.
 *
 * Calls are serialised. A viewer really does read the file from two places at once - a page is being
 * fetched while a background count walks the same file - and without that, one of them could move the
 * window between another's read and the slice it takes out of it, which shows up as a record made of
 * somebody else's bytes.
 */
export class ByteSource {
    /** Large enough that walking a file costs few reads, small enough to hold several open files. */
    static readonly WINDOW_SIZE = 256 * 1024;

    private windowStart = 0;
    private windowLength: number;
    private readonly window: Buffer;
    private queue: Promise<unknown> = Promise.resolve();

    private constructor(private handle: fs.FileHandle | undefined, memory: Buffer | undefined, readonly size: number) {
        // A memory source IS its own window: every offset is already loaded, so load() never runs and
        // the file handle it would otherwise need is never missed.
        this.window = memory ?? Buffer.alloc(ByteSource.WINDOW_SIZE);
        this.windowLength = memory ? memory.length : 0;
    }

    static async open(filePath: string): Promise<ByteSource> {
        const handle = await fs.open(filePath, 'r');
        try {
            const stat = await handle.stat();
            return new ByteSource(handle, undefined, stat.size);
        } catch (error) {
            await handle.close();
            throw error;
        }
    }

    /** A source over bytes already in memory. For tests, and for anything small enough not to care. */
    static fromBuffer(buffer: Buffer): ByteSource {
        return new ByteSource(undefined, buffer, buffer.length);
    }

    async close(): Promise<void> {
        const handle = this.handle;
        this.handle = undefined;
        await handle?.close();
    }

    /**
     * The window holding `offset`, as a view of the underlying buffer plus the file offset it starts
     * at. An empty buffer means the offset is at or past the end of the file.
     *
     * The caller may scan it, but must not await anything while doing so: the next call refills it.
     */
    windowAt(offset: number): Promise<{ buffer: Buffer; start: number }> {
        return this.serialised(() => this.windowFor(offset));
    }

    /** The byte at `offset`, or -1 past the end of the file. */
    byteAt(offset: number): Promise<number> {
        return this.serialised(async () => {
            const { buffer, start } = await this.windowFor(offset);
            return buffer.length === 0 ? -1 : buffer[offset - start];
        });
    }

    /**
     * A copy of `length` bytes from `offset`, shortened when the file ends first. A read that fits in
     * one window goes through it; anything larger is read straight into its own buffer, so a big read
     * does not evict the window a scan is walking through.
     */
    read(offset: number, length: number): Promise<Buffer> {
        return this.serialised(() => this.readFrom(offset, length));
    }

    private async windowFor(offset: number): Promise<{ buffer: Buffer; start: number }> {
        if (offset < 0 || offset >= this.size) return { buffer: Buffer.alloc(0), start: offset };

        if (offset < this.windowStart || offset >= this.windowStart + this.windowLength) {
            await this.load(offset);
        }

        return { buffer: this.window.subarray(0, this.windowLength), start: this.windowStart };
    }

    private async readFrom(offset: number, length: number): Promise<Buffer> {
        const available = Math.max(0, Math.min(length, this.size - offset));
        if (available === 0) return Buffer.alloc(0);

        if (offset >= this.windowStart && offset + available <= this.windowStart + this.windowLength) {
            const from = offset - this.windowStart;
            return Buffer.from(this.window.subarray(from, from + available));
        }

        if (available <= ByteSource.WINDOW_SIZE) {
            await this.load(offset);
            const from = offset - this.windowStart;
            return Buffer.from(this.window.subarray(from, from + Math.min(available, this.windowLength - from)));
        }

        const buffer = Buffer.alloc(available);
        await this.readInto(buffer, offset);
        return buffer;
    }

    private async load(offset: number): Promise<void> {
        const start = Math.max(0, Math.min(offset, Math.max(0, this.size - 1)));
        const length = Math.min(ByteSource.WINDOW_SIZE, this.size - start);

        this.windowLength = await this.readInto(this.window.subarray(0, length), start);
        this.windowStart = start;
    }

    private async readInto(buffer: Buffer, offset: number): Promise<number> {
        if (!this.handle) throw new Error('ByteSource is closed');

        let filled = 0;
        while (filled < buffer.length) {
            const { bytesRead } = await this.handle.read(buffer, filled, buffer.length - filled, offset + filled);
            if (bytesRead <= 0) break;
            filled += bytesRead;
        }

        return filled;
    }

    private serialised<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action, action);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
