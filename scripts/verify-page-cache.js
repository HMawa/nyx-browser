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

check('13. 页面侧采集脚本：跳过脚本/样式（v2 用 TreeWalker），且是 String.raw 拼的', () => {
  const script = cache.buildCaptureScript();
  assert.ok(script.includes('createTreeWalker'), 'v2 采集要用 TreeWalker 按块走');
  for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'IFRAME']) {
    assert.ok(script.includes(`'${tag}'`), `跳过集合里要有 ${tag}`);
  }
  assert.ok(script.includes('querySelector'), '要能取正文根节点');
  assert.ok(script.includes('return { ok: true'), '要回传结果对象');
  assert.ok(script.includes('\\s+'), '正则里的 \\s 必须保持转义（普通模板串会把反斜杠吃掉）');
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
  // 隐私模式的口径变了（用户第 2 项）：不再写"从不写入"，而是"整条加密单独存放"。
  // 两句话只能有一句为真，所以这里同时断言旧说法不许残留。
  assert.ok(main.includes('隐私模式的快照整条加密'), '状态包要写明隐私模式的快照是加密存的');
  assert.ok(!main.includes('隐私模式从不写入'), '旧口径（从不写入）已经过时，不许两边都留着');
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

/* ---- v2：块结构 + 图片说明（候选②） ---- */

check('20. v2 快照保留语义块结构，而不是一锅纯文本', () => {
  const cache = require('../src/core/page-cache');
  assert.equal(cache.CACHE_VERSION, 2, '缓存格式应已升到 v2');
  const snap = cache.normalizeSnapshot({
    url: 'https://example.com/a',
    title: '块结构',
    blocks: [
      { type: 'heading', text: '一级标题' },
      { type: 'para', text: '这是正文段落，长度足够。' },
      { type: 'list', text: '列表项一' },
      { type: 'code', text: 'const a = 1;' },
      { type: 'unknown-type', text: '未知类型要归一到 para' },
    ],
  });
  assert.ok(snap, '应当生成快照');
  assert.deepEqual(
    snap.blocks.map((block) => block.type),
    ['heading', 'para', 'list', 'code', 'para'],
    '块类型要保留，未知类型归一成 para',
  );
  assert.ok(snap.blocks.every((block) => typeof block.text === 'string' && block.text), '每块都要有文本');
});

check('21. 图片默认只存说明文字（alt），没有本体时不假装存了图', () => {
  const cache = require('../src/core/page-cache');
  const snap = cache.normalizeSnapshot({
    url: 'https://example.com/b',
    blocks: [{ type: 'para', text: '正文在这里，大约四十个头，保证超过缓存的最小长度要求，不然快照会被拒。' }],
    images: [{ alt: '一张价格趋势图' }, { alt: '' }, { src: 'https://cdn.example.com/x.png' }],
    skippedImages: 7,
  });
  // 没有 alt 但有 http(s) 地址的条目要留下（它是"能去取本体"的候选），
  // 既没有 alt 也没有可用地址的才丢。
  assert.equal(snap.images.length, 2, '空 alt 但有地址的要留；两样都没有的才丢');
  assert.equal(snap.images[0].alt, '一张价格趋势图');
  assert.ok(!snap.images[0].dataUrl, '这一条没有本体，不许凭空写 dataUrl');
  assert.ok(!JSON.stringify(snap).includes('base64'), '没有取过本体就不许出现 base64');
  assert.ok(snap.skippedImages >= 7, '跳过了多少张图要如实记账');
});

check('21b. 取到的小图能贴回快照，超过上限的一律退回只有说明（候选②）', () => {
  const cache = require('../src/core/page-cache');
  const snap = cache.normalizeSnapshot({
    url: 'https://example.com/img',
    blocks: [{ type: 'para', text: '正文在这里，大约四十个头，保证超过缓存的最小长度要求，不然快照会被拒。' }],
    images: [
      { alt: '小图', src: 'https://cdn.example.com/small.png' },
      { alt: '大图', src: 'https://cdn.example.com/big.png' },
      { alt: '没有地址', src: 'data:image/png;base64,AAAA' },
    ],
  });
  assert.deepEqual(cache.imageTargets(snap), ['https://cdn.example.com/small.png', 'https://cdn.example.com/big.png'], '只挑 http(s) 且还没有本体的图');

  const small = 'data:image/png;base64,' + 'A'.repeat(200);
  const attached = cache.attachImageData(snap, [{ src: 'https://cdn.example.com/small.png', dataUrl: small, bytes: 150 }]);
  assert.equal(attached.images[0].dataUrl, small, '取到的小图要贴回对应那条');
  assert.equal(attached.images[0].bytes, 150);
  assert.ok(!attached.images[1].dataUrl, '没取到的图保持只有说明');

  const huge = 'data:image/png;base64,' + 'A'.repeat(300000);
  const rejected = cache.attachImageData(snap, [{ src: 'https://cdn.example.com/big.png', dataUrl: huge, bytes: 225000 }]);
  assert.ok(!rejected.images.some((image) => image.dataUrl), '超过单张上限的图不许贴进去');
  assert.ok(cache.CACHE_IMAGE_BYTES_MAX <= 120 * 1024, '单张上限不许悄悄放宽');
  assert.ok(cache.CACHE_IMAGE_TOTAL_MAX <= 480 * 1024, '一页合计上限不许悄悄放宽');
  assert.ok(cache.CACHE_IMAGE_FETCH_MAX <= 6, '一页最多取 6 张，别把整页图都拉下来');
});

check('22. v1 旧快照（只有 text）仍然能用，自动降级成段落块', () => {
  const cache = require('../src/core/page-cache');
  const legacy = cache.normalizeSnapshot({
    url: 'https://example.com/c',
    title: '旧格式',
    text: '第一段正文内容写得足够长，长到超过缓存要求的最小长度。\n第二段正文内容同样要足够长，否则整条快照会被当成没正文。',
  });
  assert.ok(legacy, 'v1 快照不能因为格式升级就读不出来');
  assert.ok(legacy.blocks.length >= 2, '旧文本要按行拆成段落块');
  assert.ok(legacy.blocks.every((block) => block.type === 'para'), '旧文本只能当段落');
  assert.ok(legacy.text.includes('第一段正文'), 'text 字段要保留，兼容老界面');
});

check('23. 接线：失败页有块容器，渲染函数按类型出节点', () => {
  const html = read('src/renderer/index.html');
  assert.ok(html.includes('id="pe-cached-blocks"'), '失败页要有块容器');
  const js = read('src/renderer/renderer.js');
  assert.ok(js.includes('renderCachedBlocks'), '要按块渲染');
  assert.ok(js.includes('pe-cached-h'), '标题要单独一个类');
  assert.ok(js.includes('pe-cached-list'), '列表要单独一个类');
  assert.ok(js.includes('pe-cached-${type}'), '其余块类型按 pe-cached-<type> 生成类名');
  assert.ok(js.includes('［图片］'), '图片要给一条说明，不能当正文');
  const css = read('src/renderer/style.css');
  assert.ok(css.includes('.pe-cached-blocks'), '块容器要有样式');
  for (const cls of ['.pe-cached-quote', '.pe-cached-code', '.pe-cached-caption']) {
    assert.ok(css.includes(cls), `样式里要有 ${cls}`);
  }
});

/* ---------------- 隐私模式的加密快照（用户第 2 项） ---------------- */

const privateCache = require('../src/core/private-cache');

