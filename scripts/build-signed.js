'use strict';

/**
 * 打带自签名数字签名的安装包。
 *
 * 为什么要单独一个脚本：`npm run dist` 是未签名的（不依赖任何本机证书，任何机器都能跑）；
 * 签名需要私钥与密码，只能在本机用，所以走这条单独的路径，默认输出到 `dist-sign`
 * （不覆盖已发布的 `dist`）。
 *
 * 做法：把证书路径与密码放进 electron-builder 认识的 `CSC_LINK` / `CSC_KEY_PASSWORD`
 * 环境变量，然后调它自己的 CLI。密码**绝不写进命令行参数**（会进进程列表与 shell 历史），
 * 只通过环境变量传给子进程。
 *
 * 用法：
 *   npm run dist:signed                          → 输出到 dist-sign
 *   npm run dist:signed -- --config.directories.output=dist
 *   node scripts/build-signed.js --skip-verify   打完不验签（调试用）
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeCertValidity } = require('./lib/cert-validity');
const { readCredential } = require('./lib/win-credential');
const { decideSigningSecret } = require('./lib/signing-secret');

const ROOT = path.join(__dirname, '..');
const SIGN_DIR = path.join(ROOT, 'build', 'signing');
const PFX_PATH = path.join(SIGN_DIR, 'nyx-self-signed.pfx');
const CER_PATH = path.join(SIGN_DIR, 'nyx-self-signed.cer');
const PASSWORD_PATH = path.join(SIGN_DIR, 'password.txt');
const CLI_PATH = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const BUILD_DIR = path.join(ROOT, 'dist-sign');

function say(text) {
  console.log(`[Nyx] ${text}`);
}

function fail(text) {
  console.error(`[Nyx] ${text}`);
  process.exit(1);
}

function readPassword() {
  // 来源优先级写在 lib/signing-secret.js 里：凭据管理器 → 环境变量 → 明文文件。
  const credential = readCredential();
  if (!credential.ok) {
    say(`注意：读凭据管理器失败（${credential.error}），继续看后面的来源。`);
  }
  let fileValue = '';
  try {
    fileValue = fs.readFileSync(PASSWORD_PATH, 'utf8');
  } catch {
    fileValue = '';
  }
  const decided = decideSigningSecret({
    credential: credential.ok && credential.found ? credential.secret : '',
    envValue: process.env.NYX_SIGN_PASSWORD || '',
    fileValue,
  });
  if (!decided.ok) fail(decided.error);
  if (decided.warning) say(`注意：${decided.warning}`);
  say(`私钥密码来自「${decided.sourceLabel}」。`);
  return decided.secret;
}

/**
 * 读证书到期时间（ISO）。用 .cer 而不是 .pfx：公钥证书不需要密码，
 * 少一次把密码递进 PowerShell。
 */
function readCertNotAfter() {
  if (!fs.existsSync(CER_PATH)) {
    fail(
      '找不到自签名证书的公开部分 build/signing/nyx-self-signed.cer，读不到到期时间。\n' +
        '  读不到就不算有效：重新生成一张 node scripts/make-signing-cert.js --force',
    );
  }
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Throw'; (Get-PfxCertificate -FilePath $env:NYX_SIGN_CER).NotAfter.ToString('o')",
    ],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { NYX_SIGN_CER: CER_PATH }) },
  );
  if (result.status !== 0) {
    fail(
      '读证书到期时间失败：' +
        String(result.stderr || result.stdout || '').trim() +
        '\n  读不到就不算有效，不允许当成"应该还没过期"继续打包。',
    );
  }
  return String(result.stdout || '').trim();
}

/**
 * 打包前必过：过期或读不到有效期一律不签。
 * 这条检查比「打完再验签」更早——过期证书打出来的包，验签那一步只会报
 * 「签名无效」，让人以为是自己操作错了，其实是证书本身早就不算数了。
 */
function assertCertUsable() {
  const validity = describeCertValidity(readCertNotAfter());
  if (!validity.ok) fail(validity.message);
  if (validity.level === 'warn') {
    say(`注意：${validity.message}`);
  } else {
    say(validity.message);
  }
  return validity;
}

function main() {
  const passthrough = process.argv.slice(2);
  const skipVerify = passthrough.includes('--skip-verify');
  const extra = passthrough.filter((arg) => arg !== '--skip-verify');

  if (!fs.existsSync(PFX_PATH)) {
    fail(
      '还没有自签名证书（build/signing/nyx-self-signed.pfx）。\n' +
        '  先生成：node scripts/make-signing-cert.js\n' +
        '  想给本机建立信任：node scripts/make-signing-cert.js --trust',
    );
  }
  if (!fs.existsSync(CLI_PATH)) {
    fail('找不到 electron-builder（node_modules/electron-builder）。先 `npm install`。');
  }

  const password = readPassword();
  assertCertUsable();
  const hasOutputArg = extra.some((arg) => arg.startsWith('--config.directories.output'));
  const args = [CLI_PATH, '--win', 'nsis'].concat(
    hasOutputArg ? [] : ['--config.directories.output=dist-sign'],
    extra,
  );

  say('用自签名证书打包（私钥只在本机，密码走环境变量传给子进程，不进命令行）…');
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      CSC_LINK: PFX_PATH,
      CSC_KEY_PASSWORD: password,
    }),
  });

  if (result.error) fail(`没能启动 electron-builder：${result.error.message}`);
  if (result.status !== 0) fail(`打包失败（退出码 ${result.status}）。上面是 electron-builder 的输出。`);

  const outDir = hasOutputArg ? null : BUILD_DIR;
  say(`打包完成${outDir ? `：${path.relative(ROOT, outDir)}` : '（输出目录由参数指定）'}。`);

  if (skipVerify) return;
  const verifyScript = path.join(__dirname, 'verify-signing.js');
  const verifyArgs = [verifyScript];
  if (outDir) verifyArgs.push(`--dir=${outDir}`);
  const verify = spawnSync(process.execPath, verifyArgs, { cwd: ROOT, stdio: 'inherit' });
  if (verify.status !== 0) {
    fail('打包成功但签名验证没通过，这个包不能拿去发布。');
  }
}

main();
