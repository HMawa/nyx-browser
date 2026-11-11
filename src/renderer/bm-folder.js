'use strict';

/**
 * 「收藏到文件夹」浮层的页面逻辑（v1.5.0）。
 *
 * 数据流：
 *   长按 / 右键工具栏星标 → 主进程 openBookmarkFolderMenu 弹出本窗口
 *   → 推送 nyx:bf:data（文件夹树摊平后的列表 + 待收藏页面）
 *   → 本脚本渲染；点某个文件夹 → bmFolder.pick(id) → 主进程收藏并收起浮层。
 *
 * 键盘：↑↓ 移动高亮、Enter 选中、Esc 收起（浮层是 focusable 窗口，会拿到焦点）。
 */

(function () {
  const api = window.bmFolder;
  const listEl = document.getElementById('bf-list');
  const searchEl = document.getElementById('bf-search');
  const newNameEl = document.getElementById('bf-new-input');
  if (!api || !listEl) return;

  /** 输入框里的名字（右键新建子文件夹时用它，留空交给主进程自动命名） */
  function currentName() {
    return newNameEl ? String(newNameEl.value || '').trim() : '';
  }

  /** 新建文件夹：优先用输入框里的名字（v1.7.0），留空交给主进程自动命名 */
  function createFolderAndBookmark() {
    api.pick('new', currentName());
  }

  /** 当前文件夹条目（主进程推送，渲染用） */
  let items = [];
  /** 「最近使用」的文件夹（v1.8.0，主进程下发，最多 3 个） */
  let recent = [];
  /** 置顶建议（v1.13.0，主进程下发，最多 5 条） */
  let pinned = [];
  /** 当前高亮下标（-1 = 未选中） */
  let activeIndex = -1;
  /** 搜索过滤词（v1.6.0） */
  let filterText = '';

  /** 创建元素快捷方法 */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 按搜索词过滤：只过滤文件夹行；「新建文件夹并收藏…」始终保留在末尾 */
  function visibleItems() {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => String(item.title || '').toLowerCase().includes(needle));
  }

  /** 高亮第 index 条并把对应行滚进视野 */
  function highlight(index) {
    const rows = Array.from(listEl.querySelectorAll('.bf-item-pick'));
    activeIndex = index;
    rows.forEach((row, i) => {
      const on = i === index;
      row.classList.toggle('is-on', on);
      if (on && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
    });
  }

  /** 渲染：根「书签栏」→ 各级文件夹（按 depth 缩进）→ 分隔线 → 新建文件夹并收藏 */
  function render(index) {
    listEl.textContent = '';
    const visible = visibleItems();

    if (!visible.length) {
      listEl.appendChild(
        el('div', 'bf-empty', filterText.trim() ? `没有匹配「${filterText.trim()}」的文件夹` : '还没有文件夹，先收藏到书签栏'),
      );
      // 没有匹配时仍给「新建文件夹」入口，避免用户卡住
      const emptyCreate = el('div', 'bf-item bf-item-new bf-item-pick');
      emptyCreate.appendChild(el('span', 'bf-name', '新建文件夹并收藏…'));
      emptyCreate.addEventListener('click', () => createFolderAndBookmark());
      listEl.appendChild(emptyCreate);
      highlight(-1);
      return;
    }

    const frag = document.createDocumentFragment();

    // 置顶建议（v1.13.0）：常用页面直达，不必先打字
    if (pinned.length) {
      frag.appendChild(el('div', 'bf-head bf-head-pinned', '置顶建议'));
      for (const item of pinned) {
        const row = el('div', 'bf-item bf-item-pinned');
        row.title = item.url;
        row.appendChild(el('span', 'bf-name', item.title || item.url));
        row.addEventListener('click', () => {
          if (api.openUrl) api.openUrl(item.url);
        });
        frag.appendChild(row);
      }
      frag.appendChild(el('div', 'bf-divider'));
    }

    // 「最近使用」（v1.8.0）：置顶 2~3 个常用落点，省一次翻找
    const recentUsable = recent.filter((item) => !filterText.trim() || String(item.title || '').toLowerCase().includes(filterText.trim().toLowerCase()));
    if (recentUsable.length) {
      frag.appendChild(el('div', 'bf-head bf-head-recent', '最近使用'));
      for (const item of recentUsable) {
        const row = el('div', 'bf-item bf-item-recent');
        row.dataset.folderId = String(item.id);
        row.classList.add('bf-item-pick');
        row.title = '点击收藏到这里；右键 = 在此新建子文件夹';
        row.appendChild(el('span', 'bf-name', item.title || '未命名文件夹'));
        const count = Number(item.count);
        if (Number.isFinite(count) && count > 0) row.appendChild(el('span', 'bf-count', String(count)));
        row.addEventListener('mouseenter', () =>
          highlight(Array.from(listEl.querySelectorAll('.bf-item-pick')).indexOf(row)),
        );
        row.addEventListener('click', () => api.pick(item.id));
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          api.pick(item.id, currentName(), true);
        });
        frag.appendChild(row);
      }
      frag.appendChild(el('div', 'bf-divider'));
    }

    for (const item of visible) {
      const depth = Math.min(Number(item.depth) || 0, 3);
      const row = el('div', `bf-item${depth ? ` bf-depth-${depth}` : ''}`);
      row.dataset.folderId = String(item.id);
      row.classList.add('bf-item-pick');
      row.title = '点击收藏到这里；右键 = 在此新建子文件夹并收藏';
      row.appendChild(el('span', 'bf-name', item.title || '未命名文件夹'));
      const count = Number(item.count);
      if (Number.isFinite(count) && count > 0) {
        row.appendChild(el('span', 'bf-count', String(count)));
      }
      row.addEventListener('mouseenter', () => highlight(Array.from(listEl.querySelectorAll('.bf-item-pick')).indexOf(row)));
      row.addEventListener('click', () => api.pick(item.id));
      // 右键：在该文件夹下新建子文件夹并收藏（名字取输入框，留空自动）
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        api.pick(item.id, currentName(), true);
      });
      frag.appendChild(row);
    }

    // 分隔线 + 新建文件夹（放在列表末尾，避免和"书签栏"混淆）
    frag.appendChild(el('div', 'bf-divider'));
    const createRow = el('div', 'bf-item bf-item-new bf-item-pick');
    createRow.appendChild(el('span', 'bf-name', '新建文件夹并收藏…'));
    createRow.addEventListener('mouseenter', () =>
      highlight(Array.from(listEl.querySelectorAll('.bf-item-pick')).indexOf(createRow)),
    );
    createRow.addEventListener('click', () => createFolderAndBookmark());
    frag.appendChild(createRow);

    listEl.appendChild(frag);
    highlight(index);
  }

  // 主进程推送数据（窗口复用时也会重新推送）
  api.onData((payload) => {
    items = Array.isArray(payload.items) ? payload.items : [];
    recent = Array.isArray(payload.recent) ? payload.recent : [];
    pinned = Array.isArray(payload.pinned) ? payload.pinned : [];
    filterText = '';
    if (searchEl) searchEl.value = '';
    render(-1);
  });

  // 搜索框：即时过滤（窗口很小，不必防抖）
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      filterText = searchEl.value || '';
      render(-1);
    });
    searchEl.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        // 焦点在搜索框时，方向键/回车直接作用到列表（体验上像"边打边选"）
        event.preventDefault();
        const rows = Array.from(listEl.querySelectorAll('.bf-item-pick'));
        if (!rows.length) return;
        if (event.key === 'Enter') {
          api.pick(rows[0].dataset.folderId);
          return;
        }
        highlight(0);
        rows[0].focus && rows[0].focus();
      }
    });
  }

  // 命名输入框：回车 = 用这个名字新建文件夹并收藏（v1.7.0）
  if (newNameEl) {
    newNameEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      createFolderAndBookmark();
    });
  }

  // 键盘：↑↓ 选择、Enter 确认、Esc 收起
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const rows = Array.from(listEl.querySelectorAll('.bf-item-pick'));
      if (!rows.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      let next = activeIndex + delta;
      if (next < 0) next = rows.length - 1;
      if (next >= rows.length) next = 0;
      highlight(next);
      return;
    }
    if (event.key === 'Enter') {
      const rows = Array.from(listEl.querySelectorAll('.bf-item-pick'));
      const row = rows[activeIndex];
      if (!row) return;
      event.preventDefault();
      api.pick(row.dataset.folderId);
    }
  });
})();