check('24. 隐私模式的快照只能加密存：系统密钥不可用时一条都不许写', () => {
  const off = privateCache.pickPrivateStoreMode({ encryptionAvailable: false });
  assert.equal(off.ok, false, '密钥不可用时不许开启');
  assert.equal(off.mode, 'off', '密钥不可用时模式必须是 off');
  assert.ok(/系统密钥/.test(off.reason), '要说清是系统密钥的问题');
  assert.ok(/不会|不.*保存/.test(off.reason), '要明确说不会保存，不能含糊');
  const disabled = privateCache.pickPrivateStoreMode({ encryptionAvailable: true, enabled: false });
  assert.equal(disabled.ok, false, '用户关掉之后也不许写');
  assert.ok(/关掉/.test(disabled.reason), '关掉时要说清是被关掉的');
  const on = privateCache.pickPrivateStoreMode({ encryptionAvailable: true });
  assert.equal(on.mode, 'encrypted', '密钥可用时走加密');
  assert.ok(/加密/.test(on.reason), '说明里要出现「加密」两个字');
});

check('25. 一条记录：地址只留哈希、正文太短不存、超长截断', () => {
  const hash = (text) => `h${text.length}`;
  const short = privateCache.preparePrivateRecord(
    { url: 'https://a.test/x', title: 't', blocks: [{ type: 'para', text: '太短' }] },
    { now: 10, hash },
  );
  assert.equal(short.ok, false, '正文不足 20 字不该存');
  assert.ok(/正文太短/.test(short.reason), '要给中文原因');

  const noUrl = privateCache.preparePrivateRecord({ blocks: [{ type: 'para', text: '足够长的正文内容用来测试。' }] }, { now: 1, hash });
  assert.equal(noUrl.ok, false, '没有地址不存');
  assert.ok(/地址/.test(noUrl.reason), '要说是地址的问题');

  const long = 'x'.repeat(privateCache.PRIVATE_CACHE_TEXT_MAX + 500);
  const ok = privateCache.preparePrivateRecord({ url: 'https://a.test/x', title: 'y'.repeat(500), text: long }, { now: 7, hash });
  assert.equal(ok.ok, true, '正文够长要能整理成功');
  assert.equal(ok.record.hash, privateCache.hashUrl('https://a.test/x', hash), '索引只留哈希，不存明文地址');
  assert.ok(!JSON.stringify(Object.keys(ok.record)).includes('url'), '记录外层不许有明文地址字段');
  assert.equal(ok.record.payload.text.length, privateCache.PRIVATE_CACHE_TEXT_MAX, '正文要按上限截断');
  assert.equal(ok.record.payload.title.length, 200, '标题也要截断');
  assert.ok(ok.record.payload.url.startsWith('https://'), '地址放在要加密的 payload 里');
});

check('26. 存储归一：坏条目、过期、重复、超上限都按规矩处理', () => {
  const now = 1_000_000_000;
  const fresh = now - 1000;
  const stale = now - privateCache.PRIVATE_CACHE_TTL_MS - 1000;
  const store = privateCache.normalizePrivateStore(
    {
      entries: [
        { hash: 'a', at: fresh, blob: 'BLOB-A' },
        { hash: 'a', at: fresh - 10, blob: 'BLOB-A2' },
        { hash: 'b', at: stale, blob: 'BLOB-B' },
        { hash: 'c', at: fresh, blob: '' },
        { nope: true },
        { hash: 'd', at: fresh, blob: 'BLOB-D' },
      ],
    },
    { now },
  );
  const hashes = store.entries.map((item) => item.hash);
  assert.deepEqual(hashes.slice(0, 2), ['a', 'd'], '最新的在前、重复的只留一条');
  assert.ok(!hashes.includes('b'), '过期（超过 24 小时）的要丢掉');
  assert.ok(!hashes.includes('c'), '没有密文的条目不算数');
  const many = privateCache.normalizePrivateStore(
    { entries: Array.from({ length: 30 }, (_, i) => ({ hash: `h${i}`, at: fresh - i, blob: 'B' })) },
    { now },
  );
  assert.equal(many.entries.length, privateCache.PRIVATE_CACHE_LIMIT, '最多留 20 条');
});

check('27. 同地址覆盖而不是堆两条；说明里必须自称加密并说清有效期', () => {
  const now = 5000;
  let store = privateCache.normalizePrivateStore(null, { now });
  store = privateCache.putPrivateEntry(store, { hash: 'a', at: now - 100, blob: 'OLD' }, { now });
  store = privateCache.putPrivateEntry(store, { hash: 'a', at: now, blob: 'NEW' }, { now });
  assert.equal(store.entries.length, 1, '同一地址只能一条');
  assert.equal(store.entries[0].blob, 'NEW', '后写的覆盖前面的');

  const described = privateCache.describePrivateEntry(store.entries[0], { now });
  assert.equal(described.available, true, '有密文就该可用');
  assert.equal(described.encrypted, true, '要标明是加密的');
  assert.ok(/加密/.test(described.note), '说明里要写「加密」');
  assert.ok(/24 小时/.test(described.note), '说明里要写 24 小时后作废');
  assert.ok(/这台机器/.test(described.note), '说明里要写只能在这台机器解开');
  const missing = privateCache.describePrivateEntry(null, { now });
  assert.equal(missing.available, false, '没有条目要给 available:false');
  assert.ok(/没有/.test(missing.note), '要说清没有');
});

check('28. 接线：隐私模式走独立加密文件，明文快照那条路不许漏', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("sessions.getMode() === 'private') return savePrivatePageCache("), '隐私模式必须转到加密写入');
  assert.ok(main.includes('safeStorage.encryptString('), '要用 safeStorage 加密');
  assert.ok(main.includes('safeStorage.decryptString('), '读取时要解密');
  assert.ok(main.includes("userDataFile('private-cache.json')"), '加密快照要有自己的文件');
  assert.ok(/if \(!decision\.ok\)/.test(main), '密钥不可用时必须走拒绝分支');
  assert.ok(main.includes('PRIVATE_CACHE_SKIPPED'), '没存下来要留诊断，不许静默');
  assert.ok(main.includes('function clearPrivateCache('), '要能单独清掉加密快照');
  assert.ok(/sessions\.getMode\(\) === 'private'[\s\S]{0,200}getPrivateCachedPage/.test(main), '失败页取缓存时要区分隐私模式');
  const store = read('src/core/ui-store.js');
  assert.ok(store.includes('privateSnapshotEnabled: true'), '隐私快照要有独立开关，默认开');
  const html = read('src/renderer/settings.html');
  assert.ok(html.includes('id="offline-private-enabled"'), '设置页要有隐私快照开关');
  assert.ok(html.includes('id="offline-private-facts"'), '设置页要如实显示条目数与落点');
  assert.ok(/整条加密/.test(html), '界面上要写明整条加密');
  const js = read('src/renderer/settings.js');
  assert.ok(js.includes("privateBox.disabled = !usable"), '密钥不可用时开关要禁掉，别让人以为开了就有');
});

/* ---------------- 按站点的黑白名单（用户第 5 项） ---------------- */

check('29. 默认全存；黑名单命中就不存，而且黑名单压过白名单', () => {
  const all = cache.decideCacheSite('https://news.test/a', { mode: 'all' });
  assert.equal(all.cache, true, '默认应该缓存');
  assert.equal(all.layer, 'all', '命中层要说清是「全存」');

  const blocked = cache.decideCacheSite('https://bank.test/x', {
    mode: 'allowlist',
    allow: ['bank.test'],
    block: ['bank.test'],
  });
  assert.equal(blocked.cache, false, '两张名单都在时，黑名单优先');
  assert.equal(blocked.layer, 'block', '要报是黑名单挡的');
  assert.ok(/不会存快照/.test(blocked.reason), '要用中文说清结果');

  const sub = cache.decideCacheSite('https://ssl.bank.test/x', { block: ['bank.test'] });
  assert.equal(sub.cache, false, '黑名单要连子域一起挡');
});

