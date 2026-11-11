'use strict';
/**
 * smart-patrol.js —— 智能遨游调度（Nyx 1.1.1）
 *
 * 在「遨游网络模式（代理）」开启时工作：
 *   1) 每 15 秒巡检当前激活标签的域名，做一次直连连通性探测；
 *   2) 直连可达（延迟低于阈值）→ 判定该域「国内可直连」，写进直连名单；
 *      直连失败/超时 → 判定疑似被墙，再用代理隧道复核，复核通过则写进代理名单；
 *   3) 名单变化后重建 PAC 脚本，交给 sessions 下发（pac_script 模式），
 *      实现「国内直连、被墙走代理」的按域名智能分流；
 *   4) 定期评估节点质量：代理链路延迟劣化或代理名单增长时，触发回调让主进程
 *      重新自动测速并优选节点（保持高速率低延迟）。
 *
 * 规则表持久化在 stateDir/smart-rules.json，重启后沿用；最多保留 300 条，LRU 淘汰。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

/* ---------------- 内置国内域名后缀（直连白名单） ---------------- */
const CN_SUFFIXES = [
  '.cn', '.com.cn', '.net.cn', '.org.cn', '.gov.cn', '.edu.cn', '.ac.cn',
  '.bj.cn', '.sh.cn', '.gd.cn', '.js.cn', '.zj.cn', '.sc.cn', '.hn.cn',
  '.hb.cn', '.fj.cn', '.sd.cn', '.sx.cn', '.cq.cn', '.tj.cn', '.nm.cn',
];

/* 常见国内大站顶级域（后缀表之外补强，避免逐个等 .com 判断） */
const CN_TOP_DOMAINS = new Set([
  'baidu.com', 'qq.com', 'taobao.com', 'tmall.com', 'jd.com', 'weibo.com',
  'zhihu.com', 'bilibili.com', 'douyin.com', 'toutiao.com', '163.com',
  '126.com', 'sina.com.cn', 'sohu.com', 'ifeng.com', 'people.com.cn',
  'xinhuanet.com', 'cctv.com', 'aliyun.com', 'tencent.com', 'bytedance.com',
  'meituan.com', 'dianping.com', 'ele.me', 'xiaohongshu.com', 'kuaishou.com',
  'iqiyi.com', 'youku.com', 'mgtv.com', 'csdn.net', '4399.com', '17173.com',
  'cnblogs.com', 'juejin.cn', 'gitee.com', 'oschina.net', '51job.com',
  'zhipin.com', 'liepin.com', 'ctrip.com', 'qunar.com', '12306.cn', 'cctv.com.cn',
]);

/* 免巡检的本机/内网域名（探测也没意义） */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const DEFAULT_INTERVAL_MS = 15000; // 用户要求：每 15 秒检测一次
const PROBE_DIRECT_TIMEOUT_MS = 3000;
const PROBE_PROXY_TIMEOUT_MS = 4000;
const DIRECT_RTT_MAX_MS = 1200; // 直连延迟高于此值视为「慢」，倾向于走代理
const RULE_TTL_MS = 10 * 60 * 1000; // 单条判定 10 分钟内复用，过期重新探测
const MAX_RULES = 300; // 规则表上限，LRU 淘汰
const RESELECT_EVERY_TICKS = 6; // 每 6 轮（约 90 秒）评估一次节点质量

/** 从 URL 提取裸域名（不含 www 前缀，便于通配匹配） */
function extractHost(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  let host = raw;
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
    else if (/^[a-zA-Z0-9.-]+$/.test(raw)) host = raw;
    else return null;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (LOCAL_HOSTS.has(host)) return null;
  // 剥掉一层 www 前缀，规则统一按裸域匹配 *.domain
  if (host.startsWith('www.')) host = host.slice(4);
  // 纯 IP 不参与域名分流（PAC 对 IP 走默认代理即可）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (!host.includes('.')) return null;
  return host;
}

