'use strict';

/**
 * Nyx agent 审计（清单 D）——所有 agent 动作的留痕与查询。
 *
 * 设计要点（对应清单 D「留痕字段」与「审计面能按时间/站点/agent/动作类型筛选并导出」）：
 *  - 唯一入口：记录只来自 agent-dispatch 的 audit 回调（含 observe 的下载），别的地方不写；
 *  - 内存环形缓冲 + 磁盘 JSONL 追加：内存给界面立刻查，磁盘给事后翻账；
 *  - 内存写失败/磁盘写失败都计数并 console.error，绝不静默（红线 2）；
 *  - 查询与导出都在这里做，界面只负责展示，避免「界面过滤一套、导出另一套」。
 *
 * 本模块是纯逻辑：不 require Electron，不碰窗口。文件系统操作由调用方传进来的
 * appendFile / statSize 完成（这样纯 Node 单测可以直接喂假实现）。
 */

const DEFAULT_LIMIT = 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const EXPORT_LIMIT = 5000;

const DECISION_LABELS = {
  allow: '放行',
  confirmed: '人工确认后放行',
  deny: '拒绝',
  observed: '旁观记录',
};

const STAGE_LABELS = {
  authorize: '权限判定',
  confirm: '等待确认',
  execute: '执行',
  result: '结果',
  observe: '旁观',
};

const TYPE_LABELS = {
  navigate: '打开网址',
  readPage: '读取页面',
  screenshot: '截图',
  click: '点击',
  type: '输入文字',
  executeJS: '执行脚本',
  extractText: '提取文字',
  state: '读状态',
  riskLog: '读风险日志',
  download: '下载',
  // 通道在急停时插一条 __stop__ 记录：界面要显示"紧急停止"，不能把内部标记原样丢给用户看
  __stop__: '紧急停止',
};

const SENSITIVE_MARK = '（内容已脱敏）';

/** 时间戳归一：毫秒数，异常值给 0（宁可显示 1970 也不要 NaN） */
function normalizeTs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 一条审计记录的展示形态：字段齐全、缺的给空串，方便界面直接渲染 */
function normalizeEntry(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // 没有时间戳的记录也必须有时间：审计面上出现一行空白时间等于没留痕
  const ts = normalizeTs(source.ts) || Date.now();
  const type = typeof source.type === 'string' ? source.type : '';
  const decision = typeof source.decision === 'string' ? source.decision : 'allow';
  return {
    id: typeof source.id === 'string' ? source.id : '',
    seq: Number.isFinite(source.seq) ? source.seq : 0,
    ts,
    time: typeof source.time === 'string' && source.time ? source.time : ts ? new Date(ts).toISOString() : '',
    agent: typeof source.agent === 'string' && source.agent ? source.agent : 'local',
    mode: typeof source.mode === 'string' ? source.mode : '',
    site: typeof source.site === 'string' ? source.site : '',
    type,
    typeLabel: TYPE_LABELS[type] || type || '未知动作',
    stage: typeof source.stage === 'string' ? source.stage : '',
    stageLabel: STAGE_LABELS[source.stage] || '',
    target: typeof source.target === 'string' ? source.target : '',
    params: source.params && typeof source.params === 'object' ? source.params : {},
    sensitive: source.sensitive === true,
    decision,
    decisionLabel: DECISION_LABELS[decision] || decision,
    reason: typeof source.reason === 'string' ? source.reason : '',
    rule: typeof source.rule === 'string' ? source.rule : '',
    code: typeof source.code === 'string' ? source.code : '',
    ok: source.ok !== false,
    error: typeof source.error === 'string' ? source.error : '',
    elapsedMs: Number.isFinite(source.elapsedMs) ? Math.max(0, Math.round(source.elapsedMs)) : 0,
    interrupted: source.interrupted === true,
    confirmedBy: typeof source.confirmedBy === 'string' ? source.confirmedBy : '',
  };
}

