'use strict';

/**
 * 录屏 / 被远控检测（清单 C4，纯逻辑，零 Electron 依赖）。
 *
 * 为什么要有这件东西：
 *   隐私模式保护的是「不落盘、不旁路、不留痕」，**保护不了「你屏幕上正在发生的事被别人看见」**。
 *   用户开着 OBS 或挂着向日葵远控时切进全隐私模式，会误以为"现在安全了"，其实画面正被录。
 *   所以进入隐私模式前要先看一眼：正在录屏/被远控就别进；看不出结果时也必须说"无法确认"，
 *   绝不允许拿"没检测到"冒充"没有风险"。
 *
 * 设计取舍：
 *   - 只做**进程名单**这一档最小可用检测：能覆盖常见录屏、远控、会议软件；不做窗口标题识别、
 *     不做驱动级抓屏检测、不做摄像头指示灯识别（都不够可靠，装了反而给人虚假安全感）。
 *   - 名单里分三类（录屏 / 远控 / 会议），命中任何一类都算风险：会议软件默认可能共享屏幕。
 *   - 读不到进程列表时**不是"没有风险"**，而是 `unknown`：要求用户显式确认后再进。
 *
 * 零第三方依赖。
 */

/** 风险类别 → 中文标签 */
const CATEGORY_LABELS = {
  capture: '录屏 / 直播',
  remote: '远程控制',
  meeting: '会议（可能正在共享屏幕）',
};

/**
 * 进程名单。全部用小写，匹配时对可执行文件名做 basename + 小写处理。
 * 只收「装了就在录/就在被控」的程序：聊天软件、泛用播放器门槛太低，收进来会天天误报。
 */
const SCREEN_WATCH_PROCESSES = [
  // —— 录屏 / 直播 ——
  { name: 'obs64.exe', label: 'OBS Studio', category: 'capture' },
  { name: 'obs32.exe', label: 'OBS Studio（32 位）', category: 'capture' },
  { name: 'obs.exe', label: 'OBS Studio（旧版）', category: 'capture' },
  { name: 'bdcam.exe', label: 'Bandicam', category: 'capture' },
  { name: 'action.exe', label: 'Action! 录屏', category: 'capture' },
  { name: 'camtasiarecorder.exe', label: 'Camtasia 录制器', category: 'capture' },
  { name: 'xsplit.core.exe', label: 'XSplit', category: 'capture' },
  { name: 'sharex.exe', label: 'ShareX', category: 'capture' },
  { name: 'evcapture.exe', label: 'EV 录屏', category: 'capture' },
  { name: 'screenrecorder.exe', label: '屏幕录制工具', category: 'capture' },

  // —— 远程控制（对方能看到屏幕、通常还能操作）——
  { name: 'sunloginclient.exe', label: '向日葵远程控制', category: 'remote' },
  { name: 'todesk.exe', label: 'ToDesk 远程控制', category: 'remote' },
  { name: 'anydesk.exe', label: 'AnyDesk', category: 'remote' },
  { name: 'rustdesk.exe', label: 'RustDesk', category: 'remote' },
  { name: 'teamviewer.exe', label: 'TeamViewer', category: 'remote' },
  { name: 'winvnc4.exe', label: 'UltraVNC', category: 'remote' },
  { name: 'vncserver.exe', label: 'VNC Server', category: 'remote' },
  { name: 'mstsc.exe', label: '远程桌面连接（mstsc）', category: 'remote' },

  // —— 会议 / 共享屏幕 ——
  { name: 'wemeetapp.exe', label: '腾讯会议', category: 'meeting' },
  { name: 'zoom.exe', label: 'Zoom', category: 'meeting' },
  { name: 'ms-teams.exe', label: 'Microsoft Teams', category: 'meeting' },
  { name: 'teams.exe', label: 'Microsoft Teams（新版）', category: 'meeting' },
  { name: 'dingtalk.exe', label: '钉钉', category: 'meeting' },
  { name: 'feishu.exe', label: '飞书', category: 'meeting' },
  { name: 'voov.exe', label: 'VooV Meeting', category: 'meeting' },
  { name: 'webexmta.exe', label: 'Webex', category: 'meeting' },
];

/** 把 "C:\Program Files\OBS\obs64.exe" 或 "obs64.exe" 归一到小写文件名 */
function normalizeProcessName(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  const cut = text.split(/[\\/]/).pop() || '';
  return cut.trim().toLowerCase();
}

/** 进程名单 → 命中的风险程序（去重、按名单顺序、带中文标签与类别） */
function classifyProcesses(names) {
  const input = Array.isArray(names) ? names : [];
  const seen = new Set();
  const hits = [];

  for (const item of input) {
    const name = normalizeProcessName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const known = SCREEN_WATCH_PROCESSES.find((proc) => proc.name === name);
    if (!known) continue;
    hits.push({
      name: known.name,
      label: known.label,
      category: known.category,
      categoryLabel: CATEGORY_LABELS[known.category] || known.category,
    });
  }

  const byCategory = {};
  for (const hit of hits) {
    byCategory[hit.category] = (byCategory[hit.category] || 0) + 1;
  }

  return { hits, byCategory, note: describeHits(hits) };
}

