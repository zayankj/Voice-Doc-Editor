// Tests for src/components/ConfirmChanges.jsx (the preview window)
// Run:  cd client  &&  node --test tests/
// The component is bundled with esbuild (already installed with Vite; packages stay external)
// and rendered with React's server renderer. Plans come from the real classifier (commandIntent.js).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { classifyCommand } from '../src/lib/commandIntent.js';
import { textAfter } from '../src/lib/medicineText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '.build');
const outFile = path.join(outDir, 'ConfirmChanges.mjs');
await build({
  entryPoints: [path.join(here, '../src/components/ConfirmChanges.jsx')],
  outfile: outFile, format: 'esm', jsx: 'automatic', bundle: true, packages: 'external', logLevel: 'silent',
});
const { default: ConfirmChanges, segments, countsSummary, kindLabel } = await import(pathToFileURL(outFile).href);
after(() => fs.rmSync(outDir, { recursive: true, force: true }));

// The real layout: 8 medicines in ONE paragraph separated by line breaks
const schema = getSchema([StarterKit]);
const t = (s, marks) => schema.text(s, marks);
const para = (...kids) => schema.node('paragraph', null, kids);
const heading = (s) => para(t(s, [schema.marks.bold.create()]));
const br = () => schema.nodes.hardBreak.create();
const ADVICE = [
  'Tab. CIPLOX (Ciprofloxacin) 200 mg — Oral — Twice Daily (1-0-1) — 2 days',
  'Tab. METRONIDAZOLE (Metronidazole) 500 mg — Oral — Three Times Daily (1-1-1) — 2 days',
  'Syp. INSTARAFT (Antacid) 10 ml — Oral — Three Times Daily (1-1-1) — 5 days',
  'Tab. ZINCOVIT (Multivitamin/Mineral) — Oral — Once Daily (1-0-0) — 14 days',
  'Tab. BACTOGUT (Probiotic) — Oral — Once Daily (1-0-0) — 7 days',
  'Tab. DOLO (Paracetamol) 650 mg — Oral — As Needed (SOS)',
  'AZIPROPROTEIN POWDER (Protein Supplement) 2 scoops — Oral — Twice Daily (1-0-1) — 1 week',
  'Tab. CIPLOX 500 mg — Oral — Twice Daily (1-0-1) — 3 days',
];
const doc = schema.node('doc', null, [
  heading('DIAGNOSIS'), para(t('ENTERIC FEVER')),
  heading('ADVICE'), para(...ADVICE.flatMap((l, i) => (i ? [br(), t(l)] : [t(l)]))),
]);
const render = (r) => renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: r.kind, plan: r.plan, onApply() {}, onCancel() {} }));
const rowsOf = (html) => html.match(/<li class="[^"]*">.*?<\/li>/gs) || [];

test('generic names: ONE ROW PER MEDICINE ENTRY, accurate count, unchanged entries listed', () => {
  const r = classifyCommand(doc, 'Remove generic names from Advice');
  const html = render(r);
  assert.match(html, /Remove generic names from Advice/);
  // 7 entries have a bracket (3 generic ticked + 4 descriptions shown), 1 has none
  assert.equal((html.match(/class="confirm-row"/g) || []).length, 7);
  assert.match(html, /3 of 8 medicine entries will change/);
  assert.match(html, /1 entry will not change/);
  assert.match(html, /Tab\. CIPLOX 500 mg — Oral — Twice Daily \(1-0-1\) — 3 days<\/li>/); // the unchanged one
});

test('generic names: struck-out bracket, proposed line, description chip NOT ticked', () => {
  const html = render(classifyCommand(doc, 'Remove generic names from Advice'));
  assert.match(html, /<del> \(Ciprofloxacin\)<\/del>/);
  assert.match(html, /→ Tab\. CIPLOX 200 mg — Oral — Twice Daily \(1-0-1\) — 2 days/);
  assert.match(html, /→ Tab\. DOLO 650 mg — Oral — As Needed \(SOS\)/);
  // the Antacid entry: its chip is unticked and the line is unchanged
  assert.match(html, /<label class="confirm-chip "><input type="checkbox"\/><span>\(Antacid\)<\/span><em>description<\/em>/);
  assert.match(html, /→ Syp\. INSTARAFT \(Antacid\) 10 ml/);
  assert.match(html, /Items marked <i>description<\/i>/);
});

test('route + frequency (your voice sentence): a tick box for EACH removal, labelled', () => {
  const r = classifyCommand(doc, 'Inside the Advice section remove oral in all the section and twice daily and so on.');
  const html = render(r);
  assert.match(html, /8 of 8 medicine entries will change/);
  const first = rowsOf(html)[0];
  assert.match(first, /<span>Oral<\/span><em>route<\/em>/);
  assert.match(first, /<span>Twice Daily<\/span><em>frequency<\/em>/);
  assert.equal((first.match(/class="confirm-chip on"/g) || []).length, 2);
  assert.match(first, /→ Tab\. CIPLOX \(Ciprofloxacin\) 200 mg — \(1-0-1\) — 2 days/);
  assert.match(html, /Found: route ×8, frequency ×7/);
  assert.match(html, /→ Tab\. DOLO \(Paracetamol\) 650 mg — As Needed \(SOS\)/); // SOS kept
});

