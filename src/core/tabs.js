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

    /** @type {Array<{id:number, view:Electron.WebContentsView, url:string, title:string, loading:boolean, canGoBack:boolean, canGoForward:boolean}>} */
    this.tabs = [];
    this.activeId = null;
    this.seq = 1;
  }

  /** 当前激活标签 */
  get active() {
    return this.tabs.find((tab) => tab.id === this.activeId) || null;
  }

  /** 当前激活标签的 webContents（AI 接口的操作目标） */
  getActiveWebContents() {
    const tab = this.active;
    if (!tab) return null;
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
      additionalArguments: this.getPreloadArgs(mode),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
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
    };

    this.tabs.push(tab);
    this.mainWindow.contentView.addChildView(view);
    this.bindEvents(tab);

    // 新标签也要继承工具箱的粘性设置（UA / 视口 / 限速），否则每开一个标签都要重设
    try {
      this.onTabCreated(tab);
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

    wc.loadURL(target).catch((err) => {
      // 加载失败不抛出，交由 did-fail-load 呈现
      console.warn('[Nyx] 页面加载失败：', err.message);
    });

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
    if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return null;
    return tab.view.webContents;
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
    while (this.tabs.length > 0) {
      const tab = this.tabs.pop();
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
    }
    this.activeId = null;
    this.emit();
    return { ok: true };
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
    if (!this.tabs.some((tab) => tab.id === id)) {
      return { ok: false, error: `标签不存在：${id}` };
    }
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
      const visible = tab.id === this.activeId && !tab.loadError;
      try {
        tab.view.setVisible(visible);
      } catch {
        /* 忽略 */
      }
      if (visible) {
        tab.view.setBounds({
          x: 0,
          y: this.uiHeight,
          // 工具箱抽屉打开时同步让出右侧宽度，页面不会被面板遮挡
          width: Math.max(0, width - this.rightInset),
          height: Math.max(0, height - this.uiHeight),
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
    try {
      await tab.view.webContents.loadURL(target);
      return { ok: true, url: target };
    } catch (err) {
      return { ok: false, error: err.message, url: target };
    }
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
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: '标签已销毁' };
    wc.reload();
    return { ok: true };
  }

  /** 给渲染层的状态快照 */
  snapshot() {
    return {
      mode: this.getMode(),
      activeId: this.activeId,
      maxTabs: this.maxTabs,
      // 出站链路（proxy / direct）随快照一起下发：界面与本地接口共用同一口径，
      // 避免"界面看着走代理、实际在直连"这类只能靠日志发现的漂移。
      network: this.getNetwork() || null,
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
