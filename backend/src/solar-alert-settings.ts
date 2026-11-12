import type { SolarAlertSettings } from '@tsba/shared';
import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';

/**
 * Source of truth for the solar alert-monitor configuration. Stored in the DB
 * (key 'solar_alerts') and edited in the admin UI; the monitor reads it live on
 * every scan, so changes take effect without a restart. In 'memory' storage
 * mode it is held in-process (lost on restart), which matches how the rest of
 * the app behaves without a database.
 */

const KEY = 'solar_alerts';

export const DEFAULT_ALERT_SETTINGS: SolarAlertSettings = {
  enabled: true,
  intervalMin: 15,
  recovery: true,
  quietNight: true,
  // Fleet is AU-heavy; default the sunset reference to Sydney.
  lat: -33.8688,
  lng: 151.2093,
  admin: { recipients: ['dfaldu387@gmail.com'], delayMin: 0 },
  customer: { enabled: false, delayMin: 60 },
  includeSolution: true,
  attachResolution: false,
  resolutionRules: [],
  // Batch alerts into two combined digests a day (Sydney time) by default, so the
  // admin inbox gets one summary email at ~9am and ~5pm instead of a stream of
  // one-per-plant alerts. Turn `enabled` off to restore the legacy per-plant flow.
  schedule: {
    enabled: true,
    times: ['09:00', '17:00'],
    timezone: 'Australia/Sydney',
    maxPerDay: 4,
  },
};

// In-memory fallback for STORAGE=memory (no database).
let memRow: SolarAlertSettings | null = null;

/** Deep-merge a stored (possibly partial / older-shape) row over the defaults. */
function withDefaults(stored: Partial<SolarAlertSettings> | null): SolarAlertSettings {
  const d = DEFAULT_ALERT_SETTINGS;
  if (!stored) return structuredClone(d);
  return {
    enabled: stored.enabled ?? d.enabled,
    intervalMin: stored.intervalMin ?? d.intervalMin,
    recovery: stored.recovery ?? d.recovery,
    quietNight: stored.quietNight ?? d.quietNight,
    lat: stored.lat ?? d.lat,
    lng: stored.lng ?? d.lng,
    admin: {
      recipients: stored.admin?.recipients ?? d.admin.recipients,
      delayMin: stored.admin?.delayMin ?? d.admin.delayMin,
    },
    customer: {
      enabled: stored.customer?.enabled ?? d.customer.enabled,
      delayMin: stored.customer?.delayMin ?? d.customer.delayMin,
    },
    includeSolution: stored.includeSolution ?? d.includeSolution,
    attachResolution: stored.attachResolution ?? d.attachResolution,
    resolutionRules: stored.resolutionRules ?? d.resolutionRules,
    schedule: {
      enabled: stored.schedule?.enabled ?? d.schedule.enabled,
      times: stored.schedule?.times ?? d.schedule.times,
      timezone: stored.schedule?.timezone ?? d.schedule.timezone,
      maxPerDay: stored.schedule?.maxPerDay ?? d.schedule.maxPerDay,
    },
    updatedAt: stored.updatedAt,
  };
}

