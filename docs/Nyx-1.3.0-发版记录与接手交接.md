# Nyx 1.3.0 · 发版记录与接手交接

> 版本：**1.3.0**（上一版 1.2.9，2026-09-29）
> 发版日期：2026-10-21
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`%APPDATA%\Nyx\updates-archive\1.3.0\`
> 本次工作：接手项目后清空 1.2.9 遗留的三项体验待办 + 发版链路自动化，并做真机端到端验收

---

## 一、这次做了什么（四条线）

| # | 事项 | 类型 | 主要文件 |
|---|---|---|---|
| 1 | 地址栏下拉历史建议（键鼠联动、隐私模式禁用） | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/renderer.js`、新增 `addr-suggest.{html,css,js,preload.js}` |
| 2 | 工具箱页签栏溢出横滑 | 体验修复 | `src/renderer/style.css`、`src/renderer/toolbox-ui.js` |
| 3 | 设置分区记忆滚动位置 | 体验修复 | `src/renderer/settings.js` |
| 4 | 发版脚本留档 + `--restore`（升级链路二次同步自动化） | 工程链路 | `scripts/make-release.js` |
| 5 | 清理遗留备份文件 + 新增两个端到端验证脚本 | 卫生 / 验证 | 删除 `bookmark-bar_20260925_230940_621.js`；新增 `scripts/verify-address-suggest.js`、`scripts/verify-ui-polish.js` |

全部改动遵循既有工程约定：中文注释与文案、UTF-8 无 BOM、零第三方依赖、不改 `vendor`、不动用户数据、打包仍走 `src/**` 自动收包。

---

## 二、逐项说明

### 2.1 地址栏下拉历史建议（新功能）

**为什么**：1.2.x 的地址栏只有「输入 + 回车」，历史记录只能在工具箱里翻，回访老页面全靠手打。这是用户最常用的浏览器肌肉记忆，也是 1.2.9 交接文档里点名的体验缺口。

**怎么做的**（关键决策都在代码注释里）：

- **浮层用独立 BrowserWindow**：地址栏在外壳（`UI_HEIGHT=124`）内，下拉必须盖在标签视图（WebContentsView，原生子视图）之上；DOM 浮层会被子视图整体盖住——这与书签浮层的限制完全同源，所以复用同一套「独立无边框窗口 + `getContentBounds` 屏幕坐标换算」。
- **绝不抢焦点**：`focusable:false` + `showInactive()`。否则地址栏一失焦，用户打字就被打断。
- **透明窗口 + CSS 画面板**：`transparent:true`、`hasShadow:false`，圆角/描边/落影全在 `addr-suggest.css` 里，颜色全部取 `theme-nyx.css` 的主题令牌，四套主题自动跟随。
- **匹配与高亮都在主进程**：渲染层只发「输入内容 + 地址栏屏幕坐标」，主进程算命中、维护高亮下标、决定回车选中项。键盘（↑↓/回车/Esc）与鼠标（移入/点击）共享同一份状态，不会出现"鼠标指 A、回车跳 B"。
- **匹配规则**：只从历史记录取、只认 `http(s)`（内部页 `nyx:`、`file://` 不进建议）、按最近访问排序、前缀命中优先、去重、上限 8 条、不区分大小写、同时匹配网址与标题。
- **默认无高亮**：直接回车 = 按地址栏原文导航（符合直觉）；按了方向键或鼠标移入才有高亮项，此时回车走建议。
- **隐私红线**：全隐私模式**完全不出建议**。历史本身在隐私模式不写入，若把普通模式积累的条目展示出来等于泄漏痕迹——渲染层（不查询）与主进程（`suggestBlocked`）各有一道闸。
- **收起时机**：地址栏失焦（180ms 延迟，给"点浮层"留点击窗口）、切标签、切模式、Esc、导航后。**注意：主窗口 `blur/move/resize` 不参与收起**——新建浮层窗口本身会触发这些事件，挂上去会把刚弹出的列表立刻收掉（本次实测踩过的坑，已写进交接文档工程约定第 9 条）。

**验证**：`node scripts/verify-address-suggest.js` —— 真实 Electron + 隔离 userData + CDP，**12/12 PASS**：浮层出现、条目数正确、内部页与本地文件被过滤、↑↓ 高亮、浮层高亮与主进程一致、回车取到 URL、选中后自动收起、无命中不弹窗。

### 2.2 工具箱页签栏溢出横滑

**为什么**：工具箱从 3 个页签长到 8 个（资源 / 抓包 / 页面 / 调试 / 视频 / 书签 / 历史 / Cookie），460px 面板下每个页签被压到 30px 出头，中文标签直接糊在一起。

**怎么做的**：

