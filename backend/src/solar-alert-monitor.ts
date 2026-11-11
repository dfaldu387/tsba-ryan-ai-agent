import type { SolarAlertSettings } from '@tsba/shared';
import { getProvider, aggregateStations } from './providers/index.js';
import { getSolarAlerts } from './solar-alerts.js';
import { sendMail, GmailAuthError } from './google-gmail.js';
import { isNight } from './sun.js';
import { getAlertSettings } from './solar-alert-settings.js';
import { resolveAttachment, resolveSolution } from './solar-alert-resolution.js';
import type { SolarMonitorAlert, StationInfoItem } from './providers/types.js';

/**
 * Background solar-alert monitor.
 *
 * Every `intervalMin` (from the DB-backed settings) it scans the fleet — the
 * same cached health scan the header panel uses — and emails the configured
 * admin recipients about issues: a plant offline/partial, an inverter (or other
 * device) offline, or a provider-reported fault. It de-dupes by the alert's
 * stable id, so an ongoing issue is emailed once, not every scan, and once the
 * issue clears a short recovery note is sent (when `recovery` is on).
 *
 * Timing: an issue is only emailed once it has persisted at least `admin.delayMin`
 * minutes (a debounce that swallows brief blips). Customer alerts have their own
 * `customer.delayMin`; customer delivery itself is not wired yet (addresses are
 * added later), so enabling it currently just records that the threshold passed.
 *
 * Quiet hours are sunset-based: while it is night at the configured fleet
 * location no email is sent; anything still unresolved at sunrise is emailed
 * then as a morning catch-up, and an issue that appears and clears overnight is
 * dropped silently.
 *
 * All configuration is read live from the DB on every scan, so admin edits take
 * effect without a restart. State is in-memory: after a restart the first scan
 * treats currently-open issues as new (they are genuinely active).
 */

interface Tracked {
  alert: SolarMonitorAlert; // most recent snapshot of this issue
  firstSeen: number; // epoch ms first observed (debounce baseline)
  adminNotified: boolean;
  customerNotified: boolean;
}

// Currently-open issues, keyed by alert id.
const active = new Map<string, Tracked>();
// Issues that were alerted to admins and have since cleared, owed a recovery
// email that was deferred (night) — flushed at sunrise.
const recoveredPending = new Map<string, SolarMonitorAlert>();

let timer: NodeJS.Timeout | null = null;
let running = false;
let started = false;

const plantKey = (a: SolarMonitorAlert): string => `${a.provider}:${a.plantId}`;
const ageMin = (t: Tracked): number => (Date.now() - t.firstSeen) / 60_000;

function isOwnerLabel(label: string): boolean {
  return /owner|contact|email|phone|installer|customer/i.test(label);
}

async function plantInfo(a: SolarMonitorAlert): Promise<StationInfoItem[]> {
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '' && !info.some((x) => x.label === label)) info.push({ label, value: String(v) });
  };

  // Admin-maintained contact store FIRST, so it takes precedence and fills what
  // the platform API doesn't expose (e.g. Deye returns a null owner for many plants).
  try {
    const { getPlantContact } = await import('./plant-contacts.js');
    const c = await getPlantContact(a.provider, a.plantId);
    if (c) {
      push('Owner', c.name);
      push('Owner email', c.email);
      push('Owner phone', c.phone);
      push('Owner notes', c.notes);
    }
  } catch {
    /* store unavailable — platform data below still fills in */
  }

  // Primary source: the fleet overview, which is cheap, cached and reliable even
  // for offline plants (the per-plant detail call can be empty/rate-limited).
  try {
    const { stations } = await aggregateStations();
    const s = stations.find((x) => x.provider === a.provider && x.id === a.plantId);
    if (s) {
      push('Status', s.status);
      push('Owner', s.owner);
      push('Contact', s.contact);
      push('Location', s.location);
      push('Installed capacity', s.capacityKw != null ? `${s.capacityKw} kWp` : undefined);
      push('Battery SOC', s.batterySoc != null ? `${s.batterySoc}%` : undefined);
    }
  } catch {
    /* overview unavailable — fall through to detail */
  }

  // Bonus: richer attributes from the provider detail (owner, dates, grid type,
  // …) for platforms that expose them — appended without overwriting the above.
  const provider = getProvider(a.provider);
  if (provider) {
    try {
      const detail = await provider.stationDetail(a.plantId);
      for (const item of detail.info ?? []) push(item.label, item.value);
    } catch {
      /* detail failed — the overview fields above still carry the essentials */
    }
  }
  return info;
}

