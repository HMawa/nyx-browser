'use strict';

/**
 * 书签（收藏）存储（Nyx 1.2.4 升级：扁平列表 → 树结构 v2）。
 *
 * 落盘位置：<userData>/bookmarks.json（即 %APPDATA%\Nyx\bookmarks.json）。
 *
 * 数据结构 v2：
 *   {
 *     version: 2,
 *     root: { id: 0, title: '书签栏', children: [节点...] }
 *   }
 *   节点 = { id, title, url?, children?, addedAt? }
 *   - url 节点：书签（叶子），url 必填；
 *   - children 节点：文件夹（可继续嵌套 children），url 不填。
 *
 * 兼容与迁移：
 *   - 旧 v1 扁平文件（{ version: 1, items: [...] }）加载时自动迁移为树，
 *     全部书签挂到根下，不丢数据；
 *   - 从 Edge / Chrome 导入时保留文件夹层级（roots.bookmark_bar 根下递归），
 *     同名文件夹在父级下复用、URL 按所在文件夹内去重；
 *   - 重新导入时若某 URL 已平铺在根下但浏览器里属于某个文件夹，
 *     自动把它从根下移入对应文件夹（一次性恢复分类，不产生重复）。
 *
 * 红线：隐私模式不写历史由历史存储把关；书签存储本身无隐私分支。
 */

const fs = require('fs');
const path = require('path');

/** 数据文件版本号（v2 = 树结构） */
const BOOKMARK_VERSION = 2;

/** 根节点固定 id 与标题 */
const ROOT_ID = 0;
const ROOT_TITLE = '书签栏';

/** 标题清洗：限长、去首尾空白、去换行 */
function cleanTitle(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  return s.length > 512 ? `${s.slice(0, 512)}…` : s;
}

/** URL 清洗：必须是非空字符串、限长、不含换行 */
function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s || s.length > 4096 || /[\r\n]/.test(s)) return '';
  return s;
}

/** 各浏览器书签文件路径（相对 LOCALAPPDATA） */
const BROWSER_BOOKMARK_PATHS = {
  edge: (localAppData) => path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'),
  chrome: (localAppData) => path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
};

/** 浏览器显示名（提示文案用） */
const BROWSER_NAMES = { edge: 'Edge', chrome: 'Chrome' };

/** 深度拷贝一个节点（listTree 返回副本，防止渲染层误改主进程内存） */
function cloneNode(node) {
  if (!node || typeof node !== 'object') return null;
  const out = { id: node.id, title: node.title };
  if (typeof node.url === 'string' && node.url) out.url = node.url;
  if (Number.isFinite(node.addedAt) && node.addedAt > 0) out.addedAt = node.addedAt;
  if (Array.isArray(node.children)) out.children = node.children.map(cloneNode);
  return out;
}

class BookmarkStore {
  /**
   * @param {object} options
   * @param {string} options.stateDir 落盘目录（主进程传 app.getPath('userData')）
   * @param {string} options.localAppData 浏览器用户目录根（主进程传 app.getPath('localAppData')）
   */
  constructor({ stateDir, localAppData }) {
    this.statePath = path.join(stateDir, 'bookmarks.json');
    this.localAppData = localAppData || process.env.LOCALAPPDATA || '';
    /** @type {{version:number, root:{id:number, title:string, children:Array}}} */
    this.tree = { version: BOOKMARK_VERSION, root: { id: ROOT_ID, title: ROOT_TITLE, children: [] } };
    /** 全局自增 id 序列（跨文件夹唯一） */
    this.seq = 1;
    this.saveChain = Promise.resolve();
    this.loaded = false;
  }

  /* ---------------- 加载与迁移 ---------------- */

