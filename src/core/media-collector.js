'use strict';

/**
 * 页面媒体收集器：把"这一页上看得见的图"列成清单，供用户逐条勾选下载。
 *
 * 为什么不能只靠工具箱嗅探：
 *   嗅探走 CDP 的 Network 域，只能看到"网络真的请求过、且扩展名或 MIME 能判"的资源。
 *   页面上真正被用户当作"图标/图片"的东西，经常一条请求都没有——
 *   CSS 背景图可能是 `background-image: image-set(...)`、内联 `<svg>` 根本没有 URL、
 *   favicon 是浏览器自己按 `link[rel=icon]` 取的（甚至没进 Network 视口）、
 *   `srcset` 只发最大那张、懒加载图在滚动前只有 `data-src`。
 *   所以要真正"把页面上所有图面/标志存下来"，必须回到 DOM 里数。
 *
 * 分层：
 *   buildCollectorScript()  —— 注入页面执行的采集脚本（只读 DOM + 样式，不发请求、不写盘）
 *   normalizeCandidates()   —— 纯逻辑：补全相对地址、去重、定种类、起文件名
 *   filterCandidates()      —— 界面上的"种类筛选 + 关键字筛选"
 *
 * 隐私口径：采集只在内存里过一遍，落盘由用户点「下载选中」才发生；
 * 隐私模式的标签一律不写盘（由主进程拦，不靠这里判断）。
 */

/** 一次最多列多少条：再多人也点不过来，且 IPC 载荷会失控 */
const MAX_CANDIDATES = 400;

/** 采集时最多扫多少个元素找 CSS 背景（大页面几万个节点，扫全量会卡主线程） */
const MAX_SCAN_ELEMENTS = 8000;

/** 文件名主干长度上限（Windows 路径总长限制，留出目录与去重后缀的余量） */
const MAX_STEM = 80;

/** 种类 → 中文名。顺序即界面上的排序 */
const KIND_LABELS = {
  image: '图片',
  icon: '站点图标',
  svg: '矢量图',
  background: '背景图',
  poster: '视频封面',
  video: '视频',
};

const KIND_ORDER = ['image', 'icon', 'svg', 'background', 'poster', 'video'];

/** 拿不到扩展名时按种类兜底（宁可给个能打开的默认，也不给 .bin） */
const EXT_BY_KIND = {
  image: '.jpg',
  icon: '.png',
  svg: '.svg',
  background: '.jpg',
  poster: '.jpg',
  video: '.mp4',
};

/** URL 路径后缀能认出来的扩展名（认不出就走 EXT_BY_KIND） */
const SAFE_EXT = /^\.(jpe?g|png|gif|webp|bmp|avif|ico|svg|mp4|m4v|mov|mkv|webm|flv|mp3|m4a|aac|ogg|wav)$/i;

/**
 * 注入页面执行的采集函数。
 *
 * 约束（改的时候别破坏）：
 *   - 不写 DOM、不改网址、不发任何网络请求（测试里会静态扫 fetch/XHR/beacon）；
 *   - 所有异常就地吞掉，返回 { ok, items, page }，绝不抛到页面里；
 *   - 只读 innerText 之外的东西，不读输入框内容（避免碰到用户正在填的表单）。
 */
