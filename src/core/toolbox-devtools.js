'use strict';

/**
 * Nyx 工具箱 · 页面环境能力层。
 *
 * 覆盖四类"改页面"的操作：
 *   1. 开发者模式：原生 DevTools（检查元素 / 控制台 / Sources）——直接调 Electron 原生接口，
 *      这是唯一完整的开发者工具，自造替代品只会更差；
 *   2. 元素拾取：向页面注入拾取器，点哪抓哪，回传选择器 / XPath / 盒子 / 文本；
 *   3. 环境伪装：UA 与视口（桌面网页 ⇄ 手机版网页）、网络限速；
 *   4. 清理与取证：清站点痕迹、整页截图。
 *
 * 依赖 Toolbox 实例提供 CDP 通道（sendCommand）；UA 与截图走 Electron 原生能力，
 * 不需要通道，因此 DevTools 抢占通道时这些能力依然可用。
 */

/** 桌面 UA 与 Nyx 内核（Electron 31 / Chromium 126）保持一致，改版本号只会让站点误判 */
const CHROME_VER = '126.0.0.0';
const DESKTOP_TAIL = 'Safari/537.36';

/**
 * 内置 UA 预设。key 即界面选项值，group 用于界面分组。
 * 「移动版」不等于「伪装成手机」——给的是在线课堂、阅读、短视频这类站点最常见的几个真身。
 */
const UA_PRESETS = [
  {
    key: 'default',
    group: '默认',
    label: '内核默认',
    desc: '不覆盖，使用 Nyx 当前内核 UA',
    ua: '',
  },
  {
    key: 'chrome-win',
    group: '桌面',
    label: 'Chrome · Windows',
    desc: '标准桌面 Chrome',
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} ${DESKTOP_TAIL}`,
  },
  {
    key: 'edge-win',
    group: '桌面',
    label: 'Edge · Windows',
    desc: '带 Edg 标识，兼容只认 Edge 的站点',
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} ${DESKTOP_TAIL} Edg/${CHROME_VER}`,
  },
  {
    key: 'mac-safari',
    group: '桌面',
    label: 'Safari · macOS',
    desc: '部分站点对 Safari 有独立渲染分支',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  },
  {
    key: 'iphone',
    group: '移动',
    label: 'iPhone · Safari',
    desc: '请求移动版站点的通用选择',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  },
  {
    key: 'android',
    group: '移动',
    label: 'Android · Chrome',
    desc: '安卓 Chrome，移动版页面命中率最高',
    ua: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Mobile ${DESKTOP_TAIL}`,
  },
  {
    key: 'ipad',
    group: '移动',
    label: 'iPad · Safari',
    desc: '平板版布局，介于桌面与手机之间',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  },
  {
    key: 'wechat',
    group: '移动',
    label: '微信内置浏览器',
    desc: '带 MicroMessenger 标识，用于微信里打开的页面',
    ua: `Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240105.004) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${CHROME_VER} Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x2800313D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64`,
  },
  {
    key: 'weibo',
    group: '移动',
    label: '微博客户端',
    desc: '移动端微博内置 WebView',
    ua: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${CHROME_VER} Mobile Safari/537.36 Weibo (Pixel 8__weibo__14.3.0__android__android14)`,
  },
  {
    key: 'custom',
    group: '自定义',
    label: '自定义 UA',
    desc: '手填任意 UA 字符串',
    ua: '',
  },
];

/**
 * 视口预设：只改渲染尺寸与触摸能力，不改 UA（与 UA 可自由组合）。
 * scale 是设备像素比，移动端页面靠它决定加载 @2x/@3x 图。
 */
const DEVICE_PRESETS = [
  { key: 'off', label: '关闭（跟随窗口）', width: 0, height: 0, dpr: 1, mobile: false },
  { key: 'iphone-se', label: 'iPhone SE 375×667', width: 375, height: 667, dpr: 2, mobile: true },
  { key: 'iphone-14', label: 'iPhone 14 390×844', width: 390, height: 844, dpr: 3, mobile: true },
  { key: 'pixel-8', label: 'Pixel 8 412×915', width: 412, height: 915, dpr: 2.6, mobile: true },
  { key: 'ipad-air', label: 'iPad Air 820×1180', width: 820, height: 1180, dpr: 2, mobile: true },
  { key: 'laptop', label: '笔记本 1366×768', width: 1366, height: 768, dpr: 1, mobile: false },
  { key: 'desktop', label: '桌面 1920×1080', width: 1920, height: 1080, dpr: 1, mobile: false },
];

/**
 * 网络限速预设。throughput 单位为字节/秒（-1 表示不限）。
 * 用来验证在线课堂、播放器在弱网下的降级行为。
 */
const THROTTLE_PRESETS = [
  { key: 'off', label: '不限速', latency: 0, down: -1, up: -1, type: 'none' },
  { key: 'slow3g', label: '慢速 3G (400kbps)', latency: 400, down: 50000, up: 25000, type: 'cellular3g' },
  { key: 'fast3g', label: '快速 3G (1.6Mbps)', latency: 150, down: 200000, up: 100000, type: 'cellular3g' },
  { key: '4g', label: '4G (4Mbps)', latency: 60, down: 500000, up: 250000, type: 'cellular4g' },
  { key: 'offline', label: '离线（断网）', latency: 0, down: 0, up: 0, type: 'none' },
];

