<#
    rotate-tokens.ps1
    -----------------
    Cloudflare secrets are write-only - `wrangler secret list` shows names, never
    values. If a token is lost, the only recovery is to replace it.

    What each rotation affects:

      INGEST_TOKEN    used by the LAN agent and by manual POST /api/poll calls.
                      Update the agent afterwards (setup-agent.ps1 -SetToken).

      CONTROL_TOKEN   unlocks /control and POST /api/test-alert. Anyone holding
                      the old value loses access. Until it exists at all, every
                      control request is refused - the safe default.

      MONITOR_TOKEN   password for the optional page gate (MONITOR_GATE = "on").
                      Everyone who opens the dashboard must use the new value.

    Usage
      .\rotate-tokens.ps1 -Ingest
      .\rotate-tokens.ps1 -Control
      .\rotate-tokens.ps1 -Monitor
      .\rotate-tokens.ps1 -Ingest -Control          # any combination

    New values are written to .tokens.local.txt (git-ignored), not printed to
    the console, so they do not end up in terminal scrollback.
#>

[CmdletBinding()]
param(
    [switch]$Ingest,
    [switch]$Control,
    [switch]$Monitor,
    [string]$Wrangler = "npx"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $Ingest -and -not $Control -and -not $Monitor) {
    Write-Host "Nothing to do. Pass -Ingest, -Control and/or -Monitor." -ForegroundColor Yellow
    Write-Host "  -Ingest   the LAN agent needs the new value afterwards."
    Write-Host "  -Control  mints the device-control token. Until it exists, every"
    Write-Host "            control request is refused - which is the safe default."
    Write-Host "  -Monitor  password for the optional page gate.`n"
    exit 1
}

function New-Token {
    $b = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return (([Convert]::ToBase64String($b) -replace '[+/=]', '') + "xxxxxxxx").Substring(0, 28)
}

function Set-WorkerSecret([string]$Name, [string]$Value) {
    # The Worker trims secrets before comparing, so the line ending PowerShell
    # adds when piping is harmless.
    if ($Wrangler -eq "npx") { $Value | npx wrangler secret put $Name | Out-Null }
    else { $Value | & $Wrangler secret put $Name | Out-Null }
    if ($LASTEXITCODE -ne 0) { throw "wrangler secret put $Name failed" }
}

$file = Join-Path $PSScriptRoot ".tokens.local.txt"
$existing = @{}
if (Test-Path $file) {
    foreach ($line in Get-Content $file) {
        if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+)$') { $existing[$Matches[1]] = $Matches[2].Trim() }
    }
}

if ($Ingest) {
    $t = New-Token
    Set-WorkerSecret "INGEST_TOKEN" $t
    $existing["INGEST_TOKEN"] = $t
    Write-Host "  INGEST_TOKEN rotated - update the LAN agent (setup-agent.ps1 -SetToken)" -ForegroundColor Green
}

if ($Control) {
    $t = New-Token
    Set-WorkerSecret "CONTROL_TOKEN" $t
    $existing["CONTROL_TOKEN"] = $t
    Write-Host "  CONTROL_TOKEN set - device control is now possible with the new value" -ForegroundColor Green
    Write-Host "  (DC output stays locked unless ALLOW_DC_CONTROL is true in wrangler.toml)" -ForegroundColor Yellow
}

if ($Monitor) {
    $t = New-Token
    Set-WorkerSecret "MONITOR_TOKEN" $t
    $existing["MONITOR_TOKEN"] = $t
    Write-Host "  MONITOR_TOKEN rotated - the page gate now enforces it" -ForegroundColor Green
}

($existing.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) |
    Set-Content $file -Encoding utf8

Write-Host "`nWritten to: $file`n" -ForegroundColor Green
