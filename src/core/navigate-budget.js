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

/**
 * 按站点覆盖预算（用户要求：慢站单独放宽，而不是把全局值调大）。
 *
 * 为什么不是"每个站点一张表"那么复杂：用户只需要记住"这个域名等久一点"。
 * 规则就三件事——域名（含子域继承）、秒数（3–60，复用同一套边界）、条数上限。
 * 任何一条写错就整条丢掉并在解析结果里点名，**绝不悄悄按默认跑**：静默回退
 * 会让用户以为配置生效了，等到超时才发现没生效。
 */
const MAX_SITE_RULES = 50;

/** 域名归一：小写、去空白、去前导点；带路径/端口/协议的一律判非法（这里只认域名） */
function normalizeRuleHost(raw) {
  const text = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^\.+/, '');
  if (!text) return '';
  if (/[\s/\\?#]/.test(text) || text.includes(':')) return '';
  if (!text.includes('.')) return '';
  return text;
}

/**
 * 解析一行 `example.com=30`（也接受 `=` 前后空格、中文全角等号）。
 * @returns {{ok:true, rule:{host:string, ms:number}}|{ok:false, error:string}}
 */
function parseSiteRule(line) {
  const text = String(line == null ? '' : line).replace(/＝/g, '=').trim();
  if (!text || text.startsWith('#')) return { ok: false, skip: true, error: '空行或注释' };
  const at = text.indexOf('=');
  if (at < 0) return { ok: false, error: `「${text}」缺少等号，写成 example.com=30 这样` };
  const host = normalizeRuleHost(text.slice(0, at));
  if (!host) return { ok: false, error: `「${text}」左边不是一个域名（只填域名，别带 http:// 或路径）` };
  const seconds = Number(text.slice(at + 1).trim());
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    return { ok: false, error: `${host} 的秒数要写整数，例如 ${host}=30` };
  }
  const ms = normalizeNavigateBudget(seconds * 1000);
  if (ms == null) {
    return {
      ok: false,
      error: `${host} 的秒数要在 ${NAVIGATE_BUDGET_MIN / 1000}–${NAVIGATE_BUDGET_MAX / 1000} 秒之间`,
    };
  }
  return { ok: true, rule: { host, ms } };
}

/**
 * 解析整段文本（多行），返回可用规则与逐条错误。
 * 同一个域名写多次时**后者覆盖前者**，并在 rewritten 里点名。
 */
function parseSiteRules(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rules = [];
  const errors = [];
  const rewritten = [];
  for (const [index, line] of lines.entries()) {
    if (!String(line || '').trim()) continue;
    const parsed = parseSiteRule(line);
    if (parsed.ok) {
      const existing = rules.findIndex((r) => r.host === parsed.rule.host);
      if (existing >= 0) {
        rewritten.push(parsed.rule.host);
        rules[existing] = parsed.rule;
      } else if (rules.length >= MAX_SITE_RULES) {
        errors.push(`第 ${index + 1} 行：最多 ${MAX_SITE_RULES} 个站点，先删掉一些`);
      } else {
        rules.push(parsed.rule);
      }
      continue;
    }
    if (parsed.skip) continue;
    errors.push(`第 ${index + 1} 行：${parsed.error}`);
  }
  return { rules, errors, rewritten };
}

/** 把规则表写回多行文本（设置页回填与导出都能用） */
function formatSiteRules(rules) {
  const list = Array.isArray(rules) ? rules : [];
  return list
    .filter((r) => r && r.host && Number.isFinite(r.ms))
    .map((r) => `${r.host}=${Math.round(r.ms / 1000)}`)
    .join('\n');
}

/** 从任意来源（磁盘 JSON、请求体）收一份干净的规则表 */
function sanitizeSiteRules(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const host = normalizeRuleHost(item.host);
    const ms = normalizeNavigateBudget(item.ms);
    if (!host || ms == null) continue;
    const existing = out.findIndex((r) => r.host === host);
    if (existing >= 0) out[existing] = { host, ms };
    else if (out.length < MAX_SITE_RULES) out.push({ host, ms });
  }
  return out;
}

/** 域名匹配：等于本身或子域（`blog.example.com` 命中 `example.com`） */
function hostMatches(ruleHost, host) {
  const a = String(ruleHost || '').toLowerCase();
  const b = String(host || '').toLowerCase();
  if (!a || !b) return false;
  return b === a || b.endsWith(`.${a}`);
}

/** 从 URL 取主机名；取不到回空串（坏地址交给别处判，这里不抛错） */
function hostOfUrl(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 给某个地址挑预算：先看站点规则（取最长匹配的那条），没有就用全局值。
 * @returns {{ms:number, host:string, matched:boolean}}
 */
function resolveBudgetForUrl(rules, url, fallbackMs) {
  const host = hostOfUrl(url);
  const list = sanitizeSiteRules(rules);
  const fallback = resolveNavigateBudget(fallbackMs);
  if (!host) return { ms: fallback, host: '', matched: false };
  let best = null;
  for (const rule of list) {
    if (!hostMatches(rule.host, host)) continue;
    if (!best || rule.host.length > best.host.length) best = rule;
  }
  return best ? { ms: best.ms, host: best.host, matched: true } : { ms: fallback, host: '', matched: false };
}

module.exports = {
  NAVIGATE_BUDGET_DEFAULT,
  NAVIGATE_BUDGET_MIN,
  NAVIGATE_BUDGET_MAX,
  MAX_SITE_RULES,
  describeNavigateBudget,
  formatSiteRules,
  hostMatches,
  hostOfUrl,
  normalizeNavigateBudget,
  normalizeRuleHost,
  parseSiteRule,
  parseSiteRules,
  resolveBudgetForUrl,
  resolveNavigateBudget,
  sanitizeSiteRules,
};
