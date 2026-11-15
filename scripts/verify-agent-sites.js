'use strict';

/**
 * 站点三层授权（清单 E）的纯 Node 回归。
 *
 * 这里不启动 Electron：名单匹配、优先级、脏数据清洗都是纯函数，
 * 起窗口反而会把这些 bug 藏起来（弹窗一挡，断言根本跑不到判定）。
 * 主进程接线（弹窗、IPC、落盘）用文件级静态检查覆盖。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sites = require('../src/core/agent-sites');
const dispatch = require('../src/core/agent-dispatch');

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
/* 1. 域名归一                                                         */
/* ------------------------------------------------------------------ */

check('1. 域名归一：整条 URL、带端口、大写、末尾点都整成同一个 host', () => {
  assert.equal(sites.normalizeHost('https://A.B.com:8443/x?y=1#z'), 'a.b.com');
  assert.equal(sites.normalizeHost('  B.COM.  '), 'b.com');
  assert.equal(sites.normalizeHost('example.com:443'), 'example.com');
  assert.equal(sites.normalizeHost('localhost'), 'localhost');
});

check('2. 域名归一：拿不到合法域名时返回空串（不搞"差不多匹配"）', () => {
  for (const bad of ['', '   ', 'not-a-host', 'a..b.com', '.b.com', 'http://', '[::1]:8080', null, undefined, 42]) {
    assert.equal(sites.normalizeHost(bad), '', `「${String(bad)}」应该判非法`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. 规则匹配                                                         */
/* ------------------------------------------------------------------ */

check('3. 子域继承：登记 b.com 也覆盖 a.b.com，但不会误伤 notb.com', () => {
  const rule = sites.normalizeRule('b.com');
  assert.equal(sites.ruleMatches(rule, 'b.com'), true);
  assert.equal(sites.ruleMatches(rule, 'a.b.com'), true);
  assert.equal(sites.ruleMatches(rule, 'x.y.b.com'), true);
  assert.equal(sites.ruleMatches(rule, 'notb.com'), false);
  assert.equal(sites.ruleMatches(rule, 'b.com.evil.net'), false);
});

check('4. 规则整形成对象时补 mode/note/addedAt，脏输入返回 null', () => {
  const rule = sites.normalizeRule({ target: 'Example.com', mode: 'prefix', note: '测试', addedAt: 1234 }, 9999);
  assert.equal(rule.target, 'example.com');
  assert.equal(rule.mode, 'prefix');
  assert.equal(rule.note, '测试');
  assert.equal(rule.addedAt, 1234);
  assert.equal(sites.normalizeRule({ target: 'nope' }), null);
  assert.equal(sites.normalizeRule(null), null);
});

/* ------------------------------------------------------------------ */
/* 3. 三层判定与优先级                                                 */
/* ------------------------------------------------------------------ */

check('5. 两边都没命中就"问一次"（并且说清楚是哪个站点）', () => {
  const verdict = sites.evaluateSite({
    site: 'https://shop.example.org/cart',
    policy: { globalEnabled: true, allow: [], block: [] },
  });
  assert.equal(verdict.decision, 'ask');
  assert.equal(verdict.host, 'shop.example.org');
  assert.match(verdict.message, /需要你确认一次/);
});

check('6. 白名单进站默认放行，并在文案里说清"动作级确认不豁免"', () => {
  const verdict = sites.evaluateSite({
    site: 'a.b.com',
    policy: { globalEnabled: true, allow: ['b.com'], block: [] },
  });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.layer, sites.LAYERS.allow);
  assert.match(verdict.message, /仍会单独问你/);
});

check('7. 屏蔽优先：同一域名同时在两张名单里时拒绝', () => {
  const policy = { globalEnabled: true, allow: ['b.com'], block: ['b.com'] };
  const verdict = sites.evaluateSite({ site: 'a.b.com', policy });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.layer, sites.LAYERS.block);
  assert.equal(sites.listConflicts(policy).length, 1);
});

check('8. 屏蔽优先：屏蔽命中时即使有会话信任也拒绝', () => {
  const verdict = sites.evaluateSite({
    site: 'b.com',
    policy: { globalEnabled: true, allow: [], block: ['b.com'] },
    sessionTrusted: ['b.com'],
  });
  assert.equal(verdict.decision, 'deny');
});

check('9. 本次会话信任只活在内存里（传入才有，重启就没了）', () => {
  const policy = { globalEnabled: true, allow: [], block: [] };
  const cold = sites.evaluateSite({ site: 'b.com', policy, sessionTrusted: [] });
  const warm = sites.evaluateSite({ site: 'b.com', policy, sessionTrusted: ['B.COM'] });
  assert.equal(cold.decision, 'ask');
  assert.equal(warm.decision, 'allow');
  assert.equal(warm.layer, sites.LAYERS.session);
});

check('10. 全局关着一律不动——白名单也不能绕过', () => {
  const verdict = sites.evaluateSite({
    site: 'b.com',
    policy: { globalEnabled: false, allow: ['b.com'], block: [] },
  });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.layer, sites.LAYERS.global);
  assert.match(verdict.message, /什么也做不了/);
});

check('11. 没有可识别站点的页面一律拒绝，并说明原因', () => {
  const verdict = sites.evaluateSite({
    site: 'about:blank',
    policy: { globalEnabled: true, allow: ['b.com'], block: [] },
  });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.layer, sites.LAYERS.noSite);
  assert.match(verdict.message, /没有可识别的域名/);
});

