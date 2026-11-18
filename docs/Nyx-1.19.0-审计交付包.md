# Nyx 1.19.0 审计交付包

> 给审计方看的一份说明书。目标是：拿到这个仓库和这个安装包，不问我任何人，能自己把下面每一条复跑一遍。
> 所有数字都来自磁盘实测（`temp/collect-audit-facts-1190.js` 采集），不是凭记忆写的。

---

## 0. 一句话结论

1.19.0 是「接入外壳」：把网络接入的**呈现方式**拆成校园 / 单位 / 自定义三档，**只改呈现、入口、引导、文案四层**，代理内核与转发链路一行未动。已发布、已签名、已 tag、已 push；`main` 工作树干净。

**能放行的部分**：呈现层与文案层、换词零残留、回归 49 脚本 / 1151 项全绿、安装器 e2e 与安装保留验证通过。

**需要你自己判断的部分**：内核与出口相关能力（订阅导入、测速、分流、真实出口）**没有逐档真机复测**——逻辑没动，属推断，见 §9。

---

## 1. 交付物与完整性

| 项 | 值 |
| --- | --- |
| 安装包 | `dist/Nyx-Setup-1.19.0.exe` |
| 字节 | **127,336,256** |
| sha256 | **`7ec6204bbb5304fc55f057503c91425199fd1b820a3ed0822d2e9af136966777`** |
| 解包目录版本 | `dist/win-unpacked/Nyx.exe` → FileVersion **1.19.0** |
| 本机已装 | `%LOCALAPPDATA%\Programs\Nyx\Nyx.exe`，FileVersion **1.19.0**，250,057,048 字节 |
| 更新源 | `%APPDATA%\Nyx\updates\latest.json` → version/size/sha256 与上面三处**完全一致**，`fileExists: true` |
| 清单签名 | `signature: true`，`keyId: dc2cec223e6ea7c7`（Ed25519） |
| 更新说明 | `notes` 11 行中文（末行「本次不推送、不 tag…」之类结论性说明不含在内，实际为接入外壳说明） |
| 归档留档 | `%APPDATA%\Nyx\updates-archive\` 下保留 **1.19.0 / 1.18.2 / 1.18.1** 三版 |

自签名能力边界（与 1.17.4 起一致，未变）：

- 证书 `CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`，自签、无时间戳；
- **自签名 ≠ 公信签名**：SmartScreen 仍会提示「未知发布者」，这不是缺陷，是没买公信证书的必然结果；
- 复核命令：`& 'C:\Program Files\nodejs\npm.cmd' run verify:signing`（`--no-artifact` 时只跑静态守卫）。

---

## 2. 运行环境

- Electron **45.3.2** / Chromium **156.0.8078.100** / Node **24.22.2** / Windows；
- 运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用），其余全零依赖；
- 安装器：NSIS，`perMachine:false`（装到用户目录），自定义脚本 `build/installer.nsh`、打包后钩子 `build/after-pack.js`（翻 fuses，`EnableEmbeddedAsarIntegrityValidation` **刻意不开**，开了会砸启动）。

---

## 3. 仓库与提交

| 项 | 值 |
| --- | --- |
| HEAD | `e91a502db5c2ec924797aa44f8be17d0309a29ca`（`e91a502`） |
| 远端 `refs/heads/main` | 同 `e91a502` |
| tag `v1.19.0` | → `7b9ff62841f59037f6dae12f84d73c9694750a3a`（发版提交） |
| tag `v1.18.2-post` | → `d87d5c1441a0e62dfbc9df8a4c2346880755fb59` |
| tag `v1.18.2` | → `dfc311d…`，**没有移动过**（理由见 `docs/Nyx-1.18.2-脱敏补正.md`） |
| 工作树 | 干净（`git status --porcelain` 为空） |

近期提交（新 → 旧）：

```
e91a502 docs(agents): 1.19.0 已发布，§2 里 tag 与 main 的指向写准
a5f4a31 docs(agents): 修正 §2 里与 1.19.0 冲突的旧「当前版本」行
7b9ff62 feat(net): 接入外壳 1.19.0——三档接入方式、单一真源、全渲染层换词回归
d87d5c1 test(net): 换词语料从两个文件扩到整个渲染层，并锁定「单位档只是同表第二个标签」
4cca19a docs: 补 1.19.0 接入外壳批次条目、回归基线改成 1150 项 / 49 脚本
5bf399a docs(net): 接入外壳能力对照表与清单 20 项逐条判定
c046777 feat(net): 外壳与设置页按接入身份换词，关于页保留 mihomo 署名
ada6e1d feat(onboard): 首装引导加「接入方式」一步
f5349dd feat(net): 设置页动态换词（TreeWalker + Observer）与有序替换表
d637d18 feat(net): 接入身份与术语表单一真源，外壳加身份条与三段式骨架
```

> 注：`4cca19a` 里写的「1150 项」是**当轮**口径；`d87d5c1` 加了两条断言（`verify-net-terms` 28 → 29）之后实际是 **1151 项**。两处不一致已在新版本文档中统一为 1151，历史提交不改写。

---

## 4. 这一版做了什么

### 4.1 三档接入方式（呈现层）

| 档位 | 叫什么 | 说明 |
| --- | --- | --- |
| `campus` | 校园网络接入 | 全新安装默认。术语表把「代理/节点/订阅」换成校园网络的说法 |
| `enterprise` | 单位网络接入 | **与 campus 共用同一张术语表**，只换身份标签与身份说明两句 |
| `custom` | 自定义接入 | 老用户升级后停在这一档，界面逐字不变；顶部多一条身份选择器（回滚用） |

落点：`src/core/net-terms.js`（28 个词条 + `IDENTITY_LABELS` / `IDENTITY_NOTES` + `shellize()` 有序替换表）、`netIdentity` 偏好、两个 IPC、`src/preload.js` 四个接口、外壳 `#net-identity` 身份条、设置页 TreeWalker/Observer 动态换词、首装引导第 2 步。

