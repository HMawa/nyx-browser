#!/usr/bin/env node
/**
 * 阶段 2 地基验收 A：内核窗口句柄解析 + 常驻 Win32 通路
 *
 * 为什么需要这两件：
 *   - B 嵌入承载（SetParent）必须拿到**内核主窗口 hwnd**。而 Edge 首次以新建 user-data-dir
 *     启动会 relaunch，boot 返回瞬间窗口可能尚不存在（见「二·补 12」），故必须轮询等待，
 *     并用「属主 pid == kernelPid」证明拿到的是本次内核的窗口而非残留实例。
 *   - Electron 主进程无法直接调 Win32，而焦点转发属热路径；一次性 spawn PowerShell 往返
 *     300-500ms 不可用，故验常驻 helper + 管道的往返延迟。
 *
 * 判据：W0–W9（硬判据决定退出码；W3 为时序证据，不判 PASS/FAIL）
 * 用法：node scripts/verify-kernel-window.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const kb = require('../src/core/kernel-bridge.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `kb-window-${Date.now().toString(36)}`;
const PORT = 9321;
const UDD = path.join(ROOT, 'temp', TAG, 'profile');
const HELPER = path.join(ROOT, 'prototype', 'win32-helper.ps1');
const OUT = path.join(ROOT, 'scripts', 'verify-kernel-window.result.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(id, name, pass, detail = '') {
  results.push({ id, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} ${name} | ${detail}`);
}
function note(id, name, detail) {
  results.push({ id, name, pass: null, detail, note: true });
  console.log(`NOTE | ${id} ${name} | ${detail}`);
}

/* ── CDP HTTP ── */
function cdpList(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

/* ── 常驻 Win32 helper 客户端 ── */
class Helper {
  constructor() {
    this.lines = [];
    this.pending = [];
    this.buf = '';
  }

  static async launch() {
    const h = new Helper();
    h.proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    h.proc.stdout.setEncoding('utf8');
    h.proc.stdout.on('data', (d) => h._onData(d));
    h.proc.stderr.setEncoding('utf8');
    h.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error(`[helper:err] ${s}`);
    });
    const hello = await h._read(15000);
    h.hello = JSON.parse(hello);
    return h;
  }

  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const ln = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (ln) this._deliver(ln);
    }
  }

  _deliver(ln) {
    const w = this.pending.shift();
    if (w) w(ln);
    else this.lines.push(ln);
  }

  _read(timeoutMs) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('helper read timeout')), timeoutMs);
      this.pending.push((ln) => {
        clearTimeout(t);
        resolve(ln);
      });
    });
  }

  async send(obj, timeoutMs = 10000) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return JSON.parse(await this._read(timeoutMs));
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

