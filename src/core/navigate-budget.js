'use strict';

/**
 * 导航超时的预算（安全审计 P1-4 的后续）。
 *
 * 起因：这个值原来是写死的 15 秒。慢站（比如要等后端渲染的站点）经常合法地超过 15 秒，
 * 于是 agent 收到「打开这个地址超过 15 秒还没完成」，而页面其实已经开好了——用户看到
 * 的是"明明打开了却说失败"。反过来，15 秒对一些站又太长，卡住时就干等。
 *
 * 所以预算做成可配：
 *   - 下限 3 秒：再短就没有任何意义，正常站点都可能来不及；
 *   - 上限 60 秒：再长就是把动作通道挂死，等于回到修复前的状态；
 *   - 任何非法值（非数字、非整数、越界、字符串）一律回默认，不猜、不夹值——
 *     悄悄把 999999 夹成 60000 会让用户以为自己配置生效了。
 *
 * 这个模块是纯逻辑（零 Electron、零 fs），方便直接断言。
 */

/** 默认预算：15 秒（与修复前的硬编码值一致，保证"没配置时行为不变"） */
const NAVIGATE_BUDGET_DEFAULT = 15000;
const NAVIGATE_BUDGET_MIN = 3000;
const NAVIGATE_BUDGET_MAX = 60000;

/**
 * 归一化一个候选值。
 * @param {*} value 用户配置或单个请求里带的值
 * @returns {number|null} 合法则返回整数毫秒，非法返回 null
 */
function normalizeNavigateBudget(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (num < NAVIGATE_BUDGET_MIN || num > NAVIGATE_BUDGET_MAX) return null;
  return num;
}

/**
 * 解析出最终要用哪个预算：合法就用它，否则回默认。
 * @param {*} value
 * @returns {number}
 */
function resolveNavigateBudget(value) {
  const num = normalizeNavigateBudget(value);
  return num == null ? NAVIGATE_BUDGET_DEFAULT : num;
}

/**
 * 给用户看的说法（报错文案里用），避免出现「18000 毫秒」这种别扭写法。
 * @param {number} ms
 * @returns {string}
 */
function describeNavigateBudget(ms) {
  const num = resolveNavigateBudget(ms);
  const seconds = num / 1000;
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}

module.exports = {
  NAVIGATE_BUDGET_DEFAULT,
  NAVIGATE_BUDGET_MIN,
  NAVIGATE_BUDGET_MAX,
  describeNavigateBudget,
  normalizeNavigateBudget,
  resolveNavigateBudget,
};
