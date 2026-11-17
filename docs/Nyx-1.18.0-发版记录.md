# Nyx 1.18.0 发版记录（2026-11-17）

> 版本：**1.18.0**（收口版 + 本地隐私自检）
> 安装包：`dist/Nyx-Setup-1.18.0.exe`（127,323,200 字节 / 121.4 MB）
> sha256：`ef0d4388e54621d8aae44872fbca340a45b8cf0c17fb1d95dd0b7b9c98b8d096`
> 基线提交：`36a2c3c`；本版提交：`c06f2c1`、`569595c` + 文档提交
> 回归：**49 个脚本 / 1104 项 / 681 秒**（48 通过 / 1 失败，失败项见 §4）

---

## 1. 这一版想解决什么

两件事。

第一件是**收口**。1.17.11 到 1.17.20 一共打了十个试装包，一个都没对外发布：安全审计的 P0/P1/P2 收尾、隐私模式改造（指纹面、Worker、切换快路径、标签停靠、切换动画、显卡与字体）、安装器与更新链的修补，都只在本地装着。而更新源里的 `latest.json` 还指向 `Nyx-Setup-1.17.10.exe`——那个包已经被安装程序自己删掉了。也就是说：**任何一台机器的自动升级在这段时间里都是断的**。

第二件是**本地隐私自检**。文档里写"我们伪装了这些"，读者只能选择相信。现在改成：你自己跑一遍，看到每一项的观察值、真实值、判定和理由，复制走，还能随版本比对。

## 2. 提交范围

| 提交 | 内容 |
| --- | --- |
| `c06f2c1` | `feat(privacy): 本地隐私自检——判定引擎、设置页卡片、首次进隐私模式的横幅`（13 文件 +1673/-30） |
| `569595c` | `fix(privacy): 应用页（起始页 / 设置页）也走指纹装配，否则隐私模式第一屏就是真 UA`（4 文件 +384/-3） |
| 文档提交 | 本文件、`CHANGELOG`、`README`、`AGENTS.md`、台账、`docs/privacy-audit/1.18.0.md` |

> 1.17.11 – 1.17.20 **不打 tag**：它们从未发布过，事后补 tag 会让人以为那是发布过的版本。

## 3. 逐项为什么

### 3.1 隐私自检（16 项 / 四组 / 五档）

- 判定引擎 `src/core/privacy-check.js` 是纯模块：不 require electron/fs/path，不联网。这样它能被 `verify-privacy-check.js` 直接调，18 项断言全部是"喂数据看判定"，不需要起窗口。
- **观察值与真实值分离**是这一版的骨架：观察值来自页面自己报（`buildObserverScript()` 在页面主世界跑，900ms 内并行收音频与 WebRTC 候选），真实值来自主进程（`os.cpus()`、主显示器、系统语言、显卡字符串）。
- `TRUTH_REQUIRED = {A1, A3, A5, A6, B1, B3}`：只有这几项在拿不到真实值时**必须**判「测不到」。其余项（C1/C2/B2/A2/D1–D4）靠自己就能判定，不该被连累。第一版把这条规则套到所有项，结果 C1/C2/B2/A2 全变「测不到」，测试当场抓住。
- 报告里禁止出现「100% / 绝对安全 / 完全匿名 / 无法被追踪」和任何百分制评分，有断言守着。

### 3.2 首次进隐私模式的横幅

- 放在 `index.html` 的 `</header>` 之前：标签是 `WebContentsView`，会盖住 body 层 DOM；只有放进 header，外壳变高才能把视图往下推（与"更多菜单让位"同一套机制 `applyShellExtra`）。
- 偏好 `privacyBannerSeen` 存一次，进隐私模式显示一次；切回普通即记已读。

### 3.3 存证脚本 `npm run privacy:audit`

- 起隔离实例（`%TEMP%` 下的 userData、`pickFreePort()` 自选调试端口、spawn 前 `delete ELECTRON_RUN_AS_NODE`）→ 切隐私模式 → 调自检 → 写 `docs/privacy-audit/<版本>.md`。
- 文件里带「与上一版的差异」段；`--check` 做发版门禁：缺文件或缺这两段就 exit 1。
- 不进 `npm run verify`（要起实例、依赖代理可达），进发版门禁。

### 3.4 三个真 bug（都是这一版挖出来的）

1. **应用页从来不装配指纹**（严重）：起始页与设置页走 `TabManager.createAppPage()`，而指纹装配、UA 覆盖、工具箱粘性设置全挂在 `create()` 的 `onTabCreated` 上。结果是隐私模式第一屏读到的仍是 `Nyx/1.17.20 … Electron/45.3.2` 和真实 24 核——自检自己就报了「2 项泄漏」。修法：`createAppPage()` 也调 `onTabCreated`，等它落地再 `loadURL`。实测 `start.html` / `settings.html` 从 `cores 24 / surface null` 变成 `cores 8 / surface 2`。
2. **Emulation 身份对齐命令在导航前发不回执**：`Page.enable` 与三条 `Emulation.*` 在没有文档时发出去不报错、只沉默，每条等满 3 秒还占着同一个调试会话，和紧随其后的补打互斥。修法：这些命令移进 `applySurfaceToCurrentDocument()`（文档已存在）再发，单条超时 1.5 秒。
3. **`judgeA2` 平台归一错**：`navigator.platform` 在 Windows 上返回 `Win32`，而判定用 `/windows/i` 匹配不到，于是自检自称「UA 说自己是 Linux，客户端提示却说 Windows」。改成 `/^win/i`。另一处 `judgeC2` 把对象 `str()` 成 `"[object Object]"`（非空）导致空出口地址判成通过，也已修。

