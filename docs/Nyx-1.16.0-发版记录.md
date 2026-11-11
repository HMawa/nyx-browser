# Nyx 1.16.0 · 发版记录

> 版本：**1.16.0**（上一版 1.15.0）
> 发版时间：2026-11-01
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（仍在旧版，需在应用内点「检查更新」）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`updates-archive\1.16.0\`
> 本次工作：**四项功能补齐 + 一次验收基建修复**——置顶建议分组、抓包慢请求阈值进设置页、更新源占用看板、扩展版本历史与回滚 UI；顺手修掉验收脚本因 Windows 保留端口段产生的假失败。

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 地址栏置顶建议按**工作 / 学习 / 其他**分组，每组 5 条、总上限 15；组内重排不影响其它组；导入导出升到 version 2 带 `group` | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/addr-suggest.js`、`src/renderer/settings.{html,js,css}` |
| 2 | 抓包「慢请求」阈值进设置页：主进程 `<userData>\toolbox-prefs.json`，范围 50–10000ms、默认 1000 | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js}` |
| 3 | 设置页「更新源占用」看板：更新源 / 留档 / 合计的字节与文件数，可打开目录、复制清理命令 | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js}` |
| 4 | 设置页「扩展版本历史」：读更新源 `extensions.json` 的 `history`，一键**回滚到旧版**（下载 → sha256 → 安装） | 新功能 | `src/main.js`、`src/preload.js`、`src/renderer/settings.{html,js}` |
| 5 | 验收脚本**端口修复**：改用 `pickFreePort()`（`127.0.0.1:0` 由系统分配），消除保留端口段导致的「主窗口未就绪」假失败 | 修复 | `scripts/lib/free-port.js`、`scripts/verify-{address-suggest,ui-polish,packaged-smoke}.js` |

新增 IPC：`nyx:as:pinned-group-set`、`nyx:tb:slow-ms`、`nyx:tb:slow-ms-set`、`nyx:update:footprint`、`nyx:update:open-source`、`nyx:update:copy-clean-command`、`nyx:ext:online-history`、`nyx:ext:online-rollback`。
新增推送：`nyx:tb:slow-ms`（设置页保存阈值后由主进程广播）。

---

## 二、逐项说明

### 2.1 置顶建议分组

置顶（v1.11.0）一直是**一条平铺列表**，攒到十几条后「最常用的几个」就被淹了。本版按用途分组：

- 三个组 `work` / `study` / `other`（工作 / 学习 / 其他），`PINNED_GROUP_MAX = 5`，总上限 `PINNED_SUGGEST_MAX = 组数 × 每组上限 = 15`；读写两侧都按「每组 5 条」各自截断，非法 group 一律落「其他」；
- 老数据没有 `group` 字段也能读（落到「其他」），导出升到 `version: 2`，`items` 每条带 `group`；导入兼容 v1 文件与裸数组，**目标组满了算 `skipped`**，不覆盖现有条目；
- 组内调顺序用拖动或 `↑ ↓`，**跨组移动只走行首分组下拉**——拖动同时改分组和顺序，结果很难预期，直接把这条路堵掉；
- 地址栏浮层的置顶行带分组徽标（`工作` / `学习` / `其他`），一眼能看出这条为什么排在这；
- 满组时拒绝文案是具体的：「「工作」最多只能置顶 5 条，先取消一条」。

`nyx:as:pinned` 的返回也扩了：`{ ok, items, groups: [{key,label}], groupMax }`，界面不再自己硬编码中文组名。`nyx:as:pinned-reorder` 支持 `{ group, urls }` 只重排该组占用的位置，其它组顺序不受影响。

### 2.2 抓包慢请求阈值进设置页

原来阈值只活在抓包面板的 `localStorage['nyx:tb:slow-ms']` 里，设置页想统一管理没有入口，换台机器也会丢。现在：

- 主进程落一份 `<userData>\toolbox-prefs.json`（`{ slowMs }`），默认 **1000**，合法范围 **50–10000**；越界/非数字直接返回中文错误，不写盘；
- `nyx:tb:slow-ms` 读（同时下发 `min` / `max` / `fallback`，界面不用猜），`nyx:tb:slow-ms-set` 写；写盘成功后**主动向主窗口广播** `nyx:tb:slow-ms`；
- 设置页新增「抓包慢请求阈值」卡片：输入框（`min`/`max` 同步自 IPC）+ 保存 + 当前值徽标，保存后提示「已保存：耗时 ≥ N ms 记为慢请求」；
- 阈值从此是**单一权威源**：`toolbox-ui.js` 启动时 `nyx.tbSlowMs()` 拉一次、`nyx.onTbSlowMs()` 订阅推送、在面板里改阈值走 `nyx.tbSlowMsSet(ms)` 回写，不再各存一份；`localStorage['nyx:tb:slow-ms']` 降级为**首屏兜底缓存**（主进程读不到时面板仍能用上次的值先渲染）。

