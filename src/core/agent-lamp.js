'use strict';

/**
 * agent 状态灯（清单 A5，v1.17.9）。
 *
 * 三色只回答一个问题：**现在有没有人（或哪个 agent）正在动你的浏览器**。
 * 所以「正在被驱动」只在动作真的在执行时亮——会话刚刚结束、审计通道开着、
 * 白名单里有站点，这些都不算。灯语必须经得起"我盯着看"：
 *
 *   灰（off）   没有 agent 接入：内置接口没开、或已紧急停止。
 *   金（ready） 接入了，但此刻没有动作在跑。
 *   红（busy）  有动作正在执行（最近 ACTIVE_MS 毫秒内有过动作）。
 *
 * 另有一条「审计不完整」的常驻标识是**独立**的事（外部接入模式），
 * 不能挤进三色灯里——否则红色会同时表示"正在被驱动"和"看不全"，
 * 用户无法判断此刻到底有没有人在操作。
 */

/** 动作算「正在执行」的窗口：一次动作从派发到回执通常远小于这个值 */
const ACTIVE_MS = 4000;

const LAMP_LEVELS = {
  off: { level: 'off', label: '没有 agent 接入', tone: 'off' },
  ready: { level: 'ready', label: 'agent 已接入，当前空闲', tone: 'ready' },
  busy: { level: 'busy', label: 'agent 正在操作这个浏览器', tone: 'busy' },
};

/**
 * @param {{agentStopped?:boolean, enabled?:boolean, drivingUntil?:number, drivingAt?:number, now?:number, activeMs?:number}} input
 * @returns {{level:'off'|'ready'|'busy', label:string, tone:string, text:string, active:boolean}}
 */
function decideLamp(input) {
  const opts = input || {};
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const windowMs = Number.isFinite(opts.activeMs) && opts.activeMs > 0 ? Number(opts.activeMs) : ACTIVE_MS;

  if (opts.agentStopped === true) {
    return { ...LAMP_LEVELS.off, text: '已紧急停止：agent 的动作一律被拒，直到你点「恢复」。', active: false };
  }
  if (opts.enabled === false) {
    return { ...LAMP_LEVELS.off, text: '本地 agent 接口现在是关着的，没有 agent 能连上来。', active: false };
  }

  // 主进程给的是"截止时间"（execute 那一刻 + 4 秒）；也接受"最近一次执行时间"，
  // 两种都算得出来，不逼调用方换算——但口径只有一个：窗口一过就不再是"正在被驱动"。
  const until = Number.isFinite(opts.drivingUntil) ? Number(opts.drivingUntil) : 0;
  const since = Number.isFinite(opts.drivingAt) ? Number(opts.drivingAt) : 0;
  const busy = until > now || (until === 0 && since > 0 && now - since < windowMs);
  if (busy) {
    return { ...LAMP_LEVELS.busy, text: '有动作正在执行（或刚刚执行完）。留痕在设置 → Agent 访问。', active: true };
  }
  return { ...LAMP_LEVELS.ready, text: '接口开着，但此刻没有动作在执行。', active: false };
}

/** 面板顶部那行：灯 + 最近一次动作 + 急停按钮的说明 */
function describeLamp(lamp, extra) {
  const info = lamp || decideLamp({});
  const opts = extra || {};
  const lines = [info.text];
  if (opts.lastAction) lines.push(`最近一次：${opts.lastAction}`);
  else lines.push('最近还没有动作。');
  if (opts.auditComplete === false) lines.push('当前是外部接入模式：审计只看得到经过浏览器的部分。');
  return { level: info.level, label: info.label, text: lines.join('\n'), active: info.active };
}

module.exports = { ACTIVE_MS, LAMP_LEVELS, decideLamp, describeLamp };
