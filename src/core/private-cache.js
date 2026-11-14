'use strict';

/**
 * 隐私模式的离线快照（用户第 2 项：隐私模式全加密隔离）。
 *
 * 这里的取舍要说清楚：
 * - 普通模式的快照还是明文（page-cache.json），用户看得到、能自己处理；
 * - 隐私模式的快照单独一个文件，**整条加密**（正文、标题、地址都在密文里），
 *   明面上只有「什么时候存过一条」和地址的哈希——这两个是为了去重与过期清理。
 *
 * 这个模块只做纯逻辑（不碰 crypto / safeStorage），加密本身在主进程做，
 * 这样断言可以直接跑、不用启动 Electron。
 */

const PRIVATE_CACHE_VERSION = 1;
const PRIVATE_CACHE_LIMIT = 20;
const PRIVATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PRIVATE_CACHE_TEXT_MAX = 4000;

/**
 * 能不能往隐私模式里写：只有系统密钥可用时才允许。
 *
 * 密钥不可用时绝不退化成明文——那样就是把「隐私模式」四个字变成了谎话。
 */
function pickPrivateStoreMode(options) {
  const input = options && typeof options === 'object' ? options : {};
  if (input.encryptionAvailable !== true) {
    return {
      ok: false,
      mode: 'off',
      reason: '系统密钥服务不可用（安全存储没准备好），隐私模式的快照不会被保存。',
    };
  }
  if (input.enabled === false) {
    return { ok: false, mode: 'off', reason: '隐私模式的离线快照已被你关掉。' };
  }
  return { ok: true, mode: 'encrypted', reason: '隐私模式的快照会整条加密后单独存放。' };
}

/** 地址只留哈希：既能当索引用，又不把「你看过什么」写在明面上 */
function hashUrl(url, hashFn) {
  const text = typeof url === 'string' ? url.trim() : '';
  if (!text) return '';
  if (typeof hashFn !== 'function') return '';
  return String(hashFn(text) || '').slice(0, 32);
}

function clampText(text) {
  const value = typeof text === 'string' ? text : '';
  return value.length > PRIVATE_CACHE_TEXT_MAX ? value.slice(0, PRIVATE_CACHE_TEXT_MAX) : value;
}

/**
 * 整理一条待加密的记录（此刻还是明文，交给主进程去加密）。
 * 返回 {ok, record} 或 {ok:false, reason}——太短的正文不存，理由和普通模式一致。
 */
function preparePrivateRecord(snapshot, options) {
  const input = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  const hashFn = options && typeof options.hash === 'function' ? options.hash : null;
  const hash = hashUrl(input.url, hashFn);
  if (!hash) return { ok: false, reason: '没有可用的地址，这一页不存快照。' };
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const text = clampText(
    typeof input.text === 'string'
      ? input.text
      : blocks
          .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n'),
  );
  if (text.replace(/\s+/g, '').length < 20) {
    return { ok: false, reason: '正文太短（不足 20 字），存下来也没什么可读的。' };
  }
  return {
    ok: true,
    record: {
      id: hash,
      at: now,
      hash,
      payload: {
        url: typeof input.url === 'string' ? input.url : '',
        title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
        text,
        blocks,
        at: now,
      },
    },
  };
}

/** 只留下形状正确的条目：坏数据当不存在，不让它把整份以 fs 崩溃 */
function normalizePrivateStore(raw, options) {
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(source.entries) ? source.entries : [];
  const entries = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const blob = typeof item.blob === 'string' ? item.blob : '';
    const hash = typeof item.hash === 'string' ? item.hash : '';
    const at = Number.isFinite(item.at) ? item.at : 0;
    if (!blob || !hash) continue;
    if (!at || now - at > PRIVATE_CACHE_TTL_MS) continue;
    if (seen.has(hash)) continue;
    seen.add(hash);
    entries.push({ id: hash, hash, at, blob });
  }
  entries.sort((a, b) => b.at - a.at);
  return {
    v: PRIVATE_CACHE_VERSION,
    entries: entries.slice(0, PRIVATE_CACHE_LIMIT),
  };
}

/** 写入一条（同地址覆盖），并做上限与过期清理 */
function putPrivateEntry(store, entry, options) {
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  const base = normalizePrivateStore(store, { now }).entries;
  const incoming = entry && typeof entry === 'object' ? entry : null;
  if (!incoming || !incoming.blob || !incoming.hash) {
    return { v: PRIVATE_CACHE_VERSION, entries: base, added: false };
  }
  const rest = base.filter((item) => item.hash !== incoming.hash);
  const entries = [{ id: incoming.hash, hash: incoming.hash, at: Number(incoming.at) || now, blob: incoming.blob }]
    .concat(rest)
    .slice(0, PRIVATE_CACHE_LIMIT);
  return { v: PRIVATE_CACHE_VERSION, entries, added: true };
}

