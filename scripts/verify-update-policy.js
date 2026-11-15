'use strict';

/**
 * 更新通道准入回归（安全审计 P0-2 第一阶段）
 *
 * 纯 Node，不启动 Electron：判定在 src/core/update-policy.js，
 * 另外静态核对更新器「缺 sha256 必须拒绝」这条改动真的落进了代码。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const policy = require(path.join(ROOT, 'src', 'core', 'update-policy.js'));

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// 1. https 放行（唯一无条件的远程源）
check('https 源直接放行', () => {
  const verdict = policy.decideUpdateSource('https://updates.example.com/nyx/');
  assert(verdict.ok === true, `应当放行：${verdict.code}`);
  assert(verdict.kind === 'https', `kind 应为 https，实际 ${verdict.kind}`);
});

// 2. http 明文拒绝，并给出可执行的原因
check('http 明文源拒绝（升级包会在路上被换掉）', () => {
  const verdict = policy.decideUpdateSource('http://updates.example.com/');
  assert(verdict.ok === false, '应当拒绝');
  assert(verdict.code === 'INSECURE_HTTP', `code 应为 INSECURE_HTTP，实际 ${verdict.code}`);
  assert(/https/.test(verdict.error), `说明里要给出替代做法：${verdict.error}`);
});

// 3. 本地目录 / UNC / file: 都要显式确认
check('本地目录必须先显式确认（不给确认就拒绝并说明代价）', () => {
  for (const source of ['D:\\Nyx-updates', 'D:/Nyx-updates', '\\\\nas\\nyx', 'file:///D:/Nyx-updates']) {
    const blocked = policy.decideUpdateSource(source);
    assert(blocked.ok === false, `${source} 未确认时应当拒绝`);
    assert(blocked.code === policy.LOCAL_ACK_CODE, `${source} 的 code 应为 ${policy.LOCAL_ACK_CODE}，实际 ${blocked.code}`);
    assert(blocked.needsLocalAck === true, `${source} 应当标出"需要确认"`);
    assert(/能写这个目录|换掉升级包/.test(blocked.error), `${source} 的说明要讲清代价：${blocked.error}`);

    const allowed = policy.decideUpdateSource(source, { allowLocal: true });
    assert(allowed.ok === true, `${source} 确认后应当放行：${allowed.code}`);
    assert(allowed.kind === 'local', `${source} 的 kind 应为 local，实际 ${allowed.kind}`);
  }
});

// 4. 空值与不认识的协议
check('空源与不认识的协议都拒绝', () => {
  const empty = policy.decideUpdateSource('   ');
  assert(empty.ok === false && empty.code === 'EMPTY', `空源应为 EMPTY，实际 ${empty.code}`);
  for (const source of ['ftp://x/y', 'javascript:alert(1)', 'data:text/plain,x']) {
    const verdict = policy.decideUpdateSource(source);
    assert(verdict.ok === false, `${source} 应当拒绝`);
    assert(verdict.code === 'UNSUPPORTED_SCHEME', `${source} 应为 UNSUPPORTED_SCHEME，实际 ${verdict.code}`);
  }
});

// 5. 版本单调：只允许真正的新版本
check('版本单调：更新的放行、同版本与降级都拒绝', () => {
  const newer = policy.decideUpdateVersion({ current: '1.17.9', next: '1.17.10' });
  assert(newer.ok === true && newer.code === 'NEWER', `应放行：${newer.code}`);
  const same = policy.decideUpdateVersion({ current: '1.17.9', next: '1.17.9' });
  assert(same.ok === false && same.code === 'SAME_VERSION', `同版本应拒绝：${same.code}`);
  const down = policy.decideUpdateVersion({ current: '1.17.9', next: '1.17.3' });
  assert(down.ok === false && down.code === 'DOWNGRADE', `降级应拒绝：${down.code}`);
  assert(/还旧/.test(down.error), `降级的说明要讲清原因：${down.error}`);
});

// 6. 读不懂的版本号与读不到的当前版本都不许当成"可以装"
check('版本号读不懂或当前版本未知时一律不更新', () => {
  const bad = policy.decideUpdateVersion({ current: '1.17.9', next: 'latest' });
  assert(bad.ok === false && bad.code === 'BAD_VERSION', `坏版本号应为 BAD_VERSION，实际 ${bad.code}`);
  const noNext = policy.decideUpdateVersion({ current: '1.17.9', next: '' });
  assert(noNext.ok === false && noNext.code === 'NO_VERSION', `缺版本号应为 NO_VERSION，实际 ${noNext.code}`);
  const noCur = policy.decideUpdateVersion({ current: '', next: '1.18.0' });
  assert(noCur.ok === false && noCur.code === 'CURRENT_UNKNOWN', `当前版本未知应为 CURRENT_UNKNOWN，实际 ${noCur.code}`);
});

// 7. 版本比较本身：三段数字 + 预发布后缀 + 坏输入
check('版本比较：三段数字、预发布后缀、坏输入返回 null', () => {
  assert(policy.compareVersion('1.17.9', '1.17.10') === -1, '1.17.9 应小于 1.17.10');
  assert(policy.compareVersion('2.0.0', '1.99.99') === 1, '2.0.0 应大于 1.99.99');
  assert(policy.compareVersion('v1.17.9', '1.17.9') === 0, '带 v 前缀应视为同版本');
  assert(policy.compareVersion('1.17.9', '1.17.9-beta.1') === 1, '正式版应大于预发布版');
  assert(policy.compareVersion('abc', '1.0.0') === null, '坏输入必须返回 null（不许猜）');
});

// 8. 更新器：缺 sha256 必须判失败（审计点名的"return true"已删）
check('更新器缺摘要就拒绝，不再"跳过校验"', () => {
  const source = read('src/core/updater.js');
  assert(!/跳过完整性校验/.test(source), '不应再出现「跳过完整性校验」的旧行为');
  assert(/if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(expected\)\)/.test(source), '缺摘要时必须走拒绝分支');
  assert(/Promise\.resolve\(false\)/.test(source), '拒绝时要返回 false');
  assert(/缺摘要的更新包不可信/.test(source), '日志要讲清原因');
});

// 9. 主进程接线：设源走准入，拒绝留痕，本地源有可见提示
check('主进程设源走准入：拒绝留痕、本地源给警告提示', () => {
  const main = read('src/main.js');
  assert(/decideUpdateSource/.test(main), 'main.js 应当调用 decideUpdateSource');
  assert(/UPDATE_SOURCE_REJECTED/.test(main), '缺 UPDATE_SOURCE_REJECTED 诊断码');
  assert(/needsLocalAck: Boolean\(verdict\.needsLocalAck\)/.test(main), '拒绝时要把"需要确认"回给界面');
  assert(/已改用本地更新源/.test(main), '本地源要有中文提示');
  const handler = main.slice(main.indexOf("ipcMain.handle('nyx:update:set-source'"));
  assert(/writeConfig\(\{\s*source: verdict\.source/.test(handler.slice(0, 900)), '写入的必须是准入后的地址');
});

// 10. 清单格式说明也改了（文档层面不能再写"缺失时不做校验"）
check('清单字段说明不再写「缺失时不做完整性校验」', () => {
  const source = read('src/core/updater.js');
  assert(!/缺失时不做完整性校验/.test(source), '文档注释要跟着改');
  assert(/缺失时拒绝安装|必须提供/.test(source), '应写明缺摘要就拒绝');
});

console.log('');
if (failed === 0) {
  console.log(`[Nyx] 更新通道准入回归通过（${passed} 项）`);
  process.exit(0);
}
console.error(`[Nyx] 更新通道准入回归未通过：${failed} 项失败 / 共 ${passed + failed} 项`);
process.exit(1);
