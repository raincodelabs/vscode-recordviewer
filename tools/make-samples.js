// Writes sample datasets to a directory, for trying the viewer by hand and for test-integration.
//
//   npm run compile && node tools/make-samples.js <directory>
//
// Three files, because they are the three shapes a dataset comes in: fixed EBCDIC records with a
// .meta beside them, variable records behind a mainframe RDW, and a line-sequential ASCII file with
// no metadata at all - the one you have to set up by hand in the reading settings.

const fs = require('fs');
const path = require('path');

const { CodePage } = require(path.resolve(__dirname, '..', 'out', 'src', 'core', 'codepage'));

const out = process.argv[2];
if (!out) {
    console.error('Usage: node tools/make-samples.js <directory>');
    process.exit(1);
}

fs.mkdirSync(out, { recursive: true });

const page = CodePage.resolve('ibm037');
const names = ['SMITH', 'DUPONT', 'MULLER', 'GARCIA', 'ROSSI', 'JANSEN', 'NOVAK', 'OKONKWO', 'TANAKA', 'SVENSSON'];
const cities = ['BRUSSELS', 'PARIS', 'MUNICH', 'MADRID', 'MILANO', 'AMSTERDAM', 'PRAHA', 'LAGOS', 'TOKYO', 'STOCKHOLM'];

function meta(name, recordFormat, recordLength) {
    return `<dataSet
  name="${name}"
  copies="0"
  createDate="09/21/2026 09:00:00"
  dataSetType="File"
  fileFormat="EntrySequenced"
  recordFormat="${recordFormat}"
  recordLength="${recordLength}"
  isCataloged="true"
  markForDeletion="false" />
`;
}

// Fixed, EBCDIC, 80 bytes: the ordinary case. 500 records, 50 of them holding TANAKA.
const fixed = [];
for (let i = 1; i <= 500; i++) {
    const line = 'E' + String(i).padStart(5, '0')
        + names[i % names.length].padEnd(20)
        + cities[(i * 7) % cities.length].padEnd(20)
        + String(20000 + (i * 37) % 60000).padStart(8, '0')
        + '20260921';
    fixed.push(page.encode(line.padEnd(80).slice(0, 80)).bytes);
}
fs.writeFileSync(path.join(out, 'PAYROLL.EMPLOYEE.seq'), Buffer.concat(fixed));
fs.writeFileSync(path.join(out, 'PAYROLL.EMPLOYEE.meta'), meta('PAYROLL.EMPLOYEE', 'FB', 80));

// Variable, EBCDIC, mainframe RDW: records of different lengths.
const variable = [];
for (let i = 1; i <= 300; i++) {
    const text = 'TXN' + String(i).padStart(5, '0') + ' ' + names[i % names.length]
        + ' '.repeat(i % 17) + 'AMOUNT=' + String((i * 991) % 100000).padStart(6, '0');
    const data = page.encode(text).bytes;
    const length = data.length + 4;
    variable.push(Buffer.from([(length >> 8) & 0xff, length & 0xff, 0, 0]), data);
}
fs.writeFileSync(path.join(out, 'PAYROLL.HISTORY.seq'), Buffer.concat(variable));
fs.writeFileSync(path.join(out, 'PAYROLL.HISTORY.meta'), meta('PAYROLL.HISTORY', 'VB', 0));

// Line sequential, ASCII, no .meta: read it as LSEQ with a Windows-1252 code page.
const lines = [];
for (let i = 1; i <= 120; i++) lines.push('REPORT LINE ' + i + ' ' + cities[i % cities.length]);
fs.writeFileSync(path.join(out, 'report-no-meta.txt'), lines.join('\r\n') + '\r\n');

console.log('Wrote PAYROLL.EMPLOYEE (FB 80), PAYROLL.HISTORY (VB) and report-no-meta.txt to ' + out);