### 4.2 单一真源先建、再让 UI 取词

顺序是**先建表 → 断言锁表 → 再让界面从表取词**，没有反过来手改文案。`net-terms.js` 是唯一真源，界面不写死说法；换身份只需改表。

### 4.3 换词回归扩到全渲染层

`scripts/verify-net-terms.js` 的语料从那时的「`proxy-center.js` + `settings.html` 两个文件」扩到**全部 `src/renderer/*.{js,html}`（30 个文件 / 2312 条字面量）**，断言：

- 文件数 ≥ 10、字面量数 > 1500（防语料被悄悄缩小）；
- campus 与 enterprise 两档换词后，`LEGACY_WORDS` 残留 **0** 条；
- 第 29 项：campus 与 enterprise 的 28 个词条必须**逐条全等**、只有 LABELS/NOTES 不同 —— 锁死「单位档是同一张表的第二个标签，不是第三张表」。

### 4.4 为什么保留单位档（决策反转，有据）

上一轮我建议砍掉，前提是「要额外维护一张术语表」。实测这个前提不成立：两档的 28 个词条**差异 0 条**。砍掉的成本是动身份表、引导、设置、断言、文档并重跑全量；保留的成本是两句文案。故保留，并把这条判断写成断言，避免以后有人再误加第三张表。

---

## 5. 验证证据

| 项 | 数字 | 怎么复跑 |
| --- | --- | --- |
| 全量回归 | **49 脚本 / 1151 项 / 49 通过 / 0 失败 / 0 跳过 / 801 秒** | `& 'C:\Program Files\nodejs\npm.cmd' run verify` |
| 安装器 e2e | 通过（升级基线 1.18.2；全新→降级→升级→修复→保留数据卸载→完全卸载 56 项） | `node scripts/test-installer-e2e.js`（需管理员） |
| AUD-03 安装保留验证 | **11/11**（装完后更新源里仍有本版包、sha/size 与 `latest.json` 一致、旧包已清） | `node scripts/verify-installer-retention.js` |
| 差分命中率 | 1.18.2 → 1.19.0：**243 块 / 命中 0 / 0.00%** | 发版时 `make-release` 自动量，或 `node scripts/measure-delta-report.js` |
| 换词残留 | 30 文件 / 2312 条字面量 / 两档残留 **0** | `node scripts/verify-net-terms.js` |
| 隐私自检（私密模式） | `leak 0 / suspect 0 / unknown 4 / masked 3 / pass 9` | `node scripts/privacy-audit.js --check` |
| 隐私自检（普通模式） | `leak 3 / suspect 1 / unknown 4 / masked 0 / pass 8` | 上面那条的对照，普通模式不设防，如实报泄漏 |
| docs 真值扫描 | 0 命中（UA / 核数 / 屏幕 / 时区 / 内网 IP / 缩放这几个形状） | `git grep -n -E "<这些形状>" -- docs` |

**注意**：801 秒是当轮实测；同一套脚本在轻载时测得 545 秒。**耗时随机器负载波动，别拿它当版本特征，项数与通过数才是。**

---

## 6. 审计须知（先看这七条，省你时间）

