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
      if (!alt) { skippedImages += 1; continue; }
      if (images.length >= 12) break;
      images.push({ alt: alt.slice(0, 80) });
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
    if (item && typeof item === 'object') {
      const alt = String(item.alt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (alt) images.push({ alt });
    }
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

module.exports = {
  BLOCK_TYPES,
  CACHE_BLOCK_MAX,
  CACHE_IMAGE_MAX,
  CACHE_LIMIT,
  CACHE_TEXT_MAX,
  CACHE_VERSION,
  buildCaptureScript,
  cacheKeyOf,
  describeCachedPage,
  getSnapshot,
  normalizeSnapshot,
  putSnapshot,
  readCache,
};
