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
const { normalizeOnboardMarker } = require(path.join(ROOT, 'src', 'core', 'onboarding.js'));
const { UiStore, UI_PREF_DEFAULTS, UI_PREF_ENUMS } = require(path.join(ROOT, 'src', 'core', 'ui-store.js'));

const settingsHtml = read('src/renderer/settings.html');
const settingsJs = read('src/renderer/settings.js');
const proxyCenterCss = read('src/renderer/proxy-center.css');
const preloadJs = read('src/preload.js');
const mainJs = read('src/main.js');
const rendererJs = read('src/renderer/renderer.js');
const indexHtml = read('src/renderer/index.html');

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
  assert.strictEqual(netTerms.resolveIdentity('campus', { isUpgrade: true }), 'campus');
  assert.strictEqual(netTerms.resolveIdentity('enterprise', { isUpgrade: true }), 'enterprise');
  assert.strictEqual(netTerms.resolveIdentity('custom', { isUpgrade: false }), 'custom');
});

check('3. 没选过 + 老用户 → custom（升级后维持今天的界面）', () => {
  assert.strictEqual(netTerms.resolveIdentity('auto', { isUpgrade: true }), 'custom');
  // 纯函数不替调用方猜：不传 ctx 就当"新装"，保守判断留给主进程
  assert.strictEqual(netTerms.resolveIdentity('auto'), 'campus');
});

check('4. 没选过 + 新装 → campus（新装默认走校园口径）', () => {
  assert.strictEqual(netTerms.resolveIdentity('auto', { isUpgrade: false }), 'campus');
  assert.strictEqual(netTerms.resolveIdentity('', { isUpgrade: false }), 'campus');
});

