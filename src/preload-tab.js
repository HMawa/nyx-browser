'use strict';

/**
 * 标签页预加载脚本（每个网页视图都会注入）。
 *
 * 承担两件事：
 *   A. 正常模式：表单自动填充 + 密码填充（填充瞬间由主进程解密，明文不进本文件之外）
 *   B. 全隐私模式：按 browserleaks.com 的检测项逐项做页面内防泄漏
 *      —— WebRTC / Canvas / WebGL / 字体 / 音频 / 时区 / 屏幕 / 媒体设备 /
 *         Geolocation / 电池 / WebGPU / 语音合成 / Electron 特征 / 客户端提示
 *
 * 设计底线：
 *   1) 任何一处加固都必须包在 try/catch 里 —— 加固失败绝不能让页面白屏。
 *   2) 噪声全部"确定性"：同一会话内同输入同输出。指纹噪声如果每次刷新都变，
 *      反而比不伪装更独特（可被"二次访问不一致"直接识破）。
 *   3) 伪造值与主进程下发的 profile 共用一套参数（UA / 语言 / 时区），
 *      JS 里报的和服务端看到的必须互相自洽。
 */

const { ipcRenderer, contextBridge } = require('electron');

/** 解析主进程经 additionalArguments 传入的配置 */
function parseArgs(argv) {
  const config = { mode: 'normal', seed: '0', tz: '', tzOffset: null, languages: [], ua: '', platform: 'Windows', chrome: '' };
  for (const raw of argv || []) {
    const arg = String(raw);
    if (arg.startsWith('--nyx-mode=')) config.mode = arg.slice(11);
    else if (arg.startsWith('--nyx-seed=')) config.seed = arg.slice(11);
    else if (arg.startsWith('--nyx-tz=')) config.tz = arg.slice(9);
    else if (arg.startsWith('--nyx-tz-offset=')) config.tzOffset = Number(arg.slice(16));
    else if (arg.startsWith('--nyx-lang=')) config.languages = arg.slice(11).split(',').filter(Boolean);
    else if (arg.startsWith('--nyx-ua=')) {
      try {
        config.ua = decodeURIComponent(arg.slice(9));
      } catch {
        config.ua = arg.slice(9);
      }
    } else if (arg.startsWith('--nyx-platform=')) config.platform = arg.slice(15);
    else if (arg.startsWith('--nyx-chrome=')) config.chrome = arg.slice(13);
  }
  return config;
}

/**
 * 向主进程同步取结构化配置。
 *
 * argv 在 sandbox 渲染进程里不保证可见（拿不到就等于"隐私模式却没加固"，属于
 * 静默失效），因此结构化下发才是权威来源；argv 只作兜底，两者取并集，
 * 主进程给的值优先。
 */
function fetchSyncConfig() {
  try {
    const result = ipcRenderer.sendSync('nyx:tab:config');
    if (result && result.ok) return result;
  } catch {
    /* 忽略：主进程未响应时退回 argv */
  }
  return null;
}

/** 合并 argv 与结构化配置：结构化优先，缺失字段用 argv 补齐 */
function mergeConfig(fromArgv, fromMain) {
  const merged = { ...fromArgv };
  if (!fromMain) return merged;
  for (const key of ['mode', 'seed', 'tz', 'ua', 'platform', 'chrome', 'country']) {
    if (fromMain[key] !== undefined && fromMain[key] !== null && fromMain[key] !== '') {
      merged[key] = fromMain[key];
    }
  }
  if (fromMain.tzOffset !== undefined && fromMain.tzOffset !== null && !Number.isNaN(fromMain.tzOffset)) {
    merged.tzOffset = fromMain.tzOffset;
  }
  if (Array.isArray(fromMain.languages) && fromMain.languages.length) {
    merged.languages = fromMain.languages.slice();
  }
  if (fromMain.egressUnknown !== undefined) merged.egressUnknown = Boolean(fromMain.egressUnknown);
  // 验收探针开关由主进程下发的结构化配置决定（argv 不可信，不接受命令行开启）
  if (fromMain.verify !== undefined) merged.verify = fromMain.verify === true || fromMain.verify === '1';
  return merged;
}

let argvConfig = { mode: 'normal' };
try {
  argvConfig = parseArgs(process.argv);
} catch {
  /* 忽略：取不到 argv 时完全依赖结构化配置 */
}

const CONFIG = mergeConfig(argvConfig, fetchSyncConfig());
const PRIVATE = CONFIG.mode === 'private';
/** 加固过程中记下的条目，供验收脚本读取（不含任何密钥） */
const APPLIED = [];

