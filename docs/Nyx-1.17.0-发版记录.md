# Nyx 1.17.0 发版记录 · 傻瓜式安装向导与完整性校验

- 日期：2026-11-11
- 版本：1.17.0（上一版 1.16.0）
- 安装包：`Nyx-Setup-1.17.0.exe`，118,754,042 字节（约 113.2 MB），SHA256 `E2A4DAB25BA4A278CB65B55CEEF67997CF5B48989719C32201B44FADC299CC52`
- 解包产物：`Nyx.exe` 238,909,440 字节
- 主题：把「下载完双击、一路下一步」这条最容易被劝退的路铺平——安装前先体检环境，装完给一份可回看的报告，装错了能就地修复，装脏了能连数据一起清干净，并且每次安装都自动核对随包文件有没有被篡改。

## 一、这版解决什么问题

旧安装器是 electron-builder 默认模板：用户双击、选目录、装完，中间不告诉他系统够不够、盘剩多少、内核在不在；装坏了只能手动删目录；卸载后残留与个人数据的关系不清楚。1.17.0 把安装过程做成一条可解释的链路：**检查 → 选择 → 安装 → 校验 → 报告 → （升级/修复/卸载）**。

## 二、变更

| # | 事项 | 类型 | 说明 |
|---|---|---|---|
| 1 | 安装环境检查页 | 新增 | 目录页之后插入一页体检：系统版本、架构、目标盘剩余空间、目标目录写权限、旧版本、安装包完整性、内核文件、卸载命令；每项给出 ✔ / ! / ✘ 与可执行建议，存在阻断项时「安装」按钮置灰 |
| 2 | 依赖推荐下载 | 新增 | 检查页提供 mihomo 内核与 geo 规则集的发布页链接（`ExecShell`），不静默下载，用户在浏览器里自行决定 |
| 3 | 安装报告 | 新增 | 安装完成写入 `%APPDATA%\Nyx\install-report.txt`（UTF-16LE + BOM）；完成页提供「查看安装报告」；字段含安装模式、安装目录、系统版本/架构、盘剩余、旧版本、内核版本、完整性结论、卸载命令 |
| 4 | 升级 / 修复 / 降级 判定 | 新增 | 读卸载注册表键的 `DisplayVersion` 与 `InstallLocation` 判断：无旧版=全新安装；旧版更低=升级安装；同版本=修复安装；旧版更高=降级安装。**任何模式下都不删 `%APPDATA%\Nyx`** |
| 5 | 完整性清单 | 新增 | 构建期 `build/after-pack.js`（afterPack 钩子）为 `resources/app.asar`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`vendor/**`、`licenses/**` 计算 SHA256，写 `resources/integrity.json`；缺失必需项直接让构建失败 |
| 6 | `Nyx.exe --verify-integrity` | 新增 | 不建窗口、不加载渲染进程，纯哈希比对；全通过 exit 0，缺失/不符 exit 1；`--report=<路径>` 输出中文明细；开发态无清单时明确「跳过校验，exit 0」，可用 `NYX_INTEGRITY_ROOT` 指向解包产物 |
| 7 | 安装期自动校验 | 新增 | `customInstall` 里 `ExecWait` 调 `--verify-integrity`，结论写进安装报告；检测到环境变量 `ELECTRON_RUN_AS_NODE` 时在安装器进程内临时清除后再调用（否则 Nyx.exe 被当纯 Node 解释器，校验返回 9） |
| 8 | 完全卸载 | 新增 | 卸载时询问是否删除个人数据；静默卸载支持 `/DELETEAPPDATA`（同时清 `%APPDATA%\Nyx` 与 `%LOCALAPPDATA%\Nyx`）；普通 `/S` 卸载只删程序与快捷方式，保留个人数据 |
| 9 | 卸载残留修复 | 修复 | 模板 `un.onInit` 的 `SetOutPath $INSTDIR` 让卸载器的工作目录停在安装目录，Windows 不允许删除当前目录，导致空目录残留；`customUnInit` 首行改为 `SetOutPath "$TEMP"` 后消除 |
| 10 | 端到端测试 | 新增 | `scripts/test-installer-e2e.js`：静默全新安装 → 覆盖修复 → 卸载保数据 → `/DELETEAPPDATA` 完全卸载，四项断言链 + 末尾汇总；测试前备份并还原真实用户数据与注册表键 |
| 11 | 安装文档 | 新增 | `docs/installer.md`：检查项、四种模式、自定义目录、静默开关、完整性三层校验、卸载语义、故障排查表 |
| 12 | 回归扩容 | 修改 | 打包冒烟从 9 项扩到 11 项（随包 `integrity.json`、`--verify-integrity` 退出 0）；`npm run verify` 单步超时上调 |

