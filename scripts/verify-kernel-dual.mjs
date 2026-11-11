#!/usr/bin/env node
/**
 * Nyx 阶段 2 前置验收：内核双实例端到端 + 退出零残留
 *
 * 为什么需要它（阶段 1 遗留清单里的三项，全部属于"阶段 2 的功能底座"）：
 *   1. bootNyxKernels 双实例端到端从未跑过 —— 而"双模式切换"在阶段 2 就是切实例；
 *   2. shutdown() 对内核子进程树的清理完整性未知 —— 与项目「退出后零残留」口径直接相关；
 *   3. 内核崩溃对宿主的影响未知 —— 阶段 2 要据此实现降级，先得能"感知到"崩溃。
 *
 * 判据设计要点：
 *   - 隔离：全程在 temp/<runTag> 下的独立 profile 目录，不碰用户 %APPDATA%\Nyx 与安装版；
 *   - 归因：所有强杀/清理只按自家 pid 或自家 profile 路径精确匹配，绝不整类杀 msedge
 *     （用户日常 Edge 正在运行，误杀即事故）；
 *   - 隐私红线是硬断言：隐私实例 `listExtensions` 必须为 0，且普通实例装载扩展后
 *     隐私实例仍为 0（交叉验证，防止"串台"被单向判据掩盖）。
 *
 * 用法：node scripts/verify-kernel-dual.mjs [--headless]
 *   --headless 仅用于快速复跑；扩展装载与输入投递在 headless 下存在行为差异，
 *   作结论必须用默认的"真窗口"模式。
 * 退出码：0 全通过 / 1 有硬断言失败
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const kb = require('../src/core/kernel-bridge.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADLESS = process.argv.includes('--headless');
const RUN_TAG = `kb-dual-${Date.now().toString(36)}`;
const BASE = path.join(ROOT, 'temp', RUN_TAG);
const EXT_DIR = path.join(BASE, 'probe-ext');
const NORMAL_PROFILE = path.join(BASE, 'profile-normal');
const PRIVATE_PROFILE = path.join(BASE, 'profile-private');

const results = [];
let failed = 0;

function check(id, name, ok, detail = '') {
  results.push({ id, name, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${id} ${name}${detail ? ` | ${detail}` : ''}`);
}

/** 在 PowerShell 中求值一个整数表达式（返回 -1 表示执行失败） */
function psInt(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : -1;
}

/** 按 profile 路径精确匹配内核进程数（只认自家实例，绝不整类杀 msedge） */
function kernelProcCount() {
  return psInt(
    `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -like '*${RUN_TAG}*' } | Measure-Object).Count`,
  );
}

function portListening(port) {
  return psInt(
    `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count`,
  );
}

