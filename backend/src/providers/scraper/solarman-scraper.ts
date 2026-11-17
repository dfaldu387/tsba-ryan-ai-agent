import type { Page } from 'playwright';
import { pickCoords } from '../coords.js';
import { cached, invalidate } from '../cache.js';
import type {
  ChartData,
  EnergyFlow,
  NormalizedAlert,
  NormalizedDetail,
  NormalizedDevice,
  NormalizedPowerPoint,
  NormalizedStation,
  StationInfoItem,
  StationOverview,
  StationStatus,
} from '../types.js';
import { SessionExpiredError } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * Solarman Business scraper. The developer API is on hold, so we read the fleet
 * from the web portal using a session captured from a real browser (Cloudflare
 * Turnstile only guards the login page, not the data API).
 *
 * Technique: navigate to the plant page and let the portal's own app make its
 * authenticated `/operating/station/v2/search` XHR, but rewrite the query so it
 * returns the whole fleet in one page, then read that JSON response. Replaying
 * the request out-of-band 500s (server rejects it), so we ride the app's call.
 *
 * That list endpoint returns rich per-plant fields, so the detail page is built
 * from the cached raw records (no extra page load / fragile row-clicking).
 *
 * Devices, today's curves, latest alerts and the per-plant Overview come from the
 * portal's `/maintain-s/` JSON API. Those endpoints DO accept a direct call with
 * just the portal's bearer token (verified; unlike the plant search), so the
 * token is picked up from the app's own requests during the list scrape and the
 * rest is plain HTTPS — no extra browser work per plant.
 */

const ORIGIN = 'https://globalpro.solarmanpv.com';
const PLANT_URL = `${ORIGIN}/business/maintain/plant`;
const SEARCH_MATCH = '/operating/station/v2/search';
const API = `${ORIGIN}/maintain-s`;

// Portal bearer token, captured from the app's own /maintain-s/ requests during
// the list scrape (long-lived: ~2 months). Cleared on a 401 so the next list
// scrape picks up a fresh one.
let bearer: string | null = null;

async function api<T>(path: string, body?: unknown): Promise<T> {
  return apiAt<T>(API, path, body);
}

/** Same as api() but against another portal service base (e.g. /device-s). */
async function apiAt<T>(base: string, path: string, body?: unknown): Promise<T> {
  if (!bearer) throw new Error('solarman_no_token (list scrape has not run yet)');
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: bearer, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) {
    bearer = null;
    invalidate('scraper:solarman:stations');
  }
  if (!res.ok) throw new Error(`solarman_api ${res.status} ${path}`);
  return (await res.json()) as T;
}

interface SolarmanStation {
  id: number;
  name?: string;
  locationAddress?: string;
  installedCapacity?: number; // kW
  networkStatus?: string; // NORMAL | ALL_OFFLINE | PARTIAL_OFFLINE | NO_DEVICE
  generationPower?: number; // W (current)
  generationValue?: number; // kWh today
  generationMonth?: number; // kWh
  generationYear?: number; // kWh
  generationTotal?: number; // kWh all-time
  usePower?: number; // W (consumption)
  useMonth?: number; // kWh
  useYear?: number; // kWh
  fullPowerHoursDay?: number;
  gridInterconnectionType?: string;
  type?: string;
  startOperatingTime?: number; // epoch seconds
  regionTimezone?: string;
  creatorName?: string;
  nmi?: string;
  lastUpdateTime?: number; // epoch seconds
}

// Raw records from the last list scrape, keyed by station id — used to build the
// detail page without another page load.
const rawById = new Map<string, SolarmanStation>();

function mapStatus(net?: string): StationStatus {
  switch (net) {
    case 'NORMAL':
      return 'online';
    case 'PARTIAL_OFFLINE':
      return 'partial';
    case 'ALL_OFFLINE':
    case 'NO_DEVICE':
      return 'offline';
    default:
      return 'unknown';
  }
}

function statusLabel(net?: string): string {
  const map: Record<string, string> = {
    NORMAL: 'Online',
    PARTIAL_OFFLINE: 'Partially offline',
    ALL_OFFLINE: 'Offline',
    NO_DEVICE: 'No device',
  };
  return net ? map[net] ?? net : 'Unknown';
}

