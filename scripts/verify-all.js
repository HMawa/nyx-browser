'use strict';

/**
 * Nyx 一键回归：把三个验证脚本串成一条命令（npm run verify）。
 *
 * 依次执行：
 *  1. scripts/verify-address-suggest.js（地址栏建议，69 项）
 *  2. scripts/verify-ui-polish.js（界面体验，44 项）
 *  3. scripts/verify-packaged-smoke.js（打包产物冒烟，11 项；dist\win-unpacked 不存在时跳过）
 *
 * 行为约定：
 *   - 每个脚本跑在独立子进程里，stdio 直通（输出不捕获、不吞），一个失败不影响后续；
 *   - 跑每个脚本前先清理本仓库遗留的 Electron 进程，避免上一轮窗口占着单实例锁；
 *     只按「可执行文件完整路径」精确匹配本仓库的两个 exe：
 *       <仓库>\node_modules\electron\dist\electron.exe
 *       <仓库>\dist\win-unpacked\Nyx.exe
 *     **绝不**按进程名杀，因此不会误杀已安装的 D:\Nyx\Nyx.exe、VSCode、Trae 等。
 *   - 最后输出中文汇总，任一脚本失败 → 总退出码 1；全部通过（或有跳过）→ 0。
 *
 * 用法：
 *   npm run verify
 *   node scripts/verify-all.js
 *
 * 零第三方依赖，只用 Node 内置模块 + 系统自带 PowerShell（取进程路径）与 taskkill。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 本仓库允许清理的两个 Electron 可执行文件（完整路径精确匹配） */
const OWN_EXECUTABLES = [
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(ROOT, 'dist', 'win-unpacked', 'Nyx.exe'),
].map((p) => path.resolve(p));

/** 回归步骤：顺序、各自超时（留足余量，正常耗时约 40s / 40s / 5s / 20s） */
const STEPS = [
  {
    label: '地址栏建议回归',
    script: 'verify-address-suggest.js',
    items: '69 项',
    timeoutMs: 240000,
  },
  {
    label: '界面体验回归',
    script: 'verify-ui-polish.js',
    items: '44 项',
    timeoutMs: 240000,
  },
  {
    label: '打包产物冒烟',
    script: 'verify-packaged-smoke.js',
    items: '11 项',
    timeoutMs: 240000,
    /** 依赖解包产物：不存在就跳过（跳过不算失败） */
    requires: path.join(ROOT, 'dist', 'win-unpacked', 'Nyx.exe'),
    skipHint: '请先 npm run dist:dir',
  },
];

