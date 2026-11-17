'use strict';

/**
 * 页面读取（清单 B）回归：纯 Node，不启动 Electron。
 *
 * 覆盖三件事：
 *   1. 稳定 id 的算法本身——同样是「结构路径 + 角色 + 名字」，同签名必同 id，
 *      名字或结构一变就换 id（这样"跨读失效"才是可验证的，而不是靠运气）；
 *   2. 采集结果的整理——裁剪、规范化、计数、错误文案；
 *   3. 静态守卫——执行器/通道/接口/MCP 都真的把 readPage 接上了，
 *      并且 click / type 认 elementId（不再是只能靠选择器与坐标猜）。
 *
 * 页面内的真实 DOM 采集由 scripts/verify-ui-polish.js 的端到端用例负责。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const reader = require(path.join(ROOT, 'src', 'core', 'page-reader.js'));
const actionsModule = require(path.join(ROOT, 'src', 'core', 'actions.js'));
const dispatch = require(path.join(ROOT, 'src', 'core', 'agent-dispatch.js'));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`[Nyx] ✔ ${passed}. ${name}${detail ? `　｜${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`[Nyx] ✘ ${name}${detail ? `　｜${detail}` : ''}`);
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function main() {
  console.log('[Nyx] 页面读取回归（清单 B：结构化页面 + 稳定 id）');

  /* ---------- 1. 稳定 id 算法 ---------- */
  const limitsOk = reader.READ_LIMITS.maxText >= 1000 && reader.READ_LIMITS.maxElements >= 50 && reader.READ_LIMITS.maxNameLen >= 40;
  check('读取上限是明确的数字（正文有上限、元素有上限、名字有上限）', limitsOk, JSON.stringify(reader.READ_LIMITS));

  const sig = 'div>div:1>button|button|提交订单';
  const idA = reader.hashId(sig);
  const idB = reader.hashId(sig);
  check(
    '同一签名算两次得到同一个 id（这就是"两次读一致"的基础）',
    idA === idB && /^[0-9a-z]{7}$/.test(idA),
    `id=${idA}`,
  );

  const idOther = reader.hashId('div>div:2>button|button|提交订单');
  const idRenamed = reader.hashId('div>div:1>button|button|支付订单');
  check(
    '位置或名字变了就是另一个 id（跨读失效能被发现，不会静默点到别处）',
    idA !== idOther && idA !== idRenamed,
    `原=${idA} 换位置=${idOther} 改文案=${idRenamed}`,
  );

  const longName = reader.normalizeName('  很长的   按钮\n名字   ', 10);
  check('名字压缩空白并按上限截断', longName === '很长的 按钮 名字'.slice(0, 10), JSON.stringify(longName));

  /* ---------- 2. 采集脚本内容 ---------- */
  const readScript = reader.buildReadPageScript({ maxText: 1200, maxElements: 40 });
  const scriptHas = {
    fnv: readScript.includes('0x811c9dc5'),
    idOf: readScript.includes('idOf'),
    readyState: readScript.includes('document.readyState'),
    viewport: readScript.includes('window.innerWidth') && readScript.includes('window.innerHeight'),
    rects: readScript.includes('getBoundingClientRect'),
    maxText: readScript.includes('MAX_TEXT = 1200'),
    maxElements: readScript.includes('MAX_ELEMENTS = 40'),
    selector: readScript.includes('a[href]') && readScript.includes('contenteditable') && readScript.includes('tabindex'),
    noTemplateHole: !readScript.includes('${'),
  };
  check('采集脚本带齐：id 算法 / 加载状态 / 视口 / 元素矩形 / 两个上限 / 选择器', Object.values(scriptHas).every(Boolean), JSON.stringify(scriptHas));

  const actionScript = reader.buildElementActionScript('eabc123', 'click');
  check(
    '按 id 点击的脚本：先按同一算法找元素，找不到就报 ELEMENT_NOT_FOUND',
    actionScript.includes('idOf') && actionScript.includes('ELEMENT_NOT_FOUND') && actionScript.includes('pointerdown') && actionScript.includes('MouseEvent'),
    `len=${actionScript.length}`,
  );

  const inspectScript = reader.buildElementActionScript('eabc123', 'inspect');
  // 「只看命中」模式必须先早退：脚本里虽然带着点击代码，但运行时在派发之前就 return。
  const earlyReturn = inspectScript.indexOf("!== 'click') return");
  const firstClickEvent = inspectScript.indexOf("dispatchEvent(new MouseEvent('click'");
  check(
    '「只看命中」模式在派发点击之前就早退（不会被顺手点一下）',
    earlyReturn > 0 && firstClickEvent > earlyReturn,
    JSON.stringify({ earlyReturn, firstClickEvent }),
  );

  const typeScript = reader.buildTypeByIdScript('eabc123', 'hi', true, false);
  check(
    '按 id 输入的脚本：禁用要单独报、值要用原型 setter（兼容 React 受控）',
    typeScript.includes('ELEMENT_DISABLED') && typeScript.includes('Object.getOwnPropertyDescriptor') && typeScript.includes('ELEMENT_NOT_FOUND'),
    '',
  );

  /* ---------- 3. 采集结果整理 ---------- */
  const rawPage = {
    ok: true,
    url: 'https://example.com/order?token=abc',
    title: '订单确认',
    readyState: 'complete',
    loading: false,
    viewport: { width: 1280, height: 800 },
    text: '订单确认\n请核对收货信息',
    textLength: 20,
    truncated: false,
    counts: { interactive: 2, visible: 2, candidates: 3 },
    elements: [
      { id: 'eaaa111', role: 'button', name: '  取消  ', tag: 'button', value: '', disabled: false, inViewport: true },
      { id: 'ebbb222', role: 'textbox', name: '备注', tag: 'input', inputType: 'text', value: '顺丰', disabled: true, inViewport: false },
    ],
  };
  const page = reader.summarizeReadPage(rawPage);
  check(
    '整理结果保留 url/title/加载状态/视口，并把名字规范化',
    page.ok === true && page.url === rawPage.url && page.title === '订单确认' && page.viewport.width === 1280 && page.elements[0].name === '取消',
    JSON.stringify({ title: page.title, viewport: page.viewport, name: page.elements[0].name }),
  );
  check(
    '计数分得清：可交互 / 可见 / 候选 / 在视口内 / 禁用',
    page.counts.interactive === 2 && page.counts.candidates === 3 && page.counts.inViewport === 1 && page.counts.disabled === 1,
    JSON.stringify(page.counts),
  );
  check('元素顺序就是文档顺序，id 原样透出（不改写、不重排）', page.elements[0].id === 'eaaa111' && page.elements[1].id === 'ebbb222', '');
  check('给 agent 的下一步提示写明「用 id 去点，不要靠坐标猜」', /elementId/.test(page.hint) && /ELEMENT_NOT_FOUND/.test(page.hint), page.hint);

  const twiceA = reader.summarizeReadPage(rawPage).elements.map((el) => el.id).join(',');
  const twiceB = reader.summarizeReadPage(rawPage).elements.map((el) => el.id).join(',');
  check('同一份页面读两次，元素 id 序列完全一致', twiceA === twiceB && twiceA === 'eaaa111,ebbb222', twiceA);

  // 安全审计 P1-1：密码框的值不许回显
  const secretPage = reader.summarizeReadPage({
    ok: true,
    url: 'https://bank.test/login',
    title: '登录',
    text: '请登录',
    viewport: { width: 800, height: 600 },
    elements: [
      { id: 'eu', role: 'textbox', name: '账号', tag: 'input', inputType: 'text', value: 'alice', hasValue: true },
      { id: 'ep', role: 'textbox', name: '密码', tag: 'input', inputType: 'password', value: 'P@ssw0rd!', hasValue: true },
    ],
  });
  const secretField = secretPage.elements.find((el) => el.inputType === 'password');
  check(
    '密码框的值一律抹成空串，只给「有没有填」这个事实（不在结果里抄密码）',
    secretField && secretField.value === '' && secretField.hasValue === true && secretField.masked === true,
    JSON.stringify(secretField),
  );
  check(
    '密码框的值在整份读取结果里彻底不出现（连 JSON 里都不许有）',
    !JSON.stringify(secretPage).includes('P@ssw0rd'),
    JSON.stringify(secretPage).slice(0, 120),
  );


  const capped = reader.summarizeReadPage(
    Object.assign({}, rawPage, {
      elements: new Array(50).fill(0).map((_, i) => ({ id: `e${i}`, role: 'button', name: `B${i}`, tag: 'button', inViewport: true })),
    }),
    { maxElements: 5 },
  );
  check('元素数量按上限裁剪（默认参数可被调用方收紧）', capped.elements.length === 5 && capped.counts.interactive === 5, `len=${capped.elements.length}`);

  const longText = reader.summarizeReadPage(Object.assign({}, rawPage, { text: 'x'.repeat(900) }), { maxText: 100 });
  check('正文按上限截断，并标记 truncated（不假装完整）', longText.text.length === 100 && longText.textTruncated === true, `len=${longText.text.length}`);

  const badPage = reader.summarizeReadPage(null);
  const failedPage = reader.summarizeReadPage({ ok: false, error: '页面还没加载完' });
  check(
    '读不到内容时给中文原因，而不是空对象',
    badPage.ok === false && /没有返回可读内容/.test(badPage.error) && failedPage.ok === false && failedPage.error === '页面还没加载完',
    JSON.stringify({ badPage, failedPage }),
  );

  const missing = reader.elementNotFound('eabc123');
  check(
    '元素不存在：带错误码，并明确要求「重新读取页面」而不是换坐标重试',
    missing.ok === false && missing.code === 'ELEMENT_NOT_FOUND' && /eabc123/.test(missing.error) && /重新读取页面/.test(missing.error) && /坐标/.test(missing.error),
    missing.error.slice(0, 60),
  );

  /* ---------- 4. 接线与静态守卫 ---------- */
  const execSrc = readSrc(path.join('src', 'core', 'actions.js'));
  const apiSrc = readSrc(path.join('src', 'api', 'http-api.js'));
  const mcpSrc = readSrc(path.join('src', 'mcp', 'server.js'));

  check(
    '执行器与通道的动作名单一致（多一个少一个都会让某些动作没被记进审计）',
    JSON.stringify(actionsModule.ACTION_TYPES) === JSON.stringify(dispatch.DISPATCH_TYPES),
    `执行器 ${actionsModule.ACTION_TYPES.length} / 通道 ${dispatch.DISPATCH_TYPES.length}`,
  );

  const wiring = {
    execReadPage: /case 'readPage'/.test(execSrc) && execSrc.includes('buildReadPageScript'),
    execClickById: /case 'click'[\s\S]{0,400}params\.elementId/.test(execSrc),
    execTypeById: /case 'type'[\s\S]{0,400}params\.elementId/.test(execSrc),
    execNotFound: execSrc.includes('elementNotFound'),
    apiSchema: apiSrc.includes('readPage:') && apiSrc.includes("elementId: 'string?'"),
    mcpReadPage: mcpSrc.includes("'nyx_read_page'"),
    mcpClickId: /nyx_click[\s\S]{0,600}elementId/.test(mcpSrc),
    mcpScreenshotDemoted: /nyx_screenshot[\s\S]{0,400}nyx_read_page/.test(mcpSrc),
  };
  check('执行器/接口/MCP 全部接上 readPage 与 elementId，截图降级为人工辅助', Object.values(wiring).every(Boolean), JSON.stringify(wiring));

  // N5：maxElements / maxText 之前是被默认值静默封顶的（要 500 也只给 300，字节数一模一样）
  const many = Array.from({ length: 600 }, (_, i) => ({
    id: 'e' + i,
    role: 'button',
    name: '按钮 ' + i,
    tag: 'button',
    inputType: '',
    value: '',
    inViewport: true,
  }));
  const bigRaw = { ok: true, url: 'https://example.com/', title: 'T', elements: many, text: 'x'.repeat(12000) };
  const defaultCut = reader.summarizeReadPage(bigRaw, {});
  const asked = reader.summarizeReadPage(bigRaw, { maxElements: 500, maxText: 10000 });
  check(
    '要更多就给更多：maxElements=500 不再被默认 300 静默封顶，maxText 同理（N5）',
    defaultCut.elements.length === 300 && asked.elements.length === 500 && asked.text.length === 10000,
    JSON.stringify({ 默认给: defaultCut.elements.length, 要500给: asked.elements.length, 默认字数: defaultCut.text.length, 要1万给: asked.text.length }),
  );

  // F-01：越界不是"夹一下"，而是明确拒绝。
  // 负数会走进 slice(0,-1) 悄悄少给一条；0 会悄悄给空正文——都返回 200 却少内容。
  const badLimits = [
    { maxElements: -1, key: 'maxElements', label: '负数' },
    { maxElements: 0, key: 'maxElements', label: '0' },
    { maxElements: 900, key: 'maxElements', label: '超上限' },
    { maxText: -5, key: 'maxText', label: '负数' },
    { maxText: 0, key: 'maxText', label: '0' },
    { maxText: 50000, key: 'maxText', label: '超上限' },
    { maxElements: 1.5, key: 'maxElements', label: '小数' },
    { maxText: 'abc', key: 'maxText', label: '非数字' },
  ];
  for (const one of badLimits) {
    const verdict = reader.validateLimits(one);
    check(
      `上限校验：${one.key}=${one.label} 直接拒绝并说清范围（F-01）`,
      verdict.ok === false && verdict.code === 'BAD_VALUE' && verdict.error.includes(one.key),
      JSON.stringify(verdict),
    );
  }
  const goodLimits = reader.validateLimits({ maxElements: 50, maxText: 1000 });
  check(
    '上限校验：合法值原样通过，没传的键不补默认值（F-01）',
    goodLimits.ok === true && goodLimits.limits.maxElements === 50 && goodLimits.limits.maxText === 1000,
    JSON.stringify(goodLimits),
  );
  const emptyLimits = reader.validateLimits(undefined);
  check(
    '上限校验：完全不传就是空对象，交给默认值（F-01）',
    emptyLimits.ok === true && Object.keys(emptyLimits.limits).length === 0,
    JSON.stringify(emptyLimits),
  );

  // F-02：截图前要先把窗口恢复出来，失败要给出"窗口需可见"的原因与错误码
  const actionsSource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'actions.js'), 'utf8');
  check(
    '截图前先把窗口恢复出来（最小化/被遮挡时 capturePage 拿不到画面）（F-02）',
    /getOwnerBrowserWindow/.test(actionsSource) && /owner\.restore\(\)/.test(actionsSource) && /owner\.moveTop\(\)/.test(actionsSource),
    'actions.js 里应同时出现 getOwnerBrowserWindow / restore() / moveTop()',
  );
  check(
    '截图失败时给出窗口可见性原因与错误码（F-02）',
    /SCREENSHOT_NO_SURFACE/.test(actionsSource) && /截图需要窗口可见/.test(actionsSource),
    'actions.js 里应有 SCREENSHOT_NO_SURFACE 与「截图需要窗口可见」',
  );

  console.log('');
  if (failures.length === 0) {
    console.log(`[Nyx] 页面读取回归通过：${passed}/${passed} 项全绿`);
    return 0;
  }
  console.log(`[Nyx] 页面读取回归失败：${failures.length} 项未通过`);
  failures.forEach((name) => console.log(`         ✘ ${name}`));
  return 1;
}

process.exitCode = main();
