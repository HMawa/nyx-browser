'use strict';

/**
 * 渲染层逻辑：极简浏览器 UI。
 * 只通过 preload 暴露的 window.nyx 与主进程交互，不直接接触 Node / Electron API。
 */

const els = {
  tabs: document.getElementById('tabs'),
  newTab: document.getElementById('new-tab'),
  back: document.getElementById('btn-back'),
  forward: document.getElementById('btn-forward'),
  reload: document.getElementById('btn-reload'),
  address: document.getElementById('address'),
  bookmark: document.getElementById('btn-bookmark'),
  modeToggle: document.getElementById('mode-toggle'),
  modeLabel: document.getElementById('mode-label'),
  proxy: document.getElementById('btn-proxy'),
  linkBadge: document.getElementById('link-badge'),
  modeGroup: document.getElementById('mode-group'),
};

/** 当前界面状态快照 */
let state = { mode: 'normal', activeId: null, maxTabs: 12, network: null, tabs: [] };

/** 星标当前对应的地址（缓存键，避免每次状态推送都问一次主进程） */
let starKey = '';

/** 渲染标签列表 */
function renderTabs() {
  els.tabs.textContent = '';

  for (const tab of state.tabs) {
    const item = document.createElement('div');
    item.className = `tab${tab.active ? ' active' : ''}`;
    item.title = tab.url || tab.title;

    if (tab.loading) {
      const spinner = document.createElement('span');
      spinner.className = 'tab-spinner';
      item.appendChild(spinner);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || '新标签页';
    item.appendChild(title);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭标签';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.nyx.closeTab(tab.id);
    });
    item.appendChild(close);

    item.addEventListener('click', () => {
      if (!tab.active) window.nyx.activateTab(tab.id);
    });

    els.tabs.appendChild(item);
  }
}

/** 渲染工具栏（地址栏 + 前进后退可用状态） */
function renderToolbar() {
  const active = state.tabs.find((tab) => tab.active) || null;

  // 模式 / 激活标签变化后，地址栏建议的上下文已经不同：立即收起旧浮层，
  // 避免用户切了标签却看到上一个标签的历史建议
  const anchorKey = `${state.mode}|${active ? active.id : ''}`;
  if (anchorKey !== suggestAnchorKey) {
    suggestAnchorKey = anchorKey;
    if (typeof closeSuggest === 'function') closeSuggest();
  }

  // 星标：地址一变就重新算一次收藏状态（同 URL 不重复问主进程）
  const starUrl = active && active.url ? active.url : '';
  if (starUrl !== starKey) {
    starKey = starUrl;
    refreshBookmarkStar(active);
  }

  // 地址栏正在编辑时不覆盖用户输入
  if (document.activeElement !== els.address) {
    els.address.value = active ? active.url : '';
  }

  els.back.disabled = !active || !active.canGoBack;
  els.forward.disabled = !active || !active.canGoForward;

  const isPrivate = state.mode === 'private';
  els.modeToggle.setAttribute('aria-checked', isPrivate ? 'true' : 'false');
  els.modeLabel.textContent = isPrivate ? '全隐私模式' : '普通模式';
  document.body.classList.toggle('private-mode', isPrivate);

  renderLinkBadge();
}

/**
 * 渲染出站链路指示。
 *
 * 链路真相来自主进程（state.network.link），界面只做展示，不自行推断：
 * 隐私模式恒为"代理"，普通模式在代理不可用时为"直连"。
 */
function renderLinkBadge() {
  if (!els.linkBadge) return;

  const network = state.network || null;
  const link = network && network.link ? network.link : state.mode === 'private' ? 'proxy' : 'direct';
  const isProxy = link === 'proxy';

  els.linkBadge.textContent = isProxy ? '代理' : '直连';
  els.linkBadge.classList.toggle('link-proxy', isProxy);
  els.linkBadge.title = network
    ? `当前出站链路：${isProxy ? '代理' : '直连'}｜探测目标 ${network.host || '127.0.0.1'}:${
        network.port || '-'
      }${network.note ? `｜${network.note}` : ''}`
    : '当前出站链路';
}

