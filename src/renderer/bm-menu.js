'use strict';

/**
 * 书签下拉浮层（bm-menu.html）的页面逻辑。
 *
 * 数据流：
 *   书签栏文件夹按钮点击 → 主进程 openBookmarkMenu 弹出本窗口，
 *   窗口加载完成后推送 nyx:bm:data（{ items }）→ 本脚本渲染列表；
 *   点击书签项 → bmMenu.navigate(url) → 主进程在激活标签打开并关闭浮层；
 *   浮层失焦自动关闭由主进程处理，本页面无需额外逻辑。
 */

(function () {
  const api = window.bmMenu;
  const listEl = document.getElementById('bm-menu-list');
  if (!api || !listEl) return;

  /** 创建元素快捷方法：el('div', 'className', '文本') */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * 渲染浮层条目。
   * items 元素：{ title, url?, depth, folder? }
   *   - folder 为真：加粗标题行，不可点（仅视觉层级）；
   *   - 其余为书签行，点击让主进程 navigate。
   */
  function render(items) {
    listEl.textContent = '';
    if (!items || !items.length) {
      listEl.appendChild(el('div', 'bm-menu-empty', '（空文件夹）'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const depth = Number(it.depth) || 0;
      if (it.folder) {
        const head = el('div', 'bm-menu-folder', it.title || '未命名文件夹');
        head.style.paddingLeft = `${10 + depth * 18}px`;
        frag.appendChild(head);
      } else {
        const item = el('div', 'bm-menu-item', it.title || it.url);
        item.style.paddingLeft = `${10 + depth * 18}px`;
        item.title = it.url;
        item.addEventListener('click', () => {
          api.navigate(it.url);
        });
        frag.appendChild(item);
      }
    }
    listEl.appendChild(frag);
  }

  // 主进程推送浮层数据后渲染（窗口复用时也会重新推送）
  api.onData((payload) => render(payload.items));
})();
