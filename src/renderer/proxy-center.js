'use strict';

/**
 * 代理中心渲染层。
 *
 * 只通过 preload 暴露的 window.nyx 与主进程交互；界面文案全中文，
 * 只有 IP 这类专有名词保留原样。
 */

const els = {
  kernelDot: document.getElementById('kernel-dot'),
  kernelBadge: document.getElementById('kernel-badge'),
  activeSub: document.getElementById('active-sub'),
  mixedPort: document.getElementById('mixed-port'),
  exitIp: document.getElementById('exit-ip'),
  btnStart: document.getElementById('btn-start'),
  btnStop: document.getElementById('btn-stop'),
  btnRestart: document.getElementById('btn-restart'),
  subCount: document.getElementById('sub-count'),
  subList: document.getElementById('sub-list'),
  subForm: document.getElementById('sub-form'),
  subName: document.getElementById('sub-name'),
  subUrl: document.getElementById('sub-url'),
  statGrid: document.getElementById('stat-grid'),
  tabs: document.getElementById('tabs'),
  tabCountNodes: document.getElementById('tab-count-nodes'),
  tabCountFilter: document.getElementById('tab-count-filter'),
  groupBar: document.getElementById('group-bar'),
  egressBody: document.getElementById('egress-body'),
  prefAutoEgress: document.getElementById('pref-auto-egress'),
  btnEgressAgain: document.getElementById('btn-egress-again'),
  smartCard: document.getElementById('smart-card'),
  smartBadge: document.getElementById('smart-badge'),
  prefSmartPatrol: document.getElementById('pref-smart-patrol'),
  btnSmartClear: document.getElementById('btn-smart-clear'),
  smartBody: document.getElementById('smart-body'),
  filterBody: document.getElementById('filter-body'),
  filterCount: document.getElementById('filter-count'),
  testSummary: document.getElementById('test-summary'),
  switchHint: document.getElementById('switch-hint'),
  btnTest: document.getElementById('btn-test'),
  btnEgress: document.getElementById('btn-egress'),
  filter: document.getElementById('filter'),
  onlyAvailable: document.getElementById('only-available'),
  sortMode: document.getElementById('sort-mode'),
  thName: document.getElementById('th-name'),
  thDelay: document.getElementById('th-delay'),
  nodeBody: document.getElementById('node-body'),
  nodeEmpty: document.getElementById('node-empty'),
  logBox: document.getElementById('log-box'),
  statusbar: document.getElementById('statusbar'),
  /* 上网网卡（出站网卡选择） */
  ifaceBadge: document.getElementById('iface-badge'),
  ifaceModeAuto: document.getElementById('iface-mode-auto'),
  ifaceModeManual: document.getElementById('iface-mode-manual'),
  ifaceSelect: document.getElementById('iface-select'),
  ifaceHint: document.getElementById('iface-hint'),
  btnIfaceRefresh: document.getElementById('btn-iface-refresh'),
  btnIfaceApply: document.getElementById('btn-iface-apply'),
};

/** 主进程推来的代理状态快照 */
let status = null;
/** 策略组 / 节点 / 各节点最近测速结果（name -> { delay, status }） */
let groups = [];
let nodes = [];
const delays = {};
/** 最近一次测速给出的延迟升序排名（为空表示按策略组原顺序展示） */
let ranking = [];
/** 当前查看的策略组名；空串表示展示全部节点 */
let activeGroupName = '';
/** 用于识别"内核换了新的一轮"，换轮即丢弃上一轮的测速结果 */
let lastKernelStartedAt = 0;
let lastTestAt = 0;

/** 是否有请求在途，避免按钮被连点 */
let busy = false;
/** 本机网卡清单（「上网网卡」下拉框数据源）；ifaceLoaded 表示已成功拉过一次 */
let ifaceItems = [];
let ifaceLoaded = false;

/* ---------------- 节点状态判定 ---------------- */

/** 节点状态标签：当前使用 / 可用 / 偏慢 / 超时 / 不可用 / 未测 */
const STATE_LABELS = {
  current: '当前使用',
  picked: '已选用',
  ok: '可用',
  slow: '偏慢',
  timeout: '超时',
  unavailable: '不可用',
  idle: '未测',
};

/**
 * 归纳单个节点的展示状态。
 * 优先级：策略组当前选中 > 明确测速结论 > 延迟数值 > 未知。
 */
function nodeState(node, { isCurrent, isPicked, entry, delay }) {
  if (isCurrent) return { key: 'current', label: STATE_LABELS.current, cls: 'current' };
  if (isPicked) return { key: 'picked', label: STATE_LABELS.picked, cls: 'picked' };

  const testStatus = entry ? entry.status : '';
  if (testStatus === 'timeout' || (typeof delay === 'number' && delay < 0)) {
    return { key: 'timeout', label: STATE_LABELS.timeout, cls: 'bad' };
  }
  if (testStatus === 'unavailable') {
    return { key: 'unavailable', label: STATE_LABELS.unavailable, cls: 'bad' };
  }
  if (typeof delay === 'number' && delay > 0) {
    return delay < 700
      ? { key: 'ok', label: STATE_LABELS.ok, cls: 'ok' }
      : { key: 'slow', label: STATE_LABELS.slow, cls: 'warn' };
  }
  return { key: 'idle', label: STATE_LABELS.idle, cls: '' };
}

/** 延迟强度条：0~1000 毫秒映射到 8%~100% 宽度 */
function delayBarPercent(delay) {
  if (typeof delay !== 'number' || delay <= 0) return 0;
  const ratio = Math.min(1, delay / 1000);
  return Math.round(8 + ratio * 92);
}

/* ---------------- 小工具 ---------------- */

/** 设置中心里「网络与代理」只是其中一个分区：非本分区可见时状态栏归 settings.js 管，
 *  否则代理侧异步回调（如加载完的「就绪」）会顶掉用户当前分区的提示 */
function isNetworkSectionActive() {
  const panel = document.querySelector('.sec-panel.active');
  // 无 .sec-panel 的独立承载页视为本分区常驻激活
  return !panel || panel.dataset.sec === 'network';
}

