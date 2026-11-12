/*
 * 新标签页脚本（清单 B1）。
 *
 * 数据只来自本地：书签 + 最近历史，不联网、不请求任何第三方；
 * 书签优先（用户自己挑过的），不足再按最近访问补，同一个站点只占一格。
 */

const els = {
  form: document.getElementById('start-form'),
  input: document.getElementById('start-input'),
  hint: document.getElementById('start-hint'),
  grid: document.getElementById('start-grid'),
  empty: document.getElementById('start-empty'),
  meta: document.getElementById('start-freq-meta'),
  actions: Array.from(document.querySelectorAll('.start-action')),
};

const MAX_TILES = 6;

/**
 * 全新配置（既没书签也没历史）时的兜底入口。
 *
 * 这里刻意只放通用工具类站点，不放任何推广/返利链接——
 * 清单明确要求"不做广告导航页"。
 */
const DEFAULT_TILES = [
  { url: 'https://www.bing.com/', title: '必应搜索', from: 'default' },
  { url: 'https://zh.wikipedia.org/', title: '维基百科', from: 'default' },
  { url: 'https://github.com/', title: 'GitHub', from: 'default' },
  { url: 'https://developer.mozilla.org/zh-CN/', title: 'MDN 文档', from: 'default' },
];

/** 统一的提示写入：成功/普通走灰字，错误走警示色（不静默） */
function setHint(text, isError = false) {
  if (!els.hint) return;
  els.hint.textContent = text || '';
  els.hint.classList.toggle('is-error', !!isError);
}

/** 从 URL 取域名（用于格子副标题，取不到就退回整条地址） */
function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return String(url || '');
  }
}

/** 站点名的首字符（没有图标时用字母块占位，避免联网取 favicon） */
function markOf(name, url) {
  const text = String(name || '').trim() || hostOf(url);
  const ch = text.replace(/^www\./i, '').charAt(0);
  return ch ? ch.toUpperCase() : '·';
}

/** 拍平书签树里的链接（只取有 url 的节点，保持顺序） */
function flattenBookmarks(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.url) out.push({ url: node.url, title: node.title || node.url, from: 'bookmark' });
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) flattenBookmarks(child, out);
  return out;
}

function renderTiles(items) {
  els.grid.textContent = '';
  const show = items.slice(0, MAX_TILES);
  els.empty.hidden = show.length > 0;
  const isDefault = show.length > 0 && show.every((item) => item.from === 'default');
  els.meta.textContent = show.length
    ? isDefault
      ? '默认推荐（书签与历史为空）'
      : `基于书签与最近浏览 · ${show.length} 个`
    : '';

  for (const item of show) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'start-tile';
    tile.dataset.url = item.url;
    tile.title = item.url;

    const mark = document.createElement('span');
    mark.className = 'start-tile-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = markOf(item.title, item.url);

    const text = document.createElement('span');
    text.className = 'start-tile-text';
    const name = document.createElement('span');
    name.className = 'start-tile-name';
    name.textContent = item.title || hostOf(item.url);
    const host = document.createElement('span');
    host.className = 'start-tile-host';
    host.textContent = hostOf(item.url);
    text.append(name, host);

    tile.append(mark, text);
    tile.addEventListener('click', () => open(item.url));
    els.grid.append(tile);
  }
}

/** 打开地址：交给主进程（会先新建普通标签再关掉这个起始页） */
async function open(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    setHint('先输入一个网址或关键词', true);
    els.input.focus();
    return;
  }
  setHint('正在打开…');
  const res = await window.nyx.startOpen(raw);
  if (res && res.ok === false) setHint(res.error || '打不开这个地址', true);
}

async function collectTiles() {
  const seen = new Set();
  const items = [];
  const push = (entry) => {
    const url = String((entry && entry.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = hostOf(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ url, title: (entry && entry.title) || url });
  };

  try {
    const bookmarks = await window.nyx.bookmarksList();
    const flat = flattenBookmarks(bookmarks && bookmarks.tree && bookmarks.tree.root);
    flat.forEach(push);
  } catch {
    /* 书签读不到不影响起始页可用 */
  }

  if (items.length < MAX_TILES) {
    try {
      const history = await window.nyx.historyList();
      (history && history.items ? history.items : []).forEach(push);
    } catch {
      /* 历史读不到就只显示书签 */
    }
  }

  return items;
}

function bindActions() {
  for (const button of els.actions) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      try {
        if (action === 'downloads') await window.nyx.openDownloads();
        else if (action === 'settings') await window.nyx.openSettings();
        else if (action === 'diagnostics') await window.nyx.openSettings({ section: 'diagnostics' });
        else if (action === 'privacy') {
          const status = await window.nyx.getPrivacyStatus();
          const mode = (status && status.mode) || 'normal';
          const link = (status && status.link) || '';
          const text =
            mode === 'private'
              ? `当前是全隐私模式：不落盘、强制走代理${link ? `（${link}）` : ''}`
              : '当前是普通模式：可以用工具与扩展；需要不留痕迹时点右上角开关切到全隐私模式';
          setHint(text);
        }
      } catch (err) {
        setHint(`操作没能完成：${(err && err.message) || err}`, true);
      }
    });
  }
}

function bindForm() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    open(els.input.value);
  });
  // Esc 清空输入，符合"输入框里就地重来"的直觉
  els.input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.input.value) {
      event.preventDefault();
      els.input.value = '';
      setHint('');
    }
  });
}

async function init() {
  bindForm();
  bindActions();
  let items = [];
  try {
    items = await collectTiles();
  } catch (err) {
    setHint(`常用入口加载失败：${(err && err.message) || err}`, true);
  }
  // 全新配置（书签和历史都空）时给一组通用入口，避免首屏只有一句话
  renderTiles(items.length ? items : DEFAULT_TILES);
  els.input.focus();
}

init();
