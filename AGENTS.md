# AGENTS.md — Nyx 工作区全局规则（门禁，不是建议）

> 任何接手本仓库的人/对话，动手前先读完本文件。
> 本文件与 `docs/实测修复台账.md` 是唯一进度源；与它们冲突的口头描述一律以本文件为准。

---

## 0. 一句话总则

**一次只做一件事；失败必须可见；没证据不算改完。**

---

## 1. 工作区地图

| 路径 | 是什么 | 能不能动 |
| --- | --- | --- |
| `src/main.js` | 主进程唯一入口（约 6100 行，WebContentsView 标签架构） | 可动，改动前先读上下文 |
| `src/core/*.js` | 28 个主进程模块（会话/代理/内核桥接/工具箱/更新器/扩展…） | 可动 |
| `src/renderer/*` | 外壳与各浮层页面（`index.html` 外壳、`settings.*` 设置、`addr-suggest.*`、`bm-*`、`toolbox-ui.js`、`proxy-center.*`） | 可动 |
| `src/preload.js` / `src/preload-tab.js` | contextBridge 暴露面（**安全边界**） | 可动，加接口要同步白名单 |
| `scripts/*` | 回归与发版脚本 | 可动，验收脚本必须同步项数 |
| `docs/*` | 发版记录 / CHANGELOG / 规格 / 安装须知 | 可动 |
| `vendor/mihomo/` | 内置代理内核二进制 + geo 数据（**不入库**，`npm run setup-vendor` 拉取） | 只读，禁止改 |
| `node_modules/`、`dist/`、`temp/`、`_attic/` | 依赖 / 构建产物 / 临时 / 归档 | 不入库 |
| `/main.js`（根目录） | 历史遗留副本，**真正的入口是 `src/main.js`** | 已在 .gitignore，别读它 |

---

## 2. 固定事实（2026-11-12 基线）

- 版本：`package.json` = **1.17.2**；**已发布**的产物 `dist/Nyx-Setup-1.17.2.exe` 是 43.8.10 打的那一个（118,516,372 字节，sha256 `c17386b7c80061f98d8c0d0b3da4abed4a26a2065ef12e07f2bb3d433ea1037c`）；**当前 dist 目录里的是 Electron 45.3.2 重打的同名包**（127,117,707 字节，sha256 `74da45e2b13d902f9c7cfff3c82ebf0a4429329ff9930983221a454107ef90d8`），**没有发布**——同版本号两份不同字节的包会让人以为更新失败，要发就先升 1.17.3。
- 运行时：Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2；Windows。
- 运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用）。
- 回归基线（本轮实测，全绿）：`npm run verify` = 地址栏建议 **68 项** + 界面体验 **114 项** + 出站链路守卫 **14 项** + 下载链路 **16 项** + 图形性能策略 **14 项** + 安全基线对照 **20 项** + 外壳防护基线 **19 项** + 录屏检测 **14 项** + 动作通道 **20 项** + 页面读取 **19 项** + agent 审计 **17 项** + agent 站点授权 **34 项** + agent 接入模式 **16 项** + 页面摘要 **20 项** + 标签生命周期 **18 项** + 标签休眠 **10 项** + 断网判定 **10 项** + 离线页面缓存 **23 项** + 运行时兼容 **6 项** + 打包冒烟 **11 项** = **483 项 / 20 个脚本 / 208 秒**。
- 安装器 e2e（不进 `npm run verify`）：`scripts/test-installer-e2e.js` 真机跑 全新 → 降级 → 升级 → 修复 → 保留数据卸载 → 完全卸载，**56 项断言**；`--cross` 跨两版模式（旧版装→seed 旧格式数据→覆盖装新版→两次启动）**57 项断言（56 通过 / 1 明确跳过）**；`make-release.js --with-installer-test` 已把它接进发版门禁（默认不跑，但摘要必打印原因与命令）。
- 更新源：`%APPDATA%\Nyx\updates`（`latest.json` + 安装包 + `.blocks.json` + `extensions.json`）；留档 `%APPDATA%\Nyx\updates-archive\<版本>`。
- 安装器：NSIS，`perMachine:false`（装到用户目录），自定义脚本 `build/installer.nsh`、打包后钩子 `build/after-pack.js`。
- npm 命令必须用 `& 'C:\Program Files\nodejs\npm.cmd' run <script>`（`npm.ps1` 被执行策略拦）。

