'use strict';

/**
 * 标签生命周期（清单 G：性能）
 *
 * 目标：后台标签不再永远占着一个渲染进程。闲置够久就"休眠"——把
 * WebContentsView 和它的渲染进程整个释放掉，只留一条标签记录；点回来时
 * 按原地址重新加载。
 *
 * 三个必须写死的例外（清单 G 的"关键例外"）：
 *   1. 当前激活的标签永不休眠；
 *   2. 被 agent 操作过的标签在一段时间内不休眠（眼睛睁着、页面被冻 = 后续动作全失败）；
 *   3. 有 agent 会话在跑时，任何标签都不休眠（否则 agent 读到一半页面没了）。
 *
 * 这里只做"该不该睡"的判定与说明文案，不碰 Electron。
 * 真正的释放/重建在 src/core/tabs.js 里，两者用同一份判定，避免"判定说该睡、
 * 执行说没睡"的分裂。
 */

/** 生命周期状态 */
const LIFECYCLE_STATES = {
  active: 'active',
  background: 'background',
  asleep: 'asleep',
};

const LIFECYCLE_LABELS = {
  active: '正在使用',
  background: '后台运行',
  asleep: '已休眠',
};

/** 默认闲置多久才休眠：30 分钟（用户可感知但不会打断正常浏览） */
const DEFAULT_SLEEP_AFTER_MS = 30 * 60 * 1000;

/** 允许的最小休眠阈值：1 秒。更小的值只用于自动化验证，正常设置不该这么小 */
const MIN_SLEEP_AFTER_MS = 1000;

/** agent 操作过之后保持唤醒的时长：2 分钟 */
const AGENT_KEEP_AWAKE_MS = 2 * 60 * 1000;

/** 休眠判定的原因码 → 中文说明（审计与调试都用它，不许出现空原因） */
const LIFECYCLE_REASONS = {
  'active-tab': '这是当前正在用的标签，不休眠',
  'agent-session': 'agent 会话正在运行，所有标签都保持唤醒',
  'agent-driving': 'agent 刚操作过这个标签，先不休眠',
  'no-sleep': '休眠已关闭，标签都留在后台运行',
  'idle': '后台闲置超过阈值，休眠以释放内存',
  'idle-below': '后台闲置还没到阈值',
  'already-asleep': '已经在休眠',
  'disabled-by-option': '这个标签不参与休眠',
};

/**
 * 解析休眠阈值。
 *
 * @param {unknown} raw 配置值（毫秒）
 * @param {number} [fallback] 解析不出来时用的值
 * @returns {number} 0 表示关闭休眠；其余保证 ≥ MIN_SLEEP_AFTER_MS
 */
function normalizeSleepAfter(raw, fallback = DEFAULT_SLEEP_AFTER_MS) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  if (value === 0) {
    // 0 = 明确关闭休眠（不是"立刻休眠"，立刻休眠会让浏览变成一团乱）
    return 0;
  }
  return Math.max(MIN_SLEEP_AFTER_MS, Math.round(value));
}

/**
 * 读环境变量里的休眠阈值（自动化验证用，默认仍是 30 分钟）。
 *
 * @param {Record<string,string|undefined>} env
 * @returns {number}
 */
function readSleepAfterFromEnv(env) {
  const source = env || {};
  if (!source.NYX_TAB_SLEEP_MS) return DEFAULT_SLEEP_AFTER_MS;
  return normalizeSleepAfter(source.NYX_TAB_SLEEP_MS, DEFAULT_SLEEP_AFTER_MS);
}

/**
 * 判定一个标签该处于哪种状态。
 *
 * @param {object} input
 * @param {boolean} input.isActive 是否为当前标签
 * @param {boolean} [input.asleep] 当前是否已休眠
 * @param {number} input.idleMs 距上次离开该标签的毫秒数
 * @param {number} [input.sleepAfterMs] 休眠阈值（0 = 关闭）
 * @param {number} [input.agentDrivenUntil] agent 保持唤醒的截止时间戳
 * @param {number} [input.now] 当前时间戳
 * @param {boolean} [input.agentSessionActive] 是否有 agent 会话在跑
 * @param {boolean} [input.noSleep] 该标签被显式排除在休眠之外
 * @returns {{state:'active'|'background'|'asleep', reason:string, reasonLabel:string, keepAwake:boolean}}
 */
