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

const ROOT = path.join(__dirname, '..');
const SIGN_DIR = path.join(ROOT, 'build', 'signing');
const PFX_PATH = path.join(SIGN_DIR, 'nyx-self-signed.pfx');
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
  let raw = '';
  try {
    raw = fs.readFileSync(PASSWORD_PATH, 'utf8');
  } catch (error) {
    fail(
      '读不到自签名证书的密码文件 build/signing/password.txt。\n' +
        '  先运行 `node scripts/make-signing-cert.js` 生成证书；' +
        '如果只想打未签名的包，用 `npm run dist`。',
    );
  }
  const password = raw.replace(/^\uFEFF/, '').trim();
  if (!password) {
    fail('build/signing/password.txt 是空的，证书不可用。重新生成：node scripts/make-signing-cert.js --force');
  }
  return password;
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
