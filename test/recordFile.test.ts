import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';

import { CodePage } from '../src/core/codepage';
import { RecordFile, parseHex } from '../src/core/recordFile';
import { ReadingOptions } from '../src/core/types';

let temporary: string | undefined;

/** One scratch directory for the whole file - these tests need real files, not buffers. */
async function scratch(): Promise<string> {
    if (!temporary) temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'record-viewer-'));
    return temporary;
}

after(async () => {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

async function fileOf(name: string, bytes: Buffer, overrides: Partial<ReadingOptions>): Promise<RecordFile> {
    const filePath = path.join(await scratch(), name);
    await fs.writeFile(filePath, bytes);

    return RecordFile.open(filePath, {
        recordFormat: 'FB',
        recordLength: 8,
        vbHeader: 'auto',
        codePage: 'ibm037',
        lineSeqEscape: false,
        startOffset: 0,
        ...overrides,
    });
}

/** `count` fixed records of `length` bytes, in EBCDIC, each one holding its own number. */
function fixedFile(count: number, length: number): Buffer {
    const page = CodePage.resolve('ibm037');
    const file = Buffer.alloc(count * length, page.space);

    for (let i = 0; i < count; i++) {
        page.encode(String(i + 1).padStart(length, '0')).bytes.copy(file, i * length);
    }

    return file;
}

test('a fixed file is counted without reading it', async () => {
    const file = await fileOf('fixed.seq', fixedFile(1000, 8), { recordLength: 8 });

    assert.equal(file.knownCount, 1000);
    assert.equal(file.isCounted, true, 'arithmetic, not a walk');

    await file.close();
});

test('records are read at any depth, past the index stride', async () => {
    const file = await fileOf('deep.seq', fixedFile(5000, 8), { recordLength: 8 });
    const page = file.codePage;

    const rows = await file.read(4997, 10);
    assert.equal(rows.length, 3, 'the file ends there');
    assert.deepEqual(rows.map(row => page.decode(row.data)), ['00004998', '00004999', '00005000']);
    assert.deepEqual(rows.map(row => row.index), [4997, 4998, 4999]);

    await file.close();
});

test('a variable file is walked to be counted, and read from the index afterwards', async () => {
    const page = CodePage.resolve('ibm037');
    const parts: Buffer[] = [];

    for (let i = 1; i <= 1000; i++) {
        const data = page.encode('REC' + String(i).padStart(4, '0')).bytes;
        const length = data.length + 4;
        parts.push(Buffer.from([(length >> 8) & 0xff, length & 0xff, 0, 0]), data);
    }

    const file = await fileOf('variable.seq', Buffer.concat(parts), { recordFormat: 'VB', vbHeader: 'mainframe' });

    assert.equal(await file.countAll(), 1000);

    const rows = await file.read(700, 2);
    assert.deepEqual(rows.map(row => page.decode(row.data)), ['REC0701', 'REC0702']);

    await file.close();
});

test('text search reads the file in its own code page', async () => {
    const file = await fileOf('search.seq', fixedFile(500, 8), { recordLength: 8 });

    const found = await file.search({ kind: 'text', value: '00000042' });
    assert.deepEqual(found.matches, [41]);
    assert.equal(found.complete, true);

    await file.close();
});

test('ignoring case means the letters, not the bits', async () => {
    const page = CodePage.resolve('ibm037');
    const file = await fileOf('case.seq', page.encode('AbCdefgh').bytes, { recordLength: 8 });

    assert.deepEqual((await file.search({ kind: 'text', value: 'ABCD', caseInsensitive: true })).matches, [0]);
    assert.deepEqual((await file.search({ kind: 'text', value: 'ABCD' })).matches, []);

    await file.close();
});

test('a character the code page cannot write is reported, not searched for', async () => {
    const file = await fileOf('euro.seq', fixedFile(10, 8), { recordLength: 8 });

    const found = await file.search({ kind: 'text', value: '€' });
    assert.deepEqual(found.matches, []);
    assert.match(found.warning ?? '', /no byte for/);

    await file.close();
});

test('hex search finds the bytes whatever they decode to', async () => {
    const file = await fileOf('hex.seq', Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc]), { recordLength: 4 });

    assert.deepEqual((await file.search({ kind: 'hex', value: 'FF FE' })).matches, [1]);
    assert.deepEqual((await file.search({ kind: 'hex', value: '0x00,0x01' })).matches, [0]);
    assert.match((await file.search({ kind: 'hex', value: 'ZZ' })).warning ?? '', /hexadecimal/);

    await file.close();
});

test('a search stops on its limit rather than returning the whole file', async () => {
    const file = await fileOf('limit.seq', fixedFile(500, 8), { recordLength: 8 });

    const found = await file.search({ kind: 'text', value: '0', limit: 10 });
    assert.equal(found.matches.length, 10);
    assert.equal(found.complete, false);

    await file.close();
});

test('hex is read the several ways it gets typed', () => {
    assert.deepEqual([...parseHex('C1C2')!], [0xc1, 0xc2]);
    assert.deepEqual([...parseHex('c1 c2')!], [0xc1, 0xc2]);
    assert.deepEqual([...parseHex('0xC1,0xC2')!], [0xc1, 0xc2]);
    assert.equal(parseHex('C1C'), undefined);
    assert.equal(parseHex(''), undefined);
    assert.equal(parseHex('hello'), undefined);
});
