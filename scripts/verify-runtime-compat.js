#!/usr/bin/env node
/**
 * 运行时兼容回归（Electron 43 → 45 升级带出来的那一类问题）。
 *
 * 为什么单独一个脚本：Electron 主版本升级改的不是我们的代码，而是我们**依赖的 API 形状**——
 * `clipboard.readText()` 从同步返回字符串变成返回 Promise，`availableFormats()` 直接消失。
 * 这类变化编译器不管、单元测试不覆盖，只能靠"对着源码问一遍"的静态断言兜住。
 * 每加一条断言都对应一次真实踩坑，不是想象出来的风险。
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];

function check(label, fn) {
  try {
    fn();
    checks.push({ label, ok: true });
    console.log(`  ✔ ${label}`);
  } catch (err) {
    checks.push({ label, ok: false, error: err && err.message });
    console.log(`  ✘ ${label}｜${err && err.message}`);
  }
}

/** 取一段函数体（从 `function name(` 起，到下一个顶格 `}` 为止） */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

check('1. 剪贴板只在兼容层里碰：readText / writeText 各只有一处原语', () => {
  const main = read('src/main.js');
  // 注释里的调用示范不算调用点（这个坑踩过一次：注释里写了 `clipboard.readText()` 就数成 3 处）
  const code = main
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
  const reads = code.match(/clipboard\.readText\s*\(/g) || [];
  const writes = code.match(/clipboard\.writeText\s*\(/g) || [];
  // 读、写各留一个原语：探测 / 读取 / 写入三个入口都从原语走，
  // 这样"运行时形状变了"只可能发生在兼容层里，别处不可能绕过。
  assert.equal(reads.length, 1, `clipboard.readText() 只应有一个原语调用点，实际 ${reads.length} 处`);
  assert.equal(writes.length, 1, `clipboard.writeText() 只应有一个原语调用点，实际 ${writes.length} 处`);
  for (const name of ['rawClipboardRead', 'rawClipboardWrite', 'readClipboardText', 'writeClipboardText']) {
    assert.ok(main.includes(`function ${name}(`), `缺少兼容层函数 ${name}`);
  }
  const probe = functionBody(main, 'probeClipboardShape');
  assert.ok(/rawClipboardRead\(\)/.test(probe), '探测必须走原语，不许再直接碰 clipboard');
});

check('2. 兼容层真的处理了两种形状（字符串 / Promise）', () => {
  const main = read('src/main.js');
  const body = functionBody(main, 'readClipboardText');
  assert.ok(body, '找不到 readClipboardText');
  assert.ok(/typeof value\.then === 'function'/.test(body), '必须判断返回值是不是 Promise');
  assert.ok(/await value/.test(body), '是 Promise 就要 await');
  assert.ok(/typeof text === 'string'/.test(body), '最终必须落成字符串，不能把对象往下传');
});

check('3. 地址栏建议是异步算的，并且先刷剪贴板缓存', () => {
  const main = read('src/main.js');
  assert.ok(main.includes('async function queryAddressSuggest('), 'queryAddressSuggest 必须是 async');
  const body = functionBody(main, 'queryAddressSuggest');
  assert.ok(/await refreshClipboardCache\(/.test(body), '算命中之前要先刷新剪贴板缓存');
  assert.ok(/cachedClipboardUrl\(\)/.test(body), '应当用缓存值参与匹配');
  assert.ok(/refreshClipboardCache/.test(main) && /minIntervalMs/.test(main), '刷新要带节流，不能每敲一个字都读盘');
});

check('4. 复制类 IPC 都是 async 且回读走了兼容层（不许拿 [object Promise] 做 .includes）', () => {
  const main = read('src/main.js');
  for (const channel of ['nyx:error:copy', 'nyx:digest:copy']) {
    const idx = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(idx > 0, `缺少 ${channel}`);
    const head = main.slice(idx, idx + 120);
    assert.ok(/async \(/.test(head), `${channel} 必须是 async handler`);
    const body = main.slice(idx, idx + 1600);
    assert.ok(/await writeClipboardText\(/.test(body), `${channel} 写入要走兼容层`);
    assert.ok(/await readClipboardText\(/.test(body), `${channel} 回读要走兼容层`);
  }
});

check('5. 那些"顺手复制"的 IPC 也走兼容层（否则在 45 上会静默没写进去）', () => {
  const main = read('src/main.js');
  for (const channel of [
    'nyx:tb:copy',
    'nyx:downloads:copy-url',
    'nyx:update:copy-clean-command',
  ]) {
    const idx = main.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(idx > 0, `缺少 ${channel}`);
    const body = main.slice(idx, idx + 900);
    assert.ok(/writeClipboardText\(/.test(body), `${channel} 应当调用 writeClipboardText()`);
    assert.ok(!/clipboard\.writeText\(/.test(body), `${channel} 不许直接调 clipboard.writeText()`);
  }
});

check('6. 版本相关的事实与运行时一致（升级必须同时改三处）', () => {
  const pkg = JSON.parse(read('package.json'));
  const baseline = require(path.join(ROOT, 'src/core/security-baseline.js'));
  assert.equal(
    baseline.RUNTIME_BASELINE.electron,
    pkg.devDependencies.electron,
    `安全基线声明 ${baseline.RUNTIME_BASELINE.electron} 与 package.json 的 ${pkg.devDependencies.electron} 不一致`,
  );
  assert.ok(!/[\^~]/.test(pkg.devDependencies.electron), 'electron 版本必须钉死，不能带 ^ 或 ~');
  const doc = read('docs/Nyx-安全基线-C2-CVE对照.md');
  assert.ok(doc.includes(`\`${baseline.RUNTIME_BASELINE.chromium}\``), '文档里的 Chromium 版本要与基线一致');
  assert.ok(doc.includes(`\`${baseline.RUNTIME_BASELINE.node}\``), '文档里的 Node 版本要与基线一致');
});

check('7. 启动时探测剪贴板 API 形状，退化会如实记诊断（不许安静地兼容过去）', () => {
  const main = read('src/main.js');
  assert.ok(main.includes('async function probeClipboardShape('), '缺少 probeClipboardShape');
  const body = functionBody(main, 'probeClipboardShape');
  assert.ok(/typeof value\.then === 'function'/.test(body), '探测要判断返回值是不是 Promise');
  assert.ok(/CLIPBOARD_API_SHAPE/.test(body), '探测结果要记诊断（CLIPBOARD_API_SHAPE）');
  assert.ok(/diagnostics\.warn\(\s*'CLIPBOARD_API_SHAPE'/.test(body), '退回同步形状时必须 warn，不能只 info');
  assert.ok(/diagnostics\.info\(\s*'CLIPBOARD_API_SHAPE'/.test(body), '异步形状（正常）也要留一条 info 作基线');
  // 必须在启动流程里真的被调用，否则探测函数写得再好也不会执行
  const bootAt = main.indexOf('async function bootstrap()');
  assert.ok(bootAt > 0, '找不到 bootstrap');
  const boot = main.slice(bootAt, bootAt + 600);
  assert.ok(/probeClipboardShape\(\)/.test(boot), 'bootstrap 里必须真的调用探测');
});

check('8. 运行时退回同步剪贴板时，读路径会（且只会）警告一次', () => {
  const main = read('src/main.js');
  const body = functionBody(main, 'readClipboardText');
  assert.ok(/CLIPBOARD_SYNC_FALLBACK/.test(body), '同步分支必须记 CLIPBOARD_SYNC_FALLBACK');
  assert.ok(/syncFallbackSeen/.test(body), '同一个会话只报一次，避免每次输入都刷日志');
  const occurrences = (main.match(/CLIPBOARD_SYNC_FALLBACK/g) || []).length;
  assert.equal(occurrences, 1, `CLIPBOARD_SYNC_FALLBACK 只应出现在一处，实际 ${occurrences} 处`);
});

check('9. 写剪贴板失败要报出来，并且不许把失败当成功', () => {
  const main = read('src/main.js');
  const body = functionBody(main, 'writeClipboardText');
  assert.ok(/try\s*\{/.test(body) && /catch/.test(body), '写失败要被接住才能记诊断');
  assert.ok(/CLIPBOARD_WRITE_FAILED/.test(body), '写失败必须记 CLIPBOARD_WRITE_FAILED');
  assert.ok(/throw new Error\(/.test(body), '写完失败必须抛错，让调用方给前台提示');
  // 兼容层之外不许再出现 availableFormats（Electron 45 已经没有这个 API）；
  // 注释里提到"它没了"是允许的，所以要先把注释行剔掉。
  const stripped = ['src/main.js', 'src/preload.js', 'src/renderer/renderer.js']
    .map((rel) =>
      read(rel)
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
        })
        .join('\n'),
    )
    .join('\n');
  assert.ok(!/availableFormats/.test(stripped), 'availableFormats() 在 Electron 45 已不存在，不许再调用');
});

const failed = checks.filter((item) => !item.ok);
console.log(`\n运行时兼容回归：${checks.length - failed.length} / ${checks.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const item of failed) console.log(` - ${item.label}｜${item.error}`);
  process.exit(1);
}
