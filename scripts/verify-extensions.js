/* 由 2026-09-20 扩展插件开发会话归档；用法见文件头注释与 PROGRESS.md「二·补 6」。 */
'use strict';

/* Nyx 扩展插件管理器验收脚本（纯 Node，不依赖 Electron） */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const zlib = require('node:zlib');

const {
  ExtensionManager,
  crxZipOffset,
  unzipBuffer,
  readManifest,
  collectCapabilities,
} = require(path.join(__dirname, '..', 'src/core/extensions.js'));

const root = path.join(os.tmpdir(), `nyx-ext-verify-${Date.now()}`);
const srcDir = path.join(root, 'src');
const stateDir = path.join(root, 'state');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures.push(`${name} → ${err.message}`);
    console.log(`  [FAIL] ${name} → ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures.push(`${name} → ${err.message}`);
    console.log(`  [FAIL] ${name} → ${err.message}`);
  }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** 极简 zip 打包（store 方式，不压缩；解包逻辑不校验 CRC，故填 0） */
function makeStoreZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(0, 10); // store
    head.writeUInt32LE(0, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBuf.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 给 ZIP 套一层 CRX3 头 */
function wrapCrx3(zipBuffer) {
  const header = Buffer.from('{"crx_id":"test"}', 'utf8');
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x34327243, 0); // Cr24
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  return Buffer.concat([head, header, zipBuffer]);
}

/** 造一个假的分区（只实现用到的两个方法） */
function createFakeSession() {
  const loaded = new Map();
  return {
    loaded,
    loadExtensionCalls: [],
    async loadExtension(dir, options) {
      this.loadExtensionCalls.push({ dir, options });
      if (loaded.has(dir)) {
        const err = new Error(`Extension at ${dir} is already loaded.`);
        throw err;
      }
      const id = `fake-${Buffer.from(dir).toString('hex').slice(0, 8)}`;
      loaded.set(dir, id);
      return { id, path: dir };
    },
    removeExtension(id) {
      for (const [dir, value] of loaded) {
        if (value === id) loaded.delete(dir);
      }
    },
  };
}

(async () => {
  fs.mkdirSync(root, { recursive: true });

  /* ---------- 用例 1：MV2 内容脚本扩展（应判为高支持度，i18n 名称生效） ---------- */
  const extA = path.join(srcDir, 'ext-a');
  write(
    path.join(extA, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 2,
        name: '__MSG_extName__',
        description: '__MSG_extDesc__',
        version: '1.2.3',
        default_locale: 'zh_CN',
        content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
        permissions: ['storage'],
      },
      null,
      2,
    ),
  );
  write(
    path.join(extA, '_locales', 'zh_CN', 'messages.json'),
    JSON.stringify({ extName: { message: '页面助手' }, extDesc: { message: '给页面加小工具' } }),
  );
  write(path.join(extA, 'content.js'), 'console.log("nyx ext")');

  /* ---------- 用例 2：MV3 广告拦截扩展（应判为低支持度并给出拦截警告） ---------- */
  const extB = path.join(srcDir, 'ext-b');
  write(
    path.join(extB, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: '广告猎手',
      version: '0.9',
      permissions: ['declarativeNetRequest', 'storage'],
      host_permissions: ['<all_urls>'],
      background: { service_worker: 'sw.js' },
    }),
  );
  write(path.join(extB, 'sw.js'), '// service worker');

  /* ---------- 用例 3：非扩展目录 ---------- */
  const extC = path.join(srcDir, 'ext-c');
  write(path.join(extC, 'readme.txt'), 'not an extension');

  console.log('\n[1] manifest 解析与能力评级');
  check('MV2 扩展：i18n 名称解析正确', () => {
    const meta = readManifest(extA);
    assert.strictEqual(meta.name, '页面助手');
    assert.strictEqual(meta.description, '给页面加小工具');
    assert.strictEqual(meta.version, '1.2.3');
    assert.strictEqual(meta.manifestVersion, 2);
  });
  check('MV2 内容脚本扩展评级为 high', () => {
    const meta = readManifest(extA);
    const caps = collectCapabilities(meta.manifest, meta.manifestVersion);
    assert.strictEqual(caps.level, 'high');
    assert.strictEqual(caps.warnings.length, 0);
  });
  check('MV3 广告拦截扩展评级为 low 且给出网络拦截警告', () => {
    const meta = readManifest(extB);
    const caps = collectCapabilities(meta.manifest, meta.manifestVersion);
    assert.strictEqual(caps.level, 'low');
    assert.ok(caps.warnings.some((text) => text.includes('网络拦截')), '应提示网络拦截不可用');
    assert.ok(caps.warnings.some((text) => text.includes('Service Worker')), '应提示 SW 支持有限');
  });
  check('缺少 manifest.json 时拒绝导入', () => {
    assert.throws(() => readManifest(extC), /manifest\.json/);
  });
  check('manifest_version 非法时拒绝', () => {
    const bad = path.join(srcDir, 'ext-bad-ver');
    write(path.join(bad, 'manifest.json'), JSON.stringify({ manifest_version: 4, name: 'x', version: '1' }));
    assert.throws(() => readManifest(bad), /manifest_version/);
  });

  /* ---------- 用例 4：压缩包解包 ---------- */
  console.log('\n[2] 压缩包解包');
  check('正常 ZIP 解包', () => {
    const out = path.join(root, 'unzip-ok');
    fs.mkdirSync(out, { recursive: true });
    unzipBuffer(makeStoreZip([['manifest.json', '{"a":1}'], ['sub/b.js', 'x']]), out);
    assert.ok(fs.existsSync(path.join(out, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(out, 'sub', 'b.js')));
  });
  check('拒绝目录穿越条目', () => {
    const out = path.join(root, 'unzip-evil');
    fs.mkdirSync(out, { recursive: true });
    assert.throws(() => unzipBuffer(makeStoreZip([['../evil.txt', 'x']]), out), /路径非法/);
    assert.ok(!fs.existsSync(path.join(root, 'evil.txt')), '不应写出到上级目录');
  });
  check('CRX3 头定位正确', () => {
    const zip = makeStoreZip([['manifest.json', '{}']]);
    const crx = wrapCrx3(zip);
    const offset = crxZipOffset(crx);
    assert.strictEqual(offset, 12 + Buffer.byteLength('{"crx_id":"test"}'));
    assert.strictEqual(crx.readUInt32LE(offset), 0x04034b50);
  });
  check('裸 zip 可被识别（偏移 0）', () => {
    assert.strictEqual(crxZipOffset(makeStoreZip([['a', 'b']])), 0);
  });
  check('非压缩包文件被拒绝', () => {
    assert.throws(() => crxZipOffset(Buffer.from('hello world hello world')), /不是有效/);
  });

  /* ---------- 用例 5：管理器全流程 ---------- */
  console.log('\n[3] 管理器安装 / 启停 / 删除');
  const session = createFakeSession();
  const logs = [];
  const manager = new ExtensionManager({
    stateDir,
    getSession: () => session,
    log: (level, text) => logs.push(`${level}:${text}`),
  });
  manager.init();

  let installedA = null;
  await checkAsync('目录安装 MV2 扩展成功并自动启用', async () => {
    const res = await manager.install(extA);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.extension.name, '页面助手');
    assert.strictEqual(res.extension.enabled, true);
    assert.strictEqual(res.extension.loaded, true);
    assert.strictEqual(res.reloadHint, true, '含内容脚本应提示需要刷新标签');
    installedA = res.extension;
  });
  check('扩展已复制进仓库（源目录可删）', () => {
    assert.ok(fs.existsSync(installedA.dir), '仓库副本应存在');
    assert.ok(path.resolve(installedA.dir).startsWith(path.resolve(stateDir)), '副本应落在状态目录内');
    assert.ok(fs.existsSync(path.join(installedA.dir, 'content.js')));
  });
  check('装载时向分区传 allowFileAccess 且路径为仓库副本', () => {
    const call = session.loadExtensionCalls.at(-1);
    assert.deepStrictEqual(call.options, { allowFileAccess: true });
    assert.strictEqual(call.dir, installedA.dir);
  });
  check('索引已落盘且不含运行时字段', () => {
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'extensions.json'), 'utf8'));
    assert.strictEqual(raw.items.length, 1);
    assert.strictEqual(raw.items[0].name, '页面助手');
    assert.strictEqual(raw.items[0].runtimeId, undefined, '索引不应写入 runtimeId');
    assert.strictEqual(raw.items[0].loaded, undefined, '索引不应写入装载态');
  });

  await checkAsync('停用扩展：从分区卸载', async () => {
    const res = await manager.setEnabled(installedA.id, false);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.extension.enabled, false);
    assert.strictEqual(res.extension.loaded, false);
    assert.strictEqual(session.loaded.size, 0, '停用后分区不应保留该扩展');
  });
  await checkAsync('重新启用：回到分区', async () => {
    const res = await manager.setEnabled(installedA.id, true);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.extension.loaded, true);
    assert.strictEqual(session.loaded.size, 1);
  });

  await checkAsync('重复安装同一目录：按更新处理，不产生第二份', async () => {
    const res = await manager.install(extA);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.updated, true, '同源二次导入应标记为更新');
    assert.strictEqual(manager.list().length, 1);
  });

  await checkAsync('安装广告拦截扩展：入库成功但给出低支持度', async () => {
    const res = await manager.install(extB);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.extension.capabilities.level, 'low');
    assert.strictEqual(res.reloadHint, false, '无内容脚本不应提示刷新标签');
  });

  await checkAsync('安装非扩展目录：被拒绝', async () => {
    const res = await manager.install(extC);
    assert.strictEqual(res.ok, false);
    assert.ok(res.error.includes('manifest.json'), res.error);
  });

  await checkAsync('模拟重启：新实例按索引装载启用项', async () => {
    const session2 = createFakeSession();
    const manager2 = new ExtensionManager({
      stateDir,
      getSession: () => session2,
      log: () => {},
    });
    const ready = manager2.init();
    assert.strictEqual(ready.count, 2, '索引应恢复 2 个扩展');
    const result = await manager2.loadAll();
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.loaded, 2);
    assert.strictEqual(session2.loaded.size, 2);
  });

  await checkAsync('卸载：清仓库文件并更新索引', async () => {
    const target = manager.list().find((item) => item.name === '广告猎手');
    const dir = target.dir;
    const res = await manager.remove(target.id);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(fs.existsSync(dir), false, '仓库目录应被删除');
    const raw = JSON.parse(fs.readFileSync(path.join(stateDir, 'extensions.json'), 'utf8'));
    assert.strictEqual(raw.items.length, 1);
  });

  await checkAsync('CRX 安装全链路', async () => {
    const extD = path.join(srcDir, 'ext-d');
    write(
      path.join(extD, 'manifest.json'),
      JSON.stringify({
        manifest_version: 2,
        name: '样式改写器',
        version: '2.0.0',
        content_scripts: [{ matches: ['<all_urls>'], css: ['a.css'] }],
      }),
    );
    write(path.join(extD, 'a.css'), 'body{}');

    // 目录里带子目录，走 ZIP 打包 → 加 CRX3 头 → 走安装包链路
    const zip = makeStoreZip([
      ['manifest.json', fs.readFileSync(path.join(extD, 'manifest.json'), 'utf8')],
      ['a.css', 'body{}'],
    ]);
    const crxFile = path.join(root, 'ext-d.crx');
    fs.writeFileSync(crxFile, wrapCrx3(zip));

    const res = await manager.installCrx(crxFile);
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.extension.name, '样式改写器');
    assert.strictEqual(res.extension.source, 'crx');
    assert.strictEqual(res.extension.capabilities.level, 'high');
    assert.ok(fs.existsSync(path.join(res.extension.dir, 'a.css')), '解包内容应入库');
    assert.strictEqual(fs.readdirSync(path.join(stateDir, 'tmp')).length, 0, '临时目录应清理干净');
  });

  await checkAsync('伪装成 .crx 的无效文件被拒绝', async () => {
    const badFile = path.join(root, 'bad.crx');
    fs.writeFileSync(badFile, Buffer.from('Cr24' + 'x'.repeat(60)));
    const res = await manager.installCrx(badFile);
    assert.strictEqual(res.ok, false);
  });

  /* ---------- 用例 6：索引损坏的自愈行为 ---------- */
  console.log('\n[4] 索引损坏时的行为');
  await checkAsync('索引损坏：备份原文件并按空表启动，且拒绝覆盖写入', async () => {
    const corruptRoot = path.join(root, 'state-corrupt');
    fs.mkdirSync(corruptRoot, { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, 'extensions.json'), '{ this is not json', 'utf8');

    const session3 = createFakeSession();
    const manager3 = new ExtensionManager({ stateDir: corruptRoot, getSession: () => session3, log: () => {} });
    manager3.init();
    assert.strictEqual(manager3.list().length, 0);
    const backups = fs.readdirSync(corruptRoot).filter((name) => name.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1, '损坏索引应被备份而非删除');
    assert.strictEqual(fs.readFileSync(path.join(corruptRoot, 'extensions.json'), 'utf8'), '{ this is not json');
    const persisted = manager3.persist();
    assert.strictEqual(persisted, false, '损坏状态下不应覆盖原文件');
  });

  console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
  if (failures.length) {
    for (const item of failures) console.log(`  - ${item}`);
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('日志抽样：');
    for (const line of logs.slice(0, 6)) console.log(`  ${line}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
})();
