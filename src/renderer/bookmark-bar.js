'use strict';

/**
 * 顶部书签栏（Nyx 1.2.4 新增，本次重构下拉浮层）。
 *
 * 职责：
 *   - 加载书签树（nyx:bookmarks:list 返回 v2 树结构）并渲染到 #bookmark-bar；
 *   - 书签节点平铺为文本按钮，文件夹节点渲染为「标题 + ▾」按钮；
 *   - 点击文件夹按钮：把「按钮的屏幕坐标 + 递归子项数据」交给主进程，
 *     弹出独立无边框浮层窗口（bm-menu.html）——
 *     标签视图是 WebContentsView 原生子视图，DOM 浮层会被它整体盖住，
 *     必须用独立 BrowserWindow 才能保证浮层可见、可点；
 *   - 点击书签项调用 window.nyx.navigate(url)，与地址栏同一通道，在当前标签打开；
 *   - 最右侧「管理」按钮（index.html 静态渲染）打开独立管理窗口（bm-manage.html），
 *     管理窗口增删改后经 onBookmarkChanged 推送，本栏自动重渲染。
 *
 * 全部为中文注释；无第三方依赖。
 */

(function () {
  const nyx = window.nyx;
  const bar = document.getElementById('bookmark-bar');
  if (!nyx || !bar) return;

  /** 创建元素快捷方法：el('div', 'className', '文本') */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 从主进程加载书签树并渲染 */
  async function load() {
    let res = null;
    try {
      res = await nyx.bookmarksList();
    } catch (err) {
      console.warn('[Nyx] 书签栏加载失败：', err && err.message);
      return;
    }
    if (!res || res.ok === false) return;
    const root = res.tree && res.tree.root;
    if (!root || !Array.isArray(root.children)) return;
    render(root.children);
  }

  /** 渲染根下的一级节点：书签平铺、文件夹按钮 */
  function render(children) {
    bar.textContent = '';
    const frag = document.createDocumentFragment();
    for (const node of children) {
      if (!node || typeof node !== 'object') continue;
      if (node.url) frag.appendChild(buildBookmark(node));
      else frag.appendChild(buildFolder(node));
    }
    bar.appendChild(frag);
  }

  /** 书签按钮：显示标题文本，点击在当前标签打开 */
  function buildBookmark(node) {
    const btn = el('button', 'bm-item', node.title || node.url);
    btn.type = 'button';
    btn.title = node.url;
    btn.addEventListener('click', () => {
      window.nyx.navigate(node.url);
    });
    return btn;
  }

  /** 文件夹按钮：标题 + ▾，点击弹出独立浮层窗口 */
  function buildFolder(node) {
    const btn = el('button', 'bm-item bm-folder', `${node.title || '未命名文件夹'} ▾`);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      openMenuFor(btn, node);
    });
    return btn;
  }

  /**
   * 弹出文件夹浮层。
   * 步骤：① 递归收集子项（url 书签 + 文件夹标题行，带缩进层级 depth）；
   *       ② 用 getContentBounds 把按钮的视口坐标换算成屏幕坐标；
   *       ③ 调主进程 IPC 打开独立无边框浮层窗口（坐标与数据一起交付）。
   */
  async function openMenuFor(anchor, folderNode) {
    if (!nyx.bookmarksOpenMenu) return;
    const items = [];
    collectMenuItems(folderNode.children || [], 0, items);
    const rect = anchor.getBoundingClientRect();
    const bounds = await nyx.getContentBounds().catch(() => null);
    if (!bounds) {
      console.warn('[Nyx] 无法获取主窗口内容区坐标，浮层未弹出');
      return;
    }
    // 屏幕坐标 = 主窗口内容区左上角 + 按钮在页面内的偏移；
    // 浮层左上角对齐按钮左下角，略留 6px 间距
    nyx.bookmarksOpenMenu({
      x: bounds.x + rect.left,
      y: bounds.y + rect.bottom + 6,
      items,
    });
  }

  /** 递归收集浮层子项：url 节点为可点书签，folder 节点为加粗标题行（仅视觉层级） */
  function collectMenuItems(children, depth, out) {
    for (const node of children) {
      if (!node || typeof node !== 'object') continue;
      if (node.url) {
        out.push({ title: node.title || node.url, url: node.url, depth });
      } else {
        out.push({ title: node.title || '未命名文件夹', depth, folder: true });
        collectMenuItems(node.children || [], depth + 1, out);
      }
    }
  }

  // 订阅书签变化推送：管理窗口增删改后，书签栏立即重渲染
  if (nyx.onBookmarkChanged) {
    nyx.onBookmarkChanged(() => load());
  }

  // 绑定右侧「管理」按钮：打开工具箱并切换到书签页签（书签管理已移入工具箱）
  const manageBtn = document.getElementById('bm-manage-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      if (nyx.openToolboxPane) {
        nyx.openToolboxPane({ pane: 'bookmarks' });
      } else if (nyx.bookmarksOpenManage) {
        // 旧版本 preload 回退：仍打开独立管理窗口
        nyx.bookmarksOpenManage();
      }
    });
  }

  // 暴露刷新入口：工具箱导入书签成功后调用，书签栏立即重渲染
  window.refreshBookmarkBar = load;

  load();
})();
