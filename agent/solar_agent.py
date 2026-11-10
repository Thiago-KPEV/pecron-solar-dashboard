"""
Solar LAN Agent (optional)
==========================
Reads a Pecron power station directly over the local network, using the
MIT-licensed `pecron-monitor` package, and POSTs each reading to the Worker's
/api/ingest endpoint. It is a second, corroborating source: the Worker's own
cloud polling keeps working whether or not this runs.

The agent assumes it can be killed without warning (machine shut down, laptop
lid closed, power cut) and never holds unsent data only in memory.

Durability model
----------------
  poll -> append to JSONL spool (fsync'd) -> attempt push -> mark sent

Every sample lands on disk before any network call. If the machine powers off
mid-cycle, nothing is lost; the next run forwards the backlog. The Worker
treats `sampleId` as an idempotency key, so replays never double-count.

Day boundaries
--------------
  dayOpen   emitted on the first successful poll of a day
  sample    emitted on each later poll through the day
  dayClose  emitted by `--close`, typically scheduled in the evening

`--close` also emits a daily rollup computed locally from the spool, so it stays
correct even if individual pushes failed during the day. (The Worker skips the
rollup record and derives its own rollups from samples.)

Configuration (environment variables)
-------------------------------------
  SOLAR_INGEST_URL     https://<your-worker>/api/ingest   (unset = print only)
  SOLAR_INGEST_TOKEN   the Worker's INGEST_TOKEN (or store it encrypted with
                       setup-agent.ps1 -SetToken on Windows)
  SOLAR_PECRON_CMD     path to pecron-monitor (default: found on PATH)
  SOLAR_PECRON_CONFIG  pecron-monitor's config.yaml (only needed for --resolve
                       / address self-heal)
  SOLAR_DEVICE_MAC     the unit's MAC address, enables address self-heal
  SOLAR_SUBNET         first three octets of your LAN, e.g. 10.0.0
  SOLAR_SPOOL_DIR      where the spool lives (default ~/.solar-agent)
  SOLAR_POLL_SECONDS, SOLAR_CLOSE_EARLIEST_HOUR, SOLAR_SITE_ID,
  SOLAR_DEVICE_ID, SOLAR_CAPACITY_WH   see below

Usage
-----
  python solar_agent.py --once            # single sample, push, exit
  python solar_agent.py --run             # continuous, until killed
  python solar_agent.py --close           # end-of-day rollup + flush
  python solar_agent.py --flush           # retry backlog only
  python solar_agent.py --resolve         # find the unit by MAC, fix config
  python solar_agent.py --once --dry-run  # print payload, never send
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib import request, error

# --------------------------------------------------------------------------
# Configuration. Endpoint + token come from the environment so no secret is
# ever committed alongside this file.
# --------------------------------------------------------------------------

SITE_ID = os.environ.get("SOLAR_SITE_ID", "site-01")
DEVICE_ID = os.environ.get("SOLAR_DEVICE_ID", "pecron-01")
DEVICE_MODEL = os.environ.get("SOLAR_DEVICE_MODEL", "F3000LFP")
CAPACITY_WH = int(os.environ.get("SOLAR_CAPACITY_WH", "3072"))

INGEST_URL = os.environ.get("SOLAR_INGEST_URL", "")   # e.g. https://solar.example.com/api/ingest


def _load_token() -> str:
    """
    Prefer a DPAPI-encrypted blob over an environment variable.

    The blob is written by PowerShell's ConvertFrom-SecureString, so the token
    is encrypted at rest against *this Windows account on this machine* - a
    copied file is useless elsewhere, and the plaintext never sits in the
    registry, a dotfile, or a process listing. Scheduled tasks run as the same
    user, so they decrypt it transparently.
    """
    blob_file = SPOOL_DIR / "ingest-token.dpapi"
    if blob_file.exists():
        try:
            import ctypes
            from ctypes import wintypes

            class BLOB(ctypes.Structure):
                _fields_ = [("cbData", wintypes.DWORD),
                            ("pbData", ctypes.POINTER(ctypes.c_char))]

            raw = bytes.fromhex(blob_file.read_text(encoding="ascii").strip())
            buf = ctypes.create_string_buffer(raw, len(raw))
            blob_in = BLOB(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
            blob_out = BLOB()
            ok = ctypes.windll.crypt32.CryptUnprotectData(
                ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
            )
            if ok:
                out = ctypes.string_at(blob_out.pbData, blob_out.cbData)
                ctypes.windll.kernel32.LocalFree(blob_out.pbData)
                return out.decode("utf-16-le").strip()
            print("[warn] token blob present but could not be decrypted", file=sys.stderr)
        except Exception as exc:
            print(f"[warn] DPAPI token unavailable ({exc})", file=sys.stderr)
    return os.environ.get("SOLAR_INGEST_TOKEN", "")

POLL_SECONDS = int(os.environ.get("SOLAR_POLL_SECONDS", "300"))
SPOOL_DIR = Path(os.environ.get("SOLAR_SPOOL_DIR", Path.home() / ".solar-agent"))

# Task Scheduler runs the close task with StartWhenAvailable, so a missed
# evening run fires whenever the machine next comes up - often the following
# morning. Closing then stamps a dayClose on the wrong day using a few minutes of
# partial data. Refuse before this hour unless --force says otherwise.
CLOSE_EARLIEST_HOUR = int(os.environ.get("SOLAR_CLOSE_EARLIEST_HOUR", "15"))

PECRON_CMD = os.environ.get("SOLAR_PECRON_CMD") or shutil.which("pecron-monitor") or "pecron-monitor"

# Many routers hand out addresses by DHCP with no way to reserve one, so the
# unit's address can move. Its device key is its MAC address, which gives a
# stable identity to resolve against. Both values are optional: without them
# the agent simply uses whatever lan_ip pecron-monitor's config holds.
DEVICE_MAC = re.sub(r"[^0-9A-Fa-f]", "", os.environ.get("SOLAR_DEVICE_MAC", "")).upper()
SUBNET = os.environ.get("SOLAR_SUBNET", "").strip().rstrip(".")


def _default_pecron_config() -> Path:
    """pecron-monitor keeps config.yaml next to its own module by default."""
    try:
        import importlib.util
        spec = importlib.util.find_spec("pecron_monitor")
        if spec and spec.origin:
            return Path(spec.origin).parent / "config.yaml"
    except (ImportError, ValueError):
        pass
    return Path("config.yaml")


PECRON_CONFIG = Path(os.environ.get("SOLAR_PECRON_CONFIG", "") or _default_pecron_config())
SWEEP_COOLDOWN_MIN = 30

# The agent usually runs on an ordinary desktop or laptop. Every child process
# is launched without a console so nothing flashes on screen while someone is
# working.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _ensure_output_streams() -> None:
    """
    Under pythonw.exe there is no console and sys.stdout/stderr are None, which
    makes any print() raise. Point both at a small rotating log instead, so the
    agent stays silent on screen but still leaves a trail worth reading.
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        SPOOL_DIR.mkdir(parents=True, exist_ok=True)
        path = SPOOL_DIR / "agent.log"
        if path.exists() and path.stat().st_size > 1_000_000:
            path.replace(SPOOL_DIR / "agent.log.1")
        handle = open(path, "a", encoding="utf-8", buffering=1)
        sys.stdout = handle
        sys.stderr = handle
    except OSError:
        # Never let logging problems stop a poll.
        devnull = open(os.devnull, "w")
        sys.stdout = devnull
        sys.stderr = devnull

