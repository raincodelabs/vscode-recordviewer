import { RECORD_FORMATS, RecordFormat } from './types';

/**
 * The catalog's .meta file: one flat XML element written by RainCodeLegacyBatchDataset,
 *
 *   <dataSet name="MY.DATA.SET" dataSetType="File" fileFormat="EntrySequenced"
 *            recordFormat="FB" recordLength="80" ... />
 *
 * and the rules for finding it beside a data file.
 *
 * Everything here is pure string work, and deliberately so: the viewer opens files over whatever file
 * system VS Code is showing - the local disk, an SSH mount, anything a extension provides - and the
 * naming rules must not be reimplemented per file system. Reading bytes is the caller's job.
 *
 * Only what the viewer needs is read, and all of it is optional: a meta that says nothing useful
 * leaves the viewer exactly where a file with no meta at all does, rather than failing.
 */
export interface DataSetMeta {
    /** Where the metadata was read from - a path or a URI, whatever the caller opened. */
    metaPath: string;
    /** The catalogued DSN, shown in the editor title. */
    name?: string;
    recordFormat?: RecordFormat;
    recordLength?: number;
    fileFormat?: string;
    dataSetType?: string;
}

/** Data file extensions the catalog writes, by the kind of dataset (DataSetMetaPersistenceFile). */
export const DATA_EXTENSIONS: readonly string[] = ['.seq', '.dat', '.txt', '.idx', '.rr'];

export const META_EXTENSION = '.meta';

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

export function isMetaName(fileName: string): boolean {
    return extensionOf(fileName) === META_EXTENSION;
}

/**
 * The names the .meta of a data file could have, best first. `X.seq` is described by `X.meta`, and so
 * is `X` with no extension at all - the shape a file handed over by other means tends to have.
 */
export function metaNameCandidates(dataFileName: string): string[] {
    const extension = extensionOf(dataFileName);

    const candidates = DATA_EXTENSIONS.includes(extension)
        ? [withoutExtension(dataFileName) + META_EXTENSION]
        : [dataFileName + META_EXTENSION, withoutExtension(dataFileName) + META_EXTENSION];

    return unique(candidates);
}

/**
 * The names the data file of a .meta could have, best first: the catalog's own extension per kind of
 * dataset, then the bare name.
 */
export function dataNameCandidates(metaFileName: string): string[] {
    const base = withoutExtension(metaFileName);

    return unique([...DATA_EXTENSIONS.map(extension => base + extension), base])
        .filter(candidate => candidate !== metaFileName);
}

function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot <= 0 ? '' : fileName.slice(dot).toLowerCase();
}

function withoutExtension(fileName: string): string {
    const extension = extensionOf(fileName);
    return extension.length === 0 ? fileName : fileName.slice(0, fileName.length - extension.length);
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
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
