'use strict';

/**
 * Session 分区与网络策略管理。
 *
 * 普通模式：partition = 'persist:nyx-normal'
 *   → Cookie、localStorage、IndexedDB、缓存等落盘持久化。
 * 隐私模式：partition = 'nyx-private'（不带 persist: 前缀 = 纯内存态）
 *   → 所有存储与缓存只存在于内存，切回普通模式或退出应用时整体清空。
 *
 * 出站链路按模式分流（link：'proxy' | 'direct'）：
 *   普通模式 → 代理可用则经本机代理，代理不可用则直连（可用优先，不拿可用性换"全局代理"）；
 *   隐私模式 → 恒为 proxy，代理不可达时由主进程拒绝进入，绝不直连。
 * 代理端口默认是 Nyx 内置内核的混合端口（内核就绪后由主进程注入），
 * 内核未运行时回落到外置 Clash Verge 的 7897。两个分区统一关闭拼写检查（避免输入内容外送）。
 *
 * 双模式的权限策略在此处分流（见 core/permissions.js）：
 *   正常模式 → 常规权限按站点请求弹原生确认，用户可授可拒；
 *   隐私模式 → 一律拒绝且不弹窗。
 *
 * 关于"绝不静默降级"：本模块不再吞掉 setProxy 的异常。代理配置失败会以
 * PROXY_SET_FAILED 错误码向上抛出，由主进程决定是否拒绝进入隐私模式。
 */

const { session } = require('electron');
const { installRiskGuard } = require('./risk-guard');
const { PermissionManager } = require('./permissions');

/** 代理地址（本机回环） */
const PROXY_HOST = '127.0.0.1';

/**
 * 内置代理内核不可用时的回落端口（本机 Clash Verge 混合端口）。
 * 内核就绪后由主进程注入实际端口，见 setProxyPort()。
 */
const FALLBACK_PROXY_PORT = 7897;

/** 运行期实际生效的代理端口 */
let activeProxyPort = FALLBACK_PROXY_PORT;

/** 取得当前生效的代理端口 */
function getProxyPort() {
  return activeProxyPort;
}

/**
 * 注入内置内核的实际混合端口，并立即向已建立的各分区重新下发代理配置。
 *
 * 端口要等内核起来才知道（需动态避让本机已占用端口），因此正常路径是
 * "先注入端口、再建立会话"；若注入发生在会话建立之后，这里会重新下发一次，
 * 避免分区仍指向旧端口。
 *
 * @param {number} port
 * @returns {boolean} 端口合法并已生效时返回 true
 */
function setProxyPort(port) {
  const next = Number(port);
  if (!Number.isInteger(next) || next <= 0 || next > 65535) return false;
  if (next === activeProxyPort) return true;

  activeProxyPort = next;
  refreshProxy();
  return true;
}

/** 按当前端口与各分区链路重新下发网络配置（替换结果表，允许上层重新等待） */
function refreshProxy() {
  for (const [key, ses] of sessionCache.entries()) {
    const pending = applyProxy(ses, key);
    pending.catch(() => {
      /* 真实错误由 whenSessionReady 上报 */
    });
    proxyAssembly.set(key, pending);
  }
}

/** 分区名映射 */
const PARTITIONS = {
  normal: 'persist:nyx-normal',
  private: 'nyx-private',
};

/** 已装配策略的 session 缓存：key -> Electron.Session */
const sessionCache = new Map();

/** 已完成静态策略（权限 / 拼写 / 下载 / 风控）装配的分区，保证幂等 */
const configuredParts = new Set();

/** 代理装配结果：key -> Promise<void>；reject 表示代理设置失败 */
const proxyAssembly = new Map();

/**
 * 权限管理器：正常模式弹原生确认，隐私模式一律拒绝。
 *
 * 默认实例不挂窗口（弹窗会退化为无父窗口的对话框），主进程启动时通过
 * initPermissions() 注入带窗口的实现。
 */
