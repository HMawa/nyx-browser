'use strict';

/**
 * 页面读取（清单 B「眼睛」）：给 agent 结构化的页面信息，而不是截图。
 *
 * 三条硬要求（清单原文）：
 *   1. 返回 url / title / 是否加载完成 / 视口尺寸 / 可读正文，而不是图像；
 *   2. 给出可交互元素清单：id / role / name / 当前值 / 是否禁用 / 是否在视口内；
 *   3. **稳定 id**：同一页面读两次，同一元素的 id 必须一样；元素消失时要给明确的
 *      「元素不存在」错误（ELEMENT_NOT_FOUND），不许让 agent 靠坐标去猜。
 *
 * 稳定 id 的做法：id = FNV-1a(结构路径 + role + 可读名字)，取 base36 七位。它只依赖
 * 元素在 DOM 里的位置与无障碍名字，跟读取顺序、时间、滚动位置都无关，所以两次读一致；
 * 一旦页面结构或文案变了，旧 id 自然查不到——这时报错比乱点安全。
 *
 * 本模块是纯逻辑（零 Electron 依赖）：页面内的采集脚本以字符串形式提供，主进程用
 * `webContents.executeJavaScript()` 注入；采集结果的整理、裁剪与错误文案都在这里，
 * 可以直接被 Node 单测覆盖。
 */

const READ_LIMITS = {
  maxText: 6000,
  maxElements: 300,
  maxNameLen: 80,
};

/** 会出现在「可交互元素清单」里的选择器（宁多勿少，逐条还会再判可见性） */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'label',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]',
].join(',');

/**
 * 页面内公共前奏（采集脚本与「按 id 操作」脚本共用同一套 id 算法，
 * 保证「读到的 id」和「点击时用的 id」是同一个函数算出来的）。
 *
 * 注意：这里用 String.raw，不能写成普通模板串——里面的 `\s` 必须原样进入页面脚本。
 */
const PAGE_PRELUDE = String.raw`
  const MAX_NAME = ${READ_LIMITS.maxNameLen};
  const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(36)).slice(-7);
  };
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'label') return 'label';
    if (tag === 'input') {
      const t = String(el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'generic';
  };
  const nameOf = (el) => {
    // 密码框的 name 绝不能回退到 el.value：类型遮住了、名字里又把明文带出去，
    // 等于没遮（对抗测试就是这么把密码读出来的）。
    if (String(el.type || '').toLowerCase() === 'password') {
      return norm((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'))) || '密码输入框');
    }
    return norm(
      (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder')))
      || (el.tagName === 'INPUT' ? '' : el.innerText)
      || el.value
      || ''
    );
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName).length;
      let index = 0;
      let sib = node;
      while ((sib = sib.previousElementSibling)) index++;
      const tag = node.tagName.toLowerCase();
      parts.unshift(sameTag > 1 ? tag + ':' + index : tag);
      node = parent;
      if (parts.length >= 8) break;
    }
    return parts.join('>');
  };
  const idOf = (el) => 'e' + hash(pathOf(el) + '|' + roleOf(el) + '|' + nameOf(el));
  const visibleOf = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
`;

/** FNV-1a（与页面内实现一致，供单测与静态核对使用） */
function hashId(value) {
  let h = 0x811c9dc5;
  const text = String(value == null ? '' : value);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(36)).slice(-7);
}

