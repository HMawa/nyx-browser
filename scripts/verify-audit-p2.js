'use strict';

/**
 * 安全审计 P2 批次回归（纯 Node，不启动 Electron）。
 *
 * 覆盖四件事：
 *   1. 普通模式下「跨站读存储」「摆布窗口」从 ALLOW 改成 ASK；
 *   2. 普通模式的 UA 不再自报 Nyx / Electron；
 *   3. 隐私模式下 agent 的 screenshot / readPage 被直接拒绝；
 *   4. 上面三条都真接进了代码（静态守卫），不是只写在文档里。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  NORMAL_BASELINE,
  PRIVATE_BASELINE,
  baselineFor,
} = require(path.join(ROOT, 'src', 'core', 'permissions.js'));
const { normalUserAgent, chromeMajor, leaksIdentityToken } = require(path.join(ROOT, 'src', 'core', 'user-agent.js'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

// 1. 普通模式基线：两项高风险能力改为询问
check(
  '普通模式下「跨站访问站点存储」「管理窗口」不再是默认放行，改成逐次询问（P2）',
  NORMAL_BASELINE['storage-access'] === 'ask' &&
    NORMAL_BASELINE['window-management'] === 'ask' &&
    baselineFor('normal', 'storage-access') === 'ask' &&
    baselineFor('normal', 'window-management') === 'ask',
  JSON.stringify({
    storage: NORMAL_BASELINE['storage-access'],
    window: NORMAL_BASELINE['window-management'],
  }),
);

check(
  '隐私模式依旧全拒（这两项没被"顺手放宽"）',
  PRIVATE_BASELINE['storage-access'] !== 'allow' &&
    PRIVATE_BASELINE['window-management'] !== 'allow' &&
    baselineFor('private', 'storage-access') !== 'allow',
  JSON.stringify({ storage: PRIVATE_BASELINE['storage-access'], window: PRIVATE_BASELINE['window-management'] }),
);

check(
  '不该被动到的能力保持原样：全屏、剪贴板写入仍直接放行',
  NORMAL_BASELINE.fullscreen === 'allow' && NORMAL_BASELINE['clipboard-sanitized-write'] === 'allow',
  JSON.stringify({ fullscreen: NORMAL_BASELINE.fullscreen }),
);

// 2. 普通模式 UA
const ua = normalUserAgent({ chromeVersion: '156.0.8078.100' });
check(
  '普通模式的 UA 不含 Nyx/ 与 Electron/ 标记，只报真实内核（P2）',
  leaksIdentityToken(ua) === false && /Chrome\/156\.0\.0\.0/.test(ua) && /Windows NT 10\.0/.test(ua),
  JSON.stringify(ua),
);

check(
  '旧的 Electron 默认 UA 会被判定为"自报家门"（反向用例，防止断言写反）',
  leaksIdentityToken('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Nyx/1.17.9 Chrome/156.0.0.0 Electron/45.3.2 Safari/537.36') === true,
  JSON.stringify({ leaks: true }),
);

check(
  '拿不到 chrome 版本时退回保守主版本，不抛错也不留空',
  chromeMajor('') === '156' && chromeMajor(undefined) === '156' && /^Mozilla\/5\.0/.test(normalUserAgent({ chromeVersion: '' })),
  JSON.stringify({ major: chromeMajor('') }),
);

// 3. 隐私模式拦 agent 读页面
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check(
  '隐私模式下 agent 的截图与读页面被直接拒绝，并说清"退出隐私模式再做"（P2）',
  /const PRIVATE_MODE_AGENT_BLOCKED = new Set\(\['screenshot', 'readPage'\]\)/.test(mainSrc) &&
    /PRIVATE_MODE_AGENT_BLOCKED\.has\(type\) && sessions\.getMode\(\) === 'private'/.test(mainSrc) &&
    /rule: 'private-mode'/.test(mainSrc) &&
    /退出隐私模式再做/.test(mainSrc),
  JSON.stringify({ blocked: true }),
);

// 4. 接线守卫
const tabsSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'tabs.js'), 'utf8');
check(
  '标签视图把普通模式 UA 接进了 webPreferences，且隐私模式不覆盖画像（P2）',
  /const \{ normalUserAgent \} = require\('\.\/user-agent'\)/.test(tabsSrc) &&
    /mode === 'private' \? \{\} : \{ userAgent: normalUserAgent\(\) \}/.test(tabsSrc),
  JSON.stringify({ wired: true }),
);

const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'http-api.js'), 'utf8');
check(
  '本地接口的 /health 带 Token 才给版本、Token 只认请求头（P2）',
  /const trusted = safeEqual\(probe, token\)/.test(apiSrc) &&
    /if \(trusted\) body\.version = version \|\| null;/.test(apiSrc) &&
    !/searchParams\.get\('token'\)/.test(apiSrc),
  JSON.stringify({ wired: true }),
);

const failed = checks.filter((c) => !c.ok);
console.log('');
if (failed.length) {
  console.log(`[验证] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
  for (const item of failed) console.log(`  · 失败项：${item.name}`);
  process.exitCode = 1;
} else {
  console.log(`[验证] 安全审计 P2 批次全部通过：共 ${checks.length} 项`);
}
