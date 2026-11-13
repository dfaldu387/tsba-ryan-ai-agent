/**
 * Multi-provider solar monitoring abstraction.
 *
 * Each monitoring platform (Deye, GoodWe/SEMS, Solarman, SolisCloud, …) has its
 * own auth, base URL and response shapes. A `SolarProvider` wraps one platform
 * behind a common interface and normalises its data into the shared shapes
 * below, so the API routes and the UI never care which platform a station came
 * from.
 */

// 'waiting' = connected and healthy but not producing right now (standby, e.g.
// night / no sun). It is deliberately distinct from 'offline' (not communicating)
// so an idle plant isn't falsely alarmed as down.
export type StationStatus = 'online' | 'waiting' | 'partial' | 'offline' | 'unknown';

export interface NormalizedStation {
  /** Provider-local id, as a string (some platforms use UUIDs, some int64). */
  id: string;
  name: string;
  status: StationStatus;
  /** Current generation power, Watts. */
  currentPowerW?: number;
  /** Energy generated today / this month / all-time, kWh. */
  dailyEnergyKwh?: number;
  monthlyEnergyKwh?: number;
  totalEnergyKwh?: number;
  /** Installed (peak) capacity, kW. */
  capacityKw?: number;
  /** Battery state of charge, %. */
  batterySoc?: number;
  location?: string;
  /** Plant owner / primary contact, when the platform exposes them (e.g. Deye). */
  owner?: string;
  contact?: string;
  /** Installation coordinates (decimal degrees), when the platform exposes them.
   *  Used for per-plant sunrise/sunset so night-time alerts are judged at the
   *  plant's own location rather than a single fleet reference point. */
  lat?: number;
  lng?: number;
  /** Last data update, epoch seconds. */
  lastUpdate?: number;
}

export interface NormalizedDevice {
  sn: string;
  type?: string;
  online?: boolean;
}

export interface NormalizedAlert {
  id: string;
  name: string;
  code?: string;
  deviceSn?: string;
  /** Epoch seconds. */
  start?: number;
  level?: string;
  /** Provider-reported root cause of the fault, when exposed (e.g. SAJ alarmCauses). */
  reason?: string;
  /** Provider-reported remediation steps for this fault, when exposed (e.g. SAJ
   *  solutions). Already whitespace-tidied and one step per line. */
  solution?: string;
  /** Provider-reported handling state, when exposed (e.g. SAJ "Pending"/"Recovered"). */
  status?: string;
}

export interface NormalizedPowerPoint {
  /** Epoch seconds. */
  t: number;
  /** Power, Watts. */
  powerW: number;
}

export interface NormalizedLatest {
  currentPowerW?: number;
  consumptionPowerW?: number;
  gridPowerW?: number;
  batteryPowerW?: number;
  batterySoc?: number;
  dailyEnergyKwh?: number;
  monthlyEnergyKwh?: number;
  totalEnergyKwh?: number;
  lastUpdate?: number;
}

/** A single label/value attribute shown in the plant-details section. */
export interface StationInfoItem {
  label: string;
  value: string;
}

export interface NormalizedDetail {
  latest: NormalizedLatest | null;
  devices: NormalizedDevice[];
  alerts: NormalizedAlert[];
  power: NormalizedPowerPoint[];
  /** Full plant attributes (location, owner, dates, grid type, …) for display. */
  info: StationInfoItem[];
}

// ─── Rich plant "Overview" (detail dashboard) ────────────────────────────────
// Optional, provider-specific data powering the full monitoring detail page
// (energy-flow diagram, KPI cards, curve analysis, charts, environmental tiles).
// Only providers that expose it implement SolarProvider.overview(); the UI shows
// each section only when its data is present.

/** Live energy-flow snapshot: instantaneous power at each node + battery state. */
export interface EnergyFlow {
  pvPowerW?: number;
  loadPowerW?: number;
  gridPowerW?: number;
  batteryPowerW?: number;
  batterySoc?: number; // %
  /** Battery flow label, e.g. "Charge" / "Discharge". */
  batteryDirection?: string;
  /** Grid flow label, e.g. "Import" / "Export". */
  gridDirection?: string;
  hasPv?: boolean;
  hasGrid?: boolean;
  hasBattery?: boolean;
  hasGenerator?: boolean;
  generatorPowerW?: number;
  systemPowerKw?: number;
  runningState?: string;
  /** Work/strategy mode, e.g. "Self-use mode". */
  userMode?: string;
  todayPvEnergyKwh?: number;
  /** As-of timestamp reported by the platform. */
  dataTime?: string;
}

/** One KPI-card figure group. `kind` picks the card; secondary fields are used
 *  by the two-row cards (grid = import/export, battery = charge/discharge). */
