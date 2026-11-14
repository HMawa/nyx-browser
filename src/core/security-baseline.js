'use strict';
/**
 * 安全基线（实测清单 C2）
 *
 * 为什么要有这个文件：清单要求「Node / Electron / Chromium 的 CVE 对照 + 缓解/升级计划」，
 * 而真正会出事的情形不是「文档没写」，是**文档写了一个版本、机器上跑的是另一个版本**，
 * 于是照着文档去核对公告，核对的其实是一台不存在的机器。
 *
 * 所以这里把「声明的版本」做成可执行的事实：启动时拿 `process.versions` 与声明的三元组比对，
 * 不一致就在设置→关于→安全基线里显红，并由 `scripts/verify-security-baseline.js` 在回归里卡住。
 *
 * 本模块是纯逻辑（零 Electron 依赖），既能被主进程 require，也能被 Node 脚本直接单测。
 */

/** 声明基线：改这里必须同时改 docs/Nyx-安全基线-C2-CVE对照.md 与 package.json */
const RUNTIME_BASELINE = {
  electron: '43.7.4',
  chromium: '150.0.7871.250',
  node: '24.21.0',
  reviewedAt: '2026-11-14',
};

/**
 * 公告入口。刻意只给"去哪儿看"，不给结论：结论只能联网核对后写进文档，
 * 代码里不硬编码任何 CVE 编号（硬编码就会过期，而且会让人误以为已经核对过）。
 */
const ADVISORY_SOURCES = [
  {
    key: 'electron',
    label: 'Electron 安全公告',
    url: 'https://github.com/electron/electron/security/advisories',
  },
  {
    key: 'chromium',
    label: 'Chromium 稳定版发布记录',
    url: 'https://chromium.googlesource.com/chromium/src/+log/stable',
  },
  {
    key: 'node',
    label: 'Node.js 安全发布',
    url: 'https://nodejs.org/en/blog/vulnerability',
  },
];

/**
 * 运行时版本归一化：Electron 的 `process.versions.chrome` 可能是 `150.0.7871.250`，
 * 也可能只给主版本号前缀，比较时统一按字符串处理并做宽松匹配。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeVersion(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^v/i, '');
}

/**
 * 判断实际版本是否与声明版本一致。
 * 允许"实际比声明更细"（例如声明 `150.0.7871.250`、实际 `150.0.7871.250` 完全相等才过）；
 * 只要不是完全相等就算漂移——安全基线的意义就是精确，不是"差不多"。
 * @param {string} declared
 * @param {string} actual
 * @returns {{declared: string, actual: string, match: boolean, note: string}}
 */
function compareVersion(declared, actual) {
  const d = normalizeVersion(declared);
  const a = normalizeVersion(actual);
  if (!a) {
    return { declared: d, actual: '', match: false, note: '运行时没有报出版本号，无法确认' };
  }
  if (!d) {
    return { declared: '', actual: a, match: false, note: '声明基线缺少这一项' };
  }
  if (d === a) {
    return { declared: d, actual: a, match: true, note: '与声明基线一致' };
  }
  return {
    declared: d,
    actual: a,
    match: false,
    note: `实际 ${a} 与声明 ${d} 不一致：先更新安全基线与文档，再按复核清单重新核对公告`,
  };
}

/**
 * 汇总三件套的比对结果。
 * @param {{electron?: string, chrome?: string, node?: string}} [versions] 一般是 process.versions
 * @returns {{ok: boolean, reviewedAt: string, drift: string[], items: Array<object>}}
 */
function checkBaseline(versions) {
  const source = versions && typeof versions === 'object' ? versions : {};
  const items = [
    { key: 'electron', label: 'Electron', ...compareVersion(RUNTIME_BASELINE.electron, source.electron) },
    { key: 'chromium', label: 'Chromium', ...compareVersion(RUNTIME_BASELINE.chromium, source.chrome) },
    { key: 'node', label: 'Node.js', ...compareVersion(RUNTIME_BASELINE.node, source.node) },
  ];
  const drift = items.filter((item) => !item.match).map((item) => `${item.label}：${item.note}`);
  return { ok: drift.length === 0, reviewedAt: RUNTIME_BASELINE.reviewedAt, drift, items };
}

/**
 * 一句话中文结论，直接贴到设置页与诊断里。
 * @param {ReturnType<typeof checkBaseline>} result
 * @returns {string}
 */
function describeBaseline(result) {
  const checked = result && typeof result === 'object' ? result : checkBaseline(null);
  if (checked.ok) {
    return `运行时与安全基线一致（Electron ${RUNTIME_BASELINE.electron} / Chromium ${RUNTIME_BASELINE.chromium} / Node ${RUNTIME_BASELINE.node}，基线复核于 ${checked.reviewedAt}）`;
  }
  return `运行时与安全基线不一致：${checked.drift.join('；')}`;
}

/**
 * 供设置页展示的完整载荷（不含任何外部网络请求）。
 * @param {{electron?: string, chrome?: string, node?: string, appVersion?: string}} [versions]
 */
function securityBaselinePayload(versions) {
  const checked = checkBaseline(versions);
  return {
    ok: checked.ok,
    appVersion: versions && versions.appVersion ? String(versions.appVersion) : '',
    reviewedAt: checked.reviewedAt,
    items: checked.items,
    drift: checked.drift,
    summary: describeBaseline(checked),
    sources: ADVISORY_SOURCES.map((item) => ({ ...item })),
  };
}

module.exports = {
  RUNTIME_BASELINE,
  ADVISORY_SOURCES,
  normalizeVersion,
  compareVersion,
  checkBaseline,
  describeBaseline,
  securityBaselinePayload,
};