- 页签改为 `flex: 0 0 auto` + `min-width: 44px`，**不再压缩文字**；容器 `overflow-x: auto` 横向滚动，滚动条压到 3px；
- 纵向滚轮在页签栏上转横向（`deltaMode` 行/页分别按 16px / clientWidth 换算；Ctrl+滚轮是缩放手势，原样放行；未溢出时不拦截）；
- 切页（点击与 `openToolboxPane` 程序化切页）后当前页签 `scrollIntoView` 并留 8px 余量，避开两端渐隐；
- 两端渐隐用 `mask-image`，方向由 `data-fade=start|end|both` 按 `scrollLeft` 动态切换，**颜色全部 `color-mix` 从主题令牌派生，零新色值**（素纸等浅色主题同样成立）；
- 键盘可达：页签可 Tab 聚焦，聚焦即滚入视野，焦点环内收 1px 避免被渐隐削掉。

**验证**：`node scripts/verify-ui-polish.js` 的 A 段 **9/9 PASS**：8 个页签、最窄 44px、`scrollWidth 383 > clientWidth 314`、切到 Cookie 页签后 `scrollLeft=69` 且左右余量 `257/4`（完整可见）、`data-fade=start`、滚轮 `scrollLeft 0→69` 且 `defaultPrevented=true`、Tab 聚焦自动滚入。

### 2.3 设置分区记忆滚动位置

**为什么**：设置中心 7 个分区共用一块滚动区，翻到「扩展插件」中间再切去「关于与更新」，回来又被弹回顶部，长分区尤其烦。

**怎么做的**：

- 切走前记录当前分区 `.sec-scroll` 的 `scrollTop`，切回时恢复一次；**不会在用户滚动过程中反复重置**；重复点同一分区不做搬动；
- 落盘 `localStorage['nyx:settings:scroll']`（设置窗口是 file:// 默认 session，跨窗口重开保留），读写全 `try/catch`，损坏 / 配额满 / 被禁用时静默降级为"仅本次窗口有效"；
- 脏数据过滤（只认已登记分区名 + 有限非负数）、200ms 节流写盘、`beforeunload` 补写最后一段；
- 「网络与代理」分区没有 `.sec-scroll`（由 proxy-center 自管多层滚动容器），主动不介入，避免两边互相覆盖。

**验证**：`verify-ui-polish.js` 的 B 段 **5/5 PASS**：目标 240px → 切走切回恢复 240、二次往返仍 240、`localStorage` 落盘 `{"appearance":240}`、无脚本异常。

### 2.4 发版脚本留档 + `--restore`（升级链路二次同步自动化）

**为什么**：`installer.nsh` 升级完成会删两个 `updates` 目录里的 `*.exe`（保留 `latest.json`），也会延迟删除安装程序自身。结果是——**升级一轮后更新源里只剩清单、下不到包**，之前必须手工把 `dist` 里的 exe 再复制回去，交接文档把它列为待办第 3 条。

**怎么做的**（`scripts/make-release.js`，97 → 377 行）：

