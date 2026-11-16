'use strict';

/**
 * 统一动作通道回归（清单 C，20 项断言，纯 Node，不启动 Electron）。
 *
 * 背景：清单 §0 的核心判断是「先把动作通道做成一条，再往上挂能力」。
 * 原来的实现里，本地接口直接调 `runner.run()`：没有权限判定、没有人工确认、
 * 没有留痕、没有取消点。于是留痕（D）、授权（E）、急停（D）三件事都无处可挂。
 *
 * 这里用假执行器驱动 `createDispatcher()`，把五段（权限 → 确认 → 留痕 → 执行 →
 * 回写）逐段钉住，最后用静态断言钉住"没有任何入口能绕过通道"。
 *
 * 用法：node scripts/verify-agent-dispatch.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  CODES,
  CONFIRM_RULES,
  DISPATCH_TYPES,
  OBSERVED_TYPES,
  createDispatcher,
  describeAction,
  looksLikeSensitive,
  redactParams,
  redactUrl,
  requiresConfirmation,
} = require(path.join(ROOT, 'src', 'core', 'agent-dispatch.js'));
const { ACTION_TYPES } = require(path.join(ROOT, 'src', 'core', 'actions.js'));

const results = [];
async function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = await fn();
    ok = out === true || (out && out.ok === true);
    detail = out && typeof out === 'object' ? JSON.stringify(out.detail ?? out) : String(out);
  } catch (err) {
    ok = false;
    detail = `抛异常：${err.message}`;
  }
  results.push({ label, ok });
  console.log(`${ok ? '[Nyx] ✔' : '[Nyx] ✘'} ${label}${detail ? `　｜${detail}` : ''}`);
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假执行器：记录每次调用，按需失败，按需挂在 signal 上等急停 */
function createFakeRunner(options = {}) {
  const calls = [];
  const runner = {
    calls,
    run: async (action, ctx) => {
      calls.push({ action, signal: ctx && ctx.signal });
      if (options.failFor && options.failFor === action.type) {
        return { ok: false, error: '页面里没有这个元素：' + ((action.params && action.params.selector) || '') };
      }
      if (options.hangUntilAbort) {
        return new Promise((resolve) => {
          const signal = ctx && ctx.signal;
          if (signal) {
            signal.addEventListener('abort', () =>
              resolve({ ok: false, code: 'ABORTED', error: '动作已被紧急停止中断' }),
            );
          }
        });
      }
      return { ok: true, data: { echoed: action.type } };
    },
  };
  return runner;
}

/** 建一个把审计写进数组的通道 */
function createHarness(options = {}) {
  const audit = [];
  const runner = options.runner || createFakeRunner(options.runnerOptions);
  const dispatcher = createDispatcher({
    runner,
    mode: options.mode || (() => 'builtin'),
    site: options.site || (() => 'example.com'),
    authorize: options.authorize,
    confirm: options.confirm,
    audit: options.audit || ((entry) => audit.push(entry)),
    confirmTimeoutMs: options.confirmTimeoutMs,
    now: options.now,
  });
  return { audit, runner, dispatcher };
}

