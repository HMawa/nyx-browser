'use strict';

/**
 * 接入外壳文案唯一真源（VPN 接入外壳改造清单 §3）。
 *
 * 为什么要有这个文件：同一句话以前散落在 settings.html、proxy-center.js、main.js 三处，
 * 换一种叫法要改一地三份，漏一处就出现"半新半旧"的界面。这里把词条收成一份表，
 * 三档身份（校园 / 单位 / 自定义）各自取一套，界面只许从 `termsFor()` 拿字，不许自己写死。
 *
 * 三条不可越的边界：
 *   1. 只改字，不改行为——内核、订阅、端口、分流、已有偏好键一律不动。
 *   2. `custom` 一档逐字等于今天的界面：切回它等于回到旧版外观，老用户不会被悄悄改词。
 *   3. 校园 / 单位两档里不出现"代理"二字（合规要求见清单 §5），词条缺字直接抛错，
 *      绝不静默回退到 `custom` 的字——那样会悄悄露出旧术语。
 *
 * 本模块是纯字符串表，不 require electron / fs / path，故界面侧（preload）也能同步取用。
 */

/** 三档身份：校园网络接入 / 单位网络接入 / 自定义服务端（= 今天的界面） */
const IDENTITIES = ['campus', 'enterprise', 'custom'];

/** 「跟随默认」：新装默认 campus、老用户首次升级默认 custom，由 resolveIdentity 决定 */
const IDENTITY_AUTO = 'auto';

/** 干净机器（没有历史配置）的默认身份 */
const DEFAULT_IDENTITY = 'campus';

/** 有历史配置的机器（升级用户）的默认身份 */
const UPGRADE_IDENTITY = 'custom';

const IDENTITY_LABELS = {
  campus: '校园网络接入',
  enterprise: '单位网络接入',
  custom: '自定义服务端',
};

/** 设置页选择器里的一句话说明：只描述"该怎么填"，不替任何机构背书 */
const IDENTITY_NOTES = {
  campus: '按学校网络中心给的说明填写服务端地址与接入配置；具体以学校通知为准。',
  enterprise: '按单位网络管理员给的说明填写服务端地址与接入配置；具体以单位通知为准。',
  custom: '自己配置服务端与订阅，术语与旧版完全一致。',
};

/** 关于页与设置页都要能看到的定位声明（合规：不暗示官方背书） */
const SHELL_STATEMENT =
  'Nyx 是通用网络代理工具：不内置任何学校或单位的地址、标识与配色，也不代表任何机构认可或授权。';

/** 换身份只影响界面，这句话必须让用户看见，避免以为换了网络实现 */
const IDENTITY_SCOPE_NOTE = '换接入方式只改界面叫法与默认文案，不改网络、内核或已有配置。';

/**
 * custom 一档：逐字等于今天的界面，**改动这里的任何一个字都等于改老用户的界面**。
 * 键的顺序即界面上出现的顺序，便于逐条核对。
 */
const CUSTOM_TERMS = {
  sectionLabel: '网络与代理',
  channelTitle: '内置代理内核',
  channelStateLabel: '当前订阅',
  channelConnect: '启动内置代理',
  channelDisconnect: '停止',
  channelRefetch: '重新拉取配置',
  channelDown: '代理不可达',
  channelForce: '强制走代理',
  serverTitle: '服务端与订阅',
  subscriptionTitle: '订阅',
  subscriptionAdd: '添加订阅',
  subscriptionCurrent: '当前订阅',
  subscriptionHint: '启用的订阅决定节点来源，切换订阅会自动重启内核。',
  subscriptionEmpty: '暂无订阅，请在下方添加。',
  subscriptionNameHint: '备注名（可留空）',
  subscriptionUrlHint: '订阅地址，以 https:// 开头',
  advancedTitle: '高级',
  coreTitle: '内置代理内核',
  nodeTerm: '节点',
  latencyTerm: '测速',
  ruleTerm: '分流规则',
  exitIpTerm: '出口 IP',
  selfHealTerm: '智能巡航',
  localPortTerm: '混合端口',
  directTerm: '直连',
  upstreamTerm: '出站链路',
  onboardTitle: '选择接入方式',
  onboardSkip: '先不定',
};

