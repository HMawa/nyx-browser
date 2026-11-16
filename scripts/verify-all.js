'use strict';

/**
 * Nyx 一键回归：把四十三个验证脚本串成一条命令（npm run verify）。
 *
 * 依次执行：
 *  1. scripts/verify-address-suggest.js（地址栏建议，68 项）
 *  2. scripts/verify-ui-polish.js（界面体验，139 项）
 *  3. scripts/verify-link-guard.js（出站链路守卫，14 项；纯 Node，不启动 Electron）
 *  4. scripts/verify-downloads.js（下载链路，16 项；纯 Node，不启动 Electron）
 *  5. scripts/verify-gpu-policy.js（图形性能策略，14 项；纯 Node，不启动 Electron）
 *  6. scripts/verify-security-baseline.js（安全基线对照，20 项；纯 Node，不启动 Electron）
 *  7. scripts/verify-security-switches.js（外壳防护基线，19 项；纯 Node，不启动 Electron）
 *  8. scripts/verify-screen-watch.js（录屏 / 被远控检测，14 项；纯 Node，不启动 Electron）
 *  9. scripts/verify-agent-dispatch.js（agent 统一动作通道，20 项；纯 Node，不启动 Electron）
 * 10. scripts/verify-page-reader.js（页面读取与稳定元素 id，19 项；纯 Node，不启动 Electron）
 * 11. scripts/verify-agent-audit.js（agent 审计面与急停，17 项；纯 Node，不启动 Electron）
 * 12. scripts/verify-agent-sites.js（站点三层授权与名单导入导出，34 项；纯 Node，不启动 Electron）
 * 13. scripts/verify-agent-mode.js（agent 接入模式与两步确认，16 项；纯 Node，不启动 Electron）
 * 14. scripts/verify-page-digest.js（页面摘要、拦截统计与 Markdown / CSV 导出，26 项；纯 Node，不启动 Electron）
 * 15. scripts/verify-tab-lifecycle.js（标签生命周期判定，18 项；纯 Node，不启动 Electron）
 * 16. scripts/verify-tab-sleep.js（标签休眠与唤醒端到端，10 项）
 * 17. scripts/verify-network-state.js（断网判定与断网横幅，10 项；纯 Node，不启动 Electron）
 * 18. scripts/verify-page-cache.js（离线页面缓存、快照块结构、隐私加密、两份站点名单（含各自的导入导出、「只存这些」与自定义模板及其导入导出、名单是否真生效、模板「并进/替换」与同时套到普通模式），坏条目清理，67 项；纯 Node，不启动 Electron）
 * 19. scripts/verify-packaged-smoke.js（打包产物冒烟，11 项；dist\win-unpacked 不存在时跳过）
 * 20. scripts/verify-runtime-compat.js（运行时兼容：剪贴板异步化与版本三处一致，9 项；纯 Node，不启动 Electron）
 * 21. scripts/verify-release-gate.js（发版门禁、安装器 e2e 接线、验签挑包、差分命中率实测与过期判定、asar 差分结论、夜间 e2e 注册计划任务与状态卡、计划任务改时间/删任务的界面入口、发版后自动量差分，45 项；纯 Node，不跑安装包）
 * 22. scripts/verify-signing.js（安装包签名、密码存凭据管理器、证书有效期、签名状态进界面与打包接线，35 项；不看签名包时只跑静态守卫）
 * 23. scripts/verify-agent-settings.js（agent 改设置：白名单 / 锁死 / 确认 / 限流 / 多步撤销 / 场景预设 / 改动聚合视图与按时间筛选、CSV 导出 / 动作聚合（按类型与站点、被拦下单独报数）、动作记录也导出 CSV，34 项；纯 Node）
 * 24. scripts/verify-process-args.js（进程可辨识：命令行身份参数、进程表与 PID、不承诺改映像名，11 项；纯 Node，不启动 Electron）
 * 25. scripts/verify-toolbox-follow.js（网络面板跟随 / 锁定、锁定标签关掉后如实回退、每标签 500 条上限、关闭即释放监听，13 项；纯 Node，不启动 Electron）
 * 26. scripts/verify-agent-lamp.js（agent 三色状态灯：只在动作执行时算"正在被驱动"、审计缺口不混进灯、窄面板只给看与急停，11 项；纯 Node，不启动 Electron）
 * 27. scripts/verify-toolbar.js（工具栏：四个主路径固定、「更多」四项固定、小字标签开关、截图落点顺序、四处接线，10 项；纯 Node，不启动 Electron）
 * 28. scripts/verify-motion.js（动效档位：两档时长与缓动同源、减少动效时降级、按住有反馈、不做外发光，8 项；纯 Node，不启动 Electron）
 * 29. scripts/verify-onboard.js（首次安装引导：四种判定口径、选"先不定"不落盘、"全部默认"一步落盘、非法取值整组拒绝，10 项；纯 Node，不启动 Electron）
 * 30. scripts/verify-onboard-e2e.js（首次引导真机：全新安装弹一次、点默认后落盘并关窗、再启动与升级安装都不弹，7 项）
 * 31. scripts/verify-agent-doc.js（agent 接入说明：端点来自运行时、两种模式边界、会被拦下的四种情况、复制回读，9 项；纯 Node，不启动 Electron）
 * 32. scripts/verify-themes.js（主题：六套主题与枚举一一对应、新主题令牌齐全、对比度实算、不许有渐变、主题与显示分区，7 项；纯 Node，不启动 Electron）
 * 33. scripts/verify-shell-guard.js（外壳导航守卫：只许停在自己那份文档、网络地址与伪协议全拦、弹窗只放行 http(s)、不许内嵌 webview、接线与提示，13 项；纯 Node，不启动 Electron）
 * 34. scripts/verify-update-policy.js（更新通道准入：只许 https、本地目录必须显式确认、版本必须单调、缺 sha256 一律拒绝，10 项；纯 Node，不启动 Electron）
 * 35. scripts/verify-update-signature.js（更新签名：清单 Ed25519 签名往返、改任一受保护字段即失效、安装包六种验签结果、私钥不入库，17 项；纯 Node，不启动 Electron）
 * 36. scripts/verify-privacy-surface.js（隐私指纹面：加固脚本放进假页面世界真跑一遍核对 UA/语言/时区/Canvas/WebGL、显卡与字体统一上报值、CDP 五步顺序、userAgentMetadata、两个平台分开、完整版本号、语言去 q、Worker 版脚本与 Target.setAutoAttach 接管、文档就绪补打与接线可见，55 项；纯 Node，不启动 Electron）
 * 37. scripts/verify-ipc-guard.js（IPC 发送方校验：只认同项目 renderer 下的 html、子框架与网络地址全拒、三个注册口都被包上、页面上下文通道单独列，10 项；纯 Node，不启动 Electron）
 * 38. scripts/verify-http-api-auth.js（本地接口鉴权：只认请求头 token、查询串不再接受、无 token 的 health 不泄露版本，7 项；纯 Node，不启动 Electron）
 * 39. scripts/verify-audit-p2.js（安全审计 P2 批次：隐私模式 agent 内容边界、state 只读豁免、截图重试、密码框 name 抹除、limits 传参、设置只读不确认、MCP 参数转发，14 项；纯 Node，不启动 Electron）
 * 40. scripts/verify-permissions.js（站点设备授权白名单：设备项拆分、来源只收 http(s)、三档授权、隐私模式封死、撤销/清空与接线，22 项；纯 Node，不启动 Electron）
 * 41. scripts/verify-switch-cache.js（模式切换缓存：代理可达 30 秒、出口取不到 60 秒内复用、时钟回拨不认、计时文案点名最慢一步，以及主进程真的接上了，21 项；纯 Node，不启动 Electron）
 * 42. scripts/verify-tab-park.js（标签停靠：切模式不再销毁标签、视图摘下但不关页面、恢复按原顺序挂回、超出 12 个降级成只记地址并当面告知，12 项；纯 Node，不启动 Electron）
 * 43. scripts/verify-transition.js（切换动画：牛奶桶素材有效、页面无外联、时长与格子有上下限、减少动效降级、透明子窗口不抢焦点不开沙箱口子、开关默认开且可关，18 项；纯 Node，不启动 Electron）
 *
 * 行为约定：
 *   - 每个脚本跑在独立子进程里，stdio 直通（输出不捕获、不吞），一个失败不影响后续；
 *   - 跑每个脚本前先清理本仓库遗留的 Electron 进程，避免上一轮窗口占着单实例锁；
 *     只按「可执行文件完整路径」精确匹配本仓库的两个 exe：
 *       <仓库>\node_modules\electron\dist\electron.exe
 *       <仓库>\dist\win-unpacked\Nyx.exe
 *     **绝不**按进程名杀，因此不会误杀已安装的 D:\Nyx\Nyx.exe、VSCode、Trae 等。
 *   - 最后输出中文汇总，任一脚本失败 → 总退出码 1；全部通过（或有跳过）→ 0。
 *
 * 用法：
 *   npm run verify
 *   node scripts/verify-all.js
 *
 * 零第三方依赖，只用 Node 内置模块 + 系统自带 PowerShell（取进程路径）与 taskkill。
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** 本仓库允许清理的两个 Electron 可执行文件（完整路径精确匹配） */
const OWN_EXECUTABLES = [
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  path.join(ROOT, 'dist', 'win-unpacked', 'Nyx.exe'),
].map((p) => path.resolve(p));

