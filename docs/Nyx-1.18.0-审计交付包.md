# Nyx 1.18.0 · 审计交付包（一页看全）

> 生成时间：2026-11-18 12:07（Asia/Shanghai）
> 用途：安装完成后的整体审计输入。**所有数字均取自磁盘实测**（`node temp/collect-audit-facts.js` + `verify-all` 实跑），不是复述记忆。
> 结论先说：**可以开始审计，但有三件事必须先知道**——① 干净克隆下回归第 48 步会因缺文件失败（见 §11-F1）；② `git tag v1.18.0` 与 push **尚未做**（等你点头）；③ 锁屏期间「复制」类断言必然失败，属环境。

---

## 0. 状态总览

| 维度 | 值 |
| --- | --- |
| 版本 | **1.18.0**（`package.json` = 1.18.0） |
| 安装包 | `dist/Nyx-Setup-1.18.0.exe` · **127,323,200 字节** · sha256 `ef0d4388e54621d8aae44872fbca340a45b8cf0c17fb1d95dd0b7b9c98b8d096` |
| 已装版本 | `%LOCALAPPDATA%\Programs\Nyx\Nyx.exe` → FileVersion **1.18.0** |
| 更新源 | `%APPDATA%\Nyx\updates\latest.json` → 1.18.0；`file` 存在、size/sha256 一致、`signature`+`keyId dc2cec223e6ea7c7` 齐全 |
| 留档 | `updates-archive`：1.18.0 / 1.17.10 / 1.17.9 |
| 回归 | **49 步 / 实测 1104 项 / 681 秒**：48 通过 / 1 失败（锁屏剪贴板） |
| 提交 | `c06f2c1`（自检）→ `569595c`（应用页装配 + 存证）→ `e09e56f`（文档） |
| tag / push | **未做**（R6 需授权）；远端仓库仍停在 1.17.9 |
| 工作区 | 干净，仅两个未跟踪文件属「另一条线」：`src/core/net-terms.js`、`scripts/verify-net-terms.js` |

---

## 1. 交付物与完整性

