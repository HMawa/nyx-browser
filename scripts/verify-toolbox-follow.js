'use strict';

/**
 * 网络面板「跟随 / 锁定」与每标签 500 条上限（清单 A4，v1.17.9）回归。
 * 纯 Node，不启动 Electron。
 *
 * 为什么必须钉死：
 *   1. 抓包记录是按标签分开的，面板要么跟随、要么钉住。钉住的标签关掉后
 *      如果继续显示旧数据，用户会拿"已经不存在的页面的流量"当现在的结论。
 *   2. 500 条是内存口径。上限写错（比如界面侧还按 4000 裁）会让界面与主进程
 *      各留一份不同长度的列表，用户看到条数与"总数/丢弃数"对不上。
 *   3. "关闭工具箱必须释放监听"是清单 §4 的硬约束，只能靠静态守卫钉住。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const follow = require(path.join(ROOT, 'src', 'core', 'toolbox-follow.js'));

const results = [];
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

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('[网络面板跟随] 开始');

check('1. 默认是跟随：只有明确写 lock 才锁定，脏值一律当跟随', () => {
  expect(follow.normalizeFollowMode(undefined), 'follow', '未传');
  expect(follow.normalizeFollowMode(''), 'follow', '空串');
  expect(follow.normalizeFollowMode('lock'), 'lock', 'lock');
  expect(follow.normalizeFollowMode('LOCK'), 'follow', '大小写不认');
  expect(follow.normalizeFollowMode('locked'), 'follow', '近似词不认');
  return { detail: '只有 "lock" 生效' };
});

check('2. 跟随模式取当前活动标签；没有活动标签时不编一个 id 出来', () => {
  const withTab = follow.decideFollowTarget({ mode: 'follow', activeWcId: 12, liveWcIds: [11, 12] });
  expect(withTab.mode, 'follow', '模式');
  expect(withTab.wcId, 12, '目标');
  expect(withTab.fellBack, false, '不算回退');
  const empty = follow.decideFollowTarget({ mode: 'follow', activeWcId: null, liveWcIds: [] });
  expect(empty.wcId, null, '没有页面就是 null');
  return { detail: '12 / null' };
});

check('3. 锁定模式钉住那个标签：切到别的标签也不换数据', () => {
  const out = follow.decideFollowTarget({
    mode: 'lock',
    lockedWcId: 11,
    activeWcId: 12,
    liveWcIds: [11, 12],
  });
  expect(out.mode, 'lock', '模式');
  expect(out.wcId, 11, '要钉住 11，不是活动的 12');
  expect(out.fellBack, false, '标签还在，不算回退');
  return { detail: '锁 11、活动 12 → 仍看 11' };
});

check('4. 锁定的标签被关掉：如实回退到跟随，并给一句人话原因', () => {
  const out = follow.decideFollowTarget({
    mode: 'lock',
    lockedWcId: 11,
    activeWcId: 12,
    liveWcIds: [12],
  });
  expect(out.mode, 'follow', '回退成跟随');
  expect(out.wcId, 12, '看当前标签');
  expect(out.fellBack, true, '要标记回退过');
  expectTrue(out.reason.includes('已经关掉'), '原因要说清标签关掉了');
  expectTrue(out.reason.includes('跟随'), '原因要说明改成了跟随');
  expect(out.reason, follow.FOLLOW_FALLBACK_REASON, '原因文案统一');
  return { detail: out.reason };
});

check('5. 锁定但没有锁定目标（或读回来是脏值）：同样回退，不进入半锁状态', () => {
  const noId = follow.decideFollowTarget({ mode: 'lock', lockedWcId: null, activeWcId: 5, liveWcIds: [5] });
  expect(noId.fellBack, true, '没有目标要回退');
  expect(noId.wcId, 5, '看当前标签');
  const garbage = follow.decideFollowTarget({ mode: 'lock', lockedWcId: 'abc', activeWcId: 5, liveWcIds: [5] });
  expect(garbage.fellBack, true, '脏 id 要回退');
  return { detail: '两种半锁状态都被挡掉' };
});

check('6. 每标签 500 条：超出丢最旧的，并如实报出丢了多少', () => {
  expect(follow.RECORD_LIMIT, 500, '上限');
  const list = [];
  for (let i = 1; i <= 620; i += 1) list.push({ id: i });
  const out = follow.trimRecords(list, follow.RECORD_LIMIT);
  expect(out.records.length, 500, '留下 500 条');
  expect(out.dropped, 120, '丢掉 120 条');
  expect(out.records[0].id, 121, '留下的是最新的 500 条');
  expect(out.records[out.records.length - 1].id, 620, '最后一条是最新那条');
  return { detail: '620 → 500，丢 120' };
});

check('7. 没超上限时原样返回一份拷贝；空值/脏值不炸', () => {
  const small = [{ id: 1 }, { id: 2 }];
  const out = follow.trimRecords(small, 500);
  expect(out.records.length, 2, '条数不变');
  expect(out.dropped, 0, '没丢');
  expectTrue(out.records !== small, '要返回拷贝，别让界面直接改原数组');
  expect(follow.trimRecords(null, 500).records.length, 0, 'null 当空');
  expect(follow.trimRecords([{ id: 1 }], 0).records.length, 1, '上限写 0 时回默认上限，不把记录清空');
  return { detail: '拷贝 + 兜底' };
});

check('8. 界面右侧那句「现在看的是谁」：锁定要明说切标签不换数据', () => {
  const lock = follow.describeFollowState({ mode: 'lock', wcId: 11, title: 'docs 页面' });
  expectTrue(lock.includes('已锁定'), '要说已锁定');
  expectTrue(lock.includes('docs 页面'), '要带标签标题');
  expectTrue(lock.includes('不会换数据'), '要讲清切标签不换');
  const followText = follow.describeFollowState({ mode: 'follow', wcId: 12, title: '新闻' });
  expectTrue(followText.includes('跟随当前标签'), '跟随的说法');
  expectTrue(followText.includes('新闻'), '也要带标题');
  const noTitle = follow.describeFollowState({ mode: 'lock', wcId: 7 });
  expectTrue(noTitle.includes('标签 7'), '没标题就退回 id');
  return { detail: `${lock} / ${followText}` };
});

check('9. 上限口径一致：内核常量、纯函数常量、渲染层常量三处都是 500', () => {
  const core = read('src/core/toolbox.js');
  const renderer = read('src/renderer/toolbox-ui.js');
  expectTrue(/const MAX_RECORDS = 500;/.test(core), 'toolbox.js 的 MAX_RECORDS 要是 500');
  expectTrue(/const RECORD_LIMIT = 500;/.test(renderer), '渲染层 RECORD_LIMIT 要是 500');
  expectTrue(!/4000/.test(renderer), '渲染层不许再留 4000 的旧口径');
  return { detail: '500 / 500 / 500' };
});

check('10. 主进程把「有哪些标签、各自哪个 webContents」告诉界面（锁定才知道锁的在不在）', () => {
  const main = read('src/main.js');
  expectTrue(/ipcMain\.handle\('nyx:tb:state'/.test(main), '要有 tb:state');
  const block = main.slice(main.indexOf("ipcMain.handle('nyx:tb:state'"), main.indexOf("ipcMain.handle('nyx:tb:state'") + 1400);
  expectTrue(/tabs:\(/.test(block.replace(/\s+/g, '')), '要带 tabs');
  expectTrue(/wcId: tab\.view\.webContents\.id/.test(block), '每个标签要带 wcId');
  expectTrue(/active: tab\.id === runtime\.tabManager\.activeId/.test(block), '要标出哪个是活动标签');
  return { detail: 'tb:state 带 tabs[{id,wcId,title,active}]' };
});

check('11. 界面按「要看的那份数据」筛推送，而不是按活动标签', () => {
  const renderer = read('src/renderer/toolbox-ui.js');
  expectTrue(/function currentTargetWcId\(\)/.test(renderer), '要有 currentTargetWcId');
  expectTrue(/if \(target != null && payload\.tabId != null && payload\.tabId !== target\) return;/.test(renderer), '推送要按目标筛');
  expectTrue(/else if \(tb\.followMode === 'lock'\)/.test(renderer) || /if \(tb\.followMode !== 'lock'\)/.test(renderer), '有锁定的分支');
  expectTrue(/async function setFollowMode\(/.test(renderer), '要有 setFollowMode');
  expectTrue(/没得锁，保持跟随/.test(renderer), '没页面可锁要如实说');
  expectTrue(/已经关掉了，已改回跟随当前标签/.test(renderer), '锁定标签关掉要提示');
  expectTrue(/const target = currentTargetWcId\(\);\r?\n\s+const res = await nyx\.listToolboxRecords/.test(renderer), '装载也要按目标取');
  return { detail: '目标筛选 + 两种回退提示齐全' };
});

check('12. 界面有「跟随 / 锁定」两种选择与一行说明，且不是隐藏的功能', () => {
  const html = read('src/renderer/index.html');
  const css = read('src/renderer/style.css');
  expectTrue(/id="net-follow-mode"/.test(html), '要有选择框');
  expectTrue(/<option value="follow" selected>跟随当前标签<\/option>/.test(html), '默认选中跟随');
  expectTrue(/<option value="lock">锁定这个标签<\/option>/.test(html), '要能选锁定');
  expectTrue(/id="net-follow-hint"/.test(html), '要有状态说明位');
  expectTrue(/\.tb-follow-hint\.is-locked/.test(css), '锁定态要有样式');
  return { detail: '两选项 + 说明行 + 锁定样式' };
});

check('13. 关闭工具箱必须释放监听（清单 §4 硬约束）', () => {
  const main = read('src/main.js');
  const core = read('src/core/toolbox.js');
  expectTrue(/runtime\.toolbox\.disable\(\)/.test(main), '关工具箱要调 disable()');
  const disableBlock = core.slice(core.indexOf('disable() {'), core.indexOf('disable() {') + 500);
  expectTrue(/this\.enabled = false;/.test(disableBlock), 'disable 先关开关');
  expectTrue(/this\.detach\(collector\);/.test(disableBlock), 'disable 要逐个 detach');
  expectTrue(/collectors\.clear\(\)|this\.collectors\.clear\(\)/.test(disableBlock), '要清空采集器表');
  return { detail: '关闭即 detach 全部，零残留' };
});

const failed = results.filter((item) => !item.ok).length;
console.log(`\n[网络面板跟随] 共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('[网络面板跟随] 失败项：');
  results.filter((item) => !item.ok).forEach((item) => console.log(`  ✘ ${item.label}｜${item.detail}`));
  process.exitCode = 1;
} else {
  console.log('[网络面板跟随] 全部通过：默认跟随、锁定可钉住、标签没了如实回退，500 条口径三处一致。');
}
