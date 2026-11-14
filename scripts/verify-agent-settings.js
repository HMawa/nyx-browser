#!/usr/bin/env node
'use strict';

/**
 * 让 agent 改设置（用户第 6 项）的纯逻辑回归。
 *
 * 这一项最怕的是"给 agent 一把万能钥匙"，所以断言的重点不是"能改"，
 * 而是"改不了什么、什么时候必须确认、改多了会怎样"。
 */

const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const settings = require(path.join(root, 'src', 'core', 'agent-settings'));

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, pass: true, detail });
  } catch (err) {
    checks.push({ name, pass: false, detail: err && err.message ? err.message : String(err) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

check('可改清单形状完整：键、类型、是否需要确认、免责与限流都在', () => {
  const schema = settings.describeSettingsSchema();
  assert(schema.ok === true, 'ok 必须是 true');
  assert(typeof schema.disclaimer === 'string' && schema.disclaimer.length > 20, '免责文案不能空');
  assert(schema.rateLimit && schema.rateLimit.max > 0 && schema.rateLimit.windowMs > 0, '限流规则缺失');
  assert(schema.keys.length >= 5, `可改键太少：${schema.keys.length}`);
  for (const item of schema.keys) {
    assert(typeof item.key === 'string' && item.key, '键名缺失');
    assert(typeof item.label === 'string' && item.label, `${item.key} 缺 label`);
    assert(['boolean', 'enum', 'number'].includes(item.type), `${item.key} 类型不认识：${item.type}`);
    assert(typeof item.needsConfirm === 'boolean', `${item.key} 缺 needsConfirm`);
    if (item.type === 'enum') assert(Array.isArray(item.values) && item.values.length > 0, `${item.key} 枚举没有取值`);
    if (item.type === 'number') assert(Number.isFinite(item.min) && Number.isFinite(item.max), `${item.key} 缺范围`);
  }
  return { keys: schema.keys.length, locked: schema.locked.length };
});

check('隐私与安全相关的键一律锁死，且每条都写了为什么', () => {
  const schema = settings.describeSettingsSchema();
  const lockedKeys = schema.locked.map((item) => item.key);
  for (const key of ['mode', 'privacyLink', 'privateSnapshotEnabled', 'agentMode', 'agentSites']) {
    assert(lockedKeys.includes(key), `${key} 必须是锁死的`);
    const item = schema.locked.find((entry) => entry.key === key);
    assert(item && item.why && item.why.length > 4, `${key} 缺 why`);
  }
  // 锁死的键绝不能同时出现在可改清单里
  for (const key of lockedKeys) {
    assert(!schema.keys.some((item) => item.key === key), `${key} 同时出现在可改与锁死两份清单里`);
  }
  return { lockedKeys };
});

check('锁死的键连问都会被明确拒绝，并说明原因', () => {
  const result = settings.planSettingChange({ key: 'privacyLink', value: 'direct' }, { current: 'proxy' });
  assert(result.ok === false, '必须拒绝');
  assert(result.code === 'LOCKED_KEY', `错误码应为 LOCKED_KEY，实际 ${result.code}`);
  assert(result.locked === true, '要标记 locked');
  assert(/privacyLink/.test(result.error) && result.error.length > 10, '错误里要说清是哪个键、为什么');
  return { code: result.code };
});

check('不认识的键与非法取值都给中文原因，且不落盘', () => {
  const unknown = settings.planSettingChange({ key: 'notExist', value: 1 }, {});
  assert(unknown.ok === false && unknown.code === 'UNKNOWN_KEY', '未知键必须拒绝');

  const badBool = settings.validateSettingValue('offlineCacheEnabled', 'yes');
  assert(badBool.ok === false && badBool.code === 'BAD_VALUE' && /true/.test(badBool.error), '布尔校验文案不对');

  const badEnum = settings.validateSettingValue('theme', 'rainbow');
  assert(badEnum.ok === false && /ink/.test(badEnum.error), '枚举校验要把允许值列出来');

  const badRange = settings.validateSettingValue('tabSleepMinutes', 999);
  assert(badRange.ok === false && /240/.test(badRange.error), '范围校验要写出上限');

  const badInt = settings.validateSettingValue('tabSleepMinutes', 1.5);
  assert(badInt.ok === false && /整数/.test(badInt.error), '小数要拒绝');
  return 'ok';
});

check('需要确认的键：不带 confirm 返回 NEED_CONFIRM，带 confirm 才成功', () => {
  const blocked = settings.planSettingChange(
    { key: 'offlineCacheEnabled', value: false },
    { current: true },
  );
  assert(blocked.ok === false && blocked.code === 'NEED_CONFIRM', '应要求确认');
  assert(/confirm/.test(blocked.message), '要告诉调用方带 confirm 再来');

  const done = settings.planSettingChange(
    { key: 'offlineCacheEnabled', value: false, confirm: true },
    { current: true },
  );
  assert(done.ok === true, '确认后应成功');
  assert(done.summary && done.summary.length > 2, '要有一句"改成了什么"');
  assert(done.disclaimer === settings.SETTING_DISCLAIMER, '每次都要带免责');
  return { summary: done.summary };
});

check('不需要确认的键可以直接改，但同样带免责与摘要', () => {
  const result = settings.planSettingChange({ key: 'theme', value: 'aurora' }, { current: 'ink' });
  assert(result.ok === true, '应直接成功');
  assert(result.value === 'aurora', '值要归一后返回');
  assert(/极光|aurora/.test(result.summary) || /主题/.test(result.summary), '摘要要说清改了什么');
  assert(result.disclaimer.length > 20, '免责不能空');
  return { summary: result.summary };
});

check('值没变化时明确说"什么都没改"，不假装改过', () => {
  const result = settings.planSettingChange({ key: 'theme', value: 'ink' }, { current: 'ink' });
  assert(result.ok === true && result.code === 'NO_CHANGE', '无变化要标记 NO_CHANGE');
  assert(/什么都没改/.test(result.message), '文案要直说没改');
  return { code: result.code };
});

check('限流：一分钟内改满 10 次后拒绝，超出窗口再放行', () => {
  const now = 1_700_000_000_000;
  const history = Array.from({ length: settings.SETTING_RATE_LIMIT }, (_, index) => now - index * 1000);
  const blocked = settings.planSettingChange(
    { key: 'theme', value: 'paper' },
    { current: 'ink', history, now },
  );
  assert(blocked.ok === false && blocked.code === 'RATE_LIMITED', '应触发限流');
  assert(/最多改/.test(blocked.error), '限流要写清规则');

  const later = now + settings.SETTING_RATE_WINDOW_MS + 1;
  const allowed = settings.planSettingChange(
    { key: 'theme', value: 'paper' },
    { current: 'ink', history, now: later },
  );
  assert(allowed.ok === true, '窗口过后应放行');
  return { limit: settings.SETTING_RATE_LIMIT };
});

check('缺 key 时有明确说法，不当成空操作', () => {
  const result = settings.planSettingChange({ value: 1 }, {});
  assert(result.ok === false && result.code === 'MISSING_KEY', '缺 key 要拒绝');
  assert(/key/.test(result.error), '要指出缺的是什么');
  return 'ok';
});

check('渠道接线：dispatch 认得 settings，且改设置必须人工确认', () => {
  const dispatch = read('src/core/agent-dispatch.js');
  assert(/DISPATCH_TYPES = \[[\s\S]*?'settings'/.test(dispatch), 'DISPATCH_TYPES 里没有 settings');
  assert(/CONFIRM_RULES = \{[\s\S]*?settings: \{[\s\S]*?required: true/.test(dispatch), 'settings 必须强制人工确认');
  assert(/case 'settings':/.test(dispatch), 'redactParams 没有 settings 分支');
  assert(/type === 'settings'/.test(dispatch), 'describeTarget 没有处理 settings');

  const actions = read('src/core/actions.js');
  assert(/if \(type === 'settings'\)/.test(actions), 'actions.js 没有 settings 分支');
  assert(/applySetting/.test(actions), 'actions.js 没有注入 applySetting');

  const main = read('src/main.js');
  assert(/applySetting: \(params\) => applyAgentSetting\(params\)/.test(main), 'main.js 没把 applySetting 接上');
  assert(/function applyAgentSetting\(/.test(main), 'main.js 缺 applyAgentSetting');
  assert(/AGENT_SETTINGS_CHANGED/.test(main), '改完要记诊断');
  assert(/AGENT_SETTINGS_SAVE_FAILED/.test(main), '保存失败要有诊断');
  assert(/nyx:agent:settings'/.test(main), '缺只读 IPC');
  return 'ok';
});

check('界面与 MCP 都如实说明边界（可改 / 锁死 / 免责）', () => {
  const html = read('src/renderer/settings.html');
  for (const id of ['agent-settings-badge', 'agent-settings-keys', 'agent-settings-locked', 'agent-settings-disclaimer']) {
    assert(html.includes(`id="${id}"`), `设置页缺 ${id}`);
  }
  assert(/改不了隐私与安全相关的键/.test(html), '界面必须写明隐私键改不了');

  const js = read('src/renderer/settings.js');
  assert(/async function loadAgentSettings\(/.test(js), 'settings.js 缺 loadAgentSettings');
  assert(/loadAgentSettings\(\);/.test(js), 'loadAgentSection 没调 loadAgentSettings');

  const preload = read('src/preload.js');
  assert(/agentSettings: \(\) => ipcRenderer\.invoke\('nyx:agent:settings'\)/.test(preload), 'preload 缺 agentSettings');

  const mcp = read('src/mcp/server.js');
  assert(/'nyx_settings'/.test(mcp), 'MCP 缺 nyx_settings 工具');
  assert(/隐私与安全相关的键/.test(mcp), 'MCP 工具描述要写清边界');
  return 'ok';
});

check('撤销：没有记录时明确说没有可撤销的，不假装成功', () => {
  const plan = settings.planSettingUndo([], { current: 'ink' });
  assert(plan.ok === false, '没有记录时不能报成功');
  assert(plan.code === 'NOTHING_TO_UNDO', `要报 NOTHING_TO_UNDO，实际 ${plan.code}`);
  assert(/没有可撤销/.test(plan.error), '要给中文原因');
  assert(plan.disclaimer === settings.SETTING_DISCLAIMER, '拒绝也要带免责');
  assert(settings.planSettingUndo(null, {}).code === 'NOTHING_TO_UNDO', '传 null 也不能炸');
  return plan.code;
});

check('撤销：回到上一次的旧值，而不是让 agent 再改一次回去', () => {
  const entries = [
    { key: 'theme', value: 'paper', previous: 'ink', at: 1 },
    { key: 'theme', value: 'quiet', previous: 'paper', at: 2 },
  ];
  const plan = settings.planSettingUndo(entries, { current: 'quiet' });
  assert(plan.ok === true, `应当允许撤销：${plan.error || ''}`);
  assert(plan.key === 'theme', '撤销的是最近一条记录的键');
  assert(plan.value === 'paper', `要回滚到上一次改之前的值 paper，实际 ${plan.value}`);
  assert(plan.undo === true, '要标记这是一次撤销');
  assert(/已撤销/.test(plan.message), '文案要说清是撤销');
  assert(/quiet/.test(plan.value) === false, '不许回滚成当前值');
  return plan.value;
});

check('撤销：值已经被人改回去时说清楚，不硬盖人的选择', () => {
  const entries = [{ key: 'theme', value: 'paper', previous: 'ink', at: 1 }];
  const plan = settings.planSettingUndo(entries, { current: 'ink' });
  assert(plan.ok === true, '这不算错误，只是不需要撤销');
  assert(plan.code === 'NO_CHANGE', `要报 NO_CHANGE，实际 ${plan.code}`);
  assert(/不需要再撤销/.test(plan.message), '要说清不需要撤销');
  return plan.code;
});

check('撤销：锁死的键、记录里不认识的键、旧值不合法都拒绝并给原因', () => {
  const locked = settings.planSettingUndo([{ key: 'privacyLink', value: 'direct', previous: 'proxy' }], {});
  assert(locked.ok === false && locked.code === 'LOCKED_KEY', '锁死的键不许撤销');
  assert(locked.locked === true, '要标记 locked');
  const unknown = settings.planSettingUndo([{ key: 'notAKey', value: 1, previous: 0 }], {});
  assert(unknown.ok === false && unknown.code === 'UNKNOWN_KEY', '不认识的键要拒绝');
  const bad = settings.planSettingUndo([{ key: 'tabSleepMinutes', value: 30, previous: 'abc' }], {});
  assert(bad.ok === false && bad.code === 'BAD_VALUE', '旧值不合法要拒绝');
  assert(/撤销不了/.test(bad.error), '要给中文原因');
  return 'ok';
});

check('撤销接线：只走 agent 通道，撤销也要留痕、也要人工确认', () => {
  const main = read('src/main.js');
  assert(/planSettingUndo: planAgentSettingUndo/.test(main), 'main 要引入 planSettingUndo');
  assert(/if \(undo\) \{/.test(main) && /planAgentSettingUndo\(entries/.test(main), 'main 要走撤销分支');
  assert(/runtime\.agentSettingUndo\.push\(/.test(main), '成功修改要记一条可撤销记录');
  assert(/previous/.test(main), '记录里必须有 previous（旧值）');
  assert(main.includes('AGENT_SETTINGS_UNDONE'), '撤销要单独记一条诊断');
  assert(/agentSettingUndo: \[\],/.test(main), '可撤销记录要用空数组初始化');

  const actions = read('src/core/actions.js');
  assert(/params\.undo === true/.test(actions), '执行器要接受 undo:true');

  const dispatch = read('src/core/agent-dispatch.js');
  assert(/undo: source\.undo === true/.test(dispatch), '留痕里要能看见这是一次撤销');
  assert(/（撤销上一次）/.test(dispatch), '留痕的目标一栏要写清是撤销');

  const html = read('src/renderer/settings.html');
  assert(html.includes('id="agent-settings-undo"'), '设置页要如实说明撤销怎么用');
  const js = read('src/renderer/settings.js');
  assert(/payload\.undo/.test(js), '界面要读 undo 状态');
  assert(/agent-settings-undo/.test(js), '界面要渲染撤销说明');
  assert(/不给界面单独开一条路|让 agent 发一次/.test(js + html + main), '要写清撤销只能走 agent 通道');

  const snapshot = read('src/main.js');
  assert(/undo: lastUndo/.test(snapshot), '快照里要带 undo 状态');
  return 'ok';
});

check('产品红线：这一层不许自己联网、不许调生成式接口', () => {
  const source = read('src/core/agent-settings.js');
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  for (const pattern of [/require\(['"]node:http/, /require\(['"]node:https/, /\bfetch\s*\(/, /api\.openai|anthropic|dashscope|deepseek/i]) {
    assert(!pattern.test(code), `agent-settings.js 里出现了不该有的调用：${pattern}`);
  }
  return 'ok';
});

let passed = 0;
let failed = 0;
for (const item of checks) {
  if (item.pass) {
    passed += 1;
    console.log(`✔ ${item.name}`);
  } else {
    failed += 1;
    console.log(`✘ ${item.name}`);
    console.log(`  ${item.detail}`);
  }
}

console.log('');
console.log(`agent 改设置：${checks.length} 项检查，${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
