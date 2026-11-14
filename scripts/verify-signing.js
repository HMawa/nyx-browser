'use strict';

/**
 * 代码签名回归（项数同步到 scripts/verify-all.js）。
 *
 * 两类检查：
 *   1. 静态守卫——证书怎么生成、密码怎么传、签名怎么验，都不许退回到「把私钥塞进仓库」
 *      或「把密码写进命令行」这类做法；文档必须把自签名的边界说清。
 *   2. 真实验签——只要手上有安装了签名的包，就用系统 API 读它的签名状态；
 *      Status 不是 Valid 一律判失败（Get-AuthenticodeSignature 的返回值不许被当摆设）。
 *
 * 用法：
 *   node scripts/verify-signing.js                       自动找 dist / dist-sign 里的安装包
 *   node scripts/verify-signing.js --artifact=<exe>      验指定文件
 *   node scripts/verify-signing.js --dir=<构建目录>       在目录里找安装包
 *   node scripts/verify-signing.js --no-artifact         只跑静态守卫（没打签名包时用）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeCertValidity } = require('./lib/cert-validity');

const ROOT = path.join(__dirname, '..');
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/**
 * 剔掉注释行。
 * 静态守卫用字符串/正则找「不许出现的写法」时，注释里解释这个坑的句子
 * 会被一起数进去——本仓库已经因为这件事误判过两次（剪贴板、证书）。
 */
