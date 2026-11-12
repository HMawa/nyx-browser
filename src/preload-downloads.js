'use strict';

/**
 * 下载中心窗口的预加载脚本（安全边界）。
 *
 * 这个窗口只做一件事：显示下载记录。所以暴露面只有下载相关方法，
 * 不复用主窗口那份巨大的 preload（那样等于把标签、代理、扩展的调用面
 * 都交给一个只用来列文件的窗口）。
 *
 * 约定：所有方法返回 {ok, ...} 结构，失败带中文 error，渲染层直接展示。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyxDownloads', {
  /** 全部记录 + 汇总（打开窗口时首屏拉一次） */
  list: () => ipcRenderer.invoke('nyx:downloads:list'),
  /** 清空已结束的记录（正在下载的不会被清掉） */
  clear: () => ipcRenderer.invoke('nyx:downloads:clear'),
  /** 在资源管理器中选中文件 */
  reveal: (payload) => ipcRenderer.invoke('nyx:downloads:reveal', payload || {}),
  /** 直接打开文件 */
  openFile: (payload) => ipcRenderer.invoke('nyx:downloads:open-file', payload || {}),
  /** 复制下载地址 */
  copyUrl: (payload) => ipcRenderer.invoke('nyx:downloads:copy-url', payload || {}),
  /** 打开保存目录 */
  openDir: () => ipcRenderer.invoke('nyx:downloads:open-dir'),
  /**
   * 订阅下载状态推送（进度 / 完成 / 失败 / 取消）。
   * @param {(payload:{items:Array<object>, summary:object})=>void} handler
   * @returns {() => void} 取消订阅
   */
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        handler(payload);
      } catch (err) {
        console.error('[Nyx] 下载状态回调异常：', err && err.message);
      }
    };
    ipcRenderer.on('nyx:downloads:state', listener);
    return () => ipcRenderer.removeListener('nyx:downloads:state', listener);
  },
});
