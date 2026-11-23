/* 由 2026-09-20 扩展插件开发会话归档；用法见文件头注释与 PROGRESS.md「二·补 6」。 */
'use strict';

/* Nyx 扩展插件端到端验证（真实 Electron 环境）：
   1) 扩展真的被 Chromium 装载并能注入内容脚本；
   2) 隐私分区（nyx-private）确认零扩展、页面不被改写；
   3) MV3 扩展在本内核下的真实装载结果（如实记录，不做断言美化）。 */

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

app.disableHardwareAcceleration();

/* 输出管道可能是别的进程给的（比如把本脚本的输出重定向到文件、或上层只读了一部分就退出）。
 * 那种情况下控制台写入会抛 EPIPE，而它在主进程里是被当成未捕获异常弹框的 ——
 * 一条"日志没人读了"就把被测进程打断，属于工具自身噪音，不该算程序错误。
 * 只吞 EPIPE，其它未捕获异常照旧打出来并失败退出。 */
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  console.error('未捕获异常：', err);
  app.exit(1);
});

const workDir = path.join(os.tmpdir(), `nyx-ext-e2e-${Date.now()}`);
app.setPath('userData', path.join(workDir, 'userdata'));

/* 这条必须留空：所有窗口 destroy 之后，Electron 的默认 window-all-closed 行为会**直接退出进程**。
 * 而清理临时目录是 `await` 在 destroy 之后的 —— 一 yield 回到事件循环，进程就没了，
 * 清理永远跑不到，%TEMP%\nyx-ext-e2e-* 就这么一次一次攒下来（实测攒了 3 个才发现）。
 * 退出时机与退出码由脚本自己在最后决定。 */
app.on('window-all-closed', () => {});

/* 清理结果写在工作目录之外的固定文件里：app.exit() 会提前截断 stdout，
 * 写在 stdout 上的「清理成功/失败」抓不到（实测过），落这个文件才留证据。 */
const CLEANUP_LOG = path.join(os.tmpdir(), 'nyx-ext-e2e-cleanup.log');

/* 上一次运行如果没删干净（Electron 退出时回写 session 数据会把目录再建出来），
 * 下次开跑前先扫掉旧的，保证临时目录数量不会无限累积。
 * 只扫 5 分钟以前的，避免误删同时并行跑的另一次 e2e。 */
function sweepOldWorkDirs() {
  const now = Date.now();
  let swept = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('nyx-ext-e2e-')) continue;
      const stamp = Number(name.slice('nyx-ext-e2e-'.length));
      if (!Number.isFinite(stamp) || now - stamp < 5 * 60 * 1000) continue;
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
        swept += 1;
      } catch {
        /* 还被别人占着就留着，下次再扫 */
      }
    }
  } catch {
    /* 临时目录读不了不影响本次验证 */
  }
  return swept;
}

