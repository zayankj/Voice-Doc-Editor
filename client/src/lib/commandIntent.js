import {
  CATEGORIES, categoryOfTerm, formsFromCommand, phrasesFromCommand, pickSection, planRemoval, planEntryRemoval, brandOf, findGenericBracket,
} from './medicineText.js';
import { findClearSectionCommand, clearPreview, BARE_ALL } from './sectionCommands.js';
import { getSections, findSectionsInCommand } from './sections.js';

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
  'tablet', 'tablets', 'tab', 'tabs', 'syrup', 'syrups', 'syp', 'capsule', 'capsules', 'cap', 'caps', 'injection', 'injections', 'inj', 'drops', 'from', 'to']);
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

export function classifyCommand(doc, command) {
  const c = String(command || '').trim();
  if (!c || (!VERB.test(c) && !EMPTY_START.test(c))) return { type: 'ai' };

  const namedSection = findSectionsInCommand(getSections(doc), c).best;
  const what = understandRemoval(c, namedSection?.title || '');
  const specific = what.categories.length > 0 || what.phrases.length > 0;

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
    const medicineOnly = what.categories.length > 0 || what.medicineTerms;
    const pick = pickSection(doc, c, { medicineOnly });
    if (pick.ask) return { type: 'ask', question: pick.ask };
    // the verb "drop" is not the medicine form "drops"
    const forms = formsFromCommand(c.replace(VERB, ' '));
    const plan = planRemoval(doc, pick.section, { categories: what.categories, phrases: what.phrases, forms });
    const intent = {
      action: 'remove',
      section: pick.section.title,
      categories: what.categories,
      phrases: what.phrases,
      forms,
      scope: medicineOnly || forms.length ? 'medicine_entries' : 'section_lines',
    };
    if (!plan.changes.some((ch) => ch.removals.some((r) => r.selected))) {
      const asked = [...what.phrases, ...what.categories.map(labelOf)].join(', ');
      return { type: 'ask', question: `I found no ${asked} in ${nice(pick.section.title)}. Nothing was changed.`, intent };
    }
    const kind = what.categories.length === 1 && what.categories[0] === 'generic' && !what.phrases.length ? 'generic' : 'phrases';
    return { type: 'remove', kind, intent, plan };
  }

  // ---------- nothing specific named ----------
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
    // a section WITH MEDICINES (Advice ...) is only cleared after the user confirms; other sections clear at once
    const preview = clearPreview(doc, clear.section);
    return { type: 'clear', section: clear.section, confirm: preview.medicines > 0, preview };
  }

  // "remove the instructions from Advice": which kind?
  if (what.vague && named.best) {
    return {
      type: 'ask',
      question: `Which instructions should I remove from ${nice(named.best.title)}: route (e.g. Oral), frequency (e.g. Twice Daily), as needed (e.g. SOS) or food timing (e.g. after food)? Nothing was changed.`,
    };
  }

  return { type: 'ai' }; // e.g. "remove the line about malaria from course in hospital"
}
