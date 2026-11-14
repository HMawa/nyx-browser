'use strict';

/**
 * 标签生命周期的纯函数回归（清单 G）。
 *
 * 只测判定，不启动 Electron：真的"睡下去/醒过来"需要渲染进程，
 * 那部分由 scripts/verify-tab-sleep.js 起一个真实实例来验（带小阈值）。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  AGENT_KEEP_AWAKE_MS,
  DEFAULT_SLEEP_AFTER_MS,
  DEFAULT_SLEEP_MINUTES,
  LIFECYCLE_REASONS,
  MIN_SLEEP_AFTER_MS,
  TAB_SLEEP_MINUTES,
  decideTabLifecycle,
  describeLifecycle,
  describeSleepMinutes,
  normalizeSleepAfter,
  normalizeSleepMinutes,
  readSleepAfterFromEnv,
  sleepMinutesToMs,
  summarizeLifecycle,
} = require('../src/core/tab-lifecycle');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✔ ${name}${detail === undefined ? '' : `｜${JSON.stringify(detail)}`}`);
  } catch (err) {
    failures.push({ name, error: err.message });
    console.log(`  ✘ ${name}｜${err.message}`);
  }
}

function expect(actual, want, label) {
  if (actual !== want) {
    throw new Error(`${label || '值'}不符：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
  }
}

function expectTrue(value, label) {
  if (!value) throw new Error(`${label || '条件'}为假`);
}

console.log('标签生命周期回归（清单 G）');

check('1. 默认阈值是 30 分钟，且不低于最小阈值', () => {
  expect(DEFAULT_SLEEP_AFTER_MS, 30 * 60 * 1000, '默认阈值');
  expectTrue(MIN_SLEEP_AFTER_MS >= 1000, '最小阈值');
  expectTrue(DEFAULT_SLEEP_AFTER_MS > MIN_SLEEP_AFTER_MS, '默认阈值应大于最小值');
  return { DEFAULT_SLEEP_AFTER_MS, MIN_SLEEP_AFTER_MS };
});

check('2. 阈值解析：脏值回落、0 表示关闭、过小值被抬到最小阈值', () => {
  expect(normalizeSleepAfter(undefined), DEFAULT_SLEEP_AFTER_MS, 'undefined');
  expect(normalizeSleepAfter('abc'), DEFAULT_SLEEP_AFTER_MS, '非数字');
  expect(normalizeSleepAfter(-1), DEFAULT_SLEEP_AFTER_MS, '负数');
  expect(normalizeSleepAfter(0), 0, '0 表示关闭');
  expect(normalizeSleepAfter(500), MIN_SLEEP_AFTER_MS, '过小值');
  expect(normalizeSleepAfter('1500'), 1500, '字符串数字');
  return { small: normalizeSleepAfter(500), zero: normalizeSleepAfter(0) };
});

check('3. 环境变量旋钮：没有就用默认，有就解析（脏值仍回默认）', () => {
  expect(readSleepAfterFromEnv({}), DEFAULT_SLEEP_AFTER_MS, '无变量');
  expect(readSleepAfterFromEnv({ NYX_TAB_SLEEP_MS: '1500' }), 1500, '有变量');
  expect(readSleepAfterFromEnv({ NYX_TAB_SLEEP_MS: '0' }), 0, '关闭');
  expect(readSleepAfterFromEnv({ NYX_TAB_SLEEP_MS: 'oops' }), DEFAULT_SLEEP_AFTER_MS, '脏值');
  return { env: readSleepAfterFromEnv({ NYX_TAB_SLEEP_MS: '1500' }) };
});

check('4. 当前标签永不休眠（闲置再久、agent 记录再旧也一样）', () => {
  const decision = decideTabLifecycle({
    isActive: true,
    idleMs: 10 * 60 * 60 * 1000,
    sleepAfterMs: 1000,
    agentDrivenUntil: 0,
    now: Date.now(),
  });
  expect(decision.state, 'active', '状态');
  expect(decision.reason, 'active-tab', '原因');
  expect(decision.keepAwake, true, '保持唤醒');
  expect(decision.reasonLabel.length > 0, true, '要有中文原因');
});

check('5. 有 agent 会话在跑时，后台标签一律保持唤醒（清单 G 的关键例外）', () => {
  const decision = decideTabLifecycle({
    isActive: false,
    idleMs: 5 * 60 * 60 * 1000,
    sleepAfterMs: 1000,
    agentSessionActive: true,
    now: 1000,
  });
  expect(decision.state, 'background', '状态');
  expect(decision.reason, 'agent-session', '原因');
  expect(decision.keepAwake, true, '保持唤醒');
});

check('6. agent 刚操作过的标签在保护期内不休眠，过期后照常休眠', () => {
  const now = 10_000_000;
  const fresh = decideTabLifecycle({
    isActive: false,
    idleMs: 60 * 60 * 1000,
    sleepAfterMs: 1000,
    agentDrivenUntil: now + 1000,
    now,
  });
  expect(fresh.state, 'background', '保护期内状态');
  expect(fresh.reason, 'agent-driving', '保护期内原因');
  const stale = decideTabLifecycle({
    isActive: false,
    idleMs: 60 * 60 * 1000,
    sleepAfterMs: 1000,
    agentDrivenUntil: now - 1000,
    now,
  });
  expect(stale.state, 'asleep', '过期后状态');
  return { fresh: fresh.reason, stale: stale.reason, agentKeepMs: AGENT_KEEP_AWAKE_MS };
});

check('7. 后台闲置超过阈值就休眠，且不保持唤醒', () => {
  const decision = decideTabLifecycle({
    isActive: false,
    idleMs: 2000,
    sleepAfterMs: 1000,
    now: 1,
  });
  expect(decision.state, 'asleep', '状态');
  expect(decision.reason, 'idle', '原因');
  expect(decision.keepAwake, false, '保持唤醒');
});

check('8. 后台闲置未到阈值只在后台运行，不睡', () => {
  const decision = decideTabLifecycle({ isActive: false, idleMs: 500, sleepAfterMs: 1000, now: 1 });
  expect(decision.state, 'background', '状态');
  expect(decision.reason, 'idle-below', '原因');
  expect(decision.keepAwake, false, '保持唤醒');
});

check('9. 休眠可关闭：阈值 0 时谁都不睡', () => {
  const decision = decideTabLifecycle({
    isActive: false,
    idleMs: 99 * 60 * 60 * 1000,
    sleepAfterMs: 0,
    now: 1,
  });
  expect(decision.state, 'background', '状态');
  expect(decision.reason, 'no-sleep', '原因');
});

check('10. 被显式排除的标签（如设置页）不参与休眠', () => {
  const decision = decideTabLifecycle({
    isActive: false,
    idleMs: 99 * 60 * 60 * 1000,
    sleepAfterMs: 1000,
    noSleep: true,
    now: 1,
  });
  expect(decision.state, 'background', '状态');
  expect(decision.reason, 'disabled-by-option', '原因');
});

check('11. 已休眠的标签不重复判成"还能继续睡"以外的状态', () => {
  const decision = decideTabLifecycle({ isActive: false, asleep: true, idleMs: 5000, sleepAfterMs: 1000, now: 1 });
  expect(decision.state, 'asleep', '状态');
  expect(decision.reason, 'already-asleep', '原因');
});

check('12. 三种状态都有中文标签', () => {
  const labels = ['active', 'background', 'asleep'].map((state) => describeLifecycle(state));
  expect(labels.every((item) => typeof item === 'string' && item.length >= 2), true, '标签齐全');
  expect(describeLifecycle('asleep'), '已休眠', '休眠标签');
  return { labels };
});

check('13. 汇总能数出在用 / 后台 / 已休眠 / 保持唤醒，并给中文文案', () => {
  const summary = summarizeLifecycle([
    { state: 'active', keepAwake: true },
    { state: 'background', keepAwake: true },
    { state: 'background', keepAwake: false },
    { state: 'asleep', keepAwake: false },
  ]);
  expect(summary.total, 4, '总数');
  expect(summary.active, 1, '在用');
  expect(summary.background, 2, '后台');
  expect(summary.asleep, 1, '已休眠');
  expect(summary.keptAwake, 2, '保持唤醒');
  expectTrue(summary.text.includes('已休眠') && summary.text.includes('保持唤醒'), '文案');
  return { text: summary.text };
});

check('14. 每个原因码都有中文说明（不许出现空原因给用户看）', () => {
  const reasons = Object.keys(LIFECYCLE_REASONS);
  expectTrue(reasons.length >= 8, '原因码数量');
  const empty = reasons.filter((key) => !LIFECYCLE_REASONS[key] || LIFECYCLE_REASONS[key].length < 4);
  expect(empty.length, 0, '空说明');
  expectTrue(describeLifecycle('unknown-state').length > 0, '未知状态也要有兜底文案');
  return { reasons: reasons.length };
});

check('16. 设置页的"分钟"解析可靠：0 是关闭，脏值回默认，越界夹回范围内', () => {
  expect(normalizeSleepMinutes(undefined), DEFAULT_SLEEP_MINUTES, '缺省');
  expect(normalizeSleepMinutes('abc'), DEFAULT_SLEEP_MINUTES, '非数字');
  expect(normalizeSleepMinutes(-3), DEFAULT_SLEEP_MINUTES, '负数');
  expect(normalizeSleepMinutes(0), 0, '0 = 关闭');
  expect(normalizeSleepMinutes('15'), 15, '字符串数字');
  expect(normalizeSleepMinutes(0.6), 1, '小数至少 1 分钟');
  expect(normalizeSleepMinutes(9999), 240, '超过上限夹回 240');
  return { default: DEFAULT_SLEEP_MINUTES, options: TAB_SLEEP_MINUTES };
});

check('17. 分钟换算成毫秒时仍然守住最小阈值，且关闭就是 0', () => {
  expect(sleepMinutesToMs(0), 0, '关闭');
  expect(sleepMinutesToMs(30), 30 * 60 * 1000, '30 分钟');
  expectTrue(sleepMinutesToMs(1) >= MIN_SLEEP_AFTER_MS, '1 分钟应不小于最小阈值');
  return { oneMinute: sleepMinutesToMs(1) };
});

check('18. 说明文案讲清后果：关闭时明说不建议，开启时讲清会重新加载', () => {
  const off = describeSleepMinutes(0);
  expectTrue(off.includes('不会自动休眠'), '关闭文案');
  expectTrue(off.includes('不建议'), '关闭时要提示内存占用代价');
  const on = describeSleepMinutes(30);
  expectTrue(on.includes('30 分钟') && on.includes('重新加载'), '开启文案');
  return { off: off.slice(0, 24), on: on.slice(0, 24) };
});

check('19. 接线守位：判定与执行都在标签管理器里，入口在 main / 外壳', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const tabs = read('src/core/tabs.js');
  const main = read('src/main.js');
  const renderer = read('src/renderer/renderer.js');
  const preload = read('src/preload.js');
  const settingsHtml = read('src/renderer/settings.html');
  const settingsJs = read('src/renderer/settings.js');
  const uiStore = read('src/core/ui-store.js');
  const must = {
    applyLifecycle: tabs.includes('applyLifecycle()') && tabs.includes('sleepAfterMs'),
    sleepAndWake: tabs.includes('sleepTab(tab)') && tabs.includes('wakeTab(tab)'),
    agentDriven: tabs.includes('markAgentDriven(') && tabs.includes('setAgentSessionActive('),
    lifecycleTimer: tabs.includes('startLifecycle()') && tabs.includes('stopLifecycle()'),
    snapshotAsleep: tabs.includes('asleep: Boolean(tab.asleep)'),
    layoutSkipsSleeping: tabs.includes('!tab.asleep && Boolean(tab.view)'),
    mainThreshold: main.includes('readTabSleepAfterMs()') && main.includes('sleepAfterMs:'),
    mainKeepAwake: main.includes('touchAgentSession(') && main.includes('AGENT_SESSION_IDLE_MS'),
    mainStarts: main.includes('runtime.tabManager.startLifecycle()'),
    rendererDim: renderer.includes('is-asleep') && renderer.includes('已休眠'),
    // G 的后续：休眠时长做成设置项
    tabsSetter: tabs.includes('setSleepAfterMs('),
    mainIpc: main.includes("ipcMain.handle('nyx:tabs:sleep'") && main.includes("ipcMain.handle('nyx:tabs:sleep-set'"),
    mainAppliesSaved: main.includes('tabSleepMinutes') && main.includes('setSleepAfterMs(sleepMinutesToMs('),
    preloadApi: preload.includes("invoke('nyx:tabs:sleep')") && preload.includes("invoke('nyx:tabs:sleep-set'"),
    settingsCard: settingsHtml.includes('id="tab-sleep-row"') && settingsHtml.includes('id="btn-tab-sleep-save"'),
    settingsLogic: settingsJs.includes('loadTabSleep()') && settingsJs.includes('tabSleepSet('),
    prefStored: uiStore.includes('tabSleepMinutes:'),
  };
  const bad = Object.keys(must).filter((key) => !must[key]);
  expect(bad.length, 0, `缺少接线：${bad.join(',')}`);
  return must;
});

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure.name}：${failure.error}`);
  process.exit(1);
}
