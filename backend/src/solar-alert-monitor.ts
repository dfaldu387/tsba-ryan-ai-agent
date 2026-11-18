import type { SolarAlertSettings } from '@tsba/shared';
import { getProvider, aggregateStationsCached } from './providers/index.js';
import { getSolarAlerts } from './solar-alerts.js';
import { sendMail, MailSendError } from './smtp-mailer.js';
import { isNight } from './sun.js';
import { getAlertSettings } from './solar-alert-settings.js';
import { resolveAttachment, resolveSolution } from './solar-alert-resolution.js';
import type { SolarMonitorAlert, StationInfoItem } from './providers/types.js';
import { env } from './env.js';
import { getSetting, setSetting } from './settings-repo.js';

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
// Issues that cleared recently — if one reappears within FLAP_WINDOW_MS it is
// the same ongoing issue (keeps its first-seen and notified state), so a
// flapping plant isn't re-alerted every scan.
const recentlyCleared = new Map<string, { firstSeen: number; adminNotified: boolean; clearedAt: number }>();

// ─── Scheduled-digest bookkeeping (in-memory) ─────────────────────────────────
// When schedule.enabled is on, admin alerts are not emailed per-plant; they are
// held and flushed as ONE combined digest at the configured clock times, capped
// per day. We track, for the current local day, which time-slots have already
// fired and how many digests we've sent (for the cap). Resetting on restart is
// fine: the next due slot simply sends a fresh digest of whatever's still open.
let digestDay = ''; // 'YYYY-MM-DD' in the configured timezone
const digestSentSlots = new Set<string>(); // "HH:MM" slots already consumed today
let digestSends = 0; // digests actually emailed today (enforces maxPerDay)

// ─── Restart-safe state ───────────────────────────────────────────────────────
// The bookkeeping above (plus which open issues were already emailed and when
// each was first seen) is saved to app_settings after every scan and restored
// on the first scan after boot. Without it, every deploy/restart re-emailed all
// open issues (and re-sent today's digest slots).
const RUNTIME_KEY = 'solar_alert_runtime';
interface RuntimeState {
  digestDay: string;
  slots: string[];
  sends: number;
  open: [id: string, firstSeen: number, adminNotified: boolean][];
}
let restored = false;
const restoredOpen = new Map<string, { firstSeen: number; adminNotified: boolean }>();

async function restoreRuntime(): Promise<void> {
  if (restored) return;
  restored = true;
  if (env.storage !== 'postgres') return;
  try {
    const st = await getSetting<RuntimeState>(RUNTIME_KEY);
    if (!st) return;
    digestDay = st.digestDay ?? '';
    for (const sl of st.slots ?? []) digestSentSlots.add(sl);
    digestSends = st.sends ?? 0;
    for (const [id, firstSeen, adminNotified] of st.open ?? []) restoredOpen.set(id, { firstSeen, adminNotified });
  } catch (err) {
    console.warn('[solar-alert] could not restore monitor state:', (err as Error).message);
  }
}

async function saveRuntime(): Promise<void> {
  if (env.storage !== 'postgres' || !restored) return; // never overwrite saved state before it was loaded
  const state: RuntimeState = {
    digestDay,
    slots: [...digestSentSlots],
    sends: digestSends,
    open: [...active].map(([id, t]) => [id, t.firstSeen, t.adminNotified]),
  };
  await setSetting(RUNTIME_KEY, state).catch((err) => console.warn('[solar-alert] could not save monitor state:', (err as Error).message));
}

/** Current { date:'YYYY-MM-DD', minutes:sinceMidnight } in an IANA timezone. */
function localNow(tz: string): { date: string; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = Number(get('hour')) % 24; // en-CA can emit '24' at midnight
    return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
  } catch {
    const d = new Date(); // unknown tz → fall back to UTC
    return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
}

const slotMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

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
    // Cached: this runs once per emailed plant; an uncached sweep per plant hit
    // every provider (and their rate limits) again each time.
    const { stations } = await aggregateStationsCached();
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

/**
 * Build a combined multi-plant email. Used for the scheduled DIGEST (new issues
 * + a roll-up of what's still open + recoveries) and for an INSTANT burst (many
 * plants tripping on the same scan — one email instead of dozens).
 *
 * `solutions` maps plantKey → suggested fix; shown under that plant's row, so a
 * fault arrives with its resolution plan rather than just its name.
 */
