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

/**
 * 把输入整成「域名 + 路径」，供 URL 前缀规则使用。
 *
 * 域名规则只关心 host（子域继承），前缀规则要连路径一起比——比如
 * `example.com/admin` 只放行后台，不连带放行 `example.com/blog`。
 * 拿不到合法域名时 `host` 为空串，调用方据此判非法。
 */
function normalizeSite(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { host: '', path: '' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // 允许直接写 example.com/admin：补一个占位协议再解析
    try {
      const url = new URL(`https://${text}`);
      const host = normalizeHost(url.host);
      return { host, path: host ? normalizePath(url.pathname) : '' };
    } catch {
      return { host: normalizeHost(text), path: '' };
    }
  }
  try {
    const url = new URL(text);
    const host = normalizeHost(url.host);
    return { host, path: host ? normalizePath(url.pathname) : '' };
  } catch {
    return { host: '', path: '' };
  }
}

/** 路径规范化：小写、去末尾斜杠、去查询串（规则里存查询串只会让人误以为能按参数放行） */
function normalizePath(raw) {
  const text = String(raw || '').toLowerCase();
  const noQuery = text.split('?')[0].split('#')[0];
  const trimmed = noQuery.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
}

/** 匹配用的站点串：`host` 或 `host/path`（前缀规则用） */
function siteTextOf(host, path) {
  if (!host) return '';
  return path ? `${host}${path}` : host;
}

/** 把一条规则（字符串或对象）整成 `{target, mode, note, addedAt}`；无效返回 null */
function normalizeRule(raw, now) {
  const stamp = typeof now === 'number' ? now : Date.now();
  const source = typeof raw === 'string' ? { target: raw } : raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;
  const mode = source.mode === RULE_MODES.prefix ? RULE_MODES.prefix : RULE_MODES.host;
  const rawTarget = source.target || source.host || source.site || '';
  if (mode === RULE_MODES.prefix) {
    const site = normalizeSite(rawTarget);
    if (!site.host) return null;
    const target = siteTextOf(site.host, site.path);
    const note = typeof source.note === 'string' ? source.note.slice(0, 120) : '';
    const addedAt = typeof source.addedAt === 'number' && source.addedAt > 0 ? source.addedAt : stamp;
    return { target, mode, note, addedAt };
  }
  const target = normalizeHost(rawTarget);
  if (!target) return null;
  const note = typeof source.note === 'string' ? source.note.slice(0, 120) : '';
  const addedAt = typeof source.addedAt === 'number' && source.addedAt > 0 ? source.addedAt : stamp;
  return { target, mode, note, addedAt };
}

/**
 * 规则是否匹配。
 * - 域名规则：子域继承（`a.b.com` 命中 `b.com`）
 * - 前缀规则：按 `host/path` 从左往右比，所以 `example.com/admin` 不会顺手放行 `example.com/blog`
 */
function ruleMatches(rule, host, siteText) {
  if (!rule || !host) return false;
  if (rule.mode === RULE_MODES.prefix) {
    const text = siteText || host;
    // 必须按「路径段」匹配：裸 startsWith(target) 会让 example.com/admin 顺手放行
    // example.com/administrator —— 差一个字符，权限却是一整条路径。
    return text === rule.target || text.startsWith(`${rule.target}/`);
  }
  return host === rule.target || host.endsWith(`.${rule.target}`);
}

