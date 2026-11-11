'use strict';

/**
 * Nyx 内置代理服务（浏览器自带的类 Clash 代理层）。
 *
 * 把「订阅持久化 + 配置净化 + 内核进程 + 节点控制」收拢成一层，供主进程与代理中心
 * 界面调用。设计边界：
 *   - 只服务 Nyx 自身：各 session 的 fixed_servers 指向内核混合端口；
 *   - 不碰系统代理、不改任何全局网络设置；
 *   - 订阅地址只在本地落盘，对外展示一律脱敏；
 *   - 内核停止即删配置文件（内含节点凭据），不留后台进程。
 */

const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { ProxyStore, maskUrl } = require('./proxy-store');
const { ProxyKernel } = require('./proxy-kernel');
const { fetchSubscription } = require('./proxy-config');
const { listInterfaces: listNetInterfaces, findInterface } = require('./net-interfaces');

/** 测速默认目标：只回 204 的裸地址，不产生业务流量 */
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
/** 测速并发上限：内核就绪后要一次性把全部节点测完，并发太高会让全部节点一起超时 */
const TEST_CONCURRENCY = 32;
/** 单次批量测速的节点上限（超出部分不测，避免极端订阅把界面拖死） */
const TEST_MAX_NODES = 300;
/** 出口自查所用地址（明文 HTTP，便于经内核端口直接取回纯文本） */
const EGRESS_URL = 'http://api.ipify.org/';
/** 直连线路自查地址：同一个端点、不经代理，用于判断「出口 IP 是否真的换了」 */
const DIRECT_IP_URL = 'http://api.ipify.org/';
/**
 * 直连对照 IP 的候选端点：单个站点被本机网络重置时仍有对照组可用。
 * 全部用明文 HTTP（与 EGRESS_URL 同理，避免本机 HTTPS 扫描导致直连全灭）。
 */
const DIRECT_IP_PROVIDERS = [
  { name: 'api.ipify.org', url: 'http://api.ipify.org/' },
  { name: 'checkip.amazonaws.com', url: 'http://checkip.amazonaws.com/' },
  { name: 'ipv4.icanhazip.com', url: 'http://ipv4.icanhazip.com/' },
  { name: 'ifconfig.me', url: 'http://ifconfig.me/ip' },
  { name: 'ip-api.com/line', url: 'http://ip-api.com/line/?fields=query' },
];
/** 出口归属地 / ISP / ASN / 时区查询服务（明文 HTTP，按顺序回退） */
const GEO_PROVIDERS = [
  {
    name: 'ip-api.com',
    url: 'http://ip-api.com/json/?fields=status,message,query,country,regionName,city,isp,org,as,timezone,proxy,hosting',
    parse: (data) => ({
      ip: data.query,
      country: data.country,
      region: data.regionName,
      city: data.city,
      isp: data.isp || data.org,
      org: data.org,
      asn: data.as,
      timezone: data.timezone,
      proxy: typeof data.proxy === 'boolean' ? data.proxy : null,
      hosting: typeof data.hosting === 'boolean' ? data.hosting : null,
    }),
  },
  {
    name: 'ipwho.is',
    url: 'http://ipwho.is/',
    parse: (data) => {
      const conn = data.connection || {};
      return {
        ip: data.ip,
        country: data.country,
        region: data.region,
        city: data.city,
        isp: conn.isp || conn.org,
        org: conn.org,
        asn: conn.asn ? `AS${conn.asn}` : '',
        timezone: data.timezone ? data.timezone.id : '',
      };
    },
  },
  {
    name: 'ipapi.co',
    url: 'http://ipapi.co/json/',
    parse: (data) => ({
      ip: data.ip,
      country: data.country_name,
      region: data.region,
      city: data.city,
      isp: data.org,
      org: data.org,
      asn: data.asn ? String(data.asn) : '',
      timezone: data.timezone,
    }),
  },
];
/** 出口自查超时（毫秒） */
const EGRESS_TIMEOUT_MS = 8000;

