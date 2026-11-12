'use strict';

/**
 * 外壳防护现值表（清单 C3）。
 *
 * 为什么要有这个文件：
 * 清单要求「给出现值表 + 一次注入拦截演示」。一个写死在文档里的表格第二天就会过期，
 * 所以这里做的是**把期望写进代码、把实际值在运行时读出来当场比对**：
 *   - 每个窗口角色（外壳 / 网页标签 / 应用页 / 各浮层）声明它该有的
 *     contextIsolation、nodeIntegration、sandbox；
 *   - 每个渲染页声明它该有的 CSP；
 *   - preload 暴露面按「能干什么是危险的」分类计数。
 * 少声明、写错值，表格当场标红，测试脚本也直接红——不靠人肉记忆。
 *
 * 纯逻辑模块：不 require electron，可以在 Node 里直接单测。
 */

/** 三个安全开关的中文名，表格与提示共用 */
const PREFS_LABELS = {
  contextIsolation: '上下文隔离',
  nodeIntegration: 'Node 集成',
  sandbox: '沙箱',
};

/**
 * Electron 在**没有显式写**这些键时用的默认值。
 * 注意 sandbox 的默认是 false ——这正是最容易踩的地方：
 * 少写一行 `sandbox: true`，网页就在没有沙箱的渲染进程里跑，而代码看上去"没错"。
 */
const PREFS_DEFAULTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
};

/**
 * 窗口角色清单。`expect` 是**必须成立**的值，不是建议值。
 * 新增窗口必须先在 `registerSecurityWindow()` 里登记，否则表格会报「未登记的窗口角色」。
 */
const WINDOW_ROLES = [
  {
    role: 'shell',
    label: '主窗口外壳',
    preload: 'src/preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    why:
      '外壳 preload 用了 Node 侧能力（偏好读写、剪贴板、保存对话框），sandbox 必须关；' +
      '这个窗口只加载本地 index.html，不加载任何远端内容。',
  },
  {
    role: 'tab',
    label: '网页标签（远端内容）',
    preload: 'src/preload-tab.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    why: '唯一承载远端页面的窗口，沙箱必须开，Node 能力必须关。',
  },
  {
    role: 'app-page',
    label: '应用页（起始页 / 设置）',
    preload: 'src/preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    why: '与外层同一个 preload，取舍与 shell 相同；但导航被限制为只放行 file://。',
  },
  {
    role: 'bm-menu',
    label: '收藏悬浮菜单',
    preload: 'src/renderer/bm-menu-preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    why: '纯展示浮层，只有「选一项」一个动作，沙箱开。',
  },
  {
    role: 'addr-suggest',
    label: '地址栏建议浮层',
    preload: 'src/renderer/addr-suggest-preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    why: '纯展示浮层，沙箱开；输入相邻，`focusable:false` 且不抢焦点。',
  },
  {
    role: 'bm-folder',
    label: '收藏到文件夹浮层',
    preload: 'src/renderer/bm-folder-preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    why: '浮层里能新建文件夹（写书签库），动作走 IPC 由主进程校验，页面本身沙箱开。',
  },
  {
    role: 'downloads',
    label: '下载中心窗口',
    preload: 'src/preload-downloads.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    why: '独立窄接口（window.nyxDownloads），只读清单 + 打开/复制，沙箱开。',
  },
  {
    role: 'probe',
    label: '注入演示临时窗口',
    preload: 'src/preload.js',
    expect: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    why: '为了和被测外壳同构（sandbox:false），否则演示的结论不适用于真实外壳；用完立刻销毁。',
  },
];

/** 允许关沙箱的角色白名单（其余角色必须 sandbox:true） */
const SANDBOX_OFF_ALLOWED = WINDOW_ROLES.filter((item) => item.expect.sandbox === false).map(
  (item) => item.role,
);

function describeValue(value) {
  if (value === undefined) return '未声明';
  return value ? '开' : '关';
}

/**
 * 比对单个窗口的 webPreferences。
 * @param {string} role 角色名（必须在 WINDOW_ROLES 里）
 * @param {object} prefs 实际传给 BrowserWindow / WebContentsView 的 webPreferences
 */
