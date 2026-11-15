/**
 * 更新通道的密码学校验（安全审计 P0-2 第二阶段）。
 *
 * 第一阶段只做到「清单必须给 sha256、源只许 https、本地源要确认」——
 * 那能挡住"路上换包"，挡不住"更新源那个目录被换掉后重新写一份清单"：
 * 攻击者改 exe、改 sha256、重新写 latest.json，客户端照样全绿。
 *
 * 这一层补上清单签名：`latest.json` 里多两个字段 `signature` / `keyId`，
 * 签名覆盖「版本 / 文件名 / sha256 / 大小 / 是否强制 / 差分清单摘要」，
 * 客户端只用**硬编码在源码里的公钥**验签。换任何一项 = 签名对不上 = 拒绝。
 * 私钥在 `%APPDATA%\Nyx\update-signing-key.pem`（`scripts/make-update-key.js` 生成），
 * 绝不入库。
 *
 * 另外，安装前再核一次安装包本身：它的 Authenticode 签名必须来自
 * **固定指纹那张证书**（我们自己的自签名证书，指纹硬编码在下面）。
 * 这一步是"文件是不是我们签的那个文件"，与清单签名互补：
 *   清单签名 → 清单没被改；exe 验签 → exe 没被换。
 *
 * 本模块是纯逻辑：不发请求、不读盘、不依赖 Electron。
 */

'use strict';

const crypto = require('node:crypto');

/** 生成于 2026-11-15（`node scripts/make-update-key.js`）。公钥可以公开，私钥不在仓库里。 */
const UPDATE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAAi6T/35vWRUe5zR99NgrYRAwn+1EfmItdtCiXqtx9lo=';
const UPDATE_KEY_ID = 'dc2cec223e6ea7c7';

/** 我们的自签名代码签名证书指纹（与 scripts/verify-signing.js 里的一致） */
const UPDATE_SIGNER_THUMBPRINT = '256F208A5D31782DAF9DA041CF1D7A2A382931D0';

const SIGNATURE_ALGORITHM = 'ed25519';
const CANONICAL_PREFIX = 'nyx-update-v1';

/** 清单摘要：差分清单是整体替换的，签名要覆盖到它，否则可以只换差分 */
function blocksDigest(blocks) {
  const text = blocks == null ? '' : JSON.stringify(blocks);
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 把清单里"要保护的那几项"拼成一段确定的文本。
 * 顺序与分隔符写死，任何一项变了签名就变；不含 notes 之类的展示文案
 * （它们是给人看的，不参与完整性判断）。
 */
function canonicalManifest(input) {
  const source = input || {};
  return [
    CANONICAL_PREFIX,
    String(source.version || ''),
    String(source.file || ''),
    String(source.sha256 || '').toLowerCase(),
    String(source.size || ''),
    source.mandatory === true ? '1' : '0',
    blocksDigest(source.blocks || null),
  ].join('\n');
}

function normalizeSignature(raw) {
  return String(raw == null ? '' : raw).trim();
}

/**
 * 验签。
 * 返回 { ok, code, error }：
 *   ok           签名有效
 *   SIGNATURE_MISSING  清单没带签名（老清单 / 被删掉）
 *   KEY_UNKNOWN        keyId 不是我们这把钥匙
 *   SIGNATURE_BAD      签名对不上（内容被改过）
 *   BAD_KEY            内置公钥本身不可用（构建出错）
 */
function verifyManifestSignature(manifest, options) {
  const opts = options || {};
  const publicKeyB64 = opts.publicKeyB64 || UPDATE_PUBLIC_KEY_SPKI_B64;
  const expectedKeyId = opts.keyId || UPDATE_KEY_ID;

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, code: 'BAD_KEY', error: '内置的更新公钥不可用，无法校验更新清单（请重新构建）' };
  }

  const signature = normalizeSignature(manifest && manifest.signature);
  if (!signature) {
    return {
      ok: false,
      code: 'SIGNATURE_MISSING',
      error: '更新清单没有签名，已拒绝——没有签名的清单等于没人担保升级包',
    };
  }

  const manifestKeyId = String((manifest && manifest.keyId) || '').trim();
  if (manifestKeyId && manifestKeyId !== expectedKeyId) {
    return {
      ok: false,
      code: 'KEY_UNKNOWN',
      error: `更新清单是用另一把钥匙签的（${manifestKeyId}），这个版本只认 ${expectedKeyId}，已拒绝`,
    };
  }

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(canonicalManifest(manifest), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    verified = false;
  }

  if (!verified) {
    return {
      ok: false,
      code: 'SIGNATURE_BAD',
      error: '更新清单的签名对不上（版本、文件名、sha256、大小、强制性或差分清单被改过），已拒绝',
    };
  }
  return { ok: true, code: 'OK', error: '' };
}

