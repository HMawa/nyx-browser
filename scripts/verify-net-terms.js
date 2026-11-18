'use strict';

/**
 * 接入外壳回归（VPN 接入外壳改造清单 §6 验收 1–3、§3 术语映射）。
 *
 * 这套断言盯的不是"字改没改"，而是四条最容易做歪的地方：
 *   1. `custom` 一档必须**逐字**等于今天的界面——老用户切回去不能看到半个新词；
 *   2. 校园 / 单位两档里**一个「代理」字都不许留**（合规红线），缺词要抛错而不是静默回退；
 *   3. 默认值靠 `auto` 推断：有历史配置 → custom、干净机器 → campus，升级用户不被改词；
 *   4. 换身份只走 uiStore 一个口子，不许顺手去动内核、订阅、端口、分流。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const netTerms = require(path.join(ROOT, 'src', 'core', 'net-terms.js'));
const { UiStore, UI_PREF_DEFAULTS, UI_PREF_ENUMS } = require(path.join(ROOT, 'src', 'core', 'ui-store.js'));

const settingsHtml = read('src/renderer/settings.html');
const settingsJs = read('src/renderer/settings.js');
const proxyCenterCss = read('src/renderer/proxy-center.css');
const preloadJs = read('src/preload.js');
const mainJs = read('src/main.js');

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

/** 今天界面上真实出现过的词：改这一段就等于改老用户的界面，所以逐条冻结 */
const FROZEN_CUSTOM = {
  sectionLabel: '网络与代理',
  channelTitle: '内置代理内核',
  channelStateLabel: '当前订阅',
  channelConnect: '启动内置代理',
  channelDisconnect: '停止',
  channelRefetch: '重新拉取配置',
  channelDown: '代理不可达',
  channelForce: '强制走代理',
  subscriptionTitle: '订阅',
  subscriptionAdd: '添加订阅',
  nodeTerm: '节点',
  latencyTerm: '测速',
  ruleTerm: '分流规则',
  exitIpTerm: '出口 IP',
  selfHealTerm: '智能巡航',
  localPortTerm: '混合端口',
  directTerm: '直连',
};

check('1. 词表是纯字符串模块（界面侧可直接 require），三档身份与顺序固定', () => {
  assert.deepStrictEqual(netTerms.IDENTITIES, ['campus', 'enterprise', 'custom']);
  assert.strictEqual(netTerms.IDENTITY_AUTO, 'auto');
  assert.strictEqual(netTerms.DEFAULT_IDENTITY, 'campus');
  assert.strictEqual(netTerms.UPGRADE_IDENTITY, 'custom');
  const src = read('src/core/net-terms.js');
  for (const forbidden of ["require('electron')", "require('fs')", "require('path'", 'node:fs', 'node:path']) {
    assert.ok(!src.includes(forbidden), `词表模块不许依赖 ${forbidden}`);
  }
});

check('2. 用户显式选过就照办：campus 即便有历史配置也不被改成 custom', () => {
  assert.strictEqual(netTerms.resolveIdentity('campus', { hasExistingConfig: true }), 'campus');
  assert.strictEqual(netTerms.resolveIdentity('enterprise', { hasExistingConfig: true }), 'enterprise');
  assert.strictEqual(netTerms.resolveIdentity('custom', { hasExistingConfig: false }), 'custom');
});

check('3. 没选过 + 有历史接入配置 → custom（升级用户维持今天的界面）', () => {
  assert.strictEqual(netTerms.resolveIdentity('auto', { hasExistingConfig: true }), 'custom');
  // 纯函数不替调用方猜：不传 ctx 就当"没配置"，保守判断留给主进程（那边异常时按老用户算）
  assert.strictEqual(netTerms.resolveIdentity('auto'), 'campus');
});

check('4. 没选过 + 干净机器 → campus（新装默认走校园口径）', () => {
  assert.strictEqual(netTerms.resolveIdentity('auto', { hasExistingConfig: false }), 'campus');
  assert.strictEqual(netTerms.resolveIdentity('', { hasExistingConfig: false }), 'campus');
});

