/**
 * pecron-solar-dashboard - Cloudflare Worker
 * ==========================================
 * Always-on telemetry for a Pecron power station (built against an F3000LFP).
 *
 * A Cron Trigger polls Pecron's IoT cloud every few minutes and writes each
 * reading to D1. Nothing on the local network has to stay running for data to
 * be collected.
 *
 * One hard limit worth stating up front: this reaches the device through
 * Pecron's servers, so it only sees the unit while the unit has an internet
 * uplink. If the router or Wi-Fi the unit reports through goes down, the device
 * goes dark to the cloud as well, and nothing off-site can see through that gap.
 *
 * The optional LAN agent (agent/solar_agent.py) POSTs into /api/ingest with the
 * same schema. Both sources land in one table, de-duplicated on sampleId, so
 * they compose instead of competing.
 *
 * Site-specific values come from wrangler.toml [vars] and src/site.config.js;
 * see docs/CONFIGURATION.md. The full endpoint list is in docs/ARCHITECTURE.md.
 *
 * Endpoints (main ones)
 *   GET  /api/latest              most recent reading
 *   GET  /api/history?hours=24    time series (also ?date=YYYY-MM-DD)
 *   GET  /api/daily?days=7        per-day rollups, gap-aware
 *   POST /api/ingest              accepts readings from the LAN agent
 *   GET  /api/health              config + freshness check
 */

import MONITOR_HTML from "./monitor.html";
import CONTROL_HTML from "./control.html";
import EMBED_HTML from "./embed.html";
import MOCKUPS_HTML from "./mockups.html";
import SITE from "./site.config.js";

/*
 * Region endpoints. The per-region signing secret is NOT here - it lives in a
 * Worker secret named below and is resolved at call time by region().
 *
 * These are vendor app-level constants, not anyone's personal credentials (the
 * account login is PECRON_EMAIL / PECRON_PASSWORD). They are kept out of the
 * source anyway, so this repository never carries a value somebody might later
 * want to rotate or restrict. docs/SETUP.md explains where to find them.
 */
const REGIONS = {
  CN: {
    baseUrl: "https://iot-api.quectelcn.com",
    userDomain: "C.DM.5903.1",
    secretVar: "PECRON_SECRET_CN",
  },
  EU: {
    baseUrl: "https://iot-api.acceleronix.io",
    userDomain: "C.DM.10351.1",
    secretVar: "PECRON_SECRET_EU",
  },
  US: {
    baseUrl: "https://iot-api.landecia.com",
    userDomain: "U.DM.10351.1",
    secretVar: "PECRON_SECRET_US",
  },
};

const APP_ID = "633";
const APP_VERSION = "1.9.0";
const APP_SYSTEM_TYPE = "android";

/*
 * Site configuration.
 *
 * Everything that differs between installations is read from env (the [vars]
 * block in wrangler.toml) and from site.config.js by applyConfig(), which runs
 * at the start of every request and every cron tick. Those values are identical
 * for every request served by one deployment, so holding them in module-level
 * variables is safe. The defaults below only apply when a var is missing.
 */
const DEFAULT_ACCENT = "#2E7D5B";
let SITE_NAME = "My Solar Battery";
let DEVICE_NAME = "Pecron power station";
let CAPACITY_WH = 3072;                // F3000LFP nameplate
let PANEL_WATTS = 400;                 // array nameplate, for peak-sun-hours
let GRID_RATE_USD_PER_KWH = 0.30;      // placeholder - set your own
let GRID_RATE_VERIFIED = false;
let LAST_GRID_CHARGE = "";             // optional ISO date-time
let SITE_TZ = "UTC";
let WINDOW_OPENS_MIN = 8 * 60 + 45;    // when the panel starts producing
let WINDOW_CLOSES_MIN = 16 * 60;       // when daytime suppression of depletion alerts ends
let EMBED_ACCENT = DEFAULT_ACCENT;
let PEVS = [];
let WH_PER_MILE = null;
let COMMUTE_MILES = null;
let CHARGE_EFFICIENCY = 0.85;
let RATED_CYCLES = 3500;               // LiFePO4 typical rated life
let PSH_NORM = null;                   // optional regional peak-sun-hours norm
let CO2_KG_PER_KWH = null;             // optional grid emissions factor (mockups page)

const numVar = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** "08:45" -> 525. Falls back to `d` on anything that is not a valid HH:MM. */
function hhmmToMin(v, d) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "").trim());
  if (!m) return d;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : d;
}
const minToHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function applyConfig(env) {
  SITE_NAME = String(env.SITE_NAME || "My Solar Battery").trim();
  DEVICE_NAME = String(env.DEVICE_NAME || "Pecron power station").trim();
  CAPACITY_WH = numVar(env.BATTERY_CAPACITY_WH, 3072);
  PANEL_WATTS = numVar(env.PANEL_WATTS, 400);
  GRID_RATE_USD_PER_KWH = numVar(env.GRID_RATE_USD_PER_KWH, 0.30);
  GRID_RATE_VERIFIED = String(env.GRID_RATE_VERIFIED || "").trim().toLowerCase() === "true";
  LAST_GRID_CHARGE = String(env.LAST_GRID_CHARGE || "").trim();
  WINDOW_OPENS_MIN = hhmmToMin(env.SOLAR_WINDOW_OPENS, 8 * 60 + 45);
  WINDOW_CLOSES_MIN = hhmmToMin(env.SOLAR_WINDOW_CLOSES, 16 * 60);

  // An invalid zone name would make every timestamp throw, so it is checked
  // once and ignored (with a log line) rather than taking the Worker down.
  const tz = String(env.SITE_TIMEZONE || "UTC").trim();
  if (tz !== SITE_TZ) {
    try {
      SITE_PARTS = makeSiteParts(tz);
      SITE_TZ = tz;
    } catch {
      console.log(`[config] SITE_TIMEZONE '${tz}' is not a valid IANA zone - using ${SITE_TZ}`);
    }
  }

  const accent = String(env.EMBED_ACCENT || "").trim().replace(/^#/, "");
  EMBED_ACCENT = /^[0-9a-fA-F]{6}$/.test(accent) ? "#" + accent : DEFAULT_ACCENT;

  // Vehicles that charge from this system. [0] drives the headline
  // commute-equivalence figures. Returned in /api/summary so the pages render
  // from data, not hardcoded HTML.
  PEVS = Array.isArray(SITE?.pevs) ? SITE.pevs : [];
  WH_PER_MILE = numVar(PEVS[0]?.whPerMile, null);
  COMMUTE_MILES = numVar(PEVS[0]?.commuteMiles, null);
  CHARGE_EFFICIENCY = numVar(SITE?.chargeEfficiency, 0.85);
  RATED_CYCLES = numVar(SITE?.ratedCycles, 3500);
  PSH_NORM = numVar(SITE?.peakSunHoursNorm, null);
  CO2_KG_PER_KWH = numVar(SITE?.gridCo2KgPerKwh, null);
}

/*
 * Page placeholders. The HTML files carry tokens like __SITE_NAME__ which are
 * filled in here when a page is served, so the pages need no build step and no
 * extra request to know what to call themselves.
 */
const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PAGE_VAR_RE =
  /__(SITE_NAME|DEVICE_NAME|CAPACITY_WH_FMT|CAPACITY_WH|CAPACITY_KWH|PANEL_WATTS|SOLAR_WINDOW_OPENS|EMBED_ACCENT|PSH_NORM|CO2_KG_PER_KWH)__/g;

function fillPage(html) {
  const vars = {
    SITE_NAME: escHtml(SITE_NAME),
    DEVICE_NAME: escHtml(DEVICE_NAME),
    CAPACITY_WH: String(CAPACITY_WH),
    CAPACITY_WH_FMT: CAPACITY_WH.toLocaleString("en-US"),
    CAPACITY_KWH: (CAPACITY_WH / 1000).toFixed(1),
    PANEL_WATTS: String(PANEL_WATTS),
    SOLAR_WINDOW_OPENS: minToHhmm(WINDOW_OPENS_MIN),
    EMBED_ACCENT,
    PSH_NORM: PSH_NORM === null ? "" : String(PSH_NORM),
    CO2_KG_PER_KWH: CO2_KG_PER_KWH === null ? "" : String(CO2_KG_PER_KWH),
  };
  return html.replace(PAGE_VAR_RE, (_, k) => vars[k]);
}

function page(html, cacheControl) {
  return new Response(fillPage(html), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cacheControl },
  });
}

// ---------------------------------------------------------------- crypto ----

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(str) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)));
}

/**
 * MD5 of a UTF-8 string.
 *
 * MD5 is not part of the WebCrypto standard. The Workers runtime does expose it
 * through crypto.subtle.digest, but that is a platform extension rather than a
 * guarantee, and login is the one call the whole Worker depends on. Try the
 * native path, fall back to the local implementation below. The fallback is
 * checked against RFC 1321 vectors plus the 55/56/64-byte block boundaries.
 */
async function md5Hex(str) {
  const bytes = new TextEncoder().encode(str);
  try {
    return hex(await crypto.subtle.digest("MD5", bytes));
  } catch {
    return hex(md5Bytes(bytes));
  }
}

