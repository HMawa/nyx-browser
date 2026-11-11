<#
.SYNOPSIS
    Nyx full real-machine regression: A online switch / B exit-IP / C race / D purge.

.DESCRIPTION
    Drives the REAL app process purely over the local HTTP API (no UI automation, no
    sub-agent waiting loop). Every wait has a hard deadline; no unbounded polling.

    The baseline egress IPs are taken OUTSIDE the browser (plain PowerShell, direct vs.
    through the proxy the browser itself egresses on), so the browser never visits a
    page in normal mode and cannot contaminate the zero-residue check with its traffic.

    The proxy is Nyx's OWN built-in mihomo kernel (proxy-store defaults autoStart=true),
    so its mixed port is allocated dynamically at launch and MUST NOT be hard-coded.
    Port discovery order: kernel config.yaml mixed-port -> 7890-7910 loopback listener
    -> fallback 7897 (external Clash Verge, only when the kernel is off).

      Phase 0  realIp (direct, system proxy bypassed)
      Phase 1  launch project-local electron.exe, wait for a FRESH api-port.txt
      Phase 2  discover built-in kernel port -> reachability gate -> nodeIp (via proxy)
      A        POST /mode/switch private -> assert ok + mode=private
      B        navigate+extractText in PRIVATE mode -> proxyIp must equal nodeIp and differ
               from realIp; then load one cookie-writing site so the private partition has
               real data to purge
      C        15 rapid alternating switches -> success rate + final mode
      D        back to normal -> private partition gone, no cookies/storage/cache leftovers
      E        GET /mode/events -> buffer sanity

    Cleanup: kill ONLY electron processes whose ExecutablePath is this project's electron.exe.

.PARAMETER TimeoutSec
    Hard deadline (seconds) for the whole run. Default 150.
#>

[CmdletBinding()]
param(
    [int]$TimeoutSec = 150
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$StateDir    = Join-Path $env:APPDATA 'Nyx'
$PortFile    = Join-Path $StateDir 'api-port.txt'
$TokenFile   = Join-Path $StateDir 'api-token.txt'
$PrivPart    = Join-Path $StateDir 'Partitions\nyx-private'

$startedAt = Get-Date
$deadline  = $startedAt.AddSeconds($TimeoutSec)
$base = $null
$hdr  = $null

$r = [ordered]@{
    proxyReachable = $false
    kernelPort     = $null
    realIp         = ''
    nodeIp         = ''
    preKilled      = 0
    port           = $null
    A_switch       = ''
    B_proxyIp      = ''
    B_privIsolated = $null
    C_ok           = 0
    C_fail         = 0
    C_finalMode    = ''
    D_partitionGone = $null
    D_cookies      = $null
    D_indexedDb    = $null
    D_serviceWorker = $null
    D_localStorage = $null
    D_normalCookies = $null
    D_cacheTrace   = $null
    D_cacheFiles   = $null
    E_count        = $null
    E_types        = ''
    verdict        = [ordered]@{ A = 'N/A'; B = 'N/A'; C = 'N/A'; D = 'N/A' }
    notes          = ''
    killed         = 0
    elapsedSec     = $null
}

# ---------- helpers ----------
function Test-TcpPort {
    param([string]$H, [int]$P, [int]$TimeoutMs = 1200)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $a = $c.BeginConnect($H, $P, $null, $null)
        if (-not $a.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $c.EndConnect($a); return $true
    } catch { return $false } finally { try { $c.Close() } catch { } }
}

# Count files whose RAW BYTES contain any privacy-test domain. Existence-only checks
# are meaningless for Chromium (it pre-creates empty stores on session boot), so we
# scan CONTENT instead. Latin-1 (28591) maps every byte 1:1, so binary stores such as
# the SQLite cookies db or the leveldb/cache blobs can be searched without decoding.
function Get-PrivacyTrace {
    param([string]$Path, [string]$Pattern = 'baidu|ipify|ipinfo|ip-api|whatismyip')
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $items = @()
    if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
        $items = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
    } else {
        $items = @(Get-Item -LiteralPath $Path -Force)
    }
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    $hits = 0
    foreach ($f in $items) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            if ($latin1.GetString($bytes) -match $Pattern) { $hits++ }
        } catch { }
    }
    return $hits
}

function Get-ItemCount {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
        return @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    }
    return 1
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

