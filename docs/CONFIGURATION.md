# Configuration reference

Settings live in three places:

| Where | What goes there | How to change it |
|---|---|---|
| `[vars]` in `wrangler.toml` | plain, non-secret values | edit, then `npx wrangler deploy` |
| Worker secrets | passwords, tokens, API keys | `npx wrangler secret put NAME` |
| `src/site.config.js` | structured data (vehicle list and a few numbers) | edit, then `npx wrangler deploy` |

All `[vars]` values are written as strings in quotes, including numbers. A missing or
malformed value falls back to the default shown below.

---

## Variables (`[vars]` in wrangler.toml)

### Site and display

| Name | Default | Description |
|---|---|---|
| `SITE_NAME` | `My Solar Battery` | Name shown in page headers and titles, the embed heading, and alert email subjects. |
| `DEVICE_NAME` | `Pecron power station` (template sets `Pecron F3000LFP`) | Shown in the dashboard footer. |
| `SITE_TIMEZONE` | `UTC` (template sets `America/New_York`) | IANA timezone name, e.g. `Europe/Berlin`. Decides how timestamps are stored, where each day starts for daily totals, and the times used by the depletion alert. An invalid name is ignored with a log line. Set it **before** collecting much data: changing it later does not re-stamp existing rows. |
| `EMBED_ACCENT` | `#2E7D5B` | Default accent colour of `/embed`, as `#RRGGBB`. A host page can override it with `?accent=`. |

### Pecron connection

| Name | Default | Description |
|---|---|---|
| `PECRON_REGION` | `US` | `US`, `EU` or `CN`: the vendor cloud your app account lives in. Selects the API host, the user domain, and which `PECRON_SECRET_<REGION>` secret is read. |
| `PECRON_PK` | empty | Product key of your unit. Empty, together with `PECRON_DK`, means "use the first device on the account" (the keys found are logged). See SETUP.md step 5. |
| `PECRON_DK` | empty | Device key of your unit, often its MAC address without separators. |

### Hardware and solar

| Name | Default | Description |
|---|---|---|
| `BATTERY_CAPACITY_WH` | `3072` | Usable battery capacity in Wh (the F3000LFP is 3,072 Wh). Used to turn state of charge into stored energy, for the energy-balance overhead estimate, and for equivalent full cycles. |
| `PANEL_WATTS` | `400` | Total nameplate watts of your solar array. Used for peak sun hours and "% of array" figures. |
| `SOLAR_WINDOW_OPENS` | `08:45` | `HH:MM` local time when the panel starts producing in earnest. Later than sunrise if something shades it in the morning. The depletion alert asks "will the battery last until then?" |
| `SOLAR_WINDOW_CLOSES` | `16:00` | `HH:MM`. From the start of the hour containing `SOLAR_WINDOW_OPENS` until this time, new depletion alerts are suppressed, because brief daytime loads (charging a vehicle, say) project misleadingly short runtimes. Recovery messages can still be sent. |

### Money and grid

| Name | Default | Description |
|---|---|---|
| `GRID_RATE_USD_PER_KWH` | `0.30` | **Set your own.** Your electricity price per kWh, used for the "value generated" figures. Use the blended rate from a real bill (total charges / total kWh, including delivery), not the energy line alone. Any currency works numerically; the pages label it `$`. |
| `GRID_RATE_VERIFIED` | `false` | Set to `"true"` once the rate above comes from a real bill. Until then the pages call the rate a placeholder. |
| `LAST_GRID_CHARGE` | empty | Optional ISO date-time of the battery's last charge from the grid, e.g. `2026-01-31T12:00:00-05:00`. Useful when that charge happened before monitoring began. "Days since grid charge" uses whichever is more recent: this date, or a grid charge (AC input above 0 W) seen in the data. With neither, it counts from the first stored reading. |

### Alerts

| Name | Default | Description |
|---|---|---|
| `ALERT_STALE_MINUTES` | `30` | Minutes without a stored reading before the "telemetry stopped" alert is sent. |
| `MAILGUN_DOMAIN` | empty | Your Mailgun sending domain, e.g. `mg.example.com`. Alerts are sent from `alerts@<this domain>`. |
| `ALERT_EMAIL` | empty | Where alert emails go. |
| `ALERT_FROM_NAME` | `<SITE_NAME> Solar` | Display name on alert emails. |

Email alerts are only sent when `MAILGUN_API_KEY` (secret), `MAILGUN_DOMAIN` and
`ALERT_EMAIL` are all set. Mailgun's US API endpoint (`api.mailgun.net`) is used.

### Page gate

| Name | Default | Description |
|---|---|---|
| `MONITOR_GATE` | not set | Set to `"on"` to require the `MONITOR_TOKEN` secret before showing `/` and `/mockups`. If `on` while `MONITOR_TOKEN` is missing, those pages refuse with a clear error rather than silently reopening. `/embed`, `/control` and the API are never gated by this. |

---

## Secrets (`npx wrangler secret put NAME`)

