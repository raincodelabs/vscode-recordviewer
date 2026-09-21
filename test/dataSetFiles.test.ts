import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { CodePage } from '../src/core/codepage';
import { ReadingOptions } from '../src/core/types';
import { Uri, install, stubFileSystem } from './stubs/vscode';

/**
 * The path that opens a dataset over a file system that is not the local disk - an SSH FS mount, say.
 *
 * It is tested here with a stub file system rather than with a real SSH connection, because what broke
 * was this side of the contract: the viewer used to refuse every scheme but `file:` outright. Whether
 * SSH FS serves its own bytes correctly is its business, and it exercises the very same two calls the
 * stub does, `stat` and `readFile`.
 *
 * The module has to be pulled in AFTER install(), which is why every test imports it for itself.
 */
install();

const RECORD_LENGTH = 16;
const page = CodePage.resolve('ibm037');

function options(overrides: Partial<ReadingOptions> = {}): ReadingOptions {
    return {
        recordFormat: 'FB',
        recordLength: RECORD_LENGTH,
        vbHeader: 'auto',
        codePage: 'ibm037',
        lineSeqEscape: false,
        startOffset: 0,
        ...overrides,
    };
}

/** Three EBCDIC records, the way a catalogued dataset holds them. */
function dataset(): Buffer {
    return Buffer.concat(['ALPHA', 'BRAVO', 'CHARLIE'].map(word => page.encode(word.padEnd(RECORD_LENGTH)).bytes));
}

const META = '<dataSet name="PAYROLL.MASTER" recordFormat="FB" recordLength="16" dataSetType="File" />';

/** A dataset served over a scheme that is not `file:`, the way SSH FS serves one. */
function remoteDataSet(): { data: ReturnType<typeof Uri.parse>; meta: ReturnType<typeof Uri.parse> } {
    const data = Uri.parse('ssh://mainframe-host/datasets/PAYROLL.MASTER.seq');
    const meta = Uri.parse('ssh://mainframe-host/datasets/PAYROLL.MASTER.meta');

    stubFileSystem.write(data, dataset());
    stubFileSystem.write(meta, META);

    return { data, meta };
}

let temporary: string | undefined;

async function localDataSet(): Promise<ReturnType<typeof Uri.file>> {
    if (!temporary) temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'record-viewer-fs-'));

    const filePath = path.join(temporary, 'PAYROLL.MASTER.seq');
    await fs.writeFile(filePath, dataset());

    return Uri.file(filePath);
}

beforeEach(() => { stubFileSystem.clear(); });

after(async () => {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test('a file on a remote file system is fetched whole and read as records', async () => {
    const { openDataSet } = await import('../src/dataSetFiles');
    const { RecordFile } = await import('../src/core/recordFile');
    const { data } = remoteDataSet();

    const opened = await openDataSet(data, 1024 * 1024);
    assert.ok(opened.bytes, 'a file system with no positioned read hands over the whole file');

    const file = await RecordFile.fromSource(data.toString(), opened.source, options());
    assert.equal(file.knownCount, 3);

    const rows = await file.read(0, 3);
    assert.deepEqual(rows.map(row => page.decode(row.data).trim()), ['ALPHA', 'BRAVO', 'CHARLIE']);

    await file.close();
});

test('a file on the local disk is read where it lies, not fetched', async () => {
    const { openDataSet } = await import('../src/dataSetFiles');
    const uri = await localDataSet();

    const opened = await openDataSet(uri, 1024 * 1024);

    assert.equal(opened.bytes, undefined, 'nothing is held in memory for a file that can be paged');
    assert.equal(opened.source.size, 3 * RECORD_LENGTH);

    await opened.source.close();
});

test('a remote file over the limit is refused, and the message says which setting to raise', async () => {
    const { openDataSet } = await import('../src/dataSetFiles');
    const { data } = remoteDataSet();

    await assert.rejects(
        () => openDataSet(data, 8),
        error => {
            assert.match((error as Error).message, /remoteFileSizeLimitMB/);
            assert.match((error as Error).message, /PAYROLL\.MASTER\.seq/);
            return true;
        });
});

test('a file system that cannot stat is read anyway', async () => {
    const { openDataSet } = await import('../src/dataSetFiles');
    const { data } = remoteDataSet();
    stubFileSystem.statFails = true;

    const opened = await openDataSet(data, 1024 * 1024);

    assert.equal(opened.source.size, 3 * RECORD_LENGTH, 'an unknown size is not a reason to refuse the file');
});

test('the .meta beside a remote dataset is found and read', async () => {
    const { findMetaUri, readMetaAt } = await import('../src/dataSetFiles');
    const { data, meta } = remoteDataSet();

    const found = await findMetaUri(data);
    assert.equal(found?.toString(), meta.toString());

    const parsed = await readMetaAt(found!);
    assert.equal(parsed?.name, 'PAYROLL.MASTER');
    assert.equal(parsed?.recordFormat, 'FB');
    assert.equal(parsed?.recordLength, 16);
});

test('a remote .meta finds the data file beside it', async () => {
    const { findDataUri } = await import('../src/dataSetFiles');
    const { data, meta } = remoteDataSet();

    assert.equal((await findDataUri(meta))?.toString(), data.toString());
});

test('a dataset with no .meta beside it is simply one without', async () => {
    const { findMetaUri } = await import('../src/dataSetFiles');
    const data = Uri.parse('ssh://host/data/LONELY.seq');
    stubFileSystem.write(data, dataset());

    assert.equal(await findMetaUri(data), undefined);
});

test('the file name is read off the URI whatever the scheme', async () => {
    const { basename } = await import('../src/dataSetFiles');

    assert.equal(basename(Uri.parse('ssh://mainframe-host/datasets/PAYROLL.MASTER.seq')), 'PAYROLL.MASTER.seq');
    assert.equal(basename(Uri.file('C:\\volumes\\PROD\\PAYROLL.MASTER.seq')), 'PAYROLL.MASTER.seq');
});