function md5Bytes(input) {
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const ml = input.length;
  const buf = new Uint8Array((((ml + 8) >> 6) + 1) * 64);
  buf.set(input);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = ml * 8;
  dv.setUint32(buf.length - 8, bits >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(bits / 4294967296), true);

  const M = new Uint32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const o = new DataView(out.buffer);
  o.setUint32(0, a0, true); o.setUint32(4, b0, true);
  o.setUint32(8, c0, true); o.setUint32(12, d0, true);
  return out;
}

function randomString(n = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

/**
 * Mirror of the Android app's login crypto.
 *   key = MD5(random).upper()[8:24]
 *   iv  = key[8:16] + key[0:8]      (the halves swapped)
 * AES-CBC in WebCrypto applies PKCS#7 padding already, which is what the
 * app's "PKCS5" actually is for a 16-byte block.
 */
async function encryptPassword(password, random) {
  const md5 = (await md5Hex(random)).toUpperCase();
  const keyStr = md5.slice(8, 24);
  const ivStr = keyStr.slice(8, 16) + keyStr.slice(0, 8);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(keyStr), "AES-CBC", false, ["encrypt"]);
  const out = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: enc.encode(ivStr) },
    key,
    enc.encode(password)
  );
  return btoa(String.fromCharCode(...new Uint8Array(out)));
}

// ------------------------------------------------------------- transport ----

function region(env) {
  const r = (env.PECRON_REGION || "US").toUpperCase();
  if (!REGIONS[r]) throw new Error(`unknown PECRON_REGION: ${r}`);
  const def = REGIONS[r];
  // Trimmed for the same reason as the email and password below: a secret set
  // through a shell pipeline usually arrives with a trailing newline, which
  // would silently corrupt the signature hash rather than fail cleanly.
  const secret = (env[def.secretVar] || "").trim();
  // Fail LOUDLY and specifically. An unset signing secret otherwise surfaces as
  // a failed login, which looks exactly like bad credentials or a vendor
  // outage, and a quiet stall in sampling is easy to misdiagnose.
  if (!secret) {
    throw new Error(
      `${def.secretVar} is not set on this Worker - run: wrangler secret put ${def.secretVar}`
    );
  }
  return { ...def, secret };
}

function baseHeaders(token) {
  const h = {
    "X-Q-Language": "en",
    "quec-random-url": crypto.randomUUID(),
    "app-info": "[Solar][Worker][pecron-solar-dashboard][1]",
    appId: APP_ID,
    appVersion: APP_VERSION,
    appSystemType: APP_SYSTEM_TYPE,
  };
  if (token) h["Authorization"] = token;
  return h;
}

async function callApi(env, token, method, path, { params, form, jsonBody } = {}) {
  const { baseUrl } = region(env);
  const url = new URL(baseUrl + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const init = { method, headers: baseHeaders(token) };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  // Login is form-encoded; device control is JSON. The API accepts both.
  if (jsonBody) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(jsonBody);
  }

  const resp = await fetch(url.toString(), init);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${path}`);
  const body = await resp.json();
  if (body.code !== 200) {
    const err = new Error(body.msg || `API code ${body.code}`);
    err.apiCode = body.code;
    throw err;
  }
  return body.data;
}

async function login(env) {
  const { userDomain, secret } = region(env);
  // `wrangler secret put` is usually fed from a shell pipeline, and most shells
  // append a newline. The API rejects "user@host\n" as a malformed address, and
  // the stray byte would also corrupt the signature hash - a failure that reads
  // like bad credentials. Strip line endings from both; trim the email fully,
  // since no address legitimately carries surrounding whitespace.
  const email = (env.PECRON_EMAIL || "").trim();
  const password = (env.PECRON_PASSWORD || "").replace(/[\r\n]+$/, "");
  if (!email || !password) throw new Error("PECRON_EMAIL / PECRON_PASSWORD secrets are not set");

  const random = randomString(16);
  const pwd = await encryptPassword(password, random);
  const signature = await sha256Hex(email + pwd + random + secret);

  const data = await callApi(env, null, "POST", "/v2/enduser/enduserapi/emailPwdLogin", {
    form: { email, pwd, random, userDomain, signature },
  });
  return {
    token: data.accessToken.token,
    expiresAt: data.accessToken.expirationTime || null,
  };
}

/** Cached token, so a 5-minute cron does not log in 288 times a day. */
async function getToken(env, force = false) {
  if (!force) {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k='access_token'").first();
    const expRow = await env.DB.prepare("SELECT v FROM meta WHERE k='token_expires'").first();
    if (row?.v) {
      const exp = expRow?.v ? Number(expRow.v) : 0;
      if (!exp || Date.now() < exp - 60_000) return row.v;
    }
  }
  const { token, expiresAt } = await login(env);
  // expirationTime is not a date string. Passing it to Date.parse() stores
  // "NaN", after which the cached token never expires and every real expiry
  // costs a failed call before pollOnce's retry logs in again. Accept a number
  // in seconds or milliseconds, or a date string; treat the token as good for
  // 12 h when none of those parse.
  const n = Number(expiresAt);
  let expMs = Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) expMs = Date.now() + 12 * 3600_000;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('access_token',?)").bind(token),
    env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('token_expires',?)").bind(String(expMs)),
  ]);
  return token;
}

/*
 * PECRON_PK / PECRON_DK are optional. Set them and the Worker skips a
 * device-list call on every poll. Leave them empty and it uses the first device
 * bound to the account, logging the keys it found so they can be copied into
 * wrangler.toml (visible with `npx wrangler tail`).
 */
async function resolveDevice(env, token) {
  const pk = String(env.PECRON_PK || "").trim();
  const dk = String(env.PECRON_DK || "").trim();
  if (pk && dk) return { pk, dk };
  const data = await callApi(env, token, "GET", "/v2/binding/enduserapi/userDeviceList");
  const list = Array.isArray(data) ? data : data?.list || [];
  if (!list.length) throw new Error("no devices bound to this account");
  const d = list[0];
  const found = { pk: d.productKey || d.pk, dk: d.deviceKey || d.dk };
  console.log(
    `[device] PECRON_PK/PECRON_DK not set - using the first of ${list.length} bound device(s): ` +
    `PECRON_PK="${found.pk}" PECRON_DK="${found.dk}"`
  );
  return found;
}

// --------------------------------------------------------------- parsing ----

/**
 * customizeTslInfo is a flat list of {resourceCode, resourceValce, dataType}.
 * `resourceValce` is misspelled in the API itself - keep the typo, and accept
 * the correct spelling too in case it is ever fixed. Every value arrives as a
 * string; STRUCT values are JSON encoded inside that string.
 */
function tslToObject(tslInfo) {
  const out = {};
  for (const item of tslInfo || []) {
    const code = item.resourceCode;
    if (!code) continue;
    const raw = item.resourceValce ?? item.resourceValue;
    if (raw === undefined || raw === null || raw === "") continue;
    if ((item.dataType || "").toUpperCase() === "STRUCT") {
      try {
        out[code] = JSON.parse(raw);
      } catch {
        /* leave the field out rather than store a broken struct */
      }
    } else {
      out[code] = raw;
    }
  }
  return out;
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
// Voltage keeps 3 dp: the BMS reports a real float, and it is one of only two
// fields with sub-integer resolution. Everything the device *reports* - charge,
// watts, temperature - is a whole number, so V and A are where precision lives.
const round3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
const bool = (v) => (v === undefined || v === null ? null : String(v).toLowerCase() === "true");

/**
 * Timestamps are stored in site-local time (SITE_TIMEZONE) with that zone's
 * offset, so the strings sort chronologically and `captured_date` is the
 * site's own day. Every comparison against `captured_at` must therefore be
 * built with this same function - comparing a UTC ISO string against these
 * would compare "14:32...-08:00" with "22:32...Z" as text and silently match
 * nothing.
 *
 * The offset is computed per timestamp so it follows daylight-saving changes.
 * A fixed offset looks right for half the year and then files every reading an
 * hour off, rolls the day over at the wrong time, and disagrees with the LAN
 * agent (which stamps with its machine's real local time). The one cost:
 * during the repeated hour when clocks go back, the strings do not sort by
 * instant. integrate() already skips a backwards step.
 */
function makeSiteParts(tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
let SITE_PARTS = makeSiteParts("UTC");
function siteIso(ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(SITE_PARTS.formatToParts(new Date(whole)).map((x) => [x.type, x.value]));
  const local = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  const offMin = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - whole) / 60000);
  const abs = Math.abs(offMin);
  return `${local}${offMin < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function siteNow() {
  const capturedAt = siteIso(Date.now());
  return { capturedAt, capturedDate: capturedAt.slice(0, 10) };
}

function toSample(props, source) {
  const { capturedAt, capturedDate } = siteNow();
  const host = props.host_packet_data_jdb || {};
  return {
    sampleId: crypto.randomUUID(),
    capturedAt,
    capturedDate,
    reportType: "sample",
    // The cloud transport returns STRUCT members as strings where the LAN
    // transport returns real numbers. Coerce every numeric field so the two
    // sources are directly comparable and API consumers never have to guess at
    // a field's type. SQLite's affinity would mask this on write, but the JSON
    // served from /api/latest would not.
    soc: num(props.battery_percentage) ?? num(host.host_packet_electric_percentage),
    voltage: round3(num(host.host_packet_voltage)),
    currentAmps: round2(num(host.host_packet_current)),
    temperatureC: num(host.host_packet_temp),
    solarW: num(props.dc_data_input_hm?.dc_input_power) ?? 0,
    acOutW: num(props.ac_data_output_hm?.ac_output_power) ?? 0,
    dcOutW: num(props.dc_data_output_hm?.dc_output_power) ?? 0,
    acInW: num(props.ac_data_input_hm?.ac_input_power) ?? 0,
    totalInW: num(props.total_input_power),
    totalOutW: num(props.total_output_power),
    minutesRemaining: num(props.remain_time),
    acSwitch: bool(props.ac_switch_hm),
    dcSwitch: bool(props.dc_switch_hm),
    ups: bool(props.ups_status_hm),
    eco: bool(props.eco_onoff_us),
    // Raw enum values; decoded for display, never in storage. deviceStatus says
    // directly when the unit drops to Standby, rather than leaving it to be
    // inferred from telemetry going quiet.
    deviceStatus: num(props.device_status_hm),
    faultCode: num(props.FAULT_ALARM_ENUM),
    source,
  };
}

// --------------------------------------------------------------- storage ----

async function insertSample(env, s) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO samples
       (sample_id, captured_at, captured_date, report_type, soc, voltage, current_amps,
        temperature_c, solar_w, ac_out_w, dc_out_w, ac_in_w, total_in_w, total_out_w,
        minutes_remaining, ac_switch, dc_switch, ups, eco, device_status, fault_code, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      s.sampleId, s.capturedAt, s.capturedDate, s.reportType || "sample",
      s.soc, s.voltage, s.currentAmps, s.temperatureC,
      s.solarW, s.acOutW, s.dcOutW, s.acInW, s.totalInW, s.totalOutW,
      s.minutesRemaining,
      s.acSwitch === null ? null : s.acSwitch ? 1 : 0,
      s.dcSwitch === null ? null : s.dcSwitch ? 1 : 0,
      s.ups === null ? null : s.ups ? 1 : 0,
      s.eco === null ? null : s.eco ? 1 : 0,
      s.deviceStatus ?? null,
      s.faultCode ?? null,
      s.source
    )
    .run();
}

/*
 * A reading the cloud merely repeats is not a reading.
 *
 * getDeviceBusinessAttributes answers with the device's last reported
 * properties, and it keeps answering with them - device_status "charging"
 * included - long after the unit has stopped reporting (for example when its
 * Wi-Fi drops). Stamped with the poll time and stored, that frozen snapshot
 * looks like fresh data: integrate() sees the last daytime solar figure held
 * all night and invents kilowatt-hours that never existed, and the stale alert
 * never fires because rows keep landing on time.
 *
 * The tell is the voltage. The BMS reports it to the millivolt and a live pack
 * rarely holds it for long. In healthy cloud data a full reading repeats at
 * most about 3 polls in a row while the panel is producing, and about 6 on a
 * still night. The cloud itself refreshes roughly every 10 minutes, so ONE
 * repeat is the normal cadence and must be allowed. So: a new reading equal to
 * the last 3 stored cloud readings while solar is non-zero, or to the last 6
 * otherwise, is the snapshot, not the pack, and is not stored. The gap that opens is what the
 * charts, the rollups and the stale alert already know how to handle; `meta`
 * remembers since when and how often the cloud has been repeating so
 * /api/health and the alert can say so instead of "no reading".
 */
const REPEAT_FIELDS = {
  soc: "soc", voltage: "voltage", current_amps: "currentAmps", temperature_c: "temperatureC",
  solar_w: "solarW", ac_out_w: "acOutW", dc_out_w: "dcOutW", ac_in_w: "acInW",
  minutes_remaining: "minutesRemaining",
};

async function cloudIsRepeating(env, sample) {
  const limit = (sample.solarW || 0) > 0 ? 3 : 6;
  const cols = Object.keys(REPEAT_FIELDS);
  const { results } = await env.DB.prepare(
    `SELECT ${cols.join(", ")} FROM samples WHERE source='cloud' ORDER BY captured_at DESC LIMIT ?`
  ).bind(limit).all();
  const same = (row) => cols.every((c) => (row[c] ?? null) === (sample[REPEAT_FIELDS[c]] ?? null));
  const repeating = results.length === limit && results.every(same);
  if (!repeating) {
    await env.DB.prepare("DELETE FROM meta WHERE k IN ('cloud_frozen_since','cloud_frozen_repeats')").run();
    return false;
  }
  const since = (await env.DB.prepare("SELECT v FROM meta WHERE k='cloud_frozen_since'").first())?.v || sample.capturedAt;
  const n = Number((await env.DB.prepare("SELECT v FROM meta WHERE k='cloud_frozen_repeats'").first())?.v || 0) + 1;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('cloud_frozen_since',?)").bind(since),
    env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('cloud_frozen_repeats',?)").bind(String(n)),
  ]);
  console.log(`[poll] cloud is repeating the same reading (${n}x since ${since}) - not stored`);
  return true;
}