| Name | Required | Description |
|---|---|---|
| `PECRON_EMAIL` | Yes | Your Pecron app login email. |
| `PECRON_PASSWORD` | Yes | Your Pecron app password. |
| `PECRON_SECRET_US` / `PECRON_SECRET_EU` / `PECRON_SECRET_CN` | The one matching `PECRON_REGION` | Vendor app-level signing secret. See SETUP.md step 4 for where to find it. |
| `CONTROL_TOKEN` | For control | Bearer token for `POST /api/control` (the `/control` page asks for it) and `POST /api/test-alert`. **Unset means all control is refused.** |
| `INGEST_TOKEN` | For the LAN agent / manual polls | Bearer token for `POST /api/ingest` and `POST /api/poll`. Unset means those endpoints refuse everyone (fail closed). |
| `MAILGUN_API_KEY` | For email alerts | Mailgun sending key. |
| `MONITOR_TOKEN` | Optional | Password for the page gate (HTTP Basic; any username). Setting it enforces the gate even without `MONITOR_GATE`. |
| `ALERT_WEBHOOK` | Optional | A Discord or Slack incoming-webhook URL (or any URL accepting plain text, such as ntfy) that receives the same alerts as email. Free relays such as ntfy.sh often rate-limit Cloudflare's shared addresses, so email is the more reliable channel. |

A secret changed in the Cloudflare dashboard needs `npx wrangler deploy` before the
running Worker sees it. One changed with `wrangler secret put` applies immediately.

On Windows, `set-secrets.ps1` sets the required secrets in one pass and
`rotate-tokens.ps1 -Ingest | -Control | -Monitor` replaces tokens. Both write new
tokens to the git-ignored `.tokens.local.txt`.

---

## src/site.config.js

| Field | Default | Description |
|---|---|---|
| `pevs` | one fictional example | List of vehicles that charge from this system, shown in the dashboard's "What charges here" card and returned by `/api/summary` as `pevs`. **The first entry drives the mile figures.** Use `[]` to hide the card (mile figures then return `null`). |
| `chargeEfficiency` | `0.85` | Fraction of battery energy that ends up in a vehicle's pack after charger and inverter losses. Used for "miles on sunlight". |
| `ratedCycles` | `3500` | Rated cycle life of the station's battery, for "pack life used". Check your unit's spec sheet. |
| `peakSunHoursNorm` | `null` | Optional typical peak sun hours for your region, shown beside your own figure. `null` hides it. |
| `gridCo2KgPerKwh` | `null` | Optional grid emissions factor, used only on `/mockups`. `null` hides the CO2 estimate. |

### Vehicle fields

Every field may be `null`; the dashboard skips what is missing.

| Field | Example | Description |
|---|---|---|
| `name` | `"Example E-Bike"` | Display name. |
| `type` | `"electric bike"` | Free text: e-bike, scooter, skateboard... |
| `role` | `"daily commuter"` | Optional free text shown after the type. |
| `pack` | `"13s4p example pack"` | Battery description. |
| `cells` | `52` | Number of cells. |
| `capacityWh` | `720` | Pack capacity in Wh. |
| `capacityAh` | `14` | Pack capacity in Ah. |
| `voltsNominal` | `48` | Nominal voltage (shown in preference to `voltsFull`). |
| `voltsFull` | `54.6` | Full-charge voltage. |
| `motor` | `null` | Motor description. |
| `controller` | `null` | Controller description. |
| `whPerMile` | `25` | Measured energy use in Wh per mile. Drives `milesEquivalent*` on the first vehicle. |
| `whPerMileSource` | `"..."` | Where that figure came from; quoted in `/api/summary` → `assumptions.note`. |
| `charger` | `"Example 2 A charger"` | Charger description. |
| `chargerWatts` | `110` | Charger power. |
| `chargerAmps` | `2` | Charger current. |
| `commuteMiles` | `20` | One round-trip commute in miles. Drives `commutesBanked` on the first vehicle. |
| `blogUrl` | `null` | Optional link, shown as "More ->". |

---

## Page placeholders

The HTML pages contain tokens that the Worker fills in when it serves them, so you do
not need to edit the HTML for a normal install:

| Token | Filled with |
|---|---|
| `__SITE_NAME__` | `SITE_NAME` (HTML-escaped) |
| `__DEVICE_NAME__` | `DEVICE_NAME` (HTML-escaped) |
| `__CAPACITY_WH__`, `__CAPACITY_WH_FMT__`, `__CAPACITY_KWH__` | `BATTERY_CAPACITY_WH` as `3072`, `3,072`, `3.1` |
| `__PANEL_WATTS__` | `PANEL_WATTS` |
| `__SOLAR_WINDOW_OPENS__` | `SOLAR_WINDOW_OPENS` as `HH:MM` |
| `__EMBED_ACCENT__` | `EMBED_ACCENT` |
| `__PSH_NORM__`, `__CO2_KG_PER_KWH__` | the matching `site.config.js` fields, or empty |

Only these exact names are replaced. To change colours beyond the embed accent, edit
the CSS custom properties (`--brand` and friends) at the top of each page.