function noteCleanup(line) {
  try {
    fs.appendFileSync(CLEANUP_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* 写不进日志不影响结论 */
  }
}

const { ExtensionManager } = require(path.join(__dirname, '..', 'src/core/extensions.js'));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/* 删临时目录要重试：Electron 关掉窗口后仍可能短暂持有 userData 里的文件，
 * 一次 rmSync 就抛 EPERM，会留下 %TEMP%\nyx-ext-e2e-* 不断累积（测试债）。
 * 本进程里删不掉（文件还开着）时，交给一个 detached 的后台进程在 2 秒后删——
 * 那时本进程已 app.exit，句柄释放了。后台进程用 ELECTRON_RUN_AS_NODE=1 起，
 * 否则 process.execPath（electron.exe，GUI 子系统）会再弹一个进程出来。 */
function scheduleDetachedCleanup(dir) {
  const helper = `setTimeout(() => { try { require('node:fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true }); } catch (e) {} }, 2000);`;
  try {
    const child = spawn(process.execPath, ['-e', helper], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function cleanupWorkDir(label) {
  let removed = false;
  let lastErr = null;
  for (let i = 1; i <= 5 && !removed; i += 1) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      lastErr = err;
      if (i < 5) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  /* 即使这一次删掉了，也要留一次兜底：Electron 在 app.exit 时还会回写 session 数据，
   * 会把刚删掉的目录又建出来（实测残留过一次）。后台进程 2 秒后再删一遍最省事。 */
  const scheduled = scheduleDetachedCleanup(workDir);
  if (removed && scheduled) {
    noteCleanup(`已删 ${label}（后台进程 2 秒后再兜一次）`);
  } else if (removed) {
    noteCleanup(`已删 ${label}`);
  } else if (scheduled) {
    noteCleanup(`清理延后 ${label}：${lastErr && (lastErr.code || lastErr.message)}，交给后台进程 2 秒后删`);
  } else {
    noteCleanup(`清理失败 ${label}：${lastErr && (lastErr.code || lastErr.message)}，目录留在 ${workDir}`);
  }
  return removed || scheduled;
}

app.whenReady().then(async () => {
  const report = {};
  const swept = sweepOldWorkDirs();
  noteCleanup(`开跑：本次目录 ${workDir}；扫掉旧的 ${swept} 个`);

  /* ---- 造两个扩展：MV2 内容脚本（写 data-mv2 + 改标题）/ MV3 内容脚本（只写 data-mv3）----
     两者必须留**互不覆盖的副作用**：都改 document.title 时，后跑的那个会盖住先跑的，
     report.mv3Injected 就会把「MV3 没注入」和「MV3 注入了但被 MV2 盖住」混为一谈。 */
  const extMv2 = path.join(workDir, 'ext-mv2');
  write(
    path.join(extMv2, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name: '标题改写器',
      version: '1.0.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
    }),
  );
  write(path.join(extMv2, 'content.js'), "document.title = 'INJECTED-MV2'; document.body.dataset.mv2 = '1';");

  const extMv3 = path.join(workDir, 'ext-mv3');
  write(
    path.join(extMv3, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: '标题改写器MV3',
      version: '1.0.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
    }),
  );
  write(path.join(extMv3, 'content.js'), "document.body.dataset.mv3 = '1';");

  const pageFile = path.join(workDir, 'page.html');
  write(pageFile, '<!doctype html><html><head><title>plain</title></head><body>hello</body></html>');

  const normalSession = session.fromPartition('persist:nyx-normal');
  const privateSession = session.fromPartition('nyx-private');

  const manager = new ExtensionManager({
    stateDir: path.join(app.getPath('userData'), 'extensions'),
    getSession: () => normalSession,
    log: (level, text) => console.log(`  [ext:${level}] ${text}`),
  });
  manager.init();

  /* ---- 安装 MV2 ---- */
  const installMv2 = await manager.install(extMv2);
  report.installMv2 = { ok: installMv2.ok, error: installMv2.error || null, loaded: !!(installMv2.extension && installMv2.extension.loaded) };

  /* ---- 验证普通分区：内容脚本是否真的注入 ---- */
  const win = new BrowserWindow({ show: false, webPreferences: { session: normalSession } });
  await win.loadFile(pageFile);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  report.normalTitle = await win.webContents.executeJavaScript('document.title');
  report.normalInjected = report.normalTitle === 'INJECTED-MV2';
  report.normalExtensions = normalSession.extensions.getAllExtensions().map((ext) => `${ext.name}@${ext.version}`);

  /* ---- 验证隐私分区：零扩展、页面不被改写 ---- */
  report.privateExtensionCount = privateSession.extensions.getAllExtensions().length;
  const privWin = new BrowserWindow({ show: false, webPreferences: { session: privateSession } });
  await privWin.loadFile(pageFile);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  report.privateTitle = await privWin.webContents.executeJavaScript('document.title');
  report.privateUntouched = report.privateTitle === 'plain';

  /* ---- MV3 扩展的真实装载结果 ---- */
  const installMv3 = await manager.install(extMv3);
  report.installMv3 = {
    ok: installMv3.ok,
    error: installMv3.error || null,
    loadError: installMv3.loadError || null,
    loaded: !!(installMv3.extension && installMv3.extension.loaded),
  };

  if (installMv3.ok && installMv3.extension && installMv3.extension.loaded) {
    const win3 = new BrowserWindow({ show: false, webPreferences: { session: normalSession } });
    await win3.loadFile(pageFile);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    report.mv3Title = await win3.webContents.executeJavaScript('document.title');
    // 只看 MV3 自己的副作用（data-mv3），不看标题——标题会被 MV2 覆盖，不能当 MV3 的判据。
    report.mv3Injected = await win3.webContents.executeJavaScript("document.body.dataset.mv3 === '1'");
    win3.destroy();
  }

  /* ---- 停用全部扩展后：重新加载页面应回到未被改写状态 ---- */
  for (const item of manager.list()) {
    await manager.setEnabled(item.id, false);
  }
  const win4 = new BrowserWindow({ show: false, webPreferences: { session: normalSession } });
  await win4.loadFile(pageFile);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  report.afterDisableTitle = await win4.webContents.executeJavaScript('document.title');
  report.afterDisableUntouched = report.afterDisableTitle === 'plain';
  report.afterDisableLoadedExtensions = normalSession.extensions.getAllExtensions().length;
  win4.destroy();

  report.storeFiles = fs.existsSync(manager.storePath) ? fs.readdirSync(manager.storePath) : [];

  win.destroy();
  privWin.destroy();

  console.log('\n=== E2E REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  const pass =
    report.installMv2.ok &&
    report.installMv2.loaded &&
    report.normalInjected &&
    report.installMv3.ok &&
    report.installMv3.loaded &&
    report.mv3Injected === true &&
    report.privateExtensionCount === 0 &&
    report.privateUntouched &&
    report.afterDisableUntouched === true &&
    report.afterDisableLoadedExtensions === 0;

  console.log(pass ? '\nE2E: PASS' : '\nE2E: FAIL');
  await cleanupWorkDir('正常退出');
  app.exit(pass ? 0 : 1);
}).catch(async (err) => {
  console.error('E2E 异常：', err);
  await cleanupWorkDir('异常退出');
  app.exit(1);
});
