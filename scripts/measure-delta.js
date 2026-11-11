'use strict';

/**
 * 块级差分命中率测量（只读工具，不改任何文件）。
 *
 * 背景：src/core/updater.js 的差分下载会把更新包按固定块大小切块，逐块比对本地留档的
 * 上一版安装包，命中块复用本地字节、未命中块才走 HTTP Range。这个脚本用来量「真实版本
 * 之间到底能命中多少块」，从而判断差分值不值得保留、块大小该取多少。
 *
 * 用法：
 *   node scripts/measure-delta.js --base <旧安装包.exe> --target <新安装包.exe>
 *   node scripts/measure-delta.js --base ... --target ... --sizes 262144,524288,1048576
 *   node scripts/measure-delta.js --base ... --target ... --ideal 98.68
 *
 *   --sizes  逗号分隔的块大小，支持 256k / 512k / 1m 缩写，缺省 256KB、512KB、1MB
 *   --ideal  参考的理想命中率（演练值），仅用于打印对比，缺省 98.68
 *
 * 输出：每个块大小一行中文表格 + 结论行；始终退出码 0（除非参数/文件有问题）。
 * 依赖：只用 node 内置 crypto / fs，大文件走 createReadStream 分块读，内存占用与文件大小无关。
 *
 * 判断口径：
 *   - 「需传输」= 未命中块按块大小累加的字节数（相当于最小 Range 流量，不含 HTTP 头）；
 *   - 「单块请求」= 当前 updater 的朴素实现：每个未命中块发一次 Range 请求；
 *   - 「合并请求」= 未命中块在文件里连续成段时合并成一次 Range 的请求数，
 *     是「只改几处 HTTP 调用就能拿到的优化」，用来判断请求数会不会成为瓶颈。
 *
 * 实测结论（2026-10，真实留档的 113.2MB 安装包，三档块大小都跑过）：
 *   1.4.0 → 1.6.0：453 / 227 / 114 块（256KB / 512KB / 1MB）全部 0 命中，命中率 0.00%，省下 0.00%；
 *   1.5.0 → 1.6.0：同样是 0.00%，两组的未命中块都连成 1 整段。
 *   与桌面演练的 98.68% 相差 98.68 个百分点 —— 演练基线是「同一份文件改 3 处字节」，属理想情况；
 *   真实发布里 NSIS 是 LZMA 固实压缩流，改一处字节整条流都会重排，任何块都对不上。
 *   判断：块大小调大调小都一样（三档全 0%），保持 512KB 即可，别为差分改发布参数；
 *   对安装包切块的差分收益≈0，只保留「有则更好、无则降级」的兜底定位，不当作卖点；
 *   且零命中时当前实现会逐块 Range 拉全包（227 次请求），比整包更慢，建议先估算命中率、
 *   低于阈值就直接整包（属 updater 侧优化，本脚本只测量不实现）。
 *   app.asar 差分可行性（只判断）：asar 未压缩、按文件粒度切，命中率会高得多；但整包 113MB 里
 *   app.asar 只有约 9MB，天花板约 8%，且要把 asar/资源从安装包里拆出来单独分发才谈得上「省流量」，
 *   当前阶段不建议为 8% 改分发形态。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 缺省块大小：与 make-release.js 的 BLOCK_SIZE 对齐，另外测一档更小/更大的 */
const DEFAULT_SIZES = [256 * 1024, 512 * 1024, 1024 * 1024];

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function fail(message) {
  console.error(`[测量] 失败：${message}`);
  process.exit(1);
}

