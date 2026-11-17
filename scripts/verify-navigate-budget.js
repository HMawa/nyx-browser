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
const {
  formatSiteRules,
  hostMatches,
  parseSiteRules,
  resolveBudgetForUrl,
  sanitizeSiteRules,
} = budget;

const actionsSource = fs.readFileSync(path.join(ROOT, 'src/core/actions.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(ROOT, 'src/core/tabs.js'), 'utf8');
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
  'navigate 分支：请求里带了就用请求的（非法则回设置值），没带就用按站点挑的值',
  /const requested = params\.timeoutMs;/.test(actionsSource)
    && /resolveNavigateBudget\(requested\)/.test(actionsSource)
    && /currentNavigateBudget\(params\.url\)/.test(actionsSource),
);
check(
  '超时文案改成 describeNavigateBudget（不再硬编码「Math.round(budget / 1000) 秒」）',
  /打开这个地址超过 \$\{describeNavigateBudget\(budget\)\}还没完成/.test(actionsSource)
    && !/Math\.round\(budget \/ 1000\)/.test(actionsSource),
);

/* ---------- ⑥b 应用页 navigate 也要按预算等待 ---------- */
check(
  '应用页 navigate 返回 tabId，执行器在 fromAppPage 时继续等加载（不再假成功）',
  /result\.fromAppPage/.test(actionsSource)
    && /waitForTabLoad\(result\.tabId, remaining\)/.test(actionsSource)
    && /tabId: result\.tabId/.test(actionsSource),
);
check(
  '标签层提供 waitForTabLoad：按 did-finish-load / did-fail-load 收敛，超时返回 NAVIGATE_TIMEOUT',
  /waitForTabLoad\(tabId, timeoutMs\)/.test(tabsSource)
    && /did-finish-load/.test(tabsSource)
    && /did-fail-load/.test(tabsSource)
    && /NAVIGATE_TIMEOUT/.test(tabsSource),
);

/* ---------- ⑦ 主进程：偏好读写 + 注入 + IPC ---------- */
check(
  '偏好文件里多了 navigateTimeoutMs，非法值回默认（不是夹值）',
  /function normalizeNavigateTimeout\(value\)/.test(mainSource)
    && /navigateTimeoutMs: nav == null \? NAVIGATE_BUDGET_DEFAULT : nav/.test(mainSource),
);
check(
  '启动时把"按地址挑预算"注入给动作执行器（改设置立刻生效，不用重启）',
  /setNavigateBudgetProvider\(\(url\) => navigateBudgetForUrl\(url\)\)/.test(mainSource)
    && /function navigateBudgetForUrl\(url\)/.test(mainSource)
    && /resolveBudgetForUrl\(prefs\.navigateTimeoutSites, url, prefs\.navigateTimeoutMs\)/.test(mainSource),
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
  'preload 暴露了读写两个方法（名字与主进程 IPC 对得上，写支持带站点规则）',
  /tbNavigateTimeout: \(\) => ipcRenderer\.invoke\('nyx:tb:navigate-timeout'\)/.test(preloadSource)
    && /tbNavigateTimeoutSet: \(payload\) =>/.test(preloadSource)
    && /nyx:tb:navigate-timeout-set/.test(preloadSource),
);
check(
  '设置页有这一项（输入框按"秒"填，3–60，带按站点的文本框）',
  settingsHtml.includes('id="nav-budget-ms"')
    && settingsHtml.includes('id="btn-nav-budget-save"')
    && settingsHtml.includes('id="nav-budget-sites"')
    && /min="3"[\s\S]{0,80}max="60"/.test(settingsHtml),
);
check(
  '进入外观分区就回读，保存失败不假装成功',
  /loadNavigateBudget\(\);/.test(settingsJs)
    && /保存失败：/.test(settingsJs)
    && /tbNavigateTimeoutSet\(\{ navigateTimeoutMs: seconds \* 1000/.test(settingsJs),
);

/* ---------- ⑨ 按站点覆盖（用户要求：慢站单独放宽，不调大全局值） ---------- */
const siteOk = parseSiteRules('example.com=30\n\n# 注释\nblog.example.com=45');
check(
  '多行规则能解析：空行与 # 注释跳过，域名小写归一',
  siteOk.rules.length === 2
    && siteOk.rules[0].host === 'example.com'
    && siteOk.rules[0].ms === 30000
    && siteOk.rules[1].ms === 45000
    && siteOk.errors.length === 0,
  JSON.stringify(siteOk.rules),
);

const siteBad = parseSiteRules('nope\nexample.com=999\nhttps://x.com=20\nfoo=abc');
check(
  '写错的行走整条拒收并点出行号（不悄悄按默认跑）',
  siteBad.rules.length === 0 && siteBad.errors.length === 4 && siteBad.errors[0].startsWith('第 1 行'),
  JSON.stringify(siteBad.errors),
);

check(
  '同一域名写多次按最后一条算，并在 rewritten 里点名',
  (() => {
    const r = parseSiteRules('example.com=10\nexample.com=30');
    return r.rules.length === 1 && r.rules[0].ms === 30000 && r.rewritten.join() === 'example.com';
  })(),
);

check(
  '子域继承，且最长匹配优先（blog 那条赢过整站那条）',
  resolveBudgetForUrl([{ host: 'example.com', ms: 30000 }, { host: 'blog.example.com', ms: 45000 }], 'https://blog.example.com/a', 15000).ms === 45000
    && resolveBudgetForUrl([{ host: 'example.com', ms: 30000 }], 'https://example.com/a', 15000).ms === 30000
    && resolveBudgetForUrl([{ host: 'example.com', ms: 30000 }], 'https://notexample.com/', 8000).ms === 8000
    && hostMatches('example.com', 'blog.example.com') === true
    && hostMatches('example.com', 'anexample.com') === false,
);

check(
  '坏规则在 sanitize 时单条丢掉，坏的不会把整张表废掉',
  (() => {
    const rules = sanitizeSiteRules([{ host: 'ok.com', ms: 20000 }, { host: '.BAD', ms: 5000 }, { host: 'x.com', ms: 999999 }, null]);
    return rules.length === 1 && rules[0].host === 'ok.com';
  })(),
);

check(
  '文本与规则表能来回转（设置页回填不丢条目）',
  formatSiteRules([{ host: 'a.com', ms: 30000 }, { host: 'b.com', ms: 45000 }]) === 'a.com=30\nb.com=45'
    && parseSiteRules(formatSiteRules([{ host: 'a.com', ms: 30000 }])).rules[0].ms === 30000,
);

check(
  '主进程从偏好里读站点规则，并把多行文本回给界面',
  /navigateTimeoutSites: sanitizeSiteRules\(raw && raw\.navigateTimeoutSites\)/.test(mainSource)
    && /sitesText: formatSiteRules\(prefs\.navigateTimeoutSites\)/.test(mainSource)
    && /patch\.navigateTimeoutSites = parsed\.rules/.test(mainSource),
);

check(
  '动作执行器把目标地址传进去（否则站点规则永远不会被用上）',
  /currentNavigateBudget\(params\.url\)/.test(actionsSource)
    && /if \(picked && typeof picked === 'object'\) return resolveNavigateBudget\(picked\.ms\)/.test(actionsSource),
);

console.log('');
console.log(`agent 导航预算回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ agent 导航预算回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] agent 导航预算回归通过');
}
