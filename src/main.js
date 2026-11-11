'use strict';

/**
 * Nyx —— 双模式隐私浏览器 · 主进程入口
 *
 * 职责：
 *   1. 应用生命周期与单实例控制；
 *   2. 普通 / 隐私双 Session 分区；
 *   3. 内置代理内核（mihomo，随浏览器启停）与 WebRTC 防泄漏，外置 Clash 作为回落；
 *   4. 标签（WebContentsView）管理；
 *   5. 托盘常驻与全局恐慌快捷键（一键关闭 + 清场）；
 *   6. 独立「设置」窗口（外观 / 启动与主页 / 隐私与安全 / 网络与代理（订阅、节点、测速、出口自查）/ 下载 / 关于与更新，全中文）；
 *   7. 启动本地 AI 操作接口（HTTP + MCP）。
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
// Edge Cookie 导入模块：复制 Cookies 库 + ABE/DPAPI 解密 + node:sqlite 读取
const edgeCookieImport = require('./core/edge-cookie-import');
// Node 原生 net 模块（等价于 require('net')，显式带 node: 前缀与文件内其他 require 保持一致）。
// 用于 isProxyReachable() 做 TCP 可达性探测，必须在模块顶层声明，否则启动路径会抛 ReferenceError。
const net = require('node:net');
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  // 系统对话框：升级提示、错误告知等一律走系统弹窗，文案全中文
  dialog,
  // 屏幕信息：书签浮层定位时按工作区边界做越界收敛
  screen,
  // 打开资源管理器定位升级包目录等
  shell,
  // Electron 的网络模块（Chromium 网络栈）。注意别名：net 这个名字已被上面的
  // node:net 占用，用于代理端口的 TCP 可达性探测。
  net: electronNet,
  // 系统级加密（Windows 走 DPAPI，绑定当前用户账户）：密码库唯一的加密来源。
  // 加密不可用时密码库拒绝一切写入，宁可不存也不明文落盘。
  safeStorage,
  // 工具箱「复制」用：写系统剪贴板，比在渲染层调 navigator.clipboard 稳
  clipboard,
} = require('electron');

const sessions = require('./core/sessions');
const { PrivacyHardening } = require('./core/privacy-hardening');
const { Vault } = require('./core/vault');
const { ProxyService } = require('./core/proxy-service');
const { TabManager, normalizeInput } = require('./core/tabs');
const { createActionRunner } = require('./core/actions');
const { getRiskLog } = require('./core/risk-guard');
const { startHttpApi } = require('./api/http-api');
const { createModeEventLog } = require('./core/mode-events');
const { Updater } = require('./core/updater');
const { UiStore } = require('./core/ui-store');
const { StartupStore } = require('./core/startup-store');
const { ExtensionManager } = require('./core/extensions');
const { Toolbox } = require('./core/toolbox');
const { PageTools, UA_PRESETS, DEVICE_PRESETS, THROTTLE_PRESETS } = require('./core/toolbox-devtools');
const { SmartPatrol } = require('./core/smart-patrol');
const { getHardwareStatus } = require('./core/hardware');
const { HistoryStore } = require('./core/history-store');
const { SiteIcons } = require('./core/site-icons');
const { BookmarkStore } = require('./core/bookmark-store');

/**
 * 验收 / 调试用的隔离用户数据目录（环境变量 NYX_USER_DATA）。
 *
 * 只在显式传入时生效：验收脚本能在临时目录里复现"首次启动""代理离线"等状态，
 * 全程不读写真实用户的 %APPDATA%\Nyx。必须赶在单实例锁与任何 userData 读取之前设置，
 * 否则锁会落在真实目录上（隔离就形同虚设）。
 */
if (process.env.NYX_USER_DATA) {
  try {
    const isolated = path.resolve(process.env.NYX_USER_DATA);
    fs.mkdirSync(isolated, { recursive: true });
    app.setPath('userData', isolated);
    console.log(`[Nyx] 使用隔离用户数据目录：${isolated}`);
  } catch (err) {
    console.warn('[Nyx] 隔离用户数据目录不可用，将继续使用默认目录：', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** UI 外壳高度（px），必须与 renderer/style.css 的 --height-shell 一致 */
const UI_HEIGHT = 124;
/**
 * 主题底色映射：与 renderer/theme-nyx.css 里各主题的 --bg-shell 保持一致。
 *
 * 两个窗口的 BrowserWindow backgroundColor 决定"窗口出现前"的底色，CSS 管不到：
 * 不跟随主题的话，切到浅色主题（素纸）启动时会先闪一下深色。
 */
const THEME_BG = { ink: '#0c0a09', aurora: '#080b16', paper: '#f5f1e8', quiet: '#17181a' };
/** 标签数上限，可用环境变量 NYX_MAX_TABS 覆盖 */
const MAX_TABS = Math.max(1, Number(process.env.NYX_MAX_TABS || 12));
/** 恐慌清场快捷键 */
const PANIC_SHORTCUT = process.env.NYX_PANIC_SHORTCUT || 'CommandOrControl+Shift+X';
/** 新标签初始地址 */
const HOME_URL = process.env.NYX_HOME_URL || 'about:blank';
/** 托盘图标 */
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
/** 代理可达性探测超时（ms），可用环境变量 NYX_PROXY_PROBE_TIMEOUT 覆盖 */
const PROXY_PROBE_TIMEOUT = Math.max(
  200,
  Number(process.env.NYX_PROXY_PROBE_TIMEOUT || 2000),
);
/** 上次使用模式的持久化文件名（只记录模式名，不涉及任何浏览数据） */
const LAST_MODE_FILE = 'last-mode.txt';
/**
 * 普通模式的链路复核周期（ms）。
 *
 * 普通模式不依赖代理，但代理"中途启停"必须能自动跟随（用户开/关 Clash、
 * 内核被拉起/停掉）。周期复核比给每个页面挂网络状态监听稳妥得多；
 * 默认 60s 足够覆盖人工开关代理的节奏，又不会带来持续的探测开销。
 */
const LINK_RECHECK_MS = Math.max(5_000, Number(process.env.NYX_LINK_RECHECK_MS || 60_000));
/**
 * 视为"链路可能失效"的加载错误码（Chromium net error）。
 *   -130 ERR_PROXY_CONNECTION_FAILED / -102 ERR_CONNECTION_REFUSED /
 *   -101 ERR_CONNECTION_RESET / -104 ERR_CONNECTION_FAILED /
 *   -118 ERR_CONNECTION_TIMED_OUT / -105 ERR_NAME_NOT_RESOLVED
 */
const PROXY_FAILURE_CODES = new Set([-130, -102, -101, -104, -118, -105]);
/** 模式变更事件缓冲容量（内存环形缓冲，仅保留最近 50 条，供本地接口查询） */
const MODE_EVENT_LIMIT = 50;
/** 代理状态与内核运行目录名（位于 userData 下） */
const PROXY_STATE_DIR = 'proxy';
/** 密码与表单记忆库目录名（位于 userData 下，密文落盘文件为 nyx-vault.json） */
const VAULT_STATE_DIR = 'vault';
/**
 * 出口画像缓存有效期（ms）。
 *
 * 出口自查是真实外联请求，而"切换模式"是高频操作——每次都自查既慢又多余。
 * 缓存未过期时直接复用；过期或为空才重新自查一次。
 */
const EGRESS_CACHE_TTL_MS = Math.max(10_000, Number(process.env.NYX_EGRESS_CACHE_TTL || 300_000));
/**
 * 单次出口自查的最长等待（ms）。
 *
 * 超时按"出口未知"处理：profile 仍会做其余加固，只是不对齐时区——
 * 宁可明说"没对齐"，也不能把时区猜错（错时区比不对齐更容易被识别）。
 */
const EGRESS_MAX_WAIT_MS = Math.max(1_000, Number(process.env.NYX_EGRESS_WAIT || 6_000));
/**
 * 随包预置的内核根目录；其下 mihomo/ 内放 mihomo.exe 与 geo 数据。
 * 开发期取项目 vendor/，打包后由 extraResources 落到 resources/vendor，
 * 必须取磁盘实路径而非 asar 内路径——可执行文件无法从 asar 直接拉起。
 */
const KERNEL_VENDOR_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'vendor')
  : path.join(__dirname, '..', 'vendor');

/* ------------------------------------------------------------------ */
/* 启动前安全开关（必须在 app ready 之前设置）                          */
/* ------------------------------------------------------------------ */

// 强制 WebRTC 只使用代理链路，禁用非代理 UDP，避免真实 IP 通过 STUN 泄漏
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

// 充分利用 GPU：开启 GPU 光栅化、零拷贝合成，并放开显卡黑名单（保证独显 / 核显都能吃到硬件加速）
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// 启用 WebNN（Chromium 131+ 可用，需 secure context；file:// 由 unsafely 开关补齐）
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'file://');

/* ------------------------------------------------------------------ */
/* 运行期状态                                                          */
/* ------------------------------------------------------------------ */

const runtime = {
  mainWindow: null,
  tabManager: null,
  tray: null,
  apiServer: null,
  apiPort: null,
  apiToken: null,
  /** 内置代理编排（订阅管理 + mihomo 内核生命周期） */
  proxyService: null,
  /** 设置窗口（独立 BrowserWindow；原「代理中心」已整页并入设置） */
  proxyWindow: null,
  /** 界面偏好（顶栏元素显隐等，落盘于 <userData>/ui-preferences.json） */
  uiStore: null,
  startupStore: null,
  /** 全隐私模式的会话级加固装配（UA / 请求头 / 时区语言对齐 / WebRTC 策略） */
  hardening: null,
  /** 密码与表单记忆库（safeStorage 加密后落盘，只在填充瞬间解密） */
  vault: null,
  panicking: false,
  quitting: false,
  /** 渲染层尚未就绪时暂存的提示，待页面加载完成后推送 */
  pendingNotice: null,
  /** 自动升级服务（检查 / 获取升级包 / 静默覆盖安装） */
  updater: null,
  /** 升级弹窗是否正在展示，避免重复弹窗 */
  updateDialogOpen: false,
  /**
   * 代理可达性状态（最近一次探测结果）。
   * 链路本身以 sessions.getLink() 为准，这里只放"探测结论"，避免两份链路状态打架。
   */
  network: { proxyReachable: null, checkedAt: 0, note: '' },
  /** 普通模式链路复核定时器 */
  linkTimer: null,
  /** 代理失效降级是否正在处理（防重入：一次加载失败可能牵出多个错误码） */
  linkGuardBusy: false,
  /** 工具箱内核：资源嗅探与网络抓包（CDP 采集） */
  toolbox: null,
  /** 工具箱页面环境能力：开发者模式 / 元素拾取 / UA / 视口 / 限速 / 截图 */
  pageTools: null,
  /** 工具箱抽屉是否展开（标签视图据此让出右侧宽度） */
  toolboxOpen: false,
  /** 抽屉宽度（px），与渲染层 TOOLBOX_WIDTHS 保持一致 */
  toolboxWidth: 460,
};

/**
 * 模式变更事件缓冲（纯内存，不落盘）。
 * 记录全部模式切换请求（含被拒绝的）与启动时的模式恢复决策，
 * 供本地接口 GET /mode/events 查询，用于自动化测试断言"运行中模式切换"路径。
 */
const modeEventLog = createModeEventLog(MODE_EVENT_LIMIT);

/* ------------------------------------------------------------------ */
/* 单实例运行                                                          */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[Nyx] 启动失败：', err);
    app.exit(1);
  });
}

/* ------------------------------------------------------------------ */
/* 启动流程                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  registerIpc();

  /**
   * 权限管理器必须在任何 session 建立之前注入。
   *
   * Session 一旦装配就把权限回调绑定在当时那个管理器实例上（且 configureSessionOnce
   * 保证只装配一次），之后再换实例不会替换已绑定的回调——结果是弹窗拿不到父窗口、
   * 界面查到的审计列表来自另一个空实例。父窗口用取值函数延迟解析，
   * 因为此刻主窗口还没创建。
   */
  sessions.initPermissions({
    getWindow: () => runtime.mainWindow,
    log: (entry) =>
      console.log(
        `[Nyx] 权限决策｜模式：${entry.mode}｜站点：${entry.origin}｜${entry.permission} → ` +
          `${entry.granted ? '允许' : '拒绝'}｜依据：${entry.via}`,
      ),
  });

  // 密码库与隐私加固装配器先就绪：恢复隐私模式时要立刻用它们下发 profile
  initUiStore();
  initStartupStore();
  initVault();
  initHistoryStore();
  initBookmarkStore();
  initSiteIcons();
  initPrivacyHardening();

  // 内置代理内核先于会话建立：端口要等内核真正监听后才能确定，
  // 而两个 session 的代理必须指向这个端口，顺序不能颠倒。
  await bootstrapProxyKernel();

  // 恢复上次模式：若上次是隐私模式，必须先校验代理可达性（不可达则回落普通模式）
  let startupNotice = await restoreLastMode();

  // 预装配两个 session（写入代理、风控策略与 WebRTC 策略）
  sessions.getSession('normal');
  sessions.getSession('private');

  // 普通模式下载处理器（隐私分区已整体禁止下载落盘）
  installDownloadHandler();

  // 扩展管理器：必须在普通分区建立之后初始化（扩展装到分区上，不装到进程上）
  initExtensions();

  // 工具箱：只建实例不建通道，真正的 CDP 挂载等抽屉展开时才做（避免空跑开销）
  initToolbox();

  // 启动即处于隐私模式：必须在任何标签建立之前把 profile 装到隐私分区上，
  // 否则首个标签会带着未加固的指纹加载（顺序与手动切换保持一致）。
  if (sessions.getMode() === 'private') {
    const applied = await applyPrivacyHardening();
    if (!applied.ok) {
      console.warn(`[Nyx] 启动阶段隐私加固装配失败：${applied.error}；已回落普通模式`);
      sessions.setMode('normal');
      writeLastMode('normal');
      startupNotice = {
        level: 'error',
        code: 'HARDENING_FAILED',
        title: '隐私加固装配失败，已回落普通模式',
        message:
          `无法把隐私 profile 下发到隐私分区（${applied.error}）。` +
          '为避免"名义隐私、实际暴露"，本次启动使用普通模式。',
      };
    }
  }

  runtime.pendingNotice = startupNotice;

  // 应用菜单统一为中文（主窗口默认隐藏菜单栏，按 Alt 可唤出）
  installChineseMenu();

  createMainWindow();
  createTray();
  registerPanicShortcut();

  await startLocalApi();

  // 普通模式链路复核：代理随时可能被用户开关，启动完成后开始周期探测
  // （隐私模式下复核函数会直接返回，不会碰隐私分区的链路）
  startLinkWatchdog();

  // 自动升级服务最后初始化：它只依赖 userData 目录与托盘，不参与启动关键路径
  initUpdater();

  // 桌面快捷方式兜底：静默安装（自动升级）时安装器不会建桌面图标，应用侧自查自补
  ensureDesktopShortcut();

  console.log(
    `[Nyx] 就绪｜模式：${sessions.getMode()}｜出站链路：${sessions.getLink()}｜` +
      `代理端口：${sessions.getProxyPort()}｜标签上限：${MAX_TABS}｜恐慌快捷键：${PANIC_SHORTCUT}`,
  );
}

/**
 * 初始化密码与表单记忆库。
 *
 * 加密只有一个来源：Electron safeStorage（Windows 上落到 DPAPI，密钥绑定当前
 * 用户账户）。系统加密不可用时 Vault 自身会拒绝一切写入，这里只负责把路径与
 * 依赖装好；日志只收 Vault 抛出的非敏感文案（本模块不接收任何明文密码）。
 */
/**
 * 界面偏好存储：顶栏元素显隐一类的纯外观开关。
 *
 * 落盘在 <userData>/ui-preferences.json，读取失败一律回落默认值，
 * 保证顶栏永远有一份可用配置。
 */
function initUiStore() {
  runtime.uiStore = new UiStore({ stateDir: app.getPath('userData') });
}

/**
 * 启动与主页配置：新标签页地址与启动时打开的页面。
 *
 * 落盘在 <userData>/startup-preferences.json。与界面偏好分开存放：
 * 这里的值是地址字符串与列表，校验规则和布尔开关完全不同。
 */
function initStartupStore() {
  runtime.startupStore = new StartupStore({ stateDir: app.getPath('userData') });
}

function initVault() {
  runtime.vault = new Vault({
    stateDir: path.join(app.getPath('userData'), VAULT_STATE_DIR),
    safeStorage,
    log: (level, text) => {
      if (level === 'error') console.warn(`[Nyx] 密码库：${text}`);
    },
  });
  const stats = runtime.vault.stats();
  console.log(
    `[Nyx] 密码库就绪｜可用：${stats.available ? '是' : '否'}｜加密后端：${stats.backend}｜` +
      `条目：${stats.credentials} 个来源 / ${stats.forms} 份表单记忆｜文件：${stats.file}`,
  );
  return runtime.vault;
}

/**
 * 初始化历史记录存储。
 *
 * 落盘在 <userData>/history.json，启动时加载到内存；
 * 导航钩子（见 hookHistoryRecording）负责写入，隐私模式绝不写入。
 */
function initHistoryStore() {
  runtime.historyStore = new HistoryStore({ stateDir: app.getPath('userData') });
  runtime.historyStore.load();
  console.log(
    `[Nyx] 历史记录就绪｜条目：${runtime.historyStore.list().length}｜文件：${runtime.historyStore.statePath}`,
  );
  return runtime.historyStore;
}

/**
 * 初始化站点图标缓存（v1.6.0：地址栏建议与工具箱共用同一份 <userData>/site-icons）。
 * 网络请求注入 electronNet.fetch：走 Chromium 网络栈、跟随代理，与产品出站纪律一致。
 */
function initSiteIcons() {
  runtime.siteIcons = new SiteIcons({
    stateDir: app.getPath('userData'),
    fetchImpl: (url, init) => electronNet.fetch(url, init),
  });
  return runtime.siteIcons;
}

/**
 * 初始化书签（收藏）存储。
 *
 * 落盘在 <userData>/bookmarks.json；localAppData 用于从 Edge / Chrome
 * 导入书签文件（%LOCALAPPDATA%\Microsoft\Edge 与 %LOCALAPPDATA%\Google\Chrome）。
 */
function initBookmarkStore() {
  let localAppData;
  try {
    localAppData = app.getPath('localAppData');
  } catch (e) {
    // 个别环境（便携/服务会话）取不到 localAppData 时退回环境变量
    localAppData = process.env.LOCALAPPDATA || '';
  }
  runtime.bookmarkStore = new BookmarkStore({
    stateDir: app.getPath('userData'),
    localAppData,
  });
  runtime.bookmarkStore.load();
  console.log(
    `[Nyx] 书签就绪｜条目：${runtime.bookmarkStore.count()}｜文件：${runtime.bookmarkStore.statePath}`,
  );
  return runtime.bookmarkStore;
}

/**
 * 初始化扩展插件管理器（兼容 Edge / Chrome 扩展）。
 *
 * 时机要求：必须在普通模式分区（persist:nyx-normal）建立之后——扩展是装载到
 * 分区上而不是进程上的。隐私分区永不装载扩展：扩展能读页面内容、能外发数据，
 * 与"全隐私"互斥，这条在产品口径上不做开关，写死在分区选择里。
 */
function initExtensions() {
  runtime.extensions = new ExtensionManager({
    stateDir: path.join(app.getPath('userData'), 'extensions'),
    // 固定取普通分区：任何调用方都无法把扩展装进隐私分区
    getSession: () => sessions.getSession('normal'),
    log: (level, text) => {
      if (level === 'error') console.warn(`[Nyx] 扩展：${text}`);
      else console.log(`[Nyx] 扩展：${text}`);
    },
  });

  const ready = runtime.extensions.init();
  if (ready.count > 0) {
    console.log(
      `[Nyx] 扩展仓库就绪｜登记：${ready.count} 个｜目录：${runtime.extensions.storePath}`,
    );
  }

  // 装载是异步的：不占用启动关键路径。装载完成前已打开的标签不会注入内容脚本，
  // 界面提供「刷新全部标签」按钮让用户显式生效。
  runtime.extensions
    .loadAll()
    .then((result) => {
      if (result.total > 0) {
        console.log(`[Nyx] 扩展装载结果：${result.loaded}/${result.total}（普通模式分区）`);
      }
    })
    .catch((err) => console.warn('[Nyx] 扩展装载异常：', err.message));

  return runtime.extensions;
}

/** 初始化全隐私模式的会话级加固装配器 */
function initPrivacyHardening() {
  runtime.hardening = new PrivacyHardening({
    log: (entry) => {
      if (entry && entry.level === 'error') console.warn(`[Nyx] 隐私加固：${entry.text}`);
    },
  });
  return runtime.hardening;
}

/**
 * 判断某个 IPC 调用方所在的分区（决定它能读到什么）。
 *
 * 以分区名为准而不是"当前全局模式"：切换过程中旧标签可能还在销毁，
 * 用分区判断才能保证"隐私分区里的页面拿不到密码与表单记忆"，反之亦然。
 * 无法识别分区时（UI 外壳走默认 session）回落到当前模式。
 */
function senderMode(event) {
  try {
    const ses = event && event.sender ? event.sender.session : null;
    const partition = ses && typeof ses.getPartition === 'function' ? ses.getPartition() : '';
    if (partition === sessions.PARTITIONS.private) return 'private';
    if (partition === sessions.PARTITIONS.normal) return 'normal';
  } catch {
    /* 忽略：取不到分区就按当前模式处理 */
  }
  return sessions.getMode();
}

/**
 * 取用于构建隐私 profile 的出口画像。
 *
 * 缓存优先：出口自查是真实外联请求，不应被"切换模式"这种高频操作反复触发；
 * 缓存过期或为空时才发起一次自查。自查本身带超时上限，超时按"出口未知"处理——
 * 出口未知时 profile 仍会做其余加固，只是不伪装时区（宁可不对齐也不对错）。
 */
async function resolveEgressForProfile() {
  const service = runtime.proxyService;
  if (!service) return { egress: null, egressUnknown: true, error: '代理服务未就绪' };

  const cached = service.egressProfile();
  if (cached && cached.ip && cached.checkedAt && Date.now() - cached.checkedAt < EGRESS_CACHE_TTL_MS) {
    return { egress: cached, egressUnknown: false, reused: true };
  }

  try {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), EGRESS_MAX_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const fresh = await Promise.race([service.checkEgress().catch(() => null), timeout]);
    if (timer) clearTimeout(timer);

    const profile = service.egressProfile();
    if (profile && profile.ip) return { egress: profile, egressUnknown: false, reused: false };
    return {
      egress: null,
      egressUnknown: true,
      error: fresh && fresh.error ? fresh.error : `出口自查超时（${EGRESS_MAX_WAIT_MS}ms）`,
    };
  } catch (err) {
    return { egress: null, egressUnknown: true, error: err.message };
  }
}

/**
 * 进入隐私模式前的加固装配（顺序不能变）：
 *   1) 依据出口画像构建 profile（UA 主版本取真实内核，时区/语言对齐出口）；
 *   2) 下发到隐私分区：UA + Accept-Language + 请求头接管 + 客户端提示头自洽；
 *   3) 把同一份 profile 的两份载体交给标签管理器（argv 兜底 + 结构化配置权威）。
 * 任一步失败都返回 ok:false，由调用方拒绝进入隐私模式（不做"半加固"的隐私模式）。
 */
async function applyPrivacyHardening() {
  if (!runtime.hardening) return { ok: false, error: '隐私加固模块未初始化' };

  const egressInfo = await resolveEgressForProfile();
  const profile = runtime.hardening.buildProfile({
    egress: egressInfo.egress,
    egressUnknown: egressInfo.egressUnknown,
  });

  const applied = runtime.hardening.applySession(sessions.getSession('private'), profile);
  if (!applied.ok) return { ok: false, error: applied.error || '会话加固下发失败' };

  sessions.setPreloadArgs('private', runtime.hardening.preloadArgs(profile));
  sessions.setPreloadConfig('private', runtime.hardening.preloadConfig(profile));

  console.log(
    `[Nyx] 隐私加固已装配｜UA：Chrome/${profile.chromeMajor}｜出口 IP：${profile.exitIp || '未知'}` +
      `｜时区：${profile.timezone || '未对齐'}｜语言：${profile.acceptLanguage}` +
      `${egressInfo.egressUnknown ? `（出口信息未知：${egressInfo.error || '未取到'}）` : ''}`,
  );
  return { ok: true, profile, egressUnknown: egressInfo.egressUnknown, error: egressInfo.error || null };
}

