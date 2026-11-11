---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_f7d3bf03b58a11f183e7525400de85a5
    ReservedCode1: iXlJ9hhu2RXiHz13AUe5bniOpzPOIiw4KqK/VTSah7fy4A8XGUuCEehRfjhNxplx0okMSh8Py/UBGCI/68zG1Gw+IQehcDxJphIre5ReUyVlkPeR3u9opZl3sNJkQgJD/bgnOShyUmDHEaAhkdUcM/SDY21OFJPmssVDPjQRMKuEtFdXmdkpnSihLrM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_f7d3bf03b58a11f183e7525400de85a5
    ReservedCode2: iXlJ9hhu2RXiHz13AUe5bniOpzPOIiw4KqK/VTSah7fy4A8XGUuCEehRfjhNxplx0okMSh8Py/UBGCI/68zG1Gw+IQehcDxJphIre5ReUyVlkPeR3u9opZl3sNJkQgJD/bgnOShyUmDHEaAhkdUcM/SDY21OFJPmssVDPjQRMKuEtFdXmdkpnSihLrM=
---

# Nyx 1.0.9 · 设置中心缺陷修复与发版记录

> 记录时间：2026-09-21 下午
> 关联文档：`<项目根目录>\PROGRESS.md`「二·补 14」、`<本地工作目录>\Nyx-会话归档与交接说明.md`、`<版本存档目录>\1.0.9\版本记录-1.0.9.md`

## 一、本轮任务来源

用户指令（手机消息，原文）：

> 1删了，2重新打包并上线（记得所有操作和文件内容的归档整理）

承接上一轮：设置中心三文件（`proxy-center.js` / `settings.js` / `settings.css`）已完成 P0/P1/P2 全量修复并离屏 Electron 实测全绿；其中 `src\renderer\proxy-center.html` 经全工程引用核查确认为**死文件**（设置中心整合后无任何加载入口），等用户拍板。本轮即执行：删除死文件 → 重新打包 → 上线 → 归档。

## 二、操作时间线

| # | 动作 | 结果 |
| --- | --- | --- |
| 1 | 删除死文件 `src\renderer\proxy-center.html` | 已删（8,649 字节） |
| 2 | 清理残留引用：`proxy-center.js` 两处注释改写为「独立承载页」通用表述 | 完成 |
| 3 | 删除零调用死接口：`src\preload.js` 的 `openProxyCenter`（含悬空注释） | 完成 |
| 4 | `package.json` version：`1.0.8` → `1.0.9` | 完成 |
| 5 | `node --check` 语法自检（`preload.js` / `main.js` / `proxy-center.js` / `settings.js`） | 4/4 PASS |
| 6 | 首次构建（14:51:53） | 产出 `Nyx-Setup-1.0.9.exe` 98,521,685 B |
| 7 | 发现构建后仍改过 `preload.js`，**废弃首版重新构建**（14:53:09） | 产出 98,521,357 B（**采用此版**，保证包内容与冻结源码一致） |
| 8 | `node scripts/make-release.js` 推送更新源 | `%APPDATA%\Nyx\updates\` 投放 1.0.9 安装包 + `latest.json` |
| 9 | python 以 UTF-8 回写 `dist\latest.json` 与更新源 `latest.json` 的 `notes` 字段 | 两份一致（249 字符） |
| 10 | 归档至 `<版本存档目录>\1.0.9\` | exe + blockmap + 版本记录 |
| 11 | 三份 sha256 / 体积校验 | **完全一致** |

## 三、源码改动明细

对照基准：修复前快照 `<会话 temp>\nyx-settings-fix-backup`（含 `proxy-center.js` / `settings.js` / `settings.css`）。

### 3.1 `src\renderer\proxy-center.js`（+27 / −90 行）

1. **状态栏归属门控**：新增 `isNetworkSectionActive()`（读 `document.querySelector('.sec-panel.active')` 判定当前分区）；`setStatusText()` 在非「网络与代理」分区可见时直接返回，避免代理侧异步回调顶掉用户当前分区的提示；无 `.sec-panel` 的独立承载页视为常驻激活。
2. **代理数据按需加载**：启动即执行的 `loadAll()` 改为 `ensureNetworkLoaded()`（`networkLoaded` 一次性闸门），仅当切入「网络与代理」分区才拉状态、节点与网卡清单，由 `settings.js` 广播的 `nyx:section-change` 事件驱动。默认停在外观分区时不再起 PowerShell 查系统出口。
3. **运行时长定时器降耗**：每秒重绘增加分区可见判定，后台不再空转。
4. **软件更新逻辑整体移出**：`renderUpdate()` / `refreshUpdateStatus()` / 三个按钮绑定 / `onUpdateState` 订阅 / 首屏刷新，连同 `els` 中 8 个 `update-*` 元素引用一并迁往 `settings.js`。

### 3.2 `src\renderer\settings.js`（+142 / −18 行）

1. **`setStatus(text, isError)`**：支持错误态样式，空元素直接返回。
2. **分区切换广播**：`document.dispatchEvent(new CustomEvent('nyx:section-change', { detail: section }))`。
3. **进「关于」分区即刷新更新状态**：不做一次性缓存（版本与升级包状态可能被后台改变）。
4. **`loadPrivacy()` 容错**：`privacyReady = true` 由进门前置位改为 `try / catch` 内**成功后才置位**；失败时复位为 `false`、状态栏亮错误态，允许重进分区重试（原实现一次 IPC 报错即永久卡死）。
5. **隐私红标修正**：`privacy-badge` 由 `classList.add('bad')` 改为 `classList.toggle('bad', vault.hardened === false && status.mode === 'private')`；模块不可用时显式 `remove('bad')`。
6. **`applyStartupPrefs()` 缺接口提示**：主进程接口未就绪时不再静默 `return`，改在 `home-hint` 给出明确文案并亮错误态。
7. **迁入「关于与更新」**：`renderUpdate()` / `refreshUpdateStatus()` / 检查更新 / 安装升级包 / 打开更新目录三处绑定；`onUpdateState` 订阅置于模块顶层（后台下载进度与「升级包已就绪」需实时落界面）；初始化末尾补一次 `refreshUpdateStatus()`。

### 3.3 `src\renderer\settings.css`（+6 / −4 行）

1. 移除与 `proxy-center.css` 重复的 `.sec-panel[data-sec='network'] .layout { padding: 12px }` 覆盖。
2. 新增 `#update-hint { white-space: pre-wrap }`：更新提示为多行文案，必须保留换行。

