'use strict';

/**
 * 站点三层授权（清单 E）。
 *
 * 设计意图：把「要不要让 agent 动这个站点」的确认成本，从每一次动作压到第一次进站。
 *
 *   1. 屏蔽名单   → 进站一律拒绝（**永远赢过允许**）
 *   2. 白名单     → 进站默认放行（一次登记永久有效）
 *   3. 都没命中   → 进站时问一次；用户可选「这次会话信任该域名」（只在本进程内有效，不落盘）
 *   4. 全局关着   → 一律不动（不是"放行"，是不让 agent 干活）
 *
 * 两条硬规则：
 *   - **屏蔽优先**：同一个域名同时在两张名单里时，拒绝。
 *   - **白名单不豁免动作级确认**：站点放行只代表"可以在这个站点上干活"，
 *     输入文字、下载这类动作仍然每次都要人工点（判定在 agent-dispatch 的 CONFIRM_RULES 里）。
 *
 * 本文件是纯逻辑、零 Electron 依赖，便于直接跑单测：
 * 名单匹配、优先级、脏数据清洗、空站点的判读都在这里定死，主进程只负责弹窗与落盘。
 */

/** 名单规则的匹配方式。现阶段都按域名级，`prefix` 预留给日后的 URL 前缀规则 */
const RULE_MODES = {
  host: 'host',
  prefix: 'prefix',
};

const LAYERS = {
  block: '屏蔽名单',
  allow: '白名单',
  session: '本次会话信任',
  ask: '未命中任何名单',
  global: '全局开关',
  noSite: '没有可识别的站点',
};

const DECISIONS = {
  allow: 'allow',
  deny: 'deny',
  ask: 'ask',
};

const DEFAULT_POLICY = {
  globalEnabled: true,
  allow: [],
  block: [],
};

const MAX_RULES = 500;
const MAX_HOST_LEN = 253;

/**
 * 把各种输入整成一个可用于匹配的域名。
 *
 * 支持传整条 URL（`https://a.b.com:8443/x?y=1`）、带端口的 host、大写、末尾点。
 * 拿不到合法域名时返回空串——**不要**用空串去"差不多匹配"，那会把名单变成摆设。
 */
function normalizeHost(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      text = new URL(text).host || '';
    } catch {
      return '';
    }
  }
  text = text.split('/')[0].split('?')[0].split('#')[0];
  // 先去掉端口（IPv6 字面量带冒号，这里不支持，直接判非法比乱匹配安全）
  if (text.startsWith('[')) return '';
  const colon = text.indexOf(':');
  if (colon >= 0) text = text.slice(0, colon);
  text = text.replace(/\.+$/, '').toLowerCase();
  if (!text) return '';
  if (text.length > MAX_HOST_LEN) return '';
  if (text === 'localhost') return text;
  if (!text.includes('.')) return '';
  if (!/^[a-z0-9.-]+$/.test(text)) return '';
  if (text.includes('..')) return '';
  if (text.startsWith('.') || text.startsWith('-')) return '';
  return text;
}

/** 把一条规则（字符串或对象）整成 `{target, mode, note, addedAt}`；无效返回 null */
function normalizeRule(raw, now) {
  const stamp = typeof now === 'number' ? now : Date.now();
  const source = typeof raw === 'string' ? { target: raw } : raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;
  const target = normalizeHost(source.target || source.host || source.site || '');
  if (!target) return null;
  const mode = source.mode === RULE_MODES.prefix ? RULE_MODES.prefix : RULE_MODES.host;
  const note = typeof source.note === 'string' ? source.note.slice(0, 120) : '';
  const addedAt = typeof source.addedAt === 'number' && source.addedAt > 0 ? source.addedAt : stamp;
  return { target, mode, note, addedAt };
}

