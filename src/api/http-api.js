'use strict';

/**
 * 本地 AI 操作接口（HTTP）。
 *
 * 安全约束：
 *   1. 只监听 127.0.0.1，不接受外部网段连接；
 *   2. 非回环来源一律拒绝；
 *   3. 除 /health 外，所有请求必须携带正确的 Token（常量时间比较）。
 *
 * 端点：
 *   GET  /health                健康检查（免鉴权）
 *   GET  /state                 浏览器状态
 *   GET  /capabilities          能力清单
 *   POST /action                执行动作，body 为 { type, params }
 *   POST /mode/switch           切换模式，body 为 { mode: 'normal' | 'private' }
 *   GET  /mode/events           近期模式变更事件列表（内存环形缓冲，最近 50 条）
 *
 * /mode/switch 与 /mode/events 同样受 Token 鉴权保护，且只绑定 127.0.0.1，
 * 内部直接复用主进程的 switchMode() 全流程（代理探测 / 失败回滚 / Toast 通知），
 * 不包含任何旁路实现。
 */

const http = require('node:http');
const crypto = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/** 常量时间比较，避免 Token 被时序侧信道猜测 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 启动本地接口。
 * @param {object} options
 * @param {string} options.token 访问 Token
 * @param {{ run: (action: object) => Promise<object> }} options.runner 动作执行器
 * @param {object} [options.mode] 模式控制能力（由主进程注入，复用 switchMode 全流程）
 * @param {(mode: string) => Promise<{ok:boolean, code?:string, error?:string, state:object}>} options.mode.switch
 *        模式切换函数，返回值与主进程 switchMode() 一致
 * @param {() => Array<object>} options.mode.events 读取模式变更事件（内存环形缓冲快照）
 * @param {object} [options.privacy] 隐私观测能力（由主进程注入，只读）
 * @param {() => object} [options.privacy.status] 隐私现状快照（加固口径 / 出口画像 / 权限摘要 / 密码库统计）
 * @param {(limit:number) => object} [options.privacy.permissions] 权限决策轨迹
 * @param {string} [options.host] 监听地址，固定 127.0.0.1
 * @param {number} [options.preferredPort] 首选端口，被占用时自动改用随机端口
 * @param {(port: number) => void} [options.onPort] 监听成功回调，用于回写实际端口
 */
