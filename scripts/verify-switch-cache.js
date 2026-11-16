/**
 * 模式切换的缓存与计时回归（纯 Node，不启动 Electron）。
 *
 * 覆盖两件容易"看着像做了、实际没生效"的事：
 *   1) 缓存判定（新鲜的能用、过期的不能用、时钟回拨不能用）；
 *   2) 主进程真的接了这几条缓存与计时（静态守卫），而不是只新增了一个模块。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const cache = require(path.join(ROOT, 'src', 'core', 'switch-cache.js'));
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const moduleSource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'switch-cache.js'), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✘ ${name}${detail === undefined ? '' : `：${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

/* ① 有效期常量：写了多少就是多少，别让"改成 10 分钟"这种事悄悄发生 */
check('代理可达性结论的有效期是 30 秒', cache.PROXY_PROBE_TTL_MS === 30_000, cache.PROXY_PROBE_TTL_MS);
check('"出口取不到"的有效期是 60 秒', cache.EGRESS_UNKNOWN_TTL_MS === 60_000, cache.EGRESS_UNKNOWN_TTL_MS);

/* ② 读缓存：新鲜命中、过期不命中、时钟回拨不命中、坏数据不命中 */
const entry = cache.writeTimed({ reachable: true, key: '127.0.0.1:7897' }, 1_000);
check('刚写进去的缓存能读到，值原样带出', cache.readTimed(entry, 1_500, 30_000).hit === true && cache.readTimed(entry, 1_500, 30_000).value.key === '127.0.0.1:7897');
check('刚好到有效期边界就按过期处理', cache.readTimed(entry, 31_000, 30_000).hit === false);
check('时钟被往回调时不认这份缓存（宁多重探一次）', cache.readTimed(entry, 500, 30_000).hit === false);
check('空条目 / 没有时间戳 / ttl 非法都不命中', cache.readTimed(null, 1, 1000).hit === false && cache.readTimed({ value: 1 }, 1, 1000).hit === false && cache.readTimed(entry, 1, 0).hit === false);
check('带出 ageMs，方便日志说清"多久之前的结论"', cache.readTimed(entry, 4_000, 30_000).ageMs === 3_000);

/* ③ 写缓存：不改入参，时间戳落在现在 */
const payload = { reachable: false };
const written = cache.writeTimed(payload, 9_000);
check('写缓存返回新对象且不改入参', written.at === 9_000 && written.value === payload && Object.keys(payload).length === 1);
check('时钟坏掉时写入 0（调用方读的时候自然不命中）', cache.writeTimed(payload, Number.NaN).at === 0);

/* ④ 计时文案 */
check('不到 1 秒用毫秒表达', cache.formatDuration(320) === '320 毫秒', cache.formatDuration(320));
check('超过 1 秒用秒表达，且保留一位小数', cache.formatDuration(6_200) === '6.2 秒', cache.formatDuration(6_200));
const timing = cache.describeTiming(
  [
    { step: '探代理', ms: 120, reused: true },
    { step: '装配加固', ms: 6_000 },
    { step: '建新标签', ms: 200 },
  ],
  6_320,
);
check('计时文案点名每一步，并标出"复用缓存"', timing.text.includes('探代理') && timing.text.includes('复用缓存') && timing.text.includes('装配加固'), timing.text);
check('计时文案指出最慢的一步', timing.slowest && timing.slowest.step === '装配加固' && timing.slowest.ms === 6_000, timing.slowest);
check('计时文案统计复用次数', timing.reused === 1, timing.reused);
check('没有分步记录时也给出总耗时，而不是空白', cache.describeTiming([], 1_500).text.includes('1.5 秒'), cache.describeTiming([], 1_500).text);

/* ⑤ 主进程接线（静态守卫）：模块再好，没接上也等于没做 */
check(
  '主进程引入了 switch-cache 的四个导出',
  /require\('\.\/core\/switch-cache'\)/.test(main) &&
    /PROXY_PROBE_TTL_MS/.test(main) &&
    /EGRESS_UNKNOWN_TTL_MS/.test(main) &&
    /describeTiming/.test(main),
);
check('切换模式时走的是带缓存的探代理（不是每次都重新探）', /async function probeProxyCached/.test(main) && /await probeProxyCached\(\)/.test(main));
check(
  'switchMode 里不再有"直接探一遍"的旧写法',
  !/recordProbe\(await isProxyReachable\(\)\)/.test(main.slice(main.indexOf('async function switchMode'), main.indexOf('async function switchModeTracked'))),
);
check(
  '"出口取不到"会写进缓存，并在下次切换时被复用（不再每次等满 6 秒）',
  /switchCache\.egressUnknown = writeTimed\(/.test(main) &&
    /readTimed\(unknownCache, Date\.now\(\), EGRESS_UNKNOWN_TTL_MS\)/.test(main),
);
check(
  '切换结束写一条 MODE_SWITCH_TIMING 诊断，并把 timing 返回给调用方',
  /diagnostics\.info\('MODE_SWITCH_TIMING'/.test(main) && /return \{ ok: true, state: currentSnapshot\(\), timing \}/.test(main),
);
check('缓存模块保持纯逻辑（不 require electron / fs / http）', !/require\('electron'\)|require\('node:fs'\)|require\('http/.test(moduleSource));

console.log('');
console.log(`模式切换缓存回归：通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('✘ 模式切换缓存回归未通过');
  process.exitCode = 1;
} else {
  console.log('[Nyx] 模式切换缓存回归通过');
}
