/**
 * verify-kernel-bridge.mjs —— 阶段 1（内核桥接层）验收
 *
 * 验收口径（见 docs/Nyx-路线1和3并行落地方案.md 第五节 · 阶段 1）：
 *   listExtensions / loadExtension / installInterception / setCookie / injectScript
 *   五个 API 全部返回预期结果。
 *
 * 全程走 CDP 网络层，不依赖桌面可见性（锁屏下亦可运行）。
 * 运行：node scripts/verify-kernel-bridge.mjs
 */

import http from 'node:http';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 验收对象：正式模块 src/core/kernel-bridge.js（CJS，零依赖）
import kb from '../src/core/kernel-bridge.js';

const { findKernel, createKernelSession, listPages } = kb;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const WORK = join(ROOT, 'temp', 'kb-verify');
const RESULT_PATH = join(HERE, 'verify-kernel-bridge.result.json');

const HTTP_PORT = 8899;
const CDP_PORT = 9311;
const SITE = `http://127.0.0.1:${HTTP_PORT}`;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 测试资产 ───────────────────────── */

function buildExtension(dir, name, marker) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name,
    version: '1.0',
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'], run_at: 'document_idle' }],
    action: { default_popup: 'popup.html' },
  }, null, 2));
  writeFileSync(join(dir, 'sw.js'), `self.__nyx = ${JSON.stringify(marker)};\n`);
  writeFileSync(join(dir, 'cs.js'), `document.documentElement.setAttribute('data-nyx-ext', ${JSON.stringify(marker)});\n`);
  writeFileSync(join(dir, 'popup.html'), `<!doctype html><meta charset="utf-8"><title>${marker}</title><body>${marker}</body>\n`);
}

function buildSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/blocked.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__blocked = 1;');
      return;
    }
    if (req.url === '/ok.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.__ok = 1;');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>KB</title></head><body>kb'
      + '<script src="/blocked.js"></script><script src="/ok.js"></script></body></html>');
  });
  return new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', () => r(server)));
}

/* ───────────────────────── CDP helper ───────────────────────── */

async function waitTarget(port, targetId, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const pages = await listPages(port);
    const p = pages.find((x) => x.id === targetId);
    if (p && p.webSocketDebuggerUrl) return p;
    await sleep(250);
  }
  throw new Error(`target ${targetId} not attachable in time`);
}

