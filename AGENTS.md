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

- 版本：`package.json` = **1.17.0**；产物 `dist/Nyx-Setup-1.17.0.exe`（118,754,042 字节，sha256 `e2a4dab25ba4a278cb65b55ceef67997cf5b48989719c32201b44fadc299cc52`），`dist/win-unpacked` = 1.17.0。
- 运行时：Electron 43.7.4 / Chromium 150 / Node 24；Windows。
- 运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用）。
- 回归基线（本轮实测，全绿）：`npm run verify` = 地址栏建议 **68 项** + 界面体验 **85 项** + 出站链路守卫 **12 项** + 下载链路 **16 项** + 打包冒烟 **11 项** = **192 项 / 5 个脚本 / 129 秒**。
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

- 五个脚本：`verify-address-suggest.js`（地址栏 68）、`verify-ui-polish.js`（界面 85）、`verify-link-guard.js`（出站链路守卫 12，纯 Node 不启动 Electron）、`verify-downloads.js`（下载链路 16，纯 Node 不启动 Electron）、`verify-packaged-smoke.js`（包内 11，缺 `dist/win-unpacked` 时跳过）。另有 `bench-transfer.js`（吞吐基线，**不进回归**，测大文件快慢用）。
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
- 进度：C1（`b848b6b`）、A4（`d33be32` + `018780b` + `2c9f248`）、A2（`4919583`）、A1（`e214f9d`）、B4+B5（`533ea57`）、B1（`e7c5288`）、B2（`6bb61f0`）、B3（`1a6e6e1`）、A3（`8942dab`，已测基线 + 已可量化）已完成；**下一项 A5（核显优先 + 启动显示 GPU + 可切独显）**。
