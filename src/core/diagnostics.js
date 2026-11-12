'use strict';

/**
 * 诊断与错误日志（实测修复清单 C1）
 *
 * 为什么需要它：清单里 A2（隐私模式静默变直连）、A1（下载全废）、A4（失败页空白）
 * 三条都必须先"看得见"才能定论。在此之前 Nyx 的错误只写进 stdout，
 * 打包后的用户根本看不到，等于所有失败都是静默的。
 *
 * 三条设计约束（来自 AGENTS.md 红线）：
 *   1. 零第三方依赖：只用 node 内置模块，ZIP 容器自己写（诊断包要能发给别人看）。
 *   2. 不落敏感数据：写盘前统一脱敏（URL 查询参数里的 token/key/密码一律抹掉），
 *      绝不记录 cookie、Authorization、表单内容。
 *   3. 环形缓冲 + 文件双份：内存留最近 300 条供 UI 秒开，文件按行追加供事后排查。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** 内存环形缓冲上限（超过丢最旧的） */
const MAX_ENTRIES = 300;
/** 诊断页默认展示条数（清单要求"最近 20 条"） */
const MAX_LIST = 20;
/** 单条附加信息序列化后的上限，防止把整页 HTML 塞进来 */
const MAX_EXTRA_BYTES = 8 * 1024;
/** 落盘日志超过这个大小就轮转成 errors.1.jsonl */
const LOG_ROTATE_BYTES = 1.5 * 1024 * 1024;
/** 诊断包里的行数上限 */
const MAX_EXPORT_ENTRIES = 500;

/** Chromium 错误码 → 中文原因（失败页 A4 与诊断页共用同一张表） */
const LOAD_ERROR_REASONS = {
  '-2': '请求被中止（可能被代理或扩展拦截）',
  '-3': '请求被中止',
  '-6': '文件未找到',
  '-7': '连接超时，目标无响应',
  '-21': '网络连接被中断',
  '-101': '连接被重置，可能被防火墙或代理掐断',
  '-102': '连接被拒绝，目标端口没有服务',
  '-105': '域名解析失败，请检查网络或代理 DNS',
  '-106': '网络已断开',
  '-107': 'SSL 协议错误',
  '-109': '目标主机不可达',
  '-111': '连接超时，隧道建立失败',
  '-118': '连接提前关闭（常见于代理握手失败）',
  '-130': '代理认证失败',
  '-137': '域名解析失败（代理 DNS）',
  '-200': '证书无效（域名与证书不匹配）',
  '-201': '证书已过期',
  '-202': '证书已被吊销',
  '-204': '站点证书不受信任',
  '-207': '证书链不完整',
  '-310': '重定向次数过多',
  '-324': '响应内容为空',
  '-501': 'HTTPS 握手失败',
  // Chromium 把 9/25/110 等端口列为不安全端口，直接拒绝连接（测试地址常用到）
  '-312': '端口被浏览器列为不安全端口，已拦截（如 9、25、110 等）',
};

/** 把 Chromium 错误码翻译成中文原因（未知码回落为浏览器给出的英文描述） */
function describeLoadError(errorCode, fallback = '') {
  const key = String(errorCode);
  return LOAD_ERROR_REASONS[key] || fallback || `未知错误（${key}）`;
}

/* ------------------------------------------------------------------ */
/* 脱敏                                                                */
/* ------------------------------------------------------------------ */

/** 查询串里这些参数名一律打码 */
const SECRET_PARAM = /([?&](?:token|key|secret|password|passwd|pwd|auth|authorization|code|session|sig|signature)=)[^&#\s]*/gi;
/** 头部样式 token=xxx / Bearer xxx / sk-xxxx */
const SECRET_INLINE = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9]{8,}/gi;

/** 抹掉可能带凭证的片段；宁可多抹，不可泄漏 */
function redact(text) {
  if (typeof text !== 'string' || !text) return text || '';
  return text
    .replace(SECRET_PARAM, '$1***')
    .replace(SECRET_INLINE, (match) => (match.length > 12 ? `${match.slice(0, 4)}***` : '***'));
}

/** 深拷贝并脱敏任意附加信息，同时限制体积 */
function sanitizeExtra(extra) {
  if (extra === undefined || extra === null) return undefined;
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(extra));
  } catch {
    return { note: String(extra).slice(0, MAX_EXTRA_BYTES) };
  }
  const walk = (value, depth) => {
    if (depth > 4) return '…';
    if (typeof value === 'string') return redact(value).slice(0, 400);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => walk(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        // 名字像凭证的键直接整段打码，不看值
        out[key] = /token|secret|password|cookie|authorization|key/i.test(key) ? '***' : walk(item, depth + 1);
      }
      return out;
    }
    return value;
  };
  return walk(plain, 0);
}

