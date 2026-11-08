import { useState } from 'react';
import { DEPARTMENTS, findDepartment, templateStartHtml } from '../data/templates';
import { ChevronRight, FileIcon, TrashIcon } from '../components/Icons';
import TemplatePreview from '../components/TemplatePreview';

const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

function when(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()}`;
}

const STATUS_LABEL = { sample: 'Sample layout', demo: 'Demo' };

// #/templates          -> all department cards
// #/templates/<dept>   -> the templates of that department + the documents made from them
export default function Templates({ deptId, docs, onOpen, onContinue, onDelete }) {
  const dept = deptId ? findDepartment(deptId) : null;
  const [preview, setPreview] = useState(null); // template shown in the View window

  if (deptId && !dept) {
    return (
      <main className="page-view">
        <div className="empty">
          <b>Department not found</b>
          <p><a href="#/templates">Back to all departments</a></p>
        </div>
      </main>
    );
  }

  if (!dept) {
    return (
      <main className="page-view">
        <h1 className="page-h1">Templates</h1>
        <p className="page-lead">Choose a department to see its templates.</p>
        <div className="dept-grid">
          {DEPARTMENTS.map((d) => (
            <a key={d.id} className="dept-card" href={`#/templates/${d.id}`}>
              <div className="dept-icon">{d.name[0]}</div>
              <div className="dept-text">
                <b>{d.name}</b>
                <span>{d.description}</span>
              </div>
              <span className="dept-count">{d.templates.length} template{d.templates.length > 1 ? 's' : ''}</span>
            </a>
          ))}
        </div>
      </main>
    );
  }

  const myDocs = docs.filter((d) => d.deptId === dept.id);
  const nameOf = (tplId) => dept.templates.find((x) => x.id === tplId)?.name || 'Removed template';

  return (
    <main className="page-view">
      <div className="crumbs">
        <a href="#/templates">Templates</a> <ChevronRight size={16} /> <span>{dept.name}</span>
      </div>
      <h1 className="page-h1">{dept.name}</h1>
      <p className="page-lead">Select a template. <b>Open</b> always starts a new document from a fresh copy.</p>

      <div className="tpl-grid">
        {dept.templates.map((tpl) => (
          <article key={tpl.id} className="tpl-card">
            <button className="tpl-eye" onClick={() => setPreview(tpl)} title="View template" aria-label={`View ${tpl.name}`}>
              <EyeIcon />
            </button>
            <div className="tpl-icon"><FileIcon /></div>
            <b>{tpl.name}</b>
            <span className={`tpl-kind ${tpl.status}`}>{STATUS_LABEL[tpl.status] || tpl.status} · v{tpl.version}</span>
            <p>{tpl.description}</p>
            <div className="tpl-actions">
              <button className="pill-btn" onClick={() => setPreview(tpl)}>View Template</button>
              <button className="seg-btn on" onClick={() => onOpen(dept.id, tpl.id)}>Open</button>
            </div>
          </article>
        ))}
      </div>

      <h2 className="sub-h2">Your documents</h2>
      {myDocs.length === 0 ? (
        <div className="empty"><p>No documents yet. Click <b>Open</b> on a template to start one.</p></div>
      ) : (
        <div className="doc-rows">
          {myDocs.map((d) => (
            <div key={d.id} className="doc-row" onClick={() => onContinue(d)}>
              <FileIcon size={20} />
              <div className="doc-main">
                <b>{d.patientName || 'Patient not filled in yet'}</b>
                <span>{nameOf(d.templateId)} · last change {when(d.updatedAt)}</span>
              </div>
              <div className="sum-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn soft"
                  title="Delete"
                  aria-label="Delete document"
                  onClick={() => {
                    if (window.confirm('Delete this document? This cannot be undone.')) onDelete(d.id);
                  }}
                >
                  <TrashIcon size={20} />
                </button>
                <button className="seg-btn on" onClick={() => onContinue(d)}>Continue</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <TemplatePreview tpl={preview} dept={dept} html={templateStartHtml(preview, dept)} onClose={() => setPreview(null)} />
      )}
    </main>
  );
}