function render() {
  renderTabs();
  renderToolbar();
  applyUiPrefs();
}

/**
 * 顶栏元素的显隐。
 *
 * 开关真相来自主进程（state.ui，由设置中心「外观」写入），界面只负责展示：
 * 用 hidden 类而非内联 style，避免被页面 CSP 的 style-src 拦截。
 */
function applyUiPrefs() {
  const ui = state.ui || { showLinkBadge: true, showModeSwitch: true };
  if (els.linkBadge) els.linkBadge.classList.toggle('hidden', ui.showLinkBadge === false);
  if (els.modeGroup) els.modeGroup.classList.toggle('hidden', ui.showModeSwitch === false);
}

/**
 * 主题：真相在主进程（ui.theme），渲染层只负责把 data-theme 写到 <html> 上，
 * 具体颜色由 theme-nyx.css 按 data-theme 分档接管。
 */
function applyTheme(snapshot) {
  const theme = (snapshot && snapshot.ui && snapshot.ui.theme) || 'ink';
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
}

/** 应用状态更新 */
function applyState(snapshot) {
  if (!snapshot) return;
  state = snapshot;
  render();
  applyTheme(snapshot);
}

/* ---------------- 事件绑定 ---------------- */

// 新建标签
// 新标签地址由主进程按「启动与主页」配置解析，这里不写死地址（空串 = 用配置的默认地址）
els.newTab.addEventListener('click', () => window.nyx.createTab(''));

// 前进 / 后退 / 刷新
els.back.addEventListener('click', () => window.nyx.goBack());
els.forward.addEventListener('click', () => window.nyx.goForward());
els.reload.addEventListener('click', () => window.nyx.reload());

/* ---------------- 地址栏历史建议（v1.3.0 新增） ---------------- */

/**
 * 输入停顿多久后才查一次建议（毫秒）。
 * 太短会在每次按键都算一遍（历史最多 5000 条，没必要），太长会有明显滞后感。
 */
const SUGGEST_DEBOUNCE_MS = 90;
/** 失焦后延迟多久收起浮层（毫秒）：给「点浮层条目」留出点击窗口 */
const SUGGEST_BLUR_CLOSE_MS = 180;

let suggestTimer = 0;
let suggestBlurTimer = 0;
/** 输入法是否正在组合（中文拼音等尚未上屏）：组合期间不查询、不响应回车与方向键 */
let imeComposing = false;
/** 当前建议高亮下标（-1 = 无）：Home/End 只在有高亮时才劫持 */
let suggestIndex = -1;
/** 建议锚点键（模式 + 激活标签）：锚点变化说明上下文变了，浮层必须收起 */
let suggestAnchorKey = '';

/** 读取地址栏左下角的屏幕坐标（与书签浮层同一套 getContentBounds 换算） */
async function suggestGeometry() {
  const bounds = await window.nyx.getContentBounds().catch(() => null);
  if (!bounds) return null;
  const rect = els.address.getBoundingClientRect();
  return {
    x: Math.round(bounds.x + rect.left),
    // 留 4px 间距，浮层不贴着地址栏
    y: Math.round(bounds.y + rect.bottom + 4),
    width: Math.round(rect.width),
  };
}

/** 收起建议浮层（清掉待执行的防抖 / 延时任务，避免收起后又弹出来） */
function closeSuggest() {
  window.clearTimeout(suggestTimer);
  window.clearTimeout(suggestBlurTimer);
  suggestIndex = -1;
  if (window.nyx.addressSuggestClose) window.nyx.addressSuggestClose();
}

