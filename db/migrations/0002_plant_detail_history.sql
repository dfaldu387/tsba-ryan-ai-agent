-- Migration 0002 — persist plant detail, daily power curves and alarm history.
-- Idempotent and additive (new tables only). Applied by `npm run migrate`.
--
-- Until now these were fetched live from each monitoring platform and only
-- cached in memory, so a restart lost them and nothing was kept over time.
-- They are written from the fleet alert scan (which already fetches every
-- plant's detail every few minutes), so storing them adds no platform calls.

-- Latest full detail per plant (devices, active alarms, today's curve, info).
-- One row per plant, overwritten each time; serves a plant page when the
-- platform is slow or unreachable.
CREATE TABLE IF NOT EXISTS solar_plant_details (
  provider     TEXT        NOT NULL,
  station_id   TEXT        NOT NULL,
  detail       JSONB       NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, station_id)
);

-- One power curve per plant per local (Brisbane) day; the day's row is
-- overwritten as the curve grows, then stays as history.
CREATE TABLE IF NOT EXISTS solar_daily_curves (
  provider     TEXT        NOT NULL,
  station_id   TEXT        NOT NULL,
  day          DATE        NOT NULL,
  points       JSONB       NOT NULL,   -- [{ t: epoch ms, powerW }]
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, station_id, day)
);
CREATE INDEX IF NOT EXISTS solar_daily_curves_day_idx ON solar_daily_curves (day);

-- Every alarm/fault a platform has reported, with when it was first and last
-- seen. An alarm no longer reported keeps its last_seen, which is when it cleared.
CREATE TABLE IF NOT EXISTS solar_alarm_history (
  provider     TEXT        NOT NULL,
  station_id   TEXT        NOT NULL,
  alarm_id     TEXT        NOT NULL,   -- the platform's own alarm id
  name         TEXT        NOT NULL,
  code         TEXT,
  device_sn    TEXT,
  level        TEXT,
  reason       TEXT,
  solution     TEXT,
  status       TEXT,
  started_at   TIMESTAMPTZ,            -- when the platform says it started
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, station_id, alarm_id)
);
CREATE INDEX IF NOT EXISTS solar_alarm_history_plant_idx ON solar_alarm_history (provider, station_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS solar_alarm_history_seen_idx ON solar_alarm_history (last_seen);
