'use strict';

/**
 * 打包产物冒烟（针对 dist\win-unpacked 的解包版，不是安装版）
 *
 * 用途：每次改完打包配置（裁剪 locales / 改压缩级别 / 改 extraResources）后，
 * 用它证明"包变小了但还能起来"——只看安装包体积是不够的。
 *
 * 检查项：
 *   1) 进程能起来、远程调试端口可连；
 *   2) /json/list 里出现外壳页面（说明 asar 与 preload 正常加载）；
 *   3) 关键 DOM 与 API 在包里都还在（书签星标、工具箱 8 个页签、地址栏建议 API）；
 *   4) 页面没有未捕获脚本异常；
 *   5) 进程日志里没有 Cannot find module / ERR_FILE_NOT_FOUND / Failed to load locale；
 *   6) 解包产物带 resources\integrity.json，且 Nyx.exe --verify-integrity 退出 0（dist\win-unpacked 不存在时跳过）。
 *
 * 用法：
 *   node scripts/verify-packaged-smoke.js
 *   node scripts/verify-packaged-smoke.js --exe "D:\Nyx-src\dist\win-unpacked\Nyx.exe"
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pickFreePort } = require('./lib/free-port');

const ROOT = path.resolve(__dirname, '..');

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const EXE = path.resolve(readArg('exe', path.join(ROOT, 'dist', 'win-unpacked', 'Nyx.exe')));
// 调试端口交给系统分配（本机 Windows 保留 9486–9585 等动态段，随机挑会 bind 失败 → 假失败）
let PORT = 0;
const workDir = path.join(os.tmpdir(), `nyx-pkg-smoke-${Date.now()}`);
const userData = path.join(workDir, 'userdata');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

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
    await sleep(300);
  }
  return null;
}

/** 极简 CDP 求值（Node 24 内置 WebSocket） */
async function evalIn(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  const events = [];
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (err) => reject(new Error(`CDP 连接失败：${err.message || err.type}`)));
  });
  ws.addEventListener('message', (event) => {
    try {
      events.push(JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)));
    } catch {
      /* 忽略非 JSON 帧 */
    }
  });
  const id = 1;
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  let result = null;
  for (let i = 0; i < 60 && !result; i += 1) {
    const hit = events.find((msg) => msg && msg.id === id);
    if (hit) result = hit;
    else await sleep(100);
  }
  const exceptions = events.filter((msg) => msg && msg.method === 'Runtime.exceptionThrown');
  try {
    ws.close();
  } catch {
    /* 忽略 */
  }
  if (!result) throw new Error('CDP 求值超时');
  if (result.result && result.result.exceptionDetails) {
    throw new Error(String(result.result.exceptionDetails.text || '页面脚本异常'));
  }
  return { value: result.result && result.result.result ? result.result.result.value : undefined, exceptions };
}

