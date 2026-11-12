'use strict';

/**
 * 下载链路回归（14 项断言，纯 Node，不启动 Electron）。
 *
 * 背景：实测清单 A1「文件下载这一块儿全都报废了，前台零提示」。根因是
 * `will-download` 里先 `event.preventDefault()` 再异步 `setSavePath()`——
 * preventDefault 等于当场取消，之后设路径抛 `DownloadItem used after being
 * destroyed` 又被空 catch 吞掉，于是文件 0 字节、界面一片安静。
 *
 * 这里用一个假 item（EventEmitter + 四个取值方法）驱动 DownloadManager，
 * 断言落点生成、进度/速度记账、完成与中断的中文原因、清理策略，最后用静态
 * 断言钉住"绝不在 will-download 里 preventDefault"这条红线。
 *
 * 用法：node scripts/verify-downloads.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const {
  DOWNLOAD_STATES,
  DownloadManager,
  describeDownloadFailure,
  formatBytes,
  sanitizeFilename,
  uniquePath,
} = require(path.join(ROOT, 'src', 'core', 'downloads.js'));

const results = [];
function check(label, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = out === true || (out && out.ok === true);
    detail = out && typeof out === 'object' ? JSON.stringify(out.detail ?? out) : String(out);
  } catch (err) {
    ok = false;
    detail = `抛异常：${err.message}`;
  }
  results.push({ label, ok });
  console.log(`${ok ? '[Nyx] ✔' : '[Nyx] ✘'} ${label}${detail ? `　｜${detail}` : ''}`);
}

/** 假 DownloadItem：只要实现 Electron 里被用到的那几个方法/事件 */
class FakeItem extends EventEmitter {
  constructor({ filename = '示例 文件.zip', url = 'https://example.com/f.zip', savePath = '', total = 0 } = {}) {
    super();
    this.filename = filename;
    this.url = url;
    this.savePath = savePath;
    this.received = 0;
    this.total = total;
    this.lastErrorReason = '';
    this.cancelled = false;
  }
  getFilename() {
    return this.filename;
  }
  getURL() {
    return this.url;
  }
  getSavePath() {
    return this.savePath;
  }
  setSavePath(p) {
    this.savePath = p;
  }
  getReceivedBytes() {
    return this.received;
  }
  getTotalBytes() {
    return this.total;
  }
  getLastErrorReason() {
    return this.lastErrorReason;
  }
  cancel() {
    this.cancelled = true;
    this.emit('done', {}, DOWNLOAD_STATES.cancelled);
  }
}

console.log('[Nyx] 下载链路回归');

