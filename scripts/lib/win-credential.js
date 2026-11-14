'use strict';

/**
 * 往 Windows 凭据管理器（Credential Manager）里存/取/删一个通用凭据。
 *
 * 为什么要有这一步：自签名证书的私钥密码原先明文写在 `build/signing/password.txt`，
 * 只靠 `.gitignore` 挡着——一旦有人把 `build/` 目录打包发出去、或者备份脚本整目录复制，
 * 密码就跟着走了。凭据管理器是 Windows 自己的加密存储，密钥由当前用户账户派生，
 * 比"一个明文文本文件"强，且仍然是零第三方依赖（走 advapi32 的 CredRead/CredWrite）。
 *
 * 三条硬约束：
 *   1. 密码**绝不进命令行参数**（会出现在进程列表与 shell 历史里），只走环境变量递给子进程；
 *   2. 任何读写失败都必须返回中文原因，不许静默当成"没有密码"；
 *   3. 凭据是**当前用户**级别的（CRED_PERSIST_LOCAL_MACHINE 语义里最贴近用户的那档），
 *      换账户就用不了——这不是缺陷，是刻意的边界。
 */

const { spawnSync } = require('node:child_process');

/** 凭据在凭据管理器里的名字（TargetName）。改它等于换一把锁。 */
const CRED_TARGET = 'Nyx/SelfSignedCodeSigning';
/** CRED_TYPE_GENERIC，通用凭据。 */
const CRED_TYPE_GENERIC = 1;
/** CRED_PERSIST_LOCAL_MACHINE：只有本机该用户能解。 */
const CRED_PERSIST_LOCAL_MACHINE = 2;

/**
 * PowerShell 侧的 P/Invoke 声明。放在一个常量里，读写删共用，
 * 免得多份副本各自漂移（这是本仓库已经踩过的坑）。
 */
const CRED_PS_HEADER = [
  '$ErrorActionPreference = "Stop"',
  '$src = @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class NyxCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public int Flags;',
  '    public int Type;',
  '    public string TargetName;',
  '    public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public int CredentialBlobSize;',
  '    public IntPtr CredentialBlob;',
  '    public int Persist;',
  '    public int AttributeCount;',
  '    public IntPtr Attributes;',
  '    public string TargetAlias;',
  '    public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredWrite(ref CREDENTIAL credential, int flags);',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);',
  '  [DllImport("advapi32.dll", SetLastError = true)]',
  '  public static extern void CredFree(IntPtr buffer);',
  '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
  '  public static extern bool CredDelete(string target, int type, int flags);',
  '}',
  '"@',
  'Add-Type -TypeDefinition $src -Language CSharp | Out-Null',
].join('\n');

function runPowerShell(lines, extraEnv) {
  const script = [CRED_PS_HEADER].concat(lines).join('\n');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}) },
  );
  if (result.error) {
    return { ok: false, error: `没能启动 PowerShell：${result.error.message}`, stdout: '' };
  }
  const stdout = String(result.stdout || '').trim();
  if (result.status !== 0) {
    const detail = String(result.stderr || stdout || '').trim();
    return { ok: false, error: `PowerShell 执行失败（退出码 ${result.status}）：${detail || '没有输出'}`, stdout };
  }
  return { ok: true, error: '', stdout };
}

function lastError() {
  return '[System.ComponentModel.Win32Exception]::new([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message';
}

/**
 * 写入（或覆盖）凭据。密码只通过环境变量进子进程，不进 argv。
 * @returns {{ok: boolean, error: string}}
 */