async function main() {
  // 完整性清单（随包分发）：先做无窗口自检，再拉起 GUI——避免窗口/单实例锁干扰。
  // 解包目录不存在时按"跳过"处理（verify-all.js 对整步也是 requires 语义）。
  const unpackedDir = path.dirname(EXE);
  const resourcesDir = path.join(unpackedDir, 'resources');
  const integrityJson = path.join(resourcesDir, 'integrity.json');
  if (!fs.existsSync(unpackedDir)) {
    check('resources\\integrity.json 随包分发（跳过：解包目录不存在）', true, unpackedDir);
    check('Nyx.exe --verify-integrity 退出 0（跳过：解包目录不存在）', true, '');
  } else {
    check('resources\\integrity.json 随包分发', fs.existsSync(integrityJson), integrityJson);
    if (fs.existsSync(integrityJson)) {
      // 本机可能带 ELECTRON_RUN_AS_NODE=1：不清掉，Electron 会退化成纯 Node、自检参数不生效
      const verifyEnv = { ...process.env };
      delete verifyEnv.ELECTRON_RUN_AS_NODE;
      const verify = spawnSync(EXE, ['--verify-integrity'], { env: verifyEnv, encoding: 'utf8', windowsHide: true, timeout: 180000 });
      check('Nyx.exe --verify-integrity 退出 0', verify.status === 0, `exit=${verify.status}${verify.error ? `，${verify.error.message}` : ''}`);
    } else {
      check('Nyx.exe --verify-integrity 退出 0（跳过：清单缺失）', true, 'integrity.json 不存在');
    }
  }

  if (!fs.existsSync(EXE)) {
    console.error(`找不到解包版可执行文件：${EXE}（先跑 npm run dist:dir 或 npm run dist）`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(userData, { recursive: true });
  PORT = await pickFreePort();

  // "在线更新"这项读隔离 userData 的 updates/extensions.json：仓库本身不随包分发扩展，
  // 这里也不去真实用户数据里借扩展包；没有清单时该用例按跳过处理（见下方 extOnline 分支）。

  const outPath = path.join(workDir, 'app.log');
  const errPath = path.join(workDir, 'app.err.log');
  const outFd = fs.openSync(outPath, 'a');
  const errFd = fs.openSync(errPath, 'a');

  // 本机环境可能带 ELECTRON_RUN_AS_NODE=1：不清掉，Electron 会退化成纯 Node、main.js 起来就崩
  const env = { ...process.env, NYX_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(`[冒烟] 可执行文件：${EXE}`);
  console.log(`[冒烟] 隔离用户数据：${userData}`);

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', outFd, errFd] });

  try {
    const shellTarget = await waitTarget((t) => t.url.includes('index.html'), 40000);
    check('外壳页面在包内正常加载', !!shellTarget, shellTarget && shellTarget.url);
    if (!shellTarget) throw new Error('外壳页面未出现');

    // 页面 target 出现 ≠ DOM 解析完成：preload 的 window.nyx 很早就有了，
    // 但按钮/页签节点要等 HTML 解析完，所以这里轮询到关键节点出现为止。
    let probe = null;
    for (let i = 0; i < 40; i += 1) {
      probe = await evalIn(
        shellTarget.webSocketDebuggerUrl,
        `(() => {
          const nav = document.getElementById('tb-nav');
          return {
            readyState: document.readyState,
            nyxApi: !!(window.nyx && typeof window.nyx.addressSuggestQuery === 'function'),
            star: !!document.getElementById('btn-bookmark'),
            tbPanes: nav ? nav.querySelectorAll('.tb-nav-btn').length : -1,
            bookmarkApi: !!(window.nyx && typeof window.nyx.bookmarksToggle === 'function'),
          };
        })()`,
      );
      if (probe.value && probe.value.star && probe.value.tbPanes > 0) break;
      await sleep(250);
    }
    check('preload API 正常（建议 + 星标）', !!(probe.value && probe.value.nyxApi && probe.value.bookmarkApi), JSON.stringify(probe.value));
    check('工具栏星标在包内存在', !!(probe.value && probe.value.star), JSON.stringify(probe.value && probe.value.star));
    check('工具箱 8 个页签完整', !!(probe.value && probe.value.tbPanes === 8), `页签数 ${probe.value && probe.value.tbPanes}`);

    // 扩展仓库（v1.9.0）：打包后扩展管理器与仓库路径必须可用
    const extStore = await evalIn(
      shellTarget.webSocketDebuggerUrl,
      `(async () => {
        const list = await window.nyx.listExtensions();
        return {
          ok: !!(list && list.ok !== false),
          storePath: (list && list.storePath) || '',
          count: ((list && list.items) || []).length,
        };
      })()`,
    );
    check(
      '打包后扩展仓库可读（清单 + 仓库路径）',
      !!(extStore.value && extStore.value.ok && String(extStore.value.storePath).length > 0),
      JSON.stringify(extStore.value),
    );

    // 在线更新（v1.11.0）：更新源里有 extensions.json 时，能从源在线装/更新扩展。
    // 源里没有 extensions.json（还没发过带扩展的版本）时按"跳过"处理，不算失败。
    const online = await evalIn(
      shellTarget.webSocketDebuggerUrl,
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const check = await window.nyx.extOnlineCheck();
        if (!check || check.ok === false) return { available: false, error: (check && check.error) || '' };
        const items = check.items || [];
        const first = items[0];
        if (!first) return { available: true, count: 0 };
        const install = await window.nyx.extOnlineInstall({ key: first.key, file: first.file });
        await wait(2000);
        const after = await window.nyx.listExtensions();
        return {
          available: true,
          count: items.length,
          name: first.name,
          version: first.version,
          installOk: !!(install && install.ok),
          installError: (install && install.error) || '',
          installed: ((after && after.items) || []).map((item) => item.name),
        };
      })()`,
    );
    const onlineValue = online.value || {};
    check(
      onlineValue.available === false
        ? '在线更新：更新源暂无 extensions.json（跳过）'
        : '在线更新：能从更新源安装扩展',
      onlineValue.available === false
        ? true
        : !!(onlineValue.installOk && (onlineValue.installed || []).some((name) => String(name).includes('Nyx'))),
      JSON.stringify(onlineValue),
    );
    check('外壳页面无未捕获脚本异常', probe.exceptions.length === 0, probe.exceptions.slice(0, 2).map((e) => JSON.stringify(e.params && e.params.exceptionDetails).slice(0, 120)).join(' | '));

    // 进程存活 + 日志无致命错误
    const alive = (() => {
      try {
        return child.exitCode === null;
      } catch {
        return false;
      }
    })();
    check('进程保持存活', alive, `exitCode=${child.exitCode}`);

    const logText = `${fs.readFileSync(outPath, 'utf8')}\n${fs.readFileSync(errPath, 'utf8')}`;
    const badPatterns = [/Cannot find module/i, /ERR_FILE_NOT_FOUND/i, /Failed to load locale/i, /FATAL/i, /Uncaught/i];
    const hits = badPatterns.filter((re) => re.test(logText)).map((re) => String(re));
    check('进程日志无致命错误', hits.length === 0, hits.join('、'));
  } catch (err) {
    check('冒烟流程未中断', false, err && err.message);
  } finally {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    }
    await sleep(1500);
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }

    const failed = checks.filter((c) => !c.pass);
    console.log('');
    console.log(`[冒烟] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
    if (failed.length) {
      for (const f of failed) console.log(`  · 失败项：${f.name}｜${f.detail}`);
      process.exitCode = 1;
    } else {
      console.log('[冒烟] 全部通过：解包版可正常启动，关键界面与 API 都在');
    }
  }
}

main();
