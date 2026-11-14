'use strict';

/**
 * 量一量"未压缩的 app.asar 拿去做差分"到底能省多少。
 *
 * 背景：安装包是 NSIS + LZMA 固实压缩，`measure-delta.js` 在 1.17.3 → 1.17.4 上
 * 实测块级命中 0.00%（Electron 43 时代也是 0.00%），所以闸门一直拦着不让走差分。
 * 这里换个问法：如果把 app.asar 单独拿出来发，固定块与内容定义分块各是什么结果？
 *
 * 2026-11-14 实测（dist-sign 的 1.17.3 asar 10,090,940 字节 → dist 的 1.17.4 asar 10,181,055 字节）：
 *   固定块 512K / 128K / 64K：命中率 0.00%（体积差 90,115 字节，却把后面全部错位）
 *   内容定义分块（CDC）平均 16K：命中 75.11%，可省 7,588,142 字节（74.53%）
 *   内容定义分块（CDC）平均 64K：命中 38.27%，可省 3,877,259 字节（38.08%）
 *
 * 结论（写进 docs/实测修复台账.md）：块级差分在安装包形态上无效，在 app.asar 上要有效
 * 必须换成内容定义分块；但 asar 只占安装包约 8%（10MB / 127MB），省下来的是整包的几个百分点，
 * 代价是"两段式发布 + 服务端 CDC 清单 + 客户端打补丁 + 自己签名校验清单"这一整条链路。
 * 现阶段不做，保持整包下载；真要做得先解决"补丁包没有 Authenticode 签名"这个可信度问题。
 *
 * 只读、只打印，不改任何文件。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const base = process.argv[2] || 'dist-sign/win-unpacked/resources/app.asar';
const target = process.argv[3] || 'dist/win-unpacked/resources/app.asar';
const sizes = (process.argv[4] || '512k,128k,64k').split(',');

function parseSize(text) {
  const match = /^(\d+)(k|m)?$/i.exec(String(text).trim());
  if (!match) throw new Error(`看不懂的块大小：${text}`);
  const num = Number(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'm') return num * 1024 * 1024;
  if (unit === 'k') return num * 1024;
  return num;
}

function blocks(buffer, size) {
  const list = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    const slice = buffer.subarray(offset, Math.min(offset + size, buffer.length));
    list.push({ offset, size: slice.length, hash: crypto.createHash('sha256').update(slice).digest('hex') });
  }
  return list;
}

const baseBuf = fs.readFileSync(base);
const targetBuf = fs.readFileSync(target);

console.log(`基线：${base}（${baseBuf.length} 字节）`);
console.log(`目标：${target}（${targetBuf.length} 字节）`);
console.log(`体积变化：${(targetBuf.length - baseBuf.length).toLocaleString('en-US')} 字节`);

for (const text of sizes) {
  const size = parseSize(text);
  const baseBlocks = blocks(baseBuf, size);
  const targetBlocks = blocks(targetBuf, size);
  const have = new Map();
  for (const block of baseBlocks) {
    if (!have.has(block.hash)) have.set(block.hash, []);
    have.get(block.hash).push(block.offset);
  }
  let hit = 0;
  let savedBytes = 0;
  for (const block of targetBlocks) {
    const list = have.get(block.hash);
    if (list && list.length) {
      hit += 1;
      savedBytes += block.size;
      list.shift();
    }
  }
  const hitRate = targetBlocks.length ? (hit / targetBlocks.length) * 100 : 0;
  const savedRate = targetBuf.length ? (savedBytes / targetBuf.length) * 100 : 0;
  console.log(
    `块 ${size / 1024}K：基线 ${baseBlocks.length} 块，目标 ${targetBlocks.length} 块，命中 ${hit} 块`
    + `（命中率 ${hitRate.toFixed(2)}%），可省 ${savedBytes.toLocaleString('en-US')} 字节（${savedRate.toFixed(2)}%）`,
  );
}

/* ------------------------------------------------------------------ */
/* 内容定义分块（gear hash）：不按固定偏移切，插入一段文字不会把后面全部错位 */

const GEAR = (() => {
  const table = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < 256; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    table[i] = seed;
  }
  return table;
})();

function cdcBlocks(buffer, averageSize) {
  const list = [];
  const minSize = Math.floor(averageSize / 4);
  const maxSize = averageSize * 4;
  const mask = (() => {
    let bits = 0;
    while ((1 << bits) < averageSize) bits += 1;
    return (1 << bits) - 1;
  })();
  let start = 0;
  let hash = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    hash = ((hash << 1) + GEAR[buffer[i]]) >>> 0;
    const len = i - start + 1;
    const shouldCut = len >= minSize && ((hash & mask) === 0 || len >= maxSize);
    if (shouldCut || i === buffer.length - 1) {
      const slice = buffer.subarray(start, i + 1);
      list.push({ offset: start, size: slice.length, hash: crypto.createHash('sha256').update(slice).digest('hex') });
      start = i + 1;
      hash = 0;
    }
  }
  return list;
}

for (const average of [16 * 1024, 64 * 1024]) {
  const baseBlocks = cdcBlocks(baseBuf, average);
  const targetBlocks = cdcBlocks(targetBuf, average);
  const have = new Map();
  for (const block of baseBlocks) {
    if (!have.has(block.hash)) have.set(block.hash, []);
    have.get(block.hash).push(block.offset);
  }
  let hit = 0;
  let savedBytes = 0;
  for (const block of targetBlocks) {
    const list = have.get(block.hash);
    if (list && list.length) {
      hit += 1;
      savedBytes += block.size;
      list.shift();
    }
  }
  const savedRate = targetBuf.length ? (savedBytes / targetBuf.length) * 100 : 0;
  console.log(
    `CDC 平均 ${average / 1024}K：基线 ${baseBlocks.length} 段，目标 ${targetBlocks.length} 段，命中 ${hit} 段`
    + `（命中率 ${((hit / baseBlocks.length) * 100).toFixed(2)}%），可省 ${savedBytes.toLocaleString('en-US')} 字节（${savedRate.toFixed(2)}%）`,
  );
}
