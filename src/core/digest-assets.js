'use strict';

/**
 * 摘要导出「连图片一起存」的纯逻辑。
 *
 * 为什么单独成模块：这一节只做三件事——挑哪些图值得存、给它们起一个能落在
 * Windows 上的文件名、把这件事写进 Markdown。挑与写都不能依赖 Electron，
 * 否则断言只能起一个真实窗口去验，测起来又慢又脆。
 *
 * 三条规矩：
 * 1. 只存图片。视频、音频、字幕一律跳过并说明原因，不假装"顺手也存了"。
 * 2. 同一张图只存一份（按 url 去重），已经是 data: 的内联图由采集端负责。
 * 3. 存不下就说清楚：跳过多少张、各是什么原因，写进 Markdown 而不是只在
 *    状态栏闪一下——文件会被人转走，理由必须跟着文件走。
 */

const { extFromUrl, sanitizeFileStem } = require('./media-collector');

/** 图片目录名后缀：`页面摘要-2026-11-23-10-00_assets/` */
const ASSET_DIR_SUFFIX = '_assets';

/** 一次最多存多少张（与资源页的 120 区分开：导出是"留档"，不是批量搬运） */
const MAX_ASSETS = 40;

/** 单张上限：与预览一致，避免把一张 20MB 的原图塞进导出目录 */
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** 这些东西算"页面上看得见的图" */
const PICK_KINDS = ['image', 'background', 'svg', 'poster', 'icon'];

/**
 * 挑出要存的图。
 * @param {Array} items `media-collector.normalizeCandidates()` 返回的 items
 * @param {{maxCount?: number}} options
 * @returns {{ok: boolean, items: Array, skipped: Array<{url: string, reason: string}>, maxCount: number}}
 */
function pickAssets(items, options) {
  const list = Array.isArray(items) ? items : [];
  const wanted = Number(options && options.maxCount);
  const maxCount = Math.max(1, Math.min(MAX_ASSETS, Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : MAX_ASSETS));
  const picked = [];
  const skipped = [];
  const seen = new Set();

  for (const item of list) {
    const url = item && typeof item.url === 'string' ? item.url : '';
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    if (!PICK_KINDS.includes(item.kind)) {
      skipped.push({ url, reason: `${item.kind || '未知'} 不是图片` });
      continue;
    }
    if (item.ephemeral || /^blob:/i.test(url)) {
      skipped.push({ url, reason: 'blob: 地址只在页面打开时有效，导出时已经取不到' });
      continue;
    }
    if (picked.length >= maxCount) {
      skipped.push({ url, reason: `超过一次最多 ${maxCount} 张的上限` });
      continue;
    }
    picked.push(item);
  }

  return { ok: true, items: picked, skipped, maxCount };
}

/**
 * 给一张图起文件名：`03-站点图标.png`。
 * 序号在前是为了在资源管理器里按名字排序时与 Markdown 里的顺序一致。
 */
function assetFileName(item, index) {
  const data = item && typeof item === 'object' ? item : {};
  const order = String((Number(index) || 0) + 1).padStart(2, '0');
  const stem = sanitizeFileStem(data.stem || data.name || '') || sanitizeFileStem(data.alt || '') || 'image';
  // extFromUrl 与 item.ext 都可能带前导点，先统一剥掉再拼，否则会出现「图.png..jpg」
  const rawExt = String(data.ext || '') || String(extFromUrl(data.url || '') || '');
  const ext = rawExt.replace(/^\.+/, '') || 'png';
  return `${order}-${stem}.${ext}`;
}

/** 由导出的 md 路径推出图片目录名（不含目录，只有名字） */
function assetDirName(markdownPath) {
  const target = String(markdownPath || '');
  const base = target.split(/[\\/]/).pop() || '页面摘要';
  const stem = base.replace(/\.[^.]+$/, '') || '页面摘要';
  return `${stem}${ASSET_DIR_SUFFIX}`;
}

/**
 * 把「本页图片」小节接到 Markdown 末尾（在原有的「---」署名之前）。
 *
 * @param {string} markdown 已经生成的完整 Markdown
 * @param {Array<{url: string, file: string, alt?: string, width?: number, height?: number}>} saved
 * @param {Array<{url: string, reason: string}>} skipped
 * @param {{dirName?: string}} options
 */
function appendImageSection(markdown, saved, skipped, options) {
  const body = String(markdown || '');
  const files = Array.isArray(saved) ? saved.filter((item) => item && item.file) : [];
  const misses = Array.isArray(skipped) ? skipped.filter((item) => item && item.reason) : [];
  if (!files.length && !misses.length) return body;

  const dirName = String((options && options.dirName) || '').replace(/[\\/]+$/, '');
  const lines = ['## 本页图片', ''];
  if (files.length) {
    lines.push(`共 ${files.length} 张，存成文件旁边的 \`${dirName || ASSET_DIR_SUFFIX}\` 目录：`, '');
    for (const item of files) {
      const alt = String(item.alt || '').replace(/[[\]]/g, ' ').trim() || '页面图片';
      const size = Number(item.width) > 0 && Number(item.height) > 0 ? `（${Math.round(item.width)}×${Math.round(item.height)}）` : '';
      const rel = dirName ? `${dirName}/${item.file}` : item.file;
      lines.push(`- ![${alt}](${rel}) ${size}`);
      if (item.url && !/^data:/i.test(item.url)) lines.push(`  <${item.url}>`);
    }
    lines.push('');
  }
  if (misses.length) {
    // 同一原因只写一次，把张数标上；逐条列 url 会让正文变成日志
    const reasons = new Map();
    for (const item of misses) reasons.set(item.reason, (reasons.get(item.reason) || 0) + 1);
    lines.push(`> 还有 ${misses.length} 张没存下来：`);
    for (const [reason, count] of reasons) lines.push(`> - ${reason}（${count} 张）`);
    lines.push('');
  }

  const block = `${lines.join('\n').trim()}\n`;
  const marker = '\n---\n';
  const at = body.lastIndexOf(marker);
  if (at === -1) return `${body.trimEnd()}\n\n${block}`;
  return `${body.slice(0, at).trimEnd()}\n\n${block}${body.slice(at)}`;
}

/** 状态栏/返回给界面的一句话 */
function describeAssetExport(summary) {
  const data = summary && typeof summary === 'object' ? summary : {};
  const saved = Number(data.saved) || 0;
  const skipped = Number(data.skipped) || 0;
  if (!saved && !skipped) return '这一页没有找到可以一起存的图片。';
  if (!saved) return `没有存下图片：${skipped} 张都没取到（原因写在 Markdown 里）。`;
  if (!skipped) return `已存 ${saved} 张图片到同目录的图片文件夹。`;
  return `已存 ${saved} 张图片，另有 ${skipped} 张没取到（原因写在 Markdown 里）。`;
}

module.exports = {
  ASSET_DIR_SUFFIX,
  MAX_ASSETS,
  MAX_ASSET_BYTES,
  PICK_KINDS,
  appendImageSection,
  assetDirName,
  assetFileName,
  describeAssetExport,
  pickAssets,
};