function buildDigestEmail(p: {
  due: Tracked[];
  stillOpen?: Tracked[];
  recovered: SolarMonitorAlert[];
  contacts: Map<string, { name?: string; phone?: string; email?: string }>;
  now: { date: string; minutes: number };
  solutions?: Map<string, string>;
  kind?: 'digest' | 'instant';
}): { subject: string; text: string; html: string } {
  const { due, recovered, contacts, now } = p;
  const stillOpen = p.stillOpen ?? [];
  const solutions = p.solutions ?? new Map<string, string>();
  const instant = p.kind === 'instant';

  const group = (list: Tracked[]): Map<string, Tracked[]> => {
    const g = new Map<string, Tracked[]>();
    for (const t of list) {
      const k = plantKey(t.alert);
      (g.get(k) ?? g.set(k, []).get(k)!).push(t);
    }
    return g;
  };
  const groups = group(due);
  const openGroups = group(stillOpen);
  const plantCount = groups.size;
  const openCount = openGroups.size;
  const hhmm = `${String(Math.floor(now.minutes / 60)).padStart(2, '0')}:${String(now.minutes % 60).padStart(2, '0')}`;
  const stamp = `${now.date} ${hhmm}`;

  const ageLabel = (t: Tracked): string => {
    const mins = ageMin(t);
    if (mins < 90) return `${Math.round(mins)} min`;
    const hrs = mins / 60;
    return hrs < 48 ? `${Math.round(hrs)} hr` : `${Math.round(hrs / 24)} day`;
  };
  const oldestOf = (items: Tracked[]): Tracked => items.reduce((a, c) => (c.firstSeen < a.firstSeen ? c : a), items[0]);
  const contactStr = (a: SolarMonitorAlert): string => {
    const c = contacts.get(plantKey(a));
    if (!c) return '';
    return [c.name, c.phone, c.email].filter(Boolean).join(' · ');
  };
  const issueLine = (t: Tracked): string => `${t.alert.title}${t.alert.detail ? ` — ${t.alert.detail}` : ''}`;

  const subject = instant
    ? `[Solar Alert] ${plantCount} plant${plantCount === 1 ? '' : 's'} just went down or reported a fault`
    : plantCount > 0
      ? `[Solar Alert] ${plantCount} new plant issue${plantCount === 1 ? '' : 's'}${openCount ? ` · ${openCount} still open` : ''}`
      : openCount > 0
        ? `[Solar Digest] ${openCount} plant${openCount === 1 ? '' : 's'} still need attention`
        : `[Solar Recovered] ${recovered.length} issue${recovered.length === 1 ? '' : 's'} cleared`;

  // ─── Plain text ───
  const textRows: string[] = [];
  for (const [k, items] of groups) {
    const worst = items[0].alert;
    const who = contactStr(worst);
    textRows.push(`  • ${worst.plant} (${providerName(worst.provider)}) [down ${ageLabel(oldestOf(items))}]`);
    for (const t of items) textRows.push(`      - ${issueLine(t)}`);
    if (who) textRows.push(`      Owner: ${who}`);
    const sol = solutions.get(k);
    if (sol) textRows.push('      Suggested fix:', ...sol.split('\n').map((l) => `        ${l}`));
  }
  const openRows = [...openGroups.values()].map((items) => {
    const worst = items[0].alert;
    return `  • ${worst.plant} (${providerName(worst.provider)}) — ${items.map((t) => t.alert.title).join('; ')} [open ${ageLabel(oldestOf(items))}]`;
  });
  const recRows = recovered.map((a) => `  • ${a.plant} (${providerName(a.provider)}) — ${a.title}`);
  const text = [
    instant ? `Solar monitoring — instant alert, ${stamp}.` : `Solar monitoring digest — ${stamp}.`,
    plantCount ? `\n${instant ? 'Just detected' : 'New since the last email'} — ${plantCount} plant(s):` : '',
    ...(plantCount ? textRows : []),
    openCount ? `\nStill open (already reported) — ${openCount} plant(s):` : '',
    ...(openCount ? openRows : []),
    recovered.length ? `\nRecovered since the last digest:` : '',
    ...(recovered.length ? recRows : []),
    '',
    'This is an automated email from the TSBA solar monitoring system.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  // ─── HTML ───
  const td = 'padding:7px 10px;border-bottom:1px solid #eef2f7;font-size:13px;vertical-align:top';
  const th = 'text-align:left;padding:6px 10px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#94a3b8;border-bottom:2px solid #e2e8f0';
  const rowsHtml = [...groups.entries()]
    .map(([k, items]) => {
      const worst = items[0].alert;
      const issues = items
        .map((t) => `<strong>${escapeHtml(t.alert.title)}</strong>${t.alert.detail ? `<br><span style="color:#64748b">${escapeHtml(t.alert.detail)}</span>` : ''}`)
        .join('<br>');
      const who = contactStr(worst);
      const sol = solutions.get(k);
      return `<tr>
      <td style="${td}"><strong>${escapeHtml(worst.plant)}</strong>${who ? `<br><span style="color:#64748b;font-size:12px">${escapeHtml(who)}</span>` : ''}</td>
      <td style="${td};color:#334155">${escapeHtml(providerName(worst.provider))}</td>
      <td style="${td};color:#b91c1c">${issues}</td>
      <td style="${td};color:#64748b;white-space:nowrap">${escapeHtml(ageLabel(oldestOf(items)))}</td>
    </tr>${
      sol
        ? `<tr><td colspan="4" style="padding:0 10px 12px;border-bottom:1px solid #eef2f7">
      <div style="white-space:pre-wrap;background:#f0f9f4;border:1px solid #cdebd9;border-radius:8px;padding:10px 12px;font-size:12.5px;line-height:1.5"><strong style="color:#15803d">Suggested fix</strong>\n${escapeHtml(sol)}</div>
    </td></tr>`
        : ''
    }`;
    })
    .join('\n');

  const openHtml = openCount
    ? `<h3 style="margin:18px 0 6px;font-size:14px;color:#b45309">Still open — already reported (${openCount})</h3>
    <ul style="margin:0 0 8px;padding-left:20px;font-size:13px">
      ${[...openGroups.values()]
        .map((items) => {
          const w = items[0].alert;
          return `<li style="margin-bottom:3px">${escapeHtml(w.plant)} <span style="color:#94a3b8">(${escapeHtml(providerName(w.provider))})</span> — ${escapeHtml(items.map((t) => t.alert.title).join('; '))} <span style="color:#94a3b8">· open ${escapeHtml(ageLabel(oldestOf(items)))}</span></li>`;
        })
        .join('\n      ')}
    </ul>`
    : '';

  const recHtml = recovered.length
    ? `<h3 style="margin:18px 0 6px;font-size:14px;color:#15803d">✓ Recovered since last digest</h3>
    <ul style="margin:0 0 8px;padding-left:20px;font-size:13px">
      ${recovered.map((a) => `<li style="margin-bottom:3px">${escapeHtml(a.plant)} <span style="color:#94a3b8">(${escapeHtml(providerName(a.provider))})</span> — ${escapeHtml(a.title)}</li>`).join('\n      ')}
    </ul>`
    : '';

  const banner = instant
    ? `⚠ Instant alert — ${plantCount} plant${plantCount === 1 ? '' : 's'} just went down or reported a fault`
    : plantCount
      ? `⚠ Solar monitoring digest — ${plantCount} new issue${plantCount === 1 ? '' : 's'}`
      : `Solar monitoring digest — ${openCount} still open`;
  const bannerBg = plantCount ? '#b91c1c' : openCount ? '#b45309' : '#15803d';

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;color:#0f172a">
  <div style="background:${bannerBg};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-size:16px;font-weight:600">
    ${escapeHtml(banner)}
  </div>
  <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:18px">
    ${
      plantCount
        ? `<table style="border-collapse:collapse;width:100%">
      <thead><tr>
        <th style="${th}">Plant / Owner</th>
        <th style="${th}">Platform</th>
        <th style="${th}">Issue</th>
        <th style="${th}">Down</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
        : '<p style="margin:0 0 8px;color:#15803d">No new issues since the last email.</p>'
    }
    ${openHtml}
    ${recHtml}
    <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">Generated ${escapeHtml(stamp)} · Automated email from the TSBA solar monitoring system.</p>
  </div>
</div>`;

  return { subject, text, html };
}

/**
 * Suggested fixes for a set of plant issues, keyed by plantKey. Only plants with
 * a FAULT get one (an offline plant's fix is the same generic connectivity
 * checklist, which would just repeat down a multi-plant email). Bounded: at most
 * `limit` plants, 3 at a time; solutions are cached per fault + equipment, so a
 * fault shared by many plants costs one generation. Best-effort — never throws.
 */
async function solutionsFor(due: Tracked[], settings: SolarAlertSettings, limit = 20): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!settings.includeSolution) return out;
  const byPlant = groupByPlant(due.map((t) => t.alert));
  const jobs = [...byPlant.entries()].filter(([, issues]) => issues.some((i) => i.severity === 'alert')).slice(0, limit);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (next < jobs.length) {
        const [k, issues] = jobs[next++];
        const faults = issues.filter((i) => i.severity === 'alert');
        const sol = await resolveSolution(faults, settings).catch(() => null);
        if (sol) out.set(k, sol);
      }
    }),
  );
  return out;
}