function setStatusText(text, isError = false) {
  if (!isNetworkSectionActive()) return;
  els.statusbar.textContent = text;
  els.statusbar.classList.toggle('error', Boolean(isError));
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSpan(ms) {
  if (!ms) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** 测速结果状态文案：超时 / 不可用 / 待测 */
const TEST_STATUS_LABELS = {
  timeout: '超时',
  unavailable: '不可用',
  skipped: '未测（内核未运行）',
  idle: '待测',
};

function delayText(delay, testStatus) {
  if (typeof delay === 'number' && delay > 0) return `${delay} 毫秒`;
  if (testStatus && TEST_STATUS_LABELS[testStatus]) return TEST_STATUS_LABELS[testStatus];
  if (typeof delay === 'number' && delay < 0) return '超时';
  return '未测';
}

function setBusy(next) {
  busy = next;
  for (const btn of [els.btnStart, els.btnStop, els.btnRestart, els.btnTest, els.btnEgress, els.btnEgressAgain]) {
    if (btn) btn.disabled = busy;
  }
  // 节点表内的按钮也要跟着禁用 / 恢复
  if (els.nodeBody) renderNodes();
  // 网卡选择行（模式单选、下拉框、应用按钮）同样受忙碌状态约束
  renderInterface();
}

/** 简单键值行，供出口信息卡使用 */
function kv(label, value, cls) {
  const row = document.createElement('div');
  row.className = 'kv';

  const k = document.createElement('span');
  k.className = 'kv-k';
  k.textContent = label;

  const v = document.createElement('span');
  v.className = `kv-v ${cls || ''}`.trim();
  v.textContent = value;

  row.appendChild(k);
  row.appendChild(v);
  return row;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/* ---------------- 状态区 ---------------- */

/** 节点测速统计：可用（含偏慢）/ 超时 / 不可用 / 待测 */
function delayStats() {
  const stats = { ok: 0, timeout: 0, unavailable: 0, idle: 0, measured: 0 };
  for (const node of nodes) {
    const entry = delays[node.name] || null;
    const delay = entry ? entry.delay : node.delay;
    const testStatus = entry ? entry.status : '';
    if (testStatus === 'timeout' || (typeof delay === 'number' && delay < 0)) {
      stats.timeout += 1;
    } else if (testStatus === 'unavailable') {
      stats.unavailable += 1;
    } else if (typeof delay === 'number' && delay > 0) {
      stats.ok += 1;
    } else {
      stats.idle += 1;
    }
  }
  stats.measured = stats.ok + stats.timeout + stats.unavailable;
  return stats;
}

function renderStatus() {
  const running = Boolean(status && status.running);
  const fetching = Boolean(status && status.fetching);
  const kernel = (status && status.kernel) || {};

  els.kernelDot.className = `status-dot ${fetching ? 'busy' : running ? 'on' : 'off'}`;
  els.kernelBadge.textContent = fetching
    ? '正在拉取配置…'
    : running
      ? '内核运行中'
      : '内核未启动';

  els.btnStart.disabled = busy || running;
  els.btnStop.disabled = busy || !running;
  els.btnRestart.disabled = busy;

  // 顶栏关键参数：当前订阅 / 混合端口 / 出口 IP，一眼可见
  els.activeSub.textContent = (status && status.activeName) || '未配置';

  els.mixedPort.textContent = kernel.mixedPort ? String(kernel.mixedPort) : '—';

  const exitIp = (status && status.exitIp) || '';
  els.exitIp.textContent = exitIp || '未检测';
  els.exitIp.className = `meta-v ${exitIp ? 'ok' : ''}`.trim();

  // 概览卡片
  const stats = delayStats();
  const total = nodes.length || (status && status.nodeCount) || 0;
  const test = status && status.test;
  const summary = (test && test.summary) || null;

  const cards = [
    { k: '内核状态', v: fetching ? '正在拉取配置' : running ? '运行中' : '未启动', cls: running ? 'ok' : 'bad' },
    {
      k: '可用节点',
      v: stats.measured ? `${stats.ok} / ${stats.measured} 个` : total ? `${total} 个待测` : '—',
      cls: stats.measured && stats.ok ? 'ok' : stats.measured ? 'bad' : '',
      num: true,
    },
    {
      k: '运行时长',
      v: running ? formatSpan(Date.now() - (kernel.startedAt || Date.now())) : '—',
      num: true,
    },
    {
      k: '上次测速',
      v: summary ? `${formatTime(summary.finishedAt || test.at)}` : '未测速',
    },
    { k: '控制端口', v: kernel.controllerPort ? String(kernel.controllerPort) : '—', num: true },
    { k: '出口链路', v: running ? LINK_LABELS[(status.egress || {}).link] || '未知' : '—' },
  ];

  if (kernel.lastError) {
    cards.push({ k: '内核异常', v: kernel.lastError, cls: 'bad' });
  }

  els.statGrid.textContent = '';
  for (const card of cards) {
    const box = document.createElement('div');
    box.className = 'stat';

    const k = document.createElement('div');
    k.className = 'stat-k';
    k.textContent = card.k;

    const v = document.createElement('div');
    v.className = `stat-v ${card.cls || ''} ${card.num ? 'num' : ''}`.trim();
    v.textContent = card.v;

    box.appendChild(k);
    box.appendChild(v);
    els.statGrid.appendChild(box);
  }

  els.logBox.textContent = ((kernel.logs || []).map((entry) => entry.text).join('\n') || '（暂无日志）');
}

/* ---------------- 智能遨游调度区 ---------------- */

let smartStatus = null; // 独立于内核状态：由 nyx:smart:status 单独轮询

/** 最近判定域名列表渲染（直连 / 代理 两色区分） */
function renderSmartRules() {
  const body = els.smartBody;
  if (!body) return;
  body.textContent = '';

  const recent = (smartStatus && smartStatus.recent) || [];
  if (!recent.length) {
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent = '暂无判定记录。开启智能分流并启动代理后，每 15 秒会自动巡检当前站点。';
    body.appendChild(note);
    return;
  }

  for (const item of recent.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'smart-row';

    const dot = document.createElement('span');
    dot.className = `smart-dot ${item.kind === 'direct' ? 'direct' : 'proxy'}`;
    dot.title = item.kind === 'direct' ? '判定为国内可直连' : '判定为需走代理';

    const name = document.createElement('span');
    name.className = 'smart-host';
    name.textContent = item.host;

    const verdict = document.createElement('span');
    verdict.className = `smart-kind ${item.kind}`;
    verdict.textContent = item.kind === 'direct' ? '直连' : '代理';

    const rtt = document.createElement('span');
    rtt.className = 'smart-rtt';
    rtt.textContent = item.rtt ? `${item.rtt}ms` : '';

    const at = document.createElement('span');
    at.className = 'smart-at';
    at.textContent = formatTime(item.at);

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(verdict);
    row.appendChild(rtt);
    row.appendChild(at);
    body.appendChild(row);
  }
}

/** 刷新智能调度卡片：开关回显 + 运行状态 + 统计 + 最近判定 */
function renderSmart() {
  if (!els.smartCard || !els.smartBody) return;

  const prefs = (status && status.preferences) || {};
  els.prefSmartPatrol.checked = prefs.smartPatrol !== false;

  const running = Boolean(smartStatus && smartStatus.running);
  const enabled = prefs.smartPatrol !== false;
  const badgeText = !enabled ? '已关闭' : running ? '巡检中' : '待启动';
  els.smartBadge.textContent = badgeText;
  els.smartBadge.className = `badge ${running ? 'ok' : enabled ? '' : 'off'}`;

  // 状态总览行
  const line = document.createElement('p');
  line.className = 'smart-summary';
  if (!enabled) {
    line.textContent = '智能分流已关闭：遨游模式下全部流量直走代理，不做国内 / 被墙分流。';
  } else if (running) {
    const probe = (smartStatus && smartStatus.lastProbe) || null;
    const parts = [
      `已判定站点 ${smartStatus.siteCount || 0} 个`,
      `直连 ${smartStatus.directCount || 0}`,
      `代理 ${smartStatus.proxyCount || 0}`,
    ];
    if (probe && probe.host) {
      parts.push(`最近：${probe.host} → ${probe.kind === 'direct' ? '直连' : probe.kind === 'proxy' ? '代理' : '待定'}`);
    }
    line.textContent = parts.join(' ｜ ');
  } else {
    line.textContent = '巡检器未运行：启动内置代理后自动进入智能分流。';
  }
  els.smartBody.textContent = '';
  els.smartBody.appendChild(line);

  renderSmartRules();
}

/* ---------------- 出口信息区 ---------------- */

/** 出口自查结论 → 界面文案与配色 */
const VERDICT_LABELS = {
  ok: { text: '代理生效（出口与直连不同）', cls: 'ok' },
  leak: { text: '疑似泄漏（出口与直连相同）', cls: 'bad' },
  unknown: { text: '无法判定（缺少直连对照）', cls: 'warn' },
  fail: { text: '自检失败（拿不到出口 IP）', cls: 'bad' },
};

/** 出口链路归属 */
const LINK_LABELS = {
  'builtin-kernel': '内置内核混合端口',
  external: '外置系统代理',
  none: '无可用代理端口',
};

function renderEgress() {
  const body = els.egressBody;
  body.textContent = '';

  const prefs = (status && status.preferences) || {};
  els.prefAutoEgress.checked = prefs.autoEgress === true;

  const egress = status && status.egress;
  if (!egress) {
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent = status && status.running
      ? '未检测。点上方「出口自查」会经当前代理端口取公网 IP、归属地、ISP/ASN 与时区，并与直连线路比对。'
      : '未检测。启动内置代理后可执行出口自查。';
    body.appendChild(note);
    return;
  }

  const geo = egress.geo || {};

  body.appendChild(kv('出口 IP', egress.ip || '未取到', egress.ip ? 'ok' : 'bad'));
  body.appendChild(
    kv(
      '直连对照',
      egress.directIp
        ? `${egress.directIp}${egress.directProvider ? `（${egress.directProvider}）` : ''}`
        : `未取到（${egress.directError || '未知原因'}）`,
      egress.directIp ? '' : 'warn',
    ),
  );

  const place = [geo.country, geo.region, geo.city].filter(Boolean).join(' / ');
  body.appendChild(kv('归属地', place || '未取到'));
  body.appendChild(kv('ISP', geo.isp || geo.org || '未取到'));

  const asn = geo.asnNumber ? `${geo.asnNumber}${geo.asnOrg ? ` ${geo.asnOrg}` : ''}` : geo.asn || '';
  body.appendChild(kv('ASN', asn || '未取到'));

  const timezone = geo.timezone || '';
  const localTimezone = egress.localTimezone || '';
  if (timezone && localTimezone) {
    const same = egress.timezoneMatch === true;
    const known = typeof egress.timezoneMatch === 'boolean';
    body.appendChild(
      kv(
        '时区',
        `${timezone}（本地 ${localTimezone}${known ? (same ? '，一致' : '，不一致') : ''}）`,
        known ? (same ? 'ok' : 'warn') : '',
      ),
    );
  } else {
    body.appendChild(kv('时区', timezone || '未取到'));
  }

  const verdict = VERDICT_LABELS[egress.verdict] || VERDICT_LABELS.unknown;
  body.appendChild(kv('判定', verdict.text, verdict.cls));
  body.appendChild(kv('出口链路', LINK_LABELS[egress.link] || '未知'));
  if (geo.proxy === true || geo.hosting === true) {
    body.appendChild(kv('出口属性', geo.hosting === true ? '机房 / 数据中心出口' : '服务标注为代理出口', 'warn'));
  }
  body.appendChild(kv('自查时间', formatTime(egress.at)));
  if (egress.geoProvider) body.appendChild(kv('归属查询', egress.geoProvider));

  if (egress.note) {
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent = egress.note;
    body.appendChild(note);
  }
}

/* ---------------- 广告 / 失效节点过滤区 ---------------- */

function renderFilter() {
  const body = els.filterBody;
  body.textContent = '';

  const kernel = (status && status.kernel) || {};
  const filter = kernel.filter || null;

  if (!filter) {
    els.filterCount.textContent = '已过滤 — 个';
    els.tabCountFilter.textContent = '';
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent =
      status && status.running
        ? '本次内核未返回过滤报告，可点「重新拉取配置」重试。'
        : '启动内置代理后，这里会显示订阅中被剔除的广告 / 推广 / 失效节点。';
    body.appendChild(note);
    return;
  }

  const stats = filter.stats || {};
  const filtered = Array.isArray(filter.filtered) ? filter.filtered : [];
  const filteredCount = stats.filtered || filtered.length || 0;
  els.filterCount.textContent = `已过滤 ${filteredCount} 个`;
  els.tabCountFilter.textContent = filteredCount ? String(filteredCount) : '';

  body.appendChild(kv('扫描条目', `${stats.scanned || 0} 个`));
  body.appendChild(kv('保留可用', `${stats.kept || 0} 个`, 'ok'));
  body.appendChild(kv('白名单放行', `${stats.whitelisted || 0} 个`));
  body.appendChild(kv('DNS 加固', filter.dnsHardened ? '已启用（防 DNS 泄漏）' : '未启用', filter.dnsHardened ? 'ok' : ''));

  const emptyGroups = Array.isArray(stats.emptyGroups) ? stats.emptyGroups : [];
  if (emptyGroups.length) {
    body.appendChild(kv('空策略组', `${emptyGroups.length} 个已补 DIRECT 占位`, 'warn'));
  }

  if (filtered.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `展开被过滤的 ${filtered.length} 个条目明细`;
    details.appendChild(summary);

    const list = document.createElement('ul');
    list.className = 'filter-list';
    for (const item of filtered) {
      const li = document.createElement('li');
      li.className = 'filter-item';

      const name = document.createElement('span');
      name.className = 'filter-name';
      name.textContent = item.name || '（无名称条目）';

      const reason = document.createElement('span');
      reason.className = 'filter-reason';
      reason.textContent = `原因：${item.reason || '命中广告 / 失效特征'}`;

      li.appendChild(name);
      li.appendChild(reason);
      list.appendChild(li);
    }
    details.appendChild(list);
    body.appendChild(details);
  } else {
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent = '本次订阅未发现广告 / 推广 / 失效条目。';
    body.appendChild(note);
  }

  for (const warning of Array.isArray(filter.warnings) ? filter.warnings : []) {
    const note = document.createElement('p');
    note.className = 'info-note';
    note.textContent = `提示：${warning}`;
    body.appendChild(note);
  }
}

/* ---------------- 测速摘要区 ---------------- */

function renderTestSummary() {
  const stats = delayStats();
  const total = nodes.length;

  // 节点数总览永远展示，让"哪些节点还没测"一目了然
  const overview = total
    ? `节点 ${total} 个：可用 ${stats.ok} · 超时 ${stats.timeout} · 不可用 ${stats.unavailable} · 未测 ${stats.idle}`
    : '暂无节点。';

  const test = status && status.test;
  const summary = (test && test.summary) || null;

  if (!summary) {
    els.testSummary.textContent = `${overview}；尚无测速记录，点「测速全部节点」会并发探测全部节点（并发上限 32），结果仅留在内存。`;
    return;
  }

  const reasonLabel = test.reason === 'auto' ? '自动测速' : test.reason === 'single' ? '单节点重测' : '手动测速';
  const avg = typeof summary.avg === 'number' && summary.avg > 0 ? `${summary.avg} 毫秒` : '—';
  const best = typeof summary.min === 'number' && summary.min > 0 ? `${summary.min} 毫秒` : '—';

  els.testSummary.textContent =
    `${overview}；${reasonLabel}（${formatTime(summary.finishedAt || test.at)}，用时 ${formatSpan(summary.durationMs)}）：` +
    `可用 ${summary.ok || 0} / 超时 ${summary.timeout || 0} / 不可用 ${summary.unavailable || 0}，` +
    `最快 ${best}，平均 ${avg}。`;
}

/* ---------------- 订阅区 ---------------- */

function renderSubs() {
  const list = (status && status.subscriptions) || [];
  els.subList.textContent = '';
  els.subCount.textContent = list.length ? `${list.length} 条` : '暂无';

  if (!list.length) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = '暂无订阅，请在下方添加。';
    els.subList.appendChild(empty);
    return;
  }

  for (const sub of list) {
    const item = document.createElement('li');
    item.className = `sub-item${sub.active ? ' active' : ''}`;

    const title = document.createElement('div');
    title.className = 'sub-title';
    title.textContent = sub.name;
    title.title = sub.name;
    if (sub.active) {
      const tag = document.createElement('span');
      tag.className = 'sub-tag';
      tag.textContent = '已启用';
      title.appendChild(tag);
    }
    item.appendChild(title);

    const url = document.createElement('div');
    url.className = 'sub-url';
    url.textContent = sub.urlMasked;
    url.title = sub.urlMasked;
    item.appendChild(url);

    const meta = document.createElement('div');
    meta.className = `sub-meta${sub.lastError ? ' error' : ''}`;
    meta.textContent = sub.lastError
      ? `上次拉取失败：${sub.lastError}`
      : `节点 ${sub.nodeCount || 0} 个 · 上次更新 ${formatTime(sub.lastFetchAt)}`;
    meta.title = meta.textContent;
    item.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'sub-actions';

    if (!sub.active) {
      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'btn btn-mini';
      useBtn.textContent = '启用';
      useBtn.addEventListener('click', () => switchSubscription(sub.id));
      actions.appendChild(useBtn);
    } else {
      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'btn btn-mini';
      refreshBtn.textContent = '重新拉取';
      refreshBtn.addEventListener('click', () => refreshSubscription());
      actions.appendChild(refreshBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-mini btn-danger';
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => removeSubscription(sub));
    actions.appendChild(delBtn);

    item.appendChild(actions);
    els.subList.appendChild(item);
  }
}

/* ---------------- 节点区 ---------------- */

function currentGroup() {
  return groups.find((group) => group.name === activeGroupName) || null;
}

/** 主策略组：优先手动选择组（GLOBAL 之类），否则取第一个组；用于「全部节点」视图下的切换目标 */
function primaryGroup() {
  const selector = groups.find((group) =>
    ['select', 'selector'].includes(String((group && group.type) || '').toLowerCase().replace(/[-_]/g, '')),
  );
  return selector || groups[0] || null;
}

/**
 * 全局当前选中：primary 为主选节点（主策略组的当前项），
 * all 为所有策略组当前选中的节点集合，用于在「全部节点」视图里也标出选中项。
 */
function currentSelection() {
  const all = new Set();
  for (const group of groups) {
    if (group && group.now) all.add(group.now);
  }
  const main = primaryGroup();
  const primary = (main && main.now) || groups.map((group) => group && group.now).find(Boolean) || '';
  return { primary, all };
}

/** 策略组芯片：名称 + 类型 + 成员数，选中的组高亮 */
function buildChip({ label, sub, active, title, onClick }) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `group-chip${active ? ' active' : ''}`;
  chip.title = title || label;

  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = label;
  chip.appendChild(name);

  if (sub) {
    const meta = document.createElement('span');
    meta.className = 'chip-type';
    meta.textContent = sub;
    chip.appendChild(meta);
  }

  chip.addEventListener('click', onClick);
  return chip;
}

function renderGroupTabs() {
  const bar = els.groupBar;
  bar.textContent = '';

  if (!groups.length) {
    activeGroupName = '';
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = status && status.running ? '内核未返回策略组。' : '启动内置代理后显示策略组。';
    bar.appendChild(note);
    return;
  }

  // 注意：activeGroupName 为空串表示「全部节点」视图，不能当作未知组回落
  if (activeGroupName && !groups.some((group) => group.name === activeGroupName)) {
    activeGroupName = groups[0].name;
  }

  bar.appendChild(
    buildChip({
      label: '全部节点',
      sub: `${nodes.length} 个`,
      active: !activeGroupName,
      title: '不分策略组，展示全部节点',
      onClick: () => {
        if (!activeGroupName) return;
        activeGroupName = '';
        renderGroupTabs();
        renderNodes();
      },
    }),
  );

  for (const group of groups) {
    const members = Array.isArray(group.members) ? group.members : [];
    bar.appendChild(
      buildChip({
        label: group.name,
        sub: `${typeLabel(group.type)} · ${members.length} 个`,
        active: group.name === activeGroupName,
        title: group.now ? `${group.name}：当前使用「${group.now}」` : `${group.name}：尚未选择节点`,
        onClick: () => {
          if (activeGroupName === group.name) return;
          activeGroupName = group.name;
          renderGroupTabs();
          renderNodes();
        },
      }),
    );
  }
}

// 策略组类型中文名（内核 /proxies 返回驼峰类型名 Selector / URLTest / Fallback…，统一小写比对）
const GROUP_TYPE_LABELS = {
  selector: '手动选择',
  select: '手动选择',
  urltest: '自动测速',
  'url-test': '自动测速',
  fallback: '故障转移',
  'fallback-select': '故障转移',
  loadbalance: '负载均衡',
  'load-balance': '负载均衡',
  relay: '链路转发',
  direct: '直连',
  reject: '拦截',
  compatible: '兼容模式',
};

function typeLabel(type) {
  if (!type) return '自定义策略组';
  return GROUP_TYPE_LABELS[String(type).toLowerCase()] || '自定义策略组';
}

// 节点协议名规范化（专有名词，保留英文惯例写法；未知协议原样大写）
const PROTOCOL_LABELS = {
  ss: 'Shadowsocks',
  shadowsocks: 'Shadowsocks',
  ssr: 'ShadowsocksR',
  shadowsocksr: 'ShadowsocksR',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  anytls: 'AnyTLS',
  hysteria: 'Hysteria',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  wireguard: 'WireGuard',
  http: 'HTTP',
  socks5: 'SOCKS5',
  direct: '直连',
  reject: '拦截',
};

function protoLabel(type) {
  if (!type) return '—';
  const raw = String(type);
  return PROTOCOL_LABELS[raw.toLowerCase()] || raw.toUpperCase();
}

/** 表头排序指示：点击「节点 / 延迟」列头即可切换排序，箭头与高亮跟排序下拉保持一致 */
function updateSortHeaders() {
  const mode = els.sortMode.value;
  const label = (th, text, mark, sorted) => {
    if (!th) return;
    th.textContent = text;
    th.classList.toggle('sorted', sorted);
    if (!mark) return;
    const arrow = document.createElement('span');
    arrow.className = 'th-arrow';
    arrow.textContent = mark;
    th.appendChild(arrow);
  };
  label(els.thName, '节点', mode === 'name' ? '按名称' : '', mode === 'name');
  label(
    els.thDelay,
    '延迟',
    mode === 'delay-asc' ? '升序 ↑' : mode === 'delay-desc' ? '降序 ↓' : '',
    mode === 'delay-asc' || mode === 'delay-desc',
  );
}

function onSortHeaderClick(key) {
  const mode = els.sortMode.value;
  if (key === 'name') {
    els.sortMode.value = mode === 'name' ? 'group' : 'name';
  } else {
    els.sortMode.value = mode === 'delay-asc' ? 'delay-desc' : 'delay-asc';
  }
  renderNodes();
}

/** 延迟排序：未测 / 超时统一沉底，避免它们占据前排 */
function sortRows(rows) {
  const mode = els.sortMode.value;
  const copy = rows.slice();
  const up = (row) => (typeof row.delay === 'number' && row.delay > 0 ? row.delay : Number.POSITIVE_INFINITY);
  const down = (row) => (typeof row.delay === 'number' && row.delay > 0 ? row.delay : -1);

  if (mode === 'delay-asc') return copy.sort((a, b) => up(a) - up(b));
  if (mode === 'delay-desc') return copy.sort((a, b) => down(b) - down(a));
  if (mode === 'name') return copy.sort((a, b) => a.node.name.localeCompare(b.node.name, 'zh-Hans-CN'));
  return copy;
}

function renderNodes() {
  const group = currentGroup();
  const selection = currentSelection();
  const keyword = els.filter.value.trim().toLowerCase();
  const onlyAvailable = els.onlyAvailable.checked;

  updateSortHeaders();
  // 「全部节点」视图下也要能切换节点，这里明确告知「使用」按钮落到哪个策略组
  if (els.switchHint) {
    const target = group || primaryGroup();
    els.switchHint.textContent = target ? `「使用」作用于策略组：${target.name}` : '';
  }
  // 有策略组时按组展示成员（组内顺序即优先级顺序），「全部节点」视图展示所有节点
  let list;
  if (group) {
    const members = new Set(group.members);
    list = nodes.filter((node) => members.has(node.name));
  } else {
    list = nodes.slice();
  }

  // 先算状态，再做筛选与排序，保证状态列与筛选口径一致
  let rows = list.map((node) => {
    const entry = delays[node.name] || null;
    const delay = entry ? entry.delay : node.delay;
    const isCurrent = selection.primary === node.name;
    const isPicked = !isCurrent && selection.all.has(node.name);
    return {
      node,
      entry,
      delay,
      isCurrent,
      isPicked,
      state: nodeState(node, { isCurrent, isPicked, entry, delay }),
    };
  });

  if (onlyAvailable) {
    // 只看可用：隐藏已确认超时 / 不可用的节点，未测节点保留，便于决定是否再测
    rows = rows.filter((row) => row.state.key !== 'timeout' && row.state.key !== 'unavailable');
  }
  if (keyword) {
    rows = rows.filter((row) => row.node.name.toLowerCase().includes(keyword));
  }

  rows = sortRows(rows);

  els.nodeBody.textContent = '';
  els.nodeEmpty.hidden = rows.length > 0;
  if (!rows.length) {
    els.nodeEmpty.textContent = nodes.length
      ? '当前筛选条件下没有节点：清空搜索、取消「只看可用」或切换策略组试试。'
      : '暂无节点，请先启动内置代理。';
  }

  els.tabCountNodes.textContent = rows.length === nodes.length
    ? String(rows.length)
    : `${rows.length}/${nodes.length}`;

  for (const row of rows) {
    const { node, entry, delay, isCurrent, state } = row;
    const tr = document.createElement('tr');
    if (isCurrent) tr.className = 'current';

    // 状态列：圆点 + 文字
    const stateTd = document.createElement('td');
    const stateEl = document.createElement('span');
    stateEl.className = `state ${state.cls}`.trim();
    stateEl.textContent = state.label;
    stateTd.appendChild(stateEl);
    tr.appendChild(stateTd);

    // 节点名
    const nameTd = document.createElement('td');
    nameTd.className = 'node-name';
    nameTd.textContent = node.name;
    nameTd.title = node.name;
    tr.appendChild(nameTd);

    // 协议
    const typeTd = document.createElement('td');
    typeTd.className = 'node-type';
    typeTd.textContent = protoLabel(node.type);
    tr.appendChild(typeTd);

    // 延迟：数值 + 强度条，快慢一眼可辨
    const delayTd = document.createElement('td');
    const cell = document.createElement('div');
    cell.className = 'delay-cell';

    const toneCls = state.cls === 'ok' || state.cls === 'current'
      ? 'ok'
      : state.cls === 'warn'
        ? 'warn'
        : state.cls === 'bad'
          ? 'bad'
          : state.cls === 'picked'
            ? 'picked'
            : '';

    const val = document.createElement('span');
    val.className = `delay-val ${toneCls}`.trim();
    val.textContent = delayText(delay, entry ? entry.status : '');

    const rank = ranking.indexOf(node.name);
    if (rank >= 0 && typeof delay === 'number' && delay > 0) {
      const rankTag = document.createElement('span');
      rankTag.className = 'delay-rank';
      rankTag.textContent = `#${rank + 1}`;
      val.appendChild(rankTag);
    }
    cell.appendChild(val);

    const bar = document.createElement('div');
    bar.className = `delay-bar ${toneCls}`.trim();
    const fill = document.createElement('span');
    fill.style.width = `${delayBarPercent(delay)}%`;
    bar.appendChild(fill);
    cell.appendChild(bar);

    delayTd.appendChild(cell);
    tr.appendChild(delayTd);

    // 操作：切换节点 / 单节点重测（「全部节点」视图下自动作用于主策略组）
    const actTd = document.createElement('td');
    actTd.className = 'col-act';

    const target = group || primaryGroup();
    const inUse = Boolean(target) && target.now === node.name;

    const useBtn = document.createElement('button');
    useBtn.type = 'button';
    useBtn.className = `btn btn-mini${inUse ? ' btn-on' : ''}`;
    useBtn.textContent = inUse ? '使用中' : '使用';
    useBtn.disabled = !target || inUse || busy;
    useBtn.title = !target
      ? '内核未返回策略组，暂时无法切换节点'
      : inUse
        ? `「${target.name}」正在使用该节点`
        : `把「${target.name}」切换到该节点`;
    useBtn.addEventListener('click', () => selectNode(target, node.name));
    actTd.appendChild(useBtn);

    const retestBtn = document.createElement('button');
    retestBtn.type = 'button';
    retestBtn.className = 'btn btn-mini';
    retestBtn.textContent = '重测';
    retestBtn.title = '只重新测这一个节点';
    retestBtn.disabled = busy || !(status && status.running);
    retestBtn.addEventListener('click', () => retestNode(node.name));
    actTd.appendChild(retestBtn);

    tr.appendChild(actTd);
    els.nodeBody.appendChild(tr);
  }
}

/* ---------------- 数据加载 ---------------- */

/**
 * 应用一份状态快照，同步全部面板。
 * 返回 true 表示节点清单需要重新拉取（内核换轮或刚完成一轮测速）。
 */
function applyStatus(snapshot) {
  status = snapshot;

  const startedAt = (status && status.kernel && status.kernel.startedAt) || 0;
  if (startedAt !== lastKernelStartedAt) {
    // 内核重新拉起过一轮：上一轮的测速结果与排名全部作废
    lastKernelStartedAt = startedAt;
    for (const name of Object.keys(delays)) delete delays[name];
    ranking = [];
  }

  let refreshNodes = false;
  const testAt = (status && status.test && status.test.at) || 0;
  if (testAt !== lastTestAt) {
    lastTestAt = testAt;
    const summary = status && status.test ? status.test.summary : null;
    ranking = summary && Array.isArray(summary.ranking) ? summary.ranking.slice() : [];
    refreshNodes = true;
  }

  renderStatus();
  renderSmart();
  renderSubs();
  renderEgress();
  renderFilter();
  renderTestSummary();
  syncIfaceDraftFromStatus();
  renderInterface();
  return refreshNodes;
}

async function loadStatus() {
  applyStatus(await window.nyx.getProxyStatus());
}

async function loadNodes() {
  const result = await window.nyx.listProxyNodes();
  if (!result || result.ok === false) {
    groups = [];
    nodes = [];
  } else {
    groups = result.groups || [];
    nodes = result.nodes || [];
  }

  renderGroupTabs();
  renderNodes();
  renderTestSummary();
  renderStatus();
}

async function loadAll() {
  await loadStatus();
  await loadNodes();
}

/* ---------------- 上网网卡（手动 / 自动选择） ---------------- */

/** 把网卡清单渲染进下拉框：默认出口与虚拟网卡带后缀标注，便于辨认 */
function renderInterfaceSelect() {
  if (!els.ifaceSelect) return;

  const current = ifaceDraft.name || els.ifaceSelect.value;
  els.ifaceSelect.textContent = '';

  if (!ifaceItems.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = ifaceLoaded ? '未检测到可用网卡' : '正在读取网卡…';
    els.ifaceSelect.appendChild(opt);
    return;
  }

  for (const item of ifaceItems) {
    const opt = document.createElement('option');
    opt.value = item.name;
    const tags = [];
    if (item.isDefault) tags.push('系统默认出口');
    if (item.virtual) tags.push('虚拟');
    opt.textContent = `${item.name} · ${item.ipv4}${tags.length ? `（${tags.join('，')}）` : ''}`;
    els.ifaceSelect.appendChild(opt);
  }

  if (current && ifaceItems.some((item) => item.name === current)) {
    els.ifaceSelect.value = current;
  }
}

/**
 * 上网网卡卡片的编辑态：点「应用」之前不写库、不重建内核，只驱动单选、
 * 下拉可用性与提示文案。没有这层的话，单选一被点击就会被状态快照弹回原位。
 */
let ifaceDraft = { mode: 'auto', name: '', dirty: false };

/** 用已保存的偏好重置编辑态；用户有未提交改动时不覆盖，免得被后台状态推送冲掉 */
function syncIfaceDraftFromStatus() {
  if (ifaceDraft.dirty) return;

  const prefs = (status && status.preferences) || {};
  const savedMode = (((status && status.interfaceMode) || prefs.interfaceMode) === 'manual') ? 'manual' : 'auto';
  // 保存态是自动时保留编辑态里记着的网卡名，状态推送不该抹掉「上次选过哪张卡」
  const savedName = savedMode === 'manual'
    ? String((status && status.interfaceName) || prefs.interfaceName || '')
    : ifaceDraft.name;
  ifaceDraft = { mode: savedMode, name: savedName, dirty: false };
}

/** 单选切换：只改编辑态；切到手动且尚未选过时，预选系统默认出口网卡 */
function onIfaceModeChange() {
  if (!els.ifaceModeAuto) return;

  if (els.ifaceModeManual && els.ifaceModeManual.checked) {
    let name = ifaceDraft.name;
    if (!name) {
      const preferred =
        ifaceItems.find((item) => item.isDefault) ||
        ifaceItems.find((item) => !item.virtual) ||
        ifaceItems[0];
      name = preferred ? preferred.name : '';
    }
    ifaceDraft = { mode: 'manual', name, dirty: true };
  } else {
    // 切回自动时保留上次选过的网卡名，下次切手动可直接沿用
    ifaceDraft = { mode: 'auto', name: ifaceDraft.name, dirty: true };
  }
  renderInterface();
}

/** 依编辑态刷新模式单选、徽标与提示（区分「待应用」与「已生效」） */
function renderInterface() {
  if (!els.ifaceModeAuto) return;

  const prefs = (status && status.preferences) || {};
  const savedMode = (((status && status.interfaceMode) || prefs.interfaceMode) === 'manual') ? 'manual' : 'auto';
  const savedName = savedMode === 'manual'
    ? String((status && status.interfaceName) || prefs.interfaceName || '')
    : '';

  const mode = ifaceDraft.mode;
  const name = mode === 'manual' ? ifaceDraft.name : '';
  const active = (status && status.interfaceActive) || '';
  const running = Boolean(status && status.running);
  const pending = mode !== savedMode || name !== savedName;

  els.ifaceModeAuto.checked = mode === 'auto';
  els.ifaceModeManual.checked = mode === 'manual';
  els.ifaceSelect.disabled = busy || mode !== 'manual';

  // 已保存但内核还没换出口（例如上次内核未运行）：允许点「应用」触发重建
  const needsRebuild =
    mode === 'manual' && !pending && running && Boolean(savedName) && active !== savedName;
  if (els.btnIfaceApply) {
    els.btnIfaceApply.disabled =
      busy || (mode === 'manual' && !name) || (!pending && !needsRebuild);
  }

  // 网卡可能被拔掉 / 禁用：记着的名字未必还在本机可用列表中
  const known = ifaceItems.some((item) => item.name === name);
  if (name && known) els.ifaceSelect.value = name;
  else if (!name) els.ifaceSelect.value = '';
  const missing = Boolean(name) && ifaceLoaded && !known;

  if (mode === 'auto') {
    els.ifaceBadge.textContent = pending ? '自动选择 · 待应用' : running ? '自动选择 · 已生效' : '自动选择';
    els.ifaceHint.textContent = pending
      ? '将取消手动绑定，改由系统默认路由决定出口。点「应用」保存。'
      : '自动模式跟随系统默认路由，由系统决定出口网卡。';
    return;
  }

  els.ifaceBadge.textContent = `手动 · ${name || '未选择'}${pending ? ' · 待应用' : ''}`;
  if (!name) {
    els.ifaceHint.textContent = '请在下拉框中选择一张网卡，再点「应用」。';
  } else if (missing) {
    els.ifaceHint.textContent = `所选网卡「${name}」当前不在本机可用列表中，请重新选择后点「应用」。`;
  } else if (pending) {
    els.ifaceHint.textContent = running
      ? `点「应用」后内核会重建，出站连接与 DNS 解析将从「${name}」发出。`
      : `点「应用」保存，启动内置代理后出站连接与 DNS 解析将从「${name}」发出。`;
  } else if (running) {
    els.ifaceHint.textContent =
      active === name
        ? `内核出站连接与 DNS 解析均从「${name}」发出。`
        : `已设置为「${name}」，当前内核尚未生效，点「应用」重建内核。`;
  } else {
    els.ifaceHint.textContent = `已设置为「${name}」，启动内置代理后生效。`;
  }
}

/** 读取本机网卡清单（只读查询；失败只提示、不阻断其余功能） */
async function loadInterfaces() {
  if (!els.ifaceSelect) return;

  const result = await window.nyx.listNetInterfaces();
  if (!result || result.ok === false) {
    ifaceItems = [];
    ifaceLoaded = true;
    renderInterfaceSelect();
    renderInterface();
    setStatusText(`读取网卡失败：${(result && result.error) || '未知原因'}`, true);
    return;
  }

  ifaceItems = result.items || [];
  ifaceLoaded = true;
  renderInterfaceSelect();
  renderInterface();
}

/** 应用网卡选择；内核在跑时由主进程重建内核让新出口生效 */
async function applyInterface() {
  if (!els.ifaceModeAuto) return;

  const mode = ifaceDraft.mode;
  const name = mode === 'manual' ? ifaceDraft.name : '';

  if (mode === 'manual' && !name) {
    setStatusText('请先选择一张网卡', true);
    return;
  }

  const result = await guard('正在切换上网网卡', () =>
    window.nyx.setOutboundInterface({ mode, name }),
  );
  // guard 在已有操作执行中时会拦下本次点击（返回 undefined），不属于失败
  if (!result) return;

  if (result.ok) ifaceDraft.dirty = false;
  await loadStatus();

  if (result && result.ok) {
    if (result.unchanged) {
      setStatusText('上网网卡设置未变化');
    } else if (mode === 'manual') {
      setStatusText(
        result.restarted
          ? `已切换到网卡「${name}」，内核已重建`
          : `已切换到网卡「${name}」，启动内置代理后生效`,
      );
    } else {
      setStatusText(result.restarted ? '已恢复自动选择网卡，内核已重建' : '已恢复自动选择网卡');
    }
    return;
  }

  setStatusText(`切换上网网卡失败：${(result && result.error) || '未知原因'}`, true);
}

/* ---------------- 动作 ---------------- */

async function guard(label, fn) {
  if (busy) return;
  setBusy(true);
  setStatusText(`${label}…`);
  try {
    const result = await fn();
    return result;
  } finally {
    setBusy(false);
  }
}

async function startKernel() {
  const result = await guard('正在拉取订阅并启动内核', () => window.nyx.startProxy());
  await loadAll();
  setStatusText(
    result && result.ok
      ? `内核已启动，混合端口 ${(status && status.mixedPort) || '—'}`
      : `启动失败：${(result && result.error) || (status && status.activeLastError) || '未知原因'}`,
    !(result && result.ok),
  );
}

async function stopKernel() {
  await guard('正在停止内核', () => window.nyx.stopProxy());
  await loadAll();
  setStatusText('内核已停止，配置文件与进程均已清理');
}

async function restartKernel() {
  const result = await guard('正在重新拉取订阅并重启内核', () => window.nyx.restartProxy());
  await loadAll();
  setStatusText(
    result && result.ok ? '配置已重新加载' : `重载失败：${(result && result.error) || '未知原因'}`,
    !(result && result.ok),
  );
}

async function refreshSubscription() {
  await restartKernel();
}

async function switchSubscription(id) {
  const result = await guard('正在切换订阅并重启内核', () => window.nyx.switchProxySubscription(id));
  await loadAll();
  setStatusText(
    result && result.ok ? '订阅已切换' : `切换失败：${(result && result.error) || '未知原因'}`,
    !(result && result.ok),
  );
}

async function removeSubscription(sub) {
  const result = await guard('正在删除订阅', () => window.nyx.removeProxySubscription(sub.id));
  await loadAll();
  setStatusText(
    result && result.ok ? `已删除订阅「${sub.name}」` : `删除失败：${(result && result.error) || '未知原因'}`,
    !(result && result.ok),
  );
}

/** 把一次测速返回的结果并入本地缓存（仅内存，不落盘） */
function mergeTestResult(result, { single = false } = {}) {
  Object.assign(delays, result.results || {});

  const summary = result.summary || null;
  // 单节点重测只会给出"这一个节点"的排名，不能覆盖全量排名
  if (!single && summary && Array.isArray(summary.ranking) && summary.ranking.length > 1) {
    ranking = summary.ranking.slice();
  }
  if (summary && typeof summary.finishedAt === 'number') lastTestAt = Math.max(lastTestAt, summary.finishedAt);
}

async function testNodes() {
  const result = await guard('正在并发测速全部节点', () => window.nyx.testProxyNodes(null));

  if (result && result.ok) {
    mergeTestResult(result);
    // 测速完成后自动切到延迟升序，结果一眼看出快慢
    if (els.sortMode.value === 'group') els.sortMode.value = 'delay-asc';
    renderNodes();
    renderTestSummary();
    const summary = result.summary || {};
    setStatusText(
      `测速完成：可用 ${summary.ok || 0}，超时 ${summary.timeout || 0}，不可用 ${summary.unavailable || 0}`,
    );
  } else {
    setStatusText(`测速失败：${(result && result.error) || '未知原因'}`, true);
  }
}

async function retestNode(nodeName) {
  const result = await guard(`正在重测「${nodeName}」`, () => window.nyx.testProxyNodes([nodeName]));

  if (result && result.ok) {
    mergeTestResult(result, { single: true });
    renderNodes();
    renderTestSummary();
    const one = (result.results || {})[nodeName] || {};
    setStatusText(`「${nodeName}」重测结果：${delayText(one.delay, one.status)}`);
  } else {
    setStatusText(`重测失败：${(result && result.error) || '未知原因'}`, true);
  }
}

async function selectNode(group, nodeName) {
  if (!group) return;

  const result = await guard(`正在切换到 ${nodeName}`, () =>
    window.nyx.selectProxyNode(group.name, nodeName),
  );

  await loadNodes();
  setStatusText(
    result && result.ok ? `已切换到「${nodeName}」` : `切换失败：${(result && result.error) || '未知原因'}`,
    !(result && result.ok),
  );
}

async function checkEgress() {
  const result = await guard('正在经内核出口自查', () => window.nyx.checkProxyEgress());
  await loadStatus();
  renderNodes();

  if (result && result.ok) {
    const verdict = VERDICT_LABELS[result.verdict] || VERDICT_LABELS.unknown;
    setStatusText(`出口 IP：${result.ip} · ${verdict.text}`, result.verdict === 'leak');
  } else {
    setStatusText(`出口自查失败：${(result && result.error) || '未知原因'}`, true);
  }
}

/* ---------------- 事件绑定 ---------------- */

els.btnStart.addEventListener('click', startKernel);
els.btnStop.addEventListener('click', stopKernel);
els.btnRestart.addEventListener('click', restartKernel);
els.btnTest.addEventListener('click', testNodes);
els.btnEgress.addEventListener('click', checkEgress);
els.btnEgressAgain.addEventListener('click', checkEgress);
// 上网网卡：模式切换只改界面，点「应用」才真正写入并重建内核
if (els.ifaceModeAuto) els.ifaceModeAuto.addEventListener('change', onIfaceModeChange);
if (els.ifaceModeManual) els.ifaceModeManual.addEventListener('change', onIfaceModeChange);
if (els.ifaceSelect) {
  els.ifaceSelect.addEventListener('change', () => {
    ifaceDraft = { mode: 'manual', name: els.ifaceSelect.value, dirty: true };
    renderInterface();
  });
}
if (els.btnIfaceRefresh) els.btnIfaceRefresh.addEventListener('click', () => loadInterfaces());
if (els.btnIfaceApply) els.btnIfaceApply.addEventListener('click', applyInterface);
els.filter.addEventListener('input', renderNodes);
els.onlyAvailable.addEventListener('change', renderNodes);
els.sortMode.addEventListener('change', renderNodes);
// 列头也可直接点击排序，和下拉框双向同步
if (els.thName) els.thName.addEventListener('click', () => onSortHeaderClick('name'));
if (els.thDelay) els.thDelay.addEventListener('click', () => onSortHeaderClick('delay'));

/** 页签显示名，用于底栏提示 */
const TAB_LABELS = {
  nodes: '节点',
  line: '线路自检',
  filter: '过滤明细',
  update: '软件更新',
  logs: '内核日志',
};

// 分页切换：节点为默认页
els.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab || !els.tabs.contains(tab)) return;

  const name = tab.dataset.tab;
  for (const btn of els.tabs.querySelectorAll('.tab')) {
    btn.classList.toggle('active', btn === tab);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.dataset.panel === name);
  }
  setStatusText(`已切换到「${TAB_LABELS[name] || name}」页`);
});

