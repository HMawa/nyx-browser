'use strict';

/**
 * Nyx 发版脚本：把打包好的安装包整理成「可被在线升级识别」的更新源，
 * 额外做一份留档，并提供留档清理（--prune）与更新源恢复（--restore）。
 *
 * 一、正常发版（默认模式）做六件事：
 *   1. 在 dist 目录里找到本次构建出的安装包 Nyx-Setup-<版本>.exe；
 *   2. 计算 sha256 与体积；
 *   3. 生成 latest.json 清单（版本、文件名、校验值、更新说明）；
 *   4. 把安装包与清单一起复制到更新源目录（默认 %APPDATA%\Nyx\updates）；
 *   5. 留档：再把安装包与清单复制到归档目录（默认 %APPDATA%\Nyx\updates-archive\<版本>\）；
 *   6. 生成块级差分清单 Nyx-Setup-<版本>.blocks.json（512KB 一块、逐块 sha256），
 *      同样放进更新源与留档目录；updater 用它和留档里的上一版安装包做块比对，
 *      只下载变化的块。旧版 updater 不认识 latest.json 的 blocks 字段，会自动退回整包下载。
 *   结束时打印一次 Authenticode 签名状态，并输出「发布摘要」。
 *
 * 二、--prune [n]：清理旧留档。
 *   保留归档根下版本号（按语义比较，1.2.10 > 1.2.9）最大的 n 份，其余删除，默认 n = 3。
 *   - 只处理「归档根下形如 主.次.修订 的版本目录」，其它目录只告警不删；
 *   - 只动归档根，绝不碰更新源目录 %APPDATA%\Nyx\updates；
 *   - 可单独执行（不构建、不读 dist）：
 *       node scripts/make-release.js --prune          # 保留最近 3 版
 *       node scripts/make-release.js --prune 5        # 保留最近 5 版
 *   - 也可跟随正常发版一起执行：
 *       node scripts/make-release.js --release --prune 3 --notes "1.3.1：修复 …"
 *     （--release 显式表示「要发版」；只给 --prune 时不发版、不读 dist）
 *   - 与 --restore 同时给时先 prune 再 restore，保证 restore 用到的最大版本一定在保留集内。
 *
 * 三、--restore：修复被 installer 删空的更新源。
 *   不发新包、不读 dist，只从归档根里挑「版本号最大」的一份留档，
 *   把它的安装包与 latest.json 回写到更新源；若更新源已有同版本同 sha256 的文件，
 *   直接提示「无需恢复」并跳过复制。
 *   回写前做两道校验：
 *     a) 完整性：重算 exe 的 sha256 与 size，与归档 latest.json 强制比对；
 *        不一致 → 中文报错 + exit 1，且不写更新源（先校验后复制）；
 *        --force 显式跳过完整性校验（仅在明确知情时使用）。
 *     b) 发布者签名：调用 PowerShell Get-AuthenticodeSignature。
 *        Valid        → 打印「发布者签名有效｜<Subject>」；
 *        NotSigned    → 只告警（本项目当前未配置代码签名证书，若中断则本机永远无法恢复）；
 *        HashMismatch / 其它异常 → 告警「文件可能被篡改」，默认 exit 1，--force 才继续；
 *        PowerShell 不可用 / 超时（20 秒）/ 输出不可解析 → 告警「无法进行签名校验」后继续
 *        （完整性校验仍生效，不能因环境缺 PowerShell 把发版流程卡死）。
 *
 * 四、--clean-updates：清理更新源里堆着的旧安装包（默认 dry-run，只列不删）。
 *   扫描更新源目录（默认 %APPDATA%\Nyx\updates）里的
 *   `Nyx-Setup-<x.y.z>.exe`、`Nyx-Setup-<x.y.z>.exe.blockmap`、`Nyx-Setup-<x.y.z>.blocks.json`，
 *   只保留：① latest.json 指向的版本（整包/blockmap/块清单/清单一个都不动）；
 *   ② 版本号最大的 --keep-n 个版本（默认 1）。其它任何文件一律不动。
 *   逐文件三重护栏：必须是更新源目录的直接子文件（不递归）、文件名必须匹配版本模式、
 *   规范化后的绝对路径必须仍在更新源之下；任一不满足就跳过并告警。
 *   默认只打印「将删除什么、释放多少」，加 --yes 才真正删除（真实更新源上请先 dry-run 确认）。
 *   --max-age-days N：只清理「文件修改时间早于 N 天」的旧包，与 --keep-n 是与关系
 *   （既不是保留版本、又超过 N 天才删）；不传时行为与以前完全一致，用于避免刚同步的新包被误删。
 *   --target updates|archive|both：updates 清更新源（默认）；archive 清归档根下的 x.y.z 版本目录
 *   （默认保留 3 份）；both 两边都清，各自汇总后给一行合计。
 *   --json：stdout 只输出机器可读 JSON（过程日志走 stderr），供脚本消费。
 *   --out <文件>：把同一份 JSON 写入文件（UTF-8 无 BOM + 末尾换行，目录自动创建）；
 *   必须配合 --clean-updates，否则报错 exit 1；写入失败也 exit 1。
 *   顺序约定：与 --restore 同时给时先 restore 再 clean；与 --release/--prune 同时给时
 *   发版 → prune 归档 → clean-updates。
 *
 * 五、--dry-run：全链路预演，只校验 / 计算 / 打印，绝不写文件、不复制、不删除。
 *   --release --dry-run：照常算 sha256、差分块与所有目标路径，打印「预演摘要」；
 *   --restore --dry-run：只校验归档完整性与签名，打印将回写的文件，不复制；
 *   --prune --dry-run / --clean-updates --dry-run：只列不删；
 *   与 --yes 同时出现时以 --dry-run 为准（安全优先）。
 *   再与 --json 组合时：stdout 只输出机器可读 JSON，人类可读摘要走 stderr（stderr 上仍能看全过程）。
 *
 *
 *
 * installer.nsh 到底删哪些路径（据 build/installer.nsh 第 26-35 行核对）：
 *   Delete "$APPDATA\Nyx\updates\*.exe"   ; 升级完成后删掉更新源里的旧安装包
 *   Delete "$INSTDIR\updates\*.exe"       ; 兼容旧版本的收件目录，同样只删 exe
 *   Exec '"$SYSDIR\cmd.exe" /c ... del /f /q "$EXEPATH"'  ; 延迟删除安装程序自身
 *   —— 两个 updates 目录都只删 *.exe，latest.json 保留；安装程序自身也会被删。
 *   所以升级一轮后：更新源里剩下 latest.json，exe 没了，应用能读到清单却下不到包。
 *
 * 归档目录为什么放 %APPDATA%\Nyx\updates-archive\<版本>\：
 *   - 它不是 installer.nsh 删除的那两个 updates 目录（只是同级的另一个目录名），
 *     升级安装不会碰它；
 *   - 和更新源、userData 一起待在 %APPDATA%\Nyx 下，卸载/覆盖安装都不影响，
 *     重装应用后仍能找回历史安装包；
 *   - 不用 D:\Nyx-archive：该路径当前根本不存在，脚本得凭空造一个 D 盘根目录，
 *     既污染盘符根、又没有「同一处用户数据」的便利；D:\Nyx 本身还会被覆盖安装清理，
 *     把归档放到安装目录附近同样是「连锅端」风险。
 *
 * 用法汇总：
 *   正常发版：
 *     node scripts/make-release.js
 *     node scripts/make-release.js --source "E:\nyx-updates" --notes "1.1.0：新增分屏；修复启动偶发卡顿"
 *   发版并顺手清理留档（保留最近 3 版）：
 *     node scripts/make-release.js --release --prune
 *   只清理留档（不构建、不读 dist）：
 *     node scripts/make-release.js --prune 5
 *   自定义归档根（脚本会自动补 <版本> 子目录；若传的目录名本身就是版本号则直接用）：
 *     node scripts/make-release.js --archive "E:\nyx-archive"
 *   更新源被 installer 删空后恢复（无需重新构建）：
 *     node scripts/make-release.js --restore
 *     node scripts/make-release.js --restore --force       # 明知清单/签名有问题仍要回写
 *     node scripts/make-release.js --restore --source "E:\nyx-updates" --archive "E:\nyx-archive"
 *   先清理留档再恢复：
 *     node scripts/make-release.js --prune 3 --restore
 *   清理更新源里的旧安装包（默认 dry-run，只列不删）：
 *     node scripts/make-release.js --clean-updates
 *     node scripts/make-release.js --clean-updates --yes        # 真删
 *     node scripts/make-release.js --clean-updates --keep-n 2 --yes
 *   只清理 30 天前的旧包（与 --keep-n 是与关系，新同步的包不会被误删）：
 *     node scripts/make-release.js --clean-updates --max-age-days 30
 *     node scripts/make-release.js --clean-updates --keep-n 2 --max-age-days 30 --yes
 *   清理留档目录（归档默认保留 3 份）或两边一起清：
 *     node scripts/make-release.js --clean-updates --target archive
 *     node scripts/make-release.js --clean-updates --target both --keep-n 2 --yes
 *   机器可读输出（stdout 只有 JSON，过程日志走 stderr）：
 *     node scripts/make-release.js --clean-updates --target both --json
 *     node scripts/make-release.js --clean-updates --target both --json --yes
 *   把同一份 JSON 另存文件（目录自动创建；不带 --json 时 stdout 仍是人类可读日志）：
 *     node scripts/make-release.js --clean-updates --json --out "%TEMP%\nyx-out\report.json"
 *     node scripts/make-release.js --clean-updates --out report.json
 *   发版后顺手清理更新源旧包：
 *     node scripts/make-release.js --release --prune --clean-updates --yes
 *   演练（临时目录，不污染真实更新源）：
 *     node scripts/make-release.js --source "$env:TEMP\nyx-rs-test\src" --archive "$env:TEMP\nyx-rs-test\arc"
 *   全链路预演（release / restore / prune / clean-updates 都只打印、不写不删）：
 *     node scripts/make-release.js --release --dry-run
 *     node scripts/make-release.js --restore --dry-run
 *     node scripts/make-release.js --clean-updates --target both --dry-run --json
 *   机器可读预演（stdout 只有 JSON，摘要走 stderr）：
 *     node scripts/make-release.js --release --dry-run --json
 *     node scripts/make-release.js --restore --dry-run --json
 *
 * 之后在应用里点「检查更新」，或等启动后的自动检查，即可完成覆盖升级。
 * 依赖：只用 node 内置模块（child_process 调用系统自带 PowerShell 做签名检查），零第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

/**
 * 默认更新源放在用户数据目录，而不是安装目录（旧值 D:\Nyx\updates）。
 * 覆盖安装会清理安装目录，收件夹放里面会被连锅端，导致只能升一轮。
 */
