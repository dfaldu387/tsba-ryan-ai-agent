// Shared formatting helpers + status metadata for the Solar Monitoring module.
import type { StationStatus } from '../../api';

/** Watts → "1.24 kW" / "820 W". */
export function fmtPower(w?: number): string {
  if (w == null || Number.isNaN(w)) return '—';
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

/** kWh → "738.5 kWh" / "62.49 MWh" / "3.26 GWh". */
export function fmtEnergy(kwh?: number): string {
  if (kwh == null || Number.isNaN(kwh)) return '—';
  if (Math.abs(kwh) >= 1_000_000) return `${(kwh / 1_000_000).toFixed(2)} GWh`;
  if (Math.abs(kwh) >= 1000) return `${(kwh / 1000).toFixed(2)} MWh`;
  return `${kwh.toFixed(1)} kWh`;
}

export function fmtCapacity(kw?: number): string {
  if (kw == null || Number.isNaN(kw)) return '—';
  return `${kw.toFixed(2)} kWp`;
}

/** Portfolio-scale capacity: thousands-separated kWp, or MWp for large fleets. */
export function fmtCapacityBig(kw?: number): string {
  if (kw == null || Number.isNaN(kw)) return '—';
  if (kw >= 10_000) return `${(kw / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} MWp`;
  return `${Math.round(kw).toLocaleString()} kWp`;
}

export function fmtPct(v?: number): string {
  return v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`;
}

export function fmtTime(epochSec?: number): string {
  if (!epochSec) return '—';
  const d = new Date(epochSec * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function fmtClock(epochSec?: number): string {
  if (!epochSec) return '';
  const d = new Date(epochSec * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Relative "3 min ago" from an epoch-seconds timestamp (for last-comm columns). */
export function fmtAgo(epochSec?: number): string {
  if (!epochSec) return '—';
  const sec = Math.floor(Date.now() / 1000 - epochSec);
  if (sec < 0) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

/** "+59.04" style signed delta. */
export function fmtDelta(v?: number): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

export const STATUS_META: Record<StationStatus, { cls: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  online: { cls: 'ok', label: 'Online', tone: 'ok' },
  waiting: { cls: 'mid', label: 'Waiting', tone: 'muted' },
  partial: { cls: 'mid', label: 'Partial', tone: 'warn' },
  offline: { cls: 'flag', label: 'Offline', tone: 'bad' },
  unknown: { cls: 'muted', label: 'Unknown', tone: 'muted' },
};

/** Status chips render in this order, skipping any status with no stations. */
export const STATUS_ORDER: StationStatus[] = ['online', 'waiting', 'partial', 'offline', 'unknown'];

/** Normalise a platform colour (may lack '#') or fall back to a palette hue. */
export function chartColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  return c.startsWith('#') || c.startsWith('rgb') ? c : `#${c}`;
}

/** Round a raw step up to a tidy 1/2/5 × 10^n value for axis ticks. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

export const CHART_PALETTE = ['#f5a623', '#8b5cf6', '#38bdf8', '#10b981', '#ec4899', '#f97316'];