/** 在一张名单里找命中的那条规则（先登记的先算，方便界面显示"是哪条挡住的"） */
function findMatch(list, host, siteText) {
  if (!Array.isArray(list) || !host) return null;
  for (const rule of list) {
    if (ruleMatches(rule, host, siteText)) return rule;
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
    // 去重键带上模式：example.com 与 example.com/admin 是两条不同的规则
    const key = `${rule.mode}:${rule.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
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

/**
 * 冲突条目：同一目标同时出现在两张名单里（界面上要提示"屏蔽优先"，别让用户以为白名单生效了）。
 * 域名规则与前缀规则分开算：`example.com` 与 `example.com/admin` 不算冲突。
 */
function listConflicts(policy) {
  const allowKeys = new Set(
    (policy && policy.allow ? policy.allow : []).map((rule) => `${rule.mode}:${rule.target}`),
  );
  return (policy && policy.block ? policy.block : [])
    .filter((rule) => allowKeys.has(`${rule.mode}:${rule.target}`))
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
  const site = normalizeSite(input.site || '');
  const host = site.host;
  const siteText = siteTextOf(site.host, site.path);
  const trusted = Array.isArray(input.sessionTrusted)
    ? input.sessionTrusted.map((item) => normalizeSite(item).host).filter(Boolean)
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

  const blocked = findMatch(policy.block, host, siteText);
  if (blocked) {
    return {
      decision: DECISIONS.deny,
      layer: LAYERS.block,
      host,
      rule: blocked,
      reason: 'blocked-by-list',
      message: `${host} 在屏蔽名单里（${blocked.target}${blocked.mode === RULE_MODES.prefix ? '，URL 前缀规则' : ''}），agent 不能在这个站点上操作。要放行请先在设置里把这条从屏蔽名单删掉。`,
    };
  }

  const allowed = findMatch(policy.allow, host, siteText);
  if (allowed) {
    return {
      decision: DECISIONS.allow,
      layer: LAYERS.allow,
      host,
      rule: allowed,
      reason: 'allowed-by-list',
      message: `${host} 在白名单里（${allowed.target}${allowed.mode === RULE_MODES.prefix ? '，URL 前缀规则' : ''}），站点已放行；输入文字、下载这类动作仍会单独问你。`,
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
    const wantsPrefix = raw && typeof raw === 'object' && raw.mode === RULE_MODES.prefix;
    return {
      ok: false,
      list,
      error: wantsPrefix
        ? `「${String(shown || '').trim() || '（空）'}」看起来不是一个 URL。前缀规则要写完整到路径，例如 example.com/admin。`
        : `「${String(shown || '').trim() || '（空）'}」看起来不是一个域名。填站点根域名，例如 example.com。`,
    };
  }
  if (list.some((item) => item.target === rule.target && item.mode === rule.mode)) {
    return { ok: true, list, rule, already: true, error: '' };
  }
  if (list.length >= MAX_RULES) {
    return { ok: false, list, error: `名单最多 ${MAX_RULES} 条，先删掉一些再加。` };
  }
  return { ok: true, list: list.concat(rule), rule, already: false, error: '' };
}

/** 删一条规则（按 target；给 mode 时只删该模式的，不给就把同名的一起删） */
function removeRule(rawList, target, mode) {
  const list = sanitizeList(rawList);
  const wantMode = mode === RULE_MODES.prefix || mode === RULE_MODES.host ? mode : '';
  const hostOnly = normalizeHost(target);
  const prefixSite = normalizeSite(target);
  const prefixTarget = prefixSite.host ? siteTextOf(prefixSite.host, prefixSite.path) : '';
  if (!hostOnly && !prefixTarget) return { ok: false, list, error: '要删除的域名或 URL 不合法。' };
  const next = list.filter((rule) => {
    if (wantMode && rule.mode !== wantMode) return true;
    if (rule.mode === RULE_MODES.prefix) return rule.target !== prefixTarget;
    return rule.target !== hostOnly;
  });
  return {
    ok: next.length !== list.length,
    list: next,
    error: next.length === list.length ? `${hostOnly || prefixTarget} 不在这张名单里。` : '',
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

/** 导出成可读的 JSON（给用户自己备份 / 换机器用，不是内部落盘格式） */
function exportPolicy(policy, now) {
  const safe = sanitizePolicy(policy);
  return {
    app: 'nyx',
    kind: 'agent-sites',
    version: 1,
    exportedAt: new Date(Number(now) || Date.now()).toISOString(),
    globalEnabled: safe.globalEnabled,
    allow: safe.allow.map((rule) => ({ target: rule.target, mode: rule.mode, note: rule.note })),
    block: safe.block.map((rule) => ({ target: rule.target, mode: rule.mode, note: rule.note })),
  };
}

/**
 * 导入一份导出的名单。默认 merge（并进现有名单，不删用户已有的），
 * replace 才整份替换。校验不过就说清哪一条不行——静默丢弃条目等于骗人。
 */
function importPolicy(rawText, current, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const now = Number(opts.now) || Date.now();
  let parsed = null;
  try {
    parsed = JSON.parse(String(rawText || ''));
  } catch {
    return { ok: false, error: '这个文件不是 JSON，可能不是 Nyx 导出的名单。', policy: sanitizePolicy(current) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '文件内容不是一份名单（应该是一个对象）。', policy: sanitizePolicy(current) };
  }
  if (parsed.kind && parsed.kind !== 'agent-sites') {
    return { ok: false, error: `这份文件的类型是「${parsed.kind}」，不是 agent 站点名单。`, policy: sanitizePolicy(current) };
  }
  const hasAllow = Array.isArray(parsed.allow);
  const hasBlock = Array.isArray(parsed.block);
  if (!hasAllow && !hasBlock) {
    return { ok: false, error: '文件里既没有 allow 也没有 block 名单。', policy: sanitizePolicy(current) };
  }

  const base = mode === 'replace' ? sanitizePolicy({ globalEnabled: parsed.globalEnabled, allow: [], block: [] }) : sanitizePolicy(current);
  const nextAllow = mode === 'replace' ? [] : base.allow.slice();
  const nextBlock = mode === 'replace' ? [] : base.block.slice();
  // 全局开关跟着文件走：备份里记着"agent 访问已关闭"，导入后就必须是关闭。
  // 反过来（保留当前的开）等于把安全设置悄悄放宽，是最不该静默发生的事。
  const adoptGlobal = typeof parsed.globalEnabled === 'boolean' ? parsed.globalEnabled : base.globalEnabled;
  const globalChanged = adoptGlobal !== base.globalEnabled;
  let added = 0;
  let duplicates = 0;
  const rejected = [];

  const absorb = (list, target, label) => {
    const items = Array.isArray(list) ? list : [];
    for (const raw of items) {
      const result = addRule(target, raw, now);
      if (!result.ok) {
        rejected.push(`${label}：${(raw && (raw.target || raw)) || '（空）'}`);
        continue;
      }
      if (result.already) {
        duplicates += 1;
        continue;
      }
      target.length = 0;
      target.push(...result.list);
      added += 1;
    }
  };

  absorb(parsed.allow, nextAllow, '白名单');
  absorb(parsed.block, nextBlock, '屏蔽名单');

  const policy = sanitizePolicy({
    globalEnabled: adoptGlobal,
    allow: nextAllow,
    block: nextBlock,
  });

  const globalText = globalChanged ? `；全局开关已按文件改成「${adoptGlobal ? '开启' : '关闭'}」` : '';

  return {
    ok: true,
    policy,
    mode,
    added,
    duplicates,
    globalChanged,
    rejected: rejected.slice(0, 10),
    rejectedCount: rejected.length,
    summary: `导入完成：新增 ${added} 条，已存在 ${duplicates} 条${rejected.length ? `，${rejected.length} 条格式不对被跳过` : ''}${globalText}。`,
  };
}

/** 给界面用的状态包（设置页与「为什么被挡住」都用同一份） */
function agentSitesPayload(input) {
  const source = input && typeof input === 'object' ? input : {};
  const policy = sanitizePolicy(source.policy);
  const sessionTrusted = Array.isArray(source.sessionTrusted)
    ? source.sessionTrusted.map((item) => normalizeSite(item).host).filter(Boolean)
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
      ruleMode: current.rule ? current.rule.mode : '',
    },
    limits: { maxRules: MAX_RULES },
    modes: [
      { value: RULE_MODES.host, label: '域名（含子域）' },
      { value: RULE_MODES.prefix, label: 'URL 前缀（精确到路径）' },
    ],
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
  exportPolicy,
  findMatch,
  importPolicy,
  listConflicts,
  normalizeHost,
  normalizePath,
  normalizeRule,
  normalizeSite,
  removeRule,
  ruleMatches,
  sanitizeList,
  sanitizePolicy,
  siteTextOf,
};
