import { getBlocks } from './outline';
import { flashKey } from './flash';

// Read aloud with the browser's built-in speech engine: free, no key, no model.

// ---------- settings you can change ----------
const INTRO = 'Reading the discharge summary now.';
const OUTRO = 'That is the end of the summary.';
const PITCH = 1.0;
// Reads two-cell table rows as "label: value". Set to false if your tables are normal grids.
const PAIR_TABLE_CELLS = true;
// Reads mobile / registration / IP / bed numbers digit by digit. Set to false to read them as normal numbers.
const SPELL_ID_DIGITS = true;

let runId = 0; // lets us ignore events from a reading that was already stopped

export const ttsSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

// ---------- voices ----------
const FEMALE =
  /\b(aria|jenny|sonia|libby|natasha|neerja|swara|heera|zira|hazel|susan|catherine|linda|samantha|karen|moira|tessa|veena|fiona|victoria|allison|ava|joanna|kendra|kimberly|salli|ivy|emma|amy|olivia|serena|female)\b/i;
const MALE =
  /\b(david|mark|george|ravi|hemant|guy|ryan|james|daniel|alex|fred|rishi|prabhat|christopher|eric|roger|brian|andrew|davis|jason|tony|thomas|male)\b/i;

function scoreVoice(v) {
  const name = v.name || '';
  const lang = v.lang || '';
  let s = 0;
  if (MALE.test(name)) s -= 100;
  if (FEMALE.test(name)) s += 30;
  if (/natural/i.test(name)) s += 50; // Edge "Natural" voices are the most human-sounding
  else if (/online/i.test(name)) s += 15;
  if (/google/i.test(name)) s += 12; // Chrome's Google voices sound smoother than basic Windows ones
  if (/^en[-_]IN/i.test(lang)) s += 8;
  else if (/^en[-_]GB/i.test(lang)) s += 6;
  else if (/^en[-_]US/i.test(lang)) s += 5;
  else if (/^en/i.test(lang)) s += 3;
  else s -= 50;
  return s;
}