/** 规则是否匹配该域名：域名级规则按"子域继承"，a.b.com 命中 b.com */
function ruleMatches(rule, host) {
  if (!rule || !host) return false;
  if (rule.mode === RULE_MODES.prefix) return host.startsWith(rule.target);
  return host === rule.target || host.endsWith(`.${rule.target}`);
}

/** 在一张名单里找命中的那条规则（先登记的先算，方便界面显示"是哪条挡住的"） */
function findMatch(list, host) {
  if (!Array.isArray(list) || !host) return null;
  for (const rule of list) {
    if (ruleMatches(rule, host)) return rule;
  }
  return null;
}

/** 两张名单去重 + 限长；允许表里与屏蔽表冲突的条目要**保留**，让"屏蔽优先"在判定时生效并能在界面上看见 */
function sanitizeList(rawList, now) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rawList)) return out;
  for (const raw of rawList) {
    const rule = normalizeRule(raw, now);
    if (!rule) continue;
    if (seen.has(rule.target)) continue;
    seen.add(rule.target);
    out.push(rule);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

/** 读盘时用：脏数据不许让整个策略失效，坏的丢、缺的用默认 */
function sanitizePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    globalEnabled: source.globalEnabled !== false,
    allow: sanitizeList(source.allow),
    block: sanitizeList(source.block),
  };
}

/** 冲突条目：同时在两张名单里的域名（界面上要提示"屏蔽优先"，别让用户以为白名单生效了） */
function listConflicts(policy) {
  const allowTargets = new Set((policy && policy.allow ? policy.allow : []).map((rule) => rule.target));
  return (policy && policy.block ? policy.block : [])
    .filter((rule) => allowTargets.has(rule.target))
    .map((rule) => rule.target);
}

/**
 * 核心判定：这个站点现在能不能让 agent 动。
 *
 * @param {object} input `{site, policy, sessionTrusted}`；`sessionTrusted` 是本次会话信任过的域名数组
 * @returns {{decision:'allow'|'deny'|'ask', layer:string, host:string, rule:object|null, reason:string, message:string}}
 */
function evaluateSite(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const policy = sanitizePolicy(input.policy);
  const host = normalizeHost(input.site || '');
  const trusted = Array.isArray(input.sessionTrusted)
    ? input.sessionTrusted.map((item) => normalizeHost(item)).filter(Boolean)
    : [];

  if (!host) {
    return {
      decision: DECISIONS.deny,
      layer: LAYERS.noSite,
      host: '',
      rule: null,
      reason: 'no-site',
      message: '当前页面没有可识别的域名，无法按站点授权；在普通网页上再让 agent 操作。',
    };
  }

  // 全局关着就一律不动：白名单只解决"进站要不要问"，不解决"agent 能不能开工"
  if (!policy.globalEnabled) {
    return {
      decision: DECISIONS.deny,
      layer: LAYERS.global,
      host,
      rule: null,
      reason: 'global-disabled',
      message: '设置里的「允许 agent 访问网页」是关闭状态，agent 现在什么也做不了。',
    };
  }

  const blocked = findMatch(policy.block, host);
  if (blocked) {
    return {
      decision: DECISIONS.deny,
      layer: LAYERS.block,
      host,
      rule: blocked,
      reason: 'blocked-by-list',
      message: `${host} 在屏蔽名单里（${blocked.target}），agent 不能在这个站点上操作。要放行请先在设置里把这条从屏蔽名单删掉。`,
    };
  }

  const allowed = findMatch(policy.allow, host);
  if (allowed) {
    return {
      decision: DECISIONS.allow,
      layer: LAYERS.allow,
      host,
      rule: allowed,
      reason: 'allowed-by-list',
      message: `${host} 在白名单里（${allowed.target}），站点已放行；输入文字、下载这类动作仍会单独问你。`,
    };
  }

  if (trusted.includes(host)) {
    return {
      decision: DECISIONS.allow,
      layer: LAYERS.session,
      host,
      rule: { target: host, mode: RULE_MODES.host, note: '', addedAt: 0 },
      reason: 'session-trusted',
      message: `${host} 是你这次会话里信任过的站点；重启 Nyx 后需要重新确认。`,
    };
  }

  return {
    decision: DECISIONS.ask,
    layer: LAYERS.ask,
    host,
    rule: null,
    reason: 'not-listed',
    message: `${host} 既不在白名单也不在屏蔽名单里，需要你确认一次才能让 agent 在这个站点上操作。`,
  };
}

