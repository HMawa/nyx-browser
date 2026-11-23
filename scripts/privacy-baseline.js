/**
 * 隐私「对照基准」生成器（1.20.0，P1-1）。
 *
 * 与 `scripts/privacy-audit.js` 的分工：
 *   · `privacy-audit.js` 出的是「这一版的自检存证」（给人读的 md，随仓库公开）；
 *   · 本脚本出的是「机器比对的基准」（docs/privacy-baseline/<日期>.json），
 *     只存 id / level / title / reason，观察值与真实值一律不出本机。
 *
 * 用法：
 *   node scripts/privacy-baseline.js            # 跑一次自检并写基准
 *   node scripts/privacy-baseline.js --dry-run  # 只打印，不写文件
 *   node scripts/privacy-baseline.js --raw      # 额外把原始值写到 temp/privacy-baseline/（不入库，勿分享）
 *   node scripts/privacy-baseline.js --check    # 只校验已有基准是否干净（发版门禁用）
 *   node scripts/privacy-baseline.js --keep 6   # 仓库里只留最新 6 份
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'privacy-baseline');
/** 原始值只落这里：temp 不入库。 */
const RAW_DIR = path.join(ROOT, 'temp', 'privacy-baseline');

const privacyBaseline = require(path.join(ROOT, 'src', 'core', 'privacy-baseline.js'));
const privacyCheck = require(path.join(ROOT, 'src', 'core', 'privacy-check.js'));
const { measure } = require(path.join(__dirname, 'privacy-audit.js'));

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

/** 已安装的 Nyx 读哪个目录：`NYX_USER_DATA` 优先（验证时隔离），否则 `%APPDATA%\Nyx`。 */
function resolveUserData() {
  const overridden = String(process.env.NYX_USER_DATA || '').trim();
  if (overridden) return overridden;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Nyx');
}

function listBaselines() {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
}

function readPreviousBaseline(excludeName) {
  const names = listBaselines().filter((name) => name !== excludeName);
  if (names.length === 0) return null;
  const name = names[names.length - 1];
  const file = path.join(OUT_DIR, name);
  try {
    const parsed = privacyBaseline.parseBaseline(fs.readFileSync(file, 'utf8'));
    return parsed.ok ? { name, baseline: parsed.baseline } : null;
  } catch (error) {
    return null;
  }
}

/**
 * 「这份基准干净吗」的判据。
 *
 * 不只看字段（parseBaseline 已经管了），还要看文本里有没有漏出来的东西：
 * 内网地址、长十六进制串（哈希）、真实 UA 串。这正是审计最爱抽查的三条。
 */
function inspectCleanliness(text) {
  const problems = [];
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text)) problems.push('出现 IPv4 地址');
  if (/\b[0-9a-f]{24,}\b/i.test(text)) problems.push('出现长十六进制串（画布/音频哈希之类）');
  if (/Electron\/\d/.test(text) || /Chrome\/\d{3,}/.test(text)) problems.push('出现真实 UA 串');
  if (/"observed"|"truth"/.test(text)) problems.push('出现 observed / truth 字段');
  const parsed = privacyBaseline.parseBaseline(text);
  if (!parsed.ok) problems.push(parsed.error);
  return { problems, parsed };
}

