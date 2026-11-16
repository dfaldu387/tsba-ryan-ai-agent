// Alert triage model. The backend returns one row per raw alert (thousands, with
// heavy repetition). The console groups them by plant + fault, and separates
// SEVERITY (how urgent) from CATEGORY (what kind of problem).
import type { SolarMonitorAlert } from '../api';

export type Severity = 'critical' | 'warning' | 'info';
export type Category = 'offline' | 'partial' | 'grid' | 'battery' | 'isolation' | 'comms' | 'device';

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
export const CATEGORY_LABEL: Record<Category, string> = {
  offline: 'Offline',
  partial: 'Partial',
  grid: 'Grid fault',
  battery: 'Battery / BMS',
  isolation: 'Isolation / leakage',
  comms: 'Communication',
  device: 'Inverter fault',
};
export const CATEGORIES: Category[] = ['offline', 'partial', 'grid', 'battery', 'isolation', 'comms', 'device'];

/** Raw alert as delivered (backend also passes solution/status through). */
export type RawAlert = SolarMonitorAlert & { solution?: string; status?: string };

export interface AlertGroup {
  key: string; // provider:plantId:faultKey
  provider: string;
  plantId: string;
  plant: string;
  fault: string; // human fault name, plant/serial stripped
  code?: string;
  severity: Severity;
  category: Category;
  count: number;
  devices: string[];
  firstSeen: number | null; // ms
  lastSeen: number | null; // ms
  detail?: string;
  solution?: string;
  providerStatus?: string;
  items: RawAlert[];
}

const RX = {
  isolation: /isolat|insulat|leak|gfci|residual|riso|earth fault|ground fault|pv.?iso/i,
  battery: /batt|bms|soc\b|cell|lithium|bat\b/i,
  grid: /grid|mains|voltage|frequency|freq|over.?volt|under.?volt|islanding|ac side|no.?utility|meter/i,
  comms: /comm|wifi|wi-fi|lan|gprs|dongle|logger|datalogger|offline|lost|timeout|signal|not communicating/i,
};

export function classify(a: RawAlert): { severity: Severity; category: Category } {
  if (a.severity === 'offline') return { severity: 'critical', category: 'offline' };
  if (a.severity === 'partial') return { severity: 'warning', category: 'partial' };
  if (a.severity === 'device') return { severity: 'warning', category: 'comms' };
  const text = `${a.title} ${a.detail ?? ''}`;
  if (RX.isolation.test(text)) return { severity: 'critical', category: 'isolation' };
  if (RX.battery.test(text)) return { severity: 'warning', category: 'battery' };
  if (RX.grid.test(text)) return { severity: 'warning', category: 'grid' };
  if (RX.comms.test(text)) return { severity: 'info', category: 'comms' };
  return { severity: a.severity === 'fault' ? 'critical' : 'warning', category: 'device' };
}

/** Fault name without the plant suffix / serial so repeats group together. */
export function faultName(a: RawAlert): string {
  if (a.severity === 'offline') return 'Plant offline';
  if (a.severity === 'partial') return 'Partial / fault state';
  if (a.severity === 'device') return 'Device not communicating';
  let t = a.title;
  const dash = t.lastIndexOf(' — ');
  if (dash > 0) t = t.slice(0, dash);
  if (a.deviceSn) t = t.replace(` (${a.deviceSn})`, '');
  return t.trim() || 'Fault';
}

export function faultCode(a: RawAlert): string | undefined {
  const m = /Fault code ([^·]+)/.exec(a.detail ?? '');
  return m ? m[1].trim() : undefined;
}

const toMs = (t?: number) => (t ? (t < 1e12 ? t * 1000 : t) : null);

export function groupAlerts(alerts: RawAlert[]): AlertGroup[] {
  const map = new Map<string, AlertGroup>();
  for (const a of alerts) {
    const fault = faultName(a);
    const key = `${a.provider}:${a.plantId}:${fault.toLowerCase()}`;
    const { severity, category } = classify(a);
    const at = toMs(a.at);
    let g = map.get(key);
    if (!g) {
      g = {
        key, provider: a.provider, plantId: a.plantId, plant: a.plant, fault, code: faultCode(a),
        severity, category, count: 0, devices: [], firstSeen: at, lastSeen: at,
        detail: a.detail, solution: a.solution, providerStatus: a.status, items: [],
      };
      map.set(key, g);
    }
    g.count += 1;
    g.items.push(a);
    if (a.deviceSn && !g.devices.includes(a.deviceSn)) g.devices.push(a.deviceSn);
    if (at != null) {
      g.firstSeen = g.firstSeen == null ? at : Math.min(g.firstSeen, at);
      g.lastSeen = g.lastSeen == null ? at : Math.max(g.lastSeen, at);
    }
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[g.severity]) g.severity = severity;
    if (!g.solution && a.solution) g.solution = a.solution;
    if (!g.code) g.code = faultCode(a);
  }
  return [...map.values()].sort(
    (x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.count - x.count || x.plant.localeCompare(y.plant),
  );
}

// ─── Triage state (acknowledge / assign / snooze) ───────────────────────────
// Stored per browser until a backend triage store exists. Keyed by group key.
export interface TriageState {
  ack?: number; // ms acknowledged
  assignee?: string;
  snoozeUntil?: number; // ms
}
const TRIAGE_KEY = 'tsba.alerts.triage.v1';

export function loadTriage(): Record<string, TriageState> {
  try {
    const raw = localStorage.getItem(TRIAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
export function saveTriage(t: Record<string, TriageState>): void {
  try {
    localStorage.setItem(TRIAGE_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}
export function isSnoozed(t: TriageState | undefined, now = Date.now()): boolean {
  return Boolean(t?.snoozeUntil && t.snoozeUntil > now);
}
