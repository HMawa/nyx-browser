'use strict';

/**
 * 统一动作通道（清单 C）。
 *
 * 为什么要有这一层：
 *   agent 的每一个动作都必须从同一个地方经过，否则留痕（D）、授权（E）、急停
 *   这三件事都做不完整——审计会漏掉绕过 dispatch 的动作，急停也拦不住它们。
 *
 * dispatch(action) 固定五段：
 *   ① 权限判定  → ② 需要就挂起等人工确认 → ③ 留痕 → ④ 执行 → ⑤ 回写结果
 *
 * 四种结果，任何一种都要能说清楚原因：
 *   成功 / 失败（ACTION_FAILED，带错误信息）/ 被拒（DENIED_BY_POLICY、CONFIRM_REJECTED ...）
 *   / 被急停中断（SESSION_STOPPED、ABORTED）
 *
 * 本模块是纯逻辑：不 require Electron，不碰窗口与磁盘。真实的确认窗、审计落盘、
 * 授权名单都由调用方注入（E 与 D 分别替换 confirm 与 audit 两个注入点）。
 */

const DISPATCH_TYPES = [
  'navigate',
  'readPage',
  'screenshot',
  'click',
  'type',
  'executeJS',
  'extractText',
  'state',
  'riskLog',
  'settings',
];

/** 不是由 dispatch 发起、但同样必须出现在审计面上的动作（下载由页面/系统触发） */
const OBSERVED_TYPES = ['download'];

const STAGES = {
  authorize: 'authorize',
  confirm: 'confirm',
  execute: 'execute',
  result: 'result',
  observe: 'observe',
};

const DECISIONS = {
  allow: 'allow',
  confirmed: 'confirmed',
  deny: 'deny',
  observed: 'observed',
};

const CODES = {
  MISSING_TYPE: 'MISSING_TYPE',
  DENIED_BY_POLICY: 'DENIED_BY_POLICY',
  CONFIRM_UNAVAILABLE: 'CONFIRM_UNAVAILABLE',
  CONFIRM_REJECTED: 'CONFIRM_REJECTED',
  CONFIRM_TIMEOUT: 'CONFIRM_TIMEOUT',
  SESSION_STOPPED: 'SESSION_STOPPED',
  ABORTED: 'ABORTED',
  ACTION_FAILED: 'ACTION_FAILED',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
};

/**
 * 动作级确认的绝对要求（清单 §3：白名单不豁免）。
 * 这两类动作无论站点是否被信任、无论授权策略怎么配，都必须人工确认一次。
 */
const CONFIRM_RULES = {
  type: {
    required: true,
    why: '输入文字会写进页面表单（可能是账号、密码或支付信息），必须人工确认后才注入',
  },
  download: {
    required: true,
    why: '下载会把文件写到本机磁盘，必须人工确认后才落盘',
  },
  settings: {
    required: true,
    why: '改设置会影响你之后所有的浏览行为（读写落盘、摘要开关等），必须人工确认后才生效',
  },
};

/** 选择器里出现这些词就标为敏感（用于留痕标注，不改变确认策略——输入本来就要确认） */
const SENSITIVE_HINTS = [
  /password/i,
  /passwd/i,
  /pwd/i,
  /passcode/i,
  /\botp\b/i,
  /\bcode\b/i,
  /\bcard\b/i,
  /\bcvc\b/i,
  /\bcvv\b/i,
  /\bsecret\b/i,
  /\btoken\b/i,
  /\bkey\b/i,
];

/** 只保留协议 + 主机 + 路径，丢掉可能带票据的查询串与片段 */
function redactUrl(raw) {
  const text = String(raw || '');
  if (!text) return '';
  try {
    const url = new URL(text);
    const query = url.search ? '?…' : '';
    return `${url.protocol}//${url.host}${url.pathname}${query}`;
  } catch {
    return text.slice(0, 200);
  }
}