/** 按当前输入内容查一次建议 */
async function querySuggest() {
  if (!window.nyx.addressSuggestQuery) return;
  const text = els.address.value;
  // 隐私模式不提供历史建议：历史在隐私模式不记录，展示普通模式积累的痕迹属于泄漏
  if (state.mode === 'private' || !text.trim()) {
    closeSuggest();
    return;
  }
  const geo = await suggestGeometry();
  if (!geo) return;
  suggestIndex = -1; // 新查询：高亮归零（主进程序列里默认也是不高亮）
  window.nyx.addressSuggestQuery({ text, ...geo });
}

// 输入 → 防抖查询
els.address.addEventListener('input', (event) => {
  // 输入法组合中（中文拼音/日文假名尚未上屏）不查询：
  // 组合期间的每次按键都会触发 input，查出来的是拼音字母，既闪屏又没意义。
  if (imeComposing || (event && event.isComposing)) {
    window.clearTimeout(suggestTimer);
    return;
  }
  window.clearTimeout(suggestBlurTimer);
  window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(() => {
    querySuggest();
  }, SUGGEST_DEBOUNCE_MS);
});

// 输入法组合开始 / 结束：结束时补一次查询，把上屏后的文字算进建议
els.address.addEventListener('compositionstart', () => {
  imeComposing = true;
  window.clearTimeout(suggestTimer);
});

els.address.addEventListener('compositionend', () => {
  imeComposing = false;
  window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(() => {
    querySuggest();
  }, SUGGEST_DEBOUNCE_MS);
});

// 失焦 → 延迟收起（点浮层条目时焦点可能先离开地址栏，这里的延时就是给它留的窗口）
els.address.addEventListener('blur', () => {
  window.clearTimeout(suggestBlurTimer);
  suggestBlurTimer = window.setTimeout(() => {
    if (window.nyx.addressSuggestClose) window.nyx.addressSuggestClose();
  }, SUGGEST_BLUR_CLOSE_MS);
});

// 地址栏回车导航 / 上下键选建议 / Esc 收起
els.address.addEventListener('keydown', async (event) => {
  // 输入法组合中：回车是「确认候选词」、方向键是「翻候选词」，
  // 这些键必须留给输入法，不能被地址栏导航或建议高亮吃掉
  if (event.isComposing || imeComposing) return;

  if (event.key === 'Escape') {
    closeSuggest();
    if (window.nyx.bookmarksFolderClose) window.nyx.bookmarksFolderClose();
    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!window.nyx.addressSuggestNav) return;
    const result = await window.nyx.addressSuggestNav(event.key === 'ArrowDown' ? 'down' : 'up');
    if (result && result.handled) {
      // 有建议项时把按键消化掉，避免光标在输入框里乱跳
      event.preventDefault();
      suggestIndex = result.index;
    }
    return;
  }

  // Home / End：v1.5.0 起，只有"已经有高亮项"时才劫持去跳首/末条；
  // 没有高亮时保持输入框移动光标的原生行为（不抢用户习惯）
  if ((event.key === 'Home' || event.key === 'End') && suggestIndex >= 0 && window.nyx.addressSuggestNav) {
    const result = await window.nyx.addressSuggestNav(event.key === 'Home' ? 'first' : 'last');
    if (result && result.handled) {
      event.preventDefault();
      suggestIndex = result.index;
    }
    return;
  }

  if (event.key !== 'Enter') return;

  // Ctrl / Cmd + Enter：新标签打开（v1.5.0）
  const newTab = !!(event.ctrlKey || event.metaKey);

  let target = '';
  if (window.nyx.addressSuggestNav) {
    const result = await window.nyx.addressSuggestNav('enter', { newTab });
    if (result && result.handled && result.url) target = result.url;
  }

  const value = target || els.address.value.trim();
  if (!value) return;
  if (newTab) {
    window.nyx.createTab(value);
  } else {
    window.nyx.navigate(value);
  }
  els.address.blur();
});

// 地址栏聚焦时全选，方便直接替换
els.address.addEventListener('focus', () => els.address.select());

