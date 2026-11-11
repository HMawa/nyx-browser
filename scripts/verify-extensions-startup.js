/* 由 2026-09-20 扩展插件开发会话归档；用法见文件头注释与 PROGRESS.md「二·补 6」。
 *
 * 整机启动验证（扩展插件）：
 *   1) 在系统临时目录造一份隔离 profile，内含 1 个已启用扩展；
 *   2) 以该 profile 真实启动 Nyx 主程序（NYX_USER_DATA 隔离，全程不碰 %APPDATA%\Nyx 与安装版 D:\Nyx）；
 *   3) 启动后核验：主进程存活、普通分区已装载该扩展、隐私分区零扩展；
 *   4) 由被测进程自行退出，无需外部结束进程。
 *
 * 用法：node scripts/verify-extensions-startup.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'nyx-ext-startup-check');
const USER_DATA = path.join(WORK, 'userdata');
const SRC_EXT = path.join(WORK, 'source-ext');
const ENTRY = path.join(WORK, 'startup-entry.js');
const REPORT_FILE = path.join(WORK, 'report.json');

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('缺少依赖 electron：请先在项目根执行 npm install');
  process.exit(2);
}

const results = [];
function check(name, ok) {
  results.push([!!ok, name]);
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });

  /* ---------- 1. 造隔离 profile ---------- */
  const { ExtensionManager } = require(path.join(ROOT, 'src', 'core', 'extensions.js'));

  fs.mkdirSync(SRC_EXT, { recursive: true });
  fs.writeFileSync(
    path.join(SRC_EXT, 'manifest.json'),
    JSON.stringify({
      manifest_version: 2,
      name: '启动自检扩展',
      version: '1.0.0',
      content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'] }],
    }),
    'utf8',
  );
  fs.writeFileSync(path.join(SRC_EXT, 'c.js'), "document.title='E2E-OK';", 'utf8');

  const fakeSession = {
    loaded: new Map(),
    async loadExtension(dir) {
      this.loaded.set(dir, 'fake-id');
      return { id: 'fake-id' };
    },
    removeExtension() {},
  };

  const manager = new ExtensionManager({
    stateDir: path.join(USER_DATA, 'extensions'),
    getSession: () => fakeSession,
    log: () => {},
  });
  manager.init();
  const installRes = await manager.install(SRC_EXT);
  check('隔离 profile 预置扩展成功', installRes.ok);

  const index = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'extensions', 'extensions.json'), 'utf8'));
  check('索引内 1 条且为启用状态', index.items.length === 1 && index.items[0].enabled === true);

  /* ---------- 2. 写被测入口 ---------- */
  fs.writeFileSync(
    ENTRY,
    `'use strict';
const path = require('node:path');
const fs = require('node:fs');
process.env.NYX_USER_DATA = ${JSON.stringify(USER_DATA)};
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
const { app, session, BrowserWindow } = require('electron');
const guard = setTimeout(() => { console.log('E2E-APP: 超时未完成检查'); app.exit(2); }, 40000);
process.on('uncaughtException', (err) => console.log('E2E-APP: 未捕获异常 → ' + (err && err.message)));
require(${JSON.stringify(path.join(ROOT, 'src', 'main.js'))});
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 12000));
  const report = {
    windows: BrowserWindow.getAllWindows().length,
    normalExtensions: session.fromPartition('persist:nyx-normal').getAllExtensions().map((e) => e.name + '@' + e.version),
    privateExtensions: session.fromPartition('nyx-private').getAllExtensions().length,
  };
  const indexFile = path.join(process.env.NYX_USER_DATA, 'extensions', 'extensions.json');
  report.indexItems = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8')).items.map((i) => i.name + ':' + (i.enabled ? 'on' : 'off'))
    : [];
  const pass = report.normalExtensions.includes('启动自检扩展@1.0.0') && report.privateExtensions === 0 && report.windows >= 1;
  report.pass = pass;
  fs.writeFileSync(${JSON.stringify(REPORT_FILE)}, JSON.stringify(report, null, 2), 'utf8');
  console.log('=== APP STARTUP REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(pass ? 'E2E-APP: PASS' : 'E2E-APP: FAIL');
  clearTimeout(guard);
  app.exit(pass ? 0 : 1);
});
`,
    'utf8',
  );

  /* ---------- 3. 真实启动 ---------- */
  const run = spawnSync(electronBin, [ENTRY], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  const stdout = run.stdout || '';
  const stderr = run.stderr || '';

  const matched = stdout.match(/=== APP STARTUP REPORT ===([\s\S]*?)E2E-APP: (\w+)/);
  let report = null;
  if (fs.existsSync(REPORT_FILE)) {
    try {
      report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch {
      report = null;
    }
  }
  if (!report && matched) {
    try {
      report = JSON.parse(matched[1]);
    } catch {
      report = null;
    }
  }

  check('主程序正常退出（退出码 0）', run.status === 0);
  check('启动报告可解析', !!report);
  if (report) {
    check('主窗口已创建', report.windows >= 1);
    check('普通分区装载 1 个扩展', Array.isArray(report.normalExtensions) && report.normalExtensions.includes('启动自检扩展@1.0.0'));
    check('隐私分区零扩展', report.privateExtensions === 0);
    check('索引状态仍为启用', Array.isArray(report.indexItems) && report.indexItems.includes('启动自检扩展:on'));
  }
  check('主进程无未捕获异常', !/未捕获异常/.test(stdout));

  console.log('\n=== 主进程日志（扩展相关） ===');
  for (const line of stdout.split(/\r?\n/)) {
    if (/扩展|隔离用户数据目录/.test(line)) console.log('  ' + line.trim());
  }
  if (report) {
    console.log('\n=== 启动报告 ===');
    console.log(JSON.stringify(report, null, 2));
  }
  const lastErr = stderr.trim().split(/\r?\n/).slice(-3).join('\n  ');
  if (lastErr) console.log('\n=== 被测进程 stderr（末尾） ===\n  ' + lastErr);

  console.log('\n=== 结果 ===');
  const failed = results.filter((r) => !r[0]);
  for (const [ok, name] of results) console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  process.exitCode = failed.length ? 1 : 0;
})();
