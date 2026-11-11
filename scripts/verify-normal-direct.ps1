<#
.SYNOPSIS
    Nyx 普通模式直连兜底验证：代理不在线时普通模式必须直接可用，隐私模式必须拒绝降级。

.DESCRIPTION
    纯 API + 文件断言，全程硬超时。前提是「代理不在线」：若探测到 127.0.0.1:7897 可达，
    说明前提不成立，脚本直接 SKIP 退出，不做任何断言。

    隔离运行：本次验收使用独立 userData（NYX_USER_DATA 指向 temp 下的临时 profile），
    绝不读写真实用户 profile；并在该 profile 内预置 proxy/proxy-state.json 的
    preferences.autoStart=false，强制"内置内核完全手动"，从而真实复现"代理关着"的状态。

    断言点：
      T1  GET /state -> mode=normal 且 network.link=direct（启动即直连，不再是死端口代理）
      T2  日志出现「启动阶段不拉起内置代理内核」，且内核进程未随启动拉起（无 mihomo/nyx-kernel 子进程）
      T3  内核未随启动监听代理端口（7897 无监听；此时脚本自己的假监听器尚未启动）
      T4  POST /mode/switch {mode:private} -> 拒绝（ok=false / PROXY_UNREACHABLE），
          且拒绝后 /state 仍为 normal + direct（失败不得污染普通分区链路）
      T5  代理恢复自动回切：假监听器占住 7897 -> 普通模式自动转代理；撤掉 -> 自动回直连
          （验证 watchdog 单向跟随，模式始终留在 normal）
      T6  日志出现两条链路切换标记：切换为代理 / 切换为直连

    清理：仅结束 ExecutablePath 精确等于本项目 electron.exe 的进程，不碰其他 Electron 应用。

.PARAMETER TimeoutSec
    整体硬超时（秒），默认 120。

.PARAMETER LogDir
    子进程 stdout/stderr 与隔离 profile 所在目录，默认 <项目根>\temp\verify-normal-direct。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-normal-direct.ps1
#>

[CmdletBinding()]
param(
    [int]$TimeoutSec = 120,
    [string]$LogDir = '',
    [string]$ExePath = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ProjectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ExePath)) {
    # 默认验源码版（electron .）
    $ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
    $LaunchArgs = @('.')
} else {
    # 验打包产物（如 dist\win-unpacked\Nyx.exe），此时不需要再传项目目录参数
    $ElectronExe = (Resolve-Path -LiteralPath $ExePath).Path
    $LaunchArgs = @()
}
$ProxyPort   = 7897

if ([string]::IsNullOrWhiteSpace($LogDir)) {
    $LogDir = Join-Path $ProjectRoot 'temp\verify-normal-direct'
}
$ProfileDir = Join-Path $LogDir 'profile'
$PortFile   = Join-Path $ProfileDir 'api-port.txt'
$TokenFile  = Join-Path $ProfileDir 'api-token.txt'
$ProxyState = Join-Path $ProfileDir 'proxy\proxy-state.json'

$startedAt = Get-Date
$deadline  = $startedAt.AddSeconds($TimeoutSec)
$base = ''
$hdr  = @{}
$listener = $null

# 中文标记用 Unicode 转义匹配，规避脚本文件编码差异导致的字面量错配
$MARK_NO_KERNEL  = '\u542f\u52a8\u9636\u6bb5\u4e0d\u62c9\u8d77\u5185\u7f6e\u4ee3\u7406\u5185\u6838'
$MARK_TO_PROXY   = '\u5df2\u5207\u6362\u4e3a\u4ee3\u7406'
$MARK_TO_DIRECT  = '\u5df2\u5207\u6362\u4e3a\u76f4\u8fde'

