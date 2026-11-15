'use strict';

/**
 * agent 接入说明生成器（清单 D1）。
 *
 * 为什么要有这个文件：设置页上写着「内置模式 / 外部接入」，但真正要把别的 agent 接进来的人，
 * 需要的是「端点在哪、头怎么带、能做什么、做不到什么、出错了先看哪」——这些如果只写在文档里，
 * 用户还得先找到文档。所以由主进程按**当前真实状态**（端口、模式、急停、审计完整度）生成一份
 * 可直接粘贴给 agent 的说明。
 *
 * 三条硬口径：
 *   ① 端点与 Token 位置必须来自运行时，不能写死示例端口（写死会让人照着连不上）；
 *   ② 权限边界与审计边界必须写出来，且外部接入模式要明说"审计不完整"；
 *   ③ 急停状态、快捷键是否可用要如实反映——用户按了没反应时得知道去哪儿。
 */

const DOC_TITLE = 'Nyx · agent 接入说明';

const ACTION_LINES = [
  ['navigate', '打开网址', 'url'],
  ['readPage', '读页面里的可交互元素', '（可带 filter）'],
  ['screenshot', '截当前页面', ''],
  ['click', '点中某个元素', 'elementId'],
  ['type', '往输入框里输文字', 'elementId, text'],
  ['executeJS', '在页面里执行一段脚本', 'script'],
  ['extractText', '取页面正文', ''],
  ['state', '看标签状态', ''],
  ['settings', '改设置（可选 undo:true 撤销）', 'key, value'],
];

function normalizeOptions(raw) {
  const options = raw && typeof raw === 'object' ? raw : {};
  const port = Number(options.port);
  return {
    port: Number.isFinite(port) && port > 0 ? port : 0,
    tokenFile: String(options.tokenFile || ''),
    tokenHeader: String(options.tokenHeader || 'x-nyx-token'),
    mode: options.mode === 'external' ? 'external' : 'builtin',
    modeLabel: String(options.modeLabel || (options.mode === 'external' ? '外部接入（CDP）' : '内置（推荐）')),
    auditComplete: options.auditComplete !== false,
    stopped: options.stopped === true,
    stopShortcut: String(options.stopShortcut || ''),
    stopShortcutOk: options.stopShortcutOk !== false,
    cdpPort: Number(options.cdpPort) > 0 ? Number(options.cdpPort) : 0,
    allowCount: Number(options.allowCount) > 0 ? Number(options.allowCount) : 0,
  };
}

/**
 * 生成接入说明（Markdown）。返回值永远是完整形状，缺什么就如实写"没有"。
 */