| 物 | 位置 | 校验 |
| --- | --- | --- |
| 安装包 | `dist/Nyx-Setup-1.18.0.exe` | size 127,323,200；sha256 `ef0d4388…b8d096`；Authenticode `CN=Nyx Self-Signed, O=Nyx contributors, OU=local build` 指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0` |
| 完整性清单 | `dist/latest.json`（electron-builder 产物） | `npm run verify:integrity` **9/9** |
| 更新源清单 | `%APPDATA%\Nyx\updates\latest.json` | version/file/size/sha256 与实际文件逐项一致；Ed25519 清单签名可验（`keyId dc2cec223e6ea7c7`） |
| 差分清单 | `updates\Nyx-Setup-1.18.0.blocks.json`（243 块 × 0.5 MB） | 仅作参考：实测命中率 **0.00%**（见 §10） |
| 隐私自检存证 | `docs/privacy-audit/1.18.0.md`（与 1.17.20 各一份） | `node scripts/privacy-audit.js --check` 通过 |
| 发版记录 | `docs/Nyx-1.18.0-发版记录.md` | — |
| 变更总览 | `docs/CHANGELOG.md`（1.18.0 小节 + 索引行） | — |
| 门禁与台账 | `AGENTS.md` §2、`docs/实测修复台账.md`「1.18.0 批次」 | — |

**签名说明（别误读）**：自签名只能证明「这个包是我们这把私钥签的、之后没被改过」，**不能**消除 SmartScreen「未知发布者」，也不等于公信时间戳。私钥在 `%APPDATA%\Nyx\update-signing-key.pem`（`.pem` 已进 `.gitignore`）。

---

## 2. 运行环境

| 项 | 值 |
| --- | --- |
| Electron | **45.3.2**（Chromium 156.0.8078.100 / Node 24.22.2） |
| 平台 | Windows（NSIS，`perMachine:false`，装到用户目录） |
| 运行时依赖 | 只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用） |
| 构建期依赖 | `electron`、`electron-builder`、`@electron/fuses` 2.1.3 |
| 源码规模 | `src/` 共 **121** 个文件；`src/core/` 主进程模块 60+ 个 |
| 脚本 | `scripts/` 共 **71** 个 `.js`，其中 **49** 个进一键回归 |

---

## 3. 仓库与提交

```
e09e56f docs: 1.18.0 收口发版——发版记录、CHANGELOG、README 与门禁基线（1104 项 / 49 脚本）
569595c fix(privacy): 应用页（起始页 / 设置页）也走指纹装配，否则隐私模式第一屏就是真 UA
c06f2c1 feat(privacy): 本地隐私自检——判定引擎、设置页卡片、首次进隐私模式的横幅
36a2c3c docs: 补下一步规划（发版收口 / 质量地基 / 产品方向）
16b25b0 fix(release): 安装后不再删掉 latest.json 指向的安装包
```

### 3.1 1.17.10 → 1.18.0 都包含什么（十个试装包的收口）

| 批次 | 内容 | 落点 |
| --- | --- | --- |
| 安全审计收尾 | 外壳导航守卫、更新清单 Ed25519 签名 + 安装前验签、隐私指纹进主世界、密码框抹值、执行脚本要确认、IPC 发送方校验、Electron fuses、`/health` 鉴权 | `shell-guard.js`、`update-signature.js`、`privacy-surface.js`、`ipc-guard.js`、`build/after-pack.js` |
| 隐私模式改造 | Worker 指纹、Canvas 确定性、UA/平台/语言自洽、切换快路径（缓存 + 每步耗时）、标签停靠（12 个上限 + 真冻结）、切换动画（1 秒，可关）、显卡/字体统一上报 | `privacy-surface.js`、`switch-cache.js`、`tabs.js`、`transition.*` |
| 质量与门禁 | 硬件探测 2.5 秒超时、引导标记容忍 BOM、加密可用性异步探测、设置页标签层修好（61/61 配平）、字号四档、导航预算可按站点、急停快捷键自动降级 | `hardware.js`、`main.js`、`settings.*`、`font-scale.js`、`navigate-budget.js`、`agent-shortcut.js` |
| 安装/更新链 | 安装后保留清单指向的安装包（`16b25b0`）、安装器 e2e 进发版门禁、`--restore` 留档回写 | `build/installer.nsh`、`make-release.js` |

---

## 4. 架构与安全边界（审计从这里入手）

```
src/
  main.js                 主进程唯一入口（约 6100 行）：窗口/标签/会话/代理/工具箱/更新/agent/IPC
  preload.js              外壳暴露面（contextBridge，冻结代理）
  preload-tab.js          标签暴露面（隔离世界；隐私模式的 JS 加固由主世界注入，不在这里）
  core/                   60+ 纯逻辑或半纯逻辑模块（下详）
  renderer/               外壳（index.html）、设置、地址建议、书签文件夹、下载中心、工具箱、转场
  api/http-api.js         本地 HTTP 接口（只绑回环 + 64 hex token + 常量时间比较）
  mcp/server.js           MCP（独立 stdio 进程，转发到本地 HTTP）
