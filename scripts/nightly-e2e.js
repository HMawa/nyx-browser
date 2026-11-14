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
 *   node scripts/nightly-e2e.js                      只打印将要执行的步骤
 *   node scripts/nightly-e2e.js --run                真跑：轮换归档 → --cross
 *   node scripts/nightly-e2e.js --register           打印注册夜间任务的命令（不会自动注册）
 *   node scripts/nightly-e2e.js --register --apply   真的注册（要你自己加 --apply，不静默动手）
 *   node scripts/nightly-e2e.js --status             查一下现在有没有注册、下次什么时候跑
 *   node scripts/nightly-e2e.js --unregister --apply 真的删掉这个计划任务
 *
 * 刻意不做的事：
 *   - 不带 `--apply` 绝不注册/删除计划任务：`--register` 只打印命令，动手要你再加一个参数。
 *   - 不吞失败。任何一步失败都以非零退出，并把失败原因写进记录表。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_TASK_NAME,
  buildDeleteArgs,
  buildRegisterArgs,
  describeTask,
  parseQueryOutput,
} = require('./lib/nightly-plan');

const ROOT = path.resolve(__dirname, '..');
const RECORD = path.join(ROOT, 'docs', '安装器e2e夜间记录.md');
const LOG_DIR = path.join(ROOT, 'temp');
const TASK_NAME = DEFAULT_TASK_NAME;
// 状态文件落在应用的 userData 里：设置页读的就是这一个，换台机器/换用户各看各的。
const USER_DATA =
  process.env.NYX_USER_DATA || path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || ROOT, 'AppData', 'Roaming'), 'Nyx');
const STATUS_FILE = path.join(USER_DATA, 'nightly-e2e.json');

function say(line) {
  console.log(`[夜间 e2e] ${line}`);
}

