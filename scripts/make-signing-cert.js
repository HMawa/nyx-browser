'use strict';

/**
 * 生成「自己给自己签」的代码签名证书（Windows / PowerShell）。
 *
 * 为什么要有这一步：Nyx 的安装包目前是未签名的，Windows 会显示「未知发布者」，
 * SmartScreen 也会拦一道。买公信证书需要实名与费用，所以这里提供自签名方案：
 *   - 证书只留在本机 `build/signing/`（已在 .gitignore 里），**不进仓库、不进安装包**；
 *   - 私钥密码写同目录的 `password.txt`，只给本机打包脚本读；
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

function readPassword() {
  try {
    return fs.readFileSync(PASSWORD_PATH, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

function describeExisting() {
  const parts = [];
  parts.push(`  证书文件：${path.relative(ROOT, CER_PATH)}`);
  parts.push(`  私钥文件：${path.relative(ROOT, PFX_PATH)}`);
  parts.push(`  密码文件：${path.relative(ROOT, PASSWORD_PATH)}`);
  const thumb = runPowerShell(
    `$c = Get-PfxCertificate -FilePath $env:NYX_SIGN_PFX -Password (ConvertTo-SecureString -String $env:NYX_SIGN_PASSWORD -Force -AsPlainText); ` +
      'Write-Output ("Thumbprint=" + $c.Thumbprint); Write-Output ("NotAfter=" + $c.NotAfter.ToString("yyyy-MM-dd")); ' +
      'Write-Output ("Subject=" + $c.Subject)',
    { NYX_SIGN_PFX: PFX_PATH, NYX_SIGN_PASSWORD: readPassword() },
  );
  for (const line of thumb.split(/\r?\n/)) {
    if (line.trim()) parts.push(`  ${line.trim()}`);
  }
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
  fs.writeFileSync(PASSWORD_PATH, `${password}\n`, 'utf8');

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
  say('私钥密码已写进 build/signing/password.txt，只在本机打包时使用。');
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
  }

  generate();
  if (flags.trust) trustCert();

  say('下一步：');
  say(`  1. 信任证书（只影响本机）：node scripts/make-signing-cert.js --trust`);
  say(`  2. 打带签名的包：npm run dist:signed（默认输出到 dist-sign）`);
  say(`  3. 验证签名：node scripts/verify-signing.js --artifact=<安装包路径>`);
}

main();
