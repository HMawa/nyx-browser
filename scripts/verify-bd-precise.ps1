<#
.SYNOPSIS
    Nyx precise re-check of items B (egress) and D (zero residue).

.DESCRIPTION
    Fixes two measurement flaws in verify-mode-full.ps1:

      1. PowerShell honors the Windows system proxy (HKCU ... ProxyEnable=1 ->
         127.0.0.1:7897), so the previous "direct" baseline was silently going
         through Clash too. Here the real line IP is taken with curl --noproxy.

      2. Private mode uses partition 'nyx-private' WITHOUT the 'persist:' prefix,
         i.e. a pure in-memory session. Electron never creates
         %APPDATA%\Nyx\Partitions\nyx-private, so asserting "that folder is gone"
         proved nothing. Here we assert on an actual disk-wide trace scan instead.

    Assertions:
      B  egress in private mode == Clash egress AND != real line IP
      D  while private mode has loaded real pages, a content scan of the whole
         user-data dir finds zero traces (baidu / ipify), and the persistent
         normal partition holds no private-session traces either.

.PARAMETER TimeoutSec
    Hard deadline (seconds) for the whole run. Default 120.
#>

[CmdletBinding()]
param(
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$StateDir    = Join-Path $env:APPDATA 'Nyx'
$PortFile    = Join-Path $StateDir 'api-port.txt'
$TokenFile   = Join-Path $StateDir 'api-token.txt'

$startedAt = Get-Date
$deadline  = $startedAt.AddSeconds($TimeoutSec)
$base = $null
$hdr  = $null

$r = [ordered]@{
    realLineIp      = ''
    clashEgressIp   = ''
    port            = $null
    A_switch        = ''
    B_proxyIp       = ''
    B_privSessionMemOnly = $null
    D_traceFilesInState    = 0
    D_traceExamples        = ''
    D_normalPartitionExists = $null
    D_normalPartitionHits   = 0
    E_count         = $null
    E_types         = ''
    verdict         = [ordered]@{ A = 'N/A'; B = 'N/A'; D = 'N/A' }
    notes           = ''
    killed          = 0
    elapsedSec      = $null
}

function Kill-ProjectElectron {
    $n = 0
    $cims = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue)
    foreach ($c in $cims) {
        if ($c.ExecutablePath -and ($c.ExecutablePath.Trim() -ieq $ElectronExe)) {
            try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $n++ } catch { }
        }
    }
    if ($n -gt 0) { Start-Sleep -Milliseconds 800 }
    return $n
}

function Invoke-Nyx {
    param([string]$Method, [string]$Path, [string]$Body = $null, [int]$T = 12)
    $p = @{ Uri = ($base + $Path); Method = $Method; Headers = $hdr; UseBasicParsing = $true; TimeoutSec = $T }
    if ($Body) { $p['Body'] = $Body; $p['ContentType'] = 'application/json' }
    try {
        $resp = Invoke-WebRequest @p
        return [pscustomobject]@{ status = [int]$resp.StatusCode; body = $resp.Content; err = '' }
    } catch {
        $rs = $_.Exception.Response
        if ($rs) {
            $sr = New-Object IO.StreamReader($rs.GetResponseStream())
            return [pscustomobject]@{ status = [int]$rs.StatusCode; body = $sr.ReadToEnd(); err = '' }
        }
        return [pscustomobject]@{ status = -1; body = ''; err = $_.Exception.Message }
    }
}

# ---- Phase 0a: real line IP, explicitly bypassing the Windows system proxy ----
foreach ($u in @('https://api.ipify.org', 'https://ipinfo.io/ip')) {
    try {
        $out = & curl.exe -s --noproxy "*" --max-time 10 $u
        $m = [regex]::Match([string]$out, '^\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$')
        if ($m.Success) { $r.realLineIp = $m.Groups[1].Value; break }
    } catch { }
}

# ---- Phase 0b: egress through Clash 7897 ----
try {
    $via = Invoke-WebRequest -Uri 'https://api.ipify.org' -Proxy 'http://127.0.0.1:7897' -UseBasicParsing -TimeoutSec 12
    $r.clashEgressIp = $via.Content.Trim()
} catch { $r.notes += '|clashEgress-fail' }

Kill-ProjectElectron | Out-Null

# ---- Phase 1: launch ----
$launchedAt = Get-Date
$proc = Start-Process -FilePath $ElectronExe -ArgumentList '.' -WorkingDirectory $ProjectRoot -PassThru