// 出口自查是真实外联请求，默认不随内核启动自动执行，由用户显式开关
els.prefAutoEgress.addEventListener('change', async () => {
  const next = els.prefAutoEgress.checked;
  const result = await window.nyx.setProxyPreference('autoEgress', next);

  if (result && result.ok === false) {
    els.prefAutoEgress.checked = !next;
    setStatusText(`设置失败：${result.error || '未知原因'}`, true);
    return;
  }

  await loadStatus();
  setStatusText(next ? '已开启：内核启动后自动刷新出口信息' : '已关闭：出口信息仅手动刷新');
});

// 智能分流开关：写入代理偏好（smartPatrol），主进程会同步巡检器并复核链路
els.prefSmartPatrol.addEventListener('change', async () => {
  const next = els.prefSmartPatrol.checked;
  const result = await window.nyx.setProxyPreference('smartPatrol', next);

  if (result && result.ok === false) {
    els.prefSmartPatrol.checked = !next;
    setStatusText(`设置失败：${result.error || '未知原因'}`, true);
    return;
  }

  await loadStatus();
  setStatusText(
    next
      ? '已开启：遨游模式将按域名智能分流（国内直连 / 被墙走代理），每 15 秒巡检'
      : '已关闭：遨游模式全部流量直走代理',
  );
});

