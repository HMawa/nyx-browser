'use strict';

/**
 * 管理自签名证书私钥密码的存放位置（Windows 凭据管理器）。
 *
 * 用法：
 *   node scripts/signing-secret.js --status                 看密码现在存在哪儿（不打印密码）
 *   node scripts/signing-secret.js --store                  把环境变量/明文文件里的密码存进凭据管理器
 *   node scripts/signing-secret.js --store --purge-file     存成功后删掉 build/signing/password.txt
 *   node scripts/signing-secret.js --clear                  从凭据管理器删掉
 *
 * 为什么不做 `--show`：能读密码的脚本越少越好。要看密码存在哪儿，`--status` 够了；
 * 真要读出来打包脚本自己会读，人不需要看见它。
 */

const fs = require('node:fs');
const path = require('node:path');
const { CRED_TARGET, deleteCredential, readCredential, writeCredential } = require('./lib/win-credential');
const { describeSigningSecret, decideSigningSecret } = require('./lib/signing-secret');

const ROOT = path.join(__dirname, '..');
const SIGN_DIR = path.join(ROOT, 'build', 'signing');
const PASSWORD_PATH = path.join(SIGN_DIR, 'password.txt');

const flags = {
  status: process.argv.includes('--status'),
  store: process.argv.includes('--store'),
  purgeFile: process.argv.includes('--purge-file'),
  clear: process.argv.includes('--clear'),
};

function say(text) {
  console.log(`[Nyx] ${text}`);
}

function fail(text) {
  console.error(`[Nyx] ${text}`);
  process.exit(1);
}

function readFileValue() {
  try {
    return fs.readFileSync(PASSWORD_PATH, 'utf8');
  } catch {
    return '';
  }
}

function currentState() {
  const credential = readCredential();
  if (!credential.ok) {
    fail(`读凭据管理器失败：${credential.error}\n  打包前必须能确认密码来源，这里不许"猜"。`);
  }
  const fileValue = readFileValue();
  return {
    credential: credential.found ? credential.secret : '',
    credentialTarget: CRED_TARGET,
    envValue: process.env.NYX_SIGN_PASSWORD || '',
    fileValue,
    fileExists: fs.existsSync(PASSWORD_PATH),
  };
}

function printStatus() {
  const state = currentState();
  say('签名密码来源：');
  console.log(describeSigningSecret(state));
  const decided = decideSigningSecret(state);
  if (decided.ok) {
    say(`打包会用「${decided.sourceLabel}」。`);
  } else {
    say('现在打不了签名包——上面写了怎么补。');
  }
}

function store() {
  const state = currentState();
  const decided = decideSigningSecret(state);
  if (!decided.ok) {
    fail(decided.error);
  }
  if (decided.source === 'credential') {
    say('凭据管理器里已经有密码了，不覆盖（要换密码用 --clear 再 --store）。');
    if (flags.purgeFile && state.fileExists) purgeFile();
    return;
  }
  const written = writeCredential(decided.secret);
  if (!written.ok) fail(`存进凭据管理器失败：${written.error}`);
  say(`已把密码存进 Windows 凭据管理器（${CRED_TARGET}）。`);
  say(`原来那份来自「${decided.sourceLabel}」。`);
  if (flags.purgeFile) {
    purgeFile();
  } else if (state.fileExists) {
    say('明文文件还在：node scripts/signing-secret.js --store --purge-file 可以把它删掉。');
  }
}

function purgeFile() {
  try {
    fs.rmSync(PASSWORD_PATH, { force: true });
  } catch (error) {
    fail(`删除 build/signing/password.txt 失败：${error.message}`);
  }
  say('已删除 build/signing/password.txt（密码现在只在凭据管理器里）。');
}

function clear() {
  const removed = deleteCredential();
  if (!removed.ok) fail(`删除凭据失败：${removed.error}`);
  if (removed.removed) {
    say(`已从凭据管理器删掉 ${CRED_TARGET}。`);
  } else {
    say('凭据管理器里本来就没有这条凭据，什么都没动。');
  }
}

function main() {
  if (!flags.status && !flags.store && !flags.clear) {
    say('用法：');
    say('  --status              看密码现在存在哪儿（不打印密码）');
    say('  --store               把环境变量/明文文件里的密码存进凭据管理器');
    say('  --store --purge-file  存成功后删掉 build/signing/password.txt');
    say('  --clear               从凭据管理器删掉');
    process.exitCode = 2;
    return;
  }
  if (flags.status) printStatus();
  if (flags.store) store();
  if (flags.clear) clear();
}

main();
