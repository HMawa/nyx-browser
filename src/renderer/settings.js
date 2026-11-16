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
    // 「主题与显示」这一页一直打不开就是这个原因：面板和导航项都在，但这里漏了它，
    // activate() 第一行 `if (!SEC_LABELS[section]) return;` 直接把它退回去了。
    display: '主题与显示',
    startup: '启动与主页',
    privacy: '隐私与安全',
    network: '网络与代理',
    downloads: '下载',
    extensions: '扩展插件',
    diagnostics: '诊断',
    agent: 'Agent 访问',
    about: '关于与更新',
  };

  /** 权限标识 → 中文说明（界面展示用；未登记的标识直接显示原文） */
  const PERMISSION_CN = {
    media: '摄像头 / 麦克风',
    'audioCapture': '麦克风',
    'videoCapture': '摄像头',
    camera: '摄像头',
    microphone: '麦克风',
    screen: '屏幕共享',
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
  /* 卡片折叠（清单 A1，v1.17.8）                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 设置页有九个分区、四十来张卡片。原来全摊开，找一项要滚很久。
   * 这里给每张卡片加「铺开 / 收回」两态：收回时标题右侧仍然显示**当前值**，
   * 因为"收起来看不见现状"比"不折叠"更糟——用户还得挨个展开找。
   *
   * 不改 settings.html 的四十处结构，启动时统一增强：卡片头（.info-head）变成
   * 可点/可聚焦的折叠开关，值由 describeCardValue 统一推导。
   */

  /** 默认铺开的分区：常用区先给全，其余先收起；用户点过之后按他点的来 */
  const FOLD_OPEN_SECTIONS = ['appearance', 'network'];

  /** 卡片稳定 id：分区 + 标题 slug。标题改了 id 就变，等于「没记过」→ 回到分区默认 */
  function foldCardId(section, title) {
    const slug = String(title || '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${section}:${slug || 'card'}`;
  }

  /**
   * 收起态右侧显示的「当前值」。取值优先级写死在这里，界面不许各判一套：
   * 徽标（不是「—」时）→ 第一个复选框（开/关）→ 第一个下拉的选中项 →
   * 第一个文本框的值 → 第一条提示的首句 → 空（宁可空着，也不编一句假的）。
   */
  function describeCardValue(card) {
    if (!card) return '';

    const badge = card.querySelector('.info-head .badge');
    const badgeText = badge ? String(badge.textContent || '').trim() : '';
    if (badgeText && badgeText !== '—' && badgeText !== '-') return badgeText;

    const box = card.querySelector('input[type="checkbox"]');
    if (box) return box.checked ? '开' : '关';

    const select = card.querySelector('select');
    const option = select && select.selectedOptions ? select.selectedOptions[0] : null;
    const optionText = option ? String(option.textContent || '').trim() : '';
    if (optionText) return optionText;

    const text = card.querySelector('input[type="text"], input[type="number"], input[type="search"]');
    const value = text ? String(text.value || '').trim() : '';
    if (value) return value.length > 24 ? `${value.slice(0, 24)}…` : value;

    const hint = card.querySelector('.hint');
    if (hint) {
      // 先把换行与缩进压平再切句：卡片里的说明经常是缩进过的多行文本，
      // 直接按 \n 切会切出一个空串，收起态就变成"什么都没有"。
      const flat = String(hint.textContent || '').replace(/\s+/g, ' ').trim();
      const line = flat.split(/[。；]/)[0].trim();
      if (line) return line.length > 28 ? `${line.slice(0, 28)}…` : line;
    }

    // 纯状态卡（加固状态这类）：没有控件也没有说明，就取第一行事实的「值」
    const fact = card.querySelector('.kv-grid .kv-item .v');
    const factText = fact ? String(fact.textContent || '').trim() : '';
    if (factText) return factText.length > 24 ? `${factText.slice(0, 24)}…` : factText;

    return '';
  }

  /** 折叠记录（JSON 字符串 → 对象；坏数据一律当成"一条都没记过"） */
  function readFoldMap() {
    const raw = uiPrefs ? uiPrefs.settingsFold : '';
    if (!raw) return {};
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 这张卡片该不该收起：用户记过就按记录，没记过按分区默认 */
  function foldStateOf(card) {
    const saved = readFoldMap();
    const id = card && card.dataset ? card.dataset.foldId : '';
    if (id && Object.prototype.hasOwnProperty.call(saved, id)) return Number(saved[id]) === 1;
    const panel = card ? card.closest('.sec-panel') : null;
    const sec = panel && panel.dataset.sec ? panel.dataset.sec : '';
    return !FOLD_OPEN_SECTIONS.includes(sec);
  }

  let foldSaveTimer = null;

  /** 把「与分区默认不同」的卡片状态写回偏好（只存差异，文件才不会被四十条撑大） */
  function persistFoldState() {
    if (foldSaveTimer) clearTimeout(foldSaveTimer);
    foldSaveTimer = setTimeout(async () => {
      foldSaveTimer = null;
      const map = {};
      for (const card of document.querySelectorAll('.info-card[data-fold-id]')) {
        const folded = card.classList.contains('is-folded');
        const panel = card.closest('.sec-panel');
        const sec = panel && panel.dataset.sec ? panel.dataset.sec : '';
        const normal = !FOLD_OPEN_SECTIONS.includes(sec);
        if (folded !== normal) map[card.dataset.foldId] = folded ? 1 : 0;
      }
      try {
        const res = await window.nyx.setUiPref('settingsFold', JSON.stringify(map));
        if (res && res.ok === false) {
          setStatus(`折叠状态没能保存：${res.error || '未知原因'}`, true);
        } else if (res && res.ui) {
          uiPrefs = res.ui;
        }
      } catch {
        setStatus('折叠状态没能保存：界面与内核的通道没有响应。', true);
      }
    }, 260);
  }

  /** 应用一张卡片的折叠态；animate=false 用于首次渲染，避免进入设置页时整片闪一下 */
  function applyFold(card, folded, animate) {
    const body = card.querySelector('.info-body');
    const head = card.querySelector('.info-head');
    const value = card.querySelector('.fold-value');
    const reduce =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (value) setFoldValue(card);
    if (head) head.setAttribute('aria-expanded', folded ? 'false' : 'true');

    if (!body || !animate || reduce) {
      card.classList.toggle('is-folded', folded);
      if (body) body.style.maxHeight = '';
      return;
    }

    if (body.style.maxHeight) body.style.maxHeight = '';
    if (folded) {
      // 先量出真实高度并写死一个起点，再切到 0——中间强制一次重排（读 offsetHeight），
      // 否则浏览器会把"auto → 0"合并成一次跳变，动画看不到（用 requestAnimationFrame
      // 也可以，但后台标签里 rAF 会被节流甚至不触发，功能就得跟着一起坏）。
      body.style.maxHeight = `${body.scrollHeight}px`;
      void body.offsetHeight;
      card.classList.add('is-folded');
      body.style.maxHeight = '0px';
    } else {
      card.classList.remove('is-folded');
      // 分区不可见时（display:none）scrollHeight 是 0，把它写进 max-height 就等于
      // 「铺开了但高度 0」。量不到真实高度就直接给 auto，别拿 0 当目标值。
      const height = body.scrollHeight;
      if (!height) {
        body.style.maxHeight = '';
        return;
      }
      body.style.maxHeight = `${height}px`;
      window.setTimeout(() => {
        if (!card.classList.contains('is-folded')) body.style.maxHeight = '';
      }, 200);
    }
  }

  /**
   * 写卡片头右侧那个「当前值」。
   * 有些卡片头本来就有个状态徽标（比如「经代理」「已开启」），再写一遍同样的字就变成
   * 「经代理 经代理」——像两套数据打架。同字就不再显示，换字才显示。
   */
  function setFoldValue(card) {
    const value = card.querySelector('.fold-value');
    if (!value) return;
    const text = describeCardValue(card);
    value.textContent = text;
    const head = card.querySelector('.info-head');
    const badgeText = (head?.querySelector('.badge')?.textContent || '').trim();
    value.hidden = Boolean(badgeText) && badgeText === String(text || '').trim();
  }

  /** 刷新一批卡片显示的当前值（控件改完之后调用，别让收起态显示旧值） */
  function refreshFoldValues(root) {
    const scope = root || document;
    for (const card of scope.querySelectorAll('.info-card[data-fold-id]')) {
      setFoldValue(card);
    }
  }

  /** 把一张卡片的卡片头增强成折叠开关（head 保持 div，只加 role/tabindex，避免动四十处的结构） */
  function enhanceCardFold(sec, card) {
    const head = card.querySelector('.info-head');
    if (!head || card.dataset.foldId) return;

    const titleEl = head.querySelector('h3');
    const title = titleEl ? String(titleEl.textContent || '').trim() : '';
    card.dataset.foldId = foldCardId(sec, title);
    head.classList.add('fold-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('title', `${title}：点击铺开或收回`);

    const value = document.createElement('span');
    value.className = 'fold-value';
    // 插在标题后面。这里不能用 head.querySelector('.badge') 当锚点——有些卡片里嵌着
    // 另一层带 badge 的结构，取到的节点不是 head 的直接子节点，insertBefore 会直接抛错。
    const anchor = titleEl ? titleEl.nextSibling : head.firstChild;
    head.insertBefore(value, anchor || null);

    const caret = document.createElement('span');
    caret.className = 'fold-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '⌄';
    head.appendChild(caret);

    applyFold(card, foldStateOf(card), false);
  }

  let foldWired = false;

  /** 启动时跑一次：加分区级「全部铺开 / 全部收回」，并增强每一张卡片 */
  /**
   * 标记「必须整行」的卡片（设置页重排版）。
   *
   * 宽窗口下分区里是两列卡片，但表格、站点名单、进程表这类内容塞进半列会看不清列；
   * 这里按**内容**判断（卡片里有没有 table / 名单 / 键值网格），不写死一堆 id——
   * 以后新加表格卡片也自动整行，不用回来改这份名单。
   * @param {Element} [root] 只处理某个分区；不传就整页
   */
  function markWideCards(root) {
    const scope = root && root.querySelectorAll ? root : document;
    for (const card of scope.querySelectorAll('.sec-scroll > .info-card')) {
      const wide = Boolean(
        card.querySelector('table, .agent-site-list, .kv-grid, .template-list, .proc-table, pre'),
      );
      card.classList.toggle('card-wide', wide);
    }
  }

  /** 取某个分区的面板元素 */
  function panelOf(section) {
    return panels.find((panel) => panel.dataset.sec === section) || null;
  }

  /**
   * 兜底点亮卡片：滚动渐显是 fx.js 用 IntersectionObserver 做的，
   * 但面板从 display:none 变可见时它不一定重新算交集——卡片就一直是 opacity:0，
   * 界面上表现为"这一页明明是空的"。这里直接把可见卡片补上 fx-in。
   * 同时清掉"展开态"卡片上写死的 max-height：那个值是在面板不可见时量的（0 或偏小），
   * 留着它就会把正文裁掉一半——卡片铺开着却只露出前几行。
   * @param {Element|null} root
   */
  function revealCards(root) {
    if (!root || !root.querySelectorAll) return;
    // 这一页在后台时，CSS 过渡会被浏览器冻在起始帧（opacity 0），连兜底计时器也被节流
    // （后台标签的 setTimeout 能延到一分钟）。那种情况下动画本来也没人看得见，
    // 直接给终值最稳：切回来时内容是亮的。
    const hiddenNow = document.hidden === true;
    for (const card of root.querySelectorAll('.fx-reveal:not(.fx-in)')) {
      card.classList.add('fx-in');
      if (hiddenNow) {
        card.style.setProperty('opacity', '1', 'important');
        card.style.setProperty('transform', 'none', 'important');
        continue;
      }
      // 兜底：面板刚从 display:none 变可见时，过渡也可能停在起始帧。
      // 渐显只是装饰，内容不许看不见——确认一次还没亮就直接定死。
      setTimeout(() => {
        if (Number(getComputedStyle(card).opacity) === 0) {
          card.style.setProperty('opacity', '1', 'important');
          card.style.setProperty('transform', 'none', 'important');
        }
      }, 400);
    }
    for (const body of root.querySelectorAll('.info-card:not(.is-folded) .info-body')) {
      if (body.style.maxHeight) body.style.maxHeight = '';
    }
  }

  function setupCardFolding() {
    if (foldWired) return;
    foldWired = true;

    for (const panel of panels) {
      const sec = panel.dataset.sec || '';
      const head = panel.querySelector('.sec-head');
      if (head && !head.querySelector('.sec-fold-tools')) {
        const tools = document.createElement('div');
        tools.className = 'sec-fold-tools';

        const openAll = document.createElement('button');
        openAll.type = 'button';
        openAll.className = 'btn btn-mini';
        openAll.dataset.foldAll = 'open';
        openAll.textContent = '全部铺开';

        const closeAll = document.createElement('button');
        closeAll.type = 'button';
        closeAll.className = 'btn btn-mini';
        closeAll.dataset.foldAll = 'close';
        closeAll.textContent = '全部收回';

        tools.appendChild(openAll);
        tools.appendChild(closeAll);
        head.appendChild(tools);
      }

      const scroll = panel.querySelector('.sec-scroll');
      if (!scroll) continue;
      for (const card of scroll.querySelectorAll('section.info-card')) {
        enhanceCardFold(sec, card);
      }
    }

    markWideCards();

    document.addEventListener('click', (event) => {
      const all = event.target && event.target.closest ? event.target.closest('[data-fold-all]') : null;      if (all) {
        const panel = all.closest('.sec-panel');
        const folded = all.dataset.foldAll === 'close';
        if (panel) {
          for (const card of panel.querySelectorAll('.info-card[data-fold-id]')) {
            applyFold(card, folded, true);
          }
          persistFoldState();
          setStatus(folded ? '这个分区的卡片已全部收回。' : '这个分区的卡片已全部铺开。');
        }
        return;
      }

      const head = event.target && event.target.closest ? event.target.closest('.fold-head') : null;
      if (!head) return;
      const card = head.closest('.info-card');
      if (!card) return;
      const unfolding = card.classList.contains('is-folded');
      applyFold(card, !unfolding, true);
      persistFoldState();
    });

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const head = event.target && event.target.closest ? event.target.closest('.fold-head') : null;
        if (!head) return;
        event.preventDefault();
        const card = head.closest('.info-card');
        if (!card) return;
        applyFold(card, !card.classList.contains('is-folded'), true);
        persistFoldState();
      },
      true
    );

    // 控件改完之后，收起态显示的值要跟着变（否则用户收起后看到的还是旧值）
    document.addEventListener(
      'change',
      (event) => {
        const card = event.target && event.target.closest ? event.target.closest('.info-card') : null;
        if (card && card.dataset.foldId) refreshFoldValues(card);
      },
      true
    );
  }

  /* ------------------------------------------------------------------ */
  /* 设置结构图（思维导图，v1.17.11 从头重构）                            */
  /* ------------------------------------------------------------------ */

  const MINDMAP = {
    pad: 12,
    colGap: 44,
    rowH: 30,
    rowGap: 6,
    minHeight: 260,
  };

  let mindmapBuilt = false;
  let mindmapKey = '';
  let mindmapResizeTimer = null;

  function collectMindmapData() {
    const list = byId('nav-list');
    if (!list) return null;
    const groups = [];
    for (const group of list.querySelectorAll('.nav-group')) {
      const labelEl = group.querySelector('.nav-group-label');
      const label = (labelEl && labelEl.textContent ? labelEl.textContent : '').trim();
      const items = [];
      for (const item of group.querySelectorAll('.nav-item')) {
        items.push({
          sec: item.dataset.sec || '',
          label: (item.textContent || '').trim(),
          source: item,
        });
      }
      if (items.length) groups.push({ label, items });
    }
    return groups.length ? groups : null;
  }

  /** 让结构图上的高亮跟着当前分区走（唯一权威仍是 .nav-item.active） */
  function syncMindmapActive(section) {
    const stage = byId('mindmap-stage');
    if (!stage) return;
    for (const node of stage.querySelectorAll('.mindmap-node')) {
      const on = node.dataset.sec === section;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-current', on ? 'true' : 'false');
    }
  }

  /**
   * 画结构图：根在上 → 四个分组依次往下 → 每个分组下面摊开它的分区。
   * 全部走文档流（不是绝对定位），所以节点不会互相压住、也不会被容器裁掉；
   * 竖向排布正好吃满"右侧整列、上下占满"的版面。
   */
  function buildMindmap() {
    const stage = byId('mindmap-stage');
    const root = byId('mindmap-root');
    const box = byId('mindmap');
    if (!stage || !root || !box) return;
    const data = collectMindmapData();
    if (!data) return;

    // 分区表没变就别重建 DOM：重建会把节点换成新元素——用户点到一半、或者先拿到节点
    // 引用再点（验收脚本正是这么点的），就会点在一个已经不在文档里的按钮上，什么也不发生。
    const key = data.map((group) => group.label + ':' + group.items.map((item) => item.sec).join(',')).join('|');
    if (mindmapBuilt && key === mindmapKey) {
      layoutMindmap();
      return;
    }
    mindmapKey = key;

    for (const old of stage.querySelectorAll('.mindmap-tree')) old.remove();

    const tree = document.createElement('div');
    tree.className = 'mindmap-tree';
    stage.appendChild(tree);

    const blocks = [];
    for (const group of data) {
      const block = document.createElement('div');
      block.className = 'mindmap-block';

      const groupEl = document.createElement('div');
      groupEl.className = 'mindmap-group';
      groupEl.textContent = group.label || '未命名分组';
      block.appendChild(groupEl);

      const leaves = document.createElement('div');
      leaves.className = 'mindmap-leaves';
      const nodes = [];
      for (const item of group.items) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'mindmap-node';
        node.dataset.sec = item.sec;
        node.textContent = item.label;
        // 点节点 == 点原来的导航按钮：走同一条路径，不另开一套激活逻辑
        node.addEventListener('click', () => {
          if (item.source) item.source.click();
        });
        leaves.appendChild(node);
        nodes.push({ el: node, item });
      }
      block.appendChild(leaves);
      tree.appendChild(block);
      blocks.push({ groupEl, nodes });
    }

    layoutMindmap();
  }

  /**
   * 只重排现有节点：拉开行距把这一列填满。
   * 不碰节点元素本身——节点保留下来，点击、焦点、键盘顺序都不会因为窗口变化而丢。
   * 层级用 CSS 的竖脊（.mindmap-block 的左边框）表达，不再画 SVG 折线：
   * 分区是一行一个、左边缘对齐的，从分组中心拉出去的折线只会横穿按钮。
   */
  function layoutMindmap() {
    const box = byId('mindmap');
    if (!box) return;

    fitMindmap();

    const nodes = box.querySelectorAll('.mindmap-node').length;
    box.setAttribute('data-nodes', String(nodes));
    mindmapBuilt = true;
    syncMindmapActive(activeSection);
  }

  /**
   * 让整张图正好填满一列：内容不够高就把行距拉大（上下占满），
   * 内容太高就把行距压到最小；压到底还放不下时容器自己出现滚动条，绝不裁掉节点。
   */
  function fitMindmap() {
    const box = byId('mindmap');
    const stage = byId('mindmap-stage');
    if (!box || !stage) return;
    const avail = box.clientHeight;
    if (avail <= 0) return;

    let gap = 8;
    box.style.setProperty('--mm-gap', `${gap}px`);
    let need = stage.scrollHeight;
    while (need > avail - 6 && gap > 2) {
      gap -= 1;
      box.style.setProperty('--mm-gap', `${gap}px`);
      need = stage.scrollHeight;
    }
    while (need < avail - 6 && gap < 26) {
      gap += 1;
      box.style.setProperty('--mm-gap', `${gap}px`);
      need = stage.scrollHeight;
    }
    // 上面是"先压小、再拉大"，拉大那一步可能一步踩过头（差几像素变成要滚动）。
    // 多走一步回去，宁可底下空一行，也不要在右边挂一条滚动条。
    while (need > avail - 2 && gap > 2) {
      gap -= 1;
      box.style.setProperty('--mm-gap', `${gap}px`);
      need = stage.scrollHeight;
    }
  }

  function setupMindmap() {
    const stage = byId('mindmap-stage');
    if (!stage) return;
    buildMindmap();
    // 键盘：在结构图里按 ↑ ↓ 就能挨个分区走一遍、回车进去。
    // 鼠标用户看到的是一串按钮，键盘用户看到的是一串"能连着按的选项"，这是同一件事。
    stage.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const nodes = Array.from(stage.querySelectorAll('.mindmap-node'));
      if (!nodes.length) return;
      const at = nodes.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = nodes[(at + step + nodes.length) % nodes.length] || nodes[0];
      event.preventDefault();
      next.focus();
    });
    window.addEventListener('resize', () => {
      if (mindmapResizeTimer) clearTimeout(mindmapResizeTimer);
      mindmapResizeTimer = setTimeout(() => {
        mindmapResizeTimer = null;
        buildMindmap();
      }, 180);
    });
    // 字体加载完 / 面板变宽之后宽度会变，再画一次，免得连线差几个像素
    setTimeout(() => {
      if (mindmapBuilt) buildMindmap();
    }, 500);
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

    // 结构图上的高亮跟着走（图只是入口，状态还是 .nav-item.active 说了算）
    syncMindmapActive(section);

    // 面板此刻才由 display:none 变可见，只能在这里恢复一次位置
    restoreScroll(section);

    // 卡片宽度跟随分区内容（表格类整行、表单类两列）；面板刚变可见才量得准
    markWideCards();
    setTimeout(() => markWideCards(), 400);

    // 兜底：滚动渐显靠 IntersectionObserver，面板从 display:none 变可见时它不一定重算，
    // 结果就是"分区里明明有卡片却一片空白"。这里直接把当前分区的卡片点亮，内容不许看不见。
    revealCards(panelOf(section));

    setStatus(`已进入「${SEC_LABELS[section]}」`);

    // 通知「网络与代理」分区脚本：它据此按需加载代理数据，且只在自身分区可见时才写状态栏
    document.dispatchEvent(new CustomEvent('nyx:section-change', { detail: section }));

    if (section === 'agent') {
      loadAgentSection();
    }

    if (section === 'privacy') {
      if (!privacyReady) {
        loadPrivacy();
      }
      // 出站方式是随时可能被别的窗口改的（主进程也会改），每次进分区都重读
      loadPrivacyLink();
      // 录屏/被远控状态也可能随时变（用户刚开了个会议），每次进分区都重查一次
      loadScreenWatch();
      // 离线阅读缓存（候选③）：条目数会随浏览变化，进分区就回读
      loadOfflineCache();
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
      // 图形性能策略（A5）：进分区就回读，适配器信息也一并刷新
      loadGpuPolicy();
      // 标签休眠时长（G）：进分区回读，改完立刻生效
      loadTabSleep();
    }

    // 更新状态每次进入都刷一次：版本与升级包状态随时可能被后台改变
    if (section === 'about') {
      refreshUpdateStatus();
      // 更新源占用（v1.16.0）：体积随发版变化，每次进来重新统计
      loadFootprint();
      // 安全基线（C2）：运行时版本每次进来的真相，必须实时比对而不是缓存
      loadSecurityBaseline();
      // 安装包签名（第五轮 ②）：exe 的签名与证书有效期，内核侧有十分钟缓存
      loadSigningStatus();
      // 夜间安装器 e2e（第八轮 ③）：最近一次真机跑升级路径的结果，只读
      loadNightlyStatus();
    }

    // 诊断（清单 C1）：状态与错误记录随时会变，每次进入都重新拉
    if (section === 'diagnostics') {
      loadDiagnostics();
      // 外壳防护现值（清单 C3）：跟着诊断一起刷新——它是"现状"，不能缓存
      loadSecuritySwitches();
      // 进程详情（清单 A3）：也是"现状"，每次进来重新量
      loadProcessList();
    }

    // 卡片收起时显示的「当前值」要跟上本分区刚加载的数据（清单 A1）
    const current = panels.find((panel) => panel.dataset.sec === section);
    if (current) {
      refreshFoldValues(current);
      // 分区里的数据多半是异步回填的，加载完再补刷一次
      window.setTimeout(() => refreshFoldValues(current), 400);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 诊断（清单 C1）                                                     */
  /* ------------------------------------------------------------------ */

  /** 只绑一次按钮，避免每次切回分区重复绑定 */
  let diagWired = false;

  function wireDiagActions() {
    if (diagWired) return;
    diagWired = true;

    const refresh = byId('btn-diag-refresh');
    if (refresh) {
      refresh.addEventListener('click', () => loadDiagnostics());
    }

    const exportBtn = byId('btn-diag-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        try {
          const result = await window.nyx.exportDiagnostics();
          if (result && result.ok) {
            setStatus(`诊断包已导出（${formatBytes(result.bytes)}）`);
            await loadDiagnostics();
          } else if (result && result.canceled) {
            setStatus('已取消导出');
          } else {
            setStatus(`导出失败：${(result && result.error) || '未知原因'}`, true);
          }
        } catch (err) {
          setStatus(`导出失败：${err.message}`, true);
        } finally {
          exportBtn.disabled = false;
        }
      });
    }

    const openBtn = byId('btn-diag-open');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        const result = await window.nyx.openDiagnosticsFolder();
        if (!result || !result.ok) {
          setStatus(`打开日志目录失败：${(result && result.error) || '未知原因'}`, true);
        }
      });
    }

    const clearBtn = byId('btn-diag-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await window.nyx.clearDiagnostics();
        setStatus('诊断记录已清空');
        await loadDiagnostics();
      });
    }
  }

  /** 把一条记录渲染成一行（时间 / 级别 / 内容 + 附加信息） */
  function buildDiagItem(entry) {
    const row = document.createElement('div');
    row.className = `diag-item is-${entry.level}`;
    row.dataset.code = entry.code;

    const time = document.createElement('span');
    time.className = 'diag-time';
    const at = new Date(entry.at);
    time.textContent = Number.isNaN(at.getTime())
      ? escapeText(entry.at)
      : at.toLocaleString('zh-CN', { hour12: false });
    time.title = escapeText(entry.at);

    const level = document.createElement('span');
    level.className = 'diag-level';
    level.textContent = entry.level === 'error' ? '错误' : entry.level === 'warn' ? '警告' : '提示';

    const body = document.createElement('span');
    body.className = 'diag-body';
    body.textContent = escapeText(entry.message);

    const code = document.createElement('span');
    code.className = 'diag-code';
    code.textContent = escapeText(entry.code);
    body.appendChild(code);

    if (entry.extra !== undefined) {
      const extra = document.createElement('span');
      extra.className = 'diag-extra';
      extra.textContent = JSON.stringify(entry.extra);
      body.appendChild(extra);
    }

    row.appendChild(time);
    row.appendChild(level);
    row.appendChild(body);
    return row;
  }

  /**
   * 进程详情（清单 A3）。
   *
   * 一句话原则：**能对上 PID，就不假装改了映像名**。表里的 PID 与任务管理器一致，
   * 想分辨哪个进程是哪个标签，看「命令行」列里的 --nyx-tab / --nyx-host。
   */
  let lastProcessText = '';

  async function loadProcessList() {
    const badge = byId('proc-badge');
    const rowsEl = byId('proc-rows');
    const statusEl = byId('proc-status');
    if (!rowsEl) return;

    const refresh = byId('btn-proc-refresh');
    if (refresh && refresh.dataset.wired !== 'true') {
      refresh.dataset.wired = 'true';
      refresh.addEventListener('click', () => { loadProcessList(); });
    }
    const copy = byId('btn-proc-copy');
    if (copy && copy.dataset.wired !== 'true') {
      copy.dataset.wired = 'true';
      copy.addEventListener('click', async () => {
        if (!lastProcessText) {
          if (statusEl) statusEl.textContent = '先刷新一次进程列表再复制。';
          return;
        }
        if (!window.nyx.processCopy) return;
        const res = await window.nyx.processCopy({ text: lastProcessText });
        if (statusEl) {
          statusEl.className = res && res.ok === true ? 'hint' : 'hint is-warn';
          statusEl.textContent = res && res.ok === true ? '已复制（可直接粘到任务管理器里对照）' : (res && res.error) || '没能复制';
        }
      });
    }

    if (!window.nyx.processList) {
      if (badge) { badge.textContent = '不可用'; badge.className = 'badge bad'; }
      if (statusEl) statusEl.textContent = '当前内核不支持读取进程信息。';
      return;
    }

    const res = await window.nyx.processList();
    if (!res || res.ok !== true) {
      if (badge) { badge.textContent = '读不到'; badge.className = 'badge bad'; }
      if (statusEl) {
        statusEl.className = 'hint is-warn';
        statusEl.textContent = (res && res.error) || '读不到进程信息。';
      }
      return;
    }

    lastProcessText = res.text || '';
    if (badge) {
      badge.textContent = `${res.count} 个进程 · ${res.totalMb} MB`;
      badge.className = 'badge ok';
    }
    rowsEl.textContent = '';
    for (const row of res.rows || []) {
      const tr = document.createElement('tr');
      if (row.isMain) tr.className = 'proc-main';
      const pid = document.createElement('td');
      pid.className = 'proc-pid';
      pid.textContent = String(row.pid);
      const what = document.createElement('td');
      what.textContent = row.title ? `${row.label}（${row.title}）` : row.label;
      const mem = document.createElement('td');
      mem.className = 'proc-mem';
      mem.textContent = `${row.mb} MB`;
      tr.append(pid, what, mem);
      rowsEl.appendChild(tr);
    }
    if (statusEl) {
      statusEl.className = 'hint';
      statusEl.textContent = res.hint || '';
    }
  }

  async function loadDiagnostics() {
    wireDiagActions();

    const statusEl = byId('diag-badge');
    const gridEl = byId('diag-grid');
    const listEl = byId('diag-list');
    const countEl = byId('diag-count');
    const emptyEl = byId('diag-empty');

    let status = null;
    try {
      status = await window.nyx.getDiagnosticsStatus();
    } catch (err) {
      if (statusEl) statusEl.textContent = '读取失败';
      if (gridEl) renderKvGrid(gridEl, [['错误', err.message]]);
      return;
    }
    if (!status || !status.ok) {
      if (statusEl) statusEl.textContent = '读取失败';
      return;
    }

    const context = status.context || {};
    const counts = status.counts || { error: 0, warn: 0, info: 0, total: 0 };

    if (statusEl) {
      statusEl.textContent = counts.error
        ? `${counts.error} 条错误`
        : counts.total
          ? '无错误'
          : '暂无记录';
      statusEl.classList.toggle('is-bad', Boolean(counts.error));
    }

    if (gridEl) {
      renderKvGrid(gridEl, [
        ['应用版本', context.appVersion || '未知'],
        ['Electron', context.electron || '未知'],
        ['Chromium', context.chrome || '未知'],
        ['Node', context.node || '未知'],
        ['运行模式', context.mode || '未知'],
        ['连接方式', context.link || '未知'],
        ['代理', context.proxy || '未知'],
        ['GPU 策略', context.gpu || '未知'],
        ['平台', `${context.platform || '未知'} / ${context.arch || '未知'}`],
        ['日志文件', status.logPath || '未知'],
      ]);
    }

    if (countEl) {
      countEl.textContent = `错误 ${counts.error} / 警告 ${counts.warn} / 提示 ${counts.info}`;
    }

    let list = { items: [] };
    try {
      list = await window.nyx.listDiagnostics(status.displayLimit || 20);
    } catch (err) {
      if (listEl) {
        listEl.textContent = '';
        listEl.appendChild(hintLine(`读取记录失败：${err.message}`));
      }
      return;
    }

    const items = (list && list.items) || [];
    if (listEl) {
      listEl.textContent = '';
      for (const entry of items) listEl.appendChild(buildDiagItem(entry));
    }
    if (emptyEl) emptyEl.hidden = items.length > 0;
  }

  /* ------------------------------------------------------------------ */
  /* 外壳防护现值（清单 C3）                                              */
  /* ------------------------------------------------------------------ */

  let securitySwitchesWired = false;

  function wireSecuritySwitches() {
    if (securitySwitchesWired) return;
    securitySwitchesWired = true;

    const refresh = byId('btn-security-switches-refresh');
    if (refresh) refresh.addEventListener('click', () => loadSecuritySwitches());

    const probeBtn = byId('btn-security-probe');
    if (probeBtn) probeBtn.addEventListener('click', () => runSecurityProbe());
  }

  /** 一个窗口角色一行区块：三项开关 + 为什么这么设 */
  function buildSecurityRoleBlock(role) {
    const box = document.createElement('div');
    box.className = `sw-role${role.ok ? '' : ' is-bad'}`;

    const head = document.createElement('div');
    head.className = 'sw-role-head';

    const name = document.createElement('span');
    name.className = 'sw-role-name';
    name.textContent = role.label || role.role;
    head.appendChild(name);

    if (role.preload) {
      const pre = document.createElement('span');
      pre.className = 'sw-role-preload';
      pre.textContent = role.preload;
      head.appendChild(pre);
    }

    const tag = document.createElement('span');
    tag.className = 'sw-role-tag';
    tag.textContent = role.ok ? '与声明一致' : role.note || '与声明不一致';
    head.appendChild(tag);
    box.appendChild(head);

    const addLine = (keyText, valueText, bad) => {
      const line = document.createElement('div');
      line.className = `sw-row${bad ? ' is-bad' : ''}`;
      const key = document.createElement('span');
      key.className = 'sw-row-key';
      key.textContent = keyText;
      const value = document.createElement('span');
      value.className = 'sw-row-value';
      value.textContent = valueText;
      line.appendChild(key);
      line.appendChild(value);
      box.appendChild(line);
    };

    for (const row of role.rows || []) {
      const state = row.actual ? '开' : '关';
      if (row.match) {
        // 一致时刻意说明"是不是靠默认值成立"：靠默认值不算错，但值得提醒
        addLine(row.label, row.declared ? state : `${state}（没显式写，走默认值）`, false);
      } else {
        addLine(row.label, `${state} —— ${row.note}`, true);
      }
    }

    if (role.why) addLine('为什么这样', role.why, false);
    return box;
  }

  /** 一个本地页面的 CSP 一行 */
  function buildCspBlock(item) {
    const row = document.createElement('div');
    row.className = `diag-item sw-csp-item${item.ok ? '' : ' is-bad'}`;

    const file = document.createElement('span');
    file.className = 'diag-time';
    file.textContent = item.file;
    file.title = item.file;

    const level = document.createElement('span');
    level.className = 'diag-level';
    level.textContent = item.ok ? '可以' : item.found ? '偏宽' : '缺失';

    const body = document.createElement('span');
    body.className = 'diag-body';
    body.textContent = item.ok
      ? '来源限制正常'
      : (item.warnings || []).join('；') || '需要检查';

    row.appendChild(file);
    row.appendChild(level);
    row.appendChild(body);
    return row;
  }

  async function loadSecuritySwitches() {
    wireSecuritySwitches();

    const badgeEl = byId('security-switches-badge');
    const summaryEl = byId('security-switches-summary');
    const rolesEl = byId('security-switches-roles');
    const cspEl = byId('security-switches-csp');

    let data = null;
    try {
      data = await window.nyx.securitySwitches();
    } catch (err) {
      if (badgeEl) {
        badgeEl.textContent = '读取失败';
        badgeEl.classList.add('is-bad');
      }
      if (summaryEl) renderKvGrid(summaryEl, [['错误', err.message]]);
      return;
    }

    if (!data || data.error) {
      if (badgeEl) {
        badgeEl.textContent = '读取失败';
        badgeEl.classList.add('is-bad');
      }
      if (summaryEl) renderKvGrid(summaryEl, [['错误', (data && data.error) || '未知原因']]);
      return;
    }

    const summary = data.summary || {};
    if (badgeEl) {
      badgeEl.textContent = data.ok ? '全部一致' : '有差异';
      badgeEl.classList.toggle('is-bad', !data.ok);
    }

    if (summaryEl) {
      const notCreated = (data.notCreated || []).length;
      renderKvGrid(summaryEl, [
        ['已核对窗口', `${summary.windowCount || 0} 个${notCreated ? `（另有 ${notCreated} 个本次启动未创建，没验到）` : ''}`],
        ['开关项', `${summary.rowCount || 0} 项，其中 ${summary.badCount || 0} 项与声明不一致`],
        ['本地页面 CSP', `${summary.cspFiles || 0} 个，其中 ${summary.cspBadCount || 0} 个需要处理`],
        [
          'preload 暴露面',
          summary.preloadKeys
            ? `${summary.preloadKeys} 个方法，其中 ${summary.highRiskKeys || 0} 个能写文件 / 开目录 / 重启`
            : '没读到（窗口未就绪）',
        ],
      ]);
    }

    if (rolesEl) {
      rolesEl.textContent = '';
      const roles = data.roles || [];
      if (!roles.length) {
        rolesEl.appendChild(hintLine('这一轮没有核对到任何窗口。'));
      } else {
        for (const role of roles) rolesEl.appendChild(buildSecurityRoleBlock(role));
      }
      for (const item of data.notCreated || []) {
        rolesEl.appendChild(hintLine(`${item.label}：本次启动还没创建过，没验到（不是通过）。`));
      }
    }

    if (cspEl) {
      cspEl.textContent = '';
      const rows = data.csp || [];
      if (!rows.length) cspEl.appendChild(hintLine('没有扫到本地页面。'));
      else for (const item of rows) cspEl.appendChild(buildCspBlock(item));
    }
  }

  /**
   * 注入演示（C3）：真的去尝试，然后把每一条的真实结果列出来。
   * 不显示"通过/失败"两个字的总结——用户要看到哪一条挡、哪一条没挡。
   */
  async function runSecurityProbe() {
    const btn = byId('btn-security-probe');
    const out = byId('security-probe-out');
    if (!btn || !out) return;

    btn.disabled = true;
    out.hidden = false;
    out.className = 'sw-probe-out';
    out.textContent = '正在临时窗口里尝试注入…';

    try {
      const result = await window.nyx.securityProbe();
      if (!result || result.ok !== true) {
        out.classList.add('is-bad');
        out.textContent = `演示没能完成：${(result && (result.error || result.summary)) || '未知原因'}`;
        setStatus('注入演示没能跑起来，原因见下方', true);
        return;
      }

      const lines = [result.summary || '', ''];
      for (const check of result.checks || []) {
        lines.push(`${check.blocked ? '挡住  ' : '没挡住'}  ${check.name} —— ${check.detail}`);
      }
      if (result.bridgeKeys && result.bridgeKeys.length) {
        lines.push('');
        lines.push(
          `暴露面 ${result.bridgeKeys.length} 个方法；改写它${
            result.bridgeWriteIgnored ? '无效（冻结代理）' : '竟然生效了'
          }`,
        );
      }

      const passed = Boolean(result.passed);
      out.classList.add(passed ? 'is-ok' : 'is-bad');
      out.textContent = lines.join('\n');
      setStatus(passed ? '注入演示：全部挡住' : '注入演示：有没挡住的，详情见下方', !passed);
      if (passed) await loadSecuritySwitches();
    } catch (err) {
      out.classList.add('is-bad');
      out.textContent = `演示没能完成：${err.message}`;
      setStatus('注入演示没能跑起来，原因见下方', true);
    } finally {
      btn.disabled = false;
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
    if (byId('pref-toolbar-labels')) byId('pref-toolbar-labels').checked = uiPrefs.toolbarLabels !== false;
    if (byId('pref-motion-level')) byId('pref-motion-level').value = uiPrefs.motionLevel === 'lively' ? 'lively' : 'calm';
    applySettingsMotion(uiPrefs);
    // 主题回填 + 设置窗口自身立即换肤（主窗口由主进程 pushState 同步）
    byId('pref-theme').value = uiPrefs.theme || 'ink';
    document.documentElement.dataset.theme = uiPrefs.theme || 'ink';
    renderDisplayBadges(uiPrefs);
    byId('appearance-state').textContent = '已生效';
  }

  /** 「主题与显示」三个徽标（清单 D3）：当前主题 / 动效档位 / 顶栏小字，一眼看到改了没有 */
  const DISPLAY_THEME_LABELS = {
    ink: '墨夜',
    aurora: '极光',
    paper: '素纸',
    quiet: '静谧',
    cream: '奶白',
    sea: '海盐',
  };

  function renderDisplayBadges(ui) {
    const theme = (ui && ui.theme) || 'ink';
    const motion = (ui && ui.motionLevel) === 'lively' ? '活泼' : '克制';
    const labels = (ui && ui.toolbarLabels) !== false;
    const setBadge = (id, text) => {
      const node = byId(id);
      if (node) node.textContent = text;
    };
    setBadge('display-theme-badge', DISPLAY_THEME_LABELS[theme] || theme);
    setBadge('display-motion-badge', `${motion} · 顶栏小字${labels ? '开' : '关'}`);
    setBadge('display-badge', `${DISPLAY_THEME_LABELS[theme] || theme}`);
  }

  /**
   * 动效档位（清单 B2）：设置页自己也吃这一套，否则"改了没反应"。
   * 时长/缓动的唯一来源仍是 src/core/motion.js，这里只把结果写成 CSS 变量。
   */
  function applySettingsMotion(ui) {
    const root = document.documentElement;
    if (!root) return;
    let reduced = false;
    try {
      reduced = Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      reduced = false;
    }
    const level = (ui && ui.motionLevel) === 'lively' ? 'lively' : 'calm';
    const motion = (window.nyx && window.nyx.motionResolve)
      ? window.nyx.motionResolve({ level, reducedMotion: reduced })
      : { durationMs: 150, easing: 'ease', press: 'none', level, reduced };
    root.style.setProperty('--motion-ms', `${motion.durationMs}ms`);
    root.style.setProperty('--motion-ease', motion.easing);
    root.style.setProperty('--motion-press', motion.press || 'none');
    root.dataset.motion = motion.level;
    root.classList.toggle('motion-reduced', Boolean(motion.reduced));
  }

  async function saveUiPref(key, value) {
    const res = await window.nyx.setUiPref(key, value);
    if (!res || !res.ok) {
      setStatus(`保存失败：${(res && res.error) || '未知原因'}`);
      await loadUiPrefs();
      return;
    }
    uiPrefs = res.ui;
    if (key === 'motionLevel') {
      applySettingsMotion(res.ui);
      const motionLabel = res.ui && res.ui.motionLevel === 'lively' ? '活泼' : '克制';
      byId('appearance-hint').textContent = `动效已切到「${motionLabel}」，主窗口与设置页都已生效。`;
      setStatus('外观设置已更新');
      return;
    }
    const label =
      key === 'showLinkBadge'
        ? '出站链路徽标'
        : key === 'toolbarLabels'
          ? '顶栏按钮文字'
          : '隐私模式开关';
    byId('appearance-hint').textContent = `${label}已${value ? '显示' : '隐藏'}，主窗口顶栏已同步。`;
    setStatus('外观设置已更新');
  }

  byId('pref-show-link-badge').addEventListener('change', (event) => {
    saveUiPref('showLinkBadge', event.target.checked);
  });

  byId('pref-show-mode-switch').addEventListener('change', (event) => {
    saveUiPref('showModeSwitch', event.target.checked);
  });

  if (byId('pref-toolbar-labels')) {
    byId('pref-toolbar-labels').addEventListener('change', (event) => {
      saveUiPref('toolbarLabels', event.target.checked);
    });
  }

  if (byId('pref-motion-level')) {
    byId('pref-motion-level').addEventListener('change', (event) => {
      saveUiPref('motionLevel', event.target.value === 'lively' ? 'lively' : 'calm');
    });
  }

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
    renderDisplayBadges(res.ui);
    byId('appearance-hint').textContent = `主题已切换为${
      event.target.selectedOptions[0].textContent
    }，主窗口已同步。`;
    setStatus('主题已切换');
  });

  byId('btn-appearance-reset').addEventListener('click', async () => {
    await saveUiPref('showLinkBadge', true);
    await saveUiPref('showModeSwitch', true);
    await saveUiPref('theme', 'ink');
    // 「回复默认外观」现在也管这一页的三项：动效回克制、顶栏小字回开
    await saveUiPref('motionLevel', 'calm');
    await saveUiPref('toolbarLabels', true);
    await loadUiPrefs();
    byId('appearance-hint').textContent =
      '已恢复默认外观：墨夜主题、克制动效、顶栏显示小字与链路徽标、模式开关。';
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

  /**
   * 站点设备白名单：只读列表 + 逐站点撤销。
   * 数据来自 nyx:permissions:list 的 whitelist 字段；隐私模式不使用这份名单。
   */
  function renderPermissionWhitelist(view) {
    const badge = byId('perm-whitelist-badge');
    const hint = byId('perm-whitelist-hint');
    const wrap = byId('perm-whitelist-wrap');
    if (!badge || !wrap) return;
    wrap.textContent = '';

    const entries = (view && Array.isArray(view.whitelist)) ? view.whitelist : [];
    const error = (view && view.whitelistError) || '';
    badge.textContent = `白名单 ${entries.length} 个站点`;
    badge.classList.toggle('bad', Boolean(error));

    if (hint) {
      hint.textContent = error
        ? `白名单读写有问题：${error}`
        : entries.length
          ? '这些站点在正常模式下不再询问对应设备；撤销后下次访问会重新询问。'
          : '还没有站点进入白名单。站点选择「始终允许」后会出现在这里。';
      hint.classList.toggle('warn-text', Boolean(error));
    }

    if (!entries.length) {
      const note = document.createElement('p');
      note.className = 'empty-note';
      note.textContent = '摄像头、麦克风、屏幕共享等设备的「始终允许」会记录在这份名单里；隐私模式一律拒绝，不读这份名单。';
      wrap.appendChild(note);
      return;
    }

    const table = document.createElement('table');
    table.className = 'mini-table';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const title of ['来源', '允许的设备', '记录时间', '操作']) {
      const th = document.createElement('th');
      th.textContent = title;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement('tbody');
    for (const item of entries) {
      const row = document.createElement('tr');
      const labels = (item.labels && item.labels.length ? item.labels : item.keys || []).join('、');

      const originCell = document.createElement('td');
      originCell.textContent = item.origin || '—';
      originCell.className = 'mono';
      row.appendChild(originCell);

      const labelCell = document.createElement('td');
      labelCell.textContent = labels || '—';
      row.appendChild(labelCell);

      const timeCell = document.createElement('td');
      timeCell.textContent = formatTime(item.at);
      timeCell.className = 'mono';
      row.appendChild(timeCell);

      const actionCell = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-mini';
      button.textContent = '撤销';
      button.addEventListener('click', async () => {
        if (!window.confirm(`撤销该站点的设备授权？\n\n${item.origin}\n${labels}\n\n下次访问会重新询问。`)) return;
        const res = await window.nyx.revokePermission(item.origin);
        if (!res || !res.ok) {
          setStatus(`撤销失败：${(res && res.error) || '未知原因'}`, true);
          return;
        }
        setStatus(`已撤销 ${item.origin} 的设备授权`);
        await loadPrivacy();
      });
      actionCell.appendChild(button);
      row.appendChild(actionCell);

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

  /* ------------------------------------------------------------------ */
  /* 隐私模式的出站方式（B3）                                             */
  /* ------------------------------------------------------------------ */

  /** 出站方式卡片是否已绑过事件（只绑一次，避免重复进入分区叠加监听） */
  let privacyLinkWired = false;

  /** 把主进程返回的取值与文案渲染到卡片上 */
  function renderPrivacyLink(payload) {
    const data = payload && payload.ok !== false ? payload : { link: 'proxy', options: [] };
    const link = data.link === 'direct' ? 'direct' : 'proxy';
    const options = Array.isArray(data.options) ? data.options : [];
    const direct = options.find((item) => item && item.value === 'direct');
    const lost = (direct && Array.isArray(direct.lost) && direct.lost) || [];

    const proxyRadio = byId('privacy-link-proxy');
    const directRadio = byId('privacy-link-direct');
    if (proxyRadio) proxyRadio.checked = link === 'proxy';
    if (directRadio) directRadio.checked = link === 'direct';

    const badge = byId('privacy-link-badge');
    if (badge) {
      badge.textContent = link === 'proxy' ? '经代理' : '真实 IP';
      badge.classList.toggle('warn', link === 'proxy');
      badge.classList.toggle('bad', link === 'direct');
    }

    const lostBox = byId('privacy-link-lost');
    if (lostBox) {
      lostBox.textContent = '';
      for (const line of lost) {
        const li = document.createElement('li');
        li.textContent = String(line);
        lostBox.appendChild(li);
      }
      lostBox.hidden = link !== 'direct' && lost.length === 0;
    }

    // 风险确认只在「已选真实 IP」时才需要保留勾选状态展示；改回代理就收起并清空，
    // 免得下次再选直连时拿旧的勾选当作"用户看过了"
    const ackRow = byId('privacy-link-ack-row');
    const ack = byId('privacy-link-ack');
    if (ackRow) ackRow.hidden = link !== 'direct';
    if (ack && link !== 'direct') ack.checked = false;

    const status = byId('privacy-link-status');
    if (status) {
      status.textContent =
        link === 'proxy'
          ? `当前：经代理${data.mode === 'private' ? '（隐私模式生效中）' : ''}`
          : `当前：真实 IP 直连${data.mode === 'private' ? '（隐私模式正在直连，站点能看到你的真实 IP）' : ''}`;
      status.classList.toggle('is-warn', link === 'direct');
    }
  }

  /** 读取并渲染出站方式；失败也要说清原因，不能静默停在「—」 */
  async function loadPrivacyLink() {
    if (!window.nyx.privacyLink) return;

    try {
      renderPrivacyLink(await window.nyx.privacyLink());
    } catch (err) {
      const status = byId('privacy-link-status');
      if (status) status.textContent = `读取出站方式失败：${err.message}`;
    }

    if (!privacyLinkWired) wirePrivacyLink();
  }

  function wirePrivacyLink() {
    const proxyRadio = byId('privacy-link-proxy');
    const directRadio = byId('privacy-link-direct');
    const ack = byId('privacy-link-ack');
    const status = byId('privacy-link-status');
    if (!proxyRadio || !directRadio || !ack) return;

    privacyLinkWired = true;

    // 勾选框只影响"能不能提交"，不自己改链路
    ack.addEventListener('change', () => {
      if (status) {
        status.textContent = ack.checked
          ? '已勾选风险确认，选择「真实 IP」后立即生效'
          : '取消勾选后无法选择「真实 IP」';
        status.classList.toggle('is-warn', ack.checked);
      }
      if (!ack.checked && directRadio.checked) {
        directRadio.checked = false;
        proxyRadio.checked = true;
      }
    });

    const apply = async (link) => {
      if (link === 'direct' && !ack.checked) {
        // 没勾确认就不发请求：直接把选择回退，并说清为什么
        directRadio.checked = false;
        proxyRadio.checked = true;
        if (status) {
          status.textContent = '要把隐私模式改成直连，请先勾选「我已了解上述风险」。';
          status.classList.add('is-warn');
        }
        return;
      }

      if (status) {
        status.textContent = link === 'direct' ? '正在改为真实 IP…' : '正在改回经代理…';
        status.classList.remove('is-warn');
      }

      let res = null;
      try {
        res = await window.nyx.privacyLinkSet({ link, ack: link === 'direct' });
      } catch (err) {
        res = { ok: false, error: err.message };
      }

      if (!res || res.ok === false) {
        if (status) {
          status.textContent = `没有改成：${(res && res.error) || '未知原因'}`;
          status.classList.add('is-warn');
        }
        await loadPrivacyLink();
        return;
      }

      setStatus(link === 'direct' ? '隐私模式出站已改为真实 IP' : '隐私模式出站已改回经代理');
      await loadPrivacyLink();
    };

    proxyRadio.addEventListener('change', () => {
      if (proxyRadio.checked) apply('proxy');
    });
    directRadio.addEventListener('change', () => {
      if (directRadio.checked) apply('direct');
    });
  }

  /* ---------------- 录屏 / 被远控检测（清单 C4） ---------------- */

  let screenWatchWired = false;

  /** 把检测结果渲染到卡片：徽标、结论、命中的程序清单、需要确认时的勾选框 */
  function renderScreenWatch(payload) {
    const badge = byId('screen-watch-badge');
    const status = byId('screen-watch-status');
    const hitsEl = byId('screen-watch-hits');
    const note = byId('screen-watch-note');
    const ackRow = byId('screen-watch-ack-row');
    const data = payload && typeof payload === 'object' ? payload : {};

    if (!badge || !status) return;

    const level = data.level === 'risk' || data.level === 'unknown' ? data.level : 'none';
    badge.textContent = level === 'risk' ? '有风险' : level === 'unknown' ? '无法确认' : '未发现';
    badge.className = `badge ${level === 'none' ? 'ok' : level === 'risk' ? 'bad' : 'warn'}`;

    status.textContent = data.title ? `${data.title}。${data.summary || ''}` : '还没有检测结果';
    status.className = `hint ${level === 'none' ? 'is-ok' : 'is-warn'}`;

    if (hitsEl) {
      hitsEl.textContent = '';
      const hits = Array.isArray(data.hits) ? data.hits : [];
      hitsEl.hidden = hits.length === 0;
      for (const hit of hits) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'hit-name';
        name.textContent = hit.label || hit.name;
        const cat = document.createElement('span');
        cat.className = 'hit-cat';
        cat.textContent = hit.categoryLabel || '';
        li.append(name, cat);
        hitsEl.append(li);
      }
    }

    if (note) {
      note.textContent = data.message || '';
      note.className = 'hint';
    }

    if (ackRow) {
      // 只有「无法确认」才需要勾确认：有风险时勾了也不许进（隐私模式不拿"我确认"换安全）
      const needAck = level === 'unknown';
      ackRow.hidden = !needAck;
      const ack = byId('screen-watch-ack');
      if (ack && !needAck) ack.checked = false;
    }
  }

  async function loadScreenWatch() {
    if (!window.nyx || typeof window.nyx.screenWatch !== 'function') {
      const status = byId('screen-watch-status');
      if (status) {
        status.textContent = '当前内核不支持录屏检测。';
        status.className = 'hint is-warn';
      }
      return;
    }
    const status = byId('screen-watch-status');
    if (status) {
      status.textContent = '正在检查本机进程…';
      status.className = 'hint';
    }
    try {
      const res = await window.nyx.screenWatch();
      renderScreenWatch(res);
    } catch (err) {
      if (status) {
        status.textContent = `检测失败：${err && err.message ? err.message : '未知原因'}`;
        status.className = 'hint is-warn';
      }
    }
    if (!screenWatchWired) wireScreenWatch();
  }

  function wireScreenWatch() {
    screenWatchWired = true;
    const checkBtn = byId('btn-screen-watch-check');
    const ack = byId('screen-watch-ack');

    if (checkBtn) {
      checkBtn.addEventListener('click', async () => {
        checkBtn.disabled = true;
        try {
          await loadScreenWatch();
          setStatus('已重新检查本机进程');
        } finally {
          checkBtn.disabled = false;
        }
      });
    }

    if (ack) {
      ack.addEventListener('change', async () => {
        if (!ack.checked) return;
        try {
          const res = await window.nyx.screenWatchAck();
          if (res && res.ok) {
            setStatus('已记录你的确认：10 分钟内允许进入隐私模式（期间仍会重新检测）');
          } else {
            setStatus('没能记录确认，请重试', true);
          }
        } catch (err) {
          setStatus(`没能记录确认：${err && err.message ? err.message : '未知原因'}`, true);
        }
      });
    }
  }

  /* ---------------- 离线阅读缓存（候选③） ---------------- */

  let offlineCacheWired = false;

  /** 渲染开关、条目数、文件落点；说明里不藏"关掉会清空"这件事 */
  function renderOfflineCache(payload) {
    const data = payload && payload.ok !== false ? payload : { enabled: false, count: 0, limit: 0, file: '' };
    const enabled = data.enabled !== false;
    const count = Number(data.count) || 0;

    const badge = byId('offline-badge');
    if (badge) {
      badge.textContent = enabled ? (count ? `已保存 ${count} 页` : '已开启') : '已关闭';
      badge.className = `badge ${enabled ? 'ok' : 'warn'}`;
    }

    const box = byId('offline-cache-enabled');
    if (box) box.checked = enabled;

    const facts = byId('offline-facts');
    if (facts) {
      const limit = Number(data.limit) || 0;
      facts.textContent = count
        ? `当前保存了 ${count} 页正文快照${limit ? `（最多 ${limit} 页，最旧的会被顶掉）` : ''} · 文件：${data.file || '未知'}`
        : `还没有保存任何正文快照${limit ? `（最多保存 ${limit} 页）` : ''} · 文件：${data.file || '未知'}`;
    }

    // 隐私模式那半边（用户第 2 项）：加密是否可用、存了几条、为什么没存，都要说出来
    const privateBox = byId('offline-private-enabled');
    const privateEnabled = data.privateEnabled !== false;
    if (privateBox) {
      privateBox.checked = privateEnabled;
      // 系统密钥不可用时这个开关是摆设，直接禁掉并说明原因，别让人以为开了就有
      const usable = data.privateAvailable !== false;
      privateBox.disabled = !usable;
      privateBox.title = usable ? '' : (data.privateReason || '系统密钥不可用，隐私模式的快照不会被保存。');
    }
    const privateFacts = byId('offline-private-facts');
    if (privateFacts) {
      const info = data.private || {};
      const privateCount = Number(info.count) || 0;
      const parts = [];
      if (data.privateAvailable === false) {
        parts.push(data.privateReason || '系统密钥不可用，隐私模式的快照不会被保存。');
      } else if (privateEnabled) {
        parts.push(
          privateCount
            ? `隐私模式已加密保存 ${privateCount} 条快照（最多 ${Number(info.limit) || 0} 条，${Number(info.ttlHours) || 24} 小时后自动作废）`
            : '隐私模式还没有加密快照（最多 20 条，24 小时后自动作废）',
        );
        parts.push(`落点：${data.privateFile || '未知'}`);
        parts.push('整条加密，明面上只有地址哈希与时间；只有这台机器的这个账户能解开');
      } else {
        parts.push('隐私模式不保存快照（关掉了这一项）');
      }
      if (data.privateNotice) parts.push(data.privateNotice);
      privateFacts.textContent = parts.join(' · ');
    }

    // 解不开的加密快照：换系统账户 / 密钥变了就会出现。
    // 必须给出口——只报错不给一键清理，用户最后只能删掉整个文件，连能解的也丢。
    const broken = Number(data.privateBroken) || 0;
    const brokenBox = byId('offline-private-broken');
    const brokenText = byId('offline-private-broken-text');
    if (brokenBox) brokenBox.hidden = broken <= 0;
    if (brokenText) {
      brokenText.textContent = broken
        ? data.privateBrokenNote ||
          `有 ${broken} 条加密快照解不开（多半是换了系统账户或系统密钥变了）。它们显示不出来，也不会自己恢复。`
        : '';
    }
  }

  /**
   * 站点名单渲染。普通模式与隐私模式两份名单字段相同、规则相同，
   * 只有落盘的键名和文案不同，所以共用一个渲染函数、传前缀区分。
   */
  function renderSiteGroup(prefix, data, wording) {
    const mode = byId(`${prefix}-mode`);
    if (mode) mode.value = data.mode === 'allowlist' ? 'allowlist' : 'all';
    const allow = byId(`${prefix}-allow`);
    if (allow && document.activeElement !== allow) allow.value = (data.allow || []).join('\n');
    const block = byId(`${prefix}-block`);
    if (block && document.activeElement !== block) block.value = (data.block || []).join('\n');
    const facts = byId(`${prefix}-facts`);
    if (facts) {
      const allowCount = (data.allow || []).length;
      const blockCount = (data.block || []).length;
      facts.textContent =
        (data.mode === 'allowlist'
          ? `${wording.only} ${allowCount} 个站点`
          : `${wording.all}（除非在黑名单里）`) +
        (blockCount ? ` · ${wording.never} ${blockCount} 个站点：${(data.block || []).join('、')}` : '');
    }
  }

  function renderCacheSites(payload) {
    const data = payload && payload.ok !== false ? payload : { mode: 'all', allow: [], block: [] };
    renderSiteGroup('offline-site', data, { only: '只缓存名单里的', all: '所有站点都缓存', never: '永不缓存' });
    const priv = data.private && typeof data.private === 'object' ? data.private : { mode: 'all', allow: [], block: [] };
    renderSiteGroup('offline-private-site', priv, {
      only: '隐私模式只存名单里的',
      all: '隐私模式所有站点都存（加密）',
      never: '隐私模式永不存',
    });
  }

  async function saveCacheSites(patch, okText, scope) {
    if (!window.nyx || typeof window.nyx.offlineCacheSitesSet !== 'function') {
      setOfflineStatus('当前内核不支持修改站点名单。', true);
      return;
    }
    try {
      const body = Object.assign({}, patch);
      if (scope === 'private') body.scope = 'private';
      const res = await window.nyx.offlineCacheSitesSet(body);
      if (!res || res.ok === false) {
        setOfflineStatus(`没有改成：${(res && res.error) || '未知原因'}`, true);
        renderCacheSites(res);
        return;
      }
      renderCacheSites(res);
      setOfflineStatus(okText || '已保存。', false);
    } catch (err) {
      setOfflineStatus(`没有改成：${err && err.message ? err.message : '未知原因'}`, true);
    }
  }

  async function loadCacheSites() {
    if (!window.nyx || typeof window.nyx.offlineCacheSites !== 'function') return;
    try {
      renderCacheSites(await window.nyx.offlineCacheSites());
    } catch (err) {
      setOfflineStatus(`读取站点名单失败：${err && err.message ? err.message : '未知原因'}`, true);
    }
  }

  /**
   * 「只存这些」模板：每个模板一行，站点逐项列出来（不折叠成"等 N 个"），
   * 点「并进名单」才写盘，写之前不碰任何已有内容。
   */
  async function loadPrivateTemplates() {
    const list = byId('offline-private-template-list');
    if (!list) return;
    wireTemplateSave();
    wireTemplateIo();
    if (!window.nyx || typeof window.nyx.offlineCachePrivateTemplates !== 'function') {
      list.textContent = '当前内核不支持套模板。';
      return;
    }
    let res = null;
    try {
      res = await window.nyx.offlineCachePrivateTemplates();
    } catch (err) {
      list.textContent = `读取模板失败：${err && err.message ? err.message : '未知原因'}`;
      return;
    }
    const templates = (res && Array.isArray(res.templates) && res.templates) || [];
    // 名单生效与否先说清楚：快照关着、或这台机器加密不可用时，名单改了也不会有任何效果
    const effective = res && res.effective ? res.effective : null;
    const statusLine = byId('offline-private-template-status');
    const showEffective = (force) => {
      if (!statusLine) return;
      if (effective && effective.active === false && (force || !statusLine.textContent)) {
        statusLine.className = 'hint is-warn';
        statusLine.textContent = effective.note || '这份名单现在不会生效。';
      }
    };
    showEffective(false);
    if (!templates.length) {
      list.textContent = '没有可用的模板。';
      return;
    }
    list.textContent = '';
    for (const template of templates) {
      const row = document.createElement('div');
      row.className = 'template-row';
      const head = document.createElement('div');
      head.className = 'template-head';
      const title = document.createElement('strong');
      title.textContent = template.custom ? `${template.label}（我的）` : template.label;
      const count = document.createElement('span');
      count.className = 'template-count';
      count.textContent = `${template.count} 个站点`;
      // 两种语义分开给两颗按钮：并进（默认）与替换（第九轮 ⑤）。替换会覆盖手写名单，
      // 所以它就明写成「替换名单」，不藏在同一个按钮的弹窗里。
      const runApply = async (mode) => {
        const status = byId('offline-private-template-status');
        const alsoNormalBox = byId('offline-private-template-also-normal');
        const alsoNormal = Boolean(alsoNormalBox && alsoNormalBox.checked);
        const applied = await window.nyx
          .offlineCachePrivateTemplateApply({ key: template.key, mode, alsoNormal })
          .catch(() => null);
        if (!applied || applied.ok === false) {
          if (status) {
            status.className = 'hint is-warn';
            status.textContent = `没有套上：${(applied && applied.error) || '主进程没有响应'}`;
          }
          setOfflineStatus('套模板失败', true);
          return;
        }
        if (status) {
          const added = Array.isArray(applied.added) ? applied.added : [];
          const skipped = Array.isArray(applied.skipped) ? applied.skipped : [];
          const dropped = Array.isArray(applied.dropped) ? applied.dropped : [];
          const normal = applied.normal;
          status.className = 'hint is-ok';
          status.textContent =
            `${applied.message}` +
            (added.length ? `\n新加：${added.join('、')}` : '') +
            (skipped.length ? `\n本来就在：${skipped.join('、')}` : '') +
            (dropped.length ? `\n被换掉：${dropped.join('、')}` : '') +
            (normal && normal.ok === false ? `\n普通模式的名单没改成：${normal.error}` : '');
        }
        renderCacheSites({ ok: true, mode: applied.private ? applied.private.mode : 'allowlist', allow: applied.private ? applied.private.allow : [], block: applied.private ? applied.private.block : [], private: applied.private });
        setOfflineStatus(mode === 'replace' ? '隐私模式名单已按模板切换' : '模板已并入隐私模式名单');
      };
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'btn btn-mini';
      apply.textContent = '并进名单';
      apply.setAttribute('aria-label', `把「${template.label}」的 ${template.count} 个站点并进隐私模式名单`);
      apply.addEventListener('click', async () => {
        apply.disabled = true;
        try {
          await runApply('merge');
        } finally {
          apply.disabled = false;
        }
      });
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'btn btn-mini';
      switchBtn.textContent = '替换名单';
      switchBtn.title = '把这份名单整个换成模板里的站点（屏蔽名单不动，换掉了哪几条会列在下面）';
      switchBtn.setAttribute('aria-label', `用「${template.label}」替换隐私模式名单（现在手写的那些会被换掉）`);
      switchBtn.addEventListener('click', async () => {
        switchBtn.disabled = true;
        try {
          await runApply('replace');
        } finally {
          switchBtn.disabled = false;
        }
      });
      head.append(title, count, apply, switchBtn);
      if (template.custom) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-mini';
        remove.textContent = '删除';
        remove.setAttribute('aria-label', `删掉模板「${template.label}」（只删模板，不动名单）`);
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          const status = byId('offline-private-template-status');
          let res = null;
          try {
            res = await window.nyx.offlineCachePrivateTemplateRemove({ key: template.key });
          } catch (err) {
            res = { ok: false, error: err && err.message ? err.message : '未知原因' };
          }
          remove.disabled = false;
          if (status) {
            status.className = res && res.ok ? 'hint is-ok' : 'hint is-warn';
            status.textContent = res && res.ok
              ? (res.message || '已经删掉这个模板。')
              : `没能删掉：${(res && res.error) || '主进程没有响应'}`;
          }
          if (res && res.ok) await loadPrivateTemplates();
        });
        head.append(remove);
      }
      const summaryText = document.createElement('p');
      summaryText.className = 'hint';
      summaryText.textContent = template.summary;
      const sites = document.createElement('p');
      sites.className = 'hint template-sites';
      sites.textContent = (template.sites || []).join('、');
      row.append(head, summaryText, sites);
      list.append(row);
    }
  }

  /**
   * 「存成模板」按钮：把当前隐私名单快照成一个模板。
   * 只绑一次；存完刷新列表，好让人立刻看到自己那条。
   */
  function wireTemplateSave() {
    const button = byId('btn-offline-private-template-save');
    if (!button || button.dataset.wired === 'true') return;
    button.dataset.wired = 'true';
    button.addEventListener('click', async () => {
      const status = byId('offline-private-template-status');
      const input = byId('offline-private-template-name');
      if (!window.nyx || typeof window.nyx.offlineCachePrivateTemplateSave !== 'function') {
        if (status) {
          status.className = 'hint is-warn';
          status.textContent = '当前内核不支持保存模板。';
        }
        return;
      }
      const name = input ? input.value.trim() : '';
      button.disabled = true;
      let res = null;
      try {
        res = await window.nyx.offlineCachePrivateTemplateSave({ name });
      } catch (err) {
        res = { ok: false, error: err && err.message ? err.message : '未知原因' };
      }
      button.disabled = false;
      if (status) {
        status.className = res && res.ok ? 'hint is-ok' : 'hint is-warn';
        status.textContent = res && res.ok
          ? (res.message || '已存成模板。')
          : `没能存成模板：${(res && res.error) || '主进程没有响应'}`;
      }
      if (res && res.ok) {
        if (input) input.value = '';
        await loadPrivateTemplates();
      }
    });
  }

  /**
   * 模板搬走再搬回来（第九轮 ③）：模板是一份可搬走的清单，换机器不该靠手敲。
   * 导错文件（比如把站点名单导进来）由主进程按 kind 拒绝，这里只如实显示原因。
   */
  function wireTemplateIo() {
    const status = () => byId('offline-private-template-status');
    const say = (text, kind) => {
      const box = status();
      if (!box) return;
      box.className = kind === 'ok' ? 'hint is-ok' : 'hint is-warn';
      box.textContent = text;
    };
    const exportButton = byId('btn-offline-private-templates-export');
    if (exportButton && exportButton.dataset.wired !== 'true') {
      exportButton.dataset.wired = 'true';
      exportButton.addEventListener('click', async () => {
        if (!window.nyx || typeof window.nyx.offlineCachePrivateTemplatesExport !== 'function') {
          say('当前内核不支持导出模板。');
          return;
        }
        exportButton.disabled = true;
        let res = null;
        try {
          res = await window.nyx.offlineCachePrivateTemplatesExport();
        } catch (err) {
          res = { ok: false, error: err && err.message ? err.message : '未知原因' };
        }
        exportButton.disabled = false;
        if (res && res.ok) say(`已导出 ${res.count} 个模板：${res.path}`, 'ok');
        else if (res && res.canceled) say('已取消导出。');
        else say(`没能导出模板：${(res && res.error) || '主进程没有响应'}`);
      });
    }
    const importButton = byId('btn-offline-private-templates-import');
    if (importButton && importButton.dataset.wired !== 'true') {
      importButton.dataset.wired = 'true';
      importButton.addEventListener('click', async () => {
        if (!window.nyx || typeof window.nyx.offlineCachePrivateTemplatesImport !== 'function') {
          say('当前内核不支持导入模板。');
          return;
        }
        importButton.disabled = true;
        let res = null;
        try {
          res = await window.nyx.offlineCachePrivateTemplatesImport({ mode: 'merge' });
        } catch (err) {
          res = { ok: false, error: err && err.message ? err.message : '未知原因' };
        }
        importButton.disabled = false;
        if (res && res.ok) {
          say(res.summary || '模板已导入。', 'ok');
          await loadPrivateTemplates();
        } else if (res && res.canceled) {
          say('已取消导入。');
        } else {
          say(`没能导入模板：${(res && res.error) || '主进程没有响应'}`);
        }
      });
    }
  }

  function wireCacheSites() {
    const mode = byId('offline-site-mode');
    if (mode) {
      mode.addEventListener('change', () => {
        saveCacheSites({ mode: mode.value }, mode.value === 'allowlist' ? '已切成「只缓存名单里的站点」。' : '已切成「所有站点都缓存」。');
      });
    }
    // 隐私模式那一份：同一个保存通道，只是多带 scope
    const privMode = byId('offline-private-site-mode');
    if (privMode) {
      privMode.addEventListener('change', () => {
        saveCacheSites(
          { mode: privMode.value },
          privMode.value === 'allowlist' ? '隐私模式已切成「只存名单里的站点」。' : '隐私模式已切成「所有站点都存（加密）」。',
          'private',
        );
      });
    }
    const bindList = (id, key, label, scope) => {
      const box = byId(id);
      if (!box) return;
      // 用 change（失焦/回车触发），不用 input —— 每敲一个字就写盘会把磁盘打满
      box.addEventListener('change', () => {
        const list = box.value
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
        saveCacheSites({ [key]: list }, `已保存${label}：${list.length} 个站点。`, scope);
      });
    };
    bindList('offline-site-allow', 'allow', '「只缓存」名单');
    bindList('offline-site-block', 'block', '「永不缓存」名单');
    bindList('offline-private-site-allow', 'allow', '隐私模式「只存」名单', 'private');
    bindList('offline-private-site-block', 'block', '隐私模式「永不存」名单', 'private');

    // 名单搬走 / 搬回来（候选⑤ + 第五轮 ③：普通模式与隐私模式各一份，别导错）
    const wireSiteIo = (scope, prefix, lineId, what) => {
      const line = byId(lineId);
      const setIo = (text, bad) => {
        if (!line) return;
        line.textContent = text || '';
        line.className = bad ? 'hint is-warn' : 'hint';
      };
      const payload = (extra) => ({ scope, ...(extra || {}) });

      const exportBtn = byId(`btn-${prefix}-export`);
      if (exportBtn && !exportBtn.dataset.wired) {
        exportBtn.dataset.wired = '1';
        exportBtn.addEventListener('click', async () => {
          if (!window.nyx || typeof window.nyx.offlineCacheSitesExport !== 'function') {
            setIo('当前内核不支持导出站点名单。', true);
            return;
          }
          exportBtn.disabled = true;
          try {
            const res = await window.nyx.offlineCacheSitesExport(payload());
            if (!res || res.ok === false) {
              setIo((res && res.canceled ? '' : `没能导出${what}：`) + ((res && res.error) || '未知原因'), !(res && res.canceled));
              return;
            }
            setIo(`已导出${what}：${res.path}（只存 ${res.allow} 个 / 永不存 ${res.block} 个）`, false);
          } catch (err) {
            setIo(`没能导出${what}：${err && err.message ? err.message : '未知原因'}`, true);
          } finally {
            exportBtn.disabled = false;
          }
        });
      }

      const importBtn = byId(`btn-${prefix}-import`);
      if (importBtn && !importBtn.dataset.wired) {
        importBtn.dataset.wired = '1';
        importBtn.addEventListener('click', async () => {
          if (!window.nyx || typeof window.nyx.offlineCacheSitesImport !== 'function') {
            setIo('当前内核不支持导入站点名单。', true);
            return;
          }
          importBtn.disabled = true;
          try {
            const res = await window.nyx.offlineCacheSitesImport(payload({ mode: 'merge' }));
            if (!res || res.ok === false) {
              setIo((res && res.canceled ? '' : `没能导入${what}：`) + ((res && res.error) || '未知原因'), !(res && res.canceled));
              return;
            }
            renderCacheSites(res);
            const info = res.imported || {};
            setIo(
              `${info.summary || '导入完成。'}${info.rejectedCount ? `（跳过的条目：${(info.rejected || []).join('、')}）` : ''}`,
              false,
            );
          } catch (err) {
            setIo(`没能导入${what}：${err && err.message ? err.message : '未知原因'}`, true);
          } finally {
            importBtn.disabled = false;
          }
        });
      }
    };
    wireSiteIo('normal', 'offline-sites', 'offline-site-io', '离线缓存的站点名单');
    wireSiteIo('private', 'offline-private-sites', 'offline-private-site-io', '隐私模式的站点名单');
  }

  function setOfflineStatus(text, bad) {
    const status = byId('offline-status');
    if (!status) return;
    status.textContent = text || '';
    status.className = bad ? 'hint is-warn' : 'hint';
  }

  async function loadOfflineCache() {
    if (!window.nyx || typeof window.nyx.offlineCacheGet !== 'function') {
      setOfflineStatus('当前内核不支持离线缓存设置。', true);
      return;
    }
    try {
      const res = await window.nyx.offlineCacheGet();
      renderOfflineCache(res);
      if (res && res.ok === false) setOfflineStatus(res.error || '读取离线缓存状态失败', true);
    } catch (err) {
      setOfflineStatus(`读取离线缓存状态失败：${err && err.message ? err.message : '未知原因'}`, true);
    }
    if (!offlineCacheWired) wireOfflineCache();
    await loadCacheSites();
    await loadPrivateTemplates();
    wireCacheSites();
  }

  function wireOfflineCache() {
    offlineCacheWired = true;

    const box = byId('offline-cache-enabled');
    if (box) {
      box.addEventListener('change', async () => {
        const enabled = box.checked;
        box.disabled = true;
        try {
          const res = await window.nyx.offlineCacheSet({ enabled });
          if (!res || res.ok === false) {
            box.checked = !enabled;
            setOfflineStatus(`没有改成：${(res && res.error) || '未知原因'}`, true);
            return;
          }
          renderOfflineCache(res);
          if (!enabled) {
            setOfflineStatus(`已关闭：不再保存正文快照${res.cleared ? `，并清掉了原有的 ${res.cleared} 页` : ''}。`, false);
          } else {
            setOfflineStatus('已开启：此后打开的 http(s) 页面会保存一份纯文字快照。', false);
          }
        } catch (err) {
          box.checked = !enabled;
          setOfflineStatus(`没有改成：${err && err.message ? err.message : '未知原因'}`, true);
        } finally {
          box.disabled = false;
        }
      });
    }

    const privateBox = byId('offline-private-enabled');
    if (privateBox) {
      privateBox.addEventListener('change', async () => {
        const enabled = privateBox.checked;
        privateBox.disabled = true;
        try {
          const res = await window.nyx.offlineCacheSet({ enabled, private: true });
          if (!res || res.ok === false) {
            privateBox.checked = !enabled;
            setOfflineStatus(`没有改成：${(res && res.error) || '未知原因'}`, true);
            return;
          }
          renderOfflineCache(res);
          if (!enabled) {
            setOfflineStatus(
              `隐私模式不再保存快照${res.privateCleared ? `，并清掉了已存的 ${res.privateCleared} 条加密快照` : ''}。`,
              false,
            );
          } else {
            setOfflineStatus('隐私模式已开启加密快照：只在这台机器的这个账户下能解开。', false);
          }
        } catch (err) {
          privateBox.checked = !enabled;
          setOfflineStatus(`没有改成：${err && err.message ? err.message : '未知原因'}`, true);
        } finally {
          privateBox.disabled = false;
        }
      });
    }

    const clearBtn = byId('btn-offline-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        clearBtn.disabled = true;
        try {
          const res = await window.nyx.offlineCacheClear();
          if (!res || res.ok === false) {
            setOfflineStatus(`没有清掉：${(res && res.error) || '未知原因'}`, true);
            return;
          }
          renderOfflineCache(res);
          const privateCleared = Number(res && res.privateCleared) || 0;
          setOfflineStatus(
            res.cleared || privateCleared
              ? `已清空 ${res.cleared || 0} 页明文快照${privateCleared ? `，以及 ${privateCleared} 条加密快照` : ''}。`
              : '本来就是空的，没有可清的。',
            false,
          );
        } catch (err) {
          setOfflineStatus(`没有清掉：${err && err.message ? err.message : '未知原因'}`, true);
        } finally {
          clearBtn.disabled = false;
        }
      });
    }

    // 只清「解不开的」那些（候选③）：能解开的留着，不给"换过账户"的人一刀切
    const resetBtn = byId('btn-offline-private-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        if (!window.nyx || typeof window.nyx.offlineCachePrivateReset !== 'function') {
          setOfflineStatus('当前内核不支持清理加密快照。', true);
          return;
        }
        resetBtn.disabled = true;
        try {
          const res = await window.nyx.offlineCachePrivateReset();
          if (!res || res.ok === false) {
            setOfflineStatus(`没有清掉：${(res && res.error) || '未知原因'}`, true);
            return;
          }
          renderOfflineCache(res);
          const dropped = Number(res && res.dropped) || 0;
          const left = Number(res && res.privateLeft) || 0;
          setOfflineStatus(
            dropped
              ? `已清掉 ${dropped} 条解不开的快照${left ? `，还留着 ${left} 条能解开的` : '，现在没有加密快照了'}。`
              : '没有解不开的快照，什么都没动。',
            false,
          );
        } catch (err) {
          setOfflineStatus(`没有清掉：${err && err.message ? err.message : '未知原因'}`, true);
        } finally {
          resetBtn.disabled = false;
        }
      });
    }
  }

  /* ---------------- 图形性能（清单 A5） ---------------- */

  let gpuPolicyWired = false;

  /** 把主进程返回的策略、本次启动策略与适配器信息渲染到卡片上 */
  function renderGpuPolicy(payload) {
    const data = payload && payload.ok !== false ? payload : { policy: 'low-power', options: [] };
    const policy = ['low-power', 'high-performance', 'auto'].includes(data.policy) ? data.policy : 'low-power';
    const bootPolicy = ['low-power', 'high-performance', 'auto'].includes(data.bootPolicy)
      ? data.bootPolicy
      : policy;
    const options = Array.isArray(data.options) ? data.options : [];

    for (const value of ['low-power', 'high-performance', 'auto']) {
      const radio = byId(`gpu-policy-${value}`);
      if (radio) radio.checked = value === policy;
    }

    const option = options.find((item) => item && item.value === policy) || null;
    const bootOption = options.find((item) => item && item.value === bootPolicy) || null;

    const badge = byId('gpu-policy-badge');
    if (badge) {
      badge.textContent = (option && option.label) || policy;
      badge.classList.toggle('warn', policy !== bootPolicy);
      badge.classList.toggle('ok', policy === bootPolicy);
    }

    // 适配器这一行只报事实：Chromium 说它用的是哪张卡、我们取不到就说取不到
    const adapterLine = byId('gpu-adapter-line');
    if (adapterLine) {
      const gpu = data.gpu;
      if (gpu && gpu.ok) {
        adapterLine.textContent = `当前适配器：${gpu.activeName}${gpu.deviceCount > 1 ? `（共 ${gpu.deviceCount} 张）` : ''}`;
      } else if (gpu && gpu.note) {
        adapterLine.textContent = `当前适配器：未知（${gpu.note}）`;
      } else {
        adapterLine.textContent = '当前适配器：未知（还没有取到显卡信息）';
      }
    }

    const hint = byId('gpu-policy-hint');
    if (hint) {
      const restart = policy !== bootPolicy;
      hint.textContent = restart
        ? `已选「${(option && option.label) || policy}」，但本次启动仍按「${(bootOption && bootOption.label) || bootPolicy}」运行——显卡选择发生在启动之前，需要重启才生效。`
        : `本次启动正在按「${(bootOption && bootOption.label) || bootPolicy}」运行。${(option && option.hint) || ''}`;
      hint.classList.toggle('is-warn', restart);
      hint.classList.toggle('is-ok', !restart);
    }

    const restartBtn = byId('btn-gpu-restart');
    if (restartBtn) restartBtn.hidden = policy === bootPolicy;
    const restartHint = byId('gpu-restart-hint');
    if (restartHint) restartHint.textContent = policy === bootPolicy ? '' : '重启会重新打开当前标签。';
  }

  /** 读取并渲染图形性能策略；失败要说原因，不能停在「读取中…」 */
  async function loadGpuPolicy() {
    if (!window.nyx.gpuPolicy) return;

    try {
      renderGpuPolicy(await window.nyx.gpuPolicy());
    } catch (err) {
      const hint = byId('gpu-policy-hint');
      if (hint) {
        hint.textContent = `读取图形性能策略失败：${err.message}`;
        hint.classList.add('is-warn');
      }
    }

    if (!gpuPolicyWired) wireGpuPolicy();
  }

  function wireGpuPolicy() {
    const row = byId('gpu-policy-row');
    const restartBtn = byId('btn-gpu-restart');
    if (!row) return;

    gpuPolicyWired = true;

    const apply = async (policy) => {
      const hint = byId('gpu-policy-hint');
      if (hint) {
        hint.textContent = '正在保存…';
        hint.classList.remove('is-warn', 'is-ok');
      }

      let res = null;
      try {
        res = await window.nyx.gpuPolicySet({ policy });
      } catch (err) {
        res = { ok: false, error: err.message };
      }

      if (!res || res.ok === false) {
        if (hint) {
          hint.textContent = `没有保存：${(res && res.error) || '未知原因'}`;
          hint.classList.add('is-warn');
        }
        await loadGpuPolicy();
        return;
      }

      setStatus(res.restartRequired ? '图形性能已保存，重启后生效' : '图形性能已保存');
      await loadGpuPolicy();
    };

    row.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.name !== 'gpu-policy' || !input.checked) return;
      apply(input.value);
    });

    if (restartBtn) {
      restartBtn.addEventListener('click', async () => {
        setStatus('正在重启…');
        try {
          await window.nyx.restartApp();
        } catch (err) {
          setStatus(`重启失败：${err.message}`);
        }
      });
    }
  }

  /* ================= 标签休眠（清单 G 的后续） ================= */

  let tabSleepWired = false;
  let tabSleepState = null;

  function renderTabSleep(payload) {
    tabSleepState = payload || {};
    const badge = byId('tab-sleep-badge');
    const row = byId('tab-sleep-row');
    const hint = byId('tab-sleep-hint');
    const statusEl = byId('tab-sleep-status');
    const custom = byId('tab-sleep-custom');
    if (!badge || !row || !hint) return;

    const minutes = Number(tabSleepState.minutes);
    const off = minutes === 0;
    badge.textContent = off ? '已关闭' : `${minutes} 分钟`;
    badge.className = `badge ${off ? 'warn' : 'ok'}`;

    // 候选按钮按 payload 给的候选来渲染，选中项与真实值一致（自定义值不选中任何一项）
    const options = Array.isArray(tabSleepState.options) ? tabSleepState.options : [];
    row.textContent = '';
    for (const value of options) {
      const label = document.createElement('label');
      label.className = 'radio-item';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'tab-sleep';
      input.value = String(value);
      input.checked = value === minutes;
      const span = document.createElement('span');
      const strong = document.createElement('strong');
      strong.textContent = value === 0 ? '不自动休眠' : `${value} 分钟`;
      span.appendChild(strong);
      label.appendChild(input);
      label.appendChild(span);
      row.appendChild(label);
    }

    hint.textContent = tabSleepState.envOverride
      ? `本次启动被环境变量覆盖（${tabSleepState.envMs} ms）：${tabSleepState.envNote}`
      : tabSleepState.hint || '';
    hint.classList.toggle('is-warn', Boolean(tabSleepState.envOverride));

    if (custom) {
      custom.value = minutes > 0 ? String(minutes) : '';
      custom.placeholder = off ? '被关掉了' : '分钟';
    }
    if (statusEl) statusEl.textContent = '';
  }

  async function loadTabSleep() {
    if (!window.nyx.tabSleep) return;

    try {
      renderTabSleep(await window.nyx.tabSleep());
    } catch (err) {
      const hint = byId('tab-sleep-hint');
      if (hint) {
        hint.textContent = `读取标签休眠设置失败：${err.message}`;
        hint.classList.add('is-warn');
      }
    }

    if (!tabSleepWired) wireTabSleep();
  }

  function wireTabSleep() {
    const row = byId('tab-sleep-row');
    const saveBtn = byId('btn-tab-sleep-save');
    const custom = byId('tab-sleep-custom');
    if (!row) return;

    tabSleepWired = true;

    const apply = async (minutes) => {
      const statusEl = byId('tab-sleep-status');
      if (statusEl) statusEl.textContent = '正在保存…';

      let res = null;
      try {
        res = await window.nyx.tabSleepSet({ minutes });
      } catch (err) {
        res = { ok: false, error: err.message };
      }

      if (!res || res.ok === false) {
        if (statusEl) statusEl.textContent = `没有保存：${(res && res.error) || '未知原因'}`;
        await loadTabSleep();
        return;
      }

      setStatus(minutes === 0 ? '标签休眠已关闭（后台标签会一直留在内存里）' : `标签休眠已保存：闲置 ${minutes} 分钟后释放内存`);
      await loadTabSleep();
      if (statusEl) statusEl.textContent = '';
    };

    row.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.name !== 'tab-sleep' || !input.checked) return;
      apply(Number(input.value));
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const raw = custom ? String(custom.value || '').trim() : '';
        const minutes = Number(raw);
        if (!raw || !Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
          const statusEl = byId('tab-sleep-status');
          if (statusEl) statusEl.textContent = '请输入 1–240 之间的分钟数（0 请用上面的「不自动休眠」）。';
          return;
        }
        apply(minutes);
      });
    }
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
      renderPermissionWhitelist(decisions);
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

  byId('btn-perm-whitelist-clear').addEventListener('click', async () => {
    if (!window.confirm('清空站点设备授权白名单？\n\n摄像头、麦克风等设备下次会重新询问；本会话按站点记住的授权也会一并清空。')) return;
    const res = await window.nyx.clearPermissionWhitelist();
    if (!res || !res.ok) {
      setStatus(`清空白名单失败：${(res && res.error) || '未知原因'}`, true);
      return;
    }
    setStatus('已清空站点设备授权白名单');
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

  // 安全基线（C2）：把「声明的运行时版本」与「机器上真正跑的版本」摆在一起
let securityBaselineWired = false;

function wireSecurityBaseline() {
  if (securityBaselineWired) return;
  securityBaselineWired = true;

  for (const btn of document.querySelectorAll('[data-advisory]')) {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.advisory;
      if (typeof window.nyx.openSecurityAdvisory !== 'function') {
        setStatus('当前内核不支持打开安全公告', true);
        return;
      }
      const res = await window.nyx.openSecurityAdvisory({ key }).catch((err) => ({
        ok: false,
        error: err && err.message ? err.message : String(err),
      }));
      if (!res || res.ok === false) {
        setStatus(`没能打开公告页：${(res && res.error) || '未知原因'}`, true);
      } else {
        setStatus('已在系统浏览器打开安全公告');
      }
    });
  }
}

