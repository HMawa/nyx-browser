---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_3de8156cb4e611f1a816525400cd780f
    ReservedCode1: aZroQsMExqadaj+SU4knniP/kVv1EU6MsBARoAInVjJ7Ve6iCYZ25eKye7FinAHXFt9DqPlYAJ3GHa1fgO5SXE6XJk7GZ26pZkssdlxcUz650C9aeYMes2PZkw/eg9AEzaAxcXRd0xOWgBvqnoaGO+BeCofEHVYd0vOm6tEuMa5wSAx1gyQGnUtcorM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_3de8156cb4e611f1a816525400cd780f
    ReservedCode2: aZroQsMExqadaj+SU4knniP/kVv1EU6MsBARoAInVjJ7Ve6iCYZ25eKye7FinAHXFt9DqPlYAJ3GHa1fgO5SXE6XJk7GZ26pZkssdlxcUz650C9aeYMes2PZkw/eg9AEzaAxcXRd0xOWgBvqnoaGO+BeCofEHVYd0vOm6tEuMa5wSAx1gyQGnUtcorM=
---



# Nyx 路线①+③ 并行落地实施方案

> 验证环境：Microsoft Edge 149.0.4022.62（Chromium 149）/ Windows 11 Build 26200
> 对照组：Nyx 现役内核 Electron 31.7.7（Chromium 126）
> 结论：**① 与 ③ 不需要取舍，二者在 CDP 架构下统一为同一套内核层的两组能力。**

---

## 一、核心结论

前一轮判定的三条路（①主进程平替 / ②扩展入口面板 / ③换内核）里，**③ 的真实成本被大幅高估**。

原估算"换 CEF 或自编译 Chromium，包体 +100MB、构建链全换"的前提是**自带内核**。
但实测证明：**复用系统已有的 Chromium 系内核（Windows 必装 Edge）+ CDP 编排**，即可拿到完整的 MV3 扩展支持，同时 ① 的原生能力不但保留，还能在同一层实现。

| 维度 | 自带内核（CEF / 自编译） | 复用系统内核 + CDP（本方案） |
|---|---|---|
| 扩展 API 完整度 | 完整 | **完整**（实测 MV3 SW / CS 全通） |
| 包体增量 | +100MB 起 | **0**（Windows 自带 Edge） |
| 构建链 | 全换（CMake/Ninja/LLVM） | **不动**（Electron 项目原样） |
| ① 原生能力 | 需自行实现 | **CDP 现成域** |
| 内核版本 | 冻结在编译时 | 跟随系统更新 |

---

## 二、实测证据

### 2.1 ③ 扩展能力：Electron 内核 vs 真 Edge 内核

| 能力 | Electron 31.7.7 (Cr126) | 真 Edge 149 (Cr149) | 验证方式 |
|---|---|---|---|
| MV2 background page | 可用 | 可用 | target 枚举 |
| **MV3 Service Worker** | **注册失败（status 15/2）** | **正常启动** | target 出现 `service_worker chrome-extension://…/sw.js` |
| content script 注入 | 可用 | 可用 | 页面 DOM 标记回读 = `INJECTED` |
| 后台 chrome.* API 面 | 仅 9 个 | **完整** | action/contextMenus/cookies/declarativeNetRequest 等全部可用 |
| 扩展工具栏图标 / 右键菜单 | 无 | **有** | 真内核原生 |
| 运行时动态装扩展 | 不支持 | **支持** | `Extensions.loadUnpacked` 返回 id |
| 卸载扩展 | 不支持 | **支持** | `Extensions.uninstall` 成功 |
| profile 持久化 | 不写入 | **写入 Secure Preferences** | 21 条扩展登记，我方扩展 `location=8` |

**关键实测结果（r3a / r3c）**

```
Service Worker  → service_worker chrome-extension://jmiphhofofgheajepgjfoadiihddpegm/sw.js   ✅
content script  → data-r3-ext = "INJECTED"                                                  ✅
动态装载        → Extensions.loadUnpacked → id = okcjnbgebnlmbhdoiefmehjiobeolibk             ✅
卸载            → Extensions.uninstall → {}（成功后 getExtensions 归零）                     ✅
扩展界面        → chrome-extension://<id>/popup.html 打开并渲染 = "r3d-popup-ok"             ✅
```

### 2.2 ① 原生能力：全部不依赖扩展，CDP 直控

