'use strict';

/**
 * 站点图标缓存（v1.6.0 从 main.js 抽出来的公共模块）
 *
 * 为什么抽出来：地址栏建议、工具箱（历史 / 抓包列表）、将来的其他面板都要显示站点图标，
 * 如果各自实现一套，就会各抓一遍、各存一份，既浪费流量也浪费磁盘。
 * 这里统一三件事：
 *   1. 缓存目录：<userData>/site-icons/<sha1(host)>.bin（所有调用方共用同一份）；
 *   2. 抓取策略：https://<host>/favicon.ico、2s 超时、64KB 上限、按魔数嗅探类型；
 *   3. 失败语义：抓不到返回空串，由调用方回退到首字母色块，绝不抛异常。
 *
 * 零第三方依赖：只用 Node 内置模块；网络请求由调用方注入（主进程传 electronNet.fetch，
 * 这样图标请求走 Chromium 网络栈、跟随代理，与「出站链路受控」的产品纪律一致）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 单个图标上限：正常站点图标远小于此 */
const ICON_MAX_BYTES = 64 * 1024;
/** 抓取超时：慢站点直接放弃，不拖住任何调用方 */
const ICON_TIMEOUT_MS = 2000;

/**
 * 用魔数嗅探图片类型。
 * 不信任 Content-Type（不少站点的 favicon 返回 text/plain 或 application/octet-stream）。
 */
function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  // SVG 是文本，允许前面有 BOM / 空白 / XML 声明
  const head = buf.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return '';
}

/** 规范化 host：去协议、去路径、去端口后的小写域名（调用方可能直接给 URL） */
function normalizeHost(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).host.toLowerCase();
  } catch {
    return '';
  }
}

class SiteIcons {
  /**
   * @param {object} options
   * @param {string} options.stateDir 用户数据目录（主进程传 app.getPath('userData')）
   * @param {(url:string, init:object) => Promise<any>} options.fetchImpl 发请求的实现（主进程注入 electronNet.fetch）
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxBytes]
   */
  constructor({ stateDir, fetchImpl, timeoutMs, maxBytes }) {
    this.dir = path.join(stateDir, 'site-icons');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : ICON_TIMEOUT_MS;
    this.maxBytes = Number.isFinite(maxBytes) ? maxBytes : ICON_MAX_BYTES;
    /** host → data URL（本次运行内有效） */
    this.memo = new Map();
    /** 本次运行内抓取失败的 host：不再重试，避免反复打同一个站点 */
    this.miss = new Set();
    /** 正在抓取的 host：并发去重 */
    this.inflight = new Set();
  }

  fileOf(host) {
    const name = crypto.createHash('sha1').update(String(host)).digest('hex');
    return path.join(this.dir, `${name}.bin`);
  }

  /** 读已有图标：内存 → 磁盘；都没有返回空串 */
  cached(rawHost) {
    const host = normalizeHost(rawHost);
    if (!host) return '';
    const memo = this.memo.get(host);
    if (memo) return memo;
    try {
      const file = this.fileOf(host);
      if (!fs.existsSync(file)) return '';
      const buf = fs.readFileSync(file);
      const mime = sniffImageMime(buf);
      if (!mime) return '';
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      this.memo.set(host, dataUrl);
      return dataUrl;
    } catch {
      return '';
    }
  }

  /**
   * 抓取（或直接返回缓存）。失败返回空串。
   * @returns {Promise<string>} data URL 或 ''
   */
  async ensure(rawHost) {
    const host = normalizeHost(rawHost);
    if (!host) return '';
    const hit = this.cached(host);
    if (hit) return hit;
    if (this.miss.has(host) || this.inflight.has(host) || typeof this.fetchImpl !== 'function') return '';

    this.inflight.add(host);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const init = { headers: { Accept: 'image/x-icon,image/*;q=0.8' } };
      if (controller) init.signal = controller.signal;
      const res = await this.fetchImpl(`https://${host}/favicon.ico`, init);
      if (!res || !res.ok) {
        this.miss.add(host);
        return '';
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > this.maxBytes) {
        this.miss.add(host);
        return '';
      }
      const mime = sniffImageMime(buf);
      if (!mime) {
        this.miss.add(host);
        return '';
      }
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.fileOf(host), buf);
      } catch {
        // 缓存写失败不影响本次显示：内存里照样能用
      }
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      this.memo.set(host, dataUrl);
      return dataUrl;
    } catch {
      this.miss.add(host);
      return '';
    } finally {
      if (timer) clearTimeout(timer);
      this.inflight.delete(host);
    }
  }
}

module.exports = { SiteIcons, sniffImageMime, normalizeHost, ICON_MAX_BYTES, ICON_TIMEOUT_MS };
