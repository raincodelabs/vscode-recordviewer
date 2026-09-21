// Bundles the extension host code into dist/extension.js.
//
// The webview's own script is NOT bundled: it is plain browser JavaScript loaded from media/, so it
// stays readable in the running editor and needs no build step of its own.

import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const context = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
});

if (watch) {
    await context.watch();
} else {
    await context.rebuild();
    await context.dispose();
}