/* ------------------------------------------------------------------ */
/* 4. 名单维护                                                         */
/* ------------------------------------------------------------------ */

check('12. 加名单：非法域名把原因说清楚，重复条目不重复加', () => {
  const bad = sites.addRule([], 'not a host');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不是一个域名/);
  assert.match(bad.error, /example\.com/);

  const first = sites.addRule([], 'https://b.com/x');
  assert.equal(first.ok, true);
  assert.equal(first.list.length, 1);
  assert.equal(first.list[0].target, 'b.com');

  const again = sites.addRule(first.list, 'B.COM');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal(again.list.length, 1);
});

check('13. 删名单：命中就删、没命中要说"不在这张名单里"', () => {
  const list = sites.addRule([], 'b.com').list;
  const removed = sites.removeRule(list, 'B.com:443');
  assert.equal(removed.ok, true);
  assert.equal(removed.list.length, 0);

  const missing = sites.removeRule(list, 'c.com');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不在这张名单里/);
});

check('14. 读盘清洗：脏数据只丢坏条目，不整体失效；默认全局开启', () => {
  const policy = sites.sanitizePolicy({
    globalEnabled: undefined,
    allow: ['b.com', 'b.com', 'bad host', null, { target: 'c.com' }],
    block: ['d.com'],
  });
  assert.equal(policy.globalEnabled, true);
  assert.deepEqual(policy.allow.map((rule) => rule.target), ['b.com', 'c.com']);
  assert.deepEqual(policy.block.map((rule) => rule.target), ['d.com']);

  const empty = sites.sanitizePolicy(null);
  assert.equal(empty.globalEnabled, true);
  assert.equal(empty.allow.length, 0);
});

check('15. 会话信任：加一次只增一项，域名非法时如实报错', () => {
  const added = sites.addSessionTrust([], 'https://b.com/x');
  assert.equal(added.ok, true);
  assert.deepEqual(added.hosts, ['b.com']);
  const again = sites.addSessionTrust(added.hosts, 'b.com');
  assert.equal(again.hosts.length, 1);
  const bad = sites.addSessionTrust(again.hosts, 'about:blank');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /没有可识别的域名/);
});

check('16. 状态包：带 summary、冲突与当前站点判读，设置页只渲染不判读', () => {
  const payload = sites.agentSitesPayload({
    policy: { globalEnabled: true, allow: ['b.com'], block: ['b.com'] },
    sessionTrusted: ['c.com'],
    site: 'a.b.com',
  });
  assert.equal(payload.ok, true);
  assert.match(payload.summary, /白名单 1 条，屏蔽名单 1 条/);
  assert.deepEqual(payload.conflicts, ['b.com']);
  assert.equal(payload.current.decision, 'deny');
  assert.equal(payload.current.layer, sites.LAYERS.block);
  assert.deepEqual(payload.sessionTrusted, ['c.com']);
  assert.equal(payload.limits.maxRules, sites.MAX_RULES);
});

/* ------------------------------------------------------------------ */
/* 5. URL 前缀规则                                                     */
/* ------------------------------------------------------------------ */

