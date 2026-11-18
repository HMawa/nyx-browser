# Nyx 1.18.2 · 审计交付包

> 给审计方的一站式说明书。所有数字都是 2026-11-18 从磁盘实测取的（脚本 `temp/collect-audit-facts.js`，
> 跑完即删），不是抄记忆。仓库 HEAD `20e849a`，工作树干净。

---

## 0. 一句话结论

1.18.2 已发布、已 tag、已 push。审计上一轮列的 **B2 / B3 / B4 已修并留证**，**B1 按用户选择「A」如实披露**
（接受历史 blob 与 tag 里的旧文档残留，不改写历史、不移动 tag）。三项「未独立复验」的残余风险——小屏布局、
代理不可达时的自检、1.18.1→1.18.2 升级弹窗与首启引导——**已全部补出证据**；唯一一次全量红是**机器级剪贴板不可用**，
复测后 139/139 全通过，断言未改。

---

## 1. 交付物与完整性

| 项 | 值 |
| --- | --- |
| 版本 | `package.json` = **1.18.2** |
| 安装包 | `dist/Nyx-Setup-1.18.2.exe`，**127,323,616 字节** |
| sha256 | `0ceed9baef14b3ce42e320bf30477b743e07d5e3a5c40d8935fc8bac806f3a05` |
| 签名 | Authenticode `Valid`，`CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0` |
| 已装位置 | `%LOCALAPPDATA%\Programs\Nyx\Nyx.exe`，FileVersion **1.18.2**，250,057,048 字节 |
| 更新源 | `%APPDATA%\Nyx\updates\latest.json`：version 1.18.2 / file `Nyx-Setup-1.18.2.exe` / size 127,323,616 / sha256 与文件一致 / `signature` + `keyId dc2cec223e6ea7c7`（Ed25519 清单签名验过） |
| 留档 | `%APPDATA%\Nyx\updates-archive` 下 1.18.2 / 1.18.1 / 1.18.0 |

自签名能证明什么、不能证明什么，见 `docs/Nyx-代码签名说明.md`：**能**证明这个包打出来之后没被人改过；
**不能**替代公信签名（SmartScreen 仍会提示未知发布者，也没有时间戳）。

---

## 2. 运行环境

Electron **45.3.2** / Chromium **156.0.8078.100** / Node **24.22.2**，Windows。
运行时依赖只有两个：`@modelcontextprotocol/sdk`、`zod`（MCP server 用）。
`@electron/fuses` 2.1.3 是**构建期**依赖，用来把 `RunAsNode` 等开关焊死。

---

## 3. 仓库与提交

| 项 | 值 |
| --- | --- |
| HEAD | `20e849a test: 补验第 1 项残余风险（升级弹窗与首启引导），并记录剪贴板那条的复测结论` |
| 远端 `main` | `20e849a4051e3f497988bafbfa715dc6f8a733cf`（已 push，快进，未 force） |
| tag | `v1.18.2 → dfc311d4a4a43266d0457495ceb1c69f74062099`（**未移动**） |
| 工作树 | 干净（`git status --short` 空） |

本轮相关提交（新→旧）：

| 提交 | 内容 |
| --- | --- |
| `20e849a` | 补验升级弹窗与首启引导 + 剪贴板复测结论 |
| `d31eea6` | CHANGELOG 补记发布后同日六件事 + 全量复核结果 |
| `ef5f876` | 补漏 B1 真值残留（10 个 docs 文件）并修正披露口径 |
| `dfc311d` | 补验小屏布局 + AUD-09（代理不可达时的自检） |
| `5c077e7` | 记下 B1 的选择（接受历史泄露，不重写历史） |
| `7315238` | 按上线前复核修 B2 / B3 / B4，把 B1 交给用户决定 |
| `4f944cd` | 自检判定与报告脱敏按审计要求改，并补上三处真实不一致 |
| `c684be5` | AUD-03 换成「装完包还在」的功能判据，接进发版门禁 |

---

## 4. 这一版做了什么

### 4.1 1.18.1（审计打回后的修正版）