function readArgs(argv) {
  const options = { run: false, register: false, unregister: false, status: false, apply: false, elevated: false, keep: null, time: null, dryRun: true };
  for (const raw of argv) {
    if (raw === '--run') {
      options.run = true;
      options.dryRun = false;
    } else if (raw === '--register') {
      options.register = true;
    } else if (raw === '--unregister') {
      options.unregister = true;
    } else if (raw === '--status') {
      options.status = true;
    } else if (raw === '--apply') {
      options.apply = true;
    } else if (raw === '--elevated') {
      options.elevated = true;
    } else if (raw.startsWith('--keep=')) {
      options.keep = raw.slice('--keep='.length);
    } else if (raw.startsWith('--time=')) {
      options.time = raw.slice('--time='.length);
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

/**
 * 注册命令的"给人看的形态"：参数拼法来自 lib/nightly-plan，避免和真正执行的那份走形。
 */
function registerCommand(time, elevated) {
  const built = buildRegisterArgs({
    node: process.execPath,
    script: path.join(ROOT, 'scripts', 'nightly-e2e.js'),
    taskName: TASK_NAME,
    time,
    elevated: Boolean(elevated),
  });
  if (!built.ok) return `schtasks /Create —— 拼不出来：${built.error}`;
  // /TR 自己已经带引号了，只给"含空格且还没有引号"的参数补引号，避免出现 ""C:\..."" 这种双重引号
  const quote = (item) => (item.includes('"') ? item : / /.test(item) ? `"${item}"` : item);
  return `schtasks ${built.args.map(quote).join(' ')}`;
}

/**
 * schtasks 的输出是控制台代码页（中文系统上是 GBK），按 utf8 解会把「找不到」解成乱码，
 * 于是"任务不存在"被误判成"读不出来"。这里统一按 GBK 解，ASCII 部分两种编码一致，不影响英文系统。
 */
function decodeConsole(buffer) {
  if (!buffer || !buffer.length) return '';
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return Buffer.from(buffer).toString('utf8');
  }
}

/** 真跑 schtasks（只在带了 --apply 时才会走到这里） */
function runSchtasks(args) {
  if (process.platform !== 'win32') {
    return { ok: false, error: '计划任务只在 Windows 上有意义。' };
  }
  const result = spawnSync('schtasks', args, { encoding: 'buffer', windowsHide: true });
  const stdout = decodeConsole(result.stdout).trim();
  const stderr = decodeConsole(result.stderr).trim();
  if (result.error) return { ok: false, error: `schtasks 起不来：${result.error.message}` };
  if (result.status !== 0) {
    return { ok: false, error: `schtasks 退出码 ${result.status}：${stderr || stdout || '没有输出'}` };
  }
  return { ok: true, stdout, stderr };
}

/** 查一次任务状态：读到什么算什么，读不到就如实说读不到 */
function taskStatus() {
  if (process.platform !== 'win32') {
    return { ok: false, registered: false, error: '计划任务只在 Windows 上有意义。' };
  }
  const result = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], {
    encoding: 'buffer',
    windowsHide: true,
  });
  if (result.error) return { ok: false, registered: false, error: `schtasks 起不来：${result.error.message}` };
  // schtasks 在"任务不存在"时退出码非 0，但输出里有线索，统一交给 parseQueryOutput 判断
  return parseQueryOutput(`${decodeConsole(result.stdout)}\n${decodeConsole(result.stderr)}`);
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
  // 顺手查一次计划任务：没注册的话"上次通过"是上周的结论，用户会以为它在自动跑
  const scheduledProbe = taskStatus();
  const scheduled = {
    registered: scheduledProbe.ok === true ? scheduledProbe.registered === true : null,
    nextRun: scheduledProbe.nextRun || '',
    error: scheduledProbe.ok === true ? '' : scheduledProbe.error || '未知原因',
    checkedAt: Date.now(),
  };
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
    scheduled,
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
    console.log('用法：node scripts/nightly-e2e.js [--run] [--register [--apply [--elevated]]] [--unregister [--apply]] [--status] [--keep=N] [--time=HH:MM]');
    console.log('  不带 --run 只打印计划，什么都不做。');
    console.log('  --register 只打印命令；真要注册得再加 --apply（不静默改系统）。');
    console.log('  --elevated 只在注册时用：加 /RL HIGHEST 以最高权限跑，需要管理员终端；默认按当前用户跑。');
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
    const built = buildRegisterArgs({
      node: process.execPath,
      script: path.join(ROOT, 'scripts', 'nightly-e2e.js'),
      taskName: TASK_NAME,
      time: options.time,
      elevated: options.elevated,
    });
    if (!built.ok) {
      console.error(`[夜间 e2e] ${built.error}`);
      return 1;
    }
    say(`计划：每天 ${built.time} 跑一次（任务名 ${built.taskName}，权限：${built.elevated ? '最高（需要管理员）' : '当前用户'}）`);
    if (!options.apply) {
      say('注册夜间任务（要你自己执行，或者加 --apply 让我现在注册）：');
      console.log(`  ${registerCommand(options.time, options.elevated)}`);
      say(`删掉任务：schtasks /Delete /TN "${TASK_NAME}" /F（或者 node scripts/nightly-e2e.js --unregister --apply）`);
    } else {
      say('按 --apply 真的注册（失败会原样报出 schtasks 的错误）：');
      const created = runSchtasks(built.args);
      if (!created.ok) {
        console.error(`[夜间 e2e] 注册失败：${created.error}`);
        if (/拒绝访问|Access is denied/i.test(created.error)) {
          console.error('[夜间 e2e] 这是权限问题：默认按当前用户注册不需要管理员。若你在受限账户里，或这台机器的任务计划被策略锁住，就要开一个管理员终端再跑一次。');
        }
        return 1;
      }
      const after = taskStatus();
      const verdict = describeTask(after, { taskName: TASK_NAME });
      say(`注册结果：${verdict.text}`);
      if (!after.registered) {
        console.error('[夜间 e2e] schtasks 说建好了，但查不到这个任务——不当作注册成功。');
        return 1;
      }
    }
  }
  if (options.unregister) {
    if (!options.apply) {
      say('删除计划任务要你自己执行（或者加 --apply）：');
      console.log(`  schtasks /Delete /TN "${TASK_NAME}" /F`);
    } else {
      const removed = runSchtasks(buildDeleteArgs({ taskName: TASK_NAME }).args);
      if (!removed.ok) {
        console.error(`[夜间 e2e] 删除失败：${removed.error}`);
        return 1;
      }
      const after = taskStatus();
      say(`删除结果：${describeTask(after, { taskName: TASK_NAME }).text}`);
      if (after.ok === true && after.registered) {
        console.error('[夜间 e2e] schtasks 说删了，但还能查到——不当作删除成功。');
        return 1;
      }
    }
  }
  if (options.status) {
    const now = taskStatus();
    say(describeTask(now, { taskName: TASK_NAME }).text);
    if (now.ok !== true) return 1;
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
