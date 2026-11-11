---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ae8b309e090bdff87e0581a039937318_91fe99a4b61e11f1a816525400cd780f
    ReservedCode1: K//khxIZAQWw9xnaJ7Q28cxtZ2Rdub5ypxMIbtKkjnNrK2ZCm3+QTE5XJFzDfMfbtKjioqK40Wjnqrwez5HYdClX30ND52bqti+ZraIkFDJsWS3QcYSJntAc3hr1SxKzD6RCGy0ikEci347jc5pcH2vi6QcsGm/7+4L06lWg9m4G5Me19d/tvfusNlo=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ae8b309e090bdff87e0581a039937318_91fe99a4b61e11f1a816525400cd780f
    ReservedCode2: K//khxIZAQWw9xnaJ7Q28cxtZ2Rdub5ypxMIbtKkjnNrK2ZCm3+QTE5XJFzDfMfbtKjioqK40Wjnqrwez5HYdClX30ND52bqti+ZraIkFDJsWS3QcYSJntAc3hr1SxKzD6RCGy0ikEci347jc5pcH2vi6QcsGm/7+4L06lWg9m4G5Me19d/tvfusNlo=
---

# Nyx 1.0.12 合并发版记录

> 生成时间：2026-09-22 上午　|　指令来源：用户手机消息「把目前的待安装全部整合在一起」
> 关联文档：`PROGRESS.md`「二·补 15」、`<版本存档目录>\1.0.12\版本记录-1.0.12.md`

---

## 一、任务口径

把当时**所有已完成但分散的能力**合并进**同一个安装包**统一发版，不再逐项单独投放。

| 项 | 发版前状态 | 本版处理 |
| --- | --- | --- |
| 工具箱「视频」页签 | 1.0.11 已构建并已推更新源 | 并入统一包（代码零改动，仅合并投放） |
| 「墨夜」界面主题 | 交付包在 `<墨夜主题交付目录>`，标注并入 1.0.10 | 因版本已越过 1.0.10，本版首次整合进源码 |
| 其它 | 全盘检索 `<本地工作目录>` 下全部 md，仅上述一项待并入记录 | 无其它遗漏项 |

---

## 二、操作时间线

| 时间 | 动作 | 结果 |
| --- | --- | --- |
| — | 盘点：列 `<本地工作目录>`、检索含「交接 / 整合」的 md，读 `scripts\make-release.js` | 确认待并入项仅墨夜主题一项 |
| — | 主题整合 M1：拷 `theme-nyx.css` 至 `src\renderer\` | 1,141 行 / 28,132 字节 |
| — | M2：`index.html` / `settings.html` 追加样式链接 | 均置于各自基础样式表之后 |
| — | M3：`ui-store.js` 扩枚举与默认值 | `UI_PREF_ENUMS` + `theme: 'ink'` |
| — | M4：`main.js` 加 `THEME_BG`、主窗口与设置窗口底色改动态、`withUi` / `UI_PREF_FALLBACK` 补 theme | 覆写交接文档范围（设置窗口一并补齐） |
| — | M5：`settings.html` / `settings.js` / `settings.css` 加下拉与即时换肤 | `.set-select` 走类样式避 CSP |
| — | M6：`preload.js` 启动前置主题 + `renderer.js` 主窗换肤 | 消除首帧闪色 |
| — | `package.json` version `1.0.11` → `1.0.12` | — |
| — | `node_modules\electron-builder\cli.js --win nsis`（`CSC_IDENTITY_AUTO_DISCOVERY=false`） | 27s，产出 `dist\Nyx-Setup-1.0.12.exe` |
| — | asar 探针 | `theme-nyx.css` 6 / `UI_PREF_ENUMS` 7 / `nyx:tb:video-` 10 / `VIDEO_KIT` 3 / `pref-theme` 3 命中 |
| — | `node scripts\make-release.js` | 推送 `dist\latest.json` + `%APPDATA%\Nyx\updates\{latest.json, exe}` |
| — | 写 `notes-1.0.12.txt` + `patch-notes.js`，回写两份 `latest.json` | 两份 `notes` / `size` / `sha256` 一致（notes 170 字符） |
| — | 打包版真机启动（`NYX_USER_DATA` 隔离目录跑 `win-unpacked\Nyx.exe`） | 5 进程、主窗口出现、首启写出 `ui-preferences.json`（含 `"theme":"ink"`）、回收后残留 0 |
| — | 版本存档：建 `1.0.10\`、`1.0.11\`、`1.0.12\` 并复制 exe + blockmap，取 sha256 | 三版留档就位 |
| — | 写三份 `版本记录-<版本>.md`、刷新存档 `README.md` 总索引 | 覆盖 1.0.0~1.0.12 共 13 版 |

---

## 三、逐文件差异

| 文件 | 状态 | 行数变化 | 要点 |
| --- | --- | --- | --- |
| `src\renderer\theme-nyx.css` | 新增 | 1,141 行 / 28,132 B | 四主题变量表 + 组件覆写，含素纸浅色硬编码专项修正段 |
| `src\renderer\index.html` | 修改 | +2 | 主题样式链接（`style.css` 之后） |
| `src\renderer\settings.html` | 修改 | +19 | 主题样式链接 + 「外观」分区 `#pref-theme` 下拉（四选项） |
| `src\renderer\settings.css` | 修改 | — | `.set-select` / `:focus-visible` 类样式（宽 168px） |
| `src\preload.js` | 修改 | +24 | `applyEarlyTheme` IIFE：启动即写 `dataset.theme`，消除首帧闪色 |
| `src\core\ui-store.js` | 修改 | +32 / −7 | `UI_PREF_ENUMS` 白名单、`theme` 默认 `ink`、`load()` 删非白名单键、`set()` 枚举校验、导出枚举表 |
| `src\main.js` | 修改 | +13 / −4 | `THEME_BG` 映射；主窗口与设置窗口两处 `backgroundColor` 改动态；`withUi` / `UI_PREF_FALLBACK` 补 `theme` |
| `src\renderer\renderer.js` | 修改 | +12 | `applyTheme()`，由 `applyState()` 调用 |
| `src\renderer\settings.js` | 修改 | +22 | 回填 `#pref-theme`、`change` 即时换肤、「恢复默认外观」补 `theme='ink'` |