check('30. 白名单模式：名单内才存，名单外明确说不存并说明原因', () => {
  const inside = cache.decideCacheSite('https://www.example.com/a', { mode: 'allowlist', allow: ['example.com'] });
  assert.equal(inside.cache, true, '名单里（含子域）要缓存');
  assert.equal(inside.layer, 'allow', '要报是白名单放行的');

  const outside = cache.decideCacheSite('https://other.test/a', { mode: 'allowlist', allow: ['example.com'] });
  assert.equal(outside.cache, false, '名单外的站点不缓存');
  assert.equal(outside.layer, 'not-listed', '要报是「不在名单里」');
  assert.ok(/不在名单里/.test(outside.reason), '原因要说清是名单的问题');

  const noHost = cache.decideCacheSite('about:blank', { mode: 'all' });
  assert.equal(noHost.cache, false, '没有站点的地址不缓存');
  assert.equal(noHost.layer, 'no-host', '要报是地址的问题');
});

check('31. 名单条目归一：协议 / www / 大小写 / 尾点 / 空行都吃掉', () => {
  const list = cache.normalizeSiteList([
    ' HTTPS://WWW.Example.COM/Path ',
    'example.com.',
    '',
    '   ',
    'https://example.com',
    123,
    null,
  ]);
  assert.deepEqual(list, ['example.com'], '同一个站点只留一条，且归一成裸域名');
  assert.equal(cache.normalizeSiteText('https://a.test/x'), 'a.test', '带协议的也要能归一');
  assert.equal(cache.normalizeSiteText('not a host'), '', '不像域名的返回空串');
  const many = cache.normalizeSiteList(Array.from({ length: 260 }, (_, i) => `s${i}.test`));
  assert.equal(many.length, 200, '名单最多 200 条，不许无限长');
});

check('32. 策略归一：模式认白名单两个值，脏数据回落到「全存」', () => {
  assert.equal(cache.normalizeSitePolicy({ mode: 'allowlist' }).mode, 'allowlist', '合法模式要保留');
  assert.equal(cache.normalizeSitePolicy({ mode: 'weird' }).mode, 'all', '非法模式回落到全存（保守但可预期）');
  const policy = cache.normalizeSitePolicy({ mode: 'all', allow: ['a.test', 'A.TEST'], block: ['https://b.test'] });
  assert.deepEqual(policy.allow, ['a.test'], '归一后去重');
  assert.deepEqual(policy.block, ['b.test'], '黑名单也归一');
});

check('33. 接线：判定发生在抓取之前，名单能从设置页改、能落到诊断里', () => {
  const main = read('src/main.js');
  const idx = main.indexOf('const siteDecision = decideCacheSite(');
  assert.ok(idx > 0, '入口要先做一次站点判定');
  const beforeCapture = main.indexOf('executeJavaScript(buildPageCaptureScript()', idx);
  assert.ok(beforeCapture > idx, '判定必须发生在抓取之前（不缓存就别浪费一次网络与解析）');
  assert.ok(main.includes('PAGE_CACHE_SITE_SKIPPED'), '被名单挡掉要留诊断，不许静默');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:sites'"), '要有读名单的 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:sites-set'"), '要有写名单的 IPC');
  assert.ok(main.includes('PAGE_CACHE_SITES_UPDATED'), '改完要记一条诊断');
  const preload = read('src/preload.js');
  assert.ok(preload.includes('offlineCacheSites'), 'preload 要暴露读名单');
  assert.ok(preload.includes('offlineCacheSitesSet'), 'preload 要暴露写名单');
  const html = read('src/renderer/settings.html');
  for (const id of ['offline-site-mode', 'offline-site-allow', 'offline-site-block', 'offline-site-facts']) {
    assert.ok(html.includes(`id="${id}"`), `设置页缺少 ${id}`);
  }
  assert.ok(/黑名单优先/.test(html), '界面上要写明黑名单优先');
  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('function renderCacheSites('), '要有渲染名单的函数');
  assert.ok(js.includes('function wireCacheSites('), '要有绑定名单的函数');
  assert.ok(/loadCacheSites\(\)/.test(js), '进分区要回读一次');
});

/* ------------------------------------------------------------------ */

check('34. 导出的是「缓存站点名单」这份格式，不是 agent 站点名单', () => {
  const exported = cache.exportCacheSites(
    { mode: 'allowlist', allow: ['b.test', 'https://WWW.A.test', 'A.test'], block: ['bank.test'] },
    Date.UTC(2026, 10, 14),
  );
  assert.equal(exported.app, 'nyx', '要写 app');
  assert.equal(exported.kind, 'nyx-cache-sites', 'kind 必须和 agent 站点名单区分开');
  assert.equal(exported.version, 1, '格式版本要写出来');
  assert.equal(exported.exportedAt, '2026-11-14T00:00:00.000Z', '导出时间用 ISO');
  assert.equal(exported.mode, 'allowlist', '模式要带上');
  assert.deepEqual(exported.allow, ['b.test', 'a.test'], '导出前先归一（去重、去 www）');
  assert.deepEqual(exported.block, ['bank.test'], '黑名单也要带上');
});

check('35. 导入：默认并入、重复的算「已存在」，模式跟着文件走', () => {
  const text = JSON.stringify({
    app: 'nyx',
    kind: 'nyx-cache-sites',
    version: 1,
    mode: 'allowlist',
    allow: ['c.test', 'https://WWW.A.test', 'c.test'],
    block: ['bank.test'],
  });
  const merged = cache.importCacheSites(text, { mode: 'all', allow: ['a.test'], block: [] });
  assert.equal(merged.ok, true, `应当导入成功：${merged.error || ''}`);
  assert.equal(merged.mode, 'merge', '默认是并入');
  assert.deepEqual(merged.allow, ['a.test', 'c.test'], '已有的保留，新的并进来');
  assert.equal(merged.duplicates >= 0, true, '重复计数不能是负的');
  assert.equal(merged.siteMode, 'allowlist', '模式要跟着文件走');
  assert.equal(merged.modeAdopted, true, '模式变了要能看出来');
  assert.ok(/导入完成/.test(merged.summary), '要有中文小结');

  const replaced = cache.importCacheSites(text, { mode: 'all', allow: ['keep.test'], block: ['old.test'] }, { mode: 'replace' });
  assert.deepEqual(replaced.allow.slice().sort(), ['a.test', 'c.test'], 'replace 要整份替换');
  assert.deepEqual(replaced.block, ['bank.test'], '黑名单也跟着替换');
});

