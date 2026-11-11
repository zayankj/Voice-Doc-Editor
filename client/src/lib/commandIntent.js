import {
  CATEGORIES, categoryOfTerm, formsFromCommand, phrasesFromCommand, pickSection, planRemoval, planEntryRemoval, brandOf, findGenericBracket,
  medicineEntryAt, DOSING_PATTERN, MEDICINE_TITLE,
} from './medicineText.js';
import { findClearSectionCommand, clearPreview, BARE_ALL, findInlineSection, isClearIntent } from './sectionCommands.js';
import { getSections, findSectionsInCommand } from './sections.js';
import { getBlocks } from './outline.js';

// ONE place that understands a command, used for BOTH typed instructions and the voice transcript.
//
// classifyCommand(doc, command) returns:
//   { type: 'remove', kind, intent, plan }  remove generic names / instruction categories / exact phrases
//                                            (plan from medicineText.js; shown in the confirm window first)
//   { type: 'clear', section }              clear a whole section (only when that is clearly meant)
//   { type: 'ask', question }               not clear enough: ask the user, change nothing
//   { type: 'ai' }                          not a command for code: the AI handles it as before
//
// intent (for remove) = { action: 'remove', section, categories: [...], phrases: [...], forms: [...], scope }
//
// Rules:
//   - examples + "and so on / etc. / such as / like / similar / things like" -> the WHOLE category of each example
//     ("Oral, Twice Daily and so on" -> route + frequency)
//   - examples without those words -> only the words said ("remove twice daily and once daily")
//   - filler and scope words ("and so on", "in all the section", "from all medicines") are never removed
//   - if anything specific is named, it is NEVER a clear-section; mixed with "everything / whole" -> ask

