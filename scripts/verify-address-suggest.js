'use strict';

/**
 * 地址栏建议 · 端到端验证
 *
 * 覆盖能力（v1.3.0 基础 → v1.3.1 增强 → v1.4.0 加权/搜索行/星标联动）：
 *   基础：命中条目、浮层出现与渲染、键盘高亮联动、回车选中；
 *   增强：书签并入建议、来源徽标、命中片段 <mark> 高亮、输入法组合期不查询；
 *   v1.4.0：访问频次加权（多次访问的旧页面能压过只访问过一次的新页面）、
 *           「搜索「输入」」直通行（末尾、点击即搜索）、工具栏星标与建议的联动。
 *
 * 做法（只用 Node 内置能力，零第三方依赖）：
 *   1) 用隔离用户数据目录（NYX_USER_DATA）启动真实 Electron 应用，
 *      预置一份"设计好访问次数"的历史 + 一份书签树；
 *   2) 通过 CDP 连到主窗口外壳，调用 preload 暴露的 window.nyx.*，
 *      并在地址栏元素上派发真实的 input / composition 事件；
 *   3) 在浮层窗口（addr-suggest.html）这个独立 page target 里检查渲染结果。
 *
 * 用法：node scripts/verify-address-suggest.js
 * 退出码：0 = 全部通过；1 = 有断言失败（逐条打印中文说明）。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
// 调试端口交给系统分配：本机 Windows 保留了 9486–9585 等动态段，随机挑端口命中保留段会让
// Chromium 起不了 devtools（bind 0x271D），表现为「主窗口未就绪」的假失败。
let PORT = 0;
const workDir = path.join(os.tmpdir(), `nyx-as-verify-${Date.now()}`);
const userData = path.join(workDir, 'userdata');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 预置数据 ---------------- */

/**
 * 数据刻意设计成能验证"频次加权"：
 *   - pricing 访问 5 次但最近一次在 2 天前 → 频次高、时间旧；
 *   - docs 只访问 1 次但就在 1 分钟前 → 时间新、频次低；
 *   加权后 pricing 应排在 docs 前面（只按时间排则相反）。
 *   - 书签 example.org 无历史，靠"收藏"权重排第一。
 */
function seedUserData() {
  const now = Date.now();
  const DAY = 86400000;
  const history = [
    { id: 1, url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始', visitedAt: now - 60_000 },
    { id: 2, url: 'https://example.com/pricing', title: '示例站 · 价格', visitedAt: now - 2 * DAY },
    { id: 3, url: 'https://example.com/pricing', title: '示例站 · 价格', visitedAt: now - 2 * DAY - 3_600_000 },
    { id: 4, url: 'https://example.com/pricing', title: '示例站 · 价格', visitedAt: now - 2 * DAY - 7_200_000 },
    { id: 5, url: 'https://example.com/pricing', title: '示例站 · 价格', visitedAt: now - 2 * DAY - 10_800_000 },
    { id: 6, url: 'https://example.com/pricing', title: '示例站 · 价格', visitedAt: now - 2 * DAY - 14_400_000 },
    { id: 7, url: 'https://other.test/page/example-notes', title: '别处的示例笔记', visitedAt: now - 180_000 },
    { id: 8, url: 'https://unrelated.test/foo', title: '不相关的页面', visitedAt: now - 240_000 },
    { id: 9, url: 'nyx://settings', title: '内部页不应出现', visitedAt: now - 300_000 },
    { id: 10, url: 'file:///C:/tmp/local.html', title: '本地文件不应出现', visitedAt: now - 360_000 },
  ];

  const bookmarks = {
    version: 2,
    root: {
      id: 0,
      title: '书签栏',
      children: [
        { id: 11, title: '收藏的示例站首页', url: 'https://example.org/bookmarked-page' },
        { id: 12, title: '书签文件夹', children: [{ id: 13, title: '与查询无关的收藏', url: 'https://nothing.test/x' }] },
      ],
    },
  };

  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify({ version: 1, items: history }, null, 2), 'utf8');
  fs.writeFileSync(path.join(userData, 'bookmarks.json'), JSON.stringify(bookmarks, null, 2), 'utf8');
}

/* ---------------- 极简 CDP 客户端（Node 24 内置 WebSocket） ---------------- */

class Cdp {
  constructor(wsUrl) {
    this.ws = null;
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (err) => reject(new Error(`CDP 连接失败：${err.message || err.type}`)));
      ws.addEventListener('message', (event) => {
        let msg = null;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
          return;
        }
        if (!msg || !msg.id) return;
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`${msg.error.message}（${msg.error.code}）`));
        else waiter.resolve(msg.result);
      });
    });
    return this;
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 15000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result && result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception ? String(detail.exception.description || detail.text) : detail.text);
    }
    return result && result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/* ---------------- 目标发现 ---------------- */

async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    return Array.isArray(list) ? list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl) : [];
  } catch {
    return [];
  }
}

async function waitTarget(match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await listTargets()).filter(match);
    if (found.length) return found[0];
    await sleep(250);
  }
  return null;
}

/* ---------------- 断言记录 ---------------- */

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

/**
 * 现连一次目标窗口、求值、断开。
 * 为什么每次现连：浮层窗口会被关掉重建（回车选中 / 无命中 / 选中文件夹都会关），
 * 之前缓存的 WebSocket 会指向已销毁的 target，再求值只会拿到失败。
 * @param {string} part 目标 URL 片段（index.html / addr-suggest.html / bm-folder.html）
 * @param {string} expression 在页面里求值的表达式
 */
async function evalInTarget(part, expression) {
  const target = await waitTarget((t) => t.url.includes(part), 8000);
  if (!target) return null;
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
  try {
    await cdp.send('Runtime.enable', {});
    return await cdp.eval(expression);
  } catch {
    return null;
  } finally {
    cdp.close();
  }
}

