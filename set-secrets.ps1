<#
    set-secrets.ps1
    ---------------
    Sets the Worker's secrets in one go. Run it yourself from this folder after
    `npx wrangler login`; values are prompted for and never echoed.

      PECRON_EMAIL                 your Pecron app account email
      PECRON_PASSWORD              prompted, never echoed
      PECRON_SECRET_<REGION>       vendor signing secret for PECRON_REGION
                                   (see docs/SETUP.md for where to find it)
      CONTROL_TOKEN, INGEST_TOKEN  generated here with a cryptographic RNG
      MAILGUN_API_KEY              optional; press Enter to skip

    The generated tokens are written to .tokens.local.txt (git-ignored), not
    printed, so they do not end up in terminal scrollback.

    Usage:  .\set-secrets.ps1 [-Region US|EU|CN] [-Wrangler <path to wrangler>]

    Values set this way take effect immediately. A secret set in the Cloudflare
    dashboard instead needs a redeploy before the running Worker sees it.
#>

param(
    [ValidateSet("US", "EU", "CN")][string]$Region = "US",
    [string]$Wrangler = "npx"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Invoke-Wrangler([string[]]$WranglerArgs, [string]$Value) {
    # Piping into a native command appends a line ending, which wrangler
    # stores as part of the secret. The Worker strips trailing whitespace from
    # every secret before using it, so this is harmless - but it is why that
    # trimming must never be removed.
    if ($Wrangler -eq "npx") { $exe = "npx"; $all = @("wrangler") + $WranglerArgs }
    else { $exe = $Wrangler; $all = $WranglerArgs }
    $Value | & $exe @all | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "wrangler $($WranglerArgs -join ' ') failed" }
}

function Read-Secret([string]$Prompt) {
    $sec = Read-Host -AsSecureString $Prompt
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function New-Token {
    $b = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return (([Convert]::ToBase64String($b) -replace '[+/=]', '') + "xxxxxxxx").Substring(0, 28)
}

Write-Host "`npecron-solar-dashboard - Worker secrets (region $Region)`n" -ForegroundColor Cyan

$email = Read-Host "PECRON_EMAIL (your Pecron app login)"
if (-not $email) { throw "No email entered." }
$password = Read-Secret "PECRON_PASSWORD"
if (-not $password) { throw "No password entered." }
$signing = Read-Secret "PECRON_SECRET_$Region"
if (-not $signing) { throw "No signing secret entered." }
$mailgun = Read-Secret "MAILGUN_API_KEY (optional, Enter to skip)"

$control = New-Token
$ingest  = New-Token

Write-Host "`nUploading..." -ForegroundColor Cyan
Invoke-Wrangler @("secret", "put", "PECRON_EMAIL")          $email.Trim(); Write-Host "  PECRON_EMAIL           set"
Invoke-Wrangler @("secret", "put", "PECRON_PASSWORD")       $password;     Write-Host "  PECRON_PASSWORD        set"
Invoke-Wrangler @("secret", "put", "PECRON_SECRET_$Region") $signing.Trim(); Write-Host "  PECRON_SECRET_$Region      set"
Invoke-Wrangler @("secret", "put", "CONTROL_TOKEN")         $control;      Write-Host "  CONTROL_TOKEN          set"
Invoke-Wrangler @("secret", "put", "INGEST_TOKEN")          $ingest;       Write-Host "  INGEST_TOKEN           set"
if ($mailgun) {
    Invoke-Wrangler @("secret", "put", "MAILGUN_API_KEY") $mailgun.Trim(); Write-Host "  MAILGUN_API_KEY        set"
} else {
    Write-Host "  MAILGUN_API_KEY        skipped (email alerts stay off)"
}

$password = $null; $signing = $null; $mailgun = $null
[GC]::Collect()

# Written to a local, git-ignored file rather than the console. Keep it private.
$out = Join-Path $PSScriptRoot ".tokens.local.txt"
@"
CONTROL_TOKEN=$control
INGEST_TOKEN=$ingest
"@ | Set-Content $out -Encoding utf8

Write-Host "`nTokens written to: $out" -ForegroundColor Green
Write-Host "CONTROL_TOKEN unlocks /control and POST /api/test-alert."
Write-Host "INGEST_TOKEN is what the LAN agent (and manual POST /api/poll) sends."
Write-Host "Cloudflare secrets are write-only: keep that file safe, or rotate with .\rotate-tokens.ps1.`n"
