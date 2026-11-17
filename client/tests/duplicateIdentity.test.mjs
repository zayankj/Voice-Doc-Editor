// Duplicate medicine detection compares the medicine's IDENTITY, not a shared word (src/lib/voiceEdit.js medicineName).
// Reported: "Add capsule Vitamin C 500 mg …" with "TAB. VITAMIN D 1000 IU" in Advice asked "VITAMIN is already in this
// section" - only the first word after the form was compared. VITAMIN / form words are not a name on their own.
// Runs the chain App.jsx runs: checkMedicineEdits -> withDuplicateChoice -> applyVoiceEdit. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history } from '@tiptap/pm/history';
import { checkMedicineEdits, withDuplicateChoice } from '../src/lib/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(here, '.build-dupidentity');
fs.mkdirSync(tmp, { recursive: true });
for (const f of ['voiceEdit', 'consistency', 'outline', 'guards', 'flash', 'tables', 'previewEdits', 'medicineText', 'sections']) {
  const src = fs.readFileSync(path.join(here, '../src/lib', `${f}.js`), 'utf8').replace(/from '\.\/([A-Za-z]+)'/g, "from './$1.js'");
  fs.writeFileSync(path.join(tmp, `${f}.js`), src);
}
const { applyVoiceEdit } = await import(pathToFileURL(path.join(tmp, 'voiceEdit.js')).href);
const { getBlocks } = await import(pathToFileURL(path.join(tmp, 'outline.js')).href);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const schema = getSchema([StarterKit]);
const p = (s, bold) => schema.node('paragraph', null, [schema.text(s, bold ? [schema.marks.bold.create()] : undefined)]);
const editorWith = (meds) => {
  const doc = schema.node('doc', null, [p('DIAGNOSIS', true), p('ENTERIC FEVER'), p('ADVICE', true), ...meds.map((m) => p(m)),
    p('Drink plenty of water.'), p('FOLLOW UP', true), p('Review in OPD after 1 week.')]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), schema, isDestroyed: false, dryRun: true };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
};
const id = (ed, start) => `B${getBlocks(ed.state.doc).findIndex((b) => b.node.textContent.startsWith(start))}`;
const advice = (ed) => {
  const out = [];
  let on = false;
  ed.state.doc.forEach((n) => { const t = n.textContent; if (t === 'ADVICE') on = true; else if (t === 'FOLLOW UP') on = false; else if (on) out.push(t); });
  return out;
};
// the whole chain, as App.jsx runs it; returns the applied result
function addSaid(ed, said, newValue, at) {
  const edits = [{ block_id: id(ed, at), operation: 'insert_after', new_value: newValue, field_label: 'Advice' }];
  const med = checkMedicineEdits(ed.state.doc, { said, edits });
  assert.equal(med.reject, undefined, med.reject);
  const [edit] = withDuplicateChoice(med.edits, med.newEntries);
  return applyVoiceEdit(ed, edit);
}

const VIT_D = 'TAB. VITAMIN D 1000 IU — ONCE DAILY';
const VIT_C_1000 = 'CAP. VITAMIN C 1000 MG — ONCE DAILY';
const PAN = 'TAB. PAN 40 MG — ONCE DAILY';
const NEW_C = 'CAP. VITAMIN C 500 MG — AFTER FOOD — 5 DAYS';
const SAID_C = 'Add capsule Vitamin C 500 mg after food for 5 days.';

test('REPORTED: Vitamin C when Vitamin D exists -> added (no "VITAMIN is already" question), after the last medicine', () => {
  const ed = editorWith([VIT_D, PAN]);
  const r = addSaid(ed, SAID_C, NEW_C, 'TAB. PAN');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(advice(ed), [VIT_D, PAN, NEW_C, 'Drink plenty of water.']);
  // also without the check in front (applyVoiceEdit alone)
  const e2 = editorWith([VIT_D, PAN]);
  const r2 = applyVoiceEdit(e2, { block_id: id(e2, 'TAB. PAN'), operation: 'insert_after', new_value: NEW_C, field_label: 'Advice' });
  assert.equal(r2.ok, true, r2.error);
});

test('Vitamin D when Vitamin C exists -> added', () => {
  const ed = editorWith([VIT_C_1000, PAN]);
  const r = addSaid(ed, 'Add tablet Vitamin D 1000 IU once daily.', VIT_D, 'TAB. PAN');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(advice(ed), [VIT_C_1000, PAN, VIT_D, 'Drink plenty of water.']);
});

