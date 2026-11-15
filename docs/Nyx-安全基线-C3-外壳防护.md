# Nyx 外壳防护现值与拦截演示（清单 C3）

> 本文是「现在到底开了哪些防护」的唯一书面记录。数字全部来自本机实测（`npm run verify` 里的
> `外壳防护基线 18 项` + `界面体验回归` 的 C3 两条端到端断言），不是按经验估的。
>
> 复核方式：设置 → 诊断 → 「外壳防护现值」卡片 → 点「试一次注入」。卡片会把现值、本地页面 CSP、
> preload 暴露面和一致/不一致结论摆在一起；按钮会在一个临时窗口里真跑一遍注入尝试。
>
> 复核日期：2026-11-12 ｜ 基线版本：Nyx 1.17.0（Electron 43.7.4 / Chromium 150 / Node 24）

---

## 1. 三个关键开关的现值

每个窗口在**创建那一刻**的 `webPreferences` 都会被登记进 `src/main.js` 的
`runtime.securityWindows`，再与 `src/core/security-switches.js` 的 `WINDOW_ROLES` 表逐项核对。
期望值写死在表里，所以「谁把 sandbox 关了」会在诊断页当场变红。

| 窗口角色 | 用什么 preload | 上下文隔离 | Node 集成 | 沙箱 | 为什么允许这样 |
| --- | --- | --- | --- | --- | --- |
| `shell` 主窗口外壳 | `src/preload.js` | 开 | 关 | **关** | preload 需要用 Node 侧能力（对话框、剪贴板、系统信息），且只加载仓库内 `file://` 页面；导航只放行 `file://` 并禁止开新窗口 |
| `tab` 网页标签（远端内容） | `src/preload-tab.js` | 开 | 关 | **开** | 远端内容必须进沙箱；这个 preload 只按需注入极少的页面内能力 |
| `app-page` 应用页（起始页 / 设置） | `src/preload.js` | 开 | 关 | **关** | 与外壳同构（同一份 preload），页面本身是仓库内静态文件，导航只放行 `file://` |
| `bm-menu` 收藏悬浮菜单 | `renderer/bm-menu-preload.js` | 开 | 关 | 开 | 纯 UI 浮层，不需要 Node 侧能力 |
| `addr-suggest` 地址栏建议浮层 | `renderer/addr-suggest-preload.js` | 开 | 关 | 开 | 同上 |
| `bm-folder` 收藏到文件夹浮层 | `renderer/bm-folder-preload.js` | 开 | 关 | 开 | 同上 |
| `downloads` 下载中心 | `preload-downloads.js` | 开 | 关 | 开 | 只有下载相关动作，走窄接口 |
| `probe` 注入演示临时窗口 | `src/preload.js` | 开 | 关 | **关** | 故意与真实外壳同构，否则"演示通过"说明不了外壳安全 |
| `onboarding` 首次安装引导窗口 | `src/preload.js` | 开 | 关 | **关** | 复用外壳 preload（要 require 项目内模块），代价由三道限制兜住：只从 `file://` 本地加载、CSP `default-src none`、禁止开新窗口与非 `file://` 导航 |

关沙箱的角色白名单在代码里是 `SANDBOX_OFF_ALLOWED = ['shell', 'app-page', 'probe', 'onboarding']`，
静态守卫断言会检查 `src/main.js` 里 `sandbox: false` 恰好 3 处、`src/core/tabs.js` 里恰好 1 处。
新增窗口若也要关沙箱，必须同时改三处：`WINDOW_ROLES` 里声明期望值、这条静态断言的计数、以及上面这张表——
少改一处，诊断页会当场标红（未登记角色）或回归直接失败。

**注意「没写就算默认」这件事**：Electron 对没写的项会套默认值（`sandbox` 默认关、
`contextIsolation` 默认开、`nodeIntegration` 默认关）。诊断页对"没写但恰好正确"的项会标
**「（没显式写，走默认值）」**，不会被当成通过蒙混过去——因为默认值会随 Electron 版本变。

---

## 2. 本地页面 CSP 现值