---

## 3. 一件事一轮的工作流（严格七步）

1. **取证**：先在代码里找到与该现象对应的**具体行**，写下「现象 → 代码位置 → 为什么会导致这个现象」。
2. **复现**：能在本机复现的必须复现（脚本/探针放 `temp/`，跑完删）。复现不了的写清「为什么复现不了、靠什么间接证据」。
3. **改**：最小改动，不顺手重构。涉及用户可见行为时，**同步加前台提示 + 落日志**。
4. **自动验收**：为这一条加断言，写进已有 `scripts/verify-*.js`；同时把 `scripts/verify-all.js` 里的项数标签改成实际值（差一个数字也算没做完）。
5. **全量回归**：`npm run verify` 必须全绿才允许提交。
6. **提交**：一条一个提交，信息格式 `fix(A1): 中文一句话现象`；**一项一提交，不许攒**。
7. **交付**：向用户报三行——「现象 / 改了什么 / 怎么验证（含数字）」；同时更新 `docs/实测修复台账.md` 的状态与提交号。

---

## 4. 提交与发版门禁

- 提交前：`npm run verify` 全绿 + `git status` 只剩本次改动。
- 发版顺序**固定不可跳**：
  1. 改 `package.json` 版本号 → 2. `npm run dist` → 3. `npm run verify:integrity` / 冒烟通过 → 4. `node scripts/make-release.js --release --prune` → 5. 写 `docs/Nyx-<版本>-发版记录.md` + 更新 `docs/CHANGELOG.md` + `README.md` 变更 → 6. `git commit` + `git tag v<版本>`。
- **未经用户明确要求，不发版、不改版本号、不写更新源。**
- 中文 `--notes` 绝不能出现在 PowerShell 命令行里（会被代码页转成乱码）：写一个 `temp/*.js`，用 `spawnSync` 以数组传参，跑完删除并复核 `latest.json` 的 notes 是否为正常中文。

---

## 5. 硬性禁止清单（红线，违反即回滚）

1. **禁止用 PowerShell 的 `Get-Content`/`Set-Content`/`-replace` 改 UTF-8 源码**——pwsh 按 GBK 解码会造成双编码乱码并毁整份文件（本仓库已发生过一次，靠 `git checkout --` 恢复）。改文件只用 `edit`/`write` 工具。
2. **禁止静默失败 / 静默回退 / 静默跳过**：错误必须有前台提示（中文原因）+ 日志；状态变化必须让用户看得见。
3. **禁止把「下载」改成后台静默下载**：用户必须能看到进度、失败原因、文件落点。
4. **禁止按进程名杀进程**（`taskkill /IM electron.exe` 之类），只能按可执行文件完整路径匹配本仓库的两个 exe。
5. **禁止在真实用户数据上做破坏性实验**：测试一律 `NYX_USER_DATA` 指到 `%TEMP%` 隔离目录；`%APPDATA%\Nyx` 只读。
6. **禁止新增第三方运行时依赖**（现有两项除外）；禁止手改 `package-lock.json`；禁止动 `vendor/` 二进制。
7. **禁止靠修改 `.gitignore`/测试脚本的断言去"消掉"失败**；不许把失败断言改成永远成立。
8. **禁止改写 git 历史 / force push**；历史提交只许追加。
9. **产品红线**：不做内置 AI/生成式功能；隐私模式不落盘、必须经代理（或用户显式选择「真实 IP」并明确告知边界）。
10. **禁止 spawn Electron 前不清理环境**：必须 `delete env.ELECTRON_RUN_AS_NODE`，否则 `src/main.js` 启动即崩（`Cannot read properties of undefined (reading 'isPackaged')`）。
11. **禁止写死调试端口**：一律用 `scripts/lib/free-port.js` 的 `pickFreePort()`（Windows 有 Hyper-V/WinNAT 保留段，`bind` 会报 `0x271D`，表现为"主窗口未就绪"的假失败）。
12. **禁止在改动功能的同时顺手重排版/重命名/搬文件**；一项一件事。