// 浮层里点了某条建议：主进程已经发起导航，这里只同步地址栏显示
if (window.nyx.onAddressSuggestPicked) {
  window.nyx.onAddressSuggestPicked((payload) => {
    window.clearTimeout(suggestBlurTimer);
    window.clearTimeout(suggestTimer);
    if (payload && payload.url) els.address.value = payload.url;
    els.address.blur();
  });
}

/* ---------------- 工具栏星标（v1.4.0） ---------------- */

/** 判断某个地址是否允许收藏：只有普通网页（http/https）才有意义 */
function canBookmarkUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

/**
 * 刷新星标状态。
 * 主进程是唯一真相（书签可能存在别的窗口 / 工具箱里被改动），这里只做展示。
 */
async function refreshBookmarkStar(active) {
  if (!els.bookmark) return;
  const tab = active === undefined ? state.tabs.find((item) => item.active) || null : active;
  const url = tab && tab.url ? tab.url : '';

  if (!canBookmarkUrl(url)) {
    els.bookmark.disabled = true;
    els.bookmark.classList.remove('is-on');
    els.bookmark.textContent = '☆';
    els.bookmark.title = '当前页面不可收藏（仅支持网页）';
    return;
  }

  els.bookmark.disabled = false;
  const result = await window.nyx.bookmarksHas({ url }).catch(() => null);
  const on = !!(result && result.bookmarked);
  els.bookmark.classList.toggle('is-on', on);
  els.bookmark.textContent = on ? '★' : '☆';
  els.bookmark.title = on ? '已收藏（点击取消收藏）' : '收藏当前页';
}

// 星标点击：切换收藏状态；建议浮层若正开着，立刻重查一次让新收藏即时上榜（联动）
if (els.bookmark) {
  els.bookmark.addEventListener('click', async () => {
    // 长按已经弹过文件夹菜单：这次 click 是长按的尾巴，直接吞掉
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    const active = state.tabs.find((tab) => tab.active) || null;
    if (!active || !canBookmarkUrl(active.url)) return;

    els.bookmark.disabled = true;
    const result = await window.nyx.bookmarksToggle({ url: active.url, title: active.title || '' });
    els.bookmark.disabled = false;

    if (!result || result.ok === false) {
      showNotice({ level: 'warn', title: '收藏操作失败', message: (result && result.error) || '未知错误' });
      return;
    }

    starKey = active.url; // 已是最新状态，避免紧接着的状态推送再问一次
    await refreshBookmarkStar(active);

    // 联动：地址栏建议开着时重新查询，收藏状态变化会立刻反映到徽标与排序上
    if (window.nyx.addressSuggestQuery && els.address.value.trim() && document.activeElement === els.address) {
      querySuggest();
    }
  });
}

// 书签在别处被改动（工具箱 / 管理窗口 / 导入）时，星标同步刷新
if (window.nyx.onBookmarkChanged) {
  window.nyx.onBookmarkChanged(() => {
    starKey = '';
    refreshBookmarkStar();
  });
}

/* ---------------- 长按 / 右键星标：收藏到指定文件夹（v1.5.0） ---------------- */

/** 长按判定时长（毫秒）：太短会与普通点击打架，太长用户以为没反应 */
const LONG_PRESS_MS = 550;
let longPressTimer = 0;
/** 本次按压是否已经触发过长按（触发后要吞掉随后的 click，避免又走"收藏/取消"） */
let longPressFired = false;

/** 拿到星标按钮左下角的屏幕坐标，作为浮层锚点 */
async function bookmarkMenuAnchor() {
  const bounds = await window.nyx.getContentBounds().catch(() => null);
  if (!bounds) return null;
  const rect = els.bookmark.getBoundingClientRect();
  return { x: Math.round(bounds.x + rect.left), y: Math.round(bounds.y + rect.bottom) };
}

