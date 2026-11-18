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
// 设置页要从"窗口"改成"标签"，标签加载本地页面必须给 file:// URL（loadFile 只有 BrowserWindow 有）
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
// 录屏/远控检测（C4）要读一次进程列表：execFile 起 PowerShell，拿不到就如实报"无法确认"
const { execFile, spawnSync } = require('node:child_process');
// Edge Cookie 导入模块：复制 Cookies 库 + ABE/DPAPI 解密 + node:sqlite 读取
const edgeCookieImport = require('./core/edge-cookie-import');
const {
  STALE_DAYS,
  describeDeltaFreshness,
  normalizeBlockSize,
  normalizeDeltaReport,
  planDeltaMeasure,
  summarizeDeltaMeasure,
} = require('./core/delta-stats');
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
const nodeOs = require('node:os');
// 隐私自检的判定引擎（纯逻辑）：主进程只负责把观测值和真实值喂给它
const privacyCheck = require('./core/privacy-check');
// 设备权限的默认档位：自检里的 D3 要看"普通模式默认放行了什么"
const { baselineFor } = require('./core/permissions');
const { PrivacyHardening } = require('./core/privacy-hardening');
const {
  buildCdpSteps,
  buildHardeningScript,
  buildWorkerHardeningScript,
  describeSurfaceFailure,
  shouldAttachSurface,
} = require('./core/privacy-surface');
// IPC 发送方校验（安全审计 P1-5）：只认 Nyx 自己 renderer/ 下的本地页面
const { decideIpcSender } = require('./core/ipc-guard');
// 站点设备授权白名单：纯逻辑模块，文件读写留在主进程
const {
  normalizeOrigin: normalizePermissionOrigin,
  parseWhitelist: parsePermissionWhitelist,
  serializeWhitelist: serializePermissionWhitelist,
} = require('./core/permission-store');
const { Vault } = require('./core/vault');
const { ProxyService } = require('./core/proxy-service');
// 接入外壳文案唯一真源（VPN 接入外壳清单）：三档身份的字都从这份表取，主进程只做存取
const netTerms = require('./core/net-terms');
const { TabManager, normalizeInput } = require('./core/tabs');
const { createActionRunner, setNavigateBudgetProvider } = require('./core/actions');
// 统一动作通道（清单 C）：所有 agent 动作唯一入口，权限/确认/留痕/急停都从这里过
const { createDispatcher } = require('./core/agent-dispatch');
const { AgentAudit, toCsv } = require('./core/agent-audit');
const { describeShortcutResult, shortcutCandidates } = require('./core/agent-shortcut');
// 站点三层授权（清单 E）：屏蔽优先、白名单免进站确认、未命中问一次、全局关着一律不动
const {
  addRule: addSiteRule,
  addSessionTrust,
  agentSitesPayload,
  evaluateSite,
  exportPolicy: exportSitePolicy,
  importPolicy: importSitePolicy,
  removeRule: removeSiteRule,
  sanitizePolicy: sanitizeSitePolicy,
} = require('./core/agent-sites');
const {
  MAX_UNDO_STEPS,
  SETTING_DISCLAIMER,
  SETTING_KEYS,
  SETTING_LOCKED,
  SETTING_SCHEMA,
  aggregateAgentActions,
  aggregateSettingChanges: aggregateAgentSettingChanges,
  buildActionAuditCsv: buildAgentActionAuditCsv,
  buildSettingAuditCsv: buildAgentSettingAuditCsv,
  describeSettingsSchema,
  planPresetChange: planAgentPresetChange,
  planSettingChange: planAgentSettingChange,
  planSettingUndo: planAgentSettingUndo,
} = require('./core/agent-settings');
const {
  AGENT_DEBUG_PORT_FILE,
  DEFAULT_AGENT_MODE,
  agentModePayload,
  describeAgentMode,
  normalizeAgentMode,
  planAgentModeSwitch,
  readAgentModeFromPrefs,
} = require('./core/agent-mode');
const { ACTIVE_MS: AGENT_LAMP_ACTIVE_MS, decideLamp, describeLamp } = require('./core/agent-lamp');
const { agentDocFilename, buildAgentDoc } = require('./core/agent-doc');
const {
  buildDigestCsv,
  buildDigestMarkdown,
  buildDigestText,
  buildExtractScript,
  digestCsvFileName,
  digestDisabledPayload,
  digestFileName,
  summarize: summarizePage,
  summarizeNetwork,
} = require('./core/page-digest');
// 清单 A3：进程详情的纯逻辑（命令行参数拼装 + 进程表）
const { buildProcessRows } = require('./core/process-args');
const {
  DEFAULT_CHOICES: DEFAULT_ONBOARD_CHOICES,
  DENSITY_CHOICES,
  ONBOARD_MARKER_FILE,
  ONBOARD_STEPS,
  START_CHOICES,
  THEME_CHOICES,
  normalizeOnboardMarker,
  planOnboardChoices,
  planOnboarding,
  summarizeOnboardChoices,
} = require('./core/onboarding');
const { screenshotFilename } = require('./core/toolbar');
const {
  buildHistoryGuardScript,
  decideShellEscape,
  decideShellNavigation,
  decideShellWindowOpen,
  describeAttachBlock,
} = require('./core/shell-guard');
const { decideUpdateSource } = require('./core/update-policy');
const {
  CACHE_SITE_MODES,
  addCustomTemplate,
  applySiteTemplate,
  decideCacheSite,
  describeSiteTemplates,
  exportCacheSites,
  exportCustomTemplates,
  importCacheSites,
  importCustomTemplates,
  normalizeCustomTemplates,
  normalizeSiteList,
  normalizeSitePolicy,
  normalizeSiteText,
  removeCustomTemplate,
} = require('./core/page-cache');
const {
  PRIVATE_CACHE_LIMIT,
  describePrivateEntry,
  dropBrokenEntries,
  findPrivateEntry,
  inspectPrivateStore,
  normalizePrivateStore,
  pickPrivateStoreMode,
  preparePrivateRecord,
  privateCacheStatus,
  putPrivateEntry,
} = require('./core/private-cache');
const { getRiskLog } = require('./core/risk-guard');
// 标签生命周期（清单 G）：休眠阈值与 agent 保持唤醒时长
const {
  AGENT_KEEP_AWAKE_MS,
  DEFAULT_SLEEP_MINUTES,
  TAB_SLEEP_MINUTES,
  describeSleepMinutes,
  normalizeSleepMinutes,
  readSleepAfterFromEnv,
  sleepMinutesToMs,
} = require('./core/tab-lifecycle');
const { startHttpApi } = require('./api/http-api');
const { createModeEventLog } = require('./core/mode-events');
const { ACTIONS: LINK_GUARD_ACTIONS, isProxyFailureCode, decideProxyFailureAction } = require('./core/link-guard');
const { networkStatePayload } = require('./core/network-state');
const {
  CACHE_IMAGE_BYTES_MAX,
  CACHE_IMAGE_TOTAL_MAX,
  CACHE_LIMIT,
  CACHE_VERSION,
  attachImageData,
  buildCaptureScript: buildPageCaptureScript,
  describeCachedPage,
  getSnapshot,
  imageTargets,
  normalizeSnapshot: normalizePageCacheSnapshot,
  putSnapshot,
  readCache: readPageCache,
} = require('./core/page-cache');
const { Updater } = require('./core/updater');
const { UiStore } = require('./core/ui-store');
const { StartupStore } = require('./core/startup-store');
const { ExtensionManager } = require('./core/extensions');
const { Toolbox } = require('./core/toolbox');
const { PageTools, UA_PRESETS, DEVICE_PRESETS, THROTTLE_PRESETS } = require('./core/toolbox-devtools');
const { SmartPatrol } = require('./core/smart-patrol');
const { getHardwareStatus } = require('./core/hardware');
const { HistoryStore } = require('./core/history-store');
const { SiteIcons, sniffImageMime } = require('./core/site-icons');
const { BookmarkStore } = require('./core/bookmark-store');
const { Diagnostics } = require('./core/diagnostics');
const { DownloadManager, DOWNLOAD_STATES, formatBytes, sanitizeFilename, uniquePath } = require('./core/downloads');
const {
  DEFAULT_GPU_POLICY: BOOT_DEFAULT_GPU_POLICY,
  GPU_POLICIES,
  describeGpuPolicy,
  gpuSwitches,
  normalizeGpuPolicy,
  readGpuPolicyFromPrefs,
  summarizeGpuInfo,
} = require('./core/gpu-policy');

// 安全基线（C2）：声明版本 vs 运行时版本，设置页可见 + 回归可卡
const { ADVISORY_SOURCES, securityBaselinePayload } = require('./core/security-baseline');

// 安装包签名状态（第五轮 ②）：把 Get-AuthenticodeSignature 的四个字段翻成中文结论
const {
  describeSignature: describePackageSignature,
  describeSignatureFacts: describePackageSignatureFacts,
  parseSignaturePayload: parsePackageSignaturePayload,
} = require('./core/signing-status');

// 夜间安装器 e2e 的最近一次结果（第八轮 ③）：结果文件 → 中文结论
const { describeNightlyStatus } = require('./core/nightly-status');
const {
  EGRESS_UNKNOWN_TTL_MS,
  PROXY_PROBE_TTL_MS,
  describeTiming,
  readTimed,
  writeTimed,
} = require('./core/switch-cache');
const NIGHTLY_STATUS_FILE = 'nightly-e2e.json';

// 夜间计划任务（第九轮 ②，界面入口）：参数怎么拼、输出怎么读只留一份纯逻辑在 core 里，
// 命令行（scripts/nightly-e2e.js）与主进程都用它，不许各拼一套。
const {
  DEFAULT_TASK_NAME: NIGHTLY_TASK_NAME,
  buildDeleteArgs: buildNightlyDeleteArgs,
  buildQueryArgs: buildNightlyQueryArgs,
  buildRegisterArgs: buildNightlyRegisterArgs,
  decodeConsole: decodeNightlyConsole,
  describeTask: describeNightlyTask,
  describeTaskAction: describeNightlyTaskAction,
  isValidTime: isValidNightlyTime,
  normalizeTime: normalizeNightlyTime,
  parseQueryOutput: parseNightlyQueryOutput,
  resolveTaskPaths: resolveNightlyTaskPaths,
} = require('./core/nightly-task');

// 外壳防护现值表（C3）：每个窗口角色的期望开关值 + CSP 审计 + preload 暴露面分类
const {
  WINDOW_ROLES: SECURITY_WINDOW_ROLES,
  auditCsp,
  auditPreferences,
  buildProbeScript,
  buildSwitchesPayload,
  describeProbeResult,
  parseCsp,
} = require('./core/security-switches');

// 录屏 / 被远控检测（C4）：进程名单判读 + 进隐私模式前的闸门
const { canEnterPrivate, describeScreenWatch, screenWatchPayload } = require('./core/screen-watch');

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
/* 诊断日志（清单 C1）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 全局诊断实例。
 *
 * 必须在这里（userData 路径确定之后、任何可能失败的代码之前）创建并挂钩子：
 * 否则启动早期的异常只写进 stdout，打包后的用户永远看不到 —— 那正是清单里
 * 「下载全废却零提示」「隐私模式静默变直连」无法定论的根因。
 */
const diagnostics = new Diagnostics({
  stateDir: app.getPath('userData'),
  appVersion: app.getVersion(),
});
diagnostics.installProcessHooks(app);

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
/**
 * 恐慌清场的备用键：首选被占用时依次尝试。
 * 与 agent 急停的备用键错开，免得两个安全键互抢。
 */
const PANIC_FALLBACKS = ['CommandOrControl+Alt+Shift+Q', 'CommandOrControl+Shift+F11'];
/**
 * agent 紧急停止快捷键（清单 D）。
 *
 * 必须是**全局**热键：agent 动作在后台标签里跑时，主窗口可能根本不在前台，
 * 用户需要一个「不看界面也能刹车」的入口。与恐慌清场（关窗口清存储）分开：
 * 急停只停 agent，不动用户的页面与数据。
 */
const AGENT_STOP_SHORTCUT = process.env.NYX_AGENT_STOP_SHORTCUT || 'CommandOrControl+Alt+X';
/**
 * 新标签初始地址（清单 B1）。
 *
 * 默认指向本地起始页而不是 about:blank：空白页是"首屏大黑屏"，
 * 用户既看不出这是什么浏览器，也没有落手的地方。起始页是本地文件、
 * 不联网、不请求第三方，隐私模式下同样可用。
 */
const START_PAGE_PATH = path.join(__dirname, 'renderer', 'start.html');
const HOME_URL = process.env.NYX_HOME_URL || pathToFileURL(START_PAGE_PATH).href;
/** 启动方式选「空白页」时打开的那张安静空页（不用 about:blank，见 startupTargets 的注释） */
const BLANK_PAGE_URL = pathToFileURL(path.join(__dirname, 'renderer', 'blank.html')).href;
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
 * 视为"链路可能失效"的加载错误码（Chromium net error）及其处置判定，统一收在
 * `core/link-guard.js`：主进程只引用那一份，避免"两处各有一张表"漂移。
 */
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
 * 隐私自检的总闸。
 * 观测脚本要等音频渲染与 WebRTC 候选，正常情况下 1 秒内就回来了；
 * 但只要有一项卡住，设置页的 init() 就会被静默拖住——所以必须有硬上限。
 */
const PRIVACY_CHECK_TIMEOUT_MS = Math.max(1_000, Number(process.env.NYX_PRIVACY_CHECK_WAIT || 3_000));
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

/**
 * 显卡偏好（清单 A5）。
 *
 * 「默认吃独显」的直接原因是上面三个开关全开、又没有下发任何"优先用低功耗适配器"的请求，
 * 双显卡机器上 Chromium 就会抓住独显。策略必须在这里读——userData 路径已经确定，
 * 但 app 还没 ready，所以只能直接同步读 ui-preferences.json（UiStore 那条路要等 ready）。
 * 读失败/文件损坏一律按默认（核显优先）处理，不阻断启动。
 */
function readBootGpuPolicy() {
  try {
    const prefsPath = path.join(app.getPath('userData'), 'ui-preferences.json');
    if (!fs.existsSync(prefsPath)) return BOOT_DEFAULT_GPU_POLICY;
    return readGpuPolicyFromPrefs(JSON.parse(fs.readFileSync(prefsPath, 'utf8')));
  } catch (err) {
    console.warn('[Nyx] 显卡偏好读取失败，按默认策略启动：', err && err.message ? err.message : err);
    return BOOT_DEFAULT_GPU_POLICY;
  }
}

/** 本次启动实际生效的显卡策略（设置里改完要重启才换，所以单独留一份"启动值"） */
const BOOT_GPU_POLICY = readBootGpuPolicy();
for (const name of gpuSwitches(BOOT_GPU_POLICY)) {
  app.commandLine.appendSwitch(name);
}
console.log(`[Nyx] 显卡策略：${describeGpuPolicy(BOOT_GPU_POLICY).label}（开关 ${gpuSwitches(BOOT_GPU_POLICY).join(',') || '无'}）`);

/**
 * 后台标签休眠阈值（清单 G）。
 *
 * 默认 30 分钟；`NYX_TAB_SLEEP_MS` 只是自动化验证用的旋钮（要等到 30 分钟才能验，
 * 显然不现实），正常启动不会有这个变量。0 表示关闭休眠。
 */
function readTabSleepAfterMs() {
  const value = readSleepAfterFromEnv(process.env);
  if (value === 0) {
    console.log('[Nyx] 标签休眠：已关闭（后台标签一直留在内存里）');
  } else if (value !== 30 * 60 * 1000) {
    console.log(`[Nyx] 标签休眠阈值被环境变量改成 ${value} 毫秒（仅用于验证）`);
  }
  return value;
}

/**
 * agent 接入模式（清单 A）。
 *
 * 为什么要在 ready 之前读：CDP 端口（外部接入）只能在启动时打开，Chromium 没有运行时开关，
 * 所以模式和端口都必须在注册 command line switch 之前确定。UiStore 要等 ready，用不了，
 * 这里直接同步读 <userData>/agent-mode.json；读失败/损坏一律按内置模式启动（更安全的那一侧）。
 */
const AGENT_MODE_FILE = 'agent-mode.json';
const DEFAULT_AGENT_DEBUG_PORT = 9333;

function readBootAgentMode() {
  const fallback = { mode: DEFAULT_AGENT_MODE, debugPort: DEFAULT_AGENT_DEBUG_PORT };
  try {
    const file = path.join(app.getPath('userData'), AGENT_MODE_FILE);
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mode = readAgentModeFromPrefs(raw);
    const port = Number(raw && raw.debugPort);
    return {
      mode,
      debugPort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_AGENT_DEBUG_PORT,
    };
  } catch (err) {
    console.warn('[Nyx] agent 接入模式读取失败，按内置模式启动：', err && err.message ? err.message : err);
    return fallback;
  }
}

const BOOT_AGENT_MODE_CONFIG = readBootAgentMode();
const BOOT_AGENT_MODE = BOOT_AGENT_MODE_CONFIG.mode;
if (BOOT_AGENT_MODE === 'external') {
  // 只有用户显式选择外部接入时才打开 CDP；内置模式下这个端口根本不存在。
  app.commandLine.appendSwitch('remote-debugging-port', String(BOOT_AGENT_MODE_CONFIG.debugPort));
  console.warn(
    `[Nyx] agent 接入模式：外部接入（CDP 端口 ${BOOT_AGENT_MODE_CONFIG.debugPort}）——审计不完整，界面会常驻提示`,
  );
} else {
  console.log('[Nyx] agent 接入模式：内置（动作统一走 agent-dispatch，审计完整）');
}

// 启用 WebNN（Chromium 131+ 可用，需 secure context；file:// 由 unsafely 开关补齐）
app.commandLine.appendSwitch('enable-features', 'WebMachineLearningNeuralNetwork');
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'file://');

/* ------------------------------------------------------------------ */
/* 运行期状态                                                          */
/* ------------------------------------------------------------------ */

const runtime = {
  mainWindow: null,
  onboardWindow: null,
  tabManager: null,
  tray: null,
  apiServer: null,
  apiPort: null,
  apiToken: null,
  /** 离线可用：最近读到的页面正文快照（普通模式明文） */
  pageCache: null,
  pageCacheFile: '',
  /** 隐私模式的加密快照（单独文件，整条加密，用户第 2 项） */
  privateCache: null,
  privateCacheFile: '',
  /** 内置代理编排（订阅管理 + mihomo 内核生命周期） */
  proxyService: null,
  /** 设置页（v1.17.0 起是主窗口里的一个标签，不再是独立窗口） */
  proxyWindow: null,
  /** 界面偏好（顶栏元素显隐等，落盘于 <userData>/ui-preferences.json） */
  uiStore: null,
  startupStore: null,
  /** 全隐私模式的会话级加固装配（UA / 请求头 / 时区语言对齐 / WebRTC 策略） */
  hardening: null,
  /** 密码与表单记忆库（safeStorage 加密后落盘，只在填充瞬间解密） */
  vault: null,
  /** 诊断日志（清单 C1）：错误环形缓冲 + 诊断包导出 */
  diagnostics: null,
  /** 下载记账与下载中心（清单 A1）：进度 / 落点 / 失败原因都在这里 */
  downloads: null,
  /**
   * 统一动作通道（清单 C）：本地接口与 MCP 的唯一入口。
   * 留痕（D）、急停（D）、三层授权（E）、双模（A）都挂在这个对象上。
   */
  agentDispatcher: null,
  /** agent 审计（清单 D）：动作留痕的唯一出口，通道的 audit 回调往这里写 */
  agentAudit: null,
  /** agent 是否已被紧急停止（停止后拒绝一切新动作，直到手动恢复） */
  agentStopped: false,
  /** 站点三层授权（清单 E）：白名单 / 屏蔽名单 / 全局开关，落盘 agent-sites.json */
  agentSites: null,
  /** 本次会话信任过的域名（只在内存里，重启即失效） */
  agentSessionTrust: [],
  /** 停止原因与时间，给界面与诊断用 */
  agentStopReason: '',
  agentStopAt: 0,
  /** agent 接入模式（清单 A）：builtin 进程内 / external 外部 CDP；启动时读落盘值 */
  agentMode: BOOT_AGENT_MODE,
  /** 启动时实际生效的模式（改完没重启时与 agentMode 不一致，界面要如实说） */
  bootAgentMode: BOOT_AGENT_MODE,
  /** 外部接入的 CDP 端口（内置模式下仅作展示，不监听） */
  agentDebugPort: BOOT_AGENT_MODE_CONFIG.debugPort,
  /** agent 改设置的限流窗口（只存时间戳，一分钟内最多 10 次） */
  agentSettingHistory: [],
  /** agent 改设置的成功记录（key / 新值 / 旧值 / 时间），用于「撤销上一次」 */
  agentSettingUndo: [],
  // 安装包签名状态缓存（第五轮 ②）：读一次 exe 的 Authenticode 签名要起 PowerShell，
  // 十分钟内直接复用上一次结果，避免用户反复点「重新检查」把进程列表刷满
  signingStatus: null,
  /** agent 会话空闲计时器（清单 G）：没有新动作时用来恢复"标签可以休眠" */
  agentSessionTimer: null,
  /** 下载中心窗口（独立 BrowserWindow） */
  downloadsWindow: null,
  /**
   * 显卡适配器信息（清单 A5）：启动后由 app.getGPUInfo('basic') 填一次，
   * 只用于诊断页展示与"到底用的哪张卡"的如实汇报，取不到时保持 null。
   */
  gpuInfo: null,
  /**
   * 窗口安全开关登记表（清单 C3）：role → 实际传给 webPreferences 的原始对象。
   *
   * 现值表要回答的是「这台机器上现在到底开没开」，所以登记的是**创建窗口时真正
   * 传进去的那份对象**，不是另写一份"理想配置"文档。
   */
  securityWindows: new Map(),
  /**
   * 最近一次录屏/远控检测结果（清单 C4）：{ at, payload }，5 秒内复用，避免频繁起 PowerShell。
   */
  screenWatch: null,
  /**
   * 用户对「无法确认是否在录屏」的显式确认时间戳（毫秒）。0 表示没确认过。
   * 有 10 分钟时效：确认过不等于永久放行。
   */
  screenAckAt: 0,
  panicking: false,
  quitting: false,
  /** 渲染层尚未就绪时暂存的提示，待页面加载完成后推送 */
  pendingNotice: null,
  /**
   * 外壳页面是否已经加载完成。
   *
   * 窗口已创建但 did-finish-load 还没触发时，webContents.send('nyx:notice') 会
   * 直接消失在空气里（页面还没有监听器）——启动阶段的「代理不可达已回落普通模式」
   * 就是这么丢的。所以提示一律先入队，就绪后按顺序补发。
   */
  shellReady: false,
  /** 就绪前累积的多条提示（FIFO） */
  pendingNotices: [],
  /** 自动升级服务（检查 / 获取升级包 / 静默覆盖安装） */
  updater: null,
  /** 升级弹窗是否正在展示，避免重复弹窗 */
  updateDialogOpen: false,
  /**
   * 代理可达性状态（最近一次探测结果）。
   * 链路本身以 sessions.getLink() 为准，这里只放"探测结论"，避免两份链路状态打架。
   */
  network: { proxyReachable: null, checkedAt: 0, note: '' },
  /**
   * 切换模式的短时缓存（见 src/core/switch-cache.js）：
   *   proxy        —— 30 秒内复用"代理可达吗"的结论；
   *   egressUnknown —— 60 秒内复用"出口自查取不到"这个结论（失败那一次最贵，要等满 6 秒）。
   */
  switchCache: { proxy: null, egressUnknown: null },
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
  /** 摘要面板是否展开（清单 A2）：展开时标签视图同样要让出右侧宽度 */
  digestOpen: false,
  /** agent 状态面板是否展开（清单 A5）：和摘要面板共用让位机制 */
  agentPanelOpen: false,
  /** 最近一次动作执行的截止时间（清单 A5）：三色灯只在"正在被驱动"时亮 */
  agentDrivingUntil: 0,
};

/**
 * 模式变更事件缓冲（纯内存，不落盘）。
 * 记录全部模式切换请求（含被拒绝的）与启动时的模式恢复决策，
 * 供本地接口 GET /mode/events 查询，用于自动化测试断言"运行中模式切换"路径。
 */
const modeEventLog = createModeEventLog(MODE_EVENT_LIMIT);

/* ------------------------------------------------------------------ */
/* 完整性自检（--verify-integrity）                                     */
/* ------------------------------------------------------------------ */
/*
 * 安装器在安装完成后会执行 `Nyx.exe --verify-integrity` 复核安装介质，
 * 这里必须在单实例锁、窗口、渲染进程与代理内核启动之前处理：
 *   1) 只读文件并计算 SHA-256，不创建任何窗口、不加载任何页面；
 *   2) 校验对象是 <resources>/integrity.json（打包期由 build/after-pack.js 生成）；
 *   3) `--report=<路径>` 时把明细写成 UTF-8 文本，同时 stdout 打印摘要；
 *   4) 全部一致 app.exit(0)，有缺失 / 哈希不符 / 非法清单路径则 app.exit(1)；
 *   5) 开发态（未打包）找不到清单时明确输出"跳过校验"并 exit 0，不静默崩溃。
 * 开发态没有打包产物，基准回落到项目根目录，也可用 NYX_INTEGRITY_ROOT
 * 指向一份解包产物（例如 dist\win-unpacked\resources）做联调。
 */

/** 完整性自检命令行开关 */
const VERIFY_INTEGRITY_FLAG = '--verify-integrity';
/** 清单文件名（与 build/after-pack.js 保持一致） */
const INTEGRITY_MANIFEST_NAME = 'integrity.json';
/** 摘要算法（与 build/after-pack.js 保持一致） */
const INTEGRITY_ALGORITHM = 'sha256';

/**
 * 从命令行解析 `--report=<路径>`（也接受 `--report <路径>`）。
 *
 * 返回 null 表示没有该参数；返回空串表示参数存在但路径为空（视为用户错误，
 * 只警告不阻断校验结果）。
 *
 * @param {string[]} argv 进程参数（含可执行文件路径，但不影响识别）
 * @returns {string|null}
 */
function parseIntegrityReportPath(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--report' || arg === '--report-file') {
      const next = String(argv[index + 1] || '');
      if (!next || next.startsWith('--')) return '';
      return path.resolve(next);
    }
    if (arg.startsWith('--report=')) {
      const value = arg.slice('--report='.length).trim();
      return value ? path.resolve(value) : '';
    }
  }
  return null;
}

/**
 * 计算单个文件的 SHA-256（小写 hex）。
 * 分块读取，避免把内核等大文件整块读进内存。
 *
 * @param {string} absolutePath 文件绝对路径
 * @returns {string}
 */
