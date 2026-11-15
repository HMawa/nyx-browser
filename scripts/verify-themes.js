'use strict';

/**
 * 主题回归（清单 D3：奶白 + 海盐）。
 *
 * 两套新主题最容易出的两个毛病：
 *   ① 选了没反应（枚举里有、CSS 里没有，或者反过来）——所以先做"枚举与样式块一一对应"；
 *   ② 浅底配浅字（白底白字）——所以直接算对比度，而不是靠肉眼看截图。
 * 另外清单明确要求这两套**不加渐变**（渐变只在有实物依据时才允许），所以额外守一条。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const css = read('src/renderer/theme-nyx.css');
const store = read('src/core/ui-store.js');
const html = read('src/renderer/settings.html');
const settings = read('src/renderer/settings.js');

const THEMES = ['ink', 'aurora', 'paper', 'quiet', 'cream', 'sea'];
const NEW_THEMES = ['cream', 'sea'];
const REQUIRED = [
  '--bg',
  '--bg-shell',
  '--bg-panel',
  '--bg-tab',
  '--bg-row',
  '--bg-input',
  '--border',
  '--border-soft',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent',
  '--accent-soft',
  '--accent-ink',
  '--accent-14',
  '--ok',
  '--warn',
  '--danger',
  '--danger-14',
  '--on-accent',
  '--shadow-1',
  '--shadow-2',
  '--ring-danger',
  '--tb-bg',
  '--tb-card',
  '--tb-chip',
];

/** 取出某个主题的声明块（从 [data-theme="x"] { 到配对的花括号） */
function themeBlock(name) {
  const marker = `[data-theme="${name}"] {`;
  const start = css.indexOf(marker);
  if (start < 0) return '';
  let depth = 0;
  let index = css.indexOf('{', start);
  const from = index;
  for (; index < css.length; index += 1) {
    const ch = css[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(from, index + 1);
    }
  }
  return '';
}

function tokenOf(block, name) {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : '';
}

function hexToRgb(text) {
  const match = String(text).trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = match[1];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

function luminance(rgb) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fore, back) {
  const a = luminance(fore);
  const b = luminance(back);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

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

check('1. 六套主题在样式里都有块，且与 ui-store 的枚举一一对应（选了不会没反应）', () => {
  for (const theme of THEMES) {
    assert.ok(themeBlock(theme).length > 200, `主题 ${theme} 的样式块缺失或过短`);
    assert.ok(css.includes(`[data-theme="${theme}"]`), `样式里缺 ${theme}`);
  }
  const enumMatch = store.match(/theme:\s*\[([^\]]+)\]/);
  assert.ok(enumMatch, 'ui-store 里找不到 theme 枚举');
  const allowed = enumMatch[1]
    .split(',')
    .map((item) => item.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.deepStrictEqual(allowed.slice().sort(), THEMES.slice().sort(), '枚举与样式块不一致');
});

check('2. 两套新主题的令牌齐全（少一个就会有一块界面掉回默认色）', () => {
  for (const theme of NEW_THEMES) {
    const block = themeBlock(theme);
    const missing = REQUIRED.filter((token) => !tokenOf(block, token));
    assert.deepStrictEqual(missing, [], `${theme} 缺令牌：${missing.join(', ')}`);
  }
});

check('3. 白底白字不可能：正文/次要文字/强调色对底色的对比度都达标', () => {
  const rows = [];
  for (const theme of NEW_THEMES) {
    const block = themeBlock(theme);
    const bg = hexToRgb(tokenOf(block, '--bg'));
    assert.ok(bg, `${theme} 的 --bg 必须是 #rrggbb（对比度要算得出来）`);
    for (const [token, min] of [
      ['--text', 7],
      ['--text-dim', 4.5],
      ['--text-faint', 3],
      ['--accent', 4.5],
    ]) {
      const fore = hexToRgb(tokenOf(block, token));
      assert.ok(fore, `${theme} 的 ${token} 必须是 #rrggbb`);
      const ratio = contrast(fore, bg);
      rows.push(`${theme}${token}=${ratio.toFixed(2)}`);
      assert.ok(
        ratio >= min,
        `${theme} 的 ${token} 对 --bg 只有 ${ratio.toFixed(2)}:1（要求 ≥ ${min}）`,
      );
    }
  }
  console.log(`      对比度实测：${rows.join(' ')}`);
});

check('4. 两套新主题不加渐变（清单：渐变只在有实物依据时才允许）', () => {
  for (const theme of NEW_THEMES) {
    const block = themeBlock(theme);
    assert.ok(!/gradient\(/i.test(block), `${theme} 里出现了渐变`);
    assert.ok(!/backdrop-filter/i.test(block), `${theme} 里出现了毛玻璃`);
  }
});

check('5. 设置页有「主题与显示」独立分区，六套主题都列出来，三项控制都在', () => {
  assert.ok(/data-sec="display"/.test(html), '缺主题与显示分区');
  assert.ok(/<button[^>]*data-sec="display"[^>]*>主题与显示<\/button>/.test(html), '缺导航项');
  for (const theme of THEMES) {
    assert.ok(new RegExp(`<option value="${theme}"`).test(html), `设置页缺主题选项 ${theme}`);
  }
  assert.ok(html.includes('id="pref-theme"') && html.includes('id="pref-motion-level"'));
  assert.ok(html.includes('id="pref-toolbar-labels"'), '顶栏小字开关没挪进这一页');
  // 三项必须落在 display 分区里，而不是还留在外观页
  const displayStart = html.indexOf('data-sec="display"');
  const sectionStart = html.indexOf('data-sec="display"', displayStart + 1); // 跳过导航项
  const appearanceBlock = html.slice(html.indexOf('data-sec="appearance"'), sectionStart);
  assert.ok(!appearanceBlock.includes('id="pref-theme"'), '主题选择还留在「外观」里');
});

check('6. 切换主题会同时改 data-theme 与徽标，恢复默认也会把动效与小字一起复位', () => {
  assert.ok(/document\.documentElement\.dataset\.theme = theme/.test(settings));
  assert.ok(/function renderDisplayBadges\(/.test(settings), '缺徽标渲染');
  assert.ok(/renderDisplayBadges\(res\.ui\)/.test(settings), '切主题后没刷新徽标');
  assert.ok(/DISPLAY_THEME_LABELS/.test(settings) && /cream: '奶白'/.test(settings) && /sea: '海盐'/.test(settings));
  assert.ok(/saveUiPref\('theme', 'ink'\)[\s\S]{0,200}saveUiPref\('motionLevel', 'calm'\)[\s\S]{0,200}saveUiPref\('toolbarLabels', true\)/.test(settings),
    '「恢复默认外观」没把动效与小字一起复位');
});

check('7. 字号档位没有假装做：设置页如实说明这是独立改造', () => {
  const displayStart = html.indexOf('data-sec="display"', html.indexOf('data-sec="display"') + 1);
  const block = html.slice(displayStart, displayStart + 1600);
  assert.ok(/字号档位/.test(block), '没交代字号这件事');
  assert.ok(/独立改造|不属于|暂时没有/.test(block), '含糊过去不算交代');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[主题回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[主题回归] 通过 ${checks.length}/${checks.length}`);
}
