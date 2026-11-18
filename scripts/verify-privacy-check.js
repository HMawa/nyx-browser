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
  assert.strictEqual(keys, 'at,chromium,counts,electron,groups,headline,identity,kernelRunning,kind,redacted,version,worstLevel');
  assert.strictEqual(json.groups.length, check.GROUPS.length, '四组都要在');
  assert.strictEqual(json.redacted, true, '默认必须脱敏');
});

/* ---------- 19–32：审计打回的五条（A2/A3/A4/A6 判定 + 报告脱敏） ---------- */

ok('A2：高熵版本号取不到时必须「测不到」，不许把空值当一致', () => {
  const row = check.judgeItem('A2', { uaPlatform: 'Win32', chPlatform: 'Windows', chVersion: '', uaFullVersion: '' }, null);
  assertLevel('unknown', row.level, 'A2 空版本');
  assert.ok(row.reason.includes('高熵'), '理由要说清是没取到高熵值');
});

ok('A2：主版本号对不上 → 可疑；对得上 → 正常', () => {
  const bad = check.judgeItem('A2', { uaPlatform: 'Win32', chPlatform: 'Windows', chVersion: '156.0.8078.100', uaFullVersion: '150.0.7871.100' }, null);
  assertLevel('suspect', bad.level, 'A2 版本不一致');
  const good = check.judgeItem('A2', { uaPlatform: 'Win32', chPlatform: 'Windows', chVersion: '156.0.8078.100', uaFullVersion: '156.0.0.0' }, null);
  assertLevel('pass', good.level, 'A2 版本一致');
});

ok('观测脚本真的调了 getHighEntropyValues（静态守卫）', () => {
  const script = check.buildObserverScript();
  assert.ok(script.includes('getHighEntropyValues'), '低熵 API 拿不到完整版本号，必须走高熵查询');
  assert.ok(script.includes('uaFullVersion') && script.includes('fullVersionList'), '要高熵的这两项');
  assert.ok(!script.includes('`'), '脚本里不许出现反引号（会截断外层模板）');
});

ok('A3：普通模式下语言不一致就是泄漏，隐私模式下才是已伪装', () => {
  const normal = check.judgeItem('A3', { languages: ['zh-CN', 'zh-Hans-CN'] }, 'zh-Hans-CN', { mode: 'normal' });
  assertLevel('leak', normal.level, 'A3 普通模式（归一后相同）');
  const priv = check.judgeItem('A3', { languages: ['en-US', 'en'] }, 'zh-Hans-CN', { mode: 'private' });
  assertLevel('masked', priv.level, 'A3 隐私模式');
  const normalDiff = check.judgeItem('A3', { languages: ['en-US', 'en'] }, 'zh-Hans-CN', { mode: 'normal' });
  assertLevel('leak', normalDiff.level, 'A3 普通模式下读到别的语言同样是泄漏');
});

ok('canonicalLanguage 能把 zh-Hans-CN 折成 zh-CN，且对拍不误伤', () => {
  assert.strictEqual(check.canonicalLanguage('zh-Hans-CN'), 'zh-cn');
  assert.strictEqual(check.canonicalLanguage('zh_CN'), 'zh-cn');
  assert.strictEqual(check.canonicalLanguage('en-US;q=0.9'), 'en-us');
  assert.strictEqual(check.canonicalLanguage('en'), 'en');
  assert.strictEqual(check.canonicalLanguage(''), '');
  assert.strictEqual(check.canonicalLanguage('zh-Hant-TW'), 'zh-tw');
});

ok('A4：语言与时区的地区要对得上，对不上就是可疑', () => {
  const cases = [
    [{ timezone: 'Asia/Shanghai', offsetMinutes: -480, languages: ['en-US', 'en'] }, 'suspect', 'en-US + 上海'],
    [{ timezone: 'America/New_York', offsetMinutes: 300, languages: ['en-US', 'en'] }, 'pass', 'en-US + 纽约'],
    [{ timezone: 'Asia/Shanghai', offsetMinutes: -480, languages: ['zh-CN', 'zh'] }, 'pass', 'zh-CN + 上海'],
    [{ timezone: 'America/New_York', offsetMinutes: 300, languages: ['zh-CN', 'zh'] }, 'suspect', 'zh-CN + 纽约'],
  ];
  for (const [observed, expected, label] of cases) {
    const row = check.judgeItem('A4', observed, null);
    assertLevel(expected, row.level, label);
  }
});

