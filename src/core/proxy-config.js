'use strict';

/**
 * 订阅获取与「内核配置净化」。
 *
 * 机场下发的订阅是面向 Clash Verge 这类通用客户端的，其默认参数直接喂给内置内核
 * 会带来两类问题：
 *
 *   1) 对外暴露。订阅实测值：allow-lan: true（代理端口开给整个局域网）、
 *      external-controller 写成 ':9090'（等价 0.0.0.0:9090，且不带 secret，
 *      同网段任何人可读取/切换节点、改规则）、dns.listen: 0.0.0.0:1053（DNS 也开出去）。
 *   2) 端口打架。mixed-port: 7890 / port: 7890 / socks-port: 7891 与本机既有
 *      Clash 客户端默认端口重叠，同机共存时互相抢占。
 *
 * 所以内置内核不直接吃订阅原文，先经本模块净化：
 *   - 端口、监听、控制接口、UI 面板等敏感顶层键一律丢弃，由 Nyx 统一重写；
 *   - 强制只绑回环、关闭 allow-lan、关闭 tun；
 *   - 注入随机 secret 保护控制接口；
 *   - 删除 dns.listen，避免 DNS 对外服务。
 *
 * 净化采用「按行重写顶层键」而非 YAML 全量解析重建：既避免引入额外 YAML 依赖，
 * 又能原样保留订阅里的节点、规则与注释。改坏的风险由内核自身的 `-t` 配置校验兜底
 * （见 proxy-kernel.js 的 verifyConfig）。
 */

const http = require('http');
const https = require('https');

const { filterAdProxies } = require('./proxy-filter');

/** 由 Nyx 统一重写的顶层键：订阅里出现即丢弃，改用覆盖块的值 */
const OVERRIDDEN_TOP_KEYS = new Set([
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'mixed-port',
  'allow-lan',
  'bind-address',
  'mode',
  'log-level',
  'ipv6',
  'external-controller',
  'external-controller-cors',
  'external-ui',
  'external-ui-name',
  'external-ui-url',
  'secret',
  'tun',
  // 出站网卡由「设置中心 · 网络与代理」的网卡选择决定，订阅里写了也要丢弃
  'interface-name',
]);

/** 覆盖块锚点：插在代理列表之前，保持配置可读 */
const ANCHOR_KEY = 'proxies';

/**
 * 生成覆盖块：内置内核的固定运行参数（仅回环监听、无任何对外服务）。
 * @param {{mixedPort:number, controllerPort:number, secret:string, interfaceName?:string}} opts
 *   interfaceName：手动指定的出站网卡名；留空表示跟随系统默认路由（自动模式）。
 * @returns {string[]}
 */
