# Nyx 1.19.1 发版记录

> 发布日期：2026-11-19 ｜ 主体：`481ed56`、`c412944`、`6522590`
> 上游：`b79617c`（1.19.0 + 审计交付包）
> 依据：`temp/audit/reports/2026-11-19-1.19.0-接入外壳审计.md`（结论「不放行，P1×2」）

---

## 1. 一句话

这一版不新增功能：把 1.19.0 审计打回的两处 P1（合规声明被换词改写、切回自定义服务端不逐字还原）与三处次要项（跟随默认必然失败、老用户判据看订阅数、换词碰用户数据）修掉，界面结构与三档设计不变。

---

## 2. 逐项处置

| 编号 | 审计结论 | 改了什么 | 验证 |
| --- | --- | --- | --- |
| F1（P1） | 校园档把「Nyx 是通用网络代理工具」显示成「通用网络接入通道工具」 | 身份条拆成两段：范围说明（含「内核」，照常换词）+ 事实陈述（`#net-identity-statement` 带 `data-net-keep="1"`，跳过换词） | `verify-net-terms` 第 28 项按声明原文定位，要求 500 字内必须有 `data-net-keep`；`verify-ui-polish` 端到端断言声明原样、范围说明变「接入组件」 |
| F2（P1） | 切回自定义服务端后空态与状态条仍是外壳词 | `settings.js` 新增 `netShellTextOriginals` / `netShellAttrOriginals` 两个 Map，改字前记原文；`restoreNetShellText()` 在切到非 campus/enterprise 时先整体还原再停扫 | `verify-ui-polish`：切 custom 后空态回到「暂无订阅」、`#net-identity-scope` 回「内核」；再切回校园空态又变「暂无接入配置」（证明还原不是单向损坏） |
| F3（P2） | 「跟随默认」能选但保存必失败 | `nyx:net:identity-set` 允许写入 `auto`；`net-terms.js` 增加 `IDENTITY_AUTO` 走同一套校验 | `verify-net-terms` 第 19 项「写身份应允许 auto」；`verify-ui-polish` 走真实下拉控件切换，读回 `select === 'auto'` |
| F4（P2） | `auto` 用订阅条数判老用户，加删订阅会把口径翻 | 删掉 `netHasExistingConfig()`，新增 `netIsUpgradeUser()`（先看 `onboarding.json` 的 `pending`，没有标记才看书签/历史/偏好文件）与 `netResolveAutoIdentity()`（一次落盘 `netIdentityResolved`，此后稳定） | `verify-net-terms` 第 20 项：载荷不含 `hasExistingConfig`、判据不看 `subscriptions`、结果确实写进 `netIdentityResolved` |
| F5（P3） | 全局 `split/join` 换词会碰用户数据与错误原文 | `proxy-center.js` 给订阅备注名、订阅地址、`lastError` 文本与状态条打 `data-net-keep` | `verify-net-terms` 第 26 项：sweep 必须跳过 `[data-net-keep]`；`verify-ui-polish` 换词后读到的空态文案仍是旧词 |
| F6（P3） | 测试盲区：没断言 custom 还原、只覆盖关于页 | 两个脚本共补 4 项端到端断言 + 若干静态断言 | 界面回归 139 → **143 项**；接入外壳回归仍 **29 项** |
| F7（P3） | 交付包 HEAD 写 `e91a502` 与实际 `b79617c` 不一致 | `docs/Nyx-1.19.0-审计交付包.md` §3 改成「本文件是 1.19.0 交付当时快照，当前 HEAD 现取」（写死任何提交号都会随下一次文档提交过期），§7 第一步改成 `git checkout v1.19.0`，并新增 §11「发布后审计与 1.19.1 的处置」 | 文档自查：§7 的 checkout 用 tag 不写死提交号；§11 的处置表与本文 §2 逐条对应 |

---

## 3. 验收