LOCAL_TZ = datetime.now().astimezone().tzinfo


# --------------------------------------------------------------------------
# Spool - append-only JSONL, one file per local day.
# --------------------------------------------------------------------------

def spool_path(day: str) -> Path:
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    return SPOOL_DIR / f"{day}.jsonl"


def spool_append(record: dict) -> None:
    """Append one record and fsync. Survives an unannounced power cut."""
    path = spool_path(record["capturedDate"])
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def spool_read(day: str) -> list[dict]:
    path = spool_path(day)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                # A torn final line is expected if power was cut mid-write.
                continue
    return out


def mark_sent(sample_ids: set[str]) -> None:
    sent_file = SPOOL_DIR / "sent.txt"
    with sent_file.open("a", encoding="utf-8") as fh:
        for sid in sample_ids:
            fh.write(sid + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def already_sent() -> set[str]:
    sent_file = SPOOL_DIR / "sent.txt"
    if not sent_file.exists():
        return set()
    return {ln.strip() for ln in sent_file.read_text(encoding="utf-8").splitlines() if ln.strip()}


# --------------------------------------------------------------------------
# Device read
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Address self-heal
#
# pecron-monitor reads a fixed `lan_ip` from its config. If the DHCP lease
# moves, every poll times out and the agent reports "device offline" - which is
# indistinguishable from the device actually being off, and the cloud feed would
# happily mask it. So: resolve the current address by MAC and rewrite the config
# when it has changed.
# --------------------------------------------------------------------------

def _norm_mac(text: str) -> str:
    return re.sub(r"[^0-9A-Fa-f]", "", text).upper()


def arp_lookup(mac: str) -> str | None:
    """Find an IP for a MAC in the local ARP table."""
    try:
        out = subprocess.run(["arp", "-a"], capture_output=True, text=True, timeout=30,
                             encoding="utf-8", errors="replace",
                             creationflags=NO_WINDOW).stdout or ""
    except Exception:
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and _norm_mac(parts[1]) == mac:
            return parts[0]
    return None


def prime_arp(subnet: str) -> None:
    """
    Touch every host on the subnet so ARP resolves them.

    ARP is populated by the address resolution that *precedes* the ICMP send, so
    even a host that ignores ping ends up in the table - which matters, because
    the Pecron does not answer ping reliably.
    """
    def touch(i: int) -> None:
        try:
            subprocess.run(["ping", "-n", "1", "-w", "300", f"{subnet}.{i}"],
                           capture_output=True, timeout=10, creationflags=NO_WINDOW)
        except Exception:
            pass
    with ThreadPoolExecutor(max_workers=64) as pool:
        list(pool.map(touch, range(1, 255)))


def _sweep_allowed() -> bool:
    """Rate-limit the sweep. While the unit is unreachable every poll fails;
    sweeping 254 hosts every five minutes would be pointless noise on the LAN."""
    marker = SPOOL_DIR / ".last-sweep"
    now = time.time()
    if marker.exists():
        try:
            if now - float(marker.read_text().strip()) < SWEEP_COOLDOWN_MIN * 60:
                return False
        except ValueError:
            pass
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(now))
    return True


