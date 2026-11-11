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

class TabManager {
  /**
   * @param {object} options
   * @param {Electron.BrowserWindow} options.mainWindow 承载 UI 外壳的主窗口
   * @param {number} options.uiHeight UI 外壳高度（px），标签视图从其下方开始
   * @param {number} options.maxTabs 标签数上限
   * @param {string} options.defaultUrl 新标签默认地址
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
    const mode = this.getMode();

    const view = new WebContentsView({
      webPreferences: {
        session: this.resolveSession(),
        preload: TAB_PRELOAD,
        // 模式参数随视图创建注入：preload 必须"在页面脚本之前"就知道自己是
        // 哪种模式，否则加固只能事后补救（补不了已发生的泄漏）。
        additionalArguments: this.getPreloadArgs(mode),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    const tab = {
      id: this.seq++,
      view,
      url: target,
      title: '新标签页',
      loading: false,
      canGoBack: false,
      canGoForward: false,
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

    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      this.syncNavState(tab);
      this.emit();
    });

    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url;
      this.syncNavState(tab);
      this.emit();
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      tab.title = `加载失败（${errorDescription}）`;
      tab.loading = false;
      this.emit();
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
      const visible = tab.id === this.activeId;
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