async function loadSecurityBaseline() {
  wireSecurityBaseline();

  const grid = byId('security-baseline-grid');
  const badge = byId('security-baseline-badge');
  const summary = byId('security-baseline-summary');
  if (!grid) return;

  if (typeof window.nyx.securityBaseline !== 'function') {
    if (badge) badge.textContent = '不支持';
    grid.textContent = '';
    if (summary) summary.textContent = '当前内核不支持读取安全基线。';
    return;
  }

  const res = await window.nyx.securityBaseline().catch((err) => ({
    ok: false,
    error: err && err.message ? err.message : String(err),
  }));

  if (!res || (res.ok === false && !Array.isArray(res.items))) {
    if (badge) {
      badge.textContent = '读取失败';
      badge.className = 'badge bad';
    }
    grid.textContent = '';
    if (summary) {
      summary.textContent = `读取安全基线失败：${(res && res.error) || '未知原因'}`;
      summary.className = 'hint is-warn';
    }
    return;
  }

  const items = Array.isArray(res.items) ? res.items : [];
  renderKvGrid(
    grid,
    items.map((item) => [
      item.label,
      item.match ? `${item.actual}（与声明一致）` : `${item.actual || '未知'}（声明 ${item.declared || '—'}）`,
    ]),
  );

  if (badge) {
    badge.textContent = res.ok ? '一致' : '有差异';
    badge.className = res.ok ? 'badge ok' : 'badge bad';
  }
  if (summary) {
    summary.textContent = res.summary || (res.ok ? '运行时与安全基线一致' : '运行时与安全基线不一致');
    summary.className = res.ok ? 'hint' : 'hint is-warn';
  }
}