# Read with utf-8-sig and write plain utf-8. A byte-order mark at the head of
# config.yaml makes the YAML parser read the first key as "ï»¿email", which
# fails as a KeyError far away from the cause - and Windows tooling adds one
# readily. utf-8-sig strips it on read; writing plain utf-8 never re-adds it.
CONFIG_READ_ENC = "utf-8-sig"


def config_lan_ip() -> str | None:
    try:
        for line in PECRON_CONFIG.read_text(encoding=CONFIG_READ_ENC, errors="replace").splitlines():
            m = re.match(r"^\s*lan_ip\s*:\s*(\S+)", line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return None


def set_config_lan_ip(ip: str) -> bool:
    """Rewrite only the lan_ip line. The file also holds credentials, so it is
    edited in place rather than regenerated, and never logged."""
    try:
        raw = PECRON_CONFIG.read_text(encoding=CONFIG_READ_ENC, errors="replace")
        new = re.sub(r"(?m)^(\s*lan_ip\s*:\s*).*$", lambda m: m.group(1) + ip, raw)
        if new == raw:
            return False
        # newline="" keeps the file's existing line endings; encoding without a
        # BOM keeps the first key parseable.
        with open(PECRON_CONFIG, "w", encoding="utf-8", newline="") as fh:
            fh.write(new)
        return True
    except OSError as exc:
        print(f"[heal] could not update config: {exc}", file=sys.stderr)
        return False


def ensure_device_ip() -> str | None:
    """Resolve the device's current address, updating the config if it moved."""
    if not DEVICE_MAC or not SUBNET:
        print("[heal] SOLAR_DEVICE_MAC and SOLAR_SUBNET are not both set - "
              "address self-heal is off", file=sys.stderr)
        return None
    ip = arp_lookup(DEVICE_MAC)
    if not ip and _sweep_allowed():
        prime_arp(SUBNET)
        ip = arp_lookup(DEVICE_MAC)
    if not ip:
        return None
    current = config_lan_ip()
    if current != ip and set_config_lan_ip(ip):
        print(f"[heal] device moved {current} -> {ip}; config updated")
    return ip


def read_device() -> dict:
    """
    Read telemetry, self-healing a changed address once before giving up.

    The happy path costs nothing extra - resolution only runs after a failed
    read, so a working poll never triggers an ARP sweep.
    """
    try:
        return _read_device_once()
    except RuntimeError as first:
        ip = ensure_device_ip()
        if not ip:
            where = f"MAC {DEVICE_MAC} not present on {SUBNET}.0/24" if DEVICE_MAC and SUBNET \
                else "self-heal off: set SOLAR_DEVICE_MAC and SOLAR_SUBNET"
            raise RuntimeError(f"{first} ({where})") from first
        return _read_device_once()


def _read_device_once() -> dict:
    """Call pecron-monitor over LAN and return the device's telemetry dict."""
    cmd = [PECRON_CMD, "--raw", "--local", "--no-ble"]
    # pecron-monitor logs emoji. Under the console default (cp1252) the capture
    # thread throws UnicodeDecodeError mid-read and truncates output, so pin
    # UTF-8 and never let a stray byte kill a poll.
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180,
                          encoding="utf-8", errors="replace",
                          creationflags=NO_WINDOW)
    text = proc.stdout or ""

    # `--raw` prints a human-readable report first and the machine-readable
    # payload after a "RAW JSON DATA:" banner. Grabbing the first "{" would
    # land inside the pretty-printed UNKNOWN FIELDS block, so anchor on the
    # banner. raw_decode stops at the end of the object and ignores any
    # trailing output.
    marker = "RAW JSON DATA:"
    idx = text.find(marker)
    if idx < 0:
        detail = (proc.stderr or text).strip()[:400]
        raise RuntimeError(f"no telemetry returned: {detail or 'device offline'}")
    start = text.find("{", idx)
    if start < 0:
        raise RuntimeError("banner present but no JSON object followed")
    payload, _ = json.JSONDecoder().raw_decode(text[start:])

    # Payload is keyed by device id: {"<device key>": {...}}. Unwrap it.
    if len(payload) == 1:
        inner = next(iter(payload.values()))
        if isinstance(inner, dict):
            return inner
    return payload


