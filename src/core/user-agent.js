'use strict';

/**
 * 普通模式的 User-Agent（安全审计 P2）。
 *
 * 问题：以前普通模式发出去的 UA 是 Electron 默认的
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Nyx/1.17.x … Electron/45.3.2 …
 * 等于每访问一个网站都主动报「我用的是一个桌面壳 + 具体版本」：
 *   - 网站可以据此给你"非标准浏览器"的页面或降级策略；
 *   - 指纹里多了一串极少数人才有的标记（越独特越好认）；
 *   - Electron 版本号本身就是攻击面提示。
 *
 * 做法：只保留真实内核信息（Chromium 版本取自 process.versions.chrome），
 * 去掉 Nyx/Electron 两个私有标记。这不是"伪装成 Chrome"——
 * 内核确实是 Chromium，报的就是它。
 *
 * 隐私模式另有更强的口径（src/core/privacy-surface.js 里的画像），
 * 这里只管普通模式。
 */

/** 从 process.versions.chrome 里取主版本号，取不到就退回一个保守值 */
function chromeMajor(chromeVersion) {
  const raw = String(chromeVersion || '');
  const major = raw.split('.')[0];
  return /^\d{2,3}$/.test(major) ? major : '156';
}

/**
 * @param {{chromeVersion?: string, platform?: string}} [env]
 * @returns {string} 不含 Nyx / Electron 标记的 UA
 */
function normalUserAgent(env) {
  const chrome = chromeMajor(env && env.chromeVersion ? env.chromeVersion : process.versions.chrome);
  // Windows 的 UA 平台串固定是 Win64; x64（与真实系统位数无关，Chrome 一直这么发）
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${chrome}.0.0.0 Safari/537.36`
  );
}

/** 判定串里有没有自报家门的标记（回归脚本与排障都用它） */
function leaksIdentityToken(ua) {
  return /Nyx\/|Electron\//i.test(String(ua || ''));
}

module.exports = { chromeMajor, normalUserAgent, leaksIdentityToken };
