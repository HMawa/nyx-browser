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

  // 下载用例（A1）的隔离条件：把「下载前询问保存位置」关掉、落点钉在 workDir 里。
  // 关掉询问不是为了绕过保存框——A1 的修复正是把保存框改成同步调用，自动化里
  // 弹模态框会把整条链卡住。静默落盘这条分支同样走 installDownloadHandler 的
  // setSavePath 路径，被断言覆盖。
  const downloadDir = path.join(workDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'ui-preferences.json'),
    JSON.stringify({ downloadAsk: false, downloadDir }, null, 2),
    'utf8',
  );

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
  let downloadsPage = null;
  let httpServer = null;

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

    /* ---------- B1. 首屏可识别（起始页） ---------- */
    // 空白页 = 首屏大黑屏。这里断言首屏必须是本地起始页，且有品牌、搜索框、常用入口。
    const startTarget = await waitTarget((t) => t.url.endsWith('/start.html'), 20000);
    const firstState = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || [])[0] || {};
      return { url: tab.url || '', title: tab.title || '', count: (snap.tabs || []).length };
    })()`);
    check(
      '首屏是本地起始页而不是空白页（B1）',
      !!startTarget && String(firstState && firstState.url).endsWith('/start.html'),
      JSON.stringify({ target: !!startTarget, state: firstState }),
    );

    if (startTarget) {
      const startPage = await new Cdp(startTarget.webSocketDebuggerUrl).connect();
      await startPage.send('Runtime.enable', {});
      let startDom = null;
      for (let i = 0; i < 40; i += 1) {
        startDom = await startPage
          .eval(`(() => {
            const title = document.querySelector('.start-title');
            const input = document.getElementById('start-input');
            const tiles = document.querySelectorAll('.start-tile').length;
            if (!title || !input || tiles < 1) return null;
            return {
              title: title.textContent.trim(),
              placeholder: input.placeholder || '',
              tiles,
              meta: (document.getElementById('start-freq-meta') || {}).textContent || '',
              emptyHidden: (document.getElementById('start-empty') || {}).hidden === true,
              actions: Array.from(document.querySelectorAll('.start-action')).map((b) => b.textContent.trim()),
              focusId: (document.activeElement && document.activeElement.id) || '',
            };
          })()`)
          .catch(() => null);
        if (startDom && startDom.tiles >= 3) break;
        await sleep(250);
      }
      check(
        '起始页有品牌名、搜索框与常用入口（B1）',
        !!startDom &&
          startDom.title === 'Nyx' &&
          startDom.placeholder.includes('搜索或输入网址') &&
          startDom.tiles >= 3 &&
          startDom.emptyHidden === true &&
          /默认推荐|基于书签与最近浏览/.test(String(startDom.meta || '')) &&
          startDom.actions.includes('下载中心'),
        JSON.stringify(startDom),
      );

      // 在起始页提交一个网址：应当开出普通标签，并把起始页那个标签收掉
      await startPage.eval(`(() => {
        const input = document.getElementById('start-input');
        input.value = 'example.com';
        document.getElementById('start-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
      })()`);
      let afterOpen = null;
      for (let i = 0; i < 20; i += 1) {
        await sleep(300);
        afterOpen = await shell.eval(`(async () => {
          const snap = await window.nyx.getState();
          const tabs = snap.tabs || [];
          return {
            urls: tabs.map((t) => t.url),
            active: (tabs.find((t) => t.active) || {}).url || '',
            startLeft: tabs.filter((t) => String(t.url || '').endsWith('/start.html')).length,
          };
        })()`);
        if (String(afterOpen && afterOpen.active).includes('example.com')) break;
      }
      check(
        '起始页输入网址后开出普通标签并收掉起始页（B1）',
        !!afterOpen && String(afterOpen.active).includes('example.com') && afterOpen.startLeft === 0,
        JSON.stringify(afterOpen),
      );
      startPage.close();

      // 起始页是本地应用页（will-navigate 只放行 file://），在它身上直接 loadURL
      // 会被静默拦掉。跳转必须另开一个普通标签，应用页自己留着。
      await shell.eval(`window.nyx.createTab('')`);
      await sleep(900);
      const fromStart = await shell.eval(`(async () => {
        const res = await window.nyx.navigate('example.org');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const snap = await window.nyx.getState();
        const tabs = snap.tabs || [];
        return {
          ok: !!(res && res.ok !== false),
          active: (tabs.find((item) => item.active) || {}).url || '',
          startLeft: tabs.filter((item) => String(item.url || '').endsWith('/start.html')).length,
        };
      })()`);
      check(
        '起始页里跳转网址会另开标签，不会被本地页拦成静默失败（B1）',
        !!fromStart && fromStart.ok && String(fromStart.active).includes('example.org') && fromStart.startLeft >= 1,
        JSON.stringify(fromStart),
      );

      // 这次导航会写进历史，后面「按站点聚合 / 明细行数」断言依赖种子数据，先把它清掉
      await shell.eval(`(async () => {
        const list = await window.nyx.historyList();
        const items = (list && list.items) || [];
        for (const item of items) {
          if (/example\\.(com|org)/.test(String(item.url || '')) && Date.now() - Number(item.visitedAt) < 120000) {
            await window.nyx.historyRemove({ id: item.id });
          }
        }
        // 顺手把刚才为验证拦截至造出来的起始页标签关掉，避免影响后面的标签数断言
        const snap = await window.nyx.getState();
        for (const item of snap.tabs || []) {
          if (String(item.url || '').endsWith('/start.html')) await window.nyx.closeTab(item.id);
        }
        return true;
      })()`);
    }

    /* ---------- B2. 隐私开关：可见文字 / 状态色 / 悬停说明 ---------- */
    const modeUi = await shell.eval(`(() => {
      const group = document.getElementById('mode-group');
      const toggle = document.getElementById('mode-toggle');
      const label = document.getElementById('mode-label');
      if (!group || !toggle || !label) return null;
      const cs = getComputedStyle(label);
      const normalBorder = getComputedStyle(group).borderTopColor;
      const normalBg = getComputedStyle(group).backgroundColor;
      // 只切样式类验证"隐私模式的状态色"，不动真实模式（切模式需要可用代理，测试环境没有）
      document.body.classList.add('private-mode');
      const privateBorder = getComputedStyle(group).borderTopColor;
      const privateBg = getComputedStyle(group).backgroundColor;
      const privateLabel = getComputedStyle(label).color;
      document.body.classList.remove('private-mode');
      return {
        label: label.textContent.trim(),
        labelColor: cs.color,
        labelWeight: Number(cs.fontWeight) || 400,
        normalBorder,
        normalBg,
        privateBorder,
        privateBg,
        privateLabel,
        checked: toggle.getAttribute('aria-checked'),
        title: toggle.title || '',
        ariaLabel: toggle.getAttribute('aria-label') || '',
        normal: window.describeModeSwitch('normal'),
        priv: window.describeModeSwitch('private'),
      };
    })()`);
    check(
      '隐私开关有可见文字，且开关状态有颜色区分（B2）',
      !!modeUi &&
        modeUi.label === '普通模式' &&
        modeUi.labelColor !== 'rgba(0, 0, 0, 0)' &&
        modeUi.privateBorder !== modeUi.normalBorder &&
        modeUi.privateBg !== modeUi.normalBg &&
        modeUi.privateLabel !== modeUi.labelColor,
      modeUi && JSON.stringify({
        label: modeUi.label,
        color: modeUi.labelColor,
        normalBorder: modeUi.normalBorder,
        privateBorder: modeUi.privateBorder,
        privateLabel: modeUi.privateLabel,
      }),
    );
    check(
      '隐私开关的悬停说明写清了禁历史/禁缓存/走代理（B2）',
      !!modeUi &&
        /历史/.test(modeUi.normal.hint) &&
        /缓存/.test(modeUi.normal.hint) &&
        /代理/.test(modeUi.normal.hint) &&
        /历史/.test(modeUi.priv.hint) &&
        /缓存/.test(modeUi.priv.hint) &&
        /代理/.test(modeUi.priv.hint) &&
        modeUi.title === modeUi.normal.hint,
      modeUi && JSON.stringify({ title: modeUi.title, privHint: modeUi.priv.hint }),
    );
    check(
      '隐私开关有 aria-checked 与可读的无障碍标签（B2）',
      !!modeUi &&
        modeUi.checked === 'false' &&
        modeUi.priv.label === '全隐私模式' &&
        /已开启/.test(modeUi.priv.ariaLabel) &&
        /已关闭/.test(modeUi.ariaLabel) &&
        /历史/.test(modeUi.ariaLabel),
      modeUi && JSON.stringify({ checked: modeUi.checked, ariaLabel: modeUi.ariaLabel }),
    );

    /* ---------- B3. 隐私模式的出站方式：默认代理 / 显式真实 IP / 风险确认 ---------- */
    const linkDefault = await shell.eval('window.nyx.privacyLink()');
    const directOpt =
      linkDefault && Array.isArray(linkDefault.options)
        ? linkDefault.options.find((item) => item && item.value === 'direct')
        : null;

    check(
      '隐私模式默认经代理，并给出选择「真实 IP」会失去哪些保护（B3）',
      !!linkDefault &&
        linkDefault.ok === true &&
        linkDefault.link === 'proxy' &&
        !!directOpt &&
        Array.isArray(directOpt.lost) &&
        directOpt.lost.length >= 3 &&
        directOpt.lost.some((line) => /真实公网 IP/.test(line)),
      linkDefault && JSON.stringify({ link: linkDefault.link, lost: directOpt && directOpt.lost }),
    );

    // 没有风险确认就不许改成直连——这是"用户显式选择"的唯一凭据
    const noAck = await shell.eval("window.nyx.privacyLinkSet({ link: 'direct' })");
    check(
      '未勾选风险确认时，改成「真实 IP」会被拒绝并给出中文原因（B3）',
      !!noAck &&
        noAck.ok === false &&
        /勾选/.test(noAck.error || '') &&
        noAck.link === 'proxy',
      JSON.stringify(noAck),
    );

    const withAck = await shell.eval("window.nyx.privacyLinkSet({ link: 'direct', ack: true })");
    const afterAck = await shell.eval('window.nyx.privacyLink()');
    check(
      '勾选确认后能记住「真实 IP」，且非法取值被拒（B3）',
      !!withAck &&
        withAck.ok === true &&
        withAck.link === 'direct' &&
        !!afterAck &&
        afterAck.link === 'direct',
      JSON.stringify({ withAck, afterAck: afterAck && afterAck.link }),
    );

    const badLink = await shell.eval("window.nyx.privacyLinkSet({ link: 'open-bar' })");
    const backToProxy = await shell.eval("window.nyx.privacyLinkSet({ link: 'proxy' })");
    check(
      '出站方式的取值被白名单校验，且能改回经代理（B3）',
      !!backToProxy &&
        backToProxy.ok === true &&
        backToProxy.link === 'proxy' &&
        !!badLink &&
        badLink.link === 'proxy',
      JSON.stringify({ badLink, backToProxy }),
    );

    const linkBadgePure = await shell.eval(`(() => {
      const real = window.describeLinkBadge('private', 'direct');
      const proxied = window.describeLinkBadge('private', 'proxy');
      const normalDirect = window.describeLinkBadge('normal', 'direct');
      return { real, proxied, normalDirect };
    })()`);
    check(
      '隐私模式直连时徽标明确写「真实 IP」且带危险色类（B3）',
      !!linkBadgePure &&
        linkBadgePure.real.text === '真实 IP' &&
        linkBadgePure.real.cls === 'link-real-ip' &&
        /真实公网 IP|真实 IP/.test(linkBadgePure.real.title) &&
        linkBadgePure.proxied.text === '代理' &&
        linkBadgePure.normalDirect.text === '直连',
      JSON.stringify(linkBadgePure),
    );

    // 静态守卫：隐私分区直连必须走 allowRealIp 显式放行，且这条路径要留痕
    const sessionsSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sessions.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check(
      '代码层：隐私分区直连只在 allowRealIp 下放行，并写诊断与模式事件（B3）',
      /allowRealIp/.test(sessionsSrc) &&
        /隐私模式必须经代理/.test(sessionsSrc) &&
        /PRIVACY_REAL_IP_ENTERED/.test(mainSrc) &&
        /PRIVACY_REAL_IP/.test(mainSrc),
      '静态检查 sessions.js / main.js',
    );

    // 后面几条用例假设当前是一个「不可收藏」的空白页标签（历史行为），这里显式造出来
    await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      if (!(snap.tabs || []).length) await window.nyx.createTab('about:blank');
      else await window.nyx.navigate('about:blank');
      return true;
    })()`);
    await sleep(600);


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
        // 用 >= 3 而不是 == 3：本轮前面若多写了一条 example.com 历史（例如起始页那次跳转
        // 清理时机差一拍），明细会变成 4 条——那不是缺陷，展开/收起本身仍然是对的。
        siteView.detailRows >= 3 &&
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
    // B4+B5（v1.17.0）：设置从工具栏齿轮进入，且必须是主窗口里的标签页——
    // 以前是独立弹窗，改个配置要来回切窗口，齿轮和菜单项还能各开一份。
    const gearOpen = await shell.eval(`(async () => {
      const btn = document.getElementById('btn-proxy');
      if (!btn) return { missing: true };
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      const snap = await window.nyx.getState();
      const mine = (snap.tabs || []).filter((t) => String(t.url || '').includes('/settings.html'));
      return {
        clicked: true,
        count: mine.length,
        active: !!(mine[0] && mine[0].active),
        gears: document.querySelectorAll('#btn-proxy').length,
      };
    })()`);
    check(
      '「设置」是主窗口里的标签页而不是独立弹窗，且只在齿轮一处入口（v1.17.0）',
      !!gearOpen && gearOpen.clicked === true && gearOpen.count === 1 && gearOpen.active === true && gearOpen.gears === 1,
      JSON.stringify(gearOpen),
    );

    const settingsTarget = await waitTarget((t) => t.url.endsWith('/settings.html'), 20000);
    check('设置页标签出现', !!settingsTarget, settingsTarget && settingsTarget.url);

    // 再点一次设置（菜单项 / 错误页「打开诊断」都走同一条路）只能切回去，不能叠出第二个标签
    const reopen = await shell.eval(`(async () => {
      const before = (await window.nyx.getState()).tabs.length;
      const res = await window.nyx.openSettings();
      await new Promise((r) => setTimeout(r, 400));
      const snap = await window.nyx.getState();
      const mine = (snap.tabs || []).filter((t) => String(t.url || '').includes('/settings.html'));
      return { before, reused: !!(res && res.reused), after: snap.tabs.length, mine: mine.length };
    })()`);
    check(
      '重复打开设置只切回同一个标签，不会叠出第二个（v1.17.0）',
      !!reopen && reopen.reused === true && reopen.after === reopen.before && reopen.mine === 1,
      JSON.stringify(reopen),
    );

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

    // F1b：外观 →「图形性能」（A5）：确认默认核显优先，切换后如实说"要重启才生效"
    const gpuSetting = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const guard = (p, ms) => Promise.race([
        p,
        new Promise((r) => setTimeout(() => r({ timeout: true }), ms)),
      ]);
      let step = 'boot';
      try {
        document.querySelector('.nav-item[data-sec="appearance"]').click();
        await wait(700);
        step = 'query';
        const lowPower = document.getElementById('gpu-policy-low-power');
        const high = document.getElementById('gpu-policy-high-performance');
        const auto = document.getElementById('gpu-policy-auto');
        const badge = () => (document.getElementById('gpu-policy-badge') || {}).textContent || '';
        const hint = () => (document.getElementById('gpu-policy-hint') || {}).textContent || '';
        const adapter = (document.getElementById('gpu-adapter-line') || {}).textContent || '';
        const restartBtn = document.getElementById('btn-gpu-restart');
        if (!lowPower || !high || !auto) return { missing: true };
        step = 'first-read';
        const first = await guard(window.nyx.gpuPolicy(), 4000);
        step = 'initial';
        const initial = {
          lowPower: lowPower.checked,
          high: high.checked,
          auto: auto.checked,
          badge: badge(),
          hint: hint(),
          adapter,
          restartHidden: restartBtn ? restartBtn.hidden : null,
          policy: first && first.policy,
          bootPolicy: first && first.bootPolicy,
          firstTimeout: !!(first && first.timeout),
          options: first && Array.isArray(first.options) ? first.options.length : 0,
        };
        // 切成独显优先：必须保存成功，并明确提示"下次启动生效"
        step = 'switch-high';
        high.checked = true;
        high.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
        const afterSwitch = {
          badge: badge(),
          hint: hint(),
          restartHidden: restartBtn ? restartBtn.hidden : null,
          read: await guard(window.nyx.gpuPolicy(), 4000),
        };
        // 改回核显优先，避免影响其它用例与本地真实配置
        step = 'restore';
        lowPower.checked = true;
        lowPower.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(900);
        const afterRestore = { read: await guard(window.nyx.gpuPolicy(), 4000), hint: hint() };
        return { initial, afterSwitch, afterRestore };
      } catch (err) {
        return { failedAt: step, error: String((err && err.message) || err) };
      }
    })()`);
    check(
      '外观分区有「图形性能」卡片且默认是核显优先（A5）',
      !!gpuSetting &&
        !gpuSetting.missing &&
        !gpuSetting.failedAt &&
        gpuSetting.initial.lowPower === true &&
        gpuSetting.initial.high === false &&
        gpuSetting.initial.auto === false &&
        gpuSetting.initial.policy === 'low-power' &&
        gpuSetting.initial.bootPolicy === 'low-power' &&
        gpuSetting.initial.options === 3 &&
        gpuSetting.initial.firstTimeout === false &&
        String(gpuSetting.initial.badge).includes('核显') &&
        String(gpuSetting.initial.adapter).startsWith('当前适配器：') &&
        String(gpuSetting.initial.hint).length > 10,
      JSON.stringify(gpuSetting && gpuSetting.initial),
    );
    check(
      '切到独显优先后如实提示"重启才生效"，并可改回核显优先（A5）',
      !!gpuSetting &&
        !gpuSetting.missing &&
        !gpuSetting.failedAt &&
        gpuSetting.afterSwitch.read &&
        gpuSetting.afterSwitch.read.policy === 'high-performance' &&
        gpuSetting.afterSwitch.read.restartRequired === true &&
        String(gpuSetting.afterSwitch.badge).includes('独显') &&
        String(gpuSetting.afterSwitch.hint).includes('重启') &&
        gpuSetting.afterSwitch.restartHidden === false &&
        gpuSetting.afterRestore.read &&
        gpuSetting.afterRestore.read.policy === 'low-power' &&
        gpuSetting.afterRestore.read.restartRequired === false,
      JSON.stringify(gpuSetting && { after: gpuSetting.afterSwitch, restored: gpuSetting.afterRestore }),
    );

    // F1c：关于 →「安全基线」（C2）：声明版本 vs 机器上跑的版本要摆在一起，
    // 且公告入口只认白名单 key（渲染进程传不进任意 URL，否则就是个开放跳转）。
    const baselinePanel = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const byId = (id) => document.getElementById(id);
      const nav = document.querySelector('.nav-item[data-sec="about"]');
      if (!nav) return { missingNav: true };
      nav.click();
      await wait(500);
      await wait(400);
      const badge = byId('security-baseline-badge');
      const grid = byId('security-baseline-grid');
      const summary = byId('security-baseline-summary');
      const rows = grid ? Array.from(grid.children).map((row) => row.textContent.trim()) : [];
      const badKey = await window.nyx.openSecurityAdvisory({ key: 'evil.example' });
      const goodKeys = Array.from(document.querySelectorAll('[data-advisory]')).map((b) => b.dataset.advisory);
      return {
        badge: badge ? badge.textContent.trim() : '',
        badgeClass: badge ? badge.className : '',
        rows,
        summary: summary ? summary.textContent.trim() : '',
        badKey,
        goodKeys,
      };
    })()`);

    check(
      '关于分区「安全基线」列出三件套并显示是否一致（C2）',
      !!baselinePanel &&
        !baselinePanel.missingNav &&
        baselinePanel.rows.length === 3 &&
        baselinePanel.rows.some((line) => line.includes('Electron')) &&
        baselinePanel.rows.some((line) => line.includes('Chromium')) &&
        baselinePanel.rows.some((line) => line.includes('Node')) &&
        baselinePanel.badge.length > 0 &&
        /一致|差异/.test(baselinePanel.badge) &&
        baselinePanel.summary.includes('安全基线'),
      JSON.stringify({ badge: baselinePanel && baselinePanel.badge, rows: baselinePanel && baselinePanel.rows, summary: baselinePanel && baselinePanel.summary }),
    );

    check(
      '安全公告入口只认白名单 key，传别的 key 会被拒绝（C2）',
      !!baselinePanel &&
        baselinePanel.goodKeys.length === 3 &&
        baselinePanel.badKey &&
        baselinePanel.badKey.ok === false &&
        String(baselinePanel.badKey.error || '').includes('未知的公告入口'),
      JSON.stringify({ goodKeys: baselinePanel && baselinePanel.goodKeys, badKey: baselinePanel && baselinePanel.badKey }),
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

    /* ---------- G. 清单 C1：诊断页（状态可见 / 失败留痕 / 导出诊断包 / 脱敏） ---------- */

    // G1：诊断分区存在且状态字段齐全（清单要求：版本、Electron+Chromium、连接方式、代理状态、GPU 策略）
    const diagStatus = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const nav = document.querySelector('.nav-item[data-sec="diagnostics"]');
      if (!nav) return { missingNav: true };
      nav.click();
      await wait(900);
      const panel = document.querySelector('.sec-panel[data-sec="diagnostics"]');
      const grid = document.getElementById('diag-grid');
      const keys = grid ? Array.from(grid.querySelectorAll('.kv-item .k')).map((n) => n.textContent) : [];
      const values = grid ? Array.from(grid.querySelectorAll('.kv-item .v')).map((n) => n.textContent) : [];
      return {
        panelVisible: !!panel && panel.classList.contains('active'),
        keys,
        values,
        badge: (document.getElementById('diag-badge') || {}).textContent || '',
        count: (document.getElementById('diag-count') || {}).textContent || '',
        statusTitle: (document.getElementById('statusbar') || {}).textContent || '',
      };
    })()`);
    check(
      '设置新增「诊断」分区并显示版本/模式/连接方式/代理/GPU（C1）',
      !!diagStatus &&
        diagStatus.panelVisible === true &&
        ['应用版本', 'Electron', 'Chromium', 'Node', '运行模式', '连接方式', '代理', 'GPU 策略', '平台', '日志文件'].every(
          (key) => (diagStatus.keys || []).includes(key),
        ) &&
        (diagStatus.values || []).filter((v) => v && v !== '未知').length >= 6,
      JSON.stringify(diagStatus),
    );

    // G2：真实加载失败必须留痕（打开一个必然连不上的地址，诊断记录里要出现 LOAD_FAILED + 中文原因）
    const failUrl = 'http://127.0.0.1:65530/nyx-diag-probe?token=SECRET123';
    await shell.eval(`window.nyx.createTab(${JSON.stringify(failUrl)})`);
    await sleep(1800);
    const diagList = await settings.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('btn-diag-refresh').click();
      await wait(900);
      const res = await window.nyx.listDiagnostics(20);
      const items = (res && res.items) || [];
      const hit = items.find((it) => it.code === 'LOAD_FAILED') || null;
      return {
        total: res && res.total,
        codes: items.map((it) => it.code),
        hit,
        rowCount: document.querySelectorAll('#diag-list .diag-item').length,
        raw: JSON.stringify(items),
      };
    })()`);
    check(
      '页面加载失败会写入诊断记录（C1）',
      !!diagList &&
        !!diagList.hit &&
        String(diagList.hit.level) === 'error' &&
        /拒绝|解析|超时|不可达|连接/.test(String(diagList.hit.message)) &&
        diagList.rowCount > 0,
      JSON.stringify({ total: diagList && diagList.total, codes: diagList && diagList.codes, hit: diagList && diagList.hit }),
    );

    // G3：导出诊断包（写出真实 ZIP，文件头必须是 PK\x03\x04）
    const zipPath = path.join(workDir, `diag-${Date.now()}.zip`);
    const diagExport = await settings.eval(`(async () => window.nyx.exportDiagnostics({ path: ${JSON.stringify(zipPath)} }))()`);
    const zipOk = (() => {
      try {
        const buf = fs.readFileSync(zipPath);
        return { bytes: buf.length, magic: buf.slice(0, 4).toString('hex') };
      } catch (err) {
        return { bytes: 0, magic: '', error: err.message };
      }
    })();
    check(
      '诊断包可导出为合法 ZIP（C1）',
      !!diagExport && diagExport.ok === true && diagExport.entries >= 3 && zipOk.magic === '504b0304' && zipOk.bytes > 0,
      JSON.stringify({ diagExport, zipOk }),
    );

    // G4：导出内容必须脱敏（token=SECRET123 不能原样出现）
    const zipText = (() => {
      try {
        return fs.readFileSync(zipPath).toString('utf8');
      } catch {
        return '';
      }
    })();
    const listRaw = String((diagList && diagList.raw) || '');
    check(
      '诊断记录与诊断包已脱敏（C1）',
      !listRaw.includes('SECRET123') && !zipText.includes('SECRET123'),
      JSON.stringify({ inList: listRaw.includes('SECRET123'), inZip: zipText.includes('SECRET123') }),
    );

    /* ---------- G5/G6. 清单 C3：外壳防护现值 + 注入演示 ---------- */

    // G5：诊断分区要能看到每个窗口角色的三个开关、本地页 CSP、暴露面分类，并且一致
    const swState = await settings.eval(`(async () => {
      const nav = document.querySelector('.nav-item[data-sec="diagnostics"]');
      if (nav) nav.click();
      const refresh = document.getElementById('btn-security-switches-refresh');
      if (refresh) refresh.click();
      // 等卡片把数据填出来（角色块出现且徽标有字）
      for (let i = 0; i < 40; i += 1) {
        const badge = document.getElementById('security-switches-badge');
        const roles = document.querySelectorAll('#security-switches-roles .sw-role');
        if (roles.length >= 3 && badge && badge.textContent.trim()) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const roles = Array.from(document.querySelectorAll('#security-switches-roles .sw-role'));
      const csp = Array.from(document.querySelectorAll('#security-switches-csp .sw-csp-item'));
      return {
        badge: ((document.getElementById('security-switches-badge') || {}).textContent || '').trim(),
        roleCount: roles.length,
        roleNames: roles.map((n) => ((n.querySelector('.sw-role-name') || {}).textContent || '').trim()),
        roleBad: roles.filter((n) => n.classList.contains('is-bad')).length,
        cspCount: csp.length,
        cspBad: csp.filter((n) => n.classList.contains('is-bad')).length,
        summary: ((document.getElementById('security-switches-summary') || {}).textContent || '').trim(),
      };
    })()`);
    check(
      '诊断分区能看到每个窗口角色的隔离/Node/沙箱现值，且都符合声明（C3）',
      !!swState &&
        swState.badge === '全部一致' &&
        swState.roleCount >= 3 &&
        swState.roleBad === 0 &&
        swState.cspCount >= 5 &&
        swState.cspBad === 0,
      JSON.stringify(swState),
    );

    // G6：点「试一次注入」必须真的跑一遍，并把结果如实写出来（挡住 / 没挡住）
    await settings.eval("(() => { const b = document.getElementById('btn-security-probe'); if (b) b.click(); })()");
    let probeOut = null;
    for (let i = 0; i < 40; i += 1) {
      probeOut = await settings.eval(`(() => {
        const out = document.getElementById('security-probe-out');
        if (!out || out.hidden) return null;
        return { text: out.textContent || '', ok: out.classList.contains('is-ok'), bad: out.classList.contains('is-bad') };
      })()`);
      if (probeOut && probeOut.text && /挡住|没有回传|失败/.test(probeOut.text)) break;
      await sleep(250);
    }
    check(
      '注入演示真的跑了一遍，并如实报告有没有被挡住（C3）',
      !!probeOut && probeOut.ok === true && /全部被挡住/.test(probeOut.text) && /冻结/.test(probeOut.text),
      JSON.stringify(probeOut && { ok: probeOut.ok, bad: probeOut.bad, text: String(probeOut.text).slice(0, 200) }),
    );

    /* ---------- H. 清单 A4：加载失败页（错误码 / 中文原因 / 重试 / 诊断 / 复制） ---------- */

    // G2 已经打开了一个必然连不上的地址，这里直接复用它检查失败页
    const failPage = await shell.eval(`(() => {
      const box = document.getElementById('page-error');
      return {
        visible: !!box && !box.hidden,
        code: (document.getElementById('pe-code') || {}).textContent || '',
        title: (document.getElementById('pe-title') || {}).textContent || '',
        reason: (document.getElementById('pe-reason') || {}).textContent || '',
        url: (document.getElementById('pe-url') || {}).textContent || '',
        mode: (document.getElementById('pe-mode') || {}).textContent || '',
        hints: Array.from(document.querySelectorAll('#pe-hints li')).map((n) => n.textContent),
      };
    })()`);
    check(
      '连接失败时主界面显示失败页（错误码 + 中文原因 + 可执行建议）（A4）',
      !!failPage &&
        failPage.visible === true &&
        /^ERR_/.test(failPage.code) &&
        /[一-龥]/.test(failPage.reason) &&
        failPage.url.includes('65530') &&
        failPage.mode === '普通模式' &&
        failPage.hints.length > 0,
      JSON.stringify(failPage),
    );

    // 失败信息必须随状态快照一起下发：视图已被隐藏，外壳只能靠快照知道"该显示失败页"
    const failState = await shell.eval(`(async () => {
      const s = await window.nyx.getState();
      const active = (s.tabs || []).find((t) => t.active) || null;
      return { tabCount: (s.tabs || []).length, active: active ? { title: active.title, url: active.url, loadError: active.loadError } : null };
    })()`);
    check(
      '失败信息随状态快照下发（视图已隐藏，外壳据此渲染）（A4）',
      !!failState &&
        !!failState.active &&
        !!failState.active.loadError &&
        failState.active.loadError.code === failPage.code &&
        // errorCode 是 Chromium 的负数错误码（-102 = ERR_CONNECTION_REFUSED），
        // 必须一并下发：用户报障时凭它才能精确定位，光有字符串描述不够。
        Number.isFinite(Number(failState.active.loadError.errorCode)) &&
        Number(failState.active.loadError.errorCode) < 0,
      JSON.stringify(failState && failState.active),
    );

    // 本地起一个可控服务器：先返回 404（"服务器有响应但状态码是错误"），
    // 再切成 200 验证「重试」真能恢复页面——重试按钮不能只是装饰。
    let httpMode = 404;
    const http = require('node:http');
    httpServer = http.createServer((req, res) => {
      // A1 用例专用：给一个 256KB 的附件下载响应（Content-Disposition: attachment），
      // 让 Chromium 走真正的下载链路，而不是当页面渲染。
      if (String(req.url || '').startsWith('/a1-probe.bin')) {
        const body = Buffer.alloc(256 * 1024, 0x4e);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          'Content-Disposition': 'attachment; filename="a1-probe.bin"',
        });
        res.end(body);
        return;
      }
      res.writeHead(httpMode, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        httpMode === 200
          ? '<!doctype html><meta charset="utf-8"><title>恢复了</title><h1 id="ok">恢复成功</h1>'
          : '<!doctype html><meta charset="utf-8"><title>Not Found</title><h1>Not Found</h1>',
      );
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const httpPort = httpServer.address().port;

    await shell.eval(`window.nyx.createTab(${JSON.stringify(`http://127.0.0.1:${httpPort}/missing`)} )`);
    await sleep(1600);
    const httpErr = await shell.eval(`(() => ({
      visible: !document.getElementById('page-error').hidden,
      code: (document.getElementById('pe-code') || {}).textContent || '',
      title: (document.getElementById('pe-title') || {}).textContent || '',
      reason: (document.getElementById('pe-reason') || {}).textContent || '',
      hints: document.querySelectorAll('#pe-hints li').length,
    }))()`);
    check(
      '服务器返回 404 时显示失败页并把状态码翻成中文原因（A4）',
      !!httpErr && httpErr.visible === true && httpErr.code === 'HTTP 404' && httpErr.title === '页面不存在' && httpErr.hints > 0,
      JSON.stringify(httpErr),
    );

    // 站点恢复后点「重试」：页面应正常加载、失败页收起
    httpMode = 200;
    await shell.eval("document.getElementById('pe-retry').click()");
    await sleep(2000);
    const afterRetry = await shell.eval(`(async () => {
      const s = await window.nyx.getState();
      const active = (s.tabs || []).find((t) => t.active);
      return {
        visible: !document.getElementById('page-error').hidden,
        loadError: active ? active.loadError : 'no-active',
        url: active ? active.url : '',
      };
    })()`);
    check(
      '失败页「重试」能恢复页面并自动收起失败页（A4）',
      !!afterRetry && afterRetry.visible === false && afterRetry.loadError === null && String(afterRetry.url).includes(String(httpPort)),
      JSON.stringify(afterRetry),
    );

    // 复制详情 / 打开诊断：两个按钮都必须有实际效果，不能点完毫无反应
    httpMode = 404;
    await shell.eval(`window.nyx.createTab(${JSON.stringify(`http://127.0.0.1:${httpPort}/missing-again`)} )`);
    await sleep(1600);
    await shell.eval("document.getElementById('pe-copy').click()");
    await sleep(700);
    const copyFoot = await shell.eval("document.getElementById('pe-foot').textContent || ''");
    // 剪贴板是进程外状态，而且 Windows 上「写进去」与「别的进程能读到」之间有几十到几百
    // 毫秒的空档（Electron 用延迟渲染提交剪贴板时尤其明显）。这里不靠 JS 层反复 spawn
    // PowerShell（每次启动 ~300ms，8 次也未必够），而是让 PowerShell 自己在 3 秒内轮询，
    // 命中就返回——断言仍然是"真实剪贴板内容里要有端口与 HTTP 404"，没有放宽。
    const readClipboard = (needle) => {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        `for($i=0;$i -lt 30;$i++){ $t=Get-Clipboard; if($t -and $t -like '*${needle}*'){ $t; break }; Start-Sleep -Milliseconds 100 }`,
      ].join('; ');
      try {
        return require('node:child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          timeout: 12000,
        });
      } catch {
        return '';
      }
    };
    let clip = readClipboard(httpPort);
    if (!clip.includes(String(httpPort))) {
      await sleep(500);
      clip = readClipboard(httpPort);
    }
    // 剪贴板在 Windows 上随时可能被别的进程占着（远程桌面剪贴板重定向、锁屏后
    // 会话降权都会让 Get-Clipboard 抛 CLIPBRD_E_CANT_OPEN）。这里不追求"一定能读到"，
    // 而是校验**界面说的与实际情况一致**：说成功，剪贴板里就必须真有那两样东西；
    // 说失败，就必须是剪贴板不可用而不是别的借口。
    const copyProbe = await shell.eval(`(async () => {
      const detail = 'Nyx 加载失败：探针\\n地址：http://127.0.0.1:${httpPort}/nyx-copy-probe\\n错误码：HTTP 404';
      const res = await window.nyx.errorCopyDetail(detail);
      return { res, expected: detail };
    })()`);
    const readback = (copyProbe && copyProbe.res && copyProbe.res.readback) || '';
    const wroteContent =
      (clip.includes(String(httpPort)) && clip.includes('HTTP 404')) ||
      (readback.includes(String(httpPort)) && readback.includes('HTTP 404'));
    // 注意：`#pe-foot` 是**易失**的——任何一次状态推送都会让 renderPageError() 重写它
    // （实测 700ms 内就会被「这次失败已记入诊断日志」盖掉）。所以判断"复制到底成没成"
    // 不能读这句会过期的界面文字，要读 IPC 的真实返回：说成功就必须真写进去了，
    // 说失败就必须是剪贴板不可用。界面文字只用来确认"点了有反应、没报错"。
    const copyIpc = copyProbe && copyProbe.res;
    const ipcClaimedSuccess = !!(copyIpc && copyIpc.ok === true);
    const ipcClaimedFailure = !!(copyIpc && copyIpc.ok === false);
    const footOk =
      /已复制|复制失败|已记入诊断日志/.test(String(copyFoot)) ||
      // 重试中的瞬时文案也算"点它有反应"
      /正在重试|重试没/.test(String(copyFoot));
    check(
      '失败页「复制详情」的结果与真实剪贴板一致（A4）',
      footOk &&
        ((ipcClaimedSuccess && wroteContent) ||
          (ipcClaimedFailure && !wroteContent && String((copyIpc && copyIpc.error) || '').includes('剪贴板'))),
      JSON.stringify({
        copyFoot,
        clipHead: clip.slice(0, 80),
        readbackHead: readback.slice(0, 80),
        crossProcess: clip.includes(String(httpPort)),
        wroteContent,
        copyIpc: copyIpc ? { ok: copyIpc.ok, error: copyIpc.error || '' } : null,
      }),
    );

    await shell.eval("document.getElementById('pe-diagnostics').click()");
    await sleep(1400);
    const jumped = await settings.eval(`(() => {
      const nav = document.querySelector('.nav-item[data-sec="diagnostics"]');
      const panel = document.querySelector('.sec-panel[data-sec="diagnostics"]');
      return { nav: !!nav && nav.classList.contains('active'), panel: !!panel && panel.classList.contains('active') };
    })()`);
    check(
      '失败页「打开诊断」让设置窗口直接落到诊断分区（A4）',
      !!jumped && jumped.nav === true && jumped.panel === true,
      JSON.stringify(jumped),
    );

    /* ---------- I. 清单 A2：隐私模式的链路告警必须真的能被用户看见 ----------
       A2 的观感是"全隐私模式自己变直连了"。代码里其实没有隐私→直连的路径
       （sessions.setLink 硬拒绝），真正的问题是：隐私模式下代理挂掉时，主进程
       只在控制台打一行日志，界面上什么都不会出现——用户只能靠"页面打不开"
       去猜。所以这一条断言盯的是"告警能不能渲染出来"：主进程产出的通知
       （level=error / PRIVACY_PROXY_DOWN）必须落成可见的 toast，并且文案里
       要明说不降级，而不是一句"代理不可用"。 */
    const privacyNotice = await shell.eval(`(() => {
      window.showNotice({
        level: 'error',
        code: 'PRIVACY_PROXY_DOWN',
        title: '代理已断开，隐私模式未降级',
        message: '检测到代理 127.0.0.1:7897 不可达（连接被拒绝）。隐私模式不会降级为直连，所以页面暂时打不开。',
      });
      const box = document.querySelector('.notice.notice-error');
      return {
        visible: !!box,
        cls: box ? box.className : '',
        role: box ? box.getAttribute('role') : '',
        title: (document.querySelector('.notice-error .notice-title') || {}).textContent || '',
        body: (document.querySelector('.notice-error .notice-body') || {}).textContent || '',
      };
    })()`);
    check(
      '隐私模式代理断开的告警能在界面上显示，并明说不会降级为直连（A2）',
      !!privacyNotice &&
        privacyNotice.visible === true &&
        privacyNotice.cls.includes('notice-error') &&
        privacyNotice.title.includes('未降级') &&
        privacyNotice.body.includes('不会降级为直连'),
      JSON.stringify(privacyNotice),
    );

    /* ---------- 失败页的视觉与无障碍（v1.17.0 界面重做） ----------

       这一轮把失败页按「简洁、克制、只留一条主路径」重做：语义属性、主次按钮的
       层次差别、键盘焦点环都改成靠样式实现，所以直接读计算样式来断言，
       而不是截图比对（截图比对在 CI 上没有稳定基线）。 */
    const a11y = await shell.eval(`(() => {
      const card = document.querySelector('.page-error-card');
      const retry = document.getElementById('pe-retry');
      const diag = document.getElementById('pe-diagnostics');
      const copy = document.getElementById('pe-copy');
      const hintLabel = document.querySelector('.pe-hint-label');
      const bg = (el) => getComputedStyle(el).backgroundColor;
      return {
        role: card && card.getAttribute('role'),
        labelledby: card && card.getAttribute('aria-labelledby'),
        describedby: card && card.getAttribute('aria-describedby'),
        retryBg: bg(retry),
        diagBg: bg(diag),
        retryWeight: getComputedStyle(retry).fontWeight,
        copyBg: bg(copy),
        copyBorderWidth: getComputedStyle(copy).borderTopWidth,
        hintLabel: hintLabel ? hintLabel.textContent.trim() : '',
      };
    })()`);
    check(
      '失败页带 role=alert 并以标题/原因做无障碍关联（v1.17.0）',
      !!a11y &&
        a11y.role === 'alert' &&
        a11y.labelledby === 'pe-title' &&
        a11y.describedby === 'pe-reason' &&
        a11y.hintLabel === '可以试试',
      JSON.stringify(a11y),
    );

    // 主按钮实心强调色、次按钮描边、复制是纯文字按钮：三者计算样式必须真的不同，
    // 否则「看起来一样」的按钮会让用户在报错时不知道该点哪个
    const distinct =
      !!a11y &&
      a11y.retryBg !== a11y.diagBg &&
      a11y.retryBg !== 'rgba(0, 0, 0, 0)' &&
      Number(a11y.retryWeight) >= 600 &&
      a11y.copyBg === 'rgba(0, 0, 0, 0)' &&
      a11y.copyBorderWidth === '0px';
    check('失败页主按钮/次按钮/文字按钮三者视觉可分（v1.17.0）', distinct, JSON.stringify(a11y));

    // 键盘焦点环：只能用真实按键（Input.dispatchKeyEvent）走到按钮上，
    // 脚本 focus() 不会命中 :focus-visible，测出来的结果是假的。
    // 注意：设置现在也是标签页（B5），上一步「打开诊断」会把焦点带到设置标签，
    // 必须先切回失败页所在的那个标签，否则按键全被设置页吃掉。
    await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const list = (snap && snap.tabs) || [];
      // 要切回的是"那个加载失败、正在显示失败页"的标签，不能随便挑一个普通标签
      const page = list.find((t) => t.loadError) || list.find((t) => !String(t.url || '').includes('/settings.html'));
      if (page) await window.nyx.activateTab(page.id);
      return true;
    })()`);
    await sleep(500);
    // 页面级焦点仿真：设置是标签页之后，切标签会让外壳 webContents 失去窗口级焦点，
    // 真实按键就进不来（activeElement 一直为空）。CDP 的焦点仿真让页面以为自己在前台，
    // 这样 Input.dispatchKeyEvent 才有意义，`:focus-visible` 也才会命中。
    await shell.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await shell.eval('(() => { const el = document.activeElement; if (el && el.blur) el.blur(); return true; })()');
    let tabbedTo = '';
    for (let i = 0; i < 30; i += 1) {
      await shell.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      await shell.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
      tabbedTo = await shell.eval("document.activeElement && document.activeElement.id ? document.activeElement.id : ''");
      if (tabbedTo.startsWith('pe-')) break;
    }
    const focusRing = await shell.eval(`(() => {
      const overlay = document.getElementById('page-error');
      const el = document.getElementById('${'pe-retry'}') || document.activeElement;
      const cs = getComputedStyle(el);
      return {
        active: document.activeElement ? document.activeElement.id : '',
        focusVisible: el.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: cs.outlineColor,
        overlayHidden: !!(overlay && overlay.hidden),
        overlayDisplay: overlay ? getComputedStyle(overlay).display : 'none',
        focusables: document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])').length,
      };
    })()`);
    check(
      '失败页按钮键盘可达且焦点环可见（v1.17.0）',
      !!focusRing &&
        String(focusRing.active).startsWith('pe-') &&
        focusRing.focusVisible === true &&
        focusRing.outlineStyle === 'solid' &&
        parseFloat(focusRing.outlineWidth) >= 2,
      JSON.stringify({ tabbedTo, ...focusRing }),
    );

    /* ---------- 外壳：标签语义 / 键盘切标签 / 地址栏光晕（v1.17.0 界面统一） ----------
       标签原来是纯 div：读屏不知道这是什么，键盘也进不去。这一轮补上
       role=tab/tablist + 游标式 tabindex，并让左右方向键能真正切标签。 */
    const tabA11y = await shell.eval(`(() => {
      const list = document.getElementById('tabs');
      const nodes = Array.from(list.querySelectorAll('.tab'));
      return {
        listRole: list.getAttribute('role'),
        count: nodes.length,
        allRole: nodes.every((n) => n.getAttribute('role') === 'tab'),
        selected: nodes.filter((n) => n.getAttribute('aria-selected') === 'true').length,
        activeIndex: nodes.findIndex((n) => n.classList.contains('active')),
        indexes: nodes.map((n) => n.tabIndex),
      };
    })()`);
    check(
      '标签栏具备 tablist/tab 语义且只有活动标签可 Tab 命中（v1.17.0）',
      !!tabA11y &&
        tabA11y.listRole === 'tablist' &&
        tabA11y.count >= 2 &&
        tabA11y.allRole === true &&
        tabA11y.selected === 1 &&
        tabA11y.indexes[tabA11y.activeIndex] === 0 &&
        tabA11y.indexes.filter((v) => v === -1).length === tabA11y.count - 1,
      JSON.stringify(tabA11y),
    );

    // 真按键走一遍：聚焦活动标签 → 按右方向键 → 应切到下一个标签、焦点跟过去、焦点环可见
    const beforeTab = await shell.eval(`(() => {
      const node = document.querySelector('.tab.active');
      node.focus();
      return { id: node.dataset.tabId };
    })()`);
    await shell.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
    await shell.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' });
    await sleep(900);
    const afterTab = await shell.eval(`(() => {
      const node = document.querySelector('.tab.active');
      const focused = document.activeElement;
      const cs = getComputedStyle(focused);
      return {
        id: node ? node.dataset.tabId : '',
        focusedTag: focused ? focused.className : '',
        focusedId: focused && focused.dataset ? focused.dataset.tabId || '' : '',
        focusVisible: focused && focused.matches ? focused.matches(':focus-visible') : false,
        outlineWidth: cs.outlineWidth,
      };
    })()`);
    check(
      '右方向键能切换标签且焦点跟随并可见（v1.17.0）',
      !!afterTab &&
        afterTab.id &&
        afterTab.id !== (beforeTab && beforeTab.id) &&
        afterTab.focusedId === afterTab.id &&
        afterTab.focusVisible === true &&
        parseFloat(afterTab.outlineWidth) >= 2,
      JSON.stringify({ beforeTab, afterTab }),
    );

    // 地址栏聚焦光晕必须是主题强调色（旧版写死了上一套紫色主题的 rgba）
    const addressGlow = await shell.eval(`(() => {
      const input = document.getElementById('address');
      input.focus();
      const cs = getComputedStyle(input);
      return { boxShadow: cs.boxShadow, borderRadius: cs.borderRadius };
    })()`);
    check(
      '地址栏聚焦光晕使用主题强调色而非旧紫色（v1.17.0）',
      !!addressGlow &&
        String(addressGlow.boxShadow).includes('200, 164, 92') &&
        !String(addressGlow.boxShadow).includes('139, 92, 246'),
      JSON.stringify(addressGlow),
    );

    /* ---------- J. 清单 A1：下载必须真的落盘，并且进度/落点/失败原因看得见 ----------

       实测清单原话是「文件下载这一块儿全都报废了，前台零提示」。根因是
       will-download 里 preventDefault 后再异步 setSavePath（等于取消下载）。
       这一节不看代码，直接让应用下载一个真实文件：
         ① 文件必须真的出现在磁盘上、字节数对得上；
         ② 主进程的下载记账必须把它标成 completed 且带上落点；
         ③ 下载中心窗口必须能把它列出来（名字/状态/落点都在）；
         ④ 工具栏角标在没有进行中/失败项时必须消失，不能一直挂个数字。 */
    // 导航前先把一个"普通网页标签"选中：B5 之后设置也占用一个标签，
    // 若当前停在设置标签，navigate 会被应用页的 will-navigate 拦掉（只允许 file://）。
    const beforeDownload = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const list = (snap && snap.tabs) || [];
      const page = list.find((t) => !String(t.url || '').includes('/settings.html'));
      if (page) {
        await window.nyx.activateTab(page.id);
        return { activated: page.id };
      }
      const created = await window.nyx.createTab('about:blank');
      await new Promise((r) => setTimeout(r, 500));
      return { created: created && created.id };
    })()`);
    await sleep(400);
    await shell.eval(`window.nyx.navigate(${JSON.stringify(`http://127.0.0.1:${httpPort}/a1-probe.bin`)})`);
    const expectedFile = path.join(downloadDir, 'a1-probe.bin');
    let fileAt = 0;
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      try {
        fileAt = fs.statSync(expectedFile).size;
      } catch {
        fileAt = 0;
      }
      if (fileAt >= 256 * 1024) break;
    }
    const dlList = await shell.eval(`window.nyx.listDownloads()`);
    const dlItem = dlList && Array.isArray(dlList.items) ? dlList.items[0] : null;
    check(
      '普通模式下载真的落盘（不再 0 字节、不再静默取消）（A1）',
      fileAt === 256 * 1024 &&
        !!dlItem &&
        dlItem.state === 'completed' &&
        dlItem.error === '' &&
        String(dlItem.savePath) === expectedFile,
      JSON.stringify({ fileAt, item: dlItem && { state: dlItem.state, error: dlItem.error, savePath: dlItem.savePath, total: dlItem.totalBytes } }),
    );

    // 下载中心窗口：必须能把这条记录渲染出来（名字 / 已完成 / 落点）
    await shell.eval('window.nyx.openDownloads()');
    const downloadsTarget = await waitTarget((t) => t.url.endsWith('/downloads.html'), 12000);
    check('下载中心窗口能打开', !!downloadsTarget, downloadsTarget && downloadsTarget.url);
    let dlMetaText = '';
    if (downloadsTarget) {
      downloadsPage = await new Cdp(downloadsTarget.webSocketDebuggerUrl).connect();
      await downloadsPage.send('Runtime.enable', {});
      await sleep(900);
      const shown = await downloadsPage.eval(`(() => {
        const rows = Array.from(document.querySelectorAll('.dl-item'));
        const first = rows[0];
        return {
          rows: rows.length,
          name: first ? (first.querySelector('.dl-name') || {}).textContent : '',
          state: first ? (first.querySelector('.dl-state') || {}).textContent : '',
          meta: first ? (first.querySelector('.dl-meta') || {}).textContent : '',
          summary: (document.getElementById('dl-summary') || {}).textContent || '',
          emptyHidden: document.getElementById('dl-empty').hidden,
        };
      })()`);
      dlMetaText = String(shown && shown.meta ? shown.meta : '');
      check(
        '下载中心列出该记录：文件名/状态/落点都可读（A1）',
        !!shown &&
          shown.rows >= 1 &&
          shown.name === 'a1-probe.bin' &&
          shown.state === '已完成' &&
          String(shown.meta).includes(downloadDir) &&
          shown.emptyHidden === true,
        JSON.stringify(shown),
      );
    } else {
      check('下载中心列出该记录：文件名/状态/落点都可读（A1）', false, '下载中心窗口未出现');
    }

    // 吞吐：清单 A3 说"大文件极慢"，所以慢必须是个数字——平均速度与用时写在条目里
    const speedShown = /平均 .+\/s/.test(dlMetaText) && /用时 [\d.]+ s/.test(dlMetaText);
    check('下载条目给出平均速度与用时（A3）', speedShown === true, dlMetaText || '没有条目');

    // 工具栏角标：已经没有进行中/失败项，角标必须隐藏（避免"永远挂个 1"）
    const badge = await shell.eval(`(() => {
      const el = document.getElementById('dl-badge');
      return { hidden: el ? el.hidden : null, text: el ? el.textContent : '', hasFailed: el ? el.classList.contains('has-failed') : null };
    })()`);
    check(
      '下载结束后工具栏角标归零隐藏（A1）',
      !!badge && badge.hidden === true && badge.hasFailed === false,
      JSON.stringify(badge),
    );

    // 隐私模式不落盘这件事必须"说出来"：静态确认拦截与告知文案同时存在
    const privateGuard = (() => {
      const sessionsSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sessions.js'), 'utf8');
      const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const blocksDownload = /will-download[\s\S]{0,200}preventDefault/.test(sessionsSrc);
      const tellsUser = mainSrc.includes('DOWNLOAD_BLOCKED_PRIVATE') && mainSrc.includes('隐私模式不保存文件');
      return { blocksDownload, tellsUser };
    })();
    check(
      '隐私模式下载被拦截且有中文解释（不再是"点了没反应"）（A1）',
      privateGuard.blocksDownload === true && privateGuard.tellsUser === true,
      JSON.stringify(privateGuard),
    );

    /* ---------- 运行时无脚本异常 ---------- */
    const shellErrors = shell.exceptions();
    /* ---------- B3（设置页侧）：卡片 / 未勾确认被拦 / 勾选后可改可回 ---------- */
    // 放在这里是因为设置窗口要到脚本中段才创建，过早断言只能拿到 null。
    if (settings) {
      await shell.eval("window.nyx.openSettings({ section: 'privacy' })");
      await sleep(1000);

      const linkCard = await settings.eval(`(() => {
        const proxy = document.getElementById('privacy-link-proxy');
        const direct = document.getElementById('privacy-link-direct');
        const lost = document.getElementById('privacy-link-lost');
        const ack = document.getElementById('privacy-link-ack');
        const ackRow = document.getElementById('privacy-link-ack-row');
        const status = document.getElementById('privacy-link-status');
        const badge = document.getElementById('privacy-link-badge');
        if (!proxy || !direct || !lost || !ack || !status || !badge) return null;
        return {
          proxyChecked: proxy.checked,
          directChecked: direct.checked,
          badge: badge.textContent.trim(),
          status: status.textContent.trim(),
          lostHidden: lost.hidden,
          ackRowHidden: ackRow ? ackRow.hidden : null,
        };
      })()`);
      check(
        '设置页有「隐私模式的出站方式」卡片并显示当前取值（B3）',
        !!linkCard &&
          linkCard.proxyChecked === true &&
          linkCard.directChecked === false &&
          /经代理/.test(linkCard.badge) &&
          /经代理/.test(linkCard.status),
        JSON.stringify(linkCard),
      );

      const blockedPick = await settings.eval(`(async () => {
        const direct = document.getElementById('privacy-link-direct');
        const proxy = document.getElementById('privacy-link-proxy');
        const status = document.getElementById('privacy-link-status');
        direct.checked = true;
        direct.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        return {
          proxyChecked: proxy.checked,
          directChecked: direct.checked,
          status: status.textContent,
        };
      })()`);
      check(
        '设置页里未勾确认就选「真实 IP」会被拦下并说明原因（B3）',
        !!blockedPick &&
          blockedPick.proxyChecked === true &&
          blockedPick.directChecked === false &&
          /勾选/.test(blockedPick.status),
        JSON.stringify(blockedPick),
      );

      const ackFlow = await settings.eval(`(async () => {
        const ack = document.getElementById('privacy-link-ack');
        const direct = document.getElementById('privacy-link-direct');
        const proxy = document.getElementById('privacy-link-proxy');
        const lost = document.getElementById('privacy-link-lost');
        // 勾确认 → 选直连（真的走 IPC）→ 再改回代理，别把隔离 profile 留在直连
        ack.checked = true;
        ack.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        const lostShown = !lost.hidden;
        direct.checked = true;
        direct.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
        const afterDirect = await window.nyx.privacyLink();
        proxy.checked = true;
        proxy.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 800));
        const afterProxy = await window.nyx.privacyLink();
        return { lostShown, directLink: afterDirect.link, back: afterProxy.link };
      })()`);
      check(
        '勾选确认后设置页能把隐私模式改成真实 IP，再改回代理（B3）',
        !!ackFlow && ackFlow.directLink === 'direct' && ackFlow.back === 'proxy',
        JSON.stringify(ackFlow),
      );
    }

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
      if (downloadsPage) downloadsPage.close();
    } catch {
      /* 忽略 */
    }
    try {
      if (httpServer) httpServer.close();
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
