'use strict';

/**
 * Nyx 安装器端到端测试（真实运行 NSIS 安装包）
 *
 * 覆盖场景：
 *   1) 静默全新安装：/S /D=<临时目录>，断言程序文件、vendor 内核、完整性清单与安装报告（模式=全新安装）；
 *   2) 覆盖安装（修复）：写用户数据标记后同包再装，断言报告模式=修复安装、数据保留、--verify-integrity 通过；
 *   3) 静默卸载保留数据："Uninstall Nyx.exe" /S，断言安装目录消失、用户数据仍在；
 *   4) 重装后完全卸载：/S /DELETEAPPDATA，断言安装目录与 %APPDATA%\Nyx 都被删除。
 *
 * 安全前提（本机是开发者机器，测试绝不能动真实用户数据）：
 *   - 测试前把 %APPDATA%\Nyx、%LOCALAPPDATA%\Nyx 整体改名迁移到 %TEMP%\e2e-archive-<pid> 下，
 *     同时备份/清理 HKCU 里的 Nyx 安装信息，并备份桌面与开始菜单的 Nyx 快捷方式；
 *   - 测试结束后按原样还原；还原失败时不会删除备份，并打印备份路径。
 *   - 若某一步无法安全备份/还原，脚本直接中止，不做任何破坏性操作。
 *
 * 用法：
 *   node scripts/test-installer-e2e.js --installer=<安装包绝对路径>
 *   node scripts/test-installer-e2e.js                 # 自动取 dist 下最新的 Nyx-Setup-*.exe
 *
 * 退出码：0 = 全部断言通过；1 = 有失败项（失败后不再执行后续步骤）。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 本机可能全局设置了 ELECTRON_RUN_AS_NODE=1：这样启动 Nyx.exe 会被当成纯 Node 跑，
// 参数（如 --verify-integrity）不生效、退出码也会变成 9。所有子进程都不应该继承它。
delete process.env.ELECTRON_RUN_AS_NODE;

// ---------- 路径与常量 ----------

const ROOT = path.resolve(__dirname, '..');
const TEMP = process.env.TEMP || os.tmpdir();
const PID = process.pid;

const TEST_TAG = `nyx-e2e-${PID}`;
const WORK = path.join(TEMP, TEST_TAG); // 测试临时根目录（安装目录放这里）
const STAGE = path.join(TEMP, `e2e-stage-${PID}`); // 安装包副本存放处（刻意避开 nyx-* 通配，防止被卸载器清理）
const ARCHIVE = path.join(TEMP, `e2e-archive-${PID}`); // 用户数据备份（同上，避开 nyx-* 通配）
const STAGE_MASTER = path.join(STAGE, 'setup-master.exe');

const INSTALL_DIR = path.join(WORK, 'install');
const NYX_EXE = path.join(INSTALL_DIR, 'Nyx.exe');
const UNINST_EXE = path.join(INSTALL_DIR, 'Uninstall Nyx.exe');
const RESOURCES_DIR = path.join(INSTALL_DIR, 'resources');

const APPDATA_DIR = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const LOCALAPPDATA_DIR = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const APP_DATA = path.join(APPDATA_DIR, 'Nyx');
const LOCAL_DATA = path.join(LOCALAPPDATA_DIR, 'Nyx');
const MARKER = path.join(APP_DATA, 'e2e-marker.txt');
const REPORT = path.join(APP_DATA, 'install-report.txt');

const APP_ID = 'ae30b98a-8a1a-5223-86c6-e808d0ff0ca1';
const REG_UNINSTALL = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;
const REG_INSTALL = `HKCU\\Software\\${APP_ID}`;

const MIN_FREE_BYTES = 2 * 1024 ** 3; // 安装包解压 + 两份安装副本，留 2 GB 余量
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
const UNINSTALL_WAIT_MS = 3 * 60 * 1000;

const MODES = ['全新安装', '升级安装', '修复安装', '降级安装'];

// ---------- 全局状态 ----------

const results = [];
let group = '预检';
let installerPath = null;
let didBackup = false;
let preflightOnly = false;

const backup = {
  appData: null,
  localData: null,
  regs: [], // { key, file, existed }
  shortcuts: [], // { original, saved }
};

// ---------- 断言与记录 ----------

class AssertFailure extends Error {}

function record(name, pass, detail) {
  const ok = !!pass;
  results.push({ group, name, pass: ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✔ PASS' : '✘ FAIL'} ${name}${detail ? ` ｜ ${clip(detail, 300)}` : ''}`);
  return ok;
}

function expect(name, pass, detail) {
  if (!record(name, pass, detail)) throw new AssertFailure(name);
}

// ---------- 通用工具 ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clip(value, max = 400) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ⏎ ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(500);
  }
  return predicate();
}

function freeBytes(p) {
  try {
    const stat = fs.statfsSync(p);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return -1;
  }
}

function formatGB(bytes) {
  return bytes < 0 ? '未知' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return width;
}

function padTo(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// ---------- PowerShell / 注册表 ----------

function runPowerShell(script, timeout = 60000) {
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout },
  );
  return {
    status: res.status,
    stdout: String(res.stdout || '').trim(),
    stderr: String(res.stderr || '').trim(),
    error: res.error ? res.error.message : null,
  };
}

function listNyxProcesses() {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "$items = @(Get-Process -Name 'Nyx','Uninstall Nyx' | Select-Object Id,ProcessName,Path); " +
    "if ($items.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $items -Compress }";
  const out = runPowerShell(script, 30000).stdout;
  try {
    const data = JSON.parse(out);
    return Array.isArray(data) ? data : [data];
  } catch {
    return [];
  }
}

function killTestProcesses() {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    `Get-Process -Name 'Nyx','Uninstall Nyx' | Where-Object { $_.Path -and ($_.Path.StartsWith('${WORK}', 'OrdinalIgnoreCase') -or $_.Path.StartsWith('${STAGE}', 'OrdinalIgnoreCase')) } | ForEach-Object { Stop-Process -Id $_.Id -Force }`;
  runPowerShell(script, 60000);
}

function shellFolders() {
  const res = runPowerShell("[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')", 30000);
  const lines = res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const desktop = lines[0] || path.join(process.env.USERPROFILE || '', 'Desktop');
  const programs = lines[1] || path.join(APPDATA_DIR, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return { desktop, programs };
}

function collectNyxLnk(dir) {
  const found = [];
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.lnk$/i.test(entry.name) && /nyx/i.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function regExport(key, file) {
  const res = spawnSync('reg.exe', ['export', key, file, '/y'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: res.status === 0 && exists(file), output: clip(`${res.stdout || ''} ${res.stderr || ''}`, 200) };
}

function regDelete(key) {
  spawnSync('reg.exe', ['delete', key, '/f'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function regImport(file) {
  const res = spawnSync('reg.exe', ['import', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: res.status === 0, output: clip(`${res.stdout || ''} ${res.stderr || ''}`, 200) };
}

function registryKeyExists(key) {
  const res = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return res.status === 0;
}

// ---------- 用户数据迁移与还原 ----------

function sameVolume(a, b) {
  return path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase();
}

/** 改名迁移（同盘瞬时完成）。失败时不复制不删除，直接中止，保证真实数据不受影响。 */
function moveUserData(src, dst, label) {
  if (!exists(src)) return null;
  if (!sameVolume(src, dst)) {
    throw new Error(`${label} 与临时目录不在同一分区，无法安全迁移；测试已中止，未改动任何数据`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    throw new Error(`无法迁移 ${label}（可能被其他进程占用）：${err.message}；测试已中止，未改动该目录`);
  }
  return dst;
}

function restoreUserData(target, saved, label) {
  try {
    if (saved) {
      if (!exists(saved)) {
        record(`还原 ${label} 原始数据`, true, '备份目录已不在，视为已还原');
        return;
      }
      if (exists(target)) fs.rmSync(target, { recursive: true, force: true }); // 测试期间新产生的数据
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(saved, target);
      record(`还原 ${label} 原始数据`, true, `已从备份还原：${saved}`);
      return;
    }
    if (exists(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      record(`清理测试产生的 ${label} 残留`, true, '测试前该目录不存在，残留已删除');
    } else {
      record(`清理测试产生的 ${label} 残留`, true, '测试前不存在，测试后也无残留');
    }
  } catch (err) {
    record(`还原 ${label} 原始数据`, false, `还原失败：${err.message}；备份仍在：${saved || '（无）'}，请手动还原`);
  }
}

// ---------- 安装包与报告 ----------

function findLatestInstaller() {
  const dist = path.join(ROOT, 'dist');
  let names = [];
  try {
    names = fs.readdirSync(dist);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => /^Nyx-Setup-.*\.exe$/i.test(name))
    .map((name) => path.join(dist, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0] || null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let value = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--preflight-only') {
      preflightOnly = true;
      continue;
    }
    if (arg.startsWith('--installer=')) value = arg.slice('--installer='.length);
    else if (arg === '--installer' && args[i + 1]) {
      value = args[i + 1];
      i += 1;
    }
  }
  if (value) {
    installerPath = path.resolve(value.replace(/^"|"$/g, ''));
    return;
  }
  installerPath = findLatestInstaller();
  if (installerPath) console.log(`[信息] 未指定 --installer，自动选用最新安装包：${installerPath}`);
}

/** 从注册表备份副本 run 后读取报告；UTF-16LE（带 BOM）为主，兼容无 BOM 与 UTF-8。 */
function readReportText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros += 1;
  return zeros > 256 ? buf.toString('utf16le') : buf.toString('utf8');
}

