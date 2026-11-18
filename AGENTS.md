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

- 版本：`package.json` = **1.17.10**；**已发布**的产物 `dist/Nyx-Setup-1.17.10.exe`（Electron 45.3.2，127,266,144 字节，sha256 `94192cf1f091248e5b7abe31e605cfa5d8aca5d8b29652b9f0ced400cea2a0`，签名 `CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`）；更新源 `latest.json` 已指向它（带 Ed25519 签名，`keyId dc2cec223e6ea7c7`）。留档保留 1.17.10 / 1.17.9 / 1.17.8（1.17.7 已清理）；`dist-sign` 里还留着旧版本，**验签按版本号挑包**（`scripts/lib/pick-artifact.js`），不会再验到旧包。
- 运行时：Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2；Windows。
- 运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用）。
- 回归基线（本轮实测，全绿）：`npm run verify` = 地址栏建议 **68 项** + 界面体验 **139 项**（含「更多」菜单让位、设置页排版） + 出站链路守卫 **14 项** + 下载链路 **16 项** + 图形性能策略 **14 项** + 安全基线对照 **20 项** + 外壳防护基线 **19 项** + 录屏检测 **14 项** + 动作通道 **20 项** + 页面读取 **19 项** + agent 审计 **17 项** + agent 站点授权 **34 项** + agent 接入模式 **16 项** + 页面摘要（Markdown / CSV 导出）**26 项** + 标签生命周期 **18 项** + 标签休眠 **10 项** + 断网判定 **10 项** + 离线页面缓存（隐私加密·两份站点名单·各自的名单导入导出·「只存这些」与自定义模板及其导出导入·模板并进/替换与同时套到普通模式·名单是否真生效）**67 项** + 运行时兼容 **9 项** + 发版门禁接线（验签挑包·差分闸门·asar 差分结论·差分命中率实测与新鲜度·夜间 e2e 注册与状态卡·发版后自动量差分·计划任务改时间与删任务且必须复核）**45 项** + 代码签名（证书有效期·凭据管理器·签名状态进界面）**35 项** + agent 改设置（多步撤销·场景预设·改动聚合视图·按时间筛选与 CSV 导出·动作聚合·动作记录也导出 CSV）**34 项** + 打包冒烟 **11 项** + 网络面板跟随 **13 项** + agent 状态灯 **11 项** + 工具栏四主路径与「更多」**10 项** + 动效两档 **8 项** + 首次引导判定 **10 项** + 首次引导 e2e **7 项** + 主题回归 **7 项** + 外壳导航守卫 **13 项** + 更新通道准入 **10 项** + 隐私指纹面 **34 项** + IPC 发送方校验 **10 项** + 本地接口鉴权 **7 项** + 安全审计 P2 批次 **14 项** + 站点设备权限 **22 项** + 本地隐私自检 **18 项** + 隐私自检接线与横幅 **11 项**（计在外壳页面断言里）= **1104 项 / 49 个脚本 / 681 秒**（2026-11-17 1.18.0 发布前实测；**其中 1 项失败是会话锁屏导致系统剪贴板不可用**，非产品回归；逐脚本准确项数以 `scripts/verify-all.js` 的 `items` 为准，上面这串描述里的个别数字可能滞后）。
- 当前版本：**1.18.0**（`dist/Nyx-Setup-1.18.0.exe`，127,323,200 字节，sha256 `ef0d4388e54621d8aae44872fbca340a45b8cf0c17fb1d95dd0b7b9c98b8d096`）**已发布**，更新源 `%APPDATA%\Nyx\updates\latest.json` 指向它；已静默装到 `%LOCALAPPDATA%\Programs\Nyx`。1.17.11–1.17.20 从未发布（内容都并在 1.18.0 里）。
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

