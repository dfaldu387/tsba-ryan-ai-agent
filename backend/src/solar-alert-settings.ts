import { UserError } from './errors.js';
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
  // Two scans at the default 15-min interval: a fix must hold before we say so.
  recoveryConfirmMin: 30,
  quietNight: true,
  // Fleet is AU-heavy; default the sunset reference to Sydney.
  lat: -33.8688,
  lng: 151.2093,
  admin: { recipients: ['dfaldu387@gmail.com'], delayMin: 0 },
  customer: { enabled: false, delayMin: 60 },
  includeSolution: true,
  attachResolution: false,
  resolutionRules: [],
  // One combined alert email per hour (Sydney time) instead of a stream of per-plant
  // emails. It is sent only when something new or resolved needs reporting.
  // Turn `enabled` off to restore the legacy per-plant flow.
  schedule: {
    enabled: true,
    intervalHours: 1,
    sendFromHour: 9,
    sendUntilHour: 18,
    times: [],
    timezone: 'Australia/Sydney',
    maxPerDay: 24,
    instant: false,
  },
  // One follow-up a day for anything still open and unacknowledged, at most 3,
  // so an open fault is never silently forgotten but never spams either.
  reminders: {
    enabled: true,
    intervalMin: 1440,
    maxCount: 3,
    escalation: { enabled: false, afterReminders: 2, recipients: [] },
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
    recoveryConfirmMin: stored.recoveryConfirmMin ?? d.recoveryConfirmMin,
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
      intervalHours: stored.schedule?.intervalHours ?? d.schedule.intervalHours,
      sendFromHour: stored.schedule?.sendFromHour ?? d.schedule.sendFromHour,
      sendUntilHour: stored.schedule?.sendUntilHour ?? d.schedule.sendUntilHour,
      times: stored.schedule?.times ?? d.schedule.times,
      timezone: stored.schedule?.timezone ?? d.schedule.timezone,
      maxPerDay: stored.schedule?.maxPerDay ?? d.schedule.maxPerDay,
      instant: stored.schedule?.instant ?? d.schedule.instant,
    },
    reminders: {
      enabled: stored.reminders?.enabled ?? d.reminders.enabled,
      intervalMin: stored.reminders?.intervalMin ?? d.reminders.intervalMin,
      maxCount: stored.reminders?.maxCount ?? d.reminders.maxCount,
      escalation: {
        enabled: stored.reminders?.escalation?.enabled ?? d.reminders.escalation.enabled,
        afterReminders: stored.reminders?.escalation?.afterReminders ?? d.reminders.escalation.afterReminders,
        recipients: stored.reminders?.escalation?.recipients ?? d.reminders.escalation.recipients,
      },
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
    recoveryConfirmMin: patch.recoveryConfirmMin != null
      ? clampInt(patch.recoveryConfirmMin, 0, 720, current.recoveryConfirmMin)
      : current.recoveryConfirmMin,
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
    reminders: patch.reminders != null ? normaliseReminders(patch.reminders, current.reminders) : current.reminders,
    updatedAt: new Date().toISOString(),
  };

  if (!Number.isFinite(next.lat) || next.lat < -90 || next.lat > 90) throw new UserError('Latitude must be between -90 and 90.');
  if (!Number.isFinite(next.lng) || next.lng < -180 || next.lng > 180) throw new UserError('Longitude must be between -180 and 180.');
  if (next.enabled && next.admin.recipients.length === 0) {
    throw new UserError('Add at least one admin recipient email, or turn alerts off.');
  }
  if (next.reminders.escalation.enabled && next.reminders.escalation.recipients.length === 0) {
    throw new UserError('Add at least one escalation recipient, or turn escalation off.');
  }

  if (env.storage === 'postgres') await setSetting(KEY, next);
  else memRow = next;
  return next;
}

