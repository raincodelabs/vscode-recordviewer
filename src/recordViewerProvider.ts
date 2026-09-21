import * as vscode from 'vscode';

import { CodePage } from './core/codepage';
import { toHex } from './core/format';
import { DataSetMeta, isMetaName } from './core/meta';
import { RecordFile, SearchSpec } from './core/recordFile';
import { RECORD_FORMATS, ReadingOptions, VB_HEADER_FORMATS, carriageControlOf, splitKindOf } from './core/types';
import { basename, findDataUri, findMetaUri, openDataSet, readMetaAt } from './dataSetFiles';
import { OptionsStore, initialOptions, maxSearchMatches, remoteFileSizeLimit, sanitise, useMetaFile } from './settings';

/**
 * One open file. The document owns the reading of it; the panel owns the showing of it. Changing how
 * the file is read replaces `file` - nothing else survives the change anyway, since the index, the
 * record count and every row on screen were all derived from the options.
 */
class RecordDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        /** The data file, which is not `uri` when a .meta was the thing opened. */
        readonly dataUri: vscode.Uri,
        readonly meta: DataSetMeta | undefined,
        public file: RecordFile,
        /**
         * The whole file, when it had to be fetched whole because it is not on a local disk. Kept so
         * that changing the reading options does not go back over the wire for the same bytes.
         */
        public bytes: Buffer | undefined,
    ) {}

    /** Cancels whatever background walk of the file is in flight, on close or on a settings change. */
    counting?: vscode.CancellationTokenSource;
    searching?: vscode.CancellationTokenSource;

    /** What the options store remembers this file's settings under. */
    get key(): string { return this.dataUri.toString(); }

    dispose(): void {
        this.counting?.cancel();
        this.searching?.cancel();
        void this.file.close();
    }
}

export class RecordViewerProvider implements vscode.CustomReadonlyEditorProvider<RecordDocument> {
    static readonly viewType = 'raincode.recordViewer';

    private constructor(private readonly extensionUri: vscode.Uri, private readonly store: OptionsStore) {}

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new RecordViewerProvider(context.extensionUri, new OptionsStore(context.workspaceState));

