'use strict';

/**
 * 书签下拉浮层窗口的预加载脚本（bm-menu.html 专用）。
 *
 * 浮层是独立无边框 BrowserWindow（sandbox 开启），不共享主窗口的 preload，
 * 这里单独暴露最小能力：
 *   - onData：接收主进程推送的浮层数据（递归子项 + 层级）；
 *   - navigate：浮层内点击书签后，让主进程在激活标签打开 URL 并自动关闭浮层；
 *   - close：主动关闭浮层。
 * 不开 nodeIntegration、不暴露 ipcRenderer 本体。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 主题前置：浮层也要跟随主窗口主题（深浅底色一致），
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

contextBridge.exposeInMainWorld('bmMenu', {
  /** 订阅主进程推送的浮层数据：{ items: [{ title, url?, depth, folder? }] } */
  onData: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:bm:data', listener);
    return () => ipcRenderer.removeListener('nyx:bm:data', listener);
  },

  /** 浮层内点击书签：主进程在激活标签 navigate 打开 URL，并自动关闭浮层 */
  navigate: (url) => ipcRenderer.invoke('nyx:bm:menu-navigate', { url }),

  /** 主动关闭浮层（幂等） */
  close: () => ipcRenderer.invoke('nyx:bm:menu-close'),
});
