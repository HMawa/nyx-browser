'use strict';

/**
 * 性能基线测量（清单 C2 第一步）。
 *
 * 只量三件事，量完就把数字写下来，别靠印象：
 *   1. 冷启动：从 spawn 到主窗口可连 CDP、再到 preload 就绪（window.nyx 可用）。
 *   2. 占用：1 个标签 与 5 个标签时，整棵进程树的工作集合之和（不含其它 Nyx 实例）。
 *   3. 体积：安装包字节数、解包目录字节数（体积和占用是两件事，各自记）。
 *
 * 用法：
 *   node scripts/measure-baseline.js                量开发运行（node_modules 里的 electron）
 *   node scripts/measure-baseline.js --exe=<路径>    量别的可执行文件（例如 dist\win-unpacked\Nyx.exe）
 *   node scripts/measure-baseline.js --json          只打一行 JSON（给脚本用）
 *
 * 说明：测量会在临时目录里跑一个隔离实例（NYX_USER_DATA 指到 %TEMP%），
 * 页面来自本进程起的一个本地 HTTP 服务，不联网、不影响真实用户数据。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const workDir = path.join(os.tmpdir(), `nyx-baseline-${Date.now()}`);
const userData = path.join(workDir, 'userdata');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readArg(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const hasFlag = (name) => process.argv.includes(`--${name}`);

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
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 20000);
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

let PORT = 0;
let WEB_PORT = 0;

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
    await sleep(100);
  }
  return null;
}

function startWebServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = String(req.url || '/').split('?')[0].replace(/^\//, '') || 'b1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>基线页 ${name}</title></head>` +
          `<body><h1>${name}</h1><p>这个页面用来量占用，内容长度无所谓。</p></body></html>`,
      );
    });
    server.listen(0, '127.0.0.1', () => {
      WEB_PORT = server.address().port;
      resolve(server);
    });
  });
}

/** 整棵进程树（含子孙）的工作集合之和；按父链枚举，不会误算别的 Electron 实例。 */
function treeMemory(rootPid) {
  const script = [
    `$root = ${Number(rootPid)};`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize;',
    '$ids = @($root);',
    '$changed = $true;',
    'while ($changed) {',
    '  $changed = $false;',
    '  foreach ($p in $all) {',
    '    if (($ids -contains $p.ParentProcessId) -and ($ids -notcontains $p.ProcessId)) {',
    '      $ids += $p.ProcessId; $changed = $true;',
    '    }',
    '  }',
    '}',
    '$sum = 0;',
    'foreach ($id in $ids) {',
    '  $hit = $all | Where-Object { $_.ProcessId -eq $id };',
    '  if ($hit) { $sum += $hit.WorkingSetSize }',
    '}',
    '[pscustomobject]@{ count = $ids.Count; bytes = $sum } | ConvertTo-Json -Compress',
  ].join(' ');
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const text = String(res.stdout || '').trim();
  if (!text) return { count: 0, bytes: 0, error: String(res.stderr || '').trim() };
  try {
    const parsed = JSON.parse(text);
    return { count: Number(parsed.count) || 0, bytes: Number(parsed.bytes) || 0 };
  } catch {
    return { count: 0, bytes: 0, error: text.slice(0, 200) };
  }
}

function dirBytes(dir, skip = []) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (skip.some((s) => full === s)) continue;
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return total;
}

const mb = (bytes) => Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10;

