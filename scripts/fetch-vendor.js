#!/usr/bin/env node
'use strict';

/**
 * Nyx · 内置代理内核与 geo 数据获取脚本
 *
 * 用途：仓库不随源码分发 mihomo 内核二进制（约 61MB）与 geo 数据（约 13MB），
 *       首次运行前执行本脚本，从上游下载并按 vendor/mihomo/VERSION.txt 记录的
 *       SHA256 校验后落盘。
 *
 * 用法：
 *   node scripts/fetch-vendor.js            下载缺失的产物并校验
 *   node scripts/fetch-vendor.js --dry-run  只解析 VERSION.txt、打印下载计划，不联网下载
 *   node scripts/fetch-vendor.js --force    忽略本地已有产物，全部重新下载
 *
 * 设计约束：
 *   - 只使用 Node 内置模块（https/crypto/fs/zlib/path/os），无第三方依赖。
 *   - Node 18+；Windows / macOS / Linux 均可运行（内核目前仅取 windows-amd64）。
 *   - 幂等：本地产物校验通过即跳过；校验不一致才重新下载（--force 可强制刷新）。
 *   - 任一步失败都以退出码 1 结束，绝不静默降级。
 *
 * 校验口径说明（重要）：
 *   vendor/mihomo/VERSION.txt 里的 SHA256 是**解压后 mihomo.exe 的 SHA256**，
 *   不是 zip 包的 SHA256。因此本脚本在解压后校验 exe；同时在能取到上游
 *   release digest 时，额外校验 zip 包本身。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

/*
 * 许可提示：本脚本下载的 mihomo（Clash Meta）内核与 geo 数据均为 **GPL-3.0**，
 * 与本项目自身的 MIT 许可证不同。两者不可混同：
 *   - 内核以独立进程方式运行，本项目对其未作任何修改；
 *   - 权利义务与源码获取方式见仓库根目录 THIRD-PARTY-NOTICES.md；
 *   - GPL-3.0 许可证全文见 licenses/GPL-3.0.txt。
 */

const ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'mihomo');
const VERSION_FILE = path.join(VENDOR_DIR, 'VERSION.txt');
const EXE_PATH = path.join(VENDOR_DIR, 'mihomo.exe');
const GEO_DIR = path.join(VENDOR_DIR, 'geo');
const GEO_CACHE_FILE = path.join(GEO_DIR, '.sha256-cache.json');

// geo 数据来自 MetaCubeX/meta-rules-dat 的 latest release（每日滚动更新）
const GEO_BASE = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/';
const GEO_ASSETS = ['geoip.metadb', 'geosite.dat'];

const UA = 'nyx-fetch-vendor/1.0 (+https://github.com/)';
const MAX_REDIRECTS = 6;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');

// ---------- 小工具 ----------

function log(msg) {
  process.stdout.write(msg + '\n');
}

function fail(msg) {
  process.stderr.write('\n[失败] ' + msg + '\n');
  process.exit(1);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// ---------- VERSION.txt ----------

function readVersionFile() {
  if (!fs.existsSync(VERSION_FILE)) {
    fail('找不到 ' + path.relative(ROOT, VERSION_FILE) + '，仓库结构不完整。');
  }
  const text = fs.readFileSync(VERSION_FILE, 'utf8');

  const versionMatch = text.match(/\bv\d+\.\d+\.\d+\b/);
  const shaMatch = text.match(/\b([0-9a-fA-F]{64})\b/);
  const urlMatch = text.match(/https?:\/\/\S+\.zip/i);

  if (!versionMatch) fail('VERSION.txt 中解析不到内核版本号（形如 v1.19.31）。');
  if (!shaMatch) fail('VERSION.txt 中解析不到 64 位 SHA256 校验值。');
  if (!urlMatch) fail('VERSION.txt 中解析不到内核 zip 下载地址。');

  return {
    version: versionMatch[0],
    exeSha256: shaMatch[1].toLowerCase(),
    zipUrl: urlMatch[0],
  };
}

// ---------- HTTP ----------

function request(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(new Error('非法 URL: ' + url));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject(new Error('不支持的协议: ' + parsed.protocol));
    }
    const req = https.get(
      parsed,
      { headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity' } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向次数过多: ' + url));
          const next = new URL(res.headers.location, parsed).toString();
          return request(next, redirectsLeft - 1).then(resolve, reject);
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + status + ' ' + url));
        }
        resolve(res);
      }
    );
    req.setTimeout(60000, () => req.destroy(new Error('请求超时: ' + url)));
    req.on('error', reject);
  });
}

