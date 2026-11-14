'use strict';

/**
 * Nyx 安装器端到端测试（真实运行 NSIS 安装包）
 *
 * 覆盖场景：
 *   1) 静默全新安装：/S /D=<临时目录>，断言程序文件、vendor 内核、完整性清单与安装报告（模式=全新安装）；
 *   2) 覆盖安装（修复）：写用户数据标记后同包再装，断言报告模式=修复安装、数据保留、--verify-integrity 通过；
 *   3) 静默卸载保留数据："Uninstall Nyx.exe" /S，断言安装目录消失、用户数据仍在；
 *   4) 重装后完全卸载：/S /DELETEAPPDATA，断言安装目录与 %APPDATA%\Nyx 都被删除；
 *   5) 给了旧安装包（--from，或 --cross 时从 dist\legacy 自动发现）再加：
 *      降级安装 / 升级安装 / 跨两版升级（含旧格式用户数据与两次真实启动）。
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
 *   node scripts/test-installer-e2e.js --cross         # 跨版本：dist\legacy 里最老的包 → 最新包
 *
 * 退出码：0 = 全部断言通过；1 = 有失败项（失败后不再执行后续步骤）。
 */

const { spawn, spawnSync } = require('node:child_process');
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
let olderInstallerPath = null;
/** 跨版本模式：先装旧版、再直接升到新版（跳过中间版本），用于验证"跨两版升级" */
let crossMode = false;
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
  results.push({ group, name, pass: ok, skipped: false, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✔ PASS' : '✘ FAIL'} ${name}${detail ? ` ｜ ${clip(detail, 300)}` : ''}`);
  return ok;
}

/**
 * 跳过要显式记一条：清单要求「静默跳过也算缺陷」。
 * 所以跳过既不算通过也不算失败，单独计数并在汇总里列出来，附带怎么才能真跑的说明。
 */
function skip(name, detail) {
  results.push({ group, name, pass: true, skipped: true, detail: detail == null ? '' : String(detail) });
  console.log(`  – SKIP ${name}${detail ? ` ｜ ${clip(detail, 300)}` : ''}`);
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

/**
 * 归档的旧安装包目录（dist\legacy）。放进这里的包是"跨版本升级的基线"，
 * 不参与 npm run dist，也不会被 findLatestInstaller 选中当被测包。
 */
const LEGACY_DIR = path.join(ROOT, 'dist', 'legacy');

/** 列出 dist\legacy 里的安装包，按版本号从老到新 */
function listLegacyInstallers() {
  let names = [];
  try {
    names = fs.readdirSync(LEGACY_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^Nyx-Setup-.*\.exe$/i.test(name))
    .map((name) => path.join(LEGACY_DIR, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile() && Boolean(versionFromName(file));
      } catch {
        return false;
      }
    })
    .sort((a, b) => compareVersion(versionFromName(a), versionFromName(b)));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let value = null;
  let from = null;
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
    if (arg === '--cross') {
      crossMode = true;
      continue;
    }
    if (arg.startsWith('--installer=')) value = arg.slice('--installer='.length);
    else if (arg.startsWith('--from=')) from = arg.slice('--from='.length);
    else if (arg === '--installer' && args[i + 1]) {
      value = args[i + 1];
      i += 1;
    } else if (arg === '--from' && args[i + 1]) {
      from = args[i + 1];
      i += 1;
    }
  }
  if (from) olderInstallerPath = path.resolve(from.replace(/^"|"$/g, ''));
  // 跨版本模式没给 --from 时，自动从 dist\legacy 里挑最老的归档包当基线：
  // 让「1.16.0 → 当前版本」这条最远的升级路径随时可复跑，而不是每次都要人肉找包。
  if (crossMode && !olderInstallerPath) {
    const legacy = listLegacyInstallers();
    if (legacy.length) {
      olderInstallerPath = legacy[0];
      console.log(`[信息] 未指定 --from，自动选用 dist\\legacy 里最老的归档包：${path.basename(olderInstallerPath)}（共 ${legacy.length} 个归档：${legacy.map((file) => versionFromName(file)).join(' / ')}）`);
    } else {
      console.log('[信息] 没给 --from，dist\\legacy 里也没有归档安装包——本次只测全新安装 / 修复安装 / 两种卸载。');
      console.log('       要把跨版本升级也测掉：把旧安装包放进 dist\\legacy\\ 再重跑，或显式给 --from=<旧版安装包>。');
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

/**
 * 旧版安装包副本（升级 / 降级路径要用两个版本才测得出来）。
 *
 * 注意：`--from` 指向 `%APPDATA%\Nyx\updates-archive` 时，测试第一步会把整个
 * `%APPDATA%\Nyx` 搬到临时备份目录，源文件路径当场失效（这是真踩过的 ENOENT）。
 * 所以旧包必须在备份之前就落到 STAGE 里的常驻副本上。
 */
let olderStagedPath = null;

function stageOlderInstallerMaster() {
  if (!olderInstallerPath || olderStagedPath) return olderStagedPath;
  fs.mkdirSync(STAGE, { recursive: true });
  const master = path.join(STAGE, 'setup-old-master.exe');
  fs.copyFileSync(olderInstallerPath, master);
  olderStagedPath = master;
  return master;
}

function stageOlderInstaller(round) {
  if (!olderInstallerPath) return null;
  const master = stageOlderInstallerMaster();
  const copy = path.join(STAGE, `setup-old${round}.exe`);
  fs.copyFileSync(master || olderInstallerPath, copy);
  return copy;
}

/** 从 Nyx-Setup-1.17.0.exe 这样的文件名里取版本号，取不到就返回空串。 */
function versionFromName(file) {
  const match = /Nyx-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(path.basename(file || ''));
  return match ? match[1] : '';
}

/** 比较两个 x.y.z 版本号：返回负数表示 a 更老（只在这里用，所以不引 make-release 的实现）。 */
function compareVersion(a, b) {
  const left = String(a || '0').split('.').map((part) => Number(part) || 0);
  const right = String(b || '0').split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 读 exe 的 FileVersion（产品版本号写在这里，升级/降级后必须对得上）。 */
function exeVersion(file) {
  if (!exists(file)) return '';
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.FileVersion`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  return String(res.stdout || '').trim();
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

  if (olderInstallerPath) {
    expect(
      '旧版安装包存在且是文件（--from）',
      exists(olderInstallerPath) && fs.statSync(olderInstallerPath).isFile(),
      olderInstallerPath,
    );
    expect(
      '旧版与新版不是同一个文件（同版本测不出升级/降级）',
      path.resolve(olderInstallerPath) !== path.resolve(installerPath),
      `${path.basename(olderInstallerPath)} ／ ${path.basename(installerPath)}`,
    );
    const oldVersion = versionFromName(olderInstallerPath);
    const newVersion = versionFromName(installerPath);
    expect(
      '两个安装包文件名里都能读出 x.y.z 版本号',
      !!oldVersion && !!newVersion,
      `旧 ${oldVersion || '（读不出）'} ／ 新 ${newVersion || '（读不出）'}`,
    );
    expect(
      '两个版本号不相同',
      oldVersion !== newVersion,
      `${oldVersion} ／ ${newVersion}`,
    );
    if (crossMode) {
      const parts = String(oldVersion || '').split('.').map((item) => Number(item) || 0);
      const nextParts = String(newVersion || '').split('.').map((item) => Number(item) || 0);
      expect(
        '跨版本模式：旧版确实比新版低（否则不是"升级"）',
        parts[0] < nextParts[0] || (parts[0] === nextParts[0] && parts[1] < nextParts[1]),
        `${oldVersion} → ${newVersion}`,
      );
    }
  } else {
    skip(
      crossMode
        ? '跨版本升级路径（--cross 需要同时给 --from=<旧版安装包>）'
        : '升级安装 / 降级安装路径（需要 --from=<旧版安装包>）',
      '只给一个安装包时无法真跑「旧→新」「新→旧」，本次只测全新安装 / 修复安装 / 保留数据卸载 / 完全卸载',
    );
  }

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

/**
 * 降级：新版装完后，用旧版安装包覆盖。安装器应当判成「降级安装」并保留个人数据。
 * 这条路径以前从来没测过——只测同版本覆盖（修复）是看不出降级判定的。
 */
async function step2DowngradeToOlder() {
  group = '步骤 2｜覆盖安装（降级：旧版覆盖新版）';
  const oldVersion = versionFromName(olderInstallerPath);
  console.log(`\n${'-'.repeat(72)}\n[步骤 2] 用旧版安装包覆盖新版，应判定为降级安装（目标 ${oldVersion}）`);

  fs.mkdirSync(APP_DATA, { recursive: true });
  fs.writeFileSync(MARKER, `nyx-installer-e2e marker\npid=${PID}\ntime=${new Date().toISOString()}\n`, 'utf8');
  expect('写入用户数据标记 %APPDATA%\\Nyx\\e2e-marker.txt', exists(MARKER), MARKER);

  const setup = stageOlderInstaller(2);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '降级安装返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('降级后 Nyx.exe 仍在', exists(NYX_EXE), NYX_EXE);
  expect('降级后用户数据标记仍在（个人数据不被覆盖）', exists(MARKER), MARKER);

  await waitFor(() => exists(REPORT), 15000);
  const report = readReportText(REPORT);
  console.log('  [安装报告]');
  printReport(report);
  expect('安装报告模式 = 降级安装', modeIs(report, '降级安装'), modeDetail(report));

  const version = exeVersion(NYX_EXE);
  expect('降级后程序版本回到旧版', !!oldVersion && version.includes(oldVersion), `FileVersion=${version}，期望含 ${oldVersion}`);
}

// ---------- 跨版本升级（--cross） ----------

/** 这些是旧版本写过、新版本必须还能读的用户数据（跨版升级最容易在这里翻车） */
const LEGACY_FIXTURES = [
  {
    name: 'ui-preferences.json',
    // 1.16.0 时代的偏好：没有 offlineCacheEnabled 这个后加的键
    body: { theme: 'ink', downloadAsk: false, downloadDir: '', showLinkBadge: true, showModeSwitch: true },
  },
  {
    name: 'agent-sites.json',
    // 1.16.0 时代的站点名单：没有 version 字段，规则是纯字符串
    body: { globalEnabled: true, allow: ['legacy.example.com'], block: [] },
  },
  {
    name: 'page-cache.json',
    // v1 的缓存表：只有 text，没有 blocks / images
    body: {
      version: 1,
      items: [
        {
          url: 'https://legacy.example.com/old-page',
          title: '旧版本存下来的页面',
          text: '这是 1.16.0 时期缓存下来的正文，用来验证跨版本升级之后还读得出来。',
          chars: 36,
          at: Date.now(),
        },
      ],
    },
  },
];

function seedLegacyUserData() {
  fs.mkdirSync(APP_DATA, { recursive: true });
  for (const item of LEGACY_FIXTURES) {
    const file = path.join(APP_DATA, item.name);
    fs.writeFileSync(file, `${JSON.stringify(item.body, null, 2)}\n`, 'utf8');
    expect(`写入旧版本用户数据 ${item.name}`, exists(file), file);
  }
}

/** 起一次真程序，确认旧数据不会把它炸掉；活够时长就算过，然后按路径收尸。 */
async function launchAppSmoke(label) {
  let child = null;
  let error = '';
  try {
    child = spawn(NYX_EXE, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    child.on('error', (err) => {
      error = err && err.message ? err.message : String(err);
    });
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  if (!child) {
    expect(`${label}：程序能启动`, false, error || 'spawn 失败');
    return;
  }
  const startedAt = Date.now();
  await waitFor(() => false, 9000);
  const alive = listNyxProcesses().filter((item) => item.Path && item.Path.toLowerCase().startsWith(WORK.toLowerCase()));
  expect(
    `${label}：旧版本用户数据下程序能正常启动并存活`,
    alive.length > 0,
    alive.length ? `存活 ${alive.length} 个进程，${Math.round((Date.now() - startedAt) / 100) / 10}s` : `没有存活进程${error ? `，错误：${error}` : ''}`,
  );
  killTestProcesses();
  await waitFor(() => listNyxProcesses().length === 0, 15000);
}

/**
 * 跨版本第 1 步：全新安装旧版，写下旧格式用户数据。
 *
 * 之所以要"真写旧格式文件"：跨版升级最常见的坑不是安装器，是新版读到旧数据就崩。
 * 只断言 FileVersion 变了，等于没测这一层。
 */
async function stepCrossInstallOlder() {
  group = '步骤 1｜跨版本：先装旧版';
  const oldVersion = versionFromName(olderInstallerPath);
  console.log(`\n${'-'.repeat(72)}\n[步骤 1] 全新安装旧版（${oldVersion}），再写入旧格式用户数据`);

  const setup = stageOlderInstaller(1);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '旧版静默安装返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('旧版安装后存在 Nyx.exe', exists(NYX_EXE), NYX_EXE);
  const version = exeVersion(NYX_EXE);
  expect(
    '旧版安装后程序版本是旧版',
    !!oldVersion && version.includes(oldVersion),
    `FileVersion=${version}，期望含 ${oldVersion}`,
  );

  // 旧版安装器不一定写安装报告（这项能力是后续版本才加的），有就验、没有就显式记 SKIP
  await waitFor(() => exists(REPORT), 8000);
  if (exists(REPORT)) {
    const report = readReportText(REPORT);
    console.log('  [安装报告]');
    printReport(report);
    expect('旧版安装报告模式 = 全新安装', modeIs(report, '全新安装'), modeDetail(report));
  } else {
    skip(
      '旧版安装报告模式 = 全新安装',
      `${oldVersion} 的安装器还没有安装报告（install-report.txt），只能靠 FileVersion 与注册表判断装成功了`,
    );
  }
  fs.writeFileSync(MARKER, `nyx-installer-e2e cross marker\npid=${PID}\ntime=${new Date().toISOString()}\n`, 'utf8');
  expect('写入用户数据标记', exists(MARKER), MARKER);
  seedLegacyUserData();

  await launchAppSmoke('旧版启动');
}

/** 跨版本第 2 步：新版直接盖上去（跳过中间版本），并要求旧数据原样还在、新版能起来。 */
async function stepCrossUpgradeToNew() {
  group = '步骤 2｜跨版本：直接升到新版';
  const oldVersion = versionFromName(olderInstallerPath);
  const newVersion = versionFromName(installerPath);
  console.log(`\n${'-'.repeat(72)}\n[步骤 2] 新版直接覆盖旧版（${oldVersion} → ${newVersion}，跳过中间版本）`);

  const setup = stageInstaller(2);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '跨版本升级返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('跨版本升级后 Nyx.exe 仍在', exists(NYX_EXE), NYX_EXE);
  expect('跨版本升级后用户数据标记仍在', exists(MARKER), MARKER);

  await waitFor(() => exists(REPORT), 15000);
  const report = readReportText(REPORT);
  console.log('  [安装报告]');
  printReport(report);
  expect('安装报告模式 = 升级安装', modeIs(report, '升级安装'), modeDetail(report));

  const version = exeVersion(NYX_EXE);
  expect(
    '跨版本升级后程序版本是新版',
    !!newVersion && version.includes(newVersion),
    `FileVersion=${version}，期望含 ${newVersion}`,
  );

  for (const item of LEGACY_FIXTURES) {
    const file = path.join(APP_DATA, item.name);
    expect(`跨版本升级后旧用户数据 ${item.name} 仍在`, exists(file), file);
  }

  const verify = runVerifyIntegrity(NYX_EXE);
  expect(
    '跨版本升级后的程序自检（--verify-integrity）退出 0',
    verify.status === 0,
    `exit=${verify.status}${verify.error ? `，错误：${verify.error}` : ''}${verify.stderr ? `，stderr：${clip(verify.stderr, 200)}` : ''}`,
  );

  await launchAppSmoke('新版启动（带着旧版本用户数据）');
}

/** 升级：旧版装完后用新版覆盖，应当判成「升级安装」。 */
async function step3UpgradeBackToNew() {  group = '步骤 3｜覆盖安装（升级：新版覆盖旧版）';
  const newVersion = versionFromName(installerPath);
  const oldVersion = versionFromName(olderInstallerPath);
  console.log(`\n${'-'.repeat(72)}\n[步骤 3] 用新版覆盖旧版，应判定为升级安装（${oldVersion} → ${newVersion}）`);

  const setup = stageInstaller(3);
  const res = runSetup(setup, INSTALL_DIR);
  expect(
    '升级安装返回 0',
    res.status === 0,
    `exit=${res.status}，用时 ${res.ms}ms${res.error ? `，错误：${res.error}` : ''}${res.stderr ? `，stderr：${clip(res.stderr, 200)}` : ''}`,
  );

  await waitFor(() => exists(NYX_EXE), 60000);
  expect('升级后 Nyx.exe 仍在', exists(NYX_EXE), NYX_EXE);
  expect('升级后用户数据标记仍在（个人数据不被覆盖）', exists(MARKER), MARKER);

  await waitFor(() => exists(REPORT), 15000);
  const report = readReportText(REPORT);
  console.log('  [安装报告]');
  printReport(report);
  expect('安装报告模式 = 升级安装', modeIs(report, '升级安装'), modeDetail(report));

  const version = exeVersion(NYX_EXE);
  expect('升级后程序版本是新版', !!newVersion && version.includes(newVersion), `FileVersion=${version}，期望含 ${newVersion}`);

  const verify = runVerifyIntegrity(NYX_EXE);
  expect(
    '升级后的程序自检（--verify-integrity）退出 0',
    verify.status === 0,
    `exit=${verify.status}${verify.error ? `，错误：${verify.error}` : ''}${verify.stderr ? `，stderr：${clip(verify.stderr, 200)}` : ''}`,
  );
}

async function step2RepairInstall(label) {
  group = label || '步骤 2｜覆盖安装（修复）';
  console.log(`\n${'-'.repeat(72)}\n[修复] 写用户数据标记后同版本覆盖安装，应判定为修复安装`);

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
    item.skipped ? 'SKIP' : item.pass ? 'PASS' : 'FAIL',
    clip(item.detail || '', 60),
  ]);
  const head = ['#', '步骤', '断言', '结果', '关键值'];
  const widths = head.map((title, col) => Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[col]))));
  const line = (cells) => `│ ${cells.map((cell, col) => padTo(cell, widths[col])).join(' │ ')} │`;
  const divider = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`;

  console.log(`\n${'='.repeat(78)}`);
  console.log('  测试汇总（PASS / FAIL / SKIP）');
  console.log(`┌${widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`);
  console.log(line(head));
  console.log(divider);
  for (const row of rows) console.log(line(row));
  console.log(`└${widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`);

  const skipped = results.filter((item) => item.skipped);
  const failed = results.filter((item) => !item.pass);
  const passed = results.filter((item) => item.pass && !item.skipped);
  console.log(`共 ${results.length} 项断言：通过 ${passed.length} 项，失败 ${failed.length} 项，跳过 ${skipped.length} 项`);
  if (skipped.length) {
    console.log('跳过项（不是通过，是没测）：');
    for (const item of skipped) console.log(`  · [${item.group}] ${item.name}｜${clip(item.detail, 200)}`);
  }
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) console.log(`  · [${item.group}] ${item.name}｜${clip(item.detail, 200)}`);
  }
}

function printUsage() {
  console.log('用法：');
  console.log('  node scripts/test-installer-e2e.js --installer=<安装包绝对路径>');
  console.log('  node scripts/test-installer-e2e.js          # 自动取 dist 下最新的 Nyx-Setup-*.exe');
  console.log('  node scripts/test-installer-e2e.js --installer=dist\\Nyx-Setup-1.17.1.exe --from=dist\\Nyx-Setup-1.17.0.exe');
  console.log('       加 --from 才会真跑「升级安装」（旧→新）与「降级安装」（新→旧）两条路径；');
  console.log('       不给我会显式记成 SKIP 并说明原因——静默跳过不算测过。');
  console.log('  node scripts/test-installer-e2e.js --installer=dist\\Nyx-Setup-1.17.2.exe --from=<1.16.0 安装包> --cross');
  console.log('       --cross：先全新装旧版、写入旧格式用户数据、起一次程序，再直接升到新版（跳过中间版本），');
  console.log('       验证「跨两版升级」既不丢数据、新版也能带着旧数据正常启动。');
  console.log('       --cross 不给 --from 时，自动选用 dist\\legacy 里最老的归档安装包当基线（找不到会明说）；');
  console.log('       归档目录只放"升级基线"，不会被当成被测的最新包。');
  console.log('  node scripts/test-installer-e2e.js --preflight-only   # 只跑环境检查，不做任何改动');
  console.log('');
  console.log('说明：会静默安装到 %TEMP%\\nyx-e2e-<pid>\\install，测试前自动备份并迁移 %APPDATA%\\Nyx、');
  console.log('      %LOCALAPPDATA%\\Nyx、HKCU 注册表信息与 Nyx 快捷方式，测试结束后原样还原。');
}

async function main() {
  console.log('='.repeat(78));
  console.log('  Nyx 安装器端到端测试：全新安装 / 升级安装 / 降级安装 / 修复安装 / 两种卸载');
  console.log('='.repeat(78));

  try {
    parseArgs();
    preflight();
    if (preflightOnly) {
      record('预检完成后按 --preflight-only 退出（未做任何改动）', true, '');
    } else {
      // 旧包先落地成常驻副本：紧接着的备份会把 %APPDATA%\Nyx 整个搬走，
      // 而 --from 很可能就指向那里的 updates-archive。
      if (olderInstallerPath) stageOlderInstallerMaster();
      backupUserEnv();
      didBackup = true;
      if (crossMode && olderInstallerPath) {
        // 跨版本模式的第一步就是"全新装旧版"，所以不再跑 step1FreshInstall
        await stepCrossInstallOlder();
        await stepCrossUpgradeToNew();
        await step2RepairInstall('步骤 3｜覆盖安装（修复）');
      } else {
        await step1FreshInstall();
        if (olderInstallerPath) {
          await step2DowngradeToOlder();
          await step3UpgradeBackToNew();
          await step2RepairInstall('步骤 4｜覆盖安装（修复）');
        } else {
          await step2RepairInstall('步骤 2｜覆盖安装（修复）');
        }
      }
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
  const skipped = results.filter((item) => item.skipped);
  if (failed.length) {
    console.log('\n[结果] 存在失败断言，退出码 1。');
    process.exitCode = 1;
  } else if (preflightOnly) {
    console.log('\n[结果] 预检通过（--preflight-only：只检查环境，没有做任何安装/卸载）。');
  } else if (skipped.length) {
    console.log(`\n[结果] 已测路径全部通过，但有 ${skipped.length} 项因缺少材料跳过（不算测过）。`);
  } else {
    console.log('\n[结果] 全部断言通过：全新安装、升级安装、降级安装、修复安装、保留数据卸载与完全卸载均符合预期。');
  }
}

main().catch((err) => {
  console.error(`[致命错误] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
