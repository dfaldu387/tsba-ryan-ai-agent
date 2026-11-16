import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  hasPermission,
  ROLE_LABELS,
  type AuthenticatedUser,
  type Permission,
} from '@tsba/shared';
import { AuthError, clearToken, getMe, getStoredUser, getToken } from './api';
import { LoginForm } from './components/LoginForm';
import { ConsoleProvider, useConsole, type Navigate, type Section } from './lib/console';
import { CommandPalette } from './ui/CommandPalette';
import { Icon, Menu, SkeletonRows, type IconName } from './ui';
import { DashboardPage } from './pages/DashboardPage';
import { SolarTab } from './components/SolarTab';
import { DraftsPage } from './pages/DraftsPage';
import { ConnectionsManager } from './components/ConnectionsManager';
import { KnowledgeTab } from './components/KnowledgeTab';
import { UsersPanel } from './components/UsersPanel';
import { QueryList } from './components/QueryList';
import { SupportChat } from './components/SupportChat';
import { NotificationBell } from './components/NotificationBell';
import { ProgressTab } from './components/ProgressTab';
import { SettingsTab } from './components/SettingsTab';
import logoLight from './assets/tsba-logo.png';
import logoDark from './assets/tsba-logo-dark.png';
import logoMark from './assets/tsba-mark.png';
import { IntegrationsPanel } from './pages/IntegrationsPanel';
import { salesNavView } from './pages/sales/nav';
import { WorkspaceSwitcher, type Workspace, type WorkspaceId } from './ui/WorkspaceSwitcher';

const SALES_LABELS: Record<string, string> = {
  today: 'Today', agent: 'Pipeline agent', board: 'My pipeline', clients: 'My clients', score: 'Scoreboard', setup: 'My setup', overview: 'Overview',
  pipeline: 'Pipeline', messages: 'Text log', optouts: 'Opt-outs', reps: 'Reps', settings: 'Settings',
};

const WORKSPACES: Workspace[] = [
  { id: 'support', name: 'Solar support', hint: 'Fleet, inbox & knowledge', icon: 'sun', home: 'dashboard', search: '' },
  { id: 'sales', name: 'Sales pipeline', hint: 'Follow-ups, reps & team', icon: 'chat', home: 'sales', search: '' },
];

// Control-room wall display (dark, full-screen). Lazy: pulls in globe.gl/three.js
// only when opened, so the console bundle stays light.
const EnergyDashboard = lazy(() =>
  import('./components/EnergyDashboard').then((m) => ({ default: m.EnergyDashboard })),
);

// Separate workspaces / heavy screens, loaded on first visit.
const SalesPage = lazy(() => import('./pages/sales/SalesPage').then((m) => ({ default: m.SalesPage })));
const VoiceAgent = lazy(() => import('./components/VoiceAgent').then((m) => ({ default: m.VoiceAgent })));
// Map: Leaflet (~150 KB) is only needed on this one screen.
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })));

const SECTIONS: Section[] = [
  'dashboard', 'solar', 'map', 'energy', 'connections', 'knowledge', 'ask', 'drafts', 'voice', 'users', 'progress', 'settings', 'sales',
];
const isSection = (v: unknown): v is Section => SECTIONS.includes(v as Section);

