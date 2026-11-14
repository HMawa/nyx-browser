# Nyx 代码签名说明（自签名）

> 这份文档只讲一件事：**怎么让 Windows 认得出「这个安装包是同一把私钥签的」，以及为什么它仍然不能证明「这是 Nyx 官方发布的」。**
> 两者搞混，用户就会被一句「已签名」骗过去，所以边界写在最前面。

---

## 1. 现在是什么状态

- 发布出去的安装包（`dist/Nyx-Setup-<版本>.exe`）由 `npm run dist` 产出，**未签名**。Windows 会显示「未知发布者」，SmartScreen 可能拦一道。
- 仓库里新增了另一条打包路径 `npm run dist:signed`：它用**本机生成的自签名证书**给 `Nyx.exe` 与安装包签名，默认输出到 `dist-sign/`，不覆盖已发布的 `dist/`。
- 证书不进仓库：私钥、证书、密码都在 `build/signing/`（已被 `.gitignore` 忽略）。换一台机器要重新生成，签名指纹也就变了。
- **本机已实跑过一次**（2026-11-14）：`node scripts/build-signed.js` → `dist-sign\Nyx-Setup-1.17.3.exe` **127,166,232 字节**，`Get-AuthenticodeSignature` 结果为 `Status=Valid`、`Subject=CN=Nyx Self-Signed, O=Nyx contributors, OU=local build`、指纹 `256F208A5D31782DAF9DA041CF1D7A2A382931D0`；同一个脚本对未签名文件跑出来是 `Status=NotSigned`（所以「验过」不是空话）。

## 2. 自签名能证明什么、不能证明什么

**能证明：**
- 这个文件从签名之后**一个字节都没被改过**（改了就验不过）。
- 这个文件是**持有这张证书私钥的机器**签出来的（同一台机器再打包，指纹一致）。

**不能证明：**
- **不能证明发布者身份**。自签名证书不受任何证书颁发机构背书，别人也能生成一张叫「Nyx」的自签名证书。
- 别人的电脑上默认**仍然**会提示「未知发布者」，只有在那台机器上手动信任同一张证书之后才不提示。
- 自签名换不来 SmartScreen 的信誉积累。想彻底消除提示，只能买公信代码签名证书（EV 证书还要硬件令牌）。

所以：自签名解决的是「包有没有被篡改」和「本机一致性」，**不是**「你是谁」。文档与界面都不能把这两件事混着说。

## 3. 生成证书（只做一次）

```powershell
# 生成：RSA 3072 / SHA-256 / 5 年 / 代码签名用途
node scripts/make-signing-cert.js

# 生成并信任（只写当前用户存储，不需要管理员）
node scripts/make-signing-cert.js --trust

# 只看现有证书（指纹 / 到期 / Subject）
node scripts/make-signing-cert.js --status

# 重新生成（旧证书签出去的包会验不过，谨慎）
node scripts/make-signing-cert.js --force
```

生成后 `build/signing/` 里会出现：

| 文件 | 用途 | 能不能外传 |
| --- | --- | --- |
| `nyx-self-signed.pfx` | 私钥 + 证书（打包时用） | **绝对不能** |
| `nyx-self-signed.cer` | 公钥证书（给别的机器信任用） | 可以，但只该给自己的机器 |
| `password.txt` | 私钥密码（打包脚本读） | **绝对不能** |

密码由脚本随机生成，全程只通过环境变量交给 electron-builder，不进命令行参数（否则会出现在进程列表与 shell 历史里）。

## 4. 信任证书（在**要安装的那台**机器上做）

如果只是本机自用：

```powershell
node scripts/make-signing-cert.js --trust
```

或者手动：

```powershell
certutil -addstore -user Root "build\signing\nyx-self-signed.cer"
certutil -addstore -user TrustedPublisher "build\signing\nyx-self-signed.cer"
```

- `Root`：让系统把它当成一个可信任的根（决定「这条链能不能成立」）。
- `TrustedPublisher`：让系统把这张证书的签名者当成「受信任的发布者」（决定「要不要弹未知发布者」）。
- 两个都**只写当前用户**（`-user`），不动系统级存储，不需要管理员，也不会影响这台机器上的其他账户。

