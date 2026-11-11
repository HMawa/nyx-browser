'use strict';

/**
 * kernel-bridge.js —— Nyx 真内核桥接层（阶段 1 正式实现）
 *
 * 设计目标：同时落地路线①（原生能力）与路线③（真内核完整扩展支持）
 *   · 渲染面：系统 Chromium 系内核（Edge / Chrome / Chrome for Testing），复用，不编译
 *   · 控制面：Electron 主进程通过 CDP 端口模式编排
 *   · ① 原生能力：Fetch 拦截 / Network Cookie / Page 脚本注入，全部走 CDP，不依赖扩展
 *   · ③ 扩展能力：Extensions.loadUnpacked / uninstall / getExtensions，完整 MV3
 *
 * 实现约定：
 *   - 本模块为 CJS，供 Electron 主进程直接 require。
 *   - 不引入任何第三方依赖：Electron 31 主进程（Node 20.18）**没有全局 WebSocket**
 *     （实测 typeof WebSocket === 'undefined'），故内置一个贴合 CDP 需要的
 *     极简 RFC6455 客户端（文本帧 / 二进制帧 / 64 位长帧 / 分片 / ping-pong）。
 *   - 所有关键启动参数均经 Edge 149.0.4022.62 实测验证，勿删减。
 *
 * 验收：scripts/verify-kernel-bridge.mjs —— 五个 API 全通，见同目录 result.json。
 */

const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/* ───────────────────────────── 内核探测 ───────────────────────────── */

const KERNEL_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/** 探测可用内核；返回第一个命中的可执行文件路径，全部缺失时返回 null */
function findKernel() {
  for (const p of KERNEL_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

/* ───────────────────── 极简 WebSocket 客户端（零依赖） ───────────────────── */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragChunks = [];
    this.fragOpcode = 0;
    this.closed = false;

    if (head && head.length) this._push(head);
    socket.on('data', (d) => this._push(d));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
    socket.on('error', (e) => { this.closed = true; this.emit('error', e); });
  }

  _push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this._parseFrame()) { /* 连续解析，直到不足一帧 */ }
  }

  /** 返回 true 表示可能还有更多完整帧待解析 */
  _parseFrame() {
    const b = this.buf;
    if (b.length < 2) return false;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return false;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return false;
      const hi = b.readUInt32BE(off);
      const lo = b.readUInt32BE(off + 4);
      len = hi * 4294967296 + lo;
      off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return false;
      mask = b.subarray(off, off + 4);
      off += 4;
    }

    if (b.length < off + len) return false;

    let payload = b.subarray(off, off + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.subarray(off + len);
    this._handleFrame(fin, opcode, payload);
    return this.buf.length > 0;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x0) {                       // continuation
      this.fragChunks.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this.fragChunks);
      const op = this.fragOpcode;
      this.fragChunks = [];
      this.fragOpcode = 0;
      this._deliver(op, full);
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {     // text / binary
      if (!fin) { this.fragChunks = [payload]; this.fragOpcode = opcode; return; }
      this._deliver(opcode, payload);
      return;
    }
    if (opcode === 0x8) { this.close(); return; }      // close
    if (opcode === 0x9) { this._sendFrame(0xA, payload); return; }  // ping -> pong
    /* 0xA pong：忽略 */
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len % 4294967296, 6);
    }
    const mask = crypto.randomBytes(4);
    mask.copy(header, header.length - 4);
    const masked = Buffer.from(payload);       // 客户端出帧必须掩码（RFC6455 §5.3）
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try { this.socket.write(Buffer.concat([header, masked])); } catch { /* 连接可能已断 */ }
  }

  send(text) { this._sendFrame(0x1, Buffer.from(text, 'utf8')); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
  }
}

function wsConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket, head) => {
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        reject(new Error('WebSocket 握手校验失败'));
        return;
      }
      resolve(new WsConnection(socket, head));
    });
    req.on('response', (res) => reject(new Error(`WebSocket 握手被拒绝：HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

/* ─────────────────────────── CDP 会话封装 ─────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 以进程树方式强杀（Windows taskkill /T /F）。
 *
 * 仅在优雅退出（CDP `Browser.close`）未走通时兜底。只作用于自家内核 pid 及其子树，
 * 不会触碰用户日常运行的 Edge / Chrome —— 后者与本进程不共享进程树。
 * 之所以需要它：`proc.kill()` 是 TerminateProcess，只终止 browser 进程本身，
 * crashpad-handler 等旁支进程可能残留，与项目「退出后零残留」口径冲突。
 */
function taskkillTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    let child;
    try {
      child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * 端口占用预检。
 *
 * 若目标 CDP 端口已有一个能应答 `/json/version` 的实例在跑，说明端口被别的进程占了。
 * 此时**拒绝启动**：新内核会因端口冲突改端口或直接失败，而我们仍会 attach 到旧实例，
 * 产生"以为连的是新实例、其实连的是旧实例"的错乱
 * （双实例场景下表现为普通 / 隐私 profile 串台，属隐私红线级事故）。
 */
async function assertPortFree(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) {
      throw new Error(`CDP 端口 ${port} 已被其它内核实例占用，拒绝启动以避免 attach 到错误实例`);
    }
  } catch (err) {
    if (String(err && err.message).includes('已被其它内核实例占用')) throw err;
    /* 连接失败 = 端口空闲，符合预期 */
  }
}

/**
 * 内核存活探测：CDP `/json/version` 尚能应答即视为内核服务可用。
 *
 * 为什么不看 spawn 出的进程 —— 探针实测（temp/probe-relaunch.mjs，2026-09-21）：
 *   Edge 首次以**新建 user-data-dir** 启动时会 relaunch，spawn 出的进程
 *   在 300ms 内即以 code=0 退出，真正的 browser 是另一个 pid（实测 53308 → 55484）。
 *   结论：`proc.pid` 既不代表内核，也不能用于回收进程树（taskkill /T 会因树已断而空转）。
 */
async function pingCdp(port, timeoutMs = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 解析**真实内核 pid**（即 CDP 端口监听者 pid），用于进程树回收。
 *
 * 两条路，优先纯协议：
 *   1. CDP `SystemInfo.getProcessInfo` —— 必须走 **browser target** 连接
 *      （页面 session 调用会被拒：`only supported on the browser target`），
 *      取 type==='browser' 的那条 pid；
 *   2. `netstat -ano` 兜底 —— Windows 自带，无权限门槛（探针实测可靠）。
 *
 * @returns {Promise<number|null>} 解析失败返回 null，调用方须退化到 spawn pid 并警惕其失效。
 */
async function resolveKernelPid(port, browser) {
  if (browser) {
    try {
      const info = await browser.send('SystemInfo.getProcessInfo');
      const hit = ((info && info.processInfo) || []).find((x) => x.type === 'browser');
      if (hit && hit.id) return hit.id;
    } catch { /* 协议不支持则走 netstat */ }
  }
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const pids = [
      ...new Set(
        out
          .split(/\r?\n/)
          .filter((l) => l.includes(`:${port}`) && l.toUpperCase().includes('LISTENING'))
          .map((l) => Number(l.trim().split(/\s+/).pop()))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];
    return pids[0] || null;
  } catch {
    return null;
  }
}

/** 把一条 WebSocket 封装成带 id 关联 / 事件订阅的 CDP 连接 */
async function connect(wsUrl) {
  const ws = await wsConnect(wsUrl);
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`CDP ${m.error.message || ''} ${JSON.stringify(m.error)}`));
      else res(m.result);
    } else if (m.method && handlers.has(m.method)) {
      for (const cb of handlers.get(m.method)) {
        try { cb(m.params); } catch { /* 单个回调异常不影响会话 */ }
      }
    }
  });
  ws.on('error', () => { /* 交由各 pending 超时兜底 */ });

  return {
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        try { ws.send(JSON.stringify({ id, method, params })); }
        catch (e) { pending.delete(id); rej(e); return; }
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); }
        }, 20000);
      });
    },
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(cb);
    },
    close() { ws.close(); },
  };
}

/* ─────────────────────────── 内核实例管理 ─────────────────────────── */

/**
 * 启动一个内核实例。
 * @param {object} o
 * @param {string} o.kernelPath     内核可执行文件
 * @param {string} o.userDataDir    该实例独占的 profile 目录（隔离态的根本；双模式靠它）
 * @param {number} o.port           CDP 端口，normal / private 必须不同
 * @param {string[]} [o.extensionDirs] 启动期装载的扩展目录（[] = 零扩展，隐私实例用）
 * @param {string} [o.proxyServer]  形如 http://127.0.0.1:7890，直连 mihomo
 * @param {string[]} [o.extraArgs]
 * @param {boolean} [o.headless]    仅调试用；正常承载必须为 false
 */
function launchKernel(o) {
  const args = [
    `--user-data-dir=${o.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    `--remote-debugging-port=${o.port}`,
    // 以下三项共同构成"扩展真安装"的充分条件，缺一不可：
    //   1) --enable-unsafe-extension-debugging
    //      让命令行装载的扩展被当作真安装。否则 Chrome 126+ 视为 ephemeral：
    //      不写 Secure Preferences、Service Worker 不注册、content script 不注入。
    //   2) --disable-features=DisableLoadExtensionCommandLineSwitch
    //      复活被 Chrome 137 移除的 --load-extension 开关。
    //   3) --load-extension 按需装载。
    '--enable-unsafe-extension-debugging',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ];

  if (o.extensionDirs && o.extensionDirs.length) {
    args.push('--load-extension=' + o.extensionDirs.join(','));
  }                                   // 隐私实例传 [] → 不加该参数 → 天然零扩展
  if (o.proxyServer) args.push(`--proxy-server=${o.proxyServer}`);
  // 仅验收 / 排障用的无窗口模式；真实承载必须保持 false。
  // headless 与有窗口在扩展装载与输入投递上存在行为差异，不可混用后互作结论。
  if (o.headless) args.push('--headless=new');
  if (o.extraArgs) args.push(...o.extraArgs);
  args.push('about:blank');

  const proc = spawn(o.kernelPath, args, {
    stdio: 'ignore',
    windowsHide: false,
    // 保持 detached:false —— 让内核进程留在本进程的进程组内；
    // Windows 上 msedge 的子进程回收由 Chromium 自建的 job 对象负责，
    // 主进程（browser 进程）消失时 job 关闭即连带终止 renderer / gpu / utility。
    detached: false,
  });
  return {
    proc,
    args,
    port: o.port,
    pid: proc.pid,
    kernelPath: o.kernelPath,
    userDataDir: o.userDataDir,
  };
}

/** 轮询等待 CDP 端口就绪，返回 /json/version 结果 */
async function waitKernel(port, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return r.json();
    } catch { /* 内核尚未就绪，继续等 */ }
    await sleep(400);
  }
  throw new Error(`内核 CDP 端口 ${port} 在 ${timeoutMs}ms 内未就绪`);
}

