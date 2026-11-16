'use strict';

/**
 * 站点设备授权白名单回归（正常模式三档授权 + 隐私模式封死）
 *
 * 纯 Node，不启动 Electron：
 *   1) 纯逻辑模块 permission-store.js 的拆分 / 收敛 / 持久化 / 撤销；
 *   2) PermissionManager 用假 Session 走一遍请求式与校验式回调；
 *   3) 主进程、预加载、设置页的接线（静态检查，防止"模块写了但没接上"）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const store = require(path.join(ROOT, 'src', 'core', 'permission-store.js'));
const {
  PermissionManager,
  NORMAL_BASELINE,
  PRIVATE_BASELINE,
} = require(path.join(ROOT, 'src', 'core', 'permissions.js'));

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✘ ${name}\n    ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✘ ${name}\n    ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeSession(storagePath) {
  return {
    storagePath,
    req: null,
    check: null,
    disp: null,
    dev: null,
    setPermissionRequestHandler(fn) {
      this.req = fn;
    },
    setPermissionCheckHandler(fn) {
      this.check = fn;
    },
    setDisplayMediaRequestHandler(fn) {
      this.disp = fn;
    },
    setDevicePermissionHandler(fn) {
      this.dev = fn;
    },
  };
}

function ask(session, permission, mediaTypes, url) {
  return new Promise((resolve) => {
    session.req({ getURL: () => url || 'https://example.com/page' }, permission, resolve, mediaTypes ? { mediaTypes } : {});
  });
}

/* ------------------------------------------------------------------ */
/* 一、纯逻辑：权限项拆分与来源收敛                                    */
/* ------------------------------------------------------------------ */

check('media 按 mediaTypes 拆成 camera / microphone，不会一次全放行', () => {
  assert(JSON.stringify(store.canonicalKeys('media', ['video'])) === '["camera"]', 'video 应只拆出 camera');
  assert(JSON.stringify(store.canonicalKeys('media', ['audio'])) === '["microphone"]', 'audio 应只拆出 microphone');
  assert(
    JSON.stringify(store.canonicalKeys('media', ['audio', 'video'])) === '["microphone","camera"]',
    'audio+video 应拆出两项'
  );
});

check('没有 mediaTypes 的 media 请求按两项处理（宁可多问一次）', () => {
  const keys = store.canonicalKeys('media');
  assert(keys.includes('camera') && keys.includes('microphone'), `应包含两项，实际 ${keys.join(',')}`);
});

check('旧式 audioCapture / videoCapture / displayCapture 都能映射到设备项', () => {
  assert(store.canonicalKeys('audioCapture')[0] === 'microphone', 'audioCapture 应映射 microphone');
  assert(store.canonicalKeys('videoCapture')[0] === 'camera', 'videoCapture 应映射 camera');
  assert(store.canonicalKeys('displayCapture')[0] === 'screen', 'displayCapture 应映射 screen');
  assert(store.canonicalKeys('display-capture')[0] === 'screen', '带连字符的写法也要映射');
});

check('来源只收 http(s)，file / null / 垃圾地址一律拒绝', () => {
  assert(store.normalizeOrigin('https://Example.COM/a/b?x=1') === 'https://example.com', '应收敛到 origin 并小写主机');
  assert(store.normalizeOrigin('http://127.0.0.1:17342/probe.html') === 'http://127.0.0.1:17342', '应保留端口');
  for (const bad of ['file:///C:/x.html', 'null', '', 'not a url', 'javascript:alert(1)', 'https://']) {
    assert(store.normalizeOrigin(bad) === '', `${bad} 不应通过`);
  }
});

/* ------------------------------------------------------------------ */
/* 二、纯逻辑：白名单增删、合并、序列化                                */
/* ------------------------------------------------------------------ */

check('同一来源的授权取并集，不产生重复条目', () => {
  let entries = store.grantWhitelist([], 'https://a.com', ['camera'], 1000);
  entries = store.grantWhitelist(entries, 'https://a.com/x', ['microphone'], 2000);
  assert(entries.length === 1, `应只有 1 条，实际 ${entries.length}`);
  assert(entries[0].keys.length === 2, '应合并出两项权限');
  assert(entries[0].at === 2000, '时间应更新为最后一次');
});

