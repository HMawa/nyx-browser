# Nyx 1.18.1 发版记录

> 生成：2026-11-18。这是**审计打回后的修正版**：1.18.0 被判「不通过，不能 tag/push」。

---

## 1. 审计打回的四件事

| 编号 | 审计原话 | 本版处置 |
| --- | --- | --- |
| F1 | 干净克隆跑全量必红：`verify-all.js` 第 48 步引用未提交的 `verify-net-terms.js` | 由 `b22cb1a` 解除（摘掉 net-terms 与那一步），本版不再引用 |
| AUD-03（P0 判据） | 规格要求 `Buffer.includes('nyx-keep-package') === true`，实测 false | **换成功能判据**并接进发版门禁（见 §3①） |
| P1-1…P1-5 | 自检判定写错（A2 恒 pass、A3 正常模式误判、A4 只拦中文+美国、A6 分支写反）、报告公开真实指纹 | 逐项修 + 报告默认脱敏（见 §3②） |

---

## 2. 提交范围

| 提交 | 内容 |
| --- | --- |
| `e5e1f47` | `fix(privacy)`: 自检判定五处（A2 空版本→测不到、A3 按模式判、A4 双向对照、A6 分支修正、`canonicalLanguage` 归一） |
| `e5e1f48` | `feat(privacy)`: 报告默认脱敏 + `--raw` 出原始版 + `--check` 变严 |
| `e5e1f49` | `feat(release)`: AUD-03 功能判据（`verify-installer-retention.js`）+ 接进 `make-release` 门禁 |
| `e5e1f4a` | 项数与头部描述同步（`verify-all.js`） |

---

## 3. 关键改动

### ① AUD-03：用「装完包还在」取代字节串判据

`build/installer.nsh` 里那段改名逻辑（`Rename … .nyx-keep-package.exe`）确实被编译进去了，
但字符串在 NSIS 的 LZMA 实心里**查不到**——字节判据永远返回 false，那是判据错，不是功能错。

新增 `scripts/verify-installer-retention.js`（11 项）：装旧版 → 把新版包放进更新源模拟下载 →
从更新源覆盖安装 → 断言 ① 新版包仍在且 `sha256`/`size` 与 `latest.json` 一致 ② 旧包已清 ③ 版本是新版。
`make-release.js` 的 `installerE2eGate()` 在 e2e 通过后立刻调 `installerRetentionGate()`，失败即中止发版。

### ② 五处判定 + 脱敏

- **A2**：`!chVersion || !uaFull` → `unknown`（浏览器只在 `getHighEntropyValues()` 里给完整版本号；
  观察脚本改成异步 IIFE 调高熵查询，脚本内不许出现反引号）。
- **A3**：先 `canonicalLanguage()` 归一（`zh-Hans-CN`→`zh-cn`）再比：
  相同 → `leak`；私有模式下不同 → `masked`；**正常模式下不同 → `leak`**（之前恒判 masked，把真实泄漏报成已伪装）。
- **A4**：语言地区 ↔ 时区地区双向查表，对不上 → `suspect`；偏移差 > 60 分钟 → `suspect`；时区认不出 → `unknown`。
- **A6**：缺 `dpr` / `scaleFactor` → `unknown`；尺寸完全相同 → `suspect`；**`dpr` 与系统缩放不一致 → `suspect`**（之前写反成 pass）。
- **脱敏**：`buildReport()` / `buildReportJson()` 默认 `redact: true`——真实值列 `—（已隐藏）`、
  身份面与泄漏/可疑项的观察值隐藏、说明里的真值用 `scrub()` 替换；复制报告永远脱敏；
  `privacy-audit.js` 只把脱敏版写进 `docs/privacy-audit/`，原始 JSON 落 `temp/privacy-audit/`（不入库）。

---

## 4. 验收

| 项 | 结果 |
| --- | --- |
| `verify-privacy-check.js` | **29/29**（18 → 29） |
| `verify-release-gate.js` | **49/49**（45 → 49，含"禁止再用字节串判据"） |
| `verify-privacy-surface.js` | 66/66 |
| 全量 `verify-all.js` | **48 个脚本 / 48 通过 / 1109 项 / 659 秒** |
| 安装器 e2e | 通过（升级基线 1.18.0） |
| AUD-03 保留验证 | **11/11**（先装 1.18.0 → 放包 → 从更新源装 1.18.1 → 版本对、sha/size 对、旧包已清） |
| 包 | `dist/Nyx-Setup-1.18.1.exe`，127,322,096 字节，sha256 `F419A3DA…5F5D` |
| 完整性 / 冒烟 | 9/9、12/12 |

---

## 5. 坑

1. **字节判据 ≠ 功能判据**：NSIS 脚本被压缩进实心块，`.includes()` 查不到；能证明功能的只有"装一遍再看"。
2. **`--check` 必须能抓住"脱敏没生效"**：除了要求出现「已隐藏」，还要求报告里**不得**出现 `Electron/\d`。
3. **发布脚本的 `ROOT` 别往上跳两级**：`path.resolve(__dirname,'..','..')` 解析到 `D:\`，报 `Cannot find module 'D:\scripts\make-release.js'`。

---

## 6. 诚实边界

- 1.18.1 发出去之后，自检在隐私模式下**报出两项「可疑」**（A4、A6）——
  那不是判定误报，是判定修对了才看见的真实不一致，由 **1.18.2** 补上（见 `docs/Nyx-1.18.2-发版记录.md`）。
- 自检只证明它测到的面；DNS 出口恒「测不到」；没有评分。
- 本版**未打 tag、未 push**。
