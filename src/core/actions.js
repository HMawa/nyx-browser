'use strict';

/**
 * 动作执行器（AI 操作能力的统一实现）。
 *
 * 本地 HTTP API 与 MCP 服务都复用这里的 run()，保证两套入口能力完全一致。
 * 支持的能力：
 *   navigate      导航到指定 URL
 *   screenshot    截取当前标签可视区域（返回 PNG base64）
 *   click         按 CSS 选择器点击元素
 *   type          向输入框/可编辑区域输入文字（可回车提交）
 *   executeJS     在页面上下文执行 JavaScript
 *   extractText   提取页面正文纯文本
 *   state         读取浏览器当前状态（模式 / 标签列表 / 上限）
 *   riskLog       读取实时风控日志
 *
 * 所有动作统一返回 { ok, action, data?, error?, elapsedMs }。
 */

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
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
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

function createActionRunner({ getTabManager, getMode, getNetwork, getRiskLog }) {
  /** 取当前激活标签的 webContents */
  function activeWebContents() {
    const manager = getTabManager();
    if (!manager) return null;
    return manager.getActiveWebContents();
  }

  async function run(action) {
    const started = Date.now();
    const type = action && action.type;
    const params = (action && action.params) || {};

    const wrap = (payload) => ({
      ok: payload.ok !== false,
      action: type,
      data: payload.ok === false ? undefined : payload,
      error: payload.ok === false ? payload.error : undefined,
      elapsedMs: Date.now() - started,
    });

    try {
      if (!type) return { ok: false, action: null, error: '缺少动作类型（type）', elapsedMs: 0 };

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

      const wc = activeWebContents();
      if (!wc) return { ok: false, action: type, error: '当前没有可操作的活动标签', elapsedMs: Date.now() - started };

      switch (type) {
        case 'navigate': {
          if (!params.url) return { ok: false, action: type, error: '缺少参数 url', elapsedMs: Date.now() - started };
          const result = await getTabManager().navigate(params.url);
          return wrap(result.ok ? { ok: true, url: result.url } : { ok: false, error: result.error });
        }

        case 'screenshot': {
          const image = await wc.capturePage();
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
          if (!params.selector) return { ok: false, action: type, error: '缺少参数 selector', elapsedMs: Date.now() - started };
          const result = await wc.executeJavaScript(buildClickScript(params.selector, params.index || 0), true);
          return wrap(result);
        }

        case 'type': {
          if (!params.selector) return { ok: false, action: type, error: '缺少参数 selector', elapsedMs: Date.now() - started };
          if (typeof params.text !== 'string') return { ok: false, action: type, error: '缺少参数 text', elapsedMs: Date.now() - started };
          const script = buildTypeScript(params.selector, params.text, params.clear !== false, !!params.submit);
          const result = await wc.executeJavaScript(script, true);
          return wrap(result);
        }

        case 'executeJS': {
          if (!params.code) return { ok: false, action: type, error: '缺少参数 code', elapsedMs: Date.now() - started };
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
      return { ok: false, action: type, error: err && err.message ? err.message : String(err), elapsedMs: Date.now() - started };
    }
  }

  return { run };
}

module.exports = { createActionRunner };