let permissionManager = new PermissionManager();

/** 注入权限管理器（主进程在窗口创建后调用，以便弹窗有父窗口） */
function initPermissions(options) {
  permissionManager = new PermissionManager(options || {});
  return permissionManager;
}

/** 取得权限管理器（界面与验收脚本查询授权轨迹用） */
function getPermissionManager() {
  return permissionManager;
}

/**
 * 页面预加载脚本的启动参数（模式 → 参数数组）。
 *
 * 隐私模式的参数由 core/privacy-hardening.js 依据出口画像生成，必须由主进程
 * 在建立标签前写入；标签管理器每次新建视图时读取这里的当前值。
 */
const preloadArgs = new Map([
  ['normal', ['--nyx-mode=normal']],
  ['private', ['--nyx-mode=private']],
]);

/** 写入某模式的预加载参数 */
function setPreloadArgs(mode, args) {
  const key = mode === 'private' ? 'private' : 'normal';
  preloadArgs.set(key, Array.isArray(args) && args.length ? args.slice() : [`--nyx-mode=${key}`]);
  return preloadArgs.get(key);
}

/** 读取某模式（默认当前模式）的预加载参数 */
function getPreloadArgs(mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';
  return (preloadArgs.get(key) || [`--nyx-mode=${key}`]).slice();
}

/**
 * 页面预加载脚本的结构化配置（模式 → 配置对象）。
 *
 * 与 preloadArgs 是同一份 profile 的两种载体：argv 在 sandbox 渲染进程里不保证
 * 可见，标签的预加载脚本会在启动瞬间用 nyx:tab:config 同步 IPC 向主进程取这份
 * 结构化配置，argv 只作兜底。两者必须同时写入，避免"主进程说的"与"页面里报的"
 * 出现分歧。
 */
const preloadConfigs = new Map([
  ['normal', { mode: 'normal' }],
  ['private', { mode: 'private' }],
]);

/** 写入某模式的结构化预加载配置 */
function setPreloadConfig(mode, config) {
  const key = mode === 'private' ? 'private' : 'normal';
  const next = config && typeof config === 'object' ? { ...config } : { mode: key };
  preloadConfigs.set(key, next);
  return { ...next };
}

/** 读取某模式（默认当前模式）的结构化预加载配置 */
function getPreloadConfig(mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';
  return { ...(preloadConfigs.get(key) || { mode: key }) };
}

/** 当前全局模式 */
let currentMode = 'normal';

/**
 * 各分区的出站链路：
 *   'proxy'  → 强制经本机代理（fixed_servers）；
 *   'direct' → 显式直连。
 *
 * 隐私分区恒为 'proxy'：本模块拒绝任何"把隐私分区置为直连"的调用，
 * 避免出现"名义隐私、实际直连"——是否允许直连是产品红线，不能只靠调用方自觉。
 */
const links = new Map([
  ['normal', 'direct'],
  ['private', 'proxy'],
]);

/**
 * 固定代理配置：出站流量强制经本机代理。
 * 只有回环地址（本地 AI 接口）直连，不走代理。
 */
function buildProxyConfig() {
  return {
    mode: 'fixed_servers',
    proxyRules: `http=${PROXY_HOST}:${activeProxyPort};https=${PROXY_HOST}:${activeProxyPort}`,
    proxyBypassRules: '<local>',
  };
}

/**
 * 直连配置。
 *
 * 必须显式给 'direct'，不能图省事用 'system'：系统代理开关（Clash 的"系统代理"）
 * 一旦被打开，'system' 会把普通模式重新拽回代理，与"直连"语义不符；
 * 'direct' 也不会去读 PAC / WPAD，行为完全确定。
 */
function buildDirectConfig() {
  return { mode: 'direct', proxyBypassRules: '<local>' };
}