/* ── 主流程 ── */
(async () => {
  fs.mkdirSync(UDD, { recursive: true });

  const kernelPath = kb.findKernel();
  check('W0', '本机内核探测', !!kernelPath, kernelPath || '未找到 Edge/Chrome');

  const helper = await Helper.launch();
  check('W1', '常驻 Win32 helper 就绪', !!helper.hello?.ready, `helperPid=${helper.hello?.helperPid}`);

  const t0 = Date.now();
  const s = await kb.createKernelSession(kernelPath, UDD, PORT, {});
  const bootMs = Date.now() - t0;
  check('W2', '内核启动并就绪（真实 pid 已解析）', !!s.alive && !!s.kernelPid, `${bootMs}ms, kernelPid=${s.kernelPid}, spawnPid=${s.pid}`);

  // W3：boot 返回瞬间的窗口存在性 —— 时序证据（不判 PASS/FAIL）
  const first = await helper.send({ cmd: 'findWindows', pids: [s.kernelPid] });
  const visAtBoot = (first.windows || []).filter((w) => w.visible && w.parent === 0);
  note(
    'W3',
    'boot 返回瞬间窗口存在性（时序证据）',
    `窗口总数=${(first.windows || []).length}，可见顶层=${visAtBoot.length}` +
      (visAtBoot.length ? `，hwnd=${visAtBoot.map((w) => w.hwnd).join(',')}` : ' → 证实必须轮询等待'),
  );

  // W4：轮询等待内核主窗口（可见 + 顶层 + Chromium 类名 + 标题非空）
  let main = null;
  const deadline = Date.now() + 8000;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const r = await helper.send({ cmd: 'findWindows', pids: [s.kernelPid] });
    const cand = (r.windows || []).find(
      (w) => w.visible && w.parent === 0 && /Chrome_WidgetWin/i.test(w.cls) && String(w.title || '').trim().length > 0,
    );
    if (cand) {
      main = cand;
      break;
    }
    await sleep(250);
  }
  const waitMs = 8000 - Math.max(0, deadline - Date.now());
  check(
    'W4',
    '轮询取到内核主窗口（可见/顶层/Chromium 类名/标题非空）',
    !!main,
    main ? `hwnd=${main.hwnd} cls=${main.cls} title="${main.title}" 轮询${polls}次≈${waitMs}ms` : `8s 内未取到（轮询${polls}次）`,
  );

  if (main) {
    check(
      'W5',
      '窗口属主 pid == kernelPid 且 ≠ spawn pid',
      main.pid === s.kernelPid && main.pid !== s.pid,
      `windowPid=${main.pid}, kernelPid=${s.kernelPid}, spawnPid=${s.pid}`,
    );

    // 窗口标题形态为「<页面标题> - <profile 名> - <浏览器名>」，故判据取"包含"而非"相等"
    const pages = await cdpList(PORT);
    const pageTitle = ((pages || []).find((p) => p.type === 'page') || {}).title || '';
    check(
      'W6',
      '窗口标题包含 CDP page 标题（交叉印证同一实例）',
      !!pageTitle && String(main.title).includes(String(pageTitle)),
      `窗口="${main.title}" / CDP(page)="${pageTitle}"`,
    );
  } else {
    check('W5', '窗口属主 pid == kernelPid 且 ≠ spawn pid', false, '无候选窗口');
    check('W6', '窗口标题与 CDP page 标题交叉一致', false, '无候选窗口');
  }

  // W7：helper 往返延迟基准
  const N = 50;
  const lat = [];
  for (let i = 0; i < N; i += 1) {
    const t = Date.now();
    await helper.send({ cmd: 'ping' });
    lat.push(Date.now() - t);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(N * 0.5)];
  const p95 = lat[Math.floor(N * 0.95)];
  check(
    'W7',
    `helper 往返延迟 P50 < 20ms（热路径可用）`,
    p50 < 20,
    `P50=${p50}ms P95=${p95}ms max=${lat[N - 1]}ms min=${lat[0]}ms（${N}次 ping）`,
  );

  // W8：对内核窗口的无害 Win32 调用（读矩形 + 原位还原）
  if (main) {
    const r1 = await helper.send({ cmd: 'getRect', hwnd: main.hwnd });
    const rc = String(r1.rect || '').split('|').map(Number);
    const okRect = r1.ok && rc.length === 4 && rc.every((n) => Number.isFinite(n));
    let okPos = false;
    let detail = `rect=${r1.rect}`;
    if (okRect) {
      const cx = rc[2] - rc[0];
      const cy = rc[3] - rc[1];
      const r2 = await helper.send({
        cmd: 'setWindowPos',
        hwnd: main.hwnd,
        x: rc[0],
        y: rc[1],
        cx,
        cy,
        flags: 0x0004 | 0x0010, // SWP_NOZORDER | SWP_NOACTIVATE —— 原位还原，不改 Z 序也不抢焦点
      });
      okPos = !!r2.applied;
      detail += ` → setWindowPos(原位)=${r2.applied} rect2=${r2.rect}`;
    }
    check('W8', 'helper 对内核窗口的可操作性与安全性', okRect && okPos, detail);
  } else {
    check('W8', 'helper 对内核窗口的可操作性与安全性', false, '无候选窗口');
  }

  // W9：关闭后窗口消失 + 端口释放
  const hwndForCheck = main?.hwnd;
  const shut = await s.shutdown();
  await sleep(1200);
  const gone = hwndForCheck ? !(await helper.send({ cmd: 'isWindow', hwnd: hwndForCheck })).exists : false;
  const portFree = (await cdpList(PORT, 1500)) === null;
  check(
    'W9',
    '关闭后内核窗口消失且端口释放',
    shut.ended && gone && portFree,
    `shutdown=${JSON.stringify(shut)} hwnd已销毁=${gone} portFree=${portFree}`,
  );

  helper.kill();

  const hard = results.filter((r) => !r.note);
  const passed = hard.filter((r) => r.pass).length;
  const summary = `${passed}/${hard.length} PASS`;
  console.log(`\n# 结果：${summary}，明细 ${OUT}`);
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      { tag: TAG, port: PORT, kernelPath, summary: `${passed}/${hard.length}`, results },
      null,
      2,
    ),
    'utf8',
  );
  process.exit(passed === hard.length ? 0 : 1);
})().catch(async (e) => {
  console.error(`ERROR | ${e && e.stack}`);
  process.exit(1);
});
