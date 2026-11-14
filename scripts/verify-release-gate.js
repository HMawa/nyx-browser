'use strict';

/**
 * Nyx 发版门禁与安装器 e2e 接线守卫（纯静态，不启动 Electron、不跑安装包）
 *
 * 为什么要有这个脚本：
 *   - 安装器端到端要管理员权限、要移动真实用户数据，所以它不进 `npm run verify`；
 *   - 但它一旦"悄悄没接线"，发版摘要里那句「安装器 e2e：…」就会消失，
 *     而没人会注意到——这正是最容易被糊弄过去的地方。
 *   所以这里用静态断言把「门禁还在、没跑也会明说、跨版本基线能自动找到」钉住。
 *
 * 退出码：0 = 全部通过；1 = 有失败。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'scripts', 'make-release.js');
const E2E = path.join(ROOT, 'scripts', 'test-installer-e2e.js');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : detail });
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 只看代码行：注释里出现同名函数/字符串不算接线（这类假通过踩过好几次）。 */
function codeOnly(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 取某个函数体（从出现位置到下一个行首 function） */
function bodyOf(text, pattern) {
  const index = text.search(pattern);
  if (index < 0) return '';
  const rest = text.slice(index);
  const end = rest.slice(1).search(/\nfunction /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const release = read(RELEASE);
const releaseCode = codeOnly(release);
const e2e = read(E2E);
const e2eCode = codeOnly(e2e);

// 1) 发版脚本仍然有 --with-installer-test 这个开关，且真的被读进来
check(
  '发版脚本认识 --with-installer-test',
  /hasFlag\(\s*'with-installer-test'\s*\)/.test(releaseCode),
  'make-release.js 里必须出现 hasFlag(\'with-installer-test\')'
);

// 2) 门禁函数存在，并且发版主流程里真的调用了它（不是定义了却不用）
const gateBody = bodyOf(releaseCode, /function installerE2eGate\(/);
check('发版脚本里有安装器 e2e 门禁函数', gateBody.length > 200, `函数体 ${gateBody.length} 字`);
check(
  '发版主流程真的调用门禁（不是只定义）',
  /const\s+e2e\s*=\s*installerE2eGate\(/.test(releaseCode),
  '应出现 const e2e = installerE2eGate(setupPath, version)'
);

// 3) 门禁失败必须中止发版：不许"测挂了还报发布成功"
check(
  '门禁失败会中止发版',
  /if\s*\(\s*!ok\s*\)\s*\{\s*fail\(/.test(gateBody),
  'installerE2eGate 里必须有 if (!ok) fail(...)'
);

// 4) 没跑也必须打印一行，且带可复制的命令（禁止静默跳过）
check(
  '没跑会在发版摘要里明说，并给出可复制命令',
  /安装器 e2e：\$\{e2e\.ran/.test(releaseCode) && /manualCmd/.test(gateBody),
  '摘要行 + manualCmd 两者缺一不可'
);
check(
  '预演（--dry-run）也会打印安装器 e2e 一行',
  /安装器 e2e：预演不运行/.test(releaseCode),
  '预演不能假装跑过'
);

// 5) 跨版本基线能自动发现：dist\\legacy 目录参与查找
check(
  '发版门禁会在 dist\\legacy 里找升级基线',
  /path\.join\(\s*distDir\s*,\s*'legacy'\s*\)/.test(releaseCode),
  "findOlderInstaller 必须扫 dist\\legacy"
);

// 6) 安装器 e2e 自己也能自动发现基线，且找不到时明说
check(
  'e2e 定义了 dist\\legacy 归档目录',
  /LEGACY_DIR\s*=\s*path\.join\(\s*ROOT\s*,\s*'dist'\s*,\s*'legacy'\s*\)/.test(e2eCode),
  'LEGACY_DIR 必须是 dist/legacy'
);
check(
  'e2e 的归档目录读不到时不会崩',
  /function listLegacyInstallers\(\)[\s\S]{0,400}?catch/.test(e2eCode),
  'listLegacyInstallers 必须有 try/catch'
);
const parseBody = bodyOf(e2eCode, /function parseArgs\(/);
check(
  '--cross 不给 --from 时自动选用归档包',
  /crossMode\s*&&\s*!olderInstallerPath/.test(parseBody) && /listLegacyInstallers\(\)/.test(parseBody),
  'parseArgs 里要有自动发现分支'
);
check(
  '没有归档包时明说「没测」并给两条出路',
  /dist\\\\legacy\\\\ 里也没有归档安装包/.test(e2eCode) || /也没有归档安装包/.test(e2eCode),
  '不许静默降级成只测全新安装'
);
check(
  'e2e 支持 --cross 且会写入旧格式用户数据',
  /crossMode\s*=\s*true/.test(e2eCode) && /seedLegacyUserData\(/.test(e2eCode),
  '跨版本用例必须带旧数据，否则测不出迁移'
);

// 7) 跳过项与通过项分开统计（SKIP 不许算成 PASS）
check(
  '跳过项单独统计，不混进通过数',
  /skipped\s*\?\s*'SKIP'/.test(e2eCode) && /跳过 \$\{skipped\.length\} 项/.test(e2eCode),
  '汇总里 SKIP 与 PASS 必须分开'
);

// 8) 归档轮换脚本：手抄一份旧包不算常态化
const SYNC = path.join(ROOT, 'scripts', 'sync-legacy.js');
const syncCode = read(SYNC);
check(
  '有归档轮换脚本，能把留档里的旧包同步进 dist\\legacy',
  Boolean(syncCode) &&
    /updates-archive/.test(syncCode) &&
    /copyFileSync/.test(syncCode) &&
    /LEGACY_DIR/.test(syncCode),
  'scripts/sync-legacy.js 必须能从 updates-archive 复制到 dist/legacy'
);
check(
  '同名不同大小的包不许被静默覆盖',
  /conflicts\.push/.test(syncCode) && /没有覆盖/.test(syncCode),
  '同名不同字节会让升级判定混乱，必须显式失败'
);
check(
  '轮换默认保留最老的几份，删包必须显式 --prune',
  /--prune/.test(syncCode) && /keep/.test(syncCode) && /slice\(0, keep\)/.test(syncCode),
  '跨两版要的就是最老那份；默认不删'
);

// 验签要验「这次的包」，不是「先找到的那个」
const { pickNewestInstaller } = require('./lib/pick-artifact');
check(
  '验签挑包按版本号，不按目录顺序（否则会验到上次签的旧包）',
  (() => {
    const picked = pickNewestInstaller([
      { name: 'Nyx-Setup-1.17.3.exe', dir: 'dist-sign', mtimeMs: 999 },
      { name: 'Nyx-Setup-1.17.4.exe', dir: 'dist', mtimeMs: 1 },
      { name: 'notes.txt', dir: 'dist', mtimeMs: 9999 },
    ]);
    return Boolean(picked) && picked.name === 'Nyx-Setup-1.17.4.exe' && picked.version === '1.17.4';
  })(),
  'dist-sign 里躺着上次签的旧包时，必须挑版本更大的那个'
);
check(
  '同版本重打过的包按修改时间取最新的',
  (() => {
    const picked = pickNewestInstaller([
      { name: 'Nyx-Setup-1.17.4.exe', dir: 'a', mtimeMs: 10 },
      { name: 'Nyx-Setup-1.17.4.exe', dir: 'b', mtimeMs: 20 },
    ]);
    return Boolean(picked) && picked.dir === 'b';
  })(),
  '版本相同就看谁更新（重打包的场景）'
);
check(
  '没有候选时返回空，而不是乱挑一个',
  pickNewestInstaller([]) === null && pickNewestInstaller([{ name: 'readme.md' }]) === null,
  '挑不出来就要说挑不出来'
);
check(
  'verify-signing 真的用了这个挑包函数',
  /require\('\.\/lib\/pick-artifact'\)/.test(read(path.join(ROOT, 'scripts', 'verify-signing.js'))) &&
    /pickNewestInstaller\(/.test(read(path.join(ROOT, 'scripts', 'verify-signing.js'))),
  '抽出去的函数没接上等于没修'
);

// 差分兜底：实测在 Electron 45 上仍是 0 命中，所以「命中率太低就整包」这道闸门不能被撤掉
const UPDATER = path.join(ROOT, 'src', 'core', 'updater.js');
const updaterCode = codeOnly(read(UPDATER));
const MEASURE = path.join(ROOT, 'scripts', 'measure-delta.js');
check(
  '差分下载保留命中率闸门：命中率低就退回整包，不逐块 Range 拉全包',
  (() => {
    const matched = /const DIFF_MIN_HIT_RATE = ([\d.]+);/.exec(updaterCode);
    if (!matched) return false;
    const rate = Number(matched[1]);
    // 1.17.3 → 1.17.4 实测 0.00% 命中；闸门一旦被降到 0，就会变成 243 次 Range 拉整包
    return Number.isFinite(rate) && rate >= 0.2;
  })(),
  'DIFF_MIN_HIT_RATE 不许被降到 0.2 以下（NSIS 是固实压缩流，真实命中率就是 0）'
);
check(
  '留着块级差分的测量工具，结论可复现',
  /--base/.test(read(MEASURE)) && /--target/.test(read(MEASURE)) && /DIFF_MIN_HIT_RATE|hitRate/.test(read(MEASURE)),
  'scripts/measure-delta.js 要在，下次换内核时能重新量一遍'
);
check(
  'app.asar 的差分可行性有实测工具，结论不是拍脑袋',
  (() => {
    const file = path.join(ROOT, 'scripts', 'measure-asar-delta.js');
    if (!fs.existsSync(file)) return false;
    const code = read(file);
    // 固定块与内容定义分块都要量：只量固定块会得出"差分没用"的错误结论
    return /cdcBlocks\(/.test(code) && /平均 16K/.test(code) && /75\.11%|74\.53%/.test(code);
  })(),
  'scripts/measure-asar-delta.js 要在，且把 2026-11-14 的实测结论写进文件头'
);
check(
  '差分这条路为什么没走，文档里写清了边界',
  /asar/.test(read(path.join(ROOT, 'docs', '实测修复台账.md')))
    && /内容定义分块|CDC/.test(read(path.join(ROOT, 'docs', '实测修复台账.md'))),
  'docs/实测修复台账.md 要写明「安装包形态 0 命中、asar 上要有效必须换 CDC、以及为什么不现在做」'
);

/* ---- 差分命中率实测（设置页那个按钮背后的纯逻辑与接线）---- */

const deltaStats = require(path.join(ROOT, 'src', 'core', 'delta-stats.js'));

check(
  '差分判定：一块没命中就明说「这次整包下载」，不许装作还有优化',
  (() => {
    const described = deltaStats.describeDeltaRate({ blocks: 243, hits: 0, savedBytes: 0, blockSize: 512 * 1024 });
    return described.level === 'none' && /整包下载/.test(described.text) && described.hitRate === 0;
  })(),
  'describeDeltaRate(hits=0) → level none + 文案含「整包下载」'
);

check(
  '差分判定：低于 20% 闸门仍走整包，高于闸门才说能省多少',
  (() => {
    const low = deltaStats.describeDeltaRate({ blocks: 100, hits: 5, savedBytes: 1024 * 1024, blockSize: 512 * 1024 });
    const high = deltaStats.describeDeltaRate({ blocks: 100, hits: 60, savedBytes: 8 * 1024 * 1024, blockSize: 512 * 1024 });
    return low.level === 'gate' && /仍走整包下载/.test(low.text)
      && high.level === 'diff' && /可以走差分/.test(high.text) && Math.abs(high.hitRate - 0.6) < 1e-9;
  })(),
  '5%/60% 两种命中率要分别落在 gate 与 diff 两个结论上'
);

check(
  '差分实测的前置校验：缺包、零字节、超大都要给中文原因，不是静默返回 0',
  (() => {
    const noBase = deltaStats.planDeltaMeasure({ target: { path: 'b.exe', bytes: 10 } });
    const noTarget = deltaStats.planDeltaMeasure({ base: { path: 'a.exe', bytes: 10 } });
    const badBase = deltaStats.planDeltaMeasure({ base: { path: 'a.exe', bytes: 0 }, target: { path: 'b.exe', bytes: 10 } });
    const big = deltaStats.planDeltaMeasure({
      base: { path: 'a.exe', bytes: 400 * 1024 * 1024 },
      target: { path: 'b.exe', bytes: 400 * 1024 * 1024 },
    });
    return noBase.code === 'NO_BASE' && noTarget.code === 'NO_TARGET'
      && badBase.code === 'BAD_BASE' && big.code === 'TOO_LARGE'
      && [noBase, noTarget, badBase, big].every((item) => item.ok === false && /[\u4e00-\u9fa5]/.test(item.error));
  })(),
  '四种不满足前提的情形都要 ok:false + 中文原因'
);

check(
  '差分报告能落盘也能读回来：坏数据返回 null，不把 0 当成「量过了」',
  (() => {
    const good = deltaStats.summarizeDeltaMeasure({
      base: { path: 'a.exe', bytes: 100, version: '1.17.4' },
      target: { path: 'b.exe', bytes: 100, version: '1.17.5' },
      blockSize: 512 * 1024,
      blocks: 10,
      hits: 0,
      savedBytes: 0,
      at: Date.UTC(2026, 10, 14),
    });
    const back = deltaStats.normalizeDeltaReport(JSON.parse(JSON.stringify(good)));
    return good.ok === true && back && back.ok === true && back.level === 'none'
      && back.base.version === '1.17.4' && deltaStats.normalizeDeltaReport(null) === null
      && deltaStats.normalizeDeltaReport({}) === null;
  })(),
  'summarizeDeltaMeasure → JSON → normalizeDeltaReport 要等价；null/{} 一律 null'
);

check(
  '设置页能显示上次的实测结果，也能一键再量（接线四处都在）',
  (() => {
    const mainCode = read(path.join(ROOT, 'src', 'main.js'));
    const preloadCode = read(path.join(ROOT, 'src', 'preload.js'));
    const htmlCode = read(path.join(ROOT, 'src', 'renderer', 'settings.html'));
    const settingsCode = read(path.join(ROOT, 'src', 'renderer', 'settings.js'));
    return /nyx:update:delta-check/.test(mainCode)
      && /measureDeltaHitRate\(\{ blockSize/.test(mainCode)
      && /delta: readDeltaReport\(\)/.test(mainCode)
      && /writeDeltaReport\(report\)/.test(mainCode)
      && /updateDeltaCheck/.test(preloadCode)
      && /id="btn-delta-check"/.test(htmlCode) && /id="delta-text"/.test(htmlCode)
      && /function renderDeltaReport\(/.test(settingsCode)
      && /updateDeltaCheck\(\{\}\)/.test(settingsCode);
  })(),
  'main 的 IPC + 落盘 + footprint 带 delta、preload 方法、html 按钮与文案、settings 的渲染与点击'
);


check(
  '夜间 e2e：默认只打印计划，要真跑必须显式 --run，注册任务只打印命令不代跑',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'nightly-e2e.js'));
    return /const options = \{ run: false/.test(code)
      && /if \(!options\.run\) \{[\s\S]{0,160}没有 --run，按计划什么都没做/.test(code)
      && /schtasks \/Create \/TN/.test(code)
      && /我不代跑|要你自己执行/.test(code)
      && !/spawnSync\(\s*[^)]*schtasks/.test(code);
  })(),
  '默认 dry-run + --run 才动 + schtasks 只打印不执行'
);

check(
  '夜间 e2e：先轮换归档再 --cross，结果追加到记录表，失败以非零退出',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'nightly-e2e.js'));
    // 只看 plan() 里的步骤顺序，不能拿全文 indexOf 比：注释里先提到 --cross，会误判顺序
    const planStart = code.indexOf('function plan()');
    const planBlock = planStart >= 0 ? code.slice(planStart, code.indexOf('function registerCommand')) : '';
    const orderOk = planBlock.indexOf('sync-legacy.js') >= 0 && planBlock.indexOf('sync-legacy.js') < planBlock.indexOf('test-installer-e2e.js --cross');
    return orderOk
      && /安装器e2e夜间记录\.md/.test(code)
      && /function appendRecord\(/.test(code)
      && /parseCrossSummary\(/.test(code)
      && /process\.exitCode = main\(\)/.test(code)
      && /return 1;/.test(code);
  })(),
  'plan() 里 sync-legacy → --cross 的顺序、记录表、非零退出都在'
);

check(
  '夜间 e2e 的产物不进 Git：temp 里的日志被忽略，记录表本身要能提交',
  (() => {
    const ignore = read(path.join(ROOT, '.gitignore'));
    const tempIgnored = /^temp\/?$/m.test(ignore) || /^temp\/\*$/m.test(ignore) || /temp\//.test(ignore);
    const docsKept = !/^docs\/?$/m.test(ignore) && !/安装器e2e夜间记录/.test(ignore);
    return tempIgnored && docsKept;
  })(),
  'temp 忽略、docs 记录表不被忽略'
);

const failed = checks.filter((item) => !item.ok);
console.log(`\n[Nyx] 发版门禁接线检查（${checks.length} 项）`);
for (const item of checks) {
  console.log(`  ${item.ok ? '✔' : '✘'} ${item.name}${item.detail ? `｜${item.detail}` : ''}`);
}
if (failed.length) {
  console.error(`\n[Nyx] 发版门禁接线检查未通过：${failed.length} 项`);
  process.exit(1);
}
console.log('\n[Nyx] 发版门禁接线检查通过：没跑会明说、跑挂了会中止、升级基线能自动找到');
