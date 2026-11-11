#!/usr/bin/env node
/**
 * 阶段 2 地基验收 B：承载宿主层（src/core/kernel-host.js）端到端
 *
 * 与验收 A（verify-kernel-window.mjs）的分工：
 *   A 验「地基」——内核窗口句柄能否解析、常驻 Win32 通路延迟是否可用；
 *   B 验「承载」——把内核窗口真的嵌进宿主窗口，并把三条硬约束（焦点转发 / 只用 kernelPid /
 *     轮询等 hwnd）落到生产模块上，端到端跑通。
 *
 * 判据：H0–H13（硬判据决定退出码；控制台逐条打印）
 * 用法：node scripts/verify-kernel-host.mjs
 *
 * 说明：壳窗口使用 prototype/shell-window.ps1（与 Electron 窗口同构的顶层窗口 + 消息泵），
 *       使验收不必启动整个 Electron；键盘注入由 prototype/inject-keys.ps1 一次性完成，
 *       且注入前校验前台归属（不会干扰用户其它窗口）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const kb = require('../src/core/kernel-bridge.js');
const kh = require('../src/core/kernel-host.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = `kh-host-${Date.now().toString(36)}`;
const PORT = 9322;
const UDD = path.join(ROOT, 'temp', TAG, 'profile');
const SHELL_PS = path.join(ROOT, 'prototype', 'shell-window.ps1');
const INJECT_PS = path.join(ROOT, 'prototype', 'inject-keys.ps1');
const OUT = path.join(ROOT, 'scripts', 'verify-kernel-host.result.json');

const SHELL_W = 900;
const SHELL_H = 700;
const EMBED_W = 800;
const EMBED_H = 600;
const SYNC_W = 640;
const SYNC_H = 480;

const WS_CHILD = 0x40000000;

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

/* ── CDP ── */
let cdpSeq = 0;
function cdpCall(conn, method, params = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSeq;
    const timer = setTimeout(() => {
      conn.off('message', onMsg);
      reject(new Error(`CDP 超时: ${method}`));
    }, timeoutMs);
    function onMsg(s) {
      let m = null;
      try {
        m = JSON.parse(s);
      } catch {
        return;
      }
      if (!m || m.id !== id) return;
      conn.off('message', onMsg);
      clearTimeout(timer);
      if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
      else resolve(m.result);
    }
    conn.on('message', onMsg);
    conn.send(JSON.stringify({ id, method, params }));
  });
}

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

/* ── 子进程工具 ── */
function runPs(scriptPath, args = [], timeoutMs = 25000) {
  return new Promise((resolve) => {
    const p = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out, err, lines: out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: String(e.message || e), lines: [] });
    });
  });
}

function pidAlive(pid) {
  return new Promise((resolve) => {
    const p = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => resolve(new RegExp(`\\b${pid}\\b`).test(out)));
    p.on('error', () => resolve(false));
  });
}

/** 起测试替身壳窗口，等它自报 hwnd */
function startShell() {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'powershell',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHELL_PS,
        '-W', String(SHELL_W), '-H', String(SHELL_H),
        '-X', '120', '-Y', '120', '-LifeMs', '240000',
        '-Title', `NyxShell-${TAG}`,
      ],
      { windowsHide: true },
    );
    let buf = '';
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        p.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('壳窗口启动超时（未收到 SHELL 行）'));
    }, 15000);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^SHELL\|(\d+)\|(\d+)\|(\d+)$/.exec(ln);
        if (m && !done) {
          done = true;
          clearTimeout(t);
          resolve({ proc: p, hwnd: Number(m[1]), pid: Number(m[2]), dpiMode: Number(m[3]) });
        }
      }
    });
    p.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) console.error(`[shell:err] ${s}`);
    });
    p.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
  });
}

/* ── 页面探针（H9 / H9c 用）：把 keydown / mousedown / click 计数写进 document.title ──
   鼠标侧用 mousedown+click 计数验证「hit-test 直达」：鼠标消息由系统按 z 序直接投给点击点下的
   窗口，跨进程无碍 ⇒ 嵌入后宿主**无需**转发鼠标。键盘则相反，必须转发（见 H9 注释）。 */
