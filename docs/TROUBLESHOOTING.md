# Troubleshooting

Start with two things:

- `https://<your-worker>/api/health`, especially `lastError`, `stale` and
  `cloudRepeating`.
- `npx wrangler tail`, which streams the Worker's live logs. Each poll logs a
  `[poll] ...` line.

---

## The cloud feed is frozen (`cloudRepeating` in /api/health)

**What you see:** `/api/health` shows something like

```json
"cloudRepeating": { "since": "2026-01-31T13:10:02-05:00", "repeats": 42, "note": "..." }
```

the dashboard says **Offline**, and the "telemetry stopped" email may mention that the
cloud is repeating the same reading.

**What it means:** the unit has **stopped reporting to Pecron's cloud**, but the cloud
keeps answering with its last values. The Worker recognises this (identical readings,
down to the millivolt, several polls in a row) and stops recording the repeats, so your
history shows an honest gap instead of invented data. The Pecron app will show the same
frozen numbers.

**What to do:** it is almost always the unit's internet connection.

1. Check the router or Wi-Fi the unit uses is up, and that the unit is in range.
2. If the router is powered by the station, check that output is still on.
3. Power-cycle the unit's Wi-Fi (or the unit) if needed.

`cloudRepeating` clears by itself with the first reading that differs.

---

## "No permission" (or similar) in `lastError`

**What it means:** the login works, but **the unit is not bound to the account the
Worker logs in with**. Common causes: the unit was paired in the app with a different
account (a family member's, or an old one); it was shared to your account rather than
owned by it; or it was reset and re-paired to another account.

**What to do:**

1. Open the Pecron app logged in with exactly the `PECRON_EMAIL` the Worker uses, and
   check the unit appears there with live readings.
2. If it does not, **re-pair the unit on that same account** in the app.
3. If you set `PECRON_PK` / `PECRON_DK`, check they belong to that unit. Leaving both
   empty makes the Worker pick the first device bound to the account and log its keys
   (see SETUP.md step 5).

A wrong `PECRON_REGION`, or a signing secret from the wrong region, usually fails
**earlier**, at login, with an error about credentials or the signature. Check the
region matches where your app account was created, and that the matching
`PECRON_SECRET_<REGION>` is set.

---

## Re-pairing when the router is powered by the station

This is a catch-22 worth planning for. Re-pairing a unit to Wi-Fi usually means
resetting its network settings. But if your router (or mobile hotspot) runs off the
same station, a reset or a power cycle can cut the router's power, and the unit then has
no network to join while you pair it.

**Do this instead:**

1. **Power the router from a separate source first**: a USB power bank, another battery
   bank, or a wall socket if you have one nearby.
2. **Wait for the router to finish booting** and for its Wi-Fi network to appear. This
   can take a few minutes.
3. **Then** reset the unit's network settings and pair it in the app.
4. Once readings appear in the app (and in `/api/health`), move the router back to the
   station if you want.

This is also why the Worker refuses to switch the DC output remotely: if the router
runs from DC, switching it off remotely strands you with no way back in.

---

## Known vendor field quirks

Some odd readings come from the device or the vendor cloud, not from this project.
Check the Pecron app before suspecting the Worker.

### `ac_out_w` underreports small loads

The AC output watts reading can show **0 W or a very low value while a small AC load is
clearly running**. The inverter's own idle draw is not counted either. Consequences:

- AC consumption in `/api/daily` can be lower than reality.
- The overhead estimate (`overheadWattHours`, which compares harvest, delivered energy
  and the change in stored energy) absorbs what the AC reading misses. That is the
  more honest figure for "where did the energy go".
- Do not treat `ac_out_w = 0` as proof that nothing is plugged in.

### `solar_w` lags in the morning

The solar input reading can **trail the real panel output early in the day**, staying
at or near 0 W for a while after the panel is visibly in sun, then catching up. The
first morning readings and the morning edge of the heatmap can therefore look later or
weaker than reality. Watch a few days of the heatmap before deciding your panel is
shaded, and set `SOLAR_WINDOW_OPENS` from what you see over several days.

### Status says "Shut down" while running

The device often reports status 0 ("Shut Down" in its own list) whenever it is not
charging, including while it is powering loads. The dashboard only trusts the status
value above 0 and otherwise describes what the power flow is doing.

---

## Other common problems

| Symptom | Likely cause and fix |
|---|---|
| `lastError` names `PECRON_SECRET_...` | That secret is not set: `npx wrangler secret put PECRON_SECRET_<REGION>`. |
| `lastError`: `PECRON_EMAIL / PECRON_PASSWORD secrets are not set` | Set both secrets. |
| A secret was changed but nothing changed | If you changed it in the Cloudflare dashboard, run `npx wrangler deploy`. |
| Login keeps failing on `US` with correct credentials | The `US` entry in `REGIONS` (`src/index.js`) uses the user domain `U.DM.10351.1`, which pairs with pecron-monitor's `user_domain_secret_fallback`. pecron-monitor also lists a newer North America domain (`C.DM.10351.1`). If your account is on that one, changing `userDomain` for `US` and using the matching secret may help. This has not been verified here. |
| `/api/test-alert` returns 200 but no email arrives | Check spam; verify your Mailgun domain's DNS records; check Mailgun's logs. Mailgun accepting a message does not mean it was delivered. |
| `/api/test-alert` returns 401 | Wrong `CONTROL_TOKEN`, or it is not set (control fails closed). |
| Dashboard shows `—` everywhere | No data yet. Wait for a poll, or `POST /api/poll` with `INGEST_TOKEN`. |
| Times or day boundaries look wrong | `SITE_TIMEZONE` is unset or wrong. Existing rows keep the zone they were stored in. |
| Pages return 503 "MONITOR_GATE is on but MONITOR_TOKEN is not set" | Set the `MONITOR_TOKEN` secret, or remove `MONITOR_GATE` and redeploy. |
| Embed iframe has a scrollbar or wrong height | Add the `message` listener from SETUP.md step 11, and check its origin matches your Worker's address exactly. |
| LAN agent: `no telemetry returned` | The PC cannot reach the unit. Run `pecron-monitor --raw --local --no-ble` by hand; check `lan_ip` in pecron-monitor's `config.yaml`, or set `SOLAR_DEVICE_MAC` and `SOLAR_SUBNET` and run `python agent\solar_agent.py --resolve`. |
| LAN agent tasks never run on a laptop | The task's "Start only if on AC power" condition is on. Re-run `setup-agent.ps1`, or untick it (SETUP.md step 12). |
