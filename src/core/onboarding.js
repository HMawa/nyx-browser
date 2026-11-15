'use strict';

/**
 * 首次安装引导（清单 D2）。
 *
 * 两条硬要求，写成代码就是两个判定：
 *   1. **只有全新安装的第一次启动弹一次**——用安装器写的「首次安装」标记判定，
 *      **不能**用"有没有配置文件"猜（老用户升级上来同样没有这个标记，猜就会把人骗进引导）。
 *   2. **「全部默认」一步进主界面**——不做成"必须走完五步"，点了就按默认值落盘并关窗。
 *
 * 引导里问的五件事（玄锋 11-15 定）：主题、按钮精简 / 完整、下载目录与是否询问、
 * 隐私与代理、起始页与默认书签。每一项都能选「先不定」，落地时不写这一项。
 */

const ONBOARD_MARKER_FILE = 'onboarding.json';

const ONBOARD_STEPS = [
  {
    id: 'look',
    title: '界面',
    summary: '主题与按钮多少。之后随时能在「设置 → 主题与显示」里改。',
  },
  {
    id: 'downloads',
    title: '下载',
    summary: '存到哪、要不要每次问。默认存系统下载目录、每次问。',
  },
  {
    id: 'privacy',
    title: '隐私与代理',
    summary: '隐私模式默认走代理；只有你明确选择才会用真实 IP，届时会写明边界。',
  },
  {
    id: 'start',
    title: '起始页',
    summary: '新标签打开时看到什么。默认是 Nyx 起始页。',
  },
];

// 主题白名单在这里再列一次（与 ui-store 的 UI_PREF_ENUMS.theme 对齐，由回归脚本核对）
const THEME_CHOICES = ['ink', 'aurora', 'paper', 'quiet'];
const DENSITY_CHOICES = ['compact', 'full'];
const START_CHOICES = ['start', 'blank'];

const DEFAULT_CHOICES = {
  theme: 'ink',
  density: 'full',
  downloadAsk: true,
  downloadDir: '',
  privacyLink: 'proxy',
  startPage: 'start',
};

/**
 * 标记文件归一：安装器写的形状是 `{ pending: true, installedAt }`；
 * 升级安装写 `{ pending: false }`；用户走完引导后我们补 `doneAt`。
 */
function normalizeOnboardMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pending = raw.pending === true;
  const doneAt = Number.isFinite(Number(raw.doneAt)) && Number(raw.doneAt) > 0 ? Number(raw.doneAt) : 0;
  const skipped = raw.skipped === true;
  const installedAt = Number.isFinite(Number(raw.installedAt)) && Number(raw.installedAt) > 0
    ? Number(raw.installedAt)
    : 0;
  return { pending, doneAt, skipped, installedAt, version: String(raw.version || '') };
}

/**
 * 要不要弹引导。
 * @param {{marker?: object|null, force?: boolean}} input
 * @returns {{show: boolean, reason: string, code: string}}
 */
function planOnboarding(input) {
  const marker = normalizeOnboardMarker(input && input.marker);
  if (input && input.force === true) {
    return { show: true, code: 'FORCED', reason: '环境变量要求强制走一遍引导（仅供验证）。' };
  }
  if (!marker) {
    return {
      show: false,
      code: 'NO_MARKER',
      reason: '没有安装器写的「首次安装」标记——这多半是开发运行或老配置，按不弹处理。',
    };
  }
  if (marker.doneAt > 0) {
    return { show: false, code: 'ALREADY_DONE', reason: '引导已经走过了，不再弹第二次。' };
  }
  if (!marker.pending) {
    return { show: false, code: 'NOT_FIRST_INSTALL', reason: '这次是升级安装 / 覆盖安装，不弹引导。' };
  }
  return { show: true, code: 'FIRST_INSTALL', reason: '全新安装后的第一次启动。' };
}

/**
 * 把引导里的选择翻成偏好写入清单。选「先不定」的项（undefined / ''）不写。
 * @returns {{ok: boolean, entries: Array<{key: string, value: any}>, notes: string[], error?: string}}
 */
