# Nyx 1.8.0 · 发版记录

> 版本：**1.8.0**（上一版 1.7.0，同日 2026-10-21）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`%APPDATA%\Nyx\updates-archive\1.8.0\`
> 本次工作：1.7.0 之后列的五项——切到已开标签、收藏浮层最近使用与子文件夹、旧包清理命令、抓包只看失败、历史自定义区间

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 建议里的「已打开」徽标**可点击切过去** | 功能增强 | `src/main.js`（新 IPC `nyx:tabs:activate-by-url`）、`addr-suggest.js/.css`、`addr-suggest-preload.js` |
| 2 | 收藏浮层：**最近使用分组** + **右键建子文件夹** | 功能增强 | `src/main.js`、`bm-folder.{js,css}`、`bm-folder-preload.js` |
| 3 | `make-release --clean-updates`（旧安装包清理，默认 dry-run） | 工程链路 | `scripts/make-release.js` |
| 4 | 抓包「只看失败」开关 | 功能增强 | `src/renderer/toolbox-ui.js`、`style.css` |
| 5 | 历史「自定义」时间区间 | 功能增强 | `src/renderer/toolbox-ui.js`、`style.css` |
| 6 | 验证脚本扩容：地址栏建议 48 → **52 项**、界面体验 24 → **28 项** | 验证资产 | 两个 verify 脚本 |

---

## 二、逐项说明

### 2.1 「已打开」可点，切过去而不是再开一个

- 之前徽标只是提示。现在：**当前页**保持静态；**已打开 / ×N** 变成可点徽标（强调色 + hover），点它调 `nyx:tabs:activate-by-url`，主进程按 URL 找到那个标签并激活，同时收起建议浮层。
- 场景：想回到已经开着的那一页时，不必再开重复标签。

### 2.2 收藏浮层：最近使用 + 右键建子文件夹

- **最近使用**：主进程把「上次收藏落到的文件夹」记到 `<userData>/bookmark-folder-recent.json`（最多 3 个），浮层顶部置顶显示（左侧一条强调虚线区分），减少反复翻找。落盘读写全 try/catch，记录失败不影响收藏本身。
- **右键文件夹行**：在该文件夹**下面**新建子文件夹并收藏（名字取底部输入框，留空自动命名 `新文件夹 <日期>`）——这就是"收藏进子文件夹"的入口；普通点击仍是"收藏到这个文件夹"。
- 实现注意：`addFolder` 的父级不能传 0（`findById` 排除根节点），已按"有父级才传 parentId"处理。

### 2.3 `--clean-updates`：旧安装包一键清理（默认 dry-run）

更新源里堆了 1.2.9 以来的多个安装包。新命令：

```powershell
node scripts/make-release.js --clean-updates                 # 只列，不删
node scripts/make-release.js --clean-updates --yes           # 真正删除
node scripts/make-release.js --clean-updates --keep-n 2 --yes # 保留最近 2 版
node scripts/make-release.js --release --prune --clean-updates
```

- **必须保留**：`latest.json` 指向的版本（无条件）、版本号最大的 N 个（默认 1）；其它任何文件不动。
- 三重护栏：只处理更新源**直接子目录**里的文件（不递归）、文件名必须匹配 `Nyx-Setup-<x.y.z>` 形式、规范化路径必须仍在 `--source` 之下。
- 默认 dry-run，`--yes` 才删；参数非法 / 更新源不存在 → exit 1。
- 实测（真实更新源 dry-run）：**将删除 10 个旧文件、释放 816.4 MB**，保留 1.8.0 三件套。
- 注意：归档目录不受影响，所以差分基线仍安全；若 `latest.json` 缺失，脚本只能按 keep-n 保护并告警（此时先 `--restore` 更稳）。

### 2.4 抓包「只看失败」

- 判据（据实查过 `src/core/toolbox.js`）：记录带 `failed` 标记**或** `status >= 400`；`status === 0` 表示"进行中/尚无响应"，不算失败。
- 与类型过滤、搜索词是**与**关系；计数文案按最终结果重算；列表是增量的，开关打开时新到的正常请求不会被插入。
- 开关状态记忆在 `localStorage['nyx:tb:net-failed']`。

### 2.5 历史「自定义」时间区间

- 时间段胶囊增至 5 枚（全部 / 今天 / 近 7 天 / 更早 / **自定义**）；选自定义后展开两个 `input[type=date]` + 「应用」。
- 语义：开始日本地 `00:00:00`、结束日 `23:59:59.999`（含当天）；只填一边另一端不限；两端颠倒自动交换；非法日历日不生效并保留上次区间。
- 生效后胶囊显示 `自定义 ▸ M/D–M/D`，meta 追加区间后缀；记忆 `nyx:tb:history-range=custom` + `nyx:tb:history-custom`。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / addr-suggest / bm-folder / toolbox-ui / updater / make-release / 三个验证脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、87 项断言全过（52 + 28 + 7），56s** |
| 地址栏建议 | `node scripts/verify-address-suggest.js` | **52/52 PASS** |
| 界面体验（含工具箱两项） | `node scripts/verify-ui-polish.js` | **28/28 PASS** |
| 打包冒烟 | `node scripts/verify-packaged-smoke.js` | **7/7 PASS** |
| `--clean-updates` | Lead 独立演练（临时目录 dry-run / `--yes` / `--keep-n 2`） | dry-run 文件数不变；`--yes` 只删旧版，保留 latest 与 keep-n；再跑「没有需要清理的」 |
| 真实 dry-run | `--clean-updates`（不加 `--yes`） | 将删 10 个文件、释放 816.4 MB，实际未删 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`a32c0f00…34b5`） |

新增断言：后台已开页面带可点「已打开」、点击后激活该标签、收藏浮层有「最近使用」、文件夹行右键建子文件夹且书签落在子文件夹里、历史「自定义」展开并生效、抓包「只看失败」开关与记忆。

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.8.0.exe`（118,696,027 字节 / 113.2MB） |
| sha256 | `a32c0f003425c46749f0d19517373f58b658d2429a27fac62ad5f14d039234b5` |
| 更新源 | `%APPDATA%\Nyx\updates\`（latest.json version=1.8.0 + 包 + blocks） |
| 留档 | `updates-archive\1.8.0\`（保留集：1.8.0、1.7.0、1.6.0；1.5.0 已按策略清理） |
| 构建 / 发布 | `npm run dist`（约 20s）→ `node scripts/make-release.js --release --prune --clean-updates --notes "…"` |
| 升级方式 | 应用内点「检查更新」，或跑安装包覆盖安装 |

> 提示：发布时 `--clean-updates` 只跑了 dry-run（816.4MB 可回收）。要真正回收磁盘，执行
> `node scripts/make-release.js --clean-updates --yes`（保留当前 1.8.0）。

---

## 五、已知边界

1. 安装版仍为 1.2.9，本次只构建发布，未强装。
2. 「已打开」按 URL 精确匹配（不同 query 视为不同页面）；激活的是第一个匹配到的标签。
3. 最近使用最多记 3 个文件夹，且只在"收藏成功"时更新。
4. `--clean-updates` 不碰归档目录（差分基线安全）；`latest.json` 缺失时保护能力下降，先 `--restore`。
5. 自定义区间只在点「应用」时生效（输入过程中不实时过滤）；时间戳为 0 的记录在受限区间下不显示。