check('5. 脏值一律按「没选过」处理，不报错也不乱猜成 enterprise', () => {
  for (const dirty of ['weird', 'CAMPUS', ' campus ', null, undefined, 42, {}]) {
    assert.strictEqual(netTerms.resolveIdentity(dirty, { isUpgrade: false }), 'campus', `脏值 ${String(dirty)}`);
    assert.strictEqual(netTerms.resolveIdentity(dirty, { isUpgrade: true }), 'custom', `脏值 ${String(dirty)}`);
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
  // 「跟随默认」必须能保存回去（审计 F3：界面上摆着 auto 却保存必失败，等于给用户一个坑）
  assert.ok(/IDENTITY_AUTO/.test(block), '写身份应允许「跟随默认」（auto）这一档');
});

check('20. 身份载荷自带界面要的全部字段，且"像不像老用户"不看订阅数（审计 F4）', () => {
  const start = mainJs.indexOf('function netIdentityPayload');
  const block = mainJs.slice(start, mainJs.indexOf("ipcMain.handle('nyx:net:identity'", start));
  for (const field of ['identity', 'label', 'options', 'statement', 'scopeNote', 'terms', 'auto']) {
    assert.ok(block.includes(`${field}`), `载荷缺字段 ${field}`);
  }
  assert.ok(!block.includes('hasExistingConfig'), '载荷不该再对外暴露"按订阅数推断"的旧口径');
  // 迁移判据必须是"引导走过没有 / 有没有老数据文件"，且解析结果只落一次盘
  const upgradeStart = mainJs.indexOf('function netIsUpgradeUser');
  assert.ok(upgradeStart > 0, '缺少 netIsUpgradeUser');
  const upgradeBlock = mainJs.slice(upgradeStart, mainJs.indexOf('function netResolveAutoIdentity', upgradeStart));
  assert.ok(upgradeBlock.includes('readOnboardMarker'), '老用户判断应看首次安装标记');
  assert.ok(!upgradeBlock.includes('subscriptions'), '老用户判断不许拿订阅数当依据（订阅数会变，口径就翻）');
  // 审计 F4 回归：新装走完引导后 pending 变 0，不能把「引导走完」当「老用户」。
  // 安装器给全新安装写 fresh=true，引导 finish 只改 pending，老用户升级上来 fresh 不为 true。
  assert.ok(upgradeBlock.includes('marker.fresh === true'), '老用户判断应先看 fresh=true（否则新装走完引导会被判成升级）');
  const nsh = read('build/installer.nsh');
  assert.ok(/\{"pending":true,"fresh":true/.test(nsh), '全新安装的标记必须写 fresh=true');
  assert.ok(/IfNot.*FileExists.*onboarding\.json/.test(nsh), '升级安装不能覆盖已有的 fresh 标记');
  const marker = normalizeOnboardMarker({ pending: false, fresh: true, version: '1.19.2' });
  assert.strictEqual(marker.fresh, true, 'normalizeOnboardMarker 必须保留 fresh');
  assert.strictEqual(marker.pending, false);
  const resolveBlock = mainJs.slice(
    mainJs.indexOf('function netResolveAutoIdentity'),
    mainJs.indexOf('function netIdentityPayload'),
  );
  assert.ok(resolveBlock.includes("'netIdentityResolved'"), '自动解析结果应落盘到 netIdentityResolved');
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
  // 语料从「proxy-center.js + settings.html 两个文件」扩到**整个渲染层**：
  // 之前只扫这两个文件，别的文件（外壳 renderer.js、index.html、start.*、onboard.js）写了新文案
  // 只要不含表里的短语就能悄悄漏过去；现在任何渲染层文件里的中文字面量都要过一遍换词表。
  const literals = new Set();
  const stripComments = (src) => src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const files = fs
    .readdirSync(path.join(ROOT, 'src/renderer'))
    .filter((name) => /\.(js|html)$/.test(name))
    .map((name) => `src/renderer/${name}`);
  for (const rel of files) {
    const src = stripComments(read(rel));
    for (const match of src.matchAll(/'([^'\\\n]{2,200})'/g)) {
      if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1]);
    }
    for (const match of src.matchAll(/"([^"\\\n]{2,200})"/g)) {
      if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1]);
    }
    for (const match of src.matchAll(/`([^`]{2,300})`/g)) {
      if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1]);
    }
    for (const match of src.matchAll(/>([^<>{}]{2,120})</g)) {
      if (/[\u4e00-\u9fa5]/.test(match[1])) literals.add(match[1].trim());
    }
  }
  assert.ok(files.length >= 10, `渲染层文件只找到 ${files.length} 个，路径规则可能失效`);
  assert.ok(literals.size > 1500, `语料太少（${literals.size} 条），提取规则可能失效`);
  const leftover = [];
  for (const text of literals) {
    for (const identity of ['campus', 'enterprise']) {
      const out = netTerms.shellize(text, identity);
      for (const word of netTerms.LEGACY_WORDS) {
        if (out.includes(word)) leftover.push(`${identity}/${word} ← ${text}`);
      }
    }
  }
  assert.deepStrictEqual(leftover.slice(0, 5), [], `还有 ${leftover.length} 条换词后残留旧术语`);
});

check('26. 动态文案接上线：preload 同步接口 + 设置页扫描 + Observer 跳日志区 + custom 摘掉并还原', () => {
  assert.ok(/netShellizeText: \(text, identity\) => netTermsCore\.shellize\(text, identity\)/.test(preloadJs), 'preload 缺 netShellizeText');
  assert.ok(/function sweepNetShellText/.test(settingsJs), '设置页缺动态文案扫描');
  assert.ok(/function watchNetShellText/.test(settingsJs), '设置页缺 Observer 安装');
  assert.ok(/watchNetShellText\(payload\.identity\)/.test(settingsJs), '铺身份时没接动态文案扫描');
  const block = settingsJs.slice(settingsJs.indexOf('function sweepNetShellText'), settingsJs.indexOf('function applyNetIdentity'));
  assert.ok(/\.log-box, pre, code/.test(block), '日志区必须跳过：那是内核原始输出');
  assert.ok(/\[data-net-keep\]/.test(block), '用户数据与事实陈述要跳过（data-net-keep）');
  assert.ok(/netShellObserver\.disconnect\(\)/.test(block), '切回 custom 或重装时必须先摘掉旧 Observer');
  assert.ok(/\['campus', 'enterprise'\]\.includes\(identity\)/.test(block), '只有校园/单位两档才挂 Observer');
  // 审计 F2：切回 custom 必须把改过的字还原，而不是只摘 Observer 就走
  assert.ok(/function restoreNetShellText/.test(settingsJs), '缺还原函数：切回自定义服务端时动态文案会留在外壳词上');
  assert.ok(/restoreNetShellText\(\)/.test(block), '切回 custom 的分支没有调用还原');
  assert.ok(/netShellTextOriginals\.set\(/.test(block) && /netShellAttrOriginals\.set\(/.test(block), '扫描时要记下原文，否则无从还原');
});

check('27. 外壳（地址栏/状态条/提示）也换词：主进程改完推事件、外壳收到重扫、日志区仍跳过', () => {
  assert.ok(/nyx:net-identity-changed/.test(mainJs), '主进程没推「接入方式改过」事件');
  assert.ok(/onNetIdentityChanged: \(handler\)/.test(preloadJs), 'preload 缺 onNetIdentityChanged');
  assert.ok(/function loadNetIdentityShell/.test(rendererJs), '外壳缺接入方式加载');
  assert.ok(/loadNetIdentityShell\(\)/.test(rendererJs), '外壳初始化没调 loadNetIdentityShell');
  assert.ok(/function sweepNetIdentityText/.test(rendererJs) && /function watchNetIdentityText/.test(rendererJs), '外壳缺换词扫描');
  const block = rendererJs.slice(rendererJs.indexOf('function sweepNetIdentityText'), rendererJs.indexOf('function loadNetIdentityShell'));
  assert.ok(/\.log-box, pre, code/.test(rendererJs), '外壳也要跳过内核日志区');
  assert.ok(/\.log-box, pre, code/.test(block) || /NET_SWEEP_SKIP_SELECTOR/.test(block), '外壳扫描要用上跳过名单');
  assert.ok(/netIdentityObserver\.disconnect\(\)/.test(block), '外壳重装前要摘旧 Observer');
  // 外壳不许自己判断身份，只认主进程给的 identity
  assert.ok(!/resolveIdentity/.test(rendererJs), '外壳不该自己推断接入方式');
});

check('28. 关于页与身份条都保留事实陈述：通用网络代理工具 + mihomo GPL-3.0，且都挂换词豁免', () => {
  // 关于页：按「声明原文」定位它所在的那一段，再检查这一段确实标了豁免。
  // 不按「第一个 data-net-keep」找——那样一旦别处先出现标记（比如身份条），断言就会错位。
  const aboutAt = settingsHtml.indexOf('data-sec="about"');
  assert.ok(aboutAt > 0, '设置页找不到关于分区');
  const about = settingsHtml.slice(aboutAt);
  const stmtAt = about.indexOf('通用网络代理工具');
  assert.ok(stmtAt > 0, '关于页丢了「通用网络代理工具」这句事实陈述（清单 §7.3）');
  const stmtBlock = about.slice(Math.max(0, stmtAt - 500), stmtAt + 300);
  assert.ok(/data-net-keep/.test(stmtBlock), '关于页的事实陈述必须标 data-net-keep，否则会被换词扫掉');
  assert.ok(/mihomo/.test(about) && /GPL-3\.0/.test(about), '关于页要有 mihomo 的 GPL-3.0 声明');
  assert.ok(/data-net-keep/.test(settingsJs), '设置页扫描要跳过 data-net-keep');
  assert.ok(/\[data-net-keep\]/.test(rendererJs), '外壳扫描要跳过 data-net-keep');

  // 身份条里是同一句声明的第二份（审计 F1：以前它没标豁免，80ms 后被 Observer 扫成外壳词）
  const barAt = settingsHtml.indexOf('id="net-identity-bar"');
  assert.ok(barAt > 0, '设置页找不到身份条');
  // 身份条很短，按固定长度切；不能用「下一个 data-sec="network"」——那个串在导航里先出现过一次
  const bar = settingsHtml.slice(barAt - 120, barAt + 1200);
  assert.ok(/id="net-identity-statement"[^>]*data-net-keep/.test(bar), '身份条的事实陈述必须单独一个元素并标 data-net-keep');
  // 声明内容本身就是"通用网络代理工具"，换词表一定会改它 —— 用这条断言把风险钉住在词表层
  assert.notStrictEqual(netTerms.shellize(netTerms.SHELL_STATEMENT, 'campus'), netTerms.SHELL_STATEMENT,
    '换词表已经碰不动声明了，说明这条豁免断言失去了意义，请重新确认');
  // 清单验收 12：全隐私开关的可访问标签与可见文案同源；原生文案里本来写着「代理」，换词必须连 aria-label / title 一起换
  const privacyBtn = indexHtml.slice(indexHtml.indexOf('id="mode-toggle"') - 200, indexHtml.indexOf('id="mode-toggle"') + 700);
  assert.ok(/aria-label="全隐私模式开关/.test(privacyBtn), '隐私开关的 aria-label 不见了');
  assert.ok(/强制走代理/.test(privacyBtn), '隐私开关原生 title 里应有「强制走代理」，否则这条断言没有意义');
  assert.ok(/aria-label/.test(rendererJs) && /title/.test(rendererJs), '外壳扫描要连 title / aria-label 一起换');
});

check('29. 单位档是同一张表的第二个标签，不是第三张表（词条逐字相同，只许 LABELS / NOTES 有差别）', () => {
  // 2026-11-18 的决定：保留「单位网络接入」，但**不新增第三张术语表**。
  // 这条断言就是那道闸：谁要是哪天给 enterprise 单独写一套词，这里会立刻红。
  const campus = netTerms.termsFor('campus');
  const enterprise = netTerms.termsFor('enterprise');
  const diff = netTerms.TERM_KEYS.filter((key) => campus[key] !== enterprise[key]);
  assert.deepStrictEqual(diff, [], `单位档和校园档的词条不许分叉，实际不同：${diff.join('、')}`);
  assert.ok(netTerms.IDENTITY_LABELS.campus !== netTerms.IDENTITY_LABELS.enterprise, '两档的显示名必须不同（那就是它们的全部差别）');
  assert.ok(netTerms.IDENTITY_NOTES.campus !== netTerms.IDENTITY_NOTES.enterprise, '两档的说明必须不同（分别指向学校 / 单位）');
  // 说明里必须写清「照谁的说明填」，否则用户不知道该问谁
  assert.ok(/学校/.test(netTerms.IDENTITY_NOTES.campus), '校园档说明要点名学校网络中心');
  assert.ok(/单位/.test(netTerms.IDENTITY_NOTES.enterprise), '单位档说明要点名单位网络管理员');
});

const failed = checks.filter((item) => !item.pass);
if (failed.length) {
  console.log('[接入外壳回归] 未通过：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exitCode = 1;
} else {
  console.log(`[接入外壳回归] 通过 ${checks.length}/${checks.length}`);
}