function toStation(s: SolarmanStation): NormalizedStation {
  return {
    id: String(s.id),
    name: (s.name || `Station ${s.id}`).trim(),
    status: mapStatus(s.networkStatus),
    currentPowerW: s.generationPower,
    dailyEnergyKwh: s.generationValue,
    monthlyEnergyKwh: s.generationMonth,
    totalEnergyKwh: s.generationTotal,
    capacityKw: s.installedCapacity,
    location: s.locationAddress,
    ...pickCoords(s),
    lastUpdate: s.lastUpdateTime,
  };
}

const GRID_TYPE_LABEL: Record<string, string> = {
  BATTERY_BACKUP: 'Battery backup',
  GRID_TIED: 'Grid-tied',
  SELF_CONSUMPTION: 'Self-consumption',
};

function tsToDate(sec?: number): string | undefined {
  if (!sec) return undefined;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
}

// ─── Fleet extras: devices, today's curves, latest alerts (one pass) ─────────

interface SmDevice {
  id?: number; // portal device id (needed for /device-s/ per-device calls)
  siteId?: number;
  deviceSn?: string;
  type?: string;
  netState?: number; // 1 online, 0 offline
  alertState?: number; // -1 none, else alerting
  deviceState?: number; // 1 normal, 2 alarm, 3 offline
}
interface SmCurve {
  stationId: number;
  generationPowerList?: { generationPower?: number; dateTime?: number }[];
}
interface SmLatestAlert {
  stationId?: number;
  id?: number | string | null;
  alertName?: string | null;
  level?: number | null;
  deviceSn?: string | null;
  alertStartTime?: number | null;
  alertEndTime?: number | null;
}
interface FleetExtras {
  devices: Map<string, NormalizedDevice[]>;
  /** Raw device rows per plant (keeps the portal device id for per-device calls). */
  rawDevices: Map<string, SmDevice[]>;
  curves: Map<string, NormalizedPowerPoint[]>;
  alerts: Map<string, NormalizedAlert[]>;
}

const TYPE_LABEL: Record<string, string> = { INVERTER: 'Inverter', BATTERY: 'Battery', COLLECTOR: 'Logger', METER: 'Meter' };

function toDevice(d: SmDevice): NormalizedDevice {
  const offline = d.netState === 0 || d.deviceState === 3;
  const alarm = !offline && (d.deviceState === 2 || (d.alertState != null && d.alertState > 0));
  const online = d.netState === 1;
  return {
    sn: d.deviceSn ?? '',
    type: TYPE_LABEL[d.type ?? ''] ?? d.type,
    online: offline ? false : online ? true : undefined,
    state: offline ? 'offline' : alarm ? 'alarm' : online ? 'normal' : 'unknown',
    stateLabel: offline ? 'Offline' : alarm ? 'Alarm' : online ? 'Online' : undefined,
  };
}

function pushTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

async function loadFleetExtras(): Promise<FleetExtras> {
  const ids = [...rawById.keys()].map(Number);
  const out: FleetExtras = { devices: new Map(), rawDevices: new Map(), curves: new Map(), alerts: new Map() };
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  let ok = 0;
  await Promise.all([
    ...['INVERTER', 'BATTERY', 'COLLECTOR', 'METER'].map(async (t) => {
      const r = await api<{ data?: SmDevice[] }>(
        `/operating/system/device/${t}/list?page=1&size=500&sn=&order.direction=ASC&order.property=name`,
      ).catch(() => null);
      if (!r) return;
      ok++;
      for (const d of r.data ?? []) {
        if (d.siteId == null || !d.deviceSn) continue;
        pushTo(out.devices, String(d.siteId), toDevice(d));
        pushTo(out.rawDevices, String(d.siteId), d);
      }
    }),
    ...chunks.map(async (stationIds) => {
      const r = await api<SmCurve[]>('/history/power/day/overview', { stationIds }).catch(() => null);
      if (!r) return;
      ok++;
      for (const c of r) {
        out.curves.set(
          String(c.stationId),
          (c.generationPowerList ?? [])
            .filter((p) => p.dateTime != null)
            .map((p) => ({ t: Math.round(Number(p.dateTime)), powerW: Number(p.generationPower ?? 0) })),
        );
      }
    }),
    ...chunks.map(async (stationIds) => {
      const r = await api<SmLatestAlert[]>('/operating/station/alert/lastest/list', { stationIds }).catch(() => null);
      if (!r) return;
      ok++;
      for (const a of r) {
        // One row per plant; a plant with no alert comes back with all-null fields.
        if (!a.alertName || a.stationId == null || a.alertEndTime) continue;
        pushTo(out.alerts, String(a.stationId), {
          id: String(a.id ?? `${a.deviceSn}:${a.alertName}:${a.alertStartTime}`),
          name: a.alertName,
          deviceSn: a.deviceSn ?? undefined,
          start: a.alertStartTime != null ? Math.round(Number(a.alertStartTime)) : undefined,
          level: a.level != null ? String(a.level) : undefined,
        });
      }
    }),
  ]);
  // Nothing at all came back (token lapsed / portal down): throw so the cache
  // keeps serving the last good extras instead of caching emptiness.
  if (!ok) throw new Error('solarman_extras_unavailable');
  return out;
}

