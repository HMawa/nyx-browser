'use strict';

/**
 * 地址栏建议浮层（addr-suggest.html）的页面逻辑。
 *
 * v1.3.0：基础版本——渲染条目、高亮同步、点击/移入回传。
 * v1.3.1：① 书签并入建议，条目带「书签」来源徽标；
 *         ② 命中片段用 <mark> 高亮（按主进程下发的 query 做，不拼 HTML 字符串）；
 *         ③ 输入法组合期间不查询由主窗口负责，这里只负责渲染，无需感知。
 *
 * 数据流：
 *   地址栏输入 → renderer.js 把「输入内容 + 地址栏屏幕坐标」交给主进程
 *   → 主进程从书签与历史里筛出命中项，弹出/更新本窗口并推送 nyx:as:data
 *   → 本脚本渲染列表（带命中高亮与来源徽标）；
 *   键盘上下键 → 主进程维护高亮下标，推 nyx:as:index，本脚本只负责点亮；
 *   鼠标移入 → addrSuggest.hover(i) 把高亮同步回主进程；
 *   鼠标点击 → addrSuggest.pick(i) 由主进程在当前标签导航并收起浮层。
 *
 * 本窗口 focusable:false（主进程设置），永远不会抢走地址栏焦点。
 */

(function () {
  const api = window.addrSuggest;
  const listEl = document.getElementById('as-list');
  if (!api || !listEl) return;

  /** 当前建议条目（主进程推送，渲染用） */
  let items = [];
  /** 本次查询词（主进程下发，用于命中高亮） */
  let query = '';
  /** host → 图标 data URL（主进程异步补全，v1.5.0） */
  const icons = {};

  /** 创建元素快捷方法：el('div', 'className', '文本') */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** host 的稳定色相（0~359）：同一域名永远是同一个颜色，便于记忆 */
  function hueOfHost(host) {
    let hash = 0;
    const text = String(host || '');
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    return hash;
  }

  /** 首字母（中文取第一个字，英文取首个字母大写；搜索行固定「搜」） */
  function monogramOf(item) {
    if (item && item.source === 'search') return '搜';
    const host = String((item && item.host) || '');
    const first = host.replace(/^www\./i, '').charAt(0);
    return first ? first.toUpperCase() : '?';
  }

  /**
   * 生成图标节点：有真图标用 <img>，否则用首字母色块。
   * 真图标解码失败（少数站点返回了奇怪的 ICO）时回退首字母，不给用户留空白。
   */
  function iconNode(item) {
    const host = String((item && item.host) || '');
    const wrap = document.createElement('span');
    wrap.className = 'as-icon';

    const dataUrl = host ? icons[host] : '';
    if (dataUrl) {
      const img = document.createElement('img');
      img.className = 'as-icon-img';
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('error', () => {
        img.remove();
        wrap.classList.add('as-mono');
        wrap.style.setProperty('--as-hue', String(hueOfHost(host)));
        wrap.textContent = monogramOf(item);
      });
      img.src = dataUrl;
      wrap.appendChild(img);
      return wrap;
    }

    wrap.classList.add('as-mono');
    wrap.style.setProperty('--as-hue', String(hueOfHost(host)));
    wrap.textContent = monogramOf(item);
    return wrap;
  }

  /**
   * 把文本里命中查询词的所有片段包进 <mark>。
   * 全程用 createTextNode / createElement 拼装，不碰 innerHTML ——
   * 标题与网址都来自外部网页，任何字符串拼 HTML 都是自找 XSS。
   */
  function highlightInto(container, text, needle, maxMarks) {
    const source = String(text || '');
    const raw = String(needle || '');
    if (!source) return;
    if (!raw) {
      container.appendChild(document.createTextNode(source));
      return;
    }

    const lowerSource = source.toLowerCase();
    const lowerNeedle = raw.toLowerCase();
    let from = 0;
    let marks = 0;

    while (from < source.length && marks < maxMarks) {
      const at = lowerSource.indexOf(lowerNeedle, from);
      if (at < 0) break;
      if (at > from) container.appendChild(document.createTextNode(source.slice(from, at)));
      const mark = document.createElement('mark');
      mark.className = 'as-hit';
      mark.textContent = source.slice(at, at + raw.length);
      container.appendChild(mark);
      from = at + raw.length;
      marks += 1;
    }

    if (from < source.length) container.appendChild(document.createTextNode(source.slice(from)));
  }

  /** 高亮指定下标（-1 = 全部熄灭），同时把该条滚入视野 */
  function highlight(index) {
    const rows = listEl.querySelectorAll('.as-item');
    rows.forEach((row, i) => {
      const on = i === index;
      row.classList.toggle('is-on', on);
      if (on && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /** 渲染条目：来源徽标 + 标题主位（高亮）+ 网址次要位（高亮），整行可点 */
  function render(index) {
    listEl.textContent = '';
    if (!items.length) {
      listEl.appendChild(el('div', 'as-empty', '没有匹配的书签或历史记录'));
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const isSearch = item.source === 'search';
      const row = el('div', isSearch ? 'as-item as-search' : 'as-item');
      row.title = item.url || '';

      // 站点图标：有真图标用图，没有用首字母色块（v1.5.0）
      row.appendChild(iconNode(item));

      // 来源徽标：书签 / 搜索 / 剪贴板 / 置顶 各一种；历史条目不加噪
      if (item.source === 'bookmark') {
        row.appendChild(el('span', 'as-src', '书签'));
      } else if (isSearch) {
        row.appendChild(el('span', 'as-src as-src-search', '搜索'));
      } else if (item.source === 'clipboard') {
        row.appendChild(el('span', 'as-src as-src-clip', '剪贴板'));
      } else if (item.pinned) {
        row.appendChild(el('span', 'as-src as-src-pin', '置顶'));
      }

      // 置顶的普通命中（书签/历史里也置顶过）再补一个置顶徽标，避免只有来源徽标看不出来
      if (item.pinned && item.source !== 'pinned') {
        row.appendChild(el('span', 'as-src as-src-pin', '置顶'));
      }

      // 置顶分组（v1.16.0）：工作 / 学习 / 其他，只在置顶条目上出现
      if (item.pinned && item.pinnedGroupLabel) {
        row.appendChild(el('span', 'as-src as-src-group', String(item.pinnedGroupLabel)));
      }

      // 右键：置顶 / 取消置顶（v1.11.0）
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (api.pin) api.pin(item.url, item.title || '');
      });

      // 同站聚合（v1.6.0）：该站点还有 N 条命中被折叠，点「+N」展开
      if (item.expandable && Number(item.groupCount) > 1) {
        const more = el('span', 'as-more', `+${Number(item.groupCount) - 1}`);
        more.title = '展开该站点的其他命中';
        more.addEventListener('mousedown', (event) => event.stopPropagation());
        more.addEventListener('click', (event) => {
          event.stopPropagation();
          if (api.expand) api.expand(item.groupHost || item.host || '');
        });
        row.appendChild(more);
      }

      // 已开着提示（v1.7.0）：这个地址已经在标签里了，避免又开一个重复的
      // v1.8.0：可点切过去；v1.9.0：同址多标签时点击循环切换（当前页但还有别的标签也可点）
      if (Number(item.openTabs) > 0) {
        const total = Number(item.openTabs);
        const canCycle = !item.isActivePage || total > 1;
        const label = item.isActivePage
          ? total > 1
            ? `当前页 ×${total}`
            : '当前页'
          : total > 1
            ? `×${total}`
            : '已打开';
        const openBadge = el('span', 'as-open', label);
        if (!canCycle) {
          openBadge.title = '这个页面就是当前标签';
        } else {
          openBadge.classList.add('as-open-action');
          openBadge.title = total > 1 ? `打开了 ${total} 个标签，点击循环切换` : '已在新标签中打开，点击切过去';
          openBadge.addEventListener('mousedown', (event) => event.stopPropagation());
          openBadge.addEventListener('click', (event) => {
            event.stopPropagation();
            // 多个标签时循环切换，只有一个时等价于直接切过去
            if (api.cycleTab) api.cycleTab(item.url);
            else if (api.switchToTab) api.switchToTab(item.url);
          });
        }
        row.appendChild(openBadge);
      }

      const title = el('span', 'as-title');
      highlightInto(title, item.title || item.url || '', query, 3);
      row.appendChild(title);

      if (isSearch) {
        // 搜索行不展示那条长长的 bing 地址（对用户没有信息量）
        row.appendChild(el('span', 'as-url', '回车直接搜索'));
      } else {
        const url = el('span', 'as-url');
        highlightInto(url, item.url || '', query, 2);
        row.appendChild(url);

        // 访问次数（v1.4.0 频次加权的可见依据）：只对真的访问过多次的历史条目显示
        const visits = Number(item.visits) || 0;
        if (item.source === 'history' && visits >= 2) {
          row.appendChild(el('span', 'as-visits', `${visits} 次`));
        }
      }

      // 鼠标移入：把高亮同步给主进程（回车选中的就是鼠标指向项）
      row.addEventListener('mouseenter', () => {
        highlight(i);
        api.hover(i);
      });

      // 鼠标点击：主进程在当前标签打开并收起浮层
      row.addEventListener('click', () => {
        api.pick(i);
      });

      frag.appendChild(row);
    });

    listEl.appendChild(frag);
    highlight(index);
  }

  // 主进程推送建议数据（窗口复用时会重新推送）
  api.onData((payload) => {
    if (payload && payload.theme) {
      document.documentElement.dataset.theme = payload.theme;
    }
    items = Array.isArray(payload.items) ? payload.items : [];
    query = typeof payload.query === 'string' ? payload.query : '';
    render(Number.isFinite(payload.index) ? payload.index : -1);
  });

  // 键盘导航后的高亮变化
  api.onIndex((payload) => {
    highlight(Number.isFinite(payload.index) ? payload.index : -1);
  });

  // 主进程异步补到站点图标后重渲染（只换图标，不改变高亮状态）
  if (api.onIcons) {
    api.onIcons((payload) => {
      const incoming = (payload && payload.icons) || {};
      let changed = false;
      for (const host of Object.keys(incoming)) {
        if (incoming[host] && icons[host] !== incoming[host]) {
          icons[host] = incoming[host];
          changed = true;
        }
      }
      if (!changed) return;
      const current = Array.from(listEl.querySelectorAll('.as-item')).findIndex((n) =>
        n.classList.contains('is-on'),
      );
      render(current);
    });
  }
})();