function parseMode(text) {
  const match = /安装模式\s*[:：]\s*([^\r\n]+)/u.exec(text || '');
  if (!match) return null;
  const value = match[1].replace(/["'「」【】\s]/g, '').trim();
  return MODES.find((mode) => value.includes(mode)) || value;
}

function modeIs(text, expected) {
  const mode = parseMode(text);
  return mode ? mode === expected : String(text || '').includes(expected);
}

function modeDetail(text) {
  const mode = parseMode(text);
  return mode ? `模式=${mode}` : '报告中未解析到「安装模式」行';
}

function printReport(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  for (const line of lines.slice(0, 24)) console.log(`      ${clip(line, 160)}`);
  if (lines.length > 24) console.log(`      …（共 ${lines.length} 行，已截断）`);
}

function stageInstaller(round) {
  fs.mkdirSync(STAGE, { recursive: true });
  if (!exists(STAGE_MASTER)) fs.copyFileSync(installerPath, STAGE_MASTER);
  const copy = path.join(STAGE, `setup-round${round}.exe`);
  fs.copyFileSync(STAGE_MASTER, copy); // 安装器装完会自删，每次都跑新副本
  return copy;
}

function runSetup(exePath, installDir) {
  console.log(`  [执行] "${exePath}" /S /D=${installDir}`);
  const startedAt = Date.now();
  const res = spawnSync(exePath, ['/S', `/D=${installDir}`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: SETUP_TIMEOUT_MS,
  });
  const ms = Date.now() - startedAt;
  return {
    status: res.status,
    ms,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error ? res.error.message : null,
  };
}

function runUninstaller(exePath, extraArgs) {
  console.log(`  [执行] "${exePath}" ${extraArgs.join(' ')}`);
  const startedAt = Date.now();
  const res = spawnSync(exePath, extraArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2 * 60 * 1000,
  });
  return {
    status: res.status,
    ms: Date.now() - startedAt,
    stderr: String(res.stderr || ''),
    error: res.error ? res.error.message : null,
  };
}

function runVerifyIntegrity(exePath) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // 本机若带这个变量，Electron 会退化成纯 Node，自检参数不生效
  const startedAt = Date.now();
  const res = spawnSync(exePath, ['--verify-integrity'], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: VERIFY_TIMEOUT_MS,
  });
  console.log(`  [执行] "${exePath}" --verify-integrity（${Date.now() - startedAt}ms）`);
  return {
    status: res.status,
    stdout: clip(res.stdout, 400),
    stderr: clip(res.stderr, 400),
    error: res.error ? res.error.message : null,
  };
}

