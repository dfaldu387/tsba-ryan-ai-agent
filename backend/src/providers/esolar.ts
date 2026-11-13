import crypto from 'node:crypto';
import { portalCreds } from './scraper/credentials.js';
import { cached } from './cache.js';
import {
  ProviderError,
  type ChartData,
  type ChartSeries,
  type EnergyFlow,
  type EnergyStat,
  type Environmental,
  type NormalizedAlert,
  type NormalizedDetail,
  type NormalizedDevice,
  type NormalizedStation,
  type SelfUseBreakdown,
  type SolarProvider,
  type StationInfoItem,
  type StationOverview,
  type StationStatus,
} from './types.js';

/**
 * SAJ / Elekeeper (eSolar) — the portal's own JSON API over plain HTTPS, NO
 * headless browser. Replaces the Chromium scraper: we replicate the SPA's login
 * (AES-128-ECB password) and request signing (HMAC-SHA256), both using constants
 * shipped in the public web bundle, then call the same v2 endpoints the scraper
 * used to ride. Uses the same account credentials as the scraper (credKey
 * 'elekeeper'), so no new config is needed.
 *
 * Region host defaults to the international node (iop.saj-electric.com) and can
 * be overridden with ELEKEEPER_PORTAL_URL (e.g. eop for Europe).
 */

const PORTAL = (process.env.ELEKEEPER_PORTAL_URL || 'https://iop.saj-electric.com').replace(/\/+$/, '');
const API = `${PORTAL}/dev-api/api/v2`;

// Constants from the public SPA bundle — obfuscation, not secrecy (TLS protects
// the real password). The AES key encrypts the password; the HMAC secret signs
// each request.
const PWD_KEY = Buffer.from('ec1840a7c53cf0709eb784be480379b6', 'hex');
const SIGN_SECRET = 'b389a704-31f1-463d-8db7-435b18d1311d';

function encryptPassword(pwd: string): string {
  const c = crypto.createCipheriv('aes-128-ecb', PWD_KEY, null); // PKCS7 auto-padding
  return Buffer.concat([c.update(pwd, 'utf8'), c.final()]).toString('hex');
}