ok('A4：时区未知 / 不在对照表里时不得判正常', () => {
  const noTz = check.judgeItem('A4', { timezone: '', languages: ['zh-CN'] }, null);
  assertLevel('unknown', noTz.level, 'A4 无时区');
  const oddTz = check.judgeItem('A4', { timezone: 'Pacific/Chatham', offsetMinutes: -765, languages: ['xx-YY'] }, null);
  assertLevel('unknown', oddTz.level, 'A4 对照表外');
});

ok('A6：像素比与系统缩放不一致 → 可疑（早先这里写反了）', () => {
  const real = { width: 2560, height: 1440, scaleFactor: 1.5 };
  const bad = check.judgeItem('A6', { width: 1707, height: 1067, dpr: 1 }, real);
  assertLevel('suspect', bad.level, 'A6 dpr 不一致');
  assert.ok(bad.reason.includes('像素比'), '理由要点名像素比');
  const good = check.judgeItem('A6', { width: 1707, height: 1067, dpr: 1.5 }, real);
  assertLevel('pass', good.level, 'A6 dpr 一致');
});

ok('A6：缺像素比或系统缩放时必须测不到', () => {
  const noDpr = check.judgeItem('A6', { width: 1707, height: 1067 }, { width: 2560, height: 1440, scaleFactor: 1.5 });
  assertLevel('unknown', noDpr.level, 'A6 缺 dpr');
  const noScale = check.judgeItem('A6', { width: 1707, height: 1067, dpr: 1.5 }, { width: 2560, height: 1440 });
  assertLevel('unknown', noScale.level, 'A6 缺系统缩放');
});

ok('报告默认脱敏：不给真实核数 / 屏幕 / UA 串', () => {
  const realUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Nyx/1.18.0 Electron/45.3.2';
  const rows = [
    check.judgeItem('A1', { ua: realUa }, realUa),
    check.judgeItem('A5', { cores: 24 }, 24),
    check.judgeItem('A6', { width: 1707, height: 1067, dpr: 1.5 }, { width: 2560, height: 1440, scaleFactor: 1.5 }),
  ];
  const text = check.buildReport(rows, { version: '1.18.0' });
  assert.ok(!text.includes('Electron/45.3.2'), '不许出现真实 UA 串');
  assert.ok(!/\b24\b/.test(text), '不许出现真实核数');
  assert.ok(!text.includes('1707') && !text.includes('2560'), '不许出现本机屏幕（伪装值也算机主特征）');
  assert.ok(text.includes('已隐藏'), '要明确写出"已隐藏"');
  assert.ok(text.includes('不要直接分享'), '要提醒原始版别分享');
});

ok('报告显式关掉脱敏时才给真实值（--raw 的口径）', () => {
  const realUa = 'Mozilla/5.0 Nyx/1.18.0 Electron/45.3.2';
  const rows = [check.judgeItem('A1', { ua: realUa }, realUa), check.judgeItem('A5', { cores: 24 }, 24)];
  const text = check.buildReport(rows, { version: '1.18.0' }, { redact: false });
  assert.ok(text.includes('Electron/45.3.2'), '原始版要能看真实 UA');
  assert.ok(/\b24\b/.test(text), '原始版要能看真实核数');
  const json = check.buildReportJson(rows, { version: '1.18.0' }, { redact: false });
  assert.strictEqual(json.redacted, false, 'JSON 也要标出没脱敏');
});

/* ---------- 汇总 ---------- */

const lines = results.map((item) => `  ${item.ok ? '✔' : '✘'} ${item.name}${item.ok ? '' : `｜${item.error}`}`);
process.stdout.write(`${lines.join('\n')}\n\n`);
process.stdout.write(`[隐私自检] 共 ${results.length} 项，通过 ${pass} 项，失败 ${fail} 项\n`);
if (fail > 0) process.exitCode = 1;
