'use strict';

/**
 * 让 agent 改设置（用户第 6 项）。
 *
 * 这一项最容易做错成"给 agent 一把万能钥匙"。所以规则写死在这里，主进程只负责执行：
 *
 * 1. **白名单键**：只有 SETTING_SCHEMA 里列出来的键能被改，其它一律拒绝（含拼写错误）。
 * 2. **锁死的键**：隐私/安全相关的键（出站方式、模式、站点授权、agent 接入模式、私密快照）
 *    不在白名单里，agent 连问都不能改——要改只能人自己在设置里点。这一条是硬边界。
 * 3. **要确认的键**：会影响"看得见的结果"的键（比如关掉离线缓存、关掉摘要），
 *    必须带 confirm:true 才执行，否则返回 NEED_CONFIRM 让人（或调用方）显式确认一次。
 * 4. **限流**：同一分钟内最多 10 次修改，避免 agent 反复刷写把偏好文件写花。
 * 5. **免责文案**：每次改完都带同一段中文，说明"改的是这台机器上 Nyx 的偏好，
 *    改了什么都能在审计里看到，隐私相关的键不在这里"。
 *
 * 纯逻辑、零 Electron：这样断言可以直接跑。
 */

const SETTING_DISCLAIMER =
  '这个接口只改本机上 Nyx 的偏好设置，每次修改都会写进 agent 动作留痕（设置 → Agent 访问 → 动作留痕）。' +
  '隐私与安全相关的键（模式、出站方式、站点授权、接入模式、私密快照）不在可改范围内，只能在设置里由你自己改。';

const SETTING_LOCKED = {
  mode: '浏览器模式（普通/隐私）只能由你手动切换',
  privacyLink: '隐私模式的出站方式直接决定流量去哪，agent 不许改',
  privateSnapshotEnabled: '私密快照开关属于隐私设置，agent 不许改',
  agentMode: 'agent 接入模式改变审计范围，只能由你手动切换',
  agentSites: '站点授权名单决定 agent 能去哪，不许由 agent 自己放宽',
  downloadAsk: '下载确认行为属于安全设置，agent 不许改',
  gpuPolicy: '图形策略要重启才生效，放给 agent 只会造成"改了没反应"',
};

/**
 * 可以改的键：type 决定校验方式，needsConfirm 决定要不要显式确认。
 * defaults 只是给界面/agent 看"现在大概是什么"，真实值以 uiStore 为准。
 */
const SETTING_SCHEMA = {
  theme: {
    type: 'enum',
    values: ['ink', 'aurora', 'paper', 'quiet'],
    label: '界面主题',
    needsConfirm: false,
    describe: (value) => `主题改成「${value}」`,
  },
  tabSleepMinutes: {
    type: 'number',
    min: 0,
    max: 240,
    integer: true,
    label: '标签自动休眠（分钟，0 = 关闭）',
    needsConfirm: false,
    describe: (value) => (Number(value) === 0 ? '关掉标签自动休眠' : `标签闲置 ${value} 分钟后休眠`),
  },
  digestEnabled: {
    type: 'boolean',
    label: '页面摘要读取开关',
    needsConfirm: true,
    describe: (value) => (value === true ? '允许读取页面生成摘要' : '关掉页面摘要（不再读页面）'),
  },
  offlineCacheEnabled: {
    type: 'boolean',
    label: '离线缓存（普通模式）',
    needsConfirm: true,
    describe: (value) => (value === true ? '开启离线缓存并开始保存快照' : '关掉离线缓存并清掉已存快照'),
  },
  cacheSiteMode: {
    type: 'enum',
    values: ['all', 'allowlist'],
    label: '离线缓存的站点范围',
    needsConfirm: true,
    describe: (value) => (value === 'allowlist' ? '只缓存名单里的站点' : '所有站点都缓存'),
  },
  showLinkBadge: {
    type: 'boolean',
    label: '顶栏出站链路徽标',
    needsConfirm: false,
    describe: (value) => (value === true ? '显示出站链路徽标' : '隐藏出站链路徽标'),
  },
  showModeSwitch: {
    type: 'boolean',
    label: '顶栏模式开关',
    needsConfirm: true,
    describe: (value) => (value === true ? '显示模式开关' : '隐藏模式开关'),
  },
};

const SETTING_KEYS = Object.keys(SETTING_SCHEMA);
const SETTING_RATE_LIMIT = 10;
const SETTING_RATE_WINDOW_MS = 60 * 1000;

