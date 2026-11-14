'use strict';

/**
 * 差分命中率的判定与文案（纯逻辑，零 Electron 依赖）。
 *
 * 为什么单独一个模块：设置页要把「这次更新到底走不走差分」讲清楚，而这件事以前只在
 * 发版机上靠人跑 `scripts/measure-delta.js` 才知道。判定与文案必须能被断言直接调用，
 * 不能埋在 IPC 里。
 *
 * 一条硬规则：**命中率低于闸门（20%）时，更新走整包下载**。零命中时逐块 Range 会变成
 * 几百次请求、字节数还等于整包，比直接下整包更慢，所以这里必须如实说"这次就是整包"，
 * 不能让用户以为还有优化空间。
 */

const DEFAULT_BLOCK_SIZE = 512 * 1024;
const BLOCK_SIZES = [512 * 1024, 256 * 1024, 128 * 1024];
const MIN_BLOCK_SIZE = 32 * 1024;
const MAX_BLOCK_SIZE = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_BLOCKS = 8192;
const DIFF_GATE = 0.2;
const GATE_SOURCE = 'server';

function normalizeBlockSize(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BLOCK_SIZE;
  if (value < MIN_BLOCK_SIZE) return MIN_BLOCK_SIZE;
  if (value > MAX_BLOCK_SIZE) return MAX_BLOCK_SIZE;
  return Math.round(value);
}

function formatPercent(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value < 0) return '—';
  const clamped = Math.min(1, value);
  return `${(clamped * 100).toFixed(2)}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} 字节`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 校验要拿来量的一对文件：必须都存在、都不为空、总量不超上限。
 * 返回 {ok, error} 或 {ok:true, totalBytes, blocks}。
 */
function planDeltaMeasure(input) {
  const base = input && input.base ? input.base : {};
  const target = input && input.target ? input.target : {};
  const baseBytes = Number(base.bytes);
  const targetBytes = Number(target.bytes);
  if (!base.path) {
    return { ok: false, code: 'NO_BASE', error: '更新源里没有上一版的安装包，量不了差分。' };
  }
  if (!target.path) {
    return { ok: false, code: 'NO_TARGET', error: '更新源里没有当前版本的安装包，量不了差分。' };
  }
  if (!Number.isFinite(baseBytes) || baseBytes <= 0) {
    return { ok: false, code: 'BAD_BASE', error: '上一版的安装包读不到大小（可能已被清理）。', base: base.path };
  }
  if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
    return { ok: false, code: 'BAD_TARGET', error: '当前版本的安装包读不到大小。', target: target.path };
  }
  const blockSize = normalizeBlockSize(input && input.blockSize);
  const totalBytes = baseBytes + targetBytes;
  if (totalBytes > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      code: 'TOO_LARGE',
      error: `两个包合计 ${formatBytes(totalBytes)}，超过 ${formatBytes(MAX_TOTAL_BYTES)} 的测量上限。`,
      totalBytes,
    };
  }
  const blocks = Math.ceil(targetBytes / blockSize);
  if (blocks > MAX_BLOCKS) {
    return {
      ok: false,
      code: 'TOO_MANY_BLOCKS',
      error: `按 ${formatBytes(blockSize)} 切会得到 ${blocks} 块，超过 ${MAX_BLOCKS} 块的上限，换大一点的块再量。`,
      blocks,
    };
  }
  return { ok: true, blockSize, totalBytes, blocks, baseBytes, targetBytes };
}

/**
 * 把测量结果变成一句人话 + 一个结论级别。
 * level: gate（低于闸门，走整包）/ diff（能走差分）/ none（一块都没命中）/ unknown
 */
