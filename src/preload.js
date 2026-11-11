'use strict';

/**
 * 渲染层预加载脚本（UI 外壳专用）。
 *
 * 只做一件事：通过 contextBridge 暴露一组最小化的 IPC 能力。
 * 不开 nodeIntegration、不暴露 ipcRenderer 本体，渲染层无法越权访问主进程资源。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 主题启动前置：渲染层要等 getState() 回调才知道主题，
 * 浅色主题（素纸）下会先闪一下默认的墨夜底色。
 * 这里在文档开始时就同步写一次 data-theme 消除闪色，不依赖渲染层时序。
 */
(function applyEarlyTheme() {
  const apply = (snap) => {
    const theme = (snap && snap.ui && snap.ui.theme) || 'ink';
    const root = document.documentElement;
    if (root) {
      root.dataset.theme = theme;
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          document.documentElement.dataset.theme = theme;
        },
        { once: true },
      );
    }
  };
  ipcRenderer.invoke('nyx:get-state').then(apply).catch(() => {});
})();

contextBridge.exposeInMainWorld('nyx', {
  /** 拉取当前完整界面状态（标签列表 / 模式 / 激活标签） */
  getState: () => ipcRenderer.invoke('nyx:get-state'),

  /* ---------------- 界面偏好 / 应用信息 ---------------- */

  /** 界面偏好（顶栏元素显隐等纯外观开关） */
  getUiPrefs: () => ipcRenderer.invoke('nyx:ui:prefs'),

  /** 写入单项界面偏好；仅接受白名单键与布尔值 */
  setUiPref: (key, value) => ipcRenderer.invoke('nyx:ui:prefs-set', { key, value }),

  /** 应用与运行时信息（版本、内核版本、安装与用户数据目录、主页、标签上限） */
  getAppInfo: () => ipcRenderer.invoke('nyx:app:info'),

  /* ---------------- 启动与主页 ---------------- */

  /** 启动与主页配置：新标签页地址、启动方式、指定启动页（只含配置，不含浏览数据） */
  getStartupPrefs: () => ipcRenderer.invoke('nyx:startup:prefs'),

  /** 写入启动与主页配置；未传入的字段保持原值 */
  setStartupPrefs: (payload) => ipcRenderer.invoke('nyx:startup:prefs-set', payload || {}),

  /** 恢复默认：新标签为空白页、启动打开新标签页 */
  resetStartupPrefs: () => ipcRenderer.invoke('nyx:startup:prefs-reset'),

  /** 标签操作 */
  createTab: (url) => ipcRenderer.invoke('nyx:tab:create', url),
  closeTab: (id) => ipcRenderer.invoke('nyx:tab:close', id),
  activateTab: (id) => ipcRenderer.invoke('nyx:tab:activate', id),

  /** 导航操作（作用于当前激活标签） */
  navigate: (input) => ipcRenderer.invoke('nyx:navigate', input),
  goBack: () => ipcRenderer.invoke('nyx:go-back'),
  goForward: () => ipcRenderer.invoke('nyx:go-forward'),
  reload: () => ipcRenderer.invoke('nyx:reload'),

  /** 模式切换：'normal' | 'private' */
  switchMode: (mode) => ipcRenderer.invoke('nyx:switch-mode', mode),

  /* ---------------- 隐私状态 / 权限 / 密码库 ---------------- */

  /** 隐私现状：当前模式、加固口径、出口画像、WebRTC 策略、权限摘要、密码库统计 */
  getPrivacyStatus: () => ipcRenderer.invoke('nyx:privacy:status'),

  /** 权限决策轨迹（默认最近 50 条） */
  listPermissionDecisions: (limit) => ipcRenderer.invoke('nyx:permissions:list', limit),

  /** 清空"按站点已记住的授权"（只清内存缓存） */
  clearPermissionCache: () => ipcRenderer.invoke('nyx:permissions:clear'),

  /** 密码库统计（不含任何条目内容） */
  getVaultStats: () => ipcRenderer.invoke('nyx:vault:stats'),

  /** 密码库条目清单（仅来源与用户名，不含密码；隐私模式下拒绝） */
  listVaultEntries: () => ipcRenderer.invoke('nyx:vault:list'),

  /** 删除某站点的密码 */
  removeVaultEntry: (origin) => ipcRenderer.invoke('nyx:vault:remove', { origin }),

  /** 清空密码库（密码与表单记忆全部删除，不可撤销） */
  clearVault: () => ipcRenderer.invoke('nyx:vault:clear'),

  /* ---------------- 扩展插件（兼容 Edge / Chrome 扩展） ---------------- */

  /**
   * 扩展清单（含启用状态、装载结果与支持度评级）。
   * 扩展只在普通模式分区装载，隐私模式分区不加载任何扩展。
   */
  listExtensions: () => ipcRenderer.invoke('nyx:ext:list'),

  /** 导入已解压的扩展目录（主进程弹原生目录选择框） */
  addExtensionFromDir: () => ipcRenderer.invoke('nyx:ext:add-dir'),

  /** 导入 .crx / .zip 扩展安装包（主进程弹原生文件选择框） */
  addExtensionFromCrx: () => ipcRenderer.invoke('nyx:ext:add-crx'),

  /** 启用 / 停用扩展：{ id, enabled }，改动需刷新页面才在已打开的标签上生效 */
  toggleExtension: (payload) => ipcRenderer.invoke('nyx:ext:toggle', payload || {}),

  /** 删除扩展（主进程弹原生确认框，删除仓库内文件不可撤销） */
  removeExtension: (payload) => ipcRenderer.invoke('nyx:ext:remove', payload || {}),

  /** 全部重新装载（扩展文件被外部改动后使用） */
  reloadExtensions: () => ipcRenderer.invoke('nyx:ext:reload'),

  /** 刷新全部标签：让新装的扩展在已打开的页面上生效 */
  reloadTabsForExtensions: () => ipcRenderer.invoke('nyx:ext:reload-tabs'),

  /** 在文件管理器里打开扩展仓库目录 */
  openExtensionStore: () => ipcRenderer.invoke('nyx:ext:open-store'),

  /* ---------------- 网络与代理 ---------------- */

  /** 打开设置窗口（已在则聚焦） */
  openSettings: () => ipcRenderer.invoke('nyx:proxy:open'),

  /** 代理状态快照：内核、订阅、出口自查结果 */
  getProxyStatus: () => ipcRenderer.invoke('nyx:proxy:status'),

  /** 内置内核启停 */
  startProxy: () => ipcRenderer.invoke('nyx:proxy:start'),
  stopProxy: () => ipcRenderer.invoke('nyx:proxy:stop'),
  restartProxy: () => ipcRenderer.invoke('nyx:proxy:restart'),

  /** 订阅管理 */
  addProxySubscription: (payload) => ipcRenderer.invoke('nyx:proxy:subscription-add', payload),
  removeProxySubscription: (id) => ipcRenderer.invoke('nyx:proxy:subscription-remove', id),
  switchProxySubscription: (id) => ipcRenderer.invoke('nyx:proxy:subscription-switch', id),
  refreshProxySubscription: () => ipcRenderer.invoke('nyx:proxy:subscription-refresh'),

  /** 节点：清单 / 测速 / 切换 / 出口自查 */
  listProxyNodes: () => ipcRenderer.invoke('nyx:proxy:nodes'),
  testProxyNodes: (names) => ipcRenderer.invoke('nyx:proxy:test', names),
  selectProxyNode: (group, node) => ipcRenderer.invoke('nyx:proxy:select', { group, node }),
  checkProxyEgress: () => ipcRenderer.invoke('nyx:proxy:egress'),

  /**
   * 代理中心偏好项（主进程侧白名单：autoTest / autoEgress / autoStart）。
   * autoEgress 控制"内核就绪后是否自动刷新出口信息"，默认关闭。
   */
  setProxyPreference: (key, value) => ipcRenderer.invoke('nyx:proxy:preference-set', { key, value }),

  /* ---------------- 智能遨游调度（smart-patrol） ---------------- */

  /** 智能调度状态：巡检开关 / 运行中 / 域名规则统计 / 最近判定 */
  getSmartStatus: () => ipcRenderer.invoke('nyx:smart:status'),

  /** 清空智能分流规则表（域名判定全部作废，下次巡检重建） */
  clearSmartRules: () => ipcRenderer.invoke('nyx:smart:clear'),

  /* ---------------- 硬件能力（GPU / NPU） ---------------- */

  /** 只读探测 GPU 加速状态与 NPU 设备，供设置中心展示 */
  getHardwareStatus: () => ipcRenderer.invoke('nyx:hardware:status'),

  /* ---------------- 下载设置 ---------------- */

  /** 弹系统目录选择框，返回用户选定的下载保存目录 */
  pickDownloadDir: () => ipcRenderer.invoke('nyx:download:pick-dir'),

  /** 在资源管理器中打开当前下载目录 */
  openDownloadDir: () => ipcRenderer.invoke('nyx:download:open-dir'),

  /* ---------------- 上网网卡（手动 / 自动选择） ---------------- */

  /** 本机可用网卡清单（含当前"自动 / 手动"偏好，不返回任何凭据） */
  listNetInterfaces: () => ipcRenderer.invoke('nyx:proxy:interfaces'),

  /** 设置出站网卡：{ mode: 'auto' | 'manual', name }，内核在跑时会自动重建 */
  setOutboundInterface: (payload) => ipcRenderer.invoke('nyx:proxy:interface-set', payload || {}),

  /** 订阅代理状态变化推送，返回取消订阅函数 */
  onProxyState: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('nyx:proxy-state', listener);
    return () => ipcRenderer.removeListener('nyx:proxy-state', listener);
  },

  /* ---------------- 工具箱：嗅探 / 抓包 / 开发者模式 / 页面环境 ---------------- */

  /**
   * 工具箱状态：抽屉开合、占宽、当前标签、粘性设置。
   * 占宽要和界面里的抽屉宽度保持一致，否则标签视图与面板会错位。
   */
  getToolboxState: () => ipcRenderer.invoke('nyx:tb:state'),

  /** 展开 / 收起工具箱抽屉：{ open, width } */
  setToolboxOpen: (payload) => ipcRenderer.invoke('nyx:tb:set-open', payload || {}),

  /** UA / 视口 / 限速三份预设清单（界面不再自己维护一份常量） */
  getToolboxPresets: () => ipcRenderer.invoke('nyx:tb:presets'),

  /** 重连调试通道：开发者工具关闭后抓包需显式接管（两者互斥） */
  syncToolbox: () => ipcRenderer.invoke('nyx:tb:sync'),

  /** 抓包 / 嗅探记录清单（可按 wcId 看别的标签；不传看当前标签） */
  listToolboxRecords: (payload) => ipcRenderer.invoke('nyx:tb:list', payload || {}),

  /** 单条请求详情（完整头、POST 体、文本正文预览） */
  getToolboxDetail: (payload) => ipcRenderer.invoke('nyx:tb:detail', payload || {}),

  /** 清空某标签的抓包记录 */
  clearToolboxRecords: (payload) => ipcRenderer.invoke('nyx:tb:clear', payload || {}),

  /** 暂停 / 恢复记录：{ wcId, paused } */
  pauseToolbox: (payload) => ipcRenderer.invoke('nyx:tb:pause', payload || {}),

  /** 采集状态：通道是否挂上、是否暂停、累计条数、让位情况 */
  getToolboxStatus: (payload) => ipcRenderer.invoke('nyx:tb:status', payload || {}),

  /** 开发者模式：{ action: 'open' | 'close' | 'state', mode } */
  devTools: (payload) => ipcRenderer.invoke('nyx:tb:devtools', payload || {}),

  /** 拾取页面元素：等待用户点选，返回选择器 / XPath / 盒子 / 文本 */
  pickElement: (payload) => ipcRenderer.invoke('nyx:tb:pick', payload || {}),

  /** 取消进行中的元素拾取 */
  cancelPickElement: (payload) => ipcRenderer.invoke('nyx:tb:pick-cancel', payload || {}),

  /** 在页面上闪一下高亮某个选择器 */
  highlightElement: (payload) => ipcRenderer.invoke('nyx:tb:highlight', payload || {}),

  /** 对选择器取数：{ selector, expression }，表达式里 el 即选中元素 */
  evalOnSelector: (payload) => ipcRenderer.invoke('nyx:tb:eval', payload || {}),

  /** 切换 UA：{ preset, custom, keepPage }，不选 keepPage 会重载页面 */
  setToolboxUA: (payload) => ipcRenderer.invoke('nyx:tb:ua', payload || {}),

  /** 切换视口：{ preset, keepPage }，桌面网页 / 手机版网站互切 */
  setToolboxDevice: (payload) => ipcRenderer.invoke('nyx:tb:device', payload || {}),

  /** 网络限速 / 断网：{ preset } */
  setToolboxThrottle: (payload) => ipcRenderer.invoke('nyx:tb:throttle', payload || {}),

  /** 页面 JavaScript 开关：{ enabled } */
  setToolboxJavaScript: (payload) => ipcRenderer.invoke('nyx:tb:js', payload || {}),

  /** 清理当前站点痕迹：{ kinds: ['cookie'|'storage'|'cache'|'all'] } */
  clearToolboxSiteData: (payload) => ipcRenderer.invoke('nyx:tb:clear-site', payload || {}),

  /** 截图并保存：{ fullPage }，落点由系统保存对话框决定 */
  captureToolboxScreenshot: (payload) => ipcRenderer.invoke('nyx:tb:screenshot', payload || {}),

  /** 复制到系统剪贴板：{ text } */
  copyToolboxText: (payload) => ipcRenderer.invoke('nyx:tb:copy', payload || {}),

  /** 打开嗅探到的地址：{ url, external }，external 为 true 时交给系统默认浏览器 */
  openToolboxUrl: (payload) => ipcRenderer.invoke('nyx:tb:open', payload || {}),

  /** 下载资源到系统下载目录：{ url } */
  downloadToolboxResource: (payload) => ipcRenderer.invoke('nyx:tb:download', payload || {}),

  /* 调试：修改页面 HTML 与控制台 */

  /** 读取 / 应用 / 还原页面 HTML：{ action: 'read'|'apply'|'revert', html? } */
  pageHtml: (payload) => ipcRenderer.invoke('nyx:tb:page-html', payload || {}),

  /** 在页面执行任意 JS：{ expression }，返回 JSON 结果与临时捕获的 console 输出 */
  consoleEval: (payload) => ipcRenderer.invoke('nyx:tb:console-eval', payload || {}),

  /* Cookie 管理 */

  /** 列出当前标签页 Cookie：{ host? }，host 缺省返回该 session 全部 */
  cookieList: (payload) => ipcRenderer.invoke('nyx:tb:cookie-list', payload || {}),

  /** 写入 Cookie：{ domain, name, value, path?, secure?, httpOnly?, expirationDate?, sameSite? } */
  cookieSet: (payload) => ipcRenderer.invoke('nyx:tb:cookie-set', payload || {}),

  /** 删除 Cookie：{ domain, name, path? } */
  cookieRemove: (payload) => ipcRenderer.invoke('nyx:tb:cookie-remove', payload || {}),

  /** 清空站点全部 Cookie：{ host }，返回 { removed } */
  cookieClear: (payload) => ipcRenderer.invoke('nyx:tb:cookie-clear', payload || {}),

  /** 从 Edge 无缝导入 Cookie：{ mode: 'site'|'all' }，site 只导当前站点，all 全量上限 500 */
  cookieEdgeImport: (payload) => ipcRenderer.invoke('nyx:tb:cookie-edge-import', payload || {}),

  /* 视频增强 */

  /** 扫描页面视频：数量、主视频、进度、当前倍速与接管状态 */
  scanVideos: (payload) => ipcRenderer.invoke('nyx:tb:video-scan', payload || {}),

  /** 应用倍速：{ rate, lock }；rate 为 0/空表示还原 1x */
  setVideoRate: (payload) => ipcRenderer.invoke('nyx:tb:video-rate', payload || {}),

  /** 进度解锁：{ seconds | percent | delta | toEnd | index | all, lock, unlock } */
  seekVideo: (payload) => ipcRenderer.invoke('nyx:tb:video-seek', payload || {}),

  /** 鼠标保活：{ action: 'start' | 'stop' | 'status', mode, gap } */
  controlVideoMouse: (payload) => ipcRenderer.invoke('nyx:tb:video-mouse', payload || {}),

  /** 退出接管：停保活 + 还原页面上的倍速/进度改写 */
  releaseVideo: () => ipcRenderer.invoke('nyx:tb:video-release'),

  /** 订阅抓包增量推送，返回取消订阅函数 */
  onToolboxFeed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nyx:tb:net', listener);
    return () => ipcRenderer.removeListener('nyx:tb:net', listener);
  },

  /** 打开工具箱并切换到指定页签（书签栏「管理」按钮入口）：{ pane } */
  openToolboxPane: (payload) => ipcRenderer.invoke('nyx:tb:open-pane', payload || {}),

  /** 订阅工具箱页签切换推送（主进程经 nyx:tb:open-pane 触发），返回取消订阅函数 */
  onToolboxPane: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nyx:tb:switch-pane', listener);
    return () => ipcRenderer.removeListener('nyx:tb:switch-pane', listener);
  },

  /* ---------------- 历史记录与书签 ---------------- */
  /** 历史记录列表（按访问时间倒序，主进程持久化到 <userData>/history.json） */
  historyList: () => ipcRenderer.invoke('nyx:history:list'),
  /** 清空全部历史记录（不可撤销） */
  historyClear: () => ipcRenderer.invoke('nyx:history:clear'),
  /** 删除单条历史记录：{ id } */
  historyRemove: (payload) => ipcRenderer.invoke('nyx:history:remove', payload || {}),
  /** 书签列表（v2 树结构，含根与 children，主进程持久化到 <userData>/bookmarks.json） */
  bookmarksList: () => ipcRenderer.invoke('nyx:bookmarks:list'),
  /** 收藏当前页：{ title, url, folderId? }，folderId 省略收藏到书签栏根下；URL 已存在会跳过 */
  bookmarksAdd: (payload) => ipcRenderer.invoke('nyx:bookmarks:add', payload || {}),
  bookmarksAddFolder: (payload) => ipcRenderer.invoke('nyx:bookmarks:add-folder', payload || {}),
  /** 删除单条书签 / 文件夹：{ id }（删除文件夹会连带删除其子书签） */
  bookmarksRemove: (payload) => ipcRenderer.invoke('nyx:bookmarks:remove', payload || {}),
  /** 从浏览器导入书签：{ source: 'edge' | 'chrome' }，保留文件夹层级，返回 { added, skipped, moved } */
  bookmarksImport: (payload) => ipcRenderer.invoke('nyx:bookmarks:import', payload || {}),
  /** 批量删除书签 / 文件夹：{ ids }，文件夹递归连带子项（书签管理窗口用） */
  bookmarksRemoveMany: (payload) => ipcRenderer.invoke('nyx:bookmarks:remove-many', payload || {}),
  /** 同级排序：{ id, direction: 'up' | 'down' }（书签管理窗口用） */
  bookmarksMove: (payload) => ipcRenderer.invoke('nyx:bookmarks:move', payload || {}),

  /** 检查更新源里的扩展更新（v1.11.0，读 extensions.json） */
  extOnlineCheck: () => ipcRenderer.invoke('nyx:ext:online-check'),

  /** 从更新源下载并安装扩展包：{ key, file }（v1.11.0，装前校验 sha256） */
  extOnlineInstall: (payload) => ipcRenderer.invoke('nyx:ext:online-install', payload || {}),

  /** 一键更新所有可更新的扩展（v1.13.0） */
  extOnlineUpdateAll: () => ipcRenderer.invoke('nyx:ext:online-update-all'),

  /** 扩展版本历史（v1.16.0）：读更新源 extensions.json 的 history，不下载 */
  extOnlineHistory: () => ipcRenderer.invoke('nyx:ext:online-history'),

  /** 回滚到某个历史版本（v1.16.0）：{ key, version } → { ok, restored:{name,version} } */
  extOnlineRollback: (payload) => ipcRenderer.invoke('nyx:ext:online-rollback', payload || {}),

  /* ---------------- 更新源占用看板（v1.16.0） ---------------- */

  /** 更新源与留档的体积快照：{ ok, updates, archive, total } */
  updateFootprint: () => ipcRenderer.invoke('nyx:update:footprint'),

  /** 在资源管理器里打开更新源目录 */
  updateOpenSource: () => ipcRenderer.invoke('nyx:update:open-source'),

  /** 把清理命令写进剪贴板：{ ok, command } */
  updateCopyCleanCommand: () => ipcRenderer.invoke('nyx:update:copy-clean-command'),

  /* ---------------- 抓包慢请求阈值（v1.16.0） ---------------- */

  /** 读慢请求阈值：{ ok, slowMs, min, max, fallback } */
  tbSlowMs: () => ipcRenderer.invoke('nyx:tb:slow-ms'),

  /** 写慢请求阈值：ms → { ok, slowMs }（越界返回中文错误） */
  tbSlowMsSet: (ms) => ipcRenderer.invoke('nyx:tb:slow-ms-set', { slowMs: ms }),

  /** 订阅阈值变更推送（设置页保存后抓包面板即时生效），返回取消订阅函数 */
  onTbSlowMs: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload || {});
    ipcRenderer.on('nyx:tb:slow-ms', wrapped);
    return () => ipcRenderer.removeListener('nyx:tb:slow-ms', wrapped);
  },

  /** 调整置顶顺序（v1.12.0）：{ urls: [...] }；v1.16.0 支持 { group, urls: [...] } 只排该组 */
  addressSuggestPinnedReorder: (payload) => ipcRenderer.invoke('nyx:as:pinned-reorder', payload || {}),

  /** 把一条置顶换个分组（v1.16.0）：{ url, group }，group ∈ work|study|other */
  addressSuggestPinnedGroupSet: (payload) => ipcRenderer.invoke('nyx:as:pinned-group-set', payload || {}),

  /** 导出置顶为 JSON 文件（v1.15.0）：{ path? } 省略 path 时弹保存框 → { ok, path, count } */
  addressSuggestPinnedExport: (payload) => ipcRenderer.invoke('nyx:as:pinned-export', payload || {}),

  /** 从 JSON 文件导入置顶（v1.15.0，合并去重、填到上限）：{ path? } → { ok, added, skipped, invalid, total } */
  addressSuggestPinnedImport: (payload) => ipcRenderer.invoke('nyx:as:pinned-import', payload || {}),

  /* ---------------- 工具栏星标（v1.4.0） ---------------- */
  /** 查询某地址是否已收藏：{ url } → { ok, bookmarked, id }（星标状态与建议徽标共用） */
  bookmarksHas: (payload) => ipcRenderer.invoke('nyx:bookmarks:has', payload || {}),

  /** 收藏 / 取消收藏当前页：{ url, title } → { ok, bookmarked } */
  bookmarksToggle: (payload) => ipcRenderer.invoke('nyx:bookmarks:toggle', payload || {}),

  /** 弹出「收藏到文件夹」浮层：{ x, y, url, title }（屏幕坐标；长按 / 右键星标触发） */
  bookmarksFolderMenu: (payload) => ipcRenderer.invoke('nyx:bookmarks:folder-menu', payload || {}),

  /** 关闭「收藏到文件夹」浮层（幂等） */
  bookmarksFolderClose: () => ipcRenderer.invoke('nyx:bookmarks:folder-close'),

  /** 选中文件夹 / 新建命名文件夹并收藏：{ folderId: number|'new', title? }（浮层内也用同一通道） */
  bookmarksFolderPick: (payload) => ipcRenderer.invoke('nyx:bookmarks:folder-pick', payload || {}),

  /** 主窗口内容区屏幕坐标（书签浮层定位用：把按钮视口偏移换算成屏幕坐标） */
  getContentBounds: () => ipcRenderer.invoke('nyx:get-content-bounds'),

  /** 弹出书签下拉浮层：{ x, y, items }（屏幕坐标 + 递归子项数据，见主进程 openBookmarkMenu） */
  bookmarksOpenMenu: (payload) => ipcRenderer.invoke('nyx:bm:menu-open', payload || {}),

  /** 关闭书签下拉浮层 */
  bookmarksCloseMenu: () => ipcRenderer.invoke('nyx:bm:menu-close'),

  /** 打开书签管理窗口（树形展示、批量删除、同级排序） */
  bookmarksOpenManage: () => ipcRenderer.invoke('nyx:bm:manage-open'),

  /** 订阅书签变化推送（管理窗口保存修改后，书签栏自动刷新），返回取消订阅函数 */
  onBookmarkChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nyx:bm:changed', listener);
    return () => ipcRenderer.removeListener('nyx:bm:changed', listener);
  },

  /* ---------------- 地址栏历史建议（v1.3.0 新增） ---------------- */
  /**
   * 查询历史建议：{ text, x, y, width }。
   * x / y 为地址栏左下角的屏幕坐标（与书签浮层同一套换算），width 用于对齐浮层宽度。
   * 主进程负责命中计算与浮层生命周期，渲染层只拿条目数做键盘联动。
   */
  addressSuggestQuery: (payload) => ipcRenderer.invoke('nyx:as:query', payload || {}),

  /** 键盘导航建议：key 为 'down' | 'up' | 'first' | 'last' | 'enter' | 'escape'；enter 命中时返回 { url, newTab } */
  addressSuggestNav: (key, options) =>
    ipcRenderer.invoke('nyx:as:nav', { key, newTab: !!(options && options.newTab) }),

  /** 展开某个站点的全部命中（v1.6.0 同站聚合折叠）：{ host } */
  addressSuggestExpand: (payload) => ipcRenderer.invoke('nyx:as:expand', payload || {}),

  /** 置顶 / 取消置顶一条建议（v1.11.0）：{ url, title } */
  addressSuggestPin: (payload) => ipcRenderer.invoke('nyx:as:pin-toggle', payload || {}),

  /** 置顶列表（v1.11.0） */
  addressSuggestPinned: () => ipcRenderer.invoke('nyx:as:pinned'),

  /** 订阅站点图标补全推送：{ icons: { host: dataUrl } }（v1.5.0，异步补真图标） */
  onAddressSuggestIcons: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:as:icons', listener);
    return () => ipcRenderer.removeListener('nyx:as:icons', listener);
  },

  /* ---------------- 站点图标（v1.6.0，工具箱等面板共用） ---------------- */
  /** 取站点图标：{ host } → { ok, icon }；icon 为空表示未缓存（主进程已在后台抓，抓到会推 onSiteIcons） */
  siteIcon: (payload) => ipcRenderer.invoke('nyx:icons:get', payload || {}),

  /** 订阅图标异步就绪：{ icons: { host: dataUrl } } */
  onSiteIcons: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:icons:ready', listener);
    return () => ipcRenderer.removeListener('nyx:icons:ready', listener);
  },

  /** 收起建议浮层（幂等） */
  addressSuggestClose: () => ipcRenderer.invoke('nyx:as:close'),

  /** 订阅「浮层内点击了某条建议」推送（主进程已发起导航，外壳只需同步地址栏显示） */
  onAddressSuggestPicked: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:as:picked', listener);
    return () => ipcRenderer.removeListener('nyx:as:picked', listener);
  },

  /* ---------------- 在线升级 ---------------- */

  /** 升级状态快照：当前版本、更新源、最新版本、阶段与进度 */
  getUpdateStatus: () => ipcRenderer.invoke('nyx:update:status'),

  /** 检查更新（用户主动触发，已是最新或失败都会弹中文提示） */
  checkForUpdates: () => ipcRenderer.invoke('nyx:update:check'),

  /** 统一检查：应用 + 扩展（v1.12.0） */
  checkAllUpdates: () => ipcRenderer.invoke('nyx:update:check-all'),

  /** 获取升级包（本地源为复制，远端源为下载，含 sha256 校验） */
  fetchUpdate: () => ipcRenderer.invoke('nyx:update:fetch'),

  /** 安装已就绪的升级包（静默覆盖安装，应用自动重启） */
  installUpdate: () => ipcRenderer.invoke('nyx:update:install'),

  /** 打开升级包文件夹 */
  openUpdateFolder: () => ipcRenderer.invoke('nyx:update:open-folder'),

  /** 关于 Nyx：版本、安装目录、用户数据目录、更新源 */
  showAbout: () => ipcRenderer.invoke('nyx:update:about'),

  /** 设置更新源（http(s) 地址或本地目录）与是否自动检查 */
  setUpdateSource: (payload) => ipcRenderer.invoke('nyx:update:set-source', payload),

  /** 订阅升级状态推送，返回取消订阅函数 */
  onUpdateState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('nyx:update-state', listener);
    return () => ipcRenderer.removeListener('nyx:update-state', listener);
  },

  /** 订阅主进程推送的状态更新，返回取消订阅函数 */
  onState: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('nyx:state', listener);
    return () => ipcRenderer.removeListener('nyx:state', listener);
  },

  /**
   * 订阅主进程推送的用户提示（如"代理不可达，已拒绝进入隐私模式"），
   * 返回取消订阅函数。
   */
  onNotice: (handler) => {
    const listener = (_event, notice) => handler(notice);
    ipcRenderer.on('nyx:notice', listener);
    return () => ipcRenderer.removeListener('nyx:notice', listener);
  },
});