/**
 * 安装包签名（第五轮 ②）：把 exe 的签名状态、主体、指纹、证书到期日摆出来。
 * 判级与中文说法全在主进程（src/core/signing-status.js），界面只负责显示，
 * 免得同一套规则在两边各写一遍、哪天改成两套说法。
 */
async function loadSigningStatus(force) {
  const grid = byId('signing-grid');
  const badge = byId('signing-badge');
  const summary = byId('signing-summary');
  const btn = byId('btn-signing-recheck');
  if (!grid) return;

  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      loadSigningStatus(true).finally(() => {
        btn.disabled = false;
      });
    });
  }

  if (typeof window.nyx.signingStatus !== 'function') {
    if (badge) badge.textContent = '不支持';
    grid.textContent = '';
    if (summary) summary.textContent = '当前内核不支持读取签名状态。';
    return;
  }

  const res = await window.nyx.signingStatus({ force: Boolean(force) }).catch((err) => ({
    ok: false,
    error: err && err.message ? err.message : String(err),
  }));

  // 这里的语义：`ok:false` 有两种情况——"读不出来"（level=unknown）
  // 和"读出来了，但没签名/签名过期"（level=unsigned/expired）。后者是个确定的答案，
  // 不能当成读取失败，否则界面会对着一个未签名的包说"读不出签名"。
  const level = res && typeof res.level === 'string' ? res.level : '';
  if (!res || level === '' || level === 'unknown') {
    if (badge) {
      badge.textContent = '读不出';
      badge.className = 'badge bad';
    }
    renderKvGrid(grid, [['结论', (res && res.label) || '读不出签名']]);
    if (summary) {
      summary.textContent = (res && res.error) || '读不出这个可执行文件的签名。';
      summary.className = 'hint is-warn';
    }
    return;
  }

  const facts = Array.isArray(res.facts) ? res.facts : [];
  renderKvGrid(grid, [
    ...facts.map((item) => [item.label, item.value]),
    ['文件', res.executable || '—'],
    ['运行形态', res.packaged ? '安装版' : '开发运行（不是安装包）'],
  ]);

  if (badge) {
    const good = res.level === 'valid';
    const warn = res.level === 'expiring';
    badge.textContent = res.label || '未知';
    badge.className = `badge ${good ? 'ok' : warn ? 'warn' : 'bad'}`;
  }
  if (summary) {
    summary.textContent = res.message || '';
    const bad = res.level !== 'valid' && res.level !== 'expiring';
    summary.className = bad ? 'hint is-warn' : 'hint';
  }
}