- 四十七个脚本（项数以 §2 的实测基线为准；下面这条长列表是历史描述，逐项数字可能滞后）：`verify-address-suggest.js`（地址栏 68）、`verify-ui-polish.js`（界面 137）、`verify-link-guard.js`（出站链路守卫 14，纯 Node 不启动 Electron）、`verify-downloads.js`（下载链路 16，纯 Node 不启动 Electron）、`verify-gpu-policy.js`（图形性能策略 14，纯 Node 不启动 Electron）、`verify-security-baseline.js`（安全基线对照 20，纯 Node 不启动 Electron）、`verify-security-switches.js`（外壳防护基线 19，纯 Node 不启动 Electron）、`verify-screen-watch.js`（录屏 / 被远控检测 14，纯 Node 不启动 Electron）、`verify-agent-dispatch.js`（agent 统一动作通道 20，纯 Node 不启动 Electron）、`verify-page-reader.js`（页面读取与稳定元素 id 19，纯 Node 不启动 Electron）、`verify-agent-audit.js`（agent 动作留痕 17，纯 Node 不启动 Electron）、`verify-agent-sites.js`（agent 站点三层授权 + 导入导出与格式迁移 34，纯 Node 不启动 Electron）、`verify-agent-mode.js`（agent 接入模式与两步确认 16，纯 Node 不启动 Electron）、`verify-page-digest.js`（页面摘要、拦截统计、跳抓包与 Markdown / CSV 导出 26，纯 Node 不启动 Electron）、`verify-tab-lifecycle.js`（标签生命周期判定 18，纯 Node 不启动 Electron）、`verify-tab-sleep.js`（标签休眠与唤醒端到端 10，真实起实例，`NYX_TAB_SLEEP_MS=1200`）、`verify-network-state.js`（断网判定与断网横幅 10，纯 Node 不启动 Electron）、`verify-page-cache.js`（离线页面缓存：开关、v2 块结构、图片上限、隐私加密、两份站点名单、各自的名单导入导出与「只存这些」与自定义模板及模板导出导入、模板并进/替换与同时套到普通模式、名单是否真生效 67，纯 Node 不启动 Electron）、`verify-runtime-compat.js`（运行时兼容：剪贴板原语收口、形状探测与版本三处一致 9，纯 Node 不启动 Electron）、`verify-release-gate.js`（发版门禁、安装器 e2e 接线、归档轮换、验签挑包、差分命中率闸门与 asar 差分结论、差分命中率实测与新鲜度、夜间 e2e 状态卡与计划任务注册、计划任务改时间与删任务且必须复核 45，纯 Node 不跑安装包）、`verify-signing.js`（安装包自签名、证书有效期、密码存 Windows 凭据管理器、签名状态进设置页与打包接线 35，`--no-artifact` 时只跑静态守卫）、`verify-agent-settings.js`（agent 改设置：白名单 / 锁死键 / 确认 / 限流 / 撤销与多步撤销 / 场景预设 / 改动聚合视图与按时间筛选、CSV 导出 / 动作聚合 / 动作记录也导出 CSV / 免责 34，纯 Node 不启动 Electron）、`verify-process-args.js`（进程可辨识：命令行参数注入、进程表排序与兜底、设置页进程详情接线 11，纯 Node 不启动 Electron）、`verify-toolbox-follow.js`（网络面板跟随 / 锁定、记录上限与关闭即释放 13，纯 Node 不启动 Electron）、`verify-agent-lamp.js`（agent 三色状态灯与窄面板 11，纯 Node 不启动 Electron）、`verify-toolbar.js`（顶栏四主路径、「更多」菜单与截图落点 10，纯 Node 不启动 Electron）、`verify-motion.js`（动效两档与按钮不许有模糊光晕 8，纯 Node 不启动 Electron）、`verify-onboard.js`（首装引导判定与选项规划 10，纯 Node 不启动 Electron）、`verify-onboard-e2e.js`（首装引导端到端 7，真实起实例）、`verify-themes.js`（六套主题令牌、对比度实算、不许渐变 7，纯 Node 不启动 Electron）、`verify-shell-guard.js`（外壳导航守卫：只许自己那份 index.html、伪协议与同目录别的 html 全拦、未知自身地址失败关闭、webview 一律拒 11，纯 Node 不启动 Electron）、`verify-update-policy.js`（更新通道准入：只许 https、本地源要显式确认、版本必须更新、缺 sha256 必须拒绝 10，纯 Node 不启动 Electron）、`verify-agent-doc.js`（agent 接入说明生成与复制 9，纯 Node 不启动 Electron）、`verify-packaged-smoke.js`（包内 11，缺 `dist/win-unpacked` 时跳过）。另有 `bench-transfer.js`（吞吐基线，**不进回归**，测大文件快慢用）、`test-installer-e2e.js`（安装器四条路径真机复验 + `--cross` 跨两版，需管理员权限与两个版本的安装包，**不进回归**，但已接进 `make-release --with-installer-test`）、`make-signing-cert.js` / `build-signed.js` / `sync-legacy.js` / `signing-secret.js` / `nightly-e2e.js`（自签名证书、签名打包、归档轮换、证书口令存取、夜间 e2e，**都不进回归**，要证书或要管理员权限；其中 `nightly-e2e.js` 先 `sync-legacy` 轮换归档再跑 `test-installer-e2e.js --cross`，结果追加进 `docs/安装器e2e夜间记录.md`，默认只打印计划、`--run` 才真跑、`--register` 只打印 schtasks 命令不代跑；`scripts/lib/win-credential.js` 与 `scripts/lib/signing-secret.js` 是它们共用、且已被 `verify-signing.js` 直接断言的纯逻辑模块）。
- 上面那个长列表是 1.17.10 时写的，之后新增的脚本单独列在这里（都在 `verify-all` 里跑）：`verify-privacy-surface.js`（隐私指纹面 55）、`verify-ipc-guard.js`（IPC 发送方校验 10）、`verify-http-api-auth.js`（本地接口鉴权 7）、`verify-audit-p2.js`（安全审计 P2 批次 17）、`verify-permissions.js`（站点设备权限 22）、`verify-switch-cache.js`（模式切换缓存 21）、`verify-tab-park.js`（标签停靠 26）、`verify-transition.js`（切换动画 20）、`verify-agent-stop.js`（急停快捷键 12）、`verify-navigate-budget.js`（agent 导航预算 24）、`verify-navigate-budget-e2e.js`（应用页导航预算 e2e 7）、`verify-font-scale.js`（界面字号 15）。
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
| 提交信息里的中文变成 `?` | 用 `Out-File`/here-string 写 message 文件，按控制台代码页转码 | 用 `write` 工具写 `temp\commit-*.txt`，再 `git commit -F`（1.18.0 的 `dfb59c1` 就是这么坏的，已记录不改写历史） |

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

