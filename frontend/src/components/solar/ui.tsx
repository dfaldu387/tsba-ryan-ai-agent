// Shared presentational primitives for the Solar Monitoring module:
// sub-navigation, KPI tiles, status chips, cards, empty/loading states, a
// slide-over drawer and small line icons.
import type { ReactNode } from 'react';
import type { StationStatus } from '../../api';
import { STATUS_META } from './format';

export type SolarView = 'overview' | 'plants' | 'analytics' | 'devices' | 'alerts' | 'integrations';

export const SOLAR_VIEWS: SolarView[] = ['overview', 'plants', 'analytics', 'devices', 'alerts', 'integrations'];

// ─── Line icons (inherit colour via currentColor) ────────────────────────────

const svg = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);

export const ICON: Record<string, ReactNode> = {
  overview: svg(<><rect x="3" y="3" width="7" height="9" rx="1.3" /><rect x="14" y="3" width="7" height="5" rx="1.3" /><rect x="14" y="12" width="7" height="9" rx="1.3" /><rect x="3" y="16" width="7" height="5" rx="1.3" /></>),
  plants: svg(<><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" /></>),
  analytics: svg(<><path d="M3 3v18h18" /><path d="M7 15l3-4 3 2 4-6" /></>),
  devices: svg(<><rect x="2" y="7" width="20" height="13" rx="2" /><path d="M7 4h10M9 20v-4M15 20v-4" /></>),
  alerts: svg(<><path d="M10.3 3.3a2 2 0 0 1 3.4 0l8 14a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3z" /><path d="M12 9v4M12 17h.01" /></>),
  integrations: svg(<><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" /></>),
  power: svg(<path d="M13 2 3 14h7l-1 8 10-12h-7z" />),
  capacity: svg(<><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M7 7V4h10v3M7 13h4" /></>),
  today: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" /></>),
  month: svg(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /></>),
  lifetime: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  online: svg(<><path d="M5 12.5 9 16l10-10" /></>),
  search: svg(<><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></>),
  refresh: svg(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></>),
  chevron: svg(<path d="m9 6 6 6-6 6" />),
  close: svg(<path d="M6 6l12 12M18 6 6 18" />),
  ai: svg(<><path d="M12 2a3 3 0 0 1 3 3v1a3 3 0 0 1 3 3 3 3 0 0 1-1 5.8V17a3 3 0 0 1-3 3 3 3 0 0 1-6 0 3 3 0 0 1-3-3v-2.2A3 3 0 0 1 6 9a3 3 0 0 1 3-3V5a3 3 0 0 1 3-3z" /></>),
};

const VIEW_LABEL: Record<SolarView, string> = {
  overview: 'Overview',
  plants: 'Plants',
  analytics: 'Analytics',
  devices: 'Devices',
  alerts: 'Alerts',
  integrations: 'Integrations',
};

// ─── Sub-navigation ──────────────────────────────────────────────────────────

export function SubNav({ active, onChange, alertCount }: { active: SolarView; onChange: (v: SolarView) => void; alertCount?: number }) {
  return (
    <nav className="solar-subnav" aria-label="Solar monitoring sections">
      {SOLAR_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          className={`solar-subnav-item ${active === v ? 'active' : ''}`}
          aria-current={active === v ? 'page' : undefined}
          onClick={() => onChange(v)}
        >
          <span className="solar-subnav-ico">{ICON[v]}</span>
          <span className="solar-subnav-label">{VIEW_LABEL[v]}</span>
          {v === 'alerts' && alertCount != null && alertCount > 0 && <span className="solar-subnav-count">{alertCount}</span>}
        </button>
      ))}
    </nav>
  );
}

// ─── Portfolio KPI tile ──────────────────────────────────────────────────────

export function KpiTile({
  icon, label, value, unit, trend, tone, title,
}: {
  icon?: keyof typeof ICON; label: string; value: string; unit?: string; trend?: ReactNode;
  tone?: 'accent' | 'default'; title?: string;
}) {
  return (
    <div className={`solar-tile ${tone === 'accent' ? 'accent' : ''}`} title={title}>
      <div className="solar-tile-top">
        <span className="solar-tile-label">{label}</span>
        {icon && <span className="solar-tile-ico">{ICON[icon]}</span>}
      </div>
      <div className="solar-tile-value solar-mono">
        {value}{unit && <span className="solar-tile-unit">{unit}</span>}
      </div>
      {trend != null && <div className="solar-tile-trend">{trend}</div>}
    </div>
  );
}

// ─── Status chip + dot ───────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: StationStatus }) {
  const m = STATUS_META[status];
  return <span className={`solar-badge ${m.cls}`}>{m.label}</span>;
}