function buildAgentDoc(rawOptions) {
  const opts = normalizeOptions(rawOptions);
  const lines = [];
  lines.push(`# ${DOC_TITLE}`);
  lines.push('');
  lines.push('这份说明由 Nyx 按当前状态生成，可以直接粘贴给你的 agent。');
  lines.push('');
  lines.push('## 1. 现在是什么接入方式');
  lines.push('');
  lines.push(`- 接入模式：**${opts.modeLabel}**`);
  if (opts.auditComplete) {
    lines.push('- 审计覆盖：完整（agent 的每个动作都经过 Nyx 的统一通道，可在「Agent 访问 → 动作留痕」里看到）');
  } else {
    lines.push('- 审计覆盖：**不完整**——外部接入下别的程序能直接驱动浏览器，Nyx 只看得见"经过浏览器的部分"');
  }
  lines.push(
    `- 急停：${opts.stopped ? '**已停止**（现在的动作一律被拒）' : '可以随时停止'}` +
      (opts.stopShortcut ? `｜快捷键 ${opts.stopShortcut}${opts.stopShortcutOk ? '' : '（本机注册失败，请用工具栏按钮）'}` : ''),
  );
  lines.push('');

  lines.push('## 2. 端点');
  lines.push('');
  if (opts.mode === 'external') {
    lines.push(
      opts.cdpPort
        ? `- CDP：\`http://127.0.0.1:${opts.cdpPort}\`（只监听回环地址；这是浏览器调试端口，**不要暴露到局域网或公网**）`
        : '- CDP：外部接入模式下会在启动时打开调试端口，重启后端口号写在 `agent-debug-port.txt`',
    );
    lines.push('- 说明：走 CDP 时下面第 3 节的统一动作通道**不参与**，审计也就只剩浏览器侧那一部分。');
  } else {
    lines.push('- MCP（推荐）：Nyx 自带 MCP 服务，stdio 启动后由它转发到下面的本地 HTTP 接口');
    lines.push(
      opts.port
        ? `- 本地 HTTP：\`http://127.0.0.1:${opts.port}\`（**只监听回环**，外部访问不到）`
        : '- 本地 HTTP：只在运行中可用，端口在启动日志与「设置 → Agent 访问」里能看到',
    );
    lines.push(`- 鉴权：每个请求都要带请求头 \`${opts.tokenHeader}: <token>\`${opts.tokenFile ? `，token 存在 \`${opts.tokenFile}\`` : ''}`);
    lines.push('- 不带 token 或 token 不对 → `401`，返回里会说是 token 问题，不是动作写错。');
  }
  lines.push('');

  lines.push('## 3. 能做什么');
  lines.push('');
  lines.push('| 动作 | 说明 | 参数 |');
  lines.push('| --- | --- | --- |');
  for (const [type, label, params] of ACTION_LINES) {
    lines.push(`| \`${type}\` | ${label} | ${params || '—'} |`);
  }
  lines.push('');
  lines.push('动作统一形容为 `{ "type": "...", ...参数 }`。`click` / `type` 要先 `readPage` 拿到 `elementId`，不要猜选择器。');
  lines.push('');

  lines.push('## 4. 会被拦下来的情况（重要）');
  lines.push('');
  lines.push('- **站点授权**：没进白名单的站点会先问你一次；进了屏蔽名单的一律拒绝（屏蔽优先于白名单）。');
  if (opts.allowCount > 0) lines.push(`- 当前白名单里有 ${opts.allowCount} 条站点规则。`);
  lines.push('- **动作级确认**：`type`（输入文字）与 `download`（下载）这类动作，即使站点在白名单里也要再确认一次。');
  lines.push('- **锁死设置**：接入模式、隐私链路、隐私模式快照开关、agent 站点名单、下载是否询问、GPU 策略这些键，agent 连问都不许改。');
  lines.push('- **急停**：被停止之后所有动作直接拒绝，直到你在界面上恢复。');
  lines.push('');

  lines.push('## 5. 出错了先看哪');
  lines.push('');
  lines.push('1. `401` → token 不对或没带请求头；token 在本地文件里，别猜。');
  lines.push('2. `403` / 被拒 → 看返回里的原因：站点被屏蔽、动作级确认没点、或者 agent 已被急停。');
  lines.push('3. "找不到元素" → 先 `readPage` 重新拿一遍 `elementId`（页面刷新后旧的 id 会失效）。');
  lines.push('4. 什么都没发生 → 检查是不是在隐私模式标签里（隐私模式下不写缓存，但动作照常；被拒绝会明确说）。');
  lines.push('');
  lines.push('## 6. 边界（请如实转告使用者）');
  lines.push('');
  lines.push('- 本地 HTTP 接口只监听 `127.0.0.1`，不要做端口转发或反代把它暴露出去。');
  lines.push('- 外部接入模式下审计不完整，这是设计上的取舍，不是暂时没做。');
  lines.push('- 隐私模式不落盘；普通模式按设置保存历史与缓存。');
  lines.push('');
  return lines.join('\n');
}

/** 文件名：固定、可预期，避免用户存一堆同名副本时认不出 */
function agentDocFilename(now) {
  const date = new Date(Number.isFinite(now) ? now : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `Nyx-agent接入说明-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

module.exports = {
  ACTION_LINES,
  DOC_TITLE,
  agentDocFilename,
  buildAgentDoc,
  normalizeOptions,
};