/** 输入内容脱敏：只留长度与前 2 后 2 个字符，中间永远不落盘 */
function redactText(raw) {
  const text = typeof raw === 'string' ? raw : String(raw === undefined || raw === null ? '' : raw);
  const head = text.slice(0, 2);
  const tail = text.length > 4 ? text.slice(-2) : '';
  return {
    masked: true,
    length: text.length,
    head,
    tail,
  };
}

function looksLikeSensitive(action) {
  const params = (action && action.params) || {};
  const haystack = [params.selector, params.name, params.label, params.field]
    .filter((part) => typeof part === 'string')
    .join(' ');
  if (!haystack) return false;
  return SENSITIVE_HINTS.some((pattern) => pattern.test(haystack));
}

/** 审计里能出现的参数（其它一律丢弃，避免把整段代码/表单内容写进日志） */
function redactParams(type, params) {
  const source = params && typeof params === 'object' ? params : {};
  switch (type) {
    case 'navigate':
      return { url: redactUrl(source.url) };
    case 'click':
      return {
        elementId: typeof source.elementId === 'string' ? source.elementId.slice(0, 40) : undefined,
        selector: typeof source.selector === 'string' ? source.selector.slice(0, 200) : undefined,
        index: Number.isFinite(source.index) ? source.index : 0,
      };
    case 'type':
      return {
        elementId: typeof source.elementId === 'string' ? source.elementId.slice(0, 40) : undefined,
        selector: typeof source.selector === 'string' ? source.selector.slice(0, 200) : undefined,
        text: redactText(source.text),
        clear: source.clear !== false,
        submit: source.submit === true,
      };
    case 'readPage':
      return {
        maxText: Number.isFinite(source.maxText) ? source.maxText : 0,
        maxElements: Number.isFinite(source.maxElements) ? source.maxElements : 0,
      };
    case 'executeJS':
      return {
        codeLength: typeof source.code === 'string' ? source.code.length : 0,
        codeHead: typeof source.code === 'string' ? source.code.slice(0, 60) : '',
      };
    case 'extractText':
      return {
        selector: typeof source.selector === 'string' ? source.selector.slice(0, 200) : '',
        maxLength: Number.isFinite(source.maxLength) ? source.maxLength : 20000,
      };
    case 'riskLog':
      return {
        limit: Number.isFinite(source.limit) ? source.limit : 100,
        onlyBlocked: source.onlyBlocked === true,
      };
    case 'settings':
      // 只留"改了哪个键、改成什么"——值可能很长，但对审计来说够用
      return {
        key: typeof source.key === 'string' ? source.key.slice(0, 60) : '',
        value: typeof source.value === 'string' || typeof source.value === 'number' || typeof source.value === 'boolean'
          ? source.value
          : undefined,
        confirm: source.confirm === true,
        // 撤销也要在留痕里看得见：否则"设置怎么变回去了"会变成无解的问题
        undo: source.undo === true,
        // 预设同样要看得见：它一次改多项，留痕里只剩一个 key 会让人看不出发生了什么
        preset: typeof source.preset === 'string' ? source.preset.slice(0, 40) : undefined,
        accepts: Array.isArray(source.accepts)
          ? source.accepts.filter((key) => typeof key === 'string').slice(0, 12)
          : undefined,
      };
    case 'download':
      return {
        filename: typeof source.filename === 'string' ? source.filename.slice(0, 120) : '',
        url: redactUrl(source.url),
        bytes: Number.isFinite(source.bytes) ? source.bytes : 0,
        state: typeof source.state === 'string' ? source.state : '',
      };
    default:
      return {};
  }
}