/** 列出该实例下的全部可 attach 目标。
 *  ⚠️ Target.getTargets 的 targetInfos 不返回 webSocketDebuggerUrl，
 *     要拿页面级 CDP 地址必须走 HTTP /json/list。这是实测踩坑点。 */
async function listPages(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

async function attachPage(port, targetId) {
  const pages = await listPages(port);
  const p = pages.find((x) => x.id === targetId);
  if (!p) throw new Error(`未找到 target ${targetId}`);
  return connect(p.webSocketDebuggerUrl);
}

/* ─────────────────────────── Nyx 内核会话 ─────────────────────────── */

/**
 * 建立与内核实例的浏览器级会话，暴露 ① 与 ③ 的全部能力。
 */
async function createKernelSession(kernelPath, userDataDir, port, opts = {}) {
  // 端口预检必须早于启动：否则可能 attach 到别的实例上（理由见 assertPortFree 注释）
  await assertPortFree(port);

  const inst = launchKernel({
    kernelPath, userDataDir, port,
    extensionDirs: opts.extensionDirs || [],
    proxyServer: opts.proxyServer,
    extraArgs: opts.extraArgs,
    headless: opts.headless,
  });

  /* 启动器进程的退场记录 —— 注意：**这不是崩溃判据**。
   * Edge 首次以新建 profile 启动必然 relaunch（见 pingCdp 注释），spawn 进程随之早退；
   * 真正的存活判据是下面的心跳与会话关闭时解析出的 kernelPid。 */
  inst.proc.on('exit', () => { /* 启动器退场，内核本体另起，忽略 */ });

  let ver;
  try {
    ver = await waitKernel(port);
  } catch (err) {
    // 启动失败必须当场回收：否则留下一个无 CDP 的内核进程占着 profile 目录，
    // 下次启动会因 profile 被占用而进入"恢复上次会话"的歧路。
    const orphan = await resolveKernelPid(port, null);
    if (orphan) await taskkillTree(orphan);
    try { inst.proc.kill(); } catch { /* ignore */ }
    await taskkillTree(inst.proc.pid);
    throw err;
  }
  const browser = await connect(ver.webSocketDebuggerUrl);

  /* 真实内核 pid（CDP 端口监听者）+ 心跳存活判定。
   * 心跳连续两次探测失败才判定失活：单次失败可能只是内核繁忙，误判会导致宿主无谓降级。 */
  const kernelPid = await resolveKernelPid(port, browser);
  let exited = false;
  let exitInfo = null;
  const exitHandlers = new Set();
  const probeTimer = setInterval(async () => {
    if (exited) return;
    if (await pingCdp(port, 800)) return;
    if (await pingCdp(port, 800)) return;
    exited = true;
    exitInfo = { reason: 'cdp-unreachable', kernelPid, at: Date.now() };
    for (const f of exitHandlers) { try { f(exitInfo); } catch { /* 回调异常不得影响内核状态机 */ } }
    clearInterval(probeTimer);
  }, 800);
  if (probeTimer.unref) probeTimer.unref();

  /* 页面 session 池 —— 同一 target 必须复用同一条 CDP 连接。
   *
   * 为什么必须复用（实测踩坑）：
   *   Page.addScriptToEvaluateOnNewDocument / Fetch.enable 属于 **session 级**注册态，
   *   绑在发起它的那条连接上。若每次能力调用都新 attach 一条连接，注册完该连接即悬空，
   *   后续由另一条连接触发的导航既不会执行已注册脚本、也不会走拦截。
   *   而 Network.setCookie 是 target 级状态，跨连接共享 —— 这正是
   *   "setCookie 返回 success、injectScript 却静默失效"的根因。 */
  const pageSessions = new Map();
  async function pageSession(targetId) {
    if (pageSessions.has(targetId)) return pageSessions.get(targetId);
    for (let i = 0; i < 30; i++) {
      const pages = await listPages(port);
      const p = pages.find((x) => x.id === targetId);
      if (p && p.webSocketDebuggerUrl) {
        const s = await connect(p.webSocketDebuggerUrl);
        pageSessions.set(targetId, s);
        return s;
      }
      await sleep(250);
    }
    throw new Error(`target ${targetId} 在超时内不可 attach`);
  }

  return {
    ...inst,
    browser,
    version: ver.Browser,
    pageSession,

    /* ── 生命周期可观测性（宿主做崩溃降级的依据，均以 CDP 可应答为准） ── */

    /** 真实内核 pid（CDP 端口监听者），非 spawn 进程；解析失败为 null */
    kernelPid,
    /** 内核服务是否可用（心跳：CDP 连续两次不可达即翻 false） */
    get alive() { return !exited; },
    /** 失活信息 { reason, kernelPid, at }；健康时为 null */
    get exitInfo() { return exitInfo; },
    /** 注册内核失活回调，返回解绑函数 */
    onExit(cb) {
      exitHandlers.add(cb);
      return () => exitHandlers.delete(cb);
    },

    /* ── ③ 扩展能力（真内核完整支持） ── */

    /** 列出全部已装载扩展 */
    listExtensions: () => browser.send('Extensions.getExtensions'),

    /** 运行时装载一个未打包扩展，返回其 id。
     *  实测：端口模式可用，无需 --remote-debugging-pipe。 */
    async loadExtension(dir) {
      const r = await browser.send('Extensions.loadUnpacked', { path: dir });
      return r.id;
    },

    /** 卸载扩展 */
    unloadExtension: (id) => browser.send('Extensions.uninstall', { id }),

    /**
     * 打开扩展的交互界面（弹出页 / 选项页）。
     * 实测更好用的路径：直接把 chrome-extension://<id>/<file> 作为普通页面打开，
     * 由 Nyx 侧栏容器承载 —— 绕开 Extensions.triggerAction 对 type="tab" target 的要求
     * （Target.getTargets 默认不暴露 tab 类型 target）。这也是各类浏览器壳的通用做法。
     */
    async openExtensionPanel(id, kind = 'popup') {
      const file = kind === 'options' ? 'options.html' : 'popup.html';
      const r = await browser.send('Target.createTarget', { url: `chrome-extension://${id}/${file}` });
      return r.targetId;
    },

    /* ── ① 原生能力（不依赖任何扩展） ── */

    /**
     * 在指定页面上挂载请求拦截（广告拦截 / 资源阻断的原生实现）。
     * 比扩展的 declarativeNetRequest 更硬：在 CDP 协议层拦截，页面与扩展都无法绕过。
     *
     * @param {string} targetId
     * @param {Array<{pattern:string, action:'block'|'allow'}>} rules
     */
    async installInterception(targetId, rules) {
      const s = await pageSession(targetId);
      await s.send('Fetch.enable', {
        patterns: rules.map((r) => ({ urlPattern: r.pattern, requestStage: 'Request' })),
      });

      let blocked = 0, passed = 0;
      s.on('Fetch.requestPaused', async (p) => {
        const hit = rules.find((r) => matchPattern(r.pattern, p.request.url));
        try {
          if (hit && hit.action === 'block') {
            blocked++;
            await s.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
          } else {
            passed++;
            await s.send('Fetch.continueRequest', { requestId: p.requestId });
          }
        } catch { /* 请求可能已被内核取消，忽略 */ }
      });

      return { session: s, stats: () => ({ blocked, passed }) };
    },

    /** 原生 Cookie 编辑（target 级状态，跨连接共享；仍统一走 session 池以保时序） */
    async setCookie(targetId, cookie) {
      const s = await pageSession(targetId);
      return s.send('Network.setCookie', cookie);
    },

    /**
     * 原生脚本注入：在每次文档创建前执行（等价于扩展 content script 的先手能力）。
     *
     * ⚠️ 两条硬约束（均实测踩坑）：
     *   1. 注册态绑在 session 上 —— 必须与后续 Page.navigate 走同一 session。
     *   2. 执行时机在文档创建早期，**此时 document.documentElement 仍为 null
     *      （实测 readyState='loading'、documentElement===null）**，
     *      因此注入脚本不得直接操作 documentElement / DOM，只能写 window 级状态，
     *      或自行监听 DOMContentLoaded。
     */
    async injectScript(targetId, source) {
      const s = await pageSession(targetId);
      return s.send('Page.addScriptToEvaluateOnNewDocument', { source });
    },

    /* ── 页面控制 ── */

    newTab: (url) => browser.send('Target.createTarget', { url }),

    async closeTab(targetId) {
      const s = pageSessions.get(targetId);
      if (s) { try { s.close(); } catch { /* 连接可能已断 */ } pageSessions.delete(targetId); }
      return browser.send('Target.closeTarget', { targetId });
    },

    screenshot: async (targetId) => {
      const s = await pageSession(targetId);
      const r = await s.send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    },

    /**
     * 关闭会话并回收**内核真实进程树**。
     *
     * 顺序（先优雅、后强制，不可颠倒）：
     *   1. 关闭全部页面 session；
     *   2. CDP `Browser.close` —— 内核走正常退出流程，由 Chromium 自行回收子进程（最干净）；
     *   3. 超时未退 → 按 `kernelPid`（端口监听者）整树 taskkill 兜底。
     *
     * ⚠️ 兜底必须用 kernelPid，不能用 spawn pid：首次以新建 profile 启动时 spawn 进程
     *    已因 relaunch 退出，其进程树亦已断裂，`taskkill /T` 只会空转（实测残留 28 个进程）。
     *
     * @param {{gracefulMs?:number}} [o] 等待优雅退出的毫秒数，默认 3000。
     * @returns {Promise<{ended:boolean, graceful:boolean}>} ended=false 表示内核仍未退出。
     */
    async shutdown(o = {}) {
      const gracefulMs = Number.isFinite(o.gracefulMs) ? o.gracefulMs : 3000;

      for (const s of pageSessions.values()) { try { s.close(); } catch { /* ignore */ } }
      pageSessions.clear();

      if (!exited) {
        try { await browser.send('Browser.close'); } catch { /* 内核可能已不可达，转兜底 */ }
        const t0 = Date.now();
        while (Date.now() - t0 < gracefulMs) {
          if (!(await pingCdp(port, 500))) { exited = true; break; }
          await sleep(150);
        }
      }
      const graceful = exited;

      try { browser.close(); } catch { /* ignore */ }
      clearInterval(probeTimer);

      if (!exited) {
        const realPid = kernelPid || (await resolveKernelPid(port, null));
        if (realPid) await taskkillTree(realPid);
        try { inst.proc.kill(); } catch { /* ignore */ }   // spawn pid 多半已失效，尽力而为
        await taskkillTree(inst.proc.pid);
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
          if (!(await pingCdp(port, 600))) { exited = true; break; }
          await sleep(200);
        }
      }

      if (exited && !exitInfo) exitInfo = { reason: 'shutdown', kernelPid, at: Date.now() };
      return { ended: exited, graceful };
    },
  };
}