/** 把 "AS13335 Cloudflare, Inc." 拆成 { asnNumber, asnOrg } */
function splitAsn(value) {
  const text = String(value || '').trim();
  if (!text) return { asnNumber: '', asnOrg: '' };
  const match = /^(AS\d+)\s*(.*)$/i.exec(text);
  if (match) return { asnNumber: match[1].toUpperCase(), asnOrg: match[2].trim() };
  return { asnNumber: text.toUpperCase(), asnOrg: '' };
}

/** 归属国 → 语言候选（用于全隐私模式的语言对齐，避免 IP 与 Accept-Language 自相矛盾） */
function languagesForCountry(country) {
  const table = {
    'United States': 'en-US,en;q=0.9',
    'United Kingdom': 'en-GB,en;q=0.9',
    Canada: 'en-CA,en;q=0.9,fr-CA;q=0.8',
    Australia: 'en-AU,en;q=0.9',
    Germany: 'de-DE,de;q=0.9,en;q=0.8',
    France: 'fr-FR,fr;q=0.9,en;q=0.8',
    Netherlands: 'nl-NL,nl;q=0.9,en;q=0.8',
    Japan: 'ja-JP,ja;q=0.9,en;q=0.8',
    'South Korea': 'ko-KR,ko;q=0.9,en;q=0.8',
    Singapore: 'en-SG,en;q=0.9,zh-CN;q=0.8',
    'Hong Kong': 'zh-HK,zh;q=0.9,en;q=0.8',
    Taiwan: 'zh-TW,zh;q=0.9,en;q=0.8',
    'China': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  return table[country] || '';
}

/**
 * 不经代理的直接请求（明文 HTTP，Node 原生实现）。
 *
 * 用途只有一个：取回"真实线路出口 IP"作为对照组。之所以用明文 HTTP 而不是
 * HTTPS：本机若装了带 HTTPS 扫描的安全软件，Node 的 CA 列表不认它的中间证书，
 * 直连 HTTPS 会直接失败，对照组就没了。
 */
function fetchDirect(url, timeoutMs = EGRESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Host: target.host, 'User-Agent': 'Nyx/0.1', Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`直连查询返回 HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('直连查询超时')));
    req.on('error', (err) => reject(new Error(`直连查询失败：${err.message}`)));
    req.end();
  });
}

/** 策略组类型：这些条目是"可切换的组"，不算普通节点 */
const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay']);
/** 内核内置条目：不出现在节点列表里 */
const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'PassRule', 'Dns']);

/** 并发受限的 map */
function chunkParallel(items, limit, worker) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      await worker(items[index], index);
    }
  });
  return Promise.all(runners);
}

/** 取节点最近一次测速结果；没有记录返回 -1 */
function lastDelay(item) {
  const history = item && Array.isArray(item.history) ? item.history : [];
  const last = history[history.length - 1];
  return last && typeof last.delay === 'number' ? last.delay : -1;
}

/**
 * 经内核混合端口发起一次明文 HTTP 请求（HTTP 代理语义：请求行写绝对 URL）。
 *
 * 只用于"出口自查"这一个用途：拿到结果即证明浏览器所走的链路确实是内核在转发。
 */
function fetchViaProxy(port, url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('出口自查地址非法'));
      return;
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: target.href,
        headers: { Host: target.host, 'User-Agent': 'Nyx/0.1', Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`出口自查返回 HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error('出口自查超时')));
    req.on('error', (err) => reject(new Error(`出口自查失败：${err.message}`)));
    req.end();
  });
}

