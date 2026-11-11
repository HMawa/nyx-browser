'use strict';

/**
 * Nyx 工具箱内核：资源嗅探 + 网络抓包 + 页面环境改写的公共底座。
 *
 * 数据源是 Chrome DevTools Protocol（CDP）——Electron 的 webContents.debugger
 * 就是一条内嵌在标签页里的调试通道，Network 域能给出完整事件流：
 * 请求头、响应头、状态码、传输体积、耗时、失败原因、响应体。
 * session.webRequest 只能看到 URL 与状态码，量级不够，因此不作为主通道。
 *
 * 与原生 DevTools 的互斥：一个 webContents 同时只允许一条调试通道。
 * 用户打开 DevTools（检查/控制台）时会抢占，本模块监听 detach 自动让位，
 * 关闭 DevTools 后再重新接管，绝不与「开发者模式」抢通道。
 *
 * 隐私口径：抓包数据只在本进程内存里留痕，不落盘、不进日志；
 * 隐私模式标签同样允许抓包（属于用户自查自己的流量），但同样不落盘。
 */

const PROTOCOL_VERSION = '1.3';

/** 每个标签页保留的请求条数上限（超出丢弃最旧的已完结条目） */
const MAX_RECORDS = 4000;

/** 单个请求的 POST 体抓取上限 */
const MAX_POST_DATA_SIZE = 64 * 1024;

/** 增量推送节流间隔（毫秒）：把 CDP 的高频事件合并成批量下发 */
const FLUSH_INTERVAL_MS = 160;

/** CDP 响应体缓存上限（单标签）：太小会导致 getResponseBody 取不到正文 */
const BUFFER_TOTAL = 64 * 1024 * 1024;
const BUFFER_RESOURCE = 16 * 1024 * 1024;

/** 能直接取正文的文本型 MIME（二进制不给正文，只给体积） */
const TEXTUAL_MIME = /^(text\/|application\/(json|javascript|xml|xhtml|x-www-form-urlencoded|graphql)|image\/svg)/i;

/** 正文预览上限（超出截断展示） */
const BODY_PREVIEW_LIMIT = 200 * 1024;

/** 单条响应超过此编码体积就不预取正文（预览只要 200KB，留足编码膨胀余量） */
const BODY_FETCH_MAX_ENCODED = 768 * 1024;

/** 每标签的正文预取额度：先到先得，防止抓一个视频站把内存吃满 */
const BODY_CACHE_MAX_ENTRIES = 240;
const BODY_CACHE_MAX_BYTES = 12 * 1024 * 1024;

/**
 * 预取重试：loadingFinished 与内核正文缓冲之间存在毫秒级时序差，
 * 首发请求（文档 + 首屏资源）常有取不到的情况，退一步再试即可拿到。
 */
const BODY_FETCH_ATTEMPTS = 2;
const BODY_FETCH_RETRY_DELAY = 220;

/** 首轮全部取完后，再给失败的那些补取的时间点（毫秒）；两轮仍取不到才判定不可读 */
const BODY_RETRY_DELAYS = [1200, 4200];

/** URL 展示截断长度（避免超长 data:/blob: 撑爆 IPC） */
const URL_MAX = 600;

/* ------------------------------ 资源类型判定 ------------------------------ */

/**
 * 扩展名 → 资源种类。顺序有意义：先匹配的优先。
 * 覆盖猫抓同级的媒体面：HLS / DASH / 直链视频音频 / 字幕 / 图片。
 */