// 清空智能分流规则表：判定全部作废，下次巡检重新探测
els.btnSmartClear.addEventListener('click', async () => {
  const result = await window.nyx.clearSmartRules();
  if (result && result.ok === false) {
    setStatusText(`清空失败：${result.error || '未知原因'}`, true);
    return;
  }
  smartStatus = null;
  renderSmart();
  setStatusText('智能分流规则表已清空');
});

els.subForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const url = els.subUrl.value.trim();
  const name = els.subName.value.trim();
  if (!url) {
    setStatusText('请先填写订阅地址', true);
    return;
  }

  const result = await guard('正在添加订阅', () =>
    window.nyx.addProxySubscription({ name, url }),
  );

  if (result && result.ok) {
    els.subName.value = '';
    els.subUrl.value = '';
    await loadStatus();
    setStatusText('订阅已添加，点「启用」即可切换到该订阅');
  } else {
    setStatusText(`添加失败：${(result && result.message) || '未知原因'}`, true);
  }
});

window.nyx.onProxyState((snapshot) => {
  // 主进程自动测速 / 出口自查完成后，同步拉一次节点表，保证延迟列与排名一致
  if (applyStatus(snapshot)) loadNodes();
});

// 运行时长每秒走一格（仅本地计时，不发起任何请求）
// 运行时长每秒走一格（纯本地计算）；只在网络分区可见时重绘，避免后台空转
window.setInterval(() => {
  if (status && status.running && isNetworkSectionActive()) renderStatus();
}, 1000);

