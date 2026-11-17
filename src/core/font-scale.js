/**
 * 界面字号档位（清单 D3 里"属独立改造"的那一项）。
 *
 * 为什么单独一个模块：档位到倍数、档位到文案这两件事都是纯映射，界面侧只该读结果，
 * 不该各自写一份 if/else；而且这几个数字要被回归脚本直接断言，抽出来才好测。
 */

/** 四档：小 / 标准 / 大 / 特大。倍数只影响文字，不缩放手边距与图标尺寸。 */
const FONT_SCALES = {
  small: 0.92,
  normal: 1,
  large: 1.12,
  huge: 1.24
};

const FONT_SCALE_ORDER = ['small', 'normal', 'large', 'huge'];

const FONT_SCALE_LABELS = {
  small: '小',
  normal: '标准',
  large: '大',
  huge: '特大'
};

/** 认不出来的档位一律回到标准档（宁可不动，也不要给用户一个奇怪的倍率） */
function normalizeFontScale(value) {
  const raw = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_SCALES, raw) ? raw : 'normal';
}

/** 档位 → 倍数（写进 CSS 变量 --font-scale） */
function fontScaleFactor(value) {
  return FONT_SCALES[normalizeFontScale(value)];
}

/** 档位 → 中文名（用在徽标、状态行、日志里） */
function describeFontScale(value) {
  const key = normalizeFontScale(value);
  return FONT_SCALE_LABELS[key];
}

/** 档位 → 供界面渲染的选项表（顺序固定，避免下拉框每次重排） */
function fontScaleOptions() {
  return FONT_SCALE_ORDER.map((value) => ({ value, label: FONT_SCALE_LABELS[value], factor: FONT_SCALES[value] }));
}

module.exports = {
  FONT_SCALES,
  FONT_SCALE_ORDER,
  FONT_SCALE_LABELS,
  normalizeFontScale,
  fontScaleFactor,
  describeFontScale,
  fontScaleOptions
};