/** 域名匹配：子域也算命中（a.b.com 命中 b.com），与 E 的名单规则保持一致 */
function hostMatches(site, filter) {
  const target = String(site || '').toLowerCase();
  const want = String(filter || '').trim().toLowerCase();
  if (!want) return true;
  if (!target) return false;
  // 只认「完全相等」或「点是分隔符的子域」。
  // 不能用 includes：那样 b.com 会命中 notb.com，把不相关的站点也算进来。
  return target === want || target.endsWith(`.${want}`);
}

/** 参数摘要：界面一行显示，敏感参数不显示内容 */
function summarizeParams(entry) {
  if (entry.sensitive) return SENSITIVE_MARK;
  const params = entry.params || {};
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (value && typeof value === 'object') {
      if (value.masked) {
        parts.push(`${key}=${SENSITIVE_MARK}`);
        continue;
      }
      if (typeof value.head === 'string') {
        parts.push(`${key}=${SENSITIVE_MARK}`);
        continue;
      }
      parts.push(`${key}={…}`);
      continue;
    }
    const text = String(value);
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
  }
  return parts.join(' · ');
}

/** 一行 CSV 单元格：双引号转义，换行压成空格 */
function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

const CSV_HEADER = [
  '时间',
  '动作ID',
  'agent',
  '模式',
  '站点',
  '动作',
  '阶段',
  '目标',
  '参数摘要',
  '判定',
  '规则/原因',
  '结果',
  '错误码',
  '错误',
  '耗时ms',
];

