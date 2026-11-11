'use strict';

/**
 * 启动与主页配置：新标签页地址 + 启动时打开哪些页面。
 * 落盘位置：<userData>/startup-preferences.json
 *
 * 与 core/ui-store.js（纯外观布尔开关）分开存放：这里的值是字符串与列表，
 * 校验规则完全不同，混在一个文件里会让两边的白名单互相牵连。
 *
 * 读取失败一律回落默认值，保证浏览器永远能启动。
 */

const fs = require('fs');
const path = require('path');

/** 启动方式可选值 */
const STARTUP_MODES = ['blank', 'newTab', 'custom'];

/** 单个地址最大长度（字符）：超长一律拒绝，避免脏数据写进配置文件 */
const MAX_URL_LENGTH = 2048;

/** startupMode=custom 时允许的最大条数（实际打开数还会受标签上限约束） */
const MAX_STARTUP_URLS = 20;

/** 默认配置：新标签为空白页、启动打开新标签页 */
const STARTUP_DEFAULTS = {
  /** 新标签页地址；空串表示空白页（运行时回落到环境变量 NYX_HOME_URL） */
  newTabUrl: '',
  /** 启动方式：blank=空白页 / newTab=打开新标签页 / custom=打开指定网页 */
  startupMode: 'newTab',
  /** startupMode=custom 时要打开的地址（每行一条） */
  startupUrls: [],
};

/**
 * 收敛单个地址：去空白、限长、拒绝换行。
 *
 * 只做"能不能存"的判断，协议补全交给 core/tabs.js 的 normalizeInput，
 * 这样地址栏输入与主页配置走的是同一套解析规则，不会出现两套口径。
 */
function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH || /[\r\n]/.test(trimmed)) return '';
  return trimmed;
}

/** 收敛启动页列表：逐条去空白、丢弃空行与重复项，最多 MAX_STARTUP_URLS 条 */
function cleanUrlList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const url = cleanUrl(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_STARTUP_URLS) break;
  }
  return out;
}

class StartupStore {
  /**
   * @param {{stateDir:string}} opts
   */
  constructor({ stateDir }) {
    this.statePath = path.join(stateDir, 'startup-preferences.json');
    this.state = null;
  }

  load() {
    if (this.state) return this.state;

    let loaded = null;
    try {
      if (fs.existsSync(this.statePath)) {
        // 配置文件可能被用户手动编辑（记事本等会写入 BOM），先剥离再解析：
        // 否则 JSON.parse 直接抛错、整份配置被当成默认值丢弃
        loaded = JSON.parse(fs.readFileSync(this.statePath, 'utf8').replace(/^\uFEFF/, ''));
      }
    } catch {
      loaded = null; // 文件损坏按默认值处理，不阻断启动
    }

    const raw = loaded && typeof loaded === 'object' ? loaded : {};
    this.state = {
      newTabUrl: cleanUrl(raw.newTabUrl),
      startupMode: STARTUP_MODES.includes(raw.startupMode)
        ? raw.startupMode
        : STARTUP_DEFAULTS.startupMode,
      startupUrls: cleanUrlList(raw.startupUrls),
    };

    this.save();
    return this.state;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 界面 / 主进程用快照 */
  get() {
    const state = this.load();
    return {
      newTabUrl: state.newTabUrl,
      startupMode: state.startupMode,
      startupUrls: state.startupUrls.slice(),
    };
  }

  /** 新标签页实际使用的地址：未配置时回落到兜底值（环境变量 NYX_HOME_URL） */
  newTabUrlValue(fallback) {
    return this.load().newTabUrl || fallback || 'about:blank';
  }

  /** 启动时要打开的地址列表（至少一条；顺序即打开顺序） */
  startupTargets(fallback) {
    const prefs = this.load();
    if (prefs.startupMode === 'blank') return ['about:blank'];
    if (prefs.startupMode === 'custom' && prefs.startupUrls.length) return prefs.startupUrls.slice();
    return [this.newTabUrlValue(fallback)];
  }

  /**
   * 写入配置（支持部分字段更新，未传入的字段保持原值）。
   * 校验失败时返回中文原因，且一个字段都不落盘。
   */
  set(patch) {
    const input = patch && typeof patch === 'object' ? patch : {};
    const next = this.get();

    if ('newTabUrl' in input) {
      const value = input.newTabUrl;
      if (typeof value !== 'string') return { ok: false, error: '新标签页地址必须是字符串' };
      if (/[\r\n]/.test(value)) return { ok: false, error: '新标签页地址不能包含换行' };
      if (value.trim().length > MAX_URL_LENGTH) {
        return { ok: false, error: `新标签页地址过长（上限 ${MAX_URL_LENGTH} 字符）` };
      }
      next.newTabUrl = value.trim();
    }

    if ('startupMode' in input) {
      if (!STARTUP_MODES.includes(input.startupMode)) {
        return { ok: false, error: '启动方式取值不合法' };
      }
      next.startupMode = input.startupMode;
    }

    if ('startupUrls' in input) {
      if (!Array.isArray(input.startupUrls)) {
        return { ok: false, error: '启动页列表必须是数组' };
      }
      for (const item of input.startupUrls) {
        if (typeof item !== 'string') return { ok: false, error: '启动页列表只能包含字符串' };
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (/[\r\n]/.test(item)) return { ok: false, error: '启动页地址不能包含换行' };
        if (trimmed.length > MAX_URL_LENGTH) {
          return { ok: false, error: `启动页地址过长（上限 ${MAX_URL_LENGTH} 字符）` };
        }
      }
      const filled = input.startupUrls.filter((item) => String(item).trim()).length;
      if (filled > MAX_STARTUP_URLS) {
        return { ok: false, error: `启动页最多 ${MAX_STARTUP_URLS} 条` };
      }
      next.startupUrls = cleanUrlList(input.startupUrls);
    }

    this.state = next;
    if (!this.save()) return { ok: false, error: '写入失败，请检查用户目录权限' };
    return { ok: true, prefs: this.get() };
  }

  /** 恢复默认：新标签为空白页、启动打开新标签页、清空指定启动页 */
  reset() {
    this.state = {
      newTabUrl: STARTUP_DEFAULTS.newTabUrl,
      startupMode: STARTUP_DEFAULTS.startupMode,
      startupUrls: [],
    };
    if (!this.save()) return { ok: false, error: '写入失败，请检查用户目录权限' };
    return { ok: true, prefs: this.get() };
  }
}

module.exports = {
  StartupStore,
  STARTUP_DEFAULTS,
  STARTUP_MODES,
  MAX_STARTUP_URLS,
  MAX_URL_LENGTH,
};