function collectInPage() {
  const items = [];

  function push(url, kind, origin, extra) {
    const value = String(url == null ? '' : url).trim();
    if (!value) return;
    const row = { url: value, kind: kind, origin: origin };
    if (extra) {
      if (extra.width) row.width = extra.width;
      if (extra.height) row.height = extra.height;
      if (extra.alt) row.alt = extra.alt;
      if (extra.note) row.note = extra.note;
    }
    items.push(row);
  }

  function srcsetUrls(value) {
    return String(value == null ? '' : value)
      .split(',')
      .map(function (part) {
        return String(part).trim().split(/\s+/)[0];
      })
      .filter(Boolean);
  }

  function measure(el) {
    try {
      return { width: el.naturalWidth || el.width || 0, height: el.naturalHeight || el.height || 0 };
    } catch (err) {
      return {};
    }
  }

  // ① <img>：当前生效的那张 + src + srcset 的全部候选 + 懒加载属性
  try {
    const imgs = document.images || [];
    for (let i = 0; i < imgs.length; i += 1) {
      const img = imgs[i];
      const box = measure(img);
      const alt = img.alt || '';
      if (img.currentSrc) push(img.currentSrc, 'image', 'img', Object.assign({ alt: alt }, box));
      if (img.src && img.src !== img.currentSrc) push(img.src, 'image', 'img', Object.assign({ alt: alt }, box));
      srcsetUrls(img.getAttribute('srcset')).forEach(function (u) {
        push(u, 'image', 'srcset', Object.assign({ alt: alt }, box));
      });
      ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-echo', 'data-lazyload'].forEach(function (attr) {
        const value = img.getAttribute(attr);
        if (value) push(value, 'image', 'lazy', { alt: alt, note: '懒加载属性' });
      });
      srcsetUrls(img.getAttribute('data-srcset')).forEach(function (u) {
        push(u, 'image', 'lazy', { alt: alt, note: '懒加载属性' });
      });
    }
  } catch (err) {
    /* 单类失败不影响其它类 */
  }

  // ② 内联 <svg>：页面上很多"标志"就是它，没有 URL，得自己序列化
  try {
    const svgs = document.querySelectorAll('svg');
    for (let i = 0; i < svgs.length; i += 1) {
      const svg = svgs[i];
      let markup = '';
      try {
        markup = new XMLSerializer().serializeToString(svg);
      } catch (err) {
        markup = '';
      }
      if (!markup || markup.length > 512 * 1024) continue;
      const box = svg.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const title = svg.querySelector('title');
      push(
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup),
        'svg',
        'inline-svg',
        { width: Math.round(box.width), height: Math.round(box.height), alt: title ? title.textContent : '' },
      );
    }
  } catch (err) {
    /* 同上 */
  }

  // ③ CSS 背景：只扫元素上看得到的 background/border/mask 图，最多扫 MAX_SCAN_ELEMENTS 个
  try {
    const all = document.querySelectorAll('*');
    const limit = Math.min(all.length, 8000);
    const pattern = /url\((['"]?)([^'")]+)\1\)/g;
    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      let style = null;
      try {
        style = window.getComputedStyle(el);
      } catch (err) {
        continue;
      }
      if (!style) continue;
      const box = el.getBoundingClientRect();
      const area = Math.max(0, Math.round(box.width)) * Math.max(0, Math.round(box.height));
      if (area < 4) continue;
      ['backgroundImage', 'borderImageSource', 'maskImage', 'webkitMaskImage'].forEach(function (prop) {
        const value = style[prop];
        if (!value || value === 'none') return;
        pattern.lastIndex = 0;
        let hit = pattern.exec(value);
        while (hit) {
          push(hit[2], 'background', 'css', { width: Math.round(box.width), height: Math.round(box.height) });
          hit = pattern.exec(value);
        }
      });
    }
  } catch (err) {
    /* 同上 */
  }

  // ④ favicon / apple-touch-icon：浏览器自己取的，Network 里常常看不到
  try {
    const links = document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"], link[rel="shortcut"]');
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      const href = link.getAttribute('href');
      if (!href) continue;
      const sizes = String(link.getAttribute('sizes') || '');
      const match = sizes.match(/(\d+)x(\d+)/i);
      push(href, 'icon', 'link', match ? { width: Number(match[1]), height: Number(match[2]), note: link.rel } : { note: link.rel });
    }
  } catch (err) {
    /* 同上 */
  }

  // ⑤ 视频与封面：用户要求"图片视频都可选"，这条是同一套清单里的另一半
  try {
    const videos = document.querySelectorAll('video');
    for (let i = 0; i < videos.length; i += 1) {
      const video = videos[i];
      const box = measure(video);
      if (video.poster) push(video.poster, 'poster', 'video', box);
      if (video.currentSrc) push(video.currentSrc, 'video', 'video', box);
      if (video.src && video.src !== video.currentSrc) push(video.src, 'video', 'video', box);
      const sources = video.querySelectorAll('source');
      for (let k = 0; k < sources.length; k += 1) {
        const src = sources[k].getAttribute('src');
        if (src) push(src, 'video', 'video', box);
      }
    }
  } catch (err) {
    /* 同上 */
  }

  let pageUrl = '';
  let pageTitle = '';
  let scanned = 0;
  try {
    pageUrl = location.href;
    pageTitle = document.title || '';
    scanned = document.querySelectorAll('*').length;
  } catch (err) {
    /* 扩展页面/特权页面可能读不到 */
  }

  return { ok: true, items: items, page: { url: pageUrl, title: pageTitle, elements: scanned } };
}