def dig(raw: dict, *path, default=None):
    """Read a nested key path, tolerating absent branches."""
    cur = raw
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return default
        cur = cur[key]
    return default if cur is None else cur


def first(*values, default=None):
    """First non-None value - firmware moves fields between revisions."""
    for v in values:
        if v is not None:
            return v
    return default


def build_sample(raw: dict, report_type: str) -> dict:
    """
    Map the F3000LFP's TSL payload onto the /api/ingest record shape.

    Field paths were verified against an F3000LFP. Flat and nested spellings
    are both accepted because the firmware exposes several of these in two
    places at once.
    """
    now = datetime.now(LOCAL_TZ)
    host = raw.get("host_packet_data_jdb", {}) if isinstance(raw.get("host_packet_data_jdb"), dict) else {}

    soc = first(raw.get("battery_percentage"), host.get("host_packet_electric_percentage"))
    solar_w = first(dig(raw, "dc_data_input_hm", "dc_input_power"), default=0)
    ac_out = first(dig(raw, "ac_data_output_hm", "ac_output_power"), default=0)
    dc_out = first(dig(raw, "dc_data_output_hm", "dc_output_power"), default=0)
    ac_in = first(dig(raw, "ac_data_input_hm", "ac_input_power"),
                  dig(raw, "ac_data_input_hm", "ac_power"), default=0)

    return {
        "sampleId": str(uuid.uuid4()),
        "siteId": SITE_ID,
        "deviceId": DEVICE_ID,
        "deviceModel": DEVICE_MODEL,
        "reportType": report_type,                      # dayOpen | sample | dayClose
        "capturedAt": now.isoformat(timespec="seconds"),
        "capturedDate": now.strftime("%Y-%m-%d"),
        "battery": {
            "stateOfCharge": soc,
            "voltage": round(v, 2) if (v := host.get("host_packet_voltage")) is not None else None,
            "currentAmps": round(c, 2) if (c := host.get("host_packet_current")) is not None else None,
            "temperatureC": first(host.get("host_packet_temp"), raw.get("battery_temp")),
            "capacityWattHours": CAPACITY_WH,
        },
        "solar": {
            # No dedicated PV sensor on this model - the array arrives on DC in.
            "inputWatts": solar_w,
        },
        "load": {
            "acOutputWatts": ac_out,
            "dcOutputWatts": dc_out,
            "acInputWatts": ac_in,
            "acOutputVolts": dig(raw, "ac_data_output_hm", "ac_output_voltage"),
            "acOutputHz": dig(raw, "ac_data_output_hm", "ac_output_hz"),
        },
        "totals": {
            "inputWatts": raw.get("total_input_power"),
            "outputWatts": raw.get("total_output_power"),
            "netWatts": (raw.get("total_input_power") or 0) - (raw.get("total_output_power") or 0),
        },
        "estimates": {
            "minutesRemaining": raw.get("remain_time"),
            "minutesToFull": raw.get("remain_charging_time"),
        },
        "switches": {
            "ac": first(raw.get("ac_switch_hm"), host.get("host_packet_ac_switch")),
            "dc": first(raw.get("dc_switch_hm"), host.get("host_packet_dc_switch")),
            "ups": first(raw.get("ups_status_hm"), host.get("host_packet_ups_status")),
            "eco": raw.get("eco_onoff_us"),
        },
        # Raw enums, decoded for display rather than in storage. deviceStatus
        # reports Standby directly, which beats inferring it from silence.
        "deviceStatus": first(raw.get("device_status_hm"), host.get("host_packet_status")),
        "faultCode": raw.get("FAULT_ALARM_ENUM"),
        "agent": {
            "source": "pecron-monitor",
            "transport": "wifiTcp",
            "deviceIp": config_lan_ip(),        # resolved, not assumed - the lease can move
            "deviceMac": DEVICE_MAC,
            "agentVersion": "1.2.0",
        },
    }


