import { useMemo, useState } from 'react';
import { STATUSES, TYPES } from '../lib/summaries';
import { SearchIcon, TrashIcon, ChevronRight, ChevronDown, UserIcon, UploadIcon } from '../components/Icons';

const OWNER_TABS = [
  { id: 'all', label: 'All' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'created', label: 'Created by me' },
];

const GENDER_LABEL = { male: 'Male', female: 'Female' };

// "7 Nov 2026, 11:35 am"
function when(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return `${date}, ${time}`;
}

// The list of all saved summaries, with search and filters.
export default function Summaries({ summaries, onOpen, onImport, onChange, onDelete }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(''); // '' = any
  const [type, setType] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return summaries.filter((s) => {
      if (status && s.status !== status) return false;
      if (type && s.type !== type) return false;
      if (!q) return true;
      return [s.patient?.name, s.patient?.mrn, s.caseNo].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [summaries, query, status, type]);

  return (
    <main className="page-view">
      <div className="list-head">
        <div className="seg">
          {OWNER_TABS.map((t) => (
            <button
              key={t.id}
              className={`seg-btn ${t.id === 'all' ? 'on' : ''}`}
              disabled={t.id !== 'all'}
              title={t.id === 'all' ? undefined : 'Available when user logins are added'}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="pill-btn" onClick={onImport} title="Add a summary from a Word file">
          <UploadIcon size={18} /> Import .docx
        </button>
      </div>

      <label className="search">
        <SearchIcon />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by patient name, MRN, case number..." />
      </label>

      <div className="filters">
        {STATUSES.map((s) => (
          <button key={s.id} className={`filter ${status === s.id ? 'on' : ''}`} onClick={() => setStatus(status === s.id ? '' : s.id)}>
            <i className={`dot ${s.id}`} /> {s.label}
          </button>
        ))}
        <span className="filter-sep" />
        {TYPES.map((t) => (
          <button key={t.id} className={`filter ${type === t.id ? 'on' : ''}`} onClick={() => setType(type === t.id ? '' : t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {summaries.length === 0 && (
        <div className="empty">
          <b>No summaries yet</b>
          <p>Click <b>Import .docx</b> to add your first discharge summary.</p>
        </div>
      )}
      {summaries.length > 0 && shown.length === 0 && <div className="empty"><p>No summaries match your search or filters.</p></div>}

      <div className="cards">
        {shown.map((s) => {
          const p = s.patient || {};
          return (
            <article key={s.id} className="sum-card" onClick={() => onOpen(s.id)}>
              <i className={`dot big ${s.status}`} />
              <div className="sum-main">
                <h3>{p.name || 'Unnamed patient'}</h3>
                <div className="sum-sub">
                  {s.caseNo}
                  {p.mrn && <> · MRN {p.mrn}</>}
                </div>
                <div className="sum-tags" onClick={(e) => e.stopPropagation()}>
                  <select
                    className="tag tag-select"
                    value={s.type}
                    onChange={(e) => onChange(s.id, { type: e.target.value })}
                    aria-label="Summary type"
                  >
                    {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                  {p.age && <span className="tag">{p.age} Y</span>}
                  {p.gender && <span className="tag">{GENDER_LABEL[p.gender] || p.gender}</span>}
                  <button className="assign" disabled title="Available when the doctor list is added">
                    <UserIcon size={18} /> Assign doctor <ChevronDown size={18} />
                  </button>
                </div>
              </div>

              <div className="sum-side" onClick={(e) => e.stopPropagation()}>
                <div className="sum-actions">
                  <select
                    className={`status-pill ${s.status}`}
                    value={s.status}
                    onChange={(e) => onChange(s.id, { status: e.target.value })}
                    aria-label="Status"
                  >
                    {STATUSES.map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}
                  </select>
                  <button
                    className="icon-btn soft"
                    title="Delete"
                    aria-label="Delete summary"
                    onClick={() => {
                      if (window.confirm(`Delete the summary of ${p.name || s.caseNo}? This cannot be undone.`)) onDelete(s.id);
                    }}
                  >
                    <TrashIcon size={20} />
                  </button>
                  <button className="icon-btn soft" onClick={() => onOpen(s.id)} aria-label="Open">
                    <ChevronRight size={20} />
                  </button>
                </div>
                <div className="sum-date">{when(s.updatedAt)}</div>
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