function hashFileSync(absolutePath) {
  const hash = crypto.createHash(INTEGRITY_ALGORITHM);
  const fd = fs.openSync(absolutePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let readBytes = 0;
    while ((readBytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, readBytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 判定清单里的相对路径是否安全：不允许绝对路径、盘符或 `..` 逃出基准目录。
 * 清单被替换成恶意内容时，不能让校验动作去读包外的任意文件。
 *
 * @param {string} relativePath 清单键
 * @returns {boolean}
 */
function isSafeIntegrityPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (path.isAbsolute(relativePath)) return false;
  if (/^[A-Za-z]:/.test(relativePath)) return false;
  return !relativePath.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * 解析完整性清单的基准目录。
 *
 * - 打包运行：process.resourcesPath（即安装目录\resources）；
 * - 开发态：项目根目录（app.getAppPath()）；
 * - 联调可用 NYX_INTEGRITY_ROOT 覆盖（指向解包产物的 resources 目录）。
 *
 * @returns {string}
 */
function resolveIntegrityBase() {
  const override = String(process.env.NYX_INTEGRITY_ROOT || '').trim();
  if (override) return path.resolve(override);
  if (app.isPackaged) return process.resourcesPath;
  return app.getAppPath();
}

/**
 * 执行一次完整性校验，打印摘要、按需写报告，返回进程退出码。
 *
 * @returns {number} 0 全部一致 / 1 存在异常
 */
function runIntegrityVerify() {
  /*
   * 关闭 Electron 的 asar 虚拟文件系统：打包后 fs.statSync/读取
   * `resources/app.asar` 会被当作"目录"处理（内容按归档虚拟化），
   * 而完整性校验要算的是磁盘上那个归档文件本身的哈希，
   * 不关掉就会把 app.asar 误判成"缺失"。进程随后立即退出，无需还原。
   */
  process.noAsar = true;
  const baseDir = resolveIntegrityBase();
  const manifestPath = path.join(baseDir, INTEGRITY_MANIFEST_NAME);
  const reportPath = parseIntegrityReportPath(process.argv);

  /*
   * 开发态兜底：未打包（直接 `electron .`）时没有构建期清单。
   * 这里明确输出"跳过"并 exit 0，而不是当成校验失败 —— 开发期想做真正的
   * 完整性校验请用 `node scripts/verify-integrity.js <产物目录>`；
   * 如果设置了 NYX_INTEGRITY_ROOT 指向解包产物，则会照常校验。
   */
  if (!app.isPackaged && !fs.existsSync(manifestPath)) {
    console.log(`[Nyx] 开发态无完整性清单（${manifestPath}），跳过完整性校验，exit 0。`);
    if (reportPath) {
      try {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(
          reportPath,
          [
            'Nyx 完整性校验报告',
            `生成时间：${new Date().toISOString()}`,
            '结果：跳过（开发态无完整性清单）',
            `校验基准：${baseDir}`,
            `清单文件：${manifestPath}（不存在）`,
            '说明：开发态未经 electron-builder 打包，没有构建期清单；',
            '      请在解包产物上执行：node scripts/verify-integrity.js <产物目录>。',
            '',
          ].join('\n'),
          'utf8',
        );
        console.log(`[Nyx] 校验报告已写入：${reportPath}`);
      } catch (error) {
        console.error(`[Nyx] 警告：校验报告写入失败：${error.message}`);
      }
    }
    return 0;
  }

  /** @type {{ version: string, generated: string, files: Record<string, string> } | null} */
  let manifest = null;
  let fatalError = '';
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fatalError = `完整性清单不可用：${error.message}`;
  }

  /** 统计与明细 */
  const result = {
    baseDir,
    manifestPath,
    version: '',
    generated: '',
    total: 0,
    matched: 0,
    /** 缺失文件（清单里有、磁盘上没有） */
    missing: [],
    /** 哈希不符明细 */
    mismatched: [],
    /** 清单里出现的非法路径（绝对路径 / ..） */
    unsafe: [],
    fatalError,
  };

  if (manifest && typeof manifest === 'object') {
    result.version = String(manifest.version || '');
    result.generated = String(manifest.generated || '');
    if (manifest.algorithm !== INTEGRITY_ALGORITHM) {
      fatalError = `清单摘要算法不受支持：${String(manifest.algorithm)}（本程序只支持 ${INTEGRITY_ALGORITHM}）`;
    } else if (
      !manifest.files ||
      typeof manifest.files !== 'object' ||
      Array.isArray(manifest.files)
    ) {
      fatalError = '清单缺少 files 字段或该字段不是对象';
    } else {
      const entries = Object.keys(manifest.files).sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      result.total = entries.length;
      if (entries.length === 0) fatalError = '清单为空：没有任何待校验文件';
      for (const relativePath of entries) {
        const expected = String(manifest.files[relativePath] || '').toLowerCase();
        if (!isSafeIntegrityPath(relativePath)) {
          result.unsafe.push(relativePath);
          continue;
        }
        const absolutePath = path.join(baseDir, ...relativePath.split(/[\\/]/));
        let stat = null;
        try {
          stat = fs.statSync(absolutePath);
        } catch {
          stat = null;
        }
        if (!stat || !stat.isFile()) {
          result.missing.push(relativePath);
          continue;
        }
        const actual = hashFileSync(absolutePath);
        if (actual === expected) {
          result.matched += 1;
        } else {
          result.mismatched.push({ relativePath, expected, actual });
        }
      }
    }
  }

  const abnormal = result.missing.length + result.mismatched.length + result.unsafe.length;
  const passed = !fatalError && result.total > 0 && abnormal === 0;

  /* ---------- stdout 摘要 ---------- */
  console.log(`[Nyx] 完整性校验基准：${baseDir}`);
  if (result.version) console.log(`[Nyx] 清单版本：${result.version}（生成于 ${result.generated || '未知时间'}）`);
  if (fatalError) console.error(`[Nyx] ✘ ${fatalError}`);
  for (const item of result.mismatched) {
    console.error(`[Nyx] ✘ 哈希不符：${item.relativePath}（期望 ${item.expected}，实际 ${item.actual}）`);
  }
  for (const relativePath of result.missing) {
    console.error(`[Nyx] ✘ 文件缺失：${relativePath}`);
  }
  for (const relativePath of result.unsafe) {
    console.error(`[Nyx] ✘ 清单路径非法（疑似被篡改）：${relativePath}`);
  }
  if (passed) {
    console.log(`[Nyx] 完整性校验通过：${result.matched}/${result.total} 项与清单一致。`);
  } else {
    console.error(
      `[Nyx] 完整性校验失败：${abnormal} 项异常（缺失 ${result.missing.length} / 不符 ${result.mismatched.length} / 非法路径 ${result.unsafe.length}），` +
        `一致 ${result.matched} 项，共 ${result.total} 项。`,
    );
  }

  /* ---------- 报告文件（可选） ---------- */
  if (reportPath === '') {
    console.error('[Nyx] 警告：--report 参数缺少路径，未写出校验报告。');
  } else if (reportPath) {
    const lines = [];
    lines.push('Nyx 完整性校验报告');
    lines.push(`生成时间：${new Date().toISOString()}`);
    lines.push(`结果：${passed ? '通过' : '失败'}`);
    lines.push(`校验基准：${baseDir}`);
    lines.push(`清单文件：${manifestPath}`);
    lines.push(`清单版本：${result.version || '未知'}（生成于 ${result.generated || '未知时间'}）`);
    lines.push(`摘要算法：${INTEGRITY_ALGORITHM}`);
    lines.push(
      `统计：共 ${result.total} 项，一致 ${result.matched} 项，缺失 ${result.missing.length} 项，哈希不符 ${result.mismatched.length} 项，非法路径 ${result.unsafe.length} 项。`,
    );
    if (fatalError) lines.push(`错误：${fatalError}`);
    lines.push('');
    lines.push('明细：');
    if (result.total === 0) lines.push('  （无可校验条目）');
    // 明细按清单顺序输出，缺失与不符项带原因标注，便于人工排查
    for (const item of result.mismatched) {
      lines.push(`  [哈希不符] ${item.relativePath}`);
      lines.push(`      期望：${item.expected}`);
      lines.push(`      实际：${item.actual}`);
    }
    for (const relativePath of result.missing) {
      lines.push(`  [缺失] ${relativePath}`);
    }
    for (const relativePath of result.unsafe) {
      lines.push(`  [非法路径] ${relativePath}`);
    }
    if (abnormal === 0 && !fatalError) {
      for (const relativePath of Object.keys(manifest && manifest.files ? manifest.files : {}).sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      )) {
        lines.push(`  [一致] ${relativePath}`);
      }
      if (result.total === 0) lines.push('  （无异常）');
    }
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
      console.log(`[Nyx] 校验报告已写入：${reportPath}`);
    } catch (error) {
      // 报告写不出来不改变校验结论，但要让调用方在日志里看得见
      console.error(`[Nyx] 警告：校验报告写入失败：${error.message}`);
    }
  }

  return passed ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* 单实例运行                                                          */
/* ------------------------------------------------------------------ */

if (process.argv.includes(VERIFY_INTEGRITY_FLAG)) {
  /*
   * 完整性自检模式：建窗前处理完即退出。
   * 这里刻意不走单实例锁 —— 否则 Nyx 正在运行时校验进程会被当成
   * "第二个实例"直接 exit(0)，无论文件有没有被改都返回 0，安装器就没法发现异常。
   */
  app.exit(runIntegrityVerify());
} else if (!app.requestSingleInstanceLock()) {
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

  // 动作通道的导航预算从设置里读（v1.17.17）：注入成函数而不是值，
  // 用户改完设置立刻生效，不用重启浏览器。
  setNavigateBudgetProvider((url) => navigateBudgetForUrl(url));

  // 系统加密是否可用：用异步版探一次并缓存（Electron 45 起同步版已弃用）。
  // 放在 UI 存储之前——隐私快照那几个判断都读这个缓存。
  refreshEncryptionAvailability().catch(() => {});

  // 剪贴板 API 形状先探一次并记诊断：兼容层不能让"运行时退回了同步 API"这件事安静地发生
  probeClipboardShape().catch(() => {});

  /**
   * 权限管理器必须在任何 session 建立之前注入。
   *
   * Session 一旦装配就把权限回调绑定在当时那个管理器实例上（且 configureSessionOnce
   * 保证只装配一次），之后再换实例不会替换已绑定的回调——结果是弹窗拿不到父窗口、
   * 界面查到的审计列表来自另一个空实例。父窗口用取值函数延迟解析，
   * 因为此刻主窗口还没创建。
   */
  // 站点设备授权：白名单在会话装配前读入，权限回调才能拿到同一份数据
  const permissionWhitelist = loadPermissionWhitelist();
  sessions.initPermissions({
    getWindow: () => runtime.mainWindow,
    log: (entry) =>
      console.log(
        `[Nyx] 权限决策｜模式：${entry.mode}｜站点：${entry.origin}｜${entry.permission} → ` +
          `${entry.granted ? '允许' : '拒绝'}｜依据：${entry.via}`,
      ),
    whitelist: permissionWhitelist.entries,
    whitelistError: permissionWhitelist.error,
    saveWhitelist: (entries) => savePermissionWhitelist(entries),
  });

  // 密码库与隐私加固装配器先就绪：恢复隐私模式时要立刻用它们下发 profile
  initUiStore();
  initStartupStore();
  initVault();
  initHistoryStore();
  initPageCache();
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

  // 下载记账（清单 A1）：所有下载都进同一个列表，状态变化即推给下载中心与外壳
  runtime.downloads = new DownloadManager({ push: () => pushDownloadsState() });

  // 普通模式下载处理器（隐私分区已整体禁止下载落盘，处理器里会给出解释性提示）
  installDownloadHandler();

  // 诊断上下文（清单 C1）：诊断页 / 诊断包 / 错误记录都从这里读实时状态，
  // 免得每个调用点各拼一份、说法还不一致。任何一项取不到都给「未知」，不抛异常。
  runtime.diagnostics = diagnostics;
  diagnostics.setContextProvider(() => {
    const context = {
      appVersion: app.getVersion(),
      mode: '未知',
      link: '未知',
      proxy: '未知',
      gpu: '未知',
    };

    try {
      context.mode = sessions.getMode() === 'private' ? '全隐私模式' : '普通模式';
      context.link = sessions.getLink() === 'proxy' ? '经代理' : '直连（真实 IP）';
    } catch (err) {
      context.linkError = err && err.message;
    }

    try {
      const kernel = runtime.proxyService && typeof runtime.proxyService.status === 'function'
        ? runtime.proxyService.status()
        : null;
      const reachable = runtime.network ? runtime.network.proxyReachable : null;
      const probeText = reachable === null || reachable === undefined ? '未探测' : reachable ? '可达' : '不可达';
      context.proxy =
        `内核${kernel && kernel.running ? '运行中' : '未运行'}` +
        `／混合端口 ${kernel && kernel.mixedPort ? kernel.mixedPort : '—'}` +
        `／探测 ${probeText}` +
        (kernel && kernel.lastError ? `／最近错误：${kernel.lastError}` : '');
    } catch (err) {
      context.proxy = `读取失败：${err && err.message ? err.message : err}`;
    }

    try {
      const feature = typeof app.getGPUFeatureStatus === 'function' ? app.getGPUFeatureStatus() : null;
      const compositing = (feature && feature.gpu_compositing) || '';
      const enabled = compositing.startsWith('enabled');
      const adapter = runtime.gpuInfo && runtime.gpuInfo.ok ? runtime.gpuInfo.activeName : '未知';
      context.gpu =
        `硬件加速${enabled ? '已启用' : '未启用'}／GPU 合成 ${compositing || '未知'}` +
        `／适配器 ${adapter}／策略 ${describeGpuPolicy(BOOT_GPU_POLICY).label}`;
    } catch (err) {
      context.gpu = `读取失败：${err && err.message ? err.message : err}`;
    }

    return context;
  });
  diagnostics.info('APP_READY', '诊断服务已就绪', { userData: app.getPath('userData') });

  // 显卡适配器（清单 A5）：启动后问一次 Chromium 到底用的哪张卡，写进诊断日志；
  // 取不到就写"未知"，绝不用"已启用独显/已启用核显"这种猜的结论糊过去。
  if (typeof app.getGPUInfo === 'function') {
    app
      .getGPUInfo('basic')
      .then((info) => {
        runtime.gpuInfo = summarizeGpuInfo(info);
        diagnostics.info('GPU_ADAPTER', runtime.gpuInfo.activeName, {
          bootPolicy: BOOT_GPU_POLICY,
          deviceCount: runtime.gpuInfo.deviceCount,
          activeKnown: !!runtime.gpuInfo.activeKnown,
        });
        console.log(`[Nyx] 显卡适配器：${runtime.gpuInfo.activeName}`);
      })
      .catch((err) => {
        runtime.gpuInfo = summarizeGpuInfo(null);
        diagnostics.warn('GPU_ADAPTER_FAILED', '读不到显卡适配器', {
          error: err && err.message ? err.message : String(err),
        });
      });
  }

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

  // 启动阶段的提示同样入队：此时主窗口还没创建，notifyNotice 会按就绪状态暂存
  if (startupNotice) notifyNotice(startupNotice);

  // 应用菜单统一为中文（主窗口默认隐藏菜单栏，按 Alt 可唤出）
  installChineseMenu();

  createMainWindow();
  createTray();
  registerPanicShortcut();
  registerAgentStopShortcut();

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
      `代理端口：${sessions.getProxyPort()}｜标签上限：${MAX_TABS}｜恐慌快捷键：${runtime.panicShortcut || '（注册失败）'}`,
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
      `条目：${stats.credentialCount} 个来源 / ${stats.formCount} 份表单记忆｜文件：${stats.file}`,
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
 * 离线缓存：<userData>/page-cache.json。
 *
 * 只存正文快照（标题 + 纯文字），隐私模式绝不写（见 savePageCache）。
 * 加载失败就当空表——一个坏文件不该让"断网还能看点东西"整体失效。
 */
function initPageCache() {
  const file = userDataFile('page-cache.json');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  runtime.pageCache = readPageCache(raw);
  if (runtime.pageCache.items.length) {
    console.log(`[Nyx] 离线缓存就绪｜条目：${runtime.pageCache.items.length}｜文件：${file}`);
  }
  runtime.pageCacheFile = file;
  readPrivateCache();
  return runtime.pageCache;
}

/** 写一条离线快照（或用户关掉离线缓存时直接返回，不落盘）。
 *
 * 隐私模式（用户第 2 项）：不再"一律不写"，而是写进**另一个文件**并整条加密
 * （safeStorage → Windows DPAPI），明面上只留「存过一条」的哈希与时间。
 * 系统密钥不可用时**绝不退化成明文**，直接拒绝并说清原因。
 */
function savePageCache(snapshot) {
  if (runtime.uiStore && runtime.uiStore.get().offlineCacheEnabled === false) return false;
  if (sessions.getMode() === 'private') return savePrivatePageCache(snapshot);
  const result = putSnapshot(runtime.pageCache, snapshot);
  if (!result.stored) return false;
  runtime.pageCache = result.store;
  try {
    fs.writeFileSync(runtime.pageCacheFile, JSON.stringify(runtime.pageCache), 'utf8');
  } catch (err) {
    console.warn('[Nyx] 离线缓存没能写入磁盘（内存里仍有效）：', err && err.message ? err.message : err);
    if (runtime.diagnostics) runtime.diagnostics.warn('PAGE_CACHE_SAVE_FAILED', '离线缓存写盘失败', { error: String(err && err.message ? err.message : err) });
  }
  return true;
}

/** 隐私模式快照"没存下来"的原因（下一次打开设置时如实显示，不许静默） */
let pendingPrivateCacheNotice = '';

/** 只清隐私模式那份加密快照（关掉开关时用；普通模式的明文快照不受影响） */
function clearPrivateCache(reason) {
  const cleared = Array.isArray(runtime.privateCache && runtime.privateCache.entries)
    ? runtime.privateCache.entries.length
    : 0;
  runtime.privateCache = { v: 1, entries: [] };
  try {
    fs.writeFileSync(privateCachePath(), JSON.stringify(runtime.privateCache), 'utf8');
  } catch (err) {
    if (runtime.diagnostics) {
      runtime.diagnostics.error('PRIVATE_CACHE_CLEAR_FAILED', '清空隐私模式快照时没能写入磁盘', {
        error: String(err && err.message ? err.message : err),
      });
    }
    return { ok: false, cleared, error: `没能清空隐私模式快照：${err && err.message ? err.message : err}` };
  }
  if (runtime.diagnostics) runtime.diagnostics.info('PRIVATE_CACHE_CLEARED', { reason, cleared });
  return { ok: true, cleared };
}

/** 站点黑白名单（用户第 5 项）：从偏好里取当前策略，界面改完立刻生效 */
function cacheSitePolicy() {
  if (!runtime.uiStore) return normalizeSitePolicy(null);
  const prefs = runtime.uiStore.get();
  return normalizeSitePolicy({
    mode: prefs.cacheSiteMode,
    allow: prefs.cacheSiteAllow,
    block: prefs.cacheSiteBlock,
  });
}

/**
 * 隐私模式快照的站点名单：与普通模式那份**分开存**。
 * 理由是这两个问题不一样——普通模式管「要不要留明文正文」，隐私模式管「要不要留加密快照」。
 */
function privateSitePolicy() {
  if (!runtime.uiStore) return normalizeSitePolicy(null);
  const prefs = runtime.uiStore.get();
  return normalizeSitePolicy({
    mode: prefs.privateSiteMode,
    allow: prefs.privateSiteAllow,
    block: prefs.privateSiteBlock,
  });
}

/**
 * 写回站点名单：三个键逐个落盘，哪一步失败就立刻报出来（不静默丢一半）。
 * 手动改名单和导入名单都走这里，免得两边落盘逻辑各写一套。
 * scope='private' 时写的是隐私模式那一份（字段名不同，规则完全相同）。
 */
function saveCacheSitePolicy(policy, scope) {
  const which = scope === 'private' ? 'private' : 'normal';
  const next = normalizeSitePolicy(policy);
  const writes =
    which === 'private'
      ? [
          ['privateSiteMode', next.mode],
          ['privateSiteAllow', next.allow],
          ['privateSiteBlock', next.block],
        ]
      : [
          ['cacheSiteMode', next.mode],
          ['cacheSiteAllow', next.allow],
          ['cacheSiteBlock', next.block],
        ];
  for (const [key, value] of writes) {
    try {
      const saved = runtime.uiStore ? runtime.uiStore.set(key, value) : { ok: false, error: '偏好存储还没就绪' };
      if (saved && saved.ok === false) {
        if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_SITE_SAVE_FAILED', '站点名单没能保存', { key, error: saved.error });
        return { ok: false, error: `没能保存 ${key}：${saved.error}` };
      }
    } catch (err) {
      const reason = err && err.message ? err.message : err;
      if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_SITE_SAVE_FAILED', '站点名单没能保存', { key, error: String(reason) });
      return { ok: false, error: `没能保存 ${key}：${reason}` };
    }
  }
  return { ok: true, ...next };
}

/**
 * 自定义模板（第八轮 ⑤）：自己攒的那份名单存成模板，换机器还能一键套。
 *
 * 单独一个文件、单独一份数据，不塞进 ui-preferences.json：
 * 模板是"可搬走的清单"，偏好是"这台机器的状态"，混在一起以后导出会很尴尬。
 */
function customTemplatePath() {
  return userDataFile('cache-site-templates.json');
}

function readCustomTemplates() {
  const file = customTemplatePath();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return normalizeCustomTemplates(parsed && parsed.templates);
  } catch (err) {
    console.warn('[Nyx] 自定义模板文件读不懂，按空处理：', err && err.message ? err.message : err);
    if (runtime.diagnostics) {
      runtime.diagnostics.warn('PRIVATE_CACHE_TEMPLATES_READ_FAILED', '自定义模板文件读不出来，已按空处理', { file });
    }
    return [];
  }
}

function writeCustomTemplates(templates) {
  const file = customTemplatePath();
  const list = normalizeCustomTemplates(templates);
  try {
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, templates: list }, null, 2)}\n`, 'utf8');
    return { ok: true, count: list.length };
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.warn('[Nyx] 自定义模板没能写入：', reason);
    if (runtime.diagnostics) {
      runtime.diagnostics.error('PRIVATE_CACHE_TEMPLATES_SAVE_FAILED', '自定义模板没能写入磁盘', { file, error: reason });
    }
    return { ok: false, error: `没能写到磁盘上：${reason}` };
  }
}

/** 隐私模式的加密快照：读 / 写 / 查，全部绕开明文文件 */
function privateCachePath() {
  return userDataFile('private-cache.json');
}

function readPrivateCache() {
  const file = privateCachePath();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = '';
  }
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null;
  } catch (err) {
    console.warn('[Nyx] 隐私模式快照文件读不懂，按空处理：', err && err.message ? err.message : err);
    if (runtime.diagnostics) runtime.diagnostics.warn('PRIVATE_CACHE_READ_FAILED', '隐私模式的快照文件读不出来，已按空处理', { file });
  }
  runtime.privateCache = normalizePrivateStore(parsed, { now: Date.now() });
  runtime.privateCacheFile = file;
  return runtime.privateCache;
}

function writePrivateCache(store) {
  const file = privateCachePath();
  try {
    fs.writeFileSync(file, JSON.stringify(store), 'utf8');
    return true;
  } catch (err) {
    console.warn('[Nyx] 隐私模式的快照没能写入磁盘：', err && err.message ? err.message : err);
    if (runtime.diagnostics) {
      runtime.diagnostics.error('PRIVATE_CACHE_SAVE_FAILED', '隐私模式的加密快照写盘失败', {
        error: String(err && err.message ? err.message : err),
      });
    }
    return false;
  }
}

/**
 * 系统加密是否可用（隐私快照要不要落盘靠它决定）。
 *
 * Electron 45 把 `safeStorage.isEncryptionAvailable` 标成 deprecated，
 * 推荐 `isAsyncEncryptionAvailable()`（返回 Promise）。这两个调用点是同步的
 * （要立刻决定"这条快照能不能写盘"），所以做法是：启动时用异步版探一次并缓存，
 * 同步调用只读缓存；缓存还没建立时退回旧的同步 API（仍可用，只是会打一条弃用警告）。
 */
let encryptionAvailableCache = null;

async function refreshEncryptionAvailability() {
  try {
    if (safeStorage && typeof safeStorage.isAsyncEncryptionAvailable === 'function') {
      encryptionAvailableCache = Boolean(await safeStorage.isAsyncEncryptionAvailable());
    } else if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
      encryptionAvailableCache = Boolean(safeStorage.isEncryptionAvailable());
    } else {
      encryptionAvailableCache = false;
    }
  } catch (err) {
    encryptionAvailableCache = false;
    diagnostics.warn('ENCRYPTION_STATE_FAILED', '读不到系统加密是否可用，按"不可用"处理', {
      error: String(err && err.message ? err.message : err).slice(0, 160),
    });
  }
  diagnostics.info('ENCRYPTION_STATE', encryptionAvailableCache ? '系统加密可用' : '系统加密不可用', {
    backend: encryptionAvailableCache ? 'os' : 'none',
  });
  return encryptionAvailableCache;
}

function encryptionAvailable() {
  if (encryptionAvailableCache !== null) return encryptionAvailableCache === true;
  // 还没探过（极少见：启动早期就有人问）——用旧接口兜一次，绝不当成"可用"
  try {
    return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function privateCacheDecision() {
  const available = encryptionAvailable();
  const enabled = runtime.uiStore ? runtime.uiStore.get().privateSnapshotEnabled !== false : true;
  return pickPrivateStoreMode({ encryptionAvailable: available, enabled });
}

/**
 * 隐私模式名单是不是「真的在生效」。
 *
 * 名单只有在隐私快照开着、并且这台机器上系统加密可用时才起作用。
 * 关着的时候改名单不会报错，但也不会有任何效果——这种事必须让用户看见，
 * 否则用户会以为「我已经把这些站点放进名单了」，实际什么都没记。
 */
function privateSiteEffective() {
  const prefs = runtime.uiStore ? runtime.uiStore.get() : {};
  const enabled = prefs.privateSnapshotEnabled !== false;
  const available = encryptionAvailable();
  const active = enabled && available;
  let note = '';
  if (!enabled) {
    note = '隐私模式快照现在是关着的，这份名单暂时不会生效；把「隐私模式快照」打开之后才会按它来。';
  } else if (!available) {
    note = '这台机器上系统加密不可用，隐私模式快照根本不会写盘，这份名单暂时不会生效。';
  }
  return { enabled, encryptionAvailable: available, active, note };
}

function savePrivatePageCache(snapshot) {
  const decision = privateCacheDecision();
  if (!decision.ok) {
    if (runtime.diagnostics) {
      runtime.diagnostics.warn('PRIVATE_CACHE_SKIPPED', '隐私模式的快照没有保存', { reason: decision.reason });
    }
    pendingPrivateCacheNotice = decision.reason;
    return false;
  }
  // 站点名单：隐私模式另有自己那一份（block 优先、allowlist 只存名单里的）。
  // 判断放在加密之前——不该留下的站点，连内存里的密文都不该出现。
  const siteDecision = decideCacheSite(String(snapshot && snapshot.url ? snapshot.url : ''), privateSitePolicy());
  if (!siteDecision.cache) {
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PRIVATE_CACHE_SITE_SKIPPED', '这个站点按名单不存隐私快照', {
        layer: siteDecision.layer,
        host: siteDecision.host,
      });
    }
    return false;
  }
  const prepared = preparePrivateRecord(snapshot, { now: Date.now(), hash: privateHash });
  if (!prepared.ok) return false;
  let blob = '';
  try {
    blob = safeStorage.encryptString(JSON.stringify(prepared.record.payload)).toString('base64');
  } catch (err) {
    if (runtime.diagnostics) {
      runtime.diagnostics.error('PRIVATE_CACHE_ENCRYPT_FAILED', '隐私模式的快照加密失败', {
        error: String(err && err.message ? err.message : err),
      });
    }
    pendingPrivateCacheNotice = '这条快照没加密成功，所以没有保存。';
    return false;
  }
  const next = putPrivateEntry(runtime.privateCache, { hash: prepared.record.hash, at: prepared.record.at, blob }, { now: Date.now() });
  runtime.privateCache = { v: next.v, entries: next.entries };
  const written = writePrivateCache(runtime.privateCache);
  if (runtime.diagnostics) {
    runtime.diagnostics.info('PRIVATE_CACHE_SAVED', '隐私模式的快照已加密保存', {
      entries: runtime.privateCache.entries.length,
      written,
      chars: prepared.record.payload.text.length,
    });
  }
  return written;
}

/** 隐私模式下按地址取回快照：只有能解密才返回内容 */
function getPrivateCachedPage(url) {
  const hash = privateHash(String(url || ''));
  if (!hash) return { available: false, note: '这条地址没有加密快照。', encrypted: true };
  const entry = findPrivateEntry(runtime.privateCache, hash, { now: Date.now() });
  if (!entry) return { available: false, note: '这条地址没有加密快照。', encrypted: true };
  let payload = null;
  try {
    payload = JSON.parse(safeStorage.decryptString(Buffer.from(entry.blob, 'base64')));
  } catch (err) {
    if (runtime.diagnostics) {
      runtime.diagnostics.warn('PRIVATE_CACHE_DECRYPT_FAILED', '隐私模式的快照解不开（可能换了账户或系统密钥变了）', {
        error: String(err && err.message ? err.message : err),
      });
    }
    return {
      available: false,
      encrypted: true,
      broken: true,
      note:
        '这条加密快照解不开了（换了系统账户或密钥变了）。它不会自己恢复，' +
        '可以在 设置 → 隐私与安全 → 离线阅读缓存 里一键清掉。',
    };
  }
  const described = describePrivateEntry(entry, { now: Date.now() });
  const text = typeof payload.text === 'string' ? payload.text : '';
  return {
    available: true,
    encrypted: true,
    title: payload.title || '',
    url: payload.url || '',
    text,
    chars: text.length,
    at: described.at,
    ageText: described.ageText,
    note: described.note,
    blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    images: [],
  };
}

function privateHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 32);
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
function currentEgressAddress() {
  try {
    const service = runtime.proxyService;
    const profile = service && typeof service.egressProfile === 'function' ? service.egressProfile() : null;
    return profile && profile.ip ? String(profile.ip) : '';
  } catch {
    return '';
  }
}
async function resolveEgressForProfile() {  const service = runtime.proxyService;
  if (!service) return { egress: null, egressUnknown: true, error: '代理服务未就绪' };

  // "取不到出口"这个结论也缓存 60 秒：最贵的不是成功那次，而是失败那次——
  // 出口自查超时要等满 6 秒，连着切两次就是 12 秒，而结论通常不会在两分钟内变好。
  const unknownCache = runtime.switchCache && runtime.switchCache.egressUnknown;
  if (unknownCache) {
    const hit = readTimed(unknownCache, Date.now(), EGRESS_UNKNOWN_TTL_MS);
    if (hit.hit) {
      return {
        egress: null,
        egressUnknown: true,
        reused: true,
        error: `${hit.value || '出口自查没有取到'}（${Math.round(hit.ageMs / 1000)} 秒前刚试过，${Math.round(
          EGRESS_UNKNOWN_TTL_MS / 1000,
        )} 秒内不重复等）`,
      };
    }
  }

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
    const reason = fresh && fresh.error ? fresh.error : `出口自查超时（${EGRESS_MAX_WAIT_MS}ms）`;
    if (runtime.switchCache) runtime.switchCache.egressUnknown = writeTimed(reason, Date.now());
    return {
      egress: null,
      egressUnknown: true,
      error: reason,
    };
  } catch (err) {
    if (runtime.switchCache) runtime.switchCache.egressUnknown = writeTimed(err.message, Date.now());
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
 * 给一个标签装配「隐私指纹面」（安全审计 P0-3）。
 *
 * 审计的结论是：原来那 11 个 guard 写在 preload 的隔离世界里，页面主世界一行都看不到，
 * 于是「请求头说 Chrome/156、页面说自己 Electron/45」——头与 JS 互相矛盾，比不伪装更假。
 *
 * 这里补上真正生效的三层（缺一层都算没修好）：
 *   1. `wc.setUserAgent()`：请求头与 `navigator.userAgent` 同源；
 *   2. CDP `Emulation.*`：UA 的 platform/acceptLanguage、时区、语言一起对齐；
 *   3. CDP `Page.addScriptToEvaluateOnNewDocument`：Canvas/WebGL/Audio/硬件并发这些
 *      只能靠 JS 改的，注入到**主世界**，且在页面脚本之前执行。
 *
 * 任何一层失败都必须让用户看见（红线 2）：不静默降级成"半加固"，
 * 并在标签上记 `privacyIncomplete` 供后续排障。
 */
/**
 * 当前主显示器的缩放比。
 * 隐私模式要把 devicePixelRatio 改成画像里的值，但"改成多少"不能拍脑袋：
 * 真实浏览器的 devicePixelRatio 恒等于系统缩放，改成别的值就是一处破绽。
 */
function currentScreenScaleFactor() {
  try {
    const display = screen.getPrimaryDisplay();
    const factor = display && Number(display.scaleFactor);
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch (error) {
    return 1;
  }
}

async function attachPrivacySurface(tab) {
  if (!tab || !tab.view) return { ok: false, error: '标签还没准备好' };
  // 这一行是给排障用的：指纹面到底有没有被叫起来、当时是什么模式、哪个标签
  console.log(`[Nyx] 指纹面装配开始｜模式=${sessions.getMode()}｜标签=${tab && tab.id}`);
  if (!shouldAttachSurface(sessions.getMode())) return { ok: true, skipped: true };

  const baseProfile = runtime.hardening ? runtime.hardening.profile : null;
  // 像素比要跟系统缩放一致：真实浏览器里 devicePixelRatio 恒等于系统缩放，
  // 只在 JS 里把它改成 1、而系统缩放是 1.5，反而是"只改了一半"的破绽。
  const profile = baseProfile
    ? { ...baseProfile, devicePixelRatio: currentScreenScaleFactor() }
    : null;
  const wc = tab.view.webContents;
  const fail = (message) => {
    tab.privacyIncomplete = true;
    console.warn(`[Nyx] 隐私指纹面装配失败：${message}`);
    diagnostics.error('PRIVACY_SURFACE_FAILED', message, { tabId: tab.id });
    notifyNotice({ level: 'error', code: 'PRIVACY_SURFACE_FAILED', title: '隐私模式加固没做完', message });
    return { ok: false, error: message };
  };

  if (!profile) {
    return fail(
      '隐私模式没有可用的指纹画像（profile 为空）：这一页看到的会是本机真实标识，建议退出隐私模式后重新进入。',
    );
  }

  // 1) UA：这一步最关键——它决定请求头与 navigator.userAgent 是否同源
  try {
    // 与 privacy-hardening / toolbox 的调用口径一致：null/undefined 会让 Electron
    // 在参数转换时抛 conversion failure，必须在这里也兜成空串。
    wc.setUserAgent(profile.ua || '', profile.acceptLanguage || '');
  } catch (err) {
    return fail(describeSurfaceFailure('setUserAgent', err));
  }

  // 2) 首个文档的补丁：**先挂好再导航**
  // Page.addScriptToEvaluateOnNewDocument 在"这个 webContents 还没有任何文档"时不会回执
  // （实测 3 秒超时，连带把整条装配链路掐断），所以不能指望它在导航前注册成功。
  // 可靠的路子是在文档就绪后把同一条脚本直接打进主世界，并当场核对标记。
  // 代价写在台账里：第一个文档的补丁是"文档就绪之后"打上的；从第二次导航起才在文档开始时就生效。
  // 用 on 而不是 once：首个 dom-ready 可能落在 about:blank 这种空文档上（
  // 实测就是这样——补打打进了空文档，紧接着真正的页面加载把它整个换掉，
  // 页面里 window.__nyxSurface 又变成 null）。每次文档就绪都补一次，脚本自己幂等。
  wc.on('dom-ready', () => {
    applySurfaceToCurrentDocument(tab, profile).catch((err) => {
      console.warn('[Nyx] 隐私指纹面补打失败：', err && err.message);
    });
  });

  // 3) CDP：这里只把调试通道接上、并把 Worker 接管挂好。
  //    Emulation.* 那些身份对齐命令**必须等文档就绪再发**——在"还没有文档"的 webContents 上
  //    它们不回执（实测每一条都要等满 3 秒超时），既拖慢切换，又会和紧随其后的补打抢同一个
  //    调试会话，导致首个文档的补丁时好时坏。发送动作放在 applySurfaceToCurrentDocument 里。
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch (err) {
    return fail(describeSurfaceFailure('attach', err));
  }

  // 4) Worker：Page.addScriptToEvaluateOnNewDocument 只管文档，管不到 Worker 上下文
  //    （对抗测试 P0 实测：同一页主世界 en-US、Worker 里 zh-CN + 24 核）。
  //    这里用 Target.setAutoAttach 把 worker 目标在"开跑之前"拦住，先把 worker 版脚本
  //    evaluate 进去，再 runIfWaitingForDebugger 放行。拦不住也必须有痕迹（红线 2）。
  try {
    const workerSource = buildWorkerHardeningScript(profile);
    wc.debugger.on('message', (event, method, params, sessionId) => {
      if (method !== 'Target.attachedToTarget') return;
      const info = (params && params.targetInfo) || {};
      const kind = String(info.type || '');
      const session = (params && params.sessionId) || sessionId;
      if (kind !== 'worker' || !session) return;
      wc.debugger
        .sendCommand('Runtime.evaluate', { expression: workerSource, includeCommandLineAPI: false }, session)
        .catch((err) => {
          diagnostics.warn('PRIVACY_WORKER_INJECT_FAILED', 'Worker 里的指纹补丁没打进去', {
            tabId: tab.id,
            error: String((err && err.message) || err),
          });
        });
      wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, session).catch(() => {});
    });
    await wc.debugger.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  } catch (err) {
    const message = `隐私模式没能接管 Worker 上下文（${(err && err.message) || err}）：网页里由后台线程读到的语言/时区/核数可能仍是本机的。`;
    console.warn('[Nyx] 指纹面 Worker 接管失败：', message);
    diagnostics.warn('PRIVACY_WORKER_ATTACH_FAILED', message, { tabId: tab.id });
  }

  tab.privacyIncomplete = false;
  return { ok: true };
}

/**
 * 把加固脚本打进**当前文档**并核对标记是否真的落地。
 * 这一步存在的理由：Page.addScriptToEvaluateOnNewDocument 在"目标还没有任何文档"时
 * 不一定赶得上首个文档（对抗测试 N1 的现场就是这样：命令全成功、页面里一条都没生效）。
 */
async function applySurfaceToCurrentDocument(tab, profile) {
  if (!tab || !tab.view || !profile) return { ok: false, error: '没有可用的标签或画像' };
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return { ok: false, error: '标签已经关掉了' };
  const source = buildHardeningScript(profile);
  // 现在这个 webContents 有文档了，Page 域的命令才会回执：趁这一步把注入注册上，
  // 之后同一标签再导航（点链接、刷新）就能在"文档开始"时生效，不必每次都靠补打。
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    const enable = wc.debugger.sendCommand('Page.enable', {});
    const inject = wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('3 秒没有回执')), 3000));
    await Promise.race([Promise.all([enable, inject]), timeout]);
  } catch (err) {
    console.warn('[Nyx] 指纹面注入注册失败（本页仍会补打）：', err && err.message);
  }
  try {
    await wc.executeJavaScript(source, true);
    const applied = await wc.executeJavaScript('window.__nyxSurface || null', true);
    if (!applied) {
      tab.privacyIncomplete = true;
      const message = '隐私模式加固没生效：这一页的指纹仍是本机的（加固脚本没有跑起来）。关掉这一页重新打开；如果一直这样，请把诊断包发出来。';
      diagnostics.error('PRIVACY_SURFACE_NOT_APPLIED', '加固脚本在当前文档里没有生效', { tabId: tab.id });
      notifyNotice({ level: 'error', code: 'PRIVACY_SURFACE_FAILED', title: '隐私模式加固没做完', message });
      return { ok: false, error: message };
    }
    // 补丁落地之后再发身份对齐命令：此时文档存在，命令才会真的回执。
    // 失败只留痕、不掐断——补丁本身已经生效，这一层只影响"上报的身份细节"。
    for (const step of buildCdpSteps(profile)) {
      if (step.method === 'Page.enable' || step.method === 'Page.addScriptToEvaluateOnNewDocument') continue;
      try {
        const sent = wc.debugger.sendCommand(step.method, step.params);
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('下发超时（1.5 秒没有回执）')), 1500);
        });
        await Promise.race([sent, timeout]);
      } catch (err) {
        const message = describeSurfaceFailure('send', err);
        console.warn(`[Nyx] 指纹面下发 ${step.method} 失败：${message}`);
        diagnostics.warn('PRIVACY_SURFACE_STEP_FAILED', message, { tabId: tab.id, step: step.method });
      }
    }
    tab.privacyIncomplete = false;
    return { ok: true, applied };
  } catch (err) {
    tab.privacyIncomplete = true;
    diagnostics.error('PRIVACY_SURFACE_PATCH_FAILED', '当前文档补打加固脚本失败', {
      tabId: tab.id,
      reason: String((err && err.message) || err),
    });
    return { ok: false, error: String((err && err.message) || err) };
  }
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
 * 整机有没有网（走 Chromium 网络栈的判断，比 ping 轻）。
 *
 * 为什么单独包一层：`electronNet.isOnline()` 在个别网卡切换的瞬间会抛，
 * 而这段代码跑在"页面已经打不开"的路径上——再崩一次只会让用户看到更差的局面。
 * 读不到就返回 true（按"有网"处理），让后面的代理探测继续做判断，
 * 绝不因为读不到就默认"断网"从而掩盖真正的代理故障。
 */
function onlineState() {
  try {
    return electronNet.isOnline() !== false;
  } catch (err) {
    console.warn('[Nyx] 读取网络在线状态失败，按"有网"处理：', err.message);
    return true;
  }
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
 * 处理原则是"先探测、再决定"，具体判定抽在 `core/link-guard.js` 的纯函数里：
 *   - 探测到代理仍可达 → 属于站点 / 网络问题，不动链路（避免把正常代理误判掉）；
 *   - 普通模式 + 代理确不可达 → 切直连、提示用户并重载出错的标签；
 *   - 隐私模式 + 代理确不可达 → **不降级**，但必须明确告知"为什么打不开"。
 *
 * 隐私模式这条分支以前是 `if (mode !== 'normal') return;`，也就是页面只会报一个
 * 光秃秃的 ERR_PROXY_CONNECTION_FAILED，用户看不到"代理挂了"这件事——实测清单
 * A2「全隐私模式静默变直连」的观感有一半来自这里：不知道发生了什么，只能推断。
 */
async function handleProxyLoadFailure(info) {
  const mode = sessions.getMode();
  const link = sessions.getLink(mode);
  if (!isProxyFailureCode(info && info.errorCode)) return;
  if (link === 'direct') return;
  if (runtime.linkGuardBusy) return;

  runtime.linkGuardBusy = true;
  try {
    const probe = recordProbe(await isProxyReachable());
    // 整机有没有网：断网时"代理不可达"是必然结果，不能因此把链路改成直连。
    const online = onlineState();
    const decision = decideProxyFailureAction({
      mode,
      link,
      reachable: probe.reachable,
      errorCode: info.errorCode,
      host: probe.host,
      port: probe.port,
      error: probe.error,
      url: info.url,
      online,
    });

    if (decision.action === LINK_GUARD_ACTIONS.offline) {
      console.warn(
        `[Nyx] 整机断网（代理 ${probe.host}:${probe.port} 不可达：${probe.error}），` +
          '保持原链路不改',
      );
      diagnostics.warn('NETWORK_OFFLINE', {
        host: probe.host,
        port: probe.port,
        error: probe.error,
        errorCode: info.errorCode,
        url: info.url || '',
        mode,
      });
      modeEventLog.record({
        type: 'switch',
        from: mode,
        to: mode,
        changed: false,
        ok: false,
        code: 'NETWORK_OFFLINE',
        message: decision.notice.message,
      });
      notifyNotice(decision.notice);
      pushState(currentSnapshot());
      return;
    }

    if (decision.action === LINK_GUARD_ACTIONS.notifyPrivate) {
      console.warn(
        `[Nyx] 隐私模式下代理 ${probe.host}:${probe.port} 不可达（${probe.error}），` +
          '保持代理链路，不降级为直连',
      );
      diagnostics.error('PRIVACY_PROXY_DOWN', {
        host: probe.host,
        port: probe.port,
        error: probe.error,
        errorCode: info.errorCode,
        url: info.url || '',
      });
      modeEventLog.record({
        type: 'switch',
        from: 'private',
        to: 'private',
        changed: false,
        ok: false,
        code: 'PRIVACY_PROXY_DOWN',
        message: decision.notice.message,
      });
      notifyNotice(decision.notice);
      pushState(currentSnapshot());
      return;
    }

    if (decision.action !== LINK_GUARD_ACTIONS.fallbackDirect) {
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

    diagnostics.warn('PROXY_FALLBACK_DIRECT', {
      host: probe.host,
      port: probe.port,
      error: probe.error,
      errorCode: info.errorCode,
      url: info.url || '',
    });
    modeEventLog.record({
      type: 'switch',
      from: 'normal',
      to: 'normal',
      changed: false,
      ok: true,
      code: 'PROXY_FALLBACK_DIRECT',
      message: decision.notice.message,
    });

    notifyNotice(decision.notice);

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
      runtime.tabManager
        ? runtime.tabManager.tabs.filter((tab) => tab.view).map((tab) => tab.view.webContents)
        : [],
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
/**
 * 摘要面板占掉的右侧宽度（px）。
 * = 面板本体 380（src/renderer/style.css 里 .digest-panel 的 width）+ 右边距 14
 * + 8 的呼吸位——算少了就会贴着页面边框，看起来像被裁掉一块。
 */
const DIGEST_PANEL_W = 402;
/** 摘要面板与窗口边缘的间距（px）：与 .digest-panel 的 right 值一致 */
const DIGEST_PANEL_GAP = 14;

/**
 * 右侧被界面占掉的宽度（清单 A2）。
 *
 * 摘要面板与工具箱都贴右边，以前只把工具箱算进去：摘要一展开就被标签页压住，
 * 用户看到的是「摘要被遮」。现在两边各自占的宽度都从这里算，标签视图一起让开，
 * 页面对应的那块区域跟着变窄——不遮，也不叠。
 */
/** agent 状态面板宽度（清单 A5）：面板本体 280 + 右边距 14 + 8 呼吸位 */
const AGENT_PANEL_W = 302;

/**
 * 右侧被界面占掉的宽度（清单 A2 / A5）。
 *
 * 摘要面板、agent 状态面板与工具箱都贴右边，以前只把工具箱算进去：面板一展开就被
 * 标签页压住，用户看到的是「被遮」。现在各自占的宽度都从这里算，标签视图一起让开，
 * 页面对应的那块区域跟着变窄——不遮，也不叠。
 */
function applyRightInsets() {
  if (!runtime.tabManager) return 0;
  const toolbox = runtime.toolboxOpen ? runtime.toolboxWidth : 0;
  const digest = runtime.digestOpen ? DIGEST_PANEL_W : 0;
  const agent = runtime.agentPanelOpen ? AGENT_PANEL_W : 0;
  const total = toolbox + digest + agent;
  runtime.tabManager.setRightInset(total);
  return total;
}

async function setToolboxOpen(open, width) {
  runtime.toolboxOpen = !!open;
  if (width) runtime.toolboxWidth = Math.max(320, Math.min(Number(width) || 460, 1400));

  if (runtime.tabManager) {
    applyRightInsets();
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

  // 落点先登记再触发下载：常驻 will-download 处理器会按序取用这个路径，
  // 不会再弹第二个保存框；进度与结果统一由它记账并推到下载中心。
  pendingDownloadPaths.push(savePath);
  try {
    wc.downloadURL(target);
  } catch (err) {
    // 启动失败必须把预登记落点收回，否则会污染下一次下载
    const idx = pendingDownloadPaths.indexOf(savePath);
    if (idx >= 0) pendingDownloadPaths.splice(idx, 1);
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
 * 日志/诊断里的地址只保留协议+主机+路径，丢掉查询串。
 * 下载链接的 query 里经常带一次性签名票据，写进诊断包再导出就外泄了。
 */
function redactUrlForLog(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url || '').slice(0, 80);
  }
}

/**
 * 工具箱「下载此资源」预登记的落点队列。
 *
 * 常驻 will-download 处理器与 downloadResource() 会先后收到同一个事件，
 * 谁先设落点谁生效；用队列把「我已经替用户决定好了保存路径」这件事传过去，
 * 避免常驻处理器再弹一次保存框。
 */
const pendingDownloadPaths = [];

/** 取出（并移除）一个预登记落点；没有则返回空串 */
function takePendingDownloadPath() {
  return pendingDownloadPaths.length ? pendingDownloadPaths.shift() : '';
}

/** 下载目录：用户设置且仍然存在的目录优先，否则系统下载目录 */
function resolveDownloadDir() {
  const prefs = runtime.uiStore ? runtime.uiStore.get() : {};
  const configured = typeof prefs.downloadDir === 'string' ? prefs.downloadDir.trim() : '';
  if (configured) {
    try {
      if (fs.existsSync(configured)) return configured;
    } catch {
      /* 目录不可访问：回落系统下载目录 */
    }
  }
  return app.getPath('downloads');
}

/**
 * 普通模式页面下载处理器（常驻 will-download）+ 隐私模式拦截告知。
 *
 * 历史 bug（实测清单 A1「下载全都报废了」）：这里原本先
 * `event.preventDefault()` 再去 `await dialog.showSaveDialog(...)`，
 * 而 will-download 里 preventDefault 的语义就是「取消这次下载」——等保存框
 * 结果回来时 DownloadItem 已被销毁，`setSavePath` 抛
 * `DownloadItem used after being destroyed` 又被空 catch 吞掉。
 * 表现就是文件 0 字节、界面一声不响。
 *
 * 现在的规则（不可回退）：
 *   1. 落点必须**同步**确定：保存框用 showSaveDialogSync，落点先钉再放行；
 *   2. 绝不 preventDefault，用户取消时显式 item.cancel()；
 *   3. 每个下载都交给 DownloadManager 记账并推到下载中心；
 *   4. 完成/中断/取消都要有前台提示（失败必须可见）。
 * 隐私分区在 sessions.js 里已整体禁止落盘，这里只补一句看得见的解释。
 */
function installDownloadHandler() {
  if (runtime.downloadHandlerInstalled) return;
  runtime.downloadHandlerInstalled = true;

  const normal = sessions.getSession('normal');
  normal.on('will-download', (event, item) => {
    const filename = sanitizeFilename(item.getFilename ? item.getFilename() : '');
    const url = item.getURL ? item.getURL() : '';
    const pinned = takePendingDownloadPath();
    const prefs = runtime.uiStore ? runtime.uiStore.get() : {};

    let savePath = pinned;
    if (!savePath && prefs.downloadAsk !== false) {
      const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
      const picked = dialog.showSaveDialogSync(win, {
        title: '保存下载内容',
        defaultPath: uniquePath(resolveDownloadDir(), filename),
        buttonLabel: '保存',
      });
      if (!picked) {
        // 用户主动取消：明确 cancel，并且不留下"卡在进行中"的假记录
        try {
          item.cancel();
        } catch {
          /* 已经结束的 item 不用再 cancel */
        }
        if (runtime.diagnostics) {
          runtime.diagnostics.info('DOWNLOAD_CANCELLED_BY_DIALOG', { filename, url: redactUrlForLog(url) });
        }
        return;
      }
      savePath = picked;
    }
    if (!savePath) savePath = uniquePath(resolveDownloadDir(), filename);

    try {
      item.setSavePath(savePath);
    } catch (err) {
      // 设不上落点就别装作下载成功：记日志 + 前台说清
      if (runtime.diagnostics) {
        runtime.diagnostics.error('DOWNLOAD_SET_PATH_FAILED', { filename, savePath, message: err.message });
      }
      notifyNotice({
        level: 'error',
        code: 'DOWNLOAD_SET_PATH_FAILED',
        title: '这个文件存不下来',
        message: `无法把下载保存到「${savePath}」：${err.message}。可以到设置 → 下载里换个保存目录再试。`,
      });
      return;
    }

    const rec = runtime.downloads
      ? runtime.downloads.attach(item, { mode: 'normal', savePath, filename, url })
      : null;

    if (runtime.diagnostics) {
      runtime.diagnostics.info('DOWNLOAD_START', { filename, savePath, url: redactUrlForLog(url), id: rec && rec.id });
    }

    // 下载不是 agent 发起的（页面/链接触发），但它同样要出现在审计面上
    if (runtime.agentDispatcher) {
      runtime.agentDispatcher.observe({
        type: 'download',
        target: filename,
        params: { filename, url, bytes: 0, state: 'progressing' },
        reason: '页面触发的下载（已确认落点后开始）',
        ok: true,
      });
    }

    item.once('done', (_event, state) => {
      const size = formatBytes(item.getReceivedBytes ? item.getReceivedBytes() : 0);
      // 清单 A3：把这一次的时长与平均速度写进诊断日志，用户说"慢"时能直接报数字
      if (runtime.diagnostics) {
        const bytes = rec ? rec.receivedBytes : 0;
        const ms = rec ? rec.durationMs : 0;
        runtime.diagnostics.info('DOWNLOAD_DONE', {
          filename,
          state,
          bytes,
          ms,
          mbps: ms > 0 && bytes > 0 ? Number((bytes / 1024 / 1024 / (ms / 1000)).toFixed(2)) : 0,
        });
      }
      // 下载结束也留一条：审计面要能看出「这个文件最后到底成了没有」
      if (runtime.agentDispatcher) {
        const doneOk = state === DOWNLOAD_STATES.completed;
        runtime.agentDispatcher.observe({
          type: 'download',
          target: filename,
          params: { filename, url, bytes: rec ? rec.receivedBytes : 0, state },
          reason: doneOk ? '下载完成' : rec && rec.error ? rec.error : `下载结束（${state}）`,
          ok: doneOk,
          error: doneOk ? '' : rec && rec.error ? rec.error : `下载结束（${state}）`,
          code: doneOk ? '' : 'DOWNLOAD_FAILED',
          elapsedMs: rec ? rec.durationMs : 0,
        });
      }
      if (state === DOWNLOAD_STATES.completed) {
        const speed = rec && rec.avgBytesPerSec > 0 ? `，平均 ${formatBytes(rec.avgBytesPerSec)}/s` : '';
        notifyNotice({
          level: 'info',
          code: 'DOWNLOAD_COMPLETED',
          title: '下载完成',
          message: `${filename}（${size}${speed}）已保存到 ${savePath}。点工具栏的下载按钮可以看到全部记录。`,
        });
        return;
      }
      const failed = rec ? rec.error : '';
      const text = failed || (state === DOWNLOAD_STATES.cancelled ? '下载已被取消' : '下载中断');
      if (runtime.diagnostics) {
        runtime.diagnostics.warn('DOWNLOAD_FAILED', { filename, savePath, state, error: text });
      }
      notifyNotice({
        level: state === DOWNLOAD_STATES.cancelled ? 'warn' : 'error',
        code: 'DOWNLOAD_FAILED',
        title: state === DOWNLOAD_STATES.cancelled ? '下载已取消' : '下载失败',
        message: `${filename}：${text}。落点 ${savePath}。详情见工具栏「下载」。`,
      });
    });
  });

  // 隐私分区：sessions.js 已 preventDefault 阻止落盘，这里补用户可见的解释
  const privateSession = sessions.getSession('private');
  privateSession.on('will-download', (_event, item) => {
    const filename = sanitizeFilename(item.getFilename ? item.getFilename() : '');
    if (runtime.diagnostics) {
      runtime.diagnostics.warn('DOWNLOAD_BLOCKED_PRIVATE', { filename });
    }
    notifyNotice({
      level: 'warn',
      code: 'DOWNLOAD_BLOCKED_PRIVATE',
      title: '隐私模式不保存文件',
      message: `隐私模式不把下载写到磁盘，所以「${filename}」没有保存。需要这个文件请点模式开关切到普通模式，再重新下载。`,
    });
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

/* ------------------------------------------------------------------ */
/* 外壳防护现值表（清单 C3）                                            */
/* ------------------------------------------------------------------ */

/**
 * 登记一个窗口角色实际使用的 webPreferences。
 *
 * 为什么登记"原始对象"而不是把结论写死：清单要的是"现状表"，而现状只能从
 * 创建窗口的那一行读出来。这样以后有人把 sandbox 改成 false，表格和测试会当场红。
 * @param {string} role WINDOW_ROLES 里的角色名
 * @param {object} prefs 传给 BrowserWindow / WebContentsView 的 webPreferences
 */
function registerSecurityWindow(role, prefs) {
  if (!role) return;
  try {
    runtime.securityWindows.set(role, prefs && typeof prefs === 'object' ? { ...prefs } : {});
  } catch (err) {
    console.warn('[Nyx] 窗口安全开关登记失败：', err.message);
  }
}

/**
 * 扫一遍本地渲染页的 CSP。
 * 只读文件，不启动窗口：这样设置页打开就能看到"哪个页面缺 CSP"。
 */
function scanRendererCsp() {
  const dir = path.join(__dirname, 'renderer');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /\.html$/i.test(name));
  } catch (err) {
    console.warn('[Nyx] 渲染页目录读取失败：', err.message);
    return [];
  }

  const rows = [];
  for (const name of names.sort()) {
    let html = '';
    try {
      html = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (err) {
      rows.push({
        file: `src/renderer/${name}`,
        ok: false,
        found: false,
        policy: '',
        warnings: [`读取失败：${err.message}`],
      });
      continue;
    }
    const verdict = auditCsp(parseCsp(html));
    rows.push({
      file: `src/renderer/${name}`,
      ok: verdict.ok,
      found: verdict.found,
      policy: verdict.policy,
      warnings: verdict.warnings,
    });
  }
  return rows;
}

/**
 * 组装现值表：窗口开关实测值 + CSP 扫描 + preload 暴露面。
 * @returns {Promise<object>}
 */
async function collectSecuritySwitches() {
  const audits = [];
  const notCreated = [];
  for (const declared of SECURITY_WINDOW_ROLES) {
    if (!runtime.securityWindows.has(declared.role)) {
      // 本次启动还没创建过这个窗口（例如浮层只在用到时才建）——如实登记为"没验到"
      notCreated.push({ role: declared.role, label: declared.label, why: declared.why });
      continue;
    }
    audits.push(auditPreferences(declared.role, runtime.securityWindows.get(declared.role)));
  }

  let preloadKeys = [];
  const win = runtime.mainWindow;
  if (win && !win.isDestroyed()) {
    try {
      preloadKeys = await win.webContents.executeJavaScript(
        'Object.keys((window.nyx || window.nyxDownloads || {}))',
        true,
      );
    } catch (err) {
      console.warn('[Nyx] 读取 preload 暴露面失败：', err.message);
      preloadKeys = [];
    }
  }

  const payload = buildSwitchesPayload({
    audits,
    cspFiles: scanRendererCsp(),
    preloadKeys: Array.isArray(preloadKeys) ? preloadKeys : [],
  });
  payload.notCreated = notCreated;
  return payload;
}

/**
 * 注入演示（清单 C3）：在一个与外壳同构的隐藏窗口里真的去拿 require / eval / 改暴露面，
 * 把结果原样报回来。
 *
 * 为什么用真窗口而不是静态分析：静态只能证明"代码里写着 sandbox:false"，
 * 证明不了"渲染进程里真的没有 require"。清单要的是一次真实的拦截。
 */
async function runSecurityProbe() {
  const prefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    // 与外壳保持一致：演示的结论必须适用于真实外壳，不是适用于"更严格的一次性配置"
    sandbox: false,
    spellcheck: false,
  };
  registerSecurityWindow('probe', prefs);

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    webPreferences: prefs,
  });

  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    await win.loadFile(path.join(__dirname, 'renderer', 'security-probe.html'));
    const raw = await win.webContents.executeJavaScript(buildProbeScript(), true);
    const result = describeProbeResult(raw);
    if (result.ok) {
      runtime.diagnostics.info('SECURITY_PROBE_PASSED', result.summary);
    } else {
      runtime.diagnostics.error('SECURITY_PROBE_FAILED', result.summary, {
        failed: (result.failed || []).map((item) => item.name),
      });
    }
    // 注意：ok 表示"演示跑完了"，passed 表示"全都挡住了"——两者不能混用，
    // 否则一个没挡住的注入会看起来像"调用成功"。
    return {
      ok: true,
      passed: result.ok,
      summary: result.summary,
      checks: result.checks,
      failed: result.failed,
      bridgeKeys: result.bridgeKeys,
      bridgeFrozen: result.bridgeFrozen,
      bridgeWriteIgnored: result.bridgeWriteIgnored,
      ranAt: Date.now(),
    };
  } catch (err) {
    runtime.diagnostics.error('SECURITY_PROBE_ERROR', `注入演示没跑起来：${err.message}`);
    return { ok: false, error: `注入演示没跑起来：${err.message}` };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/* ---------------- 录屏 / 被远控检测（清单 C4） ---------------- */

/**
 * 读一次本机进程名列表。
 *
 * 用 PowerShell 的 Win32_Process 拿 Name（不需要完整路径，也不需要管理员权限）。
 * 结果用 Base64(UTF8) 回传，避免控制台代码页把进程名里的中文毁掉。
 * 读不到就返回 `{ state: 'error', error }`——**不能**当成"没有风险"。
 */
function queryProcessNames() {
  return new Promise((resolve) => {
    const command = [
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '$names = @(Get-CimInstance Win32_Process | Select-Object -ExpandProperty Name)',
      '$json = ConvertTo-Json -InputObject $names -Compress',
      '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    ].join('\n');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 12000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ state: 'error', error: `读进程列表失败：${err.message}`, names: [] });
          return;
        }
        const line = String(stdout || '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .pop();
        if (!line) {
          const detail = String(stderr || '').trim();
          resolve({ state: 'error', error: detail ? `读进程列表失败：${detail}` : '读进程列表时没有拿到内容', names: [] });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
          const names = Array.isArray(parsed) ? parsed : [parsed];
          resolve({ state: 'ok', error: '', names: names.map((n) => String(n || '')) });
        } catch (parseErr) {
          resolve({ state: 'error', error: `进程列表解析失败：${parseErr.message}`, names: [] });
        }
      },
    );
  });
}

/**
 * 刷新录屏检测结果（带 5 秒缓存，避免每次切模式都起一次 PowerShell）。
 * @param {{force?: boolean}} [options]
 */
async function refreshScreenWatch(options) {
  const force = Boolean(options && options.force);
  const cached = runtime.screenWatch;
  if (!force && cached && Date.now() - cached.at < 5000) return cached.payload;

  const scanned = await queryProcessNames();
  const payload = screenWatchPayload({
    state: scanned.state,
    names: scanned.names,
    error: scanned.error,
    checkedAt: Date.now(),
  });
  runtime.screenWatch = { at: Date.now(), payload };

  if (payload.level === 'risk') {
    runtime.diagnostics.warn(
      'SCREEN_CAPTURE_ACTIVE',
      `检测到 ${payload.hits.length} 个可能正在录屏/远控的程序：${payload.summary}`,
      { programs: payload.hits.map((hit) => hit.name) },
    );
  } else if (payload.level === 'unknown') {
    runtime.diagnostics.warn('SCREEN_WATCH_UNKNOWN', payload.summary, {});
  }
  return payload;
}

function createMainWindow() {
  const shellPrefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  };
  // 登记到外壳防护现值表（清单 C3）
  registerSecurityWindow('shell', shellPrefs);

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
    webPreferences: shellPrefs,
  });

  const shellUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.loadURL(shellUrl);
  win.once('ready-to-show', () => win.show());

  // 外壳页面就绪：从此提示可以直接推送，同时把加载期间攒下的提示一次补发
  win.webContents.on('did-finish-load', () => {
    runtime.shellReady = true;
    flushPendingNotices(win);
    // 首次安装引导（清单 D2）：外壳能显示之后再开，否则弹在空壳上一个字也没有
    maybeOpenOnboarding();
    // 对抗测试 N4：pushState/replaceState 不触发 will-navigate，却能把 location.origin 改成远端，
    // 之后一次 reload 就会让 Chromium 按远端 origin 处理外壳并终止 renderer。这里把改地址
    // 的入口按"只许同一份文件"焊住（页面脚本每次加载都补一遍，幂等）。
    win.webContents
      .executeJavaScript(buildHistoryGuardScript(shellUrl), true)
      .catch((err) => console.warn('[Nyx] 外壳改地址守卫没能装上：', err && err.message));
  });

  // UI 外壳自身也套用防泄漏策略
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  // UI 外壳中的弹窗一律交给标签系统处理
  win.webContents.setWindowOpenHandler(({ url }) => {
    const verdict = decideShellWindowOpen({ url });
    if (!verdict.allow) {
      diagnostics.warn('SHELL_WINDOW_OPEN_BLOCKED', verdict.reason, {
        code: verdict.code,
        url: redactUrlForLog(url),
      });
      notifyNotice({ level: 'warn', title: '这个链接没有打开', message: verdict.reason });
      return { action: 'deny' };
    }
    openInNewTab(url);
    return { action: 'deny' };
  });

  // 安全审计 P0-1：外壳页面暴露了整份 window.nyx（读 Cookie、读历史、改信任名单、
  // 执行脚本……），所以它只允许待在自己那份文档上。判定在 src/core/shell-guard.js，
  // 这里只做三件事：拒绝、记日志、给用户看得见的提示。
  const blockShellNav = (source) => (event, target) => {
    const verdict = decideShellNavigation({ targetUrl: target, shellUrl });
    if (verdict.allow) return;
    event.preventDefault();
    console.warn(`[Nyx] 外壳导航被拦下（${verdict.code}）：`, target);
    diagnostics.warn('SHELL_NAV_BLOCKED', verdict.reason, {
      code: verdict.code,
      source,
      url: redactUrlForLog(target),
    });
    notifyNotice({
      level: 'warn',
      title: '外壳想跳转到别处，已被拦下',
      message: verdict.reason,
    });
  };
  win.webContents.on('will-navigate', blockShellNav('will-navigate'));
  win.webContents.on('will-redirect', blockShellNav('will-redirect'));
  // 对抗测试 N4 的兜底：pushState 之后 reload 不会走 will-navigate。真有这种事发生，
  // 就把外壳停住、重新加载自己——绝不把窗口留在那个页面上（宁可重开，也不留在错的地方）。
  //
  // 注意：这里看的是**已经落地的地址**（did-navigate / did-navigate-in-page），不是
  // did-start-navigation 的目标地址。用目标地址会在"导航刚开始、will-navigate 正准备拦下它"
  // 时抢先 reload 一次，等于自己把外壳的 CDP 会话打断（界面回归就是这么炸的）。
  const enforceShellStay = (source) => (event, url, second) => {
    if (source === 'did-navigate-in-page' && second === false) return;
    const verdict = decideShellEscape({ targetUrl: url, shellUrl });
    if (!verdict.escaped) return;
    console.warn(`[Nyx] 外壳自己跑到了别处（${verdict.code}），正在把它拉回来：`, url);
    diagnostics.error('SHELL_ESCAPED', '外壳跑到了不该去的地方，已强制重新加载', {
      code: verdict.code,
      url: redactUrlForLog(url),
    });
    try {
      win.webContents.stop();
    } catch (err) { /* 已经在停就算了 */ }
    if (!win.isDestroyed()) win.loadURL(shellUrl);
    notifyNotice({
      level: 'warn',
      title: '外壳被强制重置',
      message: '外壳页面想跑到别的地方，Nyx 把它拉回来了。你的标签页还在。',
    });
  };
  win.webContents.on('did-navigate', enforceShellStay('did-navigate'));
  win.webContents.on('did-navigate-in-page', enforceShellStay('did-navigate-in-page'));
  win.webContents.on('will-attach-webview', (event) => {
    const verdict = describeAttachBlock();
    event.preventDefault();
    diagnostics.warn('SHELL_WEBVIEW_BLOCKED', verdict.reason, { code: verdict.code });
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
    } else if (mod && !input.alt && key === 'j') {
      // Ctrl+J：下载中心（对齐主流浏览器习惯；工具栏也有入口）
      event.preventDefault();
      openDownloads();
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
    // 起始页地址：命中它时按应用页打开（需要外壳 preload 才有 window.nyx）
    homeUrl: HOME_URL,
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
    // 每个视图创建时把角色与真实 webPreferences 登记给外壳防护现值表（清单 C3）
    onSecurityWindow: registerSecurityWindow,
    // 新标签纳入抓包范围，并继承工具箱的 UA / 视口 / 限速设定
    onTabCreated: (tab) => {
      if (runtime.toolbox) runtime.toolbox.syncAll();
      if (runtime.pageTools && tab.view) {
        runtime.pageTools.applySticky(tab.view.webContents).catch((err) => {
          console.warn('[Nyx] 工具箱粘性设置应用失败：', err.message);
        });
      }
      // 安全审计 P0-3：隐私模式下把 UA 与指纹补丁真正下发给**主世界**。
      // 必须在 loadURL 之前完成（标签创建回调就在 loadURL 之前），否则页面脚本先跑一步就白做。
      // 所以这里把一个 Promise 交回去，让 TabManager 等它落地再 loadURL——见 tabs.js 里的
      // "回调返回 Promise 就先等它"。对抗测试 N1 的根因正是"命令发出去了、页面已经先加载了"。
      const surface = attachPrivacySurface(tab);
      // 历史记录：导航提交（主框架）即记账，页面标题就绪后再修正标题
      hookHistoryRecording(tab);
      return surface && typeof surface.then === 'function' ? surface.then(() => undefined, () => undefined) : undefined;
    },
    // 后台标签闲置到点就休眠，释放渲染进程（清单 G）。0 = 关闭休眠。
    // 环境变量只是自动化验证用的旋钮，正常启动就是默认的 30 分钟。
    sleepAfterMs: readTabSleepAfterMs(),
  });

  // 休眠巡检：5 秒一次，判定与执行都在 TabManager 里，这里只负责开起来
  runtime.tabManager.startLifecycle();

  // 设置页里选的休眠时长（清单 G 的后续）：启动时套用，没设过就是默认 30 分钟。
  // 环境变量优先级更高——它是自动化验证的旋钮，不能让用户设置在验证时把它盖掉。
  if (process.env.NYX_TAB_SLEEP_MS === undefined && runtime.uiStore) {
    const savedMinutes = normalizeSleepMinutes(runtime.uiStore.get().tabSleepMinutes);
    const savedMs = runtime.tabManager.setSleepAfterMs(sleepMinutesToMs(savedMinutes));
    console.log(`[Nyx] 标签休眠：${describeSleepMinutes(savedMinutes)}（${savedMs} ms）`);
  }

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
  if (!tab || !tab.view) return;
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

  // 离线缓存：页面加载完成后留一份正文快照，断网时失败页能把"上次读到什么"显示出来。
  // 只在普通模式、只在 http(s)、只在加载成功后抓；抓取失败只记日志（缓存是锦上添花，
  // 不能因为它报错打断正常浏览）。
  wc.on('did-finish-load', () => {
    const url = typeof wc.getURL === 'function' ? wc.getURL() : '';
    if (!isRecordableUrl(url)) return;
    if (wc.isDestroyed()) return;
    // 站点黑白名单（用户第 5 项）：不管普通还是隐私模式，先在入口判一次。
    // 判不缓存就直接不抓——不抓比"抓了再删"更干净，也不会白白花一次网络请求。
    const siteDecision = decideCacheSite(url, cacheSitePolicy());
    if (!siteDecision.cache) {
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PAGE_CACHE_SITE_SKIPPED', {
          url: redactUrlForLog(url),
          layer: siteDecision.layer,
          host: siteDecision.host,
        });
      }
      return;
    }
    wc.executeJavaScript(buildPageCaptureScript(), true)
      .then(async (raw) => {
        if (!raw || raw.ok !== true) return;
        const snapshot = normalizePageCacheSnapshot({
          url: raw.url || url,
          title: raw.title || '',
          // v2 的块结构与图片必须一起带上：早先这里只传了 lines，
          // 结果结构化的标题/列表全被丢掉，快照退化成一堆段落（候选②才发现）。
          blocks: Array.isArray(raw.blocks) ? raw.blocks : [],
          images: Array.isArray(raw.images) ? raw.images : [],
          skippedImages: Number(raw.skippedImages) || 0,
          lines: raw.lines || [],
          at: Date.now(),
        });
        if (!snapshot) return;
        const withImages = await fetchSnapshotImages(snapshot);
        const saved = savePageCache(withImages);
        if (saved && runtime.diagnostics) {
          runtime.diagnostics.info('PAGE_CACHE_SAVED', {
            url: redactUrlForLog(url),
            blocks: withImages.blocks.length,
            images: withImages.images.filter((image) => image && image.dataUrl).length,
          });
        }
      })
      .catch((err) => {
        console.warn('[Nyx] 离线缓存没能抓取这一页：', err && err.message ? err.message : err);
      });
  });
}

/**
 * 给快照补上小图本体（候选②）。
 *
 * 只取 http(s)、只取前 CACHE_IMAGE_FETCH_MAX 张、单张超 CACHE_IMAGE_BYTES_MAX 直接放弃，
 * 合计超过 CACHE_IMAGE_TOTAL_MAX 就停手——剩下的图退回"只有说明文字"。
 * 单张失败不影响正文快照：断网时能读字比有一张图重要。
 */
async function fetchSnapshotImages(snapshot) {
  const targets = imageTargets(snapshot);
  if (!targets.length) return snapshot;
  let total = 0;
  const fetched = [];
  for (const target of targets) {
    try {
      const response = await electronNet.fetch(target, { signal: AbortSignal.timeout(4000) });
      if (!response || !response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > CACHE_IMAGE_BYTES_MAX) continue;
      if (total + buffer.length > CACHE_IMAGE_TOTAL_MAX) break;
      const mime = sniffImageMime(buffer);
      if (!mime || !/^image\//.test(mime)) continue;
      total += buffer.length;
      fetched.push({ src: target, dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, bytes: buffer.length });
    } catch (err) {
      // 取不到就只是没有这张图，不当成缓存失败
      if (runtime.diagnostics) {
        runtime.diagnostics.warn('PAGE_CACHE_IMAGE_SKIPPED', '离线快照里的一张图没能取到，只保留说明文字', {
          error: String(err && err.message ? err.message : err),
        });
      }
    }
  }
  if (!fetched.length) return snapshot;
  return attachImageData(snapshot, fetched) || snapshot;
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
 * 带缓存的代理可达性探测：30 秒内复用上一次结论。
 *
 * 为什么可以复用：切换模式时探一次 TCP 的用途只是"这次能不能走代理"，
 * 30 秒内同一台机器的同一个端口不会自己变；用户在这 30 秒里把代理关掉，
 * 最坏结果是这一次切换按"可达"进去、页面自己报连不上（日志会写清是复用的）。
 *
 * @param {{host?:string, port?:number, timeout?:number, force?:boolean}} [options]
 * @returns {Promise<{reachable:boolean, host:string, port:number, latencyMs:number, error:null|string, reused?:boolean}>}
 */
async function probeProxyCached(options = {}) {
  const host = options.host || sessions.PROXY_HOST;
  const port = options.port || sessions.getProxyPort();
  const key = `${host}:${port}`;
  const cached = runtime.switchCache && runtime.switchCache.proxy;
  if (!options.force && cached && cached.value && cached.value.key === key) {
    const hit = readTimed(cached, Date.now(), PROXY_PROBE_TTL_MS);
    if (hit.hit) {
      return { ...hit.value.probe, reused: true };
    }
  }
  const probe = await isProxyReachable(options);
  if (runtime.switchCache) {
    runtime.switchCache.proxy = writeTimed({ key, probe }, Date.now());
  }
  return probe;
}

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

/**
 * 「隐私模式的出站方式」两种取值的对外说明（清单 B3）。
 *
 * 前端与本地接口共用这一份文案：`lost` 是选择「真实 IP」后会失去的保护，
 * 设置页原样展示，避免两处文案各说一套。
 */
const PRIVACY_LINK_OPTIONS = [
  {
    value: 'proxy',
    label: '经代理',
    summary: '出站流量强制走本机代理，站点看不到你的真实公网 IP。',
    lost: [],
  },
  {
    value: 'direct',
    label: '真实 IP（直连）',
    summary: '不经过代理，直接用本机网络出口访问站点。',
    lost: [
      '真实公网 IP 会直接暴露给访问的每一个站点',
      '代理层的位置伪装失效，出口地区与站点看到的地理位置不再一致',
      '站点可以据此把你的这次访问与其他网络行为关联起来',
      '本机仍然不落盘历史与缓存，但「不留痕」只对本机成立',
    ],
  },
];

/** 隐私模式按「真实 IP」进入时的前台提示：把失去的保护逐条说清 */
function buildRealIpNotice() {
  return {
    level: 'warn',
    code: 'PRIVACY_REAL_IP',
    title: '隐私模式已开启，但出站是真实 IP',
    message:
      '你在「设置 → 隐私与安全」里选择了「真实 IP（直连）」，所以本次隐私模式不经过代理，' +
      '访问的站点可以看到你的真实公网 IP。本机仍然不写历史、不保存缓存与 Cookie。' +
      '需要隐藏 IP 时，请关闭隐私模式，或在设置里改回「经代理」并确认本机代理可用。',
  };
}

/**
 * 向渲染层推送用户可见提示；页面未就绪时入队，等 did-finish-load 后按顺序补发。
 *
 * 只判 isDestroyed 是不够的：主窗口对象早就存在，但外壳页面（renderer.js）
 * 还没执行到注册 nyx:notice 监听那一刻，此时 send 出去的提示谁都不会收到。
 */
function notifyNotice(notice) {
  if (!notice) return;
  const win = runtime.mainWindow;
  if (!win || win.isDestroyed() || !runtime.shellReady) {
    runtime.pendingNotices.push(notice);
    return;
  }
  win.webContents.send('nyx:notice', notice);
}

/** 外壳页面就绪后补发所有排队的提示（FIFO，避免"最后一条覆盖前面几条"） */
function flushPendingNotices(win) {
  const queue = runtime.pendingNotices.slice();
  runtime.pendingNotices = [];
  runtime.pendingNotice = null;
  for (const notice of queue) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('nyx:notice', notice);
  }
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
 * 模式切换动画窗口：一个盖在主窗口上的透明子窗口。
 *
 * 为什么必须是独立窗口：页面内容是 WebContentsView，原生视图永远画在外壳 DOM 之上，
 * 在外壳里做全屏动画会被视图盖住（「更多」菜单那次就是这个坑）。
 *
 * 这个窗口不加载任何远端内容、不注入 preload、不接受鼠标与键盘（focusable:false +
 * setIgnoreMouseEvents），画完由主进程按 duration 收掉；失败只留诊断，绝不影响切换本身。
 */
let transitionWindow = null;
let transitionTimer = null;

/**
 * 进 / 出两个动画的时长（毫秒）。
 * 用户要求「延长到 5 秒」：两个都按 5000 走；上限仍要卡住，
 * 否则一旦传进来一个荒谬的数字，窗口会挂很久。
 */
const TRANSITION_ENTER_MS = 1000;
const TRANSITION_EXIT_MS = 1000;
const TRANSITION_MAX_MS = 6000;

function modeTransitionEnabled() {
  if (!runtime.uiStore) return true;
  return runtime.uiStore.get().modeTransition !== false;
}

function closeModeTransition() {
  if (transitionTimer) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }
  const win = transitionWindow;
  transitionWindow = null;
  if (!win) return;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* 忽略：已经没了 */
  }
}

/**
 * 显示一次切换动画。
 * @param {'enter'|'exit'} kind enter＝像素感染（进隐私），exit＝牛奶桶（回普通）
 */
function showModeTransition(kind) {
  if (!modeTransitionEnabled()) return;
  const parentWindow = runtime.mainWindow;
  if (!parentWindow || parentWindow.isDestroyed()) return;
  if (!parentWindow.isVisible()) return;

  closeModeTransition();

  const duration = kind === 'exit' ? TRANSITION_EXIT_MS : TRANSITION_ENTER_MS;
  const bounds = parentWindow.getBounds();
  const prefs = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  registerSecurityWindow('transition', prefs);

  try {
    const win = new BrowserWindow({
      parent: parentWindow,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: prefs,
    });
    transitionWindow = win;
    win.setIgnoreMouseEvents(true, { forward: false });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // showInactive：绝不能把焦点从地址栏抢走（与建议浮层同一套理由）
      win.showInactive();
    });
    win.on('closed', () => {
      if (transitionWindow === win) transitionWindow = null;
    });

    const bucket = pathToFileURL(path.join(__dirname, 'renderer', 'assets', 'milk-bucket.webp')).href;
    const query = { kind, duration: String(duration), bucket };

    win.loadFile(path.join(__dirname, 'renderer', 'transition.html'), { query }).catch((err) => {
      diagnostics.warn('MODE_TRANSITION_FAILED', '切换动画没能显示（不影响切换本身）', {
        error: err && err.message,
      });
      closeModeTransition();
    });

    // 兜底：页面自己不会关窗口，到点由主进程收；多给 420ms 让最后一帧画完
    transitionTimer = setTimeout(closeModeTransition, duration + 420);
    if (typeof transitionTimer.unref === 'function') transitionTimer.unref();
  } catch (err) {
    transitionWindow = null;
    diagnostics.warn('MODE_TRANSITION_FAILED', '切换动画没能显示（不影响切换本身）', {
      error: err && err.message,
    });
  }
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

  // 切换耗时记账：每一步都记下来，最后拼成一句话写进日志与诊断。
  // 目的不是好看，而是"下次说切换慢"时能直接指到是哪一步慢（报告里实测约 8 秒）。
  const switchT0 = Date.now();
  const switchSteps = [];
  const trackStep = async (stepName, run) => {
    const started = Date.now();
    const value = await run();
    switchSteps.push({ step: stepName, ms: Date.now() - started });
    return value;
  };

  if (next === current) {
    return { ok: true, state: currentSnapshot() };
  }

  // 进入隐私模式前的前置校验；切回普通模式则重探一次链路
  if (next === 'private') {
    // 清单 C4：进隐私模式前先看一眼「屏幕是不是正被别人看着」。
    // 顺序有意为之：录屏/被远控在这件事上比出口链路更根本——链路再干净，画面被录也一样泄露。
    const screenCheck = await refreshScreenWatch({});
    const screenGate = canEnterPrivate(
      { level: screenCheck.level },
      { ack: Boolean(runtime.screenAckAt), ackAt: runtime.screenAckAt },
    );

    if (!screenGate.ok) {
      const risky = screenCheck.level === 'risk';
      const stale = screenGate.reason === 'ack-stale';
      const notice = {
        level: 'error',
        code: risky ? 'SCREEN_CAPTURE_ACTIVE' : 'SCREEN_WATCH_UNCONFIRMED',
        title: risky ? '检测到录屏 / 远控，已拒绝进入隐私模式' : '无法确认是否在录屏，已暂停切换',
        message:
          screenCheck.message +
          (stale ? '（上一次"确认没有录屏"已经超过 10 分钟，需要重新确认。）' : '') +
          '（详情可在「设置 → 隐私与安全 → 录屏与被远控检测」里查看。）',
      };
      console.warn(`[Nyx] 拒绝进入隐私模式：${notice.title}（${screenGate.reason}）`);
      diagnostics.warn(notice.code, screenCheck.summary, {
        level: screenCheck.level,
        reason: screenGate.reason,
        programs: (screenCheck.hits || []).map((hit) => hit.name),
      });
      modeEventLog.record({
        type: 'switch',
        from: current,
        to: 'private',
        changed: false,
        ok: false,
        code: notice.code,
        message: screenCheck.summary,
      });
      notifyNotice(notice);
      return {
        ok: false,
        code: notice.code,
        error: notice.message,
        needAck: screenCheck.level === 'unknown',
        screenWatch: screenCheck,
        state: currentSnapshot(),
      };
    }

    // 清单 B3：用户在设置里显式选择「真实 IP」→ 不探测代理、不拉内核，直接直连进入。
    // 这条路必须留足痕迹（前台提示 + 诊断 + 模式事件），因为此刻隐私模式并不隐藏 IP。
    const wantRealIp = Boolean(runtime.uiStore && runtime.uiStore.get().privacyLink === 'direct');

    if (wantRealIp) {
      sessions.setLink('private', 'direct', { allowRealIp: true });

      try {
        await sessions.whenSessionReady('private');
      } catch (err) {
        const notice = {
          level: 'error',
          code: err.code || 'PRIVACY_LINK_APPLY_FAILED',
          title: '没能按「真实 IP」进入隐私模式',
          message:
            `隐私分区没有接受直连配置（${err.message}）。` +
            '本次切换已被拒绝，当前模式保持不变。' +
            '可以在「设置 → 隐私与安全 → 隐私模式的出站方式」里改回「经代理」后重试。',
        };
        console.warn('[Nyx] 拒绝进入隐私模式：真实 IP 链路下发失败 ——', err.message);
        diagnostics.error('PRIVACY_REAL_IP_APPLY_FAILED', { error: err.message });
        notifyNotice(notice);
        return {
          ok: false,
          code: notice.code,
          error: notice.message,
          state: currentSnapshot(),
        };
      }

      const notice = buildRealIpNotice();
      console.warn('[Nyx] 已按用户设置以真实 IP 直连进入隐私模式（出站不经代理）');
      diagnostics.warn('PRIVACY_REAL_IP_ENTERED', {});
      modeEventLog.record({
        type: 'switch',
        from: current,
        to: 'private',
        changed: true,
        ok: true,
        code: 'PRIVACY_REAL_IP',
        message: '按用户设置在隐私模式下直连（真实 IP）',
      });
      notifyNotice(notice);
    } else {
      // 隐私必须经代理：内核没跑且用户允许自启时，先按需拉起，避免"内核没开所以进不去"
      await ensureProxyKernelForPrivate();

      let probeStarted = Date.now();
      const probe = recordProbe(await probeProxyCached());
      switchSteps.push({ step: '探代理', ms: Date.now() - probeStarted, reused: Boolean(probe.reused) });

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
    }
  } else {
    // 切回普通模式：不做拦截，只重探一次决定走代理还是直连
    const probeStarted = Date.now();
    const probe = recordProbe(await probeProxyCached());
    switchSteps.push({ step: '探代理', ms: Date.now() - probeStarted, reused: Boolean(probe.reused) });
    normalLinkOnEnter = probe.reachable ? 'proxy' : 'direct';
    console.log(
      `[Nyx] 切回普通模式｜出站链路预判：${
        normalLinkOnEnter === 'proxy' ? `代理 ${probe.host}:${probe.port}（可达）` : '直连（代理不可达）'
      }`,
    );
  }

  // 0. 收起地址栏建议浮层：模式一旦切换，历史建议的可用性随之改变（隐私模式不出建议）
  closeAddressSuggest();

  // 0.5 切换动画：校验全部通过、真的要动了才开始画。
  //     进隐私＝像素感染（盖住等待过程），回普通＝牛奶桶（盖住解冻与挂回）。
  //     关掉动画的人在设置里关，这里就不起窗口——切换本身完全不受影响。
  if (next === 'private') showModeTransition('enter');
  else if (current === 'private') showModeTransition('exit');

  // 1. 处理旧标签——方向很关键：
  //    · 进隐私：普通标签「停靠」（保状态），之后建私密标签。
  //    · 回普通：私密标签必须**销毁**，绝不能停靠——停靠了就等着被第 4 步挂回普通标签栈，
  //      等于把私密页面搬进普通模式（审计实测的 P0）。停靠的普通标签由第 4 步挂回。
  const leavingPrivate = current === 'private';
  const parked = await trackStep(leavingPrivate ? '销毁私密标签' : '停靠普通标签', async () => {
    if (!runtime.tabManager) return { parked: 0, dropped: 0, droppedUrls: [] };
    if (leavingPrivate) {
      runtime.tabManager.destroyAll();
      return { parked: 0, dropped: 0, droppedUrls: [] };
    }
    return typeof runtime.tabManager.parkAll === 'function'
      ? runtime.tabManager.parkAll()
      : { parked: 0, dropped: 0, droppedUrls: [] };
  });

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
    // 退出后把隐私分区链路复位成代理：否则「真实 IP」会残留到下一次进入，
    // 让下一次进去的人（甚至另一个使用这台机器的人）在不知情的情况下直连。
    if (sessions.getLink('private') === 'direct') {
      sessions.setLink('private', 'proxy');
    }
    console.log('[Nyx] 已退出隐私模式，隐私分区痕迹已清空');
  }

  // 3.5 隐私加固装配 / 复位。
  //     必须落在"重建标签"之前：标签创建时就要带上当前模式的 preload 参数与
  //     WebRTC 策略，晚一步首个标签就会跑在上一轮的 profile 上（等于用旧指纹上站）。
  if (next === 'private') {
    const applied = await trackStep('装配加固', applyPrivacyHardening);

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

  // 4. 回到普通模式时先把停靠的标签挂回来（页面状态还在），没有可挂的才开新标签；
  //    进隐私模式则老老实实开一个隐私标签（停靠着的普通标签继续躺着，联网但不走代理）。
  const restored = await trackStep('挂回/建标签', async () => {
    if (!runtime.tabManager) return { restored: 0 };
    if (next === 'normal' && typeof runtime.tabManager.restoreParked === 'function') {
      const result = runtime.tabManager.restoreParked();
      if (result.restored > 0) return result;
    }
    runtime.tabManager.create(HOME_URL);
    return { restored: 0 };
  });

  // 超出预算被降级的标签必须让用户知道：页面状态确实丢了，不能装没事。
  if (parked && parked.dropped > 0) {
    notifyNotice({
      level: 'warn',
      code: 'TABS_DROPPED_ON_SWITCH',
      title: `有 ${parked.dropped} 个标签没能保住页面状态`,
      message:
        `切模式时最多保住 ${runtime.tabManager ? runtime.tabManager.maxParked || 12 : 12} 个标签的页面状态，` +
        '超出的这几个只会记住地址，恢复时需要重新打开（填写的内容与滚动位置会丢）。',
    });
    diagnostics.warn('TABS_DROPPED_ON_SWITCH', '切模式时部分标签只记住了地址', {
      dropped: parked.dropped,
      kept: parked.parked,
      urls: (parked.droppedUrls || []).slice(0, 10),
    });
  }

  const timing = describeTiming(switchSteps, Date.now() - switchT0);
  console.log(`[Nyx] 模式切换完成｜${next === 'private' ? '隐私' : '普通'}模式｜${timing.text}`);
  diagnostics.info('MODE_SWITCH_TIMING', timing.text, {
    from: current,
    to: next,
    totalMs: timing.totalMs,
    steps: switchSteps,
  });
  return { ok: true, state: currentSnapshot(), timing };
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

/* ---------------- 首次安装引导（清单 D2） ----------------
   判定只看安装器写的「首次安装」标记，不看"有没有配置文件"：
   老用户升级上来同样没有这个标记，用猜的就会把老用户领进引导。 */
function onboardMarkerPath() {
  return userDataFile(ONBOARD_MARKER_FILE);
}

function readOnboardMarker() {
  try {
    // 必须剥 BOM：安装器 / 别的工具写这个文件时可能带 BOM，而 JSON.parse 见到 \uFEFF
    // 直接抛错。以前这条错被当成"没有标记"吞掉——结果就是**引导永远不弹**，
    // 用户只在 console 里看到一句"读不懂"。（readManifest 早就这么做了，这里补齐。）
    const raw = JSON.parse(fs.readFileSync(onboardMarkerPath(), 'utf8').replace(/^\uFEFF/, ''));
    return normalizeOnboardMarker(raw);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn('[Nyx] 首次安装标记读不懂，按"没有标记"处理：', err.message);
      diagnostics.warn('ONBOARD_MARKER_READ_FAILED', '首次安装标记读不出来', { code: err.code || '' });
    }
    return null;
  }
}

function writeOnboardMarker(patch) {
  const current = readOnboardMarker() || { pending: false, doneAt: 0, skipped: false, installedAt: 0, version: '' };
  const next = Object.assign({}, current, patch || {});
  if (next.doneAt && !next.installedAt) next.installedAt = next.doneAt;
  try {
    fs.writeFileSync(onboardMarkerPath(), JSON.stringify(Object.assign({ version: app.getVersion() }, next), null, 2));
    return { ok: true };
  } catch (err) {
    console.warn('[Nyx] 首次安装标记写不进去：', err.message);
    diagnostics.error('ONBOARD_MARKER_SAVE_FAILED', '首次安装标记没能写入磁盘', { code: err.code || '' });
    return { ok: false, error: err.message };
  }
}

function shouldShowOnboarding() {
  const forced = process.env.NYX_ONBOARD === '1';
  const plan = planOnboarding({ marker: readOnboardMarker(), force: forced });
  if (plan.show) console.log(`[Nyx] 首次安装引导：${plan.reason}`);
  else if (forced) console.warn(`[Nyx] 首次安装引导没弹出来：${plan.reason}`);
  return plan;
}

function maybeOpenOnboarding() {
  if (runtime.onboardWindow && !runtime.onboardWindow.isDestroyed()) return;
  const plan = shouldShowOnboarding();
  if (!plan.show) return;
  openOnboardingWindow();
}

function openOnboardingWindow() {
  if (runtime.onboardWindow && !runtime.onboardWindow.isDestroyed()) {
    runtime.onboardWindow.focus();
    return runtime.onboardWindow;
  }
  const prefs = {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  };
  registerSecurityWindow('onboarding', prefs);

  const win = new BrowserWindow({
    width: 760,
    height: 620,
    minWidth: 680,
    minHeight: 520,
    show: false,
    title: '欢迎使用 Nyx',
    backgroundColor: '#141110',
    autoHideMenuBar: true,
    webPreferences: prefs,
  });
  runtime.onboardWindow = win;

  // 引导窗口只加载本地页面，不许开新窗口、不许导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file://')) event.preventDefault();
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    runtime.onboardWindow = null;
  });

  win.loadFile(path.join(__dirname, 'renderer', 'onboard.html'));
  return win;
}

/* ------------------------------------------------------------------ */
/* IPC 发送方校验（安全审计 P1-5）                                     */
/* ------------------------------------------------------------------ */

const RENDERER_FILE_PREFIX = pathToFileURL(`${path.join(__dirname, 'renderer')}${path.sep}`).href;

/**
 * 这几个通道的调用方本来就是"网页里的 preload"（密码库、表单记忆、标签配置），
 * 所以不能按"只认 renderer/ 下的 file:// 页面"去卡；但它们仍然只接受最外层文档，
 * 且 vault/forms 自己还会按 origin 隔离（那是第二层）。
 */
const PAGE_CONTEXT_CHANNELS = new Set([
  'nyx:tab:config',
  'nyx:vault:has',
  'nyx:vault:fill',
  'nyx:forms:save',
  'nyx:forms:load',
]);

function checkIpcSender(event, channel) {
  const frame = event && event.senderFrame ? event.senderFrame : null;
  const url = frame && typeof frame.url === 'string' ? frame.url : '';
  const isMainFrame = !frame || frame.parent == null;
  if (PAGE_CONTEXT_CHANNELS.has(channel)) {
    if (!isMainFrame) {
      return {
        ok: false,
        code: 'SENDER_NOT_MAIN_FRAME',
        error: '这个请求来自嵌入的子框架，已拒绝（Nyx 只接受最外层页面的请求）。',
      };
    }
    return { ok: true };
  }
  const verdict = decideIpcSender({ url, isMainFrame, allowedPrefix: RENDERER_FILE_PREFIX });
  if (!verdict.ok) return verdict;
  return { ok: true };
}

/**
 * 把 ipcMain 的三个注册口包一层：所有 handler 先过发送方校验。
 * 用包装而不是"逐个 handler 手写检查"，是因为逐个写一定会漏（本项目已经有一百多个通道）。
 */
function installIpcSenderGuard() {
  if (runtime.ipcGuardInstalled) return;
  runtime.ipcGuardInstalled = true;
  const rawHandle = ipcMain.handle.bind(ipcMain);
  const rawOn = ipcMain.on.bind(ipcMain);
  const rawOnce = ipcMain.once.bind(ipcMain);

  const deny = (channel, verdict) => {
    console.warn(`[Nyx] IPC 请求被拦下（${channel}，${verdict.code}）`);
    try {
      diagnostics.warn('IPC_SENDER_BLOCKED', verdict.error || '发送方不可信，已拒绝', {
        channel,
        code: verdict.code,
      });
    } catch {
      /* 诊断没准备好也不影响拦截 */
    }
    return { ok: false, code: verdict.code, error: verdict.error };
  };

  ipcMain.handle = (channel, listener) =>
    rawHandle(channel, (event, ...args) => {
      const verdict = checkIpcSender(event, channel);
      if (!verdict.ok) return deny(channel, verdict);
      return listener(event, ...args);
    });

  const wrapEvented = (raw) => (channel, listener) =>
    raw(channel, (event, ...args) => {
      const verdict = checkIpcSender(event, channel);
      if (!verdict.ok) {
        // sendSync 必须回填 returnValue，否则发送方会一直等
        if (event && event.returnValue === undefined) event.returnValue = deny(channel, verdict);
        else deny(channel, verdict);
        return;
      }
      listener(event, ...args);
    });

  ipcMain.on = wrapEvented(rawOn);
  ipcMain.once = wrapEvented(rawOnce);
}

function registerIpc() {
  installIpcSenderGuard();
  /* ---------------- 首次安装引导（清单 D2） ---------------- */  ipcMain.handle('nyx:onboard:state', () => ({
    ok: true,
    steps: ONBOARD_STEPS,
    defaults: DEFAULT_ONBOARD_CHOICES,
    themes: THEME_CHOICES,
    densities: DENSITY_CHOICES,
    startPages: START_CHOICES,
    identities: netTerms.describeIdentities(),
    current: runtime.uiStore ? runtime.uiStore.get() : {},
  }));

  ipcMain.handle('nyx:onboard:finish', (_event, input) => {
    const payload = input && typeof input === 'object' ? input : {};
    const plan = planOnboardChoices(payload.choices, { defaults: DEFAULT_ONBOARD_CHOICES });
    if (plan.ok !== true) {
      diagnostics.warn('ONBOARD_CHOICES_REJECTED', '首次引导里的选择不合法', { error: plan.error });
      return { ok: false, error: plan.error };
    }
    const failed = [];
    for (const entry of plan.entries) {
      const res = runtime.uiStore ? runtime.uiStore.set(entry.key, entry.value) : { ok: false, error: '界面偏好还没就绪' };
      if (!res.ok) failed.push(`${entry.key}：${res.error}`);
    }
    const summary = summarizeOnboardChoices({ ok: true, entries: plan.entries, notes: plan.notes });
    writeOnboardMarker({
      pending: false,
      doneAt: Date.now(),
      skipped: payload.skipAll === true,
    });
    diagnostics.info('ONBOARD_FINISHED', payload.skipAll === true ? '首次引导：一键全部默认' : '首次引导：走完设置', {
      entries: plan.entries.length,
      skipped: payload.skipAll === true,
      failed: failed.length,
    });
    if (runtime.onboardWindow && !runtime.onboardWindow.isDestroyed()) {
      runtime.onboardWindow.close();
      runtime.onboardWindow = null;
    }
    if (failed.length) {
      // 有条目没写进去也要如实说，不能"看起来走完了"
      return { ok: false, error: `有 ${failed.length} 项没能保存：${failed.join('；')}`, summary, applied: plan.entries.length - failed.length };
    }
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) runtime.mainWindow.focus();
    return { ok: true, summary, applied: plan.entries.length, notes: plan.notes };
  });

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

  // 起始页（清单 B1）里输入/点格子：开普通标签，并把那个起始页标签收掉，
  // 不让它留在标签栏里当"空白尾巴"。
  ipcMain.handle('nyx:start:open', (_event, payload) => {
    const input = payload && payload.input;
    return openFromStartPage(input);
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

  /* ---------------------------------------------------------------- */
  /* 诊断（清单 C1）                                                    */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('nyx:diagnostics:status', () => diagnostics.status());

  ipcMain.handle('nyx:diagnostics:list', (_event, limit) => diagnostics.list(limit));

  ipcMain.handle('nyx:diagnostics:clear', () => diagnostics.clear());

  ipcMain.handle('nyx:diagnostics:open-folder', async () => {
    try {
      fs.mkdirSync(diagnostics.logDir, { recursive: true });
      const error = await shell.openPath(diagnostics.logDir);
      if (error) return { ok: false, error };
      return { ok: true, path: diagnostics.logDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /**
   * 导出诊断包。
   *
   * 默认弹系统保存对话框（用户要能自己选放哪，这也是清单「导出诊断包」的本意）；
   * 传了 payload.path 就直接写那个路径，供自动化验收用。
   */
  ipcMain.handle('nyx:diagnostics:export', async (_event, payload) => {
    const options = payload || {};
    let destPath = options.path ? path.resolve(String(options.path)) : '';

    if (destPath) {
      // 安全审计 P2：自动化通道只许写进"用户自己也会用的地方"（下载目录/临时目录）。
      // 以前这里接受任意绝对路径 —— 一个被诱导的界面就能把诊断包写到启动目录之类的位置。
      const allowedRoots = ['downloads', 'temp']
        .map((name) => {
          try {
            return path.resolve(app.getPath(name));
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      const inside = allowedRoots.some((root) => {
        const rel = path.relative(root, destPath);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!inside) {
        return {
          ok: false,
          code: 'EXPORT_PATH_NOT_ALLOWED',
          error: `诊断包只能导出到「下载」或「临时」目录（当前请求写到 ${destPath}）。手动导出时请在保存对话框里选位置。`,
        };
      }
      if (!/\.zip$/i.test(destPath)) {
        return { ok: false, code: 'EXPORT_BAD_EXTENSION', error: '诊断包必须是 .zip 文件。' };
      }
    }

    if (!destPath) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const result = await dialog.showSaveDialog(runtime.mainWindow || undefined, {
        title: '导出 Nyx 诊断包',
        defaultPath: path.join(app.getPath('downloads'), `Nyx-诊断包-${stamp}.zip`),
        filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      destPath = result.filePath;
    }

    try {
      const bundle = diagnostics.exportBundle(destPath);
      diagnostics.info('DIAG_EXPORT', `诊断包已导出：${path.basename(destPath)}`, {
        bytes: bundle.bytes,
        entries: bundle.entries,
      });
      return bundle;
    } catch (err) {
      diagnostics.error('DIAG_EXPORT_FAILED', `诊断包导出失败：${err.message}`, { stack: err.stack });
      return { ok: false, error: err.message };
    }
  });

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
      }).catch((err) => {
        console.warn('[Nyx] 置顶后重排建议失败：', err && err.message);
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

  // 主界面加载失败页（A4）：重试 / 跳诊断 / 复制详情
  registerErrorPageIpc();
  // 离线阅读缓存的开关与清理（候选③）
  registerOfflineCacheIpc();
  registerDownloadsIpc();
  // agent 审计面与急停（D）
  registerAgentAuditIpc();
  registerAgentSitesIpc();
  registerAgentModeIpc();
  registerAgentDocIpc();
  registerDigestIpc();
  registerAgentSettingsIpc();

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

/**
 * 从 IPC 参数里取来源标识（站点 origin），并做长度与格式收敛。
 *
 * 有 `event` 时**以发送方文档的 url 为准**，不信 payload 里自称的 origin：
 * 页面脚本能随便写 payload.origin，但改不了自己文档的地址（对抗测试 P1-5 的缺口）。
 * 拿不到 event（内部调用）才退回 payload。
 */
function safeOrigin(payload, event) {
  const frame = event && event.senderFrame ? event.senderFrame : null;
  const frameUrl = frame && typeof frame.url === 'string' ? frame.url : '';
  let origin = '';
  if (frameUrl) {
    try {
      const parsed = new URL(frameUrl);
      origin = parsed.protocol === 'file:' ? '' : parsed.origin;
    } catch (err) {
      origin = '';
    }
  }
  if (!origin && payload && payload.origin) origin = String(payload.origin).trim();
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
  return {
    ok: true,
    decisions: manager.list(size),
    summary: manager.summary(),
    whitelist: manager.whitelistEntries(),
    whitelistError: manager.whitelistError || '',
  };
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

  /* ---------------- 隐私自检（1.18.0，本地判定，不联网） ---------------- */

  /**
   * 跑一次自检：把"现在伪装成什么样、哪些测不到"判成一张表。
   *
   * 真实值一律由主进程给（核数、主显示器、显卡名、系统语言、默认 UA）：
   * 页面自己报的值只能当观察值，**永远不许拿来当真实值**——那等于自问自答，
   * 报告会漂亮得像"全部已伪装"，实际什么也没证明。
   */
  ipcMain.handle('nyx:privacy:check', async () => {
    const startedAt = Date.now();
    const notes = [];
    const rows = [];
    // `ctx.mode` 传下去：同样的差异在两种模式下含义相反（普通模式下不一致 = 泄漏，
    // 隐私模式下不一致 = 已伪装），判定函数需要知道自己在哪个模式里。
    const ctx = { mode: sessions.getMode() === 'private' ? 'private' : 'normal' };
    const push = (id, observedValue, truth) => rows.push(privacyCheck.judgeItem(id, observedValue, truth, ctx));

    const tab = runtime.tabManager ? runtime.tabManager.active : null;
    const webContents = tab && tab.view ? tab.view.webContents : null;
    let observed = null;

    if (webContents && !webContents.isDestroyed()) {
      try {
        // 观测脚本本身返回 Promise（音频要渲染、WebRTC 要等候选），这里再兜一道总超时：
        // 任何一步卡住都不许把设置页 init() 一起拖死。
        observed = await Promise.race([
          webContents.executeJavaScript(privacyCheck.buildObserverScript(), true),
          new Promise((resolve) => setTimeout(() => resolve(null), PRIVACY_CHECK_TIMEOUT_MS)),
        ]);
      } catch (err) {
        notes.push(`页面观测没跑完：${err.message}`);
      }
    } else {
      notes.push('当前没有可用的标签页，身份与图像的观察值都取不到。');
    }

    const seen = observed && typeof observed === 'object' ? observed : {};
    if (!observed) notes.push('这一轮只判了能判的项，页面里测得到的东西下次再跑。');

    // 真实值：能拿到就给，拿不到就是 null（判成"测不到"，不许猜）
    const cores = (() => {
      try {
        const list = nodeOs.cpus();
        return Array.isArray(list) && list.length > 0 ? list.length : null;
      } catch (err) {
        return null;
      }
    })();

    const display = (() => {
      try {
        const primary = screen.getPrimaryDisplay();
        const size = primary && (primary.size || primary.bounds) ? primary.size || primary.bounds : null;
        if (!size) return null;
        return { width: size.width, height: size.height, scaleFactor: Number(primary.scaleFactor) || 1 };
      } catch (err) {
        return null;
      }
    })();

    const realLanguages = (() => {
      try {
        const list = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages() : [];
        return Array.isArray(list) && list.length > 0 ? list.join(',') : null;
      } catch (err) {
        return null;
      }
    })();

    let gpuTruth = null;
    try {
      const hardware = await Promise.race([
        getHardwareStatus(),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      const device = hardware && hardware.gpu ? String(hardware.gpu.device || '') : '';
      if (device) gpuTruth = device;
      else notes.push('显卡名没读出来（GPU 探测超时），显卡那一项只能算测不到。');
    } catch (err) {
      notes.push('显卡名没读出来（GPU 探测失败），显卡那一项只能算测不到。');
    }

    push('A1', { ua: seen.ua || '' }, app.userAgentFallback || null);
    push('A2', { uaPlatform: seen.uaPlatform, chPlatform: seen.chPlatform, chVersion: seen.chVersion, uaFullVersion: seen.uaFullVersion }, null);
    push('A3', { languages: seen.languages || [] }, realLanguages);
    push('A4', { timezone: seen.timezone, offsetMinutes: seen.offsetMinutes, languages: seen.languages || [] }, null);
    push('A5', { cores: seen.cores }, cores);
    push('A6', { width: seen.width, height: seen.height, dpr: seen.dpr }, display);
    push('B1', { vendor: seen.vendor, renderer: seen.renderer }, gpuTruth);
    push('B2', { hashA: seen.hashA, hashB: seen.hashB }, null);
    // 音频没有"本机真实值"可对：没采集到就老老实实测不到。
    push('B3', { sum: seen.audioSum === null || seen.audioSum === undefined ? '' : String(seen.audioSum) }, null);
    push('C1', { candidates: seen.webrtcCandidates || [] }, null);
    push('C2', { address: currentEgressAddress() }, sessions.getLink() === 'proxy' ? currentEgressAddress() : null);
    push('C3', null, null);

    try {
      const watch = screenWatchPayload();
      push('D1', { detected: Boolean(watch && watch.detected) }, null);
    } catch (err) {
      push('D1', null, null);
    }
    push('D2', { blocked: PRIVATE_MODE_AGENT_BLOCKED.has('readPage') }, null);
    try {
      const baseline = baselineFor('normal') || {};
      const allowed = Object.keys(baseline).filter((key) => baseline[key] === 'allow');
      push('D3', { allowed, known: true }, null);
    } catch (err) {
      push('D3', { allowed: [], known: false }, null);
    }
    const cache = privateCacheDecision();
    push('D4', { enabled: runtime.uiStore ? runtime.uiStore.get().privateSnapshotEnabled !== false : true, encrypted: cache.mode === 'encrypted' }, null);

    const meta = {
      version: app.getVersion(),
      electron: process.versions.electron || '',
      chromium: process.versions.chrome || '',
      at: new Date().toISOString(),
      identity: buildPrivacyStatus().identityLabel || (sessions.getMode() === 'private' ? '隐私' : '普通'),
      kernelRunning: Boolean(runtime.proxyKernel && runtime.proxyKernel.running),
    };
    const summary = privacyCheck.summarize(rows);
    const report = privacyCheck.buildReport(rows, meta);
    const reportJson = privacyCheck.buildReportJson(rows, meta);
    const elapsedMs = Date.now() - startedAt;
    console.log(`[Nyx] 隐私自检完成｜${summary.headline}｜用时 ${elapsedMs} 毫秒`);
    diagnostics.info('PRIVACY_CHECK_DONE', summary.headline, { worst: summary.worstLevel, elapsedMs, mode: meta.identity });
    return {
      ok: true,
      mode: sessions.getMode(),
      rows,
      groups: privacyCheck.GROUPS,
      summary,
      meta,
      report,
      reportJson,
      notes,
      elapsedMs,
    };
  });

  ipcMain.handle('nyx:permissions:list', (_event, limit) => buildPermissionView(limit));

  /** 清空"按站点已记住的授权"：只清会话缓存，不触碰持久白名单与站点数据 */
  ipcMain.handle('nyx:permissions:clear', () => {
    const manager = sessions.getPermissionManager();
    if (!manager) return { ok: false, error: '权限管理器未就绪' };
    const result = manager.clearCache();
    console.log('[Nyx] 已清空本会话记住的授权');
    return result && typeof result === 'object' ? result : { ok: true };
  });

  /** 撤销某个站点的设备白名单；不带 permission 表示撤销该站点全部设备 */
  ipcMain.handle('nyx:permissions:revoke', (_event, payload) => {
    const manager = sessions.getPermissionManager();
    if (!manager) return { ok: false, error: '权限管理器未就绪' };
    const origin = normalizePermissionOrigin(payload && payload.origin);
    if (!origin) return { ok: false, error: '来源不合法，只支持 http(s) 站点' };
    const permission = String((payload && payload.permission) || '').toLowerCase();
    const result = manager.revokeWhitelist(origin, permission);
    if (result.ok) {
      console.log(`[Nyx] 已撤销设备授权｜站点：${origin}｜${permission || '全部设备'}`);
    } else {
      console.warn(`[Nyx] 撤销设备授权失败｜${result.error}`);
    }
    return {
      ...result,
      whitelist: manager.whitelistEntries(),
      whitelistError: manager.whitelistError || '',
    };
  });

  /** 清空站点设备白名单（会话缓存另用 nyx:permissions:clear） */
  ipcMain.handle('nyx:permissions:whitelist-clear', () => {
    const manager = sessions.getPermissionManager();
    if (!manager) return { ok: false, error: '权限管理器未就绪' };
    const result = manager.clearWhitelist();
    if (result.ok) console.log('[Nyx] 已清空站点设备授权白名单');
    else console.warn(`[Nyx] 清空站点设备授权白名单失败｜${result.error}`);
    return {
      ...result,
      whitelist: manager.whitelistEntries(),
      whitelistError: manager.whitelistError || '',
    };
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
    const origin = safeOrigin(payload, event);
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
    const origin = safeOrigin(payload, event);
    if (!origin) return { ok: false, error: '来源缺失' };

    const credential = runtime.vault.readCredential(origin);
    if (!credential) return { ok: false, error: '该站点没有可填充的密码' };
    return { ok: true, username: credential.username, password: credential.password };
  });

  /** 站点提交登录表单后：密码在这里加密落盘（明文只存在于本次调用的参数与栈帧里） */
  ipcMain.handle('nyx:vault:offer-save', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload, event);
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
    const origin = safeOrigin(payload, event);
    if (!origin) return { ok: false, error: '来源缺失' };
    return runtime.vault.saveFormValues(origin, payload && payload.values);
  });

  ipcMain.handle('nyx:forms:load', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ok: false, code: 'PRIVATE_MODE', values: {} };
    const origin = safeOrigin(payload, event);
    if (!origin) return { ok: false, error: '来源缺失' };
    return { ok: true, values: runtime.vault.readFormValues(origin) || {} };
  });

  /* ---------------- 密码库管理（界面用，隐私模式下同样拒绝） ---------------- */

  ipcMain.handle('nyx:vault:remove', (event, payload) => {
    if (!runtime.vault) return { ok: false, error: '密码库未初始化' };
    if (senderMode(event) === 'private') return { ...PRIVATE_DENIED };
    const origin = safeOrigin(payload, event);
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
  const menuPrefs = {
    preload: path.join(__dirname, 'renderer', 'bm-menu-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  // 登记到外壳防护现值表（清单 C3）
  registerSecurityWindow('bm-menu', menuPrefs);

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
    webPreferences: menuPrefs,
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
 * 剪贴板兼容层（Electron 45 起 clipboard 全是异步的）。
 *
 * 45 之前 `clipboard.readText()` 直接返回字符串，45 之后返回 Promise，
 * 而且 `availableFormats()` 整个没了。这一层把差异吃掉：
 * 调用方要么 `await readClipboardText()`，要么用 `cachedClipboardText()` 拿最近一次的值。
 * 之所以还要缓存：地址栏建议是同步算的，而剪贴板读取现在是异步的——
 * 不缓存就只能拿 `[object Promise]` 去匹配，等于剪贴板建议直接消失（这就是升级后第一个被抓到的回归）。
 */
const clipboardCache = { text: '', at: 0, reading: null };

/**
 * 剪贴板 API 形状探测（候选③ 收口）。
 *
 * 为什么不能只靠"两种形状都兼容"就算完：兼容层会让「运行时退回了旧 API」
 * 这件事彻底安静——上游把异步改回去、或者有人把 electron 降回 43，
 * 表现都只是"还能用"，没有任何人会发现。这里在启动时探测一次并记进诊断，
 * 退化时用 warn 明确说，这样版本漂移是可见的。
 */
const clipboardShape = { async: null, probedAt: 0, syncFallbackSeen: false };

/**
 * 唯一的剪贴板读原语：返回"原样"的值（可能是字符串，也可能是 Promise）。
 * 探测与正式读取都从这里走，这样整个主进程只有这一处直接碰 `clipboard.readText`，
 * 版本差异只可能在兼容层里出现（回归脚本按这个不变量断言）。
 */
function rawClipboardRead() {
  return clipboard.readText();
}

/** 唯一的剪贴板写原语：原样返回（可能是 undefined，也可能是 Promise）。 */
function rawClipboardWrite(text) {
  return clipboard.writeText(text);
}

async function probeClipboardShape() {
  try {
    const value = rawClipboardRead();
    const isAsync = Boolean(value && typeof value.then === 'function');
    clipboardShape.async = isAsync;
    clipboardShape.probedAt = Date.now();
    if (isAsync) {
      diagnostics.info('CLIPBOARD_API_SHAPE', '剪贴板 API 是异步形状（Electron 45+）', {
        electron: process.versions.electron,
      });
    } else {
      diagnostics.warn('CLIPBOARD_API_SHAPE', '剪贴板 API 退回了同步形状（比 Electron 45 老）', {
        electron: process.versions.electron,
        hint: '兼容层仍能工作，但这说明运行时版本变了，去核对 package.json 与安全基线声明。',
      });
    }
    // 探测本身就是一次读取，顺手把值放进缓存，省掉首屏那次空缓存
    if (isAsync) await value.then((text) => {
      if (typeof text === 'string') {
        clipboardCache.text = text;
        clipboardCache.at = Date.now();
      }
    }).catch(() => {});
    else if (typeof value === 'string') {
      clipboardCache.text = value;
      clipboardCache.at = Date.now();
    }
    return isAsync;
  } catch (err) {
    clipboardShape.async = null;
    diagnostics.warn('CLIPBOARD_API_PROBE_FAILED', '剪贴板形状探测失败（可能被其它程序占用）', {
      error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function readClipboardText() {
  try {
    const value = rawClipboardRead();
    const isAsync = Boolean(value && typeof value.then === 'function');
    if (!isAsync && !clipboardShape.syncFallbackSeen) {
      // 只报一次：输入时每个字都会走到这里，重复刷日志没有意义
      clipboardShape.syncFallbackSeen = true;
      clipboardShape.async = false;
      diagnostics.warn('CLIPBOARD_SYNC_FALLBACK', '剪贴板读取走回了同步分支', {
        electron: process.versions.electron,
      });
    }
    const text = isAsync ? await value : value;
    clipboardCache.text = typeof text === 'string' ? text : '';
    clipboardCache.at = Date.now();
    return clipboardCache.text;
  } catch {
    // 剪贴板被占用 / 无权限：当作空，不影响调用方
    return '';
  }
}

function cachedClipboardText() {
  return clipboardCache.text;
}

/** 刷新缓存但做节流：输入时每敲一个字都读一次剪贴板没有意义 */
async function refreshClipboardCache(minIntervalMs = 250) {
  if (Date.now() - clipboardCache.at < minIntervalMs) return clipboardCache.text;
  return readClipboardText();
}

async function writeClipboardText(text) {
  const payload = String(text == null ? '' : text);
  try {
    const value = rawClipboardWrite(payload);
    if (value && typeof value.then === 'function') await value;
    return true;
  } catch (err) {
    // 写失败必须让人看得见：调用方会据此给前台提示，不许静默当成功
    diagnostics.error('CLIPBOARD_WRITE_FAILED', '写剪贴板失败（可能被其它程序占用）', {
      error: err && err.message ? err.message : String(err),
      chars: payload.length,
    });
    throw new Error(`写剪贴板失败：${err && err.message ? err.message : '系统剪贴板当前不可用'}`, {
      cause: err,
    });
  }
}

/**
 * 读剪贴板里是否是一条网址（v1.10.0）。
 * 只在普通模式、每次查询时读一次；隐私模式压根不会走到这里（建议被整体禁用）。
 */
function cachedClipboardUrl() {
  try {
    const text = String(cachedClipboardText() || '').trim();
    if (!text || text.length > 2048) return '';
    return /^https?:\/\/\S+$/i.test(text) ? text : '';
  } catch {
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

  const suggestPrefs = {
    preload: path.join(__dirname, 'renderer', 'addr-suggest-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  // 登记到外壳防护现值表（清单 C3）
  registerSecurityWindow('addr-suggest', suggestPrefs);

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
    webPreferences: suggestPrefs,
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
async function queryAddressSuggest(payload) {
  const text = String((payload && payload.text) || '');
  const expandedHost = String((payload && payload.expandedHost) || '').toLowerCase();
  // 剪贴板读取在 Electron 45 是异步的，所以这里必须先刷一次缓存再算命中
  await refreshClipboardCache();
  const items = addressSuggestMatches(text, { expandedHost, clipboard: cachedClipboardUrl() });
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

  const folderPrefs = {
    preload: path.join(__dirname, 'renderer', 'bm-folder-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
  // 登记到外壳防护现值表（清单 C3）
  registerSecurityWindow('bm-folder', folderPrefs);

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
    webPreferences: folderPrefs,
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
  // 设置改成标签页后，状态要推给「设置标签」而不是某个窗口；
  // 没开着设置就只更新 sessions（打开时会补推一份，不会漏）。
  const wc = runtime.tabManager ? runtime.tabManager.appPageWebContents('settings') : null;
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send('nyx:proxy-state', runtime.proxyService.status());
    } catch {
      /* 页面正在销毁时发送会抛 */
    }
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
/**
 * 打开设置（清单 B4+B5：唯一入口 + 改标签页）。
 *
 * 以前设置是独立弹窗（1180×820 的 BrowserWindow）：改完一个配置想看看页面效果得
 * 来回切窗口，而且工具栏齿轮与菜单项各能开出一份，用户看到的就是「两个设置」。
 * 现在设置是本窗口里的一个标签：全局单实例（再点齿轮只是切回去），关掉标签就是关设置，
 * 改配置能直接看到当前页面，不再有弹窗。
 *
 * @param {string} [section] 要停留的分区（错误页的「打开诊断」用它直达诊断页）
 */
function openSettings(section) {
  const wantSection = typeof section === 'string' && section ? section : '';

  if (!runtime.tabManager) return { ok: false, error: '窗口未就绪' };

  const settingsUrl = pathToFileURL(path.join(__dirname, 'renderer', 'settings.html')).toString();
  const opened = runtime.tabManager.createAppPage({
    url: settingsUrl,
    title: '设置',
    kind: 'settings',
  });
  if (!opened || opened.ok !== true) {
    const reason = (opened && opened.error) || '设置页打不开';
    notifyNotice({ level: 'error', code: 'SETTINGS_OPEN_FAILED', title: '设置打不开', message: reason });
    diagnostics.error('SETTINGS_OPEN_FAILED', { reason });
    return { ok: false, error: reason };
  }

  const wc = runtime.tabManager.appPageWebContents('settings');
  if (wc) {
    syncProxyPort();
    // 状态先推一份：设置页首屏要用代理状态，等它自己来问会有一次空窗
    if (runtime.proxyService) {
      try {
        wc.send('nyx:proxy-state', runtime.proxyService.status());
      } catch {
        /* 页面还没就绪时发送会抛，did-finish-load 里还会再推一次 */
      }
    }
    if (wantSection) sendSettingsSection(wc, wantSection, opened.reused === true);
  }

  return { ok: true, reused: opened.reused === true };
}

/**
 * 把「要跳到哪个分区」推给设置页。
 *
 * 复用已打开的标签时立刻发（页面已经在跑）；新建标签要等 `did-finish-load`，
 * 否则消息发给一个还没有监听的页面，等于没发——这正是"点打开诊断结果停在默认页"的老毛病。
 */
function sendSettingsSection(wc, section, alreadyLoaded) {
  if (!wc || wc.isDestroyed()) return;
  const push = () => {
    if (wc.isDestroyed()) return;
    try {
      wc.send('nyx:settings:section', section);
    } catch {
      /* 忽略：页面正在销毁 */
    }
  };
  if (alreadyLoaded) {
    push();
    return;
  }
  wc.once('did-finish-load', push);
}

/* ------------------------------------------------------------------ */
/* 下载中心                                                             */
/* ------------------------------------------------------------------ */

/**
 * 打开（或复用）下载中心窗口。
 *
 * 为什么必须有个窗口：清单 A1 的另一半问题是「前台零提示」——用户既看不到
 * 进度，也看不到失败原因和文件到底存到哪。提示条只能讲一件事，历史和落点
 * 需要一个能看全的地方。
 */
function openDownloads() {
  const existing = runtime.downloadsWindow;
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    pushDownloadsState();
    return { ok: true, reused: true };
  }

  const downloadsPrefs = {
    preload: path.join(__dirname, 'preload-downloads.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  // 登记到外壳防护现值表（清单 C3）
  registerSecurityWindow('downloads', downloadsPrefs);

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 560,
    minHeight: 380,
    title: 'Nyx 下载',
    backgroundColor: THEME_BG[(runtime.uiStore && runtime.uiStore.get().theme) || 'ink'],
    autoHideMenuBar: true,
    webPreferences: downloadsPrefs,
  });

  runtime.downloadsWindow = win;
  win.setMenuBarVisibility(false);
  // 下载中心只承载本地页面
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'downloads.html'));
  win.webContents.once('did-finish-load', () => pushDownloadsState());
  win.on('closed', () => {
    runtime.downloadsWindow = null;
  });

  return { ok: true, reused: false };
}

/** 把下载列表推给下载中心窗口（窗口没开就什么都不做） */
function pushDownloadsState() {
  const win = runtime.downloadsWindow;
  if (!win || win.isDestroyed()) return;
  const payload = runtime.downloads
    ? { items: runtime.downloads.list(), summary: runtime.downloads.summary() }
    : { items: [], summary: { total: 0, active: 0, done: 0, failed: 0, cancelled: 0 } };
  try {
    win.webContents.send('nyx:downloads:state', payload);
  } catch {
    /* 窗口正在关闭时发送会抛，忽略 */
  }
  // 外壳工具栏上的角标也要跟着动（进行中数量）
  const shell = runtime.mainWindow;
  if (shell && !shell.isDestroyed() && runtime.shellReady) {
    try {
      shell.webContents.send('nyx:downloads:state', payload);
    } catch {
      /* 同上 */
    }
  }
}

/** 下载中心 IPC */
function registerDownloadsIpc() {
  ipcMain.handle('nyx:downloads:open', () => openDownloads());

  ipcMain.handle('nyx:downloads:list', () => {
    if (!runtime.downloads) {
      return { ok: false, error: '下载模块还没就绪', items: [], summary: null };
    }
    return { ok: true, items: runtime.downloads.list(), summary: runtime.downloads.summary() };
  });

  ipcMain.handle('nyx:downloads:clear', () => {
    if (!runtime.downloads) return { ok: false, error: '下载模块还没就绪' };
    const items = runtime.downloads.clear();
    pushDownloadsState();
    return { ok: true, items };
  });

  // 在资源管理器中定位文件：文件已被移走时给出中文原因，而不是默默没反应
  ipcMain.handle('nyx:downloads:reveal', (_event, payload) => {
    const target = payload && typeof payload.savePath === 'string' ? payload.savePath : '';
    if (!target) return { ok: false, error: '这条记录没有保存路径' };
    if (!fs.existsSync(target)) {
      return { ok: false, error: '文件已经不在了（可能被移动或删除）' };
    }
    shell.showItemInFolder(target);
    return { ok: true };
  });

  // 直接打开文件（下载完想马上看）
  ipcMain.handle('nyx:downloads:open-file', async (_event, payload) => {
    const target = payload && typeof payload.savePath === 'string' ? payload.savePath : '';
    if (!target) return { ok: false, error: '这条记录没有保存路径' };
    if (!fs.existsSync(target)) return { ok: false, error: '文件已经不在了（可能被移动或删除）' };
    const message = await shell.openPath(target);
    return message ? { ok: false, error: message } : { ok: true };
  });

  // 复制下载地址
  ipcMain.handle('nyx:downloads:copy-url', async (_event, payload) => {
    const url = payload && typeof payload.url === 'string' ? payload.url : '';
    if (!url) return { ok: false, error: '这条记录没有地址' };
    try {
      await writeClipboardText(url);
    } catch (err) {
      return { ok: false, error: `写入剪贴板失败：${err && err.message}` };
    }
    return { ok: true };
  });

  // 打开保存目录本身（目录被删了就给出中文提示）
  ipcMain.handle('nyx:downloads:open-dir', async () => {
    const dir = resolveDownloadDir();
    if (!fs.existsSync(dir)) return { ok: false, error: `下载目录不在了：${dir}` };
    const message = await shell.openPath(dir);
    return message ? { ok: false, error: message } : { ok: true, path: dir };
  });
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

/** 起始页里发起打开：新建普通标签，成功后再收掉刚才那个起始页标签 */
function openFromStartPage(input) {
  const manager = runtime.tabManager;
  if (!manager) return { ok: false, error: '窗口尚未就绪' };
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '先输入一个网址或关键词' };

  const activeId = manager.activeId;
  const current = manager.tabs.find((tab) => tab.id === activeId);
  const fromStart = !!current && current.kind === 'start';

  const opened = manager.create(raw);
  if (!opened || opened.ok !== true) return opened || { ok: false, error: '打不开这个地址' };
  if (fromStart) {
    // 新标签已经激活，再关掉旧的起始页；关失败不影响这次打开
    try {
      manager.close(current.id);
    } catch (err) {
      diagnostics.warn('START_PAGE_CLOSE_FAILED', { message: err && err.message });
    }
  }
  diagnostics.info('START_PAGE_OPEN', { url: redactUrlForLog(normalizeInput(raw)) });
  return opened;
}

/**
 * 启动时要打开的地址列表（存储未就绪时回落为单个新标签页）。
 *
 * 「空白页」不再用 `about:blank`：那玩意儿在深色窗口里就是一整块黑，
 * 用户分不清是空白页还是浏览器崩了（实测反馈）。换成一张安静的本地空白页，
 * 上面写清"这是你选的启动方式、去哪儿改"。
 */
function startupTargets() {
  const list = runtime.startupStore ? runtime.startupStore.startupTargets(HOME_URL) : [HOME_URL];
  return list.map((url) => (url === 'about:blank' ? BLANK_PAGE_URL : url));
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

const SIGNING_STATUS_CACHE_MS = 10 * 60 * 1000;

/**
 * 读本进程 exe 的 Authenticode 签名（第五轮 ②：证书到期提醒进界面）。
 *
 * 为什么读的是 `process.execPath` 而不是项目里的 .cer：
 *   用户装的这个可执行文件到底有没有签名、证书有没有过期，只能问它自己；
 *   读仓库里那份 cer 只能证明「我们签过某个包」，证明不了「你现在跑的这个包是签过的」。
 * 读不出来时返回 unknown 并带上原因，绝不假装有效。
 */
function readSigningStatus(options = {}) {
  const force = Boolean(options && options.force);
  const cached = runtime.signingStatus;
  if (!force && cached && Date.now() - cached.at < SIGNING_STATUS_CACHE_MS) {
    return Promise.resolve({ ...cached.value, cached: true });
  }

  const target = process.execPath;
  const script = [
    '$s = Get-AuthenticodeSignature -LiteralPath $env:NYX_SIGN_TARGET',
    '$cert = $s.SignerCertificate',
    '$o = [ordered]@{ Status = [string]$s.Status; Subject = ""; Thumbprint = ""; NotAfter = "" }',
    'if ($cert -ne $null) {',
    '  $o.Subject = [string]$cert.Subject',
    '  $o.Thumbprint = [string]$cert.Thumbprint',
    '  $o.NotAfter = $cert.NotAfter.ToString("o")',
    '}',
    '$o | ConvertTo-Json -Compress',
  ].join('\n');

  return new Promise((resolve) => {
    const finish = (payload) => {
      const value = {
        ok: true,
        executable: target,
        packaged: app.isPackaged,
        at: Date.now(),
        ...payload,
      };
      runtime.signingStatus = { at: value.at, value };
      resolve(value);
    };

    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, env: { ...process.env, NYX_SIGN_TARGET: target } },
        (err, stdout, stderr) => {
          if (err) {
            const reason = (stderr && String(stderr).trim()) || (err && err.message ? err.message : '未知错误');
            diagnostics.warn('SIGNING_STATUS_READ_FAILED', '读不出安装包签名状态', { error: reason });
            finish({
              ok: false,
              level: 'unknown',
              label: '读不出签名',
              error: `没能读到这个可执行文件的签名：${reason}`,
              facts: [],
            });
            return;
          }
          const parsed = parsePackageSignaturePayload(stdout);
          if (!parsed.ok) {
            diagnostics.warn('SIGNING_STATUS_PARSE_FAILED', '签名信息解析失败', { error: parsed.error });
            finish({ ok: false, level: 'unknown', label: '读不出签名', error: parsed.error, facts: [] });
            return;
          }
          const described = describePackageSignature(parsed.value);
          finish({ ...described, facts: describePackageSignatureFacts(described) });
        },
      );
    } catch (err) {
      diagnostics.error('SIGNING_STATUS_SPAWN_FAILED', '起不来读签名的子进程', {
        error: err && err.message,
      });
      finish({
        ok: false,
        level: 'unknown',
        label: '读不出签名',
        error: `没能起 PowerShell 读签名：${err && err.message ? err.message : String(err)}`,
        facts: [],
      });
    }
  });
}

/** 设置中心 IPC：界面偏好读写、应用与运行时信息 */
function registerSettingsIpc() {
  // 安装包签名状态（第五轮 ②）：读自身 exe 的签名与证书有效期，如实翻译
  ipcMain.handle('nyx:signing:status', (_event, payload) =>
    readSigningStatus({ force: Boolean(payload && payload.force) }),
  );

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

  /**
   * 接入方式（VPN 接入外壳清单 B1）。
   *
   * 只做三件事：读当前该用哪一档、判断"这台机器像不像老用户"、写用户显式选择的身份。
   * 不碰内核、订阅、端口与分流——换身份不重启内核、不重连（清单验收第 3 条）。
   */
  function netHasExistingConfig() {
    // 判断依据只有一条：已有接入配置（订阅）。服务没就绪或抛错时按"老用户"处理——
    // 宁可让升级用户维持旧界面，也不要给一个用了很久的人突然换成校园口径。
    try {
      const status =
        runtime.proxyService && typeof runtime.proxyService.status === 'function'
          ? runtime.proxyService.status()
          : null;
      const subs = status && Array.isArray(status.subscriptions) ? status.subscriptions : [];
      return subs.length > 0;
    } catch {
      return true;
    }
  }

  function netIdentityPayload() {
    const saved = (runtime.uiStore && runtime.uiStore.get().netIdentity) || netTerms.IDENTITY_AUTO;
    const hasExistingConfig = netHasExistingConfig();
    const identity = netTerms.resolveIdentity(saved, { hasExistingConfig });
    return {
      ok: true,
      saved,
      identity,
      auto: saved === netTerms.IDENTITY_AUTO,
      hasExistingConfig,
      label: netTerms.IDENTITY_LABELS[identity],
      note: netTerms.IDENTITY_NOTES[identity],
      options: netTerms.describeIdentities(),
      statement: netTerms.SHELL_STATEMENT,
      scopeNote: netTerms.IDENTITY_SCOPE_NOTE,
      terms: netTerms.termsFor(identity),
    };
  }

  ipcMain.handle('nyx:net:identity', () => netIdentityPayload());

  ipcMain.handle('nyx:net:identity-set', (_event, payload) => {
    if (!runtime.uiStore) return { ok: false, error: '界面偏好存储未就绪' };

    const identity = payload && payload.identity;
    if (!netTerms.IDENTITIES.includes(identity)) {
      const names = netTerms.IDENTITIES.map((id) => netTerms.IDENTITY_LABELS[id]).join(' / ');
      return { ok: false, error: `接入方式只能是：${names}` };
    }

    const result = runtime.uiStore.set('netIdentity', identity);
    if (!result || result.ok === false) {
      return { ok: false, error: (result && result.error) || '接入方式没能保存' };
    }

    // 顶栏与设置页都读同一份偏好，改完立刻推一次状态，避免两边显示两套叫法
    if (runtime.tabManager) pushState(runtime.tabManager.snapshot());

    // 外壳（地址栏 / 状态条 / 提示）不在设置页那棵 DOM 里，得单独通知它换词
    const payloadForShell = netIdentityPayload();
    if (runtime.mainWindow && !runtime.mainWindow.isDestroyed()) {
      runtime.mainWindow.webContents.send('nyx:net-identity-changed', payloadForShell);
    }

    return Object.assign({ ok: true }, payloadForShell);
  });

  /**
   * 隐私模式的出站方式（清单 B3）。
   *
   * 读：返回当前取值 + 两种取值的文案（含选「真实 IP」会失去哪些保护）。
   * 写：只接受 proxy / direct；`direct` 必须带 `ack: true`（用户在设置里勾过风险确认），
   *     否则拒绝——避免脚本或误点把隐私模式悄悄改成直连。
   */
  ipcMain.handle('nyx:privacy:link', () => ({
    ok: true,
    link: (runtime.uiStore && runtime.uiStore.get().privacyLink) || 'proxy',
    mode: sessions.getMode(),
    current: sessions.getLink('private'),
    options: PRIVACY_LINK_OPTIONS,
  }));

  ipcMain.handle('nyx:privacy:link-set', async (_event, payload) => {
    if (!runtime.uiStore) return { ok: false, error: '界面偏好存储未就绪' };

    const want = payload && payload.link === 'direct' ? 'direct' : 'proxy';
    if (want === 'direct' && !(payload && payload.ack === true)) {
      return {
        ok: false,
        error: '选择「真实 IP」前需要先勾选「我已了解上述风险」',
        link: (runtime.uiStore.get().privacyLink) || 'proxy',
      };
    }

    const saved = runtime.uiStore.set('privacyLink', want);
    if (!saved.ok) return saved;

    // 当前就处在隐私模式：立刻改链路，并再次明确告知（不能等下次切换才生效）
    if (sessions.getMode() === 'private') {
      const changed = sessions.setLink('private', want, { allowRealIp: want === 'direct' });
      try {
        await sessions.whenSessionReady('private');
      } catch (err) {
        diagnostics.error('PRIVACY_LINK_SWITCH_FAILED', { link: want, error: err.message });
        notifyNotice({
          level: 'error',
          code: 'PRIVACY_LINK_SWITCH_FAILED',
          title: '出站方式没能立刻生效',
          message:
            `隐私分区没有接受新的出站方式（${err.message}）。` +
            '设置已保存，下次进入隐私模式时会再次尝试；当前仍是原来的链路。',
        });
        return { ok: false, error: err.message, link: want };
      }

      if (changed) {
        if (want === 'direct') {
          diagnostics.warn('PRIVACY_REAL_IP_ENTERED', { during: 'private' });
          modeEventLog.record({
            type: 'switch',
            from: 'private',
            to: 'private',
            changed: false,
            ok: true,
            code: 'PRIVACY_REAL_IP',
            message: '隐私模式出站改为直连（真实 IP）',
          });
          notifyNotice(buildRealIpNotice());
        } else {
          diagnostics.info('PRIVACY_LINK_BACK_TO_PROXY', {});
          notifyNotice({
            level: 'info',
            code: 'PRIVACY_LINK_PROXY',
            title: '已改回经代理',
            message: '隐私模式现在强制走本机代理，站点看不到你的真实 IP。',
          });
        }
      }

      if (runtime.tabManager) pushState(runtime.tabManager.snapshot());
    }

    return { ok: true, link: want, ui: saved.ui || currentUiPrefs() };
  });

  /* 图形性能（清单 A5）：默认核显优先，用户可以显式选独显或跟随系统。
   * Chromium 的显卡选择发生在 app ready 之前，所以改动一律"下次启动生效"，
   * 这里如实告诉界面本次启动用的是哪一档（bootPolicy），不假装已经切换。
   * 注意：这里刻意不带硬件能力探测结果——getHardwareStatus() 会跑一次
   * PowerShell（最长 15 秒），把它塞进这个快照里会让设置页开一次卡一次；
   * 硬件加速那张卡片本来就有自己的只读通道（nyx:hardware:status）。 */
  ipcMain.handle('nyx:gpu:policy', () => {
    const prefs = runtime.uiStore ? runtime.uiStore.get() : null;
    const policy = normalizeGpuPolicy(prefs && prefs.gpuPolicy ? prefs.gpuPolicy : BOOT_GPU_POLICY);
    return {
      ok: true,
      policy,
      bootPolicy: BOOT_GPU_POLICY,
      restartRequired: policy !== BOOT_GPU_POLICY,
      options: GPU_POLICIES,
      gpu: runtime.gpuInfo || null,
    };
  });

  ipcMain.handle('nyx:gpu:policy-set', (_event, payload) => {
    if (!runtime.uiStore) return { ok: false, error: '界面偏好存储未就绪' };

    const want = normalizeGpuPolicy(payload && payload.policy);
    const saved = runtime.uiStore.set('gpuPolicy', want);
    if (!saved.ok) return saved;

    diagnostics.info('GPU_POLICY_SET', {
      policy: want,
      bootPolicy: BOOT_GPU_POLICY,
      restartRequired: want !== BOOT_GPU_POLICY,
    });
    return {
      ok: true,
      policy: want,
      bootPolicy: BOOT_GPU_POLICY,
      restartRequired: want !== BOOT_GPU_POLICY,
      ui: saved.ui || currentUiPrefs(),
    };
  });

  // 「立即重启」只做重启，不顺手改别的：先把请求写进诊断，重启后能对上账
  ipcMain.handle('nyx:app:restart', () => {
    diagnostics.info('APP_RESTART_REQUESTED', { bootGpuPolicy: BOOT_GPU_POLICY });
    try {
      app.relaunch();
      app.exit(0);
      return { ok: true };
    } catch (err) {
      diagnostics.error('APP_RESTART_FAILED', { error: err && err.message });
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 安全基线（C2）：只报「声明的版本 vs 机器上跑的版本」，不编造 CVE 结论
  ipcMain.handle('nyx:security:baseline', () =>
    securityBaselinePayload({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      appVersion: app.getVersion(),
    }),
  );

  // 只允许打开白名单里的公告页：不允许渲染进程传任意 URL 给 shell.openExternal
  ipcMain.handle('nyx:security:advisory', (_event, payload) => {
    const key = payload && typeof payload.key === 'string' ? payload.key : '';
    const source = ADVISORY_SOURCES.find((item) => item.key === key);
    if (!source) return { ok: false, error: `未知的公告入口：${key || '（空）'}` };
    try {
      shell.openExternal(source.url);
      diagnostics.info('SECURITY_ADVISORY_OPENED', { key: source.key });
      return { ok: true, url: source.url };
    } catch (err) {
      diagnostics.error('SECURITY_ADVISORY_FAILED', { key: source.key, error: err && err.message });
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 外壳防护现值表（C3）：把「期望值」和这台机器上窗口真正用的值摆在一起比对
  ipcMain.handle('nyx:security:switches', async () => {
    try {
      return await collectSecuritySwitches();
    } catch (err) {
      diagnostics.error('SECURITY_SWITCHES_FAILED', `读取外壳防护现值失败：${err.message}`);
      return { ok: false, error: `读取外壳防护现值失败：${err.message}` };
    }
  });

  // 注入演示（C3）：真的在一个同构窗口里尝试 require / 动态求值 / 改写暴露面
  ipcMain.handle('nyx:security:probe', () => runSecurityProbe());

  // 录屏 / 被远控检测（C4）：手动检查 + 用户对"无法确认"的显式确认
  ipcMain.handle('nyx:screen:watch', (_event, payload) => refreshScreenWatch({ force: payload && payload.force === true }));
  ipcMain.handle('nyx:screen:ack', () => {
    runtime.screenAckAt = Date.now();
    diagnostics.warn('SCREEN_WATCH_ACKNOWLEDGED', '用户确认当前没有在录屏/被远控，允许进入隐私模式', {});
    return { ok: true, ackAt: runtime.screenAckAt };
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
const {
  NAVIGATE_BUDGET_DEFAULT,
  NAVIGATE_BUDGET_MAX,
  NAVIGATE_BUDGET_MIN,
  describeNavigateBudget,
  formatSiteRules,
  parseSiteRules,
  resolveBudgetForUrl,
  sanitizeSiteRules,
} = require('./core/navigate-budget');

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

/**
 * agent 导航预算（v1.17.17）：慢站合法地会把 15 秒用光，写死就会"明明打开了却报超时"。
 * 范围 3–60 秒，非法值一律回默认（见 src/core/navigate-budget.js）。
 */
function normalizeNavigateTimeout(value) {
  const num = Number(value);
  if (!Number.isInteger(num)) return null;
  if (num < NAVIGATE_BUDGET_MIN || num > NAVIGATE_BUDGET_MAX) return null;
  return num;
}

function readToolboxPrefs() {
  try {
    const file = toolboxPrefsPath();
    const fallback = {
      slowMs: NET_SLOW_DEFAULT,
      navigateTimeoutMs: NAVIGATE_BUDGET_DEFAULT,
      navigateTimeoutSites: [],
    };
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const slow = normalizeSlowMs(raw && raw.slowMs);
    const nav = normalizeNavigateTimeout(raw && raw.navigateTimeoutMs);
    return {
      slowMs: slow == null ? NET_SLOW_DEFAULT : slow,
      navigateTimeoutMs: nav == null ? NAVIGATE_BUDGET_DEFAULT : nav,
      // 按站点覆盖（用户要求）：坏条目单条丢掉，绝不让整张表失效或悄悄回退成全局值
      navigateTimeoutSites: sanitizeSiteRules(raw && raw.navigateTimeoutSites),
    };
  } catch {
    return { slowMs: NET_SLOW_DEFAULT, navigateTimeoutMs: NAVIGATE_BUDGET_DEFAULT, navigateTimeoutSites: [] };
  }
}

/**
 * 给某个地址挑导航预算：站点规则优先（最长匹配），否则用全局值。
 * 动作执行器只关心「这次该等多久」，挑规则这件事留在主进程。
 */
function navigateBudgetForUrl(url) {
  const prefs = readToolboxPrefs();
  const picked = resolveBudgetForUrl(prefs.navigateTimeoutSites, url, prefs.navigateTimeoutMs);
  return picked;
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

/** 更新源里当前发布的版本号（读不出来就空串，别猜） */
function latestVersionInSource() {
  try {
    const latest = JSON.parse(
      fs.readFileSync(path.join(updatesDirPath(), 'latest.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    return String(latest.version || '');
  } catch {
    return '';
  }
}

/** 更新源 + 留档的体积快照（设置页「更新源占用」卡片用） */
function updateFootprint() {
  const updates = measureDir(updatesDirPath());
  const archive = measureDir(archiveDirPath());
  const version = latestVersionInSource();
  let archiveVersions = [];
  try {
    archiveVersions = fs
      .readdirSync(archiveDirPath(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    archiveVersions = [];
  }
  const delta = readDeltaReport();
  return {
    ok: true,
    version,
    archiveVersions,
    updates: { path: updates.path, bytes: updates.bytes, files: updates.files },
    archive: { path: archive.path, bytes: archive.bytes, dirs: archive.dirs, files: archive.files },
    total: updates.bytes + archive.bytes,
    // 上次实测的差分命中率：卡片一打开就能看到，不用每次再问人
    delta,
    // 这份数字还算不算数：更新源一换版本，旧报告就不再描述下一次更新（静默过期比没数字更误导）
    deltaFreshness: describeDeltaFreshness(delta, { currentVersion: version, staleDays: STALE_DAYS }),
  };
}

/** 清理命令写成一行，设置页展示 + 一键复制都用它 */
function updateCleanCommand() {
  return 'node scripts/make-release.js --clean-updates --target both --keep-n 1 --yes';
}

/* ------------------------------------------------------------------ */
/* 差分命中率实测（设置页「更新源占用」卡片里那个按钮）                     */
/* ------------------------------------------------------------------ */

const DELTA_REPORT_FILE = 'delta-report.json';
const DELTA_MAX_BYTES = 512 * 1024 * 1024;

function deltaReportPath() {
  return path.join(app.getPath('userData'), DELTA_REPORT_FILE);
}

function readDeltaReport() {
  try {
    const raw = JSON.parse(fs.readFileSync(deltaReportPath(), 'utf8').replace(/^\uFEFF/, ''));
    return normalizeDeltaReport(raw);
  } catch {
    return null;
  }
}

function writeDeltaReport(report) {
  try {
    fs.writeFileSync(deltaReportPath(), JSON.stringify(report, null, 2), 'utf8');
    return true;
  } catch (err) {
    diagnostics.warn('DELTA_REPORT_SAVE_FAILED', '差分实测结果没能保存到磁盘', { error: err && err.message });
    return false;
  }
}

/** 在目录里找一个安装包（新→旧按文件名排序，取第一个能读出大小的） */
function findInstallerFile(dir, version) {
  const wanted = String(version || '').trim();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^Nyx-Setup-[\d.]+\.exe$/i.test(name));
  } catch {
    return null;
  }
  if (!names.length) return null;
  if (wanted) {
    const exact = names.find((name) => name.includes(`-${wanted}.exe`));
    if (exact) names = [exact];
  }
  names.sort().reverse();
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size > 0) {
        const matched = /-([\d.]+)\.exe$/i.exec(name);
        return { path: full, bytes: stat.size, version: matched ? matched[1] : '' };
      }
    } catch {
      /* 读不到就试下一个 */
    }
  }
  return null;
}

/**
 * 取一对包：目标 = 更新源里当前版本的安装包；基线 = 留档里比它小的最新一版。
 * 没有留档就用留档目录里最新的一份——量出来的数字依然是真的，只是版本跨度大一点。
 */
function pickDeltaPair() {
  const updatesDir = updatesDirPath();
  const archiveRoot = archiveDirPath();
  let currentVersion = '';
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(updatesDir, 'latest.json'), 'utf8').replace(/^\uFEFF/, ''));
    currentVersion = String(latest.version || '');
  } catch {
    currentVersion = '';
  }
  const target = findInstallerFile(updatesDir, currentVersion);
  let versions = [];
  try {
    versions = fs
      .readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    versions = [];
  }
  const candidates = versions.filter((name) => name !== currentVersion);
  let base = null;
  for (let index = candidates.length - 1; index >= 0 && !base; index -= 1) {
    base = findInstallerFile(path.join(archiveRoot, candidates[index]), candidates[index]);
  }
  return { base, target, currentVersion, archiveVersions: versions };
}

/** 把文件按固定块切开逐个算 sha256（流式，避免一次读进内存） */
function hashFileBlocks(filePath, blockSize, limitBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const hashes = [];
    let pending = Buffer.alloc(0);
    let read = 0;
    const stream = fs.createReadStream(filePath, { highWaterMark: blockSize, start: 0, end: limitBytes - 1 });
    stream.on('data', (chunk) => {
      read += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= blockSize) {
        hashes.push(crypto.createHash('sha256').update(pending.subarray(0, blockSize)).digest('hex'));
        pending = pending.subarray(blockSize);
      }
      if (typeof onProgress === 'function') onProgress(read);
    });
    stream.on('error', (err) => reject(err));
    stream.on('end', () => {
      if (pending.length) {
        hashes.push(crypto.createHash('sha256').update(pending).digest('hex'));
      }
      resolve(hashes);
    });
  });
}

/**
 * 实测一次差分命中率：把两个安装包按同一块大小切开，逐块比哈希。
 * 这是设置页那个「实测一次」按钮背后真正干活的地方——只在用户点击时跑，不占启动路径。
 */
async function measureDeltaHitRate(input) {
  const blockSize = normalizeBlockSize(input && input.blockSize);
  const pair = pickDeltaPair();
  const plan = planDeltaMeasure({ base: pair.base || {}, target: pair.target || {}, blockSize });
  if (!plan.ok) {
    const failure = summarizeDeltaMeasure({ base: pair.base || {}, target: pair.target || {}, blockSize: plan.blockSize || blockSize });
    writeDeltaReport(failure);
    diagnostics.warn('DELTA_MEASURE_SKIPPED', plan.error, { code: plan.code });
    return failure;
  }
  try {
    const baseHashes = new Set(await hashFileBlocks(pair.base.path, plan.blockSize, DELTA_MAX_BYTES));
    const targetHashes = await hashFileBlocks(pair.target.path, plan.blockSize, DELTA_MAX_BYTES);
    let hits = 0;
    for (const hash of targetHashes) {
      if (baseHashes.has(hash)) hits += 1;
    }
    const savedBytes = Math.round((hits / targetHashes.length) * (Number(pair.target.bytes) || 0));
    const report = summarizeDeltaMeasure({
      base: pair.base,
      target: pair.target,
      blockSize: plan.blockSize,
      blocks: targetHashes.length,
      hits,
      savedBytes,
      at: Date.now(),
    });
    writeDeltaReport(report);
    diagnostics.info('DELTA_MEASURED', `差分实测：${report.hitRateText}`, {
      blocks: report.blocks,
      hits: report.hits,
      blockSize: report.blockSize,
      base: pair.base.version || '',
      target: pair.target.version || '',
    });
    return report;
  } catch (err) {
    const failure = {
      ok: false,
      code: 'MEASURE_FAILED',
      error: `量差分时读文件失败：${err && err.message ? err.message : String(err)}`,
      at: Date.now(),
    };
    writeDeltaReport(failure);
    diagnostics.error('DELTA_MEASURE_FAILED', '差分命中率实测失败', { error: err && err.message });
    return failure;
  }
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

  /** 对话框父窗口：设置已是标签页，统一挂在主窗口上（弹框不会跑到看不见的地方） */
  const parentWindow = () => {
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

/* ------------------------------------------------------------------ */
/* 主界面加载失败页 IPC（A4）                                           */
/* ------------------------------------------------------------------ */

/**
 * 失败页是外壳的一部分（`#page-error`，见 index.html），三个按钮都走主进程：
 *   - 重试：回到用户原本想打开的地址（requestedUrl，不是失败后可能被改写的 tab.url）
 *   - 打开诊断：设置窗口直接落到「诊断」分区，把最近错误摊给用户看
 *   - 复制详情：把错误码 / 原因 / 地址 / 模式链路拼成一段能直接粘贴报障的文本
 *
 * 为什么失败页不做成标签内的本地页面：标签视图的 preload 在创建时就绑定了，
 * 换不了 preload 就没有 IPC，按钮等于摆设；外壳本来就有完整的 window.nyx。
 */
function registerErrorPageIpc() {
  ipcMain.handle('nyx:error:retry', () => {
    if (!runtime.tabManager) return { ok: false, error: '标签管理器尚未就绪' };
    const result = runtime.tabManager.retryLoadError();
    // 重试也留痕：用户说"点了没反应"时，日志里要能看出试过几次、打的哪个地址
    if (runtime.diagnostics) {
      runtime.diagnostics.info('LOAD_RETRY', { url: result.url || '', ok: result.ok });
    }
    return result;
  });

  ipcMain.handle('nyx:error:diagnostics', () => {
    if (runtime.diagnostics) runtime.diagnostics.info('OPEN_DIAGNOSTICS_FROM_ERROR_PAGE', {});
    return openSettings('diagnostics');
  });

  ipcMain.handle('nyx:error:copy', async (_event, payload) => {
    const text = String((payload && payload.text) || '').trim();
    if (!text) return { ok: false, error: '没有可复制的详情' };
    try {
      await writeClipboardText(text);
      // 写完立刻回读校对：`writeText` 不抛异常并不等于真写进去了（会话被锁、
      // 剪贴板被别的程序独占时它会安静地什么都不做）。回读对不上就如实报错，
      // 不让界面显示一句假的「已复制」。
      // Electron 45 起 readText() 返回 Promise，必须 await 才拿到字符串，
      // 否则这里拿到的是 [object Promise]，`.includes` 直接抛（升级后第二个被抓到的回归）。
      let readback = '';
      try {
        readback = (await readClipboardText()) || '';
      } catch {
        readback = '';
      }
      const head = text.split('\n')[0].trim();
      if (!readback || (head && !readback.includes(head))) {
        return {
          ok: false,
          error: '系统剪贴板当前不可用（可能被其它程序占用），详情没能复制',
          readback,
        };
      }
      return { ok: true, readback };
    } catch (err) {
      return { ok: false, error: `复制失败：${err.message}` };
    }
  });

  // 断网时给一份"上次读到什么"——只有真的缓存过才返回内容，
  // 没缓存就返回 available:false + 中文说明，界面据此自己决定说什么。
  // 隐私模式走另一个加密文件（用户第 2 项），没有可解密的内容就如实说没有。
  ipcMain.handle('nyx:error:cached', (_event, payload) => {
    const url = String((payload && payload.url) || '');
    if (sessions.getMode() === 'private') {
      const privatePage = getPrivateCachedPage(url);
      if (runtime.diagnostics && privatePage.available) {
        runtime.diagnostics.info('OFFLINE_CACHE_SHOWN', { url: redactUrlForLog(url), chars: privatePage.chars, at: privatePage.at, encrypted: true });
      }
      return { ok: true, url, ...privatePage };
    }
    const snapshot = getSnapshot(runtime.pageCache, url);
    const described = describeCachedPage(snapshot, { now: Date.now() });
    if (runtime.diagnostics && described.available) {
      runtime.diagnostics.info('OFFLINE_CACHE_SHOWN', { url: redactUrlForLog(url), chars: described.chars, at: described.at });
    }
    return { ok: true, url, ...described };
  });
}

/**
 * 离线阅读缓存的开关与清理（候选③：把"要不要把正文写到磁盘"交给用户决定）。
 * 关掉时不只是"以后不写"，而是把已经写到磁盘的快照一起清掉——
 * 留着一份用户以为已经关掉的历史，比功能本身更糟。
 */
function clearPageCache(reason) {
  runtime.pageCache = { version: CACHE_VERSION, items: [] };
  // 隐私模式那份也一起清：用户点「清空」时不该只清一半
  const clearedPrivate = Array.isArray(runtime.privateCache && runtime.privateCache.entries)
    ? runtime.privateCache.entries.length
    : 0;
  runtime.privateCache = { v: 1, entries: [] };
  try {
    fs.writeFileSync(runtime.pageCacheFile, JSON.stringify(runtime.pageCache), 'utf8');
    fs.writeFileSync(privateCachePath(), JSON.stringify(runtime.privateCache), 'utf8');
  } catch (err) {
    console.warn('[Nyx] 清空离线缓存时写盘失败：', err && err.message ? err.message : err);
    if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_CLEAR_FAILED', '清空离线缓存时没能写入磁盘', { error: String(err && err.message ? err.message : err) });
    return { ok: false, error: `没能写入 ${runtime.pageCacheFile}：${err && err.message ? err.message : err}` };
  }
  if (runtime.diagnostics) runtime.diagnostics.info('PAGE_CACHE_CLEARED', { reason, file: runtime.pageCacheFile, private: clearedPrivate });
  return { ok: true, privateCleared: clearedPrivate };
}

function offlineCachePayload() {
  const items = runtime.pageCache && Array.isArray(runtime.pageCache.items) ? runtime.pageCache.items : [];
  const privateDecision = privateCacheDecision();
  const privateNotice = pendingPrivateCacheNotice;
  pendingPrivateCacheNotice = '';
  const privateInspect = inspectPrivateCache();
  return {
    ok: true,
    // 注意：UiStore.get() 不接受参数，返回的是整份偏好对象 —— 不能写成 get('offlineCacheEnabled')
    enabled: runtime.uiStore ? runtime.uiStore.get().offlineCacheEnabled !== false : true,
    count: items.length,
    limit: CACHE_LIMIT,
    file: runtime.pageCacheFile || userDataFile('page-cache.json'),
    note: '只存 http(s) 页面的正文结构与纯文字，外加最多 6 张小图（单张 ≤120 KB、一页合计 ≤480 KB）；不存 Cookie 与表单内容。隐私模式的快照整条加密后单独存放。',
    // 隐私模式那半边（用户第 2 项）：加密是否可用、存了几条、为什么没存
    privateEnabled: runtime.uiStore ? runtime.uiStore.get().privateSnapshotEnabled !== false : true,
    privateMode: privateDecision.mode,
    privateAvailable: privateDecision.ok,
    privateReason: privateDecision.reason,
    privateNotice,
    private: privateCacheStatus(runtime.privateCache, { now: Date.now() }),
    privateFile: runtime.privateCacheFile || userDataFile('private-cache.json'),
    privateLimit: PRIVATE_CACHE_LIMIT,
    // 解不开的条数（换系统账户 / 密钥变了）。>0 时界面上要给"一键清掉"的出口，
    // 否则用户只能去删整个文件，连能解开的一起丢。
    privateBroken: privateInspect.broken,
    privateReadable: privateInspect.readable,
    privateBrokenNote: privateInspect.note,
  };
}

/**
 * 逐条试解密，数出解不开的条数。
 * 只做一次判定，不把正文留在内存里——解出来的东西立刻丢掉。
 */
function privateDecryptProbe(entry) {
  try {
    safeStorage.decryptString(Buffer.from(entry.blob, 'base64'));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function inspectPrivateCache() {
  return inspectPrivateStore(runtime.privateCache, { now: Date.now(), decrypt: privateDecryptProbe });
}

function registerOfflineCacheIpc() {
  ipcMain.handle('nyx:offline:get', () => offlineCachePayload());

  ipcMain.handle('nyx:offline:set', (_event, payload) => {
    const enabled = !(payload && payload.enabled === false);
    // 隐私模式那半边单独一个开关（用户第 2 项）：两个开关互不影响，
    // 免得"关掉普通缓存"顺手把隐私模式的加密快照也关掉。
    if (payload && payload.private === true) {
      const nextPrivate = !(payload.enabled === false);
      try {
        const savedPrivate = runtime.uiStore.set('privateSnapshotEnabled', nextPrivate);
        if (savedPrivate && savedPrivate.ok === false) {
          if (runtime.diagnostics) runtime.diagnostics.error('PRIVATE_CACHE_TOGGLE_FAILED', '隐私模式快照开关没能保存', { error: savedPrivate.error });
          return { ...offlineCachePayload(), ok: false, error: `没能保存这个开关：${savedPrivate.error}` };
        }
      } catch (err) {
        if (runtime.diagnostics) runtime.diagnostics.error('PRIVATE_CACHE_TOGGLE_FAILED', '隐私模式快照开关没能保存', { error: String(err && err.message ? err.message : err) });
        return { ...offlineCachePayload(), ok: false, error: `没能保存这个开关：${err && err.message ? err.message : err}` };
      }
      if (!nextPrivate) {
        pendingPrivateCacheNotice = '';
        const clearedPrivate = clearPrivateCache('private-disabled');
        if (!clearedPrivate.ok) {
          return { ...offlineCachePayload(), ok: false, error: clearedPrivate.error };
        }
      }
      return { ...offlineCachePayload(), ok: true, privateEnabled: nextPrivate };
    }
    try {
      const saved = runtime.uiStore.set('offlineCacheEnabled', enabled);
      // set() 遇到非法值时返回 { ok:false } 而不抛异常，这里必须看返回值，
      // 否则界面会显示"已关闭"而内核其实没改。
      if (saved && saved.ok === false) {
        if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_TOGGLE_FAILED', '离线缓存开关没能保存', { error: saved.error });
        return { ...offlineCachePayload(), ok: false, error: `没能保存这个开关：${saved.error}` };
      }
    } catch (err) {
      if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_TOGGLE_FAILED', '离线缓存开关没能保存', { error: String(err && err.message ? err.message : err) });
      return { ...offlineCachePayload(), ok: false, error: `没能保存这个开关：${err && err.message ? err.message : err}` };
    }
    let cleared = 0;
    if (!enabled) {
      cleared = (runtime.pageCache && runtime.pageCache.items.length) || 0;
      const result = clearPageCache('user-disabled');
      if (!result.ok) return { ...offlineCachePayload(), ok: false, error: result.error };
    }
    return { ...offlineCachePayload(), enabled, cleared };
  });

  ipcMain.handle('nyx:offline:clear', () => {
    const cleared = (runtime.pageCache && runtime.pageCache.items.length) || 0;
    const result = clearPageCache('user-cleared');
    if (!result.ok) return { ...offlineCachePayload(), ok: false, error: result.error };
    return { ...offlineCachePayload(), cleared };
  });

  /**
   * 只清掉解不开的加密快照（换系统账户 / 密钥变了之后）。
   *
   * 为什么不直接清整个文件：能解开的那些还有用，一刀切掉等于罚用户"换过账户"。
   * 回给界面的 dropped 是真实清掉的条数，界面必须如实显示。
   */
  ipcMain.handle('nyx:offline:private-reset', () => {
    const result = dropBrokenEntries(runtime.privateCache, { now: Date.now(), decrypt: privateDecryptProbe });
    if (!result.ok) {
      return { ...offlineCachePayload(), ok: false, error: result.error || '没能清掉解不开的快照。' };
    }
    runtime.privateCache = result.store;
    const written = writePrivateCache(runtime.privateCache);
    if (!written) {
      if (runtime.diagnostics) {
        runtime.diagnostics.error('PRIVATE_CACHE_CLEAR_FAILED', '解不开的快照没能在磁盘上清掉', {
          dropped: result.dropped,
        });
      }
      return { ...offlineCachePayload(), ok: false, error: '清掉了内存里的记录，但磁盘上的文件没能改写（可能被占用）。' };
    }
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PRIVATE_CACHE_BROKEN_DROPPED', '清掉了打不开的加密快照', {
        before: result.before,
        after: result.after,
        dropped: result.dropped,
      });
    }
    return { ...offlineCachePayload(), ok: true, dropped: result.dropped, privateLeft: result.after };
  });

  /**
   * 站点黑白名单（用户第 5 项）。
   *
   * set 的语义要克制：只改传进来的字段，没传的保持原样；
   * 名单逐条规范化（去空白、去掉协议与 www、去重、上限 200），
   * 规范化之后如果和用户写的不一样，把结果如实回给界面（别让界面以为存的是原样）。
   */
  ipcMain.handle('nyx:offline:sites', () => ({
    ok: true,
    ...cacheSitePolicy(),
    private: privateSitePolicy(),
    privateEffective: privateSiteEffective(),
    modes: CACHE_SITE_MODES,
  }));

  ipcMain.handle('nyx:offline:sites-set', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const scope = input.scope === 'private' ? 'private' : 'normal';
    const current = scope === 'private' ? privateSitePolicy() : cacheSitePolicy();
    const next = normalizeSitePolicy({
      mode: input.mode === undefined ? current.mode : input.mode,
      allow: input.allow === undefined ? current.allow : normalizeSiteList(input.allow),
      block: input.block === undefined ? current.block : normalizeSiteList(input.block),
    });
    if (scope === 'private') {
      const saved = saveCacheSitePolicy(next, 'private');
      if (!saved.ok) return { ok: false, error: saved.error, ...cacheSitePolicy(), private: privateSitePolicy() };
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PRIVATE_CACHE_SITES_UPDATED', '隐私模式快照的站点名单已更新', {
          mode: next.mode,
          allow: next.allow.length,
          block: next.block.length,
        });
      }
      return { ok: true, ...cacheSitePolicy(), private: privateSitePolicy(), privateEffective: privateSiteEffective() };
    }
    const writes = [
      ['cacheSiteMode', next.mode],
      ['cacheSiteAllow', next.allow],
      ['cacheSiteBlock', next.block],
    ];
    const saved = saveCacheSitePolicy(next, 'normal');
    if (!saved.ok) return { ok: false, error: saved.error, ...cacheSitePolicy(), private: privateSitePolicy() };
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PAGE_CACHE_SITES_UPDATED', '离线缓存的站点名单已更新', {
        mode: next.mode,
        allow: next.allow.length,
        block: next.block.length,
      });
    }
    return { ok: true, ...next, private: privateSitePolicy() };
  });

  /**
   * 隐私模式名单的「只存这些」模板。
   *
   * 两条硬规矩写在这里而不是界面里：
   *   1. 模板只能并进现有名单（merge），绝不静默替换用户手写的那份；
   *   2. 套上模板会同时把模式切到「只存名单里的」，所以返回体要把 added / skipped 分开，
   *      界面必须逐项显示加了哪些，不能只弹一句「已应用」。
   */
  ipcMain.handle('nyx:offline:private-templates', () => {
    const custom = readCustomTemplates();
    return {
      ok: true,
      templates: describeSiteTemplates(custom),
      custom,
      current: privateSitePolicy(),
      effective: privateSiteEffective(),
    };
  });

  ipcMain.handle('nyx:offline:private-template-apply', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const key = String(input.key || '');
    // 默认合并；只有用户明确点「用它替换名单」才 replace（换掉别人手写的名单不能是默认行为）
    const switchMode = String(input.mode || 'merge') === 'replace';
    const custom = readCustomTemplates();
    const result = applySiteTemplate(privateSitePolicy(), key, custom, { mode: switchMode ? 'replace' : 'merge' });
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error, private: privateSitePolicy() };
    }
    const saved = saveCacheSitePolicy(result.policy, 'private');
    if (!saved.ok) {
      return { ok: false, error: saved.error, private: privateSitePolicy() };
    }
    // 可选：同一份模板顺手套到普通模式的名单上（候选③）。两份名单本来是分开的，
    // 所以这里单独报结果——普通那份失败不该把隐私那份说成失败，反之亦然。
    let normal = null;
    if (input.alsoNormal === true) {
      const normalPolicy = cacheSitePolicy();
      const applied = applySiteTemplate(normalPolicy, key, custom, { mode: switchMode ? 'replace' : 'merge' });
      if (!applied.ok) {
        normal = { ok: false, error: applied.error };
      } else {
        const savedNormal = saveCacheSitePolicy(applied.policy, 'normal');
        normal = savedNormal.ok
          ? { ok: true, added: applied.added.length, dropped: (applied.dropped || []).length, policy: applied.policy }
          : { ok: false, error: savedNormal.error };
        if (runtime.diagnostics) {
          runtime.diagnostics.info('CACHE_TEMPLATE_APPLIED_NORMAL', '普通模式名单也套用了同一份模板', {
            template: result.template.key,
            ok: normal.ok,
            added: applied.added.length,
          });
        }
      }
    }
    // 名单改完要说清「现在到底生效没有」——快照关着或加密不可用时，改了也不会有任何效果
    const effective = privateSiteEffective();
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PRIVATE_CACHE_TEMPLATE_APPLIED', '隐私模式名单套用了模板', {
        template: result.template.key,
        action: result.action,
        added: result.added.length,
        skipped: result.skipped.length,
        dropped: (result.dropped || []).length,
        modeChanged: result.modeChanged,
        effective: effective.active,
      });
    }
    const normalNote = normal
      ? normal.ok
        ? `\n普通模式的名单也按同一份模板处理了（加了 ${normal.added} 个${normal.dropped ? `，换掉 ${normal.dropped} 个` : ''}）。`
        : `\n普通模式的名单没改成：${normal.error}`
      : '';
    return {
      ok: true,
      template: result.template,
      action: result.action,
      added: result.added,
      skipped: result.skipped,
      dropped: result.dropped || [],
      modeChanged: result.modeChanged,
      normal,
      message: `${effective.active ? result.message : `${result.message}\n${effective.note}`}${normalNote}`,
      effective,
      private: privateSitePolicy(),
    };
  });

  /**
   * 把自己攒的那份名单存成模板（第八轮 ⑤）。
   *
   * 存的是**当前名单快照**，不存模式：模板的意思是"这些站点值得离线留"，
   * 模式是用户当下的选择，存进去会在套用时把人的选择覆盖掉。
   */
  ipcMain.handle('nyx:offline:private-template-save', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const result = addCustomTemplate(readCustomTemplates(), privateSitePolicy(), input.name, Date.now());
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: result.error,
        templates: describeSiteTemplates(result.templates),
        custom: result.templates,
        private: privateSitePolicy(),
      };
    }
    const saved = writeCustomTemplates(result.templates);
    if (!saved.ok) {
      return { ok: false, error: saved.error, custom: readCustomTemplates(), private: privateSitePolicy() };
    }
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PRIVATE_CACHE_TEMPLATE_SAVED', '把当前名单存成了自定义模板', {
        template: result.template.key,
        count: result.template.count,
      });
    }
    return {
      ok: true,
      template: result.template,
      templates: describeSiteTemplates(result.templates),
      custom: result.templates,
      message: `已存成模板「${result.template.label}」（${result.template.count} 个站点）。套用时会并进名单，不会替换你手写的那份。`,
      private: privateSitePolicy(),
    };
  });

  ipcMain.handle('nyx:offline:private-template-remove', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const result = removeCustomTemplate(readCustomTemplates(), String(input.key || ''));
    if (!result.ok) {
      return { ok: false, code: result.code, error: result.error, custom: readCustomTemplates() };
    }
    const saved = writeCustomTemplates(result.templates);
    if (!saved.ok) {
      return { ok: false, error: saved.error, custom: readCustomTemplates() };
    }
    if (runtime.diagnostics) {
      runtime.diagnostics.info('PRIVATE_CACHE_TEMPLATE_REMOVED', '删掉了一个自定义模板', {
        key: String(input.key || ''),
      });
    }
    return {
      ok: true,
      templates: describeSiteTemplates(result.templates),
      custom: result.templates,
      message: '已经删掉这个模板。名单本身没动。',
      private: privateSitePolicy(),
    };
  });

  /**
   * 名单搬走再搬回来（候选⑤）。
   *
   * 同步对话框：一旦返回 Promise 又会重演下载那个坑（窗口销毁、resolve 丢失）。
   * 导出写的是纯 JSON 文本，导入按 kind 校验类型——别把 agent 站点名单当缓存名单导入。
   */
  ipcMain.handle('nyx:offline:sites-export', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const scope = input.scope === 'private' ? 'private' : 'normal';
    const privateSide = scope === 'private';
    try {
      const policy = privateSide ? privateSitePolicy() : cacheSitePolicy();
      const target = dialog.showSaveDialogSync(runtime.win || undefined, {
        title: privateSide ? '导出隐私模式的站点名单' : '导出离线缓存的站点名单',
        defaultPath: path.join(
          app.getPath('documents'),
          `${privateSide ? 'nyx-private-cache-sites' : 'nyx-cache-sites'}-${new Date().toISOString().slice(0, 10)}.json`,
        ),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!target) return { ok: false, canceled: true, error: '已取消导出。' };
      const body = exportCacheSites(policy, Date.now(), scope);
      fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PAGE_CACHE_SITES_EXPORTED', '导出离线缓存站点名单', {
          scope,
          allow: body.allow.length,
          block: body.block.length,
        });
      }
      return { ok: true, scope, path: target, allow: body.allow.length, block: body.block.length };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_SITES_EXPORT_FAILED', '导出离线缓存站点名单失败', { scope, error: reason });
      return { ok: false, error: `没能导出名单：${reason}` };
    }
  });

  ipcMain.handle('nyx:offline:sites-import', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const scope = input.scope === 'private' ? 'private' : 'normal';
    const privateSide = scope === 'private';
    try {
      const picked = dialog.showOpenDialogSync(runtime.win || undefined, {
        title: privateSide ? '导入隐私模式的站点名单' : '导入离线缓存的站点名单',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!picked || !picked.length) return { ok: false, canceled: true, error: '已取消导入。' };
      const source = picked[0];
      let text;
      try {
        text = fs.readFileSync(source, 'utf8');
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        return { ok: false, error: `这个文件读不出来：${reason}` };
      }
      const result = importCacheSites(text, privateSide ? privateSitePolicy() : cacheSitePolicy(), {
        mode: input.mode === 'replace' ? 'replace' : 'merge',
        scope,
      });
      if (!result.ok) {
        if (runtime.diagnostics) {
          runtime.diagnostics.warn('PAGE_CACHE_SITES_IMPORT_REJECTED', '导入的缓存站点名单被拒绝', {
            scope,
            error: result.error,
          });
        }
        return { ok: false, error: result.error };
      }
      const saved = saveCacheSitePolicy(result.policy, scope);
      if (!saved.ok) return { ok: false, error: saved.error, scope };
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PAGE_CACHE_SITES_IMPORTED', '导入离线缓存站点名单', {
          scope,
          added: result.added,
          duplicates: result.duplicates,
          rejected: result.rejectedCount,
        });
      }
      return {
        ok: true,
        scope,
        imported: {
          path: source,
          mode: result.mode,
          added: result.added,
          duplicates: result.duplicates,
          rejected: result.rejected,
          rejectedCount: result.rejectedCount,
          summary: result.summary,
        },
        ...result.policy,
      };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      if (runtime.diagnostics) runtime.diagnostics.error('PAGE_CACHE_SITES_IMPORT_FAILED', '导入离线缓存站点名单失败', { scope, error: reason });
      return { ok: false, error: `没能导入名单：${reason}` };
    }
  });

  /**
   * 自定义模板搬走再搬回来（第九轮 ③）。
   *
   * 和站点名单分开两个 kind（`nyx-cache-templates` vs `nyx-cache-sites`）：
   * 模板是"清单的清单"，导错文件会变成一条叫 custom-xxx 的站点，用户还以为搬成功了。
   * 同样是同步对话框（异步会重演下载那个 Promise 永挂的坑）。
   */
  ipcMain.handle('nyx:offline:private-templates-export', () => {
    try {
      const custom = readCustomTemplates();
      if (!custom.length) {
        return { ok: false, code: 'NOTHING_TO_EXPORT', error: '还没有自定义模板，先把当前名单存成模板再导出。' };
      }
      const target = dialog.showSaveDialogSync(runtime.win || undefined, {
        title: '导出自定义模板',
        defaultPath: path.join(app.getPath('documents'), `nyx-cache-templates-${new Date().toISOString().slice(0, 10)}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!target) return { ok: false, canceled: true, error: '已取消导出。' };
      const body = exportCustomTemplates(custom, Date.now());
      fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PRIVATE_CACHE_TEMPLATES_EXPORTED', '导出自定义模板', { count: body.count });
      }
      return { ok: true, path: target, count: body.count };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      if (runtime.diagnostics) runtime.diagnostics.error('PRIVATE_CACHE_TEMPLATES_EXPORT_FAILED', '导出自定义模板失败', { error: reason });
      return { ok: false, error: `没能导出模板：${reason}` };
    }
  });

  ipcMain.handle('nyx:offline:private-templates-import', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    try {
      const picked = dialog.showOpenDialogSync(runtime.win || undefined, {
        title: '导入自定义模板',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!picked || !picked.length) return { ok: false, canceled: true, error: '已取消导入。' };
      const source = picked[0];
      let text;
      try {
        text = fs.readFileSync(source, 'utf8');
      } catch (err) {
        const reason = err && err.message ? err.message : String(err);
        return { ok: false, error: `这个文件读不出来：${reason}` };
      }
      const result = importCustomTemplates(text, readCustomTemplates(), {
        mode: input.mode === 'replace' ? 'replace' : 'merge',
      });
      if (!result.ok) {
        if (runtime.diagnostics) {
          runtime.diagnostics.warn('PRIVATE_CACHE_TEMPLATES_IMPORT_REJECTED', '导入的自定义模板被拒绝', { error: result.error });
        }
        return { ok: false, error: result.error, custom: readCustomTemplates() };
      }
      const saved = writeCustomTemplates(result.templates);
      if (!saved.ok) return { ok: false, error: saved.error, custom: readCustomTemplates() };
      if (runtime.diagnostics) {
        runtime.diagnostics.info('PRIVATE_CACHE_TEMPLATES_IMPORTED', '导入自定义模板', {
          added: result.added,
          duplicates: result.duplicates,
          rejected: result.rejectedCount,
        });
      }
      return {
        ok: true,
        path: source,
        mode: result.mode,
        added: result.added,
        duplicates: result.duplicates,
        rejected: result.rejected,
        rejectedCount: result.rejectedCount,
        summary: result.summary,
        templates: describeSiteTemplates(result.templates),
        custom: result.templates,
      };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      if (runtime.diagnostics) runtime.diagnostics.error('PRIVATE_CACHE_TEMPLATES_IMPORT_FAILED', '导入自定义模板失败', { error: reason });
      return { ok: false, error: `没能导入模板：${reason}` };
    }
  });
}

/** 网络与代理相关的 IPC 通道（与 preload.js 暴露的方法一一对应） */
function registerProxyIpc() {
  const missing = { ok: false, error: '代理服务尚未初始化' };

  ipcMain.handle('nyx:proxy:open', (_event, payload) => openSettings(payload && payload.section));

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
      // v1.17.9（清单 A4）：网络面板要能「锁定某个标签」，就必须知道现在有哪些标签、
      // 各自对应哪个 webContents——只给活动标签的话，锁定后没法判断锁的那个还在不在。
      tabs: (runtime.tabManager && Array.isArray(runtime.tabManager.tabs) ? runtime.tabManager.tabs : [])
        .filter((tab) => tab && tab.view && !tab.view.webContents.isDestroyed())
        .map((tab) => ({
          id: tab.id,
          wcId: tab.view.webContents.id,
          title: tab.title || '新标签页',
          active: tab.id === runtime.tabManager.activeId,
        })),
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

  /* ---- agent 导航预算（v1.17.17）：设置页读写，动作通道每次导航前问它 ---- */

  ipcMain.handle('nyx:tb:navigate-timeout', () => {
    const prefs = readToolboxPrefs();
    return {
      ok: true,
      navigateTimeoutMs: prefs.navigateTimeoutMs,
      min: NAVIGATE_BUDGET_MIN,
      max: NAVIGATE_BUDGET_MAX,
      fallback: NAVIGATE_BUDGET_DEFAULT,
      example: describeNavigateBudget(prefs.navigateTimeoutMs),
      // 按站点覆盖（用户要求）：给界面回一份"可直接编辑的多行文本"，省得界面自己拼
      sites: prefs.navigateTimeoutSites,
      sitesText: formatSiteRules(prefs.navigateTimeoutSites),
    };
  });

  ipcMain.handle('nyx:tb:navigate-timeout-set', (_event, payload) => {
    const value = normalizeNavigateTimeout(payload && payload.navigateTimeoutMs);
    if (value == null) {
      return {
        ok: false,
        error: `导航预算需要是 ${NAVIGATE_BUDGET_MIN / 1000}–${NAVIGATE_BUDGET_MAX / 1000} 秒之间的整数毫秒数`,
      };
    }
    /**
     * 站点规则（用户要求：慢站单独放宽，不把全局值调大）。
     * 只有真的传了 sitesText 才动这张表——不然只改全局值会把已配好的站点冲掉。
     */
    const patch = { navigateTimeoutMs: value };
    let parsed = null;
    if (payload && typeof payload.sitesText === 'string') {
      parsed = parseSiteRules(payload.sitesText);
      if (parsed.errors.length) {
        return { ok: false, error: parsed.errors[0], errors: parsed.errors };
      }
      patch.navigateTimeoutSites = parsed.rules;
    }
    const prefs = writeToolboxPrefs(patch);
    if (!prefs) return { ok: false, error: '写入失败' };
    diagnostics.info(
      'NAVIGATE_BUDGET_UPDATED',
      `agent 导航预算改成 ${describeNavigateBudget(value)}` +
        (parsed ? `，按站点 ${parsed.rules.length} 条` : ''),
      { navigateTimeoutMs: value, sites: prefs.navigateTimeoutSites.length }
    );
    return {
      ok: true,
      navigateTimeoutMs: prefs.navigateTimeoutMs,
      example: describeNavigateBudget(value),
      sites: prefs.navigateTimeoutSites,
      sitesText: formatSiteRules(prefs.navigateTimeoutSites),
      rewritten: parsed ? parsed.rewritten : [],
    };
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
    // 安全审计 P1-2：控制台执行脚本只许对**当前活动标签**做。
    // 以前传什么 wcId 就在那个 webContents 里执行——外壳一旦被导航走（P0-1）
    // 就等于远程页面能拿它去改任意标签。现在显式拒绝非活动标签。
    const requested = payload && payload.wcId;
    const asked = requested == null || requested === '' ? null : Number(requested);
    const active = activeWcId();
    if (asked != null && Number.isFinite(asked) && active != null && asked !== active) {
      return {
        ok: false,
        code: 'NOT_ACTIVE_TAB',
        error: '控制台脚本只能对当前活动标签执行：先切到那个标签再执行，或直接用 agent 的动作通道（会经过确认与留痕）。',
      };
    }
    return runtime.pageTools.evalScript(active, payload && payload.expression);
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

  ipcMain.handle('nyx:tb:copy', async (_event, payload) => {
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text) return { ok: false, error: '没有可复制的内容' };
    try {
      await writeClipboardText(text.slice(0, 512 * 1024));
    } catch (err) {
      return { ok: false, error: `写入剪贴板失败：${err && err.message}` };
    }
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

  /**
   * 差分命中率实测：只在用户点「实测一次」时跑（要读两个约 120 MB 的安装包），
   * 结果落 `<userData>/delta-report.json`，下次打开卡片直接显示上次的数字。
   * 返回值额外带 `freshness`：刚量完就是 current，但界面统一用同一个判定，
   * 免得"刚量的"和"打开卡片时读到的"两套口径对不上。
   */
  ipcMain.handle('nyx:update:delta-check', async (_event, payload) => {
    const report = await measureDeltaHitRate({ blockSize: payload && payload.blockSize });
    const currentVersion = latestVersionInSource();
    return {
      ...report,
      freshness: describeDeltaFreshness(report, { currentVersion, staleDays: STALE_DAYS }),
    };
  });

  /**
   * 夜间安装器 e2e 的最近一次结果（候选③）。
   * 数据源是 `scripts/nightly-e2e.js --run` 写下的 `<userData>/nightly-e2e.json`——
   * 读取失败不当"没跑过"，而是如实说"读不出来"：两者对用户是不同的处置。
   */
  ipcMain.handle('nyx:nightly:status', () => {
    const file = userDataFile(NIGHTLY_STATUS_FILE);
    let raw = null;
    let readError = '';
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error && error.code !== 'ENOENT') readError = String(error.message || error);
    }
    const described = describeNightlyStatus(raw, { now: Date.now() });
    return {
      ...described,
      file,
      readError,
      ok: readError ? false : described.ok,
      level: readError ? 'unknown' : described.level,
      text: readError
        ? `夜间 e2e 的状态文件读不出来（${readError}）。它应该在 ${file}；没有这个文件说明这台机器还没跑过。`
        : described.text,
    };
  });

  /**
   * 计划任务的管理入口（第九轮 ② 补的界面部分）。
   *
   * 三条纪律写在代码里，别在界面上放宽：
   *   1. 注册 / 删除之后必须**再查一遍**：`schtasks` 说成功不等于真成了；
   *   2. 安装版里没有 `scripts/`，一律如实说"不支持"，不注册一个指向不存在文件的任务；
   *   3. 这里只改「什么时候跑」，**不给「现在就跑一次」**——那是另一件事（跑一次要占机器十几分钟）。
   */
  function runNightlySchtasks(args) {
    let res = null;
    try {
      res = spawnSync('schtasks', args, { encoding: 'buffer', windowsHide: true, timeout: 20000 });
    } catch (error) {
      return { ok: false, code: -1, output: '', error: `没能启动 schtasks：${String((error && error.message) || error)}` };
    }
    if (res && res.error) {
      return { ok: false, code: -1, output: '', error: `没能启动 schtasks：${String(res.error.message || res.error)}` };
    }
    return {
      ok: true,
      code: typeof res.status === 'number' ? res.status : -1,
      output: decodeNightlyConsole(res.stdout).trim(),
      error: decodeNightlyConsole(res.stderr).trim(),
    };
  }

  /** 查一次真实状态（stdout 与 stderr 一起看：找不到任务时 schtasks 把话写在 stderr） */
  function queryNightlyTask() {
    const built = buildNightlyQueryArgs({ taskName: NIGHTLY_TASK_NAME });
    const run = runNightlySchtasks(built.args);
    const text = `${run.output}\n${run.error}`.trim();
    if (!run.ok) return { ok: false, registered: false, error: run.error };
    return parseNightlyQueryOutput(text);
  }

  /** 找出能跑夜间 e2e 的 node 与脚本（找不到就说清找过哪里） */
  function resolveNightlyNode() {
    const paths = resolveNightlyTaskPaths({
      isPackaged: app.isPackaged,
      sourceRoot: path.join(__dirname, '..'),
    });
    if (!paths.ok) return paths;
    for (const candidate of paths.candidates) {
      try {
        if (candidate && fs.existsSync(candidate)) {
          return { ok: true, node: candidate, script: paths.script };
        }
      } catch {
        // 读不到就当这个候选不存在，继续下一个
      }
    }
    return {
      ok: false,
      code: 'NO_NODE',
      error: `找不到 node.exe（找过 ${paths.candidates.join(' 和 ')}）。计划任务要用绝对路径，把 Node 装到默认位置，或者用命令行 node scripts/nightly-e2e.js --register --apply。`,
    };
  }

  function nightlyTaskPayload() {
    const task = queryNightlyTask();
    const described = describeNightlyTask(task, { taskName: NIGHTLY_TASK_NAME });
    const paths = resolveNightlyNode();
    return {
      ok: paths.ok !== false,
      taskName: NIGHTLY_TASK_NAME,
      level: described.level,
      text: described.text,
      registered: task && task.ok === true ? Boolean(task.registered) : null,
      nextRun: (task && task.nextRun) || '',
      queryError: (task && task.ok === true) ? '' : (task && task.error) || '',
      schedulable: paths.ok === true,
      schedulableError: paths.ok === true ? '' : paths.error,
      node: paths.ok === true ? paths.node : '',
      script: paths.ok === true ? paths.script : '',
      defaultTime: normalizeNightlyTime(''),
    };
  }

  ipcMain.handle('nyx:nightly:task', () => nightlyTaskPayload());

  ipcMain.handle('nyx:nightly:task-set', (_event, payload) => {
    const input = payload || {};
    const paths = resolveNightlyNode();
    const before = nightlyTaskPayload();
    if (!paths.ok) {
      return { ...before, ok: false, error: paths.error, action: 'register' };
    }
    if (!isValidNightlyTime(input.time)) {
      return {
        ...before,
        ok: false,
        action: 'register',
        error: '时间要写成 24 小时制的「时:分」，例如 03:30 或 22:10。',
      };
    }
    const built = buildNightlyRegisterArgs({
      node: paths.node,
      script: paths.script,
      taskName: NIGHTLY_TASK_NAME,
      time: input.time,
      elevated: Boolean(input.elevated),
    });
    if (!built.ok) {
      return { ...before, ok: false, action: 'register', error: built.error };
    }
    const run = runNightlySchtasks(built.args);
    const verify = queryNightlyTask();
    const described = describeNightlyTaskAction('register', { ...run, taskName: NIGHTLY_TASK_NAME }, verify);
    if (described.ok) {
      diagnostics.info('NIGHTLY_TASK_REGISTERED', `夜间计划任务已注册（每天 ${built.time}）`, { time: built.time, elevated: built.elevated });
    } else {
      diagnostics.error('NIGHTLY_TASK_REGISTER_FAILED', `夜间计划任务没能注册（每天 ${built.time}）`, { output: run.output, error: run.error });
    }
    return {
      ok: described.ok,
      action: 'register',
      text: described.text,
      error: described.ok ? '' : described.text,
      time: built.time,
      elevated: built.elevated,
      ...nightlyTaskPayload(),
    };
  });

  ipcMain.handle('nyx:nightly:task-remove', () => {
    const before = nightlyTaskPayload();
    const built = buildNightlyDeleteArgs({ taskName: NIGHTLY_TASK_NAME });
    const run = runNightlySchtasks(built.args);
    const verify = queryNightlyTask();
    const described = describeNightlyTaskAction('remove', { ...run, taskName: NIGHTLY_TASK_NAME }, verify);
    if (described.ok) {
      diagnostics.info('NIGHTLY_TASK_REMOVED', '夜间计划任务已删除', {});
    } else {
      diagnostics.error('NIGHTLY_TASK_REMOVE_FAILED', '夜间计划任务没能删除', { output: run.output, error: run.error });
    }
    return {
      ok: described.ok,
      action: 'remove',
      text: described.text,
      error: described.ok ? '' : described.text,
      ...before,
      ...nightlyTaskPayload(),
    };
  });

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
  ipcMain.handle('nyx:update:copy-clean-command', async () => {
    const command = updateCleanCommand();
    try {
      await writeClipboardText(command);
    } catch (err) {
      return { ok: false, error: `写入剪贴板失败：${err.message}`, command };
    }
    return { ok: true, command };
  });

  ipcMain.handle('nyx:update:about', () => showAboutDialog());

  ipcMain.handle('nyx:update:set-source', (_event, payload) => {
    if (!runtime.updater) return missing;
    const source = String((payload && payload.source) || '').trim();
    // 安全审计 P0-2：不是"填了就算"，先过准入（https / 显式确认的本地目录 / 版本单调）
    const verdict = decideUpdateSource(source, { allowLocal: payload && payload.allowLocal === true });
    if (!verdict.ok) {
      diagnostics.warn('UPDATE_SOURCE_REJECTED', verdict.error || '更新源被拒绝', {
        code: verdict.code,
        source: source.slice(0, 80),
      });
      return { ok: false, code: verdict.code, needsLocalAck: Boolean(verdict.needsLocalAck), error: verdict.error };
    }
    const autoCheck = payload && payload.autoCheck;
    const config = runtime.updater.writeConfig({
      source: verdict.source,
      ...(typeof autoCheck === 'boolean' ? { autoCheck } : {}),
    });
    if (verdict.kind === 'local') {
      // 本地源是显式确认过的，但每次设置都要让用户看见它的代价
      notifyNotice({
        level: 'warn',
        title: '已改用本地更新源',
        message: '任何能写这个目录的程序都能换掉升级包；只在你自己这台机器上用。',
      });
    }
    return { ok: true, config, kind: verdict.kind };
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
    { label: `恐慌清场（${runtime.panicShortcut || PANIC_SHORTCUT}）`, click: () => panic() },
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
  // 与 agent 急停同一套口径：首选被占用就依次试备用键，换了谁就说谁。
  // 恐慌清场是"出事时唯一还来得及的那一下"，默默失效比没有更危险。
  const candidates = shortcutCandidates(PANIC_SHORTCUT, PANIC_FALLBACKS);
  const tried = [];
  let effective = '';

  for (const candidate of candidates) {
    tried.push(candidate);
    let ok = false;
    try {
      ok = globalShortcut.register(candidate, () => panic());
    } catch (err) {
      console.warn(`[Nyx] 恐慌快捷键 ${candidate} 注册时抛错：`, err.message);
      ok = false;
    }
    if (ok) {
      effective = candidate;
      break;
    }
  }

  runtime.panicShortcut = effective;
  const verdict = describeShortcutResult({ preferred: PANIC_SHORTCUT, effective, tried });
  if (verdict.code === 'PREFERRED') {
    console.log(`[Nyx] ${verdict.message}`);
  } else if (verdict.code === 'FALLBACK') {
    console.warn(`[Nyx] 恐慌快捷键换了（首选 ${PANIC_SHORTCUT} 被占用）：${effective}`);
    diagnostics.warn('PANIC_SHORTCUT_FALLBACK', '首选恐慌快捷键被占用，已换成备用键', {
      preferred: PANIC_SHORTCUT,
      effective,
    });
    notifyNotice({
      level: 'warn',
      code: 'PANIC_SHORTCUT_FALLBACK',
      title: `恐慌清场改用 ${effective}`,
      message: `首选键 ${PANIC_SHORTCUT} 已被其他程序占用，所以换成了 ${effective}。这个键按下会立刻关窗并清场。`,
    });
  } else {
    console.warn(`[Nyx] ${verdict.message}`);
    diagnostics.warn('PANIC_SHORTCUT_FAILED', '恐慌快捷键一个都注册不上', { tried });
    notifyNotice({
      level: 'error',
      code: 'PANIC_SHORTCUT_FAILED',
      title: '恐慌快捷键不可用',
      message: `试过的键都被别的程序占着（${tried.join('、') || '无'}）。暂时只能用托盘菜单里的「恐慌清场」。`,
    });
  }
}

/**
 * agent 急停快捷键（清单 D）。
 *
 * 注册失败不能静默：那样用户以为有热键、按下去没反应，比没有更糟。
 * 所以：首选被占用时**先按顺序试备用键**，换成了谁就明说（日志 + 诊断 + 前台提示）；
 * 一个都注册不上才退到"只有工具栏按钮"，同样当面告知。
 */
function registerAgentStopShortcut() {
  const candidates = shortcutCandidates(AGENT_STOP_SHORTCUT);
  const tried = [];
  let effective = '';

  for (const candidate of candidates) {
    tried.push(candidate);
    let ok = false;
    try {
      ok = globalShortcut.register(candidate, () => {
        stopAgent('快捷键紧急停止');
      });
    } catch (err) {
      console.warn(`[Nyx] 急停快捷键 ${candidate} 注册时抛错：`, err.message);
      ok = false;
    }
    if (ok) {
      effective = candidate;
      break;
    }
  }

  const verdict = describeShortcutResult({ preferred: AGENT_STOP_SHORTCUT, effective, tried });
  runtime.agentStopShortcut = effective;
  runtime.agentStopShortcutOk = Boolean(effective);

  console.log(`[Nyx] ${verdict.message}`);
  if (verdict.code === 'FALLBACK') {
    console.warn(`[Nyx] agent 急停快捷键换了（首选 ${AGENT_STOP_SHORTCUT} 被占用）：${effective}`);
    diagnostics.warn('AGENT_STOP_SHORTCUT_FALLBACK', '首选急停快捷键被占用，已换成备用键', {
      preferred: AGENT_STOP_SHORTCUT,
      effective,
    });
  } else if (verdict.code === 'NONE') {
    diagnostics.warn('AGENT_STOP_SHORTCUT_FAILED', 'agent 急停快捷键一个都注册不上', { tried });
  }

  if (verdict.notice) {
    notifyNotice({ level: verdict.ok ? 'warn' : 'error', code: 'AGENT_STOP_SHORTCUT_' + verdict.code, ...verdict.notice });
  }
  return Boolean(effective);
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
    // 设置已经是主窗口里的一个标签，随主窗口一起销毁，不需要单独处理
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

/**
 * 读取站点设备授权白名单。
 * 文件不存在 → 空名单；文件读坏 → 空名单 + 可展示的错误，绝不把"读不懂"当成"全部允许"。
 */
function loadPermissionWhitelist() {
  try {
    const parsed = parsePermissionWhitelist(fs.readFileSync(userDataFile('permission-whitelist.json'), 'utf8'));
    if (parsed.error) console.warn(`[Nyx] ${parsed.error}`);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], error: '' };
    const error = `站点设备白名单读取失败：${err.message}`;
    console.warn(`[Nyx] ${error}`);
    return { entries: [], error };
  }
}

/** 原子写白名单：先写临时文件再改名，避免写一半留下坏 JSON */
function savePermissionWhitelist(entries) {
  const file = userDataFile('permission-whitelist.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializePermissionWhitelist(entries), { mode: 0o600 });
  fs.renameSync(tmp, file);
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

/* ------------------------------------------------------------------ */
/* 统一动作通道（清单 C）                                              */
/* ------------------------------------------------------------------ */

/** 当前站点：授权按站点归类、留痕也按站点筛，所以每次动作都取一次活动标签的 host */
function currentAgentSite() {
  try {
    const manager = runtime.tabManager;
    if (!manager) return '';
    // 安全审计 P1-3：以 webContents 自己报的地址为唯一权威。
    // snapshot() 里的 url 是标签管理器记下的字符串，可能落后于真实的最后一次提交
    // （重定向、history.replaceState、脚本改地址都会让两者分叉），
    // 用它会拿旧站点去做授权，等于按错误的对象放行。
    const wc = manager.getActiveWebContents();
    if (wc && !wc.isDestroyed()) {
      const live = wc.getURL();
      if (live) {
        const parsed = new URL(live);
        if (parsed.host) return parsed.host;
      }
    }
    const snap = manager.snapshot();
    const active = (snap.tabs || []).find((tab) => tab.active);
    if (!active || !active.url) return '';
    const url = new URL(active.url);
    return url.host || '';
  } catch {
    return '';
  }
}

/** 从一条 URL 里取站点（只用于「要去的地方」判定；取不到返回空串） */
function siteOfUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // 裸域名（example.com、example.com:8080、//example.com）按 https 处理。
  // 否则 new URL() 直接抛错，navigate 会在授权阶段被判成"地址看不懂"，
  // 或回落到当前页站点，出现"在空白页/设置页上怎么都跳不过去"。
  const hasScheme =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(?:javascript|data|blob|file|about|mailto|tel):/i.test(text);
  const candidate = hasScheme ? text : text.startsWith('//') ? `https:${text}` : `https://${text}`;
  try {
    const url = new URL(candidate);
    return url.host || '';
  } catch {
    return '';
  }
}

/** 名单落盘（清单 E）。读不懂就当没配过，但**不许**把坏文件当成"全部放行" */
function readAgentSites() {
  try {
    const file = userDataFile('agent-sites.json');
    if (!fs.existsSync(file)) return sanitizeSitePolicy(null);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitizeSitePolicy(raw);
  } catch (err) {
    console.warn('[Nyx] agent 站点名单读取失败，按空名单启动：', err && err.message ? err.message : err);
    diagnostics.warn('AGENT_SITES_READ_FAILED', '站点名单读取失败，按空名单启动', {
      error: err && err.message ? err.message : String(err),
    });
    return sanitizeSitePolicy(null);
  }
}

function writeAgentSites(policy) {
  const safe = sanitizeSitePolicy(policy);
  runtime.agentSites = safe;
  try {
    fs.writeFileSync(userDataFile('agent-sites.json'), `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[Nyx] agent 站点名单保存失败：', err && err.message ? err.message : err);
    diagnostics.error('AGENT_SITES_SAVE_FAILED', '站点名单没能保存到磁盘', {
      error: err && err.message ? err.message : String(err),
    });
  }
  return safe;
}

/**
 * 进站确认（清单 E 的第三层）。
 * 用户勾了「这次会话信任该域名」就只记在内存里——重启 Nyx 必须重新确认，
 * 因为"上次点过同意"不能代表"这次也想让它动"。
 */
async function askAgentSiteTrust(input) {
  const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
  const host = (input && input.host) || '';
  const detail = [
    `${host} 既不在白名单也不在屏蔽名单里。`,
    '允许一次：只在这次动作上放行，下一个动作还会再问。',
    '信任该域名：本次会话内这个站点不再逐次询问（重启 Nyx 后失效）。',
    '白名单 / 屏蔽名单在「设置 → Agent 访问」里维护；屏蔽名单永远优先。',
    '白名单只代表"站点可以操作"，输入文字、下载这类动作仍会单独问你。',
  ].join('\n');

  try {
    const answer = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Nyx · agent 想在这个站点上操作',
      message: `agent 想在 ${host} 上执行「${(input && input.label) || '动作'}」`,
      detail,
      buttons: ['拒绝', '允许这一次'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      checkboxLabel: '这次会话信任该域名（重启后失效）',
      checkboxChecked: false,
    });
    const approved = answer.response === 1;
    const remember = approved && Boolean(answer.checkboxChecked);
    diagnostics.info(
      'AGENT_SITE_CONFIRM',
      approved ? (remember ? `用户信任了 ${host}（本次会话）` : `用户只放行了 ${host} 的这一次动作`) : `用户拒绝了 ${host}`,
      { host, approved, remember },
    );
    return {
      approved,
      remember,
      reason: approved ? '' : '用户在进站确认框里选择了拒绝',
    };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    diagnostics.error('AGENT_SITE_CONFIRM_FAILED', '进站确认框没能弹出来', { host, error: message });
    return { approved: false, remember: false, reason: `进站确认框没能弹出来：${message}` };
  }
}

/**
 * 权限判定 = 站点三层授权（清单 E）。
 * 注意：**站点放行不等于动作放行**——确认规则（输入、下载）在通道里独立执行，白名单不豁免。
 */

/** 隐私模式下直接拒绝的 agent 动作（安全审计 P2）：它们天生就是"把页面内容带出去" */
const PRIVATE_MODE_AGENT_BLOCKED = new Set(['screenshot', 'readPage', 'extractText']);
async function authorizeAgentAction(action, ctx) {
  const type = action && action.type ? action.type : '';
  const site = (ctx && ctx.site) || '';
  const params = (action && action.params) || {};
  // 安全审计 P2：隐私模式下不许 agent 截图或读页面。
  // 这两类动作的意义就是"把页面内容拿出来"，而隐私模式的承诺是"这一页不留痕"——
  // 内容一旦进了 agent 的上下文与留痕，承诺就不成立了。要读就退出隐私模式再读。
  if (PRIVATE_MODE_AGENT_BLOCKED.has(type) && sessions.getMode() === 'private') {
    return {
      decision: 'deny',
      reason: '隐私模式下不允许 agent 截图或读取页面内容：它会离开"这一页不留痕"的范围。退出隐私模式再做。',
      rule: 'private-mode',
    };
  }
  // 安全审计 P2：`state` 只是"现在是什么模式、开了几个标签"，不读页面内容，
  // 也就不该被站点授权拦下（否则空白页 / 启动页上 agent 连自己的状态都查不到）。
  if (type === 'state') {
    return { decision: 'allow', reason: '只读运行状态，不涉及页面内容', rule: 'state-readonly' };
  }
  // 安全审计 P1-3：navigate 要按「要去的地方」判定，不是按「现在在哪」判定。
  // 以前 authorize 拿到的是当前页 host，于是"在已信任的站点上让 agent 跳到屏蔽站点"
  // 会被放行——屏蔽名单对 navigate 形同不存在。
  const targetSite = type === 'navigate' ? siteOfUrl(params.url) : '';
  const judgeSite = targetSite || site;
  const verdict = evaluateSite({
    site: judgeSite,
    policy: runtime.agentSites || sanitizeSitePolicy(null),
    sessionTrusted: runtime.agentSessionTrust || [],
  });
  if (type === 'navigate' && !targetSite && params.url) {
    // 地址不合法就别猜：直接拒绝并说清原因（同一套失败关闭原则）
    return {
      decision: 'deny',
      reason: `要打开的地址看不懂，没法判断站点：${String(params.url).slice(0, 120)}`,
      rule: 'navigate-bad-url',
    };
  }

  if (verdict.decision === 'allow') {
    diagnostics.info('AGENT_AUTHORIZE', `${type} 放行（${verdict.layer}）`, {
      site: verdict.host,
      from: site,
      decision: 'allow',
      layer: verdict.layer,
      rule: verdict.reason,
    });
    return { decision: 'allow', reason: verdict.message, rule: verdict.layer };
  }

  if (verdict.decision === 'deny') {
    diagnostics.warn('AGENT_AUTHORIZE', `${type} 被拒绝（${verdict.layer}）`, {
      site: verdict.host,
      from: site,
      decision: 'deny',
      layer: verdict.layer,
      rule: verdict.reason,
    });
    // 跳到屏蔽站点时把话说全：用户屏蔽的是"这个站点"，不是在屏蔽"从哪跳过去"
    const extra = targetSite && targetSite !== site
      ? `（要打开的是 ${targetSite}，当前页是 ${site || '空白页'}）`
      : '';
    return { decision: 'deny', reason: `${verdict.message}${extra}`, rule: verdict.layer };
  }

  // 未命中任何名单 → 进站问一次
  const answer = await askAgentSiteTrust({ host: verdict.host, label: type });
  if (!answer.approved) {
    return { decision: 'deny', reason: answer.reason, rule: 'site-denied' };
  }
  if (answer.remember) {
    runtime.agentSessionTrust = addSessionTrust(runtime.agentSessionTrust, verdict.host).hosts;
    return {
      decision: 'allow',
      reason: `${verdict.host} 已被你信任（本次会话有效）`,
      rule: 'session-trusted',
    };
  }
  return { decision: 'allow', reason: `你只放行了 ${verdict.host} 上的这一次动作`, rule: 'site-approved-once' };
}

/**
 * 人工确认（清单 C 的最小实现：系统弹窗）。
 * 清单 E 会把这里换成自绘窗口 + 站点三层授权，但「必须人工点一次」这条不变。
 */
async function confirmAgentAction(request) {
  const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
  const masked = request && request.params ? request.params.text : null;
  const detail = [
    request.why,
    `站点：${request.site || '（未知）'}`,
    `目标：${request.target || '（未指定）'}`,
    masked && masked.masked
      ? `要输入的内容：${masked.length} 个字符（不显示内容，留痕里也只记长度）`
      : '',
    '拒绝后这次动作不会执行，页面上不会发生任何变化。',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Nyx · agent 请求操作',
      message: request.type === 'type' ? 'agent 想在页面里输入文字' : 'agent 想执行一个需要你确认的动作',
      detail,
      buttons: ['拒绝', '允许这一次'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    const approved = answer.response === 1;
    diagnostics.info('AGENT_CONFIRM_ANSWERED', approved ? '用户允许了这次动作' : '用户拒绝了这次动作', {
      type: request.type,
      site: request.site,
      target: request.target,
    });
    return { approved, reason: approved ? '' : '用户在确认框里选择了拒绝' };
  } catch (err) {
    return { approved: false, reason: `确认框没能弹出来：${err.message}` };
  }
}

/**
 * 审计写入（清单 D）：
 *   1. 进 AgentAudit（内存环形缓冲 + `<userData>/agent-audit.jsonl` 追加），界面与导出都读它；
 *   2. 同时进诊断日志，方便 C1 的诊断包一起带走。
 * 两条路都要走：审计面挂了还有诊断，诊断挂了审计落盘还在。
 */
function recordAgentAudit(entry) {
  const record = entry || {};
  if (runtime.agentAudit) runtime.agentAudit.record(record);
  // 清单 G 的关键例外：agent 刚操作过的标签不许休眠，有 agent 会话在跑时谁也不许睡。
  // 放在审计入口统一打点，任何动作（含下载这类 observe）都会顺带续命。
  touchAgentSession(record);
  const code = record.code ? record.code : record.rule ? record.rule : '';
  const summary = `${record.type || '未知动作'} · ${record.decision || '?'}${code ? ` · ${code}` : ''}`;
  const payload = {
    id: record.id,
    stage: record.stage,
    site: record.site || '',
    target: record.target || '',
    ok: record.ok !== false,
    error: record.error || '',
    elapsedMs: record.elapsedMs || 0,
    confirmedBy: record.confirmedBy || '',
    sensitive: record.sensitive === true,
  };
  if (record.ok === false) diagnostics.warn('AGENT_ACTION', summary, payload);
  else diagnostics.info('AGENT_ACTION', summary, payload);
}

/**
 * agent 活动的"续命"打点（清单 G）。
 *
 * 两个效果：
 *   1. 让刚被操作的那张标签在一段时间内不进休眠；
 *   2. 只要还在持续收到 agent 动作，就把"有 agent 会话"保持为真——这段时间内
 *      所有标签都不休眠，否则 agent 读到一半页面被释放，后续动作全砸。
 * 会话标志用一个空闲计时器复位：没有新动作满 AGENT_SESSION_IDLE_MS 就恢复休眠能力。
 */
const AGENT_SESSION_IDLE_MS = 60 * 1000;

function touchAgentSession(record) {
  const manager = runtime.tabManager;
  if (!manager) return;
  const stage = record && record.stage;
  // 清单 A5：只有"真的在执行动作"才点亮状态灯。authorize/confirm 是在问人，
  // result/observe 是回执——把它们算进"正在被驱动"会让灯一直亮着，灯就没意义了。
  if (stage === 'execute') {
    runtime.agentDrivingUntil = Date.now() + AGENT_LAMP_ACTIVE_MS;
  }
  // authorize/confirm 还没真正碰页面，只有真的执行或观察到动作才续命
  if (stage === 'execute' || stage === 'result' || stage === 'observe') {
    manager.markAgentDriven(undefined, AGENT_KEEP_AWAKE_MS);
    manager.setAgentSessionActive(true);
    if (runtime.agentSessionTimer) clearTimeout(runtime.agentSessionTimer);
    runtime.agentSessionTimer = setTimeout(() => {
      runtime.agentSessionTimer = null;
      if (runtime.tabManager) runtime.tabManager.setAgentSessionActive(false);
    }, AGENT_SESSION_IDLE_MS);
    if (typeof runtime.agentSessionTimer.unref === 'function') runtime.agentSessionTimer.unref();
  }
}

/**
 * 状态灯快照（清单 A5）。
 *
 * 「有没有 agent 接入」看本地接口是否在听；「是不是正在被驱动」只看
 * `runtime.agentDrivingUntil`——那是 execute 阶段打的时间戳，几秒就过期。
 * 「审计不完整」是另一件事，由 modeInfo / 外壳常驻标识负责，不混进灯里。
 */
function buildAgentLamp() {
  const api = runtime.localApi;
  const listening = Boolean(api && api.listening);
  let lastAction = '';
  if (runtime.agentAudit) {
    const listed = runtime.agentAudit.list({ limit: 1 });
    const row = listed && listed.rows && listed.rows[0];
    if (row) {
      const when = row.time || '';
      const what = row.type || '动作';
      const where = row.site ? ` @ ${row.site}` : '';
      lastAction = `${when} ${what}${where}`.trim();
    }
  }
  return describeLamp(
    decideLamp({
      agentStopped: runtime.agentStopped === true,
      enabled: listening,
      drivingUntil: runtime.agentDrivingUntil || 0,
    }),
    {
      lastAction,
      auditComplete: (runtime.agentMode || 'builtin') === 'builtin',
    },
  );
}

/** 急停状态快照：界面角标、设置页、诊断都读这一份 */
function agentStatusPayload() {
  const dispatcher = runtime.agentDispatcher;
  const inner = dispatcher && typeof dispatcher.status === 'function' ? dispatcher.status() : null;
  return {
    ok: true,
    stopped: runtime.agentStopped === true,
    stopReason: runtime.agentStopReason || '',
    stopAt: runtime.agentStopAt || 0,
    stopShortcut: runtime.agentStopShortcut || AGENT_STOP_SHORTCUT,
    mode: runtime.agentMode || 'builtin',
    // 内部接入模式的完整状态（清单 A）：审计是否完整、要不要重启、外部模式的端点
    modeInfo: agentModeStatus(),
    channel: inner || null,
    audit: runtime.agentAudit ? runtime.agentAudit.stats() : null,
    // 清单 A5：三色灯（未接入 / 空闲 / 正在被驱动）
    lamp: buildAgentLamp(),
  };
}

/** 把急停状态推给外壳与设置页（设置页是主窗口里的标签，同一个 webContents 通道） */
function pushAgentStatus() {
  const payload = agentStatusPayload();
  try {
    const win = runtime.mainWindow;
    if (win && !win.isDestroyed() && win.webContents) win.webContents.send('nyx:agent:status', payload);
  } catch (err) {
    console.warn('[Nyx] 急停状态推送失败：', err && err.message ? err.message : err);
  }
  return payload;
}

/**
 * 紧急停止（清单 D 的「真刹车」）：
 *   1. 中断正在执行的动作（AbortSignal）；
 *   2. 让「等待人工确认」立刻失败，不等超时；
 *   3. 会话标记 stopped，之后所有新动作一律被拒不执行；
 *   4. 前台立刻看得见（工具栏常驻按钮 + 通知 + 诊断）。
 * 诚实边界：单条 executeJavaScript 在 V8 里掐不断，所以只能保证「不再派发下一条」。
 */
function stopAgent(reason) {
  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : '手动紧急停止';
  const before = runtime.agentStopped === true;
  runtime.agentStopped = true;
  runtime.agentStopReason = why;
  runtime.agentStopAt = Date.now();
  let aborted = 0;
  try {
    if (runtime.agentDispatcher) {
      const result = runtime.agentDispatcher.cancelAll(why);
      aborted = result && result.abortedInFlight ? result.abortedInFlight : 0;
    }
  } catch (err) {
    diagnostics.error('AGENT_STOP_FAILED', '急停调用出错', { error: err && err.message });
  }
  diagnostics.warn('AGENT_STOPPED', `agent 已停止：${why}`, { aborted, alreadyStopped: before });
  pushAgentStatus();
  notifyNotice({
    level: 'error',
    code: 'AGENT_STOPPED',
    title: '已停止 agent 操作',
    message: `${why}。正在执行的动作已中断，之后 agent 发来的动作一律拒绝；确认安全后可点工具栏的「agent 已停止」按钮恢复。`,
  });
  return { ok: true, stopped: true, reason: why, aborted, at: runtime.agentStopAt };
}

/** 恢复：清停止标记，换新的 AbortController，让 agent 可以继续发动作 */
function resumeAgent() {
  if (runtime.agentDispatcher) runtime.agentDispatcher.resume();
  const was = runtime.agentStopped === true;
  runtime.agentStopped = false;
  runtime.agentStopReason = '';
  runtime.agentStopAt = 0;
  diagnostics.warn('AGENT_RESUMED', 'agent 操作已恢复', { wasStopped: was });
  pushAgentStatus();
  if (was) {
    notifyNotice({
      level: 'warn',
      code: 'AGENT_RESUMED',
      title: 'agent 操作已恢复',
      message: '之后再来的动作会照常走权限判定与人工确认。',
    });
  }
  return { ok: true, stopped: false };
}

/**
 * agent 审计面 + 急停的 IPC（清单 D）。
 *
 * 导出格式只做两件：CSV（给人看，Excel 能开）与 JSON（给机器/留档）。
 * 落点：给了 payload.path 就直接写（自动化测试用），否则弹保存框，
 * 弹框被取消要如实返回 cancelled，不能假装成功。
 */
function registerAgentAuditIpc() {
  ipcMain.handle('nyx:agent:status', () => agentStatusPayload());

  ipcMain.handle('nyx:agent:audit', (_event, payload) => {
    if (!runtime.agentAudit) {
      return { ok: false, error: '审计还没准备好（agent 通道未启动）', rows: [], total: 0 };
    }
    try {
      const result = runtime.agentAudit.list(payload || {});
      return { ...result, stats: runtime.agentAudit.stats(), agent: agentStatusPayload() };
    } catch (err) {
      diagnostics.error('AGENT_AUDIT_LIST_FAILED', '读取审计记录失败', { error: err && err.message });
      return { ok: false, error: `读取审计记录失败：${err && err.message ? err.message : err}`, rows: [], total: 0 };
    }
  });

  ipcMain.handle('nyx:agent:audit-export', async (_event, payload) => {
    if (!runtime.agentAudit) {
      return { ok: false, error: '审计还没准备好（agent 通道未启动）' };
    }
    const options = payload && typeof payload === 'object' ? payload : {};
    const format = options.format === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let dest = typeof options.path === 'string' && options.path ? options.path : '';
    if (!dest) {
      const win = runtime.mainWindow;
      const picked = await dialog.showSaveDialog(win, {
        title: '导出 agent 审计记录',
        defaultPath: path.join(app.getPath('downloads'), `Nyx-agent审计-${stamp}.${format}`),
        filters:
          format === 'json'
            ? [{ name: 'JSON', extensions: ['json'] }]
            : [{ name: 'CSV', extensions: ['csv'] }],
        buttonLabel: '导出',
      });
      if (picked.canceled || !picked.filePath) {
        return { ok: false, cancelled: true, error: '已取消导出（没有写任何文件）' };
      }
      dest = picked.filePath;
    }
    try {
      const wanted = runtime.agentAudit.exportRows(options.filters || {});
      const text = format === 'json' ? `${JSON.stringify({ exportedAt: new Date().toISOString(), count: wanted.count, rows: wanted.rows }, null, 2)}\n` : toCsv(wanted.rows);
      fs.writeFileSync(dest, text, 'utf8');
      diagnostics.info('AGENT_AUDIT_EXPORTED', `导出审计记录 ${wanted.count} 条`, { format, dest });
      return { ok: true, format, path: dest, count: wanted.count, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (err) {
      diagnostics.error('AGENT_AUDIT_EXPORT_FAILED', '导出审计记录失败', {
        format,
        dest,
        error: err && err.message,
      });
      return { ok: false, error: `导出失败：${err && err.message ? err.message : err}` };
    }
  });

  ipcMain.handle('nyx:agent:audit-clear', () => {
    if (!runtime.agentAudit) return { ok: false, error: '审计还没准备好（agent 通道未启动）' };
    const result = runtime.agentAudit.clear();
    diagnostics.warn('AGENT_AUDIT_CLEARED', '清空内存里的审计缓冲', { cleared: result.cleared });
    return { ...result, stats: runtime.agentAudit.stats() };
  });

  ipcMain.handle('nyx:agent:stop', (_event, payload) => {
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    return stopAgent(reason || '界面按钮紧急停止');
  });

  ipcMain.handle('nyx:agent:resume', () => resumeAgent());
}

/**
 * 让 agent 改设置（用户第 6 项）。
 *
 * 边界写死在这里，而不是靠"界面别点"：
 *   - 只有 `src/core/agent-settings.js` 的白名单键能被改（锁死的键连问都不许）；
 *   - 判定走 `planSettingChange`（限流 / 需确认 / 无变化都有中文原因），这里只落盘；
 *   - 每次成功都记一条诊断，界面上也有对应的说明卡与免责。
 */
function agentSettingsSnapshot() {
  const ui = runtime.uiStore ? runtime.uiStore.get() : {};
  const current = {};
  for (const key of SETTING_KEYS) current[key] = ui[key];
  const schema = describeSettingsSchema();
  const undoList = Array.isArray(runtime.agentSettingUndo) ? runtime.agentSettingUndo : [];
  const lastUndo = undoList.length ? undoList[undoList.length - 1] : null;
  return {
    ...schema,
    current,
    // 界面上"哪些键是锁死的"要和判定用的是同一份表
    lockedKeys: Object.keys(SETTING_LOCKED),
    disclaimer: SETTING_DISCLAIMER,
    // 撤销不给界面单独开一条路：它仍是 agent 动作（带 undo:true），同样要人工确认与留痕。
    // 这里只如实告诉界面"现在能不能撤、能撤哪一次"。
    undo: lastUndo
      ? {
          available: true,
          key: lastUndo.key,
          at: lastUndo.at,
          depth: undoList.length,
          maxSteps: MAX_UNDO_STEPS,
          how:
            '让 agent 发一次 settings 动作并带上 undo:true（可选 steps 一次撤多步），照样要你点确认；' +
            '撤销只回退不重做，连撤会一路回到最早一条',
        }
      : { available: false, depth: 0, how: '还没有哪个 agent 改过设置，暂时没有可撤销的' },
  };
}

async function applyAgentSetting(params) {
  const input = params && typeof params === 'object' ? params : {};
  const undo = input.undo === true;
  const presetKey = typeof input.preset === 'string' ? input.preset.trim() : '';
  let key = typeof input.key === 'string' ? input.key.trim() : '';
  const ui = runtime.uiStore ? runtime.uiStore.get() : {};
  const history = Array.isArray(runtime.agentSettingHistory) ? runtime.agentSettingHistory : [];
  const now = Date.now();
  runtime.agentSettingHistory = history.filter((stamp) => now - stamp < 60 * 1000);

  // 撤销（候选④）：认的是"当时记下的旧值"，不是让 agent 再改一次回去。
  // 中间要是有人手动改过，planSettingUndo 会如实说"不需要撤销"，不会硬盖人的选择。
  // 支持一次撤多步（steps），但仍要过人工确认与留痕，只是不占修改限流的额度。
  let plan;
  let undoPicked = [];
  let presetChanges = [];
  if (undo) {
    const entries = Array.isArray(runtime.agentSettingUndo) ? runtime.agentSettingUndo : [];
    const stepsInput = Number(input.steps);
    const steps = Number.isFinite(stepsInput) && stepsInput >= 1 ? Math.floor(stepsInput) : 1;
    key = entries.length ? entries[entries.length - 1].key : '';
    const currents = {};
    for (const entry of entries) currents[entry.key] = ui[entry.key];
    plan = planAgentSettingUndo(entries, { currents, steps });
    if (plan.ok && Array.isArray(plan.changes)) undoPicked = plan.changes;
  } else if (presetKey) {
    // 场景预设（第五轮 ④）：一次改一组，但需要确认的键仍然逐项点名确认，
    // 不是"套一个预设就等于同意里面所有改动"。限流按"一次调用"算，不按项数算。
    key = presetKey;
    plan = planAgentPresetChange(
      { preset: presetKey, accepts: Array.isArray(input.accepts) ? input.accepts : [] },
      { currents: ui, history: runtime.agentSettingHistory, now },
    );
    if (plan.ok && Array.isArray(plan.changes)) presetChanges = plan.changes;
  } else {
    plan = planAgentSettingChange(
      { key, value: input.value, confirm: input.confirm === true },
      { current: ui[key], history: runtime.agentSettingHistory, now },
    );
  }

  if (!plan.ok) {
    if (plan.code !== 'RATE_LIMITED') {
      diagnostics.warn('AGENT_SETTINGS_REJECTED', `agent 改设置被拒：${key || '（没给键）'}`, {
        code: plan.code,
        key,
      });
    }
    return {
      ok: false,
      code: plan.code,
      error: plan.error || plan.message,
      disclaimer: SETTING_DISCLAIMER,
      locked: plan.locked === true,
      needsConfirm: plan.code === 'NEED_CONFIRM',
    };
  }

  if (plan.code === 'NO_CHANGE') {
    // 撤销时也要把这条没用的记录拿走，否则连着撤会一直停在同一条上
    if (undo && plan.consumed > 0 && Array.isArray(runtime.agentSettingUndo)) {
      runtime.agentSettingUndo.splice(Math.max(0, runtime.agentSettingUndo.length - plan.consumed));
    }
    return {
      ok: true,
      code: 'NO_CHANGE',
      key: plan.key || key,
      value: plan.value,
      message: plan.message,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  if (!runtime.uiStore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', error: '设置存储还没就绪，这次没有改。', disclaimer: SETTING_DISCLAIMER };
  }

  // 撤销与预设都可能一次改多项，所以这里按"目标列表"落盘；普通修改只有一项。
  const targets = undo
    ? undoPicked.map((item) => ({ key: item.key, value: item.value, summary: item.summary, from: undefined }))
    : presetChanges.length
      ? presetChanges.map((item) => ({ key: item.key, value: item.value, summary: item.summary, from: item.from }))
      : [{ key, value: plan.value, summary: plan.summary, from: ui[key] }];
  const applied = [];
  for (const item of targets) {
    // 关掉离线缓存时要把已存的正文一起清掉——和界面上手动关掉是同一条路径，
    // 免得"agent 关掉了但旧快照还躺在磁盘上"。
    if (item.key === 'offlineCacheEnabled' && item.value === false) {
      clearPageCache('agent-disabled');
    }
    const saved = runtime.uiStore.set(item.key, item.value);
    if (!saved || saved.ok === false) {
      const reason = (saved && saved.error) || '写入失败';
      diagnostics.error('AGENT_SETTINGS_SAVE_FAILED', `agent 改设置没能保存：${item.key}`, {
        key: item.key,
        reason,
        applied,
      });
      return {
        ok: false,
        code: 'SAVE_FAILED',
        error:
          applied.length > 0
            ? `没能保存 ${item.key}：${reason}（已经改成了 ${applied.join('、')}，剩下这几项没动）`
            : `没能保存 ${item.key}：${reason}`,
        applied,
        disclaimer: SETTING_DISCLAIMER,
      };
    }
    applied.push(item.key);
    // 标签休眠改完要立刻生效，否则用户会以为"改了没反应"
    if (item.key === 'tabSleepMinutes' && runtime.tabManager && typeof runtime.tabManager.setSleepAfterMs === 'function') {
      try {
        runtime.tabManager.setSleepAfterMs(sleepMinutesToMs(item.value));
      } catch (err) {
        console.warn('[Nyx] 应用标签休眠设置失败：', err && err.message);
      }
    }
  }

  // 撤销不占修改额度（一键回退不该被限流卡住）；普通修改与预设都只记一次
  if (!undo) runtime.agentSettingHistory.push(now);

  if (undo) {
    // 撤销把用掉的记录一起拿走：连按撤销会一路回到最早一条；想再改回去就让 agent 重设一次
    if (Array.isArray(runtime.agentSettingUndo) && plan.consumed > 0) {
      runtime.agentSettingUndo.splice(Math.max(0, runtime.agentSettingUndo.length - plan.consumed));
    }
  } else if (Array.isArray(runtime.agentSettingUndo)) {
    // 留可撤销的记录：只记"这次改成了什么、改之前是什么"，
    // 不记 agent 是谁（那在动作留痕里）。预设一次改多项，就记多项——
    // 否则撤销只能退回其中一项，看起来像"只撤了一半"。
    for (const item of targets) {
      runtime.agentSettingUndo.push({ key: item.key, value: item.value, previous: item.from, at: now });
    }
    if (runtime.agentSettingUndo.length > 20) runtime.agentSettingUndo.splice(0, runtime.agentSettingUndo.length - 20);
  }

  diagnostics.info(undo ? 'AGENT_SETTINGS_UNDONE' : 'AGENT_SETTINGS_CHANGED', undo ? `撤销了 ${applied.length} 项 agent 改的设置` : `agent 改了设置：${key}`, {
    key,
    value: plan.value,
    keys: applied,
    summary: plan.summary,
  });
  if (typeof pushAgentStatus === 'function') pushAgentStatus();
  if (typeof notifyNotice === 'function') {
    notifyNotice({
      level: 'info',
      code: undo ? 'AGENT_SETTINGS_UNDONE' : 'AGENT_SETTINGS_CHANGED',
      title: undo ? '已撤销上一次 agent 改的设置' : '有个 agent 改了你的设置',
      message: `${plan.summary}。改了什么可以在「设置 → Agent 访问 → 动作留痕」里看到。`,
    });
  }

  return {
    ok: true,
    key,
    value: plan.value,
    undo,
    keys: applied,
    steps: undo ? applied.length : 1,
    summary: plan.summary,
    message: plan.message,
    disclaimer: SETTING_DISCLAIMER,
    confirmRequired: plan.confirmRequired === true,
  };
}

function registerAgentSettingsIpc() {
  // 只读：界面把"agent 能改哪些键、为什么要确认、哪些键锁死"如实列出来。
  // 真正的修改只走 agent 动作通道（dispatch → 人工确认 → 留痕），界面不给旁路。
  ipcMain.handle('nyx:agent:settings', () => agentSettingsSnapshot());

  // 按键聚合：看哪个设置项被 agent 改得最多、最近是谁改的（用户第七轮 C）。
  // 数据源就是动作留痕本身，不另存一份，免得两处说法不一致。
  ipcMain.handle('nyx:agent:settings-audit', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    let records = [];
    try {
      records = runtime.agentAudit && typeof runtime.agentAudit.list === 'function' ? runtime.agentAudit.list() : [];
    } catch (err) {
      console.warn('[Nyx] 读动作留痕失败，设置改动聚合按空处理：', err && err.message ? err.message : err);
      diagnostics.warn('AGENT_SETTINGS_AUDIT_READ_FAILED', '读动作留痕失败，设置改动聚合按空处理', {
        error: err && err.message ? err.message : String(err),
      });
    }
    const aggregated = aggregateAgentSettingChanges(records, {
      limit: Number.isFinite(input.limit) ? input.limit : 20,
      includeUndo: input.includeUndo === true,
      // 时间窗（第八轮 ④）：界面只传「最近几天」，换算成时间戳放在这里，
      // 免得界面和主进程各算一套"一天是多久"。
      since: readAuditSince(input.days),
    });
    // 动作聚合（第九轮 ④）：同一批记录再按动作类型/站点各数一遍，
    // 与设置聚合共用同一时间窗，两边的口径不许不一样。
    const actions = aggregateAgentActions(records, {
      limit: Number.isFinite(input.limit) ? input.limit : 20,
      since: readAuditSince(input.days),
    });
    return Object.assign({}, aggregated, {
      actions,
      disclaimer: SETTING_DISCLAIMER,
      auditedAt: Date.now(),
      days: readAuditDays(input.days),
    });
  });

  // 导出聚合结果为 CSV：导的是"每个设置项一行"或"每个动作一行"，不是原始流水账。
  // `kind: 'actions'` 时导「它都干过什么」（第九轮 ④）——两张表列头不同，刻意不合并。
  // 同步对话框：异步那条路在下载那边踩过「窗口先关、Promise 永挂」的坑。
  ipcMain.handle('nyx:agent:settings-audit-export', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const kind = String(input.kind || 'settings') === 'actions' ? 'actions' : 'settings';
    let records = [];
    try {
      records = runtime.agentAudit && typeof runtime.agentAudit.list === 'function' ? runtime.agentAudit.list() : [];
    } catch (err) {
      diagnostics.warn('AGENT_SETTINGS_AUDIT_READ_FAILED', '导出前读动作留痕失败', {
        error: err && err.message ? err.message : String(err),
      });
    }
    const scope = {
      limit: Number.isFinite(input.limit) ? input.limit : 200,
      includeUndo: input.includeUndo === true,
      since: readAuditSince(input.days),
    };
    const aggregated = aggregateAgentSettingChanges(records, scope);
    const actions = kind === 'actions' ? aggregateAgentActions(records, scope) : null;
    const empty = kind === 'actions' ? (!actions || actions.empty === true) : aggregated.empty === true;
    if (empty) {
      return {
        ok: false,
        code: 'NOTHING_TO_EXPORT',
        error: (kind === 'actions' ? (actions && actions.note) : aggregated.note) || '这段时间里没有可导出的记录。',
      };
    }
    const body = kind === 'actions'
      ? buildAgentActionAuditCsv(actions, { now: Date.now() })
      : buildAgentSettingAuditCsv(aggregated.keys, { now: Date.now() });
    const rowCount = kind === 'actions' ? actions.types.length : aggregated.keys.length;
    const stamp = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const baseName = kind === 'actions' ? 'agent动作记录' : 'agent设置改动';
    const defaultName = `${baseName}-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.csv`;
    const title = kind === 'actions' ? '导出 agent 做过的动作（CSV）' : '导出 agent 改设置的记录（CSV）';
    let target = '';
    try {
      target = dialog.showSaveDialogSync(win, {
        title,
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        buttonLabel: '导出',
      });
    } catch (err) {
      diagnostics.error('AGENT_SETTINGS_AUDIT_EXPORT_FAILED', '导出对话框没能弹出来', {
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: '导出对话框没能弹出来，稍后再试一次。' };
    }
    if (!target) return { ok: false, canceled: true, error: '已取消导出。' };
    try {
      fs.writeFileSync(target, body, 'utf8');
    } catch (err) {
      diagnostics.error('AGENT_SETTINGS_AUDIT_EXPORT_FAILED', 'CSV 没能写到磁盘上', {
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: `没能写到磁盘上：${err && err.message ? err.message : String(err)}` };
    }
    diagnostics.info('AGENT_SETTINGS_AUDIT_EXPORTED', kind === 'actions' ? '导出了 agent 动作记录' : '导出了 agent 改设置的记录', {
      kind,
      rows: rowCount,
      bytes: Buffer.byteLength(body, 'utf8'),
    });
    return { ok: true, kind, path: target, rows: rowCount, bytes: Buffer.byteLength(body, 'utf8') };
  });
}

/** 界面上能选的三个时间范围（天）；0 表示不限 */
const AUDIT_RANGES = [0, 1, 7];
function readAuditDays(raw) {
  const value = Number(raw);
  return AUDIT_RANGES.includes(value) ? value : 0;
}
/** 把"最近几天"换成时间戳下限；0/非法一律 0（不限时间） */
function readAuditSince(raw) {
  const days = readAuditDays(raw);
  return days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
}

/**
 * agent 接入说明（清单 D1）。
 *
 * 为什么要"生成"而不是写一份静态文档：端点端口、鉴权头、模式、急停状态、白名单条数
 * 都是运行时事实。写死示例端口的结果一定是"照着文档填，连不上"。
 * 所以这里只做一件事：把当前真实状态喂给 `src/core/agent-doc.js`，拼出一份可粘贴的说明。
 */
function agentDocOptions() {
  const policy = runtime.agentSites || sanitizeSitePolicy(null);
  const modeInfo = agentModeStatus();
  return {
    port: runtime.apiPort,
    tokenFile: userDataFile('api-token.txt'),
    mode: runtime.agentMode,
    modeLabel: modeInfo.label,
    auditComplete: modeInfo.auditComplete !== false,
    stopped: runtime.agentStopped === true,
    stopShortcut: runtime.agentStopShortcut || AGENT_STOP_SHORTCUT,
    stopShortcutOk: runtime.agentStopShortcutOk !== false,
    cdpPort: runtime.agentDebugPort,
    allowCount: Array.isArray(policy.allow) ? policy.allow.length : 0,
  };
}

function buildAgentDocPayload() {
  const options = agentDocOptions();
  return {
    ok: true,
    markdown: buildAgentDoc(options),
    filename: agentDocFilename(Date.now()),
    mode: options.mode,
    port: options.port,
    auditComplete: options.auditComplete,
    stopped: options.stopped,
  };
}

function registerAgentDocIpc() {
  ipcMain.handle('nyx:agent:doc', () => {
    try {
      return buildAgentDocPayload();
    } catch (err) {
      diagnostics.error('AGENT_DOC_FAILED', 'agent 接入说明没能生成', {
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: `接入说明没能生成：${err && err.message ? err.message : err}` };
    }
  });

  ipcMain.handle('nyx:agent:doc-copy', async () => {
    const payload = buildAgentDocPayload();
    try {
      await writeClipboardText(payload.markdown);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '系统剪贴板当前不可用，接入说明没能复制' };
    }
    // 写完回读一次：剪贴板被别的程序抢走时必须如实说失败，别让用户粘出别的东西
    const back = await readClipboardText();
    const head = payload.markdown.slice(0, 40);
    if (typeof back !== 'string' || !back.includes(head)) {
      diagnostics.warn('AGENT_DOC_COPY_VERIFY_FAILED', '接入说明复制后回读不一致', {
        chars: payload.markdown.length,
      });
      return { ok: false, error: '系统剪贴板当前不可用（可能被其它程序占用），接入说明没能复制' };
    }
    diagnostics.info('AGENT_DOC_COPIED', '已复制 agent 接入说明', {
      chars: payload.markdown.length,
      mode: payload.mode,
    });
    return { ok: true, chars: payload.markdown.length, mode: payload.mode };
  });

  ipcMain.handle('nyx:agent:doc-save', () => {
    const payload = buildAgentDocPayload();
    try {
      const target = dialog.showSaveDialogSync(runtime.mainWindow || undefined, {
        title: '保存 agent 接入说明',
        defaultPath: path.join(app.getPath('documents'), payload.filename),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!target) return { ok: false, code: 'CANCELED', error: '已取消保存。' };
      fs.writeFileSync(target, payload.markdown, 'utf8');
      const bytes = fs.statSync(target).size;
      diagnostics.info('AGENT_DOC_SAVED', '已保存 agent 接入说明', { bytes });
      return { ok: true, path: target, bytes };
    } catch (err) {
      diagnostics.error('AGENT_DOC_SAVE_FAILED', 'agent 接入说明没能保存', {
        error: err && err.message ? err.message : String(err),
      });
      return { ok: false, error: `没能保存：${err && err.message ? err.message : err}` };
    }
  });
}

/**
 * 站点三层授权的 IPC（清单 E）。
 * 设置页只提交"要加/要删哪一条"，判定规则全在 `src/core/agent-sites.js` 里，
 * 免得界面和主进程各写一套匹配逻辑、最后两边说法不一致。
 */
function registerAgentSitesIpc() {
  const payloadOf = (extra) =>
    agentSitesPayload({
      policy: runtime.agentSites || sanitizeSitePolicy(null),
      sessionTrusted: runtime.agentSessionTrust || [],
      site: (extra && extra.site) || currentAgentSite(),
    });

  ipcMain.handle('nyx:agent:sites', (_event, payload) => payloadOf(payload));

  ipcMain.handle('nyx:agent:sites-set', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const next = sanitizeSitePolicy(runtime.agentSites || null);

    if (input.globalEnabled !== undefined) {
      next.globalEnabled = input.globalEnabled !== false;
    }
    if (typeof input.addAllow === 'string' && input.addAllow.trim()) {
      const result = addSiteRule(next.allow, { target: input.addAllow, mode: input.mode });
      if (!result.ok) return { ...payloadOf(input), ok: false, error: result.error };
      next.allow = result.list;
    }
    if (typeof input.addBlock === 'string' && input.addBlock.trim()) {
      const result = addSiteRule(next.block, { target: input.addBlock, mode: input.mode });
      if (!result.ok) return { ...payloadOf(input), ok: false, error: result.error };
      next.block = result.list;
    }
    if (typeof input.removeAllow === 'string' && input.removeAllow.trim()) {
      const result = removeSiteRule(next.allow, input.removeAllow, input.mode);
      if (!result.ok) return { ...payloadOf(input), ok: false, error: result.error };
      next.allow = result.list;
    }
    if (typeof input.removeBlock === 'string' && input.removeBlock.trim()) {
      const result = removeSiteRule(next.block, input.removeBlock, input.mode);
      if (!result.ok) return { ...payloadOf(input), ok: false, error: result.error };
      next.block = result.list;
    }

    const saved = writeAgentSites(next);

    if (input.trustSession && typeof input.trustSession === 'string') {
      const trusted = addSessionTrust(runtime.agentSessionTrust || [], input.trustSession);
      if (trusted.ok) runtime.agentSessionTrust = trusted.hosts;
    }
    if (input.clearSession) {
      runtime.agentSessionTrust = [];
    }

    diagnostics.info('AGENT_SITES_UPDATED', '站点名单已更新', {
      globalEnabled: saved.globalEnabled,
      allow: saved.allow.length,
      block: saved.block.length,
      sessionTrusted: (runtime.agentSessionTrust || []).length,
    });
    pushAgentStatus();
    return payloadOf(input);
  });

  // 名单导入导出（候选④）：导出给人备份，导入默认并入、不删用户已有的条目。
  ipcMain.handle('nyx:agent:sites-export', () => {
    const policy = sanitizeSitePolicy(runtime.agentSites || null);
    const body = exportSitePolicy(policy);
    const stamp = new Date().toISOString().slice(0, 10);
    const target = dialog.showSaveDialogSync(win, {
      title: '导出 agent 站点名单',
      defaultPath: path.join(app.getPath('documents'), `nyx-agent-sites-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      buttonLabel: '导出',
    });
    if (!target) {
      return { ...payloadOf({}), ok: false, canceled: true, error: '已取消导出。' };
    }
    try {
      fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    } catch (err) {
      diagnostics.error('AGENT_SITES_EXPORT_FAILED', '站点名单没能导出', { error: String(err && err.message ? err.message : err) });
      return { ...payloadOf({}), ok: false, error: `没能写入 ${target}：${err && err.message ? err.message : err}` };
    }
    diagnostics.info('AGENT_SITES_EXPORTED', '站点名单已导出', {
      file: target,
      allow: body.allow.length,
      block: body.block.length,
    });
    return {
      ...payloadOf({}),
      exported: { path: target, allow: body.allow.length, block: body.block.length },
    };
  });

  ipcMain.handle('nyx:agent:sites-import', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const picked = dialog.showOpenDialogSync(win, {
      title: '导入 agent 站点名单',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
      buttonLabel: '导入',
    });
    if (!picked || !picked.length) {
      return { ...payloadOf(input), ok: false, canceled: true, error: '已取消导入。' };
    }
    const file = picked[0];
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return { ...payloadOf(input), ok: false, error: `这个文件读不出来：${err && err.message ? err.message : err}` };
    }
    const result = importSitePolicy(raw, runtime.agentSites || sanitizeSitePolicy(null), { mode: 'merge' });
    if (!result.ok) {
      diagnostics.warn('AGENT_SITES_IMPORT_REJECTED', '站点名单导入被拒', { file, error: result.error });
      return { ...payloadOf(input), ok: false, error: result.error };
    }
    writeAgentSites(result.policy);
    diagnostics.info('AGENT_SITES_IMPORTED', '站点名单已导入', {
      file,
      added: result.added,
      duplicates: result.duplicates,
      rejected: result.rejectedCount,
    });
    pushAgentStatus();
    return {
      ...payloadOf(input),
      imported: {
        path: file,
        added: result.added,
        duplicates: result.duplicates,
        rejected: result.rejected,
        rejectedCount: result.rejectedCount,
        summary: result.summary,
      },
    };
  });
}

/**
 * agent 接入模式的落盘与状态（清单 A）。
 *
 * 模式只在启动时决定（CDP 端口没有运行时开关），所以这里写盘只是"下次启动用哪个"，
 * 当前进程的 runtime.agentMode 不变——界面必须如实显示"已记下，重启后生效"。
 */
function writeAgentMode(mode) {
  const next = normalizeAgentMode(mode);
  const body = { mode: next, debugPort: runtime.agentDebugPort, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(userDataFile(AGENT_MODE_FILE), JSON.stringify(body, null, 2), 'utf8');
    runtime.agentMode = next;
    return { ok: true, mode: next };
  } catch (err) {
    diagnostics.error('AGENT_MODE_SAVE_FAILED', 'agent 接入模式没能保存到磁盘', {
      mode: next,
      error: err && err.message,
    });
    return {
      ok: false,
      mode: runtime.agentMode,
      error: `没能写入 ${AGENT_MODE_FILE}：${err && err.message ? err.message : err}`,
    };
  }
}

function agentModeStatus() {
  return agentModePayload({
    mode: runtime.agentMode,
    bootMode: runtime.bootAgentMode,
    debugPort: runtime.agentDebugPort,
  });
}

/**
 * 页面摘要的 IPC（清单 F）。
 *
 * 三个约束写在这里，因为都容易被"顺手优化"掉：
 *  1. 默认关闭，关着就返回明确原因（不许静默不干活）；
 *  2. 只抽取页面原文，不调任何生成式接口——每句话都能在页面上找到出处；
 *  3. 一定要把抓包摘要一起给：页面说"成功"、接口其实 500 是这类工具最容易骗人的地方。
 */
function registerDigestIpc() {
  /**
   * 标签休眠阈值（清单 G 的后续）。
   *
   * 之前阈值写死 30 分钟，只能靠环境变量在测试里改——用户想调（或想关掉）没有办法。
   * 这里给一个正经设置项：改完立刻对 TabManager 生效，不需要重启；
   * 环境变量 NYX_TAB_SLEEP_MS 仍然优先，它是自动化验证的旋钮，界面上要如实说明。
   */
  function tabSleepPayload() {
    const envOverride = process.env.NYX_TAB_SLEEP_MS !== undefined;
    const minutes = normalizeSleepMinutes(runtime.uiStore ? runtime.uiStore.get().tabSleepMinutes : DEFAULT_SLEEP_MINUTES);
    const effectiveMs = runtime.tabManager ? runtime.tabManager.sleepAfterMs : sleepMinutesToMs(minutes);
    return {
      ok: true,
      minutes,
      effectiveMs,
      options: TAB_SLEEP_MINUTES,
      hint: describeSleepMinutes(Math.round(effectiveMs / 60000)),
      envOverride,
      envMs: envOverride ? readSleepAfterFromEnv(process.env) : 0,
      envNote: envOverride
        ? '本次启动被环境变量 NYX_TAB_SLEEP_MS 覆盖，界面上的设置这次不生效（这个变量只给自动化验证用）。'
        : '',
    };
  }

  ipcMain.handle('nyx:tabs:sleep', () => tabSleepPayload());

  // 整机在线/离线状态：外壳横幅与诊断页共用同一份说法，避免两处文案不一致。
  ipcMain.handle('nyx:net:state', () => {
    const mode = sessions.getMode();
    return networkStatePayload({ online: onlineState(), mode, link: sessions.getLink(mode) });
  });

  ipcMain.handle('nyx:tabs:sleep-set', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const minutes = normalizeSleepMinutes(input.minutes, -1);
    if (minutes < 0) {
      return { ...tabSleepPayload(), ok: false, error: '休眠时长要是 0（不自动休眠）或 1–240 之间的分钟数。' };
    }
    let result = null;
    try {
      result = runtime.uiStore.set('tabSleepMinutes', minutes);
    } catch (err) {
      diagnostics.error('TAB_SLEEP_SAVE_FAILED', '标签休眠时长没能保存', { error: err && err.message });
      return { ...tabSleepPayload(), ok: false, error: `没能保存休眠时长：${err && err.message ? err.message : err}` };
    }
    const effectiveMs = runtime.tabManager ? runtime.tabManager.setSleepAfterMs(sleepMinutesToMs(minutes)) : sleepMinutesToMs(minutes);
    diagnostics.info('TAB_SLEEP_CHANGED', `标签休眠：${describeSleepMinutes(minutes)}`, {
      minutes,
      effectiveMs,
      envOverride: process.env.NYX_TAB_SLEEP_MS !== undefined,
    });
    return { ...tabSleepPayload(), ok: true, minutes, effectiveMs, ui: result && result.ui ? result.ui : null };
  });

  ipcMain.handle('nyx:digest:get', () => ({
    ok: true,
    enabled: runtime.uiStore ? runtime.uiStore.get().digestEnabled === true : false,
  }));

  ipcMain.handle('nyx:digest:set', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const enabled = input.enabled === true;
    let result = null;
    try {
      result = runtime.uiStore.set('digestEnabled', enabled);
    } catch (err) {
      diagnostics.error('DIGEST_TOGGLE_FAILED', '页面摘要开关没能保存', { error: err && err.message });
      return { ok: false, error: `没能保存开关：${err && err.message ? err.message : err}` };
    }
    diagnostics.info('DIGEST_TOGGLED', `页面摘要已${enabled ? '开启' : '关闭'}`, { enabled });
    return { ok: true, enabled, ui: result && result.ui ? result.ui : null };
  });

  ipcMain.handle('nyx:digest:run', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const enabled = runtime.uiStore ? runtime.uiStore.get().digestEnabled === true : false;
    if (!enabled && input.force !== true) return digestDisabledPayload();

    const manager = runtime.tabManager;
    // 注意：TabManager 的 active 是 getter（`get active()`），不是函数——写成 active() 会静默拿到 undefined
    const tab = manager ? manager.active : null;
    const wc = manager && typeof manager.getActiveWebContents === 'function'
      ? manager.getActiveWebContents()
      : tab && tab.view
        ? tab.view.webContents
        : null;
    if (!tab || !wc || wc.isDestroyed()) {
      return { ok: false, code: 'NO_PAGE', error: '当前没有打开的页面，先把要总结的页面打开。' };
    }
    try {
      const raw = await wc.executeJavaScript(buildExtractScript({}), true);
      const page = summarizePage(raw);
      if (page.ok === false) {
        diagnostics.warn('DIGEST_EMPTY', '这一页没有可读正文', { url: redactUrlForLog(tab.url || '') });
        return { ok: false, code: 'DIGEST_EMPTY', error: page.error, page };
      }

      let network = null;
      try {
        const listed = runtime.toolbox && typeof runtime.toolbox.list === 'function'
          ? runtime.toolbox.list(wc.id)
          : { ok: false, records: [] };
        network = summarizeNetwork((listed && listed.records) || []);
      } catch (err) {
        // 抓包没数据不算失败：摘要本身还能看，但要在界面说清"网络部分缺失"
        network = summarizeNetwork([]);
        network.missing = true;
        console.warn('[Nyx] 页面摘要拿不到抓包记录：', err && err.message);
      }

      const result = { ok: true, page, network, ranAt: Date.now() };
      result.text = buildDigestText(result);
      diagnostics.info('DIGEST_RUN', '生成了页面摘要（纯抽取）', {
        url: redactUrlForLog(page.url || ''),
        sentences: page.bullets.length,
        candidates: page.candidates,
        requests: network.total,
        failed: network.failed,
      });
      return result;
    } catch (err) {
      diagnostics.error('DIGEST_FAILED', '生成页面摘要失败', { error: err && err.message });
      return { ok: false, code: 'DIGEST_FAILED', error: `没能读取这一页：${err && err.message ? err.message : err}` };
    }
  });

  /**
   * 进程详情（清单 A3）。
   *
   * 用户要的是「在系统资源管理器里看到浏览器的进程详情」。能做到的是：
   * 每个标签视图带 --nyx-kind / --nyx-tab / --nyx-host（任务管理器命令行列可见），
   * 加上这张 PID 表——PID 与系统里完全一致，可以复制过去对照。
   * 做不到的是改映像名：Windows 上每个 Electron 进程都叫 Nyx.exe，这版也不假装能改。
   */
  ipcMain.handle('nyx:proc:list', async () => {
    try {
      const metrics = app.getAppMetrics();
      const manager = runtime.tabManager;
      const tabs = manager && Array.isArray(manager.tabs) ? manager.tabs : [];
      const rows = tabs.map((tab) => {
        let pid = 0;
        try {
          pid = tab && tab.view ? tab.view.webContents.getOSProcessId() : 0;
        } catch {
          pid = 0;
        }
        return { id: tab.id, pid, url: tab.url, title: tab.title, asleep: Boolean(tab.asleep) };
      });
      return buildProcessRows({ metrics, tabs: rows, mainPid: process.pid });
    } catch (err) {
      return {
        ok: false,
        error: `读不到进程信息：${err && err.message ? err.message : err}`,
      };
    }
  });

  // 页面截图（清单 B1）：把当前标签可见部分存成 PNG。
  // 三条纪律：落点同步确定（不出现"先放行再改路径"）、失败说清原因、绝不静默写到用户不知道的地方。
  ipcMain.handle('nyx:page:screenshot', async () => {
    const manager = runtime.tabManager;
    const wc = manager && typeof manager.getActiveWebContents === 'function' ? manager.getActiveWebContents() : null;
    if (!wc) return { ok: false, code: 'NO_PAGE', error: '当前没有可截图的页面。' };
    const win = runtime.win || undefined;
    const picked = dialog.showSaveDialogSync(win, {
      title: '保存页面截图',
      defaultPath: path.join(app.getPath('pictures'), screenshotFilename(Date.now())),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (!picked) return { ok: false, code: 'CANCELED', error: '已取消截图。' };
    try {
      const image = await wc.capturePage();
      if (!image || image.isEmpty()) {
        return { ok: false, code: 'EMPTY', error: '这一页现在截不出内容（可能还没加载完）。' };
      }
      fs.writeFileSync(picked, image.toPNG());
      const bytes = fs.statSync(picked).size;
      diagnostics.info('PAGE_SCREENSHOT', '保存了一张页面截图', { bytes });
      return { ok: true, path: picked, bytes };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      diagnostics.error('PAGE_SCREENSHOT_FAILED', '页面截图没能保存', { reason });
      return { ok: false, error: `截图没能保存：${reason}` };
    }
  });


  // 复制进程详情：和摘要复制一样写完回读，剪贴板被占时不许假装成功
  ipcMain.handle('nyx:proc:copy', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text) return { ok: false, error: '没有可复制的内容' };
    try {
      await writeClipboardText(text);
      const readback = await readClipboardText();
      if (!readback || !readback.includes(text.split('\n')[0].slice(0, 20))) {
        return { ok: false, error: '系统剪贴板当前不可用（可能被其它程序占用），进程详情没能复制' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `复制失败：${err && err.message ? err.message : err}` };
    }
  });

  /**
   * 摘要面板的开与关（清单 A2）。
   *
   * 摘要面板是外壳 DOM，标签页是 WebContentsView——只调 z-index 没用，
   * 视图永远盖在外壳上面。所以面板一展开，就让标签视图把右侧那块宽度让出来：
   * 页面变窄一点，面板完整可见；工具箱也开着时两边各占一份宽度，互不重叠。
   */
  ipcMain.handle('nyx:digest:panel', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    runtime.digestOpen = input.open === true;
    const inset = applyRightInsets();
    return {
      ok: true,
      open: runtime.digestOpen,
      width: runtime.digestOpen ? DIGEST_PANEL_W : 0,
      gap: DIGEST_PANEL_GAP,
      toolboxOpen: runtime.toolboxOpen,
      toolboxWidth: runtime.toolboxOpen ? runtime.toolboxWidth : 0,
      inset,
    };
  });

  /**
   * 顶栏「更多」菜单展开时，临时把外壳底部让出一段高度（清单 B1 的修补）。
   *
   * 菜单是外壳 DOM，页面是 WebContentsView——菜单朝下铺开就会伸到外壳之外，
   * 被页面原生视图盖住。这里不猜菜单多高：渲染层量完自己报上来，主进程只负责改标签视图的起点。
   * 关掉（extra=0）就恢复原样。
   */
  ipcMain.handle('nyx:shell:extra', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const extra = runtime.tabManager ? runtime.tabManager.setShellExtra(input.extra) : 0;
    return { ok: true, extra, uiHeight: UI_HEIGHT };
  });

  // agent 状态面板（清单 A5）：和摘要面板一样贴右边、同样让标签视图让位。
  // 返回体里带三色灯、最近几条动作、急停状态，界面一次拿全，不用拼三个请求。
  ipcMain.handle('nyx:agent:panel', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    if (typeof input.open === 'boolean') {
      runtime.agentPanelOpen = input.open;
      applyRightInsets();
    }
    let recent = [];
    if (runtime.agentAudit) {
      const listed = runtime.agentAudit.list({ limit: 5 });
      recent = (listed && listed.rows ? listed.rows : []).map((row) => ({
        time: row.time || '',
        type: row.type || '',
        site: row.site || '',
        decision: row.decision || '',
        ok: row.ok !== false,
      }));
    }
    return {
      ok: true,
      open: runtime.agentPanelOpen === true,
      width: runtime.agentPanelOpen ? AGENT_PANEL_W : 0,
      gap: DIGEST_PANEL_GAP,
      lamp: buildAgentLamp(),
      stopped: runtime.agentStopped === true,
      stopShortcut: runtime.agentStopShortcut || AGENT_STOP_SHORTCUT,
      auditComplete: (runtime.agentMode || 'builtin') === 'builtin',
      recent,
      inset: applyRightInsets(),
    };
  });

  // 复制走主进程：写完回读校对，和失败页「复制详情」保持一致（剪贴板被占用时不许假装成功）
  ipcMain.handle('nyx:digest:copy', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text) return { ok: false, error: '没有可复制的内容' };
    try {
      await writeClipboardText(text);
      const readback = await readClipboardText();
      const head = text.split('\n')[0].slice(0, 40);
      if (!readback || (head && !readback.includes(head))) {
        return { ok: false, error: '系统剪贴板当前不可用（可能被其它程序占用），摘要没能复制' };
      }
      return { ok: true, readback };
    } catch (err) {
      return { ok: false, error: `复制失败：${err && err.message ? err.message : err}` };
    }
  });

  /**
   * 导出 Markdown（用户要求的第 3 项）。
   *
   * 三条规矩：
   * 1. 内容只从渲染端送来的 payload 里取——不在主进程重新抓一遍页面，
   *    否则文件和屏幕上的摘要会是两次不同的抽取。
   * 2. 落盘前必须让用户选位置，不往默认目录里偷偷写文件。
   * 3. 摘要没生成过就别造一个空文件，直接说清楚。
   */
  ipcMain.handle('nyx:digest:export', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const result = input.result && typeof input.result === 'object' ? input.result : null;
    if (!result) return { ok: false, error: '还没有生成摘要，先点「生成摘要」再导出。' };
    // CSV 只导网络统计：摘要句子与关键词不是表格，塞进单元格只会变成逗号地狱
    const format = input.format === 'csv' ? 'csv' : 'md';
    const win = runtime.mainWindow && !runtime.mainWindow.isDestroyed() ? runtime.mainWindow : null;
    let target = '';
    try {
      const picked = dialog.showSaveDialogSync(win, {
        title: format === 'csv' ? '导出网络统计（CSV）' : '导出页面摘要',
        defaultPath: path.join(
          app.getPath('documents'),
          format === 'csv' ? digestCsvFileName(new Date()) : digestFileName(new Date()),
        ),
        filters:
          format === 'csv'
            ? [{ name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'Markdown', extensions: ['md'] }],
        buttonLabel: '导出',
      });
      target = typeof picked === 'string' ? picked : '';
    } catch (err) {
      diagnostics.error('DIGEST_EXPORT_DIALOG_FAILED', '导出摘要时打不开保存对话框', {
        error: err && err.message,
      });
      return { ok: false, error: `打不开保存对话框：${err && err.message ? err.message : err}` };
    }
    if (!target) return { ok: false, canceled: true, error: '已取消导出。' };
    try {
      const body =
        format === 'csv' ? buildDigestCsv(result) : buildDigestMarkdown(result, { now: new Date() });
      fs.writeFileSync(target, body, 'utf8');
      diagnostics.info('DIGEST_EXPORTED', format === 'csv' ? '导出了页面摘要的网络统计（CSV）' : '导出了页面摘要（Markdown）', {
        path: target,
        bytes: Buffer.byteLength(body, 'utf8'),
      });
      return { ok: true, path: target, bytes: Buffer.byteLength(body, 'utf8'), format };
    } catch (err) {
      diagnostics.error('DIGEST_EXPORT_FAILED', '摘要没能写到磁盘', {
        path: target,
        error: err && err.message,
      });
      return { ok: false, error: `没能写入文件：${err && err.message ? err.message : err}` };
    }
  });
}