function stripComments(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

function argValue(prefix) {
  const hit = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return hit ? hit.slice(prefix.length + 1) : '';
}

function findArtifact() {
  const explicit = argValue('--artifact');
  if (explicit) return path.resolve(ROOT, explicit);

  const dirArg = argValue('--dir');
  const dirs = dirArg
    ? [path.resolve(ROOT, dirArg)]
    : [path.join(ROOT, 'dist-sign'), path.join(ROOT, 'dist')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs
      .readdirSync(dir)
      .filter((name) => /^Nyx-Setup-.*\.exe$/i.test(name))
      .sort()
      .pop();
    if (hit) return path.join(dir, hit);
  }
  return '';
}

const signatureParser = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -FilePath $env:NYX_SIGN_TARGET
Write-Output ("Status=" + $sig.Status)
if ($sig.SignerCertificate) {
  Write-Output ("Subject=" + $sig.SignerCertificate.Subject)
  Write-Output ("Thumbprint=" + $sig.SignerCertificate.Thumbprint)
  Write-Output ("NotAfter=" + $sig.SignerCertificate.NotAfter.ToString("yyyy-MM-dd"))
}
`;

function describeSignature(filePath) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', signatureParser],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { NYX_SIGN_TARGET: filePath }) },
  );
  if (result.status !== 0) {
    return { status: 'ERROR', error: String(result.stderr || result.stdout || '').trim() };
  }
  const info = {};
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0) info[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return info;
}

function gitTracked(relPath) {
  const result = spawnSync('git', ['ls-files', relPath], { cwd: ROOT, encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

// ---------- 静态守卫 ----------

const pkg = JSON.parse(read('package.json'));
const pkgText = read('package.json');
check(
  '打包脚本分成两条路：未签名的 dist 和带自签名的 dist:signed',
  Boolean(pkg.scripts && pkg.scripts.dist === 'electron-builder --win nsis') &&
    typeof pkg.scripts['dist:signed'] === 'string' &&
    typeof pkg.scripts['sign:cert'] === 'string',
  `dist=${pkg.scripts && pkg.scripts.dist}｜dist:signed=${pkg.scripts && pkg.scripts['dist:signed']}`,
);

check(
  'package.json 里不写死证书路径与密码（证书只在本机，不进仓库）',
  !/certificateFile|certificatePassword|CSC_KEY_PASSWORD/.test(pkgText),
  '构建配置里不许出现 certificateFile / certificatePassword',
);

const certScript = read('scripts/make-signing-cert.js');
check(
  '证书是自签名代码签名证书，不是随便一张证书',
  certScript.includes('-Type CodeSigningCert') &&
    certScript.includes('-KeyUsage DigitalSignature') &&
    certScript.includes('-HashAlgorithm sha256'),
  'Type=CodeSigningCert / KeyUsage=DigitalSignature / SHA-256',
);

check(
  '私钥导出到 build/signing 且密码单独落盘，不打印到控制台',
  certScript.includes('Export-PfxCertificate') &&
    certScript.includes('password.txt') &&
    !/console\.log\([^)]*\$\{password\}/.test(certScript),
  '密码只写文件，不输出到 stdout',
);

check(
  '信任证书只写当前用户存储（不需要管理员），两个存储都写',
  certScript.includes("'Root'") &&
    certScript.includes("'TrustedPublisher'") &&
    certScript.includes("'-user'"),
  'certutil -addstore -user Root / TrustedPublisher',
);

const buildScript = read('scripts/build-signed.js');
check(
  '签名密码走环境变量 CSC_KEY_PASSWORD，不进命令行参数',
  buildScript.includes('CSC_LINK') &&
    buildScript.includes('CSC_KEY_PASSWORD') &&
    !/args\s*\.\s*push\([^)]*password/.test(buildScript) &&
    !/\['--win'[^\]]*password/.test(buildScript),
  'CSC_LINK / CSC_KEY_PASSWORD 只出现在 env 里',
);

check(
  '打包脚本默认输出到 dist-sign，不覆盖已发布的 dist',
  buildScript.includes('dist-sign') && buildScript.includes('--config.directories.output=dist-sign'),
  '默认输出 dist-sign',
);

const verifyScript = read('scripts/verify-signing.js');
check(
  '验签本身要求 Status 为 Valid，未签名不许当通过',
  verifyScript.includes('Get-AuthenticodeSignature') &&
    verifyScript.includes("Status === 'Valid'") &&
    verifyScript.includes('SignerCertificate'),
  '读 Status / SignerCertificate，只有 Valid 才算通过',
);

check(
  '.gitignore 覆盖证书目录与私钥文件',
  fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('build/signing/') &&
    fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('*.pfx'),
  'build/signing/ 与 *.pfx 都被忽略',
);

check(
  '证书私钥没有被 git 跟踪',
  gitTracked('build/signing') === '' && gitTracked('*.pfx') === '',
  'git ls-files build/signing 为空',
);

const docPath = 'docs/Nyx-代码签名说明.md';
const docText = exists(docPath) ? read(docPath) : '';
check(
  '签名说明文档写清「怎么签」与「自签名不等于公信证书」',
  Boolean(docText) &&
    docText.includes('certutil -addstore -user Root') &&
    docText.includes('SmartScreen') &&
    (docText.includes('不能证明') || docText.includes('不是公信证书')),
  docPath,
);

check(
  '没装证书的机器也能用 npm run dist 出包（签名不是硬依赖）',
  pkg.scripts.dist === 'electron-builder --win nsis' &&
    !/CSC_LINK/.test(pkg.scripts.dist) &&
    !/certificateFile/.test(pkg.scripts.dist || ''),
  'dist 不读证书',
);

// ---------- 有效期判定（纯逻辑，打包前检查与这里共用同一套规则） ----------

const base = Date.UTC(2026, 10, 14, 0, 0, 0);
const futureOk = describeCertValidity(Date.UTC(2027, 10, 14), { now: base });
check(
  '证书还没过期时判为可用，并给出剩余天数',
  futureOk.ok === true && futureOk.level === 'ok' && futureOk.daysLeft === 365 && /还有 365 天/.test(futureOk.message),
  `level=${futureOk.level}｜daysLeft=${futureOk.daysLeft}`,
);

const expired = describeCertValidity(Date.UTC(2026, 10, 11), { now: base });
check(
  '证书已过期一律判为不可用（过期签出来的包 Windows 当无效）',
  expired.ok === false && expired.level === 'expired' && expired.daysLeft === -3 && /过期 3 天/.test(expired.message),
  `level=${expired.level}｜daysLeft=${expired.daysLeft}`,
);

const soon = describeCertValidity(Date.UTC(2026, 10, 24), { now: base });
check(
  '还剩 10 天时给提醒但仍允许签（30 天阈值来自同一个函数）',
  soon.ok === true && soon.level === 'warn' && soon.daysLeft === 10 && /还有 10 天到期/.test(soon.message),
  `level=${soon.level}｜daysLeft=${soon.daysLeft}`,
);

const unknownValues = [null, '', 'not-a-date', 0].map((value) =>
  describeCertValidity(value, { now: base }),
);
check(
  '读不出到期时间一律不算有效（读不到不许当成没过期）',
  unknownValues.every((item) => item.ok === false && item.level === 'unknown' && /读不出/.test(item.message)),
  `试了 ${unknownValues.length} 种空值/脏值`,
);

const buildScriptForValidity = read('scripts/build-signed.js');
check(
  '打包前就拦过期证书：build-signed 先判有效期，不可用直接退出',
  buildScriptForValidity.includes("require('./lib/cert-validity')") &&
    buildScriptForValidity.includes('assertCertUsable()') &&
    buildScriptForValidity.includes('describeCertValidity(') &&
    /if \(!validity\.ok\) fail\(validity\.message\)/.test(buildScriptForValidity) &&
    buildScriptForValidity.includes("level === 'warn'"),
  'assertCertUsable → describeCertValidity → 不可用即 fail',
);

check(
  '--status 不许再用 Windows PowerShell 5.1 不认的 Get-PfxCertificate -Password',
  // 先剔掉注释行再判：这一条自己被"注释里解释了这个坑"误伤过一次
  !/Get-PfxCertificate[^\n]*-Password/.test(stripComments(certScript)) &&
    certScript.includes('X509Certificate2') &&
    certScript.includes('有效期：'),
  '改用 X509Certificate2 读 pfx；--status 打印剩余有效期',
);

// ---------- 真实验签 ----------

if (process.argv.includes('--no-artifact')) {
  console.log('• 跳过真实签名检查（--no-artifact）：只跑了静态守卫。');
} else {
  const artifact = findArtifact();
  if (!artifact) {
    console.log('• 跳过着真实签名检查：dist / dist-sign 里没有安装包（还没打过包）。');
  } else {
    const name = path.basename(artifact);
    const info = describeSignature(artifact);
    check(
      `安装包有有效签名：${name}`,
      info.Status === 'Valid' && /Nyx/i.test(String(info.Subject || '')),
      `Status=${info.Status}｜Subject=${info.Subject || '无'}｜指纹=${info.Thumbprint || '无'}`,
    );
    check(
      `签名证书里能看出是 Nyx 的自签名证书：${name}`,
      /Nyx Self-Signed/i.test(String(info.Subject || '')),
      `Subject=${info.Subject || '无'}`,
    );

    const unsigned = describeSignature(path.join(ROOT, 'scripts', 'verify-signing.js'));
    check(
      '未签名的文件不会被误判成已签名',
      unsigned.Status !== 'Valid',
      `普通脚本的 Status=${unsigned.Status}`,
    );
  }
}

const failed = checks.filter((item) => !item.ok);
console.log('');
console.log(`代码签名：${checks.length} 项检查，${checks.length - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  失败：${item.name}｜${item.detail || ''}`);
  process.exit(1);
}
console.log('[Nyx] 代码签名回归通过');