function describeDeltaRate(input) {
  const blocks = Number(input && input.blocks);
  const hits = Number(input && input.hits);
  const savedBytes = Number(input && input.savedBytes);
  const blockSize = normalizeBlockSize(input && input.blockSize);
  if (!Number.isFinite(blocks) || blocks <= 0) {
    return { level: 'unknown', hitRate: 0, text: '没有可比对的块，量不出命中率。' };
  }
  const safeHits = Number.isFinite(hits) && hits > 0 ? Math.min(hits, blocks) : 0;
  const hitRate = safeHits / blocks;
  const saved = Number.isFinite(savedBytes) && savedBytes > 0 ? savedBytes : 0;
  const head = `块大小 ${formatBytes(blockSize)}，共 ${blocks} 块，命中 ${safeHits} 块（${formatPercent(hitRate)}）`;
  if (safeHits === 0) {
    return {
      level: 'none',
      hitRate: 0,
      text: `${head}：一块都没命中——安装包是固实压缩的，改一点就整体错位。这次更新会整包下载，逐块差分反而更慢（几百次请求、字节数还等于整包）。`,
    };
  }
  if (hitRate < DIFF_GATE) {
    return {
      level: 'gate',
      hitRate,
      text: `${head}：低于 ${Math.round(DIFF_GATE * 100)}% 的闸门，这次更新仍走整包下载（能省 ${formatBytes(saved)}，但不值得为它冒多请求的风险）。`,
    };
  }
  return {
    level: 'diff',
    hitRate,
    text: `${head}：超过 ${Math.round(DIFF_GATE * 100)}% 的闸门，可以走差分，预计少下 ${formatBytes(saved)}。`,
  };
}

/** 汇总成设置页要的一整包（含时间与文件来源，便于"为什么是这个数字"追溯） */
function summarizeDeltaMeasure(input) {
  const base = input && input.base ? input.base : {};
  const target = input && input.target ? input.target : {};
  const plan = planDeltaMeasure({ base, target, blockSize: input && input.blockSize });
  if (!plan.ok) {
    return { ok: false, code: plan.code, error: plan.error, at: Number(input && input.at) || Date.now() };
  }
  const described = describeDeltaRate({
    blocks: input && input.blocks,
    hits: input && input.hits,
    savedBytes: input && input.savedBytes,
    blockSize: plan.blockSize,
  });
  return {
    ok: true,
    at: Number(input && input.at) || Date.now(),
    blockSize: plan.blockSize,
    blocks: Number(input && input.blocks) || 0,
    hits: Number(input && input.hits) || 0,
    hitRate: described.hitRate,
    hitRateText: formatPercent(described.hitRate),
    level: described.level,
    text: described.text,
    gate: DIFF_GATE,
    gateSource: GATE_SOURCE,
    base: { path: base.path, version: base.version || '', bytes: Number(base.bytes) || 0 },
    target: { path: target.path, version: target.version || '', bytes: Number(target.bytes) || 0 },
  };
}

/** 读回来的报告做一次归一（旧版本可能缺字段），坏数据返回 null 而不是抛错 */
function normalizeDeltaReport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 时间戳是一切的前提：没有 at 说明这不是我们写出去的完整报告（多半是坏文件或空对象）
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (raw.ok !== true) {
    return {
      ok: false,
      code: typeof raw.code === 'string' ? raw.code : 'UNKNOWN',
      error: typeof raw.error === 'string' ? raw.error : '上次量差分失败了。',
      at,
    };
  }
  return {
    ok: true,
    at,
    blockSize: normalizeBlockSize(raw.blockSize),
    blocks: Number(raw.blocks) || 0,
    hits: Number(raw.hits) || 0,
    hitRate: Number(raw.hitRate) || 0,
    hitRateText: typeof raw.hitRateText === 'string' ? raw.hitRateText : formatPercent(raw.hitRate),
    level: ['gate', 'diff', 'none', 'unknown'].includes(raw.level) ? raw.level : 'unknown',
    text: typeof raw.text === 'string' ? raw.text : '',
    gate: typeof raw.gate === 'number' ? raw.gate : DIFF_GATE,
    base: raw.base && typeof raw.base === 'object' ? raw.base : { path: '', version: '', bytes: 0 },
    target: raw.target && typeof raw.target === 'object' ? raw.target : { path: '', version: '', bytes: 0 },
  };
}

module.exports = {
  BLOCK_SIZES,
  DEFAULT_BLOCK_SIZE,
  DIFF_GATE,
  MAX_BLOCKS,
  MAX_TOTAL_BYTES,
  MIN_BLOCK_SIZE,
  MAX_BLOCK_SIZE,
  describeDeltaRate,
  formatBytes,
  formatPercent,
  normalizeBlockSize,
  normalizeDeltaReport,
  planDeltaMeasure,
  summarizeDeltaMeasure,
};