function note(item) {
  APPLIED.push(item);
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 记录被替换的函数名，让 Function.prototype.toString 仍然报 native */
const patchedNames = new WeakMap();
const nativeToString = Function.prototype.toString;

function maskNative(fn, name) {
  try {
    patchedNames.set(fn, name);
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
  } catch {
    /* 忽略 */
  }
  return fn;
}

(function installToStringMask() {
  try {
    const proxy = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        if (patchedNames.has(thisArg)) {
          return `function ${patchedNames.get(thisArg)}() { [native code] }`;
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    Function.prototype.toString = proxy;
    maskNative(Function.prototype.toString, 'toString');
  } catch {
    /* 忽略 */
  }
})();

/** 字符串种子 → 32 位整数 */
function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32：小而稳的确定性随机数 */
function makeRng(seedText) {
  let state = hashSeed(String(seedText));
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RNG = makeRng(CONFIG.seed || 'nyx');

function safeDefine(target, prop, descriptor) {
  try {
    Object.defineProperty(target, prop, descriptor);
    return true;
  } catch {
    return false;
  }
}

/** 把函数装到对象上（带 native 伪装） */
function replaceMethod(target, prop, impl, name) {
  try {
    const original = target[prop];
    if (typeof original !== 'function') return null;
    const wrapped = maskNative(impl(original), name || prop);
    safeDefine(target, prop, { value: wrapped, configurable: true, writable: true });
    return original;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * A. 表单记忆与密码填充（仅正常模式）
 * ------------------------------------------------------------------ */

const FORM_VALUE_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'date', 'month', 'week', 'time', 'datetime-local']);

/** 给表单控件生成稳定的键：优先 name / id / autocomplete，退化到类型+序号 */
function fieldKey(el, index) {
  const name = el.getAttribute && (el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('autocomplete'));
  const tag = el.tagName ? el.tagName.toLowerCase() : 'input';
  const type = el.type || '';
  return `${tag}|${type}|${name || `#${index}`}`;
}

/** 收集页面里"值得记忆"的字段值 */
function collectFormValues() {
  const values = {};
  let index = 0;
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const type = (el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file' || type === 'submit' || type === 'button' || type === 'image' || type === 'checkbox' || type === 'radio') {
      index += 1;
      continue;
    }
    const isTextarea = el.tagName === 'TEXTAREA';
    const isSelect = el.tagName === 'SELECT';
    if (!isTextarea && !isSelect && !FORM_VALUE_TYPES.has(type)) {
      index += 1;
      continue;
    }
    const value = String(el.value == null ? '' : el.value).trim();
    if (value) values[fieldKey(el, index)] = value.slice(0, 1024);
    index += 1;
  }
  return values;
}

/** 按主进程给的键值回填 */
function applyFormValues(values) {
  if (!values) return 0;
  let filled = 0;
  let index = 0;
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const key = fieldKey(el, index);
    index += 1;
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    if (String(el.value || '').trim()) continue; // 用户已输入的内容不覆盖
    if (el.disabled || el.readOnly) continue;

    const value = String(values[key]);
    try {
      if (el.tagName === 'SELECT') {
        const option = [...el.options].find((item) => item.value === value || item.text === value);
        if (!option) continue;
        el.value = option.value;
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filled += 1;
    } catch {
      /* 单个字段失败不影响其它字段 */
    }
  }
  return filled;
}

/** 找到第一个密码框所属的用户名框 */
function findUsernameField(passwordEl) {
  const scope = passwordEl.form || document;
  const candidates = [...scope.querySelectorAll('input')].filter(
    (el) => (el.type || '').toLowerCase() === 'text' || (el.type || '').toLowerCase() === 'email' || (el.type || '').toLowerCase() === 'tel',
  );
  if (!candidates.length) return null;
  // 取距离密码框最近（DOM 顺序上在它之前）的那个
  let best = candidates[0];
  for (const el of candidates) {
    if (el.compareDocumentPosition(passwordEl) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
  }
  return best;
}

function setValue(el, value) {
  if (!el) return false;
  try {
    el.focus({ preventScroll: true });
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

/** 悬浮的"填充已保存密码"按钮（Shadow DOM 隔离，不影响站点样式） */
function renderFillButton(onClick) {
  try {
    if (document.getElementById('__nyx_fill_host')) return;
    const host = document.createElement('div');
    host.id = '__nyx_fill_host';
    host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '填充已保存的密码';
    button.style.cssText = [
      'all:initial',
      'font:12px/1.6 system-ui,sans-serif',
      'padding:6px 10px',
      'border-radius:6px',
      'border:1px solid #3c6df0',
      'background:#3c6df0',
      'color:#fff',
      'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.2)',
    ].join(';');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve(onClick()).finally(() => host.remove());
    });
    shadow.appendChild(button);
    (document.body || document.documentElement).appendChild(host);
  } catch {
    /* 注入失败静默降级：用户可以手动输入 */
  }
}

/** 密码框出现时挂上填充入口 */
async function setupPasswordFill() {
  const passwordFields = [...document.querySelectorAll('input[type="password"]')];
  if (!passwordFields.length) return;

  let info = null;
  try {
    info = await ipcRenderer.invoke('nyx:vault:has', { origin: location.origin });
  } catch {
    return;
  }
  if (!info || !info.ok || !info.has) return;

  renderFillButton(async () => {
    let cred = null;
    try {
      cred = await ipcRenderer.invoke('nyx:vault:fill', { origin: location.origin });
    } catch {
      cred = null;
    }
    if (!cred || !cred.ok) return;
    const fields = [...document.querySelectorAll('input[type="password"]')];
    const target = fields[0];
    if (!target) return;
    if (cred.username) setValue(findUsernameField(target), cred.username);
    setValue(target, cred.password);
  });
}

/** 提交登录表单后，询问是否保存（密码只在这一次调用里经 IPC 送到主进程加密） */
function setupPasswordSave() {
  let lastOffered = 0;
  document.addEventListener(
    'submit',
    (event) => {
      try {
        const form = event.target;
        if (!form || !form.querySelectorAll) return;
        const passwordEl = form.querySelector('input[type="password"]');
        if (!passwordEl || !passwordEl.value) return;
        if (Date.now() - lastOffered < 5000) return;
        lastOffered = Date.now();

        const usernameEl = findUsernameField(passwordEl);
        ipcRenderer
          .invoke('nyx:vault:offer-save', {
            origin: location.origin,
            username: usernameEl ? usernameEl.value : '',
            password: passwordEl.value,
          })
          .catch(() => {
            /* 用户拒绝或主进程不可用：忽略 */
          });
      } catch {
        /* 忽略 */
      }
    },
    true,
  );
}

/** 记忆并回填普通字段 */
function setupFormMemory() {
  let timer = null;

  const flush = () => {
    timer = null;
    try {
      const values = collectFormValues();
      if (Object.keys(values).length) {
        ipcRenderer.invoke('nyx:forms:save', { origin: location.origin, values }).catch(() => {});
      }
    } catch {
      /* 忽略 */
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  };

  document.addEventListener(
    'change',
    (event) => {
      const el = event.target;
      if (el && el.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) schedule();
    },
    true,
  );
  document.addEventListener('submit', schedule, true);

  setTimeout(async () => {
    try {
      const result = await ipcRenderer.invoke('nyx:forms:load', { origin: location.origin });
      if (result && result.ok && result.values) applyFormValues(result.values);
    } catch {
      /* 忽略 */
    }
  }, 600);
}

function initAutofill() {
  if (PRIVATE) return; // 隐私模式不留任何记忆
  try {
    setupFormMemory();
    setupPasswordFill();
    setupPasswordSave();
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * B. 全隐私模式：页面内防泄漏
 * ------------------------------------------------------------------ */

/** WebRTC：强制只收中继候选，本机/局域网 IP 不会出现在候选里 */
function guardWebRTC() {
  const Original = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (typeof Original !== 'function') return;

  function Patched(config, constraints) {
    const next = Object.assign({}, config || {});
    next.iceTransportPolicy = 'relay';
    return new Original(next, constraints);
  }
  Patched.prototype = Original.prototype;
  try {
    Object.setPrototypeOf(Patched, Original);
  } catch {
    /* 忽略 */
  }

  safeDefine(window, 'RTCPeerConnection', { value: maskNative(Patched, 'RTCPeerConnection'), configurable: true, writable: true });
  if (window.webkitRTCPeerConnection) {
    safeDefine(window, 'webkitRTCPeerConnection', { value: window.RTCPeerConnection, configurable: true, writable: true });
  }
  note('webrtc:relay-only');
}

/** 画布噪声：对指纹读取路径注入确定性微扰（人眼不可见，跨会话不可复现） */
function guardCanvas() {
  const canvasProto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  const ctxProto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  if (!canvasProto) return;

  const delta = 1 + Math.floor(RNG() * 3);
  const noise = [delta, -delta, delta + 1, -delta - 1];

  function perturb(imageData) {
    try {
      const data = imageData && imageData.data;
      if (!data || data.length < 64) return;
      // 固定位置、固定增量 → 幂等且会话内稳定
      const spots = [0, Math.floor(data.length / 3), Math.floor((data.length / 3) * 2), data.length - 4];
      spots.forEach((spot, index) => {
        const at = spot + (index % 3);
        if (at < data.length) {
          data[at] = (data[at] + noise[index % noise.length] + 256) % 256;
        }
      });
    } catch {
      /* 忽略 */
    }
  }

  /** 大画布才做扰动：小图标（<16px）加噪容易看出噪点 */
  function shouldPerturb(canvas) {
    try {
      return canvas.width >= 16 && canvas.height >= 16;
    } catch {
      return false;
    }
  }

  replaceMethod(
    canvasProto,
    'toDataURL',
    (original) =>
      function toDataURL(...args) {
        try {
          if (shouldPerturb(this)) perturb(this.getContext('2d').getImageData(0, 0, this.width, this.height));
        } catch {
          /* 忽略 */
        }
        return original.apply(this, args);
      },
    'toDataURL',
  );

  replaceMethod(
    canvasProto,
    'toBlob',
    (original) =>
      function toBlob(callback, ...args) {
        try {
          if (shouldPerturb(this)) perturb(this.getContext('2d').getImageData(0, 0, this.width, this.height));
        } catch {
          /* 忽略 */
        }
        return original.call(this, callback, ...args);
      },
    'toBlob',
  );

  if (ctxProto) {
    replaceMethod(
      ctxProto,
      'getImageData',
      (original) =>
        function getImageData(...args) {
          const result = original.apply(this, args);
          try {
            if (result && result.width >= 16 && result.height >= 16) perturb(result);
          } catch {
            /* 忽略 */
          }
          return result;
        },
      'getImageData',
    );
  }

  if (window.OffscreenCanvas && window.OffscreenCanvas.prototype) {
    replaceMethod(
      window.OffscreenCanvas.prototype,
      'convertToBlob',
      (original) =>
        function convertToBlob(...args) {
          try {
            if (this.width >= 16 && this.height >= 16) {
              const ctx = this.getContext('2d');
              if (ctx) perturb(ctx.getImageData(0, 0, this.width, this.height));
            }
          } catch {
            /* 忽略 */
          }
          return original.apply(this, args);
        },
      'convertToBlob',
    );
  }

  note('canvas:noise');
}

/** WebGL：显卡型号统一成一台"街机配置"，并保证扩展与取值自洽 */
function guardWebGL() {
  const FAKE_VENDOR = 'Google Inc. (Intel)';
  const FAKE_RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const UNMASKED_VENDOR = 37445;
  const UNMASKED_RENDERER = 37446;
  const VENDOR = 0x1f00;
  const RENDERER = 0x1f01;

  const targets = [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean);
  if (!targets.length) return;

  for (const ctor of targets) {
    replaceMethod(
      ctor.prototype,
      'getParameter',
      (original) =>
        function getParameter(param) {
          if (param === UNMASKED_VENDOR) return FAKE_VENDOR;
          if (param === UNMASKED_RENDERER) return FAKE_RENDERER;
          if (param === VENDOR) return 'WebKit';
          if (param === RENDERER) return 'WebKit WebGL';
          return original.call(this, param);
        },
      'getParameter',
    );
  }

  note('webgl:pin-gpu');
}

/** 音频指纹：分析器输出与离线渲染结果都加确定性微扰 */
function guardAudio() {
  const analysers = [window.AnalyserNode].filter(Boolean);
  for (const ctor of analysers) {
    replaceMethod(
      ctor.prototype,
      'getFloatFrequencyData',
      (original) =>
        function getFloatFrequencyData(array) {
          original.call(this, array);
          try {
            for (let i = 0; i < array.length; i += 97) array[i] += (RNG() - 0.5) * 1e-4;
          } catch {
            /* 忽略 */
          }
        },
      'getFloatFrequencyData',
    );
    replaceMethod(
      ctor.prototype,
      'getByteFrequencyData',
      (original) =>
        function getByteFrequencyData(array) {
          original.call(this, array);
          try {
            for (let i = 0; i < array.length; i += 89) array[i] = (array[i] + 1) % 256;
          } catch {
            /* 忽略 */
          }
        },
      'getByteFrequencyData',
    );
  }

  // 离线渲染出来的缓冲区（经典音频指纹路径）
  const offlineCtors = [window.OfflineAudioContext, window.webkitOfflineAudioContext].filter(Boolean);
  for (const ctor of offlineCtors) {
    replaceMethod(
      ctor.prototype,
      'startRendering',
      (original) =>
        function startRendering(...args) {
          const promise = original.apply(this, args);
          if (!promise || typeof promise.then !== 'function') return promise;
          return promise.then((buffer) => {
            try {
              const originalGet = buffer.getChannelData.bind(buffer);
              const cache = new Map();
              safeDefine(buffer, 'getChannelData', {
                configurable: true,
                writable: true,
                value: maskNative(
                  function getChannelData(channel) {
                    if (cache.has(channel)) return cache.get(channel);
                    const data = originalGet(channel);
                    const scale = 1e-7;
                    for (let i = 0; i < data.length; i += 1000) {
                      data[i] += (RNG() - 0.5) * scale;
                    }
                    cache.set(channel, data);
                    return data;
                  },
                  'getChannelData',
                ),
              });
            } catch {
              /* 忽略 */
            }
            return buffer;
          });
        },
      'startRendering',
    );
  }

  note('audio:noise');
}

/** 字体指纹：非通用字体且非页面自带字体时，文本测量结果加微扰 */
function guardFonts() {
  const ctxProto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|-apple-system|blinkmacsystemfont|inherit|initial|unset)$/i;

  /** 页面自己通过 CSS 加载的字体不打扰（这些测量是正常排版需要） */
  function isPageFont(family) {
    try {
      const fonts = document.fonts;
      if (!fonts || typeof fonts.check !== 'function') return false;
      return fonts.check(`12px "${family}"`);
    } catch {
      return false;
    }
  }

  function familiesOf(fontShorthand) {
    const text = String(fontShorthand || '');
    const parts = text.split(',');
    if (parts.length < 1) return [];
    const first = parts[0].replace(/^[^ ]*\s+/, '');
    const list = [first, ...parts.slice(1)];
    return list
      .map((item) => item.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  if (ctxProto) {
    replaceMethod(
      ctxProto,
      'measureText',
      (original) =>
        function measureText(text) {
          const metrics = original.call(this, text);
          try {
            const families = familiesOf(this.font);
            const risky = families.filter((family) => !GENERIC.test(family) && !isPageFont(family));
            if (!risky.length) return metrics;
            const drift = (RNG() - 0.5) * 0.8;
            const copy = Object.create(Object.getPrototypeOf(metrics));
            for (const key of ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline']) {
              const value = metrics[key];
              if (typeof value === 'number') copy[key] = key === 'width' ? value + drift : value;
            }
            return copy;
          } catch {
            return metrics;
          }
        },
      'measureText',
    );
  }

  // 字体枚举接口：非页面字体的 check() 一律报"没有这个字体"
  try {
    const fontSet = document.fonts;
    if (fontSet && typeof fontSet.check === 'function') {
      const originalCheck = fontSet.check.bind(fontSet);
      safeDefine(fontSet, 'check', {
        configurable: true,
        writable: true,
        value: maskNative(
          function check(font, text) {
            const families = familiesOf(String(font || '').replace(/^[^ ]*\s+/, ''));
            const risky = families.filter((family) => !GENERIC.test(family));
            if (risky.length && !risky.some((family) => originalCheck(`12px "${family}"`, text))) return false;
            return originalCheck(font, text);
          },
          'check',
        ),
      });
    }
  } catch {
    /* 忽略 */
  }

  note('fonts:noise');
}

/** 时区：与代理出口对齐（getTimezoneOffset / Intl / toLocale* / toString 全覆盖） */
function guardTimezone() {
  if (!CONFIG.tz || CONFIG.tzOffset === null || Number.isNaN(CONFIG.tzOffset)) return;

  const timeZone = CONFIG.tz;
  const offset = Number(CONFIG.tzOffset);

  safeDefine(Date.prototype, 'getTimezoneOffset', {
    configurable: true,
    writable: true,
    value: maskNative(function getTimezoneOffset() {
      return offset;
    }, 'getTimezoneOffset'),
  });

  const OriginalDateTimeFormat = Intl.DateTimeFormat;

  function PatchedDateTimeFormat(locales, options) {
    const next = Object.assign({}, options || {});
    if (!next.timeZone) next.timeZone = timeZone;
    return new OriginalDateTimeFormat(locales, next);
  }
  PatchedDateTimeFormat.prototype = OriginalDateTimeFormat.prototype;
  try {
    Object.setPrototypeOf(PatchedDateTimeFormat, OriginalDateTimeFormat);
  } catch {
    /* 忽略 */
  }
  try {
    Intl.DateTimeFormat = maskNative(PatchedDateTimeFormat, 'DateTimeFormat');
  } catch {
    /* 忽略 */
  }

  const RESOLVED = { timeZone, locale: (CONFIG.languages && CONFIG.languages[0]) || 'en-US', calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23' };
  try {
    const dateFormat = new OriginalDateTimeFormat('en-US', { timeZone });
    const partsCache = new OriginalDateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const longName = new OriginalDateTimeFormat('en-US', { timeZone, timeZoneName: 'long' });

    function zoneParts(date) {
      const map = {};
      for (const part of partsCache.formatToParts(date)) map[part.type] = part.value;
      return map;
    }

    function offsetText(date) {
      const minutes = -timezoneOffsetOf(date, dateFormat, timeZone);
      const sign = minutes >= 0 ? '+' : '-';
      const abs = Math.abs(minutes);
      const hh = String(Math.floor(abs / 60)).padStart(2, '0');
      const mm = String(abs % 60).padStart(2, '0');
      return `GMT${sign}${hh}${mm}`;
    }

    function timezoneName(date) {
      try {
        const found = longName.formatToParts(date).find((part) => part.type === 'timeZoneName');
        return found ? found.value : 'Local Time';
      } catch {
        return 'Local Time';
      }
    }

    safeDefine(Date.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: maskNative(function toString() {
        try {
          const parts = zoneParts(new Date(this.getTime()));
          const tz = offsetText(this);
          const hour = parts.hour === '24' ? '00' : parts.hour;
          return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year} ${hour}:${parts.minute}:${parts.second} ${tz} (${timezoneName(this)})`;
        } catch {
          return 'Invalid Date';
        }
      }, 'toString'),
    });

    safeDefine(Date.prototype, 'toTimeString', {
      configurable: true,
      writable: true,
      value: maskNative(function toTimeString() {
        try {
          const parts = zoneParts(new Date(this.getTime()));
          const hour = parts.hour === '24' ? '00' : parts.hour;
          return `${hour}:${parts.minute}:${parts.second} ${offsetText(this)} (${timezoneName(this)})`;
        } catch {
          return 'Invalid Date';
        }
      }, 'toTimeString'),
    });

    for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      replaceMethod(
        Date.prototype,
        name,
        (original) =>
          function patchedLocale(...args) {
            try {
              const locales = args[0];
              const options = Object.assign({}, args[1] || {});
              if (!options.timeZone) options.timeZone = timeZone;
              return original.call(this, locales, options);
            } catch {
              return original.apply(this, args);
            }
          },
        name,
      );
    }
  } catch {
    /* 局部失败时至少 getTimezoneOffset 与 Intl 已对齐 */
  }

  // 让 resolvedOptions() 也报对齐后的时区
  try {
    const originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = maskNative(
      function resolvedOptions() {
        const result = originalResolved.call(this);
        try {
          if (!result.timeZone || result.timeZone === 'UTC' || result.timeZone) {
            return Object.assign({}, result, { timeZone, locale: result.locale || RESOLVED.locale });
          }
        } catch {
          /* 忽略 */
        }
        return result;
      },
      'resolvedOptions',
    );
  } catch {
    /* 忽略 */
  }

  note(`timezone:${timeZone}(${offset})`);
}

/** 计算指定时刻的时区偏移（与主进程 timezoneOffsetMinutes 同算法，页面内自洽） */
function timezoneOffsetOf(date, dateFormat, timeZone) {
  try {
    const map = {};
    for (const part of dateFormat.formatToParts(date)) map[part.type] = part.value;
    const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour === '24' ? '0' : map.hour), Number(map.minute), Number(map.second));
    return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  } catch {
    return CONFIG.tzOffset || 0;
  }
}

/** 屏幕与设备信息：量化成常见档位，抹掉本机分辨率特征 */
function guardScreen() {
  const screenRef = window.screen;
  if (!screenRef) return;

  const quantize = (value) => Math.max(100, Math.round(Number(value || 0) / 100) * 100);
  const width = quantize(screenRef.width);
  const height = quantize(screenRef.height);

  if (window.Screen && window.Screen.prototype) {
    const proto = window.Screen.prototype;
    safeDefine(proto, 'width', { configurable: true, get: maskNative(() => width, 'width') });
    safeDefine(proto, 'height', { configurable: true, get: maskNative(() => height, 'height') });
    safeDefine(proto, 'availWidth', { configurable: true, get: maskNative(() => width, 'availWidth') });
    safeDefine(proto, 'availHeight', { configurable: true, get: maskNative(() => Math.max(100, height - 40), 'availHeight') });
    safeDefine(proto, 'availLeft', { configurable: true, get: maskNative(() => 0, 'availLeft') });
    safeDefine(proto, 'availTop', { configurable: true, get: maskNative(() => 0, 'availTop') });
    safeDefine(proto, 'colorDepth', { configurable: true, get: maskNative(() => 24, 'colorDepth') });
    safeDefine(proto, 'pixelDepth', { configurable: true, get: maskNative(() => 24, 'pixelDepth') });
  }

  safeDefine(window, 'devicePixelRatio', { configurable: true, get: maskNative(() => 1, 'devicePixelRatio') });
  try {
    if (screenRef.orientation) {
      safeDefine(Object.getPrototypeOf(screenRef.orientation), 'type', {
        configurable: true,
        get: maskNative(() => (window.innerWidth >= window.innerHeight ? 'landscape-primary' : 'portrait-primary'), 'type'),
      });
    }
  } catch {
    /* 忽略 */
  }

  note(`screen:${width}x${height}@1x`);
}

/** 媒体设备枚举 / 位置 / 电池 / 语音 / 游戏手柄：一律去特征 */
function guardDeviceSurfaces() {
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices) {
    safeDefine(mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: maskNative(async function enumerateDevices() {
        return [];
      }, 'enumerateDevices'),
    });

    const deny = (name) =>
      safeDefine(mediaDevices, name, {
        configurable: true,
        value: maskNative(
          async function denied() {
            throw new DOMException('Permission denied', 'NotAllowedError');
          },
          name,
        ),
      });
    deny('getUserMedia');
    deny('getDisplayMedia');
  }

  if (navigator.geolocation) {
    const error = { code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
    safeDefine(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      value: maskNative(function getCurrentPosition(_success, failure) {
        if (typeof failure === 'function') failure(error);
      }, 'getCurrentPosition'),
    });
    safeDefine(navigator.geolocation, 'watchPosition', {
      configurable: true,
      value: maskNative(function watchPosition(_success, failure) {
        if (typeof failure === 'function') failure(error);
        return 0;
      }, 'watchPosition'),
    });
  }

  if (navigator.getGamepads) {
    safeDefine(navigator, 'getGamepads', { configurable: true, value: maskNative(() => [], 'getGamepads') });
  }

  if (typeof navigator.getBattery === 'function') {
    safeDefine(navigator, 'getBattery', {
      configurable: true,
      value: maskNative(async function getBattery() {
        return { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null };
      }, 'getBattery'),
    });
  }

  if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function') {
    try {
      safeDefine(window.speechSynthesis, 'getVoices', { configurable: true, value: maskNative(() => [], 'getVoices') });
    } catch {
      /* 忽略 */
    }
  }

  if (navigator.connection) {
    try {
      const fake = { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, type: 'wifi', onchange: null, addEventListener: () => {}, removeEventListener: () => {} };
      safeDefine(navigator, 'connection', { configurable: true, get: maskNative(() => fake, 'connection') });
    } catch {
      /* 忽略 */
    }
  }

  // WebGPU 会直接报出真实显卡，与上面钉死的 WebGL 型号矛盾，隐私模式整个收起
  if (navigator.gpu) {
    try {
      safeDefine(navigator, 'gpu', { configurable: true, get: maskNative(() => undefined, 'gpu') });
    } catch {
      /* 忽略 */
    }
  }

  note('devices:minimal');
}

/** 硬件并发 / 内存 / 触摸点：常见档位 */
function guardHardware() {
  safeDefine(navigator, 'hardwareConcurrency', { configurable: true, get: maskNative(() => 4, 'hardwareConcurrency') });
  if ('deviceMemory' in navigator) {
    safeDefine(navigator, 'deviceMemory', { configurable: true, get: maskNative(() => 8, 'deviceMemory') });
  }
  safeDefine(navigator, 'maxTouchPoints', { configurable: true, get: maskNative(() => 0, 'maxTouchPoints') });
  note('hardware:4c/8g');
}

/** 语言与 UA：与主进程下发的 profile 完全一致 */
function guardIdentity() {
  if (CONFIG.languages && CONFIG.languages.length) {
    safeDefine(navigator, 'languages', { configurable: true, get: maskNative(() => CONFIG.languages.slice(), 'languages') });
    safeDefine(navigator, 'language', { configurable: true, get: maskNative(() => CONFIG.languages[0], 'language') });
  }

  if (CONFIG.ua) {
    safeDefine(navigator, 'userAgent', { configurable: true, get: maskNative(() => CONFIG.ua, 'userAgent') });
    safeDefine(navigator, 'appVersion', {
      configurable: true,
      get: maskNative(() => String(CONFIG.ua).replace(/^Mozilla\//, ''), 'appVersion'),
    });
  }

  // 客户端提示（UA-CH）：必须和 UA 字符串讲同一套话，否则一眼矛盾
  if (navigator.userAgentData || CONFIG.chrome) {
    const major = CONFIG.chrome || '120';
    const data = {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not-A.Brand', version: '24' },
      ],
      mobile: false,
      platform: CONFIG.platform || 'Windows',
      getHighEntropyValues: maskNative(
        async function getHighEntropyValues(hints) {
          const full = {
            architecture: 'x86',
            bitness: '64',
            brands: data.brands,
            fullVersionList: [
              { brand: 'Chromium', version: `${major}.0.0.0` },
              { brand: 'Google Chrome', version: `${major}.0.0.0` },
              { brand: 'Not-A.Brand', version: '24.0.0.0' },
            ],
            mobile: false,
            model: '',
            platform: data.platform,
            platformVersion: CONFIG.platform === 'Windows' ? '10.0.0' : '15.0.0',
            uaFullVersion: `${major}.0.0.0`,
            wow64: false,
          };
          if (!Array.isArray(hints) || !hints.length) return full;
          const picked = {};
          for (const hint of hints) if (hint in full) picked[hint] = full[hint];
          return picked;
        },
        'getHighEntropyValues',
      ),
      toJSON: maskNative(() => ({ brands: data.brands, mobile: false, platform: data.platform }), 'toJSON'),
    };
    try {
      safeDefine(navigator, 'userAgentData', { configurable: true, get: maskNative(() => data, 'userAgentData') });
    } catch {
      /* 忽略 */
    }
  }

  note(`identity:${CONFIG.languages[0] || 'default'}`);
}

/** Electron 特征清理：process / require / chrome 对象 / webdriver */
function guardElectronTraces() {
  for (const key of ['process', 'require', 'module', 'global', 'Buffer', '__dirname', '__filename']) {
    try {
      if (key in window) {
        delete window[key];
        if (key in window) safeDefine(window, key, { configurable: true, get: maskNative(() => undefined, key) });
      }
    } catch {
      /* 忽略 */
    }
  }

  try {
    safeDefine(navigator, 'webdriver', { configurable: true, get: maskNative(() => false, 'webdriver') });
  } catch {
    /* 忽略 */
  }

  // Electron 默认没有 window.chrome，这个"没有"本身就是特征，补一个与 Chrome 同形的壳
  if (!window.chrome) {
    const chrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      },
      csi: maskNative(() => ({}), 'csi'),
      loadTimes: maskNative(() => ({}), 'loadTimes'),
    };
    try {
      safeDefine(window, 'chrome', { configurable: true, value: chrome, writable: true });
    } catch {
      /* 忽略 */
    }
  }

  note('electron-traces:cleaned');
}

/** 按 profile 逐项加固；任何一项失败都不影响其它项 */
function applyPrivacyHardening() {
  const steps = [
    ['WebRTC', guardWebRTC],
    ['Canvas', guardCanvas],
    ['WebGL', guardWebGL],
    ['音频', guardAudio],
    ['字体', guardFonts],
    ['时区', guardTimezone],
    ['屏幕', guardScreen],
    ['设备', guardDeviceSurfaces],
    ['硬件', guardHardware],
    ['身份', guardIdentity],
    ['Electron 特征', guardElectronTraces],
  ];

  const failed = [];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (err) {
      failed.push(`${name}: ${err && err.message ? err.message : '未知错误'}`);
    }
  }
  return failed;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(function bootstrap() {
  const failures = [];

  if (PRIVATE) {
    try {
      failures.push(...applyPrivacyHardening());
    } catch (err) {
      failures.push(`整体失败：${err.message}`);
    }
  }

  // 验收探针只在本机自检（主进程 NYX_VERIFY=1）时暴露给页面世界。
  //
  // 为什么不常开：exposeInMainWorld 是"挂到页面主世界"，常开等于给每个站点
  // 多出一个普通 Chrome 没有的全局对象（Object.keys(window) 直接就能看到），
  // 它本身就是可被检测的指纹——加固模块自己制造指纹是自相矛盾的。
  // 开启时也只暴露"加固条目清单 + 伪装口径回显"，不含任何凭据、密钥或真实设备信息。
  if (CONFIG.verify === true) {
    try {
      contextBridge.exposeInMainWorld('__nyxHardening', {
        mode: CONFIG.mode,
        applied: APPLIED.slice(),
        failures,
        report: {
          userAgent: PRIVATE ? CONFIG.ua : navigator.userAgent,
          languages: PRIVATE ? CONFIG.languages : navigator.languages,
          timezone: PRIVATE ? CONFIG.tz : '',
          seed: PRIVATE ? CONFIG.seed.slice(0, 4) : '',
        },
      });
    } catch {
      /* 暴露失败不影响页面 */
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAutofill, { once: true });
  } else {
    initAutofill();
  }
})();
