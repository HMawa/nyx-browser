'use strict';

/**
 * 网络面板「看谁的数据」的判定（清单 A4，v1.17.9）。
 *
 * 背景：抓包记录是按标签分开存的，而工具箱是整套界面的一个窗口。
 * 用户切标签时，面板要么跟着换（默认），要么钉在当前这个标签上继续看。
 * 后者不是"多此一举的功能"——排查一个页面的问题时切去别处看一眼再回来，
 * 面板跟着跳走会把刚筛好的列表打散，所以必须能钉住。
 *
 * 三条纪律（都写死在纯函数里，方便断言）：
 *   1. 默认跟随；钉住要用户自己动手，绝不偷偷钉住。
 *   2. 钉住的标签关掉了 → 必须**如实回退**到跟随，并给一句人话说明，
 *      不许停在一个已经不存在的标签上显示旧数据。
 *   3. 每个标签最多留 500 条（超出丢最旧的），这是内存口径，不是"显示上限"。
 */

/** 每个标签保留的请求条数上限（与 toolbox.js 的 MAX_RECORDS 必须一致） */
const RECORD_LIMIT = 500;

const FOLLOW_MODES = {
  follow: '跟随当前标签',
  lock: '锁定这个标签',
};

const FOLLOW_FALLBACK_REASON = '锁定的标签已经关掉了，已自动改回「跟随当前标签」。';

/**
 * 归一化模式：只认 'follow' / 'lock'，其余一律当默认的跟随。
 * @param {unknown} raw
 * @returns {'follow'|'lock'}
 */
function normalizeFollowMode(raw) {
  return String(raw || '').trim() === 'lock' ? 'lock' : 'follow';
}

/**
 * 决定面板现在该看哪个标签的数据。
 * @param {{mode?:unknown, lockedWcId?:number|null, activeWcId?:number|null, liveWcIds?:number[]}} input
 * @returns {{mode:'follow'|'lock', wcId:number|null, fellBack:boolean, reason:string}}
 */
function decideFollowTarget(input) {
  const opts = input || {};
  const mode = normalizeFollowMode(opts.mode);
  const active = Number.isFinite(opts.activeWcId) ? Number(opts.activeWcId) : null;
  const locked = Number.isFinite(opts.lockedWcId) ? Number(opts.lockedWcId) : null;
  const live = Array.isArray(opts.liveWcIds) ? opts.liveWcIds.map(Number) : [];

  if (mode === 'lock') {
    if (locked != null && live.includes(locked)) {
      return { mode: 'lock', wcId: locked, fellBack: false, reason: '' };
    }
    // 钉住的标签没了：不许假装还钉着，如实回退并说明
    return { mode: 'follow', wcId: active, fellBack: true, reason: FOLLOW_FALLBACK_REASON };
  }
  return { mode: 'follow', wcId: active, fellBack: false, reason: '' };
}

/**
 * 按上限裁掉最旧的记录。
 * 只裁显示层，不动主进程的采集器；返回被丢掉多少条，供界面提示。
 * @param {Array<object>} records 新的在后
 * @param {number} limit
 * @returns {{records:Array<object>, dropped:number}}
 */
function trimRecords(records, limit) {
  const list = Array.isArray(records) ? records : [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : RECORD_LIMIT;
  if (list.length <= max) return { records: list.slice(), dropped: 0 };
  const dropped = list.length - max;
  return { records: list.slice(dropped), dropped };
}

/** 面板右下角那句「现在看的是哪个标签」 */
function describeFollowState(input) {
  const opts = input || {};
  const mode = normalizeFollowMode(opts.mode);
  const title = String(opts.title || '').trim();
  const name = title || (Number.isFinite(opts.wcId) ? `标签 ${opts.wcId}` : '当前标签');
  if (mode === 'lock') return `已锁定：${name}（切标签不会换数据）`;
  return `跟随当前标签：${name}`;
}

module.exports = {
  FOLLOW_FALLBACK_REASON,
  FOLLOW_MODES,
  RECORD_LIMIT,
  decideFollowTarget,
  describeFollowState,
  normalizeFollowMode,
  trimRecords,
};
