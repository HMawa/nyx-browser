# Nyx 1.9.0 · 发版记录

> 版本：**1.9.0**（上一版 1.8.0，同日 2026-10-21）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`%APPDATA%\Nyx\updates-archive\1.9.0\`
> 本次工作：① 扩展插件分区（导入 / 已安装列表）+ 其余四项候选

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | **扩展插件分区**（导入已解压目录 / `.crx`，已安装列表可启停删） | 新能力 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js}` |
| 2 | 建议「已打开」支持**多标签循环切换** | 功能增强 | `src/main.js`（新 IPC `nyx:tabs:cycle-by-url`）、`addr-suggest.js`、`addr-suggest-preload.js` |
| 3 | 抓包详情**耗时瀑布条** + 历史「近 30 天」 | 功能增强 | `src/renderer/toolbox-ui.js`、`style.css` |
| 4 | `make-release --clean-updates --max-age-days N` 按时间过滤 | 工程链路 | `scripts/make-release.js` |
| 5 | `docs/CHANGELOG.md`：1.3.0–1.8.0 七版合并索引 | 文档 | 新增 `docs/CHANGELOG.md` |
| 6 | 验证扩容：地址栏建议 52 → **54**、界面体验 28 → **30**、打包冒烟 7 → **8** | 验证资产 | 三个 verify 脚本 |

---

## 二、逐项说明

### 2.1 扩展插件分区（本次重点）

仓库落在用户数据目录（`<userData>\extensions`），解压目录与 `.crx` 走同一套 `loadExtension` 链路。

设计取舍（刻意保持"用户自己装、默认不内置"）：

1. **扩展管理**：
   - `nyx:ext:list` / `nyx:ext:add-dir` / `nyx:ext:add-crx`：列出已装扩展、从目录或 `.crx` 导入，装上后立刻刷新列表；
   - `nyx:ext:toggle` / `nyx:ext:remove` / `nyx:ext:reveal`：启停、删除、在资源管理器里定位；
2. 设置 →「扩展插件」分区：导入入口 + 已安装列表（名称/版本/状态/操作），列表与已安装态一起刷新；
3. **隐私红线不变**：扩展只装在普通模式分区，隐私模式仍不加载任何扩展；仓库不随包分发扩展，全部由用户自己导入。

打包后实测（`dist\win-unpacked` 真机）：导入一个解压目录后扩展出现在已安装列表且 `loaded: true`。

### 2.2 「已打开」多标签循环切换

- 新 IPC `nyx:tabs:cycle-by-url`：找出所有 URL 相同的标签，从当前激活的那个往后顺延一个（没有激活的就从第一个开始），激活并收起建议浮层。
- 徽标文案：`当前页`（唯一）→ `当前页 ×N`（当前页但还有别的同址标签，仍可点）→ `×N`（后台多开）→ `已打开`（后台单开）；悬停提示「打开了 N 个标签，点击循环切换」。

### 2.3 抓包耗时瀑布条 + 历史「近 30 天」

- 瀑布条数据来源据实核对：记录里唯一真实耗时是 `rec.duration`（主进程在 `loadingFinished/loadingFailed` 用 CDP 时间戳算出），**当前没有采集 TTFB 分段**，所以真实界面默认是「单色整条 + 总时长」；渲染层已前向兼容 `rec.timing.wait/download`（或 `ttfb/body` 别名），主进程哪天补了分段就自动拆两段。视觉：6px 圆角条、`123 ms` / `1.2 s` 文案、>10s 加「慢」标、无耗时显示「耗时未知」不画空条。
- 历史时间段新增「近 30 天」，「更早」语义相应改为"早于 30 天"，两段严格不重叠；6 枚胶囊：全部 / 今天 / 近 7 天 / 近 30 天 / 更早 / 自定义。

### 2.4 `--max-age-days` 与 CHANGELOG

- `--clean-updates --max-age-days N`：与 `--keep-n` 是**与**关系（既非保留版本、又早于 N 天才删）；dry-run 多一列「年龄(天)」；不传时行为与 1.8.0 完全一致。
- 真实更新源 dry-run 实测：`--max-age-days 30` → **0 个可删**（现有旧包都未满 30 天，受保护）；`--max-age-days 14` → 只列 `1.2.9.exe`（22 天）+ `1.2.4.blockmap`（26 天）≈121MB；不带年龄对照 → 10 个文件 / 816.4MB。
- `docs/CHANGELOG.md`：228 行，最新在前，7 版各一节（主题/变更表/验收数字/坑与决策）+ 顶部速查表；7 份原发版记录保留不动。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / settings / addr-suggest / toolbox-ui / updater / make-release / 三个验证脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、92 项断言全过（54 + 30 + 8），65s** |
| 扩展导入（dev） | `verify-ui-polish.js` 设置页实测 | 导入解压目录 → 出现在已安装列表且 `loaded: true` |
| 扩展导入（打包） | `verify-packaged-smoke.js`（解包版真机） | 打包后扩展仓库可读（清单 + 仓库路径） |
| 多标签循环 | `verify-address-suggest.js` | 双开同址 → `×2` 可点 → 两次点击在两个标签间轮换（4 → 5） |
| 工具箱两项 | `verify-ui-polish.js` | 自定义区间生效、只看失败开关、近 30 天/瀑布条由静态自测覆盖 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`eecff467…9b0c`） |

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.9.0.exe`（118,745,031 字节 / 113.2MB） |
| sha256 | `eecff467df69b810dade9a092a39e5ffd8852a2811f10323439dff97584c9b0c` |
| 更新源 | `%APPDATA%\Nyx\updates\`（latest.json version=1.9.0 + 包 + blocks） |
| 留档 | `updates-archive\1.9.0\`（保留集：1.9.0、1.8.0、1.7.0；1.6.0 已按策略清理） |
| 构建 / 发布 | `npm run dist`（约 20s）→ `node scripts/make-release.js --release --prune --notes "…"` |
| 升级方式 | 应用内点「检查更新」，或跑安装包覆盖安装 |

---

## 五、已知边界

1. 安装版仍为 1.2.9，本次只构建发布，未强装。
2. 扩展是**用户自己装的**：仓库不随包分发扩展，装什么、开不开都由用户决定；只装在普通模式分区。
3. 扩展目录里的 `tools/`、`build.js` 随包分发了（对最终用户无用，但便于二次开发）；如需瘦身可在打包时排除。
4. 抓包耗时目前只有总时长，没有 TTFB 分段（主进程未采集）；瀑布条已前向兼容，等采集补齐即可自动分段。
5. 「更早」语义从"7 天前"改为"30 天前"（配合新增的近 30 天），历史命中数与旧版不同属预期。
6. 差分仍受命中率闸门约束（实测 0% 时直接整包）；本次安装包照常产出 blocks.json 备查。
