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

- 版本：`package.json` = **1.17.4**；**已发布**的产物 `dist/Nyx-Setup-1.17.4.exe`（Electron 45.3.2，127,192,896 字节，sha256 `f6c9d53a39eed8dc707daba0a4240820395beb1251b88177f1d8f9c3747e5566`，签名 `CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`）；更新源 `latest.json` 已指向它。留档保留 1.17.4 / 1.17.3 / 1.17.2（1.17.1 已清理）；`dist-sign` 里还有上次签的 1.17.3，**验签按版本号挑包**（`scripts/lib/pick-artifact.js`），不会再验到旧包。
- 运行时：Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2；Windows。
- 运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用）。
- 回归基线（本轮实测，全绿）：`npm run verify` = 地址栏建议 **68 项** + 界面体验 **117 项** + 出站链路守卫 **14 项** + 下载链路 **16 项** + 图形性能策略 **14 项** + 安全基线对照 **20 项** + 外壳防护基线 **19 项** + 录屏检测 **14 项** + 动作通道 **20 项** + 页面读取 **19 项** + agent 审计 **17 项** + agent 站点授权 **34 项** + agent 接入模式 **16 项** + 页面摘要（Markdown / CSV 导出）**26 项** + 标签生命周期 **18 项** + 标签休眠 **10 项** + 断网判定 **10 项** + 离线页面缓存（隐私加密·两份站点名单·名单导入导出）**45 项** + 运行时兼容 **9 项** + 发版门禁接线（验签挑包·差分闸门）**22 项** + 代码签名（有效期·凭据管理器）**27 项** + agent 改设置（多步撤销）**18 项** + 打包冒烟 **11 项** = **584 项 / 23 个脚本 / 209 秒**。
- 安装器 e2e（不进 `npm run verify`）：`scripts/test-installer-e2e.js` 真机跑 全新 → 降级 → 升级 → 修复 → 保留数据卸载 → 完全卸载，**56 项断言**；`--cross` 跨两版模式（旧版装→seed 旧格式数据→覆盖装新版→两次启动）**57 项断言（56 通过 / 1 明确跳过）**；归档基线放 `dist\legacy`（当前 1.16.0 / 1.17.1 / 1.17.2，由 `npm run sync:legacy` 轮换维护），`--cross` 不带 `--from` 会自动选最老那份；`make-release.js --with-installer-test` 已把它接进发版门禁（默认不跑，但摘要必打印原因与命令）。
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

- 二十三个脚本：`verify-address-suggest.js`（地址栏 68）、`verify-ui-polish.js`（界面 117）、`verify-link-guard.js`（出站链路守卫 14，纯 Node 不启动 Electron）、`verify-downloads.js`（下载链路 16，纯 Node 不启动 Electron）、`verify-gpu-policy.js`（图形性能策略 14，纯 Node 不启动 Electron）、`verify-security-baseline.js`（安全基线对照 20，纯 Node 不启动 Electron）、`verify-security-switches.js`（外壳防护基线 19，纯 Node 不启动 Electron）、`verify-screen-watch.js`（录屏 / 被远控检测 14，纯 Node 不启动 Electron）、`verify-agent-dispatch.js`（agent 统一动作通道 20，纯 Node 不启动 Electron）、`verify-page-reader.js`（页面读取与稳定元素 id 19，纯 Node 不启动 Electron）、`verify-agent-audit.js`（agent 动作留痕 17，纯 Node 不启动 Electron）、`verify-agent-sites.js`（agent 站点三层授权 + 导入导出与格式迁移 34，纯 Node 不启动 Electron）、`verify-agent-mode.js`（agent 接入模式与两步确认 16，纯 Node 不启动 Electron）、`verify-page-digest.js`（页面摘要、拦截统计、跳抓包与 Markdown / CSV 导出 26，纯 Node 不启动 Electron）、`verify-tab-lifecycle.js`（标签生命周期判定 18，纯 Node 不启动 Electron）、`verify-tab-sleep.js`（标签休眠与唤醒端到端 10，真实起实例，`NYX_TAB_SLEEP_MS=1200`）、`verify-network-state.js`（断网判定与断网横幅 10，纯 Node 不启动 Electron）、`verify-page-cache.js`（离线页面缓存：开关、v2 块结构、图片上限、隐私加密、两份站点名单与名单导入导出 45，纯 Node 不启动 Electron）、`verify-runtime-compat.js`（运行时兼容：剪贴板原语收口、形状探测与版本三处一致 9，纯 Node 不启动 Electron）、`verify-release-gate.js`（发版门禁、安装器 e2e 接线、归档轮换、验签挑包与差分命中率闸门 22，纯 Node 不跑安装包）、`verify-signing.js`（安装包自签名、证书有效期、密码存 Windows 凭据管理器与打包接线 27，`--no-artifact` 时只跑静态守卫）、`verify-agent-settings.js`（agent 改设置：白名单 / 锁死键 / 确认 / 限流 / 撤销与多步撤销 / 免责 18，纯 Node 不启动 Electron）、`verify-packaged-smoke.js`（包内 11，缺 `dist/win-unpacked` 时跳过）。另有 `bench-transfer.js`（吞吐基线，**不进回归**，测大文件快慢用）、`test-installer-e2e.js`（安装器四条路径真机复验 + `--cross` 跨两版，需管理员权限与两个版本的安装包，**不进回归**，但已接进 `make-release --with-installer-test`）、`make-signing-cert.js` / `build-signed.js` / `sync-legacy.js` / `signing-secret.js`（自签名证书、签名打包、归档轮换、证书口令存取，**都不进回归**，要证书或要管理员权限；`scripts/lib/win-credential.js` 与 `scripts/lib/signing-secret.js` 是它们共用、且已被 `verify-signing.js` 直接断言的纯逻辑模块）。
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