test('the preview shows EXACTLY what Apply deletes (same calculation)', () => {
  const r = classifyCommand(doc, 'Remove phrases such as Oral, Twice Daily, Three Times Daily and so on from advice');
  for (const c of r.plan.changes) {
    const shownAfter = segments(c).filter((s) => !s.removed).map((s) => s.text).join('');
    assert.equal(shownAfter, textAfter(c));
  }
});

test('not found is reported', () => {
  const r = classifyCommand(doc, 'remove Oral, Twice Daily and Thrice daily from advice');
  assert.match(render(r), /Not found in Advice: Thrice daily/);
});

test('Apply is disabled when nothing is ticked; count shows 0', () => {
  const r = classifyCommand(doc, 'Remove generic names from Advice');
  const none = { ...r.plan, changes: r.plan.changes.map((c) => ({ ...c, removals: c.removals.map((x) => ({ ...x, selected: false })) })) };
  const html = renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: 'generic', plan: none, onApply() {}, onCancel() {} }));
  assert.match(html, /<button class="seg-btn on" disabled="">Apply<\/button>/);
  assert.match(html, /0 of 8 medicine entries will change/);
});

test('the window never shows other sections or the heading as content', () => {
  const html = render(classifyCommand(doc, 'Remove generic names from Advice'));
  assert.doesNotMatch(html, /ENTERIC FEVER/);
  assert.doesNotMatch(html, /<li[^>]*>[^<]*ADVICE/);
});

// ---------- whole medicines ----------
test('WHOLE MEDICINES ("remove all syrups"): one card each, struck out, "→ Medicine removed", "whole medicine"', () => {
  const r = classifyCommand(doc, "Remove all type of syrup. I don't want syrup in the advice section. Remove that syrup.");
  assert.equal(r.kind, 'entries');
  const html = render(r);
  assert.match(html, /Remove medicines from Advice/);
  const rows = rowsOf(html);
  assert.equal((html.match(/class="confirm-row"/g) || []).length, 1); // the one syrup in this document
  assert.match(rows[0], /<del>Syp\. INSTARAFT \(Antacid\) 10 ml — Oral — Three Times Daily \(1-1-1\) — 5 days<\/del>/);
  assert.match(rows[0], /→ Medicine removed/);
  assert.match(rows[0], /<em>whole medicine<\/em>/);
  // how many go / stay, in the window and the footer
  assert.equal((html.match(/1 medicine will be removed · 7 will remain unchanged/g) || []).length, 2);
  assert.match(html, /7 medicines will remain unchanged<\/summary>/);
});

test('WHOLE MEDICINES: several matches each get their own card ("remove Ciplox")', () => {
  const html = render(classifyCommand(doc, 'remove Ciplox from advice'));
  assert.equal((html.match(/class="confirm-row"/g) || []).length, 2);
  assert.match(html, /2 medicines will be removed · 6 will remain unchanged/);
});

test('WHOLE MEDICINES: not-found medicines are shown separately', () => {
  const html = render(classifyCommand(doc, 'remove the tablet Dolo and the tablet Crocin'));
  assert.match(html, /<p class="confirm-note warn">Not found in Advice \(nothing removed for these\): Crocin<\/p>/);
  assert.match(html, /<del>Tab\. DOLO \(Paracetamol\) 650 mg — Oral — As Needed \(SOS\)<\/del>/);
});

test('WHOLE MEDICINES: an unticked medicine shows "→ Kept" and is not counted; Apply disabled when none', () => {
  const r = classifyCommand(doc, 'remove Ciplox from advice');
  const one = { ...r.plan, changes: r.plan.changes.map((c, i) => ({ ...c, removals: c.removals.map((x) => ({ ...x, selected: i === 0 })) })) };
  const html = renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: 'entries', plan: one, onApply() {}, onCancel() {} }));
  assert.match(html, /→ Kept: Tab\. CIPLOX 500 mg/);
  assert.match(html, /1 medicine will be removed · 7 will remain unchanged/);
  const none = { ...r.plan, changes: r.plan.changes.map((c) => ({ ...c, removals: c.removals.map((x) => ({ ...x, selected: false })) })) };
  const html2 = renderToStaticMarkup(React.createElement(ConfirmChanges, { kind: 'entries', plan: none, onApply() {}, onCancel() {} }));
  assert.match(html2, /<button class="seg-btn on" disabled="">Apply<\/button>/);
});

test('helpers: readable labels and counts', () => {
  assert.equal(kindLabel('as_needed'), 'as needed');
  assert.equal(countsSummary({ route: 3, frequency: 2, Oral: 1, none: 0 }), 'route ×3, frequency ×2, Oral ×1');
});