check('20. URL 前缀规则：target 保留路径，查询串与末尾斜杠都去掉', () => {
  assert.equal(sites.normalizePath('/Admin/Users/?tab=1#x'), '/admin/users');
  assert.equal(sites.normalizePath('/'), '');
  const rule = sites.normalizeRule({ target: 'https://Example.com/Admin/Users/?tab=1', mode: 'prefix' });
  assert.equal(rule.mode, 'prefix');
  assert.equal(rule.target, 'example.com/admin/users');
  assert.equal(sites.normalizeRule({ target: 'example.com', mode: 'prefix' }).target, 'example.com');
});

check('21. URL 前缀规则只覆盖该路径及以下，不顺手放行同站其它路径', () => {
  const rule = sites.normalizeRule({ target: 'example.com/admin', mode: 'prefix' });
  assert.equal(sites.ruleMatches(rule, 'example.com', 'example.com/admin'), true);
  assert.equal(sites.ruleMatches(rule, 'example.com', 'example.com/admin/users'), true);
  assert.equal(sites.ruleMatches(rule, 'example.com', 'example.com/administrator'), false);
  assert.equal(sites.ruleMatches(rule, 'example.com', 'example.com/blog'), false);

  const allow = sites.addRule([], { target: 'example.com/admin', mode: 'prefix' }).list;
  const policy = { globalEnabled: true, allow, block: [] };
  const inAdmin = sites.evaluateSite({ site: 'https://example.com/admin/users', policy });
  const inBlog = sites.evaluateSite({ site: 'https://example.com/blog', policy });
  assert.equal(inAdmin.decision, 'allow');
  assert.equal(inAdmin.rule.mode, 'prefix');
  assert.equal(inBlog.decision, 'ask');
});

check('22. 前缀规则也参与"屏蔽优先"：整站白名单 + 单路径屏蔽 → 只有该路径被拒', () => {
  const allow = sites.addRule([], 'example.com').list;
  const block = sites.addRule([], { target: 'example.com/admin', mode: 'prefix' }).list;
  const policy = { globalEnabled: true, allow, block };
  // layer 是给人看的中文层名，这里断言的是"哪一层拦住的"，不是内部枚举
  assert.equal(sites.evaluateSite({ site: 'https://example.com/admin/x', policy }).layer, '屏蔽名单');
  assert.equal(sites.evaluateSite({ site: 'https://example.com/blog', policy }).layer, '白名单');
  // 两条不同模式的同名目标不算冲突：example.com 与 example.com/admin 是两回事
  assert.deepEqual(sites.listConflicts(policy), []);
});

check('23. 前缀规则能与域名规则共存，删除时按模式只删一条', () => {
  let list = sites.addRule([], 'example.com').list;
  list = sites.addRule(list, { target: 'example.com/admin', mode: 'prefix' }).list;
  assert.equal(list.length, 2);
  const removedPrefix = sites.removeRule(list, 'example.com/admin', 'prefix');
  assert.equal(removedPrefix.ok, true);
  assert.equal(removedPrefix.list.length, 1);
  assert.equal(removedPrefix.list[0].mode, 'host');
  const removedHost = sites.removeRule(removedPrefix.list, 'example.com', 'host');
  assert.equal(removedHost.ok, true);
  assert.equal(removedHost.list.length, 0);
  // 再次删除要明确说不在这张名单里，不能假装成功
  assert.equal(sites.removeRule(removedHost.list, 'example.com', 'host').ok, false);
});

check('24. 前缀非法输入有专门的中文原因，不会被静默吞掉', () => {
  const bad = sites.addRule([], { target: 'http://', mode: 'prefix' });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes('URL'), `应提到 URL：${bad.error}`);
  assert.equal(bad.list.length, 0);
});

/* ------------------------------------------------------------------ */
/* 6. 接线静态守卫                                                     */
/* ------------------------------------------------------------------ */

check('17. 主进程接线：判定走纯函数、拒绝留痕、名单落盘、IPC 已挂', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("require('./core/agent-sites')"), 'main.js 应 require agent-sites');
  assert.ok(main.includes('evaluateSite({'), '判定应调 evaluateSite');
  assert.ok(main.includes('askAgentSiteTrust('), '未命中时应弹进站确认');
  assert.ok(main.includes("'agent-sites.json'"), '名单应落盘 agent-sites.json');
  assert.ok(main.includes('registerAgentSitesIpc();'), 'registerIpc 里应调用 registerAgentSitesIpc');
  assert.ok(main.includes("ipcMain.handle('nyx:agent:sites'"), '应有 nyx:agent:sites');
  assert.ok(main.includes("ipcMain.handle('nyx:agent:sites-set'"), '应有 nyx:agent:sites-set');
  // 判定必须能等到人工点按，否则"进站问一次"是假的
  assert.ok(main.includes('async function authorizeAgentAction'), 'authorizeAgentAction 必须是 async');
  assert.ok(read('src/core/agent-dispatch.js').includes('await authorize('), '通道必须 await 判定结果');
});

