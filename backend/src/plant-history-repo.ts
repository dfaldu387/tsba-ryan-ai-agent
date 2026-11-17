import { query, withTransaction } from './db.js';
import { fleetToday } from './providers/coords.js';
import type { NormalizedAlert, NormalizedDetail, NormalizedPowerPoint } from './providers/types.js';

/**
 * Persistence for plant detail that used to live only in memory (see
 * db/migrations/0002): latest detail per plant, one power curve per plant per
 * day, and every alarm with when it was first/last seen. Each table is written
 * with ONE statement per batch (jsonb_to_recordset), so a fleet-wide scan of
 * ~300 plants costs three queries, not hundreds.
 */

export interface DetailCapture {
  provider: string;
  stationId: string;
  detail: NormalizedDetail;
}

/** Save a batch of freshly fetched plant details (from the fleet alert scan). */
export async function saveDetails(batch: DetailCapture[], at: Date = new Date()): Promise<void> {
  if (!batch.length) return;
  const day = fleetToday(at);
  const details = batch.map((b) => ({ provider: b.provider, station_id: b.stationId, detail: b.detail }));
  const curves = batch
    .filter((b) => b.detail.power.length)
    .map((b) => ({ provider: b.provider, station_id: b.stationId, points: b.detail.power }));
  const alarms = batch.flatMap((b) =>
    b.detail.alerts.map((a: NormalizedAlert) => ({
      provider: b.provider,
      station_id: b.stationId,
      alarm_id: String(a.id),
      name: a.name || 'Alarm',
      code: a.code ?? null,
      device_sn: a.deviceSn ?? null,
      level: a.level ?? null,
      reason: a.reason ?? null,
      solution: a.solution ?? null,
      status: a.status ?? null,
      started_at: a.start ? new Date(a.start * 1000).toISOString() : null,
    })),
  );

  await withTransaction(async (q) => {
    await q(
      `INSERT INTO solar_plant_details (provider, station_id, detail, captured_at)
       SELECT r.provider, r.station_id, r.detail, $2
         FROM jsonb_to_recordset($1::jsonb) AS r(provider text, station_id text, detail jsonb)
       ON CONFLICT (provider, station_id) DO UPDATE SET detail = EXCLUDED.detail, captured_at = EXCLUDED.captured_at`,
      [JSON.stringify(details), at.toISOString()],
    );
    if (curves.length) {
      await q(
        `INSERT INTO solar_daily_curves (provider, station_id, day, points, updated_at)
         SELECT r.provider, r.station_id, $2::date, r.points, $3
           FROM jsonb_to_recordset($1::jsonb) AS r(provider text, station_id text, points jsonb)
         ON CONFLICT (provider, station_id, day) DO UPDATE SET points = EXCLUDED.points, updated_at = EXCLUDED.updated_at`,
        [JSON.stringify(curves), day, at.toISOString()],
      );
    }
    if (alarms.length) {
      await q(
        `INSERT INTO solar_alarm_history
           (provider, station_id, alarm_id, name, code, device_sn, level, reason, solution, status, started_at, first_seen, last_seen)
         SELECT r.provider, r.station_id, r.alarm_id, r.name, r.code, r.device_sn, r.level, r.reason, r.solution, r.status, r.started_at, $2, $2
           FROM jsonb_to_recordset($1::jsonb) AS r(provider text, station_id text, alarm_id text, name text, code text,
                device_sn text, level text, reason text, solution text, status text, started_at timestamptz)
         ON CONFLICT (provider, station_id, alarm_id) DO UPDATE SET
           name = EXCLUDED.name, code = EXCLUDED.code, device_sn = EXCLUDED.device_sn, level = EXCLUDED.level,
           reason = EXCLUDED.reason, solution = EXCLUDED.solution, status = EXCLUDED.status,
           started_at = COALESCE(solar_alarm_history.started_at, EXCLUDED.started_at), last_seen = EXCLUDED.last_seen`,
        [JSON.stringify(alarms), at.toISOString()],
      );
    }
  });
}

/** The last saved detail for a plant, if captured within `maxAgeHours`. */
export async function storedDetail(
  provider: string,
  stationId: string,
  maxAgeHours = 24,
): Promise<{ detail: NormalizedDetail; capturedAt: string } | null> {
  const res = await query<{ detail: NormalizedDetail; captured_at: Date }>(
    `SELECT detail, captured_at FROM solar_plant_details
      WHERE provider = $1 AND station_id = $2 AND captured_at > now() - make_interval(hours => $3)`,
    [provider, stationId, maxAgeHours],
  );
  const row = res.rows[0];
  return row ? { detail: row.detail, capturedAt: new Date(row.captured_at).toISOString() } : null;
}

/** A plant's saved power curve for one local day (YYYY-MM-DD), oldest point first. */
export async function curveForDay(provider: string, stationId: string, day: string): Promise<NormalizedPowerPoint[]> {
  const res = await query<{ points: NormalizedPowerPoint[] }>(
    'SELECT points FROM solar_daily_curves WHERE provider = $1 AND station_id = $2 AND day = $3::date',
    [provider, stationId, day],
  );
  return (res.rows[0]?.points ?? []).slice().sort((a, b) => a.t - b.t);
}

export interface AlarmHistoryRow {
  alarmId: string;
  name: string;
  code: string | null;
  deviceSn: string | null;
  level: string | null;
  reason: string | null;
  solution: string | null;
  status: string | null;
  startedAt: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** A plant's alarm history, most recently seen first. */
export async function alarmHistory(provider: string, stationId: string, limit = 100): Promise<AlarmHistoryRow[]> {
  const res = await query<{
    alarm_id: string; name: string; code: string | null; device_sn: string | null; level: string | null;
    reason: string | null; solution: string | null; status: string | null;
    started_at: Date | null; first_seen: Date; last_seen: Date;
  }>(
    `SELECT alarm_id, name, code, device_sn, level, reason, solution, status, started_at, first_seen, last_seen
       FROM solar_alarm_history WHERE provider = $1 AND station_id = $2
      ORDER BY last_seen DESC LIMIT $3`,
    [provider, stationId, Math.min(500, Math.max(1, limit))],
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return res.rows.map((r) => ({
    alarmId: r.alarm_id, name: r.name, code: r.code, deviceSn: r.device_sn, level: r.level,
    reason: r.reason, solution: r.solution, status: r.status,
    startedAt: iso(r.started_at), firstSeen: iso(r.first_seen)!, lastSeen: iso(r.last_seen)!,
  }));
}

/** Retention: drop curves and alarm rows older than `days`, and details not refreshed in that time. */
export async function prunePlantHistory(days: number): Promise<void> {
  await query(`DELETE FROM solar_daily_curves WHERE day < (now() - make_interval(days => $1))::date`, [days]);
  await query(`DELETE FROM solar_alarm_history WHERE last_seen < now() - make_interval(days => $1)`, [days]);
  await query(`DELETE FROM solar_plant_details WHERE captured_at < now() - make_interval(days => $1)`, [days]);
}