async function fetchText(url, maxBytes = 8192) {
  const res = await request(url);
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        res.destroy();
        return reject(new Error('响应过大: ' + url));
      }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadToFile(url, dest) {
  const res = await request(url);
  const total = Number(res.headers['content-length'] || 0);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let received = 0;
  let lastPrint = 0;

  res.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 1000) {
      lastPrint = now;
      const pct = total ? Math.floor((received / total) * 100) : 0;
      process.stdout.write(
        '\r    下载中 ' + (total ? pct + '%' : mb(received)) + '（' + mb(received) + (total ? ' / ' + mb(total) : '') + '）   '
      );
    }
  });

  await new Promise((resolve, reject) => {
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  if (received === 0) fail('下载内容为空: ' + url);
  if (total && received !== total) {
    fail('下载不完整（' + received + ' / ' + total + ' 字节）: ' + url);
  }
  process.stdout.write('\r' + ' '.repeat(64) + '\r');
  return { bytes: received, sha256: hash.digest('hex') };
}

async function fetchJson(url) {
  const text = await fetchText(url, 4 * 1024 * 1024);
  return JSON.parse(text);
}

// ---------- zip 解压（纯 JS，只依赖 zlib） ----------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function listZipEntries(buf) {
  const minPos = Math.max(0, buf.length - 66000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip 文件（找不到中央目录结束标记）。');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的内核压缩包。');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('zip 中央目录损坏（第 ' + i + ' 项）。');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的内核压缩包。');
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipEntry(buf, entry) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== SIG_LOCAL) throw new Error('zip 本地头损坏: ' + entry.name);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);

  let data;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else if (entry.method === 8) {
    data = zlib.inflateRawSync(raw);
  } else {
    throw new Error('不支持的压缩方式（method=' + entry.method + '）: ' + entry.name);
  }
  if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
    throw new Error('解压长度不符: ' + entry.name);
  }
  return data;
}

function pickExeEntry(entries) {
  const exes = entries.filter((e) => /\.exe$/i.test(e.name));
  if (exes.length === 0) {
    throw new Error('压缩包内没有 .exe 可执行文件，可能上游命名变了。');
  }
  exes.sort((a, b) => {
    const aPref = /mihomo/i.test(a.name) ? 1 : 0;
    const bPref = /mihomo/i.test(b.name) ? 1 : 0;
    if (aPref !== bPref) return bPref - aPref;
    return b.uncompressedSize - a.uncompressedSize;
  });
  return exes[0];
}

// ---------- 内核 ----------

