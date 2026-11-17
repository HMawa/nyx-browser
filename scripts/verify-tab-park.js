/**
 * 切模式时"停靠标签而不是销毁"的回归（纯 Node，不启动 Electron）。
 *
 * 为什么用静态守卫而不是端到端：拆窗口、挂窗口、冻结渲染都只能在真 Electron 里做，
 * 而这段代码的价值恰恰在"别再调 close()"——所以这里盯的是**接线与语义**，
 * 端到端那半由手工 Drill 覆盖（台账里写明了步骤与判定标准）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const tabsSource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'tabs.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

const switchModeSection = mainSource.slice(
  mainSource.indexOf('async function switchMode'),
  mainSource.indexOf('async function switchModeTracked'),
);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✘ ${name}${detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

/* ① TabManager 上真的有两个方法，且语义对得上 */
check('TabManager 提供 parkAll() 与 restoreParked()', /parkAll\(\)\s*\{/.test(tabsSource) && /restoreParked\(\)\s*\{/.test(tabsSource));
check('停靠上限是 12 个（用户确认过的预算）', /this\.maxParked = 12;/.test(tabsSource));
check(
  '停靠时把视图从窗口上摘下来，但不销毁 webContents',
  /parkAll\(\)[\s\S]{0,2400}removeChildView\(tab\.view\)[\s\S]{0,1200}parked\.push\(tab\)/.test(tabsSource),
);
check(
  '停靠后立即静音并降低后台占用（不渲染、不出声，但页面还活着）',
  /setAudioMuted\(true\)/.test(tabsSource) && /setBackgroundThrottling\(true\)/.test(tabsSource) && /setVisible\(false\)/.test(tabsSource),
);
check(
  '恢复时把视图挂回、解静音，并按原顺序回到标签列表',
  /restoreParked\(\)[\s\S]{0,900}addChildView\(tab\.view\)/.test(tabsSource) &&
    /setAudioMuted\(false\)/.test(tabsSource) &&
    /this\.tabs\.push\(tab\)/.test(tabsSource),
);
check(
  '超出预算的标签降级成"只记地址"，恢复时按原地址重开（不是静默消失）',
  /dropped\.push\(url\)/.test(tabsSource) && /for \(const url of dropped\)/.test(tabsSource),
);

/* ② 主进程真的改用它了 */
check('切换模式改用 parkAll，不再 closeAll', /runtime\.tabManager\.parkAll\(\)/.test(switchModeSection) && !/tabManager\.closeAll\(\)/.test(switchModeSection));
check(
  '切回普通模式时先挂回停靠的标签，没有再急着开新标签',
  /next === 'normal' && typeof runtime\.tabManager\.restoreParked === 'function'/.test(switchModeSection) &&
    /restoreParked\(\)[\s\S]{0,200}result\.restored > 0/.test(switchModeSection),
);
check(
  '被降级的标签会当面告知，并落诊断（静默丢数据不可接受）',
  /TABS_DROPPED_ON_SWITCH/.test(switchModeSection) && /notifyNotice\(\{[\s\S]{0,400}TABS_DROPPED_ON_SWITCH/.test(switchModeSection),
);
check('停靠这一步也进了耗时记录（切换慢时能指到它）', /trackStep\(leavingPrivate \? '销毁私密标签' : '停靠普通标签'/.test(switchModeSection));

/* ②.5 退出私密模式：私密标签必须销毁，不能被停靠回来（审计 P0） */
check(
  'TabManager 提供 destroyAll()：强制销毁、不保留、不自动补标签',
  /destroyAll\(\)\s*\{/.test(tabsSource) && /webContents\.destroy\(\)/.test(tabsSource),
);
check(
  'destroyAll 用 destroy 而不是 close（close 会走 unload，私密页可以拖着不销毁）',
  /destroyAll\(\)[\s\S]{0,1400}webContents\.destroy\(\)/.test(tabsSource) &&
    !/destroyAll\(\)[\s\S]{0,1400}webContents\.close\(\)/.test(tabsSource),
);
const destroyAllBody = (() => {
  const start = tabsSource.indexOf('destroyAll()');
  if (start < 0) return '';
  const end = tabsSource.indexOf('return { ok: true, destroyed', start);
  return end < 0 ? tabsSource.slice(start, start + 1600) : tabsSource.slice(start, end + 40);
})();
check(
  'destroyAll 不清 parkedTabs（那是进私密前停靠的普通标签，回普通还要靠它恢复）',
  /this\.activeId = null/.test(destroyAllBody) && !/this\.parkedTabs = \[\]/.test(destroyAllBody) && !/this\.parkedActiveId/.test(destroyAllBody),
);
check(
  '切模式按方向走：离开私密调 destroyAll，且这条分支不调 parkAll',
  /const leavingPrivate = current === 'private';/.test(switchModeSection) &&
    /if \(leavingPrivate\) \{\s*runtime\.tabManager\.destroyAll\(\);/.test(switchModeSection),
);

/* ②.6 停靠不覆盖、并记住原活动标签（审计 P1 的 WebContents 泄漏） */
check(
  'parkAll 不覆盖已有停靠标签（旧实现 this.parkedTabs = [] 会让上一次的引用丢掉）',
  /const parked = Array\.isArray\(this\.parkedTabs\) \? this\.parkedTabs\.slice\(\) : \[\];/.test(tabsSource) &&
    /this\.parkedTabs = parked;/.test(tabsSource) &&
    !/parkAll\(\)[\s\S]{0,600}this\.tabs = \[\];\s*\n\s*this\.parkedTabs = \[\];/.test(tabsSource),
);
check('停靠时记住当时的活动标签，恢复时还给他', /this\.parkedActiveId = this\.activeId;/.test(tabsSource));
check(
  'restoreParked 优先恢复原活动标签，被 drop 了就退回第一个',
  /const wantActive = this\.parkedActiveId;/.test(tabsSource) &&
    /this\.tabs\.some\(\(tab\) => tab\.id === wantActive\)/.test(tabsSource),
);
check('构造函数里有 parkedActiveId 的初值（否则第一次恢复读到 undefined）', /this\.parkedActiveId = null;/.test(tabsSource));
check(
  '销毁前先摘掉调试通道（隐私标签挂着指纹面的 debugger，带着 destroy 会把主进程带崩）',
  /destroyAll\(\)[\s\S]{0,1600}wc\.debugger\.isAttached\(\)[\s\S]{0,120}wc\.debugger\.detach\(\)[\s\S]{0,400}webContents\.destroy\(\)/.test(tabsSource),
);

/* ③ 别处的显式关闭仍然有效（不能把"关标签"也停靠掉） */
check('显式关闭标签仍是销毁页面', /close\(id\)\s*\{[\s\S]{0,900}webContents\.close\(\)/.test(tabsSource));
check('closeAll 保留下来，只给真正需要清空的场景用', /closeAll\(\)\s*\{/.test(tabsSource));

console.log('');
console.log(`标签停靠回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 标签停靠回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 标签停靠回归通过');
}
