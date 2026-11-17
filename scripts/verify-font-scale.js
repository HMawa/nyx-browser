/**
 * 界面字号档位回归（清单 D3 遗留项）。
 * 纯 Node，不启动 Electron。测两件事：
 *   ① 纯逻辑：档位 → 倍率/中文名的映射是不是想要的那几个数、未知值会不会乱给倍率；
 *   ② 接线：样式真的走了 calc(... var(--font-scale))、两个页面都会把倍数写到根元素上、
 *      设置里的下拉与偏好白名单都在，preload 三条 API 都暴露了。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const font = require('../src/core/font-scale');

// ---------- ① 纯逻辑 ----------
const order = font.FONT_SCALE_ORDER;
check(
  '四档固定、倍率单调递增且标准档是 1',
  order.length === 4 &&
    order.join(',') === 'small,normal,large,huge' &&
    font.FONT_SCALES.normal === 1 &&
    font.FONT_SCALES.small < 1 &&
    font.FONT_SCALES.large > 1 &&
    font.FONT_SCALES.huge > font.FONT_SCALES.large,
  JSON.stringify(font.FONT_SCALES)
);

check(
  '认不出的档位一律回到标准档（绝不给奇怪倍率）',
  ['', null, undefined, 'NORMAL', 1.5, 'big', {}].every((v) => font.normalizeFontScale(v) === 'normal') &&
    font.normalizeFontScale('  Large  ') === 'large',
  JSON.stringify(['', null, 'NORMAL', 1.5, '  Large  '].map((v) => font.normalizeFontScale(v)))
);

check(
  '倍率与中文名对得上',
  font.fontScaleFactor('small') === 0.92 &&
    font.fontScaleFactor('large') === 1.12 &&
    font.fontScaleFactor('huge') === 1.24 &&
    font.describeFontScale('huge') === '特大' &&
    font.describeFontScale('big') === '标准' &&
    font.describeFontScale('small') === '小',
  `${font.fontScaleFactor('small')} / ${font.fontScaleFactor('huge')} / ${font.describeFontScale('huge')}`
);

const options = font.fontScaleOptions();
check(
  '选项表顺序固定、每一项都带倍率',
  options.length === 4 &&
    options.map((o) => o.value).join(',') === 'small,normal,large,huge' &&
    options.every((o) => typeof o.factor === 'number' && o.label),
  JSON.stringify(options)
);

// ---------- ② 偏好与样式 ----------
const uiStore = read('src/core/ui-store.js');
check(
  '偏好默认标准档，且进了枚举白名单',
  /fontScale:\s*'normal'/.test(uiStore) && /fontScale:\s*\['small',\s*'normal',\s*'large',\s*'huge'\]/.test(uiStore),
  'ui-store.js'
);

const theme = read('src/renderer/theme-nyx.css');
check('主题令牌里给了 --font-scale 默认值 1', /--font-scale:\s*1;/.test(theme), 'theme-nyx.css');

// 主题 CSS 也要扫：theme-nyx 的 body / .tab-title / .tb-title 曾用裸 px 覆盖
// style.css 的 calc，导致“行标题、标签标题不缩放”，而只扫 style/settings 的旧断言
// 仍是全绿。主题文件允许没有字号（继承 style.css），但一旦写 font-size 就必须带 calc。
const cssFiles = ['src/renderer/style.css', 'src/renderer/settings.css'];
for (const name of fs.readdirSync(path.join(ROOT, 'src/renderer'))) {
  if (/^theme-.*\.css$/.test(name)) cssFiles.push(`src/renderer/${name}`);
}
for (const rel of cssFiles) {
  const css = read(rel);
  const isTheme = /\/theme-.*\.css$/.test(rel);
  const scaled = (css.match(/font-size:\s*calc\([\d.]+px \* var\(--font-scale\)\);/g) || []).length;
  const bare = (css.match(/font-size:\s*[\d.]+px;/g) || []).length;
  const hasFontSize = /font-size:/.test(css);
  check(
    `${rel} 的字号全部乘上 --font-scale（不留裸 px，否则档位形同虚设）`,
    bare === 0 && (isTheme ? (!hasFontSize || scaled > 0) : scaled > 50),
    `calc ${scaled} 处 / 裸 px ${bare} 处${isTheme ? '（主题可继承）' : ''}`
  );
}

const renderer = read('src/renderer/renderer.js');
check(
  '主窗口把倍数写到根元素上，并在应用偏好时调用',
  /function applyFontScale\(ui\)/.test(renderer) &&
    /setProperty\('--font-scale',\s*String\(factor\)\)/.test(renderer) &&
    /applyMotionPrefs\(ui\);\s*\n\s*applyFontScale\(ui\);/.test(renderer),
  'renderer.js'
);

const settingsJs = read('src/renderer/settings.js');
check(
  '设置页自己也换字号，且下拉能回填与保存',
  /function applyFontScale\(ui\)/.test(settingsJs) &&
    /applyFontScale\(uiPrefs\)/.test(settingsJs) &&
    /pref-font-scale'\)\.value = uiPrefs\.fontScale/.test(settingsJs) &&
    /setUiPref\('fontScale', key\)/.test(settingsJs),
  'settings.js'
);

const settingsHtml = read('src/renderer/settings.html');
check(
  '设置页有「界面字号」四个档位，且写明只缩放文字',
  /id="pref-font-scale"/.test(settingsHtml) &&
    (settingsHtml.match(/<option value="(small|normal|large|huge)"/g) || []).length === 4 &&
    /只放大或缩小文字/.test(settingsHtml),
  'settings.html'
);

const preload = read('src/preload.js');
check(
  'preload 暴露三条同步 API，倍率源头只有 font-scale 模块',
  /require\('\.\/core\/font-scale'\)/.test(preload) &&
    /fontScaleFactor:\s*\(key\)\s*=>\s*fontScaleCore\.fontScaleFactor\(key\)/.test(preload) &&
    /fontScaleLabel:\s*\(key\)\s*=>\s*fontScaleCore\.describeFontScale\(key\)/.test(preload) &&
    /fontScaleOptions:\s*\(\)\s*=>\s*fontScaleCore\.fontScaleOptions\(\)/.test(preload),
  'preload.js'
);

const moduleText = read('src/core/font-scale.js');
check(
  'font-scale 保持纯逻辑（不碰 Electron / 文件 / 网络）',
  !/require\('electron'\)/.test(moduleText) &&
    !/require\('node:fs'\)/.test(moduleText) &&
    !/\bfetch\(/.test(moduleText),
  'font-scale.js'
);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? `｜${c.detail}` : ''}`);
}
console.log(`\n共 ${checks.length} 项：通过 ${checks.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  for (const c of failed) console.error(`  失败：${c.name}`);
  process.exit(1);
}
console.log('[Nyx] 界面字号档位回归通过');
