import { Type } from '@google/genai';

export function todayString() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`; // DD-MM-YYYY
}

export const editTextDecl = {
  name: 'edit_text',
  description: 'Edit the text of exactly one block of the document. Call once per block to change.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      block_id: { type: Type.STRING, description: 'Block id from the outline, e.g. "B12"' },
      operation: {
        type: Type.STRING,
        enum: ['set', 'replace_text', 'append', 'clear'],
        description:
          'set = replace the whole block text; replace_text = swap only part of it; append = add to the end; clear = empty it',
      },
      new_value: { type: Type.STRING, description: 'New text, or the replacement text' },
      find_text: { type: Type.STRING, description: 'Only for replace_text: the exact existing text to replace' },
      field_label: {
        type: Type.STRING,
        description: 'Short human name of what is changed, e.g. "Date of Discharge" or "Final Diagnosis"',
      },
    },
    required: ['block_id', 'operation', 'field_label'],
  },
};

export function buildPrompt(outline, today) {
  return `You are a voice editing assistant for a Word-style document (a hospital discharge summary).
Today's date is ${today} (DD-MM-YYYY). If the document already uses another date format, copy that format.

The document is given as blocks. Each block has an id like [B7]. Table rows are shown on one line as
"label | value | label | value" (each cell contains its own block id).

DOCUMENT:
${outline}

Rules:
- The user speaks an edit command. Call edit_text once for each block that must change.
- Change ONLY what was asked, plus the consistency fixes described below. Never touch unrelated blocks, headings or labels.
- In tables, edit the VALUE cell next to the label (e.g. "Date of Discharge" label -> change the cell after it).
- For a small change inside a sentence, use replace_text with the exact find_text. If unsure, use set with the full new text for that block.
- If the request is ambiguous (e.g. "change the date" with two dates), do not edit. Ask one short question.
- If the thing to change does not exist, say so briefly.
- KEEP THE DOCUMENT CONSISTENT. Facts about the patient (age, gender, name, admission date, discharge date) appear in several places: the header table AND the narrative sections (e.g. "48-year-old male patient" in Present History or Course in the Hospital).
  When the user changes one of these facts, read the whole outline, find EVERY other place that states the same fact, and call edit_text for each one in the same turn (use replace_text with the exact old wording, e.g. find_text "48-year-old male" -> new_value "15-year-old female").
  If the gender changes, also fix words that refer to the patient (male/female, he/she, his/her, man/woman).
  Do not touch clinical values (BP, pulse, SpO2, lab results, doses) or anything about other people, even if a number looks similar.
  If the user says to change it in one place only (e.g. "only in the table"), change just that place.
- After editing, confirm in one short sentence and mention how many places were updated.`;
}