/** 建议浮层的快捷求值 */
function readSuggest(expression) {
  return evalInTarget('addr-suggest.html', expression);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`找不到 Electron 可执行文件：${ELECTRON}`);
    process.exitCode = 1;
    return;
  }

  seedUserData();

  PORT = await pickFreePort();

  // 清空剪贴板：v1.10.0 起"剪贴板里的网址"会成为一条建议，
  // 若上一轮残留了 URL，会把本脚本的条目数断言全部带偏。
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value ""'], {
      stdio: 'ignore',
      timeout: 8000,
    });
  } catch {
    /* 清不掉就继续：后面的断言允许差一条剪贴板行（但通常能清掉） */
  }

  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');
  console.log(`[验证] 隔离用户数据：${userData}`);
  console.log(`[验证] 调试端口：${PORT}`);

  // 本机环境可能带 ELECTRON_RUN_AS_NODE=1，不清掉 Electron 会退化成纯 Node、main.js 启动即崩
  const childEnv = { ...process.env, NYX_USER_DATA: userData };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });

  try {
    /* 1. 主窗口外壳就绪 */
    const shellTarget = await waitTarget((t) => t.url.endsWith('/index.html'), 40000);
    check('主窗口外壳页面出现', !!shellTarget, shellTarget && shellTarget.url);
    if (!shellTarget) throw new Error('主窗口未就绪，无法继续验证');

    const shell = await new Cdp(shellTarget.webSocketDebuggerUrl).connect();
    await shell.send('Runtime.enable', {});

    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      ready = await shell
        .eval("!!(window.nyx && typeof window.nyx.addressSuggestQuery === 'function' && typeof window.nyx.bookmarksToggle === 'function')")
        .catch(() => false);
      if (!ready) await sleep(250);
    }
    check('preload 已暴露建议与星标 API', ready);
    if (!ready) throw new Error('preload 未就绪，无法继续验证');

    /* 2. 查询 + 键盘导航 */
    const flow = await shell.eval(`(async () => {
      const q = await window.nyx.addressSuggestQuery({ text: 'example', x: 160, y: 320, width: 460 });
      const d1 = await window.nyx.addressSuggestNav('down');
      const d2 = await window.nyx.addressSuggestNav('down');
      return { q, d1, d2 };
    })()`);
    // 3 条命中被同站聚合折叠成 2 行（example.org 1 条 + example.com 2 条折叠成 1 行）+ 其他站 1 行 + 搜索行 1 行 = 4
    check('同站聚合后共 4 行（2 条命中折叠）', flow && flow.q && flow.q.count === 4, JSON.stringify(flow && flow.q));
    check(
      '下键逐条移动高亮',
      flow && flow.d1 && flow.d1.index === 0 && flow.d2 && flow.d2.index === 1,
      `${JSON.stringify(flow && flow.d1)} / ${JSON.stringify(flow && flow.d2)}`,
    );

    /* 3. 浮层渲染 */
    const suggestTarget = await waitTarget((t) => t.url.includes('addr-suggest.html'), 15000);
    check('建议浮层窗口出现', !!suggestTarget, suggestTarget && suggestTarget.url);

    let suggest = null;
    if (suggestTarget) {
      suggest = await new Cdp(suggestTarget.webSocketDebuggerUrl).connect();
      await suggest.send('Runtime.enable', {});

      let rows = 0;
      for (let i = 0; i < 30 && rows === 0; i += 1) {
        rows = await suggest.eval("document.querySelectorAll('.as-item').length").catch(() => 0);
        if (!rows) await sleep(200);
      }
      check('浮层渲染出全部条目', rows === flow.q.count, `渲染 ${rows} 条 / 命中 ${flow.q.count} 条`);

      const dom = await suggest.eval(`(() => {
        const rows = Array.from(document.querySelectorAll('.as-item'));
        return {
          titles: rows.map((n) => (n.querySelector('.as-title') || {}).textContent || ''),
          hrefs: rows.map((n) => n.title),
          firstHasBookmarkBadge: !!(rows[0] && rows[0].querySelector('.as-src')),
          bookmarkBadges: document.querySelectorAll('.as-src:not(.as-src-search)').length,
          searchBadges: document.querySelectorAll('.as-src-search').length,
          lastIsSearch: rows.length ? rows[rows.length - 1].classList.contains('as-search') : false,
          visitBadges: document.querySelectorAll('.as-visits').length,
          groupBadge: (() => {
            const more = document.querySelector('.as-more');
            return more ? more.textContent : '';
          })(),
          markCount: document.querySelectorAll('.as-hit').length,
          onIndex: rows.findIndex((n) => n.classList.contains('is-on')),
        };
      })()`);

      check('书签条目排第一（收藏权重最高）', dom.firstHasBookmarkBadge && dom.hrefs[0] === 'https://example.org/bookmarked-page', dom.hrefs[0]);
      check(
        '同站聚合：example.com 只露最高分那条（pricing，访问 5 次）',
        dom.hrefs[1] === 'https://example.com/pricing' && dom.groupBadge === '+1',
        `${dom.hrefs[1]}｜折叠徽标 ${dom.groupBadge}`,
      );
      check('访问次数徽标已展示', dom.visitBadges >= 1, `徽标数 ${dom.visitBadges}`);
      check('搜索直通行排在最后且带「搜索」徽标', dom.lastIsSearch && dom.searchBadges === 1, `searchBadges=${dom.searchBadges}`);
      check('命中片段被 <mark> 高亮', dom.markCount >= 2, `mark 数 ${dom.markCount}`);
      check('浮层高亮与主进程状态一致', dom.onIndex === 1, `浮层高亮下标 ${dom.onIndex}`);
      check(
        '内部页与本地文件未进建议',
        Array.isArray(dom.hrefs) && !dom.hrefs.some((u) => /^(nyx:|file:)/.test(String(u))),
        JSON.stringify(dom.hrefs),
      );

      /* 4. 展开同站分组（v1.6.0）：点「+1」后两条 example.com 都露出来 */
      const expanded = await shell.eval(`window.nyx.addressSuggestExpand({ host: 'example.com' })`);
      check('展开同站分组返回更多条目', expanded && expanded.ok && expanded.count === 5, JSON.stringify(expanded));
      await sleep(400);
      const expandedDom = await readSuggest(`(() => {
        const rows = Array.from(document.querySelectorAll('.as-item'));
        return {
          rows: rows.length,
          hrefs: rows.map((n) => n.title),
          more: document.querySelectorAll('.as-more').length,
        };
      })()`);
      check(
        '展开后两条 example.com 命中都在、折叠徽标消失',
        !!expandedDom &&
          expandedDom.rows === 5 &&
          expandedDom.hrefs.includes('https://example.com/pricing') &&
          expandedDom.hrefs.includes('https://example.com/docs/quick-start') &&
          expandedDom.more === 0,
        expandedDom && JSON.stringify(expandedDom.hrefs),
      );
      check(
        '展开后仍按分数排序（pricing 在 docs 前）',
        !!expandedDom &&
          expandedDom.hrefs.indexOf('https://example.com/pricing') <
            expandedDom.hrefs.indexOf('https://example.com/docs/quick-start'),
        expandedDom && `pricing@${expandedDom.hrefs.indexOf('https://example.com/pricing')} docs@${expandedDom.hrefs.indexOf('https://example.com/docs/quick-start')}`,
      );

      /* 5. 回车选中：返回 URL 且浮层收起
            展开动作本身会重置高亮（等于一次新查询），所以先下键选第一条再回车 */
      await shell.eval("window.nyx.addressSuggestNav('down')");
      const picked = await shell.eval("window.nyx.addressSuggestNav('enter')");
      check(
        '回车取到高亮条目 URL',
        picked && picked.handled && typeof picked.url === 'string' && picked.url.startsWith('https://'),
        JSON.stringify(picked),
      );
      await sleep(800);
      const stillThere = (await listTargets()).some((t) => t.url.includes('addr-suggest.html'));
      check('选中后浮层自动收起', !stillThere);
    }

    /* 5. 搜索直通行：文本输入必然带一条"搜索"，网址输入则不补 */
    const searchFlow = await shell.eval(`(async () => {
      const text = await window.nyx.addressSuggestQuery({ text: 'nyx 隐私浏览器 好用吗', x: 160, y: 320, width: 460 });
      const url = await window.nyx.addressSuggestQuery({ text: 'nowhere.test/never-visited-page', x: 160, y: 320, width: 460 });
      const missText = await window.nyx.addressSuggestQuery({ text: 'zzzz-绝不命中的关键词', x: 160, y: 320, width: 460 });
      return { text, url, missText };
    })()`);
    check(
      '纯文本输入只剩一条搜索行',
      searchFlow && searchFlow.text && searchFlow.text.count === 1,
      JSON.stringify(searchFlow && searchFlow.text),
    );
    check(
      '网址形态输入不补搜索行（无命中即 0 条）',
      searchFlow && searchFlow.url && searchFlow.url.count === 0,
      JSON.stringify(searchFlow && searchFlow.url),
    );
    check(
      '无命中的纯文本仍给搜索行（不弹历史条目）',
      searchFlow && searchFlow.missText && searchFlow.missText.count === 1,
      JSON.stringify(searchFlow && searchFlow.missText),
    );
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(300);

    /* 6. 工具栏星标：状态查询 + 收藏/取消 + 与建议的联动 */
    const star = await shell.eval(`(async () => {
      const btn = document.getElementById('btn-bookmark');
      const before = { exists: !!btn, disabled: btn ? btn.disabled : null };
      const added = await window.nyx.bookmarksToggle({ url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始' });
      const hasAfterAdd = await window.nyx.bookmarksHas({ url: 'https://example.com/docs/quick-start' });
      const q = await window.nyx.addressSuggestQuery({ text: 'example', x: 160, y: 320, width: 460 });
      return { before, added, hasAfterAdd, q };
    })()`);
    check('星标按钮存在且当前页（about:blank）不可收藏', star.before.exists && star.before.disabled === true, JSON.stringify(star.before));
    check('星标可收藏页面（bookmarksToggle）', star.added && star.added.ok && star.added.bookmarked === true, JSON.stringify(star.added));
    check('收藏后 has 查询为真', star.hasAfterAdd && star.hasAfterAdd.bookmarked === true, JSON.stringify(star.hasAfterAdd));

    if (suggestTarget) {
      await sleep(500);
      const badgeAfterAdd = await readSuggest("document.querySelectorAll('.as-src:not(.as-src-search)').length");
      // 原来 1 个书签 + 新收藏的 docs = 2 个
      check('收藏后建议里书签徽标增加（星标与建议联动）', badgeAfterAdd === 2, `徽标数 ${badgeAfterAdd}`);
    }

    const unstar = await shell.eval(`(async () => {
      const removed = await window.nyx.bookmarksToggle({ url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始' });
      const hasAfterRemove = await window.nyx.bookmarksHas({ url: 'https://example.com/docs/quick-start' });
      const q = await window.nyx.addressSuggestQuery({ text: 'example', x: 160, y: 320, width: 460 });
      return { removed, hasAfterRemove, q };
    })()`);
    check('再次点击可取消收藏', unstar.removed && unstar.removed.ok && unstar.removed.bookmarked === false, JSON.stringify(unstar.removed));
    check('取消后 has 查询为假', unstar.hasAfterRemove && unstar.hasAfterRemove.bookmarked === false, JSON.stringify(unstar.hasAfterRemove));

    if (suggestTarget) {
      await sleep(500);
      const badgeAfterRemove = await readSuggest("document.querySelectorAll('.as-src:not(.as-src-search)').length");
      check('取消收藏后徽标回落', badgeAfterRemove === 1, `徽标数 ${badgeAfterRemove}`);
    }

    /* 7. v1.5.0：站点图标 / Home-End / Ctrl+Enter / 长按反馈 / 收藏到文件夹 */
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(250);

    const nav2 = await shell.eval(`(async () => {
      await window.nyx.addressSuggestQuery({ text: 'example', x: 160, y: 320, width: 460 });
      return { ok: true };
    })()`);
    await sleep(400);

    const iconDom = await readSuggest(`(() => {
      const rows = document.querySelectorAll('.as-item');
      return {
        rows: rows.length,
        icons: document.querySelectorAll('.as-icon').length,
        imgIcons: document.querySelectorAll('.as-icon-img').length,
        monoIcons: document.querySelectorAll('.as-mono').length,
        searchMono: (() => {
          const row = document.querySelector('.as-item.as-search');
          const mono = row && row.querySelector('.as-mono');
          return mono ? mono.textContent : '';
        })(),
      };
    })()`);
    check(
      '每条建议都带站点图标（离线时为首字母色块）',
      !!iconDom && iconDom.rows > 0 && iconDom.icons === iconDom.rows,
      iconDom && `行 ${iconDom.rows} / 图标 ${iconDom.icons}（真图 ${iconDom.imgIcons}，色块 ${iconDom.monoIcons}）`,
    );
    check('搜索行的图标固定为「搜」', !!iconDom && iconDom.searchMono === '搜', iconDom && iconDom.searchMono);

    const nav3 = await shell.eval(`(async () => {
      const first = await window.nyx.addressSuggestNav('first');
      const last = await window.nyx.addressSuggestNav('last');
      const enter = await window.nyx.addressSuggestNav('enter', { newTab: true });
      return { first, last, enter };
    })()`);
    check(
      'Home 跳到第一条（first）',
      nav3 && nav3.first && nav3.first.handled && nav3.first.index === 0,
      JSON.stringify(nav3 && nav3.first),
    );
    check(
      'End 跳到最后一条（last，含搜索行）',
      nav3 && nav3.last && nav3.last.handled && nav3.last.index === 3,
      JSON.stringify(nav3 && nav3.last),
    );
    check(
      'Ctrl+Enter 返回新标签意图',
      nav3 && nav3.enter && nav3.enter.handled && nav3.enter.newTab === true && String(nav3.enter.url).startsWith('https://'),
      JSON.stringify(nav3 && nav3.enter),
    );

    const press = await shell.eval(`(async () => {
      const btn = document.getElementById('btn-bookmark');
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const during = btn.classList.contains('is-pressed');
      btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 80));
      return { during, after: btn.classList.contains('is-pressed') };
    })()`);
    check('长按期间星标有按压反馈、松开即复原', press && press.during === true && press.after === false, JSON.stringify(press));

    const folderMenu = await shell.eval(
      `window.nyx.bookmarksFolderMenu({ x: 320, y: 320, url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始' })`,
    );
    check('「收藏到文件夹」浮层可打开', folderMenu && folderMenu.ok === true, JSON.stringify(folderMenu));

    const bfDom = await evalInTarget(
      'bm-folder.html',
      `(async () => {
        // 浮层列表由主进程 onData 推送后才渲染，bookmarksFolderMenu() 返回 ok 时
        // DOM 可能还是空的（2026-11-11 复跑出现过 picks=0 的偶发失败）→ 轮询等渲染。
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 40; i++) {
          if (document.querySelectorAll('.bf-item-pick').length >= 2 && document.querySelector('.bf-item-new')) break;
          await wait(50);
        }
        return {
          head: (document.querySelector('.bf-head') || {}).textContent,
          picks: document.querySelectorAll('.bf-item-pick').length,
          firstName: (document.querySelector('.bf-name') || {}).textContent,
          hasNewRow: !!document.querySelector('.bf-item-new'),
        };
      })()`,
    );
    check(
      '浮层列出「书签栏」/ 文件夹 / 新建项',
      !!bfDom && bfDom.head === '收藏到…' && bfDom.picks >= 2 && bfDom.firstName === '书签栏' && bfDom.hasNewRow,
      JSON.stringify(bfDom),
    );

    // 注意：pick 会让主进程立刻关掉浮层窗口，await 它的返回值时窗口已经销毁、
    // 响应永远收不到（CDP 会超时）。所以用逗号表达式「发起调用但不 await」，结果改从外壳侧查。
    const bfFilter = await evalInTarget(
      'bm-folder.html',
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const input = document.getElementById('bf-search');
        if (!input) return { missing: true };
        input.value = '文件夹';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        const filteredPicks = document.querySelectorAll('.bf-item-pick').length;
        const filteredNames = Array.from(document.querySelectorAll('.bf-name')).map((n) => n.textContent);
        input.value = 'zzz-绝不存在';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        const emptyText = (document.querySelector('.bf-empty') || {}).textContent || '';
        const emptyPicks = document.querySelectorAll('.bf-item-pick').length;
        return { filteredPicks, filteredNames, emptyText, emptyPicks };
      })()`,
    );
    check(
      '文件夹搜索框可过滤（v1.6.0）',
      !!bfFilter && bfFilter.filteredPicks === 2 && (bfFilter.filteredNames || []).includes('书签文件夹'),
      JSON.stringify(bfFilter),
    );
    check(
      '无匹配时给出空状态并保留「新建」入口',
      !!bfFilter && bfFilter.emptyPicks === 1 && String(bfFilter.emptyText).includes('没有匹配'),
      bfFilter && `空状态「${bfFilter.emptyText}」/ 可点行 ${bfFilter.emptyPicks}`,
    );

    const iconRes = await shell.eval(`window.nyx.siteIcon({ host: 'example.com' })`);
    check(
      '共享站点图标 IPC 可用（未缓存返回空串）',
      iconRes && iconRes.ok === true && typeof iconRes.icon === 'string',
      JSON.stringify(iconRes),
    );

    // 注意：pick 会让主进程立刻关掉浮层窗口，await 它的返回值时窗口已经销毁、
    // 响应永远收不到（CDP 会超时）。所以用逗号表达式「发起调用但不 await」，结果改从外壳侧查。
    const pickResult = await evalInTarget('bm-folder.html', '(window.bmFolder.pick(0), true)');
    check('浮层选中「书签栏」（发起收藏）', pickResult === true, String(pickResult));

    await sleep(600);
    const hasAfterFolder = await shell.eval(`window.nyx.bookmarksHas({ url: 'https://example.com/docs/quick-start' })`);
    check('收藏后 has 查询为真', hasAfterFolder && hasAfterFolder.bookmarked === true, JSON.stringify(hasAfterFolder));

    // 收尾：把这个测试书签取消掉，保持隔离用户数据干净（反正马上要删临时目录）
    await shell.eval(`window.nyx.bookmarksToggle({ url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始' })`);

    /* 7.5 v1.7.0：新建文件夹可自定义命名 + 「已在标签打开」提示 */
    const namedFolder = await shell.eval(`(async () => {
      const res = await window.nyx.bookmarksFolderMenu({
        x: 340,
        y: 340,
        url: 'https://example.com/docs/quick-start',
        title: '示例站 · 快速开始',
      });
      return res;
    })()`);
    check('再次打开收藏浮层', namedFolder && namedFolder.ok === true, JSON.stringify(namedFolder));
    await sleep(600);

    const typing = await evalInTarget(
      'bm-folder.html',
      `(async () => {
        const input = document.getElementById('bf-new-input');
        return { hasInput: !!input, pickType: typeof (window.bmFolder && window.bmFolder.pick) };
      })()`,
    );
    check(
      '浮层里有命名输入框且 IPC 可用',
      !!typing && typing.hasInput === true && typing.pickType === 'function',
      JSON.stringify(typing),
    );

    // 真正的新建走主进程通道（与浮层内 Enter 是同一条 IPC）：验证"自定义命名 + 收藏进去"
    const namedPick = await shell.eval(
      `window.nyx.bookmarksFolderPick({ folderId: 'new', title: '深度技术资料' })`,
    );
    check('新建文件夹通道返回成功', namedPick && namedPick.ok === true, JSON.stringify(namedPick));

    await sleep(600);

    await sleep(800);
    const folderState = await shell.eval(`(async () => {
      const res = await window.nyx.bookmarksList();
      const root = (res.tree && res.tree.root && res.tree.root.children) || [];
      const folder = root.find((n) => n.title === '深度技术资料');
      return {
        found: !!folder,
        childCount: folder && folder.children ? folder.children.length : -1,
        hasUrl: !!(folder && (folder.children || []).some((c) => c.url === 'https://example.com/docs/quick-start')),
        rootTitles: root.map((n) => (n.url ? '[书签]' + n.title : '[文件夹]' + n.title)),
      };
    })()`);
    check(
      '按自定义名称新建了文件夹并收藏进去',
      !!folderState && folderState.found && folderState.hasUrl,
      JSON.stringify(folderState),
    );

    // v1.8.0：后台已开的页面 → 徽标可点，点下去切到那个标签
    const tabFlow = await shell.eval(`(async () => {
      const first = await window.nyx.createTab('https://example.com/pricing');
      await new Promise((r) => setTimeout(r, 600));
      const second = await window.nyx.createTab('https://other.test/page/example-notes');
      await new Promise((r) => setTimeout(r, 700));
      const q = await window.nyx.addressSuggestQuery({
        text: 'example',
        expandedHost: 'example.com',
        x: 160,
        y: 320,
        width: 460,
      });
      return { first, second, q };
    })()`);
    await sleep(500);

    const badge = await readSuggest(`(() => {
      const node = document.querySelector('.as-open-action');
      if (!node) return { clickable: false };
      const row = node.closest('.as-item');
      return { clickable: true, text: node.textContent, url: row ? row.title : '' };
    })()`);
    check(
      '后台已开页面带可点击的「已打开」徽标',
      !!badge && badge.clickable === true && badge.text === '已打开' && String(badge.url).includes('example.com/pricing'),
      JSON.stringify(badge),
    );

    await evalInTarget(
      'addr-suggest.html',
      `(document.querySelector('.as-open-action').dispatchEvent(new MouseEvent('click', { bubbles: true })), true)`,
    );
    await sleep(700);
    const activeAfterSwitch = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.active);
      return tab ? tab.url : '';
    })()`);
    check(
      '点击「已打开」切到了那个标签',
      activeAfterSwitch === 'https://example.com/pricing',
      String(activeAfterSwitch),
    );

    if (tabFlow && tabFlow.first && tabFlow.first.id != null) {
      await shell.eval(`window.nyx.closeTab(${tabFlow.first.id})`);
    }
    if (tabFlow && tabFlow.second && tabFlow.second.id != null) {
      await shell.eval(`window.nyx.closeTab(${tabFlow.second.id})`);
    }

    // v1.9.0：同一地址开了两个标签时，点徽标循环切换（第三个落在别的页面上，保证前两个不是"当前页"）
    const cycleFlow = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const a = await window.nyx.createTab('https://example.com/pricing');
      await wait(500);
      const b = await window.nyx.createTab('https://example.com/pricing');
      await wait(500);
      const c = await window.nyx.createTab('https://other.test/page/example-notes');
      // 建标签会触发状态推送 → 外壳会收起建议浮层，所以等状态稳下来再查询
      await wait(1500);
      const q = await window.nyx.addressSuggestQuery({
        text: 'example',
        expandedHost: 'example.com',
        x: 160,
        y: 320,
        width: 460,
      });
      return { a, b, c, q };
    })()`);
    await sleep(900);
    const cycleTargets = (await listTargets()).filter((t) => t.url.includes('addr-suggest.html')).length;

    const cycleBadge = await readSuggest(`(() => {
      const node = document.querySelector('.as-open-action');
      return node ? { text: node.textContent, title: node.title } : null;
    })()`);
    check(
      '同址双标签显示 ×2 且可循环切换',
      !!cycleBadge && cycleBadge.text === '×2' && String(cycleBadge.title).includes('循环'),
      `${JSON.stringify(cycleBadge)}｜查询=${JSON.stringify(cycleFlow && cycleFlow.q)}｜浮层target数=${cycleTargets}`,
    );

    const cycleOnce = await evalInTarget(
      'addr-suggest.html',
      `(document.querySelector('.as-open-action').dispatchEvent(new MouseEvent('click', { bubbles: true })), true)`,
    );
    await sleep(700);
    const firstActive = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.active);
      return tab ? tab.id : null;
    })()`);
    await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(800);
      await window.nyx.addressSuggestQuery({
        text: 'example',
        expandedHost: 'example.com',
        x: 160,
        y: 320,
        width: 460,
      });
    })()`);
    await sleep(700);
    await evalInTarget(
      'addr-suggest.html',
      `(document.querySelector('.as-open-action').dispatchEvent(new MouseEvent('click', { bubbles: true })), true)`,
    );
    await sleep(700);
    const secondActive = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.active);
      return tab ? tab.id : null;
    })()`);
    check(
      '连点两次在两个标签间轮换',
      !!cycleFlow &&
        firstActive != null &&
        secondActive != null &&
        firstActive !== secondActive &&
        [cycleFlow.a && cycleFlow.a.id, cycleFlow.b && cycleFlow.b.id].includes(firstActive) &&
        [cycleFlow.a && cycleFlow.a.id, cycleFlow.b && cycleFlow.b.id].includes(secondActive),
      `第一次=${firstActive}｜第二次=${secondActive}｜标签=${JSON.stringify([cycleFlow && cycleFlow.a && cycleFlow.a.id, cycleFlow && cycleFlow.b && cycleFlow.b.id])}`,
    );

    for (const created of [cycleFlow && cycleFlow.a, cycleFlow && cycleFlow.b, cycleFlow && cycleFlow.c]) {
      if (created && created.id != null) await shell.eval(`window.nyx.closeTab(${created.id})`);
    }

    /* 7.6 v1.8.0：收藏浮层「最近使用」+ 右键建子文件夹 */
    await shell.eval(`window.nyx.bookmarksFolderMenu({ x: 340, y: 340, url: 'https://example.com/pricing', title: '示例站 · 价格' })`);
    await sleep(700);
    const recentDom = await evalInTarget(
      'bm-folder.html',
      `(() => ({
        hasRecentHead: !!document.querySelector('.bf-head-recent'),
        recentRows: document.querySelectorAll('.bf-item-recent').length,
        firstRecent: (document.querySelector('.bf-item-recent .bf-name') || {}).textContent || '',
      }))()`,
    );
    check(
      '浮层顶部有「最近使用」分组',
      !!recentDom && recentDom.hasRecentHead && recentDom.recentRows >= 1,
      JSON.stringify(recentDom),
    );

    const subfolder = await evalInTarget(
      'bm-folder.html',
      `(async () => {
        const input = document.getElementById('bf-new-input');
        input.value = '子文件夹测试';
        const rows = Array.from(document.querySelectorAll('.bf-item-pick'));
        const target = rows.find((row) => (row.querySelector('.bf-name') || {}).textContent === '书签文件夹');
        if (!target) return { missingRow: true };
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        return { dispatched: true };
      })()`,
    );
    check('文件夹行可右键触发建子文件夹', !!subfolder && subfolder.dispatched === true, JSON.stringify(subfolder));

    await sleep(800);
    const nested = await shell.eval(`(async () => {
      const res = await window.nyx.bookmarksList();
      const root = (res.tree && res.tree.root && res.tree.root.children) || [];
      const parent = root.find((n) => n.title === '书签文件夹');
      const child = parent && (parent.children || []).find((n) => n.title === '子文件夹测试');
      return {
        parentFound: !!parent,
        childFound: !!child,
        childHasUrl: !!(child && (child.children || []).some((c) => c.url === 'https://example.com/pricing')),
      };
    })()`);
    check(
      '子文件夹建在选中的文件夹下并收藏进去',
      !!nested && nested.parentFound && nested.childFound && nested.childHasUrl,
      JSON.stringify(nested),
    );

    // v1.10.0：剪贴板里是网址时，建议里多一行「剪贴板」
    try {
      spawnSync(
        'powershell',
        ['-NoProfile', '-Command', "Set-Clipboard -Value 'https://clip.example/page'"],
        { stdio: 'ignore', timeout: 8000 },
      );
    } catch {
      /* 设剪贴板失败就跳过（不影响其它断言） */
    }
    await sleep(400);
    const clipFlow = await shell.eval(
      `window.nyx.addressSuggestQuery({ text: 'zzz-no-history-match', x: 160, y: 320, width: 460 })`,
    );
    await sleep(400);
    const clipDom = await readSuggest(`(() => {
      const badge = document.querySelector('.as-src-clip');
      const row = badge && badge.closest('.as-item');
      return {
        badge: badge ? badge.textContent : '',
        url: row ? row.title : '',
        rows: document.querySelectorAll('.as-item').length,
      };
    })()`);
    check(
      '剪贴板里的网址会成为一条建议',
      !!clipDom && clipDom.badge === '剪贴板' && clipDom.url === 'https://clip.example/page' && clipDom.rows === 2,
      JSON.stringify(clipDom),
    );
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(200);
    // 测完立刻清空剪贴板，避免污染后面的条目数断言
    try {
      spawnSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value ""'], {
        stdio: 'ignore',
        timeout: 8000,
      });
    } catch {
      /* 忽略 */
    }

    /* 7.7 v1.11.0：置顶建议 */
    const pinFlow = await shell.eval(`(async () => {
      const pin = await window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' });
      await new Promise((r) => setTimeout(r, 300));
      const q = await window.nyx.addressSuggestQuery({ text: 'example', x: 160, y: 320, width: 460 });
      return { pin, q };
    })()`);
    check('置顶建议返回成功', pinFlow && pinFlow.pin && pinFlow.pin.ok === true && pinFlow.pin.pinned === true, JSON.stringify(pinFlow && pinFlow.pin));

    await sleep(500);
    const pinnedDom = await readSuggest(`(() => {
      const rows = Array.from(document.querySelectorAll('.as-item'));
      const first = rows[0] || null;
      return {
        firstUrl: first ? first.title : '',
        firstHasPin: !!(first && first.querySelector('.as-src-pin')),
        firstLabel: first && first.querySelector('.as-src-pin') ? first.querySelector('.as-src-pin').textContent : '',
      };
    })()`);
    check(
      '置顶条目排到最前并带「置顶」徽标',
      !!pinnedDom && pinnedDom.firstUrl === 'https://other.test/page/example-notes' && pinnedDom.firstHasPin && pinnedDom.firstLabel === '置顶',
      JSON.stringify(pinnedDom),
    );

    const unpinFlow = await shell.eval(
      `window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' })`,
    );
    check('可取消置顶', unpinFlow && unpinFlow.ok === true && unpinFlow.pinned === false, JSON.stringify(unpinFlow));
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(200);

    /* 7.8 v1.12.0：置顶排序 */
    const reorderFlow = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格' });
      await window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' });
      await wait(300);
      const before = await window.nyx.addressSuggestPinned();
      const order = (before.items || []).map((item) => item.url).reverse();
      const moved = await window.nyx.addressSuggestPinnedReorder({ urls: order });
      const after = await window.nyx.addressSuggestPinned();
      return {
        beforeCount: (before.items || []).length,
        movedOk: !!(moved && moved.ok),
        order: (after.items || []).map((item) => item.url),
        expected: order,
      };
    })()`);
    check(
      '置顶顺序可重排（v1.12.0）',
      !!reorderFlow && reorderFlow.beforeCount === 2 && reorderFlow.movedOk && JSON.stringify(reorderFlow.order) === JSON.stringify(reorderFlow.expected),
      JSON.stringify(reorderFlow),
    );

    /* 7.9 v1.13.0：置顶接入工具栏浮层 */
    const folderPinned = await shell.eval(`(async () => {
      // 先清空已有置顶（pin 是 toggle 语义，重复调用会取消），再只置顶一条
      const existing = await window.nyx.addressSuggestPinned();
      for (const item of existing.items || []) {
        await window.nyx.addressSuggestPin({ url: item.url, title: item.title });
      }
      await window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格' });
      await new Promise((r) => setTimeout(r, 200));
      const res = await window.nyx.bookmarksFolderMenu({ x: 340, y: 340, url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始' });
      return res;
    })()`);
    check('工具栏浮层可打开（含置顶分组）', !!folderPinned && folderPinned.ok === true, JSON.stringify(folderPinned));
    await sleep(600);
    const pinnedInFolder = await evalInTarget(
      'bm-folder.html',
      `(() => ({
        hasHead: !!document.querySelector('.bf-head-pinned'),
        rows: document.querySelectorAll('.bf-item-pinned').length,
        names: Array.from(document.querySelectorAll('.bf-item-pinned .bf-name')).map((n) => n.textContent),
      }))()`,
    );
    check(
      '置顶建议出现在工具栏浮层顶部',
      !!pinnedInFolder &&
        pinnedInFolder.hasHead &&
        pinnedInFolder.rows >= 1 &&
        (pinnedInFolder.names || []).includes('示例站 · 价格'),
      JSON.stringify(pinnedInFolder),
    );

    const openedPinned = await evalInTarget(
      'bm-folder.html',
      `(() => {
        const row = Array.from(document.querySelectorAll('.bf-item-pinned')).find((item) =>
          (item.textContent || '').includes('示例站 · 价格'),
        );
        if (!row) return false;
        row.click();
        return true;
      })()`,
    );
    await sleep(800);
    const pinnedNav = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.active);
      return tab ? tab.url : '';
    })()`);
    check(
      '点置顶项直接打开该页面',
      openedPinned === true && String(pinnedNav).includes('example.com/pricing'),
      String(pinnedNav),
    );
    await shell.eval(`window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格' })`);

    /* 7.11 v1.16.0：置顶分组（工作 / 学习 / 其他，每组 5 条） */
    const groupMeta = await shell.eval('window.nyx.addressSuggestPinned()');
    check(
      '置顶分组定义随列表下发（v1.16.0）',
      !!groupMeta &&
        groupMeta.ok === true &&
        Array.isArray(groupMeta.groups) &&
        groupMeta.groups.length === 3 &&
        groupMeta.groups.map((g) => g.key).join(',') === 'work,study,other' &&
        groupMeta.groupMax === 5,
      JSON.stringify(groupMeta && groupMeta.groups),
    );

    const groupFlow = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = await window.nyx.addressSuggestPinned();
      // 清空现有置顶，再用分组入口置顶两条
      for (const item of before.items || []) {
        await window.nyx.addressSuggestPin({ url: item.url, title: item.title });
      }
      await window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格', group: 'work' });
      await window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' });
      await wait(250);
      const mid = await window.nyx.addressSuggestPinned();
      const moved = await window.nyx.addressSuggestPinnedGroupSet({ url: 'https://other.test/page/example-notes', group: 'study' });
      const after = await window.nyx.addressSuggestPinned();
      return {
        midGroups: (mid.items || []).map((item) => item.url + '|' + item.group),
        movedOk: !!(moved && moved.ok),
        afterGroups: (after.items || []).map((item) => item.url + '|' + item.group),
      };
    })()`);
    check(
      '置顶可按分组落位、可改分组（v1.16.0）',
      !!groupFlow &&
        groupFlow.movedOk &&
        groupFlow.midGroups.includes('https://example.com/pricing|work') &&
        groupFlow.midGroups.includes('https://other.test/page/example-notes|other') &&
        groupFlow.afterGroups.includes('https://other.test/page/example-notes|study'),
      JSON.stringify(groupFlow),
    );

    const groupReorder = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.nyx.addressSuggestPin({ url: 'https://example.com/docs/quick-start', title: '示例站 · 快速开始', group: 'work' });
      await wait(200);
      const before = await window.nyx.addressSuggestPinned();
      const workUrls = (before.items || []).filter((item) => item.group === 'work').map((item) => item.url);
      const otherBefore = (before.items || []).filter((item) => item.group !== 'work').map((item) => item.url);
      const reordered = await window.nyx.addressSuggestPinnedReorder({ group: 'work', urls: workUrls.slice().reverse() });
      const after = await window.nyx.addressSuggestPinned();
      return {
        workCount: workUrls.length,
        reorderOk: !!(reordered && reordered.ok),
        workUrls,
        afterWork: (after.items || []).filter((item) => item.group === 'work').map((item) => item.url),
        otherBefore,
        otherAfter: (after.items || []).filter((item) => item.group !== 'work').map((item) => item.url),
      };
    })()`);
    check(
      '组内重排不影响其它分组（v1.16.0）',
      !!groupReorder &&
        groupReorder.workCount === 2 &&
        groupReorder.reorderOk &&
        JSON.stringify(groupReorder.afterWork) === JSON.stringify(groupReorder.workUrls.slice().reverse()) &&
        JSON.stringify(groupReorder.otherAfter) === JSON.stringify(groupReorder.otherBefore),
      JSON.stringify(groupReorder),
    );

    const groupCap = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // 「工作」组里已有 2 条，再塞到 6 条：第 6 条应被拒
      const results = [];
      for (let i = 0; i < 4; i += 1) {
        results.push(await window.nyx.addressSuggestPin({ url: 'https://work' + i + '.test/task', title: '工作任务 ' + i, group: 'work' }));
      }
      await wait(200);
      const overflow = await window.nyx.addressSuggestPin({ url: 'https://work-extra.test/task', title: '第 6 条工作任务', group: 'work' });
      const list = await window.nyx.addressSuggestPinned();
      return {
        addedCount: results.filter((item) => item && item.ok && item.pinned).length,
        overflowOk: !!(overflow && overflow.ok),
        overflowError: (overflow && overflow.error) || '',
        workCount: (list.items || []).filter((item) => item.group === 'work').length,
      };
    })()`);
    check(
      '每组最多 5 条，第 6 条被拒（v1.16.0）',
      !!groupCap &&
        groupCap.addedCount === 3 &&
        groupCap.overflowOk === false &&
        groupCap.workCount === 5 &&
        String(groupCap.overflowError).includes('工作'),
      JSON.stringify(groupCap),
    );

    // 建议浮层里置顶条目要带分组徽标
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(200);
    await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const addr = document.getElementById('address');
      addr.focus();
      addr.value = 'pricing';
      addr.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: 'pricing' }));
      await wait(500);
      return true;
    })()`);
    const groupBadge = await readSuggest(`(() => {
      const row = document.querySelector('.as-item');
      const labels = Array.from(document.querySelectorAll('.as-item .as-src')).map((n) => n.textContent);
      const groupNode = document.querySelector('.as-item .as-src-group');
      return { labels, groupLabel: groupNode ? groupNode.textContent : '' };
    })()`);
    check(
      '建议浮层显示置顶分组徽标（v1.16.0）',
      !!groupBadge && groupBadge.labels.includes('置顶') && groupBadge.labels.includes('工作'),
      JSON.stringify(groupBadge),
    );
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(200);

    /* 8. 输入法组合期不查询、组合结束后补查询 */
    await shell.eval('window.nyx.addressSuggestClose()');
    await sleep(300);

    const imeStart = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const addr = document.getElementById('address');
      addr.focus();
      addr.value = 'exa';
      addr.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      addr.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'exa' }));
      await wait(450);
      return { value: addr.value };
    })()`);
    const composingTarget = (await listTargets()).some((t) => t.url.includes('addr-suggest.html'));
    check(
      '输入法组合期间不查询（未弹浮层）',
      !!imeStart && !composingTarget,
      `组合中输入框值 ${imeStart && imeStart.value}｜浮层${composingTarget ? '意外出现' : '未出现'}`,
    );

    await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const addr = document.getElementById('address');
      addr.value = 'exam';
      addr.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false, data: 'm' }));
      addr.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'exam' }));
      await wait(700);
      return true;
    })()`);
    const afterIme = (await listTargets()).some((t) => t.url.includes('addr-suggest.html'));
    check('输入法上屏后补查询并弹窗', afterIme, afterIme ? '组合结束后浮层已出现' : '组合结束后没有浮层');
  } catch (err) {
    check('验证流程未中断', false, err && err.message);
  } finally {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
    await sleep(1200);

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略：临时目录残留不影响结论 */
    }

    const failed = checks.filter((c) => !c.pass);
    console.log('');
    console.log(`[验证] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
    if (failed.length) {
      for (const f of failed) console.log(`  · 失败项：${f.name}｜${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('[验证] 全部通过：地址栏建议（加权 / 搜索行 / 书签 / 高亮 / 输入法 / 星标联动）符合预期');
    }
  }
}

main();
