'use strict';

/**
 * 进程可辨识（清单 A3）——纯逻辑，不碰 Electron。
 *
 * 用户的原话是「在系统的资源管理器中，要看到浏览器的进程详情」。这里必须先说清
 * 一件事：**进程的映像名改不了**，Windows 上每个 Electron 进程都叫 Nyx.exe，
 * 没有任何公开办法让某个进程显示成「Nyx 标签 3 · example.com」。所以这一版做的是
 * 能做到的那部分：
 *
 * 1. 给每个标签视图注入命令行参数（--nyx-kind= / --nyx-tab= / --nyx-host=）。
 *    任务管理器的「详细信息 → 命令行」列、资源监视器、Process Explorer 都能看到，
 *    一眼就能分辨哪个渲染进程是哪个标签。
 * 2. 应用内给一张「进程详情」表：PID / 类型 / 内存 / 对应标签，PID 与系统里的
 *    完全一致，可复制去任务管理器里对照。
 *
 * 不做的：不改映像名、不做进程改名、不假装能给每个进程不同的图标。
 */

/** 命令行参数前缀：改成别的名字会让文档里的说明对不上，动它之前先改文档 */
const ARG_PREFIX = '--nyx';

/** 进程类型的中文说法 */
const KIND_LABELS = {
  browser: '主进程（窗口与调度）',
  tab: '标签页',
  settings: '设置页',
  downloads: '下载中心',
  toolbox: '工具箱',
  'addr-suggest': '地址栏建议浮层',
  'bm-folder': '书签文件夹浮层',
  'bm-menu': '书签菜单浮层',
  gpu: '图形进程',
  utility: '工具进程（网络/音频等）',
  zygote: '进程孵化器',
  'renderer-unknown': '渲染进程（没对上标签）',
  unknown: '其它进程',
};

/**
 * 把一个 http(s) 地址收成主机名。
 * 非 http(s)（about:blank、chrome-error://、file://）一律返回空串——
 * 那些地址没有主机可言，硬塞一个只会误导人。
 */
function hostOf(url) {
  const text = String(url || '').trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    return new URL(text).host.toLowerCase();
  } catch {
    return '';
  }
}

/** 标签视图要注入的命令行参数 */
function buildTabProcessArgs(input) {
  const options = input && typeof input === 'object' ? input : {};
  const kind = typeof options.kind === 'string' && options.kind ? options.kind : 'tab';
  const args = [`${ARG_PREFIX}-kind=${kind}`];
  const id = Number(options.tabId);
  if (Number.isFinite(id) && id > 0) args.push(`${ARG_PREFIX}-tab=${Math.floor(id)}`);
  const host = hostOf(options.url);
  if (host) args.push(`${ARG_PREFIX}-host=${host}`);
  return args;
}

/** 从命令行里把参数读回来（测试与「进程详情」核对用） */
function parseProcessArgs(list) {
  const out = { kind: '', tabId: 0, host: '' };
  for (const raw of Array.isArray(list) ? list : []) {
    const item = String(raw || '');
    if (!item.startsWith(`${ARG_PREFIX}-`)) continue;
    const body = item.slice(ARG_PREFIX.length + 1);
    const eq = body.indexOf('=');
    if (eq < 0) continue;
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    if (key === 'kind') out.kind = value;
    else if (key === 'tab') out.tabId = Number(value) || 0;
    else if (key === 'host') out.host = value;
  }
  return out;
}

/** 把基础参数与标签参数合起来（顺序不影响意义，但保持稳定便于比对） */
function mergeAdditionalArguments(base, extra) {
  const out = [];
  for (const raw of Array.isArray(base) ? base : []) out.push(String(raw));
  for (const raw of Array.isArray(extra) ? extra : []) {
    const item = String(raw);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function labelOfKind(kind) {
  const key = String(kind || '').trim();
  return KIND_LABELS[key] || KIND_LABELS.unknown;
}

/** 字节 → 兆字节（保留一位小数） */
function mbOf(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value / (1024 * 1024)) * 10) / 10;
}

/**
 * 组「进程详情」表。
 *
 * @param {object} input
 *   metrics: app.getAppMetrics() 的原始数组（每项含 pid / type / memory.workingSetSize）
 *   tabs: [{ id, pid, url, title, asleep }]，pid 是 webContents.getOSProcessId()
 *   mainPid: 主进程 pid（让它排在最前，用户一眼看到"这个是我点开的窗口"）
 */
function buildProcessRows(input) {
  const options = input && typeof input === 'object' ? input : {};
  const metrics = Array.isArray(options.metrics) ? options.metrics : [];
  const tabs = Array.isArray(options.tabs) ? options.tabs : [];
  const mainPid = Number(options.mainPid) || 0;

  // pid → 标签（一个标签一个渲染进程；睡着的标签没有进程，不进表）
  const byPid = new Map();
  for (const tab of tabs) {
    const pid = Number(tab && tab.pid) || 0;
    if (pid > 0) byPid.set(pid, tab);
    }

  const rows = [];
  for (const metric of metrics) {
    const pid = Number(metric && metric.pid) || 0;
    if (pid <= 0) continue;
    const type = String((metric && metric.type) || 'unknown');
    const tab = byPid.get(pid) || null;
    let kind = type;
    let label = '';
    let detail = '';
    if (tab) {
      kind = 'tab';
      const id = Number(tab.id) || 0;
      const host = hostOf(tab.url);
      label = `标签 ${id}${host ? ` · ${host}` : ''}`;
      detail = String(tab.title || '').trim();
      if (tab.asleep) detail = detail || '已休眠';
    } else if (type === 'Tab') {
      // Chromium 自己叫 Tab，但 pid 对不上我们的标签：多半是刚关掉的残留或浮层
      kind = 'renderer-unknown';
      label = labelOfKind(kind);
    } else {
      label = labelOfKind(type.toLowerCase());
    }
    rows.push({
      pid,
      type,
      kind,
      label: label || labelOfKind(kind),
      title: detail,
      mb: mbOf(metric && metric.memory ? metric.memory.workingSetSize * 1024 : 0),
      isMain: mainPid > 0 && pid === mainPid,
    });
  }

  // 主进程排最前，其余按内存从大到小：找"谁在吃内存"最快的顺序
  rows.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return b.mb - a.mb;
  });

  const totalMb = Math.round(rows.reduce((sum, row) => sum + row.mb, 0) * 10) / 10;
  const tabRows = rows.filter((row) => row.kind === 'tab');

  return {
    ok: true,
    rows,
    count: rows.length,
    tabCount: tabRows.length,
    totalMb,
    /** 复制到剪贴板/任务管理器对照用的纯文本 */
    text: [
      `Nyx 进程详情（共 ${rows.length} 个进程 · 合计 ${totalMb} MB）`,
      '注意：映像名一律是 Nyx.exe（Windows 不允许每进程不同），靠 PID 与命令行里的 --nyx-* 参数分辨。',
      ...rows.map((row) => `${row.pid}\t${row.label}${row.title ? `（${row.title}）` : ''}\t${row.mb} MB`),
    ].join('\n'),
    /** 命令行参数列怎么找：写清楚，免得用户以为这版能改映像名 */
    hint: '在任务管理器「详细信息」里打开「命令行」列，能看到每个标签进程带 --nyx-kind / --nyx-tab / --nyx-host。',
  };
}

module.exports = {
  ARG_PREFIX,
  KIND_LABELS,
  buildProcessRows,
  buildTabProcessArgs,
  hostOf,
  labelOfKind,
  mergeAdditionalArguments,
  parseProcessArgs,
};
