# pecron-solar-dashboard

A small, always-on solar dashboard for a **Pecron portable power station**, running
entirely on **Cloudflare's free tier**.

A Cloudflare Worker logs into Pecron's IoT cloud (the same service the Pecron phone app
uses), reads your unit every 5 minutes, and stores each reading in a Cloudflare D1
database. It then serves a live dashboard, an embeddable widget for your own website,
a token-protected control page, and a JSON API. It can also email you when something
needs attention.

It was built against an **F3000LFP**. Other Pecron models that use the same cloud and
property names will probably work, but have not been tested.

No computer at home needs to stay on: collection runs in Cloudflare's data centres.

## Features

- **Live dashboard** (`/`): state of charge, solar input, AC/DC output, pack voltage
  and current, temperature, history charts (6 h / 24 h / 7 d), a daily energy balance
  table, an hour-by-day solar heatmap, pack-health drift, value of the energy
  generated, and "miles on sunlight" for any e-bikes or other vehicles you charge.
- **Embeddable widget** (`/embed`): a compact public panel for your own site, with
  theme, background, accent colour and font controlled by query parameters, and
  automatic iframe height.
- **Device control** (`/control`): turn AC output on or off, toggle ECO standby, set
  the AC charge speed. Every attempt is logged, including refusals.
  **DC output can never be switched remotely** (see the safety note below).
- **Email alerts** through Mailgun: telemetry has stopped, the unit reports a fault
  code, or the battery will not last until the sun is back on the panel. Alerts go
  out once when a problem starts and once when it clears, never on repeat.
- **Honest data handling**: gaps are never filled in with invented energy, and a
  frozen cloud feed (the vendor cloud repeating the last reading after the unit has
  gone offline) is detected and not recorded.
- **Optional LAN agent** (`agent/solar_agent.py`): a second data source that reads the
  unit directly over your local network with the MIT-licensed
  [`pecron-monitor`](https://github.com/attractify-logan/pecron-monitor) package.

## Architecture at a glance

```
 Pecron unit --Wi-Fi--> Pecron IoT cloud <--every 5 min-- Cloudflare Worker --> D1 database
                                                                |
                                     dashboard, widget, control page, JSON API, email alerts

 (optional) LAN agent on a PC --reads unit over local network--> POST /api/ingest
```

Both sources write into the same table and are de-duplicated on `sample_id`. More
detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

You need a Cloudflare account (free), Node.js, and the Pecron app account your unit is
paired to.

```sh
npm install -g wrangler        # or use "npx wrangler" everywhere below
npx wrangler login
npx wrangler d1 create pecron-solar-dashboard        # paste the id into wrangler.toml
npx wrangler d1 execute pecron-solar-dashboard --remote --file=schema.sql
npx wrangler secret put PECRON_EMAIL
npx wrangler secret put PECRON_PASSWORD
npx wrangler secret put PECRON_SECRET_US             # or _EU / _CN, see docs/SETUP.md
npx wrangler secret put CONTROL_TOKEN
npx wrangler secret put INGEST_TOKEN
# edit the [vars] block in wrangler.toml, and src/site.config.js
npx wrangler deploy
```

Then open `https://pecron-solar-dashboard.<your-subdomain>.workers.dev/api/health`.

**New to Cloudflare? Follow [docs/SETUP.md](docs/SETUP.md)**, which goes step by step
from zero, including where to find each value.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Step-by-step install, alerts, custom domain, embedding, LAN agent |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every variable, secret and `site.config.js` field |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data flow, endpoints, database tables, alerting |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Frozen feeds, "No permission", re-pairing, vendor field quirks |

## Repository layout

| Path | What |
|---|---|
| `src/index.js` | the Worker: vendor login, polling, rollups, alerting, control, all routes |
| `src/site.config.js` | structured site settings (vehicles, cycle rating, optional norms) |
| `src/monitor.html` | `/`: the full dashboard |
| `src/embed.html` | `/embed`: the embeddable widget |
| `src/control.html` | `/control`: token-gated device control |
| `src/mockups.html` | `/mockups`: ideas for further metrics, labelled live / projected / needs hardware |
| `schema.sql` | D1 schema |
| `wrangler.toml` | Worker config and the `[vars]` settings |
| `set-secrets.ps1`, `rotate-tokens.ps1` | Windows helpers to set secrets and rotate tokens |
| `agent/` | the optional LAN agent and its Windows Task Scheduler setup script |

## Safety note: DC output

The Worker **refuses** any request to switch the DC output (`dc_switch_hm`) with
HTTP 403, and the control page shows it as locked. This is deliberate and should stay
that way.

Many setups run the router, modem or other network gear from the station's DC
output. If that output is switched off remotely, the internet connection goes with
it, and so does every way of switching it back on: this dashboard, the Pecron app's
cloud connection, everything. The only fix is to go to the unit in person. The
refusal lives in the Worker, not only in the page, so a hand-written request cannot
do it either.

Control access also **fails closed**: if `CONTROL_TOKEN` is not set, every control
request is refused.

## Disclaimer

This is an independent, community project. It is **not affiliated with, endorsed by,
or supported by Pecron** or its cloud provider. It talks to an undocumented vendor API
that may change at any time. Use it at your own risk, and keep using the official app
for anything safety-critical.

## License

MIT. See [LICENSE](LICENSE).
