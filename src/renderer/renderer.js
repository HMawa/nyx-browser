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
  // 下载中心入口（A1）
  downloads: document.getElementById('btn-downloads'),
  dlBadge: document.getElementById('dl-badge'),
  dlBadgeLabel: document.getElementById('dl-badge-label'),
  // agent 急停（D）
  agentStop: document.getElementById('btn-agent-stop'),
  agentStopDot: document.getElementById('agent-stop-dot'),
  agentStopText: document.getElementById('agent-stop-text'),
  // agent 接入模式（A）：外部接入时这条标识常驻
  agentModeFlag: document.getElementById('agent-mode-flag'),
  agentModeText: document.getElementById('agent-mode-text'),
  // agent 状态灯与窄面板（A5）
  agentLamp: document.getElementById('btn-agent-lamp'),
  agentLampDot: document.getElementById('agent-lamp-dot'),
  agentPanel: document.getElementById('agent-panel'),
  agentPanelLamp: document.getElementById('agent-panel-lamp'),
  agentPanelTitle: document.getElementById('agent-panel-title'),
  agentPanelText: document.getElementById('agent-panel-text'),
  agentPanelList: document.getElementById('agent-panel-list'),
  agentPanelClose: document.getElementById('agent-panel-close'),
  agentPanelStop: document.getElementById('agent-panel-stop'),
  agentPanelSettings: document.getElementById('agent-panel-settings'),
  // 断网提示（G 离线/在线）
  netOfflineFlag: document.getElementById('net-offline-flag'),
  netOfflineText: document.getElementById('net-offline-text'),
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
  peCached: document.getElementById('pe-cached'),
  peCachedLabel: document.getElementById('pe-cached-label'),
  peCachedNote: document.getElementById('pe-cached-note'),
  peCachedText: document.getElementById('pe-cached-text'),
  peCachedBlocks: document.getElementById('pe-cached-blocks'),
  // 页面摘要侧栏（F）：纯抽取式，默认关；入口在「更多」菜单里（清单 B1）
  btnDigest: document.getElementById('more-digest'),
  digestPanel: document.getElementById('digest-panel'),
  digestEnabled: document.getElementById('digest-enabled'),
  digestClose: document.getElementById('digest-close'),
  digestRun: document.getElementById('digest-run'),
  digestCopy: document.getElementById('digest-copy'),
  digestExport: document.getElementById('digest-export'),
  digestExportCsv: document.getElementById('digest-export-csv'),
  digestStatus: document.getElementById('digest-status'),
  digestBody: document.getElementById('digest-body'),
  // 工具栏「更多」（清单 B1）：主路径之外的四个动作收在这里
  btnMore: document.getElementById('btn-more'),
  moreMenu: document.getElementById('more-menu'),
  moreScreenshot: document.getElementById('more-screenshot'),
  moreExtensions: document.getElementById('more-extensions'),
  moreProxy: document.getElementById('more-proxy'),
  toolbarLabels: [
    document.getElementById('new-tab-label'),
    document.getElementById('downloads-label'),
    document.getElementById('toolbox-label'),
    document.getElementById('more-label'),
  ].filter(Boolean),
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
    // 休眠标签淡显 + 标题后缀（清单 G）：点一下会按原地址重新加载，不是死链
    item.className = `tab${tab.active ? ' active' : ''}${tab.asleep ? ' is-asleep' : ''}`;
    item.title = tab.asleep
      ? `${tab.url || tab.title}\n已休眠（已释放内存，点一下按原地址重新加载）`
      : tab.url || tab.title;
    // 标签是"可切换的选项"，不是普通盒子：给读屏和键盘一条正规路径。
    // 焦点用游标式（roving tabindex）：只有当前标签能被 Tab 命中，
    // 组内用左右方向键移动，避免每加一个标签就多一次 Tab 停留。
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', tab.active ? 'true' : 'false');
    item.setAttribute('aria-label', `${tab.title || '新标签页'}${tab.asleep ? '（已休眠）' : ''}`);
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
/**
 * 隐私开关的文案（清单 B2）。
 *
 * 做成纯函数是为了能被回归脚本直接调：contextBridge 暴露的 window.nyx 是冻结代理，
 * 测试没法给它打桩，只能把"文案与说明"这类纯逻辑抽出来单独验。
 * 说明里必须写清隐私模式的三件事——不写历史、不留缓存、强制走代理，
 * 否则用户看到的只是一个不知道开没开的开关。
 */
function describeModeSwitch(mode) {
  const isPrivate = mode === 'private';
  if (isPrivate) {
    return {
      label: '全隐私模式',
      hint: '当前是全隐私模式：不写浏览历史、不保存缓存与 Cookie、所有请求强制走代理。点一下回到普通模式。',
      ariaLabel: '全隐私模式开关，当前已开启：不写历史、不留缓存、强制走代理',
    };
  }
  return {
    label: '普通模式',
    hint: '当前是普通模式：会保存历史与缓存，可直连或经代理。点一下切到全隐私模式（不写历史、不留缓存、强制走代理）。',
    ariaLabel: '全隐私模式开关，当前已关闭：会保留历史与缓存',
  };
}

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
  const modeText = describeModeSwitch(state.mode);
  els.modeToggle.setAttribute('aria-checked', isPrivate ? 'true' : 'false');
  // 悬停说明必须写清"切过去会发生什么"（清单 B2：禁历史/禁缓存/走代理），
  // 原来的 title 只有"切换隐私模式"四个字，等于没有说明。
  els.modeToggle.title = modeText.hint;
  els.modeToggle.setAttribute('aria-label', modeText.ariaLabel);
  els.modeLabel.textContent = modeText.label;
  els.modeLabel.title = modeText.hint;
  document.body.classList.toggle('private-mode', isPrivate);

  renderLinkBadge();
}

/**
 * 渲染出站链路指示。
 *
 * 链路真相来自主进程（state.network.link），界面只做展示，不自行推断：
 * 隐私模式恒为"代理"，普通模式在代理不可用时为"直连"。
 */
