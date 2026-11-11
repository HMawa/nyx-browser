<#
.SYNOPSIS
    Nyx 调试前环境初始化脚本（init-debug）。

.DESCRIPTION
    每次开始调试 Nyx 之前运行，把环境恢复到「干净起点」：
      1. 结束 Nyx 项目的残留测试进程——按「项目内 node_modules\electron\dist\electron.exe」的完整路径
         精确匹配，不使用进程名模糊匹配，因此不会误杀 VSCode、TraeWork、Cursor 等其他 Electron 应用；
      2. 清理 %APPDATA%\Nyx 下的运行状态文件（Token、端口记录、缓存、分区数据等），
         删除前先逐条列出完整路径与体积，只删白名单内的项，且校验路径必须落在状态目录之内；
      3. 输出当前物理内存余量；
      4. 输出 Clash Verge 代理（127.0.0.1:7897）的监听状态与占用进程。

    代理策略：代理默认关闭，仅在需要联网调试时临时开启。本脚本不会自动启动或关闭 Clash Verge，只报告状态。

.PARAMETER ProjectRoot
    Nyx 项目根目录。默认取本脚本所在目录的上一级目录。

.PARAMETER SkipStateCleanup
    跳过 %APPDATA%\Nyx 状态文件清理，仅执行进程清理与环境检查。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-debug.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-debug.ps1 -SkipStateCleanup
#>

[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [switch]$SkipStateCleanup
)

$ErrorActionPreference = 'Continue'

# 让中文输出在 UTF-8 环境下正确显示
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ------------------------------------------------------------------
# 0. 路径与常量
# ------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

$resolved = Resolve-Path -LiteralPath $ProjectRoot -ErrorAction SilentlyContinue
if ($null -eq $resolved) {
    Write-Host ('[错误] 项目根目录不存在：' + $ProjectRoot)
    exit 1
}
$ProjectRoot = $resolved.Path

# 只认这个完整路径的 electron.exe，其他 Electron 应用一律不在匹配范围内
$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$StateDir    = Join-Path $env:APPDATA 'Nyx'
$ApiPort     = 17321
$ProxyHost   = '127.0.0.1'
$ProxyPort   = 7897

# 允许清理的状态项白名单（只删这些，不做整目录删除）
$StateWhitelist = @(
    'api-token.txt'
    'api-port.txt'
    'Preferences'
    'SingletonLock'
    'SingletonCookie'
    'SingletonSocket'
    'Cache'
    'Code Cache'
    'GPUCache'
    'DawnGraphiteCache'
    'DawnWebGPUCache'
    'ShaderCache'
    'Local Storage'
    'Session Storage'
    'IndexedDB'
    'Cookies'
    'Cookies-journal'
    'Network'
    'Partitions'
    'logs'
    'Crashpad'
)

# ------------------------------------------------------------------
# 通用函数
# ------------------------------------------------------------------

function Test-TcpPort {
    param(
        [string]$TargetHost,
        [int]$TargetPort,
        [int]$TimeoutMs = 800
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function Get-NyxTestProcesses {
    param([string]$ExePath)
    # 第一步按进程名收窄，第二步用完整可执行路径精确比对；路径不同的一律不匹配
    $all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return @() }
    return @($all | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.Trim() -ieq $ExePath) })
}

function Get-PortOwner {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($conn) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) { return ($proc.ProcessName + ' (PID ' + $proc.Id + ')') }
            return ('PID ' + $conn.OwningProcess)
        }
    } catch { }
    return '未知'
}

function Get-DirSize {
    param([string]$TargetPath)
    $sum = (Get-ChildItem -LiteralPath $TargetPath -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { return 0.0 }
    return [double]$sum
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ([math]::Round($Bytes / 1GB, 2)).ToString() + ' GB' }
    if ($Bytes -ge 1MB) { return ([math]::Round($Bytes / 1MB, 2)).ToString() + ' MB' }
    if ($Bytes -ge 1KB) { return ([math]::Round($Bytes / 1KB, 1)).ToString() + ' KB' }
    return ([math]::Round($Bytes, 0)).ToString() + ' B'
}

