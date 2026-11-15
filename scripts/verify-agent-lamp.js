'use strict';

/**
 * agent 状态灯与窄面板回归（清单 A5）。
 *
 * 断言的重点不是"红灯好看"，而是三个口径不许糊在一起：
 *   1. 「正在被驱动」只在动作真的执行时亮（4 秒窗口），会话还开着不算；
 *   2. 「审计不完整」是独立标识，不许挤进三色灯；
 *   3. 面板里只有"看"和"急停"，不给第二条改配置的路。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const lamp = require('../src/core/agent-lamp');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err && err.message ? err.message : err}`);
    console.log(`  ✘ ${name}：${err && err.message ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

const NOW = 1_700_000_000_000;

check('没接入就是灰灯：接口关着或已紧急停止一律 off', () => {
  const closed = lamp.decideLamp({ enabled: false, now: NOW });
  assert(closed.level === 'off', `接口关着应 off，实得 ${closed.level}`);
  assert(closed.active === false, 'off 不许是 active');
  const stopped = lamp.decideLamp({ agentStopped: true, enabled: true, now: NOW });
  assert(stopped.level === 'off', `已停止应 off，实得 ${stopped.level}`);
  assert(/紧急停止/.test(stopped.text), '已停止的文案要说清是急停');
  console.log(`    {"closed":"${closed.level}","stopped":"${stopped.level}"}`);
});

check('接入了但没动作时是金灯：会话开着也不算「正在被驱动」', () => {
  const ready = lamp.decideLamp({ enabled: true, drivingUntil: 0, now: NOW });
  assert(ready.level === 'ready', `应 ready，实得 ${ready.level}`);
  assert(ready.active === false, 'ready 不许是 active');
  assert(/空闲/.test(ready.label), 'ready 的标签要说"空闲"');
  console.log(`    {"level":"${ready.level}","label":"${ready.label}"}`);
});

check('只有动作正在执行才亮红灯，而且几秒后自己熄掉', () => {
  const busy = lamp.decideLamp({ enabled: true, drivingUntil: NOW + 4000, now: NOW });
  assert(busy.level === 'busy', `窗口内应 busy，实得 ${busy.level}`);
  assert(busy.active === true, 'busy 必须是 active');
  const expired = lamp.decideLamp({ enabled: true, drivingUntil: NOW - 1, now: NOW });
  assert(expired.level === 'ready', `过期后应回到 ready，实得 ${expired.level}`);
  // 也给"最近一次执行时间"这种形状留一条：窗口按 ACTIVE_MS 算
  const atRecent = lamp.decideLamp({ enabled: true, drivingAt: NOW - 1000, now: NOW });
  assert(atRecent.level === 'busy', '刚执行完 1 秒仍算正在被驱动');
  const atOld = lamp.decideLamp({ enabled: true, drivingAt: NOW - 60_000, now: NOW });
  assert(atOld.level === 'ready', '一分钟前的动作不算');
  console.log(`    {"busy":"${busy.level}","expired":"${expired.level}","recent":"${atRecent.level}","old":"${atOld.level}"}`);
});

check('灯语文案完整：三种状态都有中文说明，且都说清"现在在不在被驱动"', () => {
  for (const level of ['off', 'ready', 'busy']) {
    const info = lamp.LAMP_LEVELS[level];
    assert(info && info.label, `${level} 缺中文标签`);
    assert(info.tone === level, `${level} 的 tone 应与 level 同名（样式按它取）`);
  }
  assert(/没有 agent 接入/.test(lamp.LAMP_LEVELS.off.label), 'off 标签');
  assert(/正在操作/.test(lamp.LAMP_LEVELS.busy.label), 'busy 标签');
  console.log(`    {"levels":${Object.keys(lamp.LAMP_LEVELS).length}}`);
});

check('面板文案带上最近一次动作，并明确标出外部接入的审计缺口', () => {
  const plain = lamp.describeLamp(lamp.decideLamp({ enabled: true, now: NOW }), { lastAction: '2026-11-15T05:00:00.000Z click @ a.test' });
  assert(/最近一次/.test(plain.text), '应带"最近一次"');
  const none = lamp.describeLamp(lamp.decideLamp({ enabled: true, now: NOW }), {});
  assert(/最近还没有动作/.test(none.text), '没有动作时要说"最近还没有动作"');
  const external = lamp.describeLamp(lamp.decideLamp({ enabled: true, now: NOW }), { auditComplete: false });
  assert(/只看得到经过浏览器的部分/.test(external.text), '外部接入要提示审计缺口');
  console.log(`    {"plain":${plain.text.split('\n').length},"external":${external.text.split('\n').length}}`);
});

check('审计不完整不挤进三色灯：灯只有三种，文案分开说', () => {
  const busyExternal = lamp.decideLamp({ enabled: true, drivingUntil: NOW + 1000, now: NOW });
  assert(busyExternal.level === 'busy', '外部模式下"正在被驱动"仍是 busy，不被审计标识盖掉');
  const src = read('src/core/agent-lamp.js');
  assert(!/auditIncomplete|auditLevel/.test(src), '灯模块里不许出现审计等级（那是另一件事）');
  assert(/不能挤进三色灯/.test(src), '注释要写明这两件事分开');
  console.log('    {"busy":true,"separate":true}');
});

check('主进程只在 execute 阶段点亮，result/observe 不算', () => {
  const src = read('src/main.js');
  assert(/if \(stage === 'execute'\) \{[\s\S]{0,120}runtime\.agentDrivingUntil = Date\.now\(\) \+ AGENT_LAMP_ACTIVE_MS/.test(src), 'execute 应置驱动截止时间');
  const touch = src.slice(src.indexOf('function touchAgentSession'), src.indexOf('function touchAgentSession') + 900);
  assert(/stage === 'execute' \|\| stage === 'result' \|\| stage === 'observe'/.test(touch), '续命逻辑仍应覆盖三种阶段（与灯是两件事）');
  console.log('    {"execute":true,"keepAwake":"three-stages"}');
});

check('灯的快照进 agentStatusPayload，界面不用拼三个请求', () => {
  const src = read('src/main.js');
  assert(/lamp: buildAgentLamp\(\)/.test(src), 'agentStatusPayload 应带 lamp');
  assert(/function buildAgentLamp\(\)/.test(src), '缺 buildAgentLamp');
  assert(/agentStopped: runtime\.agentStopped === true/.test(src), '灯要读急停状态');
  assert(/enabled: listening/.test(src), '灯要读本地接口是否在听');
  assert(/auditComplete: \(runtime\.agentMode \|\| 'builtin'\) === 'builtin'/.test(src), '审计完整性按接入模式给');
  console.log('    {"lamp":true,"listening":true}');
});

check('窄面板 IPC：返回灯 + 最近 5 条动作 + 急停状态，并让标签视图让位', () => {
  const src = read('src/main.js');
  assert(/ipcMain\.handle\('nyx:agent:panel'/.test(src), '缺 nyx:agent:panel');
  assert(/runtime\.agentPanelOpen = input\.open;/.test(src), '面板开合要记账');
  assert(/const AGENT_PANEL_W = 302;/.test(src), '面板宽度常量');
  assert(/const agent = runtime\.agentPanelOpen \? AGENT_PANEL_W : 0;/.test(src), '让位宽度要算进面板');
  assert(/agentAudit\.list\(\{ limit: 5 \}\)/.test(src), '只要最近 5 条');
  assert(/preload\.js/.test('preload.js') && /agentPanel: \(payload\) => ipcRenderer\.invoke\('nyx:agent:panel'/.test(read('src/preload.js')), 'preload 要暴露 agentPanel');
  console.log('    {"ipc":true,"width":302}');
});

check('界面上有灯与面板，面板只给"看"和"急停"，不给改配置的入口', () => {
  const html = read('src/renderer/index.html');
  assert(/id="btn-agent-lamp"/.test(html), '缺状态灯按钮');
  assert(/id="agent-lamp-dot"/.test(html), '缺灯点');
  assert(/id="agent-panel"/.test(html), '缺面板容器');
  assert(/id="agent-panel-list"/.test(html), '缺最近动作列表');
  assert(/id="agent-panel-stop"/.test(html), '缺面板内急停按钮');
  assert(/\/settings|去设置/.test(html), '面板里应给"去设置"');
  assert(!/agent-panel[^>]*>[\s\S]{0,600}<input/.test(html), '面板里不该有输入控件（改配置回设置页）');
  const js = read('src/renderer/renderer.js');
  for (const fn of ['applyAgentLamp', 'renderAgentPanel', 'openAgentPanel', 'closeAgentPanel', 'toggleAgentPanel']) {
    assert(new RegExp(`function ${fn}\\(`).test(js), `缺 ${fn}`);
  }
  assert(/agentPanelTimer = setInterval/.test(js), '灯会过期，面板开着要复核');
  console.log('    {"lamp":true,"panel":true,"checks":5}');
});

check('三色只用现有令牌，零新增色值', () => {
  const css = read('src/renderer/style.css');
  assert(/\.agent-lamp-dot\.is-busy \{[\s\S]{0,120}background: var\(--danger\)/.test(css), 'busy 用 --danger');
  assert(/\.agent-lamp-dot\.is-ready \{[\s\S]{0,120}background: var\(--accent\)/.test(css), 'ready 用 --accent');
  const block = css.slice(css.indexOf('agent 状态灯与窄面板'));
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert(hex.length === 0, `面板样式里不许出现写死色值，实得 ${hex.join(',')}`);
  console.log('    {"hex":0,"tokens":"accent/danger"}');
});

if (failures.length) {
  console.log(`\n[agent 状态灯] 未通过：${failures.length} 项`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log(`\n[agent 状态灯] 通过：${passed} 项`);
