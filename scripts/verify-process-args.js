'use strict';

/**
 * 进程可辨识（清单 A3）回归——纯 Node，不启动 Electron。
 *
 * 守三件事：
 * 1. 命令行参数拼得对（kind / tab / host，非 http(s) 不给 host）。
 * 2. 进程表能把 PID 对上标签，主进程排第一，睡着的标签不进表。
 * 3. 接线到位，且**不许**出现「改名/改映像名」这种做不到的承诺。
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const pure = require(path.join(ROOT, 'src', 'core', 'process-args'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log(`  ✘ ${name}`);
    console.log(`      ${err && err.message ? err.message : err}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\n[进程可辨识（清单 A3）]');

check('命令行参数：kind 必有，tabId 与主机名按需带上，主机名统一小写', () => {
  assert.deepStrictEqual(
    pure.buildTabProcessArgs({ tabId: 3, kind: 'tab', url: 'https://Example.COM/a?b=1' }),
    ['--nyx-kind=tab', '--nyx-tab=3', '--nyx-host=example.com'],
  );
  assert.deepStrictEqual(pure.buildTabProcessArgs({ kind: 'settings' }), ['--nyx-kind=settings']);
});

check('非 http(s) 地址不硬塞主机名（about:blank / chrome-error 没有主机可言）', () => {
  assert.deepStrictEqual(
    pure.buildTabProcessArgs({ tabId: 9, kind: 'tab', url: 'chrome-error://chromewebdata/' }),
    ['--nyx-kind=tab', '--nyx-tab=9'],
  );
  assert.strictEqual(pure.hostOf('about:blank'), '');
  assert.strictEqual(pure.hostOf('not a url'), '');
  assert.strictEqual(pure.hostOf('http://127.0.0.1:8080/x'), '127.0.0.1:8080');
});

check('参数能被读回来（改完在任务管理器里看到的就是这一份）', () => {
  const parsed = pure.parseProcessArgs([
    '--autoplay-policy=no-user-gesture-required',
    '--nyx-kind=tab',
    '--nyx-tab=12',
    '--nyx-host=docs.example.com',
  ]);
  assert.deepStrictEqual(parsed, { kind: 'tab', tabId: 12, host: 'docs.example.com' });
  assert.deepStrictEqual(pure.parseProcessArgs(['--nyx-kind=tab']), { kind: 'tab', tabId: 0, host: '' });
});

check('合并参数时保留原有参数且不重复（模式参数不能被身份参数顶掉）', () => {
  const merged = pure.mergeAdditionalArguments(
    ['--nyx-mode=private', '--autoplay-policy=none'],
    ['--nyx-kind=tab', '--nyx-mode=private'],
  );
  assert.deepStrictEqual(merged, ['--nyx-mode=private', '--autoplay-policy=none', '--nyx-kind=tab']);
});

check('进程表：主进程排最前，标签按内存降序，PID 原样保留', () => {
  const result = pure.buildProcessRows({
    mainPid: 100,
    metrics: [
      { pid: 300, type: 'Tab', memory: { workingSetSize: 1024 * 1024 } },
      { pid: 100, type: 'Browser', memory: { workingSetSize: 120 * 1024 } },
      { pid: 200, type: 'Tab', memory: { workingSetSize: 200 * 1024 } },
    ],
    tabs: [
      { id: 3, pid: 200, url: 'https://a.test/x', title: '甲' },
      { id: 4, pid: 300, url: 'https://b.test/y', title: '乙' },
    ],
  });
  assert.deepStrictEqual(result.rows.map((r) => r.pid), [100, 300, 200]);
  assert.strictEqual(result.rows[0].isMain, true);
  assert.match(result.rows[0].label, /主进程/);
  assert.match(result.rows[1].label, /标签 4 · b\.test/);
  assert.strictEqual(result.rows[1].title, '乙');
  assert.strictEqual(result.tabCount, 2);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.totalMb, Math.round(result.rows.reduce((sum, r) => sum + r.mb, 0) * 10) / 10);
});

check('对不上标签的渲染进程单独说明，不冒充某个标签', () => {
  const result = pure.buildProcessRows({
    mainPid: 1,
    metrics: [{ pid: 500, type: 'Tab', memory: { workingSetSize: 4096 } }],
    tabs: [],
  });
  assert.strictEqual(result.rows[0].kind, 'renderer-unknown');
  assert.match(result.rows[0].label, /没对上标签/);
});

check('睡着的标签没有进程就不进表（不留一行 0 MB 的假进程）', () => {
  const result = pure.buildProcessRows({
    mainPid: 1,
    metrics: [{ pid: 1, type: 'Browser', memory: { workingSetSize: 1024 } }],
    tabs: [{ id: 9, pid: 0, url: 'https://c.test', asleep: true }],
  });
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.tabCount, 0);
});

check('复制文本带总览、口径说明与每行 PID/名称/内存', () => {
  const result = pure.buildProcessRows({
    mainPid: 42,
    metrics: [{ pid: 42, type: 'Browser', memory: { workingSetSize: 1024 } }],
    tabs: [],
  });
  const lines = result.text.split('\n');
  assert.match(lines[0], /Nyx 进程详情（共 1 个进程/);
  assert.match(lines[1], /映像名一律是 Nyx\.exe/);
  assert.match(lines[2], /^42\t/);
  assert.match(result.hint, /命令行/);
});

check('未知类型有兜底说法，不会把 undefined 写到界面上', () => {
  assert.strictEqual(pure.labelOfKind('weird-type'), '其它进程');
  assert.strictEqual(pure.labelOfKind(''), '其它进程');
  assert.match(pure.labelOfKind('tab'), /标签页/);
});

check('接线：标签/应用页/唤醒三处都注入身份参数，主进程有进程表与复制通道', () => {
  const tabs = read('src/core/tabs.js');
  assert.match(tabs, /buildTabProcessArgs/);
  assert.match(tabs, /mergeAdditionalArguments/);
  const callCount = (tabs.match(/buildTabProcessArgs\(/g) || []).length;
  assert.ok(callCount >= 3, `标签/应用页/唤醒应各有一处，实际 ${callCount} 处`);
  assert.match(tabs, /--nyx-/, '唤醒时按新地址重写 --nyx-* 的注释或过滤要留在代码里');

  const main = read('src/main.js');
  assert.match(main, /buildProcessRows/);
  assert.match(main, /ipcMain\.handle\('nyx:proc:list'/);
  assert.match(main, /ipcMain\.handle\('nyx:proc:copy'/);
  assert.match(main, /app\.getAppMetrics\(\)/);
  assert.match(main, /getOSProcessId\(\)/);

  const preload = read('src/preload.js');
  assert.match(preload, /processList: \(\) => ipcRenderer\.invoke\('nyx:proc:list'\)/);
  assert.match(preload, /processCopy: \(payload\) => ipcRenderer\.invoke\('nyx:proc:copy'/);

  const html = read('src/renderer/settings.html');
  assert.match(html, /id="proc-badge"/);
  assert.match(html, /id="proc-rows"/);
  assert.match(html, /id="btn-proc-copy"/);
  assert.match(html, /--nyx-tab/);

  const js = read('src/renderer/settings.js');
  assert.match(js, /async function loadProcessList\(\)/);
  assert.match(js, /loadProcessList\(\);/, '进入诊断分区要真的调用');
  assert.match(js, /processCopy\(\{ text: lastProcessText \}\)/);
});

check('红线：不承诺改映像名/进程改名（做不到的事不写在界面上）', () => {
  const html = read('src/renderer/settings.html');
  assert.match(html, /映像名一律是 Nyx\.exe/);
  const main = read('src/main.js');
  const pureSrc = read('src/core/process-args.js');
  for (const [name, src] of [['main.js', main], ['process-args.js', pureSrc]]) {
    if (/renameProcess|setProcessName|imageName\s*:\s*'Nyx 标签/.test(src)) {
      throw new Error(`${name} 里出现了做不到的改名承诺`);
    }
  }
});

const total = passed + failures.length;
console.log(`\n[验证] 共 ${total} 项，通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
  for (const item of failures) console.log(`  ✘ ${item.name}：${item.message}`);
  process.exitCode = 1;
}
