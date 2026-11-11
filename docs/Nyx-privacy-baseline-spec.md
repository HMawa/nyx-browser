---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_15044f61b31411f1839d525400cd780f
    ReservedCode1: 0zJy2PAdHz3H3R8wJ1FfTxPiMaZVRFgHzkVYmoLTnawV1+6ydc/SACgyQkRhrAysgMAiEMYH+yilG45A2ZPaUbELjUauogLV4CmwORWu451aBrnB/sxq2lJJ0an1O5vzK/sIDIImFrPX0F5Kewf+u57GldlwkgxWqGhH5NpCHF/tdjgot4YT6w+txkM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_15044f61b31411f1839d525400cd780f
    ReservedCode2: 0zJy2PAdHz3H3R8wJ1FfTxPiMaZVRFgHzkVYmoLTnawV1+6ydc/SACgyQkRhrAysgMAiEMYH+yilG45A2ZPaUbELjUauogLV4CmwORWu451aBrnB/sxq2lJJ0an1O5vzK/sIDIImFrPX0F5Kewf+u57GldlwkgxWqGhH5NpCHF/tdjgot4YT6w+txkM=
---

# Nyx 双模式隐私基线规范

> 依据：https://browserleaks.com/ 检测面清单 + 用户需求（正常模式开放权限、保留 Cookie/表单、密码加密存储；全隐私模式逐项防泄漏）
> 适用代码：`src/core/sessions.js`、`src/core/risk-guard.js`、`src/main.js`、`src/core/proxy-*.js`、`src/renderer/proxy-center.*`

---

## 一、双模式总览

| 维度 | 正常模式 `persist:nyx-normal` | 全隐私模式 `nyx-private`（内存态） |
|---|---|---|
| 存储 | Cookie / localStorage / IndexedDB / 缓存 落盘持久化 | 纯内存，退出或切换即整体清空 |
| 权限 | **开放**：摄像头 / 麦克风 / 定位 / 通知 / 剪贴板等按站点请求弹原生确认，用户可授可拒 | **一律拒绝**，不弹窗 |
| 表单与密码 | 保留自动填充；密码经 DPAPI 加密存储，仅填充瞬间解密 | 不落任何表单 / 密码 / 自动填充数据 |
| 下载 | 允许，走系统默认下载目录 | 禁止任何落盘 |
| 指纹 | **不干扰**（保持真实，避免站点风控与功能异常） | 逐项对抗（见第二节） |
| 代理 | 强制走内置内核混合端口 | 强制走内置内核；内核未就绪**拒绝进入**，绝不静默直连 |
| 拼写检查 | 关闭（避免向远端请求词典形成隐性外联） | 关闭 |
| 出口 IP | 内核节点出口 | 内核节点出口，且需通过出口自查 |

---

## 二、全隐私模式 × browserleaks 检测项处置

| 检测项 | 泄漏面 | 处置手段 | 实现层 |
|---|---|---|---|
| IP Address | 真实公网 IP / ISP / ASN / 城市 | 全流量强制经内核代理，无任何直连回落路径 | 主进程 `session.setProxy`（已有，需复核 bypass 表） |
| HTTP Request Headers | 请求头指纹、UA、`X-Requested-With` 等 | 统一 UA 为 Windows Chrome 稳定版；改写/删除可识别头 | `session.setUserAgent` + `webRequest.onBeforeSendHeaders` |
| 本地时间 / 时区 | 时区与出口 IP 归属不一致，直接暴露 | 时区对齐出口节点所在时区，`Date`/`Intl` 一致覆写 | 渲染前注入 |
| JavaScript Info | UA、平台、语言、核心数、内存、电池、网络类型 | 语言与节点地区一致；`hardwareConcurrency`/`deviceMemory` 固定值；禁用 Battery Status、NetworkInformation；`plugins` 归零 | 注入脚本 |
| WebRTC Leak | STUN 暴露真实本地/公网 IP | `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`，禁 mDNS，`RTCPeerConnection` 置空 | 主进程 + 注入脚本 |
| DNS Leak | 系统 DNS 解析暴露真实线路 | 内核 DNS 走代理（fake-ip + 经代理解析），禁用系统 DNS 回落 | 内核配置 `proxy-config.js` |
| IPv6 Leak | v6 直连绕过代理 | 关闭 IPv6 出站 | 内核 + 主机层 |
| Canvas | 渲染像素指纹 | 注入稳定噪声（每会话随机盐，同会话内结果一致，避免打乱站点功能） | 注入脚本 |
| WebGL | 显卡 vendor / renderer / 参数 | 改写为通用值 + 参数噪声 | 注入脚本 |
| Fonts | 系统字体枚举与字形测量 | 白名单化，仅返回常见字体集 | 注入脚本 |
| Audio | AudioContext 指纹 | 噪声注入 | 注入脚本 |
| Geolocation | 精确定位经纬度 | 权限拒绝 + API 置空 | 权限处理器 + 注入脚本 |
| Features Detection | Electron / 自动化特征 | `navigator.webdriver=false`，清理 Electron 与自定义全局痕迹 | 注入脚本 |
| Content Filters | 被探测为内容过滤环境 | 不注入可被探测的过滤特征 | 注入脚本 |
| Media Devices | 设备数量与 deviceId | `enumerateDevices` 归零 | 注入脚本 |
| Screen | 分辨率/色深暴露真实屏 | 固定为常见分辨率 | 注入脚本 |

