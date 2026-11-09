// Tests for removing WHOLE medicine entries (src/lib/medicineText.js: brandOf, planEntryRemoval, applyRemovals)
// Run:  cd client  &&  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { history, undo } from '@tiptap/pm/history';
import { brandOf, planEntryRemoval, applyRemovals, sectionEntries, textAfter } from '../src/lib/medicineText.js';
import { getSections } from '../src/lib/sections.js';
import { getBlocks } from '../src/lib/outline.js';

const schema = getSchema([StarterKit]);
const BOLD = () => [schema.marks.bold.create()];
const t = (s, m) => schema.text(s, m);
const br = () => schema.nodes.hardBreak.create();
const para = (...k) => schema.node('paragraph', null, k);
const heading = (s) => para(t(s, BOLD()));
const brPara = (lines) => para(...lines.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)])));

const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Oral — Once Daily (1-0-0) — 14 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'Syp. CREMAFFIN 15 ml — Oral — At night — 5 days',
  'Cap. PAN-D 40 mg — Oral — Once Daily — 5 days',
  'Tab. CIPLOX 500 mg — Oral — Twice Daily (1-0-1) — 3 days',
];
const OTHER = ['DIAGNOSIS', 'ENTERIC FEVER (A01.0: Typhoid fever)', 'COURSE IN HOSPITAL', 'Treated with Syp. ONDEM and Tab. DOLO.'];

function makeEditor(adviceBlocks) {
  const doc = schema.node('doc', null, [heading('DIAGNOSIS'), para(t(OTHER[1])), heading('COURSE IN HOSPITAL'), para(t(OTHER[3])), heading('ADVICE'), ...adviceBlocks, heading('FOLLOW UP'), para(t('Review after 5 days'))]);
  const ed = { state: EditorState.create({ doc, plugins: [history()] }), isDestroyed: false };
  ed.view = { dispatch: (tr) => { ed.state = ed.state.apply(tr); } };
  return ed;
}
const LAYOUTS = {
  'one paragraph with line breaks': () => [brPara(ADVICE)],
  'separate paragraphs': () => ADVICE.map((l) => para(t(l))),
};
const advice = (ed) => getSections(ed.state.doc).find((s) => s.title === 'ADVICE');
const entries = (ed) => sectionEntries(ed.state.doc, advice(ed)).map((e) => e.text);
// everything outside the Advice section: the parts before the ADVICE heading and from FOLLOW UP on
const outside = (ed) => {
  const all = getBlocks(ed.state.doc).map((b) => b.node.textContent);
  return [...all.slice(0, all.indexOf('ADVICE')), ...all.slice(all.indexOf('FOLLOW UP'))];
};
const plan = (ed, o) => planEntryRemoval(ed.state.doc, advice(ed), o);
const done = (ed) => { ed.isDestroyed = true; };
const without = (...gone) => ADVICE.filter((l) => !gone.includes(l));

test('brand names are read correctly', () => {
  assert.equal(brandOf(ADVICE[4]), 'DOLO');
  assert.equal(brandOf(ADVICE[1]), 'METRONIDAZOLE');
  assert.equal(brandOf(ADVICE[6]), 'PAN-D');
  assert.equal(brandOf('AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — Oral'), 'AZIPROPROTEIN POWDER');
});

for (const [layout, blocks] of Object.entries(LAYOUTS)) {
  test(`remove the tablet Dolo (${layout})`, () => {
    const ed = makeEditor(blocks());
    const before = outside(ed);
    const p = plan(ed, { forms: ['tab'], names: ['Dolo'] });
    assert.deepEqual(p.changes.map((c) => c.before), [ADVICE[4]]);
    assert.equal(textAfter(p.changes[0]), '');
    assert.equal(applyRemovals(ed, p).ok, true);
    assert.deepEqual(entries(ed), without(ADVICE[4]));
    assert.deepEqual(outside(ed), before); // Course in Hospital still mentions Tab. DOLO
    done(ed);
  });

  test(`remove all syrups (${layout})`, () => {
    const ed = makeEditor(blocks());
    const p = plan(ed, { forms: ['syp'] });
    assert.deepEqual(p.changes.map((c) => c.before), [ADVICE[2], ADVICE[5]]);
    applyRemovals(ed, p);
    assert.deepEqual(entries(ed), without(ADVICE[2], ADVICE[5]));
    done(ed);
  });

  test(`remove all tablets (${layout})`, () => {
    const ed = makeEditor(blocks());
    applyRemovals(ed, plan(ed, { forms: ['tab'] }));
    assert.deepEqual(entries(ed), [ADVICE[2], ADVICE[5], ADVICE[6]]);
    done(ed);
  });

  test(`a name matching several medicines (Ciplox) -> both proposed (${layout})`, () => {
    const ed = makeEditor(blocks());
    const p = plan(ed, { names: ['Ciplox'] });
    assert.deepEqual(p.changes.map((c) => c.before), [ADVICE[0], ADVICE[7]]);
    applyRemovals(ed, p);
    assert.deepEqual(entries(ed), without(ADVICE[0], ADVICE[7])); // first AND last line removed
    done(ed);
  });

  test(`ONE Undo restores the exact original (${layout})`, () => {
    const ed = makeEditor(blocks());
    const original = ed.state.doc;
    applyRemovals(ed, plan(ed, { forms: ['syp', 'cap'] }));
    undo(ed.state, ed.view.dispatch);
    assert.ok(ed.state.doc.eq(original));
    done(ed);
  });
}

