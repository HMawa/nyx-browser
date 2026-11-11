<#
.SYNOPSIS
    Nyx /mode/switch + /mode/events real-machine verification (hard-timeout, proxy-free).

.DESCRIPTION
    One-shot verification of the mode-event link on the REAL app process:
      1. Launch Nyx (project-local electron.exe only).
      2. Wait for a FRESH api-port.txt (mtime newer than launch) with a hard deadline.
      3. POST /mode/switch {"mode":"normal"}  -- succeeds or fails, both paths record an event.
         'normal' is chosen on purpose: it needs no proxy, so this test never touches Clash.
      4. GET /mode/events and assert count >= 1.
      5. Cleanup: kill ONLY electron processes whose ExecutablePath is this project's electron.exe.

    Global hard deadline (default 90s). No retry loops, no polling beyond the deadline.

.PARAMETER TimeoutSec
    Hard deadline in seconds for the whole run. Default 90.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-mode-api.ps1
#>

[CmdletBinding()]
param(
    [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Continue'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$StateDir    = Join-Path $env:APPDATA 'Nyx'
$PortFile    = Join-Path $StateDir 'api-port.txt'
$TokenFile   = Join-Path $StateDir 'api-token.txt'
$ModeFile    = Join-Path $StateDir 'last-mode.txt'

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$launchedAt = Get-Date

$result = [ordered]@{
    launched        = $false
    electronExists  = (Test-Path -LiteralPath $ElectronExe)
    lastModeBefore  = ''
    port            = $null
    switchStatus    = $null
    switchBody      = ''
    eventsStatus    = $null
    eventsCount     = $null
    eventsBody      = ''
    verdict         = 'UNKNOWN'
    reason          = ''
    elapsedSec      = $null
}

if (-not $result.electronExists) {
    $result.verdict = 'FAIL'
    $result.reason = 'electron.exe not found: ' + $ElectronExe
    $result | ConvertTo-Json -Depth 5
    exit 1
}

if (Test-Path -LiteralPath $ModeFile) {
    try { $result.lastModeBefore = (Get-Content -LiteralPath $ModeFile -Raw).Trim() } catch { }
}

$proc = $null

try {
    # --- 1. launch ---
    $proc = Start-Process -FilePath $ElectronExe -ArgumentList '.' -WorkingDirectory $ProjectRoot -PassThru
    $result.launched = $true

    # --- 2. wait for a FRESH port file (hard deadline) ---
    $port = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $PortFile) {
            $item = Get-Item -LiteralPath $PortFile
            if ($item.LastWriteTime -gt $launchedAt) {
                $raw = (Get-Content -LiteralPath $PortFile -Raw).Trim()
                if ($raw) { $port = [int]$raw; break }
            }
        }
        if ($proc.HasExited) {
            throw ('Nyx exited early, ExitCode=' + $proc.ExitCode)
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $port) { throw ('hard timeout waiting for fresh api-port.txt (' + $TimeoutSec + 's)') }
    $result.port = $port

    $token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    $headers = @{ 'x-nyx-token' = $token }

    # --- 3. one switch request (normal -> no proxy needed) ---
    try {
        $sw = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/mode/switch') -Method POST `
            -Body '{"mode":"normal"}' -ContentType 'application/json' -Headers $headers `
            -UseBasicParsing -TimeoutSec 10
        $result.switchStatus = [int]$sw.StatusCode
        $result.switchBody = $sw.Content
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $sr = New-Object IO.StreamReader($resp.GetResponseStream())
            $result.switchStatus = [int]$resp.StatusCode
            $result.switchBody = $sr.ReadToEnd()
        } else {
            $result.switchStatus = -1
            $result.switchBody = $_.Exception.Message
        }
    }

    # --- 4. read the event buffer: the core assertion ---
    try {
        $ev = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/mode/events') -Method GET `
            -Headers $headers -UseBasicParsing -TimeoutSec 10
        $result.eventsStatus = [int]$ev.StatusCode
        $result.eventsBody = $ev.Content
        $obj = $ev.Content | ConvertFrom-Json
        $result.eventsCount = [int]$obj.count
        if ($result.eventsCount -ge 1) {
            $result.verdict = 'PASS'
            $result.reason = 'event buffer written and readable, count=' + $result.eventsCount
        } else {
            $result.verdict = 'FAIL'
            $result.reason = 'endpoint reachable but event buffer EMPTY - write path not effective'
        }
    } catch {
        $result.eventsStatus = -1
        $result.reason = 'GET /mode/events failed: ' + $_.Exception.Message
        $result.verdict = 'FAIL'
    }
} catch {
    $result.verdict = 'FAIL'
    $result.reason = $_.Exception.Message
} finally {
    # --- 5. cleanup: project-local electron.exe only ---
    $killed = 0
    $cims = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue)
    foreach ($c in $cims) {
        if ($c.ExecutablePath -and ($c.ExecutablePath.Trim() -ieq $ElectronExe)) {
            try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }
        }
    }
    if ($killed -gt 0) { Start-Sleep -Milliseconds 600 }
    $result.elapsedSec = [math]::Round(((Get-Date) - $launchedAt).TotalSeconds, 1)
    $result['killedProcesses'] = $killed
}

$result | ConvertTo-Json -Depth 5
exit 0