## 三、验收

| 项 | 结果 |
|---|---|
| 构建 | `electron-builder --win nsis --config.directories.output=dist-inst` EXIT=0；afterPack 日志「完整性清单已生成：integrity.json（9 个文件，版本 1.17.0，算法 sha256）」 |
| 静默安装 | `/S /D=<临时目录>` exit 0；报告「安装模式：全新安装」「完整性检测：通过（退出码 0）」；BOM=`FF FE` |
| 修复安装 | 同包重装 exit 0，报告「修复安装（同版本覆盖，个人数据保留）」，预置标记文件 mtime 未变 |
| 完整性 | 正常产物脚本 9/9 exit 0；人为改 1 字节后脚本与 `Nyx.exe` 均 exit 1 并指出文件名与期望/实际哈希；恢复后 exit 0 |
| 卸载 | `/S` 卸载：目录、卸载键、安装键、桌面与开始菜单快捷方式全清，`%APPDATA%\Nyx` 保留；`/S /DELETEAPPDATA`：程序目录与两处数据目录全清 |
| 交互路径 | 检查页 8 项读控件文本核对；目标目录设为不可写路径后出现 ✘ 且「安装」按钮 `IsWindowEnabled=False`；「重新检测」可刷新 |
| 回归 | `npm run verify` 三脚本通过（地址栏 + 界面体验 + 打包冒烟 11 项） |
| 体积 | 安装包 113.2 MB（+0.05 MB，随包多出 integrity.json 与报告逻辑） |

## 四、坑与决策

1. **卸载注册表键是 UUID，不是 appId**：electron-builder 的卸载键为 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ae30b98a-8a1a-5223-86c6-e808d0ff0ca1`（`UUID.v5("com.nyx.browser", EB_NS_UUID)`），`DisplayVersion` / `InstallLocation` 都在此。检查页与脚本按 appId 找键会永远判成「全新安装」。
2. **`-WX` 让警告变致命**：electron-builder 给 makensis 传 `-WX`，6001（变量未引用）与 6010（函数未引用）直接失败；安装器与卸载器是两个编译 pass，所以自定义变量/函数必须分别用 `!ifndef BUILD_UNINSTALLER` / `!ifdef BUILD_UNINSTALLER` 包裹，只在一侧使用的东西不能定义在公共区。
3. **`ELECTRON_RUN_AS_NODE=1` 会毁掉完整性检测**：该变量让 `Nyx.exe` 当纯 Node 跑，`--verify-integrity` 变成非法参数、退出码 9，报告里会出现「完整性检测未通过」的假警报。安装器已在进程内临时清除；自动化测试同样需要剔除该变量。
4. **静默 `/D=` 的语义**：`/D=<目录>` 就是最终安装目录，不会追加 `Nyx` 子目录，且必须是最后一个参数、不能加引号——文档按实测语义写，别照抄某些模板说明。
5. **完整性清单不是信任根**：`integrity.json` 与文件同处一个安装目录，攻击者可以整体替换，只能防传输/解包损坏与误改；要防伪造得引入签名，本版未做（已在文档中写明边界）。

## 五、升级建议

- 从 1.16.0 升级：直接运行 1.17.0 安装包，安装器判定为「升级安装」，个人数据（书签、历史、保险库、设置）全部保留；装完可在完成页看报告确认「完整性检测：通过」。
- 之前手工装过、目录已删但注册表残留的机器：安装器会按 `InstallLocation` 找不到程序时回落到「全新安装」，不会报错。
- 卸载想连数据一起清：交互式卸载勾选删除个人数据，或用 `Uninstall Nyx.exe /S /DELETEAPPDATA`。
