# Nyx 1.13.0 · 发版记录

> 版本：**1.13.0**（上一版 1.12.0，同日 2026-10-21）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`updates-archive\1.13.0\`
> 本次工作：扩展「全部更新」、置顶接入工具栏、瀑布按类型筛选、`make-release --dry-run`

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 扩展**一键「全部更新」**（更新源里所有可更新的一次装完） | 功能增强 | `src/main.js`（`nyx:ext:online-update-all`）、`src/preload.js`、`settings.{html,js}` |
| 2 | **置顶建议接入工具栏星标浮层**（点一下就直达，不必先打字） | 新功能 | `src/main.js`、`bm-folder.{js,css}`、`bm-folder-preload.js` |
| 3 | 瀑布时间轴**按请求类型筛选**（8 枚胶囊，多选，不持久化） | 功能增强 | `src/renderer/toolbox-ui.js`、`style.css` |
| 4 | `make-release --dry-run` **全链路预演**（零写入） | 工程链路 | `scripts/make-release.js` |
| 5 | 验证扩容：地址栏建议 60 → **64**、界面体验 37 → **38** | 验证资产 | 两个 verify 脚本 |

---

## 二、逐项说明

### 2.1 扩展「全部更新」

- 抽出 `checkExtensionUpdates()` 与 `installExtensionFromUpdateSource(entry)` 两个共用函数（单装 / 全装同一条路径，都走 sha256 校验与"同名即更新"）；
- 新 IPC `nyx:ext:online-update-all`：把 `updatable` 的扩展逐个安装，返回 `{total, updated[], failed[]}`，**单个失败不影响其它**；
- 设置 →「扩展插件」→「扩展更新」卡片头新增「全部更新」按钮：无更新时提示"所有扩展都已是最新"，有失败时逐条列出失败原因。

### 2.2 置顶接入工具栏

- 星标浮层（长按/右键）顶部新增「置顶建议」分组（主进程下发 `pinned`，最多 5 条），行左侧强调竖条；
- 点击置顶行 → 新 IPC `nyx:bookmarks:folder-open-url` 在当前标签导航并收起浮层；
- 浮层高度按置顶条数动态增加，避免最后一个置顶项被裁掉。

### 2.3 瀑布按类型筛选

- 类型映射：Document→文档、Script→脚本、XHR+Fetch→XHR、Image/Img→图片、Media/kind/WS 帧→媒体、Font→字体、其余→其他；
- 8 枚胶囊（全部 + 7 类）多选、选中 `.is-on`；**不持久化**，每次打开详情重置为「全部」；
- 筛选后用过滤集合重算原点与跨度，统计行 `显示 12 / 30 条 · 跨度 1.2 s`；无结果保留胶囊 + 「当前筛选下没有请求」。

### 2.4 `--dry-run` 全链路预演

- `--release --dry-run`：算完 sha256/差分块/全部目标路径后逐条打印「计划动作（预演，不会执行）」，末尾「预演摘要：共 12 个写入/复制动作，合计约 226.7 MB；未做任何改动」；
- `--restore / --prune / --clean-updates` 同款预演；`--dry-run` 与 `--yes` 同时出现时**以 dry-run 为准**；
- 真机验证：跑前跑后对 `updates` + `updates-archive` 全量文件清单比对 —— **零写入**。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / settings / renderer / bm-folder / toolbox-ui / make-release / 三个验证脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、111 项断言全过（64 + 38 + 9），89s** |
| 全部更新 | `verify-ui-polish.js` | 已是最新时给出「所有扩展都已是最新」 |
| 置顶接入工具栏 | `verify-address-suggest.js` | 浮层出现「置顶建议」分组；点击后当前标签 URL 变为置顶地址 |
| 瀑布筛选 | ui-polish 假 DOM 自测 | 37/37（映射、多选、重算原点、统计、空态、重置） |
| `--dry-run` | release-ops 演练 + Lead 真机 12 动作预演 | 只打印不写；跑前跑后文件清单一致 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`62bd87cd…734c`） |

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.13.0.exe`（118,767,240 字节 / 113.2MB） |
| sha256 | `62bd87cd38f134f858111b9ef56717d9d8cb2224c211fa544834f34b27c8734c` |
| 扩展包 | `ext-my-ext-1.0.0.zip`（39.5KB） |
| 更新源 | latest.json 1.13.0 + exe + blocks |
| 留档 | `updates-archive\1.13.0\`（保留集：1.13.0、1.12.0、1.11.1） |
| 构建 / 发布 | `npm run dist` → `node scripts/make-release.js --release --prune --notes "…"`（可先 `--dry-run` 预演） |

---

## 五、已知边界

1. 安装版仍为 1.2.9；升级走应用内「检查更新」。
2. 置顶建议最多 5 条，浮层里只显示标题（悬停看完整 URL）。
3. 瀑布筛选每次打开详情重置为「全部」，统计分母固定为最近 30 条。
4. `--dry-run` 仍会做只读哈希计算（耗时≈真实发版的哈希阶段），但绝不写文件。
