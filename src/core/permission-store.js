'use strict';

/**
 * 站点设备权限白名单（纯逻辑，不依赖 Electron）。
 *
 * 设计口径：
 *  - 只把「站点 → 允许的设备」写进白名单；一次授权只覆盖这次真正申请的权限项。
 *  - media 会按 details.mediaTypes 拆成 camera / microphone，避免「允许摄像头」
 *    顺手把麦克风也永久放行。
 *  - 来源只收 http(s)；file:、null、扩展页 origin 一律不写白名单（失败关闭）。
 *  - 文件损坏时返回空名单 + 明确错误，绝不把「读不懂」当成「全部允许」。
 */

const STORE_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_KEYS = 8;

/** 设备类权限的中文名（其余权限沿用 permissions.js 的标签） */
const DEVICE_LABELS = Object.freeze({
  camera: '摄像头',
  microphone: '麦克风',
  screen: '屏幕共享',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把站点来源收敛成 origin；只接受 http(s) */
function normalizeOrigin(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** 一次请求实际覆盖的权限项（白名单按这些键逐项判断） */
function canonicalKeys(permission, mediaTypes) {
  const name = String(permission || '').toLowerCase();
  if (name === 'media') {
    const types = Array.isArray(mediaTypes)
      ? mediaTypes.map((item) => String(item).toLowerCase())
      : [];
    const keys = [];
    if (types.includes('audio')) keys.push('microphone');
    if (types.includes('video')) keys.push('camera');
    if (!keys.length) keys.push('camera', 'microphone');
    return keys;
  }
  if (name === 'audiocapture') return ['microphone'];
  if (name === 'videocapture') return ['camera'];
  if (name === 'displaycapture' || name === 'display-capture') return ['screen'];
  return [name];
}

function sanitizeKey(key) {
  const text = String(key || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(text) ? text : '';
}

function sanitizeEntry(entry) {
  const origin = normalizeOrigin(entry && entry.origin);
  if (!origin) return null;
  const keys = [];
  const source = entry && Array.isArray(entry.keys) ? entry.keys : [];
  for (const item of source) {
    const key = sanitizeKey(item);
    if (key && !keys.includes(key)) keys.push(key);
    if (keys.length >= MAX_KEYS) break;
  }
  if (!keys.length) return null;
  const at = Number(entry && entry.at);
  return { origin, keys, at: Number.isFinite(at) && at > 0 ? at : Date.now() };
}

/** 同一来源合并，后写入的时间更新 */
function mergeEntry(entries, entry) {
  const list = entries.slice();
  const index = list.findIndex((item) => item.origin === entry.origin);
  if (index === -1) {
    list.push(entry);
  } else {
    const merged = Array.from(new Set(list[index].keys.concat(entry.keys))).slice(0, MAX_KEYS);
    list[index] = { origin: entry.origin, keys: merged, at: entry.at };
  }
  list.sort((a, b) => b.at - a.at);
  return list.slice(0, MAX_ENTRIES);
}

/**
 * 解析白名单文件。
 * @returns {{entries: Array, error: string}}
 */
function parseWhitelist(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { entries: [], error: '' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], error: '名单文件不是合法 JSON，已按空白名单启动' };
  }
  const raw = isPlainObject(data) && Array.isArray(data.entries)
    ? data.entries
    : Array.isArray(data)
      ? data
      : null;
  if (!raw) {
    return { entries: [], error: '名单文件结构不认识，已按空白名单启动' };
  }
  let entries = [];
  let rejected = 0;
  for (const item of raw) {
    const entry = sanitizeEntry(item);
    if (!entry) {
      rejected += 1;
      continue;
    }
    entries = mergeEntry(entries, entry);
  }
  const error = rejected > 0 ? `名单里有 ${rejected} 条记录读不懂，已忽略` : '';
  return { entries, error };
}

function serializeWhitelist(entries) {
  const safe = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    const entry = sanitizeEntry(item);
    if (entry) safe.push(entry);
    if (safe.length >= MAX_ENTRIES) break;
  }
  return `${JSON.stringify({ v: STORE_VERSION, entries: safe }, null, 2)}\n`;
}

/** 授权：同一来源的权限项取并集 */
function grantWhitelist(entries, origin, keys, at) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return entries.slice();
  const list = [];
  for (const item of Array.isArray(keys) ? keys : []) {
    const key = sanitizeKey(item);
    if (key && !list.includes(key)) list.push(key);
    if (list.length >= MAX_KEYS) break;
  }
  if (!list.length) return entries.slice();
  return mergeEntry(entries, {
    origin: normalized,
    keys: list,
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  });
}

/** 撤销某个来源的某个权限；不给 key 表示撤销整个来源 */
function revokeWhitelist(entries, origin, key) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return entries.slice();
  const wanted = sanitizeKey(key);
  const next = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    if (!item || item.origin !== normalized) {
      next.push(item);
      continue;
    }
    if (!wanted) continue;
    const keys = item.keys.filter((itemKey) => itemKey !== wanted);
    if (keys.length) next.push({ origin: item.origin, keys, at: item.at });
  }
  return next;
}

/** 白名单是否覆盖这次请求的全部权限项 */
function isWhitelisted(entries, origin, keys) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const entry = (Array.isArray(entries) ? entries : []).find((item) => item && item.origin === normalized);
  if (!entry) return false;
  const wanted = (Array.isArray(keys) ? keys : [])
    .map(sanitizeKey)
    .filter(Boolean);
  if (!wanted.length) return false;
  return wanted.every((key) => entry.keys.includes(key));
}

/** 给界面用的只读列表（时间倒序） */
function listWhitelist(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((item) => item && item.origin && Array.isArray(item.keys) && item.keys.length)
    .map((item) => ({
      origin: item.origin,
      keys: item.keys.slice(),
      at: item.at,
      labels: item.keys.map((key) => DEVICE_LABELS[key] || key),
    }))
    .sort((a, b) => b.at - a.at);
}

function summarizeWhitelist(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const keys = new Set();
  for (const item of list) {
    for (const key of item.keys || []) keys.add(key);
  }
  return { sites: list.length, kinds: keys.size };
}

module.exports = {
  STORE_VERSION,
  MAX_ENTRIES,
  DEVICE_LABELS,
  normalizeOrigin,
  canonicalKeys,
  parseWhitelist,
  serializeWhitelist,
  grantWhitelist,
  revokeWhitelist,
  isWhitelisted,
  listWhitelist,
  summarizeWhitelist,
};
