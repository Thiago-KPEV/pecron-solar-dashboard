# Setup guide

This guide takes you from nothing to a working dashboard. It assumes no previous
Cloudflare experience. Expect it to take 30 to 60 minutes the first time.

Commands are shown as `npx wrangler ...`, which works without installing wrangler
globally. They run the same on Windows (PowerShell), macOS and Linux unless noted.
Run them from the project folder (the one containing `wrangler.toml`).

---

## 1. Accounts you need

| Account | Needed? | Cost | What for |
|---|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Yes | Free plan is enough | Runs the Worker, the cron job and the D1 database |
| Pecron app account | Yes | Free | The account your power station is paired to in the Pecron app. The Worker logs in as this account. |
| [Mailgun](https://www.mailgun.com/) | Optional | Free tier available | Sends alert emails |
| A domain on Cloudflare | Optional | Whatever your registrar charges | A nice address such as `solar.example.com` instead of `*.workers.dev` |

Your unit must already be **set up in the Pecron app and connected to Wi-Fi**. If the
app can see live readings from the unit, the Worker will be able to as well.

---

## 2. Install Node.js and wrangler

1. Install **Node.js** (the LTS version) from <https://nodejs.org/>. This also installs
   `npm` and `npx`.
2. Check it worked:

   ```sh
   node --version
   npx wrangler --version
   ```

   The first `npx wrangler` run downloads wrangler, Cloudflare's command-line tool.
   (You can install it permanently with `npm install -g wrangler` and then drop the
   `npx`.)

3. Log wrangler in to your Cloudflare account:

   ```sh
   npx wrangler login
   ```

   A browser window opens; approve the access request. Wrangler remembers this.

---

## 3. Create the database

The Worker stores every reading in **D1**, Cloudflare's SQLite database.

1. Create it:

   ```sh
   npx wrangler d1 create pecron-solar-dashboard
   ```

   The output includes a line like `database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`.

2. Open `wrangler.toml` and replace `REPLACE-WITH-YOUR-D1-DATABASE-ID` with that id.

3. Create the tables. `--remote` matters: without it wrangler only touches a local test
   copy on your computer.

   ```sh
   npx wrangler d1 execute pecron-solar-dashboard --remote --file=schema.sql
   ```

---

## 4. Set the secrets

Secrets are values the Worker needs but that must never be in the repository.
Cloudflare stores them encrypted. Each command below prompts you to type or paste the
value. On Windows you can instead run `.\set-secrets.ps1`, which prompts for the Pecron
values, generates the two tokens for you, and saves the tokens to `.tokens.local.txt`
(git-ignored).

> **Gotcha:** secrets set with `wrangler secret put` take effect straight away. A secret
> added or changed in the **Cloudflare dashboard** instead is not seen by the running
> Worker until you **redeploy** (`npx wrangler deploy`).

### PECRON_EMAIL and PECRON_PASSWORD

Your Pecron app login.

```sh
npx wrangler secret put PECRON_EMAIL
npx wrangler secret put PECRON_PASSWORD
```

### PECRON_SECRET_<REGION>

The Pecron cloud requires every login to be signed with an **app-level secret** that is
built into the Pecron app. It is the same for every user of a region, not a personal
password, but this project still does not ship it: you set it yourself.

The MIT-licensed [`pecron-monitor`](https://github.com/attractify-logan/pecron-monitor)
Python package publishes these values in its `constants.py` file, in its `REGIONS`
table. Which entry you need depends on `PECRON_REGION` in `wrangler.toml`:

| `PECRON_REGION` | Secret name | Where in pecron-monitor's `constants.py` |
|---|---|---|
| `US` (default) | `PECRON_SECRET_US` | `REGIONS["na"]["user_domain_secret_fallback"]` (the entry paired with user domain `U.DM.10351.1`) |
| `EU` | `PECRON_SECRET_EU` | `REGIONS["eu"]["user_domain_secret"]` |
| `CN` | `PECRON_SECRET_CN` | `REGIONS["cn"]["user_domain_secret"]` |

To copy it without it ever appearing on screen, install the package (`pip install
pecron-monitor`, see step 12) and pipe it straight into wrangler. For the US region:

```sh
python -c "import constants; print(constants.REGIONS['na']['user_domain_secret_fallback'])" | npx wrangler secret put PECRON_SECRET_US
```

(`constants` is one of pecron-monitor's top-level modules. If the import fails, open
the installed `constants.py` and copy the value from the table above by hand.)

Only the secret for your own region is needed. If it is missing, the Worker says so
by name in `/api/health` → `lastError`.

### CONTROL_TOKEN and INGEST_TOKEN

Two passwords you invent. Use long random strings. One way to make one:

```sh
node -e "console.log(require('crypto').randomBytes(21).toString('base64url'))"
```

```sh
npx wrangler secret put CONTROL_TOKEN     # unlocks /control and /api/test-alert
npx wrangler secret put INGEST_TOKEN      # used by the LAN agent and POST /api/poll
```

Write both down somewhere safe (a password manager). Cloudflare cannot show them to
you again. `rotate-tokens.ps1` replaces lost ones.

**Always set `INGEST_TOKEN`.** If it is unset, `/api/ingest` and `/api/poll` accept
requests from anyone. (`CONTROL_TOKEN` is the opposite: unset means control is
refused for everyone.)

### MAILGUN_API_KEY (optional)

Only needed for email alerts. In Mailgun, add and verify a sending domain (for example
`mg.example.com`), then create a sending API key for it.

```sh
npx wrangler secret put MAILGUN_API_KEY
```

You can check which secrets exist (names only) with `npx wrangler secret list`.

---

## 5. Find your device keys (PECRON_PK / PECRON_DK)

The Worker needs your unit's **product key** (PK) and **device key** (DK). You have two
options.

**Option A: let the Worker find them.** Leave `PECRON_PK` and `PECRON_DK` empty in
`wrangler.toml`. The Worker then asks the Pecron cloud for the devices on your account
and uses the first one. It logs the keys it found, so you can copy them in later and
save an API call on every poll:

```sh
npx wrangler tail          # leave running in one terminal
```

After deploying (step 7), wait for the next 5-minute poll, and look for a line like
`[device] ... PECRON_PK="..." PECRON_DK="..."`.

If your account has more than one Pecron device, use option B so the Worker reads the
right one.

**Option B: from pecron-monitor.** Run `pecron-monitor --setup` (see step 12). It logs
in, lists your devices and writes a `config.yaml` that contains `product_key` and
`device_key`. The device key is often the unit's Wi-Fi MAC address without colons.

---

## 6. Fill in your settings

1. Open `wrangler.toml` and work through the `[vars]` block. Every value has a comment,
   and [CONFIGURATION.md](CONFIGURATION.md) explains each one. The important ones:
   - `SITE_NAME`: shown on every page and in alert subjects.
   - `SITE_TIMEZONE`: your IANA timezone, for example `Europe/London` or
     `America/Chicago`.
   - `PECRON_REGION`, and `PECRON_PK` / `PECRON_DK` from step 5.
   - `BATTERY_CAPACITY_WH`, `PANEL_WATTS`: your hardware.
   - `SOLAR_WINDOW_OPENS`: when your panel starts producing properly.
   - `GRID_RATE_USD_PER_KWH`: **set your own** from an electricity bill (total charges
     divided by total kWh), then set `GRID_RATE_VERIFIED = "true"`.
   - `MAILGUN_DOMAIN` and `ALERT_EMAIL` if you want email alerts.
2. Open `src/site.config.js`. Replace the example vehicle with your own (or empty the
   list), and adjust the other fields if you like.

---

## 7. Deploy

```sh
npx wrangler deploy
```

Wrangler prints the Worker's address, something like
`https://pecron-solar-dashboard.<your-subdomain>.workers.dev`.

The cron trigger starts straight away. The first reading arrives within 5 minutes. To
take one immediately instead:

```sh
curl -X POST -H "Authorization: Bearer <INGEST_TOKEN>" https://<your-worker>/api/poll
```

(On Windows PowerShell use `curl.exe` rather than `curl`.)

---

## 8. Confirm it works: /api/health

Open `https://<your-worker>/api/health` in a browser. A healthy result looks like:

```json
{
  "ok": true,
  "region": "US",
  "credentialsConfigured": true,
  "lastSampleAt": "2026-01-31T10:05:02-05:00",
  "lastSampleAgeMinutes": 2,
  "lastSampleSource": "cloud",
  "sourcesActive": ["cloud"],
  "stale": false,
  "cloudRepeating": null,
  "lastError": null
}
```

- `lastSampleAt` is `null` and `lastError` names a secret: set that secret.
- `lastError` says "No permission" or similar: see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- `cloudRepeating` is not `null`: the unit has stopped reporting to the cloud; see
  TROUBLESHOOTING.md.

Then open `https://<your-worker>/` for the dashboard.

For live logs at any time, run `npx wrangler tail`.

---

## 9. Test the alert emails

Once `MAILGUN_API_KEY` (secret), `MAILGUN_DOMAIN` and `ALERT_EMAIL` (vars) are set and
deployed, send a test:

```sh
curl -X POST -H "Authorization: Bearer <CONTROL_TOKEN>" https://<your-worker>/api/test-alert
```

- HTTP 200 with `"email": "delivered to Mailgun"` means Mailgun **accepted** the message.
- HTTP 503 lists what is missing.

**Now check that the email actually arrived**, including the spam folder. Mailgun
accepting a message is not the same as it reaching an inbox. A brand-new sending domain
often goes to spam until its DNS records (SPF, DKIM) are verified in Mailgun. Do not
consider alerting set up until you have seen the test email in your inbox.

Real alerts are sent when telemetry stops for longer than `ALERT_STALE_MINUTES`, when
the unit reports a fault code, and when the battery is not expected to last until
`SOLAR_WINDOW_OPENS`. Each is sent once when it starts and once when it clears.

---

## 10. Add a custom domain (optional)

The domain must be added to your Cloudflare account (its DNS managed by Cloudflare).

1. In `wrangler.toml`, uncomment the `routes` block and put in your hostname:

   ```toml
   routes = [
     { pattern = "solar.example.com", custom_domain = true }
   ]
   ```

2. `npx wrangler deploy`. Cloudflare creates the DNS record and the HTTPS certificate
   for you. It can take a few minutes before the address works.

You can keep `workers_dev = true` so the `workers.dev` address keeps working too, or
set it to `false` to serve only on your domain.

---

## 11. Embed the widget on your website (optional)

Add this to any web page, replacing `solar.example.com` with your Worker's address in
both places:

```html
<iframe id="solar-embed"
        src="https://solar.example.com/embed?theme=light"
        title="Solar dashboard"
        loading="lazy"
        style="width:100%; border:0; height:620px; overflow:hidden"></iframe>
<script>
  // The widget reports its own height so the iframe never shows a scrollbar.
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://solar.example.com") return;   // only trust your Worker
    if (e.data && typeof e.data.solarEmbedHeight === "number") {
      document.getElementById("solar-embed").style.height = e.data.solarEmbedHeight + "px";
    }
  });
</script>
```

Query parameters, all optional:

| Parameter | Values | Effect |
|---|---|---|
| `theme` | `light`, `dark` | Force a theme. Omitted: follows the visitor's system setting. |
| `bg` | `transparent` | Let your page's background show through. |
| `accent` | six hex digits, e.g. `2E7D5B` (no `#`) | Accent colour. Default: `EMBED_ACCENT` in `wrangler.toml`. |
| `font` | a Google Fonts family name, e.g. `Inter` | Use your site's typeface. |

For example: `/embed?theme=dark&bg=transparent&accent=E2622C&font=Inter`.

The widget sends `{ solarEmbedHeight: <pixels> }` to the parent page whenever its height
changes. Keep the `e.origin` check in the listener above.

The widget and the read API it uses are deliberately public. Do not put them behind
the optional page gate (`MONITOR_GATE`), or every page that embeds the widget breaks.

---

## 12. Optional: the LAN agent on Windows

The Worker does not need this. The agent is a second source that reads the unit
directly over your local network and sends the readings to `/api/ingest`. It is useful
for cross-checking the cloud feed and for catching the overnight state on a schedule.
It needs a Windows PC on the same network as the unit (the agent itself is plain
Python and also runs elsewhere, but the setup script is Windows-only).

1. **Install Python 3.12+** from <https://www.python.org/downloads/>. Tick "Add
   python.exe to PATH" in the installer.

2. **Install pecron-monitor:**

   ```powershell
   pip install pecron-monitor
   ```

   (If that name is not found on PyPI, install it from its repository:
   `pip install https://github.com/attractify-logan/pecron-monitor/archive/refs/heads/main.zip`.)

3. **Run its setup once:**

   ```powershell
   pecron-monitor --setup
   ```

   It asks for your Pecron login and writes a `config.yaml` with your device details
   and the unit's local IP address. That file contains your password: never commit it
   (`.gitignore` already excludes `config.yaml`).

4. **Check a reading works** without sending anything:

   ```powershell
   python agent\solar_agent.py --once --dry-run
   ```

   You should see a JSON record with your battery's state of charge.

5. **Register the scheduled tasks and the ingest address:**

   ```powershell
   cd agent
   .\setup-agent.ps1 -IngestUrl https://<your-worker>/api/ingest
   .\setup-agent.ps1 -SetToken          # paste INGEST_TOKEN; stored encrypted (DPAPI)
   .\setup-agent.ps1 -Status
   ```

   This creates two **daily** tasks: a morning reading (`--once`, default 08:00) and an
   end-of-day reading plus rollup (`--close`, default 18:00). Change the times with
   `-MorningTime` and `-CloseTime`. A morning time before `SOLAR_WINDOW_OPENS` captures
   the overnight state before the panel starts charging.

   If you create or edit the tasks by hand in Task Scheduler instead, two settings are
   easy to lose and matter a lot:

   - **DisallowStartIfOnBatteries = false.** In Task Scheduler: *Conditions* tab →
     untick "Start the task only if the computer is on AC power". The default skips
     every run while a laptop is unplugged, with no error.
   - **StartWhenAvailable = true.** *Settings* tab → tick "Run task as soon as possible
     after a scheduled start is missed". Otherwise a run missed because the PC was off
     is simply lost.

   Use **Daily** triggers, not **One time**: a one-time trigger fires once and never
   again. `.\setup-agent.ps1 -Status` prints both settings for each task so you can
   check them.

   The tasks point at `solar_agent.py` by its full path. If you move the folder, run
   `setup-agent.ps1` again from the new location.

6. **Optional address self-heal.** If your router gives the unit a different IP address
   from time to time, set two user environment variables: `SOLAR_DEVICE_MAC` (the unit's
   MAC address) and `SOLAR_SUBNET` (the first three numbers of your network, for example
   `10.0.0`). After a failed read, the agent finds the unit by MAC and updates
   pecron-monitor's `config.yaml`. Run `python agent\solar_agent.py --resolve` to test.

When the agent is sending, `/api/health` shows `"sourcesActive": ["cloud", "lan"]`
and `localPolling.active: true` for about 20 minutes after each run.

---

## Next steps

- [CONFIGURATION.md](CONFIGURATION.md) for every setting.
- [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) when something looks wrong.