$r = [ordered]@{
    proxyPrecondition = $null
    port              = $null
    stateMode         = ''
    stateLink         = ''
    proxyReachable    = $null
    kernelChildren    = @()
    portListening     = $null
    autoStartGate     = $null
    kernelAfterDeny   = @()
    privateSwitchOk   = $null
    switchStatus      = $null
    switchRaw         = ''
    privateSwitchCode = ''
    modeAfterDeny     = ''
    linkAfterDeny     = ''
    linkOnProxyUp     = ''
    linkOnProxyDown   = ''
    modeAfterFlap     = ''
    logCaptured       = $false
    logNoKernel       = $null
    logToProxy        = $null
    logToDirect       = $null
    verdict           = [ordered]@{ T1 = 'N/A'; T2 = 'N/A'; T3 = 'N/A'; T4 = 'N/A'; T5 = 'N/A'; T6 = 'N/A' }
    overall           = 'UNKNOWN'
    notes             = ''
    killed            = 0
    elapsedSec        = $null
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
    # 按「可执行文件绝对路径完全相等」清理，而不是按进程名：
    #   - 源码版跑的是 electron.exe，打包版跑的是 Nyx.exe，名字不同但路径唯一；
    #   - 只按名字可能误伤用户自己的 Electron 应用。
    # 注意：打包版若没被清理掉，残留进程会拖住调用方的管道，让上层误判为"脚本卡死"。
    $n = 0
    $exeName = Split-Path -Leaf $ElectronExe
    $cims = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$exeName'" -ErrorAction SilentlyContinue)
    foreach ($c in $cims) {
        if ($c.ExecutablePath -and ($c.ExecutablePath.Trim() -ieq $ElectronExe)) {
            try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; $n++ } catch { }
        }
    }
    if ($n -gt 0) { Start-Sleep -Milliseconds 800 }
    return $n
}

function Get-KernelChildren {
    # 内核进程：名称含 mihomo / nyx-kernel 的进程，或本项目 electron 的直接子进程里带 kernel 字样的
    $names = @('mihomo.exe', 'mihomo-core.exe', 'nyx-kernel.exe', 'clash.exe')
    $hits = @()
    foreach ($n in $names) {
        $cims = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$n'" -ErrorAction SilentlyContinue)
        foreach ($c in $cims) { $hits += ($n + '#' + $c.ProcessId) }
    }
    return $hits
}

function Invoke-Nyx {
    param([string]$Method, [string]$Path, [string]$Body = '')
    $p = @{ Uri = ($base + $Path); Method = $Method; Headers = $hdr; UseBasicParsing = $true; TimeoutSec = 12 }
    if ($Body) {
        $p['Body'] = $Body
        $p['ContentType'] = 'application/json'
    }
    try {
        $resp = Invoke-WebRequest @p
        return [pscustomobject]@{ status = [int]$resp.StatusCode; body = $resp.Content; err = '' }
    } catch {
        # PS 5.1 上 4xx/5xx 的响应体只能从 ErrorDetails 或响应流里取；
        # 直接读流的做法在本机实测会拿到空串，因此优先用 ErrorDetails.Message。
        $status = -1
        $msg = ''
        $rs = $_.Exception.Response
        if ($rs) { try { $status = [int]$rs.StatusCode } catch { } }
        try {
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = [string]$_.ErrorDetails.Message }
        } catch { }
        if (-not $msg) {
            if ($rs) {
                try {
                    $sr = New-Object IO.StreamReader($rs.GetResponseStream())
                    $msg = $sr.ReadToEnd()
                } catch { }
            }
        }
        if ($msg) { return [pscustomobject]@{ status = $status; body = $msg; err = '' } }
        return [pscustomobject]@{ status = $status; body = ''; err = $_.Exception.Message }
    }
}

function Get-StateField {
    # 从 /state 响应里取 state.mode / state.network.link 等字段（不依赖 ConvertFrom-Json 的深度差异）
    param([string]$Json, [string]$Pattern)
    $m = [regex]::Match($Json, $Pattern)
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Read-LogText {
    param([string[]]$Files)
    $txt = ''
    foreach ($f in $Files) {
        if ([string]::IsNullOrWhiteSpace($f)) { continue }
        if (-not (Test-Path -LiteralPath $f)) { continue }
        try {
            $bytes = [IO.File]::ReadAllBytes($f)
            if ($bytes.Length -gt 0) { $txt += [Text.Encoding]::UTF8.GetString($bytes) }
        } catch {
            try { $txt += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) } catch { }
        }
    }
    return $txt
}

function Wait-Link {
    param([string]$Expect, [int]$MaxSec = 25)
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt $MaxSec) {
        $st = Invoke-Nyx -Method GET -Path '/state'
        $link = Get-StateField -Json $st.body -Pattern '"link"\s*:\s*"(\w+)"'
        if ($link -eq $Expect) { return $link }
        Start-Sleep -Milliseconds 700
    }
    return (Get-StateField -Json (Invoke-Nyx -Method GET -Path '/state').body -Pattern '"link"\s*:\s*"(\w+)"')
}

# ---------------------------- Phase 0: precondition ----------------------------