class ProxyService extends EventEmitter {
  /**
   * @param {{stateDir:string, vendorDir:string, fetcher?:Function, resolveProxyPort?:Function}} opts
   *   resolveProxyPort：返回"浏览器当前实际在用的代理端口"。内核未运行时会回落外置代理，
   *   此时出口自查要查外置代理的端口，否则会把直连结果误报成出口 IP。
   */
  constructor({ stateDir, vendorDir, fetcher = null, resolveProxyPort = null }) {
    super();

    this.store = new ProxyStore({ stateDir });
    /**
     * 订阅拉取实现。Electron 主进程注入基于 net.fetch 的版本：它走 Chromium
     * 网络栈与系统证书库，能兼容本机带 HTTPS 扫描的安全软件签发中间证书的情况；
     * 不注入时用模块自带的 Node http/https 实现（离线测试等场景）。
     */
    this.fetcher = typeof fetcher === 'function' ? fetcher : null;
    this.resolveProxyPort = typeof resolveProxyPort === 'function' ? resolveProxyPort : null;
    this.kernel = new ProxyKernel({
      binPath: path.join(vendorDir, 'mihomo', 'mihomo.exe'),
      runtimeDir: path.join(stateDir, 'kernel-runtime'),
    });

    this.fetching = false;
    this.testing = false;
    this.lastExitIp = null;
    this.lastEgressAt = null;
    /** 最近一次出口自查的完整结果（IP / 归属地 / ISP / ASN / 时区 / 一致性判定） */
    this.lastEgress = null;
    /** 最近一次批量测速的结果与统计 */
    this.lastTest = null;
    /** 内核就绪后的自动测速句柄（用于取消/去重） */
    this.autoTestTimer = null;

    const relay = () => this.emit('change', this.status());
    this.kernel.on('started', relay);
    this.kernel.on('stopped', relay);
    this.kernel.on('exit', relay);
    this.kernel.on('error', (err) => {
      this.emit('log', { level: 'error', text: err.message });
      relay();
    });
    this.kernel.on('log', (entry) => this.emit('log', entry));
  }

  /** 载入本地订阅状态（不启动内核） */
  init() {
    this.store.load();
    return this.status();
  }

  /** 内核是否正在运行 */
  get running() {
    return this.kernel.running;
  }

  /** 当前实际生效的代理端口（内核未运行时为 null，由上层回落外置代理） */
  get port() {
    return this.kernel.running ? this.kernel.mixedPort : null;
  }

  /** 面向界面与主进程的状态快照（不含节点凭据与订阅原文） */
  status() {
    const view = this.store.listForUi();
    const active = this.store.activeSubscription();
    const iface = this._interfacePrefs();

    return {
      running: this.kernel.running,
      fetching: this.fetching,
      testing: this.testing,
      mixedPort: this.kernel.mixedPort,
      exitIp: this.lastExitIp,
      egressCheckedAt: this.lastEgressAt,
      egress: this.lastEgress,
      test: this.lastTest
        ? { at: this.lastTest.at, reason: this.lastTest.reason, summary: this.lastTest.summary }
        : null,
      activeId: view.activeId,
      activeName: active ? active.name : '',
      activeUrlMasked: active ? maskUrl(active.url) : '',
      activeLastFetchAt: active ? active.lastFetchAt : null,
      activeLastError: active ? active.lastError : null,
      nodeCount: active ? active.nodeCount : 0,
      subscriptions: view.subscriptions,
      preferences: view.preferences,
      // 出站网卡：偏好（自动 / 手动）与内核实际写入的网卡名，界面据此区分「已设置」与「已生效」
      interfaceMode: iface.mode,
      interfaceName: iface.name,
      interfaceActive: this.kernel.interfaceName,
      kernel: this.kernel.getState(),
    };
  }

  /* ---------------- 出站网卡（手动 / 自动选择） ---------------- */

  /** 出站网卡偏好：auto=跟随系统默认路由，manual=绑定指定网卡 */
  _interfacePrefs() {
    const prefs = this.store.load().preferences || {};
    const mode = prefs.interfaceMode === 'manual' ? 'manual' : 'auto';
    const name = mode === 'manual' ? String(prefs.interfaceName || '').trim() : '';
    return { mode, name };
  }