/** 与页面内 nameOf 一致：压空白 + 截断 */
function normalizeName(raw, maxLen) {
  const limit = Number(maxLen) > 0 ? Number(maxLen) : READ_LIMITS.maxNameLen;
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** 结构化读取脚本 */
function buildReadPageScript(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxText = Math.max(300, Math.min(Number(opts.maxText) || READ_LIMITS.maxText, 20000));
  const maxElements = Math.max(10, Math.min(Number(opts.maxElements) || READ_LIMITS.maxElements, 800));
  // 这里必须用 String.raw：脚本里的正则 `/\s+/`、`/\n+/` 一旦被普通模板串转义，
  // `\n` 会变成真正的换行，整段脚本就语法错误、executeJavaScript 直接抛异常。
  return String.raw`(() => {
    ${PAGE_PRELUDE}
    const MAX_TEXT = ${maxText};
    const MAX_ELEMENTS = ${maxElements};
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const all = document.querySelectorAll(SEL);
    const elements = [];
    let visibleCount = 0;
    for (let i = 0; i < all.length; i += 1) {
      const el = all[i];
      if (!visibleOf(el)) continue;
      visibleCount += 1;
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const isFormField = tag === 'input' || tag === 'textarea' || tag === 'select';
      const inputType = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
      // 安全审计 P1-1：密码框的**值一律不回显**。
      // 以前 readPage 把 input[type=password] 的当前内容原样写进结果里，
      // 等于 agent 读一次页面就把用户输过的密码抄进了上下文与审计日志。
      // 现在只给"有没有填"这个事实（hasValue），值永远为空串。
      const isSecret = inputType === 'password';
      const rawValue = isFormField ? String(el.value == null ? '' : el.value) : '';
      elements.push({
        id: idOf(el),
        role: roleOf(el),
        name: nameOf(el),
        tag,
        inputType,
        value: isSecret ? '' : rawValue.slice(0, 60),
        hasValue: isFormField ? rawValue.length > 0 : false,
        masked: isSecret,
        disabled: Boolean(el.disabled) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'),
        inViewport: rect.bottom > 0 && rect.top < viewport.height,
      });
      if (elements.length >= MAX_ELEMENTS) break;
    }

    const root = document.querySelector('article') || document.querySelector('main') || document.body;
    const rawText = (root && (root.innerText || root.textContent)) || '';
    const seen = Object.create(null);
    const lines = [];
    let used = 0;
    const rawLines = rawText.split(/\n+/);
    for (let i = 0; i < rawLines.length; i += 1) {
      const line = rawLines[i].replace(/\s+/g, ' ').trim();
      if (line.length < 2) continue;
      const key = line.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      // 导航/页脚样板：只在正文已经够长时才跳过，避免把整页都当样板
      if (lines.length > 5 && /^(首页|上一页|下一页|导航|登录|注册|关于我们|联系我们|版权|copyright|all rights reserved)/i.test(line)) continue;
      lines.push(line);
      used += line.length + 1;
      if (used >= MAX_TEXT) break;
    }
    const text = lines.join('\n').slice(0, MAX_TEXT);

    return {
      ok: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      loading: document.readyState !== 'complete',
      viewport,
      text,
      textLength: rawText.length,
      truncated: used >= MAX_TEXT,
      counts: { interactive: elements.length, visible: visibleCount, candidates: all.length },
      elements,
    };
  })()`;
}

/** 按稳定 id 查找元素（找到后可选地派发一次真实点击） */
function buildElementActionScript(elementId, mode) {
  const action = String(mode || 'inspect') === 'click' ? 'click' : 'inspect';
  return `(() => {
    ${PAGE_PRELUDE}
    const wanted = ${JSON.stringify(String(elementId || ''))};
    const all = document.querySelectorAll(SEL);
    let el = null;
    for (let i = 0; i < all.length; i += 1) {
      if (idOf(all[i]) === wanted) { el = all[i]; break; }
    }
    if (!el) {
      return {
        ok: false,
        code: 'ELEMENT_NOT_FOUND',
        error: '页面上找不到这个元素（id：' + wanted + '）',
      };
    }
    const info = { id: wanted, role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase() };
    if (${JSON.stringify(action)} !== 'click') return { ok: true, found: true, element: info };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + Math.max(1, rect.width) / 2;
    const clientY = rect.top + Math.max(1, rect.height) / 2;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerover', base));
    el.dispatchEvent(new PointerEvent('pointerdown', base));
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new PointerEvent('pointerup', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
    return { ok: true, clicked: info };
  })()`;
}

/** 按稳定 id 输入（同样先按 id 解析元素，找不到就是 ELEMENT_NOT_FOUND） */
function buildTypeByIdScript(elementId, text, clear, submit) {
  return `(() => {
    ${PAGE_PRELUDE}
    const wanted = ${JSON.stringify(String(elementId || ''))};
    const all = document.querySelectorAll(SEL);
    let el = null;
    for (let i = 0; i < all.length; i += 1) {
      if (idOf(all[i]) === wanted) { el = all[i]; break; }
    }
    if (!el) return { ok: false, code: 'ELEMENT_NOT_FOUND', error: '页面上找不到这个输入元素（id：' + wanted + '）' };
    if (el.disabled) return { ok: false, code: 'ELEMENT_DISABLED', error: '这个元素当前是禁用状态，写不进去' };
    el.focus();
    const text = ${JSON.stringify(String(text))};
    const current = el.isContentEditable ? (el.innerText || '') : (el.value || '');
    const next = ${clear ? 'text' : 'current + text'};
    if (el.isContentEditable) {
      el.textContent = next;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, next);
      else el.value = next;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    ${submit ? `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();` : ''}
    return { ok: true, id: wanted, length: String(next).length };
  })()`;
}

/** 元素不存在时的统一错误文案：明确告诉 agent 下一步该干什么 */
function elementNotFound(elementId) {
  const id = String(elementId || '').trim();
  return {
    ok: false,
    code: 'ELEMENT_NOT_FOUND',
    error: `页面上找不到这个元素（id：${id || '（空）'}）。页面可能已经跳转、刷新或内容变了，请重新读取页面（readPage）再操作，不要靠坐标猜。`,
  };
}

/**
 * 整理页面采集结果。
 * 只做「校验 + 裁剪 + 补齐字段」，不改 id，也不重排顺序（顺序就是文档顺序）。
 */
function summarizeReadPage(raw, limits) {
  const lim = Object.assign({}, READ_LIMITS, limits && typeof limits === 'object' ? limits : {});
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '页面没有返回可读内容（可能还没加载完）' };
  }
  if (raw.ok === false) {
    return { ok: false, error: raw.error || '读取页面失败' };
  }
  const list = Array.isArray(raw.elements) ? raw.elements : [];
  const elements = list.slice(0, lim.maxElements).map((item) => {
    const inputType = String(item && item.inputType ? item.inputType : '');
    // 密码框双重保险：即使页面脚本传回了值（老版本 / 被测脚本改过），这里也一律抹掉
    const masked = inputType === 'password';
    // 名字也一样：密码框的 name 只保留"这是个密码框"这个事实，不带任何原文
    const rawName = masked ? '' : (item && item.name);
    return {
      id: String(item && item.id ? item.id : ''),
      role: String(item && item.role ? item.role : 'generic'),
      name: masked ? '密码输入框' : normalizeName(rawName, lim.maxNameLen),
      tag: String(item && item.tag ? item.tag : ''),
      inputType,
      value: masked ? '' : String(item && item.value ? item.value : '').slice(0, 60),
      hasValue: Boolean(item && item.hasValue),
      masked,
      disabled: Boolean(item && item.disabled),
      inViewport: Boolean(item && item.inViewport),
    };
  });
  const viewport = raw.viewport && typeof raw.viewport === 'object'
    ? { width: Number(raw.viewport.width) || 0, height: Number(raw.viewport.height) || 0 }
    : { width: 0, height: 0 };
  const text = typeof raw.text === 'string' ? raw.text.slice(0, lim.maxText) : '';
  return {
    ok: true,
    url: String(raw.url || ''),
    title: String(raw.title || ''),
    readyState: String(raw.readyState || ''),
    loading: Boolean(raw.loading),
    viewport,
    text,
    textLength: Number(raw.textLength) || text.length,
    textTruncated: Boolean(raw.truncated) || text.length >= lim.maxText,
    counts: {
      interactive: elements.length,
      visible: Number(raw.counts && raw.counts.visible) || elements.length,
      candidates: Number(raw.counts && raw.counts.candidates) || list.length,
      inViewport: elements.filter((item) => item.inViewport).length,
      disabled: elements.filter((item) => item.disabled).length,
    },
    elements,
    // 给 agent 的一句话提示：先读再点，别猜坐标
    hint: elements.length
      ? '用元素的 id 去点击或输入（click / type 的 elementId 参数）；元素不存在时会明确报 ELEMENT_NOT_FOUND。'
      : '这个页面上没有找到可交互元素；如果页面还在加载，等加载完成后再读一次。',
  };
}

module.exports = {
  INTERACTIVE_SELECTOR,
  READ_LIMITS,
  buildElementActionScript,
  buildReadPageScript,
  buildTypeByIdScript,
  elementNotFound,
  hashId,
  normalizeName,
  summarizeReadPage,
};