/** Owner/contact (local store) for each plant in the given alerts. Best-effort. */
async function contactsFor(alerts: SolarMonitorAlert[]): Promise<Map<string, { name?: string; phone?: string; email?: string }>> {
  const contacts = new Map<string, { name?: string; phone?: string; email?: string }>();
  try {
    const { getPlantContact } = await import('./plant-contacts.js');
    const unique = [...new Map(alerts.map((a) => [plantKey(a), a])).values()];
    await Promise.all(
      unique.map(async (a) => {
        const c = await getPlantContact(a.provider, a.plantId);
        if (c) contacts.set(plantKey(a), { name: c.name, phone: c.phone, email: c.email });
      }),
    );
  } catch {
    /* contact store unavailable — the email still lists plants without owners */
  }
  return contacts;
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

// More plants than this tripping on ONE scan (e.g. a provider or regional grid
// outage) are sent as one combined instant email rather than one email each.
const INSTANT_BURST_PLANTS = 5;
// An issue that clears and comes back within this window is treated as the SAME
// ongoing issue (no new alert, no recovery note) — stops a flapping logger or a
// borderline fault from emailing on every scan.
const FLAP_WINDOW_MS = 60 * 60_000;

/**
 * Email each plant's due issues as its own alert (full detail, owner info,
 * suggested fix, optional guide attachment) and mark them notified. Plants in
 * their own night are held. Stops early on an SMTP failure (retried next scan).
 */
async function sendPlantAlerts(
  due: Tracked[],
  settings: SolarAlertSettings,
  to: string,
  plantNight: (a: SolarMonitorAlert) => boolean,
): Promise<{ sent: number; deferred: number }> {
  let sent = 0;
  let deferred = 0;
  for (const [, issues] of groupByPlant(due.map((t) => t.alert))) {
    const plant = issues[0];
    if (plantNight(plant)) {
      deferred++;
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
      sent++;
      for (const i of issues) {
        const t = active.get(i.id);
        if (t) t.adminNotified = true;
      }
    } catch (err) {
      if (err instanceof MailSendError) {
        console.warn('[solar-alert] SMTP send failed — alert emails held:', err.message);
        break;
      }
      console.error(`[solar-alert] failed to email alert for ${plant.plant}:`, (err as Error).message);
    }
  }
  return { sent, deferred };
}

/**
 * Instant delivery (digest mode + `schedule.instant`): everything that tripped
 * and isn't yet reported goes out NOW. A handful of plants → one email each; a
 * burst → one combined email (with fixes) so an outage doesn't flood the inbox.
 */
async function sendInstantAlerts(
  settings: SolarAlertSettings,
  to: string,
  plantNight: (a: SolarMonitorAlert) => boolean,
): Promise<{ sent: number; deferred: number }> {
  const pending = [...active.values()].filter((t) => !t.adminNotified && ageMin(t) >= settings.admin.delayMin);
  const deferred = new Set(pending.filter((t) => plantNight(t.alert)).map((t) => plantKey(t.alert))).size;
  const due = pending.filter((t) => !plantNight(t.alert));
  if (!due.length) return { sent: 0, deferred };

  const plants = new Set(due.map((t) => plantKey(t.alert))).size;
  if (plants <= INSTANT_BURST_PLANTS) {
    const r = await sendPlantAlerts(due, settings, to, plantNight);
    return { sent: r.sent, deferred: deferred + r.deferred };
  }

  const [contacts, solutions] = await Promise.all([contactsFor(due.map((t) => t.alert)), solutionsFor(due, settings)]);
  const { subject, text, html } = buildDigestEmail({
    due,
    recovered: [],
    contacts,
    now: localNow(settings.schedule.timezone),
    solutions,
    kind: 'instant',
  });
  try {
    await sendMail({ to, subject, text, html });
  } catch (err) {
    if (err instanceof MailSendError) console.warn('[solar-alert] SMTP send failed — instant alert held:', err.message);
    else console.error('[solar-alert] failed to send instant alert:', (err as Error).message);
    return { sent: 0, deferred };
  }
  for (const t of due) t.adminNotified = true;
  return { sent: 1, deferred };
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
  await restoreRuntime();

  /**
   * Is it night at a plant's own location? Uses the plant's installation
   * coordinates when the platform exposed them, else the fallback location in
   * settings. Returns false when quiet hours are off.
   */
  const plantNight = (a: SolarMonitorAlert): boolean => {
    if (!settings.quietNight) return false;
    // Quiet hours exist because plants and loggers go dark after sunset, which
    // would read as "offline". A fault code (inverter/battery/BMS error) is a
    // real problem at any hour, so it is never held for the morning.
    if (a.severity === 'alert') return false;
    return isNight(a.lat ?? settings.lat, a.lng ?? settings.lng);
  };

  // Fresh scan: an outage must be acted on in the scan it happens, not served
  // from the previous (stale-while-revalidate) result one interval later.
  const { alerts, scannedPlants, coverage } = await getSolarAlerts({ fresh: true });
  base.scanned = scannedPlants;
  const seen = new Set(alerts.map((a) => a.id));
  // An issue may only clear if its plant was actually checked this scan:
  // plant-level (offline/partial) needs the plant in the overview; device and
  // fault issues need its detail fetched — or the plant now being offline,
  // which the plant-level alert covers. Otherwise a portal timeout or a
  // provider dropping out sent a false "Recovered" and then a "new" alert.
  const listed = new Set(coverage?.listed ?? []);
  const detailed = new Set(coverage?.detailed ?? []);
  const checked = (a: SolarMonitorAlert): boolean => {
    if (!coverage) return true; // older scan shape: previous behaviour
    const k = plantKey(a);
    if (a.severity === 'offline' || a.severity === 'partial') return listed.has(k);
    return detailed.has(k) || alerts.some((x) => x.severity === 'offline' && plantKey(x) === k);
  };

  // Forget flap-guard entries past their window.
  const nowMs = Date.now();
  for (const [id, c] of recentlyCleared) if (nowMs - c.clearedAt > FLAP_WINDOW_MS) recentlyCleared.delete(id);

  // Insert/refresh currently-open issues.
  let newIssues = 0;
  for (const a of alerts) {
    const t = active.get(a.id);
    if (t) {
      t.alert = a;
      continue;
    }
    const prev = restoredOpen.get(a.id); // still open from before a restart
    const flap = recentlyCleared.get(a.id); // cleared moments ago — same ongoing issue
    if (flap) {
      recentlyCleared.delete(a.id);
      recoveredPending.delete(a.id); // it came straight back: no "recovered" note
    }
    active.set(a.id, {
      alert: a,
      firstSeen: prev?.firstSeen ?? flap?.firstSeen ?? Date.now(),
      adminNotified: prev?.adminNotified ?? flap?.adminNotified ?? false,
      customerNotified: false,
    });
    if (!prev && !flap) newIssues++;
  }
  restoredOpen.clear(); // only the first scan after boot reconciles

  // Detect cleared issues.
  let cleared = 0;
  for (const [id, t] of [...active]) {
    if (!seen.has(id) && checked(t.alert)) {
      active.delete(id);
      cleared++;
      recentlyCleared.set(id, { firstSeen: t.firstSeen, adminNotified: t.adminNotified, clearedAt: nowMs });
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

  const to = recipients.join(', ');

  // Per-plant flow (scheduled digests OFF): every due issue is emailed as soon as
  // it passes the debounce, one email per plant, with recovery notes the same way.
  if (recipients.length && !settings.schedule.enabled) {
    const due = [...active.values()].filter((t) => !t.adminNotified && ageMin(t) >= settings.admin.delayMin);
    const r = await sendPlantAlerts(due, settings, to, plantNight);
    emailsSent += r.sent;
    deferredPlants += r.deferred;

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
          if (err instanceof MailSendError) {
            console.warn('[solar-alert] SMTP send failed — recovery emails held:', err.message);
            break;
          }
          console.error(`[solar-alert] failed to email recovery for ${plant.plant}:`, (err as Error).message);
        }
      }
    }
  }

  // Digest mode with instant alerts: outages/faults go out NOW; the digest below
  // then carries the roll-up of what's still open plus recoveries.
  if (recipients.length && settings.schedule.enabled && settings.schedule.instant) {
    const r = await sendInstantAlerts(settings, to, plantNight);
    emailsSent += r.sent;
    deferredPlants += r.deferred;
  }

  // Scheduled-digest flow: ONE combined email at the configured clock times
  // (capped per day) — new issues not yet emailed, still-open ones, recoveries.
  if (recipients.length && settings.schedule.enabled) {
    const digest = await runScheduledDigest(settings, recipients, plantNight);
    emailsSent += digest.sent;
    if (digest.reason) base.reason = digest.reason;
  }

  base.emailsSent = emailsSent;
  base.deferredPlants = deferredPlants;
  if (deferredPlants) base.reason = `${deferredPlants} plant(s) held — night at their location`;
  return base;
}

