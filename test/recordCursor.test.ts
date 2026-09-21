import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { ByteSource } from '../src/core/byteSource';
import { CodePage } from '../src/core/codepage';
import { RecordCursor, detectVbHeader, resolveSettings, unescapeLineRecord } from '../src/core/recordCursor';
import { ReadingOptions } from '../src/core/types';

function options(overrides: Partial<ReadingOptions> = {}): ReadingOptions {
    return {
        recordFormat: 'FB',
        recordLength: 4,
        vbHeader: 'auto',
        codePage: 'ibm037',
        lineSeqEscape: false,
        startOffset: 0,
        ...overrides,
    };
}

/** Every record of the file, as its bytes. */
async function readAll(bytes: Buffer, reading: ReadingOptions): Promise<{ records: Buffer[]; problem?: string }> {
    const source = ByteSource.fromBuffer(bytes);
    const settings = await resolveSettings(source, reading);
    const cursor = new RecordCursor(source, settings);

    const records: Buffer[] = [];
    for (;;) {
        const record = await cursor.next();
        if (record === null) break;
        records.push(bytes.subarray(record.offset, record.offset + record.length));
    }

    return { records, problem: cursor.problem?.message };
}

// --- fixed ----------------------------------------------------------------------------------------

test('a fixed file is cut every LRECL bytes', async () => {
    const { records } = await readAll(Buffer.from('AAAABBBBCCCC'), options({ recordLength: 4 }));

    assert.deepEqual(records.map(String), ['AAAA', 'BBBB', 'CCCC']);
});

test('the last record of a file that does not divide evenly is kept, and marked short', async () => {
    const source = ByteSource.fromBuffer(Buffer.from('AAAABB'));
    const cursor = new RecordCursor(source, await resolveSettings(source, options({ recordLength: 4 })));

    assert.equal((await cursor.next())?.truncated, undefined);

    const last = await cursor.next();
    assert.equal(last?.length, 2);
    assert.equal(last?.truncated, true);
    assert.equal(await cursor.next(), null);
});

// --- variable, mainframe RDW ----------------------------------------------------------------------

/** A record with the mainframe's own descriptor word: length INCLUDING the four bytes of the RDW. */
function rdw(data: string): Buffer {
    const length = data.length + 4;
    return Buffer.concat([Buffer.from([(length >> 8) & 0xff, length & 0xff, 0, 0]), Buffer.from(data)]);
}

test('variable records are read from their descriptor word', async () => {
    const file = Buffer.concat([rdw('ONE'), rdw('SEVENTH'), rdw('')]);
    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'mainframe' }));

    assert.deepEqual(records.map(String), ['ONE', 'SEVENTH', '']);
});

test('a descriptor word too small to hold itself stops the walk and says why', async () => {
    const file = Buffer.concat([rdw('ONE'), Buffer.from([0, 2, 0, 0]), Buffer.from('XX')]);
    const { records, problem } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'mainframe' }));

    assert.deepEqual(records.map(String), ['ONE']);
    assert.match(problem ?? '', /cannot hold itself/);
});

test('a record whose descriptor word promises more than the file holds is shown, short', async () => {
    const file = Buffer.concat([Buffer.from([0, 20, 0, 0]), Buffer.from('ONLY')]);
    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'mainframe' }));

    assert.deepEqual(records.map(String), ['ONLY']);
});

// --- variable, Micro Focus ------------------------------------------------------------------------

const MF_LONG_HEADER = mfFileHeader(0x00, 0x00, 0x7c);
const MF_SHORT_HEADER = mfFileHeader(0x7e, 0x00, 0x00);

function mfFileHeader(second: number, third: number, fourth: number): Buffer {
    const header = Buffer.alloc(128);
    header[0] = 0x30;
    header[1] = second;
    header[2] = third;
    header[3] = fourth;
    return header;
}

/** One Micro Focus record, padded to the eight-byte boundary the next one starts on. */
function mfRecord(data: string, long: boolean, at: number, isData = true): Buffer {
    const headerLength = long ? 4 : 2;
    const header = Buffer.alloc(headerLength);

    if (long) {
        header[0] = (data.length >> 24) & 0x0f;
        header[1] = (data.length >> 16) & 0xff;
        header[2] = (data.length >> 8) & 0xff;
        header[3] = data.length & 0xff;
    } else {
        header[0] = (data.length >> 8) & 0x0f;
        header[1] = data.length & 0xff;
    }

    if (isData) header[0] |= 0x40;

    const padding = (8 - ((at + headerLength + data.length) % 8)) % 8;
    return Buffer.concat([header, Buffer.from(data), Buffer.alloc(padding)]);
}

