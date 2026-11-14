'use strict';

/**
 * agent 审计面与急停（清单 D）回归：纯 Node，不启动 Electron。
 *
 * 覆盖四件事：
 *   1. 记录归一化——缺字段不崩、阶段/判定/动作都翻成中文，界面不用自己猜；
 *   2. 查询与统计——按动作/判定/站点/关键词/成败筛，倒序，offset/limit；
 *   3. 环形缓冲与落盘——超上限只留最后 N 条、落盘失败只计数不抛、
 *      超过体积阈值先轮转（宁可丢旧账，不能让磁盘无限长）；
 *   4. 静态守卫——审计入口真的接在通道的 audit 回调上，急停真的调了 cancelAll，
 *      恢复真的调了 resume，热键注册失败真的记了诊断。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const auditModule = require(path.join(ROOT, 'src', 'core', 'agent-audit.js'));
const dispatchModule = require(path.join(ROOT, 'src', 'core', 'agent-dispatch.js'));

const { AgentAudit, CSV_HEADER, EXPORT_LIMIT, hostMatches, normalizeEntry, summarizeParams, toCsv } = auditModule;

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`[Nyx] ✔ ${passed}. ${name}${detail ? `　｜${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`[Nyx] ✘ ${name}${detail ? `　｜${detail}` : ''}`);
  }
}

function readSrc(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 造一条最简记录，只给必须的字段，其余走归一化 */
function entry(patch) {
  const base = {
    id: `act-${Math.random().toString(36).slice(2, 8)}`,
    ts: 1700000000000,
    mode: 'builtin',
    site: 'example.com',
    type: 'click',
    target: 'e1a2b3c',
    params: { elementId: 'e1a2b3c' },
    decision: 'allow',
    stage: 'result',
    ok: true,
    elapsedMs: 12,
  };
  return { ...base, ...patch };
}

function fakeDisk() {
  const lines = [];
  let size = 0;
  return {
    lines,
    get size() {
      return size;
    },
    set size(value) {
      size = value;
    },
    appendFile: (file, text) => {
      lines.push({ file, text });
      size += Buffer.byteLength(text, 'utf8');
    },
    statSize: () => size,
  };
}

