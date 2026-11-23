'use strict';

/**
 * 渲染层预加载脚本（UI 外壳专用）。
 *
 * 只做一件事：通过 contextBridge 暴露一组最小化的 IPC 能力。
 * 不开 nodeIntegration、不暴露 ipcRenderer 本体，渲染层无法越权访问主进程资源。
 */

const { contextBridge, ipcRenderer } = require('electron');
// 动效档位的时长与缓动只有一份（src/core/motion.js）；界面侧同步取用，避免两处各写一套数字
const motionCore = require('./core/motion');
const fontScaleCore = require('./core/font-scale');
// 接入外壳词表（VPN 接入外壳清单 B1）：界面只许从这里取字，词表本身是纯字符串模块
const netTermsCore = require('./core/net-terms');

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

  /** 动效档位解析（清单 B2）：同步返回时长/缓动/按压，系统减少动效时自动降级 */
  motionResolve: (payload) => motionCore.resolveMotion(payload || {}),

  /**
   * 界面字号档位（清单 D3 遗留项）：倍率与中文名的唯一来源是 src/core/font-scale.js，
   * 界面侧只读结果，不另写一份数字。
   */
  fontScaleFactor: (key) => fontScaleCore.fontScaleFactor(key),
  fontScaleLabel: (key) => fontScaleCore.describeFontScale(key),
  fontScaleOptions: () => fontScaleCore.fontScaleOptions(),

  /* ---------------- 首次安装引导（清单 D2） ---------------- */

  /** 引导要问的五件事与默认值 */
  onboardState: () => ipcRenderer.invoke('nyx:onboard:state'),

  /** 提交引导里的选择；skipAll 为 true 表示「全部默认」，一次落盘并关窗 */
  onboardFinish: (payload) => ipcRenderer.invoke('nyx:onboard:finish', payload || {}),

  /** 写入单项界面偏好；仅接受白名单键与布尔值 */
  setUiPref: (key, value) => ipcRenderer.invoke('nyx:ui:prefs-set', { key, value }),

  /* ---------------- 接入方式（VPN 接入外壳清单 B1） ---------------- */

  /** 当前该用哪一档接入方式：identity / 是否自动推断 / 三档选项 / 词表 / 定位声明 */
  netIdentity: () => ipcRenderer.invoke('nyx:net:identity'),

  /** 写入用户显式选择的接入方式（campus / enterprise / custom），返回新载荷 */
  setNetIdentity: (identity) => ipcRenderer.invoke('nyx:net:identity-set', { identity }),

  /** 同步取某档的全部词条（不落盘、不走 IPC；界面渲染前先用它铺字） */
  netTermsFor: (identity) => netTermsCore.termsFor(identity),

  /** 三档选择器的选项（label + note），与主进程共用一份表 */
  netIdentityOptions: () => netTermsCore.describeIdentities(),

  /** 把一句动态文案换成外壳叫法（custom 原样返回）；设置页扫动态句子时同步调用 */
  netShellizeText: (text, identity) => netTermsCore.shellize(text, identity),

  /** 接入方式改过之后，主进程会通知外壳重扫一遍文本（返回取消订阅函数） */
  onNetIdentityChanged: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nyx:net-identity-changed', listener);
    return () => ipcRenderer.removeListener('nyx:net-identity-changed', listener);
  },

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

  /**
   * 跑一次本地隐私自检（1.18.0）。
   * 判定与报告都在主进程的纯逻辑模块里算，这里只把结果搬给界面；
   * 主进程侧带 3 秒硬上限，页面观测卡住也不会把设置页拖死。
   */
  privacyCheck: () => ipcRenderer.invoke('nyx:privacy:check'),

  /**
   * 对照基准（任务卡 T2）：读最近一份基准并跟这次自检的结论比。
   * 基准里没有观察值与真实值，返回值也不含；传 rows 才出 compare。
   */
  privacyBaseline: (payload) => ipcRenderer.invoke('nyx:privacy:baseline', payload || {}),

  /**
   * 隐私模式的出站方式（proxy / direct）与其边界文案。
   * 返回值的 options[].lost 是「真实 IP」会失去的保护，设置页原样展示。
   */
  privacyLink: () => ipcRenderer.invoke('nyx:privacy:link'),

  /**
   * 修改隐私模式的出站方式。选 direct 必须带 ack: true（用户已勾选风险确认），
   * 否则主进程会拒绝，避免隐私模式被悄悄改成直连。
   */
  privacyLinkSet: (payload) => ipcRenderer.invoke('nyx:privacy:link-set', payload || {}),

  /**
   * 图形性能策略（清单 A5）：读当前策略、本次启动实际生效的策略、显卡适配器信息。
   * `restartRequired` 为 true 说明用户改过但还没重启，改动尚未生效。
   */
  gpuPolicy: () => ipcRenderer.invoke('nyx:gpu:policy'),

  /** 修改图形性能策略（low-power / high-performance / auto），一律下次启动生效 */
  gpuPolicySet: (payload) => ipcRenderer.invoke('nyx:gpu:policy-set', payload || {}),

  /** 立即重启应用（用于让显卡策略生效）；不返回值也会退出进程 */
  restartApp: () => ipcRenderer.invoke('nyx:app:restart'),

  /** 安全基线（C2）：声明的 Electron/Chromium/Node 版本 vs 机器上跑的版本 */
  securityBaseline: () => ipcRenderer.invoke('nyx:security:baseline'),

  /** 打开安全公告页（只接受 electron / chromium / node 三个 key，URL 由主进程决定） */
  openSecurityAdvisory: (payload) => ipcRenderer.invoke('nyx:security:advisory', payload || {}),

  /** 安装包签名状态（第五轮 ②）：读当前 exe 的签名与证书有效期，force 跳过十分钟缓存 */
  signingStatus: (payload) => ipcRenderer.invoke('nyx:signing:status', payload || {}),

  /** 外壳防护现值表（C3）：每个窗口角色的隔离/Node/沙箱实测值 + CSP 扫描 + 暴露面分类 */
  securitySwitches: () => ipcRenderer.invoke('nyx:security:switches'),

  /** 注入演示（C3）：在一次性同构窗口里真去拿 require / 动态求值 / 改写暴露面 */
  securityProbe: () => ipcRenderer.invoke('nyx:security:probe'),

  /** 录屏 / 被远控检测（C4）：读本机进程，看有没有录屏 / 远控 / 会议程序在跑 */
  screenWatch: (payload) => ipcRenderer.invoke('nyx:screen:watch', payload || {}),

  /** 用户对「无法确认是否在录屏」的显式确认（10 分钟内有效） */
  screenWatchAck: () => ipcRenderer.invoke('nyx:screen:ack'),

  /** agent 急停状态（D）：stopped / 原因 / 热键 / 审计统计 */
  agentStatus: () => ipcRenderer.invoke('nyx:agent:status'),

  /** agent 审计记录（D）：时间/站点/动作/判定/结果/耗时/参数摘要，支持筛选 */
  agentAudit: (filters) => ipcRenderer.invoke('nyx:agent:audit', filters || {}),

  /** 导出审计记录（D）：format='csv'|'json'，给了 path 就直接写 */
  agentAuditExport: (payload) => ipcRenderer.invoke('nyx:agent:audit-export', payload || {}),

  /** 清空内存里的审计缓冲（磁盘 jsonl 不动） */
  agentAuditClear: () => ipcRenderer.invoke('nyx:agent:audit-clear'),

  /** 紧急停止（D）：中断在途动作并拒绝后续，直到 resume */
  agentStop: (reason) => ipcRenderer.invoke('nyx:agent:stop', { reason: String(reason || '') }),

  /** 恢复 agent 操作 */
  agentResume: () => ipcRenderer.invoke('nyx:agent:resume'),

  /** 订阅急停状态推送（返回取消订阅） */
  onAgentStatus: (handler) => {
    const listener = (_event, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('nyx:agent:status', listener);
    return () => ipcRenderer.removeListener('nyx:agent:status', listener);
  },

  /** 站点三层授权（E）：读名单、当前站点的判读、会话信任列表 */
  agentSites: (payload) => ipcRenderer.invoke('nyx:agent:sites', payload || {}),

  /** 站点三层授权（E）：改全局开关、加/删白名单与屏蔽名单、信任/清空会话 */
  agentSitesSet: (payload) => ipcRenderer.invoke('nyx:agent:sites-set', payload || {}),
  /** 站点名单导入导出（候选④）：导出走保存框，导入默认并入现有名单 */
  agentSitesExport: () => ipcRenderer.invoke('nyx:agent:sites-export'),
  agentSitesImport: (payload) => ipcRenderer.invoke('nyx:agent:sites-import', payload || {}),
  // agent 接入模式（清单 A）：切换要两次确认，第二次还得勾风险；改完要重启才生效。
  agentMode: () => ipcRenderer.invoke('nyx:agent:mode'),
  agentModeSet: (payload) => ipcRenderer.invoke('nyx:agent:mode-set', payload || {}),
  // agent 改设置（用户第 6 项）：只读 schema；修改只能走 agent 动作通道（带人工确认与留痕）
  agentSettings: () => ipcRenderer.invoke('nyx:agent:settings'),
  agentSettingsAudit: (payload) => ipcRenderer.invoke('nyx:agent:settings-audit', payload || {}),
  agentSettingsAuditExport: (payload) => ipcRenderer.invoke('nyx:agent:settings-audit-export', payload || {}),
  // 页面摘要（清单 F）：纯抽取式，默认关；关着时 run 会回一个明确原因
  digestGet: () => ipcRenderer.invoke('nyx:digest:get'),
  digestPanel: (payload) => ipcRenderer.invoke('nyx:digest:panel', payload || {}),
  /**
   * 顶栏「更多」菜单展开时让外壳底部临时加高（0 = 恢复）。
   * 不加高的话菜单会伸到标签视图那块，被原生视图盖住。
   */
  shellExtra: (payload) => ipcRenderer.invoke('nyx:shell:extra', payload || {}),
  // 清单 A5：agent 状态面板（三色灯 + 最近动作 + 急停）
  agentPanel: (payload) => ipcRenderer.invoke('nyx:agent:panel', payload || {}),
  // 清单 D1：按当前真实状态生成的接入说明（端点 / 鉴权 / 能做什么 / 会被拦什么 / 出错看哪）
  agentDoc: () => ipcRenderer.invoke('nyx:agent:doc'),
  agentDocCopy: () => ipcRenderer.invoke('nyx:agent:doc-copy'),
  agentDocSave: () => ipcRenderer.invoke('nyx:agent:doc-save'),
  // 清单 A3：进程详情（PID 与系统任务管理器一致，可复制对照）
  processList: () => ipcRenderer.invoke('nyx:proc:list'),
  processCopy: (payload) => ipcRenderer.invoke('nyx:proc:copy', payload || {}),
  pageScreenshot: () => ipcRenderer.invoke('nyx:page:screenshot'),
  digestSet: (payload) => ipcRenderer.invoke('nyx:digest:set', payload || {}),
  digestRun: (payload) => ipcRenderer.invoke('nyx:digest:run', payload || {}),
  digestCopy: (text) => ipcRenderer.invoke('nyx:digest:copy', { text: String(text || '') }),
  digestExport: (result, format) =>
    ipcRenderer.invoke('nyx:digest:export', { result: result || null, format: format === 'csv' ? 'csv' : 'md' }),

  /** 标签休眠阈值（分钟，0 = 不自动休眠）：读 / 改，改完立刻生效 */
  tabSleep: () => ipcRenderer.invoke('nyx:tabs:sleep'),
  tabSleepSet: (payload) => ipcRenderer.invoke('nyx:tabs:sleep-set', payload || {}),
  // 整机在线/离线：外壳横幅用它，别在渲染层自己猜 navigator.onLine
  netState: () => ipcRenderer.invoke('nyx:net:state'),


  /** 权限决策轨迹（默认最近 50 条） */
  listPermissionDecisions: (limit) => ipcRenderer.invoke('nyx:permissions:list', limit),

  /** 清空"按站点已记住的授权"（只清会话缓存，不碰持久白名单） */
  clearPermissionCache: () => ipcRenderer.invoke('nyx:permissions:clear'),

  /** 撤销某个站点的设备白名单；permission 省略表示撤销该站点全部设备 */
  revokePermission: (origin, permission) =>
    ipcRenderer.invoke('nyx:permissions:revoke', { origin, permission }),

  /** 清空站点设备授权白名单 */
  clearPermissionWhitelist: () => ipcRenderer.invoke('nyx:permissions:whitelist-clear'),

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

  /** 打开设置标签页（已在则切回）；传 { section } 可直接跳到某个分区 */
  openSettings: (payload) => ipcRenderer.invoke('nyx:proxy:open', payload || {}),

  /** 起始页（清单 B1）：输入关键词或网址后交给主进程开普通标签 */
  startOpen: (input) => ipcRenderer.invoke('nyx:start:open', { input: String(input || '') }),

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

  /* ---------------- 诊断（清单 C1） ---------------- */

  /** 诊断页顶部状态：版本、运行状态（模式/链路/代理/GPU）、记录条数 */
  getDiagnosticsStatus: () => ipcRenderer.invoke('nyx:diagnostics:status'),

  /** 最近 N 条诊断记录（新的在前，默认 20 条） */
  listDiagnostics: (limit) => ipcRenderer.invoke('nyx:diagnostics:list', limit),

  /** 清空内存缓冲与落盘日志（用户主动「清空记录」时用） */
  clearDiagnostics: () => ipcRenderer.invoke('nyx:diagnostics:clear'),

  /** 导出诊断包（ZIP）；给了 payload.path 就直接写该路径，否则弹保存对话框 */
  exportDiagnostics: (payload) => ipcRenderer.invoke('nyx:diagnostics:export', payload || {}),

  /** 在资源管理器中打开诊断日志目录 */
  openDiagnosticsFolder: () => ipcRenderer.invoke('nyx:diagnostics:open-folder'),

  /* ---------------- 主界面加载失败页（A4） ---------------- */

  /** 重试当前标签上一次失败的地址 */
  errorRetry: () => ipcRenderer.invoke('nyx:error:retry'),

  /** 打开设置中心并直接落到「诊断」分区 */
  errorOpenDiagnostics: () => ipcRenderer.invoke('nyx:error:diagnostics'),

  /** 复制失败详情（错误码 / 原因 / 地址 / 模式链路）到剪贴板 */
  errorCopyDetail: (text) => ipcRenderer.invoke('nyx:error:copy', { text }),

  /** 断网时取这一页的离线快照（只有真的缓存过才 available:true） */
  errorCachedPage: (payload) => ipcRenderer.invoke('nyx:error:cached', payload || {}),

  /** 离线阅读缓存：读开关与条目数 / 开关（关掉会清空）/ 清空 */
  offlineCacheGet: () => ipcRenderer.invoke('nyx:offline:get'),
  offlineCacheSet: (payload) => ipcRenderer.invoke('nyx:offline:set', payload || {}),
  offlineCacheClear: () => ipcRenderer.invoke('nyx:offline:clear'),
  offlineCachePrivateReset: () => ipcRenderer.invoke('nyx:offline:private-reset'),
  offlineCacheSites: () => ipcRenderer.invoke('nyx:offline:sites'),
  offlineCacheSitesSet: (payload) => ipcRenderer.invoke('nyx:offline:sites-set', payload || {}),
  // 隐私名单的「只存这些」模板（模板只并进现有名单，不替换）
  offlineCachePrivateTemplates: () => ipcRenderer.invoke('nyx:offline:private-templates'),
  offlineCachePrivateTemplateApply: (payload) =>
    ipcRenderer.invoke('nyx:offline:private-template-apply', payload || {}),
  // 自己攒的模板：把当前名单存成模板 / 删掉一个（模板本身可搬走，名单不受影响）
  offlineCachePrivateTemplateSave: (payload) =>
    ipcRenderer.invoke('nyx:offline:private-template-save', payload || {}),
  offlineCachePrivateTemplateRemove: (payload) =>
    ipcRenderer.invoke('nyx:offline:private-template-remove', payload || {}),
  offlineCacheSitesExport: (payload) => ipcRenderer.invoke('nyx:offline:sites-export', payload || {}),
  offlineCacheSitesImport: (payload) => ipcRenderer.invoke('nyx:offline:sites-import', payload || {}),
  // 模板本身也能搬走：和名单是两个 kind，导错文件会被明确拒绝
  offlineCachePrivateTemplatesExport: () => ipcRenderer.invoke('nyx:offline:private-templates-export'),
  offlineCachePrivateTemplatesImport: (payload) =>
    ipcRenderer.invoke('nyx:offline:private-templates-import', payload || {}),

  /** 订阅「切到某个设置分区」指令（主界面错误页跳诊断用），返回取消订阅函数 */
  onSettingsSection: (handler) => {
    const listener = (_event, section) => handler(section);
    ipcRenderer.on('nyx:settings:section', listener);
    return () => ipcRenderer.removeListener('nyx:settings:section', listener);
  },

  /* ---------------- 下载中心（A1） ---------------- */

  /** 打开（或复用）下载中心窗口 */
  openDownloads: () => ipcRenderer.invoke('nyx:downloads:open'),

  /** 下载列表 + 汇总（工具栏角标用） */
  listDownloads: () => ipcRenderer.invoke('nyx:downloads:list'),

  /**
   * 订阅下载状态推送（进行中数量 → 工具栏角标）。
   * @param {(payload:{items:Array<object>, summary:object})=>void} handler
   * @returns {() => void} 取消订阅
   */
  onDownloadsState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('nyx:downloads:state', listener);
    return () => ipcRenderer.removeListener('nyx:downloads:state', listener);
  },

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

  /** 扫描本页面上看得见的图片 / 图标 / 背景图 / 矢量图 / 视频封面 */
  mediaScan: () => ipcRenderer.invoke('nyx:tb:media-scan'),

  /** 把勾选的那几条存到用户选的目录：{ items: [{ url, name }] } */
  mediaSave: (payload) => ipcRenderer.invoke('nyx:tb:media-save', payload || {}),

  /** 取一条媒体的预览图（回 data: URL）：{ url } */
  mediaThumb: (payload) => ipcRenderer.invoke('nyx:tb:media-thumb', payload || {}),

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
  // 差分命中率实测（只在用户点按钮时跑，结果落盘）
  updateDeltaCheck: (payload) => ipcRenderer.invoke('nyx:update:delta-check', payload || {}),

  // 夜间安装器 e2e 的最近一次结果（只读；跑不跑是命令行的事）
  nightlyStatus: () => ipcRenderer.invoke('nyx:nightly:status'),
  // 夜间计划任务：改时间 / 删任务（只改"什么时候跑"，不给"现在就跑"）
  nightlyTask: () => ipcRenderer.invoke('nyx:nightly:task'),
  nightlyTaskSet: (payload) => ipcRenderer.invoke('nyx:nightly:task-set', payload || {}),
  nightlyTaskRemove: () => ipcRenderer.invoke('nyx:nightly:task-remove'),

  /** 在资源管理器里打开更新源目录 */
  updateOpenSource: () => ipcRenderer.invoke('nyx:update:open-source'),

  /** 把清理命令写进剪贴板：{ ok, command } */
  updateCopyCleanCommand: () => ipcRenderer.invoke('nyx:update:copy-clean-command'),

  /* ---------------- 抓包慢请求阈值（v1.16.0） ---------------- */

  /** 读慢请求阈值：{ ok, slowMs, min, max, fallback } */
  tbSlowMs: () => ipcRenderer.invoke('nyx:tb:slow-ms'),
  /** 写慢请求阈值：ms → { ok, slowMs }（越界返回中文错误） */
  tbSlowMsSet: (ms) => ipcRenderer.invoke('nyx:tb:slow-ms-set', { slowMs: ms }),

  /* ---------------- agent 导航预算（v1.17.17） ---------------- */

  /** 读导航预算：{ ok, navigateTimeoutMs, min, max, fallback, example } */
  tbNavigateTimeout: () => ipcRenderer.invoke('nyx:tb:navigate-timeout'),
  /** 写导航预算：ms → { ok, navigateTimeoutMs, example }；带 sitesText 时同时写按站点的规则 */
  tbNavigateTimeoutSet: (payload) =>
    ipcRenderer.invoke(
      'nyx:tb:navigate-timeout-set',
      payload && typeof payload === 'object' ? payload : { navigateTimeoutMs: payload }
    ),

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