# ------------------------------------------------------------------
# 头部信息
# ------------------------------------------------------------------

Write-Host ''
Write-Host '================================================================'
Write-Host '  Nyx 调试环境初始化（init-debug）'
Write-Host '================================================================'
Write-Host ('  时间         : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ('  项目根目录   : ' + $ProjectRoot)
Write-Host ('  状态目录     : ' + $StateDir)
Write-Host ('  进程匹配目标 : ' + $ElectronExe)
Write-Host ''

$killedCount   = 0
$killFailed    = 0
$removedCount  = 0
$removeFailed  = 0

# ------------------------------------------------------------------
# 1. 清理残留测试进程
# ------------------------------------------------------------------

Write-Host '[1/4] 清理 Nyx 残留测试进程'

$targets = Get-NyxTestProcesses -ExePath $ElectronExe

if ($targets.Count -eq 0) {
    Write-Host '      未发现 Nyx 残留测试进程。'
} else {
    Write-Host ('      发现 ' + $targets.Count + ' 个残留进程（仅匹配本项目 electron.exe，其他 Electron 应用不受影响）：')
    foreach ($p in $targets) {
        Write-Host ('        PID ' + $p.ProcessId + '  ' + $p.ExecutablePath)
    }
    foreach ($p in $targets) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            $killedCount++
        } catch {
            $killFailed++
            Write-Host ('        [失败] PID ' + $p.ProcessId + '：' + $_.Exception.Message)
        }
    }
    Write-Host ('      已结束 ' + $killedCount + ' 个进程，失败 ' + $killFailed + ' 个。')
}

if (Test-TcpPort -TargetHost '127.0.0.1' -TargetPort $ApiPort) {
    Write-Host ('      [提示] 本地接口端口 ' + $ApiPort + ' 仍被占用（' + (Get-PortOwner -Port $ApiPort) + '），若启动失败请先结束该进程。')
} else {
    Write-Host ('      本地接口端口 ' + $ApiPort + ' 空闲。')
}

# ------------------------------------------------------------------
# 2. 清理运行状态文件
# ------------------------------------------------------------------

Write-Host ''
Write-Host '[2/4] 清理运行状态文件'

