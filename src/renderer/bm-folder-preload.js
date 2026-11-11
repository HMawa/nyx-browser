'use strict';

/**
 * 「收藏到文件夹」浮层的预加载脚本（bm-folder.html 专用，v1.5.0）。
 *
 * 浮层是独立无边框透明 BrowserWindow（sandbox 开启），不共享主窗口的 preload，
 * 这里只暴露最小能力：
 *   - onData：接收主进程推送的文件夹列表与待收藏页面；
 *   - pick：选中某个文件夹（或「新建文件夹并收藏…」）；
 *   - close：主动收起浮层。
 * 不开 nodeIntegration、不暴露 ipcRenderer 本体。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 主题前置：浮层跟随主窗口主题，避免浅色主题下先闪一下深色 */
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

contextBridge.exposeInMainWorld('bmFolder', {
  /** 订阅浮层数据：{ items: [{ id, title, depth, count }], url, title } */
  onData: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:bf:data', listener);
    return () => ipcRenderer.removeListener('nyx:bf:data', listener);
  },

  /**
   * 选中文件夹：folderId 为数字，'new' 表示新建文件夹后收藏（v1.7.0 可带 title 命名）。
   * v1.8.0：asParent 为真时，在该文件夹**下面**新建子文件夹再收藏（右键文件夹行触发）。
   */
  pick: (folderId, title, asParent) =>
    ipcRenderer.invoke('nyx:bookmarks:folder-pick', {
      folderId,
      title: title == null ? '' : String(title),
      asParent: asParent === true,
    }),

  /** 主动收起浮层（幂等） */
  close: () => ipcRenderer.invoke('nyx:bookmarks:folder-close'),

  /** 打开一条置顶建议（v1.13.0）：主进程在当前标签导航并收起浮层 */
  openUrl: (url) => ipcRenderer.invoke('nyx:bookmarks:folder-open-url', { url }),
});
