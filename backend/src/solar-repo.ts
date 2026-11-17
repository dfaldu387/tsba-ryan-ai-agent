import { pool, query } from './db.js';
import type { SolarStationReading, SolarFleetReading } from './stores/types.js';

/**
 * Postgres persistence for solar-monitoring snapshots. Writes are done by the
 * background recorder (solar-recorder.ts); reads back the last-known station
 * readings (API-outage fallback) and historical fleet series (trends).
 */

const STATION_COLS =
  'provider, station_id, name, status, current_power_w, daily_kwh, monthly_kwh, total_kwh, capacity_kw, battery_soc, location, captured_at';

interface StationRow {
  provider: string;
  station_id: string;
  name: string;
  status: string;
  current_power_w: number | null;
  daily_kwh: number | null;
  monthly_kwh: number | null;
  total_kwh: number | null;
  capacity_kw: number | null;
  battery_soc: number | null;
  location: string | null;
  captured_at: Date;
}

interface FleetRow {
  systems: number;
  online: number;
  waiting: number;
  partial: number;
  offline: number;
  total_power_w: number | null;
  total_daily_kwh: number | null;
  total_energy_kwh: number | null;
  total_capacity_kw: number | null;
  total_devices: number | null;
  online_devices: number | null;
  captured_at: Date;
}

const n = (v: number | null | undefined): number | null => (v == null ? null : v);

function toStation(r: StationRow): SolarStationReading {
  return {
    provider: r.provider,
    station_id: r.station_id,
    name: r.name,
    status: r.status,
    current_power_w: r.current_power_w,
    daily_kwh: r.daily_kwh,
    monthly_kwh: r.monthly_kwh,
    total_kwh: r.total_kwh,
    capacity_kw: r.capacity_kw,
    battery_soc: r.battery_soc,
    location: r.location,
    captured_at: r.captured_at.toISOString(),
  };
}

function toFleet(r: FleetRow): SolarFleetReading {
  return {
    systems: r.systems,
    online: r.online,
    waiting: r.waiting,
    partial: r.partial,
    offline: r.offline,
    total_power_w: r.total_power_w,
    total_daily_kwh: r.total_daily_kwh,
    total_energy_kwh: r.total_energy_kwh,
    total_capacity_kw: r.total_capacity_kw,
    total_devices: r.total_devices,
    online_devices: r.online_devices,
    captured_at: r.captured_at.toISOString(),
  };
}