async function pollOnce(env) {
  let token = await getToken(env);
  let device;
  let attrs;
  try {
    device = await resolveDevice(env, token);
    attrs = await callApi(env, token, "GET", "/v2/binding/enduserapi/getDeviceBusinessAttributes", {
      params: { pk: device.pk, dk: device.dk },
    });
  } catch (err) {
    // An expired token surfaces as a non-200 API code, not a 401. Retry once
    // with a fresh login before giving up on the cycle.
    token = await getToken(env, true);
    device = await resolveDevice(env, token);
    attrs = await callApi(env, token, "GET", "/v2/binding/enduserapi/getDeviceBusinessAttributes", {
      params: { pk: device.pk, dk: device.dk },
    });
  }

  const props = tslToObject(attrs?.customizeTslInfo);
  if (!Object.keys(props).length) throw new Error("device returned no properties (likely offline)");

  const sample = toSample(props, "cloud");
  if (await cloudIsRepeating(env, sample)) {
    await env.DB.prepare("DELETE FROM meta WHERE k='last_error'").run();
    return { ...sample, frozen: true };
  }
  await insertSample(env, sample);
  // Clear any previous failure. A sticky last_error outlives the problem it
  // describes and makes a healthy service look broken on the status page.
  await env.DB.prepare("DELETE FROM meta WHERE k='last_error'").run();
  return sample;
}

// --------------------------------------------------------------- rollups ----

/**
 * Trapezoid-integrate watts into watt-hours, skipping intervals longer than
 * `maxGapMin`. Without that guard, a hole in the data - the unit offline and
 * nothing reporting - would be integrated as if the last reading before it held
 * for the whole gap, inventing kilowatt-hours that never existed.
 */
function integrate(rows, key, maxGapMin = 20) {
  let wh = 0;
  let largestGapMin = 0;
  for (let i = 1; i < rows.length; i++) {
    const t0 = Date.parse(rows[i - 1].captured_at);
    const t1 = Date.parse(rows[i].captured_at);
    const mins = (t1 - t0) / 60000;
    if (mins <= 0) continue;
    if (mins > maxGapMin) {
      largestGapMin = Math.max(largestGapMin, mins);
      continue;
    }
    wh += (((rows[i - 1][key] || 0) + (rows[i][key] || 0)) / 2) * (mins / 60);
  }
  return { wh: Math.round(wh), largestGapMin: Math.round(largestGapMin) };
}

function dailyRollup(date, rows) {
  if (!rows.length) return { date, sampleCount: 0 };
  const solar = integrate(rows, "solar_w");
  // Both rails, not just AC. With loads on the DC side an AC-only figure
  // reports almost no consumption while the pack visibly drains.
  const acLoad = integrate(rows, "ac_out_w");
  const dcLoad = integrate(rows, "dc_out_w");
  const consumed = acLoad.wh + dcLoad.wh;
  const socs = rows.map((r) => r.soc).filter((v) => v !== null && v !== undefined);
  const socOpen = socs[0] ?? null;
  const socClose = socs.at(-1) ?? null;

  /*
   * System overhead, derived rather than metered.
   *
   * The meters report what is *delivered* to a load. Inverter idle, conversion
   * loss and self-consumption are never delivered anywhere, so they are
   * invisible to both rails - yet on a small system they can dominate the
   * energy budget, often exceeding the actual load overnight.
   *
   * They do show up as the gap between what the energy balance predicts and
   * what the pack actually did:
   *
   *     overhead = harvest - delivered - change_in_stored_energy
   *
   * Precision is limited by 1% state-of-charge resolution (1% of the pack, about
   * 31 Wh on a 3,072 Wh unit), so read this as a daily figure and not a spot
   * measurement.
   */
  const storedDeltaWh =
    socOpen !== null && socClose !== null ? ((socClose - socOpen) / 100) * CAPACITY_WH : null;
  const overheadWh =
    storedDeltaWh === null ? null : Math.round(solar.wh - consumed - storedDeltaWh);

  /*
   * Second estimate of the same quantity, by coulomb counting.
   *
   * State of charge moves in whole percent - 1% of the pack per step - which is
   * too coarse to tell 12 W of standby from 18 W. Pack voltage and current are real floats,
   * so integrating V x A gives far finer resolution between SoC steps.
   *
   * Both are reported rather than one replacing the other: integrated current
   * accumulates the BMS's own offset error over hours, while SoC stays honest
   * about the long run. Divergence between them is itself diagnostic.
   */
  const coulomb = integrate(
    rows.map((r) => ({ ...r, _pw: (r.voltage ?? 0) * (r.current_amps ?? 0) })),
    "_pw"
  );

  return {
    date,
    harvestWattHours: solar.wh,
    consumedWattHours: consumed,
    consumedAcWattHours: acLoad.wh,
    consumedDcWattHours: dcLoad.wh,
    storedDeltaWattHours: storedDeltaWh === null ? null : Math.round(storedDeltaWh),
    storedDeltaCoulombWattHours: coulomb.wh,
    overheadWattHours: overheadWh,
    overheadCoulombWattHours: Math.round(solar.wh - consumed - coulomb.wh),
    netWattHours: solar.wh - consumed,
    peakSolarWatts: Math.max(...rows.map((r) => r.solar_w || 0)),
    socOpen,
    socClose,
    socMin: socs.length ? Math.min(...socs) : null,
    socMax: socs.length ? Math.max(...socs) : null,
    firstSampleAt: rows[0].captured_at,
    lastSampleAt: rows.at(-1).captured_at,
    sampleCount: rows.length,
    largestGapMinutes: Math.max(solar.largestGapMin, acLoad.largestGapMin, dcLoad.largestGapMin),
  };
}