```

**四条结构性安全假设**（审计时按这四条切）：

1. **标签是 `WebContentsView`，画在外壳 DOM 之上**：任何"盖在上面的 UI"都必须是独立无边框 `BrowserWindow`，或让外壳变高/变窄把视图推走（`applyShellExtra` / `applyRightInsets`）。历史上"菜单被遮挡""摘要被压住""动画看不见"都是这条造成的。
2. **两个世界**：`contextIsolation:true` + `sandbox:true`（远端标签）。指纹加固必须走**主世界注入**（`Page.addScriptToEvaluateOnNewDocument` + 文档就绪后 `executeJavaScript` 补打），只写 preload 的隔离世界等于没写。
3. **隐私模式 = 另一套 session**（内存分区 + 强制代理 + 不落盘），普通模式不设防。切换时普通标签**停靠**（摘视图、静音、降频、`Page.setWebLifecycleState('frozen')`），超 12 个按地址重开。
4. **本地接口 = 回环 + token + `senderFrame` 校验**：所有 `ipcMain.handle` 被 `installIpcSenderGuard()` 包过，校验发送方文档来源；`/health` 无 token 不返回版本。

### 4.1 `src/core/` 关键模块索引

| 域 | 模块 |
| --- | --- |
| 会话与模式 | `sessions.js`、`agent-mode.js`、`switch-cache.js`、`tab-lifecycle.js`、`tab-park`（在 `tabs.js`） |
| 隐私 | `privacy-hardening.js`（画像）、`privacy-surface.js`（主世界补丁 + Worker）、`privacy-check.js`（自检判定）、`page-cache.js`（离线快照，隐私加密） |
| 代理与网络 | `proxy-service.js`、`proxy-kernel.js`、`network-state.js`、`link-guard.js`、`risk-guard.js`（协议白名单） |
| 安全 | `shell-guard.js`、`update-policy.js`、`update-signature.js`、`ipc-guard.js`、`permissions.js`、`permission-store.js`、`security-baseline.js`、`security-switches.js`、`signing-status.js`、`process-args.js` |
| Agent | `agent-dispatch.js`、`agent-sites.js`、`agent-audit.js`、`agent-settings.js`、`agent-doc.js`、`agent-lamp.js`、`agent-shortcut.js`、`page-reader.js`、`actions.js` |
| 更新 | `updater.js`、`update-signature.js`、`delta-stats.js`、`nightly-status.js`、`nightly-task.js` |
| UI 基建 | `ui-store.js`、`toolbar.js`、`motion.js`、`font-scale.js`、`toolbox*.js`、`navigate-budget.js`、`onboarding.js` |
| 诊断 | `diagnostics.js`（环形缓冲 + 诊断包导出，路径白名单） |

---

## 5. 本版主打：本地隐私自检

**入口**：设置 → 隐私与安全 → 第一张卡；或首次进入隐私模式时顶部横幅的「去自检」。

- **16 项 / 四组**：身份（A1–A6）、图像与音频（B1–B3）、网络出口（C1–C3）、行为约束（D1–D4）。
- **五档**：泄漏 / 可疑 / 测不到 / 已伪装 / 正常。
- **观察值与真实值分离**：观察值由页面自己报（`buildObserverScript()` 在页面主世界跑，900ms 内并行收音频与 WebRTC 候选）；真实值由主进程给（`os.cpus()`、主显示器、系统语言、显卡字符串）。
- **硬约束**：`TRUTH_REQUIRED = {A1,A3,A5,A6,B1,B3}` 这六项拿不到真实值时**必须**判「测不到」，`judgeItem(id, observed, null)` 不许 fallback 到 observed（有断言）。
- **唯一恒为「测不到」的项**：C3（DNS 出口）——不去第三方问，就不可能知道解析走了哪条链路。
- **没有分数、没有绝对化措辞**：报告里禁止「100% / 绝对安全 / 完全匿名 / 无法被追踪」，有断言守着。
- **存证**：`npm run privacy:audit` → `docs/privacy-audit/<版本>.md`，含「与上一版的差异」；`--check` 可做发版门禁。

1.18.0 实测（隔离实例、隐私模式）：**没发现泄漏；3 项已伪装、4 项测不到、9 项正常**；用时 **2.2 秒**。

---

## 6. 安全控制核对表（逐条可点验）

| 控制 | 落点 | 断言 |
| --- | --- | --- |
| 外壳不许被导航走 | `shell-guard.js`（只放行自己那份 `index.html`；伪协议 / 同目录别的 html 全拦；未知自身地址**失败关闭**；pushState 逃逸有两层保险） | 13 项 + 界面端到端 |
| 更新只走 https / 本地源要确认 / 版本单调 / 缺 sha256 拒绝 | `update-policy.js` + `updater.js` | 10 项 |
| 清单 Ed25519 签名 + 安装前验安装包签名 | `update-signature.js` + `updater.js#install` | 17 项 |
| IPC 发送方校验（取 `event.senderFrame.url` 的 origin） | `ipc-guard.js` | 10 项 |
| 本地 HTTP：回环 + token + 常量时间比较 + `/health` 不泄版本 | `api/http-api.js` | 9 项 |
| exe 不能当 Node 用（fuses：`RunAsNode=false` 等） | `build/after-pack.js`（签名之前翻） | 打包冒烟第 12 项真跑 `ELECTRON_RUN_AS_NODE=1` |
| 隐私模式指纹：UA / UA-CH / 语言 / 时区 / 核数 / 内存 / 屏幕 / Canvas / WebGL / WebGPU / 字体 / 音频 / Worker | `privacy-surface.js` + `privacy-hardening.js` | 66 项（含 Worker 与「应用页也装配」） |
| 密码框不回显、读页面有上限、截图前恢复窗口 | `page-reader.js`、`actions.js` | 34 项 |
| 隐私模式禁止 agent 截图 / 读页面 / 提取正文 | `main.js` 的 `PRIVATE_MODE_AGENT_BLOCKED` | 动作通道 + P2 批次 |
| 站点授权三层（屏蔽优先 / 白名单免问 / 未命中问一次 / 全局关） | `agent-sites.js` | 36 项 |
| 隐私快照整条加密（`safeStorage`，密钥不可用一律不存） | `page-cache.js` + `main.js` | 缓存 67 项 |
| 诊断包导出限 downloads/temp | `main.js` 的 `nyx:diagnostics:export` | P2 批次 17 项 |