function main() {
  console.log('[Nyx] agent 审计面与急停回归（清单 D：留痕 + 真刹车）');

  /* ---------- 1. 记录归一化 ---------- */
  const normalized = normalizeEntry({ id: 'act-1', type: 'readPage', decision: 'confirmed', stage: 'execute', ok: false, error: '元素不存在', elapsedMs: 8 });
  check(
    '一条最省的记录也能补齐字段，并把动作/阶段/判定翻成中文',
    Boolean(normalized.id) &&
      normalized.typeLabel === '读取页面' &&
      normalized.stageLabel === '执行' &&
      normalized.decisionLabel === '人工确认后放行' &&
      normalized.agent === 'local' &&
      typeof normalized.time === 'string' &&
      normalized.time.length >= 16,
    JSON.stringify({ typeLabel: normalized.typeLabel, stageLabel: normalized.stageLabel, decisionLabel: normalized.decisionLabel }),
  );

  const dirty = normalizeEntry(null);
  check('脏输入（null）不抛异常，仍返回一条结构完整的记录', Boolean(dirty) && typeof dirty === 'object' && 'ok' in dirty, JSON.stringify({ ok: dirty.ok, type: dirty.type }));

  /* ---------- 2. 站点匹配（与 E 的名单规则一致） ---------- */
  const siteCases = {
    exact: hostMatches('a.b.com', 'a.b.com'),
    sub: hostMatches('a.b.com', 'b.com'),
    deeper: hostMatches('x.a.b.com', 'b.com'),
    notInfix: hostMatches('notb.com', 'b.com'),
    empty: hostMatches('', 'b.com'),
    noFilter: hostMatches('a.b.com', ''),
  };
  check(
    '站点匹配按"域名或子域"，不是按字符串包含',
    siteCases.exact && siteCases.sub && siteCases.deeper && !siteCases.notInfix && !siteCases.empty && siteCases.noFilter,
    JSON.stringify(siteCases),
  );

  /* ---------- 3. 参数摘要与脱敏 ---------- */
  const sensitive = summarizeParams({ sensitive: true, params: { text: 'hunter2', length: 7 } });
  const plain = summarizeParams({ sensitive: false, params: { elementId: 'e1a2b3c' } });
  check(
    '敏感动作的参数只显示"已脱敏"，明文不出现在摘要里',
    sensitive.includes('脱敏') && !sensitive.includes('hunter2') && plain.includes('e1a2b3c'),
    JSON.stringify({ sensitive, plain }),
  );

  /* ---------- 4. 查询 / 统计 / 环形缓冲 ---------- */
  const disk = fakeDisk();
  const audit = new AgentAudit({
    filePath: path.join('C:', 'tmp', 'agent-audit.jsonl'),
    limit: 5,
    appendFile: disk.appendFile,
    statSize: () => disk.size,
    now: () => 1700000000000,
  });

  audit.record(entry({ id: 'a1', type: 'click', decision: 'allow', ok: true, site: 'example.com', ts: 1700000000001 }));
  audit.record(entry({ id: 'a2', type: 'type', decision: 'confirmed', ok: true, site: 'mail.example.com', ts: 1700000000002, sensitive: true }));
  audit.record(entry({ id: 'a3', type: 'navigate', decision: 'deny', ok: false, site: 'evil.example', error: '站点在屏蔽名单', ts: 1700000000003, code: 'DENIED_BY_POLICY' }));
  audit.record(entry({ id: 'a4', type: 'download', decision: 'observed', ok: true, site: 'example.com', ts: 1700000000004 }));
  audit.record(entry({ id: 'a5', type: 'readPage', decision: 'allow', ok: true, site: 'example.com', ts: 1700000000005 }));

  const all = audit.list({});
  check(
    '查询默认倒序（最近的动作在最前），并给出参数摘要',
    all.ok !== false && all.rows.length === 5 && all.rows[0].id === 'a5' && typeof all.rows[0].paramsText === 'string',
    JSON.stringify({ count: all.rows.length, first: all.rows[0] && all.rows[0].id }),
  );

  const onlyType = audit.list({ type: 'click' });
  const onlyDeny = audit.list({ decision: 'deny' });
  const onlyFailed = audit.list({ ok: false });
  const onlySite = audit.list({ site: 'mail.example.com' });
  check(
    '按动作 / 判定 / 只看失败 / 站点（子域）四种筛选都生效',
    onlyType.rows.length === 1 &&
      onlyType.rows[0].id === 'a1' &&
      onlyDeny.rows.length === 1 &&
      onlyDeny.rows[0].id === 'a3' &&
      onlyFailed.rows.length === 1 &&
      onlyFailed.rows[0].id === 'a3' &&
      onlySite.rows.length === 1 &&
      onlySite.rows[0].id === 'a2',
    JSON.stringify({ type: onlyType.rows.length, deny: onlyDeny.rows.length, failed: onlyFailed.rows.length, site: onlySite.rows.length }),
  );

  const byKeyword = audit.list({ keyword: '屏蔽' });
  check('关键词能命中错误文案（用来查"为什么被拒"）', byKeyword.rows.length === 1 && byKeyword.rows[0].id === 'a3', JSON.stringify({ count: byKeyword.rows.length }));

  const paged = audit.list({ offset: 1, limit: 2 });
  check('offset / limit 分页正确（不会把第一页当第二页）', paged.rows.length === 2 && paged.rows[0].id === 'a4' && paged.rows[1].id === 'a3', JSON.stringify(paged.rows.map((r) => r.id)));

  const stats = audit.stats();
  check(
    '统计给出累计数、失败数、敏感数与判定分布',
    stats.total === 5 && stats.failed === 1 && stats.sensitive === 1 && stats.byDecision.deny === 1 && stats.byType.click === 1 && stats.filePath.endsWith('agent-audit.jsonl'),
    JSON.stringify({ total: stats.total, failed: stats.failed, sensitive: stats.sensitive, byDecision: stats.byDecision }),
  );

  for (let i = 0; i < 4; i += 1) audit.record(entry({ id: `b${i}`, ts: 1700000000010 + i }));
  const trimmed = audit.list({});
  check(
    `环形缓冲超上限只留最后 ${audit.limit} 条（累计数仍然照实增长）`,
    trimmed.rows.length === 5 && trimmed.rows[0].id === 'b3' && audit.stats().total === 9,
    JSON.stringify({ kept: trimmed.rows.length, total: audit.stats().total }),
  );

  const cleared = audit.clear();
  check('清空只清内存，磁盘文件与保留条数都说得清', cleared.cleared === 5 && audit.list({}).rows.length === 0 && audit.stats().total === 9, JSON.stringify(cleared));

  /* ---------- 5. 落盘 ---------- */
  const disk2 = fakeDisk();
  const audit2 = new AgentAudit({ filePath: 'x.jsonl', appendFile: disk2.appendFile, statSize: () => disk2.size, now: () => 1700000000000 });
  audit2.record(entry({ id: 'd1' }));
  check('每条记录都追加一行 JSON（事后能翻账，不只在内存里）', disk2.lines.length === 1 && disk2.lines[0].text.trim().startsWith('{') && disk2.lines[0].text.trim().endsWith('}'), JSON.stringify({ lines: disk2.lines.length }));

  const boom = new AgentAudit({
    filePath: 'x.jsonl',
    appendFile: () => {
      throw new Error('EACCES: 没有写入权限');
    },
    statSize: () => 0,
    now: () => 1700000000000,
  });
  const originalError = console.error;
  console.error = () => {};
  boom.record(entry({ id: 'd2' }));
  boom.record(entry({ id: 'd3' }));
  console.error = originalError;
  check(
    '落盘失败不抛异常、不丢内存记录，只累计失败次数',
    boom.stats().diskFailures === 2 && boom.list({}).rows.length === 2,
    JSON.stringify({ diskFailures: boom.stats().diskFailures, kept: boom.list({}).rows.length }),
  );

  const rotating = new AgentAudit({ filePath: 'rot.jsonl', maxBytes: 200, appendFile: () => {}, statSize: () => 400, now: () => 1700000000000 });
  rotating.record(entry({ id: 'r1' }));
  check('超过体积阈值先轮转成 .1（磁盘不会无限长），轮转次数可见', rotating.stats().rotations >= 1, JSON.stringify({ rotations: rotating.stats().rotations }));

  /* ---------- 6. 导出 ---------- */
  const csv = toCsv([normalizeEntry(entry({ id: 'c1', site: 'a,b.com', target: '有"引号"的目标', error: '失败' }))]);
  const lines = csv.split('\r\n');
  const expectedHeader = CSV_HEADER.map((name) => `"${name}"`).join(',');
  const onlyCrLf = !/(^|[^\r])\n/.test(csv);
  check(
    'CSV 有表头、用 CRLF，含逗号/引号的字段被正确转义',
    lines[0] === expectedHeader && onlyCrLf && csv.includes('"a,b.com"') && csv.includes('""引号""'),
    JSON.stringify({ header: lines[0].slice(0, 20), onlyCrLf, quoted: csv.includes('"a,b.com"'), escaped: csv.includes('""引号""') }),
  );

  const many = new AgentAudit({ filePath: 'm.jsonl', appendFile: () => {}, statSize: () => 0, limit: EXPORT_LIMIT + 50, now: () => 1700000000000 });
  for (let i = 0; i < EXPORT_LIMIT + 10; i += 1) many.record(entry({ id: `m${i}`, ts: 1700000000000 + i }));
  check(`导出有条数上限（${EXPORT_LIMIT}），不会一次拉爆界面`, many.exportRows({}).rows.length === EXPORT_LIMIT, JSON.stringify({ exported: many.exportRows({}).rows.length }));

  /* ---------- 7. 静态守卫：真的接上了 ---------- */
  const mainSrc = readSrc('src/main.js');
  const preloadSrc = readSrc('src/preload.js');
  const settingsHtml = readSrc('src/renderer/settings.html');
  const settingsJs = readSrc('src/renderer/settings.js');
  const rendererSrc = readSrc('src/renderer/renderer.js');
  const dispatchSrc = readSrc('src/core/agent-dispatch.js');

  const wiring = {
    auditSink: /recordAgentAudit\(entry\)[\s\S]{0,200}agentAudit\.record\(record\)/.test(mainSrc),
    dispatcherAudit: /audit:\s*recordAgentAudit/.test(mainSrc),
    stopCancels: /function stopAgent[\s\S]{0,800}cancelAll\(/.test(mainSrc),
    stopNotifies: /function stopAgent[\s\S]{0,1200}code:\s*'AGENT_STOPPED'/.test(mainSrc),
    stopDiagnostics: mainSrc.includes("'AGENT_STOPPED'") && mainSrc.includes('aborted'),
    resumeResumes: /function resumeAgent[\s\S]{0,400}\.resume\(\)/.test(mainSrc),
    shortcutGuard: /function registerAgentStopShortcut[\s\S]{0,900}AGENT_STOP_SHORTCUT_FAILED/.test(mainSrc),
    ipcRegistered: /registerDownloadsIpc\(\);\s*\n[\s\S]{0,80}registerAgentAuditIpc\(\)/.test(mainSrc),
    ipcHandlers:
      mainSrc.includes("'nyx:agent:status'") &&
      mainSrc.includes("'nyx:agent:audit'") &&
      mainSrc.includes("'nyx:agent:audit-export'") &&
      mainSrc.includes("'nyx:agent:audit-clear'") &&
      mainSrc.includes("'nyx:agent:stop'") &&
      mainSrc.includes("'nyx:agent:resume'"),
    preloadSurface:
      preloadSrc.includes("invoke('nyx:agent:status')") &&
      preloadSrc.includes("invoke('nyx:agent:audit'") &&
      preloadSrc.includes("invoke('nyx:agent:audit-export'") &&
      preloadSrc.includes("invoke('nyx:agent:stop'") &&
      preloadSrc.includes("invoke('nyx:agent:resume')") &&
      preloadSrc.includes("on('nyx:agent:status'"),
    settingsSection: settingsHtml.includes('data-sec="agent"') && settingsHtml.includes('id="agent-audit-list"') && settingsJs.includes('function loadAgentAudit'),
    shellButton: rendererSrc.includes('btn-agent-stop') && rendererSrc.includes('function applyAgentStatus'),
    stoppedRejects: dispatchSrc.includes('SESSION_STOPPED') && dispatchSrc.includes('stopped'),
  };
  check('审计与急停在通道、IPC、preload、外壳按钮、设置分区五处都真的接上了', Object.values(wiring).every(Boolean), JSON.stringify(wiring));

  console.log('');
  if (failures.length === 0) {
    console.log(`[Nyx] agent 审计回归通过：${passed}/${passed} 项全绿`);
    return 0;
  }
  console.log(`[Nyx] agent 审计回归失败：${failures.length} 项未通过`);
  failures.forEach((name) => console.log(`         ✘ ${name}`));
  return 1;
}

process.exitCode = main();
