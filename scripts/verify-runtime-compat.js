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

check('1. 剪贴板只在兼容层里碰：readText / writeText 的调用点不超过两处', () => {
  const main = read('src/main.js');
  // 注释里的调用示范不算调用点（这个坑踩过一次：注释里写了 `clipboard.readText()` 就数成 3 处）
  const code = main
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
  const calls = code.match(/clipboard\.(?:readText|writeText)\s*\(/g) || [];
  // readClipboardText + writeClipboardText 各一处，多出来就是有人绕过兼容层了
  assert.equal(calls.length, 2, `clipboard 直接调用应只有兼容层里的两处，实际 ${calls.length} 处`);
  assert.ok(main.includes('async function readClipboardText('), '缺少异步读取封装');
  assert.ok(main.includes('async function writeClipboardText('), '缺少异步写入封装');
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

const failed = checks.filter((item) => !item.ok);
console.log(`\n运行时兼容回归：${checks.length - failed.length} / ${checks.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const item of failed) console.log(` - ${item.label}｜${item.error}`);
  process.exit(1);
}
