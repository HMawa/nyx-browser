'use strict';

/**
 * 应用页 navigate 的预算端到端验收。
 *
 * 纯 Node 的 verify-navigate-budget.js 只能证明「函数和接线在」；它抓不到真正的 bug：
 * 起始页/设置页上 navigate 会新开标签后立刻返回，3 秒预算下 6 秒慢页也报成功，
 * 下一条动作被拖满 6 秒。这里起一个真实实例，从设置页出发，验证：
 *   ① 慢页在预算附近返回 NAVIGATE_TIMEOUT，而不是 14ms 假成功；
 *   ② 超时结果带 tabId（agent 能追到新标签）；
 *   ③ 快页返回 data.tabId + fromAppPage，且耗时远小于预算；
 *   ④ 标签确实新开了，不是把设置页自己导航走。
 *
 * 用法：node scripts/verify-navigate-budget-e2e.js
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const workDir = path.join(os.tmpdir(), `nyx-nav-budget-e2e-${Date.now()}`);
const userData = path.join(workDir, 'userdata');
const BUDGET = 3000;
const SLOW_MS = 6000;

let checks = 0;
let failed = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ✔ ${name}${detail ? `｜${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? `｜${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
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
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 15000);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result && result.exceptionDetails) throw new Error('页面脚本异常');
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

function startSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/slow') {
        const ms = Math.min(30000, Math.max(0, Number(url.searchParams.get('ms')) || 1000));
        setTimeout(() => {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end('<h1>slow</h1>');
        }, ms);
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<h1>probe</h1>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitHealth(port, token, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: token ? { 'x-nyx-token': token } : {},
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (health && health.ok) return true;
    await sleep(250);
  }
  return false;
}

async function waitTarget(port, predicate, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      .then((res) => res.json())
      .catch(() => []);
    const target = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && predicate(t));
    if (target) return target;
    await sleep(250);
  }
  return null;
}

async function main() {
  fs.mkdirSync(userData, { recursive: true });
  // 预置站点白名单：否则「未命中就问一次」会弹模态框，把动作卡在授权阶段，
  // 测出来的耗时就不是导航预算了（这是上一次手工测试踩过的坑）。
  fs.writeFileSync(
    path.join(userData, 'agent-sites.json'),
    JSON.stringify({ globalEnabled: true, allow: ['127.0.0.1', 'localhost'], block: [] }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify({ pending: false }), 'utf8');

  const site = await startSite();
  const webPort = site.address().port;
  const apiPort = await pickFreePort();
  const cdpPort = await pickFreePort();
  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');

  const childEnv = { ...process.env, NYX_USER_DATA: userData, NYX_API_PORT: String(apiPort) };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${cdpPort}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });

  let shell = null;
  try {
    const target = await waitTarget(cdpPort, (t) => /renderer[\\/]index\.html/.test(t.url || ''));
    if (!target) throw new Error('主窗口未就绪');
    shell = await new Cdp(target.webSocketDebuggerUrl).connect();
    await shell.send('Runtime.enable', {});
    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      ready = await shell.eval('!!(window.nyx && typeof window.nyx.openSettings === "function")').catch(() => false);
      if (!ready) await sleep(250);
    }
    check('1. 主窗口与 preload 就绪', ready);
    if (!ready) throw new Error('preload 未就绪');

    let token = '';
    for (let i = 0; i < 40 && !token; i += 1) {
      const tokenPath = path.join(userData, 'api-token.txt');
      if (fs.existsSync(tokenPath)) token = fs.readFileSync(tokenPath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!token) await sleep(250);
    }
    const healthy = await waitHealth(apiPort, token);
    check('2. 本地接口就绪', healthy && !!token);
    if (!healthy) throw new Error('本地接口未就绪');

    await shell.eval('window.nyx.openSettings()');
    let settingsTab = null;
    for (let i = 0; i < 40 && !settingsTab; i += 1) {
      const snap = await shell.eval('window.nyx.getState()').catch(() => null);
      const tabs = (snap && snap.tabs) || [];
      settingsTab = tabs.find((tab) => /settings\.html/.test(tab.url || '')) || null;
      if (!settingsTab) await sleep(250);
    }
    check('3. 设置页成为活动标签', !!settingsTab && settingsTab.active === true, JSON.stringify(settingsTab && settingsTab.url));
    if (!settingsTab) throw new Error('设置页没有成为活动标签');

    const post = (body, timeoutMs) => fetch(`http://127.0.0.1:${apiPort}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nyx-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));

    const before = await shell.eval('window.nyx.getState().then((snap) => snap.tabs.length)');
    const started = Date.now();
    const slow = await post({
      type: 'navigate',
      params: { url: `http://127.0.0.1:${webPort}/slow?ms=${SLOW_MS}`, timeoutMs: BUDGET },
    }, 12000);
    const elapsed = Date.now() - started;
    check(
      '4. 慢页按预算超时（不再 14ms 假成功）',
      slow.status === 400 && slow.body.code === 'NAVIGATE_TIMEOUT' && elapsed >= 2400 && elapsed <= 6000,
      `status=${slow.status} / ${elapsed}ms / ${slow.body.code}`,
    );
    check('5. 超时结果带 tabId（agent 能追到新标签）', Number.isInteger(slow.body.tabId) && slow.body.tabId > 0, `tabId=${slow.body.tabId}`);
    const after = await shell.eval('window.nyx.getState().then((snap) => snap.tabs.length)');
    check('6. 新标签确实开了，设置页没有被导航走', after === before + 1, `${before} -> ${after}`);

    // 回到设置页，再测快页：预算内成功，且返回值明确 fromAppPage。
    const snap = await shell.eval('window.nyx.getState()');
    const settingsNow = ((snap && snap.tabs) || []).find((tab) => /settings\.html/.test(tab.url || ''));
    if (settingsNow) await shell.eval(`window.nyx.activateTab(${Number(settingsNow.id)})`);
    await sleep(300);
    const fastStart = Date.now();
    const fast = await post({
      type: 'navigate',
      params: { url: `http://127.0.0.1:${webPort}/probe`, timeoutMs: BUDGET },
    }, 8000);
    const fastElapsed = Date.now() - fastStart;
    check(
      '7. 快页在预算内成功，并回 tabId/fromAppPage',
      fast.status === 200 && fast.body.ok === true
        && fast.body.data && fast.body.data.fromAppPage === true
        && Number.isInteger(fast.body.data.tabId)
        && fastElapsed < BUDGET,
      `status=${fast.status} / ${fastElapsed}ms / ${JSON.stringify(fast.body.data)}`,
    );
  } finally {
    if (shell) shell.close();
    try {
      site.close();
    } catch {
      /* 忽略 */
    }
    try {
      fs.closeSync(logFd);
    } catch {
      /* 忽略 */
    }
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(500);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }

  console.log(`\n应用页导航预算 E2E：通过 ${checks - failed} 项，失败 ${failed} 项`);
  if (failed) process.exit(1);
  console.log('[Nyx] 应用页导航预算 E2E 通过');
}

main().catch((error) => {
  console.error(`[Nyx] 应用页导航预算 E2E 失败：${error.message}`);
  process.exit(1);
});
