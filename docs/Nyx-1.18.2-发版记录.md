# Nyx 1.18.2 发版记录

> 生成：2026-11-18。上一版 1.18.1 是「审计打回后的修正版」，这一版紧接着补它暴露出来的东西。

---

## 1. 这一版要解决什么

1.18.1 把隐私自检的判定改对之后，自检立刻在隐私模式下报出两项「可疑」和一项「泄漏」——
它们不是判定误报，而是**判定修对了才看得见的真实不一致**。这一版把它们补上：

| 现象（自检原话） | 真实原因 |
| --- | --- |
| C1「WebRTC 吐出了内网地址（172.24.x.x）」 | 隐私模式第一屏（起始页 / 设置页）走 `createAppPage()`，那条路径**没设 WebRTC 策略** → 用默认策略，`RTCPeerConnection` 照样给 host 候选 |
| A6「像素比 1 与系统缩放不一致」 | `privacy-surface.js` 把 `devicePixelRatio` 默认写死 1，而本机系统缩放是 1.5 |
| A4「语言 en-US（地区 US），时区却说 Asia/Shanghai（地区 CN）」 | 出口未知时不发 `setTimezoneOverride`，时区留在本机；语言却换成了画像里的 en-US |
| （修 A4 时又挖出）偏移与时区名自相矛盾 | `timezoneOffsetMinutes()` 符号写反：纽约算出 -300，而 `getTimezoneOffset()` 口径应为 +300 |

另外：1.18.0 的存证文件 `docs/privacy-audit/1.18.0.md` 曾直接写出构建机真实指纹
（UA、24 核、1707×1067/1.5、语言与时区），这一版把它**补正为脱敏版**（不是改写历史，是补正内容）。

---

## 2. 提交范围

| 提交 | 内容 |
| --- | --- |
| `d6c19a2` | `fix(privacy)`: 应用页也受 WebRTC 策略约束、像素比取系统缩放、时区跟语言同一地区、偏移符号改回 `getTimezoneOffset` 口径 |
| 文档提交 | 本发版记录 + CHANGELOG + README + AGENTS 基线 + 台账；`docs/privacy-audit/1.18.2.md` 与补正后的 `1.18.0.md` |

（1.18.1 的四个提交 `e5e1f47` / `e5e1f48` / `e5e1f49` / `e5e1f4a` 已在此前落库，不在本版重复。）

---

## 3. 逐项说明

### ① 应用页的 WebRTC 策略（`src/core/tabs.js`）

`createAppPage()` 建完视图后补一行：

```js
wc.setWebRTCIPHandlingPolicy(this.getWebrtcPolicy(this.getMode()));
```

为什么必须补：起始页与设置页都是 `WebContentsView`，也是 **WebContents**；
隐私模式的第一屏就是起始页，而自检又恰好跑在"当前活动标签"上——
不设策略时它用默认值，`RTCPeerConnection({iceServers:[]})` 会直接把内网地址交出去。
`create()` 早就设过这一行，漏的是应用页这条路径。

### ② 像素比取系统缩放（`src/main.js`）

新增 `currentScreenScaleFactor()`（`screen.getPrimaryDisplay().scaleFactor`，异常回 1），
`attachPrivacySurface()` 里把 profile 展开成 `{ ...baseProfile, devicePixelRatio: currentScreenScaleFactor() }`。

真实浏览器里 `devicePixelRatio` 恒等于系统缩放；只在 JS 里改成 1、而系统缩放是 1.5，
是"只改了一半"，比不改更容易被认出来。

### ③ 时区跟语言取同一地区（`src/core/privacy-hardening.js`）

新增 `LANGUAGE_TIMEZONE`（语言 → 代表性时区）与 `timezoneForLanguage()`（认不出返回空串，绝不瞎猜），
`buildProfile()` 里：

```js
const alignedTz = isValidTimezone(timezone) && !egressUnknown ? timezone : timezoneForLanguage(resolvedLanguage);
const spoofTimezone = isValidTimezone(alignedTz);
```

口径变化（要写进边界）：**出口给了可信时区时仍以出口为准；出口未知时，时区跟语言同一地区**。
理由：`en-US` + `Asia/Shanghai` 这种组合现实里不存在，自相矛盾本身就可识别。
`timezoneForLanguage()` 先按整串 `Accept-Language` 取第一个标签（`en-US,en` → `en-US`），
再回落主语言（`en`）。