if ($SkipStateCleanup) {
    Write-Host '      已指定 -SkipStateCleanup，跳过状态清理。'
} elseif (-not (Test-Path -LiteralPath $StateDir)) {
    Write-Host ('      状态目录不存在（Nyx 尚未运行过），无需清理：' + $StateDir)
} else {
    $items = @()
    foreach ($name in $StateWhitelist) {
        $full = Join-Path $StateDir $name
        if (Test-Path -LiteralPath $full) {
            $items += (Get-Item -LiteralPath $full -Force)
        }
    }

    if ($items.Count -eq 0) {
        Write-Host '      未发现需要清理的状态项。'
    } else {
        Write-Host ('      以下 ' + $items.Count + ' 项将被删除（删除前清单）：')
        $totalBytes = 0.0
        foreach ($it in $items) {
            if (-not $it.FullName.StartsWith($StateDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Host ('        [跳过] 路径越界，不在状态目录内：' + $it.FullName)
                continue
            }
            $isDir = $it.PSIsContainer
            $size = 0.0
            if ($isDir) { $size = Get-DirSize -TargetPath $it.FullName } else { $size = [double]$it.Length }
            $totalBytes += $size
            $kind = '文件'
            if ($isDir) { $kind = '目录' }
            Write-Host ('        [' + $kind + '] ' + $it.FullName + '  (' + (Format-Size -Bytes $size) + ')')
        }
        Write-Host ('      合计 ' + (Format-Size -Bytes $totalBytes))

        foreach ($it in $items) {
            if (-not $it.FullName.StartsWith($StateDir, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            try {
                Remove-Item -LiteralPath $it.FullName -Recurse -Force -ErrorAction Stop
                $removedCount++
            } catch {
                $removeFailed++
                Write-Host ('        [失败] ' + $it.FullName + '：' + $_.Exception.Message)
            }
        }
        Write-Host ('      已删除 ' + $removedCount + ' 项，失败 ' + $removeFailed + ' 项。')
    }
}

# ------------------------------------------------------------------
# 3. 物理内存余量
# ------------------------------------------------------------------

Write-Host ''
Write-Host '[3/4] 物理内存余量'

$memFreeGB = -1.0
try {
    $osInfo = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $totalKB = [double]$osInfo.TotalVisibleMemorySize
    $freeKB  = [double]$osInfo.FreePhysicalMemory
    $memFreeGB = $freeKB / 1MB

    $usedPercent = 0.0
    if ($totalKB -gt 0) { $usedPercent = (($totalKB - $freeKB) / $totalKB) * 100 }

    Write-Host ('      总物理内存 : ' + ([math]::Round($totalKB / 1MB, 2)).ToString() + ' GB')
    Write-Host ('      当前余量   : ' + ([math]::Round($memFreeGB, 2)).ToString() + ' GB（已用 ' + ([math]::Round($usedPercent, 1)).ToString() + '%）')

    if ($memFreeGB -lt 1.5) {
        Write-Host '      [警告] 可用内存偏低。Nyx 每个标签约占 60-120MB，重度页面可达 300MB 以上；'
        Write-Host '             建议先关闭其他大型应用，或临时降低标签上限（$env:NYX_MAX_TABS=4）。'
    } else {
        Write-Host '      余量充足，可正常调试。'
    }
} catch {
    Write-Host ('      [警告] 读取内存信息失败：' + $_.Exception.Message)
}

# ------------------------------------------------------------------
# 4. 代理监听状态
# ------------------------------------------------------------------

Write-Host ''
Write-Host ('[4/4] Clash Verge 代理状态（' + $ProxyHost + ':' + $ProxyPort + '）')

if (Test-TcpPort -TargetHost $ProxyHost -TargetPort $ProxyPort) {
    Write-Host ('      监听状态 : 在线（' + (Get-PortOwner -Port $ProxyPort) + '）')
    Write-Host '      [注意] 代理当前处于开启状态；调试结束后请运行 cleanup-debug.ps1（需要关代理时加 -StopClash）。'
} else {
    Write-Host '      监听状态 : 未监听'
    Write-Host '      符合「代理默认关闭」策略。若本次调试需要联网，请手动启动 Clash Verge 并确认混合端口为 7897；'
    Write-Host '      校园网环境下请先确认节点可用，再开始调试。'
}

# ------------------------------------------------------------------
# 汇总
# ------------------------------------------------------------------

Write-Host ''
Write-Host '----------------------------------------------------------------'
Write-Host '  初始化汇总'
Write-Host '----------------------------------------------------------------'
Write-Host ('  残留进程清理 : 结束 ' + $killedCount + ' 个，失败 ' + $killFailed + ' 个')
if ($SkipStateCleanup) {
    Write-Host '  状态文件清理 : 已跳过'
} else {
    Write-Host ('  状态文件清理 : 删除 ' + $removedCount + ' 项，失败 ' + $removeFailed + ' 项')
}
Write-Host ''
Write-Host '  后续步骤：'
Write-Host '    1) 需要联网时手动启动 Clash Verge（混合端口 7897）'
Write-Host '    2) npm install（首次）/ npm start 启动 Nyx'
Write-Host '    3) 调试结束运行 scripts\cleanup-debug.ps1，不再需要联网时加 -StopClash'
Write-Host '----------------------------------------------------------------'
Write-Host ''

exit 0
