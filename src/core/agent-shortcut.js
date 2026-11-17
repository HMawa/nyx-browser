'use strict';

/**
 * agent 急停快捷键：候选顺序与结果描述（纯逻辑，零 Electron 依赖）。
 *
 * 为什么要候选：`CommandOrControl+Alt+X` 很容易被别的程序先占（本机就是），
 * 而急停是**安全功能**——注册失败还照旧告诉用户"快捷键是 Ctrl+Alt+X"，
 * 等于给了个按下去没反应的安全开关，比没有更糟。
 *
 * 所以：先试首选，再按顺序试备用，谁先成功就用谁；真全都失败才走"只有按钮"。
 */

/** 首选之后的备用键：都避开了输入法/截图/录屏常用的组合 */
const FALLBACK_SHORTCUTS = ['CommandOrControl+Alt+Shift+X', 'CommandOrControl+Shift+F12'];

/** 最多试几个（防止有人把候选列表写爆） */
const MAX_CANDIDATES = 4;

/**
 * 生成候选列表：首选在前，备用在后，去重、去空。
 * @param {string} preferred 首选（可来自环境变量 NYX_AGENT_STOP_SHORTCUT）
 * @param {string[]} [fallbacks]
 * @returns {string[]}
 */
function shortcutCandidates(preferred, fallbacks) {
  const list = [];
  const push = (raw) => {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (list.some((item) => item.toLowerCase() === lower)) return;
    list.push(text);
  };
  push(preferred);
  for (const item of Array.isArray(fallbacks) ? fallbacks : FALLBACK_SHORTCUTS) push(item);
  return list.slice(0, MAX_CANDIDATES);
}

/**
 * 把注册结果说成人话。
 * @param {{preferred:string, effective:string, tried:string[]}} input
 * @returns {{ok:boolean, code:string, message:string, notice:(null|{title:string,message:string})}}
 */
function describeShortcutResult(input) {
  const preferred = String((input && input.preferred) || '').trim();
  const effective = String((input && input.effective) || '').trim();
  const tried = Array.isArray(input && input.tried) ? input.tried : [];

  if (effective) {
    if (effective === preferred) {
      return {
        ok: true,
        code: 'PREFERRED',
        message: `agent 急停快捷键：${effective}`,
        notice: null,
      };
    }
    return {
      ok: true,
      code: 'FALLBACK',
      message: `首选快捷键 ${preferred || '（空）'} 被占用，改用 ${effective}`,
      notice: {
        title: `agent 急停改用 ${effective}`,
        message: `首选键 ${preferred || '（空）'} 已被其他程序占用，所以换成了 ${effective}。这个键按下就立刻停掉 agent。`,
      },
    };
  }

  return {
    ok: false,
    code: 'NONE',
    message: `agent 急停快捷键一个都注册不上（试过：${tried.join('、') || '无'}）`,
    notice: {
      title: '急停快捷键不可用',
      message: `试过的快捷键都被别的程序占着（${tried.join('、') || '无'}）。急停只能用工具栏上的按钮——它一直都在。`,
    },
  };
}

module.exports = {
  FALLBACK_SHORTCUTS,
  MAX_CANDIDATES,
  describeShortcutResult,
  shortcutCandidates,
};
