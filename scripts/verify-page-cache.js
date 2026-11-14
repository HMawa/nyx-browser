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

check('35. 数得清「解不开的」有几条：能解、解不开、抛异常三种都要算对', () => {
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

check('36. 只清解不开的那些，能解的留着（不给「换过账户」的人一刀切）', () => {
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

check('37. 解不开时既说清原因，也给出「一键清掉」的出口', () => {
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

/* ------------------------------------------------------------------ */
const failed = checks.filter((item) => !item.ok);
const total = checks.length;
console.log('');
console.log(`离线页面缓存：${total} 项检查，${total - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  ✘ ${item.name}｜${item.error}`);
  process.exitCode = 1;
}
