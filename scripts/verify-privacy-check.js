/**
 * 隐私自检判定引擎的回归（纯 Node，不启动 Electron）。
 *
 * 这一组断言的目的是守住「自检不能说假话」——尤其那两条最容易退化的：
 *   · 拿不到真实值时必须是 unknown，不许把页面自报值当真实值（假绿比不做更糟）；
 *   · 同一张画布两次取样哈希必须一致（不稳定本身是可识别特征，是 3107085 修过的点）。
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'src', 'core', 'privacy-check.js');

const check = require(MODULE_PATH);

let pass = 0;
let fail = 0;
const results = [];

function ok(name, fn) {
  try {
    fn();
    pass += 1;
    results.push({ name, ok: true });
  } catch (error) {
    fail += 1;
    results.push({ name, ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function assertLevel(expected, actual, label) {
  assert.strictEqual(actual, expected, `${label}：期望 ${expected}，实际 ${actual}`);
}

/* ---------- 1–5：五个档位各至少一例 ---------- */

ok('第 1 档：泄漏（A1 UA 里带 Electron）', () => {
  const row = check.judgeItem('A1', { ua: 'Mozilla/5.0 Nyx/1.18.0 Electron/45.3.2 Chrome/156' }, 'Mozilla/5.0 Chrome/156.0.0.0');
  assertLevel('leak', row.level, 'A1');
  assert.ok(row.reason.includes('Electron') || row.reason.includes('Nyx'), '理由要点出泄漏源');
});

ok('第 2 档：已伪装（A5 核数与真实值不同）', () => {
  const row = check.judgeItem('A5', { cores: 8 }, 24);
  assertLevel('masked', row.level, 'A5');
  assert.ok(row.reason.includes('8') && row.reason.includes('24'), '理由要同时写出两个数');
});

ok('第 3 档：测不到（C2 出口地址为空）', () => {
  const row = check.judgeItem('C2', { address: '' }, '203.0.113.9');
  assertLevel('unknown', row.level, 'C2');
  assert.ok(row.reason.includes('未连接') || row.reason.includes('测不到'), '理由要说清为什么测不到');
});

ok('第 4 档：可疑（B2 两次哈希不同）', () => {
  const row = check.judgeItem('B2', { hashA: 'aaaa1111', hashB: 'bbbb2222' }, null);
  assertLevel('suspect', row.level, 'B2');
  assert.ok(row.reason.includes('不稳定'), '理由要点明"不稳定本身就是特征"');
});

ok('第 5 档：正常（C1 没有候选）', () => {
  const row = check.judgeItem('C1', { candidates: [] }, null);
  assertLevel('pass', row.level, 'C1');
});

/* ---------- 6–13：逐条硬约束 ---------- */

ok('A2：UA 与客户端提示矛盾时判可疑，不许当通过', () => {
  const bad = check.judgeItem('A2', { uaPlatform: 'Windows', chPlatform: 'Android', chVersion: '156.0.8078.100' }, null);
  assertLevel('suspect', bad.level, 'A2 矛盾');
  const good = check.judgeItem('A2', { uaPlatform: 'Windows', chPlatform: 'Windows', chVersion: '156.0.8078.100', uaFullVersion: '156.0.0.0' }, null);
  assertLevel('pass', good.level, 'A2 自洽');
});

ok('A5：页面读到的核数等于真实核数 → 泄漏', () => {
  const row = check.judgeItem('A5', { cores: 24 }, 24);
  assertLevel('leak', row.level, 'A5');
});

ok('B2：同一画布两次取样哈希一致 → 正常（不许把稳定当问题）', () => {
  const row = check.judgeItem('B2', { hashA: 'same', hashB: 'same' }, null);
  assertLevel('pass', row.level, 'B2 稳定');
});

ok('B1：WebGL 报出本机显卡型号 → 泄漏', () => {
  const truth = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const row = check.judgeItem('B1', { vendor: 'Google Inc. (NVIDIA)', renderer: truth }, truth);
  assertLevel('leak', row.level, 'B1');
});

ok('C1：WebRTC 吐出内网地址 → 泄漏，且理由里点名泄漏了什么', () => {
  const row = check.judgeItem('C1', { candidates: ['192.168.1.7', '10.0.0.5'] }, null);
  assertLevel('leak', row.level, 'C1');
  assert.ok(row.reason.includes('192.168.1.7'), '要把泄漏的地址写出来');
});

ok('C3：DNS 出口恒为测不到（写死，不许被"修好"）', () => {
  const row = check.judgeItem('C3', { dns: '8.8.8.8' }, '8.8.8.8');
  assertLevel('unknown', row.level, 'C3');
  assert.ok(row.reason.includes('测不到'), '理由要说明这是能力边界');
});