---

## 6. 验证脚本约定

- 二十个脚本：`verify-address-suggest.js`（地址栏 68）、`verify-ui-polish.js`（界面 114）、`verify-link-guard.js`（出站链路守卫 14，纯 Node 不启动 Electron）、`verify-downloads.js`（下载链路 16，纯 Node 不启动 Electron）、`verify-gpu-policy.js`（图形性能策略 14，纯 Node 不启动 Electron）、`verify-security-baseline.js`（安全基线对照 20，纯 Node 不启动 Electron）、`verify-security-switches.js`（外壳防护基线 19，纯 Node 不启动 Electron）、`verify-screen-watch.js`（录屏 / 被远控检测 14，纯 Node 不启动 Electron）、`verify-agent-dispatch.js`（agent 统一动作通道 20，纯 Node 不启动 Electron）、`verify-page-reader.js`（页面读取与稳定元素 id 19，纯 Node 不启动 Electron）、`verify-agent-audit.js`（agent 动作留痕 17，纯 Node 不启动 Electron）、`verify-agent-sites.js`（agent 站点三层授权 + 导入导出与格式迁移 34，纯 Node 不启动 Electron）、`verify-agent-mode.js`（agent 接入模式与两步确认 16，纯 Node 不启动 Electron）、`verify-page-digest.js`（页面摘要与拦截统计 20，纯 Node 不启动 Electron）、`verify-tab-lifecycle.js`（标签生命周期判定 18，纯 Node 不启动 Electron）、`verify-tab-sleep.js`（标签休眠与唤醒端到端 10，真实起实例，`NYX_TAB_SLEEP_MS=1200`）、`verify-network-state.js`（断网判定与断网横幅 10，纯 Node 不启动 Electron）、`verify-page-cache.js`（离线页面缓存、开关与 v2 块结构 23，纯 Node 不启动 Electron）、`verify-runtime-compat.js`（运行时兼容：剪贴板异步化与版本三处一致 6，纯 Node 不启动 Electron）、`verify-packaged-smoke.js`（包内 11，缺 `dist/win-unpacked` 时跳过）。另有 `bench-transfer.js`（吞吐基线，**不进回归**，测大文件快慢用）、`test-installer-e2e.js`（安装器四条路径真机复验 + `--cross` 跨两版，需管理员权限与两个版本的安装包，**不进回归**，但已接进 `make-release --with-installer-test`）。
- 环境不满足而无法验证的断言（例如系统剪贴板被别的进程独占时）要**显式记为「跳过」并打印原因**，既不许静默通过，也不许删断言（红线 7）。
- 新增断言写在对应脚本里，标签复用中文「（vX.Y.Z）」后缀；项数必须同步到 `scripts/verify-all.js` 的 `items` 与注释。
- CDP 端到端：Node 24 全局 `WebSocket`，`--remote-debugging-port` 用 `pickFreePort()`。
- `contextBridge` 暴露的 `window.nyx` 是**冻结代理**：测试里 `window.nyx.foo = stub` 会静默失效。要测状态机就把判定抽成**纯函数**（如 `trackCoursePause(state, now, prev)`）直接调。
- `pwsh` 报 `[exit code: 1]` 不等于失败（npm warn/stderr 会触发 NativeCommandError），以脚本自己打印的汇总结论为准。
- 浮层类页面在 `WebContentsView` 架构下必须是独立无边框 `BrowserWindow`，输入相邻的浮层要 `focusable:false` + `showInactive()`，且**不能**在主窗口 `blur/move/resize` 时自动关闭。

---

## 7. 已知坑（逐条带原因，别重复踩）