function findPrivateEntry(store, hash, options) {
  if (!hash) return null;
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  const entries = normalizePrivateStore(store, { now }).entries;
  return entries.find((item) => item.hash === hash) || null;
}

/** 给界面看的说明：这条快照是加密的、什么时候存的、多久后过期 */
function describePrivateEntry(entry, options) {
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  if (!entry || !entry.blob) {
    return { available: false, note: '隐私模式这次没有可用的加密快照。' };
  }
  const ageMs = Math.max(0, now - (Number(entry.at) || now));
  const hours = Math.floor(ageMs / 3600000);
  const ageText = hours >= 1 ? `${hours} 小时前` : `${Math.max(1, Math.round(ageMs / 60000))} 分钟前`;
  return {
    available: true,
    encrypted: true,
    at: Number(entry.at) || 0,
    ageText,
    note: `隐私模式的快照整条加密存放（${ageText}），24 小时后自动作废；它只能在这台机器的这个账户下解开。`,
  };
}

function privateCacheStatus(store, options) {
  const now = options && Number.isFinite(options.now) ? options.now : Date.now();
  const entries = normalizePrivateStore(store, { now }).entries;
  return {
    ok: true,
    version: PRIVATE_CACHE_VERSION,
    count: entries.length,
    limit: PRIVATE_CACHE_LIMIT,
    ttlHours: PRIVATE_CACHE_TTL_MS / 3600000,
    encrypted: true,
    note: '隐私模式的快照整条加密，单独存放；普通模式的快照仍然是明文。',
  };
}

/**
 * 逐条试着解开，数出「解不开的」有几条。
 *
 * 为什么会解不开：换了系统账户、系统密钥被重置、或者文件被别的程序动过。
 * 解不开的条目留在盘上没有任何用处——它既不能显示，也永远不会自己好起来，
 * 所以必须能数出来、也必须能被清掉（否则用户只能删整个文件）。
 *
 * @param {object} store 磁盘上的原始结构
 * @param {{now?: number, decrypt?: (entry: object) => {ok: boolean}}} [options]
 *   decrypt 返回 {ok:true} 表示这条能解开；不传则视作全部可读（只数条数）。
 */
function inspectPrivateStore(store, options) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  const entries = normalizePrivateStore(store, { now }).entries;
  let readable = 0;
  let broken = 0;
  const detail = [];
  for (const entry of entries) {
    let ok = true;
    if (decrypt) {
      try {
        const result = decrypt(entry);
        ok = Boolean(result && result.ok === true);
      } catch {
        ok = false;
      }
    }
    if (ok) readable += 1;
    else broken += 1;
    detail.push({ hash: entry.hash, at: entry.at, ok });
  }
  return {
    ok: true,
    total: entries.length,
    readable,
    broken,
    entries: detail,
    note:
      broken > 0
        ? `有 ${broken} 条加密快照解不开（多半是换了系统账户或系统密钥变了）。它们既显示不出来，也不会自己恢复，可以一键清掉。`
        : '存下来的加密快照都能在这台机器的这个账户下解开。',
  };
}

/**
 * 只清掉解不开的条目，能解的留着。
 * 返回新的 store 与清掉的条数——界面要如实告诉用户"清了几条"。
 */
function dropBrokenEntries(store, options) {
  const opts = options || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  const entries = normalizePrivateStore(store, { now }).entries;
  const kept = [];
  let dropped = 0;
  for (const entry of entries) {
    let ok = true;
    if (decrypt) {
      try {
        const result = decrypt(entry);
        ok = Boolean(result && result.ok === true);
      } catch {
        ok = false;
      }
    }
    if (ok) kept.push(entry);
    else dropped += 1;
  }
  return {
    ok: true,
    before: entries.length,
    after: kept.length,
    dropped,
    store: { v: PRIVATE_CACHE_VERSION, entries: kept },
  };
}

module.exports = {
  PRIVATE_CACHE_LIMIT,
  PRIVATE_CACHE_TEXT_MAX,
  PRIVATE_CACHE_TTL_MS,
  PRIVATE_CACHE_VERSION,
  describePrivateEntry,
  dropBrokenEntries,
  findPrivateEntry,
  hashUrl,
  inspectPrivateStore,
  normalizePrivateStore,
  pickPrivateStoreMode,
  preparePrivateRecord,
  privateCacheStatus,
  putPrivateEntry,
};
