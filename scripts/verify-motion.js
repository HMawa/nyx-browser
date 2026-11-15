'use strict';

/**
 * 动效档位回归（清单 B2）。
 *
 * 这条清单最容易做歪成"给所有按钮加一圈发光"，所以断言里专门盯着三件事：
 *   1. 两档的时长/缓动是**代码里唯一一份**，样式侧只读 CSS 变量；
 *   2. 系统「减少动效」时必须降级，且用户选的档位不能被改写（存的还是他选的值）；
 *   3. 不许出现外发光（`box-shadow` 里带 blur 光晕 / `filter: drop-shadow`）。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const motion = require(path.join(ROOT, 'src', 'core', 'motion.js'));

const styleCss = read('src/renderer/style.css');
const themeCss = read('src/renderer/theme-nyx.css');
const settingsHtml = read('src/renderer/settings.html');
const settingsJs = read('src/renderer/settings.js');
const rendererJs = read('src/renderer/renderer.js');
const preloadJs = read('src/preload.js');
const uiStoreJs = read('src/core/ui-store.js');

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

check('1. 只有两档，默认克制；脏值不改变默认', () => {
  assert.deepStrictEqual(motion.MOTION_ORDER, ['calm', 'lively']);
  assert.strictEqual(motion.DEFAULT_MOTION, 'calm');
  for (const raw of [undefined, null, '', 'CALM', 'wild', 42, {}]) {
    assert.strictEqual(motion.normalizeMotionLevel(raw), 'calm', `脏值 ${String(raw)} 应回默认`);
  }
  assert.strictEqual(motion.normalizeMotionLevel(' Lively '), 'lively');
});

check('2. 克制档 120–180ms，活泼档更长且带回弹（数值都落在清单给的区间里）', () => {
  const calm = motion.resolveMotion({ level: 'calm' });
  const lively = motion.resolveMotion({ level: 'lively' });
  assert.ok(calm.durationMs >= 120 && calm.durationMs <= 180, `克制档 ${calm.durationMs}ms 超出 120–180`);
  assert.ok(lively.durationMs > calm.durationMs, '活泼档应比克制档更长');
  assert.strictEqual(calm.spring, false);
  assert.strictEqual(lively.spring, true);
  assert.notStrictEqual(calm.easing, lively.easing, '两档缓动应不同');
});

check('3. 系统要求减少动效时降到最短、取消位移，并说明原因', () => {
  const reduced = motion.resolveMotion({ level: 'lively', reducedMotion: true });
  assert.strictEqual(reduced.reduced, true);
  assert.strictEqual(reduced.level, 'calm');
  assert.strictEqual(reduced.durationMs, motion.REDUCED_MOTION_MS);
  assert.strictEqual(reduced.press, 'none');
  assert.strictEqual(reduced.spring, false);
  assert.match(reduced.reason, /减少动效/);
});

check('4. 降级不改写用户存的值（返回的是生效档，不是把偏好改掉）', () => {
  const store = require(path.join(ROOT, 'src', 'core', 'ui-store.js'));
  assert.ok(store.UI_PREF_DEFAULTS, 'ui-store 应导出默认值供核对');
  assert.strictEqual(store.UI_PREF_DEFAULTS.motionLevel, 'calm');
  const reduced = motion.resolveMotion({ level: 'lively', reducedMotion: true });
  assert.strictEqual(reduced.requested, undefined, '不应偷偷回传"已改写"的偏好');
  assert.strictEqual(motion.normalizeMotionLevel('lively'), 'lively', '解析层不许把 lively 抹掉');
});

check('5. CSS 变量串来自同一份数字（样式侧不许再写死时长）', () => {
  const vars = motion.motionCssVars({ level: 'lively' });
  assert.ok(vars.includes('--motion-ms: 220ms'));
  assert.ok(vars.includes('--motion-ease:'));
  assert.ok(vars.includes('--motion-press:'));
  // 外壳样式：过渡必须读变量，而不是写死 0.16s
  const iconBlock = styleCss.slice(styleCss.indexOf('.icon-btn {'), styleCss.indexOf('.icon-btn:hover'));
  assert.ok(iconBlock.includes('var(--motion-ms'), '外壳按钮的 transition 应读 --motion-ms');
  assert.ok(!/transition:[^;]*0\.\d+s/.test(iconBlock), '外壳按钮不许再写死时长');
});

check('6. 按下有反馈、悬停有提亮，且都用现有令牌（零新增色值）', () => {
  assert.ok(/\.icon-btn:active:not\(:disabled\)\s*\{[^}]*transform:\s*var\(--motion-press/.test(styleCss), '外壳按钮缺按下反馈');
  assert.ok(/\.btn:active:not\(:disabled\),\s*\n\.btn-mini:active:not\(:disabled\)\s*\{[^}]*transform:\s*var\(--motion-press/.test(themeCss), '设置页按钮缺按下反馈');
  const hover = styleCss.slice(styleCss.indexOf('.icon-btn:hover'), styleCss.indexOf('.icon-btn:active'));
  assert.ok(hover.includes('var(--border-strong)'), '悬停边界要用边框令牌');
  assert.ok(hover.includes('color-mix'), '悬停提亮用 color-mix 调和，不新增色值');
});

check('7. 不做外发光：按钮规则里不许出现带模糊的光晕', () => {
  const slices = [
    styleCss.slice(styleCss.indexOf('.icon-btn {'), styleCss.indexOf('.icon-btn:disabled')),
    themeCss.slice(themeCss.indexOf('/* 按钮 */'), themeCss.indexOf('.btn:disabled')),
  ];
  for (const slice of slices) {
    assert.ok(!/filter:\s*drop-shadow/.test(slice), '按钮规则里不许用 drop-shadow 发光');
    const shadows = slice.match(/box-shadow:[^;]+;/g) || [];
    for (const shadow of shadows) {
      assert.ok(!/\b0\s+0\s+(?!0\b)\d+px/.test(shadow), `疑似光晕：${shadow}`);
    }
  }
});

check('8. 设置页与外壳都吃同一套（同源解析、偏好可切、减少动效时自动降）', () => {
  assert.ok(/motionLevel: \['calm', 'lively'\]/.test(uiStoreJs), 'ui-store 枚举白名单缺 motionLevel');
  assert.ok(/motionResolve: \(payload\) => motionCore\.resolveMotion/.test(preloadJs), 'preload 应同步暴露 motionResolve');
  assert.ok(/id="pref-motion-level"/.test(settingsHtml), '设置页缺动效档位选择');
  assert.ok(/saveUiPref\('motionLevel'/.test(settingsJs), '设置页没有保存动效档位');
  assert.ok(/function applySettingsMotion/.test(settingsJs) && /function applyMotionPrefs/.test(rendererJs), '两侧都要有应用函数');
  for (const src of [settingsJs, rendererJs]) {
    assert.ok(/prefers-reduced-motion: reduce/.test(src), '两侧都要读系统的减少动效');
    assert.ok(/dataset\.motion/.test(src), '两侧都要把生效档写到 data-motion');
  }
  assert.ok(/prefers-reduced-motion: reduce/.test(styleCss) && /prefers-reduced-motion: reduce/.test(themeCss), '样式侧要兜底');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[动效档位回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[动效档位回归] 通过 ${checks.length}/${checks.length}`);
}