### 9.4 Electron 45 批次（2026-11-14 深夜，五项，已随 1.17.3 发布）

- 顺序：① 升 Electron 45 → ③ 导出格式迁移 → ② 离线快照 v2 → ④ 拦截请求入摘要 → ⑤ 跨两版升级实测，全部完成。
- 提交：`bfbd057`（摘要区分被拦下/真失败）、`c04ba23`（离线快照 v2：块结构 + 图片说明）、`025717a`（名单导出 v2 + 导入迁移）、`cc00b2c`（安装器 e2e `--cross` 跨两版）、`361b9d6`（Electron 43.8.10 → 45.3.2 + 剪贴板异步兼容层 + `verify-runtime-compat.js`）。
- 运行时：**Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2**（Chromium 150 分支漂移就此收口）。
- 重打包（当时未发布，后来作为 1.17.3 的构建基础发出去）：`dist\Nyx-Setup-1.17.2.exe` 127,117,707 字节、sha256 `74da45e2b13d902f9c7cfff3c82ebf0a4429329ff9930983221a454107ef90d8`；完整性 9/9、冒烟 11/11、静默安装 exit 0、启动 5 进程 681.2 MB。
- 本批次回归：**20 个脚本 / 483 项 / 208 秒**全绿。
- 当时的待办（已解决）：Electron 45 这一批要发出去必须**先升到 1.17.3**（同版本号换字节会让更新判定混乱）——已由 §9.5 完成；离线快照当时只留图片 alt，图片本体在 §9.5 补上；剪贴板兼容层是为了同时兼容 43（同步）与 45（异步），等 43 线彻底退场可以简化。

### 9.5 1.17.3 批次（2026-11-14 深夜第二轮，五项，**已发布**）

