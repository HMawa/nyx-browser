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
  // 加载失败页（A4）
  pageError: document.getElementById('page-error'),
  peCode: document.getElementById('pe-code'),
  peTitle: document.getElementById('pe-title'),
  peReason: document.getElementById('pe-reason'),
  peUrl: document.getElementById('pe-url'),
  peMode: document.getElementById('pe-mode'),
  peHintBlock: document.getElementById('pe-hint-block'),
  peHints: document.getElementById('pe-hints'),
  peRetry: document.getElementById('pe-retry'),
  peDiagnostics: document.getElementById('pe-diagnostics'),
  peCopy: document.getElementById('pe-copy'),
  peFoot: document.getElementById('pe-foot'),
};

/** 当前界面状态快照 */
let state = { mode: 'normal', activeId: null, maxTabs: 12, network: null, tabs: [] };

/** 星标当前对应的地址（缓存键，避免每次状态推送都问一次主进程） */
let starKey = '';

/** 失败页当前展示的原始失败对象（「复制详情」要用原始字段，不是渲染后的文案） */
let currentPageError = null;
/** 键盘切标签时记下"重渲染后焦点该落到哪个标签"，渲染完即清空 */
let pendingTabFocusId = '';

/** 渲染标签列表 */
function renderTabs() {
  els.tabs.textContent = '';

  const tabs = state.tabs || [];

  for (const tab of tabs) {
    const item = document.createElement('div');
    item.className = `tab${tab.active ? ' active' : ''}`;
    item.title = tab.url || tab.title;
    // 标签是"可切换的选项"，不是普通盒子：给读屏和键盘一条正规路径。
    // 焦点用游标式（roving tabindex）：只有当前标签能被 Tab 命中，
    // 组内用左右方向键移动，避免每加一个标签就多一次 Tab 停留。
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    item.setAttribute('aria-label', tab.title || '新标签页');
    item.dataset.tabId = String(tab.id);
    item.tabIndex = tab.active ? 0 : -1;

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
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `关闭标签：${tab.title || tab.url || '新标签页'}`);
    close.tabIndex = -1;
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.nyx.closeTab(tab.id);
    });
    item.appendChild(close);

    item.addEventListener('click', () => {
      if (!tab.active) window.nyx.activateTab(tab.id);
    });

    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (!tab.active) window.nyx.activateTab(tab.id);
        return;
      }
      // Delete / Backspace 关标签：和鼠标点 × 同一效果
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        window.nyx.closeTab(tab.id);
        return;
      }
      // 左右方向键在标签之间移动焦点，焦点落到哪个就切到哪个（浏览器通行做法）
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const index = tabs.indexOf(tab);
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const target = tabs[(index + step + tabs.length) % tabs.length];
        if (!target) return;
        // 切标签会整条重渲染，旧节点会被丢掉，焦点也就丢了：
        // 先记下"焦点该落在谁身上"，渲染完再补回去
        pendingTabFocusId = String(target.id);
        window.nyx.activateTab(target.id);
      }
    });

    els.tabs.appendChild(item);
  }

  // 键盘切标签后把焦点补回到新活动标签上，否则焦点会掉到 body 上，
  // 用户得重新 Tab 一遍才能继续操作
  if (pendingTabFocusId) {
    const node = els.tabs.querySelector(`.tab[data-tab-id="${pendingTabFocusId}"]`);
    pendingTabFocusId = '';
    if (node) node.focus();
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
  renderPageError();
  applyUiPrefs();
}

/* ---------------- 加载失败页（A4） ---------------- */

/**
 * 失败码 → 给用户的可执行建议。
 *
 * 只在"能说出下一步该怎么办"时才给建议：一句正确的废话（"请检查网络"）
 * 比没有建议更浪费时间，所以没收录的错误码宁可不显示提示列表。
 */