// English voices, best female voice first
function rankVoices(list) {
  const english = list.filter((v) => /^en/i.test(v.lang || ''));
  const pool = english.length ? english : list;
  return [...pool].sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

// Calls callback with the ranked voices now and again whenever the browser finishes loading more
export function watchVoices(callback) {
  if (!ttsSupported()) {
    callback([]);
    return () => {};
  }
  const synth = window.speechSynthesis;
  const update = () => callback(rankVoices(synth.getVoices()));
  update();
  synth.addEventListener('voiceschanged', update);
  return () => synth.removeEventListener('voiceschanged', update);
}

// ---------- make the text sound natural ----------
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function spokenDate(d, m, y) {
  const day = Number(d);
  const month = Number(m);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${day} ${MONTHS[month - 1]} ${y}`;
}

// "9494705601" -> "9 4 9 4 7 0 5 6 0 1"
const SPELL = (s) => s.split('').join(' ');

// Splits a run of digits into small groups so it can be read with pauses
function groupDigits(d) {
  if (d.length === 10) return [d.slice(0, 5), d.slice(5)]; // mobile: 94947 05601
  if (d.length <= 6) return [d];
  const out = [];
  for (let i = 0; i < d.length; i += 4) out.push(d.slice(i, i + 4));
  return out;
}

// "STR - 721" -> "S T R, 7 2 1"     "IP00019814" -> "I P, 0 0 0 1, 9 8 1 4"
function spellOut(value) {
  const runs = value.replace(/[\s-]+/g, '').match(/[A-Za-z]+|\d+/g) || [];
  const spoken = [];
  for (const run of runs) {
    if (/^\d+$/.test(run)) groupDigits(run).forEach((g) => spoken.push(SPELL(g)));
    else spoken.push(SPELL(run.toUpperCase()));
  }
  return spoken.join(', ');
}

// ---------- ID fields: "Patient mobile no : 949..." -> "patient mobile number is 9 4 9 ..." ----------
const NUM = '(?:no|number|num)\\b\\.?';
const VALUE = '((?:[A-Za-z]{1,5}\\s*-?\\s*)?\\d[\\d\\s-]*\\d|\\d|not\\s+specified)';

const ID_RULES = [
  {
    src: `(?:patient\\s+)?(?:(?:mobile|phone|cell)\\b\\s*(?:${NUM})?|contact\\s*${NUM})`,
    say: (l) =>
      `${/patient/i.test(l) ? 'patient ' : ''}${l.match(/mobile|phone|cell|contact/i)[0].toLowerCase()} number`,
  },
  { src: `reg(?:istration)?\\s*${NUM}`, say: () => 'registration number' },
  { src: `ip\\s*${NUM}`, say: () => 'I P number' },
  { src: `bed\\s*${NUM}`, say: () => 'bed number' },
  { src: `patient\\s*${NUM}`, say: () => 'patient number' },
].map(({ src, say }) => ({ re: new RegExp(`\\b(${src})\\s*[:\\-]?\\s*${VALUE}`, 'gi'), say }));

function speakIds(text) {
  let t = text;
  for (const { re, say } of ID_RULES) {
    t = t.replace(re, (m, label, value) => {
      if (/^not/i.test(value)) return `${say(label)} is not specified`;
      return `${say(label)} is ${SPELL_ID_DIGITS ? spellOut(value) : value}`;
    });
  }
  return t;
}

const GENDER = { m: 'male', f: 'female', male: 'male', female: 'female' };

export function toSpoken(input) {
  let t = String(input || '');

  t = t.replace(/[\u26A0\uFE0F]/g, ''); // warning symbol

  // ID fields (mobile, registration, IP, bed, patient number)
  t = speakIds(t);

  // phone numbers without a label: landline 0492 2351111, or any run of 10+ digits
  t = t.replace(/\b0\d{2,4}[\s-]\d{6,8}\b/g, (m) => m.split(/[\s-]+/).map(SPELL).join(', '));
  t = t.replace(/\b\d{10,}\b/g, (m) => groupDigits(m).map(SPELL).join(', '));

  // age and gender: "60 Y / FEMALE" -> "60 year old female",  "Female / 15" -> "15 year old female"
  t = t.replace(
    /\b(\d{1,3})\s*(?:y|yrs?|years?)\b\.?\s*\/?\s*(male|female|m|f)\b/gi,
    (m, age, g) => `${age} year old ${GENDER[g.toLowerCase()]}`
  );
  t = t.replace(/\b(male|female)\s*\/\s*(\d{1,3})\b/gi, (m, g, age) => `${age} year old ${g.toLowerCase()}`);
  t = t.replace(/\bGender\s*\/\s*Age\b/gi, 'Gender and age');

  // dates: 23-10-2026, 23/10/2026, 06/11/26
  t = t.replace(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g, (m, d, mo, y) => spokenDate(d, mo, y) ?? m);
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/g, (m, d, mo, y) => spokenDate(d, mo, `20${y}`) ?? m);

  // numbers written with commas: 3,86,000 -> 386000
  t = t.replace(/\b\d{1,3}(?:,\d{2,3})+\b/g, (m) => m.replace(/,/g, ''));

  // dosage pattern 1-0-1 -> "1, 0, 1"
  t = t.replace(/\b(\d)-(\d)-(\d)\b/g, '$1, $2, $3');

  // blood pressure 120/80 -> "120 over 80"
  t = t.replace(/\b(\d{2,3})\/(\d{2,3})\b/g, '$1 over $2');

  // units
  t = t
    .replace(/\bmmhg\b/gi, 'millimetres of mercury')
    .replace(/\bmg\/dl\b/gi, 'milligrams per decilitre')
    .replace(/\bg\/dl\b/gi, 'grams per decilitre')
    .replace(/\bmeq\/l\b/gi, 'milli equivalents per litre')
    .replace(/\bu\/l\b/gi, 'units per litre')
    .replace(/\/cumm\b/gi, ' per cubic millimetre')
    .replace(/\bbpm\b/gi, 'beats per minute')
    .replace(/(\d)\s*mcg\b/gi, '$1 micrograms')
    .replace(/(\d)\s*mg\b/gi, '$1 milligrams')
    .replace(/(\d)\s*ml\b/gi, '$1 millilitres')
    .replace(/(\d)\s*kg\b/gi, '$1 kilograms')
    .replace(/(\d)\s*cm\b/gi, '$1 centimetres')
    .replace(/(\d)\s*mm\b/gi, '$1 millimetres')
    .replace(/(\d)\s*%/g, '$1 percent');

  // medical shorthand
  t = t
    .replace(/\bSpO2\b/gi, 'oxygen saturation')
    .replace(/\bBP\b/g, 'blood pressure')
    .replace(/\bPR\b/g, 'pulse rate')
    .replace(/\bHR\b/g, 'heart rate')
    .replace(/\bRR\b/g, 'respiratory rate')
    .replace(/\b(on|under)\s+RA\b/gi, '$1 room air')
    .replace(/\bTab\b\.?\s*/gi, 'Tablet ')
    .replace(/\bInj\b\.?\s*/gi, 'Injection ')
    .replace(/\bSyp\b\.?\s*/gi, 'Syrup ')
    .replace(/\bSOS\b/g, 'as needed')
    .replace(/\bIV\b/g, 'intravenous')
    .replace(/\bDr\b\.?\s*/gi, 'Doctor ')
    .replace(/\bMrs\b\.?\s*/gi, 'Missus ')
    .replace(/\bMr\b\.?\s*/gi, 'Mister ');

  // punctuation that sounds odd when spoken
  t = t.replace(/\s*[—–]\s*/g, ', ').replace(/\s\/\s/g, ', ');

  // ALL-CAPS words of 5+ letters are read as normal words (short ones like CBC stay as letters)
  t = t.replace(/\b[A-Z]{5,}\b/g, (w) => w.toLowerCase());

  return t.replace(/\s+/g, ' ').trim();
}

// Split into short sentences: sounds more natural, and long utterances get cut off by Chrome
function chunk(text, max = 180) {
  const out = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length <= max) {
      out.push(sentence);
      continue;
    }
    let cur = '';
    for (const piece of sentence.split(/(?<=[,;])\s+/)) {
      if (cur && `${cur} ${piece}`.length > max) {
        out.push(cur.trim());
        cur = piece;
      } else {
        cur = `${cur} ${piece}`.trim();
      }
    }
    if (cur) out.push(cur.trim());
  }
  return out.filter(Boolean);
}

// ---------- what to read ----------
function tableRowPos(doc, pos) {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'tableRow') return $pos.before(d);
  }
  return null;
}

// List of { index, text }: index is the block to highlight while it is read
function buildItems(editor) {
  const doc = editor.state.doc;
  const blocks = getBlocks(doc);
  const items = [];
  let i = 0;
  while (i < blocks.length) {
    const rowPos = tableRowPos(doc, blocks[i].pos);
    if (rowPos === null) {
      items.push({ index: blocks[i].index, text: blocks[i].node.textContent });
      i++;
      continue;
    }
    const cells = [];
    while (i < blocks.length && tableRowPos(doc, blocks[i].pos) === rowPos) cells.push(blocks[i++]);

    if (PAIR_TABLE_CELLS && cells.length % 2 === 0) {
      for (let k = 0; k < cells.length; k += 2) {
        const label = cells[k].node.textContent.replace(/:\s*$/, '');
        items.push({ index: cells[k + 1].index, text: `${label}: ${cells[k + 1].node.textContent}` });
      }
    } else {
      cells.forEach((c) => items.push({ index: c.index, text: c.node.textContent }));
    }
  }
  return items;
}

// ---------- highlight while reading ----------
function setHighlight(editor, index) {
  if (!editor || editor.isDestroyed) return;
  const b = getBlocks(editor.state.doc)[index];
  const meta = b ? { from: b.pos, to: b.pos + b.node.nodeSize } : null;
  editor.view.dispatch(editor.state.tr.setMeta(flashKey, meta).setMeta('addToHistory', false));
}

export function stopReading(editor) {
  runId++;
  if (ttsSupported()) window.speechSynthesis.cancel();
  setHighlight(editor, -1);
}

export function readDocument(editor, { voiceName, rate = 0.95, onEnd } = {}) {
  const synth = window.speechSynthesis;
  const id = ++runId;
  synth.cancel();

  const voice = synth.getVoices().find((v) => v.name === voiceName);

  const items = [{ index: -1, text: INTRO }, ...buildItems(editor), { index: -1, text: OUTRO }];
  const parts = [];
  for (const item of items) {
    const spoken = toSpoken(item.text);
    if (!spoken) continue;
    const closed = /[.!?]$/.test(spoken) ? spoken : `${spoken}.`; // full stop = natural pause
    for (const text of chunk(closed)) parts.push({ text, index: item.index });
  }

  const finish = () => {
    if (id !== runId) return;
    setHighlight(editor, -1);
    onEnd?.();
  };

  if (!parts.length) {
    finish();
    return;
  }

  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p.text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = rate;
    u.pitch = PITCH;
    u.onstart = () => { if (id === runId) setHighlight(editor, p.index); };
    u.onend = () => { if (i === parts.length - 1) finish(); };
    u.onerror = (e) => { if (e.error !== 'canceled' && e.error !== 'interrupted') finish(); };
    synth.speak(u);
  });
}