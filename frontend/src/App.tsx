import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  hasPermission,
  ROLE_LABELS,
  type AuthenticatedUser,
  type Permission,
} from '@tsba/shared';
import { clearToken, getMe, getStoredUser, getToken } from './api';
import { LoginForm } from './components/LoginForm';
import { ConsoleProvider, useConsole, type Navigate, type Section } from './lib/console';
import { CommandPalette } from './ui/CommandPalette';
import { Icon, Menu, type IconName } from './ui';
import { DashboardPage } from './pages/DashboardPage';
import { SolarTab } from './components/SolarTab';
import { MapPage } from './pages/MapPage';
import { DraftsPage } from './pages/DraftsPage';
import { ConnectionsManager } from './components/ConnectionsManager';
import { KnowledgeTab } from './components/KnowledgeTab';
import { UsersPanel } from './components/UsersPanel';
import { QueryList } from './components/QueryList';
import { SupportChat } from './components/SupportChat';
import { NotificationBell } from './components/NotificationBell';
import { VoiceAgent } from './components/VoiceAgent';
import { ProgressTab } from './components/ProgressTab';
import { SettingsTab } from './components/SettingsTab';
import logoLight from './assets/tsba-logo.png';
import logoDark from './assets/tsba-logo-dark.png';
import logoMark from './assets/tsba-mark.png';
import { IntegrationsPanel } from './pages/IntegrationsPanel';

// Control-room wall display (dark, full-screen). Lazy: pulls in globe.gl/three.js
// only when opened, so the console bundle stays light.
const EnergyDashboard = lazy(() =>
  import('./components/EnergyDashboard').then((m) => ({ default: m.EnergyDashboard })),
);

const SECTIONS: Section[] = [
  'dashboard', 'solar', 'map', 'energy', 'connections', 'knowledge', 'ask', 'drafts', 'voice', 'users', 'progress', 'settings',
];
const isSection = (v: unknown): v is Section => SECTIONS.includes(v as Section);

const PERM: Record<Section, Permission> = {
  dashboard: 'view', solar: 'view', map: 'view', energy: 'view', connections: 'view', knowledge: 'view',
  ask: 'ask', drafts: 'view', voice: 'ask', users: 'manage_users', progress: 'view', settings: 'view',
};

const TITLES: Record<Section, string> = {
  dashboard: 'Today’s work',
  solar: 'Fleet',
  map: 'Map',
  energy: 'Control room',
  connections: 'Connections',
  knowledge: 'Knowledge base',
  ask: 'Inbox',
  drafts: 'Drafts & approvals',
  voice: 'Voice & chat agent',
  users: 'Users & roles',
  progress: 'Build progress',
  settings: 'Settings',
};

const FLEET_VIEWS: { view: string; label: string }[] = [
  { view: 'overview', label: 'Overview' },
  { view: 'plants', label: 'Plants' },
  { view: 'alerts', label: 'Alerts' },
  { view: 'devices', label: 'Devices' },
  { view: 'analytics', label: 'Analytics' },
];

const COLLAPSE_KEY = 'tsba.sidebar.collapsed';
const SECTION_KEY = 'tsba.section';
const THEME_KEY = 'tsba.theme';
type Theme = 'light' | 'dark';

function pathForSection(s: Section): string {
  return s === 'dashboard' ? '/' : `/${s}`;
}
function sectionFromPath(pathname: string): Section | null {
  const seg = pathname.replace(/^\/+/, '').split('/')[0];
  if (!seg) return null;
  if (seg === 'admin') return 'dashboard'; // legacy alias
  return isSection(seg) ? seg : null;
}

interface Loc {
  section: Section;
  search: string;
}

