const assert = require('assert');
const vscode = require('vscode');

// The viewer's own compiled record layer, loaded from its out/ directory: this checks how the viewer
// reads a file that SSH FS serves, not a reimplementation of it.
const EXTENSION = require('path').resolve(__dirname, '..', '..');
const { RecordFile } = require(EXTENSION + '/out/src/core/recordFile');
const { CodePage } = require(EXTENSION + '/out/src/core/codepage');

const FIXED = 'ssh://rcsshtest/data/PAYROLL.EMPLOYEE.seq';
const VARIABLE = 'ssh://rcsshtest/data/PAYROLL.HISTORY.seq';
const page = CodePage.resolve('ibm037');

function options(overrides) {
    return Object.assign({
        recordFormat: 'FB', recordLength: 80, vbHeader: 'auto',
        codePage: 'ibm037', lineSeqEscape: false, startOffset: 0,
    }, overrides || {});
}

suite('a dataset served by SSH FS over SFTP', function () {
    suiteSetup(async function () {
        const sshfs = vscode.extensions.getExtension('Kelvin.vscode-sshfs')
            || vscode.extensions.getExtension('kelvin.vscode-sshfs');
        assert.ok(sshfs, 'SSH FS is not installed in this instance');
        await sshfs.activate();
    });

    test('VS Code can stat it through the provider', async function () {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.parse(FIXED));
        console.log('  stat ->', JSON.stringify(stat));
        assert.strictEqual(stat.type, vscode.FileType.File);
        assert.strictEqual(stat.size, 40000);
    });

    test('the .meta beside it is found and read', async function () {
        const { findMetaUri, readMetaAt } = require(EXTENSION + '/out/src/dataSetFiles');

        const metaUri = await findMetaUri(vscode.Uri.parse(FIXED));
        console.log('  meta ->', metaUri && metaUri.toString());
        assert.ok(metaUri, 'the .meta beside it was not found');

        const meta = await readMetaAt(metaUri);
        console.log('  meta says ->', JSON.stringify(meta));
        assert.strictEqual(meta.name, 'PAYROLL.EMPLOYEE');
        assert.strictEqual(meta.recordFormat, 'FB');
        assert.strictEqual(meta.recordLength, 80);
    });

    test('a .meta finds its data file', async function () {
        const { findDataUri } = require(EXTENSION + '/out/src/dataSetFiles');
        const metaUri = vscode.Uri.parse('ssh://rcsshtest/data/PAYROLL.EMPLOYEE.meta');

        const data = await findDataUri(metaUri);
        console.log('  data ->', data && data.toString());
        assert.strictEqual(data && data.toString(), FIXED);
    });

    test('fixed records are read and decoded from EBCDIC', async function () {
        const { openDataSet } = require(EXTENSION + '/out/src/dataSetFiles');

        const opened = await openDataSet(vscode.Uri.parse(FIXED), 64 * 1024 * 1024);
        assert.ok(opened.bytes, 'a file system with no positioned read hands over the whole file');

        const file = await RecordFile.fromSource(FIXED, opened.source, options());
        assert.strictEqual(file.knownCount, 500);

        const rows = await file.read(0, 2);
        console.log('  record 1 ->', JSON.stringify(page.render(rows[0].data).slice(0, 46)));
        console.log('  record 2 ->', JSON.stringify(page.render(rows[1].data).slice(0, 46)));
        assert.ok(page.decode(rows[0].data).startsWith('E00001DUPONT'));

        const found = await file.search({ kind: 'text', value: 'TANAKA', caseInsensitive: true });
        console.log('  search TANAKA ->', found.matches.length, 'records');
        assert.strictEqual(found.matches.length, 50);

        await file.close();
    });

    test('variable records are cut by their descriptor word', async function () {
        const { openDataSet } = require(EXTENSION + '/out/src/dataSetFiles');

        const opened = await openDataSet(vscode.Uri.parse(VARIABLE), 64 * 1024 * 1024);
        const file = await RecordFile.fromSource(VARIABLE, opened.source, options({ recordFormat: 'VB' }));

        assert.strictEqual(await file.countAll(), 300);

        const rows = await file.read(0, 2);
        console.log('  record 1 ->', JSON.stringify(page.render(rows[0].data)), '(' + rows[0].data.length + ' bytes)');
        console.log('  record 2 ->', JSON.stringify(page.render(rows[1].data)), '(' + rows[1].data.length + ' bytes)');
        assert.ok(page.decode(rows[0].data).startsWith('TXN00001'));
        assert.notStrictEqual(rows[0].data.length, rows[1].data.length, 'these records vary in length');

        await file.close();
    });

    test('a file over the limit is refused, by name and by setting', async function () {
        const { openDataSet } = require(EXTENSION + '/out/src/dataSetFiles');

        await assert.rejects(() => openDataSet(vscode.Uri.parse(FIXED), 1024), error => {
            console.log('  refused ->', error.message);
            return /remoteFileSizeLimitMB/.test(error.message) && /PAYROLL\.EMPLOYEE\.seq/.test(error.message);
        });
    });

    test('the custom editor opens on it', async function () {
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(FIXED), 'raincode.recordViewer');

        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        // The tab carries the DSN from the .meta, not the file name - that is the viewer renaming it.
        console.log('  active tab ->', tab && tab.label);
        assert.ok(tab && tab.label === 'PAYROLL.EMPLOYEE');
    });
});