/**
 * 出站链路徽标文案（B3）。抽成纯函数，回归脚本可以直接喂取值验证，
 * 不用去猜渲染结果。
 *
 * 隐私模式 + 直连 = 用户显式选的「真实 IP」：必须一眼看出来，
 * 所以文字改成「真实 IP」并带上危险色类，不能再含糊地写「直连」。
 */
function describeLinkBadge(mode, link) {
  const isPrivate = mode === 'private';
  const value = link === 'proxy' ? 'proxy' : 'direct';

  if (isPrivate && value === 'direct') {
    return {
      text: '真实 IP',
      cls: 'link-real-ip',
      title: '隐私模式正在直连：站点能看到你的真实公网 IP（你在设置里显式选择了「真实 IP」）',
    };
  }

  return {
    text: value === 'proxy' ? '代理' : '直连',
    cls: value === 'proxy' ? 'link-proxy' : 'link-direct',
    title: '',
  };
}

function renderLinkBadge() {
  if (!els.linkBadge) return;

  const network = state.network || null;
  const link = network && network.link ? network.link : state.mode === 'private' ? 'proxy' : 'direct';
  const badge = describeLinkBadge(state.mode, link);

  els.linkBadge.textContent = badge.text;
  els.linkBadge.classList.toggle('link-proxy', badge.cls === 'link-proxy');
  els.linkBadge.classList.toggle('link-real-ip', badge.cls === 'link-real-ip');
  els.linkBadge.title = network
    ? `${badge.title || '当前出站链路'}｜探测目标 ${network.host || '127.0.0.1'}:${
        network.port || '-'
      }${network.note ? `｜${network.note}` : ''}`
    : badge.title || '当前出站链路';
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
    cachedPageFor = '';
    hideCachedPage();
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

  // 注意：view.url 是给人看的（带「地址：」前缀），查缓存必须用原始 err.url。
  loadCachedPage(err.url);
}

/** 缓存内容按地址取一次；同一地址只请求一次，避免每次状态推送都打接口。 */
let cachedPageFor = '';
function loadCachedPage(url) {
  if (!els.peCached || !window.nyx || !window.nyx.errorCachedPage) return;
  const key = String(url || '');
  if (!key) {
    hideCachedPage();
    return;
  }
  if (key === cachedPageFor) return;
  cachedPageFor = key;
  hideCachedPage();
  window.nyx.errorCachedPage({ url: key })
    .then((res) => {
      if (!res || res.available !== true) return;
      if (cachedPageFor !== key) return; // 已经切到别的失败页，丢弃这次结果
      els.peCachedNote.textContent = res.note || '';
      renderCachedBlocks(res);
      const when = res.ageText ? `（${res.ageText}抓取` : '';
      // 隐私模式的快照是加密存的，界面上要说清楚来源，别让人以为是普通缓存
      const suffix = res.encrypted ? (when ? '，加密快照）' : '（加密快照）') : when ? '）' : '';
      els.peCachedLabel.textContent = `上次读到的内容${when}${suffix}`;
      els.peCached.hidden = false;
    })
    .catch((err) => {
      console.warn('[Nyx] 离线缓存读取失败：', err && err.message ? err.message : err);
      hideCachedPage();
    });
}

/**
 * 渲染离线快照。
 *
 * v2 快照带块类型，断网页就按标题/段落/列表/引用/代码排出来——
 * 这就是「快照支持样式」的落地方式：搬结构不搬 CSS（存别人的 CSS 既不可靠也没必要）。
 * 图片只显示 alt：我们不把图片二进制抓到本地磁盘，界面上必须说实话。
 */
function renderCachedBlocks(res) {
  if (!els.peCachedBlocks || !els.peCachedText) return;
  const blocks = Array.isArray(res && res.blocks) ? res.blocks : [];
  const images = Array.isArray(res && res.images) ? res.images : [];
  els.peCachedBlocks.replaceChildren();
  if (!blocks.length) {
    els.peCachedBlocks.hidden = true;
    els.peCachedText.hidden = false;
    els.peCachedText.textContent = (res && res.text) || '';
    return;
  }
  els.peCachedText.hidden = true;
  els.peCachedBlocks.hidden = false;
  for (const block of blocks) {
    const type = String((block && block.type) || 'para');
    const text = String((block && block.text) || '');
    if (!text) continue;
    if (type === 'list') {
      const item = document.createElement('p');
      item.className = 'pe-cached-p pe-cached-list';
      item.textContent = text;
      els.peCachedBlocks.appendChild(item);
      continue;
    }
    if (type === 'heading') {
      const heading = document.createElement('p');
      heading.className = 'pe-cached-h';
      heading.textContent = text;
      els.peCachedBlocks.appendChild(heading);
      continue;
    }
    const para = document.createElement(type === 'code' ? 'pre' : 'p');
    para.className = `pe-cached-p pe-cached-${type}`;
    para.textContent = text;
    els.peCachedBlocks.appendChild(para);
  }
  if (images.length) {
    // 有本体就画出来，没有就只能给一句说明（候选②）。
    const withBytes = images.filter((image) => image && typeof image.dataUrl === 'string' && image.dataUrl);
    const note = document.createElement('p');
    note.className = 'pe-cached-img-note';
    note.textContent = withBytes.length
      ? `这一页有 ${images.length} 张图，其中 ${withBytes.length} 张存了本地副本（只有小图，单张不超过 120 KB）。`
      : `这一页有 ${images.length} 张图片；离线快照只保留图片说明，不保存图片本身。`;
    els.peCachedBlocks.appendChild(note);
    for (const image of images) {
      if (image && typeof image.dataUrl === 'string' && image.dataUrl) {
        const figure = document.createElement('figure');
        figure.className = 'pe-cached-figure';
        const img = document.createElement('img');
        img.className = 'pe-cached-img-real';
        img.src = image.dataUrl;
        img.alt = (image && image.alt) || '离线快照里的图片';
        img.loading = 'lazy';
        figure.appendChild(img);
        if (image.alt) {
          const caption = document.createElement('figcaption');
          caption.className = 'pe-cached-caption';
          caption.textContent = image.alt;
          figure.appendChild(caption);
        }
        els.peCachedBlocks.appendChild(figure);
        continue;
      }
      const slot = document.createElement('p');
      slot.className = 'pe-cached-img';
      slot.textContent = `［图片］${(image && image.alt) || ''}`;
      els.peCachedBlocks.appendChild(slot);
    }
  }
}