/**
 * 智能分流（PAC）配置：由 smart-patrol 生成的脚本按域名决定
 * 直连（国内站点）还是走代理（被墙站点）。PAC 更新无需重建 session，
 * 通过 setSmartPac() 重新下发即可，代价远低于切换 fixed_servers。
 */
let smartPac = '';

function buildSmartConfig(pacText) {
  const data = pacText || smartPac;
  // 安全兜底：PAC 缺失时退化为全代理，绝不放行"名义智能、实际裸连"
  if (!data) return buildProxyConfig();
  return {
    mode: 'pac_script',
    pacScript: { data, mandatory: true },
    proxyBypassRules: '<local>',
  };
}

/** 按链路取该分区的网络配置 */
function buildConfigFor(link) {
  if (link === 'smart') return buildSmartConfig();
  return link === 'proxy' ? buildProxyConfig() : buildDirectConfig();
}

/**
 * 更新智能分流 PAC 文本并立即重新下发（仅 smart 链路生效；
 * 其他链路下次切到 smart 时自动带上最新 PAC）。
 * @returns {Promise<boolean>} 是否已下发
 */
async function setSmartPac(pacText) {
  smartPac = pacText || '';
  const key = currentMode === 'private' ? 'private' : 'normal';
  if (getLink(key) !== 'smart') return false;
  const ses = sessionCache.get(key);
  if (!ses) return false;
  await ses.setProxy(buildSmartConfig(smartPac));
  return true;
}

/** 读取某分区（默认当前模式）的出站链路 */
function getLink(mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';
  return links.get(key) || (key === 'private' ? 'proxy' : 'direct');
}

/**
 * 设置某分区的出站链路，并立即把对应网络配置下发到已建立的 session。
 *
 * @param {'normal'|'private'} mode
 * @param {'proxy'|'direct'} link
 * @returns {boolean} 链路是否发生了变化（调用方据此决定是否记录日志 / 推送状态）
 */
function setLink(mode, link) {
  const key = mode === 'private' ? 'private' : 'normal';
  const next = link === 'proxy' ? 'proxy' : 'direct';

  // 隐私分区绝不直连：直接拒绝并保持原链路
  if (key === 'private' && next === 'direct') {
    console.warn('[Nyx] 已拒绝把隐私分区置为直连（隐私模式必须经代理）');
    return false;
  }

  const changed = getLink(key) !== next;
  links.set(key, next);

  // 无论是否变化都重新下发：进入隐私模式前的那次调用依赖 whenSessionReady()
  // 拿到"配置真的生效了 / 真的失败了"的结果，跳过下发会让这道闸门失去意义。
  const ses = sessionCache.get(key);
  if (ses) {
    const pending = applyProxy(ses, key);
    pending.catch(() => {
      /* 真实错误由 whenSessionReady 上报 */
    });
    proxyAssembly.set(key, pending);
  }

  return changed;
}

/**
 * 装配与网络无关的静态策略（幂等：同一分区只执行一次，避免重复挂监听）。
 */
function configureSessionOnce(ses, mode) {
  if (configuredParts.has(mode)) return;
  configuredParts.add(mode);

  // 权限按模式分流：
  //   正常模式 → 摄像头 / 麦克风 / 定位 / 通知 / 剪贴板读取等按站点请求弹原生确认
  //   隐私模式 → 一律拒绝且不弹窗
  permissionManager.attach(ses, mode);

  // 关闭拼写检查（默认会向远端服务请求词典，属于隐性外联）
  ses.setSpellCheckerEnabled(false);

  // 隐私模式：禁止任何下载落盘
  if (mode === 'private') {
    ses.on('will-download', (event) => event.preventDefault());
  }

  // 实时风控
  installRiskGuard(ses, { mode });
}

/**
 * 下发分区的网络配置（按其当前链路：代理 / 直连）。
 *
 * 失败时向上抛出（错误码 PROXY_SET_FAILED），绝不吞掉异常：
 * 一旦配置没下发成功又继续放行流量，等价于静默降级成了一套没人知道的链路。
 */
