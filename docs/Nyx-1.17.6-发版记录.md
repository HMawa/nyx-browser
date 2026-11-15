# Nyx 1.17.6 发版记录

- 版本：**1.17.6**
- 日期：2026-11-15
- 上一版：1.17.5（2026-11-14）
- 产物：`dist\Nyx-Setup-1.17.6.exe`，127,217,296 字节
- sha256：`99d4d0e8d3b162e8bf27e68d683f1363c0b4b0e59f4a99f208ca212f2dd835c6`
- 签名：`CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`（自签名，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`）
- 运行时：Electron 45.3.2 / Chromium 156.0.8078.100 / Node 24.22.2
- 回归：**23 个脚本 / 632 项**，全绿

## 这一版想解决什么

1.17.5 之后，「看得见」这件事还差三处：发版后没人知道差分到底命中多少、夜里自动跑的安装器
e2e 结果只在命令行里、「谁改得多」那张表既不分时间也拿不出去。再加上一份自己攒的名单
换机器只能手敲。这一版把这四件事各自补上，然后发版。

## 提交清单

| 提交 | 内容 |
| --- | --- |
| `a7e1aa3` | 发版收尾顺手量一次差分命中率，写进「更新与差分」卡；失败只告警，新增 `--skip-delta` |
| `b33e436` | 夜间安装器 e2e 跑完写 `nightly-e2e.json`，设置页新增只读状态卡（还没跑过 / 通过 / 失败 / 已过期） |
| `992500e` | 「谁改得多」支持按时间筛选（全部 / 24 小时 / 7 天），并能导出 CSV |
| `5e62fc8` | 隐私名单的「只存这些」模板支持自定义保存与删除 |

## 逐项说明

### 一、发版后自动量差分（`a7e1aa3`）

- **做法**：`scripts/measure-delta-report.js` 只做一件事——取「更新源里那一版」和「留档里
  比它小的最新一版」两个安装包，量一次块级命中率，写进 `<userData>/delta-report.json`。
  它不碰 `latest.json`、不碰安装包、不动留档。
- **`make-release.js` 里的位置很关键**：`autoMeasureDelta` 必须在 `--prune` **之后**调用。
  因为基线要的是"留档里比当前版本小的最新一版"，先清旧留档才量到下次真会用到的那一对。
- **失败只告警**：量不出来就打一行「差分实测没量成（exit …），不影响本次发布。」，
  绝不 fail——测量失败不该挡住已经打好的包。
- **逃生门**：`--skip-delta`。预演（`--dry-run`）会打印说明但**不**调用实测，
  免得预演也去读几百 MB 的文件。

### 二、夜间 e2e 结果进设置页（`b33e436`）

- `scripts/nightly-e2e.js` 跑完写 `<userData>/nightly-e2e.json`；写失败只告警，
  **不把一次跑成功的 e2e 判成失败**。
- `src/core/nightly-status.js` 给四种说法，因为这四件事对用户的处置完全不同：
  还没跑过（给命令）/ 上次通过 / 上次失败（带 error）/ 上次通过但已过期 48 小时
  （「别当成今天的状态」）。
- 读文件失败（非 ENOENT）单独给 `level:'unknown'` 并带 `readError`——「读不到」
  和「没跑过」不是一回事。
- 界面**刻意不给「现在就跑」的按钮**：半夜自动跑的东西，顺手变成手动触发器只会让人
  在开会时点一下，然后十分钟没有浏览器用。

### 三、按时间筛选 + 导出 CSV（`992500e`）

- `aggregateSettingChanges(records, {since, until})`：窗口外的次数进 `outOfRange`，
  `note` 里如实写「另有 N 次在所选时间之外」。窗口内一条都没有、但窗口外有时，
  说法和「从来没有 agent 改过设置」是两句不同的话。
- 没有时间戳的记录在设了窗口时计入 `outOfRange`：它既证明不了在窗口内，也不该假装不存在。
- CSV 只导**聚合后的表格**（每个设置项一行），不导原始流水账；行尾 CRLF（旧版 Excel
  不认纯 LF，会把整份内容塞进一个单元格）；含逗号/引号/换行的字段按 RFC 4180 整体加引号。
- 空名单补一行说明，不导出只有表头的空文件。
- 保存框走**同步** `showSaveDialogSync`：异步那条路在下载那边踩过「窗口先关、Promise 永挂」。

### 四、自定义模板（`5e62fc8`）

- 把自己攒的名单存成模板，换机器一键套；模板单独存 `<userData>/cache-site-templates.json`。
- **只存站点、不存模式**：模板的意思是"这些站点值得离线留"，mode 是用户当下的选择，
  存进去会在套用时把人的选择覆盖掉（而套用本来就已经把 mode 切到 allowlist）。
- 空名 / 空名单 / 重名 / 超过 30 个四种情况都拒绝，并给中文原因。
- 套用走与内置模板完全相同的一条路（先合并不替换、站点逐条列出）。

## 验收

| 项目 | 结果 |
| --- | --- |
| `node scripts/verify-page-cache.js` | 57/57（新增 5 项自定义模板） |
| `node scripts/verify-agent-settings.js` | 27/27（新增 3 项时间窗与 CSV） |
| `node scripts/verify-release-gate.js` | 38/38（新增 3 项差分自动量） |
| `node scripts/verify-ui-polish.js` | 120/120（新增夜间 e2e 卡） |
| `node scripts/verify-signing.js` | 38/38 |
| `npm run verify:integrity` | 9/9 |
| `node scripts/verify-packaged-smoke.js` | 11/11 |
| `node scripts/verify-all.js` | **23 脚本 / 632 项 / 214 秒全绿** |
| 安装器 e2e（发版时自动跑） | 56 项通过 / 0 失败（升级基线 1.17.5） |

## 这次踩到的坑

1. **`Get-Content` 看 UTF-8 源码会把中文显示成 `澶栧３闃叉姢`**——只是显示层的 GBK 误解码，
   文件没坏。结论：看内容一律用 `read` 工具，改内容一律用 `edit`/`write`，
   绝不用 pwsh 的 `Set-Content`/`-replace`。
2. **断言数到了自己写的注释里**（回归门禁那轮）：`code.indexOf('autoMeasureDelta(setupPath)')`
   命中的是**函数定义**（在 prune 之前），次序断言恒假。改用调用点标记
   `': autoMeasureDelta(setupPath);'` 与 `pruneResult = pruneMode();` 比位置。
3. **一次 `edit` 把相邻的一行吃掉**（`const header = [` 被误删），`node --check` 当场抓出。
   教训：`edit` 的 `old_string`/`new_string` 都要带足够上下文，改完立刻 `node --check`。
4. **`applySiteTemplate(privateSitePolicy(), key)` 的旧断言**在加了第三个参数后仍然通过
   （正则没有锚定参数列表结尾），已改成 `/applySiteTemplate\(privateSitePolicy\(\), key/`，
   避免"参数变了但守卫没发现"。
5. **全量回归偶发一次 1 个脚本红、重跑即绿**（界面/地址栏那类重负载脚本）——
   已如实记录，不作为"已知问题"放过，也不许改断言。

## 已知边界

- 块级差分在 NSIS 固排压缩下命中率仍是 **0.00%**（243 块、命中 0），所以照旧整包下载；
  0.2 的闸门留着是为了将来换打包格式，不要提前删。
- 夜间 e2e 的 `--register` 只打印 `schtasks` 命令，不代跑；状态卡也不会替你触发。
- 自定义模板上限 30 个、每个最多 60 个站点；超了明确拒绝，不静默截断。
- CSV 导出的是聚合视图（每个设置项一行），不是审计流水；要逐条请看 `agent-audit.jsonl`。
- 自签名仍然过不了 SmartScreen；`dist-sign` 里留着旧包时，验签脚本会按版本号挑最新的那个。

## 升级方式

- 应用内：设置 → 关于 → 检查更新（这次会顺带把差分实测结果写进「更新与差分」卡）。
- 手动：直接运行 `Nyx-Setup-1.17.6.exe`（会识别为升级安装，保留数据）。
- 回退：`node scripts/make-release.js --restore --version=1.17.5`。