function hideCachedPage() {
  if (!els.peCached) return;
  els.peCached.hidden = true;
  if (els.peCachedNote) els.peCachedNote.textContent = '';
  if (els.peCachedText) {
    els.peCachedText.textContent = '';
    els.peCachedText.hidden = false;
  }
  if (els.peCachedBlocks) {
    els.peCachedBlocks.replaceChildren();
    els.peCachedBlocks.hidden = true;
  }
}

/**
 * 顶栏元素的显隐。
 *
 * 开关真相来自主进程（state.ui，由设置中心「外观」写入），界面只负责展示：
 * 用 hidden 类而非内联 style，避免被页面 CSP 的 style-src 拦截。
 */
function applyUiPrefs() {
  const ui = state.ui || { showLinkBadge: true, showModeSwitch: true, toolbarLabels: true };
  if (els.linkBadge) els.linkBadge.classList.toggle('hidden', ui.showLinkBadge === false);
  if (els.modeGroup) els.modeGroup.classList.toggle('hidden', ui.showModeSwitch === false);
  // 按钮小字（清单 B1）：默认显示，认得出图标的人可以在外观里关掉
  const showLabels = ui.toolbarLabels !== false;
  for (const label of els.toolbarLabels || []) label.hidden = !showLabels;
  document.documentElement.classList.toggle('tb-labels', showLabels);
  applyMotionPrefs(ui);
  applyFontScale(ui);
}

/**
 * 界面字号档位（清单 D3 遗留项）。
 * 样式侧所有 font-size 都是 calc(Npx * var(--font-scale))，这里只把倍数写到根元素上；
 * 倍率的唯一来源是 src/core/font-scale.js（主进程给 snapshot，界面上不另写一份数字）。
 */
function applyFontScale(ui) {
  const root = document.documentElement;
  if (!root) return;
  const key = (ui && ui.fontScale) || 'normal';
  const factor = (window.nyx && window.nyx.fontScaleFactor) ? window.nyx.fontScaleFactor(key) : 1;
  root.style.setProperty('--font-scale', String(factor));
  root.dataset.fontScale = key;
}

/**
 * 动效档位（清单 B2）。
 * 三件事：① 把 --motion-ms / --motion-ease / --motion-press 写到根元素上（样式侧只读变量）；
 * ② 用 data-motion 标出当前档，便于细调个别组件；③ 系统要求减少动效时不看用户选了什么。
 */
function applyMotionPrefs(ui) {
  const root = document.documentElement;
  if (!root) return;
  const level = (ui && ui.motionLevel) || 'calm';
  const reducedMotion = prefersReducedMotion();
  // 时长与缓动的唯一来源是 src/core/motion.js，界面侧不另写一份数字
  const motion = (window.nyx && window.nyx.motionResolve)
    ? window.nyx.motionResolve({ level, reducedMotion })
    : { level: reducedMotion ? 'calm' : level, durationMs: 150, easing: 'ease', press: 'none', reduced: reducedMotion };
  root.style.setProperty('--motion-ms', `${motion.durationMs}ms`);
  root.style.setProperty('--motion-ease', motion.easing);
  root.style.setProperty('--motion-press', motion.press || 'none');
  root.dataset.motion = motion.level;
  root.classList.toggle('motion-reduced', Boolean(motion.reduced));
}

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
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

/* ---------------- 下载中心（清单 A1） ---------------- */

/** 工具栏下载入口：点开下载中心窗口；有进行中/失败时角标给出数量 */
function applyDownloadsBadge(payload) {
  if (!els.dlBadge) return;
  const summary = (payload && payload.summary) || { active: 0, failed: 0 };
  const active = Number(summary.active) || 0;
  const failed = Number(summary.failed) || 0;
  const total = active + failed;
  els.dlBadge.hidden = total <= 0;
  els.dlBadge.textContent = String(total);
  els.dlBadge.classList.toggle('has-failed', failed > 0);
  if (els.dlBadgeLabel) {
    els.dlBadgeLabel.textContent = total > 0 ? `${active} 项进行中，${failed} 项失败` : '';
  }
  if (els.downloads) {
    els.downloads.title = total > 0 ? `下载中心（${active} 进行中 / ${failed} 失败）` : '下载中心（Ctrl+J）';
  }
}

if (els.downloads) {
  els.downloads.addEventListener('click', () => window.nyx.openDownloads());
}

if (window.nyx.onDownloadsState) {
  window.nyx.onDownloadsState(applyDownloadsBadge);
}
// 首屏同步一次：角标不能等第一次下载事件才出现
if (window.nyx.listDownloads) {
  window.nyx.listDownloads().then((res) => {
    if (res && res.ok) applyDownloadsBadge({ summary: res.summary });
  });
}

/* ---------------- agent 急停（清单 D） ---------------- */

/**
 * 工具栏上的常驻刹车。
 *
 * 要求（清单 D）：入口必须是「全局热键 + 主界面常驻按钮」，不能藏在菜单里。
 * 这里的按钮在任何模式下都可见，状态由主进程推送，避免界面自己猜。
 */
