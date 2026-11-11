# 第三方组件与许可声明（THIRD-PARTY NOTICES）

Nyx（本项目，`package.json` → `"name": "nyx"`, `"version": "1.16.0"`）以 **MIT** 许可证发布，全文见仓库根目录 [`LICENSE`](LICENSE)（`Copyright (c) 2026 Nyx contributors`）。

本文件列出项目在**构建期**或**分发期**使用的第三方组件，以及它们各自的许可证与义务。除下列组件外，项目自有代码（含 `vendor/edge-abe-helper/edge_abe_helper.cs`）均按 MIT 发布。各第三方组件**不因被本项目使用而改变其许可证**。

> 说明：本文件是许可事实的汇总声明，不替代各组件许可证原文。若本文件与上游许可证原文冲突，以上游原文为准。

---

## 一、组件清单

| 名称 | 版本 | 许可证 | 上游仓库 / 源码 | 本项目如何分发 | 义务 |
|---|---|---|---|---|---|
| **Electron**（含 Chromium、Node.js、V8 及其第三方库） | 43.7.4 | MIT（Electron 本体）；随包运行时另含 BSD-3-Clause / MIT 等大量第三方许可（Chromium、Node.js、V8 等） | https://github.com/electron/electron ；许可证 https://github.com/electron/electron/blob/main/LICENSE ；Chromium 源码/LICENSE https://chromium.googlesource.com/chromium/src/+/main/LICENSE ；Node.js https://github.com/nodejs/node/blob/main/LICENSE ；Electron 官方的第三方许可汇总随发行包以 `LICENSES.chromium.html` 形式提供 | **安装包随包**：Electron 运行时（`electron.exe`、Chromium、Node.js、V8、`LICENSE`、`LICENSES.chromium.html`）由 electron-builder 打入安装目录，属本项目运行时的组成 | 保留版权声明与许可证文本。`LICENSES.chromium.html` 与 `LICENSE` 必须随安装目录一起分发，**不得删除或裁剪**（安装包会原样带上，无需额外操作；打包后请勿手动清理 `resources/` 之外的 Electron 自带许可文件） |
| **electron-builder** | 24.13.3 | MIT | https://github.com/electron-userland/electron-builder | **仅构建期**（`devDependencies`），不进入安装包 | 无分发义务（其产物为构建工具）；如需完整性，本表已记录版本与来源 |
| **@modelcontextprotocol/sdk**（MCP SDK） | 1.30.0（`package.json` 声明 `^1.12.0`） | MIT | https://github.com/modelcontextprotocol/typescript-sdk | **依赖安装 + 随包**：属生产依赖，被 electron-builder 打入 `app.asar`（已在 `dist/win-unpacked/resources/app.asar` 中确认存在） | MIT：随分发保留版权声明与许可证文本（并入本文件即满足；发行说明中注明即可） |
| **zod** | 3.25.76（`package.json` 声明 `^3.23.8`） | MIT | https://github.com/colinhacks/zod | **依赖安装 + 随包**：生产依赖，同样打入 `app.asar` | 同上（MIT） |
| **npm 传递依赖**（`package-lock.json` 中的其余条目：MIT / ISC / Apache-2.0 / BSD-3-Clause / BSD-2-Clause / BlueOak-1.0.0 / 0BSD 等宽松许可为主） | 见 `package-lock.json` | 见各包 `package.json` 的 `license` 字段（本表依据 `package-lock.json` 元数据归纳） | 各包各自的 npm 仓库 | **依赖安装**；其中被生产依赖闭包用到的部分随 `app.asar` 分发 | 宽松许可：随分发保留其版权与许可声明。完整清单可用 `npx license-checker --production` 生成后附于发行说明（可选） |
| **mihomo（Clash Meta 内核）** | v1.19.31（windows-amd64） | **GPL-3.0**（GNU General Public License v3.0）— 已核对上游 `LICENSE`：https://raw.githubusercontent.com/MetaCubeX/mihomo/v1.19.31/LICENSE | https://github.com/MetaCubeX/mihomo ；本版本源码 https://github.com/MetaCubeX/mihomo/tree/v1.19.31 | **仓库不提交二进制**：`.gitignore` 忽略 `vendor/mihomo/mihomo.exe`，由 `scripts/fetch-vendor.js`（`npm run setup-vendor`）按 `vendor/mihomo/VERSION.txt` 记录的版本与 SHA256 下载校验。<br>**安装包随包**：`electron-builder` 的 `extraResources`（`{"from": "vendor", "to": "vendor"}`）把 `vendor/mihomo/mihomo.exe` 复制进安装目录 `resources/vendor/mihomo/`，因此**发行安装包确实在再分发该 GPL-3.0 二进制**（已在 `dist/win-unpacked/resources/vendor/` 中确认 61,047,808 字节的 `mihomo.exe`） | GPL-3.0 §4 / §5 / §6：<br>① 随包**附 GPL-3.0 许可证全文**（未修改本项目的发行包中必须含许可证副本）；<br>② **提供对应源码的获取方式**（本项目未修改 mihomo 源码，故提供上游对应 tag 的源码地址即可：https://github.com/MetaCubeX/mihomo/tree/v1.19.31 ）；<br>③ 不得对所获 GPL 代码附加额外限制；<br>④ 保留上游版权与许可声明（不剥离二进制中的声明） |
| **geo 数据：geoip.metadb / geosite.dat** | 无版本号（上游 `latest` 滚动发布；本仓库内副本见下方 SHA256） | **GPL-3.0** — 上游仓库许可证已核对：https://github.com/MetaCubeX/meta-rules-dat （GitHub 许可接口 `spdx_id = GPL-3.0`） | https://github.com/MetaCubeX/meta-rules-dat ；发布页 https://github.com/MetaCubeX/meta-rules-dat/releases | 同 mihomo：**仓库不提交**（`.gitignore` 忽略 `vendor/mihomo/geo/`），由 `scripts/fetch-vendor.js` 从上游 `latest` release 下载并按上游 `.sha256sum` 校验；**安装包随包**（`extraResources` → `resources/vendor/mihomo/geo/`） | 同 GPL-3.0 义务（附许可证全文 + 源码/数据获取方式）。数据文件由 mihomo 内核在运行时读取，不属于 Nyx 程序代码 |
| **edge_abe_helper.cs**（Edge App-Bound Encryption 辅助程序） | 仓库内版本（10,242 字节） | **MIT（本项目自有代码）** | 无上游：`namespace NyxEdgeAbeHelper`，由本项目 `src/core/edge-cookie-import.js` 调起；技术背景参见 Microsoft Edge 的 App-Bound Encryption 机制 | **安装包随包**（`vendor/edge-abe-helper/edge_abe_helper.cs` 经 `extraResources` 进入 `resources/vendor/`） | 无第三方义务（本项目自有，按 MIT 发布）。建议在文件头补一行来源说明，便于外部审计 |

