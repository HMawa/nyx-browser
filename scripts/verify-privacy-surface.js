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
  // 两个"平台"是两个东西：UA-CH 用 Windows，navigator.platform 用 Win32。
  platform: 'Windows',
  navigatorPlatform: 'Win32',
  chromeVersion: '156.0.8078.100',
  platformVersion: '19.0.0',
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
  putImageData() {
    globalThis.__putCalls = (globalThis.__putCalls || 0) + 1;
    globalThis.__putTargets = (globalThis.__putTargets || []).concat([this]);
  }
}
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
globalThis.__putCalls = 0;
// 打补丁之前先留一份"原样读取"的通道，用来核对页面画布有没有被偷偷改过
globalThis.__origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
globalThis.__rawPixels = () => Array.from(globalThis.__origGetImageData.call(new CanvasRenderingContext2D(), 0, 0, 2, 2).data);
globalThis.makeCtx = () => new CanvasRenderingContext2D();

class HTMLCanvasElement {
  constructor() { this.width = 2; this.height = 2; this._ctx = new CanvasRenderingContext2D(); }
  getContext() { return this._ctx; }
  toDataURL() { return 'data:image/png;base64,AAAA'; }
}
globalThis.HTMLCanvasElement = HTMLCanvasElement;
globalThis.document = { createElement: () => new HTMLCanvasElement() };

class WebGLRenderingContext {
  getParameter(param) {
    if (param === 37445) return 'Google Inc. (NVIDIA)';
    if (param === 37446) return 'ANGLE (NVIDIA GeForce RTX 4070)';
    return 'real';
  }
  // 真实驱动会报一串带厂商私有名的扩展：这里故意混一个私有的，用来验证补丁会把它挡掉
  getSupportedExtensions() {
    return ['WEBGL_debug_renderer_info', 'OES_standard_derivatives', 'EXT_nvidia_private_thing'];
  }
  getExtension(name) {
    if (name === 'EXT_nvidia_private_thing') return { private: true };
    return { name };
  }
}
globalThis.WebGLRenderingContext = WebGLRenderingContext;

// measureText：真实环境报的是带小数的精确宽度（12.34），补丁应把它对齐到 0.5px 网格
globalThis.TextMetrics = class TextMetrics {};
CanvasRenderingContext2D.prototype.measureText = function measureText() {
  return { width: 12.34, actualBoundingBoxAscent: 8 };
};

// WebGPU：适配器信息也是一张显卡指纹。
// 这里用一个"同步 thenable"代替真 Promise，好在纯同步的校验脚本里看结果
// （补丁本身照旧走 .then 链，形态没被改动）。
globalThis.navigator.gpu = {
  requestAdapter() {
    const adapter = { info: { vendor: 'nvidia', architecture: 'ampere' } };
    return {
      then(onFulfilled) {
        return onFulfilled(adapter);
      },
    };
  },
};

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

/* ④b 同一个页面里两次读 / 一次导出：真 Chrome 是确定的，而且导出不能改动画布 */
const canvasWorld = makePageWorld(surface.buildHardeningScript(PROFILE));
const readA = canvasWorld.eval('Array.from(makeCtx().getImageData(0, 0, 2, 2).data).join(",")');
const readB = canvasWorld.eval('Array.from(makeCtx().getImageData(0, 0, 2, 2).data).join(",")');
check('同一个页面里连读两次，结果完全一样（否则"两次不一致"本身就是指纹）', readA === readB, `${readA.slice(0, 24)} / ${readB.slice(0, 24)}`);
canvasWorld.eval('globalThis.pageCanvas = new HTMLCanvasElement(); pageCanvas.toDataURL()');
check(
  '导出图片只写在自己造的副本上，页面画布那一份一次都没被写过',
  canvasWorld.eval('(__putTargets || []).every((t) => t !== pageCanvas.getContext("2d"))') === true,
  String(canvasWorld.eval('__putCalls')),
);
check(
  '导出之后原画布像素仍是原值（页面自己再读不会发现被改过）',
  canvasWorld.eval('__rawPixels().every((v) => v === 100)') === true,
);
const gl = makePageWorld(script).eval('(params) => WebGLRenderingContext.prototype.getParameter(params)');
check('WebGL vendor/renderer 不再是真实型号', gl(37445).includes('Google Inc') && gl(37446).includes('ANGLE'), `${gl(37445)} / ${gl(37446)}`);