/** 元素拾取器注入脚本：自绘高亮 + 选择器生成，点选后 resolve 回主进程 */
const PICKER_SCRIPT = `
new Promise((resolve) => {
  const prev = window.__nyxPicker;
  if (prev && typeof prev.stop === 'function') prev.stop();

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #8b5cf6;' +
    'background:rgba(139,92,246,.14);border-radius:2px;transition:all .04s linear;display:none';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:11px/1.6 Consolas,monospace;' +
    'background:#111827;color:#e6e8ee;padding:2px 6px;border-radius:3px;max-width:70vw;overflow:hidden;' +
    'white-space:nowrap;text-overflow:ellipsis;display:none';
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tip);

  function esc(v) {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }

  function selectorOf(el) {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift('#' + esc(node.id)); break; }
      let seg = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        seg += '.' + Array.prototype.slice.call(node.classList, 0, 2).map(esc).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = node.parentElement;
      if (node === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  }

  function xpathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let i = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) i += 1; sib = sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + '[' + i + ']');
      node = node.parentElement;
    }
    return '/html/' + parts.slice(1).join('/');
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of Array.prototype.slice.call(el.attributes || [], 0, 12)) {
      if (a.name === 'style' || a.name === 'class') continue;
      attrs[a.name] = String(a.value).slice(0, 200);
    }
    return {
      selector: selectorOf(el),
      xpath: xpathOf(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: el.classList ? Array.prototype.slice.call(el.classList, 0, 8) : [],
      text: (el.innerText || el.textContent || '').trim().slice(0, 400),
      html: (el.outerHTML || '').slice(0, 1200),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      attrs: attrs,
      href: el.href ? String(el.href).slice(0, 600) : '',
      src: el.src ? String(el.src).slice(0, 600) : '',
    };
  }

  function onMove(event) {
    const el = event.target;
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    tip.style.display = 'block';
    tip.textContent = selectorOf(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    tip.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 320)) + 'px';
    tip.style.top = (r.top > 26 ? r.top - 22 : r.bottom + 4) + 'px';
  }

  let done = false;
  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    try { box.remove(); tip.remove(); } catch (e) {}
    try { delete window.__nyxPicker; } catch (e) { window.__nyxPicker = null; }
  }

  function onClick(event) {
    if (done) return;
    done = true;
    event.preventDefault();
    event.stopPropagation();
    const el = event.target;
    const info = describe(el);
    cleanup();
    resolve(JSON.stringify({ ok: true, data: info }));
  }

  function onKey(event) {
    if (event.key !== 'Escape' || done) return;
    done = true;
    cleanup();
    resolve(JSON.stringify({ ok: false, error: '用户取消拾取' }));
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__nyxPicker = { stop: function () { if (done) return; done = true; cleanup(); resolve(JSON.stringify({ ok: false, error: '用户取消拾取' })); } };
});
`;

/**
 * 视频增强：鼠标保活的节奏档位。
 * 间隔是"两次动作之间"的随机区间，取随机值而不是定值，是为了让节奏不像机器。
 */
const MOUSE_GAP_PRESETS = [
  { key: 'calm', label: '悠闲 · 20~40 秒', min: 20000, max: 40000 },
  { key: 'normal', label: '常规 · 10~20 秒', min: 10000, max: 20000 },
  { key: 'busy', label: '频繁 · 4~9 秒', min: 4000, max: 9000 },
];

/** 倍速快捷档位；Chromium 自身允许 0.0625 ~ 16，超出会被内核拒绝 */
const RATE_PRESETS = [1.25, 1.5, 2, 2.5, 3, 4, 6, 8, 16];

/** 内核允许的倍速区间，两端都留给内核，不做超范围尝试（会被直接抛错） */
const RATE_MIN = 0.0625;
const RATE_MAX = 16;

/**
 * 视频增强注入脚本（页面主世界执行）。
 *
 * 三件事：倍速解锁、进度解锁、鼠标保活（脚本兜底通道）。
 *
 * 为什么要注入主世界并改写原型访问器：
 *   视频站的"倍速上限 2x""不能拖进度"多数只是它们自己播放器 UI 的软限制，
 *   但其中一部分平台会在 ratechange / seeking 事件里把值改回去——只写一次是没用的，
 *   要拦在属性写入那一层，让站点的赋值本身就落在我们设定的目标值上。
 *   patch 装在 HTMLMediaElement.prototype 上，页面里所有 video/audio 一并覆盖；
 *   站点若在实例上重新定义同名属性，原型上的原生 setter 依然可用（守卫定时器走原生
 *   setter 直接改内部状态，不受实例属性遮蔽影响）。
 *
 * 边界：只在主页面与同源 iframe 内生效；跨域 iframe 里的播放器碰不到（内核限制，非疏漏）。
 */
