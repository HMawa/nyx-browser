// edge-cookie-import.js — 从 Edge 导入 Cookie 的主进程模块
//
// 职责：定位 Edge 数据目录与安装目录 -> 复制最小 profile（Cookies + Local State）
//       -> 启动 headless Edge + CDP（Network.getAllCookies）取明文 Cookie
//       -> 按 mode（site/all）过滤后返回明文列表。
//
// 为什么用 CDP 而不是 ABE helper 直解：
//   本机 Edge 149 已启用 App-Bound Encryption 且 elevation_service 的
//   DecryptData 做了「调用进程路径 + Authenticode 签名」双重校验
//   （kElevatorErrorPathValidation=0x8004A004），独立第三方 exe 即使复制进
//   Edge Application 目录也无法通过。headless Edge 以自身进程身份解密，
//   是唯一稳定可行的通道。
//
// ABE helper（vendor/edge-abe-helper/）与 DPAPI 方案保留为回退：
//   对未启用 ABE 的旧版 Edge / 其他 Chromium 浏览器仍可用。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn, execFileSync } = require('child_process');

const EDGE_APP_ROOT = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application';
const EDGE_USER_DATA = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
const EDGE_EXE = path.join(EDGE_APP_ROOT, 'msedge.exe');
const HELPER_NAME = 'edge_abe_helper.exe';
const ABE_PREFIX = 'APPB';
const DPAPI_PREFIX = 'RFBBUEk=';

let sqlite = null;
try {
  // Electron 43 内置 node:sqlite（已验证 NODE_SQLITE_OK）
  sqlite = require('node:sqlite');
} catch (e) {
  sqlite = null;
}

/* ----------------------------- 工具函数 ----------------------------- */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 找 Edge Application 下版本号最大的目录（如 149.0.4022.62） */
function findEdgeVersionDir() {
  if (!fs.existsSync(EDGE_APP_ROOT)) return null;
  const dirs = fs.readdirSync(EDGE_APP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 4; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    });
  if (dirs.length === 0) return null;
  return path.join(EDGE_APP_ROOT, dirs[dirs.length - 1]);
}

/** 复制 Edge 最小 profile（Cookies + Local State + 空 Preferences）到临时目录 */
function copyProfileMinimal() {
  const cookiesSrc = path.join(EDGE_USER_DATA, 'Default', 'Network', 'Cookies');
  const lsSrc = path.join(EDGE_USER_DATA, 'Local State');
  if (!fs.existsSync(cookiesSrc)) {
    return { ok: false, error: '未找到 Edge Cookies 库：' + cookiesSrc };
  }
  if (!fs.existsSync(lsSrc)) {
    return { ok: false, error: '未找到 Edge Local State：' + lsSrc };
  }
  const profileDir = path.join(os.tmpdir(), 'nyx-edge-cdp-' + process.pid + '-' + Date.now());
  const defaultDir = path.join(profileDir, 'Default');
  const networkDir = path.join(defaultDir, 'Network');
  try {
    fs.mkdirSync(networkDir, { recursive: true });
    fs.copyFileSync(cookiesSrc, path.join(networkDir, 'Cookies'));
    fs.copyFileSync(lsSrc, path.join(profileDir, 'Local State'));
    // 空 Preferences：headless Edge 启动需要；不写内容，Edge 会自动补齐
    fs.writeFileSync(path.join(defaultDir, 'Preferences'), '{}', 'utf8');
  } catch (e) {
    const locked = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
    return { ok: false, locked, error: '复制 Edge profile 失败：' + e.message, profileDir };
  }
  return { ok: true, profileDir };
}

/** 清理临时 profile 目录（忽略错误） */
function cleanupProfile(profileDir) {
  try {
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) { /* 忽略 */ }
}

/** 启动 headless Edge（临时 profile），返回 { proc, port } */
function startHeadlessEdge(profileDir) {
  const port = 9400 + Math.floor(Math.random() * 2000);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--no-sandbox',
    '--user-data-dir=' + profileDir,
    '--profile-directory=Default',
    '--remote-debugging-port=' + port,
    'about:blank',
  ];
  let proc;
  try {
    proc = spawn(EDGE_EXE, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
  } catch (e) {
    return { ok: false, error: '启动 headless Edge 失败：' + e.message };
  }
  return { ok: true, proc, port };
}

/** 等待 CDP 页面 target 出现，返回 page websocket 地址 */
async function waitCdpPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = Array.isArray(list) ? list.find((t) => t && t.type === 'page') : null;
      if (page && page.webSocketDebuggerUrl) return { ok: true, wsUrl: page.webSocketDebuggerUrl };
    } catch (e) { /* 端口未就绪，继续等 */ }
    await sleep(400);
  }
  return { ok: false, error: '等待 Edge CDP 就绪超时' };
}