### ④ 时区偏移的符号（`src/core/privacy-hardening.js`）

```js
return Math.round((local - asUTC) / 60000);   // 之前写成 asUTC - local
```

`Date.prototype.getTimezoneOffset()` 的口径是"本地比 UTC 慢多少分钟为正"：
纽约（UTC-5）应给 **+300**、东京（UTC+9）应给 **-540**。
写反之后页面里的 `getTimezoneOffset()` 与它自称的时区名互相打脸。

### ⑤ 1.18.0 存证补正

用同一套脱敏口径（真实值列 `—（已隐藏）`、身份面与泄漏/可疑项的观察值隐藏、说明里的真实值替换）
把 `docs/privacy-audit/1.18.0.md` 补正，并在文件里注明"在 1.18.1 修正版里补正过"。

---

## 4. 验收

| 项 | 结果 |
| --- | --- |
| `verify-privacy-surface.js` | **70/70**（66 + 新增 4 条：应用页 WebRTC、像素比取系统缩放、时区跟语言、偏移符号） |
| `verify-privacy-check.js` | **29/29** |
| 全量 `node scripts/verify-all.js` | **48 个脚本：47 通过 / 1 失败 / 0 跳过 / 719 秒** |
| 失败项 | 界面体验回归「接入说明一键复制」→ `系统剪贴板当前不可用`；同一时刻 `Get-Clipboard` 也报「所请求的剪贴板操作失败」，属**会话锁屏导致的环境限制**，断言一个字未改 |
| 隐私自检（存证） | `docs/privacy-audit/1.18.2.md`：**泄漏 0 / 可疑 0** / 测不到 4 / 已伪装 3 / 正常 9，用时 1,897 毫秒 |
| 真实自检两份 | 正常模式 3 泄漏（如实报）、隐私模式 0 泄漏 0 可疑；脱敏 Markdown 在 `temp/privacy-audit/`，原始 JSON 只在本地 |
| 包 | `dist/Nyx-Setup-1.18.2.exe`，127,323,616 字节，sha256 `0CEED9BA…806F3A05` |
| 完整性 / 冒烟 | `verify-integrity` **9/9**、`verify-packaged-smoke` **12/12** |
| AUD-03 保留验证 | 发版门禁里跑，见下方发布摘要 |

---

## 5. 坑

1. **修好判定之后，先怀疑画像，别怀疑判定**。A4/A6 报出来时我第一反应是"断言又写错了"，
   实际两处都在画像侧（dpr 写死、时区不对齐）。
2. **`timezoneForLanguage('en-US,en')` 返回空**：`DEFAULT_LANGUAGE` 是整串 Accept-Language，
   不先按逗号取第一个标签，查表必然落空——于是"对齐"静默不生效，自检还是报可疑。
3. **符号口径要拿两个半球各验一次**：只测纽约会把"写反"当成正确（因为断言里也是手写的 300）。
4. **应用页是 WebContents**：`createAppPage()` 与 `create()` 是两条路径，
   凡是"每个标签都必须有"的加固，两条都得写；这条已经踩过一次（1.18.1 的指纹装配）。
5. `git checkout -- docs/privacy-audit/1.18.0.md` 后再跑补正脚本才干净——
   第一次跑已把真实值列改掉，第二次跑就收集不到 secrets 了（补正脚本不幂等于"秘密已被抹掉"）。

---

## 6. 诚实边界

- 自检只证明**它测到的面**：TLS 指纹、HTTP/2 帧序、字体全量枚举都不在范围内；**DNS 出口恒为「测不到」**。
- 没有隐私评分，以后也不会有单一分数。
- 出口未知时"时区跟语言同一地区"是**推测**，不是出口的真实时区——它让画像自洽，但不等于位置正确。
- 停靠标签超过 12 个会按原地址重开；切换动画可关（关掉即瞬切）。
- 1.17.11–1.17.20 从未发布，内容都并在 1.18.0 里；远端仓库仍停在 1.17.9。
- 本版**未打 tag、未 push**——等审计放行。

---

## 7. 升级方式

已装 1.18.0 / 1.18.1 的机器：应用内「检查更新」→ 下载 → 安装，或直接跑
`dist\Nyx-Setup-1.18.2.exe` 覆盖安装（保留用户数据）。更新源
`%APPDATA%\Nyx\updates\latest.json` 已指向本版（`signature` + `keyId dc2cec223e6ea7c7`）。
