/**
 * 隐私自检存证：跑一次真实自检，把结果写成 `docs/privacy-audit/<版本>.md`。
 *
 * 为什么要有这个脚本：
 *   · 设置页里那张表是"给现在的用户看的"，跑完就没了；
 *   · 每次发版都留一份，才能看出"这一版比上一版多伪装了什么、又退化了什么"。
 *
 * 口径（很重要，别改成"看起来更强"的说法）：
 *   · 报告只证明它测到的面；TLS 指纹、HTTP/2 帧序、字体全量枚举都不在范围内；
 *   · DNS 出口恒为「测不到」——自检不去向第三方要答案；
 *   · 不产生分数，也不给单一结论值（好/坏）之外的东西。
 *
 * 用法：
 *   node scripts/privacy-audit.js            # 跑一次并写文件
 *   node scripts/privacy-audit.js --dry-run   # 只打印，不写文件
 *   node scripts/privacy-audit.js --check     # 只校验上一次的存证是否还在（发版门禁用）
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'privacy-audit');
/** 原始（未脱敏）存证只落在这里：temp 不入库，`--raw` 才写。 */
const RAW_DIR = path.join(ROOT, 'temp', 'privacy-audit');
const WAIT_MS = 90_000;

const { pickFreePort } = require(path.join(__dirname, 'lib', 'free-port.js'));
const privacyCheck = require(path.join(ROOT, 'src', 'core', 'privacy-check.js'));

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function versionOf() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return String(pkg.version || '0.0.0');
}

/** 上一次存证（按版本号倒序取第一个不是本次的） */
function previousAudit(currentVersion) {
  if (!fs.existsSync(OUT_DIR)) return null;
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name))
    .sort((a, b) => compareVersion(b.replace('.md', ''), a.replace('.md', '')));
  for (const name of files) {
    const version = name.replace('.md', '');
    if (version === currentVersion) continue;
    const file = path.join(OUT_DIR, name);
    try {
      return { version, file, text: fs.readFileSync(file, 'utf8') };
    } catch (error) {
      /* 读不了就当没有 */
    }
  }
  return null;
}

function compareVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/** 从旧报告的逐项结果里抠出 `A1 已伪装` 这种行，用来算差异 */
function levelsFromReport(text) {
  const levels = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\|\s*([A-D]\d)\s+[^|]*\|\s*([^|]+?)\s*\|/);
    if (match) levels.set(match[1], match[2].trim());
  }
  return levels;
}

async function readToken(userData, child) {
  const file = path.join(userData, 'api-token.txt');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return '';
    try {
      const token = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (token) return token;
    } catch (error) {
      /* 还没写出来 */
    }
    await sleep(250);
  }
  return '';
}

async function waitHealthy(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return true;
    } catch (error) {
      await sleep(250);
    }
  }
  return false;
}

/**
 * 本地接口**实际**监听的端口。
 *
 * 为什么不能直接用 `NYX_API_PORT`：`startHttpApi` 在偏好端口被占时会换一个，
 * 然后把真端口写进 `api-port.txt`。只看环境变量就会一直等一个没人听的端口，
 * 表现成"本地接口没就绪"，把真正的原因（端口被占）掩盖掉。
 */
async function readApiPort(userData, fallback) {
  const file = path.join(userData, 'api-port.txt');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = Number(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim());
      if (Number.isInteger(value) && value > 0) return value;
    } catch (error) {
      /* 还没写出来 */
    }
    await sleep(200);
  }
  return fallback;
}

async function readDevtoolsPort(userData, child) {
  const file = path.join(userData, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null;
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0];
      const port = Number(first);
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      /* 等它出现 */
    }
    await sleep(200);
  }
  return null;
}

async function callCheck(cdpPort) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = list.find((target) => target.type === 'page' && /index\.html/.test(target.url)) || list.find((target) => target.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');

  const expression = 'window.nyx.privacyCheck()';
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('自检调用超时（30 秒）')), 30_000);
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      ws.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);
        if (data.id !== 1) return;
        clearTimeout(timer);
        resolve(data);
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      });
    });
    const result = reply.result && reply.result.result ? reply.result.result.value : null;
    if (!result || result.ok === false) {
      throw new Error(`自检没跑成：${(result && result.error) || '返回为空'}`);
    }
    return result;
  } finally {
    try {
      ws.close();
    } catch (error) {
      /* 关不上也不影响结论 */
    }
  }
}