ok('truth=null：要和真实值比的项一律测不到，绝不退回用 observed 当真实值', () => {
  // 只挑"必须和真实值比较"的项（A1/A3/A5/A6/B1/B3）。C1/B2/C2/A2/D1–D4 靠自身逻辑判定，
  // 不在这一条里——它们本来就不依赖真实值，被连累成测不到反而是缺陷。
  const cases = [
    ['A1', { ua: 'Mozilla/5.0 Chrome/156' }],
    ['A3', { languages: ['en-US', 'en'] }],
    ['A5', { cores: 24 }],
    ['A6', { screen: '1920x1080' }],
    ['B1', { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics)' }],
    ['B3', { formats: [] }],
  ];
  for (const [id, observed] of cases) {
    const row = check.judgeItem(id, observed, null);
    assertLevel('unknown', row.level, `${id} truth=null`);
    assert.strictEqual(row.truth, null, `${id} 的 truth 仍然要是 null`);
    assert.ok(row.reason.length > 0, `${id} 要说明为什么是测不到`);
  }
});

ok('worstLevel 按 leak > suspect > unknown > masked > pass 取最坏', () => {
  assertLevel('leak', check.worstLevel([{ level: 'pass' }, { level: 'leak' }, { level: 'masked' }]), 'worstLevel');
  assertLevel('suspect', check.worstLevel([{ level: 'masked' }, { level: 'suspect' }]), 'worstLevel 2');
  assertLevel('unknown', check.worstLevel([]), 'worstLevel 空输入');
});

/* ---------- 14–18：报告与措辞 ---------- */

ok('buildReport 带版本、时间与四条组的表头', () => {
  const rows = [
    check.judgeItem('A1', { ua: 'Mozilla/5.0 Chrome/156' }, 'Mozilla/5.0 Chrome/156'),
    check.judgeItem('C3', null, null),
  ];
  const text = check.buildReport(rows, {
    version: '1.18.0',
    electron: '45.3.2',
    chromium: '156.0.8078.100',
    at: '2026-11-17T23:00:00+08:00',
    identity: '普通',
    kernelRunning: true,
  });
  assert.ok(text.includes('1.18.0'), '要有版本');
  assert.ok(text.includes('2026-11-17T23:00:00+08:00'), '要有时间戳');
  assert.ok(text.includes('45.3.2'), '要有 Electron 版本');
  assert.ok(text.includes('| 项 | 结果 | 观察值 | 真实值 | 说明 |'), '要有固定表头');
  assert.ok(text.includes('只证明它测到的面'), '结尾要写诚实边界');
});

ok('describeLevel 四个中文标签与色调', () => {
  assert.strictEqual(check.describeLevel('leak').label, '泄漏');
  assert.strictEqual(check.describeLevel('suspect').label, '可疑');
  assert.strictEqual(check.describeLevel('unknown').label, '测不到');
  assert.strictEqual(check.describeLevel('masked').label, '已伪装');
  assert.strictEqual(check.describeLevel('leak').tone, 'bad');
  assert.strictEqual(check.describeLevel('unknown').tone, 'neutral');
  assert.strictEqual(check.describeLevel('不存在').label, '测不到', '未知档位要退回"测不到"而不是"正常"');
});

ok('词表与报告不许出现绝对化措辞，也不许出现隐私评分', () => {
  const rows = [
    check.judgeItem('A1', { ua: 'Mozilla/5.0 Chrome/156' }, 'Mozilla/5.0 Chrome/156'),
    check.judgeItem('A5', { cores: 8 }, 24),
    check.judgeItem('C3', null, null),
  ];
  const text = check.buildReport(rows, { version: '1.18.0' }) + JSON.stringify(check.buildReportJson(rows, { version: '1.18.0' }));
  for (const phrase of check.BANNED_PHRASES) {
    assert.ok(!text.includes(phrase), `报告里不该出现「${phrase}」`);
  }
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(text), '不许出现百分制评分');
  assert.ok(!text.includes('评分'), '不许出现"评分"字样');
});

ok('模块保持纯逻辑：不 require electron / fs / path / http', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  for (const bad of ["require('electron')", "require('node:fs')", "require('fs')", "require('node:path')", "require('path')", "require('node:http')", 'fetch(']) {
    assert.ok(!source.includes(bad), `判定引擎里不该出现 ${bad}`);
  }
});

ok('报告 JSON 字段固定，便于随版本存档比对', () => {
  const rows = [check.judgeItem('A5', { cores: 8 }, 24)];
  const json = check.buildReportJson(rows, { version: '1.18.0', electron: '45.3.2', chromium: '156.0.8078.100', at: 'T', identity: '普通', kernelRunning: false });
  assert.strictEqual(json.kind, 'nyx-privacy-audit');
  const keys = Object.keys(json).sort().join(',');
  assert.strictEqual(keys, 'at,chromium,counts,electron,groups,headline,identity,kernelRunning,kind,version,worstLevel');
  assert.strictEqual(json.groups.length, check.GROUPS.length, '四组都要在');
});

/* ---------- 汇总 ---------- */

const lines = results.map((item) => `  ${item.ok ? '✔' : '✘'} ${item.name}${item.ok ? '' : `｜${item.error}`}`);
process.stdout.write(`${lines.join('\n')}\n\n`);
process.stdout.write(`[隐私自检] 共 ${results.length} 项，通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail > 0) process.exitCode = 1;