/** 命中清单的一句话描述 */
function describeHits(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return '没有命中任何已知的录屏 / 远控程序';
  return hits.map((hit) => `${hit.label}（${hit.categoryLabel}）`).join('、');
}

/**
 * 判读检测结果。
 *
 * @param {{state?: string, names?: string[], error?: string, checkedAt?: number|string}} raw
 *   state: 'ok'（成功读到进程列表）| 'error'（读不到，例如进程查询被策略拦下）
 * @returns {{level:'none'|'risk'|'unknown', canEnterPrivate:boolean, requireAck:boolean,
 *   hits:Array, title:string, summary:string, message:string, checkedAt:any}}
 */
function describeScreenWatch(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const checkedAt = input.checkedAt || null;
  const state = String(input.state || '').toLowerCase();

  if (state === 'error' || state === 'unknown') {
    const reason = String(input.error || '').trim() || '读不到进程列表';
    return {
      level: 'unknown',
      canEnterPrivate: false,
      requireAck: true,
      hits: [],
      title: '无法确认当前是否在录屏',
      summary: `检测没能完成：${reason}`,
      message:
        `检测没能完成（${reason}）。` +
        '隐私模式不会假装安全：它保护的是不落盘、不旁路，保护不了"屏幕正被别人看见"。' +
        '可以继续进入，但你需要自己确认当前没有在录屏、共享屏幕或被远控。',
      checkedAt,
    };
  }

  if (state !== 'ok') {
    return {
      level: 'unknown',
      canEnterPrivate: false,
      requireAck: true,
      hits: [],
      title: '还没有检测过',
      summary: '还没有读取过进程列表',
      message: '进入隐私模式前会先检查一次；你也可以在「设置 → 隐私与安全」里手动点「现在检查」。',
      checkedAt,
    };
  }

  const result = classifyProcesses(input.names);
  if (result.hits.length === 0) {
    return {
      level: 'none',
      canEnterPrivate: true,
      requireAck: false,
      hits: [],
      title: '没有检测到录屏或远程控制程序',
      summary: result.note,
      message: '可以正常进入隐私模式。注意：这只说明没有已知录屏程序在跑，不代表绝对不会被拍到屏幕。',
      checkedAt,
    };
  }

  return {
    level: 'risk',
    canEnterPrivate: false,
    requireAck: false,
    hits: result.hits,
    title: '检测到可能正在录屏或被远控，已拒绝进入隐私模式',
    summary: result.note,
    message:
      `当前有 ${result.hits.length} 个程序可能正在看你的屏幕：${result.note}。` +
      '隐私模式保护的是"不落盘、不旁路"，保护不了"屏幕正被别人看见"，所以这次切换被拒绝了。' +
      '请先关闭上面这些程序（或退出共享屏幕），再重新切换。',
    checkedAt,
  };
}

/**
 * 是否允许进入隐私模式：none 直接过；unknown 需要用户显式确认；risk 一律拒绝。
 *
 * @param {{level?:string}} result describeScreenWatch 的返回值
 * @param {{ack?: boolean, ackAt?: number|null, maxAgeMs?: number}} [options]
 */
function canEnterPrivate(result, options) {
  const verdict = result && typeof result === 'object' ? result : {};
  const opts = options && typeof options === 'object' ? options : {};
  if (verdict.level === 'none') return { ok: true, reason: 'no-risk' };
  if (verdict.level === 'risk') return { ok: false, reason: 'screen-capture-active' };
  if (verdict.level !== 'unknown') return { ok: false, reason: 'not-checked' };
  if (!opts.ack) return { ok: false, reason: 'need-ack' };

  // 确认有时效：超过 10 分钟要重新确认，避免"很久以前点过一次"变成永久放行
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? Number(opts.maxAgeMs) : 10 * 60 * 1000;
  const ackAt = Number(opts.ackAt);
  if (!Number.isFinite(ackAt) || ackAt <= 0) return { ok: false, reason: 'need-ack' };
  if (Date.now() - ackAt > maxAgeMs) return { ok: false, reason: 'ack-stale' };
  return { ok: true, reason: 'acknowledged' };
}

/** 下发给界面的载荷 */
function screenWatchPayload(raw) {
  const result = describeScreenWatch(raw);
  const categories = Object.keys(CATEGORY_LABELS).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    count: result.hits.filter((hit) => hit.category === key).length,
  }));
  return {
    ok: true,
    level: result.level,
    canEnterPrivate: result.canEnterPrivate,
    requireAck: result.requireAck,
    title: result.title,
    summary: result.summary,
    message: result.message,
    checkedAt: result.checkedAt,
    hits: result.hits,
    categories: categories.filter((item) => item.count > 0),
    watched: SCREEN_WATCH_PROCESSES.length,
  };
}

module.exports = {
  CATEGORY_LABELS,
  SCREEN_WATCH_PROCESSES,
  canEnterPrivate,
  classifyProcesses,
  describeScreenWatch,
  normalizeProcessName,
  screenWatchPayload,
};
