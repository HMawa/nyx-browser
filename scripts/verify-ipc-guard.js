'use strict';

/**
 * IPC 发送方校验回归（安全审计 P1-5）。
 * 纯 Node：把判定函数当成纯函数跑一遍，再核对主进程是不是真的把三个注册口都包上了。
 */

const fs = require('node:fs');
const path = require('node:path');
const { decideIpcSender, BLOCK_CODES, BLOCK_MESSAGES } = require('../src/core/ipc-guard');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`[Nyx] ✔ ${name}${detail ? `　｜${detail}` : ''}`);
  } else {
    failures.push(name);
    console.error(`[Nyx] ✘ ${name}${detail ? `　｜${detail}` : ''}`);
  }
}

const PREFIX = 'file:///D:/Nyx-src/src/renderer/';

const own = decideIpcSender({ url: `${PREFIX}index.html`, isMainFrame: true, allowedPrefix: PREFIX });
const settingsPage = decideIpcSender({ url: `${PREFIX}settings.html`, isMainFrame: true, allowedPrefix: PREFIX });
check(
  '1. Nyx 自己的本地页面放行（index.html / settings.html 等）',
  own.ok === true && settingsPage.ok === true,
  JSON.stringify({ own, settingsPage }),
);

const remote = decideIpcSender({ url: 'https://evil.example.com/x', isMainFrame: true, allowedPrefix: PREFIX });
const fileOther = decideIpcSender({ url: 'file:///C:/Windows/win.ini', isMainFrame: true, allowedPrefix: PREFIX });
const dataUrl = decideIpcSender({ url: 'data:text/html,<b>x</b>', isMainFrame: true, allowedPrefix: PREFIX });
const about = decideIpcSender({ url: 'about:blank', isMainFrame: true, allowedPrefix: PREFIX });
check(
  '2. 网络地址、别处的 file://、data:、about: 一律拒绝（失败关闭）',
  [remote, fileOther, dataUrl, about].every((item) => item.ok === false && item.code === BLOCK_CODES.SENDER_NOT_LOCAL),
  JSON.stringify({ remote, fileOther, dataUrl, about }),
);

const traversal = decideIpcSender({ url: `${PREFIX}../main.js`, isMainFrame: true, allowedPrefix: PREFIX });
const nonHtml = decideIpcSender({ url: `${PREFIX}settings.css`, isMainFrame: true, allowedPrefix: PREFIX });
check(
  '3. 前缀之后的路径必须还是个 html：`../` 与 css/js 之类都拒绝',
  traversal.ok === false && nonHtml.ok === false,
  JSON.stringify({ traversal, nonHtml }),
);

const iframe = decideIpcSender({ url: `${PREFIX}index.html`, isMainFrame: false, allowedPrefix: PREFIX });
check(
  '4. 子框架（iframe）的请求拒绝，即便是同一份页面',
  iframe.ok === false && iframe.code === BLOCK_CODES.SENDER_NOT_MAIN_FRAME,
  JSON.stringify(iframe),
);

const unknown = decideIpcSender({ url: '', isMainFrame: true, allowedPrefix: PREFIX });
const noPrefix = decideIpcSender({ url: `${PREFIX}index.html`, isMainFrame: true, allowedPrefix: '' });
check(
  '5. 认不出来源、或者没给允许前缀时都拒绝（不猜）',
  unknown.ok === false && noPrefix.ok === false && unknown.code === BLOCK_CODES.SENDER_UNKNOWN,
  JSON.stringify({ unknown, noPrefix }),
);

check(
  '6. 拒绝原因都是能直接给用户看的中文（不是错误码堆砌）',
  Object.values(BLOCK_MESSAGES).every((text) => /[\u4e00-\u9fa5]/.test(text) && text.length >= 12),
  JSON.stringify(Object.keys(BLOCK_MESSAGES)),
);

const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const installed = /function installIpcSenderGuard\(\)/.test(mainSrc);
const wrapsHandle = /ipcMain\.handle = \(channel, listener\) =>/.test(mainSrc);
const wrapsOn = /ipcMain\.on = wrapEvented\(rawOn\)/.test(mainSrc);
const wrapsOnce = /ipcMain\.once = wrapEvented\(rawOnce\)/.test(mainSrc);
const calledEarly = /function registerIpc\(\) \{\s*\n\s*installIpcSenderGuard\(\);/.test(mainSrc);
check(
  '7. 主进程把 handle / on / once 三个注册口都包上了，并在注册 IPC 的第一步安装',
  installed && wrapsHandle && wrapsOn && wrapsOnce && calledEarly,
  JSON.stringify({ installed, wrapsHandle, wrapsOn, wrapsOnce, calledEarly }),
);

const pageChannels = /const PAGE_CONTEXT_CHANNELS = new Set\(\[/.test(mainSrc);
const pageChannelList = ['nyx:tab:config', 'nyx:vault:has', 'nyx:vault:fill', 'nyx:forms:save', 'nyx:forms:load'].every((channel) =>
  mainSrc.includes(`'${channel}'`),
);
const deniesLogged = /IPC_SENDER_BLOCKED/.test(mainSrc) && /sendSync 必须回填 returnValue/.test(mainSrc);
check(
  '8. 页面上下文通道（标签配置 / 密码库 / 表单）单独列出，且仍然只收最外层；拦下有日志、sendSync 会回填 returnValue',
  pageChannels && pageChannelList && deniesLogged,
  JSON.stringify({ pageChannels, pageChannelList, deniesLogged }),
);

const guard = require('../src/core/ipc-guard');
check(
  '9. 守卫模块保持纯逻辑（不发请求、不读盘、不引 Electron）',
  !/require\('electron'\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'core', 'ipc-guard.js'), 'utf8')) &&
    typeof guard.decideIpcSender === 'function',
  'module.exports.decideIpcSender',
);

// 10. P1-5 的第二半：vault / forms 的站点标识必须取自发送方文档，不信 payload 自称
check(
  '10. 密码与表单按「发送方文档的 origin」隔离，不再信 payload 里自称的 origin（P1-5）',
  (() => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const start = main.indexOf('function safeOrigin(');
    if (start < 0) return false;
    const fn = main.slice(start, start + 900);
    const usesFrame = /event\.senderFrame/.test(fn) && /new URL\(frameUrl\)/.test(fn);
    // payload 只在拿不到发送方地址时兜底
    const payloadIsFallback = fn.indexOf('event.senderFrame') < fn.indexOf('payload && payload.origin');
    const callers = (main.match(/safeOrigin\(payload, event\)/g) || []).length;
    return usesFrame && payloadIsFallback && callers >= 6;
  })(),
);

console.log('');
const total = passed + failures.length;
console.log(`IPC 发送方校验：${total} 项检查，${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const name of failures) console.error(`  ✘ ${name}`);
  process.exitCode = 1;
}