async function main() {
  console.log('[Nyx] 统一动作通道回归（清单 C）');

  await check('1. 通道名单与执行器支持的动作一一对应', () => {
    const missing = ACTION_TYPES.filter((type) => !DISPATCH_TYPES.includes(type));
    const extra = DISPATCH_TYPES.filter((type) => !ACTION_TYPES.includes(type));
    const ok = missing.length === 0 && extra.length === 0 && DISPATCH_TYPES.length >= 8;
    return { ok, detail: { 通道动作: DISPATCH_TYPES.length, 执行器动作: ACTION_TYPES.length, missing, extra } };
  });

  await check('2. 通道里的每个动作都经通道执行，且各自留下 execute + result 两条记录', async () => {
    const { audit, runner, dispatcher } = createHarness({ confirm: async () => ({ approved: true }) });
    const executed = [];
    for (const type of DISPATCH_TYPES) {
      const params =
        type === 'navigate'
          ? { url: 'https://example.com/a?token=secret' }
          : type === 'click'
            ? { selector: '#go' }
            : type === 'type'
              ? { selector: '#q', text: 'hello' }
              : type === 'executeJS'
                ? { code: 'return 1' }
                : type === 'extractText'
                  ? { selector: 'main' }
                  : type === 'riskLog'
                    ? { limit: 5 }
                    : {};
      const result = await dispatcher.dispatch({ type, params });
      if (result.ok) executed.push(type);
    }
    const resultStages = audit.filter((entry) => entry.stage === 'result' && entry.ok === true);
    // 不再写死动作个数：每加一类动作（例如 B 的 readPage）不该让这条断言变红，
    // 它要守的是「通道里每一个都真的走过流程、都留下两条记录」。
    const expected = DISPATCH_TYPES.length;
    const ok =
      executed.length === expected &&
      runner.calls.length === expected &&
      resultStages.length === expected &&
      audit.every((entry) => typeof entry.id === 'string' && typeof entry.ts === 'number');
    return {
      ok,
      detail: { 执行成功: executed.length, 执行器调用: runner.calls.length, 结果记录: resultStages.length },
    };
  });

  await check('3. 缺少动作类型：直接拒绝且不碰执行器', async () => {
    const { audit, runner, dispatcher } = createHarness({ confirm: async () => ({ approved: true }) });
    const result = await dispatcher.dispatch({ params: {} });
    const ok = result.ok === false && result.code === CODES.MISSING_TYPE && runner.calls.length === 0 && audit.length === 1;
    return { ok, detail: { code: result.code, 执行器调用: runner.calls.length, 错误: result.error } };
  });

  await check('4. 不认识的动作类型：明确拒绝并说明类型', async () => {
    const { runner, dispatcher } = createHarness({ confirm: async () => ({ approved: true }) });
    const result = await dispatcher.dispatch({ type: 'rm-rf', params: {} });
    const ok =
      result.ok === false && result.code === CODES.UNKNOWN_ACTION && runner.calls.length === 0 && result.error.includes('rm-rf');
    return { ok, detail: { code: result.code, 错误: result.error } };
  });

  await check('5. 权限判定拒绝：动作不执行，审计写明是谁拒的（DENIED_BY_POLICY）', async () => {
    const { audit, runner, dispatcher } = createHarness({
      authorize: () => ({ decision: 'deny', reason: '这个站点在屏蔽名单里', rule: 'blocklist' }),
      confirm: async () => ({ approved: true }),
    });
    const result = await dispatcher.dispatch({ type: 'click', params: { selector: '#danger' } });
    const denied = audit.find((entry) => entry.decision === 'deny');
    const ok =
      result.ok === false &&
      result.code === CODES.DENIED_BY_POLICY &&
      runner.calls.length === 0 &&
      denied &&
      denied.rule === 'blocklist' &&
      denied.reason.includes('屏蔽名单');
    return { ok, detail: { code: result.code, rule: denied && denied.rule, 错误: result.error } };
  });

  await check('6. 权限判定自己抛异常：按拒绝处理，不把动作放过去', async () => {
    const { runner, dispatcher } = createHarness({
      authorize: () => {
        throw new Error('策略文件损坏');
      },
      confirm: async () => ({ approved: true }),
    });
    const result = await dispatcher.dispatch({ type: 'navigate', params: { url: 'https://example.com' } });
    const ok =
      result.ok === false && result.code === CODES.DENIED_BY_POLICY && runner.calls.length === 0 && result.error.includes('策略文件损坏');
    return { ok, detail: { code: result.code, 错误: result.error } };
  });

  await check('7. 需要确认却没有确认通道：拒绝而不是偷偷放过去（CONFIRM_UNAVAILABLE）', async () => {
    const { runner, dispatcher } = createHarness();
    const result = await dispatcher.dispatch({ type: 'type', params: { selector: '#q', text: '机密' } });
    const ok =
      result.ok === false && result.code === CODES.CONFIRM_UNAVAILABLE && runner.calls.length === 0 && result.error.includes('输入文字');
    return { ok, detail: { code: result.code, 执行器调用: runner.calls.length, 错误: result.error } };
  });

  await check('8. 人工确认被拒绝：动作不执行，原因原样上报（CONFIRM_REJECTED）', async () => {
    const { audit, runner, dispatcher } = createHarness({ confirm: async () => ({ approved: false }) });
    const result = await dispatcher.dispatch({ type: 'type', params: { selector: '#q', text: '机密' } });
    const confirmStage = audit.find((entry) => entry.stage === 'confirm');
    const ok =
      result.ok === false &&
      result.code === CODES.CONFIRM_REJECTED &&
      runner.calls.length === 0 &&
      confirmStage &&
      result.error.includes('拒绝');
    return { ok, detail: { code: result.code, 确认记录: Boolean(confirmStage), 错误: result.error } };
  });

  await check('9. 人工确认通过：执行并标记为 confirmed（谁确认的也要留痕）', async () => {
    const { audit, runner, dispatcher } = createHarness({ confirm: async () => ({ approved: true }) });
    const result = await dispatcher.dispatch({ type: 'type', params: { selector: '#q', text: 'hello' } });
    const executed = audit.find((entry) => entry.stage === 'execute');
    const ok =
      result.ok === true &&
      result.decision === 'confirmed' &&
      result.confirmedBy === 'human' &&
      runner.calls.length === 1 &&
      executed &&
      executed.decision === 'confirmed';
    return { ok, detail: { decision: result.decision, confirmedBy: result.confirmedBy, 执行记录: Boolean(executed) } };
  });

  await check('10. 确认超时：按拒绝处理，并说清等了多久（CONFIRM_TIMEOUT）', async () => {
    const { runner, dispatcher } = createHarness({
      confirm: () => new Promise(() => {}),
      confirmTimeoutMs: 60,
    });
    const result = await dispatcher.dispatch({ type: 'type', params: { selector: '#q', text: 'x' } });
    const ok =
      result.ok === false && result.code === CODES.CONFIRM_TIMEOUT && runner.calls.length === 0 && /超过/.test(result.error);
    return { ok, detail: { code: result.code, 错误: result.error } };
  });

  await check('11. 执行失败：原因原样保留，审计记 ok=false（人为制造一次失败）', async () => {
    const runner = createFakeRunner({ failFor: 'click' });
    const { audit, dispatcher } = createHarness({ runner, confirm: async () => ({ approved: true }) });
    const result = await dispatcher.dispatch({ type: 'click', params: { selector: '#missing' } });
    const record = audit.find((entry) => entry.stage === 'result');
    const ok =
      result.ok === false &&
      result.code === CODES.ACTION_FAILED &&
      result.error.includes('#missing') &&
      record &&
      record.ok === false &&
      record.error.includes('#missing');
    return { ok, detail: { code: result.code, 错误: result.error } };
  });

  await check('12. 输入内容脱敏：审计里查不到明文，只有长度与前 2 后 2', () => {
    const secret = 'hunter2-my-password';
    const redacted = redactParams('type', { selector: '#password', text: secret, clear: true });
    const text = JSON.stringify(redacted);
    const ok =
      !text.includes(secret) &&
      redacted.text.masked === true &&
      redacted.text.length === secret.length &&
      redacted.text.head === 'hu' &&
      redacted.text.tail === 'rd';
    return { ok, detail: { 明文泄漏: text.includes(secret), text: redacted.text } };
  });

  await check('13. 网址里的查询串在留痕里被抹掉（票据不落审计）', () => {
    const raw = 'https://pt.example.edu.cn/cas/login?service=x&ticket=ST-123';
    const redacted = redactUrl(raw);
    const ok = redacted.includes('pt.example.edu.cn') && !redacted.includes('ticket') && !redacted.includes('ST-123');
    return { ok, detail: { 原地址: raw, 留痕: redacted } };
  });

  await check('14. 密码类选择器被标为敏感（只影响留痕标注，确认策略不变）', () => {
    const sensitive = looksLikeSensitive({ type: 'type', params: { selector: 'input[type=password]' } });
    const plain = looksLikeSensitive({ type: 'type', params: { selector: '#search' } });
    const ok = sensitive === true && plain === false && requiresConfirmation('type') && requiresConfirmation('download');
    return { ok, detail: { 密码框: sensitive, 搜索框: plain, 确认规则: Object.keys(CONFIRM_RULES) } };
  });

  await check('15. 下载不是 dispatch 发起的，但同样进审计面（observe）', () => {
    const { audit, dispatcher } = createHarness();
    const entry = dispatcher.observe({
      type: 'download',
      target: 'a1-probe.bin',
      params: { filename: 'a1-probe.bin', url: 'https://example.com/f.bin?token=abc', bytes: 262144, state: 'completed' },
      reason: '下载完成',
      ok: true,
    });
    const saved = audit.find((it) => it.type === 'download');
    const ok =
      entry.decision === 'observed' &&
      saved &&
      saved.stage === 'observe' &&
      saved.params.filename === 'a1-probe.bin' &&
      !JSON.stringify(saved).includes('token=abc') &&
      OBSERVED_TYPES.includes('download');
    return { ok, detail: { decision: entry.decision, 留痕条数: audit.length } };
  });

  await check('16. 急停：停止后新动作一律拒绝（SESSION_STOPPED），不再派发下一条', async () => {
    const { runner, dispatcher } = createHarness({ confirm: async () => ({ approved: true }) });
    dispatcher.cancelAll('测试急停');
    const result = await dispatcher.dispatch({ type: 'navigate', params: { url: 'https://example.com' } });
    const status = dispatcher.status();
    const ok =
      result.ok === false && result.code === CODES.SESSION_STOPPED && runner.calls.length === 0 && status.stopped === true;
    return { ok, detail: { code: result.code, stopped: status.stopped, 错误: result.error } };
  });

  await check('17. 急停能中断在途动作（signal 真的传到了执行器）', async () => {
    const runner = createFakeRunner({ hangUntilAbort: true });
    const { audit, dispatcher } = createHarness({ runner });
    const pending = dispatcher.dispatch({ type: 'extractText', params: {} });
    for (let i = 0; i < 20 && runner.calls.length === 0; i += 1) await tick(5);
    const stop = dispatcher.cancelAll('用户按了急停');
    const result = await pending;
    const record = audit.filter((entry) => entry.stage === 'result').pop();
    const ok =
      runner.calls.length === 1 &&
      stop.abortedInFlight === 1 &&
      result.ok === false &&
      result.interrupted === true &&
      record &&
      record.interrupted === true;
    return {
      ok,
      detail: { 在途中止数: stop.abortedInFlight, interrupted: result.interrupted, code: result.code },
    };
  });

  await check('18. 急停能让「等待人工确认」的那一步立刻失败，不等超时', async () => {
    const { dispatcher } = createHarness({ confirm: () => new Promise(() => {}), confirmTimeoutMs: 60000 });
    const pending = dispatcher.dispatch({ type: 'type', params: { selector: '#q', text: 'x' } });
    await tick(10);
    dispatcher.cancelAll('等待确认时急停');
    const result = await pending;
    const ok = result.ok === false && result.code === CODES.SESSION_STOPPED;
    return { ok, detail: { code: result.code, 错误: result.error } };
  });

  await check('19. 审计写入自己出错：不静默（计数 + 动作照常执行）', async () => {
    const { runner, dispatcher } = createHarness({
      audit: () => {
        throw new Error('磁盘满了');
      },
      confirm: async () => ({ approved: true }),
    });
    const originalError = console.error;
    console.error = () => {};
    let result;
    let status;
    try {
      result = await dispatcher.dispatch({ type: 'state', params: {} });
      status = dispatcher.status();
    } finally {
      console.error = originalError;
    }
    const ok = result.ok === true && status.auditFailures > 0 && runner.calls.length === 1;
    return { ok, detail: { 动作仍执行: result.ok, 审计失败次数: status.auditFailures } };
  });

  await check('20. 静态守卫：没有任何入口能绕过通道（接口只拿得到 dispatch）', () => {
    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const httpApi = read('src/api/http-api.js');
    const main = read('src/main.js');
    const actions = read('src/core/actions.js');
    const mcp = read('src/mcp/server.js');

    const httpApiNoRunner = !/runner\.run\s*\(/.test(httpApi);
    const httpApiUsesDispatch = /dispatch\(\{ type: 'state' \}\)/.test(httpApi) && /await dispatch\(payload\)/.test(httpApi);
    const httpApiRequiresDispatch = httpApi.includes('需要统一动作通道 dispatch()');
    const mainCreatesChannel = /createDispatcher\(\{/.test(main);
    const mainPassesOnlyDispatch = /dispatch: \(action\) => runtime\.agentDispatcher\.dispatch\(action\)/.test(main);
    const mainNoRunnerToApi = !/startHttpApi\(\{[\s\S]{0,200}?runner,/.test(main);
    const actionsHonorSignal = /signal/.test(actions) && /ABORTED/.test(actions);
    const mcpOnlyThroughApi = !/require\([^)]*core\/actions/.test(mcp) && /\/action/.test(mcp);

    const ok =
      httpApiNoRunner &&
      httpApiUsesDispatch &&
      httpApiRequiresDispatch &&
      mainCreatesChannel &&
      mainPassesOnlyDispatch &&
      mainNoRunnerToApi &&
      actionsHonorSignal &&
      mcpOnlyThroughApi;
    return {
      ok,
      detail: {
        接口不再调执行器: httpApiNoRunner,
        接口走通道: httpApiUsesDispatch,
        接口拒绝无通道: httpApiRequiresDispatch,
        主进程建通道: mainCreatesChannel,
        只把通道交给接口: mainPassesOnlyDispatch,
        执行器尊重急停: actionsHonorSignal,
        MCP只走接口: mcpOnlyThroughApi,
      },
    };
  });

  // 安全审计 P1-2：执行脚本必须人工确认，且工具箱控制台只许对活动标签执行
  await check('22. 执行脚本（executeJS）必须人工确认，控制台执行只许针对活动标签（P1-2）', () => {
    const rule = CONFIRM_RULES.executeJS;
    const ruleOk = Boolean(rule && rule.required === true && /脚本/.test(String(rule.why || '')));
    const fs = require('node:fs');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const start = mainSrc.indexOf("ipcMain.handle('nyx:tb:console-eval'");
    const block = start >= 0 ? mainSrc.slice(start, start + 900) : '';
    const activeOnly = /NOT_ACTIVE_TAB/.test(block) && /activeWcId\(\)/.test(block) && /asked !== active/.test(block);
    const noRawWcId = !/evalScript\(wcIdOf\(payload\)/.test(block);
    return {
      ok: ruleOk && activeOnly && noRawWcId,
      detail: { 确认规则: Boolean(ruleOk), 只许活动标签: activeOnly, 不再用透传的wcId: noRawWcId },
    };
  });

  // 安全审计 P1-4：导航必须有上限；空白页要能靠一次导航起步（不再被当成"没站点可授权"卡死）
  await check('23. 导航有超时上限，空白页能靠一次导航起步（P1-4）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..');
    const actionsSrc = fs.readFileSync(path.join(root, 'src', 'core', 'actions.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    const hasBudget = /const NAVIGATE_TIMEOUT_MS = \d+;/.test(actionsSrc);
    const hasRace = /Promise\.race\(\[getTabManager\(\)\.navigate\(/.test(actionsSrc);
    const hasCode = /NAVIGATE_TIMEOUT/.test(actionsSrc) && /还没完成/.test(actionsSrc);
    const clears = /clearTimeout\(timer\)/.test(actionsSrc);

    // 空白页起步：navigate 的判定按目标站点算（targetSite），因此空 host 也能放行一次
    const authStart = mainSrc.indexOf('async function authorizeAgentAction');
    const authFn = mainSrc.slice(authStart, authStart + 2600);
    const blankBootstrap = /type === 'navigate' \? siteOfUrl\(params\.url\)/.test(authFn) && /const judgeSite = targetSite \|\| site;/.test(authFn);

    const ok = hasBudget && hasRace && hasCode && clears && blankBootstrap;
    return {
      ok,
      detail: {
        导航上限常量: hasBudget,
        与超时赛跑: hasRace,
        超时有错误码与说明: hasCode,
        记得清定时器: clears,
        空白页按目标站点判定: blankBootstrap,
      },
    };
  });

  await check('24. 只读设置不弹确认、真改才弹（N8）', () => {
    const readOnly = requiresConfirmation('settings', {});
    const readOnlyList = requiresConfirmation('settings', { list: true });
    const mutateKey = requiresConfirmation('settings', { key: 'tabSleepMinutes', value: 10 });
    const mutatePreset = requiresConfirmation('settings', { preset: 'quiet' });
    const mutateUndo = requiresConfirmation('settings', { undo: true });
    const before = requiresConfirmation('settings');
    const ok = !readOnly && !readOnlyList && mutateKey && mutatePreset && mutateUndo && before === true;
    return {
      ok,
      detail: {
        只读不弹: !readOnly,
        列举也不弹: !readOnlyList,
        真改要弹: mutateKey && mutatePreset,
        撤销也要弹: mutateUndo,
        没带参数按老规矩弹: before === true,
      },
    };
  });

  await check('25. 空白页上 agent 能读到运行状态（N9：只读状态不涉及页面内容，不该被站点授权拦）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const start = mainSrc.indexOf('async function authorizeAgentAction');
    const fn = mainSrc.slice(start, start + 2600);
    const allowed = /type === 'state'[\s\S]{0,120}state-readonly/.test(fn);
    const beforeSiteCheck = fn.indexOf("type === 'state'") < fn.indexOf('evaluateSite(');
    return { ok: allowed && beforeSiteCheck, detail: { 直接放行: allowed, 在站点判定之前: beforeSiteCheck } };
  });

  // 附带打印一次能力清单，便于人工核对确认策略
  console.log('');
  console.log('[Nyx] 动作确认策略：');
  for (const type of DISPATCH_TYPES) {
    const info = describeAction(type);
    console.log(`         ${info.confirmRequired ? '需人工确认' : '无需确认  '}  ${type}${info.confirmWhy ? ` — ${info.confirmWhy}` : ''}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`[Nyx] 统一动作通道回归失败：${failed.length}/${results.length} 项未通过`);
    for (const item of failed) console.error(`         ✘ ${item.label}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[Nyx] 统一动作通道回归通过：${results.length}/${results.length} 项全绿`);
}

main().catch((err) => {
  console.error('[Nyx] 回归脚本自身出错：', err);
  process.exitCode = 1;
});