/** Insert one capture (station snapshots + fleet aggregate) in a transaction. */
export async function recordSolar(
  stations: SolarStationReading[],
  fleet: SolarFleetReading,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (stations.length) {
      // Build a single multi-row INSERT: 11 bound columns per row (captured_at
      // defaults to now()).
      const cols = 11;
      const values: unknown[] = [];
      const tuples = stations.map((s, i) => {
        const b = i * cols;
        values.push(
          s.provider,
          s.station_id,
          s.name,
          s.status,
          n(s.current_power_w),
          n(s.daily_kwh),
          n(s.monthly_kwh),
          n(s.total_kwh),
          n(s.capacity_kw),
          n(s.battery_soc),
          s.location ?? null,
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11})`;
      });
      await client.query(
        `INSERT INTO solar_station_readings
           (provider, station_id, name, status, current_power_w, daily_kwh, monthly_kwh, total_kwh, capacity_kw, battery_soc, location)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    }

    await client.query(
      `INSERT INTO solar_fleet_readings
         (systems, online, waiting, partial, offline, total_power_w, total_daily_kwh, total_energy_kwh, total_capacity_kw, total_devices, online_devices)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        fleet.systems,
        fleet.online,
        fleet.waiting,
        fleet.partial,
        fleet.offline,
        n(fleet.total_power_w),
        n(fleet.total_daily_kwh),
        n(fleet.total_energy_kwh),
        n(fleet.total_capacity_kw),
        n(fleet.total_devices),
        n(fleet.online_devices),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Most recent reading per (provider, station_id). */
export async function latestStationReadings(): Promise<SolarStationReading[]> {
  const res = await query<StationRow>(
    `SELECT DISTINCT ON (provider, station_id) ${STATION_COLS}
       FROM solar_station_readings
      ORDER BY provider, station_id, captured_at DESC`,
  );
  return res.rows.map(toStation);
}

/** The newest stored reading for one station that carried real data (skips
 *  'unknown' rows, so a fallback snapshot never passes itself off as a reading). */
export async function latestStationReading(provider: string, stationId: string): Promise<SolarStationReading | null> {
  const res = await query<StationRow>(
    `SELECT ${STATION_COLS}
       FROM solar_station_readings
      WHERE provider = $1 AND station_id = $2 AND status <> 'unknown'
      ORDER BY captured_at DESC
      LIMIT 1`,
    [provider, stationId],
  );
  return res.rows[0] ? toStation(res.rows[0]) : null;
}

/**
 * Each station's most recent snapshot for one provider, within `maxAgeHours`
 * (index-backed: provider, station_id, captured_at). Used as a fallback right
 * after a restart, before a slow provider's first live answer has arrived.
 */
export async function latestReadingsForProvider(provider: string, maxAgeHours = 24): Promise<SolarStationReading[]> {
  const res = await query<StationRow>(
    `SELECT DISTINCT ON (station_id) ${STATION_COLS}
       FROM solar_station_readings
      WHERE provider = $1 AND captured_at > now() - make_interval(hours => $2)
      ORDER BY station_id, captured_at DESC`,
    [provider, maxAgeHours],
  );
  return res.rows.map(toStation);
}

/** One station's snapshots at/after `sinceMs`, oldest first (index-backed). */
export async function stationReadingsSince(provider: string, stationId: string, sinceMs: number): Promise<SolarStationReading[]> {
  const res = await query<StationRow>(
    `SELECT ${STATION_COLS}
       FROM solar_station_readings
      WHERE provider = $1 AND station_id = $2 AND captured_at >= to_timestamp($3)
      ORDER BY captured_at ASC`,
    [provider, stationId, Math.floor(sinceMs / 1000)],
  );
  return res.rows.map(toStation);
}

/** Fleet aggregate snapshots at/after `sinceMs`, oldest first. */
export async function fleetReadingsSince(sinceMs: number): Promise<SolarFleetReading[]> {
  const res = await query<FleetRow>(
    `SELECT systems, online, waiting, partial, offline, total_power_w, total_daily_kwh,
            total_energy_kwh, total_capacity_kw, total_devices, online_devices, captured_at
       FROM solar_fleet_readings
      WHERE captured_at >= to_timestamp($1)
      ORDER BY captured_at ASC`,
    [Math.floor(sinceMs / 1000)],
  );
  return res.rows.map(toFleet);
}

/**
 * Monthly fleet production (kWh) from the stored lifetime-total series: for each
 * month, the last snapshot's total_energy_kwh minus the prior month's. Fetches
 * one extra month as the delta baseline and drops it.
 */
export async function monthlyProduction(months: number): Promise<{ month: string; kwh: number }[]> {
  // Per plant: lifetime total at the end of each month, minus the same plant's
  // total at the end of the previous month; then summed across plants. (Using
  // the fleet-wide sum instead counted a newly connected plant's entire
  // lifetime output — or a provider missing from one snapshot — as that
  // month's production.) Months are Brisbane months, not UTC.
  const res = await query<{ month: string; kwh: string | null }>(
    `WITH r AS (
       SELECT provider, station_id, total_kwh, captured_at,
              date_trunc('month', captured_at AT TIME ZONE 'Australia/Brisbane') AS m
         FROM solar_station_readings
        WHERE captured_at >= (date_trunc('month', now() AT TIME ZONE 'Australia/Brisbane') - (($1::int + 1) || ' months')::interval) AT TIME ZONE 'Australia/Brisbane'
          AND total_kwh IS NOT NULL
     ), months AS (
       SELECT provider, station_id, m,
              (array_agg(total_kwh ORDER BY captured_at DESC))[1] AS end_total,
              (array_agg(total_kwh ORDER BY captured_at ASC))[1]  AS first_total
         FROM r GROUP BY provider, station_id, m
     ), deltas AS (
       -- Baseline: the plant's previous month-end when it is the month just
       -- before; otherwise its first reading this month (a partial month).
       SELECT m, end_total - CASE
                WHEN lag(m) OVER w = m - interval '1 month' THEN lag(end_total) OVER w
                ELSE first_total END AS d
         FROM months
       WINDOW w AS (PARTITION BY provider, station_id ORDER BY m)
     )
     SELECT to_char(m, 'YYYY-MM') AS month, sum(d) AS kwh
       FROM deltas
      WHERE d >= 0 AND m >= date_trunc('month', now() AT TIME ZONE 'Australia/Brisbane') - (($1::int - 1) || ' months')::interval
      GROUP BY m
      ORDER BY m`,
    [months],
  );
  return res.rows.filter((r) => r.kwh != null).map((r) => ({ month: r.month, kwh: Number(r.kwh) }));
}

/** Delete station + fleet readings older than `days` (retention). */
export async function pruneSolarReadings(days: number): Promise<void> {
  await query(`DELETE FROM solar_station_readings WHERE captured_at < now() - ($1 || ' days')::interval`, [days]);
  await query(`DELETE FROM solar_fleet_readings WHERE captured_at < now() - ($1 || ' days')::interval`, [days]);
}