const nice = (t) => String(t).replace(/\s*:\s*$/, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const VERB = /\b(?:remove|delete|drop|strip|take\s+out|erase|get\s+rid\s+of|omit|exclude|clear|wipe)\b/i;
const GENERIC = /\b(?:generics?|generic\s+names?|salt\s+names?|composition)\b/i;
// category words
const CATEGORY_WORDS = {
  route: /\b(?:routes?|administration|mode of administration|routes? of administration)\b/i,
  frequency: /\b(?:frequenc(?:y|ies)|how often|dosing schedule|dose timings?)\b/i,
  as_needed: /\b(?:as[\s-]needed|sos|prn|when required)\s+(?:instructions?|words?|phrases?|ones)\b|\bas[\s-]needed instructions?\b/i,
  food: /\b(?:food|meal)\s+(?:timings?|instructions?|directions?)\b|\b(?:before|after|with)\s+food\s+instructions?\b/i,
};
const DESCRIPTION_WORDS = /\b(?:antacid|probiotic|prebiotic|protein supplement|supplement|multivitamin|mineral)s?\b/i;
// "and so on" style words: the examples stand for their whole category
// (a plain "like" as in "I'd like to remove ..." does NOT count)
const EXPANDER = /\b(?:and so on|so on|etc\.?|etcetera|et cetera|such as|(?:things|words|phrases|terms|ones|instructions|descriptions)\s+like|like these|like this|like that|similar(?:\s+\w+)?|and the like|and others?|and other|kinds? of|types? of|all those(?: things| words| ones)?|all these(?: things| words| ones)?|and all that|and stuff|and more)\b/i;
// words saying WHERE, never something to remove
const SCOPE = /\b(?:in|from|for|across|throughout|of|on)\s+(?:all|every|each)(?:\s+(?:the|of the|of))?\s+(?:sections?|medicines?|medications?|entries|entry|lines?|tablets?|places?|drugs?|items?|the section)\b|\b(?:everywhere|throughout|in all places|in all)\b/gi;
const FILLER_ITEM = /^(?:so on|etc\.?|etcetera|et cetera|others?|the like|more|all|everything|stuff|similar(?: \w+)?|things|ones|those|these|that|it|them)$/i;
// "clear everything" words: if these are mixed with something specific, ask
const WHOLE = /\b(?:everything|entire|whole|completely|blank|empty|all (?:the )?(?:content|contents|text))\b/i;
const saysWhole = (c) => WHOLE.test(c) || BARE_ALL.test(c); // "remove all from Advice" also means the whole section
// "Empty the Advice section": "empty" at the START of a command is a clear (not "add an empty line ...")
const EMPTY_START = /^\s*(?:please\s+)?(?:now\s+)?empty\b/i;
// "instructions / directions" without saying which kind
const VAGUE = /\b(?:instructions?|directions?|descriptions?|details)\b/i;

// ---------- medicine scope / safety words ----------
// "this medicine / that one / the selected tablet": the medicine where the cursor is
const THIS_ONE = /\b(?:this|that|current|selected)\s+(?:medicine|medication|drug|one|line|entry|tablet|syrup|capsule|injection)\b/i;
// "only once daily": the words said, never the whole category
const ONLY = /\bonly\b/i;
// changing or removing doses / strengths / durations: never for several medicines at once
const DETAIL = /\b(?:doses?|dosages?|strengths?|durations?|days?|weeks?|months?|mg|mcg|ml|grams?|units?)\b|\d\s*(?:mg|mcg|ml|g|iu|units?|days?|weeks?)\b/i;
// "dose timings" / "dosing schedule" / "dosing pattern" are frequency, not a dose
const NOT_DETAIL = /\b(?:dose\s+timings?|(?:dosing|dose|dosage)\s+(?:schedule|pattern)s?)\b/gi;
// the command EXPLICITLY asks to remove numeric dosing patterns: "remove the dosing patterns", "remove 1-0-1"
// (only then are they ticked; with a frequency removal they are shown unticked)
export const asksForPatterns = (c) =>
  /\b(?:(?:dosing|dose|dosage)\s+)?patterns?\b/i.test(String(c || '')) || new RegExp(DOSING_PATTERN.source).test(String(c || ''));
const ANY_EDIT = /\b(?:remove|delete|drop|strip|take\s+out|erase|omit|clear|wipe|change|replace|update|set|make|increase|decrease|reduce|modify|edit|alter|correct)\b/i;
const GROUP = /\b(?:all|every|each)\b|\b(?:medicines|medications|drugs|tablets|tabs|capsules|caps|syrups|injections|drops|ointments|creams|sachets|inhalers)\b/i;
const MEDICINE_WORDS = /\b(?:medicines?|medications?|drugs?|tablets?|tabs?|capsules?|caps?|syrups?|injections?|drops?|ointments?|creams?|sachets?|inhalers?|doses?|dosages?|strengths?|prescriptions?|advice)\b/i;
// "timing" without saying which kind (frequency or food timing)
const TIMING = /\btimings?\b/i;
// "clear all the medicines", "remove all the medicine", "remove all medicines from Advice": every MEDICINE entry
// (not the other advice text). Not "all tablets / all syrups" (one type: whole-medicine removal by form, as before).
// STRICT: the whole command is only "<remove word> all (the) medicines [from (the) <section> (section)]"
// (plus politeness words), so "remove timing from all medicines" or "remove frequency for all medicines" never match.
const ALL_MEDICINES =
  /^(?!.*\b(?:except|but|apart\s+from|other\s+than|keep|leave|not|only|and)\b)\s*(?:(?:please|pls|plz|now|ok|okay|kindly|just)\s+)*(?:remove|delete|drop|take\s+out|erase|clear|wipe|empty|get\s+rid\s+of)\s+(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:medicines?|medications?|drugs?)(?:\s+(?:from|in|inside|under)\s+(?:the\s+)?[a-z ]{1,40}?)?(?:\s+section)?(?:\s+(?:please|pls|plz|sir|ok|okay))?\s*[.!]?\s*$/i;
// These Advice phrases also mean "remove the MEDICINES" (not the whole section):
//   "Empty the advice" (without "section"), "Remove everything from (the) advice (section)".
// ("Clear Advice", "Empty Advice", "Empty the Advice section", "Clear the Advice section" clear the whole section.)
const ADVICE_MEDICINES = [
  /^\s*(?:(?:please|pls|plz|now|ok|okay|kindly|just)\s+)*empty\s+the\s+advice\s*[.!]?\s*$/i,
  /^\s*(?:(?:please|pls|plz|now|ok|okay|kindly|just)\s+)*remove\s+everything\s+(?:from|in)\s+(?:the\s+)?advice(?:\s+section)?\s*[.!]?\s*$/i,
];
const NO_ADVICE = 'I could not find the Advice section clearly. Nothing was changed.';

// The medicine section a command means: a section it names, else an Advice heading inside a paragraph,
// else the one medicine section of the document. { section } | { ask }
function medicineSectionFor(doc, c) {
  const named = findSectionsInCommand(getSections(doc), c);
  if (named.best) return { section: named.best };
  const inline = findInlineSection(doc, c, { medicine: true });
  if (inline?.section) return { section: inline.section };
  if (inline?.ambiguous) return { ask: `Which section did you mean: ${inline.candidates.map((s) => nice(s.title)).join(' or ')}? Nothing was changed.` };
  if (/\badvice\b/i.test(c)) return { ask: NO_ADVICE }; // Advice named but not found: never guess another section
  const pick = pickSection(doc, c, { medicineOnly: true });
  return pick.section ? { section: pick.section } : { ask: pick.ask || NO_ADVICE };
}

// Every term from the category lists that appears in the command: [{ text, category }]
function termsInCommand(c) {
  const out = [];
  const taken = [];
  const all = Object.keys(CATEGORIES).flatMap((key) => CATEGORIES[key].terms.map((term) => ({ key, term })));
  all.sort((a, b) => b.term.length - a.term.length);
  for (const { key, term } of all) {
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${term})(?![A-Za-z0-9])`, 'gi');
    for (const m of c.matchAll(re)) {
      const s = m.index;
      const e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      taken.push([s, e]);
      out.push({ text: m[0], category: key, at: s });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Understands WHAT to remove. Returns { categories, phrases, expand, vague, medicineTerms }
//   sectionTitle: the section named in the command (its name is never a word to remove)
export function understandRemoval(command, sectionTitle = '') {
  // scope words ("in all the section") are not part of what to remove
  const c = String(command || '').replace(SCOPE, ' ').replace(/\s+/g, ' ').trim();
  const categories = new Set();
  const explicit = [];

  if (GENERIC.test(c)) categories.add('generic');
  for (const [key, re] of Object.entries(CATEGORY_WORDS)) if (re.test(c)) { categories.add(key); explicit.push(key); }

  const terms = termsInCommand(c);
  const expand = EXPANDER.test(c);
  const phrases = [];
  if (expand) {
    for (const t of terms) categories.add(t.category); // the examples stand for their whole category
  } else {
    for (const t of terms) phrases.push(t.text); // only the words said
  }

  // descriptions: when named as examples ("Antacid, Probiotic"), or "descriptions" with nothing else named
  const description =
    DESCRIPTION_WORDS.test(c) ||
    (/\bdescriptions?\b/i.test(c) && !terms.length && !explicit.length && !categories.has('generic') && /\b(?:category|type|kind|medicine|drug)\b/i.test(c));
  if (description) categories.add('description');

  // other listed words (only when the user clearly listed words: quotes, "words/phrases", or commas)
  const listed = /["“”']|\b(?:phrases?|words?|terms?)\b|,/.test(c);
  if (listed) {
    for (const item of phrasesFromCommand(c, sectionTitle)) {
      const clean = item.replace(/^(?:all|the|any)\s+/i, '').trim();
      if (!clean || FILLER_ITEM.test(clean) || EXPANDER.test(clean)) continue;
      if (categoryOfTerm(clean) || terms.some((t) => t.text.toLowerCase() === clean.toLowerCase())) continue;
      if (GENERIC.test(clean) || DESCRIPTION_WORDS.test(clean) || VAGUE.test(clean)) continue;
      if (/\b(?:from|in|inside|section|advice|instructions?|medicines?)\b/i.test(clean)) continue; // leftovers of the place
      phrases.push(clean);
    }
  }
  return {
    categories: [...categories],
    phrases: [...new Set(phrases)],
    expand,
    vague: VAGUE.test(c) && !categories.size && !phrases.length,
    medicineTerms: terms.length > 0, // words like Oral / Twice Daily: these belong to medicines
  };
}

const labelOf = (key) => (CATEGORIES[key]?.label ?? { generic: 'generic names', description: 'descriptions' }[key] ?? key);

// ---------- removing WHOLE medicines ("remove all syrups", "remove the tablet Dolo") ----------
const ALL_FORMS = ['tab', 'cap', 'syp', 'susp', 'inj', 'drops', 'oint', 'sachet', 'inhaler'];
const FORM_NAMES = { tab: 'tablets', cap: 'capsules', syp: 'syrups', susp: 'suspensions', inj: 'injections', drops: 'drops', oint: 'ointments / creams', sachet: 'sachets / powders', inhaler: 'inhalers / sprays' };
// words that can follow "tablet / syrup ..." but are not a medicine name
const NOT_A_NAME = new Set(['all', 'the', 'a', 'an', 'of', 'in', 'from', 'type', 'types', 'kind', 'kinds', 'every', 'each', 'that', 'this', 'these', 'those',
  'which', 'section', 'advice', 'and', 'or', 'also', 'please', 'entries', 'entry', 'line', 'lines', 'medicine', 'medicines', 'named', 'called', 'i', 'it', 'them',
  'tablet', 'tablets', 'tab', 'tabs', 'syrup', 'syrups', 'syp', 'capsule', 'capsules', 'cap', 'caps', 'injection', 'injections', 'inj', 'drops', 'from', 'to',
  'now', 'only', 'except', 'but', 'with', 'for', 'too', 'list', 'route', 'routes', 'frequency', 'frequencies', 'instructions', 'instruction', 'here', 'there',
  // filler / politeness words people add when speaking ("... from all tablet pls")
  'pls', 'plz', 'plss', 'please', 'sir', 'madam', 'mam', 'maam', 'ok', 'okay', 'k', 'ji', 'thanks', 'thank', 'you', 'quickly', 'fast', 'just', 'kindly']);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

// Which whole medicines does the command name? { forms, names, unknown } (unknown = names said but not in the section)
function medicinesInCommand(doc, section, command) {
  const c = ` ${norm(command)} `;
  // every medicine entry of the section (all forms; plus entries without a form word, from "unchanged")
  const all = planEntryRemoval(doc, section, { forms: ALL_FORMS });
  const texts = [...all.changes, ...all.unchanged].map((e) => e.before);
  const names = [];
  for (const text of texts) {
    const brand = norm(brandOf(text));
    const first = brand.split(' ')[0];
    const generic = norm((findGenericBracket(text, { allowWithoutForm: true })?.text || '').replace(/[()]/g, ''));
    for (const n of [brand, first.length >= 4 ? first : '', generic]) {
      if (n && n.length >= 3 && c.includes(` ${n} `) && !names.includes(n)) names.push(n);
    }
  }
  // a name said right after "tablet / syrup / capsule / injection / medicine (called)": reported if it is not there
  const unknown = [];
  const after = /\b(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|syp|syrup|syrups|inj|injection|injections|medicine|drug)\.?\s+(?:named\s+|called\s+)?([a-z][a-z0-9-]{2,})/g;
  for (const m of norm(command).matchAll(after)) {
    const word = m[1];
    if (NOT_A_NAME.has(word) || names.some((n) => n.split(' ').includes(word))) continue;
    if (!unknown.includes(word)) unknown.push(word);
  }
  return { forms: formsFromCommand(command.replace(VERB, ' ')), names, unknown };
}

// Doses, strengths or durations of SEVERAL medicines at once: never done (by code or AI), always asked.
// One named medicine ("change dolo to 500 mg") is left to the AI as before.
function bulkDetailQuestion(doc, c) {
  const plain = c.replace(NOT_DETAIL, ' ');
  if (!ANY_EDIT.test(plain) || !DETAIL.test(plain) || !GROUP.test(plain) || !MEDICINE_WORDS.test(plain)) return null;
  const med = pickSection(doc, plain, { medicineOnly: true });
  if (med.section && !/\b(?:all|every|each)\b/i.test(plain) && medicinesInCommand(doc, med.section, plain).names.length === 1) return null;
  return {
    type: 'ask',
    question: 'Doses, strengths and durations are changed one medicine at a time, for safety. Which medicine do you mean? Nothing was changed.',
  };
}

// WHICH medicines a removal is for: { names: [], entries: [] } (both empty = every medicine) or { ask }
//   "from dolo"          -> only DOLO           "from this medicine" -> only the medicine at the cursor
function medicineTarget(doc, section, c, cursor) {
  const title = nice(section.title);
  if (THIS_ONE.test(c)) {
    const e = medicineEntryAt(doc, section, cursor);
    if (!e) return { ask: `Please click on the medicine in ${title} first, or say its name. Nothing was changed.` };
    return { names: [], entries: [`${e.block}-${e.entry}`] };
  }
  const meds = medicinesInCommand(doc, section, c);
  if (meds.unknown.length && !meds.names.length) {
    const list = meds.unknown.map((u) => u[0].toUpperCase() + u.slice(1)).join(', ');
    return { ask: `I could not find a medicine called ${list} in ${title}. Nothing was changed.` };
  }
  // a name that fits two medicines: ask which one
  for (const n of meds.names) {
    const hits = planEntryRemoval(doc, section, { names: [n] }).changes;
    if (hits.length > 1) {
      return { ask: `${hits.length} medicines in ${title} match "${n.toUpperCase()}": ${hits.map((h) => h.before.trim()).join(' / ')}. Which one? Nothing was changed.` };
    }
  }
  return { names: meds.names, entries: [] };
}

export function classifyCommand(doc, command, { cursor } = {}) {
  const c = String(command || '').trim();
  if (!c) return { type: 'ai' };
  const bulk = bulkDetailQuestion(doc, c);
  if (bulk) return bulk;
  if (!VERB.test(c) && !EMPTY_START.test(c)) return { type: 'ai' };

  const namedSection = findSectionsInCommand(getSections(doc), c).best;
  const what = understandRemoval(c, namedSection?.title || '');
  const patterns = asksForPatterns(c);
  const specific = what.categories.length > 0 || what.phrases.length > 0 || patterns;

  // ---------- something specific to remove: NEVER a clear-section ----------
  if (specific) {
    if (WHOLE.test(c)) {
      const name = findSectionsInCommand(getSections(doc), c).best?.title;
      return {
        type: 'ask',
        question: `Do you want to remove only ${[...what.phrases, ...what.categories.map(labelOf)].join(', ')}${name ? ` from ${nice(name)}` : ''}, or clear the whole section? Please say it again more clearly. Nothing was changed.`,
      };
    }
    // categories and words like Oral / Twice Daily belong to medicines: without a section name, use the medicine section
    const medicineOnly = what.categories.length > 0 || what.medicineTerms || patterns;
    const pick = pickSection(doc, c, { medicineOnly });
    if (pick.ask) return { type: 'ask', question: pick.ask };
    // the verb "drop" is not the medicine form "drops"
    const forms = formsFromCommand(c.replace(VERB, ' '));
    // which medicines: a named one, the one at the cursor, or every medicine (of the forms said)
    const target = medicineTarget(doc, pick.section, c, cursor);
    if (target.ask) return { type: 'ask', question: target.ask };
    // ONE frequency named for a GROUP of medicines ("remove once daily from all tablets") = ALL frequency
    // instructions (and so the dosing patterns too). Several listed, "only", or one named medicine = only those words.
    let categories = [...what.categories];
    let phrases = [...what.phrases];
    const freq = phrases.filter((p) => categoryOfTerm(p) === 'frequency');
    const group = !target.names.length && !target.entries.length;
    if (freq.length === 1 && group && !ONLY.test(c) && !categories.includes('frequency')) {
      phrases = phrases.filter((p) => p !== freq[0]);
      categories = [...categories, 'frequency'];
    }
    const plan = planRemoval(doc, pick.section, { categories, phrases, forms, names: target.names, entries: target.entries, patterns });
    const intent = {
      action: 'remove',
      section: pick.section.title,
      categories,
      phrases,
      forms,
      names: target.names,
      entries: target.entries,
      patterns,
      scope: medicineOnly || forms.length ? 'medicine_entries' : 'section_lines',
    };
    if (!plan.changes.some((ch) => ch.removals.some((r) => r.selected))) {
      // Quoted words that are not part of any medicine line but ARE ordinary text of that section ("remove 'Drink
      // plenty of water' from the advice"): not a medicine removal. The normal AI editing handles it, with all its
      // checks (named section, at most one medicine line lost, Undo, History). Medicine words, categories, dosing
      // patterns, named medicines and "this medicine" never come here: they keep the confirmation window / question.
      if (phrases.length && !categories.length && !patterns && !target.names.length && !target.entries.length) {
        const blocks = getBlocks(doc);
        const sectionText = pick.section.body.map((i) => blocks[i]?.node.textContent || '').join('\n').toLowerCase();
        if (phrases.every((p) => sectionText.includes(String(p).toLowerCase()))) return { type: 'ai' };
      }
      const asked =[...phrases, ...categories.map(labelOf), ...(patterns ? ['dosing patterns'] : [])].join(', ');
      const where = target.names.length ? `${target.names.map((n) => n.toUpperCase()).join(', ')} in ` : target.entries.length ? 'this medicine in ' : '';
      return { type: 'ask', question: `I found no ${asked} in ${where}${nice(pick.section.title)}. Nothing was changed.`, intent };
    }
    const kind = categories.length === 1 && categories[0] === 'generic' && !phrases.length ? 'generic' : 'phrases';
    return { type: 'remove', kind, intent, plan };
  }

  // ---------- nothing specific named ----------
  // "clear all the medicines" / "remove all medicines from Advice" / "empty the advice" / "remove everything from
  // advice": every medicine entry, nothing else (non-medicine advice text and the heading stay)
  if (ALL_MEDICINES.test(c) || ADVICE_MEDICINES.some((re) => re.test(c))) {
    const sec = medicineSectionFor(doc, c);
    if (sec.ask) return { type: 'ask', question: sec.ask };
    const plan = planEntryRemoval(doc, sec.section, { all: true });
    const intent = { action: 'remove', section: sec.section.title, entries: { forms: [], names: [] }, all: true, scope: 'medicine_entries' };
    if (!plan.changes.length) return { type: 'ask', question: `There are no medicines in ${nice(sec.section.title)}. Nothing was changed.`, intent };
    return { type: 'remove', kind: 'entries', intent, plan };
  }

  // "remove timing from all medicines": frequency or food timing? ask
  if (TIMING.test(c) && MEDICINE_WORDS.test(c)) {
    return {
      type: 'ask',
      question: 'Do you mean the frequency (for example Once Daily) or the food timing (for example After Food)? Nothing was changed.',
    };
  }

  // Whole medicines: "remove all type of syrup", "remove the tablet Dolo", "remove Dolo and Ciplox"
  const medPick = pickSection(doc, c, { medicineOnly: true });
  if (medPick.section) {
    const meds = medicinesInCommand(doc, medPick.section, c);
    if (meds.forms.length || meds.names.length || meds.unknown.length) {
      const title = nice(medPick.section.title);
      if (WHOLE.test(c)) {
        return { type: 'ask', question: `Do you want to remove only those medicines from ${title}, or clear the whole section? Please say it again more clearly. Nothing was changed.` };
      }
      if (!meds.names.length && meds.unknown.length) {
        const list = meds.unknown.map((u) => u[0].toUpperCase() + u.slice(1)).join(', ');
        return { type: 'ask', question: `I could not find a medicine called ${list} in ${title}. Nothing was changed.` };
      }
      const plan = planEntryRemoval(doc, medPick.section, { forms: meds.forms, names: meds.names });
      plan.notFound = [...plan.notFound, ...meds.unknown.map((u) => u[0].toUpperCase() + u.slice(1))];
      const intent = { action: 'remove', section: medPick.section.title, entries: { forms: meds.forms, names: meds.names }, scope: 'medicine_entries' };
      if (!plan.changes.length) {
        const what = meds.names.length
          ? `a ${meds.forms.length ? FORM_NAMES[meds.forms[0]].replace(/s$/, '') : 'medicine'} called ${meds.names.join(', ')}`
          : meds.forms.map((f) => FORM_NAMES[f]).join(' or ');
        return { type: 'ask', question: `There ${meds.names.length ? 'is no' : 'are no'} ${what} in ${title}. Nothing was changed.`, intent };
      }
      return { type: 'remove', kind: 'entries', intent, plan };
    }
  }

  // "Delete the Advice section": sections themselves (with their heading) cannot be deleted
  const named = findSectionsInCommand(getSections(doc), c);
  if (named.best && /\b(?:delete|remove)\s+(?:the\s+)?(?:whole\s+)?[\w\s]{0,40}?\bsection\b\s*[.!]?$/i.test(c) && !saysWhole(c)) {
    return {
      type: 'ask',
      question: `A section and its heading cannot be deleted. Do you want to clear everything under ${nice(named.best.title)}? Say "clear ${nice(named.best.title).toLowerCase()}". Nothing was changed.`,
    };
  }

  // clear a section: only with the existing strict rules ("remove everything from ...", "clear ...", "make ... blank")
  const clear = findClearSectionCommand(doc, c);
  if (clear?.ambiguous) {
    return { type: 'ask', question: `Which section should I clear: ${clear.candidates.map((s) => nice(s.title)).join(' or ')}? Nothing was changed.` };
  }
  if (clear?.section) {
    // a section WITH MEDICINES, or a medicine section such as Advice, is only cleared after the user confirms;
    // other sections clear at once
    const preview = clearPreview(doc, clear.section);
    return { type: 'clear', section: clear.section, confirm: preview.medicines > 0 || MEDICINE_TITLE.test(clear.section.title), preview };
  }
  // a clear command for Advice, but no Advice section could be identified: ask (never an ordinary AI edit)
  if (isClearIntent(c) && /\badvice\b/i.test(c)) return { type: 'ask', question: NO_ADVICE };

  // "remove the instructions from Advice": which kind?
  if (what.vague && named.best) {
    return {
      type: 'ask',
      question: `Which instructions should I remove from ${nice(named.best.title)}: route (e.g. Oral), frequency (e.g. Twice Daily), as needed (e.g. SOS) or food timing (e.g. after food)? Nothing was changed.`,
    };
  }

  return { type: 'ai' }; // e.g. "remove the line about malaria from course in hospital"
}
