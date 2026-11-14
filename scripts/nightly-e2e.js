#!/usr/bin/env node
/**
 * 安装器 e2e 夜间自动跑（用户第七轮 D）
 *
 * 为什么要有这个脚本：
 *   `test-installer-e2e.js --cross` 会真的装／升／卸一遍，要管理员权限、会临时搬走
 *   真实用户数据，所以它不在 `npm run verify` 里。但"跨两版升级"这条路径恰恰最容易
 *   在别人机器上坏掉，人肉每隔几天跑一次不现实——于是固定成夜间一件事：
 *   先把留档里的旧包轮换进 `dist\legacy`，再自动选最老的一份当基线跑 --cross，
 *   结果追加进 `docs/安装器e2e夜间记录.md`。
 *
 * 三种用法（默认什么都不做，只打印计划）：
 *   node scripts/nightly-e2e.js             只打印将要执行的步骤
 *   node scripts/nightly-e2e.js --run       真跑：轮换归档 → --cross
 *   node scripts/nightly-e2e.js --register  打印注册夜间任务的命令（不会自动注册）
 *
 * 刻意不做的事：
 *   - 不静默注册计划任务。`schtasks` 只在 `--register` 时**打印**命令，注册要你自己执行。
 *   - 不吞失败。任何一步失败都以非零退出，并把失败原因写进记录表。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RECORD = path.join(ROOT, 'docs', '安装器e2e夜间记录.md');
const LOG_DIR = path.join(ROOT, 'temp');
const TASK_NAME = 'Nyx-Installer-E2E-Nightly';
// 状态文件落在应用的 userData 里：设置页读的就是这一个，换台机器/换用户各看各的。
const USER_DATA =
  process.env.NYX_USER_DATA || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || ROOT, 'AppData', 'Roaming'), 'Nyx');
const STATUS_FILE = path.join(USER_DATA, 'nightly-e2e.json');

function say(line) {
  console.log(`[夜间 e2e] ${line}`);
}

function readArgs(argv) {
  const options = { run: false, register: false, keep: null, dryRun: true };
  for (const raw of argv) {
    if (raw === '--run') {
      options.run = true;
      options.dryRun = false;
    } else if (raw === '--register') {
      options.register = true;
    } else if (raw.startsWith('--keep=')) {
      options.keep = raw.slice('--keep='.length);
    } else if (raw === '--help' || raw === '-h') {
      options.help = true;
    } else {
      options.unknown = raw;
    }
  }
  return options;
}

function plan() {
  const steps = [
    {
      name: '轮换归档',
      command: 'node scripts/sync-legacy.js',
      why: '把 %APPDATA%\\Nyx\\updates-archive 里最老的几份安装包同步进 dist\\legacy，--cross 才有基线可选',
    },
    {
      name: '跨两版升级',
      command: 'node scripts/test-installer-e2e.js --cross',
      why: '自动选 dist\\legacy 里最老的一份当基线，装旧版 → 覆盖装当前版 → 两次启动',
    },
  ];
  return steps;
}

function registerCommand() {
  const node = process.execPath;
  const script = path.join(ROOT, 'scripts', 'nightly-e2e.js');
  const line = `schtasks /Create /TN "${TASK_NAME}" /SC DAILY /ST 03:30 /TR "\\"${node}\\" \\"${script}\\" --run" /RL HIGHEST /F`;
  return line;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function runStep(step, options) {
  say(`开始：${step.name}（${step.command}）`);
  const parts = step.command.split(' ');
  const scriptPath = path.join(ROOT, parts[1]);
  const extra = parts.slice(2);
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, code: -1, error: `脚本不存在：${path.relative(ROOT, scriptPath)}`, elapsedMs: 0 };
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [scriptPath].concat(extra), {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const elapsedMs = Date.now() - started;
  const ok = result.status === 0;
  say(`${ok ? '完成' : '失败'}：${step.name}｜exit=${result.status === null ? 'null' : result.status}｜${(elapsedMs / 1000).toFixed(1)}s`);
  return { ok, code: result.status === null ? -1 : result.status, error: ok ? '' : `exit=${result.status}`, elapsedMs };
}

function stamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 从 --cross 的输出里抠出「通过 / 失败 / 跳过」与升级基线。
 * 抠不到就写「没读到」，不猜。
 */
function parseCrossSummary(logText) {
  const text = String(logText || '');
  const counts = /通过\s*(\d+)\s*[，,]\s*失败\s*(\d+)\s*[，,]\s*跳过\s*(\d+)/.exec(text);
  const total = /共\s*(\d+)\s*项断言/.exec(text);
  const baseline = /升级基线[：:]\s*([0-9.]+)/.exec(text) || /基线[：:]\s*([0-9.]+)/.exec(text);
  return {
    total: total ? Number(total[1]) : null,
    passed: counts ? Number(counts[1]) : null,
    failed: counts ? Number(counts[2]) : null,
    skipped: counts ? Number(counts[3]) : null,
    baseline: baseline ? baseline[1] : '',
  };
}