function applyAgentStatus(payload) {
  if (!els.agentStop) return;
  const stopped = Boolean(payload && payload.stopped);
  const shortcut = (payload && payload.stopShortcut) || '';
  els.agentStop.classList.toggle('is-stopped', stopped);
  if (els.agentStopDot) els.agentStopDot.setAttribute('aria-hidden', 'true');
  if (els.agentStopText) els.agentStopText.textContent = stopped ? 'agent 已停' : 'agent 停止';
  const keyHint = shortcut ? `（${shortcut}）` : '';
  els.agentStop.title = stopped
    ? `agent 已停止：${(payload && payload.stopReason) || '手动停止'}。点击恢复`
    : `停止 agent 操作${keyHint}`;
  els.agentStop.setAttribute('aria-label', stopped ? 'agent 已停止，点击恢复' : '停止 agent 操作');
  els.agentStop.setAttribute('aria-pressed', stopped ? 'true' : 'false');
  const audit = (payload && payload.audit) || null;
  if (audit && typeof audit.kept === 'number' && els.agentStop.dataset) {
    els.agentStop.dataset.auditKept = String(audit.kept);
  }
  applyAgentModeFlag(payload && payload.modeInfo);
  applyAgentLamp(payload && payload.lamp);
}

/**
 * 三色状态灯（清单 A5）。
 *
 * 只回答一个问题：现在有没有人正在动这个浏览器。所以
 * 灰 = 没接入（接口关着或已紧急停止）、金 = 接入了但空闲、红 = 有动作正在执行。
 * 点灯打开窄面板，看最近动作与就地急停。
 */
function applyAgentLamp(lamp) {
  const info = lamp || null;
  const level = info && info.level ? info.level : 'off';
  if (els.agentLampDot) els.agentLampDot.className = `agent-lamp-dot is-${level}`;
  if (!els.agentLamp) return;
  els.agentLamp.dataset.level = level;
  els.agentLamp.title = `agent 状态：${(info && info.label) || '没有 agent 接入'}`;
  els.agentLamp.setAttribute('aria-label', els.agentLamp.title);
}

/**
 * 接入模式的常驻标识（清单 A）。
 *
 * 外部接入（CDP）时审计只看得到"经过浏览器"的部分，这件事必须一直摆在窗口上，
 * 而不是切换时弹一次提示就完了——用户随时能看见"现在是哪种模式、审计缺了多少"。
 */
function applyAgentModeFlag(modeInfo) {
  if (!els.agentModeFlag) return;
  const info = modeInfo || null;
  const incomplete = Boolean(info) && info.auditComplete === false;
  els.agentModeFlag.hidden = !incomplete;
  if (!incomplete) {
    els.agentModeFlag.removeAttribute('title');
    return;
  }
  if (els.agentModeText) els.agentModeText.textContent = info.banner || '审计不完整';
  const pending = info.restartRequired === true;
  els.agentModeFlag.title = pending
    ? '当前是外部接入模式（重启后才完全生效）：审计只覆盖经过浏览器的部分，站点授权与动作级确认管不到 CDP 的内部调用。'
    : '当前是外部接入模式：审计只覆盖经过浏览器的部分，站点授权与动作级确认管不到 CDP 的内部调用。';
}

/**
 * 断网横幅（G 的离线/在线部分）。
 *
 * 只做一件事：把"是断网，不是代理坏了"说清楚。链路状态由主进程保证不动
 * （见 link-guard 的 offline 分支），界面这边不许自己推测、也不许顺手提示
 * "已切换直连"这类会让用户误判的文案。
 */
function applyNetState(payload) {
  if (!els.netOfflineFlag) return;
  const info = payload && typeof payload === 'object' ? payload : null;
  const visible = Boolean(info) && info.visible === true;
  els.netOfflineFlag.hidden = !visible;
  if (!visible) {
    els.netOfflineFlag.removeAttribute('title');
    return;
  }
  if (els.netOfflineText) els.netOfflineText.textContent = info.text || '当前离线';
  els.netOfflineFlag.title = info.title || '整机没有网络：页面打不开是网络断了，不是代理坏了。';
}

async function refreshNetState() {
  try {
    const res = await window.nyx.netState();
    if (res && res.ok) applyNetState(res);
  } catch (err) {
    // 读不到在线状态：不弹错误（用户正在断网时最不需要的就是再多一个错误框），
    // 只在控制台留痕，横幅保持原样。
    console.warn('[Nyx] 读取网络状态失败：', String(err && err.message ? err.message : err));
  }
}

async function toggleAgentStop() {
  if (!els.agentStop) return;
  const stopped = els.agentStop.classList.contains('is-stopped');
  els.agentStop.disabled = true;
  try {
    const res = stopped
      ? await window.nyx.agentResume()
      : await window.nyx.agentStop('工具栏按钮紧急停止');
    if (res && res.ok === false) {
      showNotice({ level: 'warn', title: '没能切换 agent 状态', message: res.error || '未知原因' });
    } else {
      // 不要自己拼一份状态：再拉一次权威快照，避免界面与主进程不一致
      const fresh = await window.nyx.agentStatus();
      if (fresh && fresh.ok) applyAgentStatus(fresh);
    }
  } catch (err) {
    showNotice({ level: 'warn', title: '没能切换 agent 状态', message: String(err && err.message ? err.message : err) });
  } finally {
    els.agentStop.disabled = false;
  }
}

if (els.agentStop) {
  els.agentStop.addEventListener('click', () => {
    toggleAgentStop();
  });
}

if (window.nyx.onAgentStatus) {
  window.nyx.onAgentStatus(applyAgentStatus);
}
if (window.nyx.agentStatus) {
  window.nyx.agentStatus().then((res) => {
    if (res && res.ok) applyAgentStatus(res);
  });
}

// 断网横幅（G 离线/在线）：系统网络状态可能随时变，两个方向都要听
window.addEventListener('online', () => { refreshNetState(); });
window.addEventListener('offline', () => { refreshNetState(); });
if (window.nyx.netState) refreshNetState();

/* ------------------------------------------------------------------ */
/* 页面摘要侧栏（清单 F）                                              */
/* 纯抽取式：只把页面原文里的句子挑出来，不调用任何生成式接口。        */
/* 抓包摘要一起给——"页面显示成功、接口其实 500"是最容易被骗的地方。  */
/* ------------------------------------------------------------------ */

/** 上一次生成的纯文本（复制用），为空时说明还没生成过 */
let lastDigestText = '';
let lastDigestPayload = null;

