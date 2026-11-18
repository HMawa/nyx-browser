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

// 4b) AUD-03：装完之后更新源里的包还在——必须是真装一遍的功能判据，不是字节串判据
const retentionPath = path.join(ROOT, 'scripts', 'verify-installer-retention.js');
check(
  '有「装完之后包还在」的功能判据脚本（AUD-03）',
  fs.existsSync(retentionPath),
  '需要 scripts/verify-installer-retention.js：真装一遍再看 %APPDATA%\\Nyx\\updates'
);
const retentionCode = fs.existsSync(retentionPath) ? codeOnly(read(retentionPath)) : '';
check(
  '功能判据真的断言"新版安装包还在 + 与 latest.json 一致 + 旧包已清"',
  /installerNameFor\(newVersion\)/.test(retentionCode) &&
    /\bsha\s*===\s*wantSha/.test(retentionCode) &&
    /已被清掉/.test(retentionCode),
  '三件事缺一不可'
);
check(
  '发版门禁真的调用它，且失败会中止发版',
  /installerRetentionGate\(setupPath,\s*older\)/.test(releaseCode) && /installerRetentionGate/.test(gateBody),
  'installerE2eGate 里要调 installerRetentionGate，而不是只在别处定义'
);
check(
  '不许再用字节串 nyx-keep-package 当判据',
  !/includes\(\s*'nyx-keep-package'\s*\)/.test(releaseCode) && !/includes\(\s*'nyx-keep-package'\s*\)/.test(retentionCode),
  '那条字符串在 NSIS 脚本里、被 LZMA 压过，成品 exe 里查不到'
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
      && /const delta = readDeltaReport\(\)/.test(mainCode)
      && /writeDeltaReport\(report\)/.test(mainCode)
      && /updateDeltaCheck/.test(preloadCode)
      && /id="btn-delta-check"/.test(htmlCode) && /id="delta-text"/.test(htmlCode)
      && /function renderDeltaReport\(/.test(settingsCode)
      && /updateDeltaCheck\(\{\}\)/.test(settingsCode);
  })(),
  'main 的 IPC + 落盘 + footprint 带 delta、preload 方法、html 按钮与文案、settings 的渲染与点击'
);

check(
  '过期的差分数字不许当结论：配对变了 / 放太久 / 上次失败 / 没量过，四种都要说"该重新量"',
  (() => {
    const now = Date.UTC(2026, 10, 15);
    const fresh = deltaStats.describeDeltaFreshness(
      { ok: true, at: now - 2 * 86400000, base: { version: '1.17.5' }, target: { version: '1.17.6' } },
      { currentVersion: '1.17.6', now }
    );
    const stale = deltaStats.describeDeltaFreshness(
      { ok: true, at: now - 86400000, base: { version: '1.17.4' }, target: { version: '1.17.5' } },
      { currentVersion: '1.17.6', now }
    );
    const aged = deltaStats.describeDeltaFreshness(
      { ok: true, at: now - 40 * 86400000, base: { version: '1.17.5' }, target: { version: '1.17.6' } },
      { currentVersion: '1.17.6', now }
    );
    const failed = deltaStats.describeDeltaFreshness(
      { ok: false, code: 'NO_TARGET', error: '更新源里没有当前版本的安装包，量不了差分。', at: now },
      { currentVersion: '1.17.6', now }
    );
    const missing = deltaStats.describeDeltaFreshness(null, { currentVersion: '1.17.6', now });
    return fresh.level === 'current' && fresh.needsRemeasure === false && /1\.17\.5 → 1\.17\.6/.test(fresh.pair)
      && stale.level === 'stale' && stale.needsRemeasure === true && /不再|不描述/.test(stale.text) && /1\.17\.6/.test(stale.text)
      && aged.level === 'aged' && aged.needsRemeasure === true && aged.ageDays >= 40
      && failed.level === 'failed' && failed.needsRemeasure === true && /量不了差分/.test(failed.text)
      && missing.level === 'missing' && missing.needsRemeasure === true
      && [fresh, stale, aged, failed, missing].every((item) => /[\u4e00-\u9fa5]/.test(item.text));
  })(),
  'current / stale / aged / failed / missing 五级判定与中文说明'
);