function nowMs() {
  return Date.now();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 取进程列表（PID / 名称 / 完整路径）。
 * 用 PowerShell 的 Win32_Process 拿 ExecutablePath；结果用 Base64(UTF8) 回传，
 * 避免控制台代码页把路径里的中文毁掉。取不到就返回空数组 —— 宁可不清理，也不按名字乱杀。
 */
function listProcesses() {
  const command = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='Nyx.exe'\" | Select-Object ProcessId, Name, ExecutablePath)",
    'if ($procs.Count -gt 0) {',
    '  $json = ConvertTo-Json -InputObject $procs -Compress',
    '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    '}',
  ].join('\n');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];

  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!line) return [];
  try {
    const parsed = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * 结束本仓库遗留的 Electron 进程。
 * 只匹配完整路径（大小写不敏感），绝不按进程名杀，避免误伤安装版与其他 Electron 应用。
 */
function cleanupLeftovers(tag) {
  const allow = new Set(OWN_EXECUTABLES.map((p) => p.toLowerCase()));
  const killed = [];

  for (const proc of listProcesses()) {
    const exePath = String(proc.ExecutablePath || '');
    if (!exePath) continue;
    if (!allow.has(path.resolve(exePath).toLowerCase())) continue;
    const pid = Number(proc.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // /T 连带子孙进程（renderer / gpu / utility），/F 强制结束
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    killed.push(`${proc.Name}(${pid})`);
  }

  if (killed.length) {
    console.log(`[回归] ${tag}：已清理本仓库残留进程 ${killed.join('、')}`);
  }
  return killed.length;
}

function runStep(step, index, total) {
  const scriptPath = path.join(__dirname, step.script);
  console.log('');
  console.log(`[回归] [${index}/${total}] ${step.label}（scripts/${step.script}，${step.items}）`);

  if (!fs.existsSync(scriptPath)) {
    console.log(`[回归] [${index}/${total}] 失败：脚本不存在 ${scriptPath}`);
    return { status: 'failed', ms: 0, reason: '脚本不存在' };
  }

  // 上一轮残留的窗口会占用单实例锁 / 端口，先清干净再跑
  cleanupLeftovers(`[${index}/${total}] 前置清理`);

  const started = nowMs();
  // stdio 直通：子脚本的输出原样打到当前控制台，方便定位失败项
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: step.timeoutMs,
    windowsHide: false,
    env: process.env,
  });
  const ms = nowMs() - started;

  // 无论成败都再清一次，避免子脚本异常退出留下 Electron 进程
  cleanupLeftovers(`[${index}/${total}] 收尾清理`);

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { status: 'failed', ms, reason: `超时（${Math.round(step.timeoutMs / 1000)}s）` };
  }
  if (result.error) {
    return { status: 'failed', ms, reason: `启动失败：${result.error.message}` };
  }
  if (result.signal) {
    return { status: 'failed', ms, reason: `被信号 ${result.signal} 结束` };
  }
  if (result.status !== 0) {
    return { status: 'failed', ms, reason: `退出码 ${result.status}` };
  }
  return { status: 'passed', ms, reason: '' };
}

function main() {
  const totalStarted = nowMs();
  console.log('[回归] ===== Nyx 一键回归开始 =====');
  console.log(`[回归] 仓库：${ROOT}`);
  console.log(`[回归] 顺序执行 ${STEPS.length} 个验证脚本，单个失败不影响后续`);

  const results = [];
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    const index = i + 1;

    if (step.requires && !fs.existsSync(step.requires)) {
      console.log('');
      console.log(`[回归] [${index}/${STEPS.length}] ${step.label}（${step.items}）`);
      console.log(`[回归] [${index}/${STEPS.length}] 跳过：缺少 ${path.relative(ROOT, step.requires)}，${step.skipHint}`);
      results.push({ step, status: 'skipped', ms: 0, reason: step.skipHint });
      continue;
    }

    const outcome = runStep(step, index, STEPS.length);
    console.log(
      `[回归] [${index}/${STEPS.length}] ` +
        (outcome.status === 'passed'
          ? `通过（${formatDuration(outcome.ms)}）`
          : `失败：${outcome.reason}（${formatDuration(outcome.ms)}）`),
    );
    results.push({ step, ...outcome });
  }

  // 收尾：把整个回归过程中可能遗留的进程再清一遍
  cleanupLeftovers('最终清理');

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const elapsed = nowMs() - totalStarted;

  console.log('');
  console.log('[回归] ===== 汇总 =====');
  for (const r of results) {
    const mark = r.status === 'passed' ? '✔ 通过' : r.status === 'failed' ? '✘ 失败' : '— 跳过';
    const tail = r.status === 'passed' ? formatDuration(r.ms) : r.status === 'failed' ? `${r.reason}（${formatDuration(r.ms)}）` : r.reason;
    console.log(`  ${mark}  ${r.step.label.padEnd(8, ' ')}  ${r.step.items.padEnd(6, ' ')}  ${tail}`);
  }
  console.log('');
  console.log(
    `[回归] 共 ${results.length} 个脚本：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过，耗时 ${Math.round(elapsed / 1000)}s`,
  );

  if (failed > 0) {
    console.log('[回归] 结论：有脚本失败，见上方失败项输出。');
    process.exitCode = 1;
    return;
  }
  console.log('[回归] 结论：全部通过（跳过项需先构建解包产物）。');
  process.exitCode = 0;
}

main();