async function applyProxy(ses, mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';
  const link = getLink(key);

  try {
    await ses.setProxy(buildConfigFor(link));
  } catch (err) {
    const wrapped = new Error(
      link === 'proxy'
        ? `代理设置失败（${PROXY_HOST}:${activeProxyPort}）：${err.message}`
        : `直连配置下发失败：${err.message}`,
    );
    wrapped.code = 'PROXY_SET_FAILED';
    throw wrapped;
  }
}

/**
 * 取得指定模式的 Session（首次访问时装配策略）。
 * @param {'normal'|'private'} [mode]
 */
function getSession(mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';

  if (!sessionCache.has(key)) {
    const ses = session.fromPartition(PARTITIONS[key]);
    configureSessionOnce(ses, key);
    sessionCache.set(key, ses);
  }

  // 网络配置异步下发。失败结果保留在表中，由 whenSessionReady 抛给上层；
  // 这里额外挂一个空 catch，避免产生未处理的 Promise rejection 告警。
  if (!proxyAssembly.has(key)) {
    const pending = applyProxy(sessionCache.get(key), key);
    pending.catch(() => {
      /* 真实错误由 whenSessionReady 上报 */
    });
    proxyAssembly.set(key, pending);
  }

  return sessionCache.get(key);
}

/**
 * 等待指定分区的代理配置真正下发生效。
 *
 * @param {'normal'|'private'} [mode]
 * @throws {Error} 代理设置失败时抛出（err.code === 'PROXY_SET_FAILED'）
 */
async function whenSessionReady(mode = currentMode) {
  const key = mode === 'private' ? 'private' : 'normal';
  getSession(key);

  const pending = proxyAssembly.get(key);
  if (!pending) return;

  try {
    await pending;
  } catch (err) {
    proxyAssembly.delete(key); // 允许下次重新下发代理配置
    throw err;
  }
}

/** 清空单个 session 的全部内存与磁盘痕迹 */
async function purgeSession(ses) {
  if (!ses) return;

  const results = await Promise.allSettled([
    ses.clearStorageData(), // Cookie / localStorage / IndexedDB / CacheStorage / ServiceWorker …
    ses.clearCache(),
    ses.clearAuthCache(),
    ses.clearHostResolverCache(),
    ses.clearCodeCaches({}),
  ]);

  results
    .filter((item) => item.status === 'rejected')
    .forEach((item) => {
      const reason = item.reason && item.reason.message ? item.reason.message : item.reason;
      console.warn('[Nyx] 清场部分失败：', reason);
    });

  try {
    ses.flushStorageData();
  } catch {
    /* 忽略：部分平台无此接口 */
  }
}

/** 清空隐私分区（离开隐私模式 / 退出应用时调用） */
async function purgePrivateSession() {
  await purgeSession(sessionCache.get('private'));
}

/** 清空所有分区（恐慌清场时调用） */
async function purgeAll() {
  await Promise.allSettled([
    purgeSession(sessionCache.get('private')),
    purgeSession(sessionCache.get('normal')),
  ]);
}

function getMode() {
  return currentMode;
}

function setMode(mode) {
  currentMode = mode === 'private' ? 'private' : 'normal';
  return currentMode;
}

module.exports = {
  PROXY_HOST,
  FALLBACK_PROXY_PORT,
  getProxyPort,
  setProxyPort,
  refreshProxy,
  getLink,
  setLink,
  setSmartPac,
  PARTITIONS,
  getSession,
  whenSessionReady,
  getMode,
  setMode,
  purgeSession,
  purgePrivateSession,
  purgeAll,
  initPermissions,
  getPermissionManager,
  setPreloadArgs,
  getPreloadArgs,
  setPreloadConfig,
  getPreloadConfig,
};