| 坑 | 原因 | 正确做法 |
| --- | --- | --- |
| 改文件后整篇中文变 `涓€閿洖褰?` | pwsh 按 GBK 读 UTF-8 | 只用 `edit`/`write`；已经坏了就 `git checkout -- <file>` |
| `--notes` 中文变乱码 | PowerShell 命令行代码页 | `temp/*.js` + `spawnSync` 数组传参 |
| 启动即崩 `isPackaged` | 环境里 `ELECTRON_RUN_AS_NODE=1` | spawn 前 `delete env.ELECTRON_RUN_AS_NODE` |
| 「主窗口未就绪」且无 CDP | 调试端口落在系统保留段 | `pickFreePort()` |
| `npm.ps1 cannot be loaded` | 执行策略 | 用 `npm.cmd` 全路径 |
| `npm run dist` 报 `Access is denied: d3dcompiler_47.dll` | `dist\win-unpacked` 被运行中的进程占用 | 先关本仓库进程，或 `--config.directories.output=dist-next` |
| 测试断言"通过"但功能其实是坏的 | 对冻结的 `window.nyx` 打桩 | 抽纯函数测 |
| 建议浮层刚打开就被关 | `createTab` 触发的状态推送会关闭浮层 | 测试里等 1.5s 再 query |
| 同名扩展出现两条记录 | 记录 id 由源路径派生 | 安装前先按名称复用已有条目 |

---

## 8. 交付格式（每条修复都要）

```
现象：<用户/测试者看到什么，必要时带原话>
改动：<改了哪些文件哪几行，为什么这么改>
验证：<自动断言 N 项 + 手工步骤 + 数字证据>
提交：<commit 短号> ｜ 台账：<docs/实测修复台账.md#A1>
```

---

## 9. 当前任务指针

- 正在执行的清单：`docs/实测修复台账.md`（来源：`Nyx浏览器v1实测修复清单.md`，12 项）。
- 顺序：**C1 → A4 → A2 → A1 → B4+B5 → B1/B2/B3 → A3/A5 → C2/C3 → C4**，一项一提交。
- 进度：C1（`b848b6b`）、A4（`d33be32` + `018780b` + `2c9f248`）、A2（`4919583`）、A1（`e214f9d`）、B4+B5（`533ea57`）、B1（`e7c5288`）、B2（`6bb61f0`）、B3（`1a6e6e1`）、A3（`8942dab`，已测基线 + 已可量化）、A5（`9d76966`，默认核显优先）、C2（`321da29`，安全基线可自查）、C3（`9533ef8`，外壳防护现值 + 注入演示）、C4（`a8e42d8`，进隐私模式前查录屏与被远控）**已全部完成（12/12）**。
- 清单已清空：下一步等用户决定（候选：发版 1.17.1 / 安装器端到端复验 / 修更新源 `latest.json` 指向已删 exe 的 404 / 补 `extensions.json` 的 history / 做一次真机安装版冒烟）。

### 9.1 当前清单：Agent 化 A–G（2026-11-14 开工）