/** 尽力从上游 release API 取 zip 自身的 sha256（取不到不影响主流程）。 */
async function resolveZipDigest(zipUrl) {
  const base = path.basename(new URL(zipUrl).pathname);
  const m = zipUrl.match(/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//);
  if (!m) return null;
  try {
    const api =
      'https://api.github.com/repos/' + m[1] + '/' + m[2] + '/releases/tags/' + encodeURIComponent(m[3]);
    const release = await fetchJson(api);
    const asset = (release.assets || []).find((a) => a.name === base);
    const digest = asset && typeof asset.digest === 'string' ? asset.digest : '';
    const hash = digest.startsWith('sha256:') ? digest.slice(7).toLowerCase() : '';
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  } catch (e) {
    return null;
  }
}

async function setupKernel(meta) {
  log('');
  log('[1/2] 代理内核 mihomo ' + meta.version + '（windows-amd64）');
  log('    来源: ' + meta.zipUrl);
  log('    期望 SHA256（解压后的 mihomo.exe）: ' + meta.exeSha256);

  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (!FORCE && fs.existsSync(EXE_PATH)) {
    const actual = sha256File(EXE_PATH);
    if (actual === meta.exeSha256) {
      log('    本地已存在 vendor/mihomo/mihomo.exe（' + mb(fs.statSync(EXE_PATH).size) + '），校验通过，跳过。');
      return;
    }
    log('    本地 mihomo.exe 校验不通过（' + actual + '），将重新下载。');
  }

  if (DRY_RUN) {
    log('    [dry-run] 计划: 下载 zip → 解压取 .exe → 校验 SHA256 → 写入 vendor/mihomo/mihomo.exe');
    return;
  }

  const tmpZip = path.join(os.tmpdir(), 'nyx-mihomo-' + process.pid + '.zip');
  try {
    log('    下载中（约 22MB）…');
    const zip = await downloadToFile(meta.zipUrl, tmpZip);

    const expectedZip = await resolveZipDigest(meta.zipUrl);
    if (expectedZip) {
      if (zip.sha256 !== expectedZip) {
        fail('zip 包 SHA256 与上游 release digest 不一致。\n  实际: ' + zip.sha256 + '\n  期望: ' + expectedZip);
      }
      log('    zip 包校验通过（' + mb(zip.bytes) + '）。');
    } else {
      log('    提示: 未取到上游 zip digest，跳过 zip 级校验，改为校验解压后的 exe。');
    }

    const buf = fs.readFileSync(tmpZip);
    const entry = pickExeEntry(listZipEntries(buf));
    log('    压缩包内可执行文件: ' + entry.name + '（' + mb(entry.uncompressedSize || 0) + '）');
    const data = extractZipEntry(buf, entry);

    const actualExe = crypto.createHash('sha256').update(data).digest('hex');
    if (actualExe !== meta.exeSha256) {
      fail(
        '解压后的 mihomo.exe SHA256 与 VERSION.txt 不一致，已中止（未写入任何文件）。\n' +
          '  实际: ' + actualExe + '\n' +
          '  期望: ' + meta.exeSha256 + '\n' +
          '  可能原因: 上游重新打包了该版本，或下载被中间人篡改。请人工核对后更新 VERSION.txt。'
      );
    }

    const tmpExe = EXE_PATH + '.tmp';
    fs.writeFileSync(tmpExe, data);
    fs.renameSync(tmpExe, EXE_PATH);
    try {
      fs.chmodSync(EXE_PATH, 0o755);
    } catch (e) {
      /* Windows 上无意义，忽略 */
    }
    log('    完成: vendor/mihomo/mihomo.exe（' + mb(data.length) + '），SHA256 校验通过。');
  } finally {
    try {
      fs.unlinkSync(tmpZip);
    } catch (e) {
      /* 临时文件可能不存在 */
    }
  }
}

// ---------- geo 数据 ----------

function readGeocache() {
  try {
    return JSON.parse(fs.readFileSync(GEO_CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeGeocache(cache) {
  fs.mkdirSync(GEO_DIR, { recursive: true });
  fs.writeFileSync(GEO_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

/** 取某个 geo 资产的期望 sha256：优先官方 .sha256sum sidecar，其次 release API 的 digest。 */
async function resolveGeoDigest(name) {
  try {
    const text = await fetchText(GEO_BASE + name + '.sha256sum', 4096);
    const m = text.match(/\b([0-9a-fA-F]{64})\b/);
    if (m) return m[1].toLowerCase();
  } catch (e) {
    /* 落到 API 兜底 */
  }
  try {
    const release = await fetchJson('https://api.github.com/repos/MetaCubeX/meta-rules-dat/releases/latest');
    const asset = (release.assets || []).find((a) => a.name === name);
    const digest = asset && typeof asset.digest === 'string' ? asset.digest : '';
    if (digest.startsWith('sha256:')) {
      const hash = digest.slice(7).toLowerCase();
      if (/^[0-9a-f]{64}$/.test(hash)) return hash;
    }
  } catch (e) {
    /* 两条路都不通 */
  }
  return null;
}

async function setupGeo() {
  log('');
  log('[2/2] geo 数据（MetaCubeX/meta-rules-dat latest release）');
  log('    来源: ' + GEO_BASE + '{geoip.metadb, geosite.dat}');

  fs.mkdirSync(GEO_DIR, { recursive: true });
  const cache = readGeocache();
  let downloaded = 0;

  for (const name of GEO_ASSETS) {
    const dest = path.join(GEO_DIR, name);
    const exists = fs.existsSync(dest);
    const localSha = exists ? sha256File(dest) : null;

    if (!FORCE && exists) {
      if (DRY_RUN) {
        log('    ' + name + '：本地已存在（' + mb(fs.statSync(dest).size) + '）；正式运行时会按上游 .sha256sum 校验，不一致则重新下载。');
        continue;
      }
      const expected = await resolveGeoDigest(name);
      if (expected && expected === localSha) {
        log('    ' + name + '：已存在且校验通过，跳过。');
        continue;
      }
      if (!expected && cache[name] && cache[name].sha256 === localSha) {
        log('    ' + name + '：已存在，本地记录的校验值与文件一致，跳过。');
        continue;
      }
      if (!expected) {
        log('    ' + name + '：已存在但无法确认上游摘要，保留本地文件（如需刷新请加 --force）。');
        continue;
      }
      log('    ' + name + '：本地文件与上游最新摘要不一致，重新下载。');
    }

    if (DRY_RUN) {
      log('    [dry-run] 计划: 下载 ' + GEO_BASE + name + ' 并按其 .sha256sum 校验后写入 vendor/mihomo/geo/');
      continue;
    }

    const expected = await resolveGeoDigest(name);
    const tmp = dest + '.tmp';
    log('    ' + name + '：下载中…');
    const got = await downloadToFile(GEO_BASE + name, tmp);

    if (expected && got.sha256 !== expected) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      fail(name + ' SHA256 校验失败。\n  实际: ' + got.sha256 + '\n  期望: ' + expected);
    }
    if (!expected) {
      log('    ' + name + '：未取到上游摘要，已记录本地摘要用于后续幂等校验（本次无法提供来源校验）。');
    }

    fs.renameSync(tmp, dest);
    cache[name] = { sha256: got.sha256, size: got.bytes, url: GEO_BASE + name };
    writeGeocache(cache);
    downloaded += 1;
    log('    ' + name + '：完成（' + mb(got.bytes) + '）' + (expected ? '，SHA256 校验通过。' : '。'));
  }

  if (!DRY_RUN && downloaded === 0) {
    log('    geo 数据均已就绪，未重复下载。');
  }
}

// ---------- 主流程 ----------

async function main() {
  if (HELP) {
    log('用法: node scripts/fetch-vendor.js [--dry-run] [--force]');
    log('  --dry-run  只打印下载计划，不联网下载');
    log('  --force    忽略本地已有产物，全部重新下载并校验');
    return;
  }

  const meta = readVersionFile();
  log('Nyx 依赖获取 · vendor/mihomo');
  log('  本次获取的 mihomo 内核与 geo 数据为 GPL-3.0 许可（本项目自身为 MIT），');
  log('  许可全文见 licenses/GPL-3.0.txt，说明见 THIRD-PARTY-NOTICES.md。');
  log('  VERSION.txt 解析: 内核 ' + meta.version + '，windows-amd64');
  if (DRY_RUN) log('  （dry-run：仅解析与打印计划，不下载任何文件）');
  if (FORCE) log('  （--force：忽略本地产物，全部重新下载）');

  await setupKernel(meta);
  await setupGeo();

  log('');
  log(DRY_RUN ? '计划已生成，未下载任何文件。' : '全部完成：vendor/mihomo 已就绪，可以执行 npm start。');
}

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});
