'use strict';

/**
 * 离线可读页面缓存（清单「离线可用第一版」）。
 *
 * 目标只有一个：**断网时用户还能看到上次读到的内容**，而不是一个纯错误码。
 *
 * 三条设计约束：
 * 1. 只缓存正文快照（标题 + 去掉导航/脚本的纯文字），不缓存 HTML、不缓存 Cookie，
 *    落盘文件是明文 JSON，用户随时可以删（`page-cache.json`）。
 * 2. 隐私模式一律不写缓存——隐私模式的承诺是「不落盘」，缓存正文同样算落盘。
 * 3. 缓存页在界面上必须自称是缓存：带抓取时间、带「可能已过期」的说明，
 *    绝不能让用户以为这是刚从网上取到的最新内容。
 *
 * 这里全是纯函数（零 Electron），页面侧脚本单独用 String.raw 拼，
 * 因为普通模板串会把 /\n+/ 里的 \n 变成真换行，页面脚本会直接语法错误。
 */

const CACHE_VERSION = 2;
const CACHE_LIMIT = 50;
const CACHE_TEXT_MAX = 4000;
const CACHE_TITLE_MAX = 200;
const CACHE_BLOCK_MAX = 120;
const CACHE_IMAGE_MAX = 12;
/** 单张图最多存多少字节（超过就只留说明文字，不拉本体） */
const CACHE_IMAGE_BYTES_MAX = 120 * 1024;
/** 一页最多为图片花多少字节（所有图加起来） */
const CACHE_IMAGE_TOTAL_MAX = 480 * 1024;
/** 一页最多为几张图真的去取本体 */
const CACHE_IMAGE_FETCH_MAX = 6;
/** data URL 字符串的长度上限（base64 比原字节大约 4/3，留点余量） */
const CACHE_IMAGE_DATAURL_MAX = Math.ceil((CACHE_IMAGE_BYTES_MAX * 4) / 3) + 128;

/**
 * 缓存正文的页面侧脚本：取「结构化的正文」而不是一坨纯文字。
 *
 * v2 为什么要块：v1 只有若干行字符串，断网时整页看起来像一块砖，
 * 分不清哪里是小标题、哪里是列表。现在每块带类型（标题/段落/列表/引用/代码），
 * 断网页就能按原结构排出来——这也是「离线快照支持样式」的可行做法：
 * 不搬 CSS，只保留能表达层级的语义。
 *
 * 图片只存 alt 文字，不存二进制：存图等于把别人的图拉到本机磁盘上，
 * 隐私与体积都不该由一次浏览决定（这条写在说明里，不允许悄悄改）。
 * ——候选② 之后的调整：允许存**小图本体**，但要同时满足单张 ≤120KB、
 * 一页合计 ≤480KB、一页最多 6 张、且用户开着离线缓存；超限的一律退回"只有说明文字"。
 * 这个上限不是随手写的：拿一页 6 张 ×120KB 就是 720KB 落盘，50 页会到 30MB+，
 * 对"顺手看一眼断网内容"这个目标明显过头。
 */
function buildCaptureScript() {
  return String.raw`(() => {
    const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    if (!root) return { ok: false, reason: 'no-root' };
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME', 'TEXTAREA', 'SELECT']);
    const typeOf = (tag) => {
      if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') return 'heading';
      if (tag === 'LI') return 'list';
      if (tag === 'BLOCKQUOTE') return 'quote';
      if (tag === 'PRE' || tag === 'CODE') return 'code';
      if (tag === 'FIGCAPTION') return 'caption';
      return 'para';
    };
    const blocks = [];
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (skip.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        const tag = node.tagName;
        const want = tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4' ||
          tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'FIGCAPTION';
        return want ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let node = walker.nextNode();
    while (node) {
      const text = clean(node.innerText || node.textContent);
      if (text.length >= 4 && !seen.has(text)) {
        seen.add(text);
        blocks.push({ type: typeOf(node.tagName), text });
        if (blocks.length >= 120) break;
      }
      node = walker.nextNode();
    }
    const images = [];
    let skippedImages = 0;
    const nodes = root.querySelectorAll('img');
    for (const img of nodes) {
      const alt = clean(img.alt || img.title || '');
      const src = String(img.currentSrc || img.src || '');
      const usable = /^https?:\/\//i.test(src);
      if (!alt && !usable) { skippedImages += 1; continue; }
      if (images.length >= 12) break;
      images.push({ alt: alt.slice(0, 80), src: usable ? src.slice(0, 2048) : '' });
    }
    const lines = [];
    const seenLine = new Set();
    for (const block of blocks) {
      if (seenLine.has(block.text)) continue;
      seenLine.add(block.text);
      lines.push(block.text);
    }
    const title = clean(document.title);
    return { ok: true, url: location.href, title, blocks, images, skippedImages, lines };
  })()`;
}

