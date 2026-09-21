# Change Log

## 0.1.0

First release. Read-only.

- Records cut by record format: fixed (`FB`, `FBA`, `FBM`, `U`), variable (`VB`, `VBA`, `VBM` - mainframe
  RDW and both Micro Focus headers, detected from the file), and line sequential (`LSEQ`, `VLSEQ`).
- Text, hex, and the RecordEditor three-line view: the two nibble lines under the characters, one
  byte per column, with a column ruler over all of them.
- The EBCDIC code pages a dataset is written in, plus Windows-1252, ISO 8859-1, OEM 850 and OEM 437.
- Record format, record length, variable header, code page and start offset read from the catalog's
  `.meta` file when there is one, and changeable while the file is open. Remembered per file.
- Search by text in the file's code page, or by hex bytes; step through matches or show only those.
- Files larger than memory: paged reads, a background count, and a sparse index.