check('5. 脏值一律按「没选过」处理，不报错也不乱猜成 enterprise', () => {
  for (const dirty of ['weird', 'CAMPUS', ' campus ', null, undefined, 42, {}]) {
    assert.strictEqual(netTerms.resolveIdentity(dirty, { hasExistingConfig: false }), 'campus', `脏值 ${String(dirty)}`);
    assert.strictEqual(netTerms.resolveIdentity(dirty, { hasExistingConfig: true }), 'custom', `脏值 ${String(dirty)}`);
  }
});

check('6. custom 逐字等于今天的界面（冻结表逐条比对，改一个字就算回退）', () => {
  const terms = netTerms.termsFor('custom');
  for (const [key, value] of Object.entries(FROZEN_CUSTOM)) {
    assert.strictEqual(terms[key], value, `custom 的 ${key} 被改了：${terms[key]} ≠ ${value}`);
  }
});

check('7. 三档词条齐全且非空（28 个键一份不少、字典里也不多出未登记键）', () => {
  assert.strictEqual(netTerms.TERM_KEYS.length, 28, `词条键应为 28 个，实为 ${netTerms.TERM_KEYS.length}`);
  for (const identity of netTerms.IDENTITIES) {
    const terms = netTerms.termsFor(identity);
    assert.deepStrictEqual(Object.keys(terms).sort(), netTerms.TERM_KEYS.slice().sort(), `${identity} 词条键不齐`);
    for (const key of netTerms.TERM_KEYS) {
      assert.ok(typeof terms[key] === 'string' && terms[key].trim(), `${identity}.${key} 为空`);
    }
  }
});

check('8. 校园 / 单位两档一个旧术语都不许留（尤其「代理」二字）', () => {
  for (const identity of ['campus', 'enterprise']) {
    const terms = netTerms.termsFor(identity);
    for (const key of netTerms.TERM_KEYS) {
      for (const word of netTerms.LEGACY_WORDS) {
        assert.ok(!terms[key].includes(word), `${identity}.${key} 残留「${word}」：${terms[key]}`);
      }
    }
    assert.ok(!JSON.stringify(terms).includes('代理'), `${identity} 档出现了「代理」`);
  }
});

check('9. 校园 / 单位的分区名与关键叫法正确（接入通道 / 线路 / 出口地址 / 本地端口）', () => {
  for (const identity of ['campus', 'enterprise']) {
    const terms = netTerms.termsFor(identity);
    assert.strictEqual(terms.sectionLabel, '接入通道');
    assert.strictEqual(terms.channelTitle, '接入通道');
    assert.strictEqual(terms.subscriptionTitle, '接入配置');
    assert.strictEqual(terms.nodeTerm, '线路');
    assert.strictEqual(terms.latencyTerm, '线路质量检测');
    assert.strictEqual(terms.ruleTerm, '访问规则');
    assert.strictEqual(terms.exitIpTerm, '出口地址');
    assert.strictEqual(terms.selfHealTerm, '线路自愈');
    assert.strictEqual(terms.localPortTerm, '本地端口');
    assert.strictEqual(terms.directTerm, '直接访问');
    assert.strictEqual(terms.channelConnect, '连接接入通道');
  }
});

check('10. 取不到的词直接抛错（带键名），绝不静默回退到 custom 的字', () => {
  assert.throws(() => netTerms.t('notAKey', 'campus'), /接入外壳词条不存在：notAKey/);
});

check('11. 身份不对（含把 auto 当具体档传进来）直接抛错，不带出任何字', () => {
  assert.throws(() => netTerms.t('nodeTerm', 'auto'), /接入外壳接入方式不存在：auto/);
  assert.throws(() => netTerms.t('nodeTerm', 'weird'), /接入外壳接入方式不存在：weird/);
});

check('12. termsFor 返回副本：界面改返回值不会污染唯一真源', () => {
  const first = netTerms.termsFor('campus');
  first.nodeTerm = '被界面改坏了';
  assert.strictEqual(netTerms.termsFor('campus').nodeTerm, '线路');
  assert.strictEqual(netTerms.t('nodeTerm', 'custom'), '节点');
});

check('13. assertCoverage() 全通过（三档齐全、无旧术语、custom 无外壳词）', () => {
  assert.deepStrictEqual(netTerms.assertCoverage(), []);
});