check('不同来源各自成条，列表按时间倒序', () => {
  let entries = store.grantWhitelist([], 'https://a.com', ['camera'], 1000);
  entries = store.grantWhitelist(entries, 'https://b.com', ['microphone'], 2000);
  const list = store.listWhitelist(entries);
  assert(list.length === 2, '应有两条');
  assert(list[0].origin === 'https://b.com', '最近的应排前面');
  assert(list[0].labels.includes('麦克风'), '应带中文设备名');
});

check('白名单覆盖判定要求"这次请求的每一项"都在名单里', () => {
  const entries = store.grantWhitelist([], 'https://a.com', ['camera'], 1000);
  assert(store.isWhitelisted(entries, 'https://a.com', ['camera']) === true, '单项应命中');
  assert(store.isWhitelisted(entries, 'https://a.com', ['camera', 'microphone']) === false, '缺麦克风不应命中');
  assert(store.isWhitelisted(entries, 'https://b.com', ['camera']) === false, '别的来源不应命中');
  assert(store.isWhitelisted(entries, 'file:///C:/x', ['camera']) === false, '非 http(s) 不应命中');
});

check('撤销单项只去掉该项，撤销整个来源才删条目', () => {
  let entries = store.grantWhitelist([], 'https://a.com', ['camera', 'microphone'], 1000);
  entries = store.revokeWhitelist(entries, 'https://a.com', 'camera');
  assert(entries[0].keys.length === 1 && entries[0].keys[0] === 'microphone', '应只剩 microphone');
  entries = store.revokeWhitelist(entries, 'https://a.com');
  assert(entries.length === 0, '撤销整个来源后应清空');
});

check('序列化 → 解析可原样往返，且版本号写对', () => {
  const entries = store.grantWhitelist([], 'https://a.com', ['camera'], 1234);
  const text = store.serializeWhitelist(entries);
  const parsed = store.parseWhitelist(text);
  assert(parsed.error === '', `不应有错误：${parsed.error}`);
  assert(parsed.entries.length === 1 && parsed.entries[0].origin === 'https://a.com', '应还原出条目');
  assert(JSON.parse(text).v === store.STORE_VERSION, '应写版本号');
});

check('坏文件按空名单启动并给出错误，绝不当成"全部允许"', () => {
  const broken = store.parseWhitelist('{not json');
  assert(broken.entries.length === 0, '坏 JSON 应回空名单');
  assert(broken.error.includes('JSON'), `应说明是 JSON 问题，实际：${broken.error}`);
  const wrongShape = store.parseWhitelist('{"v":1,"entries":"nope"}');
  assert(wrongShape.entries.length === 0 && wrongShape.error, '结构不对也应回空名单 + 错误');
});

check('文件里的坏条目被丢弃，好条目保留', () => {
  const text = JSON.stringify({
    v: 1,
    entries: [
      { origin: 'file:///C:/x', keys: ['camera'], at: 1 },
      { origin: 'https://ok.com', keys: ['camera'], at: 2 },
      { origin: 'https://bad.com', keys: [], at: 3 },
    ],
  });
  const parsed = store.parseWhitelist(text);
  assert(parsed.entries.length === 1 && parsed.entries[0].origin === 'https://ok.com', '只应留 ok.com');
  assert(parsed.error.includes('2 条'), `应报告丢弃数量，实际：${parsed.error}`);
});

/* ------------------------------------------------------------------ */
/* 三、PermissionManager：请求式 / 校验式 / 模式隔离                   */
/* ------------------------------------------------------------------ */

