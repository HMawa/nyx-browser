'use strict';

/**
 * 页面媒体收集器回归（用户需求「页面上所有的图面/标志全能保存到本地」）。
 *
 * 断言重点不是"能列出几张图"，而是四件容易被糊过去的事：
 *   1. 采集脚本只读 DOM：不发请求、不写存储、不碰输入框内容；
 *   2. 地址补全与去重是真的（相对地址、`srcset`、同一地址多尺寸）；
 *   3. 丢弃必须有理由（不许静默少几条）；
 *   4. 文件名能落到 Windows 上（保留字符、保留名、超长）。
 */

const collector = require('../src/core/media-collector');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(`${name}：${err && err.message ? err.message : err}`);
    console.log(`  ✘ ${name}：${err && err.message ? err.message : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

const BASE = 'https://example.com/blog/post.html';

check('采集脚本只读页面：没有发请求、没有写存储、没有表单读写', () => {
  const script = collector.buildCollectorScript();
  assert(/document\.images/.test(script), '要数 <img>');
  assert(/querySelectorAll\('svg'\)/.test(script), '要数内联 svg');
  assert(/getComputedStyle/.test(script), '要看 CSS 背景');
  assert(/link\[rel~="icon"\]/.test(script), '要看 favicon');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'document.cookie', 'indexedDB']) {
    assert(script.indexOf(banned) < 0, `采集脚本里不许出现 ${banned}`);
  }
  for (const banned of ['.value', 'innerHTML =', 'appendChild', 'removeChild']) {
    assert(script.indexOf(banned) < 0, `采集脚本里不许出现 ${banned}（不读输入框、不改 DOM）`);
  }
  console.log(`    {"scriptChars":${script.length}}`);
});

check('相对地址按页面地址补全，认不出协议的一律不进清单', () => {
  const res = collector.normalizeCandidates(
    { items: [{ url: '/a/b.png' }, { url: '../up/logo.gif' }, { url: 'javascript:void(0)' }, { url: 'mailto:x@y.z' }] },
    BASE,
  );
  const urls = res.items.map((i) => i.url);
  assert(urls.includes('https://example.com/a/b.png'), `相对根路径没补全：${urls.join(',')}`);
  assert(urls.includes('https://example.com/up/logo.gif'), `相对上级路径没补全：${urls.join(',')}`);
  assert(!urls.some((u) => u.startsWith('javascript:')), 'javascript: 不许进清单');
  assert(!urls.some((u) => u.startsWith('mailto:')), 'mailto: 不许进清单');
  assert(res.dropped.count === 2, `该丢 2 条（javascript/mailto），实得 ${res.dropped.count}`);
  console.log(`    {"items":${res.items.length},"dropped":${res.dropped.count}}`);
});

check('同一地址出现多次只留面积最大的那份，并说明丢了什么', () => {
  const res = collector.normalizeCandidates(
    {
      items: [
        { url: '/same.png', width: 64, height: 64 },
        { url: '/same.png', width: 512, height: 512 },
        { url: '/other.png', width: 10, height: 10 },
      ],
    },
    BASE,
  );
  assert(res.items.length === 2, `去重后应 2 条，实得 ${res.items.length}`);
  const same = res.items.find((i) => i.url.endsWith('/same.png'));
  assert(same.width === 512 && same.height === 512, '要留面积最大的那份');
  assert(res.dropped.reasons['同一地址重复'] === 1, '重复项要被计数');
  console.log(`    {"keep":${res.items.length},"dup":1}`);
});

check('内联 data: 只收矢量图，位图 data: 直接丢并给理由', () => {
  const svg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const res = collector.normalizeCandidates(
    { items: [{ url: svg, kind: 'svg' }, { url: 'data:image/png;base64,iVBORw0KGgo=' }, { url: 'blob:https://example.com/9d1f-2' }] },
    BASE,
  );
  const kinds = res.items.map((i) => i.kind);
  assert(res.items.length === 2, `应留 svg + blob 两条，实得 ${res.items.length}`);
  assert(kinds.includes('svg'), '矢量图要留下');
  assert(!res.items.some((i) => i.url.startsWith('data:image/png')), '位图 data: 不许留（IPC 载荷会被撑爆）');
  assert(res.items.some((i) => i.ephemeral === true), 'blob: 要标成临时地址');
  assert(res.dropped.reasons['内联数据不是矢量图'] === 1, '位图 data: 要计数并给理由');
  console.log('    {"svg":1,"blob":1,"droppedData":1}');
});

check('文件名能落在 Windows 上：保留字符、保留名、超长都有处理', () => {
  assert(!/[\\/:*?"<>|]/.test(collector.sanitizeFileStem('a/b\\c:d*e?f"g<h>i|j')), '保留字符必须换掉');
  assert(collector.sanitizeFileStem('   ') === 'nyx-media', '空名字要有兜底');
  assert(collector.sanitizeFileStem('con') !== 'con', 'CON 是保留名，要改名');
  assert(collector.sanitizeFileStem('lpt9').toLowerCase() !== 'lpt9', 'LPT9 也要改名');
  const long = collector.sanitizeFileStem('x'.repeat(400));
  assert(long.length <= collector.MAX_STEM, `主干要截断，实得 ${long.length}`);
  assert(collector.sanitizeFileStem('  ..hidden..  ') === 'hidden', `首尾点要去掉，实得 ${collector.sanitizeFileStem('  ..hidden..  ')}`);
  console.log(`    {"maxStem":${collector.MAX_STEM}}`);
});

check('扩展名认得出就用真的，认不出按种类兜底（不给 .bin）', () => {
  assert(collector.extFromUrl('https://ex.com/a.JPEG?v=1', 'image') === '.jpeg', '大写扩展名要小写化');
  assert(collector.extFromUrl('https://ex.com/a.png?x=.php', 'image') === '.png', '只看路径，别被查询串骗');
  assert(collector.extFromUrl('https://ex.com/photo?id=3', 'image') === '.jpg', '认不出时按图片兜底');
  assert(collector.extFromUrl('https://ex.com/clip', 'video') === '.mp4', '视频兜底 .mp4');
  assert(collector.extFromUrl('https://ex.com/v', 'svg') === '.svg', '矢量图兜底 .svg');
  console.log('    {"ext":"jpg/mp4/svg"}');
});

check('种类判定有兜底：采集脚本没给 kind 也能判对', () => {
  assert(collector.guessKind('https://ex.com/favicon.ico') === 'icon', '.ico 是图标');
  assert(collector.guessKind('https://ex.com/a.svg') === 'svg', '.svg 是矢量图');
  assert(collector.guessKind('https://ex.com/v.m3u8') === 'video', 'm3u8 归视频');
  assert(collector.guessKind('https://ex.com/a.png') === 'image', '普通图');
  const res = collector.normalizeCandidates({ items: [{ url: 'https://ex.com/favicon.ico' }] }, BASE);
  assert(res.items[0].kind === 'icon', 'kind 缺失时要用判定结果');
  console.log('    {"kinds":"icon/svg/video/image"}');
});

check('清单按种类与面积排序，名字序号跟着重排', () => {
  const res = collector.normalizeCandidates(
    {
      items: [
        { url: '/small.png', width: 20, height: 20 },
        { url: '/big.png', width: 800, height: 600 },
        { url: '/favicon.ico', kind: 'icon' },
      ],
    },
    BASE,
  );
  assert(res.items[0].kind === 'image', '图片排在图标前面');
  assert(res.items[0].url.endsWith('/big.png'), '同类里面积大的在前');
  const names = res.items.map((i) => i.name);
  for (let i = 0; i < names.length; i += 1) {
    assert(names[i].indexOf('-' + String(i + 1).padStart(2, '0') + '.') > 0, `第 ${i + 1} 条名字序号不对：${names[i]}`);
  }
  console.log(`    {"order":"image>icon","names":${names.length}}`);
});

check('超过上限要截断，并把"被截掉多少"如实报出来', () => {
  const items = [];
  for (let i = 0; i < collector.MAX_CANDIDATES + 25; i += 1) items.push({ url: `/p/${i}.png`, width: i + 1, height: 1 });
  const res = collector.normalizeCandidates({ items }, BASE);
  assert(res.items.length === collector.MAX_CANDIDATES, `应截到 ${collector.MAX_CANDIDATES}，实得 ${res.items.length}`);
  assert(res.truncated === 25, `应报被截掉 25 条，实得 ${res.truncated}`);
  assert(res.total === collector.MAX_CANDIDATES + 25, '总数要是原始条数');
  console.log(`    {"max":${collector.MAX_CANDIDATES},"truncated":${res.truncated}}`);
});

check('筛选：按种类、按关键字（文件名/地址/替代文字都能搜）', () => {
  const res = collector.normalizeCandidates(
    {
      items: [
        { url: '/hero.png', alt: '首页大图' },
        { url: '/logo.svg', kind: 'svg', alt: 'Brand' },
        { url: '/favicon.ico', kind: 'icon' },
      ],
    },
    BASE,
  );
  assert(collector.filterCandidates(res.items, { kinds: ['svg'] }).length === 1, '按种类筛');
  assert(collector.filterCandidates(res.items, { keyword: 'brand' }).length === 1, '关键字要不分大小写');
  assert(collector.filterCandidates(res.items, { keyword: '首页' }).length === 1, 'alt 也要能搜');
  assert(collector.filterCandidates(res.items, { keyword: 'logo.svg' }).length === 1, '地址要能搜');
  assert(collector.filterCandidates(res.items, {}).length === 3, '空条件返回全部');
  console.log('    {"filters":"kinds/keyword/alt"}');
});

check('空结果与人话汇总：没有就说没有，不说"0 个"就完事', () => {
  const empty = collector.normalizeCandidates({ items: [] }, BASE);
  assert(empty.items.length === 0, '空清单');
  assert(collector.describeCandidates(empty.items) === '没有找到可保存的图片或图标', collector.describeCandidates(empty.items));
  const res = collector.normalizeCandidates({ items: [{ url: '/a.png' }, { url: '/b.png' }, { url: '/favicon.ico', kind: 'icon' }] }, BASE);
  assert(collector.describeCandidates(res.items) === '共 3 个：图片 2 / 站点图标 1', collector.describeCandidates(res.items));
  console.log('    {"summary":true}');
});

check('下载结果汇总说清成功与失败，不吃掉原因', () => {
  assert(collector.summarizeDownload({ saved: 3, failed: [] }) === '已保存 3 个', '全成功');
  const mixed = collector.summarizeDownload({ saved: 2, failed: [{ reason: '连接被重置' }] });
  assert(mixed.indexOf('已保存 2 个') === 0, mixed);
  assert(mixed.indexOf('连接被重置') > 0, '失败原因要露出来');
  assert(collector.summarizeDownload({ saved: 0, failed: [] }) === '没有选中任何内容', '空选择');
  console.log('    {"summarize":true}');
});

check('坏输入不炸：null / 数组 / 缺字段都要能兜住', () => {
  assert(collector.normalizeCandidates(null, BASE).items.length === 0, 'null 要兜住');
  assert(collector.normalizeCandidates([{ url: '/a.png' }], BASE).items.length === 1, '直接给数组要认');
  const res = collector.normalizeCandidates({ items: [{ url: '' }, null, { url: '/ok.png' }] }, BASE);
  assert(res.items.length === 1, `只有 1 条可用，实得 ${res.items.length}`);
  assert(res.dropped.count === 2, `两条坏输入要计数，实得 ${res.dropped.count}`);
  console.log('    {"tolerant":true}');
});

check('接线完整：主进程三条通道 + preload 三个接口 + 界面三块元素', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(path.resolve(__dirname, '..'), rel), 'utf8');
  const main = read('src/main.js');
  const preload = read('src/preload.js');
  const html = read('src/renderer/index.html');
  const ui = read('src/renderer/toolbox-ui.js');

  for (const channel of ['nyx:tb:media-scan', 'nyx:tb:media-save', 'nyx:tb:media-thumb']) {
    assert(main.includes(`'${channel}'`), `主进程缺通道 ${channel}`);
  }
  for (const api of ['mediaScan', 'mediaSave', 'mediaThumb']) {
    assert(new RegExp(`${api}: \\(`).test(preload), `preload 缺接口 ${api}`);
  }
  for (const id of ['media-scan', 'media-save', 'media-list', 'media-preview']) {
    assert(html.includes(`id="${id}"`), `外壳缺元素 #${id}`);
  }
  for (const fn of ['function scanMedia(', 'function saveMedia(', 'function renderMediaList(', 'function showMediaPreview(', 'function wireMedia(']) {
    assert(ui.includes(fn), `界面缺 ${fn}`);
  }
  assert(/wireMedia\(\);/.test(ui), 'wireMedia 必须在启动时挂上');
  console.log('    {"channels":3,"apis":3,"elements":4}');
});

