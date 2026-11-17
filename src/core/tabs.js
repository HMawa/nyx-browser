'use strict';

/**
 * 标签管理器。
 *
 * 每个标签 = 一个 WebContentsView，叠加在主窗口 UI 外壳（顶部 92px）之下。
 * 标签的 Session 由外部按当前模式注入：
 *   - 普通模式 → persist:nyx-normal（持久化）
 *   - 隐私模式 → nyx-private（内存态）
 * 因此切换模式时所有标签会被销毁重建。
 */

const path = require('node:path');
const { WebContentsView } = require('electron');
// 加载失败的取值说明与诊断页共用同一张表：错误页写"给人看的中文原因"，
// 诊断日志写 errorCode，两处口径必须一致，否则用户看到的和日志对不上。
const { describeLoadError } = require('./diagnostics');
// 清单 A3：给每个视图挂上可辨识的身份参数（任务管理器「命令行」列可见）
const { buildTabProcessArgs, mergeAdditionalArguments } = require('./process-args');
// 安全审计 P2：普通模式不再用 Electron 默认 UA（那个 UA 会自报 Nyx/Electron 与版本）
const { normalUserAgent } = require('./user-agent');
// 标签生命周期（清单 G）：休眠判定与文案。判定在纯函数里，执行（释放 / 重建视图）在这边，
// 两边用同一份判定，避免"判定说该睡、执行说没睡"的分裂。
const {
  AGENT_KEEP_AWAKE_MS,
  DEFAULT_SLEEP_AFTER_MS,
  decideTabLifecycle,
  describeLifecycle,
  normalizeSleepAfter,
  summarizeLifecycle,
} = require('./tab-lifecycle');

/** WebRTC IP 处理策略：禁用非代理 UDP，防止真实 IP 通过 STUN 泄漏 */
const WEBRTC_POLICY = 'disable_non_proxied_udp';

/**
 * 标签页预加载脚本：页面级防泄漏（隐私模式）与表单 / 密码自动填充（正常模式）的入口。
 *
 * 路径必须绝对且指向磁盘真实文件——preload 写错会让整个页面级加固静默失效
 * （视图照样能开，只是所有防泄漏与自动填充都不生效），因此这里用 __dirname 拼接。
 */
const TAB_PRELOAD = path.join(__dirname, '..', 'preload-tab.js');

/**
 * 内置应用页（设置）用的预加载脚本：与 UI 外壳同一份，页面里能直接拿到 `window.nyx`。
 *
 * 为什么应用页要单独一条路径：标签默认用 `preload-tab.js`，那是"给外部网页用的"
 * 加固脚本，没有 `window.nyx`；设置页是本地可信页面，必须走外壳 preload 才能调主进程。
 */
const APP_PRELOAD = path.join(__dirname, '..', 'preload.js');

/**
 * 把地址栏输入整理成可加载的 URL：
 *   已带协议 → 原样；裸 IP / localhost → http://；像域名 → https://；其余 → 搜索
 */
function normalizeInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;

  if (/^localhost(:\d+)?(\/.*)?$/i.test(raw)) return `http://${raw}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(raw)) return `http://${raw}`;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(raw)) return `https://${raw}`;

  return `https://www.bing.com/search?q=${encodeURIComponent(raw)}`;
}

/**
 * HTTP 状态码 → 给人看的中文原因。
 *
 * 服务器有响应（4xx/5xx）和连不上（net 错误）是两类完全不同的故障：
 * 前者说明网络通了、是服务端拒绝；后者说明根本没连上。错误页必须分清这两类，
 * 否则用户会照着"检查网络"的提示去排查一个 404。
 */
const HTTP_STATUS_REASONS = new Map([
  [400, '请求格式不合法，服务端没有接受这次请求'],
  [401, '这个页面需要登录，当前身份未通过验证'],
  [403, '服务端拒绝了这次访问（可能需要登录、或你的网络出口被限制）'],
  [404, '地址对应的页面不存在（可能已被删除或链接写错）'],
  [405, '服务端不允许用这种方式访问该地址'],
  [406, '服务端无法按浏览器声明的格式返回内容'],
  [407, '代理要求先完成身份验证'],
  [408, '服务端等待请求超时'],
  [409, '请求与服务器当前状态冲突'],
  [410, '该页面已被永久移除'],
  [413, '请求体过大，被服务端拒绝'],
  [414, '地址过长，被服务端拒绝'],
  [429, '请求过于频繁，服务端限流了，请稍后再试'],
  [451, '因法律原因，该页面在当前网络下不可访问'],
  [500, '服务端内部出错了'],
  [501, '服务端不支持该请求'],
  [502, '网关从上游收到了无效响应（常见于代理链路异常）'],
  [503, '服务端暂时不可用（过载或维护中）'],
  [504, '网关等待上游响应超时（常见于代理链路慢或断）'],
  [505, '服务端不支持该 HTTP 版本'],
  [520, '服务端返回了未知错误（Cloudflare）'],
  [521, '源站拒绝连接（Cloudflare）'],
  [522, '连接源站超时（Cloudflare）'],
  [523, '源站不可达（Cloudflare）'],
  [524, '源站响应超时（Cloudflare）'],
]);

/**
 * 按状态码给出中文原因与一句话标题。
 * @param {number} status HTTP 状态码
 * @param {string} [statusText] 服务端原始状态短语（可能为空）
 * @returns {{title: string, reason: string}}
 */
function describeHttpStatus(status, statusText) {
  const code = Number(status) || 0;
  const known = HTTP_STATUS_REASONS.get(code);
  const suffix = statusText ? `（${statusText}）` : '';

  let title;
  if (code === 404 || code === 410) title = '页面不存在';
  else if (code === 401 || code === 403 || code === 407) title = '没有访问权限';
  else if (code === 429) title = '请求太频繁了';
  else if (code >= 500) title = '服务端出错了';
  else if (code >= 400) title = '请求被拒绝了';
  else title = '这一页没能打开';

  const reason = known
    ? `${known}${suffix}`
    : `服务端返回了 HTTP ${code}${suffix}，没有给出可读的原因`;
  return { title, reason };
}