const PERM: Record<Section, Permission> = {
  dashboard: 'view', solar: 'view', map: 'view', energy: 'view', connections: 'view', knowledge: 'view',
  ask: 'ask', drafts: 'view', voice: 'ask', users: 'manage_users', progress: 'view', settings: 'view', sales: 'sales',
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
  sales: 'Sales pipeline',
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
      .catch((err) => {
        // Only a rejected token signs the user out. A server error or dropped
        // connection (e.g. the API restarting during a deploy) keeps the cached
        // session; the next request retries and a real 401 still signs out.
        if (err instanceof AuthError || !getStoredUser()) {
          clearToken();
          setUser(null);
        }
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
  // A sales rep can't see the dashboard, so their home is the follow-up agent.
  const home: Section = can('dashboard') ? 'dashboard' : 'sales';
  const active: Section = can(loc.section) ? loc.section : home;
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

  // Two workspaces share the shell; the active section decides which sidebar shows.
  const workspace: WorkspaceId = active === 'sales' ? 'sales' : 'support';
  const salesNav = salesNavView(loc.search, hasPermission(user.role, 'sales_team'));
  const salesLink = (v: string, icon: IconName, label: string) => (
    <a
      key={v}
      href={`/sales?v=${v}`}
      className="c-nav-link"
      aria-current={active === 'sales' && salesNav === v ? 'page' : undefined}
      title={collapsed ? label : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate('sales', `?v=${v}`);
      }}
    >
      <Icon name={icon} />
      <span className="c-nav-label">{label}</span>
    </a>
  );

  const initials = (user.name || user.email || '?').trim().slice(0, 2).toUpperCase();
  const fleetLabel = FLEET_VIEWS.find((v) => v.view === fleetView)?.label ?? (fleetView === 'plant' ? 'Plant' : '');

  let body: ReactNode = null;
  switch (active) {
    case 'dashboard': body = <DashboardPage />; break;
    case 'solar': body = <SolarTab search={loc.search} />; break;
    case 'map': body = <Suspense fallback={<SkeletonRows rows={6} cols={3} />}><MapPage /></Suspense>; break;
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
    case 'voice': body = <Suspense fallback={<SkeletonRows rows={4} cols={1} />}><VoiceAgent onAuthError={onAuthError} /></Suspense>; break;
    case 'users': body = <div className="col"><UsersPanel me={user} onAuthError={onAuthError} /></div>; break;
    case 'settings': body = <SettingsTab user={user} onAuthError={onAuthError} />; break;
    case 'progress': body = <ProgressTab onAuthError={onAuthError} />; break;
    case 'sales': body = <Suspense fallback={<SkeletonRows rows={5} cols={3} />}><SalesPage search={loc.search} /></Suspense>; break;
  }

  return (
    <div className={`c-shell ${collapsed ? 'collapsed' : ''} ${navOpen ? 'nav-open' : ''}`}>
      <a href="#c-main" className="c-skip">Skip to content</a>
      {navOpen && <div className="c-nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <aside className="c-side" aria-label="Console navigation">
        <div className="c-side-brand">
          <img className="c-brand-full" src={theme === 'dark' ? logoDark : logoLight} alt="TSBA — Trusted Solar, Bigger Advantage" />
          <img className="c-brand-mark" src={logoMark} alt="TSBA" />
          <span className="c-brand-sub">{workspace === 'sales' ? 'Sales pipeline' : 'Support AI console'}</span>
        </div>
        <nav aria-label="Sections">
          {workspace === 'sales' ? (
            <>
              <div className="c-nav-group">
                <div className="c-nav-h">My follow-ups</div>
                {salesLink('today', 'dashboard', 'Today')}
                {salesLink('agent', 'ai', 'Pipeline agent')}
                {salesLink('board', 'columns', 'My pipeline')}
                {salesLink('clients', 'book', 'My clients')}
                {salesLink('score', 'trend', 'Scoreboard')}
                {salesLink('setup', 'user', 'My setup')}
              </div>
              {can('sales') && hasPermission(user.role, 'sales_team') && (
                <div className="c-nav-group">
                  <div className="c-nav-h">Sales admin</div>
                  {salesLink('overview', 'monitor', 'Overview')}
                  {salesLink('pipeline', 'flag', 'Pipeline')}
                  {salesLink('messages', 'chat', 'Text log')}
                  {salesLink('optouts', 'shield', 'Opt-outs')}
                  {salesLink('reps', 'users', 'Reps')}
                  {salesLink('settings', 'sliders', 'Sales settings')}
                </div>
              )}
            </>
          ) : (
            <>
            {can('dashboard') && (
  
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
  
            )}
  
            {(can('ask') || can('drafts')) && (
  
              <div className="c-nav-group">
  
                <div className="c-nav-h">Support</div>
  
                {link('ask', 'inbox', 'Inbox')}
  
                {link('drafts', 'drafts', 'Drafts & approvals', { n: pendingDrafts, tone: 'brand' })}
  
                {link('voice', 'voice', 'Voice / chat agent')}
  
              </div>
  
            )}
  
            {can('knowledge') && (
  
              <div className="c-nav-group">
  
                <div className="c-nav-h">Knowledge</div>
  
                {link('connections', 'link', 'Connections')}
  
                {link('knowledge', 'book', 'Knowledge base')}
  
              </div>
  
            )}
  
            {(can('users') || can('settings')) && (
  
              <div className="c-nav-group">
  
                <div className="c-nav-h">Admin</div>
  
                {link('users', 'users', 'Users & roles')}
  
                {link('settings', 'settings', 'Settings')}
  
              </div>
  
            )}
  
              </>
          )}
        </nav>

        <div className="c-side-foot">
          <WorkspaceSwitcher
            current={workspace}
            collapsed={collapsed}
            options={WORKSPACES.filter((w) => can(w.home))}
            onSwitch={(w) => navigate(w.home, w.search)}
          />
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
            {active === 'sales' && SALES_LABELS[salesNav] && <span className="c-crumb"> / {SALES_LABELS[salesNav]}</span>}
          </h1>
          <div className="c-top-right">
            {can('dashboard') && (
              <button type="button" className="c-topsearch" onClick={() => setPaletteOpen(true)} aria-label="Search (Ctrl+K)">
                <Icon name="search" size={16} />
                <span className="c-topsearch-t">Search plants, serials, drafts…</span>
                <kbd>Ctrl K</kbd>
              </button>
            )}
            <button type="button" className="c-iconbtn bordered c-hide-sm" onClick={onToggleTheme} aria-pressed={theme === 'dark'}
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
                  <Icon name="chevronDown" size={14} className="c-hide-sm" />
                </span>
              }
              items={[
                // On phones the theme button is hidden from the top bar to give the title room; it lives here instead.
                { label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? 'sun' : 'moon', onSelect: onToggleTheme },
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