/** 打开「收藏到文件夹」浮层 */
async function openFolderMenu() {
  const active = state.tabs.find((tab) => tab.active) || null;
  if (!active || !canBookmarkUrl(active.url) || !window.nyx.bookmarksFolderMenu) return;
  const anchor = await bookmarkMenuAnchor();
  if (!anchor) return;
  const result = await window.nyx.bookmarksFolderMenu({
    x: anchor.x,
    y: anchor.y,
    url: active.url,
    title: active.title || '',
  });
  if (result && result.ok === false) {
    showNotice({ level: 'warn', title: '无法打开收藏菜单', message: result.error || '未知错误' });
  }
}

function cancelLongPress() {
  window.clearTimeout(longPressTimer);
  longPressTimer = 0;
  if (els.bookmark) els.bookmark.classList.remove('is-pressed');
}

if (els.bookmark) {
  // 右键：立即弹出文件夹选择
  els.bookmark.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    cancelLongPress();
    openFolderMenu();
  });

  // 长按：按住 550ms 弹出；松手 / 移出 / 取消都复位
  els.bookmark.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    longPressFired = false;
    cancelLongPress();
    els.bookmark.classList.add('is-pressed');
    longPressTimer = window.setTimeout(() => {
      longPressFired = true;
      cancelLongPress();
      openFolderMenu();
    }, LONG_PRESS_MS);
  });

  els.bookmark.addEventListener('pointerup', cancelLongPress);
  els.bookmark.addEventListener('pointerleave', cancelLongPress);
  els.bookmark.addEventListener('pointercancel', cancelLongPress);
}

// 全局 Esc：收起建议浮层与收藏菜单（两者都是"浮起来的东西"，一起收最符合直觉）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (window.nyx.addressSuggestClose) window.nyx.addressSuggestClose();
  if (window.nyx.bookmarksFolderClose) window.nyx.bookmarksFolderClose();
});

// 设置：独立窗口，不占用标签额度（原「代理中心」已整页并入设置「网络与代理」）
els.proxy.addEventListener('click', () => window.nyx.openSettings());

// 模式切换
els.modeToggle.addEventListener('click', async () => {
  const next = state.mode === 'private' ? 'normal' : 'private';
  const result = await window.nyx.switchMode(next);

  // 切换被拒绝（如代理不可达）：把开关回滚为真实状态，提示由主进程 nyx:notice 推送
  if (!result || result.ok === false) {
    if (result && result.state) applyState(result.state);
    return;
  }

  applyState(result.state);
});

/* ---------------- 用户提示（toast） ---------------- */

/** 同一提示在短时间内的重复推送会被合并，避免多入口重复弹窗 */
const NOTICE_DEDUP_MS = 800;
let lastNoticeKey = '';
let lastNoticeAt = 0;

function showNotice(notice) {
  if (!notice || !notice.message) return;

  const key = `${notice.level || 'info'}|${notice.title || ''}|${notice.message}`;
  const now = Date.now();
  if (key === lastNoticeKey && now - lastNoticeAt < NOTICE_DEDUP_MS) return;
  lastNoticeKey = key;
  lastNoticeAt = now;

  const box = document.createElement('div');
  box.className = `notice notice-${notice.level || 'info'}`;
  box.setAttribute('role', 'alert');

  const head = document.createElement('div');
  head.className = 'notice-head';

  const title = document.createElement('strong');
  title.className = 'notice-title';
  title.textContent = notice.title || '提示';
  head.appendChild(title);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notice-close';
  close.textContent = '×';
  close.title = '关闭提示';
  close.addEventListener('click', () => box.remove());
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'notice-body';
  body.textContent = notice.message;

  box.appendChild(head);
  box.appendChild(body);
  document.body.appendChild(box);

  // 10 秒后自动收起，用户也可手动关闭
  window.setTimeout(() => box.remove(), 10000);
}

/* ---------------- 初始化 ---------------- */

window.nyx.onState(applyState);
window.nyx.onNotice(showNotice);
window.nyx.getState().then(applyState);