function auditPreferences(role, prefs) {
  const declared = WINDOW_ROLES.find((item) => item.role === role);
  const actual = prefs && typeof prefs === 'object' ? prefs : {};
  if (!declared) {
    return {
      role: String(role || ''),
      label: String(role || '未知窗口'),
      rows: [],
      mismatched: 0,
      ok: false,
      note: `未登记的窗口角色：${role || '（空）'}——新增窗口必须先在 WINDOW_ROLES 里声明期望值`,
    };
  }

  const rows = Object.keys(PREFS_LABELS).map((key) => {
    const expected = declared.expect[key];
    const declaredValue = actual[key];
    // 没显式写就用 Electron 默认值，但要把「没写」这件事说出来
    const effective = declaredValue === undefined ? PREFS_DEFAULTS[key] : declaredValue;
    const match = effective === expected;
    let note = '';
    if (!match) {
      note = `期望 ${describeValue(expected)}，实际 ${describeValue(effective)}`;
      if (declaredValue === undefined) {
        note += `（代码里没写这一项，走 Electron 默认值）`;
      }
    } else if (declaredValue === undefined && expected === true) {
      note = '没显式写，靠 Electron 默认值成立——建议显式声明，别赌默认值';
    }
    return {
      key,
      label: PREFS_LABELS[key],
      expected,
      actual: effective,
      declared: declaredValue !== undefined,
      match,
      note,
    };
  });

  const mismatched = rows.filter((row) => !row.match).length;
  return {
    role: declared.role,
    label: declared.label,
    preload: declared.preload,
    why: declared.why,
    rows,
    mismatched,
    ok: mismatched === 0,
    note: mismatched === 0 ? '' : `${mismatched} 项与声明不一致`,
  };
}

/**
 * 汇总整张表。
 * @param {Array} audits auditPreferences() 的结果数组
 */
function summarizeAudit(audits) {
  const list = Array.isArray(audits) ? audits.filter(Boolean) : [];
  const bad = list.filter((item) => !item.ok);
  const rowCount = list.reduce((sum, item) => sum + item.rows.length, 0);
  return {
    windowCount: list.length,
    rowCount,
    badCount: bad.length,
    ok: bad.length === 0,
    note: bad.length ? `${bad.map((item) => item.label).join('、')} 与声明不一致` : '全部与声明一致',
  };
}

/**
 * 从一份 HTML 里取出 CSP。
 * 返回 null 表示这份页面根本没写 CSP（不是"没有限制"的意思，是"没有任何限制"）。
 */
function parseCsp(html) {
  const text = String(html || '');
  const meta = /<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/i.exec(text);
  if (!meta) return null;
  // 属性用哪种引号就用哪种引号收尾：CSP 值里本身含单引号（'self'），
  // 用 [^"']* 会把值截成 "default-src" 然后静默当成合格——这是本仓库踩过的坑。
  const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(meta[0]);
  if (!content) return null;
  const value = content[1] !== undefined ? content[1] : content[2];
  return String(value || '').trim();
}

/**
 * 检查一条 CSP 是否够窄。
 * 只查四个真会要命的点：没有 default-src、允许 eval、脚本允许 inline、来源被放宽成 *。
 */
function auditCsp(policy) {
  if (!policy) {
    return { found: false, policy: '', warnings: ['这份页面没有写 CSP'], ok: false };
  }
  const text = String(policy).toLowerCase();
  const warnings = [];
  if (!/(^|;)\s*default-src\b/.test(text)) warnings.push('缺少 default-src（没有兜底来源限制）');
  if (/(^|[\s;])'unsafe-eval'/.test(text)) warnings.push("允许 'unsafe-eval'");
  if (/script-src[^;]*'unsafe-inline'/.test(text)) warnings.push("script-src 允许 'unsafe-inline'");
  const wildcard = /(default-src|script-src)[^;]*\s\*(?:\s|;|$)/.test(text);
  if (wildcard) warnings.push('来源被放宽成 *');
  return { found: true, policy: String(policy), warnings, ok: warnings.length === 0 };
}

/**
 * preload 暴露面的风险分类。按「能干什么」分，不按函数名前缀硬套——
 * 名字一改分类就失效，而危险能力不会因为改名字就不危险。
 */
