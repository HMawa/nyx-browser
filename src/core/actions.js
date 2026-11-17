'use strict';

/**
 * 动作执行器（AI 操作能力的统一实现）。
 *
 * 本地 HTTP API 与 MCP 服务都复用这里的 run()，保证两套入口能力完全一致。
 * 支持的能力：
 *   navigate      导航到指定 URL
 *   readPage      结构化读取页面（url/title/正文摘要/可交互元素清单 + 稳定 id）
 *   screenshot    截取当前标签可视区域（返回 PNG base64；只做人工辅助，不是主通道）
 *   click         点击元素（按稳定 elementId，或退回 CSS 选择器）
 *   type          向输入框/可编辑区域输入文字（按稳定 elementId，或退回 CSS 选择器）
 *   executeJS     在页面上下文执行 JavaScript
 *   extractText   提取页面正文纯文本
 *   state         读取浏览器当前状态（模式 / 标签列表 / 上限）
 *   riskLog       读取实时风控日志
 *
 * 所有动作统一返回 { ok, action, data?, error?, elapsedMs }。
 *
 * 注意：本模块只负责「执行」。权限判定、人工确认、留痕与急停都在
 * src/core/agent-dispatch.js 的统一通道里完成——动作执行器不对外直接暴露给
 * 本地接口或 MCP，否则通道就被绕过了。
 */

const {
  buildElementActionScript,
  buildReadPageScript,
  buildTypeByIdScript,
  elementNotFound,
  summarizeReadPage,
  validateLimits,
} = require('./page-reader');

/** 导航上限（安全审计 P1-4）：超过这么久没完成就如实报超时，不让整条通道挂住 */
const NAVIGATE_TIMEOUT_MS = 15000;

const ACTION_TYPES = [
  'navigate',
  'readPage',
  'screenshot',
  'click',
  'type',
  'executeJS',
  'extractText',
  'state',
  'riskLog',
  // 改设置：不碰页面，但同样必须在动作名单里，否则通道/执行器两份名单不一致
  'settings',
];

/** 页面内点击脚本：对目标元素派发完整鼠标事件序列 */
function buildClickScript(selector, index) {
  return `(() => {
    const nodes = document.querySelectorAll(${JSON.stringify(selector)});
    const el = nodes[${Number(index) || 0}];
    if (!el) return { ok: false, error: '未找到匹配元素：${String(selector).replace(/'/g, "\\'")}' };
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
    return {
      ok: true,
      tag: el.tagName,
      // 安全审计 P1-1：密码框的文字不回显（点击结果里也不许带出用户输过的密码）
      text: (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password'
        ? (el.getAttribute('aria-label') || '')
        : (el.innerText || el.value || el.getAttribute('aria-label') || '')).trim().slice(0, 120),
    };
  })()`;
}

