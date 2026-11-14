'use strict';

/**
 * 归档轮换：把更新源留档里的旧安装包同步到 `dist/legacy`。
 *
 * 为什么要它：`transport` 里 `--cross` 跨两版实测靠 `dist/legacy` 自动找基线，
 * 之前是手工复制，换机器/清理 dist 之后就"以为测过其实没跑"。这个脚本把它做成一条命令。
 *
 * 几条刻意的规矩（都是踩过的坑）：
 *   - 只认「文件名里的版本能读出来」的包，读不出来就报出来、不复制；
 *   - 已存在且大小一致 → 报「一致」，不重复复制；
 *   - 已存在但大小不同 → **不覆盖**，直接失败（同名不同字节会让升级判定混乱，1.17.2 踩过）；
 *   - 默认保留最老的 N 份（跨两版要的就是最老那份），`--prune` 才删多余的；
 *   - 一切都不静默：复制了哪些、跳过了哪些、删了哪些，最后逐条打印。
 *
 * 用法：
 *   node scripts/sync-legacy.js                 同步（默认保留最老 2 份）
 *   node scripts/sync-legacy.js --keep=3        保留最老 3 份
 *   node scripts/sync-legacy.js --prune         删掉 dist\legacy 里不在保留集合里的包
 *   node scripts/sync-legacy.js --dry-run       只看会做什么，不动文件
 *   node scripts/sync-legacy.js --from-dir=<dir> 指定留档目录（默认 %APPDATA%\Nyx\updates-archive）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'dist', 'legacy');
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const SETUP_RE = /^Nyx-Setup-(\d+\.\d+\.\d+)\.exe$/i;
const MIN_BYTES = 50 * 1024 * 1024;

function say(text) {
  console.log(`[Nyx] ${text}`);
}

function warn(text) {
  console.warn(`[Nyx] ${text}`);
}

function fail(text) {
  console.error(`[Nyx] ${text}`);
  process.exit(1);
}

function argValue(prefix) {
  const hit = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return hit ? hit.slice(prefix.length + 1) : '';
}

function compareVersion(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${bytes} 字节`;
}

/** 扫留档目录：每个版本里找一个能读出 x.y.z 的安装包。 */
function scanArchive(archiveRoot) {
  if (!fs.existsSync(archiveRoot)) {
    fail(`留档目录不存在：${archiveRoot}\n  说明这台机器还没发布过版本（或在另一台机器上发的）。`);
  }
  const found = [];
  const skipped = [];
  for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const version = entry.name;
    const dir = path.join(archiveRoot, version);
    const files = fs.readdirSync(dir).filter((name) => SETUP_RE.test(name));
    if (!files.length) {
      skipped.push({ version, reason: '目录里没有 Nyx-Setup-<版本>.exe' });
      continue;
    }
    if (!VERSION_RE.test(version)) {
      skipped.push({ version, reason: '目录名不是 x.y.z' });
      continue;
    }
    const file = files[0];
    const nameVersion = file.match(SETUP_RE)[1];
    if (compareVersion(nameVersion, version) !== 0) {
      skipped.push({ version, reason: `文件名里的版本是 ${nameVersion}，与目录名不一致` });
      continue;
    }
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.size < MIN_BYTES) {
      skipped.push({ version, reason: `文件只有 ${formatBytes(stat.size)}，不像完整安装包` });
      continue;
    }
    found.push({ version, file, source: full, bytes: stat.size });
  }
  found.sort((a, b) => compareVersion(a.version, b.version));
  return { found, skipped };
}

