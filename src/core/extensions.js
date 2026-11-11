'use strict';

/**
 * 扩展插件管理器（兼容 Edge / Chrome 扩展）。
 *
 * 依赖 Electron 的 `session.extensions.loadExtension()`：加载的是**解压后的扩展目录**，
 * 因此本模块负责三件事：
 *   1. 把用户选中的扩展（目录 / .crx 包）收进 Nyx 自己的扩展仓库并登记元数据；
 *   2. 按启用状态在**普通模式分区（persist:nyx-normal）**上装载 / 卸载；
 *   3. 如实告知每个扩展在本内核下的支持度（哪些能力 Electron 没有实现）。
 *
 * 隐私红线：扩展只在普通模式分区装载。隐私模式分区（nyx-private）从不加载任何
 * 扩展——扩展能看到页面内容、能外发数据，与"全隐私"互斥。切换模式不会把扩展
 * 带进隐私分区；隐私分区渲染进程里也不存在任何已加载扩展。
 *
 * 兼容性口径（Electron 43 / Chromium 150，与 Chrome 扩展 API 的差异）：
 *   ✅ 基本可用：content_scripts 注入（脚本 / 样式）、chrome.runtime、chrome.storage、
 *      chrome.i18n、web_accessible_resources、options_page 的静态页面；
 *   ⚠️ 部分可用：chrome.tabs / webNavigation（只读居多）、MV3 后台 Service Worker、
 *      browserAction / action 图标（无工具栏图标界面，点击入口缺失）；
 *   ❌ 不可用：chrome.webRequest 的拦截与改写、declarativeNetRequest、
 *      nativeMessaging、chrome.debugger、chrome.bookmarks、chrome.cookies 等。
 *   注意：Chromium 150 已彻底移除 MV2 扩展支持（含 background page 常驻后台页），
 *   仅 MV3 扩展可装载；历史 MV2 扩展需迁移到 MV3 才能在 Nyx 使用。
 *   结论：内容增强 / 样式改写 / 翻译辅助类扩展可用；广告拦截、代理转发、
 *   下载接管类扩展不可用。界面上按扩展实际声明的能力给出评级与原因，不笼统说"支持"。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** 索引文件名（位于 <userData>/extensions 下） */
const INDEX_FILE = 'extensions.json';
/** 扩展本体仓库子目录 */
const STORE_DIR = 'store';
/** 解包临时目录 */
const TMP_DIR = 'tmp';
/** 索引结构版本 */
const INDEX_VERSION = 1;
/** 扩展数量上限（防止仓库被塞爆） */
const MAX_EXTENSIONS = 64;
/** 单个扩展目录允许的最大文件数 / 总字节数（防超大批量导入） */
const MAX_FILES = 4000;
const MAX_BYTES = 256 * 1024 * 1024;

/** CRX / ZIP 结构常量 */
const CRX_MAGIC = 0x34327243; // 'Cr24'（小端读作 0x34327243）
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/** 网络拦截类权限：Electron 未实现，命中即为"该扩展的核心功能不可用" */
const NETWORK_BLOCK_PERMS = [
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'declarativeNetRequestFeedback',
  'webRequest',
  'webRequestBlocking',
  'proxy',
  'nativeMessaging',
];

/**
 * 把任意扩展名整理成可用作目录名的短标识。
 * @param {string} name
 */
function slugify(name) {
  const cleaned = String(name || 'extension')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'extension';
}

/** 递归统计目录文件数与总字节数（超过上限立即返回，避免遍历过大目录） */
function measureDir(dir, limit = MAX_FILES) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 忽略：统计不到大小不影响判断 */
        }
        if (files > limit) return { files, bytes };
      }
    }
  }
  return { files, bytes };
}

/** 递归复制目录（保留相对结构） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
    // 符号链接一律跳过：扩展目录里的链接可能指向仓库之外的路径
  }
}

/** 递归删除目录（尽力而为，失败不抛） */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略：删不掉的文件由用户手工清理 */
  }
}