- 正在执行的清单：`docs/实测修复台账.md`（来源：外部实测清单 `Nyx浏览器v1实测修复清单.md`，不在本仓库内，12 项）。
- 顺序：**C1 → A4 → A2 → A1 → B4+B5 → B1/B2/B3 → A3/A5 → C2/C3 → C4**，一项一提交。
- 进度：C1（`014bfd8`）、A4（`5404bda` + `cd41559` + `f43c682`）、A2（`c64bca9`）、A1（`196ae38`）、B4+B5（`f59226c`）、B1（`4da7bd2`）、B2（`36482c3`）、B3（`ebb26e3`）、A3（`9bf8da5`，已测基线 + 已可量化）、A5（`5843d60`，默认核显优先）、C2（`23d3508`，安全基线可自查）、C3（`8efe8ea`，外壳防护现值 + 注入演示）、C4（`142723c`，进隐私模式前查录屏与被远控）**已全部完成（12/12）**。
- 清单已清空：下一步等用户决定（候选：发版 1.17.1 / 安装器端到端复验 / 修更新源 `latest.json` 指向已删 exe 的 404 / 补 `extensions.json` 的 history / 做一次真机安装版冒烟）。

### 9.1 当前清单：Agent 化 A–G（2026-11-14 开工）

- 来源：外部清单 `Nyx浏览器Agent化实现清单.md`（不在本仓库内；A–G 七项 + §4 验收清单 + 六条不可回退约束）。
- 执行顺序（已与清单 §0 的意图对齐，**C 是枢纽必须最先**）：**C → B → D → E → A → F → G**，一项一提交。
- 进度：**C 完成（`931377e`）**、**B 完成（`13f0649`）**、**D 完成（`68fa156`）**、**E 完成（`eb97030`）**、**A 完成（`43e99be`）**、**F 完成（`4c7f24e`）**、**G 完成（`72088c0` + 休眠阈值设置项 `2d6b7d6` + 断网判定 `d16a2bb`）** —— **A–G 七项全部完成**（明细见 `docs/实测修复台账.md` 的「Agent 化清单（A–G）状态」表）。E 的落点：`src/core/agent-sites.js`（三层判定 + 域名级名单）、`main.js` 的 `readAgentSites/writeAgentSites/askAgentSiteTrust/authorizeAgentAction/registerAgentSitesIpc`、`agent-dispatch` 的 `await authorize`、设置「Agent 访问 → 站点授权」卡片。A 的落点：`src/core/agent-mode.js`（模式表 + 两步确认状态机 + 状态载荷）、`main.js` 的 `readBootAgentMode/writeAgentMode/registerAgentModeIpc`（启动前 appendSwitch CDP 端口）、外壳 `#agent-mode-flag`、设置「Agent 访问 → 接入模式」卡片。F 的落点：`src/core/page-digest.js`（切句/关键词/抽取式摘要/网络摘要）、`main.js` 的 `registerDigestIpc`（默认关必须给原因）、`ui-store` 的 `digestEnabled`、外壳 `#btn-digest` / `#digest-panel`、设置「页面摘要」卡片。G 的落点：`src/core/tab-lifecycle.js`（三态判定 + 阈值解析 + 中文原因）、`tabs.js` 的 `startLifecycle/applyLifecycle/sleepTab/wakeTab/markAgentDriven/setAgentSessionActive`、`main.js` 的 `readTabSleepAfterMs` 与 `touchAgentSession`（审计入口续命）、外壳 `.tab.is-asleep` 淡显；断网部分：`src/core/link-guard.js` 的 `offline` 动作、`src/core/network-state.js`、`main.js` 的 `onlineState()` + `nyx:net:state`、外壳 `#net-offline-flag`。
- G 的诚实边界（写进台账，也要对用户说）：休眠等于卸载页面，**未提交的输入与滚动位置会丢**；5 秒巡检最晚晚 5 秒才睡；「降低占用」只做到"闲置标签不占内存"，没做离线/在线切换策略。休眠阈值已做成设置项（`2d6b7d6`：外观 → 标签休眠，0 = 关闭，1–240 分钟，改完立刻生效，环境变量 `NYX_TAB_SLEEP_MS` 仅作验证旋钮并优先于界面设置）。
- 现状取证（开工前别再重复挖）：`src/core/actions.js:96` 已有 8 种动作但**没有 dispatch 层** —— **已在 C 修掉**；`src/api/http-api.js:82` 只绑回环 + Token；`src/mcp/server.js:112` 是**独立 stdio 进程转发 HTTP**，`nyx_screenshot` 已降级为「仅人工辅助」（B 把结构化的 `nyx_read_page` 顶成了首选）；`downloads.js` 的 `attach()` 正好挂下载审计。B 的落点：`src/core/page-reader.js`（读页面 + 稳定 id）、`actions.js` 的 `readPage`/`elementId`、`/capabilities` 的 9 项动作。D 的落点：`src/core/agent-audit.js`（1000 条环形缓冲 + `<userData>/agent-audit.jsonl` 追加）、`main.js` 的 `stopAgent/resumeAgent/agentStatusPayload/registerAgentAuditIpc/registerAgentStopShortcut`、外壳 `#btn-agent-stop`、设置「Agent 访问」分区。
- 已定的四个决策（清单 §5 待确认项，用户未反对即按此执行）：
  1. 未命中站点**每次进站问一次**，确认框带「这次会话信任该域名」勾选（仅本进程有效、不落盘）。
  2. 名单**先域名级**（子域继承；两条都在名单里时屏蔽赢），数据留 `mode: 'host'|'prefix'` 字段以便日后扩 URL 前缀。
  3. 外部接入模式**只记录经过浏览器的部分** + UI 常驻「审计不完整」，不做 CDP 侧二次录制。
  4. 自动总结**侧栏展示 + 一键复制**，不落文件、不进随手记；**纯抽取式，不调任何生成式 API**（产品红线）。
