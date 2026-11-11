/* 由 2026-09-20 扩展插件开发会话归档；用法见文件头注释与 PROGRESS.md「二·补 6」。 */
'use strict';

/* Nyx 扩展插件前端接线一致性检查：
   A) settings.js 里 byId('x') 引用的 id 是否都在 settings.html 里存在（防 typo 导致按钮点了没反应）
   B) settings.js 里调用的 window.nyx.X 是否都在 preload.js 中暴露（防 IPC 通道漏接线）
   C) main.js 是否注册了对应 ipcMain 通道 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

const html = read('renderer/settings.html');
const settingsJs = read('renderer/settings.js');
const preload = read('preload.js');
const mainJs = read('main.js');

const problems = [];
const notes = [];

/* ---------- A) HTML id vs settings.js byId ---------- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set(
  [...settingsJs.matchAll(/\bbyId\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
);

const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
if (missingIds.length) problems.push(`settings.js 引用了 HTML 中不存在的 id：${missingIds.join(', ')}`);

/* 扩展分区相关元素是否齐全 */
const needExtIds = [
  'ext-list',
  'ext-count',
  'ext-store-path',
  'ext-import-hint',
  'btn-ext-add-dir',
  'btn-ext-add-crx',
  'btn-ext-reload',
  'btn-ext-reload-tabs',
  'btn-ext-open-store',
  'btn-ext-refresh',
];
const missingExtIds = needExtIds.filter((id) => !htmlIds.has(id));
if (missingExtIds.length) problems.push(`扩展分区缺少元素：${missingExtIds.join(', ')}`);
else notes.push(`扩展分区元素齐全（${needExtIds.length} 个）`);

/* nav 里的分区按钮与 section data-sec 是否配套 */
const navSecs = [...html.matchAll(/class="nav-item[^"]*"\s+data-sec="([^"]+)"/g)].map((m) => m[1]);
const sections = new Set([...html.matchAll(/class="sec-panel[^"]*"\s+data-sec="([^"]+)"/g)].map((m) => m[1]));
const missingSections = navSecs.filter((sec) => !sections.has(sec));
if (missingSections.length) problems.push(`导航项没有对应 section：${missingSections.join(', ')}`);
else notes.push(`导航与分区配套（${navSecs.length} 项，含 extensions=${navSecs.includes('extensions')}）`);

if (!sections.has('extensions')) problems.push('缺少 data-sec="extensions" 分区');

/* settings.css 是否覆盖了扩展列表类名 */
const css = read('renderer/settings.css');
const needCss = ['.ext-list', '.ext-item', '.ext-item-head', '.ext-level-low', '.ext-warn'];
const missingCss = needCss.filter((cls) => !css.includes(cls));
if (missingCss.length) problems.push(`settings.css 缺少样式：${missingCss.join(', ')}`);
else notes.push('扩展列表样式已定义');

/* ---------- B) window.nyx.* 调用 vs preload 暴露 ---------- */
const called = new Set([...settingsJs.matchAll(/window\.nyx\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
const exposed = new Set(
  [...preload.matchAll(/^\s{2}([A-Za-z0-9_]+)\s*[:,]/gm)].map((m) => m[1]),
);
const missingApi = [...called].filter((name) => !exposed.has(name));
if (missingApi.length) problems.push(`preload 未暴露 settings.js 调用的接口：${missingApi.join(', ')}`);
else notes.push(`settings.js 调用的 ${called.size} 个 nyx 接口均已在 preload 暴露`);

/* ---------- C) preload 接口 vs main.js ipcMain 通道 ---------- */
const extChannels = [...mainJs.matchAll(/ipcMain\.handle\(\s*['"](nyx:ext:[^'"]+)['"]/g)].map((m) => m[1]);
if (extChannels.length !== 8) problems.push(`扩展 IPC 通道数量异常：期望 8，实际 ${extChannels.length}（${extChannels.join(', ')}）`);
else notes.push(`扩展 IPC 通道已注册：${extChannels.join(', ')}`);

/* preload 中 invoke 的通道是否都被注册 */
const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const handled = new Set([...mainJs.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
const unhandled = [...new Set(invoked)].filter((ch) => !handled.has(ch));
if (unhandled.length) problems.push(`preload 调用了未注册的通道：${unhandled.join(', ')}`);
else notes.push(`preload 的 ${new Set(invoked).size} 个通道全部在主进程注册`);

/* ---------- D) 主进程确实在启动流程里初始化了扩展 ---------- */
if (!/initExtensions\(\)/.test(mainJs)) problems.push('main.js 启动流程未调用 initExtensions()');
if (!/registerExtensionsIpc\(\)/.test(mainJs)) problems.push('main.js 未调用 registerExtensionsIpc()');
else notes.push('main.js 已在启动与 IPC 注册流程中接入扩展管理器');

/* ---------- E) 关键安全约束：隐私分区不得装载扩展 ---------- */
const extCore = read('core/extensions.js');
if (!/nyx-normal/.test(extCore)) problems.push('扩展管理器未限定普通分区');
if (/'private'/.test(extCore)) problems.push('扩展管理器代码中出现 private 分区引用，需人工复核');
else notes.push('扩展管理器只面向普通分区，未引用隐私分区');

console.log('=== 检查项 ===');
for (const line of notes) console.log(`  [OK] ${line}`);
console.log('\n=== 问题 ===');
if (!problems.length) console.log('  无');
else for (const line of problems) console.log(`  [X] ${line}`);
process.exitCode = problems.length ? 1 : 0;