check('14. 选择器要的三档说明齐全（每档都有一句话，且都提到该照谁的说明填）', () => {
  const options = netTerms.describeIdentities();
  assert.strictEqual(options.length, 3);
  assert.deepStrictEqual(options.map((o) => o.id), ['campus', 'enterprise', 'custom']);
  for (const opt of options) {
    assert.ok(opt.label && opt.note, `${opt.id} 缺 label/note`);
  }
  assert.match(options[0].note, /学校/);
  assert.match(options[1].note, /单位/);
});

check('15. 定位声明与换身份范围说明都在，且声明里明确「不代表任何机构认可」', () => {
  assert.match(netTerms.SHELL_STATEMENT, /通用网络代理工具/);
  assert.match(netTerms.SHELL_STATEMENT, /不代表任何机构认可/);
  assert.match(netTerms.IDENTITY_SCOPE_NOTE, /不改网络、内核或已有配置/);
});

check('16. ui-store 默认 auto，且 netIdentity 在枚举白名单里（脏值会被拉回 auto）', () => {
  assert.strictEqual(UI_PREF_DEFAULTS.netIdentity, 'auto');
  assert.deepStrictEqual(UI_PREF_ENUMS.netIdentity, ['auto', 'campus', 'enterprise', 'custom']);
});