- 开工要点：急停的诚实边界写进 UI（单条 `executeJavaScript` 无法在 V8 中途掐断，保证「不再派发下一条 + 3 秒内新动作全拒」）；切换外部模式**需要重启**（CDP 端口只能在启动时开），必须在 UI 明说；E 的两个确认窗与 D 的审计面沿用 `ui-ux-pro-max` 规范（主题令牌、零新增色值、`:focus-visible`、`role=alert`）。

### 9.2–9.13 历史批次索引（1.17.1–1.17.7）
细节在 `docs/CHANGELOG.md`、各版本 `docs/Nyx-<版本>-发版记录.md`，以及 `docs/实测修复台账.md`
（那里每项都有「现象 / 改法 / 验证」）。这里只留一行索引，省回被挤占的指令预算。

| 版本 | 主题 | 验收项 / 安装包 |
| --- | --- | --- |
| 1.17.1 | 安装器 e2e 首版、C2 联网复核、离线缓存第一版、站点名单 URL 前缀 | 431 项 / 18 脚本 |
| 1.17.2 | 离线缓存开关、名单导入导出、Electron 43.8.10 | 466 项 / 19 脚本；118,516,372 / `c17386b7…` |
| 1.17.3 | Electron 45.3.2（吃两条 CVE）、离线快照 v2、摘要跳抓包、e2e 常态化 | 503 项 / 21 脚本；127,123,737 / `848eb392…` |
| 1.17.4 | 自签名安装包、隐私快照整条加密、摘要 .md、缓存站点名单、agent 改设置 | 562 项 / 23 脚本；127,192,896 / `f6c9d53a…` |
| 1.17.5 | 签名口令进凭据管理器、隐私名单分开、CSV 导出、多步撤销、差分在 45 上复测 | 602 项 / 23 脚本；127,204,896 / `7d1d0113…` |
| 1.17.6 | 发版后自动量差分、夜间 e2e 状态卡、聚合视图时间筛选 + CSV、自定义模板 | 632 项 / 23 脚本；127,217,296 / `99d4d0e8…` |
| 1.17.7 | 计划任务界面入口、模板替换并顺带套普通模式、动作记录 CSV | 657 项 / 23 脚本；127,225,416 / `ffb68720…` |