/**
 * The scheduled-digest sender. Called each scan when schedule.enabled is on.
 * Fires at most one combined email, and only when the local clock has crossed a
 * configured send time that hasn't fired yet today and the daily cap allows it.
 * Returns how many emails were sent (0 or 1) and an optional status reason.
 */
async function runScheduledDigest(
  settings: SolarAlertSettings,
  recipients: string[],
  plantNight: (a: SolarMonitorAlert) => boolean,
): Promise<{ sent: number; reason?: string }> {
  const { times, timezone, maxPerDay } = settings.schedule;
  if (!times.length) return { sent: 0, reason: 'scheduled digests on but no send times configured' };

  // Roll over to a new local day → reset the per-day slot/cap bookkeeping.
  const now = localNow(timezone);
  if (now.date !== digestDay) {
    digestDay = now.date;
    digestSentSlots.clear();
    digestSends = 0;
  }

  // Which configured times are due (reached today) but not yet consumed?
  const dueSlots = times.filter((t) => slotMinutes(t) <= now.minutes && !digestSentSlots.has(t));
  if (!dueSlots.length) {
    const next = times.find((t) => slotMinutes(t) > now.minutes);
    return { sent: 0, reason: next ? `digest held — next send ${next} ${timezone}` : 'digest held — next send tomorrow' };
  }

  // Consume the due slots regardless of whether we end up sending, so we don't
  // re-evaluate them every scan for the rest of the day.
  for (const s of dueSlots) digestSentSlots.add(s);

  if (digestSends >= maxPerDay) {
    return { sent: 0, reason: `daily digest cap reached (${maxPerDay}/day)` };
  }

  // New: open issues past the debounce, not yet emailed, not in their own night.
  // Still open: already emailed (instantly or in an earlier digest), still active.
  // Plus any pending recoveries.
  const due = [...active.values()].filter(
    (t) => !t.adminNotified && ageMin(t) >= settings.admin.delayMin && !plantNight(t.alert),
  );
  const dueKeys = new Set(due.map((t) => plantKey(t.alert)));
  const stillOpen = [...active.values()].filter((t) => t.adminNotified && !dueKeys.has(plantKey(t.alert)));
  const recovered = settings.recovery ? [...recoveredPending.values()] : [];
  if (!due.length && !stillOpen.length && !recovered.length) {
    return { sent: 0, reason: 'scheduled digest due — nothing open to report' };
  }

  const [contacts, solutions] = await Promise.all([
    contactsFor([...due.map((t) => t.alert), ...stillOpen.map((t) => t.alert), ...recovered]),
    solutionsFor(due, settings),
  ]);

  const { subject, text, html } = buildDigestEmail({ due, stillOpen, recovered, contacts, now, solutions });
  try {
    await sendMail({ to: recipients.join(', '), subject, text, html });
  } catch (err) {
    // Send failed → roll the slots back so the next scan retries this digest.
    for (const s of dueSlots) digestSentSlots.delete(s);
    if (err instanceof MailSendError) console.warn('[solar-alert] SMTP send failed — digest held:', err.message);
    else console.error('[solar-alert] failed to send digest:', (err as Error).message);
    return { sent: 0, reason: 'digest send failed — will retry next scan' };
  }

  // Mark everything reported, consume one daily send, and clear recoveries.
  for (const t of due) t.adminNotified = true;
  for (const a of recovered) recoveredPending.delete(a.id);
  digestSends++;
  return { sent: 1, reason: `digest sent — ${due.length} new, ${stillOpen.length} still open, ${recovered.length} recovered` };
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

/**
 * Send a preview of the combined DIGEST email (subject prefixed [TEST]). Uses
 * real currently-open issues when there are any; otherwise a couple of synthetic
 * rows so the format is still visible. Does not touch de-dupe/schedule state.
 */
export async function sendSampleDigest(): Promise<{
  sent: boolean;
  plants?: number;
  synthetic?: boolean;
  recipients: string[];
  reason?: string;
}> {
  const settings = await getAlertSettings();
  const recipients = settings.admin.recipients;
  if (!recipients.length) return { sent: false, recipients, reason: 'no admin recipients configured' };

  // Prefer real open issues; fall back to a fresh scan; finally synthesize.
  let pool: SolarMonitorAlert[] = [...active.values()].map((t) => t.alert);
  if (!pool.length) pool = (await getSolarAlerts()).alerts;
  let synthetic = false;
  if (!pool.length) {
    synthetic = true;
    pool = [
      { id: 'sample-1', severity: 'offline', provider: 'deye', plant: 'Sample Plant — 12 Example St', plantId: 's1', title: 'Plant offline' },
      { id: 'sample-2', severity: 'partial', provider: 'goodwe', plant: 'Sample Plant — 7 Demo Rd', plantId: 's2', title: 'Partially down (1 of 2 inverters)' },
      { id: 'sample-3', severity: 'fault', provider: 'sungrow', plant: 'Sample Plant — 3 Test Ave', plantId: 's3', title: 'Grid over-frequency' },
    ];
  }

  const due: Tracked[] = pool.map((a) => ({ alert: a, firstSeen: Date.now() - 3 * 3_600_000, adminNotified: false, customerNotified: false }));
  // Real issues get real owner details and suggested fixes (a few, to keep the
  // preview quick); synthetic rows have neither.
  const [contacts, solutions] = synthetic
    ? [new Map<string, { name?: string; phone?: string; email?: string }>(), new Map<string, string>()]
    : await Promise.all([contactsFor(pool), solutionsFor(due, settings, 5)]);

  const now = localNow(settings.schedule.timezone);
  const { subject, text, html } = buildDigestEmail({ due, recovered: [], contacts, now, solutions });
  await sendMail({ to: recipients.join(', '), subject: `[TEST] ${subject}`, text, html });
  return { sent: true, plants: new Set(due.map((t) => plantKey(t.alert))).size, synthetic, recipients };
}

/**
 * When the monitor first saw each currently-open issue (ms), by alert id — so
 * the UI can say "open 3 h" even for issues the platform gives no start time
 * for (a plant going offline). Includes state restored after a restart.
 */
export function openSince(): Map<string, number> {
  const m = new Map<string, number>();
  for (const [id, r] of restoredOpen) m.set(id, r.firstSeen);
  for (const [id, t] of active) m.set(id, t.firstSeen);
  return m;
}

/**
 * Manual "run now" (from the API): shares the scheduled scan's overlap guard, so
 * a click during a scheduled scan can't email the same issues twice.
 */
export async function runAlertMonitorNow(): Promise<MonitorRunResult | { busy: true; reason: string }> {
  if (running) return { busy: true, reason: 'A scan is already running. Try again in a minute.' };
  running = true;
  try {
    return await runAlertMonitorOnce();
  } finally {
    await saveRuntime();
    running = false;
  }
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
    await saveRuntime();
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