check('36. 导入拒绝的四种情形都要说清原因，且不动现有名单', () => {
  const current = { mode: 'all', allow: ['keep.test'], block: [] };
  const bad = cache.importCacheSites('这不是 JSON', current);
  assert.equal(bad.ok, false, '坏 JSON 要拒绝');
  assert.ok(/不是 JSON/.test(bad.error), '要说清是 JSON 的问题');
  assert.deepEqual(bad.policy.allow, ['keep.test'], '拒绝时现有名单不能被改');

  const notObject = cache.importCacheSites('[1,2,3]', current);
  assert.equal(notObject.ok, false, '数组不是一份名单');
  assert.ok(/一个对象/.test(notObject.error), '要说清要的是对象');

  const wrongKind = cache.importCacheSites(JSON.stringify({ kind: 'agent-sites', allow: ['x.test'] }), current);
  assert.equal(wrongKind.ok, false, '别把 agent 站点名单当缓存名单导进来');
  assert.ok(/agent-sites/.test(wrongKind.error), '要把实际类型说出来');

  const empty = cache.importCacheSites(JSON.stringify({ kind: 'nyx-cache-sites' }), current);
  assert.equal(empty.ok, false, '两张名单都没有时不能当成功');
  assert.ok(/allow/.test(empty.error) && /block/.test(empty.error), '要说清缺的是哪两个字段');

  const junk = cache.importCacheSites(
    JSON.stringify({ kind: 'nyx-cache-sites', allow: ['ok.test', '', 'not a host'], block: [] }),
    current,
  );
  assert.equal(junk.ok, true, '有脏条目也要照常导入能认的');
  assert.equal(junk.rejectedCount, 2, '看不懂的条目要计数');
  assert.equal(junk.rejected.length, 2, '要把跳过的条目回给界面');
});

check('37. 接线：导出/导入走同步对话框，导入后界面按返回值重画名单', () => {
  const main = read('src/main.js');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:sites-export'"), '要有导出 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:sites-import'"), '要有导入 IPC');
  assert.ok(/dialog\.showSaveDialogSync\(/.test(main), '导出必须用同步对话框（异步会重演下载那个坑）');
  assert.ok(/dialog\.showOpenDialogSync\(/.test(main), '导入也一样');
  assert.ok(main.includes('exportCacheSites('), '导出要走纯函数');
  assert.ok(main.includes('importCacheSites('), '导入要走纯函数');
  assert.ok(main.includes('saveCacheSitePolicy('), '导入完要落盘');
  assert.ok(main.includes('PAGE_CACHE_SITES_EXPORTED'), '导出要记诊断');
  assert.ok(main.includes('PAGE_CACHE_SITES_IMPORTED'), '导入要记诊断');
  assert.ok(main.includes('PAGE_CACHE_SITES_IMPORT_REJECTED'), '被拒绝也要记诊断');
  assert.ok(main.includes('PAGE_CACHE_SITES_EXPORT_FAILED'), '导出失败要记诊断');

  const preload = read('src/preload.js');
  assert.ok(preload.includes('offlineCacheSitesExport'), 'preload 要暴露导出');
  assert.ok(preload.includes('offlineCacheSitesImport'), 'preload 要暴露导入');

  const html = read('src/renderer/settings.html');
  assert.ok(html.includes('id="btn-offline-sites-export"'), '设置页要有导出按钮');
  assert.ok(html.includes('id="btn-offline-sites-import"'), '设置页要有导入按钮');
  assert.ok(html.includes('id="offline-site-io"'), '要有单独一行说导入导出结果');

  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('offlineCacheSitesExport'), '界面要真的调导出');
  assert.ok(js.includes('offlineCacheSitesImport'), '界面要真的调导入');
  assert.ok(/没能导出名单/.test(js) && /没能导入名单/.test(js), '失败要有中文前缀，别静默');
  assert.ok(/renderCacheSites\(res\)/.test(js), '导入成功要按返回值重画名单');
});

check('38. 数得清「解不开的」有几条：能解、解不开、抛异常三种都要算对', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const store = {
    v: 1,
    entries: [
      { hash: 'aaa', at: now - 1000, blob: 'good' },
      { hash: 'bbb', at: now - 2000, blob: 'bad' },
      { hash: 'ccc', at: now - 3000, blob: 'boom' },
    ],
  };
  const result = privateCache.inspectPrivateStore(store, {
    now,
    decrypt: (entry) => {
      if (entry.blob === 'good') return { ok: true };
      if (entry.blob === 'bad') return { ok: false };
      throw new Error('解不开');
    },
  });
  assert.equal(result.total, 3, '三条都要数进来');
  assert.equal(result.readable, 1, '能解开的 1 条');
  assert.equal(result.broken, 2, '解不开 + 抛异常的 2 条');
  assert.ok(/有 2 条加密快照解不开/.test(result.note), '说明里要如实报条数');
  assert.ok(/不会自己恢复/.test(result.note), '要说清它不会自己好起来');

  const allGood = privateCache.inspectPrivateStore(
    { v: 1, entries: [{ hash: 'x', at: now - 1000, blob: 'g' }] },
    { now, decrypt: () => ({ ok: true }) },
  );
  assert.equal(allGood.broken, 0, '都能解开时不许凭空报故障');
  assert.ok(/都能在这台机器/.test(allGood.note), '正常时也要有一句明确结论');
});

check('39. 只清解不开的那些，能解的留着（不给「换过账户」的人一刀切）', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const store = {
    v: 1,
    entries: [
      { hash: 'keep1', at: now - 1000, blob: 'good' },
      { hash: 'drop1', at: now - 2000, blob: 'bad' },
      { hash: 'keep2', at: now - 3000, blob: 'good2' },
    ],
  };
  const result = privateCache.dropBrokenEntries(store, {
    now,
    decrypt: (entry) => ({ ok: entry.blob.startsWith('good') }),
  });
  assert.equal(result.before, 3, '清之前是 3 条');
  assert.equal(result.dropped, 1, '只清掉 1 条解不开的');
  assert.equal(result.after, 2, '剩 2 条');
  assert.deepEqual(
    result.store.entries.map((item) => item.hash).sort(),
    ['keep1', 'keep2'],
    '能解开的必须原样留着',
  );
  const nothing = privateCache.dropBrokenEntries(
    { v: 1, entries: [{ hash: 'a', at: now - 1000, blob: 'good' }] },
    { now, decrypt: () => ({ ok: true }) },
  );
  assert.equal(nothing.dropped, 0, '没有坏条目时不许动数据');
});

check('40. 解不开时既说清原因，也给出「一键清掉」的出口', () => {
  const main = read('src/main.js');
  assert.ok(/解不开了（换了系统账户或密钥变了）/.test(main), '要如实说是解不开，不是「没有缓存」');
  assert.ok(/一键清掉/.test(main), '要告诉用户去哪儿处理');
  assert.ok(main.includes('privateBroken'), '状态包里要带解不开的条数');
  assert.ok(main.includes('inspectPrivateStore('), '条数必须真的逐条试解密算出来');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-reset'"), '要有一个只清坏条目的 IPC');
  assert.ok(main.includes('PRIVATE_CACHE_BROKEN_DROPPED'), '清完要记诊断');
  const preload = read('src/preload.js');
  assert.ok(preload.includes('offlineCachePrivateReset'), 'preload 要暴露这个动作');
  const html = read('src/renderer/settings.html');
  assert.ok(html.includes('id="offline-private-broken"'), '设置页要有这个提示块');
  assert.ok(html.includes('id="btn-offline-private-reset"'), '设置页要有清理按钮');
  const js = read('src/renderer/settings.js');
  assert.ok(js.includes('offlineCachePrivateReset'), '界面要真的调这个接口');
  assert.ok(/brokenBox\.hidden = broken <= 0/.test(js), '没有坏条目时这个块必须是隐藏的');
  assert.ok(/已清掉 \$\{dropped\} 条解不开的快照/.test(js), '清完要如实报清了几条');
});

