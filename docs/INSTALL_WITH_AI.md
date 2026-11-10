# Install with an AI assistant

You can have an AI assistant walk you through the whole install interactively. This
works with Claude (Claude Code or the Claude apps) or any similar assistant.

- **Assistants that can run commands** on your computer, such as Claude Code, can do
  most of the work. They stop and ask you whenever a step needs your input or a
  password.
- **Chat-only assistants** guide you one step at a time. You run each command yourself
  and paste back the output.

Either way, **you never paste a password or token into the chat.** Wrangler asks you
for secrets directly in your terminal, and the assistant is told to work that way.

## How to start

1. Download or clone this repository. Use the green **Code** button on the GitHub page.
2. Open your assistant **in the project folder**, the one containing `wrangler.toml`.
   For Claude Code, run `claude` from that folder.
3. Paste the prompt below.

```text
Please install pecron-solar-dashboard for me, interactively.

Read docs/INSTALL_WITH_AI.md in this project first, especially the section
"Instructions for the AI assistant", and follow it exactly. Use docs/SETUP.md as the
step-by-step reference. Ask me questions one or two at a time, explain each step in
plain language before you run it, and stop for my OK before anything that deploys or
changes my Cloudflare account.
```

If your assistant can't read files, paste the contents of this file and of
`docs/SETUP.md` into the chat after the prompt.

---

## Instructions for the AI assistant

You are helping a person install this project on their own Cloudflare account. They
may have no Cloudflare or command-line experience. `docs/SETUP.md` is the
authoritative step list, and `docs/CONFIGURATION.md` describes every setting. Follow
them, and these rules on top.

### Rules that always apply

1. **Never ask for secrets in the chat, and never print them.** That covers the Pecron
   password, the vendor app secret, `CONTROL_TOKEN`, `INGEST_TOKEN`, `MONITOR_TOKEN`
   and the Mailgun key. Use `npx wrangler secret put NAME` so the person types the
   value into wrangler's own prompt. If you can run commands but the prompt needs
   their keyboard, ask them to run that one command themselves. When you generate a
   token, pipe it straight into `wrangler secret put` and into a git-ignored file such
   as `.tokens.local.txt`. Never echo it. If a secret shows up in output by accident,
   tell the person and suggest rotating it.
2. **Ask before anything outward-facing:** `wrangler deploy`, creating the D1 database,
   adding a custom domain, sending a test alert, or switching anything on the device.
   Explain what will happen, then wait for a yes.
3. **Never commit secrets.** `config.yaml`, `.tokens.local.txt`, `.dev.vars` and `.env`
   are git-ignored. Keep them that way.
4. **One step at a time.** Ask at most two questions per message. After each step,
   check that it worked before moving on.
5. **Don't guess values.** Ask the person for things like timezone, battery size and
   electricity rate, or read them from output. If they don't know their electricity
   rate, leave `GRID_RATE_VERIFIED = "false"` and say the value figures are
   placeholders.
6. **Leave DC control locked unless they choose otherwise.** See the DC question below.

### Before you start: questions to ask

Ask these early. Each answer decides part of the setup.

| Question | Why it matters |
|---|---|
| Is the power station already paired in the Pecron app, and does the app show live readings? | Required. If not, they must fix that first; see TROUBLESHOOTING.md. |
| Which Pecron model? | Built against the F3000LFP. Others may work but are untested; set `BATTERY_CAPACITY_WH` to match. |
| Which region is their Pecron account in: North America, Europe or China? | Sets `PECRON_REGION` and which `PECRON_SECRET_*` is needed. |
| Do they already have a Cloudflare account? | If not, they sign up (free) before step 2. |
| What is their timezone? | `SITE_TIMEZONE`, as an IANA name such as `America/Chicago`. |
| Panel size in watts, and roughly when does the panel start getting real sun? | `PANEL_WATTS`, `SOLAR_WINDOW_OPENS`. |
| **Does their router, modem or any network gear run from the station's DC output?** | Decides `ALLOW_DC_CONTROL`. See below. |
| Do they want email alerts (Mailgun account), a custom domain, the website widget, or the Windows LAN agent? | Each is optional. Skip the matching SETUP.md steps if not. |

### The DC question

By default `/control` can't switch the DC output. Keep `ALLOW_DC_CONTROL = "false"`
if:

- any network gear (router, modem, Wi-Fi extender, mesh node) runs from DC, or
- they aren't sure.

Switching DC off remotely in that setup takes the internet down, along with the
dashboard and every way to switch DC back on. Recovery means going to the unit in
person.

Set it to `"true"` only if they confirm their network is powered some other way and
they want DC buttons on the control page. Explain the trade-off in one or two
sentences and let them choose.

### Step map

Work through `docs/SETUP.md` in order:

1. **Accounts (SETUP step 1).** Confirm the Cloudflare and Pecron accounts exist.
2. **Tools (step 2).** Check `node --version`. Install Node.js LTS if it's missing.
   Run `npx wrangler login`. It opens a browser, and the person approves it.
3. **Database (step 3).** `npx wrangler d1 create pecron-solar-dashboard`. Put the
   printed id into `wrangler.toml`. Then run the schema with `--remote`.
4. **Secrets (step 4).** Follow rule 1 strictly.
   - `PECRON_EMAIL` and `PECRON_PASSWORD`: the person types them into wrangler's
     prompt.
   - Regional vendor secret: use the pipe command in SETUP.md so the value never
     appears on screen. It needs `pip install pecron-monitor` first.
   - `CONTROL_TOKEN` and `INGEST_TOKEN`: generate them and pipe them in. Tell the
     person where the copy was saved, so they can move it to a password manager.
   - On Windows, `.\set-secrets.ps1` does all of this in one pass, and the person can
     run it themselves.
5. **Device keys (step 5).** Option A, auto-discovery, is simplest for one device. If
   their account has several Pecron devices, use option B.
6. **Settings (step 6).** Fill `[vars]` in `wrangler.toml` from their answers:
   - Set `ALLOW_DC_CONTROL` from the DC question.
   - Edit `src/site.config.js`: replace the example vehicle with theirs, or use `[]`.
   - Show them a short summary of what you set.
7. **Deploy (step 7).** Ask first. Then run `npx wrangler deploy` and give them the
   address it prints.
8. **Verify (step 8).** Trigger a poll with `/api/poll`, or wait up to 5 minutes. Then
   fetch `/api/health`. Success means `lastSampleAt` is recent and `lastError` is
   `null`. If not, use the bullets in step 8 and `docs/TROUBLESHOOTING.md`. Don't
   declare success until a real reading has been stored.
9. **Optional extras (steps 9 to 12)**, only the ones they asked for.
   - **Alerts:** after the test alert, ask them to confirm the email reached their
     inbox. Mailgun accepting a message doesn't mean it was delivered.
   - **LAN agent:** Windows only. The setup script creates daily tasks with the
     battery and missed-run settings already correct.

### Finishing up

Give the person a short summary:

- **Their addresses:** the dashboard `/`, the widget `/embed`, the control page
  `/control` and the health check `/api/health`.
- **Where their tokens are saved**, with a reminder to move them into a password
  manager and delete the local file.
- **What's still a placeholder,** such as the electricity rate or the solar window.
- **How to update later:** pull the latest code, review it, and run
  `npx wrangler deploy`.
- **Where to look when something breaks:** `docs/TROUBLESHOOTING.md`, and
  `npx wrangler tail` for live logs.