// ---------- 预检 ----------

function preflight() {
  group = '预检';
  console.log('\n[预检] 环境与参数检查');

  expect(
    '安装包存在且是文件',
    !!installerPath && exists(installerPath) && fs.statSync(installerPath).isFile(),
    installerPath || '未找到 dist\\Nyx-Setup-*.exe',
  );

  const stat = fs.statSync(installerPath);
  console.log(`  [信息] 安装包：${installerPath}`);
  console.log(`  [信息] 大小 ${(stat.size / 1024 ** 2).toFixed(1)} MB，修改时间 ${new Date(stat.mtimeMs).toLocaleString('zh-CN')}`);

  expect(
    '临时目录路径不含空格（NSIS /D 不能加引号）',
    !/\s/.test(TEMP) && !/\s/.test(WORK) && !/\s/.test(INSTALL_DIR),
    TEMP,
  );

  expect('测试工作目录尚未被占用', !exists(WORK) && !exists(STAGE) && !exists(ARCHIVE), `${WORK}；${STAGE}；${ARCHIVE}`);

  const free = freeBytes(TEMP);
  expect('临时目录所在磁盘剩余空间 ≥ 2 GB', free >= MIN_FREE_BYTES, `剩余 ${formatGB(free)}（需要 ${formatGB(MIN_FREE_BYTES)}）`);

  const procs = listNyxProcesses();
  expect(
    '本机没有运行中的 Nyx / 卸载程序',
    procs.length === 0,
    procs.length
      ? `发现 ${procs.length} 个进程：${procs.map((p) => `${p.ProcessName}(pid ${p.Id})`).join('；')}，请先退出 Nyx 再测试`
      : '未发现',
  );

  let stale = [];
  try {
    stale = fs
      .readdirSync(TEMP, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^e2e-archive-\d+$/.test(entry.name))
      .map((entry) => path.join(TEMP, entry.name));
  } catch {
    /* 忽略 */
  }
  expect(
    '没有上次测试遗留的用户数据备份',
    stale.length === 0,
    stale.length ? `${stale.join('；')}（请先手动还原，确认数据已回原位后再删除该目录）` : '未发现',
  );
}

