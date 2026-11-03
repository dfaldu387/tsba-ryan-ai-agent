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

export interface SolarProvider {
  /** Stable slug used in URLs, e.g. 'deye', 'goodwe'. */
  id: string;
  /** Display name, e.g. 'Deye Cloud'. */
  name: string;
  /** True once this provider has the credentials it needs. */
  configured(): boolean;
  /** All stations visible to the configured account. */
  listStations(): Promise<NormalizedStation[]>;
  /** Devices, alerts, realtime snapshot and today's power curve for one station. */
  stationDetail(stationId: string): Promise<NormalizedDetail>;
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
