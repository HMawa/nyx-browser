'use strict';

/**
 * 工具栏布局回归（清单 B1）。
 *
 * 这一项改的是"用户每天看到的东西"，所以断言分两头：
 *   1. 纯数据/纯函数：四个主路径、更多菜单四项、小字开关、截图文件名。
 *   2. 接线：界面、主进程、preload、设置页四处必须对得上——否则改一半会静默失效。
 *
 * 不启动 Electron：界面那层靠读文件核对关键片段，交互行为由 verify-ui-polish.js 的端到端覆盖。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const toolbar = require(path.join(ROOT, 'src', 'core', 'toolbar.js'));

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

const mainHtml = read('src/renderer/index.html');
const mainJs = read('src/main.js');
const rendererJs = read('src/renderer/renderer.js');
const preloadJs = read('src/preload.js');
const settingsHtml = read('src/renderer/settings.html');
const settingsJs = read('src/renderer/settings.js');
const styleCss = read('src/renderer/style.css');
const uiStoreJs = read('src/core/ui-store.js');

check('1. 常驻的四个主路径固定为：新建 / 下载 / 隐私 / 工具箱', () => {
  assert.deepStrictEqual(
    toolbar.MAIN_ACTIONS.map((item) => item.id),
    ['new-tab', 'downloads', 'privacy', 'toolbox'],
  );
  for (const item of toolbar.MAIN_ACTIONS) {
    assert.strictEqual(item.where, 'main');
    assert.ok(item.label && item.label.length <= 4, `${item.id} 的小字要短`);
    assert.ok(item.title && item.title.length > 0, `${item.id} 要有 title`);
  }
});

check('2. 「更多」菜单固定四项：页面截图 / 页面摘要 / 扩展开关 / 代理中心（且不再塞第五项）', () => {
  assert.deepStrictEqual(
    toolbar.MORE_ACTIONS.map((item) => item.id),
    ['screenshot', 'digest', 'extensions', 'proxy'],
  );
  assert.deepStrictEqual(
    toolbar.MORE_ACTIONS.map((item) => item.label),
    ['页面截图', '页面摘要', '扩展开关', '代理中心'],
  );
  for (const item of toolbar.MORE_ACTIONS) assert.strictEqual(item.where, 'more');
});

check('3. 小字标签默认显示，只有显式 false 才关；脏值不改变默认', () => {
  assert.strictEqual(toolbar.normalizeToolbarPrefs({}).labels, true);
  assert.strictEqual(toolbar.normalizeToolbarPrefs({ labels: false }).labels, false);
  assert.strictEqual(toolbar.normalizeToolbarPrefs({ labels: 'no' }).labels, true);
  assert.strictEqual(toolbar.normalizeToolbarPrefs(null).labels, true);
  assert.strictEqual(toolbar.DEFAULT_TOOLBAR_PREFS.labels, true);
});

check('4. 布局结果是拷贝，界面改它不会污染常量', () => {
  const layout = toolbar.resolveToolbarLayout({ labels: false });
  assert.strictEqual(layout.labels, false);
  layout.main[0].label = '被改了';
  assert.strictEqual(toolbar.MAIN_ACTIONS[0].label, '新建');
  assert.deepStrictEqual(layout.moreIds, ['screenshot', 'digest', 'extensions', 'proxy']);
});

check('5. 扩展开关与代理中心指向设置里的分区，其余动作不指分区', () => {
  assert.strictEqual(toolbar.sectionForAction('extensions'), 'extensions');
  assert.strictEqual(toolbar.sectionForAction('proxy'), 'network');
  assert.strictEqual(toolbar.sectionForAction('screenshot'), '');
  assert.strictEqual(toolbar.sectionForAction('不存在'), '');
});

check('6. 截图文件名按时间可读、可排序（中文前缀 + 秒级时间戳）', () => {
  const name = toolbar.screenshotFilename(new Date(2026, 2, 4, 5, 6, 7).getTime());
  assert.strictEqual(name, '页面截图-2026-03-04-05-06-07.png');
  assert.match(toolbar.screenshotFilename(Date.now()), /^页面截图-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
});

check('7. 界面接线：更多按钮 + 菜单 + 四个菜单项 + 小字标签都在，旧的 #btn-digest 已移除', () => {
  for (const id of ['btn-more', 'more-menu', 'more-screenshot', 'more-digest', 'more-extensions', 'more-proxy']) {
    assert.ok(mainHtml.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
  assert.ok(!mainHtml.includes('id="btn-digest"'), '旧的独立摘要按钮应已移除（入口唯一）');
  assert.ok(mainHtml.includes('class="tb-label"'), 'index.html 缺 .tb-label');
  assert.ok(mainHtml.includes('aria-haspopup="menu"'), '更多按钮要有 aria-haspopup');
  assert.ok(/id="new-tab-label"/.test(mainHtml) && /id="downloads-label"/.test(mainHtml) && /id="toolbox-label"/.test(mainHtml));
});

check('8. 渲染层接线：菜单开合、Esc 关闭、点外面关闭、截图走 preload', () => {
  for (const fn of ['function openMoreMenu', 'function closeMoreMenu', 'function toggleMoreMenu', 'async function takeScreenshot']) {
    assert.ok(rendererJs.includes(fn), `renderer.js 缺 ${fn}`);
  }
  assert.ok(/window\.nyx\.pageScreenshot\(\)/.test(rendererJs), '截图必须走 preload 的 pageScreenshot');
  assert.ok(/addEventListener\('keydown'/.test(rendererJs) && /Escape/.test(rendererJs), 'Esc 要能关菜单');
  assert.ok(/els\.moreMenu\.hidden = true/.test(rendererJs), '关闭菜单要真的置 hidden');
  assert.ok(/toolbarLabels !== false/.test(rendererJs), '小字开关要读 ui.toolbarLabels');
});

check('9. 主进程接线：截图先定落点、再截、失败说原因、成功落诊断', () => {
  assert.ok(/ipcMain\.handle\('nyx:page:screenshot'/.test(mainJs), 'main.js 缺截图 IPC');
  const start = mainJs.indexOf("ipcMain.handle('nyx:page:screenshot'");
  const block = mainJs.slice(start, start + 2600);
  const savedAt = block.indexOf('showSaveDialogSync');
  const capturedAt = block.indexOf('capturePage');
  assert.ok(savedAt > 0 && capturedAt > savedAt, '必须先弹保存框（同步）再截图');
  assert.ok(/code: 'CANCELED'/.test(block), '取消要有 CANCELED');
  assert.ok(/code: 'NO_PAGE'/.test(block), '没有页面要明确说');
  assert.ok(/PAGE_SCREENSHOT_FAILED/.test(block), '失败要落诊断');
  assert.ok(/screenshotFilename\(Date\.now\(\)\)/.test(block), '默认文件名要可读');
});

check('10. preload / ui-store / 设置页 / 样式四处都接上了', () => {
  assert.ok(/pageScreenshot: \(\) => ipcRenderer\.invoke\('nyx:page:screenshot'\)/.test(preloadJs));
  assert.ok(/toolbarLabels: true/.test(uiStoreJs), 'ui-store 默认值缺 toolbarLabels');
  assert.ok(/id="pref-toolbar-labels"/.test(settingsHtml), '设置页缺小字开关');
  assert.ok(/saveUiPref\('toolbarLabels'/.test(settingsJs), '设置页没有保存小字开关');
  for (const cls of ['.tb-label', '.more-menu', '.more-item', '.more-entry.is-open']) {
    assert.ok(styleCss.includes(cls), `style.css 缺 ${cls}`);
  }
  assert.ok(!/#[0-9a-fA-F]{6}/.test(styleCss.slice(styleCss.indexOf('.more-menu'), styleCss.indexOf('.more-item-text'))), '更多菜单样式不许写死色值');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[工具栏回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[工具栏回归] 通过 ${checks.length}/${checks.length}`);
}