/** 把 URL 规整成缓存键：去掉 hash，只对 http(s) 生效（其余协议不缓存）。 */
function cacheKeyOf(url) {
  if (typeof url !== 'string') return '';
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return '';
  const hashAt = text.indexOf('#');
  return hashAt >= 0 ? text.slice(0, hashAt) : text;
}

const BLOCK_TYPES = ['heading', 'para', 'list', 'quote', 'code', 'caption'];

function normalizeBlockType(raw) {
  const text = String(raw || '').toLowerCase();
  return BLOCK_TYPES.indexOf(text) >= 0 ? text : 'para';
}

/** 把页面侧脚本的原始输出整理成一条快照（不符合条件就返回 null，不存半条）。 */
function normalizeSnapshot(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const key = cacheKeyOf(input.url);
  if (!key) return null;
  const title = String(input.title || '').replace(/\s+/g, ' ').trim().slice(0, CACHE_TITLE_MAX);
  // 已归一过的快照只有 text（读盘回来的就是这种）——必须能吃下自己，
  // 否则 putSnapshot 把一条合法快照再归一一次就会判成非法，缓存永远写不进去。
  const rawBlocks = Array.isArray(input.blocks) ? input.blocks : null;
  const source = Array.isArray(input.lines)
    ? input.lines
    : typeof input.text === 'string'
      ? String(input.text).split('\n')
      : [];

  const blocks = [];
  let used = 0;
  const pushBlock = (type, text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 2) return;
    if (used + clean.length > CACHE_TEXT_MAX) {
      if (used === 0) blocks.push({ type, text: clean.slice(0, CACHE_TEXT_MAX) });
      return;
    }
    blocks.push({ type, text: clean });
    used += clean.length;
  };

  if (rawBlocks) {
    for (const item of rawBlocks) {
      if (blocks.length >= CACHE_BLOCK_MAX) break;
      if (typeof item === 'string') pushBlock('para', item);
      else if (item && typeof item === 'object') pushBlock(normalizeBlockType(item.type), item.text);
    }
  } else {
    // v1 快照（只有 lines / text）：当成段落，结构退化为「一段一行」，但内容不丢。
    for (const line of source) {
      if (blocks.length >= CACHE_BLOCK_MAX) break;
      pushBlock('para', line);
    }
  }

  const text = blocks.map((block) => block.text).join('\n');
  // 没有正文就不写：一条只有标题的缓存，在断网时比"没有缓存"更容易误导人。
  if (text.length < 20) return null;

  const images = [];
  const rawImages = Array.isArray(input.images) ? input.images : [];
  for (const item of rawImages) {
    if (images.length >= CACHE_IMAGE_MAX) break;
    if (typeof item === 'string') {
      const alt = item.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (alt) images.push({ alt });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const alt = String(item.alt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const src = String(item.src || '').trim();
    const entry = {};
    if (alt) entry.alt = alt;
    if (/^https?:\/\//i.test(src)) entry.src = src.slice(0, 2048);
    // data URL 只认图片类型，且长度必须在我们自己的上限内（读回来的文件也要过一遍，
    // 不许因为"磁盘上是老的"就无条件信任）。
    const dataUrl = String(item.dataUrl || '');
    if (/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(dataUrl) && dataUrl.length <= CACHE_IMAGE_DATAURL_MAX) {
      entry.dataUrl = dataUrl;
      if (Number(item.bytes) > 0) entry.bytes = Math.floor(Number(item.bytes));
    }
    if (entry.alt || entry.src || entry.dataUrl) images.push(entry);
  }

  return {
    url: key,
    title: title || key,
    text,
    blocks,
    images,
    chars: text.length,
    // 跳过了多少张没有说明文字的图也要记账：界面上说「只保留图片说明」时，
    // 用户有权知道到底漏掉了多少张。
    skippedImages: Number(input.skippedImages) > 0 ? Math.floor(Number(input.skippedImages)) : 0,
    at: Number(input.at) > 0 ? Number(input.at) : Date.now(),
  };
}

/**
 * 这一页还值得去取本体的图片（候选②）。
 *
 * 只挑 http(s) 且还没有 dataUrl 的前若干张：已经存过的不要重复下载，
 * data:/blob: 也没必要（要么本机已有，要么取不到）。
 * 取不取得到、多大、什么格式，全部由调用方按上限判定——这里只负责"挑谁去取"。
 */
function imageTargets(snapshot) {
  const images = snapshot && Array.isArray(snapshot.images) ? snapshot.images : [];
  const out = [];
  for (const item of images) {
    if (!item || typeof item !== 'object') continue;
    if (item.dataUrl) continue;
    if (!/^https?:\/\//i.test(String(item.src || ''))) continue;
    out.push(item.src);
    if (out.length >= CACHE_IMAGE_FETCH_MAX) break;
  }
  return out;
}

/**
 * 把取到的图片本体贴回快照（候选②）。
 *
 * `fetched` 形如 `[{ src, dataUrl, bytes }]`；没贴上的图保持"只有说明文字"。
 * 这里会再走一次 normalizeSnapshot，好处是上限判定只写在一处——
 * 调用方给什么都不会越过"单张 ≤120KB、一页合计 ≤480KB"这条线。
 */
function attachImageData(snapshot, fetched) {
  const list = Array.isArray(fetched) ? fetched : [];
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  if (!list.length) return normalizeSnapshot(input);
  const bySrc = new Map();
  for (const item of list) {
    if (!item || !item.src || !item.dataUrl) continue;
    bySrc.set(String(item.src), item);
  }
  const images = (Array.isArray(input.images) ? input.images : []).map((image) => {
    if (!image || typeof image !== 'object') return image;
    const hit = bySrc.get(String(image.src || ''));
    if (!hit) return image;
    return { ...image, dataUrl: hit.dataUrl, bytes: Number(hit.bytes) || 0 };
  });
  return normalizeSnapshot({ ...input, images });
}

/** 读盘内容 → 缓存表；脏数据当成空表，不让一个坏文件把离线能力整体搞死。 */
function readCache(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      return { version: CACHE_VERSION, items: [] };
    }
  }
  const input = parsed && typeof parsed === 'object' ? parsed : {};
  const items = Array.isArray(input.items) ? input.items : [];
  const cleaned = [];
  for (const item of items) {
    const snap = normalizeSnapshot(item);
    if (snap) cleaned.push(snap);
  }
  cleaned.sort((a, b) => b.at - a.at);
  return { version: CACHE_VERSION, items: cleaned.slice(0, CACHE_LIMIT) };
}

/** 写入一条快照，返回新的缓存表（最近用的排最前，超限丢最旧的）。 */
function putSnapshot(rawStore, rawSnapshot) {
  const store = readCache(rawStore);
  const snap = normalizeSnapshot(rawSnapshot);
  if (!snap) return { store, stored: false };
  const items = store.items.filter((item) => item.url !== snap.url);
  items.unshift(snap);
  return { store: { version: CACHE_VERSION, items: items.slice(0, CACHE_LIMIT) }, stored: true };
}

/** 按地址取缓存（精确匹配，不做"差不多"匹配：给错页面比不给更危险）。 */
function getSnapshot(rawStore, url) {
  const key = cacheKeyOf(url);
  if (!key) return null;
  const store = readCache(rawStore);
  const hit = store.items.find((item) => item.url === key);
  return hit || null;
}

/** 缓存页展示用的结构：带上抓取时间与"可能过期"的说明。 */
function describeCachedPage(snapshot, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  if (!snapshot || !snapshot.text) {
    return {
      available: false,
      title: '',
      text: '',
      blocks: [],
      images: [],
      at: 0,
      time: '',
      ageText: '',
      note: '这一页之前没有缓存，断网时无法显示旧内容。',
    };
  }
  const at = Number(snapshot.at) > 0 ? snapshot.at : 0;
  const minutes = at ? Math.max(0, Math.round((now - at) / 60000)) : 0;
  let ageText = '';
  if (at) {
    if (minutes < 1) ageText = '刚刚';
    else if (minutes < 60) ageText = `${minutes} 分钟前`;
    else if (minutes < 60 * 24) ageText = `${Math.round(minutes / 60)} 小时前`;
    else ageText = `${Math.round(minutes / (60 * 24))} 天前`;
  }
  const time = at ? new Date(at).toISOString() : '';
  return {
    available: true,
    title: snapshot.title || snapshot.url || '',
    text: snapshot.text,
    blocks: Array.isArray(snapshot.blocks) ? snapshot.blocks : [],
    images: Array.isArray(snapshot.images) ? snapshot.images : [],
    chars: Number(snapshot.chars) || String(snapshot.text).length,
    url: snapshot.url || '',
    at,
    time,
    ageText,
    note: `这是 ${ageText || '之前'}抓取的缓存快照，不是刚取到的最新内容——网络恢复后请点「重试」重新加载。`,
  };
}

/* ---------------- 按站点的黑白名单（用户第 5 项） ---------------- */

/**
 * 为什么要有这个：离线缓存默认"什么都存"，但用户可能只想留几个常用的站点，
 * 或者干脆想让某几个站（银行、公司内网）一条都不在磁盘上留。
 *
 * 三层判定，顺序是刻意的：
 *   1. 黑名单命中 → 不缓存（黑名单永远优先，白名单不能豁免它）；
 *   2. 白名单模式（mode='allowlist'）→ 只有名单里的才缓存；
 *   3. 其余统统按 mode 决定（'all' 全存 / 'allowlist' 不存）。
 *
 * 名单只做域名级：`example.com` 连子域一起算，这样用户写一条就够了，
 * 不会出现"写了 example.com 但 www.example.com 漏了"这种事。
 */
const CACHE_SITE_MODES = ['all', 'allowlist'];

function normalizeSiteText(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return '';
  let host = text;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname;
  } catch {
    return '';
  }
  return host.replace(/^www\./, '').replace(/\.$/, '');
}