/* ④-2 显卡与字体：统一上报值，而不是"如实声明不防"（用户口径：模拟一个正常浏览器） */
const glWorld = makePageWorld(script);
const glExtensions = glWorld.eval('WebGLRenderingContext.prototype.getSupportedExtensions.call(new WebGLRenderingContext())');
check(
  'WebGL 扩展列表只剩标准那几个（私有扩展会被挡掉）',
  Array.isArray(glExtensions) &&
    glExtensions.indexOf('EXT_nvidia_private_thing') < 0 &&
    glExtensions.indexOf('WEBGL_debug_renderer_info') >= 0 &&
    glExtensions.indexOf('OES_standard_derivatives') >= 0,
  glExtensions,
);
check(
  'WebGL 里问私有扩展会拿到 null（不承认自己有）',
  glWorld.eval("WebGLRenderingContext.prototype.getExtension.call(new WebGLRenderingContext(), 'EXT_nvidia_private_thing')") === null,
);
check(
  '字体度量对齐到 0.5px 网格（12.34 → 12.5）',
  glWorld.eval('CanvasRenderingContext2D.prototype.measureText.call(new CanvasRenderingContext2D(), "abc").width') === 12.5,
  glWorld.eval('CanvasRenderingContext2D.prototype.measureText.call(new CanvasRenderingContext2D(), "abc").width'),
);
const gpuVendor = makePageWorld(script).eval(`(() => {
  const adapter = navigator.gpu.requestAdapter();
  return adapter && adapter.info ? adapter.info.vendor + '/' + adapter.info.architecture : '';
})()`);
check('WebGPU 适配器信息与 WebGL 报同一块卡（不再是真实厂商）', String(gpuVendor).startsWith('intel/'), gpuVendor);

/* ⑤ 幂等：跑两次不会重复包一层 */
const twice = makePageWorld(`${script}\n${script}`);
check('脚本跑两次仍然只有一层补丁（window.__nyxSurface 版本守卫）', twice.eval('window.__nyxSurface') === surface.SURFACE_SCRIPT_VERSION);

/* ⑥ CDP 命令：顺序、参数、内容 */
const steps = surface.buildCdpSteps(PROFILE);
const methods = steps.map((item) => item.method);
check(
  'CDP 五步齐全且顺序正确（先 Page.enable，再 UA → 时区 → 语言 → 注入脚本）',
  methods.join(',') ===
    'Page.enable,Emulation.setUserAgentOverride,Emulation.setTimezoneOverride,Emulation.setLocaleOverride,Page.addScriptToEvaluateOnNewDocument',
  methods.join(','),
);
check(
  '第一条必须是 Page.enable（没有它注入脚本"成功返回但从不执行"，指纹一条都不生效）',
  methods[0] === 'Page.enable',
);
const uaStep = steps.find((item) => item.method === 'Emulation.setUserAgentOverride');
check('UA 覆盖带 acceptLanguage 与 platform（只改 UA 字符串不够）', uaStep.params.acceptLanguage === 'en-US,en' && uaStep.params.platform === 'Win32');
check(
  'UA 覆盖带 userAgentMetadata（否则 userAgentData 是空的，比不伪装更显眼）',
  Boolean(uaStep.params.userAgentMetadata)
    && Array.isArray(uaStep.params.userAgentMetadata.brands)
    && uaStep.params.userAgentMetadata.brands.length >= 2
    && uaStep.params.userAgentMetadata.platform === 'Windows'
    && uaStep.params.userAgentMetadata.brands.some((b) => b.version === '156'),
  JSON.stringify(uaStep.params.userAgentMetadata && uaStep.params.userAgentMetadata.brands),
);
check(
  '两个"平台"分开：UA-CH 报 Windows、navigator.platform 报 Win32（同时报 Wind32 那种写法会自相矛盾）',
  uaStep.params.userAgentMetadata.platform === 'Windows'
    && uaStep.params.platform === 'Win32'
    && world.eval('navigator.platform') === 'Win32',
  `${uaStep.params.userAgentMetadata.platform} / ${uaStep.params.platform} / ${world.eval('navigator.platform')}`,
);
check(
  'fullVersionList 用完整版本号，与 uaFullVersion 同源（都写 <主版本>.0.0.0 会自相矛盾）',
  uaStep.params.userAgentMetadata.fullVersionList.every((b) => /^99\.|^156\.0\.8078\.100$/.test(b.version))
    && uaStep.params.userAgentMetadata.fullVersionList.some((b) => b.version === '156.0.8078.100'),
  JSON.stringify(uaStep.params.userAgentMetadata.fullVersionList),
);
check(
  'platformVersion 读得出真实系统版本才写，读不出就不传（猜错的值反而对不上）',
  uaStep.params.userAgentMetadata.platformVersion === '19.0.0'
    && !('platformVersion' in surface.buildCdpSteps(Object.assign({}, PROFILE, { platformVersion: '' }))
      .find((item) => item.method === 'Emulation.setUserAgentOverride').params.userAgentMetadata),
);
check(
  '页面里读到的 languages 不含 ;q=（真 Chrome 的 navigator.languages 没有 q 值）',
  world.eval('navigator.languages.join(",")').indexOf(';q=') < 0,
  world.eval('navigator.languages.join(",")'),
);
const injectStep = steps.find((item) => item.method === 'Page.addScriptToEvaluateOnNewDocument');
check('注入的脚本就是同一条加固脚本（不是另一个空壳）', injectStep.params.source === script);const noTz = surface.buildCdpSteps(Object.assign({}, PROFILE, { timezone: '', timezoneOffset: null }));
check('出口时区未知时不谎报时区（不发 setTimezoneOverride）', !noTz.some((s) => s.method === 'Emulation.setTimezoneOverride'));