check('18. 白名单不豁免动作级确认：输入与下载仍在 CONFIRM_RULES 里', () => {
  assert.ok(dispatch.CONFIRM_RULES.type, '输入文字必须每次人工确认');
  assert.ok(dispatch.CONFIRM_RULES.download, '下载必须每次人工确认');
  const main = read('src/main.js');
  assert.ok(main.includes('白名单只代表'), '文案要说明白名单不等于动作放行');
});

check('19. 界面接线：设置页有名单卡与开关，preload 暴露两个方法', () => {
  const html = read('src/renderer/settings.html');
  for (const id of [
    'agent-sites-badge',
    'agent-sites-global',
    'agent-allow-input',
    'btn-agent-allow-add',
    'agent-allow-list',
    'agent-block-input',
    'btn-agent-block-add',
    'agent-block-list',
    'btn-agent-session-clear',
    'agent-sites-status',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `settings.html 缺少 #${id}`);
  }
  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('loadAgentSites()'), 'settings.js 应在进分区时加载名单');
  assert.ok(js.includes('setAgentSites('), 'settings.js 应能改名单');
  const preload = read('src/preload.js');
  assert.ok(preload.includes("invoke('nyx:agent:sites'"), 'preload 应暴露 agentSites');
  assert.ok(preload.includes("invoke('nyx:agent:sites-set'"), 'preload 应暴露 agentSitesSet');
});