async function evalOn(session, expression) {
  const r = await session.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

/* ───────────────────────── 主流程 ───────────────────────── */

const checks = [];
function record(id, desc, pass, detail) {
  checks.push({ id, desc, pass: !!pass, detail });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${desc}  ->  ${detail}`);
}

async function main() {
  log('=== Nyx stage-1 verify: kernel bridge ===');

  mkdirSync(WORK, { recursive: true });
  const extA = join(WORK, 'extA');
  const extB = join(WORK, 'extB');
  buildExtension(extA, 'Nyx Kernel Probe A', 'A');
  buildExtension(extB, 'Nyx Kernel Probe B', 'B');

  const kernel = findKernel();
  log('kernel =', kernel);
  if (!kernel) throw new Error('no kernel found');

  const server = await buildSite();
  log(`local site up at ${SITE}`);

  const session = await createKernelSession(kernel, join(WORK, 'profile-normal'), CDP_PORT, {
    extensionDirs: [extA],
  });
  log('kernel version =', session.version);
  log('launch args =', session.args.join(' '));

  try {
    /* ── T1 listExtensions ── */
    log('\n--- T1 listExtensions ---');
    const exts = await session.listExtensions();
    const list = exts.extensions || [];
    const hasA = list.some((e) => String(e.name).includes('Probe A'));
    record('T1', 'listExtensions', hasA,
      `count=${list.length}, names=[${list.map((e) => e.name).join(', ')}]`);

    /* ── T2 loadExtension (runtime) ── */
    log('\n--- T2 loadExtension ---');
    let idB = null;
    try {
      idB = await session.loadExtension(extB);
    } catch (e) {
      idB = null;
      log('  loadExtension threw:', e.message);
    }
    const exts2 = await session.listExtensions();
    const list2 = exts2.extensions || [];
    const hasB = idB ? list2.some((e) => e.id === idB) : false;
    record('T2', 'loadExtension', !!idB && hasB,
      `id=${idB}, totalExtensions=${list2.length}`);

    /* ── T3 injectScript + setCookie（同一 target 上验证生效） ── */
    log('\n--- T3 injectScript / setCookie ---');
    const created = await session.newTab('about:blank');
    const t1 = created.targetId;
    await waitTarget(CDP_PORT, t1);

    let cookieRes = null, injectRes = null;
    try { cookieRes = await session.setCookie(t1, {
      name: 'nyx_kb', value: 'route1-ok', url: SITE + '/', path: '/', httpOnly: false, sameSite: 'Lax',
    }); } catch (e) { log('  setCookie threw:', e.message); }
    // 探针写 window 级状态：注入点位于文档创建早期，此时 document.documentElement
    // 可能尚未建立，直接操作它会抛 TypeError 并被静默吞掉（r3 实测踩坑）。
    try { injectRes = await session.injectScript(t1,
      "window.__nyxInjected='route1';window.__nyxDiag={deNull:document.documentElement===null,readyState:document.readyState};"); }
    catch (e) { log('  injectScript threw:', e.message); }

    // 关键：与 setCookie / injectScript 复用同一条 session。
    // 若此处另开裸连接导航，injectScript 的注册态会静默失效（见原型注释）。
    const s1 = await session.pageSession(t1);
    await s1.send('Page.enable');
    await s1.send('Page.navigate', { url: SITE + '/' });
    await sleep(2200);
    const probe = await evalOn(s1, `JSON.stringify({
      injected: window.__nyxInjected || null,
      diag: window.__nyxDiag || null,
      cookie: document.cookie,
      ext: document.documentElement.getAttribute('data-nyx-ext')
    })`);
    const pr = JSON.parse(probe);
    record('T3a', 'setCookie', pr.cookie.includes('nyx_kb=route1-ok') && cookieRes && cookieRes.success !== false,
      `api=${JSON.stringify(cookieRes)}, document.cookie="${pr.cookie}"`);
    record('T3b', 'injectScript', pr.injected === 'route1',
      `marker=${pr.injected}, runtime=${JSON.stringify(pr.diag)}`);
    log(`  (side observation) content script marker = ${pr.ext}`);

    /* ── T4 installInterception ── */
    log('\n--- T4 installInterception ---');
    const t2 = (await session.newTab('about:blank')).targetId;
    await waitTarget(CDP_PORT, t2);
    const inter = await session.installInterception(t2, [
      { pattern: SITE + '/blocked.js', action: 'block' },
    ]);
    const s2 = inter.session;
    await s2.send('Page.enable');
    await s2.send('Page.navigate', { url: SITE + '/' });
    await sleep(2200);
    const res = JSON.parse(await evalOn(s2, `JSON.stringify({
      ok: window.__ok || 0, blocked: window.__blocked || 0
    })`));
    const stats = inter.stats();
    record('T4', 'installInterception', res.ok === 1 && res.blocked === 0 && stats.blocked >= 1,
      `page: ok.js=${res.ok}, blocked.js=${res.blocked}; cdp: ${JSON.stringify(stats)}`);

    /* ── T5 screenshot ──
     * 兼作自研 WebSocket 客户端的压力项：PNG base64 响应是 MB 级 payload，
     * 必然走 64 位长度帧（甚至分片）通路，可验证长帧解析正确。 */
    log('\n--- T5 screenshot (large payload / ws long-frame) ---');
    let png = null;
    try { png = await session.screenshot(t2); } catch (e) { log('  screenshot threw:', e.message); }
    const isPng = !!png && png.length > 8
      && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    record('T5', 'screenshot', isPng,
      `bytes=${png ? png.length : 0}, pngMagic=${isPng}`);

    /* ── T6 WebSocket 64 位长度编码通路 ──
     * T5 的 9996B 只走到 16 位长度分支。这里刻意让内核回一个 200KB 字符串，
     * 强制走 RFC6455 的 64 位长度编码（len >= 65536），覆盖自研客户端的长帧分支。 */
    log('\n--- T6 ws 64-bit length path ---');
    let big = null;
    try { big = await evalOn(s2, `'x'.repeat(200000)`); } catch (e) { log('  big eval threw:', e.message); }
    record('T6', 'ws-long-frame', typeof big === 'string' && big.length === 200000,
      `returnedLength=${typeof big === 'string' ? big.length : -1} (expect 200000, > 65535)`);

  } finally {
    log('\n--- cleanup ---');
    try { session.shutdown(); } catch { /* ignore */ }
    await sleep(600);
    server.close();
  }

  const pass = checks.filter((c) => c.pass).length;
  const fail = checks.length - pass;
  log(`\n=== SUMMARY: ${pass} pass / ${fail} fail ===`);
  for (const c of checks) if (!c.pass) log(`  FAILED: ${c.id} ${c.desc} -> ${c.detail}`);

  writeFileSync(RESULT_PATH, JSON.stringify({
    ts: new Date().toISOString(),
    stage: 1,
    module: 'kernel-bridge',
    kernel,
    kernelVersion: null,
    cdpPort: CDP_PORT,
    checks,
    summary: { total: checks.length, pass, fail },
  }, null, 2));
  log('result written to', RESULT_PATH);

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  writeFileSync(RESULT_PATH, JSON.stringify({ ts: new Date().toISOString(), fatal: e.message, checks }, null, 2));
  process.exit(2);
});
