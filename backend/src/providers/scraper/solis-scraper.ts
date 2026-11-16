import type { Page } from 'playwright';
import { pickCoords } from '../coords.js';
import { cached } from '../cache.js';
import type {
  ChartData,
  EnergyFlow,
  NormalizedAlert,
  NormalizedDetail,
  NormalizedDevice,
  NormalizedStation,
  StationInfoItem,
  StationOverview,
  StationStatus,
} from '../types.js';
import { SessionExpiredError, withSession } from './browser.js';
import { createScraperProvider } from './scraper-provider.js';

/**
 * SolisCloud scraper (API access on hold). Rides the portal's own authenticated
 * POST /api/station/list, rewriting the body to pageSize=100 so one request
 * returns the whole fleet, then reads that JSON response.
 *
 * SolisCloud signs every request in its own JS ("wrong sign" on any replay), so
 * everything else also rides the app's calls:
 *  - devices + active alarms: the fleet-wide inverter / collector / alarm list
 *    pages, one background browser pass every 10 min (never blocks a request);
 *  - per-plant Overview (live flow, today's totals, day curve): the plant's own
 *    overview page, only when someone opens that plant.
 */

const OVERVIEW_URL = 'https://www.soliscloud.com/overview/plantStation';
const LIST_MATCH = '/api/station/list';

interface SolisStation {
  id: string;
  stationName?: string;
  state?: number; // 1 online, 2 offline, 3 alarm
  power?: number;
  powerStr?: string; // unit, e.g. "kW"
  dayEnergy?: number; // kWh
  monthEnergy?: number; // kWh
  allEnergy1?: number; // kWh all-time
  capacity?: number; // kWp
  addr?: string;
  dataTimestamp?: string; // ms
}

function mapState(state?: number): StationStatus {
  if (state === 1) return 'online';
  if (state === 3) return 'partial';
  if (state === 2) return 'offline';
  return 'unknown';
}

function powerToW(v?: number, unit?: string): number | undefined {
  if (v == null) return undefined;
  const u = (unit || 'W').toLowerCase();
  if (u.startsWith('mw')) return v * 1_000_000;
  if (u.startsWith('kw')) return v * 1000;
  return v;
}

function toStation(s: SolisStation): NormalizedStation {
  return {
    id: String(s.id),
    name: (s.stationName || `Station ${s.id}`).trim(),
    status: mapState(s.state),
    currentPowerW: powerToW(s.power, s.powerStr),
    dailyEnergyKwh: s.dayEnergy,
    monthlyEnergyKwh: s.monthEnergy,
    totalEnergyKwh: s.allEnergy1,
    capacityKw: s.capacity,
    location: s.addr,
    ...pickCoords(s),
    lastUpdate: s.dataTimestamp ? Math.floor(Number(s.dataTimestamp) / 1000) : undefined,
  };
}