// ---------- 备份 / 还原 ----------

function backupUserEnv() {
  group = '备份用户环境';
  console.log('\n[备份] 迁移用户数据与注册表，保证测试从"未安装"状态开始');
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.mkdirSync(ARCHIVE, { recursive: true });

  backup.appData = moveUserData(APP_DATA, path.join(ARCHIVE, `nyx-e2e-backup-${PID}`), '%APPDATA%\\Nyx');
  record('备份 %APPDATA%\\Nyx 原始数据', true, backup.appData ? `已迁移到 ${backup.appData}` : '测试前不存在，无需备份');

  backup.localData = moveUserData(LOCAL_DATA, path.join(ARCHIVE, `nyx-e2e-local-backup-${PID}`), '%LOCALAPPDATA%\\Nyx');
  record('备份 %LOCALAPPDATA%\\Nyx 原始数据', true, backup.localData ? `已迁移到 ${backup.localData}` : '测试前不存在，无需备份');

  for (const [name, key] of [
    ['uninstall', REG_UNINSTALL],
    ['install', REG_INSTALL],
  ]) {
    const file = path.join(ARCHIVE, `reg-${name}.reg`);
    const existed = registryKeyExists(key);
    const exported = existed ? regExport(key, file) : { ok: false };
    if (existed && !exported.ok) {
      throw new Error(
        `注册表项 ${key} 存在但导出失败，为避免测试结束后无法还原，测试已中止；该键未被删除`,
      );
    }
    backup.regs.push({ key, file, existed });
    regDelete(key); // 测试期间注册表视为"未安装"，保证首次安装被判为全新安装
  }
  record(
    '备份并清理 HKCU 安装/卸载注册表项',
    true,
    `已导出 ${backup.regs.filter((item) => item.existed).length} 个键，测试期间视为未安装`,
  );

  backup.shortcuts = backupShortcuts();
  record('备份桌面 / 开始菜单快捷方式', true, `共迁移 ${backup.shortcuts.length} 个 Nyx 快捷方式`);
}

