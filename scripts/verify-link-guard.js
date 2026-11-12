'use strict';

/**
 * 出站链路守卫回归（12 项断言，纯 Node，不启动 Electron）。
 *
 * 测什么：`src/core/link-guard.js` 里的 `decideProxyFailureAction()`——
 * 一次可疑的加载失败之后到底该"不动 / 普通模式转直连 / 隐私模式只告知"。
 *
 * 为什么单独一个脚本：
 *   1. 这段判定是隐私承诺的最后一道理性闸门（隐私模式绝不降级），必须能被
 *      断言死；而走 CDP 测主进程状态机需要先能进隐私模式，测试环境里没有代理
 *      内核，根本进不去 —— 纯函数是唯一可测的形式。
 *   2. 顺带用静态断言锁住两处"防回归"代码：sessions 层拒绝隐私分区直连、
 *      主进程隐私分支必须留诊断记录；谁把它们删掉，这里立刻红。
 *
 * 用法：
 *   node scripts/verify-link-guard.js
 *
 * 零第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  ACTIONS,
  PROXY_FAILURE_CODES,
  isProxyFailureCode,
  decideProxyFailureAction,
} = require(path.join(ROOT, 'src', 'core', 'link-guard.js'));

/** 断言账本 */
const results = [];
function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = out === true || (out && out.ok === true);
    detail = out && typeof out === 'object' ? JSON.stringify(out.detail ?? out) : String(out);
  } catch (err) {
    ok = false;
    detail = `抛异常：${err.message}`;
  }
  results.push({ label, ok, detail });
  console.log(`${ok ? '[Nyx] ✔' : '[Nyx] ✘'} ${label}${detail ? `　｜${detail}` : ''}`);
}

/** 常用输入：隐私模式 + 走代理 + 代理不可达 */
function privateDown(extra = {}) {
  return { mode: 'private', link: 'proxy', reachable: false, errorCode: -130, host: '127.0.0.1', port: 7897, error: '连接被拒绝', ...extra };
}

/** 常用输入：普通模式 + 走代理 + 代理不可达 */
function normalDown(extra = {}) {
  return { mode: 'normal', link: 'proxy', reachable: false, errorCode: -130, host: '127.0.0.1', port: 7897, error: '连接被拒绝', ...extra };
}

console.log(`[Nyx] 链路守卫回归｜链路类错误码 ${PROXY_FAILURE_CODES.size} 个`);

check('1. 非链路类错误码不触发任何动作（-3 用户中止）', () => {
  const d = decideProxyFailureAction(normalDown({ errorCode: -3 }));
  return { ok: d.action === ACTIONS.none && d.reason === 'not-proxy-failure', detail: { action: d.action, reason: d.reason } };
});

check('2. 已经是直连时不重复动作', () => {
  const d = decideProxyFailureAction({ mode: 'normal', link: 'direct', reachable: false, errorCode: -130 });
  return { ok: d.action === ACTIONS.none && d.reason === 'link-is-direct', detail: { action: d.action, reason: d.reason } };
});

check('3. 隐私模式 + 代理仍可达 → 不动链路（属于站点问题）', () => {
  const d = decideProxyFailureAction(privateDown({ reachable: true }));
  return { ok: d.action === ACTIONS.none && d.notice === null, detail: { action: d.action, reason: d.reason } };
});

check('4. 隐私模式 + 代理不可达 → 只告知，绝不转直连', () => {
  const d = decideProxyFailureAction(privateDown());
  const n = d.notice || {};
  const ok =
    d.action === ACTIONS.notifyPrivate &&
    n.code === 'PRIVACY_PROXY_DOWN' &&
    n.level === 'error' &&
    typeof n.title === 'string' &&
    n.title.includes('未降级') &&
    typeof n.message === 'string' &&
    n.message.includes('不会降级为直连') &&
    n.message.includes('127.0.0.1:7897');
  return { ok, detail: { action: d.action, code: n.code, title: n.title } };
});

check('5. 隐私模式下所有链路类错误码都不会产生 fallback-direct', () => {
  const bad = [];
  for (const code of PROXY_FAILURE_CODES) {
    const d = decideProxyFailureAction(privateDown({ errorCode: code }));
    if (d.action !== ACTIONS.notifyPrivate) bad.push({ code, action: d.action });
  }
  return { ok: bad.length === 0, detail: { 逐码检查: PROXY_FAILURE_CODES.size, 异常: bad } };
});

check('6. 普通模式 + 代理仍可达 → 不动链路', () => {
  const d = decideProxyFailureAction(normalDown({ reachable: true }));
  return { ok: d.action === ACTIONS.none && d.reason === 'proxy-reachable', detail: { action: d.action } };
});

check('7. 普通模式 + 代理不可达 → 转直连并给出告知文案', () => {
  const d = decideProxyFailureAction(normalDown());
  const n = d.notice || {};
  const ok =
    d.action === ACTIONS.fallbackDirect &&
    n.code === 'PROXY_FALLBACK_DIRECT' &&
    n.level === 'warn' &&
    typeof n.message === 'string' &&
    n.message.includes('直连') &&
    n.message.includes('隐私模式');
  return { ok, detail: { action: d.action, code: n.code } };
});

check('8. 缺参/脏参不抛异常，一律按保守默认处理', () => {
  const cases = [undefined, null, {}, { mode: 'PRIVATE' }, { errorCode: '-130' }, { link: 'weird' }];
  const out = cases.map((input) => decideProxyFailureAction(input));
  const known = Object.values(ACTIONS);
  const ok = out.every((d) => d && known.includes(d.action));
  return { ok, detail: out.map((d) => d.action) };
});

check('9. isProxyFailureCode 只认数字码（字符串/空值一律 false）', () => {
  const table = { '-130': isProxyFailureCode(-130), '-3': isProxyFailureCode(-3), string: isProxyFailureCode('-130'), undef: isProxyFailureCode(undefined) };
  return { ok: table['-130'] === true && table['-3'] === false && table.string === false && table.undef === false, detail: table };
});

check('10. 静态守卫：sessions 层仍然硬拒绝"隐私分区置直连"', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'core', 'sessions.js'), 'utf8');
  const ok = text.includes('已拒绝把隐私分区置为直连') && /if \(key === 'private' && next === 'direct'\)/.test(text);
  return { ok, detail: { 命中: ok } };
});

check('11. 静态守卫：主进程隐私分支保留诊断留痕与链路判定', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const ok =
    text.includes("require('./core/link-guard')") &&
    text.includes('PRIVACY_PROXY_DOWN') &&
    !/if \(sessions\.getMode\(\) !== 'normal'\) return;\s*\n\s*const link = sessions\.getLink\('normal'\);/.test(text);
  return { ok, detail: { 命中: ok } };
});

check('12. 静态守卫：提示推送必须等外壳就绪（不许直接 send 丢掉）', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const ok = text.includes('flushPendingNotices') && /if \(!win \|\| win\.isDestroyed\(\) \|\| !runtime\.shellReady\)/.test(text);
  return { ok, detail: { 命中: ok } };
});

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.error(`[Nyx] 链路守卫回归失败：${failed.length}/${results.length} 项未通过`);
  for (const item of failed) console.error(`         ✘ ${item.label}　｜${item.detail}`);
  process.exitCode = 1;
} else {
  console.log(`[Nyx] 链路守卫回归通过：${results.length}/${results.length} 项全绿`);
  process.exitCode = 0;
}
