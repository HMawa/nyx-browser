/**
 * 模式切换动画的回归（纯 Node，不启动 Electron）。
 *
 * 动画本身要靠眼睛看，但"它会不会在没人点的时候偷偷起窗口"、"窗口有没有沙箱"、
 * "关掉开关还起不起"这些属于可以静态证明的部分，全部钉在这里。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('src/renderer/transition.html');
const pageJs = read('src/renderer/transition.js');
const pageCss = read('src/renderer/transition.css');
const mainSource = read('src/main.js');
const uiStore = read('src/core/ui-store.js');
const settingsHtml = read('src/renderer/settings.html');
const security = read('src/core/security-switches.js');
const assetPath = path.join(ROOT, 'src', 'renderer', 'assets', 'milk-bucket.webp');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✘ ${name}${detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

/* ① 素材：用户给的牛奶桶必须真的在包里，而且能当 webp 解 */
let assetOk = false;
let assetDetail = '文件不存在';
if (fs.existsSync(assetPath)) {
  const buf = fs.readFileSync(assetPath);
  const isWebp = buf.length > 16 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  assetOk = isWebp && buf.length > 512;
  assetDetail = { bytes: buf.length, isWebp };
}
check('牛奶桶素材在包里且是有效的 webp', assetOk, assetDetail);

/* ② 页面：CSP 收紧、脚本外置、不外联 */
check(
  '动画页有 CSP 且不允许外联（default-src none）',
  /Content-Security-Policy/.test(html) && /default-src 'none'/.test(html),
);
check('脚本与样式都外置（没有内联 script）', /<script src="transition\.js"><\/script>/.test(html) && !/<script>[\s\S]*?<\/script>/.test(html));
check(
  '动画页不发起任何网络请求（页面里没有 fetch / XMLHttpRequest / http 地址）',
  !/\bfetch\s*\(|XMLHttpRequest|https?:\/\//.test(pageJs),
);

/* ③ 脚本：参数、时长上下限、格子大小上下限、减少动效 */
check('两种动画都实现：进入＝从中心向外扩散，退出＝牛奶桶', /drawSpread/.test(pageJs) && /#bucket/.test(pageCss) && /playExit/.test(pageJs));
check(
  '进入动画从同一个中心点向外扩散（按到中心的距离排序，噪声只占极小比例）',
  /const cx = cols \/ 2/.test(pageJs) && /dist \* 0\.96 \+ next\(\) \* 0\.04/.test(pageJs) && /cells\.sort\(\(a, b\) => a\.at - b\.at\)/.test(pageJs),
);
check(
  '两套动画都是 1 秒，且时长被夹在 120–6000ms（别让谁传个 0 或 60000 把窗口挂住）',
  /TRANSITION_ENTER_MS = 1000/.test(mainSource) && /TRANSITION_EXIT_MS = 1000/.test(mainSource) && /Math\.max\(120, Math\.min\(6000/.test(pageJs),
);
check('进入动画以黑为主：四档色值全是纯黑到深灰，不出现彩色', /const RINGS = \['#000000', '#040506', '#08090a', '#0d0f11'\]/.test(pageJs));
check('格子大小被夹在 8–24px（报告里的口径）', /Math\.max\(8, Math\.min\(24/.test(pageJs));
check('系统开了「减少动效」就只做一次淡变，不做扩散与弹跳', /prefers-reduced-motion/.test(pageCss) && /reducedBySystem/.test(pageJs) && /if \(reduced\)/.test(pageJs));

/* ④ 主进程：窗口形态、安全开关、生命周期 */
const showSection = mainSource.slice(
  mainSource.indexOf('function showModeTransition'),
  mainSource.indexOf('async function switchMode'),
);
check('存在 showModeTransition 且由用户偏好把关', /function showModeTransition/.test(mainSource) && /modeTransitionEnabled\(\)/.test(showSection));
check(
  '窗口形态：透明、无边框、跟随主窗口、不抢焦点、不占任务栏',
  /parent: parentWindow/.test(showSection) &&
    /transparent: true/.test(showSection) &&
    /frame: false/.test(showSection) &&
    /focusable: false/.test(showSection) &&
    /skipTaskbar: true/.test(showSection) &&
    /hasShadow: false/.test(showSection),
);
check(
  '窗口不注入 preload 且开沙箱（它不需要任何接口）',
  /sandbox: true/.test(showSection) && /contextIsolation: true/.test(showSection) && !/preload:/.test(showSection),
);
check('鼠标穿透 + showInactive（绝不把焦点从地址栏抢走）', /setIgnoreMouseEvents\(true/.test(showSection) && /showInactive\(\)/.test(showSection));
check('画完由主进程按 duration 收窗口，且有兜底超时', /setTimeout\(closeModeTransition, duration \+ 420\)/.test(showSection));
check('动画起不来只留诊断，不影响切换本身', /MODE_TRANSITION_FAILED/.test(showSection));

/* ⑤ 接线：两个方向都接上，且都在"校验通过之后"才画 */
const switchSection = mainSource.slice(
  mainSource.indexOf('async function switchMode'),
  mainSource.indexOf('async function switchModeTracked'),
);
check(
  '进隐私画像素扩散、回普通画牛奶桶，且都发生在停靠标签之前',
  /if \(next === 'private'\) showModeTransition\('enter'\);/.test(switchSection) &&
    /else if \(current === 'private'\) showModeTransition\('exit'\);/.test(switchSection) &&
    switchSection.indexOf("showModeTransition('enter')") < switchSection.indexOf('parkAll()'),
);
check(
  '安全开关登记了 transition 角色（沙箱开、无 preload）',
  /role: 'transition'/.test(security) && /registerSecurityWindow\('transition', prefs\)/.test(mainSource),
);

/* ⑥ 开关本身：默认开、设置页可关 */
check('偏好默认开启切换动画', /modeTransition: true/.test(uiStore));
check(
  '设置页有「切换模式时播放动画」开关并接上保存',
  /pref-mode-transition/.test(settingsHtml) && /saveUiPref\('modeTransition'/.test(read('src/renderer/settings.js')),
);

console.log('');
console.log(`切换动画回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 切换动画回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 切换动画回归通过');
}