**已知未做**：`EnableEmbeddedAsarIntegrityValidation` 刻意不开（electron-builder 不写 asar 内嵌标记，硬开会让装了起不来）。

---

## 7. 回归：49 步清单与实测

一键：`node scripts/verify-all.js`（日志用 `*>&1 | Out-File -Encoding utf8`）。
**实测（本轮）**：49 步 —— **48 通过 / 1 失败 / 681 秒 / 1104 项**。
唯一失败：第 2 步「接入说明按当前状态生成，能一键复制」→ `系统剪贴板当前不可用`，**会话锁屏所致**（`Get-Clipboard` 同时报错），断言未改。

| # | 步骤 | 声明项数 |
| --- | --- | --- |
| 1 | 地址栏建议回归 | 68 |
| 2 | 界面体验回归 | 139 |
| 3 | 出站链路守卫 | 14 |
| 4 | 下载链路回归 | 16 |
| 5 | 图形性能策略 | 15 |
| 6 | 安全基线对照 | 20 |
| 7 | 外壳防护基线 | 19 |
| 8 | 录屏检测回归 | 14 |
| 9 | 动作通道回归 | 24 |
| 10 | 页面读取回归 | 34 |
| 11 | agent 审计回归 | 17 |
| 12 | agent 站点授权回归 | 36 |
| 13 | agent 接入模式回归 | 16 |
| 14 | 页面摘要回归 | 26 |
| 15 | 标签生命周期回归 | 18 |
| 16 | 标签休眠回归 | 10 |
| 17 | 断网判定回归 | 10 |
| 18 | 离线页面缓存 | 67 |
| 19 | 运行时兼容 | 10 |
| 20 | 发版门禁接线 | 48 |
| 21 | 代码签名 | 35 |
| 22 | agent 改设置回归 | 34 |
| 23 | 打包产物冒烟 | 12 |
| 24 | 进程可辨识回归 | 11 |
| 25 | 网络面板跟随回归 | 13 |
| 26 | agent 状态灯回归 | 11 |
| 27 | 工具栏回归 | 10 |
| 28 | 动效档位回归 | 8 |
| 29 | 首次引导回归 | 13 |
| 30 | 首次引导 e2e | 7 |
| 31 | agent 接入说明回归 | 9 |
| 32 | 主题回归 | 7 |
| 33 | 外壳导航守卫回归 | 13 |
| 34 | 更新通道准入回归 | 10 |
| 35 | 更新签名回归 | 17 |
| 36 | 隐私指纹面回归 | 66 |
| 37 | IPC 发送方校验回归 | 10 |
| 38 | 本地接口鉴权回归 | 9 |
| 39 | 安全审计 P2 批次回归 | 17 |
| 40 | 站点设备权限回归 | 22 |
| 41 | 模式切换缓存回归 | 21 |
| 42 | 标签停靠回归 | 26 |
| 43 | 切换动画回归 | 20 |
| 44 | 急停快捷键回归 | 12 |
| 45 | agent 导航预算回归 | 24 |
| 46 | 界面字号档位回归 | 15 |
| 47 | 应用页导航预算 e2e | 7 |
| 48 | 接入外壳词表回归 | 21 |
| 49 | 隐私自检判定引擎回归 | 18 |

> **声明合计 1119 项，实测报数 1104 项**——差额来自「逐项标签写的是此刻预期值、脚本自己数出来的是实际值」，以及第 48 步（见 §11-F1）。以脚本实际输出为准。

### 7.1 单跑与复现命令

```powershell
# 只跑一项（例：隐私)
node scripts\verify-privacy-surface.js
node scripts\verify-privacy-check.js
# 全量（别与任何 dist 实例并行；并行会互相打断 CDP）
node scripts\verify-all.js *>&1 | Out-File -Encoding utf8 temp\v.log

# 隐私自检存证（需要 7897 可用代理，否则隐私模式进不去）
node scripts\privacy-audit.js
node scripts\privacy-audit.js --check

# 安装器四条路径（需管理员 + 两个版本安装包；不会碰你的真实数据，脚本自带备份还原）
node scripts\test-installer-e2e.js --installer=dist\Nyx-Setup-1.18.0.exe --from=dist\legacy\Nyx-Setup-1.17.2.exe --preflight-only

# 包内冒烟 / 完整性
node scripts\verify-packaged-smoke.js
node scripts\verify-integrity.js
```