/** 校园 / 单位两档共用的外壳词：只换词，不新增功能 */
const SHELL_TERMS = {
  sectionLabel: '接入通道',
  channelTitle: '接入通道',
  channelStateLabel: '当前接入配置',
  channelConnect: '连接接入通道',
  channelDisconnect: '断开',
  channelRefetch: '重新获取接入配置',
  channelDown: '通道不可达',
  channelForce: '强制经接入通道',
  serverTitle: '服务端与接入配置',
  subscriptionTitle: '接入配置',
  subscriptionAdd: '添加接入配置',
  subscriptionCurrent: '当前接入配置',
  subscriptionHint: '启用的接入配置决定可用线路来源，切换会自动重启接入组件。',
  subscriptionEmpty: '暂无接入配置，请在下方添加。',
  subscriptionNameHint: '备注名（可留空）',
  subscriptionUrlHint: '接入配置地址，以 https:// 开头',
  advancedTitle: '高级',
  coreTitle: '接入组件',
  nodeTerm: '线路',
  latencyTerm: '线路质量检测',
  ruleTerm: '访问规则',
  exitIpTerm: '出口地址',
  selfHealTerm: '线路自愈',
  localPortTerm: '本地端口',
  directTerm: '直接访问',
  upstreamTerm: '出站链路',
  onboardTitle: '选择接入方式',
  onboardSkip: '先不定',
};

/** 词条键全集：任何一档取字前都先按这份清单校验，缺键直接报错 */
const TERM_KEYS = Object.keys(CUSTOM_TERMS);

/** 校园 / 单位两档不许出现的旧术语（出现即视为漏改，宁可报错也不静默） */
const LEGACY_WORDS = [
  '代理中心',
  '内置代理内核',
  '订阅',
  '节点',
  '测速',
  '分流规则',
  '混合端口',
  '智能巡航',
  '直连',
  '出口 IP',
  '代理',
];

/** custom 档里允许出现「接入」的键：引导页本身就叫「选择接入方式」，属通用说法 */
const SHELL_WORD_ALLOW = ['onboardTitle'];

/**
 * 动态句子的换词表（清单 §3 映射表）：长短优先，一次只跑一遍，避免替换结果被二次改写。
 * 状态条、空态提示、按钮 title 里那些整句文案不适合逐条做成词条，用这张表在**显示层**换成外壳叫法；
 * custom 档一个字都不换（界面与旧版逐项一致）。
 */
const SHELL_REPLACEMENTS = [
  ['内置代理内核', '接入组件'],
  ['启动内置代理', '连接接入通道'],
  ['启动代理', '连接接入通道'],
  ['强制走代理', '强制经接入通道'],
  ['代理不可达', '通道不可达'],
  ['代理中心', '接入通道'],
  ['代理内核', '接入组件'],
  ['智能巡航', '线路自愈'],
  ['智能分流', '访问规则'],
  ['分流规则', '访问规则'],
  ['混合端口', '本地端口'],
  ['出口 IP', '出口地址'],
  ['出口IP', '出口地址'],
  ['策略组', '线路组'],
  ['订阅', '接入配置'],
  ['节点', '线路'],
  ['测速', '线路质量检测'],
  ['直连', '直接访问'],
  ['代理', '接入通道'],
  ['内核', '接入组件'],
];

/** 换词前先看有没有命中：绝大多数文本不含旧术语，直接原样返回，不让 Observer 空转 */
const SHELL_WATCH_WORDS = SHELL_REPLACEMENTS.map(([from]) => from);

function assertIdentity(identity) {
  if (!IDENTITIES.includes(identity)) {
    throw new Error(`接入外壳接入方式不存在：${identity}`);
  }
  return identity;
}

/** 某档身份的完整词表（浅拷贝，调用方改不到真源） */
function termsFor(identity) {
  assertIdentity(identity);
  return identity === 'custom'
    ? Object.assign({}, CUSTOM_TERMS)
    : Object.assign({}, CUSTOM_TERMS, SHELL_TERMS);
}

/**
 * 取一个词条。
 * @param {string} key     词条键（见 TERM_KEYS）
 * @param {string} identity 具体身份；传 auto 属于调用方错误，直接抛
 */
function t(key, identity) {
  const terms = termsFor(identity);
  if (!Object.prototype.hasOwnProperty.call(terms, key)) {
    throw new Error(`接入外壳词条不存在：${key}`);
  }
  const value = terms[key];
  if (!value) throw new Error(`缺少「${identity}」的取值：${key}`);
  return value;
}

