'use strict';

/**
 * 传输吞吐基线（清单 A3 的取证工具，不属于回归，不进 `npm run verify`）。
 *
 * 为什么要有它：清单说「大文件极慢」，但"慢"必须先是数字。这个脚本用本机
 * 回环服务分别测两件事，并各自给出同机纯 Node 客户端做对照：
 *   1) 下行：Nyx 下载一个 MB 级文件到磁盘需要多久（MB/s）；
 *   2) 上行：Nyx 页面里 POST 一个 MB 级 body 需要多久（MB/s）。
 *
 * 用法：
 *   node scripts/bench-transfer.js                 # 下行 500MB + 上行 100MB
 *   node scripts/bench-transfer.js --down 200 --up 50
 *   node scripts/bench-transfer.js --only down
 *
 * 输出：一行 JSON（含两段数字与对照值），失败时 exit 1。
 * 注意：测量本身会占用磁盘与网络，不要在跑回归的同时跑它。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const WORK = path.join(os.tmpdir(), `nyx-bench-${Date.now()}`);
const USER_DATA = path.join(WORK, 'userdata');
const DOWNLOAD_DIR = path.join(WORK, 'downloads');

const MB = 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const downMb = Number(arg('down', 500)) || 500;
const upMb = Number(arg('up', 100)) || 100;
const only = String(arg('only', 'both'));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mbps(bytes, ms) {
  if (!bytes || !ms) return 0;
  return Number((bytes / MB / (ms / 1000)).toFixed(1));
}

/* ---------- 回环服务：/big.bin 下行，/upload 上行，/ 上行测试页 ---------- */

function buildUploadPage(mb) {
  return `<!doctype html><meta charset="utf-8"><title>ready</title>
<body style="font:14px system-ui;background:#111;color:#eee">
<div id="out">准备中…</div>
<script>
const BYTES = ${mb} * 1024 * 1024;
(async () => {
  const blob = new Blob([new Uint8Array(BYTES)]);
  const t0 = performance.now();
  const res = await fetch('/upload', { method: 'POST', body: blob });
  const echoed = await res.json();
  const ms = Math.round(performance.now() - t0);
  window.__benchUpload = { ms, bytes: echoed.bytes, mbps: +(echoed.bytes / 1024 / 1024 / (ms / 1000)).toFixed(1) };
  document.getElementById('out').textContent = JSON.stringify(window.__benchUpload);
})().catch((e) => { window.__benchUpload = { error: String(e) }; });
</script>`;
}

function startServer(uploadMb) {
  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const total = downMb * MB;
      const chunk = Buffer.alloc(1024 * 1024, 0x4e);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(total),
        'Content-Disposition': 'attachment; filename="bench.bin"',
        'Cache-Control': 'no-store',
      });
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buildUploadPage(uploadMb));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      let bytes = 0;
      req.on('data', (c) => {
        bytes += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bytes }));
      });
      return;
    }
    res.writeHead(404).end('no');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ---------- 纯 Node 对照 ---------- */

function baselineDown(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    let bytes = 0;
    http
      .get(`http://127.0.0.1:${port}/big.bin`, (res) => {
        res.on('data', (c) => {
          bytes += c.length;
        });
        res.on('end', () => resolve({ ms: Date.now() - started, bytes, mbps: mbps(bytes, Date.now() - started) }));
      })
      .on('error', (e) => resolve({ error: e.message }));
  });
}

function baselineUp(port, mb) {
  return new Promise((resolve) => {
    const total = mb * MB;
    const started = Date.now();
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/upload',
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          const ms = Date.now() - started;
          let bytes = 0;
          try {
            bytes = JSON.parse(body).bytes;
          } catch {
            bytes = 0;
          }
          resolve({ ms, bytes, mbps: mbps(bytes, ms) });
        });
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    const chunk = Buffer.alloc(1024 * 1024, 0x4e);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

/* ---------- CDP ---------- */

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function waitTarget(port, predicate, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await listTargets(port);
      const hit = list.find(predicate);
      if (hit && hit.webSocketDebuggerUrl) return hit;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return null;
}

async function connect(url) {
  const { WebSocket } = globalThis;
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return out && out.result && out.result.result ? out.result.result.value : undefined;
  };
  return { ws, send, evalJs };
}