/** 通过 CDP 获取全部 Cookie（明文） */
async function cdpGetAllCookies(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (msg && msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  try {
    await send('Network.enable');
    const res = await send('Network.getAllCookies');
    return { ok: true, cookies: (res && res.cookies) || [] };
  } finally {
    try { ws.close(); } catch (e) { /* 忽略 */ }
  }
}

/** 结束 headless Edge 进程树（按 PID 树杀，避免误杀用户 Edge） */
function killProcessTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    try { process.kill(pid); } catch (e2) { /* 忽略 */ }
  }
}

/** CDP 路径导入：headless Edge 自行解密 Cookie */
async function importEdgeCookiesCdp(opts) {
  const mode = opts && opts.mode === 'site' ? 'site' : 'all';
  const siteHost = opts && opts.host ? String(opts.host).replace(/^\./, '').toLowerCase() : '';
  if (!fs.existsSync(EDGE_EXE)) {
    return { ok: false, error: '未找到 Edge 可执行文件：' + EDGE_EXE };
  }

  // 1. 复制最小 profile（EBUSY -> locked）
  const cp = copyProfileMinimal();
  if (!cp.ok) {
    return { ok: false, locked: cp.locked === true, error: cp.error };
  }

  // 2. 启动 headless Edge + CDP
  const he = startHeadlessEdge(cp.profileDir);
  if (!he.ok) {
    cleanupProfile(cp.profileDir);
    return { ok: false, error: he.error };
  }

  try {
    const wait = await waitCdpPage(he.port, 15000);
    if (!wait.ok) {
      return { ok: false, error: wait.error };
    }
    const res = await cdpGetAllCookies(wait.wsUrl);
    if (!res.ok) return res;

    // 3. 过滤 + 映射
    const total = res.cookies.length;
    const list = [];
    for (const c of res.cookies) {
      const domain = String(c.domain || '').toLowerCase();
      const host = domain.replace(/^\./, '');
      if (!c.name) continue;
      if (mode === 'site') {
        if (!siteHost) continue;
        if (host !== siteHost && !siteHost.endsWith('.' + host)) continue;
      }
      const expires = c.session ? null : (Number(c.expires) > 0 ? Math.floor(Number(c.expires)) : null);
      list.push({
        host: host || siteHost,
        domain,
        name: String(c.name || ''),
        value: String(c.value || ''),
        path: String(c.path || '/'),
        expires,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: mapSameSiteStr(String(c.sameSite || '')),
      });
    }
    return { ok: true, via: 'cdp', mode, siteHost, total, imported: list.length, list };
  } finally {
    if (he.proc && he.proc.pid) killProcessTree(he.proc.pid);
    await sleep(600); // 等进程退出后再清理文件
    cleanupProfile(cp.profileDir);
  }
}

/** CDP sameSite 枚举 -> Electron cookies.set 取值 */
function mapSameSiteStr(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'strict') return 'strict';
  if (v === 'lax') return 'lax';
  if (v === 'none') return 'no_restriction';
  return 'unspecified';
}

/* ======================= ABE / DPAPI 回退路径 ======================= */

/** 确保 helper.exe 已复制到 Edge Application 目录（路径校验要求调用进程在该目录） */
async function ensureHelperInEdgeDir() {
  const verDir = findEdgeVersionDir();
  if (!verDir) return { ok: false, error: '未找到 Edge 安装目录' };
  const target = path.join(verDir, HELPER_NAME);
  if (fs.existsSync(target)) return { ok: true, helperPath: target };
  const temp = path.join(os.tmpdir(), 'nyx-edge-abe-helper');
  const src = path.join(temp, HELPER_NAME);
  if (!fs.existsSync(src)) {
    return { ok: false, error: '缺少 helper 编译产物，请先编译 edge_abe_helper.exe 到 ' + src };
  }
  try {
    fs.copyFileSync(src, target);
    return { ok: true, helperPath: target, copied: true };
  } catch (e) {
    return { ok: false, needElevation: true, error: 'Edge 目录不可写：' + e.message, src, target };
  }
}

/** UAC 提权复制 helper 到 Edge 目录（Start-Process -Verb RunAs） */
function elevateCopyHelper(src, target) {
  return new Promise((resolve) => {
    const ps = [
      '-NoProfile',
      '-Command',
      `Copy-Item -LiteralPath '${src}' -Destination '${target}' -Force; if(Test-Path -LiteralPath '${target}'){exit 0}else{exit 1}`,
    ];
    execFile('powershell.exe', ['-Command', 'Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList ' + JSON.stringify(ps.join(' '))], { windowsHide: false }, (err) => {
      if (err) return resolve({ ok: false, error: 'UAC 提权失败（可能被取消）：' + err.message });
      resolve({ ok: true, helperPath: target, elevated: true });
    });
  });
}