(async () => {
  await checkAsync('正常模式选「始终允许」：写白名单，第二次直接放行且不再弹窗', async () => {
    const ses = fakeSession('p-normal-1');
    const prompts = [];
    let saved = null;
    const manager = new PermissionManager({
      whitelist: [],
      saveWhitelist: (entries) => {
        saved = entries;
      },
      prompt: async (ctx) => {
        prompts.push(ctx);
        return { granted: true, scope: 'always' };
      },
    });
    manager.attach(ses, 'normal');

    const first = await ask(ses, 'media', ['video']);
    assert(first === true, '第一次应允许');
    assert(prompts.length === 1, '应只弹一次');
    assert(prompts[0].keys.join(',') === 'camera', `弹窗应只请求 camera，实际 ${prompts[0].keys}`);
    assert(saved && saved.length === 1 && saved[0].keys[0] === 'camera', '应持久化 camera');
    assert(manager.whitelistEntries()[0].origin === 'https://example.com', '白名单应记录来源');

    const second = await ask(ses, 'media', ['video']);
    assert(second === true, '第二次应直接允许');
    assert(prompts.length === 1, '第二次不应再弹窗');
  });

  await checkAsync('重启后读回白名单：直接放行，不弹窗', async () => {
    const ses = fakeSession('p-normal-2');
    let prompted = 0;
    const manager = new PermissionManager({
      whitelist: store.grantWhitelist([], 'https://example.com', ['camera'], 1000),
      saveWhitelist: () => {},
      prompt: async () => {
        prompted += 1;
        return { granted: false, scope: 'deny' };
      },
    });
    manager.attach(ses, 'normal');
    const answer = await ask(ses, 'media', ['video']);
    assert(answer === true, '白名单内应直接允许');
    assert(prompted === 0, '不应弹窗');
  });

  await checkAsync('白名单只覆盖摄像头时，再要麦克风仍会问（不顺手放行）', async () => {
    const ses = fakeSession('p-normal-3');
    const prompts = [];
    const manager = new PermissionManager({
      whitelist: store.grantWhitelist([], 'https://example.com', ['camera'], 1000),
      saveWhitelist: () => {},
      prompt: async (ctx) => {
        prompts.push(ctx);
        return { granted: false, scope: 'deny' };
      },
    });
    manager.attach(ses, 'normal');
    const answer = await ask(ses, 'media', ['audio', 'video']);
    assert(answer === false, '麦克风未在白名单，应重新询问并拒绝');
    assert(prompts.length === 1, '应弹一次');
    assert(prompts[0].keys.includes('microphone'), '弹窗应包含 microphone');
  });

  await checkAsync('选「仅本次」：只写会话缓存，不写白名单', async () => {
    const ses = fakeSession('p-normal-4');
    let saved = null;
    const manager = new PermissionManager({
      whitelist: [],
      saveWhitelist: (entries) => {
        saved = entries;
      },
      prompt: async () => ({ granted: true, scope: 'once' }),
    });
    manager.attach(ses, 'normal');
    const answer = await ask(ses, 'media', ['video']);
    assert(answer === true, '本次应允许');
    assert(!saved || saved.length === 0, '不应写白名单');
    assert(manager.whitelistEntries().length === 0, '白名单应为空');
    const again = await ask(ses, 'media', ['video']);
    assert(again === true, '本会话第二次应命中缓存');
  });

  await checkAsync('隐私模式一律拒绝：不看白名单、不弹窗', async () => {
    const ses = fakeSession('p-private-1');
    let prompted = 0;
    const manager = new PermissionManager({
      whitelist: store.grantWhitelist([], 'https://example.com', ['camera'], 1000),
      saveWhitelist: () => {},
      prompt: async () => {
        prompted += 1;
        return { granted: true, scope: 'always' };
      },
    });
    manager.attach(ses, 'private');
    const answer = await ask(ses, 'media', ['video']);
    assert(answer === false, '隐私模式应拒绝');
    assert(prompted === 0, '隐私模式不应弹窗');
  });

  await checkAsync('校验式：询问类先给 false（避免提前暴露设备清单），全屏放行', async () => {
    const ses = fakeSession('p-check-1');
    const manager = new PermissionManager({ prompt: async () => ({ granted: true, scope: 'once' }) });
    manager.attach(ses, 'normal');
    assert(ses.check({}, 'media', 'https://example.com') === false, '未授权时 media 应 false');
    assert(ses.check({}, 'fullscreen', 'https://example.com') === true, '全屏基线应放行');
    assert(NORMAL_BASELINE.media === 'ask', '正常模式 media 基线应是 ask');
    assert(PRIVATE_BASELINE.fullscreen === 'allow', '隐私模式全屏应放行');
  });

  await checkAsync('私有分区即使拿到持久白名单，校验式也不会放行 media', async () => {
    const ses = fakeSession('p-private-2');
    const manager = new PermissionManager({
      whitelist: store.grantWhitelist([], 'https://example.com', ['camera'], 1000),
    });
    manager.attach(ses, 'private');
    assert(ses.check({}, 'media', 'https://example.com') === false, '隐私模式 media 必须 false');
    assert(ses.check({}, 'fullscreen', 'https://example.com') === true, '隐私模式全屏仍应放行');
  });

  await checkAsync('只允许摄像头不会连带放行麦克风（缓存与校验式都按设备拆）', async () => {
    const ses = fakeSession('p-split-1');
    let prompted = 0;
    const manager = new PermissionManager({
      saveWhitelist: () => {},
      prompt: async () => {
        prompted += 1;
        return prompted === 1 ? { granted: true, scope: 'once' } : { granted: false, scope: 'deny' };
      },
    });
    manager.attach(ses, 'normal');
    assert((await ask(ses, 'media', ['video'])) === true, '摄像头应允许');
    assert((await ask(ses, 'media', ['audio'])) === false, '麦克风不应被摄像头的授权连带放行');
    assert(prompted === 2, `麦克风应再问一次，实际弹窗 ${prompted} 次`);
    assert(ses.check({}, 'media', 'https://example.com', { mediaType: 'video' }) === true, '校验式摄像头应放行');
    assert(ses.check({}, 'media', 'https://example.com', { mediaType: 'audio' }) === false, '校验式麦克风应拒绝');
  });

  await checkAsync('撤销白名单后，下一次请求重新弹窗', async () => {
    const ses = fakeSession('p-normal-5');
    let prompted = 0;
    const manager = new PermissionManager({
      whitelist: store.grantWhitelist([], 'https://example.com', ['camera'], 1000),
      saveWhitelist: () => {},
      prompt: async () => {
        prompted += 1;
        return { granted: false, scope: 'deny' };
      },
    });
    manager.attach(ses, 'normal');
    assert((await ask(ses, 'media', ['video'])) === true, '撤销前应直接放行');
    const revoked = manager.revokeWhitelist('https://example.com', 'camera');
    assert(revoked.ok && revoked.entries.length === 0, '撤销应成功');
    assert((await ask(ses, 'media', ['video'])) === false, '撤销后应重新询问（本次拒绝）');
    assert(prompted === 1, '应重新弹一次');
  });

  /* ------------------------------------------------------------------ */
  /* 四、接线：模块写了必须真的接上                                      */
  /* ------------------------------------------------------------------ */

  check('主进程：启动时读白名单、原子写、IPC 三个入口齐全', () => {
    const main = read('src/main.js');
    assert(/loadPermissionWhitelist\(\)/.test(main), 'bootstrap 应读取白名单');
    assert(/permission-whitelist\.json/.test(main), '应落到 permission-whitelist.json');
    assert(/serializePermissionWhitelist/.test(main), '保存前应序列化');
    assert(/fs\.renameSync\(tmp, file\)/.test(main), '应原子写（临时文件 + 改名）');
    assert(/nyx:permissions:revoke/.test(main), '缺撤销 IPC');
    assert(/nyx:permissions:whitelist-clear/.test(main), '缺清空白名单 IPC');
    assert(/whitelist: manager\.whitelistEntries\(\)/.test(main), '权限视图应带白名单');
  });

  check('预加载与设置页：撤销 / 清空按钮真的接上', () => {
    const preload = read('src/preload.js');
    assert(/revokePermission:\s*\(origin, permission\)/.test(preload), 'preload 缺 revokePermission');
    assert(/clearPermissionWhitelist:\s*\(\)/.test(preload), 'preload 缺 clearPermissionWhitelist');
    const html = read('src/renderer/settings.html');
    for (const id of ['perm-whitelist-badge', 'perm-whitelist-wrap', 'btn-perm-whitelist-clear', 'perm-whitelist-hint']) {
      assert(html.includes(id), `设置页缺 #${id}`);
    }
    const settings = read('src/renderer/settings.js');
    assert(/function renderPermissionWhitelist\(view\)/.test(settings), '设置页缺渲染函数');
    assert(/renderPermissionWhitelist\(decisions\)/.test(settings), 'loadPrivacy 应调用渲染函数');
    assert(/clearPermissionWhitelist\(\)/.test(settings), '清空按钮应调 preload');
    assert(/revokePermission\(item\.origin\)/.test(settings), '撤销按钮应调 revokePermission');
  });

  console.log('');
  if (failed === 0) {
    console.log(`[Nyx] 站点设备授权白名单回归通过（${passed} 项）`);
    process.exit(0);
  }
  console.error(`[Nyx] 站点设备授权白名单回归未通过：${failed} 项失败 / 共 ${passed + failed} 项`);
  process.exit(1);
})();