| 项 | 结果 |
| --- | --- |
| `verify-net-terms.js` | **29/29** |
| `verify-ui-polish.js` | **143/143**（解锁状态下实测；补上了 F1–F5 四条端到端） |
| 全量 `node scripts/verify-all.js` | **49 脚本 / 48 通过 / 1 失败 / 1155 项 / 745 秒** |
| 唯一失败项 | 界面回归「接入说明按当前状态生成，能一键复制…（D1）」：`系统剪贴板当前不可用`。同一刻命令行 `Set-Clipboard` / `Get-Clipboard` 都报「所请求的剪贴板操作失败。」——本机处于锁屏状态，剪贴板整条链路不可用；**断言未改**，解锁后单跑该脚本为 143/143 |
| 打包 | `dist/Nyx-Setup-1.19.1.exe` **127,338,776 字节**，sha256 `ac301054342724a4e9338d6bd88002c452e9972daad8f70ee8bb6dea2a12383e` |
| 完整性 | `verify:integrity` **9/9**（清单 1.19.1） |
| 包内冒烟 | `verify-packaged-smoke` **12/12** |
| 安装器 e2e | 通过（`--from=1.19.0`：降级 → 升级 → 修复 → 卸载 → 完全卸载） |
| AUD-03 安装保留 | **11/11**（装完更新源里仍有 `Nyx-Setup-1.19.1.exe`，sha/size 与清单一致，旧包已清） |
| 差分 | 1.19.0 → 1.19.1：243 块 / 命中 0 / 0.00%（NSIS 固实压缩，闸门保留） |
| 更新源 | `latest.json` v1.19.1 / size 与 sha 自算一致 / `signature: true` / `keyId dc2cec223e6ea7c7` / notes 17 行 |
| 本机安装 | `%LOCALAPPDATA%\Programs\Nyx\Nyx.exe` FileVersion **1.19.1** |

---

## 4. 四个坑与判断

1. **断言别直接调 IPC**：`window.nyx.setNetIdentity()` 能改主进程状态，但设置页的状态只由 `select` 的 `change` 驱动，直接调 IPC 不会重铺界面——第一版端到端断言因此读到「换词没生效」，实际是实例停在 custom 档。改成驱动真实控件后立刻绿，同时顺带覆盖了 F3 的真实路径。
2. **`#net-identity-statement` 一度没有豁免**：写入触发 MutationObserver，80ms 后 sweep 把事实陈述也换掉。拆分元素比加正则豁免更稳（事实与范围本来就是两句话）。
3. **老用户判据不能用订阅条数**：订阅是运行时状态，会随用户操作变；迁移类判断只能用「一次性落盘的标记」。
4. **下载那条断言曾出现假失败**：字节已落盘但 `DownloadItem` 状态推送还在 `progressing` 的收尾窗口里。改成等状态落定（`completed`/`interrupted`/`cancelled`），不是把 `completed` 放宽成「有文件就行」。

---

## 5. 诚实边界

- 换词仍是**渲染层**行为：主进程日志、原生对话框、内核自身日志不换词（1.19.0 起的口径未变）。
- 订阅、测速、分流、真实出口**仍未逐档真机复测**；三档只保证「呈现层与默认文案」。
- 剪贴板那条红是**环境限制**（锁屏），不是修复项；解锁后单跑已复现为全绿，但全量那一轮的记录保留原样，不美化。
- 差分命中率 0.00% 说明 NSIS 固实压缩下块级差分拿不到好处，闸门继续保留，不做「假节省」。
- 1.17.11–1.17.20 十版仍未补发版记录，本版不补写。

---

## 6. 升级与回退

- 升级：应用内「检查更新」或直接跑 `dist/Nyx-Setup-1.19.1.exe`；覆盖安装，订阅/偏好/密码库不丢（e2e 已验四种覆盖路径）。
- 回退：切回「自定义服务端」档位即逐字回到 1.18.x 的界面与文案；要回退整包则从 `%APPDATA%\Nyx\updates-archive\1.19.0\` 取 1.19.0 安装包覆盖安装。
- 更新源里若 exe 被安装程序删掉，用 `node scripts/make-release.js --restore 1.19.1` 从留档回写。