9 个本地页面（`src/renderer/*.html`）全部带 `Content-Security-Policy` meta，实测 **9/9 合格**。
审计规则会点名四类过宽写法：缺 `default-src`、`'unsafe-eval'`、`script-src 'unsafe-inline'`、
来源被放宽成 `*`。新增页面漏写 CSP 会被 `verify-security-switches.js` 第 18 项抓住。

注入演示用的临时页 `src/renderer/security-probe.html` 用的是最严的一档：
`default-src 'none'; style-src 'unsafe-inline';`——页里没有任何业务代码，脚本由主进程注入。

---

## 3. preload 暴露面现值

实测主窗口 `window.nyx` 暴露 **168 个方法**，按"能干什么"分成 7 组（另有 66 个不便归类的低风险项），
其中 **10 个属高风险**：

- 写文件（3）：`exportDiagnostics`、`captureToolboxScreenshot`、`addressSuggestPinnedExport`
- 开目录 / 开外部位置（5）：`openDiagnosticsFolder`、`openDownloads`、`openDownloadDir`、`updateOpenSource`、`openUpdateFolder`
- 进程控制（2）：`restartApp`、`restartProxy`

中风险 4 组：剪贴板（`errorCopyDetail`、`copyToolboxText`、`updateCopyCleanCommand`）、
外部打开（`openSecurityAdvisory`）、模式与隐私（`switchMode`、`privacyLink`、`privacyLinkSet`、
`clearPermissionCache`、`clearVault` 等）、下载（`listDownloads`、`downloadToolboxResource` 等）。

`contextBridge` 暴露的对象是**冻结**的：演示脚本尝试 `bridge.navigate = () => 'pwned'` 之后，
函数引用没变、调用结果也没变（`bridgeWriteIgnored === true`）。这一点是端到端断言，
不是"理论上应该"。

---

## 4. 拦截演示（实测输出）

在临时窗口里跑 `src/core/security-switches.js` 的 `buildProbeScript()`，五条路径全部被挡住：

```
5 条注入路径全部被挡住；暴露面 168 个方法，改写它无效（冻结）

挡住    require() —— 渲染进程里没有 require
挡住    process —— 渲染进程里没有 process
挡住    module —— 渲染进程里没有 module
挡住    window.require —— window 上没有 require
挡住    new Function('…') —— 动态求值被 CSP 挡住
```

（`new Function` 那条在无 CSP 的页面里本来会成功；这里被 `security-probe.html` 的
`default-src 'none'` 拦住，说明"页面必须写 CSP"不是形式主义。）

---

## 5. 已知边界（不假装安全）

1. **网页标签里的远端脚本**不在这次演示范围内：演示验证的是"外壳 preload 没把 Node 能力漏给页面"，
   不是"网页本身没漏洞"。远端页面靠沙箱 + CSP + 站点隔离兜底。
2. **`sandbox: false` 的四个角色**（`shell` / `app-page` / `probe` / `onboarding`）是刻意选择
   （preload 要 Node 能力）。若将来把 preload 拆成"纯 IPC 转发 + 主进程校验"，这四处可以收紧到
   `sandbox: true`；在那之前，防护依赖"页面只加载本地文件 + 导航白名单"。
3. **168 个暴露方法本身是风险面**：任何一个方法只要接受"任意路径/任意 URL"，就可能被页面诱导
   做不该做的事。当前高风险 10 项里有几项做了路径/白名单校验（例如诊断包导出、更新源目录），
   但**没有**做逐个方法的权限分级（按"谁在调用、调用时的页面来源"再收一层）。那是比清单 C3
   更大的一件工程，本文如实记为未做。
4. **本机 5 个窗口角色在回归时不会全部创建**（收藏菜单、建议浮层、文件夹浮层、下载中心、演示窗口
   只在用到时才建），诊断页会明确写「本次启动还没创建过，没验到（不是通过）」。
5. **没有做的事**：没有做内存/句柄级审计，没有做 fuzzing，没有对 `vendor/mihomo` 内核二进制做
   独立安全审计（它不入库、有 `--verify-integrity` 校验，但那是完整性不是安全性）。