async function measure() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-audit-'));
  const preferredPort = await pickFreePort();
  const cdpPort = await pickFreePort();
  const env = { ...process.env, NYX_USER_DATA: userData, NYX_API_PORT: String(preferredPort), NYX_VERIFY: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  // 调试端口由我们自己指定：进程不一定写 DevToolsActivePort 文件，等它是碰运气
  const child = spawn(electron, ['.', `--remote-debugging-port=${cdpPort}`], { cwd: ROOT, env, stdio: 'ignore' });

  try {
    const token = await readToken(userData, child);
    if (!token) throw new Error('没拿到本地接口 token（实例可能没起来）');
    const port = await readApiPort(userData, preferredPort);
    if (!(await waitHealthy(port))) {
      throw new Error(`本地接口没就绪（试的是 127.0.0.1:${port}，偏好端口 ${preferredPort}）`);
    }

    // 切到隐私模式：自检要证明的是"隐私模式伪装了什么"，不是普通模式
    const switchRes = await fetch(`http://127.0.0.1:${port}/mode/switch`, {
      method: 'POST',
      headers: { 'x-nyx-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'private' }),
    }).then((res) => res.json());
    if (!switchRes || switchRes.ok === false) {
      // 接口的失败字段是 `message`（早期版本这里读的是不存在的 `error`，一直显示"未知原因"）
      const why = (switchRes && (switchRes.message || switchRes.error || switchRes.reason)) || '返回为空';
      throw new Error(`切不到隐私模式：${why}`);
    }
    await sleep(1500);

    const result = await callCheck(cdpPort);
    result.devAppMode = switchRes.mode || 'private';
    return result;
  } finally {
    try {
      child.kill();
    } catch (error) {
      /* 已经退了 */
    }
    await sleep(300);
    try {
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      /* Electron 可能还捏着目录，不为此失败 */
    }
  }
}

function buildMarkdown(result, version) {
  const previous = previousAudit(version);
  const nowLevels = new Map((result.rows || []).map((row) => [row.id, row.level]));
  const beforeLevels = previous ? levelsFromReport(previous.text) : new Map();
  const diff = [];
  for (const [id, level] of nowLevels) {
    if (!beforeLevels.size) break;
    const before = beforeLevels.get(id);
    if (!before) diff.push(`- ${id} 新增（${level}）`);
    else if (before !== level) diff.push(`- ${id} ${before} → ${level}`);
  }
  for (const id of beforeLevels.keys()) {
    if (!nowLevels.has(id)) diff.push(`- ${id} 本版缺失`);
  }

  const lines = [];
  lines.push(`# Nyx ${version} · 隐私模式自检存证`);
  lines.push('');
  lines.push('> 这份文件由 `node scripts/privacy-audit.js` 生成，随仓库公开。它只证明**它测到的面**：');
  lines.push('> TLS 指纹、HTTP/2 帧序、字体全量枚举都不在范围内；DNS 出口恒为「测不到」。这里没有分数。');
  lines.push('');
  lines.push(`- 生成时间：${result.meta && result.meta.at ? result.meta.at : ''}`);
  lines.push(`- 版本：${result.meta ? result.meta.version : version}｜Electron：${result.meta ? result.meta.electron : ''}｜Chromium：${result.meta ? result.meta.chromium : ''}`);
  lines.push(`- 自检时模式：${result.devAppMode || 'private'}｜代理内核：${result.meta && result.meta.kernelRunning ? '在运行' : '未运行'}`);
  lines.push(`- 用时：${result.elapsedMs} 毫秒｜结论：${result.summary ? result.summary.headline : ''}`);
  lines.push('');
  lines.push('## 逐项结果');
  lines.push('');
  lines.push('> 这份存证随仓库公开，所以「真实值」一列默认隐藏；泄漏/可疑项的观察值本身就等于真实值，也一并隐藏。');
  lines.push('> 需要排障请在本地跑 `node scripts/privacy-audit.js --raw`，原始 JSON 只写到 `temp/privacy-audit/`（不入库），**不要分享**。');
  lines.push('');
  lines.push('| 项 | 结果 | 观察值 | 真实值 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');
  const secrets = secretsOf(result.rows);
  for (const row of result.rows || []) {
    const risky = row.level === 'leak' || row.level === 'suspect';
    const observed = risky ? '—（与真实值相同，已隐藏）' : stringifyValue(row.observed);
    const reason = scrubText(String(row.reason || ''), secrets).replace(/\|/g, '\\|');
    lines.push(`| ${row.id} ${row.title || ''} | ${row.level} | ${observed} | —（已隐藏） | ${reason} |`);
  }
  lines.push('');
  lines.push(`## 与上一版（${previous ? previous.version : '无'}）的差异`);
  lines.push('');
  if (!previous) lines.push('- 这是第一份存证，没有可比对的上一版。');
  else if (!diff.length) lines.push('- 逐项结果与上一版完全相同。');
  else lines.push(...diff);
  lines.push('');
  if (result.notes && result.notes.length) {
    lines.push('## 本次补充说明');
    lines.push('');
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  lines.push('## 诚实边界');
  lines.push('');
  lines.push('- 自检只覆盖 UA/平台/语言/时区/核数/屏幕/画布/音频/WebGL/WebRTC/出口地址/行为约束这些面。');
  lines.push('- DNS 出口不做第三方探测，因此永远显示「测不到」——宁可说测不到，也不去问外部要一个"看起来安全"的答案。');
  lines.push('- 不提供隐私评分：单一分数会掩盖"哪一项没测到"。');
  lines.push('');
  return lines.join('\n');
}

function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.length ? value.join('、') : '（空）';
  if (typeof value === 'object') {
    return Object.keys(value)
      .map((key) => `${key}=${Array.isArray(value[key]) ? value[key].join('/') : value[key]}`)
      .join('，');
  }
  return String(value);
}

/**
 * 收集「真实值」里的字符串，用于把说明文字里带到的真值打掉。
 *
 * 为什么不只隐藏表格那一列：判定理由里会写「页面读到的核数 24 与本机真实核数一致」这样的句子，
 * 只藏列不藏句子，等于把真值换个地方公开。
 */
function secretsOf(rows) {
  const found = new Set();
  const add = (value) => {
    const text = value === null || value === undefined ? '' : String(value).trim();
    if (!text) return;
    if (/^\d+$/.test(text) ? text.length >= 2 : text.length >= 3) found.add(text);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const truth = row.truth;
    if (truth === null || truth === undefined) continue;
    if (Array.isArray(truth)) truth.forEach(add);
    else if (typeof truth === 'object') Object.keys(truth).forEach((key) => add(truth[key]));
    else add(truth);
  }
  return Array.from(found);
}

function scrubText(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    if (/^\d+$/.test(secret)) {
      out = out.replace(new RegExp(`(^|[^\\d.])${secret}(?![\\d.])`, 'g'), (whole, before) => `${before}—`);
    } else if (out.indexOf(secret) >= 0) {
      out = out.split(secret).join('—');
    }
  }
  return out;
}

