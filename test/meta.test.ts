import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { dataNameCandidates, isMetaName, metaNameCandidates, parseMeta } from '../src/core/meta';

test('reads what the catalog writes', () => {
    const meta = parseMeta(`<dataSet
  name="SYS1.PROCLIB"
  copies="0"
  createDate="12/22/2020 17:03:18"
  dataSetType="PDS"
  fileFormat="EntrySequenced"
  recordFormat="LSEQ"
  recordLength="80"
  isCataloged="false"
  markForDeletion="false" />`, 'X.meta');

    assert.equal(meta?.name, 'SYS1.PROCLIB');
    assert.equal(meta?.recordFormat, 'LSEQ');
    assert.equal(meta?.recordLength, 80);
    assert.equal(meta?.fileFormat, 'EntrySequenced');
    assert.equal(meta?.dataSetType, 'PDS');
});

test('a record format it does not know is left undefined rather than guessed', () => {
    const meta = parseMeta('<dataSet name="A.B" recordFormat="WHAT" recordLength="0" />', 'X.meta');

    assert.equal(meta?.name, 'A.B');
    assert.equal(meta?.recordFormat, undefined);
    assert.equal(meta?.recordLength, undefined, 'a zero length says nothing, and must not become one');
});

test('reads a namespaced or reformatted element', () => {
    const meta = parseMeta('<?xml version="1.0"?>\n<ns:dataSet recordFormat="VB" recordLength="1024"></ns:dataSet>', 'X.meta');

    assert.equal(meta?.recordFormat, 'VB');
    assert.equal(meta?.recordLength, 1024);
});

test('decodes the entities a DSN can carry', () => {
    const meta = parseMeta('<dataSet name="A &amp; B" />', 'X.meta');

    assert.equal(meta?.name, 'A & B');
});

test('anything that is not a dataSet element is not a meta file', () => {
    assert.equal(parseMeta('<project><PropertyGroup /></project>', 'X.meta'), undefined);
    assert.equal(parseMeta('', 'X.meta'), undefined);
});

// The naming rules are pure so that they hold for a path on disk and for the path of a URI alike -
// an ssh:// dataset finds its .meta by the same names as a local one.

test('a data file points at the meta beside it', () => {
    assert.deepEqual(metaNameCandidates('PAYROLL.EMPLOYEE.seq'), ['PAYROLL.EMPLOYEE.meta']);
    assert.deepEqual(metaNameCandidates('CAT1.dat'), ['CAT1.meta']);
    assert.deepEqual(metaNameCandidates('(DBBBATCH).txt'), ['(DBBBATCH).meta']);
});

test("a file whose extension is not the catalog's tries both readings of its name", () => {
    // MY.DATA.SET could be a dataset called MY.DATA.SET, or MY.DATA with a suffix; both are looked for.
    assert.deepEqual(metaNameCandidates('MY.DATA.SET'), ['MY.DATA.SET.meta', 'MY.DATA.meta']);
    assert.deepEqual(metaNameCandidates('DATASET'), ['DATASET.meta']);
});

test('a meta points at every extension the catalog writes, then the bare name', () => {
    assert.deepEqual(dataNameCandidates('CAT1.meta'),
        ['CAT1.seq', 'CAT1.dat', 'CAT1.txt', 'CAT1.idx', 'CAT1.rr', 'CAT1']);
});

test('the meta is recognised by its extension, whatever the case', () => {
    assert.equal(isMetaName('CAT1.meta'), true);
    assert.equal(isMetaName('CAT1.META'), true);
    assert.equal(isMetaName('CAT1.seq'), false);
    assert.equal(isMetaName('meta'), false);
});
