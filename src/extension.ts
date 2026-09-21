import * as vscode from 'vscode';

import { RecordViewerProvider } from './recordViewerProvider';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(RecordViewerProvider.register(context));

    context.subscriptions.push(vscode.commands.registerCommand('raincode.recordViewer.open', async (resource?: vscode.Uri) => {
        const uri = resource ?? vscode.window.activeTextEditor?.document.uri;

        if (!uri) {
            void vscode.window.showInformationMessage('Open a file first, or pick one in the explorer.');
            return;
        }

        await vscode.commands.executeCommand('vscode.openWith', uri, RecordViewerProvider.viewType);
    }));
}

export function deactivate(): void {
    // The custom editor's documents close themselves; nothing else outlives the extension host.
}