/** Cached fleet extras (5 min, stale-while-revalidate). Null until available. */
async function fleetExtras(): Promise<FleetExtras | null> {
  if (!rawById.size || !bearer) return null;
  return cached('scraper:solarman:extras', 300_000, loadFleetExtras, { swr: true }).catch(() => null);
}

// ─── Per-device facts (model, maker, battery SOC) ────────────────────────────

/**
 * The device lists carry no model. The portal's per-device "original data"
 * (the logger's raw register dump, `/device-s/device/originalData`) does, under
 * Solarman's standard keys: `5` = product model (e.g. "HYD 15KTL-3PH",
 * "BTS 5K"), `INV_MAN` = inverter maker, `B_left_cap1` = battery SOC (%).
 */
interface DeviceFacts {
  model?: string;
  maker?: string;
  soc?: number;
  /** Battery stack module serials (`B_P_SN1..n`). The portal lists each module as
   *  its own "Battery" row, but the device lists only return the stack itself. */
  packs?: string[];
  /** Battery control units (`BDU_SN`, `BDU_SN1..n`) — the portal lists these as
   *  "Battery <model>-BDU" rows; no device list returns them either. */
  bdus?: string[];
}

function deviceFacts(deviceId: number): Promise<DeviceFacts | null> {
  return cached(
    `scraper:solarman:devfacts:${deviceId}`,
    600_000,
    async () => {
      const o = await apiAt<Record<string, string>>(`${ORIGIN}/device-s`, `/device/originalData?deviceId=${deviceId}`);
      const str = (v?: string) => (v && v.trim() ? v.trim() : undefined);
      const soc = Number(o.B_left_cap1);
      return {
        model: str(o['5']) ?? str(o.PM1_AAC) ?? str(o.B_T),
        maker: str(o.INV_MAN),
        soc: o.B_left_cap1 != null && Number.isFinite(soc) && soc >= 0 && soc <= 100 ? soc : undefined,
        packs: Object.entries(o)
          .filter(([k, v]) => /^B_P_SN\d+$/.test(k) && str(v))
          .sort(([a], [b]) => Number(a.slice(6)) - Number(b.slice(6)))
          .map(([, v]) => v.trim()),
        bdus: Object.entries(o)
          .filter(([k, v]) => /^BDU_SN\d*$/.test(k) && str(v))
          .sort(([a], [b]) => Number(a.slice(6) || 0) - Number(b.slice(6) || 0))
          .map(([, v]) => v.trim()),
      };
    },
    { swr: true },
  ).catch(() => null);
}

/** Facts for a plant's inverters + batteries (loggers/meters carry no model). */
async function plantDeviceFacts(raw: SmDevice[]): Promise<Map<string, DeviceFacts>> {
  const out = new Map<string, DeviceFacts>();
  const wanted = raw.filter((d) => d.id != null && d.deviceSn && (d.type === 'INVERTER' || d.type === 'BATTERY')).slice(0, 12);
  await Promise.all(
    wanted.map(async (d) => {
      const f = await deviceFacts(d.id!);
      if (f) out.set(d.deviceSn!, f);
    }),
  );
  return out;
}