/**
 * 离开隐私模式：复位 profile，并把预加载参数退回"无伪装"基线。
 *
 * 复位是必须的——否则下次进入隐私模式会复用上一次的出口时区与会话种子，
 * 等于换了个代理却还用着上一个会话的指纹。复位后 profile 置空，
 * 两份载体自动退化为只带模式的基线值。
 */
function resetPrivacyHardening() {
  if (!runtime.hardening) return { ok: false, error: '隐私加固模块未初始化' };

  const result = runtime.hardening.reset();
  sessions.setPreloadArgs('private', runtime.hardening.preloadArgs(null));
  sessions.setPreloadConfig('private', runtime.hardening.preloadConfig(null));
  console.log('[Nyx] 隐私加固已复位（profile 置空，预加载参数回到基线）');
  return result;
}

/**
 * 拉起内置代理内核（失败不阻断启动，自动回落外置 Clash Verge 端口）。
 *
 * 隐私模式的前提是"流量确实经代理出去"，因此内核就绪必须放在会话建立之前：
 * 端口一旦确定就注入 sessions，之后两个分区建立的连接直接指向内置内核；
 * 内核起不来时保持回落端口，隐私模式仍会在探测失败时拒绝进入（绝不直连）。
 */
async function bootstrapProxyKernel() {
  const service = new ProxyService({
    stateDir: path.join(app.getPath('userData'), PROXY_STATE_DIR),
    vendorDir: KERNEL_VENDOR_DIR,
    /**
     * 订阅拉取固定走 Electron 的网络栈（Chromium + 系统证书库）。
     *
     * 本机装有卡巴斯基（含 HTTPS 扫描），链上会多出一张它签发的中间证书；
     * Node 自带 CA 列表不认这张证书，用 node:https 直连订阅会直接抛
     * "self-signed certificate in certificate chain"。Chromium 认系统证书库，
     * 因此这里注入 net.fetch，保证订阅在任何安全软件环境下都能拉到。
     */
    fetcher: (url, { timeoutMs = 20000 } = {}) =>
      electronNet.fetch(url, {
        headers: { 'User-Agent': 'ClashMetaForNyx/0.1', Accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      }),
    /**
     * 出口自查必须查"当前真正生效的代理端口"：内核在跑就用内核混合端口，
     * 内核没跑时浏览器实际走的是外置代理回退端口，此时只能查那个端口，
     * 否则会把直连结果误报成出口 IP（判定"代理生效/疑似泄漏"的前提就错了）。
     */
    resolveProxyPort: () => sessions.getProxyPort(),
  });
  runtime.proxyService = service;
  service.init();

  // 智能遨游调度（1.1.1）：遨游模式开启后每 15 秒巡检当前站点，
  // 国内直连 / 被墙走代理的 PAC 分流 + 节点质量定期重选。
  runtime.smartPatrol = new SmartPatrol({
    stateDir: path.join(app.getPath('userData'), 'smart'),
    getActiveUrl: () => {
      const tab = runtime.tabManager && runtime.tabManager.getActive();
      return tab ? tab.url || '' : '';
    },
    getProxyPort: () => sessions.getProxyPort(),
    onPacChanged: (pac) => {
      sessions.setSmartPac(pac).catch((err) => {
        console.warn(`[Nyx] 智能分流 PAC 下发失败：${err.message}`);
      });
      pushState(currentSnapshot());
    },
    onReselect: async () => {
      const svc = runtime.proxyService;
      if (!svc) return;
      try {
        // 节点质量评估：重新测速，若策略组为手动选择组则自动切到最优节点
        const res = await svc.autoTest();
        if (!res || !res.ok || !res.summary || res.summary.ok === 0) return;
        const best = res.summary.ranking[0];
        const snapshot = await svc.nodes();
        const group = snapshot.groups && snapshot.groups.find((g) => g.type === 'select');
        if (group && best && best !== group.now && Array.isArray(group.members) && group.members.includes(best)) {
          const picked = await svc.select(group.name, best);
          if (picked && picked.ok) {
            console.log(`[Nyx] 智能调度已自动优选节点：${best}（${res.summary.min}ms）`);
          }
        } else {
          console.log(
            `[Nyx] 智能调度测速完成：可用 ${res.summary.ok}/${res.summary.total}，最低 ${res.summary.min}ms`,
          );
        }
      } catch (err) {
        console.warn(`[Nyx] 节点自动重选失败：${err.message}`);
      }
    },
    log: (level, text) => console.log(`[Nyx] ${text}`),
  });

  // 内核启停、订阅切换、端口变化等状态变化统一推给设置窗口；
  // 普通模式还要顺带复核链路：内核起来即自动改走代理，内核停掉即回落直连。
  service.on('change', () => {
    notifyProxyState();
    reevaluateNormalLink('kernel-change').catch(() => {});
    syncSmartPatrol();
  });

  /**
   * 启动阶段一律不拉起内核。
   *
   * 普通模式的可用性不依赖代理，随浏览器自启只会白占内存与端口；内核改为
   * "按需拉起"：仅当要进入 / 恢复隐私模式时，才由 ensureProxyKernelForPrivate()
   * 依据用户偏好决定是否启动。这里的日志只说明端口回落位置。
   */
  console.log(
    '[Nyx] 启动阶段不拉起内置代理内核（按需启动）；' +
      `普通模式代理端口回落 ${sessions.FALLBACK_PROXY_PORT}`,
  );
}

/**
 * 按需为隐私模式拉起内置代理内核。
 *
 * 隐私模式必须经代理，所以它是唯一需要内核的场景：
 *   - 内核已在运行 → 直接返回；
 *   - 用户偏好里关掉了 autoStart → 不擅自启动（尊重"代理默认关闭"，隐私模式随后
 *     会因代理不可达被拒绝进入，这是刻意保留的硬失败，而不是静默直连）；
 *   - 其余情况按偏好启动，成功则把内核混合端口注入 sessions。
 *
 * @returns {Promise<boolean>} 内核是否处于运行状态
 */
async function ensureProxyKernelForPrivate() {
  const service = runtime.proxyService;
  if (!service) return false;

  const status = service.status ? service.status() : null;
  if (status && status.running) return true;

  const prefs = (service.store && service.store.load().preferences) || {};
  if (!prefs.autoStart) {
    console.log('[Nyx] 用户偏好未开启"随隐私模式自启内核"，不擅自启动内置代理');
    return false;
  }

  const result = await service.start();

  if (result && result.ok && result.kernel && result.kernel.mixedPort) {
    sessions.setProxyPort(result.kernel.mixedPort);
    console.log(`[Nyx] 隐私模式按需拉起内置代理内核，混合端口 ${result.kernel.mixedPort}`);
    return true;
  }

  console.warn(
    `[Nyx] 隐私模式按需拉起内置代理内核失败（${(result && result.error) || '未知原因'}），` +
      `继续使用回落代理端口 ${sessions.FALLBACK_PROXY_PORT}`,
  );
  return false;
}

/**
 * 启动时恢复上次使用的模式，并确定普通分区的出站链路。
 *
 * 两条路径的差异就是本产品的核心语义：
 *   - 上次是普通模式（含首次启动）：绝不拉起内核，只探一次当前代理端口，
 *     可达 → 普通模式走代理，不可达 → 普通模式直连（不拿可用性换"全局代理"）；
 *   - 上次是隐私模式：先按需拉起内核（见 ensureProxyKernelForPrivate），再探代理，
 *     可达 → 恢复隐私模式；不可达 → 回落普通模式并直连，同时返回一条用户提示
 *     （绝不静默进入隐私模式）。
 *
 * @returns {Promise<null|object>} 需要推送给渲染层的提示对象；无需提示时返回 null
 */
async function restoreLastMode() {
  const last = readLastMode();

  if (last !== 'private') {
    sessions.setMode('normal');

    const probe = recordProbe(await isProxyReachable());
    // 代理可达时按智能调度偏好决定链路：开 → PAC 分流，关 → 全代理
    const link = probe.reachable ? (isSmartPatrolEnabled() ? 'smart' : 'proxy') : 'direct';
    sessions.setLink('normal', link);
    syncSmartPatrol();

    modeEventLog.record({ type: 'startup', from: last, to: 'normal', changed: false, ok: true });
    console.log(
      `[Nyx] 启动为普通模式｜出站链路：${
        link === 'smart'
          ? `智能分流（代理 ${probe.host}:${probe.port} 可达，${probe.latencyMs}ms）`
          : link === 'proxy'
            ? `代理 ${probe.host}:${probe.port}（可达，${probe.latencyMs}ms）`
            : `直连（代理 ${probe.host}:${probe.port} 不可达：${probe.error}）`
      }`,
    );
    return null;
  }

  // 上次是隐私模式：隐私必须经代理，先按需把内核拉起来再探测
  await ensureProxyKernelForPrivate();

  const probe = recordProbe(await isProxyReachable());

  if (probe.reachable) {
    sessions.setMode('private');
    sessions.setLink('private', 'proxy');
    sessions.setLink('normal', 'proxy');
    modeEventLog.record({
      type: 'startup',
      from: 'private',
      to: 'private',
      changed: false,
      ok: true,
    });
    console.log(
      `[Nyx] 已恢复上次的隐私模式（代理 ${probe.host}:${probe.port} 可达，耗时 ${probe.latencyMs}ms）`,
    );
    return null;
  }

  sessions.setMode('normal');
  sessions.setLink('normal', 'direct');
  writeLastMode('normal');
  console.warn(
    `[Nyx] 上次为隐私模式，但代理 ${probe.host}:${probe.port} 不可达（${probe.error}），已回落普通模式（直连）`,
  );

  const fallbackNotice = {
    level: 'warn',
    code: 'PROXY_UNREACHABLE',
    title: '代理不可达，已回落普通模式',
    message:
      `上次退出时处于隐私模式，但检测到本机代理 ${probe.host}:${probe.port} 不可达（${probe.error}）。` +
      '为避免真实 IP 泄漏，本次已回落为普通模式（直连可用）。请在「设置 → 网络与代理」中启动内置代理，' +
      '或启动 Clash Verge 并确认其混合端口可用，再手动切回隐私模式。',
  };

  // 启动回落同样记入事件缓冲：自动化测试据此断言"隐私→普通"的回落决策
  modeEventLog.record({
    type: 'startup',
    from: 'private',
    to: 'normal',
    changed: true,
    ok: false,
    code: 'PROXY_UNREACHABLE',
    message: fallbackNotice.message,
  });

  return fallbackNotice;
}

/**
 * 记录一次代理探测结论（供 /state 与界面展示）。
 * 链路状态本身以 sessions.getLink() 为准，这里只存"探测到的可达性"。
 */
function recordProbe(probe) {
  runtime.network.proxyReachable = !!probe.reachable;
  runtime.network.checkedAt = Date.now();
  runtime.network.note = probe.reachable ? '' : probe.error || '';
  return probe;
}

/**
 * 当前出站链路快照（随 /state、nyx:state 一起下发）。
 *
 * link 直接读 sessions：主进程与 session 只有一份真相，界面不再自己推断；
 * port 是"当前生效的代理端口"（内核混合端口或回落端口），直连时它只表示探测目标。
 */
function networkSnapshot() {
  const mode = sessions.getMode();
  return {
    mode,
    link: sessions.getLink(mode),
    proxyReachable: runtime.network.proxyReachable,
    host: sessions.PROXY_HOST,
    port: sessions.getProxyPort(),
    fallbackPort: sessions.FALLBACK_PROXY_PORT,
    checkedAt: runtime.network.checkedAt,
    note: runtime.network.note,
  };
}

/**
 * 普通模式链路复核：代理可达走代理、不可达直连，并推送最新状态。
 *
 * 只在普通模式下生效——隐私模式的链路恒为代理，这里的任何"降级"都不允许发生。
 * 复核周期由 LINK_RECHECK_MS 控制，内核启停事件也会即时触发一次。
 */
async function reevaluateNormalLink(reason) {
  if (runtime.linkGuardBusy) return false;
  if (sessions.getMode() !== 'normal') return false;

  runtime.linkGuardBusy = true;
  try {
    const probe = recordProbe(await isProxyReachable());
    // 智能遨游调度开启且代理可达 → 普通模式走 smart（PAC 分流），否则退化为全代理
    const next = probe.reachable ? (isSmartPatrolEnabled() ? 'smart' : 'proxy') : 'direct';

    if (sessions.getLink('normal') !== next) {
      sessions.setLink('normal', next);
      await sessions.whenSessionReady('normal').catch((err) => {
        console.warn(`[Nyx] 普通模式链路下发失败：${err.message}`);
      });
      console.log(
        `[Nyx] 普通模式链路已切换为${
          next === 'smart'
            ? '智能分流（国内直连 / 被墙走代理）'
            : next === 'proxy'
              ? `代理 ${probe.host}:${probe.port}`
              : '直连'
        }（触发：${reason}）`,
      );
    }

    syncSmartPatrol();
    pushState(currentSnapshot());
    return true;
  } finally {
    runtime.linkGuardBusy = false;
  }
}

/**
 * 智能遨游调度是否开启（读取代理偏好 smartPatrol，默认开启）。
 */
function isSmartPatrolEnabled() {
  const service = runtime.proxyService;
  if (!service) return false;
  const prefs = (service.store && service.store.load().preferences) || {};
  return prefs.smartPatrol !== false;
}

/**
 * 让巡检器与当前普通模式链路保持一致（幂等）：
 *   - 普通模式 + smart 链路 → 巡检器运行（PAC 分流生效）；
 *   - 其他情况（直连 / 全代理 / 隐私模式）→ 巡检器停止，不浪费探测。
 */
function syncSmartPatrol() {
  const patrol = runtime.smartPatrol;
  if (!patrol) return;
  if (sessions.getMode() === 'normal' && sessions.getLink('normal') === 'smart') {
    patrol.enabled = isSmartPatrolEnabled();
    patrol.start();
  } else {
    patrol.stop();
  }
}

/** 启动普通模式链路复核定时器（幂等） */
function startLinkWatchdog() {
  if (runtime.linkTimer) return;
  runtime.linkTimer = setInterval(() => {
    reevaluateNormalLink('watchdog').catch(() => {});
  }, LINK_RECHECK_MS);
  console.log(`[Nyx] 普通模式链路复核已启动（每 ${LINK_RECHECK_MS}ms 探测一次代理）`);
}

/**
 * 页面加载失败时的链路兜底。
 *
 * 典型场景：普通模式正走代理，用户把 Clash 关掉 → 页面首报 ERR_PROXY_CONNECTION_FAILED。
 * 这里的处理原则是"先探测、再决定"：
 *   - 探测到代理仍可达 → 属于站点 / 网络问题，不动链路（避免把正常代理误判掉）；
 *   - 探测到代理确实不可达 → 普通模式切直连、提示用户并重载出错的标签；
 *   - 隐私模式 → 一律不动（隐私模式宁可报错也不直连）。
 */
async function handleProxyLoadFailure(info) {
  if (sessions.getMode() !== 'normal') return;
  const link = sessions.getLink('normal');
  if (link !== 'proxy' && link !== 'smart') return;
  if (!PROXY_FAILURE_CODES.has(Number(info.errorCode))) return;
  if (runtime.linkGuardBusy) return;

  runtime.linkGuardBusy = true;
  try {
    const probe = recordProbe(await isProxyReachable());

    if (probe.reachable) {
      // 代理还活着：不降级，只把最新的探测结论推给界面
      pushState(currentSnapshot());
      return;
    }

    sessions.setLink('normal', 'direct');
    await sessions.whenSessionReady('normal').catch((err) => {
      console.warn(`[Nyx] 直连配置下发失败：${err.message}`);
    });
    console.warn(
      `[Nyx] 普通模式代理 ${probe.host}:${probe.port} 已不可达（${probe.error}），` +
        '自动切换为直连并重载出错的标签',
    );

    syncSmartPatrol();

    notifyNotice({
      level: 'warn',
      code: 'PROXY_FALLBACK_DIRECT',
      title: '代理已断开，普通模式已自动直连',
      message:
        `检测到本机代理 ${probe.host}:${probe.port} 不可达（${probe.error}），` +
        '普通模式已切换为直连并重新加载页面。隐私模式要求代理可达，不会降级为直连。',
    });

    pushState(currentSnapshot());

    if (runtime.tabManager && info.tabId) runtime.tabManager.reload(info.tabId);
  } finally {
    runtime.linkGuardBusy = false;
  }
}

/** 上次模式记录文件路径 */
function lastModePath() {
  return userDataFile(LAST_MODE_FILE);
}

function readLastMode() {
  try {
    const raw = fs.readFileSync(lastModePath(), 'utf8').trim();
    return raw === 'private' ? 'private' : 'normal';
  } catch {
    return 'normal';
  }
}

function writeLastMode(mode) {
  try {
    fs.writeFileSync(lastModePath(), mode === 'private' ? 'private' : 'normal');
  } catch (err) {
    console.warn('[Nyx] 模式记录落盘失败：', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 主窗口与标签                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 工具箱：资源嗅探 / 网络抓包 / 开发者模式 / 页面环境                    */
/* ------------------------------------------------------------------ */

/**
 * 工具箱装配。
 *
 * 两个实例分工：Toolbox 管 CDP 采集（抓包与嗅探），PageTools 管页面改写
 * （开发者模式 / 元素拾取 / UA / 视口 / 限速 / 截图）。PageTools 复用 Toolbox
 * 已建立的调试通道，不另行 attach——一个 webContents 只容得下一条通道。
 */
function initToolbox() {
  const push = (channel, payload) => {
    const win = runtime.mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  runtime.toolbox = new Toolbox({
    getAllWebContents: () =>
      runtime.tabManager ? runtime.tabManager.tabs.map((tab) => tab.view.webContents) : [],
    getActiveWebContents: () =>
      runtime.tabManager ? runtime.tabManager.getActiveWebContents() : null,
    push,
  });

  runtime.pageTools = new PageTools({
    toolbox: runtime.toolbox,
    getActiveWebContents: () =>
      runtime.tabManager ? runtime.tabManager.getActiveWebContents() : null,
    push,
  });
}

/**
 * 展开 / 收起工具箱抽屉，并让标签视图同步让出右侧宽度。
 *
 * 抽屉宽度由界面决定（界面按档位给像素值），主进程只负责转交给标签层；
 * 采集随抽屉开关一起启停，关掉工具箱就彻底卸掉 CDP 通道，不留后台开销。
 */
async function setToolboxOpen(open, width) {
  runtime.toolboxOpen = !!open;
  if (width) runtime.toolboxWidth = Math.max(320, Math.min(Number(width) || 460, 1400));

  if (runtime.tabManager) {
    runtime.tabManager.setRightInset(runtime.toolboxOpen ? runtime.toolboxWidth : 0);
  }

  // 收起工具箱等于退出接管：先停掉鼠标保活并还原页面上的倍速/进度改写，再卸通道
  if (!runtime.toolboxOpen && runtime.pageTools) {
    try {
      await runtime.pageTools.releaseAllVideo();
    } catch (err) {
      console.warn('[Nyx] 退出视频接管时出错：', err && err.message);
    }
  }

  if (runtime.toolbox) {
    if (runtime.toolboxOpen) runtime.toolbox.enable();
    else runtime.toolbox.disable();
  }

  return {
    ok: true,
    open: runtime.toolboxOpen,
    width: runtime.toolboxOpen ? runtime.toolboxWidth : 0,
  };
}

/**
 * 下载一条被嗅探到的资源。
 *
 * 复用 Electron 原生下载：先挂一次性 will-download 把落点钉在系统下载目录
 * （带重名自增），再触发 downloadURL——不自己写流，避免二次实现断点与进度。
 */
function downloadResource(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: '只支持 http/https 直链资源（流媒体分片请先获取播放列表）' };
  }

  const wc = runtime.tabManager ? runtime.tabManager.getActiveWebContents() : null;
  if (!wc) return { ok: false, error: '当前没有可用标签' };

  let name = 'nyx-download';
  try {
    const parsed = new URL(target);
    name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'nyx-download');
    if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += '.bin';
  } catch {
    /* 取名失败不影响下载 */
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

  const dir = app.getPath('downloads');
  let savePath = path.join(dir, name);
  if (fs.existsSync(savePath)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    savePath = path.join(dir, `${stem}-${Date.now()}${ext}`);
  }

  try {
    wc.session.once('will-download', (event, item) => {
      try {
        item.setSavePath(savePath);
      } catch {
        /* 落点设置失败则交给系统默认对话框 */
      }
    });
    wc.downloadURL(target);
  } catch (err) {
    return { ok: false, error: `下载启动失败：${err.message}` };
  }

  return { ok: true, path: savePath };
}

/** 生成目录内不冲突的保存路径：重名时追加 (1)(2)… 递增后缀 */
function uniqueSavePath(dir, name) {
  const clean = String(name || 'nyx-download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let candidate = path.join(dir, clean);
  let seq = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}(${seq})${ext}`);
    seq += 1;
  }
  return candidate;
}

/**
 * 普通模式页面下载处理器（常驻 will-download）：
 *   按下载偏好决定「弹窗询问」或「静默存到指定目录」。
 * 隐私分区在 sessions.js 里已整体禁止下载落盘，不在此列。
 */
function installDownloadHandler() {
  if (runtime.downloadHandlerInstalled) return;
  runtime.downloadHandlerInstalled = true;

  const ses = sessions.getSession('normal');
  ses.on('will-download', (event, item) => {
    // 工具箱主动下载（downloadResource）已用 once 钉过落点，不重复接管
    if (item.getSavePath && item.getSavePath()) return;

    const prefs = runtime.uiStore ? runtime.uiStore.get() : {};
    const dir = prefs.downloadDir && fs.existsSync(prefs.downloadDir)
      ? prefs.downloadDir
      : app.getPath('downloads');
    const filename = item.getFilename() || `nyx-${Date.now()}.bin`;
    const target = uniqueSavePath(dir, filename);

    if (prefs.downloadAsk !== false) {
      event.preventDefault();
      const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
      dialog.showSaveDialog(win, {
        title: '保存下载内容',
        defaultPath: target,
      }).then((result) => {
        if (result.canceled || !result.filePath) return;
        try {
          item.setSavePath(result.filePath);
        } catch {
          /* 落点设置失败则放弃本次接管 */
        }
      });
    } else {
      try {
        item.setSavePath(target);
      } catch {
        /* 交给系统默认行为 */
      }
    }
  });
}

/** 弹目录选择框，返回用户选定的下载保存目录（用于设置中心） */
async function pickDownloadDir() {
  const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
  const picked = await dialog.showOpenDialog(win, {
    title: '选择下载保存目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths.length) {
    return { ok: false, canceled: true };
  }
  return { ok: true, path: picked.filePaths[0] };
}

/**
 * 保存截图到用户选定位置。
 * 走系统保存对话框而不是静默落盘：截图是取证材料，落点该由用户定。
 */
async function saveScreenshot(base64, fullPage) {
  const win = runtime.mainWindow;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suggested = `nyx-${fullPage ? 'fullpage' : 'viewport'}-${stamp}.png`;

  const picked = await dialog.showSaveDialog(win && !win.isDestroyed() ? win : null, {
    title: '保存截图',
    defaultPath: path.join(app.getPath('pictures'), suggested),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

  try {
    fs.writeFileSync(picked.filePath, Buffer.from(base64, 'base64'));
  } catch (err) {
    return { ok: false, error: `截图写入失败：${err.message}` };
  }
  return { ok: true, path: picked.filePath };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 560,
    show: false,
    // 窗口出现前的底色跟随主题（CSS 管不到），否则浅色主题启动时会闪一下深色
    backgroundColor: THEME_BG[(runtime.uiStore && runtime.uiStore.get().theme) || 'ink'],
    title: 'Nyx',
    icon: fs.existsSync(TRAY_ICON) ? TRAY_ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 启动阶段产生的提示（如"代理不可达已回落普通模式"）在页面就绪后推送
  win.webContents.on('did-finish-load', () => {
    const notice = runtime.pendingNotice;
    if (!notice) return;
    runtime.pendingNotice = null;
    win.webContents.send('nyx:notice', notice);
  });

  // UI 外壳自身也套用防泄漏策略
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  // UI 外壳中的弹窗一律交给标签系统处理
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInNewTab(url);
    return { action: 'deny' };
  });

  win.on('resize', () => {
    if (runtime.tabManager) runtime.tabManager.layout();
  });

  // 说明：地址栏建议浮层的收起时机全部由渲染层驱动（地址栏失焦 / 切标签 / 切模式 / Esc），
  // 主窗口的 blur / move / resize 不参与——新建浮层窗口本身可能短暂触发这些事件，
  // 挂在这里会把刚弹出的建议立刻收掉（实测踩过）。

  win.on('closed', () => {
    disposeAddressSuggest();
    closeBookmarkFolderMenu();
    runtime.mainWindow = null;
    runtime.tabManager = null;
  });

  runtime.mainWindow = win;

  // 应用菜单已彻底移除，Electron 不再分发菜单 accelerator；
  // 这里在 webContents 层补回原先由菜单承载的常用快捷键，避免操作习惯被破坏。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if (mod && !input.alt && key === 't') {
      event.preventDefault();
      if (runtime.tabManager) runtime.tabManager.create(HOME_URL);
    } else if (mod && !input.alt && key === 'w') {
      event.preventDefault();
      if (!runtime.tabManager) return;
      const snapshot = runtime.tabManager.snapshot();
      if (snapshot && snapshot.activeId) runtime.tabManager.close(snapshot.activeId);
    } else if (mod && !input.alt && key === 'r') {
      event.preventDefault();
      if (runtime.tabManager) runtime.tabManager.reload();
    } else if (input.alt && input.key === 'ArrowLeft') {
      event.preventDefault();
      if (runtime.tabManager) runtime.tabManager.goBack();
    } else if (input.alt && input.key === 'ArrowRight') {
      event.preventDefault();
      if (runtime.tabManager) runtime.tabManager.goForward();
    }
  });

  runtime.tabManager = new TabManager({
    mainWindow: win,
    uiHeight: UI_HEIGHT,
    maxTabs: MAX_TABS,
    // 新标签默认地址每次新建时动态解析：设置中心改完即时生效，无需重建标签管理器
    defaultUrl: resolveNewTabUrl(),
    resolveSession: () => sessions.getSession(),
    getMode: () => sessions.getMode(),
    // 当前模式的预加载参数（隐私模式由 PrivacyHardening 依据出口画像生成）
    getPreloadArgs: (mode) => sessions.getPreloadArgs(mode),
    // WebRTC 策略按模式给出：隐私模式禁止非代理 UDP，避免真实 IP 经 STUN 泄漏
    getWebrtcPolicy: (mode) =>
      runtime.hardening ? runtime.hardening.webrtcPolicy(mode) : 'disable_non_proxied_udp',
    // 出站链路随标签状态一起下发（普通模式可能为 direct，见 networkSnapshot）
    getNetwork: () => networkSnapshot(),
    // 加载失败兜底：普通模式下代理中途消失时自动切直连并重载（隐私模式不动）
    onLoadFailure: (info) => {
      handleProxyLoadFailure(info).catch((err) => {
        console.warn('[Nyx] 加载失败兜底处理异常：', err.message);
      });
    },
    onChange: pushState,
    // 新标签纳入抓包范围，并继承工具箱的 UA / 视口 / 限速设定
    onTabCreated: (tab) => {
      if (runtime.toolbox) runtime.toolbox.syncAll();
      if (runtime.pageTools) {
        runtime.pageTools.applySticky(tab.view.webContents).catch((err) => {
          console.warn('[Nyx] 工具箱粘性设置应用失败：', err.message);
        });
      }
      // 历史记录：导航提交（主框架）即记账，页面标题就绪后再修正标题
      hookHistoryRecording(tab);
    },
  });

  // 启动标签按「启动与主页」配置打开：空白页 / 新标签页 / 指定网页（可多条）
  const targets = startupTargets();
  const opened = targets.map((url) => runtime.tabManager.create(url)).filter((res) => res && res.ok);
  // 多个启动页时 create 会依次激活，这里统一把焦点落回第一个标签
  if (opened.length > 1 && opened[0].id) runtime.tabManager.activate(opened[0].id);
}

function showMainWindow() {
  const win = runtime.mainWindow;
  if (runtime.panicking) return;

  if (!win || win.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 给标签挂上历史记录钩子。
 *
 * 时机：did-navigate / did-navigate-in-page 在导航提交时触发（含前进后退与
 * 页面内锚点跳转），此时标题常滞后，先以当前 webContents 标题记账，
 * 稍后 page-title-updated 会把最近一条同 URL 记录的标题修正为最终值。
 *
 * 红线（此处把关）：
 *   - 隐私模式绝不写历史（getMode() === 'private' 直接返回）；
 *   - 只记录主框架 http(s) 页面，内部页与特殊协议一律跳过。
 */
function hookHistoryRecording(tab) {
  const wc = tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;

  const record = (url) => {
    if (!runtime.historyStore) return;
    if (sessions.getMode() === 'private') return;
    if (!isRecordableUrl(url)) return;
    const title = typeof wc.getTitle === 'function' ? wc.getTitle() : '';
    runtime.historyStore.record(url, title || tab.title || '');
  };

  wc.on('did-navigate', (_event, url) => record(url));
  wc.on('did-navigate-in-page', (_event, url) => record(url));

  wc.on('page-title-updated', (_event, title) => {
    if (!runtime.historyStore) return;
    if (sessions.getMode() === 'private') return;
    if (title) runtime.historyStore.updateTitle(tab.url, title);
  });
}

/**
 * 是否是可记录历史的外部网页。
 *
 * 仅 http(s) 主框架页面可记录；about: / chrome: / devtools: / edge:// /
 * file: / data: / blob: 等特殊协议天然不满足 http(s) 前缀而被排除，
 * settings.html 内部设置页单独排除。
 */
function isRecordableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (!/^https?:/i.test(url)) return false;
  if (url.includes('settings.html')) return false;
  return true;
}

function toggleMainWindow() {
  const win = runtime.mainWindow;
  if (!win || win.isDestroyed()) {
    showMainWindow();
    return;
  }
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    showMainWindow();
  }
}

/**
 * 把界面偏好并入状态快照。
 *
 * 主窗口与设置窗口都读同一份快照：主窗口据此决定顶栏元素的显隐，
 * 设置窗口据此回显开关状态；这样两边的界面不会出现不一致。
 */
function withUi(snapshot) {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return Object.assign({}, base, {
    ui: runtime.uiStore
      ? runtime.uiStore.get()
      : { showLinkBadge: true, showModeSwitch: true, theme: 'ink' },
  });
}

function pushState(snapshot) {
  const win = runtime.mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('nyx:state', withUi(snapshot));
}

function openInNewTab(url) {
  if (runtime.tabManager) runtime.tabManager.create(url);
}

/* ------------------------------------------------------------------ */
/* 模式切换                                                            */
/* ------------------------------------------------------------------ */

/**
 * 探测本机代理端口是否可达（纯 TCP 连接探测，不发起任何 HTTP 请求）。
 *
 * @param {{host?:string, port?:number, timeout?:number}} [options]
 * @returns {Promise<{reachable:boolean, host:string, port:number, latencyMs:number, error:null|string}>}
 */
function isProxyReachable(options = {}) {
  const host = options.host || sessions.PROXY_HOST;
  const port = options.port || sessions.getProxyPort();
  const timeout = options.timeout || PROXY_PROBE_TIMEOUT;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const socket = new net.Socket();

    const settle = (reachable, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, host, port, latencyMs: Date.now() - startedAt, error });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => settle(true, null));
    socket.once('timeout', () => settle(false, `连接超时（${timeout}ms）`));
    socket.once('error', (err) => settle(false, err.message));
    socket.connect(port, host);
  });
}

/** 构造"代理不可达已拒绝进入隐私模式"的用户提示 */
function buildProxyBlockedNotice(probe) {
  const where = `${probe.host}:${probe.port}`;
  return {
    level: 'error',
    code: 'PROXY_UNREACHABLE',
    title: '代理不可达，已拒绝进入隐私模式',
    message:
      `无法连接本机代理 ${where}（${probe.error}）。` +
      '请在「设置 → 网络与代理」中启动内置代理（或启动 Clash Verge 并确认其混合端口可用），再重新切换。' +
      '为避免真实 IP 泄漏，本次切换已被拒绝，当前模式保持不变，不会降级为直连。',
  };
}

/** 向渲染层推送用户可见提示；页面未就绪时暂存，待加载完成后补发 */
function notifyNotice(notice) {
  const win = runtime.mainWindow;
  if (!win || win.isDestroyed()) {
    runtime.pendingNotice = notice;
    return;
  }
  win.webContents.send('nyx:notice', notice);
}

/** 当前标签状态快照（窗口未就绪时给出兜底结构） */
function currentSnapshot() {
  return runtime.tabManager
    ? runtime.tabManager.snapshot()
    : {
        mode: sessions.getMode(),
        activeId: null,
        maxTabs: MAX_TABS,
        network: networkSnapshot(),
        tabs: [],
      };
}

/**
 * 切换普通 / 隐私模式。
 *
 * 隐私模式强制走代理，"进入隐私模式"因此是一次带前置校验的操作：
 *   1. 需要时先按需拉起内置内核，再探测"当前生效的代理端口"是否可达
 *      （内核混合端口，内核未运行时回落外置 7897），不可达直接拒绝进入（并提示用户），
 *      绝不静默降级为直连；
 *   2. 代理配置下发失败同样拒绝进入；
 *   3. 切回普通模式不做可达性拦截（普通模式不依赖代理），但会重探一次并据此
 *      选择链路：代理可达走代理，不可达则直连。
 *
 * 因两个模式使用不同分区，切换成功时销毁全部标签并重建；
 * 进入隐私模式时按出口画像装配隐私加固（UA / 请求头 / 时区语言对齐），
 * 离开时复位 profile 并立即清空隐私分区全部痕迹。
 *
 * @returns {Promise<{ok:boolean, code?:string, error?:string, state:object}>}
 */
async function switchMode(mode) {
  const next = mode === 'private' ? 'private' : 'normal';
  const current = sessions.getMode();
  /** 切回普通模式时预判出的链路（proxy / direct），在模式落定后统一应用 */
  let normalLinkOnEnter = null;

  if (next === current) {
    return { ok: true, state: currentSnapshot() };
  }

  // 进入隐私模式前的前置校验；切回普通模式则重探一次链路
  if (next === 'private') {
    // 隐私必须经代理：内核没跑且用户允许自启时，先按需拉起，避免"内核没开所以进不去"
    await ensureProxyKernelForPrivate();

    const probe = recordProbe(await isProxyReachable());

    if (!probe.reachable) {
      const notice = buildProxyBlockedNotice(probe);
      console.warn(
        `[Nyx] 拒绝进入隐私模式：代理 ${probe.host}:${probe.port} 不可达（${probe.error}）`,
      );
      notifyNotice(notice);
      return {
        ok: false,
        code: 'PROXY_UNREACHABLE',
        error: notice.message,
        state: currentSnapshot(),
      };
    }

    // 隐私分区链路恒为代理（sessions 内部也会拒绝把它置为直连）
    sessions.setLink('private', 'proxy');

    try {
      // 等待代理配置真正下发，失败则同样拒绝进入
      await sessions.whenSessionReady('private');
    } catch (err) {
      const notice = buildProxyBlockedNotice({ ...probe, error: err.message });
      console.warn('[Nyx] 拒绝进入隐私模式：代理配置下发失败 ——', err.message);
      notifyNotice(notice);
      return {
        ok: false,
        code: err.code || 'PROXY_SET_FAILED',
        error: notice.message,
        state: currentSnapshot(),
      };
    }

    console.log(
      `[Nyx] 代理校验通过（${probe.host}:${probe.port}，${probe.latencyMs}ms），进入隐私模式`,
    );
  } else {
    // 切回普通模式：不做拦截，只重探一次决定走代理还是直连
    const probe = recordProbe(await isProxyReachable());
    normalLinkOnEnter = probe.reachable ? 'proxy' : 'direct';
    console.log(
      `[Nyx] 切回普通模式｜出站链路预判：${
        normalLinkOnEnter === 'proxy' ? `代理 ${probe.host}:${probe.port}（可达）` : '直连（代理不可达）'
      }`,
    );
  }

  // 0. 收起地址栏建议浮层：模式一旦切换，历史建议的可用性随之改变（隐私模式不出建议）
  closeAddressSuggest();

  // 1. 关闭所有标签（它们的 session 即将失效）
  if (runtime.tabManager) runtime.tabManager.closeAll();

  // 2. 切换模式并记录，供下次启动恢复
  sessions.setMode(next);
  writeLastMode(next);

  // 2.5 普通分区的链路按刚才的探测结果落定（必须在重建标签之前，
  //     否则首个标签会先跑在上一轮的链路上）
  if (next === 'normal' && normalLinkOnEnter) {
    sessions.setLink('normal', normalLinkOnEnter);
  }
  // 权限判定按分区取模式，这里额外同步一份"全局模式"，供不属于任何分区的窗口
  // （UI 外壳）兜底；否则外壳窗口切到隐私模式后仍按正常模式的基线放行权限。
  sessions.getPermissionManager().setMode(next);

  // 3. 离开隐私模式 → 清空隐私分区（先清后装，避免旧 profile 残留到下一次会话）
  if (current === 'private') {
    await sessions.purgePrivateSession();
    console.log('[Nyx] 已退出隐私模式，隐私分区痕迹已清空');
  }

  // 3.5 隐私加固装配 / 复位。
  //     必须落在"重建标签"之前：标签创建时就要带上当前模式的 preload 参数与
  //     WebRTC 策略，晚一步首个标签就会跑在上一轮的 profile 上（等于用旧指纹上站）。
  if (next === 'private') {
    const applied = await applyPrivacyHardening();

    if (!applied.ok) {
      // 装配不出 profile 就不进隐私模式：硬着头皮进去等于没穿衣服上站。
      // 回滚到用户原本所在的正常模式，并清掉刚建立的隐私分区，避免留下半套状态。
      const notice = {
        level: 'error',
        code: 'HARDENING_FAILED',
        title: '隐私加固装配失败，未进入隐私模式',
        message:
          `无法依据代理出口构建隐私画像（${applied.error}）。` +
          '为避免以未加固或错误对齐的指纹访问站点，本次切换已被拒绝，' +
          '当前模式已回滚为正常模式。请稍后重试，或在「设置 → 网络与代理」中确认出口信息可正常获取。',
      };
      console.warn(`[Nyx] 拒绝进入隐私模式：隐私加固装配失败 —— ${applied.error}`);
      sessions.setMode('normal');
      writeLastMode('normal');
      sessions.getPermissionManager().setMode('normal');
      try {
        await sessions.purgePrivateSession();
      } catch {
        /* 忽略：回滚阶段的清理失败不阻断流程 */
      }
      notifyNotice(notice);
      if (runtime.tabManager) runtime.tabManager.create(HOME_URL);
      return {
        ok: false,
        code: 'HARDENING_FAILED',
        error: notice.message,
        state: currentSnapshot(),
      };
    }

    console.log(
      `[Nyx] 隐私加固已装配｜出口：${applied.profile.exitIp || '(未知)'}｜` +
        `语区：${applied.profile.acceptLanguage}｜时区：${applied.profile.timezone || '(未对齐)'}`,
    );
  } else if (current === 'private') {
    // 离开隐私模式：复位 profile。复位保证下次进入一定重新构建（否则会复用旧的
    // 出口时区与会话种子，等于继续沿用上一次会话的指纹），并把预加载参数回落。
    resetPrivacyHardening();
  }

  // 4. 在新模式下重建标签
  if (runtime.tabManager) runtime.tabManager.create(HOME_URL);

  return { ok: true, state: currentSnapshot() };
}

/**
 * 带事件记录的模式切换入口（UI / 托盘 / 本地 HTTP 接口统一走这里）。
 *
 * 本函数不含任何切换逻辑，只是复用 switchMode() 的完整流程（代理探测、失败回滚、
 * Toast 通知）并把结果写入内存事件缓冲，供 GET /mode/events 查询；
 * 返回值与 switchMode() 完全一致，因此不改变任何调用方的既有行为。
 *
 * @returns {Promise<{ok:boolean, code?:string, error?:string, state:object}>}
 */
async function switchModeTracked(mode) {
  const from = sessions.getMode();
  const to = mode === 'private' ? 'private' : 'normal';

  const result = await switchMode(mode);

  modeEventLog.record({
    type: 'switch',
    from,
    to,
    changed: from !== to && result.ok === true,
    ok: result.ok === true,
    code: result.ok === false ? result.code : null,
    message: result.ok === false ? result.error : '',
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('nyx:get-state', () => {
    const snapshot = runtime.tabManager
      ? runtime.tabManager.snapshot()
      : { mode: sessions.getMode(), activeId: null, maxTabs: MAX_TABS, tabs: [] };
    return withUi(snapshot);
  });

  ipcMain.handle('nyx:tab:create', (_event, url) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    // 空入参表示「用配置的新标签页地址」，不在主进程里再写死地址
    return runtime.tabManager.create(url || '');
  });

  ipcMain.handle('nyx:tab:close', (_event, id) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    return runtime.tabManager.close(id);
  });

  ipcMain.handle('nyx:tab:activate', (_event, id) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    return runtime.tabManager.activate(id);
  });

  ipcMain.handle('nyx:navigate', (_event, input) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    return runtime.tabManager.navigate(input);
  });

  ipcMain.handle('nyx:go-back', () => (runtime.tabManager ? runtime.tabManager.goBack() : { ok: false }));
  ipcMain.handle('nyx:go-forward', () => (runtime.tabManager ? runtime.tabManager.goForward() : { ok: false }));
  ipcMain.handle('nyx:reload', () => (runtime.tabManager ? runtime.tabManager.reload() : { ok: false }));

  // 经 switchModeTracked 间接调用 switchMode：行为完全一致，额外写入模式事件缓冲
  ipcMain.handle('nyx:switch-mode', (_event, mode) => switchModeTracked(mode));

  // 硬件能力（GPU 加速状态 / NPU 本地 AI）只读探测
  ipcMain.handle('nyx:hardware:status', () => getHardwareStatus());

  // 下载设置：选择保存目录 / 打开当前下载目录
  ipcMain.handle('nyx:download:pick-dir', () => pickDownloadDir());
  ipcMain.handle('nyx:download:open-dir', () => {
    const prefs = runtime.uiStore ? runtime.uiStore.get() : {};
    const dir = prefs.downloadDir && fs.existsSync(prefs.downloadDir)
      ? prefs.downloadDir
      : app.getPath('downloads');
    shell.openPath(dir);
    return { ok: true };
  });

  // 历史记录（主进程存储，见 src/core/history-store.js）
  ipcMain.handle('nyx:history:list', () => {
    if (!runtime.historyStore) return { ok: false, error: '历史记录存储未就绪' };
    return { ok: true, items: runtime.historyStore.list() };
  });

  ipcMain.handle('nyx:history:clear', () => {
    if (!runtime.historyStore) return { ok: false, error: '历史记录存储未就绪' };
    return runtime.historyStore.clear();
  });

  ipcMain.handle('nyx:history:remove', (_event, payload) => {
    if (!runtime.historyStore) return { ok: false, error: '历史记录存储未就绪' };
    return runtime.historyStore.remove(payload && payload.id);
  });

  // 书签（主进程存储，见 src/core/bookmark-store.js；v2 返回树结构，含根与 children）
  ipcMain.handle('nyx:bookmarks:list', () => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    return { ok: true, tree: runtime.bookmarkStore.listTree() };
  });

  ipcMain.handle('nyx:bookmarks:add', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    return runtime.bookmarkStore.add(payload || {});
  });

  ipcMain.handle('nyx:bookmarks:add-folder', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    return runtime.bookmarkStore.addFolder(payload || {});
  });

  ipcMain.handle('nyx:bookmarks:remove', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    return runtime.bookmarkStore.remove(payload && payload.id);
  });

  ipcMain.handle('nyx:bookmarks:clear', () => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    return runtime.bookmarkStore.clear();
  });

  ipcMain.handle('nyx:bookmarks:import', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    const source = payload && payload.source === 'chrome' ? 'chrome' : 'edge';
    return runtime.bookmarkStore.importFrom(source);
  });

  // ---------------- 工具栏星标（v1.4.0） ----------------
  // 星标只做两件事：查询当前页是否已收藏、切换收藏状态。
  // 真正的存储读写仍走 bookmark-store，避免在渲染层拼装业务判断。

  /** 查询是否已收藏：{ url } → { ok, bookmarked, id } */
  ipcMain.handle('nyx:bookmarks:has', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    const url = String((payload && payload.url) || '');
    if (!url) return { ok: true, bookmarked: false, id: null };
    const node = findBookmarkByUrl(url);
    return { ok: true, bookmarked: !!node, id: node ? node.id : null };
  });

  /** 切换收藏状态：{ url, title } → { ok, bookmarked }；已存在则取消收藏 */
  ipcMain.handle('nyx:bookmarks:toggle', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    const url = String((payload && payload.url) || '');
    const title = String((payload && payload.title) || '');
    if (!url) return { ok: false, error: '地址不合法' };

    const existing = findBookmarkByUrl(url);
    if (existing) {
      const removed = runtime.bookmarkStore.remove(existing.id);
      if (!removed || removed.ok === false) return { ok: false, error: (removed && removed.error) || '取消收藏失败' };
      notifyBookmarkBarChanged();
      console.log(`[Nyx] 已取消收藏｜${url}`);
      return { ok: true, bookmarked: false };
    }

    const added = runtime.bookmarkStore.add({ title: title || url, url });
    if (!added || added.ok === false) return { ok: false, error: (added && added.error) || '收藏失败' };
    notifyBookmarkBarChanged();
    console.log(`[Nyx] 已收藏｜${url}`);
    return { ok: true, bookmarked: true };
  });

  /** 弹出「收藏到文件夹」选择浮层：{ x, y, url, title }（屏幕坐标） */
  ipcMain.handle('nyx:bookmarks:folder-menu', (_event, payload) => openBookmarkFolderMenu(payload || {}));

  /** 关闭「收藏到文件夹」浮层（幂等） */
  ipcMain.handle('nyx:bookmarks:folder-close', () => {
    closeBookmarkFolderMenu();
    return { ok: true };
  });

  /** 浮层里选中文件夹：{ folderId: number | 'new', title? } → 把挂起的页面收藏进去 */
  ipcMain.handle('nyx:bookmarks:folder-pick', (_event, payload) => pickBookmarkFolder(payload || {}));

  /** 浮层里点置顶建议（v1.13.0）：直接在当前标签打开并收起浮层 */
  ipcMain.handle('nyx:bookmarks:folder-open-url', (_event, payload) => {
    const url = String((payload && payload.url) || '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '地址不合法' };
    closeBookmarkFolderMenu();
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    return runtime.tabManager.navigate(url);
  });

  // ---------------- 书签栏浮层 / 书签管理窗口（独立 BrowserWindow） ----------------
  // 背景：标签视图是 WebContentsView 原生子视图，DOM 浮层会被它整体盖住，
  // 因此书签下拉浮层必须用独立无边框 BrowserWindow（见 openBookmarkMenu）。

  /** 主窗口内容区屏幕坐标（浮层定位：渲染层把视口偏移换算成屏幕坐标） */
  ipcMain.handle('nyx:get-content-bounds', () => {
    const win = runtime.mainWindow;
    if (!win || win.isDestroyed()) return null;
    return win.getContentBounds();
  });

  /** 弹出书签下拉浮层：{ x, y, items }（屏幕坐标 + 递归子项数据） */
  ipcMain.handle('nyx:bm:menu-open', (_event, payload) => openBookmarkMenu(payload || {}));

  /** 关闭书签下拉浮层（幂等） */
  ipcMain.handle('nyx:bm:menu-close', () => {
    closeBookmarkMenu();
    return { ok: true };
  });

  /** 浮层内点击书签：在激活标签打开 URL，并自动关闭浮层 */
  ipcMain.handle('nyx:bm:menu-navigate', (_event, payload) => {
    const url = payload && payload.url;
    if (!runtime.tabManager || !url) return { ok: false, error: '地址无效' };
    closeBookmarkMenu();
    return runtime.tabManager.navigate(url);
  });

  /** 打开书签管理窗口（已打开则聚焦复用） */
  ipcMain.handle('nyx:bm:manage-open', () => openBookmarkManage());

  /** 关闭书签管理窗口 */
  ipcMain.handle('nyx:bm:manage-close', () => {
    const win = runtime.bookmarkManageWindow;
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });

  // ---------------- 地址栏历史建议（独立无边框浮层窗口，v1.3.0 新增） ----------------
  // 与书签浮层同源的限制：下拉列表必须盖在标签视图（WebContentsView）之上，
  // DOM 浮层会被子视图整体挡住，因此同样交给独立窗口承载（见 openAddressSuggest）。

  /** 查询建议：渲染层把地址栏的屏幕坐标与输入内容一起交上来，命中结果由此处统一计算 */
  ipcMain.handle('nyx:as:query', (event, payload) => {
    if (suggestBlocked(event)) {
      closeAddressSuggest();
      return { ok: true, count: 0, blocked: true };
    }
    return queryAddressSuggest(payload || {});
  });

  /** 键盘导航：down / up / enter / escape；高亮下标与最终选中项都由主进程维护 */
  ipcMain.handle('nyx:as:nav', (_event, payload) =>
    navAddressSuggest(payload && payload.key, { newTab: !!(payload && payload.newTab) }),
  );

  /** 关闭建议浮层（幂等） */
  ipcMain.handle('nyx:as:close', () => {
    closeAddressSuggest();
    return { ok: true };
  });

  /** 浮层内鼠标点击某条建议：在激活标签打开并收起浮层 */
  ipcMain.handle('nyx:as:pick', (_event, payload) => pickAddressSuggest(payload && payload.index));

  /** 浮层内鼠标移入某条建议：把高亮同步给主进程，回车即可选中它 */
  ipcMain.handle('nyx:as:hover', (_event, payload) => hoverAddressSuggest(payload && payload.index));

  /** 展开某个站点的全部命中：{ host }（v1.6.0 同站聚合） */
  ipcMain.handle('nyx:as:expand', (_event, payload) => expandAddressSuggestGroup(payload && payload.host));

  /** 置顶 / 取消置顶一条建议（v1.11.0；v1.16.0 带分组）：{ url, title, group } */
  ipcMain.handle('nyx:as:pin-toggle', (_event, payload) => {
    const result = togglePinnedSuggestion(
      payload && payload.url,
      payload && payload.title,
      payload && payload.group,
    );
    // 置顶状态变了，浮层要立刻重排：用同一份查询上下文重查一次
    if (result && result.ok && addressSuggestState.geo) {
      queryAddressSuggest({
        text: addressSuggestState.text,
        expandedHost: addressSuggestState.expandedHost,
        x: addressSuggestState.geo.x,
        y: addressSuggestState.geo.y,
        width: addressSuggestState.geo.width,
      });
    }
    return result;
  });

  /** 置顶列表（v1.16.0 附带分组定义，界面不必自己硬编码中文名） */
  ipcMain.handle('nyx:as:pinned', () => ({
    ok: true,
    items: readPinnedSuggestions(),
    groups: PINNED_GROUPS.map((item) => ({ key: item.key, label: item.label })),
    groupMax: PINNED_GROUP_MAX,
  }));

  /** 把一条置顶换个分组（v1.16.0）：{ url, group } */
  ipcMain.handle('nyx:as:pinned-group-set', (_event, payload) =>
    setPinnedSuggestionGroup(payload && payload.url, payload && payload.group));

  /**
   * 置顶顺序调整（v1.12.0）：{ urls: [...] }，按给定顺序重排（未列出的保持在后）。
   * v1.16.0 增 { group, urls: [...] }：只重排该组占用的位置，跨组顺序不受影响。
   */
  ipcMain.handle('nyx:as:pinned-reorder', (_event, payload) => reorderPinnedSuggestions(payload));

  /**
   * 置顶导入 / 导出（v1.15.0）。
   * 置顶是纯本地习惯数据，换机器或重装时不该手抄：导出成一份 JSON，
   * 导入时按 url 合并去重、填到上限为止，不覆盖用户现有条目。
   */
  ipcMain.handle('nyx:as:pinned-export', async (_event, payload) => {
    const items = readPinnedSuggestions();
    if (!items.length) return { ok: false, error: '还没有置顶项，先置顶一条再导出' };
    // 传了 path 就直写（脚本 / 命令行备份用），否则弹系统保存框
    const requested = String((payload && payload.path) || '');
    const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
    const stamp = new Date().toISOString().slice(0, 10);
    let target = requested;
    if (!target) {
      const picked = await dialog.showSaveDialog(win, {
        title: '导出地址栏置顶',
        defaultPath: path.join(app.getPath('documents'), `nyx-pinned-${stamp}.json`),
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }
    const payloadOut = {
      app: 'Nyx',
      kind: 'pinned-suggestions',
      version: 2,
      exportedAt: new Date().toISOString(),
      items: items.map((item) => ({
        url: item.url,
        title: item.title || item.url,
        group: normalizePinnedGroup(item.group),
      })),
    };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(payloadOut, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: `导出失败：${err.message}` };
    }
    return { ok: true, path: target, count: items.length };
  });

  ipcMain.handle('nyx:as:pinned-import', async (_event, payload) => {
    const requested = String((payload && payload.path) || '');
    const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
    let source = requested;
    if (!source) {
      const picked = await dialog.showOpenDialog(win, {
        title: '导入地址栏置顶',
        properties: ['openFile'],
        filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) {
        return { ok: false, canceled: true };
      }
      source = picked.filePaths[0];
    }
    let raw = '';
    try {
      raw = fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      return { ok: false, error: `读取失败：${err.message}` };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: '不是合法的 JSON 文件' };
    }
    // 兼容两种格式：本站导出的 { items: [...] }，或直接一份数组
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    if (!list) return { ok: false, error: '文件里没有找到置顶列表（需要 items 数组）' };

    const current = readPinnedSuggestions();
    const seen = new Set(current.map((item) => item.url));
    const merged = current.slice();
    let added = 0;
    let skipped = 0;
    let invalid = 0;
    for (const entry of list) {
      const url = typeof entry === 'string' ? entry : (entry && typeof entry.url === 'string' ? entry.url : '');
      const clean = String(url || '').trim();
      if (!/^https?:\/\//i.test(clean)) {
        invalid += 1;
        continue;
      }
      if (seen.has(clean)) {
        skipped += 1;
        continue;
      }
      // v1.16.0：老文件没有 group 字段，一律落到「其他」；目标组满了算 skipped
      const group = normalizePinnedGroup(entry && typeof entry === 'object' ? entry.group : '');
      if (countPinnedInGroup(merged, group) >= PINNED_GROUP_MAX) {
        skipped += 1;
        continue;
      }
      const title = entry && typeof entry.title === 'string' ? entry.title.trim().slice(0, 200) : '';
      insertPinnedInGroupOrder(merged, { url: clean, title: title || clean, group });
      seen.add(clean);
      added += 1;
    }
    if (added && !writePinnedSuggestions(merged)) return { ok: false, error: '写入失败' };
    return { ok: true, added, skipped, invalid, total: readPinnedSuggestions().length, path: source };
  });


  /**
   * 在"打开了同一地址"的多个标签之间循环切换（v1.9.0）。
   * 只有一个标签时等价于切过去；多个时每点一次顺延一个，回到最先那个后再次循环。
   */
  ipcMain.handle('nyx:tabs:cycle-by-url', (_event, payload) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    const url = String((payload && payload.url) || '');
    if (!url) return { ok: false, error: '地址无效' };
    let tabs = [];
    try {
      tabs = runtime.tabManager.snapshot().tabs || [];
    } catch {
      return { ok: false, error: '读取标签失败' };
    }
    const matches = tabs.filter((item) => item && item.url === url);
    if (!matches.length) return { ok: false, error: '该页面没有打开的标签' };

    const currentIndex = matches.findIndex((item) => item.active);
    const nextIndex = (currentIndex + 1) % matches.length;
    const target = matches[nextIndex];
    closeAddressSuggest();
    const result = runtime.tabManager.activate(target.id);
    return Object.assign({}, result, { index: nextIndex, total: matches.length });
  });

  /** 按 URL 切到已经打开的标签（v1.8.0）。
   * 建议里那条「已打开」徽标点下去就调这里——比再开一个重复标签更符合意图。
   */
  ipcMain.handle('nyx:tabs:activate-by-url', (_event, payload) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    const url = String((payload && payload.url) || '');
    if (!url) return { ok: false, error: '地址无效' };
    let tabs = [];
    try {
      tabs = runtime.tabManager.snapshot().tabs || [];
    } catch {
      return { ok: false, error: '读取标签失败' };
    }
    const tab = tabs.find((item) => item && item.url === url);
    if (!tab) return { ok: false, error: '该页面没有打开的标签' };
    closeAddressSuggest();
    return runtime.tabManager.activate(tab.id);
  });

  // ---------------- 站点图标（v1.6.0：地址栏建议与工具箱共用一份缓存） ----------------
  /**
   * 取某个站点的图标：{ host } → { ok, host, icon }。
   * icon 为 data URL（命中缓存）或空串；未命中时后台抓取，抓到后向所有窗口广播
   * nyx:icons:ready，调用方收到后再补画即可——绝不让界面等网络。
   */
  ipcMain.handle('nyx:icons:get', (_event, payload) => {
    if (!runtime.siteIcons) return { ok: false, host: '', icon: '', error: '图标缓存未就绪' };
    const host = String((payload && payload.host) || '');
    if (!host) return { ok: true, host: '', icon: '' };
    const cached = runtime.siteIcons.cached(host);
    if (cached) return { ok: true, host, icon: cached };

    runtime.siteIcons
      .ensure(host)
      .then((dataUrl) => {
        if (!dataUrl) return;
        const icons = { [host]: dataUrl };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send('nyx:icons:ready', { icons });
        }
      })
      .catch(() => {
        /* ensure 内部已记录失败，这里无需处理 */
      });
    return { ok: true, host, icon: '' };
  });

  /** 批量删除书签 / 文件夹：{ ids }，文件夹递归连带子项 */
  ipcMain.handle('nyx:bookmarks:remove-many', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    const res = runtime.bookmarkStore.removeMany(payload && payload.ids);
    if (res.ok && res.removed > 0) notifyBookmarkBarChanged();
    return res;
  });

  /** 同级排序：{ id, direction: 'up' | 'down' } */
  ipcMain.handle('nyx:bookmarks:move', (_event, payload) => {
    if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
    const res = runtime.bookmarkStore.moveItem(payload && payload.id, payload && payload.direction);
    if (res.ok && res.moved) notifyBookmarkBarChanged();
    return res;
  });

  // 隐私状态 / 权限轨迹 / 密码与表单记忆（含标签页结构化配置）
  registerPrivacyIpc();

  // 网络与代理（订阅 / 内核启停 / 节点 / 出口自查）
  registerProxyIpc();

  // 设置中心：界面偏好与应用信息
  registerSettingsIpc();

  registerUpdateIpc();

  // 扩展插件（设置中心「扩展插件」分区）
  registerExtensionsIpc();

  // 工具箱：资源嗅探 / 网络抓包 / 开发者模式 / 页面环境
  registerToolboxIpc();
}

/* ------------------------------------------------------------------ */
/* 隐私加固 / 权限 / 密码库 IPC                                          */
/* ------------------------------------------------------------------ */

/** 隐私模式下统一的读取/写入拒绝口径（不区分"没有"与"不给"，避免侧信道） */
const PRIVATE_DENIED = {
  ok: false,
  code: 'PRIVATE_MODE',
  error: '隐私模式下不读取、不写入任何密码与表单记忆',
};

/** 从 IPC 参数里取来源标识（站点 origin），并做长度与格式收敛 */
function safeOrigin(payload) {
  const origin = payload && payload.origin ? String(payload.origin).trim() : '';
  if (!origin || origin.length > 200 || /[\r\n]/.test(origin)) return '';
  return origin;
}

/**
 * 隐私现状快照（IPC 与本地 HTTP 接口共用同一份实现，避免两处口径漂移）。
 *
 * 只含"口径与统计"，不含任何凭据；出口画像与加固结果必须能同屏对照。
 */
function buildPrivacyStatus() {
  const manager = sessions.getPermissionManager();
  const vault = runtime.vault ? runtime.vault.stats() : null;
  return {
    ok: true,
    mode: sessions.getMode(),
    hardening: runtime.hardening
      ? runtime.hardening.status()
      : { mode: sessions.getMode(), hardened: false, last: null },
    egress: runtime.proxyService ? runtime.proxyService.egressProfile() : null,
    proxyPort: sessions.getProxyPort(),
    // 出站链路真相：隐私模式下 link 恒为 proxy；普通模式可能是 direct（代理不可达时的可用性兜底）
    network: networkSnapshot(),
    webrtcPolicy: runtime.hardening
      ? runtime.hardening.webrtcPolicy(sessions.getMode())
      : 'disable_non_proxied_udp',
    preloadArgs: sessions.getPreloadArgs(),
    permissions: manager ? manager.summary() : null,
    vault: vault
      ? {
          available: vault.available,
          backend: vault.backend,
          credentials: vault.credentials,
          forms: vault.forms,
        }
      : null,
  };
}

/** 权限决策轨迹（供界面与验收脚本查询） */
function buildPermissionView(limit) {
  const manager = sessions.getPermissionManager();
  if (!manager) return { ok: false, error: '权限管理器未就绪', decisions: [] };
  const size = Number(limit) > 0 ? Math.min(Number(limit), 200) : 50;
  return { ok: true, decisions: manager.list(size), summary: manager.summary() };
}

function registerPrivacyIpc() {
  /**
   * 标签页结构化配置（同步）。
   *
   * 页面预加载脚本在脚本执行前就要拿到这份"权威配置"（argv 在 sandbox 下不保证
   * 可见，只能作兜底），因此这里必须是 sendSync；返回内容仅为伪装参数，
   * 不含任何凭据或密钥。
   *
   * verify 是"是否允许向页面世界暴露验收探针（window.__nyxHardening）"的开关，
   * 只在实机验收（NYX_VERIFY=1）时打开：常开等于给每个页面加了一个普通 Chrome
   * 没有的全局对象，本身就是可被检测的指纹。
   */
  ipcMain.on('nyx:tab:config', (event) => {
    const mode = senderMode(event);
    try {
      event.returnValue = {
        ok: true,
        verify: process.env.NYX_VERIFY === '1',
        ...sessions.getPreloadConfig(mode),
      };
    } catch (err) {
      event.returnValue = { ok: false, mode, error: err.message };
    }
  });

  /* ---------------- 状态与审计（只读） ---------------- */

  ipcMain.handle('nyx:privacy:status', () => buildPrivacyStatus());

  ipcMain.handle('nyx:permissions:list', (_event, limit) => buildPermissionView(limit));

  /** 清空"按站点已记住的授权"：只清内存缓存，不触碰任何站点数据 */
  ipcMain.handle('nyx:permissions:clear', () => {
    const manager = sessions.getPermissionManager();
    if (!manager) return { ok: false, error: '权限管理器未就绪' };
    const result = manager.clearCache();
    console.log('[Nyx] 已清空按站点记住的授权');
    return result && typeof result === 'object' ? result : { ok: true };
  });

  /* ---------------- 密码与表单记忆 ---------------- */

  ipcMain.handle('nyx:vault:stats', () => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    return { ok: true, ...runtime.vault.stats() };
  });

  ipcMain.handle('nyx:vault:list', (event) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED, credentials: [], forms: [] };
    return {
      ok: true,
      credentials: runtime.vault.listCredentials(),
      forms: runtime.vault.listForms(),
    };
  });

  /** 页面问"这个站点有没有存过密码"：只回布尔值，不涉及密文与明文 */
  ipcMain.handle('nyx:vault:has', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED, has: false };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };
    return { ok: true, has: runtime.vault.hasCredential(origin) };
  });

  /**
   * 填充：解密只发生在这一次调用里。
   *
   * 明文只经 IPC 直达"发起填充的那个标签页"，不写日志、不落盘、不推送给其它窗口；
   * 页面预加载脚本收到后立即写入输入框，不做任何缓存。
   */
  ipcMain.handle('nyx:vault:fill', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };

    const credential = runtime.vault.readCredential(origin);
    if (!credential) return { ok: false, error: '该站点没有可填充的密码' };
    return { ok: true, username: credential.username, password: credential.password };
  });

  /** 站点提交登录表单后：密码在这里加密落盘（明文只存在于本次调用的参数与栈帧里） */
  ipcMain.handle('nyx:vault:offer-save', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };

    const result = runtime.vault.saveCredential(origin, {
      username: payload && payload.username,
      password: payload && payload.password,
    });
    // 日志只记录"哪个站点、成没成、为什么"，绝不回显密码本身
    console.log(
      `[Nyx] 密码${result.ok ? '已加密保存' : '未保存'}｜站点：${origin}` +
        `${result.ok ? '' : `｜原因：${result.error}`}`,
    );
    return result;
  });

  ipcMain.handle('nyx:forms:save', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };
    return runtime.vault.saveFormValues(origin, payload && payload.values);
  });

  ipcMain.handle('nyx:forms:load', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ok: false, code: 'PRIVATE_MODE', values: {} };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };
    return { ok: true, values: runtime.vault.readFormValues(origin) || {} };
  });

  /* ---------------- 密码库管理（界面用，隐私模式下同样拒绝） ---------------- */

  ipcMain.handle('nyx:vault:remove', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload);
    if (!origin) return { ok: false, error: '来源缺失' };
    const result = runtime.vault.removeCredential(origin);
    if (result.ok) console.log(`[Nyx] 已删除该站点的密码｜站点：${origin}`);
    return result;
  });

  ipcMain.handle('nyx:vault:clear', (event) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const result = runtime.vault.clearAll();
    if (result.ok) console.log('[Nyx] 密码库已清空（密码与表单记忆全部删除）');
    return result;
  });
}

/* ------------------------------------------------------------------ */
/* 书签栏浮层 / 书签管理窗口（独立 BrowserWindow）                       */
/* ------------------------------------------------------------------ */

/**
 * 弹出书签下拉浮层（独立无边框 BrowserWindow，置顶、跳过任务栏）。
 *
 * 为什么不用主窗口 DOM：
 *   标签视图是 WebContentsView（原生子视图），始终压在 index.html 之上，
 *   旧版用 DOM 渲染的 .bm-menu 从 y≈126 起就被标签视图整体盖住、点不到也看不见。
 *   改成独立 BrowserWindow 后浮层永远显示在最上层，与标签视图互不干扰。
 *
 * @param {{x:number, y:number, items:Array}} payload
 *        x / y 为屏幕坐标（渲染层用 getContentBounds 换算：winLeft+rect.left、
 *        winTop+rect.bottom+6）；items 为递归子项（url 书签 + 文件夹标题行，带层级）。
 */
function openBookmarkMenu(payload) {
  const mainWin = runtime.mainWindow;
  if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const x = Number(payload && payload.x);
  const y = Number(payload && payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '浮层坐标无效' };

  // 复用已打开的浮层：只换数据 + 重新定位，避免窗口闪跳
  const existing = runtime.bookmarkMenuWindow;
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('nyx:bm:data', { items });
    existing.setPosition(Math.round(x), Math.round(y));
    existing.show();
    existing.focus();
    return { ok: true, reused: true };
  }

  // 窗口高度按条目数估算（标题行 30px + 上下留白），封顶 380px，超出内部滚动
  const height = Math.min(380, Math.max(60, 18 + items.length * 30));
  const win = new BrowserWindow({
    width: 300,
    height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // 窗口出现前的底色跟随主题（CSS 管不到，避免浅色主题下闪深色）
    backgroundColor: THEME_BG[(runtime.uiStore && runtime.uiStore.get().theme) || 'ink'],
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'bm-menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  runtime.bookmarkMenuWindow = win;

  // 浮层是纯展示窗口：禁止开新窗口、禁止导航到任何远端地址
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'bm-menu.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('nyx:bm:data', { items });
    placeBookmarkMenu(win, x, y, 300, height);
    win.show();
    win.focus();
  });

  // 失焦自动关闭：延迟一小段，避免「点按钮弹窗 → 焦点转移」瞬间被误关
  win.on('blur', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.webContents.isFocused()) closeBookmarkMenu();
    }, 120);
  });

  win.on('closed', () => {
    if (runtime.bookmarkMenuWindow === win) runtime.bookmarkMenuWindow = null;
  });

  return { ok: true, reused: false };
}

/**
 * 把浮层窗口放到目标位置，并按工作区边界收敛：
 * 书签栏最右侧的文件夹按钮触发时，原始 x + 300 可能超出屏幕右缘。
 */
function placeBookmarkMenu(win, x, y, width, height) {
  let px = Math.round(x);
  let py = Math.round(y);
  try {
    const display = screen.getDisplayNearestPoint({ x: px, y: py });
    const work = display.workArea;
    if (px + width > work.x + work.width) px = work.x + work.width - width;
    if (py + height > work.y + work.height) py = work.y + work.height - height;
    if (px < work.x) px = work.x;
    if (py < work.y) py = work.y;
  } catch {
    // 屏幕信息不可用时按原始坐标放置，不影响功能
  }
  win.setPosition(px, py);
}

/** 关闭书签下拉浮层（幂等） */
function closeBookmarkMenu() {
  const win = runtime.bookmarkMenuWindow;
  if (win && !win.isDestroyed()) win.close();
  runtime.bookmarkMenuWindow = null;
}

/* ------------------------------------------------------------------ */
/* 地址栏历史建议（独立无边框透明浮层，v1.3.0 新增）                      */
/* ------------------------------------------------------------------ */

/** 建议条数上限：再多用户也看不过来，列表越长越容易误触 */
const ADDRESS_SUGGEST_LIMIT = 8;
/** 单条目高度（dip）：与 addr-suggest.css 里 .as-item 的高度必须一致 */
const ADDRESS_SUGGEST_ITEM_H = 30;
/** 面板内边距与边框占位（dip）：窗口高度 = 条目数 × 条目高 + 此值 */
const ADDRESS_SUGGEST_CHROME_H = 12;
/** 浮层宽度收敛范围（dip）：跟随地址栏宽度，但不允许太窄或横跨整屏 */
const ADDRESS_SUGGEST_MIN_W = 280;
const ADDRESS_SUGGEST_MAX_W = 760;

/** 当前建议状态：条目 + 高亮下标（-1 = 无高亮，回车按地址栏原文导航）+ 本次查询词 */
/** 当前建议状态：条目 + 高亮下标（-1 = 无高亮，回车按地址栏原文导航）+ 本次查询上下文 */
const addressSuggestState = {
  items: [],
  index: -1,
  query: '',
  /** 原始输入（展开同站分组时要按它重查） */
  text: '',
  /** 已展开的站点（v1.6.0）：该 host 的全部命中都平铺展示 */
  expandedHost: '',
  /** 最近一次的浮层锚点（展开时复用，避免再向渲染层要坐标） */
  geo: null,
};


/**
 * 全隐私模式下不提供历史建议。
 * 理由：历史记录本身在隐私模式不写入，若把普通模式积累的历史条目展示出来，
 * 等于在"全隐私"界面里泄漏用户在普通模式的浏览痕迹，与产品红线相悖。
 * 因此这里做第二道闸（第一道在渲染层：隐私模式压根不发查询）。
 */
function suggestBlocked(event) {
  try {
    if (sessions.getMode() === 'private') return true;
    if (event && typeof senderMode === 'function' && senderMode(event) === 'private') return true;
  } catch {
    // 会话未就绪时按"不允许"处理：建议属于锦上添花，宁可不出也不能越界
    return true;
  }
  return false;
}

/** 取 URL 的主机名，仅用于建议条目的次要显示；解析失败返回空串 */
function hostOfUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 读剪贴板里是否是一条网址（v1.10.0）。
 * 只在普通模式、每次查询时读一次；隐私模式压根不会走到这里（建议被整体禁用）。
 */
function readClipboardUrl() {
  try {
    const text = String(clipboard.readText() || '').trim();
    if (!text || text.length > 2048) return '';
    return /^https?:\/\/\S+$/i.test(text) ? text : '';
  } catch {
    // 剪贴板被占用 / 无权限：当作没有，不影响建议本身
    return '';
  }
}

/**
 * 递归摊平书签树，只留可跳转的 http(s) 书签。
 * 文件夹本身不是可导航目标，不入建议；层级在这里被拍平（建议列表是一维的）。
 */
function flattenBookmarkUrls(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.url === 'string' && /^https?:\/\//i.test(node.url)) {
    out.push({ url: node.url, title: typeof node.title === 'string' ? node.title : '' });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) flattenBookmarkUrls(child, out);
  }
  return out;
}

/**
 * 建议打分权重（v1.4.0：访问频次加权）。
 * 数值只决定相对顺序，不对外暴露；调整这里就能改"什么更值得排前面"。
 */
const SUGGEST_WEIGHT = {
  /** 前缀命中（网址或主机名以输入开头）：最直观的意图信号，权重最高 */
  prefix: 100,
  /** 已收藏：用户主动表达过"这个我要留着" */
  bookmark: 60,
  /** 每次历史访问折算的加分 */
  visit: 5,
  /** 访问次数计分上限：访问 10 次封顶，避免常驻站点永远霸榜 */
  visitCap: 10,
  /** 最近访问时间加分上限 */
  recencyMax: 30,
  /** 每远离一天扣多少分（30 天前基本归零） */
  recencyPerDay: 3,
  /** 完全没有历史记录时的保底"天数"（等价于很久以前访问过） */
  staleDays: 30,
};

/* ------------------------------------------------------------------ */
/* 建议置顶（v1.11.0）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 置顶建议的分组（v1.16.0）。
 * 5 条上限对"工作 + 学习 + 其他"混在一起用的人太少，改成每组 5 条、共 15 条；
 * 组只是标签，不改变"置顶优先"的排序语义。
 */
const PINNED_GROUPS = [
  { key: 'work', label: '工作' },
  { key: 'study', label: '学习' },
  { key: 'other', label: '其他' },
];

/** 每组上限：多了会把真正相关的历史挤没 */
const PINNED_GROUP_MAX = 5;

/** 总上限（每组上限 × 组数），读写两侧都按它兜底 */
const PINNED_SUGGEST_MAX = PINNED_GROUPS.length * PINNED_GROUP_MAX;

/** 把任意输入收敛成一个合法分组 key，非法一律落到「其他」 */
function normalizePinnedGroup(value) {
  const key = String(value || '').trim().toLowerCase();
  return PINNED_GROUPS.some((item) => item.key === key) ? key : 'other';
}

/** 分组 key → 中文名（界面与建议徽标共用一份口径） */
function pinnedGroupLabel(key) {
  const found = PINNED_GROUPS.find((item) => item.key === normalizePinnedGroup(key));
  return found ? found.label : '其他';
}

/** 统计某个分组当前有几条 */
function countPinnedInGroup(list, group) {
  const key = normalizePinnedGroup(group);
  return list.filter((item) => item.group === key).length;
}

/** 把一条插到它所属分组的末尾（没有同组条目时按组顺序找插入点） */
function insertPinnedInGroupOrder(list, item) {
  const groupIndex = PINNED_GROUPS.findIndex((g) => g.key === item.group);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].group === item.group) {
      list.splice(i + 1, 0, item);
      return;
    }
  }
  // 该组还没有条目：插在第一个"组序更靠后"的条目之前，保持 工作 → 学习 → 其他
  for (let i = 0; i < list.length; i += 1) {
    const otherIndex = PINNED_GROUPS.findIndex((g) => g.key === list[i].group);
    if (otherIndex > groupIndex) {
      list.splice(i, 0, item);
      return;
    }
  }
  list.push(item);
}

function pinnedSuggestPath() {
  return path.join(app.getPath('userData'), 'pinned-suggestions.json');
}

/** 读取置顶列表：[{ url, title, group }]，损坏/超限一律降级（每组各自截断） */
function readPinnedSuggestions() {
  try {
    const file = pinnedSuggestPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw)) return [];
    const out = [];
    const counts = new Map();
    for (const item of raw) {
      if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
      const group = normalizePinnedGroup(item.group);
      const used = counts.get(group) || 0;
      if (used >= PINNED_GROUP_MAX) continue;
      counts.set(group, used + 1);
      out.push({
        url: item.url,
        title: typeof item.title === 'string' ? item.title : item.url,
        group,
      });
      if (out.length >= PINNED_SUGGEST_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writePinnedSuggestions(list) {
  try {
    // 写之前再按组截断一次，避免别的路径塞进超限数据
    const capped = [];
    const counts = new Map();
    for (const item of list) {
      const group = normalizePinnedGroup(item && item.group);
      const used = counts.get(group) || 0;
      if (used >= PINNED_GROUP_MAX) continue;
      counts.set(group, used + 1);
      capped.push({ url: item.url, title: item.title || item.url, group });
      if (capped.length >= PINNED_SUGGEST_MAX) break;
    }
    fs.writeFileSync(pinnedSuggestPath(), JSON.stringify(capped, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 置顶/取消置顶：返回最新状态（界面用同一个入口切换） */
function togglePinnedSuggestion(url, title, group) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, error: '地址不合法' };
  const list = readPinnedSuggestions();
  const index = list.findIndex((item) => item.url === clean);
  if (index >= 0) {
    list.splice(index, 1);
    if (!writePinnedSuggestions(list)) return { ok: false, error: '写入失败' };
    return { ok: true, pinned: false, total: list.length };
  }
  const target = normalizePinnedGroup(group);
  if (countPinnedInGroup(list, target) >= PINNED_GROUP_MAX) {
    return { ok: false, error: `「${pinnedGroupLabel(target)}」最多只能置顶 ${PINNED_GROUP_MAX} 条，先取消一条` };
  }
  insertPinnedInGroupOrder(list, {
    url: clean,
    title: String(title || '') || clean,
    group: target,
  });
  if (!writePinnedSuggestions(list)) return { ok: false, error: '写入失败' };
  return { ok: true, pinned: true, total: list.length, group: target };
}

/** 把一条置顶移到另一个分组（v1.16.0）：目标组满了就不动 */
function setPinnedSuggestionGroup(url, group) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, error: '地址不合法' };
  const target = normalizePinnedGroup(group);
  const list = readPinnedSuggestions();
  const index = list.findIndex((item) => item.url === clean);
  if (index < 0) return { ok: false, error: '这条不在置顶里' };
  if (list[index].group === target) return { ok: true, items: list, moved: false };
  if (countPinnedInGroup(list, target) >= PINNED_GROUP_MAX) {
    return { ok: false, error: `「${pinnedGroupLabel(target)}」最多只能置顶 ${PINNED_GROUP_MAX} 条，先取消一条` };
  }
  const [item] = list.splice(index, 1);
  item.group = target;
  insertPinnedInGroupOrder(list, item);
  if (!writePinnedSuggestions(list)) return { ok: false, error: '写入失败' };
  return { ok: true, items: readPinnedSuggestions(), moved: true };
}

/**
 * 置顶排序（v1.12.0 全量顺序 / v1.16.0 组内顺序）。
 * 传 group 时只重排该组占用的位置，其它组条目原地不动；不传则沿用全量顺序语义。
 */
function reorderPinnedSuggestions(payload) {
  const urls = Array.isArray(payload && payload.urls) ? payload.urls.map((item) => String(item)) : null;
  if (!urls) return { ok: false, error: '参数不合法' };
  const list = readPinnedSuggestions();
  const group = payload && payload.group ? normalizePinnedGroup(payload.group) : '';

  if (!group) {
    const byUrl = new Map(list.map((item) => [item.url, item]));
    const ordered = [];
    for (const url of urls) {
      const item = byUrl.get(url);
      if (!item) continue;
      ordered.push(item);
      byUrl.delete(url);
    }
    for (const item of byUrl.values()) ordered.push(item);
    if (!writePinnedSuggestions(ordered)) return { ok: false, error: '写入失败' };
    return { ok: true, items: ordered };
  }

  const slots = [];
  list.forEach((item, index) => {
    if (item.group === group) slots.push(index);
  });
  const byUrl = new Map(list.map((item) => [item.url, item]));
  const picked = [];
  for (const url of urls) {
    const item = byUrl.get(url);
    if (!item || item.group !== group || picked.includes(item)) continue;
    picked.push(item);
  }
  for (const item of list) {
    if (item.group === group && !picked.includes(item)) picked.push(item);
  }
  const next = list.slice();
  slots.forEach((slot, index) => {
    if (picked[index]) next[slot] = picked[index];
  });
  if (!writePinnedSuggestions(next)) return { ok: false, error: '写入失败' };
  return { ok: true, items: readPinnedSuggestions() };
}

/**
 * 计算建议条目（v1.3.1 书签并入；v1.4.0 频次加权 + 搜索行；v1.11.0 置顶）。
 *
 * 候选来源：书签（用户主动收藏）与历史记录（含重复访问形成的多条记录）。
 * 打分（score，越大越靠前）：
 *   前缀命中 +100；书签 +60；访问次数 min(n,10)×5；最近访问 30 分递减（每天 -3）。
 * 同分时按"最近访问时间"倒序，再按 url 稳定排序（避免每次查询顺序抖动）。
 * 末尾追加一条「搜索「输入」」直通行（输入看起来是网址时不加）。
 * 只收 http(s)：内部页、file://、data: 一律不进建议。
 */
function addressSuggestMatches(text, options) {
  const query = String(text || '').trim().toLowerCase();
  if (!query) return [];

  // 1. 先统计历史里的访问频次与最近访问时间：
  //    同一 URL 在 5 分钟去重窗口之外会有多条记录，条数即近似访问次数。
  const stats = new Map();
  const list = runtime.historyStore ? runtime.historyStore.list() : [];
  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;
    const at = Number(item.visitedAt) || 0;
    const prev = stats.get(item.url);
    if (prev) {
      prev.count += 1;
      if (at > prev.lastAt) prev.lastAt = at;
    } else {
      stats.set(item.url, { count: 1, lastAt: at });
    }
  }

  const now = Date.now();
  const seen = new Set();
  const candidates = [];

  /** 命中判定 + 打分 + 入列 */
  function consider(source, url, rawTitle) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    if (seen.has(url)) return; // 书签先入列，同 URL 的历史记录会被这里挡掉（收藏优先）
    const title = typeof rawTitle === 'string' ? rawTitle : '';
    const host = hostOfUrl(url);
    const lowerUrl = url.toLowerCase();
    const lowerTitle = title.toLowerCase();
    if (!lowerUrl.includes(query) && !lowerTitle.includes(query)) return;

    seen.add(url);
    const stat = stats.get(url) || { count: 0, lastAt: 0 };
    const isPrefix = lowerUrl.startsWith(query) || host.toLowerCase().startsWith(query);
    const days = stat.lastAt ? Math.max(0, (now - stat.lastAt) / 86400000) : SUGGEST_WEIGHT.staleDays;
    const recency = Math.max(0, SUGGEST_WEIGHT.recencyMax - days * SUGGEST_WEIGHT.recencyPerDay);
    const score =
      (isPrefix ? SUGGEST_WEIGHT.prefix : 0) +
      (source === 'bookmark' ? SUGGEST_WEIGHT.bookmark : 0) +
      Math.min(stat.count, SUGGEST_WEIGHT.visitCap) * SUGGEST_WEIGHT.visit +
      recency;

    candidates.push({
      url,
      title: title || url,
      host,
      source,
      visits: stat.count,
      lastAt: stat.lastAt,
      prefix: isPrefix,
      score,
    });
  }

  // 2. 书签先入列（收藏优先），再补历史
  try {
    const tree = runtime.bookmarkStore ? runtime.bookmarkStore.listTree() : null;
    const root = tree && tree.root;
    if (root) {
      for (const item of flattenBookmarkUrls(root, [])) consider('bookmark', item.url, item.title);
    }
  } catch (err) {
    // 书签存储异常不能连带拖垮建议：退化成"只有历史"
    console.warn('[Nyx] 地址栏建议读取书签失败：', err && err.message);
  }
  for (const item of list) {
    if (!item || typeof item.url !== 'string') continue;
    consider('history', item.url, item.title);
  }

  // 3. 排序：分数 → 最近访问 → url（稳定，防抖动）
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });

  // 4. 同站聚合（v1.6.0）：默认每个站点只露一条，其余折叠成「+N」；
  //    用户点了「+N」后，主进程按 expandedHost 重查，该站点的全部命中平铺出来。
  const expandedHost = String((options && options.expandedHost) || '').toLowerCase();
  const groupOrder = [];
  const groups = new Map();
  for (const item of candidates) {
    const key = item.host || '';
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push(item);
  }

  const merged = [];
  for (const key of groupOrder) {
    const list2 = groups.get(key);
    if (key === expandedHost) {
      merged.push(...list2);
      continue;
    }
    const head = Object.assign({}, list2[0], {
      groupCount: list2.length,
      groupHost: key,
      expandable: list2.length > 1,
      expanded: false,
    });
    merged.push(head);
  }

  // 5. 置顶项（v1.11.0；v1.16.0 带分组）：命中的置顶条目排最前，按置顶列表自身顺序（组序 + 组内序）
  const pinnedList = readPinnedSuggestions();
  const pinnedSet = new Set(pinnedList.map((item) => item.url));
  const pinnedGroupOf = new Map(pinnedList.map((item) => [item.url, item.group]));
  const pinnedOrderOf = new Map(pinnedList.map((item, index) => [item.url, index]));
  const pinnedTop = [];
  for (const item of merged) {
    if (!pinnedSet.has(item.url)) continue;
    item.pinned = true;
    item.pinnedGroup = pinnedGroupOf.get(item.url) || 'other';
    item.pinnedGroupLabel = pinnedGroupLabel(item.pinnedGroup);
    pinnedTop.push(item);
  }
  const rest = merged.filter((item) => !pinnedSet.has(item.url));
  for (const item of pinnedList) {
    if (pinnedSet.size && !pinnedTop.some((top) => top.url === item.url)) {
      const hay = `${item.url}\n${item.title}`.toLowerCase();
      if (!hay.includes(query)) continue; // 置顶项也要跟查询相关才出现在列表里
      pinnedTop.push({
        url: item.url,
        title: item.title || item.url,
        host: hostOfUrl(item.url),
        source: 'pinned',
        visits: 0,
        lastAt: 0,
        prefix: false,
        pinned: true,
        pinnedGroup: item.group,
        pinnedGroupLabel: pinnedGroupLabel(item.group),
        score: 1000,
      });
    }
  }
  // 置顶段内部按置顶列表顺序排（书签/历史命中的那条可能排在被兜底追加的前面）
  pinnedTop.sort((a, b) => (pinnedOrderOf.get(a.url) || 0) - (pinnedOrderOf.get(b.url) || 0));
  const ordered = pinnedTop.concat(rest);

  // 6. 截断 + 附加行（剪贴板网址 / 搜索直通）
  const extras = [];
  const clipRow = buildSuggestClipboardRow(options && options.clipboard, candidates);
  if (clipRow) extras.push(clipRow);
  const searchRow = buildSuggestSearchRow(text);
  if (searchRow) extras.push(searchRow);

  const budget = Math.max(0, ADDRESS_SUGGEST_LIMIT - extras.length);
  const limited = ordered.slice(0, budget).concat(extras);

  return limited;
}

/**
 * 「打开剪贴板里的网址」行（v1.10.0）。
 * 只在剪贴板确实是一条 http(s) 网址、且不在已有候选里时才出现——
 * 否则会变成常驻噪音。内容按 URL 截断展示，避免超长链接撑破浮层。
 */
function buildSuggestClipboardRow(clipText, candidates) {
  const raw = String(clipText || '').trim();
  if (!raw || raw.length > 2048) return null;
  if (!/^https?:\/\/\S+$/i.test(raw)) return null;
  if (Array.isArray(candidates) && candidates.some((item) => item.url === raw)) return null;

  const host = hostOfUrl(raw);
  const shortUrl = raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
  return {
    url: raw,
    title: `打开剪贴板网址：${shortUrl}`,
    host,
    source: 'clipboard',
    visits: 0,
    lastAt: 0,
    prefix: false,
    score: -2,
  };
}

/**
 * 构造「搜索「输入」」直通行（v1.4.0）。
 * 复用主进程既有的地址栏规范化规则：只有规范化结果落在搜索分支时才加这一行，
 * 所以输入域名 / IP / 带协议地址时不会多出一条"搜索"，行为与回车完全一致。
 */
function buildSuggestSearchRow(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let normalized = '';
  try {
    normalized = normalizeInput(raw);
  } catch {
    return null;
  }
  if (!/^https?:\/\/www\.bing\.com\/search\?q=/i.test(normalized)) return null;
  return {
    url: normalized,
    title: `搜索「${raw}」`,
    host: 'Bing',
    source: 'search',
    visits: 0,
    lastAt: 0,
    prefix: false,
    score: -1,
  };
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 建议条目的站点图标（v1.5.0 引入，v1.6.0 抽到 core/site-icons 供多处共用） */
/* ------------------------------------------------------------------ */

/** 一次列表最多补几个 host：避免打开列表就发一堆请求 */
const SUGGEST_ICON_MAX_PER_LIST = 4;

/** 把图标推给建议浮层（浮层只做渲染，不主动索取） */
function pushSuggestIcons(icons) {
  const win = runtime.addressSuggestWindow;
  if (!win || win.isDestroyed() || !icons || !Object.keys(icons).length) return;
  win.webContents.send('nyx:as:icons', { icons });
}

/**
 * 为当前列表补图标：缓存命中立刻推，未命中最多抓 SUGGEST_ICON_MAX_PER_LIST 个。
 * 抓取/缓存/失败语义都在 core/site-icons.js 里，这里只负责"挑哪些 host、什么时候推"。
 */
function kickSuggestIcons(items) {
  const icons = runtime.siteIcons;
  if (!icons) return;
  const hosts = [];
  for (const item of items || []) {
    if (!item || item.source === 'search') continue; // 搜索行用固定徽标，不抓图标
    const host = item.host;
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
  }
  if (!hosts.length) return;

  const ready = {};
  const todo = [];
  for (const host of hosts) {
    const hit = icons.cached(host);
    if (hit) ready[host] = hit;
    else todo.push(host);
  }
  pushSuggestIcons(ready);

  for (const host of todo.slice(0, SUGGEST_ICON_MAX_PER_LIST)) {
    icons
      .ensure(host)
      .then((dataUrl) => {
        if (!dataUrl) return;
        pushSuggestIcons({ [host]: dataUrl });
      })
      .catch(() => {
        /* ensure 内部已记录失败，这里无需处理 */
      });
  }
}

/** 把建议浮层放到地址栏正下方，并按屏幕工作区收敛（同书签浮层的处理思路） */
function placeAddressSuggest(win, x, y, width, height) {
  let px = Math.round(x);
  let py = Math.round(y);
  try {
    const display = screen.getDisplayNearestPoint({ x: px, y: py });
    const work = display.workArea;
    if (px + width > work.x + work.width) px = work.x + work.width - width;
    if (py + height > work.y + work.height) py = work.y + work.height - height;
    if (px < work.x) px = work.x;
    if (py < work.y) py = work.y;
  } catch {
    // 屏幕信息不可用时按原始坐标放置，不影响功能
  }
  win.setBounds({ x: px, y: py, width: Math.round(width), height: Math.round(height) });
}

/**
 * 创建 / 复用 / 定位建议浮层并推送数据。
 *
 * 焦点纪律（关键）：窗口必须 focusable:false + showInactive()。
 * 只要浮层抢到焦点，地址栏就会失焦，用户打字会被打断——这是这类
 * "贴在输入框下方"的浮层最容易踩的坑。
 */
function showAddressSuggest(geo, items, index) {
  const mainWin = runtime.mainWindow;
  if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
  if (!items || !items.length) {
    closeAddressSuggest();
    return { ok: true, count: 0 };
  }

  const rawWidth = Number(geo.width);
  const width = Math.min(
    ADDRESS_SUGGEST_MAX_W,
    Math.max(ADDRESS_SUGGEST_MIN_W, Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 460),
  );
  const height = items.length * ADDRESS_SUGGEST_ITEM_H + ADDRESS_SUGGEST_CHROME_H;
  const x = Number(geo.x);
  const y = Number(geo.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '浮层坐标无效' };

  const theme = (runtime.uiStore && runtime.uiStore.get().theme) || 'ink';
  // query 一并下发：浮层要按它给命中片段加 <mark> 高亮（高亮在渲染层做，主进程不拼 HTML）
  const data = { items, index: Number.isFinite(index) ? index : -1, theme, query: addressSuggestState.query };

  const existing = runtime.addressSuggestWindow;
  if (existing && !existing.isDestroyed()) {
    placeAddressSuggest(existing, x, y, width, height);
    existing.webContents.send('nyx:as:data', data);
    if (!existing.isVisible()) existing.showInactive();
    // 图标是异步补的：缓存命中会立刻推一次，未命中的在后台抓
    kickSuggestIcons(items);
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 绝不抢地址栏焦点
    focusable: false,
    // 阴影由 CSS 画在透明窗口上，避免系统阴影与圆角面板错位
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'addr-suggest-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  runtime.addressSuggestWindow = win;

  // 纯展示窗口：禁止开新窗口、禁止导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'addr-suggest.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // 注意：这里必须推送「当前实时状态」，不能用创建窗口时捕获的 index ——
    // 页面加载期间用户可能已经按了上下键（高亮已变），用旧值会让浮层与主进程不一致。
    win.webContents.send('nyx:as:data', {
      items: addressSuggestState.items.length ? addressSuggestState.items : items,
      index: addressSuggestState.index,
      theme,
      query: addressSuggestState.query,
    });
    placeAddressSuggest(win, x, y, width, height);
    win.showInactive();
    // 首次弹出：同样是"缓存命中立即推 + 未命中后台抓"
    kickSuggestIcons(addressSuggestState.items.length ? addressSuggestState.items : items);
  });

  win.on('closed', () => {
    if (runtime.addressSuggestWindow === win) runtime.addressSuggestWindow = null;
  });

  return { ok: true, reused: false };
}

/** 关闭建议浮层（幂等），同时清空高亮状态 */
function closeAddressSuggest() {
  addressSuggestState.items = [];
  addressSuggestState.index = -1;
  addressSuggestState.query = '';
  addressSuggestState.text = '';
  addressSuggestState.expandedHost = '';
  const win = runtime.addressSuggestWindow;
  if (win && !win.isDestroyed()) win.close();
  runtime.addressSuggestWindow = null;
}

/**
 * 给建议条目补「是否已在标签里打开」的信息（v1.7.0）。
 * 目的：用户想回到某个已开的页面时，一眼能看出"它已经开着"，而不是又开一个重复标签。
 */
function annotateSuggestOpenTabs(items) {
  if (!items || !items.length || !runtime.tabManager) return;
  let tabs = [];
  try {
    tabs = runtime.tabManager.snapshot().tabs || [];
  } catch {
    return;
  }
  if (!tabs.length) return;

  const counts = new Map();
  let activeUrl = '';
  for (const tab of tabs) {
    if (!tab || !tab.url) continue;
    counts.set(tab.url, (counts.get(tab.url) || 0) + 1);
    if (tab.active) activeUrl = tab.url;
  }

  for (const item of items) {
    if (!item || !item.url) continue;
    const count = counts.get(item.url) || 0;
    if (count > 0) {
      item.openTabs = count;
      item.isActivePage = item.url === activeUrl;
    }
  }
}

/** 处理一次查询：算命中 → 开/更新浮层 → 返回条目数 */
function queryAddressSuggest(payload) {
  const text = String((payload && payload.text) || '');
  const expandedHost = String((payload && payload.expandedHost) || '').toLowerCase();
  const items = addressSuggestMatches(text, { expandedHost, clipboard: readClipboardUrl() });
  // v1.7.0：标出"这个地址已经开在某个标签里了"
  annotateSuggestOpenTabs(items);

  // 记下查询上下文：用户点「+N」展开同站分组时要用同一份输入与锚点重查
  addressSuggestState.text = text;
  addressSuggestState.expandedHost = expandedHost;
  addressSuggestState.geo = {
    x: payload.x,
    y: payload.y,
    width: payload.width,
  };
  addressSuggestState.items = items;
  // 查询词留给渲染层做命中高亮（传原文，大小写按用户输入保留）
  addressSuggestState.query = text.trim();
  // 默认不高亮：用户直接回车 = 按输入原样导航（与地址栏直觉一致），
  // 只有按了上下键或鼠标移入才会有高亮项
  addressSuggestState.index = -1;
  if (!items.length) {
    closeAddressSuggest();
    return { ok: true, count: 0 };
  }
  const shown = showAddressSuggest(
    { x: payload.x, y: payload.y, width: payload.width },
    items,
    addressSuggestState.index,
  );
  return { ok: !!shown.ok, count: items.length, expandedHost };
}

/**
 * 展开某个站点的全部命中（v1.6.0）。
 * 用同一份输入与锚点重查一次，只是把 expandedHost 带上；浮层会原地重渲染。
 */
function expandAddressSuggestGroup(rawHost) {
  const host = String(rawHost || '').toLowerCase();
  if (!host || !addressSuggestState.geo) return { ok: false, error: '没有可展开的分组' };
  return queryAddressSuggest({
    text: addressSuggestState.text,
    expandedHost: host,
    x: addressSuggestState.geo.x,
    y: addressSuggestState.geo.y,
    width: addressSuggestState.geo.width,
  });
}

/**
 * 键盘导航：维护高亮下标；enter 时把选中项交给渲染层导航。
 *
 * v1.5.0 补齐：first / last（Home / End 跳到首末条）与 newTab（Ctrl+Enter 新标签打开）。
 * 这些键的"是否劫持"由渲染层判断（详情见 renderer.js 的 keydown），主进程只负责状态。
 */
function navAddressSuggest(key, options) {
  const items = addressSuggestState.items;
  if (!items.length) return { ok: true, handled: false };

  if (key === 'escape') {
    closeAddressSuggest();
    return { ok: true, handled: true, closed: true };
  }

  if (key === 'down' || key === 'up') {
    const delta = key === 'down' ? 1 : -1;
    let next = addressSuggestState.index + delta;
    // 在「无高亮」与最后一条之间循环：下键从第一条开始，上键从最后一条开始
    if (next >= items.length) next = -1;
    if (next < -1) next = items.length - 1;
    addressSuggestState.index = next;
    const win = runtime.addressSuggestWindow;
    if (win && !win.isDestroyed()) win.webContents.send('nyx:as:index', { index: next });
    return { ok: true, handled: true, index: next };
  }

  // Home / End：直接落到第一条 / 最后一条（末位是搜索行时也能一步选中）
  if (key === 'first' || key === 'last') {
    const next = key === 'first' ? 0 : items.length - 1;
    addressSuggestState.index = next;
    const win = runtime.addressSuggestWindow;
    if (win && !win.isDestroyed()) win.webContents.send('nyx:as:index', { index: next });
    return { ok: true, handled: true, index: next };
  }

  if (key === 'enter') {
    const index = addressSuggestState.index;
    if (index < 0 || index >= items.length) return { ok: true, handled: false };
    const url = items[index].url;
    const newTab = !!(options && options.newTab);
    closeAddressSuggest();
    // newTab 只回传意图，开标签由渲染层调用 createTab 完成（与普通导航共用一套路径）
    return { ok: true, handled: true, url, newTab };
  }

  return { ok: true, handled: false };
}

/** 浮层内鼠标移入：同步高亮（同一份状态，保证"鼠标指向哪条、回车就是哪条"） */
function hoverAddressSuggest(rawIndex) {
  const index = Number(rawIndex);
  const items = addressSuggestState.items;
  if (!items.length || !Number.isFinite(index) || index < 0 || index >= items.length) {
    return { ok: false };
  }
  addressSuggestState.index = index;
  return { ok: true };
}

/** 浮层内鼠标点击：直接在当前标签打开，并收起浮层 */
function pickAddressSuggest(rawIndex) {
  const index = Number(rawIndex);
  const items = addressSuggestState.items;
  if (!items.length || !Number.isFinite(index) || index < 0 || index >= items.length) {
    return { ok: false, error: '建议项不存在' };
  }
  const url = items[index].url;
  closeAddressSuggest();
  if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
  // 通知外壳同步地址栏显示（导航本身由主进程发起，避免渲染层二次导航）
  if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
    runtime.mainWindow.webContents.send('nyx:as:picked', { url });
  }
  return runtime.tabManager.navigate(url);
}

/** 主窗口关闭时把建议浮层一起收掉，避免留下孤立窗口 */
function disposeAddressSuggest() {
  const win = runtime.addressSuggestWindow;
  if (win && !win.isDestroyed()) win.close();
  runtime.addressSuggestWindow = null;
  addressSuggestState.items = [];
  addressSuggestState.index = -1;
}

/**
 * 打开书签管理窗口（独立窗口，树形展示 + 复选框批量删除 + 同级上移 / 下移）。
 * 已打开则聚焦复用；窗口关闭时清空引用。
 */
function openBookmarkManage() {
  const existing = runtime.bookmarkManageWindow;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 400,
    title: 'Nyx 书签管理',
    backgroundColor: THEME_BG[(runtime.uiStore && runtime.uiStore.get().theme) || 'ink'],
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'bm-manage-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  runtime.bookmarkManageWindow = win;
  win.setMenuBarVisibility(false);
  // 管理窗口只加载本地页面：禁止开新窗口、禁止导航到远端
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'bm-manage.html'));
  win.on('closed', () => {
    if (runtime.bookmarkManageWindow === win) runtime.bookmarkManageWindow = null;
  });
  return { ok: true, reused: false };
}

/** 向主窗口推送「书签已变化」，主窗口书签栏收到后立即重渲染 */
function notifyBookmarkBarChanged() {
  const win = runtime.mainWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('nyx:bm:changed', { t: Date.now() });
  }
}

/**
 * 按 URL 在书签树里找节点（工具栏星标 / 建议徽标共用）。
 * 书签是树结构，这里用显式栈做深度遍历，避免深文件夹时递归过深。
 */
function findBookmarkByUrl(url) {
  if (!runtime.bookmarkStore || !url) return null;
  let tree = null;
  try {
    tree = runtime.bookmarkStore.listTree();
  } catch {
    return null;
  }
  const root = tree && tree.root;
  if (!root) return null;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.url === url) return node;
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 「收藏到文件夹」浮层（v1.5.0，长按 / 右键星标触发）                    */
/* ------------------------------------------------------------------ */

const BF_WIDTH = 260;
const BF_HEAD_H = 28;
/** 条目高度必须与 bm-folder.css 里的 .bf-item 高度一致，否则窗口高度会错位 */
const BF_ITEM_H = 30;
/** 分隔线（9px）+ 「新建文件夹并收藏…」一行（30px）+ 面板上下内边距与边框（10px） */
const BF_EXTRA_H = 49;
/** 搜索框一行（v1.6.0）：28px 输入框 + 上下间距 6px，必须与 bm-folder.css 的 .bf-search 一致 */
const BF_SEARCH_H = 34;
/** 新建文件夹命名输入行（v1.7.0）：30px 输入框 + 下间距 4px */
const BF_NEW_ROW_H = 34;

/**
 * 「最近使用」的收藏文件夹（v1.8.0）：最多记 3 个，落盘在 <userData>/bookmark-folder-recent.json。
 * 目的：日常收藏往往反复落到同几个文件夹，置顶显示能省一次翻找。
 */
const BF_RECENT_MAX = 3;

function bookmarkFolderRecentPath() {
  return path.join(app.getPath('userData'), 'bookmark-folder-recent.json');
}

function readBookmarkFolderRecent() {
  try {
    const file = bookmarkFolderRecentPath();
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw)) return [];
    return raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0).slice(0, BF_RECENT_MAX);
  } catch {
    return [];
  }
}

function rememberBookmarkFolder(id) {
  const folderId = Number(id);
  if (!Number.isInteger(folderId) || folderId <= 0) return;
  try {
    const list = readBookmarkFolderRecent().filter((n) => n !== folderId);
    list.unshift(folderId);
    fs.writeFileSync(bookmarkFolderRecentPath(), JSON.stringify(list.slice(0, BF_RECENT_MAX)), 'utf8');
  } catch {
    // 记录失败不影响收藏本身：最近使用只是便利功能
  }
}


runtime.bookmarkFolderWindow = null;
/** 当前待收藏的页面（浮层选中文件夹后回用到） */
const bookmarkFolderState = { url: '', title: '', blurTimer: 0 };

/**
 * 递归收集可选的文件夹（只收文件夹，书签本身不是收藏目标）。
 * 根节点用 id=0 表示「书签栏」（bookmark-store 里 ROOT_ID 即 0，add 时 folderId 省略等价于根）。
 */
function collectBookmarkFolders(node, depth, out) {
  if (!node || !Array.isArray(node.children)) return out;
  for (const child of node.children) {
    if (!child || typeof child !== 'object' || child.url) continue;
    const count = Array.isArray(child.children) ? child.children.length : 0;
    out.push({ id: child.id, title: child.title || '未命名文件夹', depth, count });
    collectBookmarkFolders(child, depth + 1, out);
  }
  return out;
}

/** 弹出收藏到文件夹浮层：{ x, y, url, title }（x / y 为屏幕坐标，贴在星标按钮下方） */
function openBookmarkFolderMenu(payload) {
  const mainWin = runtime.mainWindow;
  if (!mainWin || mainWin.isDestroyed()) return { ok: false, error: '主窗口未就绪' };
  if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };

  const url = String(payload.url || '');
  const title = String(payload.title || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '地址不合法' };

  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '浮层坐标无效' };

  bookmarkFolderState.url = url;
  bookmarkFolderState.title = title;

  let folders = [];
  try {
    const tree = runtime.bookmarkStore.listTree();
    const root = tree && tree.root;
    folders = root ? collectBookmarkFolders(root, 0, []) : [];
  } catch (err) {
    console.warn('[Nyx] 读取书签文件夹失败：', err && err.message);
  }
  const rootCount = (() => {
    try {
      const tree = runtime.bookmarkStore.listTree();
      return tree && tree.root && Array.isArray(tree.root.children) ? tree.root.children.length : 0;
    } catch {
      return 0;
    }
  })();

  const items = [{ id: 0, title: '书签栏', depth: 0, count: rootCount }].concat(folders);

  // 最近使用（v1.8.0）：只挑还在树里的文件夹，避免显示已被删掉的 id
  const byId = new Map(items.map((item) => [item.id, item]));
  const recent = readBookmarkFolderRecent()
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((item) => ({ id: item.id, title: item.title, count: item.count }));

  // 置顶建议（v1.13.0）：工具栏星标也能直达常用页面，不必先打字
  const pinned = readPinnedSuggestions();

  const height =
    BF_HEAD_H +
    BF_SEARCH_H +
    items.length * BF_ITEM_H +
    BF_EXTRA_H +
    BF_NEW_ROW_H +
    (pinned.length ? 22 + pinned.length * BF_ITEM_H : 0);

  const existing = runtime.bookmarkFolderWindow;
  if (existing && !existing.isDestroyed()) {
    existing.webContents.send('nyx:bf:data', { items, recent, pinned, url, title });
    placeAddressSuggest(existing, x, y + 6, BF_WIDTH, height);
    existing.show();
    existing.focus();
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width: BF_WIDTH,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'bm-folder-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  runtime.bookmarkFolderWindow = win;

  // 纯选择窗口：禁止开新窗口、禁止导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'bm-folder.html'));
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('nyx:bf:data', { items, recent, pinned, url, title });
    placeAddressSuggest(win, x, y + 6, BF_WIDTH, height);
    win.show();
    win.focus();
  });

  // 失焦自动收起：延迟一小段，避免「点星标弹窗 → 焦点转移」瞬间被误关
  win.on('blur', () => {
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.webContents.isFocused()) closeBookmarkFolderMenu();
    }, 150);
  });

  win.on('closed', () => {
    if (runtime.bookmarkFolderWindow === win) runtime.bookmarkFolderWindow = null;
  });

  return { ok: true, reused: false };
}

/** 关闭收藏到文件夹浮层（幂等） */
function closeBookmarkFolderMenu() {
  const win = runtime.bookmarkFolderWindow;
  if (win && !win.isDestroyed()) win.close();
  runtime.bookmarkFolderWindow = null;
}

/**
 * 浮层里选中文件夹：{ folderId: number | 'new', title? }。
 * v1.7.0：'new' 可带 title（用户在浮层里直接命名），留空时退回「新文件夹 <日期>」。
 */
function pickBookmarkFolder(payload) {
  if (!runtime.bookmarkStore) return { ok: false, error: '书签存储未就绪' };
  const url = bookmarkFolderState.url;
  const title = bookmarkFolderState.title || url;
  if (!url) return { ok: false, error: '没有待收藏的页面' };

  let folderId = payload.folderId;
  let createdFolder = '';
  // asParent（v1.8.0）：在选中的文件夹**下面**新建子文件夹再收藏（Ctrl+Enter / 右键行触发）
  const asParent = payload.asParent === true;

  if (folderId === 'new' || asParent) {
    // 用户输入的名字优先；清洗掉首尾空白/换行，限长 64 字
    const typed = String(payload.title || '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 64);
    const name = typed || `新文件夹 ${new Date().toLocaleDateString('zh-CN')}`;

    // 注意：这里不能给父级传 0 —— bookmark-store 的 findById 把根节点排除在外，
    // 传 0 会被判成"目标文件夹不存在"。省略 parentId 才是"建在根下"。
    const parentId = asParent ? Number(folderId) : NaN;
    const options = { title: name };
    if (Number.isInteger(parentId) && parentId > 0) options.parentId = parentId;

    const created = runtime.bookmarkStore.addFolder(options);
    if (!created || created.ok === false) return { ok: false, error: (created && created.error) || '新建文件夹失败' };
    folderId = created.id;
    createdFolder = created.title || name;
  }

  const id = Number(folderId);
  const added = runtime.bookmarkStore.add({
    title,
    url,
    folderId: Number.isFinite(id) && id > 0 ? id : undefined,
  });
  closeBookmarkFolderMenu();

  if (!added || added.ok === false) return { ok: false, error: (added && added.error) || '收藏失败' };
  notifyBookmarkBarChanged();
  // 记住这个落点，下次浮层顶部置顶显示（v1.8.0）
  rememberBookmarkFolder(Number.isFinite(id) ? id : 0);
  console.log(`[Nyx] 已收藏到${createdFolder ? `新建文件夹「${createdFolder}」` : '指定文件夹'}｜${url}`);
  return { ok: true, folderId: Number.isFinite(id) ? id : 0, createdFolder };
}

/* ------------------------------------------------------------------ */
/* 网络与代理                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把代理状态推给设置窗口，并顺带把内核端口同步给两个 session。
 *
 * 内核自动重启会重新挑端口，因此不能只在启停时同步——任何状态变化都要
 * 立刻写回 sessions，否则会出现"内核在跑、浏览器却连旧端口"的空档。
 */
function notifyProxyState() {
  syncProxyPort();

  if (!runtime.proxyService) return;
  const win = runtime.proxyWindow;
  if (win && !win.isDestroyed()) {
    win.webContents.send('nyx:proxy-state', runtime.proxyService.status());
  }
}

/**
 * 把"当前生效端口"写回 sessions。
 *
 * 内核运行时用其混合端口；内核未运行则回落外置代理端口（隐私模式届时
 * 仍会因探测失败被拒绝进入，绝不出现直连）。
 */
function syncProxyPort() {
  const service = runtime.proxyService;
  if (!service) return;

  const port = service.port || sessions.FALLBACK_PROXY_PORT;
  if (port !== sessions.getProxyPort()) {
    sessions.setProxyPort(port);
    console.log(`[Nyx] 代理端口已同步为 ${port}`);
    // 端口变了，普通模式的探测目标随之变化，链路需重新判定并同步给界面
    reevaluateNormalLink('port-sync').catch(() => {});
  }
}

/** 打开（或聚焦）设置窗口：独立窗口，不占用标签额度 */
function openSettings() {
  const existing = runtime.proxyWindow;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    notifyProxyState();
    return { ok: true, reused: true };
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Nyx 设置',
    // 同主窗口：窗口出现前的底色跟随主题
    backgroundColor: THEME_BG[(runtime.uiStore && runtime.uiStore.get().theme) || 'ink'],
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  runtime.proxyWindow = win;
  win.setMenuBarVisibility(false);

  // 设置窗口只承载本地页面，不允许窗口内再开新窗口或跳转到远端
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.webContents.once('did-finish-load', () => notifyProxyState());

  win.on('closed', () => {
    runtime.proxyWindow = null;
  });

  return { ok: true, reused: false };
}

/* ------------------------------------------------------------------ */
/* 设置中心 IPC                                                         */
/* ------------------------------------------------------------------ */

/** 默认界面偏好（存储未就绪时的兜底，与 core/ui-store.js 保持一致） */
const UI_PREF_FALLBACK = { showLinkBadge: true, showModeSwitch: true, theme: 'ink' };

function currentUiPrefs() {
  return runtime.uiStore ? runtime.uiStore.get() : Object.assign({}, UI_PREF_FALLBACK);
}

/** 当前生效的新标签页地址：配置为空时回落到环境变量 NYX_HOME_URL */
function resolveNewTabUrl() {
  const raw = runtime.startupStore ? runtime.startupStore.newTabUrlValue(HOME_URL) : HOME_URL;
  return normalizeInput(raw);
}

/** 启动时要打开的地址列表（存储未就绪时回落为单个新标签页） */
function startupTargets() {
  return runtime.startupStore ? runtime.startupStore.startupTargets(HOME_URL) : [HOME_URL];
}

/** 按地址栏规则规范化地址，供设置中心回显「实际会打开什么」 */
function previewTargets(urls) {
  return (Array.isArray(urls) ? urls : []).map((url) => normalizeInput(url));
}

/** 配置改动后把新标签默认地址同步到运行中的标签管理器（启动方式下次启动才生效） */
function applyStartupPrefs() {
  if (!runtime.tabManager) return;
  runtime.tabManager.defaultUrl = resolveNewTabUrl();
}

/** 设置中心 IPC：界面偏好读写、应用与运行时信息 */
function registerSettingsIpc() {
  ipcMain.handle('nyx:ui:prefs', () => ({ ok: true, ui: currentUiPrefs() }));

  ipcMain.handle('nyx:ui:prefs-set', (_event, payload) => {
    if (!runtime.uiStore) return { ok: false, error: '界面偏好存储未就绪' };

    const key = payload && payload.key;
    const value = payload && payload.value;
    if (typeof value !== 'boolean' && typeof value !== 'string') {
      return { ok: false, error: '偏好取值必须是布尔值或字符串' };
    }

    const result = runtime.uiStore.set(key, value);
    if (!result || result.ok === false) {
      return { ok: false, error: (result && result.error) || '该偏好项不允许修改' };
    }

    // 顶栏元素由主窗口渲染层负责，改完立即推一次状态，避免两边显示不一致
    if (runtime.tabManager) pushState(runtime.tabManager.snapshot());

    return { ok: true, ui: result.ui || currentUiPrefs() };
  });

  // 设置中心「启动与主页 / 下载 / 关于与更新」只读信息
  ipcMain.handle('nyx:app:info', () => {
    const prefs = runtime.startupStore ? runtime.startupStore.get() : null;
    return {
      ok: true,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath('userData'),
      installDir: path.dirname(app.getPath('exe')),
      // 新标签页当前实际使用的地址（配置优先，留空时回落环境变量 NYX_HOME_URL）
      homeUrl: resolveNewTabUrl(),
      homeUrlFromEnv: !(prefs && prefs.newTabUrl),
      startupMode: prefs ? prefs.startupMode : 'newTab',
      startupTargets: previewTargets(startupTargets()),
      maxTabs: MAX_TABS,
    };
  });

  /* ---------------- 启动与主页 ---------------- */

  /** 统一回显载荷：用户配置 + 主进程实际生效值（含兜底与规范化结果） */
  const startupView = () => {
    const prefs = runtime.startupStore
      ? runtime.startupStore.get()
      : { newTabUrl: '', startupMode: 'newTab', startupUrls: [] };
    return {
      prefs,
      effective: {
        newTabUrl: resolveNewTabUrl(),
        startupMode: prefs.startupMode,
        startupTargets: previewTargets(startupTargets()),
        // 地址留空且未设环境变量时，界面按空白页显示
        fromEnv: !prefs.newTabUrl,
      },
    };
  };

  ipcMain.handle('nyx:startup:prefs', () => {
    if (!runtime.startupStore) return { ok: false, error: '启动与主页配置存储未就绪' };
    return Object.assign({ ok: true }, startupView());
  });

  ipcMain.handle('nyx:startup:prefs-set', (_event, payload) => {
    if (!runtime.startupStore) return { ok: false, error: '启动与主页配置存储未就绪' };
    const result = runtime.startupStore.set(payload || {});
    if (!result || result.ok === false) {
      return { ok: false, error: (result && result.error) || '配置未写入' };
    }
    // 新标签默认地址即时生效；启动方式与指定启动页下次启动才用得上
    applyStartupPrefs();
    return Object.assign({ ok: true }, startupView());
  });

  ipcMain.handle('nyx:startup:prefs-reset', () => {
    if (!runtime.startupStore) return { ok: false, error: '启动与主页配置存储未就绪' };
    const result = runtime.startupStore.reset();
    if (!result || result.ok === false) {
      return { ok: false, error: (result && result.error) || '配置未写入' };
    }
    applyStartupPrefs();
    return Object.assign({ ok: true }, startupView());
  });
}

/* ------------------------------------------------------------------ */
/* 扩展插件 IPC                                                         */
/* ------------------------------------------------------------------ */

/**
 * 扩展插件相关 IPC（设置中心「扩展插件」分区）。
 *
 * 目录 / 文件选择、删除确认都由主进程弹原生对话框：渲染层拿不到任意路径，
 * 也就无法把扩展装到别处或删掉别的目录。
 */
/**
 * 检查更新源里的扩展更新（v1.11.0 起，v1.13.0 抽出供"全部更新"复用）。
 * @returns {Promise<{ok:boolean, source?:string, items?:Array, updatable?:number, error?:string}>}
 */
async function checkExtensionUpdates() {
  try {
    const source = readUpdateSource();
    if (!source) return { ok: false, error: '更新源未配置', items: [], updatable: 0 };
    const index = await fetchExtensionsIndex(source);
    if (!index || !Array.isArray(index.extensions)) {
      return { ok: false, error: '更新源里没有 extensions.json', items: [], updatable: 0 };
    }
    let live = [];
    try {
      live = runtime.extensions ? runtime.extensions.list() : [];
    } catch {
      live = [];
    }
    const installedVersions = new Map(live.map((item) => [String(item.name || ''), String(item.version || '')]));
    const items = index.extensions.map((entry) => {
      const installedVersion = installedVersions.get(String(entry.name)) || '';
      return {
        key: entry.key,
        name: entry.name,
        version: entry.version,
        file: entry.file,
        size: entry.size,
        installedVersion,
        updatable: !!installedVersion && installedVersion !== String(entry.version),
      };
    });
    return { ok: true, source, items, updatable: items.filter((item) => item.updatable).length };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), items: [], updatable: 0 };
  }
}

/** 从更新源下载并安装一个扩展包（sha256 校验），给单个安装与"全部更新"共用 */
async function installExtensionFromUpdateSource(entry) {
  if (!runtime.extensions) return { ok: false, error: '扩展管理器尚未初始化' };
  const source = readUpdateSource();
  if (!source) return { ok: false, error: '更新源未配置' };

  const tmp = path.join(app.getPath('temp'), `nyx-ext-online-${process.pid}-${Date.now()}.zip`);
  try {
    if (/^https?:\/\//i.test(source)) {
      await runtime.updater.downloadToFile(`${source}/${encodeURIComponent(entry.file)}`, tmp);
    } else {
      fs.copyFileSync(path.join(source, entry.file), tmp);
    }
    if (entry.sha256) {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (hash.toLowerCase() !== String(entry.sha256).toLowerCase()) {
        return { ok: false, error: '扩展包 sha256 校验失败，已丢弃' };
      }
    }
    const result = await runtime.extensions.installCrx(tmp);
    if (result && result.ok) console.log(`[Nyx] 已在线更新扩展｜${entry.name} v${entry.version}`);
    return result;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时包清理失败不影响结果 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 抓包「慢请求」阈值（v1.16.0）                                          */
/* ------------------------------------------------------------------ */

/**
 * 阈值原来只存在抓包面板的 localStorage 里，设置页想统一管理就没门；
 * 改成主进程落一份小配置，两边都读它——面板仍然保留 localStorage 兜底，
 * 老版本写进去的值第一次启动时会被读上来当默认。
 */
const NET_SLOW_DEFAULT = 1000;
const NET_SLOW_MIN = 50;
const NET_SLOW_MAX = 10000;

function toolboxPrefsPath() {
  return path.join(app.getPath('userData'), 'toolbox-prefs.json');
}

function normalizeSlowMs(value) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return null;
  if (num < NET_SLOW_MIN || num > NET_SLOW_MAX) return null;
  return num;
}

function readToolboxPrefs() {
  try {
    const file = toolboxPrefsPath();
    if (!fs.existsSync(file)) return { slowMs: NET_SLOW_DEFAULT };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const slow = normalizeSlowMs(raw && raw.slowMs);
    return { slowMs: slow == null ? NET_SLOW_DEFAULT : slow };
  } catch {
    return { slowMs: NET_SLOW_DEFAULT };
  }
}

function writeToolboxPrefs(patch) {
  const next = Object.assign(readToolboxPrefs(), patch || {});
  try {
    fs.mkdirSync(path.dirname(toolboxPrefsPath()), { recursive: true });
    fs.writeFileSync(toolboxPrefsPath(), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 更新源占用看板（v1.16.0）                                             */
/* ------------------------------------------------------------------ */

/** 递归统计目录体积与文件数；不跟随符号链接，出错按已统计部分返回 */
function measureDir(targetPath) {
  const result = { path: targetPath, bytes: 0, files: 0, dirs: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(targetPath, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = measureDir(full);
        result.bytes += sub.bytes;
        result.files += sub.files;
        result.dirs += sub.dirs + 1;
      } else if (entry.isFile()) {
        result.bytes += fs.statSync(full).size;
        result.files += 1;
      }
    } catch {
      /* 单个条目读不到就跳过，不影响整体数字 */
    }
  }
  return result;
}

function updatesDirPath() {
  return path.join(app.getPath('userData'), 'updates');
}

function archiveDirPath() {
  return path.join(app.getPath('userData'), 'updates-archive');
}

/** 更新源 + 留档的体积快照（设置页「更新源占用」卡片用） */
function updateFootprint() {
  const updates = measureDir(updatesDirPath());
  const archive = measureDir(archiveDirPath());
  let version = '';
  let archiveVersions = [];
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(updatesDirPath(), 'latest.json'), 'utf8').replace(/^\uFEFF/, ''));
    version = String(latest.version || '');
  } catch {
    version = '';
  }
  try {
    archiveVersions = fs
      .readdirSync(archiveDirPath(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    archiveVersions = [];
  }
  return {
    ok: true,
    version,
    archiveVersions,
    updates: { path: updates.path, bytes: updates.bytes, files: updates.files },
    archive: { path: archive.path, bytes: archive.bytes, dirs: archive.dirs, files: archive.files },
    total: updates.bytes + archive.bytes,
  };
}

/** 清理命令写成一行，设置页展示 + 一键复制都用它 */
function updateCleanCommand() {
  return 'node scripts/make-release.js --clean-updates --target both --keep-n 1 --yes';
}

/* ------------------------------------------------------------------ */
/* 扩展版本历史与回滚（v1.16.0）                                          */
/* ------------------------------------------------------------------ */

/**
 * 读更新源 extensions.json 里的 history（发布端若写了版本历史，这里按原样摊平）。
 * 只读展示 + 提供"回滚到此版本"：客户端走同一套「下载 → sha256 → 安装」链路装回旧包。
 */
async function extensionHistory() {
  const source = readUpdateSource();
  if (!source) return { ok: false, error: '更新源未配置', items: [] };
  let index = null;
  try {
    index = await fetchExtensionsIndex(source);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), items: [] };
  }
  if (!index || !Array.isArray(index.extensions)) {
    return { ok: false, error: '更新源里没有 extensions.json', items: [] };
  }
  let live = [];
  try {
    live = runtime.extensions ? runtime.extensions.list() : [];
  } catch {
    live = [];
  }
  const installed = new Map(live.map((item) => [String(item.name || ''), String(item.version || '')]));
  const items = index.extensions.map((entry) => {
    const installedVersion = installed.get(String(entry.name)) || '';
    const rawHistory = Array.isArray(entry.history) ? entry.history : [];
    const history = rawHistory
      .filter((item) => item && item.version && item.file)
      .map((item) => ({
        version: String(item.version),
        file: String(item.file),
        size: Number(item.size) || 0,
        sha256: String(item.sha256 || ''),
        at: String(item.at || ''),
        current: String(item.version) === String(entry.version),
        installed: !!installedVersion && String(item.version) === installedVersion,
      }));
    return {
      key: entry.key,
      name: entry.name,
      version: entry.version,
      installedVersion,
      history,
    };
  });
  return { ok: true, source, items };
}

/** 客户端的扩展回滚：找到历史条目，按同一套"下载 → sha256 → installCrx"路径装回去 */
async function rollbackExtension(key, version) {
  if (!runtime.extensions) return { ok: false, error: '扩展管理器尚未初始化' };
  const wanted = String(version || '').trim();
  if (!wanted) return { ok: false, error: '缺少目标版本' };
  const result = await extensionHistory();
  if (!result.ok) return { ok: false, error: result.error };
  const entry = (result.items || []).find((item) => item.key === String(key || '') || item.name === String(key || ''));
  if (!entry) return { ok: false, error: '更新源里没有该扩展' };
  const target = entry.history.find((item) => item.version === wanted);
  if (!target) return { ok: false, error: `更新源里没有 ${wanted} 这个历史版本` };
  if (target.current) return { ok: false, error: '这一版就是更新源里的当前版本，直接用「检查更新」即可' };
  const outcome = await installExtensionFromUpdateSource({
    name: entry.name,
    version: target.version,
    file: target.file,
    sha256: target.sha256,
  });
  if (!outcome || !outcome.ok) return { ok: false, error: (outcome && outcome.error) || '安装失败' };
  return {
    ok: true,
    restored: { name: entry.name, version: target.version },
    fromVersion: entry.installedVersion,
  };
}

/** 当前更新源（本地目录或 http(s) 地址），来源与 OTA 相同 */
function readUpdateSource() {
  try {
    const cfg = runtime.updater ? runtime.updater.readConfig() : null;
    return String((cfg && cfg.source) || '').trim().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 读取更新源里的 extensions.json（本地直读 / 远端走 Updater 的取文本通道） */
async function fetchExtensionsIndex(source) {
  if (/^https?:\/\//i.test(source)) {
    const text = await runtime.updater.httpGetText(`${source}/extensions.json`);
    return JSON.parse(text);
  }
  const file = path.join(source, 'extensions.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function registerExtensionsIpc() {
  const notReady = { ok: false, error: '扩展管理器尚未初始化' };

  /** 统一回显载荷：清单一律带全量视图，界面不必二次拉取 */
  const view = (extra) =>
    Object.assign(
      {
        ok: true,
        items: runtime.extensions ? runtime.extensions.list() : [],
        storePath: runtime.extensions ? runtime.extensions.storePath : '',
        // 扩展恒装在普通模式分区；隐私模式分区不加载任何扩展
        scope: 'normal',
      },
      extra || {},
    );

  /** 对话框父窗口：设置窗口在则挂在它上面，否则挂主窗口 */
  const parentWindow = () => {
    const win = runtime.proxyWindow;
    if (win && !win.isDestroyed()) return win;
    return runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : undefined;
  };

  ipcMain.handle('nyx:ext:list', () => {
    if (!runtime.extensions) return notReady;
    return view();
  });


  /* ---------------- 更新源里的扩展在线更新（v1.11.0） ---------------- */

  /**
  /**
   * 检查更新源里的 extensions.json（更新源提供了扩展清单时才有可检查的项）。
   * 本地源直接读文件，http(s) 源走 Updater 的取文本通道。
   */
  ipcMain.handle('nyx:ext:online-check', () => checkExtensionUpdates());

  /** 从更新源下载并安装扩展包：{ key, file }，装前校验 sha256 */
  ipcMain.handle('nyx:ext:online-install', async (_event, payload) => {
    if (!runtime.extensions) return notReady;
    const key = String((payload && payload.key) || '');
    try {
      const check = await checkExtensionUpdates();
      if (!check.ok) return { ok: false, error: check.error };
      const entry = (check.items || []).find((item) => item.key === key || item.file === (payload && payload.file));
      if (!entry) return { ok: false, error: '更新源里没有该扩展' };
      return await installExtensionFromUpdateSource(entry);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  /**
   * 一键全部更新（v1.13.0）：把所有可更新的扩展依次装上。
   * 单个失败不影响其它（返回逐个结果），全部走 sha256 校验与"同名即更新"路径。
   */
  ipcMain.handle('nyx:ext:online-update-all', async () => {
    if (!runtime.extensions) return notReady;
    try {
      const check = await checkExtensionUpdates();
      if (!check.ok) return { ok: false, error: check.error };
      const targets = (check.items || []).filter((item) => item.updatable);
      if (!targets.length) return { ok: true, total: 0, updated: [], failed: [] };

      const updated = [];
      const failed = [];
      for (const entry of targets) {
        try {
          const result = await installExtensionFromUpdateSource(entry);
          if (result && result.ok) updated.push({ name: entry.name, version: entry.version });
          else failed.push({ name: entry.name, error: (result && result.error) || '未知原因' });
        } catch (err) {
          failed.push({ name: entry.name, error: err && err.message ? err.message : String(err) });
        }
      }
      return { ok: true, total: targets.length, updated, failed };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  /**
   * 扩展版本历史（v1.16.0）：把更新源 extensions.json 的 history 摊平成界面能直接渲染的形状。
   * 只读，不触发下载。
   */
  ipcMain.handle('nyx:ext:online-history', () => extensionHistory());

  /**
   * 客户端回滚（v1.16.0）：{ key, version }。
   * 走与在线更新同一条"下载 → sha256 → installCrx"路径，装的是更新源里的历史包。
   */
  ipcMain.handle('nyx:ext:online-rollback', async (_event, payload) => {
    if (!runtime.extensions) return notReady;
    try {
      return await rollbackExtension(payload && payload.key, payload && payload.version);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  /** 从已解压的扩展目录导入 */
  ipcMain.handle('nyx:ext:add-dir', async () => {
    if (!runtime.extensions) return notReady;

    const picked = await dialog.showOpenDialog(parentWindow(), {
      title: '选择已解压的扩展目录（目录内需含 manifest.json）',
      buttonLabel: '导入扩展',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    const result = await runtime.extensions.install(picked.filePaths[0]);
    return view(result);
  });

  /** 从 .crx / .zip 安装包导入 */
  ipcMain.handle('nyx:ext:add-crx', async () => {
    if (!runtime.extensions) return notReady;

    const picked = await dialog.showOpenDialog(parentWindow(), {
      title: '选择扩展安装包（.crx / .zip）',
      buttonLabel: '导入扩展',
      filters: [{ name: 'Chrome / Edge 扩展包', extensions: ['crx', 'zip'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    const result = await runtime.extensions.installCrx(picked.filePaths[0]);
    return view(result);
  });

  /** 启用 / 停用（改动需刷新页面才在已打开的标签上生效） */
  ipcMain.handle('nyx:ext:toggle', async (_event, payload) => {
    if (!runtime.extensions) return notReady;
    const id = payload && payload.id ? String(payload.id) : '';
    if (!id) return { ok: false, error: '缺少扩展标识' };

    const result = await runtime.extensions.setEnabled(id, !!(payload && payload.enabled));
    return view(result);
  });

  /** 卸载：删仓库文件属不可逆操作，先弹原生确认 */
  ipcMain.handle('nyx:ext:remove', async (_event, payload) => {
    if (!runtime.extensions) return notReady;
    const id = payload && payload.id ? String(payload.id) : '';
    if (!id) return { ok: false, error: '缺少扩展标识' };

    const item = runtime.extensions.find(id);
    if (!item) return { ok: false, error: '扩展不存在' };

    const confirmed = await showMessageBox({
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除扩展',
      message: `确定删除扩展「${item.name}」吗？`,
      detail: '将从扩展仓库删除该扩展的全部文件，删除后需要重新导入才能恢复。',
    });
    if (confirmed.response !== 1) return { ok: false, canceled: true };

    const result = await runtime.extensions.remove(id);
    return view(result);
  });

  /** 全部重新装载（扩展文件在外部被改动后使用） */
  ipcMain.handle('nyx:ext:reload', async () => {
    if (!runtime.extensions) return notReady;
    const result = await runtime.extensions.reloadAll();
    return view(result);
  });

  /** 刷新全部标签：内容脚本注入只对新加载的页面生效，装完扩展需要刷新一次 */
  ipcMain.handle('nyx:ext:reload-tabs', () => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    const snapshot = runtime.tabManager.snapshot();
    let reloaded = 0;
    for (const tab of snapshot.tabs) {
      const result = runtime.tabManager.reload(tab.id);
      if (result && result.ok) reloaded += 1;
    }
    return { ok: true, reloaded };
  });

  /** 打开扩展仓库目录 */
  ipcMain.handle('nyx:ext:open-store', async () => {
    if (!runtime.extensions) return notReady;
    try {
      fs.mkdirSync(runtime.extensions.storePath, { recursive: true });
    } catch {
      /* 目录已存在时忽略 */
    }
    const failure = await shell.openPath(runtime.extensions.storePath);
    return failure ? { ok: false, error: failure } : { ok: true };
  });
}

/** 网络与代理相关的 IPC 通道（与 preload.js 暴露的方法一一对应） */
function registerProxyIpc() {
  const missing = { ok: false, error: '代理服务尚未初始化' };

  ipcMain.handle('nyx:proxy:open', () => openSettings());

  ipcMain.handle('nyx:proxy:status', () => (runtime.proxyService ? runtime.proxyService.status() : null));

  ipcMain.handle('nyx:proxy:start', async () => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.start();
  });

  ipcMain.handle('nyx:proxy:stop', async () => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.stop();
  });

  ipcMain.handle('nyx:proxy:restart', async () => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.refresh();
  });

  ipcMain.handle('nyx:proxy:subscription-add', (_event, payload) => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.addSubscription(payload || {});
  });

  ipcMain.handle('nyx:proxy:subscription-remove', async (_event, id) => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.removeSubscription(id);
  });

  ipcMain.handle('nyx:proxy:subscription-switch', async (_event, id) => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.switchSubscription(id);
  });

  ipcMain.handle('nyx:proxy:subscription-refresh', async () => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.refresh();
  });

  ipcMain.handle('nyx:proxy:nodes', () => {
    if (!runtime.proxyService) return { ...missing, groups: [], nodes: [] };
    return runtime.proxyService.nodes();
  });

  ipcMain.handle('nyx:proxy:test', (_event, names) => {
    if (!runtime.proxyService) return { ...missing, results: {} };
    return runtime.proxyService.testNodes(names);
  });

  ipcMain.handle('nyx:proxy:select', (_event, payload) => {
    if (!runtime.proxyService) return missing;
    const { group, node } = payload || {};
    return runtime.proxyService.select(group, node);
  });

  ipcMain.handle('nyx:proxy:egress', () => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.checkEgress();
  });

  // 网络与代理偏好项（白名单，避免渲染层写进任意键值污染订阅状态文件）
  const ALLOWED_PREFS = new Set(['autoTest', 'autoEgress', 'autoStart', 'smartPatrol']);

  // 本机可用网卡清单（适配器名 / IPv4 / 默认出口标记），供「上网网卡」下拉框使用
  ipcMain.handle('nyx:proxy:interfaces', () => {
    if (!runtime.proxyService) return { ...missing, items: [] };
    return runtime.proxyService.listInterfaces();
  });

  // 设置出站网卡：{ mode: 'auto' | 'manual', name }；内核在跑时由服务侧自行重建
  ipcMain.handle('nyx:proxy:interface-set', (_event, payload) => {
    if (!runtime.proxyService) return missing;
    return runtime.proxyService.setOutboundInterface(payload || {});
  });

  ipcMain.handle('nyx:proxy:preference-set', (_event, payload) => {
    if (!runtime.proxyService) return missing;
    const { key, value } = payload || {};
    if (!ALLOWED_PREFS.has(key)) {
      return { ok: false, error: `不支持的偏好项：${key}` };
    }
    const prefs = runtime.proxyService.setPreference(key, value === true);
    // 智能调度开关变化：立即同步巡检器并复核链路（开 → 切 smart 分流；关 → 回全代理）
    if (key === 'smartPatrol') {
      syncSmartPatrol();
      reevaluateNormalLink('smart-patrol-toggle').catch(() => {});
    }
    return { ok: true, preferences: prefs };
  });

  // 智能遨游调度：状态 / 清空规则表
  ipcMain.handle('nyx:smart:status', () =>
    runtime.smartPatrol ? runtime.smartPatrol.status() : { running: false, siteCount: 0 },
  );
  ipcMain.handle('nyx:smart:clear', () =>
    runtime.smartPatrol ? runtime.smartPatrol.clearRules() : { ok: false, error: '智能调度未初始化' },
  );
}

/* ------------------------------------------------------------------ */
/* 工具箱 IPC                                                          */
/* ------------------------------------------------------------------ */

/**
 * 工具箱相关通道。
 *
 * 约定：凡是操作当前页面的通道，入参都可以不带 wcId——不带就落当前激活标签；
 * 带 wcId 用于面板上翻看别的标签（抓包记录按标签存在各自采集器里）。
 * 主进程只做参数收敛与转发，判定逻辑全在内核里，避免同一套规则写两遍。
 */
function registerToolboxIpc() {
  const notReady = { ok: false, error: '工具箱尚未初始化' };

  const activeWc = () => (runtime.tabManager ? runtime.tabManager.getActiveWebContents() : null);
  const activeWcId = () => {
    const wc = activeWc();
    return wc && !wc.isDestroyed() ? wc.id : null;
  };
  /** 入参 wcId 缺省时落当前激活标签 */
  const wcIdOf = (payload) => {
    const raw = payload && payload.wcId;
    const num = raw == null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(num) ? num : activeWcId();
  };

  ipcMain.handle('nyx:tb:state', () => {
    const act = activeWc();
    return {
      ok: true,
      open: runtime.toolboxOpen,
      width: runtime.toolboxWidth,
      wcId: activeWcId(),
      url: act && !act.isDestroyed() ? act.getURL() : '',
      title: act && !act.isDestroyed() ? act.getTitle() : '',
      sticky: runtime.pageTools ? runtime.pageTools.sticky : null,
      // v1.16.0：慢请求阈值统一由主进程持有，抓包面板与设置页读同一份
      slowMs: readToolboxPrefs().slowMs,
    };
  });

  /* ---- 慢请求阈值（v1.16.0）：设置页写入、抓包面板读取 ---- */

  ipcMain.handle('nyx:tb:slow-ms', () => {
    const prefs = readToolboxPrefs();
    return { ok: true, slowMs: prefs.slowMs, min: NET_SLOW_MIN, max: NET_SLOW_MAX, fallback: NET_SLOW_DEFAULT };
  });

  ipcMain.handle('nyx:tb:slow-ms-set', (_event, payload) => {
    const slow = normalizeSlowMs(payload && payload.slowMs);
    if (slow == null) {
      return { ok: false, error: `阈值需要是 ${NET_SLOW_MIN}–${NET_SLOW_MAX} 之间的毫秒数` };
    }
    const prefs = writeToolboxPrefs({ slowMs: slow });
    if (!prefs) return { ok: false, error: '写入失败' };
    // 面板开着的时候立刻按新阈值重画，不用等用户手动刷新
    try {
      if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
        runtime.mainWindow.webContents.send('nyx:tb:slow-ms', { slowMs: prefs.slowMs });
      }
    } catch {
      /* 推送失败不影响写入结果 */
    }
    return { ok: true, slowMs: prefs.slowMs };
  });

  ipcMain.handle('nyx:tb:set-open', (_event, payload) =>
    setToolboxOpen(payload && payload.open, payload && payload.width));

  ipcMain.handle('nyx:tb:presets', () => ({
    ok: true,
    ua: UA_PRESETS,
    device: DEVICE_PRESETS,
    throttle: THROTTLE_PRESETS,
  }));

  /** 开发者工具关闭后通道空着，界面据此重新接管（工具与抓包互斥，需显式重连） */
  ipcMain.handle('nyx:tb:sync', () => {
    if (!runtime.toolbox) return notReady;
    runtime.toolbox.syncAll();
    return { ok: true };
  });

  ipcMain.handle('nyx:tb:list', (_event, payload) => {
    if (!runtime.toolbox) return notReady;
    const result = runtime.toolbox.list(wcIdOf(payload));
    return Object.assign(result, {
      wcId: runtime.toolbox.collectorOf(wcIdOf(payload)) ? wcIdOf(payload) : null,
      status: runtime.toolbox.status(wcIdOf(payload)),
    });
  });

  ipcMain.handle('nyx:tb:detail', (_event, payload) => {
    if (!runtime.toolbox) return notReady;
    const id = payload && payload.id ? String(payload.id) : '';
    if (!id) return { ok: false, error: '缺少请求标识' };
    return runtime.toolbox.detail(wcIdOf(payload), id);
  });

  ipcMain.handle('nyx:tb:clear', (_event, payload) =>
    runtime.toolbox ? runtime.toolbox.clear(wcIdOf(payload)) : notReady);

  ipcMain.handle('nyx:tb:pause', (_event, payload) =>
    runtime.toolbox ? runtime.toolbox.setPaused(wcIdOf(payload), !!(payload && payload.paused)) : notReady);

  ipcMain.handle('nyx:tb:status', (_event, payload) =>
    runtime.toolbox ? runtime.toolbox.status(wcIdOf(payload)) : notReady);

  /* 开发者模式 */

  ipcMain.handle('nyx:tb:devtools', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const action = payload && payload.action ? String(payload.action) : 'open';
    if (action === 'close') return runtime.pageTools.closeDevTools(wcIdOf(payload));
    if (action === 'state') return runtime.pageTools.devToolsState(wcIdOf(payload));
    return runtime.pageTools.openDevTools(wcIdOf(payload), payload && payload.mode);
  });

  /* 元素拾取与取数 */

  ipcMain.handle('nyx:tb:pick', async (_event, payload) =>
    runtime.pageTools ? runtime.pageTools.pickElement(wcIdOf(payload)) : notReady);

  ipcMain.handle('nyx:tb:pick-cancel', (_event, payload) =>
    runtime.pageTools ? runtime.pageTools.cancelPick(wcIdOf(payload)) : notReady);

  ipcMain.handle('nyx:tb:highlight', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.highlight(wcIdOf(payload), payload && payload.selector);
  });

  ipcMain.handle('nyx:tb:eval', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.evalSelector(wcIdOf(payload), payload && payload.selector, payload && payload.expression);
  });

  /* 调试：修改页面 HTML（read/apply/revert）与控制台执行任意 JS */
  ipcMain.handle('nyx:tb:page-html', async (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const action = payload && payload.action ? String(payload.action) : 'read';
    const wcId = wcIdOf(payload);
    if (action === 'apply') return runtime.pageTools.applyHtml(wcId, payload && payload.html);
    if (action === 'revert') return runtime.pageTools.revertHtml(wcId);
    return runtime.pageTools.readHtml(wcId);
  });

  ipcMain.handle('nyx:tb:console-eval', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.evalScript(wcIdOf(payload), payload && payload.expression);
  });

  /* Cookie 管理：操作当前标签页的 session.cookies */
  const cookieWc = (payload) => {
    if (!runtime.pageTools) return null;
    const wc = runtime.pageTools.wc(wcIdOf(payload));
    return wc && !wc.isDestroyed() ? wc : null;
  };

  ipcMain.handle('nyx:tb:cookie-list', async (_event, payload) => {
    const wc = cookieWc(payload);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    try {
      const host = payload && payload.host ? String(payload.host).replace(/^\./, '') : null;
      const cookies = await wc.session.cookies.get(host ? { url: 'https://' + host } : {});
      const list = cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        value: c.value,
        path: c.path,
        expirationDate: c.expirationDate || null,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        session: !!c.session,
      }));
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('nyx:tb:cookie-set', async (_event, payload) => {
    const wc = cookieWc(payload);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const p = payload || {};
    const name = String(p.name || '');
    const domain = String(p.domain || '').replace(/^\./, '');
    if (!name) return { ok: false, error: '缺少 Cookie 名称' };
    if (!domain) return { ok: false, error: '缺少 Cookie 域名' };
    const base = 'https://' + domain + (p.path || '/');
    const detail = {
      url: base,
      name,
      value: String(p.value || ''),
      path: p.path || '/',
      secure: !!p.secure,
      httpOnly: !!p.httpOnly,
    };
    if (p.expirationDate && Number(p.expirationDate) > 0) {
      detail.expirationDate = Math.floor(Number(p.expirationDate));
    }
    if (p.sameSite && p.sameSite !== 'unspecified') detail.sameSite = p.sameSite;
    try {
      await wc.session.cookies.set(detail);
      return { ok: true };
    } catch (err) {
      try {
        detail.url = 'http://' + domain + (p.path || '/');
        await wc.session.cookies.set(detail);
        return { ok: true, fallbackHttp: true };
      } catch (e2) {
        return { ok: false, error: err.message + '（http 回退也失败：' + e2.message + '）' };
      }
    }
  });

  ipcMain.handle('nyx:tb:cookie-remove', async (_event, payload) => {
    const wc = cookieWc(payload);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const p = payload || {};
    const domain = String(p.domain || '').replace(/^\./, '');
    if (!domain || !p.name) return { ok: false, error: '缺少 domain/name' };
    const url = 'https://' + domain + (p.path || '/');
    try {
      await wc.session.cookies.remove(url, String(p.name));
      return { ok: true };
    } catch (err) {
      try {
        await wc.session.cookies.remove('http://' + domain + (p.path || '/'), String(p.name));
        return { ok: true, fallbackHttp: true };
      } catch (e2) {
        return { ok: false, error: e2.message };
      }
    }
  });

  ipcMain.handle('nyx:tb:cookie-clear', async (_event, payload) => {
    const wc = cookieWc(payload);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const domain = String((payload && payload.host) || '').replace(/^\./, '');
    if (!domain) return { ok: false, error: '缺少站点 host' };
    try {
      const cookies = await wc.session.cookies.get({ url: 'https://' + domain });
      let removed = 0;
      for (const c of cookies) {
        try {
          await wc.session.cookies.remove('https://' + domain + (c.path || '/'), c.name);
          removed++;
        } catch (e) { /* 单条失败跳过 */ }
      }
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* Cookie：从 Edge 无缝导入（site=当前站点 / all=全量上限 500） */
  ipcMain.handle('nyx:tb:cookie-edge-import', async (_event, payload) => {
    const wc = cookieWc(payload);
    if (!wc) return { ok: false, error: '当前没有可用标签' };
    const mode = payload && payload.mode === 'site' ? 'site' : 'all';
    let host = null;
    if (mode === 'site') {
      try {
        host = new URL(wc.getURL()).hostname;
      } catch (e) {
        host = null;
      }
    }
    const imp = await edgeCookieImport.importEdgeCookies({ mode, host });
    if (!imp.ok) return imp;
    const cap = mode === 'all' ? Math.min(imp.imported, 500) : imp.imported;
    let written = 0;
    let failed = 0;
    for (const c of imp.list.slice(0, cap)) {
      const detail = {
        url: 'https://' + c.host + (c.path || '/'),
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
      };
      if (c.domain) detail.domain = c.domain;
      if (c.expires) detail.expirationDate = c.expires;
      if (c.sameSite && c.sameSite !== 'unspecified') detail.sameSite = c.sameSite;
      try {
        await wc.session.cookies.set(detail);
        written++;
      } catch (e) {
        try {
          detail.url = 'http://' + c.host + (c.path || '/');
          await wc.session.cookies.set(detail);
          written++;
        } catch (e2) {
          failed++;
        }
      }
    }
    return { ok: true, mode, host, total: imp.total, imported: imp.imported, written, failed };
  });


  /* 页面环境 */

  ipcMain.handle('nyx:tb:ua', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.setUserAgent(
      wcIdOf(payload),
      payload && payload.preset,
      payload && payload.custom,
      !!(payload && payload.keepPage),
    );
  });

  ipcMain.handle('nyx:tb:device', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.setDevice(wcIdOf(payload), payload && payload.preset, !!(payload && payload.keepPage));
  });

  ipcMain.handle('nyx:tb:throttle', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.applyThrottle(wcIdOf(payload), payload && payload.preset);
  });

  ipcMain.handle('nyx:tb:js', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.setJavaScriptEnabled(wcIdOf(payload), !(payload && payload.enabled === false));
  });

  /* 取证与转移 */

  ipcMain.handle('nyx:tb:clear-site', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const kinds = payload && Array.isArray(payload.kinds) ? payload.kinds.slice(0, 4) : ['cookie', 'storage'];
    return runtime.pageTools.clearSiteData(wcIdOf(payload), kinds);
  });

  ipcMain.handle('nyx:tb:screenshot', async (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const shot = await runtime.pageTools.capture(wcIdOf(payload), !!(payload && payload.fullPage));
    if (!shot.ok) return shot;
    return saveScreenshot(shot.base64, shot.fullPage);
  });

  ipcMain.handle('nyx:tb:copy', (_event, payload) => {
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text) return { ok: false, error: '没有可复制的内容' };
    clipboard.writeText(text.slice(0, 512 * 1024));
    return { ok: true, length: text.length };
  });

  /** 打开一条嗅探到的地址：默认新标签，也可交给系统默认浏览器 */
  ipcMain.handle('nyx:tb:open', (_event, payload) => {
    const target = payload && payload.url ? String(payload.url).trim() : '';
    if (!/^https?:\/\//i.test(target)) return { ok: false, error: '只支持 http/https 地址' };

    if (payload && payload.external) {
      shell.openExternal(target).catch((err) => console.warn('[Nyx] 外部打开失败：', err.message));
      return { ok: true, external: true };
    }
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    return runtime.tabManager.create(target);
  });

  /** 打开工具箱并切换到指定页签（书签栏「管理」按钮等入口用） */
  ipcMain.handle('nyx:tb:open-pane', (_event, payload) => {
    if (!runtime.tabManager) return { ok: false, error: '窗口尚未就绪' };
    const pane = payload && payload.pane ? String(payload.pane) : 'bookmarks';
    setToolboxOpen(true, runtime.toolboxWidth);
    const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
    if (win) win.webContents.send('nyx:tb:switch-pane', { pane });
    return { ok: true, pane };
  });

  ipcMain.handle('nyx:tb:download', (_event, payload) =>
    downloadResource(payload && payload.url));

  /* 视频增强：倍速解锁 / 进度解锁 / 鼠标保活 */

  ipcMain.handle('nyx:tb:video-scan', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.scanVideos(wcIdOf(payload));
  });

  ipcMain.handle('nyx:tb:video-rate', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const cfg = payload || {};
    return runtime.pageTools.setVideoRate(wcIdOf(cfg), cfg.rate, cfg.lock);
  });

  ipcMain.handle('nyx:tb:video-seek', (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.seekVideo(wcIdOf(payload), payload || {});
  });

  ipcMain.handle('nyx:tb:video-mouse', async (_event, payload) => {
    if (!runtime.pageTools) return notReady;
    const cfg = payload || {};
    const wcId = wcIdOf(cfg);
    if (cfg.action === 'stop') {
      const stopped = runtime.pageTools.stopMouseIdle(wcId == null ? null : wcId);
      return Object.assign({ ok: true }, stopped, { mouse: runtime.pageTools.mouseStatus(wcId) });
    }
    if (cfg.action === 'status') return runtime.pageTools.mouseStatus(wcId);
    return runtime.pageTools.startMouseIdle(wcId, cfg);
  });

  ipcMain.handle('nyx:tb:video-release', () => {
    if (!runtime.pageTools) return notReady;
    return runtime.pageTools.releaseAllVideo();
  });
}

/** 升级相关的 IPC 通道（与 preload.js 暴露的方法一一对应） */
function registerUpdateIpc() {
  const missing = { ok: false, error: '升级服务尚未初始化' };

  ipcMain.handle('nyx:update:status', () => (runtime.updater ? runtime.updater.getState() : null));

  ipcMain.handle('nyx:update:check', async () => {
    if (!runtime.updater) return missing;
    return checkForUpdatesInteractive({ userInitiated: true });
  });

  /**
   * 统一检查更新（v1.12.0）：应用更新 + 扩展更新一次查完。
   * 应用侧复用现有的交互式检查（会弹提示），扩展侧只做汇总，具体安装仍走扩展卡片。
   */
  ipcMain.handle('nyx:update:check-all', async () => {
    const appResult = runtime.updater ? await runtime.updater.check() : { ok: false, error: '升级服务未就绪' };

    let extensionUpdates = { ok: false, error: '更新源未配置', items: [], updatable: 0 };
    try {
      const source = readUpdateSource();
      if (source) {
        const index = await fetchExtensionsIndex(source);
        if (index && Array.isArray(index.extensions)) {
          const live = runtime.extensions ? runtime.extensions.list() : [];
          const installedVersions = new Map(live.map((item) => [String(item.name || ''), String(item.version || '')]));
          const items = index.extensions.map((entry) => {
            const installedVersion = installedVersions.get(String(entry.name)) || '';
            return {
              key: entry.key,
              name: entry.name,
              version: entry.version,
              installedVersion,
              updatable: !!installedVersion && installedVersion !== String(entry.version),
            };
          });
          extensionUpdates = { ok: true, items, updatable: items.filter((item) => item.updatable).length };
        } else {
          extensionUpdates = { ok: true, items: [], updatable: 0, note: '更新源里没有 extensions.json' };
        }
      }
    } catch (err) {
      extensionUpdates = { ok: false, error: err && err.message ? err.message : String(err), items: [], updatable: 0 };
    }

    return { ok: true, app: appResult, extensions: extensionUpdates };
  });

  ipcMain.handle('nyx:update:fetch', async () => {
    if (!runtime.updater) return missing;
    return runtime.updater.download();
  });

  ipcMain.handle('nyx:update:install', () => {
    if (!runtime.updater) return missing;
    if (!runtime.updater.readyFile) return { ok: false, error: '升级包尚未就绪' };
    const started = runtime.updater.install();
    if (started.ok) setTimeout(() => app.quit(), 300);
    return started;
  });

  ipcMain.handle('nyx:update:open-folder', () => openUpdateFolder());

  /* ---- 更新源占用看板（v1.16.0）---- */

  /** 更新源 + 留档的体积快照，设置页「关于与更新」里展示 */
  ipcMain.handle('nyx:update:footprint', () => updateFootprint());

  /** 打开更新源目录（不存在时先建出来，避免 explorer 报错） */
  ipcMain.handle('nyx:update:open-source', async () => {
    const dir = updatesDirPath();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就让 shell 去报错 */
    }
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true, path: dir };
  });

  /** 把清理命令放进剪贴板：命令是文档里验证过的那一条，避免用户手抄出错 */
  ipcMain.handle('nyx:update:copy-clean-command', () => {
    const command = updateCleanCommand();
    try {
      clipboard.writeText(command);
    } catch (err) {
      return { ok: false, error: `写入剪贴板失败：${err.message}`, command };
    }
    return { ok: true, command };
  });

  ipcMain.handle('nyx:update:about', () => showAboutDialog());

  ipcMain.handle('nyx:update:set-source', (_event, payload) => {
    if (!runtime.updater) return missing;
    const source = String((payload && payload.source) || '').trim();
    if (!source) return { ok: false, error: '更新源不能为空' };
    const isRemote = /^https?:\/\//i.test(source);
    const isLocal = /^[a-zA-Z]:[\\/]/.test(source) || source.startsWith('\\\\') || /^file:\/\//i.test(source);
    if (!isRemote && !isLocal) {
      return { ok: false, error: '更新源必须是 http(s) 地址或本地目录路径' };
    }
    const autoCheck = payload && payload.autoCheck;
    const config = runtime.updater.writeConfig({
      source,
      ...(typeof autoCheck === 'boolean' ? { autoCheck } : {}),
    });
    return { ok: true, config };
  });
}

/* ------------------------------------------------------------------ */
/* 应用菜单（全中文）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 应用菜单策略：彻底移除。
 * 产品要求主窗口不显示文件 / 编辑 / 视图 / 帮助等应用菜单。传 null 后
 * Electron 不再生成应用菜单（主窗口与设置窗口都不会有菜单栏）；托盘菜单
 * 走 Tray.setContextMenu，与应用菜单相互独立，不受影响。
 */
function installChineseMenu() {
  Menu.setApplicationMenu(null);
}

/* ------------------------------------------------------------------ */
/* 自动升级（OTA）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 桌面快捷方式兜底。
 *
 * 非 oneClick 安装器在静默安装（自动升级走的就是静默）时不会初始化「创建桌面
 * 快捷方式」那一页的变量，装完桌面是空的。这里每次启动自查一次：快捷方式存在
 * 且指向当前这份程序就跳过，缺失或指向旧位置就补建，保证升级后图标不丢、且
 * 永远指向真正在运行的那一份 Nyx。
 */
function ensureDesktopShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  const exePath = app.getPath('exe');
  const linkPath = path.join(app.getPath('desktop'), 'Nyx 隐私浏览器.lnk');

  try {
    if (fs.existsSync(linkPath) && shell.readShortcutLink(linkPath).target === exePath) return;
  } catch {
    /* 快捷方式损坏或读不出来，下面直接重建 */
  }

  try {
    const created = shell.writeShortcutLink(linkPath, 'create', {
      target: exePath,
      cwd: path.dirname(exePath),
      icon: exePath,
      iconIndex: 0,
      description: 'Nyx 隐私浏览器',
    });
    if (!created) console.warn('[Nyx] 桌面快捷方式补建未生效（权限或安全软件拦截）');
  } catch (err) {
    console.warn(`[Nyx] 桌面快捷方式补建失败：${err.message}`);
  }
}

/** 统一样式的系统对话框：有主窗口时挂成子窗口，避免弹窗跑到窗口后面 */
function showMessageBox(options) {
  const win = runtime.mainWindow;
  if (win && !win.isDestroyed()) return dialog.showMessageBox(win, options);
  return dialog.showMessageBox(options);
}

/** 初始化升级服务，并按配置在启动后静默检查一次 */
function initUpdater() {
  runtime.updater = new Updater({
    userDataDir: app.getPath('userData'),
    currentVersion: app.getVersion(),
    execPath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    log: (message) => console.log(`[Nyx] 升级｜${message}`),
    onState: (state) => broadcastUpdateState(state),
  });

  const config = runtime.updater.readConfig();
  console.log(
    `[Nyx] 升级服务就绪｜当前版本：${app.getVersion()}｜更新源：${config.source}｜` +
      `自动检查：${config.autoCheck ? '开' : '关'}`,
  );

  if (!config.autoCheck) return;

  // 启动 8 秒后静默检查：只有真的存在新版本才会弹窗，无更新不打扰用户
  const timer = setTimeout(() => {
    void checkForUpdatesInteractive({ userInitiated: false });
  }, 8000);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/** 把升级状态同步到托盘提示、任务栏进度条与所有渲染窗口 */
function broadcastUpdateState(state) {
  try {
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
      runtime.mainWindow.setProgressBar(
        state.phase === 'downloading' ? Math.max(0.01, state.progress / 100) : -1,
      );
    }
  } catch {
    /* 进度条失败不影响升级主流程 */
  }

  try {
    if (runtime.tray && !runtime.tray.isDestroyed()) {
      runtime.tray.setToolTip(
        state.phase === 'downloading'
          ? `Nyx 隐私浏览器｜正在获取升级包 ${state.progress}%`
          : 'Nyx 隐私浏览器',
      );
    }
  } catch {
    /* 托盘提示失败不影响升级主流程 */
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('nyx:update-state', state);
  }
}

/**
 * 检查更新并给出中文反馈。
 * userInitiated=true 表示用户主动点击，此时"已是最新"和"检查失败"都要明确告知；
 * 自动检查则保持安静，只有发现新版本才弹窗。
 */
async function checkForUpdatesInteractive({ userInitiated = false } = {}) {
  if (!runtime.updater) return { ok: false, error: '升级服务尚未初始化' };

  const result = await runtime.updater.check();

  if (!result.ok) {
    if (userInitiated) {
      await showMessageBox({
        type: 'error',
        title: '检查更新',
        message: '检查更新失败',
        detail: `${result.error}\n\n更新源：${runtime.updater.readConfig().source}\n可在升级包文件夹里放置 latest.json 与新版安装包，或修改更新源配置后重试。`,
        buttons: ['好'],
        noLink: true,
      });
    }
    return result;
  }

  if (!result.hasUpdate) {
    if (userInitiated) {
      await showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本（${result.currentVersion}）`,
        buttons: ['好'],
        noLink: true,
      });
    }
    return result;
  }

  await promptUpdateAvailable(runtime.updater.getState());
  return result;
}

