'use strict';

/**
 * 本地密码库与表单记忆（正常模式专属）。
 *
 * 安全约束（本模块的唯一职责就是守住这几条）：
 *   1) 只存密文：用户名、密码、表单值统一经 Electron safeStorage（跟随系统钥匙串 /
 *      DPAPI）加密后再落盘，磁盘上永远是 base64 密文。
 *   2) 仅在填充瞬间解密：readCredential() 只有被"填充动作"调用时才解密，
 *      返回值只在本进程内存里短暂存在，绝不写日志、绝不写磁盘、绝不出 IPC 之外。
 *   3) 加密不可用时拒绝保存：宁可功能不可用，也不降级成明文存储。
 *   4) 隐私模式完全不参与：调用方（IPC 层）在隐私模式下直接短路，本模块不感知模式，
 *      但提供 clearAll() 供"清空隐私痕迹"场景调用。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 磁盘结构版本 */
const VAULT_VERSION = 1;

/** 表单值里最多保留的字段数，防止恶意页面塞爆磁盘 */
const MAX_FORM_FIELDS = 60;
const MAX_VALUE_LENGTH = 4096;

/** 掩码：只露首尾，用于界面展示 */
function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 2) return '*'.repeat(text.length);
  if (text.length <= 6) return `${text[0]}***${text[text.length - 1]}`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

class Vault {
  /**
   * @param {object} options
   * @param {string} options.stateDir 状态目录（与代理订阅等同级）
   * @param {object} options.safeStorage Electron safeStorage（或测试替身）
   * @param {(level:string, text:string) => void} [options.log] 日志回调（只收非敏感文案）
   */
  constructor({ stateDir, safeStorage, log = () => {} }) {
    this.file = path.join(stateDir, 'nyx-vault.json');
    this.safeStorage = safeStorage;
    this.log = log;
    this.data = { version: VAULT_VERSION, credentials: {}, forms: {}, updatedAt: null };
    this.loaded = false;
  }

  /** 加密能力是否可用（不可用时拒绝一切写入） */
  get available() {
    try {
      return Boolean(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  /** 供界面展示的后端名称，写清楚"密文存在哪把锁下" */
  get backend() {
    if (!this.available) return 'unavailable';
    try {
      if (process.platform === 'win32') return 'dpapi';
      if (process.platform === 'darwin') return 'keychain';
      return 'libsecret';
    } catch {
      return 'unknown';
    }
  }

  load() {
    if (this.loaded) return this.data;
    this.loaded = true;
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === VAULT_VERSION) {
          this.data = {
            version: VAULT_VERSION,
            credentials: parsed.credentials || {},
            forms: parsed.forms || {},
            updatedAt: parsed.updatedAt || null,
          };
        }
      }
    } catch (err) {
      // 损坏的库不让它拖垮浏览器：留空并保留原文件（不覆盖），交由用户处理
      this.log('error', `密码库读取失败（已忽略内容）：${err.message}`);
    }
    return this.data;
  }

  save() {
    this.data.updatedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch (err) {
      this.log('error', `密码库写入失败：${err.message}`);
      return false;
    }
  }

  /** 加密字符串 → base64 密文；失败返回 null（调用方必须当作"保存失败"处理） */
  encrypt(plain) {
    if (!this.available) return null;
    try {
      const buffer = this.safeStorage.encryptString(String(plain));
      return Buffer.from(buffer).toString('base64');
    } catch (err) {
      this.log('error', `加密失败：${err.message}`);
      return null;
    }
  }