function startHttpApi({
  token,
  runner,
  mode,
  privacy,
  host = '127.0.0.1',
  preferredPort = 17321,
  onPort,
}) {
  const handler = async (req, res) => {
    // 来源校验：只接受回环连接
    const remote = req.socket.remoteAddress || '';
    if (!LOOPBACK.has(remote)) {
      return sendJson(res, 403, { ok: false, error: '仅允许本机访问' });
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: '非法请求路径' });
    }

    // 免鉴权端点
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, name: 'Nyx', version: '0.1.0', ts: Date.now() });
    }

    // Token 鉴权
    const provided = req.headers['x-nyx-token'] || url.searchParams.get('token') || '';
    if (!safeEqual(provided, token)) {
      return sendJson(res, 401, { ok: false, error: 'Token 无效' });
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      return sendJson(res, 200, await runner.run({ type: 'state' }));
    }

    if (url.pathname === '/capabilities' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        actions: [
          { type: 'navigate', params: { url: 'string' } },
          { type: 'screenshot', params: {} },
          { type: 'click', params: { selector: 'string', index: 'number?' } },
          { type: 'type', params: { selector: 'string', text: 'string', clear: 'boolean?', submit: 'boolean?' } },
          { type: 'executeJS', params: { code: 'string' } },
          { type: 'extractText', params: { selector: 'string?', maxLength: 'number?' } },
          { type: 'state', params: {} },
          { type: 'riskLog', params: { limit: 'number?', onlyBlocked: 'boolean?' } },
        ],
      });
    }

    if (url.pathname === '/action' && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
      const result = await runner.run(payload);
      return sendJson(res, result.ok ? 200 : 400, result);
    }

    // ---- 模式切换（供自动化测试驱动，复用主进程 switchMode 全流程）----

    if (url.pathname === '/mode/switch' && req.method === 'POST') {
      if (!mode || typeof mode.switch !== 'function') {
        return sendJson(res, 503, {
          ok: false,
          reason: 'MODE_API_UNAVAILABLE',
          message: '模式控制能力尚未就绪',
        });
      }

      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return sendJson(res, 400, {
          ok: false,
          reason: 'INVALID_JSON',
          message: '请求体不是合法 JSON',
        });
      }

      const requested = payload && typeof payload === 'object' ? payload.mode : undefined;
      if (requested !== 'normal' && requested !== 'private') {
        return sendJson(res, 400, {
          ok: false,
          reason: 'INVALID_MODE',
          message: "mode 字段必须是 'normal' 或 'private'",
        });
      }

      let result;
      try {
        result = await mode.switch(requested);
      } catch (err) {
        return sendJson(res, 500, {
          ok: false,
          reason: 'SWITCH_ERROR',
          message: err.message,
        });
      }

      if (result && result.ok === true) {
        // 以切换后的真实模式为准（switchMode 返回的 state 由 sessions 生成）
        const current = result.state && result.state.mode ? result.state.mode : requested;
        return sendJson(res, 200, { ok: true, mode: current });
      }

      // 失败：代理不可达 / 代理配置下发失败等，均原样透出错误码与用户提示文案
      return sendJson(res, 400, {
        ok: false,
        reason: (result && result.code) || 'SWITCH_FAILED',
        message: (result && result.error) || '模式切换失败',
      });
    }

    if (url.pathname === '/mode/events' && req.method === 'GET') {
      if (!mode || typeof mode.events !== 'function') {
        return sendJson(res, 503, {
          ok: false,
          reason: 'MODE_API_UNAVAILABLE',
          message: '模式事件缓冲尚未就绪',
        });
      }

      const events = mode.events() || [];
      return sendJson(res, 200, { ok: true, count: events.length, events });
    }

    // ---- 隐私现状（供验收脚本读取加固口径，只读）----

    if (url.pathname === '/privacy/status' && req.method === 'GET') {
      if (!privacy || typeof privacy.status !== 'function') {
        return sendJson(res, 503, {
          ok: false,
          reason: 'PRIVACY_API_UNAVAILABLE',
          message: '隐私状态能力尚未就绪',
        });
      }
      return sendJson(res, 200, privacy.status());
    }

    if (url.pathname === '/privacy/permissions' && req.method === 'GET') {
      if (!privacy || typeof privacy.permissions !== 'function') {
        return sendJson(res, 503, {
          ok: false,
          reason: 'PRIVACY_API_UNAVAILABLE',
          message: '权限审计能力尚未就绪',
        });
      }
      const limit = Number(url.searchParams.get('limit') || 0);
      return sendJson(res, 200, privacy.permissions(limit));
    }

    return sendJson(res, 404, { ok: false, error: '未找到该端点' });
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handler(req, res).catch((err) => {
        try {
          sendJson(res, 500, { ok: false, error: err.message });
        } catch {
          /* 忽略 */
        }
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // 首选端口被占用 → 换随机端口再试一次
        console.warn(`[Nyx] 端口 ${preferredPort} 已占用，改用随机端口`);
        server.listen(0, host);
        return;
      }
      reject(err);
    });

    server.on('listening', () => {
      const port = server.address().port;
      console.log(`[Nyx] 本地接口监听于 http://${host}:${port}`);
      if (typeof onPort === 'function') onPort(port);
      resolve(server);
    });

    // 只绑定回环地址，绝不对外暴露
    server.listen(preferredPort, host);
  });
}

module.exports = { startHttpApi };