// ------------------------------------------------------------------ HTTP ----

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};

/**
 * cacheSeconds matters more than it looks. These endpoints are public and a
 * popular page embedding the widget can bring real traffic; every uncached hit is D1 rows read. Anything that
 * mutates or reflects auth stays no-store.
 */
const json = (obj, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control":
        cacheSeconds > 0 && status === 200 ? `public, max-age=${cacheSeconds}` : "no-store",
      ...CORS,
    },
  });

/** Constant-time-ish compare so a token cannot be probed byte by byte. */
function tokenMatches(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorized(request, expected) {
  // Fail closed: a missing token refuses exactly like a wrong one. "Unset means
  // open" is convenient in local dev and dangerous in a public deploy, where
  // forgetting one `wrangler secret put` would let anyone write samples.
  if (!expected || !expected.trim()) return false;
  const h = request.headers.get("Authorization") || "";
  return tokenMatches(h.replace(/^Bearer\s+/i, "").trim(), expected.trim());
}

// ---------------------------------------------------------------- alerting --

const setAlertState = (env, v) =>
  env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('alert_state',?)").bind(v).run();

/**
 * POST to ALERT_WEBHOOK, shaped for whichever service the URL points at.
 *
 * ntfy.sh was the first choice - no account, just a topic - but its free tier
 * rate-limits by source IP, and Cloudflare Workers egress from a large shared
 * pool. In practice that means HTTP 429 regardless of how little we send, so a
 * Discord or Slack webhook is the more reliable destination from here.
 *
 * Returns whether delivery succeeded; callers must not latch alert state on a
 * failed send.
 */
function alertBody(url, title, message) {
  if (/discord\.com\/api\/webhooks/i.test(url)) {
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**${title}**\n${message}` }),
    };
  }
  if (/hooks\.slack\.com/i.test(url)) {
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `*${title}*\n${message}` }),
    };
  }
  // ntfy and generic receivers: plain text plus a Title header.
  return {
    headers: { "Content-Type": "text/plain; charset=utf-8", Title: title, Priority: "high" },
    body: message,
  };
}

/*
 * Email sink (Mailgun). Preferred over the webhook because free webhook relays
 * such as ntfy.sh tend to answer Cloudflare Worker egress with HTTP 429, which
 * leaves alerting looking armed while being dead. Send alerts to an inbox that
 * somebody actually reads - that is the entire point.
 *
 * Inert until MAILGUN_API_KEY, MAILGUN_DOMAIN and ALERT_EMAIL all exist. No key,
 * no send, no error: the Worker runs normally until someone arms it.
 */
async function sendEmail(env, subject, text) {
  const key = (env.MAILGUN_API_KEY || "").trim();
  if (!key) return false;
  const domain = (env.MAILGUN_DOMAIN || "").trim();
  const to = (env.ALERT_EMAIL || "").trim();
  if (!domain || !to) {
    console.log("[alert] MAILGUN_DOMAIN or ALERT_EMAIL is not set - email not sent");
    return false;
  }
  // Header-safe display name: no quotes, angle brackets or line breaks.
  const fromName = String(env.ALERT_FROM_NAME || `${SITE_NAME} Solar`).replace(/["<>\r\n]/g, "").trim();
  try {
    const r = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`api:${key}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        from: `${fromName} <alerts@${domain}>`,
        to,
        subject,
        text,
      }),
    });
    if (!r.ok) console.log(`[alert] mailgun returned HTTP ${r.status}`);
    return r.ok;
  } catch (err) {
    console.log(`[alert] mailgun failed: ${err.message}`);
    return false;
  }
}

async function notify(env, title, message) {
  // Email first. Falls through to the webhook so nothing breaks if the key is
  // absent, and so both can run during any changeover.
  const mailed = await sendEmail(env, title, message);
  // Trim: piping a value into `wrangler secret put` appends a newline in most
  // shells, and a URL with a trailing newline fails in ways that look like the
  // webhook is simply not firing.
  const hook = (env.ALERT_WEBHOOK || "").trim();
  if (!hook) return mailed;
  try {
    const shaped = alertBody(hook, title, message);
    const r = await fetch(hook, { method: "POST", headers: shaped.headers, body: shaped.body });
    if (!r.ok) console.log(`[alert] webhook returned HTTP ${r.status}`);
    return mailed || r.ok;
  } catch (err) {
    // An alert that cannot be delivered must not take the poller down with it.
    console.log(`[alert] webhook failed: ${err.message}`);
    return mailed;
  }
}

/**
 * Decide whether telemetry has stopped, and say so once.
 *
 * Two guards do the real work here:
 *
 *   Transition-only. Firing every five minutes for the same outage is how a
 *   useful alert becomes something everybody mutes. State lives in `meta`, and
 *   a notification goes out on the edge in each direction - including recovery,
 *   so a resolved outage visibly resolves.
 *
 *   Latch on delivery. The state only moves once a notification actually went
 *   out, so a failed send retries next cycle instead of being forgotten.
 */
async function evaluateAlert(env) {
  // Either sink counts. Without one, evaluating costs queries and can notify
  // nobody.
  if (!env.ALERT_WEBHOOK && !env.MAILGUN_API_KEY) return;

  const staleMin = Number(env.ALERT_STALE_MINUTES ?? 30);

  /*
   * NO HOURS WINDOW, deliberately. For a battery charged by solar, OVERNIGHT IS
   * THE RISK WINDOW - a pack heading for flat at 02:00 is exactly the event worth
   * catching, and an hours guard would hide precisely that. An hours window is a
   * mitigation for intrusive channels; EMAIL DOES NOT WAKE ANYONE, so
   * suppressing by hour buys nothing and costs coverage. Repeat-suppression is
   * the transition-only latching below, which is the real noise control.
   *
   * If your unit's uplink goes down by design at night (for example a router
   * powered from an output that ECO standby switches off), expect a stale
   * alert each night. The fix is to keep the uplink powered, not to add a
   * window here.
   */

  const last = await env.DB.prepare(
    `SELECT captured_at, soc, fault_code, current_amps, minutes_remaining, solar_w
       FROM samples ORDER BY captured_at DESC LIMIT 1`
  ).first();
  const ageMin = last ? (Date.now() - Date.parse(last.captured_at)) / 60000 : Infinity;

  await evaluateFault(env, last);
  await evaluateDepletion(env, last);
  /*
   * Latch the state ONLY on successful delivery.
   *
   * Setting it first means a failed webhook permanently suppresses the alert -
   * the condition stays true, the state says "already told them", and nothing
   * ever retries. That is worse than having no alerting, because it looks armed.
   * Failing delivery now simply retries on the next cycle.
   */
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='alert_state'").first();
  const state = row?.v || "ok";

  // Same rule as above: latch only once the notification actually went out.
  if (ageMin > staleMin && state === "ok") {
    const frozenSince = (await env.DB.prepare("SELECT v FROM meta WHERE k='cloud_frozen_since'").first())?.v;
    const sent = await notify(
      env,
      `${SITE_NAME}: telemetry stopped`,
      `No reading for ${Number.isFinite(ageMin) ? Math.round(ageMin) + " min" : "any recorded period"}` +
        ` (threshold ${staleMin} min).\nLast sample: ${last?.captured_at ?? "never"}` +
        (frozenSince
          ? `\n\nPecron's cloud is still answering, but with the same reading every poll since ${frozenSince}: ` +
            `the unit has stopped reporting to it. The repeats are not being recorded. ` +
            `Check the unit's Wi-Fi and your router; the Pecron app will show the same frozen numbers.`
          : "")
    );
    if (sent) {
      await setAlertState(env, "alerting");
      console.log(`[alert] stale ${Math.round(ageMin)}min -> notified`);
    }
  } else if (ageMin <= staleMin && state === "alerting") {
    const sent = await notify(env, `${SITE_NAME}: telemetry resumed`,
      `Readings are landing again.\nLast sample: ${last.captured_at}`);
    if (sent) {
      await setAlertState(env, "ok");
      console.log("[alert] recovered -> notified");
    }
  }
}

/* Basic-auth check for the internal pages. Compared with the same constant-time
   helper the control token uses, so the gate cannot be probed by timing. */
