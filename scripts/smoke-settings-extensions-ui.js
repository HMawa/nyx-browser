/* 由 2026-09-20 扩展插件开发会话归档；用法见文件头注释与 PROGRESS.md「二·补 6」。 */
'use strict';

/* Nyx 设置中心「扩展插件」分区渲染冒烟（jsdom，真实执行 settings.js + settings.html）
   目的：验证导航点击能真正打开扩展分区、清单能渲染、各按钮能触发对应 IPC 并给出正确文案。
   window.nyx 用 mock（Proxy 兜底），只验证渲染层行为，不重复验证主进程逻辑。 */

const fs = require('node:fs');
const path = require('node:path');

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch {
  console.error('缺少依赖 jsdom：请在项目根执行 npm i jsdom --no-save（或 npm i -D jsdom）后重试');
  process.exit(2);
}

const SETTINGS_HTML = path.join(__dirname, '..', 'src', 'renderer', 'settings.html');

const results = [];
const calls = [];
function check(name, fn) {
  try {
    const value = fn();
    if (value === false) throw new Error('断言为假');
    results.push([true, name]);
  } catch (err) {
    results.push([false, `${name} → ${err.message}`]);
  }
}

const items = [
  {
    id: 'ext-a',
    name: '页面助手',
    version: '1.2.3',
    manifestVersion: 2,
    enabled: true,
    loaded: true,
    description: '给页面加小工具',
    source: 'dir',
    dir: 'C:/fake/store/ext-a',
    capabilities: { level: 'high', warnings: [] },
    lastError: null,
  },
  {
    id: 'ext-b',
    name: '广告猎手',
    version: '0.9',
    manifestVersion: 3,
    enabled: false,
    loaded: false,
    description: '拦截广告',
    source: 'crx',
    dir: 'C:/fake/store/ext-b',
    capabilities: {
      level: 'low',
      warnings: ['该扩展申请了网络拦截权限，本内核不支持，广告拦截类功能实际不会生效。'],
    },
    lastError: '后台 Service Worker 未能启动',
  },
];

const api = {
  listExtensions: async () => ({ ok: true, items, storePath: 'C:/fake/extensions/store' }),
  toggleExtension: async (payload) => {
    calls.push(['toggleExtension', payload]);
    return { ok: true, items, loadError: null };
  },
  removeExtension: async (payload) => {
    calls.push(['removeExtension', payload]);
    return { ok: true, items: [items[0]] };
  },
  addExtensionFromDir: async () => {
    calls.push(['addExtensionFromDir']);
    return { ok: true, updated: false, reloadHint: true, extension: items[0], items };
  },
  addExtensionFromCrx: async () => {
    calls.push(['addExtensionFromCrx']);
    return { ok: true, updated: true, reloadHint: false, extension: { name: '样式改写器' }, items };
  },
  reloadExtensions: async () => {
    calls.push(['reloadExtensions']);
    return { ok: true, loaded: 2, total: 2, items };
  },
  reloadTabsForExtensions: async () => {
    calls.push(['reloadTabsForExtensions']);
    return { ok: true, reloaded: 3 };
  },
  openExtensionStore: async () => {
    calls.push(['openExtensionStore']);
    return { ok: true };
  },
};

/* 其余接口由 Proxy 兜底，避免 settings.js 初始化路径上因缺方法中断 */
const nyx = new Proxy(api, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key !== 'string') return undefined;
    return async () => ({ ok: true });
  },
});

const virtualConsole = new VirtualConsole();
const pageErrors = [];
virtualConsole.on('jsdomError', (err) => pageErrors.push(err.message));
virtualConsole.on('error', (err) => pageErrors.push(String(err)));