const DEFAULT_SOURCE = path.join(APPDATA, 'Nyx', 'updates');

/**
 * 默认归档根：%APPDATA%\Nyx\updates-archive，实际留档落在 <归档根>\<版本>\。
 * 该目录不在 installer.nsh 的 Delete 范围内（见头部注释），升级后依然完好。
 */
const DEFAULT_ARCHIVE_ROOT = path.join(APPDATA, 'Nyx', 'updates-archive');

/** 清单文件名，与主进程「检查更新」读取的文件名保持一致 */
const MANIFEST_NAME = 'latest.json';

/**
 * 差分包块大小：512KB。
 * 块越细，命中率越高（改动只影响所在块）；但块太小会让「需要下载的块」请求数暴涨，
 * 512KB 在 113MB 安装包上是 200 多块，兼顾命中率与请求数。
 */
const BLOCK_SIZE = 512 * 1024;

/**
 * --clean-updates 认得的文件名：只处理「安装包本体 / blockmap / 块清单」这三类，
 * 其它任何文件（latest.json、README、别的 exe）一律不动。
 */
const SETUP_FILE_PATTERN = /^Nyx-Setup-\d+\.\d+\.\d+\.(?:exe|exe\.blockmap|blocks\.json)$/;

/** --prune 未给数字时保留的留档份数 */
const PRUNE_DEFAULT_KEEP = 3;

/** 归档里的版本目录名必须是「主.次.修订」，其它名字一律不参与清理 */
const VERSION_DIR_PATTERN = /^\d+\.\d+\.\d+$/;

/** 调用 PowerShell 做签名检查的超时（毫秒），避免环境异常时卡死发版流程 */
const SIGNATURE_TIMEOUT_MS = 20 * 1000;

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * 读取「值可选」的参数（如 --prune 3）：
 * 下一个 token 缺失或以 - 开头时视为没给值，返回 null，交给调用方用默认值。
 */
function readOptionalValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return { present: false, value: null };
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith('-')) return { present: true, value: null };
  return { present: true, value: next };
}

/**
 * 流式计算 sha256：历史 dist 里出现过 900MB+ 的安装包，
 * 用 readFileSync 一次性读入容易把内存顶爆，这里按 4MB 分块读。
 */
function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 生成块级差分清单：安装包按 BLOCK_SIZE 切块、逐块算 sha256。
 * updater 会拿它和本地留档里的上一版安装包做「块 hash → 偏移」比对，
 * 命中块直接复用本地字节，未命中块才用 Range 下载。
 */
function buildBlockManifest(setupPath, size, sha256, version) {
  const blocks = [];
  const fd = fs.openSync(setupPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(BLOCK_SIZE);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(BLOCK_SIZE, size - offset);
      const read = fs.readSync(fd, buffer, 0, length, offset);
      if (read <= 0) break;
      blocks.push(crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex'));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    version,
    file: `Nyx-Setup-${version}.exe`,
    size,
    blockSize: BLOCK_SIZE,
    sha256,
    blocks,
  };
}










function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


function fail(message) {
  console.error(`[发版] 失败：${message}`);
  process.exit(1);
}


function info(message) {
  console.log(`[发版] ${message}`);
}

/** 把版本号拆成数字段，便于比较 1.2.9 / 1.2.10 这类字符串 */
function versionWeight(version) {
  return String(version)
    .split('.')
    .map((part) => {
      const value = parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

/** 逐段比较版本号，返回正数表示 a 更新（纯字符串排序会把 1.2.10 排到 1.2.9 前面，必须按语义比） */
function compareVersion(a, b) {
  const left = versionWeight(a);
  const right = versionWeight(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 解析留档目录：--archive 既可传「归档根」（自动补 <版本> 子目录），
 * 也可直接传具体版本目录（目录名恰为版本号时识别，避免出现 1.2.9\1.2.9）。
 */
function resolveArchiveDir(archiveRoot, version) {
  const resolved = path.resolve(archiveRoot);
  if (path.basename(resolved) === version) return resolved;
  return path.join(resolved, version);
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 递归统计目录占用，仅用于清理时的「释放 X MB」提示 */
function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch (error) {
      // 统计失败不影响清理，忽略
    }
  }
  return total;
}

/**
 * 调用系统自带 PowerShell 读取 Authenticode 签名状态。
 * 输出经 Base64(UTF8) 回传，避免控制台代码页（GBK）把中文签名者名毁掉。
 * 任何环境问题都只返回 { available: false }，由调用方降级为告警，绝不抛出。
 */
function checkSignature(file) {
  const escapedPath = String(path.resolve(file)).replace(/'/g, "''");
  const command = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$sig = $null',
    `try { $sig = Get-AuthenticodeSignature -LiteralPath '${escapedPath}' -ErrorAction Stop } catch { $sig = $null }`,
    "if ($null -eq $sig) { Write-Output 'NYX_SIG_ERROR' } else {",
    "  $cert = ''",
    '  if ($sig.SignerCertificate) { $cert = [string]$sig.SignerCertificate.Subject }',
    '  $json = [pscustomobject]@{ Status = [string]$sig.Status; Subject = $cert } | ConvertTo-Json -Compress',
    '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    '}',
  ].join('\n');

  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: SIGNATURE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    return { available: false, reason: `无法调用 PowerShell（${error.message}）` };
  }

  if (result.error) {
    const reason =
      result.error.code === 'ETIMEDOUT'
        ? `PowerShell 调用超时（${SIGNATURE_TIMEOUT_MS / 1000} 秒）`
        : `无法调用 PowerShell（${result.error.message}）`;
    return { available: false, reason };
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    const stderr = String(result.stderr || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return { available: false, reason: `PowerShell 退出码 ${result.status}${stderr ? `：${stderr}` : ''}` };
  }

  const lastLine = String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  if (!lastLine || lastLine === 'NYX_SIG_ERROR') {
    return { available: false, reason: 'Get-AuthenticodeSignature 没有返回结果' };
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(lastLine, 'base64').toString('utf8'));
  } catch (error) {
    return { available: false, reason: 'PowerShell 输出无法解析' };
  }
  return {
    available: true,
    status: String(parsed.Status || 'Unknown'),
    subject: String(parsed.Subject || ''),
  };
}

/**
 * 把签名检查结果翻译成中文结论：
 *   level = ok    → 一切正常
 *   level = warn  → 只告警，流程继续（未签名 / 环境不支持签名校验）
 *   level = error → 文件可能被篡改，restore 默认中止（--force 才继续）
 */
function describeSignature(signature) {
  if (!signature || !signature.available) {
    const reason = signature ? signature.reason : '未知原因';
    return {
      level: 'warn',
      text: `无法进行签名校验（${reason}），已跳过发布者校验继续（完整性校验仍然生效）`,
    };
  }
  const status = String(signature.status || 'Unknown');
  if (status === 'Valid') {
    return { level: 'ok', text: `发布者签名有效｜${signature.subject || '（未取到签名者信息）'}` };
  }
  if (status === 'NotSigned') {
    return {
      level: 'warn',
      text: '安装包未做 Authenticode 签名（本项目当前未配置代码签名证书），发布者身份无法验证，已按完整性校验放行',
    };
  }
  if (status === 'HashMismatch') {
    return {
      level: 'error',
      text: '安装包签名校验失败（HashMismatch）：文件在签名后被改动过，可能被篡改',
    };
  }
  return {
    level: 'error',
    text:
      `安装包签名状态异常（${status}）：文件可能被篡改` +
      (signature.subject ? `｜签名者：${signature.subject}` : ''),
  };
}

function logSignature(signature) {
  const described = describeSignature(signature);
  if (described.level === 'error') console.warn(`[发版] 警告：${described.text}`);
  else if (described.level === 'warn') console.warn(`[发版] 提示：${described.text}`);
  else info(described.text);
  return described;
}

/**
 * 统一读取并解析最新清单（latest.json）。
 * 先去掉开头可能存在的 UTF-8 BOM（\uFEFF）再 JSON.parse：
 * Windows 侧手工编辑清单（PowerShell `Set-Content -Encoding utf8`、记事本「UTF-8」另存）
 * 或从别处拷来的文件经常带 BOM，而 JSON.parse 不认 \uFEFF，会在第一个字符处报
 * "Unexpected token ''"——看上去像清单坏了，实际只是编码前缀。
 * 解析失败返回 null（不抛异常），失败原因记在 readManifest.lastError，
 * 本次是否忽略过 BOM 记在 readManifest.lastHadBom，供调用方提示。
 */
function readManifest(file) {
  readManifest.lastError = null;
  readManifest.lastHadBom = false;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    readManifest.lastError = `读取失败（${error.message}）`;
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    readManifest.lastHadBom = true;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    readManifest.lastError = error.message;
    return null;
  }
}
readManifest.lastError = null;
readManifest.lastHadBom = false;

/**
 * 列出归档根下所有可用留档（要求 <归档根>\<版本>\latest.json 可解析且安装包存在）。
 * 三类情况分别给不同提示，避免「清单坏了」被误报成「归档目录为空」：
 *   a) 归档根不存在 / 没有任何 x.y.z 版本目录 → 「归档目录为空（没有任何可用版本）」；
 *   b) 有版本目录但全部不可用 → 逐条列出每个目录的原因，再总结「没有可用留档」；
 *   c) 部分可用 → 返回可用列表，被跳过的版本逐条告警（保留原有行为）。
 */
function listArchivedReleases(archiveRoot) {
  if (!fs.existsSync(archiveRoot)) {
    fail(
      `归档目录不存在：${archiveRoot}\n` +
        '  提示：先正常发版一次（node scripts/make-release.js）才会生成留档；' +
        '若留档在别处，请用 --archive 指定归档根。',
    );
  }
  let entries = [];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch (error) {
    fail(`归档目录无法读取：${archiveRoot}（${error.message}）`);
  }

  const versionDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!VERSION_DIR_PATTERN.test(entry.name)) {
      console.warn(`[发版] 警告：跳过非版本目录 ${entry.name}（目录名不是「主.次.修订」格式）`);
      continue;
    }
    versionDirs.push({ name: entry.name, dir: path.join(archiveRoot, entry.name) });
  }

  // 情况 a：归档根在，但一个版本目录都没有
  if (!versionDirs.length) {
    fail(
      `归档目录为空（没有任何可用版本）：${archiveRoot}\n` +
        '  归档根下没有 x.y.z 形式的版本目录。\n' +
        '  期望结构：<归档根>\\<版本>\\latest.json + <归档根>\\<版本>\\Nyx-Setup-<版本>.exe。',
    );
  }

  // 逐个版本目录检查，把不可用的原因记下来，而不是一句「无法解析」带过
  const releases = [];
  const unusable = [];
  for (const item of versionDirs) {
    const manifestPath = path.join(item.dir, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      unusable.push({ name: item.name, reason: '缺少清单 latest.json' });
      continue;
    }
    const manifest = readManifest(manifestPath);
    if (!manifest || typeof manifest !== 'object') {
      unusable.push({
        name: item.name,
        reason: `清单不可解析${readManifest.lastError ? `（${readManifest.lastError}）` : ''}`,
      });
      continue;
    }
    if (readManifest.lastHadBom) {
      console.log(
        `[发版] 提示：${item.name} 的清单带 UTF-8 BOM，已忽略 BOM 后正常解析（PowerShell/记事本另存常见）。`,
      );
    }
    const version = String(manifest.version || item.name);
    const file = String(manifest.file || `Nyx-Setup-${version}.exe`);
    const exePath = path.join(item.dir, file);
    if (!fs.existsSync(exePath)) {
      unusable.push({ name: item.name, reason: `缺少安装包 ${file}` });
      continue;
    }
    releases.push({ dir: item.dir, manifestPath, manifest, version, file, exePath });
  }

  // 情况 b：有目录但全部不可用
  if (!releases.length) {
    console.warn('[发版] 警告：归档里的版本目录均不可用，逐条原因如下：');
    for (const item of unusable) {
      console.warn(`  - ${path.join(archiveRoot, item.name)}：${item.reason}`);
    }
    fail(
      `没有可用留档：${unusable.length} 个版本目录均不可用（原因见上）：${archiveRoot}\n` +
        '  提示：可用 --prune 清掉损坏的旧留档，或重新发版生成新的留档。',
    );
  }

  // 情况 c：部分可用，跳过的逐条告警
  for (const item of unusable) {
    console.warn(
      `[发版] 警告：归档版本 ${item.name} 不可用，已跳过：${item.reason}（${path.join(archiveRoot, item.name)}）`,
    );
  }
  return releases;
}