| 能力 | CDP 域 | 实测结果 |
|---|---|---|
| 请求拦截（广告拦截基础） | `Fetch` | blocked.js 被阻断、ok.js 正常放行 ✅ |
| Cookie 读写编辑 | `Network` | `setCookie → success`，页面 `document.cookie` 读到 ✅ |
| 页面脚本注入 | `Page.addScriptToEvaluateOnNewDocument` | 注入标记回读 = `route1` ✅ |
| 多标签 / 截屏 | `Target` / `Page.captureScreenshot` | 可用 ✅ |
| 隐私实例零扩展隔离 | — | 独立 profile 实例 `getExtensions → []` ✅ |

> ① 的拦截能力**强于扩展方案**：Fetch 域在协议层拦截，页面与扩展都无法绕过，且不占扩展额度。

---

## 三、目标架构

```
┌──────────────────────────────────────────────────────┐
│  Nyx Shell  (Electron 31 —— 外壳与业务逻辑全部保留)   │
│                                                       │
│   ├─ 设置中心 / 代理中心 / 双模式切换        (现有 UI) │
│   ├─ 扩展面板（侧栏）                                 │
│   │    列出扩展 → 点击 → 打开 popup / options         │
│   ├─ KernelBridge（主进程）                           │
│   │    · 内核探测与进程守护                           │
│   │    · CDP 会话（端口模式）                         │
│   │    · 能力路由：扩展 / 拦截 / Cookie / 注入        │
│   └─ 产出物 / 下载 / 历史等业务模块          (现有)   │
└────────────────────┬─────────────────────────────────┘
                     │  CDP over 127.0.0.1:<port>
        ┌────────────┴─────────────┐
        ▼                          ▼
┌───────────────────┐   ┌───────────────────────┐
│ 普通实例 profile   │   │ 隐私实例 profile       │
│  · 装扩展          │   │  · 零扩展（永不装载）   │
│  · ① 原生拦截      │   │  · ① 原生拦截          │
│  · mihomo 代理     │   │  · mihomo 代理         │
└───────────────────┘   └───────────────────────┘
     msedge.exe (Chromium 149) —— 真内核，复用系统
```

**三条路的重新归位**

| 原路线 | 在新架构中的落点 |
|---|---|
| ① 主进程原生平替 | CDP `Fetch` / `Network` / `Page` 域，由 KernelBridge 统一调度 |
| ② 扩展入口面板 | Nyx 侧栏列扩展 + 打开 `chrome-extension://<id>/popup.html` |
| ③ 换内核 | 改为**复用系统内核 + CDP 编排**（不编译、不打包内核） |

---

## 四、强制启动参数模板

以下参数经实测确定，**缺一即失效**：

```
msedge.exe
  --user-data-dir=<每实例独占目录>          # 隔离态的根本；双模式靠它
  --remote-debugging-port=<9301|9302>       # 端口模式即可，无需 pipe
  --enable-unsafe-extension-debugging       # 必需：让命令行扩展成为"真安装"
  --disable-features=DisableLoadExtensionCommandLineSwitch   # 必需：复活被 Cr137 移除的开关
  --load-extension=<扩展目录,逗号分隔>       # 隐私实例不传此参数 → 天然零扩展
  --proxy-server=http://127.0.0.1:<mihomo端口>
  --no-first-run --no-default-browser-check --disable-sync
```

---

## 五、分阶段落地

### 阶段 1 —— 内核桥接层（1–2 天）

- 新增 `KernelBridge` 模块（参考实现见同目录 `nyx-kernel-bridge.mjs`）
- 内核探测：优先系统 Edge；缺失时下载 Chrome for Testing 到 `userData/kernel/`（官方分发，仍无需编译）
- 双实例编排：`profile-normal`（9301）+ `profile-private`（9302）
- 打通 CDP 会话与 `Fetch` / `Network` / `Page` / `Extensions` 四域

**验收**：`listExtensions` / `loadExtension` / `installInterception` / `setCookie` / `injectScript` 五个 API 全部返回预期结果。

### 阶段 2 —— UI 承载（3–5 天）

- 决定窗口承载方式（见第六节风险 R2）
- 侧栏扩展面板：`listExtensions` → 列表 → 点击开 `popup.html`
- 设置中心新增"扩展管理"页：添加（选目录）/ 移除 / 启用状态
- 代理中心对接 `--proxy-server`，双模式切换 = 切换实例

**验收**：装上 22 个 Edge 扩展全部可用（含工具栏图标、右键菜单、popup）。

### 阶段 3 —— 原生能力补齐（2–3 天）

- 广告拦截规则引擎：规则集 → `Fetch.enable` patterns，热更新
- 脚本注入管理（替代内容脚本类扩展的核心场景）
- Cookie 编辑器 UI

