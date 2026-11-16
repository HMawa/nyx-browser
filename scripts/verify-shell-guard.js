'use strict';

/**
 * 外壳导航守卫回归（安全审计 P0-1）
 *
 * 纯 Node，不启动 Electron：判定逻辑全在 src/core/shell-guard.js，
 * 这里既测判定，也测「主进程真的把它接上了」。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const guard = require(path.join(ROOT, 'src', 'core', 'shell-guard.js'));

const SHELL_URL = 'file:///D:/Nyx-src/src/renderer/index.html';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✘ ${name}\n    ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// 1. 外壳自己的文档放行（这是唯一被允许的目标）
check('外壳自己那份文档允许导航（唯一放行项）', () => {
  const verdict = guard.decideShellNavigation({ targetUrl: SHELL_URL, shellUrl: SHELL_URL });
  assert(verdict.allow === true, `应当放行，实际 ${verdict.code}`);
  assert(verdict.code === 'ALLOW_SELF', `code 应为 ALLOW_SELF，实际 ${verdict.code}`);
  // 大小写不同的同一路径（Windows 下全路径归一化到小写）也要放行
  const upper = guard.decideShellNavigation({
    targetUrl: 'file:///D:/Nyx-src/src/renderer/INDEX.HTML',
    shellUrl: SHELL_URL,
  });
  assert(upper.allow === true, '同一份文档只是大小写不同，应当放行');
});

// 2. 网络地址一律拒绝（审计里的实测攻击路径就是这一条）
check('网络地址拒绝：http(s) 与伪协议都进不来', () => {
  for (const url of [
    'http://127.0.0.1:17332/evil.html',
    'https://example.com/',
    'javascript:alert(1)',
    'data:text/html,<script>location="http://x"</script>',
    'about:blank',
  ]) {
    const verdict = guard.decideShellNavigation({ targetUrl: url, shellUrl: SHELL_URL });
    assert(verdict.allow === false, `${url} 应当被拒`);
    assert(verdict.code === 'BLOCK_REMOTE', `${url} 的 code 应为 BLOCK_REMOTE，实际 ${verdict.code}`);
    assert(/标签页|不允许/.test(verdict.reason), `${url} 的说明要讲清替代做法：${verdict.reason}`);
  }
});

// 3. 同目录下的别的本地页面也不行（它们同样拿得到 window.nyx）
check('同目录的其它本地页面也要拒绝（不是只拦远程）', () => {
  const verdict = guard.decideShellNavigation({
    targetUrl: 'file:///D:/Nyx-src/src/renderer/onboard.html',
    shellUrl: SHELL_URL,
  });
  assert(verdict.allow === false, '别的 html 应当被拒');
  assert(verdict.code === 'BLOCK_OTHER_FILE', `应为 BLOCK_OTHER_FILE，实际 ${verdict.code}`);
});

// 4. 别的 file: 主机（UNC）与解析不出来的地址
check('UNC 路径与读不懂的地址都拒绝', () => {
  const unc = guard.decideShellNavigation({
    targetUrl: 'file://server/share/index.html',
    shellUrl: SHELL_URL,
  });
  assert(unc.allow === false && unc.code === 'BLOCK_OTHER_HOST', `UNC 应为 BLOCK_OTHER_HOST，实际 ${unc.code}`);
  const broken = guard.decideShellNavigation({ targetUrl: 'not a url', shellUrl: SHELL_URL });
  assert(broken.allow === false && broken.code === 'BLOCK_UNPARSABLE', `坏地址应为 BLOCK_UNPARSABLE，实际 ${broken.code}`);
});

// 5. 不知道自己是谁时一律拒绝（失败关闭，而不是失败放行）
check('外壳自身地址读不出来时一律拒绝（失败关闭）', () => {
  const verdict = guard.decideShellNavigation({ targetUrl: SHELL_URL, shellUrl: '' });
  assert(verdict.allow === false, '应当拒绝');
  assert(verdict.code === 'SHELL_URL_UNKNOWN', `应为 SHELL_URL_UNKNOWN，实际 ${verdict.code}`);
});

// 6. 外壳里的弹窗：只放行网页，交给标签系统
check('外壳弹窗只放行 http(s)，其余协议明确拒绝', () => {
  const ok = guard.decideShellWindowOpen({ url: 'https://example.com/a' });
  assert(ok.allow === true && ok.code === 'OPEN_IN_TAB', `https 应放行，实际 ${ok.code}`);
  assert(guard.decideShellWindowOpen({ url: 'http://127.0.0.1:8000/' }).allow === true, 'http 也应放行');
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'about:blank']) {
    const blocked = guard.decideShellWindowOpen({ url });
    assert(blocked.allow === false, `${url} 应当被拒`);
    assert(/没有打开/.test(blocked.reason), `${url} 的说明要讲清楚：${blocked.reason}`);
  }
});

// 7. 外壳不许内嵌 webview
check('外壳不许挂 webview', () => {
  const verdict = guard.describeAttachBlock();
  assert(verdict.allow === false && verdict.code === 'BLOCK_WEBVIEW', '应当拒绝内嵌 webview');
});

// 8. 主进程接线：三种导航事件都挂上了
check('主进程接线：will-navigate / will-redirect / will-attach-webview 都在主窗口上', () => {
  const main = read('src/main.js');
  assert(
    /decideShellNavigation,[\s\S]{0,120}require\('\.\/core\/shell-guard'\)/.test(main),
    'main.js 应当 require shell-guard 的判定函数'
  );
  assert(/pathToFileURL\(path\.join\(__dirname, 'renderer', 'index\.html'\)\)\.href/.test(main), '应当算出外壳自己的地址');
  assert(/win\.loadURL\(shellUrl\)/.test(main), '应当用同一个地址加载外壳（比对的地址必须就是加载的地址）');
  assert(!/win\.loadFile\(path\.join\(__dirname, 'renderer', 'index\.html'\)\)/.test(main), '不应再留着 loadFile 的旧写法');
  assert(/win\.webContents\.on\('will-navigate', blockShellNav\('will-navigate'\)\)/.test(main), '缺 will-navigate 守卫');
  assert(/win\.webContents\.on\('will-redirect', blockShellNav\('will-redirect'\)\)/.test(main), '缺 will-redirect 守卫');
  assert(/win\.webContents\.on\('will-attach-webview'/.test(main), '缺 will-attach-webview 守卫');
  assert(/event\.preventDefault\(\)/.test(main), '拦下时必须 preventDefault');
});

// 9. 主进程接线：拦下要留痕 + 让用户看见（红线 2）
check('拦下之后要记日志、也要给用户看得见的提示', () => {
  const main = read('src/main.js');
  assert(/SHELL_NAV_BLOCKED/.test(main), '缺 SHELL_NAV_BLOCKED 诊断码');
  assert(/SHELL_WEBVIEW_BLOCKED/.test(main), '缺 SHELL_WEBVIEW_BLOCKED 诊断码');
  assert(/SHELL_WINDOW_OPEN_BLOCKED/.test(main), '缺 SHELL_WINDOW_OPEN_BLOCKED 诊断码');
  assert(/外壳想跳转到别处，已被拦下/.test(main), '缺中文提示');
  assert(/notifyNotice\(\{[\s\S]{0,120}level: 'warn'/.test(main), '应当用 warn 级提示告知用户');
  assert(/redactUrlForLog\(target\)/.test(main), '日志里的地址要先脱敏');
});

// 10. 弹窗处理不再无条件 openInNewTab（先判协议）
check('弹窗处理器先判协议再交给标签系统', () => {
  const main = read('src/main.js');
  // 主进程里有多个窗口的 setWindowOpenHandler，这里只看主窗口那一个
  const start = main.indexOf('function createMainWindow()');
  assert(start > 0, '找不到 createMainWindow');
  const at = main.indexOf('setWindowOpenHandler', start);
  assert(at > 0, '主窗口没有 setWindowOpenHandler');
  const block = main.slice(at, at + 900);
  assert(/decideShellWindowOpen\(\{ url \}\)/.test(block), '应当先调 decideShellWindowOpen');
  assert(block.indexOf('decideShellWindowOpen') < block.indexOf('openInNewTab'), '判定必须在 openInNewTab 之前');
});

// 11. 守卫模块自己不碰网络、不读盘（纯判定）
check('守卫模块保持纯逻辑（不发请求、不读文件）', () => {
  const source = read('src/core/shell-guard.js');
  assert(!/require\('node:fs'\)|require\('node:https?'\)|fetch\(/.test(source), '守卫模块不应读盘或发请求');
});

// 12. 历史 API 逃逸（N4）：pushState 换个地址再 reload，就能让外壳跑在别的 origin 上
check('历史记录守卫脚本会拦住跨源 pushState/replaceState，放行外壳自己那份地址', () => {
  const script = guard.buildHistoryGuardScript('file:///D:/app/renderer/index.html');
  assert(/pushState/.test(script) && /replaceState/.test(script), '守卫脚本应同时接管 pushState 与 replaceState');
  assert(/index\.html/.test(script), '守卫脚本里应带上"允许的那份地址"');
  assert(/console\.warn/.test(script) && /return undefined/.test(script), '被拒时要拦住这次写入并留一句警告，而不是照写下去');
  const allow = guard.decideShellEscape({ shellUrl: 'file:///D:/app/renderer/index.html', targetUrl: 'file:///D:/app/renderer/index.html' });
  assert(allow.escaped === false, '外壳自己的地址应判为安全');
  const escape = guard.decideShellEscape({ shellUrl: 'file:///D:/app/renderer/index.html', targetUrl: 'https://evil.example/x' });
  assert(escape.escaped === true && escape.code, '换了 origin 应判为逃逸并给出错误码');
  const other = guard.decideShellEscape({ shellUrl: 'file:///D:/app/renderer/index.html', targetUrl: 'file:///D:/app/renderer/other.html' });
  assert(other.escaped === true, '同目录别的 html 也算逃逸');
});

// 13. 主进程真的装上了两层保险（静态接线守卫）
check('主进程装上历史守卫并在导航后兜底一次（N4 接线）', () => {
  const main = read('src/main.js');
  assert(/executeJavaScript\(buildHistoryGuardScript\(shellUrl\)/.test(main), 'did-finish-load 里应执行历史守卫脚本');
  assert(/did-navigate'/.test(main) && /SHELL_ESCAPED/.test(main), '应在导航落地后兜底并留痕');
  assert(!/on\('did-start-navigation'/.test(main), '不要在导航刚开始时抢先 reload（会打断自己的 CDP 会话）');
  assert(/win\.loadURL\(shellUrl\)/.test(main), '发现逃逸后应把外壳拉回自己那份地址');
});

console.log('');
if (failed === 0) {
  console.log(`[Nyx] 外壳导航守卫回归通过（${passed} 项）`);
  process.exit(0);
}
console.error(`[Nyx] 外壳导航守卫回归未通过：${failed} 项失败 / 共 ${passed + failed} 项`);
process.exit(1);