## 4. 验收

| 项 | 结果 |
| --- | --- |
| `scripts/verify-privacy-check.js`（新） | **18 / 18** |
| `scripts/verify-privacy-surface.js` | **66 / 66**（新增 11 条：自检接线 9 + 应用页装配 + CDP 时序） |
| 全量 `node scripts/verify-all.js` | **49 个脚本 / 1104 项 / 681 秒**：**48 通过 / 1 失败** |
| 唯一失败的项 | `界面体验回归` 的「接入说明一键复制」——**会话锁屏导致系统剪贴板整体不可用**（`Get-Clipboard` / `Set-Clipboard` 同时报错），**断言未改** |
| 真实自检（隔离实例，隐私模式） | 结论「没发现泄漏；3 项已伪装、4 项测不到、9 项正常」，用时 **2.2 秒** |
| 存证 | `docs/privacy-audit/1.18.0.md`（2,207 字节），差异段写「与上一版逐项相同」 |
| 安装包 | 127,323,200 / `ef0d4388…`；`verify:integrity` **9/9**；`verify-packaged-smoke` **12/12**；签名 `CN=Nyx Self-Signed` 有效 |
| 更新源 | `latest.json`：version 1.18.0、file 存在、size 一致、sha256 与实际一致、signature + keyId(`dc2cec223e6ea7c7`)、notes 19 行中文 |
| 安装器 e2e（发版脚本内） | **56 项全通过**（升级基线 1.17.20） |
| 真机升级 | 静默安装 exit 0、FileVersion **1.18.0**、启动 **6 进程 890.3 MB**、**装完后更新源里的 1.18.0 包仍在** |
| 差分实测 | 1.17.10 → 1.18.0：243 块 / 命中 0 / **0.00%**（与历史一致：整包是 LZMA 固实流，块级差分本就命中不了） |

## 5. 坑

1. **应用页不装配**这条只能靠真跑发现：静态断言看的是"函数存在"，日志里也没有异常——第一屏悄悄用真值，谁也看不见。
2. **CDP 的 Page 域命令在"没有文档的 webContents"上静默不回执**：不报错、只沉默，等满超时后还占着会话。任何"导航前先下发"的设计都会踩。
3. **交接单要求的字节复核 `nyx-keep-package` 对 NSIS 脚本无效**：这串标记只存在于 `build/installer.nsh` 的编译脚本里（`Rename … .nyx-keep-package.exe`），经 LZMA 压缩后 exe 字节流里查不到（实测 `Buffer.includes` = false）。改用**功能验证**：装完后确认更新源里的包还在（实测 True）。这才是 `16b25b0` 真正修的东西。
4. **锁屏会让整条"复制"链路失败**：系统剪贴板不可用时 `clipboard.writeText` 静默失败、读回来是空串，PowerShell 的 `Get-Clipboard` 也一样报错。属环境限制，记录而不是改断言。
5. **`node -e` 内联写中文/引号在 pwsh 里必炸**（本版又炸一次）：一律先写 `temp/*.js` 再 `node` 执行；`>` 与 `Out-File` 默认 UTF-16LE，日志用 `*>&1 | Out-File -Encoding utf8`。

## 6. 已知边界

- 自检**只证明它测到的面**：TLS 指纹、HTTP/2 帧序、字体全量枚举不在范围。
- **DNS 出口恒为「测不到」**：不去第三方问，就不可能知道解析走了哪条链路。
- 本版**没有隐私评分**，以后也不会有单一分数。
- 自检跑在本地页面（起始页 / 设置页）上：它测的是这个渲染环境的标识，不含站点在服务端能读到的信息。
- **1.17.11 – 1.17.20 从未发布**；停在 1.17.10 及更早、且更新源里的包已被删的机器，需要**手动装一次**这一版才能回到自动升级。
- 时区「未对齐」时不伪装（代理给不出出口地区）；停靠标签超过 12 个会按原地址重开；切换动画 1 秒、可在设置里关掉。
- `campus` 身份不在本版。

## 7. 升级方式

```powershell
# 已装 1.17.x：启动后 8 秒会自动检查一次，或在设置 → 关于与更新里点「检查更新」
# 手动装（也可用于从 1.17.10 及更早断链的机器）
Start-Process "$PWD\dist\Nyx-Setup-1.18.0.exe" -ArgumentList @('/S', "/D=$env:LOCALAPPDATA\Programs\Nyx") -Wait
```

回退：`node scripts/make-release.js --restore --version=1.17.20`（安装包在 `%APPDATA%\Nyx\updates-archive\1.17.20`）。