1. **聚合回归里是 49 个脚本，磁盘上有 56 个 `verify-*.js`。** 差集是 7 个：`verify-all.js`（跑批器本身）、`verify-integrity.js`（走 `npm run verify:integrity`）、`verify-installer-retention.js`（由 `make-release` 的安装器门禁内部调用）、`verify-extensions{,-e2e,-startup,-wiring}.js`（扩展相关，需人工/单独跑）。**这 7 个不在 1151 里**，也不该算进去。
2. **项数以 `scripts/verify-all.js` 的 `items` 标签为准**：49 条标签求和 = 1151，与实测一致。历史版本曾出现标签与实际差 18 项（发版门禁 48→52、代码签名 35→38 没同步），现在只认那个文件。
3. **AUD-03 是功能判据，不是字节判据。** 交接单最初要求「安装包里能找到 `nyx-keep-package` 这串字节」，实测**永远为 false**——NSIS 会把 `Rename` 的目标路径压进 LZMA 固实流，原文查不到。所以判据换成功能验证：装完后更新源里包还在、sha/size 与清单一致、旧包已清。
4. **`dist/` 里有 25 个历史安装包，共 3.0 GB。** 都是本机构建产物（1.17.0 → 1.19.0，其中 1.17.11–1.17.20 从未发布到更新源）。它们不入库，删了不影响复验，只是重新打包要时间。
5. **更新源里剩 6 份孤儿差分包**（`Nyx-Setup-1.17.9 / 1.17.10 / 1.18.0 / 1.18.1 / 1.18.2 .blocks.json` 对应的 exe 已被 prune 清掉，只剩 1.19.0 那对是配对的）。孤儿清单不会被任何客户端读取，属残留，不是漏洞。
6. **B1 当初的处理是「不移动 tag」**：`v1.18.2` 指向的树里旧文档仍含真实指纹（只在本机 git 历史里，未推送过就不存在泄露面；已推送则历史 blob 无法靠挪 tag 消除）。补正后的树打了 `v1.18.2-post`，主文档已全部脱敏。
7. **隐私自检的诚实边界**：DNS 泄漏这一项在有检测环境下恒为 `unknown`（浏览器内测不到解析路径）；「观察值」不是「真实值」——报告展示的是我们故意让页面看到的值，不是本机真实指纹；默认报告是**脱敏版**，真实值只在 `temp/privacy-audit/<版本>.json`（不入库）。

---

## 7. 建议的审计路线（八步）

1. `git checkout e91a502`，确认 `git status` 干净；
2. `node -e "console.log(require('./package.json').version)"` → 1.19.0；
3. `Get-FileHash dist\Nyx-Setup-1.19.0.exe -Algorithm SHA256` → 与 §1 的 sha256 比对；
4. `node scripts/verify-update-signature.js` → 清单签名链通；
5. `npm run verify` → 期望 49 脚本 / 1151 项全绿；
6. `node scripts/verify-installer-retention.js` → 期望 11/11；
7. `node scripts/verify-net-terms.js` → 期望 29/29（看 2312 条语料与两档零残留）；
8. `node scripts/privacy-audit.js --check` → 期望脱敏版存证通过（含 `—（已隐藏）`、差异段、边界段）。

---

## 8. 数据落点与不入库清单

| 落点 | 内容 |
| --- | --- |
| `%APPDATA%\Nyx\` | 偏好、书签、历史、站点名单、诊断包、`updates/`、`updates-archive/` |
| `%APPDATA%\Nyx\updates\` | `latest.json` + 安装包 + `.blocks.json` + `extensions.json` |
| `%LOCALAPPDATA%\Programs\Nyx\` | 安装目录（用户级安装） |
| `docs/privacy-audit/*.md` | 脱敏存证（可入库） |
| `temp/privacy-audit/*.json` | 原始观察值（**不入库**） |
| `dist/`、`node_modules/`、`temp/`、`_attic/` | 构建产物 / 依赖 / 临时 / 归档（**不入库**） |

`vendor/mihomo/` 是内核二进制 + geo 数据，**不入库**，靠 `npm run setup-vendor` 拉；GPL-3.0 署名与源码获取方式写在关于页与 `THIRD-PARTY-NOTICES.md`。

---

## 9. 仍然开放的事（不藏着）

1. **内核与出口能力没有逐档真机复测**：订阅导入、测速、分流规则、真实出口，这四项在 1.19.0 里**逻辑未动**，但也没有对三档各跑一遍真实网络——属推断，不属验证。要断言「三档都能正常出网」，得在三个真实网络环境里各测一次。
2. **13 寸首屏没截图**：换词后长句可能撑破窄屏，未做小屏视觉验证。
3. **1.17.11–1.17.20 十版从未发布**：`dist/` 里有包，更新源里从来没有过，`CHANGELOG`/发版记录也没为它们写过条目——本版一并扫过，不补写十份记录。
4. **扩展相关 4 个脚本未进聚合**：`verify-extensions*.js` 需要真实扩展包，暂时单独跑。
5. **`src/main.js` 仍是单文件主入口（约 6,100 行）**：拆分提案存在但没有做，理由是它对用户不可见、风险大于收益。

---

## 10. 变更表（1.18.2 → 1.19.0）

| 类别 | 变更 |
| --- | --- |
| 呈现 | 三档接入方式 + 身份条 + 设置页与外壳换词 |
| 入口 | 首装引导第 2 步「接入方式」 |
| 文案 | 28 词条单一真源；关于页保留 mihomo GPL-3.0 署名 |
| 未动 | `proxy-service` / `proxy-kernel` / `kernel-bridge` / `proxy-config` / `proxy-filter` 一行未改 |
| 回归 | 48 脚本 / 1120 项 → **49 脚本 / 1151 项** |
| 产物 | 127,323,616 → **127,336,256** 字节 |
