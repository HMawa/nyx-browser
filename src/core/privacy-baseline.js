/**
 * 隐私自检的「对照基准」（1.20.0，P1-1）。
 *
 * 解决的问题：设置页里的自检是"给现在的用户看的"，跑完就没了；发版之间
 * "这次比上次少伪装了什么"没有任何可复现的依据。基准文件就是那份依据。
 *
 * 硬口径（写死在这里，别改成"看起来更强"的说法）：
 *   · 基准**只存结论**：id / level / title / reason。观察值、真实值一律不出本机；
 *   · reason 里会带真值（"页面读到的核数 24 与本机真实核数一致"），所以写盘前必须
 *     把真值、内网地址、长十六进制串打掉——只藏列不藏句子等于换个地方公开；
 *   · 比对只看 level（观察值本来就该逐次不同：画布噪声按输入确定，但哈希不该进仓库）；
 *   · 不做分数、不联网、不引用任何第三方服务。
 *
 * 纯逻辑，不 require electron / fs，方便直接断言。
 */

'use strict';

const BASELINE_KIND = 'nyx-privacy-baseline';
const HIDDEN = '—（已隐藏）';
/** 仓库里最多留这么多份（按日期文件名排序），老的由脚本删。 */
const MAX_BASELINES = 12;

/** 与 `scripts/privacy-audit.js` 里那份口径一致：两项以上数字、三项以上字符串才算真值。 */
function secretsOfRows(rows) {
  const found = new Set();
  const add = (value) => {
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (!text) return;
    if (/^\d+$/.test(text) ? text.length >= 2 : text.length >= 3) found.add(text);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const truth = row.truth;
    if (truth === null || truth === undefined) continue;
    if (Array.isArray(truth)) truth.forEach(add);
    else if (typeof truth === 'object') Object.keys(truth).forEach((key) => add(truth[key]));
    else add(truth);
  }
  return Array.from(found);
}

/**
 * 把一段文字里的「不该出门的东西」打掉。
 *
 * 三类：已知真值（来自 truth 列）、IPv4/IPv6 地址、以及 24 位以上的十六进制串
 * （画布/音频哈希、WebGL unmasked renderer 里的哈希段都长这样）。
 */
function scrubText(text) {
  let out = String(text === null || text === undefined ? '' : text);
  // IPv4
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, HIDDEN);
  // IPv6：至少两个冒号才算地址（`2001:db8::1` 这种缩写也要盖住）。
  // 只要一个冒号的（`12:30` 这种时间）不动，否则会把正常的时间描述洗掉。
  out = out.replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, HIDDEN);
  // 长十六进制串（哈希）
  out = out.replace(/\b[0-9a-f]{24,}\b/gi, HIDDEN);
  return out;
}

/** 把已知真值也一起打掉（在 scrubText 之后调用；字符串与数字各按各的口径）。 */
function scrubSecrets(text, secrets) {
  let out = scrubText(text);
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (!secret) continue;
    if (/^\d+$/.test(secret)) {
      out = out.replace(new RegExp(`(^|[^\\d.])${secret}(?![\\d.])`, 'g'), (whole, before) => `${before}${HIDDEN}`);
    } else if (out.indexOf(secret) >= 0) {
      out = out.split(secret).join(HIDDEN);
    }
  }
  return out;
}

/** 从一行判定结果里挑出「可以出门」的四个字段；缺的给空串/未知，不猜。 */
function pickRow(row) {
  const id = String((row && row.id) || '').trim();
  if (!id) return null;
  return {
    id,
    level: String((row && row.level) || 'unknown'),
    title: String((row && (row.title || row.id)) || id),
    reason: String((row && row.reason) || ''),
  };
}

/**
 * 生成一份基准。
 *
 * @param {Array} rows 判定结果（含 observed / truth，只在这里用于"打掉真值"）
 * @param {Object} meta 版本 / 运行时 / 时间 / 身份 / 内核
 * @param {Object} [options] `{ at }` 可指定时间（测试用）
 */
function buildBaseline(rows, meta, options) {
  const info = meta && typeof meta === 'object' ? meta : {};
  const secrets = secretsOfRows(rows);
  const counts = { leak: 0, suspect: 0, unknown: 0, masked: 0, pass: 0 };
  const picked = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = pickRow(row);
    if (!item) continue;
    item.reason = scrubSecrets(item.reason, secrets);
    if (Object.prototype.hasOwnProperty.call(counts, item.level)) counts[item.level] += 1;
    picked.push(item);
  }
  const at = (options && options.at) || info.at || new Date().toISOString();
  return {
    kind: BASELINE_KIND,
    at,
    version: String(info.version || ''),
    electron: String(info.electron || ''),
    chromium: String(info.chromium || ''),
    identity: String(info.identity || ''),
    kernelRunning: Boolean(info.kernelRunning),
    counts,
    rows: picked,
  };
}