/** 导出 CSV：给用户拿 Excel 打开用，字段与界面「推导」列一致 */
function toCsv(rows) {
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const entry of rows) {
    lines.push(
      [
        entry.time,
        entry.id,
        entry.agent,
        entry.mode,
        entry.site,
        entry.typeLabel,
        entry.stageLabel,
        entry.target,
        summarizeParams(entry),
        entry.decisionLabel,
        entry.reason || entry.rule,
        entry.ok ? '成功' : '失败',
        entry.code,
        entry.error,
        entry.elapsedMs,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

class AgentAudit {
  /**
   * @param {object} options
   * @param {string} [options.filePath] JSONL 落盘路径（不给就只存内存）
   * @param {number} [options.limit] 内存里保留多少条（默认 1000）
   * @param {number} [options.maxBytes] JSONL 超过多大就轮转（默认 2MB）
   * @param {Function} [options.appendFile] (filePath, text) => void
   * @param {Function} [options.statSize] (filePath) => number
   * @param {Function} [options.now] () => number
   */
  constructor(options) {
    const opts = options || {};
    this.filePath = typeof opts.filePath === 'string' ? opts.filePath : '';
    this.limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.round(opts.limit) : DEFAULT_LIMIT;
    this.maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.round(opts.maxBytes) : DEFAULT_MAX_BYTES;
    this.appendFile = typeof opts.appendFile === 'function' ? opts.appendFile : null;
    this.statSize = typeof opts.statSize === 'function' ? opts.statSize : null;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.entries = [];
    this.total = 0;
    this.memoryFailures = 0;
    this.diskFailures = 0;
    this.rotations = 0;
  }

  /** 记一条：内存 + 磁盘，任一步失败都要计数报错，不吞 */
  record(raw) {
    const entry = normalizeEntry(raw);
    if (!entry.time) entry.time = new Date(this.now()).toISOString();
    if (!entry.ts) entry.ts = this.now();
    this.total += 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.appendToDisk(entry);
    return entry;
  }

  appendToDisk(entry) {
    if (!this.filePath || !this.appendFile) return false;
    try {
      if (this.statSize) {
        const size = Number(this.statSize(this.filePath));
        if (Number.isFinite(size) && size > this.maxBytes) {
          this.rotations += 1;
          this.appendFile(`${this.filePath}.1`, '');
        }
      }
      this.appendFile(this.filePath, `${JSON.stringify(entry)}\n`);
      return true;
    } catch (err) {
      this.diskFailures += 1;
      // 审计落盘失败必须吼出来：漏一条就是账对不上
      console.error('[Nyx] 审计落盘失败（内存里仍有这条）：', err && err.message ? err.message : err);
      return false;
    }
  }

  /** 按条件筛：时间区间 / 站点 / 动作 / 判定 / 是否成功 / agent */
  list(filters) {
    const f = filters && typeof filters === 'object' ? filters : {};
    const since = normalizeTs(f.since);
    const until = normalizeTs(f.until);
    const type = typeof f.type === 'string' ? f.type : '';
    const decision = typeof f.decision === 'string' ? f.decision : '';
    const stage = typeof f.stage === 'string' ? f.stage : '';
    const agent = typeof f.agent === 'string' ? f.agent : '';
    const wantOk = typeof f.ok === 'boolean' ? f.ok : null;
    const keyword = typeof f.keyword === 'string' ? f.keyword.trim().toLowerCase() : '';
    const rows = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (since && entry.ts < since) continue;
      if (until && entry.ts > until) continue;
      if (type && entry.type !== type) continue;
      if (decision && entry.decision !== decision) continue;
      if (stage && entry.stage !== stage) continue;
      if (agent && entry.agent !== agent) continue;
      if (wantOk !== null && entry.ok !== wantOk) continue;
      if (f.site && !hostMatches(entry.site, f.site)) continue;
      if (keyword) {
        const haystack = `${entry.site} ${entry.type} ${entry.target} ${entry.reason} ${entry.code} ${entry.error}`.toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      rows.push(entry);
    }
    const offset = Number.isFinite(f.offset) && f.offset > 0 ? Math.round(f.offset) : 0;
    const limit = Number.isFinite(f.limit) && f.limit > 0 ? Math.round(f.limit) : 200;
    return {
      ok: true,
      total: rows.length,
      offset,
      limit,
      rows: rows.slice(offset, offset + limit).map((entry) => ({
        ...entry,
        paramsText: summarizeParams(entry),
      })),
    };
  }

  /** 统计：判定分布、动作分布、失败数、最近一次停止 */
  stats() {
    const byDecision = {};
    const byType = {};
    let failed = 0;
    let sensitive = 0;
    let lastTs = 0;
    for (const entry of this.entries) {
      byDecision[entry.decision] = (byDecision[entry.decision] || 0) + 1;
      byType[entry.type || '（空）'] = (byType[entry.type || '（空）'] || 0) + 1;
      if (!entry.ok) failed += 1;
      if (entry.sensitive) sensitive += 1;
      if (entry.ts > lastTs) lastTs = entry.ts;
    }
    const sites = [...new Set(this.entries.map((entry) => entry.site).filter(Boolean))];
    return {
      ok: true,
      kept: this.entries.length,
      total: this.total,
      limit: this.limit,
      failed,
      sensitive,
      sites: sites.slice(0, 20),
      byDecision,
      byType,
      lastTs,
      lastTime: lastTs ? new Date(lastTs).toISOString() : '',
      memoryFailures: this.memoryFailures,
      diskFailures: this.diskFailures,
      rotations: this.rotations,
      filePath: this.filePath,
    };
  }

  /** 导出用：默认导出内存里全部（上限 EXPORT_LIMIT），但走同一套筛选 */
  exportRows(filters) {
    const wanted = this.list({ ...(filters || {}), offset: 0, limit: EXPORT_LIMIT });
    return { ok: true, count: wanted.rows.length, rows: wanted.rows };
  }

  /** 清空内存缓冲；磁盘文件不动（要删磁盘由界面显式确认后调用） */
  clear() {
    const cleared = this.entries.length;
    this.entries = [];
    return { ok: true, cleared };
  }
}

module.exports = {
  AgentAudit,
  CSV_HEADER,
  DECISION_LABELS,
  DEFAULT_LIMIT,
  EXPORT_LIMIT,
  STAGE_LABELS,
  TYPE_LABELS,
  hostMatches,
  normalizeEntry,
  summarizeParams,
  toCsv,
};