| 编号 | 问题 | 改法 |
| --- | --- | --- |
| P1-1 | A2 恒 pass（`uaFullVersion` / `fullVersionList` 低熵读不到，空值分支是空的） | 观察脚本改走 `getHighEntropyValues([...])`；空值 → `unknown`，主版本不一致 → `suspect` |
| P1-2 | A3 正常模式误判「已伪装」 | 加 `canonicalLanguage()` 归一后比较；正常模式不同即 `leak` |
| P1-3 | A4 只拦「中文 + America」 | 语言地区 ↔ 时区地区**双向查表**；时区未知一律 `unknown` |
| P1-4 | A6 分支写反（像素比不一致反而 pass） | 不一致 → `suspect`；缺值 → `unknown` |
| P1-5 | 报告与存证公开真实指纹 | `buildReport/buildReportJson` 默认 `redact: true`；`--raw` 才出原始版且只落 `temp/privacy-audit/` |
| AUD-03 | 字节判据永远不可能为真 | 换功能判据 `verify-installer-retention.js`（装旧版→新包进更新源→覆盖装→包还在且 sha/size 一致→旧包已清），接进发版门禁 |

### 4.2 1.18.2（判定修对之后暴露的三处真实不一致）

| 项 | 现象 | 改法 |
| --- | --- | --- |
| 应用页没有 WebRTC 策略 | 隐私模式第一屏（起始页/设置页）是 `createAppPage()` 造的，漏了 `setWebRTCIPHandlingPolicy` → `RTCPeerConnection` 吐内网地址 | 与 `create()` 同口径设策略 |
| 像素比写死 1 | 系统缩放不是 1（具体值已隐去），真浏览器 dpr 恒等于系统缩放 → 改一半更好认 | 取 `screen.getPrimaryDisplay().scaleFactor` |
| 时区与语言不同地区 | 出口未知时不发 `setTimezoneOverride`，留下「语言 en-US + 中国时区」 | 出口未知时按语言隐含地区选时区；顺手修了 `timezoneOffsetMinutes()` 的符号（原来纽约算成 -300） |

### 4.3 发布之后同一天（都不改二进制，只补证据与口径）

B2 历史存证脱敏（含 CHANGELOG、四份发版记录、审计交付包、两份 privacy-audit 存证；全树扫描 **0 命中**，含内网 IP 与系统缩放）、
B3 计数统一（48 脚本逐个真跑 = **1120 项**，与 `items` 求和对齐）、B4 安装保留验证存证、
残余风险三项补证（见 §5）、B1 选 A 的正式披露（`docs/Nyx-1.18.2-发版记录.md` §8.3）。

---

## 5. 验证证据（可复跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 全量回归 | `node scripts/verify-all.js` | **48 脚本：47 通过 / 1 失败 / 0 跳过 / 817 秒**；失败项是界面回归「接入说明一键复制」，原因见 §6.4 |
| 界面回归（剪贴板恢复后单跑） | `node scripts/verify-ui-polish.js` | **139/139**，该条状态「已复制 1689 字」 |
| 隐私自检判定引擎 | `node scripts/verify-privacy-check.js` | **29/29** |
| 发版门禁 | `node scripts/verify-release-gate.js` | **52/52** |
| 隐私指纹面 | `node scripts/verify-privacy-surface.js` | **70/70** |
| AUD-03 安装保留 | `node scripts/verify-installer-retention.js --installer=dist/Nyx-Setup-1.18.2.exe --previous=dist/Nyx-Setup-1.18.1.exe` | **11/11**（原始输出见 `docs/安装保留验证-1.18.2.md`） |
| 真值扫描 | 见 §7 第 6 步（形状式扫描：UA 串 / 两位数核数 / 四位数分辨率 / Asia 时区 / 小写语言地区标签 / 内网 IP / 系统缩放七类形状；**模式不写进仓库**，避免文档自己变成真值副本） | **0 命中** |
| 小屏布局 | `node temp/probe-small2.js`（临时探针） | 1024×700 与 1366×768：横向溢出 0、竖排标题 0；结构图列 300px，内容超出时自己滚动 |
| AUD-09 代理不可达 | `node temp/probe-small-and-aud09.js` | 切隐私被拒 `PROXY_UNREACHABLE`（写明不降级直连）；普通模式自检 2,843ms、16 项、C2/C3 `unknown` |
| 升级弹窗与首启引导 | `node temp/probe-upgrade-dialog.js` | 1.18.1 报 `phase: available`；原生弹窗「Nyx 有新版本可用：1.18.2」（截图）；覆盖装后 FileVersion 1.18.2；再启动**无 `onboard.html`**、`onboarding.json` 仍 `pending:false` |

