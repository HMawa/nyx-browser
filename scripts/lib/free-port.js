'use strict';

/**
 * 让操作系统分配一个真正可用的本地端口。
 *
 * 为什么需要这个：
 * 验收脚本原先用「固定基数 + Math.random()」挑调试端口，本机 Windows 会保留
 * 一批动态端口段（`netsh int ipv4 show excludedportrange protocol=tcp`，实测含
 * 9486–9585，属 Hyper-V / WinNAT 占位）。一旦随机命中保留段，Chromium 起调试
 * 服务时直接报
 *   bind() returned an error: 以一种访问权限不允许的方式做了一个访问套接字的尝试 (0x271D)
 *   Cannot start http server for devtools.
 * 表现为「主窗口外壳页面出现 ✘／主窗口未就绪」这类假失败，而且概率约三分之一，
 * 极易被误判成产品 bug。
 *
 * 做法：向 127.0.0.1:0 监听，拿系统分配的端口后立即关闭。系统不会把自己保留的
 * 端口分配给我们，因此拿到的端口一定可绑定。关闭到子进程重新监听之间有一个极
 * 短的窗口期，实践中足够安全（脚本重启应用时也不会挑到同一端口两次）。
 */

const net = require('net');

/**
 * @returns {Promise<number>} 可用的本地 TCP 端口
 */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('未能从系统分配到可用端口'));
      });
    });
  });
}

module.exports = { pickFreePort };