function normalizeSiteList(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const host = normalizeSiteText(item);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out.slice(0, 200);
}

function normalizeSitePolicy(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: CACHE_SITE_MODES.includes(input.mode) ? input.mode : 'all',
    allow: normalizeSiteList(input.allow),
    block: normalizeSiteList(input.block),
  };
}

function siteMatches(host, rule) {
  if (!host || !rule) return false;
  return host === rule || host.endsWith(`.${rule}`);
}

/**
 * 「只存这些」的模板：几组常见站点的起点名单。
 *
 * 两条自我约束：
 *   1. 模板只是**起点**，套上去之后用户还能逐条删、逐条加——不提供"锁死的推荐名单"；
 *   2. 套用一律走 merge（并进现有名单），绝不静默替换用户已经手写的那份。
 * 换句话说：模板负责省打字，不负责替用户做决定。
 */
const SITE_TEMPLATES = [
  {
    key: 'docs',
    label: '文档与手册',
    summary: '查资料最常打开的几家中英文文档站；这类页面文字多，离线留着最有用。',
    sites: ['developer.mozilla.org', 'docs.python.org', 'learn.microsoft.com', 'doc.rust-lang.org', 'devdocs.io'],
  },
  {
    key: 'reference',
    label: '百科与参考',
    summary: '百科与标准文档；页面结构规整，快照读起来干净。',
    sites: ['wikipedia.org', 'zh.wikipedia.org', 'w3.org', 'rfc-editor.org'],
  },
  {
    key: 'news',
    label: '新闻与通讯',
    summary: '只列了几家通讯社与公共广播；商业新闻站的付费墙与追踪器多，要不要留请你自己判断。',
    sites: ['reuters.com', 'apnews.com', 'bbc.com', 'npr.org'],
  },
];