/** 回归步骤：顺序、各自超时（留足余量，正常耗时约 40s / 40s / 5s / 20s） */
const STEPS = [
  {
    label: '地址栏建议回归',
    script: 'verify-address-suggest.js',
    items: '68 项',
    timeoutMs: 240000,
  },
  {
    label: '界面体验回归',
    script: 'verify-ui-polish.js',
    items: '139 项',
    timeoutMs: 360000,
  },
  {
    label: '出站链路守卫',
    script: 'verify-link-guard.js',
    items: '14 项',
    timeoutMs: 60000,
  },
  {
    label: '下载链路回归',
    script: 'verify-downloads.js',
    items: '16 项',
    timeoutMs: 60000,
  },
  {
    label: '图形性能策略',
    script: 'verify-gpu-policy.js',
    items: '14 项',
    timeoutMs: 60000,
  },
  {
    label: '安全基线对照',
    script: 'verify-security-baseline.js',
    items: '20 项',
    timeoutMs: 60000,
  },
  {
    label: '外壳防护基线',
    script: 'verify-security-switches.js',
    items: '19 项',
    timeoutMs: 60000,
  },
  {
    label: '录屏检测回归',
    script: 'verify-screen-watch.js',
    items: '14 项',
    timeoutMs: 60000,
  },
  {
    label: '动作通道回归',
    script: 'verify-agent-dispatch.js',
    items: '24 项',
    timeoutMs: 60000,
  },
  {
    label: '页面读取回归',
    script: 'verify-page-reader.js',
    items: '22 项',
    timeoutMs: 60000,
  },
  {
    label: 'agent 审计回归',
    script: 'verify-agent-audit.js',
    items: '17 项',
    timeoutMs: 60000,
  },
  {
    label: 'agent 站点授权回归',
    script: 'verify-agent-sites.js',
    items: '36 项',
    timeoutMs: 60000,
  },
  {
    label: 'agent 接入模式回归',
    script: 'verify-agent-mode.js',
    items: '16 项',
    timeoutMs: 60000,
  },
  {
    label: '页面摘要回归',
    script: 'verify-page-digest.js',
    items: '26 项',
    timeoutMs: 60000,
  },
  {
    label: '标签生命周期回归',
    script: 'verify-tab-lifecycle.js',
    items: '18 项',
    timeoutMs: 60000,
  },
  {
    label: '标签休眠回归',
    script: 'verify-tab-sleep.js',
    items: '10 项',
    timeoutMs: 240000,
  },
  {
    label: '断网判定回归',
    script: 'verify-network-state.js',
    items: '10 项',
    timeoutMs: 60000,
  },
  {
    label: '离线页面缓存',
    script: 'verify-page-cache.js',
    items: '67 项',
    timeoutMs: 60000,
  },
  {
    label: '运行时兼容',
    script: 'verify-runtime-compat.js',
    items: '9 项',
    timeoutMs: 60000,
  },
  {
    label: '发版门禁接线',
    script: 'verify-release-gate.js',
    items: '45 项',
    timeoutMs: 60000,
  },
  {
    label: '代码签名',
    script: 'verify-signing.js',
    items: '35 项',
    timeoutMs: 60000,
    /** 没打签名包时只跑静态守卫（脚本自己会打印「跳过真实签名检查」） */
    args: ['--no-artifact'],
  },
  {
    label: 'agent 改设置回归',
    script: 'verify-agent-settings.js',
    items: '34 项',
    timeoutMs: 60000,
  },
  {
    label: '打包产物冒烟',
    script: 'verify-packaged-smoke.js',
    items: '12 项',
    timeoutMs: 240000,
    /** 依赖解包产物：不存在就跳过（跳过不算失败） */
    requires: path.join(ROOT, 'dist', 'win-unpacked', 'Nyx.exe'),
    skipHint: '请先 npm run dist:dir',
  },
  {
    label: '进程可辨识回归',
    script: 'verify-process-args.js',
    items: '11 项',
    timeoutMs: 60000,
  },
  {
    label: '网络面板跟随回归',
    script: 'verify-toolbox-follow.js',
    items: '13 项',
    timeoutMs: 60000,
  },
  {
    label: 'agent 状态灯回归',
    script: 'verify-agent-lamp.js',
    items: '11 项',
    timeoutMs: 60000,
  },
  {
    label: '工具栏回归',
    script: 'verify-toolbar.js',
    items: '10 项',
    timeoutMs: 60000,
  },
  {
    label: '动效档位回归',
    script: 'verify-motion.js',
    items: '8 项',
    timeoutMs: 60000,
  },
  {
    label: '首次引导回归',
    script: 'verify-onboard.js',
    items: '10 项',
    timeoutMs: 60000,
  },
  {
    label: '首次引导 e2e',
    script: 'verify-onboard-e2e.js',
    items: '7 项',
    timeoutMs: 240000,
  },
  {
    label: 'agent 接入说明回归',
    script: 'verify-agent-doc.js',
    items: '9 项',
    timeoutMs: 60000,
  },
  {
    label: '主题回归',
    script: 'verify-themes.js',
    items: '7 项',
    timeoutMs: 60000,
  },
  {
    label: '外壳导航守卫回归',
    script: 'verify-shell-guard.js',
    items: '13 项',
    timeoutMs: 60000,
  },
  {
    label: '更新通道准入回归',
    script: 'verify-update-policy.js',
    items: '10 项',
    timeoutMs: 60000,
  },
  {
    label: '更新签名回归',
    script: 'verify-update-signature.js',
    items: '17 项',
    timeoutMs: 60000,
  },
  {
    label: '隐私指纹面回归',
    script: 'verify-privacy-surface.js',
    items: '55 项',
    timeoutMs: 60000,
  },
  {
    label: 'IPC 发送方校验回归',
    script: 'verify-ipc-guard.js',
    items: '10 项',
    timeoutMs: 60000,
  },
  {
    label: '本地接口鉴权回归',
    script: 'verify-http-api-auth.js',
    items: '7 项',
    timeoutMs: 60000,
  },
  {
    label: '安全审计 P2 批次回归',
    script: 'verify-audit-p2.js',
    items: '14 项',
    timeoutMs: 60000,
  },
  {
    label: '站点设备权限回归',
    script: 'verify-permissions.js',
    items: '22 项',
    timeoutMs: 60000,
  },
  {
    label: '模式切换缓存回归',
    script: 'verify-switch-cache.js',
    items: '21 项',
    timeoutMs: 60000,
  },
  {
    label: '标签停靠回归',
    script: 'verify-tab-park.js',
    items: '12 项',
    timeoutMs: 60000,
  },
  {
    label: '切换动画回归',
    script: 'verify-transition.js',
    items: '18 项',
    timeoutMs: 60000,
  },
];