function checkMode() {
  const names = listBaselines();
  if (names.length === 0) {
    console.error(`✘ docs/privacy-baseline/ 里还没有任何基准（先跑 node scripts/privacy-baseline.js）`);
    process.exitCode = 1;
    return;
  }
  const name = names[names.length - 1];
  const file = path.join(OUT_DIR, name);
  const text = fs.readFileSync(file, 'utf8');
  const { problems, parsed } = inspectCleanliness(text);
  if (problems.length) {
    console.error(`✘ 最新基准不干净：docs/privacy-baseline/${name}`);
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ 最新基准干净：docs/privacy-baseline/${name}（${parsed.baseline.rows.length} 项，${text.length} 字节）`);
  console.log(`  ${privacyBaseline.describeBaseline(parsed.baseline)}`);
}

async function main() {
  if (hasFlag('--check')) {
    checkMode();
    return;
  }

  const result = await measure();
  const baseline = privacyBaseline.buildBaseline(result.rows || [], result.meta, {});
  baseline.identity = result.devAppMode || baseline.identity || '';
  const text = `${JSON.stringify(baseline, null, 2)}\n`;

  const { problems, parsed } = inspectCleanliness(text);
  if (!parsed.ok) throw new Error(`生成的基准自己就不合法：${parsed.error}`);
  if (problems.length) throw new Error(`生成的基准不干净（不该写盘）：${problems.join('、')}`);

  const name = privacyBaseline.baselineFileName(baseline.at);
  const previous = readPreviousBaseline(name);
  const compare = previous
    ? privacyBaseline.compareBaseline(result.rows || [], previous.baseline)
    : { comparable: false, lines: ['这是第一份基准，没有可比对的上一份。'] };

  if (hasFlag('--dry-run')) {
    console.log(text);
    console.log(`[隐私基准] ${privacyBaseline.describeBaseline(baseline)}`);
    for (const line of compare.lines) console.log(`  · ${line}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, text, 'utf8');

  // 已安装的 Nyx 读的是 userData 里的那份（打包产物不含 docs/），所以这里同步一份过去。
  // 写不进去只告警：装没装本机应用不影响仓库里的存证。
  let userDataPath = '';
  try {
    const dir = path.join(resolveUserData(), 'privacy-baseline');
    fs.mkdirSync(dir, { recursive: true });
    userDataPath = path.join(dir, name);
    fs.writeFileSync(userDataPath, text, 'utf8');
  } catch (error) {
    console.warn(`[隐私基准] 没能同步到应用目录：${error.message}（仓库里的那份仍然有效）`);
  }

  // 只保留最近的若干份，老的删掉；删了什么要打出来，不静默。
  const keepLimit = Number(flagValue('--keep', privacyBaseline.MAX_BASELINES)) || privacyBaseline.MAX_BASELINES;
  const plan = privacyBaseline.keepLatestNames(listBaselines(), keepLimit);
  for (const dropName of plan.drop) {
    try {
      fs.rmSync(path.join(OUT_DIR, dropName), { force: true });
      console.log(`[隐私基准] 归档轮换：删掉较旧的 docs/privacy-baseline/${dropName}`);
    } catch (error) {
      console.warn(`[隐私基准] 删不掉 docs/privacy-baseline/${dropName}：${error.message}`);
    }
  }

  if (hasFlag('--raw')) {
    // 原始值只进 temp（不入库）：排障要真值，但真值不许跟着仓库走。
    try {
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const rawFile = path.join(RAW_DIR, `${name.replace(/\.json$/, '')}-raw.json`);
      const raw = {
        at: new Date().toISOString(),
        mode: result.devAppMode || 'private',
        elapsedMs: result.elapsedMs,
        notes: result.notes || [],
        reportJson: privacyCheck.buildReportJson(result.rows || [], result.meta, { redact: false }),
      };
      fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      console.log(`[隐私基准] 原始值（含真实值，勿分享）：temp/privacy-baseline/${path.basename(rawFile)}`);
    } catch (error) {
      console.warn(`[隐私基准] 原始值没写成：${error.message}（不影响脱敏基准）`);
    }
  }

  console.log(`[隐私基准] 已写入 docs/privacy-baseline/${name}（${text.length} 字节，只存结论）`);
  if (userDataPath) console.log(`[隐私基准] 已同步到应用目录：${userDataPath}`);
  console.log(`[隐私基准] ${privacyBaseline.describeBaseline(baseline)}`);
  console.log(`[隐私基准] 与上一份（${previous ? previous.name : '无'}）对照：`);
  for (const line of compare.lines) console.log(`  · ${line}`);
  console.log(`[隐私基准] 用时 ${result.elapsedMs} 毫秒`);
}

main().catch((error) => {
  console.error(`[隐私基准] 失败：${error.message}`);
  console.error('  这一步失败不会自动跳过：基准跑不出来说明自检或判定坏了，先修那个。');
  process.exitCode = 1;
});
