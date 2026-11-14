# Nyx 安全基线 · C2 CVE 对照与升级计划

> 对应实测清单第 11 项（C2）：「Node / Electron / Chromium 的 CVE 对照 + 缓解 / 升级计划」。
> 本文件的版本号必须与 `package.json` 的 `devDependencies.electron` 和 `src/core/security-baseline.js`
> 里的 `RUNTIME_BASELINE` 一致——`npm run verify` 会跑 `scripts/verify-security-baseline.js` 卡这一点，
> 三处不一致就直接红。

---

## 0. 写在前面的两条规矩

1. **不抄写未核实的 CVE 编号。** 本文件只写「风险类别 + 本仓库的缓解措施 + 复核方法」。
   具体编号必须在发版机联网、按第 3 节的方法现场核对后，才允许补进来；凭记忆或按版本号猜一个
   `CVE-20xx-xxxxx` 写进安全文档，比不写更危险——它会让后面的人以为已经核对过。
2. **版本以构建产物为准。** 下面三行是「这台机器上跑出来的」，不是「设计目标」：
   运行时实际值由 `process.versions` 在启动时读出，并与本文件比对，漂移会在设置→关于→安全基线里显红。

---

## 1. 当前声明基线

| 组件 | 版本 | 来源 | 复核日期 | 状态 |
| --- | --- | --- | --- | --- |
| Electron | `45.3.2` | `package.json` → `devDependencies.electron` | 2026-11-14 | 已固定（不带 `^`/`~`）；第 5 节列的四条公告**全部已覆盖**（本轮从 43.7.4 → 43.8.10 → 45.3.2，两次升级） |
| Chromium | `156.0.8078.100` | Electron 45.3.2 内置（`process.versions.chrome`） | 2026-11-14 | 随 Electron 走；**已跳到 156 线**，此前 150 分支的漂移问题随本次主版本升级消除 |
| Node.js | `24.22.2` | Electron 45.3.2 内置（`process.versions.node`） | 2026-11-14 | 随 Electron 走 |
| 运行时依赖 | `@modelcontextprotocol/sdk` `^1.12.0`、`zod` `^3.23.8` | `package.json` → `dependencies` | 2026-11-14 | 仅 MCP server 使用，不进渲染进程 |

固定 `electron` 版本（无 `^`/`~`）是刻意的：Electron 的小版本升级会带入 Chromium 的整段更新，
必须当成一次完整回归 + 发版来做，不能由 `npm update` 顺手带走。

---

## 2. 风险类别与现有缓解

按「攻击面 → 风险 → 本仓库现状」列。这一节回答的是清单里那个问题：
**我们依赖的运行时如果有洞，Nyx 现在靠什么挡住？**

| 攻击面 | 风险 | Nyx 现状 | 位置 |
| --- | --- | --- | --- |
| 渲染进程拿到 Node 能力 | 页面脚本直接读文件 / 起进程 | 全窗口 `nodeIntegration: false`、`contextIsolation: true`；能力只经 `contextBridge` 白名单暴露 | `src/main.js` 各 `webPreferences`；`src/preload.js` |
| 页面导航到任意 URL | 被 `file://` 之外的地址接管为应用页 | 应用页（起始页 / 设置 / 下载中心）的 `will-navigate` 只放行 `file://`，其余一律拒绝；`setWindowOpenHandler` 一律 deny | `src/core/tabs.js`、`src/main.js` |
| 网页注入 | XSS 后被当成应用页执行、或回传主进程 | 每个 renderer 页面都有 `Content-Security-Policy` meta（`default-src 'self'`）；主进程 IPC 只接受形状校验过的 payload | `src/renderer/*.html`、各 `ipcMain.handle` |
| 拖进来的文件 / 下载 | 恶意附件静默落盘 | 下载必须用户确认落点（同步保存框）或已有明确目录；隐私分区**禁止下载**并给出中文提示 | `src/main.js` `installDownloadHandler()` |
| 远程内容被当成本地应用 | 供应链/钓鱼 | 起始页、设置页、下载中心都是本地 `file://`，不加载任何远程 HTML | `src/renderer/*.html` |
| 隐私模式出口 | 流量绕过代理暴露真实 IP | 隐私分区 `setLink('private','direct')` 默认硬拒绝；只有用户在设置里**看风险并勾确认**后才放行，且每次进入都发中文警告 + 落诊断 + 写模式事件 | `src/core/sessions.js`、`src/core/link-guard.js`、`src/main.js` |
| 崩溃/异常静默 | 出错没人知道 | 主进程 `uncaughtException`/`unhandledRejection`、`child-process-gone`、渲染进程 `render-process-gone`/`preload-error`/`did-fail-load` 全部入诊断，可在设置→诊断里看历史并导出诊断包 | `src/core/diagnostics.js` |
| 代理内核二进制 | 被替换的内核 | `vendor/mihomo/` 不入库，由 `npm run setup-vendor` 拉取；打包产物有 `resources/integrity.json` + `Nyx.exe --verify-integrity` 可校验 | `scripts/fetch-vendor.js`、`scripts/verify-integrity.js` |