  /** 枚举本机可用网卡，并带上当前偏好（界面据此渲染下拉框与选中项） */
  async listInterfaces() {
    const listed = await listNetInterfaces();
    return Object.assign({}, listed, { preference: this._interfacePrefs() });
  }

  /**
   * 设置出站网卡：自动跟随系统默认路由，或手动绑定指定网卡。
   *
   * 手动模式先校验网卡是否在位——内核收到不存在的网卡名照样启动，只在真实拨号时
   * 报 `interface not found`（连 DNS 都解析不了），所以必须在写配置前把关。
   * 内核在跑时直接重建：网卡名只在生成配置那一刻写入，不重建等于没改。
   * 重建失败（新网卡不可用等）则把偏好回滚到改动前的值，避免浏览器停在
   * 「配置里写着、内核用不了」的状态。
   *
   * @param {{mode?:string, name?:string}} payload mode: 'auto' | 'manual'
   */
  async setOutboundInterface({ mode, name } = {}) {
    const nextMode = mode === 'manual' ? 'manual' : 'auto';
    let nextName = '';

    if (nextMode === 'manual') {
      const found = await findInterface(name);
      if (!found.ok) return { ok: false, error: found.error };
      nextName = found.item.name;
    }

    const previous = this._interfacePrefs();
    if (previous.mode === nextMode && previous.name === nextName) {
      this.emit('change', this.status());
      return {
        ok: true,
        restarted: false,
        unchanged: true,
        preference: { mode: nextMode, name: nextName },
      };
    }

    this.store.setPreference('interfaceMode', nextMode);
    this.store.setPreference('interfaceName', nextName);

    let restarted = false;
    let error = '';
    if (this.kernel.running) {
      const result = await this.start({ restart: true });
      restarted = Boolean(result && result.ok);
      if (!restarted) {
        error = (result && result.error) || '重建内核失败';
        this.store.setPreference('interfaceMode', previous.mode);
        this.store.setPreference('interfaceName', previous.name);
      }
    }

    this.emit('change', this.status());
    return { ok: !error, restarted, error, preference: this._interfacePrefs() };
  }

  /**
   * 启动内核：拉取当前订阅（直连）→ 净化配置 → 校验 → 拉起进程。
   *
   * @param {{restart?:boolean, rawText?:string}} [opts]
   *   restart=true 走「重建」语义：内核在跑时先对新配置做预检，通过后才停旧起新；
   *   rawText 为调用方已拉取的订阅原文，传入可省掉一次网络请求。
   */
  async start({ restart = false, rawText = null } = {}) {
    if (this.kernel.running && !restart) {
      return { ok: true, reused: true, kernel: this.kernel.getState() };
    }

    // 出站网卡偏好先落到内核对象上：预检与正式生成配置都要读它。
    // 重建语义是「先预检新配置、通过后再停旧内核」，所以必须在这之前设置。
    const iface = this._interfacePrefs();
    this.kernel.setOutboundInterface(iface.name);

    const sub = this.store.activeSubscription();
    if (!sub) {
      return { ok: false, error: '尚未配置订阅，无法启动内置代理' };
    }

    this.fetching = true;
    this.emit('change', this.status());

    try {
      let raw = rawText;
      let prepared = null;

      if (restart && this.kernel.running) {
        // 先预检再停旧内核：配置有问题时保留现有内核继续服务，避免「停了才发现起不来」
        const probe = await this._pullAndPrecheck(sub);
        if (!probe.ok) {
          this.fetching = false;
          this.emit('change', this.status());
          return { ok: false, error: probe.error, kernelKept: true };
        }
        raw = probe.raw;
        prepared = probe.prepared;
        await this.kernel.stop();
      } else if (!raw) {
        raw = await fetchSubscription(sub.url, this.fetcher ? { fetcher: this.fetcher } : {});
      }

      const kernel = await this.kernel.start(raw, { prepared });
      // 节点数以内核 /proxies 为准（净化后配置的粗略行数统计会把策略组也算进去）
      this.store.markFetch(sub.id, { ok: true, nodeCount: await this.countNodes() });
      this.lastExitIp = null;
      this.lastEgressAt = null;
      this.lastEgress = null;
      this.fetching = false;
      this.emit('change', this.status());
      // 内核就绪后异步开跑：自动测速 + 出口信息刷新，都不阻塞启动流程
      this.scheduleAutoRoutines();
      return { ok: true, kernel };
    } catch (err) {
      this.fetching = false;
      this.store.markFetch(sub.id, { ok: false, message: err.message });
      this.emit('change', this.status());
      return { ok: false, error: err.message };
    }
  }