/**
 * 清理旧留档：保留版本号最大的 keep 份，其余删除。
 * 返回 { kept, removed, freed }，供发版的「发布摘要」引用；清理日志逐条打印。
 */
function pruneMode() {
  const archiveRoot = path.resolve(readArg('archive', DEFAULT_ARCHIVE_ROOT));
  const source = path.resolve(readArg('source', DEFAULT_SOURCE));
  const pruneArg = readOptionalValue('prune');

  let keep = PRUNE_DEFAULT_KEEP;
  if (pruneArg.value !== null) {
    const raw = String(pruneArg.value).trim();
    if (!/^\d+$/.test(raw)) {
      fail(
        `--prune 的参数必须是 ≥1 的整数（收到 "${raw}"）。\n` +
          `  用法：--prune ${PRUNE_DEFAULT_KEEP}（省略参数时默认保留 ${PRUNE_DEFAULT_KEEP} 版）。`,
      );
    }
    keep = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(keep) || keep < 1) {
      fail(`--prune 的参数必须是 ≥1 的整数（收到 "${raw}"），不能保留 0 份或负数。`);
    }
  }

  // 安全护栏：归档根与更新源任何方向重叠都拒绝清理，绝不误删更新源里的安装包
  if (
    path.resolve(archiveRoot) === source ||
    isInside(archiveRoot, source) ||
    isInside(source, archiveRoot)
  ) {
    fail(
      `归档根与更新源路径重叠（归档根 ${archiveRoot}，更新源 ${source}），` +
        '为避免误删更新源里的安装包，拒绝执行清理。',
    );
  }

  console.log(`[留档] 清理归档根：${archiveRoot}（保留版本号最大的 ${keep} 份）`);

  if (!fs.existsSync(archiveRoot)) {
    console.log('[留档] 归档目录不存在，没有需要清理的留档。');
    return { kept: [], removed: [], freed: 0 };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch (error) {
    fail(`归档目录无法读取：${archiveRoot}（${error.message}）`);
  }

  const versionDirs = [];
  for (const entry of entries) {
    const full = path.join(archiveRoot, entry.name);
    if (!entry.isDirectory()) continue;
    if (!VERSION_DIR_PATTERN.test(entry.name)) {
      console.warn(
        `[留档] 警告：跳过非版本目录 ${entry.name}（目录名不是「主.次.修订」格式，不参与清理）`,
      );
      continue;
    }
    versionDirs.push({ name: entry.name, dir: full });
  }

  if (!versionDirs.length) {
    console.log('[留档] 没有需要清理的留档（归档根下没有 x.y.z 形式的版本目录）。');
    return { kept: [], removed: [], freed: 0 };
  }

  // 语义版本倒序：1.3.1、1.3.0、1.2.10、1.2.9、1.2.8……
  versionDirs.sort((a, b) => compareVersion(b.name, a.name));
  const kept = versionDirs.slice(0, keep);
  const doomed = versionDirs.slice(keep);

  console.log(`[留档] 保留 ${kept.map((item) => item.name).join('、')}`);

  const dry = hasFlag('dry-run');
  if (dry) {
    console.log('[留档] --dry-run：以下仅预演，不会删除任何目录');
  }

  const removed = [];
  const deleted = [];
  let freed = 0;
  for (const item of doomed) {
    // 双保险：只删归档根的直接子目录，且名字必须是 x.y.z，防止误删无关路径
    const parent = path.dirname(path.resolve(item.dir));
    if (parent !== path.resolve(archiveRoot) || !VERSION_DIR_PATTERN.test(item.name)) {
      console.warn(`[留档] 警告：路径可疑，已跳过未删除：${item.dir}`);
      continue;
    }
    const size = dirSize(item.dir);
    if (!dry) {
      try {
        fs.rmSync(item.dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[留档] 警告：删除失败 ${item.name}（${error.message}），已跳过`);
        continue;
      }
      deleted.push(item.name);
    }
    freed += size;
    removed.push({ name: item.name, size });
    console.log(
      dry
        ? `[留档] 预演：将删除 ${item.name}（释放 ${humanSize(size)}）`
        : `[留档] 已删除 ${item.name}（释放 ${humanSize(size)}）`,
    );
  }

  if (!removed.length) {
    console.log(`[留档] 没有需要清理的留档（现有 ${versionDirs.length} 份，保留 ${kept.length} 份）。`);
  } else {
    console.log(
      `[留档] ${dry ? '预演合计' : '合计'}释放 ${humanSize(freed)}，归档根` +
        `${dry ? '将保留' : '现有'} ${kept.length} 份留档（${kept.map((item) => item.name).join('、')}）。`,
    );
  }
  return { kept: kept.map((item) => item.name), removed, deleted, freed };
}

/** --restore：从归档里挑版本号最大的一份，先校验完整性与签名，再回写到更新源 */
function restoreMode() {
  const archiveRoot = path.resolve(readArg('archive', DEFAULT_ARCHIVE_ROOT));
  const source = path.resolve(readArg('source', DEFAULT_SOURCE));
  const force = hasFlag('force');
  // --restore --dry-run --json：stdout 只留 JSON，人类可读摘要走 stderr
  const jsonDry = hasFlag('json') && hasFlag('dry-run');
  const originalLog = console.log;
  if (jsonDry) {
    console.log = (...args) => console.error(...args);
  }
  const emitDryJson = (payload) => {
    console.log = originalLog;
    originalLog(JSON.stringify(payload, null, 2));
  };

  console.log('[发版] 恢复模式（--restore）：不构建、不生成新清单，只从归档回写更新源');
  console.log(`  更新源   ：${source}`);
  console.log(`  归档根   ：${archiveRoot}`);

  const releases = listArchivedReleases(archiveRoot).sort((a, b) => compareVersion(b.version, a.version));
  const latest = releases[0];
  console.log(`  归档版本 ：${releases.map((item) => item.version).join('、')}（取最大 ${latest.version}）`);

  // 安装包缺失：留档只有清单，无法恢复
  if (!fs.existsSync(latest.exePath)) {
    fail(
      `归档里的安装包缺失：${latest.exePath}\n` +
        `  清单 ${latest.manifestPath} 指向的 ${latest.file} 不存在，无法恢复。` +
        '请重新发版留档，或手工把对应安装包放回该目录。',
    );
  }

  // ===== 完整性校验：先重算再比对，全部通过才允许写更新源 =====
  const actualSize = fs.statSync(latest.exePath).size;
  const actualSha = sha256Of(latest.exePath);
  console.log(`  安装包   ：${latest.exePath}`);
  console.log(`  sha256   ：${actualSha}（本次重算）`);
  console.log(`  size     ：${actualSize} 字节（${humanSize(actualSize)}）`);

  const manifestSha = String(latest.manifest.sha256 || '').toLowerCase();
  const manifestSize = Number(latest.manifest.size);
  const integrityIssues = [];
  if (!manifestSha) {
    integrityIssues.push('归档清单里没有 sha256 字段，无法验证完整性');
  } else if (manifestSha !== actualSha) {
    integrityIssues.push(`sha256 不一致（清单 ${manifestSha}，实际 ${actualSha}）`);
  }
  if (!Number.isFinite(manifestSize) || manifestSize <= 0) {
    integrityIssues.push('归档清单里没有有效的 size 字段，无法验证完整性');
  } else if (manifestSize !== actualSize) {
    integrityIssues.push(`size 不一致（清单 ${manifestSize} 字节，实际 ${actualSize} 字节）`);
  }

  if (integrityIssues.length) {
    if (!force) {
      fail(
        '完整性校验未通过：\n  - ' +
          integrityIssues.join('\n  - ') +
          '\n  已中止，更新源未被写入。确认知情后可用 --force 跳过完整性校验。',
      );
    }
    console.warn('[发版] 警告：完整性校验未通过：');
    for (const issue of integrityIssues) console.warn(`  - ${issue}`);
    console.warn('  已指定 --force，跳过完整性校验继续回写（风险自负）。');
  } else {
    info('完整性校验通过：sha256 与 size 均与归档清单一致。');
  }

  // ===== 发布者签名校验（回写前，只影响是否继续）=====
  const signature = logSignature(checkSignature(latest.exePath));
  if (signature.level === 'error') {
    if (!force) {
      fail(
        `签名校验未通过：${signature.text}\n` +
          '  已中止，更新源未被写入。确认文件可信后可用 --force 强制恢复。',
      );
    }
    console.warn('[发版] 警告：已指定 --force，忽略签名异常继续恢复（风险自负）。');
  }

  const sourceExe = path.join(source, latest.file);
  const sourceManifestPath = path.join(source, MANIFEST_NAME);

  // 归档里的块级差分清单（老留档可能没有这个文件）
  const archivedBlocksName = latest.manifest.blocks ? String(latest.manifest.blocks) : '';
  const archivedBlocksPath = archivedBlocksName ? path.join(latest.dir, archivedBlocksName) : '';
  let archivedBlocksOk = false;
  if (archivedBlocksPath && fs.existsSync(archivedBlocksPath)) {
    const blockManifest = readManifest(archivedBlocksPath);
    if (!blockManifest || !Array.isArray(blockManifest.blocks)) {
      console.warn(`[发版] 警告：归档差分清单不可解析，本次不恢复它：${archivedBlocksPath}`);
    } else if (
      String(blockManifest.sha256 || '').toLowerCase() !== actualSha ||
      Number(blockManifest.size) !== actualSize
    ) {
      console.warn('[发版] 警告：归档差分清单与安装包对不上，本次不恢复它（升级时只能整包下载）。');
    } else {
      archivedBlocksOk = true;
    }
  } else if (archivedBlocksName) {
    console.warn('[发版] 警告：归档缺少差分清单，恢复后只能整包下载。');
  }

  // 「无需恢复」判定：更新源里同版本文件齐备且 sha256 相同
  if (fs.existsSync(sourceExe) && fs.existsSync(sourceManifestPath)) {
    // 统一走 readManifest：用户可能手工保存过更新源清单（带 BOM 很常见），
    // 这里读失败只说明「无法确认是同版本」，不应中断恢复流程。
    const sourceManifest = readManifest(sourceManifestPath);
    if (sourceManifest && readManifest.lastHadBom) {
      console.log('[发版] 提示：更新源清单带 UTF-8 BOM，已忽略 BOM 后解析。');
    }
    const sameVersion = sourceManifest && String(sourceManifest.version) === latest.version;
    // 归档带了差分清单时，更新源也必须有，否则「恢复」只算做了一半
    const sourceBlocksOk = archivedBlocksOk ? fs.existsSync(path.join(source, archivedBlocksName)) : true;
    if (sameVersion && sha256Of(sourceExe) === actualSha && sourceBlocksOk) {
      info(`无需恢复：更新源已有 ${latest.version}，安装包 sha256 与归档一致。`);
      console.log(`  更新源   ：${source}`);
      console.log(`  安装包   ：${sourceExe}（${humanSize(actualSize)}）`);
      console.log(`  差分清单 ：${archivedBlocksOk ? path.join(source, archivedBlocksName) : '（归档未提供）'}`);
      console.log(`  签名     ：${signature.text}`);
      console.log('');
      console.log('  下一步：在 Nyx 里点「检查更新」，启动后 8 秒也会自动检查一次。');
      if (jsonDry) {
        emitDryJson({
          dryRun: true,
          version: latest.version,
          archive: latest.dir,
          files: [],
          verified: true,
          restored: false,
          reason: `更新源已有 ${latest.version}，安装包 sha256 与归档一致，无需恢复`,
        });
      }
      return;
    }
  }

  if (hasFlag('dry-run')) {
    // 预演要回写的文件清单：JSON 与人类可读摘共用这一份
    const plannedFiles = [
      {
        op: 'copy',
        from: latest.exePath,
        to: sourceExe,
        size: actualSize,
        kind: 'installer',
      },
      {
        op: 'copy',
        from: latest.manifestPath,
        to: sourceManifestPath,
        size: fs.statSync(latest.manifestPath).size,
        kind: 'manifest',
      },
    ];
    if (archivedBlocksOk) {
      plannedFiles.push({
        op: 'copy',
        from: archivedBlocksPath,
        to: path.join(source, archivedBlocksName),
        size: fs.statSync(archivedBlocksPath).size,
        kind: 'blocks',
      });
    }
    console.log('');
    console.log('[发版] 预演（--dry-run）：校验已完成，以下文件「将」被回写，但不会复制任何东西');
    console.log(`  恢复版本 ：${latest.version}`);
    console.log(`  归档来源 ：${latest.dir}`);
    for (const file of plannedFiles) {
      const suffix = file.kind === 'blocks' ? '（差分清单）' : '';
      console.log(`  将写入   ：${file.to}（${humanSize(file.size)}）${suffix}`);
    }
    console.log(`  签名     ：${signature.text}`);
    console.log('');
    console.log('  预演摘要 ：未做任何改动（更新源与归档均未被写入）。');
    if (jsonDry) {
      emitDryJson({
        dryRun: true,
        version: latest.version,
        archive: latest.dir,
        files: plannedFiles,
        verified: true,
      });
    }
    return;
  }

  fs.mkdirSync(source, { recursive: true });
  fs.copyFileSync(latest.exePath, sourceExe);
  fs.copyFileSync(latest.manifestPath, sourceManifestPath);
  let restoredBlocks = '';
  if (archivedBlocksOk) {
    restoredBlocks = path.join(source, archivedBlocksName);
    fs.copyFileSync(archivedBlocksPath, restoredBlocks);
  }

  const restoredSha = sha256Of(sourceExe);
  const restoredSize = fs.statSync(sourceExe).size;

  info('恢复完成');
  console.log(`  恢复版本 ：${latest.version}`);
  console.log(`  安装包   ：${sourceExe}（${humanSize(restoredSize)}）`);
  console.log(`  归档来源 ：${latest.dir}`);
  console.log(
    `  sha256   ：${restoredSha}` +
      (restoredSha === actualSha
        ? '（回写后与归档一致）'
        : '（⚠ 回写后与归档不一致，请检查磁盘或重新复制）'),
  );
  console.log(
    manifestSha
      ? `  清单校验 ：${manifestSha === actualSha ? '与归档清单一致' : '⚠ 与归档清单不一致（已按 --force 跳过）'}`
      : '  清单校验 ：清单无 sha256 字段，未校验',
  );
  console.log(`  签名     ：${signature.text}`);
  console.log(`  差分清单 ：${restoredBlocks || '（归档未提供，恢复后只能整包下载）'}`);
  console.log(`  清单     ：${sourceManifestPath}`);
  console.log('');
  console.log('  现在可以在 Nyx 里点「检查更新」，启动后 8 秒也会自动检查一次。');
}

/**
 * --dry-run 下的发版预演：走完全部校验与计算（找包 / sha256 / 差分块 / 目标路径），
 * 只打印计划，不写 latest.json、不复制安装包、不生成 blocks.json。
 */
function releaseDryRun() {
  // --json：stdout 只留最终 JSON，人类可读摘要与过程日志一律走 stderr
  const json = hasFlag('json');
  const originalLog = console.log;
  if (json) {
    console.log = (...args) => console.error(...args);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const version = pkg.version;
    const source = path.resolve(readArg('source', DEFAULT_SOURCE));
    const archiveRoot = path.resolve(readArg('archive', DEFAULT_ARCHIVE_ROOT));
    const notes = readArg('notes', `${version}：常规更新。`);
    const setupName = `Nyx-Setup-${version}.exe`;
    const setupPath = path.join(DIST_DIR, setupName);

    console.log('[发版] ===== 预演（--dry-run）：只校验与打印，不写任何文件 =====');
    console.log(`  版本号   ：${version}`);
    if (!fs.existsSync(setupPath)) {
      const found = fs.existsSync(DIST_DIR)
        ? fs.readdirSync(DIST_DIR).filter((n) => n.toLowerCase().endsWith('.exe'))
        : [];
      fail(
        `没有找到安装包 ${setupName}。请先执行 npm run dist；` +
          (found.length ? `dist 目录现有：${found.join('、')}` : 'dist 目录为空。'),
      );
    }

    const size = fs.statSync(setupPath).size;
    const sha256 = sha256Of(setupPath);
    const blocksName = `Nyx-Setup-${version}.blocks.json`;
    const blocksPath = path.join(DIST_DIR, blocksName);
    const blockManifest = buildBlockManifest(setupPath, size, sha256, version);
    const blockCount = blockManifest.blocks.length;
    const manifest = {
      version,
      notes,
      file: setupName,
      sha256,
      size,
      mandatory: false,
      blocks: blocksName,
    };
    const latestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const blocksText = `${JSON.stringify(blockManifest, null, 2)}\n`;

    const archiveDir = resolveArchiveDir(archiveRoot, version);
    const signature = describeSignature(checkSignature(setupPath));

    const actions = [];
    let totalBytes = 0;
    // 小于 1MB 的文件用字节显示，免得清单类小文件全变成「0.0 MB」
    const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${bytes} 字节` : humanSize(bytes));
    // label 只给人看；--json 输出里会丢掉，保持 { order, op, from, to, size } 契约
    const plan = (label, op, from, to, bytes) => {
      actions.push({ order: actions.length + 1, op, from: from || null, to, size: bytes, label });
      totalBytes += bytes;
    };

    const latestSize = Buffer.byteLength(latestText, 'utf8');
    const blocksSize = Buffer.byteLength(blocksText, 'utf8');
    plan('写清单', 'write', null, path.join(DIST_DIR, MANIFEST_NAME), latestSize);
    plan('写差分清单', 'write', null, blocksPath, blocksSize);
    plan('复制安装包 → 更新源', 'copy', setupPath, path.join(source, setupName), size);
    plan('复制清单 → 更新源', 'copy', path.join(DIST_DIR, MANIFEST_NAME), path.join(source, MANIFEST_NAME), latestSize);
    plan('复制差分清单 → 更新源', 'copy', blocksPath, path.join(source, blocksName), blocksSize);
    plan('复制安装包 → 留档', 'copy', setupPath, path.join(archiveDir, setupName), size);
    plan('复制清单 → 留档', 'copy', path.join(DIST_DIR, MANIFEST_NAME), path.join(archiveDir, MANIFEST_NAME), latestSize);
    plan('复制差分清单 → 留档', 'copy', blocksPath, path.join(archiveDir, blocksName), blocksSize);

    console.log(`  安装包   ：${setupPath}（${size} 字节 / ${humanSize(size)}）`);
    console.log(`  sha256   ：${sha256}`);
    console.log(`  更新源   ：${source}`);
    console.log(`  留档     ：${archiveDir}`);
    console.log(`  差分清单 ：${blocksName}（${blockCount} 块 × ${humanSize(BLOCK_SIZE)}，预计 ${humanSize(blocksSize)}）`);
    console.log(`  签名     ：${signature.text}`);
    console.log('');
    console.log('  计划动作（预演，不会执行）：');
    actions.forEach((action) => {
      console.log(`    ${action.order}. ${action.label}：${action.to}（${sizeText(action.size)}）`);
    });
    console.log('');
    console.log(`  预演摘要 ：共 ${actions.length} 个写入/复制动作，合计约 ${humanSize(totalBytes)}；未做任何改动。`);

    if (json) {
      const report = {
        dryRun: true,
        version,
        installer: { file: setupName, size, sha256 },
        actions: actions.map((action) => ({
          order: action.order,
          op: action.op,
          from: action.from,
          to: action.to,
          size: action.size,
        })),
        totalBytes,
      };
      originalLog(JSON.stringify(report, null, 2));
    }
  } finally {
    console.log = originalLog;
  }
}

/** 正常发版：打包 → 算 hash → 写清单 → 复制到更新源 → 留档 → 签名检查 → 发布摘要 */
function releaseMode() {
  if (hasFlag('dry-run')) {
    releaseDryRun();
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const source = path.resolve(readArg('source', DEFAULT_SOURCE));
  const archiveRoot = path.resolve(readArg('archive', DEFAULT_ARCHIVE_ROOT));
  const notes = readArg('notes', `${version}：常规更新。`);
  const setupName = `Nyx-Setup-${version}.exe`;
  const setupPath = path.join(DIST_DIR, setupName);

  if (!fs.existsSync(setupPath)) {
    const found = fs.existsSync(DIST_DIR)
      ? fs.readdirSync(DIST_DIR).filter((n) => n.toLowerCase().endsWith('.exe'))
      : [];
    fail(
      `没有找到安装包 ${setupName}。请先执行 npm run dist；` +
        (found.length ? `dist 目录现有：${found.join('、')}` : 'dist 目录为空。'),
    );
  }

  const size = fs.statSync(setupPath).size;
  const sha256 = sha256Of(setupPath);

  // ===== 块级差分清单 =====
  // 旧版 updater 不认识 latest.json 的 blocks 字段，读到也不会坏，只会退回整包下载。
  const blocksName = `Nyx-Setup-${version}.blocks.json`;
  const blockManifest = buildBlockManifest(setupPath, size, sha256, version);
  const blockCount = blockManifest.blocks.length;

  const manifest = {
    version,
    notes,
    file: setupName,
    sha256,
    size,
    mandatory: false,
    blocks: blocksName,
  };

  fs.writeFileSync(path.join(DIST_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(DIST_DIR, blocksName), `${JSON.stringify(blockManifest, null, 2)}\n`, 'utf8');

  fs.mkdirSync(source, { recursive: true });
  fs.copyFileSync(setupPath, path.join(source, setupName));
  fs.copyFileSync(path.join(DIST_DIR, MANIFEST_NAME), path.join(source, MANIFEST_NAME));
  fs.copyFileSync(path.join(DIST_DIR, blocksName), path.join(source, blocksName));

  // ===== 留档 =====
  // 复制到更新源之后再存一份：installer.nsh 升级完会删 updates\*.exe，
  // 留档目录不在删除范围内，被删空后可用 --restore 从这里回写。
  if (isInside(archiveRoot, source) || path.resolve(archiveRoot) === source) {
    console.warn(
      `[发版] 警告：归档目录位于更新源之内（${archiveRoot}），installer.nsh 的 Delete "$APPDATA\\Nyx\\updates\\*.exe" 会把它一起删掉，留档将失效。`,
    );
  }
  const archiveDir = resolveArchiveDir(archiveRoot, version);
  let archivedBefore = false;
  try {
    archivedBefore = fs.existsSync(path.join(archiveDir, MANIFEST_NAME));
  } catch (error) {
    archivedBefore = false;
  }
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.copyFileSync(setupPath, path.join(archiveDir, setupName));
  fs.copyFileSync(path.join(DIST_DIR, MANIFEST_NAME), path.join(archiveDir, MANIFEST_NAME));
  // 留档里也放一份块清单：updater 的基线来自留档，块大小/分行方式必须与发布时一致
  fs.copyFileSync(path.join(DIST_DIR, blocksName), path.join(archiveDir, blocksName));

  // ===== 发布者签名状态（只告警不中断，发版不该被签名环境卡住）=====
  const signature = logSignature(checkSignature(setupPath));

  // ===== 跟随发版一起清理留档（--release --prune）=====
  let pruneResult = null;
  if (hasFlag('prune')) {
    pruneResult = pruneMode();
  }

  info('完成');
  console.log(`  版本号   ：${version}`);
  console.log(`  安装包   ：${setupPath}（${humanSize(size)}）`);
  console.log(`  sha256   ：${sha256}`);
  console.log(`  更新源   ：${source}`);
  console.log(`  清单     ：${path.join(source, MANIFEST_NAME)}`);
  console.log(`  留档     ：${archiveDir}` + (archivedBefore ? '（已覆盖同版本旧留档）' : ''));
  console.log(`  留档清单 ：${path.join(archiveDir, MANIFEST_NAME)}`);
  console.log(
    `  差分清单 ：${path.join(source, blocksName)}（${blockCount} 块 × ${humanSize(BLOCK_SIZE)}）`,
  );
  console.log('');
  console.log('  下一步：在 Nyx 里点「检查更新」，启动后 8 秒也会自动检查一次。');
  console.log('  升级完成后更新源里的 exe 会被安装程序删掉，届时用 --restore 从留档回写。');
  console.log('');
  console.log('  发布摘要 ：');
  console.log(`    版本     ：${version}`);
  console.log(`    安装包   ：${setupName}（${size} 字节，${humanSize(size)}）`);
  console.log(`    更新源   ：${source}`);
  console.log(`    留档     ：${archiveDir}`);
  console.log(`    完整性   ：sha256 已自算 ${sha256}，size ${size} 字节`);
  console.log(`    差分     ：${blocksName}（${blockCount} 块 × ${humanSize(BLOCK_SIZE)}），更新源与留档各一份`);
  console.log(`    签名     ：${signature.text}`);
  if (pruneResult) {
    console.log(
      `    留档清理 ：保留 ${pruneResult.kept.length} 份` +
        (pruneResult.removed.length
          ? `，删除 ${pruneResult.removed.length} 份（释放 ${humanSize(pruneResult.freed)}）`
          : '，无删除'),
    );
  }
}

/**
 * --clean-updates：清理旧安装包 / 旧留档，默认 dry-run（只列不删），加 --yes 才真删。
 * --target updates|archive|both（默认 updates，向后兼容）：
 *   updates → 更新源里的 Nyx-Setup-<x.y.z>.exe / *.exe.blockmap / *.blocks.json；
 *   archive → 归档根下的 x.y.z 版本目录（整目录递归删除）。
 * 保留：更新源 latest.json 指向的版本（无条件）+ 版本号最大的 --keep-n 个
 *  （updates 默认 1、archive 默认 3）。可选 --max-age-days N 与 keep-n 是与关系：
 *  既不保留、又超过 N 天才删。
 * 更新源逐文件三重护栏；归档额外护栏：目录名必须是 x.y.z、目录内必须有 latest.json 或
 * 对应安装包、删除前断言「保留集包含最大版本」（--restore 用它做差分基线）。
 */
function cleanUpdatesMode() {
  const json = hasFlag('json');
  const outPath = String(readArg('out', '') || '').trim();
  const originalLog = console.log;
  if (json) {
    // --json：stdout 只留最终 JSON，过程日志一律改走 stderr（中文错误仍走 stderr + exit 1）
    console.log = (...args) => console.error(...args);
  }
  try {
    const payload = runCleanUpdates();
    // stdout 与 --out 文件用同一个字符串，保证两边逐字节一致（含末尾换行）
    const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    if (outPath) {
      try {
        const resolvedOut = path.resolve(outPath);
        // 目录不存在就递归创建（--out 允许指向还没建的子目录）
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, jsonText, 'utf8');
        info(`清理报告已写入：${resolvedOut}`);
      } catch (error) {
        console.error(`[发版] 失败：无法写入 --out 文件（${outPath}）：${error.message}`);
        process.exit(1);
      }
    }
    if (json) {
      process.stdout.write(jsonText);
    }
  } finally {
    console.log = originalLog;
  }
}

/** 实际执行清理，并组装 --json 所需的机器可读结果 */
function runCleanUpdates() {
  const targetArg = readArg('target', 'updates');
  const target = String(targetArg).trim().toLowerCase();
  if (!['updates', 'archive', 'both'].includes(target)) {
    fail(`--target 只能是 updates / archive / both（收到 "${targetArg}"）。`);
  }
  const yes = hasFlag('yes') && !hasFlag('dry-run');
  const explicitKeepN = readKeepNArg();
  const maxAgeDays = readMaxAgeDaysArg();
  const source = path.resolve(readArg('source', DEFAULT_SOURCE));
  const archiveRoot = path.resolve(readArg('archive', DEFAULT_ARCHIVE_ROOT));
  const updatesKeepN = explicitKeepN === null ? 1 : explicitKeepN;
  const archiveKeepN = explicitKeepN === null ? 3 : explicitKeepN;

  const payload = {
    target,
    keepN: explicitKeepN,
    keepNByTarget: { updates: updatesKeepN, archive: archiveKeepN },
    maxAgeDays,
    dryRun: !yes,
    updates: { files: [], freed: 0, deleted: [] },
    archive: { dirs: [], freed: 0, deleted: [] },
    totalFreed: 0,
  };

  let removedFiles = 0;
  let removedDirs = 0;

  if (target === 'updates' || target === 'both') {
    const result = cleanUpdatesDir(source, { yes, keepN: updatesKeepN, maxAgeDays });
    payload.updates.files = result.removed;
    payload.updates.deleted = result.deleted;
    payload.updates.freed = result.freed;
    removedFiles += result.removed.length;
  }

  if (target === 'archive' || target === 'both') {
    const result = cleanArchiveDir(archiveRoot, {
      yes,
      keepN: archiveKeepN,
      maxAgeDays,
      source,
    });
    payload.archive.dirs = result.removed;
    payload.archive.deleted = result.deleted;
    payload.archive.freed = result.freed;
    removedDirs += result.removed.length;
  }

  payload.totalFreed = payload.updates.freed + payload.archive.freed;

  if (target === 'both') {
    const total = payload.totalFreed;
    console.log('');
    if (yes) {
      info(
        `合计已清理：删除 ${removedFiles} 个旧文件 + ${removedDirs} 个旧留档目录，释放 ${humanSize(total)}` +
          `（更新源 ${humanSize(payload.updates.freed)} + 留档 ${humanSize(payload.archive.freed)}）。`,
      );
    } else {
      info(
        `dry-run 合计：将删除 ${removedFiles} 个旧文件 + ${removedDirs} 个旧留档目录，释放 ${humanSize(total)}` +
          `（更新源 ${humanSize(payload.updates.freed)} + 留档 ${humanSize(payload.archive.freed)}）；确认后加 --yes 才会真正删除。`,
      );
    }
  }

  return payload;
}

/** 解析 --keep-n（未给返回 null，由各 target 用各自的默认值：updates 1 / archive 3） */
function readKeepNArg() {
  const keepArg = readOptionalValue('keep-n');
  if (keepArg.value === null) return null;
  const raw = String(keepArg.value).trim();
  if (!/^\d+$/.test(raw)) {
    fail(`--keep-n 的参数必须是 ≥1 的整数（收到 "${raw}"）。用法：--clean-updates --keep-n 2`);
  }
  const keepN = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(keepN) || keepN < 1) {
    fail(`--keep-n 的参数必须是 ≥1 的整数（收到 "${raw}"），不能保留 0 个版本。`);
  }
  return keepN;
}

/** 解析 --max-age-days（未给返回 null；非数字 / 0 / 负数 / 缺参都报错） */
function readMaxAgeDaysArg() {
  // 自己解析：readOptionalValue 会把 "-5" 当成下一个开关，负数就漏掉了
  const ageIndex = process.argv.indexOf('--max-age-days');
  if (ageIndex < 0) return null;
  const next = process.argv[ageIndex + 1];
  const hasValue = next !== undefined && (!next.startsWith('-') || /^-\d+$/.test(next));
  if (!hasValue) {
    fail('--max-age-days 需要一个参数（≥1 的整数），例如 --clean-updates --max-age-days 30。');
  }
  const raw = String(next).trim();
  if (!/^\d+$/.test(raw)) {
    fail(`--max-age-days 的参数必须是 ≥1 的整数（收到 "${raw}"）。用法：--clean-updates --max-age-days 30`);
  }
  const maxAgeDays = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 1) {
    fail(`--max-age-days 的参数必须是 ≥1 的整数（收到 "${raw}"），不能是 0 或负数。`);
  }
  return maxAgeDays;
}

/** 清理更新源目录里的旧安装包（--target updates） */
function cleanUpdatesDir(source, options) {
  const { yes, keepN, maxAgeDays } = options;

  console.log(
    `[清理] 更新源：${source}（${yes ? '执行删除' : 'dry-run，只列不删'}；保留最近 ${keepN} 个版本 + latest.json 指向的版本）`,
  );

  if (!fs.existsSync(source)) fail(`更新源目录不存在：${source}`);
  if (!fs.statSync(source).isDirectory()) fail(`更新源不是目录：${source}`);

  // 读 latest.json（BOM 容错）：它指向的版本必须无条件保留
  const manifest = readManifest(path.join(source, MANIFEST_NAME));
  if (manifest && readManifest.lastHadBom) {
    console.log('[清理] 提示：更新源清单带 UTF-8 BOM，已忽略 BOM 后解析。');
  }
  const pinnedVersion = manifest && manifest.version ? String(manifest.version) : '';
  if (!pinnedVersion) {
    console.warn('[清理] 警告：没有可用的 latest.json，只能按 --keep-n 保留；请确认最新版不会被误判为旧包。');
  } else {
    console.log(`[清理] 清单版本：${pinnedVersion}（无条件保留）`);
  }

  let entries = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    fail(`更新源目录无法读取：${source}（${error.message}）`);
  }

  const versions = new Set();
  const files = [];
  const foreign = [];
  const nowMs = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue; // 目录（含子目录）一律不碰，也不递归
    // 安装包三件套：Nyx-Setup-<x.y.z>.exe / .exe.blockmap / .blocks.json
    const match = /^Nyx-Setup-(\d+\.\d+\.\d+)\.(?:exe|exe\.blockmap|blocks\.json)$/.exec(entry.name);
    if (!match) {
      if (/^Nyx-Setup-/i.test(entry.name)) foreign.push(entry.name);
      continue;
    }
    const full = path.join(source, entry.name);
    let size = 0;
    let mtimeMs = nowMs;
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      size = 0;
    }
    const ageDays = Math.max(0, (nowMs - mtimeMs) / 86400000);
    versions.add(match[1]);
    files.push({ name: entry.name, full, version: match[1], size, ageDays, kind: 'installer' });
  }

  if (foreign.length) {
    console.warn(`[清理] 警告：跳过 ${foreign.length} 个无法识别版本的文件：${foreign.join('、')}`);
  }
  if (!files.length) {
    console.log('[清理] 没有需要清理的旧安装包（更新源里没有 Nyx-Setup-<x.y.z> 文件）。');
    return { removed: [], deleted: [], freed: 0 };
  }

  // 保留集合 = 版本号最大的 N 个 + latest.json 指向的版本（针对安装包）
  const keepVersions = new Set(
    [...versions].sort((a, b) => compareVersion(b, a)).slice(0, keepN),
  );
  if (pinnedVersion) {
    keepVersions.add(pinnedVersion);
    if (!versions.has(pinnedVersion)) {
      console.log(`[清理] 提示：latest.json 指向 ${pinnedVersion}，更新源里没有它的文件，无需额外保护。`);
    }
  }

  const kept = files.filter((f) => keepVersions.has(f.version));
  const notKept = files.filter((f) => !keepVersions.has(f.version));
  // 年龄过滤与 keep-n 是与关系：只有「不是保留版本」且「超过 N 天」才进入待删
  const tooNew = maxAgeDays === null ? [] : notKept.filter((f) => f.ageDays <= maxAgeDays);
  const doomed = (maxAgeDays === null ? notKept : notKept.filter((f) => f.ageDays > maxAgeDays)).sort(
    (a, b) => compareVersion(b.version, a.version) || a.name.localeCompare(b.name),
  );

  console.log(
    `[清理] 保留版本：${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}` +
      `（${kept.length} 个文件）`,
  );
  if (maxAgeDays !== null) {
    console.log(
      `[清理] 年龄策略：只清理早于 ${maxAgeDays} 天的旧包（与 --keep-n 是与关系；` +
        `${tooNew.length} 个旧文件未满 ${maxAgeDays} 天，保留）`,
    );
  }

  if (!doomed.length) {
    if (tooNew.length) {
      console.log(`[清理] 没有需要清理的旧安装包（${tooNew.length} 个旧文件未满 ${maxAgeDays} 天）。`);
    } else {
      console.log('[清理] 没有需要清理的旧安装包。');
    }
    return { removed: [], deleted: [], freed: 0 };
  }

  const showAge = maxAgeDays !== null;
  const widthName = Math.max(...doomed.map((f) => f.name.length), 12) + 2;
  console.log('');
  console.log(
    `  ${padText('文件名', widthName)}${padText('大小', 12, true)}` +
      (showAge ? padText('年龄(天)', 10, true) : '') +
      padText('归属版本', 10, true),
  );
  console.log(`  ${'-'.repeat(widthName + 20 + (showAge ? 10 : 0))}`);

  const removed = [];
  const deleted = [];
  let freed = 0;
  for (const file of doomed) {
    const resolved = path.resolve(file.full);
    const base = path.basename(resolved);
    const relative = path.relative(source, resolved);
    // 三重护栏，任一不满足就跳过并告警
    const directChild = path.dirname(resolved) === source;
    const isSetupFile = SETUP_FILE_PATTERN.test(base);
    const stillInside = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!directChild || !isSetupFile || !stillInside) {
      console.warn(`[清理] 警告：护栏拦截，已跳过：${resolved}`);
      continue;
    }

    // 删除前再按当前 stat 复核一次年龄，避免扫描后被别的进程刷新了 mtime 还照删
    if (maxAgeDays !== null) {
      let currentAgeDays = file.ageDays;
      try {
        currentAgeDays = Math.max(0, (Date.now() - fs.statSync(resolved).mtimeMs) / 86400000);
      } catch {
        /* stat 失败就沿用扫描时的年龄 */
      }
      if (currentAgeDays <= maxAgeDays) {
        console.log(`[清理] 跳过（未满 ${maxAgeDays} 天）：${base}`);
        continue;
      }
    }

    if (yes) {
      try {
        fs.unlinkSync(resolved);
      } catch (error) {
        console.warn(`[清理] 警告：删除失败 ${base}（${error.message}），已跳过`);
        continue;
      }
      deleted.push(base);
    }
    removed.push({
      name: base,
      size: file.size,
      version: file.version,
      // 年龄保留两位小数：JSON 里 5.8e-7 这种浮点噪声对消费方不友好
      ageDays: Number(file.ageDays.toFixed(2)),
      kind: 'installer',
    });
    freed += file.size;
    console.log(
      `  ${padText(base, widthName)}${padText(humanSize(file.size), 12, true)}` +
        (showAge ? padText(file.ageDays.toFixed(0), 10, true) : '') +
        padText(file.version, 10, true),
    );
  }

  console.log('');
  if (!removed.length) {
    console.log('[清理] 没有实际可清理的文件（候选都被护栏拦下了）。');
    return { removed: [], deleted: [], freed: 0 };
  }
  if (yes) {
    info(`清理完成：已删除 ${removed.length} 个旧文件，释放 ${humanSize(freed)}。`);
  } else {
    info(`dry-run：将删除 ${removed.length} 个旧文件，释放 ${humanSize(freed)}；确认后加 --yes 才会真正删除。`);
  }
  console.log(`  更新源   ：${source}`);
  console.log(`  保留版本 ：${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}`);
  console.log(
    `  保留策略 ：保留 ${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}` +
      (maxAgeDays === null ? '；只按版本号保留（未启用年龄过滤）' : `；仅清理早于 ${maxAgeDays} 天的旧包`),
  );
  return { removed, deleted, freed };
}

