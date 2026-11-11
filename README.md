# Nyx

**双模式隐私浏览器。** 同一套 Electron 外壳下，普通模式与全隐私模式拥有各自的会话分区、网络出口、指纹策略与权限规则；全隐私模式默认走本机 mihomo 内核，代理不可达时**拒绝进入**而不是悄悄直连。浏览器数据全部留在本机，内置本地 HTTP 与 MCP 接口，方便把浏览器交给 AI 或脚本操作。

- **双模式**：`persist:nyx-normal`（持久） / `nyx-private`（纯内存，退出即清）
- **内置内核**：mihomo（Clash Meta）以独立进程运行，只监听 `127.0.0.1`，安装时按 SHA256 校验下载
- **本地接口**：HTTP（`127.0.0.1`，需 `X-Nyx-Token`）+ MCP stdio，8 个浏览器操作工具
- **无遥测**：不含统计、崩溃上报、远程日志；没有自建服务器
- 技术栈：Electron 43 / Node.js / 原生 HTML+CSS+JS，无前端框架

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [双模式隐私模型](#双模式隐私模型)
- [本地 AI 操作接口](#本地-ai-操作接口)
- [构建与打包](#构建与打包)
- [安装与卸载](#安装与卸载)
- [安全说明与已知限制](#安全说明与已知限制)
- [许可证](#许可证)
- [免责声明](#免责声明)

---

## 特性

### 双模式隔离

- **两套独立会话分区**：普通模式写入 `persist:nyx-normal`（落盘持久），全隐私模式使用内存分区 `nyx-private`，进程退出即消失。
- **出口绑定不可绕过**：分区与链路绑定由代码强制——隐私模式只允许「代理」链路，调用方传 `direct` 会被直接拒绝（`src/core/sessions.js` 的 `setLink`）。这不是 UI 层的开关，而是会话层的约束。
- **切换即重建**：每次切换模式都会销毁并重建全部标签页，不残留上一模式的页面、来源与滚动状态。
- **退出清场**：离开隐私模式、退出程序、或触发恐慌快捷键时，清除 Storage / Cache / Auth Cache / HostResolver Cache / Code Cache 并 `flushStorageData`。
- **隐私模式无下载**：`will-download` 在会话层直接 `preventDefault()`，不存在"下载到一半再拦"的窗口。

### 反指纹与泄漏防护

- **以真实出口为基准对齐**：UA 的 Chromium 主版本取自本机真实的 `process.versions.chrome`，平台串保持真实；对齐的是「你从哪个地区出口」，而不是伪造一台不存在的机器。
- **请求头改写**：`User-Agent`、`Accept-Language`、`Sec-CH-UA` / `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` 统一改写，并删除 `X-Client-Data`、`X-Requested-With`、`X-Electron-Version` 等特征头。
- **页面级扰动**（`src/preload-tab.js`，仅隐私模式）：Canvas / OffscreenCanvas 取图噪声（面积 ≥16×16 才扰动，避免影响小图标）、WebGL 渲染器统一为 `WebKit WebGL` 并保证扩展与取值自洽、字体枚举、`OfflineAudioContext` 音频指纹、屏幕尺寸量化、`hardwareConcurrency` / `deviceMemory` 固定、媒体设备枚举掩码，以及 Geolocation / 电池 / WebGPU / 语音合成等接口封装。
- **WebRTC**：隐私模式使用 `disable_non_proxied_udp`，禁止非代理 UDP，防止真实 IP 经 STUN 泄漏。
- **时区不猜**：只有在能确认出口地理位置与时区时才改写时区；拿不到出口信息就不改（并在状态里如实标注 `(未对齐)`），避免"猜错反而更独特"。
- **一次一指纹**：每次进入隐私模式重新生成随机种子；离开时重置，下次进入是新的指纹。
- **关闭拼写检查**：两个分区都关闭，避免拼写数据外流。
- **协议白名单**：`src/core/risk-guard.js` 只放行 `http/https/ws/wss/data/blob/about/file/devtools/chrome/chrome-extension`，其余协议请求直接拦截；所有请求进出记入 800 条环形缓冲，可随时查看被拦截项。

### 权限与审计

- **普通模式**：原生对话框询问，会话内记住选择。
- **隐私模式**：默认拒绝全部敏感权限，仅放行全屏与「脱敏后的剪贴板写入」。
- 屏幕共享走系统级选择器；HID / USB / 串口设备权限在隐私模式一律拒绝。
- 同步权限检查处理器永不弹窗（避免阻塞页面线程）。
- **决策留痕**：最近 500 条权限决策可在设置中心与 HTTP 接口中查询。

### 代理内核

- **mihomo（Clash Meta）独立进程**：与浏览器进程分离，只监听 `127.0.0.1`，控制器使用随机 secret，退出时一并结束，异常自动重启（上限 3 次）。
- **启动前配置校验**：先跑 `mihomo -t` 校验配置，通过后才拉起，避免坏配置把整条链路拖死。
- **订阅清洗**：强制 loopback 绑定、关闭 `allow-lan` 与 `tun`、丢弃 `dns.listen`、随机化 secret，防止订阅里的配置把代理暴露到局域网。
- **节点过滤**：剔除广告、无效、过期节点；多网卡机器可指定出口网卡。
- **智能模式**：定时直连探测，国内站点直连、被阻断站点走 PAC，规则上限 300 条并持久化。
- **可观测**：内核日志、当前端口、订阅状态在「代理中心」集中展示。

### 浏览体验

- 多标签（默认上限 12，可用 `NYX_MAX_TABS` 调整）、地址栏联想（历史+书签加权、置顶分组、剪贴板 URL 行、搜索引擎行、标签页标注、键盘导航）。
- 书签树 v2、从 Edge / Chrome 导入书签、独立书签管理窗口、文件夹选择器。
- 历史记录上限 5000 条、5 分钟去重、**隐私模式不写盘**。
- 凭据保险箱：`safeStorage`（Windows 下为 DPAPI）加密，拒绝明文落盘，隐私模式下不可访问。
- 扩展：Edge / Chrome 的 MV3 扩展只加载进普通模式分区，**隐私模式永不加载**；能力等级在界面上如实标注（内容脚本可用，`webRequest` / `declarativeNetRequest` / `nativeMessaging` 不可用）。
- 下载：可选「每次询问」或固定目录；4 套主题（墨夜 / 极光 / 素纸 / 静谧）；系统托盘；单实例运行；全局恐慌快捷键 `Ctrl+Shift+X`（可用 `NYX_PANIC_SHORTCUT` 覆盖）。
- 自托管更新：支持本地目录或 http(s) 的 `latest.json`，断点续传（Range）+ 流式 SHA256 校验 + 静默安装，升级保留用户数据。

### 开发者工具箱

内置调试面板（不依赖外部扩展）：基于 CDP 的资源嗅探与网络抓包（上限 4000 条，仅内存）、页面环境覆盖（UA / 设备 / 限速预设）、控制台执行、Cookie 管理（含从 Edge 导入）、元素拾取与高亮、截图。

---

## 快速开始

**环境要求**：Windows 10/11 x64、Node.js 18 以上、npm。

```powershell
git clone <your-repo-url> Nyx
cd Nyx

npm install
npm run setup-vendor
npm start
```

### 关于 `npm run setup-vendor`

仓库**不包含**代理内核二进制（许可证与仓库体积原因），由脚本在本地下载：

| 产物 | 来源 | 大小 |
| --- | --- | --- |
| `vendor/mihomo/mihomo.exe` | MetaCubeX/mihomo `v1.19.31` windows-amd64 | ~58 MB（zip ~22 MB） |
| `vendor/mihomo/geo/geoip.metadb` | MetaCubeX/meta-rules-dat | ~8 MB |
| `vendor/mihomo/geo/geosite.dat` | MetaCubeX/meta-rules-dat | ~4 MB |

- 版本、下载地址与**期望的 exe SHA256** 都记录在 [`vendor/mihomo/VERSION.txt`](vendor/mihomo/VERSION.txt)（该文件入库，脚本据此校验）。
- 校验不通过直接失败（退出码 1），不会带着损坏的内核继续跑。
- 幂等：已存在且校验通过的文件会跳过，重复执行只补缺失项。
- 只想要计划不想下载：`node scripts/fetch-vendor.js --dry-run`；强制重下：`--force`。
- 网络受限时可手动下载同名产物放进对应目录，再执行一次脚本做校验。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 Nyx（Electron 主进程，`src/main.js`） |
| `npm run setup-vendor` | 下载并校验 mihomo 内核与 geo 数据 |
| `npm run mcp` | 以 stdio 方式启动 MCP 服务（需 Nyx 已在运行） |
| `npm run pack` | 生成未打包的应用目录（`electron-builder --dir`） |
| `npm run dist` | 生成 Windows 安装包（NSIS） |
| `npm run dist:dir` | 生成 NSIS 目标但只输出目录 |
| `npm run release` | 生成自托管更新所需的发布产物 |
| `npm run verify` | 运行仓库自带的验证脚本套件 |

---

## 目录结构

```text
Nyx/
├── src/
│   ├── main.js              主进程：生命周期、模式切换、窗口/托盘/浮层、本地接口装配
│   ├── preload.js           UI 外壳预加载（contextBridge 暴露受限 IPC）
│   ├── preload-tab.js       标签页预加载：隐私模式页面级防泄漏 + 普通模式表单/密码自动填充
│   ├── api/
│   │   └── http-api.js      本机 HTTP 接口（仅 127.0.0.1 + token 鉴权）
│   ├── mcp/
│   │   └── server.js        MCP stdio 服务，转发到上面这套 HTTP 接口
│   ├── core/                主进程能力层
│   ├── renderer/            浏览器外壳 UI（原生 HTML/CSS/JS）
│   └── assets/              托盘等静态资源
├── scripts/                 构建、验证、发布与依赖下载脚本
├── vendor/
│   ├── mihomo/VERSION.txt   内核版本 / 下载地址 / SHA256（入库，二进制不入库）
│   └── edge-abe-helper/     Edge 相关辅助组件
├── build/                   图标与 NSIS 安装器配置（electron-builder 资源）
├── docs/                    发版记录与设计文档
└── package.json
```

`src/core/` 主要模块：

| 模块 | 职责 |
| --- | --- |
| `sessions.js` | 分区、链路绑定、代理应用与清场 |
| `privacy-hardening.js` | 主进程侧指纹对齐（UA / CH-UA / 语言 / WebRTC / 时区） |
| `permissions.js` | 双模式权限策略与决策审计 |
| `risk-guard.js` | 协议白名单与请求风险日志 |
| `proxy-kernel.js` / `proxy-config.js` / `proxy-filter.js` | mihomo 生命周期、订阅配置清洗、节点过滤 |
| `proxy-service.js` / `smart-patrol.js` / `net-interfaces.js` | 代理编排、智能分流、出口网卡 |
| `tabs.js` / `actions.js` | 标签管理、自动化动作执行 |
| `vault.js` / `history-store.js` / `bookmark-store.js` | 凭据保险箱、历史、书签 |
| `extensions.js` / `toolbox.js` / `toolbox-devtools.js` | 扩展加载、工具箱与页面调试能力 |
| `updater.js` / `ui-store.js` / `startup-store.js` / `mode-events.js` | 自托管更新、界面偏好、启动项、模式事件环形日志 |

---

## 双模式隐私模型

| 维度 | 普通模式 | 全隐私模式 |
| --- | --- | --- |
| Session 分区 | `persist:nyx-normal`（落盘） | `nyx-private`（纯内存） |
| Cookie / 站点数据 | 持久保存 | 仅本次会话，离开即清 |
| 缓存 | 保留 | 离开时清除（含 Code Cache / Auth Cache） |
| 下载 | 允许（可设为每次询问） | 禁止（`will-download` 直接拦截） |
| 网络出口 | 直连 / 智能分流 | **强制**本机 mihomo 代理，代码层禁止直连 |
| 代理不可达 | 重新探测后可回落直连并提示 | **拒绝进入隐私模式**，不降级 |
| WebRTC | 默认策略 | `disable_non_proxied_udp` |
| UA / CH-UA | 系统默认 | 按真实出口对齐并改写 |
| 时区 | 系统时区 | 能确认出口地区时改写，否则不改并标注 |
| 指纹 | 系统默认 | 每次进入重新随机（Canvas / WebGL / 字体 / 音频等） |
| 权限请求 | 弹窗询问（会话内记住） | 默认全部拒绝（仅全屏 / 脱敏剪贴板写入） |
| 浏览器扩展 | 允许（仅此分区） | 不加载 |
| 凭据保险箱 | 可读写 | 不可访问 |
| 退出 / 恐慌 | 保留数据 | 清除分区数据并重建界面 |

### WebRTC 防泄漏

Chromium 的 WebRTC 默认允许通过 STUN 收集本机与 NAT 后的地址，即使 HTTP 流量走了代理，真实出口也可能从 ICE candidate 里漏出去。Nyx 在隐私模式把策略固定为 `disable_non_proxied_udp`：不允许未经代理的 UDP，普通模式保持系统默认，避免影响正常音视频通话。

### 权限拒绝策略

隐私模式不弹权限框——弹框本身就是一种指纹与打扰。默认策略是「全拒绝，只留白名单」：全屏、以及经过脱敏的剪贴板写入；屏幕共享交给系统选择器；HID / USB / 串口一律拒绝。普通模式才使用原生对话框，并按会话记住选择。每一次允许/拒绝都进入审计环形缓冲，可在设置中心或 `/privacy/permissions` 查证。

### 进入隐私模式前的代理可达性校验

进入隐私模式前会做一次**纯 TCP 连接探测**（带超时的 `connect`，不发送任何业务数据）确认本机代理端口活着：

1. 探测失败 → 直接拒绝切换，弹出明确原因；
2. **不会**出于"让用户先用上"的考虑悄悄切成直连——那会让用户以为自己在隐私模式里，实际流量裸奔；
3. 已经在隐私模式中时，链路异常也不会自动降级，只能由用户显式退出或修复代理；
4. 普通模式相反：链路断开后重新探测，必要时回落到直连并明确提示当前出口。

---

## 本地 AI 操作接口

Nyx 启动后在 `127.0.0.1` 上开一个 HTTP 服务，供本机脚本或 AI 客户端驱动浏览器。默认端口 `17321`，被占用时自动换端口，实际端口写入 `<userData>/api-port.txt`。

**鉴权**：除 `/health` 外的所有请求都必须带 `X-Nyx-Token` 头（或 `?token=` 查询参数）。Token 首次启动随机生成，存于 `<userData>/api-token.txt`，比较时使用恒定时间算法。请求体上限 1 MB；服务只绑定回环地址，非回环来源一律拒绝。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探针（无需鉴权） |
| GET | `/state` | 当前模式、标签、代理端口等运行状态 |
| GET | `/capabilities` | 当前可用能力清单 |
| POST | `/action` | 执行浏览器动作（见下表） |
| POST | `/mode/switch` | 切换模式，`{"mode":"normal"\|"private"}` |
| GET | `/mode/events` | 模式切换 / 启动事件环形日志 |
| GET | `/privacy/status` | 当前隔离与指纹状态 |
| GET | `/privacy/permissions?limit=` | 权限决策审计 |

`POST /action` 支持的 `type`：

| type | 参数 | 说明 |
| --- | --- | --- |
| `navigate` | `url` | 当前标签打开网址 |
| `screenshot` | — | 页面截图 |
| `click` | `selector`、`index?` | 点击元素（同选择器多命中时可指定序号） |
| `type` | `selector`、`text`、`clear?`、`submit?` | 输入文本 |
| `executeJS` | `code` | 在页面上下文执行脚本 |
| `extractText` | `selector?`、`maxLength?` | 提取文本 |
| `state` | — | 读取状态 |
| `riskLog` | `limit?`、`onlyBlocked?` | 读取请求风险日志 |

```powershell
$token = Get-Content "$env:APPDATA\Nyx\api-token.txt" -Raw
$port  = Get-Content "$env:APPDATA\Nyx\api-port.txt" -Raw

Invoke-RestMethod "http://127.0.0.1:$port/state" -Headers @{ 'X-Nyx-Token' = $token.Trim() }
Invoke-RestMethod "http://127.0.0.1:$port/mode/switch" -Method Post `
  -Headers @{ 'X-Nyx-Token' = $token.Trim() } -ContentType 'application/json' `
  -Body '{"mode":"private"}'
```

### MCP 服务

`npm run mcp` 以 stdio 方式启动 MCP 服务，把上面的 HTTP 接口包装成工具，供 Claude Desktop 等客户端调用。凭证解析顺序：`NYX_TOKEN` / `NYX_API_PORT` / `NYX_API_HOST` 环境变量 → `<userData>/api-token.txt` 与 `api-port.txt`。

| 工具 | 参数 |
| --- | --- |
| `nyx_navigate` | `url` |
| `nyx_screenshot` | —（返回 PNG 图像内容） |
| `nyx_click` | `selector`、`index?` |
| `nyx_type` | `selector`、`text`、`clear?`、`submit?` |
| `nyx_execute_js` | `code` |
| `nyx_extract_text` | `selector?`、`maxLength?` |
| `nyx_state` | — |
| `nyx_risk_log` | `limit?`、`onlyBlocked?` |

MCP 客户端配置示例（把路径换成你自己的仓库位置）：

```json
{
  "mcpServers": {
    "nyx": {
      "command": "node",
      "args": ["<path-to-repo>\\src\\mcp\\server.js"]
    }
  }
}
```

---

## 构建与打包

使用 `electron-builder`，Windows 目标为 NSIS 安装包：

```powershell
npm run setup-vendor   # 安装包需要 vendor/ 里的内核与 geo 数据
npm run dist
```

- 产物：`dist/Nyx-Setup-<version>.exe`（默认英文文件名，界面与安装语言为简体中文）。
- 安装器行为：非一键安装、可改安装目录、写入桌面与开始菜单快捷方式，配置见 `build/installer.nsh`。
- 打包规则：`src/**` 与 `package.json` 进 asar；`vendor/` 通过 `extraResources` 原样放进安装目录；图标取自 `build/icon.ico`。
- 许可证随包：安装目录 `resources/` 下同时放置 `LICENSE`（本项目 MIT）、`THIRD-PARTY-NOTICES.md` 与 `licenses/GPL-3.0.txt`（mihomo 内核的 GPL-3.0 全文）。
- `npm run pack` 只生成未打包目录，便于检查文件是否齐全。

---

## 安装与卸载

发行包是 NSIS 安装器（`dist/Nyx-Setup-<version>.exe`），支持全新/升级/修复安装、自定义安装目录、完整性校验与静默安装。

- 安装前会检查系统版本、架构、目标目录可写性与磁盘剩余空间；
- 覆盖安装（升级/修复）保留 `%APPDATA%\Nyx` 里的个人数据；
- 安装报告写在 `%APPDATA%\Nyx\install-report.txt`，安装时完整性自检结果另见 `%APPDATA%\Nyx\integrity-check.txt`；
- 卸载默认保留个人数据，完全卸载需加 `/DELETEAPPDATA`。

环境检查项、四种安装模式的判定、依赖与推荐下载、完整性校验、静默参数与故障排查，见 [docs/installer.md](docs/installer.md)。

---

## 安全说明与已知限制

**安全设计**

- 本地 HTTP 接口只绑定回环地址，非回环来源拒绝，Token 恒定时间比较，请求体限 1 MB。
- 权限检查/模式切换等关键约束放在主进程（会话层、权限处理层），不依赖渲染层自觉。
- 代理内核是独立进程，不注入浏览器进程，也不会加载订阅里的任意脚本。
- 打包不含任何第三方统计 SDK、崩溃上报或远程日志。

**已知限制（如实说明）**

- **平台**：只支持 Windows x64，内核二进制只有 windows-amd64 版本；其他平台无法开箱运行。
- **隐私 ≠ 匿名**：反指纹的目标是降低可识别性，不是 Tor 级别的匿名。出口 IP 本身就是最强的标识符，需要你自己确保代理出口可信。
- **指纹覆盖有边界**：页面侧已覆盖 UA / CH-UA / Canvas / WebGL / 字体 / 音频 / 时区 / 屏幕 / `hardwareConcurrency` / `deviceMemory` / 媒体设备枚举等常见面，但**只作用于渲染进程可见的 JS / DOM / HTTP 面**；内核自身的 TLS 握手特征、HTTP/2 帧特征，以及代理出口 IP 本身无法伪装。噪声扰动是"降低可识别性"，不是"每次会话完全一致"——个别站点做多次取图比对时仍可能看出扰动。
- **时区策略是"宁可不改"**：拿不到出口地理位置时不做时区伪装，可能与 IP 归属地不一致——这是刻意选择，避免引入新的矛盾信号。
- **内核未签名**：下载的 `mihomo.exe` 未做代码签名，首次运行可能触发 SmartScreen 或杀软提示；脚本用 VERSION.txt 的 SHA256 保证完整性，但无法替代签名。
- **geo 数据随上游滚动**：`geoip.metadb` / `geosite.dat` 取自 meta-rules-dat 的 `latest`，不锁定版本；只有内核版本锁定在 VERSION.txt。
- **只提供工具，不提供服务**：本项目不提供、不运营任何代理节点或订阅服务，运行所需订阅由用户自行准备并对其合法性负责。
- **扩展能力有限**：MV3 扩展只能加载进普通模式，且网络拦截类能力（`webRequest` / DNR）不受支持，部分扩展会功能不全。
- **更新通道需自备**：没有官方更新服务器；要么把 `latest.json` 与安装包放进本地更新目录，要么自建 http(s) 源。
- **单机单用户**：进程级单实例锁，无多用户隔离；能读取 token 文件的本机进程即可控制浏览器。
- **内核窗口内嵌**：把 Edge/Chrome 内核窗口嵌进自绘外框的实验代码（`src/core/kernel-host.js`）依赖额外的 Win32 辅助脚本，仓库未包含该辅助脚本，该路径默认不可用，仅作设计参考。

---

## 许可证

本项目以 **MIT** 许可证发布，全文见 [LICENSE](LICENSE)。

第三方组件各自遵循其自身许可证，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，包括但不限于：

- **Electron**（MIT）
- **mihomo / Clash Meta**（**GPL-3.0**）：以**独立进程**方式启动并与本项目通过本地 HTTP 通信，不链接、不合并，因此不影响本项目的 MIT 授权。**仓库本身不提交其二进制**（`.gitignore` 排除，由 `scripts/fetch-vendor.js` 从上游官方发布页下载并校验 SHA256）；但**发行安装包会随包分发**该 GPL-3.0 二进制，故安装包内同时附带 GPL-3.0 许可证全文（`resources/licenses/GPL-3.0.txt`）与第三方声明（`resources/THIRD-PARTY-NOTICES.md`），并给出对应源码获取方式。本项目对 mihomo 未作任何修改。
- **meta-rules-dat**（geo 数据 `geoip.metadb` / `geosite.dat`，上游许可为 **GPL-3.0**，分发方式同上）。

---

## 免责声明

本项目仅用于**学习交流**。请勿将本项目用于任何违反当地法律法规的用途；使用者自行承担因使用本软件产生的一切后果与责任。软件按「现状」提供，不附带任何明示或暗示的担保。