/** 留痕里“目标”一栏：稳定元素 id 优先，其次选择器，最后网址 */
function describeTarget(type, params) {
  const source = params && typeof params === 'object' ? params : {};
  // 改设置的目标是"哪个键"，没有页面元素可指；撤销时键由主进程按记录决定
  if (type === 'settings') {
    if (source.undo === true) return '（撤销上一次）';
    if (typeof source.preset === 'string' && source.preset) return `预设 ${source.preset.slice(0, 40)}`;
    return typeof source.key === 'string' ? source.key.slice(0, 60) : '（未指定键）';
  }
  if (typeof source.elementId === 'string' && source.elementId) return source.elementId.slice(0, 40);
  if (typeof source.selector === 'string' && source.selector) return source.selector.slice(0, 200);
  if (typeof source.url === 'string' && source.url) return redactUrl(source.url);
  return type === 'state' || type === 'screenshot' || type === 'riskLog' ? '（当前标签）' : '';
}

function requiresConfirmation(type) {
  const rule = CONFIRM_RULES[type];
  return Boolean(rule && rule.required);
}

/** 给 /capabilities 用：每个动作是否强制人工确认 */
function describeAction(type) {
  const rule = CONFIRM_RULES[type];
  return {
    type,
    confirmRequired: Boolean(rule && rule.required),
    confirmWhy: rule ? rule.why : '',
  };
}

function normalizeDecision(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const decision = source.decision === 'deny' || source.decision === 'confirm' ? source.decision : 'allow';
  return {
    decision,
    reason: typeof source.reason === 'string' ? source.reason : '',
    rule: typeof source.rule === 'string' ? source.rule : 'default',
  };
}

/**
 * 创建统一通道。
 *
 * @param {object} options
 * @param {{ run: (action: object, ctx?: { signal?: AbortSignal }) => Promise<object> }} options.runner 纯执行器
 * @param {(action: object, ctx: object) => ({decision?: 'allow'|'confirm'|'deny', reason?: string, rule?: string}|Promise<object>)} [options.authorize]
 * @param {(request: object) => Promise<{approved: boolean, remember?: boolean, reason?: string}>} [options.confirm]
 * @param {(entry: object) => void} [options.audit] 审计写入（D 会把这里换成环形缓冲 + jsonl）
 * @param {() => string} [options.mode] 当前 agent 模式（A 会接上 builtin / external）
 * @param {() => string} [options.site] 当前站点（授权与留痕都按站点归类）
 * @param {() => number} [options.now]
 * @param {number} [options.confirmTimeoutMs] 等待人工确认的上限，默认 120 秒
 */