/**
 * 解析 manifest 里的 __MSG_xxx__ 形式文案。
 * @param {string} value 原始文案
 * @param {Map<string,string>} messages default_locale 对应的键值表
 */
function resolveMessage(value, messages) {
  if (typeof value !== 'string' || !messages || messages.size === 0) return value;
  const matched = /^__MSG_(.+)__$/.exec(value.trim());
  if (!matched) return value;
  const key = matched[1].toLowerCase();
  return messages.get(key) || value;
}

/** 读取 _locales/<default_locale>/messages.json，得到 i18n 键值表 */
function readLocaleMessages(dir, defaultLocale) {
  const messages = new Map();
  if (!defaultLocale) return messages;
  const file = path.join(dir, '_locales', String(defaultLocale), 'messages.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, item] of Object.entries(raw || {})) {
      if (item && typeof item.message === 'string') messages.set(key.toLowerCase(), item.message);
    }
  } catch {
    /* 没有 i18n 资源属正常情况 */
  }
  return messages;
}

/** 判断文件是否在目录内（防目录穿越） */
function isInside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * 从一个 ZIP 缓冲区解压到目标目录。
 *
 * 只实现扩展包会用到的最小集合：store(0) 与 deflate(8) 两种压缩方式，
 * 不处理加密与 zip64（扩展包不会用到）。每个条目的最终路径都必须落在目标
 * 目录内，否则视为恶意包直接拒绝。
 */