const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

// ─── Per-plant Overview (live flow, today's totals, day curve) ───────────────

interface SmRecord {
  generationPower?: number | null;
  usePower?: number | null;
  wirePower?: number | null; // grid-side power; direction in wireStatus
  gridPower?: number | null;
  batterySoc?: number | null;
  batteryPower?: number | null;
  wireStatus?: string | null; // PURCHASE | GRID | STATIC
  batteryStatus?: string | null; // CHARGE | DISCHARGE | STATIC
  dateTime?: number;
}
interface SmDayStats {
  generationValue?: number | null;
  useValue?: number | null;
  gridValue?: number | null; // exported
  buyValue?: number | null; // imported
  chargeValue?: number | null;
  dischargeValue?: number | null;
}

const num = (v: number | null | undefined): number | undefined =>
  v == null || Number.isNaN(Number(v)) ? undefined : Number(v);
const hhmm = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' });

async function overview(stationId: string): Promise<StationOverview> {
  if (!bearer) await solarmanScraperProvider.listStations(); // first open after a restart
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Brisbane' }));
  const r = await api<{ statistics?: SmDayStats; records?: SmRecord[] }>(
    `/history/power/${encodeURIComponent(stationId)}/record?year=${now.getFullYear()}&month=${now.getMonth() + 1}&day=${now.getDate()}`,
  );
  const recs = r.records ?? [];
  const last = recs[recs.length - 1];
  const st = r.statistics ?? {};
  const hasBattery = recs.some((x) => x.batterySoc != null);

  let flow: EnergyFlow | undefined;
  if (last) {
    const gridW = num(last.wirePower) ?? num(last.gridPower);
    const ws = (last.wireStatus || '').toUpperCase();
    const bs = (last.batteryStatus || '').toUpperCase();
    flow = {
      pvPowerW: num(last.generationPower),
      loadPowerW: num(last.usePower),
      gridPowerW: gridW != null ? Math.abs(gridW) : undefined,
      gridDirection: ws === 'PURCHASE' ? 'Import' : ws === 'GRID' ? 'Export' : undefined,
      batteryPowerW: hasBattery && last.batteryPower != null ? Math.abs(Number(last.batteryPower)) : undefined,
      batterySoc: num(last.batterySoc),
      batteryDirection: bs === 'CHARGE' ? 'Charging' : bs === 'DISCHARGE' ? 'Discharging' : bs === 'STATIC' ? 'Idle' : undefined,
      hasPv: true,
      hasGrid: gridW != null,
      hasBattery,
      todayPvEnergyKwh: num(st.generationValue),
      dataTime: last.dateTime ? hhmm(last.dateTime) : undefined,
    };
  }

  let powerCurve: ChartData | undefined;
  if (recs.length) {
    const series = [
      { name: 'PV', unit: 'W', data: recs.map((x) => num(x.generationPower) ?? null) },
      { name: 'Consumption', unit: 'W', data: recs.map((x) => num(x.usePower) ?? null) },
      ...(hasBattery
        ? [
            { name: 'Battery', unit: 'W', data: recs.map((x) => num(x.batteryPower) ?? null) },
            { name: 'SOC', unit: '%', secondaryAxis: true, data: recs.map((x) => num(x.batterySoc) ?? null) },
          ]
        : []),
    ].filter((s) => s.data.some((v) => v != null));
    powerCurve = { kind: 'line', xLabels: recs.map((x) => (x.dateTime ? hhmm(x.dateTime) : '')), series };
  }

  return {
    flow,
    stats: [
      { kind: 'pv', todayKwh: num(st.generationValue), totalKwh: rawById.get(stationId)?.generationTotal },
      ...(st.useValue != null ? [{ kind: 'load' as const, todayKwh: num(st.useValue) }] : []),
      ...(st.buyValue != null || st.gridValue != null
        ? [{ kind: 'grid' as const, todayKwh: num(st.buyValue), today2Kwh: num(st.gridValue) }]
        : []),
      ...(hasBattery ? [{ kind: 'battery' as const, todayKwh: num(st.chargeValue), today2Kwh: num(st.dischargeValue) }] : []),
    ],
    powerCurve,
  };
}