/* ─────────────────────────── 通配符匹配 ─────────────────────────── */

/** 将 CDP urlPattern（支持 * 通配）转为匹配函数 */
function matchPattern(pattern, url) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$').test(url);
}

/* ─────────────────────────── 双实例编排 ─────────────────────────── */

/**
 * 启动 Nyx 的双模式内核：普通实例（可装扩展）+ 隐私实例（零扩展）。
 *
 * 隔离由三条同时成立的条件保证，缺一即失效：
 *   1. profile 目录不同（userDataDir 各自独占）；
 *   2. CDP 端口不同（且启动前预检，防 attach 到别人的实例）；
 *   3. 隐私实例永不获得 extensionDirs —— 隐私红线，不接受任何参数覆盖。
 *
 * 可选参数（阶段 2 宿主接入所需）：
 *   proxyServer               形如 http://127.0.0.1:7899，两实例共用同一 mihomo 混合端口
 *   normalPort / privatePort  CDP 端口，默认 9301 / 9302
 *   normalProfileDir / privateProfileDir   显式覆盖 profile 目录
 *   normalExtensionDirs       启动期预装到普通实例的扩展目录
 *   bootPrivate               是否同时拉起隐私实例（默认 true；宿主可延迟到切隐私模式再拉）
 *   headless                  仅验收用，真实承载必须为 false
 */