export interface EnergyStat {
  kind: 'pv' | 'load' | 'grid' | 'battery';
  todayKwh?: number;
  totalKwh?: number;
  /** Secondary row (grid: export; battery: discharge). */
  today2Kwh?: number;
  total2Kwh?: number;
  /** PV only: self-consumption %. */
  selfUsePercentage?: number;
}

/** Curve-analysis self-consumption / self-sufficiency breakdown for a period. */
export interface SelfUseBreakdown {
  pvEnergy?: number;
  loadEnergy?: number;
  sellEnergy?: number;
  buyEnergy?: number;
  chargeEnergy?: number;
  dischargeEnergy?: number;
  pvSelfConsumedEnergy?: number;
  loadSelfConsumedEnergy?: number;
  /** Rates as fractions (0–1). */
  pvSelfConsumedRate?: number;
  pvSellRate?: number;
  loadSelfConsumedRate?: number;
  loadBuyRate?: number;
  unit?: string;
}

/** A generic multi-series chart: x-axis labels + named series. */
export interface ChartSeries {
  name: string;
  color?: string;
  unit?: string;
  /** Right-axis series (e.g. SOC %) drawn on a secondary scale. */
  secondaryAxis?: boolean;
  data: (number | null)[];
}
export interface ChartData {
  kind: 'line' | 'bar';
  xLabels: string[];
  series: ChartSeries[];
}

/** Environmental savings tiles. */
export interface Environmental {
  co2SavedT?: number;
  treesEquivalent?: number;
  coalSavedT?: number;
}

/** The full rich detail-page bundle (all sections optional / best-effort). */
export interface StationOverview {
  flow?: EnergyFlow;
  /** The KPI cards (generated / consumption / grid / battery). */
  stats?: EnergyStat[];
  /** Self-consumption + self-sufficiency breakdown for the selected period. */
  selfUse?: SelfUseBreakdown;
  /** Day power + SOC time-series. */
  powerCurve?: ChartData;
  /** Energy comparison bars (monthly / quarter / annual). */
  comparison?: ChartData;
  environmental?: Environmental;
  /** Plant strategy / work-mode label. */
  strategy?: string;
}

/** Severity of a monitoring notification, most to least severe. */
export type SolarAlertSeverity = 'offline' | 'partial' | 'fault' | 'alert' | 'device';

/**
 * A single health issue surfaced in the header notification panel: a plant that
 * is offline/partial, an individual device that is disconnected, or a provider-
 * reported active fault. `id` is stable across scans so the UI can de-dupe and
 * track which alerts have been seen.
 */
export interface SolarMonitorAlert {
  id: string;
  severity: SolarAlertSeverity;
  provider: string;
  plant: string;
  plantId: string;
  title: string;
  detail?: string;
  deviceSn?: string;
  /** Epoch seconds, when known (e.g. a fault's start time). */
  at?: number;
  /** Provider-reported remediation steps for this fault, when exposed (e.g. SAJ).
   *  Preferred over an AI-generated solution in alert emails. */
  solution?: string;
  /** Provider-reported handling state, when exposed (e.g. SAJ "Pending"). */
  status?: string;
  /** Plant coordinates (decimal degrees), when known — for per-plant quiet hours. */
  lat?: number;
  lng?: number;
}

export interface SolarProvider {
  /** Stable slug used in URLs, e.g. 'deye', 'goodwe'. */
  id: string;
  /** Display name, e.g. 'Deye Cloud'. */
  name: string;
  /** True once this provider has the credentials it needs. */
  configured(): boolean;
  /**
   * Optional/unverified integration: when it fails with no cached data, the
   * aggregator reports it as "unavailable" (awaiting verification) rather than a
   * hard error, so a known-incomplete platform (e.g. a placeholder or a scraper
   * with no live session yet) doesn't spam the fleet view with error banners.
   */
  optional?: boolean;
  /** All stations visible to the configured account. */
  listStations(): Promise<NormalizedStation[]>;
  /** Devices, alerts, realtime snapshot and today's power curve for one station. */
  stationDetail(stationId: string): Promise<NormalizedDetail>;
  /**
   * Rich "Overview" dashboard data (energy flow, KPI cards, curve analysis,
   * power/energy charts, environmental). Optional — only providers that expose
   * it implement this; the detail page shows the Overview when present and falls
   * back to the basic detail otherwise. Kept separate from stationDetail() so the
   * fleet alert scan (which calls stationDetail per plant) stays lightweight.
   */
  overview?(stationId: string): Promise<StationOverview>;
}

export class ProviderError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(providerId: string) {
    super(`${providerId}_not_configured`);
    this.name = 'ProviderNotConfiguredError';
  }
}
