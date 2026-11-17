// Console component library. Namespaced `c-` (see console.css). Every component
// covers its default / hover / loading / empty / error states.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { StationStatus } from '../api';
import { fmtAbs, fmtInt, fmtRel, staleness, toMs } from '../lib/format';
import type { Severity } from '../lib/alerts';
import { SEVERITY_LABEL } from '../lib/alerts';

// ─── Icons ───────────────────────────────────────────────────────────────────
const p = (d: ReactNode) => d;
const PATHS: Record<string, ReactNode> = {
  dashboard: p(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>),
  fleet: p(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>),
  map: p(<><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></>),
  inbox: p(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z" /></>),
  drafts: p(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>),
  voice: p(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" /></>),
  link: p(<><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><path d="M8 12h8" /></>),
  book: p(<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>),
  users: p(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>),
  settings: p(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>),
  search: p(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  alert: p(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>),
  plant: p(<><path d="M3 21h18M5 21V8l7-5 7 5v13" /><path d="M9 21v-6h6v6" /></>),
  bolt: p(<path d="M13 2 3 14h7l-1 8 10-12h-7z" />),
  sun: p(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" /></>),
  offline: p(<><path d="M2 2l20 20" /><path d="M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5M12 20h.01" /></>),
  check: p(<path d="M20 6 9 17l-5-5" />),
  x: p(<path d="M18 6 6 18M6 6l12 12" />),
  chevron: p(<path d="m9 6 6 6-6 6" />),
  chevronDown: p(<path d="m6 9 6 6 6-6" />),
  more: p(<><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>),
  refresh: p(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v5h-5" /></>),
  external: p(<><path d="M15 3h6v6M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>),
  ai: p(<><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></>),
  mail: p(<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></>),
  clock: p(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  user: p(<><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></>),
  doc: p(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>),
  shield: p(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />),
  battery: p(<><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2M6 10v4M10 10v4" /></>),
  thumbUp: p(<><path d="M7 10v12M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H7V10l4-8a3 3 0 0 1 4 3.9z" /></>),
  thumbDown: p(<><path d="M17 14V2M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.6 2H17v12l-4 8a3 3 0 0 1-4-3.9z" /></>),
  copy: p(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>),
  flag: p(<><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><path d="M4 22v-7" /></>),
  send: p(<><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>),
  plus: p(<path d="M12 5v14M5 12h14" />),
  sliders: p(<><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></>),
  columns: p(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v18" /></>),
  bell: p(<><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>),
  wrench: p(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />),
  monitor: p(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>),
  menu: p(<path d="M3 6h18M3 12h18M3 18h18" />),
  moon: p(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  logout: p(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>),
  chat: p(<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6A8.4 8.4 0 1 1 21 11.5z" />),
  trend: p(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>),
  stop: p(<rect x="6" y="6" width="12" height="12" rx="2" />),
  back: p(<path d="m15 18-6-6 6-6" />),
};
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}

// ─── Status pill / dot ───────────────────────────────────────────────────────
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand' | 'gold';

export const STATION_TONE: Record<StationStatus, { tone: Tone; label: string }> = {
  online: { tone: 'success', label: 'Online' },
  partial: { tone: 'warning', label: 'Partial' },
  offline: { tone: 'danger', label: 'Offline' },
  waiting: { tone: 'neutral', label: 'Waiting' },
  unknown: { tone: 'neutral', label: 'No data' },
};

/** What each status means, shown as a tooltip wherever a status is displayed. */
export const STATION_HINT: Record<StationStatus, string> = {
  online: 'All devices are reporting.',
  partial: 'Some devices at this plant are not reporting.',
  offline: 'No devices at this plant are reporting.',
  waiting: 'The provider is waiting for the plant to start reporting (e.g. overnight or newly installed).',
  unknown: 'The provider has not reported a status for this plant — usually no datalogger or inverter is linked to it.',
};

/** A plant that has never sent any data (no status, power, energy or update time). */
export function neverReported(s: { status: StationStatus; lastUpdate?: number; currentPowerW?: number; dailyEnergyKwh?: number }): boolean {
  return s.status === 'unknown' && !s.lastUpdate && s.currentPowerW == null && s.dailyEnergyKwh == null;
}

export function Pill({ tone = 'neutral', children, dot, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`c-pill t-${tone}`} title={title}>
      {dot && <span className="c-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

const DEVICE_TONE: Record<string, { tone: Tone; label: string; hint: string }> = {
  normal: { tone: 'success', label: 'Online', hint: 'Communicating and operating normally.' },
  standby: { tone: 'info', label: 'Standby', hint: 'Idle but communicating — e.g. a full battery that isn’t cycling. Not a fault.' },
  alarm: { tone: 'warning', label: 'Alarm', hint: 'Communicating but reporting a fault — see Alerts.' },
  offline: { tone: 'danger', label: 'Offline', hint: 'Not communicating with the provider portal.' },
};

/** Per-device state, showing the provider's own label (e.g. SAJ "Standby", "Discharge")
 *  like the vendor portal does. Falls back to the legacy online flag for providers
 *  that don't report a state. */
export function DeviceStatePill({ device }: { device: { online?: boolean; state?: string; stateLabel?: string } }) {
  const key = device.state && device.state !== 'unknown'
    ? device.state
    : device.online === false ? 'offline' : device.online === true ? 'normal' : undefined;
  if (!key) return <Pill tone="neutral" title="The provider didn’t report a state for this device.">{device.stateLabel || 'Unknown'}</Pill>;
  const m = DEVICE_TONE[key];
  return <Pill tone={m.tone} dot title={m.hint}>{device.stateLabel || m.label}</Pill>;
}

export function StatusPill({ status }: { status: StationStatus }) {
  const m = STATION_TONE[status];
  return <Pill tone={m.tone} dot title={STATION_HINT[status]}>{m.label}</Pill>;
}

export function StatusDot({ status, label }: { status: StationStatus; label?: boolean }) {
  const m = STATION_TONE[status];
  return (
    <span className={`c-sdot t-${m.tone}`} title={`${m.label} — ${STATION_HINT[status]}`}>
      <span className="c-dot" aria-hidden="true" />
      {label ? m.label : <span className="c-sr">{m.label}</span>}
    </span>
  );
}

const SEV_TONE: Record<Severity, Tone> = { critical: 'danger', warning: 'warning', info: 'info' };
export function SeverityPill({ severity }: { severity: Severity }) {
  return <Pill tone={SEV_TONE[severity]} dot>{SEVERITY_LABEL[severity]}</Pill>;
}

// ─── Provider chip ───────────────────────────────────────────────────────────
const PROVIDER_HUE: Record<string, number> = {
  deye: 24, goodwe: 352, sems: 352, saj: 150, esolar: 150, elekeeper: 150, solarman: 38, solis: 218,
  soliscloud: 218, sigen: 168, sigenergy: 168, dyness: 268, sungrow: 4, growatt: 340, whes: 196,
};
export function providerHue(id: string): number {
  const k = id.toLowerCase();
  for (const [key, h] of Object.entries(PROVIDER_HUE)) if (k.includes(key)) return h;
  let h = 0;
  for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export function ProviderChip({ id, name }: { id: string; name: string }) {
  return (
    <span className="c-prov" style={{ ['--h' as string]: providerHue(id) }}>
      <span className="c-prov-mark" aria-hidden="true" />
      {name}
    </span>
  );
}

// ─── Time ────────────────────────────────────────────────────────────────────
export function RelTime({ t, stale }: { t?: number | string | null; stale?: boolean }) {
  const ms = toMs(t);
  if (ms == null) return <span className="c-empty-val">—</span>;
  const s = stale ? staleness(ms) : undefined;
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtAbs(ms)} className={s ? `c-stale s-${s}` : undefined}>
      {fmtRel(ms)}
    </time>
  );
}

// ─── Sparkline ───────────────────────────────────────────────────────────────
export function Sparkline({ values, width = 96, height = 28, tone = 'brand', label }: {
  values: (number | null | undefined)[]; width?: number; height?: number; tone?: Tone; label?: string;
}) {
  const nums = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const real = nums.filter((v): v is number => v != null);
  if (real.length < 2) return <span className="c-empty-val">—</span>;
  const max = Math.max(...real, 0.0001);
  const min = Math.min(...real, 0);
  const span = max - min || 1;
  const step = width / (nums.length - 1);
  let d = '';
  nums.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg className={`c-spark t-${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? 'trend'}>
      <path d={`${d}L${width},${height}L0,${height}Z`} className="c-spark-area" />
      <path d={d} className="c-spark-line" />
    </svg>
  );
}

/** Horizontal ratio bar (e.g. performance ratio). */
export function RatioBar({ value, max = 100, tone }: { value: number | null; max?: number; tone?: Tone }) {
  if (value == null || !Number.isFinite(value)) return <span className="c-empty-val">—</span>;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const t: Tone = tone ?? (pct >= 60 ? 'success' : pct >= 30 ? 'warning' : 'danger');
  return (
    <span className="c-ratio" title={`${Math.round(value)}%`}>
      <span className={`c-ratio-bar t-${t}`}><span style={{ width: `${pct}%` }} /></span>
      <span className="c-ratio-n">{Math.round(value)}%</span>
    </span>
  );
}

// ─── KPI tile ────────────────────────────────────────────────────────────────
export function KpiTile({
  label, value, sub, tone, icon, spark, onClick, loading, delta,
}: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; icon?: IconName;
  spark?: (number | null)[]; onClick?: () => void; loading?: boolean;
  delta?: { text: string; tone: Tone };
}) {
  const inner = (
    <>
      <span className="c-kpi-top">
        <span className="c-kpi-label">{label}</span>
        {icon && <span className={`c-kpi-ico t-${tone ?? 'neutral'}`}><Icon name={icon} size={16} /></span>}
      </span>
      {loading ? (
        <span className="c-skel c-skel-lg" />
      ) : (
        <span className="c-kpi-value">{value}</span>
      )}
      <span className="c-kpi-foot">
        {/* The footer is derived from the same data as the value, so it waits for it too. */}
        {loading ? <span className="c-skel c-skel-sm" aria-hidden="true" /> : (
          <>
            {delta && <span className={`c-delta t-${delta.tone}`}>{delta.text}</span>}
            {sub && <span className="c-kpi-sub">{sub}</span>}
            {spark && <Sparkline values={spark} tone={tone ?? 'brand'} />}
          </>
        )}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className={`c-kpi is-link ${tone ? `k-${tone}` : ''}`} onClick={onClick}>{inner}</button>
  ) : (
    <div className={`c-kpi ${tone ? `k-${tone}` : ''}`}>{inner}</div>
  );
}

// ─── Section (flat, no card-in-card) ─────────────────────────────────────────
export function Section({ title, sub, actions, children, className, id }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  const hid = useId();
  return (
    <section className={`c-section ${className ?? ''}`} aria-labelledby={title ? hid : undefined} id={id}>
      {(title || actions) && (
        <header className="c-section-h">
          <div className="c-section-t">
            {title && <h2 id={hid}>{title}</h2>}
            {sub && <span className="c-section-sub">{sub}</span>}
          </div>
          {actions && <div className="c-section-a">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ─── Empty / error / skeleton ────────────────────────────────────────────────
export function EmptyState({ icon = 'check', title, hint, action, tone = 'neutral' }: {
  icon?: IconName; title: string; hint?: ReactNode; action?: ReactNode; tone?: Tone;
}) {
  return (
    <div className={`c-emptystate t-${tone}`}>
      <span className="c-emptystate-ico"><Icon name={icon} size={20} /></span>
      <strong>{title}</strong>
      {hint && <span className="c-emptystate-hint">{hint}</span>}
      {action}
    </div>
  );
}

export function ErrorState({ title = 'Couldn’t load this', detail, onRetry }: { title?: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="c-errorstate" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
      {onRetry && <button type="button" className="c-btn sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="c-skelrows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="c-skelrow" key={i}>
          {Array.from({ length: cols }).map((__, j) => <span key={j} className="c-skel" />)}
        </div>
      ))}
    </div>
  );
}

// ─── Drawer (right side; bottom sheet on mobile) ─────────────────────────────
export function Drawer({ open, onClose, title, sub, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hid = useId();
  // Callers often pass an inline onClose; keeping it in a ref means the focus
  // effect below runs only when the drawer opens/closes — not on every parent
  // re-render (e.g. the 30s fleet poll), which used to yank focus out of inputs.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="c-drawer-root">
      <div className="c-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className={`c-drawer ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={hid} ref={ref} tabIndex={-1}>
        <header className="c-drawer-h">
          <div className="c-drawer-t">
            <h2 id={hid}>{title}</h2>
            {sub && <div className="c-drawer-sub">{sub}</div>}
          </div>
          <button type="button" className="c-iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="c-drawer-b">{children}</div>
        {footer && <footer className="c-drawer-f">{footer}</footer>}
      </div>
    </div>
  );
}

// ─── Dropdown menu ───────────────────────────────────────────────────────────
export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}
export function Menu({ label, icon = 'more', items, align = 'right', trigger }: {
  label: string; icon?: IconName; items: (MenuItem | 'sep')[]; align?: 'left' | 'right'; trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // The popup is portalled to <body> with fixed positioning so a scrolling or
  // overflow-clipped ancestor (e.g. the deal board) can't cut it off. Placed
  // under the trigger, flipped above when there's no room, clamped on-screen.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const btn = ref.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!btn || !pop) return;
      const m = 8, vw = window.innerWidth, vh = window.innerHeight;
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let top = btn.bottom + 4;
      if (top + ph > vh - m && btn.top - 4 - ph >= m) top = btn.top - 4 - ph;
      top = Math.max(m, Math.min(top, vh - ph - m));
      let left = align === 'right' ? btn.right - pw : btn.left;
      left = Math.max(m, Math.min(left, vw - pw - m));
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    };
    place();
    const onScroll = (e: Event) => { if (!popRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!t && (ref.current?.contains(t as Node) || popRef.current?.contains(t as Node));
    const onDoc = (e: MouseEvent) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    popRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };
  return (
    <div className="c-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button type="button" className={trigger ? 'c-btn sm' : 'c-iconbtn'} aria-haspopup="menu" aria-expanded={open}
        aria-label={trigger ? undefined : label} title={trigger ? undefined : label} onClick={() => setOpen((o) => !o)}>
        {trigger ?? <Icon name={icon} />}
      </button>
      {open && createPortal(
        <div ref={popRef} className={`c-menu-pop ${align}`} role="menu" aria-label={label} onKeyDown={onMenuKey}
          onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="c-menu-sep" role="separator" />
            ) : (
              <button key={i} type="button" role="menuitem" className={`c-menu-item ${it.danger ? 'danger' : ''}`}
                disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }}>
                {it.icon && <Icon name={it.icon} size={16} />}
                <span>{it.label}</span>
                {it.hint && <span className="c-menu-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ─── Segmented control / filter chips / tabs ─────────────────────────────────
export function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string;
}) {
  return (
    <div className="c-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count != null && <span className="c-seg-n">{o.count.toLocaleString('en-AU')}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chip({ active, onClick, children, tone, count }: {
  active?: boolean; onClick: () => void; children: ReactNode; tone?: Tone; count?: number;
}) {
  return (
    <button type="button" className={`c-chip ${active ? 'on' : ''} ${tone ? `t-${tone}` : ''}`} aria-pressed={active} onClick={onClick}>
      {tone && <span className="c-dot" aria-hidden="true" />}
      {children}
      {count != null && <span className="c-chip-n">{count.toLocaleString('en-AU')}</span>}
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: {
  value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[]; label: string;
}) {
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    onChange(n.value);
    (e.currentTarget.parentElement?.querySelector(`[data-tab="${n.value}"]`) as HTMLElement | null)?.focus();
  };
  // When tabs don't fit they scroll sideways; fade the edge that hides more tabs
  // so it's visible that there are more, and keep the selected tab in view.
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const more = el.scrollWidth - el.clientWidth;
      setEdge(more <= 1 ? '' : el.scrollLeft < 2 ? 'fade-r' : el.scrollLeft >= more - 2 ? 'fade-l' : 'fade-lr');
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', update); };
  }, [tabs.length]);
  useEffect(() => {
    (ref.current?.querySelector('[aria-selected="true"]') as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  return (
    <div ref={ref} className={`c-tabs ${edge}`} role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button key={t.value} type="button" role="tab" data-tab={t.value} aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1} onClick={() => onChange(t.value)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}
          {t.count != null && t.count > 0 && <span className="c-tab-n">{t.count.toLocaleString('en-AU')}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, label, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string; autoFocus?: boolean;
}) {
  return (
    <label className="c-search">
      <Icon name="search" size={16} />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        aria-label={label} autoFocus={autoFocus} />
      {value && (
        <button type="button" className="c-search-x" onClick={() => onChange('')} aria-label="Clear search"><Icon name="x" size={14} /></button>
      )}
    </label>
  );
}

/** Truncated text with the full value in a tooltip. */
export function Trunc({ text, className }: { text: string; className?: string }) {
  return <span className={`c-trunc ${className ?? ''}`} title={text}>{text}</span>;
}

/** Persisted (per browser) UI preference. */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`tsba.pref.${key}`);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try { localStorage.setItem(`tsba.pref.${key}`, JSON.stringify(next)); } catch { /* ignore */ }
  };
  return [v, set];
}

// ─── Pagination (all tables: 15 rows per page) ───────────────────────────────
export const PAGE_SIZE = 15;

/**
 * Page state for a list. Jumps back to page 1 whenever `resetKey` changes
 * (filters / search / sort) and clamps when the list shrinks.
 */
export function usePaged<T>(items: T[], resetKey: unknown = null, size = PAGE_SIZE) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const key = JSON.stringify(resetKey);
  useEffect(() => { setPage(0); }, [key]);
  const safe = Math.min(page, pageCount - 1);
  const start = safe * size;
  return { page: safe, setPage, pageCount, start, size, total: items.length, slice: items.slice(start, start + size) };
}

function pageNumbers(page: number, count: number): (number | null)[] {
  const keep = new Set([0, count - 1, page - 1, page, page + 1].filter((n) => n >= 0 && n < count));
  const out: (number | null)[] = [];
  let prev = -1;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}

/** "1–15 of 288 plants" + Prev / page numbers / Next. Renders nothing for an empty list. */
export function Pager({ paged, noun, label, extra }: {
  paged: { page: number; setPage: (n: number) => void; pageCount: number; start: number; size: number; total: number };
  noun: string; label?: string; extra?: ReactNode;
}) {
  const { page, setPage, pageCount, start, size, total } = paged;
  if (total === 0) return null;
  const plural = total === 1 ? noun : `${noun}s`;
  return (
    <div className="c-tablefoot">
      <span>{fmtInt(start + 1)}–{fmtInt(Math.min(start + size, total))} of {fmtInt(total)} {plural}</span>
      {extra}
      {pageCount > 1 && (
        <nav className="c-pager" aria-label={label ?? `${noun} pages`}>
          <button type="button" className="c-btn sm" onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Previous page">
            <Icon name="chevron" size={14} className="flip" /> Prev
          </button>
          {pageNumbers(page, pageCount).map((n, i) => n == null
            ? <span key={`gap${i}`} className="c-pager-gap" aria-hidden="true">…</span>
            : <button key={n} type="button" className={`c-btn sm ${n === page ? 'primary' : 'ghost'}`} aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${n + 1}`} onClick={() => setPage(n)}>{n + 1}</button>)}
          <button type="button" className="c-btn sm" onClick={() => setPage(page + 1)} disabled={page >= pageCount - 1} aria-label="Next page">
            Next <Icon name="chevron" size={14} />
          </button>
        </nav>
      )}
    </div>
  );
}
