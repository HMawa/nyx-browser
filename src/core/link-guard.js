'use strict';

/**
 * 出站链路守卫（纯逻辑，不碰 Electron）。
 *
 * 背景：用户在实测里报「开着 Clash 刷新几次，全隐私模式自己变回直连」。
 * 全隐私模式的产品语义是"宁可不工作，也不许把真实 IP 送出去"，因此链路的任何
 * 一次变化都不允许是静默的：要么门在事前拦住（进不去），要么在事后明确告知
 * （提示 + 诊断日志 + 模式事件）。
 *
 * 这个模块只回答一个问题：**一次可疑的加载失败，接下来该做什么**。
 * 判定抽成纯函数，回归脚本可以不启动 Electron 直接喂数据（历史上这里出过
 * "打桩 window.nyx 静默失效导致断言假通过"的事）。
 */

/**
 * 视为"链路可能失效"的 Chromium net error 码。
 *   -130 ERR_PROXY_CONNECTION_FAILED / -102 ERR_CONNECTION_REFUSED /
 *   -101 ERR_CONNECTION_RESET      / -104 ERR_CONNECTION_FAILED /
 *   -118 ERR_CONNECTION_TIMED_OUT  / -105 ERR_NAME_NOT_RESOLVED
 */
const PROXY_FAILURE_CODES = new Set([-130, -102, -101, -104, -118, -105]);

/** 判定结果：不动 / 普通模式转直连 / 隐私模式仅告知 */
const ACTIONS = { none: 'none', fallbackDirect: 'fallback-direct', notifyPrivate: 'notify-private', offline: 'offline' };

/** 是否属于"链路可疑"的失败码（只认数字：Chromium 给的就是 number，字符串说明上游传错了） */
function isProxyFailureCode(errorCode) {
  return typeof errorCode === 'number' && PROXY_FAILURE_CODES.has(errorCode);
}

/**
 * 决定一次可疑失败后的动作（纯函数）。
 *
 * @param {{mode?:string, link?:string, reachable?:boolean, errorCode?:number,
 *          host?:string, port?:number, error?:string, url?:string, online?:boolean}} [rawInput]
 *   mode      当前模式：'normal' | 'private'
 *   link      当前分区的链路：'proxy' | 'smart' | 'direct'
 *   reachable 刚刚探测到的代理可达性
 *   online    整机是否有网（`net.isOnline()`）；false 时不改链路
 * @returns {{action:string, notice:object|null, reason:string}}
 *   action='none'            —— 不动链路（不相关 / 代理其实还活着）
 *   action='fallback-direct' —— 普通模式：代理确已不在，转直连并重载
 *   action='notify-private'  —— 隐私模式：代理确已不在，**保持代理**，只告知
 *   action='offline'         —— 整机断网：两种模式都不改链路，只告知"是断网"
 */
function decideProxyFailureAction(rawInput) {
  // 调用方可能只拿到一个残缺的对象（甚至 null）：一律按普通模式的保守假设处理，
  // 绝不因为缺字段就抛异常——这段代码跑在"页面已经挂了"的路径上，再崩一次只会更糟。
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const mode = input.mode === 'private' ? 'private' : 'normal';
  const link = input.link === 'proxy' || input.link === 'smart' ? input.link : 'direct';
  const reachable = input.reachable === true;
  const host = input.host || '127.0.0.1';
  const port = Number(input.port) || 0;
  const error = input.error || '未知原因';
  const where = port ? `${host}:${port}` : host;

  // 不是链路类的失败，或当前分区本来就走直连：动它没有意义
  if (!isProxyFailureCode(input.errorCode)) {
    return { action: ACTIONS.none, notice: null, reason: 'not-proxy-failure' };
  }
  if (link === 'direct') {
    return { action: ACTIONS.none, notice: null, reason: 'link-is-direct' };
  }

  // 整机没网的时候，代理不可达是"必然结果"，不是代理坏了。这时候转直连毫无意义
  // （直连也不通），而且会把链路状态改脏——等网络回来就变成"明明是代理模式却在直连"。
  // 所以先判网络，再判代理。
  if (input.online === false) {
    return {
      action: ACTIONS.offline,
      reason: 'network-offline',
      notice: {
        level: 'warn',
        code: 'NETWORK_OFFLINE',
        title: '当前没有网络，先别改链路',
        message:
          `这一页打不开是因为整机断网了（代理 ${where} 也不可达：${error}），` +
          '不是代理坏了。' +
          (mode === 'private'
            ? '隐私模式保持代理不变，网络恢复后点「重试」即可。'
            : '链路保持原样，网络恢复后会自动重新探测。'),
      },
    };
  }

  // 隐私模式：无论探测结果如何都不许降级。可达 → 属于站点问题；不可达 → 明确告知。
  if (mode === 'private') {
    if (reachable) {
      return { action: ACTIONS.none, notice: null, reason: 'proxy-reachable' };
    }
    return {
      action: ACTIONS.notifyPrivate,
      reason: 'private-proxy-down',
      notice: {
        level: 'error',
        code: 'PRIVACY_PROXY_DOWN',
        title: '代理已断开，隐私模式未降级',
        message:
          `检测到代理 ${where} 不可达（${error}）。隐私模式不会降级为直连，` +
          '所以页面暂时打不开——这是刻意保留的行为，避免真实 IP 泄漏。' +
          '请恢复代理后点「重试」；需要直连请手动切到普通模式。',
      },
    };
  }

  // 普通模式：代理确实不在 → 转直连（并告知），可达 → 站点问题不动链路
  if (reachable) {
    return { action: ACTIONS.none, notice: null, reason: 'proxy-reachable' };
  }
  return {
    action: ACTIONS.fallbackDirect,
    reason: 'normal-proxy-down',
    notice: {
      level: 'warn',
      code: 'PROXY_FALLBACK_DIRECT',
      title: '代理已断开，普通模式已自动直连',
      message:
        `检测到本机代理 ${where} 不可达（${error}），` +
        '普通模式已切换为直连并重新加载页面。隐私模式要求代理可达，不会降级为直连。',
    },
  };
}

module.exports = { ACTIONS, PROXY_FAILURE_CODES, isProxyFailureCode, decideProxyFailureAction };