function providerName(id: string): string {
  return getProvider(id)?.name ?? id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildAlertEmail(
  plant: SolarMonitorAlert,
  issues: SolarMonitorAlert[],
  info: StationInfoItem[],
  solution?: string | null,
): { subject: string; text: string; html: string } {
  const owner = info.filter((i) => isOwnerLabel(i.label));
  const details = info.filter((i) => !isOwnerLabel(i.label));
  const worst = issues[0]; // alerts arrive most-severe first
  const subject = `[Solar Alert] ${plant.plant} — ${worst.title}`;

  const issueLines = issues.map((i) => `  • ${i.title}${i.detail ? ` — ${i.detail}` : ''}`);
  const ownerLines = owner.length
    ? owner.map((i) => `  ${i.label}: ${i.value}`)
    : ['  (no owner/contact details available from the provider)'];
  const detailLines = details.map((i) => `  ${i.label}: ${i.value}`);

  const text = [
    `A monitoring issue was detected on "${plant.plant}".`,
    '',
    `Platform : ${providerName(plant.provider)}`,
    `Plant    : ${plant.plant}`,
    '',
    'Issue(s):',
    ...issueLines,
    ...(solution ? ['', 'Suggested solution:', solution] : []),
    '',
    'Plant owner / contact:',
    ...ownerLines,
    ...(detailLines.length ? ['', 'Plant details:', ...detailLines] : []),
    '',
    `Detected at ${new Date().toUTCString()}.`,
    'This is an automated alert from the TSBA solar monitoring system.',
  ].join('\n');

  const row = (label: string, value: string) =>
    `<tr><td style="padding:3px 12px 3px 0;color:#64748b;white-space:nowrap;vertical-align:top">${escapeHtml(
      label,
    )}</td><td style="padding:3px 0;color:#0f172a">${escapeHtml(value)}</td></tr>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:620px;color:#0f172a">
  <div style="background:#b91c1c;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:16px;font-weight:600">
    ⚠ Solar monitoring alert
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:18px">
    <p style="margin:0 0 14px">A monitoring issue was detected on <strong>${escapeHtml(
      plant.plant,
    )}</strong> (${escapeHtml(providerName(plant.provider))}).</p>
    <h3 style="margin:0 0 6px;font-size:14px">Issue(s)</h3>
    <ul style="margin:0 0 16px;padding-left:20px">
      ${issues
        .map(
          (i) =>
            `<li style="margin-bottom:4px"><strong>${escapeHtml(i.title)}</strong>${
              i.detail ? ` — ${escapeHtml(i.detail)}` : ''
            }</li>`,
        )
        .join('\n      ')}
    </ul>
    ${
      solution
        ? `<h3 style="margin:0 0 6px;font-size:14px">Suggested solution</h3>
    <div style="white-space:pre-wrap;background:#f0f9f4;border:1px solid #cdebd9;border-radius:8px;padding:12px 14px;margin-bottom:16px;font-size:13.5px;line-height:1.55">${escapeHtml(
      solution,
    )}</div>`
        : ''
    }
    <h3 style="margin:0 0 6px;font-size:14px">Plant owner / contact</h3>
    <table style="border-collapse:collapse;font-size:13px;margin-bottom:16px">${
      owner.length
        ? owner.map((i) => row(i.label, i.value)).join('')
        : '<tr><td style="color:#94a3b8;font-style:italic">No owner/contact details available from the provider.</td></tr>'
    }</table>
    ${
      details.length
        ? `<h3 style="margin:0 0 6px;font-size:14px">Plant details</h3>
    <table style="border-collapse:collapse;font-size:13px;margin-bottom:16px">${details
      .map((i) => row(i.label, i.value))
      .join('')}</table>`
        : ''
    }
    <p style="margin:0;color:#94a3b8;font-size:12px">Detected at ${escapeHtml(
      new Date().toUTCString(),
    )} · Automated alert from the TSBA solar monitoring system.</p>
  </div>
</div>`;

  return { subject, text, html };
}

function buildRecoveryEmail(
  plant: SolarMonitorAlert,
  cleared: SolarMonitorAlert[],
): { subject: string; text: string; html: string } {
  const subject = `[Solar Recovered] ${plant.plant} — issue resolved`;
  const lines = cleared.map((i) => `  • ${i.title}`);
  const text = [
    `A previously reported issue on "${plant.plant}" (${providerName(plant.provider)}) has cleared:`,
    '',
    ...lines,
    '',
    `Resolved as of ${new Date().toUTCString()}.`,
    'This is an automated recovery notice from the TSBA solar monitoring system.',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:620px;color:#0f172a">
  <div style="background:#15803d;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:16px;font-weight:600">
    ✓ Solar monitoring recovered
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:18px">
    <p style="margin:0 0 12px">A previously reported issue on <strong>${escapeHtml(
      plant.plant,
    )}</strong> (${escapeHtml(providerName(plant.provider))}) has cleared:</p>
    <ul style="margin:0 0 16px;padding-left:20px">
      ${cleared.map((i) => `<li style="margin-bottom:4px">${escapeHtml(i.title)}</li>`).join('\n      ')}
    </ul>
    <p style="margin:0;color:#94a3b8;font-size:12px">Resolved as of ${escapeHtml(
      new Date().toUTCString(),
    )} · Automated notice from the TSBA solar monitoring system.</p>
  </div>
</div>`;
  return { subject, text, html };
}

/** Group alerts by plant (provider:plantId), preserving severity order. */
function groupByPlant(alerts: SolarMonitorAlert[]): Map<string, SolarMonitorAlert[]> {
  const groups = new Map<string, SolarMonitorAlert[]>();
  for (const a of alerts) {
    const key = plantKey(a);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }
  return groups;
}

export interface MonitorRunResult {
  scanned: number;
  active: number;
  newIssues: number;
  cleared: number;
  /** True when it is night at the fallback location (informational). */
  night: boolean;
  /** How many plants had emails held because it is night at THAT plant. */
  deferredPlants: number;
  emailsSent: number;
  recipients: string[];
  reason?: string;
}

/**
 * Run one scan + notification pass. Exported so a route can force a run. Never
 * throws: provider/email failures are logged and reflected in the result.
 */
export async function runAlertMonitorOnce(): Promise<MonitorRunResult> {
  const settings = await getAlertSettings();
  const recipients = settings.admin.recipients;
  const base: MonitorRunResult = {
    scanned: 0,
    active: 0,
    newIssues: 0,
    cleared: 0,
    night: false,
    deferredPlants: 0,
    emailsSent: 0,
    recipients,
  };

  if (!settings.enabled) return { ...base, reason: 'alerts disabled in settings' };

  /**
   * Is it night at a plant's own location? Uses the plant's installation
   * coordinates when the platform exposed them, else the fallback location in
   * settings. Returns false when quiet hours are off.
   */
  const plantNight = (a: SolarMonitorAlert): boolean => {
    if (!settings.quietNight) return false;
    return isNight(a.lat ?? settings.lat, a.lng ?? settings.lng);
  };

  const { alerts, scannedPlants } = await getSolarAlerts();
  base.scanned = scannedPlants;
  const seen = new Set(alerts.map((a) => a.id));

  // Insert/refresh currently-open issues.
  let newIssues = 0;
  for (const a of alerts) {
    const t = active.get(a.id);
    if (t) t.alert = a;
    else {
      active.set(a.id, { alert: a, firstSeen: Date.now(), adminNotified: false, customerNotified: false });
      newIssues++;
    }
  }

  // Detect cleared issues.
  let cleared = 0;
  for (const [id, t] of [...active]) {
    if (!seen.has(id)) {
      active.delete(id);
      cleared++;
      if (t.adminNotified && settings.recovery) recoveredPending.set(id, t.alert);
    }
  }

  base.newIssues = newIssues;
  base.cleared = cleared;
  base.active = active.size;
  base.night = settings.quietNight && isNight(settings.lat, settings.lng);

  let emailsSent = 0;
  let deferredPlants = 0;

  // Customer alerts: delivery not wired yet. Mark the threshold as passed (only
  // in that plant's daytime, so a morning catch-up stays consistent) so we don't
  // repeat this every scan; actual sending is added with per-plant emails.
  if (settings.customer.enabled) {
    for (const t of active.values()) {
      if (!t.customerNotified && ageMin(t) >= settings.customer.delayMin && !plantNight(t.alert)) {
        t.customerNotified = true;
        console.log(`[solar-alert] customer alert threshold reached for ${t.alert.plant} (delivery not wired yet)`);
      }
    }
  }

  // Admin alert emails: open issues past the debounce that haven't been sent,
  // grouped by plant. Each plant's quiet hours are judged at ITS OWN location —
  // a plant in night is held and retried once it's daytime there.
  if (recipients.length) {
    const to = recipients.join(', ');
    const due = [...active.values()].filter((t) => !t.adminNotified && ageMin(t) >= settings.admin.delayMin);
    for (const [, issues] of groupByPlant(due.map((t) => t.alert))) {
      const plant = issues[0];
      if (plantNight(plant)) {
        deferredPlants++;
        continue; // night at this plant — hold until its sunrise
      }
      const info = await plantInfo(plant);
      // Generate a KB-grounded solution + attach a matching guide (both best-effort).
      const [solution, attachment] = await Promise.all([
        resolveSolution(issues, settings),
        resolveAttachment(issues, settings),
      ]);
      const { subject, text, html } = buildAlertEmail(plant, issues, info, solution);
      try {
        await sendMail({ to, subject, text, html, attachments: attachment ? [attachment] : undefined });
        emailsSent++;
        for (const i of issues) {
          const t = active.get(i.id);
          if (t) t.adminNotified = true;
        }
      } catch (err) {
        if (err instanceof GmailAuthError) {
          console.warn('[solar-alert] Gmail not connected — alert emails held:', err.message);
          break;
        }
        console.error(`[solar-alert] failed to email alert for ${plant.plant}:`, (err as Error).message);
      }
    }

    // Recovery emails for cleared, previously-notified issues (same per-plant
    // quiet hours — a recovery that clears overnight is sent in the morning).
    if (recoveredPending.size) {
      for (const [, issues] of groupByPlant([...recoveredPending.values()])) {
        const plant = issues[0];
        if (plantNight(plant)) {
          deferredPlants++;
          continue;
        }
        const { subject, text, html } = buildRecoveryEmail(plant, issues);
        try {
          await sendMail({ to, subject, text, html });
          emailsSent++;
          for (const i of issues) recoveredPending.delete(i.id);
        } catch (err) {
          if (err instanceof GmailAuthError) {
            console.warn('[solar-alert] Gmail not connected — recovery emails held:', err.message);
            break;
          }
          console.error(`[solar-alert] failed to email recovery for ${plant.plant}:`, (err as Error).message);
        }
      }
    }
  }

  base.emailsSent = emailsSent;
  base.deferredPlants = deferredPlants;
  if (deferredPlants) base.reason = `${deferredPlants} plant(s) held — night at their location`;
  return base;
}

/**
 * Send one real alert email on demand, built from an actual current fleet issue
 * (the most severe open one), with real plant/owner details and the matching
 * resolution attachment — WITHOUT touching the de-dupe state. For previewing the
 * real alert format. Subject is prefixed [TEST] so it's distinguishable.
 */
export async function sendSampleAlert(): Promise<{
  sent: boolean;
  plant?: string;
  issues?: number;
  attached?: boolean;
  recipients: string[];
  reason?: string;
}> {
  const settings = await getAlertSettings();
  const recipients = settings.admin.recipients;
  if (!recipients.length) return { sent: false, recipients, reason: 'no admin recipients configured' };

  // Prefer issues already open in memory (instant); else run a scan.
  let pool: SolarMonitorAlert[] = [...active.values()].map((t) => t.alert);
  if (!pool.length) pool = (await getSolarAlerts()).alerts;
  if (!pool.length) return { sent: false, recipients, reason: 'no active issues — the fleet is currently healthy' };

  const rank: Record<string, number> = { offline: 0, partial: 1, fault: 1, alert: 2, device: 3 };
  pool = [...pool].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const worst = pool[0];
  const issues = pool.filter((a) => a.provider === worst.provider && a.plantId === worst.plantId);

  const info = await plantInfo(worst);
  const [solution, attachment] = await Promise.all([
    resolveSolution(issues, settings),
    resolveAttachment(issues, settings),
  ]);
  const { subject, text, html } = buildAlertEmail(worst, issues, info, solution);
  await sendMail({
    to: recipients.join(', '),
    subject: `[TEST] ${subject}`,
    text,
    html,
    attachments: attachment ? [attachment] : undefined,
  });
  return { sent: true, plant: worst.plant, issues: issues.length, attached: Boolean(attachment), recipients };
}

/**
 * Send a real alert email for a specific, caller-supplied set of issues (one
 * plant), with the full pipeline: owner enrichment, KB-grounded solution and a
 * resolution attachment. Used to preview an exact scenario. Subject is prefixed
 * [TEST]. Does not touch de-dupe state.
 */
export async function sendCustomAlert(issues: SolarMonitorAlert[]): Promise<{
  sent: boolean;
  plant?: string;
  detailItems?: number;
  attached?: boolean;
  hasSolution?: boolean;
  recipients: string[];
  reason?: string;
}> {
  const settings = await getAlertSettings();
  const recipients = settings.admin.recipients;
  if (!recipients.length) return { sent: false, recipients, reason: 'no admin recipients configured' };
  if (!issues.length) return { sent: false, recipients, reason: 'no issues supplied' };

  const worst = issues[0];
  const info = await plantInfo(worst);
  const [solution, attachment] = await Promise.all([
    resolveSolution(issues, settings),
    resolveAttachment(issues, settings),
  ]);
  const { subject, text, html } = buildAlertEmail(worst, issues, info, solution);
  await sendMail({
    to: recipients.join(', '),
    subject: `[TEST] ${subject}`,
    text,
    html,
    attachments: attachment ? [attachment] : undefined,
  });
  return {
    sent: true,
    plant: worst.plant,
    detailItems: info.length,
    attached: Boolean(attachment),
    hasSolution: Boolean(solution),
    recipients,
  };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const res = await runAlertMonitorOnce();
    if (res.emailsSent || res.newIssues || res.cleared || res.deferredPlants) {
      console.log(
        `[solar-alert] scan: ${res.scanned} plants, ${res.active} open, +${res.newIssues}/-${res.cleared}, ${res.emailsSent} email(s)${res.deferredPlants ? `, ${res.deferredPlants} held (night)` : ''}`,
      );
    }
  } catch (err) {
    console.error('[solar-alert] monitor tick failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/** Re-arm the next tick from the live interval setting (so edits apply at once). */
async function scheduleNext(): Promise<void> {
  let minutes = 15;
  try {
    const s = await getAlertSettings();
    minutes = s.intervalMin > 0 ? s.intervalMin : 15;
  } catch {
    /* use default if settings can't be read this cycle */
  }
  timer = setTimeout(() => {
    void tick().finally(() => void scheduleNext());
  }, minutes * 60_000);
  timer.unref?.();
}

/**
 * Start the periodic alert monitor. Always starts (configuration lives in the
 * DB, read live); when alerts are disabled in settings a scan is a cheap no-op.
 */
export function startSolarAlertMonitor(): void {
  if (started) return;
  started = true;
  // First run a little after boot so provider caches are primed.
  setTimeout(() => {
    void tick().finally(() => void scheduleNext());
  }, 45_000);
  console.log('[solar-alert] monitor started (config in DB, read live each scan)');
}

export function stopSolarAlertMonitor(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

export type { SolarAlertSettings };
