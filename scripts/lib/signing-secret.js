'use strict';

/**
 * 决定「签名密码从哪儿来」——纯逻辑，不碰磁盘也不碰 PowerShell。
 *
 * 优先级（顺序即安全性，改动前先想清楚为什么）：
 *   1. `credential`：Windows 凭据管理器（加密存储，密钥由当前用户账户派生）
 *   2. `env`：环境变量 `NYX_SIGN_PASSWORD`（CI 或临时用；进程环境表里能看见）
 *   3. `file`：`build/signing/password.txt`（明文，历史遗留，能不用就别用）
 *   4. `none`：都没有
 *
 * 为什么把"文件"留到最后而不是直接删掉：老机器上很可能只有那个文件，
 * 直接删等于让打包脚本突然打不出签名包。所以保留读取，但**每次都要喊一声**。
 */

const SOURCE_CREDENTIAL = 'credential';
const SOURCE_ENV = 'env';
const SOURCE_FILE = 'file';
const SOURCE_NONE = 'none';

const SOURCE_LABELS = {
  credential: 'Windows 凭据管理器',
  env: '环境变量 NYX_SIGN_PASSWORD',
  file: '明文文件 build/signing/password.txt',
  none: '没有找到',
};

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/^\uFEFF/, '').trim();
}

/**
 * @param {{credential?: string, envValue?: string, fileValue?: string}} input
 * @returns {{ok: boolean, source: string, sourceLabel: string, secret: string, warning: string, error: string}}
 */
function decideSigningSecret(input) {
  const options = input || {};
  const credential = clean(options.credential);
  const envValue = clean(options.envValue);
  const fileValue = clean(options.fileValue);

  if (credential) {
    return {
      ok: true,
      source: SOURCE_CREDENTIAL,
      sourceLabel: SOURCE_LABELS[SOURCE_CREDENTIAL],
      secret: credential,
      warning: '',
      error: '',
    };
  }
  if (envValue) {
    return {
      ok: true,
      source: SOURCE_ENV,
      sourceLabel: SOURCE_LABELS[SOURCE_ENV],
      secret: envValue,
      warning: '密码来自环境变量，这能被打包用，但同机其它进程也能看见。建议 node scripts/signing-secret.js --store 存进凭据管理器。',
      error: '',
    };
  }
  if (fileValue) {
    return {
      ok: true,
      source: SOURCE_FILE,
      sourceLabel: SOURCE_LABELS[SOURCE_FILE],
      secret: fileValue,
      warning:
        '密码还是明文躺在 build/signing/password.txt 里。存进凭据管理器后再删掉它：' +
        'node scripts/signing-secret.js --store --purge-file',
      error: '',
    };
  }
  return {
    ok: false,
    source: SOURCE_NONE,
    sourceLabel: SOURCE_LABELS[SOURCE_NONE],
    secret: '',
    warning: '',
    error:
      '找不到自签名证书的私钥密码：凭据管理器里没有、环境变量 NYX_SIGN_PASSWORD 也没设、' +
      'build/signing/password.txt 不存在。\n' +
      '  重新生成证书：node scripts/make-signing-cert.js --force\n' +
      '  只想打未签名的包：npm run dist',
  };
}

/** 给人看的来源状态（`--status` 用），不打印密码本身。 */
function describeSigningSecret(state) {
  const options = state || {};
  const lines = [];
  lines.push(`  凭据管理器（${options.credentialTarget || 'Nyx/SelfSignedCodeSigning'}）：${
    clean(options.credential) ? '有密码' : '没有'
  }`);
  lines.push(`  环境变量 NYX_SIGN_PASSWORD：${clean(options.envValue) ? '有值' : '没设'}`);
  lines.push(
    `  build/signing/password.txt：${
      options.fileExists ? (clean(options.fileValue) ? '存在且有内容（明文）' : '存在但是空的') : '不存在'
    }`,
  );
  const decided = decideSigningSecret(options);
  lines.push(`  打包实际会用：${decided.sourceLabel}`);
  if (decided.warning) lines.push(`  注意：${decided.warning}`);
  if (!decided.ok) lines.push(`  不能用：${decided.error.split('\n')[0]}`);
  return lines.join('\n');
}

module.exports = {
  SOURCE_CREDENTIAL,
  SOURCE_ENV,
  SOURCE_FILE,
  SOURCE_LABELS,
  SOURCE_NONE,
  decideSigningSecret,
  describeSigningSecret,
};