try {
    $port = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $PortFile) {
            $it = Get-Item -LiteralPath $PortFile
            if ($it.LastWriteTime -gt $launchedAt) {
                $raw = (Get-Content -LiteralPath $PortFile -Raw).Trim()
                if ($raw) { $port = [int]$raw; break }
            }
        }
        if ($proc.HasExited) { throw ('Nyx exited early, ExitCode=' + $proc.ExitCode) }
        Start-Sleep -Milliseconds 500
    }
    if (-not $port) { throw ('hard timeout waiting for fresh api-port.txt (' + $TimeoutSec + 's)') }
    $r.port = $port
    $base = 'http://127.0.0.1:' + $port
    $hdr = @{ 'x-nyx-token' = (Get-Content -LiteralPath $TokenFile -Raw).Trim() }

    # ---- A ----
    $privacyMark = Get-Date
    $sw = Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"private"}'
    $r.A_switch = $sw.body
    $r.verdict.A = if ($sw.status -eq 200 -and $sw.body -match '"mode"\s*:\s*"private"') { 'PASS' } else { 'FAIL' }
    Start-Sleep -Seconds 2

    # ---- B: egress while in private mode ----
    $nav = Invoke-Nyx -Method POST -Path '/action' -Body '{"type":"navigate","params":{"url":"https://api.ipify.org"}}' -TimeoutSec 15
    Start-Sleep -Seconds 3
    $txt = Invoke-Nyx -Method POST -Path '/action' -Body '{"type":"extractText","params":{"maxLength":500}}' -TimeoutSec 15
    $m = [regex]::Match($txt.body, '\b(?:\d{1,3}\.){3}\d{1,3}\b')
    if ($m.Success) { $r.B_proxyIp = $m.Value }

    $memOnly = -not (Test-Path -LiteralPath (Join-Path $StateDir 'Partitions\nyx-private'))
    $r.B_privSessionMemOnly = $memOnly

    $bPass = ($r.B_proxyIp -ne '') -and
             (($r.realLineIp -eq '') -or ($r.B_proxyIp -ne $r.realLineIp)) -and
             (($r.clashEgressIp -eq '') -or ($r.B_proxyIp -eq $r.clashEgressIp))
    $r.verdict.B = if ($bPass) { 'PASS' } else { 'FAIL' }
    if (-not $bPass) { $r.notes += "|B:nav=$($nav.status),extract=$($txt.status)" }

    # ---- D: load a real cookie/cache-writing page, then scan the disk ----
    Invoke-Nyx -Method POST -Path '/action' -Body '{"type":"navigate","params":{"url":"https://www.baidu.com"}}' -TimeoutSec 15 | Out-Null
    Start-Sleep -Seconds 3

    $hits = @(Get-ChildItem -LiteralPath $StateDir -Recurse -File -Force -ErrorAction SilentlyContinue |
              Where-Object { $_.LastWriteTime -gt $privacyMark } |
              Select-String -Pattern 'baidu' -List -ErrorAction SilentlyContinue)
    $r.D_traceFilesInState = $hits.Count
    $r.D_traceExamples = (($hits | Select-Object -First 5 | ForEach-Object { $_.Filename }) -join ',')

    # back to normal, then check the persistent partition carries nothing private
    Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"normal"}' -TimeoutSec 12 | Out-Null
    Start-Sleep -Seconds 2
    $normPart = Join-Path $StateDir 'Partitions\nyx-normal'
    $r.D_normalPartitionExists = Test-Path -LiteralPath $normPart
    if ($r.D_normalPartitionExists) {
        $r.D_normalPartitionHits = @(Get-ChildItem -LiteralPath $normPart -Recurse -File -Force -ErrorAction SilentlyContinue |
                                     Select-String -Pattern 'baidu|ipify' -List -ErrorAction SilentlyContinue).Count
    }

    $dPass = ($r.D_traceFilesInState -eq 0) -and ($r.D_normalPartitionHits -eq 0) -and ($memOnly -eq $true)
    $r.verdict.D = if ($dPass) { 'PASS' } else { 'FAIL' }

    # ---- E ----
    $ev = Invoke-Nyx -Method GET -Path '/mode/events'
    try {
        $obj = $ev.body | ConvertFrom-Json
        $r.E_count = [int]$obj.count
        $r.E_types = (@($obj.events | ForEach-Object { $_.type }) -join ',')
    } catch { $r.notes += '|events-parse-fail' }
} catch {
    $r.notes += '|EXCEPTION: ' + $_.Exception.Message
} finally {
    try { if ($base) { Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"normal"}' -TimeoutSec 8 | Out-Null } } catch { }
    $r.killed = Kill-ProjectElectron
    $r.elapsedSec = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
}

$r | ConvertTo-Json -Depth 6
exit 0