  /** 启动时加载；文件缺失 / 损坏一律回落为空树，绝不抛异常 */
  load() {
    if (this.loaded) return this.tree;
    this.loaded = true;
    let raw = null;
    try {
      if (fs.existsSync(this.statePath)) {
        raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8').replace(/^\uFEFF/, ''));
      }
    } catch {
      raw = null;
    }

    // v2 树结构：直接采用，仅做兜底规范化
    if (raw && raw.version === 2 && raw.root && typeof raw.root === 'object') {
      this.tree = raw;
      this.tree.root.id = ROOT_ID;
      if (!cleanTitle(this.tree.root.title)) this.tree.root.title = ROOT_TITLE;
      if (!Array.isArray(this.tree.root.children)) this.tree.root.children = [];
      this.seq = this.maxIdOf(this.tree.root) + 1;
      return this.tree;
    }

    // v1 扁平结构（旧版 { version:1, items:[...] }）：自动迁移为树，全部挂到根下
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    const root = { id: ROOT_ID, title: ROOT_TITLE, children: [] };
    const usedIds = new Set();
    let maxId = 0;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const url = cleanUrl(it.url);
      if (!url) continue;
      const rawId = Number(it.id);
      let id = Number.isFinite(rawId) && rawId > 0 ? rawId : 0;
      if (id > 0 && usedIds.has(id)) id = 0; // 旧数据里 id 撞车时补发新 id
      if (id <= 0) id = this.nextFreeId(usedIds, maxId);
      usedIds.add(id);
      if (id > maxId) maxId = id;
      const addedAt = Number(it.addedAt);
      root.children.push({
        id,
        title: cleanTitle(it.title) || url,
        url,
        addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : 0,
      });
    }
    this.tree = { version: BOOKMARK_VERSION, root };
    this.seq = maxId + 1;
    // 迁移完成后立即落盘为 v2，避免下次启动重复走迁移分支
    this.save();
    return this.tree;
  }

  /** 在 usedIds 之外找一个最小可用 id（从 maxId+1 起） */
  nextFreeId(usedIds, maxId) {
    let id = Math.max(1, maxId + 1);
    while (usedIds.has(id)) id += 1;
    return id;
  }

  /** 遍历整棵树，返回最大节点 id */
  maxIdOf(node) {
    let max = Number.isFinite(node.id) ? node.id : 0;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const m = this.maxIdOf(child);
        if (m > max) max = m;
      }
    }
    return max;
  }

  /* ---------------- 查询 ---------------- */

  /** 返回书签树副本（含根与 children），渲染层直接消费 */
  listTree() {
    return { version: BOOKMARK_VERSION, root: cloneNode(this.tree.root) };
  }

  /** 统计书签（url 节点）总数，供日志与面板元信息使用 */
  count() {
    let n = 0;
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.url) n += 1;
        if (Array.isArray(node.children)) walk(node.children);
      }
    };
    walk(this.tree.root.children);
    return n;
  }

  /** 按 id 查找节点；返回 { parent, index, node }，找不到返回 null */
  findById(id) {
    const key = Number(id);
    const stack = [{ parent: this.tree.root, node: this.tree.root }];
    while (stack.length) {
      const cur = stack.pop();
      if (cur.node.id === key && cur.node !== this.tree.root) {
        return { parent: cur.parent, index: cur.parent.children.indexOf(cur.node), node: cur.node };
      }
      if (Array.isArray(cur.node.children)) {
        for (const child of cur.node.children) stack.push({ parent: cur.node, node: child });
      }
    }
    return null;
  }

  /** 树内是否存在同 url 的书签（跨文件夹全局去重用） */
  hasUrl(nodes, url) {
    for (const node of nodes) {
      if (node.url && node.url === url) return true;
      if (Array.isArray(node.children) && this.hasUrl(node.children, url)) return true;
    }
    return false;
  }

  /* ---------------- 写操作 ---------------- */

  /**
   * 收藏一个页面。
   * URL 已存在则跳过（保持 v1 行为：同一页面只收藏一次）。
   * @param {{title?:string, url:string, folderId?:number}} payload
   *        folderId 省略时收藏到根下（书签栏）
   */
  add({ title, url, folderId }) {
    const clean = cleanUrl(url);
    if (!clean) return { ok: false, error: '地址不合法' };
    if (this.hasUrl(this.tree.root.children, clean)) {
      return { ok: false, code: 'EXISTS', error: '该页面已在书签中' };
    }
    let target = this.tree.root;
    if (folderId != null) {
      const found = this.findById(folderId);
      if (!found || !Array.isArray(found.node.children)) {
        return { ok: false, error: '目标文件夹不存在' };
      }
      target = found.node;
    }
    target.children.unshift({
      id: this.seq++,
      title: cleanTitle(title) || clean,
      url: clean,
      addedAt: Date.now(),
    });
    this.save();
    return { ok: true, added: true };
  }

  /**
   * 新建文件夹。
   * @param {{title:string, parentId?:number}} payload
   *        parentId 省略时建在根下
   */
  addFolder({ title, parentId }) {
    const clean = cleanTitle(title);
    if (!clean) return { ok: false, error: '文件夹名不能为空' };
    let target = this.tree.root;
    if (parentId != null) {
      const found = this.findById(parentId);
      if (!found || !Array.isArray(found.node.children)) {
        return { ok: false, error: '目标文件夹不存在' };
      }
      target = found.node;
    }
    const node = { id: this.seq++, title: clean, children: [] };
    target.children.push(node);
    this.save();
    return { ok: true, id: node.id, title: node.title };
  }

  /** 按 id 删除节点（文件夹连同子书签一起删除）；根节点不可删 */
  remove(id) {
    const key = Number(id);
    if (!Number.isFinite(key) || key <= ROOT_ID) {
      return { ok: false, error: '书签不存在' };
    }
    const found = this.findById(key);
    if (!found) return { ok: false, error: '书签不存在' };
    found.parent.children.splice(found.index, 1);
    this.save();
    return { ok: true };
  }

  /**
   * 批量删除书签 / 文件夹（书签管理窗口用）。
   * 每个 id 独立校验：删除文件夹会连同其全部子节点一并删除；
   * 重复 id / 不存在的 id / 根 id 自动跳过，不视为失败。
   * @param {Array<number|string>} ids
   * @returns {{ok:boolean, removed:number, skipped:number}}
   */
  removeMany(ids) {
    const list = Array.isArray(ids) ? ids : [];
    // 归一化：去重、只保留合法 id（大于根 id 0）
    const keys = [...new Set(list.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > ROOT_ID))];
    let removed = 0;
    let skipped = 0;
    for (const key of keys) {
      const found = this.findById(key);
      if (!found) {
        skipped += 1;
        continue;
      }
      // 文件夹节点连同其 children 一起被 splice 移除，子书签随之删除
      found.parent.children.splice(found.index, 1);
      removed += 1;
    }
    if (removed > 0) this.save();
    return { ok: true, removed, skipped };
  }

  /**
   * 同级排序：把指定节点在父级 children 内上移 / 下移一格（书签管理窗口用）。
   * @param {number|string} id
   * @param {'up'|'down'} direction
   * @returns {{ok:boolean, error?:string, moved?:boolean}}
   */
  moveItem(id, direction) {
    const key = Number(id);
    if (!Number.isFinite(key) || key <= ROOT_ID) {
      return { ok: false, error: '书签不存在' };
    }
    const found = this.findById(key);
    if (!found) return { ok: false, error: '书签不存在' };
    const siblings = found.parent.children;
    const idx = found.index;
    const dir = direction === 'up' ? 'up' : 'down';
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= siblings.length) {
      return { ok: false, error: dir === 'up' ? '已在最前，无法上移' : '已在最后，无法下移' };
    }
    // 同数组内交换相邻位置即可（保持其它节点顺序不变）
    const node = siblings.splice(idx, 1)[0];
    siblings.splice(target, 0, node);
    this.save();
    return { ok: true, moved: true };
  }

  /** 一键清空（IPC 保留 clear，为后续管理入口预留） */
  clear() {
    this.tree.root.children = [];
    this.save();
    return { ok: true };
  }

  /**
   * 从 Edge / Chrome 本地书签文件导入（保留文件夹层级）。
   * @param {'edge'|'chrome'} source
   * @returns {{ok:boolean, added:number, skipped:number, moved:number, source:string}}
   */
  importFrom(source) {
    const src = source === 'chrome' ? 'chrome' : 'edge';
    const filePath = BROWSER_BOOKMARK_PATHS[src](this.localAppData);
    if (!this.localAppData) {
      return { ok: false, error: '无法定位浏览器用户目录（LOCALAPPDATA 为空）' };
    }
    let parsed = null;
    try {
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `未找到 ${BROWSER_NAMES[src]} 书签文件：${filePath}` };
      }
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return { ok: false, error: `读取 ${BROWSER_NAMES[src]} 书签文件失败（可能被占用或损坏）` };
    }

    const roots = parsed && parsed.roots;
    if (!roots) return { ok: true, added: 0, skipped: 0, moved: 0, source: src };

    const stats = { added: 0, skipped: 0, moved: 0 };

    // 书签栏（bookmark_bar）保层级；other / synced 若存在也保层级挂到根下，不丢数据
    for (const key of ['bookmark_bar', 'other', 'synced']) {
      const browserRoot = roots[key];
      if (!browserRoot || typeof browserRoot !== 'object') continue;
      const targetFolder =
        key === 'bookmark_bar'
          ? this.tree.root
          : this.ensureFolder(this.tree.root, cleanTitle(browserRoot.name) || (key === 'other' ? '其他书签' : '同步书签'));
      this.importNode(browserRoot, targetFolder, stats);
    }

    if (stats.added > 0 || stats.moved > 0) this.save();
    return { ok: true, added: stats.added, skipped: stats.skipped, moved: stats.moved, source: src };
  }

  /** 在父级下找同名文件夹，不存在则新建（同级同名复用） */
  ensureFolder(parent, title) {
    const name = cleanTitle(title) || '未命名文件夹';
    if (Array.isArray(parent.children)) {
      for (const child of parent.children) {
        if (!child.url && cleanTitle(child.title) === name) return child;
      }
    }
    const node = { id: this.seq++, title: name, children: [] };
    if (!Array.isArray(parent.children)) parent.children = [];
    parent.children.push(node);
    return node;
  }

  /** 递归导入一个浏览器书签节点到目标文件夹 */
  importNode(browserNode, targetFolder, stats) {
    if (!browserNode || typeof browserNode !== 'object') return;
    if (!Array.isArray(browserNode.children)) return;

    for (const child of browserNode.children) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'folder') {
        // 文件夹：同级同名复用，递归子项
        const folder = this.ensureFolder(targetFolder, child.name);
        this.importNode(child, folder, stats);
        continue;
      }
      if (child.type !== 'url') continue;
      const clean = cleanUrl(child.url);
      if (!clean) continue;
      const title = cleanTitle(child.name) || clean;

      // 迁移搬家：该 URL 已平铺在根下、但浏览器里属于某个文件夹 → 从根下移入该文件夹
      if (targetFolder !== this.tree.root) {
        const rootIdx = this.tree.root.children.findIndex((n) => n.url === clean);
        if (rootIdx >= 0) {
          const node = this.tree.root.children.splice(rootIdx, 1)[0];
          node.title = title;
          targetFolder.children.push(node);
          stats.moved += 1;
          continue;
        }
      }

      // 文件夹内去重（与目标文件夹里已有书签比较）
      if (targetFolder.children.some((n) => n.url === clean)) {
        stats.skipped += 1;
        continue;
      }

      targetFolder.children.push({
        id: this.seq++,
        title,
        url: clean,
        addedAt: Date.now(),
      });
      stats.added += 1;
    }
  }

  /** 串行写盘 */
  save() {
    const snapshot = JSON.stringify(this.tree, null, 2);
    this.saveChain = this.saveChain.then(() => {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        fs.writeFileSync(this.statePath, snapshot, 'utf8');
      } catch (err) {
        console.warn('[Nyx] 书签写盘失败：', err.message);
      }
    });
    return this.saveChain;
  }
}

module.exports = { BookmarkStore, BOOKMARK_VERSION };