check('25. 导出是一份能自我说明的 JSON：带 kind/version/时间，规则保留模式（候选④）', () => {
  const policy = sites.sanitizePolicy({
    globalEnabled: false,
    allow: [{ target: 'example.com', mode: 'host' }, { target: 'example.com/admin', mode: 'prefix' }],
    block: [{ target: 'evil.test', mode: 'host' }],
  });
  const out = sites.exportPolicy(policy, 1_700_000_000_000);
  assert.equal(out.app, 'nyx');
  assert.equal(out.kind, 'agent-sites');
  assert.equal(out.version, sites.EXPORT_VERSION, '导出的版本号要与模块声明一致');
  assert.equal(out.exportedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(out.globalEnabled, false);
  assert.deepEqual(out.allow.map((rule) => `${rule.mode}:${rule.target}`), ['host:example.com', 'prefix:example.com/admin']);
  assert.deepEqual(out.block.map((rule) => `${rule.mode}:${rule.target}`), ['host:evil.test']);
});

check('26. 导入默认合并：新条目加进去，已存在的算重复而不是报错', () => {
  const current = sites.sanitizePolicy({ allow: [{ target: 'example.com', mode: 'host' }], block: [] });
  const file = JSON.stringify({
    kind: 'agent-sites',
    allow: [{ target: 'example.com', mode: 'host' }, { target: 'news.test', mode: 'prefix' }],
    block: [{ target: 'evil.test', mode: 'host' }],
  });
  const result = sites.importPolicy(file, current, { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2, '新增的应该是一条白名单 + 一条屏蔽');
  assert.equal(result.duplicates, 1, 'example.com 已存在，应计为重复');
  assert.equal(result.rejectedCount, 0);
  assert.ok(result.policy.allow.some((rule) => rule.target === 'news.test' && rule.mode === 'prefix'));
  assert.ok(result.policy.block.some((rule) => rule.target === 'evil.test'));
  assert.ok(/条/.test(result.summary), 'summary 要用人话报数');
});

check('27. 导入坏文件给中文原因，不当成「导入成功但啥都没变」', () => {
  const current = sites.sanitizePolicy(null);
  const badJson = sites.importPolicy('{ not json', current);
  assert.equal(badJson.ok, false);
  assert.ok(/不是 JSON/.test(badJson.error), badJson.error);

  const notObject = sites.importPolicy('[1,2,3]', current);
  assert.equal(notObject.ok, false);
  assert.ok(/不是一份名单/.test(notObject.error), notObject.error);

  const wrongKind = sites.importPolicy(JSON.stringify({ kind: 'bookmarks', allow: [] }), current);
  assert.equal(wrongKind.ok, false);
  assert.ok(/不是 agent 站点名单/.test(wrongKind.error), wrongKind.error);

  const empty = sites.importPolicy(JSON.stringify({ kind: 'agent-sites' }), current);
  assert.equal(empty.ok, false);
  assert.ok(/既没有 allow 也没有 block/.test(empty.error), empty.error);
});

check('28. 导入里的脏条目被列出来，不会被静默忽略', () => {
  const current = sites.sanitizePolicy(null);
  const file = JSON.stringify({
    kind: 'agent-sites',
    allow: [{ target: 'ok.test', mode: 'host' }, { target: 'not a host', mode: 'host' }, { target: 'ok2.test', mode: 'host' }],
  });
  const result = sites.importPolicy(file, current, { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.added, 2);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.rejected.length, 1);
  assert.ok(/not a host/.test(result.rejected[0]), '被拒绝的条目要原样列出来');
  assert.ok(/1/.test(result.summary), result.summary);
});

check('29. 导出再导入是等价的：规则与全局开关都能往返（候选④）', () => {
  const source = sites.sanitizePolicy({
    globalEnabled: false,
    allow: [{ target: 'example.com', mode: 'host' }, { target: 'shop.test', mode: 'prefix' }],
    block: [{ target: 'evil.test', mode: 'host' }],
  });
  const exported = JSON.stringify(sites.exportPolicy(source, 1_700_000_000_000));
  const result = sites.importPolicy(exported, sites.sanitizePolicy(null), { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.policy.globalEnabled, false, '全局开关要跟着走');
  const key = (list) => list.map((rule) => `${rule.mode}:${rule.target}`).sort();
  assert.deepEqual(key(result.policy.allow), key(source.allow));
  assert.deepEqual(key(result.policy.block), key(source.block));
  assert.equal(result.duplicates, 0);
  assert.equal(result.rejectedCount, 0);
});

check('30. 导入导出的主进程接线：两个对话框 + 落盘 + 留痕', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("ipcMain.handle('nyx:agent:sites-export'"), '要有导出 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:agent:sites-import'"), '要有导入 IPC');
  assert.ok(main.includes('showSaveDialogSync'), '导出要用同步保存框（异步会让用户看到一个空对话框）');
  assert.ok(main.includes('showOpenDialogSync'), '导入要用同步打开框');
  assert.ok(main.includes('AGENT_SITES_EXPORTED'), '导出要落日志');
  assert.ok(main.includes('AGENT_SITES_IMPORTED'), '导入要落日志');
  assert.ok(main.includes('AGENT_SITES_IMPORT_REJECTED'), '导入被拒要落日志');
  const preload = read('src/preload.js');
  assert.ok(preload.includes('agentSitesExport'), 'preload 应暴露 agentSitesExport');
  assert.ok(preload.includes('agentSitesImport'), 'preload 应暴露 agentSitesImport');
  const html = read('src/renderer/settings.html');
  assert.ok(html.includes('id="btn-agent-sites-export"'), '设置页要有导出按钮');
  assert.ok(html.includes('id="btn-agent-sites-import"'), '设置页要有导入按钮');
});

check('31. 导出文件带格式版本，规则带可解析的添加时间（候选③迁移的地基）', () => {
  const policy = sites.sanitizePolicy({
    globalEnabled: true,
    allow: [{ target: 'example.com', mode: 'host', addedAt: 1_700_000_000_000 }],
    block: [],
  });
  const out = sites.exportPolicy(policy, 1_700_000_100_000);
  assert.equal(out.version, sites.EXPORT_VERSION, '导出要写自己的格式版本');
  assert.equal(typeof out.exportedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(out.exportedAt)), 'exportedAt 要能解析');
  assert.equal(out.allow[0].addedAt, new Date(1_700_000_000_000).toISOString(), '逐条添加时间要保留');
});

check('32. v1 老文件（纯字符串规则、没有 addedAt）能导入，并如实说做了哪些迁移', () => {
  const legacy = JSON.stringify({
    app: 'nyx',
    kind: 'agent-sites',
    version: 1,
    globalEnabled: true,
    allow: ['a.example', { target: 'b.example/admin', mode: 'prefix' }],
    block: [],
  });
  const result = sites.importPolicy(legacy, sites.sanitizePolicy(null), { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, 1);
  assert.equal(result.toVersion, sites.EXPORT_VERSION);
  assert.equal(result.migrated, true, '要标出这份文件被迁移过');
  assert.equal(result.policy.allow.length, 2);
  assert.equal(result.policy.allow[0].mode, 'host', '纯字符串按域名规则');
  assert.equal(result.policy.allow[1].mode, 'prefix', '显式写了 prefix 的保留');
  assert.ok(Array.isArray(result.steps) && result.steps.length >= 2, '迁移步骤要说得清');
  assert.ok(result.summary.includes('升到'), '状态行要写明升级了格式');
});

check('33. 连 version 都没写的手写文件：按 v1 处理，但明确提示这是猜的', () => {
  const handWritten = JSON.stringify({ globalEnabled: true, allow: ['hand.example'] });
  const result = sites.importPolicy(handWritten, sites.sanitizePolicy(null), { mode: 'merge' });
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, 1);
  assert.ok(
    result.warnings.some((text) => text.includes('没写格式版本')),
    '要说明它是按 v1 猜的，不许悄悄当最新格式',
  );
});

check('34. 未来版本（v99）明确拒绝，不猜着导入', () => {
  const future = JSON.stringify({ app: 'nyx', kind: 'agent-sites', version: 99, allow: [] });
  const result = sites.importPolicy(future, sites.sanitizePolicy(null), { mode: 'merge' });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('v99'), '要说出对方是哪个版本');
  assert.ok(result.error.includes(sites.EXPORT_VERSION + ''), '要说出自己只认到哪个版本');
  assert.equal(result.policy.allow.length, 0, '拒绝时不许改动现有名单');
});

