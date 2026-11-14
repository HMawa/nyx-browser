'use strict';

/**
 * agent 接入模式（清单 A）的纯 Node 回归。
 *
 * 这里不启动 Electron：模式归一、两步确认的状态机、状态载荷都是纯函数。
 * 主进程接线（启动前读盘并开 CDP 端口、IPC、常驻标识）用文件级静态检查覆盖——
 * 「有没有在 ready 之前 appendSwitch」这种事，跑起来反而看不出来（进程已经起来了）。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mode = require('../src/core/agent-mode');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    checks.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
    console.log(`✘ ${name}`);
    console.log(`    ${err && err.message ? err.message : err}`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. 模式归一与默认值                                                  */
/* ------------------------------------------------------------------ */

check('1. 只有两种模式，默认是内置', () => {
  assert.deepEqual(Object.keys(mode.AGENT_MODES).sort(), ['builtin', 'external']);
  assert.equal(mode.DEFAULT_AGENT_MODE, 'builtin');
  assert.equal(mode.normalizeAgentMode(undefined), 'builtin');
  assert.equal(mode.normalizeAgentMode(''), 'builtin');
  assert.equal(mode.normalizeAgentMode('  EXTERNAL '), 'external');
  assert.equal(mode.normalizeAgentMode('cdp'), 'builtin', '不认识的取值必须回默认，不能猜');
});

check('2. 两种模式各自的"审计是否完整 / 是否需要重启"是写死的，不随调用变化', () => {
  assert.equal(mode.AGENT_MODES.builtin.auditComplete, true);
  assert.equal(mode.AGENT_MODES.builtin.needsRestart, false);
  assert.equal(mode.AGENT_MODES.external.auditComplete, false);
  assert.equal(mode.AGENT_MODES.external.needsRestart, true);
  // 两次确认的第 2 步必须带 requiresAck，否则"强提醒"就退化成点两下按钮
  assert.equal(mode.AGENT_MODE_CONFIRM_STEPS.length, 2);
  assert.equal(mode.AGENT_MODE_CONFIRM_STEPS[0].requiresAck === true, false);
  assert.equal(mode.AGENT_MODE_CONFIRM_STEPS[1].requiresAck, true);
});

check('3. 从落盘内容读模式：两种字段名都认，脏数据回默认', () => {
  assert.equal(mode.readAgentModeFromPrefs({ mode: 'external' }), 'external');
  assert.equal(mode.readAgentModeFromPrefs({ agentMode: 'external' }), 'external');
  assert.equal(mode.readAgentModeFromPrefs({ mode: 'EXTERNAL' }), 'external');
  assert.equal(mode.readAgentModeFromPrefs({ mode: 'nonsense' }), 'builtin');
  assert.equal(mode.readAgentModeFromPrefs({}), 'builtin');
  assert.equal(mode.readAgentModeFromPrefs(null), 'builtin');
  assert.equal(mode.readAgentModeFromPrefs('external'), 'builtin', '字符串不是对象，按默认处理');
});

/* ------------------------------------------------------------------ */
/* 2. 切换的两步确认状态机                                              */
/* ------------------------------------------------------------------ */

check('4. 目标就是当前模式：直接说"已经是了"，不进确认流程', () => {
  const plan = mode.planAgentModeSwitch({ current: 'builtin', target: 'builtin' });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'ALREADY_THERE');
  assert.ok(plan.error.includes('已经是'));
});