/** 直连探测：对目标域发起一次 HTTP HEAD（80 端口），记录往返延迟 */
function probeDirect(host, timeoutMs = PROBE_DIRECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = http.get(
      {
        host,
        port: 80,
        path: '/',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'NyxSmartPatrol/1.0', Connection: 'close' },
      },
      (res) => {
        res.resume();
        resolve({ ok: true, rtt: Date.now() - startedAt, status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
  });
}

/** 经代理隧道探测：CONNECT host:80 成功即认为该域经代理可通 */
function probeViaProxy(host, proxyPort, timeoutMs = PROBE_PROXY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${host}:80`,
      timeout: timeoutMs,
      headers: { Host: `${host}:80`, 'User-Agent': 'NyxSmartPatrol/1.0' },
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, rtt: Date.now() - startedAt, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
  });
}

/** 判断域名是否属于内置国内名单 */
function isKnownCn(host) {
  if (CN_TOP_DOMAINS.has(host)) return true;
  for (const s of CN_SUFFIXES) {
    if (host.endsWith(s)) return true;
  }
  return false;
}

class SmartPatrol {
  /**
   * @param {object} opts
   * @param {string} opts.stateDir      规则持久化目录（userData/smart）
   * @param {Function} [opts.getActiveUrl] 返回当前激活标签 URL 的回调
   * @param {Function} [opts.getProxyPort] 返回当前代理端口的回调
   * @param {Function} [opts.onPacChanged]  PAC 文本变化回调 (pacText, info) => void
   * @param {Function} [opts.onReselect]   需要重新优选节点时回调 () => void
   * @param {Function} [opts.log]         日志回调 (level, text) => void
   */
  constructor(opts = {}) {
    this.stateDir = opts.stateDir || '';
    this.getActiveUrl = opts.getActiveUrl || null;
    this.getProxyPort = opts.getProxyPort || null;
    this.onPacChanged = opts.onPacChanged || null;
    this.onReselect = opts.onReselect || null;
    this.log = opts.log || (() => {});

    this.intervalMs = DEFAULT_INTERVAL_MS;
    this.enabled = true; // 开关由代理偏好 smartPatrol 控制，这里只反映巡检器是否激活
    this.running = false;
    this.timer = null;
    this.tickCount = 0;

    /** @type {Map<string, {kind:'direct'|'proxy', at:number, rtt:number|null}>} */
    this.sites = new Map();
    this.lastProbe = null; // 最近一次巡检结论
    this.lastPac = '';
    this.lastPacAt = 0;

    this._load();
  }

  /* ---------------- 生命周期 ---------------- */

  start() {
    if (this.running) return;
    this.running = true;
    // 先按现有规则表立即下发一次 PAC（避免空窗期全代理），随后进入巡检
    const pac = this.buildPac(this.getProxyPort ? this.getProxyPort() : 0);
    if (pac !== this.lastPac && this.onPacChanged) {
      this.lastPac = pac;
      this.lastPacAt = Date.now();
      try {
        this.onPacChanged(pac, this.status());
      } catch (err) {
        this.log('error', `PAC 初始下发失败：${err.message}`);
      }
    }
    this.log('info', `智能遨游调度已启动（每 ${this.intervalMs / 1000} 秒巡检一次）`);
    this.tick().catch((err) => this.log('error', `首轮巡检失败：${err.message}`));
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log('error', `巡检失败：${err.message}`));
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log('info', '智能遨游调度已停止');
  }

  /** 规则表变化时立即重建 PAC 并下发；无变化则静默 */
  async tick() {
    this.tickCount += 1;
    const host = extractHost(this.getActiveUrl ? this.getActiveUrl() : '');
    const proxyPort = this.getProxyPort ? this.getProxyPort() : 0;

    if (host) {
      await this._probeHost(host, proxyPort);
    }

    // 周期性节点质量评估：代理名单膨胀或长期未评估时触发重新优选
    const proxyCount = [...this.sites.values()].filter((s) => s.kind === 'proxy').length;
    if (proxyCount > 0 && this.tickCount % RESELECT_EVERY_TICKS === 0 && this.onReselect) {
      this.log('info', `代理名单 ${proxyCount} 条，触发节点质量评估`);
      try {
        this.onReselect();
      } catch (err) {
        this.log('error', `节点重选触发失败：${err.message}`);
      }
    }

    const pac = this.buildPac(proxyPort);
    if (pac !== this.lastPac) {
      this.lastPac = pac;
      this.lastPacAt = Date.now();
      this._save();
      if (this.onPacChanged) {
        try {
          this.onPacChanged(pac, this.status());
        } catch (err) {
          this.log('error', `PAC 下发失败：${err.message}`);
        }
      }
    }

    return this.status();
  }

  /** 巡检单个域名：直连探测 → 必要时代理复核 → 更新判定 */
  async _probeHost(host, proxyPort) {
    const prev = this.sites.get(host);
    if (prev && Date.now() - prev.at < RULE_TTL_MS) {
      // 结论仍新鲜，直接复用，不重复探测
      return prev;
    }

    // 内置国内名单直接落直连，无需探测（省一次网络请求）
    if (isKnownCn(host)) {
      const verdict = { kind: 'direct', at: Date.now(), rtt: 0, source: 'cn-list' };
      this.sites.set(host, verdict);
      this.lastProbe = { host, ...verdict, at: Date.now() };
      return verdict;
    }

    const direct = await probeDirect(host);
    if (direct.ok && direct.rtt <= DIRECT_RTT_MAX_MS) {
      const verdict = { kind: 'direct', at: Date.now(), rtt: direct.rtt, source: 'probe' };
      this.sites.set(host, verdict);
      this.lastProbe = { host, ...verdict, at: Date.now() };
      return verdict;
    }

    // 直连失败或过慢 → 疑似被墙，走代理复核
    let viaProxy = null;
    if (proxyPort) {
      viaProxy = await probeViaProxy(host, proxyPort);
    }
    if (viaProxy && viaProxy.ok) {
      const verdict = { kind: 'proxy', at: Date.now(), rtt: viaProxy.rtt, source: 'probe' };
      this.sites.set(host, verdict);
      this.lastProbe = { host, ...verdict, at: Date.now() };
      return verdict;
    }

    // 两边都不通：保留原判定（若有），避免抖动
    const verdict = prev || { kind: 'unknown', at: Date.now(), rtt: null, source: 'unreachable' };
    if (prev) {
      this.sites.set(host, { ...prev, at: Date.now() });
    } else {
      this.sites.set(host, verdict);
    }
    this.lastProbe = { host, ...verdict, at: Date.now() };
    return verdict;
  }

  /* ---------------- PAC 生成 ---------------- */

  /**
   * 生成智能分流 PAC：
   *   1) localhost/内网 → DIRECT
   *   2) 内置国内后缀 + 直连名单 → DIRECT
   *   3) 被墙名单 → PROXY 127.0.0.1:{port}
   *   4) 默认 → PROXY（遨游模式兜底：未知站点一律走代理，保证不被墙卡死）
   */
  buildPac(proxyPort) {
    const port = proxyPort || 7890;
    const lines = [];
    lines.push('function FindProxyForURL(url, host) {');
    lines.push('  if (host === "localhost" || shExpMatch(host, "*.local")) return "DIRECT";');
    for (const s of CN_SUFFIXES) {
      lines.push(`  if (shExpMatch(host, "*${s}")) return "DIRECT";`);
    }
    // 直连名单（去重：内置名单已覆盖的不重复写）
    const directHosts = new Set();
    for (const [h, v] of this.sites) {
      if (v.kind === 'direct' && !isKnownCn(h)) directHosts.add(h);
    }
    for (const h of directHosts) {
      lines.push(`  if (shExpMatch(host, "${h}") || shExpMatch(host, "*.${h}")) return "DIRECT";`);
    }
    // 代理名单
    const proxyHosts = new Set();
    for (const [h, v] of this.sites) {
      if (v.kind === 'proxy') proxyHosts.add(h);
    }
    for (const h of proxyHosts) {
      lines.push(`  if (shExpMatch(host, "${h}") || shExpMatch(host, "*.${h}")) return "PROXY 127.0.0.1:${port}";`);
    }
    lines.push(`  return "PROXY 127.0.0.1:${port}";`);
    lines.push('}');
    return lines.join('\n');
  }

  /* ---------------- 状态与规则管理 ---------------- */

  status() {
    const entries = [...this.sites.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 20);
    return {
      running: this.running,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      siteCount: this.sites.size,
      directCount: [...this.sites.values()].filter((s) => s.kind === 'direct').length,
      proxyCount: [...this.sites.values()].filter((s) => s.kind === 'proxy').length,
      lastProbe: this.lastProbe,
      lastPacAt: this.lastPacAt,
      recent: entries.map(([host, v]) => ({ host, kind: v.kind, at: v.at, rtt: v.rtt, source: v.source })),
    };
  }

  /** 清空规则表（域名判定全部作废） */
  clearRules() {
    this.sites.clear();
    this.lastProbe = null;
    this._save();
    this.log('info', '智能分流规则表已清空');
    return { ok: true };
  }

  _load() {
    if (!this.stateDir) return;
    try {
      const file = path.join(this.stateDir, 'smart-rules.json');
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.sites)) {
        for (const item of raw.sites) {
          if (item && typeof item.host === 'string' && (item.kind === 'direct' || item.kind === 'proxy')) {
            this.sites.set(item.host, { kind: item.kind, at: Number(item.at) || 0, rtt: item.rtt ?? null, source: item.source || 'persist' });
          }
        }
      }
    } catch (err) {
      this.log('warn', `智能规则加载失败：${err.message}`);
    }
  }

  _save() {
    if (!this.stateDir) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      // LRU 淘汰：超出上限时按最近判定时间淘汰最旧条目
      let list = [...this.sites.entries()];
      if (list.length > MAX_RULES) {
        list.sort((a, b) => b[1].at - a[1].at);
        list = list.slice(0, MAX_RULES);
        this.sites = new Map(list);
      }
      const payload = {
        updatedAt: Date.now(),
        sites: list.map(([host, v]) => ({ host, kind: v.kind, at: v.at, rtt: v.rtt, source: v.source })),
      };
      const tmp = path.join(this.stateDir, 'smart-rules.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, path.join(this.stateDir, 'smart-rules.json'));
    } catch (err) {
      this.log('warn', `智能规则保存失败：${err.message}`);
    }
  }
}

module.exports = { SmartPatrol, extractHost, probeDirect, probeViaProxy, isKnownCn, CN_SUFFIXES, CN_TOP_DOMAINS };
