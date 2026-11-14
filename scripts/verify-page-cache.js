'use strict';

/**
 * 离线可读页面缓存（清单「离线可用第一版」）的纯 Node 回归。
 *
 * 不起 Electron：缓存的规则全在 `src/core/page-cache.js` 里，
 * 起窗口反而会把"到底存了什么"藏在界面后面。页面侧采集脚本的**形状**用静态检查，
 * 端到端（真的断网看缓存）放在 scripts/verify-ui-polish.js 里做。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cache = require('../src/core/page-cache');

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

const longText = '这是一段足够长的正文，用来模拟从页面里抽出来的可读内容，长度必须超过二十个字。';

check('1. 只缓存 http(s)：file/about/data 一律不产生缓存键', () => {
  assert.equal(cache.cacheKeyOf('https://a.com/x#h'), 'https://a.com/x');
  assert.equal(cache.cacheKeyOf('http://a.com/x'), 'http://a.com/x');
  for (const bad of ['file:///c:/x.html', 'about:blank', 'data:text/html,hi', '', null, 42]) {
    assert.equal(cache.cacheKeyOf(bad), '', `「${String(bad)}」不该有缓存键`);
  }
});

check('2. 快照归一：标题压空白并截断，正文按行拼接、超长截断', () => {
  const snap = cache.normalizeSnapshot({
    url: 'https://a.com/p#x',
    title: '  多   空格   标题  ',
    lines: ['  第一段正文要够长，否则整条缓存会被判成没有正文。  ', '', '  ', '第二段正文也要够长才行。'],
  });
  assert.equal(snap.url, 'https://a.com/p');
  assert.equal(snap.title, '多 空格 标题');
  assert.ok(snap.text.includes('第一段'));
  assert.ok(snap.text.includes('第二段'));
  assert.equal(snap.chars, snap.text.length);
  assert.ok(snap.at > 0);
});

check('3. 正文太短不写缓存（只有标题的缓存会误导人）', () => {
  assert.equal(cache.normalizeSnapshot({ url: 'https://a.com/x', title: '短', lines: ['短'] }), null);
  assert.equal(cache.normalizeSnapshot({ url: 'https://a.com/x', lines: [] }), null);
  assert.equal(cache.normalizeSnapshot(null), null);
  assert.equal(cache.normalizeSnapshot({ url: 'file:///c:/x', lines: [longText] }), null);
});

check('4. 自己的输出能被自己吃下去（否则缓存永远写不进去）', () => {
  const once = cache.normalizeSnapshot({ url: 'https://a.com/x', title: 't', lines: [longText] });
  const twice = cache.normalizeSnapshot(once);
  assert.ok(twice, '归一过的快照再归一不能变成 null');
  assert.equal(twice.text, once.text);
  const put = cache.putSnapshot(null, once);
  assert.equal(put.stored, true);
  assert.equal(put.store.items.length, 1);
});

check('5. 正文截断到上限，且不会把超长单行整个丢掉', () => {
  const huge = 'x'.repeat(cache.CACHE_TEXT_MAX * 2);
  const snap = cache.normalizeSnapshot({ url: 'https://a.com/big', lines: [huge] });
  assert.ok(snap, '超长单行也要存下截断版');
  assert.ok(snap.chars <= cache.CACHE_TEXT_MAX);
  assert.ok(snap.chars > 100);
});

check('6. 最近用的排最前，同一个地址只保留最新一条', () => {
  let store = null;
  store = cache.putSnapshot(store, { url: 'https://a.com/1', text: longText, at: 1000 }).store;
  store = cache.putSnapshot(store, { url: 'https://a.com/2', text: longText, at: 2000 }).store;
  store = cache.putSnapshot(store, { url: 'https://a.com/1', text: longText + '新', at: 3000 }).store;
  assert.equal(store.items.length, 2);
  assert.equal(store.items[0].url, 'https://a.com/1');
  assert.equal(store.items[0].at, 3000);
});

check('7. 缓存上限：超过 CACHE_LIMIT 条只留最近的', () => {
  let store = null;
  for (let i = 0; i < cache.CACHE_LIMIT + 7; i += 1) {
    store = cache.putSnapshot(store, { url: `https://a.com/${i}`, text: `${longText}第 ${i} 条`, at: 1000 + i }).store;
  }
  assert.equal(store.items.length, cache.CACHE_LIMIT);
  assert.equal(store.items[0].url, `https://a.com/${cache.CACHE_LIMIT + 6}`);
});

check('8. 按地址精确取，不做"差不多"匹配（给了别的页面比不给更糟）', () => {
  const put = cache.putSnapshot(null, { url: 'https://a.com/x', text: longText, at: 5000 });
  assert.ok(cache.getSnapshot(put.store, 'https://a.com/x'));
  assert.ok(cache.getSnapshot(put.store, 'https://a.com/x#section'), '只忽略 hash');
  assert.equal(cache.getSnapshot(put.store, 'https://a.com/x?q=1'), null, '查询串不同就是另一个地址');
  assert.equal(cache.getSnapshot(put.store, 'https://a.com/X'), null, '大小写不同不猜');
  assert.equal(cache.getSnapshot(put.store, 'file:///c:/x'), null);
});

check('9. 坏文件当空表读，不让一个坏 JSON 把离线能力整体搞死', () => {
  for (const bad of ['', '{', '{bad json', 'null', '[]', '{"items":"nope"}', '\uFEFF{"items":[]}']) {
    const store = cache.readCache(bad);
    assert.equal(store.version, cache.CACHE_VERSION);
    assert.ok(Array.isArray(store.items), `「${bad}」应读成空表`);
    assert.equal(store.items.length, 0);
  }
  // 带 BOM 但内容合法的，要能读出来（Windows 上很容易长出 BOM）
  const withBom = `\uFEFF${JSON.stringify({ version: 1, items: [{ url: 'https://a.com/x', title: 't', text: longText, at: 9 }] })}`;
  assert.equal(cache.readCache(withBom).items.length, 1);
});

check('10. 读盘时顺手清脏条目并按时间倒序', () => {
  const raw = JSON.stringify({
    version: 1,
    items: [
      { url: 'https://a.com/old', text: longText, at: 100 },
      { url: 'file:///c:/nope', text: longText, at: 200 },
      { url: 'https://a.com/new', text: longText, at: 300 },
      { url: 'https://a.com/short', text: '短', at: 400 },
      null,
    ],
  });
  const store = cache.readCache(raw);
  assert.deepEqual(store.items.map((item) => item.url), ['https://a.com/new', 'https://a.com/old']);
});

check('11. 缓存页说明必须自称缓存并带抓取时间', () => {
  const snap = cache.normalizeSnapshot({ url: 'https://a.com/x', title: '标题', lines: [longText], at: 1_700_000_000_000 });
  const view = cache.describeCachedPage(snap, { now: 1_700_000_000_000 + 125_000 });
  assert.equal(view.available, true);
  assert.equal(view.title, '标题');
  assert.equal(view.ageText, '2 分钟前');
  assert.ok(/缓存快照/.test(view.note), '说明里必须写明这是缓存快照');
  assert.ok(/不是刚取到/.test(view.note), '必须说明不是最新内容');
  assert.ok(/重试/.test(view.note), '必须给出下一步');
  assert.ok(view.time.includes('T'), '要带 ISO 时间戳');
});

check('12. 没有缓存时给中文说明，而不是空对象或 null', () => {
  const view = cache.describeCachedPage(null, {});
  assert.equal(view.available, false);
  assert.equal(view.text, '');
  assert.ok(view.note.length > 5);
  assert.ok(/没有缓存/.test(view.note));
});

check('13. 页面侧采集脚本：跳过脚本/样式，且是 String.raw 拼的', () => {
  const script = cache.buildCaptureScript();
  assert.ok(script.includes('script,style,noscript,svg,iframe'), '要跳过脚本与样式节点');
  assert.ok(script.includes('querySelector'), '要能取正文根节点');
  assert.ok(script.includes('return { ok: true'), '要回传结果对象');
  assert.ok(script.includes('\\n'), '正则里的 \\n 必须保持转义（普通模板串会变成真换行）');
  assert.ok(!script.includes('\n\n\n'), '不应出现连空行');
  const src = read('src/core/page-cache.js');
  assert.ok(src.includes('String.raw`(() => {'), '采集脚本必须用 String.raw 拼');
});

check('14. 接线：主进程写/读/取三处都在，且隐私模式不写', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("readFileSync(file, 'utf8')"), '启动时要读 page-cache.json');
  assert.ok(main.includes("userDataFile('page-cache.json')"), '缓存文件落在 userData');
  assert.ok(main.includes('initPageCache();'), 'bootstrap 里要初始化缓存');
  assert.ok(main.includes('savePageCache('), '加载完成后要写快照');
  assert.ok(main.includes("sessions.getMode() === 'private'"), '隐私模式必须拒绝写缓存');
  assert.ok(main.includes("ipcMain.handle('nyx:error:cached'"), '失败页要能取缓存');
  assert.ok(read('src/preload.js').includes('errorCachedPage'), 'preload 暴露 errorCachedPage');
  const html = read('src/renderer/index.html');
  for (const id of ['pe-cached', 'pe-cached-label', 'pe-cached-note', 'pe-cached-text']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  const js = read('src/renderer/renderer.js');
  assert.ok(js.includes('loadCachedPage('), 'renderer 要调用 loadCachedPage');
  assert.ok(js.includes('peCachedText'), 'renderer 要写缓存正文');
});

check('15. 离线缓存是可选开关：默认开，关掉后不再写（候选③）', () => {
  const store = require('../src/core/ui-store');
  assert.equal(store.UI_PREF_DEFAULTS.offlineCacheEnabled, true, '默认应为开启');
  const main = read('src/main.js');
  assert.ok(
    main.includes('uiStore.get().offlineCacheEnabled === false'),
    '写快照前必须问用户的开关（关掉就不能继续写）',
  );
});

check('16. 关掉开关会把已经落盘的正文明文一起清掉，并把条数回给界面', () => {
  const main = read('src/main.js');
  assert.ok(main.includes('function clearPageCache('), '要有集中清理函数');
  assert.ok(/runtime\.pageCache = \{ version: CACHE_VERSION, items: \[\] \}/.test(main), '清理要真的把内存清空');
  assert.ok(main.includes('PAGE_CACHE_CLEARED'), '清理要落日志');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:set'"), '要有开关 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:clear'"), '要有手动清空 IPC');
  assert.ok(/cleared = \(runtime\.pageCache && runtime\.pageCache\.items\.length\) \|\| 0/.test(main), '要如实回传清掉多少条');
  assert.ok(/if \(!enabled\) \{/.test(main), '关掉时必须走清理分支');
});

check('17. 开关的状态包如实带条目数、上限与文件落点', () => {
  const main = read('src/main.js');
  assert.ok(main.includes('function offlineCachePayload()'), '要有统一状态包');
  for (const key of ['enabled', 'count', 'limit', 'file', 'note']) {
    assert.ok(new RegExp(`\\b${key}:`).test(main), `状态包里缺少 ${key}`);
  }
  assert.ok(main.includes('隐私模式从不写入'), '状态包要写明隐私模式的边界');
});

check('18. 接线：preload 三个方法 + 设置页卡片 + 进分区回读', () => {
  const preload = read('src/preload.js');
  for (const name of ['offlineCacheGet', 'offlineCacheSet', 'offlineCacheClear']) {
    assert.ok(preload.includes(name), `preload 缺少 ${name}`);
  }
  const html = read('src/renderer/settings.html');
  for (const id of ['offline-badge', 'offline-cache-enabled', 'btn-offline-clear', 'offline-facts', 'offline-status']) {
    assert.ok(html.includes(`id="${id}"`), `settings.html 缺少 #${id}`);
  }
  assert.ok(/关掉这个开关会停止写入，并把已经保存的快照一起清掉/.test(html), '卡片要直说关掉会清空');
  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('loadOfflineCache();'), '进隐私分区要回读');
  assert.ok(js.includes('renderOfflineCache'), '要有渲染函数');
  assert.ok(js.includes('没有改成：'), '失败要如实说"没有改成"');
});

check('19. 开关必须真被读到：UiStore.get() 不接受参数，调用时不得传键名', () => {
  const store = require('../src/core/ui-store');
  const storeSrc = read('src/core/ui-store.js');
  assert.ok(/  get\(\) \{/.test(storeSrc), 'UiStore.get() 的签名必须是无参的');
  const instance = new store.UiStore({ stateDir: path.join(require('node:os').tmpdir(), `nyx-ui-store-probe-${process.pid}`) });
  const all = instance.get();
  assert.equal(typeof all, 'object', 'get() 返回整份偏好对象');
  assert.equal(all.offlineCacheEnabled, true, '默认应带 offlineCacheEnabled=true');

  // 关键回归：曾经写成 get('offlineCacheEnabled')，拿到的是整个对象，
  // 于是 !== false 永远成立 —— 开关关掉了其实还在缓存。
  const main = read('src/main.js');
  assert.ok(
    !/uiStore\.get\(\s*'/.test(main) && !/uiStore\.get\(\s*"/.test(main),
    'main.js 里不得出现 uiStore.get(键名)：get() 不接受参数，要写成 get().键名',
  );
  assert.ok(main.includes("uiStore.get().offlineCacheEnabled === false"), '写缓存前必须真的问到开关值');
  assert.ok(main.includes('uiStore.get().offlineCacheEnabled !== false'), '状态包必须真的报到开关值');
  assert.ok(/saved\.ok === false/.test(main), 'set() 返回 ok:false 时必须如实失败，不能假装保存成功');
});

/* ------------------------------------------------------------------ */

const failed = checks.filter((item) => !item.ok);
const total = checks.length;
console.log('');
console.log(`离线页面缓存：${total} 项检查，${total - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  ✘ ${item.name}｜${item.error}`);
  process.exitCode = 1;
}
