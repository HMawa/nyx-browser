'use strict';

/**
 * kernel-host.js —— Nyx 内核承载宿主层（阶段 2）
 *
 * 职责：把「真内核（系统 Edge / Chrome）」的顶层窗口以 B 方案（跨进程 SetParent 嵌入）
 * 承载进 Nyx 宿主窗口，并为运行期提供尺寸同步、焦点转发与干净退出；嵌入失败时可供
 * 上层降级到 A 方案（独立顶层窗口）。
 *
 * 为什么需要常驻 helper（prototype/win32-helper.ps1）：
 *   Electron 主进程无法直接调 Win32，而焦点转发是**每次交互都触发**的热路径；
 *   一次性 spawn PowerShell 往返 300–500ms 不可用。实测常驻 + 行 JSON 管道
 *   P50 = 0ms / P95 = 1ms（见 scripts/verify-kernel-window.result.json 的 W7）。
 *
 * 三条硬约束（来源 PROGRESS「二·补 11」「二·补 12」，实现中不得省略）：
 *   ① **焦点转发**：宿主每次自身获得焦点 / 被点击 / 从非激活态恢复时，必须显式
 *      setFocus(内核子窗口)。嵌入后系统焦点默认停在壳窗口，且**点击内核区域并不会**
 *      把焦点交给子窗口（鼠标按坐标 hit-test 直达，与焦点链是两条独立通路）。
 *      不转发 → 用户点击内核后键盘**静默失效**（鼠标仍正常，极易漏测）。
 *   ② **进程归属**：一律用真实内核 pid（kernelPid），**禁用 spawn pid** —— Edge 首次以
 *      新建 user-data-dir 启动会 relaunch，spawn 进程 300ms 内即退出，进程树随之断裂。
 *   ③ **句柄时机**：取内核窗口 hwnd 必须**轮询等待**其出现且属主 pid == kernelPid，
 *      不能沿用 boot 返回时机（relaunch 发生在 boot 返回之后）。
 *
 * 实现约定：
 *   - CJS，供 Electron 主进程直接 require；纯 Node 亦可 require（模块顶层不依赖
 *     electron），便于离线验收脚本驱动。
 *   - 零第三方依赖：helper 为纯 PowerShell + Add-Type，模块侧只用 node 内置。
 *   - **坐标语义（易错点）**：SetParent 之后，setWindowPos 的 x/y 是**相对壳窗口客户区**；
 *     而 getWindowRect 返回的永远是屏幕坐标。故 syncBounds() 收的是「客户区相对矩形」；
 *     仅在窗口为顶层时（A 回退 / detach 之后）才用屏幕坐标摆放。
 *   - 所有对内核窗口的写操作都带 SWP_NOACTIVATE：**绝不主动抢焦点**，焦点只由
 *     forwardFocus() 显式转发决定。
 */

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');

/* ────────────────────────── 常量 ────────────────────────── */

const DEFAULT_REQUEST_TIMEOUT = 3000; // 普通命令（含 findWindows 枚举）
const FOCUS_REQUEST_TIMEOUT = 1200; // 焦点转发：热路径，宁可快速失败也不拖 UI
const HELPER_START_TIMEOUT = 15000; // 首次 spawn PowerShell + Add-Type 编译约 1–2s，留足余量
const WINDOW_POLL_MS = 200; // 等待内核窗口的轮询间隔
const WINDOW_WAIT_TIMEOUT = 10000; // 等待内核窗口的上限

const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────── helper 定位 ────────────────────────── */

/**
 * 定位 Win32 helper 脚本。
 * 打包态应置于 resources 目录（electron-builder 的 extraResources）——
 * .ps1 不能放 asar 内，PowerShell 读不到；开发态取仓库 prototype 目录。
 */