/* ⑥.5 画像字段的自相矛盾（对抗测试报告 P1 那三条） */
const hardening = require(path.join(ROOT, 'src/core/privacy-hardening.js'));
check(
  'Accept-Language 解析：去掉 q 值、按大小写去重、顺序不变（请求头仍用原始串）',
  JSON.stringify(hardening.parseAcceptLanguage('zh-HK,zh;q=0.9,en;q=0.8')) === JSON.stringify(['zh-HK', 'zh', 'en'])
    && JSON.stringify(hardening.parseAcceptLanguage('en-US, en-US , en-US;q=0.7')) === JSON.stringify(['en-US'])
    && JSON.stringify(hardening.parseAcceptLanguage('')) === JSON.stringify(['en-US', 'en']),
  JSON.stringify(hardening.parseAcceptLanguage('zh-HK,zh;q=0.9,en;q=0.8')),
);
check(
  'navigatorPlatform 与 UA-CH platform 是两个值，Windows 版本号能映射成 UA-CH 的写法',
  hardening.navigatorPlatform() === 'Win32'
    && hardening.platformName() === 'Windows'
    && hardening.windowsPlatformVersion('10.0.26100') === '19.0.0'
    && hardening.windowsPlatformVersion('10.0.22631') === '15.0.0'
    && hardening.windowsPlatformVersion('10.0.19045') === '10.0.0'
    && hardening.windowsPlatformVersion('6.1.7601') === '',
  `${hardening.navigatorPlatform()} / ${hardening.currentPlatformVersion()}`,
);

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

