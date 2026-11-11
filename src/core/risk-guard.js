'use strict';

/**
 * 实时风控（Risk Guard）
 *
 * 对每个 Session 的出站连接做统一体检与留痕：
 *   1. 协议白名单校验——不在白名单的协议直接阻断；
 *   2. 连接审计——记录每一条连接的 URL、资源类型、完成状态；
 *   3. 规则挂载点——evaluate() 是唯一决策入口，后续可在此接入域名黑名单、
 *      用户自定义规则，或与卡巴斯基等外部安全软件联动。
 *
 * 注意：本模块只做"本地判据"，不代替杀软的网络层拦截；
 * 与卡巴斯基 HTTPS 扫描共存的注意事项见 README。
 */

const MAX_LOG = 800;

/** 环形审计日志 */
const RISK_LOG = [];

/** 允许出站的协议白名单（其余一律阻断） */
const ALLOWED_SCHEMES = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
  'data:',
  'blob:',
  'about:',
  'file:',
  'devtools:',
  'chrome:',
  'chrome-extension:',
]);

function record(entry) {
  RISK_LOG.push(entry);
  if (RISK_LOG.length > MAX_LOG) {
    RISK_LOG.splice(0, RISK_LOG.length - MAX_LOG);
  }
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

/**
 * 风险评估入口。
 * @param {{ url: string, resourceType: string, method: string }} details
 * @returns {{ allow: boolean, reason?: string }}
 */
function evaluate(details) {
  let protocol = '';
  try {
    protocol = new URL(details.url).protocol;
  } catch {
    protocol = '';
  }

  if (!protocol || !ALLOWED_SCHEMES.has(protocol)) {
    return { allow: false, reason: `协议不在白名单：${protocol || '未知'}` };
  }

  // ↓↓↓ 规则扩展位：域名黑/白名单、可疑特征匹配、外部安全方案联动 ↓↓↓
  // 示例：
  //   const host = new URL(details.url).hostname;
  //   if (BLOCKED_HOSTS.has(host)) return { allow: false, reason: '命中黑名单域名' };
  return { allow: true };
}

/**
 * 为一个 Session 装配风控钩子。
 * @param {Electron.Session} ses
 * @param {{ mode?: 'normal'|'private' }} options
 */
function installRiskGuard(ses, { mode = 'normal' } = {}) {
  // 请求发出前：判定放行 / 阻断
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const verdict = evaluate(details);

    if (!verdict.allow) {
      record({
        ts: Date.now(),
        mode,
        action: 'block',
        reason: verdict.reason,
        url: normalizeUrl(details.url),
        resourceType: details.resourceType,
        method: details.method,
      });
      return callback({ cancel: true });
    }

    record({
      ts: Date.now(),
      mode,
      action: 'allow',
      // 两个分区都已 setProxy 固定到 127.0.0.1:7897，此处标记即代表走代理
      proxied: true,
      url: normalizeUrl(details.url),
      resourceType: details.resourceType,
      method: details.method,
    });
    return callback({});
  });

  // 请求完成：记录状态码
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    record({
      ts: Date.now(),
      mode,
      action: 'complete',
      statusCode: details.statusCode,
      url: normalizeUrl(details.url),
      resourceType: details.resourceType,
    });
  });

  // 请求异常（超时 / 连接被拒 / 代理不可用等）
  ses.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
    record({
      ts: Date.now(),
      mode,
      action: 'error',
      reason: details.error,
      url: normalizeUrl(details.url),
      resourceType: details.resourceType,
    });
  });
}

/**
 * 读取风控日志（供本地 API 暴露）。
 * @param {{ limit?: number, onlyBlocked?: boolean }} options
 */
function getRiskLog({ limit = 100, onlyBlocked = false } = {}) {
  const list = onlyBlocked
    ? RISK_LOG.filter((item) => item.action === 'block' || item.action === 'error')
    : RISK_LOG;
  return list.slice(-Math.max(1, Math.min(limit, MAX_LOG)));
}

module.exports = { installRiskGuard, getRiskLog };
