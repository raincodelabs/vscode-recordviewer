/**
 * The vocabulary shared by the record layer and the editor: what a file looks like, and what the
 * viewer was told to read it as.
 */

/**
 * Record formats a dataset can be catalogued with, as the catalog writes them in a .meta file
 * (RainCodeLegacyBatchDataset's RecordFormat). `Unknown` is one of its values too, and means the
 * catalog does not know either - the viewer then falls back to its defaults like a file with no meta.
 */
export type RecordFormat = 'FB' | 'FBA' | 'FBM' | 'VB' | 'VBA' | 'VBM' | 'LSEQ' | 'VLSEQ' | 'U' | 'Unknown';

export const RECORD_FORMATS: readonly RecordFormat[] =
    ['FB', 'FBA', 'FBM', 'VB', 'VBA', 'VBM', 'LSEQ', 'VLSEQ', 'U', 'Unknown'];

/**
 * How records of a variable-format file are delimited. The runtime supports three, and picks between
 * them by looking at the first bytes of the file (DotNetFH.CheckMicrofocusVBFile); `auto` does the same.
 *
 * - `mainframe`  four-byte RDW, big-endian length INCLUDING the RDW, no padding.
 * - `mf-short`   Micro Focus two-byte header, 0x40 marks a data record, records aligned on eight bytes.
 * - `mf-long`    Micro Focus four-byte header, same flag and alignment.
 */
export type VbHeaderFormat = 'auto' | 'mainframe' | 'mf-short' | 'mf-long';

export const VB_HEADER_FORMATS: readonly VbHeaderFormat[] = ['auto', 'mainframe', 'mf-short', 'mf-long'];

/** How a file is cut into records, once the record format has been reduced to what that implies. */
export type SplitKind = 'fixed' | 'variable' | 'line';

/** Everything the viewer needs to turn a file into records and characters. */
export interface ReadingOptions {
    recordFormat: RecordFormat;
    /** LRECL. Used by the fixed formats; for the others it is a display hint only. */
    recordLength: number;
    vbHeader: VbHeaderFormat;
    /** A code page id (`ibm037`) or CCSID (`273`), resolved by codepage.ts. */
    codePage: string;
    /** Line-sequential only: a zero byte escapes the byte that follows it. */
    lineSeqEscape: boolean;
    /** Bytes skipped before the first record. Detection of a Micro Focus file header adds to this. */
    startOffset: number;
}

export function splitKindOf(format: RecordFormat): SplitKind {
    switch (format) {
        case 'VB':
        case 'VBA':
        case 'VBM':
            return 'variable';
        case 'LSEQ':
        case 'VLSEQ':
            return 'line';
        default:
            // FB, FBA, FBM, U and Unknown: a stream of records of the declared length. U has no
            // declared length on the mainframe, but a viewer has to cut it somewhere, and the length
            // the user can change is the honest way to do it.
            return 'fixed';
    }
}

/**
 * Whether the first byte of every record is a carriage-control character rather than data - ASA for
 * the `A` formats, machine code for the `M` ones. The viewer shows it in its own column so the data
 * columns line up with the copybook the way they do on the mainframe.
 */
export function carriageControlOf(format: RecordFormat): 'none' | 'asa' | 'machine' {
    switch (format) {
        case 'FBA':
        case 'VBA':
            return 'asa';
        case 'FBM':
        case 'VBM':
            return 'machine';
        default:
            return 'none';
    }
}

/** One record, as the viewer hands it to the editor. */
export interface RecordRow {
    /** Zero-based position in the file. */
    index: number;
    /** Offset of the record's data - after the header of a variable record. */
    offset: number;
    data: Buffer;
    /**
     * Set when the record is shorter than it should be: the last record of a fixed file that does not
     * divide evenly, or a variable record whose header promises more than the file holds.
     */
    truncated?: boolean;
}
