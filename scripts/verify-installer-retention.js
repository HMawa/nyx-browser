/**
 * 安装后「更新源里的安装包还在吗」——AUD-03 的功能判据。
 *
 * 为什么不能只看字节：交接单原本要求 `Nyx-Setup-x.y.z.exe` 的字节流里出现
 * `nyx-keep-package` 字符串。但那条字符串写在 `build/installer.nsh` 里，**会被 LZMA 压掉**，
 * 成品 exe 里根本查不到——用它当判据永远是 false，等于门禁永远不过。
 *
 * 所以改成真装一遍看结果：
 *   ① 先装「旧版」（--previous，可选：不给就跳过这一步）
 *   ② 静默覆盖装「新版」（--installer）
 *   ③ 断言 %APPDATA%\Nyx\updates 里新版安装包**还在**，且 sha256 / 大小与 latest.json 一致
 *   ④ 断言旧版安装包**已被清掉**（留着旧包会堆积，也会让「点更新装错版本」）
 *   ⑤ 断言装完的 FileVersion 是新版
 *
 * 会真的安装软件到本机（和 test-installer-e2e.js 同位级），所以**不进 npm run verify**，
 * 由 make-release --with-installer-test 带起来，也可手动跑。
 *
 * 用法：
 *   node scripts/verify-installer-retention.js --installer=dist\Nyx-Setup-1.18.1.exe
 *   node scripts/verify-installer-retention.js --installer=… --previous=dist\legacy\Nyx-Setup-1.18.0.exe
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UPDATES_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Nyx', 'updates');
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Nyx');
const EXE = path.join(INSTALL_DIR, 'Nyx.exe');
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail === undefined || detail === '' ? '' : `｜${detail}`}`);
}

function skip(name, reason) {
  results.push({ name, pass: true, skipped: true, detail: reason });
  console.log(`  – SKIP ${name}｜${reason}`);
}

function parseArgs() {
  const args = { installer: '', previous: '' };
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith('--installer=')) args.installer = path.resolve(raw.slice('--installer='.length).replace(/^"|"$/g, ''));
    else if (raw.startsWith('--previous=')) args.previous = path.resolve(raw.slice('--previous='.length).replace(/^"|"$/g, ''));
  }
  return args;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex').toLowerCase();
}

function versionOfName(file) {
  const match = path.basename(file).match(/(\d+\.\d+\.\d+)\.exe$/i);
  return match ? match[1] : '';
}

function installedVersion() {
  if (!fs.existsSync(EXE)) return '';
  try {
    return String(require('node:child_process').execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Item -LiteralPath '${EXE}').VersionInfo.FileVersion`,
    ], { encoding: 'utf8' })).trim();
  } catch (error) {
    return '';
  }
}

function stopInstalled() {
  const script = [
    `$dir = '${INSTALL_DIR}'`,
    'Get-Process -Name Nyx -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir) } | ForEach-Object { Stop-Process -Id $_.Id -Force }',
    'Start-Sleep -Milliseconds 400',
  ].join('; ');
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  } catch (error) {
    /* 没进程也无所谓 */
  }
}

function runSetup(file) {
  const started = Date.now();
  const result = spawnSync(file, ['/S', `/D=${INSTALL_DIR}`], { timeout: SETUP_TIMEOUT_MS, stdio: 'ignore' });
  return { code: result.status === null ? 'timeout' : result.status, ms: Date.now() - started };
}

function readLatest() {
  const file = path.join(UPDATES_DIR, 'latest.json');
  if (!fs.existsSync(file)) return null;
  try {
    return { file, data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { file, data: null, error: error.message };
  }
}

function installerNameFor(version) {
  return `Nyx-Setup-${version}.exe`;
}

function main() {
  const args = parseArgs();
  const newVersion = versionOfName(args.installer);

  console.log('[安装保留验证] AUD-03：装完新版之后，更新源里的新包还在、旧包已清');
  if (!args.installer || !fs.existsSync(args.installer)) {
    console.error(`✘ 找不到新版安装包：${args.installer || '(没有 --installer)'}`);
    process.exitCode = 1;
    return;
  }
  record('新版安装包存在且版本号读得出', Boolean(newVersion), args.installer);

  // ① 旧版（可选）：装一次，确认起点是旧版
  if (args.previous && fs.existsSync(args.previous)) {
    const oldVersion = versionOfName(args.previous);
    stopInstalled();
    const before = runSetup(args.previous);
    record('先装旧版：安装程序退出码为 0', before.code === 0, `exit=${before.code}｜${before.ms}ms`);
    record(`先装旧版：装完版本是 ${oldVersion}`, installedVersion() === oldVersion, `实测 ${installedVersion()}`);
  } else {
    skip('先装旧版', '没给 --previous（或文件不存在）：只验证"覆盖装新版后新包保留"这一半');
  }

  // ② 模拟"更新已经下载好"：把新版包放进更新源，再从那里运行它（真实升级就是这么走的）
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  const staged = path.join(UPDATES_DIR, installerNameFor(newVersion));
  fs.copyFileSync(args.installer, staged);
  record(`把新版包放进更新源（模拟下载）：${installerNameFor(newVersion)}`, fs.existsSync(staged), staged);

  stopInstalled();
  const step = runSetup(staged);
  record('从更新源覆盖装新版：安装程序退出码为 0', step.code === 0, `exit=${step.code}｜${step.ms}ms`);
  record(`覆盖装新版：装完版本是 ${newVersion}`, installedVersion() === newVersion, `实测 ${installedVersion()}`);

  // ③ 新包还在，且与 latest.json 一致
  const latest = readLatest();
  record('更新源里有 latest.json 且能解析', Boolean(latest && latest.data), latest && latest.error ? latest.error : UPDATES_DIR);
  const manifest = (latest && latest.data) || {};
  const keptFile = path.join(UPDATES_DIR, installerNameFor(newVersion));
  const keptExists = fs.existsSync(keptFile);
  record(`装完后更新源里仍有 ${installerNameFor(newVersion)}`, keptExists, keptFile);
  if (keptExists) {
    const sha = sha256File(keptFile);
    const size = fs.statSync(keptFile).size;
    const wantSha = String(manifest.sha256 || '').toLowerCase();
    record('保留的包 sha256 与 latest.json 一致', Boolean(wantSha) && sha === wantSha, `实测 ${sha.slice(0, 16)}…`);
    record('保留的包大小与 latest.json 一致', Number(manifest.size) === size, `实测 ${size}`);
  }

  // ④ 旧包已被清掉
  if (args.previous && fs.existsSync(args.previous)) {
    const oldVersion = versionOfName(args.previous);
    const oldLeft = fs.existsSync(path.join(UPDATES_DIR, installerNameFor(oldVersion)));
    record(`旧版安装包 ${installerNameFor(oldVersion)} 已被清掉`, !oldLeft, oldLeft ? '还留着' : '已清理');
  } else {
    skip('旧包已清理', '没给 --previous，无从判断哪份算旧包');
  }

  // ⑤ 收尾：把本次启动检查用的进程关掉（只按完整路径）
  stopInstalled();

  const failed = results.filter((item) => !item.pass);
  const skipped = results.filter((item) => item.skipped);
  console.log('');
  console.log(`[安装保留验证] 共 ${results.length} 项：通过 ${results.length - failed.length - skipped.length}，跳过 ${skipped.length}，失败 ${failed.length}`);
  if (failed.length) {
    for (const item of failed) console.log(`  ✘ ${item.name}｜${item.detail}`);
    process.exitCode = 1;
  }
}

main();
