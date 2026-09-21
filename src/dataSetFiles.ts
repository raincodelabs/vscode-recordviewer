import * as path from 'path';
import * as vscode from 'vscode';

import { ByteSource } from './core/byteSource';
import { DataSetMeta, dataNameCandidates, metaNameCandidates, parseMeta } from './core/meta';

/**
 * Finding and opening a dataset through VS Code's file system rather than through Node's.
 *
 * The viewer has to work on whatever the editor is showing. A local file is read through the disk,
 * positioned read by positioned read, because a dataset is routinely larger than memory. Everything
 * else - an `ssh://` mount from the SSH FS extension, or any other extension's file system - has no
 * positioned read to offer: `workspace.fs` can only hand over a whole file. So that is what happens
 * there, once, under a size limit the user controls.
 *
 * The naming rules stay in core/meta.ts, which knows nothing about either file system: the same
 * candidates are tried here for a URI as they are on disk.
 */

export interface OpenedDataSet {
    source: ByteSource;
    /**
     * The bytes, and only when the file had to be fetched whole: rereading it with other options then
     * costs no round trip, and its presence is how the editor knows to say so.
     */
    bytes?: Buffer;
}

/** Reads a dataset, a page at a time from the disk when it is on one, whole when it is not. */
export async function openDataSet(uri: vscode.Uri, sizeLimit: number, cached?: Buffer): Promise<OpenedDataSet> {
    if (uri.scheme === 'file') {
        return { source: await ByteSource.open(uri.fsPath) };
    }

    if (cached) return { source: ByteSource.fromBuffer(cached), bytes: cached };

    const size = (await vscode.workspace.fs.stat(uri)).size;

    if (size > sizeLimit) {
        throw new Error(
            `${basename(uri)} is ${megabytes(size)} MB, and it is not on a local disk: a file system such `
            + 'as SSH FS can only hand over a whole file, so the viewer would have to fetch all of it. The '
            + `limit is ${megabytes(sizeLimit)} MB (raincodeRecordViewer.remoteFileSizeLimitMB). Raise it, `
            + 'or copy the file locally and open that.');
    }

    // A view over what the file system returned rather than a copy of it: the limit above already
    // decides how much memory this costs, and there is no reason to pay for it twice.
    const fetched = await vscode.workspace.fs.readFile(uri);
    const bytes = Buffer.from(fetched.buffer, fetched.byteOffset, fetched.byteLength);
    return { source: ByteSource.fromBuffer(bytes), bytes };
}

/** The .meta beside a data file, or undefined when there is none - the ordinary case. */
export async function findMetaUri(dataUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    return firstThatExists(dataUri, metaNameCandidates(basename(dataUri)));
}

/** The data file a .meta describes. */
export async function findDataUri(metaUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    return firstThatExists(metaUri, dataNameCandidates(basename(metaUri)));
}

export async function readMetaAt(uri: vscode.Uri): Promise<DataSetMeta | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return parseMeta(Buffer.from(bytes).toString('utf8'), uri.scheme === 'file' ? uri.fsPath : uri.toString());
    } catch {
        return undefined;
    }
}

export function basename(uri: vscode.Uri): string {
    // URI paths are posix whatever the platform, including the `/c:/...` of a Windows file URI.
    return path.posix.basename(uri.path);
}

async function firstThatExists(sibling: vscode.Uri, names: string[]): Promise<vscode.Uri | undefined> {
    const directory = path.posix.dirname(sibling.path);

    for (const name of names) {
        const candidate = sibling.with({ path: path.posix.join(directory, name) });
        if (await isFile(candidate)) return candidate;
    }

    return undefined;
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
    try {
        return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
    } catch {
        return false;
    }
}

function megabytes(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}
