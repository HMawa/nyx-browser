# Nyx 1.17.10 发版记录

> 这一版不是加功能，是**按安全审计报告把该关的门关上**。
> 上一版 1.17.9 的审计结论是「不通过，不可发布」（3 个 P0 + 7 个 P1 + 7 个 P2）；
> 本版逐项修完并有断言看着，才谈得上「能发」。

- 发布时间：2026-11-15
- 安装包：`dist\Nyx-Setup-1.17.10.exe`
- 字节数：127,266,144
- SHA-256：`94192cf1f091248e5b7abe31e605cfa5d8aca5d8b29652b9f0ced400cea2a0`
- 签名：自签名（`CN=Nyx Self-Signed`，指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`，`Status=Valid`）
- 回归：36 个脚本 / 863 项 / 全绿（含包内冒烟 12 项）
- 更新清单签名：Ed25519（`keyId dc2cec223e6ea7c7`），安装前再核一次安装包签名

---

## 一、这一版修了什么

| 编号 | 问题（审计原文口径） | 本版的改法 |
| --- | --- | --- |
| P0-1 | 外壳没有导航守卫：被导航到任意网址后，那个页面拿到整份 `window.nyx`（226 个方法） | `src/core/shell-guard.js` 只放行同一份 `renderer/index.html`；网络地址、伪协议、UNC、同目录别的 html 全拦；三条事件（navigate / redirect / attach-webview）一起挂；自身地址读不到时**失败关闭** |
| P0-2 | 更新通道可替换：清单缺 sha256 时直接放行、安装前不验签、更新源可指任意 http/本地目录 | 三道门：源只许 https（本地源要显式确认）、版本必须更新、**缺 sha256 一律拒绝**；清单加 Ed25519 签名（公钥硬编码、私钥不进仓库）；安装前用 `Get-AuthenticodeSignature` 再核一次安装包 |
| P0-3 | 隐私模式的 11 个 JS 加固都在隔离世界，页面主世界读不到；请求头已改成 Chrome/156 而 JS 仍报 Electron，**头与 JS 矛盾比不伪装更可识别** | `src/core/privacy-surface.js` 生成主世界注入脚本，经 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前生效；UA 用 `setUserAgent` + CDP 覆盖，语言/时区/平台一起对齐；Canvas / WebGL / Audio 加稳定噪声；失败**明确报错**并标 `privacyIncomplete` |
| P1-1 | `readPage` 明文回显密码框的值 | 密码框 `value` 恒为空，改给 `hasValue` / `masked`；点击回执里也只留 `aria-label` |
| P1-2 | `executeJS` 无需确认，且能对任意 `wcId` 执行 | 进 `CONFIRM_RULES`（必须人工确认）；控制台脚本只许当前活动标签；留痕只记长度 + sha256 |
| P1-3 | 站点授权按「当前页」判，屏蔽名单对 `navigate` 形同不存在 | 改成按「要去的地方」判（`wc.getURL()` → 目标地址站点）；目标地址解析不出直接拒绝 |
| P1-4 | 空白页上 agent 死锁，`navigate` 无超时 | navigate 按目标站点判定（空白页也能走一次）；加 15 秒超时并如实说「地址已交给浏览器」 |
| P1-5 | 所有 IPC 不校验 `senderFrame` | `src/core/ipc-guard.js` + 包装 `ipcMain.handle/on/once`：只收本仓库 `renderer/*.html` 的最外层帧；网页 preload 的 5 个通道单独放行但同样只收最外层 |
| P1-6 | Electron fuses 未固化，`ELECTRON_RUN_AS_NODE=1 Nyx.exe -e` 能跑 | afterPack 里（签名之前）翻四个 fuse：RunAsNode、NODE_OPTIONS、`--inspect` 全关，只从 app.asar 加载；包内冒烟**真去试**一次，跑通了就判失败 |
| P2 批次 | `/health` 免鉴权还硬编码版本号、Token 可走 `?token=`；普通模式放行跨站存储与窗口管理；普通模式 UA 自报 Electron；隐私模式下 agent 仍可 readPage/screenshot；`executeJS` 留痕抄正文；诊断包可写任意路径 | 见下节 |

## 二、P2 逐条

- **本地接口**：`/health` 不带 Token 只回「活着」，带对 Token 才给真实版本号（`app.getVersion()`）；Token 只认请求头 `x-nyx-token`，URL 里带的一律不认。
- **权限基线**：`storage-access`、`window-management` 从「直接放行」改成「逐次询问」；其余能力一个不动。
- **普通模式 UA**：只报真实内核（`Chrome/156…`），不再自报 `Nyx/` 与 `Electron/`。
- **隐私模式下 agent**：`screenshot` / `readPage` 直接拒绝，说明「退出隐私模式再做」。
- **留痕**：`executeJS` 只记长度与 sha256，不记正文。
- **诊断包**：只许导出到「下载」或「临时」目录，且必须是 `.zip`。

## 三、验收

| 项目 | 结果 |
| --- | --- |
| `npm run verify`（36 脚本） | 863 项全绿 |
| `npm run verify:integrity` | 9/9（清单版本 1.17.10） |
| `node scripts/verify-signing.js` | 38/38（签名有效，证书剩 1826 天） |
| `node scripts/verify-packaged-smoke.js` | 12/12（含 fuses 实测、API、界面） |
| 安装器 e2e（发版时自动） | 见发布摘要 |
| 差分实测（发版时自动） | 见发布摘要 |

新增/更新的回归脚本：

- `verify-shell-guard.js`（11）
- `verify-update-policy.js`（10）
- `verify-update-signature.js`（17）
- `verify-privacy-surface.js`（28，把生成的脚本放进 vm 真跑一遍）
- `verify-ipc-guard.js`（9）
- `verify-http-api-auth.js`（7，真起回环服务器发真请求）
- `verify-audit-p2.js`（14）
- `verify-packaged-smoke.js`（11 → 12）

## 四、踩过的坑

1. **`build-signed.js` 读的是工作区 `package.json`**：上一次发 1.17.9 时，index 里已经是新版本、工作区还是旧的，结果把旧版重打了一遍。这次先改工作区再打包，并且打完复核 `FileVersion`。
2. **fuses 只能写一次且必须在签名之前**：签名之后再翻，签名立刻失效。所以放在 afterPack、清单生成之前。
3. **`EnableEmbeddedAsarIntegrityValidation` 没开**：它要求 asar 里带构建期写入的完整性标记，electron-builder 这条链路不写；硬开会让装了起不来。台账里记为「未做，原因是会砸掉启动」。
4. **`redactParams` 的签名是 `(type, params)`**，不是 `(action)`：审计断言先写错，拿到 `{}` 才发现。
5. **UI 套件会被并行跑的全量拖成 CDP 超时**：这不是功能坏，是资源不够；已把三个 Electron 脚本的 CDP 等待上限加到 60 秒，全量里失败会「干净环境重试一次」。

## 五、已知边界（本版仍然不成立的说法）

- **自签名不等于公信签名**：SmartScreen 仍会提示「未知发布者」；证书没有时间戳服务。
- **外部接入模式的审计仍不完整**：CDP 内部的调用不经过统一通道，界面会常驻「审计不完整」。
- **隐私模式不是「隐身」**：它做的是「本机不留痕 + 指纹一致 + 强制代理」，不是抗全网追踪；P0-3 修完只是把「头与 JS 矛盾」这个更糟的问题解决掉。
- **计划任务在安装版里仍不可用**：只有源码目录能注册（安装版没有 `scripts/`）。
- **代理内核与 GeoIP 不做按需下载**：体积换的是开箱可用（见 `docs/体积与裁剪评估.md`）。

## 六、升级与回退

- 升级：应用内「检查更新」（更新源已指向 1.17.10，清单带签名），或直接运行安装包覆盖安装。
- 回退：从 `%APPDATA%\Nyx\updates-archive\1.17.9\` 取上一版安装包安装；本版没有改用户数据格式，回退不会丢配置（引导标记 `onboarding.json` 保留）。