check('保存这条路的三条硬约束都在代码里：选目录、隐私模式拒绝、逐条报结果', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'src/main.js'), 'utf8');
  const start = main.indexOf('function downloadSelectedMedia(');
  assert(start > 0, '找不到 downloadSelectedMedia');
  const body = main.slice(start, start + 4000);

  assert(/showSaveDialogSync\(/.test(body), '必须弹目录选择框，不许偷偷丢进下载目录');
  assert(/openDirectory/.test(body), '必须是选目录，不是选文件');
  assert(/sessions\.getMode\(\) === 'private'/.test(body), '隐私模式必须拒绝写盘');
  assert(/failed\.push\(/.test(body), '每条失败都要记原因，不许静默跳过');
  assert(/uniqueSavePath\(dir, name\)/.test(body), '重名要自增，别覆盖用户已有的文件');
  assert(!/pendingDownloadPaths\.push\(savePath\)[\s\S]{0,40}wc\.downloadURL/.test(''), '占位');
  const pushAt = body.indexOf('pendingDownloadPaths.push(savePath)');
  const dlAt = body.indexOf('wc.downloadURL(url)');
  assert(pushAt > 0 && dlAt > pushAt, '落点必须先登记再触发下载（下载中心的配对靠这个顺序）');
  console.log('    {"dir":true,"private":true,"reasons":true}');
});

