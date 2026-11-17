'use strict';

/**
 * agent 接入说明回归（清单 D1）。
 *
 * 这一项的风险是"写一份漂亮但没用的说明"：端口写死、边界不提、出错只说"失败"。
 * 所以断言集中在四件事上：
 *   ① 端点必须来自运行时（没有端口时要如实说"运行中可用"，不许编一个 3000 出来）；
 *   ② 两种接入模式的边界必须写清（外部接入要明说审计不完整）；
 *   ③ 能被拦下来的几种情况必须提前告知；
 *   ④ 说明里不许出现真实的 token 值，只许给文件位置。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const doc = require(path.join(ROOT, 'src', 'core', 'agent-doc.js'));

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

const builtin = doc.buildAgentDoc({
  port: 45999,
  tokenFile: 'C:/Users/x/AppData/Roaming/Nyx/api-token.txt',
  mode: 'builtin',
  allowCount: 2,
  stopShortcut: 'CommandOrControl+Alt+X',
});

check('1. 内置模式：端点是真实端口、鉴权头与 token 文件位置都在，且不提 CDP', () => {
  assert.match(builtin, /127\.0\.0\.1:45999/, '没写真实端口');
  assert.match(builtin, /x-nyx-token/, '没写鉴权头');
  assert.match(builtin, /api-token\.txt/, '没写 token 文件位置');
  assert.match(builtin, /401/, '没交代 401 的含义');
  assert.ok(!/CDP/.test(builtin), '内置模式不该提 CDP');
});

check('2. 没有端口时如实说「运行中可用」，绝不编一个示例端口', () => {
  const noPort = doc.buildAgentDoc({ mode: 'builtin' });
  assert.match(noPort, /运行中可用|启动日志/, '没有端口时没说清楚');
  assert.ok(!/127\.0\.0\.1:\d{2,5}/.test(noPort), '没有端口却编了一个端口出来');
});

check('3. 外部接入模式：写 CDP 端点，并明说审计不完整、统一动作通道不参与', () => {
  const external = doc.buildAgentDoc({ mode: 'external', cdpPort: 9333, auditComplete: false });
  assert.match(external, /127\.0\.0\.1:9333/);
  assert.match(external, /审计[^\n]*不完整/, '外部接入没写审计不完整');
  assert.match(external, /不参与/, '没说明统一通道不参与');
  assert.match(external, /不要暴露|局域网|公网/, '没写不要暴露端口');
});

check('4. 急停与快捷键状态如实反映（按了没反应时要指路）', () => {
  const stopped = doc.buildAgentDoc({ mode: 'builtin', stopped: true });
  assert.match(stopped, /已停止/);
  const noShortcut = doc.buildAgentDoc({ mode: 'builtin', stopShortcut: 'Ctrl+Alt+X', stopShortcutOk: false });
  assert.match(noShortcut, /注册失败/);
  assert.match(noShortcut, /工具栏按钮|界面/, '快捷键失败时没说改用什么');
});

check('5. 九个动作都在，且明确要求先 readPage 拿 elementId（别猜选择器）', () => {
  for (const [type] of doc.ACTION_LINES) assert.ok(builtin.includes(type), `动作表缺 ${type}`);
  assert.strictEqual(doc.ACTION_LINES.length, 9);
  assert.match(builtin, /先 `readPage`|先 readPage/);
  assert.match(builtin, /elementId/);
  const exec = doc.ACTION_LINES.find(([type]) => type === 'executeJS');
  assert.ok(exec && exec[2] === 'code', 'executeJS 的参数名必须是 code（服务端读的就是它）');
  assert.match(builtin, /"type": "navigate", "params": \{ "url":/, '请求体要给出 {type, params} 的完整示例');
  assert.match(builtin, /GET \/state/, 'state 走 GET 要写明');
  assert.match(builtin, /`readPage` \/ `screenshot` \/ `extractText` 会被拒绝/, '隐私模式下被拒的动作要如实写');
});

check('6. 会被拦下来的四种情况都提前告知（站点授权 / 动作级确认 / 锁死设置 / 急停）', () => {
  assert.match(builtin, /站点授权/);
  assert.match(builtin, /屏蔽优先|屏蔽.*一律拒绝/);
  assert.match(builtin, /动作级确认/);
  assert.match(builtin, /锁死|连问都不许改/);
  assert.match(builtin, /急停/);
  assert.match(builtin, /当前白名单里有 2 条/, '白名单条数没带上');
});

check('7. 文件名可预期（同一天稳定，跨天变化），且说明里不含真实 token 值', () => {
  const a = doc.agentDocFilename(Date.UTC(2026, 2, 4, 1, 2, 3));
  const b = doc.agentDocFilename(Date.UTC(2026, 2, 4, 9, 9, 9));
  assert.strictEqual(a, b, '同一天应该得到同一个文件名');
  assert.match(a, /^Nyx-agent接入说明-2026-03-04\.md$/);
  assert.ok(!/[0-9a-f]{32,}/i.test(builtin), '说明里出现了像 token 的长串');
});

check('8. 纯文本生成：模块里不发任何网络请求（只拼字符串）', () => {
  const source = read('src/core/agent-doc.js');
  assert.ok(!/fetch\(/.test(source), '不许发请求');
  assert.ok(!/require\('node:http/.test(source) && !/require\('http/.test(source), '不许引 http');
});

check('9. 接线：主进程三个 IPC（复制要回读校对、保存走同步对话框）、preload 三方法、界面三处 id', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const html = read('src/renderer/settings.html');
  const settings = read('src/renderer/settings.js');
  assert.ok(/ipcMain\.handle\('nyx:agent:doc'/.test(main));
  assert.ok(/ipcMain\.handle\('nyx:agent:doc-copy'/.test(main));
  assert.ok(/ipcMain\.handle\('nyx:agent:doc-save'/.test(main));
  assert.ok(/agentDocFilename, buildAgentDoc/.test(main), '主进程没引说明生成器');
  assert.ok(/readClipboardText\(\)[\s\S]{0,220}includes\(head\)/.test(main), '复制后没有回读校对');
  assert.ok(/showSaveDialogSync/.test(main) && /filters: \[\{ name: 'Markdown'/.test(main));
  assert.ok(/registerAgentDocIpc\(\);/.test(main), 'registerIpc 没挂上');
  assert.ok(/agentDoc: \(\) => ipcRenderer\.invoke\('nyx:agent:doc'\)/.test(preload));
  assert.ok(/agentDocCopy: \(\) => ipcRenderer\.invoke\('nyx:agent:doc-copy'\)/.test(preload));
  assert.ok(/agentDocSave: \(\) => ipcRenderer\.invoke\('nyx:agent:doc-save'\)/.test(preload));
  for (const id of ['btn-agent-doc-copy', 'btn-agent-doc-save', 'agent-doc-status']) {
    assert.ok(html.includes(`id="${id}"`), `设置页缺 ${id}`);
  }
  assert.ok(/function loadAgentDoc\(/.test(settings) && /function wireAgentDoc\(/.test(settings));
  assert.ok(/function loadAgentDoc\(\)/.test(settings));
  // 设置页不许把全文直接摊在页面上（含端口与 token 路径，容易被顺手截屏外传）
  assert.ok(!/agent-doc-preview/.test(html), '不该在设置页摊开全文');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[agent 接入说明回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[agent 接入说明回归] 通过 ${checks.length}/${checks.length}`);
}