function basicAuthOk(request, expected) {
  const h = request.headers.get("Authorization") || "";
  if (!/^Basic\s+/i.test(h)) return false;
  let decoded;
  try {
    decoded = atob(h.replace(/^Basic\s+/i, "").trim());
  } catch {
    return false;                       // malformed base64 is simply a failure
  }
  const given = decoded.slice(decoded.indexOf(":") + 1);   // username ignored
  return tokenMatches(given, expected);
}

/* Fault names, so an alert says "Battery overvoltage" rather than "code 2" at
   2am. Mirrors the table in monitor.html - if one changes, change both. */
const FAULTS = {
  1: "Battery over-temperature", 2: "Battery overvoltage", 3: "Battery undervoltage",
  4: "Battery short circuit", 5: "Charge overcurrent", 6: "Discharge overcurrent",
  7: "Charger input overvoltage", 8: "Charger input overcurrent",
  9: "Charger output overvoltage", 10: "Charger output overcurrent",
  11: "Charger output short circuit", 12: "Charger input undervoltage",
  13: "Charger overheating", 14: "DC output short circuit", 15: "DC output overvoltage",
  16: "DC output overcurrent", 17: "DC output over-temperature",
};

/* Latch helper. Same rule as everywhere else in this file: the state moves ONLY
   after a notification actually goes out. Latching first means one failed send
   permanently suppresses the alert while the condition stays true - worse than
   no alerting, because it looks armed. */
async function latch(env, key, value, title, body) {
  const sent = await notify(env, title, body);
  if (sent) {
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)").bind(key, value).run();
    console.log(`[alert] ${key} -> ${value}`);
  }
  return sent;
}

async function stateOf(env, key) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(key).first();
  return r?.v || "ok";
}

/* Device faults. Seventeen codes - over-temperature, over/undervoltage, short
   circuit, charge and discharge overcurrent and so on. Rare, unambiguous, and
   always worth knowing about. */
async function evaluateFault(env, last) {
  if (!last) return;
  const state = await stateOf(env, "alert_fault_state");
  const code = last.fault_code;
  if (code !== null && code !== undefined && state === "ok") {
    await latch(env, "alert_fault_state", "faulted", `${SITE_NAME}: DEVICE FAULT`,
      `Pecron reports fault code ${code} — ${FAULTS[code] || "unrecognized code"}.\n` +
      `Reading at ${last.captured_at}, pack ${last.soc}%.\n\n` +
      `Faults are rare and usually mean the unit has protected itself. Check it in person.`);
  } else if ((code === null || code === undefined) && state === "faulted") {
    await latch(env, "alert_fault_state", "ok", `${SITE_NAME}: fault cleared`,
      `The Pecron is no longer reporting a fault.\nReading at ${last.captured_at}, pack ${last.soc}%.`);
  }
}

/*
 * Will the pack reach the next generation window?
 *
 * Deliberately NOT a fixed state-of-charge floor. A 30% floor is noise at 15:00
 * with sun on the panel and already too late at 04:00 with hours of dark left -
 * wrong in both directions, because charge alone says nothing about whether the
 * loads make it to morning.
 *
 * What matters is runtime against the next generation window. That is
 * SOLAR_WINDOW_OPENS - when the panel actually starts producing, which can be
 * well after dawn if trees or buildings shade it - not sunrise. The margin
 * covers the fact that early generation is weak.
 *
 * Only evaluated while DISCHARGING: minutes_remaining means something quite
 * different when the pack is charging, and a sunny afternoon would otherwise
 * trip it constantly.
 */
const DEPLETION_MARGIN_MIN = 90;

function minutesUntilWindow(nowMs) {
  const iso = siteIso(nowMs);
  const nowMin = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return nowMin < WINDOW_OPENS_MIN
    ? WINDOW_OPENS_MIN - nowMin
    : 24 * 60 - nowMin + WINDOW_OPENS_MIN;
}

async function evaluateDepletion(env, last) {
  if (!last) return;

  // Skip during panel hours. Transient daytime loads (charging a PEV) cause
  // brief high discharge rates that project to false "will not reach sunrise"
  // alerts - the firmware's minutes_remaining reflects the current draw, not
  // the draw after the charger finishes. The question only matters after the
  // panel stops producing. Recovery can always fire so a stale "short" clears.
  // "Daytime" runs from the top of the hour SOLAR_WINDOW_OPENS falls in until
  // SOLAR_WINDOW_CLOSES.
  const iso = siteIso(Date.now());
  const nowMin = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  const daytime = nowMin >= Math.floor(WINDOW_OPENS_MIN / 60) * 60 && nowMin < WINDOW_CLOSES_MIN;

  const state = await stateOf(env, "alert_depletion_state");
  const discharging = Number(last.current_amps ?? 0) < 0;
  const runway = Number(last.minutes_remaining ?? 0);
  const needed = minutesUntilWindow(Date.now()) + DEPLETION_MARGIN_MIN;
  const short = discharging && runway > 0 && runway < needed;

  if (short && state === "ok" && !daytime) {
    const h = (m) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
    await latch(env, "alert_depletion_state", "short", `${SITE_NAME}: WILL NOT REACH SUNRISE`,
      `Pack ${last.soc}% with about ${h(runway)} of runtime left.\n` +
      `The panel does not start producing until ~${minToHhmm(WINDOW_OPENS_MIN)}, which is ${h(needed - DEPLETION_MARGIN_MIN)} away ` +
      `(plus a ${DEPLETION_MARGIN_MIN} min margin because early generation is weak).\n\n` +
      `If nothing needs AC overnight, switching AC output off at /control removes the inverter's idle draw, ` +
      `which is often enough to close the gap.\n` +
      `Reading at ${last.captured_at}.`);
  } else if (!short && state === "short") {
    // Recovers when charging resumes or the runway clears the requirement.
    await latch(env, "alert_depletion_state", "ok", `${SITE_NAME}: sunrise within reach`,
      `Pack ${last.soc}%, ${discharging ? "still discharging but with enough runway" : "charging"}.\n` +
      `Reading at ${last.captured_at}.`);
  }
}

// ----------------------------------------------------------------- control --

/*
 * What may be written, and what may never be.
 *
 * dc_switch_hm is ABSENT ON PURPOSE and must stay that way.
 *
 * A common setup powers the router, modem or other critical network gear from
 * the station's DC output. Switching that output off remotely kills the
 * router, which kills the internet connection, which kills this Worker's only
 * route to the device AND any way of switching it back on. Recovery means
 * physically going to the unit.
 *
 * Nothing in Pecron's documentation hints at this - it depends on how each
 * installation is wired - so anyone reading the device's list of writable
 * properties will reasonably assume DC belongs here next to AC. It does not.
 * The refusal lives in the Worker rather than the UI so that a hand-rolled curl
 * cannot do it either.
 */
const CONTROL_ALLOWLIST = {
  ac_switch_hm: (v) => typeof v === "boolean",
  eco_onoff_us: (v) => typeof v === "boolean",
  ac_charging_power_ios: (v) => Number.isInteger(v) && v >= 0 && v <= 10,
};

const CONTROL_DENYLIST = {
  dc_switch_hm:
    "Refused: DC output is never switched remotely. If a router or other " +
    "critical gear runs off it, switching it off would sever internet, " +
    "telemetry and any remote route back in. Do this at the unit if it is " +
    "genuinely needed.",
};

async function logControl(env, code, value, result, detail) {
  try {
    await env.DB.prepare(
      "INSERT INTO control_log (at, code, value, result, detail) VALUES (?,?,?,?,?)"
    )
      .bind(siteIso(Date.now()), String(code), JSON.stringify(value ?? null), result, detail ?? null)
      .run();
  } catch (err) {
    console.log(`[control] could not write audit row: ${err.message}`);
  }
}

/** Push one property to the device via Pecron's cloud. */
async function sendControl(env, code, value) {
  let token = await getToken(env);
  let device = await resolveDevice(env, token);
  const payload = {
    data: JSON.stringify([{ [code]: value }]),
    deviceList: [{ productKey: device.pk, deviceKey: device.dk }],
    type: 2, // property write
  };
  try {
    return await callApi(env, token, "POST", "/v2/binding/enduserapi/batchControlDevice", {
      jsonBody: payload,
    });
  } catch (err) {
    // Same expired-token dance as pollOnce: a stale token surfaces as an API
    // code, not a 401, so retry once with a fresh login before giving up.
    token = await getToken(env, true);
    device = await resolveDevice(env, token);
    return callApi(env, token, "POST", "/v2/binding/enduserapi/batchControlDevice", {
      jsonBody: payload,
    });
  }
}

function controlAuthorized(request, env) {
  const expected = env.CONTROL_TOKEN;
  // Fail CLOSED. authorized() treats an unset token as "open", which is
  // reasonable for reads and unacceptable here - a missing secret must never
  // mean the outputs are switchable by anyone who finds the URL.
  if (!expected) return false;
  // Trim both sides. Piping a value into `wrangler secret put` appends a
  // newline in most shells, and the stored secret then never matches a
  // correctly-sent header - a failure that reads exactly like a wrong token.
  // No legitimate token carries surrounding whitespace.
  const given = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return tokenMatches(given, expected.trim());
}