const VIDEO_KIT = `(() => {
  const KEY = '__nyxVideo';
  if (window[KEY] && window[KEY].version === 2) return JSON.stringify({ ok: true, reused: true });

  const state = {
    version: 2,
    rate: 0,          // >0 表示已接管倍速；0 表示未接管
    lockRate: false,  // 站点改回倍速时自动拽回
    lockSeek: false,  // 站点把进度拽回时自动纠正
    seekTarget: null, // 当前锁定的时间点（秒）
    moves: 0,         // 脚本通道执行的鼠标抖动次数
  };

  const proto = window.HTMLMediaElement ? window.HTMLMediaElement.prototype : null;
  const desc = {
    rate: proto ? Object.getOwnPropertyDescriptor(proto, 'playbackRate') : null,
    dflt: proto ? Object.getOwnPropertyDescriptor(proto, 'defaultPlaybackRate') : null,
    time: proto ? Object.getOwnPropertyDescriptor(proto, 'currentTime') : null,
  };

  let rateSetter = null;
  let timeSetter = null;
  let timer = null;

  function clampRate(v) {
    const n = Number(v);
    if (!isFinite(n)) return 1;
    if (n < 0.0625) return 0.0625;
    if (n > 16) return 16;
    return n;
  }

  function clampTime(el, v) {
    let n = Number(v);
    if (!isFinite(n) || n < 0) n = 0;
    const d = el && isFinite(el.duration) ? el.duration : null;
    if (d != null && n > d - 0.05) n = Math.max(0, d - 0.05);
    return n;
  }

  /* 内部写入一律走原生访问器，绕开自己装的 patch，避免自我递归 */
  function rawRate(el, v) { try { if (desc.rate) desc.rate.set.call(el, clampRate(v)); } catch (e) {} }
  function rawDefaultRate(el, v) { try { if (desc.dflt) desc.dflt.set.call(el, clampRate(v)); } catch (e) {} }
  function rawTime(el, v) { try { if (desc.time) desc.time.set.call(el, clampTime(el, v)); } catch (e) {} }

  /**
   * 站点改回倍速的两条常见路径：
   *   1. 直接给 playbackRate 赋值（含播放器重建 <video> 后再赋值）——拦 setter；
   *   2. 改写 defaultPlaybackRate 让内核在 load 后自己回到该倍速——拦 setter。
   */
  function patch() {
    if (!proto || !desc.rate || !desc.time) return false;
    rateSetter = function (value) {
      const target = state.lockRate && state.rate > 0 ? state.rate : value;
      try { desc.rate.set.call(this, clampRate(target)); } catch (e) {}
    };
    timeSetter = function (value) {
      const target = state.lockSeek && state.seekTarget != null ? state.seekTarget : value;
      try { desc.time.set.call(this, clampTime(this, target)); } catch (e) {}
    };
    try {
      Object.defineProperty(proto, 'playbackRate', { configurable: true, enumerable: desc.rate.enumerable, get: desc.rate.get, set: rateSetter });
      Object.defineProperty(proto, 'currentTime', { configurable: true, enumerable: desc.time.enumerable, get: desc.time.get, set: timeSetter });
      return true;
    } catch (e) { return false; }
  }

  /** 页面里所有 video/audio（含同源 iframe），带上 iframe 偏移便于算屏幕坐标 */
  function collect() {
    const out = [];
    const walk = (doc, ox, oy) => {
      let list = [];
      try { list = doc.querySelectorAll('video'); } catch (e) { list = []; }
      for (let i = 0; i < list.length; i += 1) out.push({ el: list[i], ox: ox, oy: oy });
      let frames = [];
      try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { frames = []; }
      for (let i = 0; i < frames.length; i += 1) {
        let inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; }
        if (!inner) continue;
        let r;
        try { r = frames[i].getBoundingClientRect(); } catch (e) { continue; }
        walk(inner, ox + r.left, oy + r.top);
      }
    };
    walk(document, 0, 0);
    return out;
  }

  function boxOf(entry) {
    let r;
    try { r = entry.el.getBoundingClientRect(); } catch (e) { return null; }
    return { x: r.left + entry.ox, y: r.top + entry.oy, w: r.width, h: r.height };
  }

  function shown(entry) {
    const b = boxOf(entry);
    if (!b || b.w < 20 || b.h < 20) return false;
    try {
      const cs = getComputedStyle(entry.el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    } catch (e) {}
    return true;
  }

  function viewport() {
    return {
      width: Math.max(document.documentElement ? document.documentElement.clientWidth : 0, window.innerWidth || 0) || 800,
      height: Math.max(document.documentElement ? document.documentElement.clientHeight : 0, window.innerHeight || 0) || 600,
    };
  }

  function screenBox() {
    const vp = viewport();
    const list = collect().filter(shown);
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < list.length; i += 1) {
      const b = boxOf(list[i]);
      if (!b) continue;
      const area = b.w * b.h;
      if (area > bestArea) { bestArea = area; best = b; }
    }
    if (!best) return null;
    const x = Math.min(Math.max(best.x, 0), Math.max(0, vp.width - 2));
    const y = Math.min(Math.max(best.y, 0), Math.max(0, vp.height - 2));
    const w = Math.max(2, Math.min(best.w, vp.width - x));
    const h = Math.max(2, Math.min(best.h, vp.height - y));
    return { x: x, y: y, w: w, h: h, vw: vp.width, vh: vp.height };
  }

  function shortUrl(url) {
    const s = String(url || '');
    if (!s) return '';
    const cut = s.split('?')[0].split('#')[0];
    return cut.length > 96 ? '…' + cut.slice(-96) : cut;
  }

  function scan() {
    const all = collect();
    const vp = viewport();
    let mainIdx = -1;
    let mainArea = 0;
    const videos = [];
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i].el;
      const b = boxOf(all[i]) || { x: 0, y: 0, w: 0, h: 0 };
      const onScreen = shown(all[i]);
      if (onScreen && b.w * b.h > mainArea) { mainArea = b.w * b.h; mainIdx = i; }
      let cur = '';
      try { cur = el.currentSrc || el.src || ''; } catch (e) {}
      videos.push({
        index: i,
        width: Math.round(b.w),
        height: Math.round(b.h),
        duration: isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : null,
        currentTime: isFinite(el.currentTime) ? Math.round(el.currentTime * 100) / 100 : null,
        rate: Math.round((el.playbackRate || 1) * 100) / 100,
        paused: !!el.paused,
        readyState: el.readyState,
        onScreen: onScreen,
        main: false,
        src: shortUrl(cur),
      });
    }
    if (mainIdx >= 0) videos[mainIdx].main = true;
    return {
      ok: true,
      count: videos.length,
      videos: videos,
      main: mainIdx,
      rate: state.rate,
      lockRate: state.lockRate,
      lockSeek: state.lockSeek,
      seekTarget: state.seekTarget,
      moves: state.moves,
      patched: !!rateSetter && !!timeSetter,
      viewport: vp,
    };
  }

  function applyRate(rate) {
    const next = clampRate(rate);
    state.rate = next;
    patch();
    const list = collect();
    for (let i = 0; i < list.length; i += 1) {
      rawRate(list[i].el, next);
      rawDefaultRate(list[i].el, next);
    }
    return { ok: true, rate: next, touched: list.length, patched: !!rateSetter };
  }

  function releaseRate() {
    state.rate = 0;
    state.lockRate = false;
    const list = collect();
    for (let i = 0; i < list.length; i += 1) {
      rawRate(list[i].el, 1);
      rawDefaultRate(list[i].el, 1);
    }
    return { ok: true, rate: 1, touched: list.length };
  }

  function setLock(opts) {
    if (opts && opts.lockRate != null) state.lockRate = !!opts.lockRate;
    if (opts && opts.lockSeek != null) state.lockSeek = !!opts.lockSeek;
    if (state.lockRate || state.lockSeek) patch();
    if (state.lockRate && state.rate > 0) applyRate(state.rate);
    return { ok: true, lockRate: state.lockRate, lockSeek: state.lockSeek, patched: !!rateSetter };
  }

  function seek(opts) {
    const cfg = opts || {};
    const list = collect().filter(shown);
    const targets = [];
    if (cfg.all) {
      for (let i = 0; i < list.length; i += 1) targets.push(list[i]);
    } else if (cfg.index != null && list[cfg.index]) {
      targets.push(list[cfg.index]);
    } else if (list.length) {
      let pick = 0;
      let area = 0;
      for (let i = 0; i < list.length; i += 1) {
        const b = boxOf(list[i]);
        if (b && b.w * b.h > area) { area = b.w * b.h; pick = i; }
      }
      targets.push(list[pick]);
    }
    if (!targets.length) return { ok: false, error: '页面上没有找到可操作的视频' };

    patch();
    const applied = [];
    for (let i = 0; i < targets.length; i += 1) {
      const el = targets[i].el;
      let t = null;
      if (cfg.toEnd) t = (isFinite(el.duration) ? el.duration : 0) - 0.4;
      else if (cfg.percent != null) t = (isFinite(el.duration) ? el.duration : 0) * (Number(cfg.percent) / 100);
      else if (cfg.seconds != null) t = Number(cfg.seconds);
      else if (cfg.delta != null) t = el.currentTime + Number(cfg.delta);
      if (t == null || !isFinite(t)) continue;
      const finalT = clampTime(el, t);
      if (state.lockSeek) state.seekTarget = finalT;
      rawTime(el, finalT);
      applied.push({ index: i, time: Math.round(finalT * 100) / 100, duration: isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : null });
    }
    if (!applied.length) return { ok: false, error: '当前视频还没有可用时长（可能尚未加载出元数据）' };
    return { ok: true, applied: applied, lockSeek: state.lockSeek, seekTarget: state.seekTarget };
  }

  function unlockSeek() {
    state.lockSeek = false;
    state.seekTarget = null;
    return { ok: true, lockSeek: false };
  }

  /** 合成鼠标移动（脚本兜底通道：CDP 通道被开发者工具占着时用） */
  function jiggle() {
    const box = screenBox() || { x: 0, y: 0, w: viewport().width, h: viewport().height };
    const x = Math.min(box.x + Math.random() * Math.max(1, box.w), viewport().width - 1);
    const y = Math.min(box.y + Math.random() * Math.max(1, box.h), viewport().height - 1);
    let target = null;
    try { target = document.elementFromPoint(x, y); } catch (e) { target = null; }
    if (!target) target = document.body || document.documentElement;
    const init = {
      bubbles: true, cancelable: true, view: window, detail: 0,
      clientX: x, clientY: y, screenX: x, screenY: y,
      movementX: Math.round((Math.random() - 0.5) * 7), movementY: Math.round((Math.random() - 0.5) * 7),
    };
    const types = ['mouseover', 'mouseenter', 'mousemove'];
    for (let i = 0; i < types.length; i += 1) {
      try { target.dispatchEvent(new MouseEvent(types[i], init)); } catch (e) {}
    }
    try {
      if (window.PointerEvent) {
        const p = new PointerEvent('pointermove', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0 }, init));
        target.dispatchEvent(p);
      }
    } catch (e) {}
    state.moves += 1;
    return { ok: true, x: Math.round(x), y: Math.round(y), moves: state.moves, synthetic: true };
  }

  /** 守卫：只接管到的东西，没接管时完全不碰页面 */
  function tick() {
    if (!state.lockRate && !state.lockSeek) return;
    if (rateSetter && proto && Object.getOwnPropertyDescriptor(proto, 'playbackRate').set !== rateSetter) patch();
    const list = collect();
    for (let i = 0; i < list.length; i += 1) {
      const el = list[i].el;
      if (state.lockRate && state.rate > 0) {
        if (Math.abs(el.playbackRate - state.rate) > 0.001) rawRate(el, state.rate);
        if (Math.abs((el.defaultPlaybackRate || 1) - state.rate) > 0.001) rawDefaultRate(el, state.rate);
      }
      if (state.lockSeek && state.seekTarget != null && !el.paused) {
        if (el.currentTime < state.seekTarget - 1.5) rawTime(el, state.seekTarget);
      }
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    try {
      if (proto && desc.rate) Object.defineProperty(proto, 'playbackRate', desc.rate);
      if (proto && desc.time) Object.defineProperty(proto, 'currentTime', desc.time);
    } catch (e) {}
    rateSetter = null;
    timeSetter = null;
    state.rate = 0;
    state.lockRate = false;
    state.lockSeek = false;
    state.seekTarget = null;
  }

  timer = setInterval(tick, 700);

  window[KEY] = {
    version: 2,
    scan: scan,
    applyRate: applyRate,
    releaseRate: releaseRate,
    setLock: setLock,
    seek: seek,
    unlockSeek: unlockSeek,
    jiggle: jiggle,
    box: screenBox,
    stop: stop,
    state: state,
  };
  return JSON.stringify({ ok: true, reused: false });
})()`;

