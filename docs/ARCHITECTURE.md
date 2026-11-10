# Architecture

## Data flow

```
                         (1) cloud path - always on
 +-------------+  Wi-Fi  +------------------+   HTTPS, every 5 min   +---------------------+
 | Pecron unit | ------> | Pecron IoT cloud | <--------------------- | Cloudflare Worker   |
 +-------------+         +------------------+    (cron trigger)      |  src/index.js       |
        |                                                            |                     |
        |  local network                                             |  pages + JSON API   |
        v                (2) LAN path - optional                     |  email alerts       |
 +------------------+   POST /api/ingest (INGEST_TOKEN)              |                     |
 | LAN agent        | -------------------------------------------->  |                     |
 | solar_agent.py   |                                                +----------+----------+
 | + pecron-monitor |                                                           |
 +------------------+                                                           v
                                                                     +---------------------+
                                                                     | D1 database         |
                                                                     | samples, meta,      |
                                                                     | control_log         |
                                                                     +---------------------+
```

1. **Cloud path.** The unit reports to Pecron's IoT cloud over Wi-Fi, roughly every
   few minutes. Every 5 minutes a Cloudflare cron trigger runs the Worker, which logs in
   as your Pecron account (caching the session token in D1), asks the cloud for the
   unit's current properties, converts them to one row, and stores it with
   `source = 'cloud'`.
2. **LAN path (optional).** The agent runs `pecron-monitor --raw --local` to read the
   unit directly over your network, appends the record to a local spool file first (so
   nothing is lost if the PC loses power), then POSTs it to `/api/ingest`. Those rows
   get `source = 'lan'`.

Both paths write to the same `samples` table. `sample_id` is the primary key and
inserts use `INSERT OR IGNORE`, so a backlog replayed by the agent never creates
duplicates. Reads can be filtered with `?source=cloud` or `?source=lan`.

The pages (`/`, `/embed`, `/control`, `/mockups`) are served by the Worker itself, so
they are on the same origin as the API they call. The Worker fills placeholders such as
`__SITE_NAME__` from your configuration as it serves them.

### Frozen-cloud detection

The vendor cloud keeps answering with a unit's **last** reported values after the unit
stops reporting (for example when its Wi-Fi drops). Stored as new rows, that frozen
snapshot would look like live data and would invent energy in the daily totals.

So before storing a cloud reading, the Worker compares it with the most recent stored
cloud readings across state of charge, voltage (reported to the millivolt), current,
temperature, solar, AC/DC output, AC input and runtime. If it is identical to the last
**3** (while solar is above 0 W) or the last **6** (otherwise), it is treated as a frozen
snapshot: it is **not stored**, `cloudRepeating` appears in `/api/health`, and the gap
that opens is handled by the stale alert and the gap-aware rollups like any other gap.
One repeat is normal (the cloud refreshes about every 10 minutes) and is stored.

### Gap-aware energy totals

Energy figures integrate power over time (trapezoid rule) but skip any interval longer
than 20 minutes. A gap is reported as `largestGapMinutes` rather than being filled in
by assuming the last reading held for the whole gap.

---

## Endpoints

Reads are public and send CORS headers, so other sites can call them. Writes need a
bearer token: `Authorization: Bearer <token>`.

