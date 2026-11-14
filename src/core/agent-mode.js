'use strict';

/**
 * agent 接入模式（清单 A）：内置 MCP / 外部接入。
 *
 * 为什么必须是个"选择开关"而不是只做一种：
 *  - 内置模式：MCP server 跑在本进程里，agent 的每一步都经过统一动作通道
 *    （agent-dispatch），所以留痕是**完整**的，权限判定、急停、动作级确认全都生效。
 *  - 外部接入：外部程序通过 CDP（DevTools 协议）直接驱动浏览器，它看得见渲染进程，
 *    但**看不见我们自己的通道**——我们只能尽力记录"经过浏览器的部分"，
 *    审计从设计上就是不完整的。这件事必须在界面上长期说出来，不能只在切换时说一次。
 *
 * 另一条硬约束：CDP 端口只能在启动时打开（Chromium 的 remote debugging 没有运行时开关），
 * 所以切换模式**必须重启**，界面要如实说，不能假装立刻生效。
 *
 * 这个模块是纯逻辑，不 require electron，方便在纯 Node 里直接断言。
 */

const AGENT_MODES = {
  builtin: {
    value: 'builtin',
    label: '内置（推荐）',
    summary: 'agent 通过 Nyx 自己的 MCP 接口操作页面，每个动作都经过统一通道。',
    auditComplete: true,
    needsRestart: false,
  },
  external: {
    value: 'external',
    label: '外部接入（CDP）',
    summary: '外部程序用 DevTools 协议直接驱动浏览器，看起来更灵活，但 Nyx 只看得见"经过浏览器"的部分。',
    auditComplete: false,
    needsRestart: true,
  },
};

const DEFAULT_AGENT_MODE = 'builtin';

/** 外部接入要额外承担的风险，切换确认时必须逐条摆在用户眼前 */
const EXTERNAL_MODE_RISKS = [
  '外部程序能直接读写页面、执行脚本，Nyx 的站点授权与动作级确认**管不到**它的内部调用。',
  '审计记录只能覆盖"经过浏览器"的部分（导航、下载等），CDP 自己的调用可能一条都留不下。',
  'CDP 端口一旦打开，本机上任何能连到回环的程序都可以尝试连接；端口与 token 请当作密码看待。',
  '切换会重启应用：当前所有标签、登录状态之外的内存状态都会丢。',
];

/** 两次确认的文案（清单 E/A 都要求"不可关闭的强提醒"，不允许出现"不再提示"） */
const AGENT_MODE_CONFIRM_STEPS = [
  {
    stage: 1,
    title: '确认要切换 agent 接入模式？',
    detail: '切换后需要重启 Nyx 才会生效。内置模式下每个动作都走统一通道、留痕完整；外部接入模式下 Nyx 只能尽力而为。',
  },
  {
    stage: 2,
    title: '再确认一次：外部接入会让审计变得不完整',
    detail: '这不是可以关掉的提示。确认后界面上会常驻「审计不完整」标识，直到你切回内置模式。',
    requiresAck: true,
  },
];

const AGENT_MODE_SWITCH_STEPS = AGENT_MODE_CONFIRM_STEPS.length;

const AGENT_DEBUG_PORT_FILE = 'agent-debug-port.txt';

function normalizeAgentMode(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(AGENT_MODES, key) ? key : DEFAULT_AGENT_MODE;
}

/**
 * 从落盘内容里取模式。
 * @param {any} raw 解析后的 JSON（可能是 null / 脏数据）
 */
function readAgentModeFromPrefs(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_AGENT_MODE;
  if (raw.mode !== undefined) return normalizeAgentMode(raw.mode);
  if (raw.agentMode !== undefined) return normalizeAgentMode(raw.agentMode);
  return DEFAULT_AGENT_MODE;
}

function describeAgentMode(mode) {
  return AGENT_MODES[normalizeAgentMode(mode)];
}