/* ------------------------------------------------------------------ */

// 安全审计 P1-3：navigate 要按「要去的地方」判定，且当前站点以 webContents 自己报的地址为准
check('35. 站点判定接线：当前站点取 webContents.getURL()，navigate 按目标站点判定（P1-3）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

  const siteFn = mainSrc.slice(mainSrc.indexOf('function currentAgentSite()'), mainSrc.indexOf('function siteOfUrl('));
  assert.ok(/getActiveWebContents\(\)/.test(siteFn), '当前站点要先问 webContents 要地址');
  assert.ok(/wc\.getURL\(\)/.test(siteFn), '必须用 getURL() 的实时地址');
  assert.ok(
    siteFn.indexOf('manager.getActiveWebContents()') < siteFn.indexOf('manager.snapshot()'),
    '实时地址要排在 snapshot() 兜底之前',
  );

  const start = mainSrc.indexOf('async function authorizeAgentAction');
  const authFn = mainSrc.slice(start, start + 2600);
  assert.ok(/type === 'navigate' \? siteOfUrl\(params\.url\)/.test(authFn), 'navigate 要取目标地址的站点');
  assert.ok(/site: judgeSite/.test(authFn), '判定要用 judgeSite（目标优先）');
  assert.ok(/navigate-bad-url/.test(authFn), '目标地址看不懂时要失败关闭，不许猜');
});

check('36. 屏蔽名单对 navigate 真的生效：从白名单页跳到屏蔽站点会被拒，并说清两边站点（P1-3）', () => {
  const policy = sites.sanitizePolicy({
    globalEnabled: true,
    allow: [{ target: 'good.example', mode: 'host' }],
    block: [{ target: 'bad.example', mode: 'host' }],
  });
  const judge = (current, target) => sites.evaluateSite({ site: target || current, policy, sessionTrusted: [] });
  const fromGoodToBad = judge('good.example', 'bad.example');
  const onGood = judge('good.example', '');
  assert.equal(fromGoodToBad.decision, 'deny', '跳到屏蔽站点必须被拒');
  assert.equal(fromGoodToBad.layer, '屏蔽名单');
  assert.equal(onGood.decision, 'allow', '留在白名单页要照常放行');
  const fromBadToGood = judge('bad.example', 'good.example');
  assert.equal(fromBadToGood.decision, 'allow');
});

const failed = checks.filter((item) => !item.ok);
const total = checks.length;
console.log('');
console.log(`站点三层授权（E）：${total} 项检查，${total - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  ✘ ${item.name}｜${item.error}`);
  process.exitCode = 1;
}
