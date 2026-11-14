'use strict';

/**
 * 生成「自己给自己签」的代码签名证书（Windows / PowerShell）。
 *
 * 为什么要有这一步：Nyx 的安装包目前是未签名的，Windows 会显示「未知发布者」，
 * SmartScreen 也会拦一道。买公信证书需要实名与费用，所以这里提供自签名方案：
 *   - 证书只留在本机 `build/signing/`（已在 .gitignore 里），**不进仓库、不进安装包**；
 *   - 私钥密码优先存进 **Windows 凭据管理器**（加密存储，密钥由当前用户派生）；
 *     只有凭据管理器写不进去时才退回到同目录的 `password.txt`，并且会大声说明；
 *   - 信任与否由用户决定：`--trust` 才会写进当前用户的「受信任的根证书颁发机构」
 *     与「受信任的发布者」，不写系统级存储（不需要管理员）。
 *
 * 必须说清的边界（文档与界面里都不能含糊）：
 *   自签名只能证明「这个包和上次是同一把私钥签的」，不能证明「Nyx 的官方发布者是谁」；
 *   别人的机器上默认仍会提示未知发布者，必须手动信任同一张证书后才不提示。
 *
 * 用法：
 *   node scripts/make-signing-cert.js            生成证书（已存在就只报告，不覆盖）
 *   node scripts/make-signing-cert.js --force    删掉重生成（旧签名就此失效）
 *   node scripts/make-signing-cert.js --trust    生成后写进当前用户的信任存储
 *   node scripts/make-signing-cert.js --status   只看现有证书状态
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeCertValidity } = require('./lib/cert-validity');
const { CRED_TARGET, deleteCredential, readCredential, writeCredential } = require('./lib/win-credential');
const { decideSigningSecret } = require('./lib/signing-secret');

const ROOT = path.join(__dirname, '..');
const SIGN_DIR = path.join(ROOT, 'build', 'signing');
const PFX_PATH = path.join(SIGN_DIR, 'nyx-self-signed.pfx');
const CER_PATH = path.join(SIGN_DIR, 'nyx-self-signed.cer');
const PASSWORD_PATH = path.join(SIGN_DIR, 'password.txt');
const SUBJECT = 'CN=Nyx Self-Signed, O=Nyx contributors, OU=local build';

const flags = {
  force: process.argv.includes('--force'),
  trust: process.argv.includes('--trust'),
  status: process.argv.includes('--status'),
};

function say(text) {
  console.log(`[Nyx] ${text}`);
}

function fail(text) {
  console.error(`[Nyx] ${text}`);
  process.exit(1);
}

function runPowerShell(script, extraEnv) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, extraEnv || {}),
    },
  );
  if (result.error) {
    fail(`没能启动 PowerShell：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`PowerShell 执行失败（退出码 ${result.status}）：${detail || '没有输出'}`);
  }
  return String(result.stdout || '').trim();
}

/**
 * 密码现在优先来自 Windows 凭据管理器；明文文件只作为老机器的退路。
 * 这里不去"猜"——三种来源都空就返回空串，由调用处决定怎么报错。
 */
function resolvePassword() {
  const credential = readCredential();
  const decided = decideSigningSecret({
    credential: credential.ok && credential.found ? credential.secret : '',
    envValue: process.env.NYX_SIGN_PASSWORD || '',
    fileValue: readFilePassword(),
  });
  return decided;
}

