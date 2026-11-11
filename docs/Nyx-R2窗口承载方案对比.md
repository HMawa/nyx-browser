---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_3eac1eafb4e611f1a816525400cd780f
    ReservedCode1: fBKBIo4dJ7hSY2dyuYG1N5jbILDkit74AwKZcoVpQq0HBrMX2sGZ2+NGMOK33M1LD7fQwbfP15MI3sOW4YRw1SZd+qTdWJpYlJ+xhXSN5OXX09T8tlO0s6SuiyOm7VW7bLUg6UgGHsy5CMqB5hvRdaSuRdygkmYLnDHNanCxn6lVGqfG00rllAuVdIg=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_3eac1eafb4e611f1a816525400cd780f
    ReservedCode2: fBKBIo4dJ7hSY2dyuYG1N5jbILDkit74AwKZcoVpQq0HBrMX2sGZ2+NGMOK33M1LD7fQwbfP15MI3sOW4YRw1SZd+qTdWJpYlJ+xhXSN5OXX09T8tlO0s6SuiyOm7VW7bLUg6UgGHsy5CMqB5hvRdaSuRdygkmYLnDHNanCxn6lVGqfG00rllAuVdIg=
---



# Nyx R2 窗口承载方案对比

> 对比基准：自建壳（WinForms / Electron 均可）+ 真内核 Edge 149（--app 模式）
> 取证方式：本机 Win32 实测，非推演。原始脚本与日志见 temp 目录 r2c.ps1 / r2d.ps1 / r2c.log / r2d.log
> 结论一句话：**Win32 SetParent 真嵌入可行，但有一个硬前提——必须先改窗口样式，裸调用必失败。**

---

## 一、实测结果（硬数据）

### 实验 1：裸 SetParent（不改样式）

| 组别 | 对象 | SetParent 返回 | GetParent@400ms | 判定 |
|---|---|---|---|---|
| 对照组 | 另一进程的普通 WinForms 窗口 | 65548（非零） | 0 | 失败 |
| 实验组 | Edge 149 内核窗口（style=0x16CF0000） | 65548（非零） | 0 | 失败 |

关键发现：**SetParent 返回非零、LastError=0，但父子关系根本没建立。**
对照组（普通窗口）同样失败 → 这不是 Chromium 的特殊限制，而是现代 Windows 对无 `WS_CHILD` 样式窗口的通用行为。
即：**"返回成功"完全不可信，唯一校验手段是回读 `GetParent`。**

### 实验 2：强制 `WS_CHILD` 后再 SetParent

```
style before = 0x16CF0000        (WS_POPUP，顶层窗口)
style after  = 0x56CF0000        (清 WS_POPUP，置 WS_CHILD)
SetParent ret = 65548
parent @100ms  = 2493676
parent @1100ms = 2493676         ← 稳定保持，未被内核还原
```

| 验证项 | 结果 | 取证 |
|---|---|---|
| 父子关系建立 | 通过 | GetParent 回读 == 壳 HWND |
| 关系持久性 | 通过 | 1.1s 后仍保持，内核未自行还原 |
| 内核渲染存活 | 通过 | `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` 抓到完整页面内容 |
| 壳窗口合成视图 | 通过 | 壳窗口 PrintWindow 内可见内核页面 |
| 屏幕实拍可见 | 通过 | CopyFromScreen 实拍到内容 |
| CDP 控制面 | 通过 | `http://127.0.0.1:9341/json/list` 正常返回 page target，title/url 正确 |
| Edge 进程存活 | 通过 | 嵌入后内核进程无异常退出 |

结论：**嵌入不会打断 Chromium 的渲染管线，也不影响 CDP 编排通道。** 这两点原本是最大不确定性，现已排除。

---

## 二、方案对比矩阵

### A. 独立窗口并列（壳窗口 + 内核独立窗口，坐标跟随同步）
### B. Win32 SetParent 真嵌入（本次实测方案）
### C. 回到 Electron BrowserWindow 承载页面（内核进程退居扩展代理）
### D. 无边框覆盖拼接（内核对齐摆放 + 壳自绘标题栏压在上层，不重定父）