被压掉的那几段留下的长期结论（仍然生效）：

- **差分命中率恒为 0.00%**（Electron 43 与 45 都一样）——由 NSIS/LZMA 固实压缩决定，与内核版本无关；
  `DIFF_MIN_HIT_RATE = 0.2` 的闸门必须留着，否则会退化成 243 次 Range 请求，比整包下载更慢。
- **asar 差分不做**：CDC 16K 可省 74.53%，但 asar 只占整包约 8%，而且补丁拼出来的包没有 Authenticode 签名。
- **计划任务的 schtasks 输出是 GBK**（`encoding:'buffer'` + `TextDecoder('gbk')`）；注册默认不带 `/RL HIGHEST`
  （用户目录安装，普通权限就够），执行后必须复核。
- **同一文件混着多组改动要按 hunk 分桶**（`temp/patch-*.patch` + `git apply --cached --recount`）；
  上一桶提交后剩余 diff 本身就只剩下一桶，直接 `git add`，不要再套补丁。
- **断言里的正则要先按真实函数名核对**（是 `aggregateAgentSettingChanges`，不是 `agentSettingChanges`）；
  次序类断言要比**调用点标记**，拿函数名 `indexOf` 会命中函数定义，断言恒假。

### 9.14 12 项改进首批（2026-11-15 上午，A1/A2/A3，**已随 1.17.8 发布**）