check(
  '过期判定接线：footprint 带 freshness、实测返回也带，界面按 needsRemeasure 标提醒色',
  (() => {
    const mainCode = read(path.join(ROOT, 'src', 'main.js'));
    const settingsCode = read(path.join(ROOT, 'src', 'renderer', 'settings.js'));
    const htmlCode = read(path.join(ROOT, 'src', 'renderer', 'settings.html'));
    return /deltaFreshness: describeDeltaFreshness\(delta, \{ currentVersion: version/.test(mainCode)
      && /freshness: describeDeltaFreshness\(report, \{ currentVersion/.test(mainCode)
      && /function latestVersionInSource\(\)/.test(mainCode)
      && /renderDeltaReport\(res\.delta \|\| null, res\.deltaFreshness \|\| null\)/.test(settingsCode)
      && /renderDeltaReport\(res, res\.freshness \|\| null\)/.test(settingsCode)
      && /const stale = Boolean\(fresh && fresh\.needsRemeasure\)/.test(settingsCode)
      && /重新量一次/.test(htmlCode);
  })(),
  '两处判定来源 + 界面按 needsRemeasure 换色 + 按钮文案'
);


check(
  '夜间 e2e：默认只打印计划，要真跑必须显式 --run，注册任务不带 --apply 只打印命令',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'nightly-e2e.js'));
    return /const options = \{ run: false, register: false/.test(code)
      && /if \(!options\.run\) \{[\s\S]{0,200}没有 --run，按计划什么都没做/.test(code)
      && /schtasks \/Create/.test(code)
      && /if \(!options\.apply\) \{/.test(code)
      && /我不代跑|要你自己执行|或者加 --apply/.test(code)
      && !/spawnSync\(\s*[^)]*schtasks[\s\S]{0,80}\/Create/.test(code);
  })(),
  '默认 dry-run + --run 才动 + 注册要再加 --apply（print 分支里没有真调用）'
);

check(
  '夜间 e2e 计划任务：参数拼法可断言（带引号的 /TR、每天固定时间、默认不提权），时间写错回默认',
  (() => {
    const plan = require(path.join(ROOT, 'scripts', 'lib', 'nightly-plan.js'));
    const built = plan.buildRegisterArgs({ node: 'C:\\Program Files\\nodejs\\node.exe', script: 'D:\\Nyx-src\\scripts\\nightly-e2e.js', time: '03:30' });
    const elevated = plan.buildRegisterArgs({ node: 'n.exe', script: 's.js', elevated: true });
    const bad = plan.buildRegisterArgs({ node: 'n.exe', script: 's.js', time: '25:99' });
    const missing = plan.buildRegisterArgs({ node: '', script: 's.js' });
    const del = plan.buildDeleteArgs({});
    return built.ok === true
      // 默认不提权：加 /RL HIGHEST 会让普通用户直接拿到「拒绝访问」，注册这件事就变成少数人才能做
      && !built.args.includes('/RL') && !built.args.includes('HIGHEST')
      && elevated.elevated === true && elevated.args.includes('/RL') && elevated.args.includes('HIGHEST')
      && elevated.args[elevated.args.length - 1] === '/F'
      && built.args.includes('/SC') && built.args.includes('DAILY')
      && built.args.includes('/ST') && built.args.includes('03:30')
      && built.tr === '"C:\\Program Files\\nodejs\\node.exe" "D:\\Nyx-src\\scripts\\nightly-e2e.js" --run'
      && /^".*node\.exe" /.test(built.tr)
      && bad.ok === true && bad.time === plan.DEFAULT_TIME
      && missing.ok === false && /完整路径/.test(missing.error)
      && del.ok === true && del.args.join(' ') === '/Delete /TN Nyx-Installer-E2E-Nightly /F';
  })(),
  '参数数组 + /TR 自己带引号 + 默认不提权（--elevated 才加 /RL HIGHEST）+ 时间越界回默认 + 缺路径明确拒绝 + 删除参数'
);

check(
  '夜间 e2e 计划任务：查询输出能分出「没注册 / 读不出来 / 已注册带下次时间」三种，不乱猜',
  (() => {
    const plan = require(path.join(ROOT, 'scripts', 'lib', 'nightly-plan.js'));
    const off = plan.parseQueryOutput('\n错误: 系统找不到指定的文件。\n');
    const broken = plan.parseQueryOutput('');
    const brokenEn = plan.parseQueryOutput('ERROR: Something else failed\n');
    const on = plan.parseQueryOutput(
      'TaskName:                             \\Nyx-Installer-E2E-Nightly\nNext Run Time:                        2026-11-16 3:30:00\nStatus:                               Ready\n'
    );
    const onZh = plan.parseQueryOutput('任务名:                               \\Nyx-Installer-E2E-Nightly\n下次运行时间:                         2026-11-16 3:30:00\n状态:                                就绪\n');
    const sayOff = plan.describeTask(off, {});
    const sayBroken = plan.describeTask(broken, {});
    const sayOn = plan.describeTask(on, {});
    return off.ok === true && off.registered === false
      && broken.ok === false && /没有输出/.test(broken.error)
      && brokenEn.ok === false && /报错/.test(brokenEn.error)
      && on.ok === true && on.registered === true && on.nextRun === '2026-11-16 3:30:00'
      && onZh.ok === true && onZh.registered === true
      && sayOff.level === 'off' && /--register --apply/.test(sayOff.text)
      && sayBroken.level === 'unknown' && /不等于没注册/.test(sayBroken.text)
      && sayOn.level === 'on' && /下次运行：2026-11-16 3:30:00/.test(sayOn.text);
  })(),
  '四种输出 → 三种说法；「读不出来」不许当「没注册」'
);

check(
  '夜间 e2e 计划任务：状态文件带上注册状态，卡片能把「没注册」和「上次通过」分开说',
  (() => {
    const script = read(path.join(ROOT, 'scripts', 'nightly-e2e.js'));
    const status = require(path.join(ROOT, 'src', 'core', 'nightly-status.js'));
    const withOn = status.describeNightlyStatus(
      { at: Date.UTC(2026, 10, 15), ok: true, total: 57, passed: 56, failed: 0, skipped: 1, scheduled: { registered: true, nextRun: '2026-11-16 3:30:00' } },
      { now: Date.UTC(2026, 10, 15) + 3600000 }
    );
    const withOff = status.describeNightlyStatus(
      { at: Date.UTC(2026, 10, 15), ok: true, scheduled: { registered: false } },
      { now: Date.UTC(2026, 10, 15) + 3600000 }
    );
    const withNull = status.describeNightlyStatus(
      { at: Date.UTC(2026, 10, 15), ok: true, scheduled: { registered: null, error: '查不到' } },
      { now: Date.UTC(2026, 10, 15) + 3600000 }
    );
    const rowOf = (payload) => (payload.rows.find((row) => row.label === '计划任务') || {}).value || '';
    return /const scheduledProbe = taskStatus\(\)/.test(script)
      && /scheduled,\n  \}/.test(script)
      && /已注册，下次 2026-11-16 3:30:00/.test(rowOf(withOn))
      && /没注册/.test(rowOf(withOff))
      && /上次没查出来：查不到/.test(rowOf(withNull))
      && /TextDecoder\('gbk'\)/.test(script);
  })(),
  'writeStatus 查一次注册状态 → 卡片「计划任务」一行三态；schtasks 输出按 GBK 解'
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

check(
  '差分实测自动化：脚本只做「量一次 + 写报告」，报告落在与主进程同一个文件',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'measure-delta-report.js'));
    // 复用主进程那套纯逻辑，不许在这里另写一份命中率/闸门规则
    const reusesCore = /require\(path\.join\(ROOT, 'src\/core\/delta-stats\.js'\)\)/.test(code)
      && /planDeltaMeasure\(/.test(code)
      && /summarizeDeltaMeasure\(/.test(code)
      && /normalizeDeltaReport\(/.test(code)
      && /describeDeltaRate\(/.test(code);
    // 报告必须落在 <userData>\delta-report.json —— 设置页读的就是这个文件
    const sameReport = /path\.join\(USER_DATA, 'delta-report\.json'\)/.test(code) && /function writeReport\(/.test(code);
    // 只允许写这一个文件：不许顺手改 latest.json / 安装包 / 留档
    const noSideEffects = !/latest\.json',\s*JSON\.stringify/.test(code)
      && !/fs\.copyFileSync|fs\.renameSync|fs\.unlinkSync|fs\.rmSync/.test(code);
    // dry-run 必须什么都不读不写
    const dryOk = /if \(dryRun\) \{/.test(code) && /什么都没读、什么都没写/.test(code);
    return reusesCore && sameReport && noSideEffects && dryOk;
  })(),
  '复用 delta-stats 纯逻辑、只写 delta-report.json、dry-run 不读不写',
);

check(
  '差分实测自动化：发版收尾时真的调了这一步，且在清理留档之后（基线才是下次真用的那一对）',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'make-release.js'));
    const define = /function autoMeasureDelta\(setupPath\)/.test(code);
    const spawned = /spawnSync\(process\.execPath, \[scriptPath, `--target=\$\{setupPath\}`\]/.test(code);
    const called = /const delta = hasFlag\('skip-delta'\) \? [\s\S]{0,120}: autoMeasureDelta\(setupPath\);/.test(code);
    // 注意：要定位「调用」，不是定义——`function autoMeasureDelta(setupPath)` 也在文件里，会比 prune 更靠前
    const callAt = code.indexOf(': autoMeasureDelta(setupPath);');
    const pruneAt = code.indexOf('pruneResult = pruneMode();');
    const afterPrune = callAt > 0 && pruneAt > 0 && pruneAt < callAt;
    const escape = /--skip-delta/.test(code) && /差分实测 ：\$\{delta\.text\}/.test(code);
    // 量不成不许中断发版：只有 console.warn，不许 fail(
    const warnOnly = /差分实测没量成（exit/.test(code) && !/if \(!delta\.ok\) fail\(/.test(code);
    return define && spawned && called && afterPrune && escape && warnOnly;
  })(),
  'autoMeasureDelta 定义 + 真调用 + 在 prune 之后 + --skip-delta 逃生门 + 只告警不中断',
);

check(
  '差分实测自动化：预演不量，但要说清真实发版会量（别让人以为这条被跳过了）',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'make-release.js'));
    const dryBlockStart = code.indexOf('function releaseDryRun()');
    const dryBlock = dryBlockStart >= 0 ? code.slice(dryBlockStart, code.indexOf('function releaseMode()')) : '';
    return /差分实测 ：真实发版会在写完之后顺手量一次/.test(dryBlock)
      && !/autoMeasureDelta\(/.test(dryBlock)
      && /--skip-delta/.test(dryBlock);
  })(),
  'releaseDryRun 里只打印说明、不调用实测',
);


