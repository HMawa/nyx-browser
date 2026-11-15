'use strict';

/**
 * 更新源的准入与版本单调（安全审计 P0-2，第一阶段）
 *
 * 审计指出的问题：`nyx:update:set-source` 什么地址都收（http、本地盘、UNC），
 * 而更新器拿到清单后会去装那个 exe。真实世界里"能改更新源的人"本来就该被当成
 * 能装任意程序的人，所以这里给三条硬规矩：
 *   1. 只允许 https；http 明文一律拒绝（能塞一个假清单的东西，不该只有 https）；
 *   2. 本地目录 / UNC 只在用户显式确认后允许（开发与离线分发要用，但必须说清代价）；
 *   3. 清单版本必须比当前版本新；同版本或降级一律拒绝并说明原因。
 *
 * 判定写成纯函数：主进程只负责调用、记日志、回中文原因，行为可断言。
 */

const LOCAL_ACK_CODE = 'NEEDS_LOCAL_ACK';
const LOCAL_ACK_HINT = '这是本地目录更新源：任何能写这个目录的程序都能换掉升级包，我只在这一台机器上认这个源？';

function parseVersion(raw) {
  const text = String(raw == null ? '' : raw).trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), tag: m[4] || '' };
}

/** 返回 -1 / 0 / 1；解析不了的一律返回 null（调用方必须当"不可比"处理，不许猜） */
function compareVersion(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  // 正式版 > 预发布版（1.17.9 > 1.17.9-beta.1），两者都空则相等
  if (left.tag === right.tag) return 0;
  if (!left.tag) return 1;
  if (!right.tag) return -1;
  return left.tag > right.tag ? 1 : -1;
}

/**
 * 更新源准入。
 * @param {string} raw 用户填的地址
 * @param {{allowLocal?: boolean}} options 是否已就本地目录的风险做过显式确认
 */
function decideUpdateSource(raw, options) {
  const text = String(raw == null ? '' : raw).trim();
  const allowLocal = Boolean(options && options.allowLocal);
  if (!text) {
    return { ok: false, code: 'EMPTY', kind: 'empty', error: '更新源不能为空' };
  }
  if (/^https:\/\//i.test(text)) {
    return { ok: true, code: 'HTTPS', kind: 'https', source: text, needsLocalAck: false };
  }
  if (/^http:\/\//i.test(text)) {
    return {
      ok: false,
      code: 'INSECURE_HTTP',
      kind: 'http',
      error: '不支持 http 明文更新源：升级包会在路上被人替换，换成 https 地址。',
    };
  }
  const isFileUrl = /^file:\/\//i.test(text);
  const isDrive = /^[a-zA-Z]:[\\/]/.test(text);
  const isUnc = text.startsWith('\\\\');
  if (isFileUrl || isDrive || isUnc) {
    if (!allowLocal) {
      return {
        ok: false,
        code: LOCAL_ACK_CODE,
        kind: 'local',
        needsLocalAck: true,
        error: LOCAL_ACK_HINT,
      };
    }
    return { ok: true, code: 'LOCAL', kind: 'local', source: text, needsLocalAck: false };
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_SCHEME',
    kind: 'other',
    error: '更新源必须是 https 地址，或本地目录路径（本地目录需要显式确认）。',
  };
}

/**
 * 本次更新是否该装。
 * @param {{current?: string, next?: string, mandatory?: boolean}} input
 */
function decideUpdateVersion(input) {
  const current = String((input && input.current) || '').trim();
  const next = String((input && input.next) || '').trim();
  if (!next) {
    return { ok: false, code: 'NO_VERSION', error: '更新清单里没有版本号，没法判断该不该装。' };
  }
  if (!parseVersion(next)) {
    return { ok: false, code: 'BAD_VERSION', error: `更新清单的版本号「${next}」读不懂，已拒绝。` };
  }
  if (!current || !parseVersion(current)) {
    // 当前版本读不出来时不当成"可以装"：升级是破坏性动作，宁可不动
    return {
      ok: false,
      code: 'CURRENT_UNKNOWN',
      error: '读不出当前版本号，为了安全暂时不做更新（可在「关于与更新」里查看当前版本）。',
    };
  }
  const cmp = compareVersion(next, current);
  if (cmp === 0) {
    return { ok: false, code: 'SAME_VERSION', error: `更新源里的版本和现在一样（${current}），不用更新。` };
  }
  if (cmp < 0) {
    // 降级只允许手动；自动更新里出现降级通常是源被换过
    return {
      ok: false,
      code: 'DOWNGRADE',
      error: `更新源里的版本（${next}）比当前版本（${current}）还旧，已拒绝自动降级。`,
    };
  }
  return { ok: true, code: 'NEWER', from: current, to: next };
}

module.exports = {
  LOCAL_ACK_CODE,
  LOCAL_ACK_HINT,
  compareVersion,
  decideUpdateSource,
  decideUpdateVersion,
  parseVersion,
};
