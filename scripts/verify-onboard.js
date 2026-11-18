'use strict';

/**
 * 首次安装引导回归（清单 D2）。
 *
 * 这一项的判定最容易做歪成"没有配置文件就弹引导"，所以断言重点全在判定口径上：
 *   ① 没有标记（开发运行 / 老配置）→ 不弹；
 *   ② 升级安装写的 pending=false → 不弹；
 *   ③ 已经走过（doneAt>0）→ 不弹；
 *   ④ 只有 pending=true 的全新安装 → 弹一次。
 * 另外还有两条产品口径：选「先不定」的项不许写进偏好；「全部默认」必须一步落盘。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const onboard = require(path.join(ROOT, 'src', 'core', 'onboarding.js'));

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    checks.push({ name, pass: false, error: String(err && err.message ? err.message : err) });
    console.log(`  ✘ ${name}\n      ${String(err && err.message ? err.message : err).split('\n')[0]}`);
  }
}

const mainJs = read('src/main.js');
const preloadJs = read('src/preload.js');
const html = read('src/renderer/onboard.html');
const js = read('src/renderer/onboard.js');
const css = read('src/renderer/onboard.css');
const nsh = read('build/installer.nsh');

check('1. 没有「首次安装」标记时不弹（开发运行 / 老配置都走这条）', () => {
  const plan = onboard.planOnboarding({ marker: null });
  assert.strictEqual(plan.show, false);
  assert.strictEqual(plan.code, 'NO_MARKER');
  assert.match(plan.reason, /不弹/);
});

check('2. 升级安装写的 pending=false 不弹，且原因说的是"升级安装"', () => {
  const plan = onboard.planOnboarding({ marker: { pending: false, version: '1.17.9' } });
  assert.strictEqual(plan.show, false);
  assert.strictEqual(plan.code, 'NOT_FIRST_INSTALL');
  assert.match(plan.reason, /升级安装|覆盖安装/);
});

check('3. 走过一次之后（doneAt>0）不再弹第二次', () => {
  const plan = onboard.planOnboarding({ marker: { pending: false, doneAt: Date.now(), skipped: false } });
  assert.strictEqual(plan.show, false);
  assert.strictEqual(plan.code, 'ALREADY_DONE');
});

check('4. 只有全新安装（pending=true）才弹，且验证旋钮能强制弹一次', () => {
  const plan = onboard.planOnboarding({ marker: { pending: true, version: '1.17.9' } });
  assert.strictEqual(plan.show, true);
  assert.strictEqual(plan.code, 'FIRST_INSTALL');
  const forced = onboard.planOnboarding({ marker: null, force: true });
  assert.strictEqual(forced.show, true);
  assert.strictEqual(forced.code, 'FORCED');
});

check('5. 标记归一：脏数据当没有标记，别把 doneAt 认成 0 以外的怪值', () => {
  assert.strictEqual(onboard.normalizeOnboardMarker(null), null);
  assert.strictEqual(onboard.normalizeOnboardMarker('x'), null);
  const marker = onboard.normalizeOnboardMarker({ pending: true, doneAt: 'abc', installedAt: -5 });
  assert.strictEqual(marker.doneAt, 0);
  assert.strictEqual(marker.installedAt, 0);
  assert.strictEqual(marker.pending, true);
});

check('6. 选「先不定」的项一律不写进偏好（不替用户拍板）', () => {
  const plan = onboard.planOnboardChoices({});
  assert.strictEqual(plan.ok, true);
  assert.deepStrictEqual(plan.entries, []);
  // 只选了主题：其余项不该跟着冒出来
  const onlyTheme = onboard.planOnboardChoices({ theme: 'paper' });
  assert.deepStrictEqual(onlyTheme.entries.map((e) => e.key), ['theme']);
});

check('7. 「全部默认」一步落盘：六组默认值都写，且下载默认是"每次问"、接入方式默认是校园', () => {
  const plan = onboard.planOnboardChoices({ useDefaults: true });
  assert.strictEqual(plan.ok, true);
  const map = Object.fromEntries(plan.entries.map((e) => [e.key, e.value]));
  assert.strictEqual(map.theme, 'ink');
  assert.strictEqual(map.toolbarLabels, true, '默认应是"完整"（带小字）');
  assert.strictEqual(map.downloadAsk, true, '默认应每次问');
  assert.strictEqual(map.privacyLink, 'proxy', '隐私模式默认经接入通道');
  assert.strictEqual(map.startPage, 'start');
  assert.strictEqual(map.netIdentity, 'campus', '全新安装默认按校园网络接入显示');
  assert.ok(plan.entries.length >= 6);
});

check('8. 精简档复用 B1 的小字开关；直连必须给出边界提醒；非法取值整组拒绝', () => {
  const compact = onboard.planOnboardChoices({ density: 'compact' });
  assert.deepStrictEqual(compact.entries, [{ key: 'toolbarLabels', value: false }]);
  const direct = onboard.planOnboardChoices({ privacyLink: 'direct' });
  assert.strictEqual(direct.ok, true);
  assert.ok(direct.notes.some((n) => /真实 IP|边界/.test(n)), '直连要写明边界');
  for (const bad of [{ theme: 'neon' }, { density: 'tiny' }, { privacyLink: 'both' }, { startPage: 'x' }, { netIdentity: 'official' }]) {
    const res = onboard.planOnboardChoices(bad);
    assert.strictEqual(res.ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(res.error && res.error.length > 4);
  }
});

check('8b. 引导多了一步「接入方式」：三档都能选，只写叫法不碰网络，摘要里说人话', () => {
  const step = onboard.ONBOARD_STEPS.find((item) => item.id === 'network');
  assert.ok(step, 'ONBOARD_STEPS 里没有接入方式这一步');
  assert.match(step.title, /接入方式/);
  assert.match(step.summary, /校园网络接入|单位网络接入|自定义服务端|只改叫法/);
  for (const identity of ['campus', 'enterprise', 'custom']) {
    const plan = onboard.planOnboardChoices({ netIdentity: identity });
    assert.strictEqual(plan.ok, true, `${identity} 应被接受`);
    assert.deepStrictEqual(plan.entries, [{ key: 'netIdentity', value: identity }]);
    assert.ok(plan.notes.some((n) => /只改界面/.test(n)), '必须说清只改叫法');
    const summary = onboard.summarizeOnboardChoices(plan);
    assert.match(summary, /接入方式/);
  }
  assert.deepStrictEqual(onboard.NET_IDENTITY_CHOICES, ['campus', 'enterprise', 'custom']);
  // 引导自己的文案不许出现旧叫法（隐私与接入通道那一步同理）
  for (const item of onboard.ONBOARD_STEPS) {
    assert.ok(!/代理/.test(`${item.title}${item.summary}`), `引导第 ${item.id} 步仍在说「代理」`);
  }
  // 界面与主进程都要把三档递进去
  assert.ok(/id: 'ob-net-identity'|'ob-net-identity'/.test(js), '引导页缺接入方式选择器');
  assert.ok(/identities: netTerms\.describeIdentities\(\)/.test(mainJs), '主进程没把三档递给引导页');
});

check('9. 主题清单与 ui-store 的白名单一致（否则引导里选完存不进去）', () => {
  const uiStore = read('src/core/ui-store.js');
  const enumLine = uiStore.slice(uiStore.indexOf('theme: ['), uiStore.indexOf(']', uiStore.indexOf('theme: [')));
  for (const theme of onboard.THEME_CHOICES) {
    assert.ok(enumLine.includes(`'${theme}'`), `ui-store 的 theme 白名单缺 ${theme}`);
  }
});

check('11. 启动方式选「空白页」时打开的是一张真页面，不是 about:blank（否则看着像浏览器坏了）', () => {
  const blank = read('src/renderer/blank.html');
  assert.ok(/BLANK_PAGE_URL/.test(mainJs), 'main.js 缺 BLANK_PAGE_URL');
  assert.ok(
    /url === 'about:blank' \? BLANK_PAGE_URL : url/.test(mainJs),
    'startupTargets 没把 about:blank 换成空白页',
  );
  assert.ok(/空白页/.test(blank), '空白页上一个字都没有');
  assert.ok(/启动与主页/.test(blank), '空白页要告诉用户去哪儿改启动方式');
  assert.ok(!/https?:\/\//.test(blank), '空白页不许引用任何网络资源');
  assert.ok(!/<script/i.test(blank), '空白页不该有脚本');
});

check('12. 启动方式的白名单仍是 blank / newTab / custom，默认不是 blank', () => {
  const store = require(path.join(ROOT, 'src', 'core', 'startup-store.js'));
  assert.deepStrictEqual(store.STARTUP_MODES, ['blank', 'newTab', 'custom']);
  assert.strictEqual(store.STARTUP_DEFAULTS.startupMode, 'newTab');
});

check('10. 接线：只有主进程判定、窗口只在 file:// 加载、标记由安装器写、界面有两条出口', () => {
  assert.ok(/ONBOARD_MARKER_FILE/.test(mainJs) && /function readOnboardMarker/.test(mainJs), 'main.js 缺标记读取');
  assert.ok(/function maybeOpenOnboarding/.test(mainJs), 'main.js 缺 maybeOpenOnboarding');
  assert.ok(/did-finish-load'[\s\S]{0,200}maybeOpenOnboarding\(\)/.test(mainJs), '引导要等外壳能显示之后再开');
  assert.ok(/ipcMain\.handle\('nyx:onboard:state'/.test(mainJs) && /ipcMain\.handle\('nyx:onboard:finish'/.test(mainJs));
  assert.ok(/writeOnboardMarker\(\{\s*pending: false,\s*doneAt: Date\.now\(\)/.test(mainJs), '走完要写 doneAt，避免二次弹出');
  assert.ok(/onboardState: \(\) => ipcRenderer\.invoke\('nyx:onboard:state'\)/.test(preloadJs));
  assert.ok(/onboardFinish: \(payload\)/.test(preloadJs));
  // 安装器只在全新安装写 pending=true
  assert.ok(/onboarding\.json/.test(nsh), 'installer.nsh 没写引导标记');
  assert.ok(/\$nyxMode == "全新安装"[\s\S]{0,220}"pending":true/.test(nsh), '只有全新安装才置 pending=true');
  // 界面：两条出口 + 不许有"必须下一步"
  assert.ok(/id="btn-onboard-skip"[\s\S]{0,80}全部默认/.test(html), '缺「全部默认」按钮');
  assert.ok(/id="btn-onboard-done"/.test(html), '缺「开始用」按钮');
  assert.ok(!/下一步|上一步/.test(js), '引导不做成必须走完的向导');
  assert.ok(/finish\(true\)/.test(js) && /finish\(false\)/.test(js));
  assert.ok(!/#[0-9a-fA-F]{6}/.test(css), '引导样式不许写死色值');
});

// 首次安装标记可能被别的工具写成带 BOM 的 UTF-8；JSON.parse 见到 \uFEFF 会直接抛错，
// 而那条错会被当成「没有标记」吞掉 —— 结果就是引导永远不弹（只在 console 留一句）。
check('读安装标记前先剥 BOM（否则带 BOM 的标记会让引导永远不弹）', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(
    /JSON\.parse\(fs\.readFileSync\(onboardMarkerPath\(\), 'utf8'\)\.replace\(\/\^\\uFEFF\/, ''\)\)/.test(mainSource),
    'main.js 的 readOnboardMarker 应剥掉 BOM 再 parse',
  );
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[首次引导回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[首次引导回归] 通过 ${checks.length}/${checks.length}`);
}
