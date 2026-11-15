'use strict';

/**
 * 工具栏布局（清单 B1）。
 *
 * 原则：**常驻的四个动作解决"每天都要用"，其余收进「更多」菜单。**
 *   - 主路径（常驻）：新建标签、下载中心、隐私模式、工具箱。
 *   - 「更多」菜单：页面截图、页面摘要、扩展开关、代理中心。
 *
 * 这里只放"怎么排、叫什么、菜单里有什么"这类纯数据与纯函数，
 * 免得界面上散落一堆 if；也让断言能直接测，不用起 Electron。
 */

/** 常驻的四个主路径（顺序就是显示顺序）。 */
const MAIN_ACTIONS = Object.freeze([
  { id: 'new-tab', label: '新建', title: '新建标签（Ctrl+T）', where: 'main' },
  { id: 'downloads', label: '下载', title: '下载中心（Ctrl+J）', where: 'main' },
  { id: 'privacy', label: '隐私', title: '切到隐私模式（全隐私：不落盘、强制走代理）', where: 'main' },
  { id: 'toolbox', label: '工具箱', title: '工具箱：资源嗅探、网络抓包、开发者模式、页面环境', where: 'main' },
]);

/** 收进「更多」菜单的四项（顺序固定，别再塞第五项）。 */
const MORE_ACTIONS = Object.freeze([
  { id: 'screenshot', label: '页面截图', title: '把当前页存成 PNG（存到你选的目录）', where: 'more' },
  { id: 'digest', label: '页面摘要', title: '纯抽取式摘要，默认关闭；不调用任何生成式接口', where: 'more' },
  { id: 'extensions', label: '扩展开关', title: '打开设置 → 扩展：启用、停用、安装内置扩展', where: 'more' },
  { id: 'proxy', label: '代理中心', title: '打开设置 → 网络与代理：订阅、内核、节点、分流', where: 'more' },
]);

const ALL_ACTIONS = Object.freeze([...MAIN_ACTIONS, ...MORE_ACTIONS]);

/** 「显示文字标签」默认开：图标认不出来的时候，小字比 tooltip 更救急。 */
const DEFAULT_TOOLBAR_PREFS = Object.freeze({ labels: true });

function normalizeToolbarPrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return { labels: source.labels !== false };
}

/** 界面按这个决定：哪些常驻、哪些进菜单、要不要显示小字。 */
function resolveToolbarLayout(rawPrefs) {
  const prefs = normalizeToolbarPrefs(rawPrefs);
  return {
    prefs,
    labels: prefs.labels,
    main: MAIN_ACTIONS.map((item) => ({ ...item })),
    more: MORE_ACTIONS.map((item) => ({ ...item })),
    moreIds: MORE_ACTIONS.map((item) => item.id),
    mainIds: MAIN_ACTIONS.map((item) => item.id),
  };
}

/** 「更多」菜单里的目标分区（扩展开关 / 代理中心其实都是设置里的分区）。 */
const MORE_SECTION_TARGETS = Object.freeze({ extensions: 'extensions', proxy: 'network' });

function sectionForAction(id) {
  return MORE_SECTION_TARGETS[id] || '';
}

/** 截图文件名：中文可读、按时间排序不会乱。 */
function screenshotFilename(now) {
  const date = new Date(Number.isFinite(now) ? now : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}-${pad(
    date.getMinutes(),
  )}-${pad(date.getSeconds())}`;
  return `页面截图-${stamp}.png`;
}

module.exports = {
  ALL_ACTIONS,
  DEFAULT_TOOLBAR_PREFS,
  MAIN_ACTIONS,
  MORE_ACTIONS,
  MORE_SECTION_TARGETS,
  normalizeToolbarPrefs,
  resolveToolbarLayout,
  screenshotFilename,
  sectionForAction,
};