const API_RISK_GROUPS = [
  {
    key: 'file-write',
    label: '写文件 / 导出',
    risk: 'high',
    pattern: /(export|save|write|screenshot|diagnostic.*bundle)/i,
  },
  {
    key: 'file-open',
    label: '打开文件 / 目录',
    risk: 'high',
    pattern: /(open.*(file|path|dir|folder|downloads|source|log)|reveal|show.*folder|openFolder)/i,
  },
  {
    key: 'process',
    label: '重启 / 退出进程',
    risk: 'high',
    pattern: /(restart|relaunch|quit|exit)/i,
  },
  {
    key: 'clipboard',
    label: '剪贴板',
    risk: 'medium',
    pattern: /(clipboard|copy)/i,
  },
  {
    key: 'external',
    label: '打开外部链接',
    risk: 'medium',
    pattern: /(advisory|external|openUrl|openExternal)/i,
  },
  {
    key: 'mode',
    label: '模式与隐私',
    risk: 'medium',
    pattern: /(mode|privacy|link|hardening|vault|permission)/i,
  },
  {
    key: 'download',
    label: '下载',
    risk: 'medium',
    pattern: /download/i,
  },
  {
    key: 'nav',
    label: '标签与导航',
    risk: 'low',
    pattern: /(tab|navigate|reload|goBack|goForward|state|address|history|bookmark)/i,
  },
  {
    key: 'settings',
    label: '设置与偏好',
    risk: 'low',
    pattern: /(settings|prefs|theme|gpu|update|ext|hardware|security)/i,
  },
];

/**
 * 把暴露出来的方法名分组计数。
 * @param {string[]} keys `Object.keys(window.nyx)`
 */
function classifyPreloadApi(keys) {
  const list = Array.isArray(keys) ? keys.map((item) => String(item)) : [];
  const groups = API_RISK_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    risk: group.risk,
    keys: [],
  }));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const ungrouped = [];

  for (const name of list) {
    const hit = API_RISK_GROUPS.find((group) => group.pattern.test(name));
    if (hit) {
      byKey.get(hit.key).keys.push(name);
    } else {
      ungrouped.push(name);
    }
  }

  const filled = groups.filter((group) => group.keys.length > 0);
  const highRisk = filled.filter((group) => group.risk === 'high');
  return {
    total: list.length,
    groups: filled,
    ungrouped,
    highRiskKeys: highRisk.reduce((sum, group) => sum + group.keys.length, 0),
    note: list.length
      ? `暴露 ${list.length} 个方法，其中 ${highRisk.reduce((sum, g) => sum + g.keys.length, 0)} 个涉及写文件/开目录/重启`
      : '没有读到暴露面（窗口未就绪或 preload 未生效）',
  };
}

/**
 * 在渲染进程里跑的注入演示脚本。
 *
 * 它只做「尝试」，然后把结果原样报回来；判断放在主进程（describeProbeResult），
 * 这样脚本本身不含任何结论，改判据不用改页面。
 */
