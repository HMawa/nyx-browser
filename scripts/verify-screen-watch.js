'use strict';

/**
 * 录屏 / 被远控检测回归（清单 C4，14 项断言，纯 Node，不启动 Electron）。
 *
 * 测什么：`src/core/screen-watch.js` 的名字归一、名单命中、三种判读（未发现 / 有风险 / 无法确认），
 * 以及"能不能进隐私模式"的闸门逻辑；再对 `src/main.js` 的接线做静态守卫。
 *
 * 为什么不端到端跑：真去检测需要"机器上正在跑录屏软件"这种环境，不能靠测试进程假装；
 * 所以判据做成纯函数直接喂数据，接线用静态守卫卡住位置（必须在拉起代理内核之前拦）。
 * 界面渲染由 `verify-ui-polish.js` 覆盖。
 *
 * 用法：node scripts/verify-screen-watch.js
 *
 * 零第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  CATEGORY_LABELS,
  SCREEN_WATCH_PROCESSES,
  canEnterPrivate,
  classifyProcesses,
  describeScreenWatch,
  normalizeProcessName,
  screenWatchPayload,
} = require(path.join(ROOT, 'src', 'core', 'screen-watch.js'));

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

// 常见进程名，测试里当"机器上跑着这些"
const RUNNING = [
  'System',
  'explorer.exe',
  'chrome.exe',
  'OBS64.EXE',
  'C:\\Program Files\\Oray\\SunLogin\\SunloginClient.exe',
  'wemeetapp.exe',
];

check('1. 名单齐全：每个程序都有名字、中文标签、已知类别', () => {
  const bad = SCREEN_WATCH_PROCESSES.filter(
    (item) =>
      !item ||
      typeof item.name !== 'string' ||
      item.name.length < 4 ||
      item.name !== item.name.toLowerCase() ||
      typeof item.label !== 'string' ||
      item.label.length < 2 ||
      !Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, item.category),
  );
  const cats = new Set(SCREEN_WATCH_PROCESSES.map((item) => item.category));
  return {
    ok: bad.length === 0 && SCREEN_WATCH_PROCESSES.length >= 15 && cats.size === 3,
    detail: { 数量: SCREEN_WATCH_PROCESSES.length, 类别: [...cats], 不合法: bad },
  };
});

check('2. 进程名归一：去掉路径、统一小写、空值不出错', () => {
  const a = normalizeProcessName('C:\\Program Files\\OBS\\obs64.exe');
  const b = normalizeProcessName('  Todesk.EXE  ');
  const c = normalizeProcessName('');
  const d = normalizeProcessName(null);
  const e = normalizeProcessName('/usr/local/bin/rustdesk');
  return {
    ok: a === 'obs64.exe' && b === 'todesk.exe' && c === '' && d === '' && e === 'rustdesk',
    detail: { a, b, c, d, e },
  };
});

check('3. 命中判读：录屏 + 远控 + 会议各自归类，无关进程不误报', () => {
  const result = classifyProcesses(RUNNING);
  const cats = result.hits.map((hit) => hit.category).sort();
  return {
    ok:
      result.hits.length === 3 &&
      cats.join(',') === 'capture,meeting,remote' &&
      result.hits.every((hit) => hit.categoryLabel && hit.categoryLabel.length > 0),
    detail: { 命中: result.hits.map((hit) => `${hit.label}/${hit.category}`), note: result.note },
  };
});

check('4. 大小写与完整路径都能命中（用户从任务管理器看到的名字不一定规范）', () => {
  const upper = classifyProcesses(['AnyDesk.EXE']);
  const fullPath = classifyProcesses(['D:\\Tools\\ToDesk\\ToDesk.exe']);
  return {
    ok: upper.hits.length === 1 && upper.hits[0].name === 'anydesk.exe' && fullPath.hits.length === 1 && fullPath.hits[0].name === 'todesk.exe',
    detail: { upper: upper.hits, fullPath: fullPath.hits },
  };
});

check('5. 同一个程序在列表里出现多次只报一条（父进程 + 子进程很常见）', () => {
  const result = classifyProcesses(['obs64.exe', 'OBS64.exe', 'C:\\x\\obs64.exe']);
  return { ok: result.hits.length === 1, detail: { 命中: result.hits.length } };
});

check('6. 没有命中 → 允许进入，但话里不许说"绝对安全"', () => {
  const verdict = describeScreenWatch({ state: 'ok', names: ['explorer.exe', 'chrome.exe'], checkedAt: 1 });
  return {
    ok:
      verdict.level === 'none' &&
      verdict.canEnterPrivate === true &&
      verdict.requireAck === false &&
      verdict.hits.length === 0 &&
      /不代表绝对/.test(verdict.message),
    detail: { level: verdict.level, message: verdict.message },
  };
});

check('7. 有命中 → 拒绝进入，并把"保护不了屏幕"讲清楚', () => {
  const verdict = describeScreenWatch({ state: 'ok', names: RUNNING, checkedAt: 1 });
  return {
    ok:
      verdict.level === 'risk' &&
      verdict.canEnterPrivate === false &&
      verdict.hits.length === 3 &&
      /OBS Studio/.test(verdict.message) &&
      /保护不了/.test(verdict.message) &&
      /先关闭/.test(verdict.message),
    detail: { level: verdict.level, summary: verdict.summary },
  };
});

check('8. 读不到进程列表 → 是"无法确认"，不是"没有风险"，且要求显式确认', () => {
  const verdict = describeScreenWatch({ state: 'error', error: '进程查询被策略拦下', checkedAt: 1 });
  return {
    ok:
      verdict.level === 'unknown' &&
      verdict.canEnterPrivate === false &&
      verdict.requireAck === true &&
      /无法确认/.test(verdict.title) &&
      /不会假装安全/.test(verdict.message) &&
      /进程查询被策略拦下/.test(verdict.message),
    detail: { level: verdict.level, title: verdict.title },
  };
});

check('9. 还没检测过 → 也是"无法确认"，不默认放行', () => {
  const verdict = describeScreenWatch({});
  return { ok: verdict.level === 'unknown' && verdict.canEnterPrivate === false && /还没有检测过/.test(verdict.title), detail: { title: verdict.title } };
});

check('10. 闸门：未发现直接过；有风险连"我确认"也不放行', () => {
  const none = canEnterPrivate({ level: 'none' }, {});
  const risk = canEnterPrivate({ level: 'risk' }, { ack: true, ackAt: Date.now() });
  return {
    ok: none.ok === true && none.reason === 'no-risk' && risk.ok === false && risk.reason === 'screen-capture-active',
    detail: { none, risk },
  };
});

check('11. 闸门：无法确认时必须确认过才放行，且确认会过期', () => {
  const noAck = canEnterPrivate({ level: 'unknown' }, {});
  const fresh = canEnterPrivate({ level: 'unknown' }, { ack: true, ackAt: Date.now() });
  const stale = canEnterPrivate({ level: 'unknown' }, { ack: true, ackAt: Date.now() - 11 * 60 * 1000 });
  return {
    ok:
      noAck.ok === false &&
      noAck.reason === 'need-ack' &&
      fresh.ok === true &&
      fresh.reason === 'acknowledged' &&
      stale.ok === false &&
      stale.reason === 'ack-stale',
    detail: { noAck: noAck.reason, fresh: fresh.reason, stale: stale.reason },
  };
});

check('12. 下发载荷：类别计数与实际命中一致，并带上监测名单规模', () => {
  const payload = screenWatchPayload({ state: 'ok', names: RUNNING, checkedAt: 1700000000000 });
  const total = payload.categories.reduce((sum, item) => sum + item.count, 0);
  return {
    ok:
      payload.ok === true &&
      payload.level === 'risk' &&
      payload.hits.length === 3 &&
      total === 3 &&
      payload.watched === SCREEN_WATCH_PROCESSES.length &&
      payload.checkedAt === 1700000000000,
    detail: { categories: payload.categories, watched: payload.watched },
  };
});

check('13. 远程桌面（mstsc）也算风险：它确实在看着你的屏幕', () => {
  const verdict = describeScreenWatch({ state: 'ok', names: ['mstsc.exe'], checkedAt: 1 });
  const hit = verdict.hits[0];
  return { ok: verdict.level === 'risk' && hit && hit.category === 'remote', detail: { hit } };
});

check('14. 静态守卫：闸门在拉起代理内核之前，且提示/诊断/preload/设置页都接上了', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');

  // switchMode 里"先看屏幕、再看代理"的顺序是这一条的核心要求
  const body = main.slice(main.indexOf('async function switchMode(mode)'));
  const switchBody = body.slice(0, body.indexOf('async function switchModeTracked'));
  const screenIdx = switchBody.indexOf('refreshScreenWatch');
  const kernelIdx = switchBody.indexOf('ensureProxyKernelForPrivate');
  const gateIdx = switchBody.indexOf('canEnterPrivate');

  // 闸门拦下时必须同时留下模式事件（"状态变化要让用户看得见"）
  const gateBlock = switchBody.slice(switchBody.indexOf('const screenGate'), switchBody.indexOf('wantRealIp'));
  const detail = {
    闸门位置: { screenIdx, kernelIdx, gateIdx },
    闸门在内核之前: screenIdx >= 0 && kernelIdx >= 0 && screenIdx < kernelIdx && gateIdx > screenIdx,
    两个IPC: main.includes("ipcMain.handle('nyx:screen:watch'") && main.includes("ipcMain.handle('nyx:screen:ack'"),
    诊断留痕: main.includes('SCREEN_CAPTURE_ACTIVE') && main.includes('SCREEN_WATCH_UNKNOWN'),
    模式事件: gateBlock.includes('modeEventLog.record') && gateBlock.includes("code: notice.code"),
    preload两方法: preload.includes('screenWatch:') && preload.includes('screenWatchAck:'),
    设置页卡片: html.includes('id="screen-watch-badge"') && html.includes('id="btn-screen-watch-check"'),
    设置页逻辑: settingsJs.includes('loadScreenWatch') && settingsJs.includes('renderScreenWatch'),
  };
  const ok =
    detail.闸门在内核之前 &&
    detail.两个IPC &&
    detail.诊断留痕 &&
    detail.模式事件 &&
    detail.preload两方法 &&
    detail.设置页卡片 &&
    detail.设置页逻辑;
  return { ok, detail };
});

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.error(`[Nyx] 录屏检测回归失败：${failed.length}/${results.length} 项未通过`);
  for (const item of failed) console.error(`         ✘ ${item.label}　｜${item.detail}`);
  process.exitCode = 1;
} else {
  console.log(`[Nyx] 录屏检测回归通过：${results.length}/${results.length} 项全绿`);
  process.exitCode = 0;
}
