'use strict';

/**
 * 整页长截图的纯逻辑：量页面尺寸、算能不能截、给文件名与人话。
 *
 * 为什么单独成模块：真正截图要用 CDP（`Page.captureScreenshot` +
 * `captureBeyondViewport`），那部分必须起 Electron 才测得了；而"多长算太长、
 * 超了怎么交代、文件叫什么"这些判断是纯算术，不该被绑在窗口上。
 *
 * 三条规矩：
 * 1. **必须设上限**。一万像素高的页面拼进一张 PNG 就是上百 MB，先例是浏览器
 *    直接把标签卡死；这里截断并如实告诉用户"只截到多少像素"。
 * 2. 估不出来就拒绝，不猜。量不到尺寸说明页面还没就绪，这时截出来的是白图。
 * 3. 文件名带时间戳与尺寸，同一页截多次不会互相覆盖。
 */

/** 单张长图的像素上限：高 2 万、宽 4 千、总量 4000 万像素 */
const MAX_HEIGHT = 20000;
const MAX_WIDTH = 4000;
/**
 * 总量上限单列一条，因为长与宽各自合规也可能合起来过大：
 * 4000×20000 = 8000 万像素，PNG 编码前光是位图就 320 MB，够把进程顶爆。
 * 4000 万像素（约 160 MB 位图）是"能截下来也不至于卡死"的折中。
 */
const MAX_PIXELS = 40000000;

/**
 * 注入页面量尺寸的脚本。
 *
 * 用 `documentElement.scrollWidth/scrollHeight` 与 `body` 取较大值：
 * 只读 `body.scrollHeight` 在 `html { overflow: hidden }` 的站点上会偏小。
 */
function buildMetricsScript() {
  return `(() => {
  const doc = document.documentElement || {};
  const body = document.body || {};
  const width = Math.max(
    Number(doc.scrollWidth) || 0,
    Number(body.scrollWidth) || 0,
    Number(window.innerWidth) || 0,
  );
  const height = Math.max(
    Number(doc.scrollHeight) || 0,
    Number(body.scrollHeight) || 0,
    Number(window.innerHeight) || 0,
  );
  const cssPixels = Math.max(Number(window.innerWidth) || 0, Number(window.innerHeight) || 0);
  return {
    ok: true,
    url: String(location.href || ''),
    title: String(document.title || ''),
    width,
    height,
    viewportWidth: Number(window.innerWidth) || 0,
    viewportHeight: Number(window.innerHeight) || 0,
    devicePixelRatio: Number(window.devicePixelRatio) || 1,
    readyState: String(document.readyState || ''),
    hasContent: cssPixels > 0,
  };
})()`;
}

/** 把像素数说成人话：`1.2 万` 这种量级比 `12000` 好读 */
function humanPixels(value) {
  const px = Math.max(0, Math.round(Number(value) || 0));
  if (px >= 10000) return `${(px / 10000).toFixed(1)} 万`;
  return String(px);
}

/**
 * 判断这一页能不能整页截、截多大。
 * @param {{width?: number, height?: number, readyState?: string, hasContent?: boolean}} metrics
 * @returns {{ok: boolean, error?: string, width: number, height: number, capped: boolean, note: string, pixels: number}}
 */
function planFullshot(metrics) {
  const data = metrics && typeof metrics === 'object' ? metrics : {};
  const width = Math.round(Number(data.width) || 0);
  const height = Math.round(Number(data.height) || 0);

  if (!data.hasContent || width <= 0 || height <= 0) {
    return {
      ok: false,
      error: '量不出这一页的尺寸（可能还没加载完或是空白页），先等页面显示出来再试。',
      width: 0,
      height: 0,
      capped: false,
      note: '',
      pixels: 0,
    };
  }

  let outWidth = width;
  let outHeight = height;
  let capped = false;
  const notes = [];

  if (outHeight > MAX_HEIGHT) {
    outHeight = MAX_HEIGHT;
    capped = true;
    notes.push(`页面高 ${humanPixels(height)} 像素，超过单张上限，只截到 ${humanPixels(MAX_HEIGHT)} 像素`);
  }
  if (outWidth > MAX_WIDTH) {
    outWidth = MAX_WIDTH;
    capped = true;
    notes.push(`页面宽 ${humanPixels(width)} 像素，超过单张上限，只截到 ${humanPixels(MAX_WIDTH)} 像素`);
  }
  if (outWidth * outHeight > MAX_PIXELS) {
    // 长宽都没超但总量超了（例如 3900×19000）：按比例压到总量以内
    const scale = Math.sqrt(MAX_PIXELS / (outWidth * outHeight));
    outWidth = Math.max(1, Math.floor(outWidth * scale));
    outHeight = Math.max(1, Math.floor(outHeight * scale));
    capped = true;
    notes.push(
      `这一页太大（约 ${humanPixels(width)}×${humanPixels(height)}），为免卡死按比例缩到 ${outWidth}×${outHeight}`,
    );
  }

  return {
    ok: true,
    width: outWidth,
    height: outHeight,
    capped,
    note: notes.join('；'),
    pixels: outWidth * outHeight,
  };
}

/** 状态提示一句话 */
function describeFullshot(plan) {
  const data = plan && typeof plan === 'object' ? plan : {};
  if (!data.ok) return data.error || '这一页截不了整页图。';
  const size = `${data.width}×${data.height}`;
  if (data.capped && data.note) return `已保存整页长图（${size}）：${data.note}。`;
  return `已保存整页长图（${size}）。`;
}

/** 文件名：`整页-2026-11-23-10-00-00-1440x3200.png` */
function fullshotFilename(now) {
  const when = now instanceof Date ? now : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `-${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return `整页-${stamp}.png`;
}

module.exports = {
  MAX_HEIGHT,
  MAX_PIXELS,
  MAX_WIDTH,
  buildMetricsScript,
  describeFullshot,
  fullshotFilename,
  humanPixels,
  planFullshot,
};
