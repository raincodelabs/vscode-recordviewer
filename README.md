# Mainframe Record Viewer

Browse mainframe data files in Visual Studio Code, record by record.

A dataset copied down from z/OS is not a text file: it is a stream of fixed-length records, or records
behind a descriptor word, written in EBCDIC. Opening one in an editor shows a wall of mojibake with no
record boundaries. This extension shows it the way the mainframe does - one record per line, in text,
in hex, or in both at once - and lets you search it.

It reads the file only. Nothing is ever written back.

## What it reads

| Record format | How the file is cut |
|---|---|
| `FB`, `FBA`, `FBM`, `U` | every LRECL bytes |
| `VB`, `VBA`, `VBM` | by the record descriptor word - mainframe RDW, or either Micro Focus header |
| `LSEQ`, `VLSEQ` | at the line terminator of the file's own code page |

Code pages: the EBCDIC pages a dataset is normally written in (037, 273, 277, 278, 280, 284, 285, 297,
500, 870, 871, 875, 1025, 1026, 1047, and the 1140-1149 euro variants), plus Windows-1252, ISO 8859-1,
OEM 850 and OEM 437. Either the CCSID (`273`) or the name (`ibm273`) is accepted.

Variable files that carry a Micro Focus file header are recognised by it, and the header is skipped.

## The three-line view

Hex is written vertically, the way RecordEditor and ISPF write it: the high nibble of a byte above its
low nibble, one byte per column, under the character it stands for. So a byte, its hexadecimal and the
column number on the ruler are always in the same place, and a field's position can be read off the
screen.

```
  Record    Offset  Len  ----+----1----+----2----+----3----+----4----+----5
       1  00000000   80  E00001DUPONT              LAGOS
                         CFFFFFCEDDDE44444444444444DCCDE44444444444444444
                         500001447653000000000000003176200000000000000000
```

**View** switches between the text alone, the two hex lines alone, and all three.

## Opening a file

- **right-click a file** in the explorer and choose **Open as Mainframe Records**, or
- run **Mainframe: Open as Mainframe Records** from the command palette, or
- **Open With...** on any file and pick **Mainframe Record Viewer**.

Opening a Raincode catalog `.meta` file opens the dataset it describes, and the record format, the
record length and the dataset name come from it. Opening a data file that has a `.meta` beside it does
the same. A file with no metadata opens on the defaults in the settings, which you then correct.

To make the viewer the default editor for an extension, add an editor association - VS Code offers it
under **Configure Editor Association** too:

```json
"workbench.editorAssociations": {
    "*.seq": "raincode.recordViewer"
}
```

## Reading settings

**Reading settings** opens what the file is being read as, and every part of it can be changed while
the file is open: record format, record length, variable-record header, code page, the offset the first
record starts at, and whether a zero byte escapes the byte that follows it in a line-sequential file.

Applying a change rereads the file. What you choose is remembered per file, so the next time you open
it, it opens the way you left it.

A file whose metadata is wrong - a `VB` dataset with no descriptor words, say - stops with the reason
in the status bar rather than showing nonsense. Correcting the format in the settings is the answer.

## Searching

Type a value and press **Find**:

- **Text** is searched in the file's own code page. *Ignore case* compares the letters, which is the
  only thing that makes sense on EBCDIC, where the two cases are not one bit apart.
- **Hex** takes `C1C2`, `c1 c2` or `0xC1,0xC2` and searches the bytes, whatever they decode to.

Matches are highlighted, ▲ and ▼ step through them, and **Only matches** hides everything else. A
search over a large file reports its progress and can be stopped.

## Settings

| Setting | What it does |
|---|---|
| `raincodeRecordViewer.useMetaFile` | Read the catalog `.meta` file beside the data file. |
| `raincodeRecordViewer.defaultCodePage` | Code page for a file with no metadata. |
| `raincodeRecordViewer.defaultRecordFormat` | Record format for a file with no metadata. |
| `raincodeRecordViewer.defaultRecordLength` | LRECL for a fixed-format file with no metadata. |
| `raincodeRecordViewer.defaultVbHeader` | Header a variable file is read with; `auto` detects it. |
| `raincodeRecordViewer.lineSeqEscape` | Zero byte escapes the next one, in line-sequential files. |
| `raincodeRecordViewer.maxSearchMatches` | Where a search gives up. |

## Large files

Nothing is loaded whole. Records are read a page at a time through one sliding window, and a fixed
file is counted arithmetically rather than walked. A variable or line-sequential file has to be walked
once to be counted - that runs in the background, the record count grows as it goes, and only every
256th record offset is kept, so the memory it costs stays in kilobytes whatever the file's size.

## Not in this version

Editing, field-by-field decoding against a copybook, VSAM KSDS and D-ISAM files, PDS members and GDG
generations. For those, and for editing, use RecordEditor and CatalogExplorer.

## Licence and support

MIT - see LICENSE.txt. The extension is provided **as is**: no warranty, no liability, and no support.
Use it under your own responsibility. Bug reports and pull requests are welcome, and nothing is promised
about them.

---

Made by [Raincode Labs](https://www.raincodelabs.com/).