- 顺序：① 发 1.17.3 → ② 离线快照存小图 → ③ 剪贴板兼容层收口 → ④ 摘要里被拦下的请求跳抓包 → ⑤ 安装器 e2e 常态化，按「先做完 ②③④⑤ 再统一发版」执行，避免连发两版。
- 提交：`52b2d9a`（剪贴板只留两处原语 + 启动探测形状 + `verify-runtime-compat.js` 6 → 9 项）、`afb3af2`（摘要里被拦下的站点可点，工具箱按该域名筛抓包 + `verify-page-digest.js` 20 → 22）、`300ed59`（离线快照存 ≤120 KB 小图、单页合计 ≤480 KB、最多 6 张，并修掉 v2 的 `blocks`/`images` 在抓取回调里被丢掉的真 bug + `verify-page-cache.js` 23 → 24）、`bbad0a6`（`dist\legacy` 归档基线 + `--cross` 自动发现 + `make-release` 扫 legacy + 新增 `verify-release-gate.js` 13 项）、`855a563`（回归项数同步 503 + 摘要跳抓包端到端，界面 114 → 115）。
- 发布：`dist/Nyx-Setup-1.17.3.exe` **127,123,737 字节**、sha256 **`848eb392ca31c9bca198dc48343cf6b0242bf716c072e9d7d3418355efed38e8`**；完整性 9/9、冒烟 11/11、安装器 e2e **56/56（升级基线 1.17.2）**、真机安装 1.17.3 启动正常（5 进程 661.7 MB、诊断里有 `CLIPBOARD_API_SHAPE` info）；留档 1.17.3 / 1.17.2 / 1.17.1，清理 1.16.0 释放 113.4 MB。
- 本批次回归：**21 个脚本 / 503 项 / 213 秒**全绿。文档：`docs/Nyx-1.17.3-发版记录.md`、`docs/CHANGELOG.md`（索引 + 1.17.3 小节，标题改「1.3.0 → 1.17.3 二十个版本」）、`README.md`（技术栈 Electron 45 / Chromium 156、离线可读含小图上限、摘要含拦截统计与跳抓包）。
- 待办（等用户决定）：安装包代码签名、快照图片是否加密落盘、摘要导出成 Markdown、`dist\legacy` 归档轮换脚本、离线缓存按站点黑白名单。
- 三个新踩的坑（已收进 §7 同类问题）：① 断言会数到**自己注释里**写的 `clipboard.readText()` / `availableFormats()`，静态守卫必须先剔注释行；② 同一文件混多组改动要按 hunk 分桶（`temp/patch-*.patch` + `git apply --cached --recount`），`style.css` 这种跨提交共享文件用 `--include=` 限定 + 整份 `git add`；③ `Get-Content | ConvertFrom-Json` 读 `latest.json` 会按 GBK 解码报「传入的对象无效」，复核更新源一律用 node 读。

### 9.6 用户六项需求批次（2026-11-14 深夜第三轮，六项，**已随 1.17.4 发布**）

