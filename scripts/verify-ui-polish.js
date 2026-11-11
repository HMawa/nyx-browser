'use strict';

/**
 * v1.3.0 界面体验项 · 端到端验证
 *
 * 覆盖两件事（都是"改的是 CSS / 渲染层交互，光看代码看不出来"的部分）：
 *   A. 工具箱页签栏溢出横滑：页签不再被压扁、容器可横向滚动、滚轮纵向转横向、
 *      切页后当前页签完整可见、两端渐隐提示按滚动位置切换；
 *   B. 设置中心分区滚动位置记忆：切走再切回恢复原位、localStorage 落盘。
 *
 * 做法：用隔离用户数据目录启动真实 Electron 应用，通过 CDP 连到主窗口外壳与
 * 设置窗口两个 page target，在真实 DOM 上量尺寸、派发事件、读回滚位置。
 *
 * 用法：node scripts/verify-ui-polish.js
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
// 端口由系统分配（main() 里再取）：本机 Windows 把 9486–9585 留给了 Hyper-V/WinNAT，
// 原来「9700 + random」一旦撞进保留段，Chromium 的 devtools 直接就起不来（0x271D）
let PORT = 0;
const workDir = path.join(os.tmpdir(), `nyx-ui-verify-${Date.now()}`);
const userData = path.join(workDir, 'userdata');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- 预置数据 ---------------- */

/**
 * 造一份历史记录：三个站点、其中 example.com 访问 3 次，
 * 用来验证「按站点」聚合的次数、排序与展开明细（v1.6.0）。
 */
function seedHistory() {
  const now = Date.now();
  const HOUR = 3600000;
  const items = [
    { id: 1, url: 'https://example.com/a', title: '示例 A', visitedAt: now - 5 * 60000 },
    { id: 2, url: 'https://example.com/b', title: '示例 B', visitedAt: now - 2 * HOUR },
    { id: 3, url: 'https://example.com/c', title: '示例 C', visitedAt: now - 5 * HOUR },
    { id: 4, url: 'https://docs.other.test/intro', title: '别处文档', visitedAt: now - 3 * HOUR },
    { id: 5, url: 'https://third.test/page', title: '第三站', visitedAt: now - 26 * HOUR },
    { id: 6, url: 'https://third.test/page2', title: '第三站 2', visitedAt: now - 30 * HOUR },
  ];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify({ version: 1, items }, null, 2), 'utf8');
}

/* ---------------- 极简 CDP 客户端 ---------------- */

