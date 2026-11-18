import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';

/**
 * Shared alert triage state — acknowledge / snooze / assign — keyed by the
 * console's alert-group key (`provider:plantId:fault`). It used to live only in
 * each browser's localStorage, so one admin acknowledging a fault left it open
 * for everyone else. Stored in app_settings (one small JSON document); in
 * 'memory' storage mode it is held in-process.
 *
 * Read/unread ("seen") stays per person in the browser — that's personal, not
 * team state.
 */

export interface TriageEntry {
  /** Acknowledged at (ms). */
  ack?: number;
  ackBy?: string;
  /** Snoozed until (ms). */
  snoozeUntil?: number;
  snoozedBy?: string;
  assignee?: string;
  updatedAt: number;
}
export type TriageMap = Record<string, TriageEntry>;
export type TriagePatch = Partial<Pick<TriageEntry, 'ack' | 'snoozeUntil' | 'assignee'>>;

const KEY = 'solar_alert_triage';
// Entries untouched this long (and not snoozed into the future) are dropped, so
// the document doesn't grow forever with faults that cleared months ago.
const PRUNE_AFTER_MS = 30 * 24 * 3_600_000;

let mem: TriageMap = {};
// Serialise read-modify-write so two quick clicks can't lose an update.
let chain: Promise<unknown> = Promise.resolve();

export async function getTriage(): Promise<TriageMap> {
  if (env.storage !== 'postgres') return mem;
  return (await getSetting<TriageMap>(KEY)) ?? {};
}

function prune(map: TriageMap, now: number): TriageMap {
  const out: TriageMap = {};
  for (const [k, e] of Object.entries(map)) {
    if (now - e.updatedAt < PRUNE_AFTER_MS || (e.snoozeUntil ?? 0) > now) out[k] = e;
  }
  return out;
}

/**
 * Apply one patch to several group keys (`null` clears them). A field set to
 * `undefined`/`null` in the patch is removed. Returns the full updated map.
 */
export function patchTriage(keys: string[], patch: TriagePatch | null, by: string): Promise<TriageMap> {
  const run = chain.then(async () => {
    const now = Date.now();
    const map = prune(await getTriage(), now);
    for (const key of keys) {
      if (patch === null) {
        delete map[key];
        continue;
      }
      const next: TriageEntry = { ...map[key], updatedAt: now };
      if ('ack' in patch) {
        if (patch.ack) {
          next.ack = patch.ack;
          next.ackBy = by;
        } else {
          delete next.ack;
          delete next.ackBy;
        }
      }
      if ('snoozeUntil' in patch) {
        if (patch.snoozeUntil) {
          next.snoozeUntil = patch.snoozeUntil;
          next.snoozedBy = by;
        } else {
          delete next.snoozeUntil;
          delete next.snoozedBy;
        }
      }
      if ('assignee' in patch) {
        if (patch.assignee) next.assignee = patch.assignee;
        else delete next.assignee;
      }
      map[key] = next;
    }
    if (env.storage === 'postgres') await setSetting(KEY, map);
    else mem = map;
    return map;
  });
  chain = run.catch(() => {});
  return run;
}