/**
 * 决定当前该用哪一档身份。
 *
 * 规则（清单 §2 默认值）：用户显式选过就用选的；没选过（auto）时，
 * 老用户 → custom（升级后界面维持原样），新装 → campus（走引导选）。
 *
 * **判据由调用方给，这里不猜**。审计 F4 定的口径：不能用「当前有几条订阅」判断老用户——
 * 那个数会变（用户后来加一条订阅，界面口径就翻），而迁移判断只能发生一次。
 * 主进程的做法是首次解析时落一个持久化的 `netIdentityResolved`，之后一直用它。
 * 不传 ctx 时按"新装"处理（= campus），异常情况由调用方自己保守决定。
 *
 * @param {string} saved 偏好里存的值（可能是 auto、空或脏数据）
 * @param {{isUpgrade?: boolean}} [ctx]
 */
function resolveIdentity(saved, ctx) {
  if (IDENTITIES.includes(saved)) return saved;
  const isUpgrade = Boolean(ctx && ctx.isUpgrade);
  return isUpgrade ? UPGRADE_IDENTITY : DEFAULT_IDENTITY;
}

/**
 * 把一句今天界面的文案换成外壳叫法（清单 §3 映射表的显示层实现）。
 *
 * 为什么整句换而不是逐条登记词条：状态条、空态提示、按钮 title 是拼出来的句子，
 * 逐条登记会膨胀成几百个键，而且以后新增的句子还会漏。这里用有序替换表兜住所有动态句子；
 * custom 档原样返回（老用户界面一个字不变），没有命中就直接返回（不让 MutationObserver 空转）。
 *
 * @param {string} text 原始文案
 * @param {string} identity 具体身份（auto 属于调用方错误）
 */
function shellize(text, identity) {
  if (typeof text !== 'string' || !text) return text;
  assertIdentity(identity);
  if (identity === 'custom') return text;
  if (!SHELL_WATCH_WORDS.some((word) => text.includes(word))) return text;
  let out = text;
  for (const [from, to] of SHELL_REPLACEMENTS) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/** 选择器要展示的三档：label 中文名、note 一句话说明 */function describeIdentities() {
  return IDENTITIES.map((id) => ({
    id,
    label: IDENTITY_LABELS[id],
    note: IDENTITY_NOTES[id],
  }));
}

/**
 * 自检：三档都必须齐全、非空，且不越边界。
 * 返回问题列表（空数组 = 通过）；不抛错，便于回归脚本一次打印全部问题。
 */
function assertCoverage() {
  const problems = [];
  for (const identity of IDENTITIES) {
    const terms = termsFor(identity);
    for (const key of TERM_KEYS) {
      const value = terms[key];
      if (typeof value !== 'string' || !value.trim()) {
        problems.push(`${identity} 缺少词条 ${key}`);
      }
    }
    for (const key of Object.keys(terms)) {
      if (!TERM_KEYS.includes(key)) problems.push(`${identity} 多出未登记词条 ${key}`);
    }
  }

  // custom 是"今天的界面"，除引导标题外不许冒出「接入」
  for (const key of TERM_KEYS) {
    if (SHELL_WORD_ALLOW.includes(key)) continue;
    if (CUSTOM_TERMS[key].includes('接入')) problems.push(`custom 的 ${key} 混入外壳词：${CUSTOM_TERMS[key]}`);
  }

  // 校园 / 单位两档不许留旧术语，尤其不许出现「代理」
  for (const identity of ['campus', 'enterprise']) {
    const terms = termsFor(identity);
    for (const key of TERM_KEYS) {
      const value = terms[key];
      for (const word of LEGACY_WORDS) {
        if (value.includes(word)) problems.push(`${identity} 的 ${key} 残留旧术语「${word}」：${value}`);
      }
    }
  }

  return problems;
}

module.exports = {
  IDENTITIES,
  IDENTITY_AUTO,
  DEFAULT_IDENTITY,
  UPGRADE_IDENTITY,
  IDENTITY_LABELS,
  IDENTITY_NOTES,
  IDENTITY_SCOPE_NOTE,
  SHELL_STATEMENT,
  TERM_KEYS,
  LEGACY_WORDS,
  SHELL_REPLACEMENTS,
  termsFor,
  t,
  shellize,
  resolveIdentity,
  describeIdentities,
  assertCoverage,
};