### 残余风险（应用层无法覆盖，需记录并披露）

| 项 | 原因 |
|---|---|
| JA3 / JA4 TLS 指纹 | Chromium 网络栈固定，脚本层无法改写 ClientHello |
| TCP/IP OS 指纹 | 由内核 TCP 栈决定，须靠代理节点侧伪装 |
| 显式 SOCKS/HTTP 代理检测 | 节点 IP 为机房段，可被 ASN 库识别为代理/VPN |

---

## 三、代理中心新增能力

### 3.1 广告 / 推广 / 失效节点自动识别与过滤

**识别规则（命中任一即判定为广告节点）**

1. 名称含关键词：`官网`、`订阅`、`地址`、`加群`、`群组`、`TG`、`Telegram`、`客服`、`站长`、`机场`、`续费`、`到期`、`剩余`、`流量`、`购买`、`优惠`、`折扣`、`免费`、`试用`、`防失联`、`备用网址`、`发布页`、`邀请`、`注册`、`教程`、`加速器`
2. 名称含 URL 或域名（`http://`、`https://`、`www.`、`.com`、`.cn`、`.net` 等）
3. 节点 `server` 为空、或指向前述推广域名
4. 名称命中后需排除正常节点误伤（如含"专线""官网优化"等真实节点命名），采用白名单优先级更高

**处置**：过滤结果不写入节点表、不进入任何策略组，仅在代理中心显示"已过滤 N 个广告节点"计数与明细入口（可展开查看被过滤项）。

### 3.2 自动测速

- 内核就绪后自动对全部有效节点并发测速（并发上限 32，避免打满）
- 接口：`GET /proxies/{name}/delay`，`url=http://www.gstatic.com/generate_204`，`timeout=5000`
- 结果标注：延迟毫秒数 / `超时` / `不可用`，按延迟升序排列
- 支持手动重测、单节点重测
- 测速结果仅在内存，不落盘

### 3.3 出口 IP 信息展示

经内核混合端口查询，展示：

| 字段 | 说明 |
|---|---|
| 出口 IP | 公网 IP |
| 国家 / 地区 / 城市 | 归属地 |
| ISP / ASN | 运营商与自治域，用于识别机房段 |
| 时区 | 与本地时区对比，不一致时提示已对齐 |
| 一致性判定 | 与真实线路对比，标记"代理生效 / 疑似泄漏" |

副作用：出口自查为真实外联请求，仅在用户主动点击或进入隐私模式校验时触发。

---

## 四、密码加密存储

- 加密：Electron `safeStorage`（Windows 走 DPAPI，绑定当前用户账户）
- 落盘：密文写入 `%APPDATA%\Nyx\vault`，明文绝不落盘、绝不进日志
- 解密：仅在自动填充瞬间解密到内存，填充后立即释放
- 保护：`vault` 目录不随浏览器数据清场（普通模式保留），进入隐私模式不读不写
*（内容由AI生成，仅供参考）*
