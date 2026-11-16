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
const SURFACE_SCRIPT_VERSION = 2;

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
    // navigator.platform 用的是 Win32 这种值（不是 UA-CH 里的 Windows），
    // 画像里两者分开存；老调用方只传 platform 时按 Win32 兜底。
    platform: String(source.navigatorPlatform || source.platform || 'Win32'),
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

  // ---- Canvas：确定性噪声（同一块画布算多少次都一样），且绝不写回页面画布 ----
  // 两条都是被对抗测试抓出来的真 bug：
  //   ① 噪声按调用次数推进 PRNG → 同一画布两次 toDataURL/getImageData 结果不同，
  //      而真 Chrome 是确定的，"两次不一致"本身就是检测信号；
  //   ② toDataURL 把噪声 putImageData 写回了原画布 → 页面画布被篡改、重复导出累积噪声。
  const seedHash = state;
  const noiseFor = (index, value) => {
    let h = (seedHash ^ Math.imul(index, 2654435761) ^ Math.imul(value, 40503)) >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    return (h % 3) - 1;
  };
  const noisy = (data) => {
    if (!data || !data.length) return data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, data[i] + noiseFor(i, data[i])));
    }
    return data;
  };
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
      const out = origGetImageData.apply(this, args);
      // getImageData 本来就返回一份拷贝，改它不会动到页面画布
      noisy(out.data);
      return out;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const surfaceCopies = new WeakSet();
    HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
      // 自己造的副本直接原样导出，否则会一层层复制下去（递归）
      if (surfaceCopies.has(this)) return origToDataURL.apply(this, args);
      try {
        const ctx = this.getContext('2d');
        if (ctx && this.width && this.height) {
          const data = origGetImageData.call(ctx, 0, 0, this.width, this.height);
          noisy(data.data);
          // 在副本上导出：原画布一个像素都不碰
          const copy = document.createElement('canvas');
          copy.width = this.width;
          copy.height = this.height;
          const copyCtx = copy.getContext('2d');
          if (copyCtx) {
            copyCtx.putImageData(data, 0, 0);
            surfaceCopies.add(copy);
            return origToDataURL.apply(copy, args);
          }
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
        noisy(out.data);
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
    // fullVersionList 必须是完整版本号（156.0.8078.100 这种），而 brands 里写主版本；
    // 之前两处都写 `<主版本>.0.0.0`，与 uaFullVersion 对不上，是自相矛盾的一条。
    const fullVersion = String(source.chromeVersion || '') || (major ? `${major}.0.0.0` : '');
    const metadata = {
      brands: major
        ? [
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major },
            { brand: 'Not)A;Brand', version: '99' },
          ]
        : [],
      fullVersionList: fullVersion
        ? [
            { brand: 'Chromium', version: fullVersion },
            { brand: 'Google Chrome', version: fullVersion },
            { brand: 'Not)A;Brand', version: '99.0.0.0' },
          ]
        : [],
      // UA-CH 的 platform 是 `Windows`（不是 navigator.platform 的 Win32）；
      // 留空会让 navigator.userAgentData.platform === ''，那比不伪装更显眼。
      platform: String(source.platform || 'Windows'),
      // 读得出真实系统版本才写，读不出就不传 —— 猜一个错的值反而对不上。
      ...(source.platformVersion ? { platformVersion: String(source.platformVersion) } : {}),
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
        // 请求头用原始的 Accept-Language（带 q 值是正常的），页面里读到的列表另行解析
        acceptLanguage: String(source.acceptLanguage || '') || (Array.isArray(source.languages) ? source.languages.join(',') : 'en-US,en'),
        platform: String(source.navigatorPlatform || source.platform || 'Win32'),
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

/**
 * Worker 版的加固脚本（对抗测试 P0：Worker 里读到的是真实值）。
 *
 * 为什么必须单独一份：`Page.addScriptToEvaluateOnNewDocument` 只作用于**文档**（含 iframe），
 * 不进入 Worker / ServiceWorker；`Emulation.setTimezoneOverride` 也不跨 worker 目标。
 * 实测同一页三处不一致：主世界 en-US/Win32、Worker zh-CN/Win32（真值）、iframe en-US/Win32。
 * Worker 里没有 document / window，只有 self，所以这里只碰 navigator、Date、Intl、OffscreenCanvas。
 * 同样的原则：失败不抛到页面，各处 try/catch。
 */
function buildWorkerHardeningScript(profile) {
  const source = profile || {};
  const payload = {
    version: SURFACE_SCRIPT_VERSION,
    seed: String(source.seed || 'nyx'),
    ua: String(source.ua || ''),
    platform: String(source.navigatorPlatform || source.platform || 'Win32'),
    language: String(source.language || 'en-US'),
    languages: Array.isArray(source.languages) ? source.languages.slice(0, 8) : [],
    // 与主世界保持同一套默认值：画像里没有这两个字段时主世界用 8，Worker 也必须用 8，
    // 否则同一页主世界 8 核、Worker 24 核，等于自己把矛盾暴露出来（实测踩过）。
    cores: Number.isFinite(source.hardwareConcurrency) ? source.hardwareConcurrency : 8,
    memory: Number.isFinite(source.deviceMemory) ? source.deviceMemory : 8,
    timezone: String(source.timezone || ''),
  };
  return `(function () {
  try {
    var CFG = ${JSON.stringify(payload)};
    var scope = typeof self !== 'undefined' ? self : this;
    var nav = scope.navigator;
    if (nav) {
      var def = function (name, value) {
        try { Object.defineProperty(nav, name, { get: function () { return value; }, configurable: true }); } catch (e) {}
      };
      if (CFG.ua) def('userAgent', CFG.ua);
      def('appVersion', String(CFG.ua || '').replace(/^Mozilla\\//, ''));
      def('platform', CFG.platform);
      def('language', CFG.language);
      if (CFG.languages.length) {
        var langs = CFG.languages.slice();
        try { Object.freeze(langs); } catch (e) {}
        def('languages', langs);
      }
      if (CFG.cores > 0) def('hardwareConcurrency', CFG.cores);
      if (CFG.memory > 0) def('deviceMemory', CFG.memory);
      def('webdriver', false);
    }
    if (CFG.timezone) {
      try {
        var fmt = Intl.DateTimeFormat;
        var origFormat = fmt.prototype.resolvedOptions;
        fmt.prototype.resolvedOptions = function () {
          var out = origFormat.call(this);
          out.timeZone = CFG.timezone;
          return out;
        };
        var origOffset = Date.prototype.getTimezoneOffset;
        var probe = new Date(2020, 0, 1);
        var probeText = probe.toLocaleString('en-US', { timeZone: CFG.timezone });
        var parsed = Date.parse(probeText);
        var offset = Math.round(((parsed ? probe.getTime() - parsed : 0) / 60000));
        Date.prototype.getTimezoneOffset = function () { return offset; };
        if (typeof origOffset !== 'function') { /* 只作可读性 */ }
      } catch (e) {}
    }
    try {
      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        var origGet = OffscreenCanvasRenderingContext2D.prototype.getImageData;
        OffscreenCanvasRenderingContext2D.prototype.getImageData = function () {
          var out = origGet.apply(this, arguments);
          var data = out && out.data;
          if (data && data.length) {
            for (var i = 0; i < data.length; i += 4) {
              data[i] = Math.max(0, Math.min(255, data[i] + ((i % 3) - 1)));
            }
          }
          return out;
        };
      }
    } catch (e) {}
    scope.__nyxSurface = CFG.version;
  } catch (err) { /* worker 里也不许把页面搞崩 */ }
})();`;
}

module.exports = {
  SURFACE_SCRIPT_VERSION,
  buildCdpSteps,
  buildHardeningScript,
  buildWorkerHardeningScript,
  describeSurfaceFailure,
  shouldAttachSurface,
};
