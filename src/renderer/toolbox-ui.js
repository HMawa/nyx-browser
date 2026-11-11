'use strict';

/**
 * 工具箱面板：资源嗅探 / 网络抓包 / 页面环境。
 *
 * 设计边界：
 * - 面板只做展示与参数收集，所有判定（种类、可下载性、是否让位给开发者工具）都在主进程内核里；
 * - 面板宽度是"界面说了算"：这里改 --tb-width，同时把同一数值交给主进程去收窄标签视图，
 *   两处必须同源，否则面板会盖住页面或留出空白；
 * - 嗅探与抓包共用一个数据源（同一条请求记录），因此两个页签天然一致，不会出现
 *   "嗅探列了但抓包没有"的错位。
 */
(function () {
  const nyx = window.nyx;
  if (!nyx || typeof nyx.getToolboxState !== 'function') return;

  /** 面板宽度档位（px），与主进程 clamp 范围一致 */
  const WIDTHS = [380, 460, 620];
  /** 单个页签最多保留的 DOM 行数，超出的从最旧开始丢（记录本身还在主进程里） */
  const MAX_NODES = 1200;

  const els = {
    root: document.getElementById('toolbox'),
    entry: document.getElementById('btn-toolbox'),
    width: document.getElementById('tb-width'),
    close: document.getElementById('tb-close'),
    nav: document.getElementById('tb-nav'),
    toast: document.getElementById('tb-toast'),

    paneSniff: document.getElementById('pane-sniff'),
    sniffKinds: document.getElementById('sniff-kinds'),
    sniffSearch: document.getElementById('sniff-search'),
    sniffMeta: document.getElementById('sniff-meta'),
    sniffList: document.getElementById('sniff-list'),

    paneNet: document.getElementById('pane-net'),
    netPause: document.getElementById('net-pause'),
    netClear: document.getElementById('net-clear'),
    netFollow: document.getElementById('net-follow'),
    netTypes: document.getElementById('net-types'),
    netSearch: document.getElementById('net-search'),
    netMeta: document.getElementById('net-meta'),
    netList: document.getElementById('net-list'),

    panePage: document.getElementById('pane-page'),
    dtMode: document.getElementById('dt-mode'),
    dtOpen: document.getElementById('dt-open'),
    dtClose: document.getElementById('dt-close'),
    dtNote: document.getElementById('dt-note'),
    pickStart: document.getElementById('pick-start'),
    pickCancel: document.getElementById('pick-cancel'),
    pickNote: document.getElementById('pick-note'),
    pickResult: document.getElementById('pick-result'),
    uaSelect: document.getElementById('ua-select'),
    uaCustomRow: document.getElementById('ua-custom-row'),
    uaCustom: document.getElementById('ua-custom'),
    deviceSelect: document.getElementById('device-select'),
    throttleSelect: document.getElementById('throttle-select'),
    envKeep: document.getElementById('env-keep'),
    envApply: document.getElementById('env-apply'),
    envReset: document.getElementById('env-reset'),
    envNote: document.getElementById('env-note'),
    pageInfo: document.getElementById('page-info'),
    jsToggle: document.getElementById('js-toggle'),
    infoRefresh: document.getElementById('info-refresh'),
    siteClear: document.getElementById('site-clear'),
    shotView: document.getElementById('shot-view'),
    shotFull: document.getElementById('shot-full'),

    paneVideo: document.getElementById('pane-video'),
    videoScan: document.getElementById('video-scan'),
    videoWatch: document.getElementById('video-watch'),
    videoInfo: document.getElementById('video-info'),
    videoNote: document.getElementById('video-note'),
    videoRates: document.getElementById('video-rates'),
    videoRateCustom: document.getElementById('video-rate-custom'),
    videoRateApply: document.getElementById('video-rate-apply'),
    videoRateReset: document.getElementById('video-rate-reset'),
    videoRateLock: document.getElementById('video-rate-lock'),
    videoSeeks: document.getElementById('video-seeks'),
    videoSeekCustom: document.getElementById('video-seek-custom'),
    videoSeekGo: document.getElementById('video-seek-go'),
    videoSeekUnlock: document.getElementById('video-seek-unlock'),
    videoSeekLock: document.getElementById('video-seek-lock'),
    mouseMode: document.getElementById('mouse-mode'),
    mouseGap: document.getElementById('mouse-gap'),
    mouseStart: document.getElementById('mouse-start'),
    mouseStop: document.getElementById('mouse-stop'),
    mouseInfo: document.getElementById('mouse-info'),

    detail: document.getElementById('net-detail'),
    detailTitle: document.getElementById('detail-title'),
    detailNav: document.getElementById('detail-nav'),
    detailBody: document.getElementById('detail-body'),
    detailClose: document.getElementById('detail-close'),

    /** 书签 / 历史面板 */
    paneBookmarks: document.getElementById('pane-bookmarks'),
    paneHistory: document.getElementById('pane-history'),
    bmMeta: document.getElementById('bm-meta'),
    bmList: document.getElementById('bm-list'),
    bmSearch: document.getElementById('bm-search'),
    bmAdd: document.getElementById('bm-add'),
    bmImportEdge: document.getElementById('bm-import-edge'),
    bmImportChrome: document.getElementById('bm-import-chrome'),
    bmNewFolder: document.getElementById('bm-new-folder'),
    bmDelete: document.getElementById('bm-delete'),
    historyMeta: document.getElementById('history-meta'),
    historyList: document.getElementById('history-list'),
    historySearch: document.getElementById('history-search'),
    historyClear: document.getElementById('history-clear'),

    /** 调试页签 */
    paneDebug: document.getElementById('pane-debug'),
    dbgHtml: document.getElementById('dbg-html'),
    dbgHtmlRead: document.getElementById('dbg-html-read'),
    dbgHtmlApply: document.getElementById('dbg-html-apply'),
    dbgHtmlRevert: document.getElementById('dbg-html-revert'),
    dbgHtmlNote: document.getElementById('dbg-html-note'),
    dbgJs: document.getElementById('dbg-js'),
    dbgJsRun: document.getElementById('dbg-js-run'),
    dbgJsClear: document.getElementById('dbg-js-clear'),
    dbgJsMeta: document.getElementById('dbg-js-meta'),
    dbgJsOut: document.getElementById('dbg-js-out'),

    /** Cookie 页签 */
    paneCookie: document.getElementById('pane-cookie'),
    ckRefresh: document.getElementById('ck-refresh'),
    ckAdd: document.getElementById('ck-add'),
    ckClear: document.getElementById('ck-clear'),
    ckEdgeSite: document.getElementById('ck-edge-site'),
    ckEdgeAll: document.getElementById('ck-edge-all'),
    ckMeta: document.getElementById('ck-meta'),
    ckList: document.getElementById('ck-list'),
  };

  if (!els.root || !els.entry) return;

  /** 用户是否手动动过倍速锁定开关；未动过时点倍速自动勾选锁定，避免被站点写回 */
  let videoLockTouched = false;

  /** 面板状态 */
  const tb = {
    open: false,
    width: WIDTHS[1],
    wcId: null,
    records: [],
    byId: new Map(),
    sniffNodes: new Map(),
    netNodes: new Map(),
    sniffKind: 'media',
    sniffQuery: '',
    netType: 'all',
    netQuery: '',
    /** 只看失败请求（与类型、搜索是「与」关系，v1.8.0） */
    netOnlyFailed: false,
    /** 列表排序：'time' 按到达顺序 / 'duration' 按耗时降序（v1.11.0） */
    netSort: 'time',
    /** 慢请求开关与阈值（毫秒）：开关只影响筛选，行上的「慢」标记始终按阈值显示 */
    netSlowOnly: false,
    netSlowMs: 1000,
    paused: false,
    picking: false,
    detailId: null,
    detailSection: 'headers',
    /** 瀑布区的类型筛选（多选）：空集合 = 全部；不持久化，每次打开详情重置（v1.13.0） */
    waterfallTypes: new Set(),
    /** 瀑布区「只看慢请求」开关：阈值每次渲染时重读 nyx:tb:slow-ms；不持久化（v1.15.0） */
    waterfallSlowOnly: false,
    presets: { ua: [], device: [], throttle: [] },
    sticky: null,
    /** 主进程侧的累计条数与滚动丢弃数（本地表会被截断，计数以主进程为准） */
    total: 0,
    dropped: 0,
    /** 胶囊计数刷新节流句柄 */
    chipTimer: null,
    /** 抓包列表图标补全的 rAF 句柄（同帧多次追加只扫一次） */
    netIconPump: 0,

    /** 视频页签：上次扫描结果、接管状态、自动刷新句柄 */
    video: null,
    videoPicked: null,
    videoWatchTimer: null,
    mousePollTimer: null,
    mouse: { running: false, moves: 0, lastAt: 0, fallback: false, mode: 'video', gap: 'normal' },

    /** 历史记录页签 */
    historyItems: [],
    historyQuery: '',
    /** 历史视图：'time' 按时间平铺 / 'site' 按站点聚合（v1.6.0） */
    historyView: 'time',
    /** 历史时间段：'all' 全部 / 'today' 今天 / 'week' 近 7 天 / 'older' 更早（v1.7.0） */
    historyRange: 'all',
    /** 当前「按站点」视图的聚合结果与展开集合（host 集合） */
    historyGroups: [],
    historyOpen: new Set(),
    /** 自定义时间区间（v1.8.0）：from / to 均为 'YYYY-MM-DD' 或空串（空＝该端不限） */
    historyCustom: { from: '', to: '' },
    /** host → 站点图标 data URL：历史聚合行与抓包行共用同一份（v1.7.0） */
    siteIcons: Object.create(null),
    /** 防止同一站点反复问主进程 */
    siteIconAsked: new Set(),
    /** 书签页签 */
    bookmarkItems: [],
    bookmarkQuery: '',
  };

  /** 书签树管理状态：折叠集合在每次重渲染间保留，树与总数随 load 更新 */
  const bmState = { root: null, collapsed: new Set(), total: 0 };

  /* ---------------- 历史视图 / 时间段（按时间 · 按站点 · 全部/今天/近7天/近30天/更早/自定义） ---------------- */

  /** 历史视图持久化键：窗口重开仍记住上次选择 */
  const HISTORY_VIEW_KEY = 'nyx:tb:history-view';
  /** 历史时间段持久化键（v1.7.0） */
  const HISTORY_RANGE_KEY = 'nyx:tb:history-range';
  /** 自定义时间区间持久化键（v1.8.0）：{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } */
  const HISTORY_CUSTOM_KEY = 'nyx:tb:history-custom';
  /** 时间段取值与中文标签：非法值一律退回 all */
  const HISTORY_RANGE_KEYS = ['all', 'today', 'week', 'month', 'older', 'custom'];
  const HISTORY_RANGE_LABEL = { all: '全部', today: '今天', week: '近 7 天', month: '近 30 天', older: '更早', custom: '自定义' };
  /** 「近 7 天」的窗口长度：7×24 小时 */
  const HISTORY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  /** 「近 30 天」与「更早」的分界：30×24 小时（v1.9.0 起「更早」= 早于 30 天） */
  const HISTORY_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  /** 读取上次的视图选择；localStorage 被禁用 / 值非法时退回「按时间」 */
  function readHistoryView() {
    try {
      return window.localStorage.getItem(HISTORY_VIEW_KEY) === 'site' ? 'site' : 'time';
    } catch (e) {
      return 'time';
    }
  }

  /** 记住视图选择；写失败只在本次会话内生效，不影响功能 */
  function writeHistoryView(view) {
    try {
      window.localStorage.setItem(HISTORY_VIEW_KEY, view === 'site' ? 'site' : 'time');
    } catch (e) {
      /* 静默降级 */
    }
  }

  /** 读取上次的时间段；非法值退回 all */
  function readHistoryRange() {
    try {
      const value = window.localStorage.getItem(HISTORY_RANGE_KEY);
      return HISTORY_RANGE_KEYS.includes(value) ? value : 'all';
    } catch (e) {
      return 'all';
    }
  }

  /** 记住时间段选择；写失败同样静默降级 */
  function writeHistoryRange(range) {
    try {
      window.localStorage.setItem(HISTORY_RANGE_KEY, HISTORY_RANGE_KEYS.includes(range) ? range : 'all');
    } catch (e) {
      /* 静默降级 */
    }
  }

  /* ---- 自定义时间区间（v1.8.0） ---- */

  /** 校验 'YYYY-MM-DD' 是不是真实存在的日历日（挡掉 2 月 30 日这种"能解析但不存在"的日期） */
  function isDateInputValue(value) {
    const text = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    const parts = text.split('-').map(Number);
    const probe = new Date(parts[0], parts[1] - 1, parts[2]);
    return probe.getFullYear() === parts[0] && probe.getMonth() === parts[1] - 1 && probe.getDate() === parts[2];
  }

  /** 规整区间：非法/空串归空，两端颠倒时交换（'YYYY-MM-DD' 可直接按字符串比较） */
  function normalizeCustomRange(raw) {
    let from = isDateInputValue(raw && raw.from) ? String(raw.from) : '';
    let to = isDateInputValue(raw && raw.to) ? String(raw.to) : '';
    if (from && to && from > to) {
      const swap = from;
      from = to;
      to = swap;
    }
    return { from, to };
  }

  /** 读取自定义区间；损坏 / 脏数据直接丢弃（两端都无效即视为未设置） */
  function readHistoryCustom() {
    try {
      const raw = window.localStorage.getItem(HISTORY_CUSTOM_KEY);
      if (!raw) return { from: '', to: '' };
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { from: '', to: '' };
      return normalizeCustomRange(data);
    } catch (e) {
      return { from: '', to: '' };
    }
  }

  /** 记住自定义区间；两端都空就不占用存储 */
  function writeHistoryCustom(range) {
    try {
      if (!range || (!range.from && !range.to)) {
        window.localStorage.removeItem(HISTORY_CUSTOM_KEY);
        return;
      }
      window.localStorage.setItem(HISTORY_CUSTOM_KEY, JSON.stringify({ from: range.from || '', to: range.to || '' }));
    } catch (e) {
      /* 静默降级 */
    }
  }

  /* ---- 抓包「只看失败」开关（v1.8.0） ---- */

  /** 只看失败持久化键：'1' 开 / '0' 关，默认关 */
  const NET_FAILED_KEY = 'nyx:tb:net-failed';

  function readNetOnlyFailed() {
    try {
      return window.localStorage.getItem(NET_FAILED_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function writeNetOnlyFailed(value) {
    try {
      window.localStorage.setItem(NET_FAILED_KEY, value ? '1' : '0');
    } catch (e) {
      /* 静默降级 */
    }
  }

  /* ---- 抓包排序 / 慢请求阈值（v1.11.0） ---- */

  /** 排序记忆：'time' / 'duration'，非法值退回 time */
  const NET_SORT_KEY = 'nyx:tb:net-sort';
  /** 慢请求阈值记忆：毫秒字符串；非法 / 非正数退回默认 1000 */
  const NET_SLOW_MS_KEY = 'nyx:tb:slow-ms';
  const NET_SLOW_DEFAULT_MS = 1000;
  /** 阈值上限 10 分钟：挡住手滑输入的天文数字，避免整张表都被判「慢」 */
  const NET_SLOW_MAX_MS = 10 * 60 * 1000;

  function readNetSort() {
    try {
      return window.localStorage.getItem(NET_SORT_KEY) === 'duration' ? 'duration' : 'time';
    } catch (e) {
      return 'time';
    }
  }

  function writeNetSort(sort) {
    try {
      window.localStorage.setItem(NET_SORT_KEY, sort === 'duration' ? 'duration' : 'time');
    } catch (e) {
      /* 静默降级 */
    }
  }

  /** 阈值规整：非数字 / 非正数 → 默认 1000；小数取整；上限 10 分钟 */
  function normalizeSlowMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return NET_SLOW_DEFAULT_MS;
    return Math.min(NET_SLOW_MAX_MS, Math.max(1, Math.round(n)));
  }

  function readNetSlowMs() {
    try {
      return normalizeSlowMs(window.localStorage.getItem(NET_SLOW_MS_KEY));
    } catch (e) {
      return NET_SLOW_DEFAULT_MS;
    }
  }

  function writeNetSlowMs(value) {
    try {
      window.localStorage.setItem(NET_SLOW_MS_KEY, String(normalizeSlowMs(value)));
    } catch (e) {
      /* 静默降级 */
    }
  }

  /**
   * v1.16.0：慢请求阈值改成「主进程单源」。
   *
   * 背景：v1.11.0 起阈值只存在本窗口的 localStorage 里，v1.16.0 又把它搬进了设置页
   * （主进程 toolbox-prefs.json + nyx:tb:slow-ms-set）。两处各存一份必然对不上：
   * 在设置里改成 1500，抓包面板还是 1000。所以现在以主进程为准——localStorage 只当
   * 首屏拿不到 IPC 时的兜底缓存，主进程一变就由 applySlowMsFromMain 覆盖回来。
   */
  function applySlowMsFromMain(value) {
    const next = normalizeSlowMs(value);
    const changed = next !== tb.netSlowMs;
    tb.netSlowMs = next;
    // 顺手把兜底缓存对齐，避免下次首屏闪一下旧值
    writeNetSlowMs(next);
    if (netSlowInput && document.activeElement !== netSlowInput) {
      netSlowInput.value = String(next);
    }
    if (!changed) return;
    // 阈值变了：「慢」标与筛选结果都要重算；瀑布区正在看也要重绘
    if (els.netTypes && els.netTypes.parentNode) renderNetChips();
    if (tb.open && els.root && !els.root.hidden) rebuildNet();
    if (tb.detailSection === 'waterfall' && els.detail && !els.detail.hidden) renderDetailSection();
  }

  /** 订阅主进程的阈值广播，并在启动时先拉一次当前值（设置页改完立即生效） */
  function bindSlowMsPush() {
    if (typeof nyx.onTbSlowMs === 'function') {
      nyx.onTbSlowMs((payload) => applySlowMsFromMain(payload && payload.slowMs));
    }
    if (typeof nyx.tbSlowMs === 'function') {
      nyx
        .tbSlowMs()
        .then((res) => {
          if (res && res.ok) applySlowMsFromMain(res.slowMs);
        })
        .catch(() => {
          /* 拿不到就继续用 localStorage 兜底 */
        });
    }
  }

  tb.historyView = readHistoryView();
  tb.historyRange = readHistoryRange();
  tb.historyCustom = readHistoryCustom();
  // 存的是自定义但区间是脏数据 → 退回「全部」（只在内存里回退，不额外写盘）
  if (tb.historyRange === 'custom' && !tb.historyCustom.from && !tb.historyCustom.to) tb.historyRange = 'all';
  tb.netOnlyFailed = readNetOnlyFailed();
  tb.netSort = readNetSort();
  tb.netSlowMs = readNetSlowMs();

  /* ============================ 通用小工具 ============================ */

  function fmtSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  }

  function fmtMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`;
  }

  function shortTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (v) => String(v).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** URL → 展示用文件名（取最后一段路径，解码，去超长） */
  function fileNameOf(url) {
    const raw = String(url == null ? '' : url);
    // 内联与内存资源没有路径可截，给个人能读的名字，别把整段 base64 糊在列表上
    if (raw.startsWith('data:')) {
      const comma = raw.indexOf(',');
      const semi = raw.indexOf(';');
      const mime = raw.slice(5, semi > 0 ? semi : comma > 0 ? comma : 32);
      return `内联数据（${mime || '未知类型'}）`;
    }
    if (raw.startsWith('blob:')) return 'Blob 内存资源';
    try {
      const u = new URL(raw);
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      const name = seg ? decodeURIComponent(seg) : u.hostname;
      return name.length > 96 ? `${name.slice(0, 96)}…` : name;
    } catch {
      return raw.slice(0, 96);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function miniBtn(label, title, onClick) {
    const btn = el('button', 'tb-mini', label);
    btn.type = 'button';
    if (title) btn.title = title;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  let toastTimer = null;
  function toast(message, level) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = `tb-toast${level ? ` is-${level}` : ''}`;
    els.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, level === 'err' ? 6000 : 3200);
  }

  /** 统一处理主进程返回：失败就弹提示，返回是否成功 */
  function check(result, okMessage) {
    if (!result) {
      toast('主进程没有响应', 'err');
      return false;
    }
    if (result.ok === false) {
      if (result.canceled) return false;
      toast(result.error || '操作失败', 'err');
      return false;
    }
    if (okMessage) toast(okMessage);
    return true;
  }

  function copy(text, label) {
    if (!text) return toast('没有可复制的内容', 'warn');
    nyx.copyToolboxText({ text: String(text) }).then((res) => {
      if (res && res.ok) toast(`${label || '内容'}已复制到剪贴板`);
      else toast((res && res.error) || '复制失败', 'err');
    });
  }

  /* ============================ 开合与宽度 ============================ */

  function applyWidth(px) {
    tb.width = px;
    document.documentElement.style.setProperty('--tb-width', `${px}px`);
    // 面板变宽变窄都会改变页签栏可滚动量：下一帧重算渐隐并保持高亮页签可见
    window.requestAnimationFrame(() => {
      revealActiveNavTab();
    });
  }

  async function openToolbox() {
    tb.open = true;
    els.root.hidden = false;
    els.detail.hidden = true;
    els.entry.classList.add('is-on');
    applyWidth(tb.width);

    await nyx.setToolboxOpen({ open: true, width: tb.width });
    await nyx.syncToolbox();
    // 每次打开都对齐当前激活标签：否则 wcId 停留在初始标签，视频/抓包作用错对象
    tb.wcId = null;
    await loadRecords();
    await refreshStatus();
    await refreshPageInfo();
  }

  async function closeToolbox() {
    tb.open = false;
    els.root.hidden = true;
    els.detail.hidden = true;
    els.entry.classList.remove('is-on');
    tb.detailId = null;
    stopVideoWatch();
    stopMousePoll();
    tb.mouse = Object.assign({}, tb.mouse, { running: false });
    renderMouseInfo();
    await nyx.setToolboxOpen({ open: false });
    toast('工具箱已收起，采集与视频接管已中止');
  }

  function cycleWidth() {
    const idx = WIDTHS.indexOf(tb.width);
    const next = WIDTHS[(idx + 1) % WIDTHS.length];
    applyWidth(next);
    if (tb.open) nyx.setToolboxOpen({ open: true, width: next });
    toast(`面板宽度 ${next}px`);
  }

  /* ============================ 页签切换 ============================ */

  function switchPane(name) {
    const map = { sniff: els.paneSniff, net: els.paneNet, page: els.panePage, video: els.paneVideo, ai: els.paneAi, bookmarks: els.paneBookmarks, history: els.paneHistory, debug: els.paneDebug, cookie: els.paneCookie };
    for (const key of Object.keys(map)) {
      if (map[key]) map[key].hidden = key !== name;
    }
    els.nav.querySelectorAll('.tb-nav-btn').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.pane === name);
    });
    // 页签栏可横向滚动：切页后把当前页签滚回视野（否则切到靠右的页签会看不见高亮）
    revealActiveNavTab();
    if (name === 'page') refreshPageInfo();
    if (name === 'video') scanVideo(true);
    if (name === 'bookmarks') loadBookmarks();
    if (name === 'history') loadHistory();
    if (name === 'cookie') loadCookies();
    // 切到抓包时补一次可见行图标（面板刚可见，rAF 里再量尺寸）
    if (name === 'net') queueVisibleNetIcons();
  }

  /* ============================ 页签栏横滑 ============================ */
  /* 8 个页签在窄面板里排不下，容器改为横向滚动；本段只做交互补偿：
     滚轮转横向、切页/聚焦后滚入视野、两端渐隐提示。 */

  /** 按当前 scrollLeft 更新两端渐隐方向；没有溢出就整体去掉渐隐 */
  function updateNavFade() {
    const box = els.nav;
    if (!box) return;
    const max = box.scrollWidth - box.clientWidth;
    if (max <= 1) {
      // 与下面写入保持同一路径（dataset.fade 即 data-fade 属性）
      delete box.dataset.fade;
      return;
    }
    const atStart = box.scrollLeft <= 1;
    const atEnd = box.scrollLeft >= max - 1;
    if (atStart && atEnd) delete box.dataset.fade;
    else if (atStart) box.dataset.fade = 'end';
    else if (atEnd) box.dataset.fade = 'start';
    else box.dataset.fade = 'both';
  }

  /** 让单个页签完整进入视野：贴边时会被渐隐区削掉一圈，故留 8px 余量 */
  function revealNavTab(btn) {
    const box = els.nav;
    if (!box || !btn) return;
    btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const boxRect = box.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const margin = 8;
    if (btnRect.left < boxRect.left + margin) {
      box.scrollLeft -= boxRect.left + margin - btnRect.left;
    } else if (btnRect.right > boxRect.right - margin) {
      box.scrollLeft += btnRect.right - boxRect.right + margin;
    }
    updateNavFade();
  }

  /** 当前高亮页签滚入视野（切页、程序化 switchPane、面板变宽后都走这里） */
  function revealActiveNavTab() {
    if (!els.nav) return;
    revealNavTab(els.nav.querySelector('.tb-nav-btn.is-on'));
  }

  /**
   * 纵向滚轮 → 横向滚动。
   * 只有容器确实溢出时才拦截，避免吞掉本应冒泡给祖先的滚轮；
   * 带 Ctrl 的滚轮是缩放手势，原样放行。
   */
  function onNavWheel(event) {
    const box = els.nav;
    if (!box || event.ctrlKey) return;
    if (box.scrollWidth - box.clientWidth <= 1) return;
    let delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    if (event.deltaMode === 1) delta *= 16; // 按行滚动
    else if (event.deltaMode === 2) delta *= box.clientWidth; // 按页滚动
    event.preventDefault();
    box.scrollLeft += delta;
  }

  /* ============================ 记录装载 ============================ */

  async function loadRecords() {
    const res = await nyx.listToolboxRecords({ wcId: tb.wcId == null ? undefined : tb.wcId });
    if (!res || res.ok === false) {
      tb.records = [];
      tb.byId.clear();
      tb.total = 0;
      tb.dropped = 0;
      if (res && res.wcId == null) {
        tb.wcId = null;
        renderAll();
        return;
      }
      toast((res && res.error) || '读取抓包记录失败', 'warn');
      renderAll();
      return;
    }

    tb.wcId = res.wcId == null ? null : res.wcId;
    tb.records = Array.isArray(res.records) ? res.records.slice() : [];
    tb.total = Number(res.total) || tb.records.length;
    tb.dropped = Number(res.dropped) || 0;
    tb.byId.clear();
    for (const rec of tb.records) tb.byId.set(rec.id, rec);
    renderAll();
  }

  /** 主进程增量推送：合并进本地表并就地更新节点 */
  function onFeed(payload) {
    if (!payload || !Array.isArray(payload.records)) return;
    if (tb.wcId != null && payload.tabId != null && payload.tabId !== tb.wcId) return;

    const batch = [];
    for (const rec of payload.records) {
      const exist = tb.byId.get(rec.id);
      if (exist) Object.assign(exist, rec);
      else {
        // 记录按 seq 升序到达，直接压尾部即可保持顺序
        tb.byId.set(rec.id, rec);
        tb.records.push(rec);
      }
      batch.push(rec);
    }
    if (Number.isFinite(payload.total)) tb.total = payload.total;
    if (Number.isFinite(payload.dropped)) tb.dropped = payload.dropped;
    if (tb.records.length > 4000) {
      tb.records.splice(0, tb.records.length - 4000);
    }

    for (const rec of batch) {
      updateSniffNode(rec);
      updateNetNode(rec);
    }
    renderSniffMeta();
    renderNetMeta();
    scheduleChipRefresh();
    autoScroll(els.sniffList);
    autoScroll(els.netList);
  }

  /** 胶囊计数节流刷新：抓包高峰每秒上百条，逐个重绘会把面板拖卡 */
  function scheduleChipRefresh() {
    if (tb.chipTimer) return;
    tb.chipTimer = window.setTimeout(() => {
      tb.chipTimer = null;
      renderSniffChips();
      renderNetChips();
    }, 700);
  }

  function autoScroll(container) {
    if (!container) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }

  /* ============================ 筛选规则 ============================ */

  const SNIFF_KINDS = [
    { key: 'media', label: '媒体', test: (r) => !!r.kind },
    { key: 'video', label: '视频', test: (r) => r.kind === 'video' },
    { key: 'audio', label: '音频', test: (r) => r.kind === 'audio' },
    { key: 'stream', label: '流媒体', test: (r) => r.kind === 'hls' || r.kind === 'dash' },
    { key: 'image', label: '图片', test: (r) => r.kind === 'image' },
    { key: 'subtitle', label: '字幕', test: (r) => r.kind === 'subtitle' },
    { key: 'all', label: '全部', test: () => true },
  ];

  const NET_TYPES = [
    { key: 'all', label: '全部', test: () => true },
    { key: 'doc', label: '文档', test: (r) => r.type === 'Document' },
    { key: 'xhr', label: 'XHR', test: (r) => r.type === 'XHR' || r.type === 'Fetch' },
    { key: 'script', label: 'JS', test: (r) => r.type === 'Script' },
    { key: 'style', label: 'CSS', test: (r) => r.type === 'Stylesheet' },
    { key: 'image', label: '图片', test: (r) => r.type === 'Image' },
    { key: 'media', label: '媒体', test: (r) => r.type === 'Media' || !!r.kind || r.fromWs },
    { key: 'font', label: '字体', test: (r) => r.type === 'Font' },
    { key: 'ws', label: 'WS', test: (r) => r.type === 'WebSocket' },
    { key: 'fail', label: '失败', test: (r) => !!r.failed },
    { key: 'other', label: '其他', test: (r) => !r.type || (r.type === 'Other' && !r.kind) },
  ];

  const KIND_LABEL = {
    video: '视频',
    audio: '音频',
    image: '图片',
    hls: 'HLS',
    dash: 'DASH',
    subtitle: '字幕',
  };

  function ruleOf(list, key) {
    return list.find((item) => item.key === key) || list[0];
  }

  function matchesQuery(rec, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      String(rec.url || '').toLowerCase().includes(q) ||
      String(rec.host || '').toLowerCase().includes(q) ||
      String(rec.status == null ? '' : rec.status).includes(q) ||
      String(rec.method || '').toLowerCase().includes(q) ||
      String(rec.type || '').toLowerCase().includes(q) ||
      String(rec.mime || '').toLowerCase().includes(q)
    );
  }

  function sniffMatched(rec) {
    return ruleOf(SNIFF_KINDS, tb.sniffKind).test(rec) && matchesQuery(rec, tb.sniffQuery);
  }

  /**
   * 失败请求判定（v1.8.0「只看失败」）：
   * 判据用的是抓包记录里现有的两个字段 ——
   *   · rec.failed：主进程在请求出错时写入（errorText，或兜底的 'failed'），正常响应为空；
   *   · rec.status：正常拿到响应时为 HTTP 状态码，未拿到响应时为 0（进行中），因此 0 不算失败。
   * 命中条件 = rec.failed 非空 或 status ≥ 400。
   */
  function isFailedRec(rec) {
    if (!rec) return false;
    if (rec.failed) return true;
    const status = Number(rec.status);
    return Number.isFinite(status) && status >= 400;
  }

  /**
   * 慢请求判定（v1.11.0）：耗时 ≥ 阈值即算慢；耗时 0 / 未知不算。
   * 同一个判定既用于「慢请求」开关筛选，也用于行上的「慢」标记。
   */
  function isSlowRec(rec) {
    const duration = Number(rec && rec.duration);
    return Number.isFinite(duration) && duration > 0 && duration >= tb.netSlowMs;
  }

  function netMatched(rec) {
    // 与关系：类型 → 只看失败 → 慢请求 → 搜索词
    if (!ruleOf(NET_TYPES, tb.netType).test(rec)) return false;
    if (tb.netOnlyFailed && !isFailedRec(rec)) return false;
    if (tb.netSlowOnly && !isSlowRec(rec)) return false;
    return matchesQuery(rec, tb.netQuery);
  }

  /**
   * 「按耗时」排序规则：耗时降序；耗时 0 / 未知的排最后；
   * 同耗时按 seq 升序（请求到达顺序），保证排序稳定、不来回跳。
   */
  function sortNetRecords(list) {
    return list.slice().sort((a, b) => {
      const da = Number(a && a.duration) || 0;
      const db = Number(b && b.duration) || 0;
      if (da === 0 && db === 0) return (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0);
      if (da === 0) return 1;
      if (db === 0) return -1;
      if (db !== da) return db - da;
      return (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0);
    });
  }

  function countBy(list, test) {
    let n = 0;
    for (const rec of tb.records) if (test(rec)) n += 1;
    return n;
  }

  /* ============================ 筛选胶囊渲染 ============================ */

  function renderChips(container, list, activeKey, onPick) {
    container.textContent = '';
    for (const item of list) {
      const btn = el('button', `tb-chip${item.key === activeKey ? ' is-on' : ''}`);
      btn.type = 'button';
      btn.appendChild(document.createTextNode(item.label));
      const count = countBy(null, item.test);
      btn.appendChild(el('span', 'tb-chip-count', String(count)));
      btn.addEventListener('click', () => onPick(item.key));
      container.appendChild(btn);
    }
  }

  function renderSniffChips() {
    renderChips(els.sniffKinds, SNIFF_KINDS, tb.sniffKind, (key) => {
      tb.sniffKind = key;
      renderSniffChips();
      rebuildSniff();
    });
  }

  function renderNetChips() {
    renderChips(els.netTypes, NET_TYPES, tb.netType, (key) => {
      tb.netType = key;
      renderNetChips();
      rebuildNet();
    });
    // 「只看失败」是独立开关（不与类型互斥），所以不放进 renderChips 的列表里，
    // 而是在同一行末尾补一枚胶囊：每次重渲染都会重建，选中态跟着 tb.netOnlyFailed 走。
    const toggle = el('button', `tb-chip tb-chip-toggle${tb.netOnlyFailed ? ' is-on' : ''}`, '只看失败');
    toggle.type = 'button';
    toggle.title = '只显示失败的请求（状态码 ≥ 400，或请求出错）';
    toggle.setAttribute('aria-pressed', tb.netOnlyFailed ? 'true' : 'false');
    toggle.addEventListener('click', () => setNetOnlyFailed(!tb.netOnlyFailed));
    els.netTypes.appendChild(toggle);
    // 第二行：排序切换 + 慢请求开关 + 阈值输入（只创建一次，靠 syncNetExtras 同步状态）
    ensureNetExtras();
    syncNetExtras();
  }

  /** 切换「只看失败」：记住选择并重建列表（计数随 netMatched 一起变） */
  function setNetOnlyFailed(next) {
    const value = !!next;
    if (tb.netOnlyFailed === value) return;
    tb.netOnlyFailed = value;
    writeNetOnlyFailed(value);
    renderNetChips();
    rebuildNet();
  }

  /* ---------------- 抓包排序 / 慢请求控件（v1.11.0） ----------------
     这组控件放在类型胶囊行下面单独一行（#net-extra），而且只创建一次：
     类型胶囊行每次刷新（700ms 节流）都会被 renderChips 整行重建，
     把 number 输入框放进去会丢焦点、丢正在输入的值。 */

  let netExtraBar = null;
  let netSlowInput = null;

  function ensureNetExtras() {
    if (netExtraBar && netExtraBar.isConnected) return netExtraBar;
    if (!els.netTypes) return null;
    const bar = el('div', 'tb-chips tb-net-extra');
    bar.id = 'net-extra';

    for (const [sortKey, label, title] of [
      ['time', '按时间', '按请求到达顺序排列（默认）'],
      ['duration', '按耗时', '按耗时降序排列，耗时未知的排在最后'],
    ]) {
      const chip = el('button', 'tb-chip', label);
      chip.type = 'button';
      chip.dataset.sort = sortKey;
      chip.title = title;
      chip.addEventListener('click', () => setNetSort(sortKey));
      bar.appendChild(chip);
    }

    const slowChip = el('button', 'tb-chip tb-chip-toggle', '慢请求');
    slowChip.type = 'button';
    slowChip.title = '只显示耗时 ≥ 阈值的请求（行上的「慢」标记与开关无关，始终显示）';
    slowChip.addEventListener('click', () => setNetSlowOnly(!tb.netSlowOnly));
    bar.appendChild(slowChip);

    netSlowInput = el('input', 'tb-input tb-slow-input');
    netSlowInput.type = 'number';
    netSlowInput.min = '1';
    netSlowInput.step = '100';
    netSlowInput.title = '慢请求阈值（毫秒），回车或失焦立即生效';
    netSlowInput.value = String(tb.netSlowMs);
    const applyThreshold = () => {
      const next = normalizeSlowMs(netSlowInput.value);
      tb.netSlowMs = next;
      writeNetSlowMs(next);
      netSlowInput.value = String(next);
      // v1.16.0：同步写进主进程（设置页读的是同一份），失败也不影响本窗口即时生效
      if (typeof nyx.tbSlowMsSet === 'function') {
        nyx.tbSlowMsSet(next).catch(() => {
          /* 主进程写盘失败：本窗口仍按新阈值显示，下次打开会回落到主进程的值 */
        });
      }
      // 阈值变了：行的「慢」标记与筛选结果都要重算
      renderNetChips();
      rebuildNet();
    };
    netSlowInput.addEventListener('change', applyThreshold);
    netSlowInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyThreshold();
    });
    bar.appendChild(netSlowInput);

    els.netTypes.after(bar);
    netExtraBar = bar;
    syncNetExtras();
    return bar;
  }

  /** 同步排序 / 慢请求控件的选中态与输入值（不重建 DOM）；控件还没建就先建出来 */
  function syncNetExtras() {
    if (!netExtraBar) {
      if (!ensureNetExtras()) return;
      return; // ensureNetExtras 末尾已同步过一次
    }
    for (const chip of netExtraBar.querySelectorAll('.tb-chip')) {
      if (chip.dataset.sort) chip.classList.toggle('is-on', chip.dataset.sort === tb.netSort);
    }
    const slowChip = netExtraBar.querySelector('.tb-chip-toggle');
    if (slowChip) {
      slowChip.classList.toggle('is-on', tb.netSlowOnly);
      slowChip.setAttribute('aria-pressed', tb.netSlowOnly ? 'true' : 'false');
    }
    // 正在输入的框不回填，避免打断打字
    if (netSlowInput && document.activeElement !== netSlowInput) netSlowInput.value = String(tb.netSlowMs);
  }

  /** 切换排序：记住选择并重建（按耗时回到顶部，按时间贴到底部） */
  function setNetSort(sortKey) {
    const next = sortKey === 'duration' ? 'duration' : 'time';
    if (tb.netSort === next) return;
    tb.netSort = next;
    writeNetSort(next);
    syncNetExtras();
    rebuildNet();
  }

  /** 切换「慢请求」筛选：只影响筛选，不影响行上的「慢」标记 */
  function setNetSlowOnly(next) {
    const value = !!next;
    if (tb.netSlowOnly === value) return;
    tb.netSlowOnly = value;
    syncNetExtras();
    rebuildNet();
  }

  /* ============================ 资源嗅探 ============================ */

  function buildSniffNode(rec) {
    const item = el('div', 'tb-item');
    const kind = rec.kind || 'other';
    item.appendChild(el('span', `tb-item-kind tb-kind-${kind}`, KIND_LABEL[kind] || '其他'));

    const main = el('div', 'tb-item-main');
    main.appendChild(el('div', 'tb-item-name', fileNameOf(rec.url)));

    const bits = [rec.host || '', rec.mime || '', fmtSize(rec.size), fmtMs(rec.duration)];
    if (rec.fromWs) bits.push('来自 WebSocket');
    const sub = el('div', 'tb-item-sub', bits.filter(Boolean).join(' · '));
    main.appendChild(sub);

    const acts = el('div', 'tb-item-acts');
    acts.appendChild(miniBtn('复制', '复制资源地址', () => copy(rec.url, '资源地址')));
    acts.appendChild(miniBtn('打开', '在当前窗口新建标签打开', () => nyx.openToolboxUrl({ url: rec.url })));
    acts.appendChild(miniBtn('下载', '下载到系统下载目录', async () => {
      const res = await nyx.downloadToolboxResource({ url: rec.url });
      if (check(res)) toast(`已开始下载：${res.path || ''}`);
    }));
    acts.appendChild(
      miniBtn('外部', '交给系统默认浏览器 / 播放器', async () => {
        const res = await nyx.openToolboxUrl({ url: rec.url, external: true });
        if (check(res)) toast('已交给系统默认程序打开');
      }),
    );
    acts.appendChild(
      miniBtn('详情', '跳到抓包页签查看完整请求', () => {
        switchPane('net');
        openDetail(rec.id);
      }),
    );
    main.appendChild(acts);

    item.appendChild(main);
    return item;
  }

  function updateSniffNode(rec) {
    if (!sniffMatched(rec)) return;
    const exist = tb.sniffNodes.get(rec.id);
    if (exist) {
      // 记录完结后大小、耗时、MIME 才会齐，这里整体重画该行
      const fresh = buildSniffNode(rec);
      exist.replaceWith(fresh);
      tb.sniffNodes.set(rec.id, fresh);
      return;
    }
    const node = buildSniffNode(rec);
    tb.sniffNodes.set(rec.id, node);
    els.sniffList.appendChild(node);
    if (tb.sniffNodes.size > MAX_NODES) {
      const firstKey = tb.sniffNodes.keys().next().value;
      const first = tb.sniffNodes.get(firstKey);
      if (first) first.remove();
      tb.sniffNodes.delete(firstKey);
    }
  }

  function rebuildSniff() {
    els.sniffList.textContent = '';
    tb.sniffNodes.clear();
    const matches = tb.records.filter(sniffMatched);
    const shown = matches.slice(-MAX_NODES);
    const frag = document.createDocumentFragment();
    for (const rec of shown) {
      const node = buildSniffNode(rec);
      tb.sniffNodes.set(rec.id, node);
      frag.appendChild(node);
    }
    if (shown.length === 0) {
      els.sniffList.appendChild(emptyHint(tb.records.length === 0 ? '暂无资源' : '没有命中筛选条件的资源'));
    } else {
      els.sniffList.appendChild(frag);
      els.sniffList.scrollTop = els.sniffList.scrollHeight;
    }
    renderSniffMeta(matches.length);
  }

  function renderSniffMeta(matchedCount) {
    if (!els.sniffMeta) return;
    if (tb.wcId == null) {
      els.sniffMeta.textContent = '当前标签的抓包通道尚未挂上（页面正在加载或工具箱刚打开）';
      return;
    }
    const matched = matchedCount == null ? tb.records.filter(sniffMatched).length : matchedCount;
    const parts = [`匹配 ${matched} 条`, `共记录 ${Math.max(tb.total, tb.records.length)} 条`];
    if (tb.dropped > 0) parts.push(`更早 ${tb.dropped} 条已滚动丢弃`);
    if (tb.paused) parts.push('已暂停');
    els.sniffMeta.textContent = parts.join(' · ');
  }

  /* ============================ 网络抓包 ============================ */

  function statusClass(rec) {
    if (rec.failed) return 'st-bad';
    if (rec.status == null) return 'st-pending';
    if (rec.status >= 400) return 'st-bad';
    if (rec.status >= 300) return 'st-redirect';
    return 'st-ok';
  }

  /** 抓包记录的站点域名：优先记录自带的 host，否则从 URL 解析；
      解析不出返回空串 —— 该行不画图标，但行本身照常显示 */
  function recHost(rec) {
    const given = String((rec && rec.host) || '').trim().toLowerCase();
    if (given) return given;
    try {
      return new URL(String((rec && rec.url) || '')).host.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function buildNetNode(rec) {
    const row = el('div', 'tb-net');
    row.dataset.id = rec.id;
    const host = recHost(rec);
    if (host) row.dataset.host = host;
    if (tb.detailId === rec.id) row.classList.add('is-open');

    row.appendChild(el('span', `tb-net-status ${statusClass(rec)}`, rec.failed ? '×' : rec.status == null ? '…' : String(rec.status)));
    row.appendChild(el('span', 'tb-net-type', rec.type || (rec.fromWs ? 'WS帧' : '—')));

    // 站点图标（v1.7.0）：命中缓存立刻画真图标，否则先首字母色块，绝不阻塞渲染
    if (host) row.appendChild(siteIconNode(host));

    const body = el('div', 'tb-net-body');
    const urlLine = el('div', 'tb-net-url', rec.url);
    if (rec.fromWs) urlLine.classList.add('tb-net-media');
    body.appendChild(urlLine);
    const metaBits = [rec.method || 'GET', rec.host || ''];
    const sz = fmtSize(rec.size);
    if (sz) metaBits.push(sz);
    const dur = fmtMs(rec.duration);
    if (dur) metaBits.push(dur);
    if (rec.kind) metaBits.push(KIND_LABEL[rec.kind] || rec.kind);
    const tm = shortTime(rec.at);
    if (tm) metaBits.push(tm);
    body.appendChild(el('div', 'tb-net-host', metaBits.filter(Boolean).join(' · ')));
    row.appendChild(body);

    const right = el('span', 'tb-net-size', sz || '');
    row.appendChild(right);

    // 「慢」标记（v1.11.0）：只看阈值，与「慢请求」开关无关 —— 开关只影响筛选
    if (isSlowRec(rec)) {
      const slow = el('span', 'tb-slow-tag', '慢');
      slow.title = `耗时 ${fmtDurationLabel(rec.duration)}，已达到慢请求阈值 ${tb.netSlowMs} ms`;
      row.appendChild(slow);
    }

    row.addEventListener('click', () => openDetail(rec.id));
    return row;
  }

  function updateNetNode(rec) {
    if (!netMatched(rec)) {
      const stale = tb.netNodes.get(rec.id);
      if (stale) {
        stale.remove();
        tb.netNodes.delete(rec.id);
      }
      return;
    }
    const exist = tb.netNodes.get(rec.id);
    if (exist) {
      const fresh = buildNetNode(rec);
      exist.replaceWith(fresh);
      tb.netNodes.set(rec.id, fresh);
      // 请求完结时 duration 才变成真实值：按耗时视图里顺序会变，攒着待会儿重排
      if (tb.netSort === 'duration') scheduleNetResort();
      return;
    }
    const node = buildNetNode(rec);
    tb.netNodes.set(rec.id, node);
    els.netList.appendChild(node);
    if (tb.netNodes.size > MAX_NODES) {
      const firstKey = tb.netNodes.keys().next().value;
      const first = tb.netNodes.get(firstKey);
      if (first) first.remove();
      tb.netNodes.delete(firstKey);
    }
    // 新行进来才可能需要图标（同帧多次追加只触发一次扫描）
    queueVisibleNetIcons();
    // 按耗时视图：新行先按到达顺序追加，攒够数量 / 到时间再统一重排（见 scheduleNetResort）
    if (tb.netSort === 'duration') scheduleNetResort();
  }

  /* ---------------- 「按耗时」增量重排节流（v1.11.0） ----------------
     抓包高峰每秒进十几条，如果每插一行就全表排序 + 重建 DOM，面板会卡。
     这里两条阈值任一到就重排一次：
       · 累积 NET_RESORT_EVERY（20）条新行；
       · 或距上次重排超过 NET_RESORT_MS（2000ms，由上一条插入时起算）。
     重排会保留滚动位置，避免流式请求时列表每 2 秒跳回顶部。 */
  const NET_RESORT_EVERY = 20;
  const NET_RESORT_MS = 2000;
  let netResortTimer = null;
  let netResortPending = 0;

  function scheduleNetResort() {
    netResortPending += 1;
    if (netResortPending >= NET_RESORT_EVERY) {
      flushNetResort();
      return;
    }
    if (netResortTimer) return;
    netResortTimer = window.setTimeout(() => {
      netResortTimer = null;
      flushNetResort();
    }, NET_RESORT_MS);
  }

  function flushNetResort() {
    if (netResortTimer) {
      window.clearTimeout(netResortTimer);
      netResortTimer = null;
    }
    netResortPending = 0;
    if (tb.netSort !== 'duration') return;
    rebuildNet({ keepScroll: true });
  }

  /** 切换排序 / 重建列表前先取消待重排，避免重复重建 */
  function cancelNetResort() {
    if (netResortTimer) {
      window.clearTimeout(netResortTimer);
      netResortTimer = null;
    }
    netResortPending = 0;
  }

  /**
   * 重建抓包列表。
   * @param {{ keepScroll?: boolean }} options keepScroll=true 时保留当前滚动位置（增量重排用）；
   *   否则「按时间」贴到底部（原有行为）、「按耗时」回到顶部（先看最慢的请求）。
   */
  function rebuildNet(options) {
    const keepScroll = options && options.keepScroll ? els.netList.scrollTop : null;
    cancelNetResort();
    els.netList.textContent = '';
    tb.netNodes.clear();
    const matches = tb.records.filter(netMatched);
    // 按时间：取最近 MAX_NODES 条（原有行为）；按耗时：先排序再取最慢的 MAX_NODES 条
    const shown = tb.netSort === 'duration' ? sortNetRecords(matches).slice(0, MAX_NODES) : matches.slice(-MAX_NODES);
    const frag = document.createDocumentFragment();
    for (const rec of shown) {
      const node = buildNetNode(rec);
      tb.netNodes.set(rec.id, node);
      frag.appendChild(node);
    }
    if (shown.length === 0) {
      els.netList.appendChild(emptyHint(tb.records.length === 0 ? '暂无请求' : '没有命中筛选条件的请求'));
    } else {
      els.netList.appendChild(frag);
      if (keepScroll != null) els.netList.scrollTop = keepScroll;
      else els.netList.scrollTop = tb.netSort === 'duration' ? 0 : els.netList.scrollHeight;
    }
    renderNetMeta(matches.length);
    // 列表已滚到目标位置：先给可见（含预取）的行补站点图标
    queueVisibleNetIcons();
  }

  function renderNetMeta(matchedCount) {
    if (!els.netMeta) return;
    const matched = matchedCount == null ? tb.records.filter(netMatched).length : matchedCount;
    const parts = [`匹配 ${matched} 条`, `共记录 ${Math.max(tb.total, tb.records.length)} 条`];
    if (tb.dropped > 0) parts.push(`更早 ${tb.dropped} 条已滚动丢弃`);
    if (tb.paused) parts.push('已暂停');
    els.netMeta.textContent = parts.join(' · ');
  }

  /* ---------------- 抓包行的站点图标（v1.7.0） ----------------
     复用历史聚合行那套图标队列与首字母色块（siteIconNode / queueSiteIcon）。
     列表可能有上千行，所以只给「当前可见（上下各留 120px 预取）」的行排队：
     每帧最多 NET_ICON_BUDGET 个，滚动时再补，队列间隔沿用 20ms。 */
  const NET_ICON_BUDGET = 60;
  const NET_ICON_SCAN_MAX = 400;

  function queueVisibleNetIcons() {
    if (tb.netIconPump) return;
    if (!els.netList || typeof window.requestAnimationFrame !== 'function') return;
    tb.netIconPump = window.requestAnimationFrame(() => {
      tb.netIconPump = 0;
      const list = els.netList;
      if (!list) return;
      const rows = list.querySelectorAll('.tb-net');
      if (!rows.length) return;
      const box = typeof list.getBoundingClientRect === 'function' ? list.getBoundingClientRect() : null;
      const canMeasure = !!box && box.height > 0;
      let budget = NET_ICON_BUDGET;
      let scanned = 0;
      for (const row of rows) {
        if (budget <= 0 || scanned >= NET_ICON_SCAN_MAX) break;
        const host = row.dataset.host;
        if (!host || tb.siteIcons[host] || tb.siteIconAsked.has(host)) continue;
        scanned += 1;
        if (canMeasure) {
          const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null;
          // 面板隐藏或行尚未布局时 rect 全 0：退化成「按行序取前 N 行」
          if (rect && (rect.width > 0 || rect.height > 0)) {
            if (rect.bottom < box.top - 120 || rect.top > box.bottom + 120) continue;
          }
        }
        queueSiteIcon(host);
        budget -= 1;
      }
    });
  }

  function emptyHint(text) {
    return el('div', 'tb-empty', text);
  }

  /* ============================ 请求详情 ============================ */

  async function openDetail(id) {
    const rec = tb.byId.get(id);
    tb.detailId = id;
    // 每次打开详情都把瀑布的筛选重置为「全部」+ 关闭慢请求开关（不持久化，避免下次打开看不到东西）
    if (tb.waterfallTypes && tb.waterfallTypes.size > 0) tb.waterfallTypes.clear();
    tb.waterfallSlowOnly = false;
    els.detail.hidden = false;
    els.detailTitle.textContent = rec ? fileNameOf(rec.url) : '请求详情';
    els.netList.querySelectorAll('.tb-net').forEach((row) => {
      row.classList.toggle('is-open', row.dataset.id === id);
    });

    els.detailBody.textContent = '';
    els.detailBody.appendChild(el('div', 'tb-empty', '正在读取请求详情…'));

    const res = await nyx.getToolboxDetail({ wcId: tb.wcId == null ? undefined : tb.wcId, id });
    if (!res || res.ok === false) {
      els.detailBody.textContent = '';
      els.detailBody.appendChild(el('div', 'tb-empty', (res && res.error) || '详情不可读'));
      return;
    }
    tb.detailData = res;
    renderDetailSection();
  }

  function kvRow(key, value) {
    const row = el('div', 'tb-card-row');
    row.appendChild(el('span', 'tb-card-key', key));
    row.appendChild(el('span', 'tb-card-val', value));
    return row;
  }

  function sectionTitle(text) {
    return el('div', 'tb-group-title', text);
  }

  function headersBlock(title, headers) {
    const box = el('div', 'tb-card');
    box.appendChild(sectionTitle(title));
    const keys = Object.keys(headers || {});
    if (keys.length === 0) {
      box.appendChild(el('div', 'tb-note', '（无）'));
      return box;
    }
    for (const key of keys) box.appendChild(kvRow(key, headers[key]));
    return box;
  }

  /* ---- 耗时瀑布条（v1.9.0 起，v1.10.0 消费主进程分段） ----
     字段来源（读 src/core/toolbox.js 的 applyTiming 确认）：
       · rec.timing = { wait, download }（毫秒）：wait = 响应头 − 请求开始（TTFB），
         download = 完成 − 响应头；主进程用单调时钟计算并各自取整；
       · rec.duration = 完成 − 开始，是权威总耗时；没有时间戳时 duration=0 且 timing=null；
       · 两个字段都在 brief() 里下发，详情里从 data.record 取。
     两段和由两个已取整的分段相加而来，可能与 duration 差 1ms 左右；差超过
     TIMING_APPROX_TOLERANCE_MS 时总耗时以 duration 为准，并在图例后标「≈」，
     避免条宽按分段和算而溢出。没有 timing 时退化为「单色整条 + 总时长」。 */

  /** 两段和与 duration 允许的取整误差（毫秒）；超出则总耗时以 duration 为准并标 ≈ */
  const TIMING_APPROX_TOLERANCE_MS = 5;

  /** 时长的展示文案：<1000ms 显示 '123 ms'，否则 '1.2 s' */
  function fmtDurationLabel(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '';
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.round(value)} ms`;
  }

  /**
   * 解析耗时数据：返回 { total, wait, download, sum, split, approx } 或 null（无耗时）。
   * - split=false：只有 duration，画单色整条，不显示图例；
   * - split=true 且两段和为 0：按单色处理（wait/download 都无意义）；
   * - approx=true：两段和与 duration 差 > 5ms，总时长以 duration 为准。
   */
  function netTimingOf(record) {
    const rec = record || {};
    const duration = Number(rec.duration);
    const hasDuration = Number.isFinite(duration) && duration > 0;
    const timing = rec.timing && typeof rec.timing === 'object' ? rec.timing : null;

    if (timing) {
      const waitRaw = timing.wait != null ? timing.wait : timing.ttfb;
      const downloadRaw = timing.download != null ? timing.download : timing.body;
      const wait = Number(waitRaw);
      const download = Number(downloadRaw);
      const usable = Number.isFinite(wait) && Number.isFinite(download) && wait >= 0 && download >= 0;
      const sum = usable ? wait + download : 0;
      if (usable && sum > 0) {
        // duration 是权威总耗时；两段和只用来算条内占比
        const total = hasDuration ? duration : sum;
        const approx = hasDuration && Math.abs(sum - total) > TIMING_APPROX_TOLERANCE_MS;
        return { total, wait, download, sum, split: true, approx };
      }
    }

    if (!hasDuration) return null;
    return { total: duration, wait: 0, download: duration, sum: duration, split: false, approx: false };
  }

  /** 瀑布条：两段式（带图例 / 每段 title）或单色整条；无耗时则给「耗时未知」灰字，不画空条 */
  function buildTimingWaterfall(record) {
    const box = el('div', 'tb-timing');
    const info = netTimingOf(record);
    if (!info) {
      const unknown = el('div', 'tb-timing-unknown', '耗时未知');
      unknown.title = '请求还在进行中，或没有可用的耗时数据';
      box.appendChild(unknown);
      return box;
    }

    // 两段齐全时，条上方给一行小图例：「等待 120 ms · 下载 340 ms」
    if (info.split) {
      const legend = el('div', 'tb-timing-legend');
      legend.appendChild(document.createTextNode(`等待 ${fmtDurationLabel(info.wait)} · 下载 ${fmtDurationLabel(info.download)}`));
      if (info.approx) {
        const approx = el('span', 'tb-timing-approx', '≈');
        approx.title = '两段之和与总耗时存在取整差异，条宽按两段占比绘制，总时长以 duration 为准';
        legend.appendChild(approx);
      }
      box.appendChild(legend);
    }

    const row = el('div', 'tb-timing-row');
    const bar = el('div', 'tb-timing-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `总耗时 ${fmtDurationLabel(info.total)}`);

    // 占比分母优先用两段和：条总是铺满，同时不和 duration 的取整误差打架
    const base = info.split ? info.sum : info.total;
    const waitPct = info.split && base > 0 ? (info.wait / base) * 100 : 0;
    const downloadPct = 100 - waitPct;

    if (waitPct > 0) {
      const waitSeg = el('span', 'tb-timing-seg tb-timing-seg-wait');
      waitSeg.style.setProperty('--tb-seg-w', `${waitPct.toFixed(2)}%`);
      waitSeg.title = `等待响应（TTFB）：${fmtDurationLabel(info.wait)}`;
      bar.appendChild(waitSeg);
    }
    const bodySeg = el('span', 'tb-timing-seg tb-timing-seg-body');
    bodySeg.style.setProperty('--tb-seg-w', `${downloadPct.toFixed(2)}%`);
    bodySeg.title = info.split
      ? `内容下载：${fmtDurationLabel(info.download)}`
      : `总耗时：${fmtDurationLabel(info.total)}`;
    bar.appendChild(bodySeg);
    bar.title = info.split
      ? `等待响应 ${fmtDurationLabel(info.wait)} · 内容下载 ${fmtDurationLabel(info.download)}`
      : `总耗时 ${fmtDurationLabel(info.total)}`;

    row.appendChild(bar);
    row.appendChild(el('span', 'tb-timing-total', fmtDurationLabel(info.total)));
    // 超过 10s 标一个「慢」，纯视觉标记，不改任何数据
    if (info.total > 10000) row.appendChild(el('span', 'tb-timing-slow', '慢'));
    box.appendChild(row);
    return box;
  }

  /* ---- 多请求瀑布时间轴（v1.12.0） ----
     数据全部来自已经加载的 tb.records（不新增 IPC）：
       · at：请求开始（毫秒时间戳）→ 时间轴原点 = 这批请求里最早的 at；
       · duration / timing{wait,download}：条长与条内两段；
       · finished / failed / status：进行中与失败着色。
     取 seq 最大的最近 WATERFALL_MAX_ROWS 条；时间轴最长 WATERFALL_MAX_SPAN_MS，
     超出的条按 100% 截断并标 «»，避免一条卡死请求把其余条压成 1px。 */
  const WATERFALL_MAX_ROWS = 30;
  const WATERFALL_MAX_SPAN_MS = 60000;

  function clampPct(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
  }

  /** 取最近 N 条（按 seq 升序排好），瀑布内按时间顺序从上往下画 */
  function pickWaterfallRecords() {
    const list = Array.isArray(tb.records) ? tb.records : [];
    return list
      .slice()
      .sort((a, b) => (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0))
      .slice(-WATERFALL_MAX_ROWS);
  }

  /** 计算每条请求在时间轴上的相对起点 / 长度（百分比） */
  function computeWaterfall(records) {
    const list = Array.isArray(records) ? records : [];
    if (list.length === 0) return { origin: 0, span: 0, rows: [] };

    let origin = 0;
    for (const rec of list) {
      const at = Number(rec && rec.at) || 0;
      if (at > 0 && (!origin || at < origin)) origin = at;
    }
    if (!origin) origin = Number(list[0] && list[0].at) || 0;

    let maxEnd = origin;
    for (const rec of list) {
      const at = Number(rec && rec.at) || origin;
      const end = at + Math.max(0, Number(rec && rec.duration) || 0);
      if (end > maxEnd) maxEnd = end;
    }
    // 时间轴跨度：至少 1ms（避免除零），上限 60s
    let span = Math.max(1, maxEnd - origin);
    if (span > WATERFALL_MAX_SPAN_MS) span = WATERFALL_MAX_SPAN_MS;

    const rows = [];
    for (const rec of list) {
      const at = Number(rec && rec.at) || origin;
      const duration = Math.max(0, Number(rec && rec.duration) || 0);
      const startMs = Math.max(0, at - origin);
      const startPct = clampPct((startMs / span) * 100);
      const room = 100 - startPct;
      // 先按原始比例判断是否超轴，再截到轴尾（否则 clamp 之后永远判不出截断）
      const rawWidthPct = (duration / span) * 100;
      const widthPct = Math.min(rawWidthPct, room);
      const clipped = rawWidthPct > room;
      rows.push({ rec, startMs, startPct, widthPct, clipped });
    }
    return { origin, span, rows };
  }

  /** 行首文案：短域名 + 状态码；整行不超过 30 字符，域名过长时只截域名、保住状态码 */
  function waterfallLabel(rec) {
    const host = recHost(rec) || '(未知站点)';
    let status = '…';
    if (rec && rec.failed) status = '失败';
    else if (rec && rec.status != null) status = String(rec.status);
    const statusText = String(status);
    const hostRoom = Math.max(6, 30 - statusText.length - 1);
    const shortHost = host.length > hostRoom ? `${host.slice(0, hostRoom - 1)}…` : host;
    return `${shortHost} ${statusText}`;
  }

  /** 悬停说明：URL / 开始偏移 / 耗时（有分段再补等待与下载） */
  function waterfallTitle(row) {
    const rec = row.rec || {};
    const lines = [String(rec.url || '')];
    lines.push(`开始 +${Math.round(row.startMs)} ms`);
    lines.push(isPendingRec(rec) ? '耗时 …（进行中）' : `耗时 ${fmtDurationLabel(rec.duration)}`);
    const timing = netTimingOf(rec);
    if (timing && timing.split) {
      lines.push(`等待 ${fmtDurationLabel(timing.wait)} / 下载 ${fmtDurationLabel(timing.download)}`);
    }
    if (row.clipped) lines.push('条尾超出时间轴，已截断（»）');
    return lines.filter(Boolean).join('\n');
  }

  /** 进行中：还没有结束事件，也没失败 */
  function isPendingRec(rec) {
    return !!rec && rec.finished !== true && !rec.failed;
  }

  /** 单条请求的瀑布行：标签 + 轨道（条内按 timing 拆两段）+ 耗时 */
  function buildWaterfallRow(row) {
    const rec = row.rec || {};
    const line = el('div', 'tb-wf-row');
    line.title = waterfallTitle(row);
    if (tb.detailId === rec.id) line.classList.add('is-open');
    if (isFailedRec(rec)) line.classList.add('is-failed');
    if (isPendingRec(rec)) line.classList.add('is-pending');

    line.appendChild(el('span', 'tb-wf-label', waterfallLabel(rec)));

    const track = el('div', 'tb-wf-track');
    // 进行中的条给一点最小可见宽度，否则 0ms 的条完全看不见
    const pending = isPendingRec(rec);
    const widthPct = pending && row.widthPct <= 0 ? 1.5 : row.widthPct;
    const bar = el('div', 'tb-wf-bar');
    bar.style.setProperty('--wf-left', `${row.startPct.toFixed(2)}%`);
    bar.style.setProperty('--wf-w', `${widthPct.toFixed(2)}%`);

    const timing = netTimingOf(rec);
    if (timing && timing.split) {
      const waitPct = (timing.wait / timing.sum) * 100;
      const waitSeg = el('span', 'tb-wf-seg tb-wf-seg-wait');
      waitSeg.style.setProperty('--wf-seg-w', `${waitPct.toFixed(2)}%`);
      bar.appendChild(waitSeg);
      const bodySeg = el('span', 'tb-wf-seg tb-wf-seg-body');
      bodySeg.style.setProperty('--wf-seg-w', `${(100 - waitPct).toFixed(2)}%`);
      bar.appendChild(bodySeg);
    } else {
      const bodySeg = el('span', 'tb-wf-seg tb-wf-seg-body');
      bodySeg.style.setProperty('--wf-seg-w', '100%');
      bar.appendChild(bodySeg);
    }
    track.appendChild(bar);
    if (row.clipped) {
      // 截断标记贴在条尾（放在条内，避免被轨道的 overflow 裁掉）
      bar.appendChild(el('span', 'tb-wf-clip', '»'));
    }
    line.appendChild(track);

    line.appendChild(el('span', 'tb-wf-dur', pending ? '…' : fmtDurationLabel(rec.duration)));
    line.addEventListener('click', () => openDetailFromWaterfall(rec));
    return line;
  }

  /** 从瀑布行跳到该请求的详情：切回「概览与头」分区再走现有的打开逻辑 */
  function openDetailFromWaterfall(rec) {
    if (!rec || rec.id == null) return;
    if (tb.detailSection !== 'headers') {
      tb.detailSection = 'headers';
      syncDetailNav();
    }
    openDetail(rec.id);
  }

  /** 时间轴顶部刻度：0 / 25% / 50% / 75% / 总时长 */
  function buildWaterfallTicks(span) {
    const axis = el('div', 'tb-wf-ticks');
    const marks = [0, 25, 50, 75, 100];
    for (const pct of marks) {
      const tick = el('span', 'tb-wf-tick', pct === 0 ? '0' : fmtDurationLabel((span * pct) / 100));
      tick.style.setProperty('--wf-tick', `${pct}%`);
      if (pct === 0) tick.classList.add('is-first');
      if (pct === 100) tick.classList.add('is-last');
      axis.appendChild(tick);
    }
    return axis;
  }

  /* ---- 瀑布区类型筛选（v1.13.0） ----
     多选胶囊，默认「全部」= 不筛选；状态只存在内存里（每次打开详情重置），
     免得用户下次打开时"什么都看不到"。类型映射按记录里的 type / kind：
     Document→文档、Script→脚本、XHR 与 Fetch→XHR、Image/Img→图片、
     Media（带 kind 的流媒体、WS 帧也算）→媒体、Font→字体，其余→其他。 */
  const WATERFALL_TYPE_ORDER = ['doc', 'script', 'xhr', 'image', 'media', 'font', 'other'];
  const WATERFALL_TYPE_LABEL = {
    all: '全部',
    doc: '文档',
    script: '脚本',
    xhr: 'XHR',
    image: '图片',
    media: '媒体',
    font: '字体',
    other: '其他',
  };
  const WATERFALL_TYPE_TESTS = {
    doc: (r) => r.type === 'Document',
    script: (r) => r.type === 'Script',
    xhr: (r) => r.type === 'XHR' || r.type === 'Fetch',
    image: (r) => r.type === 'Image' || r.type === 'Img',
    media: (r) => r.type === 'Media' || !!r.kind || !!r.fromWs,
    font: (r) => r.type === 'Font',
  };

  /** 请求归到哪个类型（other 兜底） */
  function waterfallTypeOf(rec) {
    const target = rec || {};
    for (const key of WATERFALL_TYPE_ORDER) {
      const test = WATERFALL_TYPE_TESTS[key];
      if (test && test(target)) return key;
    }
    return 'other';
  }

  /** 当前筛选是否命中：集合为空 = 全部 */
  function waterfallTypeMatched(rec) {
    const picked = tb.waterfallTypes;
    if (!picked || picked.size === 0) return true;
    return picked.has(waterfallTypeOf(rec));
  }

  /**
   * 按指定阈值判断是否慢请求（瀑布区专用）。
   * 阈值由调用方传入（来自 tb.netSlowMs），主进程的广播会先把 tb.netSlowMs 更新好，
   * 所以列表面板/设置页改阈值后这里下一次渲染自然跟上。
   */
  function isSlowRecAt(rec, slowMs) {
    const duration = Number(rec && rec.duration);
    return Number.isFinite(duration) && duration > 0 && duration >= slowMs;
  }

  /** 切换「只看慢请求」：不持久化，只在详情抽屉的瀑布区重绘 */
  function toggleWaterfallSlow() {
    tb.waterfallSlowOnly = !tb.waterfallSlowOnly;
    if (tb.detailSection === 'waterfall') renderDetailSection();
  }

  /** 切换类型：「全部」清空集合，其余多选切换，然后只重绘详情抽屉里的瀑布 */
  function toggleWaterfallType(key) {
    if (!tb.waterfallTypes) tb.waterfallTypes = new Set();
    if (key === 'all') {
      tb.waterfallTypes.clear();
    } else if (tb.waterfallTypes.has(key)) {
      tb.waterfallTypes.delete(key);
    } else {
      tb.waterfallTypes.add(key);
    }
    if (tb.detailSection === 'waterfall') renderDetailSection();
  }

  /** 类型胶囊行：全部 + 7 个类型 + 末尾「只看慢请求」开关（复用 .tb-chips / .tb-chip 视觉） */
  function buildWaterfallTypeChips(slowMs) {
    const bar = el('div', 'tb-chips tb-wf-types');
    const active = tb.waterfallTypes;
    const allOn = !active || active.size === 0;
    for (const key of ['all'].concat(WATERFALL_TYPE_ORDER)) {
      const on = key === 'all' ? allOn : !allOn && active.has(key);
      const chip = el('button', `tb-chip${on ? ' is-on' : ''}`, WATERFALL_TYPE_LABEL[key] || key);
      chip.type = 'button';
      chip.dataset.wfType = key;
      chip.title = key === 'all' ? '不按类型筛选' : `只显示${WATERFALL_TYPE_LABEL[key]}类请求（可多选）`;
      chip.addEventListener('click', () => toggleWaterfallType(key));
      bar.appendChild(chip);
    }
    // 慢请求开关：与类型筛选是「与」关系，阈值跟随抓包工具条里的设置
    const slowChip = el(
      'button',
      `tb-chip tb-chip-toggle${tb.waterfallSlowOnly ? ' is-on' : ''}`,
      '只看慢请求',
    );
    slowChip.type = 'button';
    slowChip.dataset.wfSlow = '1';
    slowChip.title = `只显示耗时 ≥ ${slowMs} ms 的请求（阈值在抓包工具条里改）`;
    slowChip.setAttribute('aria-pressed', tb.waterfallSlowOnly ? 'true' : 'false');
    slowChip.addEventListener('click', toggleWaterfallSlow);
    bar.appendChild(slowChip);
    return bar;
  }

  /** 瀑布面板：类型胶囊 + 统计 + 刻度 + 行；筛选无结果时保留胶囊并给空态 */
  function buildWaterfallBox() {
    const box = el('div', 'tb-wf');
    const picked = pickWaterfallRecords();
    if (picked.length === 0) {
      box.appendChild(emptyHint('暂无可用于瀑布的请求'));
      return box;
    }

    // v1.16.0：阈值取内存里的单源（主进程广播 / 面板输入都会维护 tb.netSlowMs），
    // 不再每次重读 localStorage —— 否则设置页改的值要等一次窗口重载才反映到瀑布
    const slowMs = tb.netSlowMs;
    const shown = picked
      .filter(waterfallTypeMatched)
      .filter((rec) => !tb.waterfallSlowOnly || isSlowRecAt(rec, slowMs));
    // 原点与跨度只按筛选后的集合计算
    const plan = computeWaterfall(shown);

    const head = el('div', 'tb-wf-head');
    const statsParts = [`显示 ${shown.length} / ${picked.length} 条`];
    if (shown.length) statsParts.push(`跨度 ${fmtDurationLabel(plan.span)}`);
    if (tb.waterfallSlowOnly) statsParts.push(`慢 ≥${slowMs} ms`);
    head.appendChild(el('span', '', statsParts.join(' · ')));
    box.appendChild(head);
    box.appendChild(buildWaterfallTypeChips(slowMs));

    if (shown.length === 0) {
      box.appendChild(emptyHint('当前筛选下没有请求'));
      return box;
    }

    box.appendChild(buildWaterfallTicks(plan.span));
    for (const row of plan.rows) box.appendChild(buildWaterfallRow(row));
    return box;
  }

  /** 详情分区导航的选中态同步（含 JS 注入的「瀑布」项） */
  function syncDetailNav() {
    if (!els.detailNav) return;
    for (const node of els.detailNav.querySelectorAll('.tb-nav-btn')) {
      node.classList.toggle('is-on', node.dataset.sec === tb.detailSection);
    }
  }

  /** 往详情分区导航里补一个「瀑布」区（DOM 契约不改 HTML，只在 JS 里追加） */
  let waterfallNavReady = false;
  function ensureWaterfallNav() {
    if (waterfallNavReady || !els.detailNav) return;
    let exists = false;
    for (const node of els.detailNav.querySelectorAll('.tb-nav-btn')) {
      if (node.dataset.sec === 'waterfall') exists = true;
    }
    if (!exists) {
      const btn = el('button', 'tb-nav-btn', '瀑布');
      btn.type = 'button';
      btn.dataset.sec = 'waterfall';
      btn.title = '最近 30 条请求在同一时间轴上的相对位置';
      els.detailNav.appendChild(btn);
    }
    waterfallNavReady = true;
  }

  function renderDetailSection() {
    // 瀑布区不依赖详情数据（详情接口失败也能看时间轴），先处理它
    if (tb.detailSection === 'waterfall') {
      els.detailBody.textContent = '';
      ensureWaterfallNav();
      els.detailBody.appendChild(buildWaterfallBox());
      return;
    }

    const data = tb.detailData;
    if (!data) return;
    const rec = data.record || {};
    els.detailBody.textContent = '';

    if (tb.detailSection === 'headers') {
      // 分区顶部：耗时瀑布条（无耗时则显示「耗时未知」灰字）
      els.detailBody.appendChild(buildTimingWaterfall(rec));
      const box = el('div', 'tb-card');
      box.appendChild(sectionTitle('概览'));
      box.appendChild(kvRow('方法', rec.method || 'GET'));
      box.appendChild(kvRow('状态', rec.failed ? '失败' : rec.status == null ? '进行中' : String(rec.status)));
      box.appendChild(kvRow('类型', rec.type || '—'));
      box.appendChild(kvRow('MIME', rec.mime || '—'));
      box.appendChild(kvRow('大小', fmtSize(rec.size) || '—'));
      box.appendChild(kvRow('耗时', fmtMs(rec.duration) || '—'));
      if (data.protocol) box.appendChild(kvRow('协议', data.protocol));
      if (data.remoteIP) box.appendChild(kvRow('远端 IP', data.remoteIP));
      if (rec.kind) box.appendChild(kvRow('资源', KIND_LABEL[rec.kind] || rec.kind));
      if (rec.cached) box.appendChild(kvRow('缓存', '命中'));
      box.appendChild(kvRow('时间', shortTime(rec.at)));
      els.detailBody.appendChild(box);

      const urlBox = el('div', 'tb-card');
      urlBox.appendChild(sectionTitle('地址'));
      const pre = el('pre', 'tb-pre', data.rawUrl || rec.url || '');
      urlBox.appendChild(pre);
      const acts = el('div', 'tb-item-acts');
      acts.appendChild(miniBtn('复制 URL', '复制完整地址', () => copy(data.rawUrl || rec.url, '地址')));
      acts.appendChild(miniBtn('复制 cURL', '复制成可粘贴到终端的 cURL 命令', () => copy(buildCurl(data), 'cURL')));
      acts.appendChild(miniBtn('下载', '下载该资源', async () => {
        const r = await nyx.downloadToolboxResource({ url: data.rawUrl || rec.url });
        if (check(r)) toast(`已开始下载：${r.path || ''}`);
      }));
      acts.appendChild(miniBtn('打开', '新建标签打开', () => nyx.openToolboxUrl({ url: data.rawUrl || rec.url })));
      urlBox.appendChild(acts);
      els.detailBody.appendChild(urlBox);

      els.detailBody.appendChild(headersBlock('请求头', data.requestHeaders));
      els.detailBody.appendChild(headersBlock('响应头', data.responseHeaders));
      return;
    }

    if (tb.detailSection === 'payload') {
      const box = el('div', 'tb-card');
      box.appendChild(sectionTitle('请求载荷'));
      if (data.postData) {
        box.appendChild(el('pre', 'tb-pre', data.postData));
        box.appendChild(
          miniBtn('复制载荷', '复制 POST 体', () => copy(data.postData, '载荷')),
        );
      } else {
        box.appendChild(el('div', 'tb-note', '该请求没有请求体（GET 或空体）。'));
      }
      els.detailBody.appendChild(box);
      return;
    }

    const box = el('div', 'tb-card');
    box.appendChild(sectionTitle('响应正文预览'));
    if (data.bodyPreview) {
      const limited = data.bodyPreview.slice(0, 200000);
      box.appendChild(el('pre', 'tb-pre', limited));
      const acts = el('div', 'tb-item-acts');
      acts.appendChild(miniBtn('复制正文', '复制预览正文', () => copy(limited, '正文')));
      box.appendChild(acts);
    } else {
      box.appendChild(el('div', 'tb-note', data.bodyNote || '无正文预览。'));
    }
    if (data.bodyPreview && data.bodyNote) box.appendChild(el('div', 'tb-note', data.bodyNote));
    els.detailBody.appendChild(box);
  }

  function buildCurl(data) {
    const rec = data.record || {};
    const method = rec.method || 'GET';
    const lines = [`curl -X ${method} '${data.rawUrl || rec.url}'`];
    const headers = data.requestHeaders || {};
    for (const key of Object.keys(headers)) {
      if (/^:(authority|method|path|scheme)$/i.test(key)) continue;
      lines.push(`  -H '${key}: ${String(headers[key]).replace(/'/g, "'\\''")}'`);
    }
    if (data.postData) lines.push(`  --data-raw '${String(data.postData).replace(/'/g, "'\\''")}'`);
    return lines.join(' \\\n');
  }

  function closeDetail() {
    els.detail.hidden = true;
    tb.detailId = null;
    tb.detailData = null;
    els.netList.querySelectorAll('.tb-net').forEach((row) => row.classList.remove('is-open'));
  }

  /* ============================ 页面环境 ============================ */

  async function refreshStatus() {
    const res = await nyx.getToolboxStatus({ wcId: tb.wcId == null ? undefined : tb.wcId });
    if (!res || res.ok === false) return;
    tb.paused = !!res.paused;
    els.netPause.textContent = tb.paused ? '继续' : '暂停';
    els.netPause.classList.toggle('is-on', tb.paused);

    if (res.attached === false) {
      els.dtNote.textContent = '抓包通道当前没挂上：多半是开发者工具占用着（两者互斥）。关闭开发者工具后点一次「重连」。';
    } else {
      els.dtNote.textContent = '检查元素、看控制台、改样式、打断点都在这里。开发者工具与抓包互斥，开着时抓包会暂停。';
    }
    renderSniffMeta();
    renderNetMeta();
  }

  function fillPresets() {
    const p = tb.presets;
    els.uaSelect.textContent = '';
    let group = null;
    let groupNode = null;
    for (const item of p.ua || []) {
      if (item.group !== group) {
        group = item.group;
        groupNode = document.createElement('optgroup');
        groupNode.label = group;
        els.uaSelect.appendChild(groupNode);
      }
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      if (item.desc) opt.title = item.desc;
      (groupNode || els.uaSelect).appendChild(opt);
    }

    els.deviceSelect.textContent = '';
    for (const item of p.device || []) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      els.deviceSelect.appendChild(opt);
    }

    els.throttleSelect.textContent = '';
    for (const item of p.throttle || []) {
      const opt = document.createElement('option');
      opt.value = item.key;
      opt.textContent = item.label;
      els.throttleSelect.appendChild(opt);
    }
  }

  function syncEnvFromSticky() {
    const s = tb.sticky;
    if (!s) return;
    if (s.uaPreset) els.uaSelect.value = s.uaPreset;
    if (s.customUA) els.uaCustom.value = s.customUA;
    if (s.devicePreset) els.deviceSelect.value = s.devicePreset;
    if (s.throttle) els.throttleSelect.value = s.throttle;
    els.jsToggle.checked = !s.disabledJs;
    toggleCustomRow();
    renderEnvNote();
  }

  function toggleCustomRow() {
    els.uaCustomRow.hidden = els.uaSelect.value !== 'custom';
  }

  function renderEnvNote() {
    const parts = [];
    if (els.uaSelect.value !== 'default') parts.push(`UA：${els.uaSelect.options[els.uaSelect.selectedIndex].textContent}`);
    if (els.deviceSelect.value !== 'off') parts.push(`视口：${els.deviceSelect.options[els.deviceSelect.selectedIndex].textContent}`);
    if (els.throttleSelect.value !== 'off') parts.push(`网络：${els.throttleSelect.options[els.throttleSelect.selectedIndex].textContent}`);
    if (!els.jsToggle.checked) parts.push('JavaScript 已禁用');
    els.envNote.textContent = parts.length
      ? `当前生效：${parts.join('；')}。设置对新标签同样生效。`
      : '改 UA + 视口即切换桌面网页与手机版网站；设置对新标签同样生效。';
  }

  async function applyEnv() {
    const keep = !!els.envKeep.checked;
    const uaPreset = els.uaSelect.value;
    const custom = els.uaCustom.value.trim();

    const uaRes = await nyx.setToolboxUA({ preset: uaPreset, custom, keepPage: true });
    if (!check(uaRes)) return;

    const devRes = await nyx.setToolboxDevice({ preset: els.deviceSelect.value, keepPage: true });
    if (!check(devRes)) return;

    const thrRes = await nyx.setToolboxThrottle({ preset: els.throttleSelect.value });
    if (!check(thrRes)) return;

    tb.sticky = Object.assign({}, tb.sticky, {
      uaPreset,
      customUA: custom,
      devicePreset: els.deviceSelect.value,
      throttle: els.throttleSelect.value,
    });
    renderEnvNote();

    if (keep) {
      toast('已应用，未重载页面（部分站点需刷新才切换版本）');
    } else {
      await nyx.reload();
      toast('已应用并重载页面');
    }
  }

  async function resetEnv() {
    els.uaSelect.value = 'default';
    els.deviceSelect.value = 'off';
    els.throttleSelect.value = 'off';
    els.jsToggle.checked = true;
    els.uaCustom.value = '';
    toggleCustomRow();
    await nyx.setToolboxJavaScript({ enabled: true });
    await applyEnv();
  }

  const PAGE_INFO_EXPR = `(() => {
    const bytes = (() => { let n = 0; try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i) || ''; n += k.length + (localStorage.getItem(k) || '').length; } } catch (e) {} return n; })();
    let cookieNames = 0;
    try { cookieNames = document.cookie ? document.cookie.split(';').length : 0; } catch (e) {}
    return {
      title: document.title,
      url: location.href,
      ready: document.readyState,
      viewport: window.innerWidth + '×' + window.innerHeight,
      dpr: window.devicePixelRatio,
      screen: window.screen.width + '×' + window.screen.height,
      lang: navigator.language,
      tz: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return '—'; } })(),
      cookieNames,
      lsKeys: (() => { try { return localStorage.length; } catch (e) { return 0; } })(),
      lsBytes: bytes,
      scripts: document.scripts.length,
      iframes: document.querySelectorAll('iframe').length,
      images: document.images.length,
      forms: document.forms.length
    };
  })()`;

  async function refreshPageInfo() {
    if (!els.pageInfo) return;
    els.pageInfo.textContent = '';
    const res = await nyx.evalOnSelector({ wcId: tb.wcId == null ? undefined : tb.wcId, selector: 'html', expression: PAGE_INFO_EXPR });
    if (!res || res.ok === false || !res.value) {
      els.pageInfo.appendChild(el('div', 'tb-note', (res && res.error) || '当前标签没有可读取的页面（可能是空白页或内置页面）。'));
      return;
    }
    const v = res.value;
    const rows = [
      ['标题', v.title || '—'],
      ['地址', v.url || '—'],
      ['状态', v.ready || '—'],
      ['视口', `${v.viewport || '—'} @${v.dpr || 1}x`],
      ['屏幕', v.screen || '—'],
      ['语言', v.lang || '—'],
      ['时区', v.tz || '—'],
      ['Cookie', `${v.cookieNames || 0} 项`],
      ['本地存储', `${v.lsKeys || 0} 键 / ${fmtSize(v.lsBytes) || '0B'}`],
      ['脚本/框架', `${v.scripts || 0} / ${v.iframes || 0}`],
      ['图片/表单', `${v.images || 0} / ${v.forms || 0}`],
    ];
    for (const [key, value] of rows) {
      els.pageInfo.appendChild(el('span', 'tb-kv-key', key));
      els.pageInfo.appendChild(el('span', 'tb-kv-val', String(value)));
    }
  }

  /* ---------------- 元素拾取 ---------------- */

  async function startPick() {
    if (tb.picking) return;
    tb.picking = true;
    els.pickStart.disabled = true;
    els.pickCancel.hidden = false;
    els.pickNote.textContent = '正在拾取：把鼠标移到目标元素上，点一下即可；Esc 取消。';

    const res = await nyx.pickElement({ wcId: tb.wcId == null ? undefined : tb.wcId });
    tb.picking = false;
    els.pickStart.disabled = false;
    els.pickCancel.hidden = true;
    els.pickNote.textContent = '点页面上的元素即可抓取它的选择器、XPath、盒子与文本；Esc 取消。';

    if (!res || res.ok === false) {
      if (res && res.error && /取消/.test(res.error)) return;
      toast((res && res.error) || '拾取失败', 'err');
      return;
    }
    renderPickResult(res.data || {});
  }

  function renderPickResult(info) {
    els.pickResult.hidden = false;
    els.pickResult.textContent = '';

    const rows = el('div', 'tb-card-row');
    const put = (key, value) => {
      rows.appendChild(el('span', 'tb-card-key', key));
      rows.appendChild(el('span', 'tb-card-val', value));
    };
    put('选择器', info.selector || '—');
    put('XPath', info.xpath || '—');
    put('标签', `${info.tag || '—'}${info.id ? `#${info.id}` : ''}`);
    if (info.classes && info.classes.length) put('class', info.classes.join(' '));
    if (info.box) put('盒子', `${info.box.w}×${info.box.h} @(${info.box.x},${info.box.y})`);
    if (info.href) put('href', info.href);
    if (info.src) put('src', info.src);
    els.pickResult.appendChild(rows);

    if (info.text) {
      els.pickResult.appendChild(sectionTitle('文本'));
      els.pickResult.appendChild(el('pre', 'tb-pre', info.text));
    }
    if (info.attrs && Object.keys(info.attrs).length) {
      els.pickResult.appendChild(sectionTitle('属性'));
      const box = el('div', 'tb-card');
      for (const key of Object.keys(info.attrs)) box.appendChild(kvRow(key, info.attrs[key]));
      els.pickResult.appendChild(box);
    }

    const acts = el('div', 'tb-item-acts');
    acts.appendChild(miniBtn('复制选择器', '复制 CSS 选择器', () => copy(info.selector, '选择器')));
    acts.appendChild(miniBtn('复制 XPath', '复制 XPath', () => copy(info.xpath, 'XPath')));
    acts.appendChild(miniBtn('复制文本', '复制元素文本', () => copy(info.text, '文本')));
    acts.appendChild(miniBtn('复制 HTML', '复制 outerHTML', () => copy(info.html, 'HTML')));
    acts.appendChild(
      miniBtn('高亮', '在页面上闪一下该元素', async () => {
        const r = await nyx.highlightElement({ selector: info.selector });
        if (r && r.ok) toast('已在页面上高亮');
        else toast((r && r.error) || '高亮失败', 'err');
      }),
    );
    els.pickResult.appendChild(acts);

    const evalBar = el('div', 'tb-bar');
    const input = el('input', 'tb-input');
    input.type = 'text';
    input.value = 'el.textContent.trim().slice(0, 200)';
    input.title = '表达式里的 el 即选中的元素';
    const btn = el('button', 'tb-btn', '取数');
    btn.type = 'button';
    const out = el('pre', 'tb-pre', '');
    out.hidden = true;
    btn.addEventListener('click', async () => {
      const r = await nyx.evalOnSelector({ selector: info.selector, expression: input.value });
      out.hidden = false;
      if (!r || r.ok === false) {
        out.textContent = (r && r.error) || '取数失败';
        return;
      }
      out.textContent = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
    });
    evalBar.appendChild(input);
    evalBar.appendChild(btn);
    els.pickResult.appendChild(sectionTitle('对选中元素取数'));
    els.pickResult.appendChild(evalBar);
    els.pickResult.appendChild(out);
  }

  /* ============================ 视频增强 ============================ */

  /** 秒 → mm:ss / hh:mm:ss */
  function fmtClock(sec) {
    if (sec == null || !isFinite(sec)) return '未知';
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /**
   * 解析跳转输入。
   * 三种写法都吃：50% / 12:30 / 1:02:03 / 750
   */
  function parseSeekSpec(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/%$/.test(raw)) {
      const n = Number(raw.slice(0, -1));
      if (!isFinite(n)) return null;
      return { percent: Math.max(0, Math.min(100, n)) };
    }
    if (raw.includes(':')) {
      const parts = raw.split(':').map((p) => Number(p));
      if (parts.some((n) => !isFinite(n))) return null;
      let sec = 0;
      for (const p of parts) sec = sec * 60 + p;
      return { seconds: sec };
    }
    const n = Number(raw);
    if (!isFinite(n)) return null;
    return { seconds: Math.max(0, n) };
  }

  function renderVideoChips() {
    const rates = (tb.presets && tb.presets.rates) || [];
    els.videoRates.textContent = '';
    for (const rate of rates) {
      const btn = el('button', 'tb-chip', `${rate}x`);
      btn.type = 'button';
      btn.title = `把当前视频调到 ${rate}x`;
      if (tb.video && Math.abs((tb.video.rate || 0) - rate) < 0.001) btn.classList.add('is-on');
      btn.addEventListener('click', () => applyRate(rate));
      els.videoRates.appendChild(btn);
    }

    const seeks = [
      { label: '25%', cfg: { percent: 25 } },
      { label: '50%', cfg: { percent: 50 } },
      { label: '75%', cfg: { percent: 75 } },
      { label: '90%', cfg: { percent: 90 } },
      { label: '跳末尾', cfg: { toEnd: true }, title: '跳到片尾前 0.4 秒，刷进度用' },
    ];
    els.videoSeeks.textContent = '';
    for (const item of seeks) {
      const btn = el('button', 'tb-chip', item.label);
      btn.type = 'button';
      btn.title = item.title || `跳到全片 ${item.label} 处`;
      btn.addEventListener('click', () => doSeek(item.cfg));
      els.videoSeeks.appendChild(btn);
    }
  }

  function renderVideoInfo() {
    const box = els.videoInfo;
    box.textContent = '';
    const put = (key, value) => {
      box.appendChild(el('span', 'tb-kv-key', key));
      box.appendChild(el('span', 'tb-kv-val', value));
    };
    const info = tb.video;
    if (!info || info.ok === false) {
      put('状态', (info && info.error) || '尚未扫描');
      return;
    }
    const main = info.videos && info.main >= 0 ? info.videos[info.main] : null;
    put('视频数', `${info.count}`);
    if (main) {
      put('主视频', `${main.width}×${main.height}${main.duration ? ` · ${fmtClock(main.currentTime)} / ${fmtClock(main.duration)}` : ''}`);
      put('形态', `${main.readyState >= 2 ? '已出画面' : '加载中'} · ${main.paused ? '暂停' : '播放中'} · 当前 ${main.rate}x`);
    } else {
      put('主视频', info.count ? '没有可见的视频画面' : '未找到 video 元素');
    }
    put('倍速接管', info.rate > 0 ? `${info.rate}x${info.lockRate ? ' · 已锁定' : ''}` : '未接管');
    if (info.lockSeek && info.seekTarget != null) put('进度锁定', `钉在 ${fmtClock(info.seekTarget)}`);
    put('改写状态', info.patched ? '已挂钩（站点改不动）' : '未挂钩');
    if (main && main.src) put('源', main.src);
    if (info.count > 1) put('提示', `页面共 ${info.count} 个视频，倍速与进度对全部生效`);
  }

  /** 扫描当前标签的视频；silent 为 true 时失败不弹提示（自动刷新用） */
  async function scanVideo(silent) {
    const res = await nyx.scanVideos({});
    tb.video = res || null;
    if (!res || res.ok === false) {
      renderVideoInfo();
      if (!silent) toast((res && res.error) || '扫描失败', 'err');
      return;
    }
    if (res.count === 0 && !silent) toast('当前页面没有找到视频');
    renderVideoInfo();
    renderVideoChips();
    // 用主进程的真实状态校正界面上的锁定开关与保活显示
    if (res.lockRate != null && videoLockTouched) els.videoRateLock.checked = !!res.lockRate;
    if (res.lockSeek != null) els.videoSeekLock.checked = !!res.lockSeek;
    if (res.viewport) {
      els.videoNote.textContent = `当前视口 ${res.viewport.width}×${res.viewport.height}，只作用于本标签里能拿到脚本权限的视频（含同源 iframe）。`;
    }
    await refreshMouseStatus(true);
  }

  async function applyRate(rate) {
    // 用户没手动动过锁定开关时，点倍速自动勾选锁定：站点（如 B 站）会把倍速写回，
    // 不锁定的话等于白设。手动改过开关后尊重用户选择。
    if (rate > 0 && !videoLockTouched) {
      videoLockTouched = true;
      els.videoRateLock.checked = true;
    }
    const res = await nyx.setVideoRate({
      rate,
      lock: els.videoRateLock.checked,
    });
    if (!check(res)) return;
    const clamped = res.clamped ? '（已收到内核上限 16x）' : '';
    toast(rate ? `已设为 ${res.rate}x，命中 ${res.touched || 0} 个媒体元素${clamped}` : '已还原 1x');
    await scanVideo(true);
  }

  async function doSeek(cfg) {
    const payload = Object.assign({}, cfg, {
      lock: els.videoSeekLock.checked,
    });
    const res = await nyx.seekVideo(payload);
    if (!check(res)) return;
    const first = res.applied && res.applied[0];
    toast(first ? `已跳到 ${fmtClock(first.time)}` : '已调整进度');
    await scanVideo(true);
  }

  function stopVideoWatch() {
    if (tb.videoWatchTimer) {
      window.clearInterval(tb.videoWatchTimer);
      tb.videoWatchTimer = null;
    }
    if (els.videoWatch) els.videoWatch.checked = false;
  }

  function startVideoWatch() {
    stopVideoWatch();
    tb.videoWatchTimer = window.setInterval(() => {
      if (!tb.open || els.paneVideo.hidden) return;
      scanVideo(true);
    }, 2000);
  }

  /** 保活运行期间的轻量轮询：只为了让"已移动 N 次 / 最近几秒前"是活的 */
  function startMousePoll() {
    stopMousePoll();
    tb.mousePollTimer = window.setInterval(() => {
      if (!tb.open || els.paneVideo.hidden || !tb.mouse.running) return;
      refreshMouseStatus(true);
    }, 2000);
  }

  function stopMousePoll() {
    if (tb.mousePollTimer) {
      window.clearInterval(tb.mousePollTimer);
      tb.mousePollTimer = null;
    }
  }

  /** 用主进程给的清单填视频相关的下拉与胶囊（清单只有一份，写在内核里） */
  function fillVideoPresets() {
    const gaps = (tb.presets && tb.presets.mouseGaps) || [];
    els.mouseGap.textContent = '';
    for (const gap of gaps) {
      const opt = el('option', '', gap.label);
      opt.value = gap.key;
      els.mouseGap.appendChild(opt);
    }
    if (!els.mouseGap.value && gaps.length) els.mouseGap.value = 'normal';
    renderVideoChips();
    renderMouseInfo();
  }

  function renderMouseInfo() {
    const m = tb.mouse || {};
    if (!m.running) {
      els.mouseInfo.textContent = m.moves ? `已停止 · 累计移动 ${m.moves} 次` : '未运行';
      return;
    }
    const since = m.lastAt ? Math.max(0, Math.round((Date.now() - m.lastAt) / 1000)) : null;
    const gapLabel = ((tb.presets && tb.presets.mouseGaps) || []).find((g) => g.key === m.gap);
    const channel = m.fallback ? '页面脚本通道' : 'CDP 通道';
    els.mouseInfo.textContent = `运行中 · ${m.mode === 'viewport' ? '整页' : '视频窗口'} · ${gapLabel ? gapLabel.label : ''} · 已移动 ${m.moves} 次${since == null ? '' : ` · 最近 ${since} 秒前`} · ${channel}`;
  }

  async function refreshMouseStatus(silent) {
    const res = await nyx.controlVideoMouse({
      action: 'status',
    });
    if (res && res.ok !== false) {
      tb.mouse = Object.assign({}, tb.mouse, res, { running: !!res.running });
    } else if (!silent) {
      tb.mouse = Object.assign({}, tb.mouse, { running: false });
    }
    renderMouseInfo();
  }

  /* ============================ 整体渲染 ============================ */

  function renderAll() {
    renderSniffChips();
    renderNetChips();
    rebuildSniff();
    rebuildNet();
    renderSniffMeta();
    renderNetMeta();
  }

  /* ============================ 历史记录页签 ============================ */

  function fmtDateTime(ts) {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function hostOf(url) {
    try {
      return new URL(url).host || url;
    } catch (e) {
      return url;
    }
  }

  async function loadHistory() {
    els.historyMeta.textContent = '加载中…';
    const res = await nyx.historyList();
    if (!res || res.ok === false) {
      els.historyMeta.textContent = (res && res.error) || '读取历史记录失败';
      els.historyList.textContent = '';
      return;
    }
    tb.historyItems = Array.isArray(res.items) ? res.items : [];
    renderHistory();
  }

  function historyMatched(item) {
    if (!tb.historyQuery) return true;
    const q = tb.historyQuery.toLowerCase();
    return (item.title || '').toLowerCase().includes(q) || (item.url || '').toLowerCase().includes(q);
  }

  /* ---------------- 按站点视图（v1.6.0） ---------------- */

  /** 展开后每个站点最多列出的明细条数 */
  const HISTORY_DETAIL_MAX = 50;
  /** 每次渲染最多补多少个站点的图标：历史可能上千条，避免一开面板就打出一片请求 */
  const HISTORY_ICON_BUDGET = 60;

  /** 相对时间：「刚刚 / 12 分钟前 / 3 小时前 / 5 天前」 */
  function fmtRelTime(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return '刚刚';
    const mins = Math.floor(diff / (60 * 1000));
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} 天前`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} 个月前`;
    return `${Math.floor(months / 12)} 年前`;
  }

  /** host 的稳定色相（0~359）：同一站点永远是同一颜色，与地址栏建议同一套哈希 */
  function hueOfHost(host) {
    let hash = 0;
    const text = String(host || '');
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
  }

  /** 首字母：去掉 www 后取第一个字符，中文取第一个字 */
  function monogramOf(host) {
    const first = String(host || '').replace(/^www\./i, '').charAt(0);
    return first ? first.toUpperCase() : '?';
  }

  /**
   * 站点图标节点：有缓存就画 <img>，没有就画首字母色块——绝不留空白。
   * 真图标解码失败（少数站点返回奇怪的 ICO）时同样回退到色块。
   * 图标是纯装饰：alt 空、title 给域名、不进 tab 顺序。
   */
  function siteIconNode(host) {
    const wrap = el('span', 'tb-site-icon');
    wrap.title = host;
    wrap.setAttribute('aria-hidden', 'true');
    const dataUrl = tb.siteIcons[host];
    if (!dataUrl) return monoIconNode(host);
    const img = document.createElement('img');
    img.className = 'tb-site-icon-img';
    img.alt = '';
    img.decoding = 'async';
    img.src = dataUrl;
    img.addEventListener('error', () => {
      const mono = monoIconNode(host);
      if (wrap.parentNode) wrap.replaceWith(mono);
    });
    wrap.appendChild(img);
    return wrap;
  }

  /** 首字母色块：16×16 圆角块，色相由域名哈希派生（与地址栏建议同款观感） */
  function monoIconNode(host) {
    const node = el('span', 'tb-site-icon tb-site-mono', monogramOf(host));
    node.title = host;
    node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--site-hue', String(hueOfHost(host)));
    return node;
  }

  /**
   * 拿到图标后只替换命中 host 的图标槽（历史聚合行 + 抓包行共用同一份缓存），
   * 绝不重渲染列表：抓包列表可能有上千行，重渲染会丢滚动位置与详情高亮。
   */
  function applySiteIcon(host, dataUrl) {
    if (!host || !dataUrl) return;
    tb.siteIcons[host] = dataUrl;
    for (const container of [els.historyList, els.netList]) {
      if (!container) continue;
      for (const row of container.querySelectorAll('.tb-site, .tb-net')) {
        if (row.dataset.host !== host) continue;
        const slot = row.querySelector('.tb-site-icon');
        if (slot) slot.replaceWith(siteIconNode(host));
      }
    }
  }

  /** 图标补全队列：一次只问一个站点，避免列表很长时瞬间打出一片 IPC 与抓取 */
  const siteIconQueue = [];
  let siteIconTimer = null;

  function queueSiteIcon(host) {
    if (!host || tb.siteIcons[host] || tb.siteIconAsked.has(host)) return;
    tb.siteIconAsked.add(host);
    siteIconQueue.push(host);
    if (siteIconTimer) return;
    siteIconTimer = window.setTimeout(flushSiteIconQueue, 20);
  }

  function flushSiteIconQueue() {
    siteIconTimer = null;
    const host = siteIconQueue.shift();
    if (!host) return;
    if (typeof nyx.siteIcon === 'function') {
      nyx
        .siteIcon({ host })
        .then((res) => {
          // 未命中时主进程会在后台抓，抓到了再通过 onSiteIcons 推回来
          if (res && res.ok !== false && res.icon) applySiteIcon(host, res.icon);
        })
        .catch(() => {
          /* 图标只是装饰，抓不到就保持首字母色块 */
        });
    }
    if (siteIconQueue.length) siteIconTimer = window.setTimeout(flushSiteIconQueue, 20);
  }

  /** 给本次渲染里还没图标、也没问过的站点排队（按最近访问顺序，限量） */
  function queueMissingIcons(groups) {
    let budget = HISTORY_ICON_BUDGET;
    for (const group of groups) {
      if (budget <= 0) break;
      if (tb.siteIcons[group.host] || tb.siteIconAsked.has(group.host)) continue;
      queueSiteIcon(group.host);
      budget -= 1;
    }
  }

  /** 按 host 聚合：次数、最近访问时间、明细（按访问时间倒序） */
  function buildSiteGroups(items) {
    const map = new Map();
    for (const item of items) {
      const host = hostOf(item.url) || '(未知站点)';
      let group = map.get(host);
      if (!group) {
        group = { host, count: 0, lastAt: 0, items: [] };
        map.set(host, group);
      }
      const at = Number(item.visitedAt) || 0;
      group.count += 1;
      if (at > group.lastAt) group.lastAt = at;
      group.items.push(item);
    }
    const groups = Array.from(map.values());
    for (const group of groups) {
      group.items.sort((a, b) => (Number(b.visitedAt) || 0) - (Number(a.visitedAt) || 0));
    }
    // 站点之间按最近访问倒序，时间相同再按次数多的在前
    groups.sort((a, b) => b.lastAt - a.lastAt || b.count - a.count);
    return groups;
  }

  /** 聚合行：图标 + 域名 + 访问次数 + 最近访问相对时间，点一行展开明细 */
  function buildSiteRow(group) {
    const row = el('div', 'tb-item tb-site');
    row.dataset.host = group.host;
    row.title = '点击展开 / 收起该站点的访问明细';
    const expanded = tb.historyOpen.has(group.host);
    if (expanded) row.classList.add('is-open');
    // 用 div 做行，但仍可键盘操作：Enter / 空格展开收起，aria-expanded 同步状态
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    row.appendChild(siteIconNode(group.host));

    const main = el('div', 'tb-item-main');
    main.appendChild(el('div', 'tb-item-name', group.host));
    const bits = [`${group.count} 次访问`, fmtRelTime(group.lastAt)];
    main.appendChild(el('div', 'tb-item-sub', bits.filter(Boolean).join(' · ')));
    row.appendChild(main);

    const caret = el('span', 'tb-site-caret', '▸');
    caret.setAttribute('aria-hidden', 'true');
    row.appendChild(caret);

    row.addEventListener('click', () => toggleSiteRow(row));
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleSiteRow(row);
    });
    return row;
  }

  /** 展开后的明细：最近访问倒序，最多 HISTORY_DETAIL_MAX 条 */
  function buildSiteDetail(group) {
    const box = el('div', 'tb-site-detail');
    const items = group.items.slice(0, HISTORY_DETAIL_MAX);
    for (const item of items) {
      const line = el('div', 'tb-site-url');
      line.title = item.url || '';
      line.appendChild(el('span', 'tb-site-url-title', item.title || item.url || '(无标题)'));
      line.appendChild(el('span', 'tb-site-url-time', fmtRelTime(item.visitedAt)));
      box.appendChild(line);
    }
    if (group.count > items.length) {
      box.appendChild(el('div', 'tb-site-more', `仅显示最近 ${items.length} 条，共 ${group.count} 条`));
    }
    return box;
  }

  /** 点聚合行：就地插入 / 移除明细节点，不重渲染整张列表 */
  function toggleSiteRow(row) {
    const host = row.dataset.host || '';
    if (!host) return;
    const open = row.classList.contains('is-open');
    const next = row.nextElementSibling;
    if (open) {
      if (next && next.classList.contains('tb-site-detail')) next.remove();
      row.classList.remove('is-open');
      row.setAttribute('aria-expanded', 'false');
      tb.historyOpen.delete(host);
      return;
    }
    row.classList.add('is-open');
    row.setAttribute('aria-expanded', 'true');
    tb.historyOpen.add(host);
    const group = tb.historyGroups.find((node) => node.host === host);
    if (group) row.after(buildSiteDetail(group));
  }

  let historyViewBar = null;
  let historyRangeBar = null;
  /** 自定义区间的输入行与两个日期框（v1.8.0） */
  let historyCustomRow = null;
  let historyFromEl = null;
  let historyToEl = null;

  /** 视图切换（按时间 / 按站点）与时间段胶囊：复用 .tb-chips / .tb-chip，插在历史页签的工具条里 */
  function ensureHistoryViewBar() {
    if (historyViewBar && historyViewBar.isConnected) return historyViewBar;
    const bar = els.paneHistory ? els.paneHistory.querySelector('.tb-bar') : null;
    if (!bar) return null;
    const chips = el('div', 'tb-chips');
    chips.id = 'history-views';
    for (const [view, label, title] of [
      ['time', '按时间', '按访问时间平铺显示'],
      ['site', '按站点', '按站点聚合：图标 + 域名 + 访问次数，点行展开明细'],
    ]) {
      const chip = el('button', 'tb-chip', label);
      chip.type = 'button';
      chip.dataset.view = view;
      chip.title = title;
      chip.addEventListener('click', () => switchHistoryView(view));
      chips.appendChild(chip);
    }
    bar.appendChild(chips);
    historyViewBar = chips;
    syncHistoryViewChips();

    // 时间段（v1.7.0）：全部 / 今天 / 近 7 天 / 更早；v1.8.0 追加「自定义」
    const ranges = el('div', 'tb-chips');
    ranges.id = 'history-ranges';
    for (const [range, label, title] of [
      ['all', '全部', '不限时间'],
      ['today', '今天', '今天 0 点之后的历史'],
      ['week', '近 7 天', '最近 7×24 小时的历史'],
      ['month', '近 30 天', '最近 30×24 小时的历史'],
      ['older', '更早', '30 天以前的历史'],
      ['custom', '自定义', '自定义时间段：填写开始 / 结束日期后点「应用」'],
    ]) {
      const chip = el('button', 'tb-chip', label);
      chip.type = 'button';
      chip.dataset.range = range;
      chip.title = title;
      chip.addEventListener('click', () => switchHistoryRange(range));
      ranges.appendChild(chip);
    }
    bar.appendChild(ranges);
    historyRangeBar = ranges;
    syncHistoryRangeChips();

    // 自定义区间输入行：只在选中「自定义」时显示，插在工具条下方
    const row = el('div', 'tb-date-row');
    row.id = 'history-custom';
    row.hidden = true;
    historyFromEl = el('input', 'tb-input tb-date');
    historyFromEl.type = 'date';
    historyFromEl.id = 'history-from';
    historyFromEl.title = '开始日期（含当天，按本地 0 点起）';
    historyToEl = el('input', 'tb-input tb-date');
    historyToEl.type = 'date';
    historyToEl.id = 'history-to';
    historyToEl.title = '结束日期（含当天，按本地 23:59:59）';
    const applyBtn = el('button', 'tb-btn tb-date-apply', '应用');
    applyBtn.type = 'button';
    applyBtn.title = '应用自定义时间段；只填一边时另一边不限，两端颠倒会自动交换';
    applyBtn.addEventListener('click', () => applyHistoryCustomRange());
    row.appendChild(historyFromEl);
    row.appendChild(el('span', 'tb-date-sep', '至'));
    row.appendChild(historyToEl);
    row.appendChild(applyBtn);
    bar.after(row);
    historyCustomRow = row;
    syncHistoryCustomRow();
    return chips;
  }

  /** 把 is-on 同步到当前视图对应的胶囊上 */
  function syncHistoryViewChips() {
    if (!historyViewBar) return;
    for (const chip of historyViewBar.querySelectorAll('.tb-chip')) {
      chip.classList.toggle('is-on', chip.dataset.view === tb.historyView);
    }
  }

  /** 把 is-on / 文案同步到当前时间段对应的胶囊上（自定义会显示区间摘要） */
  function syncHistoryRangeChips() {
    if (!historyRangeBar) return;
    for (const chip of historyRangeBar.querySelectorAll('.tb-chip')) {
      const active = chip.dataset.range === tb.historyRange;
      chip.classList.toggle('is-on', active);
      if (chip.dataset.range === 'custom') {
        const text = customRangeText();
        chip.textContent = active && text ? `自定义 ▸ ${text}` : '自定义';
        chip.title = text ? `自定义时间段：${text}（点开可改）` : '自定义时间段：填写开始 / 结束日期后点「应用」';
      }
    }
  }

  /** 'YYYY-MM-DD' → 'M/D'（胶囊与 meta 里用短文案） */
  function fmtMonthDay(value) {
    const parts = String(value || '').split('-');
    if (parts.length !== 3) return '';
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }

  /** 自定义区间的可读文案：'10/1–10/7' / '10/1 起' / '至 10/7' / ''（未设置） */
  function customRangeText() {
    const from = tb.historyCustom.from ? fmtMonthDay(tb.historyCustom.from) : '';
    const to = tb.historyCustom.to ? fmtMonthDay(tb.historyCustom.to) : '';
    if (from && to) return `${from}–${to}`;
    if (from) return `${from} 起`;
    if (to) return `至 ${to}`;
    return '';
  }

  /** 本地自然日 0 点 */
  function startOfLocalDay(value) {
    const parts = String(value || '').split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
  }

  /** 本地自然日 23:59:59.999（结束日含当天） */
  function endOfLocalDay(value) {
    const parts = String(value || '').split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999).getTime();
  }

  /** 切换时间段：记住选择并重渲染（聚合在过滤后的集合上重算） */
  function switchHistoryRange(range) {
    const next = HISTORY_RANGE_KEYS.includes(range) ? range : 'all';
    if (tb.historyRange === next) return;
    tb.historyRange = next;
    writeHistoryRange(next);
    syncHistoryRangeChips();
    syncHistoryCustomRow();
    renderHistory();
  }

  /**
   * 应用自定义区间：
   * - 只填一边 → 另一边不限；两端颠倒 → 自动交换（在 normalizeCustomRange 里做）；
   * - 非法 / 双双为空 → 不生效，保留上一次有效区间（只提示，不改状态）。
   */
  function applyHistoryCustomRange() {
    const raw = {
      from: historyFromEl ? historyFromEl.value : '',
      to: historyToEl ? historyToEl.value : '',
    };
    const next = normalizeCustomRange(raw);
    if (!next.from && !next.to) {
      toast('请先选择开始或结束日期', 'warn');
      return;
    }
    tb.historyCustom = next;
    writeHistoryCustom(next);
    // 回填规整后的值：两端颠倒时用户能直接看到已交换
    if (historyFromEl) historyFromEl.value = next.from;
    if (historyToEl) historyToEl.value = next.to;
    tb.historyRange = 'custom';
    writeHistoryRange('custom');
    syncHistoryRangeChips();
    syncHistoryCustomRow();
    renderHistory();
    toast(`已应用自定义时间段：${customRangeText() || '不限'}`);
  }

  /** 自定义输入行的显隐与回填：仅选中「自定义」时出现 */
  function syncHistoryCustomRow() {
    if (!historyCustomRow) return;
    const active = tb.historyRange === 'custom';
    historyCustomRow.hidden = !active;
    if (!active) return;
    // 正在输入的框不回填，避免打断打字
    if (historyFromEl && document.activeElement !== historyFromEl) historyFromEl.value = tb.historyCustom.from || '';
    if (historyToEl && document.activeElement !== historyToEl) historyToEl.value = tb.historyCustom.to || '';
  }

  /** 时间段过滤：今天 = 本地自然日 0 点起；近 7 / 30 天 = 滚动窗口；更早 = 30 天以外；自定义 = 区间内（含两端当天） */
  function historyRangeMatched(item, now) {
    const range = tb.historyRange;
    if (range === 'all') return true;
    const at = Number(item && item.visitedAt) || 0;
    // 没有时间戳的记录不参与受限时间段（否则会被误算进「更早」）
    if (!at) return false;
    if (range === 'older') return at < now - HISTORY_MONTH_MS;
    if (range === 'month') return at >= now - HISTORY_MONTH_MS;
    if (range === 'week') return at >= now - HISTORY_WEEK_MS;
    if (range === 'custom') {
      // 区间在写入 / 读取时已规整（非法归空、两端颠倒已交换）
      const from = tb.historyCustom.from ? startOfLocalDay(tb.historyCustom.from) : null;
      const to = tb.historyCustom.to ? endOfLocalDay(tb.historyCustom.to) : null;
      if (from != null && at < from) return false;
      if (to != null && at > to) return false;
      return true;
    }
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return at >= start.getTime();
  }

  /** meta 末尾的时间段说明：全部时不显示，自定义显示区间摘要 */
  function historyRangeSuffix() {
    if (tb.historyRange === 'all') return '';
    if (tb.historyRange === 'custom') return `（${customRangeText() || '自定义'}）`;
    return `（${HISTORY_RANGE_LABEL[tb.historyRange] || '全部'}）`;
  }

  function switchHistoryView(view) {
    const next = view === 'site' ? 'site' : 'time';
    if (tb.historyView === next) return;
    tb.historyView = next;
    writeHistoryView(next);
    syncHistoryViewChips();
    renderHistory();
  }

  function renderHistory() {
    ensureHistoryViewBar();
    syncHistoryViewChips();
    syncHistoryRangeChips();
    syncHistoryCustomRow();
    els.historyList.textContent = '';

    const all = tb.historyItems;
    // 过滤顺序：时间段 → 搜索词 → 视图渲染
    const now = Date.now();
    const inRange = all.filter((item) => historyRangeMatched(item, now));
    const shown = inRange.filter(historyMatched);
    const suffix = historyRangeSuffix();

    // 按站点：先聚合再画，聚合的次数 / 最近访问都基于过滤后的集合重算
    if (tb.historyView === 'site') {
      const groups = buildSiteGroups(shown);
      tb.historyGroups = groups;
      if (groups.length === 0) {
        els.historyList.appendChild(emptyHint(all.length === 0 ? '暂无历史记录' : '没有命中筛选条件的站点'));
      } else {
        const frag = document.createDocumentFragment();
        for (const group of groups) {
          frag.appendChild(buildSiteRow(group));
          // 重新渲染（搜索 / 切视图 / 刷新）后仍保持原来的展开状态
          if (tb.historyOpen.has(group.host)) frag.appendChild(buildSiteDetail(group));
        }
        els.historyList.appendChild(frag);
        queueMissingIcons(groups);
      }
      els.historyMeta.textContent = `共 ${all.length} 条 · ${groups.length} 个站点 · 命中 ${shown.length} 条${suffix}`;
      return;
    }

    // 按时间：沿用原有平铺列表（单条「打开 / 删除」照旧）
    if (shown.length === 0) {
      els.historyList.appendChild(emptyHint(all.length === 0 ? '暂无历史记录' : '没有命中筛选条件的历史记录'));
    } else {
      const frag = document.createDocumentFragment();
      for (const item of shown) frag.appendChild(buildHistoryRow(item));
      els.historyList.appendChild(frag);
    }
    els.historyMeta.textContent = `共 ${all.length} 条 · 命中 ${shown.length} 条${suffix}`;
  }

  /** 订阅主进程的图标补全推送：只换对应站点的图标，不打断展开与滚动 */
  function bindSiteIconPush() {
    if (typeof nyx.onSiteIcons !== 'function') return;
    nyx.onSiteIcons((payload) => {
      const incoming = (payload && payload.icons) || {};
      for (const host of Object.keys(incoming)) {
        if (incoming[host]) applySiteIcon(host, incoming[host]);
      }
    });
  }

  function buildHistoryRow(item) {
    const row = el('div', 'tb-item');
    const main = el('div', 'tb-item-main');
    main.appendChild(el('div', 'tb-item-name', item.title || hostOf(item.url)));
    const bits = [hostOf(item.url), fmtDateTime(item.visitedAt)];
    main.appendChild(el('div', 'tb-item-sub', bits.filter(Boolean).join(' · ')));
    const acts = el('div', 'tb-item-acts');
    acts.appendChild(
      miniBtn('打开', '在当前窗口新建标签打开', () => {
        nyx.createTab(item.url);
      }),
    );
    acts.appendChild(
      miniBtn('删除', '删除这条历史记录', async () => {
        const res = await nyx.historyRemove({ id: item.id });
        if (!check(res)) return;
        tb.historyItems = tb.historyItems.filter((it) => it.id !== item.id);
        renderHistory();
        toast('已删除该条历史记录');
      }),
    );
    main.appendChild(acts);
    row.appendChild(main);
    return row;
  }

  /* ============================ 书签页签 ============================ */

  async function loadBookmarks() {
    els.bmMeta.textContent = '加载中…';
    const res = await nyx.bookmarksList();
    if (!res || res.ok === false) {
      els.bmMeta.textContent = (res && res.error) || '读取书签失败';
      els.bmList.textContent = '';
      return;
    }
    // v2 树结构：直接保留树供树形渲染，bmState.total 为全部书签条数
    const root = res.tree && res.tree.root;
    bmState.root = root && Array.isArray(root.children) ? root : { id: 0, title: '书签栏', children: [] };
    bmState.total = countUrls(bmState.root.children);
    renderBookmarks();
  }

  function countUrls(nodes) {
    let n = 0;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.url) n += 1;
      if (Array.isArray(node.children)) n += countUrls(node.children);
    }
    return n;
  }

  /** 搜索过滤：文件夹在命中自身或子树任一命中时展示（树形保留层级） */
  function bmVisible(node) {
    if (!tb.bookmarkQuery) return true;
    const q = tb.bookmarkQuery.toLowerCase();
    const self = (node.title || '').toLowerCase().includes(q) || (node.url || '').toLowerCase().includes(q);
    if (self) return true;
    if (Array.isArray(node.children)) return node.children.some(bmVisible);
    return false;
  }

  function renderBookmarks() {
    els.bmList.textContent = '';
    const root = bmState.root;
    if (!root || root.children.length === 0) {
      els.bmList.appendChild(emptyHint('暂无书签，可收藏当前页或从浏览器导入'));
      els.bmMeta.textContent = '共 0 条书签';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const node of root.children) {
      if (!bmVisible(node)) continue;
      frag.appendChild(buildBookmarkNode(node, 0));
    }
    els.bmList.appendChild(frag);
    els.bmMeta.textContent = `共 ${bmState.total} 条书签 · 已选 ${els.bmList.querySelectorAll('input.bm-cb:checked').length} 项`;
  }

  /** 递归渲染书签节点：复选框 + 文件夹展开箭头 + 标签 + 同级上移/下移 */
  function buildBookmarkNode(node, depth) {
    const isFolder = !node.url;
    const row = el('div', 'bm-tree-row');
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const cb = el('input', 'bm-cb');
    cb.type = 'checkbox';
    cb.dataset.id = String(node.id);
    cb.title = isFolder ? '勾选文件夹会在删除时连同其内部全部书签一并删除' : `打开：${node.url}`;
    cb.addEventListener('change', () => onBookmarkCheck(node, cb.checked));
    row.appendChild(cb);

    if (isFolder) {
      const collapsed = bmState.collapsed.has(node.id);
      const arrow = el('button', 'bm-arrow', collapsed ? '▸' : '▾');
      arrow.type = 'button';
      arrow.title = collapsed ? '展开文件夹' : '折叠文件夹';
      arrow.addEventListener('click', (event) => {
        event.stopPropagation();
        if (collapsed) bmState.collapsed.delete(node.id);
        else bmState.collapsed.add(node.id);
        renderBookmarks();
      });
      row.appendChild(arrow);
    } else {
      row.appendChild(el('span', 'bm-arrow-spacer', ''));
    }

    const label = el('span', isFolder ? 'bm-label bm-label-folder' : 'bm-label bm-label-url', node.title || (node.url || '未命名文件夹'));
    if (node.url) {
      label.title = node.url;
      label.addEventListener('dblclick', () => nyx.createTab(node.url));
    }
    row.appendChild(label);

    const ops = el('span', 'bm-ops');
    ops.appendChild(miniBtn('↑', '同级内上移', () => moveBookmark(node.id, 'up')));
    ops.appendChild(miniBtn('↓', '同级内下移', () => moveBookmark(node.id, 'down')));
    row.appendChild(ops);

    const wrap = el('div', '');
    wrap.appendChild(row);
    if (isFolder && Array.isArray(node.children) && !bmState.collapsed.has(node.id)) {
      const box = el('div', 'bm-tree-children');
      for (const child of node.children) {
        if (!bmVisible(child)) continue;
        box.appendChild(buildBookmarkNode(child, depth + 1));
      }
      wrap.appendChild(box);
    }
    return wrap;
  }

  /** 勾选文件夹时联动全部后代（含嵌套文件夹的子代） */
  function onBookmarkCheck(node, checked) {
    if (!node.url) {
      const ids = new Set();
      collectDescendantIds(node, ids);
      els.bmList.querySelectorAll('input.bm-cb').forEach((cb) => {
        if (ids.has(Number(cb.dataset.id))) cb.checked = checked;
      });
    }
    els.bmMeta.textContent = `共 ${bmState.total} 条书签 · 已选 ${els.bmList.querySelectorAll('input.bm-cb:checked').length} 项`;
  }

  function collectDescendantIds(node, out) {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) {
      out.add(child.id);
      collectDescendantIds(child, out);
    }
  }

  function collectCheckedIds() {
    const ids = [];
    els.bmList.querySelectorAll('input.bm-cb:checked').forEach((cb) => ids.push(Number(cb.dataset.id)));
    return ids;
  }

  /** 同级上移 / 下移（立即生效并刷新书签栏） */
  async function moveBookmark(id, direction) {
    const res = await nyx.bookmarksMove({ id, direction });
    if (!check(res)) return;
    if (res.moved) toast('已移动');
    loadBookmarks();
    if (window.refreshBookmarkBar) window.refreshBookmarkBar();
  }

  /** 删除选中：二次确认后批量删除（文件夹连带子书签） */
  async function deleteCheckedBookmarks() {
    const ids = collectCheckedIds();
    if (!ids.length) {
      toast('请先勾选要删除的书签', 'warn');
      return;
    }
    const ok = window.confirm(`确定删除选中的 ${ids.length} 项吗？文件夹会连同其内部全部书签一起删除，此操作不可撤销。`);
    if (!ok) return;
    const res = await nyx.bookmarksRemoveMany({ ids });
    if (!check(res)) return;
    toast(`已删除 ${res.removed || 0} 项${res.skipped ? `，跳过 ${res.skipped} 项` : ''}`);
    loadBookmarks();
    if (window.refreshBookmarkBar) window.refreshBookmarkBar();
  }

  /** 新建文件夹（默认建在根下） */
  async function newBookmarkFolder() {
    const title = window.prompt('文件夹名称：', '');
    if (title == null) return;
    const res = await nyx.bookmarksAddFolder({ title: title.trim() });
    if (!check(res)) return;
    toast(`已创建文件夹「${res.title}」`);
    loadBookmarks();
    if (window.refreshBookmarkBar) window.refreshBookmarkBar();
  }

  async function addCurrentBookmark() {
    const state = await nyx.getToolboxState();
    const title = state && state.title ? state.title : '';
    const url = state && state.url ? state.url : '';
    if (!url || !/^https?:\/\//i.test(url)) {
      toast('当前页面不支持收藏（仅 http / https 页面）', 'warn');
      return;
    }
    // v2：默认收藏到根下（书签栏）；重复收藏由主进程返回 EXISTS 并统一提示
    const res = await nyx.bookmarksAdd({ title: title || url, url });
    if (!check(res)) return;
    toast('已收藏当前页');
    loadBookmarks();
    if (window.refreshBookmarkBar) window.refreshBookmarkBar();
  }

  async function importBookmarks(source) {
    const label = source === 'edge' ? 'Edge' : 'Chrome';
    els.bmImportEdge.disabled = true;
    els.bmImportChrome.disabled = true;
    try {
      const res = await nyx.bookmarksImport({ source });
      if (!check(res)) return;
      let msg = `从 ${label} 导入完成：新增 ${res.added} 条，跳过 ${res.skipped} 条`;
      if (res.moved > 0) msg += `，从书签栏归位 ${res.moved} 条到文件夹`;
      toast(msg);
      loadBookmarks();
      // 同步刷新顶部书签栏，让文件夹按钮立即可见
      if (window.refreshBookmarkBar) window.refreshBookmarkBar();
    } finally {
      els.bmImportEdge.disabled = false;
      els.bmImportChrome.disabled = false;
    }
  }

  /* ============================ 调试页签 ============================ */

  /** 首次读取的原始 HTML，供「还原」使用 */
  let dbgOriginalHtml = null;

  async function readPageHtml() {
    const res = await nyx.pageHtml({ action: 'read' });
    if (!check(res)) return;
    els.dbgHtml.value = res.html || '';
    if (dbgOriginalHtml == null) dbgOriginalHtml = res.html || '';
    els.dbgHtmlApply.disabled = false;
    els.dbgHtmlRevert.disabled = false;
    els.dbgHtmlNote.textContent = `已读取 ${(res.html || '').length} 字符${dbgOriginalHtml != null ? ' · 原始 HTML 已留档，可随时还原' : ''}`;
  }

  async function applyPageHtml() {
    const html = els.dbgHtml.value;
    if (!html) {
      toast('HTML 为空，无法应用', 'warn');
      return;
    }
    const res = await nyx.pageHtml({ action: 'apply', html });
    if (!check(res)) return;
    toast('已应用到页面');
  }

  async function revertPageHtml() {
    if (dbgOriginalHtml == null) {
      toast('尚未读取过原始 HTML，无可还原内容', 'warn');
      return;
    }
    const res = await nyx.pageHtml({ action: 'revert' });
    if (!check(res)) return;
    els.dbgHtml.value = dbgOriginalHtml;
    toast('已还原首次读取的 HTML');
  }

  async function runConsoleEval() {
    const expression = els.dbgJs.value;
    if (!expression) {
      toast('请输入要执行的 JS', 'warn');
      return;
    }
    els.dbgJsRun.disabled = true;
    els.dbgJsMeta.textContent = '执行中…';
    try {
      const res = await nyx.consoleEval({ expression });
      if (!res) {
        els.dbgJsMeta.textContent = '主进程没有响应';
        return;
      }
      if (res.ok === false) {
        els.dbgJsMeta.textContent = '执行失败';
        appendConsole('error', res.error || '未知错误');
        return;
      }
      els.dbgJsMeta.textContent = `执行完成 · ${res.logs && res.logs.length ? `捕获 ${res.logs.length} 条 console 输出` : '无 console 输出'}`;
      if (res.logs && res.logs.length) {
        for (const log of res.logs) {
          appendConsole(log.level === 'error' ? 'error' : log.level === 'warn' ? 'warn' : 'log', log.text);
        }
      }
      if (res.value !== undefined) {
        let shown;
        try {
          shown = typeof res.value === 'string' ? res.value : JSON.stringify(res.value);
        } catch (e) {
          shown = String(res.value);
        }
        appendConsole('result', `=> ${shown}`);
      }
      if ((!res.logs || !res.logs.length) && res.value === undefined) appendConsole('log', '（无输出）');
    } finally {
      els.dbgJsRun.disabled = false;
    }
  }

  function appendConsole(kind, text) {
    const line = el('div', `dbg-${kind}`, text);
    els.dbgJsOut.appendChild(line);
    els.dbgJsOut.scrollTop = els.dbgJsOut.scrollHeight;
  }

  function clearConsole() {
    els.dbgJsOut.textContent = '';
    els.dbgJsMeta.textContent = '';
  }

  /* ============================ Cookie 页签 ============================ */

  /** 当前站点 host：来自工具箱状态里的激活标签 URL */
  async function currentHost() {
    const state = await nyx.getToolboxState();
    if (!state || state.ok === false) return '';
    return hostOf(state.url || '');
  }

  async function loadCookies() {
    const host = await currentHost();
    if (!host) {
      els.ckMeta.textContent = '当前页面不是 http / https 站点';
      els.ckList.textContent = '';
      return;
    }
    els.ckMeta.textContent = `加载 ${host} 的 Cookie…`;
    const res = await nyx.cookieList({ host });
    if (!res || res.ok === false) {
      els.ckMeta.textContent = (res && res.error) || '读取 Cookie 失败';
      els.ckList.textContent = '';
      return;
    }
    renderCookies(res.list || [], host);
  }

  function renderCookies(list, host) {
    els.ckList.textContent = '';
    if (!list.length) {
      els.ckList.appendChild(emptyHint('当前站点没有 Cookie'));
      els.ckMeta.textContent = `${host} · 共 0 条 Cookie`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const c of list) frag.appendChild(buildCookieRow(c));
    els.ckList.appendChild(frag);
    els.ckMeta.textContent = `${host} · 共 ${list.length} 条 Cookie`;
  }

  function buildCookieRow(c) {
    const row = el('div', 'ck-item');
    const main = el('div', 'ck-main');
    const nameLine = el('div', 'ck-name', c.name);
    nameLine.appendChild(el('span', 'ck-domain', `${c.domain}${c.path || '/'}`));
    main.appendChild(nameLine);
    const sub = el('div', 'ck-sub', `值：${c.value || '(空)'}`);
    sub.title = c.value || '';
    main.appendChild(sub);
    row.appendChild(main);

    const badges = el('div', 'ck-badges');
    if (c.secure) badges.appendChild(el('span', 'ck-badge is-secure', 'Secure'));
    if (c.httpOnly) badges.appendChild(el('span', 'ck-badge is-http', 'HttpOnly'));
    if (c.session) badges.appendChild(el('span', 'ck-badge', '会话'));
    else if (c.expirationDate) badges.appendChild(el('span', 'ck-badge', fmtDateTime(c.expirationDate * 1000)));
    if (c.sameSite && c.sameSite !== 'unspecified') badges.appendChild(el('span', 'ck-badge', c.sameSite));
    row.appendChild(badges);

    const ops = el('div', 'ck-ops');
    ops.appendChild(miniBtn('编辑', '修改该 Cookie 的值', () => editCookie(c)));
    ops.appendChild(miniBtn('删除', '删除该 Cookie', () => removeCookie(c)));
    row.appendChild(ops);
    return row;
  }

  async function editCookie(c) {
    const value = window.prompt(`修改「${c.name}」的值：`, c.value || '');
    if (value == null) return;
    const res = await nyx.cookieSet({
      domain: String(c.domain || '').replace(/^\./, ''),
      name: c.name,
      value,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      expirationDate: c.expirationDate || undefined,
      sameSite: c.sameSite || undefined,
    });
    if (!check(res)) return;
    toast('已更新 Cookie');
    loadCookies();
  }

  async function removeCookie(c) {
    const ok = window.confirm(`删除 Cookie「${c.name}」（${c.domain}）？`);
    if (!ok) return;
    const res = await nyx.cookieRemove({ domain: String(c.domain || '').replace(/^\./, ''), name: c.name, path: c.path || '/' });
    if (!check(res)) return;
    toast('已删除');
    loadCookies();
  }

  async function newCookie() {
    const host = await currentHost();
    if (!host) {
      toast('当前页面不是 http / https 站点', 'warn');
      return;
    }
    const name = window.prompt('Cookie 名称：', '');
    if (name == null || !name.trim()) return;
    const value = window.prompt(`「${name.trim()}」的值：`, '');
    if (value == null) return;
    const res = await nyx.cookieSet({ domain: host, name: name.trim(), value });
    if (!check(res)) return;
    toast('已新增 Cookie');
    loadCookies();
  }

  async function clearSiteCookies() {
    const host = await currentHost();
    if (!host) return;
    const ok = window.confirm(`清空 ${host} 的全部 Cookie？此操作不可撤销。`);
    if (!ok) return;
    const res = await nyx.cookieClear({ host });
    if (!check(res)) return;
    toast(`已清空 ${res.removed || 0} 条 Cookie`);
    loadCookies();
  }

  async function importEdgeCookies(mode) {
    const btn = mode === 'site' ? els.ckEdgeSite : els.ckEdgeAll;
    const other = mode === 'site' ? els.ckEdgeAll : els.ckEdgeSite;
    btn.disabled = true;
    other.disabled = true;
    els.ckMeta.textContent = '正在从 Edge 导入 Cookie…';
    try {
      // Edge Cookies 库被占用时后台轮询重试（每 3 秒一次，最多 20 次 = 60 秒）
      const MAX_RETRY = 20;
      let res = null;
      for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        res = await nyx.cookieEdgeImport({ mode });
        if (!res) {
          els.ckMeta.textContent = '主进程没有响应';
          return;
        }
        if (res.ok !== false) break;
        if (res.locked && attempt < MAX_RETRY) {
          els.ckMeta.textContent = `Edge 正在占用 Cookie 库，请关闭 Edge，正在自动重试（${attempt + 1}/${MAX_RETRY}）…`;
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        break;
      }
      if (res.ok === false) {
        els.ckMeta.textContent = res.error || '导入失败';
        toast(res.error || '导入失败', 'err');
        return;
      }
      els.ckMeta.textContent = `Edge 导入完成：匹配 ${res.total} 条，写入 Nyx ${res.written} 条${res.failed ? `，失败 ${res.failed} 条` : ''}`;
      toast(`已从 Edge 导入 ${res.written} 条 Cookie`);
      loadCookies();
    } finally {
      btn.disabled = false;
      other.disabled = false;
    }
  }

  /* ============================ 事件绑定 ============================ */

  els.entry.addEventListener('click', () => {
    if (tb.open) closeToolbox();
    else openToolbox();
  });

  els.close.addEventListener('click', () => closeToolbox());
  els.width.addEventListener('click', () => cycleWidth());

  els.nav.addEventListener('click', (event) => {
    const btn = event.target.closest ? event.target.closest('.tb-nav-btn') : null;
    if (!btn || !btn.dataset.pane) return;
    switchPane(btn.dataset.pane);
  });

  // 滚轮转横向：必须 passive:false，才能阻止默认的纵向滚动
  els.nav.addEventListener('wheel', onNavWheel, { passive: false });

  // 用户自己横向拖滚 / 触摸板横扫后，渐隐方向要跟着变
  els.nav.addEventListener('scroll', () => updateNavFade(), { passive: true });

  // 键盘可达性：Tab 落到页签上时自动滚入视野（按钮本身是原生 button，天然可聚焦）
  els.nav.addEventListener('focusin', (event) => {
    const btn = event.target.closest ? event.target.closest('.tb-nav-btn') : null;
    if (btn) revealNavTab(btn);
  });

  // 窗口尺寸变化会改变页签栏可用宽度
  window.addEventListener('resize', () => updateNavFade());

  els.sniffSearch.addEventListener('input', () => {
    tb.sniffQuery = els.sniffSearch.value.trim();
    rebuildSniff();
  });

  els.netSearch.addEventListener('input', () => {
    tb.netQuery = els.netSearch.value.trim();
    rebuildNet();
  });

  els.netPause.addEventListener('click', async () => {
    const next = !tb.paused;
    const res = await nyx.pauseToolbox({ paused: next, wcId: tb.wcId == null ? undefined : tb.wcId });
    if (!check(res)) return;
    tb.paused = !!res.paused;
    els.netPause.textContent = tb.paused ? '继续' : '暂停';
    els.netPause.classList.toggle('is-on', tb.paused);
    renderSniffMeta();
    renderNetMeta();
  });

  els.netClear.addEventListener('click', async () => {
    const res = await nyx.clearToolboxRecords({ wcId: tb.wcId == null ? undefined : tb.wcId });
    if (!check(res)) return;
    tb.records = [];
    tb.byId.clear();
    tb.total = 0;
    tb.dropped = 0;
    if (tb.chipTimer) {
      window.clearTimeout(tb.chipTimer);
      tb.chipTimer = null;
    }
    closeDetail();
    renderAll();
    toast('记录已清空');
  });

  els.netFollow.addEventListener('change', () => {
    if (els.netFollow.checked) refreshActive();
  });

  // 抓包列表滚动：新滚进视野的行补站点图标（懒加载，不与渲染绑定）
  els.netList.addEventListener('scroll', () => queueVisibleNetIcons(), { passive: true });

  els.historySearch.addEventListener('input', () => {
    tb.historyQuery = els.historySearch.value.trim();
    renderHistory();
  });

  els.historyClear.addEventListener('click', async () => {
    const res = await nyx.historyClear();
    if (!check(res)) return;
    tb.historyItems = [];
    renderHistory();
    toast('历史记录已清空');
  });

  els.bmSearch.addEventListener('input', () => {
    tb.bookmarkQuery = els.bmSearch.value.trim();
    renderBookmarks();
  });

  els.bmAdd.addEventListener('click', () => addCurrentBookmark());

  els.bmImportEdge.addEventListener('click', () => importBookmarks('edge'));
  els.bmImportChrome.addEventListener('click', () => importBookmarks('chrome'));

  els.bmNewFolder.addEventListener('click', () => newBookmarkFolder());
  els.bmDelete.addEventListener('click', () => deleteCheckedBookmarks());

  els.dtOpen.addEventListener('click', async () => {
    const res = await nyx.devTools({ action: 'open', mode: els.dtMode.value });
    if (!check(res)) return;
    toast('开发者工具已打开，抓包暂时让位');
    window.setTimeout(refreshStatus, 400);
  });

  els.dtClose.addEventListener('click', async () => {
    const res = await nyx.devTools({ action: 'close' });
    if (!check(res)) return;
    await nyx.syncToolbox();
    toast('开发者工具已关闭，抓包通道已重连');
    window.setTimeout(refreshStatus, 300);
  });

  els.pickStart.addEventListener('click', () => startPick());
  els.pickCancel.addEventListener('click', () => nyx.cancelPickElement({}));

  els.uaSelect.addEventListener('change', () => {
    toggleCustomRow();
    renderEnvNote();
  });
  els.deviceSelect.addEventListener('change', renderEnvNote);
  els.throttleSelect.addEventListener('change', renderEnvNote);
  els.envApply.addEventListener('click', () => applyEnv());
  els.envReset.addEventListener('click', () => resetEnv());

  els.jsToggle.addEventListener('change', async () => {
    const enabled = els.jsToggle.checked;
    const res = await nyx.setToolboxJavaScript({ enabled });
    if (!check(res)) return;
    tb.sticky = Object.assign({}, tb.sticky, { disabledJs: !enabled });
    renderEnvNote();
    toast(enabled ? '已启用 JavaScript，正在重载' : '已禁用 JavaScript，正在重载');
    await nyx.reload();
  });

  els.infoRefresh.addEventListener('click', () => refreshPageInfo());

  els.siteClear.addEventListener('click', async () => {
    const res = await nyx.clearToolboxSiteData({ kinds: ['cookie', 'storage', 'cache'] });
    if (!check(res)) return;
    toast(`已清理 ${res.origin || '本站'} 的 Cookie / 存储 / 缓存，正在重载`);
    await nyx.reload();
  });

  els.shotView.addEventListener('click', () => capture(false));
  els.shotFull.addEventListener('click', () => capture(true));

  /* 视频页签：倍速 / 进度 / 鼠标保活 */

  // 倍速默认锁定：站点（如 B 站）会自行把倍速写回，勾选锁定后注入层会拦截写回
  els.videoRateLock.checked = true;

  els.videoScan.addEventListener('click', () => scanVideo(false));

  els.videoWatch.addEventListener('change', () => {
    if (els.videoWatch.checked) startVideoWatch();
    else stopVideoWatch();
  });

  els.videoRateApply.addEventListener('click', () => {
    const raw = els.videoRateCustom.value.trim();
    const rate = Number(raw);
    if (!raw || !isFinite(rate) || rate <= 0) return toast('倍速请填正数，如 3.5', 'err');
    applyRate(rate);
  });

  els.videoRateCustom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.videoRateApply.click();
  });

  els.videoRateReset.addEventListener('click', () => {
    videoLockTouched = true;
    els.videoRateLock.checked = false;
    applyRate(0);
  });

  els.videoRateLock.addEventListener('change', async () => {
    videoLockTouched = true;
    const lock = els.videoRateLock.checked;
    const taken = tb.video && tb.video.rate ? tb.video.rate : 0;
    const mainRate = tb.video && tb.video.videos && tb.video.main >= 0 ? tb.video.videos[tb.video.main].rate : 1;
    const rate = lock ? Math.max(1, taken || mainRate || 1) : taken || mainRate || 1;
    const res = await nyx.setVideoRate({
      rate,
      lock,
    });
    if (!check(res)) return;
    toast(lock ? `已锁定 ${rate}x：站点改回倍速会被拽回` : '已取消倍速锁定');
    await scanVideo(true);
  });

  els.videoSeekGo.addEventListener('click', () => {
    const spec = parseSeekSpec(els.videoSeekCustom.value);
    if (!spec) return toast('写法支持 12:30 / 750 / 50%', 'err');
    doSeek(spec);
  });

  els.videoSeekCustom.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') els.videoSeekGo.click();
  });

  els.videoSeekUnlock.addEventListener('click', async () => {
    els.videoSeekLock.checked = false;
    const res = await nyx.seekVideo({
      unlock: true,
      lock: false,
    });
    if (!check(res)) return;
    toast('已解除进度锁定');
    await scanVideo(true);
  });

  els.videoSeekLock.addEventListener('change', async () => {
    const lock = els.videoSeekLock.checked;
    const to = tb.video && tb.video.seekTarget != null ? tb.video.seekTarget : null;
    const cur = tb.video && tb.video.videos && tb.video.main >= 0 ? tb.video.videos[tb.video.main].currentTime : null;
    if (lock && to == null && cur == null) {
      els.videoSeekLock.checked = false;
      return toast('先跳转一次再锁定，锁定的是当前这个时间点', 'err');
    }
    const res = await nyx.seekVideo({
      seconds: to != null ? to : cur,
      lock,
    });
    if (!check(res)) {
      els.videoSeekLock.checked = !lock;
      return;
    }
    toast(lock ? '已锁定进度：站点拽回会被纠正' : '已解除进度锁定');
    await scanVideo(true);
  });

  els.mouseStart.addEventListener('click', async () => {
    const res = await nyx.controlVideoMouse({
      action: 'start',
      mode: els.mouseMode.value,
      gap: els.mouseGap.value,
    });
    if (!check(res)) return;
    tb.mouse = Object.assign({}, tb.mouse, (res && res.mouse) || {}, { running: true });
    tb.mouse.mode = els.mouseMode.value;
    tb.mouse.gap = els.mouseGap.value;
    renderMouseInfo();
    startMousePoll();
    toast('鼠标保活已开始');
  });

  els.mouseStop.addEventListener('click', async () => {
    const res = await nyx.controlVideoMouse({
      action: 'stop',
    });
    stopMousePoll();
    if (!check(res)) return;
    tb.mouse = Object.assign({}, tb.mouse, (res && res.mouse) || {}, { running: false });
    renderMouseInfo();
    toast('鼠标保活已停止');
  });

  async function restartMouseIfRunning() {
    if (!tb.mouse.running) return;
    await nyx.controlVideoMouse({
      action: 'start',
      mode: els.mouseMode.value,
      gap: els.mouseGap.value,
    });
    tb.mouse.mode = els.mouseMode.value;
    tb.mouse.gap = els.mouseGap.value;
    renderMouseInfo();
  }

  els.mouseMode.addEventListener('change', () => restartMouseIfRunning());
  els.mouseGap.addEventListener('change', () => restartMouseIfRunning());

  async function capture(fullPage) {
    const res = await nyx.captureToolboxScreenshot({ fullPage });
    if (!res) return toast('截图失败', 'err');
    if (res.canceled) return;
    if (res.ok === false) return toast(res.error || '截图失败', 'err');
    toast(`截图已保存：${res.path || ''}`);
  }

  els.detailClose.addEventListener('click', () => closeDetail());

  // 分区导航补一个 JS 注入的「瀑布」区（HTML 里仍只有三个分区按钮）
  ensureWaterfallNav();

  els.detailNav.addEventListener('click', (event) => {
    const btn = event.target.closest ? event.target.closest('.tb-nav-btn') : null;
    if (!btn || !btn.dataset.sec) return;
    tb.detailSection = btn.dataset.sec;
    syncDetailNav();
    renderDetailSection();
  });

  // 详情开着时按 Esc 先关详情
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.detail.hidden) closeDetail();
  });

  /* 调试页签 */
  els.dbgHtmlRead.addEventListener('click', () => readPageHtml());
  els.dbgHtmlApply.addEventListener('click', () => applyPageHtml());
  els.dbgHtmlRevert.addEventListener('click', () => revertPageHtml());
  els.dbgJsRun.addEventListener('click', () => runConsoleEval());
  els.dbgJsClear.addEventListener('click', () => clearConsole());

  /* Cookie 页签 */
  els.ckRefresh.addEventListener('click', () => loadCookies());
  els.ckAdd.addEventListener('click', () => newCookie());
  els.ckClear.addEventListener('click', () => clearSiteCookies());
  els.ckEdgeSite.addEventListener('click', () => importEdgeCookies('site'));
  els.ckEdgeAll.addEventListener('click', () => importEdgeCookies('all'));

  /* ============================ 与主状态同步 ============================ */

  /** 标签切换后主动对一次账：抓包记录是按标签分开存的，跟随标签时要换一份数据 */
  async function refreshActive() {
    const res = await nyx.getToolboxState();
    if (!res || res.ok === false) return;
    if (res.sticky) {
      tb.sticky = res.sticky;
      syncEnvFromSticky();
    }
    if (!tb.open) return;
    if (res.wcId !== tb.wcId) {
      tb.wcId = res.wcId == null ? null : res.wcId;
      closeDetail();
      await loadRecords();
      await refreshStatus();
      // 保活是按标签存的，换标签要把显示与真实状态对齐
      await refreshMouseStatus(true);
      if (!els.paneVideo.hidden) scanVideo(true);
    }
  }

  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
      syncTimer = null;
      if (tb.open && els.netFollow.checked) refreshActive();
    }, 220);
  }

  nyx.onState(() => scheduleSync());
  nyx.onToolboxFeed(onFeed);
  // 站点图标异步就绪：只补画对应行，不重渲染（与地址栏建议共用主进程缓存）
  bindSiteIconPush();
  // 慢请求阈值以主进程为准：启动拉一次 + 订阅设置页的改动（v1.16.0）
  bindSlowMsPush();
  if (nyx.onToolboxPane) {
    nyx.onToolboxPane((payload) => {
      // 书签栏「管理」等入口：确保工具箱可见，再切到指定页签
      if (!payload || !payload.pane) return;
      if (!tb.open) {
        tb.open = true;
        els.root.hidden = false;
        els.detail.hidden = true;
        els.entry.classList.add('is-on');
        applyWidth(tb.width);
        nyx.setToolboxOpen({ open: true, width: tb.width });
        nyx.syncToolbox();
        tb.wcId = null;
        loadRecords();
        refreshStatus();
        refreshPageInfo();
      }
      switchPane(payload.pane);
    });
  }

  /* ============================ 初始化 ============================ */

  (async function init() {
    const state = await nyx.getToolboxState();
    if (state && state.ok) {
      tb.wcId = state.wcId == null ? null : state.wcId;
      tb.sticky = state.sticky || null;
    }

    const presets = await nyx.getToolboxPresets();
    if (presets && presets.ok) {
      tb.presets = {
        ua: presets.ua || [],
        device: presets.device || [],
        throttle: presets.throttle || [],
        rates: presets.rates || [],
        mouseGaps: presets.mouseGaps || [],
      };
      if (presets.sticky) tb.sticky = presets.sticky;
    }
    fillPresets();
    fillVideoPresets();
    syncEnvFromSticky();
    renderEnvNote();
    // 页签栏两端渐隐依赖真实宽度：字体就绪后再算一次，避免首屏用回退字体导致判定偏差
    updateNavFade();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => updateNavFade()).catch(() => {});
    }
  })();
})();