function buildProbeScript() {
  return `(() => {
    const checks = [];
    const add = (name, blocked, detail) => {
      checks.push({ name, blocked: !!blocked, detail: String(detail == null ? '' : detail) });
    };

    add('require()', typeof require === 'undefined', typeof require === 'undefined' ? '渲染进程里没有 require' : '拿到了 require');
    add('process', typeof process === 'undefined', typeof process === 'undefined' ? '渲染进程里没有 process' : '拿到了 process');
    add('module', typeof module === 'undefined', typeof module === 'undefined' ? '渲染进程里没有 module' : '拿到了 module');
    add('window.require', typeof window.require === 'undefined', typeof window.require === 'undefined' ? 'window 上没有 require' : 'window 上挂了 require');

    let evalBlocked = false;
    let evalDetail = '';
    try {
      const probe = new Function('return typeof require');
      const got = probe();
      evalBlocked = got === 'undefined';
      evalDetail = evalBlocked ? '动态求值拿到的是 undefined' : '动态求值拿到了 require';
    } catch (err) {
      evalBlocked = true;
      evalDetail = '动态求值被 CSP 挡住：' + (err && err.message ? err.message : '执行被拒绝');
    }
    add("new Function('…') 动态求值", evalBlocked, evalDetail);

    const bridge = window.nyx || window.nyxDownloads || null;
    const bridgeKeys = bridge ? Object.keys(bridge) : [];
    let bridgeFrozen = false;
    let bridgeWriteIgnored = false;
    if (bridge) {
      try {
        bridgeFrozen = Object.isFrozen(bridge);
      } catch (err) {
        bridgeFrozen = false;
      }
      const beforeRef = bridge.navigate;
      try {
        bridge.navigate = function () { return 'pwned'; };
      } catch (err) {
        /* 严格模式下写冻结对象会抛，这本身就是证据 */
      }
      // 引用没变、且没有变成我们的桩，才算「改写无效」
      bridgeWriteIgnored =
        bridge.navigate === beforeRef && String(bridge.navigate).indexOf('pwned') === -1;
    }

    return {
      checks,
      bridgeKeys,
      bridgeFrozen,
      bridgeWriteIgnored,
      location: String(location.href),
    };
  })()`;
}

/**
 * 判读演示结果。
 * 原则：没验到就写「没验到」，绝不把「没报错」当「挡住了」。
 */
function describeProbeResult(raw) {
  const probe = raw && typeof raw === 'object' ? raw : {};
  const checks = Array.isArray(probe.checks) ? probe.checks : [];
  if (!checks.length) {
    return {
      ok: false,
      summary: '演示脚本没有回传任何结果（窗口可能没起来）',
      failed: [],
      checks,
    };
  }
  const failed = checks.filter((item) => !item.blocked);
  const parts = [];
  parts.push(
    failed.length
      ? `有 ${failed.length} 条没挡住：${failed.map((item) => item.name).join('、')}`
      : `${checks.length} 条注入路径全部被挡住`,
  );
  if (probe.bridgeKeys && probe.bridgeKeys.length) {
    parts.push(`暴露面 ${probe.bridgeKeys.length} 个方法，改写它${probe.bridgeWriteIgnored ? '无效（冻结）' : '竟然生效了'}`);
  } else {
    parts.push('没有读到暴露面');
  }
  return {
    ok: failed.length === 0 && !!probe.bridgeWriteIgnored,
    summary: parts.join('；'),
    failed,
    checks,
    bridgeKeys: probe.bridgeKeys || [],
    bridgeFrozen: !!probe.bridgeFrozen,
    bridgeWriteIgnored: !!probe.bridgeWriteIgnored,
  };
}

/**
 * 一次把现值表需要的材料组装好（主进程调用，文件系统扫描放在外面做完再传进来）。
 * @param {object} input { audits, cspFiles, preloadKeys }
 */
function buildSwitchesPayload(input) {
  const source = input && typeof input === 'object' ? input : {};
  const audits = Array.isArray(source.audits) ? source.audits : [];
  const cspFiles = Array.isArray(source.cspFiles) ? source.cspFiles : [];
  const summary = summarizeAudit(audits);
  const api = classifyPreloadApi(source.preloadKeys);
  const cspBad = cspFiles.filter((item) => !item.ok);
  return {
    ok: summary.ok,
    summary: {
      ...summary,
      cspFiles: cspFiles.length,
      cspBadCount: cspBad.length,
      preloadKeys: api.total,
      highRiskKeys: api.highRiskKeys,
      text: summary.ok
        ? `${summary.windowCount} 个窗口角色全部与声明一致；${cspFiles.length} 个本地页面都有 CSP`
        : summary.note,
    },
    roles: audits,
    csp: cspFiles,
    preload: api,
    sandboxOffAllowed: SANDBOX_OFF_ALLOWED,
  };
}

module.exports = {
  API_RISK_GROUPS,
  PREFS_DEFAULTS,
  PREFS_LABELS,
  SANDBOX_OFF_ALLOWED,
  WINDOW_ROLES,
  auditCsp,
  auditPreferences,
  buildProbeScript,
  buildSwitchesPayload,
  classifyPreloadApi,
  describeProbeResult,
  parseCsp,
  summarizeAudit,
};
