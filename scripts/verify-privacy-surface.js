/**
 * 隐私指纹面回归（安全审计 P0-3）—— 纯 Node，不启动 Electron。
 *
 * 为什么这样测：审计的问题是「补丁写在隔离世界，页面主世界看不见」。
 * 只做静态 grep 证明不了"真的生效"，所以这里**把生成的脚本放进一个假页面世界真的跑一遍**
 * （vm 新建一个 realm，里面造出 navigator/Date/Intl/Canvas/WebGL/Audio），然后读回来核对：
 * UA、平台、语言、硬件并发、时区、Canvas 噪声、WebGL 型号、幂等性。
 *
 * 剩下几条是接线与红线守卫：主进程必须真的 `setUserAgent` + CDP 注入（不是只写注释），
 * 失败必须给用户看得见的提示，生成的脚本里不许出现 Electron / Nyx 的真实标识。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const surface = require('../src/core/privacy-surface');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? `：${detail}` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PROFILE = {
  seed: 'seed-abc',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  platform: 'Win32',
  languages: ['en-US', 'en'],
  timezone: 'America/New_York',
  timezoneOffset: 300,
  hardwareConcurrency: 12,
  deviceMemory: 16,
};

/**
 * 一个"页面世界"的前置代码：真实浏览器里这些东西都在主世界。
 * 写在 vm 里而不是从外部注入，是为了拿到**独立的内建对象**
 * （否则补丁会改到测试进程自己的 Date/Function.prototype 上）。
 */
const PAGE_PREAMBLE = `
globalThis.window = globalThis;
class Navigator {}
Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => 'Nyx/1.17.9 Electron/45.3.2 Chrome/150', configurable: true });
Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32-real', configurable: true });
Object.defineProperty(Navigator.prototype, 'language', { get: () => 'zh-CN', configurable: true });
Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 32, configurable: true });
globalThis.Navigator = Navigator;
globalThis.navigator = new Navigator();

class CanvasRenderingContext2D {
  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(Math.max(4, w * h * 4));
    data.fill(100);
    return { data };
  }
  putImageData() {}
}
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.makeCtx = () => new CanvasRenderingContext2D();

class HTMLCanvasElement {
  constructor() { this.width = 2; this.height = 2; }
  getContext() { return new CanvasRenderingContext2D(); }
  toDataURL() { return 'data:image/png;base64,AAAA'; }
}
globalThis.HTMLCanvasElement = HTMLCanvasElement;

class WebGLRenderingContext {
  getParameter(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    if (param === 37446) return 'ANGLE (NVIDIA GeForce RTX 4070)';
    return 'real';
  }
}
globalThis.WebGLRenderingContext = WebGLRenderingContext;

class AnalyserNode {
  getFloatFrequencyData(array) { array.fill(0); }
}
globalThis.AnalyserNode = AnalyserNode;
`;

/** 新建一个假页面世界，跑前置代码 + 加固脚本，返回读取器 */
function makePageWorld(source) {
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(PAGE_PREAMBLE, context, { timeout: 5000 });
  vm.runInContext(source, context, { timeout: 5000 });
  return {
    eval(code) {
      return vm.runInContext(code, context, { timeout: 5000 });
    },
  };
}

const script = surface.buildHardeningScript(PROFILE);

