import { useEffect, useState, type ReactNode } from 'react';
import {
  hasPermission,
  ROLE_LABELS,
  type AuthenticatedUser,
  type Permission,
} from '@tsba/shared';
import { clearToken, getMe, getStoredUser, getToken } from './api';
import { LoginForm } from './components/LoginForm';
import { DashboardTab } from './components/DashboardTab';
import { ConnectionsManager } from './components/ConnectionsManager';
import { KnowledgeTab } from './components/KnowledgeTab';
import { UsersPanel } from './components/UsersPanel';
import { AskTab } from './components/AskTab';
import { NotificationBell } from './components/NotificationBell';
import { VoiceAgent } from './components/VoiceAgent';
import { ProgressTab } from './components/ProgressTab';
import { SettingsTab } from './components/SettingsTab';

type Section = 'dashboard' | 'connections' | 'knowledge' | 'ask' | 'voice' | 'users' | 'progress' | 'settings';

interface NavItem {
  key: Section;
  label: string;
  icon: string;
  perm: Permission;
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '▦', perm: 'view' },
  { key: 'connections', label: 'Connections', icon: '🔌', perm: 'view' },
  { key: 'knowledge', label: 'Knowledge base', icon: '📚', perm: 'view' },
  { key: 'ask', label: 'Ask the agent', icon: '💬', perm: 'ask' },
  { key: 'voice', label: 'Voice agent', icon: '🎙️', perm: 'ask' },
  { key: 'users', label: 'Users & roles', icon: '👥', perm: 'manage_users' },
  { key: 'settings', label: 'Settings', icon: '⚙️', perm: 'view' },
  { key: 'progress', label: 'Progress', icon: '📈', perm: 'view' },
];

const TITLES: Record<Section, string> = {
  dashboard: 'Dashboard',
  connections: 'Connections & knowledge sources',
  knowledge: 'Knowledge base',
  ask: 'Ask the agent',
  voice: 'Voice agent',
  users: 'Users & roles',
  settings: 'Settings',
  progress: 'Build progress',
};

const SUBTITLES: Record<Section, string> = {
  dashboard: 'A live overview of the agent, its knowledge and recent activity.',
  connections: 'Connect Google Drive & Gmail, then select folders and scan email into the knowledge base.',
  knowledge: 'Every document and folder source powering the agent’s answers.',
  ask: 'Generate a grounded draft reply for review and approval.',
  voice: 'Speak to the agent and hear grounded answers read back aloud.',
  users: 'Create accounts and assign roles. Permissions follow the role.',
  settings: 'System configuration, integrations and your account.',
  progress: 'What’s done, in progress and next.',
};

const COLLAPSE_KEY = 'tsba.sidebar.collapsed';
const SECTION_KEY = 'tsba.section';

// Crisp line icons (inherit the nav link colour via currentColor).
const svgIcon = (paths: ReactNode): ReactNode => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);

const ICONS: Record<Section, ReactNode> = {
  dashboard: svgIcon(
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>,
  ),
  connections: svgIcon(
    <>
      <path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" />
    </>,
  ),
  knowledge: svgIcon(
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>,
  ),
  ask: svgIcon(<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />),
  voice: svgIcon(
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
    </>,
  ),
  users: svgIcon(
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  ),
  settings: svgIcon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
  ),
  progress: svgIcon(
    <>
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" /><polyline points="16 7 22 7 22 13" />
    </>,
  ),
};

const SECTIONS: Section[] = [
  'dashboard', 'connections', 'knowledge', 'ask', 'voice', 'users', 'progress', 'settings',
];
const isSection = (v: unknown): v is Section => SECTIONS.includes(v as Section);

function initialSection(): Section {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('status')) return 'connections'; // returning from OAuth
    const t = params.get('tab');
    if (t === 'admin') return 'dashboard';
    if (isSection(t)) return t;
    // No explicit tab in the URL — restore the last section the user was on.
    const saved = localStorage.getItem(SECTION_KEY);
    if (isSection(saved)) return saved;
  } catch {
    /* ignore */
  }
  return 'dashboard';
}