/* ------------------------------ 能力实现 ------------------------------ */

class PageTools {
  /**
   * @param {object} options
   * @param {import('./toolbox').Toolbox} options.toolbox 提供 CDP 通道
   * @param {() => Electron.WebContents|null} options.getActiveWebContents 当前激活标签
   * @param {(channel: string, payload: object) => void} options.push 主进程 → UI 外壳推送
   */
  constructor(options) {
    this.toolbox = options.toolbox;
    this.getActiveWebContents = options.getActiveWebContents;
    this.push = options.push;

    /** 粘性设置：对之后新建的标签同样生效，避免每开一个标签都要重设一次 */
    this.sticky = {
      uaPreset: 'default',
      customUA: '',
      devicePreset: 'off',
      throttle: 'off',
      disabledJs: false,
    };

    /** 手动切换过 UA 的标签：标签刷新后 Chromium 会重置部分覆盖，需重放 */
    this.applied = new Map();

    /** 鼠标保活会话：每个标签最多一份，键为 wcId */
    this.mouseSessions = new Map();
  }

  /** 取目标 webContents（指定 id 或当前激活标签） */
  wc(wcId) {
    if (wcId == null) return this.getActiveWebContents();
    const all = this.toolbox.getAllWebContents ? this.toolbox.getAllWebContents() : [];
    for (const wc of all) {
      if (wc && !wc.isDestroyed() && wc.id === Number(wcId)) return wc;
    }
    return null;
  }