function scanLegacy() {
  if (!fs.existsSync(LEGACY_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(LEGACY_DIR)) {
    const hit = name.match(SETUP_RE);
    if (!hit) continue;
    const full = path.join(LEGACY_DIR, name);
    out.push({ version: hit[1], name, path: full, bytes: fs.statSync(full).size });
  }
  out.sort((a, b) => compareVersion(a.version, b.version));
  return out;
}

function main() {
  const keep = Math.max(1, Number(argValue('--keep')) || 2);
  const prune = process.argv.includes('--prune');
  const dryRun = process.argv.includes('--dry-run');
  const archiveRoot = argValue('--from-dir')
    ? path.resolve(argValue('--from-dir'))
    : path.join(process.env.APPDATA || '', 'Nyx', 'updates-archive');

  say(`留档目录：${archiveRoot}`);
  const { found, skipped } = scanArchive(archiveRoot);
  if (!found.length) {
    fail(
      '留档里没有可用的安装包，什么都不做。\n' +
        '  先确认这台机器发布过版本（%APPDATA%\\Nyx\\updates-archive），或用 --from-dir 指定目录。',
    );
  }

  say(`留档里可用：${found.map((item) => item.version).join('、')}`);
  for (const item of skipped) warn(`跳过 ${item.version}：${item.reason}`);

  fs.mkdirSync(LEGACY_DIR, { recursive: true });
  const existing = scanLegacy();
  const existingByVersion = new Map(existing.map((item) => [item.version, item]));

  // 保留集合 = 「留档里的版本」与「dist\legacy 里已有的版本」的并集，取最老的 N 份。
  // 为什么要把已有的算进来：留档会被发版脚本按数量清理（1.16.0 就是这么没的），
  // 但 dist\legacy 里那份恰恰是跨两版最想要的基线，不能因为它不在留档里就当成多余。
  const pool = new Map();
  for (const item of found) pool.set(item.version, { version: item.version, bytes: item.bytes });
  for (const item of existing) {
    if (!pool.has(item.version)) pool.set(item.version, { version: item.version, bytes: item.bytes });
  }
  const sortedPool = Array.from(pool.values()).sort((a, b) => compareVersion(a.version, b.version));
  const keepVersions = new Set(sortedPool.slice(0, keep).map((item) => item.version));
  say(`保留集合（最老 ${keep} 份）：${Array.from(keepVersions).join('、')}`);

  let copied = 0;
  let same = 0;
  const conflicts = [];

  for (const item of found) {
    if (!keepVersions.has(item.version)) continue;
    const target = path.join(LEGACY_DIR, item.file);
    const current = existingByVersion.get(item.version);
    if (current) {
      if (current.bytes === item.bytes) {
        same += 1;
        say(`一致：${item.file}（${formatBytes(item.bytes)}）`);
        continue;
      }
      conflicts.push(
        `${item.file}：dist\\legacy 里是 ${formatBytes(current.bytes)}，留档里是 ${formatBytes(item.bytes)}`,
      );
      continue;
    }
    if (dryRun) {
      say(`会复制：${item.file}（${formatBytes(item.bytes)}）`);
      continue;
    }
    fs.copyFileSync(item.source, target);
    copied += 1;
    say(`已复制：${item.file}（${formatBytes(item.bytes)}）`);
  }

  if (conflicts.length) {
    fail(
      '有同名但大小不同的包，**没有覆盖**（同名不同字节会让升级判定与差分更新混乱）：\n' +
        conflicts.map((line) => `  - ${line}`).join('\n') +
        '\n  确认哪个是正确的那份后，手动删掉 dist\\legacy 里的旧文件再重跑。',
    );
  }

  let removed = 0;
  if (prune) {
    for (const item of scanLegacy()) {
      if (keepVersions.has(item.version)) continue;
      if (dryRun) {
        say(`会删除：${item.name}（${formatBytes(item.bytes)}）`);
        continue;
      }
      fs.rmSync(item.path, { force: true });
      removed += 1;
      say(`已删除：${item.name}（${formatBytes(item.bytes)}）`);
    }
  } else if (scanLegacy().some((item) => !keepVersions.has(item.version))) {
    say('dist\\legacy 里还有不在保留集合里的包；要清理请加 --prune。');
  }

  say(
    `完成：复制 ${copied} 个，已一致 ${same} 个，删除 ${removed} 个${dryRun ? '（预演，没有动文件）' : ''}。`,
  );
  const legacy = scanLegacy();
  if (legacy.length) {
    say(`dist\\legacy 现在有：${legacy.map((item) => item.version).join('、')}`);
    say('跨两版实测：node scripts/test-installer-e2e.js --cross --installer=dist\\Nyx-Setup-<当前版本>.exe');
  }
}

main();
