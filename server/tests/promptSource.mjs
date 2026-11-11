// Test helper: takes buildExtractPrompt OUT of index.js (without starting the server) so its output can be compared.
import fs from 'node:fs';
export function loadBuildExtractPrompt() {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = src.indexOf('function buildExtractPrompt(');
  const end = src.indexOf("\napp.post('/api/extract-edits'", start);
  if (start < 0 || end < 0) throw new Error('buildExtractPrompt not found');
  return new Function(`${src.slice(start, end)}\nreturn buildExtractPrompt;`)();
}
// dummy inputs: every upload combination, plus typed and spoken commands
export const CASES = {
  file: ['OUTLINE', '10-11-2026', '', true, false, null],
  fileTyped: ['OUTLINE', '10-11-2026', 'only update the medicines', true, false, null],
  fileTemplate: ['OUTLINE', '10-11-2026', '', true, false, { name: 'Nursing', department: 'Nursing', aiHints: ['hint one'] }],
  typed: ['OUTLINE', '10-11-2026', 'change age to 45', false, false, null],
  audio: ['OUTLINE', '10-11-2026', '', false, true, null],
};