function setDigestStatus(text, kind) {
  if (!els.digestStatus) return;
  els.digestStatus.textContent = text || '';
  els.digestStatus.className = `digest-status${kind ? ` is-${kind}` : ''}`;
}

function buildDigestBlock(title, lines, extraClass) {
  const block = document.createElement('div');
  block.className = `digest-block${extraClass ? ` ${extraClass}` : ''}`;
  const heading = document.createElement('h3');
  heading.textContent = title;
  block.appendChild(heading);
  const list = document.createElement('ul');
  for (const line of lines) {
    const item = document.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  }
  block.appendChild(list);
  return block;
}

/**
 * 「被拦下的请求」块（候选④）。
 *
 * 之前这里只有一行拼起来的文字，看到「被拦下 3 个」也只能干看着。
 * 现在每个站点是一个按钮：点一下把域名交给工具箱的抓包页当过滤条件，
 * 顺手把摘要面板收起来，让用户直接看到那些请求。
 * 注意用自定义事件而不是直接调 toolbox-ui 的函数：两个脚本同页但互不依赖，
 * 谁先加载都不会炸，测试也能直接 dispatchEvent 验。
 */
function buildBlockedBlock(hosts) {
  const block = document.createElement('div');
  block.className = 'digest-block digest-blocked';
  const heading = document.createElement('h3');
  heading.textContent = `被拦下的站点（${hosts.length} 个）`;
  block.appendChild(heading);
  const list = document.createElement('ul');
  list.className = 'digest-blocked-list';
  for (const item of hosts) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'digest-blocked-btn';
    btn.dataset.host = item.host;
    btn.textContent = `${item.host}（${item.count} 次，${item.reason}）`;
    btn.title = '在工具箱的抓包页按这个域名筛出来';
    btn.setAttribute('aria-label', `在工具箱里筛出 ${item.host} 的被拦下请求`);
    btn.addEventListener('click', () => focusNetInToolbox(item.host));
    li.appendChild(btn);
    list.appendChild(li);
  }
  block.appendChild(list);
  const hint = document.createElement('p');
  hint.className = 'digest-blocked-hint';
  hint.textContent = '被拦下不等于网站坏了：可能是广告、追踪器，也可能是你以为该在的东西——点一条自己看。';
  block.appendChild(hint);
  return block;
}

/** 把过滤条件交给工具箱（工具箱那边监听这个事件：切到抓包页 + 填搜索框） */
function focusNetInToolbox(host) {
  const query = String(host || '').trim();
  if (!query) return;
  window.dispatchEvent(new CustomEvent('nyx:toolbox-focus-net', { detail: { query } }));
  if (els.digestPanel) els.digestPanel.hidden = true;
}

function buildDigestMeta(page) {
  const block = document.createElement('div');
  block.className = 'digest-block';
  const heading = document.createElement('h3');
  heading.textContent = '来源';
  block.appendChild(heading);
  const title = document.createElement('p');
  title.textContent = page.title || '（没有标题）';
  title.style.margin = '0 0 4px';
  block.appendChild(title);
  const url = document.createElement('p');
  url.className = 'digest-url';
  url.textContent = page.url || '';
  url.style.margin = '0';
  url.style.wordBreak = 'break-all';
  url.style.color = 'var(--text-faint)';
  url.style.fontSize = '11px';
  block.appendChild(url);
  return block;
}

/** 把一次摘要结果画到侧栏上 */
function renderDigest(payload) {
  if (!els.digestBody) return;
  els.digestBody.textContent = '';
  lastDigestText = payload && typeof payload.text === 'string' ? payload.text : '';
  // 导出的 Markdown 要用整份 payload 重新排版（和复制共用同一次抽取结果）
  lastDigestPayload = payload && typeof payload === 'object' ? payload : null;

  const page = (payload && payload.page) || null;
  const network = (payload && payload.network) || null;

  if (page) {
    els.digestBody.appendChild(buildDigestMeta(page));
    if (Array.isArray(page.headings) && page.headings.length) {
      els.digestBody.appendChild(buildDigestBlock('小标题', page.headings.slice(0, 6)));
    }
    if (Array.isArray(page.bullets) && page.bullets.length) {
      els.digestBody.appendChild(buildDigestBlock('摘要（抽取自页面原文）', page.bullets));
    }
    if (Array.isArray(page.keywords) && page.keywords.length) {
      const block = document.createElement('div');
      block.className = 'digest-block';
      const heading = document.createElement('h3');
      heading.textContent = '关键词';
      block.appendChild(heading);
      const line = document.createElement('p');
      line.textContent = page.keywords.map((item) => (item && item.word) || item).join(' · ');
      line.style.margin = '0';
      line.style.color = 'var(--text-dim)';
      block.appendChild(line);
      els.digestBody.appendChild(block);
    }
  }

  if (network) {
    const blocked = Number(network.blocked) || 0;
    const lines = [
      blocked > 0
        ? `${network.total} 个请求，失败 ${network.failed} 个，被拦下 ${blocked} 个`
        : `${network.total} 个请求，失败 ${network.failed} 个`,
    ];
    if (Array.isArray(network.hosts) && network.hosts.length) {
      lines.push(`主要域名：${network.hosts.map((h) => `${h.host}（${h.count}）`).join('、')}`);
    }
    if (Array.isArray(network.apis) && network.apis.length) {
      lines.push(`主要接口：${network.apis.map((a) => `${a.key}（${a.count}）`).join('、')}`);
    }
    if (Array.isArray(network.blockedHosts) && network.blockedHosts.length) {
      lines.push('被拦下的站点见下方，点一条就能在工具箱里筛出来');
    }
    const block = buildDigestBlock(
      network.missing ? '网络（这次没取到抓包记录）' : '网络',
      lines,
      network.warning ? 'warn' : '',
    );
    if (network.warning) {
      const warn = document.createElement('p');
      warn.textContent = network.warning;
      warn.style.margin = '6px 0 0';
      block.appendChild(warn);
    }
    els.digestBody.appendChild(block);
    // 候选④：「被拦下」单独一块，每行可点，点了直接去工具箱筛（否则只能看个数字）
    if (Array.isArray(network.blockedHosts) && network.blockedHosts.length) {
      els.digestBody.appendChild(buildBlockedBlock(network.blockedHosts));
    }
  }
}