证据文件：`docs/上线前残余风险补验-1.18.2.md`、`docs/安装保留验证-1.18.2.md`、
`docs/privacy-audit/1.18.2.md`（脱敏存证）、`docs/实测修复台账.md`（含「发布后全量复核」「全量复核的收尾」两节）。

---

## 6. 审计须知（请先看这七条）

### 6.1 B1：历史 blob 与 tag 里仍有构建机真值（选 A，已披露）

`569595c` 等历史提交里的 `docs/privacy-audit/1.17.20.md` 含当时构建机的真实 UA、核数、屏幕/缩放、语言与时区。
工作区已全部脱敏（全树 0 命中），但**历史 blob 删不掉**；`v1.18.2` tag 指向 `dfc311d`，那份文档也是旧版。
选择 A 的理由与代价写在 `docs/Nyx-1.18.2-发版记录.md` §8.3：不动历史、不移动 tag，接受「克隆者可从历史翻到」。

### 6.2 计数口径只认一个来源

`npm run verify` = **1120 项 / 48 个脚本**，等于 `scripts/verify-all.js` 里 48 条 `items` 之和（2026-11-18 逐脚本实跑核对）。
历史文档里出现过的 1131 / 1113 / 1109 是三次不同口径，已废弃；AGENTS.md §2 现在也写明「只认那个文件」。

### 6.3 字节判据不能用来验 AUD-03

`nyx-keep-package` 是 NSIS `Rename` 的目标串，被 LZMA 实心压缩过，**exe 字节流里搜不到**（实测 `Buffer.includes(...) === false`）。
能证明「装完包还在」的只有功能判据：`docs/安装保留验证-1.18.2.md` 里的 11 项、两轮耗时与 sha/size 对照。

### 6.4 剪贴板那条红是环境问题（已复测）

全量那轮（817 秒）唯一失败是「接入说明一键复制」：`系统剪贴板当前不可用（可能被其它程序占用）`。
当时**没有任何 Electron 进程**在跑，命令行 `Set-Clipboard` 也抛 `所请求的剪贴板操作失败。`——机器级不可用（会话锁屏）。
剪贴板恢复后单跑该脚本：**139/139**，同一条状态是「已复制 1689 字」。**断言没有改过，也没有改成永远通过**。

### 6.5 安装到自定义目录会先卸掉已有安装（本轮实测撞到，值得记）

`Nyx-Setup-*.exe /S /D=<别的目录>` 会走 NSIS 的「先卸旧版」流程：**已装的那份（连同它的注册表项与安装目录）会被删掉**，
用户数据 `%APPDATA%\Nyx` 不受影响。本轮做升级弹窗探针时把用户已装的 1.18.2 卸掉了，已按原样重装并核对
FileVersion 1.18.2 / 250,057,048 字节。审计如果要在隔离环境做安装实验，请用**独立账户或独立机器**，别在装着正式版的机器上试。

### 6.6 隐私自检的诚实边界

- 只证明它测到的面：**TLS 指纹、HTTP/2 帧序、字体全量枚举不在范围**。
- **DNS 出口（C3）永远「无法自证」**——这是设计上的 `unknown`，不是缺陷。
- 没有隐私评分，以后也不会有单一分数（报告里连百分比都没有）。
- 代理给不出出口信息时，画像时区标记「未对齐」，**不发** `setTimezoneOverride`，日志如实写「未对齐」。
- 自检在**应用页**（起始页/设置页）上跑；普通模式不设防，所以普通模式下 `leak` 是如实报告。

### 6.7 更新源目录里还有几份旧的差分清单

`%APPDATA%\Nyx\updates` 里有 `Nyx-Setup-1.17.9 / 1.17.10 / 1.18.0 / 1.18.1 / 1.18.2.blocks.json`。
它们的 exe 已经不在（被 `--prune` 清掉了），说明只是**残留清单**，不会被用到（更新器按 `latest.json` 找包）。
留着是为了万一要回滚时能看到当年块表；不影响升级链。

