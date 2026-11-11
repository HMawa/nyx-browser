#!/usr/bin/env node
'use strict';

/**
 * Nyx MCP 服务（stdio 传输）。
 *
 * 作用：把 Nyx 的本地 HTTP 接口包装成标准 MCP 工具，供 AI 客户端直接调用。
 * 前提：桌面端 Nyx 已在运行（本进程只做转发，不启动浏览器）。
 *
 * 启动：npm run mcp
 *
 * 运行参数解析优先级：
 *   1. 环境变量 NYX_TOKEN / NYX_API_PORT / NYX_API_HOST
 *   2. 桌面端写入的用户数据目录（api-token.txt / api-port.txt）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 推算 Electron 桌面端的 userData 目录（productName = Nyx） */
function resolveUserDataDir() {
  if (process.env.NYX_USER_DATA) return process.env.NYX_USER_DATA;
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Nyx');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Nyx');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Nyx');
  }
}

function readIfExists(file) {
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  } catch {
    /* 忽略 */
  }
  return '';
}

function resolveRuntime() {
  const dir = resolveUserDataDir();
  const token = process.env.NYX_TOKEN || readIfExists(path.join(dir, 'api-token.txt'));
  const port = process.env.NYX_API_PORT || readIfExists(path.join(dir, 'api-port.txt')) || '17321';
  const host = process.env.NYX_API_HOST || '127.0.0.1';
  return { token, port, host, baseUrl: `http://${host}:${port}` };
}

/** 调用桌面端本地接口 */
async function callApi(runtime, action) {
  if (!runtime.token) {
    throw new Error('未找到访问 Token，请先启动 Nyx 桌面端（Token 位于用户数据目录 api-token.txt）');
  }
  const response = await fetch(`${runtime.baseUrl}/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Nyx-Token': runtime.token,
    },
    body: JSON.stringify(action),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: '响应不是合法 JSON' }));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `接口返回 ${response.status}`);
  }
  return payload;
}

/** 统一把结果转成 MCP 文本内容 */
function toContent(payload) {
  const data = payload.data || {};
  // 截图返回 base64，单独以图片内容块返回，避免文本过长
  if (data.base64) {
    return {
      content: [
        { type: 'text', text: `截图成功：${data.width}x${data.height}（PNG）` },
        { type: 'image', data: data.base64, mimeType: 'image/png' },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * 工具注册兼容层。
 * SDK 1.10+ 使用 registerTool(name, config, handler)；
 * 更早版本使用 tool(name, description, inputSchema, handler)。两者都做兼容。
 */
function defineTool(server, name, config, handler) {
  if (typeof server.registerTool === 'function') {
    server.registerTool(name, config, handler);
    return;
  }
  if (typeof server.tool === 'function') {
    server.tool(name, config.description, config.inputSchema, handler);
    return;
  }
  throw new Error('当前 @modelcontextprotocol/sdk 版本不支持注册工具，请升级依赖');
}

async function main() {
  const runtime = resolveRuntime();

  // 兼容 ESM-only 依赖：动态 import
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  const server = new McpServer({ name: 'nyx-browser', version: '0.1.0' });

  const invoke = (action) => async () => {
    try {
      return toContent(await callApi(runtime, action));
    } catch (err) {
      return { content: [{ type: 'text', text: `调用失败：${err.message}` }], isError: true };
    }
  };

  defineTool(
    server,
    'nyx_navigate',
    {
      title: '导航',
      description: '让 Nyx 浏览器当前标签跳转到指定网址',
      inputSchema: { url: z.string().describe('目标网址，如 https://example.com') },
    },
    async ({ url }) => (await invoke({ type: 'navigate', params: { url } })()),
  );

  defineTool(
    server,
    'nyx_screenshot',
    {
      title: '截图',
      description: '截取 Nyx 当前标签的可视区域，返回 PNG 图片',
      inputSchema: {},
    },
    async () => (await invoke({ type: 'screenshot', params: {} })()),
  );

  defineTool(
    server,
    'nyx_click',
    {
      title: '点击元素',
      description: '按 CSS 选择器点击页面元素',
      inputSchema: {
        selector: z.string().describe('CSS 选择器'),
        index: z.number().optional().describe('多个匹配时取第几个，默认 0'),
      },
    },
    async ({ selector, index }) => (await invoke({ type: 'click', params: { selector, index } })()),
  );

  defineTool(
    server,
    'nyx_type',
    {
      title: '输入文字',
      description: '向输入框或可编辑区域写入文字，可选回车提交',
      inputSchema: {
        selector: z.string().describe('CSS 选择器'),
        text: z.string().describe('要输入的文字'),
        clear: z.boolean().optional().describe('是否先清空原内容，默认 true'),
        submit: z.boolean().optional().describe('是否回车提交，默认 false'),
      },
    },
    async ({ selector, text, clear, submit }) =>
      (await invoke({ type: 'type', params: { selector, text, clear, submit } })()),
  );

  defineTool(
    server,
    'nyx_execute_js',
    {
      title: '执行 JavaScript',
      description: '在 Nyx 当前页面上下文执行 JavaScript 并返回结果',
      inputSchema: { code: z.string().describe('要执行的 JS 代码') },
    },
    async ({ code }) => (await invoke({ type: 'executeJS', params: { code } })()),
  );

  defineTool(
    server,
    'nyx_extract_text',
    {
      title: '提取正文',
      description: '提取 Nyx 当前页面的正文纯文本',
      inputSchema: {
        selector: z.string().optional().describe('可选：限定提取范围的 CSS 选择器'),
        maxLength: z.number().optional().describe('最大返回字符数，默认 20000'),
      },
    },
    async ({ selector, maxLength }) => (await invoke({ type: 'extractText', params: { selector, maxLength } })()),
  );

  defineTool(
    server,
    'nyx_state',
    {
      title: '浏览器状态',
      description: '读取 Nyx 当前模式、标签列表与活动标签',
      inputSchema: {},
    },
    async () => (await invoke({ type: 'state', params: {} })()),
  );

  defineTool(
    server,
    'nyx_risk_log',
    {
      title: '风控日志',
      description: '读取 Nyx 的连接审计日志（放行 / 阻断 / 异常）',
      inputSchema: {
        limit: z.number().optional().describe('返回条数，默认 100'),
        onlyBlocked: z.boolean().optional().describe('只返回被阻断或异常的连接'),
      },
    },
    async ({ limit, onlyBlocked }) => (await invoke({ type: 'riskLog', params: { limit, onlyBlocked } })()),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Nyx-MCP] 已启动，转发目标：${runtime.baseUrl}`);
}

main().catch((err) => {
  console.error('[Nyx-MCP] 启动失败：', err.message);
  process.exit(1);
});
