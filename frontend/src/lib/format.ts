// Console-wide data formatting rules:
//  • thousands separators everywhere (en-AU), units always shown
//  • one empty value: "—"
//  • times shown in plant-local (Australian) time; relative + absolute-on-hover
export const EMPTY = '—';

const AU = 'en-AU';
export const PLANT_TZ = 'Australia/Sydney';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function fmtInt(v?: number | null): string {
  return isNum(v) ? Math.round(v).toLocaleString(AU) : EMPTY;
}

export function fmtNum(v?: number | null, digits = 1): string {
  return isNum(v) ? v.toLocaleString(AU, { minimumFractionDigits: 0, maximumFractionDigits: digits }) : EMPTY;
}

/** Watts → kW (always kW in tables so columns line up). */
export function fmtKw(w?: number | null, digits = 1): string {
  if (!isNum(w)) return EMPTY;
  return `${(w / 1000).toLocaleString(AU, { minimumFractionDigits: digits, maximumFractionDigits: digits })} kW`;
}

/** Watts → adaptive kW / MW for headline numbers. */
export function fmtPowerBig(w?: number | null): string {
  if (!isNum(w)) return EMPTY;
  if (Math.abs(w) >= 1_000_000) return `${fmtNum(w / 1_000_000, 2)} MW`;
  return `${fmtNum(w / 1000, 1)} kW`;
}

/** kWh → kWh / MWh / GWh with separators. */
export function fmtKwh(kwh?: number | null): string {
  if (!isNum(kwh)) return EMPTY;
  if (Math.abs(kwh) >= 1_000_000) return `${fmtNum(kwh / 1_000_000, 2)} GWh`;
  if (Math.abs(kwh) >= 10_000) return `${fmtNum(kwh / 1000, 1)} MWh`;
  return `${fmtNum(kwh, 1)} kWh`;
}

export function fmtKwp(kw?: number | null): string {
  if (!isNum(kw)) return EMPTY;
  if (kw >= 10_000) return `${fmtNum(kw / 1000, 1)} MWp`;
  return `${fmtNum(kw, kw >= 100 ? 0 : 1)} kWp`;
}

export function fmtPct(v?: number | null): string {
  return isNum(v) ? `${Math.round(v)}%` : EMPTY;
}

/** Normalise an epoch in seconds OR milliseconds (or ISO string) to ms. */
export function toMs(t?: number | string | null): number | null {
  if (t == null || t === '') return null;
  if (typeof t === 'string') {
    const ms = new Date(t).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (!isNum(t) || t <= 0) return null;
  return t < 1e12 ? t * 1000 : t;
}

/** Absolute plant-local time, e.g. "14 Nov 2026, 2:05 pm AEDT". */
export function fmtAbs(t?: number | string | null): string {
  const ms = toMs(t);
  if (ms == null) return EMPTY;
  return new Date(ms).toLocaleString(AU, {
    timeZone: PLANT_TZ, day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

export function fmtClock(t?: number | string | null): string {
  const ms = toMs(t);
  if (ms == null) return EMPTY;
  return new Date(ms).toLocaleTimeString(AU, { timeZone: PLANT_TZ, hour: 'numeric', minute: '2-digit' });
}

/** "just now" / "12 min ago" / "3 h ago" / "2 d ago". */
export function fmtRel(t?: number | string | null, now = Date.now()): string {
  const ms = toMs(t);
  if (ms == null) return EMPTY;
  const sec = Math.round((now - ms) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h ago`;
  if (sec < 86_400 * 45) return `${Math.round(sec / 86_400)} d ago`;
  // Older than ~6 weeks: a short date; the full time is in the title tooltip.
  return new Date(ms).toLocaleDateString(AU, { timeZone: PLANT_TZ, day: 'numeric', month: 'short', year: 'numeric' });
}

/** Staleness bucket for last-communication colouring. */
export type Staleness = 'fresh' | 'stale' | 'old' | 'none';
export function staleness(t?: number | string | null, now = Date.now()): Staleness {
  const ms = toMs(t);
  if (ms == null) return 'none';
  const min = (now - ms) / 60_000;
  if (min <= 30) return 'fresh';
  if (min <= 24 * 60) return 'stale';
  return 'old';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString(AU)} ${n === 1 ? one : many}`;
}

/** Mask a person/address string for low-privilege roles: "Jane Smith" → "J••• S•••". */
export function mask(s?: string | null): string {
  if (!s) return EMPTY;
  return s
    .split(/\s+/)
    .map((w) => (w.length <= 1 ? w : `${w[0]}${'•'.repeat(Math.min(3, w.length - 1))}`))
    .join(' ');
}

/**
 * Installed capacity of the fleet, in kW. Counts commissioned plants only: a
 * plant that is offline and has never reported power is a placeholder on the
 * platform (often with a nonsense size), so it would inflate the total. One
 * definition, used by the dashboard and the Fleet overview so they agree.
 */
export function installedCapacityKw(stations: { status: string; currentPowerW?: number | null; capacityKw?: number | null }[]): number {
  return stations
    .filter((s) => !(s.status === 'offline' && s.currentPowerW == null))
    .reduce((a, s) => a + (s.capacityKw ?? 0), 0);
}