/* ⑨ 对抗测试 N1 的现场教训：CDP 命令"全部成功、页面里一条都没生效" */
check(
  '文档就绪后补打一次，并当场核对 window.__nyxSurface（不是发完命令就算完）',
  /wc\.on\('dom-ready'[\s\S]{0,200}applySurfaceToCurrentDocument\(tab, profile\)/.test(main) &&
    /window\.__nyxSurface \|\| null/.test(main),
);
check(
  '每次文档就绪都补打（不是 once）——首个 dom-ready 可能落在空文档上，用 once 会把补丁打空',
  /wc\.on\('dom-ready'/.test(main) && !/wc\.once\('dom-ready'/.test(main),
);
check(
  '补打没生效就报 PRIVACY_SURFACE_NOT_APPLIED 并给前台提示',
  /diagnostics\.error\('PRIVACY_SURFACE_NOT_APPLIED'/.test(main) &&
    /隐私模式加固没生效/.test(main),
);
check(
  '导航前那一轮不发送 Page.addScriptToEvaluateOnNewDocument（没有文档时它不回执，会把整条链路挂住）',
  /step\.method === 'Page\.addScriptToEvaluateOnNewDocument'\) continue;/.test(main),
);
check(
  '单条 CDP 下发失败不再掐断整条链路，但要留痕（PRIVACY_SURFACE_STEP_FAILED）',
  /PRIVACY_SURFACE_STEP_FAILED/.test(main) && !/return fail\(describeSurfaceFailure\('send', err\)\)/.test(main),
);

/* ⑧ Worker 上下文：Page.addScriptToEvaluateOnNewDocument 管不到它（对抗测试 P0） */
const WORKER_PREAMBLE = `
globalThis.self = globalThis;
class WorkerNavigator {}
Object.defineProperty(WorkerNavigator.prototype, 'userAgent', { get: () => 'Nyx/1.17.12 Electron/45.3.2 Chrome/156', configurable: true });
Object.defineProperty(WorkerNavigator.prototype, 'platform', { get: () => 'Win32-real', configurable: true });
Object.defineProperty(WorkerNavigator.prototype, 'language', { get: () => 'zh-CN', configurable: true });
Object.defineProperty(WorkerNavigator.prototype, 'languages', { get: () => ['zh-CN', 'zh'], configurable: true });
Object.defineProperty(WorkerNavigator.prototype, 'hardwareConcurrency', { get: () => 24, configurable: true });
Object.defineProperty(WorkerNavigator.prototype, 'deviceMemory', { get: () => 16, configurable: true });
globalThis.navigator = new WorkerNavigator();
`;
const workerScript = surface.buildWorkerHardeningScript(PROFILE);
let workerCompiles = true;
try {
  new vm.Script(workerScript);
} catch {
  workerCompiles = false;
}
check('Worker 版加固脚本可以编译', workerCompiles);
check(
  'Worker 版脚本不碰 document / window（Worker 里没有这两样，用了就会整段抛掉）',
  !/\bdocument\./.test(workerScript) && !/\bwindow\./.test(workerScript),
);
const workerContext = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
vm.runInContext(WORKER_PREAMBLE, workerContext, { timeout: 5000 });
vm.runInContext(workerScript, workerContext, { timeout: 5000 });
const workerRead = (code) => vm.runInContext(code, workerContext, { timeout: 5000 });
check('Worker 里的语言与主世界同源（不再是本机的 zh-CN）', workerRead('navigator.language') === 'en-US', String(workerRead('navigator.language')));
check('Worker 里的平台与主世界同源', workerRead('navigator.platform') === 'Win32', String(workerRead('navigator.platform')));
check(
  'Worker 里的核数/内存与主世界同为画像值（不能一边画像值、一边真值）',
  workerRead('navigator.hardwareConcurrency') === world.eval('navigator.hardwareConcurrency') &&
    workerRead('navigator.deviceMemory') === world.eval('navigator.deviceMemory'),
  `worker ${workerRead('navigator.hardwareConcurrency')}/${workerRead('navigator.deviceMemory')} vs 主世界 ${world.eval('navigator.hardwareConcurrency')}/${world.eval('navigator.deviceMemory')}`,
);
check(
  'Worker 里也留下了版本标记（说明补丁真的跑进去了）',
  workerRead('self.__nyxSurface') === surface.SURFACE_SCRIPT_VERSION,
  String(workerRead('self.__nyxSurface')),
);
check(
  '主进程用 Target.setAutoAttach 拦住 worker 再放行，失败要留痕',
  /buildWorkerHardeningScript/.test(main) &&
    /Target\.setAutoAttach/.test(main) &&
    /waitForDebuggerOnStart: true/.test(main) &&
    /Target\.attachedToTarget/.test(main) &&
    /Runtime\.runIfWaitingForDebugger/.test(main) &&
    /PRIVACY_WORKER_ATTACH_FAILED/.test(main),
);
console.log('');
console.log(`隐私指纹面回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 隐私指纹面回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 隐私指纹面回归通过');
}
