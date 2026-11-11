'use strict';

/**
 * Nyx 自动升级（OTA）服务。
 *
 * 目标：加功能、改文案、换版本之后，用户点一次「检查更新」就能完成覆盖升级，
 * 不需要重走安装向导，也不需要重新配置订阅与偏好。
 *
 * 更新源（由 %APPDATA%\Nyx\update-config.json 的 source 字段决定）：
 *   1. 本地目录（默认 %APPDATA%\Nyx\updates）—— 把新版安装包与 latest.json 一并放进去即可离线升级；
 *   2. http(s) 地址 —— 目录下同样要能取到 latest.json。
 *
 * latest.json 格式：
 *   {
 *     "version": "0.2.0",
 *     "notes": "本次更新说明（中文，可多行）",
 *     "file": "Nyx-Setup-0.2.0.exe",   // 相对更新源的安装包文件名
 *     "sha256": "…",                    // 选填，但强烈建议提供，缺失时不做完整性校验
 *     "size": 12345678,                 // 选填，仅用于进度显示
 *     "mandatory": false                // 选填，true 时提示语更强调
 *   }
 *
 * 升级流程：读清单 → 版本比较 → 复制/下载到 update-cache（支持断点续传） →
 *   流式 sha256 校验 → 拉起一个延迟执行的静默安装进程（/S）→ 应用自行退出 →
 *   安装程序覆盖安装 → 安装完成后自动启动新版。
 * 用户数据目录（%APPDATA%\Nyx，含订阅与偏好）不受影响。
 *
 * 下载与校验的两个细节：
 *   1) 下载先写 <文件>.part，中断后分片保留在 update-cache，下次自动带 Range 续传；
 *      清单版本变化后旧分片直接丢弃，避免把上一版的数据拼进新包；
 *   2) sha256 用 createReadStream 流式计算，不再 readFileSync 把 113MB 整包读进内存。
 *
 * 关于「差分更新」（electron-builder blockmap）的结论——本项目暂不实现：
 *   1) 本模块是自研 Updater，没有接 electron-updater，拿不到 blockmap 差分下载器；
 *   2) 差分要求本地保留「上一版安装包本体」做块比对，而 installer.nsh 升级后会删掉
 *      updates 目录里的 *.exe，天然缺少基线文件；
 *   3) 若未来要做：用已有的 %APPDATA%\Nyx\updates-archive 留档保留上一版 →
 *      引入 electron-updater 的 blockmap 差分下载 → 更新源同时提供 .blockmap 文件；
 *   4) 在此之前，「整包 + 断点续传 + 流式校验」是性价比最高的方案。
 *
 * 本模块只依赖 Node 内置模块，不引入任何第三方运行时依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

/**
 * 旧版默认更新源：早期把收件目录放在安装目录里（<安装目录>\updates）。
 * 覆盖安装会清理安装目录，升级包会被一并删掉，导致只能升一轮、下一轮检不到清单。
 * 默认源已迁到用户数据目录（%APPDATA%\Nyx\updates，跨升级保留），这里按当前安装目录
 * 推导出旧位置，仅作兼容回退。
 */

/**
 * 差分更新的最低命中率闸门（v1.7.0）。
 * 实测：真实 NSIS 安装包（LZMA 固实压缩流）跨版本块命中率为 0%，
 * 逐块 Range 拉全包反而更慢；因此命中率低于该阈值时直接走整包下载。
 * 设为 0.2（20%）：至少省两成流量才值得多付出这些往返。
 */
const DIFF_MIN_HIT_RATE = 0.2;
/** 清单文件名 */
const MANIFEST_NAME = 'latest.json';
/** 更新源配置文件名（位于 userData 目录） */
const CONFIG_NAME = 'update-config.json';
/** 升级包缓存目录名（位于 userData 目录） */
const CACHE_NAME = 'update-cache';

/**
 * 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 只比较前三段数字；带 - 后缀的预发布版低于同号正式版。
 */