# --------------------------------------------------------------------------
# Daily rollup - integrates the spool, so it is correct even if pushes failed.
# --------------------------------------------------------------------------

def build_rollup(day: str) -> dict:
    samples = [s for s in spool_read(day) if s.get("reportType") != "dayClose"]
    if not samples:
        return {"date": day, "sampleCount": 0, "note": "no samples recorded"}

    samples.sort(key=lambda s: s["capturedAt"])

    def ts(s):
        return datetime.fromisoformat(s["capturedAt"])

    harvest_wh = 0.0
    consumed_wh = 0.0
    largest_gap = 0.0
    for prev, cur in zip(samples, samples[1:]):
        hours = (ts(cur) - ts(prev)).total_seconds() / 3600.0
        # Guard against the overnight gap inflating totals via trapezoid over a
        # multi-hour hole: only integrate across plausible polling intervals.
        if hours <= 0 or hours > (POLL_SECONDS * 4) / 3600.0:
            largest_gap = max(largest_gap, hours * 60.0)
            continue
        pw = prev["solar"]["inputWatts"] or 0
        cw = cur["solar"]["inputWatts"] or 0
        harvest_wh += (pw + cw) / 2.0 * hours
        pl = (prev["load"]["acOutputWatts"] or 0) + (prev["load"]["dcOutputWatts"] or 0)
        cl = (cur["load"]["acOutputWatts"] or 0) + (cur["load"]["dcOutputWatts"] or 0)
        consumed_wh += (pl + cl) / 2.0 * hours

    socs = [s["battery"]["stateOfCharge"] for s in samples if s["battery"]["stateOfCharge"] is not None]
    solar = [s["solar"]["inputWatts"] or 0 for s in samples]

    return {
        "date": day,
        "harvestWattHours": round(harvest_wh, 1),
        "consumedWattHours": round(consumed_wh, 1),
        "peakSolarWatts": max(solar) if solar else 0,
        "socOpen": socs[0] if socs else None,
        "socClose": socs[-1] if socs else None,
        "socMin": min(socs) if socs else None,
        "socMax": max(socs) if socs else None,
        "firstSampleAt": samples[0]["capturedAt"],
        "lastSampleAt": samples[-1]["capturedAt"],
        "sampleCount": len(samples),
        "largestGapMinutes": round(largest_gap, 1),
    }


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------