const ERROR_HINTS = new Map([
  ['ERR_NAME_NOT_RESOLVED', ['确认域名拼写正确（域名可能已经不存在）', '刚改过代理或 DNS 的话，等几秒再重试']],
  ['ERR_NAME_RESOLUTION_FAILED', ['确认域名拼写正确（域名可能已经不存在）', '刚改过代理或 DNS 的话，等几秒再重试']],
  ['ERR_CONNECTION_REFUSED', ['对方服务器没有在这个端口上提供服务（也可能已停机）', '如果是本机地址，确认对应程序已经启动']],
  ['ERR_CONNECTION_TIMED_OUT', ['对方没有在超时时间内响应，可能是线路问题或站点不可用', '开了代理的话，先在「网络与代理」里看看节点是否可用']],
  ['ERR_CONNECTION_RESET', ['连接被对方中断，可能是站点侧限制或链路抖动', '重试一次；持续如此建议换节点']],
  ['ERR_CONNECTION_CLOSED', ['连接建立后被对方关闭', '重试一次，或稍后再来']],
  ['ERR_INTERNET_DISCONNECTED', ['本机当前没有可用的网络连接', '确认网卡、Wi-Fi 或路由器状态']],
  ['ERR_PROXY_CONNECTION_FAILED', ['代理没有连上：内核未运行或端口不可达', '到「网络与代理」启动内核，或换一个节点']],
  ['ERR_TUNNEL_CONNECTION_FAILED', ['代理隧道建立失败，通常是节点拒绝了这次连接', '换一个节点，或在代理中心查看该节点的可用性']],
  ['ERR_CERT_AUTHORITY_INVALID', ['证书签发者不被信任，常见于自签名站点或中间人设备', '公共网站上出现这条提示就不要继续了']],
  ['ERR_CERT_COMMON_NAME_INVALID', ['证书和域名不匹配，可能是配置错误或有人冒用', '公共网站上出现这条提示就不要继续了']],
  ['ERR_CERT_DATE_INVALID', ['证书已过期或本机时间不对', '先确认系统时间准确']],
  ['ERR_SSL_PROTOCOL_ERROR', ['TLS 握手失败，对方可能不支持当前协议版本', '换用 https 站点或联系站点管理员']],
  ['ERR_EMPTY_RESPONSE', ['服务器没有返回任何内容就断开了连接', '重试一次；持续如此多半是站点问题']],
  ['ERR_BLOCKED_BY_CLIENT', ['这次请求被本机策略拦截了（可能来自扩展或防护规则）', '检查是否开启了拦截类设置']],
  ['ERR_ADDRESS_UNREACHABLE', ['目标地址在当前网络下不可达', '确认网络环境，或换一条出口链路']],
  ['ERR_ABORTED', ['加载被中断（通常是又发起了一次导航）', '重新点一次链接即可']],
]);

/** HTTP 状态码 → 可执行建议（网络层错误码之外的另一半：服务器是通的，只是拒绝了这次请求） */
function buildHttpHints(status) {
  const code = Number(status) || 0;
  if (code === 401) return ['这一页需要先登录', '登录该站点后再打开这个地址'];
  if (code === 403) return ['当前账号没有访问这一页的权限', '换一个有权限的账号，或从站点首页进入'];
  if (code === 404 || code === 410) {
    return ['确认地址有没有写错（少打一个字符也会这样）', '从站点首页或站内搜索重新进入这一页'];
  }
  if (code === 407) return ['代理要求先认证', '到「网络与代理」里检查代理的账号密码'];
  if (code === 429) return ['请求太频繁被站点限流了', '等一会儿再试，别连续刷新'];
  if (code === 451) return ['该页面因法律原因不可用', '这不是本机问题，换一个来源'];
  if (code >= 500) return ['站点自己出错了（不是本机或网络的问题）', '过一会儿再试，或稍后从站点首页进入'];
  if (code >= 400) return ['站点不接受这次请求', '从上一页重新进入这个链接试试'];
  return [];
}