  /**
   * 拉取指定订阅并做内核配置预检（预检不触碰在跑的内核进程）。
   *
   * 预检失败时把错误写回该订阅记录并返回 ok:false，调用方据此中止换源，
   * 让当前生效的订阅与在跑的内核保持不变。
   *
   * @param {object} sub 订阅记录
   * @returns {Promise<{ok:boolean, raw?:string, prepared?:object, error?:string}>}
   */
  async _pullAndPrecheck(sub) {
    let raw;
    try {
      raw = await fetchSubscription(sub.url, this.fetcher ? { fetcher: this.fetcher } : {});
    } catch (err) {
      this.store.markFetch(sub.id, { ok: false, message: err.message });
      return { ok: false, error: err.message };
    }

    const prepared = await this.kernel.precheck(raw);
    if (!prepared.ok) {
      this.store.markFetch(sub.id, { ok: false, message: prepared.error });
      return { ok: false, error: prepared.error, raw };
    }

    return { ok: true, raw, prepared };
  }

  /**
   * 内核就绪后的自动动作：
   *   1) 稍等内核内部策略组完成首轮健康检查，再对全部有效节点并发测速并排序（默认开启）；
   *   2) 刷新出口 IP 信息（公网 IP / 归属地 / ISP / ASN / 时区 / 一致性判定）。
   *
   * 用 setTimeout 而不是立即执行：内核刚起来的几秒内 /proxies 还没稳定，
   * 立刻测速会把一堆节点错判成超时。
   *
   * 出口自查属真实外联请求，按规范只在用户主动点击（或隐私模式校验）时发起，
   * 默认不随内核启动自动执行，需偏好 autoEgress 显式开启。
   */
  scheduleAutoRoutines({ delayMs = 2500 } = {}) {
    if (this.autoTestTimer) clearTimeout(this.autoTestTimer);
    const prefs = this.store.load().preferences || {};
    const autoTest = prefs.autoTest !== false;
    const autoEgress = prefs.autoEgress === true;

    this.autoTestTimer = setTimeout(async () => {
      this.autoTestTimer = null;
      if (!this.kernel.running) return;
      try {
        if (autoTest) await this.autoTest();
        if (autoEgress) await this.checkEgress();
      } catch (err) {
        this.emit('log', { level: 'error', text: `自动任务失败：${err.message}` });
      }
    }, delayMs);
    if (this.autoTestTimer.unref) this.autoTestTimer.unref();
  }

  /** 停止内核 */
  async stop() {
    if (this.autoTestTimer) {
      clearTimeout(this.autoTestTimer);
      this.autoTestTimer = null;
    }
    await this.kernel.stop();
    this.lastExitIp = null;
    this.lastEgressAt = null;
    this.lastEgress = null;
    this.lastTest = null;
    this.emit('change', this.status());
    return { ok: true };
  }

  /** 重新拉取当前订阅并重启内核（订阅内容变更后生效） */
  async refresh() {
    return this.start({ restart: true });
  }

  /* ---------------- 订阅管理 ---------------- */

  addSubscription({ name, url }) {
    const result = this.store.addSubscription({ name, url });
    this.emit('change', this.status());
    return result;
  }

  async removeSubscription(id) {
    const wasActive = this.store.load().activeId === id;
    const result = this.store.removeSubscription(id);
    if (!result.ok) return result;

    if (wasActive) {
      await this.kernel.stop();
      this.lastExitIp = null;
      if (result.activeId) await this.start();
    }

    this.emit('change', this.status());
    return result;
  }

