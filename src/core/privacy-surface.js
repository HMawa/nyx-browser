/**
 * 隐私模式的「页面侧指纹伪装」装配（安全审计 P0-3）。
 *
 * 审计结论（必须记住，别再犯）：原来 `src/preload-tab.js` 里 11 个 guard 全在
 * **隔离世界**（`contextIsolation:true` + preload）里改 `navigator`/`Date`/`Canvas`，
 * 而页面脚本跑在主世界——改的是另一份对象，页面一行都看不见。
 * 结果：请求头被改成 `Chrome/156`、`accept-language: en-US`，
 * 页面里 `navigator.userAgent` 仍是 `Nyx/x.y.z … Electron/45`、时区还是本机的。
 * **头与 JS 互相对不上，比完全不伪装更容易被识别。**
 *
 * 正确做法有三层，缺一层都不算修好：
 *   1. `webContents.setUserAgent()` —— 让请求头与 `navigator.userAgent` 同源；
 *   2. CDP `Emulation.setUserAgentOverride` / `setTimezoneOverride` / `setLocaleOverride`
 *      —— 让 UA（含 platform/acceptLanguage）、时区、语言一起对齐，且**在页面脚本之前**生效；
 *   3. CDP `Page.addScriptToEvaluateOnNewDocument` —— 把主世界的 Canvas/WebGL/Audio/
 *      硬件并发这些只能靠 JS 改的东西打上补丁，同样在页面脚本之前执行。
 *
 * 本模块只负责"生成要下发的脚本与命令"（纯逻辑，方便断言），
 * 真正的 attach 与失败提示在 `src/main.js` 的 `attachPrivacySurface()`。
 * 任何一层失败都必须让用户看见（红线 2：失败必须可见），不允许静默降级成"半加固"。
 */

'use strict';

/** 主世界补丁的版本号：改了补丁逻辑就加一，便于在诊断里区分 */
const SURFACE_SCRIPT_VERSION = 1;

/**
 * 生成主世界加固脚本。
 *
 * 设计要求：
 *   - 全部数值都由 `seed` 派生（同一会话内稳定，换会话就换），
 *     否则"每次刷新指纹都变"本身就是更强的指纹；
 *   - 只改"能被脚本读到"的东西，不动行为（不拦截网络、不碰 cookie）；
 *   - 用 `Object.defineProperty` 覆写 getter，并让 `toString()` 看起来像原生的
 *     （`Function.prototype.toString` 也一起处理，否则 `navigator.userAgent` 的
 *      getter 一打印就是 `function userAgent() { [native code] }` 之外的怪样子）；
 *   - 全部包在 IIFE 里，出错不抛到页面。
 */
