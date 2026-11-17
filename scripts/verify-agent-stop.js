'use strict';

/**
 * agent 急停快捷键回归：纯 Node，不启动 Electron。
 *
 * 背景：`CommandOrControl+Alt+X` 在本机被别的程序占着，注册失败时原来只在日志里
 * 留一句——用户以为有热键、按下去没反应。现在改成按顺序试备用键，换了就当面说。
 *
 * 这里覆盖两件事：
 *   1. 候选与文案的纯逻辑（顺序、去重、空值、换键提示、全失败提示）；
 *   2. 主进程真的接上了（循环注册、记 effective、三处状态都读 effective 而不是常量）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const shortcut = require(path.join(ROOT, 'src', 'core', 'agent-shortcut.js'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? '✔' : '✘';
  console.log(`  ${mark} ${name}${detail ? '｜' + detail : ''}`);
}

function main() {
  console.log('[验证] agent 急停快捷键回归');

  // ---- 候选与文案（纯逻辑）----
  const list = shortcut.shortcutCandidates('CommandOrControl+Alt+X');
  check(
    '首选在最前，后面跟着备用键（快捷键被占用时才有得退）',
    list[0] === 'CommandOrControl+Alt+X' && list.length >= 2,
    JSON.stringify(list),
  );
  check(
    '候选去重：同一个键写两遍只留一个',
    shortcut.shortcutCandidates('Ctrl+X', ['Ctrl+X', 'Ctrl+Y']).length === 2,
    JSON.stringify(shortcut.shortcutCandidates('Ctrl+X', ['Ctrl+X', 'Ctrl+Y'])),
  );
  check(
    '空候选会被丢掉，不会注册一个空字符串',
    shortcut.shortcutCandidates('', ['', 'Ctrl+Y']).length === 1 &&
      shortcut.shortcutCandidates('', ['', 'Ctrl+Y'])[0] === 'Ctrl+Y',
    JSON.stringify(shortcut.shortcutCandidates('', ['', 'Ctrl+Y'])),
  );
  check(
    '候选数量有上限，不会无限试',
    shortcut.shortcutCandidates('A', ['B', 'C', 'D', 'E', 'F']).length <= shortcut.MAX_CANDIDATES,
    JSON.stringify(shortcut.shortcutCandidates('A', ['B', 'C', 'D', 'E', 'F'])),
  );

  const preferredOk = shortcut.describeShortcutResult({
    preferred: 'CommandOrControl+Alt+X',
    effective: 'CommandOrControl+Alt+X',
    tried: ['CommandOrControl+Alt+X'],
  });
  check(
    '首选就注册成功：不提示、不告警，只说现在用的是哪个',
    preferredOk.ok === true && preferredOk.code === 'PREFERRED' && preferredOk.notice === null,
    JSON.stringify(preferredOk),
  );

  const fallback = shortcut.describeShortcutResult({
    preferred: 'CommandOrControl+Alt+X',
    effective: 'CommandOrControl+Alt+Shift+X',
    tried: ['CommandOrControl+Alt+X', 'CommandOrControl+Alt+Shift+X'],
  });
  check(
    '换成备用键：明确告诉用户在按下哪个键（而不是继续宣传旧键）',
    fallback.ok === true &&
      fallback.code === 'FALLBACK' &&
      fallback.notice &&
      fallback.notice.title.includes('CommandOrControl+Alt+Shift+X') &&
      fallback.message.includes('CommandOrControl+Alt+Shift+X'),
    JSON.stringify({ code: fallback.code, notice: fallback.notice && fallback.notice.title }),
  );

  const none = shortcut.describeShortcutResult({
    preferred: 'CommandOrControl+Alt+X',
    effective: '',
    tried: ['CommandOrControl+Alt+X', 'CommandOrControl+Alt+Shift+X'],
  });
  check(
    '一个都注册不上：说明只剩工具栏按钮，而不是假装有热键',
    none.ok === false &&
      none.code === 'NONE' &&
      none.notice &&
      /按钮/.test(none.notice.message) &&
      /试过/.test(none.message),
    JSON.stringify({ code: none.code, message: none.message }),
  );

  // ---- 主进程接线（静态守卫）----
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check(
    '主进程按候选列表逐个尝试注册，不是只试一个',
    /const candidates = shortcutCandidates\(AGENT_STOP_SHORTCUT\);/.test(mainSrc) &&
      /for \(const candidate of candidates\) \{/.test(mainSrc) &&
      /globalShortcut\.register\(candidate,/.test(mainSrc),
    'main.js 里应有 candidates 循环',
  );
  check(
    '注册成功的那个会被记下来，三处状态都读它',
    /runtime\.agentStopShortcut = effective;/.test(mainSrc) &&
      (mainSrc.match(/stopShortcut: runtime\.agentStopShortcut \|\| AGENT_STOP_SHORTCUT,/g) || []).length === 3,
    JSON.stringify({ hits: (mainSrc.match(/stopShortcut: runtime\.agentStopShortcut \|\| AGENT_STOP_SHORTCUT,/g) || []).length }),
  );
  check(
    '换成备用键与全部失败都有诊断留痕，并且当面提示',
    /AGENT_STOP_SHORTCUT_FALLBACK/.test(mainSrc) &&
      /AGENT_STOP_SHORTCUT_FAILED/.test(mainSrc) &&
      /if \(verdict\.notice\) \{/.test(mainSrc) &&
      /notifyNotice\(\{ level: verdict\.ok \? 'warn' : 'error'/.test(mainSrc),
    'main.js 里应有 FALLBACK / FAILED 两条诊断与 notice',
  );

  // 恐慌清场是同一类缺陷：默默失效比没有更危险，所以也走候选列表
  check(
    '恐慌清场快捷键也按候选列表尝试，备用键与 agent 急停错开',
    /const PANIC_FALLBACKS = \[/.test(mainSrc) &&
      /const candidates = shortcutCandidates\(PANIC_SHORTCUT, PANIC_FALLBACKS\);/.test(mainSrc) &&
      /globalShortcut\.register\(candidate, \(\) => panic\(\)\);/.test(mainSrc) &&
      /PANIC_SHORTCUT_FALLBACK/.test(mainSrc) &&
      /PANIC_SHORTCUT_FAILED/.test(mainSrc),
    'main.js 里应有 PANIC_FALLBACKS 与 panic 的候选循环',
  );
  check(
    '启动横幅与托盘菜单显示的是"实际注册上的"键，不是配置里那个',
    /恐慌快捷键：\$\{runtime\.panicShortcut \|\| '（注册失败）'\}/.test(mainSrc) &&
      /label: `恐慌清场（\$\{runtime\.panicShortcut \|\| PANIC_SHORTCUT\}）`/.test(mainSrc),
    '横幅与托盘都要读 runtime.panicShortcut',
  );

  const failed = checks.filter((item) => !item.ok);
  console.log('');
  if (failed.length) {
    console.log(`[验证] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
    for (const item of failed) console.log(`  · 失败项：${item.name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[验证] agent 急停快捷键全部通过：共 ${checks.length} 项`);
}

main();