/** 加一条规则；域名非法时把原因说清楚（界面直接显示这句话） */
function addRule(rawList, raw, now) {
  const list = sanitizeList(rawList, now);
  const rule = normalizeRule(raw, now);
  if (!rule) {
    const shown = typeof raw === 'string' ? raw : raw && (raw.target || raw.host);
    return {
      ok: false,
      list,
      error: `「${String(shown || '').trim() || '（空）'}」看起来不是一个域名。填站点根域名，例如 example.com。`,
    };
  }
  if (list.some((item) => item.target === rule.target)) {
    return { ok: true, list, rule, already: true, error: '' };
  }
  if (list.length >= MAX_RULES) {
    return { ok: false, list, error: `名单最多 ${MAX_RULES} 条，先删掉一些再加。` };
  }
  return { ok: true, list: list.concat(rule), rule, already: false, error: '' };
}

/** 删一条规则（按域名，大小写与端口都不敏感） */
function removeRule(rawList, target) {
  const list = sanitizeList(rawList);
  const host = normalizeHost(target);
  if (!host) return { ok: false, list, error: '要删除的域名不合法。' };
  const next = list.filter((rule) => rule.target !== host);
  return {
    ok: next.length !== list.length,
    list: next,
    error: next.length === list.length ? `${host} 不在这张名单里。` : '',
  };
}

/** 会话信任：加/清。只活在内存里，重启即失效（这是设计，不是遗漏） */
function addSessionTrust(rawSet, site) {
  const set = new Set(Array.isArray(rawSet) ? rawSet : []);
  const host = normalizeHost(site);
  if (!host) return { ok: false, hosts: [...set], error: '当前页面没有可识别的域名，没法记住。' };
  set.add(host);
  return { ok: true, hosts: [...set], error: '' };
}

function describePolicy(policy) {
  const safe = sanitizePolicy(policy);
  if (!safe.globalEnabled) return 'agent 访问已关闭（任何站点都不会执行动作）';
  return `agent 访问已开启；白名单 ${safe.allow.length} 条，屏蔽名单 ${safe.block.length} 条`;
}

/** 给界面用的状态包（设置页与「为什么被挡住」都用同一份） */
function agentSitesPayload(input) {
  const source = input && typeof input === 'object' ? input : {};
  const policy = sanitizePolicy(source.policy);
  const sessionTrusted = Array.isArray(source.sessionTrusted)
    ? source.sessionTrusted.map((item) => normalizeHost(item)).filter(Boolean)
    : [];
  const current = evaluateSite({
    site: source.site || '',
    policy,
    sessionTrusted,
  });
  return {
    ok: true,
    policy,
    sessionTrusted,
    conflicts: listConflicts(policy),
    summary: describePolicy(policy),
    current: {
      site: current.host,
      decision: current.decision,
      layer: current.layer,
      reason: current.reason,
      message: current.message,
      rule: current.rule ? current.rule.target : '',
    },
    limits: { maxRules: MAX_RULES },
  };
}

module.exports = {
  DECISIONS,
  DEFAULT_POLICY,
  LAYERS,
  MAX_RULES,
  RULE_MODES,
  addRule,
  addSessionTrust,
  agentSitesPayload,
  describePolicy,
  evaluateSite,
  findMatch,
  listConflicts,
  normalizeHost,
  normalizeRule,
  removeRule,
  ruleMatches,
  sanitizeList,
  sanitizePolicy,
};
