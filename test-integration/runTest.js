// Runs the suite in a real VS Code, with SSH FS installed, against the SSH server README.md sets up.
//
// Kept apart from `npm test`: those tests need nothing but Node, while this one needs a container and
// a few minutes. It exists because the interesting half of reading a remote dataset is the half this
// project does not own - whether the file system extension answers `stat` and `readFile` the way the
// viewer expects - and the only honest way to know is to ask a real one.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

const extension = path.resolve(__dirname, '..');
const extensionsDir = path.resolve(__dirname, 'extensions');
const fixture = path.resolve(__dirname, 'fixture');

/** The key README.md tells you to generate, unless RCSSH_KEY says otherwise. */
const privateKey = process.env.RCSSH_KEY || path.join(os.tmpdir(), 'rcsshtest', 'testkey');

function writeFixture() {
    fs.mkdirSync(path.join(fixture, '.vscode'), { recursive: true });

    // The connection the suite's ssh:// URIs name. Workspace settings, so nothing of the developer's
    // own VS Code configuration is touched.
    fs.writeFileSync(path.join(fixture, '.vscode', 'settings.json'), JSON.stringify({
        'sshfs.configs': [{
            name: 'rcsshtest',
            host: 'localhost',
            port: 2222,
            username: 'raincode',
            privateKeyPath: privateKey.replace(/\\/g, '/'),
        }],
    }, null, 4));
}

(async () => {
    if (!fs.existsSync(privateKey)) {
        throw new Error('No private key at ' + privateKey + '. See README.md, or set RCSSH_KEY.');
    }

    writeFixture();

    // VSCODE_EXE uses the VS Code already installed rather than downloading another 325 MB.
    const executable = process.env.VSCODE_EXE || await downloadAndUnzipVSCode('stable');
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(executable);

    // SSH FS has to live in the instance the tests run in; the developer's own extensions are left
    // alone. JSON.stringify quotes the path, which a shell needs and which Windows paths always have.
    const install = cp.spawnSync(JSON.stringify(cli), [...args, '--extensions-dir', extensionsDir,
        '--install-extension', 'kelvin.vscode-sshfs'],
    { encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32' });

    if (install.error) throw install.error;
    console.log('install:', (install.stdout || '').trim(), (install.stderr || '').trim());

    await runTests({
        vscodeExecutablePath: executable,
        extensionDevelopmentPath: extension,
        extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
        launchArgs: [
            fixture,
            '--extensions-dir', extensionsDir,
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
        ],
    });
})().catch(error => {
    console.error('FAILED:', error.message);
    process.exit(1);
});