/** Read the current settings, filling any missing fields with defaults. */
export async function getAlertSettings(): Promise<SolarAlertSettings> {
  if (env.storage === 'postgres') {
    return withDefaults(await getSetting<SolarAlertSettings>(KEY));
  }
  return withDefaults(memRow);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Validate + normalise an incoming (partial) settings patch, merge it over the
 * current settings, persist it, and return the saved result. Throws Error with a
 * human-readable message on invalid input so the route can return 400.
 */
export async function saveAlertSettings(patch: Partial<SolarAlertSettings>): Promise<SolarAlertSettings> {
  const current = await getAlertSettings();
  const next: SolarAlertSettings = {
    enabled: patch.enabled ?? current.enabled,
    intervalMin: patch.intervalMin != null ? clampInt(patch.intervalMin, 1, 1440, current.intervalMin) : current.intervalMin,
    recovery: patch.recovery ?? current.recovery,
    quietNight: patch.quietNight ?? current.quietNight,
    lat: patch.lat != null ? Number(patch.lat) : current.lat,
    lng: patch.lng != null ? Number(patch.lng) : current.lng,
    admin: {
      recipients: patch.admin?.recipients != null
        ? normaliseRecipients(patch.admin.recipients)
        : current.admin.recipients,
      delayMin: patch.admin?.delayMin != null ? clampInt(patch.admin.delayMin, 0, 1440, current.admin.delayMin) : current.admin.delayMin,
    },
    customer: {
      enabled: patch.customer?.enabled ?? current.customer.enabled,
      delayMin: patch.customer?.delayMin != null ? clampInt(patch.customer.delayMin, 0, 1440, current.customer.delayMin) : current.customer.delayMin,
    },
    includeSolution: patch.includeSolution ?? current.includeSolution,
    attachResolution: patch.attachResolution ?? current.attachResolution,
    resolutionRules: patch.resolutionRules != null ? normaliseRules(patch.resolutionRules) : current.resolutionRules,
    schedule: patch.schedule != null ? normaliseSchedule(patch.schedule, current.schedule) : current.schedule,
    updatedAt: new Date().toISOString(),
  };

  if (!Number.isFinite(next.lat) || next.lat < -90 || next.lat > 90) throw new Error('Latitude must be between -90 and 90.');
  if (!Number.isFinite(next.lng) || next.lng < -180 || next.lng > 180) throw new Error('Longitude must be between -180 and 180.');
  if (next.enabled && next.admin.recipients.length === 0) {
    throw new Error('Add at least one admin recipient email, or turn alerts off.');
  }
  if (next.schedule.enabled && next.schedule.times.length === 0) {
    throw new Error('Add at least one send time, or turn scheduled digests off.');
  }

  if (env.storage === 'postgres') await setSetting(KEY, next);
  else memRow = next;
  return next;
}

/** Validate + clean resolution rules; drops rows without a document. */
function normaliseRules(list: unknown): import('@tsba/shared').AlertResolutionRule[] {
  if (!Array.isArray(list)) throw new Error('Resolution rules must be a list.');
  const out: import('@tsba/shared').AlertResolutionRule[] = [];
  for (const raw of list) {
    const r = raw as Partial<import('@tsba/shared').AlertResolutionRule>;
    const documentId = String(r?.documentId ?? '').trim();
    if (!documentId) continue; // a rule with no document does nothing
    const keywords = String(r?.keywords ?? '').trim();
    if (!keywords) throw new Error('Each resolution rule needs at least one keyword.');
    out.push({ keywords, documentId, documentTitle: String(r?.documentTitle ?? '').trim() });
  }
  return out;
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Validate + normalise the scheduled-digest config, merging over the current one. */
function normaliseSchedule(
  patch: Partial<import('@tsba/shared').AlertScheduleConfig>,
  current: import('@tsba/shared').AlertScheduleConfig,
): import('@tsba/shared').AlertScheduleConfig {
  const enabled = patch.enabled ?? current.enabled;

  let times = current.times;
  if (patch.times != null) {
    if (!Array.isArray(patch.times)) throw new Error('Send times must be a list of "HH:MM" values.');
    const seen = new Set<string>();
    times = [];
    for (const raw of patch.times) {
      const t = String(raw).trim();
      if (!t) continue;
      const m = TIME_RE.exec(t);
      if (!m) throw new Error(`"${raw}" is not a valid 24-hour time (use HH:MM, e.g. 09:00 or 17:30).`);
      const norm = `${m[1].padStart(2, '0')}:${m[2]}`; // zero-pad the hour
      if (!seen.has(norm)) {
        seen.add(norm);
        times.push(norm);
      }
    }
    times.sort(); // chronological, since "HH:MM" sorts lexically
  }

  let timezone = current.timezone;
  if (patch.timezone != null) {
    const tz = String(patch.timezone).trim();
    try {
      // Throws RangeError for an unknown IANA zone.
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      timezone = tz;
    } catch {
      throw new Error(`"${patch.timezone}" is not a valid IANA timezone (e.g. Australia/Sydney).`);
    }
  }

  const maxPerDay = patch.maxPerDay != null ? clampInt(patch.maxPerDay, 1, 48, current.maxPerDay) : current.maxPerDay;
  return { enabled, times, timezone, maxPerDay };
}

/** Trim, de-dupe and validate a recipients list; throws on a malformed address. */
function normaliseRecipients(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('Recipients must be a list of email addresses.');
  const out: string[] = [];
  for (const raw of list) {
    const email = String(raw).trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) throw new Error(`"${raw}" is not a valid email address.`);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}