function createDispatcher(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const runner = opts.runner;
  if (!runner || typeof runner.run !== 'function') {
    throw new Error('createDispatcher 需要 runner.run()——动作执行器不能省');
  }

  const audit = typeof opts.audit === 'function' ? opts.audit : null;
  const authorize = typeof opts.authorize === 'function' ? opts.authorize : null;
  const confirmChannel = typeof opts.confirm === 'function' ? opts.confirm : null;
  const modeOf = typeof opts.mode === 'function' ? opts.mode : () => 'builtin';
  const siteOf = typeof opts.site === 'function' ? opts.site : () => '';
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const confirmTimeoutMs =
    Number.isFinite(opts.confirmTimeoutMs) && opts.confirmTimeoutMs > 0 ? opts.confirmTimeoutMs : 120000;

  let seq = 0;
  let stopped = false;
  let stopReason = '';
  let inFlight = 0;
  let auditFailures = 0;
  let controller = new AbortController();
  const pendingConfirms = new Map();

  function writeAudit(entry) {
    if (!audit) return false;
    try {
      // 传副本：同一条记录后面还会被回写结果，审计侧拿到的必须是当时的快照
      audit({ ...entry });
      return true;
    } catch (err) {
      auditFailures += 1;
      // 留痕失败必须吼出来，不能静默——审计漏了就是审计漏了
      console.error('[Nyx] 审计写入失败（这条已丢）：', err && err.message ? err.message : err);
      return false;
    }
  }

  function baseEntry(type, extra) {
    const ts = now();
    return Object.assign(
      {
        id: `act-${++seq}-${ts}`,
        seq,
        ts,
        time: new Date(ts).toISOString(),
        mode: modeOf(),
        site: siteOf(),
        type,
        target: '',
        params: {},
        sensitive: false,
        decision: DECISIONS.allow,
        reason: '',
        rule: '',
        code: '',
        ok: true,
        error: undefined,
        elapsedMs: 0,
        interrupted: false,
      },
      extra || {},
    );
  }

  function refuse(entry, code, error, started) {
    entry.stage = entry.stage || STAGES.authorize;
    entry.decision = DECISIONS.deny;
    entry.code = code;
    entry.ok = false;
    entry.error = error;
    entry.elapsedMs = now() - started;
    writeAudit(entry);
    return {
      ok: false,
      action: entry.type,
      error,
      code,
      decision: entry.decision,
      auditId: entry.id,
      elapsedMs: entry.elapsedMs,
    };
  }

  /** 挂起等人工确认；超时/被急停/通道缺失都按拒绝处理，并给出可读原因 */
  function awaitConfirm(request, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingConfirms.delete(request.id);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        // 短超时（测试或用户配得很短）时不要显示成「0 秒」
        const shown = confirmTimeoutMs < 10000 ? (confirmTimeoutMs / 1000).toFixed(1) : String(Math.round(confirmTimeoutMs / 1000));
        finish({
          approved: false,
          code: CODES.CONFIRM_TIMEOUT,
          reason: `等待人工确认超过 ${shown} 秒，已按拒绝处理`,
        });
      }, confirmTimeoutMs);

      pendingConfirms.set(request.id, { finish });

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            finish({
              approved: false,
              code: CODES.SESSION_STOPPED,
              reason: '等待人工确认期间被紧急停止',
            });
          },
          { once: true },
        );
      }

      Promise.resolve()
        .then(() => confirmChannel(request))
        .then((answer) => {
          if (answer && answer.approved === true) {
            finish({ approved: true, remember: answer.remember === true });
            return;
          }
          finish({
            approved: false,
            code: CODES.CONFIRM_REJECTED,
            reason: (answer && answer.reason) || '用户在确认框里选择了拒绝',
          });
        })
        .catch((err) => {
          finish({
            approved: false,
            code: CODES.CONFIRM_REJECTED,
            reason: `确认通道出错，按拒绝处理：${err && err.message ? err.message : err}`,
          });
        });
    });
  }

  async function dispatch(action) {
    const started = now();
    const type = action && typeof action.type === 'string' ? action.type : '';
    const params = (action && action.params) || {};

    // 类型缺失：连判定都没有意义，直接拒绝并留痕
    if (!type) {
      const entry = baseEntry(null, { stage: STAGES.authorize });
      return refuse(entry, CODES.MISSING_TYPE, '缺少动作类型（type）', started);
    }

    const known = DISPATCH_TYPES.includes(type);
    const entryBase = {
      stage: STAGES.authorize,
      target: describeTarget(type, params),
      params: redactParams(type, params),
      sensitive: looksLikeSensitive(action),
    };

    // ① 已被急停：不再派发任何新动作
    if (stopped) {
      const entry = baseEntry(type, entryBase);
      return refuse(
        entry,
        CODES.SESSION_STOPPED,
        `紧急停止已生效，不再接受新动作${stopReason ? `（${stopReason}）` : ''}`,
        started,
      );
    }

    if (!known) {
      const entry = baseEntry(type, entryBase);
      return refuse(entry, CODES.UNKNOWN_ACTION, `不支持的动作类型：${type}`, started);
    }

    // ② 权限判定（清单 E 的进站确认要在这里等一次人工点按，所以判定允许是异步的）
    let decision = { decision: 'allow', reason: '', rule: 'default' };
    if (authorize) {
      try {
        decision = normalizeDecision(
          // eslint-disable-next-line no-await-in-loop
          await authorize(action, { mode: modeOf(), site: siteOf(), sensitive: entryBase.sensitive, type }),
        );
      } catch (err) {
        decision = {
          decision: 'deny',
          reason: `权限判定出错，按拒绝处理：${err && err.message ? err.message : err}`,
          rule: 'authorize-error',
        };
      }
    }

    if (decision.decision === 'deny') {
      const entry = baseEntry(type, entryBase);
      entry.rule = decision.rule;
      entry.reason = decision.reason;
      return refuse(entry, CODES.DENIED_BY_POLICY, decision.reason || '授权策略拒绝了这次动作', started);
    }

    // ③ 需要人工确认就挂起（动作级确认优先于站点白名单，白名单不豁免）
    const needConfirm = decision.decision === 'confirm' || requiresConfirmation(type);
    let confirmedBy = '';
    if (needConfirm) {
      if (!confirmChannel) {
        const entry = baseEntry(type, entryBase);
        entry.stage = STAGES.confirm;
        entry.rule = decision.rule;
        return refuse(
          entry,
          CODES.CONFIRM_UNAVAILABLE,
          `这个动作需要人工确认，但当前没有可用的确认通道，已拒绝：${(CONFIRM_RULES[type] || {}).why || '需要人工确认'}`,
          started,
        );
      }

      const confirmEntry = baseEntry(type, entryBase);
      confirmEntry.stage = STAGES.confirm;
      confirmEntry.decision = DECISIONS.deny;
      confirmEntry.rule = decision.rule;
      confirmEntry.reason = '等待人工确认';
      writeAudit(confirmEntry);

      const answer = await awaitConfirm(
        {
          id: confirmEntry.id,
          type,
          target: entryBase.target,
          params: entryBase.params,
          sensitive: entryBase.sensitive,
          why: (CONFIRM_RULES[type] || {}).why || '这个动作会改变页面或写入文件，需要你确认',
          mode: confirmEntry.mode,
          site: confirmEntry.site,
        },
        controller.signal,
      );

      if (!answer.approved) {
        const entry = Object.assign(confirmEntry, {
          stage: STAGES.result,
          code: answer.code || CODES.CONFIRM_REJECTED,
          reason: answer.reason || '人工确认未通过',
          ok: false,
          error: answer.reason || '人工确认未通过',
          elapsedMs: now() - started,
        });
        writeAudit(entry);
        return {
          ok: false,
          action: type,
          error: entry.error,
          code: entry.code,
          decision: DECISIONS.deny,
          auditId: entry.id,
          elapsedMs: entry.elapsedMs,
        };
      }
      confirmedBy = 'human';
    }

    // ④ 执行（执行前先把「允许」这一步写进审计，失败也要能看到当时被允许过）
    const entry = baseEntry(type, entryBase);
    entry.stage = STAGES.execute;
    entry.decision = confirmedBy ? DECISIONS.confirmed : DECISIONS.allow;
    entry.reason = decision.reason;
    entry.rule = decision.rule;
    entry.confirmedBy = confirmedBy;
    writeAudit(entry);

    inFlight += 1;
    let result;
    const signal = controller.signal;
    try {
      result = await runner.run(action, { signal });
    } catch (err) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
      inFlight -= 1;
    }

    const aborted = Boolean(signal && signal.aborted);
    const ok = Boolean(result && result.ok !== false);

    // ⑤ 回写结果
    const resultEntry = Object.assign({}, entry, {
      stage: STAGES.result,
      ok,
      error: ok ? undefined : (result && result.error) || '动作执行失败（没有返回原因）',
      code: ok ? (result && result.code ? result.code : '') : (result && result.code) || CODES.ACTION_FAILED,
      elapsedMs: now() - started,
      interrupted: aborted,
      reason: aborted ? `执行期间被紧急停止${stopReason ? `（${stopReason}）` : ''}` : entry.reason,
    });
    writeAudit(resultEntry);

    const payload = {
      ok,
      action: type,
      data: ok ? (result && result.data !== undefined ? result.data : stripMeta(result)) : undefined,
      error: ok ? undefined : resultEntry.error,
      code: resultEntry.code || '',
      decision: entry.decision,
      auditId: resultEntry.id,
      elapsedMs: resultEntry.elapsedMs,
      interrupted: aborted,
      confirmedBy: confirmedBy || undefined,
    };
    if (aborted && !ok && !payload.code) payload.code = CODES.ABORTED;
    return payload;
  }

  /** runner 的原始返回可能是 {ok, data} 也可能是裸对象，统一收一下 */
  function stripMeta(raw) {
    if (!raw || typeof raw !== 'object') return raw === undefined ? null : raw;
    const { ok, error, ...rest } = raw;
    return rest;
  }

  /** 不是 dispatch 发起的动作（下载），照样进审计面 */
  function observe(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const type = typeof source.type === 'string' && source.type ? source.type : 'download';
    const ts = now();
    const entry = {
      id: typeof source.id === 'string' && source.id ? source.id : `obs-${++seq}-${ts}`,
      seq,
      ts,
      time: new Date(ts).toISOString(),
      mode: typeof source.mode === 'string' && source.mode ? source.mode : modeOf(),
      site: typeof source.site === 'string' && source.site ? source.site : siteOf(),
      type,
      stage: STAGES.observe,
      target: typeof source.target === 'string' ? source.target : '',
      params: redactParams(type, source.params || {}),
      sensitive: false,
      decision: DECISIONS.observed,
      reason: typeof source.reason === 'string' ? source.reason : '',
      rule: 'observed',
      code: typeof source.code === 'string' ? source.code : '',
      ok: source.ok !== false,
      error: source.ok === false ? source.error || '（没有给出原因）' : undefined,
      elapsedMs: Number.isFinite(source.elapsedMs) ? source.elapsedMs : 0,
      interrupted: false,
    };
    writeAudit(entry);
    return entry;
  }

  /** 紧急停止：中断在途（signal）+ 拒绝后续 + 让等待中的确认立刻失败 */
  function cancelAll(reason) {
    const why = typeof reason === 'string' && reason ? reason : '用户触发了紧急停止';
    stopped = true;
    stopReason = why;
    const abortedInFlight = inFlight;

    try {
      controller.abort();
    } catch {
      /* 忽略：AbortController 已经中止过 */
    }

    for (const [, waiter] of Array.from(pendingConfirms.entries())) {
      waiter.finish({
        approved: false,
        code: CODES.SESSION_STOPPED,
        reason: `等待确认期间被紧急停止（${why}）`,
      });
    }
    pendingConfirms.clear();

    const entry = baseEntry('__stop__', { stage: STAGES.result, reason: why });
    entry.decision = DECISIONS.deny;
    entry.code = CODES.SESSION_STOPPED;
    entry.ok = false;
    entry.abortedInFlight = abortedInFlight;
    writeAudit(entry);

    return { ok: true, stopped: true, reason: why, abortedInFlight, auditId: entry.id };
  }

  /** 解除停止状态（用户确认可以继续之后才会调用） */
  function resume() {
    stopped = false;
    stopReason = '';
    controller = new AbortController();
    return { ok: true, stopped: false };
  }

  function status() {
    return {
      ok: true,
      mode: modeOf(),
      site: siteOf(),
      stopped,
      stopReason,
      inFlight,
      pendingConfirms: pendingConfirms.size,
      auditFailures,
      confirmTimeoutMs,
      confirmRules: CONFIRM_RULES,
      types: DISPATCH_TYPES.map(describeAction),
      observedTypes: OBSERVED_TYPES,
    };
  }

  return { dispatch, observe, cancelAll, resume, status };
}

module.exports = {
  CODES,
  CONFIRM_RULES,
  DECISIONS,
  DISPATCH_TYPES,
  OBSERVED_TYPES,
  STAGES,
  createDispatcher,
  describeAction,
  describeTarget,
  looksLikeSensitive,
  redactParams,
  redactText,
  redactUrl,
  requiresConfirmation,
};
