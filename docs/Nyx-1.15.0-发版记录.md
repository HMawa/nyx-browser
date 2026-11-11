# Nyx 1.15.0 · 发版记录

> 版本：**1.15.0**（上一版 1.14.0）
> 源码树：`<项目根目录>`（**本次首次纳入 git 版本控制**）　安装版：`<安装目录>`（仍为 1.2.9，需在应用内点「检查更新」）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`updates-archive\1.15.0\`
> 本次工作：**四项功能 + 一次工程治理**（git、置顶导入导出、瀑布联动慢请求、扩展回滚 + dry-run JSON）

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 源码纳入 git：`.git` 初始化 + `.gitignore` 补齐 + 基线提交与 `v1.14.0` tag | 工程治理 | `.gitignore` |
| 2 | 地址栏「置顶建议」支持**导出 / 导入 JSON**（合并去重、上限 5 条、非法跳过） | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js,css}` |
| 3 | 抓包瀑布联动「**只看慢请求**」阈值（读 `nyx:tb:slow-ms`，与类型筛选是与关系） | 新功能 | `src/renderer/toolbox-ui.js` |
| 4 | 扩展在线更新**版本历史与回滚**：`extensions.json` 可带 `history`（最近 3 版），设置页展示历史并回滚到旧版 | 新能力 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js}` |
| 5 | `make-release` 全链路 **`--dry-run --json`**（release / restore / clean-updates / prune） | 新能力 | `scripts/make-release.js` |
| 6 | 验证扩容：界面体验 39 → **42** 项 | 验证资产 | `scripts/verify-ui-polish.js`、`scripts/verify-all.js` |

新增 IPC：`nyx:as:pinned-export`、`nyx:as:pinned-import`。

---

## 二、逐项说明

### 2.1 置顶建议导入 / 导出

置顶（v1.11.0 引入，`pinned-suggestions.json`）此前只能一条条点，换机器或重装就没了。现在设置 → 外观 → 置顶管理底部有两个按钮：

- **导出 JSON**：写 `{app:'Nyx', kind:'pinned-suggestions', version:1, exportedAt, items:[{url,title}]}`；
- **导入 JSON**：兼容上面这种封装，也兼容裸数组；只收 `http(s)`（其余计 `invalid`），已存在计 `skipped`，超过上限 `PINNED_SUGGEST_MAX = 5` 也计 `skipped`；返回 `{ok, added, skipped, invalid, total, path}`，界面按中文提示。

主进程同时支持 `payload.path`：传了路径就直接读写（便于自动化与脚本），不传才弹系统对话框。

### 2.2 抓包瀑布：只看慢请求

瀑布区（v1.12.0）在多请求时间轴上新增一枚开关胶囊「只看慢请求」：

- 阈值与列表**同一个键** `localStorage['nyx:tb:slow-ms']`（默认 1000ms），每次渲染重读 → 在列表面板改阈值，瀑布下次渲染即跟随；
- 与 8 枚类型胶囊是**与**关系；统计行变三段：`显示 5 / 30 条 · 跨度 1.2 s · 慢 ≥1000 ms`（未勾选不显示末段）；
- 开关不持久化，每次打开详情重置（与类型筛选一致）。

### 2.3 扩展在线更新可回滚

更新源的 `extensions.json` 现在可以带每个扩展的**最近 3 个版本**：

```json
{ "key": "my-ext", "version": "1.0.0", "file": "ext-my-ext-1.0.0.zip",
  "sha256": "…", "size": 105113,
  "history": [ { "version": "1.0.0", "file": "…", "sha256": "…", "size": 105113, "at": "…" },
               { "version": "0.9.0", "file": "…", "sha256": "…", "size": 40406,  "at": "…" } ] }
```

设置 →「扩展插件」→「扩展版本历史」按 `history` 逐版列出，「回滚到此版本」走同一套「下载 → sha256 → 安装」链路把旧包装回本机。

### 2.4 `--dry-run --json`

`--release --dry-run --json` / `--restore --dry-run --json` 在 stdout 只输出 JSON（日志与摘要走 stderr），可直接 `JSON.parse` 接入 CI：

```json
{ "dryRun": true, "version": "1.15.0", "installer": {"file": "…", "size": 118816230, "sha256": "…"},
  "actions": [{"order": 1, "op": "copy", "from": "…", "to": "…", "size": …}],
  "totalBytes": 237666030 }
```

### 2.5 本次最重要的经验：contextBridge 不能打桩

写界面状态用例时想当然地在测试里覆盖 `window.nyx.<方法名> = async () => ({...})` —— contextBridge 暴露的对象是**冻结代理**，非严格模式下赋值静默失败，测试照常跑但读到的仍是真实的运行时状态，于是断言全部落空（界面文案不跟着变、提示不出现）。

修法不是"换个打桩姿势"，而是**把判定从 DOM/IPC 里拆出来**：纯函数 + 单参数入口。这同时让测试从"重放整条链路"变成"直接喂状态"，稳定性更高。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / renderer / toolbox-ui / settings / 两个 verify 脚本 / make-release） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、115 项断言全过（64 + 42 + 9）**，97 秒 |
| 置顶导入导出 | `verify-ui-polish.js` | 导出 2 条 → 清空 → 导入 2 条；重复导入 `added=0 / skipped=2`；脏文件 `added=3 / skipped=2 / invalid=1 / total=5` |
| 瀑布慢请求 | ui-polish 假 DOM 自测 43/43 | 边界 999/1000/1001、阈值改 2000 后重渲染生效、与类型筛选组合、空态、打开详情重置 |
| 扩展回滚 | `verify-ui-polish.js` | 更新源提供 `history` 时逐版列出、「回滚到此版本」装回旧版；未提供时该用例跳过 |
| dry-run JSON | `node -e "JSON.parse(...)"` | stdout 2,987 字节纯 JSON、`actions=12`、源目录零写入 |
| 打包冒烟 | `verify-packaged-smoke.js` | 9/9（内含扩展在线更新检查） |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`7b6ab517…d40d`） |

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.15.0.exe`（118,816,230 字节 / 113.3MB） |
| sha256 | `7b6ab517438c0d0d4e9e63f81f3cd80904547690c3863ad2404f4fd6827ed40d` |
| 更新源 | latest.json 1.15.0 + exe + blocks（227 块 × 0.5MB） |
| 留档 | `updates-archive\1.15.0\` |
| 磁盘回收 | `--clean-updates --target both --yes`：更新源 26 个旧文件 + 2 个旧留档目录，共释放 **1949.2MB**（1722.5 + 226.6） |

清理后更新源只剩 1.15.0 一套（113.4MB），留档只剩 1.15.0。

---

## 五、已知边界

1. **扩展回滚窗口只有 3 版**（更新源 `history` 最多给 3 版）；要更长窗口得由发布方在 `extensions.json` 里多写几版。
2. 回滚分两步：发布方改「更新源当前指向哪一版」、客户端点「回滚到此版本」才真正装旧包；只改发布指针不会让本机自动退版。
3. 置顶导入上限 5 条，超出部分直接跳过（不排队），导入前建议先导出备份。
4. 瀑布的慢请求开关不持久化；列表改阈值后，已打开的瀑布需下次渲染才跟随（未加跨面板事件）。
5. git 只从 1.14.0 起有历史，1.3.0–1.13.0 的逐版快照无法追溯（此前无版本控制）。
6. 安装包仍未做 Authenticode 签名，发布者身份无法验证（与 1.3.1 起的既有限制一致）。
