import { LogoIcon, BellIcon, ChevronDown } from './Icons';

// Change these in one place. The user is a placeholder until real logins exist.
export const APP_NAME = 'Voice Doc Editor';
const USER = { name: 'Sahya', role: 'Admin' };

// The white bar across the very top of every page
export default function AppHeader() {
  return (
    <header className="app-header">
      <a className="brand" href="#/summaries">
        <LogoIcon />
        <span>{APP_NAME}</span>
      </a>
      <div className="spacer" />
      <button className="icon-btn" title="Notifications (coming soon)" aria-label="Notifications">
        <BellIcon />
      </button>
      <div className="user" title="Logins are not set up yet">
        <div className="user-avatar">{USER.name[0]}</div>
        <div className="user-text">
          <b>{USER.name}</b>
          <span>{USER.role}</span>
        </div>
        <ChevronDown size={18} />
      </div>
    </header>
  );
}
