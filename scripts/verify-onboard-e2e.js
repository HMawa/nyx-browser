'use strict';

/**
 * 首次安装引导端到端（清单 D2）。
 *
 * 纯逻辑那半边在 verify-onboard.js，这里只回答三件真机才看得出来的事：
 *   ① marker=pending 时**真的弹出**引导窗口；② 点「全部默认」之后偏好真的落盘、窗口真的关掉；
 *   ③ 再启动一次不再弹；把 marker 改成 pending=false（升级安装）也不弹。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const workDir = path.join(os.tmpdir(), `nyx-onboard-${Date.now()}`);
const userData = path.join(workDir, 'userdata');

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

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    return Array.isArray(list) ? list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl) : [];
  } catch {
    return [];
  }
}

async function waitTarget(port, match, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await listTargets(port)).filter(match);
    if (found.length) return found[0];
    await sleep(250);
  }
  return null;
}

async function launch({ marker }) {
  fs.mkdirSync(userData, { recursive: true });
  if (marker) {
    fs.writeFileSync(path.join(userData, 'onboarding.json'), JSON.stringify(marker, null, 2), 'utf8');
  }
  const port = await pickFreePort();
  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');
  const childEnv = { ...process.env, NYX_USER_DATA: userData };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', logFd, logFd],
  });
  return { child, port };
}

async function stop(child) {
  if (!child || child.killed) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 6000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
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
  // 避免站点授权确认框干扰 shell 的自动化动作
  fs.writeFileSync(
    path.join(userData, 'agent-sites.json'),
    JSON.stringify({ globalEnabled: true, allow: ['127.0.0.1', 'localhost'], block: [] }, null, 2),
    'utf8',
  );
  console.log(`[验证] 隔离用户数据：${userData}`);

  /* ---------- 第一次启动：全新安装（pending=true） → 应该弹 ---------- */
  let run = await launch({ marker: { pending: true, version: '1.17.9-test' } });
  let onboard = null;
  try {
    onboard = await waitTarget(run.port, (t) => t.url.endsWith('/onboard.html'), 45000);
    check('1. 全新安装（pending=true）首次启动弹出引导窗口', !!onboard, onboard ? onboard.url : '没等到引导窗口');

    if (onboard) {
      const page = await new Cdp(onboard.webSocketDebuggerUrl).connect();
      await page.send('Runtime.enable', {});
      let form = null;
      for (let i = 0; i < 40; i += 1) {
        form = await page.eval(`(() => {
          const ids = ['ob-theme', 'ob-density', 'ob-download-dir', 'ob-download-ask', 'ob-privacy-link', 'ob-start'];
          const missing = ids.filter((id) => !document.getElementById(id));
          return {
            missing,
            skip: !!document.getElementById('btn-onboard-skip'),
            done: !!document.getElementById('btn-onboard-done'),
            cards: document.querySelectorAll('.onboard-card').length,
            hasNextStep: /下一步/.test(document.body.textContent || ''),
          };
        })()`).catch(() => null);
        if (form && form.cards >= 4) break;
        await sleep(250);
      }
      check(
        '2. 引导页里五件事都在，且没有"必须下一步"的强制流程',
        form && form.missing.length === 0 && form.skip && form.done && form.cards >= 4 && form.hasNextStep === false,
        JSON.stringify(form),
      );

      // 点「全部默认」：一步落盘并关窗
      await page.eval(`document.getElementById('btn-onboard-skip').click()`);
      let closed = false;
      for (let i = 0; i < 40; i += 1) {
        const still = (await listTargets(run.port)).some((t) => t.url.endsWith('/onboard.html'));
        if (!still) {
          closed = true;
          break;
        }
        await sleep(250);
      }
      check('3. 点「全部默认」后引导窗口自己关掉', closed === true);

      const markerPath = path.join(userData, 'onboarding.json');
      let marker = null;
      try {
        marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      } catch {
        marker = null;
      }
      check(
        '4. 走完会写 doneAt 且 pending=false（防止第二次弹出）',
        !!marker && marker.pending === false && Number(marker.doneAt) > 0,
        JSON.stringify(marker),
      );

      const prefsPath = path.join(userData, 'ui-preferences.json');
      let prefs = null;
      for (let i = 0; i < 20; i += 1) {
        try {
          prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
        } catch {
          prefs = null;
        }
        if (prefs && prefs.theme) break;
        await sleep(250);
      }
      check(
        '5. 「全部默认」真的把偏好写进了磁盘（主题 / 下载询问 / 隐私链路 / 起始页）',
        !!prefs && typeof prefs.theme === 'string' && prefs.downloadAsk === true && prefs.privacyLink !== undefined,
        JSON.stringify(prefs && { theme: prefs.theme, downloadAsk: prefs.downloadAsk, privacyLink: prefs.privacyLink, startPage: prefs.startPage }),
      );
      page.close();
    }
  } finally {
    await stop(run.child);
  }

  /* ---------- 第二次启动：已经走过 → 不该再弹 ---------- */
  run = await launch({ marker: null });
  try {
    await waitTarget(run.port, (t) => t.url.endsWith('/index.html'), 45000);
    await sleep(2500);
    const again = (await listTargets(run.port)).some((t) => t.url.endsWith('/onboard.html'));
    check('6. 已经有 doneAt 的配置再次启动不再弹（仅首次）', again === false, `出现=${again}`);
  } finally {
    await stop(run.child);
  }

  /* ---------- 第三次启动：升级安装（pending=false） → 不该弹 ---------- */
  run = await launch({ marker: { pending: false, doneAt: Date.now(), version: '1.17.9' } });
  try {
    await waitTarget(run.port, (t) => t.url.endsWith('/index.html'), 45000);
    await sleep(2500);
    const upgraded = (await listTargets(run.port)).some((t) => t.url.endsWith('/onboard.html'));
    check('7. 升级安装（pending=false）不弹引导', upgraded === false, `出现=${upgraded}`);
  } finally {
    await stop(run.child);
  }

  const failed = checks.filter((item) => !item.pass);
  if (failed.length) {
    console.log('[首次引导 e2e] 未通过：');
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? `：${item.detail}` : ''}`);
    console.log(`[提示] 应用日志：${path.join(workDir, 'app.log')}`);
    process.exitCode = 1;
  } else {
    console.log(`[首次引导 e2e] 通过 ${checks.length}/${checks.length}`);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

main().catch((err) => {
  console.error(`[首次引导 e2e] 出错：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