async function bootNyxKernels(baseDir, kernelPath, o = {}) {
  const normal = await createKernelSession(
    kernelPath,
    o.normalProfileDir || join(baseDir, 'profile-normal'),
    o.normalPort || 9301,
    {
      extensionDirs: o.normalExtensionDirs || [],   // 启动期可不带；运行时用 loadExtension 动态装载
      proxyServer: o.proxyServer,
      headless: o.headless,
      extraArgs: o.normalExtraArgs,
    },
  );

  if (o.bootPrivate === false) return { normal, private: null };

  const privateInst = await createKernelSession(
    kernelPath,
    o.privateProfileDir || join(baseDir, 'profile-private'),
    o.privatePort || 9302,
    {
      // 隐私红线：永不装载扩展 → 不生成 --load-extension → 天然隔离。
      // 此处硬编码空数组、且不开放任何入口让调用方传入，避免上层"顺手带扩展"。
      extensionDirs: [],
      proxyServer: o.proxyServer,
      headless: o.headless,
      extraArgs: o.privateExtraArgs,
    },
  );
  return { normal, private: privateInst };
}

module.exports = {
  findKernel,
  launchKernel,
  waitKernel,
  listPages,
  attachPage,
  createKernelSession,
  matchPattern,
  bootNyxKernels,
  taskkillTree,
  assertPortFree,
  wsConnect,
};
