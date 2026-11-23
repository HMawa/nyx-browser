# 隐私基准快照（privacy baseline）

这个目录放的是**「某个版本、某台机器上跑出来的隐私自检结论」**，用来回答一个很实际的问题：

> 换了新版本之后，隐私伪装是变好了、变差了，还是跟上次一样？

一句话口径：**只存结论，不存真值。**

---

## 1. 一份基准里有什么

```json
{
  "kind": "nyx-privacy-baseline",
  "at": "2026-11-23T06:12:44.183Z",
  "version": "1.19.2",
  "electron": "45.3.2",
  "chromium": "156.0.8078.100",
  "identity": "隐私",
  "kernelRunning": true,
  "counts": { "leak": 0, "suspect": 0, "unknown": 4, "masked": 3, "pass": 9 },
  "rows": [
    {
      "id": "A1",
      "level": "masked",
      "title": "浏览器标识（User-Agent）",
      "reason": "页面上报的是伪装后的完整版本号，真实版本是 —（已隐藏）。"
    }
  ]
}
```

- `id` / `level` / `title` / `reason` 是**结论**：这一项测了什么、判成什么、为什么。
- **没有** `observed`（页面看到的值）与 `truth`（主进程取到的真实值）：生成时就被抹成 `—（已隐藏）`。
- 理由句里的具体值（IPv4 / IPv6 / 24 位以上十六进制串 / 已知真值）也会被替换，
  所以整份文件可以入库、可以贴给别人看。

`parseBaseline()` 是入库守卫：文件里只要出现 `observed` 或 `truth` 字段、或 `kind` 不对，**直接拒绝读取**，
而不是「悄悄忽略那个字段」——后者会让人以为基准是干净的。

---

## 2. 怎么生成

```powershell
node scripts/privacy-baseline.js                # 跑一次，写 docs/privacy-baseline/<日期>.json
node scripts/privacy-baseline.js --dry-run      # 只跑不写
node scripts/privacy-baseline.js --check        # 校验最新一份干净（无 IP / 无长哈希 / 无真实 UA 串）
node scripts/privacy-baseline.js --raw          # 额外写 temp/privacy-baseline/<日期>-raw.json（含真值，不入库）
node scripts/privacy-baseline.js --keep 6       # 归档轮换：只留最近 6 份
```

必要条件：**本机代理得是通的**（隐私模式切换要求代理可达；代理不通会报
「无法连接本机代理 …为避免真实 IP 泄漏，本次切换已被拒绝」，这是设计如此，不是 bug）。

生成时会顺手把同一份文件同步到用户数据目录
（`<NYX_USER_DATA 或 %APPDATA%\Nyx>/privacy-baseline/<日期>.json`），
因为安装包里只打 `src/**`、没有 `docs/`，设置页要能读到就得有一份在用户目录里。

---

## 3. 怎么对照

设置页 →「隐私与安全」→「隐私自检」跑完一次之后，表格下面那一栏就是对照结果：

- `与基准完全一致（16 项）`
- `A1 已伪装 → 泄漏`（结论变了，逐项说清从什么变成什么）
- `C1 基准里有、这一次没有（正常）`（这一版没测这一项，单列，不当成"没变化"）
- `B2 新增（测不到）`
- `还没有对照基准：在仓库里跑 node scripts/privacy-baseline.js`

**没有分数，也没有及格线**：基准是"上次是怎么判的"，不是"应该怎么判"。

---

## 4. 轮换规则

- 文件名是 `YYYY-MM-DD.json`，字符串倒序即时间倒序。
- 默认最多留 **12** 份（`MAX_BASELINES`），`--keep N` 可覆盖；删掉哪份会打印出来。
- 同一台机器同一天跑多次，后一次覆盖前一次（保持目录可读）。

---

## 5. 这份东西的边界

| 能证明 | 不能证明 |
| --- | --- |
| 这一版在这台机器上，16 项分别判成什么 | 换一台机器/换一个出口会不会一样 |
| 跟上一次相比哪几项结论变了 | "变好"到底是哪一段代码带来的（要配合 git bisect） |
| 基准文件里没有真值（含入库守卫） | 自检本身没漏测的面（TLS 指纹、HTTP/2 帧序、DNS 出口都不在范围内） |

DNS 出口永远显示「测不到」：自检不去向第三方要答案，这条从 1.18.0 起就是这样写的。
