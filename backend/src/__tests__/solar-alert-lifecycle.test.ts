import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolarMonitorAlert } from '../providers/types.js';

// The monitor's lifecycle: alert → clearing (confirmation window) → resolved
// (logged + "resolved" email) — and a flap inside the window stays one issue.

const sent: { subject: string; text: string }[] = [];
let scan: SolarMonitorAlert[] = [];
const settings = {
  enabled: true,
  intervalMin: 15,
  recovery: true,
  recoveryConfirmMin: 30,
  quietNight: false,
  lat: -33.8,
  lng: 151.2,
  admin: { recipients: ['ops@example.com'], delayMin: 0 },
  customer: { enabled: false, delayMin: 60 },
  includeSolution: false,
  attachResolution: false,
  resolutionRules: [],
  // Legacy per-plant flow: these lifecycle tests assert one email per plant as it trips.
  schedule: { enabled: false, intervalHours: 1, sendFromHour: 9, sendUntilHour: 18, times: [] as string[], timezone: 'Australia/Sydney', maxPerDay: 24, instant: false },
};

vi.mock('../env.js', () => ({ env: { storage: 'memory' } }));
vi.mock('../settings-repo.js', () => ({ getSetting: async () => null, setSetting: async () => {} }));
vi.mock('../sun.js', () => ({ isNight: () => false }));
vi.mock('../solar-alert-settings.js', () => ({ getAlertSettings: async () => settings }));
vi.mock('../solar-alert-resolution.js', () => ({ resolveSolution: async () => null, resolveAttachment: async () => null }));
vi.mock('../plant-contacts.js', () => ({ getPlantContact: async () => null }));
vi.mock('../providers/index.js', () => ({
  getProvider: () => undefined,
  aggregateStationsCached: async () => ({ stations: [], errors: [] }),
}));
vi.mock('../smtp-mailer.js', () => ({
  MailSendError: class extends Error {},
  sendMail: async (m: { subject: string; text: string }) => {
    sent.push({ subject: m.subject, text: m.text });
  },
}));
vi.mock('../solar-alerts.js', () => ({
  getSolarAlerts: async () => ({
    alerts: scan,
    scannedPlants: 1,
    // The plant was fully checked on every scan, so a missing alert really cleared.
    coverage: { listed: ['deye:p1'], detailed: ['deye:p1'] },
  }),
}));

const fault: SolarMonitorAlert = {
  id: 'deye:p1:fault:F35:SN1',
  severity: 'alert',
  provider: 'deye',
  plant: 'Smith Residence',
  plantId: 'p1',
  title: 'Grid over-voltage',
  deviceSn: 'SN1',
};

const MIN = 60_000;
let t0 = 0;
const at = (min: number) => vi.setSystemTime(t0 + min * MIN);

async function load() {
  vi.resetModules();
  const monitor = await import('../solar-alert-monitor.js');
  const history = await import('../solar-alert-history.js');
  return { monitor, history };
}

