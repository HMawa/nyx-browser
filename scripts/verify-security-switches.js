'use strict';

/**
 * 外壳防护基线回归（18 项断言，纯 Node，不启动 Electron）。
 *
 * 测什么：`src/core/security-switches.js`——每个窗口角色该有的隔离 / Node 能力 / 沙箱值、
 * 本地页面 CSP 的审计规则、preload 暴露面的风险分类，以及注入演示的判读逻辑。
 *
 * 为什么这些断言要靠"纯函数 + 静态守卫"两条腿：
 *   1. 三个开关是**创建窗口那一刻**的取值，端到端脚本只能在窗口建好之后去看结果，
 *      看不到"少写一行 sandbox: true 会退化成什么"这类反例；
 *   2. 所以把期望值做成表（WINDOW_ROLES）、把判据做成纯函数（auditPreferences /
 *      auditCsp / describeProbeResult），再对源码做静态守卫，防止有人把 sandbox
 *      悄悄关掉而测试仍然全绿。
 *
 * 真实窗口里的注入演示由 `verify-ui-polish.js` 端到端跑，这里只保证"判据没错"。
 *
 * 用法：node scripts/verify-security-switches.js
 *
 * 零第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  SANDBOX_OFF_ALLOWED,
  WINDOW_ROLES,
  auditCsp,
  auditPreferences,
  buildProbeScript,
  buildSwitchesPayload,
  classifyPreloadApi,
  describeProbeResult,
  parseCsp,
  summarizeAudit,
} = require(path.join(ROOT, 'src', 'core', 'security-switches.js'));

const results = [];
function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = out === true || (out && out.ok === true);
    detail = out && typeof out === 'object' ? JSON.stringify(out.detail ?? out) : String(out);
  } catch (err) {
    ok = false;
    detail = `抛异常：${err.message}`;
  }
  results.push({ label, ok, detail });
  console.log(`${ok ? '[Nyx] ✔' : '[Nyx] ✘'} ${label}${detail ? `　｜${detail}` : ''}`);
}

const TAB_PREFS = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const SHELL_PREFS = { contextIsolation: true, nodeIntegration: false, sandbox: false };

check('1. 窗口角色表完整：每个角色都有名字、preload 与期望值', () => {
  const roles = WINDOW_ROLES.map((item) => item.role);
  const unique = new Set(roles).size === roles.length;
  const complete = WINDOW_ROLES.every(
    (item) =>
      typeof item.role === 'string' &&
      item.role.length > 0 &&
      typeof item.label === 'string' &&
      item.label.length > 0 &&
      typeof item.preload === 'string' &&
      item.preload.length > 0 &&
      item.expect &&
      typeof item.expect.contextIsolation === 'boolean' &&
      typeof item.expect.nodeIntegration === 'boolean' &&
      typeof item.expect.sandbox === 'boolean' &&
      typeof item.why === 'string' &&
      item.why.length > 10,
  );
  return { ok: unique && complete, detail: { count: roles.length, 角色: roles, 唯一: unique, 完整: complete } };
});

check('2. 允许关沙箱的角色只能是白名单里那四个（外壳 / 应用页 / 注入演示 / 首次引导）', () => {
  const expect = ['app-page', 'onboarding', 'probe', 'shell'].sort();
  const actual = [...SANDBOX_OFF_ALLOWED].sort();
  return {
    ok: expect.length === actual.length && expect.every((role, i) => role === actual[i]),
    detail: { 允许关沙箱: actual },
  };
});

check('3. 网页标签按声明配置 → 三项全对', () => {
  const audit = auditPreferences('tab', TAB_PREFS);
  return { ok: audit.ok === true && audit.mismatched === 0, detail: { ok: audit.ok, rows: audit.rows.length } };
});

check('4. 网页标签把沙箱关掉 → 当场红，并指出是哪一项', () => {
  const audit = auditPreferences('tab', { contextIsolation: true, nodeIntegration: false, sandbox: false });
  const row = audit.rows.find((item) => item.key === 'sandbox');
  return {
    ok: audit.ok === false && row && row.match === false && audit.mismatched === 1,
    detail: { ok: audit.ok, 沙箱行: row, note: audit.note },
  };
});

check('5. 网页标签少写 sandbox → 按 Electron 默认（关）判定为不一致，并说明是"没写"', () => {
  const audit = auditPreferences('tab', { contextIsolation: true, nodeIntegration: false });
  const row = audit.rows.find((item) => item.key === 'sandbox');
  return {
    ok: audit.ok === false && row && row.match === false && row.declared === false && /没写这一项/.test(row.note),
    detail: { 沙箱行: row },
  };
});

check('6. 外壳少写 contextIsolation → 靠默认值成立，但标注"建议显式声明"', () => {
  const audit = auditPreferences('shell', { nodeIntegration: false, sandbox: false });
  const row = audit.rows.find((item) => item.key === 'contextIsolation');
  return {
    ok: audit.ok === true && row && row.match === true && row.declared === false && /显式声明/.test(row.note),
    detail: { 隔离行: row },
  };
});

check('7. 未登记的角色 → 报"未登记的窗口角色"，不给通过', () => {
  const audit = auditPreferences('mystery', { sandbox: true });
  return {
    ok: audit.ok === false && /未登记的窗口角色/.test(audit.note),
    detail: { note: audit.note },
  };
});

check('8. 汇总：一个角色红就整表红，且带上是哪个', () => {
  const good = auditPreferences('tab', TAB_PREFS);
  const bad = auditPreferences('shell', { contextIsolation: false, nodeIntegration: true, sandbox: false });
  const summary = summarizeAudit([good, bad]);
  return {
    ok: summary.ok === false && summary.badCount === 1 && /外壳/.test(summary.note),
    detail: summary,
  };
});

check('9. 取 CSP：双引号 / 单引号 / 没有都处理对', () => {
  const html1 = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';
  const html2 = "<meta http-equiv='Content-Security-Policy' content=\"default-src 'self'; script-src 'self'\">";
  const html3 = '<meta charset="utf-8">';
  const a = parseCsp(html1);
  const b = parseCsp(html2);
  const c = parseCsp(html3);
  return {
    ok: a === "default-src 'self'" && b === "default-src 'self'; script-src 'self'" && c === null,
    detail: { 双引号: a, 单引号: b, 没有: c },
  };
});

check('10. 没写 CSP 的页面 → 判"缺失"，不许当成"没关系"', () => {
  const verdict = auditCsp(null);
  return {
    ok: verdict.found === false && verdict.ok === false && verdict.warnings.length === 1,
    detail: verdict,
  };
});

check('11. 过宽的 CSP 会被点名：unsafe-eval / unsafe-inline / 通配来源', () => {
  const evalVerdict = auditCsp("default-src 'self'; script-src 'unsafe-eval'");
  const inlineVerdict = auditCsp("default-src 'self'; script-src 'self' 'unsafe-inline'");
  const wildcardVerdict = auditCsp("default-src 'self'; script-src *");
  const noDefault = auditCsp("script-src 'self'");
  const ok =
    evalVerdict.ok === false &&
    evalVerdict.warnings.some((w) => /unsafe-eval/.test(w)) &&
    inlineVerdict.ok === false &&
    inlineVerdict.warnings.some((w) => /unsafe-inline/.test(w)) &&
    wildcardVerdict.ok === false &&
    wildcardVerdict.warnings.some((w) => /\*/.test(w)) &&
    noDefault.ok === false &&
    noDefault.warnings.some((w) => /default-src/.test(w));
  return {
    ok,
    detail: {
      eval: evalVerdict.warnings,
      inline: inlineVerdict.warnings,
      wildcard: wildcardVerdict.warnings,
      noDefault: noDefault.warnings,
    },
  };
});

