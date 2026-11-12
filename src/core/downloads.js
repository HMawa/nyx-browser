'use strict';

/**
 * 下载管理（纯逻辑，不依赖 Electron 的 DownloadItem 具体类型）。
 *
 * 为什么单独成模块：本仓库的下载曾经"全都报废"——`will-download` 里先
 * `event.preventDefault()` 再去弹异步保存框，等于当场取消下载，随后对已销毁的
 * DownloadItem 调 `setSavePath` 抛异常又被空 catch 吞掉，结果是文件 0 字节、
 * 界面上一个提示都没有。这段逻辑现在必须能脱离 Electron 被断言（scripts/
 * verify-downloads.js 用一个假 item 驱动），所以：
 *   - 落点唯一的决定权在 `uniquePath()` / `sanitizeFilename()` 两个纯函数；
 *   - 进度、速度、失败原因的统一记账在 `DownloadManager`；
 *   - 任何状态变化都通过 `push()` 推给界面，不允许只打日志。
 *
 * 零第三方依赖。
 */

const fs = require('fs');
const path = require('path');

/** 下载状态（与 Electron DownloadItem 的 done 事件值对齐，另加 progressing） */
const DOWNLOAD_STATES = {
  progressing: 'progressing',
  completed: 'completed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

/** 历史条数上限（内存 + 落盘都按这个截断） */
const MAX_ENTRIES = 100;
/** 进度推送节流：太频繁会把渲染层刷爆，300ms 一次足够看出速度 */
const PUSH_INTERVAL_MS = 300;

/**
 * 把服务器给的（或 URL 里取的）文件名洗成 Windows 能写的名字。
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizeFilename(raw) {
  const text = String(raw || '').trim();
  if (!text) return `nyx-${Date.now()}.bin`;
  // 保留中文，只干掉 Windows 非法字符与控制字符
  const cleaned = text
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+$/, '_')
    .trim();
  const sliced = cleaned.slice(0, 150).trim();
  return sliced || `nyx-${Date.now()}.bin`;
}

/**
 * 生成目录内不冲突的保存路径：重名时追加 (1)(2)… 递增后缀。
 *
 * @param {string} dir 目录
 * @param {string} filename 已洗过的文件名
 * @param {(p:string)=>boolean} [exists] 便于测试注入
 * @returns {string}
 */
function uniquePath(dir, filename, exists = fs.existsSync) {
  const name = sanitizeFilename(filename);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  let candidate = path.join(dir, name);
  let seq = 1;
  // 上限保护：目录里同名文件超过 999 个就带时间戳，避免死循环
  while (exists(candidate) && seq <= 999) {
    candidate = path.join(dir, `${stem}(${seq})${ext}`);
    seq += 1;
  }
  if (exists(candidate)) {
    candidate = path.join(dir, `${stem}-${Date.now()}${ext}`);
  }
  return candidate;
}

/**
 * 把 Electron 的 done 状态 + 中断原因翻成用户能看懂的中文。
 *
 * @param {string} state completed / cancelled / interrupted
 * @param {string} [reason] DownloadItem 的 getLastModifiedTime 之外的失败描述
 * @returns {string} 空字符串表示没出错
 */
function describeDownloadFailure(state, reason) {
  if (state === DOWNLOAD_STATES.completed) return '';
  if (state === DOWNLOAD_STATES.cancelled) return '下载已被取消';
  const detail = String(reason || '').trim();
  if (!detail) return '下载中断（网络断开或服务器提前结束响应）';
  if (/ENOSPC|no space/i.test(detail)) return '磁盘空间不足，下载中断';
  if (/EACCES|EPERM|permission/i.test(detail)) return '没有写入权限，下载中断';
  if (/ENOENT/i.test(detail)) return '保存目录不存在，下载中断';
  if (/network|disconnect|ECONN|ETIMEDOUT|reset/i.test(detail)) return `网络中断，下载失败（${detail}）`;
  return `下载中断：${detail}`;
}

/**
 * 人类可读的字节数。
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 下载管理器：只管记账与推送，落点由调用方先定好再交给它 */
class DownloadManager {
  /**
   * @param {{push?:(payload:object)=>void, exists?:(p:string)=>boolean,
   *          now?:()=>number, limit?:number}} [opts]
   */
  constructor(opts = {}) {
    this.push = typeof opts.push === 'function' ? opts.push : () => {};
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.limit = Number(opts.limit) > 0 ? Number(opts.limit) : MAX_ENTRIES;
    /** @type {Array<object>} 新条目在前 */
    this.items = [];
    this.seq = 0;
    this.lastPushAt = 0;
  }

  /** 是否还有未结束的下载 */
  activeCount() {
    return this.items.filter((it) => it.state === DOWNLOAD_STATES.progressing).length;
  }

  /** 列表快照（给渲染层用，纯数据） */
  list() {
    return this.items.map((it) => Object.assign({}, it));
  }

  /** 汇总，随列表一起下发 */
  summary() {
    const done = this.items.filter((it) => it.state === DOWNLOAD_STATES.completed).length;
    const failed = this.items.filter((it) => it.state === DOWNLOAD_STATES.interrupted).length;
    const cancelled = this.items.filter((it) => it.state === DOWNLOAD_STATES.cancelled).length;
    return { total: this.items.length, active: this.activeCount(), done, failed, cancelled };
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  clear() {
    // 未结束的条目不删：否则用户就再也不知道"那个还在下的文件"去哪了
    this.items = this.items.filter((it) => it.state === DOWNLOAD_STATES.progressing);
    this.emit(true);
    return this.list();
  }

  /**
   * 接管一个 DownloadItem（真货或测试用的假货）。
   *
   * 调用前必须已经把保存路径钉好（setSavePath 同步调用），这里只读不写落点，
   * 避免又出现"先取消再设路径"的老毛病。
   *
   * @param {object} item Electron DownloadItem 形状
   * @param {{mode?:string, savePath?:string, source?:string}} [meta]
   * @returns {object} 记录
   */
  attach(item, meta = {}) {
    const startedAt = this.now();
    const readPath = () => {
      try {
        return (typeof item.getSavePath === 'function' && item.getSavePath()) || meta.savePath || '';
      } catch {
        return meta.savePath || '';
      }
    };
    const rec = {
      id: `dl-${++this.seq}-${startedAt}`,
      filename: sanitizeFilename(meta.filename || (item.getFilename ? item.getFilename() : '')),
      url: meta.url || (item.getURL ? item.getURL() : ''),
      mode: meta.mode === 'private' ? 'private' : 'normal',
      savePath: readPath(),
      state: DOWNLOAD_STATES.progressing,
      receivedBytes: 0,
      totalBytes: 0,
      speedBytes: 0,
      // 时长与平均速度：清单 A3 要「慢」有据可查，别只凭感觉
      durationMs: 0,
      avgBytesPerSec: 0,
      error: '',
      startedAt,
      endedAt: 0,
    };

    this.items.unshift(rec);
    this.trim();
    this.emit(true);

    let lastBytes = 0;
    let lastAt = startedAt;

    const onUpdated = () => {
      try {
        rec.receivedBytes = Number(item.getReceivedBytes ? item.getReceivedBytes() : 0) || 0;
        rec.totalBytes = Number(item.getTotalBytes ? item.getTotalBytes() : 0) || 0;
        rec.savePath = readPath() || rec.savePath;
      } catch {
        /* 读到一半被销毁：保留上一帧数据 */
      }
      const at = this.now();
      const delta = at - lastAt;
      if (delta >= 500) {
        rec.speedBytes = Math.max(0, Math.round(((rec.receivedBytes - lastBytes) * 1000) / delta));
        lastBytes = rec.receivedBytes;
        lastAt = at;
      }
      this.emit(false);
    };

    const onDone = (_event, state) => {
      rec.endedAt = this.now();
      rec.receivedBytes = Number(item.getReceivedBytes ? item.getReceivedBytes() : rec.receivedBytes) || rec.receivedBytes;
      rec.totalBytes = Number(item.getTotalBytes ? item.getTotalBytes() : rec.totalBytes) || rec.totalBytes;
      rec.savePath = readPath() || rec.savePath;
      rec.speedBytes = 0;
      // 时长与平均速度：只统计真的结束了、并且确实收到了字节的条目
      const duration = rec.endedAt - rec.startedAt;
      if (duration > 0 && rec.receivedBytes > 0) {
        rec.durationMs = duration;
        rec.avgBytesPerSec = Math.round((rec.receivedBytes * 1000) / duration);
      }
      if (state === DOWNLOAD_STATES.completed) {
        rec.state = DOWNLOAD_STATES.completed;
        rec.error = '';
      } else if (state === DOWNLOAD_STATES.cancelled) {
        rec.state = DOWNLOAD_STATES.cancelled;
        rec.error = describeDownloadFailure(DOWNLOAD_STATES.cancelled, '');
      } else {
        rec.state = DOWNLOAD_STATES.interrupted;
        let reason = '';
        try {
          reason = item.getLastErrorReason ? item.getLastErrorReason() : '';
        } catch {
          reason = '';
        }
        rec.error = describeDownloadFailure(DOWNLOAD_STATES.interrupted, reason);
      }
      this.emit(true);
    };

    if (typeof item.on === 'function') {
      item.on('updated', onUpdated);
      item.once('done', onDone);
    }

    return rec;
  }

  trim() {
    if (this.items.length <= this.limit) return;
    // 只裁已结束的条目，正在下的一个不丢
    const keep = [];
    let remaining = this.limit;
    for (const it of this.items) {
      if (it.state === DOWNLOAD_STATES.progressing) {
        keep.push(it);
        remaining -= 1;
      }
    }
    for (const it of this.items) {
      if (remaining <= 0) break;
      if (it.state === DOWNLOAD_STATES.progressing) continue;
      keep.push(it);
      remaining -= 1;
    }
    // 保持"新条目在前"的顺序
    this.items = this.items.filter((it) => keep.includes(it));
  }

  /** 推送状态（进度类节流，状态类立即推） */
  emit(immediate) {
    const at = this.now();
    if (!immediate && at - this.lastPushAt < PUSH_INTERVAL_MS) return;
    this.lastPushAt = at;
    this.push({ items: this.list(), summary: this.summary() });
  }
}

module.exports = {
  DOWNLOAD_STATES,
  MAX_ENTRIES,
  PUSH_INTERVAL_MS,
  DownloadManager,
  describeDownloadFailure,
  formatBytes,
  sanitizeFilename,
  uniquePath,
};
