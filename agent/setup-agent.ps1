<#
    setup-agent.ps1
    ---------------
    Registers the optional Solar LAN agent (solar_agent.py) with Windows Task
    Scheduler and, optionally, stores the Worker's ingest token encrypted at rest.

    Runs as the current user - no administrator rights needed. The tasks run
    only while you are logged in.

    Two daily tasks are created:
      "Solar Agent - Morning"   python solar_agent.py --once    (default 08:00)
      "Solar Agent - Day Close" python solar_agent.py --close   (default 18:00)

    Both are DAILY triggers (not one-time), and both carry the two settings that
    matter most and are easy to lose when recreating tasks by hand:
      DisallowStartIfOnBatteries = false   the schtasks default is true, which
                                           silently skips every run while a
                                           laptop is unplugged
      StartWhenAvailable         = true    a run missed because the machine was
                                           off or asleep fires when it is next
                                           available, instead of losing the day

    Usage
      .\setup-agent.ps1 -IngestUrl https://solar.example.com/api/ingest
      .\setup-agent.ps1 -SetToken       # prompt for INGEST_TOKEN, store it encrypted
      .\setup-agent.ps1 -Status         # show tasks, their settings, and the spool
      .\setup-agent.ps1 -Remove         # unregister everything
#>

[CmdletBinding()]
param(
    [switch]$SetToken,
    [switch]$Remove,
    [switch]$Status,
    [string]$IngestUrl,
    [string]$Python,                    # path to python.exe; found on PATH if omitted
    [string]$MorningTime = "08:00",
    [string]$CloseTime   = "18:00"
)

$ErrorActionPreference = "Stop"

$Agent = Join-Path $PSScriptRoot "solar_agent.py"
$Spool = if ($env:SOLAR_SPOOL_DIR) { $env:SOLAR_SPOOL_DIR } else { Join-Path $env:USERPROFILE ".solar-agent" }
$TokenFile = Join-Path $Spool "ingest-token.dpapi"

$TaskMorning = "Solar Agent - Morning"
$TaskClose   = "Solar Agent - Day Close"

function Resolve-Python {
    if ($Python) { return $Python }
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "python.exe not found on PATH. Pass -Python C:\path\to\python.exe" }
    if ($cmd.Source -like "*WindowsApps*") {
        throw "Found the Microsoft Store python alias, not a real install. Install Python from python.org or pass -Python."
    }
    return $cmd.Source
}

function Escape-Xml([string]$s) { [Security.SecurityElement]::Escape($s) }

