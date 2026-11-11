# Nyx 1.10.0 · 发版记录

> 版本：**1.10.0**（上一版 1.9.0，同日 2026-10-21）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`%APPDATA%\Nyx\updates-archive\1.10.0\`
> 本次工作：修掉抓包耗时恒定 0 的真 bug + 瀑布条分段 + 剪贴板建议 + 归档清理

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | **修 bug：抓包耗时恒为 0**（混用 wallTime 与单调时钟），并补 TTFB / 下载分段 | Bug 修复 + 功能 | `src/core/toolbox.js` |
| 2 | 耗时瀑布条消费分段数据：**图例 + 每段悬停说明 + ≈ 标记** | 体验 | `src/renderer/toolbox-ui.js`、`style.css` |
| 3 | 建议新增**「剪贴板里的网址」**一行 | 新功能 | `src/main.js`、`src/renderer/addr-suggest.js`、`addr-suggest.css` |
| 4 | `make-release --clean-updates --target updates\|archive\|both` | 工程链路 | `scripts/make-release.js` |
| 5 | 验证扩容：地址栏建议 54 → **55**、界面体验 30 → **33** | 验证资产 | 两个 verify 脚本 |

---

## 二、逐项说明

### 2.1 修 bug：抓包耗时一直是 0（本轮最有价值的一项）

**根因**：`toolbox.js` 里算耗时用的是「`Network.loadingFinished.timestamp × 1000 − wallTime × 1000`」——`timestamp` 是**单调时钟**（秒，自某个任意起点），`wallTime` 是**纪元秒**。两者基准不同，相减得到负数，被 `Math.max(0, …)` 夹成 0。结果：**界面上所有请求都显示"耗时未知"**，耗时瀑布条只能画单色条。

**修法**：在 `requestWillBeSent` 记下 `monoStart`、`responseReceived` 记下 `monoResponse`、完成时调用 `applyTiming()`：

- `duration = (finished − start) × 1000`
- `timing.wait = (response − start) × 1000`（TTFB）
- `timing.download = (finished − response) × 1000`

拿不到单调时钟就不写 duration/timing（界面显示"耗时未知"），**绝不给假数字**。

实测（本机拒绝连接的端口，必然快速失败）：记录 `duration: 6ms`、`failed: net::ERR_UNSAFE_PORT` —— 以前这里恒为 0。

### 2.2 瀑布条两段化

ui-polish 的渲染层早已前向兼容，主进程补上数据后自动生效，本轮再补：

- 条上方图例：**「等待 120 ms · 下载 340 ms」**（≥1000ms 转秒）；
- 每段 `title`：「等待响应（TTFB）：120 ms」/「内容下载：340 ms」；
- `|wait+download − duration| > 5ms` 时以 `duration` 为准并标 **≈**（条宽分母仍用两段和，保证不溢出）；
- 降级保留：无 timing → 单色无图例；两段和为 0 → 单色；`duration=0` → 「耗时未知」。

### 2.3 「剪贴板里的网址」建议行

- 每次查询读一次剪贴板；仅当它是**单条 http(s) 网址**、且不在已有候选里时，追加一行「打开剪贴板网址：…」，带虚线「剪贴板」徽标；
- 附加行改为**先预留位置再拼装**（剪贴板行 + 搜索行最多占 2 席），避免"加完又被挤掉"；
- 隐私模式不会走到（建议整体禁用）；剪贴板读失败当没有。

### 2.4 `--clean-updates --target`

- `--target updates`（默认，行为不变）/ `archive` / `both`；
- 归档侧额外护栏：目录名必须 `x.y.z`、目录内必须含 `latest.json` 或对应 exe、先算保留集再删（保留集成员拒删）、年龄按**目录内主文件** mtime（不再取 max，避免新清单把旧包"变新"）；
- 实测（Lead 独立复跑）：`--target archive` 只动归档、更新源文件数不变；`--target both --keep-n 2 --yes` 两边各删 1 个旧版本；`--target foo` → exit 1。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / toolbox / extensions / settings / addr-suggest / 三个验证脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、96 项断言全过（55 + 33 + 8），76s** |
| 抓包耗时 | `verify-ui-polish.js`（本机拒绝连接端口） | `duration: 6ms`（修复前恒为 0） |
| 剪贴板建议 | `verify-address-suggest.js` | 设剪贴板为 URL 后查询 → 出现「剪贴板」行（共 2 行：剪贴板 + 搜索） |
| `--target` | Lead 独立演练（archive / both / 非法值） | 只动目标目录；保护项未删；非法值 exit 1 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`6f59f28f…8c23`） |

> 测试稳健性补充：剪贴板是非隔离状态，脚本开头与剪贴板用例结束后都会清空，避免上一轮残留 URL 把条目数断言带偏（本轮就踩过一次）。

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.10.0.exe`（118,749,936 字节 / 113.2MB） |
| sha256 | `6f59f28f6d22e2689cf67953c8405ebf8f15c5423285ab8f0363b1706c848c23` |
| 更新源 | `%APPDATA%\Nyx\updates\`（latest.json version=1.10.0） |
| 留档 | `updates-archive\1.10.0\`（保留集：1.10.0、1.9.0、1.8.0；1.7.0 已按策略清理） |
| 构建 / 发布 | `npm run dist`（约 20s）→ `node scripts/make-release.js --release --prune --notes "…"` |
| 升级方式 | 应用内点「检查更新」，或跑安装包覆盖安装 |

---

## 五、已知边界

1. 安装版仍为 1.2.9，本次只构建发布，未强装。
2. **升级号是 1.10.0**，比较是语义版本（1.10.0 > 1.9.0），不是字符串比较——更新源/归档/`--prune` 都按语义比较，已验证。
3. 耗时依赖 CDP 的单调时钟：拿不到时间戳的记录（部分 WebSocket 帧 / 缓存命中）仍显示"耗时未知"。
4. 剪贴板建议每次查询读一次剪贴板（仅普通模式）；若剪贴板被其他程序占用会静默跳过。
5. 打开扩展设置页需要扩展已装载（`runtimeId` 存在）；扩展被停用时该按钮会提示失败。
6. `--target archive` 是**整目录递归删除**（不可撤销），默认 dry-run + 多重护栏，务必确认输出后再加 `--yes`。