function compareVersion(a, b) {
  const parse = (value) => {
    const text = String(value == null ? '0' : value).trim();
    const dash = text.indexOf('-');
    const core = dash >= 0 ? text.slice(0, dash) : text;
    const pre = dash >= 0 ? text.slice(dash + 1) : '';
    const nums = core.split('.').map((n) => {
      const v = Number.parseInt(n, 10);
      return Number.isFinite(v) ? v : 0;
    });
    return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre };
  };

  const x = parse(a);
  const y = parse(b);

  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  }

  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** 是否为 http(s) 更新源 */
function isRemoteSource(source) {
  return /^https?:\/\//i.test(String(source || '').trim());
}

/** 把 file:///D:/x 与 D:/x 统一成正斜杠无关的本地目录字符串 */
function toLocalDir(source) {
  let text = String(source || '').trim();
  if (/^file:\/\//i.test(text)) {
    text = decodeURIComponent(text.replace(/^file:\/\//i, ''));
    text = text.replace(/^\//, '');
  }
  return text;
}

class Updater {
  constructor(options = {}) {
    /** 用户数据目录（%APPDATA%\Nyx），配置与缓存都落在这里 */
    this.userDataDir = options.userDataDir;
    /** 当前应用版本号 */
    this.currentVersion = options.currentVersion || '0.0.0';
    /** 当前可执行文件路径（打包后即安装目录下的 Nyx.exe） */
    this.execPath = options.execPath || process.execPath;
    /** 是否已打包；开发模式只允许检查、不允许真正安装 */
    this.isPackaged = options.isPackaged === true;
    /** 日志（只收非敏感文案） */
    this.log = options.log || (() => {});
    /** 状态推送回调 */
    this.onState = options.onState || (() => {});

    /** 阶段：idle | checking | uptodate | available | downloading | ready | installing | error */
    this.phase = 'idle';
    this.message = '尚未检查更新';
    /** 远端清单 */
    this.manifest = null;
    /** 已校验通过的本地升级包路径 */
    this.readyFile = null;
    /** 下载进度（0-100） */
    this.progress = 0;
    this.checkedAt = null;
    this.lastError = null;
  }

  /* ---------------- 状态 ---------------- */

  getState() {
    return {
      phase: this.phase,
      message: this.message,
      currentVersion: this.currentVersion,
      source: this.readConfig().source,
      latestVersion: this.manifest ? this.manifest.version : null,
      notes: this.manifest ? this.manifest.notes || '' : '',
      mandatory: !!(this.manifest && this.manifest.mandatory),
      progress: this.progress,
      readyFile: this.readyFile,
      checkedAt: this.checkedAt,
      lastError: this.lastError,
      packaged: this.isPackaged,
    };
  }

  setState(patch) {
    Object.assign(this, patch);
    try {
      this.onState(this.getState());
    } catch (err) {
      this.log(`状态推送失败：${err.message}`);
    }
  }

  /* ---------------- 配置 ---------------- */

  configPath() {
    return path.join(this.userDataDir, CONFIG_NAME);
  }

  /** 默认更新源：用户数据目录下，覆盖安装不会清，可反复升级 */
  defaultSource() {
    return path.join(this.userDataDir, 'updates');
  }

  /** 目录里是否已有可用的更新清单 */
  hasManifest(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    try {
      return fs.existsSync(path.join(dir, MANIFEST_NAME));
    } catch {
      return false;
    }
  }

  /** 读取原始配置（不解析路径），写入时以它为基底，避免把解析结果固化进配置文件 */
  readRawConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath(), 'utf8'));
      return {
        source: typeof parsed.source === 'string' ? parsed.source.trim() : '',
        autoCheck: parsed.autoCheck !== false,
      };
    } catch {
      return { source: '', autoCheck: true };
    }
  }

  /**
   * 解析实际生效的更新源：显式配置 > 用户数据目录默认源 > 旧安装目录源（兼容旧安装）。
   */
  resolveSource() {
    const raw = this.readRawConfig();
    if (raw.source) return raw.source;
    const preferred = this.defaultSource();
    if (this.hasManifest(preferred)) return preferred;
    // 旧安装的收件目录在安装目录下，按当前可执行文件位置推导，不写死盘符
    const legacySource = path.join(path.dirname(this.execPath), 'updates');
    if (this.hasManifest(legacySource)) {
      this.log(`默认更新源 ${preferred} 暂无清单，本轮沿用旧目录 ${legacySource}`);
      return legacySource;
    }
    return preferred;
  }

  readConfig() {
    const raw = this.readRawConfig();
    return { source: this.resolveSource(), autoCheck: raw.autoCheck };
  }

  writeConfig(patch) {
    const next = Object.assign(this.readRawConfig(), patch || {});
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this.configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.log(`更新源配置写入失败：${err.message}`);
    }
    return next;
  }

  /** 升级包缓存目录 */
  cacheDir() {
    return path.join(this.userDataDir, CACHE_NAME);
  }

  /* ---------------- 网络 ---------------- */

  httpGetText(url, redirectLeft = 3) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(
        url,
        { headers: { 'User-Agent': `Nyx-Updater/${this.currentVersion}` } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
            res.resume();
            let next = res.headers.location;
            try {
              next = new URL(next, url).toString();
            } catch {
              /* 保持原样 */
            }
            resolve(this.httpGetText(next, redirectLeft - 1));
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`更新源返回 HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        },
      );
      req.setTimeout(20000, () => req.destroy(new Error('更新源请求超时')));
      req.on('error', reject);
    });
  }

  /** 分片文件路径（下载中的临时文件，校验通过后才改名为正式文件） */
  partFile(dest) {
    return `${dest}.part`;
  }

  /** 写分片元数据：记录分片属于哪个版本，用于「版本变化后丢弃旧分片」与续传提示 */
  writePartMeta(partFile, total, offset) {
    try {
      const manifest = this.manifest || {};
      fs.writeFileSync(
        `${partFile}.meta.json`,
        `${JSON.stringify(
          {
            version: manifest.version || null,
            file: manifest.file || null,
            sha256: manifest.sha256 || null,
            size: total || 0,
            offset: offset || 0,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    } catch {
      /* 元数据只用于续传提示与过期判断，写失败不影响下载本身 */
    }
  }

  /** 删除分片与其元数据（全量重下、校验失败、正常完成时都会用到） */
  removePart(partFile) {
    try {
      fs.unlinkSync(partFile);
    } catch {
      /* 不存在就算了 */
    }
    try {
      fs.unlinkSync(`${partFile}.meta.json`);
    } catch {
      /* 不存在就算了 */
    }
  }

  /**
   * 清掉「版本已经变了」的过期分片。
   * 清单版本变化后，旧版本的分片不可能再拼成新包，留着只会把续传逻辑带偏。
   */
  cleanupStaleParts() {
    const dir = this.cacheDir();
    if (!fs.existsSync(dir)) return;
    const current = this.manifest && this.manifest.version ? String(this.manifest.version) : '';
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith('.part.meta.json')) continue;
      const metaPath = path.join(dir, name);
      const partFile = path.join(dir, name.slice(0, -'.meta.json'.length));
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        meta = null;
      }
      if (!meta || !meta.version) continue;
      if (current && String(meta.version) === current) continue;
      this.log(`[升级] 检测到旧版本 ${meta.version} 的未完成下载，已删除过期分片`);
      this.removePart(partFile);
    }
  }

  /**
   * 下载升级包到 dest，支持断点续传：
   *   - 本地已有 *.part 且非空 → 请求带 Range: bytes=<已有大小>-；
   *   - 206 → 追加写（Content-Range 起点必须与本地分片一致，否则全量重下）；
   *   - 200 → 源不支持 Range，从头覆盖；
   *   - 416 → 分片越界（多半已完整或源文件变小），丢弃分片后重试一次全量。
   * 分片先落盘，由调用方在校验通过后改名为正式文件；失败保留分片供下次续传。
   */
  downloadToFile(url, dest, redirectLeft = 3, attempt = 0) {
    return new Promise((resolve, reject) => {
      const partFile = this.partFile(dest);
      const offset = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
      const expected = Number(this.manifest && this.manifest.size) || 0;

      // 分片其实已经下满（上次下完没来得及改名）：不再发请求，直接交给校验
      if (offset > 0 && expected > 0 && offset >= expected) {
        this.log(`[升级] 检测到已完成下载的分片（${offset} 字节），跳过网络直接校验`);
        resolve({ partFile, resumed: false, skipped: true });
        return;
      }

      const headers = { 'User-Agent': `Nyx-Updater/${this.currentVersion}` };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { headers }, (res) => {
        // 重定向：保留 Range 头继续跟，末尾的递归会重新读一次分片大小
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
          res.resume();
          let next = res.headers.location;
          try {
            next = new URL(next, url).toString();
          } catch {
            /* 保持原样 */
          }
          this.downloadToFile(next, dest, redirectLeft - 1, attempt).then(resolve, reject);
          return;
        }

        // 416：Range 起点越界，丢弃分片重试一次全量
        if (res.statusCode === 416 && offset > 0 && attempt < 1) {
          res.resume();
          this.log('[升级] 更新源返回 416（分片越界），已丢弃残留分片，改为全量下载');
          this.removePart(partFile);
          this.downloadToFile(url, dest, redirectLeft, attempt + 1).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          reject(new Error(`升级包下载失败：HTTP ${res.statusCode}`));
          return;
        }

        const partial = res.statusCode === 206;
        let total = 0;
        if (partial) {
          const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(res.headers['content-range'] || ''));
          if (match) {
            const start = Number(match[1]);
            total = match[3] === '*' ? 0 : Number(match[3]);
            // 长度对不上说明分片与源不是同一份文件，续传会拼出坏包
            if (offset > 0 && start !== offset) {
              res.resume();
              this.log(`[升级] 分片起点与本地不一致（本地 ${offset}，源 ${start}），改为全量下载`);
              this.removePart(partFile);
              this.downloadToFile(url, dest, redirectLeft, attempt + 1).then(resolve, reject);
              return;
            }
          }
        } else if (offset > 0) {
          this.log('[升级] 更新源不支持断点续传（返回 200），从头覆盖下载');
        }

        if (!total) total = Number(res.headers['content-length'] || 0) + (partial ? offset : 0);
        if (!total) total = expected;

        const base = partial ? offset : 0;
        if (base > 0) {
          const percent = total > 0 ? Math.floor((base / total) * 100) : 0;
          this.log(`[升级] 检测到未完成下载 ${percent}%（${base} / ${total} 字节），从断点续传`);
        }
        this.writePartMeta(partFile, total || expected, base);

        let received = 0;
        const out = fs.createWriteStream(partFile, { flags: base > 0 ? 'a' : 'w' });
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0) {
            // 沿用原有 downloading 阶段语义：progress = 已下载 / 总大小
            this.setState({ progress: Math.min(99, Math.round(((base + received) / total) * 100)) });
          }
        });
        res.on('error', (err) => {
          out.destroy();
          reject(err);
        });
        // 连接被对端掐断时 Node 可能只发 aborted 而不发 error，这里显式兜底
        res.on('aborted', () => {
          out.destroy();
          reject(new Error('升级包下载中断（连接被对端关闭）'));
        });
        out.on('error', reject);
        out.on('finish', () =>
          out.close(() => {
            const got = base + received;
            if (total > 0 && got !== total) {
              // 半截响应不能当成功，否则会把残缺文件改名成正式包
              reject(new Error(`升级包下载不完整（${got} / ${total} 字节）`));
              return;
            }
            resolve({ partFile, resumed: base > 0, skipped: false });
          }),
        );
        res.pipe(out);
      });
      req.setTimeout(60000, () => req.destroy(new Error('升级包下载超时')));
      req.on('error', reject);
    });
  }

  /* ---------------- 块级差分 ---------------- */

  /** 归档根：<userData>\updates-archive。installer.nsh 升级时不会删这里，正好当差分基线 */
  archiveRootDir() {
    return path.join(this.userDataDir, 'updates-archive');
  }

  /**
   * 找一份「基线安装包」：归档里版本号最大、且不等于目标版本的那份。
   * 找不到返回 null，调用方降级为整包下载（差分只是省流量，不能影响可用性）。
   */
  findBaseline(targetVersion) {
    const root = this.archiveRootDir();
    if (!fs.existsSync(root)) return null;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 只认 x.y.z 目录，避免把杂物目录当成版本
      if (!/^\d+\.\d+\.\d+$/.test(entry.name)) continue;
      if (String(entry.name) === String(targetVersion)) continue;
      candidates.push(entry.name);
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => compareVersion(b, a));
    for (const version of candidates) {
      // 留档里的安装包命名规则见 make-release.js：Nyx-Setup-<版本>.exe
      const file = path.join(root, version, `Nyx-Setup-${version}.exe`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) return { version, file };
      } catch {
        /* 换下一个候选 */
      }
    }
    return null;
  }

  /** 给基线安装包建「块 sha256 → 块偏移」索引（同一个 hash 只记首个偏移） */
  buildBlockIndex(file, blockSize) {
    const index = new Map();
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(blockSize);
      let offset = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, blockSize, offset);
        if (read <= 0) break;
        const hash = crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
        if (!index.has(hash)) index.set(hash, offset);
        if (read < blockSize) break;
        offset += read;
      }
    } finally {
      fs.closeSync(fd);
    }
    return index;
  }

  /**
   * 只取一个字节区间（一个块），必须拿到 206。
   * 源返回 200 说明它忽略 Range，差分没法用 —— 抛错让上层降级整包。
   */
  fetchRange(url, start, end) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': `Nyx-Updater/${this.currentVersion}`,
        Range: `bytes=${start}-${end}`,
      };
      const lib = url.startsWith('https:') ? https : http;
      const req = lib.get(url, { headers }, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          reject(new Error('更新源不支持 Range（返回 200），差分不可用'));
          return;
        }
        if (res.statusCode !== 206) {
          res.resume();
          reject(new Error(`块下载失败：HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(30000, () => req.destroy(new Error('块下载超时')));
      req.on('error', reject);
    });
  }

  /**
   * 块级差分下载：命中块从本地基线安装包复制，未命中块用 Range 拉取，
   * 按顺序写进 *.part，最后整体 sha256 校验。
   * 任何一步失败都返回 false（调用方静默降级为整包下载），绝不抛出去。
   */
  async downloadDifferential(url, dest) {
    const manifest = this.manifest || {};
    const blocksName = manifest.blocks;
    if (!blocksName || !manifest.sha256) return false;

    const base = String(this.readConfig().source).trim().replace(/\/+$/, '');
    let plan = null;
    try {
      plan = JSON.parse(await this.httpGetText(`${base}/${encodeURIComponent(blocksName)}`));
    } catch (err) {
      this.log(`[升级] 差分清单不可用（${err.message}），改用整包下载`);
      return false;
    }

    const blockSize = Number(plan && plan.blockSize);
    const size = Number(plan && plan.size);
    const blocks = plan && Array.isArray(plan.blocks) ? plan.blocks : null;
    if (!Number.isInteger(blockSize) || blockSize <= 0 || !blocks || !blocks.length) {
      this.log('[升级] 差分清单字段不完整，改用整包下载');
      return false;
    }
    if (!Number.isInteger(size) || size <= 0 || blocks.length !== Math.ceil(size / blockSize)) {
      this.log('[升级] 差分清单的 size / 块数对不上，改用整包下载');
      return false;
    }
    if (Number(manifest.size) && Number(manifest.size) !== size) {
      this.log('[升级] 差分清单与 latest.json 的 size 不一致，改用整包下载');
      return false;
    }

    const baseline = this.findBaseline(manifest.version);
    if (!baseline) {
      this.log('[升级] 本地没有可当基线的上一版安装包（updates-archive），改用整包下载');
      return false;
    }

    const partFile = this.partFile(dest);
    let out = null;
    let baselineFd = null;
    try {
      this.log(`[升级] 尝试差分更新：基线 ${baseline.version}（${baseline.file}）`);
      const index = this.buildBlockIndex(baseline.file, blockSize);

      // 命中率闸门（v1.7.0）：先只算"能命中多少块"，不下载任何字节。
      // 背景：NSIS 安装包是 LZMA 固实压缩流，跨版本实测命中率为 0%；
      // 零命中时逐块 Range 拉全包会比整包下载更慢（227 次往返、字节一点没省），
      // 所以命中率低于阈值时直接放弃差分、走整包。
      let previewHits = 0;
      for (const hash of blocks) {
        if (hash && index.has(String(hash).toLowerCase())) previewHits += 1;
      }
      const hitRate = blocks.length ? previewHits / blocks.length : 0;
      if (hitRate < DIFF_MIN_HIT_RATE) {
        this.log(
          `[升级] 差分预计只命中 ${previewHits}/${blocks.length} 块（${(hitRate * 100).toFixed(1)}%，` +
            `低于 ${(DIFF_MIN_HIT_RATE * 100).toFixed(0)}%），改用整包下载`,
        );
        return false;
      }

      baselineFd = fs.openSync(baseline.file, 'r');
      out = fs.createWriteStream(partFile, { flags: 'w' });
      const baselineBuffer = Buffer.allocUnsafe(blockSize);

      let hits = 0;
      let fetched = 0;
      let written = 0;
      for (let i = 0; i < blocks.length; i += 1) {
        const start = i * blockSize;
        const length = Math.min(blockSize, size - start);
        const hash = String(blocks[i] || '').toLowerCase();
        let chunk = null;
        if (hash && index.has(hash)) {
          const offset = index.get(hash);
          const read = fs.readSync(baselineFd, baselineBuffer, 0, length, offset);
          if (read === length) {
            // 必须复制：baselineBuffer 下一轮会被覆盖
            chunk = Buffer.from(baselineBuffer.subarray(0, length));
            hits += 1;
          }
        }
        if (!chunk) {
          chunk = await this.fetchRange(url, start, start + length - 1);
          if (!chunk || chunk.length !== length) {
            throw new Error(`第 ${i} 块长度不符（${chunk ? chunk.length : 0} / ${length}）`);
          }
          fetched += length;
        }
        if (!out.write(chunk)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        written += chunk.length;
        // 差分的进度按「已写字节 / 总大小」推进，语义与整包下载一致
        this.setState({ progress: Math.min(99, Math.round((written / size) * 100)) });
      }

      await new Promise((resolve, reject) => {
        out.once('error', reject);
        out.end(() => resolve());
      });
      out = null;

      const valid = await this.verifyFile(partFile, manifest.sha256);
      if (!valid) {
        this.log('[升级] 差分产物 sha256 校验失败，已丢弃，改用整包下载');
        this.removePart(partFile);
        return false;
      }

      const saved = Math.max(0, size - fetched);
      this.log(
        `[升级] 差分命中 ${hits}/${blocks.length} 块（${blocks.length - hits} 块需下载，省下 ${(saved / 1024 / 1024).toFixed(1)} MB）`,
      );
      return true;
    } catch (err) {
      this.log(`[升级] 差分下载中止（${err.message}），改用整包下载`);
      try {
        if (out) out.destroy();
      } catch {
        /* 忽略 */
      }
      this.removePart(partFile);
      return false;
    } finally {
      if (baselineFd !== null) {
        try {
          fs.closeSync(baselineFd);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /* ---------------- 清单 ---------------- */

  async fetchManifest(source) {
    if (isRemoteSource(source)) {
      const url = `${String(source).trim().replace(/\/+$/, '')}/${MANIFEST_NAME}`;
      const text = await this.httpGetText(url);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('更新源返回的 latest.json 不是合法 JSON');
      }
    }

    const file = path.join(toLocalDir(source), MANIFEST_NAME);
    if (!fs.existsSync(file)) {
      throw new Error(`更新源里没有找到 ${MANIFEST_NAME}（已找：${file}）`);
    }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`更新源清单不是合法 JSON：${err.message}`);
    }
  }

  /** 检查更新。不抛异常，失败以 { ok:false } 形式返回 */
  async check() {
    const source = this.readConfig().source;
    this.setState({ phase: 'checking', message: '正在检查更新…', lastError: null, progress: 0 });

    try {
      const manifest = await this.fetchManifest(source);
      if (!manifest || !manifest.version) throw new Error('更新清单缺少 version 字段');

      const fileName = manifest.file || `Nyx-Setup-${manifest.version}.exe`;
      const cmp = compareVersion(manifest.version, this.currentVersion);
      this.checkedAt = new Date().toISOString();

      if (cmp <= 0) {
        this.setState({
          manifest: null,
          readyFile: null,
          phase: 'uptodate',
          message: `已是最新版本（${this.currentVersion}）`,
        });
        return { ok: true, hasUpdate: false, currentVersion: this.currentVersion };
      }

      // 已有同版本缓存且校验通过，直接进入"可升级"
      const cached = path.join(this.cacheDir(), fileName);
      const cacheOk = fs.existsSync(cached) && (await this.verifyFile(cached, manifest.sha256));

      this.setState({
        manifest,
        readyFile: cacheOk ? cached : null,
        phase: cacheOk ? 'ready' : 'available',
        message: cacheOk ? `发现新版本 ${manifest.version}，升级包已就绪` : `发现新版本 ${manifest.version}`,
      });

      return {
        ok: true,
        hasUpdate: true,
        currentVersion: this.currentVersion,
        latestVersion: manifest.version,
        notes: manifest.notes || '',
        mandatory: !!manifest.mandatory,
        ready: cacheOk,
      };
    } catch (err) {
      this.setState({ phase: 'error', message: `检查更新失败：${err.message}`, lastError: err.message });
      return { ok: false, error: err.message };
    }
  }

  /* ---------------- 校验 ---------------- */

  /**
   * 流式 sha256 校验：createReadStream 分块喂给 hash，内存占用与文件大小无关
   * （113MB 整包不再 readFileSync 一次性读入）。
   * 保持原行为：清单没给 sha256 时跳过校验；比较时大小写不敏感。
   * 返回 Promise<boolean>，调用方需要 await。
   */
  verifyFile(file, sha256) {
    if (!sha256) {
      this.log('更新清单未提供 sha256，跳过完整性校验');
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', () => resolve(false));
      stream.on('end', () => {
        resolve(hash.digest('hex').toLowerCase() === String(sha256).trim().toLowerCase());
      });
    });
  }

  /* ---------------- 下载 ---------------- */

  /** 取回升级包（本地源为复制，远端为下载），断点续传 + 流式 sha256 校验 */
  async download() {
    if (!this.manifest) return { ok: false, error: '请先检查更新' };

    const source = this.readConfig().source;
    const fileName = this.manifest.file || `Nyx-Setup-${this.manifest.version}.exe`;
    const dest = path.join(this.cacheDir(), fileName);
    const partFile = this.partFile(dest);

    this.setState({ phase: 'downloading', message: `正在获取升级包 ${this.manifest.version}…`, progress: 0 });

    try {
      fs.mkdirSync(this.cacheDir(), { recursive: true });
      // 版本变了就把上一版的半成品删掉；同版本的分片保留，供重启后续传
      this.cleanupStaleParts();

      if (isRemoteSource(source)) {
        const url = `${String(source).trim().replace(/\/+$/, '')}/${encodeURIComponent(fileName)}`;
        // 远端源先试块级差分（只拉变化块）；本地目录源是零流量复制，没必要分块
        let diffUsed = false;
        if (this.manifest.blocks) {
          diffUsed = await this.downloadDifferential(url, dest);
        }
        if (!diffUsed) {
          await this.downloadToFile(url, dest);
        }
        if (fs.existsSync(partFile)) {
          // 分片改名为正式文件：Windows 上目标已存在时 rename 会失败，先删旧文件
          try {
            fs.unlinkSync(dest);
          } catch {
            /* 目标本来就不存在 */
          }
          fs.renameSync(partFile, dest);
        }
      } else {
        // 本地更新源：直接复制，顺手清掉同名的残留分片
        const from = path.join(toLocalDir(source), fileName);
        if (!fs.existsSync(from)) throw new Error(`更新源里没有找到升级包（已找：${from}）`);
        this.removePart(partFile);
        fs.copyFileSync(from, dest);
        this.setState({ progress: 100 });
      }

      this.setState({ progress: 99 });
      const valid = await this.verifyFile(dest, this.manifest.sha256);
      if (!valid) {
        // 坏包必须连分片一起删：否则下次续传会把坏数据接着用，永远校验不过
        this.removePart(partFile);
        try {
          fs.unlinkSync(dest);
        } catch {
          /* 忽略 */
        }
        this.log('[升级] 升级包 sha256 校验失败，已删除升级包与残留分片');
        throw new Error('升级包 sha256 校验失败，已丢弃，请核对更新源');
      }
      // 校验通过，分片与元数据都可以清掉了
      this.removePart(partFile);

      this.setState({
        readyFile: dest,
        phase: 'ready',
        progress: 100,
        message: `升级包已就绪（${this.manifest.version}）`,
      });
      return { ok: true, file: dest };
    } catch (err) {
      const kept = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
      if (kept > 0) {
        this.log(`[升级] 本次下载中断，已保留分片 ${kept} 字节，下次自动从断点续传`);
      }
      this.setState({ phase: 'error', message: `获取升级包失败：${err.message}`, lastError: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * 拉起静默安装。
   *
   * 用中间批处理做三件事：
   *   1. 延迟几秒，等本进程把内核子进程与会话干净退出，避免文件占用导致覆盖失败；
   *   2. 静默安装（/S）并按当前安装目录原地覆盖（/D=…，NSIS 要求该参数位于行尾且不加引号）；
   *   3. 静默模式下安装程序不会自动启动应用，装完由脚本把新版拉起来。
   * 用户数据目录（%APPDATA%\Nyx）不在安装目录内，订阅、偏好与密码库都原样保留。
   */
  install() {
    if (!this.isPackaged) {
      return { ok: false, error: '开发模式下不执行覆盖安装，请先打包' };
    }
    if (!this.readyFile || !fs.existsSync(this.readyFile)) {
      return { ok: false, error: '升级包尚未准备好，请先检查并获取更新' };
    }

    const installDir = path.dirname(this.execPath);
    const exePath = path.join(installDir, path.basename(this.execPath));
    const script = path.join(this.cacheDir(), 'apply-update.cmd');
    const body = [
      '@echo off',
      'ping -n 4 127.0.0.1 >nul',
      `"${this.readyFile}" /S /D=${installDir}`,
      'ping -n 3 127.0.0.1 >nul',
      `if exist "${exePath}" start "" "${exePath}"`,
      '',
    ].join('\r\n');

    try {
      fs.writeFileSync(script, body, 'utf8');
    } catch (err) {
      return { ok: false, error: `升级脚本写入失败：${err.message}` };
    }

    try {
      const child = spawn('cmd.exe', ['/c', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      return { ok: false, error: `升级程序启动失败：${err.message}` };
    }

    this.setState({ phase: 'installing', message: '正在安装新版本，应用即将自动重启…' });
    return { ok: true, installDir };
  }
}

module.exports = { Updater, compareVersion };