/** 给发版脚本用：用私钥签一份清单的规范文本 */
function signManifest(manifest, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), privateKey).toString('base64');
}

/**
 * 安装前核对安装包的 Authenticode 签名。
 *
 * 输入是 `Get-AuthenticodeSignature` 的三个结果：`status`（'Valid' / 'NotSigned' /
 * 'HashMismatch' / 'UnknownError' …）、`thumbprint`、`statusMessage`。
 *
 * 规则：
 *   1. 指纹必须是我们那张证书——这是身份，比"链可信"更强（我们是自签名）。
 *   2. 状态是 Valid → 过。
 *   3. 状态不是 Valid、但状态说明是"根证书不受信任"这类**链信任**问题 → 仍过
 *      （没把我们的自签名证书装进受信任根的机器上就是这个状态，指纹已经确认过）。
 *   4. 其它一律拒：没签名、哈希不匹配（文件被改）、证书已过期。
 */
function decideInstallerSignature(input) {
  const status = String((input && input.status) || '').trim();
  const thumbprint = String((input && input.thumbprint) || '').replace(/\s+/g, '').toUpperCase();
  const statusMessage = String((input && input.statusMessage) || '');
  const expired = input && input.expired === true;
  const expected = String((input && input.expectedThumbprint) || UPDATE_SIGNER_THUMBPRINT)
    .replace(/\s+/g, '')
    .toUpperCase();

  if (!status) {
    return { ok: false, code: 'NO_RESULT', error: '读不到安装包的签名状态，已拒绝安装（读不到就当没签名）' };
  }
  if (status === 'NotSigned') {
    return { ok: false, code: 'NOT_SIGNED', error: '安装包没有代码签名，已拒绝安装' };
  }
  if (thumbprint !== expected) {
    return {
      ok: false,
      code: 'WRONG_SIGNER',
      error: `安装包的签名证书不是 Nyx 的（${thumbprint.slice(0, 16) || '未知'}…，应为 ${expected.slice(0, 16)}…），已拒绝安装`,
    };
  }
  if (expired) {
    return { ok: false, code: 'EXPIRED', error: '安装包的签名证书已过期，已拒绝安装' };
  }
  if (status === 'Valid') {
    return { ok: true, code: 'OK', error: '' };
  }
  // 链不受信任（自签名证书没装进受信任根）：指纹已核对过，允许安装，但要说清原因
  const trustOnly = /not trusted|untrusted|certificate chain|terminated in a root/i.test(statusMessage);
  if (trustOnly) {
    return { ok: true, code: 'UNTRUSTED_CHAIN', error: '' };
  }
  return {
    ok: false,
    code: 'BAD_SIGNATURE',
    error: `安装包的签名校验没通过（${status}${statusMessage ? '：' + statusMessage : ''}），可能是文件被改过，已拒绝安装`,
  };
}

module.exports = {
  CANONICAL_PREFIX,
  SIGNATURE_ALGORITHM,
  UPDATE_KEY_ID,
  UPDATE_PUBLIC_KEY_SPKI_B64,
  UPDATE_SIGNER_THUMBPRINT,
  blocksDigest,
  canonicalManifest,
  decideInstallerSignature,
  signManifest,
  verifyManifestSignature,
};