- 正常发版在原四步之后加**第五步留档**：`%APPDATA%\Nyx\updates-archive\<版本>\`（不在 installer 删除范围内、与 userData 同处、卸载/覆盖安装都不影响；刻意不用并不存在的 `<安装目录>\Nyx-archive`）；
- 新增 `--restore`：不读 `dist`、不重新构建，从归档根挑**版本号最大**（按数值比较，`1.2.10 > 1.2.9`）的一份回写更新源；更新源已有同版本同 sha256 时提示「无需恢复」并跳过；
- sha256 改为 4MB 分块流式计算（历史上有过 900MB 的包）；
- 失败路径全中文：归档缺失 / 为空、清单缺失或不可解析、exe 缺失 → 退出码 1；sha256 与清单不一致 → 只告警（清单是权威校验源）；
- 头部注释据实写明 `installer.nsh` 删哪些路径、为什么归档放这里、四种用法示例。

**验证**（release-ops 用真实 127MB 包在临时目录演练，已清理）：正常发版 → 三份（dist / 更新源 / 留档）`Get-FileHash` 一致 → 删掉更新源 exe 模拟 installer → `--restore` 恢复且 hash 一致 → 再跑一次走「无需恢复」分支 → 空归档 / 清单缺失 / exe 缺失均正确报错。

### 2.5 卫生与验证资产

- 删除 `src/renderer/bookmark-bar_20260925_230940_621.js`（书签栏改造前备份，全项目 grep 无引用，`index.html` 只引 `bookmark-bar.js`）；
- 新增两个可复跑的端到端验证脚本（都是"真实 Electron + 隔离 userData + CDP"，不碰真实用户数据）：
  - `scripts/verify-address-suggest.js`（12 项）
  - `scripts/verify-ui-polish.js`（16 项）
- 两个脚本都内置了一个环境坑的处置：**启动前必须 `delete env.ELECTRON_RUN_AS_NODE`**，否则 Electron 退化成纯 Node、`require('electron').app` 为 undefined，main.js 启动即崩。

---

## 三、验收汇总

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / renderer / addr-suggest / settings / toolbox-ui / make-release / 两个验证脚本） | 全部通过 |
| 地址栏建议 | `node scripts/verify-address-suggest.js` | **12/12 PASS** |
| 页签横滑 + 设置滚动记忆 | `node scripts/verify-ui-polish.js` | **16/16 PASS** |
| 运行时异常 | 两个脚本内 CDP `Runtime.exceptionThrown` 采集（主窗口 + 设置窗口） | 0 异常 |
| 打包内容 | `asar list` 检查 `dist/win-unpacked/resources/app.asar` | `addr-suggest.*` 与改动后的 `settings.js` / `toolbox-ui.js` 均在包内 |
| 发版一致性 | `Get-FileHash` 比对 dist / 更新源 / 留档 | 三处 sha256 一致 |
| 用户数据 | 全部验证使用 `NYX_USER_DATA` 临时目录；真实 `%APPDATA%\Nyx` 未被任何验证写入 | 符合 |

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.3.0.exe`（127,037,714 字节 / 121.2 MB） |
| sha256 | `87ceffe1240c55f1ee89c075bfe83e980030e01bd0fa23f796b16de7dee2e370` |
| 更新源 | `%APPDATA%\Nyx\updates\`（`latest.json` + `Nyx-Setup-1.3.0.exe`） |
| 留档 | `%APPDATA%\Nyx\updates-archive\1.3.0\`（同清单 + 同包） |
| 构建命令 | `& 'C:\Program Files\nodejs\npm.cmd' run dist`（本机 `npm.ps1` 被执行策略拦住，用 `npm.cmd` 等效） |
| 发布命令 | `node scripts/make-release.js --notes "…"` |
| 升级方式 | 在 1.2.9 里点「检查更新」（启动后 8 秒也会自动检查一次），或在安装目录跑 `Nyx-Setup-1.3.0.exe` 覆盖安装 |
| 升级后 | 更新源里的 exe 会被 installer 删掉，之后需要重新放包时执行 `node scripts/make-release.js --restore` |

`latest.json` 的 notes 已写入中文更新说明（应用内更新提示会显示）。

---

## 五、已知边界与风险

1. **安装版仍是 1.2.9**：本次只完成构建与发布，未在用户机器上跑覆盖安装（不动正在运行的应用）。需要在应用内点「检查更新」完成升级。
2. **留档会累积占盘**：每次发版在更新源 + 留档各存一份 121MB 包，`updates-archive` 目前无自动清理。
3. **`--restore` 不校验数字签名**：只回写 exe + 清单；若要防篡改，需在清单里补 signature 字段并校验。
4. **页签渐隐连描边一起淡化**：遮罩挂在 `#tb-nav` 容器上，不改 DOM 就只能如此；要保留完整描边需再包一层内层滚动容器。
5. **3px 滚动条让页签可视高度略紧**：`tb-head` 38px 行高下按钮可视区偏窄，必要时降到 2px。
6. **地址栏建议不跟随窗口移动**：主窗口移动/缩放期间不重定位（此时地址栏必然失焦、浮层已收起），属于可接受行为。
7. **PROGRESS.md 已过期**：根 `PROGRESS.md` 停在 1.0.12，只是历史快照；**权威现状以本文与 `output\Nyx项目交接文档.md` 为准**。

---

## 六、接手约定（后续开发者必读）

1. 所有注释 / 文案 / 提交说明用中文；文件 UTF-8 无 BOM。
2. 不破坏 `%APPDATA%\Nyx` 下的书签、历史、订阅、密码库；验证一律用 `NYX_USER_DATA` 临时目录。
3. 贴输入框 / 贴页面的浮层一律独立 BrowserWindow + `focusable:false`，且**不要在主窗口 `blur/move/resize` 上收浮层**。
4. 「全隐私模式」红线：恒代理绝不直连、历史/扩展/密码库禁用、**地址栏建议不出**；指纹伪装值必须取代理出口真实情况且主进程与页面一致。
5. 打包用 `npm run dist`（卡执行策略时用 `npm.cmd`），发版用 `node scripts/make-release.js`，别再手工往更新源复制 exe。
6. 改动涉及界面交互时，优先补一个 `scripts/verify-*.js`（真实 Electron + CDP），把验收固化下来——本次两个脚本就是模板。
7. 发版三件套：① `package.json` 版本号 ② `npm run dist` ③ `make-release --notes`；发完核对 dist / 更新源 / 留档三处 sha256 一致。
