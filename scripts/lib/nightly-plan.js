'use strict';

/**
 * 夜间安装器 e2e 的"计划任务"那一层（纯逻辑，不碰系统）。
 *
 * 为什么单独拆出来：`schtasks` 的命令行拼错一个引号就会注册出一个"看起来有、其实跑不起来"
 * 的任务——这种错误最难发现，因为 `schtasks /Create` 会照样返回成功。
 * 所以把「参数怎么拼」与「输出怎么读」变成纯函数，让断言直接钉住，而不是靠人眼比。
 */

const DEFAULT_TASK_NAME = 'Nyx-Installer-E2E-Nightly';
const DEFAULT_TIME = '03:30';

/** 时间必须是 HH:MM（00:00–23:59）；写死成固定字符串是为了让 schtasks 不依赖系统区域格式 */
function normalizeTime(raw) {
  const text = String(raw || '').trim();
  const matched = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!matched) return DEFAULT_TIME;
  return `${String(Number(matched[1])).padStart(2, '0')}:${matched[2]}`;
}

/**
 * 拼 schtasks 的参数（数组形态，交给 spawnSync 直接传，不经过 shell 二次解释）。
 *
 * 默认**不要** /RL HIGHEST：加它需要管理员权限，普通用户直接拿到「错误: 拒绝访问。」
 * （要注册就得开一个提权终端，等于把这件事变成少数人才能做）。而安装器是 perMachine:false、
 * 装到用户目录，e2e 备份还原的也都是用户数据，普通权限就够——所以默认按普通权限注册，
 * 真需要提权的机器再用 --elevated 自己选。
 */
function buildRegisterArgs(input) {
  const node = String((input && input.node) || '').trim();
  const script = String((input && input.script) || '').trim();
  const taskName = String((input && input.taskName) || DEFAULT_TASK_NAME).trim() || DEFAULT_TASK_NAME;
  const time = normalizeTime(input && input.time);
  const elevated = Boolean(input && input.elevated);
  if (!node || !script) {
    return { ok: false, error: '注册计划任务需要 node 与脚本的完整路径（不能是相对路径）。' };
  }
  // schtasks 的 /TR 要把带空格的路径自己用引号包住，这里显式加，不指望 shell
  const tr = `"${node}" "${script}" --run`;
  const args = ['/Create', '/TN', taskName, '/SC', 'DAILY', '/ST', time, '/TR', tr];
  if (elevated) args.push('/RL', 'HIGHEST');
  args.push('/F');
  return { ok: true, taskName, time, tr, elevated, args };
}

/** 拼删除任务的参数 */
function buildDeleteArgs(input) {
  const taskName = String((input && input.taskName) || DEFAULT_TASK_NAME).trim() || DEFAULT_TASK_NAME;
  return { ok: true, taskName, args: ['/Delete', '/TN', taskName, '/F'] };
}

/**
 * 读 `schtasks /Query /TN <名字> /FO LIST` 的输出。
 * 三态说清楚：
 *   - 输出里说"找不到" → 明确判定没注册（registered:false）；
 *   - 命令本身报别的错、或输出看不懂 → ok:false（读不出来 ≠ 没注册）；
 *   - 读到 TaskName/下次运行时间 → 已注册。
 */
function parseQueryOutput(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, registered: false, error: 'schtasks 没有输出，读不出来。' };
  if (/错误:|ERROR:/.test(raw)) {
    const line = raw.split(/\r?\n/).find((item) => /错误:|ERROR:/.test(item)) || '';
    const missing = /找不到|does not exist|cannot find/i.test(line);
    return missing
      ? { ok: true, registered: false, nextRun: '', taskName: '' }
      : { ok: false, registered: false, error: `schtasks 报错：${line.trim() || '读不出原因'}` };
  }
  const field = (label) => {
    const matched = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, 'im').exec(raw);
    return matched ? matched[1].trim() : '';
  };
  const taskName = field('TaskName') || field('任务名');
  const nextRun = field('Next Run Time') || field('下次运行时间');
  const status = field('Status') || field('状态');
  if (!taskName && !nextRun) {
    return { ok: false, registered: false, error: '输出里读不到任务名，判断不了有没有注册。' };
  }
  return { ok: true, registered: true, taskName, nextRun, status };
}

/** 给用户看的一句话（注册成功 / 没注册 / 读不出来，三种不混） */
function describeTask(query, input) {
  const name = String((input && input.taskName) || DEFAULT_TASK_NAME);
  if (!query || query.ok !== true) {
    return {
      level: 'unknown',
      text: `查不出计划任务「${name}」的状态（${(query && query.error) || '未知原因'}）——这不等于没注册，只是这次没读到。`,
    };
  }
  if (!query.registered) {
    return {
      level: 'off',
      text: `计划任务「${name}」还没注册：夜间 e2e 不会自己跑。注册命令是 node scripts/nightly-e2e.js --register --apply。`,
    };
  }
  const next = query.nextRun ? `下次运行：${query.nextRun}` : '（系统没给下次运行时间）';
  return { level: 'on', text: `计划任务「${name}」已注册，${next}。` };
}

module.exports = {
  DEFAULT_TASK_NAME,
  DEFAULT_TIME,
  buildDeleteArgs,
  buildRegisterArgs,
  describeTask,
  normalizeTime,
  parseQueryOutput,
};
