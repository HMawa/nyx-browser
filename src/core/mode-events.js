'use strict';

/**
 * 模式变更事件环形缓冲（纯内存，不落盘）。
 *
 * 用途：记录每一次模式切换请求（含被拒绝的请求）与启动时的模式恢复决策，
 * 供本地接口 GET /mode/events 查询，支撑自动化测试对"模式切换"代码路径的断言
 * （该路径此前无法通过 UI 自绘控件触发）。
 *
 * 特性：
 *   1. 固定容量环形缓冲，超出容量自动丢弃最旧记录（默认保留最近 50 条）；
 *   2. 纯内存结构，不写文件、不写日志（不产生额外本地痕迹）；
 *   3. 仅记录模式名、时间戳、错误码与提示文案，不含任何浏览数据。
 */

const DEFAULT_LIMIT = 50;

/** 格式化为本地时间字符串（手工拼接，不用 strftime 中文格式串） */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * 创建模式变更事件缓冲。
 * @param {number} [limit] 容量上限，默认 50
 */
function createModeEventLog(limit = DEFAULT_LIMIT) {
  const capacity = Math.max(1, Number(limit) || DEFAULT_LIMIT);
  const buffer = [];
  let seq = 0;

  /**
   * 追加一条事件。
   * @param {{type?:'switch'|'startup', from?:string, to?:string, changed?:boolean,
   *          ok?:boolean, code?:string|null, message?:string, ts?:number}} [entry]
   * @returns {object} 归一化后的事件对象
   */
  function record(entry = {}) {
    seq += 1;
    const ts = Number.isFinite(entry.ts) ? entry.ts : Date.now();
    const ok = entry.ok === true;

    const item = {
      seq,
      ts,
      time: formatTime(ts),
      type: entry.type === 'startup' ? 'startup' : 'switch',
      from: entry.from === 'private' ? 'private' : 'normal',
      to: entry.to === 'private' ? 'private' : 'normal',
      changed: entry.changed === true,
      ok,
      code: ok ? null : entry.code || null,
      message: entry.message ? String(entry.message) : '',
    };

    buffer.push(item);
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    return item;
  }

  /** 按时间顺序返回全部在缓冲中的事件（副本） */
  function events() {
    return buffer.slice();
  }

  function count() {
    return buffer.length;
  }

  function clear() {
    buffer.length = 0;
  }

  return { record, events, count, clear, capacity };
}

module.exports = { createModeEventLog, DEFAULT_LIMIT };