---

## 3. 复核方法（每次发版前必做，约 15 分钟）

1. **拿准版本三元组**：`node -e "console.log(process.versions)"` 只能拿到当前 Node；
   真实三元组以启动日志与设置→关于→安全基线的读数为准（那里读的是 Electron 运行时的
   `process.versions.electron` / `.chrome` / `.node`）。
2. **看 Electron 安全公告**：<https://github.com/electron/electron/security/advisories>，
   按「受影响版本区间」比对第 1 节的 Electron 版本。有命中 → 进第 4 节流程。
3. **看 Chromium 稳定版发布说明**：<https://chromium.googlesource.com/chromium/src/+log/stable>，
   重点是标了 `Security:` 的提交；Electron 每次主版本发布会捆绑一段 Chromium，跨版本比较即可。
4. **看 Node 安全发布**：<https://nodejs.org/en/blog/vulnerability>，比对 `24.21.0` 所处的行。
5. **看两个运行时依赖**：`npm audit --omit=dev`（`@modelcontextprotocol/sdk`、`zod`）；
   MCP server 只在用户显式跑 `npm run mcp` 时才启动，且不监听公网。
6. 有命中就把结论写进第 5 节的表格，并在 `docs/实测修复台账.md` 里记一行。

---

## 4. 升级计划与触发阈值

**什么时候必须动 Electron：**

- 命中任一 **Critical / High** 且攻击面落在「渲染进程 / V8 / IPC / 网络栈」→ **当版必须升**，
  不许攒到下一个功能版本；升不了就在发布说明里写清「已知风险 + 临时缓解（关掉哪个特性）」。
- 命中攻击面只在「未启用的特性」（例如我们没用到的 WebGPU 后端）→ 记录在案，随下一个常规版本升。
- 距最新稳定版落后 **≥ 2 个 Electron 主版本** → 排进下一个版本，不等 CVE。

**升级动作序列（固定，不许跳）：**

1. 改 `package.json` 的 `electron` 为精确版本（不带 `^`）→ `npm install`。
2. 同步改本文件第 1 节的表 + `src/core/security-baseline.js` 的 `RUNTIME_BASELINE`。
3. `npm run verify`（431 项 / 18 个脚本全绿）→ `npm run dist` → `npm run verify:integrity dist\win-unpacked`。
4. 起一次真机抽检：起始页、设置页、下载中心、失败页、隐私开关、内置代理。
5. 发版 + 在 `docs/CHANGELOG.md` 写「运行时升级」小节，注明原版本与新版本。

---

## 5. 已核对结论

| 复核日期 | 复核人 | Electron | 结论 | 处置 |
| --- | --- | --- | --- | --- |
| 2026-11-14（升到 45 线） | 联网复核（Electron 安全公告 / CVE 记录 / Debian DLA）+ 本机运行时实测 | `45.3.2` | 第 5.1 节的四条公告**全部已覆盖**（45.3.2 远在修复线之上）。**基线漂移问题本轮一并消除**：Chromium 从 `150.0.7871.250` 跳到 `156.0.8078.100`，不再是"修复只在下一分支"的状态。**不写「已知无风险」**：新分支自身的后续修复仍要跟 | 全量回归 + 重打包 + 真机安装 + 跨两版升级实测后发布（见发版记录） |
| 2026-11-14（升级到 43.8.10 后） | 联网复核（Electron 安全公告 / CVE 记录 / Debian DLA） | `43.8.10` | 第 5.1 节的四条公告**全部已覆盖**：CVE-2026-113798 修在 43.7.6、CVE-2026-115570 修在 43.8.1，43.8.10 都在修复线之上。**仍未消除的是基线漂移**：Chromium `150.0.7871.250` 所属 150 分支已落后于当前稳定分支（Debian 跟踪表里 150.0.7871.100 标 vulnerable、fix 在 156.x） | 已升到 43.8.10 并跑全量回归；150 分支的 Chromium 侧修复在本轮跟随 45 线时拿到 |
| 2026-11-14（升级前） | 联网复核 | `43.7.4` | **2 条 High 影响项**：CVE-2026-113798、CVE-2026-115570；另 2 条已由 43.7.4 覆盖 | 已按计划升级到 43.8.10 |

### 5.1 逐条核对（Electron 45.3.2）

判定口径：只有「影响区间覆盖当前版本」才算受影响。区间取自公告原文。