### 3.4 死代码清理（本版发版前执行）

| 对象 | 处理 | 依据 |
| --- | --- | --- |
| `src\renderer\proxy-center.html`（8,649 B） | **删除** | 设置中心整合后无任何加载入口；`main.js` 的 `nyx:proxy:open` 早已改为 `openSettings()`；其原承载的更新按钮 UI 绑定随迁移真空 |
| `src\preload.js` → `openProxyCenter` | **删除** | 全工程零调用点（`/** 兼容旧调用名：与 openSettings 等价 */`），悬空注释同步清除 |
| `src\renderer\proxy-center.js`（2 处注释） | 改写 | 原注释指向已删文件 |
| `src\renderer\proxy-center.js` / `.css` | **保留** | 仍被 `settings.html` link / script 引用，为「网络与代理」分区的实现本体，非死文件 |

## 四、打包产物与校验

| 项 | 值 |
| --- | --- |
| 版本号 | `1.0.9` |
| 安装包 | `Nyx-Setup-1.0.9.exe` |
| 体积 | 98,521,357 字节（约 94.0 MB） |
| 构建时间 | 2026-09-21 14:53:09 |
| SHA-256 | `b3fa9ca7debc406cae3996b87bee81a04c6fa9ac8b132c3f9cb7799fe98d2901` |
| blockmap | `Nyx-Setup-1.0.9.exe.blockmap`（104,152 字节） |
| 构建命令 | `node node_modules/electron-builder/cli.js --win nsis`（`CSC_IDENTITY_AUTO_DISCOVERY=false`，绕开 `npm run dist` 静默不执行的问题） |

**三处一致性校验（实测）**

| 位置 | 路径 | sha256 | 体积 |
| --- | --- | --- | --- |
| 构建产物 | `<项目根目录>\dist\Nyx-Setup-1.0.9.exe` | `b3fa9ca7…d2901` | 98,521,357 B |
| 更新源 | `%APPDATA%\Nyx\updates\Nyx-Setup-1.0.9.exe` | 同上 | 同上 |
| 版本存档 | `<版本存档目录>\1.0.9\Nyx-Setup-1.0.9.exe` | 同上 | 同上 |

- 与更新源 `latest.json` 的 `sha256` / `size` 字段一致：**True**
- `dist\latest.json` 与更新源 `latest.json` 的 `notes` 一致：**True**（均 249 字符）

## 五、打包内容验证

对 `dist\win-unpacked\resources\app.asar`（8,798,495 字节）做字符串探针：

| 探针 | 命中数 | 判定 |
| --- | --- | --- |
| `proxy-center.html` | 0 | ✅ 死文件确已不入包 |
| `openProxyCenter` | 0 | ✅ 死接口确已不入包 |
| `getProxyStatus` | 2 | ✅ 代理状态接口在位 |
| `proxy-center.js` | 5 | ✅ 分区实现正常打包 |
| `proxy-center.css` | 5 | ✅ 样式正常打包 |
| `openSettings` | 7 | ✅ 设置中心入口正常 |

## 六、遗留与建议

1. **本机安装版仍为 1.0.8**，待应用内「检查更新 → 立即升级」（或启动后 8 秒自动检查）覆盖升级至 1.0.9。
2. **更新源内 1.0.7 旧包**（98,498,094 字节）已无用途（1.0.7 已在版本存档留档），可择机清理；1.0.8 作为上一版建议保留。
3. 扩展兼容遗留三项承袭 1.0.8：① 无浏览器工具栏图标（`action` 点击入口缺失）；② MV3 后台 Service Worker 只读，行为与 Chrome 不等价；③ 网络拦截类扩展能力为内核级差异（界面已如实标注）。
4. 路线①+③并行落地（阶段 2 UI 承载）为在途工作，见 `docs\Nyx-路线1和3并行落地方案.md`，与本版修复无耦合。
*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