/**
 * 让摘要面板与工具箱并排（清单 A2）。
 *
 * 面板贴右边，工具箱也贴右边。以前只把工具箱的宽度告诉标签层，摘要一展开
 * 就被标签页压住；现在展开/收起都跟主进程说一声，由它把标签视图的右侧
 * 收进去（工具箱 + 摘要各占一份），面板再按工具箱宽度往左让位。
 */
async function syncDigestLayout(open) {
  if (!window.nyx.digestPanel) return null;
  try {
    const res = await window.nyx.digestPanel({ open: !!open });
    if (els.digestPanel && res && res.open) {
      const shift = res.toolboxOpen ? Number(res.toolboxWidth) || 0 : 0;
      els.digestPanel.style.right = shift
        ? `${(Number(res.gap) || 14) + shift + 8}px`
        : '';
      els.digestPanel.classList.toggle('is-beside-toolbox', Boolean(shift));
    } else if (els.digestPanel) {
      els.digestPanel.style.right = '';
      els.digestPanel.classList.remove('is-beside-toolbox');
    }
    return res || null;
  } catch (err) {
    setDigestStatus(`摘要面板布局没同步上：${String(err && err.message ? err.message : err)}`, 'warn');
    return null;
  }
}

function openDigestPanel() {
  if (!els.digestPanel) return;
  els.digestPanel.hidden = false;
  setDigestStatus('', '');
  syncDigestLayout(true);
  if (!window.nyx.digestGet) {
    setDigestStatus('当前内核不支持页面摘要。', 'warn');
    return;
  }
  window.nyx.digestGet().then((res) => {
    if (els.digestEnabled) els.digestEnabled.checked = Boolean(res && res.enabled);
  }).catch((err) => {
    setDigestStatus(`读不到摘要开关：${String(err && err.message ? err.message : err)}`, 'warn');
  });
}

function closeDigestPanel() {
  if (els.digestPanel) els.digestPanel.hidden = true;
  syncDigestLayout(false);
}

/**
 * agent 状态窄面板（清单 A5）。
 *
 * 之所以也走"让位"而不是浮在海报上：标签页是 WebContentsView，永远画在外壳 DOM
 * 之上，任何贴右边的浮层都会被压住一半。让标签视图把宽度让出来才是真可见。
 */
const AGENT_LAMP_LABELS = {
  off: '没有 agent 接入',
  ready: 'agent 已接入，当前空闲',
  busy: 'agent 正在操作这个浏览器',
};
/** 面板开着时的复核定时器（灯只有几秒生命，不刷新会停在旧状态） */
let agentPanelTimer = null;

function renderAgentPanel(res) {
  const data = res || {};
  const lamp = data.lamp || null;
  const level = lamp && lamp.level ? lamp.level : 'off';
  if (els.agentPanelLamp) els.agentPanelLamp.className = `agent-panel-lamp is-${level}`;
  if (els.agentPanelTitle) els.agentPanelTitle.textContent = AGENT_LAMP_LABELS[level] || 'agent 状态';
  if (els.agentPanelText) {
    const lines = [];
    if (lamp && lamp.text) lines.push(lamp.text);
    if (data.auditComplete === false) lines.push('当前是外部接入模式：审计只看得到经过浏览器的部分。');
    if (data.stopped === true) lines.push('已紧急停止：点下面的按钮才会重新放行。');
    els.agentPanelText.textContent = lines.join('\n');
  }
  if (els.agentPanelStop) {
    els.agentPanelStop.textContent = data.stopped === true ? '恢复 agent' : '紧急停止';
    els.agentPanelStop.classList.toggle('is-resume', data.stopped === true);
  }
  if (els.agentPanelList) {
    const rows = Array.isArray(data.recent) ? data.recent : [];
    els.agentPanelList.replaceChildren(...rows.map((row) => {
      const li = document.createElement('li');
      li.className = 'agent-panel-item';
      const when = String(row.time || '').replace('T', ' ').slice(0, 19);
      const type = row.type || '动作';
      const site = row.site ? ` · ${row.site}` : '';
      const tag = row.decision === 'deny' ? '（被拒）' : row.ok === false ? '（失败）' : '';
      li.textContent = `${when}  ${type}${site}${tag}`;
      if (row.decision === 'deny' || row.ok === false) li.classList.add('is-blocked');
      return li;
    }));
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'agent-panel-item is-empty';
      li.textContent = '还没有动作记录。';
      els.agentPanelList.replaceChildren(li);
    }
  }
  if (els.agentLampDot) els.agentLampDot.className = `agent-lamp-dot is-${level}`;
  if (els.agentLamp) {
    els.agentLamp.dataset.level = level;
    els.agentLamp.title = `agent 状态：${(lamp && lamp.label) || AGENT_LAMP_LABELS.off}`;
  }
}

async function syncAgentPanelLayout(open) {
  if (!window.nyx.agentPanel) return null;
  try {
    const res = await window.nyx.agentPanel({ open: !!open });
    if (els.agentPanel && res && res.open) {
      const shift = res.toolboxOpen ? Number(res.toolboxWidth) || 0 : 0;
      els.agentPanel.style.right = shift ? `${(Number(res.gap) || 14) + shift + 8}px` : '';
      els.agentPanel.classList.toggle('is-beside-toolbox', Boolean(shift));
    } else if (els.agentPanel) {
      els.agentPanel.style.right = '';
      els.agentPanel.classList.remove('is-beside-toolbox');
    }
    return res || null;
  } catch (err) {
    return null;
  }
}

