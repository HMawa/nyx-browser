'use strict';

/**
 * 外壳导航守卫（安全审计 P0-1）
 *
 * 背景：UI 外壳（`src/renderer/index.html`）的 preload 暴露了整份 `window.nyx`
 * （两百多个方法：读 Cookie、读历史、改站点信任名单、抓包、执行脚本……）。
 * 一旦外壳被导航到别处（远程页、本地任意 file://、javascript: 伪协议），
 * 那个页面就拿到了整份接口——等于把浏览器内部权限交给任意网页。
 *
 * 所以这里只留一条规则：**外壳只能待在自己的那份文档上**，任何其他目标一律拒绝。
 * 判定刻意写成纯函数，主进程只负责调它 + 记日志 + 给用户可见提示，
 * 这样"该不该放行"有断言可测，不靠读代码猜。
 */

function parseUrl(raw) {
  try {
    return new URL(String(raw == null ? '' : raw));
  } catch {
    return null;
  }
}

/** 归一化路径：Windows 下大小写不敏感，且要统一 / 与 %20 这类写法 */
function normalizePath(pathname) {
  let value = String(pathname || '');
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 解不开就按原样比，反正已经是不常见的情况 */
  }
  value = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function describeTarget(raw) {
  const parsed = parseUrl(raw);
  if (!parsed) return { ok: false, scheme: '', host: '', path: '' };
  return {
    ok: true,
    scheme: String(parsed.protocol || '').toLowerCase(),
    host: String(parsed.host || '').toLowerCase(),
    path: normalizePath(parsed.pathname),
  };
}

/**
 * 外壳窗口自己发起的导航（will-navigate / will-redirect）该不该放行。
 * 只有「同一个 file: 主机 + 同一份 html」才算自己。
 */
function decideShellNavigation(input) {
  const target = describeTarget(input && input.targetUrl);
  const shell = describeTarget(input && input.shellUrl);
  if (!shell.ok || !shell.path) {
    // 连自己的地址都不知道，只能一律拒绝：宁可外壳卡住，也不放行任何外来页面
    return {
      allow: false,
      code: 'SHELL_URL_UNKNOWN',
      reason: '外壳自身地址读不出来，这次导航被拒绝。',
    };
  }
  if (!target.ok) {
    return {
      allow: false,
      code: 'BLOCK_UNPARSABLE',
      reason: '这个地址解析不出来，导航被拒绝。',
    };
  }
  if (target.scheme !== 'file:') {
    return {
      allow: false,
      code: 'BLOCK_REMOTE',
      reason: '外壳不允许导航到网络地址；要打开网页请用标签页。',
    };
  }
  if (target.host !== shell.host) {
    return {
      allow: false,
      code: 'BLOCK_OTHER_HOST',
      reason: '外壳不允许跳转到别的 file: 主机。',
    };
  }
  if (target.path !== shell.path) {
    // 哪怕同目录下另一份 html 也不行：那份页面同样拿得到 window.nyx
    return {
      allow: false,
      code: 'BLOCK_OTHER_FILE',
      reason: '外壳只允许停留在自己这份文档上；要打开本地文件请用标签页。',
    };
  }
  return { allow: true, code: 'ALLOW_SELF', reason: '外壳文档自身。' };
}

/**
 * 外壳里点链接 / 弹窗（setWindowOpenHandler）该怎么处理。
 * 只放行 http(s)，交给标签系统打开；其它（file:、javascript:、data:、about:）一律不接。
 */
function decideShellWindowOpen(input) {
  const target = describeTarget(input && input.url);
  if (!target.ok) {
    return { allow: false, code: 'BLOCK_UNPARSABLE', reason: '这个地址解析不出来，没有打开。' };
  }
  if (target.scheme === 'http:' || target.scheme === 'https:') {
    return { allow: true, code: 'OPEN_IN_TAB', reason: '交给标签页打开。' };
  }
  return {
    allow: false,
    code: 'BLOCK_SCHEME',
    reason: `外壳里的弹窗只接受网页地址，${target.scheme || '这个协议'} 没有打开。`,
  };
}

/** 外壳里不允许挂 webview（套娃等于绕过标签系统的所有策略） */
function describeAttachBlock() {
  return { allow: false, code: 'BLOCK_WEBVIEW', reason: '外壳不允许内嵌 webview。' };
}

module.exports = {
  describeTarget,
  decideShellNavigation,
  decideShellWindowOpen,
  describeAttachBlock,
};