check(
  '夜间 e2e：跑完也写一份 JSON 状态，落在应用 userData 里给设置页读',
  (() => {
    const code = read(path.join(ROOT, 'scripts', 'nightly-e2e.js'));
    const sameDir = /process\.env\.NYX_USER_DATA/.test(code) && /path\.join\(USER_DATA, 'nightly-e2e\.json'\)/.test(code);
    const writer = /function writeStatus\(row, extra = \{\}\)/.test(code) && /fs\.writeFileSync\(STATUS_FILE/.test(code);
    const calledInRun = /appendRecord\(\{[\s\S]{0,400}?\}\);\s*writeStatus\(/.test(code);
    // 写状态失败不许把一次跑成功的 e2e 判成失败
    const warnOnly = /状态文件没能写入/.test(code) && !/if \(!writeStatus\(/.test(code);
    return sameDir && writer && calledInRun && warnOnly;
  })(),
  'USER_DATA 同源、writeStatus 定义、在 appendRecord 之后调用、写失败只告警',
);

check(
  '夜间 e2e 状态：没跑过/通过/失败/太久没更新四种说法分开，坏数据不当成「跑过」',
  (() => {
    const { describeNightlyStatus, normalizeNightlyStatus } = require(path.join(ROOT, 'src', 'core', 'nightly-status.js'));
    const now = Date.UTC(2026, 10, 15, 0, 0, 0);
    const never = describeNightlyStatus(null, { now });
    const pass = describeNightlyStatus({ at: now - 3600e3, ok: true, total: 57, passed: 56, failed: 0, skipped: 1, baseline: '1.16.0' }, { now });
    const fail = describeNightlyStatus({ at: now - 3600e3, ok: false, error: 'exit=1', total: 57 }, { now });
    const stale = describeNightlyStatus({ at: now - 5 * 24 * 3600e3, ok: true, total: 57 }, { now });
    return never.level === 'never' && /还没跑过/.test(never.text)
      && pass.level === 'pass' && pass.rows.length >= 4 && /57 项断言 \/ 通过 56 \/ 失败 0 \/ 跳过 1/.test(pass.text)
      && fail.level === 'fail' && /exit=1/.test(fail.text)
      && stale.level === 'stale' && /别当成今天的状态/.test(stale.text)
      && normalizeNightlyStatus({}) === null
      && normalizeNightlyStatus({ at: 'x' }) === null
      && normalizeNightlyStatus({ at: now }) !== null;
  })(),
  '四种 level 与文案、`{}` 与非法 at 一律返回 null',
);

check(
  '夜间 e2e 状态：设置页只读展示，界面里没有任何「现在就跑」的入口',
  (() => {
    const mainCode = read(path.join(ROOT, 'src', 'main.js'));
    const preloadCode = read(path.join(ROOT, 'src', 'preload.js'));
    const htmlCode = read(path.join(ROOT, 'src', 'renderer', 'settings.html'));
    const settingsCode = read(path.join(ROOT, 'src', 'renderer', 'settings.js'));
    const wired = /ipcMain\.handle\('nyx:nightly:status'/.test(mainCode)
      && /userDataFile\(NIGHTLY_STATUS_FILE\)/.test(mainCode)
      && /nightlyStatus: \(\) => ipcRenderer\.invoke\('nyx:nightly:status'\)/.test(preloadCode)
      && /id="nightly-badge"/.test(htmlCode) && /id="nightly-grid"/.test(htmlCode)
      && /id="btn-nightly-refresh"/.test(htmlCode)
      && /async function loadNightlyStatus\(/.test(settingsCode)
      && /loadNightlyStatus\(\);/.test(settingsCode);
    // 只读的硬约束：整个界面里不存在"触发一次夜间 e2e"的通道
    const readOnly = !/nightlyRun|nightly-run|nightlyE2eRun/.test(preloadCode)
      && !/nightlyRun|nightly-run/.test(settingsCode)
      && !/nightlyRun|nightly-run/.test(mainCode);
    return wired && readOnly;
  })(),
  'IPC + preload + 四个 id + 加载函数都在，且没有任何触发跑 e2e 的入口',
);

check(
  '夜间计划任务：注册/删除之后必须复核，命令说成功但查不到一律算失败',
  (() => {
    const task = require(path.join(ROOT, 'src', 'core', 'nightly-task.js'));
    const okRegister = task.describeTaskAction('register', { ok: true, code: 0, taskName: task.DEFAULT_TASK_NAME }, { ok: true, registered: true, nextRun: '2026/11/15 3:30:00' });
    const ghost = task.describeTaskAction('register', { ok: true, code: 0, taskName: task.DEFAULT_TASK_NAME }, { ok: true, registered: false });
    const blind = task.describeTaskAction('register', { ok: true, code: 0, taskName: task.DEFAULT_TASK_NAME }, { ok: false, error: '读不出来' });
    const denied = task.describeTaskAction('register', { ok: true, code: 1, output: '', error: '错误: 拒绝访问。', taskName: task.DEFAULT_TASK_NAME }, { ok: true, registered: false });
    const removed = task.describeTaskAction('remove', { ok: true, code: 0, taskName: task.DEFAULT_TASK_NAME }, { ok: true, registered: false });
    const stillThere = task.describeTaskAction('remove', { ok: true, code: 0, taskName: task.DEFAULT_TASK_NAME }, { ok: true, registered: true });
    return okRegister.ok && /下次运行/.test(okRegister.text)
      && !ghost.ok && /查不到/.test(ghost.text) && /没生效/.test(ghost.text)
      && !blind.ok && /别当成已经成功/.test(blind.text)
      && !denied.ok && /拒绝访问/.test(denied.text) && /管理员/.test(denied.text)
      && removed.ok && /已经删掉/.test(removed.text)
      && !stillThere.ok && /还在/.test(stillThere.text)
      && task.isValidTime('03:30') && task.isValidTime('3:30') && !task.isValidTime('24:00') && !task.isValidTime('0330')
      && task.normalizeTime('3:5') === '03:30'
      && task.buildQueryArgs({}).args.join(' ').includes('/FO LIST')
      && /NOT_AVAILABLE|计划任务只能从源码目录注册/.test(task.resolveTaskPaths({ isPackaged: true }).error || '');
  })(),
  '四种结果（成功/查不到/读不出/拒绝访问）+ 删除后仍在 + 时间格式 + 安装版明确不支持',
);

check(
  '夜间计划任务：设置页能改时间、能删任务，但依然没有「现在就跑一次」的按钮',
  (() => {
    const mainCode = read(path.join(ROOT, 'src', 'main.js'));
    const preloadCode = read(path.join(ROOT, 'src', 'preload.js'));
    const htmlCode = read(path.join(ROOT, 'src', 'renderer', 'settings.html'));
    const settingsCode = read(path.join(ROOT, 'src', 'renderer', 'settings.js'));
    const wired = /ipcMain\.handle\('nyx:nightly:task'/.test(mainCode)
      && /ipcMain\.handle\('nyx:nightly:task-set'/.test(mainCode)
      && /ipcMain\.handle\('nyx:nightly:task-remove'/.test(mainCode)
      // 跑 schtasks 必须按 Buffer 取、按 GBK 解（否则中文报错变乱码 → 误判读不出来）
      && /spawnSync\('schtasks', args, \{ encoding: 'buffer'/.test(mainCode)
      && /decodeNightlyConsole\(res\.stdout\)/.test(mainCode)
      // 注册/删除都必须复核
      && /describeNightlyTaskAction\('register'/.test(mainCode)
      && /describeNightlyTaskAction\('remove'/.test(mainCode)
      && /resolveNightlyNode\(\)/.test(mainCode)
      && /nightlyTask: \(\) => ipcRenderer\.invoke\('nyx:nightly:task'\)/.test(preloadCode)
      && /nightlyTaskSet: \(payload\) => ipcRenderer\.invoke\('nyx:nightly:task-set'/.test(preloadCode)
      && /nightlyTaskRemove: \(\) => ipcRenderer\.invoke\('nyx:nightly:task-remove'\)/.test(preloadCode)
      && /id="nightly-time"/.test(htmlCode) && /id="btn-nightly-register"/.test(htmlCode)
      && /id="btn-nightly-remove"/.test(htmlCode) && /id="nightly-task-status"/.test(htmlCode)
      && /function renderNightlyTask\(/.test(settingsCode) && /function wireNightlyTask\(/.test(settingsCode)
      && /nightlyTaskSet\(\{ time, elevated: false \}\)/.test(settingsCode);
    // 「现在就跑」仍然是禁区：没有任何触发 run 的通道
    const noRunButton = !/nightlyRun|nightly-run|nightlyE2eRun/.test(preloadCode)
      && !/nightlyRun|nightly-run/.test(settingsCode)
      && !/nightlyRun|nightly-run/.test(htmlCode);
    return wired && noRunButton;
  })(),
  '三个 IPC + 三个 preload 方法 + 四个 id + 跑一遍的通道依然不存在',
);

// 12) 安装器不许把 latest.json 指向的那一版安装包删掉
//     （以前裸删 updates\*.exe，装完就把清单指向的包一起删了，旧机器升不上来）
const installerNsh = read(path.join(ROOT, 'build', 'installer.nsh'));
check(
  '安装后保留刚装上的那一版安装包',
  /\$\{If\} \$\{FileExists\} "\$APPDATA\\Nyx\\updates\\Nyx-Setup-\$\{VERSION\}\.exe"/.test(installerNsh),
  '必须先在删除前把 Nyx-Setup-${VERSION}.exe 挪开，删完再挪回来'
);
check(
  '不再裸删更新源里的全部 exe',
  !/^\s*Delete "\$APPDATA\\Nyx\\updates\\\*\.exe"\s*$/m.test(installerNsh),
  '禁止出现 Delete "$APPDATA\\Nyx\\updates\\*.exe"'
);
check(
  '清旧包只按 Nyx-Setup-*.exe 通配',
  /Delete "\$APPDATA\\Nyx\\updates\\Nyx-Setup-\*\.exe"/.test(installerNsh),
  '不许删更新源里别的 exe（用户可能放在那里给自己看的）'
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