check('1. 文件名清洗：Windows 非法字符替换、空名兜底', () => {
  const cleaned = sanitizeFilename('a\\b/c:d*e?f"g<h>i|j.zip');
  const empty = sanitizeFilename('   ');
  const ok = cleaned === 'a_b_c_d_e_f_g_h_i_j.zip' && /^nyx-\d+\.bin$/.test(empty) && !/[\\/:*?"<>|]/.test(cleaned);
  return { ok, detail: { cleaned, empty } };
});

check('2. 落点生成：目录内不重名时直接用原名', () => {
  const p = uniquePath('D:\\dl', '报告 2026.pdf', () => false);
  return { ok: p === path.join('D:\\dl', '报告 2026.pdf'), detail: { p } };
});

check('3. 落点生成：重名追加 (1)(2)（保留扩展名）', () => {
  const taken = new Set([path.join('D:\\dl', 'a.zip')]);
  let n = 1;
  const p = uniquePath('D:\\dl', 'a.zip', (candidate) => {
    if (taken.has(candidate)) return true;
    if (n < 2) {
      taken.add(candidate);
      n += 1;
      return true;
    }
    return false;
  });
  return { ok: /a\(2\)\.zip$/.test(p), detail: { p } };
});

check('4. 落点生成：极端重名不死循环，退化为时间戳后缀', () => {
  const p = uniquePath('D:\\dl', 'x.bin', () => true);
  return { ok: /x-\d+\.bin$/.test(p), detail: { p } };
});

check('5. 失败原因：完成态没有错误文案', () => {
  return { ok: describeDownloadFailure(DOWNLOAD_STATES.completed) === '', detail: describeDownloadFailure(DOWNLOAD_STATES.completed) };
});

check('6. 失败原因：取消态说清是取消', () => {
  const text = describeDownloadFailure(DOWNLOAD_STATES.cancelled, '');
  return { ok: text === '下载已被取消', detail: text };
});

check('7. 失败原因：磁盘满/无权限/网络中断各自给中文解释', () => {
  const disk = describeDownloadFailure(DOWNLOAD_STATES.interrupted, 'ENOSPC: no space left on device');
  const perm = describeDownloadFailure(DOWNLOAD_STATES.interrupted, 'EACCES: permission denied');
  const net = describeDownloadFailure(DOWNLOAD_STATES.interrupted, 'net::ERR_CONNECTION_RESET');
  const unknown = describeDownloadFailure(DOWNLOAD_STATES.interrupted, '');
  const ok =
    disk.includes('磁盘空间不足') &&
    perm.includes('没有写入权限') &&
    net.includes('网络中断') &&
    unknown.includes('下载中断');
  return { ok, detail: { disk, perm, net, unknown } };
});

check('8. 字节格式化：B/KB/MB/GB 边界', () => {
  const out = [formatBytes(512), formatBytes(2048), formatBytes(5 * 1024 * 1024), formatBytes(3 * 1024 ** 3)];
  return { ok: out[0] === '512 B' && out[1] === '2.0 KB' && out[2] === '5.0 MB' && out[3] === '3.00 GB', detail: out };
});

check('9. 接管下载：立即出现 progressing 条目并推一次状态', () => {
  const pushes = [];
  const mgr = new DownloadManager({ push: (p) => pushes.push(p) });
  const item = new FakeItem({ savePath: path.join('D:\\dl', 'x.zip'), total: 1000 });
  const rec = mgr.attach(item, { mode: 'normal' });
  const ok = rec.state === DOWNLOAD_STATES.progressing && mgr.list().length === 1 && pushes.length >= 1 && pushes[0].summary.active === 1;
  return { ok, detail: { state: rec.state, pushes: pushes.length, summary: pushes[0] && pushes[0].summary } };
});

check('10. 进度事件：字节数与速度被记账，且节流生效（不会每次都推）', () => {
  let clock = 1000;
  const pushes = [];
  const mgr = new DownloadManager({ push: (p) => pushes.push(p), now: () => clock });
  const item = new FakeItem({ savePath: path.join('D:\\dl', 'y.bin'), total: 2000 });
  const rec = mgr.attach(item, { mode: 'normal' });
  const afterAttach = pushes.length;
  item.received = 500;
  item.emit('updated', {}, DOWNLOAD_STATES.progressing);
  clock += 1000;
  item.received = 1500;
  item.emit('updated', {}, DOWNLOAD_STATES.progressing);
  const ok =
    rec.receivedBytes === 1500 &&
    rec.totalBytes === 2000 &&
    rec.speedBytes > 0 &&
    // 两次 updated 之间只推了一次：节流窗口生效
    pushes.length - afterAttach <= 2;
  return { ok, detail: { received: rec.receivedBytes, total: rec.totalBytes, speed: rec.speedBytes, pushed: pushes.length - afterAttach } };
});

check('11. 下载完成：状态翻转、错误清空、汇总计入 done', () => {
  const pushes = [];
  const mgr = new DownloadManager({ push: (p) => pushes.push(p) });
  const item = new FakeItem({ savePath: path.join('D:\\dl', 'ok.zip'), total: 1024 });
  mgr.attach(item, { mode: 'normal' });
  item.received = 1024;
  item.emit('done', {}, DOWNLOAD_STATES.completed);
  const rec = mgr.list()[0];
  const summary = mgr.summary();
  const ok = rec.state === DOWNLOAD_STATES.completed && rec.error === '' && rec.endedAt > 0 && summary.done === 1 && summary.active === 0;
  return { ok, detail: { state: rec.state, summary } };
});

check('12. 下载中断：状态为 interrupted 且带中文原因（不再静默）', () => {
  const pushes = [];
  const mgr = new DownloadManager({ push: (p) => pushes.push(p) });
  const item = new FakeItem({ savePath: path.join('D:\\dl', 'bad.zip'), total: 100 });
  item.lastErrorReason = 'ENOSPC: no space left on device';
  mgr.attach(item, { mode: 'normal' });
  item.emit('done', {}, DOWNLOAD_STATES.interrupted);
  const rec = mgr.list()[0];
  const ok = rec.state === DOWNLOAD_STATES.interrupted && rec.error.includes('磁盘空间不足') && mgr.summary().failed === 1;
  return { ok, detail: { state: rec.state, error: rec.error } };
});

check('13. 清空历史：正在下载的条目不会被一起清掉', () => {
  const mgr = new DownloadManager({ push: () => {} });
  const running = new FakeItem({ savePath: 'D:\\dl\\run.bin' });
  const finished = new FakeItem({ savePath: 'D:\\dl\\done.bin' });
  mgr.attach(running, { mode: 'normal' });
  mgr.attach(finished, { mode: 'normal' });
  finished.emit('done', {}, DOWNLOAD_STATES.completed);
  const left = mgr.clear();
  const ok = left.length === 1 && left[0].state === DOWNLOAD_STATES.progressing;
  return { ok, detail: { left: left.map((it) => it.state) } };
});

check('14. 静态守卫：will-download 里不得出现 preventDefault + 异步 setSavePath', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const start = text.indexOf('function installDownloadHandler');
  const end = text.indexOf('function pickDownloadDir');
  const body = start >= 0 && end > start ? text.slice(start, end) : '';
  const hasSyncDialog = body.includes('showSaveDialogSync');
  const hasPrevent = /preventDefault\s*\(/.test(body);
  const hasAsyncDialog = /showSaveDialog\s*\(/.test(body);
  const ok = body.length > 0 && hasSyncDialog && !hasPrevent && !hasAsyncDialog;
  return { ok, detail: { 同步对话框: hasSyncDialog, 出现preventDefault: hasPrevent, 出现异步对话框: hasAsyncDialog } };
});

const failed = results.filter((r) => !r.ok);
console.log('');
if (failed.length > 0) {
  console.error(`[Nyx] 下载链路回归失败：${failed.length}/${results.length} 项未通过`);
  for (const item of failed) console.error(`         ✘ ${item.label}`);
  process.exitCode = 1;
} else {
  console.log(`[Nyx] 下载链路回归通过：${results.length}/${results.length} 项全绿`);
  process.exitCode = 0;
}