// 智能调度状态独立轮询（3 秒）：规则表由主进程巡检更新，不走内核状态推送
window.setInterval(async () => {
  if (!isNetworkSectionActive()) return;
  try {
    const result = await window.nyx.getSmartStatus();
    if (result && result.ok) {
      smartStatus = result;
      renderSmart();
    }
  } catch (err) {
    // 巡检器未就绪等瞬时错误静默跳过，下轮再试
  }
}, 3000);

/**
 * 代理数据按需加载：只有真正切到「网络与代理」分区才拉状态、节点与网卡清单。
 * 打开设置中心默认停在外观分区，不该为一屏之外的代理数据起 PowerShell 查系统出口。
 */
let networkLoaded = false;

async function ensureNetworkLoaded() {
  if (networkLoaded) return;
  networkLoaded = true;
  await loadAll();
  setStatusText('就绪');
  if (status && status.running) loadNodes();
  // 网卡清单单独拉：查系统默认出口要跑一次 PowerShell，不塞进主状态刷新链路
  loadInterfaces();
}

// 独立承载页直接初始化；设置中心由 settings.js 切分区时广播
if (isNetworkSectionActive()) ensureNetworkLoaded();
document.addEventListener('nyx:section-change', (event) => {
  if (event.detail === 'network') ensureNetworkLoaded();
});
