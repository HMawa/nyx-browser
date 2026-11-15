'use strict';

/**
 * IPC 发送方校验（安全审计 P1-5）。
 *
 * 审计结论：所有 `ipcMain.handle` 都不看 `event.senderFrame`。
 * 于是"谁在发这个请求"完全没有被验证——只要有一个页面能拿到 Nyx 的 preload，
 * 它就能调用整份接线（改设置、读历史、写 Cookie）。
 *
 * 本模块是纯逻辑：给定"发送方所在地址"与"允许的前缀"，回答放不放行。
 * 规则刻意做成白名单（失败关闭）：
 *   - 只认本项目 `src/renderer/` 下的本地页面（file: 协议）；
 *   - 必须是最外层文档（iframe 里的请求一律拒绝，避免嵌入内容借壳）；
 *   - 网络地址、`data:`、`about:`、读不出来的地址全部拒绝。
 */

const BLOCK_CODES = {
  SENDER_UNKNOWN: 'SENDER_UNKNOWN',
  SENDER_NOT_LOCAL: 'SENDER_NOT_LOCAL',
  SENDER_NOT_MAIN_FRAME: 'SENDER_NOT_MAIN_FRAME',
};

const BLOCK_MESSAGES = {
  SENDER_UNKNOWN: '这个请求没有可识别的来源，已拒绝（无法确认是 Nyx 自己的页面发起的）。',
  SENDER_NOT_LOCAL: '这个请求不是从 Nyx 自己的页面发起的，已拒绝。',
  SENDER_NOT_MAIN_FRAME: '这个请求来自嵌入的子框架，已拒绝（Nyx 只接受自己最外层页面的请求）。',
};

/**
 * @param {{url?: string, isMainFrame?: boolean, allowedPrefix?: string, allowedFiles?: string[]}} input
 * @returns {{ok: boolean, code?: string, error?: string}}
 */
function decideIpcSender(input) {
  const raw = input && typeof input.url === 'string' ? input.url.trim() : '';
  const prefix = input && typeof input.allowedPrefix === 'string' ? input.allowedPrefix : '';
  const isMainFrame = !input || input.isMainFrame !== false;

  if (!raw) return { ok: false, code: BLOCK_CODES.SENDER_UNKNOWN, error: BLOCK_MESSAGES.SENDER_UNKNOWN };
  if (!isMainFrame) {
    return { ok: false, code: BLOCK_CODES.SENDER_NOT_MAIN_FRAME, error: BLOCK_MESSAGES.SENDER_NOT_MAIN_FRAME };
  }
  if (!prefix || !raw.startsWith(prefix)) {
    return { ok: false, code: BLOCK_CODES.SENDER_NOT_LOCAL, error: BLOCK_MESSAGES.SENDER_NOT_LOCAL };
  }
  // 前缀之后必须还是一个 html 文件（不许 `../` 之类的相对跳跃，解码后再看一次）
  let tail = '';
  try {
    tail = decodeURIComponent(raw.slice(prefix.length));
  } catch {
    tail = raw.slice(prefix.length);
  }
  if (/\.\./.test(tail) || /[\\/]$/.test(tail) || !/^[A-Za-z0-9._-]+\.html(?:[?#].*)?$/.test(tail)) {
    return { ok: false, code: BLOCK_CODES.SENDER_NOT_LOCAL, error: BLOCK_MESSAGES.SENDER_NOT_LOCAL };
  }
  return { ok: true };
}

module.exports = { BLOCK_CODES, BLOCK_MESSAGES, decideIpcSender };
