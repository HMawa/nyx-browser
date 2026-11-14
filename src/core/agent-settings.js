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

/**
 * 场景预设：一次改一组，免得 agent 挨个调五次还把中间态留给用户。
 *
 * 三条硬规则（不是建议）：
 *   1. 预设里**绝不允许出现锁死键**——隐私与安全的开关不在可改范围内，
 *      预设是个"一把改很多"的入口，更不能绕过这条。
 *   2. 值必须是 SETTING_SCHEMA 里合法的值，加载时就校验一次（见 assertPresets）。
 *   3. 落到每个键上仍然**逐项确认**：需要确认的键必须出现在 accepts 里，
 *      少一个就整体不动，并在 missingConfirm 里点名缺哪一个。
 */
const SETTING_PRESETS = {
  quiet: {
    label: '安静（少读少写）',
    summary: '不读页面、不存快照，标签闲置 15 分钟就休眠',
    settings: { digestEnabled: false, offlineCacheEnabled: false, tabSleepMinutes: 15 },
  },
  work: {
    label: '工作（留文字）',
    summary: '允许生成摘要、保留离线缓存，标签闲置 1 小时才休眠',
    settings: { digestEnabled: true, offlineCacheEnabled: true, tabSleepMinutes: 60 },
  },
  tidy: {
    label: '整洁（只留顶栏骨架）',
    summary: '隐藏链路徽标与模式开关，摘要与缓存保持不动',
    settings: { showLinkBadge: false, showModeSwitch: false },
  },
};
const PRESET_KEYS = Object.keys(SETTING_PRESETS);

/** 加载时就把畸形的预设挡下来：写错一个键名不该等到用户点下去才暴露 */
function assertPresets() {
  const problems = [];
  for (const presetKey of PRESET_KEYS) {
    const preset = SETTING_PRESETS[presetKey];
    if (!preset || typeof preset.settings !== 'object' || preset.settings === null) {
      problems.push(`${presetKey} 没有 settings`);
      continue;
    }
    for (const [key, value] of Object.entries(preset.settings)) {
      if (SETTING_LOCKED[key]) problems.push(`${presetKey} 里出现了锁死键 ${key}`);
      const checked = validateSettingValue(key, value);
      if (!checked.ok) problems.push(`${presetKey}.${key}：${checked.error}`);
    }
  }
  if (problems.length) throw new Error(`场景预设写错：${problems.join('；')}`);
  return true;
}

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
    presets: PRESET_KEYS.map((presetKey) => {
      const preset = SETTING_PRESETS[presetKey];
      return {
        preset: presetKey,
        label: preset.label,
        summary: preset.summary,
        settings: Object.keys(preset.settings).map((key) => ({
          key,
          label: SETTING_SCHEMA[key].label,
          value: preset.settings[key],
          summary: SETTING_SCHEMA[key].describe(preset.settings[key]),
          needsConfirm: SETTING_SCHEMA[key].needsConfirm === true,
        })),
      };
    }),
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

/**
 * 规划一次"场景预设"批量修改（不落盘）。
 *
 * 与 planSettingChange 的差别只有两点：一次改多项、要确认的键必须逐项点名确认。
 * 其余判定完全复用同一套规则——预设不是后门，只是把多次调用合成一次。
 *
 * @param {{preset?: string, accepts?: string[]}} request
 * @param {{currents?: object, current?: any, history?: number[], now?: number}} context
 */