/* ① 脚本本身：能编译、不含真实标识 */
let compiles = true;
try {
  new vm.Script(script);
} catch {
  compiles = false;
}
check('生成的加固脚本可以编译（不是一段看着像代码的字符串）', compiles);
check('脚本不含 Electron / Nyx 的真实标识（否则等于自报家门）', !/Electron|Nyx\//.test(script));
check('脚本里没有发起网络请求的能力（只改本地对象，不外传）', !/fetch\s*\(|XMLHttpRequest|WebSocket/.test(script));

/* ② 真的在主世界跑一遍 */
const world = makePageWorld(script);
check('跑完之后 navigator.userAgent 是伪装值（不再是 Electron）', world.eval('navigator.userAgent') === PROFILE.ua, world.eval('navigator.userAgent'));
check('navigator.platform 跟着改成伪装值', world.eval('navigator.platform') === 'Win32', world.eval('navigator.platform'));
check(
  'navigator.language / languages 与请求头同源',
  world.eval('navigator.language') === 'en-US' && world.eval('navigator.languages.join(",")') === 'en-US,en',
  `${world.eval('navigator.language')} / ${world.eval('navigator.languages.join(",")')}`,
);
check('languages 是冻结数组（页面改不动）', world.eval('Object.isFrozen(navigator.languages)') === true);
check('hardwareConcurrency 不再是本机的真值', world.eval('navigator.hardwareConcurrency') === 12, String(world.eval('navigator.hardwareConcurrency')));
check('navigator.webdriver 固定 false（不给自动化留信号）', world.eval('navigator.webdriver') === false);

/* ③ 时区：Date 与 Intl 必须一起改，否则两边一对就露馅 */
check('Date.getTimezoneOffset 跟出口时区一致', world.eval('new Date().getTimezoneOffset()') === 300, String(world.eval('new Date().getTimezoneOffset()')));
check(
  'Intl.DateTimeFormat.resolvedOptions().timeZone 也被改成出口时区',
  world.eval('new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().timeZone') === 'America/New_York',
  world.eval('new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().timeZone'),
);

/* ④ Canvas / WebGL：噪声确定（同会话稳定），不同种子不同 */
const canvasNoise = (src) => makePageWorld(src).eval('Array.from(makeCtx().getImageData(0, 0, 2, 2).data).join(",")');
const noise1 = canvasNoise(surface.buildHardeningScript(PROFILE));
const noise2 = canvasNoise(surface.buildHardeningScript(PROFILE));
const noise3 = canvasNoise(surface.buildHardeningScript(Object.assign({}, PROFILE, { seed: 'other-seed' })));
check('Canvas 读回值被加了噪声（不等于原始的 100）', !/^(100,)+100$/.test(noise1), noise1.slice(0, 40));
check('同一会话两次读到的噪声完全一致（"每次都变"才是更强的指纹）', noise1 === noise2);
check('换一个会话种子 → 噪声不同', noise1 !== noise3);
const gl = makePageWorld(script).eval('(params) => WebGLRenderingContext.prototype.getParameter(params)');
check('WebGL vendor/renderer 不再是真实型号', gl(37445).includes('Google Inc') && gl(37446).includes('ANGLE'), `${gl(37445)} / ${gl(37446)}`);

/* ⑤ 幂等：跑两次不会重复包一层 */
const twice = makePageWorld(`${script}\n${script}`);
check('脚本跑两次仍然只有一层补丁（window.__nyxSurface 版本守卫）', twice.eval('window.__nyxSurface') === surface.SURFACE_SCRIPT_VERSION);

/* ⑥ CDP 命令：顺序、参数、内容 */
const steps = surface.buildCdpSteps(PROFILE);
const methods = steps.map((item) => item.method);
check(
  'CDP 四步齐全且顺序正确（UA → 时区 → 语言 → 注入脚本）',
  methods.join(',') ===
    'Emulation.setUserAgentOverride,Emulation.setTimezoneOverride,Emulation.setLocaleOverride,Page.addScriptToEvaluateOnNewDocument',
  methods.join(','),
);
check('UA 覆盖带 acceptLanguage 与 platform（只改 UA 字符串不够）', steps[0].params.acceptLanguage === 'en-US,en' && steps[0].params.platform === 'Win32');
check('注入的脚本就是同一条加固脚本（不是另一个空壳）', steps[3].params.source === script);
const noTz = surface.buildCdpSteps(Object.assign({}, PROFILE, { timezone: '', timezoneOffset: null }));
check('出口时区未知时不谎报时区（不发 setTimezoneOverride）', !noTz.some((s) => s.method === 'Emulation.setTimezoneOverride'));

/* ⑦ 模式与失败文案 */
check('只有隐私模式才装配指纹面', surface.shouldAttachSurface('private') === true && surface.shouldAttachSurface('normal') === false);
const f1 = surface.describeSurfaceFailure('setUserAgent', new Error('炸了'));
const f2 = surface.describeSurfaceFailure('attach', new Error('炸了'));
check(
  '失败文案分环节说清后果（UA / 注入两种都提"关掉这一页重新打开"）',
  /UA/.test(f1) && /指纹/.test(f2) && /重新打开/.test(f1) && /重新打开/.test(f2),
);

/* ⑧ 接线守卫：主进程必须真的做了这三件事 */
const main = read('src/main.js');
check('主进程引入了 privacy-surface 模块', /require\('\.\/core\/privacy-surface'\)/.test(main));
check(
  '标签创建回调里调用 attachPrivacySurface，且在历史记录之前（loadURL 之前就装配）',
  /attachPrivacySurface\(tab\);[\s\S]{0,120}hookHistoryRecording\(tab\);/.test(main),
);
check('真的调了 wc.setUserAgent（不是只写注释）', /wc\.setUserAgent\(profile\.ua, profile\.acceptLanguage\);/.test(main));
check(
  '真的 attach debugger 并逐条发送 CDP 命令',
  /wc\.debugger\.isAttached\(\)[\s\S]{0,80}wc\.debugger\.attach\('1\.3'\)/.test(main) &&
    /for \(const step of buildCdpSteps\(profile\)\)/.test(main),
);
check(
  '任何一层失败都可见：前台提示 + 诊断 + 标签标记',
  /diagnostics\.error\('PRIVACY_SURFACE_FAILED'/.test(main) &&
    /notifyNotice\(\{ level: 'error', code: 'PRIVACY_SURFACE_FAILED'/.test(main) &&
    /tab\.privacyIncomplete = true;/.test(main),
);
check('隐私模式没有 profile 时明确拒绝装配（不假装成功）', /隐私模式没有可用的指纹画像/.test(main));

console.log('');
console.log(`隐私指纹面回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 隐私指纹面回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 隐私指纹面回归通过');
}
