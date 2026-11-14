#!/usr/bin/env node
'use strict';

/**
 * 发版后自动量一次差分命中率，把结果写进 <userData>\delta-report.json。
 *
 * 为什么单独做成脚本：量差分需要在「没有 Electron 进程」的情况下读两个约 120 MB 的包，
 * 而设置页里那个按钮走的是主进程（`src/main.js` 的 measureDeltaHitRate）。发版脚本是纯 Node，
 * 起不了 Electron，所以这里用同一套纯逻辑（`src/core/delta-stats.js`）重算一遍，
 * 写进同一份报告文件——设置页打开就能看到最新数字，不用人再点一次。
 *
 * 用法：
 *   node scripts/measure-delta-report.js                 # 目标取更新源 latest.json，基线取留档里更小的最新一版
 *   node scripts/measure-delta-report.js --target=<exe>  # 指定目标包（发版脚本就是这么调的）
 *   node scripts/measure-delta-report.js --base=<exe>    # 指定基线包
 *   node scripts/measure-delta-report.js --block-size=512k
 *   node scripts/measure-delta-report.js --dry-run       # 只打印将要量的两个包，不读不写
 *
 * 退出码：0 = 量成功或显式跳过；1 = 真出错（读文件失败等）——但发版脚本对它只告警不中断，
 * 因为「没量成」不该挡住一次已经完成的发布。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const {
  DEFAULT_BLOCK_SIZE,
  DIFF_GATE,
  MAX_TOTAL_BYTES,
  describeDeltaRate,
  formatBytes,
  formatPercent,
  normalizeBlockSize,
  normalizeDeltaReport,
  planDeltaMeasure,
  summarizeDeltaMeasure,
} = require(path.join(ROOT, 'src/core/delta-stats.js'));

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || ROOT, 'AppData', 'Roaming');
const USER_DATA = process.env.NYX_USER_DATA || path.join(APPDATA, 'Nyx');
const UPDATES_DIR = path.join(USER_DATA, 'updates');
const ARCHIVE_ROOT = path.join(USER_DATA, 'updates-archive');
const REPORT_FILE = path.join(USER_DATA, 'delta-report.json');

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const prefixed = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  if (index >= 0 && index + 1 < process.argv.length && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function info(message) {
  console.log(`[差分实测] ${message}`);
}

function versionOf(file) {
  const matched = /-([\d.]+)\.exe$/i.exec(String(file || ''));
  return matched ? matched[1] : '';
}

function findInstaller(dir, version) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^Nyx-Setup-[\d.]+\.exe$/i.test(name));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const wanted = String(version || '').trim();
  if (wanted) {
    const exact = names.find((name) => name.includes(`-${wanted}.exe`));
    if (exact) names = [exact];
  }
  names.sort().reverse();
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size > 0) return { path: full, bytes: stat.size, version: versionOf(name) };
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return null;
}

function compareVersion(a, b) {
  const left = String(a || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 目标 = 更新源里 latest.json 指向的那版；基线 = 留档里严格更小的最新一版 */
function pickPair(options = {}) {
  const target = options.target
    ? describeFile(options.target)
    : findInstaller(UPDATES_DIR, readLatestVersion());
  let versions = [];
  try {
    versions = fs
      .readdirSync(ARCHIVE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersion);
  } catch {
    versions = [];
  }
  if (options.base) return { base: describeFile(options.base), target, archiveVersions: versions };
  const targetVersion = target ? target.version : '';
  const older = versions.filter((name) => !targetVersion || compareVersion(name, targetVersion) < 0);
  let base = null;
  for (let index = older.length - 1; index >= 0 && !base; index -= 1) {
    base = findInstaller(path.join(ARCHIVE_ROOT, older[index]), older[index]);
  }
  return { base, target, archiveVersions: versions };
}

function describeFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size <= 0) return null;
    return { path: file, bytes: stat.size, version: versionOf(file) };
  } catch {
    return null;
  }
}

function readLatestVersion() {
  try {
    const raw = fs.readFileSync(path.join(UPDATES_DIR, 'latest.json'), 'utf8').replace(/^\uFEFF/, '');
    return String(JSON.parse(raw).version || '');
  } catch {
    return '';
  }
}