async function main() {
  const version = versionOf();

  if (hasFlag('--check')) {
    const file = path.join(OUT_DIR, `${version}.md`);
    if (!fs.existsSync(file)) {
      console.error(`✘ 缺少本版存证：docs/privacy-audit/${version}.md（发版前必须先跑一次 privacy-audit）`);
      process.exitCode = 1;
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    const ok =
      text.includes('## 与上一版') &&
      text.includes('诚实边界') &&
      text.includes('已隐藏') &&
      !/Electron\/\d/.test(text);
    console.log(
      ok
        ? `✔ 本版存证在位且已脱敏：docs/privacy-audit/${version}.md（${text.length} 字节）`
        : '✘ 存证内容不完整或没脱敏（需要差异段、诚实边界，且不许出现真实 UA 串）',
    );
    if (!ok) process.exitCode = 1;
    return;
  }

  const result = await measure();
  const markdown = buildMarkdown(result, version);

  if (hasFlag('--dry-run')) {
    console.log(markdown);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${version}.md`);
  fs.writeFileSync(file, markdown, 'utf8');
  console.log(`[隐私自检存证] 已写入 docs/privacy-audit/${version}.md（${markdown.length} 字节，已脱敏）`);

  if (hasFlag('--raw')) {
    // 原始版只进 temp（不入库）：排障要原始值，但原始值不许跟着仓库走。
    try {
      fs.mkdirSync(RAW_DIR, { recursive: true });
      const rawFile = path.join(RAW_DIR, `${version}.json`);
      const raw = {
        at: new Date().toISOString(),
        mode: result.devAppMode || 'private',
        elapsedMs: result.elapsedMs,
        notes: result.notes || [],
        reportJson: privacyCheck.buildReportJson(result.rows || [], result.meta, { redact: false }),
      };
      fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2), 'utf8');
      console.log(`[隐私自检存证] 原始版（含真实值，勿分享）：temp/privacy-audit/${version}.json`);
    } catch (error) {
      console.warn(`[隐私自检存证] 原始版没写成：${error.message}（不影响脱敏存证）`);
    }
  }
  console.log(`[隐私自检存证] 结论：${result.summary ? result.summary.headline : ''}｜用时 ${result.elapsedMs} 毫秒`);
}

// 被 `scripts/privacy-baseline.js` 复用：那条脚本要跑同一套「起实例 → 切隐私 → 自检」流程，
// 抄一份就会两处漂移（比如水位线、token 口径）。所以这里导出，只在直接执行时才跑 main。
module.exports = { buildMarkdown, measure };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[隐私自检存证] 失败：${error.message}`);
    console.error('  这一步失败不会自动跳过：发版前必须能跑出存证；跑不出来说明自检本身坏了。');
    process.exitCode = 1;
  });
}