function backupShortcuts() {
  const dirs = shellFolders();
  const store = path.join(ARCHIVE, 'shortcuts');
  fs.mkdirSync(store, { recursive: true });
  const saved = [];
  for (const dir of [dirs.desktop, dirs.programs]) {
    for (const lnk of collectNyxLnk(dir)) {
      const target = path.join(store, `${saved.length}.lnk`);
      try {
        fs.renameSync(lnk, target);
        saved.push({ original: lnk, saved: target });
      } catch {
        /* 被占用则留在原处，还原阶段跳过 */
      }
    }
  }
  return saved;
}

function restoreShortcuts() {
  const dirs = shellFolders();
  const restored = new Set();
  let ok = true;
  for (const item of backup.shortcuts) {
    try {
      if (!exists(item.saved)) continue;
      fs.mkdirSync(path.dirname(item.original), { recursive: true });
      if (exists(item.original)) fs.rmSync(item.original, { force: true });
      fs.renameSync(item.saved, item.original);
      restored.add(item.original.toLowerCase());
    } catch {
      ok = false;
    }
  }
  // 测试新造、且不在备份清单里的快捷方式一律清掉
  for (const dir of [dirs.desktop, dirs.programs]) {
    for (const lnk of collectNyxLnk(dir)) {
      if (!restored.has(lnk.toLowerCase())) {
        try {
          fs.rmSync(lnk, { force: true });
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  // 安装器新建的空开始菜单文件夹
  for (const dir of [dirs.programs]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/nyx/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        /* 忽略 */
      }
    }
  }
  record('还原桌面 / 开始菜单快捷方式', ok, `备份 ${backup.shortcuts.length} 个，已还原 ${restored.size} 个`);
}

function restoreRegistry() {
  let ok = true;
  const details = [];
  for (const item of backup.regs) {
    regDelete(item.key); // 先清测试写入的值
    if (item.existed && exists(item.file)) {
      const imported = regImport(item.file);
      if (!imported.ok) {
        ok = false;
        details.push(`${item.key} 导入失败（${imported.output}）`);
      }
    }
  }
  record(
    '还原 HKCU 安装/卸载注册表项',
    ok,
    ok ? `已还原 ${backup.regs.filter((item) => item.existed).length} 个键，测试前不存在的键已清除` : details.join('；'),
  );
}

function cleanup() {
  group = '清理与还原';
  console.log('\n[清理] 结束测试进程并还原用户环境');
  killTestProcesses();

  let removed = true;
  for (const dir of [WORK, STAGE]) {
    if (!exists(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      removed = false;
      record(`删除临时目录 ${dir}`, false, err.message);
    }
  }
  if (removed) record('删除测试临时目录（安装目录与安装包副本）', true, `${WORK}；${STAGE}`);

  if (!didBackup) {
    record('还原用户环境', true, '预检/备份阶段中止，未改动用户数据');
    return;
  }

  restoreUserData(APP_DATA, backup.appData, '%APPDATA%\\Nyx');
  restoreUserData(LOCAL_DATA, backup.localData, '%LOCALAPPDATA%\\Nyx');
  restoreShortcuts();
  restoreRegistry();

  try {
    fs.rmSync(ARCHIVE, { recursive: true, force: true });
  } catch {
    /* 备份目录里若还有未还原内容，retain 并在上面已报告 */
  }
}

// ---------- 四个场景 ----------

async function step1FreshInstall() {
  group = '步骤 1｜静默全新安装';
  console.log(`\n${'-'.repeat(72)}\n[步骤 1] 静默全新安装 → ${INSTALL_DIR}`);

  const setup = stageInstaller(1);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '安装器静默安装返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('安装后存在 Nyx.exe', exists(NYX_EXE), NYX_EXE);
  expect('安装后存在 resources\\app.asar', exists(path.join(RESOURCES_DIR, 'app.asar')), path.join(RESOURCES_DIR, 'app.asar'));
  expect(
    '安装后存在 resources\\vendor\\mihomo\\mihomo.exe',
    exists(path.join(RESOURCES_DIR, 'vendor', 'mihomo', 'mihomo.exe')),
    path.join(RESOURCES_DIR, 'vendor', 'mihomo', 'mihomo.exe'),
  );
  expect(
    '安装后存在 resources\\integrity.json',
    exists(path.join(RESOURCES_DIR, 'integrity.json')),
    path.join(RESOURCES_DIR, 'integrity.json'),
  );

  await waitFor(() => exists(REPORT), 15000);
  expect('安装报告 %APPDATA%\\Nyx\\install-report.txt 存在', exists(REPORT), REPORT);
  const report = readReportText(REPORT);
  console.log('  [安装报告]');
  printReport(report);
  expect('安装报告模式 = 全新安装', modeIs(report, '全新安装'), modeDetail(report));
}

async function step2RepairInstall() {
  group = '步骤 2｜覆盖安装（修复）';
  console.log(`\n${'-'.repeat(72)}\n[步骤 2] 写用户数据标记后同版本覆盖安装，应判定为修复安装`);

  fs.mkdirSync(APP_DATA, { recursive: true });
  fs.writeFileSync(MARKER, `nyx-installer-e2e marker\npid=${PID}\ntime=${new Date().toISOString()}\n`, 'utf8');
  expect('写入用户数据标记 %APPDATA%\\Nyx\\e2e-marker.txt', exists(MARKER), MARKER);

  const setup = stageInstaller(2);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '覆盖安装静默安装返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('覆盖安装后 Nyx.exe 仍在', exists(NYX_EXE), NYX_EXE);
  expect('覆盖安装后用户数据标记仍在（升级/修复保留数据）', exists(MARKER), MARKER);

  await waitFor(() => exists(REPORT), 15000);
  expect('覆盖安装后安装报告仍存在', exists(REPORT), REPORT);
  const report = readReportText(REPORT);
  console.log('  [安装报告]');
  printReport(report);
  expect('安装报告模式 = 修复安装', modeIs(report, '修复安装'), modeDetail(report));

  // 用无窗口自检代替真拉 GUI：既验证程序可运行，又不污染桌面与单实例锁
  const verify = runVerifyIntegrity(NYX_EXE);
  expect(
    'Nyx.exe --verify-integrity 退出 0',
    verify.status === 0,
    `exit=${verify.status}${verify.error ? `，错误：${verify.error}` : ''}${verify.stderr ? `，stderr：${clip(verify.stderr, 200)}` : ''}`,
  );
}

async function step3UninstallKeepData() {
  group = '步骤 3｜静默卸载（保留数据）';
  console.log(`\n${'-'.repeat(72)}\n[步骤 3] 静默卸载 "Uninstall Nyx.exe" /S，应保留用户数据`);

  expect('卸载程序存在', exists(UNINST_EXE), UNINST_EXE);

  const res = runUninstaller(UNINST_EXE, ['/S']);
  expect(
    '卸载器静默卸载返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}`,
  );

  // NSIS 卸载器会先把自身复制到 %TEMP% 再执行，原进程可能秒退，因此以安装目录消失为准
  await waitFor(() => !exists(INSTALL_DIR), UNINSTALL_WAIT_MS);
  expect('静默卸载后安装目录已删除', !exists(INSTALL_DIR), INSTALL_DIR);
  expect('静默卸载后用户数据标记仍在（未加 /DELETEAPPDATA）', exists(MARKER), MARKER);
}

async function step4UninstallDeleteData() {
  group = '步骤 4｜完全卸载（/DELETEAPPDATA）';
  console.log(`\n${'-'.repeat(72)}\n[步骤 4] 重新安装后执行 "Uninstall Nyx.exe" /S /DELETEAPPDATA，应连个人数据一起删除`);

  const setup = stageInstaller(3);
  const install = runSetup(setup, INSTALL_DIR);
  expect(
    '重装静默安装返回 0',
    install.status === 0,
    `exit=${install.status}，用时 ${install.ms}ms${install.error ? `，错误：${install.error}` : ''}`,
  );
  await waitFor(() => exists(NYX_EXE), 60000);
  expect('重装后 Nyx.exe 存在', exists(NYX_EXE), NYX_EXE);
  expect('重装后用户数据标记仍在（安装不覆盖个人数据）', exists(MARKER), MARKER);
  expect('重装后卸载程序存在', exists(UNINST_EXE), UNINST_EXE);

  const res = runUninstaller(UNINST_EXE, ['/S', '/DELETEAPPDATA']);
  expect(
    '完全卸载返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}`,
  );

  await waitFor(() => !exists(INSTALL_DIR), UNINSTALL_WAIT_MS);
  expect('完全卸载后安装目录已删除', !exists(INSTALL_DIR), INSTALL_DIR);
  await waitFor(() => !exists(APP_DATA), UNINSTALL_WAIT_MS);
  expect('完全卸载后 %APPDATA%\\Nyx 已删除', !exists(APP_DATA), APP_DATA);
}

// ---------- 汇总与入口 ----------

function printSummary() {
  const rows = results.map((item, index) => [
    String(index + 1),
    item.group,
    item.name,
    item.pass ? 'PASS' : 'FAIL',
    clip(item.detail || '', 60),
  ]);
  const head = ['#', '步骤', '断言', '结果', '关键值'];
  const widths = head.map((title, col) => Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[col]))));
  const line = (cells) => `│ ${cells.map((cell, col) => padTo(cell, widths[col])).join(' │ ')} │`;
  const divider = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`;

  console.log(`\n${'='.repeat(78)}`);
  console.log('  测试汇总（PASS / FAIL）');
  console.log(`┌${widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`);
  console.log(line(head));
  console.log(divider);
  for (const row of rows) console.log(line(row));
  console.log(`└${widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`);

  const failed = results.filter((item) => !item.pass);
  console.log(`共 ${results.length} 项断言：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) console.log(`  · [${item.group}] ${item.name}｜${clip(item.detail, 200)}`);
  }
}