/** 读 Local State 的 os_crypt 段 */
function readOsCrypt() {
  const lsPath = path.join(EDGE_USER_DATA, 'Local State');
  if (!fs.existsSync(lsPath)) return { ok: false, error: '未找到 Local State' };
  let ls;
  try {
    ls = JSON.parse(fs.readFileSync(lsPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: '解析 Local State 失败：' + e.message };
  }
  const oc = (ls && ls.os_crypt) || {};
  return { ok: true, appBoundKey: oc.app_bound_encrypted_key || null, legacyKey: oc.encrypted_key || null };
}

/** PowerShell DPAPI 解出 32 字节 AES key */
function dpapiDecryptBase64(b64) {
  return new Promise((resolve) => {
    const ps = [
      'Add-Type -AssemblyName System.Security;',
      `$env:NYX_B64 = '${b64}';`,
      '$bytes=[Convert]::FromBase64String($env:NYX_B64);',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($out))',
    ].join(' ');
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: 'DPAPI 解密失败：' + err.message });
      resolve({ ok: true, b64: String(stdout || '').trim() });
    });
  });
}

/** 调 helper 解密（decrypt-key / decrypt-value / decrypt-values 批量） */
function runHelper(helperPath, mode, args, inputLines) {
  return new Promise((resolve) => {
    const cmdArgs = [mode].concat(args || []);
    const child = execFile(helperPath, cmdArgs, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        return resolve({ ok: false, error: 'helper 执行失败：' + (stderr || err.message) });
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (inputLines && inputLines.length) {
      child.stdin.write(inputLines.join('\r\n') + '\r\n');
    }
    child.stdin.end();
  });
}

/** 用 ABE helper 解出 32 字节 AES key（hex） */
async function abeDecryptKey(helperPath, b64Key) {
  const r = await runHelper(helperPath, 'decrypt-key', [b64Key], null);
  if (!r.ok) return r;
  const line = r.stdout.split(/\r?\n/)[0] || '';
  if (!line.startsWith('OK:')) return { ok: false, error: 'decrypt-key 结果异常：' + r.stdout };
  const hex = line.slice(3).trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { ok: false, error: 'decrypt-key 返回非 32 字节 key：' + hex };
  return { ok: true, hex };
}

/** v10 密文：'v10' + 12B nonce + AES-256-GCM(AAD='cookie') */
function decryptV10(key, buf) {
  try {
    if (buf.length < 3 + 12 + 16) return null;
    const nonce = buf.subarray(3, 15);
    const ct = buf.subarray(15);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(Buffer.from('cookie'));
    const out = Buffer.concat([d.update(ct), d.final()]);
    return out.toString('utf8');
  } catch (e) {
    return null;
  }
}

/** expires_utc（1601-01-01 微秒）转 Unix 秒；<=0 视为会话 cookie */
function expiresToUnix(expiresUtc) {
  const n = Number(expiresUtc);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n / 1e6 - 11644473600);
}

/** samesite 映射 -1/0/1/2 -> unspecified/no_restriction/lax/strict */
function mapSameSite(v) {
  const n = Number(v);
  if (n === 0) return 'no_restriction';
  if (n === 1) return 'lax';
  if (n === 2) return 'strict';
  return 'unspecified';
}

function rowBuf(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return Buffer.from(String(v), 'base64');
}

