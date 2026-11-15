'use strict';

/**
 * 动效档位（清单 B2）。
 *
 * 为什么要有这一层：小按钮"看得出能点"靠三件事——边框、悬停提亮、按下有反馈。
 * 第三件需要过渡时长与缓动，而"多长算合适"因人而异：
 *   克制档：120–180ms，干净利落，默认；
 *   活泼档：略带回弹（overshoot 曲线），可选；
 *   系统开了「减少动效」：一律降到最短，且不加位移与回弹——这不是审美问题，是可用性要求。
 *
 * 另外一条硬约束（清单里点名的）：**不做外发光**。外发光在投影仪与低端屏上会糊成一团，
 * 也是"AI 味"的典型来源。能在本模块里判的都判掉，样式侧只允许 inset 阴影与焦点环。
 */

const MOTION_LEVELS = {
  calm: { id: 'calm', label: '克制', summary: '快而干脆，没有多余动作。' },
  lively: { id: 'lively', label: '活泼', summary: '略微回弹，按下更有手感。' },
};

const MOTION_ORDER = ['calm', 'lively'];

const DEFAULT_MOTION = 'calm';

// 时长与缓动都写死在这里，样式侧只读 CSS 变量，避免两处各写一套数字
const MOTION_SPECS = {
  calm: { durationMs: 150, easing: 'cubic-bezier(0.2, 0, 0.2, 1)', press: 'translateY(1px) scale(0.97)', spring: false },
  lively: { durationMs: 220, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', press: 'translateY(1px) scale(0.95)', spring: true },
};

// 系统要求减少动效时的兜底：不改手感，只把动作缩到几乎看不见
const REDUCED_MOTION_MS = 90;
const REDUCED_PRESS = 'none';

function normalizeMotionLevel(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  return MOTION_ORDER.includes(value) ? value : DEFAULT_MOTION;
}

/**
 * 决定最终生效的动效档。
 * @param {{level?: string, reducedMotion?: boolean}} input
 * @returns {{level: string, label: string, durationMs: number, easing: string, press: string, spring: boolean, reduced: boolean, reason: string}}
 */
function resolveMotion(input) {
  const wanted = normalizeMotionLevel(input && input.level);
  const reduced = Boolean(input && input.reducedMotion === true);
  if (reduced) {
    return {
      level: 'calm',
      label: MOTION_LEVELS.calm.label,
      durationMs: REDUCED_MOTION_MS,
      easing: MOTION_SPECS.calm.easing,
      press: REDUCED_PRESS,
      spring: false,
      reduced: true,
      reason: '系统开了「减少动效」，这里只保留最短过渡。',
    };
  }
  const spec = MOTION_SPECS[wanted];
  return {
    level: wanted,
    label: MOTION_LEVELS[wanted].label,
    durationMs: spec.durationMs,
    easing: spec.easing,
    press: spec.press,
    spring: spec.spring,
    reduced: false,
    reason: wanted === 'lively' ? '活泼档：按下略有回弹。' : '克制档：默认，快而干脆。',
  };
}

function describeMotion(motion) {
  // 传进来的可能是"偏好"（只有 level）也可能是"已解析结果"（有 durationMs）——两种都要能用
  const resolved = motion && Number.isFinite(motion.durationMs) ? motion : resolveMotion(motion || {});
  const head = resolved.reduced ? '动效：跟随系统（已减少）' : `动效：${resolved.label}`;
  return `${head}｜${resolved.durationMs}ms`;
}

/** 应用层样式用的 CSS 变量串，主进程与界面共用一份，避免数字漂移。 */
function motionCssVars(motion) {
  const resolved = motion && Number.isFinite(motion.durationMs) ? motion : resolveMotion(motion || {});
  return [
    `--motion-ms: ${resolved.durationMs}ms`,
    `--motion-ease: ${resolved.easing}`,
    `--motion-press: ${resolved.press}`,
  ].join('; ');
}

module.exports = {
  DEFAULT_MOTION,
  MOTION_LEVELS,
  MOTION_ORDER,
  MOTION_SPECS,
  REDUCED_MOTION_MS,
  describeMotion,
  motionCssVars,
  normalizeMotionLevel,
  resolveMotion,
};