### 2.3 更新源占用看板

发版机上的 `updates` / `updates-archive` 很容易涨到 GB 级（历史留档 + 每版 113MB 的安装包），此前只能自己开资源管理器算。设置页新增「更新源占用」：

- `nyx:update:footprint` 返回 `{ ok, version, archiveVersions, updates: {path,bytes,files}, archive: {path,bytes,dirs,files}, total }`；递归统计**不跟随符号链接**，单个条目读不到就跳过、按已统计部分返回，不会因为一个坏文件让整张卡白屏；
- `nyx:update:open-source` 在资源管理器里打开更新源目录；
- `nyx:update:copy-clean-command` 把发版机上的一行清理命令复制到剪贴板：
  `node scripts/make-release.js --clean-updates --target both --keep-n 1 --yes`；
- 应用只读不删：清理仍然只发生在发版机上（避免用户在客户端误删自己的更新源）。

### 2.4 扩展版本历史与回滚 UI

1.15.0 已经有了发布侧的数据形状（`extensions.json` 可带 `history`），但客户端没有入口。本版补上：

- `nyx:ext:online-history`：读更新源 `extensions.json`，把 `history` 摊平成界面能直接渲染的形状，每条带 `current`（是不是更新源当前版）与 `installed`（是不是本机已装版），**只读、不触发下载**；
- `nyx:ext:online-rollback`：`{ key, version }`，走与在线更新**同一条**「下载 → sha256 校验 → installCrx」路径安装历史包；装失败不动已装版本；拒绝回滚到「更新源当前版」（那种情况提示直接用「检查更新」）；
- 设置页「扩展版本历史」卡片：按扩展列出各历史版本、大小与时间，按钮文案按状态在「更新到此版本 / 回滚到此版本 / 已安装」之间切换，回滚前有确认框（明确告知「只替换扩展文件，扩展自己的配置与存储保留」），下载期间按钮禁用并显示「回滚中…」。

要点：**更新源指向哪一版，和本机装了哪一版是两件事**——改 `extensions.json` 只是告诉客户端「当前发布的是哪一版」，客户端「回滚到此版本」才是把旧版真正装到本机。

### 2.5 验收脚本端口修复（本版最容易被误判的一条）

整链回归出现过「地址栏自检全绿、`npm run verify` 里却挂掉两项」，失败文案是 `✘ 主窗口外壳页面出现` / `主窗口未就绪`，一度被当成产品 bug。真因与产品无关，是**端口**：

- 本机 Windows 保留了一段动态端口（`netsh int ipv4 show excludedportrange protocol=tcp`，实测含 **9486–9585**，属 Hyper-V / WinNAT 占位）；
- 验收脚本原先用「基数 + `Math.random()`」挑 `--remote-debugging-port`，命中保留段时 Chromium 起调试服务直接报
  `bind() returned an error: 以一种访问权限不允许的方式做了一个访问套接字的尝试 (0x271D)` 与 `Cannot start http server for devtools.`；
- 主窗口本身起得来，只是没有 CDP，脚本连不上就报「主窗口未就绪」——**假失败**，概率约三分之一（地址栏脚本原来在 9400–9699 里随机构造端口，UI 脚本 9700–9999 偶尔中招）。当时白跑了 3 轮才定位。

修法不是「换个大一点的基数」，而是**让系统分配**：新增 `scripts/lib/free-port.js` 的 `pickFreePort()`，向 `127.0.0.1:0` 监听拿到端口后立即关闭——系统不会把自己保留的端口分配出来，因此一定可绑定。`verify-address-suggest.js`、`verify-ui-polish.js`、`verify-packaged-smoke.js` 三个脚本都在 spawn Electron 前 `PORT = await pickFreePort()`。

> 结论写在这里留给后人：**看到「主窗口未就绪 / 外壳页面未出现」，先查端口（`netsh` 看保留段、看 Chromium 是否打印 0x271D），不要先怀疑产品代码。**

