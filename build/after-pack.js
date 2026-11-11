'use strict';

/**
 * electron-builder afterPack 钩子 —— 生成安装包完整性清单
 *
 * 打包完成后扫描 <appOutDir>\resources 下的程序资产，逐个计算 SHA-256，
 * 汇总写成 resources\integrity.json。运行期 `Nyx.exe --verify-integrity`
 * 与开发期 `node scripts/verify-integrity.js` 都读同一份清单复算比对，
 * 用来发现安装介质损坏、传输截断或被替换的文件。
 *
 * 收录范围（相对 resources 目录）：
 *   - app.asar（主程序归档）
 *   - vendor/**（随包附带的内核与辅助程序）
 *   - licenses/**（第三方许可全文）
 *   - LICENSE、THIRD-PARTY-NOTICES.md
 *
 * 清单格式：
 *   {
 *     "generated": "ISO8601 时间",
 *     "version": "1.16.0",
 *     "algorithm": "sha256",
 *     "files": { "<posix 相对路径>": "<小写 hex>" }
 *   }
 *
 * 说明：
 *   - 键统一用 `/` 分隔的相对路径，保证 Windows / CI 上生成的清单一致；
 *   - 不收录 integrity.json 自身（否则文件内容会自我指涉，永远对不上）；
 *   - 不做路径大小写折叠：Windows 上文件名大小写不敏感，但清单按实际文件名记录。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 清单文件名（放在 resources 目录下） */
const MANIFEST_NAME = 'integrity.json';
/** 摘要算法，与运行期校验脚本保持一致 */
const ALGORITHM = 'sha256';
/** 必须存在的单文件（相对 resources），缺失即视为打包异常 */
const REQUIRED_FILES = ['app.asar', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];
/** 必须存在且需要递归收录的目录（相对 resources） */
const TREE_DIRS = ['vendor', 'licenses'];

/**
 * 计算单个文件的 SHA-256（小写 hex）。
 *
 * 用分块读取而不是 readFileSync：内核的 mihomo.exe 有 60 MB 上下，
 * 一次性读进内存没必要，分块还能顺带降低打包机内存峰值。
 *
 * @param {string} absolutePath 文件的绝对路径
 * @returns {string} 小写十六进制摘要
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
 * 递归收集目录下的所有普通文件，返回相对 resources 的 posix 路径。
 *
 * 符号链接按文件处理（打包产物里不应该有符号链接，真遇到时跟随一次即可）。
 *
 * @param {string} resourcesDir resources 目录绝对路径
 * @param {string} relativeDir 当前递归到的相对目录（posix 形式）
 * @param {string[]} output 收集结果
 */
function collectTree(resourcesDir, relativeDir, output) {
  const absoluteDir = path.join(resourcesDir, ...relativeDir.split('/'));
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectTree(resourcesDir, childRelative, output);
    } else {
      // 清单自身永不收录，避免"写清单改了清单"的自我指涉
      if (childRelative === MANIFEST_NAME) continue;
      output.push(childRelative);
    }
  }
}

/**
 * afterPack 主流程。
 *
 * @param {import('electron-builder').AfterPackContext} context 打包上下文
 */
module.exports = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, 'resources');
  if (!fs.existsSync(resourcesDir)) {
    // 非 Windows 目标（例如 mac 的 Contents/Resources 结构）不适用本清单，
    // 本项目只发布 Windows 安装包，这里直接跳过而不是让构建失败。
    console.log(`[Nyx] 跳过完整性清单：未找到 resources 目录（${resourcesDir}）`);
    return;
  }

  // 必需单文件缺失说明 extraResources 配置或产物有问题，必须让打包直接失败，
  // 否则会产出"看着能装、校验必挂"的安装包。
  for (const name of REQUIRED_FILES) {
    const absolutePath = path.join(resourcesDir, name);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`[Nyx] 完整性清单生成失败：resources 下缺少必需文件 ${name}`);
    }
  }

  /** @type {string[]} */
  const relativePaths = REQUIRED_FILES.slice();
  for (const dir of TREE_DIRS) {
    const absoluteDir = path.join(resourcesDir, dir);
    if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) {
      throw new Error(`[Nyx] 完整性清单生成失败：resources 下缺少必需目录 ${dir}`);
    }
    collectTree(resourcesDir, dir, relativePaths);
  }

  // 稳定排序：同一份产物重复打包时清单键顺序不变，便于 diff 与审计
  relativePaths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  /** @type {Record<string, string>} */
  const files = {};
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(resourcesDir, ...relativePath.split('/'));
    files[relativePath] = hashFile(absolutePath);
  }

  // 版本号以 electron-builder 解析出的 appInfo 为准（与 package.json 同源），
  // 拿不到时回落到项目 package.json，避免钩子里抛错。
  let version = '';
  try {
    version = String(context.packager.appInfo.version || '');
  } catch {
    version = '';
  }
  if (!version) {
    version = String(require('../package.json').version || '');
  }

  const manifest = {
    generated: new Date().toISOString(),
    version,
    algorithm: ALGORITHM,
    files,
  };

  const manifestPath = path.join(resourcesDir, MANIFEST_NAME);
  // 2 空格缩进 + 末尾换行：便于人工抽查，体积代价相对哈希表可以忽略
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `[Nyx] 完整性清单已生成：${MANIFEST_NAME}（${relativePaths.length} 个文件，版本 ${version}，算法 ${ALGORITHM}）`,
  );
};