function nonce(len = 16): string {
  const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

interface Envelope<T> {
  errCode?: number | string;
  code?: number | string;
  errMsg?: string;
  msg?: string;
  data?: T;
}

function envOk(e: Envelope<unknown>): boolean {
  const code = e.errCode ?? e.code;
  return code === 0 || code === '0';
}
function envCode(e: Envelope<unknown>): string {
  return String(e.errCode ?? e.code ?? '');
}

/** Common body fields the SPA attaches to every request. */
function commonBody(): Record<string, unknown> {
  return {
    appProjectName: 'elekeeper',
    // Date-only (YYYY-MM-DD), matching the SPA. The chart endpoints reject a full
    // ISO datetime here with "Incorrect date format"; date-only is accepted by all.
    clientDate: new Date().toISOString().slice(0, 10),
    lang: 'en',
    timeStamp: Date.now(),
    clientId: 'esolar-monitor-admin',
    clientCode: 'organization',
  };
}

/**
 * Build the signed headers + exact raw body string for a v2 request. The server
 * verifies X-Sign = HMAC-SHA256 over the x-* headers (minus a few), md5(body),
 * the nonce and the timestamp — so the body we hash must be byte-identical to
 * what we send.
 */
function sign(payload: Record<string, unknown>, token?: string): { headers: Record<string, string>; body: string } {
  const bodyObj: Record<string, unknown> = { ...commonBody(), ...payload };
  for (const k of Object.keys(bodyObj)) if (bodyObj[k] === '' || bodyObj[k] == null) delete bodyObj[k];
  const raw = JSON.stringify(bodyObj);

  const ts = String(Date.now());
  const traceId = nonce(16);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json;charset=UTF-8',
    'X-App-Project-Name': 'elekeeper',
    'X-Client-Code': 'organization',
    'X-Client-Date': new Date().toISOString(),
    'X-Lang': 'en',
    'X-Timestamp': ts,
    'X-Trace-Id': traceId,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Signature base: x-* headers (except volatile/sign ones), stripped of 'x-',
  // plus body=md5(raw); sorted k=v joined by &; then nonce + timestamp.
  const skip = new Set(['x-timestamp', 'x-trace-id', 'x-sign', 'x-sign-enable']);
  const parts: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('x-') && !skip.has(lk)) parts[lk.slice(2)] = v;
  }
  parts.body = crypto.createHash('md5').update(raw).digest('hex');
  const base = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${parts[k]}`)
    .join('&');
  const signStr = `${base}&nonce=${traceId}&timestamp=${ts}`;
  headers['X-Sign'] = crypto.createHmac('sha256', SIGN_SECRET).update(signStr).digest('hex');
  return { headers, body: raw };
}

let token: { value: string; expiresAt: number } | null = null;

function creds(): { username: string; password: string } {
  const c = portalCreds('elekeeper');
  if (!c) throw new ProviderError('elekeeper_not_configured: no SAJ credentials (login file or SCRAPER_ELEKEEPER_USER/PASS)');
  return { username: c.username, password: c.password };
}

async function login(): Promise<string> {
  const { username, password } = creds();
  const { headers, body } = sign({ username, password: encryptPassword(password), loginType: 1, rememberMe: false });
  const res = await fetch(`${API}/sys/user/login`, { method: 'POST', headers, body }).catch((err) => {
    throw new ProviderError(`elekeeper_network_error: ${(err as Error).message}`);
  });
  const data = (await res.json().catch(() => ({}))) as Envelope<{ token?: string; access_token?: string }>;
  const tok = (data.data?.token ?? data.data?.access_token ?? '').replace(/^Bearer\s+/i, '');
  if (!envOk(data) || !tok) {
    throw new ProviderError(`elekeeper_auth_failed: ${data.errMsg || data.msg || `HTTP ${res.status}`}`, envCode(data));
  }
  token = { value: tok, expiresAt: Date.now() + 6 * 24 * 3_600_000 }; // ~7d token, refresh early
  return tok;
}

async function getToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt > Date.now()) return token.value;
  return login();
}

/** Signed POST to a v2 endpoint; re-logs in once on an expired-session code. */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const run = async (t: string): Promise<Envelope<T>> => {
    const { headers, body } = sign(payload, t);
    const res = await fetch(`${API}${path}`, { method: 'POST', headers, body }).catch((err) => {
      throw new ProviderError(`elekeeper_network_error: ${(err as Error).message}`);
    });
    return (await res.json().catch(() => ({}))) as Envelope<T>;
  };
  let data = await run(await getToken());
  // 10002 = session expired; also retry on any token/auth-ish failure.
  if (!envOk(data) && /10002|token|login|auth|expire/i.test(`${envCode(data)} ${data.errMsg || data.msg || ''}`)) {
    data = await run(await getToken(true));
  }
  if (!envOk(data) && data.data == null) {
    throw new ProviderError(`elekeeper_request_failed (${path}): ${data.errMsg || data.msg || 'error'}`, envCode(data));
  }
  return (data.data ?? ({} as T)) as T;
}

// ─── Shapes + mapping (mirrors the former scraper, same normalized output) ───

interface SajPlant {
  plantUid: string;
  plantNo?: string;
  plantName?: string;
  pvCapacity?: number;
  pvPower?: number;
  runningState?: number;
  runningStateName?: string;
  batSoc?: number;
  batCapacity?: number;
  batModel?: string;
  inverterNum?: number;
  inverterModel?: string;
  todayPvEnergy?: number;
  totalPvEnergy?: number;
  todayEquivalentHours?: number;
  address?: string;
  activationTime?: string;
  installerName?: string;
  ownerName?: string;
  ownerPhone?: string;
  alarmInfo?: string;
}

function mapState(state?: number, name?: string): StationStatus {
  if (state === 1) return 'online';
  if (state === 2) return 'partial';
  if (state === 0 || state === 3) return 'offline';
  const n = (name || '').toLowerCase();
  if (n.includes('normal') || n.includes('online')) return 'online';
  if (n.includes('alarm') || n.includes('fault') || n.includes('partial')) return 'partial';
  if (n.includes('offline') || n.includes('disconnect')) return 'offline';
  return 'unknown';
}

function toStation(p: SajPlant): NormalizedStation {
  return {
    id: String(p.plantUid),
    name: (p.plantName || p.plantNo || p.plantUid).trim(),
    status: mapState(p.runningState, p.runningStateName),
    currentPowerW: p.pvPower,
    dailyEnergyKwh: p.todayPvEnergy,
    totalEnergyKwh: p.totalPvEnergy,
    capacityKw: p.pvCapacity,
    batterySoc: p.batSoc,
    location: p.address,
    owner: p.ownerName || undefined,
    contact: p.ownerPhone || undefined,
  };
}

const rawById = new Map<string, SajPlant>();

interface SajDeviceNode {
  deviceSn?: string;
  deviceName?: string;
  deviceModel?: string;
  aliasName?: string;
  deviceStatus?: number;
  children?: SajDeviceNode[];
}
function flattenDevices(nodes: SajDeviceNode[], out: NormalizedDevice[] = []): NormalizedDevice[] {
  for (const n of nodes) {
    const sn = n.deviceSn || n.aliasName;
    if (sn) out.push({ sn, type: n.deviceName || n.deviceModel || undefined, online: n.deviceStatus === 1 });
    if (n.children?.length) flattenDevices(n.children, out);
  }
  return out;
}

interface SajAlarm {
  alarmId?: string | number;
  alarmID?: string | number;
  id?: string | number;
  alarmName?: string;
  alarmCauses?: string;
  alarmContent?: string;
  alarmMsg?: string;
  /** Numbered remediation steps, ';'-separated, e.g. "1. Check …;2. Check …". */
  solutions?: string;
  deviceSn?: string;
  deviceTypeName?: string;
  alarmCode?: string;
  /** Portal "Alarm Code" (e.g. "51"); the API has no separate alarmCode field. */
  eventNo?: string | number;
  /** Handling state: alarmState 1 = Pending, and alarmStateName is its label. */
  alarmState?: number;
  alarmStateName?: string;
  // SAJ returns US-format datetimes, e.g. "11/11/2026 00:31:33".
  alarmStartTime?: string;
  alarmUpdateTime?: string;
  startTime?: string;
  alarmLevelName?: string;
  alarmLevel?: number;
  alarmDuration?: string;
}

/**
 * Tidy SAJ's `solutions` string into one step per line. SAJ ships numbered steps
 * joined by ';' ("1. …;2. …") with stray double-spaces around emphasised terms;
 * we collapse the whitespace and break before each "<n>." so the steps render as
 * a readable list in the UI and emails. Returns undefined for an empty value.
 */
function formatSolution(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  const steps = cleaned
    .replace(/;\s*(?=\d+\.\s)/g, '\n') // break before "2." etc.
    .replace(/\s*;\s*$/, '') // drop a trailing ';'
    .trim();
  return steps;
}

/** Parse a SAJ datetime to epoch seconds. SAJ sends US format
 *  ("MM/DD/YYYY HH:MM:SS"); also accepts ISO and numeric epochs. */
function sajTimeToEpochSec(v?: string | number): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : n; // ms → s
  }
  const s = String(v).trim();
  let t = Date.parse(s); // handles "MM/DD/YYYY HH:MM:SS" (US) natively
  if (Number.isNaN(t)) t = Date.parse(s.replace(' ', 'T')); // handles "YYYY-MM-DD HH:MM:SS"
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function infoFromPlant(p: SajPlant): StationInfoItem[] {
  const info: StationInfoItem[] = [];
  const push = (label: string, v: string | number | undefined | null) => {
    if (v != null && v !== '') info.push({ label, value: String(v) });
  };
  push('Status', p.runningStateName);
  push('Location', p.address);
  push('Owner', p.ownerName);
  push('Contact', p.ownerPhone);
  push('Installed capacity', p.pvCapacity != null ? `${p.pvCapacity} kWp` : undefined);
  push('Today', p.todayPvEnergy != null ? `${p.todayPvEnergy} kWh` : undefined);
  push('Total', p.totalPvEnergy != null ? `${p.totalPvEnergy} kWh` : undefined);
  push('Battery SOC', p.batSoc != null ? `${p.batSoc}%` : undefined);
  push('Battery capacity', p.batCapacity != null ? `${p.batCapacity} kWh` : undefined);
  push('Battery model', p.batModel);
  push('Inverters', p.inverterNum);
  push('Inverter model', p.inverterModel);
  push('Installer', p.installerName);
  push('Commissioned', p.activationTime);
  push('Plant ID', p.plantNo);
  return info;
}

async function listStationsRaw(): Promise<SajPlant[]> {
  const data = await post<{ rows?: SajPlant[]; list?: SajPlant[]; records?: SajPlant[] }>(
    '/monitor/plant/userPlantPage',
    { pageNo: 1, pageSize: 300 },
  );
  return data.rows ?? data.list ?? data.records ?? [];
}

// ─── Rich Overview (detail dashboard) ────────────────────────────────────────
// The SAJ plant-detail page keys its flow/KPI/chart calls on the plant's master
// inverter serial (`sn` + snType:1), fetched from the capability endpoint. Passing
// plantUid alone returns null — the sn is required. See docs/saj-overview-endpoints.json.

interface SajCapability {
  // NB: masterInverterSerial is a MODEL code here (e.g. "h21030k"), NOT a serial —
  // don't use it as `sn`. The real inverter serial is in invreterSnList / snList[].sn.
  masterInverterSerial?: string;
  snList?: Array<{ sn?: string; snType?: number; inverterTag?: string }>;
  invreterSnList?: string[];
}

/** The plant's inverter serial + snType, needed as the `sn` key for flow/stats/charts. */
async function inverterSn(stationId: string): Promise<{ sn: string; snType: number } | undefined> {
  try {
    const cap = await post<SajCapability>('/monitor/plant/getPlantCapabilityV3', {
      plantUid: stationId,
      versionOf3d: 1,
    });
    const first = cap.snList?.find((d) => d.sn);
    const sn = first?.sn || cap.invreterSnList?.[0];
    if (!sn) return undefined;
    return { sn, snType: first?.snType ?? 1 };
  } catch {
    return undefined;
  }
}

interface SajFlow {
  totalPvPower?: number;
  totalLoadPowerwatt?: number;
  sysGridPowerwatt?: number;
  batPower?: number;
  batEnergyPercent?: number;
  batteryDirectionName?: string;
  gridDirectionName?: string;
  genPowerwatt?: number;
  hasPv?: number;
  hasGrid?: number;
  hasBattery?: number;
  hasGen?: number;
  systemPower?: number;
  runningStateName?: string;
  userModeName?: string;
  todayPvEnergy?: number;
  dataTime?: string;
}

function mapFlow(f: SajFlow): EnergyFlow {
  return {
    pvPowerW: f.totalPvPower,
    loadPowerW: f.totalLoadPowerwatt,
    gridPowerW: f.sysGridPowerwatt,
    batteryPowerW: f.batPower,
    batterySoc: f.batEnergyPercent,
    batteryDirection: f.batteryDirectionName || undefined,
    gridDirection: f.gridDirectionName || undefined,
    hasPv: f.hasPv === 1,
    hasGrid: f.hasGrid === 1,
    hasBattery: f.hasBattery === 1,
    hasGenerator: f.hasGen === 1,
    generatorPowerW: f.genPowerwatt,
    systemPowerKw: f.systemPower,
    runningState: f.runningStateName || undefined,
    userMode: f.userModeName || undefined,
    todayPvEnergyKwh: f.todayPvEnergy,
    dataTime: f.dataTime || undefined,
  };
}

interface SajEnergyDatum {
  dataType?: string;
  energy1Today?: number | null;
  energy1Total?: number | null;
  energy2Today?: number | null;
  energy2Total?: number | null;
  selfUsePercentage?: number | null;
}
interface SajStatistics {
  energyDataList?: SajEnergyDatum[];
  environmentalInformation?: unknown;
  userModeName?: string;
}

function mapStats(list: SajEnergyDatum[]): EnergyStat[] {
  const out: EnergyStat[] = [];
  const num = (v: number | null | undefined) => (v == null ? undefined : v);
  for (const d of list) {
    const t = (d.dataType || '').toUpperCase();
    if (t.includes('PV')) {
      out.push({ kind: 'pv', todayKwh: num(d.energy1Today), totalKwh: num(d.energy1Total), selfUsePercentage: num(d.selfUsePercentage) });
    } else if (t.includes('LOAD')) {
      out.push({ kind: 'load', todayKwh: num(d.energy1Today), totalKwh: num(d.energy1Total) });
    } else if (t.includes('BUY') || t.includes('SELL') || t.includes('GRID')) {
      // energy1 = buy/import, energy2 = sell/export
      out.push({ kind: 'grid', todayKwh: num(d.energy1Today), totalKwh: num(d.energy1Total), today2Kwh: num(d.energy2Today), total2Kwh: num(d.energy2Total) });
    } else if (t.includes('BAT') || t.includes('CHARGE')) {
      // energy1 = charge, energy2 = discharge
      out.push({ kind: 'battery', todayKwh: num(d.energy1Today), totalKwh: num(d.energy1Total), today2Kwh: num(d.energy2Today), total2Kwh: num(d.energy2Total) });
    }
  }
  // Stable card order.
  const order: Record<EnergyStat['kind'], number> = { pv: 0, load: 1, grid: 2, battery: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** Pull CO2/trees/coal from the statistics' environmentalInformation, whatever
 *  shape it takes (array of {name,value} or a flat object). Best-effort. */
function mapEnvironmental(env: unknown): Environmental | undefined {
  if (!env) return undefined;
  const pick = (re: RegExp): number | undefined => {
    const scan = (entries: [string, unknown][]) => {
      for (const [k, v] of entries) {
        if (re.test(k)) {
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          if (!Number.isNaN(n)) return n;
        }
      }
      return undefined;
    };
    if (Array.isArray(env)) {
      // SAJ shape: [{describe:"CO₂ emissions reduced (t)", value, unit, iconUrl}, …].
      const pairs = env
        .map((e) => {
          const o = e as Record<string, unknown>;
          const key = String(o.describe ?? o.name ?? o.label ?? o.key ?? o.type ?? '');
          return [key, o.value ?? o.num ?? o.data] as [string, unknown];
        })
        .filter(([k]) => k);
      return scan(pairs);
    }
    if (typeof env === 'object') return scan(Object.entries(env as Record<string, unknown>));
    return undefined;
  };
  const co2 = pick(/co2|carbon|reduceCo2|emission/i);
  const trees = pick(/tree|forest|plant/i);
  const coal = pick(/coal/i);
  if (co2 == null && trees == null && coal == null) return undefined;
  return { co2SavedT: co2, treesEquivalent: trees, coalSavedT: coal };
}

interface SajSelfUse {
  pvEnergy?: number; loadEnergy?: number; sellEnergy?: number; buyEnergy?: number;
  chargeEnergy?: number; dischargeEnergy?: number;
  pvSelfConsumedEnergy?: number; loadSelfConsumedEnergy?: number;
  pvSelfConsumedRate?: number; pvSellRate?: number;
  loadSelfConsumedRate?: number; loadBuyRate?: number;
  energyUnit?: string;
}
function mapSelfUse(s: SajSelfUse): SelfUseBreakdown {
  return {
    pvEnergy: s.pvEnergy, loadEnergy: s.loadEnergy, sellEnergy: s.sellEnergy, buyEnergy: s.buyEnergy,
    chargeEnergy: s.chargeEnergy, dischargeEnergy: s.dischargeEnergy,
    pvSelfConsumedEnergy: s.pvSelfConsumedEnergy, loadSelfConsumedEnergy: s.loadSelfConsumedEnergy,
    pvSelfConsumedRate: s.pvSelfConsumedRate, pvSellRate: s.pvSellRate,
    loadSelfConsumedRate: s.loadSelfConsumedRate, loadBuyRate: s.loadBuyRate,
    unit: s.energyUnit,
  };
}

interface SajChart {
  showType?: string;
  xAxis?: { coordinateList?: string[] };
  yAxis?: Array<{ dataList?: string[]; color?: string; groupName?: string; legendName?: string; tagName?: string; unit?: string }>;
}
function mapChart(c: SajChart): ChartData | undefined {
  const x = c.xAxis?.coordinateList ?? [];
  const ys = c.yAxis ?? [];
  if (!x.length || !ys.length) return undefined;
  const series: ChartSeries[] = ys.map((y) => {
    const unit = y.unit || '';
    return {
      name: y.groupName || y.tagName || y.legendName || 'Series',
      color: y.color || undefined,
      unit,
      secondaryAxis: /%/.test(unit) || /soc/i.test(y.groupName || y.tagName || ''),
      data: (y.dataList ?? []).map((v) => (v === '' || v == null ? null : Number(v))),
    };
  });
  return { kind: c.showType === 'line' ? 'line' : 'bar', xLabels: x, series };
}

const todayStr = () => new Date().toISOString().slice(0, 10);

export const esolarProvider: SolarProvider = {
  id: 'elekeeper',
  name: 'Elekeeper (SAJ)',
  configured: () => Boolean(portalCreds('elekeeper')),

  async listStations(): Promise<NormalizedStation[]> {
    const list = await cached('elekeeper:plants', 60_000, listStationsRaw);
    rawById.clear();
    for (const p of list) rawById.set(String(p.plantUid), p);
    return list.map(toStation);
  },

  async stationDetail(stationId: string): Promise<NormalizedDetail> {
    const p = rawById.get(stationId);
    const info = p ? infoFromPlant(p) : [];

    // Devices (inverter tree) + active alarms — best-effort each.
    let devices: NormalizedDevice[] = [];
    try {
      const tree = await post<SajDeviceNode[]>('/monitor/plantDevice/listForWeb', { plantUid: stationId });
      devices = flattenDevices(Array.isArray(tree) ? tree : []);
    } catch {
      /* device list unavailable */
    }

    let alerts: NormalizedAlert[] = [];
    try {
      const a = await post<{ rows?: SajAlarm[]; list?: SajAlarm[]; records?: SajAlarm[] }>(
        '/devicedata/alarm/device/userAlarmPage',
        { plantUid: stationId, pageNo: 1, pageSize: 100 },
      );
      const rows = a.rows ?? a.list ?? a.records ?? [];
      alerts = rows.map((r, i) => ({
        id: String(r.alarmID ?? r.alarmId ?? r.id ?? r.eventNo ?? `${stationId}:${i}`),
        name: r.alarmName || r.alarmCauses || r.alarmMsg || 'Alarm',
        // The API has no alarmCode; the portal's "Alarm Code" is eventNo (e.g. "51").
        code: r.alarmCode ?? (r.eventNo != null && r.eventNo !== '' ? String(r.eventNo) : undefined),
        deviceSn: r.deviceSn,
        start: sajTimeToEpochSec(r.alarmStartTime ?? r.startTime ?? r.alarmUpdateTime),
        level: r.alarmLevelName || (r.alarmLevel != null ? String(r.alarmLevel) : undefined),
        reason: r.alarmCauses || r.alarmContent || undefined,
        solution: formatSolution(r.solutions),
        status: r.alarmStateName || undefined,
      }));
    } catch {
      /* alarms unavailable — fall back to the plant's summary alarm line */
      if (p?.alarmInfo) alerts = [{ id: `${stationId}:alarm`, name: p.alarmInfo }];
    }
    if (!alerts.length && p?.alarmInfo) alerts = [{ id: `${stationId}:alarm`, name: p.alarmInfo }];

    return {
      info,
      latest: p
        ? {
            currentPowerW: p.pvPower,
            dailyEnergyKwh: p.todayPvEnergy,
            totalEnergyKwh: p.totalPvEnergy,
            batterySoc: p.batSoc,
          }
        : null,
      devices,
      alerts,
      power: [],
    };
  },

  /**
   * Rich Overview dashboard: live energy flow, KPI cards, curve-analysis
   * breakdown, the day power/SOC curve, the energy-comparison bars and the
   * environmental tiles. Every call is keyed on the master inverter serial
   * (`sn` + snType:1) — without it SAJ returns null. All sections are
   * best-effort and resolved in parallel; a failed one is simply omitted.
   */
  async overview(stationId: string): Promise<StationOverview> {
    const inv = await inverterSn(stationId);
    const day = todayStr();
    const snp = inv ? { sn: inv.sn, snType: inv.snType } : {};

    const [flow, stats, selfUse, powerCurve, comparison] = await Promise.all([
      post<SajFlow>('/monitor/plantHome/getDeviceEnergyFlowDiagram', { plantUid: stationId, ...snp }).then(mapFlow).catch(() => undefined),
      post<SajStatistics>('/monitor/plantHome/getPlantEnergyStatistics', { plantUid: stationId, ...snp }).catch(() => undefined),
      post<SajSelfUse>('/monitor/plant/chart/getSelfUseEnergyData', {
        plantUid: stationId, chartDateType: 1, chartDay: day, showSelfUse: 1, version2: true, ...snp,
      }).then(mapSelfUse).catch(() => undefined),
      post<SajChart>('/monitor/plant/chart/getCommonChartData', {
        plantUid: stationId, chartDateType: 1, chartDay: day, commonChartType: 2, ...snp,
      }).then(mapChart).catch(() => undefined),
      post<SajChart>('/monitor/plant/chart/getCommonChartData', {
        plantUid: stationId, chartCompareType: '1', commonChartType: 4, ...snp,
      }).then(mapChart).catch(() => undefined),
    ]);

    return {
      flow,
      stats: stats?.energyDataList?.length ? mapStats(stats.energyDataList) : undefined,
      selfUse,
      powerCurve,
      comparison,
      environmental: mapEnvironmental(stats?.environmentalInformation),
      strategy: flow?.userMode || stats?.userModeName || undefined,
    };
  },
};