function appendRecord(row) {
  const header = [
    '# 安装器 e2e 夜间记录',
    '',
    '> 由 `node scripts/nightly-e2e.js --run` 追加。表里的数字来自 `test-installer-e2e.js --cross`',
    '> 自己的汇总行；抠不到就写「没读到」，不靠猜。',
    '',
    '| 时间 | 升级基线 | 断言 | 通过 | 失败 | 跳过 | 结果 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ].join('\n');
  ensureDir(path.dirname(RECORD));
  let body = fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8') : '';
  if (!body.trim()) body = `${header}\n`;
  const cells = [
    row.time,
    row.baseline || '没读到',
    row.total === null ? '没读到' : String(row.total),
    row.passed === null ? '没读到' : String(row.passed),
    row.failed === null ? '没读到' : String(row.failed),
    row.skipped === null ? '没读到' : String(row.skipped),
    row.ok ? '通过' : `失败（${row.error || '见日志'}）`,
    row.note || '',
  ];
  body = `${body.replace(/\s*$/, '')}\n| ${cells.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |\n`;
  fs.writeFileSync(RECORD, body, 'utf8');
  say(`记录已追加：${path.relative(ROOT, RECORD)}`);
}

/**
 * 把这次结果也写成 JSON 状态，给设置页读（`<userData>/nightly-e2e.json`）。
 * 写失败不中断：记录表已经追加过了，状态卡只是"顺手能让用户看见"，不该反过来把跑失败判成失败。
 */
function writeStatus(row, extra = {}) {
  const status = {
    at: extra.at || Date.now(),
    ok: row.ok === true,
    baseline: row.baseline || '',
    total: row.total === null ? null : row.total,
    passed: row.passed === null ? null : row.passed,
    failed: row.failed === null ? null : row.failed,
    skipped: row.skipped === null ? null : row.skipped,
    error: row.ok ? '' : row.error || '见日志',
    log: row.note || '',
    task: TASK_NAME,
  };
  try {
    ensureDir(path.dirname(STATUS_FILE));
    fs.writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
    say(`状态已写入：${STATUS_FILE}`);
    return true;
  } catch (error) {
    console.warn(`[夜间 e2e] 状态文件没能写入 ${STATUS_FILE}：${error && error.message}`);
    return false;
  }
}

function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.unknown) {
    console.error(`[夜间 e2e] 不认识这个参数：${options.unknown}（可用：--run / --register / --keep=N）`);
    process.exit(1);
  }
  if (options.help) {
    console.log('用法：node scripts/nightly-e2e.js [--run] [--register] [--keep=N]');
    console.log('  不带 --run 只打印计划，什么都不做。');
    return 0;
  }
  const steps = plan();
  say(`工作目录：${ROOT}`);
  if (options.keep) say(`（--keep=${options.keep} 目前只用于提示：轮换保留份数由 sync-legacy.js 自己的 --keep 决定）`);
  for (const [index, step] of steps.entries()) {
    say(`第 ${index + 1} 步：${step.name} → ${step.command}`);
    say(`        为什么：${step.why}`);
  }
  if (options.register) {
    say('注册夜间任务（要你自己执行，我不代跑）：');
    console.log(`  ${registerCommand()}`);
    say(`删掉任务：schtasks /Delete /TN "${TASK_NAME}" /F`);
  }
  if (!options.run) {
    say('没有 --run，按计划什么都没做。要真跑加 --run。');
    return 0;
  }
  if (process.platform !== 'win32') {
    console.error('[夜间 e2e] 安装器 e2e 只在 Windows 上有意义，这里直接退出。');
    return 1;
  }
  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, `nightly-e2e-${Date.now()}.log`);
  const chunks = [];
  const originalLog = console.log;
  console.log = (...args) => {
    originalLog(...args);
    chunks.push(args.map((item) => String(item)).join(' '));
  };
  let failedStep = null;
  for (const step of steps) {
    const result = runStep(step, options);
    if (!result.ok) {
      failedStep = { step, result };
      break;
    }
  }
  console.log = originalLog;
  const logText = chunks.join('\n');
  fs.writeFileSync(logFile, logText, 'utf8');
  const summary = parseCrossSummary(logText);
  const now = new Date();
  appendRecord({
    time: stamp(now),
    baseline: summary.baseline,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    ok: !failedStep,
    error: failedStep ? failedStep.result.error : '',
    note: `日志：temp\\${path.basename(logFile)}`,
  });
  writeStatus(
    {
      baseline: summary.baseline,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      ok: !failedStep,
      error: failedStep ? failedStep.result.error : '',
      note: `日志：temp\\${path.basename(logFile)}`,
    },
    { at: now.getTime() },
  );
  if (failedStep) {
    console.error(`[夜间 e2e] 第 ${steps.indexOf(failedStep.step) + 1} 步失败：${failedStep.step.name}｜${failedStep.result.error}`);
    return 1;
  }
  say('夜间 e2e 全部完成。');
  return 0;
}

process.exitCode = main();
