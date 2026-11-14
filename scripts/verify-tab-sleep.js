'use strict';

/**
 * 标签休眠端到端验证（清单 G）。
 *
 * 纯函数那边（scripts/verify-tab-lifecycle.js）只回答"该不该睡"；
 * 这里起一个真实实例回答"睡了以后还回得来吗"，以及清单 G 点名的两个例外：
 *   - 当前标签永不休眠；
 *   - 有 agent 会话 / agent 刚操作过的标签不休眠。
 *
 * 休眠阈值默认 30 分钟，测试等不起，所以用 NYX_TAB_SLEEP_MS 把它压到 1.2 秒。
 * 这个环境变量只是验证旋钮，正常启动不会有。
 *
 * 用法：node scripts/verify-tab-sleep.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const workDir = path.join(os.tmpdir(), `nyx-tab-sleep-${Date.now()}`);
const userData = path.join(workDir, 'userdata');
const SLEEP_MS = 1200;

let PORT = 0;
let WEB_PORT = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
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
        if (msg.error) waiter.reject(new Error(msg.error.message));
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

function startWebServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = String(req.url || '/').split('?')[0].replace(/^\//, '') || 'g1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>休眠测试 ${name}</title></head>` +
          `<body><h1>${name}</h1><p>这个页面用来验证后台标签休眠与唤醒。</p></body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      WEB_PORT = server.address().port;
      resolve(server);
    });
  });
}

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`找不到 Electron 可执行文件：${ELECTRON}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(userData, { recursive: true });
  // agent 动作要过站点授权（清单 E）：把本地测试站点登记为白名单，
  // 否则"未命中就问一次"会弹模态框把整条链挂住。
  fs.writeFileSync(
    path.join(userData, 'agent-sites.json'),
    JSON.stringify({ globalEnabled: true, allow: ['127.0.0.1', 'localhost'], block: [] }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(userData, 'ui-preferences.json'), JSON.stringify({ downloadAsk: false }, null, 2), 'utf8');

  PORT = await pickFreePort();
  const webServer = await startWebServer();
  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');
  console.log(`[验证] 隔离用户数据：${userData}`);
  console.log(`[验证] 调试端口：${PORT}｜测试站点：http://127.0.0.1:${WEB_PORT}`);
  console.log(`[验证] 休眠阈值：${SLEEP_MS} ms（NYX_TAB_SLEEP_MS）`);

  const childEnv = { ...process.env, NYX_USER_DATA: userData, NYX_TAB_SLEEP_MS: String(SLEEP_MS) };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });

  let shell = null;
  try {
    const shellTarget = await waitTarget((t) => t.url.endsWith('/index.html'), 40000);
    if (!shellTarget) throw new Error('主窗口未就绪（日志见 app.log）');
    shell = await new Cdp(shellTarget.webSocketDebuggerUrl).connect();
    await shell.send('Runtime.enable', {});

    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      ready = await shell.eval('!!(window.nyx && typeof window.nyx.createTab === "function")').catch(() => false);
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('preload 未就绪');

    const initial = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      return { lifecycle: snap.lifecycle || null, count: (snap.tabs || []).length };
    })()`);
    check(
      '1. 快照里带生命周期信息，且休眠阈值就是验证用的那个数',
      !!initial && initial.lifecycle && initial.lifecycle.sleepAfterMs === SLEEP_MS,
      JSON.stringify(initial && initial.lifecycle),
    );

    // 开第二个标签（成为当前标签），再切回第一个 → 第二个变成"后台闲置"
    const created = await shell.eval(`window.nyx.createTab('http://127.0.0.1:${WEB_PORT}/g2')`);
    const firstId = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      return ((snap.tabs || [])[0] || {}).id || null;
    })()`);
    check('2. 第二个标签开出来了', created && created.ok === true, JSON.stringify(created));
    await sleep(1200); // 等页面加载完成，否则"闲置"从刚创建就开始算会有歧义
    await shell.eval(`window.nyx.activateTab(${JSON.stringify(firstId)})`);
    await sleep(300);

    const tab2Id = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const other = (snap.tabs || []).find((tab) => tab.id !== ${JSON.stringify(firstId)});
      return other ? other.id : null;
    })()`);

    // 等巡检（5 秒一轮）+ 阈值（1.2 秒）跑完
    await sleep(8000);
    const afterSleep = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.id === ${JSON.stringify(tab2Id)}) || {};
      const active = (snap.tabs || []).find((item) => item.active) || {};
      const dimmed = document.querySelectorAll('.tab.is-asleep').length;
      return {
        asleep: tab.asleep === true,
        lifecycleLabel: tab.lifecycle || '',
        activeAsleep: active.asleep === true,
        activeId: active.id,
        dimmed,
        summary: (snap.lifecycle || {}).text || '',
        asleepCount: (snap.lifecycle || {}).asleep || 0,
      };
    })()`);
    check(
      '3. 后台标签闲置超过阈值后真的休眠了（渲染进程已释放）',
      !!afterSleep && afterSleep.asleep === true && afterSleep.asleepCount >= 1,
      JSON.stringify(afterSleep),
    );
    check(
      '4. 当前标签永不休眠（清单 G 的关键例外之一）',
      !!afterSleep && afterSleep.activeAsleep === false,
      JSON.stringify({ activeId: afterSleep && afterSleep.activeId }),
    );
    check(
      '5. 标签栏把休眠状态显示出来（淡显 + 已休眠文案），不是悄悄释放',
      !!afterSleep && afterSleep.dimmed >= 1 && afterSleep.lifecycleLabel === '已休眠',
      JSON.stringify({ dimmed: afterSleep && afterSleep.dimmed, label: afterSleep && afterSleep.lifecycleLabel }),
    );

    // 点回休眠标签：应当按原地址重新加载并恢复可用
    await shell.eval(`window.nyx.activateTab(${JSON.stringify(tab2Id)})`);
    await sleep(2500);
    const afterWake = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.id === ${JSON.stringify(tab2Id)}) || {};
      return { asleep: tab.asleep === true, url: tab.url || '', loading: tab.loading === true };
    })()`);
    check(
      '6. 点回休眠标签会按原地址重新加载（唤醒后地址没丢）',
      !!afterWake && afterWake.asleep === false && String(afterWake.url).includes('/g2'),
      JSON.stringify(afterWake),
    );
    const restoredTarget = await waitTarget((t) => t.url.includes('/g2'), 15000);
    let bodyText = '';
    if (restoredTarget) {
      const pageCdp = await new Cdp(restoredTarget.webSocketDebuggerUrl).connect();
      await pageCdp.send('Runtime.enable', {});
      bodyText = await pageCdp.eval('document.body ? document.body.innerText : ""').catch(() => '');
      pageCdp.close();
    }
    check(
      '7. 唤醒后页面内容真的回来了（不是只留一个空壳）',
      /休眠测试|验证后台标签休眠/.test(String(bodyText)),
      JSON.stringify({ text: String(bodyText).slice(0, 40) }),
    );

    // agent 例外：开第三个标签并切走，然后让 agent 动作一次
    await shell.eval(`window.nyx.createTab('http://127.0.0.1:${WEB_PORT}/g3')`);
    await sleep(1200);
    const tab3Id = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const active = (snap.tabs || []).find((item) => item.active) || {};
      return active.id || null;
    })()`);
    await shell.eval(`window.nyx.activateTab(${JSON.stringify(tab2Id)})`);

    const tokenPath = path.join(userData, 'api-token.txt');
    const portPath = path.join(userData, 'api-port.txt');
    let apiToken = '';
    for (let i = 0; i < 40 && !apiToken; i += 1) {
      if (fs.existsSync(tokenPath) && fs.existsSync(portPath)) {
        // 文件是 UTF-8 写的，可能带 BOM；trim() 去不掉 BOM，会把首字符带进 Token 里
        // 导致 401「Token 无效」——这种假失败最难查，索性在这里一次性清掉。
        apiToken = fs.readFileSync(tokenPath, 'utf8').replace(/^\uFEFF/, '').trim();
      }
      if (!apiToken) await sleep(250);
    }
    const apiPort = apiToken ? fs.readFileSync(portPath, 'utf8').trim() : '';
    let actionOk = false;
    let actionDetail = { hasToken: !!apiToken, port: apiPort };
    if (apiToken) {
      // 本地接口是"先写端口文件、再开始监听"：直接打 /action 容易撞上还没 listening，
      // 表现为 fetch failed。先等 /health 通，再发动作（与界面回归同一套做法）。
      // 接口鉴权用的是 x-nyx-token 头（不是 Authorization: Bearer），传错头只会得到
      // 401「Token 无效」，看起来像令牌读错了，其实头就写错了。
      for (let i = 0; i < 40; i += 1) {
        const health = await fetch(`http://127.0.0.1:${apiPort}/health`, {
          headers: { 'x-nyx-token': apiToken },
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        if (health && health.ok) break;
        await sleep(250);
      }
      const res = await fetch(`http://127.0.0.1:${apiPort}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nyx-token': apiToken },
        body: JSON.stringify({ type: 'readPage' }),
        signal: AbortSignal.timeout(20000),
      }).catch((err) => ({ caught: err && err.message }));
      if (res && res.caught) {
        actionDetail.error = res.caught;
      } else {
        const payload = await res.json().catch(() => ({}));
        actionOk = !!payload && payload.ok === true;
        actionDetail = { ...actionDetail, status: res.status, code: payload && payload.code, error: payload && payload.error };
      }
    }
    check('8. agent 动作能正常执行（为下面的例外做铺垫）', actionOk, JSON.stringify(actionDetail));

    await sleep(8000);
    const afterAgent = await shell.eval(`(async () => {
      const snap = await window.nyx.getState();
      const tab = (snap.tabs || []).find((item) => item.id === ${JSON.stringify(tab3Id)}) || {};
      return {
        tabAsleep: tab.asleep === true,
        agentSessionActive: (snap.lifecycle || {}).agentSessionActive === true,
        summary: (snap.lifecycle || {}).text || '',
      };
    })()`);
    check(
      '9. 有 agent 会话在跑时，后台标签保持唤醒（清单 G 的关键例外之二）',
      !!afterAgent && afterAgent.agentSessionActive === true && afterAgent.tabAsleep === false,
      JSON.stringify(afterAgent),
    );

    const errors = await shell
      .eval(`(async () => {
        const snap = await window.nyx.getState();
        return (snap.tabs || []).filter((tab) => tab.loadError).map((tab) => tab.loadError.code);
      })()`)
      .catch(() => []);
    check('10. 休眠 / 唤醒过程中没有产生页面错误', Array.isArray(errors) && errors.length === 0, JSON.stringify(errors));
  } finally {
    if (shell) shell.close();
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(1200);
    webServer.close();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 日志留在临时目录也不影响结果 */
    }
  }

  const failed = checks.filter((item) => !item.pass);
  console.log(`\n结果：${checks.length - failed.length} 项通过，${failed.length} 项失败`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  - ${item.name}：${item.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[验证失败]', err && err.message ? err.message : err);
  process.exitCode = 1;
});