**验收**：不装任何扩展的前提下，广告拦截与脚本注入均生效。

### 阶段 4 —— 迁移与收尾（1–2 天）

- 旧版 Electron session 逻辑下线
- 1.0.8 → 1.1.0 升级通道
- 扩展数据迁移（旧 profile 内的扩展目录复用）

---

## 六、风险与对策

| 编号 | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 目标机无 Edge 且无 Chrome | 无内核可用 | 下载 Chrome for Testing 兜底（分发包，非编译）；Windows 环境实际必装 Edge |
| R2 | 窗口承载方式：CDP 托管的 Edge 是**独立窗口**，与 Electron 壳视觉割裂 | 体验 | 先做「独立窗口 + 壳做控制面板」；如需真嵌入，用 Win32 `SetParent` 将内核窗口重定父到 Electron 窗口（需处理焦点 / DPI / 生命周期，作为独立子项评估） |
| R3 | `--enable-unsafe-extension-debugging` 属调试向开关 | 长期可用性 | 已实测 Edge 149 稳定可用；在上层做能力探测，失效时降级到 `--load-extension` + 提示用户手动 `chrome://extensions` 装载 |
| R4 | 内核随系统自动更新，行为可能漂移 | 兼容性 | 启动时读 `Browser` 版本号，维护最低版本断言；CDP 域做能力探测而非硬编码 |
| R5 | 用户日常 Edge 与本方案实例并存 | 端口 / profile 冲突 | 每实例独占 `--user-data-dir` 与端口，二者互不干扰（已实测） |
| R6 | 隐私实例的隔离强度 | 隐私 | 独立 profile 目录 + 不传 `--load-extension`，实测 `getExtensions → []` |

---

## 七、踩坑清单（实测）

1. **Chrome 126+ 只加 `--load-extension` 会得到"哑巴扩展"**
   扩展看似装载（`chrome-extension://ID/options.html` 可访问），但**不写入 Secure Preferences、Service Worker 不注册、content script 不注入** —— 内核把它当作 ephemeral 资源。**必须叠加 `--enable-unsafe-extension-debugging`**，才会被当真安装处理。

2. **Chrome 137+ 直接移除了 `--load-extension` 开关本身**
   需 `--disable-features=DisableLoadExtensionCommandLineSwitch` 复活。Edge 149 实测有效。

3. **`Target.getTargets` 返回的 targetInfos 不含 `webSocketDebuggerUrl`**
   要拿某个页面的 CDP 地址，必须走 HTTP `GET /json/list`（其条目含 `webSocketDebuggerUrl` 与 `id`）。这是最容易卡住的一步。

4. **`Extensions.*` 并非只支持 pipe 模式**
   web-ext 官方文档称需 `--remote-debugging-pipe`，但实测 Edge 149 在 **`--remote-debugging-port` 端口模式下** `getExtensions` / `loadUnpacked` / `uninstall` 全部可用。端口模式对 Electron 集成友好得多（pipe 需接管 fd 3/4）。

5. **`Extensions.triggerAction` 要求 `type="tab"` 的 target**
   而 `Target.getTargets` 默认不暴露 `tab` 类型（实测 `type=tab` 数量为 0），传 page target 报 `Action can only be triggered on a tab target`。
   **规避**：不要走 triggerAction，直接把 `chrome-extension://<id>/popup.html`（或 `options.html`）作为普通页面打开 —— 实测渲染正常。这也是各类浏览器壳的通用做法。

6. **扩展目录层级**
   `--load-extension` / `loadUnpacked` 必须指向**含 `manifest.json` 的那一层**（即 `…\<扩展ID>\<版本>_0\`），指向上层会报无 manifest.json。

---

## 八、附：参考实现

同目录 `nyx-kernel-bridge.mjs` 为可直接接入的内核桥接层参考实现，导出：

| 导出 | 作用 |
|---|---|
| `findKernel()` | 探测系统可用内核 |
| `launchKernel(opts)` | 启动内核实例（含全部必需参数） |
| `waitKernel(port)` | 等待 CDP 就绪 |
| `createKernelSession(...)` | 建立会话，暴露 ①③ 全部能力 |
| `bootNyxKernels(...)` | 一次性拉起普通 + 隐私双实例 |
| `matchPattern(p, url)` | 通配符匹配工具 |

会话对象能力：`listExtensions` / `loadExtension` / `unloadExtension` / `openExtensionPanel` /
`installInterception` / `setCookie` / `injectScript` / `newTab` / `closeTab` / `screenshot` / `shutdown`。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