function printUsage() {
  console.log('用法：');
  console.log('  node scripts/test-installer-e2e.js --installer=<安装包绝对路径>');
  console.log('  node scripts/test-installer-e2e.js          # 自动取 dist 下最新的 Nyx-Setup-*.exe');
  console.log('  node scripts/test-installer-e2e.js --preflight-only   # 只跑环境检查，不做任何改动');
  console.log('');
  console.log('说明：会静默安装到 %TEMP%\\nyx-e2e-<pid>\\install，测试前自动备份并迁移 %APPDATA%\\Nyx、');
  console.log('      %LOCALAPPDATA%\\Nyx、HKCU 注册表信息与 Nyx 快捷方式，测试结束后原样还原。');
}

async function main() {
  console.log('='.repeat(78));
  console.log('  Nyx 安装器端到端测试：全新安装 / 修复安装 / 静默卸载 / 完全卸载');
  console.log('='.repeat(78));

  try {
    parseArgs();
    preflight();
    if (preflightOnly) {
      record('预检完成后按 --preflight-only 退出（未做任何改动）', true, '');
    } else {
      backupUserEnv();
      didBackup = true;
      await step1FreshInstall();
      await step2RepairInstall();
      await step3UninstallKeepData();
      await step4UninstallDeleteData();
    }
  } catch (err) {
    if (err instanceof AssertFailure) {
      console.log(`\n[中止] ${group} 断言失败，后续步骤不再执行。`);
    } else {
      record(`流程中断（${group}）`, false, err && err.message ? err.message : String(err));
    }
  } finally {
    try {
      cleanup();
    } catch (err) {
      record('清理与还原过程未抛错', false, err && err.message ? err.message : String(err));
    }
    printSummary();
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length) {
    console.log('\n[结果] 存在失败断言，退出码 1。');
    process.exitCode = 1;
  } else {
    console.log('\n[结果] 全部断言通过：安装、修复、保留数据卸载与完全卸载均符合预期。');
  }
}

main().catch((err) => {
  console.error(`[致命错误] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
