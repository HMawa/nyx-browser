'use strict';

/**
 * 书签管理窗口（bm-manage.html）的页面逻辑。
 *
 * 功能：
 *   - 树形展示全部书签：文件夹可展开 / 折叠，书签为叶子；
 *   - 复选框多选：勾选文件夹会联动勾选 / 取消其全部后代
 *     （删除时文件夹递归连带子项，与主进程 removeMany 语义一致）；
 *   - 「删除选中」批量删除：删除前页内二次确认，不可撤销；
 *   - 每行「↑ / ↓」按钮在同级内调整顺序（单行操作，立即生效）；
 *   - 增删改均直接走主进程持久化；主进程会推送 nyx:bm:changed，
 *     主窗口书签栏自动刷新；本窗口每次操作后重新拉树保持最新；
 *   - 窗口重新聚焦时也会重新拉树（主窗口导入书签后本窗口数据同步）。
 */

(function () {
  const api = window.bmManage;
  const treeEl = document.getElementById('bm-tree');
  const countEl = document.getElementById('bm-count');
  const delBtn = document.getElementById('bm-delete');
  const closeBtn = document.getElementById('bm-close');
  const confirmBar = document.getElementById('bm-confirm');
  const confirmMsg = document.getElementById('bm-confirm-msg');
  const confirmOk = document.getElementById('bm-confirm-ok');
  const confirmCancel = document.getElementById('bm-confirm-cancel');
  const statusEl = document.getElementById('bm-status');
  if (!api || !treeEl) return;

  /** 当前根节点（listTree 返回的 root，children 为一级节点） */
  let root = null;
  /** 已折叠的文件夹 id 集合 */
  const collapsed = new Set();
  /** 待删除的勾选 id（确认条弹出期间暂存） */
  let pendingDelete = [];

  /** 创建元素快捷方法：el('div', 'className', '文本') */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 重新拉取书签树并渲染 */
  async function load() {
    let res = null;
    try {
      res = await api.list();
    } catch (err) {
      console.warn('[Nyx] 书签管理加载失败：', err && err.message);
      return;
    }
    if (!res || res.ok === false) return;
    root = res.tree && res.tree.root;
    renderTree();
  }

  /** 渲染整棵树（文件夹折叠时跳过其 children 子树） */
  function renderTree() {
    treeEl.textContent = '';
    if (!root || !Array.isArray(root.children) || root.children.length === 0) {
      treeEl.appendChild(el('div', 'bm-empty', '（暂无书签）'));
      updateCount();
      return;
    }
    const frag = document.createDocumentFragment();
    walk(root.children, 0, frag);
    treeEl.appendChild(frag);
    updateCount();
  }

  /** 递归渲染节点行 */
  function walk(nodes, depth, parent) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      parent.appendChild(buildRow(node, depth));
      // 文件夹且未折叠：继续渲染子项
      if (!node.url && Array.isArray(node.children) && node.children.length && !collapsed.has(node.id)) {
        const sub = el('div', 'bm-children');
        walk(node.children, depth + 1, sub);
        parent.appendChild(sub);
      }
    }
  }

  /** 构建一行：复选框 + 展开箭头 + 标题 + 上移 / 下移 */
  function buildRow(node, depth) {
    const row = el('div', 'bm-row');
    row.style.paddingLeft = `${8 + depth * 18}px`;

    const cb = el('input', 'bm-cb');
    cb.type = 'checkbox';
    cb.dataset.id = String(node.id);
    cb.title = node.url ? `打开：${node.url}` : '勾选以批量删除（将连带删除文件夹内全部书签）';
    cb.addEventListener('change', () => onCheck(node, cb.checked));
    row.appendChild(cb);

    if (!node.url) {
      // 文件夹：展开 / 折叠箭头
      const arrow = el('button', 'bm-arrow', collapsed.has(node.id) ? '▶' : '▼');
      arrow.type = 'button';
      arrow.title = collapsed.has(node.id) ? '展开文件夹' : '折叠文件夹';
      arrow.addEventListener('click', () => {
        if (collapsed.has(node.id)) collapsed.delete(node.id);
        else collapsed.add(node.id);
        renderTree();
      });
      row.appendChild(arrow);
    } else {
      row.appendChild(el('span', 'bm-arrow-spacer', ''));
    }

    const label = el(
      'span',
      node.url ? 'bm-label bm-label-url' : 'bm-label bm-label-folder',
      node.title || (node.url ? node.url : '未命名文件夹'),
    );
    if (node.url) label.title = node.url;
    row.appendChild(label);

    // 操作区：同级上移 / 下移（悬停显示）
    const ops = el('span', 'bm-ops');
    const up = el('button', 'bm-op', '↑');
    up.type = 'button';
    up.title = '在同级内上移';
    up.addEventListener('click', () => move(node.id, 'up'));
    const down = el('button', 'bm-op', '↓');
    down.type = 'button';
    down.title = '在同级内下移';
    down.addEventListener('click', () => move(node.id, 'down'));
    ops.appendChild(up);
    ops.appendChild(down);
    row.appendChild(ops);

    return row;
  }

  /** 勾选文件夹时联动勾选 / 取消其全部后代（含嵌套文件夹的后代） */
  function onCheck(node, checked) {
    if (!node.url) {
      const ids = new Set();
      collectDescendantIds(node, ids);
      treeEl.querySelectorAll('input.bm-cb').forEach((cb) => {
        if (ids.has(Number(cb.dataset.id))) cb.checked = checked;
      });
    }
    updateCount();
  }

  /** 收集节点全部后代 id（自身除外） */
  function collectDescendantIds(node, out) {
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) {
      out.add(child.id);
      collectDescendantIds(child, out);
    }
  }

  /** 收集所有勾选的行 id */
  function collectCheckedIds() {
    const ids = [];
    treeEl.querySelectorAll('input.bm-cb:checked').forEach((cb) => ids.push(Number(cb.dataset.id)));
    return ids;
  }

  /** 统计书签总数与勾选数（顶部展示） */
  function updateCount() {
    let total = 0;
    const countUrls = (nodes) => {
      for (const node of nodes) {
        if (node.url) total += 1;
        if (Array.isArray(node.children)) countUrls(node.children);
      }
    };
    if (root && Array.isArray(root.children)) countUrls(root.children);
    const checked = treeEl.querySelectorAll('input.bm-cb:checked').length;
    countEl.textContent = `共 ${total} 个书签${checked ? `，已选 ${checked} 项` : ''}`;
    delBtn.textContent = checked ? `删除选中（${checked}）` : '删除选中';
  }

  /** 底部状态提示，2 秒后自动消失 */
  function flash(text) {
    statusEl.textContent = text;
    statusEl.hidden = false;
    clearTimeout(flash._timer);
    flash._timer = setTimeout(() => {
      statusEl.hidden = true;
    }, 2000);
  }

  /** 同级上移 / 下移（单行操作，立即生效） */
  async function move(id, direction) {
    let res = null;
    try {
      res = await api.move(id, direction);
    } catch (err) {
      flash('移动失败');
      return;
    }
    if (!res || res.ok === false) {
      flash((res && res.error) || '移动失败');
      return;
    }
    if (res.moved) load();
  }

  /* ---------------- 事件绑定 ---------------- */

  // 删除：收集勾选 → 页内二次确认 → 批量删除 → 重拉树
  delBtn.addEventListener('click', () => {
    const ids = collectCheckedIds();
    if (!ids.length) {
      flash('请先勾选要删除的书签');
      return;
    }
    pendingDelete = ids;
    confirmMsg.textContent = `将删除 ${ids.length} 项（文件夹会连带删除其内全部书签），此操作不可撤销。`;
    confirmBar.hidden = false;
  });

  confirmOk.addEventListener('click', async () => {
    const ids = pendingDelete;
    confirmBar.hidden = true;
    pendingDelete = [];
    if (!ids.length) return;
    let res = null;
    try {
      res = await api.removeMany(ids);
    } catch (err) {
      flash('删除失败');
      return;
    }
    if (res && res.ok) {
      flash(`已删除 ${res.removed || 0} 项`);
      load();
    } else {
      flash((res && res.error) || '删除失败');
    }
  });

  confirmCancel.addEventListener('click', () => {
    confirmBar.hidden = true;
    pendingDelete = [];
  });

  closeBtn.addEventListener('click', () => api.close());

  // 重新聚焦时同步最新数据（主窗口可能刚导入书签）
  window.addEventListener('focus', load);

  load();
})();