### 许可证分布（`package-lock.json` 统计，仅供审计参考）

`package-lock.json`（lockfileVersion 3，441 条）按 `license` 字段统计：MIT 321、ISC 39、Apache-2.0 35、BSD-3-Clause 15、LGPL-3.0-or-later 10、BSD-2-Clause 6、BlueOak-1.0.0 5、组合式（Apache-2.0 AND LGPL-3.0-or-later 等）4、Python-2.0 1、WTFPL/`WTFPL OR ISC` 2、0BSD 1、未标注 2。

其中 `LGPL-3.0-or-later` 条目**全部**来自 `sharp` / `libvips`（`@img/sharp-*`、`@img/sharp-libvips-*`），而 `sharp`、`@huggingface/transformers`、`onnxruntime-node`、`openvino-node` **并不在 `package.json` 的依赖中**（只残留在 `package-lock.json` 里，见 `.opensource-audit/license-report.md` 的“锁文件不同步”条目），也**未进入** `app.asar`。因此它们不影响本项目的发行许可，但会让外部审计者误判依赖构成，建议清理锁文件。

---

## 二、重新分发说明（MIT 与 GPL-3.0 的边界）

1. **Nyx 本体是 MIT。** 项目自有代码（`src/`、`scripts/`、`build/` 脚本、`vendor/edge-abe-helper/`）由 Nyx contributors 以 MIT 发布。

2. **mihomo 以独立进程方式运行，不与本项目代码链接。** Nyx 通过 `child_process` 启动 `vendor/mihomo/mihomo.exe`，并仅通过本地 HTTP / 内核 API 与之通信：
   - 进程启动路径：`src/core/proxy-service.js:252` → `path.join(vendorDir, 'mihomo', 'mihomo.exe')`
   - 目录定位（开发态 vs 打包态）：`src/main.js:151-152`（打包后为 `resources/vendor`）
   - geo 数据复制进内核工作目录：`src/core/proxy-kernel.js:288-290`

   因此 mihomo 与 Nyx 之间是**可分发的独立程序**关系（进程边界 + 网络接口），不是链接或合并，GPL-3.0 不会传染到 MIT 的 Nyx 代码。geo 数据文件是 mihomo 运行时读取的独立数据资产，同样不由 Nyx 代码静态包含。

3. **仓库不提交 GPL 二进制，安装包才随包分发。** 两条路径分别对应不同的义务：
   - *仅克隆仓库的用户*：仓库中只有 `vendor/mihomo/VERSION.txt`（版本 / SHA256 / 来源记录）与 `scripts/fetch-vendor.js`，用户在本地运行 `npm run setup-vendor` 自行下载。**下载来源是上游 mihomo 官方发布页**，GPL-3.0 说明与上游源码链接见上表与 `scripts/fetch-vendor.js` 的注释。
   - *安装发行包的用户*：安装包内**确实包含** mihomo v1.19.31 二进制与 geo 数据（`extraResources`），此时属于“以二进制形式再分发 GPL-3.0 程序”，**必须**随附 GPL-3.0 许可证全文并提供对应源码获取方式（见上表“义务”列，以及 `.opensource-audit/license-report.md` 的待办清单）。