/* ---------- 主流程 ---------- */

async function main() {
  const result = { down: null, up: null, baseline: { down: null, up: null }, error: null };

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  // 免掉"保存到哪"的模态框：自动化必须能把落点固定下来
  fs.writeFileSync(
    path.join(USER_DATA, 'ui-preferences.json'),
    JSON.stringify({ downloadAsk: false, downloadDir: DOWNLOAD_DIR }, null, 2),
  );

  const { server, port: httpPort } = await startServer(upMb);
  const cdpPort = await pickFreePort();
  const env = { ...process.env, NYX_USER_DATA: USER_DATA };
  delete env.ELECTRON_RUN_AS_NODE; // 不清掉会启动即崩（isPackaged）

  const child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${cdpPort}`, '--no-sandbox'], {
    env,
    stdio: 'ignore',
  });

  try {
    const shellTarget = await waitTarget(cdpPort, (t) => t.type === 'page' && !!t.url);
    if (!shellTarget) throw new Error('主窗口 CDP 目标未就绪');
    const shell = await connect(shellTarget.webSocketDebuggerUrl);
    await sleep(1500);

    if (only !== 'up') {
      const started = Date.now();
      await shell.evalJs(`window.nyx.navigate('http://127.0.0.1:${httpPort}/big.bin')`);
      const file = path.join(DOWNLOAD_DIR, 'bench.bin');
      const want = downMb * MB;
      let last = -1;
      let stable = 0;
      let size = 0;
      let firstByteAt = 0;
      while (Date.now() - started < 15 * 60 * 1000) {
        await sleep(100);
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        // 首个字节落盘的时刻：把"导航+建连"的固定开销从吞吐里摘出去
        if (!firstByteAt && size > 0) firstByteAt = Date.now();
        if (size === last) stable += 100;
        else stable = 0;
        last = size;
        if (size >= want) break;
        if (size > 0 && stable >= 3000) break; // 3 秒不长 → 结束（成功或中断）
      }
      const ms = Date.now() - started;
      const transferMs = firstByteAt ? Date.now() - firstByteAt : 0;
      const record = await shell.evalJs('window.nyx.listDownloads()');
      const item = (record && record.items && record.items[0]) || null;
      result.down = {
        mb: downMb,
        ms,
        startupMs: firstByteAt ? firstByteAt - started : ms,
        transferMs,
        bytes: size,
        mbps: mbps(size, transferMs || ms),
        complete: size === want,
        state: item ? item.state : '',
        avgBytesPerSec: item ? item.avgBytesPerSec || 0 : 0,
      };
      result.baseline.down = await baselineDown(httpPort);
    }

    if (only !== 'down') {
      await shell.evalJs(`window.nyx.navigate('http://127.0.0.1:${httpPort}/')`);
      const tabTarget = await waitTarget(cdpPort, (t) => t.type === 'page' && String(t.url || '').startsWith(`http://127.0.0.1:${httpPort}`));
      if (!tabTarget) throw new Error('上传页 CDP 目标未就绪');
      const tab = await connect(tabTarget.webSocketDebuggerUrl);
      const deadline = Date.now() + 180000;
      let value = null;
      while (Date.now() < deadline) {
        await sleep(300);
        const v = await tab.evalJs('window.__benchUpload || null');
        if (v) {
          value = v;
          break;
        }
      }
      tab.ws.close();
      result.up = Object.assign({ mb: upMb }, value || { error: '页面上传没有给出结果' });
      result.baseline.up = await baselineUp(httpPort, upMb);
    }

    shell.ws.close();
  } catch (err) {
    result.error = err.message;
  } finally {
    server.close();
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
    await sleep(600);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