export function App() {
  const [user, setUser] = useState<AuthenticatedUser | null>(() => (getToken() ? getStoredUser() : null));
  const [restoring, setRestoring] = useState<boolean>(() => Boolean(getToken()));
  const [section, setSection] = useState<Section>(initialSection);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });

  useEffect(() => {
    if (!getToken()) return;
    getMe()
      .then(setUser)
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setRestoring(false));
  }, []);

  // Remember the active section so a reload returns here, not to the dashboard.
  useEffect(() => {
    try {
      localStorage.setItem(SECTION_KEY, section);
    } catch {
      /* ignore */
    }
  }, [section]);

  // Close the profile menu on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  if (!user) {
    if (restoring) return null;
    return <LoginForm onAuthed={setUser} />;
  }

  const onAuthError = () => {
    clearToken();
    setUser(null);
  };
  const signOut = () => {
    clearToken();
    setUser(null);
  };

  const items = NAV.filter((n) => hasPermission(user.role, n.perm));
  // Guard: if the current section isn't permitted, show the first available one.
  const active: Section = items.some((i) => i.key === section) ? section : items[0]?.key ?? 'dashboard';

  const initials = (user.name || user.email || '?').trim().slice(0, 2).toUpperCase() || '?';

  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="side-brand">
          <div className="logo">TSBA</div>
          <div className="side-brand-text">
            <strong>TSBA Admin</strong>
            <span className="side-sub">Support AI console</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Admin sections">
          {items.map((n) => (
            <button
              key={n.key}
              className={`side-link ${active === n.key ? 'active' : ''}`}
              aria-current={active === n.key ? 'page' : undefined}
              onClick={() => setSection(n.key)}
              title={collapsed ? n.label : undefined}
            >
              <span className="side-ico" aria-hidden="true">{ICONS[n.key]}</span>
              <span className="side-label">{n.label}</span>
            </button>
          ))}
        </nav>

      </aside>

      <div className="content">
        <header className="content-head">
          <div className="head-main">
            <button
              type="button"
              className="head-collapse"
              onClick={toggleCollapsed}
              aria-pressed={collapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
            </button>
            <h1 className="head-title">{TITLES[active]}</h1>
          </div>

          <div className="head-right">
            {hasPermission(user.role, 'view') && (
              <NotificationBell onNavigate={() => setSection('ask')} onAuthError={onAuthError} />
            )}
            <div className="profile-menu">
              <button
                type="button"
                className={`profile-trigger ${menuOpen ? 'open' : ''}`}
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <span className="profile-avatar" aria-hidden="true">{initials}</span>
                <span className="profile-id">
                  <span className="profile-name">{user.name || user.email}</span>
                  <span className="profile-role">{ROLE_LABELS[user.role]}</span>
                </span>
                <span className="profile-caret" aria-hidden="true">▾</span>
              </button>

              {menuOpen && (
                <>
                  <button
                    type="button"
                    className="menu-backdrop"
                    aria-label="Close menu"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="profile-dropdown" role="menu">
                    <div className="profile-dropdown-head">
                      <span className="profile-name">{user.name || 'Account'}</span>
                      <span className="profile-email">{user.email}</span>
                    </div>
                    <button
                      type="button"
                      className="menu-item"
                      role="menuitem"
                      onClick={() => {
                        setSection('settings');
                        setMenuOpen(false);
                      }}
                    >
                      <span className="menu-item-ico" aria-hidden="true">⚙️</span> Settings
                    </button>
                    <button type="button" className="menu-item" role="menuitem" onClick={signOut}>
                      <span className="menu-item-ico" aria-hidden="true">⏻</span> Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <div className="content-body">
          <p className="page-lead">{SUBTITLES[active]}</p>
          {active === 'dashboard' && <DashboardTab onAuthError={onAuthError} />}
          {active === 'connections' && (
            <div className="col">
              <ConnectionsManager user={user} onAuthError={onAuthError} />
            </div>
          )}
          {active === 'knowledge' && <KnowledgeTab user={user} onAuthError={onAuthError} />}
          {active === 'ask' && hasPermission(user.role, 'ask') && <AskTab onAuthError={onAuthError} />}
          {active === 'voice' && hasPermission(user.role, 'ask') && <VoiceAgent onAuthError={onAuthError} />}
          {active === 'users' && hasPermission(user.role, 'manage_users') && (
            <div className="col">
              <UsersPanel me={user} onAuthError={onAuthError} />
            </div>
          )}
          {active === 'settings' && <SettingsTab user={user} onAuthError={onAuthError} />}
          {active === 'progress' && <ProgressTab onAuthError={onAuthError} />}
        </div>
      </div>
    </div>
  );
}
