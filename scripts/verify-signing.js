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
const { pickNewestInstaller } = require('./lib/pick-artifact');

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

  // 版本号最大的那个才算「这次的包」：按目录顺序取第一个会验到旧的，
  // 然后报一个漂亮的 Valid——看着过了，其实新包没验（真踩过）。
  const candidates = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!/^Nyx-Setup-.*\.exe$/i.test(name)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      candidates.push({ name, dir, mtimeMs });
    }
  }
  const picked = pickNewestInstaller(candidates);
  return picked ? path.join(picked.dir, picked.name) : '';
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

// ---------- 密码存放位置（凭据管理器优先，明文只作退路） ----------

const {
  SOURCE_CREDENTIAL,
  SOURCE_ENV,
  SOURCE_FILE,
  SOURCE_NONE,
  decideSigningSecret,
  describeSigningSecret,
} = require('./lib/signing-secret');
const credScript = read('scripts/lib/win-credential.js');
const secretCli = read('scripts/signing-secret.js');

const pickCredential = decideSigningSecret({ credential: 'from-cred', envValue: 'from-env', fileValue: 'from-file' });
const pickEnv = decideSigningSecret({ envValue: 'from-env', fileValue: 'from-file' });
const pickFile = decideSigningSecret({ fileValue: 'from-file' });
const pickNone = decideSigningSecret({});

check(
  '密码来源有明确优先级：凭据管理器 → 环境变量 → 明文文件 → 没有',
  pickCredential.source === SOURCE_CREDENTIAL &&
    pickCredential.secret === 'from-cred' &&
    pickCredential.warning === '' &&
    pickEnv.source === SOURCE_ENV &&
    pickFile.source === SOURCE_FILE &&
    pickNone.source === SOURCE_NONE &&
    pickNone.ok === false,
  `${pickCredential.source} / ${pickEnv.source} / ${pickFile.source} / ${pickNone.source}`,
);

check(
  '退回到明文或环境变量时每次都要说出来，不许静默',
  /明文/.test(pickFile.warning) &&
    pickFile.warning.includes('--purge-file') &&
    /环境变量/.test(pickEnv.warning) &&
    pickCredential.warning === '',
  `file=${pickFile.warning.slice(0, 18)}…｜env=${pickEnv.warning.slice(0, 18)}…`,
);

check(
  '读不到密码时报错点名三条来源与两条出路',
  pickNone.ok === false &&
    ['凭据管理器', 'NYX_SIGN_PASSWORD', 'password.txt', 'make-signing-cert.js --force', 'npm run dist'].every(
      (word) => pickNone.error.includes(word),
    ),
  '错误文案含三来源 + 两条出路',
);

check(
  '凭据读写走 Windows 凭据管理器（advapi32 的 CredRead/CredWrite/CredDelete），不是自己造加密',
  credScript.includes('advapi32.dll') &&
    credScript.includes('CredWrite') &&
    credScript.includes('CredRead') &&
    credScript.includes('CredDelete') &&
    credScript.includes("Nyx/SelfSignedCodeSigning"),
  'advapi32 + CredWrite/CredRead/CredDelete',
);