  /**
   * CDP 命令带重试：新标签的调试通道是异步挂上的，
   * 刚创建就下发 Emulation 命令会撞上"尚未挂载"，这里退避重试几次。
   */
  async cdp(wcId, method, params, retries = 6) {
    for (let i = 0; i < retries; i += 1) {
      try {
        return await this.toolbox.sendCommand(wcId, method, params);
      } catch (err) {
        const retriable = /尚未挂上调试通道/.test(String(err && err.message));
        if (!retriable || i === retries - 1) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return null;
  }

  /** 当前生效的 UA 字符串（空串表示不覆盖） */
  resolveUA() {
    const s = this.sticky;
    if (s.uaPreset === 'custom') return String(s.customUA || '').trim();
    const preset = UA_PRESETS.find((p) => p.key === s.uaPreset);
    return preset ? preset.ua : '';
  }

  /** 把粘性设置应用到某个标签（新建标签时也会调用） */
  async applySticky(wc) {
    if (!wc || wc.isDestroyed()) return { ok: true };
    const s = this.sticky;

    // UA：Electron 原生接口，不需要 CDP，DevTools 开着也能用
    // 空串 = 恢复默认 UA；绝不能传 null（Electron 参数校验会抛 conversion failure）
    const ua = this.resolveUA();
    try {
      wc.setUserAgent(ua || '');
    } catch (err) {
      console.warn('[Nyx] UA 应用失败：', err && err.message);
    }

    // 视口与触摸：走 CDP，失败不阻断（通道可能被 DevTools 占用）
    try {
      const device = DEVICE_PRESETS.find((d) => d.key === s.devicePreset);
      if (device && device.key !== 'off') {
        await this.cdp(wc.id, 'Emulation.setDeviceMetricsOverride', {
          width: device.width,
          height: device.height,
          deviceScaleFactor: device.dpr,
          mobile: device.mobile,
        });
        await this.cdp(wc.id, 'Emulation.setTouchEmulationEnabled', { enabled: device.mobile, maxTouchPoints: 5 });
      } else {
        await this.cdp(wc.id, 'Emulation.clearDeviceMetricsOverride');
        await this.cdp(wc.id, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      }
    } catch (err) {
      console.warn('[Nyx] 视口应用失败：', err && err.message);
    }

    // 限速
    try {
      await this.applyThrottle(wc.id, s.throttle, { silent: true });
    } catch (err) {
      console.warn('[Nyx] 限速应用失败：', err && err.message);
    }

    // 禁用 JS
    if (s.disabledJs) {
      try {
        await this.cdp(wc.id, 'Emulation.setScriptExecutionDisabled', { value: true });
      } catch {
        /* 忽略 */
      }
    }

    return { ok: true };
  }

  /* ---------------------------- 开发者模式 ---------------------------- */

  /**
   * 打开原生 DevTools。
   * @param {number} wcId
   * @param {'bottom'|'right'|'undocked'|'detach'} mode 停靠方式
   */
  openDevTools(wcId, mode) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const place = ['bottom', 'right', 'undocked', 'detach'].includes(mode) ? mode : 'bottom';
    try {
      wc.openDevTools({ mode: place, activate: true });
      return { ok: true, mode: place };
    } catch (err) {
      return { ok: false, error: `开发者工具打开失败：${err.message}` };
    }
  }

  closeDevTools(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    wc.closeDevTools();
    return { ok: true };
  }

  devToolsState(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: true, opened: false, available: false, attached: false };
    return {
      ok: true,
      available: true,
      opened: wc.isDevToolsOpened(),
      focused: wc.isDevToolsFocused(),
      attached: this.toolbox.status(wcId).attached,
    };
  }

  /* ---------------------------- 元素拾取 ---------------------------- */

  /**
   * 拾取页面元素：注入拾取器，等待用户点选（或 Esc 取消）。
   * 用户长时间不点会超时返回，避免界面一直挂着等待态。
   */
  async pickElement(wcId, timeoutMs = 60000) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    if (this.toolbox.status(wc.id).attached === false && wc.isDevToolsOpened()) {
      // 拾取器是纯页面脚本注入，不依赖 CDP，提示但不阻断
      console.warn('[Nyx] 开发者工具已打开，拾取器仍可用（走脚本注入）');
    }

    let timer = null;
    try {
      const raw = await Promise.race([
        wc.executeJavaScript(PICKER_SCRIPT, true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(JSON.stringify({ ok: false, error: '拾取超时（60 秒未选择）' })), timeoutMs);
        }),
      ]);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return parsed;
    } catch (err) {
      return { ok: false, error: `元素拾取失败：${err.message}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 取消进行中的拾取 */
  cancelPick(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false };
    wc.executeJavaScript('window.__nyxPicker && window.__nyxPicker.stop && window.__nyxPicker.stop(); true', true).catch(
      () => {}
    );
    return { ok: true };
  }

  /** 在页面上高亮某个选择器（拾取后回看用） */
  async highlight(wcId, selector) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const sel = JSON.stringify(String(selector || ''));
    const script = `(() => { const el = document.querySelector(${sel}); if (!el) return false;
      el.scrollIntoView({block:'center', behavior:'smooth'});
      const r = el.getBoundingClientRect();
      const mark = document.createElement('div');
      mark.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #22d3ee;background:rgba(34,211,238,.16);border-radius:2px;'+
        'left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px';
      document.documentElement.appendChild(mark);
      setTimeout(() => mark.remove(), 1600);
      return true; })()`;
    try {
      const found = await wc.executeJavaScript(script, true);
      return found ? { ok: true } : { ok: false, error: '选择器在当前页面没有匹配到元素' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 对选择器执行一段脚本（开发者工具的"快捷取数"）。
   * 单表达式，返回 JSON 可序列化的结果。
   */
  async evalSelector(wcId, selector, expression) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const sel = JSON.stringify(String(selector || ''));
    const expr = String(expression || 'el').slice(0, 2000);
    const script = `(() => { const el = document.querySelector(${sel}); if (!el) return null;
      try { return JSON.parse(JSON.stringify((${expr}))); } catch (e) { return String(e); } })()`;
    try {
      const value = await wc.executeJavaScript(script, true);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ---------------------------- 调试：修改 HTML / 控制台 ---------------------------- */

  /**
   * 控制台执行任意 JS（独立通道，不受 evalSelector 2000 字符限制）。
   *
   * 特性：
   *   - 表达式上限 64KB（超出截断），支持 async（返回 Promise 时会等待）；
   *   - 执行期间临时包装 console.log/error/warn/info 收集页面日志；
   *   - 返回值做安全归一化（BigInt / Symbol / Error / DOM 元素 / 循环引用），
   *     最终以 JSON 字符串回传，主进程解析后返回结构体。
   */
  async evalScript(wcId, expression) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const expr = String(expression || '').slice(0, 64 * 1024);
    if (!expr.trim()) return { ok: false, error: '表达式不能为空' };
    const script = `(() => {
      const __logs = [];
      const __orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
      const __fmt = (v) => {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
      };
      const __norm = (v) => {
        if (v === undefined) return { type: 'undefined' };
        if (typeof v === 'function') return { type: 'function' };
        if (typeof v === 'symbol') return { type: 'symbol', text: String(v) };
        if (typeof v === 'bigint') return { type: 'bigint', text: String(v) };
        if (v instanceof Error) return { type: 'error', message: v.message, stack: v.stack };
        if (v instanceof Element) return { type: 'element', tag: v.tagName, id: v.id, cls: String(v.className || '') };
        if (v && typeof v === 'object') {
          try { return JSON.parse(JSON.stringify(v)); } catch (e) { return { type: 'unserializable', text: String(v) }; }
        }
        return v;
      };
      return (async () => {
        console.log = (...a) => __logs.push({ level: 'log', text: a.map(__fmt).join(' ') });
        console.error = (...a) => __logs.push({ level: 'error', text: a.map(__fmt).join(' ') });
        console.warn = (...a) => __logs.push({ level: 'warn', text: a.map(__fmt).join(' ') });
        console.info = (...a) => __logs.push({ level: 'info', text: a.map(__fmt).join(' ') });
        let value, error = null;
        try {
          value = (() => { return (${expr}); })();
          if (value && typeof value.then === 'function') value = await value;
          value = __norm(value);
        } catch (e) {
          error = String((e && e.stack) || e);
        } finally {
          console.log = __orig.log;
          console.error = __orig.error;
          console.warn = __orig.warn;
          console.info = __orig.info;
        }
        return JSON.stringify({ logs: __logs, value, error });
      })();
    })()`;
    try {
      const raw = await wc.executeJavaScript(script, true);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = { logs: [], value: raw, error: null };
      }
      return { ok: true, logs: parsed.logs || [], value: parsed.value, error: parsed.error || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 读取当前标签页整棵 DOM 的 HTML（document.documentElement.outerHTML）。
   * 首次读取会保存快照，供「还原」恢复本次会话最初的页面状态。
   */
  async readHtml(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const script = `(() => document.documentElement.outerHTML)()`;
    try {
      const html = await wc.executeJavaScript(script, true);
      if (!this.htmlSnapshot) this.htmlSnapshot = new Map();
      if (!this.htmlSnapshot.has(wc.id)) this.htmlSnapshot.set(wc.id, html);
      return { ok: true, html, snapshot: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 把编辑框里的 HTML 整棵写回页面。
   * 用 document.open / write / close 完整替换文档（含 <html> 根元素），
   * 页面脚本会随之重新执行——这是唯一能替换根元素的方式。
   */
  async applyHtml(wcId, html) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const text = String(html || '');
    if (!text.trim()) return { ok: false, error: 'HTML 不能为空' };
    if (text.length > 5 * 1024 * 1024) return { ok: false, error: 'HTML 过大（超过 5MB），已拒绝写回' };
    const wrapped = JSON.stringify(text);
    const script = `(() => { document.open(); document.write(${wrapped}); document.close(); return 'applied'; })()`;
    try {
      const value = await wc.executeJavaScript(script, true);
      return { ok: true, applied: value === 'applied' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** 还原到本次会话首次 readHtml 保存的原始 HTML */
  async revertHtml(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    if (!this.htmlSnapshot || !this.htmlSnapshot.has(wc.id)) {
      return { ok: false, error: '还没有读取过快照，请先「读取页面 HTML」' };
    }
    return this.applyHtml(wc.id, this.htmlSnapshot.get(wc.id));
  }

  /* ---------------------------- UA / 视口 / 限速 ---------------------------- */

  /** 切换 UA；preserve 为 true 时不重载页面 */
  async setUserAgent(wcId, presetKey, customUA, keepPage) {
    const preset = UA_PRESETS.find((p) => p.key === presetKey) || UA_PRESETS[0];
    this.sticky.uaPreset = preset.key;
    if (preset.key === 'custom') {
      const value = String(customUA || '').trim();
      if (!value) return { ok: false, error: '自定义 UA 不能为空' };
      if (/[\r\n]/.test(value)) return { ok: false, error: '自定义 UA 不能包含换行' };
      this.sticky.customUA = value.slice(0, 512);
    }

    const wc = this.wc(wcId);
    if (!wc) return { ok: true, sticky: true, note: '已记录，新建标签时生效' };

    const ua = this.resolveUA();
    try {
      // 空串 = 恢复默认 UA；绝不能传 null（Electron 参数校验会抛 conversion failure）
      wc.setUserAgent(ua || '');
    } catch (err) {
      return { ok: false, error: `UA 应用失败：${err.message}` };
    }

    // 页面内 UA 同步：某些脚本读 navigator.userAgent，重载前先对齐
    try {
      await this.cdp(wc.id, 'Emulation.setUserAgentOverride', { userAgent: ua || wc.getUserAgent() });
    } catch {
      /* 通道被占用可忽略：setUserAgent 已覆盖网络层 UA */
    }

    if (!keepPage) {
      try {
        await wc.reload();
      } catch {
        /* 重载失败不影响 UA 已生效 */
      }
    }
    return { ok: true, ua, reloaded: !keepPage };
  }

  /** 设备视口切换 */
  async setDevice(wcId, presetKey, keepPage) {
    const preset = DEVICE_PRESETS.find((d) => d.key === presetKey) || DEVICE_PRESETS[0];
    this.sticky.devicePreset = preset.key;

    const wc = this.wc(wcId);
    if (!wc) return { ok: true, sticky: true, note: '已记录，新建标签时生效' };

    try {
      if (preset.key === 'off') {
        await this.cdp(wc.id, 'Emulation.clearDeviceMetricsOverride');
        await this.cdp(wc.id, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      } else {
        await this.cdp(wc.id, 'Emulation.setDeviceMetricsOverride', {
          width: preset.width,
          height: preset.height,
          deviceScaleFactor: preset.dpr,
          mobile: preset.mobile,
        });
        await this.cdp(wc.id, 'Emulation.setTouchEmulationEnabled', { enabled: preset.mobile, maxTouchPoints: 5 });
      }
    } catch (err) {
      return { ok: false, error: `视口切换失败：${err.message}` };
    }

    if (!keepPage) {
      try {
        await wc.reload();
      } catch {
        /* 忽略 */
      }
    }
    return { ok: true, preset: preset.key, reloaded: !keepPage };
  }

  /** 网络限速 / 断网 */
  async applyThrottle(wcId, presetKey, options = {}) {
    const preset = THROTTLE_PRESETS.find((t) => t.key === presetKey) || THROTTLE_PRESETS[0];
    if (!options.silent) this.sticky.throttle = preset.key;

    const wc = this.wc(wcId);
    if (!wc) return { ok: true, sticky: true, note: '已记录，新建标签时生效' };

    try {
      await this.cdp(wc.id, 'Network.emulateNetworkConditions', {
        offline: preset.key === 'offline',
        latency: preset.latency,
        downloadThroughput: preset.down,
        uploadThroughput: preset.up,
        connectionType: preset.type,
      });
    } catch (err) {
      return { ok: false, error: `限速设置失败：${err.message}` };
    }
    return { ok: true, preset: preset.key };
  }

  /** 禁用 / 恢复页面 JavaScript */
  async setJavaScriptEnabled(wcId, enabled) {
    this.sticky.disabledJs = !enabled;
    const wc = this.wc(wcId);
    if (!wc) return { ok: true, sticky: true };
    try {
      await this.cdp(wc.id, 'Emulation.setScriptExecutionDisabled', { value: !enabled });
    } catch (err) {
      return { ok: false, error: `JS 开关失败：${err.message}` };
    }
    return { ok: true, enabled };
  }

  /* ---------------------------- 清理与取证 ---------------------------- */

  /**
   * 清理当前站点的浏览数据。
   * @param {number} wcId
   * @param {string[]} kinds cookie|storage|cache|all
   */
  async clearSiteData(wcId, kinds) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };

    let origin = '';
    try {
      origin = new URL(wc.getURL()).origin;
    } catch {
      return { ok: false, error: '当前页面不是普通网页（无法确定站点）' };
    }
    if (!origin || origin === 'null') return { ok: false, error: '当前页面不是普通网页（无法确定站点）' };

    const list = Array.isArray(kinds) && kinds.length ? kinds : ['cookie', 'storage'];
    const ses = wc.session;
    const done = [];

    try {
      if (list.includes('cookie') || list.includes('all')) {
        await ses.cookies.get({ url: origin }).then((cookies) =>
          Promise.all(cookies.map((c) => ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`, c.name).catch(() => null)))
        );
        done.push('Cookie');
      }
      if (list.includes('storage') || list.includes('all')) {
        await ses.clearStorageData({
          origin,
          storages: ['localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'shadercache', 'filesystem'],
        });
        done.push('站点存储');
      }
      if (list.includes('cache') || list.includes('all')) {
        await ses.clearCache();
        done.push('磁盘缓存');
      }
    } catch (err) {
      return { ok: false, error: `清理失败：${err.message}` };
    }

    try {
      await wc.reload();
    } catch {
      /* 忽略 */
    }
    return { ok: true, origin, cleared: done };
  }

  /**
   * 截图。
   * @param {number} wcId
   * @param {boolean} fullPage 是否整页（超出视口部分一并截）
   */
  async capture(wcId, fullPage) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };

    if (fullPage) {
      try {
        const res = await this.cdp(wc.id, 'Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          fromSurface: true,
        });
        if (res && res.data) return { ok: true, base64: res.data, fullPage: true };
      } catch (err) {
        console.warn('[Nyx] 整页截图走 CDP 失败，回落可视区：', err && err.message);
      }
    }

    try {
      const image = await wc.capturePage();
      return { ok: true, base64: image.toPNG().toString('base64'), fullPage: false };
    } catch (err) {
      return { ok: false, error: `截图失败：${err.message}` };
    }
  }

  /* ---------------------------- 视频增强 ---------------------------- */

  /**
   * 调页面内视频工具箱的方法。
   * 首次调用时脚本尚未注入，检测到空结果就注入一次再调；之后都是复用同一个实例。
   * @param {number} wcId
   * @param {string} method window.__nyxVideo 上的方法名
   * @param {*} args 该方法唯一的入参（可省略）
   */
  async kitCall(wcId, method, args) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const payload = args === undefined ? 'undefined' : JSON.stringify(args);
    const call = `(() => {
      const kit = window.__nyxVideo;
      if (!kit) return '';
      try { return JSON.stringify(kit.${method}(${payload})); }
      catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
    })()`;
    try {
      let raw = await wc.executeJavaScript(call, true);
      if (!raw) {
        await wc.executeJavaScript(VIDEO_KIT, true);
        raw = await wc.executeJavaScript(call, true);
      }
      if (!raw) return { ok: false, error: '视频脚本注入失败（页面可能是内置页，或禁用了脚本执行）' };
      let res = null;
      try { res = JSON.parse(raw); } catch { res = null; }
      if (!res || typeof res !== 'object') return { ok: false, error: '视频脚本返回了无法解析的结果' };
      return res;
    } catch (err) {
      return { ok: false, error: `视频脚本执行失败：${err.message}` };
    }
  }

  /** 扫描页面视频：数量、主视频尺寸、播放进度、当前倍速与接管状态 */
  async scanVideos(wcId) {
    return this.kitCall(wcId, 'scan');
  }

  /**
   * 应用倍速。
   * @param {number|null} rate 0 或空 → 还原 1x
   * @param {boolean|null} lock 是否开启"站点改回就拽回"
   */
  async setVideoRate(wcId, rate, lock) {
    const value = Number(rate);
    if (rate == null || !isFinite(value) || value <= 0) {
      const off = await this.kitCall(wcId, 'releaseRate');
      if (off.ok === false) return off;
      await this.kitCall(wcId, 'setLock', { lockRate: false });
      return { ok: true, released: true, rate: 1, lockRate: false, touched: off.touched || 0 };
    }
    const target = Math.min(RATE_MAX, Math.max(RATE_MIN, value));
    const applied = await this.kitCall(wcId, 'applyRate', target);
    if (applied.ok === false) return applied;
    if (lock != null) await this.kitCall(wcId, 'setLock', { lockRate: !!lock });
    return {
      ok: true,
      rate: target,
      touched: applied.touched || 0,
      lockRate: lock == null ? undefined : !!lock,
      clamped: target !== value,
    };
  }

  /** 进度解锁：秒 / 百分比 / 相对偏移 / 跳末尾；lock 为 true 时站点拽回就纠正 */
  async seekVideo(wcId, options) {
    const cfg = Object.assign({}, options || {});
    if (cfg.lock != null) {
      const lockRes = await this.kitCall(wcId, 'setLock', { lockSeek: !!cfg.lock });
      if (lockRes.ok === false) return lockRes;
    }
    if (cfg.unlock) return this.kitCall(wcId, 'unlockSeek');

    const res = await this.kitCall(wcId, 'seek', {
      seconds: cfg.seconds,
      percent: cfg.percent,
      delta: cfg.delta,
      toEnd: cfg.toEnd,
      index: cfg.index,
      all: cfg.all,
    });
    if (res.ok === false) return res;
    if (cfg.lock === false) await this.kitCall(wcId, 'unlockSeek');
    return res;
  }

  /** 取"鼠标活动范围"：视频区域（默认）或整个可视区 */
  async mouseBox(wcId, mode) {
    const wc = this.wc(wcId);
    if (!wc) return null;
    const viewportExpr = `(() => { const w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 800; const h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 600; return JSON.stringify({ x: 0, y: 0, w: w, h: h, vw: w, vh: h }); })()`;
    if (mode !== 'viewport') {
      try {
        const raw = await wc.executeJavaScript(`(() => { const kit = window.__nyxVideo; if (!kit) return ''; try { return JSON.stringify(kit.box() || null); } catch (e) { return ''; } })()`, true);
        if (raw) {
          const box = JSON.parse(raw);
          if (box && box.w > 8 && box.h > 8) return box;
        }
      } catch {
        /* 取不到就退到整页范围 */
      }
    }
    try {
      const raw = await wc.executeJavaScript(viewportExpr, true);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * 鼠标保活：在视频窗口里按随机间隔做小幅鼠标移动。
   * 优先走 CDP Input（页面看到的是真事件）；通道被开发者工具占着时自动落到页面脚本通道。
   */
  async startMouseIdle(wcId, options) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const cfg = options || {};
    const preset = MOUSE_GAP_PRESETS.find((p) => p.key === cfg.gap) || MOUSE_GAP_PRESETS[1];
    this.stopMouseIdle(wc.id);
    const session = {
      wcId: wc.id,
      mode: cfg.mode === 'viewport' ? 'viewport' : 'video',
      gap: preset.key,
      min: preset.min,
      max: preset.max,
      moves: 0,
      fallback: false,
      cursor: null,
      lastAt: 0,
      running: true,
      misses: 0,
      retryDelay: 0,
      timer: null,
    };
    this.mouseSessions.set(wc.id, session);
    // 先来一次，用户点完就能看到动，不用干等一个周期
    this.scheduleMouse(session, 900);
    return { ok: true, mouse: this.mouseStatusOf(session) };
  }

  /** 停止保活；不传 wcId 表示全部停止 */
  stopMouseIdle(wcId) {
    const keys = wcId == null ? Array.from(this.mouseSessions.keys()) : [Number(wcId)];
    let stopped = 0;
    for (const key of keys) {
      const session = this.mouseSessions.get(key);
      if (!session) continue;
      session.running = false;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      this.mouseSessions.delete(key);
      stopped += 1;
    }
    return { ok: true, stopped };
  }

  /** 保活状态（界面轮询展示用） */
  mouseStatus(wcId) {
    const wc = this.wc(wcId);
    if (!wc) return { ok: true, running: false, moves: 0, lastAt: 0 };
    const session = this.mouseSessions.get(wc.id);
    if (!session) return { ok: true, running: false, moves: 0, lastAt: 0, wcId: wc.id };
    return this.mouseStatusOf(session);
  }

  mouseStatusOf(session) {
    return {
      ok: true,
      running: !!session.running,
      wcId: session.wcId,
      mode: session.mode,
      gap: session.gap,
      moves: session.moves,
      lastAt: session.lastAt,
      fallback: !!session.fallback,
    };
  }

  scheduleMouse(session, delay) {
    session.timer = setTimeout(() => {
      this.mouseBurst(session)
        .catch((err) => console.warn('[Nyx] 鼠标保活异常：', err && err.message))
        .then(() => {
          if (!session.running) return;
          // 首轮常常撞上"页面还在加载/视频还没排版"，此时不该干等一整个随机间隔
          const next = session.retryDelay || this.randomGap(session);
          session.retryDelay = 0;
          this.scheduleMouse(session, next);
        });
    }, delay);
  }

  randomGap(session) {
    return Math.round(session.min + Math.random() * Math.max(1, session.max - session.min));
  }

  /** 一次移动：从上次落点缓和滑到区域内随机点，中途带抖动，不落直线 */
  async mouseBurst(session) {
    const wc = this.wc(session.wcId);
    if (!wc || wc.isDestroyed()) {
      this.stopMouseIdle(session.wcId);
      return;
    }
    if (!session.running) return;
    if (session.fallback) return this.fallbackJiggle(session);

    const box = await this.mouseBox(session.wcId, session.mode);
    if (!session.running) return;
    if (!box) {
      // 取不到活动范围（页面还在加载、视频尚未排版）：短间隔补几次，别让用户干等一个随机周期
      session.misses = (session.misses || 0) + 1;
      if (session.misses <= 6) session.retryDelay = 2000;
      return;
    }
    session.misses = 0;

    const from = session.cursor || { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const to = {
      x: box.x + 4 + Math.random() * Math.max(1, box.w - 8),
      y: box.y + 4 + Math.random() * Math.max(1, box.h - 8),
    };
    const steps = 5 + Math.floor(Math.random() * 7);
    let last = from;

    for (let i = 1; i <= steps; i += 1) {
      if (!session.running) return;
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const x = Math.min(Math.max(box.x + 1, from.x + (to.x - from.x) * ease + (Math.random() - 0.5) * 2.4), box.x + box.w - 1);
      const y = Math.min(Math.max(box.y + 1, from.y + (to.y - from.y) * ease + (Math.random() - 0.5) * 2.4), box.y + box.h - 1);
      last = { x, y };
      try {
        await this.cdp(
          session.wcId,
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), buttons: 0, pointerType: 'mouse', modifiers: 0 },
          2,
        );
      } catch {
        // 通道不可用（多为开发者工具占用）：本轮改走页面脚本通道，之后都走它
        session.fallback = true;
        return this.fallbackJiggle(session);
      }
      await new Promise((r) => setTimeout(r, 24 + Math.random() * 26));
    }

    session.cursor = last;
    session.moves += 1;
    session.lastAt = Date.now();
  }

  /** 页面脚本通道：合成 mousemove（isTrusted=false，能过多数保活检测，但不是真事件） */
  async fallbackJiggle(session) {
    const wc = this.wc(session.wcId);
    if (!wc || wc.isDestroyed()) return;
    try {
      let raw = await wc.executeJavaScript(`(() => { const kit = window.__nyxVideo; if (!kit) return ''; try { return JSON.stringify(kit.jiggle()); } catch (e) { return ''; } })()`, true);
      if (!raw) {
        await wc.executeJavaScript(VIDEO_KIT, true);
        raw = await wc.executeJavaScript(`(() => { const kit = window.__nyxVideo; if (!kit) return ''; try { return JSON.stringify(kit.jiggle()); } catch (e) { return ''; } })()`, true);
      }
      if (!raw) return;
      const res = JSON.parse(raw);
      session.fallback = true;
      session.moves += 1;
      session.lastAt = Date.now();
      if (res && res.x != null) session.cursor = { x: res.x, y: res.y };
    } catch {
      /* 页面不可注入：本轮跳过，下一轮再试 */
    }
  }

  /**
   * 退出接管：停掉全部保活，并把页面上的改写还原（倍速回到 1x、原型访问器还原）。
   * 收起工具箱、切标签、关窗口时都会走这里——不在页面上留无界面可撤销的改动。
   */
  async releaseAllVideo() {
    this.stopMouseIdle(null);
    const all = this.toolbox.getAllWebContents ? this.toolbox.getAllWebContents() : [];
    let reverted = 0;
    for (const wc of all) {
      if (!wc || wc.isDestroyed()) continue;
      try {
        const done = await wc.executeJavaScript(`(() => { const kit = window.__nyxVideo; if (!kit) return false; try { kit.stop(); return true; } catch (e) { return false; } })()`, true);
        if (done) reverted += 1;
      } catch {
        /* 内置页 / 已崩溃页面跳过 */
      }
    }
    return { ok: true, reverted };
  }

  /* ---------------------------- 预设清单 ---------------------------- */

  /** 把可选清单交给界面，避免界面与内核两份常量各写一遍 */
  presets() {
    return {
      ua: UA_PRESETS,
      device: DEVICE_PRESETS,
      throttle: THROTTLE_PRESETS,
      mouseGaps: MOUSE_GAP_PRESETS,
      rates: RATE_PRESETS,
      rateRange: { min: RATE_MIN, max: RATE_MAX },
      sticky: Object.assign({}, this.sticky),
    };
  }
}

module.exports = { PageTools, UA_PRESETS, DEVICE_PRESETS, THROTTLE_PRESETS, MOUSE_GAP_PRESETS, RATE_PRESETS };
