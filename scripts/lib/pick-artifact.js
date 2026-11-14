/**
 * 从若干候选里挑出「要验签的那个安装包」。
 *
 * 为什么不能「哪个目录先命中就用哪个」：`dist-sign` 里常常躺着上一次签的旧包，
 * 而 `dist` 里是刚打出来的新包。按目录顺序取第一个，会拿旧包去验签、报一个漂亮的
 * `Status=Valid`——看起来通过了，其实新包根本没验过（本仓库真踩过：1.17.4 打出包后，
 * 验签验的是 1.17.3）。
 *
 * 规则只有一条：版本号最大的优先；版本相同再看修改时间（同一版本重打过）。
 *
 * @param {Array<{name: string, dir?: string, mtimeMs?: number}>} candidates
 * @returns {{name: string, dir?: string, mtimeMs?: number, version: string}|null}
 */

const INSTALLER_RE = /^Nyx-Setup-(\d+)\.(\d+)\.(\d+)\.exe$/i;

function parseInstallerVersion(name) {
  const match = INSTALLER_RE.exec(String(name || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function pickNewestInstaller(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  let best = null;
  let bestVersion = null;
  for (const item of list) {
    if (!item || typeof item.name !== 'string') continue;
    const version = parseInstallerVersion(item.name);
    if (!version) continue;
    if (!best) {
      best = item;
      bestVersion = version;
      continue;
    }
    const order = compareVersions(version, bestVersion);
    if (order > 0) {
      best = item;
      bestVersion = version;
      continue;
    }
    if (order === 0) {
      const left = Number.isFinite(item.mtimeMs) ? item.mtimeMs : 0;
      const right = Number.isFinite(best.mtimeMs) ? best.mtimeMs : 0;
      if (left > right) {
        best = item;
        bestVersion = version;
      }
    }
  }
  if (!best) return null;
  return {
    ...best,
    version: `${bestVersion[0]}.${bestVersion[1]}.${bestVersion[2]}`,
  };
}

module.exports = { compareVersions, parseInstallerVersion, pickNewestInstaller };