/** 发现新版本：先问是否升级，再决定是否拉取升级包 */
async function promptUpdateAvailable(state) {
  if (runtime.updateDialogOpen) return;
  runtime.updateDialogOpen = true;

  try {
    const lines = [
      `当前版本：${state.currentVersion}`,
      `最新版本：${state.latestVersion}`,
    ];
    if (state.notes) lines.push('', '更新说明：', state.notes);
    lines.push('', '升级会覆盖安装到当前目录，订阅、偏好与密码库都不会丢失。');

    const { response } = await showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `Nyx 有新版本可用：${state.latestVersion}`,
      detail: lines.join('\n'),
      buttons: ['立即升级', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response !== 0) return;

    const fetched = await runtime.updater.download();
    if (!fetched.ok) {
      await showMessageBox({
        type: 'error',
        title: '获取升级包失败',
        message: '升级包没有取回来，本次升级已取消',
        detail: fetched.error,
        buttons: ['好'],
        noLink: true,
      });
      return;
    }

    const confirmed = await showMessageBox({
      type: 'question',
      title: '升级包已就绪',
      message: `升级包已就绪（${state.latestVersion}）`,
      detail: '点击「立即重启安装」后，浏览器会自动退出并完成覆盖安装，装完自动重新打开。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (confirmed.response !== 0) return;

    const started = runtime.updater.install();
    if (!started.ok) {
      await showMessageBox({
        type: 'error',
        title: '无法启动安装',
        message: '安装程序没有启动',
        detail: started.error,
        buttons: ['好'],
        noLink: true,
      });
      return;
    }

    console.log('[Nyx] 升级｜已拉起静默安装，应用即将退出');
    app.quit();
  } finally {
    runtime.updateDialogOpen = false;
  }
}

/** 打开升级包文件夹（本地更新源直接定位；远端源则打开下载缓存目录） */
async function openUpdateFolder() {
  const source = runtime.updater ? runtime.updater.readConfig().source : '';
  const isRemote = /^https?:\/\//i.test(String(source));
  const target = isRemote || !source
    ? (runtime.updater ? runtime.updater.cacheDir() : app.getPath('userData'))
    : String(source).replace(/^file:\/\//i, '').replace(/^\//, '');

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    /* 目录已存在或无权限，交给 openPath 报错 */
  }

  const error = await shell.openPath(target);
  if (error) {
    await showMessageBox({
      type: 'error',
      title: '打开失败',
      message: '打不开升级包文件夹',
      detail: `${target}\n${error}`,
      buttons: ['好'],
      noLink: true,
    });
  }
}

/** 关于对话框：版本、安装位置、用户数据位置 */
async function showAboutDialog() {
  await showMessageBox({
    type: 'info',
    title: '关于 Nyx',
    message: `Nyx 隐私浏览器 ${app.getVersion()}`,
    detail: [
      '双模式隐私浏览器：普通模式 / 全隐私模式，内置本机代理内核。',
      '支持在线升级：换版本、加功能都不需要重新走安装流程。',
      '',
      `安装目录：${path.dirname(app.getPath('exe'))}`,
      `用户数据：${app.getPath('userData')}`,
      `更新源：${runtime.updater ? runtime.updater.readConfig().source : '未初始化'}`,
    ].join('\n'),
    buttons: ['好'],
    noLink: true,
  });
}

/* ------------------------------------------------------------------ */
/* 托盘常驻                                                            */
/* ------------------------------------------------------------------ */

function createTray() {
  const icon = fs.existsSync(TRAY_ICON)
    ? nativeImage.createFromPath(TRAY_ICON)
    : nativeImage.createEmpty();

  runtime.tray = new Tray(icon);
  runtime.tray.setToolTip('Nyx 隐私浏览器');

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: toggleMainWindow },
    { type: 'separator' },
    {
      label: '切换到 普通模式',
      click: () => {
        void switchModeTracked('normal');
      },
    },
    {
      label: '切换到 全隐私模式',
      click: async () => {
        const result = await switchModeTracked('private');
        // 被拒绝进入隐私模式时把窗口唤到前台，确保用户看得到提示
        if (result && result.ok === false) showMainWindow();
      },
    },
    { type: 'separator' },
    { label: '设置…', click: () => openSettings() },
    {
      label: '检查更新…',
      click: () => {
        void checkForUpdatesInteractive({ userInitiated: true });
      },
    },
    { label: '打开升级包文件夹', click: () => openUpdateFolder() },
    { label: `关于 Nyx（当前版本 ${app.getVersion()}）`, click: () => showAboutDialog() },
    { label: `恐慌清场（${PANIC_SHORTCUT}）`, click: () => panic() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  runtime.tray.setContextMenu(menu);
  runtime.tray.on('double-click', toggleMainWindow);
}

/* ------------------------------------------------------------------ */
/* 恐慌快捷键：一键关闭窗口并清场                                        */
/* ------------------------------------------------------------------ */

function registerPanicShortcut() {
  const ok = globalShortcut.register(PANIC_SHORTCUT, () => panic());
  if (!ok) {
    console.warn(`[Nyx] 恐慌快捷键注册失败（${PANIC_SHORTCUT}），可能已被其他程序占用`);
  }
}

/**
 * 恐慌清场：
 *   关闭全部标签 → 清空所有分区存储与缓存 → 销毁窗口与托盘 → 退出进程。
 */
async function panic() {
  if (runtime.panicking) return;
  runtime.panicking = true;
  console.warn('[Nyx] 触发恐慌清场');

  try {
    if (runtime.tabManager) runtime.tabManager.closeAll();
  } catch {
    /* 忽略 */
  }

  try {
    await sessions.purgeAll();
  } catch (err) {
    console.error('[Nyx] 恐慌清场时清理数据失败：', err.message);
  }

  try {
    globalShortcut.unregisterAll();
  } catch {
    /* 忽略 */
  }

  try {
    if (runtime.apiServer) runtime.apiServer.close();
  } catch {
    /* 忽略 */
  }

  // 内核是独立子进程，必须显式结束；否则"清场"之后本机仍留着代理在监听
  try {
    if (runtime.proxyService) await runtime.proxyService.stop();
  } catch (err) {
    console.error('[Nyx] 恐慌清场时结束内核失败：', err.message);
  }

  try {
    if (runtime.tray) {
      runtime.tray.destroy();
      runtime.tray = null;
    }
  } catch {
    /* 忽略 */
  }

  try {
    if (runtime.proxyWindow && !runtime.proxyWindow.isDestroyed()) {
      runtime.proxyWindow.destroy();
    }
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
      runtime.mainWindow.destroy();
    }
  } catch {
    /* 忽略 */
  }

  app.exit(0);
}

/* ------------------------------------------------------------------ */
/* 本地 AI 接口                                                        */
/* ------------------------------------------------------------------ */

function userDataFile(name) {
  return path.join(app.getPath('userData'), name);
}

/** 读取或生成访问 Token（首次启动时随机生成并落盘） */
function ensureApiToken() {
  const file = userDataFile('api-token.txt');

  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
  } catch {
    /* 忽略，走重新生成 */
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (err) {
    console.warn('[Nyx] Token 落盘失败：', err.message);
  }
  return token;
}

async function startLocalApi() {
  runtime.apiToken = ensureApiToken();

  const runner = createActionRunner({
    getTabManager: () => runtime.tabManager,
    getMode: () => sessions.getMode(),
    // 标签管理器未就绪时的状态兜底里也要有出站链路，否则 /state 会出现"时有时无"的字段
    getNetwork: () => networkSnapshot(),
    getRiskLog,
  });

  // 模式控制能力：交给本地接口驱动模式切换与事件查询（供自动化测试使用）
  // 注意：switch 直接复用 switchModeTracked（内部即 switchMode 全流程），不含任何旁路实现
  const modeControl = {
    switch: (mode) => switchModeTracked(mode),
    events: () => modeEventLog.events(),
  };

  // 隐私观测能力（只读）：验收脚本据此断言加固是否真的下发，不依赖界面肉眼观察
  const privacyControl = {
    status: () => buildPrivacyStatus(),
    permissions: (limit) => buildPermissionView(limit),
  };

  runtime.apiServer = await startHttpApi({
    token: runtime.apiToken,
    runner,
    mode: modeControl,
    privacy: privacyControl,
    host: '127.0.0.1',
    preferredPort: Number(process.env.NYX_API_PORT || 17321),
    onPort: (port) => {
      runtime.apiPort = port;
      try {
        fs.writeFileSync(userDataFile('api-port.txt'), String(port));
      } catch (err) {
        console.warn('[Nyx] 端口落盘失败：', err.message);
      }
    },
  });

  console.log(
    `[Nyx] 本地 AI 接口：http://127.0.0.1:${runtime.apiPort}（Token 存于 ${userDataFile('api-token.txt')}）`,
  );
}

/* ------------------------------------------------------------------ */
/* 生命周期兜底                                                        */
/* ------------------------------------------------------------------ */

// 托盘常驻：关闭窗口不退出应用
app.on('window-all-closed', () => {
  /* 保持常驻，等待托盘操作或恐慌清场 */
});

app.on('activate', () => {
  showMainWindow();
});

// 退出前清空隐私分区（普通分区保留，这是它的设计特性），并结束内置代理内核：
// 内核是独立子进程，不会随应用退出自动消失，留着等于"浏览器关了、代理还在跑"。
app.on('before-quit', (event) => {
  if (runtime.quitting) return;
  runtime.quitting = true;
  event.preventDefault();

  // 退出前停掉链路复核定时器，避免退出过程中还在探测 / 推送状态
  if (runtime.linkTimer) {
    clearInterval(runtime.linkTimer);
    runtime.linkTimer = null;
  }

  sessions
    .purgePrivateSession()
    .catch(() => {})
    .then(() => (runtime.proxyService ? runtime.proxyService.stop() : null))
    .catch(() => {})
    .finally(() => {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* 忽略 */
      }
      app.exit(0);
    });
});
