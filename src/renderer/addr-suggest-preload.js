'use strict';

/**
 * 地址栏历史建议浮层的预加载脚本（addr-suggest.html 专用，v1.3.0 新增）。
 *
 * 浮层是独立无边框透明 BrowserWindow（sandbox 开启），不共享主窗口的 preload，
 * 这里只暴露最小能力：
 *   - onData：接收主进程推送的建议条目与主题；
 *   - onIndex：接收键盘导航后的高亮下标；
 *   - pick：鼠标点击某条建议（主进程在当前标签导航并收起浮层）；
 *   - hover：鼠标移入某条建议（把高亮同步回主进程，保证回车选中的是鼠标指向项）。
 *
 * 只读语义：本窗口不能导航、不能执行脚本、不接触 Node / ipcRenderer 本体。
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 主题前置：浮层窗口出现前先拿到主题，避免浅色主题下先闪一下深色。
 * 复用主窗口同一条 nyx:get-state 通道（返回快照里带 ui.theme）。
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

contextBridge.exposeInMainWorld('addrSuggest', {
  /** 订阅建议数据：{ items: [{ url, title, host }], index, theme } */
  onData: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:as:data', listener);
    return () => ipcRenderer.removeListener('nyx:as:data', listener);
  },

  /** 订阅高亮下标变化：{ index }（-1 表示无高亮） */
  onIndex: (handler) => {
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('nyx:as:index', listener);
    return () => ipcRenderer.removeListener('nyx:as:index', listener);
  },

  /** 点击某条建议：主进程在激活标签打开并收起浮层 */
  pick: (index) => ipcRenderer.invoke('nyx:as:pick', { index }),

  /** 鼠标移入某条建议：把高亮同步给主进程 */
  hover: (index) => ipcRenderer.invoke('nyx:as:hover', { index }),

  /** 展开某个站点的全部命中（v1.6.0 同站聚合折叠） */
  expand: (host) => ipcRenderer.invoke('nyx:as:expand', { host }),

  /** 切到已经打开该地址的标签（v1.8.0） */
  switchToTab: (url) => ipcRenderer.invoke('nyx:tabs:activate-by-url', { url }),

  /** 在打开了同一地址的多个标签间循环切换（v1.9.0） */
  cycleTab: (url) => ipcRenderer.invoke('nyx:tabs:cycle-by-url', { url }),

  /** 置顶 / 取消置顶某条建议（v1.11.0） */
  pin: (url, title) => ipcRenderer.invoke('nyx:as:pin-toggle', { url, title }),
});