check('41. 隐私模式另有一份站点名单：默认值与枚举都独立于普通模式', () => {
  const store = read('src/core/ui-store.js');
  assert.ok(/privateSiteMode: 'all'/.test(store), '默认全存');
  assert.ok(/privateSiteAllow: \[\]/.test(store), '默认空白名单');
  assert.ok(/privateSiteBlock: \[\]/.test(store), '默认空黑名单');
  assert.ok(/privateSiteMode: \['all', 'allowlist'\]/.test(store), '枚举要与普通模式一致（两个值）');
  assert.ok(/cacheSiteMode: 'all'/.test(store), '普通模式那份还要在（两份是不同的键）');
});

check('42. 隐私模式保存快照前先按自己的名单判定，黑名单优先', () => {
  const cache = require('../src/core/page-cache');
  const policy = { mode: 'allowlist', allow: ['example.com', 'docs.test'], block: ['bank.example.com'] };
  const allowed = cache.decideCacheSite('https://example.com/a', policy);
  const blocked = cache.decideCacheSite('https://bank.example.com/x', policy);
  const outside = cache.decideCacheSite('https://other.test/', policy);
  assert.strictEqual(allowed.cache, true, '名单里的站点要存');
  assert.strictEqual(blocked.cache, false, '黑名单压过白名单');
  assert.strictEqual(outside.cache, false, '名单外的站点不存');
  assert.ok(outside.reason.length > 0, '不存时要给出中文原因');

  const main = read('src/main.js');
  assert.ok(/function privateSitePolicy\(\)/.test(main), '主进程要有一份隐私模式的策略读取');
  assert.ok(/decideCacheSite\(String\(snapshot && snapshot\.url/.test(main), '保存前要按站点判定');
  const saveStart = main.indexOf('function savePrivatePageCache(');
  const saveEnd = main.indexOf('function getPrivateCachedPage(');
  const body = main.slice(saveStart, saveEnd > saveStart ? saveEnd : saveStart + 4000);
  assert.ok(
    body.indexOf('decideCacheSite(') > -1 && body.indexOf('decideCacheSite(') < body.indexOf('encryptString('),
    '判定必须在加密之前——不该留的站点连密文都不该生成',
  );
  assert.ok(body.includes('PRIVATE_CACHE_SITE_SKIPPED'), '跳过时要记诊断（含 layer 与 host）');
});

check('43. 名单 IPC 支持 scope，两份名单各写各的键', () => {
  const main = read('src/main.js');
  assert.ok(/private: privateSitePolicy\(\)/.test(main), '状态包里要同时带上两份');
  assert.ok(/input\.scope === 'private'/.test(main), 'sites-set 要认 scope');
  assert.ok(/function saveCacheSitePolicy\(policy, scope\)/.test(main), '保存函数要按 scope 选键');
  assert.ok(/privateSiteMode/.test(main) && /privateSiteAllow/.test(main) && /privateSiteBlock/.test(main), '隐私模式写自己那三个键');
  assert.ok(main.includes('PRIVATE_CACHE_SITES_UPDATED'), '改隐私名单也要记诊断');
  const preload = read('src/preload.js');
  assert.ok(preload.includes('offlineCacheSitesSet'), 'preload 复用同一个入口（不新开方法）');
});

check('44. 界面：隐私模式的名单单独一块，且说清「两份分开存」', () => {
  const html = read('src/renderer/settings.html');
  for (const id of [
    'offline-private-site-mode',
    'offline-private-site-allow',
    'offline-private-site-block',
    'offline-private-site-facts',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `设置页缺 ${id}`);
  }
  assert.ok(/两份|分开存/.test(html), '要说明这两份名单为什么要分开');
  const js = read('src/renderer/settings.js');
  assert.ok(/function renderSiteGroup\(/.test(js), '两种名单共用一个渲染函数');
  assert.ok(js.includes("renderSiteGroup('offline-private-site'"), '隐私那一块要被渲染');
  assert.ok(/'private'/.test(js), '保存时要带 scope');
  assert.ok(js.includes("bindList('offline-private-site-allow'"), '隐私白名单要能改');
  assert.ok(js.includes("bindList('offline-private-site-block'"), '隐私黑名单要能改');
});

check('45. 两份名单导出成两种文件：导错文件必须被拒，并说明这是另一份', () => {
  const policy = { mode: 'allowlist', allow: ['keep.example.com'], block: ['never.example.com'] };
  const normalFile = cache.exportCacheSites(policy, Date.UTC(2026, 10, 14), 'normal');
  const privateFile = cache.exportCacheSites(policy, Date.UTC(2026, 10, 14), 'private');
  assert.equal(normalFile.kind, 'nyx-cache-sites', '普通模式沿用原 kind');
  assert.equal(privateFile.kind, 'nyx-private-cache-sites', '隐私模式是另一个 kind');
  assert.equal(privateFile.scope, 'private', '导出文件里要写明是哪一份');

  const wrong = cache.importCacheSites(JSON.stringify(privateFile), { mode: 'all', allow: [], block: [] }, { scope: 'normal' });
  assert.ok(wrong.ok === false, '把隐私名单导进普通模式必须被拒');
  assert.ok(/另一份名单/.test(wrong.error), `拒绝时要说明这是另一份：${wrong.error}`);

  const right = cache.importCacheSites(JSON.stringify(privateFile), { mode: 'all', allow: [], block: [] }, { scope: 'private' });
  assert.ok(right.ok === true, '导到正确的那一份要成功');
  assert.equal(right.policy.allow.length, 1, '名单内容要真的进来');
});

check('46. 接线：两份名单各有自己的导出/导入入口与结果行', () => {
  const main = read('src/main.js');
  assert.ok(/input\.scope === 'private' \? 'private' : 'normal'/.test(main), '导出要认 scope');
  assert.ok(/exportCacheSites\(policy, Date\.now\(\), scope\)/.test(main), '导出要把 scope 传下去');
  assert.ok(/importCacheSites\(text, privateSide \? privateSitePolicy\(\) : cacheSitePolicy\(\), \{/.test(main), '导入要按 scope 选名单');
  assert.ok(/saveCacheSitePolicy\(result\.policy, scope\)/.test(main), '导入后要存回正确的那一份');
  assert.ok(main.includes('nyx-private-cache-sites'), '导出文件名要能区分两份');

  const preload = read('src/preload.js');
  assert.ok(/offlineCacheSitesExport: \(payload\) => ipcRenderer\.invoke\('nyx:offline:sites-export', payload \|\| \{\}\)/.test(preload), 'preload 要透传 scope');

  const html = read('src/renderer/settings.html');
  for (const id of [
    'btn-offline-sites-export',
    'btn-offline-sites-import',
    'btn-offline-private-sites-export',
    'btn-offline-private-sites-import',
    'offline-site-io',
    'offline-private-site-io',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `设置页缺 ${id}`);
  }

  const js = read('src/renderer/settings.js');
  assert.ok(/const wireSiteIo = \(scope, prefix, lineId, what\)/.test(js), '两套按钮共用一个接线函数');
  assert.ok(js.includes("wireSiteIo('private', 'offline-private-sites'"), '隐私那套也要接上');
});

check('47. 「只存这些」模板：模板本身是干净的，站点没有重复也没有写坏的域名', () => {
  const cache = require('../src/core/page-cache');
  const templates = cache.describeSiteTemplates();
  assert.ok(Array.isArray(templates) && templates.length >= 3, '至少要有三组模板');
  for (const template of templates) {
    assert.ok(template.key && template.label && template.summary, `模板 ${template.key} 要有人能看懂的名字与说明`);
    assert.ok(template.sites.length > 0, `模板 ${template.key} 不能是空名单`);
    assert.strictEqual(template.sites.length, template.count, 'count 与 sites 长度要一致');
    assert.strictEqual(new Set(template.sites).size, template.sites.length, `模板 ${template.key} 里站点有重复`);
    for (const site of template.sites) {
      assert.strictEqual(site, cache.normalizeSiteText(site), `模板 ${template.key} 里的 ${site} 不是规范域名`);
    }
  }
});

check('48. 套模板只并进现有名单、不替换用户手写的那份，并把模式切到「只存名单里的」', () => {
  const cache = require('../src/core/page-cache');
  const before = { mode: 'all', allow: ['my.internal.example'], block: ['bank.example'] };
  const result = cache.applySiteTemplate(before, 'docs');
  assert.ok(result.ok === true, `套模板应该成功：${result.error || ''}`);
  assert.ok(result.policy.allow.includes('my.internal.example'), '用户原有条目不许被清掉');
  assert.deepStrictEqual(result.policy.block, ['bank.example'], '黑名单也要原样保留');
  assert.strictEqual(result.policy.mode, 'allowlist', '套模板的意图是"只存这些"，模式要一起切');
  assert.ok(result.added.length > 0, '第一次套要能报出新增了哪些');
  assert.strictEqual(result.modeChanged, true, '模式变了要如实回报');
  assert.ok(/并进名单/.test(result.message), '消息要说清是"并进"而不是"替换"');
});

check('49. 重复套同一个模板不会重复加，也不报成失败、不报成新增', () => {
  const cache = require('../src/core/page-cache');
  const once = cache.applySiteTemplate({ mode: 'all', allow: [], block: [] }, 'docs');
  const twice = cache.applySiteTemplate(once.policy, 'docs');
  assert.ok(twice.ok === true, '第二次套应该正常返回');
  assert.strictEqual(twice.added.length, 0, '第二次没有新增');
  assert.strictEqual(twice.skipped.length, once.added.length, '第一次加进去的这次都算"本来就在"');
  assert.strictEqual(twice.policy.allow.length, once.policy.allow.length, '名单长度不许变');
  assert.strictEqual(twice.modeChanged, false, '模式已经是 allowlist，不该说成变了');
  assert.ok(/本来就在/.test(twice.message), '要说清是本来就在，不是没生效');
});

check('50. 认不出的模板名字要明确拒绝，且不动现有名单', () => {
  const cache = require('../src/core/page-cache');
  const before = { mode: 'allowlist', allow: ['a.example'], block: [] };
  const bad = cache.applySiteTemplate(before, 'nope');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'UNKNOWN_TEMPLATE');
  assert.ok(/没有叫/.test(bad.error), `错误文案要指名道姓：${bad.error}`);
  assert.deepStrictEqual(bad.policy.allow, ['a.example'], '拒绝时名单必须原样返回');
});

check('51. 接线：模板列表与套用各一个 IPC，界面把站点逐项列出来', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const html = read('src/renderer/settings.html');
  const js = read('src/renderer/settings.js');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-templates'"), '缺模板列表 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-template-apply'"), '缺套用 IPC');
  assert.ok(/applySiteTemplate\(privateSitePolicy\(\), key/.test(main), '套用要走纯函数，不能现写一套');
  assert.ok(/saveCacheSitePolicy\(result\.policy, 'private'\)/.test(main), '套完要落进隐私那份名单');
  assert.ok(main.includes('PRIVATE_CACHE_TEMPLATE_APPLIED'), '套用要有诊断记录');
  assert.ok(/offlineCachePrivateTemplateApply/.test(preload), 'preload 缺套用方法');
  assert.ok(html.includes('id="offline-private-template-list"'), '设置页缺模板列表容器');
  assert.ok(html.includes('id="offline-private-template-status"'), '设置页缺模板结果行');
  assert.ok(/async function loadPrivateTemplates\(\)/.test(js), '缺渲染函数');
  assert.ok(/\(template\.sites \|\| \[\]\)\.join\('、'\)/.test(js), '站点要逐项列出，不许折成"等 N 个"');
  assert.ok(/await loadPrivateTemplates\(\)/.test(js), '进分区时要加载模板');
});

check('52. 当前名单能存成自定义模板（存的是名单快照，不存模式）', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['a.test', 'b.test'], block: [] });
  const saved = cache.addCustomTemplate([], policy, '我们组的文档站', 1700000000000);
  assert.ok(saved.ok === true, '应该能存下来');
  assert.equal(saved.template.count, 2);
  assert.equal(saved.templates.length, 1);
  const entry = saved.templates[0];
  assert.equal(entry.label, '我们组的文档站');
  assert.deepEqual(entry.sites, ['a.test', 'b.test'], '存的必须是当前名单快照');
  assert.equal(Object.prototype.hasOwnProperty.call(entry, 'mode'), false, '模板里不许存模式（会覆盖用户当下的选择）');
  assert.equal(entry.createdAt, 1700000000000);
  // 存完之后能被 describeSiteTemplates 合并进来，且标成自定义
  const list = cache.describeSiteTemplates(saved.templates);
  assert.equal(list.length, 3 + 1, '内置三组 + 自定义一条');
  const mine = list.find((item) => item.key === entry.key);
  assert.ok(mine && mine.custom === true, '自定义模板要带 custom 标记');
  assert.ok(!list.find((item) => item.key === 'docs').custom, '内置模板不该被标成自定义');
});

check('53. 重名 / 空名 / 空名单三种情况都拒绝，且给中文原因', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['a.test'], block: [] });
  const first = cache.addCustomTemplate([], policy, '常用', 1);
  assert.ok(first.ok === true);
  const dup = cache.addCustomTemplate(first.templates, policy, '常用', 2);
  assert.ok(dup.ok === false && dup.code === 'DUPLICATE_NAME', '重名要拒');
  assert.ok(dup.error.includes('已经有一个叫「常用」的模板'), '重名要说清是哪个');
  const empty = cache.addCustomTemplate([], policy, '   ', 1);
  assert.ok(empty.ok === false && empty.code === 'EMPTY_NAME');
  assert.ok(empty.error.includes('起个名字'));
  const emptyList = cache.addCustomTemplate([], cache.normalizeSitePolicy(null), '空的', 1);
  assert.ok(emptyList.ok === false && emptyList.code === 'EMPTY_LIST', '名单为空时不该存出一个空模板');
  assert.ok(emptyList.error.includes('名单还是空的'));
  // 满了也要拒
  let many = [];
  for (let i = 0; i < cache.CUSTOM_TEMPLATE_MAX; i += 1) {
    const r = cache.addCustomTemplate(many, policy, `模板${i}`, i + 1);
    assert.ok(r.ok === true, `第 ${i} 个应该能存`);
    many = r.templates;
  }
  const over = cache.addCustomTemplate(many, policy, '再来一个', 99);
  assert.ok(over.ok === false && over.code === 'TOO_MANY_TEMPLATES', '超过上限要拒');
});

