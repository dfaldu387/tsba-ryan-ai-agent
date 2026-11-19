import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';
import type { SolarAlertSeverity } from './providers/types.js';

/**
 * Resolved-issue log: every alert the monitor saw clear (and stay clear for the
 * confirmation window) is recorded here with when it opened, when it resolved
 * and whether the team was emailed about it — so the console can show what was
 * fixed, not just what is open. Stored as one bounded JSON document in
 * app_settings (in-process in 'memory' storage mode).
 */

export interface ResolvedAlertRecord {
  id: string;
  provider: string;
  plantId: string;
  plant: string;
  severity: SolarAlertSeverity;
  title: string;
  detail?: string;
  deviceSn?: string;
  /** When the monitor first saw the issue (ms). */
  openedAt: number;
  /** When it was first seen cleared (ms) — the resolution time. */
  resolvedAt: number;
  /** When the clearance was confirmed (stayed clear for the window), ms. */
  confirmedAt: number;
  /** Was an alert email sent for this issue while it was open? */
  alerted: boolean;
  /** When the "resolved" email went out (ms), if it did. */
  recoveryEmailedAt?: number;
}

const KEY = 'solar_alert_history';
const KEEP_MS = 30 * 24 * 3_600_000;
const MAX_RECORDS = 1500;

let mem: ResolvedAlertRecord[] = [];
let chain: Promise<unknown> = Promise.resolve();

async function load(): Promise<ResolvedAlertRecord[]> {
  if (env.storage !== 'postgres') return mem;
  return (await getSetting<ResolvedAlertRecord[]>(KEY)) ?? [];
}

async function save(list: ResolvedAlertRecord[]): Promise<void> {
  if (env.storage === 'postgres') await setSetting(KEY, list);
  else mem = list;
}

/** Serialised read-modify-write, so the monitor and API never lose an update. */
function mutate(fn: (list: ResolvedAlertRecord[]) => ResolvedAlertRecord[]): Promise<void> {
  const run = chain.then(async () => {
    const now = Date.now();
    const next = fn(await load())
      .filter((r) => now - r.confirmedAt < KEEP_MS)
      .sort((a, b) => b.resolvedAt - a.resolvedAt)
      .slice(0, MAX_RECORDS);
    await save(next);
  });
  chain = run.catch(() => {});
  return run;
}

/** Record newly confirmed resolutions. */
export function recordResolved(records: ResolvedAlertRecord[]): Promise<void> {
  if (!records.length) return Promise.resolve();
  return mutate((list) => [...records, ...list]);
}

/** Stamp the "resolved" email time on records (by alert id + resolvedAt). */
export function markRecoveryEmailed(items: { id: string; resolvedAt: number }[], at: number): Promise<void> {
  if (!items.length) return Promise.resolve();
  const keys = new Set(items.map((i) => `${i.id}@${i.resolvedAt}`));
  return mutate((list) => list.map((r) => (keys.has(`${r.id}@${r.resolvedAt}`) ? { ...r, recoveryEmailedAt: at } : r)));
}

/** Resolved issues within the last `days` days, newest first. */
export async function listResolved(days = 7): Promise<ResolvedAlertRecord[]> {
  await chain; // include writes still in flight
  const since = Date.now() - days * 24 * 3_600_000;
  return (await load()).filter((r) => r.resolvedAt >= since);
}