function planOnboardChoices(rawChoices, options) {
  const raw = rawChoices && typeof rawChoices === 'object' ? rawChoices : {};
  const defaults = Object.assign({}, DEFAULT_CHOICES, (options && options.defaults) || {});
  const useDefaults = raw.useDefaults === true;
  const pick = (key) => {
    if (useDefaults) return defaults[key];
    const value = raw[key];
    if (value === undefined || value === null || value === '') return undefined;
    return value;
  };

  const entries = [];
  const notes = [];

  const theme = pick('theme');
  if (theme !== undefined) {
    if (!THEME_CHOICES.includes(theme)) {
      return { ok: false, entries: [], notes: [], error: `不认识的界面主题：${theme}` };
    }
    entries.push({ key: 'theme', value: theme });
  }

  const density = pick('density');
  if (density !== undefined) {
    if (!DENSITY_CHOICES.includes(density)) {
      return { ok: false, entries: [], notes: [], error: `不认识的按钮密度：${density}` };
    }
    // 精简 = 只留图标；完整 = 图标带小字。复用 B1 的小字开关，避免两套说法
    entries.push({ key: 'toolbarLabels', value: density !== 'compact' });
  }

  const downloadAsk = pick('downloadAsk');
  if (downloadAsk !== undefined) entries.push({ key: 'downloadAsk', value: downloadAsk !== false });

  const downloadDir = pick('downloadDir');
  if (downloadDir !== undefined) entries.push({ key: 'downloadDir', value: String(downloadDir) });

  const privacyLink = pick('privacyLink');
  if (privacyLink !== undefined) {
    if (privacyLink !== 'proxy' && privacyLink !== 'direct') {
      return { ok: false, entries: [], notes: [], error: `不认识的隐私模式链路：${privacyLink}` };
    }
    entries.push({ key: 'privacyLink', value: privacyLink });
    if (privacyLink === 'direct') {
      notes.push('隐私模式选了「真实 IP 直连」：这是你自己的选择，本机地址会暴露给访问的站点。');
    }
  }

  const startPage = pick('startPage');
  if (startPage !== undefined) {
    if (!START_CHOICES.includes(startPage)) {
      return { ok: false, entries: [], notes: [], error: `不认识的起始页：${startPage}` };
    }
    entries.push({ key: 'startPage', value: startPage });
  }

  if (entries.length === 0) notes.push('这次没有要改的，全部沿用默认值。');
  return { ok: true, entries, notes };
}

function summarizeOnboardChoices(plan) {
  if (!plan || plan.ok !== true) return '没能把这些选择写进设置。';
  const byKey = {};
  for (const entry of plan.entries) byKey[entry.key] = entry.value;
  const parts = [];
  if (byKey.theme) parts.push(`主题 ${byKey.theme}`);
  if (Object.prototype.hasOwnProperty.call(byKey, 'toolbarLabels')) {
    parts.push(byKey.toolbarLabels ? '按钮完整' : '按钮精简');
  }
  if (Object.prototype.hasOwnProperty.call(byKey, 'downloadAsk')) {
    parts.push(byKey.downloadAsk ? '下载每次问' : '下载不问直接存');
  }
  if (byKey.downloadDir) parts.push(`下载到 ${byKey.downloadDir}`);
  if (byKey.privacyLink) parts.push(byKey.privacyLink === 'direct' ? '隐私模式直连' : '隐私模式走代理');
  if (byKey.startPage) parts.push(byKey.startPage === 'blank' ? '新标签空白' : '新标签起始页');
  return parts.length ? parts.join('、') : '全部沿用默认值。';
}

module.exports = {
  DEFAULT_CHOICES,
  DENSITY_CHOICES,
  ONBOARD_MARKER_FILE,
  ONBOARD_STEPS,
  START_CHOICES,
  THEME_CHOICES,
  normalizeOnboardMarker,
  planOnboardChoices,
  planOnboarding,
  summarizeOnboardChoices,
};
