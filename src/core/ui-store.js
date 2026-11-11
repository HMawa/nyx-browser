'use strict';

/**
 * 界面偏好：顶栏元素显隐、界面主题一类的纯外观开关。
 * 落盘位置：<userData>/ui-preferences.json
 *
 * 只存布尔值与白名单内的枚举字符串，不含任何敏感信息；读取失败一律回落到默认值，
 * 保证界面永远有一份可用配置。
 */

const fs = require('fs');
const path = require('path');

/** 已知偏好项与默认值（键名白名单，写入时校验） */
const UI_PREF_DEFAULTS = {
  /** 顶栏是否显示出站链路徽标（直连 / 代理） */
  showLinkBadge: true,
  /** 顶栏是否显示隐私模式开关 */
  showModeSwitch: true,
  /** 界面主题：ink 墨夜 / aurora 极光 / paper 素纸 / quiet 静谧 */
  theme: 'ink',
  /** 下载保存目录；空字符串 = 跟随系统下载目录 */
  downloadDir: '',
  /** 下载前是否弹窗询问保存位置（false 时静默存到 downloadDir） */
  downloadAsk: true,
};

/** 枚举型偏好的合法取值（键 → 允许值）。
 *  与 theme-nyx.css 里 <html data-theme="…"> 的取值必须一一对应。 */
const UI_PREF_ENUMS = {
  theme: ['ink', 'aurora', 'paper', 'quiet'],
};

class UiStore {
  /**
   * @param {{stateDir:string}} opts
   */
  constructor({ stateDir }) {
    this.statePath = path.join(stateDir, 'ui-preferences.json');
    this.state = null;
  }

  load() {
    if (this.state) return this.state;

    let loaded = null;
    try {
      if (fs.existsSync(this.statePath)) {
        loaded = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch {
      loaded = null; // 文件损坏按默认值处理，不阻断启动
    }

    const merged = Object.assign({}, UI_PREF_DEFAULTS, loaded && typeof loaded === 'object' ? loaded : {});

    // 只保留白名单键；枚举键按 UI_PREF_ENUMS 校验，其余键类型必须与默认值一致，
    // 防止脏数据污染内存
    for (const key of Object.keys(merged)) {
      if (!(key in UI_PREF_DEFAULTS)) {
        // 原实现此处为 merged[key] = UI_PREF_DEFAULTS[key]，但该键不在默认表里，
        // 取到的是 undefined —— 键并未删除（JSON.stringify 会丢弃 undefined，所以磁盘上看不出来，
        // 但内存对象里一直带着它），与"只保留白名单键"的注释相反。delete 才是注释的本意。
        delete merged[key];
      } else if (UI_PREF_ENUMS[key]) {
        // 枚举键放行字符串，但取值必须在白名单内
        if (!UI_PREF_ENUMS[key].includes(merged[key])) merged[key] = UI_PREF_DEFAULTS[key];
      } else if (typeof merged[key] !== typeof UI_PREF_DEFAULTS[key]) {
        merged[key] = UI_PREF_DEFAULTS[key];
      }
    }

    this.state = merged;
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

  /** 界面用快照 */
  get() {
    return Object.assign({}, this.load());
  }

  /** 写入单项偏好；键名与取值都必须在白名单内 */
  set(key, value) {
    if (!(key in UI_PREF_DEFAULTS)) return { ok: false, error: `未知的偏好项：${key}` };

    // 枚举键按允许值校验，其余键仍要求与默认值同类型
    if (UI_PREF_ENUMS[key]) {
      if (!UI_PREF_ENUMS[key].includes(value)) {
        return { ok: false, error: `取值不合法：${value}` };
      }
    } else if (typeof value !== typeof UI_PREF_DEFAULTS[key]) {
      return { ok: false, error: '取值类型不合法' };
    }

    const state = this.load();
    state[key] = value;
    if (!this.save()) return { ok: false, error: '写入失败，请检查用户目录权限' };
    return { ok: true, ui: this.get() };
  }
}

module.exports = { UiStore, UI_PREF_DEFAULTS, UI_PREF_ENUMS };