function writeCredential(secret, target = CRED_TARGET) {
  if (typeof secret !== 'string' || !secret) {
    return { ok: false, error: '要保存的密码是空的，什么都没写。' };
  }
  const lines = [
    '$bytes = [System.Text.Encoding]::Unicode.GetBytes($env:NYX_CRED_SECRET)',
    '$cred = New-Object NyxCred+CREDENTIAL',
    `$cred.Type = ${CRED_TYPE_GENERIC}`,
    '$cred.TargetName = $env:NYX_CRED_TARGET',
    '$cred.UserName = $env:USERNAME',
    `$cred.Persist = ${CRED_PERSIST_LOCAL_MACHINE}`,
    '$cred.CredentialBlobSize = $bytes.Length',
    '$cred.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)',
    '[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $cred.CredentialBlob, $bytes.Length)',
    'try {',
    '  $ok = [NyxCred]::CredWrite([ref]$cred, 0)',
    '  if ($ok) { Write-Output "NYXCRED_WRITTEN=1" }',
    `  else { Write-Output ("NYXCRED_ERROR=" + ${lastError()}) }`,
    '} finally {',
    '  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob)',
    '}',
  ];
  const result = runPowerShell(lines, { NYX_CRED_TARGET: target, NYX_CRED_SECRET: secret });
  if (!result.ok) return { ok: false, error: result.error };
  if (result.stdout.includes('NYXCRED_WRITTEN=1')) return { ok: true, error: '' };
  const matched = /NYXCRED_ERROR=(.+)/.exec(result.stdout);
  return { ok: false, error: `写凭据失败：${matched ? matched[1].trim() : '没有输出'}` };
}

/**
 * 读取凭据。读不到（不存在）不算错误，返回 found:false，由上层决定怎么说。
 * @returns {{ok: boolean, found: boolean, secret: string, error: string}}
 */
function readCredential(target = CRED_TARGET) {
  const lines = [
    '$ptr = [IntPtr]::Zero',
    `if ([NyxCred]::CredRead($env:NYX_CRED_TARGET, ${CRED_TYPE_GENERIC}, 0, [ref]$ptr)) {`,
    '  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NyxCred+CREDENTIAL])',
    '  $bytes = New-Object byte[] $cred.CredentialBlobSize',
    '  if ($cred.CredentialBlobSize -gt 0) {',
    '    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)',
    '  }',
    '  [NyxCred]::CredFree($ptr)',
    '  Write-Output ("NYXCRED_OK=" + [System.Text.Encoding]::Unicode.GetString($bytes))',
    '} else {',
    '  Write-Output "NYXCRED_MISSING=1"',
    '}',
  ];
  const result = runPowerShell(lines, { NYX_CRED_TARGET: target });
  if (!result.ok) return { ok: false, found: false, secret: '', error: result.error };
  if (result.stdout.includes('NYXCRED_MISSING=1')) return { ok: true, found: false, secret: '', error: '' };
  const matched = /NYXCRED_OK=([\s\S]*)$/.exec(result.stdout);
  if (!matched) {
    return { ok: false, found: false, secret: '', error: '凭据管理器的返回看不懂，没有读到密码。' };
  }
  const secret = matched[1].replace(/\r?\n$/, '');
  if (!secret) return { ok: true, found: false, secret: '', error: '' };
  return { ok: true, found: true, secret, error: '' };
}

/** 删除凭据。本来就没有也算成功（幂等），但会如实说是"本来就没有"。 */
function deleteCredential(target = CRED_TARGET) {
  const lines = [
    `if ([NyxCred]::CredDelete($env:NYX_CRED_TARGET, ${CRED_TYPE_GENERIC}, 0)) { Write-Output "NYXCRED_DELETED=1" }`,
    `else { Write-Output ("NYXCRED_NONE=" + ${lastError()}) }`,
  ];
  const result = runPowerShell(lines, { NYX_CRED_TARGET: target });
  if (!result.ok) return { ok: false, removed: false, error: result.error };
  if (result.stdout.includes('NYXCRED_DELETED=1')) return { ok: true, removed: true, error: '' };
  return { ok: true, removed: false, error: '' };
}

module.exports = {
  CRED_TARGET,
  CRED_TYPE_GENERIC,
  deleteCredential,
  readCredential,
  writeCredential,
};