function Get-IpInBrowser {
    $urls = @('https://api.ipify.org', 'https://ipinfo.io/ip')
    foreach ($u in $urls) {
        if ((Get-Date) -ge $deadline) { return '' }
        $nav = Invoke-Nyx -Method POST -Path '/action' -Body ('{"type":"navigate","params":{"url":"' + $u + '"}}') -TimeoutSec 15
        if ($nav.status -ne 200) { $r.notes += "|nav$($nav.status):$($nav.err)" ; continue }
        Start-Sleep -Seconds 3
        $txt = Invoke-Nyx -Method POST -Path '/action' -Body '{"type":"extractText","params":{"maxLength":500}}' -TimeoutSec 15
        $m = [regex]::Match($txt.body, '\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b')
        if ($m.Success) { return $m.Value }
    }
    return ''
}

# ---------- Phase 0: outside-the-browser baselines ----------
# NOTE: the Windows system proxy is often ON (Registry ProxyEnable=1 ->
# 127.0.0.1:7897) and PowerShell's Invoke-WebRequest honors it by default. A bare
# request would then silently tunnel through a proxy, making realIp == nodeIp and
# producing a FALSE 'B: FAIL'. Keep the baseline honest: bypass the system proxy
# with curl --noproxy (same approach as verify-bd-precise.ps1).
foreach ($u in @('https://api.ipify.org', 'https://ipinfo.io/ip')) {
    try {
        $out = & curl.exe -s --noproxy '*' --max-time 10 $u
        $m = [regex]::Match([string]$out, '^\s*(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$')
        if ($m.Success) { $r.realIp = $m.Groups[1].Value; break }
    } catch { }
}
if (-not $r.realIp) { $r.notes += '|directIp-fail' }

$r.preKilled = Kill-ProjectElectron

