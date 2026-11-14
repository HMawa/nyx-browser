'use strict';

/**
 * 夜间安装器 e2e 的结果状态（纯逻辑，零 Electron）。
 *
 * 数据来自 `scripts/nightly-e2e.js --run` 写下的 `<userData>/nightly-e2e.json`。
 * 为什么要把它搬进设置页：这条每天夜里跑一次、跑一次要十几分钟、还要管理员权限，
 * 结果以前只躺在 `docs/安装器e2e夜间记录.md` 里——不看文档就不知道昨晚到底跑没跑、过没过。
 *
 * 三条判定：
 *   1. 从没跑过 → 明确说"还没跑过"，并给出怎么跑（不是一片空白）；
 *   2. 跑过但失败 → 失败就是失败，把失败原因原样带出来，不许只说"有记录"；
 *   3. 超过 STALE_HOURS 没更新 → 提示"最近一次是 N 天前"，避免拿一份上周的结果当今天的状态。
 */

const STALE_HOURS = 48;
const DAY_MS = 24 * 60 * 60 * 1000;

function pickNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/** 归一夜间 e2e 状态：没有可信的 at 一律返回 null（`{}` 不算"跑过"） */
function normalizeNightlyStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at: Math.round(at),
    ok: raw.ok === true,
    baseline: typeof raw.baseline === 'string' ? raw.baseline.slice(0, 32) : '',
    total: pickNumber(raw.total),
    passed: pickNumber(raw.passed),
    failed: pickNumber(raw.failed),
    skipped: pickNumber(raw.skipped),
    error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : '',
    log: typeof raw.log === 'string' ? raw.log.slice(0, 200) : '',
    task: typeof raw.task === 'string' ? raw.task.slice(0, 120) : '',
  };
}

function formatTime(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '—';
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function ageText(at, now) {
  const delta = Math.max(0, Number(now) - Number(at));
  if (delta < 60 * 1000) return '刚刚';
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / (60 * 1000))} 分钟前`;
  if (delta < DAY_MS) return `${Math.floor(delta / (60 * 60 * 1000))} 小时前`;
  return `${Math.floor(delta / DAY_MS)} 天前`;
}

/**
 * 给界面用的描述。
 * level：never（还没跑过）/ pass / fail / stale（跑过但已经很久没更新）
 */
function describeNightlyStatus(raw, options = {}) {
  const now = Number.isFinite(Number(options.now)) && Number(options.now) > 0 ? Number(options.now) : Date.now();
  const staleHours = Number.isFinite(Number(options.staleHours)) && Number(options.staleHours) > 0
    ? Number(options.staleHours)
    : STALE_HOURS;
  const status = normalizeNightlyStatus(raw);
  if (!status) {
    return {
      ok: false,
      level: 'never',
      label: '还没跑过',
      text:
        '这台机器还没跑过夜间安装器 e2e。它要管理员权限、会临时搬走真实用户数据，' +
        '所以不在 npm run verify 里；想跑就执行 node scripts/nightly-e2e.js --run。',
      rows: [],
      at: 0,
    };
  }
  const stale = now - status.at > staleHours * 60 * 60 * 1000;
  const level = !status.ok ? 'fail' : stale ? 'stale' : 'pass';
  const label = !status.ok ? '上次失败' : stale ? '上次通过（已过期）' : '上次通过';
  const counts =
    status.total === null
      ? '断言数没读到'
      : `${status.total} 项断言` +
        (status.passed === null ? '' : ` / 通过 ${status.passed}`) +
        (status.failed === null ? '' : ` / 失败 ${status.failed}`) +
        (status.skipped === null ? '' : ` / 跳过 ${status.skipped}`);
  const head = !status.ok
    ? `最近一次夜间 e2e 失败：${status.error || '原因没记下来，看日志'}`
    : stale
      ? `最近一次夜间 e2e 通过，但已经是 ${ageText(status.at, now)}的事了，别当成今天的状态。`
      : `最近一次夜间 e2e 通过（${ageText(status.at, now)}）。`;
  const rows = [
    { label: '最近一次', value: `${formatTime(status.at)}（${ageText(status.at, now)}）` },
    { label: '结果', value: status.ok ? '通过' : `失败：${status.error || '见日志'}` },
    { label: '升级基线', value: status.baseline || '没读到' },
    { label: '断言', value: counts },
    { label: '日志', value: status.log || '—' },
  ];
  return {
    ok: status.ok,
    level,
    label,
    text: `${head}${counts}；升级基线 ${status.baseline || '没读到'}。要再跑一次：node scripts/nightly-e2e.js --run`,
    rows,
    at: status.at,
    stale,
  };
}

module.exports = {
  STALE_HOURS,
  describeNightlyStatus,
  formatTime,
  normalizeNightlyStatus,
};
