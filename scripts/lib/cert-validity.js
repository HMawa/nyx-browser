'use strict';

/**
 * 证书有效期的纯逻辑判定（打包前检查与回归断言共用同一套规则）。
 *
 * 为什么单独抽成一个模块：过期与否只看一个时间戳，但「过期了还能不能打包」
 * 和「还剩多少天该提醒」这两条规则必须只有一处实现——否则打包脚本说一套、
 * 回归脚本说另一套，最后就会变成「验签通过但签名无效」这种最难查的状态。
 *
 * 三条硬规则（写在这里，不许在调用方另写一遍）：
 *   1. 已经过期 → ok:false（过期证书签出来的包，Windows 一律当无效，不能拿去发布）；
 *   2. 读不出到期时间 → ok:false（读不到不等于有效，不许当成有效放过）；
 *   3. 剩余天数 ≤ warnDays → ok:true 但 level:'warn'（还能签，但必须当场提醒）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WARN_DAYS = 30;

function formatCertDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 把各种来源的到期时间解析成 Date。
 * 认：Date、毫秒时间戳、ISO 字符串（含 PowerShell 的 "o" 格式）、"yyyy-MM-dd"、中文斜杠写法。
 */
function parseCertDate(raw) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const fromNumber = new Date(raw);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  const compact = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (compact) {
    const date = new Date(Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 判定证书还剩多久。
 * @param {string|number|Date} notAfter 到期时间（任何 parseCertDate 认的形状）
 * @param {{now?: number|Date, warnDays?: number}} [options]
 * @returns {{ok: boolean, level: 'ok'|'warn'|'expired'|'unknown', daysLeft: number|null, notAfter: string, message: string}}
 */
function describeCertValidity(notAfter, options) {
  const opts = options || {};
  const nowDate = parseCertDate(opts.now === undefined ? Date.now() : opts.now);
  const now = nowDate ? nowDate.getTime() : Date.now();
  const warnDays =
    Number.isFinite(opts.warnDays) && opts.warnDays >= 0 ? Number(opts.warnDays) : DEFAULT_WARN_DAYS;

  const date = parseCertDate(notAfter);
  if (!date) {
    return {
      ok: false,
      level: 'unknown',
      daysLeft: null,
      notAfter: '',
      message:
        '读不出这张自签名证书的到期时间——读不到就不算有效。' +
        '重新生成一张：node scripts/make-signing-cert.js --force',
    };
  }

  const daysLeft = Math.floor((date.getTime() - now) / DAY_MS);
  const stamp = formatCertDate(date);

  if (daysLeft < 0) {
    return {
      ok: false,
      level: 'expired',
      daysLeft,
      notAfter: stamp,
      message:
        `自签名证书已经过期 ${Math.abs(daysLeft)} 天（到期 ${stamp}），` +
        '过期证书签出来的包 Windows 会当成无效签名，不能拿去发布。' +
        '重新生成：node scripts/make-signing-cert.js --force（旧签名随之失效）。',
    };
  }

  if (daysLeft <= warnDays) {
    return {
      ok: true,
      level: 'warn',
      daysLeft,
      notAfter: stamp,
      message:
        `自签名证书还有 ${daysLeft} 天到期（${stamp}）。` +
        '到期前请重新生成，否则到时候打出来的包会验不过。',
    };
  }

  return {
    ok: true,
    level: 'ok',
    daysLeft,
    notAfter: stamp,
    message: `自签名证书还有 ${daysLeft} 天有效（到 ${stamp}）。`,
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_WARN_DAYS,
  describeCertValidity,
  formatCertDate,
  parseCertDate,
};