/** 把采集函数变成一段可 executeJavaScript 的表达式字符串 */
function buildCollectorScript() {
  return '(' + collectInPage.toString() + ')();';
}

/* ------------------------------ 纯逻辑部分 ------------------------------ */

/** 按 URL 猜种类（采集脚本没给出来时的兜底） */
function guessKind(url) {
  const text = String(url || '').toLowerCase();
  if (/^data:image\/svg\+xml/.test(text)) return 'svg';
  if (/\.(ico)(\?|#|$)/.test(text)) return 'icon';
  if (/\.svg(\?|#|$)/.test(text)) return 'svg';
  if (/\.(mp4|m4v|mov|mkv|webm|flv|ts|m3u8)(\?|#|$)/.test(text)) return 'video';
  return 'image';
}

/** 绝对化；拿不到就返回空串（宁可不列，也不要列出点不开的地址） */
function resolveUrl(raw, base) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^data:/i.test(text)) return /^data:image\/svg\+xml/i.test(text) ? text : '';
  if (/^blob:/i.test(text)) return text;
  // 只认这几类协议：`javascript:` / `mailto:` / `file:` 之类的 new URL 也能解析成功，
  // 但下载器一条都处理不了，列出来就是骗用户点
  let parsed = null;
  try {
    parsed = base ? new URL(text, base) : new URL(text);
  } catch (err) {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const href = parsed.href;
  return /^https?:\/\//i.test(href) ? href : '';
}

/** 文件名主干：去掉路径分隔符与 Windows 保留字符，压空格，截断 */
function sanitizeFileStem(raw) {
  let text = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, MAX_STEM);
  if (!text) text = 'nyx-media';
  // Windows 保留名（CON/PRN/... 加扩展名也打不开）
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = 'nyx-' + text;
  return text;
}

/** 从 URL 里取文件名主干；取不到就用种类兜底 */
function stemFromUrl(url) {
  // data:/blob: 的 pathname 是乱码（base64 片段、uuid），当文件名会得到一串垃圾
  if (/^(data|blob):/i.test(String(url || ''))) return '';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const decoded = decodeURIComponent(last);
    const dot = decoded.lastIndexOf('.');
    return dot > 0 ? decoded.slice(0, dot) : decoded;
  } catch (err) {
    return '';
  }
}

/** 扩展名：URL 里能认出就用真的，认不出按种类兜底 */
function extFromUrl(url, kind) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot > 0) {
      const ext = last.slice(dot).toLowerCase();
      if (SAFE_EXT.test(ext)) return ext;
    }
  } catch (err) {
    /* 解析失败走兜底 */
  }
  return EXT_BY_KIND[kind] || '.jpg';
}

function fileNameFor(item, index) {
  const kind = KIND_LABELS[item.kind] ? item.kind : 'image';
  const stem = sanitizeFileStem(item.alt || stemFromUrl(item.url) || KIND_LABELS[kind]);
  const ext = extFromUrl(item.url, kind);
  const suffix = String(index + 1).padStart(2, '0');
  return stem + '-' + suffix + ext;
}

/**
 * 把采集结果整理成界面用的清单。
 * 返回 { ok, items, dropped:{ count, reasons }, page } —— 丢弃的必须能说清为什么，
 * 不许静默少几条（红线 2）。
 */