class TabManager {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow 承载 UI 外壳的主窗口
   * @param {number} options.uiHeight UI 外壳高度（px），标签视图从其下方开始
   * @param {number} options.maxTabs 标签数上限
   * @param {string} options.defaultUrl 新标签默认地址
   * @param {string} [options.homeUrl] 起始页地址（命中它时按应用页打开）
   * @param {() => Electron.Session} options.resolveSession 按当前模式返回 Session
   * @param {() => 'normal'|'private'} options.getMode 读取当前模式
   * @param {() => string[]} [options.getPreloadArgs] 读取当前模式的预加载参数
   * @param {(mode:string) => string} [options.getWebrtcPolicy] 按模式返回 WebRTC 策略
   * @param {() => object} [options.getNetwork] 读取当前出站链路状态（随快照下发）
   * @param {(info: object) => void} [options.onLoadFailure] 主框架加载失败回调（普通模式代理失效兜底用）
   * @param {(snapshot: object) => void} [options.onChange] 状态变化回调
   */
  constructor(options) {
    this.mainWindow = options.mainWindow;
    this.uiHeight = options.uiHeight;
    this.maxTabs = options.maxTabs;
    this.defaultUrl = options.defaultUrl;
    this.homeUrl = options.homeUrl || '';
    this.resolveSession = options.resolveSession;
    this.getMode = options.getMode;
    this.getPreloadArgs = options.getPreloadArgs || (() => [`--nyx-mode=${this.getMode()}`]);
    this.getWebrtcPolicy =
      options.getWebrtcPolicy || (() => WEBRTC_POLICY);
    this.getNetwork = options.getNetwork || (() => null);
    this.onLoadFailure = options.onLoadFailure || (() => {});
    this.onChange = options.onChange || (() => {});
    this.onTabCreated = options.onTabCreated || (() => {});
    /**
     * 窗口登记回调（清单 C3）：每建一个视图就把「角色 + 实际 webPreferences」报给主进程，
     * 供设置里的「外壳防护」现值表当场比对期望值。传空则不做登记（单测/无界面场景）。
     * @type {(role: string, prefs: object) => void}
     */
    this.onSecurityWindow = options.onSecurityWindow || (() => {});

    /**
     * 工具箱右侧抽屉占用宽度（px）。
     *
     * 工具箱是 UI 外壳里的一块浮层，标签是叠加在外壳之上的 WebContentsView，
     * 不主动收窄就会把面板盖住。这里由工具箱开关状态驱动，
     * 标签层不关心工具箱内部逻辑，只认这一个数字。
     */
    this.rightInset = 0;

    /**
     * 外壳底部临时多让出的高度（px），0 = 正常。
     *
     * 顶栏的「更多」菜单朝下铺开，而标签页是叠加在外壳之上的 WebContentsView：
     * 菜单一旦伸到外壳外面就会被页面盖住（z-index 再高也没用，原生视图永远在 DOM 上层）。
     * 所以菜单展开时把外壳临时加高，让菜单落在外壳自己的地盘里——和工具箱让出右侧宽度一个道理。
     */
    this.shellExtra = 0;

    /** @type {Array<{id:number, view:Electron.WebContentsView, url:string, title:string, loading:boolean, canGoBack:boolean, canGoForward:boolean}>} */
    this.tabs = [];
    this.activeId = null;
    /**
     * 切模式时"停靠"起来的标签（见 parkAll / restoreParked）。
     * 上限 12 个是用户确认过的预算：超出部分降级成"只记地址"，恢复时重开并明说状态丢失。
     */
    this.parkedTabs = [];
    this.parkedDropped = [];
    this.parkedActiveId = null;
    this.maxParked = 12;
    this.seq = 1;

    /**
     * 后台标签闲置多久后休眠（清单 G）。0 = 关闭休眠。
     * 默认 30 分钟；自动化验证用 NYX_TAB_SLEEP_MS 调小。
     */
    this.sleepAfterMs = normalizeSleepAfter(
      options.sleepAfterMs === undefined ? DEFAULT_SLEEP_AFTER_MS : options.sleepAfterMs,
      DEFAULT_SLEEP_AFTER_MS,
    );

    /** 是否有 agent 会话在跑：有的话所有标签都不许休眠（清单 G 的关键例外） */
    this.agentSessionActive = false;

    /** 休眠巡检定时器（5 秒一次，够细也不费电） */
    this.lifecycleTimer = null;
  }

  /**
   * 改休眠阈值（设置页可调）。立刻生效，不用重启。
   * @param {number} ms 0 = 关闭休眠
   * @returns {number} 实际生效的毫秒数
   */
  setSleepAfterMs(ms) {
    const next = normalizeSleepAfter(ms, DEFAULT_SLEEP_AFTER_MS);
    if (next === this.sleepAfterMs) return this.sleepAfterMs;
    this.sleepAfterMs = next;
    // 阈值改小可能让某些后台标签马上符合休眠条件；改大则要把已睡的唤醒回来。
    this.applyLifecycle();
    this.emit();
    return this.sleepAfterMs;
  }

  /**
   * 标记某个标签刚被 agent 操作过：在一段时间内不许休眠。
   * @param {number} [tabId] 缺省用当前标签
   * @param {number} [ttlMs]
   */
  markAgentDriven(tabId, ttlMs = AGENT_KEEP_AWAKE_MS) {
    const tab = tabId ? this.tabs.find((item) => item.id === tabId) : this.active;
    if (!tab) return { ok: false, error: '当前没有活动标签' };
    tab.agentDrivenUntil = Date.now() + Math.max(0, Number(ttlMs) || 0);
    // 已经睡了的，agent 要找它就得先醒过来，而不是让它对着一个空壳报错
    if (tab.asleep) this.wakeTab(tab);
    return { ok: true, id: tab.id, agentDrivenUntil: tab.agentDrivenUntil };
  }

  /** 设置 agent 会话状态：true 时任何标签都不休眠 */
  setAgentSessionActive(flag) {
    const next = Boolean(flag);
    if (next === this.agentSessionActive) return;
    this.agentSessionActive = next;
    this.emit();
  }

  /** 启动休眠巡检 */
  startLifecycle() {
    if (this.lifecycleTimer) return;
    this.lifecycleTimer = setInterval(() => this.applyLifecycle(), 5000);
    // 只是内部巡检，不该拖住进程退出
    if (typeof this.lifecycleTimer.unref === 'function') this.lifecycleTimer.unref();
  }

  /** 停止休眠巡检（关闭全部标签 / 退出时调用） */
  stopLifecycle() {
    if (!this.lifecycleTimer) return;
    clearInterval(this.lifecycleTimer);
    this.lifecycleTimer = null;
  }

