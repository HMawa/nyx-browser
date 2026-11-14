'use strict';

/**
 * 断网判定与断网横幅（清单 G 的「离线/在线」部分）回归，纯 Node，不启动 Electron。
 *
 * 测什么：`src/core/network-state.js` 的说法与 `link-guard` 的 offline 分支。
 *
 * 为什么必须钉死：
 *   1. 断网时如果把"代理不可达"当成"代理坏了"，普通模式会把链路改成直连，
 *      网络恢复后就变成"明明是代理模式却在直连"——用户完全不知情。
 *   2. 反过来读不到在线状态就喊"断网"，会把真正的代理故障掩盖掉。
 *   两种错都比"不提示"更糟，所以正反两个方向都要断言。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { describeNetworkState, networkStatePayload } = require(path.join(ROOT, 'src', 'core', 'network-state.js'));
const { ACTIONS, decideProxyFailureAction } = require(path.join(ROOT, 'src', 'core', 'link-guard.js'));

const results = [];
/**
 * 这一份用「没抛异常就算通过」的语义：断言全在 expect()/expectTrue() 里，
 * 抛出来就是失败，避免再写一次 ok 标记（写两处容易忘一处，结果全红）。
 */
function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = true;
    if (out && typeof out === 'object' && out.detail !== undefined) detail = String(out.detail);
  } catch (err) {
    detail = err && err.message ? err.message : String(err);
  }
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? `｜${detail}` : ''}`);
}
function expect(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function expectTrue(value, what) {
  if (!value) throw new Error(`${what}：期望为真，实际 ${JSON.stringify(value)}`);
}

console.log('[断网判定] 开始');

check('1. 有网时不显示横幅；读不到在线状态也算有网（不许把代理故障说成断网）', () => {
  expect(describeNetworkState({ online: true, mode: 'normal' }).visible, false, '有网');
  expect(describeNetworkState({ online: undefined, mode: 'private' }).visible, false, '读不到');
  expect(describeNetworkState({}).visible, false, '空入参');
  return { detail: '三种情况都不显示' };
});

check('2. 断网 + 普通模式：说明是断网，并讲清链路不会被改成直连', () => {
  const state = describeNetworkState({ online: false, mode: 'normal', link: 'proxy' });
  expect(state.visible, true, '要显示');
  expect(state.level, 'warn', '级别');
  expectTrue(state.text.includes('当前离线'), '文案含"当前离线"');
  expectTrue(state.title.includes('不是代理坏了'), '要说清不是代理坏了');
  expectTrue(state.title.includes('不会被改成直连'), '要承诺链路不动');
  return { detail: state.text };
});

check('3. 断网 + 隐私模式：明确"保持代理、不降级"，并指路「重试」', () => {
  const state = describeNetworkState({ online: false, mode: 'private', link: 'proxy' });
  expect(state.visible, true, '要显示');
  expectTrue(state.text.includes('隐私模式保持代理'), '文案要点明保持代理');
  expectTrue(state.title.includes('不会因此降级为直连'), '隐私承诺');
  expectTrue(state.title.includes('重试'), '给下一步');
  return { detail: state.text };
});

check('4. 断网文案会区分当前链路是代理还是直连（不硬说"代理不可达"）', () => {
  const direct = describeNetworkState({ online: false, mode: 'normal', link: 'direct' });
  expectTrue(direct.text.includes('直连'), '直连链路要点明');
  const proxy = describeNetworkState({ online: false, mode: 'normal', link: 'smart' });
  expectTrue(proxy.text.includes('代理'), 'smart 也算代理链路');
  return { detail: `${direct.text} / ${proxy.text}` };
});

check('5. 给界面的载荷字段齐全，且 ok 恒为真（断网不是"失败"）', () => {
  const payload = networkStatePayload({ online: false, mode: 'private', link: 'proxy' });
  expect(payload.ok, true, 'ok');
  expect(payload.visible, true, 'visible');
  expect(payload.mode, 'private', 'mode');
  expect(payload.link, 'proxy', 'link');
  expectTrue(typeof payload.checkedAt === 'number' && payload.checkedAt > 0, 'checkedAt');
  return { detail: `${payload.text}｜${payload.level}` };
});

check('6. 脏入参不炸：模式/链路缺省按普通模式 + 直连处理', () => {
  const state = describeNetworkState(null);
  expect(state.visible, false, 'null 视为有网');
  const offline = describeNetworkState({ online: false, mode: 'nonsense', link: 'nonsense' });
  expect(offline.visible, true, '断网仍要显示');
  return { detail: offline.text };
});

check('7. 链路判定：断网时两种模式都不许转直连（offline 动作优先于 fallback）', () => {
  const normal = decideProxyFailureAction({
    mode: 'normal',
    link: 'proxy',
    reachable: false,
    errorCode: -102,
    online: false,
  });
  expect(normal.action, ACTIONS.offline, '普通模式断网');
  const priv = decideProxyFailureAction({
    mode: 'private',
    link: 'proxy',
    reachable: false,
    errorCode: -102,
    online: false,
  });
  expect(priv.action, ACTIONS.offline, '隐私模式断网');
  expectTrue(normal.notice && normal.notice.code === 'NETWORK_OFFLINE', '通知码');
  return { detail: `${normal.action}｜${normal.reason}` };
});

check('8. 有网时断网分支不抢戏：仍然按原规则判（普通降级、隐私只告知）', () => {
  const base = { link: 'proxy', reachable: false, errorCode: -102, online: true };
  expect(decideProxyFailureAction({ ...base, mode: 'normal' }).action, ACTIONS.fallbackDirect, '普通模式');
  expect(decideProxyFailureAction({ ...base, mode: 'private' }).action, ACTIONS.notifyPrivate, '隐私模式');
  return { detail: 'online=true 时规则不变' };
});

check('9. 静态守卫：主进程把在线状态喂给判定，并留痕 + 通知', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  expectTrue(main.includes('function onlineState('), '要有 onlineState()');
  expectTrue(main.includes('online,'), '判定要带 online');
  expectTrue(main.includes("diagnostics.warn('NETWORK_OFFLINE'"), '要留诊断');
  expectTrue(main.includes('LINK_GUARD_ACTIONS.offline'), '要处理 offline 分支');
  expectTrue(main.includes("ipcMain.handle('nyx:net:state'"), '要有状态通道');
  return { detail: 'main.js 五处都在' };
});

check('10. 静态守卫：外壳有横幅、渲染层只按载荷渲染（不自己猜 navigator.onLine）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  expectTrue(html.includes('id="net-offline-flag"'), 'index.html 要有横幅');
  expectTrue(html.includes('role="status"'), '横幅要可被读屏播报');
  expectTrue(js.includes('function applyNetState('), '渲染层要有 applyNetState');
  expectTrue(js.includes('function refreshNetState('), '渲染层要有 refreshNetState');
  expectTrue(js.includes("addEventListener('offline'"), '要听 offline');
  expectTrue(js.includes("addEventListener('online'"), '要听 online');
  expectTrue(preload.includes("invoke('nyx:net:state')"), 'preload 要暴露 netState');
  return { detail: '横幅 + 渲染 + 订阅齐全' };
});

const failed = results.filter((item) => !item.ok).length;
console.log(`\n[断网判定] 共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('[断网判定] 失败项：');
  results.filter((item) => !item.ok).forEach((item) => console.log(`  ✘ ${item.label}｜${item.detail}`));
  process.exitCode = 1;
} else {
  console.log('[断网判定] 全部通过：断网只提示、不改链路，说法与界面一致。');
}