describe('solar alert lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    t0 = Date.UTC(2026, 10, 19, 1, 0); // midday in Sydney
    at(0);
    sent.length = 0;
    scan = [];
  });
  afterEach(() => vi.useRealTimers());

  it('alerts, waits out the confirmation window, then emails "resolved" and logs it', async () => {
    const { monitor, history } = await load();

    scan = [fault];
    await monitor.runAlertMonitorOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('[Solar Alert]');
    expect(monitor.notifiedAt().has(fault.id)).toBe(true);

    // Clears — but not yet confirmed: no email, shown as "Confirming".
    scan = [];
    at(15);
    const r2 = await monitor.runAlertMonitorOnce();
    expect(r2.cleared).toBe(1);
    expect(r2.resolved).toBe(0);
    expect(sent).toHaveLength(1);
    expect(monitor.pendingResolutions()).toHaveLength(1);

    // Still clear after 30 min → confirmed resolved + email.
    at(45);
    const r3 = await monitor.runAlertMonitorOnce();
    expect(r3.resolved).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain('[Solar Resolved]');
    expect(sent[1].subject).toContain('Smith Residence');
    expect(sent[1].text).toContain('15 min'); // lasted: opened 0, cleared at 15
    expect(monitor.pendingResolutions()).toHaveLength(0);

    const log = await history.listResolved(7);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: fault.id, alerted: true, openedAt: t0, resolvedAt: t0 + 15 * MIN });
    expect(log[0].recoveryEmailedAt).toBeTypeOf('number');
  });

  it('a flap inside the window stays the same issue — no resolved email, no new alert', async () => {
    const { monitor, history } = await load();
    scan = [fault];
    await monitor.runAlertMonitorOnce();
    scan = [];
    at(15);
    await monitor.runAlertMonitorOnce();
    scan = [fault]; // back within 30 min
    at(30);
    const r = await monitor.runAlertMonitorOnce();
    expect(r.newIssues).toBe(0);
    expect(sent).toHaveLength(1); // only the original alert
    expect(await history.listResolved(7)).toHaveLength(0);
    expect(monitor.openSince().get(fault.id)).toBe(t0); // kept its original start
  });

  it('a recurrence after a confirmed resolution is a fresh alert that says it came back', async () => {
    const { monitor } = await load();
    scan = [fault];
    await monitor.runAlertMonitorOnce();
    scan = [];
    at(15);
    await monitor.runAlertMonitorOnce();
    at(45);
    await monitor.runAlertMonitorOnce(); // resolved email
    scan = [fault];
    at(120);
    const r = await monitor.runAlertMonitorOnce();
    expect(r.newIssues).toBe(1);
    expect(sent).toHaveLength(3);
    expect(sent[2].subject).toContain('[Solar Alert]');
    expect(sent[2].text).toContain('has come back');
  });

  it('scheduled mode sends one combined email per hour, and only when something is new', async () => {
    const { monitor } = await load();
    const fault2: SolarMonitorAlert = { ...fault, id: 'deye:p2:fault:F35:SN2', plant: 'Jones Solar', plantId: 'p2', deviceSn: 'SN2' };
    settings.schedule = { ...settings.schedule, enabled: true };
    try {
      // t0 is 12:00 Sydney. 12:10 → the first digest goes out (one email, not one per plant).
      at(10);
      scan = [fault];
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).not.toContain('Smith Residence —');

      // Same hour, nothing new → nothing sent.
      at(20);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(1);

      // A second plant trips at 12:40; it waits for the 13:00 digest.
      at(40);
      scan = [fault, fault2];
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(1);

      // 13:00 → one email covering the new plant; the still-open one is not repeated as new.
      at(60);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(2);
      expect(sent[1].text).toContain('Jones Solar');

      // 13:30 → no digest slot due → silent.
      at(90);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(2);

      // 14:00 with nothing new, both still open → one hourly email carrying the open issues.
      at(120);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(3);
      expect(sent[2].subject).toContain('still need attention');
    } finally {
      settings.schedule = { ...settings.schedule, enabled: false };
    }
  });

  it('sends nothing outside the 09:00–18:00 window; the morning digest carries what came in overnight', async () => {
    const { monitor } = await load();
    settings.schedule = { ...settings.schedule, enabled: true };
    try {
      // 19:00 Sydney (t0 is 12:00): a new fault, but outside the window → no email.
      at(420);
      scan = [fault];
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(0);

      // 09:00 next morning → the digest goes out with the overnight issue.
      at(1260);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain('[Solar Alert]');
    } finally {
      settings.schedule = { ...settings.schedule, enabled: false };
    }
  });

  it('with resolved emails off, the fix is still logged but not emailed', async () => {
    const { monitor, history } = await load();
    settings.recovery = false;
    try {
      scan = [fault];
      await monitor.runAlertMonitorOnce();
      scan = [];
      at(15);
      await monitor.runAlertMonitorOnce();
      at(45);
      await monitor.runAlertMonitorOnce();
      expect(sent).toHaveLength(1);
      expect(await history.listResolved(7)).toHaveLength(1);
    } finally {
      settings.recovery = true;
    }
  });
});
