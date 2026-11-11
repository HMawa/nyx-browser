'use strict';

/**
 * 设置中心渲染逻辑。
 *
 * 分工：本文件负责左栏分区导航，以及「外观 / 启动与主页 / 隐私与安全 / 下载 / 关于与更新」
 * 五个分区的渲染与交互；「网络与代理」分区整体沿用 proxy-center.js（订阅、内核、节点、
 * 自检、过滤、日志），本文件不重复实现。
 *
 * 用 IIFE 包裹，避免与 proxy-center.js 的顶层标识符相互覆盖。
 */
(function () {
  const SEC_LABELS = {
    appearance: '外观',
    startup: '启动与主页',
    privacy: '隐私与安全',
    network: '网络与代理',
    downloads: '下载',
    extensions: '扩展插件',
    about: '关于与更新',
  };

  /** 权限标识 → 中文说明（界面展示用；未登记的标识直接显示原文） */
  const PERMISSION_CN = {
    media: '摄像头 / 麦克风',
    'audioCapture': '麦克风',
    'videoCapture': '摄像头',
    geolocation: '定位',
    notifications: '通知',
    clipboardRead: '读取剪贴板',
    'clipboard-read': '读取剪贴板',
    'clipboard-sanitized-write': '写入剪贴板',
    midi: 'MIDI 设备',
    midiSysex: 'MIDI 设备',
    displayCapture: '屏幕捕获',
    usb: 'USB 设备',
    hid: 'HID 设备',
    serial: '串口设备',
    fullscreen: '全屏',
    pointerLock: '指针锁定',
    openExternal: '打开外部应用',
    idleDetection: '空闲检测',
    mediaKeySystem: '受保护媒体',
    'window-management': '窗口管理',
    'storage-access': '存储访问',
    'top-level-storage-access': '顶层存储访问',
    'unknown': '未登记权限',
  };

  const byId = (id) => document.getElementById(id);

  const navEl = byId('nav-list');
  const statusbarEl = byId('statusbar');
  const panels = Array.from(document.querySelectorAll('.sec-panel'));

  /* ------------------------------------------------------------------ */
  /* 分区滚动位置记忆                                                     */
  /* ------------------------------------------------------------------ */

  /** 持久化键：设置窗口是独立页面（file:// 同源），键名加前缀避免与代理中心撞车 */
  const SCROLL_KEY = 'nyx:settings:scroll';
  /** 分区名 → 上次滚动位置（像素）；缺省即首次进入，视为 0 */
  const scrollMemo = readScrollMemo();
  /** 当前分区名：切换时以它作为「切走前要记录的那个分区」 */
  const firstActivePanel = panels.find((panel) => panel.classList.contains('active'));
  let activeSection = firstActivePanel && firstActivePanel.dataset.sec ? firstActivePanel.dataset.sec : 'appearance';
  /** 首屏分区名：init 只给它恢复一次，避免用户在异步初始化期间已经切走又被拉回 */
  const initialSection = activeSection;
  /** 落盘节流句柄：滚动过程中不反复写 localStorage，避免同步写拖慢滚动 */
  let scrollWriteTimer = null;

  /** 读取已保存的滚动位置；数据损坏或 localStorage 被禁用时静默降级为空表 */
  function readScrollMemo() {
    try {
      const raw = window.localStorage.getItem(SCROLL_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const out = {};
      for (const key of Object.keys(data)) {
        const pos = Number(data[key]);
        // 只接受已登记分区名与有限非负数，其余脏数据直接丢弃
        if (SEC_LABELS[key] && Number.isFinite(pos) && pos > 0) out[key] = Math.round(pos);
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 立即落盘（写失败同样静默降级：配额满 / 隐私模式禁用都不该影响设置页） */
  function writeScrollMemo() {
    if (scrollWriteTimer) {
      clearTimeout(scrollWriteTimer);
      scrollWriteTimer = null;
    }
    try {
      window.localStorage.setItem(SCROLL_KEY, JSON.stringify(scrollMemo));
    } catch {
      /* 忽略：记忆功能降级为「仅本次窗口内有效」 */
    }
  }

  function scheduleScrollWrite() {
    if (scrollWriteTimer) clearTimeout(scrollWriteTimer);
    scrollWriteTimer = setTimeout(() => {
      scrollWriteTimer = null;
      writeScrollMemo();
    }, 200);
  }

  /**
   * 取分区的滚动容器。
   * 「网络与代理」分区没有 .sec-scroll（它内部是 proxy-center.css 的 .layout /
   * .panel-side / .panel-main 多层容器，由 proxy-center.js 自己管理），
   * 这里返回 null 即不参与记忆，避免与它内部的滚动容器互相覆盖。
   */
  function scrollBoxOf(section) {
    const panel = panels.find((node) => node.dataset.sec === section);
    if (!panel) return null;
    return panel.querySelector('.sec-scroll');
  }

  /** 记下某分区当前位置；回到顶部时清除记录，保持「首次进入为 0」的语义 */
  function rememberScroll(section) {
    const box = scrollBoxOf(section);
    if (!box) return;
    const pos = Math.max(0, Math.round(box.scrollTop));
    if (pos > 0) scrollMemo[section] = pos;
    else delete scrollMemo[section];
    scheduleScrollWrite();
  }

  /** 切回分区时恢复一次；之后用户怎么滚都不再干预（不监听后重设） */
  function restoreScroll(section) {
    const box = scrollBoxOf(section);
    if (!box) return;
    box.scrollTop = scrollMemo[section] || 0;
  }

  /** 每个滚动容器各挂一个监听，仅当所属分区可见时才记录，避免后台分区被写脏 */
  function bindScrollMemory() {
    for (const panel of panels) {
      const box = panel.querySelector('.sec-scroll');
      if (!box) continue;
      box.addEventListener(
        'scroll',
        () => {
          if (panel.dataset.sec !== activeSection) return;
          const pos = Math.max(0, Math.round(box.scrollTop));
          if (pos > 0) scrollMemo[panel.dataset.sec] = pos;
          else delete scrollMemo[panel.dataset.sec];
          scheduleScrollWrite();
        },
        { passive: true },
      );
    }
    // 关窗时补写一次：节流窗口内最后一段滚动也不丢
    window.addEventListener('beforeunload', () => {
      rememberScroll(activeSection);
      writeScrollMemo();
    });
  }

  let appInfo = null;
  let uiPrefs = null;
  let appearanceReady = false;
  let privacyReady = false;
  // 扩展分区首次进入时才拉清单：装载状态与文件系统耦合，进分区时读一次最新值
  let extensionsReady = false;

  function setStatus(text, isError = false) {
    if (!statusbarEl) return;
    statusbarEl.textContent = text;
    statusbarEl.classList.remove('ok', 'error');
    statusbarEl.classList.toggle('error', Boolean(isError));
    if (!isError) statusbarEl.classList.add('ok');
    // 成功提示 3 秒后恢复就绪，避免状态条长期滞留旧文案
    if (statusbarEl._timer) clearTimeout(statusbarEl._timer);
    if (!isError) {
      statusbarEl._timer = setTimeout(() => {
        statusbarEl.textContent = '就绪';
        statusbarEl.classList.remove('ok');
      }, 3000);
    }
  }

  function permissionText(name) {
    const key = String(name || 'unknown');
    return PERMISSION_CN[key] ? `${PERMISSION_CN[key]}（${key}）` : key;
  }

  function formatTime(value) {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return String(value);
    }
  }

  function escapeText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function renderKvGrid(container, pairs) {
    if (!container) return;
    container.textContent = '';
    for (const [key, value] of pairs) {
      const item = document.createElement('div');
      item.className = 'kv-item';

      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = key;

      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = escapeText(value);
      v.title = escapeText(value);

      item.appendChild(k);
      item.appendChild(v);
      container.appendChild(item);
    }
  }

  /** 生成一行说明文字（列表空态 / 失败提示用，避免重复 createElement 样板） */
  function hintLine(text) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = escapeText(text);
    return p;
  }

  /** 字节数转人类可读（更新源占用看板用；与主进程口径无关，只做展示） */
  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = n;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  /* ------------------------------------------------------------------ */
  /* 分区导航                                                            */
  /* ------------------------------------------------------------------ */

  function activate(section) {
    if (!SEC_LABELS[section]) return;

    // 切走前先记住上一个分区的位置；重复点同一个分区不做任何搬动，避免把位置倒回去
    if (activeSection !== section) rememberScroll(activeSection);

    for (const btn of navEl.querySelectorAll('.nav-item')) {
      btn.classList.toggle('active', btn.dataset.sec === section);
    }
    for (const panel of panels) {
      panel.classList.toggle('active', panel.dataset.sec === section);
    }
    activeSection = section;

    // 面板此刻才由 display:none 变可见，只能在这里恢复一次位置
    restoreScroll(section);

    setStatus(`已进入「${SEC_LABELS[section]}」`);

    // 通知「网络与代理」分区脚本：它据此按需加载代理数据，且只在自身分区可见时才写状态栏
    document.dispatchEvent(new CustomEvent('nyx:section-change', { detail: section }));

    if (section === 'privacy' && !privacyReady) {
      loadPrivacy();
    }

    // 扩展清单按需拉取：装载状态与文件系统耦合，进分区时读一次最新值
    if (section === 'extensions') {
      if (!extensionsReady) loadExtensions();
      // 版本历史独立于已装清单（只依赖更新源），每次进入都刷一次（v1.16.0）
      loadExtensionHistory();
    }

    // 地址栏置顶列表（v1.12.0）：进外观分区时读一次最新值
    if (section === 'appearance') {
      loadPinnedList();
      wirePinnedIo();
      // 抓包慢请求阈值（v1.16.0）：与工具箱共用主进程偏好，进入分区就回读
      loadSlowMs();
    }

    // 更新状态每次进入都刷一次：版本与升级包状态随时可能被后台改变
    if (section === 'about') {
      refreshUpdateStatus();
      // 更新源占用（v1.16.0）：体积随发版变化，每次进来重新统计
      loadFootprint();
    }
  }

  navEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.nav-item');
    if (!btn) return;
    activate(btn.dataset.sec);
  });

  /* ------------------------------------------------------------------ */
  /* 外观：顶栏元素显隐（真实影响主窗口）                                 */
  /* ------------------------------------------------------------------ */

  async function loadUiPrefs() {
    const res = await window.nyx.getUiPrefs();
    uiPrefs = res && res.ui ? res.ui : null;
    if (!uiPrefs) {
      byId('appearance-state').textContent = '读取失败';
      return;
    }
    byId('pref-show-link-badge').checked = uiPrefs.showLinkBadge !== false;
    byId('pref-show-mode-switch').checked = uiPrefs.showModeSwitch !== false;
    // 主题回填 + 设置窗口自身立即换肤（主窗口由主进程 pushState 同步）
    byId('pref-theme').value = uiPrefs.theme || 'ink';
    document.documentElement.dataset.theme = uiPrefs.theme || 'ink';
    byId('appearance-state').textContent = '已生效';
  }

  async function saveUiPref(key, value) {
    const res = await window.nyx.setUiPref(key, value);
    if (!res || !res.ok) {
      setStatus(`保存失败：${(res && res.error) || '未知原因'}`);
      await loadUiPrefs();
      return;
    }
    uiPrefs = res.ui;
    const label = key === 'showLinkBadge' ? '出站链路徽标' : '隐私模式开关';
    byId('appearance-hint').textContent = `${label}已${value ? '显示' : '隐藏'}，主窗口顶栏已同步。`;
    setStatus('外观设置已更新');
  }

  byId('pref-show-link-badge').addEventListener('change', (event) => {
    saveUiPref('showLinkBadge', event.target.checked);
  });

  byId('pref-show-mode-switch').addEventListener('change', (event) => {
    saveUiPref('showModeSwitch', event.target.checked);
  });

  // 主题切换：只写偏好，主窗口由主进程 pushState 同步；设置窗口自己立即换肤
  byId('pref-theme').addEventListener('change', async (event) => {
    const theme = event.target.value;
    const res = await window.nyx.setUiPref('theme', theme);
    if (!res || !res.ok) {
      setStatus(`主题切换失败：${(res && res.error) || '未知原因'}`);
      await loadUiPrefs();
      return;
    }
    uiPrefs = res.ui;
    document.documentElement.dataset.theme = theme;
    byId('appearance-hint').textContent = `主题已切换为${
      event.target.selectedOptions[0].textContent
    }，主窗口已同步。`;
    setStatus('主题已切换');
  });

  byId('btn-appearance-reset').addEventListener('click', async () => {
    await saveUiPref('showLinkBadge', true);
    await saveUiPref('showModeSwitch', true);
    await saveUiPref('theme', 'ink');
    await loadUiPrefs();
    byId('appearance-hint').textContent = '已恢复默认外观：墨夜主题，顶栏显示链路徽标与模式开关。';
    setStatus('外观已恢复默认');
  });

  /* ------------------------------------------------------------------ */
  /* 隐私与安全                                                          */
  /* ------------------------------------------------------------------ */

  function renderPrivacy(status) {
    const badge = byId('privacy-badge');
    const grid = byId('privacy-grid');

    if (!status || status.ok === false) {
      badge.textContent = '不可用';
      badge.classList.remove('bad');
      renderKvGrid(grid, [['状态', (status && status.error) || '隐私模块未就绪']]);
      return;
    }

    const hardening = status.hardening || {};
    const network = status.network || {};
    const vault = status.vault || {};
    const permissions = status.permissions || {};

    const hardened = hardening.hardened === true || status.mode === 'private';
    badge.textContent = hardened ? '隐私加固已装配' : '当前为普通模式';

    const linkText = network.link === 'proxy' ? '代理' : network.link === 'direct' ? '直连' : '未知';

    renderKvGrid(grid, [
      ['当前模式', status.mode === 'private' ? '全隐私模式' : '普通模式'],
      ['出站链路', linkText],
      ['代理端口', status.proxyPort || '—'],
      ['WebRTC 策略', status.webrtcPolicy || '—'],
      ['加固装配', hardening.hardened === true ? '已装配' : hardened ? '随模式生效' : '未装配'],
      ['记住的授权', `${permissions.rememberedAllow || 0} 允许 / ${permissions.rememberedDeny || 0} 拒绝`],
      ['密码条目', vault.credentialCount ?? vault.credentials ?? 0],
      ['表单记忆', vault.formCount ?? vault.forms ?? 0],
      ['加密后端', vault.backend || '—'],
      ['加密可用', vault.available ? '是' : '否'],
    ]);

    // 用 toggle 而非 add：模式切回普通后红标必须跟着消失
    badge.classList.toggle('bad', vault.hardened === false && status.mode === 'private');
  }

  function renderPermissionDecisions(view) {
    const badge = byId('perm-badge');
    const wrap = byId('perm-table-wrap');
    wrap.textContent = '';

    const summary = (view && view.summary) || {};
    const decisions = (view && view.decisions) || [];
    badge.textContent = `本会话决策 ${summary.decisions ?? decisions.length} 条`;

    if (!decisions.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = '本会话尚未发生权限请求。站点申请摄像头、定位、通知等权限时，决策会记录在这里。';
      wrap.appendChild(note);
      return;
    }

    const table = document.createElement('table');
    table.className = 'mini-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const title of ['时间', '分区', '来源', '权限', '结果', '依据']) {
      const th = document.createElement('th');
      th.textContent = title;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    for (const item of decisions) {
      const row = document.createElement('tr');

      const cells = [
        { text: formatTime(item.at), className: 'mono' },
        { text: item.mode === 'private' ? '隐私' : '普通' },
        { text: item.origin || '—' },
        { text: permissionText(item.permission) },
        { text: item.granted ? '允许' : '拒绝', pill: item.granted ? 'ok' : 'bad' },
        { text: item.via || '—', className: 'mono' },
      ];

      for (const cell of cells) {
        const td = document.createElement('td');
        if (cell.pill) {
          const span = document.createElement('span');
          span.className = `pill ${cell.pill}`;
          span.textContent = cell.text;
          td.appendChild(span);
        } else {
          td.textContent = cell.text;
        }
        if (cell.className) td.classList.add(cell.className);
        row.appendChild(td);
      }

      body.appendChild(row);
    }
    table.appendChild(body);
    wrap.appendChild(table);
  }

  function renderVault(entries) {
    const badge = byId('vault-badge');
    const wrap = byId('vault-table-wrap');
    wrap.textContent = '';

    const credentials = (entries && entries.credentials) || [];
    const forms = (entries && entries.forms) || [];
    badge.textContent = `${credentials.length} 个站点密码 / ${forms.length} 份表单记忆`;

    if (!credentials.length && !forms.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = '密码库为空。页面提交登录表单并选择记住后，条目会出现在这里。';
      wrap.appendChild(note);
      return;
    }

    const table = document.createElement('table');
    table.className = 'mini-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const title of ['类型', '来源', '内容', '更新时间', '操作']) {
      const th = document.createElement('th');
      th.textContent = title;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');

    for (const entry of credentials) {
      const row = document.createElement('tr');

      const typeCell = document.createElement('td');
      typeCell.textContent = '站点密码';
      row.appendChild(typeCell);

      const originCell = document.createElement('td');
      originCell.textContent = entry.origin || '—';
      row.appendChild(originCell);

      const contentCell = document.createElement('td');
      contentCell.textContent = entry.usernameHint ? `用户名 ${entry.usernameHint}` : '（无用户名）';
      row.appendChild(contentCell);

      const timeCell = document.createElement('td');
      timeCell.className = 'mono';
      timeCell.textContent = formatTime(entry.updatedAt || entry.at);
      row.appendChild(timeCell);

      const actionCell = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-mini btn-danger';
      btn.textContent = '删除';
      btn.addEventListener('click', () => removeCredential(entry.origin));
      actionCell.appendChild(btn);
      row.appendChild(actionCell);

      body.appendChild(row);
    }

    for (const entry of forms) {
      const row = document.createElement('tr');

      const typeCell = document.createElement('td');
      typeCell.textContent = '表单记忆';
      row.appendChild(typeCell);

      const originCell = document.createElement('td');
      originCell.textContent = entry.origin || '—';
      row.appendChild(originCell);

      const contentCell = document.createElement('td');
      contentCell.textContent = `${entry.fields || 0} 个字段`;
      row.appendChild(contentCell);

      const timeCell = document.createElement('td');
      timeCell.className = 'mono';
      timeCell.textContent = formatTime(entry.updatedAt);
      row.appendChild(timeCell);

      const actionCell = document.createElement('td');
      actionCell.textContent = '—';
      row.appendChild(actionCell);

      body.appendChild(row);
    }

    table.appendChild(body);
    wrap.appendChild(table);
  }

  async function loadPrivacy() {
    setStatus('正在读取隐私状态…');

    try {
      const [status, decisions, entries] = await Promise.all([
        window.nyx.getPrivacyStatus(),
        window.nyx.listPermissionDecisions(50),
        window.nyx.listVaultEntries(),
      ]);

      renderPrivacy(status);
      renderPermissionDecisions(decisions);
      renderVault(entries);

      // 标记位只在真正拿到数据后置位：中途失败要允许用户重进分区重试
      privacyReady = true;
      setStatus('隐私与安全：状态已刷新');
    } catch (error) {
      privacyReady = false;
      setStatus(`读取隐私与安全状态失败：${(error && error.message) || error}`, true);
    }
  }

  async function removeCredential(origin) {
    if (!origin) return;
    if (!window.confirm(`删除该站点的已保存密码？\n\n${origin}\n\n此操作不可撤销。`)) return;

    const res = await window.nyx.removeVaultEntry(origin);
    if (!res || !res.ok) {
      setStatus(`删除失败：${(res && res.error) || '未知原因'}`);
      return;
    }
    setStatus(`已删除 ${origin} 的密码`);
    await loadPrivacy();
  }

  byId('btn-privacy-refresh').addEventListener('click', () => loadPrivacy());
  byId('btn-vault-refresh').addEventListener('click', () => loadPrivacy());

  byId('btn-perm-clear').addEventListener('click', async () => {
    if (!window.confirm('清空本会话「按站点记住的授权」？\n\n不会删除站点数据、Cookie 或缓存，仅让站点下次重新询问。')) return;
    const res = await window.nyx.clearPermissionCache();
    if (!res || !res.ok) {
      setStatus(`清空失败：${(res && res.error) || '未知原因'}`);
      return;
    }
    setStatus('已清空按站点记住的授权');
    await loadPrivacy();
  });

  byId('btn-vault-clear').addEventListener('click', async () => {
    if (!window.confirm('清空全部密码与表单记忆？\n\n该操作不可撤销，所有已保存的站点密码与表单记忆都会被删除。')) return;
    const res = await window.nyx.clearVault();
    if (!res || !res.ok) {
      setStatus(`清空失败：${(res && res.error) || '未知原因'}`);
      return;
    }
    setStatus('密码库已清空');
    await loadPrivacy();
  });

  /* ------------------------------------------------------------------ */
  /* 启动与主页 / 下载 / 关于                                            */
  /* ------------------------------------------------------------------ */

  /** 启动方式 → 中文（取值与 core/startup-store.js 一一对应） */
  const STARTUP_MODE_CN = {
    newTab: '打开新标签页',
    blank: '打开空白页',
    custom: '打开指定网页',
  };

  let startupPrefs = null;

  /** 按行读取指定启动页：去空行、去重复（与主进程侧收敛口径一致） */
  function readStartupUrls() {
    const raw = (byId('home-startup-urls') && byId('home-startup-urls').value) || '';
    const seen = new Set();
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const url = line.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  /** 回显「启动与主页」：输入框、启动方式单选、指定启动页与当前生效值 */
  function renderStartup(result) {
    if (!result || result.ok === false) {
      byId('home-newtab-badge').textContent = '不可用';
      byId('home-startup-badge').textContent = '不可用';
      byId('home-hint').textContent = `读取失败：${(result && result.error) || '未知原因'}`;
      return;
    }

    startupPrefs = result.prefs || {};
    const effective = result.effective || {};
    const mode = startupPrefs.startupMode || 'newTab';
    const urls = startupPrefs.startupUrls || [];

    byId('home-newtab-url').value = startupPrefs.newTabUrl || '';
    byId('startup-mode-newtab').checked = mode === 'newTab';
    byId('startup-mode-blank').checked = mode === 'blank';
    byId('startup-mode-custom').checked = mode === 'custom';
    byId('home-startup-urls').value = urls.join('\n');
    byId('startup-urls-row').hidden = mode !== 'custom';

    byId('home-newtab-badge').textContent = startupPrefs.newTabUrl ? '已自定义' : '空白页';
    byId('home-startup-badge').textContent =
      mode === 'blank' ? '空白页' : mode === 'custom' ? `指定 ${urls.length} 条` : '新标签页';

    renderKvGrid(byId('startup-grid'), [
      ['新标签页实际地址', effective.newTabUrl || 'about:blank'],
      ['启动方式', STARTUP_MODE_CN[mode] || mode],
      ['启动时打开', (effective.startupTargets || []).join('  ｜  ') || '—'],
      [
        '地址来源',
        startupPrefs.newTabUrl ? '设置中心' : effective.fromEnv === false ? '空白页' : '环境变量 / 空白页',
      ],
      ['标签上限', `${(appInfo && appInfo.maxTabs) || '—'} 个`],
    ]);
    byId('startup-badge').textContent = '已生效';
  }

  async function loadStartupPrefs() {
    const res = await window.nyx.getStartupPrefs();
    renderStartup(res);
    return res;
  }

  async function applyStartupPrefs() {
    if (!window.nyx.setStartupPrefs) {
      byId('home-hint').textContent = '当前版本不支持该设置（主进程接口未就绪）。';
      setStatus('启动与主页配置不可用', true);
      return;
    }

    const mode = byId('startup-mode-custom').checked
      ? 'custom'
      : byId('startup-mode-blank').checked
        ? 'blank'
        : 'newTab';
    const urls = readStartupUrls();

    const res = await window.nyx.setStartupPrefs({
      newTabUrl: byId('home-newtab-url').value || '',
      startupMode: mode,
      startupUrls: urls,
    });

    if (!res || !res.ok) {
      byId('home-hint').textContent = `保存失败：${(res && res.error) || '未知原因'}`;
      setStatus('启动与主页配置保存失败');
      return;
    }

    renderStartup(res);
    byId('home-hint').textContent =
      mode === 'custom' && urls.length === 0
        ? '已保存：指定网页为空，启动时改为打开新标签页。'
        : '已保存：新标签页地址立即生效，启动方式与指定启动页在下次启动生效。';
    setStatus('启动与主页配置已更新');
  }

  for (const value of ['newTab', 'blank', 'custom']) {
    // 取值驼峰、元素 id 全小写，这里统一转小写再取元素
    byId(`startup-mode-${value.toLowerCase()}`).addEventListener('change', () => {
      byId('startup-urls-row').hidden = !byId('startup-mode-custom').checked;
    });
  }

  byId('btn-home-apply').addEventListener('click', () => applyStartupPrefs());

  byId('btn-home-reset').addEventListener('click', async () => {
    if (!window.confirm('恢复默认启动与主页配置？\n\n新标签页回到空白页，启动时打开新标签页，已填写的指定启动页会被清空。'))
      return;

    const res = await window.nyx.resetStartupPrefs();
    if (!res || !res.ok) {
      byId('home-hint').textContent = `恢复默认失败：${(res && res.error) || '未知原因'}`;
      setStatus('启动与主页恢复默认失败');
      return;
    }
    renderStartup(res);
    byId('home-hint').textContent = '已恢复默认：新标签为空白页、启动打开新标签页。';
    setStatus('启动与主页已恢复默认');
  });

  // 输入框里回车即保存，省一次点击
  byId('home-newtab-url').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyStartupPrefs();
  });

  async function loadAppInfo() {
    const res = await window.nyx.getAppInfo();
    if (!res || res.ok === false) {
      byId('nav-version').textContent = '—';
      return;
    }
    appInfo = res;

    byId('nav-version').textContent = res.version ? `v${res.version}` : '—';

    // 「启动与主页」的当前生效值统一由 renderStartup 渲染（含配置与兜底口径）

    renderKvGrid(byId('about-grid'), [
      ['版本', res.version ? `v${res.version}` : '—'],
      ['内核', `Electron ${res.electron || '—'} / Chromium ${res.chrome || '—'}`],
      ['Node', res.node || '—'],
      ['运行平台', `${res.platform || '—'} ${res.arch || ''}`.trim()],
      ['用户数据目录', res.userData || '—'],
      ['安装目录', res.installDir || '—'],
    ]);
  }

  byId('btn-about').addEventListener('click', () => window.nyx.showAbout());


  /* ------------------------------------------------------------------ */
  /* 关于与更新                                                          */
  /* 从 proxy-center.js 迁入：软件更新属于本分区，不该寄生在网络代理脚本里 */
  /* ------------------------------------------------------------------ */

  function renderUpdate(state) {
    if (!state) return;

    const badge = byId('update-badge');
    const hint = byId('update-hint');
    const progress = byId('update-progress');
    const progressBar = byId('update-progress-bar');
    const btnCheck = byId('btn-check-update');
    const btnInstall = byId('btn-install-update');
    if (!badge || !hint) return;

    badge.textContent = `当前版本 ${state.currentVersion ? `v${state.currentVersion}` : '—'}`;

    const lines = [];
    if (state.latestVersion) lines.push(`最新版本：${state.latestVersion}`);
    if (state.source) lines.push(`更新源：${state.source}`);

    if (state.phase === 'downloading') {
      lines.push(`正在获取升级包：${state.progress}%`);
    } else if (state.phase === 'ready') {
      lines.push('升级包已就绪，可立即重启安装。');
    } else if (state.phase === 'uptodate') {
      lines.push('已是最新版本。');
    } else if (state.error) {
      lines.push(`上次检查出错：${state.error}`);
    }

    if (!lines.length) {
      lines.push('点「检查更新」查看是否有新版本。升级为覆盖安装：订阅、偏好与密码库都会保留。');
    }
    if (state.notes) lines.push('', `更新说明：${state.notes}`);

    hint.textContent = lines.join('\n');

    const downloading = state.phase === 'downloading';
    if (progress) progress.hidden = !downloading;
    if (downloading && progressBar) progressBar.style.width = `${state.progress}%`;
    if (btnCheck) btnCheck.disabled = downloading;
    if (btnInstall) btnInstall.hidden = !(state.phase === 'ready' && state.readyFile);
  }

  async function refreshUpdateStatus() {
    if (!window.nyx.getUpdateStatus) return;
    try {
      renderUpdate(await window.nyx.getUpdateStatus());
    } catch (error) {
      setStatus(`读取更新状态失败：${(error && error.message) || error}`, true);
    }
  }

  byId('btn-check-update').addEventListener('click', async () => {
    const btn = byId('btn-check-update');
    btn.disabled = true;
    setStatus('正在检查应用与扩展更新…');
    try {
      // v1.12.0：统一入口——一次把「应用更新」和「扩展更新」都查了
      if (window.nyx.checkAllUpdates) {
        const all = await window.nyx.checkAllUpdates();
        const appResult = all && all.app;
        const extResult = (all && all.extensions) || {};
        const appText =
          appResult && appResult.ok && appResult.hasUpdate
            ? `应用有新版本 ${appResult.latestVersion}（已弹出升级提示）`
            : appResult && appResult.ok
              ? `应用已是最新（${appResult.currentVersion}）`
              : `应用检查失败：${(appResult && appResult.error) || '未知原因'}`;
        const extText = extResult.ok
          ? extResult.updatable > 0
            ? `扩展有 ${extResult.updatable} 个更新（到「扩展插件」卡片点「全部更新」）`
            : '扩展均为最新'
          : '扩展检查不可用';
        setStatus(`${appText}；${extText}`);
        await refreshUpdateStatus();
        return;
      }

      // 兜底：老版本 preload 没有 checkAllUpdates 时退回只查应用
      const result = await window.nyx.checkForUpdates();
      if (result && result.ok && result.hasUpdate) {
        setStatus(`发现新版本 ${result.latestVersion}，已弹出升级提示`);
      } else if (result && result.ok) {
        setStatus(`当前已是最新版本（${result.currentVersion}）`);
      } else {
        setStatus(`检查更新失败：${(result && result.error) || '未知原因'}`, true);
      }
    } catch (error) {
      setStatus(`检查更新失败：${(error && error.message) || error}`, true);
    } finally {
      btn.disabled = false;
      await refreshUpdateStatus();
    }
  });

  byId('btn-install-update').addEventListener('click', async () => {
    const btn = byId('btn-install-update');
    btn.disabled = true;
    try {
      const result = await window.nyx.installUpdate();
      if (result && result.ok) {
        setStatus('正在退出并安装升级包，装完会自动重新打开…');
      } else {
        setStatus(`安装失败：${(result && result.error) || '未知原因'}`, true);
        btn.disabled = false;
      }
    } catch (error) {
      setStatus(`安装失败：${(error && error.message) || error}`, true);
      btn.disabled = false;
    }
  });

  byId('btn-update-folder').addEventListener('click', () => window.nyx.openUpdateFolder());

  // 订阅放模块顶层而非 activate()：后台推送（下载进度 / 升级包就绪）必须能实时落到界面
  if (window.nyx.onUpdateState) {
    window.nyx.onUpdateState((state) => renderUpdate(state));
  }


  /* ------------------------------------------------------------------ */
  /* 扩展插件（导入 / 启停 / 删除）                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 支持度评级文案。
   * 评级由主进程按扩展实际声明的能力算出（内容脚本 / 后台形态 / 网络拦截权限），
   * 界面只做展示，不在渲染层重新推断——两边算法若各写一份必然会漂移。
   */
  const EXT_LEVEL_TEXT = {
    high: '支持度 高',
    medium: '支持度 中',
    low: '支持度 低',
  };

  /** 导入 / 操作的统一反馈：错误写进提示区，成功则整表重绘（清单以主进程为准） */
  async function runExtAction(label, run) {
    setStatus(`${label}…`);
    const res = await run();

    if (res && res.canceled) {
      setStatus(`${label}已取消`);
      return null;
    }
    if (!res || !res.ok) {
      const message = (res && res.error) || '未知原因';
      if (res && Array.isArray(res.items)) renderExtensions(res.items);
      byId('ext-import-hint').textContent = `${label}失败：${message}`;
      setStatus(`${label}失败：${message}`);
      return null;
    }
    if (Array.isArray(res.items)) renderExtensions(res.items);
    return res;
  }

  function renderExtensions(items) {
    const listEl = byId('ext-list');
    listEl.textContent = '';

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = '还没有导入任何扩展。点上方「导入已解压目录」或「导入 .crx / .zip 包」开始。';
      listEl.appendChild(empty);
    } else {
      for (const item of items) listEl.appendChild(buildExtensionRow(item));
    }

    const enabled = items.filter((item) => item.enabled).length;
    const loaded = items.filter((item) => item.loaded).length;
    byId('ext-count').textContent = items.length
      ? `${items.length} 个（启用 ${enabled} · 已装载 ${loaded}）`
      : '0 个';
  }

  /** 单个扩展卡片（全部用 DOM API 拼装：扩展名称/描述来自外部文件，不进 innerHTML） */
  function buildExtensionRow(item) {
    const caps = item.capabilities || {};

    const row = document.createElement('div');
    row.className = 'ext-item';

    const head = document.createElement('div');
    head.className = 'ext-item-head';

    const name = document.createElement('span');
    name.className = 'ext-name';
    name.textContent = item.name;

    const version = document.createElement('span');
    version.className = 'badge';
    version.textContent = `v${item.version} · MV${item.manifestVersion}`;

    const level = document.createElement('span');
    level.className = `ext-level ext-level-${caps.level || 'medium'}`;
    level.textContent = EXT_LEVEL_TEXT[caps.level] || EXT_LEVEL_TEXT.medium;

    const state = document.createElement('span');
    state.className = `ext-state ${item.loaded ? 'on' : 'off'}`;
    if (!item.enabled) state.textContent = '已停用';
    else state.textContent = item.loaded ? '已启用 · 已装载' : '已启用 · 未装载';

    const actions = document.createElement('span');
    actions.className = 'ext-actions';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-mini';
    toggle.textContent = item.enabled ? '停用' : '启用';
    toggle.addEventListener('click', () => toggleExtension(item));
    actions.appendChild(toggle);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-mini';
    remove.textContent = '删除';
    remove.addEventListener('click', () => removeExtension(item));
    actions.appendChild(remove);

    head.append(name, version, level, state, actions);
    row.appendChild(head);

    if (item.description) {
      const desc = document.createElement('p');
      desc.className = 'ext-desc';
      desc.textContent = item.description;
      row.appendChild(desc);
    }

    const from = document.createElement('p');
    from.className = 'ext-meta';
    from.textContent = `${item.source === 'crx' ? '安装包导入' : '目录导入'} · 作用范围：普通模式 · 仓库路径：${item.dir}`;
    row.appendChild(from);

    if (item.lastError) {
      const failed = document.createElement('p');
      failed.className = 'ext-error';
      failed.textContent = `装载失败：${item.lastError}`;
      row.appendChild(failed);
    }

    const warnings = Array.isArray(caps.warnings) ? caps.warnings : [];
    if (warnings.length) {
      const list = document.createElement('ul');
      list.className = 'ext-warn';
      for (const text of warnings) {
        const li = document.createElement('li');
        li.textContent = text;
        list.appendChild(li);
      }
      row.appendChild(list);
    }

    return row;
  }

  async function loadExtensions(notice) {
    const res = await window.nyx.listExtensions();
    if (!res || !res.ok) {
      extensionsReady = false;
      byId('ext-count').textContent = '读取失败';
      const listEl = byId('ext-list');
      listEl.textContent = '';
      const failed = document.createElement('p');
      failed.className = 'hint';
      failed.textContent = `扩展清单读取失败：${(res && res.error) || '未知原因'}`;
      listEl.appendChild(failed);
      return;
    }

    extensionsReady = true;
    renderExtensions(res.items || []);
    if (res.storePath) {
      byId('ext-store-path').textContent = `扩展仓库：${res.storePath}`;
    }
    if (notice) setStatus(notice);
  }

  /* ---------------- 扩展版本历史（v1.16.0） ---------------- */
  /*
     更新源里每个扩展可以带最近几个发布版本的历史（发布端写进 extensions.json）。
     这里只做展示与回滚：读、装都走主进程，设置页不碰文件系统。
  */

  async function loadExtensionHistory() {
    const box = byId('ext-history-list');
    const countEl = byId('ext-history-count');
    if (!box) return;

    if (typeof window.nyx.extOnlineHistory !== 'function') {
      if (countEl) countEl.textContent = '不支持';
      box.textContent = '';
      box.appendChild(hintLine('当前内核不支持读取扩展版本历史。'));
      return;
    }

    box.textContent = '';
    box.appendChild(hintLine('正在读取版本历史…'));

    const res = await window.nyx.extOnlineHistory().catch(() => null);
    box.textContent = '';

    // 主进程会给出中文原因（更新源未配置 / 没有 extensions.json），原样透出即可
    if (!res || res.ok === false) {
      if (countEl) countEl.textContent = '读取失败';
      box.appendChild(hintLine(`读取版本历史失败：${(res && res.error) || '未知原因'}`));
      return;
    }

    const items = Array.isArray(res.items) ? res.items : [];
    let versionCount = 0;
    for (const entry of items) {
      if (Array.isArray(entry.history)) versionCount += entry.history.length;
    }
    if (countEl) countEl.textContent = `${items.length} 个扩展 · ${versionCount} 个版本`;

    if (!items.length) {
      box.appendChild(hintLine('更新源里没有扩展清单（extensions.json 未配置）。'));
      return;
    }
    for (const entry of items) box.appendChild(buildHistoryItem(entry));
  }

  function buildHistoryItem(entry) {
    const row = document.createElement('div');
    row.className = 'ext-item';

    const head = document.createElement('div');
    head.className = 'ext-item-head';

    const name = document.createElement('span');
    name.className = 'ext-name';
    name.textContent = entry.name || entry.key || '扩展';
    head.appendChild(name);

    const state = document.createElement('span');
    state.className = entry.installedVersion ? 'ext-state on' : 'ext-state';
    state.textContent = entry.installedVersion ? `已安装 v${entry.installedVersion}` : '未安装';
    head.appendChild(state);

    const current = document.createElement('span');
    current.className = 'ext-meta';
    current.textContent = `更新源当前版本 v${entry.version || '—'}`;
    head.appendChild(current);
    row.appendChild(head);

    const versions = document.createElement('div');
    versions.className = 'ext-history-versions';
    const history = Array.isArray(entry.history) ? entry.history : [];
    if (!history.length) {
      versions.appendChild(hintLine('这个扩展在更新源里只有当前版本，没有可回滚的历史版本。'));
    } else {
      for (const version of history) versions.appendChild(buildHistoryVersionRow(entry, version));
    }
    row.appendChild(versions);
    return row;
  }

  function buildHistoryVersionRow(entry, version) {
    // 「装没装」和「是不是更新源里的最新版」是两件事：回滚之后最新版并没有被安装，
    // 这里必须按 installed 判断按钮，否则回滚完就再也滚不回去了（v1.16.0 回归修复）
    const installed = !!version.installed;
    const line = document.createElement('div');
    line.className = 'ext-history-row' + (installed ? ' is-current' : '');

    const tag = document.createElement('span');
    tag.className = 'ext-history-ver';
    tag.textContent = `v${version.version}`;
    line.appendChild(tag);

    const meta = document.createElement('span');
    meta.className = 'ext-history-meta';
    const bits = [];
    if (version.size) bits.push(formatBytes(version.size));
    if (version.at) bits.push(formatTime(version.at));
    if (version.current) bits.push('更新源最新');
    if (installed) bits.push('已安装');
    meta.textContent = bits.join(' · ');
    line.appendChild(meta);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-mini';
    if (installed) {
      // 已安装的这一版不需要再回滚，但保留在列表里便于对照
      btn.textContent = version.current ? '当前版本' : '已安装版本';
      btn.disabled = true;
    } else if (version.current) {
      // 最新版没装（典型情况：刚回滚到旧版）：这一版不能走「回滚」，
      // 主进程会直接拒绝（回滚只认历史版本），要走在线安装那条路
      btn.textContent = '更新到此版本';
      btn.addEventListener('click', () => applyLatestVersion(entry, btn));
    } else {
      btn.textContent = '回滚到此版本';
      btn.addEventListener('click', () => rollbackExtensionTo(entry, version.version, btn));
    }
    line.appendChild(btn);
    return line;
  }

  /** 装回更新源里的当前版本（回滚之后想滚回去时用） */
  async function applyLatestVersion(entry, btn) {
    if (typeof window.nyx.extOnlineInstall !== 'function') {
      setStatus('当前内核不支持在线安装扩展', true);
      return;
    }
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '更新中…';
    const res = await window.nyx.extOnlineInstall({ key: entry.key }).catch(() => null);
    if (!res || res.ok === false) {
      btn.disabled = false;
      btn.textContent = original;
      setStatus(`更新失败：${(res && res.error) || '未知原因'}`, true);
      return;
    }
    setStatus(`已把「${entry.name || entry.key}」更新到 v${entry.version || '—'}`);
    await loadExtensionHistory();
    await loadExtensions();
  }

  async function rollbackExtensionTo(entry, version, btn) {
    if (typeof window.nyx.extOnlineRollback !== 'function') {
      setStatus('当前内核不支持回滚扩展版本', true);
      return;
    }
    const label = entry.name || entry.key || '扩展';
    const confirmed = window.confirm(
      `确定把「${label}」回滚到 v${version}？\n当前已安装的版本会被覆盖，扩展自己的配置与存储保留。`,
    );
    if (!confirmed) return;

    // 回滚要重新下载并装载扩展，期间禁用按钮避免重复点击
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '回滚中…';
    const res = await window.nyx.extOnlineRollback({ key: entry.key, version }).catch(() => null);
    if (!res || res.ok === false) {
      btn.disabled = false;
      btn.textContent = original;
      setStatus(`回滚失败：${(res && res.error) || '未知原因'}`, true);
      return;
    }
    const restored = res.restored || {};
    setStatus(`已回滚「${restored.name || label}」到 v${restored.version || version}，刷新页面后生效`);
    await loadExtensionHistory();
    await loadExtensions();
  }

  const extHistoryRefresh = byId('btn-ext-history-refresh');
  if (extHistoryRefresh) {
    extHistoryRefresh.addEventListener('click', () => {
      loadExtensionHistory();
    });
  }

  /**
   * 「全部更新」（v1.13.0）：把更新源里所有可更新的扩展一次装完。
   * 与「检查更新」里的扩展检查共用同一份 extensions.json。
   */
  const updateAllBtn = byId('btn-ext-update-all');
  if (updateAllBtn && window.nyx.extOnlineUpdateAll) {
    updateAllBtn.addEventListener('click', async () => {
      updateAllBtn.disabled = true;
      const original = updateAllBtn.textContent;
      updateAllBtn.textContent = '更新中…';
      setStatus('正在更新全部扩展…');
      try {
        const result = await window.nyx.extOnlineUpdateAll();
        if (!result || result.ok === false) {
          setStatus(`全部更新失败：${(result && result.error) || '未知原因'}`, true);
          return;
        }
        if (!result.total) {
          setStatus('所有扩展都已是最新');
          return;
        }
        const updatedNames = (result.updated || []).map((item) => `${item.name} v${item.version}`).join('、');
        const failedCount = (result.failed || []).length;
        setStatus(
          failedCount
            ? `已更新 ${(result.updated || []).length} 个，失败 ${failedCount} 个（${(result.failed || [])
                .map((item) => `${item.name}：${item.error}`)
                .join('；')}）`
            : `已更新 ${(result.updated || []).length} 个扩展：${updatedNames}`,
          failedCount > 0,
        );
        await loadExtensions('扩展已更新，刷新页面后生效');
      } finally {
        updateAllBtn.disabled = false;
        updateAllBtn.textContent = original;
      }
    });
  }

  /**
   * 地址栏置顶管理（v1.12.0）：拖动或 ↑↓ 调整顺序，× 直接移除。
   * 拖拽用原生 HTML5 drag 事件，不引入任何库；拖动过程中把被拖行做成半透明。
   */
  let pinnedIoWired = false;

  /**
   * 置顶导入 / 导出的按钮接线（v1.15.0）。
   * 只绑一次：进出外观分区不会重复叠加监听；真正的文件对话框在主进程。
   */
  function wirePinnedIo() {
    if (pinnedIoWired) return;
    pinnedIoWired = true;

    const exportBtn = byId('btn-pinned-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        if (!window.nyx.addressSuggestPinnedExport) return;
        const res = await window.nyx.addressSuggestPinnedExport().catch(() => null);
        if (!res) {
          setStatus('导出失败：主进程没有响应', true);
          return;
        }
        if (res.canceled) return;
        if (res.ok === false) {
          setStatus(`导出失败：${res.error || '未知原因'}`, true);
          return;
        }
        setStatus(`已导出 ${res.count} 条置顶到 ${res.path}`);
      });
    }

    const importBtn = byId('btn-pinned-import');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        if (!window.nyx.addressSuggestPinnedImport) return;
        const res = await window.nyx.addressSuggestPinnedImport().catch(() => null);
        if (!res) {
          setStatus('导入失败：主进程没有响应', true);
          return;
        }
        if (res.canceled) return;
        if (res.ok === false) {
          setStatus(`导入失败：${res.error || '未知原因'}`, true);
          return;
        }
        const extra = res.invalid ? `，无效 ${res.invalid} 条` : '';
        if (!res.added) {
          setStatus(`没有新增置顶（跳过 ${res.skipped} 条${extra}），当前共 ${res.total} 条`);
        } else {
          setStatus(`已导入 ${res.added} 条置顶（跳过 ${res.skipped} 条${extra}），当前共 ${res.total} 条`);
        }
        await loadPinnedList();
      });
    }
  }

  /* ---------------- 地址栏置顶分组（v1.16.0） ---------------- */
  /*
     置顶项按「工作 / 学习 / 其他」分组，每组上限 5 条（上限与顺序由主进程判定）。
     组内调顺序用拖动或 ↑ ↓；跨组移动统一走行首的分组下拉，
     避免拖动跨组时既改分组又改顺序、结果难预期。
  */

  const PINNED_GROUP_FALLBACK = [
    { key: 'work', label: '工作' },
    { key: 'study', label: '学习' },
    { key: 'other', label: '其他' },
  ];
  const PINNED_GROUP_MAX = 5;

  async function loadPinnedList() {
    const box = byId('pinned-list');
    const countEl = byId('pinned-count');
    if (!box || !window.nyx.addressSuggestPinned) return;

    const res = await window.nyx.addressSuggestPinned().catch(() => null);
    const items = res && res.ok && Array.isArray(res.items) ? res.items : [];
    // 分组表由主进程下发（旧版内核没有 groups 时退回本地三组，保证界面不空）
    const groups =
      res && res.ok && Array.isArray(res.groups) && res.groups.length ? res.groups : PINNED_GROUP_FALLBACK;
    const groupMax = res && res.ok && Number(res.groupMax) > 0 ? Number(res.groupMax) : PINNED_GROUP_MAX;
    const groupKeys = groups.map((group) => group.key);
    const labelOf = (key) => {
      const hit = groups.find((group) => group.key === key);
      return hit ? hit.label : key;
    };
    const canGroup = typeof window.nyx.addressSuggestPinnedGroupSet === 'function';

    if (countEl) countEl.textContent = `${items.length} / ${groups.length * groupMax}`;
    box.textContent = '';

    if (!items.length) {
      box.appendChild(hintLine('还没有置顶项。在地址栏建议里右键任意一条即可置顶。'));
      return;
    }

    // 老数据可能没有 group 字段（或写了非法值）：统一落到最后一组「其他」
    const fallbackKey = groupKeys[groupKeys.length - 1];
    const buckets = new Map(groupKeys.map((key) => [key, []]));
    for (const item of items) {
      const key = groupKeys.includes(item.group) ? item.group : fallbackKey;
      buckets.get(key).push(item);
    }

    const persistGroup = async (groupKey, order) => {
      const result = await window.nyx
        .addressSuggestPinnedReorder({ group: groupKey, urls: order })
        .catch(() => null);
      if (!result || result.ok === false) {
        setStatus(`调整置顶顺序失败：${(result && result.error) || '未知原因'}`, true);
      }
      await loadPinnedList();
    };

    // 拖动状态跨整组共享：只在同组的行之间允许落点
    let dragUrl = '';
    let dragGroup = '';

    const buildRow = (item, index, groupItems, group) => {
      const row = document.createElement('div');
      row.className = 'ext-item';
      row.draggable = true;
      row.dataset.url = item.url;

      const head = document.createElement('div');
      head.className = 'ext-item-head';

      // 行首小组标签：一眼看清这一条属于哪组（分组标题之外还有冗余，方便拖动时确认）
      const tag = document.createElement('span');
      tag.className = 'pinned-group-tag';
      tag.textContent = group.label;
      head.appendChild(tag);

      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = item.title || item.url;
      head.appendChild(name);

      const order = document.createElement('span');
      order.className = 'badge';
      order.textContent = `#${index + 1}`;
      head.appendChild(order);

      // 分组下拉：唯一的跨组移动入口
      const select = document.createElement('select');
      select.className = 'pinned-group-select';
      select.dataset.url = item.url;
      select.title = '移动到其他分组';
      select.setAttribute('aria-label', '移动到其他分组');
      for (const option of groups) {
        const opt = document.createElement('option');
        opt.value = option.key;
        opt.textContent = option.label;
        if (option.key === group.key) opt.selected = true;
        select.appendChild(opt);
      }
      if (!canGroup) select.disabled = true;
      select.addEventListener('change', async () => {
        const next = String(select.value || '');
        if (!next || next === group.key) return;
        if (!canGroup) {
          select.value = group.key;
          setStatus('当前内核不支持调整置顶分组', true);
          return;
        }
        const result = await window.nyx
          .addressSuggestPinnedGroupSet({ url: item.url, group: next })
          .catch(() => null);
        if (!result || result.ok === false) {
          select.value = group.key;
          setStatus(`调整分组失败：${(result && result.error) || '未知原因'}`, true);
          return;
        }
        setStatus(`已把「${item.title || item.url}」移到「${labelOf(next)}」`);
        await loadPinnedList();
      });
      head.appendChild(select);

      row.appendChild(head);

      const desc = document.createElement('div');
      desc.className = 'ext-desc';
      desc.textContent = item.url;
      row.appendChild(desc);

      const actions = document.createElement('div');
      actions.className = 'ext-actions';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn btn-mini';
      up.textContent = '↑';
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        const order = groupItems.map((it) => it.url);
        [order[index - 1], order[index]] = [order[index], order[index - 1]];
        persistGroup(group.key, order);
      });
      actions.appendChild(up);

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'btn btn-mini';
      down.textContent = '↓';
      down.disabled = index === groupItems.length - 1;
      down.addEventListener('click', () => {
        const order = groupItems.map((it) => it.url);
        [order[index + 1], order[index]] = [order[index], order[index + 1]];
        persistGroup(group.key, order);
      });
      actions.appendChild(down);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-mini';
      remove.textContent = '取消置顶';
      remove.addEventListener('click', async () => {
        const result = await window.nyx.addressSuggestPin({ url: item.url, title: item.title }).catch(() => null);
        if (!result || result.ok === false) {
          setStatus(`取消置顶失败：${(result && result.error) || '未知原因'}`, true);
          return;
        }
        setStatus(`已取消置顶：${item.title || item.url}`);
        await loadPinnedList();
      });
      actions.appendChild(remove);

      row.appendChild(actions);

      row.addEventListener('dragstart', (event) => {
        dragUrl = item.url;
        dragGroup = group.key;
        row.classList.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.url);
        }
      });
      row.addEventListener('dragend', () => {
        dragUrl = '';
        dragGroup = '';
        row.classList.remove('is-dragging');
      });
      row.addEventListener('dragover', (event) => {
        // 只在同组内允许落点：跨组移动请用下拉，避免一次拖动改两件事
        if (!dragUrl || dragUrl === item.url || dragGroup !== group.key) return;
        event.preventDefault();
        row.classList.add('is-drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('is-drop-target');
        if (!dragUrl || dragUrl === item.url || dragGroup !== group.key) return;
        const order = groupItems.map((it) => it.url).filter((url) => url !== dragUrl);
        const targetIndex = order.indexOf(item.url);
        order.splice(targetIndex, 0, dragUrl);
        persistGroup(group.key, order);
      });

      return row;
    };

    for (const group of groups) {
      const groupItems = buckets.get(group.key) || [];

      const section = document.createElement('section');
      section.className = 'pinned-group';
      section.dataset.group = group.key;

      const head = document.createElement('div');
      head.className = 'pinned-group-head';
      const title = document.createElement('span');
      title.className = 'pinned-group-title';
      title.textContent = group.label;
      head.appendChild(title);
      const tally = document.createElement('span');
      tally.className = 'badge';
      tally.textContent = `${groupItems.length} / ${groupMax}`;
      head.appendChild(tally);
      section.appendChild(head);

      const body = document.createElement('div');
      body.className = 'pinned-group-body';
      if (!groupItems.length) {
        body.appendChild(
          hintLine(`「${group.label}」还没有置顶项：在地址栏建议里右键，选「置顶到${group.label}」。`),
        );
      } else {
        groupItems.forEach((item, index) => {
          body.appendChild(buildRow(item, index, groupItems, group));
        });
      }
      section.appendChild(body);
      box.appendChild(section);
    }
  }


  /* ---------------- 抓包慢请求阈值（v1.16.0） ---------------- */
  /*
     阈值只有一份，存在主进程（toolbox-prefs）。抓包面板的「只看慢请求」与行尾「慢」标
     读的都是它，所以这里保存后不需要通知别处，面板下次渲染自然用新值。
  */

  async function loadSlowMs(notice) {
    const input = byId('net-slow-ms');
    const hint = byId('net-slow-hint');
    const badge = byId('net-slow-badge');
    const saveBtn = byId('btn-net-slow-save');
    if (!input) return;

    if (typeof window.nyx.tbSlowMs !== 'function') {
      if (saveBtn) saveBtn.disabled = true;
      input.disabled = true;
      if (hint) hint.textContent = '当前内核不支持读取阈值（缺少主进程接口）。';
      return;
    }

    const res = await window.nyx.tbSlowMs().catch(() => null);
    if (!res || res.ok === false) {
      if (hint) hint.textContent = `读取失败：${(res && res.error) || '未知原因'}`;
      return;
    }
    input.min = String(res.min || 50);
    input.max = String(res.max || 10000);
    input.value = String(res.slowMs);
    if (badge) badge.textContent = `${res.slowMs} ms`;
    if (hint) hint.textContent = notice || `当前阈值 ${res.slowMs} ms（默认 ${res.fallback} ms）`;
  }

  const netSlowSave = byId('btn-net-slow-save');
  const netSlowInput = byId('net-slow-ms');
  if (netSlowSave && netSlowInput) {
    // 主线程接口缺失时按钮保持禁用，不给出"看起来能点但没反应"的假象
    if (typeof window.nyx.tbSlowMsSet !== 'function') {
      netSlowSave.disabled = true;
      netSlowInput.disabled = true;
    } else {
      const submitSlowMs = async () => {
        const hint = byId('net-slow-hint');
        const badge = byId('net-slow-badge');
        const raw = String(netSlowInput.value || '').trim();
        const ms = Number(raw);
        // 只接受整数：小数毫秒在界面上没有意义，也让主进程的上下限校验更直白
        if (!raw || !Number.isFinite(ms) || !Number.isInteger(ms) || ms < 50 || ms > 10000) {
          if (hint) hint.textContent = '阈值需要是 50–10000 之间的整数毫秒数';
          return;
        }
        netSlowSave.disabled = true;
        try {
          const res = await window.nyx.tbSlowMsSet(ms).catch(() => null);
          if (!res || res.ok === false) {
            if (hint) hint.textContent = `保存失败：${(res && res.error) || '未知原因'}`;
            setStatus('慢请求阈值保存失败', true);
            return;
          }
          netSlowInput.value = String(res.slowMs);
          if (badge) badge.textContent = `${res.slowMs} ms`;
          if (hint) hint.textContent = `已保存：耗时 ≥ ${res.slowMs} ms 记为慢请求`;
          setStatus(`慢请求阈值已保存为 ${res.slowMs} ms`);
        } finally {
          netSlowSave.disabled = false;
        }
      };
      netSlowSave.addEventListener('click', submitSlowMs);
      netSlowInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submitSlowMs();
        }
      });
    }
  }

  /* ---------------- 更新源占用（v1.16.0） ---------------- */
  /*
     体积统计在主进程做（要读盘），这里只负责格式化与按钮。
     清理命令也由主进程返回，避免设置页把发版脚本路径写死。
  */

  async function loadFootprint() {
    const grid = byId('update-footprint-grid');
    const badge = byId('footprint-badge');
    const paths = byId('footprint-paths');
    if (!grid) return;

    if (typeof window.nyx.updateFootprint !== 'function') {
      if (badge) badge.textContent = '不支持';
      grid.textContent = '';
      if (paths) paths.textContent = '当前内核不支持读取更新源占用。';
      return;
    }

    const res = await window.nyx.updateFootprint().catch(() => null);
    if (!res || res.ok === false) {
      if (badge) badge.textContent = '读取失败';
      grid.textContent = '';
      if (paths) paths.textContent = `读取失败：${(res && res.error) || '未知原因'}`;
      return;
    }

    const updates = res.updates || {};
    const archive = res.archive || {};
    const versions = Array.isArray(res.archiveVersions) ? res.archiveVersions.length : 0;
    const archiveDetail = versions ? `${archive.dirs || 0} 个目录 · ${versions} 个历史版本` : `${archive.dirs || 0} 个目录`;
    renderKvGrid(grid, [
      ['更新源', `${formatBytes(updates.bytes)}（${updates.files || 0} 个文件）`],
      ['留档', `${formatBytes(archive.bytes)}（${archiveDetail}）`],
      ['合计', formatBytes(res.total)],
    ]);
    if (badge) badge.textContent = formatBytes(res.total);
    if (paths) {
      paths.textContent = `更新源：${updates.path || '—'}\n留档：${archive.path || '—'}`;
    }
  }

  const footprintOpen = byId('btn-footprint-open');
  if (footprintOpen) {
    footprintOpen.addEventListener('click', async () => {
      const hint = byId('footprint-hint');
      if (typeof window.nyx.updateOpenSource !== 'function') {
        if (hint) hint.textContent = '当前内核不支持打开更新源文件夹。';
        return;
      }
      footprintOpen.disabled = true;
      try {
        const res = await window.nyx.updateOpenSource().catch(() => null);
        if (!res || res.ok === false) {
          if (hint) hint.textContent = `打开失败：${(res && res.error) || '未知原因'}`;
          setStatus('打开更新源文件夹失败', true);
          return;
        }
        if (hint) hint.textContent = `已在文件管理器中打开：${res.path}`;
        setStatus('已打开更新源文件夹');
      } finally {
        footprintOpen.disabled = false;
      }
    });
  }

  const footprintCopy = byId('btn-footprint-copy');
  if (footprintCopy) {
    footprintCopy.addEventListener('click', async () => {
      const hint = byId('footprint-hint');
      if (typeof window.nyx.updateCopyCleanCommand !== 'function') {
        if (hint) hint.textContent = '当前内核不支持复制清理命令。';
        return;
      }
      footprintCopy.disabled = true;
      try {
        const res = await window.nyx.updateCopyCleanCommand().catch(() => null);
        if (!res) {
          if (hint) hint.textContent = '复制失败：主进程没有响应';
          return;
        }
        // 失败时主进程也会带回命令原文，照常显示出来，用户还能手动复制
        if (res.ok === false) {
          if (hint) {
            hint.textContent = `复制失败：${res.error || '未知原因'}${res.command ? `\n${res.command}` : ''}`;
          }
          setStatus('复制清理命令失败', true);
          return;
        }
        if (hint) hint.textContent = `已复制清理命令（在发版机项目根目录执行）：\n${res.command || ''}`;
        setStatus('清理命令已复制到剪贴板');
      } finally {
        footprintCopy.disabled = false;
      }
    });
  }

  async function toggleExtension(item) {
    const next = !item.enabled;
    const res = await runExtAction(next ? '启用扩展' : '停用扩展', () =>
      window.nyx.toggleExtension({ id: item.id, enabled: next }),
    );
    if (!res) return;

    if (res.loadError) {
      byId('ext-import-hint').textContent = `「${item.name}」已启用，但装载失败：${res.loadError}`;
    } else {
      byId('ext-import-hint').textContent = next
        ? `「${item.name}」已启用，刷新页面后在该页生效。`
        : `「${item.name}」已停用，当前已打开的页面刷新后不再注入。`;
    }
    setStatus(`扩展已${next ? '启用' : '停用'}：${item.name}`);
  }

  async function removeExtension(item) {
    const res = await runExtAction('删除扩展', () => window.nyx.removeExtension({ id: item.id }));
    if (!res) return;
    byId('ext-import-hint').textContent = `「${item.name}」已从扩展仓库删除。`;
    setStatus(`扩展已删除：${item.name}`);
  }

  byId('btn-ext-add-dir').addEventListener('click', async () => {
    const res = await runExtAction('导入扩展目录', () => window.nyx.addExtensionFromDir());
    if (!res) return;

    const name = res.extension ? res.extension.name : '扩展';
    if (res.loadError) {
      byId('ext-import-hint').textContent = `「${name}」已复制进扩展仓库，但装载失败：${res.loadError}`;
    } else if (res.reloadHint) {
      byId('ext-import-hint').textContent = `「${name}」已导入并启用，点「刷新全部标签」让它在当前页面生效。`;
    } else {
      byId('ext-import-hint').textContent = `「${name}」已导入并启用（该扩展不注入页面，无需刷新标签）。`;
    }
    setStatus(`${res.updated ? '扩展已更新' : '扩展已导入'}：${name}`);
  });

  byId('btn-ext-add-crx').addEventListener('click', async () => {
    const res = await runExtAction('导入扩展包', () => window.nyx.addExtensionFromCrx());
    if (!res) return;

    const name = res.extension ? res.extension.name : '扩展';
    if (res.loadError) {
      byId('ext-import-hint').textContent = `「${name}」已从安装包解出并入库，但装载失败：${res.loadError}`;
    } else if (res.reloadHint) {
      byId('ext-import-hint').textContent = `「${name}」已从安装包导入并启用，点「刷新全部标签」让它在当前页面生效。`;
    } else {
      byId('ext-import-hint').textContent = `「${name}」已从安装包导入并启用。`;
    }
    setStatus(`扩展已导入：${name}`);
  });

  byId('btn-ext-reload').addEventListener('click', async () => {
    const res = await runExtAction('重新装载扩展', () => window.nyx.reloadExtensions());
    if (!res) return;
    byId('ext-import-hint').textContent = `全部重新装载完成：成功 ${res.loaded}/${res.total} 个。`;
    setStatus(`扩展重新装载：${res.loaded}/${res.total}`);
  });

  byId('btn-ext-reload-tabs').addEventListener('click', async () => {
    const res = await window.nyx.reloadTabsForExtensions();
    if (!res || !res.ok) {
      byId('ext-import-hint').textContent = `刷新标签失败：${(res && res.error) || '未知原因'}`;
      setStatus('刷新标签失败');
      return;
    }
    byId('ext-import-hint').textContent = `已刷新 ${res.reloaded} 个标签，扩展内容脚本开始注入。`;
    setStatus(`已刷新 ${res.reloaded} 个标签`);
  });

  byId('btn-ext-open-store').addEventListener('click', async () => {
    const res = await window.nyx.openExtensionStore();
    if (!res || !res.ok) {
      setStatus(`打开扩展仓库失败：${(res && res.error) || '未知原因'}`);
      return;
    }
    setStatus('已在文件管理器中打开扩展仓库');
  });

  byId('btn-ext-refresh').addEventListener('click', () => loadExtensions('扩展清单已刷新'));

  async function loadHardware() {
    const badge = byId('hw-badge');
    const body = byId('hw-body');
    if (!body || !badge) return;
    try {
      const res = await window.nyx.getHardwareStatus();
      if (!res || !res.ok) throw new Error((res && res.error) || '探测失败');
      badge.textContent = '已探测';
      body.textContent = '';

      // GPU 区块
      const gpuHead = document.createElement('div');
      gpuHead.className = 'set-row-title';
      gpuHead.textContent = 'GPU 硬件加速';
      body.appendChild(gpuHead);

      const gpuLine = document.createElement('p');
      gpuLine.className = 'hw-line';
      if (res.gpu && res.gpu.available) {
        const features = Object.entries(res.gpu.features || {})
          .filter(([, on]) => on)
          .map(([name]) => name);
        const featText = features.length ? features.join(' / ') : '合成未生效';
        gpuLine.textContent = `${res.gpu.device}${res.gpu.driverVersion ? `（驱动 ${res.gpu.driverVersion}）` : ''} · ${featText}`;
        gpuLine.classList.add(res.gpu.accelerated ? 'hw-ok' : 'hw-bad');
      } else {
        gpuLine.textContent = '未取到 GPU 信息。';
        gpuLine.classList.add('hw-bad');
      }
      body.appendChild(gpuLine);
    } catch (err) {
      badge.textContent = '探测失败';
      body.textContent = `硬件探测失败：${err.message}`;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 下载：保存位置 / 下载前询问                                          */
  /* ------------------------------------------------------------------ */

  async function loadDownloadPrefs() {
    const res = await window.nyx.getUiPrefs();
    const ui = res && res.ui ? res.ui : null;
    if (!ui) return;
    const dir = ui.downloadDir || '';
    const dirInput = byId('download-dir');
    if (dirInput) dirInput.value = dir;
    const ask = byId('pref-download-ask');
    if (ask) ask.checked = ui.downloadAsk !== false;
  }

  function bindDownloadPrefs() {
    const pick = byId('btn-download-pick');
    if (pick) {
      pick.addEventListener('click', async () => {
        const res = await window.nyx.pickDownloadDir();
        if (!res || !res.ok) return;
        byId('download-dir').value = res.path;
        byId('download-hint').textContent = `已选择：${res.path}，点「应用」后生效。`;
      });
    }

    const open = byId('btn-download-open');
    if (open) {
      open.addEventListener('click', () => {
        window.nyx.openDownloadDir();
      });
    }

    const apply = byId('btn-download-apply');
    if (apply) {
      apply.addEventListener('click', async () => {
        const dir = (byId('download-dir').value || '').trim();
        const ask = byId('pref-download-ask').checked;
        const res = await window.nyx.setUiPref('downloadDir', dir);
        if (!res || !res.ok) {
          byId('download-hint').textContent = `保存目录失败：${(res && res.error) || '未知原因'}`;
          setStatus('下载设置保存失败');
          return;
        }
        const res2 = await window.nyx.setUiPref('downloadAsk', ask);
        if (!res2 || !res2.ok) {
          byId('download-hint').textContent = `询问开关保存失败：${(res2 && res2.error) || '未知原因'}`;
          setStatus('下载设置保存失败');
          return;
        }
        uiPrefs = res2.ui;
        byId('download-hint').textContent = `已应用：${dir ? `保存到 ${dir}` : '跟随系统下载目录'}，${ask ? '下载前询问位置' : '静默保存'}。`;
        setStatus('下载设置已保存');
      });
    }

    const reset = byId('btn-download-reset');
    if (reset) {
      reset.addEventListener('click', async () => {
        const res = await window.nyx.setUiPref('downloadDir', '');
        if (!res || !res.ok) {
          byId('download-hint').textContent = `恢复默认失败：${(res && res.error) || '未知原因'}`;
          return;
        }
        const res2 = await window.nyx.setUiPref('downloadAsk', true);
        if (!res2 || !res2.ok) return;
        uiPrefs = res2.ui;
        byId('download-dir').value = '';
        byId('pref-download-ask').checked = true;
        byId('download-hint').textContent = '已恢复默认：跟随系统下载目录，下载前询问位置。';
        setStatus('下载设置已恢复默认');
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  async function init() {
    bindScrollMemory();
    await Promise.all([loadUiPrefs(), loadAppInfo(), loadHardware()]);
    await loadStartupPrefs();
    bindDownloadPrefs();
    await loadDownloadPrefs();
    // 首次进入也要恢复（窗口重开时回到上次停留的位置）；若用户在初始化期间已切走则不干预
    if (activeSection === initialSection) restoreScroll(activeSection);
    setStatus('设置已就绪');
    // 更新状态不依赖进入分区：后台推送也要能实时落到界面上
    refreshUpdateStatus();
  }

  // 主窗口切换模式等操作会推送新状态，这里同步界面偏好（顶栏显隐是全局项）
  window.nyx.onState((snapshot) => {
    const ui = snapshot && snapshot.ui ? snapshot.ui : null;
    if (!ui) return;
    uiPrefs = ui;
    const badge = byId('pref-show-link-badge');
    const toggle = byId('pref-show-mode-switch');
    if (badge) badge.checked = ui.showLinkBadge !== false;
    if (toggle) toggle.checked = ui.showModeSwitch !== false;
  });

  init();
})();