function planPresetChange(request, context) {
  const input = request && typeof request === 'object' ? request : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const presetKey = typeof input.preset === 'string' ? input.preset.trim() : '';

  if (!presetKey) {
    return {
      ok: false,
      code: 'MISSING_PRESET',
      error: `要套哪个预设？（可选：${PRESET_KEYS.join(' / ')}）`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }
  const preset = SETTING_PRESETS[presetKey];
  if (!preset) {
    return {
      ok: false,
      code: 'UNKNOWN_PRESET',
      error: `没有这个预设：${presetKey}（可选：${PRESET_KEYS.join(' / ')}）`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

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

  const currents = ctx.currents && typeof ctx.currents === 'object' ? ctx.currents : {};
  const accepts = Array.isArray(input.accepts) ? input.accepts.map((key) => String(key)) : [];
  const changes = [];
  const unchanged = [];
  const missingConfirm = [];
  const entries = Object.entries(preset.settings);

  for (const [key, value] of entries) {
    const checked = validateSettingValue(key, value);
    if (!checked.ok) return { ...checked, disclaimer: SETTING_DISCLAIMER };
    const rule = SETTING_SCHEMA[key];
    const hasCurrent = Object.prototype.hasOwnProperty.call(currents, key)
      || (Object.prototype.hasOwnProperty.call(ctx, 'current') && entries.length === 1);
    const from = hasCurrent
      ? (Object.prototype.hasOwnProperty.call(currents, key) ? currents[key] : ctx.current)
      : undefined;
    if (hasCurrent && from === checked.value) {
      unchanged.push({ key, label: rule.label, value: checked.value });
      continue;
    }
    if (rule.needsConfirm === true && !accepts.includes(key)) {
      missingConfirm.push({ key, label: rule.label, summary: rule.describe(checked.value) });
      continue;
    }
    changes.push({
      key,
      value: checked.value,
      label: rule.label,
      summary: rule.describe(checked.value),
      from,
    });
  }

  if (missingConfirm.length) {
    return {
      ok: false,
      code: 'NEED_CONFIRM',
      preset: presetKey,
      missingConfirm,
      error: `这些项要你逐项确认后才改：${missingConfirm.map((item) => item.label).join('、')}。`
        + '把确认过的键放进 accepts 再来一次（其余项不会动）。',
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  if (!changes.length) {
    return {
      ok: true,
      code: 'NO_CHANGE',
      preset: presetKey,
      changes: [],
      unchanged,
      summary: `「${preset.label}」涉及的东西本来就是这样，什么都没改。`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  return {
    ok: true,
    preset: presetKey,
    label: preset.label,
    changes,
    unchanged,
    confirmRequired: changes.length > 0,
    summary: `按「${preset.label}」改 ${changes.length} 项：${changes.map((item) => item.summary).join('；')}`,
    message: `已按「${preset.label}」改 ${changes.length} 项。`,
    disclaimer: SETTING_DISCLAIMER,
  };
}

/** 一次最多能连着撤几步：给个上限，免得一次调用把 20 条历史整个翻回去 */
const MAX_UNDO_STEPS = 5;
/**
 * 撤销由 agent 做成的修改（支持一次撤多步）。
 *
 * 为什么认"记录里的旧值"而不是让 agent 再改一次回去：改回去走的是同一条路，
 * 但只要中间有人手动动过，就会把人的选择覆盖掉。这里只回滚记录里记下的旧值。
 *
 * 多步撤销的两条约束：
 *   1. **整体成功或整体不动**：要撤的几条里只要有一条锁死/非法，就一条都不改，
 *      免得撤一半留下一个既不是改前也不是改后的状态。
 *   2. **只回退、不重做**：撤销会把记录一起拿走，所以连着撤会一路回到最早一条；
 *      想再改回去就让 agent 重新设一次（那样每次都得过确认与留痕）。
 *
 * @param {Array<{key:string,value:*,previous:*,at?:number}>} entries 成功的修改记录（越旧越前）
 * @param {{currents?:Object, current?:*, steps?:number}} [context]
 *        currents 是"每个键现在是什么值"的映射；current 只用于单键场景（兼容旧调用）
 */
function planSettingUndo(entries, context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const list = Array.isArray(entries) ? entries.filter((item) => item && typeof item.key === 'string') : [];
  if (!list.length) {
    return {
      ok: false,
      code: 'NOTHING_TO_UNDO',
      error: '还没有哪个 agent 改过设置，没有可撤销的。',
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  const currents = ctx.currents && typeof ctx.currents === 'object' ? ctx.currents : null;
  const rawSteps = Number(ctx.steps);
  const steps = Number.isFinite(rawSteps) && rawSteps >= 1 ? Math.min(Math.floor(rawSteps), MAX_UNDO_STEPS) : 1;

  // 从最新一条往前取，最多 steps 条（栈顶先撤）
  const picked = list.slice(Math.max(0, list.length - steps)).reverse();

  // 先整体校验，任何一条不合格就一条都不动
  for (const entry of picked) {
    if (SETTING_LOCKED[entry.key]) {
      return {
        ok: false,
        code: 'LOCKED_KEY',
        key: entry.key,
        error: `${entry.key} 现在不能由 agent 改：${SETTING_LOCKED[entry.key]}`,
        locked: true,
        disclaimer: SETTING_DISCLAIMER,
      };
    }
    if (!SETTING_SCHEMA[entry.key]) {
      return {
        ok: false,
        code: 'UNKNOWN_KEY',
        key: entry.key,
        error: `记录里的 ${entry.key} 已经不在可改范围里了，撤销不了。`,
        disclaimer: SETTING_DISCLAIMER,
      };
    }
    const checked = validateSettingValue(entry.key, entry.previous);
    if (!checked.ok) {
      return {
        ok: false,
        code: 'BAD_VALUE',
        key: entry.key,
        error: `记录里这一项的旧值不合法，撤销不了：${checked.error}`,
        disclaimer: SETTING_DISCLAIMER,
      };
    }
  }

  const changes = [];
  const unchanged = [];
  for (const entry of picked) {
    const rule = SETTING_SCHEMA[entry.key];
    const checked = validateSettingValue(entry.key, entry.previous);
    const known = currents
      ? Object.prototype.hasOwnProperty.call(currents, entry.key)
      : Object.prototype.hasOwnProperty.call(ctx, 'current');
    const nowValue = currents ? currents[entry.key] : ctx.current;
    if (known && nowValue === checked.value) {
      // 已经是原样了：不必再写一次，但也有可能同键还有更早的一步要撤
      unchanged.push({ key: entry.key, value: checked.value, label: rule.label });
      continue;
    }
    changes.push({
      key: entry.key,
      value: checked.value,
      from: known ? nowValue : undefined,
      label: rule.label,
      summary: rule.describe(checked.value),
      at: entry.at,
    });
  }

  if (!changes.length) {
    const only = picked[0];
    const rule = SETTING_SCHEMA[only.key];
    return {
      ok: true,
      code: 'NO_CHANGE',
      key: only.key,
      value: validateSettingValue(only.key, only.previous).value,
      changes: [],
      consumed: picked.length,
      unchanged: unchanged.length,
      message: `${rule.label} 已经回到上一次改之前的样子了，不需要再撤销。`,
      summary: `${rule.describe(validateSettingValue(only.key, only.previous).value)}（无变化）`,
      disclaimer: SETTING_DISCLAIMER,
    };
  }

  const first = changes[0];
  const extra = changes.length > 1 ? `，另外还撤了 ${changes.length - 1} 项` : '';
  return {
    ok: true,
    key: first.key,
    value: first.value,
    undo: true,
    steps: changes.length,
    changes,
    consumed: picked.length,
    unchanged: unchanged.length,
    summary: changes.map((item) => item.summary).join('；'),
    message:
      changes.length === 1
        ? `已撤销：${first.label} 回到「${first.summary}」。`
        : `已撤销 ${changes.length} 项：${first.label} 回到「${first.summary}」${extra}。`,
    disclaimer: SETTING_DISCLAIMER,
  };
}

assertPresets();

/**
 * 按键聚合 agent 改设置的记录（用户第七轮 C）。
 *
 * 输入是审计记录的原始数组（`runtime.agentAudit.list()` 那一份）。这里只认：
 * - `type === 'settings'`（别的动作不参与）
 * - `decision !== 'deny'`（被拒的没改成，不能算进"改过几次"）
 * - `ok !== false`（执行失败的没落盘）
 * - `params.key` 是认识的键
 *
 * 坏记录直接跳过、不抛错：审计面宁可少一行，也不能因为一条脏数据整块渲染不出来。
 */
function aggregateSettingChanges(records, options) {
  const source = Array.isArray(records) ? records : [];
  const limit = Number.isFinite(options && options.limit) ? Math.max(1, Math.round(options.limit)) : 20;
  const flags = (options && options.includeUndo === true) ? true : false;
  // 时间窗（第八轮 ④）：只统计 since 之后、until 之前的记录。
  // 用「时间戳」而不是「天数」当下限，是为了让「最近 24 小时」这种说法只在界面层出现一次。
  const since = Number.isFinite(options && options.since) && options.since > 0 ? Number(options.since) : 0;
  const until = Number.isFinite(options && options.until) && options.until > 0 ? Number(options.until) : 0;
  const map = new Map();
  let considered = 0;
  let outOfRange = 0;
  for (const raw of source) {
    const entry = raw && typeof raw === 'object' ? raw : null;
    if (!entry) continue;
    if (entry.type !== 'settings') continue;
    if (entry.decision === 'deny') continue;
    if (entry.ok === false) continue;
    const params = entry.params && typeof entry.params === 'object' ? entry.params : {};
    // 撤销是"改回去"，默认不混进改动次数里，否则一次改动 + 一次撤销会显示成改过两次
    if (entry.undo === true || params.undo === true) {
      if (!flags) continue;
    }
    let key = typeof params.key === 'string' ? params.key : '';
    if (!key && typeof entry.target === 'string') key = entry.target;
    if (!key) continue;
    const known = SETTING_SCHEMA[key];
    if (!known) continue;
    const ts = Number.isFinite(entry.ts) ? entry.ts : 0;
    // 没有时间的记录：既算不进窗口内，也不能被静默丢掉——这里让它照样计入总数，
    // 只是不算进 keys 的聚合里由 outOfRange 计数交代清楚。
    if (since || until) {
      if (!ts) {
        outOfRange += 1;
        continue;
      }
      if (since && ts < since) {
        outOfRange += 1;
        continue;
      }
      if (until && ts > until) {
        outOfRange += 1;
        continue;
      }
    }
    considered += 1;
    const agent = typeof entry.agent === 'string' && entry.agent ? entry.agent : 'local';
    const current = map.get(key);
    const value = Object.prototype.hasOwnProperty.call(params, 'value') ? params.value : undefined;
    if (!current) {
      map.set(key, {
        key,
        label: known.label,
        count: 1,
        lastAt: ts,
        lastTime: ts ? new Date(ts).toISOString() : '',
        lastAgent: agent,
        lastValue: value,
        agents: [agent],
      });
      continue;
    }
    current.count += 1;
    if (ts >= current.lastAt) {
      current.lastAt = ts;
      current.lastTime = ts ? new Date(ts).toISOString() : '';
      current.lastAgent = agent;
      current.lastValue = value;
    }
    if (!current.agents.includes(agent)) current.agents.push(agent);
  }
  const keys = Array.from(map.values())
    .sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt))
    .slice(0, limit);
  return {
    ok: true,
    total: considered,
    outOfRange,
    keys,
    empty: considered === 0,
    note: considered === 0
      ? (outOfRange > 0
        ? `所选的这段时间里没有 agent 改过设置，但另外还有 ${outOfRange} 次在时间之外——把范围放宽就能看到。`
        : '还没有 agent 改过设置。它们改的时候会先问你要确认，改完这里会按设置项记一次。')
      : `最近 ${considered} 次改动，涉及 ${keys.length} 个设置项${outOfRange > 0 ? `；另有 ${outOfRange} 次在所选时间之外` : ''}。`,
  };
}

/**
 * 把聚合结果转成 CSV（第八轮 ④）。
 *
 * 只导聚合后的行（每个设置项一行），不导原始记录：原始记录里有 url、参数这类东西，
 * 导出来是一条条流水账，看不出"谁改得多"这个问题的答案。
 */
function buildSettingAuditCsv(rows, options) {
  const list = Array.isArray(rows) ? rows : [];
  const now = options && Number.isFinite(options.now) ? new Date(options.now) : new Date();
  const lines = [['设置项', '改过次数', '最近一次', '改成', '谁改的'].join(',')];
  for (const row of list) {
    const item = row && typeof row === 'object' ? row : {};
    const at = Number.isFinite(item.lastAt) && item.lastAt > 0 ? new Date(item.lastAt) : null;
    lines.push([
      csvCell(item.label || item.key || ''),
      csvCell(Number.isFinite(item.count) ? item.count : ''),
      csvCell(at ? at.toISOString() : ''),
      csvCell(describeSettingValue(item.lastValue)),
      csvCell(Array.isArray(item.agents) ? item.agents.join(' / ') : (item.lastAgent || '')),
    ].join(','));
  }
  if (list.length === 0) {
    lines.push(['说明', '0', now.toISOString(), '这段时间里没有 agent 改过设置', ''].join(','));
  }
  // 行尾用 CRLF：旧版 Excel 不认只有 LF 的 CSV，会把整份内容塞进一个单元格
  return `${lines.join('\r\n')}\r\n`;
}

/** 把设置值写成人能读的字（导出 CSV 与界面共用一套说法） */
function describeSettingValue(value) {
  if (value === true) return '开';
  if (value === false) return '关';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** RFC 4180：含逗号、引号、换行的字段整体加双引号，内部引号双写 */
function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

module.exports = {
  MAX_UNDO_STEPS,
  PRESET_KEYS,
  SETTING_DISCLAIMER,
  SETTING_KEYS,
  SETTING_LOCKED,
  SETTING_PRESETS,
  SETTING_RATE_LIMIT,
  SETTING_RATE_WINDOW_MS,
  SETTING_SCHEMA,
  aggregateSettingChanges,
  buildSettingAuditCsv,
  describeSettingValue,
  describeSettingsSchema,
  planPresetChange,
  planSettingChange,
  planSettingUndo,
  validateSettingValue,
};