/** 解析块大小列表：纯字节数，或 256k / 1m 这类缩写 */
function parseSizes(text) {
  const list = String(text)
    .split(',')
    .map((raw) => raw.trim().toLowerCase())
    .filter(Boolean)
    .map((raw) => {
      const match = /^(\d+(?:\.\d+)?)\s*([km]?)b?$/.exec(raw);
      if (!match) fail(`无法识别的块大小 "${raw}"（示例：262144、256k、1m）`);
      const value = Number(match[1]);
      const unit = match[2] === 'k' ? 1024 : match[2] === 'm' ? 1024 * 1024 : 1;
      const bytes = Math.round(value * unit);
      if (!Number.isFinite(bytes) || bytes <= 0) fail(`块大小不合法："${raw}"`);
      return bytes;
    });
  if (!list.length) fail('--sizes 至少要给一个块大小');
  return [...new Set(list)];
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatBlockSize(bytes) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / 1024 / 1024} MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} B`;
}

/** 流式切块算 sha256：createReadStream 分块读，不把整个安装包读进内存 */
function blockHashes(file, blockSize) {
  return new Promise((resolve, reject) => {
    const hashes = [];
    let pending = Buffer.alloc(0);
    const stream = fs.createReadStream(file, { highWaterMark: blockSize });
    stream.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= blockSize) {
        const block = pending.subarray(0, blockSize);
        hashes.push(crypto.createHash('sha256').update(block).digest('hex'));
        pending = pending.subarray(blockSize);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (pending.length) {
        hashes.push(crypto.createHash('sha256').update(pending).digest('hex'));
      }
      resolve(hashes);
    });
  });
}

/** 流式整包 sha256 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function padRight(text, width) {
  const value = String(text);
  // 中文按两格宽估算，保证表格大致对齐
  const displayWidth = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - displayWidth));
}

function padLeft(text, width) {
  const value = String(text);
  const displayWidth = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return ' '.repeat(Math.max(0, width - displayWidth)) + value;
}

function percent(part, whole) {
  if (!whole) return '0.0%';
  return `${((part / whole) * 100).toFixed(2)}%`;
}

async function measure(base, target, sizes) {
  const baseSize = fs.statSync(base).size;
  const targetSize = fs.statSync(target).size;
  console.log(`[测量] 基线   ：${base}（${formatBytes(baseSize)}）`);
  console.log(`[测量] 目标   ：${target}（${formatBytes(targetSize)}）`);
  console.log(`[测量] 块大小 ：${sizes.map(formatBlockSize).join('、')}`);

  const [baseSha, targetSha] = [await sha256File(base), await sha256File(target)];
  const identical = baseSha === targetSha;
  console.log(`[测量] 整包 sha256：基线 ${baseSha.slice(0, 16)}…  目标 ${targetSha.slice(0, 16)}…`);
  console.log(`[测量] 整包是否完全相同：${identical ? '是（内容没变，差分可全命中）' : '否'}`);

  const rows = [];
  for (const blockSize of sizes) {
    const targetBlocks = await blockHashes(target, blockSize);
    const baseBlocks = await blockHashes(base, blockSize);
    // hash → 首个块偏移（同内容只记一次即可，命中的是哪份字节无所谓）
    const index = new Set(baseBlocks);

    let hits = 0;
    let missBytes = 0;
    let missRuns = 0;
    let previousMiss = false;
    for (let i = 0; i < targetBlocks.length; i += 1) {
      const length = Math.min(blockSize, targetSize - i * blockSize);
      const hit = index.has(targetBlocks[i]);
      if (hit) {
        hits += 1;
      } else {
        missBytes += length;
        if (!previousMiss) missRuns += 1;
      }
      previousMiss = !hit;
    }
    const missCount = targetBlocks.length - hits;
    rows.push({
      blockSize,
      blocks: targetBlocks.length,
      hits,
      missCount,
      hitRate: targetBlocks.length ? hits / targetBlocks.length : 0,
      missBytes,
      savedRate: targetSize ? 1 - missBytes / targetSize : 0,
      missRuns,
    });
  }

  // ===== 表格 =====
  console.log('');
  const header =
    padRight('块大小', 10) +
    padLeft('目标块数', 10) +
    padLeft('命中', 8) +
    padLeft('未命中', 9) +
    padLeft('命中率', 10) +
    padLeft('需传输', 12) +
    padLeft('省下', 9) +
    padLeft('请求(逐块)', 13) +
    padLeft('请求(合并)', 13);
  console.log(header);
  console.log('-'.repeat([...header].length ? header.length : 90));
  for (const row of rows) {
    console.log(
      padRight(formatBlockSize(row.blockSize), 10) +
        padLeft(row.blocks, 10) +
        padLeft(row.hits, 8) +
        padLeft(row.missCount, 9) +
        padLeft(percent(row.hits, row.blocks), 10) +
        padLeft(formatBytes(row.missBytes), 12) +
        padLeft(percent(targetSize - row.missBytes, targetSize), 9) +
        padLeft(row.missCount, 13) +
        padLeft(row.missRuns, 13),
    );
  }

  // ===== 结论 =====
  const maxSaved = Math.max(...rows.map((r) => r.savedRate));
  const minSaved = Math.min(...rows.map((r) => r.savedRate));
  // 三种块大小收益一致时，不要随便挑第一行当「推荐」（那只是最小块）
  const allEqual = maxSaved - minSaved < 0.001;
  const best = allEqual
    ? rows.find((r) => r.blockSize === 512 * 1024) || rows[0]
    : rows.find((r) => r.savedRate === maxSaved);
  const worst = allEqual ? best : rows.find((r) => r.savedRate === minSaved);
  const ideal = Number(readArg('ideal', '98.68'));
  console.log('');
  console.log('[测量] ===== 结论 =====');
  if (allEqual) {
    console.log(
      `  块大小趋势：三种块大小收益一致（均省下 ${percent(targetSize - best.missBytes, targetSize)}），` +
        '块大小对结果没有影响',
    );
  } else {
    console.log(
      `  块大小趋势：${formatBlockSize(worst.blockSize)} 省下 ${percent(targetSize - worst.missBytes, targetSize)}` +
        ` → ${formatBlockSize(best.blockSize)} 省下 ${percent(targetSize - best.missBytes, targetSize)}` +
        (best.savedRate > worst.savedRate ? '（块越大命中越容易）' : '（块大小影响很小）'),
    );
  }
  if (Number.isFinite(ideal) && ideal > 0) {
    console.log(
      `  与理想演练值对比：演练 ${ideal.toFixed(2)}% vs 本次最佳 ${(best.hitRate * 100).toFixed(2)}%` +
        `（差 ${(best.hitRate * 100 - ideal).toFixed(2)} 个百分点）`,
    );
  }

  // 收益阈值：省下不到 15% 视为「不值得依赖差分」；15%~50% 算有限；50% 以上算值得
  let verdict;
  if (best.savedRate >= 0.5) verdict = '值得保留：能稳定省下一半以上流量';
  else if (best.savedRate >= 0.15) verdict = '收益有限：可保留兜底，但别指望常态省流量';
  else verdict = '收益≈0：差分对当前发放形态基本无效，建议只当兜底、不当作卖点';

  if (allEqual) {
    console.log(
      `  推荐块大小：保持 512 KB${best.savedRate < 0.05 ? '（换块大小没有收益，不建议为此改发布参数）' : '（收益与块大小无关）'}`,
    );
  } else {
    console.log(`  推荐块大小：${formatBlockSize(best.blockSize)}（省下 ${percent(targetSize - best.missBytes, targetSize)}）`);
  }
  console.log(`  判断：${verdict}`);

  // 零命中时，逐块 Range 反而比整包更慢：请求数暴涨、字节数一样
  if (best.hitRate === 0) {
    console.log(
      `  ⚠ 零命中提醒：当前 updater 会逐块 Range 拉完整包（${best.missCount} 次请求），` +
        '字节数与整包相同但多出大量往返，比直接整包下载更慢；' +
        '建议差分前先用块清单估算命中率，低于阈值就直接走整包。',
    );
  } else if (best.missCount > 0 && best.missRuns < best.missCount) {
    console.log(
      `  请求数优化空间：未命中块 ${best.missCount} 个但只分成 ${best.missRuns} 段，` +
        `把连续未命中块合并成一次 Range 可把请求数从 ${best.missCount} 降到 ${best.missRuns}。`,
    );
  }
  if (best.missCount === 0) {
    console.log('  说明：基线所有块都能在目标里找到，差分可 100% 命中（内容几乎没变）。');
  }
  console.log('');
  console.log('  备注：NSIS 安装包是 LZMA 固实压缩流，任何代码改动都会让整条流错位，');
  console.log('        因此对安装包切块的命中率天然接近 0；要真正省流量需改为对未压缩的');
  console.log('        app.asar / 资源目录做差分（需调整打包与分发方式）。');
  return rows;
}

(async () => {
  const base = readArg('base', '');
  const target = readArg('target', '');
  if (!base || !target) {
    fail('用法：node scripts/measure-delta.js --base <旧安装包.exe> --target <新安装包.exe> [--sizes 262144,524288,1048576]');
  }
  const basePath = path.resolve(base);
  const targetPath = path.resolve(target);
  for (const [label, file] of [['基线', basePath], ['目标', targetPath]]) {
    if (!fs.existsSync(file)) fail(`${label}安装包不存在：${file}`);
    if (!fs.statSync(file).isFile()) fail(`${label}路径不是文件：${file}`);
  }
  const sizes = parseSizes(readArg('sizes', DEFAULT_SIZES.join(',')));
  await measure(basePath, targetPath, sizes);
  process.exitCode = 0;
})().catch((err) => {
  console.error(`[测量] 未捕获异常：${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