async function scrapeStations(page: Page): Promise<NormalizedStation[]> {
  let body: string | null = null;

  await page.route(`**${LIST_MATCH}`, (route) => {
    try {
      const raw = route.request().postData() || '{}';
      const b = JSON.parse(raw);
      b.pageNo = 1;
      b.pageSize = 100;
      void route.continue({ postData: JSON.stringify(b) });
    } catch {
      void route.continue();
    }
  });
  page.on('response', async (resp) => {
    if (resp.url().includes(LIST_MATCH) && resp.status() === 200 && !body) {
      try {
        const t = await resp.text();
        if (t.includes('records') || t.includes('page')) body = t;
      } catch {
        /* ignore */
      }
    }
  });

  await page.goto(OVERVIEW_URL, { waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
  if (/login/i.test(page.url())) throw new SessionExpiredError('solis');
  await page.waitForTimeout(3500);
  if (!body) throw new Error('station list response not captured');

  const data = JSON.parse(body) as { data?: { records?: SolisStation[]; page?: { records?: SolisStation[] } } };
  const records = data.data?.records ?? data.data?.page?.records ?? [];
  return records.map(toStation);
}

// ─── Ride-along capture helper ───────────────────────────────────────────────

/**
 * Open `path` and capture the JSON `data` of the first response whose URL
 * contains `match`, rewriting its POST body to one big page when `pageSize` is set.
 */
async function capture<T>(page: Page, path: string, match: string, pageSize?: number): Promise<T | null> {
  let data: T | null = null;
  if (pageSize) {
    await page.route(`**${match}`, (route) => {
      try {
        const b = JSON.parse(route.request().postData() || '{}');
        b.pageNo = 1;
        b.pageSize = pageSize;
        void route.continue({ postData: JSON.stringify(b) });
      } catch {
        void route.continue();
      }
    });
  }
  const done = page
    .waitForResponse((r) => r.url().includes(match) && r.status() === 200, { timeout: 40_000 })
    .then(async (r) => {
      data = ((await r.json()) as { data?: T }).data ?? null;
    })
    .catch(() => {});
  await page.goto(`https://www.soliscloud.com${path}`, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
  if (/login/i.test(page.url())) throw new SessionExpiredError('solis');
  await done;
  if (pageSize) await page.unroute(`**${match}`).catch(() => {});
  return data;
}

type Paged<T> = { records?: T[]; page?: { records?: T[] } };
const recordsOf = <T,>(d: Paged<T> | null): T[] => d?.records ?? d?.page?.records ?? [];

// ─── Fleet devices + active alarms (background, every 10 min) ────────────────

interface SolisInverter {
  sn?: string;
  stationId?: string;
  state?: number; // 1 online, 2 offline, 3 alarm
  productModel?: string;
  model?: string;
}
interface SolisCollector {
  sn?: string;
  stationId?: string;
  state?: number; // 1 online, 2 offline
}
interface SolisAlarm {
  id?: string;
  stationId?: string;
  alarmDeviceSn?: string;
  sn?: string;
  alarmCode?: string;
  code?: string;
  alarmLevel?: string | number;
  alarmMsg?: string;
  alarmName?: string;
  alarmBeginTime?: number | string;
  advice?: string;
  state?: string | number;
}
interface SolisExtras {
  devices: Map<string, NormalizedDevice[]>;
  alarms: Map<string, NormalizedAlert[]>;
}

function solisDevice(sn: string, type: string, state?: number): NormalizedDevice {
  const st = state === 1 ? 'normal' : state === 2 ? 'offline' : state === 3 ? 'alarm' : 'unknown';
  return {
    sn,
    type,
    online: st === 'offline' ? false : st === 'unknown' ? undefined : true,
    state: st,
    stateLabel: { normal: 'Online', offline: 'Offline', alarm: 'Alarm', unknown: undefined }[st],
  };
}

function addTo<T>(m: Map<string, T[]>, k: string, v: T): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

/** Last good extras, served instantly; refreshed in the background. */
let extras: SolisExtras | null = null;

async function loadExtras(): Promise<SolisExtras> {
  // pageSize 100: SolisCloud returns an EMPTY page for larger sizes on some lists (collectors at 500).
  return withSession('solis', async (page) => {
    const inverters = await capture<Paged<SolisInverter>>(page, '/overview/device/details/inverter', '/api/inverter/index/list', 100);
    const collectors = await capture<Paged<SolisCollector>>(page, '/overview/device/details/collector', '/api/collector/listV2', 100);
    const alarms = await capture<Paged<SolisAlarm>>(page, '/overview/alarm/inverterAlarm', '/api/alarm/list', 100);
    if (!inverters && !collectors) throw new Error('solis_devices_not_captured');
    const out: SolisExtras = { devices: new Map(), alarms: new Map() };
    for (const d of recordsOf(inverters)) if (d.sn && d.stationId) addTo(out.devices, String(d.stationId), solisDevice(d.sn, 'Inverter', d.state));
    for (const d of recordsOf(collectors)) if (d.sn && d.stationId) addTo(out.devices, String(d.stationId), solisDevice(d.sn, 'Logger', d.state));
    for (const a of recordsOf(alarms)) {
      if (!a.stationId) continue;
      const begin = a.alarmBeginTime != null ? Number(a.alarmBeginTime) : undefined;
      addTo(out.alarms, String(a.stationId), {
        id: String(a.id ?? `${a.alarmDeviceSn ?? a.sn}:${a.alarmCode ?? a.code}:${begin}`),
        name: a.alarmMsg || a.alarmName || `Alarm ${a.alarmCode ?? a.code ?? ''}`.trim(),
        code: a.alarmCode ?? a.code,
        deviceSn: a.alarmDeviceSn ?? a.sn,
        start: begin != null && Number.isFinite(begin) ? Math.round(begin > 1e12 ? begin / 1000 : begin) : undefined,
        level: a.alarmLevel != null ? String(a.alarmLevel) : undefined,
        solution: a.advice || undefined,
      });
    }
    extras = out;
    return out;
  });
}

function refreshExtras(): void {
  cached('scraper:solis:extras', 600_000, loadExtras, { swr: true }).catch(() => {});
}

/** Detail from the cached station list + last good device/alarm lists (never blocks on a browser). */
function detailFromList(stationId: string, stations: NormalizedStation[]): NormalizedDetail | null {
  refreshExtras();
  const s = stations.find((x) => x.id === stationId);
  if (!s) return null;
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', s.status);
  push('Location', s.location);
  push('Installed capacity', s.capacityKw != null ? `${s.capacityKw} kWp` : undefined);
  push('Today', s.dailyEnergyKwh != null ? `${s.dailyEnergyKwh} kWh` : undefined);
  push('This month', s.monthlyEnergyKwh != null ? `${s.monthlyEnergyKwh} kWh` : undefined);
  push('Total', s.totalEnergyKwh != null ? `${s.totalEnergyKwh} kWh` : undefined);
  push('Station ID', s.id);
  return {
    info,
    latest: {
      currentPowerW: s.currentPowerW,
      dailyEnergyKwh: s.dailyEnergyKwh,
      monthlyEnergyKwh: s.monthlyEnergyKwh,
      totalEnergyKwh: s.totalEnergyKwh,
      lastUpdate: s.lastUpdate,
    },
    devices: extras?.devices.get(stationId) ?? [],
    alerts: extras?.alarms.get(stationId) ?? [],
    power: [],
  };
}

// ─── Per-plant Overview ──────────────────────────────────────────────────────

type DetailMix = Record<string, unknown> & {
  smartEnergyConfig?: { currStrategyName?: string };
  stationModuleShow?: { batteryShow?: boolean; gridShow?: boolean; loadShow?: boolean };
};
interface SolisDayChart {
  time?: number[];
  power?: number[];
  totalAndSmartLoadPowerList?: number[];
  familyLoadPowerList?: number[];
  batteryPower?: number[];
  batteryCapacitySocList?: number[];
  psum?: number[];
}

const f = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
/** Energy value + its unit string ("kWh" / "MWh") → kWh. */
const kwh = (v: unknown, unit: unknown): number | undefined => {
  const n = f(v);
  if (n == null) return undefined;
  const u = String(unit ?? 'kWh').toLowerCase();
  return u.startsWith('gwh') ? n * 1e6 : u.startsWith('mwh') ? n * 1000 : n;
};
/** Power value + unit ("kW"/"W") → W. */
const watts = (v: unknown, unit: unknown): number | undefined => {
  const n = f(v);
  if (n == null) return undefined;
  const u = String(unit ?? 'kW').toLowerCase();
  return u.startsWith('mw') ? n * 1e6 : u.startsWith('kw') ? n * 1000 : n;
};

async function overview(stationId: string): Promise<StationOverview> {
  const { dm, chart } = await withSession('solis', async (page) => {
    let chartData: SolisDayChart | null = null;
    const chartDone = page
      .waitForResponse((r) => r.url().includes('/api/chart/station/day/v2') && r.status() === 200, { timeout: 40_000 })
      .then(async (r) => {
        chartData = ((await r.json()) as { data?: SolisDayChart }).data ?? null;
      })
      .catch(() => {});
    const dm = await capture<DetailMix>(page, `/overview/plantStation/details/overview/${encodeURIComponent(stationId)}`, '/api/station/detailMix');
    await chartDone;
    return { dm, chart: chartData as SolisDayChart | null };
  });
  if (!dm) throw new Error('solis_overview_not_captured');

  // Signs (verified: PV + battery discharge + grid import = load): battery
  // negative = discharging; psum (grid) negative = importing.
  const battW = f(dm.batteryPowerOrigin) ?? watts(dm.batteryPower, dm.batteryPowerStr);
  const gridW = f(dm.psumOrgin) ?? watts(dm.psum, dm.psumStr);
  const show = dm.stationModuleShow ?? {};
  const hasBattery = Boolean(show.batteryShow) || (f(dm.batteryCount) ?? 0) > 0;

  const flow: EnergyFlow = {
    pvPowerW: f(dm.pvAndAcCoupledPowerOrigin) ?? watts(dm.power, dm.powerStr),
    loadPowerW: f(dm.totalLoadPowerOrigin) ?? watts(dm.totalLoadPower, dm.totalLoadPowerStr),
    gridPowerW: gridW != null ? Math.abs(gridW) : undefined,
    gridDirection: gridW == null || gridW === 0 ? undefined : gridW < 0 ? 'Import' : 'Export',
    batteryPowerW: hasBattery && battW != null ? Math.abs(battW) : undefined,
    batterySoc: hasBattery ? f(dm.batteryPercent) : undefined,
    batteryDirection: !hasBattery || battW == null ? undefined : battW === 0 ? 'Idle' : battW < 0 ? 'Discharging' : 'Charging',
    hasPv: true,
    hasGrid: show.gridShow !== false && gridW != null,
    hasBattery,
    todayPvEnergyKwh: kwh(dm.dayEnergy, dm.dayEnergyStr),
    dataTime: typeof dm.dataTimestampStr === 'string' ? dm.dataTimestampStr.replace(/\s*\(UTC.*\)$/, '') : undefined,
  };

  let powerCurve: ChartData | undefined;
  const t = chart?.time ?? [];
  if (t.length) {
    const lbl = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' });
    const s = (name: string, unit: string, data?: number[], secondaryAxis = false) =>
      data?.length ? { name, unit, secondaryAxis, data: data.map((v) => f(v) ?? null) } : null;
    powerCurve = {
      kind: 'line',
      xLabels: t.map(lbl),
      series: [
        s('PV', 'W', chart?.power),
        s('Consumption', 'W', chart?.totalAndSmartLoadPowerList ?? chart?.familyLoadPowerList),
        s('Grid', 'W', chart?.psum),
        ...(hasBattery ? [s('Battery', 'W', chart?.batteryPower), s('SOC', '%', chart?.batteryCapacitySocList, true)] : []),
      ].filter((x): x is NonNullable<typeof x> => x != null && x.data.some((v) => v != null && v !== 0)),
    };
  }

  return {
    flow,
    stats: [
      { kind: 'pv', todayKwh: kwh(dm.dayEnergy, dm.dayEnergyStr), totalKwh: kwh(dm.allEnergy, dm.allEnergyStr) },
      { kind: 'load', todayKwh: kwh(dm.homeLoadTodayEnergy, dm.homeLoadTodayEnergyStr), totalKwh: kwh(dm.homeLoadTotalEnergy, dm.homeLoadTotalEnergyStr) },
      {
        kind: 'grid',
        todayKwh: kwh(dm.gridPurchasedDayEnergy, dm.gridPurchasedDayEnergyStr),
        totalKwh: kwh(dm.gridPurchasedTotalEnergy, dm.gridPurchasedTotalEnergyStr),
        today2Kwh: kwh(dm.gridSellDayEnergy, dm.gridSellDayEnergyStr),
        total2Kwh: kwh(dm.gridSellTotalEnergy, dm.gridSellTotalEnergyStr),
      },
      ...(hasBattery
        ? [{
            kind: 'battery' as const,
            todayKwh: kwh(dm.batteryChargeEnergy, dm.batteryChargeEnergyStr),
            totalKwh: kwh(dm.batteryChargeTotalEnergy, dm.batteryChargeTotalEnergyStr),
            today2Kwh: kwh(dm.batteryDischargeEnergy, dm.batteryDischargeEnergyStr),
            total2Kwh: kwh(dm.batteryDischargeTotalEnergy, dm.batteryDischargeTotalEnergyStr),
          }]
        : []),
    ],
    powerCurve,
    strategy: dm.smartEnergyConfig?.currStrategyName || undefined,
  };
}

export const solisScraperProvider = createScraperProvider({
  id: 'solis',
  name: 'SolisCloud',
  credKey: 'solis',
  scrapeStations,
  detailFromList,
  overview,
});