check('12. 正常的窄 CSP 判通过（本仓库各页在用的那种写法）', () => {
  const verdict = auditCsp(
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;",
  );
  return { ok: verdict.ok === true && verdict.warnings.length === 0, detail: verdict.warnings };
});

check('13. 暴露面按"能干什么"分类：写文件 / 开目录 / 重启都要标成高风险', () => {
  const api = classifyPreloadApi([
    'exportDiagnostics',
    'restartApp',
    'revealInFolder',
    'copyUrl',
    'navigate',
    'openSettings',
    'mysteryToken',
  ]);
  const byKey = new Map(api.groups.map((group) => [group.key, group]));
  const fileWrite = byKey.get('file-write');
  const fileOpen = byKey.get('file-open');
  const processGroup = byKey.get('process');
  const ok =
    fileWrite &&
    fileWrite.keys.includes('exportDiagnostics') &&
    fileOpen &&
    fileOpen.keys.includes('revealInFolder') &&
    processGroup &&
    processGroup.keys.includes('restartApp') &&
    api.ungrouped.includes('mysteryToken') &&
    api.highRiskKeys === 3;
  return { ok, detail: { highRiskKeys: api.highRiskKeys, note: api.note, ungrouped: api.ungrouped } };
});

check('14. 汇总载荷：数字自洽，且把"没创建过的窗口"单列而不是算作通过', () => {
  const payload = buildSwitchesPayload({
    audits: [auditPreferences('tab', TAB_PREFS)],
    cspFiles: [
      { file: 'a.html', ok: true, found: true, policy: "default-src 'self'", warnings: [] },
      { file: 'b.html', ok: false, found: false, policy: '', warnings: ['这份页面没有写 CSP'] },
    ],
    preloadKeys: ['navigate', 'restartApp'],
  });
  return {
    ok:
      payload.ok === true &&
      payload.summary.windowCount === 1 &&
      payload.summary.cspFiles === 2 &&
      payload.summary.cspBadCount === 1 &&
      payload.summary.preloadKeys === 2 &&
      payload.summary.highRiskKeys === 1,
    detail: payload.summary,
  };
});