function mfFile(header: Buffer, records: { data: string; isData?: boolean }[], long: boolean): Buffer {
    let file = header;
    for (const record of records) {
        file = Buffer.concat([file, mfRecord(record.data, long, file.length, record.isData !== false)]);
    }
    return file;
}

test('a Micro Focus long file is detected, its header skipped and its padding stepped over', async () => {
    const file = mfFile(MF_LONG_HEADER, [{ data: 'ONE' }, { data: 'SEVENTH' }, { data: 'X' }], true);

    assert.deepEqual(await detectVbHeader(ByteSource.fromBuffer(file)), { format: 'mf-long', dataStart: 128 });

    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'auto' }));
    assert.deepEqual(records.map(String), ['ONE', 'SEVENTH', 'X']);
});

test('a Micro Focus short file is detected and read the same way', async () => {
    const file = mfFile(MF_SHORT_HEADER, [{ data: 'ONE' }, { data: 'TWO' }], false);

    assert.deepEqual(await detectVbHeader(ByteSource.fromBuffer(file)), { format: 'mf-short', dataStart: 128 });

    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'auto' }));
    assert.deepEqual(records.map(String), ['ONE', 'TWO']);
});

test('a record Micro Focus marked as not data is stepped over, not shown', async () => {
    const file = mfFile(MF_LONG_HEADER, [{ data: 'KEPT' }, { data: 'DELETED', isData: false }, { data: 'ALSO' }], true);
    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'auto' }));

    assert.deepEqual(records.map(String), ['KEPT', 'ALSO']);
});

test('a file with no Micro Focus header is read as mainframe RDW from byte zero', async () => {
    const file = Buffer.concat([rdw('ONE'), rdw('TWO')]);

    assert.deepEqual(await detectVbHeader(ByteSource.fromBuffer(file)), { format: 'mainframe', dataStart: 0 });

    const { records } = await readAll(file, options({ recordFormat: 'VB', vbHeader: 'auto' }));
    assert.deepEqual(records.map(String), ['ONE', 'TWO']);
});

// --- line sequential ------------------------------------------------------------------------------

test('an ASCII line-sequential file is cut at the line feed, carriage return dropped', async () => {
    const file = Buffer.from('ONE\r\nTWO\nTHREE');
    const { records } = await readAll(file, options({ recordFormat: 'LSEQ', codePage: 'windows1252' }));

    assert.deepEqual(records.map(String), ['ONE', 'TWO', 'THREE'], 'the last line needs no terminator');
});

test('an EBCDIC line-sequential file is cut at ITS line feed', async () => {
    const page = CodePage.resolve('ibm037');
    const line = (text: string) => page.encode(text).bytes;
    const file = Buffer.concat([line('ONE'), Buffer.from([0x25]), line('TWO'), Buffer.from([0x25])]);

    const { records } = await readAll(file, options({ recordFormat: 'LSEQ', codePage: 'ibm037' }));

    assert.deepEqual(records.map(record => page.decode(record)), ['ONE', 'TWO']);
});

test('an empty line is a record', async () => {
    const { records } = await readAll(Buffer.from('A\n\nB\n'), options({ recordFormat: 'LSEQ', codePage: 'windows1252' }));

    assert.deepEqual(records.map(String), ['A', '', 'B']);
});

test('with escaping on, a zero byte hides the terminator that follows it', async () => {
    const file = Buffer.from([0x41, 0x00, 0x0a, 0x42, 0x0a, 0x43, 0x0a]);
    const { records } = await readAll(file, options({
        recordFormat: 'LSEQ',
        codePage: 'windows1252',
        lineSeqEscape: true,
    }));

    assert.deepEqual(records.map(record => [...record]), [[0x41, 0x00, 0x0a, 0x42], [0x43]]);
    assert.deepEqual([...unescapeLineRecord(records[0])], [0x41, 0x0a, 0x42]);
});

test('a file with no terminator at all is refused as line sequential', async () => {
    const { records, problem } = await readAll(Buffer.alloc(100 * 1024, 0x40), options({
        recordFormat: 'LSEQ',
        codePage: 'ibm037',
    }));

    assert.deepEqual(records, []);
    assert.match(problem ?? '', /not line sequential/);
});

// --- offsets --------------------------------------------------------------------------------------

test('a start offset skips whatever comes before the first record', async () => {
    const { records } = await readAll(Buffer.from('JUNKAAAABBBB'), options({ recordLength: 4, startOffset: 4 }));

    assert.deepEqual(records.map(String), ['AAAA', 'BBBB']);
});