/** ABE/DPAPI 回退路径导入（对旧版 Edge / 未启用 ABE 的 Chromium） */
async function importEdgeCookiesAbe(opts) {
  const mode = opts && opts.mode === 'site' ? 'site' : 'all';
  const siteHost = opts && opts.host ? String(opts.host).replace(/^\./, '').toLowerCase() : '';

  let helper = await ensureHelperInEdgeDir();
  if (helper.needElevation) {
    const el = await elevateCopyHelper(helper.src, helper.target);
    if (!el.ok) return { ok: false, needElevation: true, error: el.error };
    helper = el;
  }
  if (!helper.ok) return { ok: false, error: helper.error };
  const helperPath = helper.helperPath;

  const oc = readOsCrypt();
  if (!oc.ok) return { ok: false, error: oc.error };

  // 复制 Cookies 库（锁定判断）
  const cookiesSrc = path.join(EDGE_USER_DATA, 'Default', 'Network', 'Cookies');
  const dir = path.join(os.tmpdir(), 'nyx-edge-cookies-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, 'Cookies-copy-' + Date.now() + '.sqlite');
  try {
    fs.copyFileSync(cookiesSrc, dst);
  } catch (e) {
    const locked = e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
    return { ok: false, locked, error: locked ? 'Edge Cookies 库被占用，请关闭 Edge 后重试' : ('复制 Cookies 库失败：' + e.message) };
  }

  if (!sqlite) return { ok: false, error: 'node:sqlite 不可用，无法读取 Cookies 库' };
  let db;
  try {
    db = new sqlite.DatabaseSync(dst, { readOnly: true });
  } catch (e) {
    return { ok: false, error: '打开 Cookies 库失败：' + e.message };
  }

  try {
    let aesKey = null;
    if (oc.legacyKey && oc.legacyKey.startsWith(DPAPI_PREFIX)) {
      const d = await dpapiDecryptBase64(oc.legacyKey);
      if (d.ok) {
        const raw = Buffer.from(d.b64, 'base64');
        if (raw.length === 32) aesKey = raw;
      }
    }
    if (!aesKey && oc.appBoundKey && oc.appBoundKey.startsWith(ABE_PREFIX)) {
      const k = await abeDecryptKey(helperPath, oc.appBoundKey);
      if (k.ok) aesKey = Buffer.from(k.hex, 'hex');
    }
    if (!aesKey) {
      return { ok: false, error: '未能解出 AES key（os_crypt 结构不支持：appBound=' +
        (!!oc.appBoundKey) + ' legacy=' + (!!oc.legacyKey) + '）' };
    }

    const rows = db.prepare(
      'SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies'
    ).all();
    const total = rows.length;

    const targets = [];
    for (const row of rows) {
      const host = String(row.host_key || '').toLowerCase();
      if (mode === 'site') {
        if (siteHost && host !== siteHost && host !== '.' + siteHost) continue;
      }
      if (!row.encrypted_value) continue;
      targets.push({ row, host });
    }

    const v10list = [];
    const v20list = [];
    for (const t of targets) {
      const buf = rowBuf(t.row.encrypted_value);
      const pre = buf.length >= 3 ? buf.subarray(0, 3).toString('ascii') : '';
      if (pre === 'v10') v10list.push({ t, buf });
      else if (pre === 'v20') v20list.push({ t, buf });
    }

    const decrypted = new Map();
    for (const item of v10list) {
      const v = decryptV10(aesKey, item.buf);
      if (v != null) decrypted.set(item.t.row, v);
    }
    if (v20list.length) {
      const b64s = v20list.map((x) => x.buf.toString('base64'));
      const r = await runHelper(helperPath, 'decrypt-values', [], b64s);
      if (r.ok) {
        const lines = r.stdout.split(/\r?\n/);
        for (let i = 0; i < v20list.length; i++) {
          const line = lines[i] || '';
          if (line.startsWith('OK:')) {
            try {
              decrypted.set(v20list[i].t.row, Buffer.from(line.slice(3).trim(), 'base64').toString('utf8'));
            } catch (e) { /* 跳过坏值 */ }
          }
        }
      }
    }

    const list = [];
    for (const t of targets) {
      const value = decrypted.get(t.row);
      if (value == null) continue;
      list.push({
        host: t.host,
        domain: (t.host.startsWith('.') ? t.host : t.host),
        name: String(t.row.name || ''),
        value,
        path: String(t.row.path || '/'),
        expires: expiresToUnix(t.row.expires_utc),
        secure: !!t.row.is_secure,
        httpOnly: !!t.row.is_httponly,
        sameSite: mapSameSite(t.row.samesite),
      });
    }

    return { ok: true, via: 'abe', mode, siteHost, total, imported: list.length, list };
  } finally {
    try { db.close(); } catch (e) { /* 忽略 */ }
  }
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 导入 Edge Cookie。
 * @param {object} opts { mode: 'site'|'all', host?: 当前站点 host（mode=site 时过滤） }
 * @returns {Promise<{ok, via?, locked?, needElevation?, total, imported, list}>}
 */
async function importEdgeCookies(opts) {
  // 优先 CDP（headless Edge 自行解密，本机 Edge 149 唯一可行通道）
  const r = await importEdgeCookiesCdp(opts);
  if (r.ok) return r;
  if (r.locked) return r; // 库被锁：提示用户关 Edge，由 UI 层轮询重试
  // CDP 不可用（Edge 路径缺失等）时回退 ABE/DPAPI
  const abe = await importEdgeCookiesAbe(opts);
  if (abe.ok) return abe;
  // 回退也失败：返回更可读的错误
  return { ok: false, error: (r.error || 'CDP 导入失败') + '；ABE 回退：' + (abe.error || '未知错误') };
}

module.exports = { importEdgeCookies, importEdgeCookiesCdp, importEdgeCookiesAbe, findEdgeVersionDir, ensureHelperInEdgeDir, HELPER_NAME };