export function StatusDot({ status }: { status: StationStatus }) {
  const m = STATUS_META[status];
  return <span className={`solar-dot ${m.tone === 'ok' ? 'ok' : m.tone === 'bad' ? 'flag' : m.tone === 'warn' ? 'mid' : 'muted'}`} />;
}

// ─── Section card ────────────────────────────────────────────────────────────

export function SectionCard({ title, eyebrow, actions, children, className }: {
  title?: string; eyebrow?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions || eyebrow) && (
        <div className="card-h">
          <div>
            {title && <h2>{title}</h2>}
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

// ─── Empty / loading ─────────────────────────────────────────────────────────

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: keyof typeof ICON }) {
  return (
    <div className="solar-emptystate">
      {icon && <span className="solar-emptystate-ico">{ICON[icon]}</span>}
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function SkeletonTiles({ count = 6 }: { count?: number }) {
  return (
    <div className="solar-tiles">
      {Array.from({ length: count }).map((_, i) => (
        <div className="solar-tile skeleton" key={i}>
          <div className="sk-line sk-sm" />
          <div className="sk-line sk-lg" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="solar-skrows">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="sk-line sk-row" key={i} />
      ))}
    </div>
  );
}

// ─── Slide-over drawer (right side; full-screen on mobile) ───────────────────

export function Drawer({ open, title, eyebrow, onClose, children }: {
  open: boolean; title: string; eyebrow?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="solar-drawer-root" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="solar-drawer-backdrop" aria-label="Close" onClick={onClose} />
      <div className="solar-drawer">
        <div className="solar-drawer-head">
          <div>
            <h3>{title}</h3>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          </div>
          <button type="button" className="solar-drawer-close" onClick={onClose} aria-label="Close drawer">{ICON.close}</button>
        </div>
        <div className="solar-drawer-body">{children}</div>
      </div>
    </div>
  );
}

// ─── Refresh / freshness bar ─────────────────────────────────────────────────

export function RefreshBar({ lastUpdated, refreshing, onRefresh }: { lastUpdated: number | null; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="solar-refresh-bar">
      <span className="solar-updated">
        {refreshing
          ? 'Updating…'
          : lastUpdated
            ? `Updated ${new Date(lastUpdated).toLocaleTimeString()} · auto every 60s`
            : ''}
      </span>
      <button type="button" className="ghost solar-refresh-btn" onClick={onRefresh} disabled={refreshing}>
        <span className={`solar-refresh-ico ${refreshing ? 'spin' : ''}`} aria-hidden="true">↻</span> Refresh
      </button>
    </div>
  );
}

// ─── Provider brand accents (for Integrations cards) ─────────────────────────

const PROVIDER_ACCENT: Record<string, string> = {
  deye: '#ff7a00',
  elekeeper: '#1f9d55',
  esolar: '#1f9d55',
  saj: '#1f9d55',
  goodwe: '#e4002b',
  sems: '#e4002b',
  solarman: '#f59e0b',
  solis: '#2563eb',
  soliscloud: '#2563eb',
  sigen: '#10b981',
  sigenergy: '#10b981',
  dyness: '#7c3aed',
  sungrow: '#d4302a',
  growatt: '#e4002b',
};

export function providerAccent(id: string, name: string): string {
  const key = id.toLowerCase();
  if (PROVIDER_ACCENT[key]) return PROVIDER_ACCENT[key];
  const nk = name.toLowerCase();
  for (const [k, v] of Object.entries(PROVIDER_ACCENT)) if (nk.includes(k)) return v;
  return '#64748b';
}

export function providerInitials(name: string): string {
  return name.replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 2).toUpperCase() || '?';
}