/** 一次失败在界面上要呈现的全部内容（纯函数，便于回归脚本直接喂数据） */
function buildPageErrorView(err, mode) {
  const info = err || {};
  const hints = ERROR_HINTS.get(info.code) || (info.kind === 'http' ? buildHttpHints(info.status) : []);
  const tail = info.at ? new Date(info.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  return {
    code: info.code || 'ERR_FAILED',
    title: info.title || '这一页没能打开',
    reason: info.reason || '没有拿到可读的失败原因',
    url: info.url ? `地址：${info.url}` : '',
    mode: info.mode === 'private' ? '全隐私模式' : mode === 'private' ? '全隐私模式' : '普通模式',
    hints,
    foot: tail ? `这次失败已记入诊断日志（${tail}）` : '这次失败已记入诊断日志',
  };
}

/** 渲染加载失败页：没有失败态时整块隐藏 */
function renderPageError() {
  if (!els.pageError) return;
  const active = (state.tabs || []).find((tab) => tab.active);
  const err = active && active.loadError;

  if (!err) {
    if (!els.pageError.hidden) els.pageError.hidden = true;
    currentPageError = null;
    return;
  }

  currentPageError = err;
  const view = buildPageErrorView(err, state.mode);

  els.pageError.hidden = false;
  els.peCode.textContent = view.code;
  els.peTitle.textContent = view.title;
  els.peReason.textContent = view.reason;
  els.peUrl.textContent = view.url;
  els.peUrl.hidden = !view.url;
  els.peMode.textContent = view.mode;
  els.peFoot.textContent = view.foot;

  // 建议列表收在「可以试试」小标题下；没有建议时连标题一起收，不留空档
  const hintBlock = els.peHintBlock || els.peHints;
  if (view.hints.length > 0) {
    els.peHints.textContent = '';
    for (const hint of view.hints) {
      const li = document.createElement('li');
      li.textContent = hint;
      els.peHints.appendChild(li);
    }
    if (hintBlock) hintBlock.hidden = false;
  } else {
    els.peHints.textContent = '';
    if (hintBlock) hintBlock.hidden = true;
  }
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

/* 失败页按钮：重试 / 打开诊断 / 复制详情（A4） */
if (els.peRetry) {
  els.peRetry.addEventListener('click', async () => {
    els.peRetry.disabled = true;
    els.peFoot.textContent = '正在重试…';
    try {
      const result = await window.nyx.errorRetry();
      if (!result || !result.ok) {
        // 重试本身失败也要说出来，不能让按钮点完看起来什么都没发生
        els.peFoot.textContent = `重试没能发起：${(result && result.error) || '未知原因'}`;
      }
    } catch (err) {
      els.peFoot.textContent = `重试没能发起：${err.message}`;
    } finally {
      els.peRetry.disabled = false;
    }
  });
}

if (els.peDiagnostics) {
  els.peDiagnostics.addEventListener('click', () => {
    window.nyx.errorOpenDiagnostics();
  });
}

if (els.peCopy) {
  els.peCopy.addEventListener('click', async () => {
    const err = currentPageError;
    if (!err) return;
    const lines = [
      `Nyx 加载失败：${err.title || ''}（${err.code || ''}）`,
      `原因：${err.reason || ''}`,
      `地址：${err.url || ''}`,
      `模式：${err.mode === 'private' ? '全隐私模式' : '普通模式'}`,
      `错误码：${err.errorCode || err.code || ''}`,
      `时间：${err.at ? new Date(err.at).toLocaleString('zh-CN', { hour12: false }) : ''}`,
      `版本：${state.appVersion || '未知'}`,
    ];
    const result = await window.nyx.errorCopyDetail(lines.join('\n'));
    els.peFoot.textContent = result && result.ok ? '详情已复制到剪贴板' : `复制失败：${(result && result.error) || '未知原因'}`;
  });
}

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
