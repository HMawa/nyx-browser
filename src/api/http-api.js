'use strict';

/**
 * 本地 AI 操作接口（HTTP）。
 *
 * 安全约束：
 *   1. 只监听 127.0.0.1，不接受外部网段连接；
 *   2. 非回环来源一律拒绝；
 *   3. 除 /health 的「存活探针」形态外，所有请求必须携带正确的 Token（常量时间比较）；
 *      Token 只认请求头 x-nyx-token，不再接受 ?token= ——放在 URL 里会进日志、进历史、进代理。
 *
 * 端点：
 *   GET  /health                存活探针（不带 Token 时只说"活着"，带对 Token 才给版本号）
 *   GET  /state                 浏览器状态
 *   GET  /capabilities          能力清单（含哪些动作必须人工确认）
 *   POST /action                执行动作，body 为 { type, params }
 *   POST /mode/switch           切换模式，body 为 { mode: 'normal' | 'private' }
 *   GET  /mode/events           近期模式变更事件列表（内存环形缓冲，最近 50 条）
 *
 * /mode/switch 与 /mode/events 同样受 Token 鉴权保护，且只绑定 127.0.0.1，
 * 内部直接复用主进程的 switchMode() 全流程（代理探测 / 失败回滚 / Toast 通知），
 * 不包含任何旁路实现。
 *
 * 动作一律交给统一通道 dispatch()（src/core/agent-dispatch.js）执行——
 * 本文件不得直接调用执行器，否则权限判定 / 人工确认 / 留痕 / 急停都会漏。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { CONFIRM_RULES, describeAction } = require('../core/agent-dispatch');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/** 动作被拒 / 被急停时的 HTTP 状态码（让调用方不必解析中文也能判断性质） */
const CODE_STATUS = {
  MISSING_TYPE: 400,
  UNKNOWN_ACTION: 400,
  ACTION_FAILED: 400,
  BAD_VALUE: 400,
  BODY_TOO_LARGE: 413,
  DENIED_BY_POLICY: 403,
  CONFIRM_REJECTED: 403,
  CONFIRM_TIMEOUT: 408,
  CONFIRM_UNAVAILABLE: 503,
  SESSION_STOPPED: 409,
  ABORTED: 409,
};

/** 请求体读失败时该回什么：超限是 413（带一句怎么办），其它才是"不是合法 JSON" */
function bodyErrorStatus(err) {
  return err && err.code === 'BODY_TOO_LARGE' ? 413 : 400;
}

function bodyErrorMessage(err) {
  if (err && err.code === 'BODY_TOO_LARGE') {
    return `${err.message}。把参数改小一点（比如缩小 executeJS 的 code），或者拆成几次调用。`;
  }
  return '请求体不是合法 JSON';
}

function statusFor(result) {
  if (result && result.ok === true) return 200;
  const code = result && result.code ? result.code : '';
  return CODE_STATUS[code] || 400;
}

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
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 超限要**回一句话**再停：直接 destroy 的话客户端只看到 fetch failed，
        // 分不清是"网断了"还是"body 太大"。这里记下超限，让上层回 413。
        tooLarge = true;
        chunks.length = 0;
        const error = new Error(`请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)} KB 上限`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        // 不再继续读，也不再写；把剩余数据丢掉，让响应能正常发出去
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * 启动本地接口。
 * @param {object} options
 * @param {string} options.token 访问 Token
 * @param {(action: object) => Promise<object>} options.dispatch 统一动作通道（唯一入口）
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
  version = '',
  dispatch,
  mode,
  privacy,
  host = '127.0.0.1',
  preferredPort = 17321,
  onPort,
}) {
  if (typeof dispatch !== 'function') {
    throw new Error('startHttpApi 需要统一动作通道 dispatch()：动作不能绕过权限判定与留痕');
  }

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

    // 存活探针：不鉴权也能知道"它活着"，但不泄版本号、不泄配置；
    // 带了正确 Token 才把真实版本号给出来（旧版这里硬编码 0.1.0，误导排障）。
    if (url.pathname === '/health') {
      const probe = req.headers['x-nyx-token'] || '';
      const trusted = safeEqual(probe, token);
      const body = { ok: true, name: 'Nyx', ts: Date.now() };
      if (trusted) body.version = version || null;
      return sendJson(res, 200, body);
    }

    // Token 鉴权：只认请求头。URL 里带 Token 会被历史、日志、代理各留一份。
    const provided = req.headers['x-nyx-token'] || '';
    if (!safeEqual(provided, token)) {
      return sendJson(res, 401, { ok: false, error: 'Token 无效（请放在 x-nyx-token 请求头里）' });
    }

    if (url.pathname === '/state' && req.method === 'GET') {
      return sendJson(res, 200, await dispatch({ type: 'state' }));
    }

    if (url.pathname === '/capabilities' && req.method === 'GET') {
      const schemas = {
        navigate: { url: 'string' },
        readPage: { maxText: 'number?', maxElements: 'number?' },
        screenshot: {},
        click: { elementId: 'string?', selector: 'string?', index: 'number?' },
        type: { elementId: 'string?', selector: 'string?', text: 'string', clear: 'boolean?', submit: 'boolean?' },
        executeJS: { code: 'string' },
        extractText: { selector: 'string?', maxLength: 'number?' },
        state: {},
        riskLog: { limit: 'number?', onlyBlocked: 'boolean?' },
        // 改设置：不传 key 就只读清单；undo 撤销、preset 套预设（预设同样逐项确认）
        settings: {
          key: 'string?',
          value: 'any?',
          confirm: 'boolean?',
          preset: 'string?',
          accepts: 'string[]?',
          undo: 'boolean?',
          steps: 'number?',
        },
      };
      return sendJson(res, 200, {
        ok: true,
        // 每个动作都标出是否强制人工确认（type / download 永远要确认，白名单不豁免）
        actions: Object.keys(schemas).map((type) => ({
          ...describeAction(type),
          params: schemas[type],
        })),
        confirmRules: CONFIRM_RULES,
        channel: 'agent-dispatch',
      });
    }

    if (url.pathname === '/action' && req.method === 'POST') {
      let payload;
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        return sendJson(res, bodyErrorStatus(err), { ok: false, code: err && err.code ? err.code : 'INVALID_JSON', error: bodyErrorMessage(err) });
      }
      const result = await dispatch(payload);
      return sendJson(res, statusFor(result), result);
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
      } catch (err) {
        return sendJson(res, bodyErrorStatus(err), {
          ok: false,
          reason: err && err.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
          message: bodyErrorMessage(err),
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
