import { useState } from 'react';
import { HomeIcon, BoltIcon, FileIcon, PlusIcon, GridIcon, GearIcon, CollapseIcon } from './Icons';

// Left navigation. Only the main pages are listed here; departments live inside Templates.
const MAIN = [
  { id: 'dashboard', label: 'Dashboard', Icon: HomeIcon },
  { id: 'activity', label: 'Activity', Icon: BoltIcon },
  { id: 'summaries', label: 'Summaries', Icon: FileIcon },
  { id: 'templates', label: 'Templates', Icon: GridIcon },
];
const ACCOUNT = [{ id: 'settings', label: 'Settings', Icon: GearIcon }];

const KEY = 'sidebar-collapsed';
const readCollapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

function Item({ id, label, Icon, active, collapsed }) {
  return (
    <a href={`#/${id}`} className={`nav-item ${active === id ? 'on' : ''}`} title={collapsed ? label : undefined}>
      <Icon />
      <span className="nav-label">{label}</span>
    </a>
  );
}

export default function Sidebar({ active }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function toggle() {
    setCollapsed((c) => {
      try { localStorage.setItem(KEY, c ? '0' : '1'); } catch { /* ignore */ }
      return !c;
    });
  }

  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Main navigation">
      <div className="sidebar-top">
        <button className="icon-btn" onClick={toggle} title={collapsed ? 'Expand menu' : 'Collapse menu'} aria-label="Toggle menu">
          <CollapseIcon />
        </button>
      </div>

      <div className="nav-group">
        {MAIN.slice(0, 3).map((it) => <Item key={it.id} {...it} active={active} collapsed={collapsed} />)}
        <a href="#/create-summary" className={`nav-create ${active === 'create-summary' ? 'on' : ''}`} title={collapsed ? 'Create Summary' : undefined}>
          <PlusIcon />
          <span className="nav-label">Create Summary</span>
        </a>
        {MAIN.slice(3).map((it) => <Item key={it.id} {...it} active={active} collapsed={collapsed} />)}
      </div>

      <div className="nav-group account">
        {!collapsed && <div className="nav-title">ACCOUNT</div>}
        {ACCOUNT.map((it) => <Item key={it.id} {...it} active={active} collapsed={collapsed} />)}
      </div>
    </nav>
  );
}