        return vscode.window.registerCustomEditorProvider(RecordViewerProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    async openCustomDocument(uri: vscode.Uri): Promise<RecordDocument> {
        // Opening the .meta opens the dataset it describes: that is the file a user picks out of the
        // catalog's volume directory, and the data file beside it is an implementation detail.
        let dataUri = uri;
        let metaUri: vscode.Uri | undefined;

        if (isMetaName(basename(uri))) {
            metaUri = uri;
            const data = await findDataUri(uri);
            if (!data) throw new Error('No data file next to ' + basename(uri) + '.');
            dataUri = data;
        } else if (useMetaFile()) {
            metaUri = await findMetaUri(dataUri);
        }

        const meta = metaUri ? await readMetaAt(metaUri) : undefined;
        const options = initialOptions(meta, this.store.get(dataUri.toString()));
        const opened = await openDataSet(dataUri, remoteFileSizeLimit());

        return new RecordDocument(uri, dataUri, meta,
            await RecordFile.fromSource(displayPath(dataUri), opened.source, options), opened.bytes);
    }

    async resolveCustomEditor(document: RecordDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        panel.webview.html = this.html(panel.webview);

        if (document.meta?.name) panel.title = document.meta.name;

        panel.webview.onDidReceiveMessage(message => {
            this.handle(document, panel, message).catch(error => {
                void panel.webview.postMessage({ type: 'error', message: messageOf(error) });
            });
        });

        panel.onDidDispose(() => {
            document.counting?.cancel();
            document.searching?.cancel();
        });
    }

    private async handle(document: RecordDocument, panel: vscode.WebviewPanel, message: any): Promise<void> {
        switch (message?.type) {
            case 'ready':
                await this.start(document, panel);
                return;

            case 'rows':
                await this.sendRows(document, panel, message.first, message.count);
                return;

            case 'rowsAt':
                await this.sendRowsAt(document, panel, message.indexes);
                return;

            case 'options':
                await this.applyOptions(document, panel, message.options);
                return;

            case 'search':
                await this.search(document, panel, message.spec);
                return;

            case 'cancelSearch':
                document.searching?.cancel();
                return;

            default:
                return;
        }
    }

    /** Everything the webview needs to draw itself, then the record count, which may take a while. */
    private async start(document: RecordDocument, panel: vscode.WebviewPanel): Promise<void> {
        const file = document.file;

        await panel.webview.postMessage({
            type: 'init',
            fileName: basename(document.dataUri),
            dataPath: file.name,
            metaPath: document.meta?.metaPath,
            dataSetName: document.meta?.name,
            meta: document.meta,
            options: file.options,
            resolved: {
                vbHeader: file.settings.vbHeader,
                startOffset: file.settings.startOffset,
                kind: splitKindOf(file.options.recordFormat),
                carriageControl: carriageControlOf(file.options.recordFormat),
                codePageLabel: file.codePage.label,
                // A file the editor handed over whole rather than one read from a disk - worth saying,
                // since it is why a large one is refused and why later edits to it are not reflected.
                scheme: document.dataUri.scheme,
                fetchedWhole: document.bytes !== undefined,
            },
            size: file.size,
            recordFormats: RECORD_FORMATS.filter(format => format !== 'Unknown'),
            vbHeaders: VB_HEADER_FORMATS,
            codePages: CodePage.all().map(page => ({ id: page.id, label: page.label, ccsid: page.ccsid })),
        });

        await this.count(document, panel);
    }

    private async count(document: RecordDocument, panel: vscode.WebviewPanel): Promise<void> {
        document.counting?.cancel();
        const source = new vscode.CancellationTokenSource();
        document.counting = source;

        const post = () => panel.webview.postMessage({
            type: 'count',
            known: document.file.knownCount,
            complete: document.file.isCounted,
            bytesScanned: document.file.bytesScanned,
            problem: document.file.problem,
        });

        await post();
        await document.file.countAll(() => { void post(); }, source.token);
        await post();
    }

    private async sendRows(document: RecordDocument, panel: vscode.WebviewPanel, first: number, count: number): Promise<void> {
        const rows = await document.file.read(atLeastZero(first), clampCount(count));
        await panel.webview.postMessage({ type: 'rows', first, rows: rows.map(row => this.toWireRow(document, row)) });
    }

    /** The scattered records a filtered view shows - the matches of a search, in file order. */
    private async sendRowsAt(document: RecordDocument, panel: vscode.WebviewPanel, indexes: number[]): Promise<void> {
        if (!Array.isArray(indexes)) return;

        const wanted = indexes.slice(0, 500).map(atLeastZero);
        const rows = [];

        for (const index of wanted) {
            const row = await document.file.readOne(index);
            if (row) rows.push(this.toWireRow(document, row));
        }

        await panel.webview.postMessage({ type: 'rowsAt', rows });
    }

    private toWireRow(document: RecordDocument, row: { index: number; offset: number; data: Buffer; truncated?: boolean }) {
        return {
            index: row.index,
            offset: row.offset,
            length: row.data.length,
            text: document.file.codePage.render(row.data),
            hex: toHex(row.data),
            truncated: row.truncated === true,
        };
    }

    private async applyOptions(document: RecordDocument, panel: vscode.WebviewPanel, raw: Partial<ReadingOptions>): Promise<void> {
        const options = sanitise(raw);

        document.counting?.cancel();
        document.searching?.cancel();

        // A file fetched whole is reread from the bytes already in hand; a local one is reopened,
        // which costs a file handle and nothing else.
        const opened = await openDataSet(document.dataUri, remoteFileSizeLimit(), document.bytes);
        const reopened = await RecordFile.fromSource(displayPath(document.dataUri), opened.source, options);

        const previous = document.file;
        document.file = reopened;
        document.bytes = opened.bytes;
        await previous.close();

        await this.store.remember(document.key, options);
        await this.start(document, panel);
    }

    private async search(document: RecordDocument, panel: vscode.WebviewPanel, spec: SearchSpec): Promise<void> {
        document.searching?.cancel();
        const source = new vscode.CancellationTokenSource();
        document.searching = source;

        const outcome = await document.file.search(
            { ...spec, limit: maxSearchMatches() },
            (scanned, matches) => { void panel.webview.postMessage({ type: 'searchProgress', scanned, matches }); },
            source.token,
        );

        await panel.webview.postMessage({ type: 'searchResult', ...outcome });
    }

    private html(webview: vscode.Webview): string {
        const nonce = newNonce();
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Mainframe Record Viewer</title>
</head>
<body>
<div id="toolbar">
    <span class="group">
        <label for="view-mode">View</label>
        <select id="view-mode" title="What each record is shown as">
            <option value="text">Text</option>
            <option value="hex">Hex, two lines</option>
            <option value="both">Text over hex, three lines</option>
        </select>
    </span>
    <span class="group">
        <label for="goto">Record</label>
        <input id="goto" type="number" min="1" step="1" title="Go to a record by its number">
        <button id="goto-button" type="button">Go</button>
    </span>
    <span class="group grow">
        <input id="search-value" type="text" placeholder="Find in records">
        <select id="search-kind" title="How the value is read">
            <option value="text">Text</option>
            <option value="hex">Hex</option>
        </select>
        <label class="check"><input id="search-case" type="checkbox"> Ignore case</label>
        <button id="search-button" type="button">Find</button>
        <button id="search-cancel" type="button" class="hidden">Stop</button>
        <button id="search-prev" type="button" title="Previous match" disabled>&#9650;</button>
        <button id="search-next" type="button" title="Next match" disabled>&#9660;</button>
        <label class="check"><input id="search-filter" type="checkbox" disabled> Only matches</label>
    </span>
    <span class="group">
        <button id="settings-button" type="button" title="How this file is read">Reading settings</button>
    </span>
</div>

<form id="settings" class="hidden">
    <div class="field">
        <label for="record-format">Record format</label>
        <select id="record-format"></select>
    </div>
    <div class="field">
        <label for="record-length">Record length</label>
        <input id="record-length" type="number" min="1" step="1">
    </div>
    <div class="field">
        <label for="vb-header">Variable header</label>
        <select id="vb-header"></select>
    </div>
    <div class="field">
        <label for="code-page">Code page</label>
        <select id="code-page"></select>
    </div>
    <div class="field">
        <label for="start-offset">Start offset</label>
        <input id="start-offset" type="number" min="0" step="1">
    </div>
    <div class="field check">
        <label><input id="line-escape" type="checkbox"> Zero byte escapes the next one</label>
    </div>
    <div class="field actions">
        <button id="settings-apply" type="submit">Apply</button>
        <button id="settings-close" type="button">Close</button>
    </div>
    <p id="settings-note"></p>
</form>

<div id="grid">
    <div id="header">
        <span class="col-number">Record</span>
        <span class="col-offset">Offset</span>
        <span class="col-length">Len</span>
        <span class="col-data"><span id="ruler"></span></span>
    </div>
    <div id="scroller">
        <div id="spacer"></div>
        <div id="rows"></div>
    </div>
</div>

<div id="status">
    <span id="status-file"></span>
    <span id="status-count"></span>
    <span id="status-search"></span>
    <span id="status-problem"></span>
</div>

<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}

/** What the file is called in the title bar and the status bar. */
function displayPath(uri: vscode.Uri): string {
    return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function atLeastZero(value: number): number {
    const index = Number(value);
    return Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
}

function clampCount(count: number): number {
    const wanted = Number(count);
    if (!Number.isFinite(wanted) || wanted <= 0) return 0;
    return Math.min(Math.floor(wanted), 500);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function newNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
    return nonce;
}
