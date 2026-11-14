/**
 * 网络在线状态 → 界面提示（纯逻辑，零 Electron 依赖，可直接单测）。
 *
 * 为什么需要它：清单 G 要求「离线/在线切换」。真正的坑不是"没网时页面打不开"
 * （这本来就会打不开），而是没网时**我们会误判成代理坏了**：
 *   - 普通模式下会把链路改成直连，网络恢复后就成了"明明是代理模式却在直连"；
 *   - 隐私模式下会反复提示"代理已断开"，让用户以为代理配置出问题。
 * 所以这一层只做两件事：告诉用户"是断网"，并保证链路不动。
 *
 * 判定原则：只有**明确知道**没网（online === false）才提示；读不到（undefined）
 * 一律当有网，避免把代理故障掩盖成"断网"。
 */

const NET_STATES = { online: 'online', offline: 'offline' };

/** 常驻横幅的层级：断网用 warn（不是错误，用户也无能为力） */
const BANNER_LEVELS = { offline: 'warn' };

/**
 * @param {{online?:boolean, mode?:string, link?:string}} [rawInput]
 *   online  整机是否有网；只有 false 才算断网
 *   mode    'normal' | 'private'
 *   link    'proxy' | 'smart' | 'direct'
 * @returns {{online:boolean, state:string, visible:boolean, level:string, text:string, title:string}}
 */
function describeNetworkState(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const online = input.online !== false;
  const mode = input.mode === 'private' ? 'private' : 'normal';
  const link = input.link === 'proxy' || input.link === 'smart' ? input.link : 'direct';

  if (online) {
    return { online: true, state: NET_STATES.online, visible: false, level: '', text: '', title: '' };
  }

  const linkText = link === 'direct' ? '直连' : '代理';
  if (mode === 'private') {
    return {
      online: false,
      state: NET_STATES.offline,
      visible: true,
      level: BANNER_LEVELS.offline,
      text: '当前离线 · 隐私模式保持代理',
      title:
        '整机没有网络：页面打不开是网络断了，不是代理坏了。' +
        '隐私模式不会因此降级为直连（避免真实 IP 泄漏），网络恢复后点「重试」即可。',
    };
  }
  return {
    online: false,
    state: NET_STATES.offline,
    visible: true,
    level: BANNER_LEVELS.offline,
    text: `当前离线 · ${linkText}链路保持原样`,
    title:
      '整机没有网络：页面打不开是网络断了，不是代理坏了。' +
      '链路不会被改成直连，网络恢复后会自动重新探测代理。',
  };
}

/**
 * 给界面/接口的载荷（外壳横幅、诊断页都用它，保证说法一致）。
 */
function networkStatePayload(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const state = describeNetworkState(input);
  return {
    ok: true,
    ...state,
    mode: input.mode === 'private' ? 'private' : 'normal',
    link: input.link === 'proxy' || input.link === 'smart' ? input.link : 'direct',
    checkedAt: Date.now(),
  };
}

module.exports = { BANNER_LEVELS, NET_STATES, describeNetworkState, networkStatePayload };