- 来源：`Nyx浏览器Agent化实现清单.md`（A–G 七项 + §4 验收清单 + 六条不可回退约束）。
- 执行顺序（已与清单 §0 的意图对齐，**C 是枢纽必须最先**）：**C → B → D → E → A → F → G**，一项一提交。
- 进度：**C 完成（`79c9477`）**、**B 完成（`4795ab4`）**、**D 完成（`9a811c3`）**、**E 完成（`6ae78a8`）**、**A 完成（`ea4bb34`）**、**F 完成（`65ea440`）**、**G 完成（`1b6711c` + 休眠阈值设置项 `d2bc416` + 断网判定 `9801414`）** —— **A–G 七项全部完成**（明细见 `docs/实测修复台账.md` 的「Agent 化清单（A–G）状态」表）。E 的落点：`src/core/agent-sites.js`（三层判定 + 域名级名单）、`main.js` 的 `readAgentSites/writeAgentSites/askAgentSiteTrust/authorizeAgentAction/registerAgentSitesIpc`、`agent-dispatch` 的 `await authorize`、设置「Agent 访问 → 站点授权」卡片。A 的落点：`src/core/agent-mode.js`（模式表 + 两步确认状态机 + 状态载荷）、`main.js` 的 `readBootAgentMode/writeAgentMode/registerAgentModeIpc`（启动前 appendSwitch CDP 端口）、外壳 `#agent-mode-flag`、设置「Agent 访问 → 接入模式」卡片。F 的落点：`src/core/page-digest.js`（切句/关键词/抽取式摘要/网络摘要）、`main.js` 的 `registerDigestIpc`（默认关必须给原因）、`ui-store` 的 `digestEnabled`、外壳 `#btn-digest` / `#digest-panel`、设置「页面摘要」卡片。G 的落点：`src/core/tab-lifecycle.js`（三态判定 + 阈值解析 + 中文原因）、`tabs.js` 的 `startLifecycle/applyLifecycle/sleepTab/wakeTab/markAgentDriven/setAgentSessionActive`、`main.js` 的 `readTabSleepAfterMs` 与 `touchAgentSession`（审计入口续命）、外壳 `.tab.is-asleep` 淡显；断网部分：`src/core/link-guard.js` 的 `offline` 动作、`src/core/network-state.js`、`main.js` 的 `onlineState()` + `nyx:net:state`、外壳 `#net-offline-flag`。
- G 的诚实边界（写进台账，也要对用户说）：休眠等于卸载页面，**未提交的输入与滚动位置会丢**；5 秒巡检最晚晚 5 秒才睡；「降低占用」只做到"闲置标签不占内存"，没做离线/在线切换策略。休眠阈值已做成设置项（`d2bc416`：外观 → 标签休眠，0 = 关闭，1–240 分钟，改完立刻生效，环境变量 `NYX_TAB_SLEEP_MS` 仅作验证旋钮并优先于界面设置）。
- 现状取证（开工前别再重复挖）：`src/core/actions.js:96` 已有 8 种动作但**没有 dispatch 层** —— **已在 C 修掉**；`src/api/http-api.js:82` 只绑回环 + Token；`src/mcp/server.js:112` 是**独立 stdio 进程转发 HTTP**，`nyx_screenshot` 已降级为「仅人工辅助」（B 把结构化的 `nyx_read_page` 顶成了首选）；`downloads.js` 的 `attach()` 正好挂下载审计。B 的落点：`src/core/page-reader.js`（读页面 + 稳定 id）、`actions.js` 的 `readPage`/`elementId`、`/capabilities` 的 9 项动作。D 的落点：`src/core/agent-audit.js`（1000 条环形缓冲 + `<userData>/agent-audit.jsonl` 追加）、`main.js` 的 `stopAgent/resumeAgent/agentStatusPayload/registerAgentAuditIpc/registerAgentStopShortcut`、外壳 `#btn-agent-stop`、设置「Agent 访问」分区。
- 已定的四个决策（清单 §5 待确认项，用户未反对即按此执行）：
  1. 未命中站点**每次进站问一次**，确认框带「这次会话信任该域名」勾选（仅本进程有效、不落盘）。
  2. 名单**先域名级**（子域继承；两条都在名单里时屏蔽赢），数据留 `mode: 'host'|'prefix'` 字段以便日后扩 URL 前缀。
  3. 外部接入模式**只记录经过浏览器的部分** + UI 常驻「审计不完整」，不做 CDP 侧二次录制。
  4. 自动总结**侧栏展示 + 一键复制**，不落文件、不进随手记；**纯抽取式，不调任何生成式 API**（产品红线）。
- 开工要点：急停的诚实边界写进 UI（单条 `executeJavaScript` 无法在 V8 中途掐断，保证「不再派发下一条 + 3 秒内新动作全拒」）；切换外部模式**需要重启**（CDP 端口只能在启动时开），必须在 UI 明说；E 的两个确认窗与 D 的审计面沿用 `ui-ux-pro-max` 规范（主题令牌、零新增色值、`:focus-visible`、`role=alert`）。

### 9.2 候选批次（2026-11-14 晚，五项，全部完成）