class Cdp {
  constructor(wsUrl) {
    this.ws = null;
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    /** 主进程方向的事件（console / exception），用于收尾时统一核对 */
    this.events = [];
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
        if (msg && msg.method) {
          this.events.push(msg);
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

  /** 页面里的脚本异常（真正的 JS 错误，不含被拦截的无关告警） */
  exceptions() {
    return this.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => {
        const d = e.params && e.params.exceptionDetails;
        return d ? String((d.exception && d.exception.description) || d.text) : '未知异常';
      });
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

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`找不到 Electron 可执行文件：${ELECTRON}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(userData, { recursive: true });
  seedHistory();

  // 扩展在线检查 / 全部更新 / 版本历史都读隔离 userData 的 updates/extensions.json：
  // 仓库本身不随包分发扩展，这里不种任何扩展；没有 extensions.json 时相关用例按跳过处理。

  // 先向系统要一个真正空闲的端口，再交给 Electron 的 --remote-debugging-port
  PORT = await pickFreePort();
  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');
  console.log(`[验证] 隔离用户数据：${userData}`);
  console.log(`[验证] 调试端口：${PORT}`);

  // 与另一个验证脚本一致：必须清掉 ELECTRON_RUN_AS_NODE，
  // 否则 Electron 退化成纯 Node 运行，main.js 启动即崩。
  const childEnv = { ...process.env, NYX_USER_DATA: userData };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });

  let shell = null;
  let settings = null;

  try {
    /* ---------- 主窗口 ---------- */
    const shellTarget = await waitTarget((t) => t.url.endsWith('/index.html'), 40000);
    check('主窗口外壳页面出现', !!shellTarget, shellTarget && shellTarget.url);
    if (!shellTarget) throw new Error('主窗口未就绪，无法继续验证');

    shell = await new Cdp(shellTarget.webSocketDebuggerUrl).connect();
    await shell.send('Runtime.enable', {});

    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      ready = await shell
        .eval("!!(window.nyx && typeof window.nyx.openToolboxPane === 'function')")
        .catch(() => false);
      if (!ready) await sleep(250);
    }
    check('preload 接口就绪', ready);
    if (!ready) throw new Error('preload 未就绪，无法继续验证');

    /* ---------- A. 工具箱页签栏 ---------- */
    // 打开工具箱并切到最后一个页签（Cookie），此时页签栏一定需要横滚
    await shell.eval("window.nyx.openToolboxPane({ pane: 'cookie' })");
    await sleep(900);

    const navStats = await shell.eval(`(() => {
      const nav = document.getElementById('tb-nav');
      if (!nav) return null;
      const btns = Array.from(nav.querySelectorAll('.tb-nav-btn'));
      const on = nav.querySelector('.tb-nav-btn.is-on');
      const navRect = nav.getBoundingClientRect();
      const onRect = on ? on.getBoundingClientRect() : null;
      return {
        count: btns.length,
        minBtnWidth: Math.min.apply(null, btns.map((b) => Math.round(b.getBoundingClientRect().width))),
        scrollWidth: nav.scrollWidth,
        clientWidth: nav.clientWidth,
        scrollLeft: Math.round(nav.scrollLeft),
        overflowX: getComputedStyle(nav).overflowX,
        fade: nav.dataset.fade || '',
        activePane: on ? on.dataset.pane : '',
        activeLeftGap: onRect ? Math.round(onRect.left - navRect.left) : null,
        activeRightGap: onRect ? Math.round(navRect.right - onRect.right) : null,
      };
    })()`);

    check('工具箱页签栏存在 8 个页签', navStats && navStats.count === 8, navStats && `count=${navStats.count}`);
    check(
      '页签不再被压缩（每个 ≥ 44px）',
      navStats && navStats.minBtnWidth >= 44,
      navStats && `最窄 ${navStats.minBtnWidth}px`,
    );
    check(
      '容器为横向滚动且确实溢出',
      navStats && navStats.overflowX === 'auto' && navStats.scrollWidth > navStats.clientWidth,
      navStats && `scrollWidth ${navStats.scrollWidth} > clientWidth ${navStats.clientWidth}`,
    );
    check(
      '切页后当前页签完整可见',
      navStats &&
        navStats.activePane === 'cookie' &&
        navStats.scrollLeft > 0 &&
        navStats.activeLeftGap >= -1 &&
        navStats.activeRightGap >= -1,
      navStats && `pane=${navStats.activePane} scrollLeft=${navStats.scrollLeft} 左右余量=${navStats.activeLeftGap}/${navStats.activeRightGap}`,
    );
    check(
      '两端渐隐提示已生效',
      navStats && ['start', 'end', 'both'].includes(navStats.fade),
      navStats && `data-fade=${navStats.fade || '(空)'}`,
    );

    // 滚轮纵向转横向：先归零，再派发一次 deltaY=120 的 wheel
    const wheel = await shell.eval(`(() => {
      const nav = document.getElementById('tb-nav');
      nav.scrollLeft = 0;
      const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
      nav.dispatchEvent(event);
      return { scrollLeft: Math.round(nav.scrollLeft), prevented: event.defaultPrevented };
    })()`);
    check(
      '滚轮纵向滚动转横向',
      wheel && wheel.scrollLeft > 0 && wheel.prevented === true,
      wheel && `scrollLeft=${wheel.scrollLeft} defaultPrevented=${wheel.prevented}`,
    );

    // 焦点可达性：聚焦最后一个页签应把它带进视野
    const focusReveal = await shell.eval(`(() => {
      const nav = document.getElementById('tb-nav');
      nav.scrollLeft = 0;
      const last = nav.querySelectorAll('.tb-nav-btn')[nav.querySelectorAll('.tb-nav-btn').length - 1];
      last.focus();
      const navRect = nav.getBoundingClientRect();
      const rect = last.getBoundingClientRect();
      return { focused: document.activeElement === last, rightGap: Math.round(navRect.right - rect.right), scrollLeft: Math.round(nav.scrollLeft) };
    })()`);
    check(
      '键盘聚焦页签自动滚入视野',
      focusReveal && focusReveal.focused && focusReveal.scrollLeft > 0 && focusReveal.rightGap >= -1,
      focusReveal && `scrollLeft=${focusReveal.scrollLeft} 右侧余量=${focusReveal.rightGap}`,
    );

    /* ---------- C. 工具栏星标样式（v1.4.0） ---------- */
    const star = await shell.eval(`(() => {
      const btn = document.getElementById('btn-bookmark');
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      const rect = btn.getBoundingClientRect();
      const addr = document.getElementById('address').getBoundingClientRect();
      const tool = document.getElementById('btn-toolbox').getBoundingClientRect();
      const text = (btn.textContent || '').trim();
      return {
        cls: btn.className,
        glyphOk: text === '☆' || text === '★',
        disabled: btn.disabled,
        fontSize: Math.round(parseFloat(cs.fontSize)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        color: cs.color,
        cursor: cs.cursor,
        opacity: cs.opacity,
        betweenAddressAndToolbox: rect.left >= addr.right - 1 && rect.right <= tool.left + 1,
      };
    })()`);
    check(
      '星标按钮存在且插在地址栏与工具箱之间',
      !!star && star.betweenAddressAndToolbox && star.glyphOk && String(star.cls).includes('bm-star'),
      star && `class=${star.cls}｜glyph=${star.glyphOk}｜位置正确=${star.betweenAddressAndToolbox}`,
    );
    check(
      '星标尺寸与图标按钮同一量级、星形字号已放大',
      !!star && star.width >= 26 && star.height >= 26 && star.fontSize >= 14,
      star && `${star.width}×${star.height}｜字号 ${star.fontSize}px`,
    );
    check(
      '不可收藏页面（about:blank）星标禁用且不响应 hover',
      !!star && star.disabled === true && star.cursor === 'default',
      star && `disabled=${star.disabled}｜cursor=${star.cursor}｜opacity=${star.opacity}`,
    );

    /* ---------- D. 工具箱历史「按站点」视图（v1.6.0） ---------- */
    await shell.eval("window.nyx.openToolboxPane({ pane: 'history' })");
    await sleep(1600);

    const siteView = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const pane = document.getElementById('pane-history');
      if (!pane) return { missingPane: true };
      const chips = Array.from(pane.querySelectorAll('.tb-chip'));
      const siteChip = chips.find((c) => (c.textContent || '').includes('按站点'));
      if (!siteChip) return { missingChip: true, chips: chips.map((c) => c.textContent) };
      siteChip.click();
      await wait(600);
      const rows = Array.from(pane.querySelectorAll('.tb-site'));
      const first = rows[0] || null;
      const info = first
        ? {
            host: (first.querySelector('.tb-item-name') || {}).textContent,
            meta: (first.querySelector('.tb-item-sub') || {}).textContent,
            hasIcon: !!first.querySelector('.tb-site-icon'),
            isMono: !!first.querySelector('.tb-site-mono'),
            expanded: first.getAttribute('aria-expanded'),
          }
        : null;
      if (first) first.click();
      await wait(400);
      const detailRows = pane.querySelectorAll('.tb-site-detail .tb-site-url').length;
      const ariaWhenOpen = first ? first.getAttribute('aria-expanded') : null;
      if (first) first.click();
      await wait(300);
      const detailAfterCollapse = pane.querySelectorAll('.tb-site-detail').length;
      let stored = null;
      try {
        stored = window.localStorage.getItem('nyx:tb:history-view');
      } catch {
        stored = 'ERR';
      }
      return { rows: rows.length, info, detailRows, ariaWhenOpen, detailAfterCollapse, stored };
    })()`);

    check(
      '历史页签存在「按站点」视图切换',
      !!siteView && !siteView.missingChip && !siteView.missingPane,
      JSON.stringify(siteView && (siteView.chips || siteView)),
    );
    check('按站点聚合出 3 个站点', !!siteView && siteView.rows === 3, siteView && `聚合行 ${siteView.rows}`);
    check(
      '聚合行含域名 / 访问次数 / 相对时间 / 图标',
      !!siteView &&
        siteView.info &&
        siteView.info.host === 'example.com' &&
        String(siteView.info.meta || '').includes('次访问') &&
        siteView.info.hasIcon,
      siteView && JSON.stringify(siteView.info),
    );
    check(
      '点行展开明细、再点收起',
      !!siteView &&
        siteView.detailRows === 3 &&
        siteView.ariaWhenOpen === 'true' &&
        siteView.detailAfterCollapse === 0,
      siteView && `明细 ${siteView.detailRows} 条 / aria-open=${siteView.ariaWhenOpen} / 收起后 ${siteView.detailAfterCollapse}`,
    );
    check('视图选择已记忆', !!siteView && siteView.stored === 'site', siteView && String(siteView.stored));

    /* ---------- D2. 历史「自定义区间」+ 抓包「只看失败」（v1.8.0） ---------- */
    const rangeUi = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const pane = document.getElementById('pane-history');
      const chips = Array.from(pane.querySelectorAll('.tb-chip'));
      const custom = chips.find((c) => (c.textContent || '').includes('自定义'));
      if (!custom) return { missingChip: true, chips: chips.map((c) => c.textContent) };
      custom.click();
      await wait(200);
      const row = pane.querySelector('.tb-date-row');
      const visible = !!(row && !row.hidden);
      const from = row && row.querySelector('input[type="date"]');
      const applyBtn = row && Array.from(row.querySelectorAll('button')).find((b) => (b.textContent || '').includes('应用'));
      let meta = '';
      if (row && from) {
        const today = new Date();
        const iso = (d) => d.toISOString().slice(0, 10);
        const inputs = Array.from(row.querySelectorAll('input[type="date"]'));
        inputs[0].value = iso(today);
        inputs[1].value = iso(today);
        if (applyBtn) applyBtn.click();
        await wait(300);
        meta = (document.getElementById('history-meta') || {}).textContent || '';
      }
      let stored = null;
      try {
        stored = window.localStorage.getItem('nyx:tb:history-range');
      } catch {
        stored = 'ERR';
      }
      return { visible, meta, stored, hasFrom: !!from };
    })()`);
    check(
      '历史时间段有「自定义」并展开日期输入',
      !!rangeUi && !rangeUi.missingChip && rangeUi.visible === true && rangeUi.hasFrom === true,
      JSON.stringify(rangeUi && (rangeUi.chips || rangeUi)),
    );
    check(
      '自定义区间应用后 meta 跟随并记忆',
      !!rangeUi && String(rangeUi.meta).includes('命中') && rangeUi.stored === 'custom',
      `meta=${rangeUi && rangeUi.meta}｜stored=${rangeUi && rangeUi.stored}`,
    );

    const netUi = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.nyx.openToolboxPane({ pane: 'net' });
      await wait(900);
      const pane = document.getElementById('pane-net');
      // 胶囊可能被整行重建（renderNetChips），所以每次点击后都重新查一遍 DOM
      const findToggle = () =>
        Array.from(pane.querySelectorAll('.tb-chip')).find((c) => (c.textContent || '').includes('只看失败'));
      const first = findToggle();
      if (!first) return { missingChip: true };
      const before = first.getAttribute('aria-pressed');
      first.click();
      await wait(300);
      const second = findToggle();
      const after = second ? second.getAttribute('aria-pressed') : null;
      let stored = null;
      try {
        stored = window.localStorage.getItem('nyx:tb:net-failed');
      } catch {
        stored = 'ERR';
      }
      // 复原，避免影响后续步骤
      if (second) second.click();
      await wait(150);
      return { before, after, stored };
    })()`);
    check(
      '抓包有「只看失败」开关胶囊',
      !!netUi && !netUi.missingChip && netUi.before === 'false' && netUi.after === 'true',
      JSON.stringify(netUi),
    );
    check(
      '只看失败开关状态已记忆',
      !!netUi && (netUi.stored === '1' || netUi.stored === '0'),
      netUi && String(netUi.stored),
    );

    /* ---------- B. 设置中心分区滚动记忆 ---------- */
    await shell.eval('window.nyx.openSettings()');
    const settingsTarget = await waitTarget((t) => t.url.endsWith('/settings.html'), 20000);
    check('设置窗口出现', !!settingsTarget, settingsTarget && settingsTarget.url);

    if (settingsTarget) {
      settings = await new Cdp(settingsTarget.webSocketDebuggerUrl).connect();
      await settings.send('Runtime.enable', {});

      // 等设置页初始化完成（分区面板渲染 + 事件绑定）
      let settingsReady = false;
      for (let i = 0; i < 40 && !settingsReady; i += 1) {
        settingsReady = await settings
          .eval("!!document.querySelector('.sec-panel[data-sec=appearance] .sec-scroll')")
          .catch(() => false);
        if (!settingsReady) await sleep(250);
      }
      check('设置页分区就绪', settingsReady);

      if (settingsReady) {
        const scrollFlow = await settings.eval(`(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));

          // 找一个"内容确实超出可视区"的分区（设置窗口默认 1180×820，多数分区一屏放得下）。
          // 若全部放得下，就给最高的那个分区临时塞一块占位板，把滚动条撑出来——
          // 记忆逻辑是分区通用的，占位板只影响可滚区间，不影响被测行为。
          const panels = Array.from(document.querySelectorAll('.sec-panel')).filter((p) => p.querySelector('.sec-scroll'));
          let pick = null;
          let pickMax = -1;
          for (const p of panels) {
            const box = p.querySelector('.sec-scroll');
            const span = box.scrollHeight - box.clientHeight;
            if (span > pickMax) {
              pickMax = span;
              pick = { panel: p, box };
            }
          }
          let spacer = null;
          if (pickMax < 40) {
            spacer = document.createElement('div');
            // 注意：.sec-scroll 是 flex 纵向容器，普通 height 会被 flex-shrink 压回去，
            // 必须用 flex: 0 0 <高>，否则撑不出滚动条（这里踩过一次）
            spacer.style.flex = '0 0 1400px';
            spacer.style.height = '1400px';
            pick.box.appendChild(spacer);
            await wait(120);
          }
          const section = pick.panel.dataset.sec;
          const other = (panels.find((p) => p.dataset.sec !== section) || {}).dataset
            ? panels.find((p) => p.dataset.sec !== section).dataset.sec
            : 'startup';

          const max = Math.max(0, pick.box.scrollHeight - pick.box.clientHeight);
          const target = Math.min(240, max);
          pick.box.scrollTop = target;
          pick.box.dispatchEvent(new Event('scroll'));
          await wait(350);

          const go = (name) => document.querySelector('.nav-item[data-sec="' + name + '"]').click();

          go(other);
          await wait(160);
          go(section);
          await wait(160);
          const afterBack = Math.round(pick.box.scrollTop);

          go(other);
          await wait(160);
          go(section);
          await wait(160);
          const afterSecondBack = Math.round(pick.box.scrollTop);

          let stored = null;
          try {
            stored = window.localStorage.getItem('nyx:settings:scroll');
          } catch {
            stored = 'ERR';
          }

          if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
          return { section, other, max, target, afterBack, afterSecondBack, stored };
        })()`);

        check(
          '切走再切回恢复滚动位置',
          scrollFlow && scrollFlow.target > 0 && Math.abs(scrollFlow.afterBack - scrollFlow.target) <= 2,
          scrollFlow && `分区 ${scrollFlow.section} 目标 ${scrollFlow.target} / 恢复 ${scrollFlow.afterBack}（可滚区间 ${scrollFlow.max}）`,
        );
        check(
          '多次往返仍稳定',
          scrollFlow && Math.abs(scrollFlow.afterSecondBack - scrollFlow.target) <= 2,
          scrollFlow && `第二次恢复 ${scrollFlow.afterSecondBack}`,
        );
        check(
          '滚动位置已落盘 localStorage',
          scrollFlow && typeof scrollFlow.stored === 'string' && scrollFlow.stored.includes(scrollFlow.section),
          scrollFlow && String(scrollFlow.stored).slice(0, 80),
        );
      }
    }

    /* ---------- E. 扩展插件（v1.9.0 起：导入 / 已安装列表） ---------- */
    await settings.eval(`document.querySelector('.nav-item[data-sec="extensions"]').click()`);
    await sleep(1200);

    const extPanel = await settings.eval(`(() => {
      const sec = document.querySelector('.sec-panel[data-sec="extensions"]');
      const cards = sec ? Array.from(sec.querySelectorAll('.info-card h3')).map((h) => (h.textContent || '').trim()) : [];
      return {
        cards,
        hasImportDir: !!document.getElementById('btn-ext-add-dir'),
        hasImportCrx: !!document.getElementById('btn-ext-add-crx'),
        hasInstalledList: !!document.getElementById('ext-list'),
      };
    })()`);
    check(
      '设置里扩展插件分区有导入入口与已安装列表',
      !!extPanel &&
        extPanel.hasImportDir === true &&
        extPanel.hasImportCrx === true &&
        extPanel.hasInstalledList === true &&
        (extPanel.cards || []).length >= 2,
      JSON.stringify(extPanel),
    );

    // v1.10.0：抓包耗时用单调时钟计算（此前恒为 0 → 界面一直"耗时未知"）
    // 用本机一个必然拒绝连接的端口：失败很快（DNS/网络超时不可控，会拖到 30s）
    const timingFlow = await shell.eval(`(async () => {
      const created = await window.nyx.createTab('http://127.0.0.1:9/nyx-timing-probe');
      await new Promise((r) => setTimeout(r, 2500));
      const res = await window.nyx.listToolboxRecords({});
      const recs = (res && res.records) || [];
      const finished = recs.filter((rec) => rec && rec.finished);
      const withDuration = finished.filter((rec) => Number(rec.duration) > 0);
      const sample = withDuration[0] || null;
      return {
        total: recs.length,
        finished: finished.length,
        withDuration: withDuration.length,
        sample: sample ? { duration: sample.duration, timing: sample.timing || null, failed: sample.failed || '' } : null,
        tabId: created && created.id,
      };
    })()`);
    check(
      '抓包记录带真实耗时（单调时钟计算）',
      !!timingFlow && timingFlow.withDuration >= 1,
      JSON.stringify(timingFlow && (timingFlow.sample || timingFlow)),
    );
    if (timingFlow && timingFlow.tabId != null) {
      await shell.eval(`window.nyx.closeTab(${timingFlow.tabId})`);
    }

    /* ---------- E2. v1.12.0：置顶管理 / 统一检查更新 ---------- */
    await shell.eval(`(async () => {
      await window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格' });
      await window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' });
    })()`);

    const pinnedUi = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="appearance"]').click();
      await wait(800);
      const box = document.getElementById('pinned-list');
      const rows = box ? Array.from(box.querySelectorAll('.ext-item')) : [];
      const firstButtons = rows[0] ? Array.from(rows[0].querySelectorAll('button')).map((b) => b.textContent) : [];
      return {
        rows: rows.length,
        countText: (document.getElementById('pinned-count') || {}).textContent || '',
        buttons: firstButtons,
        draggable: !!(rows[0] && rows[0].draggable),
      };
    })()`);
    check(
      '设置里有置顶管理（可拖动 / ↑↓ / 取消置顶）',
      !!pinnedUi && pinnedUi.rows === 2 && pinnedUi.draggable === true && (pinnedUi.buttons || []).includes('取消置顶'),
      JSON.stringify(pinnedUi),
    );

    /* ---------- E2b. v1.15.0：置顶导入 / 导出 ---------- */
    const exportFile = path.join(workDir, 'pinned-export.json');
    const importFile = path.join(workDir, 'pinned-import.json');
    const ioFlow = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = await window.nyx.addressSuggestPinned();
      const exported = await window.nyx.addressSuggestPinnedExport({ path: ${JSON.stringify(exportFile)} });
      // 清空后从未导入：应逐条回到两条
      for (const item of (before.items || [])) {
        await window.nyx.addressSuggestPin({ url: item.url, title: item.title });
      }
      const emptied = await window.nyx.addressSuggestPinned();
      const imported = await window.nyx.addressSuggestPinnedImport({ path: ${JSON.stringify(exportFile)} });
      await wait(200);
      const afterImport = await window.nyx.addressSuggestPinned();
      const again = await window.nyx.addressSuggestPinnedImport({ path: ${JSON.stringify(exportFile)} });
      return {
        beforeCount: (before.items || []).length,
        exportOk: !!(exported && exported.ok),
        exportedCount: exported ? exported.count : null,
        emptiedCount: (emptied.items || []).length,
        importOk: !!(imported && imported.ok),
        added: imported ? imported.added : null,
        skipped: imported ? imported.skipped : null,
        afterCount: (afterImport.items || []).length,
        againAdded: again ? again.added : null,
        againSkipped: again ? again.skipped : null,
        againTotal: again ? again.total : null,
      };
    })()`);

    // 手工造一份"脏"文件：重复一条 + 非法一条 + 三条新的，正好顶到上限 5
    fs.writeFileSync(
      importFile,
      JSON.stringify({
        app: 'Nyx',
        kind: 'pinned-suggestions',
        version: 1,
        items: [
          { url: 'https://example.com/pricing', title: '重复的' },
          'ftp://not-http.example/x',
          { url: 'https://new-one.test/a', title: '新增 A' },
          { url: 'https://new-two.test/b', title: '新增 B' },
          { url: 'https://new-three.test/c', title: '新增 C' },
          { url: 'https://new-four.test/d', title: '溢出 D' },
        ],
      }),
      'utf8',
    );
    const dirtyImport = await shell.eval(
      `window.nyx.addressSuggestPinnedImport({ path: ${JSON.stringify(importFile)} })`,
    );
    const overLimit = await shell.eval(
      `window.nyx.addressSuggestPinnedImport({ path: ${JSON.stringify(importFile)} })`,
    );

    // 复原：清掉导入的，重新置顶原来两条（不影响后面用例）
    await shell.eval(`(async () => {
      const now = await window.nyx.addressSuggestPinned();
      for (const item of (now.items || [])) {
        await window.nyx.addressSuggestPin({ url: item.url, title: item.title });
      }
      await window.nyx.addressSuggestPin({ url: 'https://example.com/pricing', title: '示例站 · 价格' });
      await window.nyx.addressSuggestPin({ url: 'https://other.test/page/example-notes', title: '别处的示例笔记' });
    })()`);

    const exportedJson = (() => {
      try {
        return JSON.parse(fs.readFileSync(exportFile, 'utf8'));
      } catch {
        return null;
      }
    })();
    check(
      '置顶可导出为 JSON 并原样导回（v1.15.0）',
      !!ioFlow &&
        ioFlow.beforeCount === 2 &&
        ioFlow.exportOk === true &&
        ioFlow.exportedCount === 2 &&
        !!exportedJson &&
        exportedJson.kind === 'pinned-suggestions' &&
        (exportedJson.items || []).length === 2 &&
        ioFlow.emptiedCount === 0 &&
        ioFlow.importOk === true &&
        ioFlow.added === 2 &&
        ioFlow.afterCount === 2 &&
        ioFlow.againAdded === 0 &&
        ioFlow.againSkipped === 2 &&
        ioFlow.againTotal === 2,
      JSON.stringify(ioFlow),
    );
    check(
      '导入合并去重、跳过非法、填到上限 5 条（v1.15.0）',
      !!dirtyImport &&
        dirtyImport.ok === true &&
        dirtyImport.added === 3 &&
        dirtyImport.skipped === 2 &&
        dirtyImport.invalid === 1 &&
        dirtyImport.total === 5 &&
        !!overLimit &&
        overLimit.ok === true &&
        overLimit.added === 0 &&
        overLimit.skipped === 5 &&
        overLimit.total === 5,
      JSON.stringify({ dirtyImport, overLimit }),
    );

    const unified = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="about"]').click();
      await wait(600);
      const btn = document.getElementById('btn-check-update');
      if (!btn) return { missing: true };
      btn.click();
      await wait(2500);
      return { status: (document.getElementById('statusbar') || {}).textContent || '' };
    })()`);
    check(
      '「检查更新」一次查应用与扩展',
      !!unified && String(unified.status).includes('应用') && String(unified.status).includes('扩展'),
      JSON.stringify(unified),
    );

    // v1.13.0：全部更新按钮（没有扩展清单时给出明确提示，有清单时给出「都已是最新」或更新结果）
    const updateAll = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="extensions"]').click();
      await wait(700);
      const btn = document.getElementById('btn-ext-update-all');
      if (!btn) return { missing: true };
      btn.click();
      await wait(2500);
      return { status: (document.getElementById('statusbar') || {}).textContent || '' };
    })()`);
    check(
      '扩展「全部更新」可用（给出明确结果）',
      !!updateAll &&
        (String(updateAll.status).includes('最新') ||
          String(updateAll.status).includes('已更新') ||
          String(updateAll.status).includes('extensions.json')),
      JSON.stringify(updateAll),
    );

    /* ---------- F. v1.16.0：设置中心四件（慢请求阈值 / 更新源占用 / 版本历史 / 置顶分组） ---------- */

    // F1：外观 →「抓包慢请求阈值」，写进主进程配置，越界值必须被挡下
    const slowSetting = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="appearance"]').click();
      await wait(700);
      const input = document.getElementById('net-slow-ms');
      const save = document.getElementById('btn-net-slow-save');
      if (!input || !save) return { missing: true };
      const hintEl = () => document.getElementById('net-slow-hint');
      input.value = '1200';
      save.click();
      await wait(700);
      const savedHint = (hintEl() || {}).textContent || '';
      const badge = (document.getElementById('net-slow-badge') || {}).textContent || '';
      const read = await window.nyx.tbSlowMs();
      // 越界值（10 < 最小值 50）必须被拒绝，且不能覆盖已经存好的 1200
      input.value = '10';
      save.click();
      await wait(500);
      const rejectedHint = (hintEl() || {}).textContent || '';
      const readAfter = await window.nyx.tbSlowMs();
      return { savedHint, badge, rejectedHint, read, readAfter };
    })()`);
    check(
      '设置页能保存抓包慢请求阈值（v1.16.0）',
      !!slowSetting &&
        !slowSetting.missing &&
        String(slowSetting.savedHint).includes('已保存') &&
        !!slowSetting.read &&
        slowSetting.read.ok === true &&
        slowSetting.read.slowMs === 1200,
      JSON.stringify(slowSetting && { hint: slowSetting.savedHint, badge: slowSetting.badge, read: slowSetting.read }),
    );
    check(
      '越界的慢请求阈值被挡下且不覆盖旧值（v1.16.0）',
      !!slowSetting &&
        String(slowSetting.rejectedHint).includes('整数毫秒数') &&
        !!slowSetting.readAfter &&
        slowSetting.readAfter.slowMs === 1200,
      JSON.stringify(slowSetting && { hint: slowSetting.rejectedHint, readAfter: slowSetting.readAfter }),
    );

    // F2：瀑布「只看慢请求」跟着面板阈值走（阈值 1200 ms，失败探测请求远快于它 → 必然空态）
    const wfSlow = await shell.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.nyx.openToolboxPane({ pane: 'net' });
      await wait(900);
      const slowInput = document.querySelector('#net-extra .tb-slow-input');
      if (!slowInput) return { missingInput: true };
      slowInput.value = '1200';
      slowInput.dispatchEvent(new Event('change'));
      await wait(400);
      const created = await window.nyx.createTab('http://127.0.0.1:9/nyx-wf-slow');
      await wait(2400);
      const rows = Array.from(document.querySelectorAll('#net-list .tb-net'));
      if (rows.length === 0) return { missingRow: true };
      rows[rows.length - 1].click();
      await wait(500);
      const nav = Array.from(document.querySelectorAll('#detail-nav .tb-nav-btn')).find(
        (b) => b.dataset.sec === 'waterfall',
      );
      if (!nav) return { missingNav: true };
      nav.click();
      await wait(400);
      const body = document.getElementById('detail-body');
      const chip = Array.from(body.querySelectorAll('.tb-chip')).find((c) =>
        (c.textContent || '').includes('只看慢请求'),
      );
      if (!chip) return { missingChip: true };
      const readStats = () => ((body.querySelector('.tb-wf-head') || {}).textContent || '').replace(/\\s+/g, ' ');
      const beforeStats = readStats();
      chip.click();
      await wait(500);
      const afterStats = readStats();
      const text = (body.textContent || '').replace(/\\s+/g, ' ');
      let threshold = '';
      try {
        threshold = window.localStorage.getItem('nyx:tb:slow-ms') || '';
      } catch {
        threshold = 'ERR';
      }
      return {
        beforeStats,
        afterStats,
        empty: text.includes('当前筛选下没有请求'),
        threshold,
        tabId: created && created.id,
      };
    })()`);
    check(
      '瀑布「只看慢请求」按面板阈值过滤（v1.16.0）',
      !!wfSlow &&
        !wfSlow.missingInput &&
        !wfSlow.missingRow &&
        !wfSlow.missingNav &&
        !wfSlow.missingChip &&
        wfSlow.threshold === '1200' &&
        !String(wfSlow.beforeStats).includes('慢 ≥') &&
        String(wfSlow.afterStats).includes('慢 ≥1200 ms') &&
        wfSlow.empty === true,
      JSON.stringify(wfSlow),
    );
    if (wfSlow && wfSlow.tabId != null) {
      await shell.eval(`window.nyx.closeTab(${wfSlow.tabId})`);
    }

    // F3：关于 →「更新源占用」看板（三个 KV 行，且合计与主进程一致）
    const footprintUi = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="about"]').click();
      await wait(1000);
      const grid = document.getElementById('update-footprint-grid');
      const rows = grid ? Array.from(grid.querySelectorAll('.kv-item')) : [];
      const ipc = await window.nyx.updateFootprint();
      return {
        rows: rows.length,
        texts: rows.map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim()),
        badge: (document.getElementById('footprint-badge') || {}).textContent || '',
        paths: (document.getElementById('footprint-paths') || {}).textContent || '',
        ipc,
      };
    })()`);
    check(
      '设置页展示更新源占用看板（v1.16.0）',
      !!footprintUi &&
        footprintUi.rows === 3 &&
        (footprintUi.texts || []).some((t) => t.includes('更新源')) &&
        (footprintUi.texts || []).some((t) => t.includes('留档')) &&
        !!footprintUi.ipc &&
        footprintUi.ipc.ok === true &&
        // 隔离用户数据里的更新源可能是空的：合计行要与主进程读数一致
        Number(footprintUi.ipc.total) === 0
          ? (footprintUi.texts || []).some((t) => t.includes('合计') && t.includes('0 B'))
          : (footprintUi.texts || []).some((t) => t.includes('合计') && !t.includes('0 B')),
      JSON.stringify(footprintUi && { rows: footprintUi.rows, texts: footprintUi.texts, total: footprintUi.ipc && footprintUi.ipc.total }),
    );

    // F4：一键复制清理命令（按钮把命令原文写进提示区，主进程给出同一条命令）
    const cleanCmdUi = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.getElementById('btn-footprint-copy');
      if (!btn) return { missing: true };
      btn.click();
      await wait(600);
      const hint = (document.getElementById('footprint-hint') || {}).textContent || '';
      const ipc = await window.nyx.updateCopyCleanCommand();
      return { hint, ipc };
    })()`);
    check(
      '设置页可复制更新源清理命令（v1.16.0）',
      !!cleanCmdUi &&
        !cleanCmdUi.missing &&
        String(cleanCmdUi.hint).includes('--clean-updates') &&
        !!cleanCmdUi.ipc &&
        cleanCmdUi.ipc.ok === true &&
        String(cleanCmdUi.ipc.command).includes('--clean-updates'),
      JSON.stringify(cleanCmdUi),
    );

    // F5：扩展 →「扩展版本历史」面板（当前版本行禁用，其余可回滚）
    const historyUi = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="extensions"]').click();
      await wait(1000);
      const ipc = await window.nyx.extOnlineHistory();
      const list = document.getElementById('ext-history-list');
      const rows = list ? Array.from(list.querySelectorAll('.ext-history-row')) : [];
      const currentRow = rows.find((r) => r.classList.contains('is-current')) || null;
      const currentBtn = currentRow ? currentRow.querySelector('button') : null;
      return {
        ipcOk: !!(ipc && ipc.ok),
        ipcVersions: ((ipc && ipc.items && ipc.items[0] && ipc.items[0].history) || []).map((v) => v.version),
        rows: rows.length,
        versions: rows.map((r) => ((r.querySelector('.ext-history-ver') || {}).textContent || '').trim()),
        currentLabel: currentRow ? ((currentRow.querySelector('.ext-history-ver') || {}).textContent || '').trim() : '',
        badge: (document.getElementById('ext-history-count') || {}).textContent || '',
        currentDisabled: currentBtn ? currentBtn.disabled === true : null,
        currentText: currentBtn ? (currentBtn.textContent || '').trim() : '',
        rollbackLabels: rows
          .filter((r) => !r.classList.contains('is-current'))
          .map((r) => ((r.querySelector('button') || {}).textContent || '').trim()),
      };
    })()`);
    // F6 / F7 的交互辅助：点某个历史行的「回滚到此版本」，先接管确认框
    const rollbackTo = (version, waitMs) => `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const origConfirm = window.confirm;
      window.confirm = () => true;
      try {
        document.querySelector('.nav-item[data-sec="extensions"]').click();
        await wait(900);
        const findRow = (ver) =>
          Array.from(document.querySelectorAll('.ext-history-row')).find(
            (r) => ((r.querySelector('.ext-history-ver') || {}).textContent || '').trim() === ver,
          );
        const row = findRow('${version}');
        if (!row) return { missingRow: true };
        const btn = row.querySelector('button');
        if (!btn) return { missingBtn: true };
        const label = (btn.textContent || '').trim();
        btn.click();
        await wait(${waitMs});
        const list = await window.nyx.listExtensions();
        const items = (list && list.items) || [];
        return {
          label,
          versions: items.map((e) => e.version),
          count: items.length,
          status: (document.getElementById('statusbar') || {}).textContent || '',
        };
      } finally {
        window.confirm = origConfirm;
      }
    })()`;

    const historyVersions = (historyUi && historyUi.ipcVersions) || [];
    if (!historyUi || historyVersions.length < 2) {
      // 仓库不随包分发扩展：更新源没提供历史时，这组用例没有可断言的对象
      check('更新源未提供扩展历史，版本历史回滚用例跳过', true, JSON.stringify(historyUi));
    } else {
      check(
        '设置页列出扩展版本历史（v1.16.0）',
        historyUi.ipcOk === true &&
          historyUi.rows === (historyUi.versions || []).length &&
          historyUi.rows >= 2 &&
          historyUi.currentDisabled === true &&
          String(historyUi.currentText).includes('当前版本') &&
          (historyUi.rollbackLabels || []).every((label) => label.includes('回滚到此版本')),
        JSON.stringify(historyUi),
      );

      // F6 / F7：回滚到最旧版本再滚回当前版本（按钮 + 二次确认走真实交互）
      const currentVersion = String(historyUi.currentLabel || '').replace(/^v/, '');
      const olderVersion = historyVersions.filter((v) => v !== currentVersion).pop();
      const rbDown = await settings.eval(rollbackTo(`v${olderVersion}`, 3000));
      check(
        '可从版本历史回滚到旧版本（v1.16.0）',
        !!rbDown &&
          !rbDown.missingRow &&
          !rbDown.missingBtn &&
          String(rbDown.label).includes('回滚到此版本') &&
          (rbDown.versions || []).includes(olderVersion),
        JSON.stringify(rbDown),
      );
      const rbUp = await settings.eval(rollbackTo(`v${currentVersion}`, 3000));
      check(
        '可从版本历史滚回最新版本（v1.16.0）',
        !!rbUp && !rbUp.missingRow && (rbUp.versions || []).includes(currentVersion),
        JSON.stringify(rbUp),
      );
    }

    // F8：外观 → 置顶项按工作/学习/其他分区渲染（每行带分组下拉）
    const groupUi = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.nav-item[data-sec="appearance"]').click();
      await wait(900);
      const list = document.getElementById('pinned-list');
      const sections = list ? Array.from(list.querySelectorAll('.pinned-group')) : [];
      const selects = list ? Array.from(list.querySelectorAll('select.pinned-group-select')) : [];
      return {
        sections: sections.length,
        titles: sections.map((s) => ((s.querySelector('.pinned-group-title') || {}).textContent || '').trim()),
        counts: sections.map((s) => ((s.querySelector('.badge') || {}).textContent || '').trim()),
        rows: list ? list.querySelectorAll('.ext-item').length : 0,
        selects: selects.length,
        options: selects[0] ? Array.from(selects[0].options).map((o) => o.value) : [],
      };
    })()`);
    check(
      '置顶项按分组分区展示（v1.16.0）',
      !!groupUi &&
        groupUi.sections === 3 &&
        (groupUi.titles || []).join(',') === '工作,学习,其他' &&
        groupUi.selects === groupUi.rows &&
        (groupUi.options || []).join(',') === 'work,study,other',
      JSON.stringify(groupUi),
    );

    // F9：行首下拉跨组移动（改完从 IPC 读回来确认落盘）
    const groupMove = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const list = document.getElementById('pinned-list');
      const select = list ? list.querySelector('select.pinned-group-select') : null;
      if (!select) return { missing: true };
      const url = select.dataset.url;
      select.value = 'work';
      select.dispatchEvent(new Event('change'));
      await wait(1000);
      const after = await window.nyx.addressSuggestPinned();
      const moved = (after.items || []).find((it) => it.url === url) || null;
      // 复原成 other，避免影响后面的组上限断言
      await window.nyx.addressSuggestPinnedGroupSet({ url, group: 'other' });
      return { url, group: moved && moved.group, status: (document.getElementById('statusbar') || {}).textContent || '' };
    })()`);
    check(
      '置顶项可用下拉跨组移动（v1.16.0）',
      !!groupMove && !groupMove.missing && groupMove.group === 'work',
      JSON.stringify(groupMove),
    );

    // F10：每组上限 5 条（第 6 条必须被拒绝，并给中文原因）
    const groupCap = await shell.eval(`(async () => {
      const urls = [1, 2, 3, 4, 5, 6].map((n) => 'https://cap-' + n + '.nyx.test/page');
      const results = [];
      for (const url of urls) {
        results.push(await window.nyx.addressSuggestPin({ url, title: url, group: 'study' }));
      }
      const state = await window.nyx.addressSuggestPinned();
      return {
        okFlags: results.map((r) => !!(r && r.ok)),
        lastError: (results[5] && results[5].error) || '',
        study: ((state && state.items) || []).filter((it) => it.group === 'study').length,
        groups: ((state && state.groups) || []).map((g) => g.key),
        groupMax: state && state.groupMax,
      };
    })()`);
    check(
      '置顶每组上限 5 条（v1.16.0）',
      !!groupCap &&
        groupCap.okFlags.slice(0, 5).every((ok) => ok === true) &&
        groupCap.okFlags[5] === false &&
        String(groupCap.lastError).includes('最多只能置顶 5 条') &&
        groupCap.study === 5 &&
        groupCap.groupMax === 5,
      JSON.stringify(groupCap),
    );

    /* ---------- 运行时无脚本异常 ---------- */
    const shellErrors = shell.exceptions();
    check('主窗口无未捕获脚本异常', shellErrors.length === 0, shellErrors.slice(0, 3).join(' | '));
    if (settings) {
      const settingsErrors = settings.exceptions();
      check('设置窗口无未捕获脚本异常', settingsErrors.length === 0, settingsErrors.slice(0, 3).join(' | '));
    }
  } catch (err) {
    check('验证流程未中断', false, err && err.message);
  } finally {
    try {
      if (shell) shell.close();
      if (settings) settings.close();
    } catch {
      /* 忽略 */
    }
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
      /* 忽略 */
    }

    const failed = checks.filter((c) => !c.pass);
    console.log('');
    console.log(`[验证] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
    if (failed.length) {
      for (const f of failed) console.log(`  · 失败项：${f.name}｜${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('[验证] 全部通过：页签横滑与设置分区滚动记忆行为符合预期');
    }
  }
}

main();