function decideTabLifecycle(input) {
  const data = input && typeof input === 'object' ? input : {};
  const now = Number.isFinite(data.now) ? data.now : Date.now();
  const sleepAfterMs = data.sleepAfterMs === undefined ? DEFAULT_SLEEP_AFTER_MS : Number(data.sleepAfterMs);

  const result = (state, reason, keepAwake) => ({
    state,
    reason,
    reasonLabel: LIFECYCLE_REASONS[reason] || reason,
    keepAwake: Boolean(keepAwake),
  });

  if (data.isActive) {
    return result(LIFECYCLE_STATES.active, 'active-tab', true);
  }
  if (data.agentSessionActive) {
    // 有 agent 在跑：谁都不许睡，否则它读到一半页面就没了
    return result(LIFECYCLE_STATES.background, 'agent-session', true);
  }
  if (data.noSleep) {
    return result(data.asleep ? LIFECYCLE_STATES.asleep : LIFECYCLE_STATES.background, 'disabled-by-option', true);
  }
  const drivenUntil = Number(data.agentDrivenUntil) || 0;
  if (drivenUntil > now) {
    return result(LIFECYCLE_STATES.background, 'agent-driving', true);
  }
  if (!sleepAfterMs) {
    return result(
      data.asleep ? LIFECYCLE_STATES.asleep : LIFECYCLE_STATES.background,
      'no-sleep',
      true,
    );
  }
  if (data.asleep) {
    return result(LIFECYCLE_STATES.asleep, 'already-asleep', false);
  }
  const idleMs = Number(data.idleMs);
  const idle = Number.isFinite(idleMs) && idleMs > 0 ? idleMs : 0;
  if (idle >= sleepAfterMs) {
    return result(LIFECYCLE_STATES.asleep, 'idle', false);
  }
  return result(LIFECYCLE_STATES.background, 'idle-below', false);
}

/** 状态 → 中文标签 */
function describeLifecycle(state) {
  return LIFECYCLE_LABELS[state] || LIFECYCLE_LABELS.background;
}

/**
 * 汇总一组判定结果（快照 / 设置页展示用）。
 *
 * @param {Array<{state:string}>} decisions
 * @returns {{total:number, active:number, background:number, asleep:number, keptAwake:number, text:string}}
 */
function summarizeLifecycle(decisions) {
  const list = Array.isArray(decisions) ? decisions.filter(Boolean) : [];
  const active = list.filter((item) => item.state === LIFECYCLE_STATES.active).length;
  const asleep = list.filter((item) => item.state === LIFECYCLE_STATES.asleep).length;
  const background = list.length - active - asleep;
  const keptAwake = list.filter((item) => item.keepAwake).length;
  const parts = [`共 ${list.length} 个标签`, `${active} 个在用`];
  if (asleep > 0) parts.push(`${asleep} 个已休眠`);
  if (background > 0) parts.push(`${background} 个后台`);
  if (keptAwake > 0) parts.push(`${keptAwake} 个保持唤醒`);
  return { total: list.length, active, background, asleep, keptAwake, text: parts.join(' · ') };
}

/**
 * 设置页里能选的休眠时长（分钟）。0 = 不自动休眠。
 *
 * 上限 240 分钟是刻意的：再长的阈值和"从不休眠"几乎没有区别，
 * 但界面上看起来像是在保护什么，容易误导。
 */
const TAB_SLEEP_MINUTES = [0, 5, 10, 15, 30, 60, 120, 240];
const DEFAULT_SLEEP_MINUTES = Math.round(DEFAULT_SLEEP_AFTER_MS / 60000);

/**
 * 把界面上的"分钟"解析成可靠值：非法回落默认，合法但不在候选里也接受（用户手填）。
 *
 * @param {unknown} raw 分钟
 * @param {number} [fallback] 解析不出来时用的分钟数
 * @returns {number} 0 或 [1, 240]
 */
function normalizeSleepMinutes(raw, fallback = DEFAULT_SLEEP_MINUTES) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value === 0) return 0;
  return Math.min(240, Math.max(1, Math.round(value)));
}

/** 分钟 → 毫秒（0 仍表示关闭） */
function sleepMinutesToMs(minutes) {
  const safe = normalizeSleepMinutes(minutes);
  return safe === 0 ? 0 : normalizeSleepAfter(safe * 60 * 1000);
}

/** 给用户看的说明，别让他对"0"产生误解 */
function describeSleepMinutes(minutes) {
  const safe = normalizeSleepMinutes(minutes);
  if (safe === 0) return '后台标签不会自动休眠（内存占用会一直涨，不建议长期这样）';
  return `后台标签闲置 ${safe} 分钟后释放内存，点回来时按原地址重新加载`;
}

module.exports = {
  AGENT_KEEP_AWAKE_MS,
  DEFAULT_SLEEP_AFTER_MS,
  DEFAULT_SLEEP_MINUTES,
  LIFECYCLE_LABELS,
  LIFECYCLE_REASONS,
  LIFECYCLE_STATES,
  MIN_SLEEP_AFTER_MS,
  TAB_SLEEP_MINUTES,
  decideTabLifecycle,
  describeLifecycle,
  describeSleepMinutes,
  normalizeSleepAfter,
  normalizeSleepMinutes,
  readSleepAfterFromEnv,
  sleepMinutesToMs,
  summarizeLifecycle,
};
