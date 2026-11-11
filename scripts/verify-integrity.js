'use strict';

/**
 * 开发期 / CI 完整性复核脚本
 *
 * 用法：
 *   node scripts/verify-integrity.js [产物目录]
 *
 * 产物目录可以是：
 *   - dist\win-unpacked（自动向下找 resources\integrity.json）
 *   - 直接给 resources 目录（含 integrity.json）
 *   - 不给参数时默认 dist\win-unpacked
 *
 * 行为：
 *   - 读取 integrity.json，按清单逐个复算 SHA-256 并比对；
 *   - 打印缺失文件、哈希不符明细（含期望值与实际值）；
 *   - 全部一致 exit 0，有任何缺失/不符或清单本身不可用 exit 1。
 *
 * 说明：本脚本只读产物目录，不修改任何文件；清单格式见 build/after-pack.js。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 与打包钩子保持一致：清单文件名与摘要算法 */
const MANIFEST_NAME = 'integrity.json';
const ALGORITHM = 'sha256';

/**
 * 计算文件 SHA-256（小写 hex）。
 * 分块读取，避免把 60 MB 级别的内核文件整块读进内存。
 *
 * @param {string} absolutePath 绝对路径
 * @returns {string}
 */
function hashFile(absolutePath) {
  const hash = crypto.createHash(ALGORITHM);
  const fd = fs.openSync(absolutePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let readBytes = 0;
    while ((readBytes = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(chunk.subarray(0, readBytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 把用户传入的目录解析成"含 integrity.json 的基准目录"。
 *
 * @param {string|undefined} rawArg 命令行参数
 * @returns {{ baseDir: string, manifestPath: string }}
 */
function resolveBase(rawArg) {
  const startDir = path.resolve(rawArg || path.join('dist', 'win-unpacked'));
  // 候选顺序：目录自身 → 目录\resources → 目录\win-unpacked（兼容直接给 dist）
  const candidates = [
    startDir,
    path.join(startDir, 'resources'),
    path.join(startDir, 'win-unpacked'),
    path.join(startDir, 'win-unpacked', 'resources'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, MANIFEST_NAME))) {
      return { baseDir: candidate, manifestPath: path.join(candidate, MANIFEST_NAME) };
    }
  }
  return { baseDir: startDir, manifestPath: path.join(startDir, MANIFEST_NAME) };
}

/**
 * 判断清单里的相对路径是否安全（不允许绝对路径或 .. 逃出基准目录）。
 *
 * @param {string} relativePath 清单键
 * @returns {boolean}
 */
function isSafeRelative(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (path.isAbsolute(relativePath)) return false;
  if (/^[A-Za-z]:/.test(relativePath)) return false;
  return !relativePath.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * 主流程：读清单、复算、打印、返回退出码。
 *
 * @returns {number} 0 通过 / 1 失败
 */
function main() {
  const { baseDir, manifestPath } = resolveBase(process.argv[2]);

  console.log(`[Nyx] 完整性复核目录：${baseDir}`);
  if (!fs.existsSync(manifestPath)) {
    console.error(`[Nyx] 未找到完整性清单：${manifestPath}`);
    console.error('[Nyx] 请先构建产物（electron-builder --dir）或检查传入的目录是否正确。');
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`[Nyx] 完整性清单解析失败：${error.message}`);
    return 1;
  }

  if (!manifest || typeof manifest !== 'object') {
    console.error('[Nyx] 完整性清单格式非法：根节点不是对象。');
    return 1;
  }
  if (manifest.algorithm !== ALGORITHM) {
    console.error(
      `[Nyx] 完整性清单算法不受支持：${String(manifest.algorithm)}（本工具只支持 ${ALGORITHM}）`,
    );
    return 1;
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    console.error('[Nyx] 完整性清单格式非法：files 字段缺失或不是对象。');
    return 1;
  }

  const entries = Object.keys(manifest.files).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length === 0) {
    console.error('[Nyx] 完整性清单为空：没有任何待校验文件。');
    return 1;
  }

  const missing = [];
  const mismatched = [];
  const unsafe = [];
  let matched = 0;

  for (const relativePath of entries) {
    const expected = String(manifest.files[relativePath] || '').toLowerCase();
    if (!isSafeRelative(relativePath)) {
      unsafe.push(relativePath);
      continue;
    }
    const absolutePath = path.join(baseDir, ...relativePath.split(/[\\/]/));
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      missing.push(relativePath);
      continue;
    }
    const actual = hashFile(absolutePath);
    if (actual === expected) {
      matched += 1;
    } else {
      mismatched.push({ relativePath, expected, actual });
    }
  }

  console.log(
    `[Nyx] 清单信息：版本 ${String(manifest.version || '未知')}，生成于 ${String(
      manifest.generated || '未知',
    )}，共 ${entries.length} 项`,
  );

  for (const item of mismatched) {
    console.error(`[Nyx] ✘ 哈希不符：${item.relativePath}`);
    console.error(`         期望：${item.expected}`);
    console.error(`         实际：${item.actual}`);
  }
  for (const relativePath of missing) {
    console.error(`[Nyx] ✘ 文件缺失：${relativePath}`);
  }
  for (const relativePath of unsafe) {
    console.error(`[Nyx] ✘ 清单路径非法（疑似被篡改）：${relativePath}`);
  }

  const failed = mismatched.length + missing.length + unsafe.length;
  if (failed > 0) {
    console.error(
      `[Nyx] 完整性校验失败：${failed} 项异常（缺失 ${missing.length} / 不符 ${mismatched.length} / 非法路径 ${unsafe.length}），` +
        `一致 ${matched} 项，共 ${entries.length} 项。`,
    );
    return 1;
  }

  console.log(`[Nyx] 完整性校验通过：${matched}/${entries.length} 项与清单一致。`);
  return 0;
}

process.exitCode = main();