/**
 * 夜间安装器 e2e 的最近一次结果（第八轮 ③）。
 * 只读：跑一次要管理员权限、十几分钟，还会动真实安装目录，所以界面不提供"现在就跑"。
 */
async function loadNightlyStatus() {
  const grid = byId('nightly-grid');
  const badge = byId('nightly-badge');
  const summary = byId('nightly-summary');
  const btn = byId('btn-nightly-refresh');
  if (!grid) return;

  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      loadNightlyStatus().finally(() => {
        btn.disabled = false;
      });
    });
  }

  if (typeof window.nyx.nightlyStatus !== 'function') {
    if (badge) {
      badge.textContent = '不支持';
      badge.className = 'badge';
    }
    grid.textContent = '';
    if (summary) {
      summary.textContent = '当前内核不支持读取夜间 e2e 结果。';
      summary.className = 'hint';
    }
    return;
  }

  const res = await window.nyx.nightlyStatus().catch((err) => ({
    ok: false,
    level: 'unknown',
    label: '读不出',
    text: `读取失败：${err && err.message ? err.message : String(err)}`,
    rows: [],
  }));

  const level = res && typeof res.level === 'string' ? res.level : 'unknown';
  const rows = Array.isArray(res && res.rows) ? res.rows : [];
  if (rows.length) {
    renderKvGrid(grid, rows.map((item) => [item.label, item.value]));
  } else {
    grid.textContent = '';
  }
  if (badge) {
    badge.textContent = (res && res.label) || '未知';
    badge.className = `badge ${level === 'pass' ? 'ok' : level === 'never' || level === 'stale' ? 'warn' : 'bad'}`;
  }
  if (summary) {
    summary.textContent = (res && res.text) || '';
    summary.className = level === 'pass' ? 'hint' : 'hint is-warn';
  }

  // 计划任务那一段（第九轮 ②）：读状态、改时间、删任务。跑一次 e2e 仍然不给按钮。
  const taskStatus = byId('nightly-task-status');
  if (typeof window.nyx.nightlyTask === 'function') {
    const task = await window.nyx.nightlyTask().catch((err) => ({
      ok: false,
      schedulable: false,
      text: `读取计划任务失败：${err && err.message ? err.message : String(err)}`,
    }));
    renderNightlyTask(task);
  } else if (taskStatus) {
    taskStatus.textContent = '当前内核不支持管理计划任务。';
    taskStatus.className = 'hint';
  }
  wireNightlyTask();
}

