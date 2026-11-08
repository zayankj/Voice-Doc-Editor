// Department templates.
// None of these are hospital-approved yet. The approved layouts will replace them later (and move to the backend).
//
// Each template: id, name, department, description, version, status, aiHints, fields, layout, medical
//   status   'demo'   = placeholder only (title + notice, no layout)
//            'sample' = full sample layout with {{placeholders}}, awaiting hospital approval
//   aiHints  extra notes for the AI. The SERVER keeps its own copy in server/templates.json (that is the one used).
//   fields   the {{placeholders}} in the layout
//   layout   the starting HTML (only for 'sample' templates)
//   medical  true = must be reviewed and signed by the responsible doctor
import { RECEPTION_REGISTRATION } from './layouts/reception';

const t = (department, id, name, description) => ({
  id, name, department, description, version: '0.1', status: 'demo', aiHints: [], fields: [], layout: '', medical: false,
});

// Every {{placeholder}} name in a layout, in order, without repeats
const fieldsOf = (html) => [...new Set([...html.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]))];

const PLACEHOLDER_HINTS = [
  'Values are written as {{placeholder}} markers. When the user, the file or the voice command gives a value, replace the marker with that value (replace_text, find_text = the exact marker).',
  'If a value is not given, leave its {{placeholder}} marker unchanged. Never invent patient details.',
];

export const DEPARTMENTS = [
  {
    id: 'reception', name: 'Reception', description: 'Registration and patient details',
    templates: [
      {
        ...t('reception', 'patient-registration', 'Patient Registration', 'Registration form for a patient visiting the hospital'),
        version: '1.0',
        status: 'sample',
        layout: RECEPTION_REGISTRATION,
        fields: fieldsOf(RECEPTION_REGISTRATION),
        aiHints: PLACEHOLDER_HINTS,
      },
    ],
  },
  {
    id: 'opd', name: 'OPD', description: 'Outpatient consultations',
    templates: [
      t('opd', 'opd-consultation-note', 'OPD Consultation Note', 'Notes from an outpatient consultation'),
      t('opd', 'follow-up-consultation', 'Follow-up Consultation', 'Notes from a follow-up visit'),
    ],
  },
  {
    id: 'ipd', name: 'IPD / Ward', description: 'Inpatient admission and ward notes',
    templates: [
      t('ipd', 'patient-admission-assessment', 'Patient Admission Assessment', 'Assessment when a patient is admitted'),
      t('ipd', 'patient-progress-notes', 'Patient Progress Notes', 'Daily notes during the hospital stay'),
    ],
  },
  {
    id: 'nursing', name: 'Nursing', description: 'Nursing assessments and notes',
    templates: [
      t('nursing', 'nursing-assessment', 'Nursing Assessment', 'Assessment recorded by the nursing team'),
      t('nursing', 'nursing-progress-notes', 'Nursing Progress Notes', 'Ongoing notes by the nursing team'),
    ],
  },
  {
    id: 'emergency', name: 'Emergency', description: 'Emergency department records',
    templates: [
      t('emergency', 'emergency-initial-assessment', 'Emergency Initial Assessment', 'First assessment in the emergency department'),
      t('emergency', 'triage-assessment', 'Triage Assessment', 'Triage record on arrival'),
    ],
  },
  {
    id: 'operation-theatre', name: 'Operation Theatre', description: 'Before and during surgery',
    templates: [
      t('operation-theatre', 'preoperative-assessment', 'Preoperative Assessment', 'Assessment before an operation'),
      t('operation-theatre', 'operative-notes', 'Operative Notes', 'Notes about an operation'),
    ],
  },
  {
    id: 'general-medicine', name: 'General Medicine', description: 'Medical assessments and notes',
    templates: [
      t('general-medicine', 'medical-assessment', 'Medical Assessment', 'Medical assessment of a patient'),
      t('general-medicine', 'clinical-progress-notes', 'Clinical Progress Notes', 'Ongoing clinical notes'),
    ],
  },
  {
    id: 'orthopedics', name: 'Orthopedics', description: 'Bone and joint care',
    templates: [t('orthopedics', 'orthopedic-consultation', 'Orthopedic Consultation', 'Notes from an orthopedic consultation')],
  },
  {
    id: 'cardiology', name: 'Cardiology', description: 'Heart care',
    templates: [t('cardiology', 'cardiology-consultation', 'Cardiology Consultation', 'Notes from a cardiology consultation')],
  },
  {
    id: 'pediatrics', name: 'Pediatrics', description: 'Child care',
    templates: [t('pediatrics', 'pediatric-assessment', 'Pediatric Assessment', 'Assessment of a child patient')],
  },
];

export const findDepartment = (id) => DEPARTMENTS.find((d) => d.id === id) || null;
export function findTemplateById(tplId) {
  for (const d of DEPARTMENTS) {
    const tpl = d.templates.find((x) => x.id === tplId);
    if (tpl) return { tpl, dept: d };
  }
  return null;
}
export const findTemplate = (deptId, tplId) => findDepartment(deptId)?.templates.find((x) => x.id === tplId) || null;

// The starting page of a demo template: only a title and a clear DEMO notice, nothing clinical
export function demoTemplateHtml(tpl, dept) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<h1>${esc(tpl.name)}</h1>
<p><em>DEMO TEMPLATE – not hospital-approved. The approved layout will be added later.</em></p>
<p>Department: ${esc(dept.name)}</p>
<p></p>`;
}

// The fresh starting content of a template (every new document starts from this)
export function templateStartHtml(tpl, dept) {
  return tpl.layout || demoTemplateHtml(tpl, dept);
}