async function openAgentPanel() {
  if (!els.agentPanel) return;
  els.agentPanel.hidden = false;
  if (els.agentLamp) els.agentLamp.setAttribute('aria-expanded', 'true');
  const res = await syncAgentPanelLayout(true);
  renderAgentPanel(res);
  // 面板开着时每 3 秒复核一次：灯会过期（4 秒窗口），不刷新就会一直停在"正在被驱动"
  if (agentPanelTimer) clearInterval(agentPanelTimer);
  agentPanelTimer = setInterval(() => {
    if (!els.agentPanel || els.agentPanel.hidden) return;
    window.nyx.agentPanel({ open: true }).then(renderAgentPanel).catch(() => {});
  }, 3000);
}

function closeAgentPanel() {
  if (els.agentPanel) els.agentPanel.hidden = true;
  if (els.agentLamp) els.agentLamp.setAttribute('aria-expanded', 'false');
  if (agentPanelTimer) {
    clearInterval(agentPanelTimer);
    agentPanelTimer = null;
  }
  syncAgentPanelLayout(false);
}

function toggleAgentPanel() {
  if (!els.agentPanel) return;
  if (els.agentPanel.hidden) openAgentPanel();
  else closeAgentPanel();
}

async function runDigest() {
  if (!window.nyx.digestRun) {
    setDigestStatus('当前内核不支持页面摘要。', 'warn');
    return;
  }
  els.digestRun.disabled = true;
  setDigestStatus('正在读取这一页…（只抽取原文，不联网）', '');
  try {
    const res = await window.nyx.digestRun({});
    if (!res || res.ok !== true) {
      // 关着的时候主进程会回 DIGEST_DISABLED 与明确原因——不许静默什么都不做
      const reason = res && res.error ? res.error : '没能生成摘要';
      setDigestStatus(reason, 'warn');
      if (res && res.code === 'DIGEST_DISABLED') {
        showNotice({ level: 'info', title: '页面摘要没有开启', message: reason });
      }
      return;
    }
    renderDigest(res);
    setDigestStatus(`已生成：抽取 ${res.page.bullets.length} 句（候选 ${res.page.candidates} 句）`, 'ok');
  } catch (err) {
    setDigestStatus(`生成失败：${String(err && err.message ? err.message : err)}`, 'warn');
  } finally {
    els.digestRun.disabled = false;
  }
}

async function copyDigest() {
  if (!lastDigestText) {
    setDigestStatus('还没有摘要可以复制，先生成一次。', 'warn');
    return;
  }
  if (!window.nyx.digestCopy) {
    setDigestStatus('当前内核不支持复制。', 'warn');
    return;
  }
  try {
    const res = await window.nyx.digestCopy(lastDigestText);
    if (res && res.ok) setDigestStatus('摘要已复制到剪贴板', 'ok');
    else setDigestStatus(res && res.error ? res.error : '复制失败', 'warn');
  } catch (err) {
    setDigestStatus(`复制失败：${String(err && err.message ? err.message : err)}`, 'warn');
  }
}

/**
 * 导出成 Markdown 文件（用户要求的第 3 项）。
 *
 * 复制是给人看的纯文本，导出是要存下来的文件：两者必须来自同一次抽取，
 * 所以送出去的是整个 payload，而不是把屏幕上已有的文本再拼一遍。
 */
