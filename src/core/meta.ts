import * as fs from 'fs/promises';
import * as path from 'path';

import { RECORD_FORMATS, RecordFormat } from './types';

/**
 * Reading the catalog's .meta file, when the data file has one beside it.
 *
 * A .meta is one flat XML element written by RainCodeLegacyBatchDataset:
 *
 *   <dataSet name="MY.DATA.SET" dataSetType="File" fileFormat="EntrySequenced"
 *            recordFormat="FB" recordLength="80" ... />
 *
 * Only what the viewer needs is read, and everything is optional: a meta that says nothing useful
 * leaves the viewer exactly where a file with no meta at all does, rather than failing.
 */
export interface DataSetMeta {
    /** The path the metadata was read from. */
    metaPath: string;
    /** The catalogued DSN, shown in the editor title. */
    name?: string;
    recordFormat?: RecordFormat;
    recordLength?: number;
    fileFormat?: string;
    dataSetType?: string;
}

/** Data file extensions the catalog writes, by the kind of dataset (DataSetMetaPersistenceFile). */
const DATA_EXTENSIONS = ['.seq', '.dat', '.txt', '.idx', '.rr'];

const META_EXTENSION = '.meta';

export function parseMeta(xml: string, metaPath: string): DataSetMeta | undefined {
    const element = /<\s*(?:\w+:)?dataSet\b([^>]*)>/i.exec(xml);
    if (!element) return undefined;

    const attributes = new Map<string, string>();
    const attribute = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

    let match: RegExpExecArray | null;
    while ((match = attribute.exec(element[1])) !== null) {
        attributes.set(match[1].toLowerCase(), decodeEntities(match[2]));
    }

    const recordLength = Number(attributes.get('recordlength'));

    return {
        metaPath,
        name: attributes.get('name'),
        recordFormat: asRecordFormat(attributes.get('recordformat')),
        recordLength: Number.isFinite(recordLength) && recordLength > 0 ? recordLength : undefined,
        fileFormat: attributes.get('fileformat'),
        dataSetType: attributes.get('datasettype'),
    };
}

export async function readMeta(metaPath: string): Promise<DataSetMeta | undefined> {
    try {
        return parseMeta(await fs.readFile(metaPath, 'utf8'), metaPath);
    } catch {
        return undefined;
    }
}

/**
 * The .meta beside a data file: `X.seq` is described by `X.meta`, and so is `X` with no extension at
 * all. Undefined when there is none - the ordinary case for a file that did not come from a catalog.
 */
export async function findMetaFor(dataPath: string): Promise<string | undefined> {
    const directory = path.dirname(dataPath);
    const base = path.basename(dataPath);
    const extension = path.extname(base);

    const candidates = DATA_EXTENSIONS.includes(extension.toLowerCase())
        ? [base.slice(0, -extension.length) + META_EXTENSION]
        : [base + META_EXTENSION, base.slice(0, base.length - extension.length) + META_EXTENSION];

    for (const candidate of candidates) {
        const candidatePath = path.join(directory, candidate);
        if (await isFile(candidatePath)) return candidatePath;
    }

    return undefined;
}

/**
 * The data file a .meta describes. The catalog names it after the meta with its own extension per
 * dataset kind, so every one of them is tried, then the bare name - which is what a file handed over
 * by other means tends to look like.
 */
export async function findDataFileFor(metaPath: string): Promise<string | undefined> {
    const withoutExtension = metaPath.slice(0, metaPath.length - path.extname(metaPath).length);

    for (const extension of [...DATA_EXTENSIONS, '']) {
        const candidate = withoutExtension + extension;
        if (candidate !== metaPath && await isFile(candidate)) return candidate;
    }

    return undefined;
}

export function isMetaPath(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === META_EXTENSION;
}

function asRecordFormat(value: string | undefined): RecordFormat | undefined {
    if (!value) return undefined;

    const wanted = value.trim().toUpperCase();
    return RECORD_FORMATS.find(format => format.toUpperCase() === wanted);
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

async function isFile(candidate: string): Promise<boolean> {
    try {
        return (await fs.stat(candidate)).isFile();
    } catch {
        return false;
    }
}