/**
 * 接入模式的 IPC（清单 A）：切换要两次确认，第二次还要显式勾风险。
 * 这里不接受"跳过确认"的捷径——清单 §3 把"不可关闭的强提醒"列为不可回退约束。
 */
function registerAgentModeIpc() {
  ipcMain.handle('nyx:agent:mode', () => agentModeStatus());

  ipcMain.handle('nyx:agent:mode-set', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const plan = planAgentModeSwitch({
      current: runtime.agentMode,
      target: input.target,
      stage: input.stage,
      ackRisk: input.ackRisk === true,
    });
    if (!plan.ok) {
      // 需要确认不是错误状态，但对界面来说"没改成"，要说清还差哪一步
      return { ...agentModeStatus(), ...plan, ok: false };
    }
    const saved = writeAgentMode(plan.target);
    const status = agentModeStatus();
    if (!saved.ok) return { ...status, ok: false, error: saved.error };
    diagnostics.warn('AGENT_MODE_CHANGED', `agent 接入模式改为「${describeAgentMode(plan.target).label}」`, {
      from: plan.current,
      to: plan.target,
      needsRestart: plan.needsRestart === true,
      debugPort: runtime.agentDebugPort,
    });
    if (plan.target === 'external') {
      notifyNotice({
        level: 'warn',
        code: 'AGENT_MODE_EXTERNAL',
        title: '已改为外部接入模式（需要重启）',
        message:
          '重启后 Nyx 会打开 CDP 端口，外部程序可以直接驱动浏览器；审计只能覆盖经过浏览器的部分，界面上会常驻「审计不完整」标识。',
      });
    } else {
      notifyNotice({
        level: 'info',
        code: 'AGENT_MODE_BUILTIN',
        title: '已改回内置模式（需要重启）',
        message: '重启后 agent 的每个动作都会重新经过统一通道，审计恢复完整。',
      });
    }
    return { ...status, ok: true, ...plan, applied: false, message: plan.message };
  });
}