- 来源：用户口述 12 项改进清单（`外部清单（不在本仓库内）`），首批只做 A1/A2/A3，进 1.17.8；后续按 A4/A5 → C2/C1 → B1/B2 → D2 → D1 → D3。
- A1 `08b498d` 设置页卡片折叠：`src/core/ui-store.js` 的 `settingsFold`（存 JSON 字符串，因为偏好校验只收布尔与字符串）+ `src/renderer/settings.js` 的折叠节（`FOLD_OPEN_SECTIONS`、`describeCardValue`、`applyFold` 用 `void body.offsetHeight` 强制重排而不是 rAF、`enhanceCardFold` 锚点用 `titleEl.nextSibling`）+ `settings.css` + `verify-ui-polish.js` 121 → **125**。默认态：常用分区（外观、网络）铺开，其余收起。
- A2 `1abd33f` 摘要面板让出右侧：`src/main.js` 的 `DIGEST_PANEL_W = 402` / `DIGEST_PANEL_GAP = 14` / `applyRightInsets()`（工具箱宽度 + 摘要宽度一起给 `setRightInset`）+ IPC `nyx:digest:panel` + `renderer.js` 的 `syncDigestLayout()` 与 `nyx:toolbox-layout` 事件 + `toolbox-ui.js` 的 `notifyToolboxLayout()`；界面 125 → **127**。**根因不是 z-index**：标签页与工具箱都是 `WebContentsView`，永远画在外壳 DOM 之上，只能靠让出宽度。
- A3 `4cb172a` 进程可辨识：`src/core/process-args.js`（`buildTabProcessArgs` 给每个渲染进程塞 `--nyx-kind` / `--nyx-tab` / `--nyx-host`，任务管理器「命令行」列可见；`buildProcessRows` 出主进程优先、按内存降序的表）+ `tabs.js` 的 `additionalArguments`（含 `wakeTab` 重建时先清旧 `--nyx-*`）+ IPC `nyx:proc:list` / `nyx:proc:copy` + 设置页「诊断 → 进程详情」卡 + 新增 `scripts/verify-process-args.js` 11 项；界面 127 → **128**。
- **两条诚实边界（必须对用户说）**：① 映像名永远是 `Nyx.exe`——Windows 不允许每个进程用不同名字，不承诺改名；② 摘要面板的「并排」是让标签页缩窄，不是浮在上面。
- 本批次回归：**24 个脚本 / 675 项 / 237 秒**全绿（68+128+14+16+14+20+19+14+20+19+17+34+16+26+18+10+10+67+9+45+35+34+11+11）。
- 三个新坑：① `display:none` 子树里 `getBoundingClientRect()` 全是 0（量高度前必须先点导航切到该分区），否则"铺开高度 0"是假红；② 卡片增强发生在 `init()` 里，测试必须轮询等 `.info-card[data-fold-id]` 出现；③ 设置页里的导航项要用 `settings.eval`，用 `shell.eval` 会拿不到（`.nav-item` 在设置页视图里）。
- **工作区里有一批不属于本批次的未提交改动**（`LICENSE` 改 PolyForm-Noncommercial、`README.md`、`THIRD-PARTY-NOTICES.md`、`package.json` 的 `"license"`、`scripts/fetch-vendor.js`）：来自另一条开发线，**不许提交、不许回滚**，交付时要向用户点明。
- 待办（等用户决定）：是否发 1.17.8；A4/A5、C2/C1、B1/B2、D2/D1/D3 逐项推进。

### 9.15 1.17.9 批次（2026-11-15，A4/A5/C2/C1/B1/B2/D2/D1/D3 九项，**代码完成，待发版**）