---

## 8. 数据落点（审计时按需只读检查）

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\Nyx\agent-sites.json` | 站点三层授权（屏蔽 / 白名单，域名级 + `mode:'prefix'`） |
| `%APPDATA%\Nyx\toolbox-prefs.json` | 抓包慢请求阈值、导航预算（全局 + 按站点） |
| `%APPDATA%\Nyx\ui-preferences.json` | 主题、动效、字号、折叠态、`privacyBannerSeen` |
| `%APPDATA%\Nyx\page-cache.json` / `private-cache.json` | 离线快照（后者整条 `safeStorage` 加密、24 小时作废、上限 20） |
| `%APPDATA%\Nyx\agent-audit.jsonl` | agent 每动作两条记录（不留正文，只留长度 + sha256） |
| `%APPDATA%\Nyx\diagnostics\errors.jsonl` | 诊断（环形 300 条 + 导出 ZIP） |
| `%APPDATA%\Nyx\update-signing-key.pem` | 更新清单签名私钥（**绝不入库**） |
| `%APPDATA%\Nyx\updates` / `updates-archive` | 更新源 / 留档 |

---

## 9. 已知边界（请当作审计基线，而不是缺陷）

1. 自检只证明它测到的面：**TLS 指纹、HTTP/2 帧序、字体全量枚举不在范围**；C3（DNS 出口）恒「测不到」。
2. 没有隐私评分，以后也不会有单一分数。
3. 时区「未对齐」时不伪装（代理给不出出口地区）；日志如实写「未对齐」。
4. 停靠标签超 12 个按原地址重开（保的是 WebContents，不是整份会话）。
5. 切换动画 1 秒，可在设置里关掉（关掉即瞬切）。
6. 字体只对齐度量、不改字形；靠字形轮廓的指纹仍可能读到。
7. 自签名 ≠ 公信签名：SmartScreen 仍提示「未知发布者」。
8. `EnableEmbeddedAsarIntegrityValidation` 未开（会砸掉启动）。
9. 差分命中率恒 0.00%（NSIS/LZMA 固实压缩），`DIFF_MIN_HIT_RATE = 0.2` 闸门保留，否则退化成 243 次 Range 请求。
10. 1.17.11–1.17.20 **从未发布**；停在 1.17.10 及更早、且更新源里的包已被删的机器，需**手动装一次**才能回到自动升级。
11. 自检跑在本地页面（起始页 / 设置页），不含站点在服务端能读到的信息。
12. `campus` 身份（另一条线的 net-terms）**不在本版**。

---

## 10. 审计须知：五个已发现的问题（先看这里）

### F1（阻断级，干净克隆）回归第 48 步引用了未提交的脚本
- 现象：`scripts/verify-all.js`（已提交）第 48 步 `script: 'verify-net-terms.js'`，而 `scripts/verify-net-terms.js` **未提交**（`git status` 里是 `??`，属另一条线的半成品）。工作区能跑过，是因为文件在本地。
- 影响：**任何人 clone 下来跑 `node scripts/verify-all.js`，第 48 步必失败**（文件不存在）。
- 待你决定：① 提交这两个文件（等于把 net-terms 半成品纳入仓库）；② 或把第 48 步从 `STEPS` 摘掉，等那条线做完再加回。**我没有擅自动它**（约定是「另一条线的文件不提交也不回滚」）。

### F2（口径）声明 1119 项 vs 实测 1104 项
- 原因：`verify-all.js` 的 `items` 是人工写的预期值，实际项数由各脚本自己打印；第 48 步含 21 项未提交脚本，加上个别脚本新增断言后标签未同步。
- 建议：审计以**脚本实际输出**（1104）为准；要不要把标签校到分毫不差，是一种取舍（既往约定是"差一个数字也算没做完"，这条现在有 15 项漂移，需要你决定要不要清一遍）。

### F3（环境）锁屏时「复制」类断言必然失败
- 现象：`clipboard.writeText()` 静默失败、读回空串；`Get-Clipboard` / `Set-Clipboard` 同时报 `所请求的剪贴板操作失败。`
- 影响：第 2 步「接入说明一键复制」红。
- 结论：**不是产品回归**，断言未改；解锁后重跑即绿。

### F4（设计）交接单要求的字节复核 `nyx-keep-package` 对 NSIS 无效
- 那串标记只存在于 `build/installer.nsh` 的编译脚本（`Rename … .nyx-keep-package.exe`），LZMA 压过之后 exe 字节流里查不到（实测 `Buffer.includes` = false）。
- 已改用**功能验证**：装完后 `%APPDATA%\Nyx\updates\Nyx-Setup-1.18.0.exe` 仍在（实测 True），这才是 `16b25b0` 修的东西。

### F5（流程）尚未 tag / push
- `git tag v1.18.0` 与 push 都没做（交接单要求需你点头）。远端仓库仍停在 1.17.9，push 跨度 = 1.17.9 → 1.18.0。

---

## 11. 建议审计路线（按投入产出排序）

1. **读三个新文件**：`src/core/privacy-check.js`（判定口径）、`scripts/verify-privacy-check.js`（口径有没有被绕过）、`scripts/privacy-audit.js`（存证是否可信）。
2. **真跑一次自检**：开隐私模式 → 设置 → 隐私自检 → 「运行自检」；对照 `docs/privacy-audit/1.18.0.md` 看是否一致；再故意用一个没走代理的页面复跑，确认结论会变红（而不是永远"正常"）。
3. **验"观察值不能自己作证"**：`judgeItem('A5', {cores:8}, null).level` 应为 `unknown`（可直接 `node -e` 调模块）。
4. **验应用页装配**：隐私模式下打开起始页与设置页，主世界读 `navigator.hardwareConcurrency` 与 `window.__nyxSurface`，应为画像值（8）与版本号 2。
5. **验更新链**：`latest.json` 三一致 + 清单签名可验 + 安装包签名有效；再确认「装完更新源里的包还在」。
6. **验外壳守卫**：外壳里 `location.href='https://example.com'` 应被拦下并有可见提示；`history.pushState` 后刷新不应逃逸。
7. **跑一遍全量回归**（解锁状态下），确认 49/49。
8. 需要更细的逐项证据 → 看 `docs/实测修复台账.md`（每项都有「现象 / 改法 / 验证」）与 `docs/Nyx-1.18.0-发版记录.md`。

---

## 12. 附录

### A. 本版提交范围

| 提交 | 内容 | 规模 |
| --- | --- | --- |
| `c06f2c1` | 隐私自检：引擎 + 卡片 + 横幅 | 13 文件 +1673/-30 |
| `569595c` | 应用页装配 + 存证脚本 + `privacy:audit` | 4 文件 +384/-3 |
| `e09e56f` | 发版记录 / CHANGELOG / README / AGENTS / 台账 / 存证 | 7 文件 +236/-4 |

### B. 关键命令速查

```powershell
# 打包（含签名前回归 38 项）
node scripts\build-signed.js --config.directories.output=dist
# 发版（写更新源 + 留档 + 差分；中文 notes 必须走 temp/*.js + spawnSync 数组）
node scripts\make-release.js --release --prune --with-installer-test
# 回退更新源到某版本
node scripts\make-release.js --restore --version=1.17.10
# 启动源码版（隔离数据，别碰真实配置）
$env:NYX_USER_DATA="$env:TEMP\nyx-audit-$(Get-Random)"; node_modules\electron\dist\electron.exe .
```

### C. 审计时不要做的事

- **不要**用 `Get-Content` 判断文件内容对不对（pwsh 按 GBK 解码，中文会显示成乱码；本仓库已因此误判过两次）。
- **不要**并发跑两个起 Electron 的脚本（CDP 会互相打断，表现为"主窗口未就绪"的假失败）。
- **不要**在真实 `%APPDATA%\Nyx` 上做破坏性实验；一律 `NYX_USER_DATA` 指向 `%TEMP%` 隔离目录。
- **不要**按进程名杀进程（用完整路径；本仓库涉及 `node_modules\electron\dist\electron.exe`、`dist\win-unpacked\Nyx.exe`、`%LOCALAPPDATA%\Programs\Nyx\Nyx.exe`）。
- **不要**把「自检结果正常」当成「匿名」：它只证明它测到的面。

---

（完。要我把某一节展开成独立文档，或按你的审计清单逐条对齐，说一声。）