check('17. UiStore 真写读回：campus 落盘后重开仍是 campus', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-net-identity-'));
  try {
    const store = new UiStore({ stateDir });
    assert.strictEqual(store.get().netIdentity, 'auto', '新装的默认应是 auto');
    const written = store.set('netIdentity', 'campus');
    assert.ok(written && written.ok !== false, '写入应成功');
    assert.strictEqual(new UiStore({ stateDir }).get().netIdentity, 'campus', '重开后应读回 campus');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

check('18. UiStore 拒绝非法身份（乱值不落盘）', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-net-identity-'));
  try {
    const store = new UiStore({ stateDir });
    const bad = store.set('netIdentity', 'weird');
    assert.strictEqual(bad.ok, false, '非法身份应被拒绝');
    assert.strictEqual(store.get().netIdentity, 'auto', '拒绝后取值不变');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

check('19. 主进程两个 IPC 各注册一次，写身份只碰 uiStore（不重启内核、不动订阅/端口）', () => {
  const getCount = mainJs.split("ipcMain.handle('nyx:net:identity'").length - 1;
  const setCount = mainJs.split("ipcMain.handle('nyx:net:identity-set'").length - 1;
  assert.strictEqual(getCount, 1, `nyx:net:identity 应注册 1 次，实为 ${getCount}`);
  assert.strictEqual(setCount, 1, `nyx:net:identity-set 应注册 1 次，实为 ${setCount}`);

  const start = mainJs.indexOf("ipcMain.handle('nyx:net:identity-set'");
  const end = mainJs.indexOf("ipcMain.handle('nyx:privacy:link'", start);
  assert.ok(start > 0 && end > start, '找不到写身份的处理块');
  const block = mainJs.slice(start, end);
  for (const forbidden of ['startProxy', 'restartProxy', 'addSubscription', 'removeProxySubscription', 'mixedPort', 'writeFile', 'spawn']) {
    assert.ok(!block.includes(forbidden), `写身份的处理块里出现了 ${forbidden}——换身份不许碰网络行为`);
  }
  assert.ok(block.includes("runtime.uiStore.set('netIdentity'"), '写身份应落到 uiStore');
  assert.ok(block.includes('IDENTITIES.includes'), '写身份前应校验三档身份');
});

check('20. 身份载荷自带界面要的全部字段，且"有没有历史配置"只看订阅数', () => {
  const start = mainJs.indexOf('function netIdentityPayload');
  const block = mainJs.slice(start, mainJs.indexOf("ipcMain.handle('nyx:net:identity'", start));
  for (const field of ['identity', 'label', 'options', 'statement', 'scopeNote', 'terms', 'hasExistingConfig']) {
    assert.ok(block.includes(`${field}`), `载荷缺字段 ${field}`);
  }
  const hasConfigStart = mainJs.indexOf('function netHasExistingConfig');
  const hasConfigBlock = mainJs.slice(hasConfigStart, start);
  assert.ok(hasConfigBlock.includes('subscriptions'), '判断历史配置应看订阅列表');
  assert.ok(hasConfigBlock.includes('return true'), '异常时应保守按老用户处理');
});

check('21. 三处接线齐全：preload 四接口、设置页选择器 + data-net-term、进分区回读', () => {
  for (const api of ['netIdentity:', 'setNetIdentity:', 'netTermsFor:', 'netIdentityOptions:']) {
    assert.ok(preloadJs.includes(api), `preload 缺接口 ${api}`);
  }
  assert.ok(/id="net-identity-select"/.test(settingsHtml), '设置页缺身份选择器');
  assert.ok(/data-net-term="channelTitle"/.test(settingsHtml), '网络分区标题没挂词条');
  assert.ok(/data-net-term="subscriptionTitle"/.test(settingsHtml), '订阅标题没挂词条');
  assert.ok(/data-net-ph="subscriptionUrlHint"/.test(settingsHtml), '订阅地址 placeholder 没挂词条');
  assert.ok(/function applyNetIdentity/.test(settingsJs), '设置页缺词条铺放函数');
  assert.ok(/function wireNetIdentity/.test(settingsJs), '设置页缺选择器接线');
  assert.ok(/section === 'network'[\s\S]{0,160}loadNetIdentity/.test(settingsJs), '进网络分区时应回读身份');
});

check('22. 三段式只在校园/单位生效：自定义服务端必须原样搬回，且搬动的是已有节点', () => {
  assert.ok(/function applyNetShellLayout/.test(settingsJs), '设置页缺三段式布局函数');
  assert.ok(/applyNetShellLayout\(payload\.identity, terms\)/.test(settingsJs), '铺身份时没有调用三段式布局');
  // custom 必须走"逆序搬回 + 删外壳元素"这一支，且不进 data-net-layout
  const block = settingsJs.slice(
    settingsJs.indexOf('function netShellMove'),
    settingsJs.indexOf('function applyNetIdentity'),
  );
  assert.ok(/if \(identity === 'custom'\)/.test(block), '自定义服务端应有还原分支');
  assert.ok(/NET_SHELL_RESTORE\.pop\(\)/.test(block), '还原应按记录逆序搬回');
  assert.ok(/insertBefore\(item\.node, item\.next\)/.test(block), '还原应放回原来的位置');
  assert.ok(/querySelectorAll\('\.net-shell-only'\)/.test(block), '还原应删掉全部外壳元素');
  // 三段：① 接入通道在 kernel-bar 前、② 服务端段标题、③ 高级 details 收走五块
  assert.ok(/netShellStep\('① 接入通道'\)/.test(block), '缺 ① 接入通道');
  assert.ok(/terms\.serverTitle/.test(block), '缺 ② 服务端与接入配置段标题');
  assert.ok(/net-advanced net-shell-only/.test(block), '缺 ③ 高级折叠块');
  for (const selector of ['#iface-card', '#smart-card', '#stat-grid', '#tabs', '.tab-panels']) {
    assert.ok(block.includes(`'${selector}'`), `③ 高级里少了 ${selector}`);
  }
  // 是搬已有节点，不是重新造一份：新造的话 id 会重复、proxy-center.js 的引用会失联
  assert.ok(/NET_SHELL_RESTORE\.push\(record\)/.test(block), '搬动应记录原位置');
  assert.ok(/next: node\.nextSibling/.test(block), '记录里要有原来的下一个兄弟节点');
});

check('23. 三段式的样式只在 [data-net-layout="shell"] 下命中（自定义服务端一条不中）', () => {
  const shellStart = proxyCenterCss.indexOf('三段式外壳（校园 / 单位）');
  const shellEnd = proxyCenterCss.indexOf('---------------- 主体布局', shellStart);
  assert.ok(shellStart > 0 && shellEnd > shellStart, '样式里找不到三段式小节');
  const shellRules = proxyCenterCss.slice(shellStart, shellEnd);
  assert.ok(/\[data-net-layout="shell"\] \.layout[\s\S]{0,160}flex-direction: column/.test(shellRules), '三段式应是单列');
  assert.ok(/\[data-net-layout="shell"\] \.layout[\s\S]{0,200}overflow-y: auto/.test(shellRules), '三段式要能整段滚动');
  assert.ok(/\.net-step[\s\S]{0,120}var\(--text-dim\)/.test(shellRules), '.net-step 应沿用主题色令牌');
  assert.ok(/\.net-advanced[\s\S]{0,200}var\(--border\)/.test(shellRules), '.net-advanced 应沿用主题边框令牌');
  assert.ok(/\.net-advanced > summary:focus-visible/.test(shellRules), '折叠标题要有可见焦点');
  // 不允许出现新的写死色值 / 渐变
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(shellRules), '三段式样式里不许写死颜色');
  assert.ok(!/linear-gradient|radial-gradient/.test(shellRules), '三段式样式里不许用渐变');
});

check('24. shellize：custom 原样返回、校园/单位换词、没命中返回同一字符串、幂等、auto 抛错', () => {
  assert.strictEqual(netTerms.shellize('启动内置代理后显示策略组。', 'custom'), '启动内置代理后显示策略组。');
  assert.strictEqual(netTerms.shellize('启动内置代理后显示策略组。', 'campus'), '连接接入通道后显示线路组。');
  assert.strictEqual(netTerms.shellize('代理内核未启动', 'campus'), '接入组件未启动');
  assert.strictEqual(netTerms.shellize('点「测速全部节点」', 'enterprise'), '点「线路质量检测全部线路」');
  assert.strictEqual(netTerms.shellize('普通一句没有旧术语', 'campus'), '普通一句没有旧术语');
  const once = netTerms.shellize('订阅里没有节点，测速一下', 'campus');
  assert.strictEqual(netTerms.shellize(once, 'campus'), once, '换过一遍的词不应再被改写');
  assert.throws(() => netTerms.shellize('订阅', 'auto'), /接入外壳接入方式不存在：auto/);
  assert.strictEqual(netTerms.shellize('', 'campus'), '');
  assert.strictEqual(netTerms.shellize(null, 'campus'), null);
});

check('25. 渲染层现有文案全量换词后零残留（含空态、状态条、按钮 title）', () => {
  const literals = new Set();
  const stripComments = (src) => src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const proxy = stripComments(read('src/renderer/proxy-center.js'));
  for (const match of proxy.matchAll(/'([^'\\\n]{2,200})'/g)) {
    if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1]);
  }
  for (const match of proxy.matchAll(/`([^`]{2,300})`/g)) {
    if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1]);
  }
  for (const match of settingsHtml.matchAll(/>([^<>{}]{2,120})</g)) {
    if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1].trim());
  }
  assert.ok(literals.size > 300, `语料太少（${literals.size} 条），提取规则可能失效`);
  const leftover = [];
  for (const text of literals) {
    const out = netTerms.shellize(text, 'campus');
    for (const word of netTerms.LEGACY_WORDS) {
      if (out.includes(word)) leftover.push(`${word} ← ${text}`);
    }
  }
  assert.deepStrictEqual(leftover.slice(0, 5), [], `还有 ${leftover.length} 条换词后残留旧术语`);
});

check('26. 动态文案接上线：preload 同步接口 + 设置页扫描 + Observer 跳日志区 + custom 摘掉', () => {
  assert.ok(/netShellizeText: \(text, identity\) => netTermsCore\.shellize\(text, identity\)/.test(preloadJs), 'preload 缺 netShellizeText');
  assert.ok(/function sweepNetShellText/.test(settingsJs), '设置页缺动态文案扫描');
  assert.ok(/function watchNetShellText/.test(settingsJs), '设置页缺 Observer 安装');
  assert.ok(/watchNetShellText\(payload\.identity\)/.test(settingsJs), '铺身份时没接动态文案扫描');
  const block = settingsJs.slice(settingsJs.indexOf('function sweepNetShellText'), settingsJs.indexOf('function applyNetIdentity'));
  assert.ok(/\.log-box, pre, code/.test(block), '日志区必须跳过：那是内核原始输出');
  assert.ok(/netShellObserver\.disconnect\(\)/.test(block), '切回 custom 或重装时必须先摘掉旧 Observer');
  assert.ok(/!\[.campus., .enterprise.\]\.includes\(identity\)\) return/.test(block), '只有校园/单位两档才挂 Observer');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[接入外壳回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[接入外壳回归] 通过 ${checks.length}/${checks.length}`);
}
