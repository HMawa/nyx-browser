'use strict';

/**
 * 下载中心渲染逻辑。
 *
 * 只做展示与转发：所有动作都走 window.nyxDownloads（预加载暴露的窄接口）。
 * 状态文案一律用中文，并把"失败原因 + 落点"直接写在条目里——用户不需要
 * 再去翻日志才知道文件为什么没下下来（清单 A1 的原始抱怨就是"零提示"）。
 */

const els = {
  summary: document.getElementById('dl-summary'),
  empty: document.getElementById('dl-empty'),
  list: document.getElementById('dl-list'),
  hint: document.getElementById('dl-hint'),
  btnOpenDir: document.getElementById('btn-dl-open-dir'),
  btnClear: document.getElementById('btn-dl-clear'),
};

let currentItems = [];

/** 字节数：下载中显示"已收到 / 总量"，结束后显示总量 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 时间：只要时分秒，历史列表不需要年月日 */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 状态 → 中文标签 + 样式类 */
function stateLabel(item) {
  switch (item.state) {
    case 'progressing':
      return { text: '正在下载', cls: 'is-progressing' };
    case 'completed':
      return { text: '已完成', cls: 'is-done' };
    case 'cancelled':
      return { text: '已取消', cls: 'is-failed' };
    default:
      return { text: '失败', cls: 'is-failed' };
  }
}

function setHint(text) {
  els.hint.textContent = text || '';
}

/** 渲染汇总行 */
function renderSummary(summary) {
  if (!summary || !summary.total) {
    els.summary.textContent = '还没有下载记录';
    return;
  }
  const parts = [`共 ${summary.total} 项`];
  if (summary.active) parts.push(`${summary.active} 项进行中`);
  if (summary.done) parts.push(`${summary.done} 项已完成`);
  if (summary.failed) parts.push(`${summary.failed} 项失败`);
  if (summary.cancelled) parts.push(`${summary.cancelled} 项已取消`);
  els.summary.textContent = parts.join(' · ');
}

/** 单个条目 */
function buildItem(item) {
  const li = document.createElement('li');
  const state = stateLabel(item);
  li.className = `dl-item ${state.cls}`;
  li.setAttribute('role', 'listitem');
  li.dataset.id = item.id;

  const top = document.createElement('div');
  top.className = 'dl-item-top';

  const name = document.createElement('span');
  name.className = 'dl-name';
  name.textContent = item.filename || '未命名文件';
  name.title = item.filename || '';

  const size = document.createElement('span');
  size.className = 'dl-size';
  size.textContent =
    item.state === 'progressing'
      ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
      : formatBytes(item.totalBytes || item.receivedBytes);

  const badge = document.createElement('span');
  badge.className = `dl-state ${state.cls}`;
  badge.textContent = state.text;

  top.append(name, size, badge);
  li.append(top);

  // 进度条：只有进行中才画，完成后保留满条会让历史列表很吵
  if (item.state === 'progressing') {
    const bar = document.createElement('div');
    bar.className = 'dl-bar';
    const fill = document.createElement('div');
    fill.className = 'dl-bar-fill';
    const total = Number(item.totalBytes) || 0;
    const received = Number(item.receivedBytes) || 0;
    fill.style.width = total > 0 ? `${Math.min(100, Math.round((received / total) * 100))}%` : '18%';
    bar.append(fill);
    li.append(bar);

    const speed = document.createElement('p');
    speed.className = 'dl-meta';
    speed.textContent = item.speedBytes > 0 ? `${formatBytes(item.speedBytes)}/s` : '正在建立连接…';
    li.append(speed);
  }

  // 落点与时间：失败排查看的就是这一行
  const meta = document.createElement('p');
  meta.className = 'dl-meta';
  const bits = [];
  if (item.savePath) bits.push(item.savePath);
  // 吞吐：让「慢」变成一个能报给开发者的数字，而不是一句感觉
  if (item.avgBytesPerSec > 0) {
    const seconds = item.durationMs > 0 ? (item.durationMs / 1000).toFixed(1) : '';
    bits.push(`平均 ${formatBytes(item.avgBytesPerSec)}/s${seconds ? ` · 用时 ${seconds} s` : ''}`);
  }
  if (item.mode === 'private') bits.push('隐私模式');
  if (item.startedAt) bits.push(formatTime(item.startedAt));
  meta.textContent = bits.join(' · ');
  meta.title = item.savePath || '';
  li.append(meta);

  if (item.error) {
    const err = document.createElement('p');
    err.className = 'dl-error';
    err.textContent = item.error;
    li.append(err);
  }

  const actions = document.createElement('div');
  actions.className = 'dl-actions';

  const finished = item.state === 'completed';
  const addBtn = (label, disabled, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dl-link-btn';
    btn.textContent = label;
    btn.disabled = Boolean(disabled);
    btn.addEventListener('click', onClick);
    actions.append(btn);
  };

  addBtn('打开', !finished, () => openFile(item));
  addBtn('在文件夹中显示', !finished, () => reveal(item));
  addBtn('复制链接', !item.url, () => copyUrl(item));
  li.append(actions);

  return li;
}

/** 整表重绘（列表规模上限 100，重绘成本可接受） */
function render(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  currentItems = items;
  renderSummary(payload && payload.summary);

  els.empty.hidden = items.length > 0;
  els.list.replaceChildren(...items.map(buildItem));

  // 有失败项时清空按钮才有意义；一条记录都没有就禁用，避免点了没反应
  els.btnClear.disabled = !items.some((it) => it.state !== 'progressing');
}

async function openFile(item) {
  const res = await window.nyxDownloads.openFile({ savePath: item.savePath });
  setHint(res && res.ok ? '已打开文件' : `打开失败：${(res && res.error) || '未知原因'}`);
}

async function reveal(item) {
  const res = await window.nyxDownloads.reveal({ savePath: item.savePath });
  if (!res || !res.ok) setHint(`定位失败：${(res && res.error) || '未知原因'}`);
}

async function copyUrl(item) {
  const res = await window.nyxDownloads.copyUrl({ url: item.url });
  setHint(res && res.ok ? '下载地址已复制' : `复制失败：${(res && res.error) || '未知原因'}`);
}

els.btnOpenDir.addEventListener('click', async () => {
  const res = await window.nyxDownloads.openDir();
  if (!res || !res.ok) setHint(`打不开下载目录：${(res && res.error) || '未知原因'}`);
  else setHint(`已打开 ${res.path}`);
});

els.btnClear.addEventListener('click', async () => {
  const res = await window.nyxDownloads.clear();
  if (!res || !res.ok) {
    setHint(`清空失败：${(res && res.error) || '未知原因'}`);
    return;
  }
  setHint('已清空结束的记录（正在下载的保留）');
});

window.nyxDownloads.onState((payload) => render(payload));

// 首屏：窗口可能比首次推送晚建，主动拉一次
window.nyxDownloads.list().then((res) => {
  if (res && res.ok) {
    render({ items: res.items, summary: res.summary });
  } else {
    setHint((res && res.error) || '下载列表读取失败');
  }
});

// 供回归脚本驱动：只暴露只读数据，不给写接口
window.__nyxDownloadsDebug = {
  items: () => currentItems,
  count: () => currentItems.length,
};