| 编号 | 问题 | 影响区间（43 线） | 45.3.2 是否受影响 | Nyx 侧缓解 |
| --- | --- | --- | --- | --- |
| CVE-2026-113800 | `hid`/`usb` 权限检查在跨源 iframe 里拿到顶层 frame 的 origin，可能把设备访问授给错误的 frame | `< 43.7.0` | **否**（43.7.0 起修复，45.3.2 远在其上） | 无需额外处理 |
| CVE-2026-114122 | `webContents.beginFrameSubscription` 收到的帧数据未完全校验；GPU 进程已被攻破时可造主进程越界读 | `< 43.7.3` | **否**（43.7.3 起修复） | 无需额外处理 |
| CVE-2026-113798 | `pointerLock` 权限请求可能被归属到错误的 frame，按 origin 授权时会以顶层页面身份放行 | `< 43.7.6` | **否**（43.7.6 起修复） | `src/core/permissions.js` 的「隐私模式默认拒绝敏感权限」继续保留，作为纵深防御 |
| CVE-2026-115570 | eMudhra 一批中间证书被攻破；新版本在 Chromium 网络栈与 Node `tls`/`https`/`fetch` 里加了阻断 | `>= 43.0.0-alpha.1, < 43.8.1` | **否**（43.8.1 起修复） | 不自动信任异常证书：`certificate-error` 全部入诊断 |

### 5.2 升级后仍然存在的事实（写在脸上）

- **Chromium 150 分支的漂移问题已随本次主版本升级消除**：现在跑的是 `156.0.8078.100`。但「跟随」这件事本身没有终点——156 分支往后仍会持续收到 Chromium 侧修复，只有继续跟 Electron 主版本才拿得到。这不是「某个 CVE 命中」，而是基线整体年龄问题。
- 本条与本轮升级无关，但必须一起说：**外部接入模式（CDP）的审计从设计上就不完整**，与 Electron 版本无关；相关边界见设置页「接入模式」卡片与台账 A 项。
- 升级本身没有改动任何权限/证书缓解代码；上述缓解仍在，只是从「唯一防线」退回「纵深防御」。

### 5.3 上一轮记录（保留，便于对照）

| 复核日期 | 复核人 | Electron | 结论 | 处置 |
| --- | --- | --- | --- | --- |
| 2026-11-12 | 本次接手 | `43.7.4` | 本机当时处于锁屏/离线会话，**未联网核对**。已建立版本卡点与复核清单，未写入任何未核实的 CVE 编号。 | 已于 2026-11-14 联网补全（见上表） |

> 上一行刻意留成「未联网核对」而不是「已知无风险」——没核对过就是没核对过，
> 按清单要求，**静默跳过也算缺陷**。

---

## 6. 升级计划（本轮已执行）

**执行结果（2026-11-14，两次升级）：**

1. `package.json` 的 `electron` 由 `43.7.4` → **`43.8.10`**（43 线最新，同一条线改动最小）→ 运行时 `Electron 43.8.10 / Chromium 150.0.7871.250 / Node 24.22.1`。
2. 用户明确要求「根治分支漂移」后，再由 `43.8.10` → **`45.3.2`**（当前稳定线）→ 运行时实测 `Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2`。

**为什么这次直接跳到 45 而不是 44：** 漂移的根因是"跨分支不回流"。44.11.3 只是再走一个同样会被下一个主版本甩开的线；
45.3.2 是当时 `dist-tags.latest`，跳过去才算真的把 Chromium 基线换新（150 → 156）。

**为什么不能只打补丁：** Electron 没有单 CVE 补丁通道，小版本升级会带回整段 Chromium，
必须当成一次完整回归 + 发版（第 4 节的五步序列）。

**下一次升级的触发阈值（写死，别凭感觉）：**

1. 45 线出现「影响区间覆盖 45.3.2」的高危公告 → 立刻升 45 线最新；
2. 45 线停止维护（Electron 官方只维护最近 3 个主版本）→ 升到当时受支持的主版本；
3. Chromium 156 分支出现「正在被利用」的公告 → 不再等，直接跳主版本。

**升级时必须同时改的三处（漏一处就会出现"文档说升了、程序没升"）：**

1. `package.json` 的 `electron` 精确版本；
2. 本文件第 1 节的表 + 第 5 节新增一行复核记录；
3. `src/core/security-baseline.js` 的 `RUNTIME_BASELINE`（`electron` / `chromium` / `node` / `reviewedAt`）——
   `scripts/verify-security-baseline.js` 会断言它与 `package.json` 一致，并在运行时不符时让设置页显示「有差异」。
   （本轮就是被这一条抓出来的：升级后它先红了，才去改声明——这正是设计意图。）

**公告来源（复核时逐条看过）：**

- Electron 安全公告：<https://github.com/electron/electron/security/advisories>
- Chromium 稳定版日志：<https://chromium.googlesource.com/chromium/src/+log/stable>
- Node 安全发布：<https://nodejs.org/en/blog/vulnerability>
- 各 CVE 的原始记录：<https://www.cve.org/CVERecord?id=CVE-2026-113800>、<https://www.cve.org/CVERecord?id=CVE-2026-114122>、<https://www.cve.org/CVERecord?id=CVE-2026-113798>、<https://github.com/advisories/GHSA-jr5w-w6x2-84p9>
- Chromium 150 分支状态（Debian 跟踪表把 150.0.7871.100 标为 vulnerable、fix 在 156.x）：<https://security-tracker.debian.org/tracker/DLA-4677-1>
  （本轮已升到 156 线，这条记录只作为"当初为什么必须跳分支"的证据保留）
