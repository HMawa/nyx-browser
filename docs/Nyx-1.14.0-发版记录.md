# Nyx 1.14.0 · 发版记录

> 版本：**1.14.0**（上一版 1.13.0，同日 2026-10-21）
> 源码树：`<项目根目录>`　安装版：`<安装目录>`（仍为 1.2.9；用户当前实际在跑 `dist\win-unpacked`（1.13.0），建议升到 1.14.0）
> 更新源：`%APPDATA%\Nyx\updates`　留档：`updates-archive\1.14.0\`
> 本次工作：安装包与回归验证维护（Nyx 侧无对外功能变更）

---

## 一、变更清单

| # | 事项 | 类型 | 文件 |
|---|---|---|---|
| 1 | 验证扩容：界面体验断言 38 → **39** | 验证资产 | `scripts/verify-ui-polish.js` |

---

## 二、验收记录

| 项目 | 方法 | 结果 |
|---|---|---|
| 语法 | `node --check`（main / preload / settings / verify 脚本） | 全部通过 |
| 一键回归 | `npm run verify` | **3/3 脚本、112 项断言全过（64 + 39 + 9）** |
| 打包冒烟 | `verify-packaged-smoke.js --exe dist-next\…` | 9/9 |
| 发版一致性 | dist / 更新源 / 留档三处 sha256 | 一致（`89224c28…3bca`） |

---

## 三、发版记录

| 项 | 值 |
|---|---|
| 安装包 | `dist\Nyx-Setup-1.14.0.exe`（118,766,285 字节 / 113.2MB） |
| sha256 | `89224c2802ef31a3015106c37ec4423099aa5f21f9ac7c360266a3079f203bca` |
| 更新源 | latest.json 1.14.0 + exe + blocks |
| 留档 | `updates-archive\1.14.0\`（保留集：1.14.0、1.13.0、1.12.0） |

> 构建备注：本次构建时用户的 `dist\win-unpacked` 正在运行（占用 d3dcompiler 等文件），因此改用
> `npx electron-builder --win nsis --config.directories.output=dist-next` 构建到 `dist-next\`，
> 再把安装包复制进 `dist\` 发版；`dist\win-unpacked` 仍是被占用的旧构建，下次关闭应用后重新 `npm run dist` 即可刷新。