function findHelper() {
  const cands = [];
  if (process.resourcesPath) cands.push(join(process.resourcesPath, 'win32-helper.ps1'));
  cands.push(join(__dirname, '..', '..', 'prototype', 'win32-helper.ps1'));
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

/** 判定候选窗口是否为「内核主窗口」：可见 / 顶层 / Chromium 窗口类 / 标题非空 */
function isKernelMainWindow(w) {
  return (
    !!w &&
    w.visible === true &&
    Number(w.parent) === 0 &&
    /Chrome_WidgetWin/i.test(String(w.cls || '')) &&
    String(w.title || '').trim().length > 0
  );
}

function normBounds(b) {
  if (!b) return null;
  const x = Math.round(Number(b.x));
  const y = Math.round(Number(b.y));
  const width = Math.round(Number(b.width ?? b.cx));
  const height = Math.round(Number(b.height ?? b.cy));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

const sameBounds = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/* ────────────────────────── 常驻 helper 客户端 ────────────────────────── */

/**
 * Win32Helper —— 常驻 PowerShell helper 的行 JSON 客户端。
 * 协议：每行 `{"id":n,"cmd":"..."}` → 每行 `{"id":n,"ok":true,...}`（helper 回显 id）。
 * 兼容无 id 的旧响应：当且仅当恰有一个在途请求时交付给它。
 */
class Win32Helper extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.helperPath = opts.helperPath || findHelper();
    this.requestTimeout = opts.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
    this.startTimeout = opts.startTimeout || HELPER_START_TIMEOUT;
    this.proc = null;
    this.started = false;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.ready = null; // helper 自报 { ready, helperPid }
    this.exitInfo = null;
    this.latency = { last: null, p50: null, samples: 0 };
    this._lat = [];
  }

  start() {
    if (this.started) return Promise.resolve(this.ready);
    if (!this.helperPath) return Promise.reject(new Error('win32-helper.ps1 未找到（打包态需放入 resources）'));

    this.proc = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.started = true;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) this.emit('helper-stderr', s);
    });
    this.proc.on('exit', (code, signal) => this._onExit(code, signal));
    this.proc.on('error', (e) => this._onExit(null, null, e));

    // helper 首行自报 ready（无 id）→ 用一个临时 pending 承接
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('helper 启动超时（未收到 ready）')), this.startTimeout);
      this.pending.set('__ready__', {
        resolve: (line) => {
          clearTimeout(timer);
          try {
            this.ready = JSON.parse(line);
            resolve(this.ready);
          } catch (e) {
            reject(new Error(`helper ready 行解析失败: ${e.message}`));
          }
        },
        reject,
        timer,
      });
    });
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

  _deliver(line) {
    // 1) ready 行
    const rw = this.pending.get('__ready__');
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {
      /* 非 JSON 行（如 helper 的进度输出）直接丢弃 */
    }
    if (rw && msg && msg.ready) {
      this.pending.delete('__ready__');
      rw.resolve(line);
      return;
    }
    // 2) 按 id 匹配
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const w = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    // 3) 兼容：恰有一个在途请求时交付
    const keys = [...this.pending.keys()].filter((k) => k !== '__ready__');
    if (keys.length === 1) {
      const w = this.pending.get(keys[0]);
      this.pending.delete(keys[0]);
      clearTimeout(w.timer);
      w.resolve(msg || { ok: false, error: 'non-json response' });
      return;
    }
    this.emit('helper-noise', line);
  }

  _onExit(code, signal, err) {
    this.exitInfo = { code, signal, error: err ? String(err.message || err) : null, at: Date.now() };
    const e = new Error(`win32 helper 已退出（code=${code} signal=${signal}${err ? ' ' + err.message : ''}）`);
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.pending.clear();
    this.started = false;
    this.emit('exit', this.exitInfo);
  }

  /** 发一条命令并等响应；失败/超时 reject（调用方决定是否降级） */
  request(cmd, params = {}, timeoutMs = this.requestTimeout) {
    if (!this.started || !this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      return Promise.reject(new Error('win32 helper 未运行'));
    }
    const id = ++this.seq;
    const payload = JSON.stringify({ id, cmd, ...params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper 命令超时: ${cmd}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** 往返延迟采样（热路径体检用） */
  async ping() {
    const t = Date.now();
    await this.request('ping', {}, FOCUS_REQUEST_TIMEOUT);
    const dt = Date.now() - t;
    this.latency.last = dt;
    this._lat.push(dt);
    if (this._lat.length > 64) this._lat.shift();
    const s = [...this._lat].sort((a, b) => a - b);
    this.latency.p50 = s[Math.floor(s.length / 2)];
    this.latency.samples = s.length;
    return dt;
  }

  /** 停止 helper：杀进程并让所有在途请求失败（宿主退出/降级时调用） */
  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.started = false;
  }
}

/* ────────────────────────── 承载宿主 ────────────────────────── */

/**
 * KernelHost —— 内核窗口的承载编排。
 *
 * 用法（Electron 主进程）：
 *   const host = new KernelHost();
 *   await host.waitKernelWindow({ pid: kernelPid });          // 硬约束③
 *   await host.embed({ shellHwnd: win.getNativeWindowHandle(), bounds: {...} });
 *   win.on('focus', () => host.forwardFocus());               // 硬约束①
 *   win.on('resize', () => host.syncBounds(currentClientRect()));
 *   ...
 *   await host.shutdown();
 */
class KernelHost extends EventEmitter {
  constructor(opts = {}) {
    super();
    const shared = opts.helper instanceof Win32Helper ? opts.helper : null;
    this.helper = shared || new Win32Helper(opts);
    this.ownsHelper = !shared;
    this.kernelPid = null;
    this.kernelHwnd = null;
    this.shellHwnd = null;
    this.embedded = false;
    this.mode = 'none'; // none | embedded | top-level
    this.bounds = null;
    this.lastError = null;
    this.windowInfo = null; // findWindows 命中的原始记录
  }

  async ensureHelper() {
    if (!this.helper.started) await this.helper.start();
    return this.helper;
  }

  /**
   * 硬约束③：轮询等待内核主窗口出现，并用「属主 pid == kernelPid」证明是本次实例。
   * 硬约束②：只接受 kernelPid，签名为 pid 而非 spawnPid。
   */
  async waitKernelWindow({ pid, timeoutMs = WINDOW_WAIT_TIMEOUT, pollMs = WINDOW_POLL_MS } = {}) {
    const kernelPid = Number(pid ?? this.kernelPid);
    if (!Number.isFinite(kernelPid) || kernelPid <= 0) {
      throw new Error('kernel-host: 缺少 kernelPid（禁用 spawn pid，见硬约束②）');
    }
    this.kernelPid = kernelPid;
    await this.ensureHelper();

    const t0 = Date.now();
    const deadline = t0 + timeoutMs;
    let polls = 0;
    for (;;) {
      polls += 1;
      const r = await this.helper.request('findWindows', { pids: [kernelPid] });
      const cand = (r.windows || []).find(isKernelMainWindow);
      if (cand) {
        this.kernelHwnd = Number(cand.hwnd);
        this.windowInfo = cand;
        const info = { hwnd: this.kernelHwnd, pid: Number(cand.pid), title: cand.title, cls: cand.cls, polls, elapsedMs: Date.now() - t0 };
        this.emit('window-ready', info);
        return info;
      }
      if (Date.now() >= deadline) {
        const err = new Error(`kernel-host: ${timeoutMs}ms 内未等到内核窗口（pid=${kernelPid}，轮询 ${polls} 次）`);
        this.lastError = err.message;
        throw err;
      }
      await sleep(pollMs);
    }
  }

  /**
   * B 方案：嵌入。内部顺序固定 —— 容错重取 hwnd → setParent（含样式改写）→ 回读校验 → 摆位。
   * 校验不通过直接抛错（不谎报成功），由上层决定是否降级到 A 方案。
   */
  async embed({ shellHwnd, bounds, kernelPid, waitTimeoutMs } = {}) {
    if (kernelPid) this.kernelPid = Number(kernelPid);
    const shell = Number(shellHwnd);
    if (!Number.isFinite(shell) || shell <= 0) throw new Error('kernel-host: embed 需要有效 shellHwnd');
    await this.ensureHelper();

    // 句柄可能因页面导航/内核重启而失效：失效则重新等待（硬约束③）
    if (this.kernelHwnd) {
      const alive = await this.helper.request('isWindow', { hwnd: this.kernelHwnd });
      if (!alive.exists) this.kernelHwnd = null;
    }
    if (!this.kernelHwnd) await this.waitKernelWindow({ timeoutMs: waitTimeoutMs ?? WINDOW_WAIT_TIMEOUT });

    this.shellHwnd = shell;
    const r = await this.helper.request('setParent', { hwnd: this.kernelHwnd, parent: shell });
    if (!r.matched) {
      const err = new Error(`kernel-host: 嵌入失败，GetParent 回读未命中（readBack=${r.parentReadBack} shell=${shell}）`);
      this.lastError = err.message;
      this.emit('degrade', { reason: 'embed-failed', detail: err.message });
      throw err;
    }
    this.embedded = true;
    this.mode = 'embedded';
    this.bounds = null;

    if (bounds) await this.syncBounds(bounds, { force: true });
    const info = { kernelHwnd: this.kernelHwnd, shellHwnd: shell, styleAfter: r.styleAfter };
    this.emit('embedded', info);
    return info;
  }

  /**
   * 硬约束①的载体：把系统焦点显式转发给内核子窗口。
   * 宿主应在自身 focus / mousedown / 从非激活态恢复时调用（幂等，可重复调用）。
   *
   * 实现要点（实测踩过的坑，勿退回 SetFocus 方案）：
   *   · GetFocus() 只反映**调用线程**消息队列的焦点，helper 是独立进程，回读恒为 0；
   *   · SetFocus 跨线程需先 AttachThreadInput 挂钩前台线程，否则静默失败、焦点进不去内核。
   * 故统一走 helper 的 forceFocus：挂钩 → 置前台 → SetFocus → GetGUIThreadInfo 回读。
   */
  async forwardFocus() {
    if (!this.embedded || !this.kernelHwnd) return { skipped: true, reason: 'not-embedded' };
    try {
      const r = await this.helper.request('forceFocus', { hwnd: this.kernelHwnd }, FOCUS_REQUEST_TIMEOUT);
      if (!r.matched) {
        // 焦点没落上：可能是子窗口已被替换/销毁 —— 记录但不抛（热路径不能让异常冒到 UI）
        this.emit('focus-miss', r);
        return { ok: false, matched: false, focusAfter: r.focusAfter, fgAccepted: r.fgAccepted, inputAttached: r.inputAttached };
      }
      return { ok: true, matched: true, focusAfter: r.focusAfter, targetThread: r.targetThread, inputAttached: r.inputAttached };
    } catch (e) {
      this.lastError = e.message;
      this.emit('focus-error', e);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 激活内核（嵌入承载专用）：让内核窗口真正进入「激活」态。
   *
   * 为什么单靠 forwardFocus 不够：跨进程 SetParent 后内核子窗口不会自动收到激活消息，
   * 而 Chromium 只在内部 is_active_（由 WM_ACTIVATE 维护）为真时才处理键盘输入，否则按键被
   * 静默丢弃 —— 现象是注入成功、GUI 线程焦点也对，但页面零 keydown。另外本进程不在前台时
   * SetForegroundWindow 恒被拒（Foreground Lock），SendInput 的按键会落到用户当前的前台窗口
   * 而非内核；helper 侧的 activate 含前台锁解锁、置前台兜底与激活消息补投。
   */
  async activateKernel() {
    if (!this.embedded || !this.kernelHwnd) return { skipped: true, reason: 'not-embedded' };
    try {
      const r = await this.helper.request('activate', { hwnd: this.kernelHwnd }, FOCUS_REQUEST_TIMEOUT);
      const res = {
        ok: r.fgAccepted === true,
        fgAccepted: r.fgAccepted,
        fgIsRoot: r.fgIsRoot,
        foreground: r.foreground,
        focusAfter: r.focusAfter,
        inputAttached: r.inputAttached,
        inputLinked: r.inputLinked,
      };
      if (!res.ok) this.emit('activate-failed', res);
      return res;
    } catch (e) {
      this.lastError = e.message;
      this.emit('focus-error', e);
      return { ok: false, error: e.message };
    }
  }

  /**
   * 尺寸同步：bounds 为**相对壳窗口客户区**的矩形（SetParent 后的坐标语义）。
   * 相同矩形默认跳过（避免每帧下发）；传 force 可强制。
   */
  async syncBounds(bounds, { force = false, show = false } = {}) {
    if (!this.embedded || !this.kernelHwnd) return { skipped: true, reason: 'not-embedded' };
    const b = normBounds(bounds);
    if (!b) return { skipped: true, reason: 'bad-bounds', bounds: bounds || null };
    if (!force && sameBounds(this.bounds, b)) return { skipped: true, reason: 'unchanged', bounds: b };

    const flags = SWP_NOZORDER | SWP_NOACTIVATE | (show ? SWP_SHOWWINDOW : 0);
    const r = await this.helper.request('setWindowPos', {
      hwnd: this.kernelHwnd,
      x: b.x,
      y: b.y,
      cx: b.width,
      cy: b.height,
      flags,
    });
    if (r.applied) this.bounds = b;

    /* 回读实际矩形：Chromium 内核窗口带**最小宽度**约束（实测 150% 缩放下被抬到 ~772 物理 px，
       约合 500 DIP + 非客户区）。小于该值时 SetWindowPos 仍返回成功，但宽度被内核自行抬高；
       宿主若按请求值布局，会把「视图区」与「内核实际占位」算错（右侧溢出/错位）。
       故如实回报 actual / clamped，并抛事件让 UI 层按实际值排布。 */
    const rc = String(r.rect || '').split('|').map(Number);
    const actual =
      rc.length === 4 && rc.every((n) => Number.isFinite(n))
        ? { x: rc[0], y: rc[1], width: rc[2] - rc[0], height: rc[3] - rc[1] }
        : null;
    const clamped = !!actual && (actual.width !== b.width || actual.height !== b.height);
    if (clamped) this.emit('bounds-clamped', { requested: b, actual });

    return { ok: !!r.applied, bounds: b, actual, clamped, rect: r.rect };
  }

  /**
   * 退出嵌入（用于降级到 A 方案或宿主关闭前）。
   * screenBounds 传顶层窗口的目标屏幕坐标（不传则保持当前位置）。
   */
  async detach({ screenBounds, show = true } = {}) {
    if (!this.embedded || !this.kernelHwnd) return { skipped: true, reason: 'not-embedded' };
    const r = await this.helper.request('detach', { hwnd: this.kernelHwnd });
    this.embedded = false;
    this.mode = 'top-level';
    this.bounds = null;

    const b = normBounds(screenBounds);
    if (b) {
      await this.helper.request('setWindowPos', {
        hwnd: this.kernelHwnd,
        x: b.x,
        y: b.y,
        cx: b.width,
        cy: b.height,
        flags: SWP_NOZORDER | SWP_NOACTIVATE | (show ? SWP_SHOWWINDOW : 0),
      });
    } else if (show) {
      // 仅保证可见（不改位置尺寸）：SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW
      await this.helper.request('setWindowPos', {
        hwnd: this.kernelHwnd,
        x: 0,
        y: 0,
        cx: 0,
        cy: 0,
        flags: 0x0002 | 0x0001 | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
      });
    }
    this.emit('detached', { kernelHwnd: this.kernelHwnd, styleAfter: r.styleAfter, mode: this.mode });
    return { ok: true, mode: this.mode, ...r };
  }

  /** A 方案入口：确保内核是独立顶层窗口（已嵌入则先脱离），并按屏幕坐标摆放 */
  async ensureTopLevel({ screenBounds, show = true } = {}) {
    await this.ensureHelper();
    if (this.embedded) await this.detach({ screenBounds, show });
    else if (screenBounds) {
      const b = normBounds(screenBounds);
      if (b) {
        await this.helper.request('setWindowPos', {
          hwnd: this.kernelHwnd,
          x: b.x,
          y: b.y,
          cx: b.width,
          cy: b.height,
          flags: SWP_NOZORDER | SWP_NOACTIVATE | (show ? SWP_SHOWWINDOW : 0),
        });
      }
    }
    this.mode = 'top-level';
    return { mode: this.mode, kernelHwnd: this.kernelHwnd };
  }

  /** 内核窗口是否仍存在（宿主据此判断是否需重新 embed / 降级） */
  async kernelWindowAlive() {
    if (!this.kernelHwnd) return false;
    try {
      const r = await this.helper.request('isWindow', { hwnd: this.kernelHwnd }, FOCUS_REQUEST_TIMEOUT);
      return !!r.exists;
    } catch {
      return false;
    }
  }

  /**
   * 收尾：脱离嵌入 → 停 helper（helper 归本实例所有时）。
   * 不负责关内核进程 —— 那是 kernel-bridge 的 shutdown（按 kernelPid 整树回收）。
   */
  async shutdown() {
    const out = { detached: false, helperStopped: false, mode: this.mode };
    try {
      if (this.embedded) {
        await this.detach({ show: false });
        out.detached = true;
      }
    } catch (e) {
      out.detachError = e.message;
    }
    if (this.ownsHelper) {
      this.helper.stop();
      out.helperStopped = true;
    }
    this.embedded = false;
    this.mode = 'none';
    this.bounds = null;
    return out;
  }

  status() {
    return {
      kernelPid: this.kernelPid,
      kernelHwnd: this.kernelHwnd,
      shellHwnd: this.shellHwnd,
      mode: this.mode,
      embedded: this.embedded,
      bounds: this.bounds,
      helper: {
        started: this.helper.started,
        helperPid: this.helper.ready ? this.helper.ready.helperPid : null,
        pending: this.helper.pending.size,
        latency: this.helper.latency,
        exitInfo: this.helper.exitInfo,
      },
      lastError: this.lastError,
    };
  }
}

module.exports = {
  KernelHost,
  Win32Helper,
  findHelper,
  isKernelMainWindow,
  normBounds,
  SWP_NOZORDER,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
};