| 维度 | A 独立窗口并列 | **B SetParent 嵌入** | C Electron 承载 | D 覆盖拼接 |
|---|---|---|---|---|
| 视觉融合度 | 差（始终是两块窗） | **高（实测合成成功）** | 高 | 中高（层级/拖动需手工同步） |
| 内核版本 | Edge 149 | **Edge 149** | Electron 31 / Chromium 126 | Edge 149 |
| 扩展能力 | 完整 MV3 | **完整 MV3** | MV3 SW 注册失败（已实测） | 完整 MV3 |
| ①原生收益（Fetch 拦截/Cookie 写入/脚本注入） | 有 | **有** | 有 | 有 |
| 实现复杂度 | 低 | 中（已跑通，有可复用脚本） | 中 | 中 |
| 与内核的耦合度 | 松 | 紧（改内核窗口样式） | 松 | 极松 |
| 内核异常影响面 | 隔离 | 可能带崩宿主消息循环 | 隔离 | 隔离 |
| 多窗口 / 多标签扩展 | 好 | 中（每窗口一套嵌入逻辑） | 好 | 差 |
| DPI / 缩放鲁棒性 | 好 | 中（需处理跨 DPI 感知） | 好 | 中 |
| 输入焦点可靠性 | 高 | **未验证** | 高 | 中 |
| 本次实测状态 | 未测（无需测，机制简单） | **已通过** | 已知退化，否决 | 未测 |

淘汰说明：C 在早前实验中已确认 MV3 Service Worker 注册失败（status 15/2）、后台仅 9 个 `chrome.*` API、交互入口类 API 全缺，与"扩展多、要灵活"的诉求直接冲突，不再作为候选。

---

## 三、推荐路线

**主路线 B，A 作为运行时回退开关。**

理由：
1. B 是唯一同时满足"真 149 内核 + 完整 MV3 扩展 + 原生拦截收益 + 单一窗口观感"的方案，且已在本机跑通。
2. 实现成本集中在一个几十行的 Win32 帮助模块上（改样式 → SetParent → 回读校验），不需要碰内核二进制。
3. A 的机制极简，作为 B 的降级路径成本几乎为零：嵌入失败时不做重定父，退化成坐标跟随的独立窗口，功能不丢，只是观感差一档。

### B 路线实施要点（全部来自本次实测，不是文档推演）

1. **必须先改样式**：`style = (style & ~WS_POPUP) | WS_CHILD`，然后才 SetParent。跳过这步必失败，且失败是静默的。
2. **必须回读校验**：`GetParent` 不等于壳 HWND 一律视为失败，不要相信 SetParent 的返回值。
3. **嵌入后定位用 MoveWindow**，坐标相对父窗口客户区。
4. **壳窗口需要显式前置**（`SetWindowPos HWND_TOPMOST` + `SetForegroundWindow`），否则嵌入结果可能被其他窗口遮挡，表现为"看起来没生效"。
5. **CDP 端口与窗口宿主完全解耦**，嵌入前后均可照常编排，控制面无需任何适配。
6. **隐私实例仍走零扩展独立 profile**，与承载方式无关，红线不受影响。

### 剩余待验证项（本次未覆盖，不宣称已解决）

- 嵌入状态下鼠标 / 键盘输入是否正常投递到内核（需真实点击测试，本次只做了渲染取证）。
- 内核自身弹出的独立顶层窗口（设置页、下载确认、权限气泡）不会成为壳的子窗口，会以独立窗口出现。
- 多显示器跨 DPI 拖动时的缩放重算。
- 内核进程崩溃时对宿主壳消息循环的影响。

---

## 四、证据文件

| 文件 | 说明 |
|---|---|
| R2-evidence-1-pre-embed.png | 嵌入前内核窗口基线渲染 |
| R2-evidence-2-kernel-after-embed.png | 嵌入后直接抓内核窗口，渲染存活 |
| R2-evidence-3-shell-composite.png | 壳窗口合成视图，内核内容已在其中 |
| R2-evidence-4-screen.png | 屏幕实拍，最终观感 |
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