# Task XML rather than schtasks flags: schtasks cannot set the battery and
# start-when-available settings, and Register-ScheduledTask writes to the root
# task folder, which is refused without elevation. `schtasks /create /xml`
# creates the same task in the current user's context without admin.
function New-TaskXml([string]$exe, [string]$arguments, [string]$time, [string]$description) {
    $start = "2026-01-01T{0}:00" -f ([datetime]::Parse($time)).ToString("HH:mm")
    $user  = "$env:USERDOMAIN\$env:USERNAME"
@"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$(Escape-Xml $description)</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Escape-Xml $user)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $exe)</Command>
      <Arguments>$(Escape-Xml $arguments)</Arguments>
      <WorkingDirectory>$(Escape-Xml $PSScriptRoot)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Register-AgentTask([string]$name, [string]$exe, [string]$arguments, [string]$time, [string]$description) {
    $xmlPath = Join-Path $env:TEMP ("solar-agent-task-{0}.xml" -f [guid]::NewGuid())
    try {
        # schtasks expects the XML in UTF-16, matching the declaration above.
        New-TaskXml $exe $arguments $time $description | Set-Content -Path $xmlPath -Encoding Unicode
        schtasks /create /tn $name /xml $xmlPath /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not register $name" }
    } finally {
        Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- status ----
if ($Status) {
    "=== Scheduled tasks ==="
    foreach ($n in @($TaskMorning, $TaskClose)) {
        $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        if ($t) {
            $i = Get-ScheduledTaskInfo -TaskName $n
            "{0,-24} {1,-8} last: {2}  result: {3}  next: {4}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime
            # Show the two settings that matter, so a hand-edited task that lost
            # them is obvious.
            "    DisallowStartIfOnBatteries = {0}   (want False)" -f $t.Settings.DisallowStartIfOnBatteries
            "    StartWhenAvailable         = {0}   (want True)"  -f $t.Settings.StartWhenAvailable
        } else {
            "{0,-24} NOT REGISTERED" -f $n
        }
    }

    "`n=== Spool ($Spool) ==="
    if (Test-Path $Spool) {
        $days = Get-ChildItem $Spool -Filter *.jsonl -ErrorAction SilentlyContinue
        if ($days) {
            foreach ($d in $days | Sort-Object Name) {
                $lines = (Get-Content $d.FullName | Measure-Object -Line).Lines
                "{0}  {1,5} records  {2,8:N0} bytes" -f $d.BaseName, $lines, $d.Length
            }
        } else { "no data collected yet" }
        $sent = Join-Path $Spool "sent.txt"
        $ack  = if (Test-Path $sent) { (Get-Content $sent | Measure-Object -Line).Lines } else { 0 }
        "acknowledged by the Worker: $ack"
        "ingest token: " + $(if (Test-Path $TokenFile) { "stored (encrypted)" } else { "not stored - falls back to SOLAR_INGEST_TOKEN" })
    } else { "spool not created yet" }

    "`n=== Endpoint ==="
    $u = [Environment]::GetEnvironmentVariable("SOLAR_INGEST_URL", "User")
    "SOLAR_INGEST_URL = " + $(if ($u) { $u } else { "(unset - agent will print payloads instead of sending)" })
    return
}

# ---------------------------------------------------------------- remove ----
if ($Remove) {
    # No scheduled tasks, no environment variable, no stored token. Collected
    # history is left alone.
    foreach ($n in @($TaskMorning, $TaskClose)) {
        schtasks /delete /tn $n /f 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { "removed task: $n" } else { "not registered: $n" }
    }
    if ([Environment]::GetEnvironmentVariable("SOLAR_INGEST_URL", "User")) {
        [Environment]::SetEnvironmentVariable("SOLAR_INGEST_URL", $null, "User")
        "cleared: SOLAR_INGEST_URL (user scope)"
    }
    if (Test-Path $TokenFile) {
        Remove-Item $TokenFile -Force
        "removed: stored ingest token"
    }
    ""
    "The agent no longer runs. The Cloudflare Worker keeps collecting from the"
    "vendor cloud, so telemetry continues - /api/health will simply report"
    "localPolling.active = false."
    ""
    "History kept at $Spool (delete it by hand if you want it gone)."
    return
}

# ------------------------------------------------------------- set token ----
if ($SetToken) {
    New-Item -ItemType Directory -Force -Path $Spool | Out-Null
    Write-Host "Paste the Worker's INGEST_TOKEN. It is encrypted immediately and"
    Write-Host "never written anywhere in plain text."
    $sec = Read-Host -AsSecureString "INGEST_TOKEN"
    if (-not $sec -or $sec.Length -eq 0) { throw "No token entered." }
    # DPAPI, scoped to this Windows account on this machine.
    ConvertFrom-SecureString $sec | Set-Content $TokenFile -Encoding ascii
    "Token stored encrypted at $TokenFile"
    "A copy of that file is useless on any other machine or account."
    return
}

# ------------------------------------------------------------- register -----
$py = Resolve-Python
if (-not (Test-Path $Agent)) { throw "Agent not found at $Agent" }
# pythonw.exe runs without a console window; the agent logs to its spool
# folder when it has no console.
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
$exe = if (Test-Path $pyw) { $pyw } else { $py }
New-Item -ItemType Directory -Force -Path $Spool | Out-Null

if ($IngestUrl) {
    [Environment]::SetEnvironmentVariable("SOLAR_INGEST_URL", $IngestUrl, "User")
    "SOLAR_INGEST_URL set to $IngestUrl (user scope)"
}

Register-AgentTask $TaskMorning $exe "`"$Agent`" --once" $MorningTime "Solar LAN agent: morning reading (overnight state)"
"registered: $TaskMorning  (daily at $MorningTime)"

Register-AgentTask $TaskClose $exe "`"$Agent`" --close" $CloseTime "Solar LAN agent: end-of-day reading and rollup"
"registered: $TaskClose  (daily at $CloseTime)"

""
"The tasks point at $Agent by absolute path. If you move this folder, run"
"this script again from the new location."
""
"Next:"
"  1. pecron-monitor --setup               (one-time, needs your Pecron login)"
"  2. python `"$Agent`" --once --dry-run   (check a reading prints)"
"  3. .\setup-agent.ps1 -SetToken           (store INGEST_TOKEN encrypted)"
"  4. .\setup-agent.ps1 -Status             (check the tasks and collection)"
