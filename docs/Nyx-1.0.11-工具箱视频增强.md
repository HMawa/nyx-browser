---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_931f9c85b61e11f1a816525400cd780f
    ReservedCode1: izysdZz6HoTxWpbLJcbQHX76cg1LZrDusaxNcJGlwrbQqg8uUb3ag6HPhKfTKiGN754lcSn0rzRe9cyD+kUYPTAJCgTjd4xo0QSIYhg+2m1BUDjMoAN5C1D1t/ErJXt9ZRdpv/ztWYUPFwBx7daDcq7MLne9YfAzbo8Og1rbfRdw9OgVqF3KxYVt/yA=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_931f9c85b61e11f1a816525400cd780f
    ReservedCode2: izysdZz6HoTxWpbLJcbQHX76cg1LZrDusaxNcJGlwrbQqg8uUb3ag6HPhKfTKiGN754lcSn0rzRe9cyD+kUYPTAJCgTjd4xo0QSIYhg+2m1BUDjMoAN5C1D1t/ErJXt9ZRdpv/ztWYUPFwBx7daDcq7MLne9YfAzbo8Og1rbfRdw9OgVqF3KxYVt/yA=
---

# Nyx 1.0.11 工具箱「视频」页签

> 补档生成时间：2026-09-22（发版当日未单独出文档，随 1.0.12 合并发版一并补齐）
> 关联：`PROGRESS.md`「二·补 15」、`<版本存档目录>\1.0.11\版本记录-1.0.11.md`

---

## 一、版本口径

| 项 | 值 |
| --- | --- |
| 版本号 | `1.0.11` |
| 版本类型 | 功能新增（内置开发者工具箱新增「视频」页签） |
| 安装包 | `Nyx-Setup-1.0.11.exe`（98,507,689 字节 / 约 93.94 MB） |
| SHA-256 | `eedb625f122c07aef567f507688be9b56a3cdd23159326e1e6fbdb7d6c40ad45` |
| 构建时间 | 2026-09-21 23:31:49 |
| 后续 | 能力已全部并入 **1.0.12**，此后无需单独投放 1.0.11 |

---

## 二、能力范围（在线课堂 / 在线视频场景）

1. **倍速解锁**：最高 16x；带**站点改回拦截**（页面脚本把 `playbackRate` 改回去会被拦下）与速率锁定。
2. **进度条拖动突破**：按百分比 / 秒 / 直接跳末尾三种模式；带**锁定纠偏**（页面把 `currentTime` 拽回时自动纠正）。
3. **鼠标随机移动保活**：在视频窗口按随机间隔合成鼠标移动，规避挂机检测；**CDP 真事件优先**（`Input.dispatchMouseEvent`），通道被开发者工具占用时自动回落到页面脚本通道（`dispatchEvent`）。
4. **无残留**：收起工具箱 = 停止保活 + `releaseAllVideo` 还原页面原型，不留改写痕迹。

---

## 三、实现结构（四层各加薄薄一层）

| 文件 | 改动要点 |
| --- | --- |
| `src\core\toolbox-devtools.js` | `VIDEO_KIT` 页面注入脚本：原型拦截 `playbackRate` / `currentTime`，`jiggle` 合成鼠标，`scan` 汇总（count / videos / main / rate / lock* / viewport）；鼠标 burst 增加 `misses` / `retryDelay` 短间隔补试 |
| `src\main.js` | 注册 `nyx:tb:video-{scan,rate,seek,mouse,release}` 五个 `ipcMain.handle`，参数统一从 payload 解 `{wcId, rate, lock, seconds, percent, mode, gap, ...}`；保活优先 CDP，抛错则置 `fallback` 走页面脚本通道；关闭 / 收起工具箱时清 timer 并置 `running=false` |
| `src\preload.js` | 透传五个视频方法 |
| `src\renderer\toolbox-ui.js` | tb 状态增加 `video` / `mouse` 字段；切到 video 页签自动 `scan`；倍速锁 / 进度锁复用 `kit.setLock`；鼠标启停走轮询；关闭工具箱与切标签调用 `release` / `refresh`，防跨标签串台 |

---

## 四、验证

- 真机验证：**静音 WAV 假媒体 + 假 toolbox 驱动 `PageTools`**，**21/21 PASS**。
- 发版构建：`node node_modules\.bin\electron-builder.cmd --win nsis`（`npm run dist` 静默失败，未出包，故绕开）。
- `latest.json` 更新为 1.0.11 并投放更新源 `%APPDATA%\Nyx\updates`；存档 sha256 与 dist / 更新源三份一致。

---

## 五、更新说明（用户可见原文）

> 1.0.11：工具箱新增「视频」页签——视频窗口鼠标随机移动保活（防挂机检测）、倍速解锁最高 16x（含站点改回拦截）、进度条拖动解锁（含锁定不被拽回）

*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