---

## 三、接口与命令速查

| 场景 | 命令 / 接口 |
|---|---|
| 发版 | `npm run dist` → `node scripts/make-release.js --release --prune` |
| 机器可读预演 | `node scripts/make-release.js --release --dry-run --json`（`actions` / `totalBytes`） |
| 客户端回滚入口 | 设置 → 扩展插件 → 扩展版本历史 → 「回滚到此版本」 |
| 一键回归 | `npm run verify`（3 个脚本，见下） |

---

## 四、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（`verify-all.js` / `make-release.js` / `main.js` / `preload.js` / `settings.js` / `addr-suggest.js`） | 全部通过 |
| dry-run JSON | `--release --dry-run --json` | stdout 纯 JSON、`actions = 12`；失败场景 stdout 0 字节、日志全在 stderr |
| 端口修复 | `netsh` 确认保留段 9486–9585 + 三个验收脚本改用 `pickFreePort()` | 地址栏回归 **69/69 稳定全绿**（此前约 1/3 概率假失败） |
| 一键回归 | `npm run verify` | **3/3 脚本全过，122 项断言**（地址栏 69 / 界面体验 44 / 打包冒烟 9） |
| 界面体验 | `verify-ui-polish.js` | **44 项全过**（置顶分组、阈值卡片、占用看板、版本历史与回滚、慢请求面板） |
| 打包冒烟 | `verify-packaged-smoke.js` | 9/9（含扩展仓库可读与在线更新检查；对新构建重跑仍 9/9） |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 三处均为 `66bd45a7…f3a48d`，一致 |

---

## 五、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.16.0.exe`（118,825,505 字节 / 113.3 MB）；`dist\win-unpacked\Nyx.exe` 的 FileVersion = 1.16.0 |
| sha256 | `66bd45a7fe3a1262cf6ab3f90e1a6a60f56ab674e843fadce42b9075ebf3a48d` |
| 更新源 | `%APPDATA%\Nyx\updates`，**5 个文件 / 113.4 MB**：latest.json 1.16.0（size=118825505，sha256 同上，notes 为 1.16.0 中文，以 spawn 参数数组写入、无乱码）、Nyx-Setup-1.16.0.exe 113.32 MB、Nyx-Setup-1.16.0.blocks.json 0.02 MB（227 块 × 0.5 MB） |
| 留档 | `updates-archive\` 只剩 **1.16.0** 一个目录，3 个文件 / 113.4 MB |
| 磁盘回收 | `--clean-updates --target both --keep-n 1 --yes` **实跑（不是预演）**：更新源删 2 个旧文件（Nyx-Setup-1.15.0.exe / .blocks.json），释放 **113.3 MB**；留档删旧目录 1.15.0，释放 **113.5 MB**；合计释放 **226.8 MB** |

---

## 六、已知边界

1. **回滚窗口由更新源决定**（`history` 最多给 3 版）；更早的包只能由发布方另行保留。
2. **更新源指向 ≠ 本机已装**：改 `extensions.json` 只改「当前发布哪一版」，已装扩展不会自己退版，客户端「回滚到此版本」才是真的装旧包。
3. **慢请求阈值已收口，只剩一处极端限制**：唯一权威源是主进程 `<userData>\toolbox-prefs.json`；`toolbox-ui.js` 通过 `nyx.tbSlowMs()` 启动拉一次 + `nyx.onTbSlowMs()` 订阅推送 + 面板修改时 `nyx.tbSlowMsSet(ms)` 回写，`localStorage['nyx:tb:slow-ms']` 降级为**首屏兜底缓存**。已知限制：瀑布区在面板改阈值后由推送即时重绘，但若主进程广播丢失，需等下次打开详情才会用上新值。
4. 置顶分组每组 5 条、总 15 条；导入超限的部分直接跳过（不排队），导入前建议先导出备份。
5. 「更新源占用」每次进设置页都实时扫目录，GB 级更新源首读有几百毫秒、且无缓存；看板是只读的，清理仍需在发版机执行。
6. `pickFreePort()` 只保证「取到端口那一刻可绑定」；同一台机器**并行**跑多个验收脚本仍有极小概率撞端口（脚本不共享端口池）。
7. 安装包仍未做 Authenticode 签名，发布者身份无法验证（与 1.3.1 起的既有限制一致）。
