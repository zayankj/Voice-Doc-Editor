// Why an AI edit was not applied (src/lib/editFailure.js): a fixed reason code for the console, a plain sentence
// for the note. The editor's own error text can contain document words, so it is never logged. Dummy data only.
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reasonCode, notAppliedNote, editFailureLine, REASON_CODES, REASON_TEXT } from '../src/lib/editFailure.js';

test('each editor failure gets its fixed code', () => {
  assert.equal(reasonCode({ ok: false, error: 'Block B99 does not exist' }), 'no_such_block');
  assert.equal(reasonCode({ ok: false, error: '"ENTERIC FEVER" not found in B18. Use operation "set" instead.' }), 'text_not_found');
  assert.equal(reasonCode({ ok: false, error: '"Tab. DUMMYMED" not found in B12' }), 'text_not_found');
  assert.equal(reasonCode({ ok: false, error: 'insert_after needs new_value' }), 'missing_value');
  assert.equal(reasonCode({ ok: false, error: 'append needs new_value' }), 'missing_value');
  assert.equal(reasonCode({ ok: false, error: 'Unknown operation: move' }), 'unknown_operation');
  assert.equal(reasonCode({ ok: false, blocked: true, error: 'it would change the gender, which you did not ask for' }), 'rejected_by_check');
  assert.equal(reasonCode({ ok: false, error: 'something new' }), 'not_applied');
  assert.equal(reasonCode(null), 'not_applied');
});

test('every NOT blocked failure the editor can return (voiceEdit.js) has a specific code, not the catch-all', () => {
  const src = fs.readFileSync(new URL('../src/lib/voiceEdit.js', import.meta.url), 'utf8');
  // the plain { ok: false, error: `...` } returns (blocked ones are refused by a check and keep their own note)
  const plain = [...src.matchAll(/return \{ ok: false, error: (?:`([^`]+)`|'([^']+)') \}/g)].map((m) => m[1] ?? m[2]);
  assert.ok(plain.length >= 6, `found ${plain.length}`);
  for (const tpl of plain) {
    const sample = tpl.replace(/\$\{block_id\}/g, 'B18').replace(/\$\{find_text\}/g, 'TEXT').replace(/\$\{operation\}/g, 'move');
    assert.notEqual(reasonCode({ ok: false, error: sample }), 'not_applied', `no code for: ${tpl}`);
  }
});

test('the note says WHY, with the field label, never the editor\'s text (no document words)', () => {
  const note = notAppliedNote([{ code: 'text_not_found', label: 'Diagnosis' }]);
  assert.equal(note, '1 could not be applied (Diagnosis: the text to replace was not found there).');
  assert.equal(notAppliedNote([{ code: 'no_such_block', label: '' }, { code: 'missing_value', label: 'Advice' }]),
    '2 could not be applied (the place it pointed to does not exist in the document; Advice: the AI did not give the new text).');
  assert.equal(notAppliedNote([]), '');
  assert.equal(notAppliedNote([{ code: 'bogus', label: 'Follow Up' }]), `1 could not be applied (Follow Up: ${REASON_TEXT.not_applied}).`);
  for (const t of Object.values(REASON_TEXT)) assert.ok(!/ENTERIC|DUMMY|Tab\./.test(t));
});

test('console line: fixed codes and a count only; anything else becomes "?"', () => {
  assert.equal(editFailureLine(['text_not_found', 'rejected_by_check']), 'Edit not applied: count=2 reasons=text_not_found,rejected_by_check');
  for (const leak of ['ENTERIC FEVER', 'Tab. DUMMYMED 650 mg', 'DUMMY PATIENT', '"x" not found in B3']) {
    const line = editFailureLine([leak]);
    assert.equal(line, 'Edit not applied: count=1 reasons=?');
  }
  assert.equal(editFailureLine(null), 'Edit not applied: count=0 reasons=-');
  for (const c of REASON_CODES) assert.match(c, /^[a-z_]+$/);
});

test('App.jsx: the reason (not only a count) is in the note; only editFailureLine reaches the console', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /failed\.push\(\{ code: reasonCode\(r\), label: ed\.field_label \|\| '' \}\)/);
  assert.match(app, /notAppliedNote\(failed\)/);
  assert.ok(!/could not be applied\.` : ''/.test(app), 'the old count-only note is gone');
  assert.match(app, /if \(codes\.length\) console\.info\(editFailureLine\(codes\)\);/);
});