test('Vitamin C 500 mg when Vitamin C 1000 mg exists -> the same medicine: the existing duplicate rules apply', () => {
  // an ADD said by the person: a NEW line, the existing entry unchanged (duplicate_ok set by the check, as before)
  const ed = editorWith([VIT_C_1000, PAN]);
  const r = addSaid(ed, SAID_C, NEW_C, 'TAB. PAN');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(advice(ed), [VIT_C_1000, PAN, NEW_C, 'Drink plenty of water.']);
  // without the person's duplicate choice: the existing question, naming VITAMIN C, nothing changed
  const e2 = editorWith([VIT_C_1000, PAN]);
  const before = e2.state.doc;
  const r2 = applyVoiceEdit(e2, { block_id: id(e2, 'TAB. PAN'), operation: 'insert_after', new_value: NEW_C, field_label: 'Advice' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /^VITAMIN C is already in this section\. Do you want to change the existing entry, or add another VITAMIN C entry\? Nothing was changed/);
  assert.ok(e2.state.doc.eq(before));
});

test('two identical entries: added as a separate line by an ADD; the question otherwise (unchanged behaviour)', () => {
  const ed = editorWith([VIT_D, PAN]);
  const r = addSaid(ed, 'Add tablet Pan 40 mg once daily.', PAN, 'TAB. PAN');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(advice(ed), [VIT_D, PAN, PAN, 'Drink plenty of water.'], 'kept as two separate entries, nothing merged');
  const e2 = editorWith([VIT_D, PAN]);
  const r2 = applyVoiceEdit(e2, { block_id: id(e2, 'TAB. PAN'), operation: 'insert_after', new_value: PAN, field_label: 'Advice' });
  assert.match(r2.error, /^PAN is already in this section/);
});

test('different medicines sharing a word (VITAMIN, TABLET, CAPSULE, SYRUP) are not duplicates; the same ones still are', () => {
  const ed = editorWith(['Tab. VITAMIN B12 500 mcg — Once Daily', 'Cap. VITAMIN E 400 IU — Once Daily', 'Syp. BENADRYL — Daily Morning (1-0-0)', 'Tab. TABLET X']);
  const at = id(ed, 'Tab. TABLET X');
  const ask = (v) => { const e = editorWith(['Tab. VITAMIN B12 500 mcg — Once Daily', 'Cap. VITAMIN E 400 IU — Once Daily', 'Syp. BENADRYL — Daily Morning (1-0-0)', 'Tab. TABLET X']);
    return applyVoiceEdit(e, { block_id: at, operation: 'insert_after', new_value: v, field_label: 'Advice' }); };
  for (const v of ['Cap. VITAMIN C 500 mg', 'Tab. VITAMIN D3 60000 IU', 'Tab. VITAMIN B6 10 mg', 'Syp. CALPOL 5 ml', 'Tab. TABLET Y'])
    assert.equal(ask(v).ok, true, `${v}: ${ask(v).error}`);
  assert.match(ask('Tab. VITAMIN B12 1000 mcg').error, /^VITAMIN B12 is already in this section/);
  assert.match(ask('Tablet Vitamin E').error, /^VITAMIN E is already in this section/);
  assert.match(ask('Syp. BENADRYL 10 ml').error, /^BENADRYL is already in this section/);
  // a medicine named only "VITAMIN": compared as before
  const v = editorWith(['Tab. VITAMIN 500 mg — Once Daily']);
  assert.match(applyVoiceEdit(v, { block_id: id(v, 'Tab. VITAMIN'), operation: 'insert_after', new_value: 'Tab. VITAMIN 250 mg OD', field_label: 'Advice' }).error, /^VITAMIN is already in this section/);
});

test('adding a new medicine at the top / at the bottom still works', () => {
  const top = editorWith([VIT_D, PAN]);
  const r = addSaid(top, 'Add capsule Vitamin C 500 mg after food for 5 days at the top.', NEW_C, 'ADVICE');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(advice(top), [NEW_C, VIT_D, PAN, 'Drink plenty of water.']);
  const bottom = editorWith([VIT_D, PAN]);
  const r2 = addSaid(bottom, 'Add capsule Vitamin C 500 mg after food for 5 days at the bottom.', NEW_C, 'TAB. PAN');
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(advice(bottom), [VIT_D, PAN, NEW_C, 'Drink plenty of water.']);
});
