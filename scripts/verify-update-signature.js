/**
 * 更新通道签名回归（安全审计 P0-2 第二阶段）—— 纯 Node，不启动 Electron。
 *
 * 覆盖三层：
 *   1. 清单签名：同一份清单签出来验得过，改任何一个受保护字段都验不过；
 *   2. 安装包验签：六种 Authenticode 结果各自的判定（含"读不到就当没签名"）；
 *   3. 接线与私钥纪律：清单验签在版本比较之前、安装前核签名、私钥不入库。
 *
 * 这里用**临时生成的测试钥匙**验往返（不依赖本机私钥），
 * 只对"内置公钥本身可用"做一次自检。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sig = require('../src/core/update-signature');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? `：${detail}` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 测试钥匙：只活在内存里，跟真实发布私钥无关 */
const testPair = crypto.generateKeyPairSync('ed25519');
const testPrivatePem = testPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const testPublicB64 = testPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const testKeyId = crypto.createHash('sha256').update(testPublicB64).digest('hex').slice(0, 16);
const opts = { publicKeyB64: testPublicB64, keyId: testKeyId };

function sampleManifest(patch) {
  return Object.assign(
    {
      version: '1.17.10',
      notes: '这一版修安全审计的 P0。',
      file: 'Nyx-Setup-1.17.10.exe',
      sha256: 'a'.repeat(64),
      size: 127250504,
      mandatory: false,
      blocks: 'Nyx-Setup-1.17.10.blocks.json',
    },
    patch || {},
  );
}

function signedSample(patch) {
  const base = sampleManifest(patch);
  const signature = sig.signManifest(base, testPrivatePem);
  return Object.assign({}, base, { signature, keyId: testKeyId });
}