/**
 * 清理归档根下的旧版本目录（--target archive）。
 * 与更新源不同，这里删的是「整个 x.y.z 目录」，所以护栏更严：
 *   a) 目录名必须是 x.y.z；
 *   b) 目录内必须有 latest.json 或 Nyx-Setup-<版本>.exe（否则当作用户手工目录，不动）；
 *   c) 先算保留集再删，并断言「版本号最大的目录一定在保留集里」（--restore 靠它做基线）；
 *   d) 删除前再确认一次目录内容与年龄，且规范化路径必须仍是归档根的直接子目录。
 */
function cleanArchiveDir(archiveRoot, options) {
  const { yes, keepN, maxAgeDays } = options;
  const source = options.source;

  console.log(
    `[留档清理] 归档根：${archiveRoot}（${yes ? '执行删除' : 'dry-run，只列不删'}；` +
      `保留最近 ${keepN} 个版本 + 更新源清单指向的版本）`,
  );

  if (!fs.existsSync(archiveRoot)) {
    console.log('[留档清理] 归档目录不存在，没有需要清理的旧留档。');
    return { removed: [], deleted: [], freed: 0 };
  }
  if (!fs.statSync(archiveRoot).isDirectory()) {
    fail(`归档根不是目录：${archiveRoot}`);
  }

  // 生效清单版本：取自更新源 latest.json，用来保护「正在升级用的那份」
  let pinnedVersion = '';
  const sourceManifest = source ? path.join(source, MANIFEST_NAME) : '';
  if (sourceManifest && fs.existsSync(sourceManifest)) {
    const manifest = readManifest(sourceManifest);
    if (manifest && manifest.version) pinnedVersion = String(manifest.version);
  }
  if (pinnedVersion) {
    console.log(`[留档清理] 更新源清单版本：${pinnedVersion}（对应目录无条件保留）`);
  } else {
    console.warn('[留档清理] 警告：读不到更新源 latest.json，只能按 --keep-n 保留。');
  }

  let entries = [];
  try {
    entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  } catch (error) {
    fail(`归档目录无法读取：${archiveRoot}（${error.message}）`);
  }

  const nowMs = Date.now();
  const versions = [];
  const foreign = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (/^Nyx-Setup-/i.test(entry.name)) foreign.push(entry.name);
      continue;
    }
    if (!/^\d+\.\d+\.\d+$/.test(entry.name)) {
      foreign.push(entry.name);
      continue;
    }
    const dir = path.join(archiveRoot, entry.name);
    const manifestPath = path.join(dir, MANIFEST_NAME);
    const exePath = path.join(dir, `Nyx-Setup-${entry.name}.exe`);
    const hasManifest = fs.existsSync(manifestPath);
    const hasExe = fs.existsSync(exePath);
    // 护栏 b：既没有清单也没有对应安装包 → 视为用户手工目录，不参与清理
    if (!hasManifest && !hasExe) {
      console.warn(
        `[留档清理] 警告：跳过 ${entry.name}（目录内既没有 ${MANIFEST_NAME} 也没有 Nyx-Setup-${entry.name}.exe）`,
      );
      continue;
    }
    // 年龄按目录内「主文件」判断：安装包优先，其次清单，最后退回目录 mtime。
    // 注意不能取两者的较大值——清单常被重新同步（mtime 很新），会把旧包误判成新包。
    let mtimeMs = 0;
    if (hasExe) {
      try {
        mtimeMs = fs.statSync(exePath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
    }
    if (!mtimeMs && hasManifest) {
      try {
        mtimeMs = fs.statSync(manifestPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
    }
    if (!mtimeMs) {
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        mtimeMs = nowMs;
      }
    }
    versions.push({
      name: entry.name,
      dir,
      ageDays: Math.max(0, (nowMs - mtimeMs) / 86400000),
      size: dirSize(dir),
      hasManifest,
      hasExe,
    });
  }

  if (foreign.length) {
    console.warn(`[留档清理] 警告：跳过 ${foreign.length} 个非版本目录/文件：${foreign.join('、')}`);
  }
  if (!versions.length) {
    console.log('[留档清理] 没有需要清理的旧留档。');
    return { removed: [], deleted: [], freed: 0 };
  }

  // 先算保留集（keep-n + 清单版本），再做断言，最后才删
  const sorted = [...versions].sort((a, b) => compareVersion(b.name, a.name));
  const keepVersions = new Set(sorted.slice(0, keepN).map((item) => item.name));
  if (pinnedVersion) keepVersions.add(pinnedVersion);
  const maxVersion = sorted[0].name;
  if (!keepVersions.has(maxVersion)) {
    // 正常情况下不可能走到这里（keep-n ≥ 1 必然含最大版本），留作断言式兜底
    console.warn(`[留档清理] 警告：断言触发——最大版本 ${maxVersion} 不在保留集，强制加入（--restore 依赖它）。`);
    keepVersions.add(maxVersion);
  }

  const kept = versions.filter((item) => keepVersions.has(item.name));
  const notKept = versions.filter((item) => !keepVersions.has(item.name));
  const tooNew = maxAgeDays === null ? [] : notKept.filter((item) => item.ageDays <= maxAgeDays);
  const doomed = (maxAgeDays === null ? notKept : notKept.filter((item) => item.ageDays > maxAgeDays)).sort(
    (a, b) => compareVersion(b.name, a.name),
  );

  console.log(
    `[留档清理] 保留版本：${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}` +
      `（${kept.length} 个目录）`,
  );
  if (maxAgeDays !== null) {
    console.log(
      `[留档清理] 年龄策略：只清理早于 ${maxAgeDays} 天的旧留档（与 --keep-n 是与关系；` +
        `${tooNew.length} 个目录未满 ${maxAgeDays} 天，保留）`,
    );
  }

  if (!doomed.length) {
    console.log(
      tooNew.length
        ? `[留档清理] 没有需要清理的旧留档（${tooNew.length} 个目录未满 ${maxAgeDays} 天）。`
        : '[留档清理] 没有需要清理的旧留档。',
    );
    return { removed: [], deleted: [], freed: 0 };
  }

  const showAge = maxAgeDays !== null;
  const widthName = Math.max(...doomed.map((item) => item.name.length), 8) + 2;
  console.log('');
  console.log(
    `  ${padText('版本目录', widthName)}${padText('大小', 12, true)}` +
      (showAge ? padText('年龄(天)', 10, true) : '') +
      padText('内容', 12, true),
  );
  console.log(`  ${'-'.repeat(widthName + 22 + (showAge ? 10 : 0))}`);

  const removed = [];
  const deleted = [];
  let freed = 0;
  for (const item of doomed) {
    const resolved = path.resolve(item.dir);
    const name = path.basename(resolved);
    const relative = path.relative(archiveRoot, resolved);
    // 三条基础护栏：直接子目录、名字是 x.y.z、规范化路径仍在归档根之下
    const directChild = path.dirname(resolved) === archiveRoot;
    const nameOk = /^\d+\.\d+\.\d+$/.test(name);
    const stillInside = Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!directChild || !nameOk || !stillInside) {
      console.warn(`[留档清理] 警告：护栏拦截，已跳过：${resolved}`);
      continue;
    }
    // 断言式保护：保留集里的目录绝不删（含最大版本与清单版本）
    if (keepVersions.has(name)) {
      console.warn(`[留档清理] 警告：保留集保护，已跳过：${resolved}`);
      continue;
    }
    // 删除前再确认内容与年龄（扫描到删除之间可能被改写）
    let hasContent = false;
    try {
      hasContent =
        fs.existsSync(path.join(resolved, MANIFEST_NAME)) ||
        fs.existsSync(path.join(resolved, `Nyx-Setup-${name}.exe`));
    } catch {
      hasContent = false;
    }
    if (!hasContent) {
      console.warn(`[留档清理] 警告：目录内容已不匹配（缺清单与安装包），已跳过：${resolved}`);
      continue;
    }
    if (maxAgeDays !== null) {
      let currentAgeDays = item.ageDays;
      try {
        // 与扫描时同一口径：安装包优先，其次清单，最后目录
        const exePath = path.join(resolved, `Nyx-Setup-${name}.exe`);
        const manifestPath = path.join(resolved, MANIFEST_NAME);
        let mtimeMs = 0;
        if (fs.existsSync(exePath)) mtimeMs = fs.statSync(exePath).mtimeMs;
        else if (fs.existsSync(manifestPath)) mtimeMs = fs.statSync(manifestPath).mtimeMs;
        else mtimeMs = fs.statSync(resolved).mtimeMs;
        currentAgeDays = Math.max(0, (Date.now() - mtimeMs) / 86400000);
      } catch {
        /* stat 失败就沿用扫描时的年龄 */
      }
      if (currentAgeDays <= maxAgeDays) {
        console.log(`[留档清理] 跳过（未满 ${maxAgeDays} 天）：${name}`);
        continue;
      }
    }

    if (yes) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[留档清理] 警告：删除失败 ${name}（${error.message}），已跳过`);
        continue;
      }
    }
    if (yes) deleted.push(name);
    removed.push({ name, size: item.size, ageDays: Number(item.ageDays.toFixed(2)), kind: 'archive' });
    freed += item.size;
    console.log(
      `  ${padText(name, widthName)}${padText(humanSize(item.size), 12, true)}` +
        (showAge ? padText(item.ageDays.toFixed(0), 10, true) : '') +
        padText(item.hasExe ? 'exe+清单' : '清单', 12, true),
    );
  }

  console.log('');
  if (!removed.length) {
    console.log('[留档清理] 没有实际可清理的目录（候选都被护栏拦下了）。');
    return { removed: [], deleted: [], freed: 0 };
  }
  if (yes) {
    info(`留档清理完成：已删除 ${removed.length} 个旧版本目录，释放 ${humanSize(freed)}。`);
  } else {
    info(
      `留档 dry-run：将删除 ${removed.length} 个旧版本目录，释放 ${humanSize(freed)}；` +
        '确认后加 --yes 才会真正删除。',
    );
  }
  console.log(`  归档根   ：${archiveRoot}`);
  console.log(`  保留版本 ：${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}`);
  console.log(
    `  保留策略 ：保留 ${[...keepVersions].sort((a, b) => compareVersion(b, a)).join('、')}` +
      (maxAgeDays === null ? '；只按版本号保留（未启用年龄过滤）' : `；仅清理早于 ${maxAgeDays} 天的旧留档`),
  );
  return { removed, deleted, freed };
}

/** 控制台表格用的定宽文本（中文按两格宽估算） */
function padText(text, width, alignRight = false) {
  const value = String(text);
  const displayWidth = [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const padding = ' '.repeat(Math.max(0, width - displayWidth));
  return alignRight ? padding + value : value + padding;
}

function printUsage() {
  console.log('[发版] 用法：');
  console.log('  node scripts/make-release.js                      正常发版（写更新源 + 留档 + 签名检查）');
  console.log('  node scripts/make-release.js --release --prune    发版后清理旧留档（默认保留最近 3 版）');
  console.log('  node scripts/make-release.js --prune [n]          只清理旧留档，不构建、不读 dist');
  console.log('  node scripts/make-release.js --restore            从留档回写更新源（无需重新构建）');
  console.log('  node scripts/make-release.js --clean-updates      更新源旧包清理（dry-run，只列不删）');
  console.log('  node scripts/make-release.js --clean-updates --yes  真正删除旧包');
  console.log('  参数：--source <更新源目录>  --archive <归档根目录>  --notes <更新说明>  --force');
  console.log('        --keep-n <N>（配合 --clean-updates，默认 1，另加清单指向的版本）  --yes');
  console.log('        --max-age-days <N>（配合 --clean-updates，只删早于 N 天的旧包，与 keep-n 是与关系）');
  console.log('        --target updates|archive|both（清更新源 / 留档目录 / 两者；缺省 updates）');
  console.log('        --json（配合 --clean-updates，或 --release/--restore 的 --dry-run，stdout 只输出 JSON）');
  console.log('        --out <文件>（配合 --clean-updates，把同一份 JSON 写入文件，目录自动创建）');
  console.log('        --dry-run（全链路预演：release/restore/prune/clean-updates 都只打印、不写不删）');
  console.log('  产物：latest.json + 安装包 + blocks.json');
}

if (hasFlag('help') || hasFlag('h')) {
  printUsage();
  process.exit(0);
}

// --out 是「导出清理报告」专用参数：不跟 --clean-updates 一起用时报错，
// 免得用户以为它在导出别的东西（比如发版摘要）。
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) {
  const outValue = process.argv[outIndex + 1];
  if (outValue === undefined || outValue.startsWith('--')) {
    fail('--out 需要一个文件路径，例如 --clean-updates --json --out report.json。');
  }
  if (!hasFlag('clean-updates')) {
    fail('--out 只能配合 --clean-updates 使用（示例：--clean-updates --json --out report.json）。');
  }
}

const wantRestore = hasFlag('restore');
const wantPrune = hasFlag('prune');
const wantClean = hasFlag('clean-updates');
const wantRelease = hasFlag('release') || hasFlag('publish');

// 安全优先：同时给 --dry-run 与 --yes 时一律按预演处理，绝不删除
if (hasFlag('dry-run') && hasFlag('yes')) {
  console.warn('[发版] 提示：--dry-run 优先于 --yes，本次只预演，不会删除任何文件。');
}

if (wantRestore) {
  // 先 prune 再 restore，最后 clean-updates：避免把刚恢复的文件当成旧包清掉
  // （保留规则本身也会护住清单版本，这里只是顺序上的双保险）。
  if (wantPrune) pruneMode();
  restoreMode();
  if (wantClean) cleanUpdatesMode();
} else if (wantRelease) {
  // 发版 → prune 归档（在 releaseMode 内）→ 清理更新源旧包
  releaseMode();
  if (wantClean) cleanUpdatesMode();
} else if (wantPrune || wantClean) {
  // 只做清理类动作：不构建、不读 dist
  if (wantPrune) pruneMode();
  if (wantClean) cleanUpdatesMode();
} else {
  releaseMode();
}