/** 页面内输入脚本：兼容 input / textarea / contenteditable 与 React 受控组件 */
function buildTypeScript(selector, text, clear, submit) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: '未找到输入元素：' + ${JSON.stringify(String(selector))} };
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

    return { ok: true, value: String(next).slice(0, 200) };
  })()`;
}

/** 页面内正文提取脚本 */
function buildExtractScript(selector) {
  return `(() => {
    const custom = ${JSON.stringify(selector || '')};
    const root = (custom && document.querySelector(custom))
      || document.querySelector('article')
      || document.querySelector('main')
      || document.body;
    if (!root) return { ok: false, error: '页面没有可提取的内容' };
    const text = (root.innerText || root.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return {
      ok: true,
      title: document.title,
      url: location.href,
      length: text.length,
      text,
    };
  })()`;
}

function createActionRunner({ getTabManager, getMode, getNetwork, getRiskLog, getSettings, applySetting }) {
  /** 取当前激活标签的 webContents */
  function activeWebContents() {
    const manager = getTabManager();
    if (!manager) return null;
    return manager.getActiveWebContents();
  }

  async function run(action, options) {
    const started = Date.now();
    const type = action && action.type;
    const params = (action && action.params) || {};
    const opts = options && typeof options === 'object' ? options : {};
    const signal = opts.signal;

    // 急停后不允许再派发任何一步：在执行器入口和每个页面动作前各查一次
    const aborted = () => Boolean(signal && signal.aborted);
    const interrupted = () => ({
      ok: false,
      action: type,
      code: 'ABORTED',
      error: '动作已被紧急停止中断',
      elapsedMs: Date.now() - started,
    });

    const wrap = (payload) => ({
      ok: payload.ok !== false,
      action: type,
      data: payload.ok === false ? undefined : payload,
      error: payload.ok === false ? payload.error : undefined,
      // 执行失败时把业务错误码透出去（如 ELEMENT_NOT_FOUND / ELEMENT_DISABLED），
      // 否则通道只能一律记 ACTION_FAILED，agent 分不清"元素没了"和"执行炸了"。
      code: payload.ok === false ? payload.code || '' : '',
      elapsedMs: Date.now() - started,
    });

    try {
      if (!type) return { ok: false, action: null, error: '缺少动作类型（type）', elapsedMs: 0 };
      if (aborted()) return interrupted();

      // ---- 不需要页面上下文的动作 ----
      if (type === 'state') {
        const manager = getTabManager();
        // network 与标签一起返回：验收与界面都用同一口径判断"当前到底走代理还是直连"
        const network = typeof getNetwork === 'function' ? getNetwork() : null;
        return wrap({
          ok: true,
          state: manager
            ? manager.snapshot()
            : { mode: getMode(), activeId: null, network, tabs: [] },
        });
      }

      if (type === 'riskLog') {
        return wrap({ ok: true, log: getRiskLog({ limit: params.limit || 100, onlyBlocked: !!params.onlyBlocked }) });
      }

      // ---- 改设置：不碰页面，所以放在"必须要有活动标签"之前 ----
      // 读 schema 与写改动都交给主进程注入的两个函数，判定规则在 src/core/agent-settings.js
      if (type === 'settings') {
        if (aborted()) return interrupted();
        // undo:true 是"撤销上一次"，它同样只走这一个入口（人工确认与留痕都在通道里做）
        if (params.apply === true || params.key || params.undo === true || params.preset) {
          if (typeof applySetting !== 'function') {
            return wrap({ ok: false, error: '当前内核不支持由 agent 改设置' });
          }
          const applied = await applySetting(params);
          return wrap(applied);
        }
        if (typeof getSettings !== 'function') {
          return wrap({ ok: false, error: '当前内核不支持读取设置选项' });
        }
        const schema = getSettings();
        return wrap({ ok: true, ...schema });
      }

      const wc = activeWebContents();
      if (!wc) return { ok: false, action: type, error: '当前没有可操作的活动标签', elapsedMs: Date.now() - started };
      if (aborted()) return interrupted();

      switch (type) {
        case 'navigate': {
          if (!params.url) return { ok: false, action: type, error: '缺少参数 url', elapsedMs: Date.now() - started };
          if (aborted()) return interrupted();
          // 安全审计 P1-4：导航要有上限。
          // 以前 `await navigate()` 一直等加载完成——遇到不返回的站点、被系统吞掉的
          // 请求、或者一个永远在重定向的页面，这一个动作就会把整条动作通道挂住，
          // 后面的动作全部排队，用户只看到"agent 卡住了"。
          const budget = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : NAVIGATE_TIMEOUT_MS;
          let timer = null;
          const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ __timeout: true }), budget);
          });
          let result;
          try {
            result = await Promise.race([getTabManager().navigate(params.url), timeout]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (result && result.__timeout) {
            return {
              ok: false,
              action: type,
              code: 'NAVIGATE_TIMEOUT',
              error: `打开这个地址超过 ${Math.round(budget / 1000)} 秒还没完成（可能站点很慢、一直在跳转，或者网络断了）。地址本身已经交给浏览器，你可以稍后用 state / readPage 看看是否已经加载好。`,
              url: params.url,
              elapsedMs: Date.now() - started,
            };
          }
          return wrap(result.ok ? { ok: true, url: result.url } : { ok: false, error: result.error });
        }

        case 'readPage': {
          if (aborted()) return interrupted();
          // 先校验上限：负数/0/非整数一律拒绝。夹一下最省事，但 `maxElements:-1`
          // 配 slice(0,-1) 会悄悄少给一条、`maxText:0` 会悄悄给空正文——比报错更难查。
          const limits = validateLimits({ maxElements: params.maxElements, maxText: params.maxText });
          if (!limits.ok) return wrap({ ok: false, code: limits.code, error: limits.error });
          const raw = await wc.executeJavaScript(
            buildReadPageScript({ maxText: limits.limits.maxText, maxElements: limits.limits.maxElements }),
            true,
          );
          if (aborted()) return interrupted();
          // 上限要两处一致：页面脚本按它截，汇总这里也按同一份截。
          // 只给页面不给汇总，就会出现「文档说能给 800，实际 300 就封顶」的静默封顶。
          return wrap(summarizeReadPage(raw, limits.limits));
        }

        case 'screenshot': {
          // 窗口最小化 / 被完全遮挡 / 正被模态确认框禁用时，capturePage 会直接拿不到画面
          // （Current display surface not available for capture）。agent 常在后台跑，
          // 这是最常见的一种失败——先把窗口恢复出来，再截。
          const owner = typeof wc.getOwnerBrowserWindow === 'function' ? wc.getOwnerBrowserWindow() : null;
          if (owner && !owner.isDestroyed()) {
            try {
              if (!owner.isVisible() || owner.isMinimized()) owner.restore();
              if (!owner.isVisible()) owner.show();
              owner.moveTop();
            } catch {
              /* 忽略：拿不到窗口就把失败原因交给下面统一报 */
            }
          }
          // 导航刚完成时第一次 capturePage 常常拿不到帧（UnknownVizError），
          // 等一帧再来一次通常就好——所以失败重试一次，而不是直接把错丢给用户。
          let image = null;
          let lastError = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              image = await wc.capturePage();
              break;
            } catch (err) {
              lastError = err;
              if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 180));
            }
          }
          if (!image) {
            const reason = (lastError && lastError.message) || '页面还没画出第一帧';
            return wrap({
              ok: false,
              code: 'SCREENSHOT_NO_SURFACE',
              error: `截图失败：${reason}。截图需要窗口可见——把 Nyx 窗口恢复出来（别最小化、别被别的窗口完全盖住），或者先关掉挡在前面的确认框。`,
            });
          }
          const size = image.getSize();
          return wrap({
            ok: true,
            format: 'png',
            width: size.width,
            height: size.height,
            base64: image.toPNG().toString('base64'),
          });
        }

        case 'click': {
          // 优先按稳定 id 点（清单 B：不许靠坐标猜）；没有 id 才退回 CSS 选择器
          if (params.elementId) {
            if (aborted()) return interrupted();
            const byId = await wc.executeJavaScript(buildElementActionScript(params.elementId, 'click'), true);
            if (aborted()) return interrupted();
            if (byId && byId.ok === false) return wrap(elementNotFound(params.elementId));
            return wrap(byId);
          }
          if (!params.selector) return { ok: false, action: type, error: '缺少参数 selector 或 elementId', elapsedMs: Date.now() - started };
          if (aborted()) return interrupted();
          const result = await wc.executeJavaScript(buildClickScript(params.selector, params.index || 0), true);
          return wrap(result);
        }

        case 'type': {
          if (typeof params.text !== 'string') return { ok: false, action: type, error: '缺少参数 text', elapsedMs: Date.now() - started };
          if (params.elementId) {
            if (aborted()) return interrupted();
            const byId = await wc.executeJavaScript(
              buildTypeByIdScript(params.elementId, params.text, params.clear !== false, !!params.submit),
              true,
            );
            if (aborted()) return interrupted();
            if (byId && byId.ok === false) {
              if (byId.code === 'ELEMENT_DISABLED') return wrap(byId);
              return wrap(elementNotFound(params.elementId));
            }
            return wrap(byId);
          }
          if (!params.selector) return { ok: false, action: type, error: '缺少参数 selector 或 elementId', elapsedMs: Date.now() - started };
          if (aborted()) return interrupted();
          const script = buildTypeScript(params.selector, params.text, params.clear !== false, !!params.submit);
          const result = await wc.executeJavaScript(script, true);
          return wrap(result);
        }

        case 'executeJS': {
          if (!params.code) return { ok: false, action: type, error: '缺少参数 code', elapsedMs: Date.now() - started };
          if (aborted()) return interrupted();
          const result = await wc.executeJavaScript(String(params.code), true);
          return wrap({ ok: true, result: result === undefined ? null : result });
        }

        case 'extractText': {
          const result = await wc.executeJavaScript(buildExtractScript(params.selector), true);
          if (!result || result.ok === false) return wrap(result || { ok: false, error: '提取失败' });
          const maxLength = Number(params.maxLength || 20000);
          const truncated = result.text.length > maxLength;
          return wrap({
            ok: true,
            title: result.title,
            url: result.url,
            length: result.length,
            truncated,
            text: truncated ? result.text.slice(0, maxLength) : result.text,
          });
        }

        default:
          return { ok: false, action: type, error: `不支持的动作类型：${type}`, elapsedMs: Date.now() - started };
      }
    } catch (err) {
      return {
        ok: false,
        action: type,
        code: err && err.code ? err.code : '',
        error: err && err.message ? err.message : String(err),
        elapsedMs: Date.now() - started,
      };
    }
  }

  return { run };
}

module.exports = { ACTION_TYPES, createActionRunner };