/* ① 规范文本：同输入同输出，且与字段顺序无关 */
const a = sig.canonicalManifest(sampleManifest());
const b = sig.canonicalManifest({ size: 127250504, blocks: 'Nyx-Setup-1.17.10.blocks.json', sha256: 'A'.repeat(64), file: 'Nyx-Setup-1.17.10.exe', notes: 'ignored', mandatory: false, version: '1.17.10' });
check('规范文本稳定：换字段顺序、大小写、无关字段（notes）都不影响', a === b, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
check('规范文本把 sha256 统一成小写、强制性统一成 0/1', a.includes('a'.repeat(64)) && a.split('\n')[5] === '0', JSON.stringify(a.split('\n')));

/* ② 正常清单验得过 */
const good = signedSample();
check('自己签的清单验签通过', sig.verifyManifestSignature(good, opts).ok === true, JSON.stringify(sig.verifyManifestSignature(good, opts)));

/* ③ 逐字段篡改都必须验不过，且原因说得清 */
const tamperCases = [
  ['version', { version: '1.17.11' }],
  ['file', { file: 'Nyx-Setup-1.17.10-evil.exe' }],
  ['sha256', { sha256: 'b'.repeat(64) }],
  ['size', { size: 1 }],
  ['mandatory', { mandatory: true }],
  ['blocks', { blocks: 'other.blocks.json' }],
];
let tamperAllRejected = true;
const tamperDetail = [];
for (const [label, patch] of tamperCases) {
  const broken = Object.assign({}, good, patch);
  const verdict = sig.verifyManifestSignature(broken, opts);
  if (verdict.ok || verdict.code !== 'SIGNATURE_BAD') {
    tamperAllRejected = false;
    tamperDetail.push(`${label}→${verdict.code}`);
  }
}
check('改版本/文件名/sha256/大小/强制性/差分清单，六项全部验签失败', tamperAllRejected, tamperDetail.join(','));

/* ④ 缺签名、钥匙不对 */
const missing = sig.verifyManifestSignature(sampleManifest(), opts);
check('清单没有签名 → SIGNATURE_MISSING，且中文原因说清"等于没人担保"', missing.code === 'SIGNATURE_MISSING' && /没有签名/.test(missing.error), JSON.stringify(missing));
const wrongKey = sig.verifyManifestSignature(Object.assign({}, good, { keyId: 'deadbeefdeadbeef' }), opts);
check('清单是另一把钥匙签的 → KEY_UNKNOWN，并报出两个 keyId', wrongKey.code === 'KEY_UNKNOWN' && /deadbeef/.test(wrongKey.error), JSON.stringify(wrongKey));
const noKeyId = sig.verifyManifestSignature(Object.assign({}, good, { keyId: undefined }), opts);
check('清单不写 keyId 时仍按内置公钥验签（兼容老清单，签名不对照样拒）', noKeyId.ok === true);

/* ⑤ 内置公钥可用、keyId 与实际公钥一致 */
let builtinKeyOk = true;
try {
  crypto.createPublicKey({ key: Buffer.from(sig.UPDATE_PUBLIC_KEY_SPKI_B64, 'base64'), format: 'der', type: 'spki' });
} catch {
  builtinKeyOk = false;
}
const derivedKeyId = crypto.createHash('sha256').update(sig.UPDATE_PUBLIC_KEY_SPKI_B64).digest('hex').slice(0, 16);
check('内置更新公钥能构造出 key，且 keyId 与公钥自洽', builtinKeyOk && derivedKeyId === sig.UPDATE_KEY_ID, `${derivedKeyId} vs ${sig.UPDATE_KEY_ID}`);

/* ⑥ 安装包验签：六种结果 */
const T = sig.UPDATE_SIGNER_THUMBPRINT;
const cases = [
  ['Valid + 我们的指纹 → 放行', { status: 'Valid', thumbprint: T }, true, 'OK'],
  ['没签名 → 拒绝', { status: 'NotSigned', thumbprint: '' }, false, 'NOT_SIGNED'],
  ['指纹不是我们的 → 拒绝', { status: 'Valid', thumbprint: 'F'.repeat(40) }, false, 'WRONG_SIGNER'],
  ['证书已过期 → 拒绝', { status: 'Valid', thumbprint: T, expired: true }, false, 'EXPIRED'],
  ['哈希不匹配（文件被改）→ 拒绝', { status: 'HashMismatch', thumbprint: T, statusMessage: '哈希不匹配' }, false, 'BAD_SIGNATURE'],
  ['链不受信任（自签名证书没装进受信任根）+ 指纹对 → 放行并说明', { status: 'UnknownError', thumbprint: T, statusMessage: 'A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider.' }, true, 'UNTRUSTED_CHAIN'],
];
let installerOk = true;
const installerDetail = [];
for (const [label, input, wantOk, wantCode] of cases) {
  const verdict = sig.decideInstallerSignature(input);
  if (verdict.ok !== wantOk || verdict.code !== wantCode) {
    installerOk = false;
    installerDetail.push(`${label} → ${verdict.code}`);
  }
}
check('安装包验签六种结果全部符合预期', installerOk, installerDetail.join('；'));
check('读不到签名状态 → 拒绝（读不到就当没签名）', sig.decideInstallerSignature({}) .code === 'NO_RESULT');

/* ⑦ 接线守卫 */
const updater = read('src/core/updater.js');
check(
  '清单验签在版本比较之前，且验不过直接抛错',
  /const signature = verifyManifestSignature\(manifest\);[\s\S]{0,200}if \(!signature\.ok\)[\s\S]{0,200}throw new Error\(signature\.error\);[\s\S]{0,600}const cmp = compareVersion\(/.test(updater),
);
check(
  '安装前核签名：readAuthenticode + decideInstallerSignature + 拒绝即返回',
  /const signed = readAuthenticode\(this\.readyFile\);/.test(updater) &&
    /const verdict = decideInstallerSignature\(\{/.test(updater) &&
    /if \(!verdict\.ok\) \{[\s\S]{0,200}return \{ ok: false, error: verdict\.error \};/.test(updater),
);
check('读签名用 PowerShell 且按 GBK 解码（否则中文状态说明会被解坏）', /Get-AuthenticodeSignature/.test(updater) && /new TextDecoder\('gbk'\)/.test(updater));
const release = read('scripts/make-release.js');
check(
  '发版脚本先签名再写 latest.json，找不到私钥就中止',
  /const signed = signManifestObject\(manifest\);/.test(release) &&
    /fail\([\s\S]{0,200}找不到更新签名私钥/.test(release) &&
    release.indexOf('signManifestObject(manifest)') < release.indexOf('fs.writeFileSync(path.join(DIST_DIR, MANIFEST_NAME)'),
);
check('清单格式注释已声明 signature / keyId 必填', /"signature": "…",\s*\/\/ 必须提供（Ed25519/.test(updater) && /"keyId":/.test(updater));

/* ⑧ 私钥纪律 */
const gitignore = read('.gitignore');
check('私钥不入库：.gitignore 排除 *.pem', /^\*\.pem$/m.test(gitignore), JSON.stringify(gitignore.split('\n').filter((l) => /pem/.test(l))));
const strayPem = [];
(function walk(dir, depth) {
  if (depth > 2) return;
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.name === 'node_modules' || item.name === '.git' || item.name === 'dist' || item.name === 'temp') continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, depth + 1);
    else if (/\.pem$/i.test(item.name)) strayPem.push(path.relative(ROOT, full));
  }
})(ROOT, 0);
check('仓库里没有散落的 .pem 私钥文件', strayPem.length === 0, strayPem.join(', '));

console.log('');
console.log(`更新签名回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 更新签名回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 更新签名回归通过');
}
