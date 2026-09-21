import * as vscode from 'vscode';

import { DataSetMeta } from './core/meta';
import { RECORD_FORMATS, ReadingOptions, RecordFormat, VB_HEADER_FORMATS, VbHeaderFormat } from './core/types';

const SECTION = 'raincodeRecordViewer';

/** Where per-file overrides live, so a file opens the way it was left. */
const STORAGE_KEY = 'raincodeRecordViewer.options';

/** What a file is read as when neither its .meta file nor the user has said otherwise. */
export function defaultOptions(): ReadingOptions {
    const configuration = vscode.workspace.getConfiguration(SECTION);

    return {
        recordFormat: asRecordFormat(configuration.get<string>('defaultRecordFormat')) ?? 'FB',
        recordLength: configuration.get<number>('defaultRecordLength') ?? 80,
        vbHeader: asVbHeader(configuration.get<string>('defaultVbHeader')) ?? 'auto',
        codePage: configuration.get<string>('defaultCodePage') ?? 'ibm037',
        lineSeqEscape: configuration.get<boolean>('lineSeqEscape') ?? false,
        startOffset: 0,
    };
}

export function maxSearchMatches(): number {
    return vscode.workspace.getConfiguration(SECTION).get<number>('maxSearchMatches') ?? 5000;
}

/**
 * How much of a file the viewer will fetch whole, in bytes, when it is not on a local disk.
 *
 * VS Code's file system API reads a whole file or nothing, so an `ssh://` dataset cannot be paged
 * through the way a local one is. The limit is what stops a careless click pulling a gigabyte over an
 * SFTP connection.
 */
export function remoteFileSizeLimit(): number {
    const megabytes = vscode.workspace.getConfiguration(SECTION).get<number>('remoteFileSizeLimitMB') ?? 64;
    return Math.max(1, megabytes) * 1024 * 1024;
}

export function useMetaFile(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('useMetaFile') ?? true;
}

/**
 * The options a file opens with: the defaults, then what its .meta file says, then whatever the user
 * last chose for that file. In that order, because the last one is the only one that was said about
 * this file on purpose.
 */
export function initialOptions(meta: DataSetMeta | undefined, remembered: Partial<ReadingOptions> | undefined): ReadingOptions {
    const options = defaultOptions();

    if (meta) {
        if (meta.recordFormat && meta.recordFormat !== 'Unknown') options.recordFormat = meta.recordFormat;
        if (meta.recordLength) options.recordLength = meta.recordLength;
    }

    return sanitise({ ...options, ...remembered });
}

/** Keeps what a viewer is showing, so reopening the same file does not start from the defaults again. */
export class OptionsStore {
    constructor(private readonly memento: vscode.Memento) {}

    get(path: string): Partial<ReadingOptions> | undefined {
        return this.memento.get<Record<string, Partial<ReadingOptions>>>(STORAGE_KEY, {})[path];
    }

    async remember(path: string, options: ReadingOptions): Promise<void> {
        const all = this.memento.get<Record<string, Partial<ReadingOptions>>>(STORAGE_KEY, {});
        all[path] = options;
        await this.memento.update(STORAGE_KEY, all);
    }
}

/** Accepts what the webview sends without trusting it: it is a form, and forms get typed into. */
export function sanitise(options: Partial<ReadingOptions>): ReadingOptions {
    const defaults = defaultOptions();
    const recordLength = Number(options.recordLength);

    return {
        recordFormat: asRecordFormat(options.recordFormat) ?? defaults.recordFormat,
        recordLength: Number.isFinite(recordLength) && recordLength > 0 ? Math.floor(recordLength) : defaults.recordLength,
        vbHeader: asVbHeader(options.vbHeader) ?? defaults.vbHeader,
        codePage: typeof options.codePage === 'string' && options.codePage.length > 0 ? options.codePage : defaults.codePage,
        lineSeqEscape: options.lineSeqEscape === true,
        startOffset: toOffset(options.startOffset),
    };
}

function toOffset(value: unknown): number {
    const offset = Number(value);
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
}

function asRecordFormat(value: unknown): RecordFormat | undefined {
    return RECORD_FORMATS.find(format => format === value);
}

function asVbHeader(value: unknown): VbHeaderFormat | undefined {
    return VB_HEADER_FORMATS.find(format => format === value);
}