function writeProbeExtension() {
  fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EXT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Nyx Dual Probe',
        version: '1.0.0',
        action: { default_popup: 'popup.html' },
        content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'], run_at: 'document_idle' }],
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(
    path.join(EXT_DIR, 'popup.html'),
    '<!doctype html><meta charset="utf-8"><title>Nyx Dual Probe</title><p>probe popup</p>',
    'utf8',
  );
  fs.writeFileSync(path.join(EXT_DIR, 'cs.js'), 'window.__nyxDualProbe = 1;\n', 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`# Nyx 内核双实例验收 | tag=${RUN_TAG} | 模式=${HEADLESS ? 'headless' : '真窗口'}`);

  // ── 环境前置 ──
  const kernelPath = kb.findKernel();
  check('D0', '本机内核探测', !!kernelPath, kernelPath || '未找到 msedge.exe');
  if (!kernelPath) throw new Error('内核不可用，终止');

  const userEdgeBefore = psInt(
    `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -notlike '*${RUN_TAG}*' } | Measure-Object).Count`,
  );

  for (const p of [9301, 9302]) {
    const n = portListening(p);
    check('D1', `端口 ${p} 启动前空闲`, n === 0, `listening=${n}`);
  }

  fs.mkdirSync(BASE, { recursive: true });
  writeProbeExtension();

  kb.assertPortFree(9301);

  // ── 双实例启动 ──
  const t0 = Date.now();
  const kernels = await kb.bootNyxKernels(BASE, kernelPath, {
    headless: HEADLESS,
    normalProfileDir: NORMAL_PROFILE,
    privateProfileDir: PRIVATE_PROFILE,
  });
  const bootMs = Date.now() - t0;
  await sleep(2500); // 心跳需连续两次探测失败才判失活，此处确认两个实例都未被误判
  check(
    'D2',
    '双实例启动并就绪（真实内核 pid 已解析）',
    !!kernels.normal?.alive &&
      !!kernels.private?.alive &&
      !!kernels.normal?.kernelPid &&
      !!kernels.private?.kernelPid,
    `${bootMs}ms, kernelPid=${kernels.normal?.kernelPid}/${kernels.private?.kernelPid}, spawnPid=${kernels.normal?.pid}/${kernels.private?.pid}`,
  );
  check(
    'D3',
    '内核确为本机 Edge（非 Chromium 替身）',
    String(kernels.normal.version || '').includes('Edg/'),
    kernels.normal.version,
  );

  // ── 隔离 ──
  check(
    'D4',
    'profile 目录与 pid 均独立',
    NORMAL_PROFILE !== PRIVATE_PROFILE &&
      kernels.normal.pid !== kernels.private.pid &&
      kernels.normal.userDataDir !== kernels.private.userDataDir,
    `pid=${kernels.normal.pid}/${kernels.private.pid}`,
  );
  const procNow = kernelProcCount();
  check('D5', '两实例进程树已落地（按 profile 路径匹配）', procNow >= 2, `matched=${procNow}`);

  // ── 隐私红线（双向） ──
  // Extensions.getExtensions 的返回结构以实测为准：兼容 {extensions:[...]} 与裸数组
  const extCount = (r) => (Array.isArray(r?.extensions) ? r.extensions.length : Array.isArray(r) ? r.length : -1);

  const privBefore = await kernels.private.listExtensions();
  check('D6', '隐私实例初始零扩展', extCount(privBefore) === 0, `count=${extCount(privBefore)}`);

  const extId = await kernels.normal.loadExtension(EXT_DIR);
  const normalAfter = await kernels.normal.listExtensions();
  check(
    'D7',
    '普通实例运行时装载扩展成功',
    !!extId && extCount(normalAfter) >= 1,
    `id=${extId} count=${extCount(normalAfter)}`,
  );

  const privAfter = await kernels.private.listExtensions();
  check(
    'D8',
    '隐私实例未被扩展污染（交叉验证）',
    extCount(privAfter) === 0,
    `private=${extCount(privAfter)}（normal=${extCount(normalAfter)}）`,
  );

  // ── 崩溃可观测性：强杀隐私实例的**真实内核进程**（browser 进程，不带 /T）──
  // 故意只杀 browser 本体：既验"崩溃能否被感知"，也验"子进程是否随 Chromium job 一并回收"
  spawnSync('taskkill', ['/PID', String(kernels.private.kernelPid), '/F'], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40 && kernels.private.alive; i += 1) await sleep(200);
  check(
    'D9',
    '内核崩溃可被感知（alive 翻 false）',
    kernels.private.alive === false,
    JSON.stringify(kernels.private.exitInfo || {}),
  );

  // 崩溃后子进程应随 Chromium job 一并回收（这是 detached:false 依赖的机制，必须实测而非假定）
  await sleep(1500);
  const leftover = psInt(
    `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -like '*${RUN_TAG}*profile-private*' } | Measure-Object).Count`,
  );
  check('D10', '崩溃实例无残留子进程', leftover === 0, `leftover=${leftover}`);

  // ── 优雅退出：普通实例 ──
  const shut = await kernels.normal.shutdown();
  check('D11', '优雅退出成功（Browser.close 生效）', shut.ended === true, JSON.stringify(shut));

  // ── 零残留 ──
  await sleep(1200);
  const restProc = kernelProcCount();
  check('D12', '退出后零进程残留', restProc === 0, `matched=${restProc}`);
  const restPort = portListening(9301) + portListening(9302);
  check('D13', '退出后 CDP 端口全部释放', restPort === 0, `listening=${restPort}`);

  // ── 用户日常 Edge 未受影响（提示项，不作硬断言：用户同时可能自己开新页） ──
  const userEdgeAfter = psInt(
    `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -notlike '*${RUN_TAG}*' } | Measure-Object).Count`,
  );
  console.log(
    `NOTE | D14 用户日常 Edge 进程数：运行前 ${userEdgeBefore} → 运行后 ${userEdgeAfter}` +
      `${userEdgeBefore > 0 && userEdgeAfter === 0 ? '  ← 异常，需立即排查' : ''}`,
  );
}

let exitCode = 1;
try {
  await main();
  exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error(`ERROR | ${err && err.message}`);
  check('E1', '脚本执行未抛异常', false, String(err && err.message));
  exitCode = 1;
} finally {
  // 兜底清理：只对自家 profile 匹配到的进程动手
  const ps = psInt(
    `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -like '*${RUN_TAG}*' } | Measure-Object).Count`,
  );
  if (ps > 0) console.log(`# 兜底清理：仍有 ${ps} 个自家内核进程，按 pid 逐个强杀`);
  if (ps > 0) {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${RUN_TAG}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 60000 },
    );
  }

  const out = path.join(ROOT, 'scripts', 'verify-kernel-dual.result.json');
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        tag: RUN_TAG,
        headless: HEADLESS,
        pass: results.filter((r) => r.ok).length,
        fail: failed,
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n# 结果：${results.filter((r) => r.ok).length}/${results.length} PASS，明细 ${out}`);
  process.exit(exitCode);
}
