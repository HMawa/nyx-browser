'use strict';

/**
 * 代理模块的本地状态：订阅列表、当前启用订阅、用户偏好。
 * 落盘位置：<userData>/proxy/proxy-state.json
 *
 * 订阅地址含访问令牌，属敏感信息，因此：
 *   - 源码里不写任何真实订阅地址，首次启动是空列表，全部由用户在界面里添加；
 *   - 添加后只写本地用户目录，不写进仓库；
 *   - 对外（界面/日志）暴露时一律脱敏。
 */

const fs = require('fs');
const path = require('path');

/** 首次启动不预置订阅：用户自己添加，添加结果只落本地用户目录 */
const DEFAULT_SUBSCRIPTIONS = [];

/** 订阅地址通常带访问令牌，展示时只留头尾 */
function maskUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(
    /(token|key|password|auth)=([^&\s]{0,4})[^&\s]*([^&\s]{2})/gi,
    (whole, key, head, tail) => `${key}=${head}****${tail}`,
  );
}

class ProxyStore {
  /**
   * @param {{stateDir:string}} opts
   */
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, 'proxy-state.json');
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
      loaded = null; // 状态文件损坏时按首次运行处理，不阻断启动
    }

    if (!loaded || !Array.isArray(loaded.subscriptions)) {
      loaded = {
        version: 1,
        // 没有预置订阅，也就没有默认启用项；用户添加并启用后才会写具体 id
        activeId: null,
        subscriptions: DEFAULT_SUBSCRIPTIONS.map((item) => ({
          ...item,
          addedAt: Date.now(),
          lastFetchAt: null,
          lastError: null,
          nodeCount: 0,
        })),
        preferences: { autoStart: true, autoTest: true, autoEgress: false, smartPatrol: true },
      };
    }

    // autoStart：是否允许为"需要代理的模式"自动拉起内置内核。
    //   浏览器启动时一律不拉内核（普通模式不依赖代理，见 main.js bootstrapProxyKernel），
    //   只有进入 / 恢复隐私模式时才会读这个开关——置 false 即"内核完全手动"。
    // autoEgress 默认关闭：出口自查是真实外联请求，规范要求仅由用户主动点击
    // 或隐私模式校验触发，不得随内核启动静默执行。
    // interfaceMode / interfaceName：出站网卡设置。auto=跟随系统默认路由（配置里不写
    //   interface-name），manual=绑定 interfaceName 指定的网卡；网卡名只在内核重建时
    //   写进配置，所以切换后必须重启内核才会真正换出口。
    loaded.preferences = Object.assign(
      {
        autoStart: true,
        autoTest: true,
        autoEgress: false,
        interfaceMode: 'auto',
        interfaceName: '',
      },
      loaded.preferences || {}
    );
    this.state = loaded;
    this.save();
    return this.state;
  }

  save() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** 界面用：脱敏后的订阅视图 */
  listForUi() {
    const state = this.load();
    return {
      activeId: state.activeId,
      preferences: state.preferences,
      subscriptions: state.subscriptions.map((item) => ({
        id: item.id,
        name: item.name,
        urlMasked: maskUrl(item.url),
        addedAt: item.addedAt,
        lastFetchAt: item.lastFetchAt,
        lastError: item.lastError,
        nodeCount: item.nodeCount,
        active: item.id === state.activeId,
      })),
    };
  }

  /** 内部用：完整订阅（含真实地址），仅在发起拉取时取用 */
  activeSubscription() {
    const state = this.load();
    return state.subscriptions.find((item) => item.id === state.activeId) || null;
  }

  getSubscription(id) {
    return this.load().subscriptions.find((item) => item.id === id) || null;
  }

  setActive(id) {
    const state = this.load();
    if (!state.subscriptions.some((item) => item.id === id)) {
      return { ok: false, message: '订阅不存在' };
    }
    state.activeId = id;
    this.save();
    return { ok: true, activeId: id };
  }

  addSubscription({ name, url }) {
    const trimmed = String(url || '').trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      return { ok: false, message: '订阅地址需以 http:// 或 https:// 开头' };
    }

    const state = this.load();
    if (state.subscriptions.some((item) => item.url === trimmed)) {
      return { ok: false, message: '该订阅已存在' };
    }

    const id = `sub-${Date.now().toString(36)}`;
    state.subscriptions.push({
      id,
      name: String(name || '').trim() || `订阅 ${state.subscriptions.length + 1}`,
      url: trimmed,
      addedAt: Date.now(),
      lastFetchAt: null,
      lastError: null,
      nodeCount: 0,
    });
    this.save();
    return { ok: true, id };
  }

  removeSubscription(id) {
    const state = this.load();
    const idx = state.subscriptions.findIndex((item) => item.id === id);
    if (idx < 0) return { ok: false, message: '订阅不存在' };

    state.subscriptions.splice(idx, 1);
    if (state.activeId === id) {
      state.activeId = state.subscriptions.length ? state.subscriptions[0].id : null;
    }
    this.save();
    return { ok: true, activeId: state.activeId };
  }

  /** 记录一次拉取结果，用于界面展示订阅健康度 */
  markFetch(id, { ok, message, nodeCount }) {
    const state = this.load();
    const item = state.subscriptions.find((sub) => sub.id === id);
    if (!item) return;
    item.lastFetchAt = Date.now();
    item.lastError = ok ? null : String(message || '拉取失败').slice(0, 200);
    if (typeof nodeCount === 'number' && nodeCount > 0) item.nodeCount = nodeCount;
    this.save();
  }

  setPreference(key, value) {
    const state = this.load();
    state.preferences[key] = value;
    this.save();
    return state.preferences;
  }
}

module.exports = { ProxyStore, maskUrl };