/* ------------------------------------------------------------------ */
/* ZIP 写入（只为实现"导出诊断包"，store/deflate 两种方法）                */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间/日期（ZIP 头使用，固定 UTC 便于不同机器比对） */
function dosStamp(date) {
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (Math.floor(date.getUTCSeconds() / 2) & 0x1f);
  const day =
    (((date.getUTCFullYear() - 1980) & 0x7f) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/**
 * 写出一个最小 ZIP 包（无目录条目、无 zip64、无加密）。
 * @param {string} filePath 目标路径
 * @param {Array<{name: string, data: Buffer|string}>} entries 条目
 * @returns {{filePath: string, bytes: number, entries: number}}
 */
function writeZipSync(filePath, entries) {
  const list = (entries || []).map((entry) => ({
    name: String(entry.name || 'unnamed.txt').replace(/\\/g, '/'),
    data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8'),
  }));
  const stamp = dosStamp(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of list) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const buffer = Buffer.concat([...locals, centralBuf, end]);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
  return { filePath, bytes: buffer.length, entries: list.length };
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                        */
/* ------------------------------------------------------------------ */

class Diagnostics {
  /**
   * @param {object} options
   * @param {string} options.stateDir userData 目录（日志写在 <stateDir>/diagnostics/）
   * @param {string} [options.appVersion] 应用版本（用于诊断报告抬头）
   * @param {number} [options.maxEntries] 内存缓冲上限
   */
  constructor({ stateDir, appVersion = '', maxEntries = MAX_ENTRIES } = {}) {
    this.stateDir = stateDir;
    this.appVersion = appVersion;
    this.maxEntries = Math.max(20, Number(maxEntries) || MAX_ENTRIES);
    this.entries = [];
    this.seq = 0;
    /** 由主进程注册：返回当前模式 / 代理 / GPU 等实时上下文 */
    this.contextProvider = null;
    this.logDir = path.join(stateDir, 'diagnostics');
    this.logPath = path.join(this.logDir, 'errors.jsonl');
    this.hooksInstalled = false;
    this.writeFailures = 0;
  }

  setContextProvider(fn) {
    this.contextProvider = typeof fn === 'function' ? fn : null;
  }

  /** 当前上下文快照（没注册 provider 时只给版本信息） */
  context() {
    const base = {
      appVersion: this.appVersion || '',
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      node: process.versions.node || '',
      platform: process.platform,
      arch: process.arch,
      userData: this.stateDir,
    };
    if (!this.contextProvider) return base;
    try {
      const extra = this.contextProvider() || {};
      // provider 的字段覆盖基础字段（版本号以 app.getVersion() 为准更可靠）
      return { ...base, ...extra, appVersion: extra.appVersion || base.appVersion };
    } catch (err) {
      return { ...base, contextError: err && err.message ? err.message : String(err) };
    }
  }

  /** 记一条记录 */
  push(level, code, message, extra) {
    const entry = {
      id: (this.seq += 1),
      at: new Date().toISOString(),
      level: ['error', 'warn', 'info'].includes(level) ? level : 'error',
      code: redact(String(code || 'UNKNOWN')).slice(0, 80),
      message: redact(String(message || '')).slice(0, 2000),
    };
    const safeExtra = sanitizeExtra(extra);
    if (safeExtra !== undefined) entry.extra = safeExtra;

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.appendToFile(entry);
    return entry;
  }

  error(code, message, extra) {
    return this.push('error', code, message, extra);
  }

  warn(code, message, extra) {
    return this.push('warn', code, message, extra);
  }

  info(code, message, extra) {
    return this.push('info', code, message, extra);
  }

  /** 追加写盘：失败只累加计数，绝不让日志本身抛异常打断主流程 */
  appendToFile(entry) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      try {
        const stat = fs.statSync(this.logPath);
        if (stat.size > LOG_ROTATE_BYTES) {
          const rotated = path.join(this.logDir, 'errors.1.jsonl');
          try {
            fs.rmSync(rotated, { force: true });
          } catch {
            /* 轮转失败不影响主流程 */
          }
          fs.renameSync(this.logPath, rotated);
        }
      } catch {
        /* 文件还不存在：直接写 */
      }
      fs.appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      this.writeFailures += 1;
    }
  }

  /** 最近 N 条（新的在前） */
  list(limit = MAX_LIST) {
    const count = Math.max(1, Math.min(Number(limit) || MAX_LIST, this.maxEntries));
    const items = this.entries.slice(-count).reverse();
    return { ok: true, total: this.entries.length, limit: count, items };
  }

  counts() {
    const counts = { error: 0, warn: 0, info: 0, total: this.entries.length };
    for (const entry of this.entries) counts[entry.level] += 1;
    return counts;
  }

  /** 诊断页顶部状态（结构固定，UI 直接渲染） */
  status() {
    return {
      ok: true,
      version: this.appVersion,
      context: this.context(),
      counts: this.counts(),
      logPath: this.logPath,
      logDir: this.logDir,
      writeFailures: this.writeFailures,
      maxEntries: this.maxEntries,
      displayLimit: MAX_LIST,
    };
  }

  clear() {
    this.entries = [];
    try {
      fs.rmSync(this.logPath, { force: true });
    } catch {
      /* 文件本来就不存在 */
    }
    return { ok: true };
  }

  /** 人类可读的诊断报告（诊断包里的主文件） */
  buildReport() {
    const context = this.context();
    const counts = this.counts();
    const lines = [
      'Nyx 诊断报告',
      `导出时间：${new Date().toISOString()}`,
      '',
      '== 版本 ==',
      `应用版本：${context.appVersion || '未知'}`,
      `Electron：${context.electron || '未知'}`,
      `Chromium：${context.chrome || '未知'}`,
      `Node：${context.node || '未知'}`,
      `平台：${context.platform} / ${context.arch}`,
      '',
      '== 运行状态 ==',
      `模式：${context.mode || '未知'}`,
      `连接方式：${context.link || '未知'}`,
      `代理：${context.proxy || '未知'}`,
      `GPU 策略：${context.gpu || '未知'}`,
      `用户数据：${context.userData}`,
      '',
      `== 记录统计 ==（错误 ${counts.error} / 警告 ${counts.warn} / 提示 ${counts.info}）`,
      '',
      '== 最近记录 ==',
    ];
    const items = this.entries.slice(-MAX_EXPORT_ENTRIES);
    if (!items.length) lines.push('（暂无记录）');
    for (const entry of items) {
      lines.push(`[${entry.at}] ${entry.level.toUpperCase()} ${entry.code}：${entry.message}`);
      if (entry.extra !== undefined) lines.push(`    附加：${JSON.stringify(entry.extra)}`);
    }
    lines.push('', '说明：本报告已脱敏，URL 查询参数中的凭证与 Authorization/sk-* 已打码。');
    return lines.join('\n');
  }

  /**
   * 导出诊断包（ZIP：诊断报告.txt + errors.jsonl + manifest.json）
   * @param {string} destPath 目标 zip 路径
   */
  exportBundle(destPath) {
    const context = this.context();
    const counts = this.counts();
    const items = this.entries.slice(-MAX_EXPORT_ENTRIES);
    const jsonl = items.map((entry) => JSON.stringify(entry)).join('\n');
    const manifest = {
      app: 'Nyx',
      kind: 'diagnostics-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: context.appVersion || '',
      electron: context.electron || '',
      chrome: context.chrome || '',
      node: context.node || '',
      platform: context.platform,
      arch: context.arch,
      counts,
      entries: items.length,
      redacted: true,
    };
    const result = writeZipSync(destPath, [
      { name: '诊断报告.txt', data: this.buildReport() },
      { name: 'errors.jsonl', data: jsonl },
      { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
    ]);
    return { ok: true, ...result, counts, entries: items.length };
  }

  /**
   * 安装全局错误钩子。必须在 app ready 之前调用，否则会漏掉启动早期异常。
   * @param {import('electron').App} app
   */
  installProcessHooks(app) {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;

    process.on('uncaughtException', (err) => {
      this.error('MAIN_UNCAUGHT', err && err.message ? err.message : String(err), { stack: err && err.stack });
      // 不吞掉：照旧打到 stderr，方便终端里同时看到
      console.error('[Nyx] 未捕获异常：', err);
    });

    process.on('unhandledRejection', (reason) => {
      const message = reason && reason.message ? reason.message : String(reason);
      this.warn('MAIN_REJECTION', message, { stack: reason && reason.stack });
      console.error('[Nyx] 未处理的 Promise 拒绝：', reason);
    });

    app.on('child-process-gone', (_event, details) => {
      this.error('CHILD_PROCESS_GONE', `子进程异常退出：${details.type}`, {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });

    // 证书错误：不改变 Electron 默认行为（默认就是拒绝），只记录原因
    app.on('certificate-error', (event, webContents, url, error) => {
      if (!event.defaultPrevented) {
        this.warn('CERT_ERROR', `证书校验失败：${error}`, { url, error });
      }
    });

    // 所有 webContents（标签页 / 外壳 / 浮层 / 设置）统一挂钩子
    app.on('web-contents-created', (_event, contents) => {
      contents.on('render-process-gone', (_e, details) => {
        this.error('RENDER_GONE', '页面进程异常退出', {
          reason: details && details.reason,
          exitCode: details && details.exitCode,
          url: contents.getURL ? contents.getURL() : '',
        });
      });
      contents.on('unresponsive', () => {
        this.warn('RENDER_UNRESPONSIVE', '页面无响应', { url: contents.getURL ? contents.getURL() : '' });
      });
      contents.on('preload-error', (_e, preloadPath, error) => {
        this.error('PRELOAD_ERROR', error && error.message ? error.message : 'preload 脚本出错', {
          preload: preloadPath,
          stack: error && error.stack,
        });
      });
      contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        this.error('LOAD_FAILED', describeLoadError(errorCode, errorDescription), {
          errorCode,
          errorDescription,
          url: validatedURL,
        });
      });
    });
  }
}

module.exports = {
  Diagnostics,
  LOAD_ERROR_REASONS,
  describeLoadError,
  redact,
  sanitizeExtra,
  crc32,
  writeZipSync,
  MAX_ENTRIES,
  MAX_LIST,
};