async function exportDigest(format) {
  const isCsv = format === 'csv';
  const kind = isCsv ? '网络统计' : '摘要';
  const button = isCsv ? els.digestExportCsv : els.digestExport;
  if (!lastDigestPayload) {
    setDigestStatus(`还没有${kind}可以导出，先生成一次。`, 'warn');
    return;
  }
  if (!window.nyx.digestExport) {
    setDigestStatus('当前内核不支持导出。', 'warn');
    return;
  }
  if (button) button.disabled = true;
  try {
    const res = await window.nyx.digestExport(lastDigestPayload, isCsv ? 'csv' : 'md');
    if (res && res.ok) {
      setDigestStatus(`已导出：${res.path}（${res.bytes} 字节）`, 'ok');
    } else if (res && res.canceled) {
      setDigestStatus('已取消导出。', '');
    } else {
      setDigestStatus(res && res.error ? res.error : '导出失败', 'warn');
    }
  } catch (err) {
    setDigestStatus(`导出失败：${String(err && err.message ? err.message : err)}`, 'warn');
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------------- 工具栏「更多」菜单（清单 B1） ----------------
 *
 * 为什么要有这个菜单：常驻按钮每多一个，地址栏就窄一分；而"页面截图 / 页面摘要 /
 * 扩展开关 / 代理中心"这四件事一周用不到几次。主路径留四个（新建、下载、隐私、工具箱），
 * 其余收进这里——但要收得可见：菜单项写全名，不藏图标后面。
 *
 * 关于"铺开后被页面盖住"：菜单是外壳 DOM，页面是 WebContentsView，原生视图永远画在
 * DOM 上层，调 z-index 没用。做法和摘要面板一样——展开时让外壳底部临时加高，
 * 把菜单装进外壳自己的地盘里，收起时再还回去。
 */

/** 菜单实际占用高度，收起时用来还原；量不到就退到保守值。 */
const MORE_MENU_FALLBACK_H = 232;
let moreMenuExtra = 0;
/** 外壳原本的高度：开局读一次 CSS 变量，别在代码里再抄一份 124。 */
const SHELL_BASE_H = (() => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--height-shell');
  const parsed = Number.parseInt(String(raw).replace('px', ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 124;
})();

function moreMenuHeight() {
  if (!els.moreMenu) return MORE_MENU_FALLBACK_H;
  const rect = els.moreMenu.getBoundingClientRect();
  const height = Math.ceil(rect.height || 0);
  return height > 0 ? height + 8 : MORE_MENU_FALLBACK_H;
}

function applyShellExtra(extra) {
  const next = Math.max(0, Math.round(Number(extra) || 0));
  if (next === moreMenuExtra) return;
  moreMenuExtra = next;
  // 外壳自己的高度变量先改，主进程那边再改标签视图的起点：两边都到齐才没有抖动。
  const shell = SHELL_BASE_H + next;
  document.documentElement.style.setProperty('--height-shell', `${shell}px`);
  if (window.nyx && typeof window.nyx.shellExtra === 'function') {
    window.nyx.shellExtra({ extra: next }).catch(() => {
      /* 界面已经按本地值渲染了；主进程没收到只影响页面让位，不影响菜单本身 */
    });
  }
}

function openMoreMenu() {
  if (!els.moreMenu) return;
  els.moreMenu.hidden = false;
  if (els.btnMore) {
    els.btnMore.classList.add('is-open');
    els.btnMore.setAttribute('aria-expanded', 'true');
  }
  // 先量再让位：菜单高度取决于内容与字号，写死一个数字迟早对不上。
  applyShellExtra(moreMenuHeight());
}

function closeMoreMenu() {
  if (!els.moreMenu || els.moreMenu.hidden) return;
  els.moreMenu.hidden = true;
  if (els.btnMore) {
    els.btnMore.classList.remove('is-open');
    els.btnMore.setAttribute('aria-expanded', 'false');
  }
  applyShellExtra(0);
}

function toggleMoreMenu() {
  if (!els.moreMenu) return;
  if (els.moreMenu.hidden) openMoreMenu();
  else closeMoreMenu();
}

async function takeScreenshot() {
  if (!window.nyx || typeof window.nyx.pageScreenshot !== 'function') {
    showNotice({ level: 'warn', title: '当前内核不支持页面截图', message: '这一版的界面没有接上截图接口。' });
    return;
  }
  try {
    const res = await window.nyx.pageScreenshot();
    if (res && res.ok) {
      showNotice({
        level: 'ok',
        title: '截图已保存',
        message: `${res.path}（${Math.max(1, Math.round((res.bytes || 0) / 1024))} KB）`,
      });
      return;
    }
    if (res && res.code === 'CANCELED') {
      showNotice({ level: 'info', title: '已取消截图', message: '没有生成任何文件。' });
      return;
    }
    showNotice({ level: 'warn', title: '没能截图', message: (res && res.error) || '原因未知。' });
  } catch (err) {
    showNotice({
      level: 'warn',
      title: '没能截图',
      message: String(err && err.message ? err.message : err),
    });
  }
}

if (els.btnMore) {
  els.btnMore.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleMoreMenu();
  });
}
if (els.moreScreenshot) {
  els.moreScreenshot.addEventListener('click', () => {
    closeMoreMenu();
    takeScreenshot();
  });
}
if (els.moreExtensions) {
  els.moreExtensions.addEventListener('click', () => {
    closeMoreMenu();
    if (window.nyx.openSettings) window.nyx.openSettings({ section: 'extensions' });
  });
}
if (els.moreProxy) {
  els.moreProxy.addEventListener('click', () => {
    closeMoreMenu();
    if (window.nyx.openSettings) window.nyx.openSettings({ section: 'network' });
  });
}
document.addEventListener('click', (event) => {
  if (!els.moreMenu || els.moreMenu.hidden) return;
  const target = event.target;
  if (els.moreMenu.contains(target) || (els.btnMore && els.btnMore.contains(target))) return;
  closeMoreMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMoreMenu();
}, true);

if (els.btnDigest) {
  els.btnDigest.addEventListener('click', () => {
    closeMoreMenu();
    if (!els.digestPanel) return;
    if (els.digestPanel.hidden) openDigestPanel();
    else closeDigestPanel();
  });
}
if (els.digestClose) els.digestClose.addEventListener('click', closeDigestPanel);
// 工具箱开合/换宽度时，摘要面板跟着挪（清单 A2：两边都贴右边，必须并排避让）
window.addEventListener('nyx:toolbox-layout', () => {
  if (els.digestPanel && !els.digestPanel.hidden) syncDigestLayout(true);
  if (els.agentPanel && !els.agentPanel.hidden) syncAgentPanelLayout(true);
});

// agent 状态灯与窄面板（A5）：点灯开合，面板里只放"看"和"急停"，改配置回设置页
if (els.agentLamp) els.agentLamp.addEventListener('click', () => { toggleAgentPanel(); });
if (els.agentPanelClose) els.agentPanelClose.addEventListener('click', closeAgentPanel);
if (els.agentPanelStop) {
  els.agentPanelStop.addEventListener('click', async () => {
    els.agentPanelStop.disabled = true;
    try {
      await toggleAgentStop();
      const res = await window.nyx.agentPanel({ open: true });
      renderAgentPanel(res);
    } finally {
      els.agentPanelStop.disabled = false;
    }
  });
}
if (els.agentPanelSettings) {
  els.agentPanelSettings.addEventListener('click', () => {
    closeAgentPanel();
    if (window.nyx.openSettings) window.nyx.openSettings({ section: 'agent' });
  });
}
if (els.digestRun) els.digestRun.addEventListener('click', () => { runDigest(); });
if (els.digestCopy) els.digestCopy.addEventListener('click', () => { copyDigest(); });
if (els.digestExport) els.digestExport.addEventListener('click', () => { exportDigest('md'); });
if (els.digestExportCsv) els.digestExportCsv.addEventListener('click', () => { exportDigest('csv'); });
if (els.digestEnabled) {
  els.digestEnabled.addEventListener('change', async () => {
    const enabled = els.digestEnabled.checked;
    if (!window.nyx.digestSet) return;
    try {
      const res = await window.nyx.digestSet({ enabled });
      if (!res || res.ok !== true) {
        setDigestStatus(res && res.error ? res.error : '开关没能保存', 'warn');
        return;
      }
      if (!enabled) {
        if (els.digestBody) els.digestBody.textContent = '';
        lastDigestText = '';
        lastDigestPayload = null;
        setDigestStatus('已关闭：不再读取页面。需要时再打开开关重新生成。', '');
      } else {
        setDigestStatus('已开启：点「生成摘要」读取当前页。', 'ok');
      }
    } catch (err) {
      setDigestStatus(`开关没能保存：${String(err && err.message ? err.message : err)}`, 'warn');
    }
  });
}