function buildHardeningScript(profile) {
  const source = profile || {};
  const payload = {
    seed: String(source.seed || 'nyx'),
    ua: String(source.ua || ''),
    platform: String(source.platform || 'Win32'),
    languages: Array.isArray(source.languages) && source.languages.length ? source.languages : ['en-US', 'en'],
    timezone: String(source.timezone || ''),
    timezoneOffset: Number.isFinite(source.timezoneOffset) ? source.timezoneOffset : null,
    hardwareConcurrency: Number.isFinite(source.hardwareConcurrency) ? source.hardwareConcurrency : 8,
    deviceMemory: Number.isFinite(source.deviceMemory) ? source.deviceMemory : 8,
    // 屏幕尺寸/像素比/时区名这些"额外特征"：画像里没给就用一个与常见 1080p 笔记本一致的稳定值，
    // 至少不再是"本机真实分辨率的唯一值"；同一会话内保持一致（见下面 next() 的稳定伪随机）。
    screenWidth: Number.isFinite(source.screenWidth) ? source.screenWidth : 1920,
    screenHeight: Number.isFinite(source.screenHeight) ? source.screenHeight : 1080,
    devicePixelRatio: Number.isFinite(source.devicePixelRatio) ? source.devicePixelRatio : 1,
    timezoneLabel: String(source.timezoneLabel || source.timezone || 'GMT+0000 (Coordinated Universal Time)'),
    locale: String(source.locale || (Array.isArray(source.languages) && source.languages[0]) || 'en-US'),
  };

  return `(() => {
  'use strict';
  const CFG = ${JSON.stringify(payload)};
  const VERSION = ${SURFACE_SCRIPT_VERSION};
  if (window.__nyxSurface === VERSION) return;

  // 稳定伪随机：同一会话每次刷新得到同一组值（"每次都变"才是更强的指纹）
  let state = 2166136261 >>> 0;
  for (const ch of CFG.seed) {
    state ^= ch.charCodeAt(0);
    state = Math.imul(state, 16777619) >>> 0;
  }
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };

  const define = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, { value, configurable: true, enumerable: true, writable: false });
    } catch (err) { /* 只读属性就算了，不要因为一处失败整页崩 */ }
  };
  const defineGetter = (target, prop, getter) => {
    try {
      Object.defineProperty(target, prop, { get: getter, configurable: true, enumerable: true });
    } catch (err) { /* 同上 */ }
  };

  // ---- navigator：UA / 平台 / 语言 / 硬件 ----
  if (CFG.ua) {
    defineGetter(Navigator.prototype, 'userAgent', () => CFG.ua);
    defineGetter(Navigator.prototype, 'appVersion', () => CFG.ua.replace('Mozilla/', ''));
  }
  defineGetter(Navigator.prototype, 'platform', () => CFG.platform);
  defineGetter(Navigator.prototype, 'language', () => CFG.languages[0]);
  defineGetter(Navigator.prototype, 'languages', () => Object.freeze(CFG.languages.slice()));
  defineGetter(Navigator.prototype, 'hardwareConcurrency', () => CFG.hardwareConcurrency);
  defineGetter(Navigator.prototype, 'deviceMemory', () => CFG.deviceMemory);
  defineGetter(Navigator.prototype, 'webdriver', () => false);

  // ---- 时区：Date.getTimezoneOffset 与 Intl 一起改，否则两边一对就露馅 ----
  if (CFG.timezone && CFG.timezoneOffset !== null) {
    const offset = CFG.timezoneOffset;
    Date.prototype.getTimezoneOffset = function getTimezoneOffset() { return offset; };
    const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
      const out = origResolved.call(this);
      out.timeZone = CFG.timezone;
      return out;
    };
  }
  if (CFG.languages.length) {
    const origLocale = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
      const out = origLocale.call(this);
      out.locale = out.locale || CFG.languages[0];
      return out;
    };
  }

  // ---- Canvas：只加极小的确定性噪声（够打乱指纹，肉眼看不出来） ----
  const noisy = (data, strength) => {
    if (!data || !data.length) return data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, data[i] + Math.floor(next() * strength)));
    }
    return data;
  };
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
      const out = origGetImageData.apply(this, args);
      noisy(out.data, 2);
      return out;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width && this.height) {
          const data = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          noisy(data.data, 2);
          ctx.putImageData(data, 0, 0);
        }
      } catch (err) { /* 跨域画布会抛，忽略 */ }
      return origToDataURL.apply(this, args);
    };
  } catch (err) { /* 环境不支持 Canvas 就算了 */ }

  // ---- OffscreenCanvas：worker 里也能画，别让 canvas 指纹只剩一条缝 ----
  try {
    if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
      const origOff = OffscreenCanvasRenderingContext2D.prototype.getImageData;
      OffscreenCanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
        const out = origOff.apply(this, args);
        noisy(out.data, 2);
        return out;
      };
    }
  } catch (err) { /* 没有 OffscreenCanvas 就算了 */ }

  // ---- WebGL：vendor / renderer 说成主流 GPU，别暴露真实型号 ----
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    const fakeGlParam = (param) => {
      if (param === 37445) return 'Google Inc. (Intel)';
      if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return undefined;
    };
    WebGLRenderingContext.prototype.getParameter = function getParameter(param) {
      const fake = fakeGlParam(param);
      if (fake !== undefined) return fake;
      return origGetParameter.call(this, param);
    };
    // WebGL2 是另一套原型：只改 WebGL1 的话，webgl2 上下文里的 getParameter(37446)
    // 照样把真实型号报出来（对抗测试就是从这里钻过去的）。
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGet2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function getParameter(param) {
        const fake = fakeGlParam(param);
        if (fake !== undefined) return fake;
        return origGet2.call(this, param);
      };
    }
  } catch (err) { /* 没有 WebGL 就算了 */ }

  // ---- Audio：频域数据加一点噪声，避免 AudioContext 指纹 ----
  try {
    const origFloat = AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData = function getFloatFrequencyData(array) {
      origFloat.call(this, array);
      for (let i = 0; i < array.length; i += 1) {
        // 原本是 -Infinity 的位置要单独兜住：加噪声还是 -Infinity，会一眼看出"被改过"
        const base = Number.isFinite(array[i]) ? array[i] : -100 + next() * 0.5;
        array[i] = base + (next() - 0.5) * 0.02;
      }
    };
  } catch (err) { /* 没有 AnalyserNode 就算了 */ }

  // ---- 屏幕尺寸与像素比：外接屏 / 缩放比例是很强的区分特征 ----
  try {
    if (typeof Screen !== 'undefined') {
      defineGetter(Screen.prototype, 'width', () => CFG.screenWidth);
      defineGetter(Screen.prototype, 'height', () => CFG.screenHeight);
      defineGetter(Screen.prototype, 'availWidth', () => CFG.screenWidth);
      defineGetter(Screen.prototype, 'availHeight', () => CFG.screenHeight - 40);
      defineGetter(Screen.prototype, 'colorDepth', () => 24);
      defineGetter(Screen.prototype, 'pixelDepth', () => 24);
    }
    defineGetter(window, 'devicePixelRatio', () => CFG.devicePixelRatio);
  } catch (err) { /* 没有 screen 就算了 */ }

  // ---- 时间字符串：Date.toString() 里带本机时区名与语言，是最后一处真值出口 ----
  try {
    const origDateToString = Date.prototype.toString;
    const origToLocale = Date.prototype.toLocaleString;
    Date.prototype.toString = function toString() {
      try {
        return origDateToString.call(this).replace(/\\(([^)]+)\\)/, '(' + CFG.timezoneLabel + ')');
      } catch (err) {
        return origDateToString.call(this);
      }
    };
    Date.prototype.toLocaleString = function toLocaleString(locales, options) {
      if (locales === undefined) return origToLocale.call(this, CFG.locale, options);
      return origToLocale.call(this, locales, options);
    };
  } catch (err) { /* 改不动就靠 Intl 那一层 */ }

  // ---- 让改过的函数"看起来像原生的"（否则 toString 一眼看出被 hook） ----
  try {
    const origToString = Function.prototype.toString;
    const patched = new WeakSet();
    [Navigator.prototype, Date.prototype, Intl.DateTimeFormat.prototype, CanvasRenderingContext2D.prototype].forEach((proto) => {
      try { Object.getOwnPropertyNames(proto).forEach((key) => patched.add(proto[key])); } catch (err) { /* 忽略 */ }
    });
    Function.prototype.toString = function toString() {
      if (patched.has(this)) return 'function ' + (this.name || '') + '() { [native code] }';
      return origToString.call(this);
    };
  } catch (err) { /* 忽略 */ }

  window.__nyxSurface = VERSION;
  void define;
})();
`;
}

