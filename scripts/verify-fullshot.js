/**
 * 整页长截图（M3）的纯逻辑回归。
 *
 * 这里不启动 Electron：真正截图要用 CDP，必须起窗口；而"能不能截、截多大、
 * 怎么交代截断"这些判断全在 `src/core/fullshot.js` 里，纯算术。
 *
 * 最后两组是静态守卫：一是量尺寸脚本必须只读（不写 DOM、不发请求），
 * 二是主进程那条通道必须"先弹保存框再截图""只有自己挂的调试通道才摘"。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  MAX_HEIGHT,
  MAX_PIXELS,
  MAX_WIDTH,
  buildMetricsScript,
  describeFullshot,
  fullshotFilename,
  humanPixels,
  planFullshot,
} = require('../src/core/fullshot');

const ROOT = path.join(__dirname, '..');
const checks = [];

async function check(label, fn) {
  try {
    await fn();
    checks.push({ ok: true, label });
    console.log(`✔ ${label}`);
  } catch (err) {
    checks.push({ ok: false, label, error: err && err.message ? err.message : String(err) });
    console.log(`✘ ${label}｜${err && err.message ? err.message : err}`);
  }
}

function readFile(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

async function main() {
  await check('量得出尺寸时装得下单张长图，不截断（M3）', async () => {
    const plan = planFullshot({ width: 1280, height: 3200, hasContent: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.width, 1280);
    assert.equal(plan.height, 3200);
    assert.equal(plan.capped, false);
    assert.equal(plan.note, '');
    assert.equal(plan.pixels, 1280 * 3200);
  });

  await check('页面太高时截到上限并如实说截到多少（M3）', async () => {
    const plan = planFullshot({ width: 1200, height: 90000, hasContent: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.capped, true);
    assert.equal(plan.height, MAX_HEIGHT);
    assert.ok(plan.note.includes('只截到'), `说明里要写截到多少：${plan.note}`);
    assert.ok(plan.note.includes('9.0 万'), `要写清原高：${plan.note}`);
  });

  await check('页面太宽时截到上限并如实说（M3）', async () => {
    const plan = planFullshot({ width: 9000, height: 800, hasContent: true });
    assert.equal(plan.capped, true);
    assert.equal(plan.width, MAX_WIDTH);
    assert.ok(plan.note.includes('只截到'));
  });

  await check('长宽都没超但总量超了，按比例缩到上限内并说明（M3）', async () => {
    const plan = planFullshot({ width: 3900, height: 19000, hasContent: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.capped, true);
    assert.ok(plan.width * plan.height <= MAX_PIXELS, '缩完必须落在总量上限内');
    assert.ok(plan.note.includes('按比例缩到'), `要说明是缩的：${plan.note}`);
    // 超出上限时不许出现"缩得比原来还大"这种反向错误
    assert.ok(plan.width <= 3900 && plan.height <= 19000);
  });

  await check('量不出尺寸就拒绝，不截白图（M3）', async () => {
    for (const bad of [{}, { hasContent: false, width: 100, height: 100 }, { width: 0, height: 0 }, null]) {
      const plan = planFullshot(bad);
      assert.equal(plan.ok, false, `这些输入都该拒绝：${JSON.stringify(bad)}`);
      assert.ok(plan.error && plan.error.includes('量不出'), '要给人话原因');
      assert.equal(plan.pixels, 0);
    }
  });

  await check('状态提示把人话与尺寸分开说（M3）', async () => {
    const plain = describeFullshot({ ok: true, width: 800, height: 1200, capped: false });
    assert.equal(plain, '已保存整页长图（800×1200）。');
    const capped = describeFullshot({ ok: true, width: 800, height: MAX_HEIGHT, capped: true, note: '页面高 3.0 万像素，只截到 2.0 万像素' });
    assert.ok(capped.includes('800×20000') && capped.includes('只截到'), capped);
    const failed = describeFullshot({ ok: false, error: '量不出这一页的尺寸' });
    assert.equal(failed, '量不出这一页的尺寸');
  });

  await check('文件名带时间戳且不会撞名（M3）', async () => {
    const name = fullshotFilename(new Date('2026-11-23T10:05:07'));
    assert.equal(name, '整页-2026-11-23-10-05-07.png');
    const other = fullshotFilename(new Date('2026-11-23T10:05:08'));
    assert.notEqual(name, other, '同一页连截两次要能区分');
  });

  await check('像素数说成「万」量级（M3）', async () => {
    assert.equal(humanPixels(320), '320');
    assert.equal(humanPixels(20000), '2.0 万');
    assert.equal(humanPixels(-5), '0');
  });

  await check('量尺寸脚本只读：不写 DOM、不发请求、不碰存储（M3）', async () => {
    const script = buildMetricsScript();
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'document.cookie', 'innerHTML =', 'appendChild', 'removeChild', 'style.']) {
      assert.ok(!script.includes(banned), `量尺寸脚本里不该出现 ${banned}`);
    }
    assert.ok(script.includes('scrollHeight'), '要量滚动高度');
    assert.ok(script.includes('scrollWidth'), '要量滚动宽度');
  });

  await check('主进程契约：先弹保存框、CDP 截整页、只摘自己挂的通道（M3）', async () => {
    const main = readFile('src/main.js');
    const at = main.indexOf("ipcMain.handle('nyx:page:fullshot'");
    assert.ok(at > 0, '缺少 nyx:page:fullshot');
    const body = main.slice(at, at + 3600);
    const dialogAt = body.indexOf('showSaveDialogSync');
    const captureAt = body.indexOf('Page.captureScreenshot');
    assert.ok(dialogAt > 0, '必须先弹保存框');
    assert.ok(captureAt > dialogAt, '保存框要在截图之前，取消就一张都不生成');
    assert.ok(/captureBeyondViewport: true/.test(body), '要截到视口之外');
    assert.ok(/clip: \{ x: 0, y: 0, width: plan\.width, height: plan\.height, scale: 1 \}/.test(body), '按量好的尺寸下 clip');
    assert.ok(/attachedHere/.test(body), '要记是不是自己挂的调试通道');
    assert.ok(/if \(attachedHere\)/.test(body), '只有自己挂的才 detach');
    assert.ok(/PAGE_FULLSHOT/.test(body), '成功与失败都要落诊断');
    assert.ok(/planFullshot\(/.test(body), '要用纯逻辑算尺寸');
    assert.ok(/capped: plan\.capped/.test(body), '返回值要带截断标记');
  });

  await check('界面接线：菜单项、preload、渲染层三处齐全（M3）', async () => {
    const html = readFile('src/renderer/index.html');
    assert.ok(html.includes('id="more-fullshot"'), '「更多」菜单要有整页长截图');
    assert.ok(/整页长截图/.test(html), '菜单项要写全名');
    assert.ok(/超高会截断/.test(html), '提示里要写明超高会截断');
    const preload = readFile('src/preload.js');
    assert.ok(/pageFullshot: \(\) => ipcRenderer\.invoke\('nyx:page:fullshot'\)/.test(preload), 'preload 要暴露 pageFullshot');
    const renderer = readFile('src/renderer/renderer.js');
    assert.ok(/async function takeFullshot\(\)/.test(renderer), '渲染层要有 takeFullshot');
    assert.ok(/moreFullshot: document\.getElementById\('more-fullshot'\)/.test(renderer), '要取到菜单项');
    assert.ok(/els\.moreFullshot\.addEventListener\('click'/.test(renderer), '要绑点击');
    assert.ok(/res\.code === 'CANCELED'/.test(renderer), '取消要单独说一句');
    assert.ok(/截断/.test(renderer), '截断时提示要说出来');
  });

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n整页长截图回归：${checks.length - failed.length} / ${checks.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const item of failed) console.log(` - ${item.label}｜${item.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('整页长截图回归脚本自身出错：', err);
  process.exit(1);
});
