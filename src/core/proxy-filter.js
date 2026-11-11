'use strict';

/**
 * 订阅「广告 / 推广 / 失效节点」识别与过滤。
 *
 * 机场订阅里常混入一批"不是节点"的条目：名称写着「官网」「剩余流量」「续费地址」
 * 的提示项、server 指向推广域名或干脆为空的废条目。它们对内核毫无用处，出现在
 * 节点表与策略组里还会污染测速结果、把用户导向推广页。
 *
 * 设计约束：
 *   - 纯函数、零依赖、可离线单测（见 scripts/verify-proxy-filter.js）；
 *   - 过滤在净化（sanitize）阶段按行完成，不引入 YAML 全量解析重建，保留订阅原文的
 *     节点、规则与注释；
 *   - 命中过滤的条目同时从 `proxies` 列表与 `proxy-groups` 成员列表里剔除，
 *     避免策略组引用到不存在的节点导致内核校验失败；
 *   - 只做"移除"，绝不新增或改写节点参数；唯一的新增是在某策略组成员被全部过滤后
 *     补一个 DIRECT 成员，防止出现空成员策略组（内核会拒绝加载）。
 */

/** 名称中的推广/广告强特征（中文关键词） */
const AD_NAME_KEYWORDS = [
  '官网',
  '订阅',
  '加群',
  '群组',
  '客服',
  '站长',
  '续费',
  '到期',
  '剩余',
  '购买',
  '优惠',
  '折扣',
  '防失联',
  '备用网址',
  '地址发布',
  '发布页',
  '永久地址',
  '邀请',
  '注册',
  '教程',
  '机场',
  '试用',
  '免费',
  '流量',
];

/** 名称中的推广/广告特征（拉丁词，按词边界匹配，避免误伤节点名里的普通字母片段） */
const AD_NAME_PATTERNS = [
  /\btelegram\b/i,
  /\bt\.me\b/i,
  /\btg\b/i,
  /\bdiscord\b/i,
  /\bwatch\b/i,
  /\bsubscribe\b/i,
  /\bwebsite\b/i,
];

/**
 * 白名单（优先级高于关键词命中）：这些是真实节点常见的命名特征，
 * 命中即视为正常节点而不做过滤（例如订阅里名为「香港01 官网优化」的真实节点）。
 */
const NAME_WHITELIST_PATTERNS = [
  /iepl/i,
  /iplc/i,
  /\bbgp\b/i,
  /\bcn2\b/i,
  /\bgia\b/i,
  /专线/,
  /中转/,
  /家宽/,
  /直连/,
  /原生/,
  /优化/,
  /流媒体/,
  /解锁/,
  /倍率/,
];

/** 名称里出现网址/域名，基本是推广条目 */
const URL_IN_NAME_PATTERN =
  /https?:\/\/|www\.|[\w-]+\.(?:com|cn|net|org|xyz|top|icu|me|cc|info|vip|site|online|club|shop|app|link|live|fun|pro|io)\b/i;

/** server 字段里的推广特征（域名标签级匹配，避免 "ad" 误伤 "load" 这类子串） */
const PROMO_SERVER_LABELS = new Set([
  'sub',
  'subs',
  'subscribe',
  'subscription',
  'ad',
  'ads',
  'adv',
  'advert',
  'promo',
  'invite',
  'invitation',
  'register',
  'reg',
  'shop',
  'pay',
  'payment',
  'buy',
  'tg',
  'telegram',
  'notice',
  'blog',
]);

/** server 中的中文推广词 */
const PROMO_SERVER_TEXT_PATTERN = /订阅|推广|官网|机场|加群|加群|客服|续费|失效/;

/** 明显无效的 server 占位值 */
const PLACEHOLDER_SERVER_PATTERN = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|localhost|example\.com|none|null)$/i;