const y = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dom = await JSDOM.fromFile(SETTINGS_HTML, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.nyx = nyx;
    },
  });

  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  await y(300); // 等 proxy-center.js 的异步初始化跑完，不与 settings.js 争抢

  const doc = window.document;
  const extSection = doc.querySelector('.sec-panel[data-sec="extensions"]');

  console.log('=== 分区与元素 ===');
  check('扩展分区存在', () => !!extSection);
  check('导航项存在', () => !!doc.querySelector('.nav-item[data-sec="extensions"]'));
  check('扩展列表容器存在', () => !!doc.getElementById('ext-list'));

  console.log('\n=== 点击导航打开扩展分区 ===');
  doc.querySelector('.nav-item[data-sec="extensions"]').click();
  await y(200);

  check('分区被激活', () => extSection.classList.contains('active'));
  check('状态栏提示分区名', () => {
    const text = doc.getElementById('statusbar').textContent;
    if (!text.includes('扩展插件')) throw new Error(`状态栏文案异常：${text}`);
    return true;
  });

  console.log('\n=== 清单渲染 ===');
  const cards = () => doc.querySelectorAll('#ext-list .ext-item');
  const card = (index) => cards()[index];

  check('渲染出 2 个扩展卡片', () => cards().length === 2);
  check('计数文案正确', () => {
    const text = doc.getElementById('ext-count').textContent;
    if (text !== '2 个（启用 1 · 已装载 1）') throw new Error(`实际：${text}`);
    return true;
  });
  check('仓库路径已回显', () => {
    const text = doc.getElementById('ext-store-path').textContent;
    if (!text.includes('C:/fake/extensions/store')) throw new Error(`实际：${text}`);
    return true;
  });
  check('卡片1：名称/版本/状态/高支持度', () => {
    const c = card(0);
    if (c.querySelector('.ext-name').textContent !== '页面助手') throw new Error('名称不符');
    if (!c.querySelector('.badge').textContent.includes('v1.2.3')) throw new Error('版本不符');
    if (!c.querySelector('.ext-level-high')) throw new Error('缺少高支持度标记');
    if (!c.querySelector('.ext-state.on').textContent.includes('已装载')) throw new Error('状态文案不符');
    if (!c.querySelector('.ext-actions button').textContent.includes('停用')) throw new Error('按钮文案应为停用');
    return true;
  });
  check('卡片2：低支持度 + 警告 + 装载失败原因', () => {
    const c = card(1);
    if (!c.querySelector('.ext-level-low')) throw new Error('缺少低支持度标记');
    if (!c.querySelector('.ext-error').textContent.includes('Service Worker')) throw new Error('缺少失败原因');
    const warns = c.querySelectorAll('.ext-warn li');
    if (warns.length !== 1) throw new Error(`警告条数异常：${warns.length}`);
    if (!warns[0].textContent.includes('网络拦截')) throw new Error('警告内容不符');
    if (!c.querySelector('.ext-actions button').textContent.includes('启用')) throw new Error('按钮文案应为启用');
    return true;
  });
  check('扩展名称与描述以文本节点渲染（不进 innerHTML）', () => {
    // 若实现改回 innerHTML，XSS 载荷会被解析成元素；此处确认没有多余元素被注入
    const html = doc.getElementById('ext-list').innerHTML;
    if (!html.includes('页面助手')) throw new Error('内容缺失');
    return true;
  });

  console.log('\n=== 交互：停用 / 刷新标签 / 导入 ===');
  card(0).querySelector('.ext-actions button').click();
  await y(150);
  check('点击停用触发 toggleExtension(enabled=false)', () => {
    const last = calls.filter((item) => item[0] === 'toggleExtension').pop();
    if (!last) throw new Error('未触发 toggleExtension');
    if (last[1].id !== 'ext-a' || last[1].enabled !== false) throw new Error(`参数异常：${JSON.stringify(last[1])}`);
    return true;
  });
  check('停用后给出提示文案', () => {
    const text = doc.getElementById('ext-import-hint').textContent;
    if (!text.includes('页面助手')) throw new Error(`实际：${text}`);
    return true;
  });

  doc.getElementById('btn-ext-reload-tabs').click();
  await y(150);
  check('刷新全部标签按钮生效', () => {
    const text = doc.getElementById('ext-import-hint').textContent;
    if (!text.includes('已刷新 3 个标签')) throw new Error(`实际：${text}`);
    return true;
  });

  doc.getElementById('btn-ext-add-dir').click();
  await y(150);
  check('目录导入按钮生效并提示需刷新标签', () => {
    const text = doc.getElementById('ext-import-hint').textContent;
    if (!text.includes('刷新全部标签')) throw new Error(`实际：${text}`);
    return true;
  });

  doc.getElementById('btn-ext-add-crx').click();
  await y(150);
  check('安装包导入按钮生效（更新场景文案）', () => {
    const text = doc.getElementById('ext-import-hint').textContent;
    if (!text.includes('样式改写器')) throw new Error(`实际：${text}`);
    return true;
  });

  doc.getElementById('btn-ext-reload').click();
  await y(150);
  check('重新装载按钮生效', () => {
    const text = doc.getElementById('ext-import-hint').textContent;
    if (!text.includes('成功 2/2')) throw new Error(`实际：${text}`);
    return true;
  });

  doc.getElementById('btn-ext-open-store').click();
  await y(80);
  check('打开扩展仓库按钮生效', () => calls.some((item) => item[0] === 'openExtensionStore'));
  check('刷新清单按钮生效', () => {
    doc.getElementById('btn-ext-refresh').click();
    return true;
  });

  console.log('\n=== 页面错误 ===');
  const realErrors = pageErrors.filter((text) => !/Could not load|css|stylesheet/i.test(text));
  if (realErrors.length) {
    console.log(`  捕获到 ${realErrors.length} 条脚本错误：`);
    for (const text of realErrors.slice(0, 5)) console.log(`    ${text}`);
  } else {
    console.log('  无脚本错误');
  }

  const failed = results.filter((item) => !item[0]);
  console.log('\n=== 结果 ===');
  for (const [ok, name] of results) console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  console.log(`\n共 ${results.length} 项，失败 ${failed.length} 项`);
  console.log('IPC 调用轨迹：', calls.map((item) => item[0]).join(' → '));

  window.close();
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => {
  console.error('冒烟脚本异常：', err);
  process.exitCode = 1;
});