4. **SHA256 固定的下载来源（可复现）**

   | 资产 | 大小 | SHA256 |
   |---|---|---|
   | `mihomo-windows-amd64-v1.19.31.zip`（上游发布包，https://github.com/MetaCubeX/mihomo/releases/download/v1.19.31/mihomo-windows-amd64-v1.19.31.zip ） | 22,430,598 B | `38b2420799d9e7cde77ec1a19c7150dd17ca77f7fb82d9f62cb8763a307eee67`（取自 GitHub Release 资产 `digest` 字段） |
   | 解压后 `mihomo.exe`（实际落盘 `vendor/mihomo/mihomo.exe`） | 61,047,808 B | `532ED88B3A37D72F6B5EE5D24A45CE5D8799F3BA34931D6A167D4345F7EBCA50`（与 `vendor/mihomo/VERSION.txt` 记录一致，本地实测同值） |
   | `geoip.metadb`（本仓库当前使用的副本） | 8,510,129 B | `2483EA23514052425A64538AA502FC37263DB797150C62BD2F6AD147AE61372B` |
   | `geosite.dat`（本仓库当前使用的副本） | 4,244,510 B | `9E37F1C1E764A1772F5331B69B20F741944B033F0584AEC4FC358330E2D869DD` |

   注意：geo 数据来自上游 `latest` 滚动发布（URL 中的 tag 名为 `latest`，会随上游更新而变化），因此**该 URL 本身不是内容固定的地址**；上面两行 SHA256 是当前副本的实测值，`scripts/fetch-vendor.js` 依赖上游 `.sha256sum` sidecar 或 Release API `digest` 做校验。若需完全可复现，应把 geo 数据固定到具体 release（或把 SHA256 写入版本记录文件）。

5. **获取 mihomo 源码的方式（供 GPL 合规使用）**
   - 上游仓库：https://github.com/MetaCubeX/mihomo
   - 对应本版本源码：https://github.com/MetaCubeX/mihomo/tree/v1.19.31
   - 源码归档：https://github.com/MetaCubeX/mihomo/archive/refs/tags/v1.19.31.tar.gz
   - GPL-3.0 许可证全文：https://www.gnu.org/licenses/gpl-3.0.txt （亦见 https://raw.githubusercontent.com/MetaCubeX/mihomo/v1.19.31/LICENSE ）

6. **本项目未修改 mihomo。** 若未来对 mihomo 打补丁或修改源码，则必须以 GPL-3.0 分发修改后的完整源码（含构建脚本），不能只提供上游链接。

---

## 三、媒体与素材（图片 / 图标 / 字体）

| 资产 | 大小 / SHA256 | 判定 | 说明 |
|---|---|---|---|
| `build/icon.png` | 10,251 B / `706201F6018C4780948519431B441E2D65B3D591847EA9EE6C721B0FA17836B1` | 来源未记录（UNKNOWN） | 用作应用图标源图（electron-builder `buildResources`）。仓库内无第三方来源记录，按本项目自有标识处理；建议在 `README` 或本文件补一行出处（例如“自绘 / 由 X 生成，2026”），避免外部审计者无法追溯 |
| `build/icon.ico` | 22,035 B | 来源未记录（UNKNOWN） | 由 `build/icon.png` 派生的 Windows 图标；`package.json` → `build.win.icon` 引用。**注意：该文件目前未被 git 跟踪**（`git status` 显示未跟踪、`git ls-files build` 无此文件），发布仓库需将其入库，否则新克隆无法打包安装包 |
| `src/assets/tray.png` | 1,218 B / `D61C329ED9940BA084EB3E26A44D074A8210A360AAB9B97C6A0B5D856999F409` | 来源未记录（UNKNOWN） | 托盘图标，随 `src/` 打入 `app.asar`；同上，建议补出处 |
| 字体 | — | **无第三方字体** | 全仓库未发现 `.ttf/.otf/.woff/.woff2` 字体文件，也未发现 `@font-face` 引用外部字体；`src/renderer/theme-nyx.css` 中的颗粒噪点纹理为内联 `data:image/svg+xml`（`feTurbulence`），由本项目 CSS 自行生成 |
| `docs/evidence-R2/*.png` | 4 张截图 | 第三方产品截图，**不对外发布** | 已由 `.gitignore` 排除（`docs/evidence-R2/`），不进入公开仓库；其中含真实网络出口信息与第三方界面 |


---

## 四、本项目不包含的内容

- 不包含 Chromium / Node.js / V8 的源码，也不重复粘贴其全部许可证文本：这些文本由 Electron 发行包以 `LICENSE` 与 `LICENSES.chromium.html` 形式随包提供（`node_modules/electron/dist/` 内可见，安装后位于 Electron 运行时目录）。
- 不包含 GPL-3.0 全文的重复粘贴：全文以上游链接与本文件“义务”列指向的地址为准；**发行安装包仍需随包附带一份 GPL-3.0 全文**（见第二节与审计报告待办）。
- 不包含商业字体、商业图标库或来源不明的素材。

---

_本文件由仓库维护者在发布前核对；如发现任何许可信息与实际不符，请开 issue 更正。_
