---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_4d3befedb55011f183e7525400de85a5
    ReservedCode1: l8tU0EqZ0Hehekb27owmYlCtz5+S3GXmOzkK1QZ3Hzh5T53v7OxiLoI3ugtMflUwxZCmnWDHSXteMod0nMb5rqQG2ETPc2xfOy8OcQriArWF4kK3P7MHNHbOCAkXuMNSh+h78ojJgpuMXp1VYSLZzjObqSsJVAVyOc0RKGDK4diY27TQA1NHkwi01pM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_4d3befedb55011f183e7525400de85a5
    ReservedCode2: l8tU0EqZ0Hehekb27owmYlCtz5+S3GXmOzkK1QZ3Hzh5T53v7OxiLoI3ugtMflUwxZCmnWDHSXteMod0nMb5rqQG2ETPc2xfOy8OcQriArWF4kK3P7MHNHbOCAkXuMNSh+h78ojJgpuMXp1VYSLZzjObqSsJVAVyOc0RKGDK4diY27TQA1NHkwi01pM=
---

# Nyx 阶段 1 落地报告：内核桥接层

- 日期：2026-09-21
- 范围：`docs\Nyx-路线1和3并行落地方案.md` 四阶段中的**阶段 1（内核桥接层）**
- 目标版本：1.0.8 → 1.1.0
- 结论：**阶段 1 完成，验收 7/7 全通过**

---

## 一、阶段目标与验收口径

原方案对阶段 1 的验收要求：

> `listExtensions` / `loadExtension` / `installInterception` / `setCookie` / `injectScript` 五个 API 全部返回预期结果。

补充约束：**全程走 CDP 网络层，不依赖桌面可见性**（即锁屏下也必须可验收）。

本轮实际执行时本机处于锁屏态，验收全程通过 —— 该约束达成。

---

## 二、交付物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 正式模块 | `src\core\kernel-bridge.js` | CJS，供 Electron 主进程 `require`，**零第三方依赖** |
| 验收脚本 | `scripts\verify-kernel-bridge.mjs` | 自建本地站点 + 自建测试扩展，全自动回归 |
| 验收结果 | `scripts\verify-kernel-bridge.result.json` | 机器可读，含每项断言明细 |
| 方案期原型 | `prototype\nyx-kernel-bridge.mjs` | 保留作存档；实现已被 `src\core\` 版取代 |

模块导出：`findKernel` / `launchKernel` / `waitKernel` / `listPages` / `attachPage` / `createKernelSession` / `matchPattern` / `bootNyxKernels` / `wsConnect`。

会话能力：`listExtensions` / `loadExtension` / `unloadExtension` / `openExtensionPanel`（③ 扩展）与 `installInterception` / `setCookie` / `injectScript`（① 原生），外加 `newTab` / `closeTab` / `screenshot` / `shutdown` / `pageSession`。

---

## 三、验收结果（7/7 PASS）

内核：本机 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` = **Edg/149.0.4022.62**

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| T1 | `listExtensions` | PASS | `count=1, names=[Nyx Kernel Probe A]` |
| T2 | `loadExtension`（运行时装载） | PASS | `id=dmlfnhbklpkncgcdmchpncalfpolefjo, totalExtensions=2` |
| T3a | `setCookie` | PASS | API `{"success":true}`，页面 `document.cookie="nyx_kb=route1-ok"` |
| T3b | `injectScript` | PASS | `marker=route1` |
| T4 | `installInterception` | PASS | 页面侧 `ok.js=1, blocked.js=0`；CDP 侧 `{blocked:1, passed:0}` |
| T5 | `screenshot` | PASS | 9996 B，PNG 魔数正确 |
| T6 | WebSocket 64 位长度通路 | PASS | 内核回传 200000 字节字符串完整无损 |

**T4 的判据是双向的**：既要求目标资源被真实阻断（`blocked.js` 未执行），又要求同页其它资源未被误伤（`ok.js` 正常执行）—— 单向判据无法区分「精准拦截」与「整页炸掉」。

---

## 四、关键实现决策

### 4.1 不引入 `ws` 依赖，内置极简 RFC6455 客户端

实测事实：

```
Electron 31.7.7 / Node 20.18.0 / Chromium 126
typeof WebSocket === 'undefined'      ← 主进程没有全局 WebSocket
node_modules 下无 ws 包
```

Node 的全局 WebSocket 自 22.4 起才默认启用，Electron 31 落在其之前。要在主进程跑 CDP，必须自带 WS。

取舍：`npm i ws` 会改动 `package.json` 依赖树与打包产物；而 CDP 对 WS 的需求面其实很窄。故按实际需要实现一个贴合场景的子集：