### Pages

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` (also `/monitor`) | optional gate (`MONITOR_TOKEN`) | Full dashboard |
| GET | `/embed` | none, never gated | Embeddable widget; see SETUP.md for its query params |
| GET | `/control` | page is public; actions need `CONTROL_TOKEN` | Device control |
| GET | `/mockups` | optional gate (`MONITOR_TOKEN`) | Further metric ideas |

### API

| Method | Path | Auth | Description | Cache |
|---|---|---|---|---|
| GET | `/api/health` | none | Config and freshness: `lastSampleAt`, `lastSampleAgeMinutes`, `stale` (over 20 min), `sourcesActive`, `localPolling`, `cloudRepeating`, `lastError`, `dcControlEnabled` | none |
| GET | `/api/latest` | none | Most recent row, plus `powerWatts` (V x A; positive = charging) and `capacityWattHours`. `?source=` | 60 s |
| GET | `/api/history` | none | Rows for the last `?hours=` (default 24, max 744), or one `?date=YYYY-MM-DD`. `?source=` | 60 s |
| GET | `/api/daily` | none | Per-day rollups for the last `?days=` (default 7, max 90): harvest, consumed (AC/DC), stored change, overhead (two estimates), SoC range, gaps. `?source=` | 300 s |
| GET | `/api/summary` | none | Lifetime and today totals, best day, peak sun hours, self-sufficiency, grid energy avoided and value, cycles, days since grid charge, mile equivalents, `pevs`, `assumptions` (last 90 days) | 600 s |
| GET | `/api/hourly` | none | Hour x day solar grid for the heatmap, `?days=` (default 30, max 90) | 600 s |
| GET | `/api/health-trend` | none | Mean resting voltage per 5% charge bucket per day, for pack-aging | 600 s |
| GET | `/api/control-log` | none | Last 100 control attempts, including refusals | none |
| POST | `/api/ingest` | `INGEST_TOKEN` | Accepts `{records:[...]}` (or one record) from the LAN agent; returns `accepted`, `stored`, `skippedRollups` | none |
| POST | `/api/poll` | `INGEST_TOKEN` | Polls the cloud now and evaluates alerts, same as one cron run | none |
| POST | `/api/control` | `CONTROL_TOKEN` | Body `{code, value}`. Allowed: `ac_switch_hm` (bool), `eco_onoff_us` (bool), `ac_charging_power_ios` (integer 0-10, x10%). `dc_switch_hm` (bool) only when `ALLOW_DC_CONTROL` is `"true"`; otherwise refused with 403. | none |
| POST | `/api/test-alert` | `CONTROL_TOKEN` | Sends a test email and reports which settings are missing | none |
| OPTIONS | any | none | CORS preflight | - |

Unknown paths return 404 with a short list of endpoints. Every token fails closed: if
`INGEST_TOKEN` is unset, `/api/ingest` and `/api/poll` refuse everyone; if `CONTROL_TOKEN` is
unset, `/api/control` and `/api/test-alert` refuse everyone.

### Control safety

- **`dc_switch_hm` is refused by default** with HTTP 403 and logged as `refused`. If a
  router or other critical gear runs off the DC output, switching it remotely would cut
  the only way back in. Installations whose network does not run off DC can opt in with
  `ALLOW_DC_CONTROL = "true"`; `/api/health` reports the setting as `dcControlEnabled`,
  and `/control` shows the DC buttons only when it is on.
- **Fail closed.** A missing `CONTROL_TOKEN` is treated exactly like a wrong one.
- Every attempt (applied, refused, error, unauthorized) is written to `control_log`.
- The device confirms changes asynchronously; its reported state can take a few
  minutes to catch up.

---

## D1 tables

Defined in `schema.sql`.

### `samples`

One row per reading from either source.

| Column | Meaning |
|---|---|
| `sample_id` | primary key (UUID); dedupe key across sources |
| `captured_at` | ISO-8601 in `SITE_TIMEZONE` with its offset (sorts chronologically) |
| `captured_date` | site-local `YYYY-MM-DD` |
| `report_type` | `sample`, `dayOpen` or `dayClose` |
| `soc` | state of charge, % |
| `voltage`, `current_amps` | pack voltage and current (current negative = discharging) |
| `temperature_c` | pack temperature |
| `solar_w` | DC input watts (where the panel connects) |
| `ac_out_w`, `dc_out_w`, `ac_in_w` | output and grid-input watts |
| `total_in_w`, `total_out_w` | device totals |
| `minutes_remaining` | firmware runtime estimate (meaningful while discharging) |
| `ac_switch`, `dc_switch`, `ups`, `eco` | output and mode states (0/1) |
| `device_status` | raw enum: 0 shut down, 1 charging, 2 DC discharge, 3 AC discharge, 4 standby, 5 conservation |
| `fault_code` | raw enum: 0 normal, 1-17 fault names (see `FAULTS` in `src/index.js`) |
| `source` | `cloud` or `lan` |

### `meta`

Small key/value store.

| Key | Meaning |
|---|---|
| `access_token`, `token_expires` | cached Pecron session token and its expiry (ms) |
| `last_error` | last poll failure, cleared on the next success |
| `cloud_frozen_since`, `cloud_frozen_repeats` | frozen-cloud detector state |
| `alert_state` | stale alert: `ok` or `alerting` |
| `alert_fault_state` | fault alert: `ok` or `faulted` |
| `alert_depletion_state` | depletion alert: `ok` or `short` |

### `control_log`

Every control attempt: `at`, `code`, `value`, `result` (`applied`, `refused`, `error`,
`unauthorized`), `detail`.

---

## Alerting

Alerts are evaluated after every cron poll (and every manual `/api/poll`), whether or
not the poll itself succeeded. Delivery goes to Mailgun email and, if set, to
`ALERT_WEBHOOK` as well.

| Alert | Fires when | Clears when |
|---|---|---|
| Telemetry stopped | no stored reading for over `ALERT_STALE_MINUTES`. If the cloud is repeating a frozen reading, the email says so and suggests checking the unit's Wi-Fi. | a fresh reading lands |
| Device fault | the latest reading carries a fault code | the fault code goes away |
| Will not reach sunrise | the pack is discharging and `minutes_remaining` is less than the time until `SOLAR_WINDOW_OPENS` plus a 90-minute margin. Not raised during panel hours (see `SOLAR_WINDOW_CLOSES`). | charging resumes or the runtime covers the gap |

Two rules keep alerts useful:

- **Transition-only latching.** Each alert sends one message when its condition
  starts and one when it clears, never a repeat every 5 minutes.
- **Latch on delivery.** The state only changes after a message was actually
  accepted. If sending fails, the next cycle tries again, so a broken mail setup can
  never silently mark an alert as "already sent".

There is deliberately **no quiet-hours window**: for a solar-charged battery, overnight
is exactly when running flat is most likely, and an email does not wake anyone.

---

## Token caching and expiry

Logging in on every poll would mean nearly 300 logins a day, so the session token is
cached in `meta`. The vendor's `expirationTime` is not a date string: the Worker accepts
it as seconds or milliseconds (or a date string), and assumes 12 hours if none of those
parse. If a call still fails with an expired token (the vendor reports this as an API
error code rather than HTTP 401), the Worker logs in again and retries once.