/** 与主进程同款：按固定块切、逐块 sha256（流式，不整读进内存） */
function hashFileBlocks(filePath, blockSize, limitBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const hashes = [];
    let pending = Buffer.alloc(0);
    let read = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: blockSize, start: 0, end: limitBytes - 1 });
    stream.on('data', (chunk) => {
      read += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= blockSize) {
        hashes.push(crypto.createHash('sha256').update(pending.subarray(0, blockSize)).digest('hex'));
        pending = pending.subarray(blockSize);
      }
      if (typeof onProgress === 'function') onProgress(read);
    });
    stream.on('error', (err) => reject(err));
    stream.on('end', () => {
      if (pending.length) hashes.push(crypto.createHash('sha256').update(pending).digest('hex'));
      resolve(hashes);
    });
  });
}

async function measure({ base, target, blockSize }) {
  const baseHashes = await hashFileBlocks(base.path, blockSize, Math.min(base.bytes, MAX_TOTAL_BYTES));
  const targetHashes = await hashFileBlocks(target.path, blockSize, Math.min(target.bytes, MAX_TOTAL_BYTES));
  const seen = new Set(baseHashes);
  let hits = 0;
  let savedBytes = 0;
  for (const hash of targetHashes) {
    if (!seen.has(hash)) continue;
    hits += 1;
    savedBytes += blockSize;
  }
  return { baseHashes, targetHashes, hits, savedBytes };
}

function writeReport(report) {
  try {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.warn(`[差分实测] 报告没能写入 ${REPORT_FILE}：${error && error.message}`);
    return false;
  }
}

async function main() {
  const blockSize = normalizeBlockSize(readArg('block-size', DEFAULT_BLOCK_SIZE));
  const dryRun = hasFlag('dry-run');
  const pair = pickPair({ target: readArg('target', ''), base: readArg('base', '') });

  if (dryRun) {
    info(`块大小：${formatBytes(blockSize)}（闸门 ${formatPercent(DIFF_GATE)}）`);
    info(`目标包：${pair.target ? `${pair.target.path}（${formatBytes(pair.target.bytes)}）` : '没找到'}`);
    info(`基线包：${pair.base ? `${pair.base.path}（${formatBytes(pair.base.bytes)}）` : '没找到'}`);
    info('--dry-run：什么都没读、什么都没写。');
    return 0;
  }

  const plan = planDeltaMeasure({ base: pair.base || {}, target: pair.target || {}, blockSize });
  const base = {
    base: pair.base || {},
    target: pair.target || {},
    blockSize: plan.blockSize || blockSize,
  };
  if (!plan.ok) {
    const failure = summarizeDeltaMeasure(base);
    writeReport(failure);
    info(`没量成：${plan.error}`);
    info(`已经把原因写进 ${REPORT_FILE}，设置页里能看到。`);
    return 0;
  }

  let measured;
  try {
    measured = await measure({ base: pair.base, target: pair.target, blockSize: base.blockSize });
  } catch (error) {
    const failure = summarizeDeltaMeasure(base);
    writeReport(failure);
    console.warn(`[差分实测] 读文件失败：${error && error.message}`);
    return 1;
  }

  const report = normalizeDeltaReport(
    summarizeDeltaMeasure({
      base: pair.base,
      target: pair.target,
      blockSize: base.blockSize,
      blocks: measured.targetHashes.length,
      hits: measured.hits,
      savedBytes: measured.savedBytes,
      at: Date.now(),
    }),
  );
  writeReport(report);
  const rate = describeDeltaRate({
    blocks: measured.targetHashes.length,
    hits: measured.hits,
    savedBytes: measured.savedBytes,
    blockSize: base.blockSize,
  });
  info(
    `${pair.base.version || '基线'} → ${pair.target.version || '目标'}：` +
      `${measured.targetHashes.length} 块 / 命中 ${measured.hits} / ${formatPercent(rate.hitRate)}`,
  );
  info(rate.text);
  info(`报告已写入 ${REPORT_FILE}`);
  return 0;
}

main().then((code) => process.exit(code === undefined ? 0 : code), (error) => {
  console.error(`[差分实测] 未预料的错误：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