check('5. 只走了第一步：返回 NEED_CONFIRM 并把下一步要展示的内容带回去', () => {
  const plan = mode.planAgentModeSwitch({ current: 'builtin', target: 'external', stage: 1 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NEED_CONFIRM');
  assert.equal(plan.stepsLeft, 1);
  assert.equal(plan.step.stage, 2);
  assert.ok(plan.step.title.includes('再确认一次'));
  // 没给 stage 也不能直接放过
  const noStage = mode.planAgentModeSwitch({ current: 'builtin', target: 'external' });
  assert.equal(noStage.code, 'NEED_CONFIRM');
});

check('6. 第二步没勾风险确认：NEED_ACK，且不允许悄悄降级成 ok', () => {
  const plan = mode.planAgentModeSwitch({ current: 'builtin', target: 'external', stage: 2 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NEED_ACK');
  assert.ok(plan.error.includes('审计不完整'));
  // 传字符串 "true" 不算勾选——只认布尔 true
  const loose = mode.planAgentModeSwitch({ current: 'builtin', target: 'external', stage: 2, ackRisk: 'true' });
  assert.equal(loose.code, 'NEED_ACK');
});

check('7. 两步走完且勾了确认：记下目标模式，并且明确"还没生效、要重启"', () => {
  const plan = mode.planAgentModeSwitch({ current: 'builtin', target: 'external', stage: 2, ackRisk: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'external');
  assert.equal(plan.needsRestart, true);
  assert.equal(plan.applied, false, '切换不能假装立即生效');
  assert.ok(plan.message.includes('重启'));
  assert.ok(Array.isArray(plan.risks) && plan.risks.length >= 4, '外部模式必须把风险逐条给出');
});

check('8. 从外部切回内置同样要两步确认，也同样要重启', () => {
  const need = mode.planAgentModeSwitch({ current: 'external', target: 'builtin', stage: 1 });
  assert.equal(need.code, 'NEED_CONFIRM');
  const done = mode.planAgentModeSwitch({ current: 'external', target: 'builtin', stage: 2, ackRisk: true });
  assert.equal(done.ok, true);
  assert.equal(done.needsRestart, true);
  assert.equal(done.risks.length, 0, '切回内置不需要再吓人，风险清单应为空');
});

/* ------------------------------------------------------------------ */
/* 3. 给界面的状态载荷                                                  */
/* ------------------------------------------------------------------ */

check('9. 内置模式：审计完整、无横幅、端点为空', () => {
  const payload = mode.agentModePayload({ mode: 'builtin', bootMode: 'builtin', debugPort: 9333 });
  assert.equal(payload.auditComplete, true);
  assert.equal(payload.banner, '');
  assert.equal(payload.restartRequired, false);
  assert.equal(payload.externalEndpoint, 'http://127.0.0.1:9333/json');
  assert.equal(payload.risks.length, 0);
  assert.equal(payload.modes.length, 2);
  assert.equal(payload.steps.length, 2);
});

check('10. 外部模式：审计不完整 + 常驻横幅 + 逐条风险', () => {
  const payload = mode.agentModePayload({ mode: 'external', bootMode: 'external', debugPort: '9444' });
  assert.equal(payload.auditComplete, false);
  assert.ok(payload.banner.includes('审计不完整'));
  assert.equal(payload.restartRequired, false);
  assert.ok(payload.risks.length >= 4);
  assert.ok(payload.externalEndpoint.endsWith(':9444/json'));
});

check('11. 改了还没重启：restartRequired 为真，且能同时看到"落盘值"和"本次实际"', () => {
  const payload = mode.agentModePayload({ mode: 'external', bootMode: 'builtin', debugPort: 9333 });
  assert.equal(payload.mode, 'external');
  assert.equal(payload.bootMode, 'builtin');
  assert.equal(payload.restartRequired, true);
  assert.equal(payload.bootLabel, mode.AGENT_MODES.builtin.label);
});

check('12. 端口缺失时不编造端点地址', () => {
  const payload = mode.agentModePayload({ mode: 'external', bootMode: 'external' });
  assert.equal(payload.debugPort, '');
  assert.equal(payload.externalEndpoint, '');
});

/* ------------------------------------------------------------------ */
/* 4. 主进程接线：必须"启动前"决定，不能在 ready 之后                     */
/* ------------------------------------------------------------------ */

check('13. 主进程在 ready 之前读落盘模式，并按模式下发 CDP 开关', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("require('./core/agent-mode')"), 'main.js 应引用 agent-mode');
  const readIdx = main.indexOf('const BOOT_AGENT_MODE_CONFIG = readBootAgentMode();');
  const switchIdx = main.indexOf("appendSwitch('remote-debugging-port'");
  const readyIdx = main.indexOf('app.whenReady()');
  assert.ok(readIdx > 0, '缺少启动时读取模式的语句');
  assert.ok(switchIdx > readIdx, '应先读模式再决定是否开 CDP 端口');
  assert.ok(readyIdx > switchIdx, 'CDP 端口必须在 app ready 之前开（运行时没有开关）');
  assert.ok(main.includes('AGENT_MODE_SAVE_FAILED'), '落盘失败必须留痕，不能静默');
  assert.ok(main.includes('AGENT_MODE_CHANGED'), '改模式必须留痕');
});

check('14. 主进程注册了接入模式的两个 IPC，且已在 registerIpc 里接线', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("ipcMain.handle('nyx:agent:mode'"));
  assert.ok(main.includes("ipcMain.handle('nyx:agent:mode-set'"));
  const bodyStart = main.indexOf('function registerIpc()');
  assert.ok(bodyStart > 0, '找不到 registerIpc');
  const bodyEnd = main.indexOf('\nfunction ', bodyStart + 10);
  const registerIpc = main.slice(bodyStart, bodyEnd > 0 ? bodyEnd : undefined);
  assert.ok(registerIpc.includes('registerAgentModeIpc();'), 'registerIpc 里必须调用 registerAgentModeIpc');
  assert.ok(main.includes('modeInfo: agentModeStatus()'), '急停状态里要带接入模式，外壳才能常驻标识');
});

check('15. preload 暴露了 agentMode / agentModeSet，设置页有接入模式卡片与两步确认', () => {
  const preload = read('src/preload.js');
  assert.ok(preload.includes("invoke('nyx:agent:mode'"), 'preload 应暴露 agentMode');
  assert.ok(preload.includes("invoke('nyx:agent:mode-set'"), 'preload 应暴露 agentModeSet');

  const html = read('src/renderer/settings.html');
  for (const id of [
    'agent-mode-badge',
    'agent-mode-builtin',
    'agent-mode-external',
    'agent-mode-step2',
    'agent-mode-ack',
    'btn-agent-mode-apply',
    'agent-mode-status',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `settings.html 缺少 #${id}`);
  }

  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('loadAgentMode()'), 'settings.js 应在进分区时加载接入模式');
  assert.ok(js.includes('agentModeSet({ target:'), 'settings.js 应能提交模式切换');
  assert.ok(js.includes('ackRisk: true'), '第二步必须带 ackRisk，不能绕过勾选');
  // 界面文案不允许出现"不再提示"这种可以关掉的强提醒（注释里提到这句不算，先剥掉注释行）
  const modeBlock = js.slice(js.indexOf('接入模式（清单 A）'), js.indexOf('function loadAgentSection()'));
  const codeOnly = modeBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.equal(codeOnly.includes('不再提示'), false, '切换确认不允许提供"不再提示"');
});

check('16. 外壳有常驻的"审计不完整"标识，并随状态推送显示', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.includes('id="agent-mode-flag"'), '外壳缺少常驻标识');
  assert.ok(html.includes('role="status"'), '常驻标识要让读屏软件也能读到');
  const js = read('src/renderer/renderer.js');
  assert.ok(js.includes('function applyAgentModeFlag('), 'renderer.js 应有常驻标识的渲染函数');
  assert.ok(js.includes('modeInfo'), '常驻标识应由状态推送里的 modeInfo 驱动');
});

/* ------------------------------------------------------------------ */

const failed = checks.filter((item) => !item.ok);
const total = checks.length;
console.log('');
console.log(`agent 接入模式（A）：${total} 项检查，${total - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  ✘ ${item.name}｜${item.error}`);
  process.exitCode = 1;
}
