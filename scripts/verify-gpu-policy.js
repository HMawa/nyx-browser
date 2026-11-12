'use strict';

/**
 * 图形性能策略回归（14 项断言，纯 Node，不启动 Electron）。
 *
 * 测什么：`src/core/gpu-policy.js`——默认核显优先、三档策略对应的 Chromium 开关、
 * 以及"到底用的哪张卡"的如实汇报（取不到就说未知，不许假装成功）。
 *
 * 为什么单独一个脚本：
 *   1. 策略必须在 app ready 之前读文件并 appendSwitch，这段只跑一次、且跑在 CDP
 *      连上之前，端到端脚本根本观测不到它；纯函数 + 静态守卫是唯一可测形式。
 *   2. 显卡选择在真机上"看起来生效了其实没生效"极易发生（Windows 会把
 *      force_low_power_gpu 当建议），所以断言重点放在"不许谎报"上。
 *
 * 用法：node scripts/verify-gpu-policy.js
 *
 * 零第三方依赖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  DEFAULT_GPU_POLICY,
  GPU_POLICIES,
  describeGpuPolicy,
  gpuSwitches,
  normalizeGpuPolicy,
  readGpuPolicyFromPrefs,
  summarizeGpuInfo,
} = require(path.join(ROOT, 'src', 'core', 'gpu-policy.js'));

const results = [];
function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = out === true || (out && out.ok === true);
    detail = out && typeof out === 'object' ? JSON.stringify(out.detail ?? out) : String(out);
  } catch (err) {
    ok = false;
    detail = `抛异常：${err.message}`;
  }
  results.push({ label, ok, detail });
  console.log(`${ok ? '[Nyx] ✔' : '[Nyx] ✘'} ${label}${detail ? `　｜${detail}` : ''}`);
}

check('1. 默认策略是核显优先（清单 A5 的核心诉求）', () => {
  const ok = DEFAULT_GPU_POLICY === 'low-power';
  return { ok, detail: { default: DEFAULT_GPU_POLICY } };
});

check('2. 三档策略齐全且都有中文标签与说明', () => {
  const values = GPU_POLICIES.map((it) => it.value);
  const ok =
    values.length === 3 &&
    ['low-power', 'high-performance', 'auto'].every((v) => values.includes(v)) &&
    GPU_POLICIES.every((it) => typeof it.label === 'string' && it.label.length > 0 && typeof it.hint === 'string' && it.hint.length > 6);
  return { ok, detail: { values, labels: GPU_POLICIES.map((it) => it.label) } };
});

check('3. normalizeGpuPolicy 收敛大小写与空白', () => {
  const out = {
    lower: normalizeGpuPolicy('high-performance'),
    upper: normalizeGpuPolicy('  AUTO '),
    spaced: normalizeGpuPolicy('low-power '),
  };
  const ok = out.lower === 'high-performance' && out.upper === 'auto' && out.spaced === 'low-power';
  return { ok, detail: out };
});

check('4. 非法/缺失一律回落到核显优先', () => {
  const cases = [undefined, null, '', 'open-bar', 123, {}, []];
  const out = cases.map((input) => normalizeGpuPolicy(input));
  const ok = out.every((v) => v === DEFAULT_GPU_POLICY);
  return { ok, detail: out };
});

check('5. 核显优先只下发 force_low_power_gpu', () => {
  const switches = gpuSwitches('low-power');
  const ok = switches.length === 1 && switches[0] === 'force_low_power_gpu';
  return { ok, detail: switches };
});

check('6. 独显优先只下发 force_high_performance_gpu', () => {
  const switches = gpuSwitches('high-performance');
  const ok = switches.length === 1 && switches[0] === 'force_high_performance_gpu';
  return { ok, detail: switches };
});

check('7. 跟随系统不加任何开关（交给 Windows 图形设置）', () => {
  const switches = gpuSwitches('auto');
  const ok = Array.isArray(switches) && switches.length === 0;
  return { ok, detail: switches };
});

check('8. 两档显卡开关永不同时下发，且都按无前导 -- 的名字给 appendSwitch', () => {
  const all = GPU_POLICIES.map((it) => gpuSwitches(it.value));
  const neverBoth = all.every((list) => !(list.includes('force_low_power_gpu') && list.includes('force_high_performance_gpu')));
  const noDashes = all.every((list) => list.every((name) => !name.startsWith('--')));
  return { ok: neverBoth && noDashes, detail: all };
});

check('9. describeGpuPolicy 对非法值也给完整描述（界面不会显示空白）', () => {
  const out = ['low-power', 'high-performance', 'auto', 'bogus', undefined].map((v) => describeGpuPolicy(v));
  const ok = out.every((it) => it && typeof it.label === 'string' && it.label.length > 0);
  return { ok, detail: out.map((it) => it.label) };
});

check('10. 从 ui-preferences 同步读取：认字段、缺失或损坏回默认', () => {
  const out = {
    high: readGpuPolicyFromPrefs({ gpuPolicy: 'high-performance' }),
    auto: readGpuPolicyFromPrefs({ gpuPolicy: 'auto' }),
    missing: readGpuPolicyFromPrefs({}),
    corrupt: readGpuPolicyFromPrefs({ gpuPolicy: 'ultra' }),
    nullish: readGpuPolicyFromPrefs(null),
  };
  const ok =
    out.high === 'high-performance' &&
    out.auto === 'auto' &&
    out.missing === DEFAULT_GPU_POLICY &&
    out.corrupt === DEFAULT_GPU_POLICY &&
    out.nullish === DEFAULT_GPU_POLICY;
  return { ok, detail: out };
});

check('11. summarizeGpuInfo 优先报 active 的那张卡', () => {
  const out = summarizeGpuInfo({
    gpuDevice: [
      { vendorId: 0x8086, deviceId: 0x9a49, active: false },
      { vendorId: 0x10de, deviceId: 0x25a0, active: true },
    ],
  });
  const ok =
    out.ok === true &&
    out.deviceCount === 2 &&
    out.activeKnown === true &&
    out.activeVendor.includes('NVIDIA') &&
    out.activeName.includes('当前使用') &&
    out.activeDeviceId === '0x25a0';
  return { ok, detail: out };
});

check('12. 没有 active 标记时不谎报：明确写"系统没标出用哪张"', () => {
  const out = summarizeGpuInfo({ gpuDevice: [{ vendorId: 0x8086, deviceId: 0x1234 }] });
  const ok =
    out.ok === true &&
    out.activeKnown === false &&
    out.note.includes('没有标出') &&
    !out.activeName.includes('当前使用');
  return { ok, detail: { activeName: out.activeName, activeKnown: out.activeKnown, note: out.note } };
});

check('13. 取不到显卡信息时给「未知」而不是编一个型号', () => {
  const cases = [null, undefined, {}, { gpuDevice: [] }];
  const out = cases.map((input) => summarizeGpuInfo(input));
  const ok = out.every((it) => it.ok === false && it.activeName === '未知' && it.deviceCount === 0 && it.note.length > 0);
  return { ok, detail: out.map((it) => it.activeName) };
});

check('14. 静态守卫：启动前读偏好并下发开关，且记录启动后的真实适配器', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const uiStore = fs.readFileSync(path.join(ROOT, 'src', 'core', 'ui-store.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

  const bootBeforeReady =
    main.indexOf('const BOOT_GPU_POLICY = readBootGpuPolicy();') > 0 &&
    main.indexOf('const BOOT_GPU_POLICY = readBootGpuPolicy();') < main.indexOf('app.whenReady(');
  const detail = {
    启动前读偏好: bootBeforeReady,
    按策略下发开关: /for \(const name of gpuSwitches\(BOOT_GPU_POLICY\)\)/.test(main),
    启动后记录适配器: main.includes("diagnostics.info('GPU_ADAPTER'") && main.includes('runtime.gpuInfo = summarizeGpuInfo(info)'),
    没有无条件强制独显: !/appendSwitch\('force_high_performance_gpu'\)/.test(main),
    偏好项与枚举: uiStore.includes("gpuPolicy: 'low-power'") && uiStore.includes("gpuPolicy: ['low-power', 'high-performance', 'auto']"),
    暴露面齐全: preload.includes("ipcRenderer.invoke('nyx:gpu:policy')") && preload.includes("ipcRenderer.invoke('nyx:app:restart')"),
  };
  const ok = Object.values(detail).every(Boolean);
  return { ok, detail };
});

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.error(`[Nyx] 图形策略回归失败：${failed.length}/${results.length} 项未通过`);
  for (const item of failed) console.error(`         ✘ ${item.label}　｜${item.detail}`);
  process.exitCode = 1;
} else {
  console.log(`[Nyx] 图形策略回归通过：${results.length}/${results.length} 项全绿`);
  process.exitCode = 0;
}