- 来源：12 项改进清单剩下的九项，用户 m17941/m18435「做」逐步推进；顺序 A4 → A5 → C2 → C1 → B1 → B2 → D2 → D1 → D3，一项一提交。
- A4 `cb9c6c9` 网络面板跟随/锁定：`src/core/toolbox-follow.js`（`decideFollowTarget` / `trimRecords` / `describeFollowState`），`#net-follow` 复选框 → 两态 `<select>`，`toolbox.js` 的 `MAX_RECORDS` 4000 → **500**、`disable()` 补 `collectors.clear()`；新增 `verify-toolbox-follow.js` 13 项。
- A5 `3caaf33` agent 状态灯 + 窄面板：`src/core/agent-lamp.js`（`ACTIVE_MS = 4000`、`decideLamp`、`describeLamp`；**「审计不完整」不许挤进三色灯**），工具栏 `#btn-agent-lamp` + `#agent-panel`（无输入控件）+ IPC `nyx:agent:panel` + `AGENT_PANEL_W = 302`；新增 `verify-agent-lamp.js` 11 项。
- C2 `a89b90d` 性能基线：`scripts/measure-baseline.js` + `docs/性能基线.md`（冷启动 386/380 ms、1 标签 657.4 MB、5 标签 1083.9/1086.7 MB、体积 121.3 MB / 解包 389.7 MB）。
- C1 `a682076` 裁剪评估：`docs/体积与裁剪评估.md`，结论**已是最小**——「该扩展移出随包」本来就没随包（`src/bundled-extensions` 不存在、asar 2296 条无命中），三种要付代价的裁剪列给用户决定。
- B1 `7c9da81` 顶栏四主路径：`src/core/toolbar.js`（`MAIN_ACTIONS` / `MORE_ACTIONS` / `normalizeToolbarPrefs` / `sectionForAction` / `screenshotFilename`）+ `.more-group`/`#more-menu` + `.tb-label` 小字（偏好 `toolbarLabels`）+ IPC `nyx:page:screenshot`（**先 `showSaveDialogSync` 再 `capturePage`**）；旧 `#btn-digest` 移除，摘要只留菜单里 `#more-digest`；新增 `verify-toolbar.js` 10 项。
- B2 `8500586` 按钮反馈与动效两档：`src/core/motion.js`（克制 150ms / 活泼 220ms；减少动效 → 90ms 且不改用户偏好）+ 偏好 `motionLevel` + `theme-glass.css` 去掉按钮外发光/悬停上浮/主按钮常态辉光/危险红光；新增 `verify-motion.js` 8 项。
- D2 `3d2c039` 首装引导：`src/core/onboarding.js`（`planOnboarding` 四态 + `planOnboardChoices`，选「先不定」不写）+ `src/renderer/onboard.*` + `build/installer.nsh` 只在全新安装写 `pending:true`；新增 `verify-onboard.js` 10 项 + `verify-onboard-e2e.js` 7 项。顺手把第 3 处 `sandbox:false` 正式登记进 `src/core/security-switches.js` 的 `WINDOW_ROLES`（外壳防护 17 → 19 项），**没有放宽断言**。
- D1 `694d334` agent 接入说明：`src/core/agent-doc.js`（六节文档、无端口不编造、外部模式如实写审计缺口）+ 三个 IPC（含复制回读校对）+ 设置「Agent 访问 → 接入说明」卡（**不做全文预览**，含 token 路径与端口）；新增 `verify-agent-doc.js` 9 项，界面 134。
- D3 `995e41e` 奶白 / 海盐 + 「主题与显示」分区：`theme-nyx.css` 两套新主题（只换配色、零渐变）、`ui-store` 枚举扩到六项、设置页新分区（主题/动效/小字，口径与「外观」分开）、`settleInit()` 兜住永不返回的硬件探测、`.sec-scroll > .info-card { flex: 0 0 auto; }`；新增 `verify-themes.js` 7 项。
- 回归基础设施 `164afa4`：CDP 单次等待 15s → **60s**，`verify-all` 失败后干净环境重试一次（两次都红按「重试后仍失败」报）。触发原因：本机可用物理内存掉到 3 GB 上下时，启动 Electron 的脚本偶发 `CDP 调用超时：Runtime.enable / Runtime.evaluate`，单跑必过。
- 本批次回归：**32 个脚本 / 756 项 / 447 秒**全绿。
- 五个新坑：① 设置页 `init()` 里 `await` 一个永不返回的 IPC（`nyx:hardware:status` 的 PowerShell 探测）会让后续初始化**静默不发生**——必须逐项超时兜住；② `.sec-scroll` 是纵向 flex，卡片铺开会被压扁（量出来高度 0）；③ `edit` 删整段 HTML 时少删一个 `</div>` 会让下一个分区成为子节点（探针打出 `displayParent` 才发现）；④ 新主题的浅灰文字必须先算对比度（cream/sea 的 `--text-faint` 各红了 1 次）；⑤ `verify-all` 里的环境性假失败只能靠"放大等待 + 一次重试"处理，**绝不能改断言**。
- 待办（等用户决定）：是否发 1.17.9；`nyx:hardware:status` 在本机永不返回（已被兜住，但值得单独治）；`AGENT_STOP_SHORTCUT_FAILED`（`CommandOrControl+Alt+X` 被占用，只在诊断里）是否做成界面可见提示；字号档位（清单 D3 里明确"属独立改造"）尚未做。