/**
 * 切换前的判定：要不要重启、要不要两次确认、缺哪一步。
 * @param {object} input {current, target, stage, ackRisk}
 * @returns {{ok:boolean, code?:string, error?:string, target:string, current:string, step?:object, needsRestart?:boolean, applied?:boolean}}
 */
function planAgentModeSwitch(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const current = normalizeAgentMode(input.current);
  const target = normalizeAgentMode(input.target);

  if (target === current) {
    return {
      ok: false,
      code: 'ALREADY_THERE',
      error: `现在已经是「${AGENT_MODES[current].label}」模式了。`,
      current,
      target,
    };
  }

  const stage = Number(input.stage) || 0;
  if (stage < AGENT_MODE_SWITCH_STEPS) {
    const step = AGENT_MODE_CONFIRM_STEPS[stage];
    return {
      ok: false,
      code: 'NEED_CONFIRM',
      error: '切换 agent 接入模式需要两次确认。',
      current,
      target,
      step,
      stepsLeft: AGENT_MODE_SWITCH_STEPS - stage,
    };
  }

  if (AGENT_MODE_CONFIRM_STEPS[stage - 1].requiresAck && input.ackRisk !== true) {
    return {
      ok: false,
      code: 'NEED_ACK',
      error: '需要先勾选风险确认：外部接入会让审计不完整。',
      current,
      target,
      step: AGENT_MODE_CONFIRM_STEPS[stage - 1],
    };
  }

  return {
    ok: true,
    current,
    target,
    needsRestart: AGENT_MODES[target].needsRestart || AGENT_MODES[current].needsRestart,
    applied: false,
    risks: target === 'external' ? EXTERNAL_MODE_RISKS.slice() : [],
    message:
      target === 'external'
        ? '已记下：下次启动会用外部接入模式。重启后界面会常驻「审计不完整」标识。'
        : '已记下：下次启动回到内置模式，审计会恢复完整留痕。',
  };
}

/**
 * 给界面用的状态：当前模式、审计是否完整、外部模式的端点提示。
 * @param {object} input {mode, bootMode, debugPort, needsRestart}
 */
function agentModePayload(rawInput) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const mode = normalizeAgentMode(input.mode);
  const bootMode = normalizeAgentMode(input.bootMode === undefined ? mode : input.bootMode);
  const info = AGENT_MODES[mode];
  const bootInfo = AGENT_MODES[bootMode];
  const debugPort = input.debugPort ? String(input.debugPort) : '';
  return {
    ok: true,
    mode,
    label: info.label,
    summary: info.summary,
    auditComplete: info.auditComplete,
    // 落盘值可能与"本次启动实际生效"的不一致（刚改完还没重启）
    bootMode,
    bootLabel: bootInfo.label,
    restartRequired: mode !== bootMode,
    needsRestartOnSwitch: Object.values(AGENT_MODES).some((m) => m.needsRestart),
    debugPort,
    externalEndpoint: debugPort ? `http://127.0.0.1:${debugPort}/json` : '',
    modes: Object.values(AGENT_MODES).map((m) => ({ ...m })),
    risks: mode === 'external' ? EXTERNAL_MODE_RISKS.slice() : [],
    steps: AGENT_MODE_CONFIRM_STEPS.map((s) => ({ ...s })),
    // 外部模式下这条标识要常驻，不是一次性提示
    banner: info.auditComplete ? '' : '外部接入模式：审计不完整（只看得到经过浏览器的部分）',
  };
}

module.exports = {
  AGENT_MODES,
  AGENT_MODE_CONFIRM_STEPS,
  AGENT_MODE_SWITCH_STEPS,
  AGENT_DEBUG_PORT_FILE,
  DEFAULT_AGENT_MODE,
  EXTERNAL_MODE_RISKS,
  agentModePayload,
  describeAgentMode,
  normalizeAgentMode,
  planAgentModeSwitch,
  readAgentModeFromPrefs,
};