/** Validate + clean resolution rules; drops rows without a document. */
function normaliseRules(list: unknown): import('@tsba/shared').AlertResolutionRule[] {
  if (!Array.isArray(list)) throw new UserError('Resolution rules must be a list.');
  const out: import('@tsba/shared').AlertResolutionRule[] = [];
  for (const raw of list) {
    const r = raw as Partial<import('@tsba/shared').AlertResolutionRule>;
    const documentId = String(r?.documentId ?? '').trim();
    if (!documentId) continue; // a rule with no document does nothing
    const keywords = String(r?.keywords ?? '').trim();
    if (!keywords) throw new UserError('Each resolution rule needs at least one keyword.');
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
  const intervalHours = patch.intervalHours != null
    ? clampInt(patch.intervalHours, 1, 24, current.intervalHours)
    : current.intervalHours;
  const sendFromHour = patch.sendFromHour != null
    ? clampInt(patch.sendFromHour, 0, 23, current.sendFromHour)
    : current.sendFromHour;
  const sendUntilHour = patch.sendUntilHour != null
    ? clampInt(patch.sendUntilHour, 1, 24, current.sendUntilHour)
    : current.sendUntilHour;
  if (sendUntilHour <= sendFromHour) {
    throw new UserError('The send window must end after it starts (e.g. 09:00 to 18:00).');
  }

  let times = current.times;
  if (patch.times != null) {
    if (!Array.isArray(patch.times)) throw new UserError('Send times must be a list of "HH:MM" values.');
    const seen = new Set<string>();
    times = [];
    for (const raw of patch.times) {
      const t = String(raw).trim();
      if (!t) continue;
      const m = TIME_RE.exec(t);
      if (!m) throw new UserError(`"${raw}" is not a valid 24-hour time (use HH:MM, e.g. 09:00 or 17:30).`);
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
      throw new UserError(`"${patch.timezone}" is not a valid IANA timezone (e.g. Australia/Sydney).`);
    }
  }

  const maxPerDay = patch.maxPerDay != null ? clampInt(patch.maxPerDay, 1, 48, current.maxPerDay) : current.maxPerDay;
  const instant = patch.instant ?? current.instant;
  return { enabled, intervalHours, sendFromHour, sendUntilHour, times, timezone, maxPerDay, instant: Boolean(instant) };
}

/** Validate + normalise the reminder/escalation config, merging over the current one. */
function normaliseReminders(
  patch: Partial<import('@tsba/shared').AlertReminderConfig>,
  current: import('@tsba/shared').AlertReminderConfig,
): import('@tsba/shared').AlertReminderConfig {
  const esc: Partial<import('@tsba/shared').AlertReminderConfig['escalation']> = patch.escalation ?? {};
  return {
    enabled: Boolean(patch.enabled ?? current.enabled),
    // 15 min floor (below the scan interval it means "every scan" = spam); 7 days ceiling.
    intervalMin: patch.intervalMin != null ? clampInt(patch.intervalMin, 15, 10080, current.intervalMin) : current.intervalMin,
    maxCount: patch.maxCount != null ? clampInt(patch.maxCount, 0, 100, current.maxCount) : current.maxCount,
    escalation: {
      enabled: Boolean(esc.enabled ?? current.escalation.enabled),
      afterReminders: esc.afterReminders != null ? clampInt(esc.afterReminders, 1, 100, current.escalation.afterReminders) : current.escalation.afterReminders,
      recipients: esc.recipients != null ? normaliseRecipients(esc.recipients) : current.escalation.recipients,
    },
  };
}

/** Trim, de-dupe and validate a recipients list; throws on a malformed address. */
function normaliseRecipients(list: unknown): string[] {
  if (!Array.isArray(list)) throw new UserError('Recipients must be a list of email addresses.');
  const out: string[] = [];
  for (const raw of list) {
    const email = String(raw).trim().toLowerCase();
    if (!email) continue;
    if (!EMAIL_RE.test(email)) throw new UserError(`"${raw}" is not a valid email address.`);
    if (!out.includes(email)) out.push(email);
  }
  return out;
}
