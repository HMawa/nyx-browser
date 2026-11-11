'use strict';

/**
 * 历史记录存储（Nyx 1.2.3 新增：历史记录 + 书签功能）。
 *
 * 落盘位置：<userData>/history.json（即 %APPDATA%\Nyx\history.json）。
 * 设计要点：
 *   - 内存缓存 + 串行写：所有写操作排队执行，避免并发写把文件写坏；
 *   - 历史上限 5000 条：超出后按访问时间从最旧开始裁剪；
 *   - 同 URL 5 分钟窗口内重复访问只更新时间不新增（连续刷新 / 回跳不刷屏）；
 *   - 隐私模式绝不写入历史——该红线在 main.js 的导航钩子里把关，
 *     本模块不做模式判断（它不知道当前是什么模式）。
 */

const fs = require('fs');
const path = require('path');

/** 数据文件版本号：结构变更时递增，加载时用于兼容判断 */
const HISTORY_VERSION = 1;

/** 历史上限（条），超出按访问时间裁剪最旧记录 */
const MAX_HISTORY = 5000;

/** 同 URL 合并窗口（毫秒）：窗口内重复访问只更新时间不新增 */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/** 合法时间范围（毫秒时间戳），防止脏数据把列表撑爆或显示异常 */
const TS_MIN = Date.UTC(2000, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);

/** 标题清洗：限长、去首尾空白、去换行，避免落盘脏标题影响渲染 */
function cleanTitle(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  return s.length > 512 ? `${s.slice(0, 512)}…` : s;
}

/** URL 清洗：必须是非空字符串、限长、不含换行 */
function cleanUrl(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s || s.length > 4096 || /[\r\n]/.test(s)) return '';
  return s;
}

class HistoryStore {
  /**
   * @param {object} options
   * @param {string} options.stateDir 落盘目录（主进程传 app.getPath('userData')）
   */
  constructor({ stateDir }) {
    this.statePath = path.join(stateDir, 'history.json');
    /** @type {Array<{id:number, url:string, title:string, visitedAt:number}>} 按访问时间倒序 */
    this.items = [];
    this.seq = 1;
    this.saveChain = Promise.resolve();
    this.loaded = false;
  }

  /** 启动时加载；文件缺失 / 损坏一律回落为空列表，绝不抛异常 */
  load() {
    if (this.loaded) return this.items;
    this.loaded = true;
    let raw = null;
    try {
      if (fs.existsSync(this.statePath)) {
        raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8').replace(/^\uFEFF/, ''));
      }
    } catch {
      raw = null;
    }
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    const items = [];
    let maxId = 0;
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const url = cleanUrl(it.url);
      const visitedAt = Number(it.visitedAt);
      if (!url || !Number.isFinite(visitedAt) || visitedAt < TS_MIN || visitedAt > TS_MAX) continue;
      const id = Number(it.id);
      const rec = {
        id: Number.isFinite(id) && id > 0 ? id : 0,
        url,
        title: cleanTitle(it.title) || url,
        visitedAt,
      };
      items.push(rec);
      if (rec.id > maxId) maxId = rec.id;
    }
    // 旧文件可能是乱序的，统一按访问时间倒序
    items.sort((a, b) => b.visitedAt - a.visitedAt);
    this.items = items.slice(0, MAX_HISTORY);
    this.seq = maxId + 1;
    return this.items;
  }

  /** 返回访问时间倒序列表（副本，避免外部改到内部状态） */
  list() {
    return this.items.slice();
  }

  /**
   * 记录一次访问。
   * 同 URL 5 分钟窗口内只更新时间不新增；超出窗口则新增一条。
   */
  record(url, title) {
    const clean = cleanUrl(url);
    if (!clean) return { ok: false, error: '地址不合法' };
    const now = Date.now();
    const same = this.items.find((it) => it.url === clean && now - it.visitedAt < DEDUP_WINDOW_MS);
    if (same) {
      same.visitedAt = now;
      const t = cleanTitle(title);
      if (t) same.title = t;
    } else {
      this.items.push({
        id: this.seq++,
        url: clean,
        title: cleanTitle(title) || clean,
        visitedAt: now,
      });
    }
    this.items.sort((a, b) => b.visitedAt - a.visitedAt);
    if (this.items.length > MAX_HISTORY) this.items.length = MAX_HISTORY;
    this.save();
    return { ok: true };
  }

  /** 页面标题就绪后修正最近一条同 URL 记录的标题（did-navigate 时标题常滞后） */
  updateTitle(url, title) {
    const clean = cleanUrl(url);
    const t = cleanTitle(title);
    if (!clean || !t) return;
    const item = this.items.find((it) => it.url === clean);
    if (item && item.title !== t) {
      item.title = t;
      this.save();
    }
  }

  /** 按 id 删除单条记录 */
  remove(id) {
    const key = Number(id);
    const idx = this.items.findIndex((it) => it.id === key);
    if (idx < 0) return { ok: false, error: '记录不存在' };
    this.items.splice(idx, 1);
    this.save();
    return { ok: true };
  }

  /** 一键清空 */
  clear() {
    this.items = [];
    this.seq = 1;
    this.save();
    return { ok: true };
  }

  /** 串行写盘：写操作按调用顺序排队，天然避免并发写坏文件 */
  save() {
    const snapshot = JSON.stringify({ version: HISTORY_VERSION, items: this.items }, null, 2);
    this.saveChain = this.saveChain.then(() => {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        fs.writeFileSync(this.statePath, snapshot, 'utf8');
      } catch (err) {
        console.warn('[Nyx] 历史记录写盘失败：', err.message);
      }
    });
    return this.saveChain;
  }
}

module.exports = { HistoryStore, HISTORY_VERSION, MAX_HISTORY, DEDUP_WINDOW_MS };