check('54. 自定义模板能删，删不存在的模板要如实说没这个模板', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['a.test'], block: [] });
  const saved = cache.addCustomTemplate([], policy, '临时', 1);
  const removed = cache.removeCustomTemplate(saved.templates, saved.template.key);
  assert.ok(removed.ok === true && removed.templates.length === 0, '删掉之后要真的没了');
  const missing = cache.removeCustomTemplate(saved.templates, 'custom-不存在');
  assert.ok(missing.ok === false && missing.code === 'NOT_FOUND');
  assert.ok(missing.error.includes('没有这个模板'), '删不存在的要说清');
  // 坏数据不该把整个文件读崩
  assert.deepEqual(cache.normalizeCustomTemplates([null, {}, { label: 'x' }, 'y']), [], '坏条目全部丢掉');
  assert.equal(cache.normalizeCustomTemplates([{ label: 'A', sites: ['a.test'] }, { label: 'A', sites: ['b.test'] }]).length, 1, '同名只留一条');
});

check('55. 自定义模板能被套用，走的是与内置模板同一条路', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'all', allow: [], block: [] });
  const saved = cache.addCustomTemplate([], cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['mine.test', 'other.test'], block: [] }), '我的', 1);
  const applied = cache.applySiteTemplate(policy, saved.template.key, saved.templates);
  assert.ok(applied.ok === true, '自定义模板要能套用');
  assert.deepEqual(applied.added, ['mine.test', 'other.test']);
  assert.equal(applied.policy.mode, 'allowlist', '套用同样要把模式切到只存名单里的');
  assert.ok(applied.message.includes('我的'), '消息里要带模板名');
  assert.ok(applied.message.includes('并进名单'), '说法要与内置模板一致');
  const unknown = cache.applySiteTemplate(policy, 'custom-没有这条', saved.templates);
  assert.ok(unknown.ok === false && unknown.code === 'UNKNOWN_TEMPLATE', '认不出的自定义 key 也要拒');
});