async function startLocalApi() {
  runtime.apiToken = ensureApiToken();
  // 站点授权（清单 E）：名单读盘失败时按空名单启动（即"每个站点都要问一次"），
  // 绝不因为文件坏了就变成"全部放行"。
  runtime.agentSites = readAgentSites();

  // 审计面（清单 D）：内存环形缓冲给界面，jsonl 落盘给事后翻账。
  // 落盘走 fs.appendFileSync，失败只会计数 + 打印，不会让动作本身失败。
  const auditFile = userDataFile('agent-audit.jsonl');
  runtime.agentAudit = new AgentAudit({
    filePath: auditFile,
    appendFile: (target, text) => {
      if (!text) return;
      fs.appendFileSync(target, text);
    },
    statSize: (target) => {
      try {
        return fs.statSync(target).size;
      } catch {
        return 0;
      }
    },
  });

  const runner = createActionRunner({
    getTabManager: () => runtime.tabManager,
    getMode: () => sessions.getMode(),
    // 标签管理器未就绪时的状态兜底里也要有出站链路，否则 /state 会出现"时有时无"的字段
    getNetwork: () => networkSnapshot(),
    getRiskLog,
    // 改设置（用户第 6 项）：读 schema 与写改动都走 agent-settings.js 的规则，
    // 这里只负责"把结论落到 uiStore 上"，不做任何额外放行
    getSettings: () => agentSettingsSnapshot(),
    applySetting: (params) => applyAgentSetting(params),
  });

  // 所有 agent 动作唯一入口：权限判定 → 人工确认 → 留痕 → 执行 → 回写结果
  runtime.agentDispatcher = createDispatcher({
    runner,
    mode: () => runtime.agentMode,
    site: currentAgentSite,
    authorize: authorizeAgentAction,
    confirm: confirmAgentAction,
    audit: recordAgentAudit,
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
    // 版本号取真实的 app 版本（旧版 /health 里硬编码 0.1.0，排障时误导人）
    version: app.getVersion(),
    // 只传通道，不传执行器：执行器从这里拿不到，绕不过权限与留痕
    dispatch: (action) => runtime.agentDispatcher.dispatch(action),
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