/** 一行中文话，给界面/脚本直接用。 */
function describeBaseline(baseline) {
  if (!baseline || !Array.isArray(baseline.rows) || baseline.rows.length === 0) {
    return '这份基准是空的，没法对照。';
  }
  const counts = baseline.counts && typeof baseline.counts === 'object' ? baseline.counts : {};
  const parts = [];
  const order = [
    ['leak', '泄漏'],
    ['suspect', '可疑'],
    ['unknown', '测不到'],
    ['masked', '已伪装'],
    ['pass', '正常'],
  ];
  for (const [key, label] of order) {
    const n = Number(counts[key]) || 0;
    if (n > 0) parts.push(`${label} ${n}`);
  }
  const day = String(baseline.at || '').slice(0, 10) || '日期未知';
  return `${day} 生成（${baseline.version || '版本未知'}）：${baseline.rows.length} 项｜${parts.join(' / ')}`;
}

/**
 * 解析一份基准文件。
 *
 * 这里同时是**入库守卫**：如果文件里出现 `observed` 或 `truth` 字段，直接判不合法——
 * 那说明有人把含真值的报告改名塞进了 `docs/privacy-baseline/`。
 */
function parseBaseline(text) {
  let data = null;
  try {
    data = typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : text;
  } catch (error) {
    return { ok: false, error: `基准文件不是合法 JSON：${error.message}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '基准文件内容不是一个对象' };
  if (data.kind !== BASELINE_KIND) {
    return { ok: false, error: `基准文件的 kind 不对（期望 ${BASELINE_KIND}，实际 ${String(data.kind || '空')}）` };
  }
  if (!Array.isArray(data.rows)) return { ok: false, error: '基准文件缺少 rows 数组' };
  for (const row of data.rows) {
    if (!row || typeof row !== 'object') return { ok: false, error: '基准文件里有不是对象的行' };
    if (Object.prototype.hasOwnProperty.call(row, 'observed') || Object.prototype.hasOwnProperty.call(row, 'truth')) {
      return { ok: false, error: `基准文件里出现了观察值/真实值（${String(row.id || '未知项')}），基准只许存结论` };
    }
    if (!row.id) return { ok: false, error: '基准文件里有一行没有 id' };
    if (!row.level) return { ok: false, error: `基准文件里的 ${row.id} 没有 level` };
  }
  return { ok: true, baseline: data };
}

/** 单行友好标签，比对结果里用。 */
function levelLabel(level) {
  const table = {
    leak: '泄漏',
    suspect: '可疑',
    unknown: '测不到',
    masked: '已伪装',
    pass: '正常',
  };
  return table[String(level)] || String(level || '未知');
}

/**
 * 把这一次的自检结果与基准比一遍。
 *
 * 只比 level：比观察值没有意义（每次画布噪声都不同），比真值更不允许（真值不该离开本机）。
 * `comparable:false` 表示"没得比"，并给出中文原因，别让界面显示一个空的"完全一致"。
 */
function compareBaseline(currentRows, baseline) {
  const rows = Array.isArray(currentRows) ? currentRows : [];
  if (!baseline || !Array.isArray(baseline.rows) || baseline.rows.length === 0) {
    return { comparable: false, error: '没有可用的对照基准', lines: [], changed: [], missing: [], added: [], sameCount: 0 };
  }
  if (rows.length === 0) {
    return { comparable: false, error: '这一次还没跑出自检结果，先点「运行自检」', lines: [], changed: [], missing: [], added: [], sameCount: 0 };
  }
  const before = new Map();
  for (const row of baseline.rows) if (row && row.id) before.set(row.id, String(row.level || 'unknown'));
  const now = new Map();
  for (const row of rows) if (row && row.id) now.set(row.id, String(row.level || 'unknown'));

  const changed = [];
  const missing = [];
  const added = [];
  let sameCount = 0;
  for (const [id, level] of now) {
    if (!before.has(id)) added.push({ id, level, text: `${id} 新增（${levelLabel(level)}）` });
    else if (before.get(id) !== level) {
      changed.push({ id, from: before.get(id), to: level, text: `${id} ${levelLabel(before.get(id))} → ${levelLabel(level)}` });
    } else sameCount += 1;
  }
  for (const [id, level] of before) {
    if (!now.has(id)) missing.push({ id, level, text: `${id} 基准里有、这一次没有（${levelLabel(level)}）` });
  }

  const lines = [...changed.map((item) => item.text), ...added.map((item) => item.text), ...missing.map((item) => item.text)];
  if (lines.length === 0) lines.push(`与基准完全一致（${sameCount} 项）`);
  return { comparable: true, error: '', lines, changed, missing, added, sameCount };
}

/** `docs/privacy-baseline/2026-11-23.json` 这种文件名。 */
function baselineFileName(at) {
  const text = String(at || new Date().toISOString());
  const day = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${day}.json`;
}

/** 只保留最新的若干份（按文件名倒序，`YYYY-MM-DD.json` 排序即时间序）。 */
function keepLatestNames(names, limit) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_BASELINES;
  const list = (Array.isArray(names) ? names : []).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(String(name)));
  const sorted = list.slice().sort().reverse();
  return { keep: sorted.slice(0, max), drop: sorted.slice(max) };
}

module.exports = {
  BASELINE_KIND,
  HIDDEN,
  MAX_BASELINES,
  baselineFileName,
  buildBaseline,
  compareBaseline,
  describeBaseline,
  keepLatestNames,
  levelLabel,
  parseBaseline,
  scrubSecrets,
  scrubText,
  secretsOfRows,
};