  /** base64 密文 → 明文；失败返回 null */
  decrypt(cipher) {
    if (!cipher || !this.available) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(String(cipher), 'base64'));
    } catch (err) {
      this.log('error', `解密失败：${err.message}`);
      return null;
    }
  }

  /* ---------------- 登录凭据 ---------------- */

  /** 是否已为此来源存过密码 */
  hasCredential(origin) {
    this.load();
    return Boolean(this.data.credentials[origin]);
  }

  /**
   * 保存（或覆盖）某来源的登录信息。
   * @returns {{ok:boolean, error?:string}}
   */
  saveCredential(origin, { username = '', password = '' } = {}) {
    this.load();
    if (!origin) return { ok: false, error: '来源缺失' };
    if (!password) return { ok: false, error: '密码为空，未保存' };
    if (!this.available) return { ok: false, error: '系统加密不可用，已拒绝保存以免明文落盘' };

    const encUser = this.encrypt(username);
    const encSecret = this.encrypt(password);
    if (encSecret === null || encUser === null) {
      return { ok: false, error: '加密失败，未保存' };
    }

    this.data.credentials[origin] = {
      user: encUser,
      secret: encSecret,
      usernameHint: maskSecret(username),
      updatedAt: Date.now(),
    };
    const ok = this.save();
    return ok ? { ok: true } : { ok: false, error: '写入失败' };
  }

  /**
   * 解密读取登录信息 —— 只在"用户点击填充"这一瞬间被调用。
   * @returns {{username:string, password:string}|null}
   */
  readCredential(origin) {
    this.load();
    const entry = this.data.credentials[origin];
    if (!entry) return null;

    const username = this.decrypt(entry.user) || '';
    const password = this.decrypt(entry.secret) || '';
    if (!password) return null;
    return { username, password };
  }

  /** 界面用清单：只给掩码与时间，不给明文 */
  listCredentials() {
    this.load();
    return Object.entries(this.data.credentials).map(([origin, entry]) => ({
      origin,
      usernameHint: entry.usernameHint || '',
      updatedAt: entry.updatedAt || null,
    }));
  }

  removeCredential(origin) {
    this.load();
    if (!this.data.credentials[origin]) return { ok: false, error: '该来源没有保存的密码' };
    delete this.data.credentials[origin];
    this.save();
    return { ok: true };
  }

  /* ---------------- 表单记忆（非密码字段） ---------------- */

  /**
   * 保存表单字段值（正常模式用于自动填充）。
   * 与密码同等对待：加密后落盘。
   */
  saveFormValues(origin, values) {
    this.load();
    if (!origin || !values || typeof values !== 'object') return { ok: false, error: '参数非法' };
    if (!this.available) return { ok: false, error: '系统加密不可用，已拒绝保存表单内容' };

    const picked = {};
    let count = 0;
    for (const [key, value] of Object.entries(values)) {
      if (count >= MAX_FORM_FIELDS) break;
      const text = String(value == null ? '' : value).slice(0, MAX_VALUE_LENGTH);
      if (!text) continue;
      picked[key] = text;
      count += 1;
    }
    if (!count) return { ok: false, error: '没有可保存的内容' };

    const cipher = this.encrypt(JSON.stringify(picked));
    if (cipher === null) return { ok: false, error: '加密失败，未保存' };

    this.data.forms[origin] = { payload: cipher, fields: count, updatedAt: Date.now() };
    const ok = this.save();
    return ok ? { ok: true, fields: count } : { ok: false, error: '写入失败' };
  }

  /** 读取表单值（填充瞬间解密） */
  readFormValues(origin) {
    this.load();
    const entry = this.data.forms[origin];
    if (!entry || !entry.payload) return null;
    const text = this.decrypt(entry.payload);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  listForms() {
    this.load();
    return Object.entries(this.data.forms).map(([origin, entry]) => ({
      origin,
      fields: entry.fields || 0,
      updatedAt: entry.updatedAt || null,
    }));
  }

  /* ---------------- 维护 ---------------- */

  /** 清空全部记忆（界面上的"清空密码与表单记忆"） */
  clearAll() {
    this.load();
    this.data.credentials = {};
    this.data.forms = {};
    this.save();
    return { ok: true };
  }

  /** 概况（界面展示用，不含任何明文） */
  stats() {
    this.load();
    return {
      available: this.available,
      backend: this.backend,
      credentialCount: Object.keys(this.data.credentials).length,
      formCount: Object.keys(this.data.forms).length,
      updatedAt: this.data.updatedAt,
      file: this.file,
    };
  }
}

module.exports = { Vault, maskSecret, VAULT_VERSION };