function nowMs() {
  return Date.now();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 取进程列表（PID / 名称 / 完整路径）。
 * 用 PowerShell 的 Win32_Process 拿 ExecutablePath；结果用 Base64(UTF8) 回传，
 * 避免控制台代码页把路径里的中文毁掉。取不到就返回空数组 —— 宁可不清理，也不按名字乱杀。
 */
function listProcesses() {
  const command = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='electron.exe' or Name='Nyx.exe'\" | Select-Object ProcessId, Name, ExecutablePath)",
    'if ($procs.Count -gt 0) {',
    '  $json = ConvertTo-Json -InputObject $procs -Compress',
    '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    '}',
  ].join('\n');

  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];

  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!line) return [];
  try {
    const parsed = JSON.parse(Buffer.from(line, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * 结束本仓库遗留的 Electron 进程。
 * 只匹配完整路径（大小写不敏感），绝不按进程名杀，避免误伤安装版与其他 Electron 应用。
 */
function cleanupLeftovers(tag) {
  const allow = new Set(OWN_EXECUTABLES.map((p) => p.toLowerCase()));
  const killed = [];

  for (const proc of listProcesses()) {
    const exePath = String(proc.ExecutablePath || '');
    if (!exePath) continue;
    if (!allow.has(path.resolve(exePath).toLowerCase())) continue;
    const pid = Number(proc.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    // /T 连带子孙进程（renderer / gpu / utility），/F 强制结束
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15000,
    });
    killed.push(`${proc.Name}(${pid})`);
  }

  if (killed.length) {
    console.log(`[回归] ${tag}：已清理本仓库残留进程 ${killed.join('、')}`);
  }
  return killed.length;
}

function runStep(step, index, total) {
  const first = runStepOnce(step, index, total);
  if (first.status === 'passed' || first.status === 'skipped') return first;
  if (first.reason === '脚本不存在' || first.reason.startsWith('超时（')) return first;

  // 一次重试，只为把「环境抖动」和「功能真的坏了」分开。
  //
  // 有实测依据：本机可用物理内存掉到 3 GB 上下时，第二个启动 Electron 的步骤
  // 会偶发 `CDP 调用超时：Runtime.enable / Runtime.evaluate`（同一脚本单跑必过，
  // 换台机器/隔几分钟也必过）。命令串本身没变、断言一条没动——重试一次还红，
  // 就按真失败报，绝不把两次失败说成通过。
  console.log('');
  console.log(`[回归] [${index}/${total}] 首次失败（${first.reason}），干净环境重试一次`);
  const second = runStepOnce(step, index, total);
  if (second.status === 'passed') {
    return { status: 'passed', ms: first.ms + second.ms, reason: '', retried: true };
  }
  return { status: 'failed', ms: first.ms + second.ms, reason: `重试后仍失败：${second.reason}`, retried: true };
}

function runStepOnce(step, index, total) {
  const scriptPath = path.join(__dirname, step.script);
  console.log('');
  console.log(`[回归] [${index}/${total}] ${step.label}（scripts/${step.script}，${step.items}）`);

  if (!fs.existsSync(scriptPath)) {
    console.log(`[回归] [${index}/${total}] 失败：脚本不存在 ${scriptPath}`);
    return { status: 'failed', ms: 0, reason: '脚本不存在' };
  }

  // 上一轮残留的窗口会占用单实例锁 / 端口，先清干净再跑
  cleanupLeftovers(`[${index}/${total}] 前置清理`);

  const started = nowMs();
  // stdio 直通：子脚本的输出原样打到当前控制台，方便定位失败项
  const result = spawnSync(process.execPath, [scriptPath].concat(Array.isArray(step.args) ? step.args : []), {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: step.timeoutMs,
    windowsHide: false,
    env: process.env,
  });
  const ms = nowMs() - started;

  // 无论成败都再清一次，避免子脚本异常退出留下 Electron 进程
  cleanupLeftovers(`[${index}/${total}] 收尾清理`);

  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { status: 'failed', ms, reason: `超时（${Math.round(step.timeoutMs / 1000)}s）` };
  }
  if (result.error) {
    return { status: 'failed', ms, reason: `启动失败：${result.error.message}` };
  }
  if (result.signal) {
    return { status: 'failed', ms, reason: `被信号 ${result.signal} 结束` };
  }
  if (result.status !== 0) {
    return { status: 'failed', ms, reason: `退出码 ${result.status}` };
  }
  return { status: 'passed', ms, reason: '' };
}

function main() {
  const totalStarted = nowMs();
  console.log('[回归] ===== Nyx 一键回归开始 =====');
  console.log(`[回归] 仓库：${ROOT}`);
  console.log(`[回归] 顺序执行 ${STEPS.length} 个验证脚本，单个失败不影响后续`);

  const results = [];
  for (let i = 0; i < STEPS.length; i += 1) {
    const step = STEPS[i];
    const index = i + 1;

    if (step.requires && !fs.existsSync(step.requires)) {
      console.log('');
      console.log(`[回归] [${index}/${STEPS.length}] ${step.label}（${step.items}）`);
      console.log(`[回归] [${index}/${STEPS.length}] 跳过：缺少 ${path.relative(ROOT, step.requires)}，${step.skipHint}`);
      results.push({ step, status: 'skipped', ms: 0, reason: step.skipHint });
      continue;
    }

    const outcome = runStep(step, index, STEPS.length);
    console.log(
      `[回归] [${index}/${STEPS.length}] ` +
        (outcome.status === 'passed'
          ? `通过（${formatDuration(outcome.ms)}）`
          : `失败：${outcome.reason}（${formatDuration(outcome.ms)}）`),
    );
    results.push({ step, ...outcome });
  }

  // 收尾：把整个回归过程中可能遗留的进程再清一遍
  cleanupLeftovers('最终清理');

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const elapsed = nowMs() - totalStarted;

  console.log('');
  console.log('[回归] ===== 汇总 =====');
  for (const r of results) {
    const mark = r.status === 'passed' ? '✔ 通过' : r.status === 'failed' ? '✘ 失败' : '— 跳过';
    const tail = r.status === 'passed' ? formatDuration(r.ms) : r.status === 'failed' ? `${r.reason}（${formatDuration(r.ms)}）` : r.reason;
    console.log(`  ${mark}  ${r.step.label.padEnd(8, ' ')}  ${r.step.items.padEnd(6, ' ')}  ${tail}`);
  }
  console.log('');
  console.log(
    `[回归] 共 ${results.length} 个脚本：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过，耗时 ${Math.round(elapsed / 1000)}s`,
  );

  if (failed > 0) {
    console.log('[回归] 结论：有脚本失败，见上方失败项输出。');
    process.exitCode = 1;
    return;
  }
  console.log('[回归] 结论：全部通过（跳过项需先构建解包产物）。');
  process.exitCode = 0;
}

main();