check('预览走主进程取图：隐私模式不预览、有大小与超时上限、只收图片', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'src/main.js'), 'utf8');
  const start = main.indexOf('async function loadMediaThumb(');
  assert(start > 0, '找不到 loadMediaThumb');
  const body = main.slice(start, start + 3000);

  assert(/sessions\.getMode\(\) === 'private'/.test(body), '隐私模式必须拒绝预览（net.fetch 走默认链路，会绕开代理）');
  assert(/MEDIA_THUMB_MAX_BYTES/.test(body), '要有大小上限');
  assert(/MEDIA_THUMB_TIMEOUT_MS/.test(body), '要有超时');
  assert(/\^image\\\//.test(body), '只收 image/*');
  assert(/AbortController/.test(body), '要有可中断的请求');
  const expr = (main.match(/const MEDIA_THUMB_MAX_BYTES = ([^;]+);/) || [])[1] || '';
  const maxBytes = expr ? Number(new Function(`return (${expr});`)()) : 0;
  assert(maxBytes > 0 && maxBytes <= 4 * 1024 * 1024, `上限要合理，实得 ${expr || '空'}`);
  console.log(`    {"maxBytes":${maxBytes}}`);
});

if (failures.length) {
  console.log(`\n[媒体收集] 未通过：${failures.length} 项`);
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log(`\n[媒体收集] 通过：${passed} 项`);
