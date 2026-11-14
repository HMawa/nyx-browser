/**
 * 页面摘要（清单 F）的纯逻辑回归。
 *
 * 这里完全不启动 Electron：页面摘要的正确性全在 `src/core/page-digest.js`
 * ——切句、关键词、抽句顺序、上限、网络摘要、以及"默认关着必须给原因"。
 *
 * 最重要的一条是最后那组静态守卫：**这个模块里不许出现网络请求**。
 * 清单 F 要求纯抽取式（产品红线：不做内置生成式功能），一旦有人图省事
 * 在这里接个大模型接口，产品红线就破了，必须让回归当场红。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  DIGEST_LIMITS,
  buildDigestText,
  buildExtractScript,
  classifyBlocked,
  digestDisabledPayload,
  keywords,
  splitSentences,
  summarize,
  summarizeNetwork,
} = require('../src/core/page-digest');

const ROOT = path.join(__dirname, '..');
const checks = [];

async function check(label, fn) {
  try {
    await fn();
    checks.push({ ok: true, label });
    console.log(`✔ ${label}`);
  } catch (err) {
    checks.push({ ok: false, label, error: err && err.message ? err.message : String(err) });
    console.log(`✘ ${label}｜${err && err.message ? err.message : err}`);
  }
}

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const SAMPLE_PAGE = {
  ok: true,
  url: 'https://example.com/report',
  title: '季度报告',
  readyState: 'complete',
  headings: ['一、概览', '二、风险'],
  text: [
    '本季度营收同比增长百分之十二，主要来自企业客户的续费。',
    '页面上还写着：这段说明和业务无关，用来占位。',
    '风险部分是供应链延迟，已经影响到两个交付节点。',
    '另外还有一行很短的文字。',
  ].join('\n'),
  lines: 4,
  lineCount: 4,
  textLength: 120,
};

async function main() {
  await check('1. 切句能处理中英文混排的句末标点', () => {
    const list = splitSentences('第一句话。第二句话！第三句？English sentence. 最后一句；');
    assert.ok(list.length >= 5, `应至少切出 5 句，实际 ${list.length}：${JSON.stringify(list)}`);
    assert.ok(list.some((s) => s.includes('English sentence')), '英文句子没被切出来');
  });

  await check('2. 关键词过滤停用词，且按出现次数排序', () => {
    const list = keywords('供应链延迟影响交付。供应链延迟要提前通知。延迟的问题需要跟踪。', 5).map((item) => item.word);
    assert.ok(list.length >= 1, '没有抽到关键词');
    assert.ok(list[0] === '供应链' || list[0] === '延迟', `第一个关键词应是正文实词，实际 ${list[0]}`);
    for (const stop of ['的', '了', '和', '是', '需要', '问题']) {
      assert.ok(!list.includes(stop), `停用词 ${stop} 不该进关键词`);
    }
  });

  await check('3. 摘要抽出的句子顺序与原文一致（不按分数重排）', () => {
    const result = summarize(SAMPLE_PAGE);
    assert.strictEqual(result.ok, true);
    assert.ok(result.bullets.length >= 2, `至少抽 2 句，实际 ${result.bullets.length}`);
    const positions = result.bullets.map((sentence) => SAMPLE_PAGE.text.indexOf(sentence));
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i] > positions[i - 1], `第 ${i} 句在原文里的位置没有递增：${JSON.stringify(result.bullets)}`);
    }
  });

  await check('4. 太短的句子不会进摘要', () => {
    const result = summarize({ ...SAMPLE_PAGE, text: '好。\n还行。\n这句话足够长了，可以被当作候选句子来处理。' });
    assert.ok(result.bullets.length >= 1);
    for (const sentence of result.bullets) {
      assert.ok(sentence.length >= DIGEST_LIMITS.minSentenceLen, `过短的句子混进摘要：${sentence}`);
    }
  });

  await check('5. 摘要句数与字数都有上限', () => {
    const many = Array.from({ length: 60 }, (_, i) => `这是第 ${i} 句足够长的测试正文，用来验证上限是否生效。`).join('\n');
    const result = summarize({ ...SAMPLE_PAGE, text: many });
    assert.ok(result.bullets.length <= DIGEST_LIMITS.maxSentences, `句数超上限：${result.bullets.length}`);
    assert.ok(result.chars <= DIGEST_LIMITS.maxChars, `字数超上限：${result.chars}`);
    assert.strictEqual(result.truncated, many.length > DIGEST_LIMITS.maxChars, 'truncated 必须与正文是否超上限一致');
  });

  await check('6. 页面读不出来时给中文原因，而不是空摘要', () => {
    const result = summarize({ ok: false, error: '读不到页面' });
    assert.strictEqual(result.ok, false);
    assert.ok(/读/.test(result.error), `原因应该是中文且说明读不到：${result.error}`);
  });

  await check('7. 正文为空时明确报空，不给假摘要', () => {
    const result = summarize({ ...SAMPLE_PAGE, text: '', lines: 0, lineCount: 0 });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error && result.error.length > 0, '空正文必须带原因');
  });

  await check('8. 网络摘要统计请求数、失败数与字节', () => {
    const records = [
      { host: 'a.com', url: 'https://a.com/api/x', type: 'xhr', status: 200, size: 100, failed: false, finished: true },
      { host: 'a.com', url: 'https://a.com/api/x?p=2', type: 'xhr', status: 500, size: 20, failed: true, finished: true },
      { host: 'a.com', url: 'https://a.com/logo.png', type: 'image', status: 200, size: 5000, failed: false, finished: true },
      { host: 'b.com', url: 'https://b.com/lib.js', type: 'script', status: 0, size: 0, failed: false, finished: false },
    ];
    const result = summarizeNetwork(records);
    assert.strictEqual(result.total, 4);
    assert.strictEqual(result.failed, 1, `失败数应为 1，实际 ${result.failed}`);
    assert.ok(result.pending >= 1, '未完成的请求要单独计数');
    assert.ok(result.bytes >= 5120, `字节数应累计，实际 ${result.bytes}`);
  });

  await check('9. 只有 xhr / fetch 算"接口"，静态资源不算', () => {
    const result = summarizeNetwork([
      { host: 'a.com', url: 'https://a.com/api/x', type: 'xhr', status: 200, finished: true },
      { host: 'a.com', url: 'https://a.com/logo.png', type: 'image', status: 200, finished: true },
      { host: 'a.com', url: 'https://a.com/style.css', type: 'stylesheet', status: 200, finished: true },
    ]);
    const keys = result.apis.map((api) => api.key);
    assert.ok(keys.includes('a.com/api/x'), `接口列表应含 xhr：${JSON.stringify(keys)}`);
    assert.ok(!keys.some((key) => key.includes('logo.png')), '图片不该被当成接口');
    assert.ok(!keys.some((key) => key.includes('style.css')), '样式文件不该被当成接口');
  });

  await check('10. 有失败请求时给出"页面成功≠接口成功"的警告', () => {
    const result = summarizeNetwork([
      { host: 'a.com', url: 'https://a.com/api/x', type: 'xhr', status: 500, failed: true, finished: true },
    ]);
    assert.ok(result.warning && result.warning.includes('失败'), `应给出失败警告：${result.warning}`);
    assert.ok(result.warning.includes('不代表接口成功'), '警告要说明"页面显示成功不代表接口成功"');
  });

  await check('11. 有请求没结束时提醒结论可能不完整', () => {
    const result = summarizeNetwork([
      { host: 'a.com', url: 'https://a.com/api/x', type: 'xhr', status: 200, failed: false, finished: false },
    ]);
    assert.ok(result.pending >= 1);
    assert.ok(result.warning && result.warning.includes('没结束'), `应提醒还没结束：${result.warning}`);
  });

  await check('12. 没有网络记录时也不炸，给 0 与空列表', () => {
    const result = summarizeNetwork([]);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.failed, 0);
    assert.deepStrictEqual(result.hosts, []);
    assert.deepStrictEqual(result.apis, []);
  });

  await check('13. 复制用的纯文本包含标题、地址、摘要与网络结论', () => {
    const page = summarize(SAMPLE_PAGE);
    const network = summarizeNetwork([
      { host: 'a.com', url: 'https://a.com/api/x', type: 'xhr', status: 500, failed: true, finished: true },
    ]);
    const text = buildDigestText({ page, network });
    assert.ok(text.includes('季度报告'), '缺少标题');
    assert.ok(text.includes('example.com/report'), '缺少地址');
    assert.ok(text.includes(page.bullets[0]), '缺少摘要句子');
    assert.ok(/失败/.test(text), '缺少网络失败结论');
    assert.ok(text.includes('抽取'), '应说明这是抽取而非生成');
  });

  await check('14. 默认关着时返回明确原因（不是静默空结果）', () => {
    const payload = digestDisabledPayload();
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.code, 'DIGEST_DISABLED');
    assert.ok(payload.error.includes('默认'), `原因要说明默认关闭：${payload.error}`);
    assert.ok(payload.error.includes('设置'), '要告诉用户去哪儿打开');
  });

  await check('15. 采集脚本是 String.raw 拼的，且不含未转义的换行正则', () => {
    const script = buildExtractScript({});
    assert.ok(script.includes('String.raw') || script.includes('\\n'), '脚本里应有转义后的换行处理');
    // 用真正的正则字面量语法检查：如果 /^\s*$/ 的 \n 被写成真换行，脚本执行会语法错误（B 已踩过这个坑）
    assert.ok(script.includes('split('), '应包含切行逻辑');
    assert.ok(script.includes('headings'), '应包含小标题采集');
  });

  await check('16. 页面摘要模块里不许有任何网络请求（纯抽取式，产品红线）', () => {
    const source = readFile('src/core/page-digest.js');
    assert.ok(!/\bfetch\s*\(/.test(source), 'page-digest.js 里出现了 fetch(...)：这已经不是纯抽取式了');
    assert.ok(!/require\(['"]node:https?['"]\)/.test(source), 'page-digest.js 里引了 http(s) 模块');
    assert.ok(!/require\(['"]https?['"]\)/.test(source), 'page-digest.js 里引了 http(s) 模块');
    assert.ok(!/api\.openai|anthropic|dashscope|deepseek/i.test(source), 'page-digest.js 里出现了生成式服务名');
  });

  await check('17. 接线守卫：主进程有四个 IPC、开关默认关、preload 与界面都接了', () => {
    const main = readFile('src/main.js');
    assert.ok(main.includes("ipcMain.handle('nyx:digest:get'"), '缺少 nyx:digest:get');
    assert.ok(main.includes("ipcMain.handle('nyx:digest:set'"), '缺少 nyx:digest:set');
    assert.ok(main.includes("ipcMain.handle('nyx:digest:run'"), '缺少 nyx:digest:run');
    assert.ok(main.includes("ipcMain.handle('nyx:digest:copy'"), '缺少 nyx:digest:copy');
    assert.ok(main.includes('digestDisabledPayload('), '未开启时必须返回明确原因');
    assert.ok(main.includes('summarizeNetwork('), '必须把抓包摘要一起给');
    assert.ok(/registerAgentModeIpc\(\);\s*\n\s*registerDigestIpc\(\);/.test(main), 'registerIpc 里没调用 registerDigestIpc');

    const store = readFile('src/core/ui-store.js');
    assert.ok(/digestEnabled:\s*false/.test(store), '页面摘要默认必须是关闭的');

    const preload = readFile('src/preload.js');
    for (const method of ['digestGet', 'digestSet', 'digestRun', 'digestCopy']) {
      assert.ok(preload.includes(method), `preload 缺少 ${method}`);
    }

    const html = readFile('src/renderer/index.html');
    assert.ok(html.includes('id="digest-panel"'), '外壳缺少摘要侧栏');
    assert.ok(html.includes('id="btn-digest"'), '外壳缺少摘要入口按钮');
    assert.ok(html.includes('id="digest-enabled"'), '侧栏缺少开关');

    const renderer = readFile('src/renderer/renderer.js');
    for (const fn of ['renderDigest', 'openDigestPanel', 'runDigest', 'copyDigest']) {
      assert.ok(renderer.includes(fn), `renderer 缺少 ${fn}`);
    }
  });

  await check('18. 被拦下的请求与真失败分开计数：拦下不等于出错（候选④）', () => {
    const records = [
      { host: 'a.example', url: 'https://a.example/api/ok', type: 'xhr', finished: true, size: 100 },
      { host: 'a.example', url: 'https://a.example/api/bad', type: 'xhr', finished: true, failed: true, size: 0 },
      { host: 'ads.tracker', url: 'https://ads.tracker/ad.js', type: 'script', finished: true, blockedReason: 'ERR_BLOCKED_BY_CLIENT', size: 0 },
      { host: 'ads.tracker', url: 'https://ads.tracker/p.gif', type: 'image', finished: true, blockedReason: 'ERR_BLOCKED_BY_CLIENT', size: 0 },
    ];
    const network = summarizeNetwork(records, {});
    assert.equal(network.total, 4);
    assert.equal(network.failed, 1, '被拦下的那两条不能算进失败');
    assert.equal(network.blocked, 2, '被拦下的要单独计数');
    assert.equal(network.blockedHosts.length, 1, '按域名聚合');
    assert.equal(network.blockedHosts[0].host, 'ads.tracker');
    assert.equal(network.blockedHosts[0].count, 2);
    assert.ok(network.blockedHosts[0].reason.includes('浏览器拦下'), network.blockedHosts[0].reason);
    assert.ok(network.warning.includes('1 个请求失败'), '有真失败时警告要先说失败');
    const blockedOnly = summarizeNetwork(
      [
        { host: 'a.example', url: 'https://a.example/ok', type: 'xhr', finished: true, size: 10 },
        { host: 'ads.tracker', url: 'https://ads.tracker/ad.js', type: 'script', finished: true, blockedReason: 'ERR_BLOCKED_BY_CLIENT' },
      ],
      {},
    );
    assert.equal(blockedOnly.failed, 0);
    assert.equal(blockedOnly.blocked, 1);
    assert.ok(/拦下/.test(blockedOnly.warning), blockedOnly.warning);
    assert.ok(!/个请求失败/.test(blockedOnly.warning), '只有拦截时不许把拦截说成失败');
  });

  await check('19. 分类器认得常见拦截原因，未知原因也如实转述', () => {
    assert.ok(classifyBlocked({ blockedReason: 'ERR_BLOCKED_BY_CLIENT' }).includes('浏览器拦下'));
    assert.ok(classifyBlocked({ blockedReason: 'ERR_BLOCKED_BY_RESPONSE' }).includes('响应被拦下'));
    assert.ok(classifyBlocked({ blockedReason: 'ERR_BLOCKED_BY_CSP' }).includes('安全策略'));
    assert.ok(classifyBlocked({ blockedReason: 'ABORTED' }).includes('页面自己取消'));
    assert.ok(classifyBlocked({ blockedReason: 'WEIRD_REASON' }).includes('WEIRD_REASON'), '不认识的也要原样说出来');
    assert.equal(classifyBlocked({}), '', '没有拦截原因就是空串，不许编');

    const text = buildDigestText({
      page: { title: 't', url: 'https://a.example/', bullets: [], keywords: [], headings: [] },
      network: summarizeNetwork(
        [
          { host: 'a.example', url: 'https://a.example/api', type: 'xhr', finished: true, size: 10 },
          { host: 'ads.tracker', url: 'https://ads.tracker/ad.js', type: 'script', finished: true, blockedReason: 'ERR_BLOCKED_BY_CLIENT' },
        ],
        {},
      ),
    });
    assert.ok(/被拦下 1 个/.test(text), text);
    assert.ok(text.includes('被拦下的请求'), '复制文本要给一节，说清拦了什么');
  });

  await check('20. 侧栏与抓包 brief 都要真的带出拦截信息（不然算出来的数没人看见）', () => {
    const renderer = readFile('src/renderer/renderer.js');
    assert.ok(renderer.includes('被拦下'), '侧栏要把拦截说出来');
    assert.ok(renderer.includes('blockedHosts'), '侧栏要逐条列出被拦下的域名');
    const toolbox = readFile('src/core/toolbox.js');
    assert.ok(toolbox.includes('blockedReason'), '抓包 brief 必须带 blockedReason，否则摘要拿不到原因');
  });

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n页面摘要回归：${checks.length - failed.length} / ${checks.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) console.log(` - ${item.label}｜${item.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('页面摘要回归脚本自身出错：', err);
  process.exit(1);
});