- 来源：用户原话「1自己签名，2隐私模式全加密隔离，普通模式正常就行.3做。4做。5做。6做个AI接口让不同的agent根据用户需要快速并且自定义的修改设置（写好提醒和警告免责）」。顺序按 ①②③④⑤⑥ 逐项做、一项一提交。
- ① 安装包自签名 `718cc6f`：`make-signing-cert.js`（自签证书 + 可选 `--trust` 写用户存储）+ `build-signed.js`（`CSC_LINK`/`CSC_KEY_PASSWORD` 只进环境变量，输出 `dist-sign`）+ `docs/Nyx-代码签名说明.md`（能证明/不能证明、撤销、SmartScreen 对照）+ `verify-signing.js` 12 项。真机验证：`dist-sign\Nyx-Setup-1.17.3.exe` 127,166,232 字节、`Status=Valid`、指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`。
- ② 隐私模式快照加密 `2f5ecfb`：`src/core/private-cache.js`（密钥不可用一律 off，**绝不退化成明文**；24 小时自动作废；只存 sha256 截 32 作键）+ `main.js` 的 `savePrivatePageCache/getPrivateCachedPage/clearPrivateCache`（`safeStorage.encryptString` 整条加密，落 `private-cache.json`）；**口径变化**：1.17.3 及以前隐私模式根本不写缓存，本轮改成「默认也写、但整条加密后单独存放 24 小时」，并同步改了设置页文案与 `verify-page-cache.js` 第 17 项断言。
- ③ 摘要导出 Markdown `b21c8af`：`buildDigestMarkdown` / `digestFileName`（`页面摘要-YYYY-MM-DD-HH-MM.md`）+ `nyx:digest:export`（先选位置再写，取消与失败都有中文原因）+ 侧栏「导出 .md」；`verify-page-digest.js` 22 → 24。
- ④ 归档轮换 `b55c593`：`sync-legacy.js`（保留集合 = 留档 ∪ `dist\legacy` 里最老的 N 份，默认 2；同名不同大小拒绝覆盖；删包必须 `--prune`）+ `verify-release-gate.js` 13 → 16。当前 `dist\legacy` 有 1.16.0 / 1.17.1 / 1.17.2。
- ⑤ 缓存站点黑白名单 `fdfc6d1`：`page-cache.js` 的 `decideCacheSite`（黑名单优先、白名单只管"只缓存这些"、子域继承）+ `nyx:offline:sites(-set)` + 设置页下拉与两个名单框（change 触发保存）；`verify-page-cache.js` 29 → 34。
- ⑥ agent 改设置 `b9f4c43`：`src/core/agent-settings.js`（7 个白名单键、7 个锁死键、needsConfirm、一分钟 10 次限流、中文免责）+ 动作类型 `settings`（强制人工确认、走统一通道留痕）+ MCP `nyx_settings` + 设置页只读说明卡；`verify-agent-settings.js` 12 项，界面 115 → 116。
- 本批次回归：**23 个脚本 / 543 项 / 229 秒**全绿。
- 两个新踩的坑：① 给 `actions.js` 加了 `settings` 分支但忘了同步 `ACTION_TYPES` 名单，被「通道与执行器名单一一对应」两条静态守卫同时抓出（`执行器 9 / 通道 10`）——加动作类型必须同时改名单；② 编辑 `scripts/verify-ui-polish.js` 时用新块替换掉了 `主窗口无未捕获脚本异常` 那条 check，靠读回文件才发现，已补回。

### 9.7 1.17.4 批次（2026-11-14 深夜第四轮，五项，**已发布**）

- 顺序：先做完 ②证书有效期 ③加密快照清坏条目 ④改设置撤销 ⑤缓存名单导入导出，最后统一发 ①1.17.4（避免连发两版）。
- 提交：`173d85d`（打包前查证书有效期 + 修 PowerShell 5.1 `Get-PfxCertificate` 不认 `-Password` 的真 bug + `verify-signing.js` 12 → 18）、`4af0a10`（`inspectPrivateStore`/`dropBrokenEntries`，只清解不开的 + `verify-page-cache.js` 34 → 37）、`058b953`（`planSettingUndo`，撤销仍走确认与留痕、不占限流额度、界面不给旁路 + `verify-agent-settings.js` 12 → 17、界面 117）、`3a65c13`（`kind: 'nyx-cache-sites'` 导出/导入，与 agent 站点名单刻意分开 kind + `verify-page-cache.js` 37 → 41）、`e1cb150`（验签按版本号挑包，见下）。
- 发布：`dist/Nyx-Setup-1.17.4.exe` **127,192,896 字节**、sha256 **`f6c9d53a39eed8dc707daba0a4240820395beb1251b88177f1d8f9c3747e5566`**、签名 `CN=Nyx Self-Signed…`（指纹 `256F208A…`）；完整性 9/9、冒烟 11/11、安装器 e2e **56/56（基线 1.17.3）**、真机静默安装 exit 0 + FileVersion 1.17.4 + 启动 5 进程 684.0 MB（诊断里有 `CLIPBOARD_API_SHAPE` info / `APP_READY` / `GPU_ADAPTER`）；留档保留 1.17.4 / 1.17.3 / 1.17.2（删 1.17.1 释放 113.4 MB），孤儿 `Nyx-Setup-1.17.3.blocks.json` 已删。
- **本批次最值得记的 bug（`e1cb150`）**：`verify-signing.js` 的 `findArtifact()` 按 `[dist-sign, dist]` 目录顺序取第一个命中的包，而 `dist-sign` 里躺着上次签的 1.17.3 —— 1.17.4 打出来后验的却是旧包，21 项一串 ✔ 全是**假通过**。修法：新增 `scripts/lib/pick-artifact.js`（版本号最大优先、同版本看 mtime），`verify-release-gate.js` 16 → 20 项把行为钉住。教训：**「挑哪个文件」这种小事也必须抽纯函数 + 有断言**，假通过比失败更危险。
- 本批次回归：**23 个脚本 / 562 项 / 209 秒**全绿（68+117+14+16+14+20+19+14+20+19+17+34+16+24+18+10+10+41+9+20+18+17+11）。
- 文档：`docs/Nyx-1.17.4-发版记录.md`（新）、`docs/CHANGELOG.md`（索引 + 1.17.4 小节，标题改「1.3.0 → 1.17.4 二十一个版本」）、`README.md`（签名边界、断网也能读改为「隐私模式整条加密」、agent 改设置与撤销、摘要 Markdown 导出）、`docs/实测修复台账.md`（新章节 + 基线 562 项）。
- 坑（本批次新增）：`edit` 的 old_string 选太宽会吃掉相邻行（本轮两次：`clearBtn.addEventListener(...)`、`#offline-site-mode { height: 28px;`），改完必须读回 + `node --check` + 跑相关回归；项数标签散在三处（头部注释 / STEPS `items` / 脚本输出），改一项要一起改。
- 待办（等用户决定）：签名证书口令是否改存 Windows 凭据管理器；隐私快照是否再按站点白名单细分；摘要是否再支持导出 CSV；agent 改设置是否要多步撤销栈；安装包增量差分要不要针对 45 内核实测一轮。
- 待办（等用户决定）：是否发 **1.17.4**（含签名包、私密加密快照、Markdown 导出、站点名单、agent 改设置）；agent 改设置的锁死键是否要允许"人工代理执行"。

