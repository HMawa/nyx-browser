# Nyx 1.19.2 发版记录

> 发布日期：2026-11-19 ｜ 主体：`12cca7e`、`21ffb7b`、`d82e87e`（+ 本发版提交）
> 上游：`e37e43b`（1.19.1）
> 依据：`temp/audit/reports/2026-11-19-1.19.0-接入外壳审计.md` 与 1.19.1 复核（F4 新装默认档回归）

---

## 1. 一句话

这一版不新增功能：修 1.19.1 的两处遗留——新装用户走完/跳过首次引导后被误判成「自定义服务端」，以及接入方式下面那两行多余小字。

---

## 2. 逐项处置

| 项 | 现象 | 改了什么 | 验证 |
| --- | --- | --- | --- |
| F4（P1） | 全新安装选「跟随默认」后，`onboarding.json` 的 `pending:false` 被 `netIsUpgradeUser()` 当成老用户，默认档变成 custom | `build/installer.nsh` 全新安装写 `{pending:true,fresh:true}`；升级/覆盖/修复只在标记不存在时写 `pending:false`，不覆盖已有 fresh；`onboarding.js` 归一化保留 `fresh`；`main.js` 的 `netIsUpgradeUser()` 先判 `fresh===true` 返回 false | `verify-net-terms` 第 20 项新增 4 条断言；运行时 `{pending:false,fresh:true}`+auto → campus，`{pending:false}`+auto → custom；`verify-onboard` 14/14 |
| UI | 身份条下面两行「自己配置服务端与订阅…」「换接入方式只改界面叫法…」 | `settings.html` 删除 `#net-identity-note` 与 `#net-identity-scope`，只保留带 `data-net-keep="1"` 的 `#net-identity-statement`；`settings.js` 同步删写入 | `verify-ui-polish` 143/143；源码实例 `note:false, scope:false`，bar 只剩「接入方式 / 选择器 / 合规声明」 |
| 文档 | 1.19.1 发版记录/台账未提这两项 | 本记录 + CHANGELOG + README + AGENTS + 台账 | 见下 |

---

## 3. 验收

| 项 | 结果 |
| --- | --- |
| `node scripts/verify-all.js` | **49 个脚本 / 49 通过 / 0 失败 / 0 跳过 / 1155 项 / 559 秒** |
| 界面回归 | **143/143** |
| 接入外壳 | **29/29** |
| 隐私自检 | **29/29** |
| 隐私指纹面 | **70/70** |
| 打包 | `dist/Nyx-Setup-1.19.2.exe` **127,338,888 字节**，sha256 `923620341f55183408f39e3dfc204053d9206b80f22dd18bcfd491c6e5631906` |
| 签名 | Authenticode **Valid**（`CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`） |
| 完整性 | `verify:integrity` **9/9** |
| 包内冒烟 | `verify-packaged-smoke` **12/12** |
| 安装器 e2e | **56/56**（全新安装 11.3s → 降级 1.19.1 13.2s → 升级 1.19.2 11.7s → 修复 11.2s → 保留数据卸载 839ms → `/DELETEAPPDATA` 703ms；测试后 `%APPDATA%\Nyx`、HKCU 两键、快捷方式已还原，`%LOCALAPPDATA%\Nyx` 无残留） |
| 差分 | 1.19.1 → 1.19.2：243 块 / 命中 0 / 0.00%（NSIS 固实压缩，闸门保留） |
| 更新源 | `latest.json` v1.19.2 / size 与 sha 自算一致 / `signature: true` / `keyId dc2cec223e6ea7c7` / notes 8 行中文 |
| 留档 | 保留 **1.19.2 / 1.19.1 / 1.19.0**，清理 1.18.2（释放 121.4 MB） |

---

## 4. 三个坑与判断

1. **`pending:false` 不能表达“走完引导”**：它同时出现在「全新安装完成」和「升级用户」两种语义里。修法不是再猜一个文件，而是让安装器显式写 `fresh:true`，并且升级绝不覆盖它——这样「是否老用户」是一次性事实，不随用户后来加删订阅变化。
2. **`fresh` 必须在安装器写、在主进程保留**：只在 `onboarding.js` 补字段不够，因为升级安装会重写 `onboarding.json`；`${IfNot} ${FileExists}` 保护的是「已有标记」，不是「已有 pending 值」。
3. **身份条拆元素比正则豁免稳**：事实陈述与范围说明本来就是两句话，拆开并给事实陈述 `data-net-keep="1"`，比在 sweep 里加一堆例外可维护。这次按用户要求把两行说明整体删掉，只留事实陈述，逻辑更简单。

---

## 5. 诚实边界

- 三档仍只改**呈现层与默认文案**；订阅、测速、分流、真实出口未逐档真机复测。
- 身份条现在只有合规声明与选择器；「跟随默认」仍保留，但不再有解释性小字。
- 差分命中率 0.00% 说明 NSIS 固实压缩下块级差分拿不到好处；闸门继续保留，不做“假节省”。
- 1.17.11–1.17.20 十版仍未补发版记录，本版不补写。
- `v1.19.1` tag 不移动；`v1.19.2` 为新 tag。

---

## 6. 升级与回退

- 升级：应用内「检查更新」或直接跑 `dist/Nyx-Setup-1.19.2.exe`；覆盖安装，订阅/偏好/密码库不丢（e2e 已验四种覆盖路径）。
- 回退：切回「自定义服务端」档位即逐字回到 1.18.x 的界面与文案；要回退整包则从 `%APPDATA%\Nyx\updates-archive\1.19.1\` 取 1.19.1 安装包覆盖安装。
- 更新源里若 exe 被安装程序删掉，用 `node scripts/make-release.js --restore 1.19.2` 从留档回写。