function unquote(value) {
  const text = String(value == null ? '' : value).trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

/**
 * 从一段（可能跨多行的）节点定义里取出某个字段值。
 * 支持 `key: value`、`key: "value"`、`key: 'value'` 以及流式 map `{name: x, server: y}`。
 *
 * @param {string} text
 * @param {string} key
 * @returns {string}
 */
function extractField(text, key) {
  const pattern = new RegExp(
    `(?:^|[\\s{'",])${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)'|([^,}\\r\\n]+))`,
    'i',
  );
  const match = pattern.exec(text);
  if (!match) return '';
  return unquote(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
}

/** server 字段是否指向推广域名 / 明显无效 */
function serverReason(server) {
  const raw = String(server || '').trim();
  if (!raw) return '服务地址为空';

  const host = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split('?')[0]
    .replace(/:\d+$/, '')
    .trim();

  if (!host) return '服务地址为空';
  if (PLACEHOLDER_SERVER_PATTERN.test(host)) return `服务地址无效（${host}）`;
  if (PROMO_SERVER_TEXT_PATTERN.test(host)) return `服务地址含推广特征（${host}）`;

  if (/^[a-z0-9.-]+$/i.test(host)) {
    for (const label of host.split('.')) {
      if (PROMO_SERVER_LABELS.has(label)) return `服务地址含推广域名标签（${label}）`;
    }
  }

  return null;
}

/** 取 YAML 标量值：先剥掉行尾注释，再去引号 */
function scalarValue(value) {
  const text = String(value == null ? '' : value);
  const match = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^#]*?)\s*(?:#.*)?$/.exec(text);
  return unquote(match ? match[1] : text);
}

/**
 * 判定单个节点是否为广告 / 推广 / 失效条目。
 *
 * @param {{name?:string, server?:string}} node
 * @returns {{filter:boolean, reason:string, whitelisted?:boolean}}
 */
function classifyNode({ name, server } = {}) {
  const nodeName = String(name || '').trim();
  const serverText = String(server || '').trim();

  const whitelisted = NAME_WHITELIST_PATTERNS.some((pattern) => pattern.test(nodeName));

  // 1) 名称里带网址/域名：无论是否命中白名单，一律视为推广条目
  if (nodeName && URL_IN_NAME_PATTERN.test(nodeName)) {
    return { filter: true, reason: '名称含网址/域名', whitelisted };
  }

  // 2) 白名单优先：真实节点命名特征命中即放行
  if (whitelisted) return { filter: false, reason: '', whitelisted: true };

  // 3) 名称关键词命中
  const keyword = AD_NAME_KEYWORDS.find((word) => nodeName.includes(word));
  if (keyword) return { filter: true, reason: `名称含广告关键词「${keyword}」`, whitelisted: false };

  const pattern = AD_NAME_PATTERNS.find((item) => item.test(nodeName));
  if (pattern) return { filter: true, reason: `名称含广告推广词（${pattern.source}）`, whitelisted: false };

  // 4) server 侧判定
  const badServer = serverReason(serverText);
  if (badServer) return { filter: true, reason: badServer, whitelisted: false };

  return { filter: false, reason: '', whitelisted: false };
}

/** 策略组成员行里的标量名（排除 `- type: xxx` 这类键值行） */
const MEMBER_LINE_PATTERN = /^(\s*)-\s*([^:#\[\]{}\r\n]+?)\s*$/;

/** 内联成员列表：`proxies: [a, b, c]`（可出现在块状或流式策略组里） */
const INLINE_MEMBER_LIST_PATTERN = /(^|[,{\s])proxies\s*:\s*\[([^\]]*)\]/gi;

/** 流式（单行）策略组/条目里的 name 值 */
const FLOW_NAME_PATTERN = /(?:^|[,{\s])name\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/i;

function readFlowName(line) {
  const match = FLOW_NAME_PATTERN.exec(line);
  if (!match) return '(未命名策略组)';
  return unquote(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
}

function splitInlineList(value) {
  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((item) => unquote(item))
    .filter(Boolean);
}

/**
 * 兜底清扫：剔除内联成员列表（`proxies: [a, b, c]`）里对已过滤节点的引用。
 *
 * 第二遍只覆盖「块状策略组」（`proxies:` 换行、每行一个成员），而机场订阅里同样常见
 * 流式写法：`- { name: 自动选择, type: url-test, proxies: [节点A, 节点B] }` —— 整组挤在
 * 一行里。这类引用一旦漏删，内核会以 `proxy group[0]: xxx not found` 直接拒绝启动，
 * 所以再统一扫一遍收口；成员被删空的组补 DIRECT，避免空成员策略组。
 *
 * @param {string[]} lines
 * @param {Set<string>} filteredNames
 * @param {{groupRefs:Array, emptyGroups:string[], warnings:string[]}} ctx
 * @returns {string[]}
 */
function sweepInlineGroupRefs(lines, filteredNames, ctx) {
  return lines.map((line) => {
    if (!/proxies\s*:\s*\[/.test(line)) return line;

    const groupName = readFlowName(line);
    let rewritten = '';
    let cursor = 0;
    let touched = false;
    let match;
    INLINE_MEMBER_LIST_PATTERN.lastIndex = 0;

    while ((match = INLINE_MEMBER_LIST_PATTERN.exec(line))) {
      const names = splitInlineList(match[2]);
      const keptNames = [];
      for (const name of names) {
        if (filteredNames.has(name)) {
          ctx.groupRefs.push({ name, group: groupName });
        } else {
          keptNames.push(name);
        }
      }
      if (keptNames.length === names.length) continue;

      touched = true;
      if (!keptNames.length) {
        ctx.emptyGroups.push(groupName);
        ctx.warnings.push(`策略组「${groupName}」成员全部被过滤，已补 DIRECT 占位`);
      }
      rewritten += `${line.slice(cursor, match.index)}${match[1]}proxies: [${keptNames.length ? keptNames.join(', ') : 'DIRECT'}]`;
      cursor = match.index + match[0].length;
    }

    return touched ? rewritten + line.slice(cursor) : line;
  });
}

/**
 * 按行过滤订阅原文里的广告节点。
 *
 * @param {string} rawText 订阅原文（Clash / mihomo 格式）
 * @returns {{
 *   text: string,
 *   filtered: Array<{name:string, reason:string, server:string}>,
 *   groupRefs: Array<{name:string, group:string}>,
 *   keptCount: number,
 *   scannedCount: number,
 *   whitelistedCount: number,
 *   emptyGroups: string[],
 *   warnings: string[],
 * }}
 */
function filterAdProxies(rawText) {
  const lines = String(rawText == null ? '' : rawText)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  const warnings = [];
  const filtered = [];
  const groupRefs = [];
  const kept = [];
  let scannedCount = 0;
  let whitelistedCount = 0;

  /* ---------- 第一遍：过滤 proxies 列表 ---------- */

  const keptLines = [];
  let inProxies = false;
  let itemIndent = -1;
  let itemLines = [];

  const flushItem = () => {
    if (!itemLines.length) return;
    const text = itemLines.join('\n');
    const name = extractField(text, 'name');
    const server = extractField(text, 'server');
    const verdict = classifyNode({ name, server });

    scannedCount += 1;
    if (verdict.filter) {
      filtered.push({ name: name || '(未命名条目)', reason: verdict.reason, server: server || '' });
    } else {
      if (verdict.whitelisted) whitelistedCount += 1;
      kept.push(name);
      keptLines.push(...itemLines);
    }
    itemLines = [];
  };

  for (const line of lines) {
    const topMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line);

    if (topMatch) {
      if (inProxies) flushItem();
      inProxies = topMatch[1] === 'proxies';
      itemIndent = -1;
      keptLines.push(line);
      continue;
    }

    if (!inProxies) {
      keptLines.push(line);
      continue;
    }

    const itemMatch = /^(\s*)-\s*(.*)$/.exec(line);
    if (itemMatch && (itemIndent < 0 || itemMatch[1].length <= itemIndent)) {
      flushItem();
      itemIndent = itemMatch[1].length;
      itemLines.push(line);
      continue;
    }

    if (itemLines.length) {
      itemLines.push(line);
      continue;
    }

    // proxies 块内的空行 / 注释
    keptLines.push(line);
  }
  flushItem();

  const filteredNames = new Set(filtered.map((item) => item.name).filter((name) => name !== '(未命名条目)'));

  if (!scannedCount) {
    warnings.push('订阅中未发现内联 proxies 列表：若订阅改用 proxy-providers 由内核远程下发节点，则无法逐条过滤');
  }

  /* ---------- 第二遍：清理 proxy-groups 里对已过滤节点的引用 ---------- */

  const emptyGroups = [];
  const out = [];
  let inGroups = false;
  /** @type {null|{name:string, keyIndex:number, memberPrefix:string, keptMembers:number, droppedMembers:number, expectMembers:boolean, inline:boolean}} */
  let group = null;

  const closeGroup = () => {
    if (!group) return;
    if (group.droppedMembers > 0 && group.keptMembers === 0) {
      // 成员被全部过滤：补一个 DIRECT，避免出现空成员策略组（内核会拒绝加载）
      const prefix = group.memberPrefix || '      ';
      if (group.keyIndex >= 0) out.splice(group.keyIndex + 1, 0, `${prefix}- DIRECT`);
      group.keptMembers = 1;
      emptyGroups.push(group.name || '(未命名策略组)');
      warnings.push(`策略组「${group.name || '(未命名)'}」成员全部被过滤，已补 DIRECT 占位`);
    }
    group = null;
  };

  // 第二遍必须基于第一遍的产出（已被剔除掉广告节的 proxies 段）继续处理，
  // 否则会重新把原始行整体写出，导致过滤结果被覆盖成"看起来过滤了、其实没删"。
  for (const line of keptLines) {
    const topMatch = /^([A-Za-z0-9_-]+)\s*:/.exec(line);

    if (topMatch) {
      closeGroup();
      inGroups = topMatch[1] === 'proxy-groups';
      out.push(line);
      continue;
    }

    if (!inGroups) {
      out.push(line);
      continue;
    }

    const itemMatch = /^(\s*)-\s*name\s*:\s*(.*)$/.exec(line);
    if (itemMatch) {
      closeGroup();
      group = {
        name: scalarValue(itemMatch[2]),
        keyIndex: -1,
        memberPrefix: '',
        keptMembers: 0,
        droppedMembers: 0,
        expectMembers: false,
        inline: false,
      };
      out.push(line);
      continue;
    }

    if (group) {
      // 组内的 proxies 内联数组：proxies: [a, b, c]
      const inlineMatch = /^(\s*)proxies\s*:\s*\[(.*)\]\s*$/.exec(line);
      if (inlineMatch) {
        const names = splitInlineList(inlineMatch[2]);
        const keptNames = names.filter((name) => {
          if (!filteredNames.has(name)) return true;
          group.droppedMembers += 1;
          groupRefs.push({ name, group: group.name });
          return false;
        });
        group.keptMembers = keptNames.length;
        group.inline = true;
        if (!keptNames.length) {
          group.keptMembers = 1;
          emptyGroups.push(group.name || '(未命名策略组)');
          warnings.push(`策略组「${group.name || '(未命名)'}」成员全部被过滤，已补 DIRECT 占位`);
          out.push(`${inlineMatch[1]}proxies: [DIRECT]`);
        } else {
          out.push(`${inlineMatch[1]}proxies: [${keptNames.join(', ')}]`);
        }
        group.expectMembers = false;
        continue;
      }

      const keyMatch = /^(\s*)proxies\s*:\s*(?:#.*)?$/.exec(line);
      if (keyMatch) {
        group.keyIndex = out.length;
        group.memberPrefix = `${keyMatch[1]}  - `;
        out.push(line);
        group.expectMembers = true;
        continue;
      }

      if (group.expectMembers) {
        const memberMatch = MEMBER_LINE_PATTERN.exec(line);
        if (memberMatch) {
          const name = unquote(memberMatch[2]);
          if (filteredNames.has(name)) {
            group.droppedMembers += 1;
            groupRefs.push({ name, group: group.name });
            if (!group.memberPrefix) group.memberPrefix = `${memberMatch[1]}- `;
            continue;
          }
          group.keptMembers += 1;
          out.push(line);
          continue;
        }
        group.expectMembers = false;
      }

      out.push(line);
      continue;
    }

    // 组内尚未遇到策略组名（如 `- name:` 之后紧跟的键值行）
    out.push(line);
  }
  closeGroup();

  // 第三遍兜底：清扫流式策略组（单行 `{ ... proxies: [...] }`）里对已过滤节点的引用
  const swept = sweepInlineGroupRefs(out, filteredNames, { groupRefs, emptyGroups, warnings });

  return {
    text: swept.join('\n'),
    filtered,
    groupRefs,
    keptCount: kept.length,
    scannedCount,
    whitelistedCount,
    emptyGroups,
    warnings,
  };
}

module.exports = {
  AD_NAME_KEYWORDS,
  AD_NAME_PATTERNS,
  NAME_WHITELIST_PATTERNS,
  classifyNode,
  serverReason,
  filterAdProxies,
  sweepInlineGroupRefs,
  extractField,
};