function readFilePassword() {
  try {
    return fs.readFileSync(PASSWORD_PATH, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

function describePasswordSource() {
  const credential = readCredential();
  if (credential.ok && credential.found) {
    return `Windows 凭据管理器（${CRED_TARGET}）`;
  }
  if (!credential.ok) {
    return `读凭据管理器失败（${credential.error}），退回到 build/signing/password.txt`;
  }
  if (readFilePassword()) return '明文文件 build/signing/password.txt（建议存进凭据管理器）';
  return '还没有密码（先运行本脚本生成证书）';
}

function describeExisting() {
  const parts = [];
  parts.push(`  证书文件：${path.relative(ROOT, CER_PATH)}`);
  parts.push(`  私钥文件：${path.relative(ROOT, PFX_PATH)}`);
  parts.push(`  密码存放：${describePasswordSource()}`);
  let notAfter = '';
  // 注意：Windows PowerShell 5.1 的 Get-PfxCertificate **没有 -Password 参数**，
  // 早先那版就这么写了，结果 --status 一直打印 Thumbprint= 与 Subject= 空值且不报错。
  // 这里改用 .NET 的 X509Certificate2 构造函数读带密码的 pfx，读不到会抛错。
  const thumb = runPowerShell(
    "$ErrorActionPreference = 'Stop'\n" +
      '$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:NYX_SIGN_PFX, $env:NYX_SIGN_PASSWORD)\n' +
      'Write-Output ("Thumbprint=" + $c.Thumbprint); Write-Output ("NotAfter=" + $c.NotAfter.ToString("yyyy-MM-dd")); ' +
      'Write-Output ("NotAfterIso=" + $c.NotAfter.ToString("o")); ' +
      'Write-Output ("Subject=" + $c.Subject)',
    { NYX_SIGN_PFX: PFX_PATH, NYX_SIGN_PASSWORD: resolvePassword().secret },
  );
  for (const line of thumb.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('NotAfterIso=')) {
      notAfter = line.trim().slice('NotAfterIso='.length);
      continue;
    }
    parts.push(`  ${line.trim()}`);
  }
  // 到期这件事只在打包前查还不够——`--status` 是人主动来看证书的地方，
  // 过期与将到期必须在这里就说得明明白白。
  const validity = describeCertValidity(notAfter);
  parts.push(`  有效期：${validity.message}`);
  return parts.join('\n');
}

function trustCert() {
  say('把证书写进「当前用户」的信任存储（不需要管理员）…');
  const stores = ['Root', 'TrustedPublisher'];
  for (const store of stores) {
    const result = spawnSync('certutil.exe', ['-addstore', '-user', store, CER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      fail(
        `写进 ${store} 失败（退出码 ${result.status}）：` +
          `${String(result.stderr || result.stdout || '').trim() || '没有输出'}\n` +
          '  可以手动执行：certutil -addstore -user ' +
          `${store} "${CER_PATH}"`,
      );
    }
    say(`已写进 ${store}。`);
  }
  say('自签名证书已信任：本机双击安装包不会再提示「未知发布者」，但别的机器不会自动信任。');
}

function generate() {
  fs.mkdirSync(SIGN_DIR, { recursive: true });
  const password = crypto.randomBytes(24).toString('base64url');
  // 密码先进凭据管理器；写不进去才退回到明文文件，并且必须说出来——
  // 「静默退回到明文」正是这一项要消灭的东西。
  const stored = writeCredential(password);
  let passwordFileWritten = false;
  if (!stored.ok) {
    fs.writeFileSync(PASSWORD_PATH, `${password}\n`, 'utf8');
    passwordFileWritten = true;
    say(`凭据管理器写入失败（${stored.error}），已退回到明文文件 build/signing/password.txt。`);
    say('  这不是理想状态：这个文件一旦被复制走，私钥就等于泄露。方便时请重试存进凭据管理器。');
  }

  say('正在生成自签名代码签名证书（RSA 3072 / SHA-256 / 5 年）…');
  const script =
    "$ErrorActionPreference = 'Stop'\n" +
    '$password = ConvertTo-SecureString -String $env:NYX_SIGN_PASSWORD -Force -AsPlainText\n' +
    '$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $env:NYX_SIGN_SUBJECT ' +
    '-KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm sha256 -KeyExportPolicy Exportable ' +
    '-KeyUsage DigitalSignature -CertStoreLocation Cert:\\CurrentUser\\My ' +
    '-NotAfter (Get-Date).AddYears(5)\n' +
    'Export-PfxCertificate -Cert $cert -FilePath $env:NYX_SIGN_PFX -Password $password | Out-Null\n' +
    'Export-Certificate -Cert $cert -FilePath $env:NYX_SIGN_CER -Type CERT | Out-Null\n' +
    'Write-Output $cert.Thumbprint\n';
  const stdout = runPowerShell(script, {
    NYX_SIGN_PASSWORD: password,
    NYX_SIGN_SUBJECT: SUBJECT,
    NYX_SIGN_PFX: PFX_PATH,
    NYX_SIGN_CER: CER_PATH,
  });
  const thumbprint = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';

  if (!fs.existsSync(PFX_PATH) || !fs.existsSync(CER_PATH)) {
    fail('证书文件没有落盘，生成失败。');
  }
  say(`证书已生成：${path.relative(ROOT, CER_PATH)}（指纹 ${thumbprint || '未知'}）`);
  say(
    passwordFileWritten
      ? '私钥密码退回到了 build/signing/password.txt（明文），建议尽快存进凭据管理器。'
      : `私钥密码已存进 Windows 凭据管理器（${CRED_TARGET}），不在任何明文文件里。`,
  );
  return thumbprint;
}

function main() {
  if (flags.status) {
    if (!fs.existsSync(PFX_PATH)) {
      say('还没有自签名证书。运行 `node scripts/make-signing-cert.js` 生成。');
      return;
    }
    say('现有自签名证书：');
    console.log(describeExisting());
    return;
  }

  if (fs.existsSync(PFX_PATH) && !flags.force) {
    say('自签名证书已存在，不覆盖（要重生成请加 --force，旧签名会随之失效）。');
    console.log(describeExisting());
    if (flags.trust) trustCert();
    return;
  }

  if (fs.existsSync(PFX_PATH) && flags.force) {
    for (const file of [PFX_PATH, CER_PATH, PASSWORD_PATH]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        fail(`删不掉旧文件 ${file}：${error.message}`);
      }
    }
    say('已删除旧证书文件。');
    // 旧密码留在凭据管理器里只会误导下一个读它的人：证书都换了，那把锁已经没用了。
    const removed = deleteCredential();
    if (removed.ok && removed.removed) {
      say(`已清掉凭据管理器里的旧密码（${CRED_TARGET}）。`);
    } else if (!removed.ok) {
      say(`没能清掉凭据管理器里的旧密码（${removed.error}），生成新证书后会用新的覆盖它。`);
    }
  }

  generate();
  if (flags.trust) trustCert();

  say('下一步：');
  say(`  1. 信任证书（只影响本机）：node scripts/make-signing-cert.js --trust`);
  say(`  2. 打带签名的包：npm run dist:signed（默认输出到 dist-sign）`);
  say(`  3. 验证签名：node scripts/verify-signing.js --artifact=<安装包路径>`);
}

main();