check(
  '密码只通过环境变量递给 PowerShell，不拼进脚本正文',
  credScript.includes('NYX_CRED_SECRET') &&
    !/script\s*\+\s*secret/.test(credScript) &&
    !/\$\{secret\}/.test(credScript) &&
    !/secret\s*\}\s*`/.test(credScript),
  'NYX_CRED_SECRET 只出现在 env 里',
);

check(
  '生成证书时先存凭据管理器，写不进去才明说地退回明文文件',
  certScript.includes('writeCredential(password)') &&
    certScript.includes('passwordFileWritten') &&
    certScript.includes('凭据管理器写入失败'),
  '先 writeCredential，失败才 fs.writeFileSync 并说明',
);

check(
  '打包脚本也从凭据管理器取密码（不是只改生成端）',
  buildScript.includes('readCredential()') &&
    buildScript.includes('decideSigningSecret') &&
    buildScript.includes('decided.sourceLabel'),
  'build-signed 走同一套来源判定',
);

check(
  '--status 只说密码存在哪儿，不打印密码本身',
  describeSigningSecret({ credential: 'SECRET-XYZ', credentialTarget: 'Nyx/SelfSignedCodeSigning' }).includes('有密码') &&
    !describeSigningSecret({ credential: 'SECRET-XYZ', credentialTarget: 'Nyx/SelfSignedCodeSigning' }).includes(
      'SECRET-XYZ',
    ) &&
    secretCli.includes('--purge-file') &&
    secretCli.includes('--clear') &&
    !/console\.log\([^)]*secret\s*\)/.test(secretCli),
  '状态里只出现"有密码/没有"',
);

check(
  '凭据管理器这条路径有 npm 脚本入口，且有文档说明边界',
  pkg.scripts['sign:secret'] === 'node scripts/signing-secret.js' &&
    docText.includes('凭据管理器') &&
    (docText.includes('换账户') || docText.includes('当前用户')),
  pkg.scripts['sign:secret'] || '缺 sign:secret',
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

// ---------------------------------------------------------------------------
// 安装包签名状态进界面（第五轮 ②）：判定规则与界面接线
// ---------------------------------------------------------------------------

const signingStatus = require('../src/core/signing-status');
const BASE_NOW = Date.UTC(2026, 10, 14);

const farValid = signingStatus.describeSignature(
  { status: 'Valid', subject: 'CN=Nyx Self-Signed', thumbprint: 'ABC', notAfter: '2031-11-14T00:00:00.0000000+08:00' },
  { now: BASE_NOW },
);
check(
  '有效签名且离到期还早 → 判为有效并给出剩余天数',
  farValid.ok === true && farValid.level === 'valid' && farValid.daysLeft > 1500,
  `level=${farValid.level}｜daysLeft=${farValid.daysLeft}`,
);

const soonValid = signingStatus.describeSignature(
  { status: 'Valid', notAfter: '2026-11-24T00:00:00.0000000+08:00' },
  { now: BASE_NOW },
);
check(
  '签名有效但证书 30 天内到期 → 提醒（不是失败）',
  soonValid.ok === true && soonValid.level === 'expiring' && soonValid.daysLeft === 10 && /重新签/.test(soonValid.message),
  `level=${soonValid.level}｜daysLeft=${soonValid.daysLeft}`,
);

const expiredSig = signingStatus.describeSignature(
  { status: 'Valid', notAfter: '2026-11-11T00:00:00.0000000+08:00' },
  { now: BASE_NOW },
);
check(
  '证书已过期 → 判为不可信并说明过期几天',
  expiredSig.ok === false && expiredSig.level === 'expired' && /过期 3 天/.test(expiredSig.message),
  `level=${expiredSig.level}｜${expiredSig.message.slice(0, 24)}`,
);

const unsignedSig = signingStatus.describeSignature({ status: 'NotSigned' });
const suspicious = signingStatus.describeSignature({ status: 'HashMismatch' });
check(
  '「没签名」和「签名不可信」分开说，后者要提示重新下载',
  unsignedSig.level === 'unsigned' && unsignedSig.suspicious === false && suspicious.level === 'unknown'
    && suspicious.suspicious === true && /重新下载/.test(suspicious.message),
  `unsigned=${unsignedSig.level}｜suspicious=${suspicious.level}/${suspicious.suspicious}`,
);

const noDate = signingStatus.describeSignature({ status: 'Valid', notAfter: '' });
check(
  '读不到有效期时不许当作「还没过期」',
  noDate.ok === false && noDate.level === 'unknown' && /读不到/.test(noDate.message),
  `level=${noDate.level}`,
);

const parsedOk = signingStatus.parseSignaturePayload(
  '\uFEFF[{"Status":"Valid","Subject":"CN=x","Thumbprint":"T","NotAfter":"2031-11-14T00:00:00.0000000+08:00"}]',
);
const parsedBad = signingStatus.parseSignaturePayload('not json');
const parsedEmpty = signingStatus.parseSignaturePayload('');
check(
  'PowerShell 输出解析：能吃掉 BOM 与数组包装，坏输入给中文原因',
  parsedOk.ok === true && parsedOk.value.status === 'Valid' && parsedOk.value.thumbprint === 'T'
    && parsedBad.ok === false && /JSON/.test(parsedBad.error)
    && parsedEmpty.ok === false && /没读到/.test(parsedEmpty.error),
  `ok=${parsedOk.ok}｜bad=${parsedBad.ok}｜empty=${parsedEmpty.ok}`,
);

const facts = signingStatus.describeSignatureFacts(farValid);
check(
  '界面事实表五段齐全，缺项写「—」',
  Array.isArray(facts) && facts.length === 5 && facts[0].label === '签名状态'
    && /2031-11-1\d/.test(facts[4].value)
    && signingStatus.describeSignatureFacts({}).every((item) => item.value === '—'),
  `facts=${facts.length}`,
);

const mainSrc = read('src/main.js');
const preloadSrc = read('src/preload.js');
const htmlSrc = read('src/renderer/settings.html');
const settingsSrc = read('src/renderer/settings.js');
check(
  '接线：内核读自身 exe 的签名，界面只显示不重算',
  /ipcMain\.handle\('nyx:signing:status'/.test(mainSrc)
    && /function readSigningStatus\(/.test(mainSrc)
    && /process\.execPath/.test(mainSrc)
    && /SIGNING_STATUS_CACHE_MS = 10 \* 60 \* 1000/.test(mainSrc)
    && /Get-AuthenticodeSignature -LiteralPath \$env:NYX_SIGN_TARGET/.test(mainSrc)
    && /signingStatus: \(payload\) => ipcRenderer\.invoke\('nyx:signing:status'/.test(preloadSrc)
    && /async function loadSigningStatus\(force\)/.test(settingsSrc)
    && /id="signing-badge"/.test(htmlSrc) && /id="signing-grid"/.test(htmlSrc)
    && /id="signing-summary"/.test(htmlSrc) && /id="btn-signing-recheck"/.test(htmlSrc),
  'main/preload/settings 四处都在',
);

const failed = checks.filter((item) => !item.ok);
console.log('');
console.log(`代码签名：${checks.length} 项检查，${checks.length - failed.length} 项通过，${failed.length} 项失败`);
if (failed.length) {
  for (const item of failed) console.log(`  失败：${item.name}｜${item.detail || ''}`);
  process.exit(1);
}
console.log('[Nyx] 代码签名回归通过');