function buildOverrideBlock({ mixedPort, controllerPort, secret, interfaceName = '' }) {
  const lines = [
    '# ===== Nyx 内置内核运行参数（自动生成，手改无效） =====',
    `mixed-port: ${mixedPort}`,
    'allow-lan: false',
    'bind-address: 127.0.0.1',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    `external-controller: 127.0.0.1:${controllerPort}`,
    `secret: '${secret}'`,
  ];

  // 手动绑定出站网卡：内核的出站连接与 DNS 解析都从该网卡发出。
  // 网卡名可能含空格与中文（如「以太网 4」），必须加引号；
  // 单引号按 YAML 规则转义成两个单引号，避免网卡名里的引号把配置写坏。
  const iface = String(interfaceName || '')
    .trim()
    .replace(/'/g, "''");
  if (iface) lines.push(`interface-name: '${iface}'`);

  lines.push('tun:', '  enable: false', '# ===== 覆盖结束 =====', '');
  return lines;
}

/**
 * 探测 YAML 块内子项使用的缩进宽度。
 *
 * 各机场订阅的缩进风格不统一：有的整体两空格（Clash Verge 模板），有的整体四空格
 * （本机订阅一实测为四空格）。重写块内某几行时若不沿用原文缩进，就会出现
 *
 *   dns:
 *     enable: true          <- 两空格
 *       default-nameserver: <- 原文四空格，被当成 enable 的续行
 *
 * 这类「同块内缩进深浅不一」的写法，内核会直接判定
 * `yaml: line N: mapping values are not allowed in this context` 而拒绝启动。
 *
 * @param {string[]} block 含首行的完整块
 * @returns {string} 子项缩进字符串（至少两空格；无法判定时回退默认值）
 */
function detectChildIndent(block) {
  for (let i = 1; i < block.length; i += 1) {
    const line = block[i];
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;
    const matched = /^([ \t]+)\S/.exec(line);
    if (!matched) return '  ';
    // YAML 不允许 tab 缩进，遇到就退回默认值，交由内核校验兜底
    if (matched[1].includes('\t')) return '  ';
    return matched[1];
  }
  return '  ';
}

/**
 * 重写订阅里的 dns 块：只保留内核自用解析，杜绝 DNS 对外服务。
 *
 *   - 丢弃 listen（订阅里常见 0.0.0.0:1053，等于把 DNS 开到局域网）；
 *   - 强制 enable: true / ipv6: false（关掉 AAAA 解析，配合 ipv6: false 减少泄漏面）；
 *   - 其余键（nameserver / nameserver-policy / fallback 等）原样保留，不动机场的解析策略。
 *   - 强制项沿用原文子项缩进，避免出现块内缩进深浅不一的非法 YAML。
 *
 * @param {string[]} block dns 块的全部原始行（含首行）
 * @returns {string[]}
 */
function rebuildDnsBlock(block) {
  const indent = detectChildIndent(block);
  const rest = block.slice(1).filter((line) => {
    if (/^\s*listen\s*:/.test(line)) return false;
    if (/^\s*enable\s*:/.test(line)) return false;
    if (/^\s*ipv6\s*:/.test(line)) return false;
    return true;
  });

  return [block[0], `${indent}enable: true`, `${indent}ipv6: false`, ...rest];
}

/**
 * 把订阅原文净化为内置内核可安全运行的配置，并返回本次净化的处理报告。
 *
 * @param {string} rawText 订阅原文（Clash / mihomo 格式）
 * @param {{mixedPort:number, controllerPort:number, secret:string}} opts
 * @returns {{
 *   text: string,
 *   filtered: Array<{name:string, reason:string, server:string}>,
 *   groupRefs: Array<{name:string, group:string}>,
 *   filterStats: {scanned:number, kept:number, filtered:number, whitelisted:number, emptyGroups:string[]},
 *   warnings: string[],
 *   droppedTopKeys: string[],
 *   dnsHardened: boolean,
 * }}
 */
function sanitizeDetailed(rawText, opts) {
  // 第一步：剔除广告 / 推广 / 失效节点，并清理策略组里对它们的引用
  const filter = filterAdProxies(rawText);
  const lines = filter.text.split(/\r?\n/);
  const total = lines.length;

  const out = [];
  const droppedTopKeys = [];
  let anchored = false;
  let dnsHardened = false;

  const isTopKey = (line) => /^([A-Za-z0-9_-]+)\s*:/.exec(line);

  let index = 0;
  while (index < total) {
    const line = lines[index];
    const topMatch = isTopKey(line);

    if (!topMatch) {
      // 块外的缩进行（顶层注释等）：原样保留
      out.push(line);
      index += 1;
      continue;
    }

    // 切出该顶层键的完整块（首行 + 其下所有缩进行）
    let end = index + 1;
    while (end < total && !isTopKey(lines[end])) end += 1;
    const block = lines.slice(index, end);
    const key = topMatch[1];

    if (key === 'dns') {
      out.push(...rebuildDnsBlock(block));
      dnsHardened = true;
      index = end;
      continue;
    }

    // 敏感顶层键：整块丢弃，稍后由覆盖块统一提供
    if (OVERRIDDEN_TOP_KEYS.has(key)) {
      droppedTopKeys.push(key);
      index = end;
      continue;
    }

    if (!anchored && key === ANCHOR_KEY) {
      out.push(...buildOverrideBlock(opts));
      anchored = true;
    }

    out.push(...block);
    index = end;
  }

  if (!anchored) out.push('', ...buildOverrideBlock(opts));

  return {
    text: out.join('\n'),
    filtered: filter.filtered,
    groupRefs: filter.groupRefs,
    filterStats: {
      scanned: filter.scannedCount,
      kept: filter.keptCount,
      filtered: filter.filtered.length,
      whitelisted: filter.whitelistedCount,
      emptyGroups: filter.emptyGroups,
    },
    warnings: filter.warnings,
    droppedTopKeys,
    dnsHardened,
  };
}

/**
 * 把订阅原文净化为内置内核可安全运行的配置（只取净化后的文本）。
 * @param {string} rawText
 * @param {{mixedPort:number, controllerPort:number, secret:string}} opts
 * @returns {string}
 */
function sanitize(rawText, opts) {
  return sanitizeDetailed(rawText, opts).text;
}

/**
 * 用调用方提供的 fetch 实现拉取订阅（Electron net.fetch 语义：自带跳转跟随）。
 *
 * @param {Function} fetcher (url, {timeoutMs}) => Promise<Response>
 * @param {string} url
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<string>}
 */
async function fetchViaFetcher(fetcher, url, { timeoutMs = 20000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error('订阅地址不是合法 URL');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('订阅地址必须是 http/https');

  let res;
  try {
    res = await fetcher(url, { timeoutMs });
  } catch (err) {
    throw new Error(`订阅拉取失败：${err.message}`);
  }

  if (!res) throw new Error('订阅拉取失败：未取得响应');

  const status = res.status || 0;
  if (status !== 200) throw new Error(`订阅返回 HTTP ${status}`);

  return res.text();
}

/**
 * 拉取订阅文本（直连，跟随 3xx 跳转）。
 *
 * 传了 fetcher 就用调用方的实现（Electron 主进程注入基于 net.fetch 的版本，走
 * Chromium 网络栈与系统证书库）；否则退回下面的 Node http/https 实现。
 *
 * 之所以要可注入：本机若装了带 HTTPS 扫描的安全软件（如卡巴斯基），链上会多出
 * 一张该软件签发的中间证书，Node 自带 CA 列表不认它，直连订阅会报
 * "self-signed certificate in certificate chain"；而 Chromium 认系统证书库。
 *
 * @param {string} url
 * @param {{timeoutMs?:number, redirects?:number, fetcher?:Function}} [opts]
 * @returns {Promise<string>}
 */
function fetchSubscription(url, { timeoutMs = 20000, redirects = 4, fetcher = null } = {}) {
  if (typeof fetcher === 'function') {
    return fetchViaFetcher(fetcher, url, { timeoutMs });
  }

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error('订阅地址不是合法 URL'));
      return;
    }

    if (!/^https?:$/.test(target.protocol)) {
      reject(new Error('订阅地址必须是 http/https'));
      return;
    }

    const mod = target.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'http:' ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          // 机场常按 UA 下发不同格式，固定成 Clash 系 UA 以拿到 mihomo 配置
          'User-Agent': 'ClashMetaForNyx/0.1',
          Accept: '*/*',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirects <= 0) {
            reject(new Error('订阅跳转次数过多'));
            return;
          }
          resolve(fetchSubscription(new URL(location, url).href, { timeoutMs, redirects: redirects - 1 }));
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`订阅返回 HTTP ${status}`));
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new Error('订阅请求超时')));
    req.on('error', (err) => reject(new Error(`订阅拉取失败：${err.message}`)));
    req.end();
  });
}

/**
 * 粗略统计净化后配置里的节点数（仅用于界面展示，权威数据以内核 /proxies 为准）。
 * @param {string} sanitizedText
 * @returns {number}
 */
function countProxies(sanitizedText) {
  const lines = String(sanitizedText).split(/\r?\n/);
  let inBlock = false;
  let count = 0;
  for (const line of lines) {
    if (/^proxies\s*:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && /^[A-Za-z0-9_-]+\s*:/.test(line)) break;
    if (inBlock && /^\s*-\s/.test(line)) count += 1;
    else if (inBlock && /^\s*-\s*\{/.test(line)) count += 1;
  }
  return count;
}

module.exports = {
  OVERRIDDEN_TOP_KEYS,
  buildOverrideBlock,
  detectChildIndent,
  rebuildDnsBlock,
  sanitize,
  sanitizeDetailed,
  fetchViaFetcher,
  fetchSubscription,
  countProxies,
};