export default {
  async scheduled(event, env, ctx) {
    applyConfig(env);
    ctx.waitUntil(
      (async () => {
        try {
          const s = await pollOnce(env);
          if (!s.frozen) console.log(`[poll] soc=${s.soc}% solar=${s.solarW}W acOut=${s.acOutW}W`);
        } catch (err) {
          // Expected whenever the unit is offline to Pecron's cloud (Wi-Fi or
          // router down, unit switched off). Log, do not throw.
          console.log(`[poll] skipped: ${err.message}`);
          await env.DB.prepare("INSERT OR REPLACE INTO meta (k,v) VALUES ('last_error',?)")
            .bind(`${new Date().toISOString()} ${err.message}`)
            .run();
        }
        // Runs whether or not the poll succeeded - a failed poll is exactly the
        // case that needs evaluating.
        await evaluateAlert(env);
      })()
    );
  },

  async fetch(request, env) {
    applyConfig(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Pages are served from here so their fetches are same-origin.
    // The public embed is meant to be framed by other sites, so it must NOT
    // carry the usual X-Frame-Options/frame-ancestors lockdown.
    if (path === "/embed") {
      return page(EMBED_HTML, "public, max-age=300");
    }
    /*
     * Gate for the internal pages. HTTP Basic, because these are pages opened
     * from an address bar or a phone bookmark - a bearer header cannot be sent
     * that way, and Basic gets a native browser prompt with no login page to
     * build or maintain. Any username; the password is MONITOR_TOKEN.
     *
     * ARMING MODEL, and it is the opposite of the control endpoint's on purpose:
     *
     *   MONITOR_TOKEN absent, MONITOR_GATE absent  -> OPEN. The default, so a
     *     fresh deployment works before any secret exists: a gate that failed
     *     closed with no secret set would lock everyone out of the dashboard
     *     the moment it deployed.
     *   MONITOR_TOKEN set                          -> ENFORCED.
     *   MONITOR_GATE = "on" but token missing      -> REFUSED, loudly.
     *
     * That last rule is the point. Arming is sticky: once MONITOR_GATE is on in
     * wrangler.toml (versioned, visible in the repo), losing or clearing the
     * secret can never silently reopen the page to the internet. It fails to a
     * named error instead, because something quietly reverting while still
     * looking correct is the worst kind of failure.
     *
     * NEVER extend this to /embed or the API reads it calls. Other sites iframe
     * the embed and the embed fetches those endpoints same-origin; gating
     * either breaks every page that embeds it, silently.
     */
    const gateOn = String(env.MONITOR_GATE || "").trim().toLowerCase() === "on";
    const monitorToken = (env.MONITOR_TOKEN || "").trim();
    if (path === "/" || path === "/monitor" || path === "/mockups") {
      if (gateOn && !monitorToken) {
        return new Response(
          "MONITOR_GATE is on but MONITOR_TOKEN is not set on this Worker.\n" +
          "Set the secret, or remove MONITOR_GATE from wrangler.toml to reopen the page.",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
      if (monitorToken && !basicAuthOk(request, monitorToken)) {
        return new Response("Authentication required.", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Solar dashboard", charset="UTF-8"',
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    if (path === "/mockups") return page(MOCKUPS_HTML, "public, max-age=60");
    // The control page itself is harmless to serve: every write it makes is
    // checked against CONTROL_TOKEN by /api/control.
    if (path === "/control") return page(CONTROL_HTML, "public, max-age=60");
    if (path === "/" || path === "/monitor") {
      // Short cache: the page is small, and a stale copy after a deploy is more
      // annoying than a re-fetch.
      return page(MONITOR_HTML, "public, max-age=60");
    }

    // Optional feed filter shared by every read endpoint. Absent means "both",
    // so callers that never pass it are unaffected. An unrecognized value is rejected rather than ignored:
    // silently returning everything would look exactly like a working filter.
    const source = url.searchParams.get("source");
    if (source !== null && source !== "cloud" && source !== "lan") {
      return json({ error: `invalid source '${source}' — expected 'cloud' or 'lan'` }, 400);
    }
    const andSource = source ? " AND source = ?" : "";
    const whereSource = source ? " WHERE source = ?" : "";
    const srcArg = source ? [source] : [];

    try {
      if (path === "/api/health") {
        const last = await env.DB.prepare(
          "SELECT captured_at, soc, source FROM samples ORDER BY captured_at DESC LIMIT 1"
        ).first();
        const err = await env.DB.prepare("SELECT v FROM meta WHERE k='last_error'").first();
        // Which feeds are actually alive, rather than which are configured.
        const active = await env.DB.prepare(
          "SELECT DISTINCT source FROM samples WHERE captured_at >= ?"
        ).bind(siteIso(Date.now() - 3600_000)).all();
        const ageMin = last ? Math.round((Date.now() - Date.parse(last.captured_at)) / 60000) : null;

        // The LAN agent is optional and usually runs on an ordinary computer
        // that gets shut down or taken elsewhere. Its absence is a normal
        // operating state, not a fault, so report it as plain status rather
        // than as a missing source or an error a consumer has to interpret.
        const lastLan = await env.DB.prepare(
          "SELECT captured_at FROM samples WHERE source='lan' ORDER BY captured_at DESC LIMIT 1"
        ).first();
        const lanAgeMin = lastLan
          ? Math.round((Date.now() - Date.parse(lastLan.captured_at)) / 60000)
          : null;
        const lanActive = lanAgeMin !== null && lanAgeMin <= 20;
        const frozenSince = (await env.DB.prepare("SELECT v FROM meta WHERE k='cloud_frozen_since'").first())?.v;
        const frozenRepeats = (await env.DB.prepare("SELECT v FROM meta WHERE k='cloud_frozen_repeats'").first())?.v;

        return json({
          ok: true,
          region: env.PECRON_REGION || "US",
          credentialsConfigured: Boolean(env.PECRON_EMAIL && env.PECRON_PASSWORD),
          lastSampleAt: last?.captured_at ?? null,
          lastSampleAgeMinutes: ageMin,
          lastSampleSource: last?.source ?? null,
          sourcesActive: active.results.map((r) => r.source),
          localPolling: {
            active: lanActive,
            lastSampleAt: lastLan?.captured_at ?? null,
            lastSampleAgeMinutes: lanAgeMin,
            // Don't assert *why* it stopped. The machine may be shut down, off
            // the local network, or simply outside its scheduled runs - which
            // is the usual case - so "not running" would often be wrong.
            note: lanActive
              ? "The LAN agent is polling the device directly over the local network."
              : "Local polling is off. Cloud feed is unaffected.",
          },
          stale: ageMin === null ? true : ageMin > 20,
          // Set while every cloud poll comes back identical to the stored
          // readings (see cloudIsRepeating). The unit has stopped reporting;
          // the cloud has not noticed; this Worker has, and is not recording
          // the repeats. Cleared by the first reading that differs.
          cloudRepeating: frozenSince
            ? { since: frozenSince, repeats: Number(frozenRepeats || 0),
                note: "Pecron's cloud is answering with the same reading every poll: the unit has stopped reporting to it. Repeats are not stored." }
            : null,
          lastError: err?.v ?? null,
        });
      }

      // Reads are public. Telemetry exposes nothing that can be misused, and an
      // unauthenticated page is far easier to open on a phone.
      // Writes - /api/ingest, /api/poll - stay authenticated.
      if (path === "/api/latest") {
        const row = await env.DB.prepare(
          `SELECT * FROM samples${whereSource} ORDER BY captured_at DESC LIMIT 1`
        ).bind(...srcArg).first();
        if (!row) return json({ error: source ? `no data yet for source '${source}'` : "no data yet" }, 404);
        // Derived from the two fields that carry decimals, so it resolves to
        // ~0.1 W where the device's own watt fields are whole numbers.
        // Positive = charging, negative = discharging.
        const powerWatts =
          row.voltage != null && row.current_amps != null
            ? Math.round(row.voltage * row.current_amps * 10) / 10
            : null;
        return json({ ...row, powerWatts, capacityWattHours: CAPACITY_WH }, 200, 60);
      }

      if (path === "/api/history") {
        const date = url.searchParams.get("date");
        let rows;
        if (date) {
          rows = await env.DB.prepare(
            `SELECT * FROM samples WHERE captured_date=?${andSource} ORDER BY captured_at`
          ).bind(date, ...srcArg).all();
        } else {
          const hours = Math.min(Number(url.searchParams.get("hours") || 24), 24 * 31);
          const since = siteIso(Date.now() - hours * 3600_000);   // same format as stored
          rows = await env.DB.prepare(
            `SELECT * FROM samples WHERE captured_at >= ?${andSource} ORDER BY captured_at`
          ).bind(since, ...srcArg).all();
        }
        return json({ count: rows.results.length, source: source ?? "all", samples: rows.results }, 200, 60);
      }

      if (path === "/api/daily") {
        const days = Math.min(Number(url.searchParams.get("days") || 7), 90);
        // The date list is filtered too. Without that, a day holding only cloud
        // rows still appears when filtering to lan - as an empty rollup.
        const dates = await env.DB.prepare(
          `SELECT DISTINCT captured_date d FROM samples${whereSource} ORDER BY d DESC LIMIT ?`
        ).bind(...srcArg, days).all();
        const out = [];
        for (const { d } of dates.results.reverse()) {
          const rows = await env.DB.prepare(
            `SELECT * FROM samples WHERE captured_date=?${andSource} ORDER BY captured_at`
          ).bind(d, ...srcArg).all();
          out.push(dailyRollup(d, rows.results));
        }
        return json({ days: out, source: source ?? "all", capacityWattHours: CAPACITY_WH }, 200, 300);
      }

      if (path === "/api/ingest" && request.method === "POST") {
        if (!authorized(request, env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        const body = await request.json();
        const records = Array.isArray(body?.records) ? body.records : [body];
        let stored = 0;
        let skipped = 0;
        for (const r of records) {
          if (!r?.sampleId) continue;
          // The LAN agent also emits a dailyRollup record at close of day. It
          // carries totals, not instantaneous readings, so storing it as a
          // sample inserts an all-null row that shows up as junk in history and
          // drags the integration. The Worker derives rollups on read anyway.
          if (r.reportType === "dailyRollup") { skipped++; continue; }
          await insertSample(env, {
            sampleId: r.sampleId,
            capturedAt: r.capturedAt,
            capturedDate: r.capturedDate,
            reportType: r.reportType,
            soc: r.battery?.stateOfCharge ?? null,
            voltage: r.battery?.voltage ?? null,
            currentAmps: r.battery?.currentAmps ?? null,
            temperatureC: r.battery?.temperatureC ?? null,
            solarW: r.solar?.inputWatts ?? 0,
            acOutW: r.load?.acOutputWatts ?? 0,
            dcOutW: r.load?.dcOutputWatts ?? 0,
            acInW: r.load?.acInputWatts ?? 0,
            totalInW: r.totals?.inputWatts ?? null,
            totalOutW: r.totals?.outputWatts ?? null,
            minutesRemaining: r.estimates?.minutesRemaining ?? null,
            acSwitch: r.switches?.ac ?? null,
            dcSwitch: r.switches?.dc ?? null,
            ups: r.switches?.ups ?? null,
            eco: r.switches?.eco ?? null,
            deviceStatus: r.deviceStatus ?? null,
            faultCode: r.faultCode ?? null,
            source: "lan",
          });
          stored++;
        }
        return json({ accepted: records.length, stored, skippedRollups: skipped });
      }

      if (path === "/api/summary") {
        // One query, grouped in JS. The obvious alternative - a rollup query per
        // day - is 90 round trips to D1 for a page public traffic might hammer.
        const since = siteIso(Date.now() - 90 * 24 * 3600_000);
        const all = await env.DB.prepare(
          `SELECT captured_date, captured_at, solar_w, ac_out_w, dc_out_w, ac_in_w,
                  soc, voltage, current_amps
             FROM samples WHERE captured_at >= ? ORDER BY captured_at`
        ).bind(since).all();

        const byDate = new Map();
        for (const r of all.results) {
          if (!byDate.has(r.captured_date)) byDate.set(r.captured_date, []);
          byDate.get(r.captured_date).push(r);
        }

        const today = siteIso(Date.now()).slice(0, 10);
        let lifetimeWh = 0, todayWh = 0, best = null;
        for (const [date, rows] of byDate) {
          const wh = integrate(rows, "solar_w").wh;
          lifetimeWh += wh;
          if (date === today) todayWh = wh;
          if (!best || wh > best.wattHours) best = { date, wattHours: wh };
        }

        const peakWatts = all.results.reduce((m, r) => Math.max(m, r.solar_w || 0), 0);

        /*
         * Self-sufficiency: the share of consumption met by sun AS IT ARRIVED,
         * rather than drawn from the pack and refilled later. Per interval that
         * is min(generation, load) - energy the panel covered in the moment.
         * The distinction matters: a system can be net-positive over a day while
         * running almost entirely off the battery.
         */
        let directWh = 0, loadWh = 0, dischargeWh = 0, todayLoadWh = 0;
        const rows = all.results;
        for (let i = 1; i < rows.length; i++) {
          const mins = (Date.parse(rows[i].captured_at) - Date.parse(rows[i - 1].captured_at)) / 60000;
          if (mins <= 0 || mins > 20) continue;          // same gap guard as integrate()
          const h = mins / 60;
          const load = ((rows[i].ac_out_w || 0) + (rows[i].dc_out_w || 0) +
                        (rows[i - 1].ac_out_w || 0) + (rows[i - 1].dc_out_w || 0)) / 2;
          const gen = ((rows[i].solar_w || 0) + (rows[i - 1].solar_w || 0)) / 2;
          loadWh += load * h;
          if (rows[i].captured_date === today) todayLoadWh += load * h;
          directWh += Math.min(load, gen) * h;
          // Equivalent full cycles are conventionally counted on energy OUT of
          // the pack, so integrate only the discharging half.
          const p = (rows[i].voltage ?? 0) * (rows[i].current_amps ?? 0);
          if (p < 0) dischargeWh += -p * h;
        }
        const selfSufficiencyPct = loadWh > 0 ? Math.round((directWh / loadWh) * 100) : null;

        const psh = (wh) => (PANEL_WATTS > 0 ? Math.round((wh / PANEL_WATTS) * 100) / 100 : null);

        /*
         * Days since the pack last took a charge from the grid (AC input).
         * Take whichever is MORE RECENT: a grid charge actually seen in the
         * samples, or the optional LAST_GRID_CHARGE date (useful because
         * monitoring may start after the last grid charge happened). Measured
         * wins when it is newer, so the declared date quietly stops mattering
         * the first time a real charge is recorded - it is a floor, not an
         * override. With neither, count from the first sample in the window
         * rather than claiming an unbounded streak.
         */
        const lastGrid = all.results.filter((r) => (r.ac_in_w || 0) > 0).at(-1);
        const measuredMs = lastGrid ? Date.parse(lastGrid.captured_at) : null;
        const declaredMs = LAST_GRID_CHARGE ? Date.parse(LAST_GRID_CHARGE) : NaN;
        const firstMs = all.results.length ? Date.parse(all.results[0].captured_at) : NaN;
        let anchorMs = NaN;
        let gridBasis = null;
        if (measuredMs !== null && (!Number.isFinite(declaredMs) || measuredMs >= declaredMs)) {
          anchorMs = measuredMs; gridBasis = "measured";
        } else if (Number.isFinite(declaredMs)) {
          anchorMs = declaredMs; gridBasis = "declared";
        } else if (Number.isFinite(firstMs)) {
          anchorMs = firstMs; gridBasis = "monitoringStart";
        }
        const daysSinceGridCharge = Number.isFinite(anchorMs)
          ? Math.floor((Date.now() - anchorMs) / 86400_000)
          : null;

        // Null when no vehicle with a Wh/mile figure is configured, rather than
        // dividing by nothing.
        const miles = (wh) =>
          WH_PER_MILE > 0 ? Math.round((wh * CHARGE_EFFICIENCY) / WH_PER_MILE) : null;
        const lifetimeMiles = miles(lifetimeWh);

        return json({
          daysMonitored: byDate.size,
          lifetimeHarvestWattHours: Math.round(lifetimeWh),
          todayHarvestWattHours: Math.round(todayWh),
          bestDayWattHours: best?.wattHours ?? null,
          bestDayDate: best?.date ?? null,
          peakWattsEver: peakWatts,
          daysSinceGridCharge,
          gridChargeEverSeen: Boolean(lastGrid),
          // So a consumer can tell a witnessed streak from a stated one rather
          // than having to assume: "measured" | "declared" | "monitoringStart".
          daysSinceGridChargeBasis: gridBasis,
          lastGridChargeAt: Number.isFinite(anchorMs) ? new Date(anchorMs).toISOString() : null,
          milesEquivalentToday: miles(todayWh),
          milesEquivalentLifetime: lifetimeMiles,
          commutesBanked: lifetimeMiles !== null && COMMUTE_MILES > 0
            ? Math.round((lifetimeMiles / COMMUTE_MILES) * 10) / 10
            : null,

          // Peak sun hours - harvest normalized by panel rating. The standard
          // solar yardstick, and the one figure that makes this array
          // comparable to any other.
          peakSunHoursToday: psh(todayWh),
          peakSunHoursBest: best ? psh(best.wattHours) : null,

          selfSufficiencyPct,

          /*
           * Grid energy avoided, and what it was worth.
           *
           * Deliberately based on energy DELIVERED TO LOADS, not on harvest.
           * Harvest is the bigger, more flattering number, but it is the wrong
           * one: energy the panel made and nothing consumed was never going to
           * appear on a bill. Inverter overhead is excluded for the same reason
           * - it is a cost of running off a battery, not a cost the loads would
           * have incurred on the grid. This makes the figure conservative,
           * which is the right side to be wrong on for a number that goes public.
           *
           * Honest caveat: if the pack was grid-charged at some point, some
           * delivered energy WAS bought, just not from the panel. Read
           * alongside daysSinceGridCharge.
           */
          gridEnergyAvoidedWattHours: Math.round(loadWh),
          gridEnergyAvoidedTodayWattHours: Math.round(todayLoadWh),
          valueGeneratedUsd: Math.round((loadWh / 1000) * GRID_RATE_USD_PER_KWH * 100) / 100,
          valueGeneratedTodayUsd: Math.round((todayLoadWh / 1000) * GRID_RATE_USD_PER_KWH * 100) / 100,
          gridRateUsdPerKwh: GRID_RATE_USD_PER_KWH,

          // Pack wear. Counted on energy discharged, which is the convention.
          throughputWattHours: Math.round(dischargeWh),
          equivalentFullCycles: Math.round((dischargeWh / CAPACITY_WH) * 100) / 100,
          ratedCycles: RATED_CYCLES,

          // System totals. lifetimeWh = total harvested; loadWh = delivered to
          // loads. The difference is inverter idle, conversion loss, and BMS.
          totalHarvestedWattHours: Math.round(lifetimeWh),
          totalOverheadWattHours: Math.round(lifetimeWh - loadWh),
          systemEfficiencyPct: lifetimeWh > 0
            ? Math.round((loadWh / lifetimeWh) * 100) : null,

          pevs: PEVS,

          assumptions: {
            whPerMile: WH_PER_MILE,
            chargeEfficiency: CHARGE_EFFICIENCY,
            commuteMiles: COMMUTE_MILES,
            pevSource: PEVS[0]?.name ?? null,
            panelWatts: PANEL_WATTS,
            ratedCycles: RATED_CYCLES,
            gridRateUsdPerKwh: GRID_RATE_USD_PER_KWH,
            gridRateVerified: GRID_RATE_VERIFIED,
            note:
              (PEVS[0] && WH_PER_MILE
                ? "Commute Wh/mile based on the " + PEVS[0].name + " (" + WH_PER_MILE + " Wh/mi" +
                  (PEVS[0].whPerMileSource ? ", " + PEVS[0].whPerMileSource : "") + "). "
                : "No vehicle is configured in site.config.js, so mile figures are null. ") +
              "Charge efficiency is an estimate covering charger and inverter losses. Miles are an equivalence, not an attribution - other loads draw on the same generation. " +
              (GRID_RATE_VERIFIED
                ? "The grid rate was set from a real bill. "
                : "The grid rate is a PLACEHOLDER until GRID_RATE_VERIFIED is set; ") +
              "value and avoided-energy figures are computed on energy delivered to loads, which excludes both unused harvest and inverter overhead.",
          },
        }, 200, 600);
      }

      if (path === "/api/hourly") {
        // Hour x day generation grid, aggregated here rather than in a browser.
        // Building this client-side would mean shipping a month of raw samples
        // to a phone to produce a few hundred cells.
        const days = Math.min(Number(url.searchParams.get("days") || 30), 90);
        const since = siteIso(Date.now() - days * 24 * 3600_000);
        const rs = await env.DB.prepare(
          `SELECT captured_date, substr(captured_at, 12, 2) hh,
                  AVG(solar_w) avg_w, MAX(solar_w) max_w, COUNT(*) n
             FROM samples WHERE captured_at >= ?
            GROUP BY captured_date, hh
            ORDER BY captured_date, hh`
        ).bind(since).all();

        const cells = rs.results.map((r) => ({
          date: r.captured_date,
          hour: Number(r.hh),
          avgWatts: Math.round(r.avg_w || 0),
          maxWatts: Math.round(r.max_w || 0),
          samples: r.n,
        }));
        return json({
          days: [...new Set(cells.map((c) => c.date))],
          cells,
          peakWatts: cells.reduce((m, c) => Math.max(m, c.maxWatts), 0),
          panelWatts: PANEL_WATTS,
        }, 200, 600);
      }

      if (path === "/api/health-trend") {
        /*
         * Pack aging shows up as resting voltage drifting at a comparable
         * state of charge. Both conditions matter: voltage under load says
         * nothing, and voltage at 100% says nothing either, so restrict to
         * near-idle current in a mid-charge band and let the weekly mean move.
         *
         * This needs months to say anything. It returns whatever exists so the
         * shape is visible early, with the sample count attached so a reader
         * can tell a trend from a rumour.
         */
        /*
         * Bucket by state of charge, not just by day. Averaging voltage across
         * a wide charge band and comparing days is meaningless: a day that
         * happened to sit at 75% will read higher than one that sat at 53%, and
         * that looks exactly like a pack improving. Comparisons are only valid
         * WITHIN a bucket, so the bucket is part of the key.
         */
        const rs = await env.DB.prepare(
          `SELECT captured_date, (CAST(soc AS INTEGER) / 5) * 5 AS soc_bucket,
                  AVG(voltage) v, COUNT(*) n
             FROM samples
            WHERE voltage IS NOT NULL AND current_amps IS NOT NULL
              AND ABS(current_amps) < 1.0
              AND soc IS NOT NULL
            GROUP BY captured_date, soc_bucket
            HAVING n >= 3
            ORDER BY soc_bucket, captured_date`
        ).all();
        return json({
          conditions: { maxAbsCurrentAmps: 1.0, socBucketPercent: 5, minSamplesPerBucket: 3 },
          points: rs.results.map((r) => ({
            date: r.captured_date,
            socBucket: r.soc_bucket,
            meanVoltage: Math.round(r.v * 1000) / 1000,
            samples: r.n,
          })),
          note: "Resting voltage per 5% charge bucket. Compare a bucket against itself over time — never across buckets. Meaningful over months, not days.",
        }, 200, 600);
      }

      /*
       * End-to-end delivery test. Exists because the failure being replaced was
       * an alert path that looked configured and delivered nothing for days -
       * ntfy answering Worker egress with 429. Deploying is not evidence; a
       * message arriving in the inbox is.
       *
       * Reuses the control token rather than inventing a third credential, and
       * reports which sinks actually accepted the message rather than just "ok".
       */
      if (path === "/api/test-alert" && request.method === "POST") {
        if (!controlAuthorized(request, env)) {
          return json({ error: "unauthorized" }, 401);
        }
        const stamp = siteIso(Date.now());
        const staleMin = Number(env.ALERT_STALE_MINUTES ?? 30);
        const mailed = await sendEmail(
          env,
          `${SITE_NAME}: test alert`,
          `This is a delivery test sent at ${stamp}.\n\n` +
          `If you are reading it, alerting works end to end: the Worker can reach ` +
          `Mailgun and mail reaches this inbox. Nothing is wrong with the system.\n\n` +
          `Live alerts fire on three conditions - telemetry stopping for over ${staleMin} minutes, ` +
          `a device fault code, and the pack not having enough runtime to reach the ` +
          `panel's ${minToHhmm(WINDOW_OPENS_MIN)} window.`
        );
        const missing = ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "ALERT_EMAIL"].filter((k) => !String(env[k] || "").trim());
        return json({
          sentAt: stamp,
          email: mailed
            ? "delivered to Mailgun"
            : missing.length ? `NOT SENT - not set: ${missing.join(", ")}` : "NOT SENT - Mailgun rejected the request (see wrangler tail)",
          emailTo: (env.ALERT_EMAIL || "").trim() || null,
          mailgunDomain: (env.MAILGUN_DOMAIN || "").trim() || null,
          webhook: env.ALERT_WEBHOOK ? "configured (ntfy is known to 429)" : "not configured",
          note: mailed
            ? "Mailgun accepted it. Confirm it actually arrived before calling this done."
            : "Set the missing value(s) - MAILGUN_API_KEY as a Worker secret, the others in [vars] - redeploy, then run this again.",
        }, mailed ? 200 : 503);
      }

      if (path === "/api/control" && request.method === "POST") {
        let body = {};
        try { body = await request.json(); } catch { /* handled below */ }
        const code = body?.code;
        const value = body?.value;

        if (!controlAuthorized(request, env)) {
          await logControl(env, code ?? "(none)", value, "unauthorized",
            env.CONTROL_TOKEN ? "bad or missing token" : "CONTROL_TOKEN is not configured");
          return json({
            error: "unauthorized",
            detail: env.CONTROL_TOKEN ? undefined : "CONTROL_TOKEN is not configured on this Worker",
          }, 401);
        }

        if (CONTROL_DENYLIST[code]) {
          await logControl(env, code, value, "refused", CONTROL_DENYLIST[code]);
          return json({ error: "refused", reason: CONTROL_DENYLIST[code] }, 403);
        }

        const validate = CONTROL_ALLOWLIST[code];
        if (!validate) {
          await logControl(env, code ?? "(none)", value, "refused", "not in allowlist");
          return json({ error: `'${code}' is not a controllable property`, allowed: Object.keys(CONTROL_ALLOWLIST) }, 400);
        }
        if (!validate(value)) {
          await logControl(env, code, value, "refused", "value failed validation");
          return json({ error: `invalid value for ${code}` }, 400);
        }

        try {
          const result = await sendControl(env, code, value);
          await logControl(env, code, value, "applied", JSON.stringify(result ?? null).slice(0, 300));
          return json({
            ok: true, code, value, result,
            note: "The device confirms asynchronously — its reported state may take a few minutes to catch up.",
          });
        } catch (err) {
          await logControl(env, code, value, "error", err.message);
          return json({ error: err.message }, 502);
        }
      }

      if (path === "/api/control-log") {
        const rows = await env.DB.prepare(
          "SELECT at, code, value, result, detail FROM control_log ORDER BY id DESC LIMIT 100"
        ).all();
        return json({ count: rows.results.length, entries: rows.results });
      }

      if (path === "/api/poll" && request.method === "POST") {
        // Manual trigger, handy while setting up. Uses the ingest token.
        if (!authorized(request, env.INGEST_TOKEN)) return json({ error: "unauthorized" }, 401);
        const s = await pollOnce(env);
        // Evaluate alerts here too, so a manual poll is equivalent to a
        // scheduled one and the alert path can be exercised on demand rather
        // than only by waiting for the cron.
        await evaluateAlert(env);
        return json({ polled: s });
      }

      return json({ error: "not found", endpoints: ["/api/health", "/api/latest", "/api/history", "/api/daily", "/api/ingest", "/api/poll"] }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