/** Build a rich detail page from the cached raw list record + fleet extras — no browser needed. */
async function detailFromList(stationId: string): Promise<NormalizedDetail | null> {
  const s = rawById.get(stationId);
  if (!s) return null;
  const extras = await fleetExtras();
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', statusLabel(s.networkStatus));
  push('Location', s.locationAddress);
  push('Installed capacity', s.installedCapacity != null ? `${s.installedCapacity} kWp` : undefined);
  push('Grid type', s.gridInterconnectionType ? GRID_TYPE_LABEL[s.gridInterconnectionType] ?? s.gridInterconnectionType : undefined);
  push('Plant type', s.type);
  push('Current power', s.generationPower != null ? `${s.generationPower} W` : undefined);
  push('Current consumption', s.usePower != null ? `${s.usePower} W` : undefined);
  push('Today', s.generationValue != null ? `${s.generationValue} kWh` : undefined);
  push('This month', s.generationMonth != null ? `${s.generationMonth} kWh` : undefined);
  push('This year', s.generationYear != null ? `${s.generationYear} kWh` : undefined);
  push('Total', s.generationTotal != null ? `${s.generationTotal} kWh` : undefined);
  push('Consumption this month', s.useMonth != null ? `${s.useMonth} kWh` : undefined);
  push('Full-power hours today', s.fullPowerHoursDay != null ? `${s.fullPowerHoursDay} h` : undefined);
  push('Commissioned', tsToDate(s.startOperatingTime));
  push('Owner', s.creatorName);
  push('NMI', s.nmi);
  push('Timezone', s.regionTimezone);
  push('Last update', tsToDate(s.lastUpdateTime));
  push('Station ID', s.id);

  // Enrich with per-device model / maker / battery SOC (cached, best-effort).
  const raw = extras?.rawDevices.get(stationId) ?? [];
  const facts = raw.length ? await plantDeviceFacts(raw) : new Map<string, DeviceFacts>();
  const ofType = (t: string) => raw.filter((d) => d.type === t).map((d) => facts.get(d.deviceSn ?? ''));
  const invFacts = ofType('INVERTER');
  const batFacts = ofType('BATTERY');
  const socs = invFacts.map((f) => f?.soc).filter((v): v is number => v != null);
  const batterySoc = socs.length ? Math.round(socs.reduce((a, b) => a + b, 0) / socs.length) : undefined;
  push('Manufacturer', uniq(invFacts.map((f) => f?.maker)).join(', '));
  push('Inverter model', uniq(invFacts.map((f) => f?.model)).join(', '));
  push('Battery model', uniq(batFacts.map((f) => f?.model)).join(', '));
  push('Battery SOC', batterySoc != null ? `${batterySoc}%` : undefined);

  const listed = (extras?.devices.get(stationId) ?? []).map((d) => {
    const model = facts.get(d.sn)?.model;
    return model && d.type ? { ...d, type: `${d.type} · ${model}` } : d;
  });
  // Battery stacks: the portal shows every module (B_P_SN*) and control unit
  // (BDU_SN*) of a stack as its own Battery row, but the device lists return
  // only the stack. A module can also have a stale standalone record (e.g.
  // offline since 2025) while its live stack reports it — the stack wins.
  const isBattery = (d: NormalizedDevice) => /^Battery/.test(d.type ?? '');
  const stackOf = new Map<string, NormalizedDevice>(); // module/BDU sn → its stack
  const claim = (sn: string, stack: NormalizedDevice) => {
    const cur = stackOf.get(sn);
    // Prefer an online stack's report over an offline one.
    if (!cur || (cur.online === false && stack.online !== false)) stackOf.set(sn, stack);
  };
  for (const d of listed.filter(isBattery)) {
    for (const sn of facts.get(d.sn)?.packs ?? []) if (sn !== d.sn) claim(sn, d);
  }
  const bduStack = new Map<string, NormalizedDevice>(); // bdu sn → stack
  for (const d of listed.filter(isBattery)) {
    for (const sn of facts.get(d.sn)?.bdus ?? []) {
      const cur = bduStack.get(sn);
      if (!cur || (cur.online === false && d.online !== false)) bduStack.set(sn, d);
    }
  }
  const asModule = (stack: NormalizedDevice, sn: string): NormalizedDevice => ({ ...stack, sn });
  const asBdu = (stack: NormalizedDevice, sn: string): NormalizedDevice => {
    const model = facts.get(stack.sn)?.model;
    return { ...stack, sn, type: model ? `Battery · ${model}-BDU` : 'Battery · BDU' };
  };

  // A listed battery that a live (online) stack claims as a module: take the stack's view.
  const fixed = listed.map((d) => {
    const owner = isBattery(d) ? stackOf.get(d.sn) : undefined;
    return owner && owner.online !== false && (d.online === false || !facts.get(d.sn)?.model) ? asModule(owner, d.sn) : d;
  });
  const seen = new Set(fixed.map((d) => d.sn));
  const devices: NormalizedDevice[] = [];
  for (const d of fixed) {
    devices.push(d);
    if (!isBattery(d) || stackOf.has(d.sn)) continue; // only expand real stacks
    for (const sn of facts.get(d.sn)?.bdus ?? []) {
      if (seen.has(sn) || bduStack.get(sn) !== d) continue;
      seen.add(sn);
      devices.push(asBdu(d, sn));
    }
    for (const sn of facts.get(d.sn)?.packs ?? []) {
      if (seen.has(sn) || stackOf.get(sn) !== d) continue;
      seen.add(sn);
      devices.push(asModule(d, sn));
    }
  }

  return {
    info,
    latest: {
      currentPowerW: s.generationPower,
      consumptionPowerW: s.usePower,
      dailyEnergyKwh: s.generationValue,
      monthlyEnergyKwh: s.generationMonth,
      totalEnergyKwh: s.generationTotal,
      batterySoc,
      lastUpdate: s.lastUpdateTime,
    },
    devices,
    alerts: extras?.alerts.get(stationId) ?? [],
    power: extras?.curves.get(stationId) ?? [],
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  // The plant page fires the search more than once: first filtered to the
  // account's OWN plants (`stationSource: 0`), then the full list including
  // plants shared from other accounts. Keeping whichever answered first made
  // the fleet flip between e.g. 44 and 57 plants. Collect every response and
  // keep the unfiltered one (or, failing that, the one with the most rows).
  const bodies: { body: string; filtered: boolean; rows: number }[] = [];

  await page.route(`**${SEARCH_MATCH}*`, (route) => {
    try {
      const u = new URL(route.request().url());
      u.searchParams.set('page', '1');
      u.searchParams.set('size', '200');
      void route.continue({ url: u.toString() });
    } catch {
      void route.continue();
    }
  });
  page.on('request', (req) => {
    const a = req.headers().authorization;
    if (a && req.url().includes('/maintain-s/')) bearer = a;
  });
  page.on('response', async (resp) => {
    if (!resp.url().includes(SEARCH_MATCH) || resp.status() !== 200) return;
    try {
      const text = await resp.text();
      const post = resp.request().postData() ?? '';
      const rows = ((JSON.parse(text) as { data?: unknown[] }).data ?? []).length;
      bodies.push({ body: text, filtered: /stationSource/.test(post), rows });
    } catch {
      /* ignore */
    }
  });

  await page.goto(PLANT_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/\/login/.test(page.url())) throw new SessionExpiredError('solarman');
  await page.waitForTimeout(3000);
  const best = bodies.find((b) => !b.filtered) ?? [...bodies].sort((a, b) => b.rows - a.rows)[0];
  if (!best) throw new Error('station list response not captured');

  const data = JSON.parse(best.body) as { total?: number; data?: { station: SolarmanStation }[] };
  const raws = (data.data ?? []).map((it) => it.station);
  rawById.clear();
  for (const s of raws) rawById.set(String(s.id), s);
  // Warm devices/curves/alerts in the background so plant pages and the alert
  // scan have them without waiting.
  void fleetExtras();
  return raws.map(toStation);
}

export const solarmanScraperProvider = createScraperProvider({
  id: 'solarman',
  name: 'Solarman Business',
  credKey: 'solarman',
  scrapeStations,
  detailFromList,
  overview,
});