async function main() {
  const exe = path.resolve(readArg('exe', DEFAULT_EXE));
  const jsonOnly = hasFlag('json');
  if (!fs.existsSync(exe)) {
    console.error(`找不到可执行文件：${exe}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'ui-preferences.json'), JSON.stringify({ downloadAsk: false }, null, 2), 'utf8');

  PORT = await pickFreePort();
  const webServer = await startWebServer();
  const logFd = fs.openSync(path.join(workDir, 'app.log'), 'a');

  const childEnv = { ...process.env, NYX_USER_DATA: userData };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const args = exe === DEFAULT_EXE ? ['.', `--remote-debugging-port=${PORT}`] : [`--remote-debugging-port=${PORT}`];
  const startedAt = Date.now();
  const child = spawn(exe, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', logFd, logFd] });

  const result = {
    exe,
    packaged: exe !== DEFAULT_EXE,
    coldStartMs: null,
    preloadReadyMs: null,
    oneTab: null,
    fiveTabs: null,
    errors: [],
  };

  let shell = null;
  try {
    const shellTarget = await waitTarget((t) => t.url.endsWith('/index.html'), 60000);
    if (!shellTarget) throw new Error('主窗口未就绪（日志见 app.log）');
    result.coldStartMs = Date.now() - startedAt;

    shell = await new Cdp(shellTarget.webSocketDebuggerUrl).connect();
    await shell.send('Runtime.enable', {});

    let ready = false;
    for (let i = 0; i < 80 && !ready; i += 1) {
      ready = await shell.eval('!!(window.nyx && typeof window.nyx.createTab === "function")').catch(() => false);
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error('preload 未就绪');
    result.preloadReadyMs = Date.now() - startedAt;

    await sleep(1500); // 让首帧、GPU、工具进程稳定下来，否则第一个数偏低
    result.oneTab = treeMemory(child.pid);

    const four = [
      `http://127.0.0.1:${WEB_PORT}/b2`,
      `http://127.0.0.1:${WEB_PORT}/b3`,
      `http://127.0.0.1:${WEB_PORT}/b4`,
      `http://127.0.0.1:${WEB_PORT}/b5`,
    ];
    for (const url of four) {
      await shell.eval(`window.nyx.createTab(${JSON.stringify(url)})`);
      await sleep(200);
    }
    // 等 5 个标签都不在加载中
    for (let i = 0; i < 60; i += 1) {
      const loading = await shell
        .eval(`(async () => { const s = await window.nyx.getState(); return (s.tabs || []).filter(t => t.loading).length; })()`)
        .catch(() => 0);
      if (!loading) break;
      await sleep(250);
    }
    await sleep(2000);
    result.fiveTabs = treeMemory(child.pid);
    result.tabCount = await shell
      .eval(`(async () => { const s = await window.nyx.getState(); return (s.tabs || []).length; })()`)
      .catch(() => 0);
  } catch (err) {
    result.errors.push(String(err && err.message ? err.message : err));
  } finally {
    if (shell) shell.close();
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(1200);
    // 只按自己的 PID 清理残留子进程（不按进程名杀）
    spawnSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${Number(child.pid)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true });
    webServer.close();
  }

  // 体积：安装包与解包目录（体积 ≠ 占用，各自记）
  const setupDir = path.join(ROOT, 'dist');
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked');
  let setup = null;
  try {
    const files = fs.readdirSync(setupDir).filter((f) => /^Nyx-Setup-.*\.exe$/i.test(f));
    const newest = files
      .map((f) => ({ f, t: fs.statSync(path.join(setupDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest) setup = { file: newest.f, bytes: fs.statSync(path.join(setupDir, newest.f)).size };
  } catch {
    /* 没有 dist 就跳过 */
  }
  result.setupBytes = setup ? setup.bytes : null;
  result.setupFile = setup ? setup.file : '';
  result.unpackedBytes = fs.existsSync(unpacked) ? dirBytes(unpacked, [path.join(unpacked, 'updates')]) : null;

  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }

  if (jsonOnly) {
    console.log(JSON.stringify(result));
    return;
  }

  const line = (label, value) => console.log(`  ${label}：${value}`);
  console.log('[性能基线] 一次测量结束（隔离 userData，未影响真实数据）');
  line('可执行文件', result.exe);
  line('冷启动到主窗口可连', result.coldStartMs == null ? '失败' : `${result.coldStartMs} ms`);
  line('冷启动到 preload 就绪', result.preloadReadyMs == null ? '失败' : `${result.preloadReadyMs} ms`);
  line('1 个标签占用', result.oneTab ? `${result.oneTab.count} 个进程 / ${mb(result.oneTab.bytes)} MB` : '失败');
  line('5 个标签占用', result.fiveTabs ? `${result.fiveTabs.count} 个进程 / ${mb(result.fiveTabs.bytes)} MB` : '失败');
  line('安装包体积', result.setupBytes == null ? '（没有 dist）' : `${result.setupFile} ${result.setupBytes} 字节（${mb(result.setupBytes)} MB）`);
  line('解包目录体积', result.unpackedBytes == null ? '（没有 dist\\win-unpacked）' : `${result.unpackedBytes} 字节（${mb(result.unpackedBytes)} MB）`);
  if (result.errors.length) {
    console.log('[性能基线] 过程中出错：');
    for (const err of result.errors) console.log(`  - ${err}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[性能基线] 未预期的失败：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
