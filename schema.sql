-- pecron-solar-dashboard - D1 schema
--
-- One row per reading, from either source. sample_id is the primary key, so a
-- replayed backlog from the LAN agent collapses instead of double-counting.

CREATE TABLE IF NOT EXISTS samples (
  sample_id         TEXT PRIMARY KEY,
  captured_at       TEXT NOT NULL,          -- ISO-8601 with offset
  captured_date     TEXT NOT NULL,          -- site-local YYYY-MM-DD (SITE_TIMEZONE)
  report_type       TEXT NOT NULL DEFAULT 'sample',
  soc               INTEGER,
  voltage           REAL,
  current_amps      REAL,
  temperature_c     INTEGER,
  solar_w           INTEGER,                -- DC input; no dedicated PV sensor on this model
  ac_out_w          INTEGER,
  dc_out_w          INTEGER,
  ac_in_w           INTEGER,
  total_in_w        INTEGER,
  total_out_w       INTEGER,
  minutes_remaining INTEGER,
  ac_switch         INTEGER,
  dc_switch         INTEGER,
  ups               INTEGER,
  eco               INTEGER,
  -- Raw enum values, decoded for display rather than in storage.
  --   device_status: 0 Shut Down, 1 Charging, 2 DC Discharge, 3 AC Discharge,
  --                  4 Standby, 5 Conservation
  --   fault_code:    0 Normal, 1-17 see FAULT_ALARM_ENUM in the device TSL
  device_status     INTEGER,
  fault_code        INTEGER,
  source            TEXT NOT NULL           -- 'cloud' | 'lan'
);

CREATE INDEX IF NOT EXISTS idx_samples_at   ON samples (captured_at);
CREATE INDEX IF NOT EXISTS idx_samples_date ON samples (captured_date, captured_at);

-- Small key/value scratch: cached access token, last error.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

-- Every control attempt, including the ones that were refused. Worth having the
-- first time somebody asks why the AC went off.
CREATE TABLE IF NOT EXISTS control_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  code   TEXT NOT NULL,
  value  TEXT NOT NULL,
  result TEXT NOT NULL,          -- applied | refused | error | unauthorized
  detail TEXT
);