check('56. 接线：存模板与删模板各一个 IPC，界面输入框与删除按钮都在', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const html = read('src/renderer/settings.html');
  const js = read('src/renderer/settings.js');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-template-save'"), '缺存模板 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-template-remove'"), '缺删模板 IPC');
  assert.ok(/addCustomTemplate\(readCustomTemplates\(\), privateSitePolicy\(\), input\.name/.test(main), '存模板要走纯函数');
  assert.ok(/writeCustomTemplates\(result\.templates\)/.test(main), '存完要落盘');
  assert.ok(main.includes('cache-site-templates.json'), '模板要单独一个文件');
  assert.ok(main.includes('PRIVATE_CACHE_TEMPLATE_SAVED') && main.includes('PRIVATE_CACHE_TEMPLATE_REMOVED'), '两个动作都要留诊断');
  assert.ok(/offlineCachePrivateTemplateSave/.test(preload) && /offlineCachePrivateTemplateRemove/.test(preload), 'preload 缺两个方法');
  assert.ok(html.includes('id="offline-private-template-name"'), '设置页缺命名输入框');
  assert.ok(html.includes('id="btn-offline-private-template-save"'), '设置页缺保存按钮');
  assert.ok(/function wireTemplateSave\(\)/.test(js), '缺保存按钮的绑定');
  assert.ok(/template\.custom \? `\$\{template\.label\}（我的）`/.test(js), '自定义模板要有标记');
  assert.ok(/offlineCachePrivateTemplateRemove\(\{ key: template\.key \}\)/.test(js), '自定义模板要能删');
});

check('57. 模板能导出成文件：带自己的 kind 与版本号，只存名字与站点，不把 mode 塞进去', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['a.test', 'b.test'], block: [] });
  const saved = cache.addCustomTemplate([], policy, '我们组', 1);
  const body = cache.exportCustomTemplates(saved.templates, 1700000000000);
  assert.equal(body.kind, 'nyx-cache-templates', '模板要用自己的 kind');
  assert.notEqual(body.kind, cache.CACHE_SITE_EXPORT_KIND, '别和站点名单共用一个 kind');
  assert.equal(body.version, 2, '模板格式版本单独一个号');
  assert.equal(body.count, 1);
  assert.equal(body.templates[0].label, '我们组');
  assert.deepEqual(body.templates[0].sites, ['a.test', 'b.test']);
  assert.equal(body.templates[0].mode, undefined, '模板不存 mode（套用时只合并不替换）');
  assert.equal(body.exportedAt, new Date(1700000000000).toISOString());
});

check('58. 模板导入：默认并进来，同名不覆盖；replace 顶掉旧的', () => {
  const policy = cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['a.test'], block: [] });
  const mine = cache.addCustomTemplate([], policy, '我的', 1);
  const theirs = cache.addCustomTemplate([], cache.normalizeSitePolicy({ mode: 'allowlist', allow: ['x.test'], block: [] }), '别人的', 2);
  const file = JSON.stringify(cache.exportCustomTemplates(theirs.templates, 3));
  const merged = cache.importCustomTemplates(file, mine.templates);
  assert.ok(merged.ok === true);
  assert.equal(merged.templates.length, 2, 'merge 要把两个都留着');
  assert.ok(merged.summary.includes('新增 1 个模板'), 'summary 要报数');
  const again = cache.importCustomTemplates(file, merged.templates);
  assert.equal(again.added, 0, '同名不该再加一条');
  assert.equal(again.duplicates, 1);
  assert.ok(again.summary.includes('已存在 1 个'));
  const replaced = cache.importCustomTemplates(file, mine.templates, { mode: 'replace' });
  assert.equal(replaced.templates.length, 1, 'replace 只留文件里的');
  assert.equal(replaced.templates[0].label, '别人的');
});

check('59. 导错文件要明确拒绝：站点名单不是模板；更高格式版本要求升级 Nyx', () => {
  const sitesFile = JSON.stringify({ app: 'nyx', kind: cache.CACHE_SITE_EXPORT_KIND, version: 1, allow: ['a.test'], block: [] });
  const wrong = cache.importCustomTemplates(sitesFile, []);
  assert.ok(wrong.ok === false);
  assert.ok(wrong.error.includes('这是站点名单'), '要指出这是名单，别让人以为搬成功了');
  const newer = cache.importCustomTemplates(JSON.stringify({ kind: 'nyx-cache-templates', version: 99, templates: [] }), []);
  assert.ok(newer.ok === false && newer.error.includes('更新版本'), '更高版本要让人升级');
  const notJson = cache.importCustomTemplates('这不是 JSON', []);
  assert.ok(notJson.ok === false && notJson.error.includes('JSON'), '不是 JSON 要说清');
  const noList = cache.importCustomTemplates(JSON.stringify({ kind: 'nyx-cache-templates', version: 2 }), []);
  assert.ok(noList.ok === false && noList.error.includes('templates'), '缺清单要拒');
});

check('60. 导入超过上限时如实说丢掉了几个，不静默截断', () => {
  const many = [];
  for (let i = 0; i < cache.CUSTOM_TEMPLATE_MAX + 3; i += 1) {
    many.push({ label: `组 ${i}`, sites: ['t.test'], createdAt: 1 });
  }
  const file = JSON.stringify({ kind: 'nyx-cache-templates', version: 2, templates: many });
  const result = cache.importCustomTemplates(file, []);
  assert.ok(result.ok === true);
  assert.equal(result.templates.length, cache.CUSTOM_TEMPLATE_MAX, '最多 30 个');
  assert.equal(result.overflow, 3, '要能报出丢掉了几个');
  assert.ok(result.summary.includes('超出上限'), 'summary 要把这件事说出来');
});