check('15. 注入演示脚本本身：去拿 require / 动态求值 / 改写暴露面，一个都不少', () => {
  const script = buildProbeScript();
  const ok =
    typeof script === 'string' &&
    script.includes("typeof require === 'undefined'") &&
    script.includes("typeof process === 'undefined'") &&
    script.includes("new Function('return typeof require')") &&
    script.includes('Object.isFrozen') &&
    script.includes('bridgeWriteIgnored') &&
    script.includes('return {');
  return { ok, detail: { 长度: script.length } };
});

check('16. 判读：全都挡住才算通过；有一条没挡住就要点名', () => {
  const allBlocked = describeProbeResult({
    checks: [
      { name: 'require()', blocked: true, detail: '没有 require' },
      { name: 'process', blocked: true, detail: '没有 process' },
    ],
    bridgeKeys: ['navigate', 'createTab'],
    bridgeFrozen: true,
    bridgeWriteIgnored: true,
  });
  const leaked = describeProbeResult({
    checks: [
      { name: 'require()', blocked: false, detail: '拿到了 require' },
      { name: 'process', blocked: true, detail: '没有 process' },
    ],
    bridgeKeys: ['navigate'],
    bridgeFrozen: false,
    bridgeWriteIgnored: false,
  });
  const empty = describeProbeResult(null);
  return {
    ok:
      allBlocked.ok === true &&
      /全部被挡住/.test(allBlocked.summary) &&
      leaked.ok === false &&
      leaked.failed.length === 1 &&
      /require\(\)/.test(leaked.summary) &&
      empty.ok === false &&
      /没有回传/.test(empty.summary),
    detail: { 全挡: allBlocked.summary, 泄漏: leaked.summary, 空: empty.summary },
  };
});

check('17. 静态守卫：窗口创建处必须登记角色，且关沙箱只出现在白名单位置', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const tabs = fs.readFileSync(path.join(ROOT, 'src', 'core', 'tabs.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');

  const registerCalls = (main.match(/registerSecurityWindow\('/g) || []).length;
  const sandboxOffInMain = (main.match(/sandbox: false/g) || []).length;
  const sandboxOffInTabs = (tabs.match(/sandbox: false/g) || []).length;

  const detail = {
    mainRegisterCalls: registerCalls,
    mainSandboxOff: sandboxOffInMain,
    tabsSandboxOff: sandboxOffInTabs,
    tabsRegister: tabs.includes("onSecurityWindow('tab'") && tabs.includes("onSecurityWindow('app-page'"),
    ipcHandlers:
      main.includes("ipcMain.handle('nyx:security:switches'") &&
      main.includes("ipcMain.handle('nyx:security:probe'"),
    preloadSurface: preload.includes('securitySwitches:') && preload.includes('securityProbe:'),
    settingsCard: html.includes('id="security-switches-roles"') && html.includes('id="btn-security-probe"'),
    settingsLogic: settingsJs.includes('loadSecuritySwitches') && settingsJs.includes('runSecurityProbe'),
  };
  // 关沙箱的地方必须正好是"外壳 + 注入演示 + 首次引导"（main.js 三处）与"应用页"（tabs.js 一处）
  const ok =
    registerCalls >= 7 &&
    sandboxOffInMain === 3 &&
    sandboxOffInTabs === 1 &&
    detail.tabsRegister &&
    detail.ipcHandlers &&
    detail.preloadSurface &&
    detail.settingsCard &&
    detail.settingsLogic;
  return { ok, detail };
});

check('18. 每个本地页面都写了 CSP（新增页面漏写会在这里被抓住）', () => {
  const dir = path.join(ROOT, 'src', 'renderer');
  const files = fs.readdirSync(dir).filter((name) => /\.html$/i.test(name));
  const rows = files.map((name) => {
    const html = fs.readFileSync(path.join(dir, name), 'utf8');
    const verdict = auditCsp(parseCsp(html));
    return { file: name, ok: verdict.ok, warnings: verdict.warnings };
  });
  const bad = rows.filter((item) => !item.ok);
  return { ok: bad.length === 0 && rows.length >= 7, detail: { 页面数: rows.length, 不合格: bad } };
});

check('19. 现值表书面记录存在，且把"已知边界"写出来（不假装安全）', () => {
  const docPath = path.join(ROOT, 'docs', 'Nyx-安全基线-C3-外壳防护.md');
  if (!fs.existsSync(docPath)) return { ok: false, detail: '文档不存在' };
  const doc = fs.readFileSync(docPath, 'utf8');
  const need = ['三个关键开关的现值', '本地页面 CSP 现值', 'preload 暴露面现值', '拦截演示', '已知边界'];
  const missing = need.filter((word) => !doc.includes(word));
  return {
    ok: missing.length === 0 && doc.length > 1500,
    detail: { 字节: Buffer.byteLength(doc, 'utf8'), 缺章节: missing },
  };
});

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.error(`[Nyx] 外壳防护基线回归失败：${failed.length}/${results.length} 项未通过`);
  for (const item of failed) console.error(`         ✘ ${item.label}　｜${item.detail}`);
  process.exitCode = 1;
} else {
  console.log(`[Nyx] 外壳防护基线回归通过：${results.length}/${results.length} 项全绿`);
  process.exitCode = 0;
}