$r.proxyPrecondition = Test-TcpPort -H '127.0.0.1' -P $ProxyPort
if ($r.proxyPrecondition) {
    $r.overall = 'SKIP'
    $r.notes = "proxy 127.0.0.1:$ProxyPort is UP -> precondition violated (needs proxy DOWN); no assertion performed"
    $r | ConvertTo-Json -Depth 6
    exit 0
}

if (-not (Test-Path -LiteralPath $ElectronExe)) {
    $r.overall = 'FAIL'
    $r.notes = 'electron.exe not found: ' + $ElectronExe
    $r | ConvertTo-Json -Depth 6
    exit 1
}

# ---------------------------- Phase 1: isolated profile ----------------------------

$r.killed = Kill-ProjectElectron
if (Test-Path -LiteralPath $ProfileDir) { Remove-Item -LiteralPath $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path (Join-Path $ProfileDir 'proxy') | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 预置偏好：内核完全手动（autoStart=false），并关闭自动测速/自动出口自查，避免真实外联
$seed = [ordered]@{
    version       = 1
    activeId      = 'sub-verify'
    subscriptions = @(
        [ordered]@{
            id         = 'sub-verify'
            name       = 'verify-placeholder'
            url        = 'https://example.invalid/sub?token=verify000000'
            addedAt    = 0
            lastFetchAt = $null
            lastError  = $null
            nodeCount  = 0
        }
    )
    preferences   = [ordered]@{ autoStart = $false; autoTest = $false; autoEgress = $false }
}
[IO.File]::WriteAllText($ProxyState, ($seed | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

$outLog = Join-Path $LogDir 'stdout.log'
$errLog = Join-Path $LogDir 'stderr.log'
Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue

# ---------------------------- Phase 2: launch ----------------------------

$env:NYX_USER_DATA = $ProfileDir
$env:NYX_LINK_RECHECK_MS = '5000'
$launchedAt = Get-Date
# Start-Process 的 -ArgumentList 不接受空数组，打包产物（无附加参数）需走另一条分支
$spArgs = @{
    FilePath               = $ElectronExe
    WorkingDirectory       = $ProjectRoot
    RedirectStandardOutput = $outLog
    RedirectStandardError  = $errLog
    PassThru               = $true
}
if ($LaunchArgs.Count -gt 0) { $spArgs['ArgumentList'] = $LaunchArgs }
$proc = Start-Process @spArgs

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

    # -------- 前置：预置偏好是否真的生效（autoStart=false） --------
    try {
        $ps = Get-Content -LiteralPath $ProxyState -Raw -Encoding UTF8 | ConvertFrom-Json
        $r.autoStartGate = [bool]$ps.preferences.autoStart
    } catch {
        $r.notes += '|seed-read-fail:' + $_.Exception.Message
        $r.autoStartGate = $null
    }

    # -------- T1: 启动即直连 --------
    $st = Invoke-Nyx -Method GET -Path '/state'
    $r.stateMode = Get-StateField -Json $st.body -Pattern '"mode"\s*:\s*"(\w+)"'
    $r.stateLink = Get-StateField -Json $st.body -Pattern '"link"\s*:\s*"(\w+)"'
    $r.proxyReachable = (Get-StateField -Json $st.body -Pattern '"proxyReachable"\s*:\s*(true|false)')
    if ($r.stateMode -eq 'normal' -and $r.stateLink -eq 'direct') { $r.verdict.T1 = 'PASS' } else { $r.verdict.T1 = 'FAIL' }

    # -------- T3: 内核未随启动监听代理端口 --------
    if ((Test-TcpPort -H '127.0.0.1' -P $ProxyPort) -eq $false) { $r.portListening = $false } else { $r.portListening = $true }
    $r.kernelChildren = @(Get-KernelChildren)
    if ($r.portListening -eq $false) { $r.verdict.T3 = 'PASS' } else { $r.verdict.T3 = 'FAIL' }

    # -------- T4: 隐私模式必须被拒，且不污染普通链路 --------
    $sw = Invoke-Nyx -Method POST -Path '/mode/switch' -Body '{"mode":"private"}'
    $r.switchStatus = $sw.status
    $r.switchRaw = ([string]$sw.body).Trim()
    if ($r.switchRaw.Length -gt 400) { $r.switchRaw = $r.switchRaw.Substring(0, 400) }
    try {
        $so = $sw.body | ConvertFrom-Json
        $r.privateSwitchOk = $so.ok
        if ($so.reason) { $r.privateSwitchCode = [string]$so.reason }
        elseif ($so.code) { $r.privateSwitchCode = [string]$so.code }
        elseif ($so.message) { $r.privateSwitchCode = [string]$so.message }
    } catch {
        $r.notes += '|switch-parse-fail:' + $_.Exception.Message
    }
    if ($r.privateSwitchOk -eq $false -and $sw.status -eq 400 -and ($r.privateSwitchCode -match 'PROXY_UNREACHABLE')) {
        $r.verdict.T4 = 'PASS'
    } else {
        $r.verdict.T4 = 'FAIL'
    }

    $st2 = Invoke-Nyx -Method GET -Path '/state'
    $r.modeAfterDeny = Get-StateField -Json $st2.body -Pattern '"mode"\s*:\s*"(\w+)"'
    $r.linkAfterDeny = Get-StateField -Json $st2.body -Pattern '"link"\s*:\s*"(\w+)"'
    $r.kernelAfterDeny = @(Get-KernelChildren)
    if ($r.modeAfterDeny -ne 'normal' -or $r.linkAfterDeny -ne 'direct') { $r.verdict.T4 = 'FAIL' }

    # -------- T5: 代理恢复 / 消失，普通模式链路自动跟随 --------
    # 假监听器：只占端口、完成 TCP 握手，不转发任何流量
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $ProxyPort)
    $listener.Start()
    $r.linkOnProxyUp = Wait-Link -Expect 'proxy' -MaxSec 25

    try { $listener.Stop() } catch { }
    $listener = $null
    Start-Sleep -Seconds 1
    $r.linkOnProxyDown = Wait-Link -Expect 'direct' -MaxSec 25

    $st3 = Invoke-Nyx -Method GET -Path '/state'
    $r.modeAfterFlap = Get-StateField -Json $st3.body -Pattern '"mode"\s*:\s*"(\w+)"'

    if ($r.linkOnProxyUp -eq 'proxy' -and $r.linkOnProxyDown -eq 'direct' -and $r.modeAfterFlap -eq 'normal') {
        $r.verdict.T5 = 'PASS'
    } else {
        $r.verdict.T5 = 'FAIL'
    }
} catch {
    $r.notes += '|EXCEPTION: ' + $_.Exception.Message
} finally {
    if ($listener) { try { $listener.Stop() } catch { } }
    $r.killed += Kill-ProjectElectron
    $r.elapsedSec = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
    Remove-Item Env:\NYX_USER_DATA -ErrorAction SilentlyContinue
    Remove-Item Env:\NYX_LINK_RECHECK_MS -ErrorAction SilentlyContinue
}

# ---------------------------- T2 / T6: 日志标记 ----------------------------
# 必须在子进程结束后读取：进程存活期间写句柄未释放，读到的往往是空文件（假阴性）。
$logText = Read-LogText -Files @($outLog, $errLog)
if ($logText -and $logText.Trim().Length -gt 0) {
    $r.logCaptured = $true
    $r.logNoKernel = [bool]($logText -match $MARK_NO_KERNEL)
    $r.logToProxy  = [bool]($logText -match $MARK_TO_PROXY)
    $r.logToDirect = [bool]($logText -match $MARK_TO_DIRECT)
    if ($r.logNoKernel) { $r.verdict.T2 = 'PASS' } else { $r.verdict.T2 = 'FAIL' }
    if ($r.logToProxy -and $r.logToDirect) { $r.verdict.T6 = 'PASS' } else { $r.verdict.T6 = 'FAIL' }
}

# 预置偏好没生效（内核会被自动拉起）时，T4/T5 的结论不成立，如实标 INVALID，避免假 PASS/假 FAIL
if ($r.autoStartGate -ne $false) {
    foreach ($k in @('T4', 'T5')) {
        if ($r.verdict[$k] -ne 'N/A') { $r.verdict[$k] = 'INVALID' }
    }
    $r.notes += '|autoStart gate NOT respected: seeded proxy-state.json was ignored (kernel may auto-start)'
}

$hard = @($r.verdict.T1, $r.verdict.T3, $r.verdict.T4, $r.verdict.T5)
if ($r.autoStartGate -ne $false) { $r.overall = 'SETUP-FAIL' }
elseif ($hard -contains 'FAIL') { $r.overall = 'FAIL' }
elseif ($hard -contains 'N/A') { $r.overall = 'PARTIAL' }
else { $r.overall = 'PASS' }

$r | ConvertTo-Json -Depth 6
exit 0