# ---------- Phase 1: launch ----------
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

    # ---------- Phase 2: discover the BUILT-IN kernel port ----------
    # The proxy is Nyx's own mihomo kernel; its mixed port is chosen at launch and
    # changes between runs, so it must be discovered, never assumed. Order:
    #   1) kernel-runtime/config.yaml -> mixed-port (the port the kernel really binds)
    #   2) loopback listener inside 7890-7910, excluding the API port itself
    #   3) fallback 7897 (external Clash Verge; only valid when the kernel is off)
    $proxyPort = $null
    $kernelCfg = Join-Path $StateDir 'proxy\kernel-runtime\config.yaml'
    $kernelDeadline = (Get-Date).AddSeconds(30)
    while (((Get-Date) -lt $kernelDeadline) -and (-not $proxyPort)) {
        if (Test-Path -LiteralPath $kernelCfg) {
            $hit = Select-String -LiteralPath $kernelCfg -Pattern '^\s*mixed-port\s*:\s*(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) {
                $cand = [int]$hit.Matches[0].Groups[1].Value
                if (($cand -ne $port) -and (Test-TcpPort -H '127.0.0.1' -P $cand)) { $proxyPort = $cand; break }
            }
        }
        $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -ge 7890 -and $_.LocalPort -le 7910 -and $_.LocalPort -ne $port })
        if ($listen.Count -gt 0) { $proxyPort = [int]$listen[0].LocalPort; break }
        if ($proc.HasExited) { throw ('Nyx exited while waiting for the kernel (ExitCode=' + $proc.ExitCode + ')') }
        Start-Sleep -Milliseconds 500
    }
    if (-not $proxyPort) {
        $proxyPort = 7897
        $r.notes += '|kernelPort-not-found-fallback-7897'
    }
    $r.kernelPort = $proxyPort
    $r.proxyReachable = Test-TcpPort -H '127.0.0.1' -P $proxyPort
    if (-not $r.proxyReachable) {
        throw ('proxy 127.0.0.1:' + $proxyPort + ' NOT reachable -> private mode cannot be entered')
    }

    # nodeIp baseline must be taken through the SAME port the browser egresses on
    try {
        $viaProxy = Invoke-WebRequest -Uri 'https://api.ipify.org' -Proxy ('http://127.0.0.1:' + $proxyPort) -UseBasicParsing -TimeoutSec 12
        $r.nodeIp = $viaProxy.Content.Trim()
    } catch { $r.notes += '|nodeIp-fail' }

    # ---------- A. online switch to private ----------
    $sw = Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"private"}'
    $r.A_switch = $sw.body
    $r.verdict.A = 'FAIL'
    if ($sw.status -eq 200 -and $sw.body -match '"ok"\s*:\s*true' -and $sw.body -match '"mode"\s*:\s*"private"') {
        $r.verdict.A = 'PASS'
    }
    Start-Sleep -Seconds 2

    # ---------- B. egress IP in private mode + isolation evidence ----------
    if ($r.verdict.A -eq 'PASS') {
        $r.B_proxyIp = Get-IpInBrowser
        $sameAsNode = ($r.nodeIp -ne '') -and ($r.B_proxyIp -eq $r.nodeIp)
        $diffFromReal = ($r.realIp -eq '') -or ($r.B_proxyIp -ne $r.realIp)
        if ($r.B_proxyIp -and $diffFromReal -and ($sameAsNode -or $r.nodeIp -eq '')) {
            $r.verdict.B = 'PASS'
        } else { $r.verdict.B = 'FAIL' }

        # one cookie-writing page so the private session actually holds data
        Invoke-Nyx -Method POST -Path '/action' -Body '{"type":"navigate","params":{"url":"https://www.baidu.com"}}' -TimeoutSec 15 | Out-Null
        Start-Sleep -Seconds 3
        # Isolation evidence, corrected: sessions.js declares the private partition as
        # 'nyx-private' WITHOUT the 'persist:' prefix, i.e. purely in-memory. The correct
        # evidence is therefore the ABSENCE of any on-disk private partition: a directory
        # appearing here would mean private traffic leaked onto disk.
        if (Test-Path -LiteralPath $PrivPart) {
            $r.B_privIsolated = $false
            $r.notes += '|privatePartitionON-DISK-unexpected'
        } else {
            $r.B_privIsolated = $true
        }
        if (-not $r.B_privIsolated) { $r.verdict.B = 'FAIL' }
    }

    # ---------- C. race: 15 rapid alternating switches ----------
    $flip = $true
    for ($i = 1; $i -le 15; $i++) {
        if ((Get-Date) -ge $deadline) { $r.notes += "|C-deadline@$i"; break }
        $flip = -not $flip
        $target = 'private'
        if ($flip) { $target = 'normal' }
        $res = Invoke-Nyx -Method POST -Path '/mode/switch' -Body ('{"mode":"' + $target + '"}') -TimeoutSec 10
        if ($res.status -eq 200) { $r.C_ok++ } else { $r.C_fail++ }
        Start-Sleep -Milliseconds 40
    }
    $st = Invoke-Nyx -Method GET -Path '/state'
    $mm = [regex]::Match($st.body, '"mode"\s*:\s*"(\w+)"')
    if ($mm.Success) { $r.C_finalMode = $mm.Groups[1].Value }
    if ($r.C_fail -eq 0 -and $st.status -eq 200) { $r.verdict.C = 'PASS' } else { $r.verdict.C = 'FAIL' }

    # ---------- D. purge: back to normal, then scan for residue ----------
    # NOTE: every check below is CONTENT-based, never "does the path exist". Chromium
    # pre-creates empty stores (cookies db, leveldb/IndexedDB dirs, cache blobs) as soon
    # as a session boots, so mere existence proves nothing - only real privacy-domain
    # bytes left on disk do. All counters are expected to be 0.
    Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"normal"}' | Out-Null
    Start-Sleep -Seconds 2

    $r.D_partitionGone = -not (Test-Path -LiteralPath $PrivPart)
    $r.D_cookies       = Get-PrivacyTrace (Join-Path $StateDir 'Network\Cookies')
    $r.D_indexedDb     = Get-PrivacyTrace (Join-Path $StateDir 'IndexedDB')
    $r.D_serviceWorker = Get-PrivacyTrace (Join-Path $StateDir 'Service Worker')
    $r.D_localStorage  = Get-PrivacyTrace (Join-Path $StateDir 'Local Storage')
    # strongest isolation signal: nothing leaked into the PERSISTENT normal partition
    $r.D_normalCookies = Get-PrivacyTrace (Join-Path $StateDir 'Partitions\nyx-normal\Network\Cookies')
    $r.D_cacheTrace    = Get-PrivacyTrace (Join-Path $StateDir 'Cache\Cache_Data')
    $r.D_cacheFiles    = Get-ItemCount (Join-Path $StateDir 'Cache\Cache_Data')

    $clean = ($r.D_partitionGone -eq $true) -and ($r.D_cookies -eq 0) -and ($r.D_indexedDb -eq 0) -and
             ($r.D_serviceWorker -eq 0) -and ($r.D_localStorage -eq 0) -and ($r.D_normalCookies -eq 0) -and
             ($r.D_cacheTrace -eq 0)
    $r.verdict.D = if ($clean) { 'PASS' } else { 'FAIL' }

    # ---------- E. events ----------
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