function initialLoc(): Loc {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('status')) return { section: 'connections', search: window.location.search }; // OAuth return
    const fromPath = sectionFromPath(window.location.pathname);
    if (fromPath) return { section: fromPath, search: window.location.search };
    const t = params.get('tab'); // legacy ?tab= links
    if (t === 'admin') return { section: 'dashboard', search: '' };
    if (isSection(t)) return { section: t, search: '' };
    const saved = localStorage.getItem(SECTION_KEY);
    if (isSection(saved)) return { section: saved, search: '' };
  } catch {
    /* ignore */
  }
  return { section: 'dashboard', search: '' };
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export function App() {
  const [user, setUser] = useState<AuthenticatedUser | null>(() => (getToken() ? getStoredUser() : null));
  const [restoring, setRestoring] = useState<boolean>(() => Boolean(getToken()));
  const [loc, setLoc] = useState<Loc>(initialLoc);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readPref(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    writePref(THEME_KEY, theme);
  }, [theme]);

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

  useEffect(() => writePref(SECTION_KEY, loc.section), [loc.section]);

  // Normalise the URL once (strip legacy ?tab=, map / → last section).
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(loc.search);
    params.delete('tab');
    const qs = params.toString();
    const target = pathForSection(loc.section) + (qs ? `?${qs}` : '');
    if (window.location.pathname + window.location.search !== target) window.history.replaceState({}, '', target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const navigate = useCallback<Navigate>((section, search = '') => {
    const target = pathForSection(section) + search;
    if (window.location.pathname + window.location.search !== target) window.history.pushState({}, '', target);
    setLoc({ section, search });
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onPop = () =>
      setLoc({ section: sectionFromPath(window.location.pathname) ?? 'dashboard', search: window.location.search });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (!user) {
    if (restoring) return null;
    return <LoginForm onAuthed={setUser} />;
  }

  const onAuthError = () => {
    clearToken();
    setUser(null);
  };

  return (
    <ConsoleProvider user={user} navigate={navigate} onAuthError={onAuthError}>
      <Shell
        loc={loc}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onSignOut={onAuthError}
      />
    </ConsoleProvider>
  );
}

function Shell({ loc, theme, onToggleTheme, onSignOut }: {
  loc: Loc; theme: Theme; onToggleTheme: () => void; onSignOut: () => void;
}) {
  const { user, navigate, onAuthError, drafts, openGroups } = useConsole();
  const [collapsed, setCollapsed] = useState(() => readPref(COLLAPSE_KEY) === '1');
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const can = (s: Section) => hasPermission(user.role, PERM[s]);
  const active: Section = can(loc.section) ? loc.section : 'dashboard';
  const params = useMemo(() => new URLSearchParams(loc.search), [loc.search]);
  const fleetView = params.get('station') ? 'plant' : params.get('view') ?? 'overview';

  // Global shortcuts: Ctrl/⌘+K palette, "/" focuses palette too when not typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setNavOpen(false), [loc]);

  const pendingDrafts = (drafts ?? []).filter((d) => d.status === 'pending').length;
  const criticalAlerts = openGroups.filter((g) => g.severity === 'critical').length;

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePref(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });
  };

  // Full-screen control-room wall display.
  if (active === 'energy') {
    return (
      <Suspense fallback={<div className="c-wall-loading">Loading control room…</div>}>
        <EnergyDashboard onExit={() => navigate('map')} onAuthError={onAuthError} />
      </Suspense>
    );
  }

  const link = (s: Section, icon: IconName, label: string, badge?: { n: number; tone?: 'danger' | 'brand' }, search = '') =>
    can(s) ? (
      <a
        href={pathForSection(s) + search}
        className="c-nav-link"
        aria-current={active === s && (s !== 'solar' || !search) ? 'page' : undefined}
        title={collapsed ? label : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          navigate(s, search);
        }}
      >
        <Icon name={icon} />
        <span className="c-nav-label">{label}</span>
        {badge && badge.n > 0 && (
          <span className={`c-nav-badge ${badge.tone ?? ''}`} aria-label={`${badge.n} ${label.toLowerCase()} pending`}>
            {badge.n > 99 ? '99+' : badge.n}
          </span>
        )}
      </a>
    ) : null;

  const initials = (user.name || user.email || '?').trim().slice(0, 2).toUpperCase();
  const fleetLabel = FLEET_VIEWS.find((v) => v.view === fleetView)?.label ?? (fleetView === 'plant' ? 'Plant' : '');

  let body: ReactNode = null;
  switch (active) {
    case 'dashboard': body = <DashboardPage />; break;
    case 'solar': body = <SolarTab search={loc.search} />; break;
    case 'map': body = <MapPage />; break;
    case 'connections':
      body = (
        <div className="c-stack">
          <IntegrationsPanel />
          <div className="col"><ConnectionsManager user={user} onAuthError={onAuthError} /></div>
        </div>
      );
      break;
    case 'knowledge': body = <KnowledgeTab user={user} onAuthError={onAuthError} />; break;
    case 'ask': body = <><QueryList onAuthError={onAuthError} /><SupportChat onAuthError={onAuthError} floatingOnly /></>; break;
    case 'drafts': body = <DraftsPage search={loc.search} />; break;
    case 'voice': body = <VoiceAgent onAuthError={onAuthError} />; break;
    case 'users': body = <div className="col"><UsersPanel me={user} onAuthError={onAuthError} /></div>; break;
    case 'settings': body = <SettingsTab user={user} onAuthError={onAuthError} />; break;
    case 'progress': body = <ProgressTab onAuthError={onAuthError} />; break;
  }

  return (
    <div className={`c-shell ${collapsed ? 'collapsed' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <a href="#c-main" className="c-skip">Skip to content</a>
      {navOpen && <div className="c-nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className="c-side" aria-label="Console navigation">
        <div className="c-side-brand">
          <img className="c-brand-full" src={theme === 'dark' ? logoDark : logoLight} alt="TSBA — Trusted Solar, Bigger Advantage" />
          <img className="c-brand-mark" src={logoMark} alt="TSBA" />
          <span className="c-brand-sub">Support AI console</span>
        </div>
        <nav aria-label="Sections">
          <div className="c-nav-group">
            <div className="c-nav-h">Monitor</div>
            {link('dashboard', 'dashboard', 'Dashboard')}
            {/* The critical-alert badge sits on Fleet only while its sub-menu is hidden; otherwise on Alerts. */}
            {link('solar', 'fleet', 'Fleet', active === 'solar' && !collapsed ? undefined : { n: criticalAlerts, tone: 'danger' })}
            {active === 'solar' && !collapsed && (
              <div className="c-nav-sub">
                {FLEET_VIEWS.map((v) => (
                  <a key={v.view} href={`/solar${v.view === 'overview' ? '' : `?view=${v.view}`}`} className="c-nav-link"
                    aria-current={fleetView === v.view ? 'page' : undefined}
                    onClick={(e) => { e.preventDefault(); navigate('solar', v.view === 'overview' ? '' : `?view=${v.view}`); }}>
                    <span className="c-nav-label">{v.label}</span>
                    {v.view === 'alerts' && criticalAlerts > 0 && <span className="c-nav-badge danger">{criticalAlerts}</span>}
                  </a>
                ))}
              </div>
            )}
            {link('map', 'map', 'Map')}
          </div>
          {(can('ask') || can('drafts')) && (
            <div className="c-nav-group">
              <div className="c-nav-h">Support</div>
              {link('ask', 'inbox', 'Inbox')}
              {link('drafts', 'drafts', 'Drafts & approvals', { n: pendingDrafts, tone: 'brand' })}
              {link('voice', 'voice', 'Voice / chat agent')}
            </div>
          )}
          <div className="c-nav-group">
            <div className="c-nav-h">Knowledge</div>
            {link('connections', 'link', 'Connections')}
            {link('knowledge', 'book', 'Knowledge base')}
          </div>
          <div className="c-nav-group">
            <div className="c-nav-h">Admin</div>
            {link('users', 'users', 'Users & roles')}
            {link('settings', 'settings', 'Settings')}
          </div>
        </nav>

        <div className="c-side-foot">
          <span className="c-side-ver">Every AI reply is human-approved</span>
        </div>
      </aside>
      <button type="button" className="c-edge-toggle" onClick={toggleCollapsed} aria-pressed={collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <Icon name="chevron" size={14} className={collapsed ? undefined : 'flip'} />
      </button>

      <div className="c-main">
        <header className="c-top">
          <button type="button" className="c-iconbtn c-mobilenav-btn" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <h1>
            {TITLES[active]}
            {active === 'solar' && fleetLabel && <span className="c-crumb"> / {fleetLabel}</span>}
          </h1>
          <div className="c-top-right">
            <button type="button" className="c-topsearch" onClick={() => setPaletteOpen(true)} aria-label="Search (Ctrl+K)">
              <Icon name="search" size={16} />
              <span className="c-topsearch-t">Search plants, serials, drafts…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <button type="button" className="c-iconbtn bordered" onClick={onToggleTheme} aria-pressed={theme === 'dark'}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            {hasPermission(user.role, 'view') && (
              <NotificationBell onNavigate={(s) => navigate(s)} onAuthError={onAuthError} />
            )}
            <Menu
              label="Account"
              trigger={
                <span className="c-acct">
                  <span className="c-avatar" aria-hidden="true">{initials}</span>
                  <span className="c-acct-id c-hide-sm">
                    <strong>{user.name || user.email}</strong>
                    <span>{ROLE_LABELS[user.role]}</span>
                  </span>
                  <Icon name="chevronDown" size={14} />
                </span>
              }
              items={[
                { label: 'Sign out', icon: 'logout', onSelect: onSignOut },
              ]}
            />
          </div>
        </header>
        <main id="c-main" className="c-body content-body" tabIndex={-1}>
          {body}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