const EXT_RULES = [
  [/\.(m3u8|m3u)(\?|#|$)/i, 'hls'],
  [/\.(mpd)(\?|#|$)/i, 'dash'],
  [/\.(mp4|m4v|mov|mkv|webm|flv|f4v|avi|wmv|ts|m2ts|mts)(\?|#|$)/i, 'video'],
  [/\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba|wma|ape)(\?|#|$)/i, 'audio'],
  [/\.(srt|ass|ssa|vtt|sub)(\?|#|$)/i, 'subtitle'],
  [/\.(jpg|jpeg|png|gif|webp|bmp|avif|ico)(\?|#|$)/i, 'image'],
];

/** 响应 MIME → 资源种类（扩展名看不出来时的兜底） */
function kindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (!m) return '';
  if (/mpegurl|vnd\.apple\.mpegurl/.test(m)) return 'hls';
  if (/dash\+xml/.test(m)) return 'dash';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  return '';
}

/**
 * 判定一条请求的资源种类。
 * @returns {string} hls|dash|video|audio|subtitle|image|''
 */
function guessKind(url, mimeType) {
  const u = String(url || '').split('#')[0];
  for (const [re, kind] of EXT_RULES) {
    if (re.test(u)) return kind;
  }
  const byMime = kindFromMime(mimeType);
  if (byMime) return byMime;
  // 无扩展名的流：HLS 分片常见 .ts / 无扩展名但 mime 为 mpegts
  if (/mpegts|octet-stream/.test(String(mimeType || '').toLowerCase()) && /\/[^/]*\.ts(\?|#|$)/i.test(u)) {
    return 'video';
  }
  return '';
}

/** 从 URL 取主机名（失败时回落为空串，不抛异常） */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return '';
  }
}

/** URL 收敛：截断 + 剔除控制字符，保证 IPC 与界面都不会被畸形串搞崩 */
function safeUrl(url) {
  const s = String(url || '').replace(/[\r\n\t]/g, '');
  return s.length > URL_MAX ? `${s.slice(0, URL_MAX)}…` : s;
}

/**
 * 把一个 headers 对象（CDP 的 NameValue 数组或普通对象）拍平成对象。
 * CDP 的请求/响应头在部分事件里是数组形式，统一收敛便于界面直接渲染。
 */
function flattenHeaders(raw) {
  if (!raw) return {};
  const out = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && item.name) out[item.name] = String(item.value || '');
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const key of Object.keys(raw)) out[key] = String(raw[key] || '');
    return out;
  }
  return out;
}

/* ------------------------------ 单个标签的采集器 ------------------------------ */

/**
 * 计算一次请求的耗时与分段（v1.9.0）。
 *
 * CDP 里有两套时间：`wallTime` 是纪元秒（给展示用），`timestamp` 是单调时钟秒。
 * 之前用「完成时间戳 − wallTime×1000」算耗时，基准不一致 → 负数被 clamp 成 0，
 * 界面上所有请求都显示"耗时未知"。这里统一改用单调时钟：
 *   duration        = 完成 − 开始
 *   timing.wait     = 响应头 − 开始（TTFB）
 *   timing.download = 完成 − 响应头
 * 拿不到单调时钟就不写 duration/timing，界面显示"耗时未知"，绝不给假数字。
 */
function applyTiming(rec, finishedMono) {
  if (!rec) return;
  const start = Number(rec.monoStart) || 0;
  const responded = Number(rec.monoResponse) || 0;
  const finished = Number(finishedMono) || 0;
  if (start <= 0 || finished <= start) return;

  rec.duration = Math.max(0, Math.round((finished - start) * 1000));
  if (responded > start && responded <= finished) {
    rec.timing = {
      wait: Math.max(0, Math.round((responded - start) * 1000)),
      download: Math.max(0, Math.round((finished - responded) * 1000)),
    };
  }
}

/**
 * 一个标签页的抓包状态：CDP 通道 + 请求记录表 + 待推送增量。
 */
class TabCollector {
  /** @param {Electron.WebContents} wc */
  constructor(wc) {
    this.wc = wc;
    this.wcId = wc.id;
    /** @type {Map<string, object>} requestId → 记录 */
    this.records = new Map();
    /** @type {Set<string>} 本周期内有变化的 requestId */
    this.dirty = new Set();
    /** 是否已挂上 CDP */
    this.attached = false;
    /** 用户是否暂停了本标签的记录（暂停后仍挂通道但不入表，用于"暂停抓包"） */
    this.paused = false;
    /** 已丢弃的旧条目数（界面提示"更早的记录已滚动丢弃"） */
    this.dropped = 0;
    /** 累计计数（不受 MAX_RECORDS 影响） */
    this.total = 0;
    /** 请求序号，给界面做稳定排序 */
    this.seq = 0;
    /** 正文预取：已缓存的条数 / 字节数 / 待取队列 / 是否正在取 */
    this.bodyEntries = 0;
    this.bodyBytes = 0;
    this.bodyQueue = [];
    this.bodyBusy = false;
    /** 首轮没取到的正文，等队列跑空后统一补取 */
    this.bodyRetry = [];
    this.bodyRetryScheduled = false;
    this.bodyRetryRound = 0;
  }

  /**
   * 预取正文。
   *
   * 必须趁 loadingFinished 立刻取：Chromium 的响应体缓冲会被驱逐，
   * 等用户点开详情再取，往往只剩一句 "No resource with given identifier found"。
   */
  queueBody(record) {
    if (record.bodyQueued || record.bodyText !== undefined) return;
    if (record.failed || !record.finished) return;
    if (!TEXTUAL_MIME.test(record.mime || '')) return;
    if (record.size > BODY_FETCH_MAX_ENCODED) {
      record.bodyNote = '正文偏大，未缓存预览，可直接下载';
      return;
    }
    if (this.bodyEntries >= BODY_CACHE_MAX_ENTRIES || this.bodyBytes >= BODY_CACHE_MAX_BYTES) {
      record.bodyNote = '正文缓存额度已满，本条未缓存预览';
      return;
    }
    record.bodyQueued = true;
    this.bodyQueue.push(record.id);
    this.pumpBody();
  }

  /** 串行取正文：CDP 单通道，并发拉取容易互相拖慢 */
  pumpBody() {
    if (this.bodyBusy) return;
    const id = this.bodyQueue.shift();
    if (id == null) {
      this.scheduleBodyRetry();
      return;
    }
    const record = this.records.get(id);
    if (!record) {
      this.pumpBody();
      return;
    }
    this.bodyBusy = true;
    this.fetchBody(record)
      .catch(() => {})
      .then(() => {
        this.bodyBusy = false;
        this.pumpBody();
      });
  }

  /**
   * 补取。子框架（OOPIF）里的资源正文常常比主框架晚一拍才可读，
   * 首轮跑空后统一再来一遍，能捞回大部分「首次取不到」的条目。
   */
  scheduleBodyRetry() {
    if (!this.bodyRetry.length || this.bodyRetryScheduled) return;
    const round = this.bodyRetryRound;
    if (round >= BODY_RETRY_DELAYS.length) return;
    this.bodyRetryScheduled = true;
    // 上一轮失败的条目仍留在补取池里，靠 record.bodyRetryRound 区分是不是该收尾
    const pending = this.bodyRetry.slice();
    this.bodyRetry.length = 0;
    this.bodyRetryRound = round + 1;
    setTimeout(() => {
      this.bodyRetryScheduled = false;
      if (!this.attached) return;
      this.bodyQueue.push(...pending);
      this.pumpBody();
    }, BODY_RETRY_DELAYS[round]);
  }

  async fetchBody(record) {
    if (!this.attached || !this.wc || this.wc.isDestroyed()) return;
    let res = null;
    let lastErr = null;
    for (let attempt = 0; attempt < BODY_FETCH_ATTEMPTS; attempt += 1) {
      try {
        res = await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId: record.id });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < BODY_FETCH_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, BODY_FETCH_RETRY_DELAY));
        }
      }
    }
    if (!res) {
      // 取不到不代表真没有：详情页会按需再取，队列跑空后这里也会分两轮补取
      const round = record.bodyRetryRound || 0;
      if (round < BODY_RETRY_DELAYS.length) {
        record.bodyRetryRound = round + 1;
        this.bodyRetry.push(record.id);
        return;
      }
      record.bodyNote = `正文未缓存：${(lastErr && lastErr.message) || '内核未提供'}`;
      console.warn('[Nyx] 正文预取失败：', record.type, record.mime, record.url, lastErr && lastErr.message);
      return;
    }
    if (res.body == null) return;
    const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : String(res.body);
    record.bodyText = text.slice(0, BODY_PREVIEW_LIMIT);
    record.bodyNote = text.length > BODY_PREVIEW_LIMIT ? '正文超过 200KB，已截断预览' : '';
    this.bodyEntries += 1;
    this.bodyBytes += record.bodyText.length;
    this.dirty.add(record.id);
  }

  /** 记录一条新请求 */
  begin(requestId, payload) {
    if (this.paused) return null;
    this.seq += 1;
    const record = {
      id: requestId,
      seq: this.seq,
      url: safeUrl(payload.url),
      rawUrl: payload.url,
      host: hostOf(payload.url),
      method: payload.method || 'GET',
      type: payload.type || 'Other',
      status: 0,
      statusText: '',
      kind: guessKind(payload.url, ''),
      mime: '',
      size: 0,
      duration: 0,
      startedAt: Date.now(),
      // wallTime 是「纪元秒」，只用于展示；算耗时必须用 CDP 的单调时钟（timestamp），
      // 两者混用会得到负数并被 clamp 成 0（v1.9.0 之前所有耗时光秃秃是 0，原因就在这里）。
      startTime: payload.wallTime ? payload.wallTime * 1000 : Date.now(),
      /** 请求开始的单调时钟（秒）；0 表示没拿到 */
      monoStart: Number(payload.timestamp) || 0,
      /** 收到响应头的单调时钟（秒）；0 表示还没收到 */
      monoResponse: 0,
      /** 分段耗时（毫秒）：wait = 等首字节（TTFB），download = 内容下载 */
      timing: null,
      cached: false,
      failed: '',
      finished: false,
      requestHeaders: flattenHeaders(payload.headers),
      postData: payload.postData ? String(payload.postData).slice(0, MAX_POST_DATA_SIZE) : '',
      responseHeaders: {},
      remoteIP: '',
      protocol: '',
      fromWs: false,
      wsFrames: 0,
    };
    this.records.set(requestId, record);
    this.total += 1;
    this.dirty.add(requestId);
    this.trim();
    return record;
  }

  /** 记录数超上限时丢弃最旧的「已完结」条目 */
  trim() {
    if (this.records.size <= MAX_RECORDS) return;
    const finished = [];
    for (const rec of this.records.values()) {
      if (rec.finished || rec.failed) finished.push(rec);
    }
    finished.sort((a, b) => a.seq - b.seq);
    let need = this.records.size - MAX_RECORDS;
    for (const rec of finished) {
      if (need <= 0) break;
      this.records.delete(rec.id);
      this.dirty.delete(rec.id);
      this.dropped += 1;
      need -= 1;
    }
  }

  /** 推送用的精简负载（去掉大头字段，正文只在详情里按需取） */
  brief(rec) {
    return {
      id: rec.id,
      seq: rec.seq,
      url: rec.url,
      host: rec.host,
      method: rec.method,
      type: rec.type,
      status: rec.status,
      kind: rec.kind,
      mime: rec.mime,
      size: rec.size,
      duration: rec.duration,
      timing: rec.timing || null,
      cached: rec.cached,
      failed: rec.failed,
      finished: rec.finished,
      at: rec.startedAt,
      fromWs: rec.fromWs,
      wsFrames: rec.wsFrames,
    };
  }

  /** 重置全部记录 */
  clear() {
    this.records.clear();
    this.dirty.clear();
    this.dropped = 0;
    this.total = 0;
    this.bodyEntries = 0;
    this.bodyBytes = 0;
    this.bodyQueue.length = 0;
    this.bodyRetry.length = 0;
  }
}

/* ------------------------------ 工具箱主类 ------------------------------ */

class Toolbox {
  /**
   * @param {object} options
   * @param {() => Electron.WebContents[]} options.getAllWebContents 当前全部标签的 webContents
   * @param {() => Electron.WebContents|null} options.getActiveWebContents 当前激活标签的 webContents
   * @param {(channel: string, payload: object) => void} options.push 主进程 → UI 外壳的推送通道
   */
  constructor(options) {
    this.getAllWebContents = options.getAllWebContents || (() => []);
    this.getActiveWebContents = options.getActiveWebContents || (() => null);
    this.push = options.push || (() => {});

    /** @type {Map<number, TabCollector>} wcId → 采集器 */
    this.collectors = new Map();

    /** 工具箱总开关：关闭时全部 detach，零开销 */
    this.enabled = false;

    this.timer = null;
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  /** 打开工具箱：给现有全部标签挂上采集器 */
  enable() {
    if (this.enabled) return { ok: true };
    this.enabled = true;
    this.syncAll();
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    return { ok: true };
  }

  /** 关闭工具箱：全部 detach，停止定时器 */
  disable() {
    this.enabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const collector of this.collectors.values()) {
      this.detach(collector);
    }
    return { ok: true };
  }

  /** 与标签现状对齐：新增的挂上，已关闭的清理（新标签打开时由主进程调用） */
  syncAll() {
    if (!this.enabled) return;
    const alive = new Set();

    for (const wc of this.getAllWebContents()) {
      if (!wc || wc.isDestroyed()) continue;
      alive.add(wc.id);
      if (!this.collectors.has(wc.id)) {
        const collector = new TabCollector(wc);
        this.collectors.set(wc.id, collector);
        this.attach(collector);
      }
    }

    for (const [wcId, collector] of this.collectors) {
      if (alive.has(wcId)) continue;
      this.detach(collector);
      this.collectors.delete(wcId);
    }
  }

  /** 取采集器（按 wcId；不传则取当前激活标签） */
  collectorOf(wcId) {
    if (wcId != null) return this.collectors.get(Number(wcId)) || null;
    const wc = this.getActiveWebContents();
    return wc ? this.collectors.get(wc.id) || null : null;
  }

  /* ---------------------------- CDP 通道 ---------------------------- */

  /** 挂上调试通道并开启 Network 域 */
  attach(collector) {
    const wc = collector.wc;
    if (wc.isDestroyed() || collector.attached) return;

    // DevTools 已打开时通道被占用：直接让位，等它关闭后再接管
    if (wc.isDevToolsOpened()) return;

    try {
      wc.debugger.attach(PROTOCOL_VERSION);
    } catch (err) {
      // 「Another debugger is already attached」是预期内的让位场景，不刷错误日志
      if (!/already attached/i.test(String(err && err.message))) {
        console.warn('[Nyx] 工具箱挂载失败：', err && err.message);
      }
      return;
    }

    collector.attached = true;

    wc.debugger.on('message', (event, method, params) => {
      try {
        this.onCdpMessage(collector, method, params);
      } catch (err) {
        // 单条事件解析失败不能拖垮整个抓包
        console.warn('[Nyx] 抓包事件处理异常：', err && err.message);
      }
    });

    wc.debugger.on('detach', (event, reason) => {
      collector.attached = false;
      // 用户打开原生 DevTools 会顶掉通道：关闭后自动重新接管
      if (this.enabled && reason !== 'target closed') {
        setTimeout(() => {
          if (this.enabled && !wc.isDestroyed() && !wc.isDevToolsOpened()) this.attach(collector);
        }, 400);
      }
    });

    const enable = () =>
      wc.debugger
        .sendCommand('Network.enable', {
          maxTotalBufferSize: BUFFER_TOTAL,
          maxResourceBufferSize: BUFFER_RESOURCE,
          maxPostDataSize: MAX_POST_DATA_SIZE,
        })
        .catch((err) => console.warn('[Nyx] Network 域开启失败：', err && err.message));

    enable();
  }

  /** 卸下调试通道 */
  detach(collector) {
    const wc = collector.wc;
    collector.attached = false;
    if (!wc || wc.isDestroyed()) return;
    try {
      if (wc.debugger.isAttached()) {
        wc.debugger.sendCommand('Network.disable').catch(() => {});
        wc.debugger.detach();
      }
    } catch {
      /* 忽略：通道可能已被 DevTools 抢占 */
    }
  }

  /**
   * 向指定标签的 CDP 通道发一条命令。
   * 供后续能力（元素高亮、截图、视口模拟、限速）复用同一条通道，避免重复 attach。
   */
  async sendCommand(wcId, method, params) {
    const collector = this.collectorOf(wcId);
    if (!collector || !collector.attached) {
      throw new Error('该标签尚未挂上调试通道（可能已打开开发者工具占用）');
    }
    return collector.wc.debugger.sendCommand(method, params || {});
  }

  /* ---------------------------- CDP 事件处理 ---------------------------- */

  onCdpMessage(collector, method, params) {
    if (collector.paused) return;

    switch (method) {
      case 'Network.requestWillBeSent': {
        const rec = collector.begin(params.requestId, {
          url: params.request && params.request.url,
          method: params.request && params.request.method,
          headers: params.request && params.request.headers,
          postData: params.request && params.request.postData,
          type: params.type,
          wallTime: params.wallTime,
          // 单调时钟：后面所有耗时都基于它算，不能与 wallTime 混用
          timestamp: params.timestamp,
        });
        // 重定向链：上一跳是丢弃、这一跳是记录，标记出来便于排查
        if (rec && params.redirectResponse) {
          rec.status = params.redirectResponse.status || 0;
          rec.responseHeaders = flattenHeaders(params.redirectResponse.headers);
          rec.mime = params.redirectResponse.mimeType || '';
        }
        break;
      }

      case 'Network.requestWillBeSentExtraInfo': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.requestHeaders = Object.assign({}, rec.requestHeaders, flattenHeaders(params.headers));
        collector.dirty.add(rec.id);
        break;
      }

      case 'Network.responseReceived': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        const res = params.response || {};
        rec.status = res.status || 0;
        rec.statusText = res.statusText || '';
        rec.mime = res.mimeType || '';
        rec.cached = !!res.fromDiskCache || !!res.fromPrefetchCache;
        rec.remoteIP = res.remoteIPAddress
          ? `${res.remoteIPAddress}${res.remotePort ? `:${res.remotePort}` : ''}`
          : '';
        rec.protocol = res.protocol || '';
        rec.responseHeaders = flattenHeaders(res.headers);
        // 收到响应头的时间点：TTFB 的右端（v1.9.0）
        rec.monoResponse = Number(params.timestamp) || 0;
        rec.kind = guessKind(rec.rawUrl || rec.url, rec.mime);
        // 服务端返回体积：无加载完成事件时（如 WebSocket / 长连接）也能显示大小
        if (res.encodedDataLength) rec.size = res.encodedDataLength;
        collector.dirty.add(rec.id);
        break;
      }

      case 'Network.responseReceivedExtraInfo': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.responseHeaders = Object.assign({}, rec.responseHeaders, flattenHeaders(params.headers));
        if (params.statusCode) rec.status = params.statusCode;
        collector.dirty.add(rec.id);
        break;
      }

      case 'Network.dataReceived': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.size += params.dataLength || 0;
        collector.dirty.add(rec.id);
        break;
      }

      case 'Network.loadingFinished': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.finished = true;
        if (params.encodedDataLength) rec.size = params.encodedDataLength;
        applyTiming(rec, Number(params.timestamp) || 0);
        if (!rec.kind) rec.kind = guessKind(rec.rawUrl || rec.url, rec.mime);
        collector.dirty.add(rec.id);
        // 正文只能在这时候取，见 queueBody 的说明
        collector.queueBody(rec);
        break;
      }

      case 'Network.loadingFailed': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.finished = true;
        // canceled 是页面主动中断（跳转、预取取消），与真失败分开表述
        rec.failed = params.errorText || 'failed';
        rec.blockedReason = params.blockedReason || '';
        applyTiming(rec, Number(params.timestamp) || 0);
        collector.dirty.add(rec.id);
        break;
      }

      case 'Network.webSocketCreated': {
        const rec = collector.begin(params.requestId, { url: params.url, method: 'WS', type: 'WebSocket' });
        if (rec) {
          rec.fromWs = true;
          rec.kind = 'ws';
        }
        break;
      }

      case 'Network.webSocketFrameReceived':
      case 'Network.webSocketFrameSent': {
        const rec = collector.records.get(params.requestId);
        if (!rec) break;
        rec.wsFrames = (rec.wsFrames || 0) + 1;
        rec.finished = true;
        collector.dirty.add(rec.id);
        break;
      }

      default:
        break;
    }
  }

  /* ---------------------------- 增量推送 ---------------------------- */

  /** 定时把本周期内的变化批量推给界面 */
  flush() {
    if (!this.enabled) return;

    for (const collector of this.collectors.values()) {
      if (collector.dirty.size === 0) continue;

      const records = [];
      for (const id of collector.dirty) {
        const rec = collector.records.get(id);
        if (rec) records.push(collector.brief(rec));
      }
      collector.dirty.clear();
      if (records.length === 0) continue;

      this.push('nyx:tb:net', {
        tabId: collector.wcId,
        records,
        total: collector.total,
        dropped: collector.dropped,
      });
    }
  }

  /* ---------------------------- 查询接口 ---------------------------- */

  /**
   * 拉某个标签的全量记录。
   * @param {number} wcId
   * @returns {{ok:boolean, records:object[], total:number, dropped:number, error?:string}}
   */
  list(wcId) {
    const collector = this.collectorOf(wcId);
    if (!collector) {
      return { ok: false, error: '该标签没有抓包数据（工具箱未开启或标签已关闭）', records: [], total: 0, dropped: 0 };
    }
    const records = [];
    for (const rec of collector.records.values()) records.push(collector.brief(rec));
    records.sort((a, b) => a.seq - b.seq);
    return { ok: true, records, total: collector.total, dropped: collector.dropped };
  }

  /**
   * 单条请求详情：含完整头、POST 体，文本型响应再取正文预览。
   * @param {number} wcId
   * @param {string} id requestId
   */
  async detail(wcId, id) {
    const collector = this.collectorOf(wcId);
    if (!collector) return { ok: false, error: '该标签没有抓包数据' };
    const rec = collector.records.get(id);
    if (!rec) return { ok: false, error: '该请求已被滚动丢弃' };

    const out = {
      ok: true,
      record: collector.brief(rec),
      rawUrl: rec.rawUrl || rec.url,
      requestHeaders: rec.requestHeaders || {},
      responseHeaders: rec.responseHeaders || {},
      postData: rec.postData || '',
      remoteIP: rec.remoteIP || '',
      protocol: rec.protocol || '',
      bodyPreview: '',
      bodyNote: '',
    };

    // 正文优先用请求结束那一刻抄下来的缓存；没赶上（超额度、已驱逐）再按需补一次
    const textual = TEXTUAL_MIME.test(rec.mime || '');
    if (rec.bodyText !== undefined) {
      out.bodyPreview = rec.bodyText;
      out.bodyNote = rec.bodyNote || '';
    } else if (rec.bodyNote && !(rec.type === 'Document' && /正文(未缓存|不可读|暂不可读)/.test(rec.bodyNote))) {
      out.bodyNote = rec.bodyNote;
    } else if (rec.finished && !rec.failed && textual && collector.attached) {
      try {
        const res = await collector.wc.debugger.sendCommand('Network.getResponseBody', { requestId: id });
        if (res && res.body) {
          const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          out.bodyPreview = text.slice(0, BODY_PREVIEW_LIMIT);
          out.bodyNote = text.length > BODY_PREVIEW_LIMIT ? '正文超过 200KB，已截断预览' : '';
        }
      } catch (err) {
        // 主文档的原始响应体常被内核提前释放，退一步用当前 DOM 序列化顶上，总比空着强
        const dom = await this.documentFallback(collector, rec);
        if (dom) {
          out.bodyPreview = dom.slice(0, BODY_PREVIEW_LIMIT);
          out.bodyNote = dom.length > BODY_PREVIEW_LIMIT
            ? '正文为当前页面 DOM 序列化（原始响应体已被内核释放），超过 200KB 已截断'
            : '正文为当前页面 DOM 序列化（原始响应体已被内核释放）';
          return out;
        }
        // 还在补取轮次内就别吓唬用户：正文往往晚几秒才可读
        const rounds = rec.bodyRetryRound || 0;
        out.bodyNote = rounds < BODY_RETRY_DELAYS.length
          ? '正文暂不可读，正在自动补取，稍后重开本详情即可看到'
          : `正文不可读：${err && err.message ? err.message : '已被内核丢弃'}`;
      }
    } else if (!textual) {
      out.bodyNote = '二进制或流式资源不提供正文预览，可直接下载';
    } else {
      out.bodyNote = '正文尚未就绪（请求还在进行中）。';
    }

    return out;
  }

  /**
   * 主文档正文兜底：CDP 拿不到原始响应体时，用当前页 DOM 序列化顶替。
   * 只在抓包记录对应的就是该标签当前页面时才用，避免把别的页面塞进来。
   */
  async documentFallback(collector, rec) {
    if (rec.type !== 'Document' || !collector.wc || collector.wc.isDestroyed()) return '';
    // 页面常被前端改过 query（如 Bing 补 &first=1），所以按 源+路径 判同一页，不逐字比 URL
    const key = (u) => {
      try {
        const parsed = new URL(String(u || ''));
        return `${parsed.origin}${parsed.pathname}`;
      } catch (_) {
        return String(u || '').split('#')[0];
      }
    };
    const current = key(collector.wc.getURL());
    const target = key(rec.rawUrl || rec.url);
    if (current !== target) {
      console.warn('[Nyx] DOM 兜底跳过（非同一页面）：', target, '|', current);
      return '';
    }
    try {
      const html = await collector.wc.executeJavaScript(
        '(document.doctype ? "<!DOCTYPE " + document.doctype.name + ">\\n" : "") + document.documentElement.outerHTML',
        true,
      );
      return typeof html === 'string' ? html : '';
    } catch (err) {
      console.warn('[Nyx] DOM 兜底失败：', err && err.message);
      return '';
    }
  }

  /** 清空某标签的记录 */
  clear(wcId) {
    const collector = this.collectorOf(wcId);
    if (!collector) return { ok: false, error: '该标签没有抓包数据' };
    collector.clear();
    return { ok: true, total: 0, dropped: 0 };
  }

  /** 暂停 / 恢复某标签的记录（通道保留，只是不入表） */
  setPaused(wcId, paused) {
    const collector = this.collectorOf(wcId);
    if (!collector) return { ok: false, error: '该标签没有抓包数据' };
    collector.paused = !!paused;
    return { ok: true, paused: collector.paused };
  }

  /** 采集器状态（界面用来提示"正在让位给开发者工具"） */
  status(wcId) {
    const collector = this.collectorOf(wcId);
    return {
      ok: true,
      enabled: this.enabled,
      attached: collector ? collector.attached : false,
      paused: collector ? collector.paused : false,
      total: collector ? collector.total : 0,
      dropped: collector ? collector.dropped : 0,
      tabs: this.collectors.size,
    };
  }
}

module.exports = { Toolbox, guessKind, hostOf, safeUrl };