### 9.16 1.17.10 批次（2026-11-15 夜，设置页重排 + 「更多」菜单遮挡，**代码完成，未发版**）

- 来源：用户 m20014 原话「设置页面极度混乱重新做，重新排版。上方更多的按钮，点击后下方铺开被遮挡。」外加一份安全审计报告 `temp/Nyx-1.17.9-安全审计报告.md`（结论「不通过，不可发布」）。
- ① `3332bf8` 「更多」菜单被页面盖住：根因是 `#more-menu` 是外壳 DOM、标签页是 `WebContentsView`（原生视图永远在 DOM 之上，`z-index:950` 无效），而外壳高度写死 `--height-shell:124px` → 菜单伸出外壳即被盖。改法照 A2 的让位思路：`src/core/tabs.js` 加 `shellExtra` 与 `setShellExtra(px)`（clamp 0..600），`layout()` 里 `y: uiHeight + shellExtra`；IPC `nyx:shell:extra` + preload `shellExtra()` + `renderer.js` 的 `moreMenuHeight()/applyShellExtra()`，打开时量高度让位、关闭归零。界面 134 → **135**。
- ② 设置页重排（本轮）：`settings.css` 的 `.sec-scroll` 由 `display:flex` 改**两列自适应网格**（`repeat(auto-fill, minmax(360px, 1fr))`、`align-content/align-items: start`、gap 14）；新增 `.info-card.card-wide`（整行）与 `.sec-scroll > *:not(.info-card)`（提示块整行）；导航 `#nav-list` 分四组（外观与显示 / 隐私与网络 / 能力与工具 / 诊断与关于，`.nav-group` + `.nav-group-label`）；`settings.js` 新增 `markWideCards(root)`（含 `table / .kv-grid / .proc-table / .agent-site-list / .template-list / pre` 的卡片自动整行，不写死 id）。界面 135 → **136**。
- **本批次真 bug（已修）**：改网格后「点卡片头铺开」高度恒为 0。根因是 `.info-card .info-body` 带 `overflow:hidden`，作为 flex 项时「自动最小尺寸」被算成 0，行高只剩 head 的 40px、正文溢出被裁；修法 `.info-card .info-body { overflow:hidden; flex: 0 0 auto; }` + 网格 `align-items: start`。探针实测 `bodyRect` 0 → 315、`cardHeight` 51 → 366。
- 本批次回归：**32 个脚本 / 758 项 / 381 秒**全绿（界面 136）。
- 新坑：① 网格化后要同时给 `.info-body` 写 `flex: 0 0 auto`，否则「自动最小尺寸为 0」会静默吃掉正文高度；② 宽卡片判定必须按内容而不是按 id，否则以后新加的表格卡片会挤在半列里。
- 待办（等用户决定 / 已授权未开工）：安全审计的 3 个 P0（外壳无导航守卫、更新通道可替换、隐私 JS 加固全在隔离世界）与 7 个 P1 逐项修；修完之前 1.17.9 的「隐私浏览器」定位要如实说明边界。