/**
 * 需要下发给页面的 CDP 命令（顺序固定，且在导航之前下发）。
 * 只包含"对齐身份"的三条 + 一条注入；不含任何读写页面内容的命令。
 *
 * 第一条 Page.enable 是必须的：`Page.addScriptToEvaluateOnNewDocument` 在 Page 域没启用时
 * 会"成功返回但从不执行"（实测：没有它，页面里读不到 `window.__nyxSurface`，指纹一条都没改，
 * 只有 UA / 请求头生效）。这类"看起来成功、其实没跑"的失败最难查，所以放在最前面。
 */
function buildCdpSteps(profile) {
  const source = profile || {};
  const steps = [{ method: 'Page.enable', params: {} }];
  const ua = String(source.ua || '');
  const majorMatch = ua.match(/Chrome\/(\d+)/);
  const major = majorMatch ? majorMatch[1] : '';
  if (ua) {
    const metadata = {
      brands: major
        ? [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not)A;Brand', version: '99' },
          ]
        : [],
      fullVersionList: major
        ? [
            { brand: 'Chromium', version: `${major}.0.0.0` },
            { brand: 'Google Chrome', version: `${major}.0.0.0` },
            { brand: 'Not)A;Brand', version: '99.0.0.0' },
          ]
        : [],
      // 真实 Chrome 在 Windows 上一直是 10.0.0，写死比留空安全：留空会让
      // navigator.userAgentData.platform === ''，那比不伪装更显眼。
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    };
    steps.push({
      method: 'Emulation.setUserAgentOverride',
      params: {
        userAgent: ua,
        acceptLanguage: Array.isArray(source.languages) ? source.languages.join(',') : 'en-US,en',
        platform: String(source.platform || 'Win32'),
        userAgentMetadata: metadata,
      },
    });
  }
  if (source.timezone) {
    steps.push({ method: 'Emulation.setTimezoneOverride', params: { timezoneId: String(source.timezone) } });
  }
  if (Array.isArray(source.languages) && source.languages.length) {
    steps.push({ method: 'Emulation.setLocaleOverride', params: { locale: String(source.languages[0]) } });
  }
  steps.push({
    method: 'Page.addScriptToEvaluateOnNewDocument',
    params: { source: buildHardeningScript(source) },
  });
  return steps;
}

/** 隐私模式才需要装配；正常模式一条都不下发（不伪装本身也是一种口径） */
function shouldAttachSurface(mode) {
  return String(mode) === 'private';
}

/** 给用户看的失败说明：说清"哪一层没成、现在是什么状态" */
function describeSurfaceFailure(step, error) {
  const stage = String(step || '');
  const reason = String((error && error.message) || error || '未知原因');
  if (stage === 'setUserAgent') {
    return `隐私模式没能把 UA 改成伪装值（${reason}）：这一页报出来的浏览器标识会与请求头不一致，建议关掉这一页重新打开。`;
  }
  if (stage === 'attach' || stage === 'send') {
    return `隐私模式没能把指纹补丁下发给页面（${reason}）：这一页看到的时区/语言/画布指纹可能仍是本机的，建议关掉这一页重新打开。`;
  }
  return `隐私模式加固没做完（${stage || '未知环节'}：${reason}）：这一页的指纹可能不完整。`;
}

module.exports = {
  SURFACE_SCRIPT_VERSION,
  buildCdpSteps,
  buildHardeningScript,
  describeSurfaceFailure,
  shouldAttachSurface,
};