---

## 7. 建议审计路线（8 步）

```powershell
# 1) 版本与产物
node -e "const p=require('./package.json');console.log(p.version)"
(Get-Item dist\Nyx-Setup-1.18.2.exe).Length
Get-FileHash dist\Nyx-Setup-1.18.2.exe -Algorithm SHA256
(Get-AuthenticodeSignature dist\Nyx-Setup-1.18.2.exe).Status
(Get-AuthenticodeSignature dist\Nyx-Setup-1.18.2.exe).SignerCertificate.Thumbprint

# 2) 更新源三方一致 + 清单签名
node -e "const j=require(process.env.APPDATA+'/Nyx/updates/latest.json');console.log(j.version,j.file,j.size,j.keyId)"
node scripts\verify-update-signature.js

# 3) 干净 clone 跑全量（建议在无并行窗口、没锁屏的环境）
node scripts\verify-all.js

# 4) 隐私自检与脱敏
node scripts\verify-privacy-check.js
node scripts\privacy-audit.js --check

# 5) 发版门禁与安装保留（后者会真装，别在正式机跑）
node scripts\verify-release-gate.js
node scripts\verify-installer-retention.js --installer=dist\Nyx-Setup-1.18.2.exe --previous=dist\Nyx-Setup-1.18.1.exe

# 6) 真值扫描（当前树）：模式不写进仓库，按下面七类形状临时拼一条 grep，跑完不落盘
#    形状：① UA 串（Nyx/数字.数字.数字 或 Electron/数字.数字.数字）
#          ② 两位数核数（数字 + 空格 + 核）
#          ③ 四位数分辨率（四位 x 四位，如 NNNNxNNNN）
#          ④ Asia/ 开头的时区
#          ⑤ 小写语言地区标签（两字母-两字母）
#          ⑥ 内网 IP（RFC1918 三类私有网段）
#          ⑦ 系统缩放/像素比（非 1 的 dpr / scaleFactor 数值）
#    期望 exit 1（0 命中）。若命中，把那行改成「—（已隐藏）」再复扫。
git grep -n -E "<上面七类形状拼成的正则>" -- docs
#    想按当年确切值复查，就把构建机真值临时拼进模式（别写进任何 .md）。

# 7) 真机看一眼（人眼项）
#    1.18.1 上「设置 → 关于与更新 → 检查更新」应弹出「Nyx 有新版本可用：1.18.2」
#    升级覆盖安装后启动不应再出现「欢迎使用 Nyx」引导

# 8) 远端一致性
git ls-remote origin refs/heads/main refs/tags/v1.18.2
```

---

## 8. 数据落点与不入库的东西

| 路径 | 是什么 | 入不入库 |
| --- | --- | --- |
| `%APPDATA%\Nyx` | 用户数据（偏好、书签、历史、密码库、page-cache、private-cache、agent 审计、诊断） | 不入库（用户数据） |
| `%APPDATA%\Nyx\updates` / `updates-archive` | 更新源与留档 | 不入库 |
| `%LOCALAPPDATA%\Programs\Nyx` | 安装目录 | 不入库 |
| `dist/` | 构建产物 | 不入库 |
| `docs/privacy-audit/<版本>.md` | **脱敏**存证，随仓库公开 | **入库** |
| `temp/privacy-audit/<版本>.json` | 原始（未脱敏）自检 JSON | 不入库（`.gitignore`） |
| `temp/probe-*.js` | 一次性探针（小屏、AUD-09、升级弹窗等） | 不入库，跑完删 |

---

## 9. 仍然开放的事项

1. **升级资产没重打**：本次全部改动是文档与验证证据，`dist/Nyx-Setup-1.18.2.exe` 与 `latest.json` 没动。
2. **tag 未随 main 前进**：`v1.18.2` 停在 `dfc311d`（3 个纯文档提交之前）。按约定移动 tag 属于改写已发布的 tag，不做。
3. **审计未独立复验的三项**已由主开发补证（§5），但**仍需审计自己复跑一遍**才算签字——尤其安装保留验证（会真装）。