function normalizeCandidates(raw, baseUrl) {
  const payload = raw && typeof raw === 'object' ? raw : {};
  const source = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
  const page = (!Array.isArray(payload) && payload.page) || {};
  const base = String(baseUrl || page.url || '');

  const reasons = {};
  let dropped = 0;
  const drop = (why) => {
    dropped += 1;
    reasons[why] = (reasons[why] || 0) + 1;
  };

  const byUrl = new Map();
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') {
      drop('条目格式不对');
      continue;
    }
    const url = resolveUrl(entry.url, base);
    if (!url) {
      drop(/^data:/i.test(String(entry.url || '')) ? '内联数据不是矢量图' : '地址补不全');
      continue;
    }
    const kind = KIND_LABELS[entry.kind] ? entry.kind : guessKind(url);
    const width = Number(entry.width) || 0;
    const height = Number(entry.height) || 0;
    const area = width * height;
    const row = {
      url,
      kind,
      origin: String(entry.origin || ''),
      width,
      height,
      alt: String(entry.alt || ''),
      note: String(entry.note || ''),
      ephemeral: /^blob:/i.test(url),
    };
    const seen = byUrl.get(url);
    if (seen) {
      // 同一地址重复出现：保留面积更大的那份，其余丢弃并计数
      if (area > seen.width * seen.height) byUrl.set(url, row);
      drop('同一地址重复');
      continue;
    }
    byUrl.set(url, row);
  }

  const items = Array.from(byUrl.values()).slice(0, MAX_CANDIDATES).map((row, index) => {
    const name = fileNameFor(row, index);
    return Object.assign({}, row, { name, area: row.width * row.height });
  });
  items.sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return b.area - a.area;
  });
  // 排序后名字里的序号要跟着重排，否则列表里会出现 03、01、02 这种乱序
  items.forEach((row, index) => {
    row.name = fileNameFor(row, index);
  });

  const truncated = byUrl.size > MAX_CANDIDATES ? byUrl.size - MAX_CANDIDATES : 0;

  return {
    ok: true,
    items,
    page: { url: base, title: String(page.title || ''), elements: Number(page.elements) || 0 },
    dropped: { count: dropped, reasons },
    truncated,
    total: byUrl.size,
  };
}

/** 界面筛选：按种类（空数组=全部）+ 关键字（文件名/地址/替代文字） */
function filterCandidates(items, options) {
  const list = Array.isArray(items) ? items : [];
  const kinds = options && Array.isArray(options.kinds) && options.kinds.length ? options.kinds : null;
  const keyword = String((options && options.keyword) || '').trim().toLowerCase();
  return list.filter((item) => {
    if (kinds && kinds.indexOf(item.kind) < 0) return false;
    if (!keyword) return true;
    const hay = (item.name + ' ' + item.url + ' ' + (item.alt || '')).toLowerCase();
    return hay.indexOf(keyword) >= 0;
  });
}

/** 一行中文汇总：「共 12 个：图片 8 / 站点图标 2 / 矢量图 2」 */
function describeCandidates(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '没有找到可保存的图片或图标';
  const counts = new Map();
  for (const item of list) counts.set(item.kind, (counts.get(item.kind) || 0) + 1);
  const parts = [];
  for (const kind of KIND_ORDER) {
    const n = counts.get(kind);
    if (n) parts.push(KIND_LABELS[kind] + ' ' + n);
  }
  return '共 ' + list.length + ' 个：' + parts.join(' / ');
}

/** 逐条结果的汇总：「已保存 9 个，失败 2 个」 */
function summarizeDownload(result) {
  const saved = Number(result && result.saved) || 0;
  const failed = Array.isArray(result && result.failed) ? result.failed : [];
  if (!saved && !failed.length) return '没有选中任何内容';
  if (!failed.length) return '已保存 ' + saved + ' 个';
  return '已保存 ' + saved + ' 个，失败 ' + failed.length + ' 个：' + failed.map((f) => f.reason).slice(0, 3).join('；');
}

module.exports = {
  EXT_BY_KIND,
  KIND_LABELS,
  KIND_ORDER,
  MAX_CANDIDATES,
  MAX_SCAN_ELEMENTS,
  MAX_STEM,
  buildCollectorScript,
  describeCandidates,
  extFromUrl,
  filterCandidates,
  guessKind,
  normalizeCandidates,
  resolveUrl,
  sanitizeFileStem,
  stemFromUrl,
  summarizeDownload,
};