承自 1.0.11、本版仅合并投放（零改动）：`src\core\toolbox-devtools.js`、`src\main.js`（`nyx:tb:video-*` 五通道）、`src\preload.js`（五方法透传）、`src\renderer\toolbox-ui.js`。

备份对照目录：`<墨夜主题交付目录>\`（含 7 个源文件快照与只读校验脚本）。

---

## 四、验证记录

- **语法自检**：`node --check` 对 `main.js` / `preload.js` / `core\ui-store.js` / `renderer.js` / `settings.js` → **5/5 PASS**
- **ui-store 行为自测**：**14/14 PASS**（老配置补齐 theme、脏类型回落、非白名单键删除、非法主题拒写、`set()` 全分支、枚举表契约）
- **离屏 Electron 冒烟**（真实 html + 真实 CSP）：
  - 四主题 computed 值与 CSS 变量逐一对上：ink `#0c0a09`/`#c8a45c`、aurora `#080b16`/`#4fd6c8`、paper `#f5f1e8`/`#9a6b1f`、quiet `#17181a`/`#6fb3c0`
  - **CSP 未拦 `--grain` data-URI** → 交接文档遗留未知项 **U1 关闭**
  - 焦点可见（quiet 主题 `outline 2px solid rgba(111,179,192,.55)`）→ V7 通过
  - 设置下拉四选项、宽 168px；ink / paper 下设置窗底色正确切换
  - **preload 前置主题生效**：喂 `theme:'paper'` 快照 → `dataset.theme==='paper'` 且首帧底色即 `#f5f1e8` → M6 通过
  - 截图人工复核四张（墨夜暖黑、素纸米白可读、焦点可见、设置页浅色完整）
- **打包版真机启动**：隔离 `NYX_USER_DATA` → 5 进程 / 主窗口 / 首启落 `ui-preferences.json`（`"theme":"ink"`）/ 零报错 / 回收残留 0（未触碰真实 `%APPDATA%\Nyx`）
- **产物一致性**：`dist` 与更新源两份 exe sha256 一致 `187daff44a659bf1de4559ad411ac5f2243a2d163cf6c08ee1831d7fa39cd403`，体积均 98,510,785 B，与两份 `latest.json` 的 `sha256` / `size` 字段一致

---

## 五、产物与投放

| 项 | 值 |
| --- | --- |
| 安装包 | `<项目根目录>\dist\Nyx-Setup-1.0.12.exe` |
| 体积 | 98,510,785 字节（约 93.94 MB） |
| blockmap | 104,140 字节 |
| SHA-256 | `187daff44a659bf1de4559ad411ac5f2243a2d163cf6c08ee1831d7fa39cd403` |
| 构建时间 | 2026-09-22 08:32:50 |
| 更新源 | `%APPDATA%\Nyx\updates\{latest.json, Nyx-Setup-1.0.12.exe}` |
| 版本存档 | `<版本存档目录>\1.0.12\`（exe + blockmap + 版本记录） |

更新说明（用户可见原文）：

> 1.0.12：本次为合并发版——① 新增内置「墨夜」界面主题：墨夜 / 极光 / 素纸 / 静谧 四套配色，设置中心「外观」分区可即时切换并记住选择，窗口出现前的底色随主题同步，浅色主题不再闪深色；② 工具箱新增「视频」页签：视频窗口鼠标随机移动保活（防挂机检测）、倍速解锁最高 16x（含站点改回拦截）、进度条拖动解锁（含锁定不被拽回）。

---

## 六、遗留与备注

- 至 1.0.12，**此前所有已完成待发能力已全部收进同一安装包，无遗留待并入项**。
- 本机安装版仍低于 1.0.12，待应用内「检查更新 → 立即升级」或启动 8 秒后自动检查完成覆盖升级。
- 升级为覆盖安装，订阅 / 偏好（含新增主题选择）/ 密码库跨级保留；旧配置无 `theme` 字段时自动补齐为墨夜，不影响既有用户。
- 更新源内 1.0.7 等旧包均已在版本存档留档，可安全删除。
- 构建注意：`npm run dist` 会静默失败（不产出包），一律改用 `node node_modules\electron-builder\cli.js --win nsis`；`notes` 中文字段不可命令行直传，须脚本 UTF-8 回写（1.0.9 用 python，1.0.12 起用 Node）。

*（内容由AI生成，仅供参考）*
*（内容由AI生成，仅供参考）*