- ① 安装器端到端复验 `dc44f90`：`test-installer-e2e.js` 加 `--from=<旧版包>`，真跑 降级 → 升级 → 修复；不给旧包时显式记 SKIP。带两个包实测 **56 项断言全通过**（降级 `模式=降级安装`/`FileVersion=1.17.0`，升级 `模式=升级安装`/`FileVersion=1.17.1` + `--verify-integrity` exit 0）。
- ② C2 联网复核 `4d47438`：已复核结论写进 `docs/Nyx-安全基线-C2-CVE对照.md`（CVE-2026-113800/114122 已覆盖；CVE-2026-113798 需 Electron 43.7.6+；CVE-2026-115570 需 43.8.1+；Chromium 150 分支已落后，修复在 156.x），新增第 6 节升级计划；`security-baseline.js` 的 `reviewedAt` 改 2026-11-14，声明版本仍是真实运行的 43.7.4。
- ③ 离线可用第一版 `52c61cd`：`src/core/page-cache.js`（http(s) 正文快照，LRU 50，**隐私模式不落盘**，正文 < 20 字不缓存）+ 失败页「上次读到的内容（N 分钟前抓取）」+ 说明这是缓存快照；新增 `verify-page-cache.js` 14 项 + 界面 2 项。
- ④ 站点名单 URL 前缀 `d8a06c3`：`agent-sites.js` 规则带 `mode: host|prefix`，prefix 按路径段匹配（`example.com/admin` 不覆盖 `/administrator`）；设置里两处下拉 + 「前缀」标记；`verify-agent-sites.js` 24 项。
- ⑤ CHANGELOG 验收口径说明（并入 `4d47438`）：断言列是当时的统计口径，改了脚本数会让历史数字看起来"涨了很多"，跨版本请看各自发版记录；历史数字未改。
- 本批次回归：**19 个脚本 / 453 项 / 197 秒**全绿。离线缓存与 URL 前缀属于 1.17.1 之后的新改动，已随 **1.17.2** 打包。

### 9.3 1.17.2 批次（2026-11-14 夜，五项，已发布）

- 顺序：① 升 Electron → ③ 离线缓存开关 → ④ 名单导入导出 → ⑤ e2e 接门禁 → ② 发 1.17.2，全部完成。
- 提交：`3ceb7e1`（离线缓存开关 + `UiStore.get()` 真 bug）、`511552e`（名单导入导出 + 全局开关跟文件走）、`6de6da0`（Electron 43.7.4 → 43.8.10 + 安全基线三处）、`e812ce5`（`make-release --with-installer-test`）。
- 发布：`dist\Nyx-Setup-1.17.2.exe` 118,516,372 字节、sha256 `c17386b7c80061f98d8c0d0b3da4abed4a26a2065ef12e07f2bb3d433ea1037c`；完整性 9/9、冒烟 11/11、安装器 e2e **56/56**、真机安装 1.17.2 启动正常。
- 文档：`docs/Nyx-1.17.2-发版记录.md`、`docs/CHANGELOG.md`（索引 + 1.17.2 小节）、`README.md`（离线可读/休眠两条特性、名单导入导出与 e2e 门禁）。
- 本批次回归：**19 个脚本 / 466 项 / 206 秒**全绿。
- 待办（未开工，等用户决定）：发版之后的新候选、离线缓存快照是否要支持图片、站点名单的导出格式版本迁移。

### 9.4 Electron 45 批次（2026-11-14 深夜，五项，**未发版**）

- 顺序：① 升 Electron 45 → ③ 导出格式迁移 → ② 离线快照 v2 → ④ 拦截请求入摘要 → ⑤ 跨两版升级实测，全部完成。
- 提交：`bfbd057`（摘要区分被拦下/真失败）、`c04ba23`（离线快照 v2：块结构 + 图片说明）、`025717a`（名单导出 v2 + 导入迁移）、`cc00b2c`（安装器 e2e `--cross` 跨两版）、`361b9d6`（Electron 43.8.10 → 45.3.2 + 剪贴板异步兼容层 + `verify-runtime-compat.js`）。
- 运行时：**Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2**（Chromium 150 分支漂移就此收口）。
- 重打包（未发布）：`dist\Nyx-Setup-1.17.2.exe` 127,117,707 字节、sha256 `74da45e2b13d902f9c7cfff3c82ebf0a4429329ff9930983221a454107ef90d8`；完整性 9/9、冒烟 11/11、静默安装 exit 0、启动 5 进程 681.2 MB。
- 本批次回归：**20 个脚本 / 483 项 / 208 秒**全绿。
- 待办：把 Electron 45 这一批发出去要**先升到 1.17.3**（同版本号换字节会让更新判定混乱）；离线快照目前只留图片 alt，没有图片本体；剪贴板兼容层是为了同时兼容 43（同步）与 45（异步），等 43 线彻底退场可以简化。