  /** 切换启用订阅：换源必须重启内核才生效 */
  async switchSubscription(id) {
    const view = this.store.load();
    if (view.activeId === id) return { ok: true, reused: true };

    const target = view.subscriptions.find((item) => item.id === id);
    if (!target) return { ok: false, error: '订阅不存在' };

    // 内核在跑时先拉取并预检新订阅：换源失败不能连累当前可用的代理
    if (this.kernel.running) {
      this.fetching = true;
      this.emit('change', this.status());
      const probe = await this._pullAndPrecheck(target);
      this.fetching = false;
      this.emit('change', this.status());

      if (!probe.ok) return { ok: false, error: probe.error, kernelKept: true };

      const result = this.store.setActive(id);
      if (!result.ok) return result;

      await this.kernel.stop();
      return this.start({ rawText: probe.raw });
    }

    const result = this.store.setActive(id);
    if (!result.ok) return result;

    await this.kernel.stop();
    return this.start();
  }

  setPreference(key, value) {
    const prefs = this.store.setPreference(key, value);
    this.emit('change', this.status());
    return prefs;
  }

  /* ---------------- 节点 ---------------- */

  /** 节点与策略组清单 */
  async nodes() {
    if (!this.kernel.running) {
      return { ok: false, error: '内核未运行', groups: [], nodes: [] };
    }

    try {
      const proxies = await this.kernel.proxies();
      const groups = [];
      const nodes = [];

      for (const [name, item] of Object.entries(proxies)) {
        const type = item && item.type ? item.type : '';

        if (GROUP_TYPES.has(type)) {
          groups.push({
            name,
            type,
            now: item.now || '',
            members: Array.isArray(item.all) ? item.all : [],
          });
        } else if (type && !BUILTIN_TYPES.has(type)) {
          nodes.push({ name, type, delay: lastDelay(item) });
        }
      }

      const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
      groups.sort(byName);
      nodes.sort(byName);

      return { ok: true, groups, nodes };
    } catch (err) {
      return { ok: false, error: err.message, groups: [], nodes: [] };
    }
  }

  /** 统计当前订阅下的可用节点数（排除策略组与内核内置条目），供界面展示 */
  async countNodes() {
    if (!this.kernel.running) return 0;

    try {
      const proxies = await this.kernel.proxies();
      return Object.values(proxies).filter((item) => {
        const type = item && item.type ? item.type : '';
        return type && !GROUP_TYPES.has(type) && !BUILTIN_TYPES.has(type);
      }).length;
    } catch {
      return 0;
    }
  }

