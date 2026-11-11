# Nyx 1.3.1 · 发版记录

> 版本：**1.3.1**（上一版 1.3.0，2026-10-21 同日）
> 发版日期：2026-10-21
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（**仍为 1.2.9，待应用内升级**）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`%APPDATA%\Nyx\updates-archive\1.3.1\`
> 本次工作：把 1.3.0 留下的三个「建议增强」与发版脚本的两块短板（留档清理、完整性与签名校验）补齐

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 地址栏建议：书签并入且排序优先、来源徽标 | 功能增强 | `src/main.js`、`src/renderer/addr-suggest.js`、`addr-suggest.css` |
| 2 | 地址栏建议：命中片段 `<mark>` 高亮 | 功能增强 | `src/main.js`（下发 query）、`src/renderer/addr-suggest.js`、`addr-suggest.css` |
| 3 | 地址栏建议：输入法组合期不查询 / 不误导航 | 体验修复 | `src/renderer/renderer.js` |
| 4 | 发版脚本：`--prune [n]` 留档自动清理 | 工程链路 | `scripts/make-release.js` |
| 5 | 发版脚本：`--restore` 完整性强校验 + Authenticode 签名状态 | 工程链路 | `scripts/make-release.js` |
| 6 | 发版脚本：清单读取忽略 UTF-8 BOM、不可用原因准确提示 | 健壮性 | `scripts/make-release.js` |
| 7 | 验证脚本升级：地址栏建议 12 → **17** 项 | 验证资产 | `scripts/verify-address-suggest.js` |

---

## 二、逐项说明

### 2.1 书签并入建议（排序优先 + 来源徽标）

- 数据来源从「只有历史」扩到「书签 + 历史」：书签树递归摊平，只取 `http(s)` 节点，文件夹本身不入建议（不是可导航目标）。
- 排序（强 → 弱）：**书签前缀命中 → 历史前缀命中 → 书签包含命中 → 历史包含命中**；同 URL 去重时书签胜出（收藏比访问更能代表"这就是我要的"）。
- 书签条目在浮层里带「书签」徽标（`--accent-14` 底 + `--accent-24` 描边，四套主题自动跟随）。
- 书签存储读取失败只降级为「只有历史」，不连带拖垮建议。

### 2.2 命中片段高亮

- 主进程把本次查询词（原文）随数据下发给浮层；浮层用 `document.createTextNode` / `createElement('mark')` **拼 DOM 节点**完成高亮，全程不碰 `innerHTML`——标题与网址都来自外部网页，任何字符串拼 HTML 都是自找 XSS。
- 标题最多高亮 3 处、网址最多 2 处，避免整行花屏；高亮行内再提一档背景（`--accent-40`），保证"当前行 + 命中"两层信息都在。

### 2.3 输入法守卫

- `compositionstart` → 置位并取消待执行的查询；组合期间 `input` 事件一律不查询（否则查出来的是拼音字母，既闪屏又没意义）。
- `compositionend` → 复位并补一次查询，把上屏后的文字算进建议。
- `keydown` 在组合中直接放行：回车是「确认候选词」、方向键是「翻候选词」，不能被地址栏导航或建议高亮吃掉。

### 2.4 `--prune [n]` 留档自动清理

- 保留归档根下**版本号最大**的 n 份（默认 3），语义比较（`1.2.10 > 1.2.9`），不是字符串排序。
- 只删形如 `x.y.z` 的直接子目录；非版本目录与普通文件只告警跳过；双保险校验父目录就是归档根。
- 归档根与更新源路径重叠（任一方向包含）时**拒绝执行**，绝不误删更新源里的安装包。
- `n` 非 ≥1 整数 → 中文报错 + exit 1；单独执行不读 `dist`；`--release --prune` 发版后清理；`--prune --restore` 先清后恢复。

### 2.5 `--restore` 完整性强校验 + 签名状态

- **先校验后复制**：重算 sha256 与 size，必须与归档清单一致；不符 → 中文报错 + exit 1，此时连更新源目录都不会被创建（不会留下半截状态）。`--force` 才跳过。
- **签名状态**：`powershell -NoProfile -Command Get-AuthenticodeSignature`（20s 超时；结果以 Base64(UTF-8) 回传，避开控制台 GBK 乱码）：
  - `Valid` → 「发布者签名有效｜<Subject>」；
  - `NotSigned` → 「本机未配置代码签名证书，发布者身份无法验证，已按完整性校验放行」（告警放行）；
  - `HashMismatch` / 其它异常 → 告警「文件可能被篡改」，默认 exit 1，`--force` 才继续；
  - PowerShell 不可用 / 超时 / 输出不可解析 → 告警「无法进行签名校验」后继续（完整性校验仍然生效）。
- 正常发版路径也会打印签名状态，并汇总进「发布摘要」。

### 2.6 清单读取忽略 BOM + 提示准确

- 新增 `readManifest()`：读文本 → 去掉开头 `\uFEFF` → `JSON.parse`，失败返回 null 不抛；所有读清单的位置统一走它。
  真实踩点：用 PowerShell `Set-Content -Encoding utf8` 改写清单会写入 BOM，原实现直接「清单无法解析」，最终还误导成「归档目录为空」。
- 归档不可用原因分三类提示：归档根不存在 / 没有任何 `x.y.z` 目录 / 有目录但全部不可用（逐条列原因）。

---

## 三、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check src\main.js src\renderer\renderer.js src\renderer\addr-suggest.js scripts\make-release.js scripts\verify-address-suggest.js` | 全部通过 |
| 地址栏建议（含 1.3.1 增强） | `node scripts/verify-address-suggest.js` | **17/17 PASS** |
| 页签横滑 + 设置滚动记忆（回归） | `node scripts/verify-ui-polish.js` | **16/16 PASS** |
| `--prune` 语义排序 | 临时归档 1.2.8 / 1.2.9 / 1.2.10 / 1.3.0 / 1.3.1 + 非版本目录 | 保留 `1.3.1、1.3.0、1.2.10`，删 `1.2.9、1.2.8`；非版本目录告警跳过；二次执行「没有需要清理的留档」；`--prune 0` exit 1 |
| `--restore` 篡改拦截 | 篡改归档清单 sha256（无 BOM）后恢复 | exit 1「完整性校验未通过」，**更新源目录未被创建**；`--force` 通过并标注已跳过 |
| `--restore` BOM 容忍 | 清单首三字节 `EF BB BF` | 提示「已忽略 BOM 后正常解析」，完整性通过并成功回写 |
| `--restore` 签发状态 | 真实 1.3.0 安装包 | 「未做 Authenticode 签名…已按完整性校验放行」 |
| 真实数据安全 | 每次演练前后核对 `%APPDATA%\Nyx\updates` 文件指纹 | 全程未变；演练目录均在 `%TEMP%` 并已清理 |

