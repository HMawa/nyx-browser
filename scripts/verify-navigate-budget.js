'use strict';

/**
 * agent 导航预算回归（v1.17.17）。
 *
 * 背景：导航上限原来是写死的 15 秒。慢站合法地会超过它，于是 agent 收到"超时失败"，
 * 而页面其实已经开好了；反过来 15 秒对某些站又太长，卡住时干等。现在做成可配。
 *
 * 这个脚本只做纯 Node 断言（不启动 Electron）：一半跑纯函数，一半是静态守卫，
 * 保证"设置里真的能改、动作通道真的读它"。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const budget = require(path.join(ROOT, 'src/core/navigate-budget.js'));

const actionsSource = fs.readFileSync(path.join(ROOT, 'src/core/actions.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(ROOT, 'src/renderer/settings.js'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${name}${detail ? `｜${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? `｜${detail}` : ''}`);
  }
}

console.log('');
console.log('agent 导航预算回归');

/* ---------- ① 常量与边界 ---------- */
check(
  '默认仍是 15 秒，下限 3 秒、上限 60 秒',
  budget.NAVIGATE_BUDGET_DEFAULT === 15000
    && budget.NAVIGATE_BUDGET_MIN === 3000
    && budget.NAVIGATE_BUDGET_MAX === 60000,
  `默认 ${budget.NAVIGATE_BUDGET_DEFAULT} / ${budget.NAVIGATE_BUDGET_MIN}–${budget.NAVIGATE_BUDGET_MAX}`,
);

/* ---------- ② 归一化：合法值原样通过 ---------- */
check('3 秒、15 秒、60 秒都能通过', [
  budget.normalizeNavigateBudget(3000),
  budget.normalizeNavigateBudget(15000),
  budget.normalizeNavigateBudget(60000),
].join(',') === '3000,15000,60000');

/* ---------- ③ 归一化：越界一律 null，不悄悄夹值 ---------- */
const rejected = [
  ['2999', 2999],
  ['60001', 60001],
  ['0', 0],
  ['负数', -15000],
  ['小数', 15000.5],
  ['非数字', 'abc'],
  ['空串', ''],
  ['null', null],
  ['undefined', undefined],
];
const leaky = rejected.filter(([, value]) => budget.normalizeNavigateBudget(value) !== null);
check(
  '越界/小数/非数字/空值全部拒绝（绝不悄悄夹到边界）',
  leaky.length === 0,
  leaky.length ? `漏了：${leaky.map(([label]) => label).join('、')}` : '共 9 种',
);

/* ---------- ④ resolve：非法回默认，合法用它 ---------- */
check(
  'resolveNavigateBudget 非法值回默认、合法值原样',
  budget.resolveNavigateBudget(8000) === 8000
    && budget.resolveNavigateBudget(999999) === budget.NAVIGATE_BUDGET_DEFAULT
    && budget.resolveNavigateBudget('x') === budget.NAVIGATE_BUDGET_DEFAULT,
);

/* ---------- ⑤ 文案 ---------- */
check(
  '报错文案用「秒」而不是「毫秒」，且带一位小数只在需要时',
  budget.describeNavigateBudget(15000) === '15 秒'
    && budget.describeNavigateBudget(4500) === '4.5 秒',
  `${budget.describeNavigateBudget(15000)} / ${budget.describeNavigateBudget(4500)}`,
);

/* ---------- ⑥ 动作执行器真的读它 ---------- */
check(
  '动作执行器引入了导航预算模块，并有可注入的来源',
  /require\('\.\/navigate-budget'\)/.test(actionsSource)
    && /function setNavigateBudgetProvider\(provider\)/.test(actionsSource)
    && /setNavigateBudgetProvider/.test(actionsSource.slice(actionsSource.lastIndexOf('module.exports'))),
);
check(
  'navigate 分支：请求里带了就用请求的（非法则回设置值），没带就用设置值',
  /const requested = params\.timeoutMs;/.test(actionsSource)
    && /resolveNavigateBudget\(requested\)/.test(actionsSource)
    && /currentNavigateBudget\(\)/.test(actionsSource),
);
check(
  '超时文案改成 describeNavigateBudget（不再硬编码「Math.round(budget / 1000) 秒」）',
  /打开这个地址超过 \$\{describeNavigateBudget\(budget\)\}还没完成/.test(actionsSource)
    && !/Math\.round\(budget \/ 1000\)/.test(actionsSource),
);

/* ---------- ⑦ 主进程：偏好读写 + 注入 + IPC ---------- */
check(
  '偏好文件里多了 navigateTimeoutMs，非法值回默认（不是夹值）',
  /function normalizeNavigateTimeout\(value\)/.test(mainSource)
    && /navigateTimeoutMs: nav == null \? NAVIGATE_BUDGET_DEFAULT : nav/.test(mainSource),
);
check(
  '启动时把"读偏好"注入给动作执行器（改设置立刻生效，不用重启）',
  /setNavigateBudgetProvider\(\(\) => readToolboxPrefs\(\)\.navigateTimeoutMs\)/.test(mainSource),
);
check(
  '有一条读、一条写，写失败给中文原因并留痕',
  /ipcMain\.handle\('nyx:tb:navigate-timeout'/.test(mainSource)
    && /ipcMain\.handle\('nyx:tb:navigate-timeout-set'/.test(mainSource)
    && /NAVIGATE_BUDGET_UPDATED/.test(mainSource)
    && /导航预算需要是/.test(mainSource),
);

/* ---------- ⑧ 暴露面与界面 ---------- */
check(
  'preload 暴露了读写两个方法（名字与主进程 IPC 对得上）',
  /tbNavigateTimeout: \(\) => ipcRenderer\.invoke\('nyx:tb:navigate-timeout'\)/.test(preloadSource)
    && /tbNavigateTimeoutSet: \(ms\) => ipcRenderer\.invoke\('nyx:tb:navigate-timeout-set'/.test(preloadSource),
);
check(
  '设置页有这一项（输入框按"秒"填，3–60）',
  settingsHtml.includes('id="nav-budget-ms"')
    && settingsHtml.includes('id="btn-nav-budget-save"')
    && /min="3"[\s\S]{0,80}max="60"/.test(settingsHtml),
);
check(
  '进入外观分区就回读，保存失败不假装成功',
  /loadNavigateBudget\(\);/.test(settingsJs)
    && /保存失败：/.test(settingsJs)
    && /NavigateTimeoutSet\(seconds \* 1000\)/.test(settingsJs),
);

console.log('');
console.log(`agent 导航预算回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ agent 导航预算回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] agent 导航预算回归通过');
}
