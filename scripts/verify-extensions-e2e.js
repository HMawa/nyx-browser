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

app.disableHardwareAcceleration();

const workDir = path.join(os.tmpdir(), `nyx-ext-e2e-${Date.now()}`);
app.setPath('userData', path.join(workDir, 'userdata'));

const { ExtensionManager } = require(path.join(__dirname, '..', 'src/core/extensions.js'));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

app.whenReady().then(async () => {
  const report = {};

  /* ---- 造两个扩展：MV2 内容脚本（改标题）/ MV3 内容脚本 ---- */
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
  write(path.join(extMv2, 'content.js'), "document.title = 'INJECTED-MV2';");

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
  write(path.join(extMv3, 'content.js'), "document.title = 'INJECTED-MV3';");

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
  report.normalExtensions = normalSession.getAllExtensions().map((ext) => `${ext.name}@${ext.version}`);

  /* ---- 验证隐私分区：零扩展、页面不被改写 ---- */
  report.privateExtensionCount = privateSession.getAllExtensions().length;
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
    report.mv3Injected = report.mv3Title === 'INJECTED-MV3';
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
  report.afterDisableLoadedExtensions = normalSession.getAllExtensions().length;
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
    report.privateExtensionCount === 0 &&
    report.privateUntouched &&
    report.afterDisableUntouched === true &&
    report.afterDisableLoadedExtensions === 0;

  console.log(pass ? '\nE2E: PASS' : '\nE2E: FAIL');
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch (err) {
    console.log(`（临时目录清理延后：${err.code}）`);
  }
  app.exit(pass ? 0 : 1);
}).catch((err) => {
  console.error('E2E 异常：', err);
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响退出码 */
  }
  app.exit(1);
});
