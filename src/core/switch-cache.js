/**
 * 模式切换的缓存与计时（纯逻辑，零 Electron、不读盘、不发请求）。
 *
 * 为什么要单独一个模块：切换模式原来每次都要重新问一遍"代理可达吗""出口是哪"，
 * 冷的时候要等好几秒（实测进入隐私模式约 8 秒）。这里把"什么时候可以复用上一次结论"
 * 这件事抽出来，规则写得看得见、可以被断言覆盖，主进程只负责把结果记进 runtime。
 *
 * 原则：
 *   - **可达性可以短暂复用**（30 秒）：代理刚探过又刚探一遍没有意义，但也不能太久——
 *     用户可能刚把代理关掉，30 秒内仍按"可达"处理是他自己承担的代价，日志会写清"复用"。
 *   - **"出口取不到"也要复用**（60 秒）：最贵的不是成功那一次，而是失败那一次——
 *     出口自查超时要等满 6 秒，连着切两次就是 12 秒。失败结论同样可以记一小段时间，
 *     过期后重试。成功的出口画像由 proxy-service 自己缓存（10 分钟），这里不重复。
 *   - 任何"复用"都必须能被讲出来：`describeTiming()` 会把每一步的耗时和是否复用拼成一句
 *     中文，写进日志与诊断，避免"快是快了但不知道为什么快"。
 */

/** 代理可达性结论的有效期 */
const PROXY_PROBE_TTL_MS = 30_000;

/** "出口自查取不到"这个结论的有效期 */
const EGRESS_UNKNOWN_TTL_MS = 60_000;

/**
 * 读一份带时间戳的缓存。
 *
 * @param {{at?:number, value?:any}|null|undefined} entry
 * @param {number} now
 * @param {number} ttlMs
 * @returns {{hit:boolean, value:any, ageMs:number}}
 */
function readTimed(entry, now, ttlMs) {
  const at = entry && Number(entry.at);
  const ttl = Number(ttlMs);
  const stamp = Number(now);
  if (!entry || !Number.isFinite(at) || at <= 0) return { hit: false, value: null, ageMs: 0 };
  if (!Number.isFinite(stamp) || stamp <= 0) return { hit: false, value: null, ageMs: 0 };
  if (!Number.isFinite(ttl) || ttl <= 0) return { hit: false, value: null, ageMs: 0 };
  const ageMs = stamp - at;
  // 时钟回拨（系统时间被改过）时按"过期"处理：宁可多探一次，也不要拿未来的戳当新鲜
  if (ageMs < 0) return { hit: false, value: null, ageMs: 0 };
  if (ageMs >= ttl) return { hit: false, value: null, ageMs };
  return { hit: true, value: entry.value === undefined ? null : entry.value, ageMs };
}

/**
 * 写一份带时间戳的缓存（返回新对象，不改入参）。
 *
 * @param {any} value
 * @param {number} now
 * @returns {{at:number, value:any}}
 */
function writeTimed(value, now) {
  const stamp = Number(now);
  return { at: Number.isFinite(stamp) && stamp > 0 ? stamp : 0, value };
}

/**
 * 把一段耗时换成中文（用于日志与前台提示）。
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

/**
 * 把切换过程拼成一句可读的话：每一步叫什么、多久、是否复用了缓存。
 *
 * @param {Array<{step:string, ms:number, reused?:boolean}>} steps
 * @param {number} totalMs
 * @returns {{text:string, totalMs:number, slowest:{step:string, ms:number}|null, reused:number}}
 */
function describeTiming(steps, totalMs) {
  const list = Array.isArray(steps) ? steps.filter((item) => item && item.step) : [];
  const total = Number.isFinite(Number(totalMs)) ? Math.max(0, Number(totalMs)) : 0;
  if (!list.length) {
    return { text: `本次切换用时 ${formatDuration(total)}（没有记录到分步耗时）`, totalMs: total, slowest: null, reused: 0 };
  }
  let slowest = null;
  let reused = 0;
  for (const item of list) {
    const ms = Number(item.ms) || 0;
    if (item.reused) reused += 1;
    if (!slowest || ms > slowest.ms) slowest = { step: String(item.step), ms };
  }
  const parts = list.map((item) => {
    const ms = Number(item.ms) || 0;
    return `${item.step} ${formatDuration(ms)}${item.reused ? '（复用缓存）' : ''}`;
  });
  return {
    text: `本次切换用时 ${formatDuration(total)}：${parts.join('，')}`,
    totalMs: total,
    slowest,
    reused,
  };
}

module.exports = {
  PROXY_PROBE_TTL_MS,
  EGRESS_UNKNOWN_TTL_MS,
  readTimed,
  writeTimed,
  formatDuration,
  describeTiming,
};
