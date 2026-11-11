<#
.SYNOPSIS
    Nyx 调试后清场脚本（cleanup-debug）。

.DESCRIPTION
    每次调试结束运行，确保不留残留：
      1. 结束 Nyx 项目的测试进程——同样按「项目内 node_modules\electron\dist\electron.exe」的完整路径
         精确匹配，不会误杀 VSCode、TraeWork、Cursor 等其他 Electron 应用；
      2. 可选（-StopClash）：一并关闭 Clash Verge 及其内核进程，让代理恢复「默认关闭」状态；
      3. 复核 7897 与 17321 端口，输出清理结果。

    注意：不加 -StopClash 时，代理进程会被保留，脚本只做状态报告。

.PARAMETER ProjectRoot
    Nyx 项目根目录。默认取本脚本所在目录的上一级目录。

.PARAMETER StopClash
    一并关闭 Clash Verge 相关进程。会中断当前所有走代理的连接，也可能影响其他正在使用该代理的程序，
    仅在确认不再需要联网时使用。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\cleanup-debug.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\cleanup-debug.ps1 -StopClash
#>

[CmdletBinding()]
param(
    [string]$ProjectRoot = '',
    [switch]$StopClash
)

$ErrorActionPreference = 'Continue'

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

$ElectronExe = Join-Path $ProjectRoot 'node_modules\electron\dist\electron.exe'
$ApiPort     = 17321
$ProxyPort   = 7897

# Clash 系进程名白名单（精确名称比对，避免误伤名字相近的程序）
$ClashNames = @(
    'Clash Verge'
    'clash-verge'
    'clash-verge-service'
    'verge-mihomo'
    'mihomo'
    'clash'
    'clash-meta'
    'Clash for Windows'
    'ClashN'
    'clash-nyanpasu'
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
    $all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return @() }
    return @($all | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.Trim() -ieq $ExePath) })
}

function Get-ClashProcesses {
    param([string[]]$Names)
    $all = @(Get-Process -ErrorAction SilentlyContinue)
    $hit = @()
    foreach ($proc in $all) {
        $matched = @($Names | Where-Object { $_ -ieq $proc.ProcessName })
        if ($matched.Count -gt 0) { $hit += $proc }
    }
    return $hit
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

# ------------------------------------------------------------------
# 头部
# ------------------------------------------------------------------

Write-Host ''
Write-Host '================================================================'
Write-Host '  Nyx 调试清场（cleanup-debug）'
Write-Host '================================================================'
Write-Host ('  时间         : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ('  项目根目录   : ' + $ProjectRoot)
Write-Host ('  关闭代理     : ' + $(if ($StopClash) { '是（-StopClash）' } else { '否' }))
Write-Host ''

$killedCount = 0
$killFailed  = 0
$clashKilled = 0
$clashFailed = 0

# ------------------------------------------------------------------
# 1. 结束 Nyx 测试进程
# ------------------------------------------------------------------

Write-Host '[1/3] 结束 Nyx 测试进程'

$targets = Get-NyxTestProcesses -ExePath $ElectronExe

if ($targets.Count -eq 0) {
    Write-Host '      未发现 Nyx 残留测试进程。'
} else {
    Write-Host ('      发现 ' + $targets.Count + ' 个进程（仅匹配本项目 electron.exe）：')
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

# ------------------------------------------------------------------
# 2. 可选关闭 Clash Verge
# ------------------------------------------------------------------

Write-Host ''
Write-Host '[2/3] Clash Verge 代理进程'

$clashProcs = Get-ClashProcesses -Names $ClashNames

if (-not $StopClash) {
    if ($clashProcs.Count -gt 0) {
        Write-Host ('      当前有 ' + $clashProcs.Count + ' 个代理相关进程在运行（已按默认策略保留）：')
        foreach ($cp in $clashProcs) {
            Write-Host ('        PID ' + $cp.Id + '  ' + $cp.ProcessName)
        }
        Write-Host '      如需一并关闭以恢复「代理默认关闭」状态，请加 -StopClash 重新执行本脚本。'
    } else {
        Write-Host '      未发现 Clash Verge 相关进程，代理已处于关闭状态。'
    }
} else {
    if ($clashProcs.Count -eq 0) {
        Write-Host '      未发现 Clash Verge 相关进程，无需关闭。'
    } else {
        Write-Host ('      将结束以下 ' + $clashProcs.Count + ' 个代理相关进程（会中断当前所有代理连接）：')
        foreach ($cp in $clashProcs) {
            Write-Host ('        PID ' + $cp.Id + '  ' + $cp.ProcessName)
        }
        foreach ($cp in $clashProcs) {
            try {
                Stop-Process -Id $cp.Id -Force -ErrorAction Stop
                $clashKilled++
            } catch {
                $clashFailed++
                Write-Host ('        [失败] PID ' + $cp.Id + ' ' + $cp.ProcessName + '：' + $_.Exception.Message)
            }
        }
        Write-Host ('      已结束 ' + $clashKilled + ' 个代理进程，失败 ' + $clashFailed + ' 个。')
        if ($clashFailed -gt 0) {
            Write-Host '      [提示] 部分进程（如 clash-verge-service）为系统服务，普通权限无法结束，可在任务管理器中处理。'
        }
    }
}

# ------------------------------------------------------------------
# 3. 端口复核
# ------------------------------------------------------------------

Write-Host ''
Write-Host '[3/3] 端口复核'

Start-Sleep -Milliseconds 500

$proxyStillUp = Test-TcpPort -TargetHost '127.0.0.1' -TargetPort $ProxyPort
if ($proxyStillUp) {
    Write-Host ('      代理端口 ' + $ProxyPort + ' : 仍在监听（' + (Get-PortOwner -Port $ProxyPort) + '）')
} else {
    Write-Host ('      代理端口 ' + $ProxyPort + ' : 已释放')
}

$apiStillUp = Test-TcpPort -TargetHost '127.0.0.1' -TargetPort $ApiPort
if ($apiStillUp) {
    Write-Host ('      接口端口 ' + $ApiPort + ' : 仍被占用（' + (Get-PortOwner -Port $ApiPort) + '）')
} else {
    Write-Host ('      接口端口 ' + $ApiPort + ' : 已释放')
}

# ------------------------------------------------------------------
# 汇总
# ------------------------------------------------------------------

$leftover = 0
if (-not $proxyStillUp) { } else { $leftover++ }
if (-not $apiStillUp) { } else { $leftover++ }

Write-Host ''
Write-Host '----------------------------------------------------------------'
Write-Host '  清场汇总'
Write-Host '----------------------------------------------------------------'
Write-Host ('  Nyx 进程     : 结束 ' + $killedCount + ' 个，失败 ' + $killFailed + ' 个')
if ($StopClash) {
    Write-Host ('  Clash 进程   : 结束 ' + $clashKilled + ' 个，失败 ' + $clashFailed + ' 个')
} else {
    Write-Host '  Clash 进程   : 已保留（未指定 -StopClash）'
}
if ($leftover -eq 0) {
    Write-Host '  端口状态     : 7897 与 17321 均已释放，无残留'
} else {
    Write-Host '  端口状态     : 仍有端口在监听，详见上方复核结果'
}
Write-Host ''
Write-Host '  下次调试前请先运行 scripts\init-debug.ps1 做环境初始化。'
Write-Host '----------------------------------------------------------------'
Write-Host ''

exit 0