  /** 逐个标签判定并执行休眠 / 唤醒 */
  applyLifecycle() {
    const now = Date.now();
    let changed = false;
    for (const tab of this.tabs) {
      const decision = decideTabLifecycle({
        isActive: tab.id === this.activeId,
        asleep: Boolean(tab.asleep),
        idleMs: now - (tab.lastActiveAt || now),
        sleepAfterMs: this.sleepAfterMs,
        agentDrivenUntil: tab.agentDrivenUntil || 0,
        agentSessionActive: this.agentSessionActive,
        noSleep: Boolean(tab.noSleep),
        now,
      });
      if (decision.state === 'asleep' && !tab.asleep) {
        this.sleepTab(tab);
        changed = true;
      } else if (decision.keepAwake && tab.asleep) {
        this.wakeTab(tab);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /**
   * 让标签休眠：释放 WebContentsView 与它的渲染进程，只留一条记录。
   *
   * 诚实边界：休眠等于把页面卸载了，页面里的未提交输入、滚动位置会丢；
   * 重新点开是按原地址重新加载。这也是为什么 agent 驱动的标签永不休眠。
   */
  sleepTab(tab) {
    if (!tab || tab.asleep || !tab.view) return { ok: false, error: '这个标签不能休眠' };
    const wc = tab.view.webContents;
    tab.sleepUrl = tab.url && tab.url !== 'about:blank' ? tab.url : tab.sleepUrl || tab.url;
    try {
      this.mainWindow.contentView.removeChildView(tab.view);
    } catch {
      /* 忽略：窗口可能已销毁 */
    }
    try {
      wc.close();
    } catch {
      /* 忽略 */
    }
    tab.view = null;
    tab.asleep = true;
    tab.loading = false;
    tab.canGoBack = false;
    tab.canGoForward = false;
    tab.loadError = null;
    return { ok: true, id: tab.id };
  }

  /**
   * 唤醒休眠标签：按原地址重建视图并加载。
   * @returns {{ok:boolean, id?:number, error?:string}}
   */
  wakeTab(tab) {
    if (!tab) return { ok: false, error: '标签不存在' };
    if (!tab.asleep) return { ok: true, id: tab.id };
    if (!tab.prefs) return { ok: false, error: '这个标签缺少重建参数，无法唤醒' };

    let view;
    try {
      // 清单 A3：唤醒时要按「现在这个地址」重写身份参数——休眠期间可能已经改过地址，
      // 沿用建视图那次的 --nyx-host 会让任务管理器里显示的是旧站点，比没有更糟。
      const baseArgs = (tab.prefs.additionalArguments || []).filter(
        (item) => !String(item).startsWith('--nyx-'),
      );
      tab.prefs = {
        ...tab.prefs,
        additionalArguments: mergeAdditionalArguments(
          baseArgs,
          buildTabProcessArgs({ tabId: tab.id, kind: 'tab', url: tab.sleepUrl || tab.url }),
        ),
      };
      view = new WebContentsView({ webPreferences: tab.prefs });
    } catch (err) {
      // 重建失败必须说出来，不能留一个点了没反应的标签
      console.error('[Nyx] 唤醒标签失败：', err && err.message);
      tab.asleep = false;
      tab.title = '唤醒失败';
      this.emit();
      return { ok: false, error: `唤醒标签失败：${(err && err.message) || '未知错误'}` };
    }

    tab.view = view;
    tab.asleep = false;
    tab.loading = true;
    this.mainWindow.contentView.addChildView(view);
    this.bindEvents(tab);

    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy(this.getWebrtcPolicy(this.getMode()));
    wc.setWindowOpenHandler(({ url }) => {
      this.create(url);
      return { action: 'deny' };
    });

    const target = tab.sleepUrl || tab.url || this.defaultUrl;
    tab.url = target;
    tab.requestedUrl = target;
    // 重建后工具箱的粘性设置（UA / 视口 / 限速）要重新施加一遍
    // 同样：返回 Promise（隐私模式要先注册指纹补丁）就等它，再加载
    let gate = null;
    try {
      gate = this.onTabCreated(tab);
    } catch (err) {
      console.warn('[Nyx] 标签重建回调异常：', err.message);
    }
    const startLoad = () => {
      wc.loadURL(target).catch((err) => {
        console.warn('[Nyx] 唤醒后加载失败：', err && err.message);
      });
    };
    if (gate && typeof gate.then === 'function') gate.then(startLoad, startLoad);
    else startLoad();
    this.layout();
    this.emit();
    return { ok: true, id: tab.id };
  }

  /** 当前激活标签 */
  get active() {
    return this.tabs.find((tab) => tab.id === this.activeId) || null;
  }

  /** 当前激活标签的 webContents（AI 接口的操作目标） */
  getActiveWebContents() {
    const tab = this.active;
    if (!tab || tab.asleep || !tab.view) return null;
    const wc = tab.view.webContents;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  /** 新建标签 */
  create(input) {
    if (this.tabs.length >= this.maxTabs) {
      return { ok: false, error: `标签数已达上限（${this.maxTabs} 个），请先关闭部分标签` };
    }

    const target = input ? normalizeInput(input) : this.defaultUrl;

    // 新标签页是本地起始页（清单 B1）：它要用外壳 preload 才能拿到 window.nyx，
    // 所以走应用页通道；但起始页不像设置那样单实例——开三个新标签就该有三个起始页。
    if (this.homeUrl && target === this.homeUrl) {
      return this.createAppPage({
        url: this.homeUrl,
        title: '新标签页',
        kind: 'start',
        singleInstance: false,
      });
    }

    const mode = this.getMode();

    const webPreferences = {
      session: this.resolveSession(),
      preload: TAB_PRELOAD,
      // 模式参数随视图创建注入：preload 必须"在页面脚本之前"就知道自己是
      // 哪种模式，否则加固只能事后补救（补不了已发生的泄漏）。
      // 清单 A3：再挂上 --nyx-kind / --nyx-tab / --nyx-host，让 Windows 任务管理器的
      // 「命令行」列能看出这个渲染进程是哪个标签（映像名改不了，参数能加）。
      additionalArguments: mergeAdditionalArguments(
        this.getPreloadArgs(mode),
        buildTabProcessArgs({ tabId: this.seq, kind: 'tab', url: target }),
      ),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 安全审计 P2：普通模式的 UA 只报真实内核，不报 Nyx/Electron。
      // 隐私模式会被 attachPrivacySurface() 用画像里的 UA 覆盖（那边口径更强）。
      ...(mode === 'private' ? {} : { userAgent: normalUserAgent() }),
    };
    // 登记到外壳防护现值表（清单 C3）：远端内容窗口必须沙箱 + 隔离 + 无 Node 能力
    this.onSecurityWindow('tab', webPreferences);

    const view = new WebContentsView({ webPreferences });

    const tab = {
      id: this.seq++,
      view,
      url: target,
      // 用户"想打开"的地址：失败后错误页的「重试」要用它，
      // 不能用 tab.url（导航失败时 tab.url 可能已经被改写成错误页/中间地址）。
      requestedUrl: target,
      title: '新标签页',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      // 加载失败信息（null = 正常）。有值时视图会被隐藏，页面区交给外壳的错误页。
      loadError: null,
      // 休眠相关（清单 G）：prefs 是重建视图的唯一依据，绝不能丢
      prefs: webPreferences,
      asleep: false,
      sleepUrl: '',
      agentDrivenUntil: 0,
      lastActiveAt: Date.now(),
      noSleep: false,
    };

    this.tabs.push(tab);
    this.mainWindow.contentView.addChildView(view);
    this.bindEvents(tab);

    // 新标签也要继承工具箱的粘性设置（UA / 视口 / 限速），否则每开一个标签都要重设。
    // 回调可能返回 Promise（隐私模式下要先把指纹补丁注册到新文档再导航），那就等它落地再 loadURL；
    // 返回 undefined 的旧回调照旧同步走，行为不变。
    let gate = null;
    try {
      gate = this.onTabCreated(tab);
    } catch (err) {
      console.warn('[Nyx] 标签创建回调异常：', err.message);
    }

    // 防泄漏 & 弹窗策略
    const wc = view.webContents;
    // 两种模式都禁止"非代理 UDP"：本浏览器的全部流量都强制经代理，
    // 放开非代理 UDP 等于让 STUN 把真实 IP 交给对端（正常模式同样会泄漏）。
    wc.setWebRTCIPHandlingPolicy(this.getWebrtcPolicy(mode));
    wc.setWindowOpenHandler(({ url }) => {
      this.create(url);
      return { action: 'deny' };
    });

    const startLoad = () => {
      wc.loadURL(target).catch((err) => {
        // 加载失败不抛出，交由 did-fail-load 呈现
        console.warn('[Nyx] 页面加载失败：', err.message);
      });
    };
    if (gate && typeof gate.then === 'function') {
      // 等指纹补丁落地；失败了也要照常加载页面（宁可标签能打开，不留下一个白页）
      gate.then(startLoad, startLoad);
    } else {
      startLoad();
    }

    this.activate(tab.id);
    return { ok: true, id: tab.id };
  }

  /**
   * 打开一个内置应用页（当前只有设置）。
   *
   * 为什么设置要变成标签页（清单 B4+B5）：设置原本是独立弹窗，改个配置得来回切窗口，
   * 而且工具栏齿轮和菜单项各开一份，用户看到「两个设置」。改成标签后只有一个入口、
   * 一个实例——再次点齿轮只是切回那个标签，不会叠出第二个设置。
   *
   * @param {object} options
   * @param {string} options.url 本地页面地址（file://）
   * @param {string} [options.title] 标签标题
   * @param {string} [options.kind] 应用页类型（用于复用判断，默认 'settings'）
   */
  createAppPage(options) {
    const url = String((options && options.url) || '');
    if (!url) return { ok: false, error: '应用页地址为空' };
    const kind = (options && options.kind) || 'settings';

    // 已经开着就只切过去：设置这类页面是单实例，不允许叠标签。
    // 起始页（singleInstance:false）例外——每个新标签都该有自己的一份。
    const singleInstance = !options || options.singleInstance !== false;
    if (singleInstance) {
      const existing = this.tabs.find((tab) => tab.kind === kind);
      if (existing) {
        this.activate(existing.id);
        return { ok: true, id: existing.id, reused: true };
      }
    }

    if (this.tabs.length >= this.maxTabs) {
      return { ok: false, error: `标签数已达上限（${this.maxTabs} 个），请先关闭部分标签` };
    }

    const appPreferences = {
      // 应用页是本地可信页面，用默认会话即可（换代理会话反而会让本地页面走代理）
      preload: APP_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      // 与外壳 preload 的要求一致：preload.js 里用到 Node 侧能力，sandbox 必须关
      sandbox: false,
      spellcheck: false,
      // 清单 A3：应用页（设置等）也带上身份参数，任务管理器里能一眼分辨
      additionalArguments: buildTabProcessArgs({
        tabId: this.seq,
        kind: (options && options.appPage) || 'settings',
        url: '',
      }),
    };
    // 登记到外壳防护现值表（清单 C3）：应用页与外壳同一取舍（sandbox 关），导航只放行 file://
    this.onSecurityWindow('app-page', appPreferences);

    const view = new WebContentsView({ webPreferences: appPreferences });

    const tab = {
      id: this.seq++,
      view,
      url,
      requestedUrl: url,
      title: (options && options.title) || '设置',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      kind,
      // 应用页是本地页面：内存占用极小，休眠只会在切换时多一次白屏，
      // 所以设置页不参与休眠（清单 G 的"不打断正常操作"取舍）。
      prefs: appPreferences,
      asleep: false,
      sleepUrl: '',
      agentDrivenUntil: 0,
      lastActiveAt: Date.now(),
      noSleep: kind === 'settings',
    };

    this.tabs.push(tab);
    this.mainWindow.contentView.addChildView(view);
    this.bindEvents(tab);

    const wc = view.webContents;
    // 本地页面不允许开新窗口，也不允许被导航到远端
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, targetUrl) => {
      if (!String(targetUrl).startsWith('file://')) event.preventDefault();
    });
    wc.loadURL(url).catch((err) => {
      console.warn('[Nyx] 应用页加载失败：', err && err.message);
    });

    this.activate(tab.id);
    return { ok: true, id: tab.id, reused: false };
  }

  /** 取某个应用页标签的 webContents（没开着就返回 null） */
  appPageWebContents(kind = 'settings') {
    const tab = this.tabs.find((item) => item.kind === kind);
    if (!tab || tab.asleep || !tab.view) return null;
    return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
  }

  /** 绑定标签生命周期事件 */
  bindEvents(tab) {
    const wc = tab.view.webContents;

    wc.on('page-title-updated', (_event, title) => {
      tab.title = title || tab.title;
      this.emit();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.syncNavState(tab);
      this.emit();
    });

    wc.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      tab.url = url;
      this.syncNavState(tab);
      // 服务器有响应但状态码是错误（404/403/5xx…）：Chromium 会照常渲染服务端页面，
      // 但大多数站点给出的错误页毫无信息量，这里统一换成 Nyx 自己的失败页。
      const status = Number(httpResponseCode) || 0;
      if (status >= 400) {
        this.presentLoadError(tab, { kind: 'http', url, status, statusText: httpStatusText || '' });
        return;
      }
      this.emit();
    });

    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url;
      this.syncNavState(tab);
      this.emit();
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED：用户中途停止、或刚发起就被下一次导航打断，不是故障，
      // 弹错误页会把"快速连点两次刷新"变成错误提示。
      if (errorCode === -3) return;
      this.presentLoadError(tab, {
        kind: 'net',
        url: validatedURL || tab.url,
        errorCode,
        errorDescription,
      });
      console.warn(`[Nyx] 加载失败 ${errorCode} ${errorDescription} → ${validatedURL}`);

      // 交给主进程判定"是不是代理链路失效"（普通模式代理中途关闭时页面首报的
      // 就是 ERR_PROXY_CONNECTION_FAILED），是否降级由主进程决定，标签层不自行处理。
      try {
        this.onLoadFailure({ tabId: tab.id, errorCode, errorDescription, url: validatedURL });
      } catch (err) {
        console.error('[Nyx] 加载失败回调异常：', err.message);
      }
    });

    wc.on('render-process-gone', () => {
      tab.title = '页面已崩溃';
      this.emit();
    });
  }

  syncNavState(tab) {
    if (!tab || !tab.view) {
      if (tab) {
        tab.canGoBack = false;
        tab.canGoForward = false;
      }
      return;
    }
    try {
      tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
      tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward();
    } catch {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
  }

  /** 关闭标签 */
  close(id) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return { ok: false, error: `标签不存在：${id}` };

    const [tab] = this.tabs.splice(index, 1);

    if (tab.view) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {
        /* 忽略：窗口可能已销毁 */
      }
      try {
        tab.view.webContents.close();
      } catch {
        /* 忽略 */
      }
      tab.view = null;
    }

    if (this.activeId === id) {
      const fallback = this.tabs[index] || this.tabs[index - 1] || null;
      this.activeId = fallback ? fallback.id : null;
    }

    // 最后一个标签被关闭时自动补一个空白标签，避免出现"无内容区"
    if (this.tabs.length === 0) {
      return this.create(this.defaultUrl);
    }

    this.layout();
    this.emit();
    return { ok: true };
  }

  /** 关闭全部标签（不清空 session） */
  closeAll() {
    this.stopLifecycle();
    while (this.tabs.length > 0) {
      const tab = this.tabs.pop();
      if (!tab.view) continue;
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {
        /* 忽略 */
      }
      try {
        tab.view.webContents.close();
      } catch {
        /* 忽略 */
      }
      tab.view = null;
    }
    this.activeId = null;
    this.emit();
    return { ok: true };
  }

  /**
   * 切模式前的"停靠"：把标签从窗口上卸下来，但不销毁页面。
   *
   * 为什么要有这一步：切模式时 session 会换，旧标签确实不能再用了——但"不能用了"
   * 不等于"必须销毁"。用户正在填的表单、滚到一半的长文，都挂在这个 WebContents 上，
   * 一 close 就全没了（改造前的 closeAll 就是这样，实测会丢）。
   *
   * 做法：视图从 contentView 上摘下来（不再渲染、不再占显存），WebContents 保活并静音，
   * 标签对象整体挪进 parkedTabs。回到普通模式时原样挂回去，页面状态（含表单、滚动、
   * 历史）都在。
   *
   * 上限 12 个（用户确认过的预算）：超出的按"地址 + 标题"降级记录，恢复时重新打开，
   * 并明确告诉用户这几个页面的状态丢了——静默丢数据是不可接受的。
   *
   * @returns {{ok:boolean, parked:number, dropped:number, droppedUrls:string[]}}
   */
  parkAll() {
    this.stopLifecycle();
    const dropped = [];
    const keep = Math.max(0, Number(this.maxParked) || 12);
    const all = this.tabs.slice();
    this.tabs = [];
    // 关键：不能覆盖已有的停靠标签。旧实现直接 this.parkedTabs = []，第二次停靠时
    // 上一次的标签引用就丢了——既不关也不恢复，WebContents 变孤儿（审计的 P1）。
    const parked = Array.isArray(this.parkedTabs) ? this.parkedTabs.slice() : [];
    // 记住停靠前用户正在看的那一个，回来时还给他，而不是永远跳回第一个
    if (!this.parkedActiveId) this.parkedActiveId = this.activeId;

    for (const tab of all) {
      if (!tab) continue;
      const url = String(tab.url || '');
      const isAppPage = Boolean(tab.appPage);
      if (parked.length >= keep && !isAppPage) {
        // 超出预算：只能记住地址，页面状态确实会丢（下面会把丢掉的列出来）
        dropped.push(url);
        try {
          if (tab.view) tab.view.webContents.close();
        } catch {
          /* 忽略：窗口可能已销毁 */
        }
        tab.view = null;
        continue;
      }
      if (tab.view) {
        try {
          this.mainWindow.contentView.removeChildView(tab.view);
        } catch {
          /* 忽略：窗口可能已销毁 */
        }
        try {
          // 冻结期间按用户口径：允许联网，但绝不能出声、也绝不走代理
          // （普通分区本来就不挂代理；这里只保证不静音用户正在听的页面之外的影响）。
          tab.view.webContents.setAudioMuted(true);
          tab.view.webContents.setBackgroundThrottling(true);
        } catch {
          /* 忽略 */
        }
        tab.view.setVisible(false);
        this.freezeTab(tab);
      }
      parked.push(tab);
    }

    this.parkedTabs = parked;
    this.activeId = null;
    this.parkedDropped = dropped.slice();
    this.emit();
    return { ok: true, parked: parked.length, dropped: dropped.length, droppedUrls: dropped };
  }

  /**
   * 停靠时尽力把页面真正冻结（CDP `Page.setWebLifecycleState`）。
   *
   * 为什么只加"摘视图 + 静音 + 降频"不够：那样页面还在正常跑 JS、定时器、动画，
   * 后台标签一多就是白白烧 CPU/电；用户要的是"挂起来"，不是"看不见但还在跑"。
   *
   * 为什么不让它失败影响停靠：冻结是 CDP 的额外能力，个别的 WebContents 可能
   * 因为调试通道已被占用（隐私标签挂着指纹面）或版本差异拒绝这条命令。这时
   * 退回"摘视图 + 静音 + 降频"三件事就好，绝不能因为冻结失败把标签留在窗口里。
   *
   * 用户口径：冻结期间允许联网，但不走代理——普通分区本来就不挂代理，所以这里
   * 只冻结页面生命周期，不碰网络。
   *
   * @param {object} tab 标签对象（必须有 view）
   * @returns {boolean} 是否真的把命令发下去了
   */
  freezeTab(tab) {
    const wc = tab && tab.view ? tab.view.webContents : null;
    if (!wc || wc.isDestroyed()) return false;
    let owned = false;
    try {
      owned = !wc.debugger.isAttached();
      if (owned) wc.debugger.attach('1.3');
    } catch (err) {
      // 挂不上调试通道：属于"冻结不了"，退回普通停靠，但要留痕
      this.reportFreezeFailure(tab, err);
      return false;
    }
    // 自己挂的调试器记得摘；原本就挂着的（比如隐私页）不要动别人的通道
    tab.freezeDebugger = owned;
    tab.frozen = false;
    try {
      wc.debugger
        .sendCommand('Page.setWebLifecycleState', { state: 'frozen' })
        .then(() => {
          tab.frozen = true;
        })
        .catch((err) => {
          tab.frozen = false;
          this.reportFreezeFailure(tab, err);
        });
    } catch (err) {
      this.reportFreezeFailure(tab, err);
      return false;
    }
    return true;
  }

  /**
   * 把冻结过的页面解冻；顺手摘掉自己挂的调试通道。
   * 不在这里抛错：恢复标签比"解冻干净"重要。
   */
  thawTab(tab) {
    const wc = tab && tab.view ? tab.view.webContents : null;
    if (!wc || wc.isDestroyed()) return false;
    const owned = Boolean(tab.freezeDebugger);
    try {
      if (wc.debugger.isAttached()) {
        wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' }).catch(() => {
          /* 解冻失败：页面仍可用，只是可能还在被冻着，等它自己恢复 */
        });
      }
    } catch {
      /* 忽略：通道可能已经断了 */
    }
    tab.frozen = false;
    tab.freezeDebugger = false;
    if (owned) {
      try {
        wc.debugger.detach();
      } catch {
        /* 忽略 */
      }
    }
    return true;
  }

  /** 冻结失败要留痕，但不必打扰用户——它只影响省电，不影响功能 */
  reportFreezeFailure(tab, err) {
    const message = (err && err.message) || String(err || '未知原因');
    console.warn(`[Nyx] 停靠标签没能真正冻结（${tab && tab.url ? tab.url : '未知地址'}）：${message}`);
    try {
      const d = require('./diagnostics');
      if (d && typeof d.warn === 'function') {
        d.warn('TAB_FREEZE_FAILED', '停靠标签没能真正冻结，已退回"摘视图 + 静音 + 降频"', {
          url: tab && tab.url ? String(tab.url).slice(0, 200) : '',
          error: message.slice(0, 200),
        });
      }
    } catch {
      /* 忽略：诊断模块不可用时只留 console */
    }
  }

  /**
   * 强制销毁当前全部标签（退出私密模式用；不保留、不自动补标签）。
   *
   * 为什么单独一个方法：私密标签在切回普通模式时必须**立即消失**。走 parkAll 会把它们
   * 停靠起来，第 4 步 restoreParked 又挂回普通标签栈——等于把私密页面搬进普通模式。
   *
   * 用 destroy() 而不是 close()：close() 会走 unload/beforeunload，页面可以拖着不销毁；
   * 私密页不能有这种"我说了算"的机会。
   *
   * 注意：不清 parkedTabs / parkedActiveId —— 那些是进入私密前停靠的**普通**标签，
   * 退出私密后还要靠它们恢复。
   *
   * @returns {{ok:boolean, destroyed:number}}
   */
  destroyAll() {
    this.stopLifecycle();
    let destroyed = 0;
    while (this.tabs.length > 0) {
      const tab = this.tabs.pop();
      if (!tab || !tab.view) continue;
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {
        /* 忽略：窗口可能已销毁 */
      }
      try {
        // 隐私标签身上挂着调试通道（指纹面用），带着它直接 destroy 会把主进程带崩
        // （实测：切回普通模式时整个应用退出）。先摘掉调试器再销毁。
        const wc = tab.view.webContents;
        if (wc.debugger && wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* 忽略：没有调试通道或已经断开 */
      }
      try {
        tab.view.webContents.destroy();
      } catch {
        /* 忽略：可能已经没了 */
      }
      tab.view = null;
      destroyed += 1;
    }
    this.activeId = null;
    this.emit();
    return { ok: true, destroyed };
  }

  /**
   * 把停靠的标签挂回窗口（顺序与停靠前一致），并恢复活动标签。
   *
   * @returns {{ok:boolean, restored:number, dropped:number, droppedUrls:string[]}}
   */
  restoreParked() {
    const parked = Array.isArray(this.parkedTabs) ? this.parkedTabs.slice() : [];
    const dropped = Array.isArray(this.parkedDropped) ? this.parkedDropped.slice() : [];
    const wantActive = this.parkedActiveId;
    this.parkedTabs = [];
    this.parkedDropped = [];
    this.parkedActiveId = null;

    for (const tab of parked) {
      if (!tab || !tab.view) continue;
      try {
        this.mainWindow.contentView.addChildView(tab.view);
      } catch {
        /* 忽略：窗口可能已销毁 */
      }
      try {
        tab.view.webContents.setAudioMuted(false);
        tab.view.webContents.setBackgroundThrottling(false);
      } catch {
        /* 忽略 */
      }
      this.thawTab(tab);
      this.tabs.push(tab);
    }

    // 恢复用户离开时正在看的那一个；它要是被 drop 掉了，就退回第一个，不抛错
    this.activeId = this.tabs.some((tab) => tab.id === wantActive)
      ? wantActive
      : (this.tabs.length > 0 ? this.tabs[0].id : null);

    // 超出预算的那几个：状态确实保不住了，但地址还留着，恢复时按原地址重新打开，
    // 至少不让用户回去自己再找一遍。
    for (const url of dropped) {
      if (!url) continue;
      try {
        this.create(url);
      } catch {
        /* 忽略：开不出来也不能中断恢复 */
      }
    }

    this.applyLifecycle();
    this.startLifecycle();
    this.layout();
    this.emit();
    return { ok: true, restored: this.tabs.length, dropped: dropped.length, droppedUrls: dropped };
  }


  /**
   * 记录一次加载失败并切到错误页。
   *
   * 为什么不在标签里加载一个本地错误页 HTML：视图的 preload 是创建时绑定的，
   * 换不了 preload 就等于错误页里的按钮没法调主进程；而外壳（index.html）本来就
   * 有全套 window.nyx。所以这里的做法是"隐藏坏视图 + 由外壳渲染错误页"。
   */
  presentLoadError(tab, info) {
    if (!tab || !this.tabs.includes(tab)) return;

    const kind = info.kind === 'http' ? 'http' : 'net';
    const status = Number(info.status) || 0;
    let code;
    let title;
    let reason;
    if (kind === 'http') {
      const described = describeHttpStatus(status, info.statusText);
      code = `HTTP ${status}`;
      title = described.title;
      reason = described.reason;
    } else {
      code = String(info.errorDescription || 'ERR_FAILED');
      title = '这一页没能打开';
      reason = describeLoadError(info.errorCode, info.errorDescription);
    }

    tab.loading = false;
    tab.loadError = {
      at: Date.now(),
      kind,
      code,
      title,
      reason,
      // 失败时把当前模式与链路一起记下来：用户报"打不开"时，只凭错误码分不清
      // 是站点坏了还是代理坏了，这两个字段是错误页与日志里最有用的上下文。
      mode: this.getMode(),
      url: info.url || tab.url,
      status,
      errorCode: Number(info.errorCode) || 0,
    };
    tab.title = `${title}（${code}）`;

    if (tab.id === this.activeId) this.layout();
    this.emit();
  }

  /** 清除失败状态并重新显示视图（重试 / 重新导航 / 刷新时调用） */
  clearLoadError(tab) {
    if (!tab || !tab.loadError) return;
    tab.loadError = null;
    if (tab.id === this.activeId) this.layout();
  }

  /**
   * 重试当前标签上一次失败的地址（错误页「重试」按钮）。
   * 用 requestedUrl 而不是 tab.url：失败后 tab.url 可能是被打断的中间地址。
   */
  retryLoadError(id) {
    const tab = id ? this.tabs.find((item) => item.id === id) : this.active;
    if (!tab) return { ok: false, error: '当前没有活动标签' };
    // 休眠标签先唤醒再重试；唤醒本身就会按原地址加载
    if (tab.asleep || !tab.view) {
      const woken = this.wakeTab(tab);
      if (!woken.ok) return woken;
      return { ok: true, url: tab.url };
    }
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: '标签已销毁' };

    const target = tab.requestedUrl || tab.url;
    tab.loadError = null;
    tab.loading = true;
    this.layout();
    wc.loadURL(target).catch((err) => {
      console.warn('[Nyx] 重试加载失败：', err.message);
    });
    this.emit();
    return { ok: true, url: target };
  }

  /** 激活标签 */
  activate(id) {
    const next = this.tabs.find((tab) => tab.id === id);
    if (!next) {
      return { ok: false, error: `标签不存在：${id}` };
    }
    // 切走的标签从现在开始计时闲置（休眠判定用）
    const previous = this.active;
    if (previous && previous.id !== id) previous.lastActiveAt = Date.now();
    // 点到一个已休眠的标签：先按原地址重建视图，否则界面上就是个空壳
    if (next.asleep) this.wakeTab(next);
    next.lastActiveAt = Date.now();
    this.activeId = id;
    this.layout();
    this.emit();
    return { ok: true };
  }

  /** 重排标签视图（窗口尺寸变化 / 激活切换时调用） */
  layout() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const [width, height] = this.mainWindow.getContentSize();

    for (const tab of this.tabs) {
      // 有 loadError 的标签不显示视图：它的内容区由外壳的错误页接管，
      // 不隐藏的话用户会看到一个白屏（Chromium 默认错误页被 Nyx 关掉了提示）。
      // 已休眠的标签没有视图（渲染进程已释放），跳过即可。
      const visible = tab.id === this.activeId && !tab.loadError && !tab.asleep && Boolean(tab.view);
      if (!tab.view) continue;
      try {
        tab.view.setVisible(visible);
      } catch {
        /* 忽略 */
      }
      if (visible) {
        tab.view.setBounds({
          x: 0,
          y: this.uiHeight + this.shellExtra,
          // 工具箱抽屉打开时同步让出右侧宽度，页面不会被面板遮挡
          width: Math.max(0, width - this.rightInset),
          height: Math.max(0, height - this.uiHeight - this.shellExtra),
        });
      }
    }
  }

  /**
   * 设置工具箱抽屉占宽并立即重排。
   * @param {number} px 0 表示工具箱关闭
   */
  setRightInset(px) {
    const next = Math.max(0, Math.min(Number(px) || 0, 1400));
    if (next === this.rightInset) return;
    this.rightInset = next;
    this.layout();
  }

  /**
   * 设置外壳底部临时让出的高度并立即重排（顶栏「更多」菜单展开时用）。
   *
   * 只影响标签视图的起点与高度，外壳自己的 CSS 变量由渲染层同步设置——
   * 主进程不猜界面用了多高，只认渲染层报上来的数字。
   * @param {number} px 0 表示恢复
   * @returns {number} 实际生效的额外高度
   */
  setShellExtra(px) {
    const next = Math.max(0, Math.min(Number(px) || 0, 600));
    if (next === this.shellExtra) return this.shellExtra;
    this.shellExtra = next;
    this.layout();
    return this.shellExtra;
  }

  /** 当前标签导航 */
  async navigate(input) {
    const tab = this.active;
    if (!tab) return { ok: false, error: '当前没有活动标签' };
    const target = normalizeInput(input);
    // 起始页/设置页是本地应用页，它们的 will-navigate 只放行 file://：
    // 在它们身上直接 loadURL 会被拦下，表现为"点了没反应"的静默失败。
    // 所以在应用页上开网址一律另开一个普通标签，应用页自己留着。
    if (tab.kind) {
      const opened = this.create(target);
      if (!opened || opened.ok === false) return opened || { ok: false, error: '新建标签失败' };
      return { ok: true, url: target, tabId: opened.id, fromAppPage: true };
    }
    // 换地址就当作重新来过：先清失败态，否则错误页会盖住新页面。
    tab.requestedUrl = target;
    this.clearLoadError(tab);
    if (tab.asleep || !tab.view) {
      // 休眠标签被要求导航：记下目标地址再唤醒，避免"先加载旧地址再跳"的两次请求
      tab.sleepUrl = target;
      const woken = this.wakeTab(tab);
      return woken.ok ? { ok: true, url: target } : { ok: false, error: woken.error, url: target };
    }
    try {
      await tab.view.webContents.loadURL(target);
      return { ok: true, url: target };
    } catch (err) {
      return { ok: false, error: err.message, url: target };
    }
  }

  /**
   * 等某个标签把当前这次加载跑完（应用页 navigate 新建标签后要用）。
   *
   * 应用页分支会先 create() 再立刻返回，因为不能把设置页自己导航走；但 agent 需要
   * 知道“新标签到底加载完没有”，否则导航预算在这条路径上等于没生效（实测 3 秒预算
   * 下 6 秒慢页仍返回 ok，下一动作被拖 6 秒）。这里只等待，不重新发起加载。
   *
   * @param {number} tabId
   * @param {number} timeoutMs 剩余预算；<=0 时只做一次状态快照
   * @returns {Promise<{ok:boolean,url?:string,code?:string,error?:string}>}
   */
  waitForTabLoad(tabId, timeoutMs) {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return Promise.resolve({ ok: false, code: 'TAB_NOT_FOUND', error: '标签不存在' });
    if (tab.loadError) {
      return Promise.resolve({
        ok: false,
        code: 'NAVIGATE_FAILED',
        error: tab.loadError.reason || tab.loadError.title || '页面加载失败',
        url: tab.loadError.url || tab.url,
      });
    }
    const wc = tab.view && tab.view.webContents;
    if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, code: 'TAB_CLOSED', error: '标签已关闭' });
    if (!wc.isLoading()) return Promise.resolve({ ok: true, url: wc.getURL() || tab.url });

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        wc.removeListener('did-finish-load', onFinish);
        wc.removeListener('did-fail-load', onFail);
        wc.removeListener('destroyed', onDestroyed);
        resolve(payload);
      };
      const onFinish = () => finish({ ok: true, url: wc.getURL() || tab.url });
      const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        // -3 = ERR_ABORTED：被下一次导航打断，不是故障，继续等新的一次。
        if (errorCode === -3) return;
        finish({
          ok: false,
          code: 'NAVIGATE_FAILED',
          error: errorDescription || '页面加载失败',
          url: validatedURL || tab.url,
        });
      };
      const onDestroyed = () => finish({ ok: false, code: 'TAB_CLOSED', error: '标签已关闭' });
      wc.on('did-finish-load', onFinish);
      // 用 on 而不是 once：子框架失败与 ERR_ABORTED 都会被忽略，若 once 会顺手
      // 把监听摘掉，之后真正的主框架失败就没人接了。
      wc.on('did-fail-load', onFail);
      wc.once('destroyed', onDestroyed);
      // 监听挂上后立刻再查一次：加载可能正好在 isDestroyed() 与 on() 之间完成，
      // 不补这一下会白等到超时，把成功误报成 NAVIGATE_TIMEOUT。
      if (!wc.isLoading()) {
        finish({ ok: true, url: wc.getURL() || tab.url });
        return;
      }
      const wait = Math.max(0, Number(timeoutMs) || 0);
      timer = setTimeout(() => finish({ ok: false, code: 'NAVIGATE_TIMEOUT', error: '等待页面加载超时', url: tab.url }), wait);
      if (timer.unref) timer.unref();
    });
  }

  goBack() {
    const wc = this.getActiveWebContents();
    if (!wc) return { ok: false, error: '当前没有活动标签' };
    if (!wc.navigationHistory.canGoBack()) return { ok: false, error: '无法后退' };
    wc.navigationHistory.goBack();
    return { ok: true };
  }

  goForward() {
    const wc = this.getActiveWebContents();
    if (!wc) return { ok: false, error: '当前没有活动标签' };
    if (!wc.navigationHistory.canGoForward()) return { ok: false, error: '无法前进' };
    wc.navigationHistory.goForward();
    return { ok: true };
  }

  /** 刷新标签：不传 id 时刷新当前激活标签 */
  reload(id) {
    const tab = id ? this.tabs.find((item) => item.id === id) : this.active;
    if (!tab) return { ok: false, error: '当前没有活动标签' };
    // 处在错误页时刷新 = 重试原地址（此时 webContents 里还是失败前的页面，reload 无意义）
    if (tab.loadError) return this.retryLoadError(tab.id);
    if (tab.asleep || !tab.view) {
      const woken = this.wakeTab(tab);
      return woken.ok ? { ok: true, url: tab.url } : woken;
    }
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: '标签已销毁' };
    wc.reload();
    return { ok: true };
  }

  /** 给渲染层的状态快照 */
  snapshot() {
    const decisions = this.tabs.map((tab) => ({
      state: tab.asleep ? 'asleep' : tab.id === this.activeId ? 'active' : 'background',
      keepAwake: Boolean(tab.agentDrivenUntil && tab.agentDrivenUntil > Date.now()) || this.agentSessionActive,
    }));
    return {
      mode: this.getMode(),
      activeId: this.activeId,
      maxTabs: this.maxTabs,
      // 出站链路（proxy / direct）随快照一起下发：界面与本地接口共用同一口径，
      // 避免"界面看着走代理、实际在直连"这类只能靠日志发现的漂移。
      network: this.getNetwork() || null,
      // 生命周期（清单 G）：界面据此显示"已休眠"，设置页据此解释为什么标签不睡
      lifecycle: {
        sleepAfterMs: this.sleepAfterMs,
        agentSessionActive: this.agentSessionActive,
        ...summarizeLifecycle(decisions),
      },
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title || '新标签页',
        url: tab.url,
        loading: tab.loading,
        active: tab.id === this.activeId,
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
        // 失败信息随快照下发：外壳据此渲染错误页（视图已被隐藏）
        loadError: tab.loadError || null,
        // 休眠标记：界面用淡显 + 「已休眠」提示，点一下会按原地址重新加载
        asleep: Boolean(tab.asleep),
        lifecycle: describeLifecycle(tab.asleep ? 'asleep' : tab.id === this.activeId ? 'active' : 'background'),
      })),
    };
  }

  emit() {
    try {
      this.onChange(this.snapshot());
    } catch (err) {
      console.error('[Nyx] 状态推送失败：', err.message);
    }
  }
}

module.exports = { TabManager, normalizeInput, WEBRTC_POLICY };