> 说明：`Get-AuthenticodeSignature` 对非 PE 文件返回 `UnknownError`，脚本按「异常」处理并中止 —— 这是刻意偏保守的取舍；离线或证书链异常导致误判时用 `--force`（同时跳过完整性校验，高危）。

---

## 四、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.3.1.exe`（127,039,037 字节 / 121.2 MB） |
| sha256 | `ee3d93192c70c1591bfc14e79735387082b9d898290c1853cc4a9c2e9a306a03` |
| 更新源 | `%APPDATA%\Nyx\updates\`（`latest.json` version=1.3.1 + 安装包） |
| 留档 | `%APPDATA%\Nyx\updates-archive\1.3.1\`（保留集：1.3.1、1.3.0） |
| 构建 | `& 'C:\Program Files\nodejs\npm.cmd' run dist`（本机 `npm.ps1` 被执行策略拦住） |
| 发布 | `node scripts/make-release.js --release --prune --notes "…"` |
| 一致性 | dist / 更新源 / 留档三处 sha256 一致（已核） |
| 升级方式 | 应用内点「检查更新」（启动后 8 秒也会自动检查），或跑安装包覆盖安装 |

> ⚠️ 参数陷阱：`--prune` 单独出现时脚本只清留档、**不发行**。要「发版 + 清理」必须显式带 `--release`：`--release --prune`。

---

## 五、已知边界

1. 安装版仍为 1.2.9，本次只构建发布，未强装（不动正在运行的应用）。
2. 无代码签名证书：签名校验只能报 `NotSigned`，无法验证发布者身份；要真正验签需给构建机配 Authenticode 证书。
3. `--force` 同时绕过完整性与签名校验，属高危开关，仅限明确知情时使用。
4. `--prune` 按**目录名**语义排序，不读清单里的 version 字段；目录名与清单版本不一致时以目录名为准。
5. 更新源目录里仍留着 1.2.9 / 1.3.0 的安装包（installer 升级时会删 `*.exe`，无需手工清）。