/** 给 agent 看的"能改什么、要什么条件"（/capabilities 与设置页都用它，避免两套说法） */
function describeSettingsSchema() {
  return {
    ok: true,
    disclaimer: SETTING_DISCLAIMER,
    rateLimit: { max: SETTING_RATE_LIMIT, windowMs: SETTING_RATE_WINDOW_MS },
    keys: SETTING_KEYS.map((key) => {
      const rule = SETTING_SCHEMA[key];
      return {
        key,
        label: rule.label,
        type: rule.type,
        values: rule.values || null,
        min: rule.type === 'number' ? rule.min : null,
        max: rule.type === 'number' ? rule.max : null,
        needsConfirm: rule.needsConfirm === true,
      };
    }),
    locked: Object.keys(SETTING_LOCKED).map((key) => ({ key, why: SETTING_LOCKED[key] })),
  };
}

/** 值校验：类型、枚举、范围，逐条给中文原因（不许只说"不合法"） */
function validateSettingValue(key, value) {
  const rule = SETTING_SCHEMA[key];
  if (!rule) return { ok: false, code: 'UNKNOWN_KEY', error: `这个键不能由 agent 改：${key}` };
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, code: 'BAD_VALUE', error: `${key} 只接受 true / false` };
    return { ok: true, value };
  }
  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) {
      return { ok: false, code: 'BAD_VALUE', error: `${key} 只接受：${rule.values.join(' / ')}（收到 ${String(value)}）` };
    }
    return { ok: true, value };
  }
  if (rule.type === 'number') {
    const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof num !== 'number' || !Number.isFinite(num)) {
      return { ok: false, code: 'BAD_VALUE', error: `${key} 只接受数字` };
    }
    if (rule.integer && !Number.isInteger(num)) {
      return { ok: false, code: 'BAD_VALUE', error: `${key} 只接受整数` };
    }
    if (num < rule.min || num > rule.max) {
      return { ok: false, code: 'BAD_VALUE', error: `${key} 只能取 ${rule.min}–${rule.max}（收到 ${num}）` };
    }
    return { ok: true, value: num };
  }
  return { ok: false, code: 'BAD_VALUE', error: `不认识的取值类型：${rule.type}` };
}

/**
 * 规划一次修改：不落盘，只回答"能不能改、要什么条件、改完是什么样"。
 *
 * @param {{key: string, value: any, confirm: boolean}} request
 * @param {{current?: any, history?: number[], now?: number}} context
 */
function planSettingChange(request, context) {
  const input = request && typeof request === 'object' ? request : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const key = typeof input.key === 'string' ? input.key.trim() : '';

  if (!key) return { ok: false, code: 'MISSING_KEY', error: '要改哪个键？（key 是必填的）', disclaimer: SETTING_DISCLAIMER };

  // 锁死的键：不说"不支持"，要说清为什么，否则调用方会当成 bug 反复重试
  if (SETTING_LOCKED[key]) {
    return {
      ok: false,
      code: 'LOCKED_KEY',
      error: `${key} 不能由 agent 改：${SETTING_LOCKED[key]}`,
      locked: true,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  const checked = validateSettingValue(key, input.value);
  if (!checked.ok) return { ...checked, disclaimer: SETTING_DISCLAIMER };

  const rule = SETTING_SCHEMA[key];
  const history = Array.isArray(ctx.history) ? ctx.history.filter((stamp) => Number.isFinite(stamp)) : [];
  const recent = history.filter((stamp) => now - stamp < SETTING_RATE_WINDOW_MS);
  if (recent.length >= SETTING_RATE_LIMIT) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      error: `一分钟内最多改 ${SETTING_RATE_LIMIT} 次设置，先停一下（这 1 分钟内已改 ${recent.length} 次）`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  const unchanged = Object.prototype.hasOwnProperty.call(ctx, 'current') && ctx.current === checked.value;
  if (unchanged) {
    return {
      ok: true,
      code: 'NO_CHANGE',
      key,
      value: checked.value,
      message: `${rule.label} 本来就是 ${String(checked.value)}，什么都没改。`,
      summary: `${rule.describe(checked.value)}（无变化）`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  if (rule.needsConfirm === true && input.confirm !== true) {
    return {
      ok: false,
      code: 'NEED_CONFIRM',
      key,
      value: checked.value,
      message: `${rule.label} 改动会影响你看到的结果：${rule.describe(checked.value)}。要带 confirm:true 再来一次才会真的改。`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  return {
    ok: true,
    key,
    value: checked.value,
    confirmRequired: rule.needsConfirm === true,
    summary: rule.describe(checked.value),
    message: `已改：${rule.describe(checked.value)}。`,
    disclaimer: SETTING_DISCLAIMER,
  };
}

module.exports = {
  SETTING_DISCLAIMER,
  SETTING_KEYS,
  SETTING_LOCKED,
  SETTING_RATE_LIMIT,
  SETTING_RATE_WINDOW_MS,
  SETTING_SCHEMA,
  describeSettingsSchema,
  planSettingChange,
  validateSettingValue,
};
