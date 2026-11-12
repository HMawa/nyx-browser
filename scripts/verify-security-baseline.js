'use strict';
/**
 * 安全基线回归（实测清单 C2）
 *
 * 这一项不像 A1/A4 那样有「点一下能看见」的行为，它防的是**文档与机器脱钩**：
 * 文档说依赖 Electron 43.7.4，`package.json` 里其实是别的版本，或者模块里又抄了第三个数——
 * 于是照着安全公告核对的是一个根本不存在的组合。三条一起卡住，脱钩当场红。
 *
 * 纯 Node：不启动 Electron，只读文件 + 跑纯函数。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'Nyx-安全基线-C2-CVE对照.md');
const PKG = path.join(ROOT, 'package.json');
const MODULE = path.join(ROOT, 'src', 'core', 'security-baseline.js');

let failed = 0;
let total = 0;

function check(name, pass, detail) {
  total += 1;
  if (!pass) failed += 1;
  console.log(`  ${pass ? '✔' : '✘'} ${name}${detail ? `｜${detail}` : ''}`);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  console.log('[安全基线] 检查声明版本、文档与模块是否互相一致');

  const pkg = JSON.parse(read(PKG) || '{}');
  const doc = read(DOC);
  const baseline = require(MODULE);

  const declaredElectron = String((pkg.devDependencies && pkg.devDependencies.electron) || '');
  const { RUNTIME_BASELINE, ADVISORY_SOURCES } = baseline;

  check('package.json 里 electron 是精确版本（不带 ^ / ~ / *）', /^\d+\.\d+\.\d+$/.test(declaredElectron), declaredElectron || '（缺失）');
  check('模块声明基线 = package.json 的 electron', RUNTIME_BASELINE.electron === declaredElectron, `${RUNTIME_BASELINE.electron} vs ${declaredElectron}`);
  check('模块声明了 Chromium 与 Node 版本', !!RUNTIME_BASELINE.chromium && !!RUNTIME_BASELINE.node, `${RUNTIME_BASELINE.chromium} / ${RUNTIME_BASELINE.node}`);
  check('模块记录了基线复核日期', /^\d{4}-\d{2}-\d{2}$/.test(String(RUNTIME_BASELINE.reviewedAt || '')), String(RUNTIME_BASELINE.reviewedAt || ''));

  check('安全基线文档存在', doc.length > 800, `${doc.length} 字节`);
  check('文档写明了 Electron 版本且与模块一致', doc.includes(RUNTIME_BASELINE.electron), RUNTIME_BASELINE.electron);
  check('文档写明了 Chromium 版本且与模块一致', doc.includes(RUNTIME_BASELINE.chromium), RUNTIME_BASELINE.chromium);
  check('文档写明了 Node 版本且与模块一致', doc.includes(RUNTIME_BASELINE.node), RUNTIME_BASELINE.node);
  check(
    '文档包含必需小节（复核方法 / 升级计划 / 已核对结论）',
    doc.includes('复核方法') && doc.includes('升级计划') && doc.includes('已核对结论'),
    '',
  );
  // 只把「当真的结论」当问题：文档里可以在解释规矩时引用「已知无风险」这种说法，
  // 所以先去掉中文引号内的内容，再找有没有直接把风险判成"没有"的断言。
  const docWithoutQuotes = doc.replace(/「[^」]*」/g, '「」').replace(/“[^”]*”/g, '“”');
  check(
    '文档没有把未核实的结论写成「无风险」',
    !/已知无风险|不存在漏洞|没有安全风险/.test(docWithoutQuotes),
    '',
  );
  check(
    '文档给出了三个公告入口的网址',
    ADVISORY_SOURCES.every((source) => doc.includes(source.url)),
    ADVISORY_SOURCES.map((s) => s.key).join(','),
  );

  const okBaseline = baseline.checkBaseline({ electron: RUNTIME_BASELINE.electron, chrome: RUNTIME_BASELINE.chromium, node: RUNTIME_BASELINE.node });
  check('版本一致时 checkBaseline 通过', okBaseline.ok === true && okBaseline.drift.length === 0, okBaseline.summary || JSON.stringify(okBaseline.drift));

  const drift = baseline.checkBaseline({ electron: '0.0.1', chrome: RUNTIME_BASELINE.chromium, node: RUNTIME_BASELINE.node });
  check('Electron 漂移时会被抓出来且指名道姓', drift.ok === false && drift.drift.some((line) => line.includes('Electron')), JSON.stringify(drift.drift));

  const missing = baseline.checkBaseline({});
  check('版本读不到时判为不一致（不假装通过）', missing.ok === false && missing.items.every((item) => item.match === false), JSON.stringify(missing.drift));

  const payload = baseline.securityBaselinePayload({ electron: RUNTIME_BASELINE.electron, chrome: RUNTIME_BASELINE.chromium, node: RUNTIME_BASELINE.node, appVersion: '1.17.0' });
  check('载荷带 summary 与公告入口，供设置页直接渲染', typeof payload.summary === 'string' && payload.sources.length === 3, payload.summary.slice(0, 60));

  const mainJs = read(path.join(ROOT, 'src', 'main.js'));
  check('主进程注册了 nyx:security:baseline 并在真实进程里取值', mainJs.includes("ipcMain.handle('nyx:security:baseline'") && mainJs.includes('process.versions.electron'), '');
  check(
    '打开公告页只走白名单（渲染进程传不了任意 URL）',
    mainJs.includes("ipcMain.handle('nyx:security:advisory'") && mainJs.includes('ADVISORY_SOURCES.find'),
    '',
  );

  const preload = read(path.join(ROOT, 'src', 'preload.js'));
  check('preload 暴露 securityBaseline / openSecurityAdvisory', preload.includes('securityBaseline:') && preload.includes('openSecurityAdvisory:'), '');

  const html = read(path.join(ROOT, 'src', 'renderer', 'settings.html'));
  check('设置页关于分区有安全基线卡片', html.includes('id="security-baseline-grid"') && html.includes('data-advisory="electron"'), '');

  const settingsJs = read(path.join(ROOT, 'src', 'renderer', 'settings.js'));
  check('设置页进入关于分区会重新读基线', settingsJs.includes('loadSecurityBaseline()') && settingsJs.includes('securityBaseline()'), '');

  console.log('');
  console.log(`[安全基线] 共 ${total} 项，通过 ${total - failed} 项，失败 ${failed} 项`);
  if (failed) process.exitCode = 1;
  else console.log('[Nyx] 安全基线回归通过：声明版本、文档与设置页三处一致');
}

main();