def push(records: list[dict], dry_run: bool = False) -> bool:
    if not records:
        return True
    if dry_run or not INGEST_URL:
        print(json.dumps(records if len(records) > 1 else records[0], indent=2))
        if not INGEST_URL and not dry_run:
            print("\n[warn] SOLAR_INGEST_URL unset - printed instead of sent.", file=sys.stderr)
        return True

    body = json.dumps({"records": records}).encode("utf-8")
    req = request.Request(INGEST_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "pecron-solar-agent/1.0")
    token = _load_token()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with request.urlopen(req, timeout=30) as resp:
            ok = 200 <= resp.status < 300
            if ok:
                mark_sent({r["sampleId"] for r in records})
            return ok
    except (error.URLError, error.HTTPError, TimeoutError) as exc:
        print(f"[warn] push failed, kept in spool: {exc}", file=sys.stderr)
        return False


def flush_backlog(dry_run: bool = False) -> int:
    """Forward everything on disk the Worker has not acknowledged."""
    sent = already_sent()
    pending: list[dict] = []
    for path in sorted(SPOOL_DIR.glob("*.jsonl")):
        for rec in spool_read(path.stem):
            if rec.get("sampleId") not in sent:
                pending.append(rec)
    if not pending:
        return 0
    # Chunk so one huge backlog does not produce an oversized request.
    forwarded = 0
    for i in range(0, len(pending), 200):
        chunk = pending[i:i + 200]
        if push(chunk, dry_run=dry_run):
            forwarded += len(chunk)
        else:
            break
    return forwarded


# --------------------------------------------------------------------------

def last_record_before(ts: datetime) -> dict | None:
    """Most recent spooled reading earlier than `ts` that carries a charge level."""
    best = None
    best_t = None
    for path in sorted(SPOOL_DIR.glob("*.jsonl")):
        for rec in spool_read(path.stem):
            if dig(rec, "battery", "stateOfCharge") is None:
                continue
            try:
                t = datetime.fromisoformat(rec["capturedAt"])
            except (KeyError, ValueError):
                continue
            if t < ts and (best_t is None or t > best_t):
                best, best_t = rec, t
    return best


def overnight_delta(current: dict) -> dict | None:
    """
    Recover the average load across an unmonitored gap from its two bookends.

    The agent may not run overnight, and Pecron's cloud keeps no retrievable
    history. But the pack itself is the meter - the charge level at
    last light and the charge level at first light, divided by the hours
    between, give the average draw directly. No overnight polling required.

    State of charge reports in whole percent, so precision is one percent of
    the pack spread over the gap; `resolutionWatts` reports that honestly.
    """
    try:
        now_t = datetime.fromisoformat(current["capturedAt"])
    except (KeyError, ValueError):
        return None
    prev = last_record_before(now_t)
    if not prev:
        return None

    prev_t = datetime.fromisoformat(prev["capturedAt"])
    hours = (now_t - prev_t).total_seconds() / 3600.0
    if hours < 0.5:                                   # not a gap, just the next poll
        return None

    soc_from = dig(prev, "battery", "stateOfCharge")
    soc_to = dig(current, "battery", "stateOfCharge")
    if soc_from is None or soc_to is None:
        return None
    cap = dig(current, "battery", "capacityWattHours", default=CAPACITY_WH)
    net_wh = (soc_to - soc_from) / 100.0 * cap

    return {
        "method": "stateOfChargeBookends",
        "fromAt": prev["capturedAt"],
        "toAt": current["capturedAt"],
        "hours": round(hours, 2),
        "socFrom": soc_from,
        "socTo": soc_to,
        "netWattHours": round(net_wh, 1),
        "averageWatts": round(net_wh / hours, 1),      # negative = net draw
        "resolutionWatts": round(cap / 100.0 / hours, 2),
    }