check('61. 接线：导出/导入各一个 IPC（同步对话框），界面两个按钮都绑上了', () => {
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const html = read('src/renderer/settings.html');
  const js = read('src/renderer/settings.js');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-templates-export'"), '缺导出 IPC');
  assert.ok(main.includes("ipcMain.handle('nyx:offline:private-templates-import'"), '缺导入 IPC');
  assert.ok(/showSaveDialogSync/.test(main) && /showOpenDialogSync/.test(main), '要用同步对话框（异步会重演 Promise 永挂）');
  assert.ok(/exportCustomTemplates\(custom, Date\.now\(\)\)/.test(main), '导出走纯函数');
  assert.ok(/importCustomTemplates\(text, readCustomTemplates\(\)/.test(main), '导入走纯函数');
  assert.ok(main.includes('PRIVATE_CACHE_TEMPLATES_EXPORTED') && main.includes('PRIVATE_CACHE_TEMPLATES_IMPORTED'), '两个动作都要留诊断');
  assert.ok(main.includes('NOTHING_TO_EXPORT'), '没有模板时要明确说没东西可导');
  assert.ok(/offlineCachePrivateTemplatesExport/.test(preload) && /offlineCachePrivateTemplatesImport/.test(preload), 'preload 缺两个方法');
  assert.ok(html.includes('id="btn-offline-private-templates-export"') && html.includes('id="btn-offline-private-templates-import"'), '设置页缺两个按钮');
  assert.ok(/function wireTemplateIo\(\)/.test(js), '缺模板导入导出的绑定');
  assert.ok(/dataset\.wired !== 'true'/.test(js), '按钮只绑一次');
});

check('63. 隐私名单「现在到底生效没有」要能判定出来（关着 / 加密不可用 / 生效）', () => {
  const main = read('src/main.js');
  assert.ok(/function privateSiteEffective\(\)/.test(main), '缺「是否生效」判定函数');
  assert.ok(/privateSnapshotEnabled !== false/.test(main), '判定要看私密快照开关');
  assert.ok(/isEncryptionAvailable\(\)/.test(main), '判定要看系统加密能不能用');
  // 关着的时候必须给一句人话，不能只回 active:false
  assert.ok(/这份名单暂时不会生效/.test(main), '关着要说清"这份名单暂时不会生效"');
  assert.ok(/隐私模式快照根本不会写盘/.test(main), '加密不可用要说清原因');
  assert.ok(/privateEffective: privateSiteEffective\(\)/.test(main), '站点名单接口要带上生效状态');
  assert.ok(/effective: privateSiteEffective\(\)/.test(main), '模板接口要带上生效状态');
  // 套用模板时，若名单不生效，message 里必须补上原因（否则界面只会说"已并入"）
  assert.ok(/effective\.active \? result\.message :/.test(main) && /effective\.note/.test(main), '套用时要把"不生效"的原因写进返回文案');
  assert.ok(/effective,\n\s+private: privateSitePolicy\(\),/.test(main), '套用结果要带回 effective');
});

check('64. 设置页把「名单不生效」当场说出来，不留到用户自己发现', () => {
  const js = read('src/renderer/settings.js');
  assert.ok(/const effective = res && res\.effective \? res\.effective : null;/.test(js), '界面要读 effective');
  assert.ok(/effective\.active === false/.test(js), '界面要判 active === false');
  assert.ok(/statusLine\.className = 'hint is-warn';/.test(js), '要用警告样式，别混在普通提示里');
  assert.ok(/这份名单现在不会生效/.test(js), '要有一句兜底说明');
  assert.ok(/id="offline-private-template-status"/.test(read('src/renderer/settings.html')), '要用已有状态行，不新造元素');
});

/* ------------------------------------------------------------------ */
check('65. 模板默认「并进」，只有明确要求才「替换」：替换会报出被换掉的站点，屏蔽名单不受影响（第九轮 ⑤）', () => {
  const cache = require('../src/core/page-cache.js');
  const base = cache.normalizeSitePolicy({ mode: 'blocklist', allow: ['keep.test', 'old.test'], block: ['blocked.test'] });

  const merged = cache.applySiteTemplate(base, 'docs', [], { mode: 'merge' });
  assert.ok(merged.ok === true && merged.action === 'merge', '默认应当是合并');
  assert.ok(merged.policy.allow.includes('keep.test'), '合并要把手写的站点留着');
  assert.ok(merged.policy.allow.includes('old.test'), '合并要把手写的站点留着（第二条）');
  assert.ok(merged.policy.allow.length > 2, '合并后应当比原来更多');
  assert.deepStrictEqual(merged.dropped, [], '合并不该有被换掉的站点');
  assert.strictEqual(merged.policy.mode, 'allowlist', '套模板后模式要切到只存名单里的');

  const replaced = cache.applySiteTemplate(base, 'docs', [], { mode: 'replace' });
  assert.ok(replaced.ok === true && replaced.action === 'replace', 'replace 要如实标成替换');
  assert.ok(replaced.dropped.includes('keep.test') && replaced.dropped.includes('old.test'), '被换掉的站点要逐条报出来');
  assert.ok(!replaced.policy.allow.includes('keep.test'), '替换后手写名单不该还在');
  assert.deepStrictEqual([...replaced.policy.block], ['blocked.test'], '替换名单不许动屏蔽名单');
  assert.ok(/被换掉了/.test(replaced.message), '替换要在文案里说清换掉了几个');

  // 不存在的模板、以及"没给 mode"时的默认值，两种边界都要钉住
  const unknown = cache.applySiteTemplate(base, '没有这个模板', [], { mode: 'replace' });
  assert.ok(unknown.ok === false && unknown.code === 'UNKNOWN_TEMPLATE', '未知模板要明确拒绝');
  const noOption = cache.applySiteTemplate(base, 'docs', []);
  assert.ok(noOption.ok === true && noOption.action === 'merge', '不传 options 时必须是合并（向后兼容）');
});

check('66. 模板可以同时套到普通模式那份名单上，两份结果分开报（第九轮 ③）', () => {
  const main = read('src/main.js');
  assert.ok(/const switchMode = String\(input\.mode \|\| 'merge'\) === 'replace';/.test(main), 'IPC 要认 mode，默认 merge');
  assert.ok(/input\.alsoNormal === true/.test(main), '要认 alsoNormal');
  assert.ok(/const normalPolicy = cacheSitePolicy\(\);/.test(main), '普通模式那份名单用 cacheSitePolicy()');
  assert.ok(/saveCacheSitePolicy\(applied\.policy, 'normal'\)/.test(main), '普通那份要独立落盘');
  assert.ok(/CACHE_TEMPLATE_APPLIED_NORMAL/.test(main), '普通那份的结果要留痕');
  assert.ok(/normalNote/.test(main), '两份结果要在文案里分开说');
  assert.ok(/普通模式的名单没改成/.test(main), '普通那份失败必须如实说，不能吞掉');
});

check('67. 设置页给模板两颗按钮（并进 / 替换）和一个「同时也套到普通模式」的勾选', () => {
  const html = read('src/renderer/settings.html');
  const js = read('src/renderer/settings.js');
  assert.ok(/id="offline-private-template-also-normal"/.test(html), '要有 alsoNormal 勾选框');
  assert.ok(/替换名单/.test(html) && /替换名单/.test(js), '要有「替换名单」按钮与说明');
  assert.ok(/offlineCachePrivateTemplateApply\(\{ key: template\.key, mode, alsoNormal \}\)/.test(js), '调用要带上 mode 与 alsoNormal');
  assert.ok(/await runApply\('merge'\)/.test(js) && /await runApply\('replace'\)/.test(js), '两颗按钮要分别走合并与替换');
  assert.ok(/被换掉：/.test(js), '替换后要列出被换掉的站点');
});

const failed = checks.filter((item) => !item.ok);
const total = checks.length;
console.log('');
console.log(`离线页面缓存：${total} 项检查，${total - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  ✘ ${item.name}｜${item.error}`);
  process.exitCode = 1;
}