  /**
   * 批量并发测速。
   *
   * 三种入口共用：内核就绪后的自动测速（reason='auto'）、界面「重新测速」
   * （reason='manual'）、单节点重测（reason='single'）。结果里区分
   * ok / timeout / unavailable 三态，并给出按延迟升序的排名，供界面排序展示。
   *
   * @param {string[]|null} names 节点名列表；留空表示对全部有效节点测速
   * @param {{reason?:'auto'|'manual'|'single'}} [opts]
   */
  async testNodes(names, { reason = 'manual' } = {}) {
    if (!this.kernel.running) {
      return { ok: false, error: '内核未运行', results: {}, summary: null };
    }
    if (this.testing) {
      return { ok: false, error: '测速正在进行中', results: {}, summary: null, skipped: true };
    }

    let list = Array.isArray(names) ? names.filter(Boolean) : [];
    if (!list.length) {
      const snapshot = await this.nodes();
      list = snapshot.nodes.map((node) => node.name);
    }
    list = list.slice(0, TEST_MAX_NODES);
    if (!list.length) {
      return { ok: false, error: '当前订阅没有可用节点', results: {}, summary: null };
    }

    const testUrl = this.store.load().preferences.testUrl || DEFAULT_TEST_URL;
    const startedAt = Date.now();
    const results = {};
    this.testing = true;
    this.emit('change', this.status());

    try {
      await chunkParallel(list, TEST_CONCURRENCY, async (name) => {
        results[name] = await this.kernel.delay(name, testUrl);
      });

      const entries = list.map((name) => ({
        name,
        delay: results[name] ? results[name].delay : -1,
        status: results[name] ? results[name].status : 'unavailable',
      }));
      const okList = entries.filter((item) => item.status === 'ok');
      const delays = okList.map((item) => item.delay);

      // 排名：先按可用节点延迟升序，超时与不可用排在后面（同类按名称稳定排序）
      const weight = { ok: 0, timeout: 1, unavailable: 2 };
      const ranking = entries
        .slice()
        .sort((a, b) => weight[a.status] - weight[b.status] || (a.status === 'ok' ? a.delay - b.delay : 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .map((item) => item.name);

      const summary = {
        total: list.length,
        ok: okList.length,
        timeout: entries.filter((item) => item.status === 'timeout').length,
        unavailable: entries.filter((item) => item.status === 'unavailable').length,
        min: delays.length ? Math.min(...delays) : -1,
        max: delays.length ? Math.max(...delays) : -1,
        avg: delays.length ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length) : -1,
        testUrl,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        concurrency: TEST_CONCURRENCY,
        ranking,
      };

      this.lastTest = { at: Date.now(), reason, results, summary };
      return { ok: true, results, summary };
    } finally {
      this.testing = false;
      this.emit('change', this.status());
    }
  }

  /** 自动测速（内核就绪后触发）；已在测速中则跳过，避免重复把内核打满 */
  async autoTest() {
    if (this.testing) return { ok: false, error: '测速进行中', skipped: true };
    return this.testNodes(null, { reason: 'auto' });
  }

  /** 切换某个策略组当前选中的节点 */
  async select(groupName, nodeName) {
    if (!this.kernel.running) return { ok: false, error: '内核未运行' };

    try {
      await this.kernel.select(groupName, nodeName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * 依次尝试多个归属地服务，返回第一个成功的结果（含 ASN 拆分后的号码与机构）。
   * @param {number} port 经哪个代理端口查询（必须与被测出口一致）
   */
  async fetchGeo(port) {
    const errors = [];

    for (const provider of GEO_PROVIDERS) {
      try {
        const text = await fetchViaProxy(port, provider.url, EGRESS_TIMEOUT_MS);
        const data = JSON.parse(text);
        if (data && data.status === 'fail') {
          errors.push(`${provider.name}: ${data.message || '查询被拒绝'}`);
          continue;
        }
        const parsed = provider.parse(data);
        if (!parsed || !parsed.ip) {
          errors.push(`${provider.name}: 返回结果缺少 IP`);
          continue;
        }
        const { asnNumber, asnOrg } = splitAsn(parsed.asn);
        return { ok: true, provider: provider.name, data: { ...parsed, asnNumber, asnOrg } };
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
      }
    }

    return { ok: false, error: errors.join('；') };
  }

  /**
   * 出口自查（代理中心「刷新出口信息」与内核就绪后的自动刷新都走这里）。
   *
   * 一次做完四件事：
   *   1) 经当前实际生效的代理端口取回公网 IP —— 这就是浏览器真实的出口 IP；
   *   2) 查询该 IP 的归属地 / 城市 / ISP / ASN / 时区；
   *   3) 用同一个端点走直连，取回"真实线路 IP"作为对照组；
   *   4) 比对两组 IP，给出「代理链路是否真的生效」的判定。
   *
   * 第 3 步是这次补齐的关键：只看出口 IP 数字无法判断代理有没有生效，
   * 必须有一个不经代理的对照值才能说明问题。
   */
  async checkEgress() {
    const port = this.resolveProxyPort ? this.resolveProxyPort() : this.port;
    const at = Date.now();

    if (!port) {
      this.lastExitIp = null;
      this.lastEgressAt = at;
      this.lastEgress = {
        at,
        ok: false,
        link: 'none',
        port: null,
        verdict: 'fail',
        note: '当前没有可用代理端口（内置内核未运行，且未配置外置代理回退）',
        error: '代理端口不可用',
      };
      this.emit('change', this.status());
      return this.lastEgress;
    }

    const link =
      this.kernel.running && port === this.kernel.mixedPort ? 'builtin-kernel' : 'external';
    const result = {
      at,
      ok: false,
      link,
      port,
      ip: null,
      directIp: null,
      directProvider: '',
      geo: null,
      geoProvider: '',
      localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      timezoneMatch: null,
      verdict: 'unknown',
      note: '',
    };

    try {
      const text = (await fetchViaProxy(port, EGRESS_URL, EGRESS_TIMEOUT_MS)).trim();
      result.ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(text) ? text : text.slice(0, 64);
      this.lastExitIp = result.ip;

      const geo = await this.fetchGeo(port);
      if (geo.ok) {
        result.geo = geo.data;
        result.geoProvider = geo.provider;
      } else {
        result.geoError = geo.error;
      }

      // 直连对照：逐个候选端点尝试，任意一个取到就用（全部失败才退化成"无法判定"）
      const directErrors = [];
      for (const provider of DIRECT_IP_PROVIDERS) {
        try {
          const directText = (await fetchDirect(provider.url, EGRESS_TIMEOUT_MS)).trim();
          if (!directText) {
            directErrors.push(`${provider.name}: 返回内容为空`);
            continue;
          }
          result.directIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(directText)
            ? directText
            : directText.slice(0, 64);
          result.directProvider = provider.name;
          break;
        } catch (err) {
          directErrors.push(`${provider.name}: ${err.message}`);
        }
      }
      if (!result.directIp) {
        result.directError = directErrors.join('；');
      }

      if (result.geo && result.geo.timezone) {
        result.timezoneMatch = result.geo.timezone === result.localTimezone;
      }

      if (result.directIp) {
        if (result.directIp === result.ip) {
          result.verdict = 'leak';
          result.note = '出口 IP 与直连线路一致：流量没有走代理，或代理把连接直连兜底';
        } else {
          result.verdict = 'ok';
          result.note = '出口 IP 与直连线路不同：代理链路确实在转发流量';
        }
      } else {
        result.verdict = 'unknown';
        result.note = `未能取到直连对照 IP（${result.directError || '未知原因'}），只能确认代理链路可通，无法比对是否与真实线路一致`;
      }

      result.ok = true;
    } catch (err) {
      result.error = err.message;
      result.verdict = 'fail';
      result.note = '取不到出口 IP：代理链路当前不可用';
      this.lastExitIp = null;
    }

    this.lastEgressAt = result.at;
    this.lastEgress = result;
    this.emit('change', this.status());
    return result;
  }

  /**
   * 出口画像：把最近一次出口自查里对"隐私伪装"有用的字段抽出来，
   * 供全隐私模式做时区 / 语言对齐（避免出现"IP 在美国、时区却是上海"这种自相矛盾）。
   */
  egressProfile() {
    const egress = this.lastEgress;
    const geo = egress && egress.geo ? egress.geo : null;

    return {
      ip: egress ? egress.ip : null,
      country: geo ? geo.country || '' : '',
      timezone: geo ? geo.timezone || '' : '',
      language: geo ? languagesForCountry(geo.country) : '',
      isp: geo ? geo.isp || '' : '',
      asn: geo ? geo.asnNumber || '' : '',
      link: egress ? egress.link : '',
      checkedAt: egress ? egress.at : null,
    };
  }
}

module.exports = {
  ProxyService,
  DEFAULT_TEST_URL,
  EGRESS_URL,
  DIRECT_IP_URL,
  DIRECT_IP_PROVIDERS,
  GEO_PROVIDERS,
  TEST_CONCURRENCY,
  TEST_MAX_NODES,
  languagesForCountry,
  splitAsn,
  fetchDirect,
};