### 9.8 候选批次（2026-11-14 深夜第五轮，五项，**代码完成，未发版**）

- 顺序：① 签名口令进 Windows 凭据管理器 → ② 隐私快照按站点收窄 → ③ 摘要导出 CSV → ④ agent 改设置多步撤销 → ⑤ 增量差分在 Electron 45 上复测，一项一提交。
- ① `3ae3e59` 凭据管理器：`scripts/lib/win-credential.js`（`advapi32` 的 `CredWrite/CredRead/CredFree/CredDelete`，口令只经环境变量进子进程）+ `scripts/lib/signing-secret.js`（`decideSigningSecret` 优先级 凭据 → 环境变量 → 明文文件 → 没有，落到后两条一律带中文警告）+ `scripts/signing-secret.js`（`--status` / `--store` / `--store --purge-file` / `--clear`，`npm run sign:secret`）；`make-signing-cert.js` 生成后就写凭据、`build-signed.js` 打包前从凭据读；`verify-signing.js` 18 → **27**。边界写进文档：**只防 password.txt 被复制，不防同账户下的恶意程序**。
- ② `4e9a77e` 隐私快照站点名单：`ui-store` 新增 `privateSiteMode/privateSiteAllow/privateSiteBlock`，与普通模式那份 `cacheSite*` **刻意分开存**——那份管「要不要留明文正文」，这份管「要不要留加密快照」；`savePrivatePageCache()` 在 `preparePrivateRecord` 之前判站点，跳过记 `PRIVATE_CACHE_SITE_SKIPPED`；`verify-page-cache.js` 41 → **45**。
- ③ `71551f6` 摘要导出 CSV：`buildDigestCsv`（RFC 4180 转义、**行尾 CRLF**，因为旧版 Excel 不认裸 LF）+ `digestCsvFileName`；`nyx:digest:export` 认 `format: 'md'|'csv'`，默认名与 `filters` 跟着走；侧栏两个按钮各导各的。**刻意只导网络统计**（域名/接口/被拦下），摘要句子与关键词塞单元格只会变成逗号地狱；`verify-page-digest.js` 24 → **26**。
- ④ `2038fbb` 多步撤销：`planSettingUndo` 改栈式（`MAX_UNDO_STEPS = 5`，`context.currents` + `context.steps`），两条硬约束——**整体成功或整体不动**（任一条锁死/未知/非法就整体拒绝）、**只回退不重做**（撤销后 `splice` 掉用掉的记录）；`agentSettingsSnapshot().undo` 增 `depth`/`maxSteps`；`verify-agent-settings.js` 17 → **18**。
- ⑤ `8a6d328` 差分复测：`measure-delta.js --base 1.17.3 --target 1.17.4 --sizes 512k` → **243 块 / 命中 0 / 0.00%**，与 Electron 43 时一致 → 命中率不取决于内核，**由 NSIS/LZMA 固实压缩这个发放形态决定**；零命中时逐块 Range 会变成 243 次请求且字节数等同整包，比整包更慢。`verify-release-gate.js` 20 → **22**（命中率闸门 `>= 0.2` + 测量工具仍在）。
- 本批次回归：**23 个脚本 / 584 项 / 209 秒**全绿（68+117+14+16+14+20+19+14+20+19+17+34+16+26+18+10+10+45+9+22+27+18+11）。
- 未发版：五项只改本机行为，版本号仍是 1.17.4，更新源没动，`dist\Nyx-Setup-1.17.4.exe` 的 sha `f6c9d53a…` 未变。**要发就得先升 1.17.5**。
- 待办（等用户决定）：是否发 1.17.5；证书口令轮换与到期提醒是否进界面；隐私快照站点名单是否做「只存这些」模板导入导出；agent 改设置是否按「场景预设」批量改（仍逐项确认）；未压缩 `app.asar` 的差分可行性。