撤销信任：

```powershell
certutil -delstore -user Root "<指纹>"
certutil -delstore -user TrustedPublisher "<指纹>"
```

指纹用 `node scripts/make-signing-cert.js --status` 查。

## 5. 打带签名的包

**打包前会先查证书有没有过期**（`scripts/build-signed.js` 的 `assertCertUsable()`）：

- 已过期 → 直接停下，不打包。过期证书签出来的包，Windows 一律当无效签名，比不签更糟（用户会以为是自己下载坏了）。
- 还剩 ≤ 30 天 → 打印提醒后继续打包（到期前记得重生成）。
- 读不出到期时间 → 同样停下。**读不到不等于没过期**，不许当成有效放过。

随时可以查剩余有效期：

```powershell
node scripts/make-signing-cert.js --status
#   有效期：自签名证书还有 1825 天有效（到 2031-11-14）。
```

到期后重新生成一张（旧签名随之失效，已发出去的包仍然能装，但签名链断了）：

```powershell
node scripts/make-signing-cert.js --force
node scripts/make-signing-cert.js --trust
```

```powershell
# 输出到 dist-sign（默认，不碰已发布的 dist）
npm run dist:signed

# 想直接进 dist（发布用，注意会覆盖已发布的同名包）
npm run dist:signed -- --config.directories.output=dist
```

打完脚本会自动跑一次验签；验不过就直接失败，**不会**留下一个「以为签了其实没签」的包。

## 6. 验证签名

```powershell
# 自动找 dist-sign / dist 里的安装包
node scripts/verify-signing.js

# 指定文件
node scripts/verify-signing.js --artifact=dist\Nyx-Setup-1.17.4.exe

# 没打签名包时只想跑静态守卫
node scripts/verify-signing.js --no-artifact
```

也可以直接看：

```powershell
Get-AuthenticodeSignature "dist-sign\Nyx-Setup-1.17.4.exe" | Format-List Status, SignerCertificate
```

`Status` 必须是 `Valid`。`UnknownError` / `NotSigned` / `HashMismatch` 都不算签好。脚本里已经写死这一点：Status 不是 Valid 一律判失败。

## 7. SmartScreen 与「未知发布者」

| 场景 | 用户看到什么 | 原因 |
| --- | --- | --- |
| 未签名包 | 「未知发布者」+ SmartScreen 可能拦 | 完全没有签名 |
| 本机自签名 + 本机信任 | 不提示 | 证书在受信任的根与发布者里 |
| 本机自签名 + 未信任 | 仍然「未知发布者」 | 别人的电脑不认识这张证书 |
| 公信证书（OV） | 一般不再提示未知发布者，SmartScreen 仍需信誉积累 | 有 CA 背书 |
| 公信证书（EV） | 一开始就有较高信誉 | 硬件令牌 + 更严审核 |

**不要**为了少一次提示，就教用户「关掉 SmartScreen」或者「点『仍要运行』就行」。正确做法是把证书给用户、让用户自己决定要不要信任，并且说清信任的后果。

## 8. 什么时候该换成公信证书

满足任一条件就该换：

1. 要发给**不特定的人**下载（自签名对每个新用户都是一次「未知发布者」）。
2. 要过企业/学校的软件白名单（多数白名单只认 CA 背书的证书）。
3. 需要 SmartScreen 信誉（自签名永远积累不到）。

换的时候只需要改打包环境变量：`CSC_LINK` 指向新的 PFX / 或者用 `WIN_CSC_LINK`、`CSC_KEY_PASSWORD` 给密码，`scripts/build-signed.js` 不用改。

## 9. 已知限制

- 自签名证书**不被时间戳服务认可**，所以本仓库的签名不带时间戳；证书过期后，过期前签的包也会一起验不过。到期前用 `--force` 重新签并重新打包。
- 只签 `Nyx.exe` 与安装包本身；`node_modules` 里的原生模块不在签名范围内。
- 签名不改变安装包体积以外的任何行为，也不影响 `--verify-integrity`（那是另一套自校验，两者互不替代）。
