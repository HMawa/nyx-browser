'use strict';

/**
 * 首次安装引导（清单 D2）的界面。
 *
 * 两条纪律写在最前面：
 *   1. 每一项都有「先不定」——不选就不写，绝不替用户拍板；
 *   2. 「全部默认」只发一次请求，落盘完就关窗，不做成"必须走完"的向导。
 */

const state = {
  info: null,
  note: '',
};

function byId(id) {
  return document.getElementById(id);
}

function setNote(text) {
  const box = byId('onboard-note');
  if (box) box.textContent = text || '';
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children || []) node.append(child);
  return node;
}

function selectRow(id, label, options, value) {
  const select = el('select', { id, class: 'onboard-select' });
  for (const option of options) {
    const opt = el('option', { value: option.value, text: option.label });
    if (option.value === value) opt.setAttribute('selected', 'selected');
    select.append(opt);
  }
  return el('label', { class: 'onboard-row' }, [
    el('span', { class: 'onboard-row-label', text: label }),
    select,
  ]);
}

function switchRow(id, label, checked) {
  const input = el('input', { type: 'checkbox', id });
  if (checked) input.checked = true;
  return el('label', { class: 'onboard-row onboard-row-switch' }, [
    el('span', { class: 'onboard-row-label', text: label }),
    el('span', { class: 'set-switch' }, [input, el('span', { text: '是' })]),
  ]);
}

function render(info) {
  const box = byId('onboard-steps');
  if (!box) return;
  box.textContent = '';

  const themeOptions = [
    { value: '', label: '先不定' },
    ...(info.themes || []).map((id) => ({ value: id, label: id === 'ink' ? '墨夜（深色）' : id })),
  ];
  const densityOptions = [
    { value: '', label: '先不定' },
    { value: 'full', label: '完整：图标带小字' },
    { value: 'compact', label: '精简：只留图标' },
  ];
  const linkOptions = [
    { value: '', label: '先不定' },
    { value: 'proxy', label: '走代理（推荐）' },
    { value: 'direct', label: '真实 IP 直连（会写明边界）' },
  ];
  const startOptions = [
    { value: '', label: '先不定' },
    { value: 'start', label: 'Nyx 起始页' },
    { value: 'blank', label: '空白页' },
  ];
  const identityOptions = [
    { value: '', label: '先不定' },
    ...(info.identities || []).map((item) => ({ value: item.id, label: item.label })),
  ];

  // ① 界面
  box.append(
    el('section', { class: 'onboard-card' }, [
      el('h2', { text: '1 · 界面' }),
      el('p', { class: 'onboard-desc', text: '先挑个顺眼的，之后在「设置 → 主题与显示」里随时改。' }),
      selectRow('ob-theme', '主题', themeOptions, ''),
      selectRow('ob-density', '顶栏按钮', densityOptions, ''),
    ]),
  );

  // ② 接入方式：只换说法的档位，选了立刻决定设置页里那些词怎么叫
  box.append(
    el('section', { class: 'onboard-card' }, [
      el('h2', { text: '2 · 接入方式' }),
      el('p', {
        class: 'onboard-desc',
        text: '这份界面怎么称呼「连接外部网络」这件事。只改叫法与版式，不改任何网络行为；选「先不定」就按校园网络接入显示。',
      }),
      selectRow('ob-net-identity', '接入方式', identityOptions, ''),
    ]),
  );

  // ③ 下载
  const dir = el('input', { type: 'text', id: 'ob-download-dir', class: 'onboard-input', placeholder: '留空 = 系统下载目录' });
  box.append(
    el('section', { class: 'onboard-card' }, [
      el('h2', { text: '3 · 下载' }),
      el('p', { class: 'onboard-desc', text: '存到哪、要不要每次问。留空就用系统下载目录。' }),
      el('label', { class: 'onboard-row' }, [el('span', { class: 'onboard-row-label', text: '保存目录' }), dir]),
      switchRow('ob-download-ask', '每次下载都问我', true),
    ]),
  );

  // ④ 隐私与接入通道
  box.append(
    el('section', { class: 'onboard-card' }, [
      el('h2', { text: '4 · 隐私与接入通道' }),
      el('p', { class: 'onboard-desc', text: '隐私模式默认经接入通道；只有你明确选「真实 IP」才会直连，并且会一直标注这个边界。' }),
      selectRow('ob-privacy-link', '隐私模式的链路', linkOptions, ''),
    ]),
  );

  // ⑤ 起始页
  box.append(
    el('section', { class: 'onboard-card' }, [
      el('h2', { text: '5 · 起始页' }),
      el('p', { class: 'onboard-desc', text: '新标签打开时看到什么。' }),
      selectRow('ob-start', '新标签页', startOptions, ''),
    ]),
  );
}

function collectChoices() {
  const value = (id) => {
    const node = byId(id);
    return node ? node.value : '';
  };
  const checked = (id) => {
    const node = byId(id);
    return node ? node.checked : true;
  };
  const choices = {};
  const theme = value('ob-theme');
  if (theme) choices.theme = theme;
  const density = value('ob-density');
  if (density) choices.density = density;
  const dir = String(value('ob-download-dir') || '').trim();
  if (dir) choices.downloadDir = dir;
  choices.downloadAsk = checked('ob-download-ask');
  const link = value('ob-privacy-link');
  if (link) choices.privacyLink = link;
  const start = value('ob-start');
  if (start) choices.startPage = start;
  const identity = value('ob-net-identity');
  if (identity) choices.netIdentity = identity;
  return choices;
}

async function finish(skipAll) {
  const buttons = [byId('btn-onboard-skip'), byId('btn-onboard-done')].filter(Boolean);
  for (const button of buttons) button.disabled = true;
  setNote(skipAll ? '正在按默认值设置…' : '正在保存…');
  const payload = skipAll
    ? { skipAll: true, choices: { useDefaults: true } }
    : { skipAll: false, choices: collectChoices() };
  const res = await window.nyx.onboardFinish(payload);
  if (!res || !res.ok) {
    for (const button of buttons) button.disabled = false;
    setNote(`没能保存：${(res && res.error) || '未知原因'}`);
    return;
  }
  setNote(`已保存：${res.summary}`);
}

function init() {
  if (!window.nyx || !window.nyx.onboardState) {
    setNote('当前内核不支持首次引导，直接开始用就好。');
    return;
  }
  window.nyx.onboardState().then((info) => {
    state.info = info || {};
    if (state.info.current && state.info.current.theme) {
      document.documentElement.dataset.theme = state.info.current.theme;
    }
    render(state.info);
  }).catch((err) => setNote(`读取设置失败：${err && err.message ? err.message : err}`));

  const skip = byId('btn-onboard-skip');
  if (skip) skip.addEventListener('click', () => finish(true));
  const done = byId('btn-onboard-done');
  if (done) done.addEventListener('click', () => finish(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') finish(true);
  });
}

init();