def do_sample(report_type: str, dry_run: bool) -> None:
    raw = read_device()
    rec = build_sample(raw, report_type)
    if report_type == "dayOpen":
        gap = overnight_delta(rec)
        if gap:
            rec["overnight"] = gap
            print(f"  overnight: {gap['averageWatts']:+.1f} W avg over {gap['hours']} h "
                  f"({gap['socFrom']}% -> {gap['socTo']}%, +/-{gap['resolutionWatts']} W)")
    spool_append(rec)
    push([rec], dry_run=dry_run)
    soc = rec["battery"]["stateOfCharge"]
    print(f"{rec['capturedAt']}  {report_type:8}  soc={soc}%  solar={rec['solar']['inputWatts']}W")


def main() -> int:
    _ensure_output_streams()        # must precede any print()
    ap = argparse.ArgumentParser(description="Solar LAN agent for pecron-solar-dashboard")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--once", action="store_true", help="one sample then exit")
    g.add_argument("--run", action="store_true", help="poll continuously")
    g.add_argument("--close", action="store_true", help="end-of-day rollup and flush")
    g.add_argument("--flush", action="store_true", help="retry unsent backlog only")
    g.add_argument("--resolve", action="store_true",
                   help="resolve the device's address by MAC and update the config")
    ap.add_argument("--dry-run", action="store_true", help="print payloads, never send")
    ap.add_argument("--force", action="store_true",
                    help=f"with --close, close the day even before "
                         f"{CLOSE_EARLIEST_HOUR:02d}:00 local")
    args = ap.parse_args()

    if args.resolve:
        configured = config_lan_ip()
        found = ensure_device_ip()
        print(f"device MAC : {DEVICE_MAC}")
        print(f"config says: {configured}")
        print(f"on the LAN : {found or 'NOT FOUND'}")
        if found and found == configured:
            print("match - no change needed")
        elif not found:
            print("device is not answering on this subnet")
            return 1
        return 0

    if args.flush:
        n = flush_backlog(args.dry_run)
        print(f"forwarded {n} backlogged record(s)")
        return 0

    if args.close:
        now = datetime.now(LOCAL_TZ)
        if now.hour < CLOSE_EARLIEST_HOUR and not args.force:
            # Almost certainly a catch-up firing of a missed evening run. Flushing
            # the backlog is always safe and is the useful half of this task, so
            # do that and stop short of writing a close for a day still running.
            n = flush_backlog(args.dry_run)
            print(f"[skip] --close at {now.strftime('%H:%M')} is before "
                  f"{CLOSE_EARLIEST_HOUR:02d}:00 local - treating it as a catch-up run, "
                  f"not closing the day. Forwarded {n} backlogged record(s). "
                  f"Use --force to close anyway.")
            return 0
        today = now.strftime("%Y-%m-%d")
        try:
            do_sample("dayClose", args.dry_run)
        except Exception as exc:                       # device may already be asleep
            print(f"[warn] final sample unavailable: {exc}", file=sys.stderr)
        now = datetime.now(LOCAL_TZ)
        rollup = {
            "sampleId": str(uuid.uuid4()),
            "siteId": SITE_ID,
            "deviceId": DEVICE_ID,
            "reportType": "dailyRollup",
            "capturedAt": now.isoformat(timespec="seconds"),
            "capturedDate": today,
            "daily": build_rollup(today),
        }
        spool_append(rollup)
        push([rollup], dry_run=args.dry_run)
        flush_backlog(args.dry_run)
        print(json.dumps(rollup["daily"], indent=2))
        return 0

    if args.once:
        flush_backlog(args.dry_run)                    # clear any backlog first
        # May be scheduled several times a day. Only the first successful run
        # of a given day is the day's opening reading.
        today_str = datetime.now(LOCAL_TZ).strftime("%Y-%m-%d")
        try:
            do_sample("dayOpen" if not spool_read(today_str) else "sample", args.dry_run)
        except Exception as exc:
            # A missed read is normal on a scheduled run (device asleep, this
            # machine on a different network). Report and exit quietly rather
            # than filling Task Scheduler's history with tracebacks.
            print(f"[skip] no reading this cycle: {exc}", file=sys.stderr)
            return 0
        return 0

    # --run
    flush_backlog(args.dry_run)
    first = True
    while True:
        try:
            do_sample("dayOpen" if first else "sample", args.dry_run)
            first = False
        except Exception as exc:
            print(f"[warn] poll failed: {exc}", file=sys.stderr)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