function unzipBuffer(buffer, outDir) {
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 66000);
  for (let i = buffer.length - 22; i >= scanFrom; i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('压缩包结构无效（未找到中央目录）');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0) throw new Error('压缩包内容为空');

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL) {
      throw new Error('压缩包中央目录损坏');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name || name.includes('\u0000')) continue;

    const target = path.resolve(outDir, name);
    if (!isInside(outDir, target)) throw new Error(`压缩包内路径非法：${name}`);

    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) {
      throw new Error(`压缩包条目损坏：${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);

    let content;
    if (method === 0) {
      content = raw;
    } else if (method === 8) {
      content = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`不支持的压缩方式（${method}）：${name}`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * 定位 .crx 文件里真正的 ZIP 起始偏移。
 *
 * CRX2：`Cr24` + ver(2) + pubkeyLen + sigLen + pubkey + sig + ZIP
 * CRX3：`Cr24` + ver(3) + headerLen + header + ZIP
 * 直接给 .zip 时偏移为 0。
 */
function crxZipOffset(buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== CRX_MAGIC) {
    if (buffer.readUInt32LE(0) === ZIP_LOCAL) return 0;
    throw new Error('不是有效的 .crx / .zip 文件');
  }
  const version = buffer.readUInt32LE(4);
  let head;
  if (version === 2) {
    const pubKeyLen = buffer.readUInt32LE(8);
    const sigLen = buffer.readUInt32LE(12);
    head = 16 + pubKeyLen + sigLen;
  } else if (version === 3) {
    const headerSize = buffer.readUInt32LE(8);
    head = 12 + headerSize;
  } else {
    throw new Error(`不支持的 CRX 版本：${version}`);
  }

  // 头部长度字段偶有对齐差异，向后小范围扫描到第一个本地文件头，避免"差几个字节"导致失败
  const scanEnd = Math.min(buffer.length - 4, head + 4096);
  for (let i = head; i <= scanEnd; i += 1) {
    if (buffer.readUInt32LE(i) === ZIP_LOCAL) return i;
  }
  throw new Error('CRX 包体定位失败（内部数据不是 ZIP）');
}

/**
 * 读取并校验扩展目录里的 manifest.json。
 * @returns {{manifest: object, name: string, version: string, manifestVersion: number, description: string}}
 */
function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) {
    throw new Error('所选目录里没有 manifest.json，不是扩展目录');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`manifest.json 解析失败：${err.message}`);
  }
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('manifest.json 内容不是对象');
  }

  const manifestVersion = Number(manifest.manifest_version);
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    throw new Error(`不支持的 manifest_version：${manifest.manifest_version}（仅支持 2 / 3）`);
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('manifest 缺少 version 字段');
  }

  const messages = readLocaleMessages(dir, manifest.default_locale);
  const name = String(resolveMessage(manifest.name, messages) || '未命名扩展').trim();
  const description = String(resolveMessage(manifest.description, messages) || '').trim();

  return {
    manifest,
    name: name.slice(0, 120),
    version: manifest.version.trim(),
    manifestVersion,
    description: description.slice(0, 300),
  };
}

/** 汇总该扩展在本内核下的能力口径 */
function collectCapabilities(manifest, manifestVersion) {
  const permissions = []
    .concat(Array.isArray(manifest.permissions) ? manifest.permissions : [])
    .concat(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : [])
    .map((item) => String(item));

  const hasContentScripts = Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0;
  const hasMv3Worker =
    manifestVersion === 3 && !!(manifest.background && manifest.background.service_worker);
  const hasMv2Background = manifestVersion === 2 && !!manifest.background;
  const networkBlocked = permissions.some((perm) => NETWORK_BLOCK_PERMS.includes(perm));
  const hasAction = !!(manifest.action || manifest.browser_action);
  const hasNativeMessaging = permissions.includes('nativeMessaging');

  const warnings = [];
  if (networkBlocked) {
    const hit = permissions.filter((perm) => NETWORK_BLOCK_PERMS.includes(perm)).join('、');
    warnings.push(`依赖网络拦截类能力（${hit}），本内核未实现，相关功能不会生效`);
  }
  if (hasMv3Worker) {
    warnings.push('MV3 后台 Service Worker 支持有限，依赖后台常驻的功能可能不稳定');
  }
  if (hasAction) {
    warnings.push('没有浏览器工具栏图标入口，点击图标触发的功能无法操作（可用快捷键或页面右键菜单的部分替代）');
  }
  if (hasNativeMessaging) {
    warnings.push('需要与本地程序通信（nativeMessaging），本内核不支持');
  }
  if (!hasContentScripts && !hasMv2Background && !hasMv3Worker) {
    warnings.push('未见内容脚本或后台脚本，页面里可能没有任何可见效果');
  }

  /**
   * 支持度评级：
   *   high   → 靠内容脚本做页面增强，基本能完整工作；
   *   medium → 能注入，但依赖后台能力，部分功能会退化；
   *   low    → 核心能力建立在本内核未实现的接口上，装上也没有实际作用。
   */
  let level = 'medium';
  if (networkBlocked && !hasContentScripts) {
    level = 'low';
  } else if (hasContentScripts && !networkBlocked) {
    level = hasMv3Worker ? 'medium' : 'high';
  } else if (networkBlocked) {
    level = 'low';
  }

  return {
    level,
    hasContentScripts,
    hasMv3Worker,
    hasMv2Background,
    hasAction,
    networkBlocked,
    permissions: permissions.slice(0, 40),
    warnings,
  };
}

/**
 * 扩展管理器。
 *
 * 生命周期：init() 读索引（同步）→ loadAll() 在普通分区逐项装载（异步）。
 * 所有会改变运行状态的方法都返回 `{ ok, error? }`，不抛异常给 IPC 层。
 */
class ExtensionManager {
  /**
   * @param {object} options
   * @param {string} options.stateDir 扩展仓库根目录（<userData>/extensions）
   * @param {() => Electron.Session|null} options.getSession 取普通模式分区
   * @param {(level: string, text: string) => void} [options.log]
   */
  constructor(options) {
    this.stateDir = options.stateDir;
    this.storeDir = path.join(this.stateDir, STORE_DIR);
    this.tmpDir = path.join(this.stateDir, TMP_DIR);
    this.indexPath = path.join(this.stateDir, INDEX_FILE);
    this.getSession = options.getSession || (() => null);
    this.log = options.log || (() => {});

    /** @type {Array<object>} 扩展登记表 */
    this.items = [];
    /** 索引是否可用（不可用时拒绝写入，避免覆盖损坏文件造成二次损失） */
    this.indexUsable = true;
  }

  /** 创建目录结构并读入索引 */
  init() {
    try {
      fs.mkdirSync(this.storeDir, { recursive: true });
      fs.mkdirSync(this.tmpDir, { recursive: true });
    } catch (err) {
      this.log('error', `扩展仓库目录创建失败：${err.message}`);
    }
    this.loadIndex();
    return { ok: true, count: this.items.length };
  }

  /** 读取索引；结构损坏时备份原文件并按空表启动（不静默删除用户数据） */
  loadIndex() {
    this.items = [];
    if (!fs.existsSync(this.indexPath)) return;

    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      const list = raw && Array.isArray(raw.items) ? raw.items : [];
      this.items = list
        .filter((item) => item && typeof item.id === 'string' && typeof item.dir === 'string')
        .map((item) => ({
          id: item.id,
          name: String(item.name || '未命名扩展'),
          version: String(item.version || '0'),
          description: String(item.description || ''),
          manifestVersion: Number(item.manifestVersion) || 2,
          source: String(item.source || ''),
          dir: item.dir,
          enabled: item.enabled !== false,
          capabilities: item.capabilities || null,
          addedAt: Number(item.addedAt) || Date.now(),
          updatedAt: Number(item.updatedAt) || Date.now(),
          lastError: item.lastError || null,
          runtimeId: null,
          loaded: false,
        }));
    } catch (err) {
      this.indexUsable = false;
      const backup = `${this.indexPath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.indexPath, backup);
      } catch {
        /* 备份失败也不阻塞启动 */
      }
      this.log('error', `扩展索引损坏，已备份为 ${path.basename(backup)}：${err.message}`);
    }
  }

  /** 写索引（尽力而为；失败只在日志里说明，不影响本次装载结果） */
  persist() {
    if (!this.indexUsable) {
      this.log('error', '扩展索引当前不可写（历史文件损坏），本次改动未落盘');
      return false;
    }
    const payload = {
      version: INDEX_VERSION,
      items: this.items.map((item) => ({
        id: item.id,
        name: item.name,
        version: item.version,
        description: item.description,
        manifestVersion: item.manifestVersion,
        source: item.source,
        dir: item.dir,
        enabled: item.enabled,
        capabilities: item.capabilities,
        addedAt: item.addedAt,
        updatedAt: item.updatedAt,
        lastError: item.lastError,
      })),
    };
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), 'utf8');
      return true;
    } catch (err) {
      this.log('error', `扩展索引写入失败：${err.message}`);
      return false;
    }
  }

  /** 界面用清单（不含任何凭据；附带当前装载状态） */
  list() {
    return this.items.map((item) => ({
      id: item.id,
      name: item.name,
      version: item.version,
      description: item.description,
      manifestVersion: item.manifestVersion,
      source: item.source,
      dir: item.dir,
      // Chromium 运行时扩展 id（v1.10.0）：打开扩展选项页要用 chrome-extension://<id>/...
      runtimeId: item.runtimeId || '',
      enabled: item.enabled,
      loaded: item.loaded,
      capabilities: item.capabilities,
      addedAt: item.addedAt,
      updatedAt: item.updatedAt,
      lastError: item.lastError,
      mode: 'normal',
    }));
  }

  /** 生效目录（界面「打开扩展仓库」用） */
  get storePath() {
    return this.storeDir;
  }

  /** 在普通模式分区装载单个扩展 */
  async loadOne(item) {
    const ses = this.getSession();
    if (!ses) {
      item.lastError = '普通模式分区未就绪';
      item.loaded = false;
      return { ok: false, error: item.lastError };
    }
    if (!fs.existsSync(path.join(item.dir, 'manifest.json'))) {
      item.lastError = '扩展目录已被删除或损坏';
      item.loaded = false;
      return { ok: false, error: item.lastError };
    }

    try {
      const extension = await ses.extensions.loadExtension(item.dir, { allowFileAccess: true });
      item.runtimeId = extension && extension.id ? extension.id : item.runtimeId;
      item.loaded = true;
      item.lastError = null;
      this.log('info', `扩展已装载：${item.name} v${item.version}（id=${item.runtimeId}）`);
      return { ok: true, runtimeId: item.runtimeId };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      // 重复装载同一路径会报 already loaded：视作已装载，不算失败
      if (/already loaded/i.test(message)) {
        item.loaded = true;
        item.lastError = null;
        return { ok: true, runtimeId: item.runtimeId };
      }
      item.loaded = false;
      item.lastError = message;
      this.log('error', `扩展装载失败（${item.name}）：${message}`);
      return { ok: false, error: message };
    }
  }

  /** 从普通模式分区卸载单个扩展 */
  unloadOne(item) {
    const ses = this.getSession();
    if (!ses || !item.runtimeId) {
      item.loaded = false;
      return { ok: true };
    }
    try {
      ses.extensions.removeExtension(item.runtimeId);
      item.loaded = false;
      this.log('info', `扩展已卸载：${item.name}`);
      return { ok: true };
    } catch (err) {
      item.loaded = false;
      this.log('error', `扩展卸载失败（${item.name}）：${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** 启动时按索引把启用项装载回普通分区 */
  async loadAll() {
    const targets = this.items.filter((item) => item.enabled);
    const results = [];
    for (const item of targets) {
      // 串行装载：并发 loadExtension 在部分 Chromium 版本上会互相干扰
      // eslint-disable-next-line no-await-in-loop
      const result = await this.loadOne(item);
      results.push({ id: item.id, name: item.name, ok: result.ok, error: result.error || null });
    }
    this.persist();

    const okCount = results.filter((item) => item.ok).length;
    if (targets.length > 0) {
      this.log('info', `扩展装载完成：${okCount}/${targets.length} 个`);
    }
    return { ok: true, loaded: okCount, total: targets.length, failed: results.filter((r) => !r.ok) };
  }

  /** 按 id 查登记项 */
  find(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  /**
   * 从目录安装（目录会被复制进仓库，源目录之后可自由删除）。
   * @param {string} sourceDir
   */
  async install(sourceDir) {
    const dir = path.resolve(String(sourceDir || ''));
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: '所选路径不是可读目录' };
    }

    let meta;
    try {
      meta = readManifest(dir);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const size = measureDir(dir);
    if (size.files > MAX_FILES || size.bytes > MAX_BYTES) {
      return { ok: false, error: `扩展体积超出上限（${size.files} 个文件 / ${Math.round(size.bytes / 1048576)} MB）` };
    }

    const pathId = crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 12);
    // 先按"源路径 id"找；找不到再按扩展**名字**找。
    // 同名视为「更新」并复用原条目：否则从不同来源（解压目录 / .crx / 在线 zip）安装同一扩展
    // 会得到两条重复记录（v1.11.0 修，客户端在线更新时踩到）。
    let existing = this.find(pathId);
    if (!existing) existing = this.items.find((item) => item.name === meta.name) || null;
    const id = existing ? existing.id : pathId;
    if (!existing && this.items.length >= MAX_EXTENSIONS) {
      return { ok: false, error: `扩展数量已达上限（${MAX_EXTENSIONS} 个）` };
    }

    const targetDir =
      existing && existing.dir ? existing.dir : path.join(this.storeDir, `${slugify(meta.name)}-${id}`);
    if (isInside(dir, targetDir) || dir === path.resolve(targetDir) || isInside(targetDir, dir)) {
      return { ok: false, error: '扩展仓库与源目录相互嵌套，请先把扩展拷到别处再导入' };
    }

    try {
      if (fs.existsSync(targetDir)) removeDir(targetDir);
      copyDir(dir, targetDir);
    } catch (err) {
      return { ok: false, error: `复制扩展文件失败：${err.message}` };
    }

    // 仓库里的副本要重新校验一次：manifest 必须随副本一起进来
    let storedMeta;
    try {
      storedMeta = readManifest(targetDir);
    } catch (err) {
      removeDir(targetDir);
      return { ok: false, error: `仓库副本校验失败：${err.message}` };
    }

    const capabilities = collectCapabilities(storedMeta.manifest, storedMeta.manifestVersion);
    const now = Date.now();

    const item = existing || {
      id,
      addedAt: now,
      runtimeId: null,
      loaded: false,
      lastError: null,
    };
    if (existing && existing.loaded) this.unloadOne(existing);

    Object.assign(item, {
      name: storedMeta.name,
      version: storedMeta.version,
      description: storedMeta.description,
      manifestVersion: storedMeta.manifestVersion,
      source: 'folder',
      dir: targetDir,
      enabled: true,
      capabilities,
      updatedAt: now,
    });

    if (!existing) this.items.push(item);
    const loadResult = await this.loadOne(item);
    this.persist();

    return {
      ok: true,
      extension: this.list().find((entry) => entry.id === item.id),
      updated: !!existing,
      loadError: loadResult.ok ? null : loadResult.error,
      /** 提示界面：新装/更新的扩展需要刷新页面才会注入 */
      reloadHint: capabilities.hasContentScripts,
    };
  }

  /**
   * 从 .crx / .zip 安装：解出包体后再走目录安装流程。
   * @param {string} filePath
   */
  async installCrx(filePath) {
    const file = path.resolve(String(filePath || ''));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return { ok: false, error: '所选文件不存在或不可读' };
    }

    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch (err) {
      return { ok: false, error: `读取安装包失败：${err.message}` };
    }
    if (buffer.length > MAX_BYTES) {
      return { ok: false, error: '安装包超出体积上限（256 MB）' };
    }

    let zipOffset;
    try {
      zipOffset = crxZipOffset(buffer);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const tmpDir = path.join(this.tmpDir, `crx-${Date.now()}`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      unzipBuffer(buffer.subarray(zipOffset), tmpDir);
    } catch (err) {
      removeDir(tmpDir);
      return { ok: false, error: `解包失败：${err.message}` };
    }

    // 有些包会把扩展放在一层子目录里，向下找一层含 manifest.json 的目录
    let unpackedDir = tmpDir;
    if (!fs.existsSync(path.join(unpackedDir, 'manifest.json'))) {
      const candidates = fs
        .readdirSync(tmpDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(tmpDir, entry.name))
        .filter((candidate) => fs.existsSync(path.join(candidate, 'manifest.json')));
      if (candidates.length === 1) unpackedDir = candidates[0];
    }

    const result = await this.install(unpackedDir);
    removeDir(tmpDir);

    if (result.ok && result.extension) {
      result.extension.source = 'crx';
      const item = this.find(result.extension.id);
      if (item) item.source = 'crx';
      this.persist();
      result.extension = this.list().find((entry) => entry.id === result.extension.id);
    }
    return result;
  }

  /**
   * 启用 / 停用。
   * @param {string} id
   * @param {boolean} enabled
   */
  async setEnabled(id, enabled) {
    const item = this.find(id);
    if (!item) return { ok: false, error: '扩展不存在' };

    if (enabled) {
      item.enabled = true;
      const result = await this.loadOne(item);
      this.persist();
      return { ok: true, extension: this.list().find((entry) => entry.id === id), loadError: result.ok ? null : result.error };
    }

    item.enabled = false;
    this.unloadOne(item);
    this.persist();
    return { ok: true, extension: this.list().find((entry) => entry.id === id) };
  }

  /** 卸载并从仓库删除文件 */
  async remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: '扩展不存在' };

    const [item] = this.items.splice(index, 1);
    this.unloadOne(item);

    if (isInside(this.storeDir, item.dir)) {
      removeDir(item.dir);
    } else {
      this.log('error', `已拒绝删除仓库之外的目录：${item.dir}`);
    }

    this.persist();
    return { ok: true, removed: item.name };
  }

  /** 全部重新装载（扩展文件被外部改动后手动刷新用） */
  async reloadAll() {
    for (const item of this.items) {
      if (item.loaded) this.unloadOne(item);
    }
    return this.loadAll();
  }
}

module.exports = {
  ExtensionManager,
  // 导出内部工具便于验收脚本单独校验（不参与运行时逻辑）
  crxZipOffset,
  unzipBuffer,
  readManifest,
  collectCapabilities,
};