function describeSiteTemplates(extra) {
  const custom = normalizeCustomTemplates(extra);
  const list = SITE_TEMPLATES.concat(custom.map((item) => ({
    key: item.key,
    label: item.label,
    summary: item.summary,
    sites: item.sites,
  })));
  return list.map((item) => ({
    key: item.key,
    label: item.label,
    summary: item.summary,
    sites: normalizeSiteList(item.sites),
    count: normalizeSiteList(item.sites).length,
    custom: custom.some((entry) => entry.key === item.key),
  }));
}

/**
 * 自定义模板（第八轮 ⑤）：把自己攒的那份名单存成模板，换机器一键套。
 *
 * 为什么只存站点、不存模式：模板的语义是"这些站点值得离线留"，
 * 模式是用户当前的选择（全部 / 只存名单），存进模板里会在套用时把
 * 用户当下的选择覆盖掉——而套用这一步已经把模式切到 allowlist 了。
 */
const CUSTOM_TEMPLATE_MAX = 30;
const CUSTOM_TEMPLATE_SITES_MAX = 60;

function normalizeCustomTemplate(raw) {
  const item = raw && typeof raw === 'object' ? raw : null;
  if (!item) return null;
  const label = typeof item.label === 'string' ? item.label.trim().slice(0, 40) : '';
  if (!label) return null;
  const sites = normalizeSiteList(item.sites).slice(0, CUSTOM_TEMPLATE_SITES_MAX);
  if (!sites.length) return null;
  const createdAt = Number.isFinite(item.createdAt) && item.createdAt > 0 ? item.createdAt : 0;
  // key 由标签派生，保证同一个名字不会攒出两条；标签改了就是另一条
  const key = `custom-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return {
    key,
    label,
    summary: typeof item.summary === 'string' && item.summary
      ? item.summary.slice(0, 120)
      : `你自己存的：${sites.length} 个站点。`,
    sites,
    createdAt,
  };
}

function normalizeCustomTemplates(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const item = normalizeCustomTemplate(entry);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
    if (out.length >= CUSTOM_TEMPLATE_MAX) break;
  }
  return out;
}

/**
 * 把当前名单快照成一个模板。
 * 返回 { ok, templates, template, error }：重名直接拒（不覆盖已有的），
 * 名单为空也拒（存一个空模板，套用时什么都不会发生，只会让人困惑）。
 */
function addCustomTemplate(rawTemplates, rawPolicy, name, now) {
  const templates = normalizeCustomTemplates(rawTemplates);
  const policy = normalizeSitePolicy(rawPolicy);
  const label = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  if (!label) {
    return { ok: false, code: 'EMPTY_NAME', error: '先给模板起个名字，例如「我们组的文档站」。', templates };
  }
  if (!policy.allow.length) {
    return {
      ok: false,
      code: 'EMPTY_LIST',
      error: '名单还是空的，没有可存的站点。先把要离线留的站点加进名单，再存成模板。',
      templates,
    };
  }
  const stamp = Number.isFinite(now) && now > 0 ? now : Date.now();
  const draft = normalizeCustomTemplate({ label, sites: policy.allow, createdAt: stamp });
  if (!draft) {
    return { ok: false, code: 'BAD_TEMPLATE', error: '这份名单存不成模板（名字或站点不合法）。', templates };
  }
  const existed = templates.find((item) => item.key === draft.key);
  if (existed) {
    return {
      ok: false,
      code: 'DUPLICATE_NAME',
      error: `已经有一个叫「${existed.label}」的模板了。换个名字，或者先把旧的删掉。`,
      templates,
    };
  }
  if (templates.length >= CUSTOM_TEMPLATE_MAX) {
    return {
      ok: false,
      code: 'TOO_MANY_TEMPLATES',
      error: `自定义模板最多 ${CUSTOM_TEMPLATE_MAX} 个，先删掉几个再存。`,
      templates,
    };
  }
  const next = templates.concat([draft]);
  return { ok: true, templates: next, template: { key: draft.key, label: draft.label, count: draft.sites.length } };
}

function removeCustomTemplate(rawTemplates, key) {
  const templates = normalizeCustomTemplates(rawTemplates);
  const target = typeof key === 'string' ? key : '';
  const next = templates.filter((item) => item.key !== target);
  if (next.length === templates.length) {
    return { ok: false, code: 'NOT_FOUND', error: '没有这个模板，可能已经被删掉了。', templates };
  }
  return { ok: true, templates: next };
}

/**
 * 把一个模板并进现有名单。
 * 返回 { ok, policy, template, added, skipped, message }：
 * added 是真正写进去的站点（逐项可显示），skipped 是已经在名单里的——
 * 界面要把这两个数分开说，否则用户会以为"套了模板但没变化"是我们坏了。
 */
function applySiteTemplate(rawPolicy, key, extra) {
  const policy = normalizeSitePolicy(rawPolicy);
  const wanted = String(key || '');
  const custom = normalizeCustomTemplates(extra);
  const template = SITE_TEMPLATES.find((item) => item.key === wanted)
    || custom.find((item) => item.key === wanted);
  if (!template) {
    return {
      ok: false,
      code: 'UNKNOWN_TEMPLATE',
      error: `没有叫「${wanted}」的模板。`,
      policy,
    };
  }
  const sites = normalizeSiteList(template.sites);
  const existing = new Set(policy.allow);
  const added = [];
  const skipped = [];
  for (const site of sites) {
    if (existing.has(site)) {
      skipped.push(site);
      continue;
    }
    existing.add(site);
    added.push(site);
  }
  const next = normalizeSitePolicy({
    // 套模板的意图就是"只存这些"，所以模式一起切到 allowlist
    mode: 'allowlist',
    allow: [...policy.allow, ...added],
    block: policy.block,
  });
  const message = added.length
    ? `已把「${template.label}」的 ${added.length} 个站点并进名单${skipped.length ? `（${skipped.length} 个本来就在）` : ''}，模式已切到「只存名单里的」。`
    : `「${template.label}」里的 ${skipped.length} 个站点本来就在名单里，模式已切到「只存名单里的」。`;
  return {
    ok: true,
    policy: next,
    template: { key: template.key, label: template.label },
    added,
    skipped,
    modeChanged: policy.mode !== 'allowlist',
    message,
  };
}


/**
 * 这一页要不要存快照。
 * 返回 { cache, layer, host, reason }：layer 是命中的那一层，reason 是中文说明，
 * 界面与日志直接用，不许自己再编一套话。
 */
function decideCacheSite(rawUrl, rawPolicy) {
  const policy = normalizeSitePolicy(rawPolicy);
  let host = '';
  try {
    host = normalizeSiteText(String(rawUrl || ''));
  } catch {
    host = '';
  }
  if (!host) {
    return { cache: false, layer: 'no-host', host: '', reason: '这个地址没有可识别的站点，不缓存。' };
  }
  const blocked = policy.block.find((rule) => siteMatches(host, rule));
  if (blocked) {
    return {
      cache: false,
      layer: 'block',
      host,
      reason: `${host} 在「不缓存的站点」里，这一页不会存快照。`,
    };
  }
  if (policy.mode === 'allowlist') {
    const allowed = policy.allow.find((rule) => siteMatches(host, rule));
    if (!allowed) {
      return {
        cache: false,
        layer: 'not-listed',
        host,
        reason: `当前是「只缓存名单里的站点」，${host} 不在名单里。`,
      };
    }
    return { cache: true, layer: 'allow', host, reason: `${host} 在「只缓存的站点」名单里。` };
  }
  return { cache: true, layer: 'all', host, reason: '当前允许缓存所有站点。' };
}

/**
 * 缓存站点名单的导出/导入（候选⑤）。
 *
 * 为什么单独一套格式：它和 agent 站点名单是两个东西——那边管的是「agent 能不能动这个站」，
 * 这边管的是「断网时要不要留这个站的正文」。共用一个 kind 会让人把两份名单搞混，
 * 进了错的文件比没有文件更糟。
 */
const CACHE_SITE_EXPORT_KIND = 'nyx-cache-sites';
const CACHE_SITE_EXPORT_VERSION = 1;

/**
 * 两份名单各有一个 kind（第五轮 ③）：
 *   普通模式那份导出的是一份文件，隐私模式那份是另一份。
 *   导错文件比没有文件更糟——把「只存这些明文正文」的名单导进加密快照那边，
 *   用户会以为自己的隐私设置生效了，其实一份都没生效。
 */
const CACHE_SITE_EXPORT_KINDS = {
  normal: CACHE_SITE_EXPORT_KIND,
  private: 'nyx-private-cache-sites',
};

const CACHE_SITE_SCOPE_LABELS = {
  normal: '普通模式的站点名单',
  private: '隐私模式（加密快照）的站点名单',
};

function scopeOf(options) {
  const opts = options && typeof options === 'object' ? options : {};
  return opts.scope === 'private' ? 'private' : 'normal';
}

function exportCacheSites(policy, now, scope) {
  const safe = normalizeSitePolicy(policy);
  const stamp = Number.isFinite(now) ? now : Date.now();
  const which = scopeOf({ scope });
  return {
    app: 'nyx',
    kind: CACHE_SITE_EXPORT_KINDS[which],
    scope: which,
    version: CACHE_SITE_EXPORT_VERSION,
    exportedAt: new Date(stamp).toISOString(),
    mode: safe.mode,
    allow: safe.allow.slice(),
    block: safe.block.slice(),
  };
}

function importCacheSites(rawText, current, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const base = normalizeSitePolicy(current);
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const which = scopeOf(opts);
  const expectedKind = CACHE_SITE_EXPORT_KINDS[which];
  const text = typeof rawText === 'string' ? rawText.replace(/^\uFEFF/, '') : '';

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '这个文件不是 JSON，可能不是 Nyx 导出的名单。', policy: base };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '文件内容不是一份名单（应该是一个对象）。', policy: base };
  }
  if (parsed.kind !== expectedKind) {
    const what = typeof parsed.kind === 'string' && parsed.kind ? `「${parsed.kind}」` : '（没写）';
    const hint =
      parsed.kind === CACHE_SITE_EXPORT_KINDS.private || parsed.kind === CACHE_SITE_EXPORT_KINDS.normal
        ? '（这是另一份名单，别导错）'
        : '';
    return {
      ok: false,
      error: `这份文件的类型是${what}${hint}，不是${CACHE_SITE_SCOPE_LABELS[which]}。`,
      policy: base,
    };
  }
  if (parsed.allow === undefined && parsed.block === undefined) {
    return { ok: false, error: '文件里既没有 allow 也没有 block 名单。', policy: base };
  }

  const rejected = [];
  const next = mode === 'replace'
    ? { ...base, allow: [], block: [] }
    : { ...base, allow: base.allow.slice(), block: base.block.slice() };
  let added = 0;
  let duplicates = 0;

  const absorb = (rawList, bucket) => {
    if (!Array.isArray(rawList)) return;
    for (const item of rawList) {
      const host = normalizeSiteText(item);
      if (!host) {
        if (rejected.length < 10) rejected.push(typeof item === 'string' ? item : String(item));
        continue;
      }
      if (next[bucket].includes(host)) {
        duplicates += 1;
        continue;
      }
      next[bucket].push(host);
      added += 1;
    }
  };

  absorb(parsed.allow, 'allow');
  absorb(parsed.block, 'block');

  // 模式只在文件明确写了、且是合法值时才采纳（replace 时尤其重要：空名单 + 白名单模式 = 什么都不缓存）
  let modeAdopted = false;
  if (typeof parsed.mode === 'string' && CACHE_SITE_MODES.includes(parsed.mode)) {
    if (parsed.mode !== next.mode) modeAdopted = true;
    next.mode = parsed.mode;
  }

  const normalized = normalizeSitePolicy(next);
  const rejectedCount = rejected.length;
  const parts = [`导入完成：新增 ${added} 条`];
  if (duplicates) parts.push(`已存在 ${duplicates} 条`);
  if (rejectedCount) parts.push(`跳过 ${rejectedCount} 条看不懂的`);

  return {
    ok: true,
    mode,
    policy: normalized,
    allow: normalized.allow,
    block: normalized.block,
    siteMode: normalized.mode,
    modeAdopted,
    added,
    duplicates,
    rejected,
    rejectedCount,
    summary: `${parts.join('，')}。`,
  };
}

/**
 * 自定义模板的导出格式（第九轮 ③）。
 * 和站点名单分开一个 kind：模板是"清单的清单"，导进名单文件里会变成一条叫 "custom-xxx" 的站点。
 * version 单独一个号，因为模板格式以后会长（比如带 mode、带备注），不能和名单共用一个版本号。
 */
const CACHE_TEMPLATE_EXPORT_KIND = 'nyx-cache-templates';
const CACHE_TEMPLATE_EXPORT_VERSION = 2;

function exportCustomTemplates(rawTemplates, now) {
  const list = normalizeCustomTemplates(rawTemplates);
  const stamp = Number.isFinite(now) ? now : Date.now();
  return {
    app: 'nyx',
    kind: CACHE_TEMPLATE_EXPORT_KIND,
    version: CACHE_TEMPLATE_EXPORT_VERSION,
    exportedAt: new Date(stamp).toISOString(),
    count: list.length,
    templates: list.map((item) => ({
      label: item.label,
      sites: item.sites.slice(),
      createdAt: item.createdAt || 0,
    })),
  };
}

/**
 * 导入自定义模板。整份文件要么按 merge 并进来、要么按 replace 顶掉，不做"部分成功"。
 * 认不出的条目逐条跳过并在 summary 里报数，绝不静默丢。
 */
function importCustomTemplates(rawText, current, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  const base = normalizeCustomTemplates(current);
  const text = typeof rawText === 'string' ? rawText.replace(/^\uFEFF/, '') : '';

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: '这个文件不是 JSON，可能不是 Nyx 导出的模板。', templates: base };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '文件内容不是一份模板（应该是一个对象）。', templates: base };
  }
  if (parsed.kind !== CACHE_TEMPLATE_EXPORT_KIND) {
    const what = typeof parsed.kind === 'string' && parsed.kind ? `「${parsed.kind}」` : '（没写）';
    const hint = parsed.kind === CACHE_SITE_EXPORT_KIND || parsed.kind === CACHE_SITE_EXPORT_KINDS.private
      ? '（这是站点名单，不是模板——名单请用名单的导入按钮）'
      : '';
    return { ok: false, error: `这份文件的类型是${what}${hint}，不是自定义模板。`, templates: base };
  }
  const version = Number(parsed.version);
  if (Number.isFinite(version) && version > CACHE_TEMPLATE_EXPORT_VERSION) {
    return {
      ok: false,
      error: `这份模板是更新版本的 Nyx 导出的（格式 ${version}，这个版本只认到 ${CACHE_TEMPLATE_EXPORT_VERSION}）。升级 Nyx 再导。`,
      templates: base,
    };
  }
  const incoming = Array.isArray(parsed.templates) ? parsed.templates : Array.isArray(parsed.custom) ? parsed.custom : null;
  if (!incoming) {
    return { ok: false, error: '文件里没有 templates 清单。', templates: base };
  }

  const next = mode === 'replace' ? [] : base.slice();
  const rejected = [];
  let added = 0;
  let duplicates = 0;
  for (const item of incoming) {
    const normalized = normalizeCustomTemplate(item);
    if (!normalized) {
      if (rejected.length < 10) rejected.push(typeof item === 'string' ? item : String((item && item.label) || item));
      continue;
    }
    if (next.some((exist) => exist.key === normalized.key)) {
      duplicates += 1;
      continue;
    }
    next.push(normalized);
    added += 1;
  }

  const overflow = Math.max(0, next.length - CUSTOM_TEMPLATE_MAX);
  const kept = next.slice(0, CUSTOM_TEMPLATE_MAX);
  const parts = [`导入完成：新增 ${added} 个模板`];
  if (duplicates) parts.push(`已存在 ${duplicates} 个`);
  if (rejected.length) parts.push(`跳过 ${rejected.length} 个看不懂的`);
  if (overflow) parts.push(`超出上限丢掉了 ${overflow} 个（最多 ${CUSTOM_TEMPLATE_MAX} 个）`);

  return {
    ok: true,
    mode,
    templates: kept,
    custom: kept,
    added,
    duplicates,
    rejected,
    rejectedCount: rejected.length,
    overflow,
    summary: `${parts.join('，')}。`,
  };
}

module.exports = {
  BLOCK_TYPES,
  CACHE_BLOCK_MAX,
  CACHE_IMAGE_BYTES_MAX,
  CACHE_IMAGE_DATAURL_MAX,
  CACHE_IMAGE_FETCH_MAX,
  CACHE_IMAGE_MAX,
  CACHE_IMAGE_TOTAL_MAX,
  CACHE_LIMIT,
  CACHE_SITE_EXPORT_KIND,
  CACHE_SITE_EXPORT_KINDS,
  CACHE_SITE_SCOPE_LABELS,
  CACHE_SITE_EXPORT_VERSION,
  CACHE_SITE_MODES,
  CACHE_TEMPLATE_EXPORT_KIND,
  CACHE_TEMPLATE_EXPORT_VERSION,
  CACHE_TEXT_MAX,
  CACHE_VERSION,
  CUSTOM_TEMPLATE_MAX,
  CUSTOM_TEMPLATE_SITES_MAX,
  addCustomTemplate,
  attachImageData,
  applySiteTemplate,
  buildCaptureScript,
  cacheKeyOf,
  decideCacheSite,
  describeCachedPage,
  describeSiteTemplates,
  exportCacheSites,
  exportCustomTemplates,
  getSnapshot,
  imageTargets,
  importCacheSites,
  importCustomTemplates,
  normalizeSiteList,
  normalizeSitePolicy,
  normalizeSiteText,
  normalizeSnapshot,
  normalizeCustomTemplates,
  putSnapshot,
  readCache,
  removeCustomTemplate,
};
