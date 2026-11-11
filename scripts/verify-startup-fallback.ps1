<#
.SYNOPSIS
    Nyx 启动回落验证（待办 #4）：上次退出为 private + 代理不可达时，启动必须回落 normal。

.DESCRIPTION
    纯 API + 文件断言，全程硬超时。本测试的前提恰恰是「代理不在线」：
    若探测到 127.0.0.1:7897 可达，说明前提不成立，脚本直接 SKIP 退出，不做任何断言。

    断言点：
      T1  last-mode.txt 落盘被改写为 normal（持久化回落）
      T2  主进程输出出现「已回落」标记（控制台可捕获时才判定，否则记 N/A）
      T3  GET /state -> mode == normal（运行时内存态同样回落）
      T4  GET /mode/events -> 存在 startup 事件 {from:private, to:normal, changed:true, ok:false, code:PROXY_UNREACHABLE}

    清理：仅结束 ExecutablePath 精确等于本项目 electron.exe 的进程，不碰其他 Electron 应用。

.PARAMETER TimeoutSec
    整体硬超时（秒），默认 90。

.PARAMETER LogDir
    子进程 stdout/stderr 重定向目录，默认 <项目根>\temp\startup-fallback。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-startup-fallback.ps1
#>

[CmdletBinding()]
param(
    [int]$TimeoutSec = 90,
    [string]$LogDir = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$StateDir    = Join-Path $env:APPDATA 'Nyx'
$PortFile    = Join-Path $StateDir 'api-port.txt'
$TokenFile   = Join-Path $StateDir 'api-token.txt'
$ModeFile    = Join-Path $StateDir 'last-mode.txt'

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $ProjectRoot 'temp\startup-fallback'
}

$startedAt = Get-Date
$deadline  = $startedAt.AddSeconds($TimeoutSec)
$base = ''
$hdr  = @{}

# 用 Unicode 转义匹配日志里的中文标记，规避脚本文件编码差异导致的字面量错配
$FALLBACK_MARK = '\u5df2\u56de\u843d'

$r = [ordered]@{
    proxyReachable = $null
    lastModeBefore = ''
    port           = $null
    lastModeAfter  = ''
    stateMode      = ''
    eventCount     = $null
    startupEvent   = ''
    logCaptured    = $false
    logHit         = $null
    verdict        = [ordered]@{ T1 = 'N/A'; T2 = 'N/A'; T3 = 'N/A'; T4 = 'N/A' }
    overall        = 'UNKNOWN'
    notes          = ''
    killed         = 0
    elapsedSec     = $null
}

# ---------------------------- helpers ----------------------------

