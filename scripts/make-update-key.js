/**
 * 生成更新清单签名密钥（Ed25519）。
 *
 * 为什么需要它（安全审计 P0-2）：
 *   更新器以前只信任清单里的 sha256，而清单本身放在更新源目录里——
 *   谁能改那个目录，谁就能同时改安装包和 sha256，等于没有任何保护。
 *   现在清单要带一把私钥的签名，客户端只用硬编码的公钥验签：
 *   换包 = 换 sha256 = 签名对不上 = 拒绝安装。
 *
 * 用法：
 *   node scripts/make-update-key.js                 # 默认写到 %APPDATA%\Nyx\update-signing-key.pem
 *   node scripts/make-update-key.js --out=D:\k.pem  # 指定路径
 *   node scripts/make-update-key.js --force         # 覆盖已有私钥（**会让已发布的客户端验签失败**）
 *
 * 私钥**绝不入库**：`.gitignore` 已排除 `*.pem`；这里也只写到你指定的位置。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argOf(name) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function defaultKeyPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Nyx', 'update-signing-key.pem');
}

/** 密钥标识：公钥的 sha256 前 16 位十六进制，用来在清单里标明"是哪把钥匙" */
function keyIdOf(publicKeyB64) {
  return crypto.createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);
}

function main() {
  const outPath = argOf('out') || defaultKeyPath();

  if (fs.existsSync(outPath) && !hasFlag('force')) {
    console.error(`[更新签名] 私钥已存在：${outPath}`);
    console.error('[更新签名] 换成新私钥会让所有已发布的客户端验签失败。确实要换就加 --force。');
    process.exitCode = 1;
    return;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const keyId = keyIdOf(publicKeyB64);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, privatePem, { encoding: 'utf8', mode: 0o600 });

  console.log(`[更新签名] 私钥已写入：${outPath}`);
  console.log('[更新签名] 下面两个值要写进 src/core/update-signature.js（公钥可以公开，私钥不行）：');
  console.log('');
  console.log(`  UPDATE_PUBLIC_KEY_SPKI_B64 = '${publicKeyB64}';`);
  console.log(`  UPDATE_KEY_ID = '${keyId}';`);
  console.log('');
  console.log('[更新签名] 自检：');
  const probe = Buffer.from('nyx-self-check');
  const sig = crypto.sign(null, probe, privateKey).toString('base64');
  const ok = crypto.verify(null, probe, publicKey, Buffer.from(sig, 'base64'));
  console.log(`  签名/验签一轮：${ok ? '通过' : '失败'}`);
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { keyIdOf, defaultKeyPath };