test('one paragraph: exactly ONE line break remains between the remaining medicines, none at the start or end', () => {
  for (const gone of [[0], [7], [0, 7], [2, 3, 4], [0, 1, 2, 3, 4, 5, 6]]) {
    const ed = makeEditor([brPara(ADVICE)]);
    const p = plan(ed, { names: gone.map((i) => brandOf(ADVICE[i])) });
    applyRemovals(ed, p);
    const para = ed.state.doc.child(5);
    const kinds = [];
    para.forEach((n) => kinds.push(n.type.name));
    assert.notEqual(kinds[0], 'hardBreak', `starts with a line break after removing ${gone}`);
    assert.notEqual(kinds.at(-1), 'hardBreak', `ends with a line break after removing ${gone}`);
    assert.ok(!kinds.some((k, i) => k === 'hardBreak' && kinds[i + 1] === 'hardBreak'), `double line break after removing ${gone}`);
    done(ed);
  }
});

test('one paragraph: removing EVERY medicine removes the paragraph; the heading and other sections stay', () => {
  const ed = makeEditor([brPara(ADVICE.slice(0, 2))]);
  applyRemovals(ed, plan(ed, { names: ['Ciplox', 'Metronidazole'] }));
  const texts = getBlocks(ed.state.doc).map((b) => b.node.textContent);
  assert.deepEqual(texts, ['DIAGNOSIS', OTHER[1], 'COURSE IN HOSPITAL', OTHER[3], 'ADVICE', 'FOLLOW UP', 'Review after 5 days']);
  done(ed);
});

test('formatting of the remaining medicines is kept (bold brand stays bold)', () => {
  const p1 = para(t('Tab. '), t('CIPLOX', BOLD()), t(' 200 mg — Oral'), br(), t('Tab. '), t('DOLO', BOLD()), t(' 650 mg — Oral'), br(), t('Syp. '), t('ONDEM', BOLD()), t(' 5 ml'));
  const ed = makeEditor([p1]);
  applyRemovals(ed, plan(ed, { names: ['Dolo'] }));
  assert.deepEqual(entries(ed), ['Tab. CIPLOX 200 mg — Oral', 'Syp. ONDEM 5 ml']);
  const bold = [];
  ed.state.doc.child(5).forEach((n) => { if (n.marks?.some((m) => m.type.name === 'bold')) bold.push(n.text); });
  assert.deepEqual(bold, ['CIPLOX', 'ONDEM']);
  done(ed);
});

test('a medicine that does not exist -> nothing proposed, reported as not found', () => {
  const ed = makeEditor([brPara(ADVICE)]);
  const p = plan(ed, { forms: ['tab'], names: ['Crocin'] });
  assert.equal(p.changes.length, 0);
  assert.deepEqual(p.notFound, ['Crocin']);
  done(ed);
});

test('"tablet Dolo" only removes the TABLET called Dolo; a generic name also finds the brand', () => {
  const ed = makeEditor([brPara([...ADVICE, 'Syp. DOLO 120 mg/5 ml — Oral — 3 days'])]);
  assert.deepEqual(plan(ed, { forms: ['tab'], names: ['Dolo'] }).changes.map((c) => c.before), [ADVICE[4]]);
  assert.deepEqual(plan(ed, { names: ['Paracetamol'] }).changes.map((c) => c.before), [ADVICE[4]]);
  done(ed);
});

test('the preview count: every other medicine is listed as unchanged', () => {
  const ed = makeEditor([brPara(ADVICE)]);
  const p = plan(ed, { forms: ['syp'] });
  assert.equal(p.changes.length + p.unchanged.length, ADVICE.length);
  assert.deepEqual(p.counts, { entry: 2 });
  done(ed);
});

test('an entry changed after the preview -> nothing applied', () => {
  const ed = makeEditor([brPara(ADVICE)]);
  const p = plan(ed, { forms: ['syp'] });
  const b = getBlocks(ed.state.doc)[p.changes[0].block];
  ed.view.dispatch(ed.state.tr.insertText('X', b.pos + 1));
  const snapshot = ed.state.doc;
  assert.equal(applyRemovals(ed, p).ok, false);
  assert.ok(ed.state.doc.eq(snapshot));
  done(ed);
});