function Test-TcpPort {
    param([string]$H, [int]$P, [int]$TimeoutMs = 1200)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $a = $c.BeginConnect($H, $P, $null, $null)
        if (-not $a.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $c.EndConnect($a)
        return $true
    } catch {
        return $false
    } finally {
        try { $c.Close() } catch { }
    }
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
    param([string]$Method, [string]$Path)
    $p = @{ Uri = ($base + $Path); Method = $Method; Headers = $hdr; UseBasicParsing = $true; TimeoutSec = 12 }
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

# ---------------------------- Phase 0: precondition ----------------------------

$r.proxyReachable = Test-TcpPort -H '127.0.0.1' -P 7897
if ($r.proxyReachable) {
    $r.overall = 'SKIP'
    $r.notes = 'proxy 127.0.0.1:7897 is UP -> precondition violated (needs proxy DOWN); no assertion performed'
    $r | ConvertTo-Json -Depth 6
    exit 0
}

if (-not (Test-Path -LiteralPath $ElectronExe)) {
    $r.overall = 'FAIL'
    $r.notes = 'electron.exe not found: ' + $ElectronExe
    $r | ConvertTo-Json -Depth 6
    exit 1
}

# ---------------------------- Phase 1: plant last-mode=private ----------------------------

$r.killed = Kill-ProjectElectron
try {
    Set-Content -LiteralPath $ModeFile -Value 'private' -NoNewline -Encoding ASCII -ErrorAction Stop
    $r.lastModeBefore = (Get-Content -LiteralPath $ModeFile -Raw).Trim()
} catch {
    $r.notes += '|plant-fail:' + $_.Exception.Message
}

# ---------------------------- Phase 2: launch ----------------------------

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$outLog = Join-Path $LogDir 'stdout.log'
$errLog = Join-Path $LogDir 'stderr.log'
Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

$launchedAt = Get-Date
$proc = Start-Process -FilePath $ElectronExe -ArgumentList '.' -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

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
        Start-Sleep -Milliseconds 400
    }
    if (-not $port) { throw ('hard timeout waiting for fresh api-port.txt (' + $TimeoutSec + 's)') }
    $r.port = $port
    $base = 'http://127.0.0.1:' + $port
    $hdr = @{ 'x-nyx-token' = (Get-Content -LiteralPath $TokenFile -Raw).Trim() }

    Start-Sleep -Seconds 2

    # -------- T1: 磁盘持久化回落 --------
    $r.lastModeAfter = (Get-Content -LiteralPath $ModeFile -Raw).Trim()
    if ($r.lastModeAfter -eq 'normal') { $r.verdict.T1 = 'PASS' } else { $r.verdict.T1 = 'FAIL' }

    # -------- T3: 运行时内存态 --------
    $st = Invoke-Nyx -Method GET -Path '/state'
    $mm = [regex]::Match($st.body, '"mode"\s*:\s*"(\w+)"')
    if ($mm.Success) { $r.stateMode = $mm.Groups[1].Value }
    if ($r.stateMode -eq 'normal') { $r.verdict.T3 = 'PASS' } else { $r.verdict.T3 = 'FAIL' }

    # -------- T4: 事件缓冲留痕 --------
    $ev = Invoke-Nyx -Method GET -Path '/mode/events'
    try {
        $obj = $ev.body | ConvertFrom-Json
        $r.eventCount = [int]$obj.count
        $hit = @($obj.events | Where-Object {
            $_.type -eq 'startup' -and $_.from -eq 'private' -and $_.to -eq 'normal' -and $_.changed -eq $true
        })
        if ($hit.Count -gt 0) {
            $r.startupEvent = ($hit[0] | ConvertTo-Json -Compress)
            if ($hit[0].code -eq 'PROXY_UNREACHABLE') { $r.verdict.T4 = 'PASS' } else { $r.verdict.T4 = 'FAIL' }
        } else {
            $r.verdict.T4 = 'FAIL'
        }
    } catch {
        $r.notes += '|events-parse-fail:' + $_.Exception.Message
        $r.verdict.T4 = 'FAIL'
    }
} catch {
    $r.notes += '|EXCEPTION: ' + $_.Exception.Message
} finally {
    $r.killed += Kill-ProjectElectron
    $r.elapsedSec = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
}

# ---------------------------- T2: 主进程日志标记 ----------------------------
# 必须在子进程结束后读取：进程存活期间写句柄未释放，读到的往往是空文件（假阴性）。
# 同时显式按 UTF-8 还原字节——Node 以 UTF-8 写管道，PowerShell 默认按 ANSI 解码会把中文
# 变成乱码，导致「已回落」标记永远匹配不上。
$logText = ''
foreach ($f in @($outLog, $errLog)) {
    if ([string]::IsNullOrWhiteSpace($f)) { continue }
    if (-not (Test-Path -LiteralPath $f)) { continue }
    try {
        $bytes = [IO.File]::ReadAllBytes($f)
        if ($bytes.Length -gt 0) { $logText += [Text.Encoding]::UTF8.GetString($bytes) }
    } catch {
        try { $logText += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) } catch { }
    }
}
if ($logText -and $logText.Trim().Length -gt 0) {
    $r.logCaptured = $true
    $r.logHit = [bool]($logText -match $FALLBACK_MARK)
    if ($r.logHit) { $r.verdict.T2 = 'PASS' } else { $r.verdict.T2 = 'FAIL' }
}

$hard = @($r.verdict.T1, $r.verdict.T3, $r.verdict.T4)
if ($hard -contains 'FAIL') { $r.overall = 'FAIL' }
elseif ($hard -contains 'N/A') { $r.overall = 'PARTIAL' }
else { $r.overall = 'PASS' }

$r | ConvertTo-Json -Depth 6
exit 0
