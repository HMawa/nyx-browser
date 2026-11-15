'use strict';

/**
 * 本地接口鉴权回归（安全审计 P2：/health 免鉴权泄版本号、Token 可走 URL）。
 *
 * 这一条不启动 Electron：startHttpApi() 只依赖注入进来的 token 与 dispatch，
 * 所以可以真起一个回环服务器，用真 HTTP 请求验证「带不带 Token 分别看到什么」。
 */

const assert = require('node:assert');
const path = require('node:path');

const { startHttpApi } = require(path.join(__dirname, '..', 'src', 'api', 'http-api.js'));
const { pickFreePort } = require(path.join(__dirname, 'lib', 'free-port.js'));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

async function main() {
  const TOKEN = 'a'.repeat(64);
  const VERSION = '9.9.9-test';
  const port = await pickFreePort();
  let modes = { mode: 'normal' };
  const server = await startHttpApi({
    token: TOKEN,
    version: VERSION,
    dispatch: async (action) => ({ ok: true, type: action && action.type, mode: modes.mode }),
    mode: {
      switchMode: async () => ({ ok: true }),
      events: () => ({}),
    },
    privacy: null,
    preferredPort: port,
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (pathname, headers) => {
    const res = await fetch(base + pathname, { headers: headers || {}, signal: AbortSignal.timeout(8000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };

  try {
    // 1. 不带 Token 的 /health：只说明"活着"，不给版本号
    const probe = await call('/health');
    check(
      '不带 Token 的 /health 只说活着，不泄露版本号（P2）',
      probe.status === 200 && probe.body && probe.body.ok === true && probe.body.name === 'Nyx' && !('version' in probe.body),
      JSON.stringify(probe.body),
    );

    // 2. 带对 Token 的 /health：给出真实版本号
    const probeAuthed = await call('/health', { 'x-nyx-token': TOKEN });
    check(
      '带对 Token 的 /health 才给真实版本号，不再是硬编码 0.1.0（P2）',
      probeAuthed.status === 200 && probeAuthed.body && probeAuthed.body.version === VERSION,
      JSON.stringify(probeAuthed.body),
    );

    // 3. 正常端点不带 Token → 401，且提示要放请求头
    const denied = await call('/state');
    check(
      '不带 Token 访问 /state 被拒，并说明 Token 要放在请求头（P2）',
      denied.status === 401 && denied.body && denied.body.ok === false && /x-nyx-token/.test(String(denied.body.error)),
      JSON.stringify(denied.body),
    );

    // 4. Token 放在 URL 里不再被接受（会进历史、日志、代理）
    const viaQuery = await call(`/state?token=${TOKEN}`);
    check(
      'Token 放在 URL 里不再被接受——URL 会进历史与日志（P2）',
      viaQuery.status === 401,
      JSON.stringify({ status: viaQuery.status }),
    );

    // 5. 带请求头 Token 才放行
    const allowed = await call('/state', { 'x-nyx-token': TOKEN });
    check(
      '带对请求头 Token 时正常放行（P2）',
      allowed.status === 200 && allowed.body && allowed.body.ok === true && allowed.body.type === 'state',
      JSON.stringify(allowed.body),
    );

    // 6. 错 Token 一样拒
    const wrong = await call('/state', { 'x-nyx-token': 'b'.repeat(64) });
    check('错 Token 一样被拒（P2）', wrong.status === 401, JSON.stringify({ status: wrong.status }));

    // 7. 静态守卫：接口模块里不许再出现 query 取 Token 或硬编码版本号
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'http-api.js'), 'utf8');
    check(
      '接口里不再有 ?token= 回退，也没有硬编码的 0.1.0（P2）',
      !/searchParams\.get\('token'\)/.test(src) && !/'0\.1\.0'/.test(src),
      JSON.stringify({ queryToken: /searchParams\.get\('token'\)/.test(src), hardVersion: /'0\.1\.0'/.test(src) }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length) {
    console.log(`[验证] 共 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
    for (const item of failed) console.log(`  · 失败项：${item.name}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[验证] 本地接口鉴权全部通过：共 ${checks.length} 项`);
}

main().catch((err) => {
  console.error('[验证] 本地接口鉴权回归失败：', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

/* 便于断言脚本自身被读到（与其它纯 Node 回归保持同样的导出习惯） */
module.exports = { main, assert };