/** 把计划任务的现状画出来：能不能管（安装版不能）、有没有注册、下次什么时候跑 */
function renderNightlyTask(task) {
  const statusLine = byId('nightly-task-status');
  const timeInput = byId('nightly-time');
  const registerBtn = byId('btn-nightly-register');
  const removeBtn = byId('btn-nightly-remove');
  const schedulable = Boolean(task && task.schedulable);
  if (registerBtn) registerBtn.disabled = !schedulable;
  if (removeBtn) removeBtn.disabled = !schedulable;
  if (timeInput) {
    timeInput.disabled = !schedulable;
    if (task && task.defaultTime && !timeInput.value) timeInput.value = task.defaultTime;
  }
  if (!statusLine) return;
  const parts = [];
  if (task && task.text) parts.push(task.text);
  if (!schedulable && task && task.schedulableError) parts.push(task.schedulableError);
  statusLine.textContent = parts.join(' ') || '读不出计划任务的状态。';
  statusLine.className = schedulable ? 'hint' : 'hint is-warn';
}

/** 两个按钮只绑一次；注册 / 删除之后都以主进程复核过的那句话为准 */
function wireNightlyTask() {
  const registerBtn = byId('btn-nightly-register');
  const removeBtn = byId('btn-nightly-remove');
  const timeInput = byId('nightly-time');
  const statusLine = byId('nightly-task-status');
  const setStatus = (text, ok) => {
    if (!statusLine) return;
    statusLine.textContent = text;
    statusLine.className = ok ? 'hint' : 'hint is-warn';
  };

  if (registerBtn && !registerBtn.dataset.wired) {
    registerBtn.dataset.wired = '1';
    registerBtn.addEventListener('click', async () => {
      if (typeof window.nyx.nightlyTaskSet !== 'function') {
        setStatus('当前内核不支持注册计划任务。', false);
        return;
      }
      const time = (timeInput && timeInput.value.trim()) || '';
      registerBtn.disabled = true;
      setStatus('正在注册…', true);
      const res = await window.nyx
        .nightlyTaskSet({ time, elevated: false })
        .catch((err) => ({ ok: false, text: `注册失败：${err && err.message ? err.message : String(err)}` }));
      registerBtn.disabled = false;
      setStatus((res && res.text) || '注册结果未知。', Boolean(res && res.ok));
      if (res && res.ok && timeInput) timeInput.value = res.time || time;
      await loadNightlyStatus();
    });
  }

  if (removeBtn && !removeBtn.dataset.wired) {
    removeBtn.dataset.wired = '1';
    removeBtn.addEventListener('click', async () => {
      if (typeof window.nyx.nightlyTaskRemove !== 'function') {
        setStatus('当前内核不支持删除计划任务。', false);
        return;
      }
      removeBtn.disabled = true;
      setStatus('正在删除…', true);
      const res = await window.nyx
        .nightlyTaskRemove()
        .catch((err) => ({ ok: false, text: `删除失败：${err && err.message ? err.message : String(err)}` }));
      removeBtn.disabled = false;
      setStatus((res && res.text) || '删除结果未知。', Boolean(res && res.ok));
      await loadNightlyStatus();
    });
  }
}

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
    renderDeltaReport(res.delta || null, res.deltaFreshness || null);
  }

  /**
   * 把「上次量的差分命中率」画进卡片（没量过就说明怎么量，不假装有数字）。
   * `freshness` 由主进程算好一并带回来：判定只在一处，界面不自己再判一遍——
   * 否则"刚量完"和"打开卡片时读到的"会出现两套口径。
   */
  function renderDeltaReport(report, freshness) {
    const grid = byId('delta-grid');
    const text = byId('delta-text');
    if (!grid || !text) return;
    const fresh = freshness || null;
    if (!report) {
      grid.textContent = '';
      text.className = 'hint';
      text.textContent =
        (fresh && fresh.text) ||
        '差分命中率还没量过：点下面的「重新量一次」，用留档里的上一版和更新源里的当前版本量一遍。';
      return;
    }
    if (report.ok === false) {
      grid.textContent = '';
      text.className = 'hint is-warn';
      text.textContent = (fresh && fresh.text) || `上次没量成：${report.error || '未知原因'}`;
      return;
    }
    renderKvGrid(grid, [
      ['命中率', report.hitRateText || '—'],
      ['块大小 / 块数', `${formatBytes(report.blockSize)} · ${report.blocks} 块`],
      ['基线 → 目标', `${(report.base && report.base.version) || '？'} → ${(report.target && report.target.version) || '？'}`],
    ]);
    // 过期的数字比没有数字更容易误导：这时候整段标成提醒色，而不是继续用"能走差分"的绿
    const stale = Boolean(fresh && fresh.needsRemeasure);
    text.className = stale ? 'hint is-warn' : report.level === 'diff' ? 'hint is-ok' : 'hint';
    text.textContent = report.text || '';
    if (report.at) {
      text.textContent += `（${new Date(report.at).toLocaleString('zh-CN')} 实测）`;
    }
    if (fresh && fresh.text) text.textContent += `\n${fresh.text}`;
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

  const deltaCheck = byId('btn-delta-check');
  if (deltaCheck && !deltaCheck.dataset.wired) {
    deltaCheck.dataset.wired = '1';
    deltaCheck.addEventListener('click', async () => {
      if (typeof window.nyx.updateDeltaCheck !== 'function') {
        setStatus('当前内核不支持实测差分命中率', true);
        return;
      }
      const hint = byId('delta-text');
      deltaCheck.disabled = true;
      if (hint) {
        hint.className = 'hint';
        hint.textContent = '正在量：要把两个安装包各切一遍块，可能要十几秒，别关窗口。';
      }
      try {
        const res = await window.nyx.updateDeltaCheck({}).catch(() => null);
        if (!res) {
          if (hint) {
            hint.className = 'hint is-warn';
            hint.textContent = '实测失败：主进程没有响应。';
          }
          setStatus('实测差分命中率失败', true);
          return;
        }
        renderDeltaReport(res, res.freshness || null);
        setStatus(res.ok === false ? '实测差分失败，原因见卡片' : '差分命中率已更新', res.ok === false);
      } finally {
        deltaCheck.disabled = false;
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

  /**
   * 带超时的初始化步骤（清单 D3 顺手修）：失败或超时都只记一条警告，
   * 绝不让"一件小事没回来"变成"整页功能静默消失"。
   */
  async function settleInit(label, timeoutMs, fn) {
    let timer = null;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            console.warn(`[Nyx] ${label}在 ${timeoutMs}ms 内没有返回，先跳过它继续初始化。`);
            resolve();
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      console.warn(`[Nyx] ${label}加载失败，继续初始化：`, err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 卡片该住哪一页。
   * 历史原因（v1.12～1.17.10 几次插入新分区）：「外观」那 5 张卡片掉到了面板外面，
   * 于是它们对任何分区都永远可见；「隐私与安全」的 4 张卡片也落在滚动区之外。
   * 标记结构的问题要改标记（已记在台账），但在那之前界面不能是坏的——
   * 这里按卡片标题把住错页的卡片搬回去，只搬这 9 张，别的卡片一概不碰。
   */
  const CARD_HOME = {
    地址栏置顶: 'appearance',
    抓包慢请求阈值: 'appearance',
    图形性能: 'appearance',
    硬件加速: 'appearance',
    标签休眠: 'appearance',
    离线阅读缓存: 'privacy',
    加固状态: 'privacy',
    站点授权决策轨迹: 'privacy',
    密码与表单记忆: 'privacy',
  };

  /**
   * 把卡片搬回它该在的那一页（放进该页的 .sec-scroll 里）。
   * 只处理 CARD_HOME 里点名的标题，返回搬动张数。
   */
  function normalizeCards() {
    let moved = 0;
    const cards = Array.from(document.querySelectorAll('.info-card'));
    for (const card of cards) {
      const title = (card.querySelector('.info-title, h3, h2')?.textContent || '').trim();
      const home = Object.keys(CARD_HOME).find((key) => title.includes(key));
      if (!home) continue;
      const host = document.querySelector(`.sec-panel[data-sec="${CARD_HOME[home]}"] .sec-scroll`);
      if (!host || card.parentElement === host) continue;
      host.appendChild(card);
      moved += 1;
    }
    return moved;
  }

  /**
   * 把跑丢的分区面板收回内容区（真 bug 兜底）：
   * 只要有一个 `.sec-panel` 不在 `main.settings-main` 里，它就是 `body` 的直接子节点，
   * 于是"点结构图上的节点，右侧不动"——面板在自己的位置上显示，而不是在内容区里换。
   * 这里按文档顺序统一搬进来，一处修好所有分区；顺序不变，事件绑定不受影响。
   */
  function normalizePanels() {
    const main = document.querySelector('.settings-main');
    if (!main) return 0;
    const all = Array.from(document.querySelectorAll('.sec-panel'));
    let moved = 0;
    for (const panel of all) {
      if (panel.parentElement !== main) {
        main.appendChild(panel);
        moved += 1;
      }
    }
    moved += normalizeCards();
    return moved;
  }

  async function init() {
    bindScrollMemory();
    // 折叠只依赖界面偏好，所以先把偏好等到手、立刻增强卡片，再让另外两件慢慢来。
    // （硬件探测在部分驱动/远程会话下会挂住；把它排在折叠前面就等于"一颗钉子钉住整页"。）
    await settleInit('界面偏好', 8000, loadUiPrefs);
    const moved = normalizePanels();
    if (moved) console.warn(`[Nyx] 有 ${moved} 个分区面板不在内容区里，已收回去。`);
    setupCardFolding();
    // 结构图：入口先画出来，用户一进来就能点（不依赖任何网络/硬件信息）
    setupMindmap();
    // 这两件不影响折叠，失败也只是少了版本号/硬件信息，放在后台各自跑
    settleInit('应用信息', 8000, loadAppInfo);
    settleInit('硬件信息', 8000, loadHardware);
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

  /* ---------------- agent 审计面与急停（清单 D） ---------------- */

  let agentWired = false;

  /** 从筛选控件收集条件；空值不传，免得后端把空串当成真的过滤条件 */
  function collectAgentFilters() {
    const out = { limit: 200 };
    const type = byId('agent-filter-type');
    const decision = byId('agent-filter-decision');
    const site = byId('agent-filter-site');
    const keyword = byId('agent-filter-keyword');
    const failed = byId('agent-filter-failed');
    if (type && type.value) out.type = type.value;
    if (decision && decision.value) out.decision = decision.value;
    if (site && site.value.trim()) out.site = site.value.trim();
    if (keyword && keyword.value.trim()) out.keyword = keyword.value.trim();
    if (failed && failed.checked) out.ok = false;
    return out;
  }

  function buildAgentRow(row) {
    const el = document.createElement('div');
    el.className = 'agent-row';
    if (row.ok === false) el.classList.add('is-failed');
    el.dataset.auditId = row.id || '';

    const time = document.createElement('span');
    time.className = 'agent-time';
    time.textContent = row.time || '—';
    el.appendChild(time);

    const type = document.createElement('span');
    type.className = 'agent-type';
    type.textContent = row.typeLabel || row.type || '—';
    el.appendChild(type);

    const decision = document.createElement('span');
    decision.className = `agent-decision is-${row.decision || 'allow'}`;
    decision.textContent = row.decisionLabel || row.decision || '—';
    el.appendChild(decision);

    const result = document.createElement('span');
    result.className = 'agent-result';
    const where = row.site ? `${row.site} · ` : '';
    const target = row.target ? ` → ${row.target}` : '';
    result.textContent = row.ok === false ? `${where}${row.error || '失败'}${target}` : `${where}成功${target}`;
    result.title = result.textContent;
    el.appendChild(result);

    const ms = document.createElement('span');
    ms.className = 'agent-ms';
    ms.textContent = row.elapsedMs ? `${row.elapsedMs} ms` : '—';
    el.appendChild(ms);

    const params = document.createElement('div');
    params.className = 'agent-params';
    const parts = [`阶段 ${row.stageLabel || row.stage || '—'}`];
    if (row.paramsText) parts.push(row.paramsText);
    if (row.code) parts.push(`码 ${row.code}`);
    if (row.rule) parts.push(`规则 ${row.rule}`);
    params.textContent = parts.join(' · ');
    el.appendChild(params);

    return el;
  }

  async function loadAgentStatus() {
    if (!window.nyx.agentStatus) return;
    try {
      const status = await window.nyx.agentStatus();
      const badge = byId('agent-badge');
      const hint = byId('agent-stop-status');
      const stopBtn = byId('btn-agent-stop');
      const resumeBtn = byId('btn-agent-resume');
      const stopped = Boolean(status && status.stopped);
      if (badge) {
        badge.textContent = stopped ? '已停止' : '运行中';
        badge.className = `badge ${stopped ? 'bad' : 'ok'}`;
      }
      if (hint) {
        const shortcut = (status && status.stopShortcut) || '';
        hint.textContent = stopped
          ? `已停止：${(status && status.stopReason) || '手动停止'}。恢复后动作会照常走权限判定与人工确认。`
          : `当前没有停止。全局热键 ${shortcut}，也可以点上面的按钮。`;
        hint.className = stopped ? 'hint is-warn' : 'hint';
      }
      if (stopBtn) stopBtn.disabled = stopped;
      if (resumeBtn) resumeBtn.disabled = !stopped;
    } catch (err) {
      const hint = byId('agent-stop-status');
      if (hint) {
        hint.textContent = `读取急停状态失败：${err && err.message ? err.message : err}`;
        hint.className = 'hint is-warn';
      }
    }
  }

  async function loadAgentAudit() {
    const list = byId('agent-audit-list');
    const empty = byId('agent-audit-empty');
    const count = byId('agent-audit-count');
    const status = byId('agent-audit-status');
    if (!window.nyx.agentAudit) {
      if (status) status.textContent = '当前内核不支持读取 agent 审计记录。';
      return;
    }
    if (status) {
      status.textContent = '正在读取…';
      status.className = 'hint';
    }
    try {
      const res = await window.nyx.agentAudit(collectAgentFilters());
      if (!res || res.ok === false) {
        if (status) {
          status.textContent = `读取失败：${(res && res.error) || '未知原因'}`;
          status.className = 'hint is-warn';
        }
        return;
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      if (list) {
        list.textContent = '';
        for (const row of rows) list.appendChild(buildAgentRow(row));
      }
      if (empty) empty.hidden = rows.length > 0;
      if (count) {
        const stats = res.stats || {};
        count.textContent = `${rows.length} 条 / 共 ${stats.total || rows.length}`;
        count.className = `badge${stats.failed ? ' bad' : ''}`;
      }
      if (status) {
        const stats = res.stats || {};
        status.textContent =
          `内存里保留 ${stats.kept || rows.length} 条，累计 ${stats.total || rows.length} 条` +
          `，敏感 ${stats.sensitive || 0} 条，失败 ${stats.failed || 0} 条` +
          `${stats.diskFailures ? `；落盘失败 ${stats.diskFailures} 次` : ''}` +
          `。文件：${stats.filePath || '—'}`;
        status.className = stats.diskFailures || stats.memoryFailures ? 'hint is-warn' : 'hint';
      }
    } catch (err) {
      if (status) {
        status.textContent = `读取失败：${err && err.message ? err.message : err}`;
        status.className = 'hint is-warn';
      }
    }
  }

  async function exportAgentAudit(format) {
    const status = byId('agent-audit-status');
    if (!window.nyx.agentAuditExport) return;
    try {
      const res = await window.nyx.agentAuditExport({ format, filters: collectAgentFilters() });
      if (!res || res.ok === false) {
        if (status) {
          status.textContent = `没有导出：${(res && res.error) || '未知原因'}`;
          status.className = 'hint is-warn';
        }
        return;
      }
      if (status) {
        status.textContent = `已导出 ${res.count} 条到 ${res.path}（${formatBytes(res.bytes)}）`;
        status.className = 'hint';
      }
    } catch (err) {
      if (status) {
        status.textContent = `导出失败：${err && err.message ? err.message : err}`;
        status.className = 'hint is-warn';
      }
    }
  }

  function wireAgentSection() {
    if (agentWired) return;
    agentWired = true;
    const stopBtn = byId('btn-agent-stop');
    const resumeBtn = byId('btn-agent-resume');
    const refresh = byId('btn-agent-refresh');
    const csv = byId('btn-agent-export-csv');
    const json = byId('btn-agent-export-json');
    const clear = byId('btn-agent-clear');
    const status = byId('agent-audit-status');

    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true;
        const res = await window.nyx.agentStop('设置页按钮紧急停止');
        if (res && res.ok === false && status) {
          status.textContent = `没有停止：${res.error || '未知原因'}`;
          status.className = 'hint is-warn';
        }
        await loadAgentStatus();
        await loadAgentAudit();
      });
    }
    if (resumeBtn) {
      resumeBtn.addEventListener('click', async () => {
        resumeBtn.disabled = true;
        await window.nyx.agentResume();
        await loadAgentStatus();
      });
    }
    if (refresh) {
      refresh.addEventListener('click', () => {
        loadAgentAudit();
      });
    }
    if (csv) csv.addEventListener('click', () => exportAgentAudit('csv'));
    if (json) json.addEventListener('click', () => exportAgentAudit('json'));
    if (clear) {
      clear.addEventListener('click', async () => {
        const res = await window.nyx.agentAuditClear();
        if (status) {
          status.textContent = res && res.ok === false
            ? `没有清空：${res.error || '未知原因'}`
            : `已清空内存里的 ${(res && res.cleared) || 0} 条记录（磁盘上的 jsonl 不动）`;
          status.className = res && res.ok === false ? 'hint is-warn' : 'hint';
        }
        await loadAgentAudit();
      });
    }
    // 筛选条件一变就重查：不做"应用"按钮，少一步操作
    for (const id of ['agent-filter-type', 'agent-filter-decision']) {
      const el = byId(id);
      if (el) el.addEventListener('change', () => loadAgentAudit());
    }
    for (const id of ['agent-filter-site', 'agent-filter-keyword']) {
      const el = byId(id);
      if (el) {
        el.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') loadAgentAudit();
        });
      }
    }
    const failed = byId('agent-filter-failed');
    if (failed) failed.addEventListener('change', () => loadAgentAudit());
  }

  // ---------------------------------------------------------------- 站点三层授权（清单 E）

  let agentSitesWired = false;
  let agentSitesState = null;

  function renderSiteList(listId, emptyId, countId, rules, conflicts) {
    const list = byId(listId);
    const empty = byId(emptyId);
    const count = byId(countId);
    if (count) count.textContent = String(rules.length);
    if (!list) return;
    list.textContent = '';
    for (const rule of rules) {
      const li = document.createElement('li');
      const host = document.createElement('span');
      host.className = 'site-host';
      host.textContent = rule.target;
      li.appendChild(host);
      if (rule.mode === 'prefix') {
        // 前缀规则和域名规则长得像但管得窄，必须在行上标出来，否则用户会以为整站都放行了
        const tag = document.createElement('span');
        tag.className = 'site-mode';
        tag.textContent = '前缀';
        li.appendChild(tag);
      }
      if (conflicts.includes(rule.target)) {
        const conflict = document.createElement('span');
        conflict.className = 'site-conflict';
        conflict.textContent = '同时在两张名单里：屏蔽优先';
        li.appendChild(conflict);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'site-remove';
      remove.textContent = '删除';
      remove.dataset.target = rule.target;
      remove.dataset.mode = rule.mode || 'host';
      remove.setAttribute('aria-label', `从这张名单里删除 ${rule.target}`);
      li.appendChild(remove);
      list.appendChild(li);
    }
    if (empty) empty.hidden = rules.length > 0;
  }

  function renderAgentSites(payload) {
    agentSitesState = payload || null;
    if (!payload || payload.ok === false) {
      const badge = byId('agent-sites-badge');
      if (badge) {
        badge.textContent = '读不到';
        badge.className = 'badge bad';
      }
      const status = byId('agent-sites-status');
      if (status) {
        status.textContent = (payload && payload.error) || '站点名单读取失败。';
        status.className = 'hint is-warn';
      }
      return;
    }
    const policy = payload.policy || { globalEnabled: true, allow: [], block: [] };
    const global = byId('agent-sites-global');
    if (global) global.checked = policy.globalEnabled !== false;

    const badge = byId('agent-sites-badge');
    if (badge) {
      badge.textContent = policy.globalEnabled === false ? '已关闭' : '已开启';
      badge.className = policy.globalEnabled === false ? 'badge warn' : 'badge ok';
    }

    const conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
    renderSiteList('agent-allow-list', 'agent-allow-empty', 'agent-allow-count', policy.allow || [], conflicts);
    renderSiteList('agent-block-list', 'agent-block-empty', 'agent-block-count', policy.block || [], conflicts);

    const sessionCount = byId('agent-session-count');
    const trusted = Array.isArray(payload.sessionTrusted) ? payload.sessionTrusted : [];
    if (sessionCount) {
      sessionCount.textContent = trusted.length
        ? `本次会话信任 ${trusted.length} 个站点：${trusted.join('、')}`
        : '本次会话信任 0 个站点';
    }

    const current = byId('agent-sites-current');
    if (current && payload.current) {
      const map = { allow: '放行', deny: '拒绝', ask: '进站时问你一次' };
      current.textContent = payload.current.site
        ? `当前站点 ${payload.current.site}：${map[payload.current.decision] || payload.current.decision}（${payload.current.layer}）`
        : '当前标签没有可识别的站点（本地页不受名单限制，但也不会放行）。';
    }
  }

  async function loadAgentSites() {
    if (!window.nyx.agentSites) return;
    try {
      const payload = await window.nyx.agentSites({});
      renderAgentSites(payload);
    } catch (err) {
      renderAgentSites({ ok: false, error: `读取站点名单失败：${err && err.message ? err.message : err}` });
    }
  }

  async function setAgentSites(patch, okText) {
    if (!window.nyx.agentSitesSet) return { ok: false, error: '当前内核不支持改站点名单。' };
    const status = byId('agent-sites-status');
    try {
      const payload = await window.nyx.agentSitesSet(patch || {});
      if (payload && payload.ok === false) {
        renderAgentSites({ ...(agentSitesState || {}), ok: true, ...payload, error: '' });
        if (status) {
          status.textContent = `没改成：${payload.error || '未知原因'}`;
          status.className = 'hint is-warn';
        }
        return payload;
      }
      renderAgentSites(payload);
      if (status) {
        status.textContent = okText || '已保存';
        status.className = 'hint is-ok';
      }
      return payload;
    } catch (err) {
      if (status) {
        status.textContent = `没保存成功：${err && err.message ? err.message : err}`;
        status.className = 'hint is-warn';
      }
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function wireAgentSites() {
    if (agentSitesWired) return;
    agentSitesWired = true;

    const global = byId('agent-sites-global');
    if (global) {
      global.addEventListener('change', () => {
        const on = global.checked;
        setAgentSites(
          { globalEnabled: on },
          on ? '已开启 agent 访问：未命中名单的站点会逐站问你一次' : '已关闭 agent 访问：agent 现在什么也做不了',
        );
      });
    }

    const addAllow = byId('btn-agent-allow-add');
    const allowInput = byId('agent-allow-input');
    const allowMode = byId('agent-allow-mode');
    // 名单导入导出（候选④）：导出给人备份，导入默认并入、不删已有条目
    const exportBtn = byId('btn-agent-sites-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        const status = byId('agent-sites-status');
        exportBtn.disabled = true;
        try {
          const res = await window.nyx.agentSitesExport();
          if (res && res.ok !== false && res.exported) {
            if (status) {
              status.textContent = `已导出到 ${res.exported.path}（白名单 ${res.exported.allow} 条 / 屏蔽 ${res.exported.block} 条）`;
              status.className = 'hint is-ok';
            }
          } else if (status) {
            status.textContent = (res && res.error) || '没能导出名单';
            status.className = res && res.canceled ? 'hint' : 'hint is-warn';
          }
        } catch (err) {
          if (status) {
            status.textContent = `没能导出名单：${err && err.message ? err.message : '未知原因'}`;
            status.className = 'hint is-warn';
          }
        } finally {
          exportBtn.disabled = false;
        }
      });
    }

    const importBtn = byId('btn-agent-sites-import');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        const status = byId('agent-sites-status');
        importBtn.disabled = true;
        try {
          const res = await window.nyx.agentSitesImport({});
          if (res && res.ok !== false && res.imported) {
            renderAgentSites(res);
            if (status) {
              status.textContent = res.imported.rejectedCount
                ? `${res.imported.summary} 跳过的条目：${res.imported.rejected.join('；')}`
                : res.imported.summary;
              status.className = res.imported.rejectedCount ? 'hint is-warn' : 'hint is-ok';
            }
          } else if (status) {
            status.textContent = (res && res.error) || '没能导入名单';
            status.className = res && res.canceled ? 'hint' : 'hint is-warn';
          }
        } catch (err) {
          if (status) {
            status.textContent = `没能导入名单：${err && err.message ? err.message : '未知原因'}`;
            status.className = 'hint is-warn';
          }
        } finally {
          importBtn.disabled = false;
        }
      });
    }

    if (addAllow && allowInput) {
      addAllow.addEventListener('click', () => {
        const value = allowInput.value.trim();
        const mode = allowMode && allowMode.value === 'prefix' ? 'prefix' : 'host';
        if (!value) {
          const status = byId('agent-sites-status');
          if (status) {
            status.textContent = mode === 'prefix' ? '先填一个 URL 前缀，例如 example.com/admin' : '先填一个域名，例如 example.com';
            status.className = 'hint is-warn';
          }
          return;
        }
        setAgentSites({ addAllow: value, mode }, `已把 ${value} 加进白名单`).then((res) => {
          if (res && res.ok === false) return;
          allowInput.value = '';
        });
      });
    }

    const addBlock = byId('btn-agent-block-add');
    const blockInput = byId('agent-block-input');
    const blockMode = byId('agent-block-mode');
    if (addBlock && blockInput) {
      addBlock.addEventListener('click', () => {
        const value = blockInput.value.trim();
        const mode = blockMode && blockMode.value === 'prefix' ? 'prefix' : 'host';
        if (!value) {
          const status = byId('agent-sites-status');
          if (status) {
            status.textContent = mode === 'prefix' ? '先填一个 URL 前缀，例如 example.com/admin' : '先填一个域名，例如 example.com';
            status.className = 'hint is-warn';
          }
          return;
        }
        setAgentSites({ addBlock: value, mode }, `已把 ${value} 加进屏蔽名单`).then((res) => {
          if (res && res.ok === false) return;
          blockInput.value = '';
        });
      });
    }

    for (const id of ['agent-allow-list', 'agent-block-list']) {
      const list = byId(id);
      if (!list) continue;
      list.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('.site-remove') : null;
        if (!button) return;
        const target = button.dataset.target || '';
        const mode = button.dataset.mode || 'host';
        const patch = id === 'agent-allow-list' ? { removeAllow: target, mode } : { removeBlock: target, mode };
        setAgentSites(patch, `已从名单里删掉 ${target}`);
      });
    }

    const clearSession = byId('btn-agent-session-clear');
    if (clearSession) {
      clearSession.addEventListener('click', () => {
        setAgentSites({ clearSession: true }, '已清空本次会话的信任，之后再进这些站点会重新问你');
      });
    }
  }

  // ── 接入模式（清单 A）─────────────────────────────────────────────
  // 两步确认：第一步只把"要切到哪个模式"记在内存里，第二步给风险清单 + 必须勾确认，
  // 而且第二次的提示不允许出现"不再提示"（清单 §3 的不可回退约束）。
  let agentModeWired = false;
  let agentModeState = null;
  let agentModePending = '';

  function renderAgentMode(payload) {
    agentModeState = payload || null;
    const info = payload || {};
    const badge = byId('agent-mode-badge');
    const facts = byId('agent-mode-facts');
    const banner = byId('agent-mode-banner');
    const step2 = byId('agent-mode-step2');
    const risks = byId('agent-mode-risks');
    const ack = byId('agent-mode-ack');
    const cancel = byId('btn-agent-mode-cancel');
    const restart = byId('btn-agent-mode-restart');
    const applyBtn = byId('btn-agent-mode-apply');
    const builtin = byId('agent-mode-builtin');
    const external = byId('agent-mode-external');

    if (badge) {
      const externalOn = info.mode === 'external';
      badge.textContent = info.label || (externalOn ? '外部接入（CDP）' : '内置（推荐）');
      badge.className = externalOn ? 'badge bad' : 'badge ok';
    }
    if (builtin) builtin.checked = info.mode !== 'external';
    if (external) external.checked = info.mode === 'external';

    if (facts) {
      const lines = [info.summary || ''];
      lines.push(
        info.auditComplete === false
          ? '审计完整度：不完整（只看得到经过浏览器的部分）'
          : '审计完整度：完整（每个动作都经过统一通道）',
      );
      if (info.mode === 'external') {
        lines.push(`外部端点：${info.externalEndpoint || '（端口未知）'}`);
      }
      if (info.restartRequired) {
        lines.push(`已记下「${info.label || info.mode}」，但本次启动仍按「${info.bootLabel || info.bootMode}」运行——重启后才生效。`);
      } else {
        lines.push('当前启动就是这个模式，不需要重启。');
      }
      facts.textContent = lines.filter(Boolean).join('　');
    }

    if (banner) {
      const show = info.auditComplete === false;
      banner.hidden = !show;
      banner.textContent = show ? info.banner || '' : '';
    }

    if (step2) step2.hidden = !agentModePending;
    if (agentModePending && risks) {
      risks.textContent = '';
      (info.risks || []).forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        risks.appendChild(li);
      });
    }
    if (ack) ack.checked = false;
    if (cancel) cancel.hidden = !agentModePending;
    if (restart) restart.hidden = info.restartRequired !== true;
    if (applyBtn) applyBtn.textContent = agentModePending ? '确认切换（第二步）' : '切换接入模式';
  }

  async function loadAgentMode() {
    const status = byId('agent-mode-status');
    if (!window.nyx || typeof window.nyx.agentMode !== 'function') {
      if (status) status.textContent = '当前内核不支持读取接入模式。';
      return null;
    }
    try {
      const res = await window.nyx.agentMode();
      renderAgentMode(res);
      if (status) status.textContent = '';
      return res;
    } catch (err) {
      if (status) status.textContent = `读取接入模式失败：${err && err.message ? err.message : err}`;
      return null;
    }
  }

  async function applyAgentMode() {
    const status = byId('agent-mode-status');
    const ack = byId('agent-mode-ack');
    const pending = agentModePending || (agentModeState && agentModeState.mode === 'external' ? 'builtin' : 'external');
    if (!agentModePending) {
      // 第一步：只问一次，把目标模式记下来，等第二步确认
      agentModePending = pending;
      renderAgentMode(agentModeState || {});
      if (status) status.textContent = '再点一次「确认切换」才会真正改，中间必须勾选上面的风险确认。';
      return;
    }
    if (!ack || ack.checked !== true) {
      if (status) status.textContent = '请先勾选「我已了解外部接入会让审计不完整」。';
      return;
    }
    if (!window.nyx || typeof window.nyx.agentModeSet !== 'function') {
      if (status) status.textContent = '当前内核不支持切换接入模式。';
      return;
    }
    const btn = byId('btn-agent-mode-apply');
    if (btn) btn.disabled = true;
    try {
      const res = await window.nyx.agentModeSet({ target: agentModePending, stage: 2, ackRisk: true });
      agentModePending = '';
      renderAgentMode(res);
      if (status) {
        status.textContent = res && res.ok === false
          ? `没有改成：${(res && res.error) || '未知原因'}`
          : `已记下「${(res && res.label) || ''}」，重启 Nyx 之后生效。`;
        status.className = res && res.ok === false ? 'hint is-warn' : 'hint is-ok';
      }
    } catch (err) {
      if (status) status.textContent = `切换失败：${err && err.message ? err.message : err}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function wireAgentMode() {
    if (agentModeWired) return;
    agentModeWired = true;
    const applyBtn = byId('btn-agent-mode-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => applyAgentMode());
    const cancel = byId('btn-agent-mode-cancel');
    if (cancel) {
      cancel.addEventListener('click', () => {
        agentModePending = '';
        renderAgentMode(agentModeState || {});
        const status = byId('agent-mode-status');
        if (status) status.textContent = '已取消，没有改任何设置。';
      });
    }
    const restart = byId('btn-agent-mode-restart');
    if (restart) {
      restart.addEventListener('click', () => {
        if (window.nyx && typeof window.nyx.restartApp === 'function') window.nyx.restartApp();
      });
    }
  }

  /* ---------- 页面摘要（清单 F） ---------- */

  let digestSettingWired = false;

  function renderDigestSetting(payload) {
    const badge = byId('digest-badge');
    const toggle = byId('digest-setting-enabled');
    const status = byId('digest-setting-status');
    const enabled = Boolean(payload && payload.enabled);
    if (badge) {
      badge.textContent = enabled ? '已开启' : '已关闭';
      badge.className = `badge ${enabled ? 'ok' : 'warn'}`;
    }
    if (toggle) toggle.checked = enabled;
    if (status) {
      status.textContent = enabled
        ? '当前允许读取页面。生成摘要时会在右侧栏展示，也可以一键复制。'
        : '当前关闭：不会读取任何页面。需要时在这里或主界面右侧栏里打开。';
      status.className = 'hint';
    }
  }

  async function loadDigestSetting() {
    const status = byId('digest-setting-status');
    if (!window.nyx.digestGet) {
      if (status) {
        status.textContent = '当前内核不支持页面摘要。';
        status.className = 'hint is-warn';
      }
      return;
    }
    try {
      const res = await window.nyx.digestGet();
      renderDigestSetting(res);
    } catch (err) {
      if (status) {
        status.textContent = `读取摘要开关失败：${String(err && err.message ? err.message : err)}`;
        status.className = 'hint is-warn';
      }
    }
  }

  function wireDigestSetting() {
    if (digestSettingWired) return;
    digestSettingWired = true;
    const toggle = byId('digest-setting-enabled');
    if (!toggle) return;
    toggle.addEventListener('change', async () => {
      const enabled = toggle.checked;
      const status = byId('digest-setting-status');
      if (!window.nyx.digestSet) return;
      try {
        const res = await window.nyx.digestSet({ enabled });
        if (!res || res.ok !== true) {
          if (status) {
            status.textContent = res && res.error ? res.error : '开关没能保存';
            status.className = 'hint is-warn';
          }
          toggle.checked = !enabled;
          return;
        }
        renderDigestSetting(res);
      } catch (err) {
        toggle.checked = !enabled;
        if (status) {
          status.textContent = `开关没能保存：${String(err && err.message ? err.message : err)}`;
          status.className = 'hint is-warn';
        }
      }
    });
  }

  function loadAgentSection() {
    wireAgentSection();
    wireAgentSites();
    wireAgentMode();
    wireAgentDoc();
    wireDigestSetting();
    loadAgentStatus();
    loadAgentAudit();
    loadAgentSites();
    loadAgentMode();
    loadAgentDoc();
    loadDigestSetting();
    loadAgentSettings();
  }

  /**
   * 接入说明（清单 D1）。
   *
   * 这里刻意不"预览全文"：说明里含 token 文件位置与当前端口，全文摆在设置页上反而容易被
   * 顺手截屏外传。只显示字符数与模式，复制/保存都在主进程生成，界面只是一层壳。
   */
  let agentDocWired = false;

  function renderAgentDoc(res) {
    const badge = byId('agent-doc-badge');
    const size = byId('agent-doc-size');
    const ok = Boolean(res && res.ok);
    if (badge) {
      badge.textContent = ok ? `${res.mode === 'external' ? '外部接入' : '内置'} · ${res.markdown.length} 字` : '读不到';
      badge.className = `badge ${ok ? (res.auditComplete === false ? 'warn' : 'ok') : 'bad'}`;
    }
    if (size) size.textContent = ok ? `共 ${res.markdown.split('\n').length} 行` : '—';
  }

  async function loadAgentDoc() {
    if (!window.nyx || typeof window.nyx.agentDoc !== 'function') {
      setAgentDocStatus('当前内核不支持生成接入说明。', true);
      return;
    }
    try {
      const res = await window.nyx.agentDoc();
      renderAgentDoc(res);
      if (res && res.ok === false) setAgentDocStatus(res.error || '接入说明没能生成。', true);
    } catch (err) {
      setAgentDocStatus(`读取接入说明失败：${err && err.message ? err.message : err}`, true);
    }
  }

  function setAgentDocStatus(text, bad) {
    const line = byId('agent-doc-status');
    if (!line) return;
    line.className = bad ? 'hint is-warn' : 'hint';
    line.textContent = text;
  }

  function wireAgentDoc() {
    if (agentDocWired) return;
    agentDocWired = true;
    const copy = byId('btn-agent-doc-copy');
    const save = byId('btn-agent-doc-save');
    if (copy) {
      copy.addEventListener('click', async () => {
        copy.disabled = true;
        try {
          const res = await window.nyx.agentDocCopy();
          if (res && res.ok) setAgentDocStatus(`已复制 ${res.chars} 字，直接粘给你的 agent 就行。`);
          else setAgentDocStatus((res && res.error) || '没能复制接入说明。', true);
        } catch (err) {
          setAgentDocStatus(`没能复制接入说明：${err && err.message ? err.message : err}`, true);
        } finally {
          copy.disabled = false;
        }
      });
    }
    if (save) {
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          const res = await window.nyx.agentDocSave();
          if (res && res.ok) setAgentDocStatus(`已保存 ${res.bytes} 字节：${res.path}`);
          else if (res && res.code === 'CANCELED') setAgentDocStatus('已取消保存。');
          else setAgentDocStatus((res && res.error) || '没能保存接入说明。', true);
        } catch (err) {
          setAgentDocStatus(`没能保存接入说明：${err && err.message ? err.message : err}`, true);
        } finally {
          save.disabled = false;
        }
      });
    }
  }

  /**
   * 让 agent 改设置（用户第 6 项）——这里只展示"哪些键能改 / 哪些锁死 / 免责"。
   * 修改入口只有 agent 动作通道（带人工确认与留痕），界面刻意不给旁路。
   */
  async function loadAgentSettings() {
    const badge = byId('agent-settings-badge');
    const keysList = byId('agent-settings-keys');
    const lockedList = byId('agent-settings-locked');
    const disclaimer = byId('agent-settings-disclaimer');
    const status = byId('agent-settings-status');
    if (!window.nyx.agentSettings) {
      if (status) {
        status.textContent = '当前内核不支持由 agent 改设置。';
        status.className = 'hint is-warn';
      }
      return;
    }
    try {
      const payload = await window.nyx.agentSettings();
      if (!payload || payload.ok === false) {
        if (status) {
          status.textContent = `读取可改设置失败：${(payload && payload.error) || '没有返回原因'}`;
          status.className = 'hint is-warn';
        }
        return;
      }
      const keys = Array.isArray(payload.keys) ? payload.keys : [];
      const locked = Array.isArray(payload.locked) ? payload.locked : [];
      if (badge) {
        badge.textContent = `${keys.length} 个键可改`;
        badge.className = 'badge ok';
      }
      if (keysList) {
        keysList.innerHTML = '';
        for (const item of keys) {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'site-host';
          name.textContent = item.key;
          const desc = document.createElement('span');
          desc.textContent = item.needsConfirm ? `　${item.label}（要确认）` : `　${item.label}`;
          li.append(name, desc);
          keysList.append(li);
        }
      }
      if (lockedList) {
        lockedList.innerHTML = '';
        for (const item of locked) {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'site-host';
          name.textContent = item.key;
          const desc = document.createElement('span');
          desc.textContent = `　${item.why}`;
          li.append(name, desc);
          lockedList.append(li);
        }
      }
      if (disclaimer && typeof payload.disclaimer === 'string' && payload.disclaimer) {
        disclaimer.textContent = payload.disclaimer;
      }
      // 场景预设：只列出来，不给界面按钮——套预设仍是 agent 的动作，要过确认与留痕
      const presetList = byId('agent-settings-preset-list');
      if (presetList) {
        presetList.innerHTML = '';
        const presets = Array.isArray(payload.presets) ? payload.presets : [];
        for (const item of presets) {
          const li = document.createElement('li');
          const name = document.createElement('span');
          name.className = 'site-host';
          name.textContent = item.preset;
          const desc = document.createElement('span');
          const parts = (Array.isArray(item.settings) ? item.settings : []).map((one) => one.summary);
          desc.textContent = `　${item.label}：${item.summary}（${parts.join('；')}）`;
          li.append(name, desc);
          presetList.append(li);
        }
        if (!presets.length) {
          const li = document.createElement('li');
          li.textContent = '当前内核没有提供场景预设。';
          presetList.append(li);
        }
      }
      // 撤销：不给界面单独开一条路（那会绕开人工确认与留痕），只如实说现在能撤哪一次、怎么撤
      const undoLine = byId('agent-settings-undo');
      if (undoLine) {
        const undoInfo = payload.undo && typeof payload.undo === 'object' ? payload.undo : {};
        const depth = Number(undoInfo.depth) || 0;
        undoLine.textContent = undoInfo.available
          ? `撤销：可以撤销最近一次对「${undoInfo.key}」的修改（现在能连撤 ${depth} 步，一次最多 ${undoInfo.maxSteps || 5} 步）——${undoInfo.how || '让 agent 发一次带 undo:true 的设置动作'}。`
          : `撤销：${undoInfo.how || '还没有哪个 agent 改过设置，暂时没有可撤销的'}。`;
        undoLine.className = 'hint';
      }
      if (status) {
        status.textContent = `一分钟内最多改 ${(payload.rateLimit && payload.rateLimit.max) || 10} 次；改完会立刻生效。`;
        status.className = 'hint';
      }
      await loadSettingAudit();
      return payload;
    } catch (err) {
      if (status) {
        status.textContent = `读取可改设置失败：${err && err.message ? err.message : err}`;
        status.className = 'hint is-warn';
      }
    }
  }

  /**
   * 「谁改得多」（用户第七轮 C）：按设置项聚合动作留痕。
   * 只读：不提供一个能从界面直接改设置的入口。
   */
  async function loadSettingAudit() {
    const table = byId('agent-settings-audit-table');
    const rows = byId('agent-settings-audit-rows');
    const note = byId('agent-settings-audit-note');
    if (!table || !rows || !note) return;
    if (!window.nyx || typeof window.nyx.agentSettingsAudit !== 'function') {
      table.hidden = true;
      note.textContent = '当前内核不支持查看 agent 改设置的记录。';
      note.className = 'hint is-warn';
      return;
    }
    // 时间范围（第八轮 ④）：界面只传「最近几天」，换算成时间戳是主进程的事
    const range = byId('agent-audit-range');
    const days = range ? Number(range.value) || 0 : 0;
    let payload = null;
    try {
      payload = await window.nyx.agentSettingsAudit({ limit: 20, days });
    } catch (err) {
      table.hidden = true;
      note.textContent = `读不出改动记录：${err && err.message ? err.message : '未知原因'}`;
      note.className = 'hint is-warn';
      return;
    }
    if (!payload || payload.ok === false) {
      table.hidden = true;
      note.textContent = `读不出改动记录：${(payload && payload.error) || '没有返回原因'}`;
      note.className = 'hint is-warn';
      return;
    }
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    rows.textContent = '';
    if (!keys.length) {
      table.hidden = true;
      note.textContent = payload.note || '还没有 agent 改过设置。';
      note.className = 'hint';
      return;
    }
    for (const item of keys) {
      const tr = document.createElement('tr');
      const cells = [
        item.label || item.key,
        `${item.count} 次`,
        item.lastTime ? new Date(item.lastTime).toLocaleString() : '—',
        describeSettingValue(item.lastValue),
        (item.agents || []).join('、') || '—',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      rows.append(tr);
    }
    table.hidden = false;
    note.textContent = payload.note || '';
    note.className = 'hint';
    // 动作聚合（第九轮 ④）：和设置改动同一批记录、同一个时间窗，分开两块显示
    renderActionAudit(payload.actions);
  }

  /**
   * 「它都干过什么」：按动作类型与站点各数一遍。
   * 被拦下/被拒的只报数不进表格——它们不是"做过的事"，混进执行次数里会把风险说小。
   */
  function renderActionAudit(actions) {
    const table = byId('agent-actions-audit-table');
    const rows = byId('agent-actions-audit-rows');
    const note = byId('agent-actions-audit-note');
    const sitesLine = byId('agent-actions-sites');
    if (!table || !rows || !note) return;
    if (!actions || actions.ok === false) {
      table.hidden = true;
      note.textContent = '读不出动作记录。';
      note.className = 'hint is-warn';
      if (sitesLine) sitesLine.textContent = '';
      return;
    }
    const types = Array.isArray(actions.types) ? actions.types : [];
    rows.textContent = '';
    note.textContent = actions.note || '';
    note.className = actions.empty ? 'hint' : 'hint';
    if (!types.length) {
      table.hidden = true;
    } else {
      for (const item of types) {
        const tr = document.createElement('tr');
        const cells = [
          item.label || item.type,
          `${item.count} 次`,
          Number.isFinite(item.lastAt) && item.lastAt > 0 ? new Date(item.lastAt).toLocaleString() : '—',
          (item.sites || []).slice(0, 3).join('、') || '—',
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.append(td);
        }
        rows.append(tr);
      }
      table.hidden = false;
    }
    if (sitesLine) {
      const sites = Array.isArray(actions.sites) ? actions.sites : [];
      sitesLine.textContent = sites.length
        ? `主要在哪些站点：${sites.slice(0, 6).map((item) => `${item.site}（${item.count} 次）`).join('、')}。`
        : '';
    }
  }

  function describeSettingValue(value) {
    if (value === undefined) return '—';
    if (typeof value === 'boolean') return value ? '开' : '关';
    if (value === null) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  /**
   * 「谁改得多」的时间范围与导出（第八轮 ④）。
   * 导出走同步保存框，导出的是聚合后的表格（每个设置项一行），不是原始流水账。
   */
  function wireSettingAuditTools() {
    const range = byId('agent-audit-range');
    if (range && range.dataset.wired !== 'true') {
      range.dataset.wired = 'true';
      range.addEventListener('change', () => {
        loadSettingAudit();
      });
    }
    // 两张表各有一个导出按钮：同样的对话框、同样的时间范围，只有 kind 不同。
    bindAuditExport('btn-agent-audit-export', 'settings', 'agent-settings-audit-note');
    bindAuditExport('btn-agent-actions-export', 'actions', 'agent-actions-audit-note');
  }

  function bindAuditExport(buttonId, kind, noteId) {
    const button = byId(buttonId);
    if (!button || button.dataset.wired === 'true') return;
    button.dataset.wired = 'true';
    const what = kind === 'actions' ? '动作记录' : '改动记录';
    button.addEventListener('click', async () => {
      const note = byId(noteId);
      if (!window.nyx || typeof window.nyx.agentSettingsAuditExport !== 'function') {
        if (note) {
          note.textContent = `当前内核不支持导出${what}。`;
          note.className = 'hint is-warn';
        }
        return;
      }
      const rangeSelect = byId('agent-audit-range');
      const days = rangeSelect ? Number(rangeSelect.value) || 0 : 0;
      button.disabled = true;
      if (note) {
        note.textContent = '正在导出…';
        note.className = 'hint';
      }
      let res = null;
      try {
        res = await window.nyx.agentSettingsAuditExport({ days, kind });
      } catch (err) {
        res = { ok: false, error: err && err.message ? err.message : '未知原因' };
      }
      button.disabled = false;
      if (!note) return;
      if (res && res.ok) {
        note.textContent = `已导出 ${res.rows} 行：${res.path}（${res.bytes} 字节）`;
        note.className = 'hint is-ok';
        return;
      }
      if (res && res.canceled) {
        note.textContent = '已取消导出。';
        note.className = 'hint';
        return;
      }
      note.textContent = `没能导出：${(res && res.error) || '未知原因'}`;
      note.className = 'hint is-warn';
    });
  }

  wireSettingAuditTools();

  // 主界面加载失败页（A4）的「打开诊断」会要求设置窗口直接落到「诊断」分区
  if (window.nyx.onSettingsSection) {
    window.nyx.onSettingsSection((section) => {
      if (!SEC_LABELS[section]) return;
      activate(section);
    });
  }

  init();
})();
