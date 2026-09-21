# Change Log

## 0.2.0

- Datasets on any file system VS Code can show, including the `ssh://` of the SSH FS extension. Those
  are fetched whole rather than a page at a time - the file system API has no positioned read - under
  `raincodeRecordViewer.remoteFileSizeLimitMB`.
- Hex written the way RecordEditor writes it: the high nibbles over the low ones, one byte per column,
  under the character it stands for, so text, hex and the ruler line up.
- MIT licence.

## 0.1.0

First package, never published. Read-only.

- Records cut by record format: fixed (`FB`, `FBA`, `FBM`, `U`), variable (`VB`, `VBA`, `VBM` - mainframe
  RDW and both Micro Focus headers, detected from the file), and line sequential (`LSEQ`, `VLSEQ`).
- Text and hex views, with a column ruler.
- The EBCDIC code pages a dataset is written in, plus Windows-1252, ISO 8859-1, OEM 850 and OEM 437.
- Record format, record length, variable header, code page and start offset read from the catalog's
  `.meta` file when there is one, and changeable while the file is open. Remembered per file.
- Search by text in the file's code page, or by hex bytes; step through matches or show only those.
- Files larger than memory: paged reads, a background count, and a sparse index.