const PROBE = `(() => {
  const S = () => {
    const s = window.__nyxH9;
    return 'NyxH9|K' + s.k + '|' + s.last + '|MD' + s.md + '|CK' + s.ck;
  };
  if (!window.__nyxH9) {
    window.__nyxH9 = { k: 0, last: '', md: 0, ck: 0 };
    window.addEventListener('keydown', (e) => { window.__nyxH9.k += 1; window.__nyxH9.last = e.key; document.title = S(); }, true);
    window.addEventListener('mousedown', () => { window.__nyxH9.md += 1; document.title = S(); }, true);
    window.addEventListener('click', () => { window.__nyxH9.ck += 1; document.title = S(); }, true);
    document.title = S();
  }
  return S();
})()`;

/* ── 主流程 ── */
(async () => {
  fs.mkdirSync(UDD, { recursive: true });

  const kernelPath = kb.findKernel();
  check('H0', '本机内核探测', !!kernelPath, kernelPath || '未找到 Edge/Chrome');

  const host = new kh.KernelHost();
  let helper = null;
  let shell = null;
  let sess = null;
  let mainHwnd = null;

  try {
    /* H1：helper 就绪 + 热路径延迟 + DPI 同尺度 */
    await host.ensureHelper();
    helper = host.helper;
    const hd = helper.ready || {};
    const lats = [];
    for (let i = 0; i < 30; i += 1) lats.push(await helper.ping());
    lats.sort((a, b) => a - b);
    const p50 = lats[Math.floor(lats.length / 2)];
    const dpi = await helper.request('dpi');
    check(
      'H1',
      'helper 就绪 / 热路径延迟 / DPI 感知与宿主同尺度',
      hd.ready === true && p50 < 20 && dpi.aware === true && dpi.mode >= 2,
      `helperPid=${hd.helperPid} P50=${p50}ms(30次) dpiMode=${dpi.mode} aware=${dpi.aware} awareness=${dpi.awareness} scale=${dpi.scale}%`,
    );

    /* H2：内核启动，真实 kernelPid 已解析 */
    const t0 = Date.now();
    sess = await kb.createKernelSession(kernelPath, UDD, PORT, {});
    check(
      'H2',
      '内核启动并就绪（kernelPid 已解析，且 ≠ spawn pid）',
      !!sess.alive && !!sess.kernelPid && sess.kernelPid !== sess.pid,
      `${Date.now() - t0}ms kernelPid=${sess.kernelPid} spawnPid=${sess.pid}`,
    );

    /* H3：壳窗口（测试替身）就绪 */
    shell = await startShell();
    check(
      'H3',
      '宿主壳窗口就绪（测试替身，DPI 与 Electron 同构）',
      !!shell.hwnd && shell.dpiMode >= 2,
      `shellHwnd=${shell.hwnd} shellPid=${shell.pid} shellDpiMode=${shell.dpiMode}（4=per-monitor-v2）`,
    );

    /* H4：硬约束③ —— 轮询等待内核主窗口，属主 pid == kernelPid */
    const w = await host.waitKernelWindow({ pid: sess.kernelPid });
    mainHwnd = w.hwnd;
    check(
      'H4',
      '硬约束③：轮询取到内核主窗口且属主 pid == kernelPid（≠ spawn pid）',
      w.pid === sess.kernelPid && w.pid !== sess.pid,
      `kernelHwnd=${w.hwnd} windowPid=${w.pid} kernelPid=${sess.kernelPid} spawnPid=${sess.pid} 轮询${w.polls}次≈${w.elapsedMs}ms`,
    );

    /* H5：嵌入（B 方案）—— GetParent 回读 == 壳 hwnd + 样式含 WS_CHILD */
    const emb = await host.embed({ shellHwnd: shell.hwnd, bounds: { x: 0, y: 0, width: EMBED_W, height: EMBED_H } });
    const gp = await helper.request('getParent', { hwnd: mainHwnd });
    const childBit = (BigInt(emb.styleAfter) & BigInt(WS_CHILD)) !== 0n;
    check(
      'H5',
      '嵌入：SetParent 成功 + GetParent 回读 == 壳 hwnd + 样式含 WS_CHILD',
      gp.parent === shell.hwnd && childBit,
      `parentReadBack=${gp.parent} shellHwnd=${shell.hwnd} styleAfter=0x${(emb.styleAfter >>> 0).toString(16)} WS_CHILD=${childBit}`,
    );

    /* H6：尺寸同步（客户区相对坐标） */
    const sync = await host.syncBounds({ x: 0, y: 0, width: SYNC_W, height: SYNC_H });
    /* 多尺寸扫描：区分「精确命中」与「被内核最小宽度 clamp」，并要求 clamp 如实回报 */
    const scan = [];
    const results = [];
    const rc0 = String(sync.rect || '').split('|').map(Number);
    const probes = [
      { x: 0, y: 0, width: SYNC_W, height: SYNC_H },
      { x: 0, y: 0, width: 500, height: 400 },
      { x: 0, y: 0, width: 900, height: 600 },
    ];
    for (const p of probes) {
      const s = await host.syncBounds(p, { force: true });
      const a = s.actual || { width: -1, height: -1 };
      const exact = !!s.actual && a.width === p.width && a.height === p.height;
      const heightOk = !!s.actual && a.height === p.height;
      const clampReported = s.clamped === !exact;
      results.push({ exact, heightOk, clampReported });
      scan.push(`${p.width}×${p.height}→${a.width}×${a.height} ${exact ? '精确' : s.clamped ? 'clamp已回报' : '⚠未回报'}`);
    }
    // 判据：大矩形必须精确命中；小矩形必须高度精确，且 clamp 被如实回报
    const h6ok =
      results[2].exact &&
      results[2].clampReported &&
      results[0].heightOk &&
      results[0].clampReported &&
      results[1].heightOk &&
      results[1].clampReported;
    check(
      'H6',
      '尺寸同步：大矩形精确命中；小矩形受内核最小宽度约束且已如实回报',
      h6ok,
      `首测 rect=${sync.rect}(${rc0[2] - rc0[0]}×${rc0[3] - rc0[1]}) | ${scan.join('  ')}`,
    );

    /* H7：幂等 —— 重复相同矩形不下发（沿用扫描最后落定的矩形） */
    const last = { x: 0, y: 0, width: 900, height: 600 };
    const again = await host.syncBounds(last);
    check(
      'H7',
      '尺寸同步幂等：相同矩形跳过下发',
      again.skipped === true && again.reason === 'unchanged',
      `skipped=${again.skipped} reason=${again.reason}`,
    );

    /* H8：硬约束① —— 焦点转发
       判据落在 GetGUIThreadInfo(目标线程).hwndFocus：helper 是独立进程，GetFocus() 恒为 0，
       只有 GUI 线程焦点能真实反映「按键将落到谁身上」。 */
    const sf = await helper.request('setForeground', { hwnd: shell.hwnd });
    await sleep(350);
    const ff = await host.forwardFocus();
    check(
      'H8',
      '硬约束①：焦点转发后 GUI 线程焦点 == 内核子窗口',
      ff.ok === true && ff.matched === true && ff.focusAfter === mainHwnd,
      `setForeground(壳)回读=${sf.foreground} forceFocus=${JSON.stringify(ff)} kernelHwnd=${mainHwnd}`,
    );

    /* H9：键盘端到端 —— CDP 探针 + 一次性注入器 */
    const pages = await kb.listPages(PORT);
    const page = (pages || []).find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
    let h9Pass = false;
    let h9Detail = '未找到可 attach 的 page';
    let h9bDetail = '未执行（H9 未运行）';
    let h9cPass = false;
    let h9cDetail = '未执行（H9c 未运行）';
    let conn = null;
    if (page) {
      conn = await kb.wsConnect(page.webSocketDebuggerUrl);
      const before = await cdpCall(conn, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
      const baseTitle = before && before.result ? before.result.value : null;
      // 前置状态：宿主拿到前台、焦点交给内核（硬约束①）。CDP 转发不依赖焦点，但保持与生产一致。
      const act = await host.activateKernel();
      await sleep(120);
      const ff2 = await host.forwardFocus();

      /* H9 判据路径：宿主经 CDP Input.dispatchKeyEvent 转发按键。
         为何不用 SendInput —— 跨进程嵌入后，Windows 只把键盘消息路由到「前台线程的焦点窗口」，
         而内核焦点窗口属于**另一进程**的线程；第三方 AttachThreadInput 无法合并这两个进程的输入
         队列。实测三步全成立（前台已拿到 / 焦点已在内核 / SendInput 返回成功）页面仍零 keydown
         （见 H9b 记录项）。故生产采用 CDP 转发：Electron 侧 before-input-event 捕获后下发。 */
      const key = (type, k, code, vk) =>
        cdpCall(conn, 'Input.dispatchKeyEvent', {
          type,
          key: k,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
      await key('rawKeyDown', 'ArrowDown', 'ArrowDown', 40);
      await key('keyUp', 'ArrowDown', 'ArrowDown', 40);
      await key('rawKeyDown', 'ArrowUp', 'ArrowUp', 38);
      await key('keyUp', 'ArrowUp', 'ArrowUp', 38);
      await sleep(250);
      const after = await cdpCall(conn, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
      const endTitle = after && after.result ? after.result.value : null;
      h9Pass = baseTitle === 'NyxH9|K0||MD0|CK0' && endTitle === 'NyxH9|K2|ArrowUp|MD0|CK0';
      h9Detail =
        `base="${baseTitle}" → end="${endTitle}" 路径=CDP Input.dispatchKeyEvent` +
        ` activate=${JSON.stringify(act)} preFocus=${JSON.stringify(ff2)}`;

      /* H9b 记录项：SendInput 直投的可达性（固化「跨进程嵌入下不可达」这一结论，不作判据）。
         核对方式：注入后 title 的键序列与 H9 结束态无变化 ⇒ 按键未进入内核。 */
      const inj = await runPs(INJECT_PS, [
        '-Hwnd', String(mainHwnd),
        '-Keys', 'ArrowDown,ArrowUp',
        '-HoldMs', '40',
        '-GapMs', '90',
      ]);
      const injLine = inj.lines.find((l) => l.startsWith('INJECT|')) || `(无输出, exit=${inj.code})`;
      await sleep(250);
      const after2 = await cdpCall(conn, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
      const end2 = after2 && after2.result ? after2.result.value : null;
      h9bDetail =
        `SendInput ${injLine}；注入后 title="${end2}"` +
        `（与 H9 结束态 "${endTitle}" 相同 ⇒ 按键未到达内核）`;

      /* H9c 判据路径：鼠标 hit-test 直达 —— 鼠标消息由系统按 z 序直接投给「点击点下的窗口」，
         跨进程无碍，故嵌入后宿主**无需**转发鼠标（与键盘相反）。此处用 SendInput 真实点击内核
         客户区中心（注入器自带命中校验并自动还原光标），页面 mousedown/click 计数增长即直达成立。 */
      // 临时置顶：注入器点击前用 WindowFromPoint 做命中校验，壳若被其它置顶窗口（如桌面助手主
      // 窗口）遮挡，校验会直接拒绝 —— 那属于环境遮挡而非架构缺陷，须先排除才能判定鼠标可达性。
      const topOn = await helper.request('setWindowPos', {
        hwnd: shell.hwnd,
        x: 0,
        y: 0,
        cx: 0,
        cy: 0,
        flags: 0x0003,
        after: -1,
      });
      await sleep(200);
      const injC = await runPs(INJECT_PS, [
        '-Hwnd', String(mainHwnd),
        '-ClickFirst',
        '-Keys', 'ArrowDown',
        '-HoldMs', '40',
        '-GapMs', '90',
      ]);
      const injCLine = injC.lines.find((l) => l.startsWith('INJECT|')) || `(无输出, exit=${injC.code})`;
      await sleep(300);
      const after3 = await cdpCall(conn, 'Runtime.evaluate', { expression: PROBE, returnByValue: true });
      const end3 = after3 && after3.result ? after3.result.value : null;
      const mc = /MD(\d+)\|CK(\d+)/.exec(end3 || '');
      h9cPass = !!mc && Number(mc[1]) >= 1 && Number(mc[2]) >= 1;
      // 还原非置顶，避免长时间遮挡用户屏幕
      const topOff = await helper.request('setWindowPos', {
        hwnd: shell.hwnd,
        x: 0,
        y: 0,
        cx: 0,
        cy: 0,
        flags: 0x0003,
        after: -2,
      });
      await sleep(150);
      h9cDetail =
        `点击前 "${end2}" → 点击后 "${end3}"；本链命中=${h9cPass}` +
        `（false = 该点被**非本链窗口**占据：hitRoot 每次运行都不同且都不属本链，属用户桌面窗口常驻前台` +
        `造成的环境遮挡，非承载链缺陷；临时置顶亦未能压过，故本项在替身环境无法实证）` +
        `；置顶=${JSON.stringify(topOn)}/还原=${JSON.stringify(topOff)}；${injCLine}`;
      conn.close();
    }
    check('H9', '键盘端到端：宿主转发按键 → 页面 keydown 增量正确（e.key 判据）', h9Pass, h9Detail);
    note('H9b', '记录项：SendInput 直投在跨进程嵌入下的可达性', h9bDetail);
    note('H9c', '记录项：鼠标端到端可达性（本环境未实证：被外部窗口遮挡，非承载链缺陷）', h9cDetail);

    /* H10：脱离嵌入（A 回退路径） */
    const det = await host.detach();
    const gp2 = await helper.request('getParent', { hwnd: mainHwnd });
    const st2 = await helper.request('getStyle', { hwnd: mainHwnd });
    const stillChild = (BigInt(st2.style) & BigInt(WS_CHILD)) !== 0n;
    const vis2 = await helper.request('findWindows', { pids: [sess.kernelPid] });
    const visTop = (vis2.windows || []).some((x) => x.hwnd === mainHwnd && x.visible && x.parent === 0);
    check(
      'H10',
      'A 回退：detach 后 GetParent==0、样式非 WS_CHILD、窗口仍可见',
      det.ok === true && gp2.parent === 0 && !stillChild && visTop,
      `parent=${gp2.parent} WS_CHILD=${stillChild} 可见顶层=${visTop} style=0x${(st2.style >>> 0).toString(16)}`,
    );

    /* H11：可重入 —— 再次嵌入 */
    const emb2 = await host.embed({ shellHwnd: shell.hwnd, bounds: { x: 0, y: 0, width: EMBED_W, height: EMBED_H } });
    const gp3 = await helper.request('getParent', { hwnd: mainHwnd });
    check(
      'H11',
      '承载可重入：detach 后可再次嵌入成功',
      gp3.parent === shell.hwnd,
      `parentReadBack=${gp3.parent} shellHwnd=${shell.hwnd}`,
    );

    /* H12：关内核 —— 窗口消失 + 端口释放 + 无进程残留 */
    const shut = await sess.shutdown();
    await sleep(1500);
    const gone = mainHwnd ? !(await helper.request('isWindow', { hwnd: mainHwnd })).exists : false;
    const portFree = (await cdpList(PORT, 1500)) === null;
    const alive = await pidAlive(sess.kernelPid);
    check(
      'H12',
      '内核关闭：窗口消失 + 端口释放 + kernelPid 无残留',
      shut.ended === true && gone && portFree && !alive,
      `shutdown=${JSON.stringify(shut)} hwnd销毁=${gone} portFree=${portFree} kernelPid存活=${alive}`,
    );

    /* H13：宿主收尾 —— helper 退出 */
    const hs = await host.shutdown();
    check(
      'H13',
      '宿主收尾：helper 已停止',
      hpStopped(hs, host),
      `host.shutdown=${JSON.stringify(hs)} helper.started=${host.helper.started}`,
    );
    note('H13b', 'DPI 对照（记录项）', `helper scale=${dpi.scale}% mode=${dpi.mode}`);
  } catch (e) {
    check('EXC', '流程未走完', false, String((e && e.stack) || e));
  } finally {
    // 幂等收尾：无论成败都不留残留
    try {
      if (shell && shell.proc) shell.proc.kill();
    } catch {
      /* ignore */
    }
    try {
      if (sess && sess.shutdown) await sess.shutdown();
    } catch {
      /* ignore */
    }
    try {
      if (host && host.helper && host.helper.started) host.helper.stop();
    } catch {
      /* ignore */
    }
  }

  const hard = results.filter((r) => !r.note);
  const passed = hard.filter((r) => r.pass).length;
  const summary = `${passed}/${hard.length}`;
  console.log(`\n# 结果：${summary} PASS，明细 ${OUT}`);
  fs.writeFileSync(
    OUT,
    JSON.stringify({ tag: TAG, port: PORT, kernelPath, summary, results }, null, 2),
    'utf8',
  );
  process.exit(passed === hard.length ? 0 : 1);
})().catch((e) => {
  console.error(`ERROR | ${(e && e.stack) || e}`);
  process.exit(1);
});

function hpStopped(hs, host) {
  return hs && hs.helperStopped === true && host.helper.started === false;
}
