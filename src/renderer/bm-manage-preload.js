'use strict';

/**
 * 书签管理窗口的预加载脚本（bm-manage.html 专用）。
 *
 * 管理窗口是独立 BrowserWindow（sandbox 开启），不共享主窗口的 preload，
 * 这里单独暴露与书签管理相关的 IPC 能力：
 *   - list：拉取书签树（v2 树结构）；
 *   - removeMany：批量删除书签 / 文件夹（文件夹递归连带子项）；
 *   - move：同级上移 / 下移；
 *   - close：关闭管理窗口。
 * 保存修改由主进程直接落盘并推送 nyx:bm:changed，主窗口书签栏自动刷新。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 主题前置：管理窗口跟随主窗口主题（深浅底色一致），
 * 避免浅色主题下窗口出现前闪一下深色。
 */
(function applyEarlyTheme() {
  const apply = (snap) => {
    const theme = (snap && snap.ui && snap.ui.theme) || 'ink';
    const root = document.documentElement;
    if (root) {
      root.dataset.theme = theme;
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          document.documentElement.dataset.theme = theme;
        },
        { once: true },
      );
    }
  };
  ipcRenderer.invoke('nyx:get-state').then(apply).catch(() => {});
})();

contextBridge.exposeInMainWorld('bmManage', {
  /** 拉取完整书签树：{ ok, tree: { version, root } } */
  list: () => ipcRenderer.invoke('nyx:bookmarks:list'),

  /** 批量删除：{ ids }，文件夹递归连带子项，重复 / 不存在 / 根 id 自动跳过 */
  removeMany: (ids) => ipcRenderer.invoke('nyx:bookmarks:remove-many', { ids }),

  /** 同级排序：{ id, direction: 'up' | 'down' } */
  move: (id, direction) => ipcRenderer.invoke('nyx:bookmarks:move', { id, direction }),

  /** 关闭管理窗口 */
  close: () => ipcRenderer.invoke('nyx:bm:manage-close'),
});