- 客户端握手（`Sec-WebSocket-Accept` 校验）
- 文本帧 / 二进制帧 / **64 位长度编码** / **分片重组**（continuation）
- ping → pong 自动应答；客户端出帧强制掩码（RFC6455 §5.3）

**风险已用测试覆盖而非口头声明**：T5 覆盖 16 位长度分支，T6 专门制造 >64KB 响应覆盖 64 位分支。T6 的设置原因是 T5 只到 9996 B，仅靠 T5 无法证明长帧分支正确。

### 4.2 启动参数三项组合，缺一不可

```
--enable-unsafe-extension-debugging
--disable-features=DisableLoadExtensionCommandLineSwitch
--load-extension=<dirs>
```

三项共同构成"扩展真安装"的充分条件，已在代码注释中固化说明，**勿删减**。隐私实例传空数组 → 不加 `--load-extension` → 天然零扩展，隔离不靠开关而靠参数缺失。

---

## 五、实测踩坑（本轮新增，均为硬结论）

### 坑 1：`injectScript` 静默失效 —— 注入时机 `document.documentElement === null`

**现象**：`injectScript` 调用成功、无异常、无报错，但页面上探针读不到。

**误判过程**：第一轮归因为"注册态绑 session，跨连接导航不生效"，据此加了 session 池并重跑 —— **仍然 FAIL**。session 池判断方向正确但并非本症根因。

**真实根因**：注入点在**文档创建早期**执行，此时 `document.documentElement` 尚未建立。

**实锤证据**（探针改为回传运行时状态后）：

```json
{"deNull": true, "readyState": "loading"}
```

脚本在 `document.documentElement === null` 上直接调 `setAttribute` 抛 TypeError，异常被 CDP 静默吞掉，故表现为"成功但无效"。

**规避**：注入脚本只写 window 级状态，或自行监听 `DOMContentLoaded`，严禁直接操作 DOM。

**对照旁证**：同一页面上的扩展 content script 成功注入（`data-nyx-ext=B`），因其运行时机为 `document_idle` —— 时机差异而非能力差异。

### 坑 2：注册态是 session 级的，同一 target 必须复用同一条 CDP 连接

`Page.addScriptToEvaluateOnNewDocument` / `Fetch.enable` 这类注册绑在发起连接上；若每次能力调用都新开连接、注册完连接即悬空，后续由别的连接触发的导航既不执行脚本也不走拦截。

而 `Network.setCookie` 是 target 级状态，跨连接共享 —— 这解释了"为什么 setCookie 一直是好的、只有 injectScript 挂"。

**规避**：模块内设 session 池（`pageSession(targetId)`），页面级能力统一取用；`closeTab` / `shutdown` 负责回收连接。

### 坑 3：`Target.getTargets` 不返回 `webSocketDebuggerUrl`

要拿页面级 CDP 地址，必须走 HTTP `/json/list`。已在 `listPages` 注释中固化。

---

## 六、未验证项 / 风险（不宣称已解决）

1. **R2 嵌入路线的输入投递**：本轮全程锁屏，真实 `SendInput` 级注入仍无法验证（锁屏态下 ForegroundWindow 为空、输入被 LogonUI 拦截，属环境限制而非方案缺陷）。**需解锁后重测**，脚手架 `prototype\r3a.ps1` 已备好。
2. 跨 DPI 拖动、内核自身弹出的独立顶层窗口（设置页 / 权限气泡）、内核崩溃对宿主消息循环的影响 —— 均为 R2 遗留项，见 `docs\Nyx-R2窗口承载方案对比.md`。
3. 内核进程组清理：`shutdown()` 目前只 kill 主进程，Edge 派生的子进程依赖其自行退出；回归脚本外挂了按 profile 路径匹配的兜底清理。
4. 单实例验证：本轮只跑通单个内核实例，`bootNyxKernels` 的双实例并行（9301 / 9302）尚未端到端验证。

---

## 七、下一步（阶段 2：UI 承载）

阶段 1 交付的模块已可被主进程直接 `require`，阶段 2 起需解决：

1. `src\main.js` 接入内核桥接层（生命周期与现有 Session 分区对齐）
2. 选定承载方案：主走 B（SetParent 嵌入）+ A（独立窗口）作运行时回退（依据 `docs\Nyx-R2窗口承载方案对比.md` 结论）
3. 补测 R2 输入投递（**需解锁环境**）
4. 双实例端到端（normal 可装扩展 / private 零扩展）

---

*（内容由 AI 生成，仅供参考）*
*（内容由AI生成，仅供参考）*
