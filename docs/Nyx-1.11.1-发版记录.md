# Nyx 1.11.0 / 1.11.1 · 发版记录

> 版本：**1.11.1**（1.11.0 同日发布，1.11.1 是它的修复版）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`updates-archive\1.11.1\`
> 本次工作：建议右键置顶、**扩展在线更新**（发布端 + 客户端）、抓包按耗时排序与慢请求告警、`--clean-updates --json`

---

## 一、1.11.0 变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 地址栏建议支持**右键置顶 / 取消置顶**（置顶项排最前、带「置顶」徽标） | 新功能 | `src/main.js`、`src/preload.js`、`addr-suggest.{js,css,preload.js}` |
| 2 | **扩展在线更新**：客户端读更新源的 `extensions.json`，检查、下载并安装新版 | 新能力 | `src/main.js`、`src/preload.js`、`settings.js` |
| 3 | 抓包列表**按耗时排序** + **慢请求阈值告警** | 功能增强 | `src/renderer/toolbox-ui.js`、`style.css` |
| 4 | `--clean-updates --json`（stdout 纯 JSON，供脚本消费） | 工程链路 | `scripts/make-release.js` |
| 5 | 验证扩容：地址栏建议 55 → **58**、界面体验 33 → **34**、打包冒烟 8 → **9** | 验证资产 | 三个 verify 脚本 |

### 1.11.1 修复

| # | 问题 | 修法 |
|---|---|---|
| 1 | **同一扩展从不同来源安装会出现两条重复记录**（先从解压目录安装、再在线更新 → 列表里两条同名） | `core/extensions.js` 的 `install()`：原来只按"源路径 sha1"判重，不同来源天然不同 id。现在**先按路径 id 找、找不到再按扩展名找**，同名视为「更新」并复用原条目与原目录（`updated: true`） |

> 这个 bug 是 1.11.0 的在线更新端到端验证发现的（隔离环境里 `installed` 出现同名两条），当场修掉并重新发版。

---

## 二、逐项说明

### 2.1 建议右键置顶

- 浮层里右键任意条目 = 置顶 / 取消置顶；落盘 `<userData>/pinned-suggestions.json`（上限 5 条，超出提示先取消一条）；
- 置顶项在查询命中时**排最前**并带「置顶」徽标；置顶状态变化后浮层自动重查重排；
- 置顶也受查询约束（`url/title` 必须命中输入），不做"永远显示"。

### 2.2 扩展在线更新（客户端）

- **客户端**：`nyx:ext:online-check` 读更新源（本地目录直读 / http(s) 走 Updater 取文本），对比已装版本给出 `updatable`；`nyx:ext:online-install` 下载/复制安装包 → 校验 sha256 → `installCrx` 安装 → 清临时包；
- 设置 →「扩展插件」→「扩展更新」卡片：点「全部更新」检查 → 有新版则装上 → 刷新列表。

实测（真实更新源 + 打包态）：`ext-my-ext-1.0.0.zip` 39.5KB / sha256 `01e1436e…`；`online-check` 列出 1 个、`updatable` 判定正确；`online-install` 成功且列表仍只有 **1 条**（1.11.1 修复后）。
### 2.3 抓包排序与慢请求

- 抓包工具条下新增一行：`按时间 / 按耗时` 排序 + `慢请求` 开关 + 64px 阈值输入（默认 1000ms，`0/负数/非数字` 退回 1000，上限 10 分钟）；
- 按耗时 = 降序、**0/未知排最后**、同耗时按 seq 稳定；切换排序记忆 `nyx:tb:net-sort`；
- 增量到达的请求**不全表重排**：累计 20 条或每 2 秒先到者触发一次，重排保留滚动位置；
- 行上「慢」标记**始终**按阈值渲染（开关只影响筛选），筛选链：类型 → 只看失败 → 慢请求 → 搜索。

### 2.4 `--clean-updates --json`

stdout 纯 JSON（过程日志转 stderr）：
`{ target, keepN, keepNByTarget, maxAgeDays, dryRun, updates:{files:[{name,size,version,ageDays,kind}],deleted,freed}, archive:{dirs,deleted,freed}, totalFreed }`。
清理只针对安装包（`Nyx-Setup-*.exe` + 同版本 `.blockmap`），`extensions.json` 本体永不进候选。

真实只读 dry-run：`--clean-updates --json --target both` → **14 个候选 / ≈1.02 GB**，归档 0（keep-n 3 全保留）。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / extensions / settings / toolbox-ui / addr-suggest / make-release / 三个验证脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、101 项断言全过（58 + 34 + 9），83s** |
| 建议置顶 | `verify-address-suggest.js` | 置顶后排第一且带「置顶」徽标；取消后恢复 |
| 在线更新（打包态） | `verify-packaged-smoke.js` | 从更新源 `extensions.json` 拉取并安装成功；列表**只有 1 条** |
| 抓包排序/慢请求 | ui-polish 假 DOM 自测 | 55/55（排序稳定性、999/1000/1001 边界、四层筛选、慢标记、节流） |
| `--json` | `node -e JSON.parse(...)` | 通过；dryRun:true、updates 14 个候选、归档 0 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`94c96abf…92b8`） |

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.11.1.exe`（118,761,174 字节 / 113.2MB） |
| sha256 | `94c96abfb528e1e51dd2b0e8f92636bed80a9f737e30e243a9126464287292b8` |
| 扩展包 | `ext-my-ext-1.0.0.zip`（40,406 字节，sha256 `01e1436e…96ba`） |
| 更新源 | `%APPDATA%\Nyx\updates\`（latest.json 1.11.1 + exe + blocks） |
| 留档 | `updates-archive\1.11.1\`（保留集：1.11.1、1.11.0、1.10.0） |
| 构建 / 发布 | `npm run dist`（约 20s）→ `node scripts/make-release.js --release --prune --notes "…"` |

---

## 五、已知边界

1. 安装版仍为 1.2.9，本次只构建发布，未强装。
2. 1.11.0 与 1.11.1 同日发布：**1.11.0 有"重复条目"缺陷，请直接升 1.11.1**（更新源 latest.json 已指向 1.11.1）。
3. 扩展包无签名（与安装包一致），只做 sha256 完整性校验。
4. 置顶只影响建议列表顺序，不改书签/历史；上限 5 条。
5. 抓包"慢请求"开关本身不持久化（阈值会持久化），重开工具箱恢复默认关闭。
