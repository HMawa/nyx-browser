; ============================================================================
;  Nyx 安装器扩展脚本（electron-builder NSIS include）
;
;  由 package.json → build.nsis.include 引入。electron-builder 会把它注入在
;  所有 NSIS 模板之前，所以这里只能依赖编译期 -D 定义
;  （${PRODUCT_FILENAME} / ${APP_FILENAME} / ${VERSION} / ${PROJECT_DIR} 等）
;  和 NSIS 标准 Include，不能使用 common.nsh / multiUser.nsh 里稍后才会
;  定义的符号（例如 ${INSTALL_REGISTRY_KEY}、${APP_EXECUTABLE_FILENAME}）。
;
;  本文件负责：
;   1. 环境检查页（位于目录页之后、安装页之前）
;   2. 依赖下载指引（只给链接，不内置任何下载逻辑）
;   3. 安装报告（UTF-16LE + BOM，写入 %APPDATA%\Nyx\install-report.txt）
;   4. 升级 / 修复安装识别（绝不删除 %APPDATA%\Nyx）
;   5. 完整性自检调用（由应用自身实现，失败只记录，不中断安装）
;   6. 卸载：可选同时删除个人数据（静默卸载用 /DELETEAPPDATA）
;   7. 静默开关：安装 /S、/D=目标目录（/D 必须是最后一个参数）；卸载 /S
;
;  维护提示：NYX_KERNEL_VERSION 必须与 vendor\mihomo\VERSION.txt 同步更新。
; ============================================================================

!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

; ---------------------------------------------------------------------------
; 常量定义
; ---------------------------------------------------------------------------

; 依赖下载链接（检查页「打开依赖下载页」按钮使用）
!define NYX_URL_WINDOWS "https://www.microsoft.com/software-download/windows11"
!define NYX_URL_KERNEL  "https://github.com/MetaCubeX/mihomo/releases"

; 随安装包附带的 mihomo 内核版本（与 vendor\mihomo\VERSION.txt 保持一致）
!define NYX_KERNEL_VERSION "v1.19.31"

; 检查阈值
!define NYX_MIN_BUILD   17763   ; Windows 10 1809：低于此版本阻断安装
!define NYX_REC_BUILD   19041   ; Windows 10 2004：低于此版本只提醒
!define NYX_MIN_DISK_MB 1536    ; 1.5 GB：低于此数值阻断安装
!define NYX_REC_DISK_MB 2560    ; 2.5 GB：低于此数值只提醒

; 检查结果三态
!define NYX_ST_OK    3
!define NYX_ST_WARN  2
!define NYX_ST_BLOCK 1

; 旧版本信息所在的注册表键（与 electron-builder 模板写入的键一致；
; 注意这里不是 appId，而是由 appId 生成的 GUID）
!define NYX_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
!define NYX_INSTALL_KEY   "Software\${APP_GUID}"

; 完成页：提供「查看安装报告」复选框
!define MUI_FINISHPAGE_SHOWREADME "$APPDATA\Nyx\install-report.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看安装报告"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

; 完成页提醒文案（运行时展开变量）
!define MUI_FINISHPAGE_TEXT "Nyx 已安装完成。$\r$\n$\r$\n安装报告：$APPDATA\Nyx\install-report.txt$\r$\n提醒：升级或修复安装不会删除个人数据（书签、历史、设置、扩展），卸载时也可以自动选择保留。"

; ---------------------------------------------------------------------------
; 全局变量
; ---------------------------------------------------------------------------

; 卸载器专用变量（customUnInit / customUnInstall 在卸载器编译过程中展开）
!ifdef BUILD_UNINSTALLER
Var nyxDeleteUserData
!endif

; 以下变量只属于安装器侧（环境检查页 / 安装报告），卸载器编译时不声明，
; 否则会被 -WX 判为「变量未使用」
!ifndef BUILD_UNINSTALLER
Var nyxOsName
Var nyxOsBuild
Var nyxOsStatus
Var nyxArchText
Var nyxArchStatus
Var nyxDirStatus
Var nyxDiskFreeMb
Var nyxDiskStatus
Var nyxDiskText
Var nyxKernelStatus
Var nyxKernelPost
Var nyxRunning
Var nyxOldVersion
Var nyxOldInstall
Var nyxMode
Var nyxModeDetail
Var nyxModeStatus
Var nyxBlockers
Var nyxWarnings
Var nyxIntegrityExit
Var nyxIntegrityText
Var nyxPageText
Var nyxLine
Var nyxMark
Var nyxTextCtrl
!endif

; ---------------------------------------------------------------------------
; 小工具函数
; 说明：这些函数只被安装器（含环境检查页与安装报告）使用，卸载器编译过程
; （BUILD_UNINSTALLER）里没有任何页面或安装宏引用它们，若不隔离会被 -WX
; 判为「未引用的函数」而编译失败，所以整块包在条件里。
; ---------------------------------------------------------------------------
!ifndef BUILD_UNINSTALLER

; 数字补零到两位：输入 $0，输出 $0
Function nyxPad2
  StrLen $1 $0
  ${If} $1 == 0
    StrCpy $0 "00"
  ${ElseIf} $1 == 1
    StrCpy $0 "0$0"
  ${EndIf}
FunctionEnd

; 生成时间戳：输出 $0 = "YYYY-MM-DD HH:MM:SS"
Function nyxTimestamp
  ${GetTime} "" "L" $R7 $R6 $R5 $R4 $R3 $R2 $R1
  ; $R7=日 $R6=月 $R5=年 $R4=星期英文 $R3=时 $R2=分 $R1=秒
  StrCpy $0 $R6
  Call nyxPad2
  StrCpy $R6 $0
  StrCpy $0 $R7
  Call nyxPad2
  StrCpy $R7 $0
  StrCpy $0 $R3
  Call nyxPad2
  StrCpy $R3 $0
  StrCpy $0 $R2
  Call nyxPad2
  StrCpy $R2 $0
  StrCpy $0 $R1
  Call nyxPad2
  StrCpy $R1 $0
  StrCpy $0 "$R5-$R6-$R7 $R3:$R2:$R1"
FunctionEnd

; 状态码转标记符号：输入 $0，输出 $0
Function nyxMarker
  ${If} $0 == ${NYX_ST_BLOCK}
    StrCpy $0 "✘"
  ${ElseIf} $0 == ${NYX_ST_WARN}
    StrCpy $0 "⚠"
  ${Else}
    StrCpy $0 "✔"
  ${EndIf}
FunctionEnd

; 向检查页文本追加一行（$nyxMark + $nyxLine）
Function nyxAddLine
  StrCpy $nyxPageText "$nyxPageText$nyxMark $nyxLine$\r$\n"
FunctionEnd

; 向安装报告追加一行（$R1 为文件句柄，$R2 为文本）
Function nyxReportLine
  FileWriteUTF16LE $R1 "$R2$\r$\n"
FunctionEnd

; ---------------------------------------------------------------------------
; 环境检测
; ---------------------------------------------------------------------------

; 系统版本：名称 + 内部版本号
Function nyxDetectOs
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "ProductName"
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "DisplayVersion"
  ${If} $0 == ""
    StrCpy $0 "Windows"
  ${EndIf}
  ${If} $2 != ""
    StrCpy $0 "$0 $2"
  ${EndIf}
  ${If} $1 == ""
    StrCpy $1 "0"
  ${EndIf}
  StrCpy $nyxOsName $0
  StrCpy $nyxOsBuild $1
  ${If} $1 < ${NYX_MIN_BUILD}
    StrCpy $nyxOsStatus ${NYX_ST_BLOCK}
  ${ElseIf} $1 < ${NYX_REC_BUILD}
    StrCpy $nyxOsStatus ${NYX_ST_WARN}
  ${Else}
    StrCpy $nyxOsStatus ${NYX_ST_OK}
  ${EndIf}
FunctionEnd

; 系统架构：只支持 64 位；ARM64 上以 x64 模拟运行，可用但会提醒
Function nyxDetectArch
  ${If} ${RunningX64}
    ${If} ${IsNativeARM64}
      StrCpy $nyxArchText "ARM64（通过 x64 模拟运行，可用但性能较低）"
      StrCpy $nyxArchStatus ${NYX_ST_WARN}
    ${ElseIf} ${IsNativeAMD64}
      StrCpy $nyxArchText "x64（64 位，推荐）"
      StrCpy $nyxArchStatus ${NYX_ST_OK}
    ${Else}
      StrCpy $nyxArchText "64 位（架构识别为兼容模式）"
      StrCpy $nyxArchStatus ${NYX_ST_OK}
    ${EndIf}
  ${Else}
    StrCpy $nyxArchText "32 位（本安装包仅支持 64 位系统）"
    StrCpy $nyxArchStatus ${NYX_ST_BLOCK}
  ${EndIf}
FunctionEnd

; 目标目录写权限：建目录 + 写临时文件 + 删除
Function nyxDetectDir
  StrCpy $nyxDirStatus ${NYX_ST_OK}
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors nyx_dir_bad
  ClearErrors
  FileOpen $0 "$INSTDIR\.nyx-write-test" w
  IfErrors nyx_dir_bad
  FileWrite $0 "nyx"
  FileClose $0
  ClearErrors
  Delete "$INSTDIR\.nyx-write-test"
  Goto nyx_dir_done
  nyx_dir_bad:
    StrCpy $nyxDirStatus ${NYX_ST_BLOCK}
  nyx_dir_done:
FunctionEnd

; 目标盘剩余空间（MB）
Function nyxDetectDisk
  StrCpy $nyxDiskStatus ${NYX_ST_OK}
  StrCpy $nyxDiskFreeMb "-1"
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == ""
    ; 网络路径 / 无法识别的根目录：只提醒，不阻断
    StrCpy $nyxDiskText "无法检测（网络路径或受限目录）"
    StrCpy $nyxDiskStatus ${NYX_ST_WARN}
    Return
  ${EndIf}
  ${DriveSpace} "$0" "/D=F /S=M" $1
  ${If} $1 == ""
    StrCpy $nyxDiskText "无法检测（磁盘读取失败）"
    StrCpy $nyxDiskStatus ${NYX_ST_WARN}
    Return
  ${EndIf}
  StrCpy $nyxDiskFreeMb $1
  StrCpy $nyxDiskText "$1 MB（需要至少 ${NYX_MIN_DISK_MB} MB）"
  ${If} $1 < ${NYX_MIN_DISK_MB}
    StrCpy $nyxDiskStatus ${NYX_ST_BLOCK}
  ${ElseIf} $1 < ${NYX_REC_DISK_MB}
    StrCpy $nyxDiskStatus ${NYX_ST_WARN}
  ${Else}
    StrCpy $nyxDiskStatus ${NYX_ST_OK}
  ${EndIf}
FunctionEnd

; 内核依赖：编译期已知是否随包附带；若目标目录里已有旧版本，再核对文件是否完整
Function nyxDetectKernel
  StrCpy $nyxKernelStatus ${NYX_ST_OK}
!if /FileExists "${PROJECT_DIR}\vendor\mihomo\mihomo.exe"
  ; 打包配置里内核随包附带
!else
  StrCpy $nyxKernelStatus ${NYX_ST_WARN}
!endif
  ; 修复/升级场景：已安装目录里存在 app.asar 但缺少内核 → 提醒用户重新下载完整安装包
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    ${IfNot} ${FileExists} "$INSTDIR\resources\vendor\mihomo\mihomo.exe"
      StrCpy $nyxKernelStatus ${NYX_ST_WARN}
    ${EndIf}
  ${EndIf}
FunctionEnd

; 是否有 Nyx 正在运行（安装/卸载前需要先关闭）
Function nyxDetectRunning
  StrCpy $nyxRunning "0"
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${PRODUCT_FILENAME}.exe" /NH | find /I "${PRODUCT_FILENAME}.exe" >nul'
  Pop $0
  Pop $1
  ${If} $0 == "0"
    StrCpy $nyxRunning "1"
  ${EndIf}
FunctionEnd

; 旧版本检测：全新安装 / 升级安装 / 修复安装 / 降级安装
; 说明：升级时 electron-builder 会先调用旧卸载器，注册表里的版本信息会消失，
;       所以必须在 customInit（.onInit 阶段）就采集好。
Function nyxUpdateMode
  StrCpy $nyxOldVersion ""
  StrCpy $nyxOldInstall ""

  ; 先看当前用户，再看所有用户（两种安装模式都兼容）
  ReadRegStr $0 HKCU "${NYX_UNINSTALL_KEY}" "DisplayVersion"
  ReadRegStr $1 HKCU "${NYX_UNINSTALL_KEY}" "InstallLocation"
  ReadRegStr $2 HKCU "${NYX_INSTALL_KEY}" "InstallLocation"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${NYX_UNINSTALL_KEY}" "DisplayVersion"
  ${EndIf}
  ${If} $1 == ""
    ReadRegStr $1 HKLM "${NYX_UNINSTALL_KEY}" "InstallLocation"
  ${EndIf}
  ${If} $2 == ""
    ReadRegStr $2 HKLM "${NYX_INSTALL_KEY}" "InstallLocation"
  ${EndIf}
  ${If} $1 != ""
    StrCpy $nyxOldInstall $1
  ${Else}
    StrCpy $nyxOldInstall $2
  ${EndIf}

  ${If} $nyxOldVersion == ""
  ${AndIf} $0 != ""
    StrCpy $nyxOldVersion $0
  ${EndIf}

  ; 注册表没有记录，但目标目录里已经有 Nyx.exe：也视为已安装（例如手工拷贝过程序目录）
  ${If} $nyxOldVersion == ""
  ${AndIf} ${FileExists} "$INSTDIR\${PRODUCT_FILENAME}.exe"
    StrCpy $nyxOldVersion "（版本未知）"
  ${EndIf}

  ${If} $nyxOldVersion == ""
    StrCpy $nyxMode "全新安装"
    StrCpy $nyxModeDetail ""
    StrCpy $nyxModeStatus ${NYX_ST_OK}
  ${ElseIf} $nyxOldVersion == "（版本未知）"
    StrCpy $nyxMode "升级安装"
    StrCpy $nyxModeDetail "（无法读取旧版本号 → ${VERSION}，个人数据保留）"
    StrCpy $nyxModeStatus ${NYX_ST_OK}
  ${Else}
    ${VersionCompare} "$nyxOldVersion" "${VERSION}" $3
    ${If} $3 == 0
      StrCpy $nyxMode "修复安装"
      StrCpy $nyxModeDetail "（同版本 $nyxOldVersion 覆盖安装，个人数据保留）"
      StrCpy $nyxModeStatus ${NYX_ST_OK}
    ${ElseIf} $3 == 1
      StrCpy $nyxMode "降级安装"
      StrCpy $nyxModeDetail "（已安装 $nyxOldVersion 比本安装包 ${VERSION} 更新，个人数据保留）"
      StrCpy $nyxModeStatus ${NYX_ST_WARN}
    ${Else}
      StrCpy $nyxMode "升级安装"
      StrCpy $nyxModeDetail "（$nyxOldVersion → ${VERSION}，个人数据保留）"
      StrCpy $nyxModeStatus ${NYX_ST_OK}
    ${EndIf}
  ${EndIf}
FunctionEnd

; 汇总检测结果，统计阻断/提醒数量
Function nyxDetectAll
  Call nyxDetectOs
  Call nyxDetectArch
  Call nyxDetectDir
  Call nyxDetectDisk
  Call nyxDetectKernel
  Call nyxDetectRunning
  Call nyxUpdateMode

  StrCpy $nyxBlockers 0
  StrCpy $nyxWarnings 0

  ${If} $nyxOsStatus == ${NYX_ST_BLOCK}
    IntOp $nyxBlockers $nyxBlockers + 1
  ${ElseIf} $nyxOsStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxArchStatus == ${NYX_ST_BLOCK}
    IntOp $nyxBlockers $nyxBlockers + 1
  ${ElseIf} $nyxArchStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxDirStatus == ${NYX_ST_BLOCK}
    IntOp $nyxBlockers $nyxBlockers + 1
  ${ElseIf} $nyxDirStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxDiskStatus == ${NYX_ST_BLOCK}
    IntOp $nyxBlockers $nyxBlockers + 1
  ${ElseIf} $nyxDiskStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxKernelStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxRunning == "1"
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
  ${If} $nyxModeStatus == ${NYX_ST_WARN}
    IntOp $nyxWarnings $nyxWarnings + 1
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 检查页文案
; ---------------------------------------------------------------------------
Function nyxBuildPageText
  StrCpy $nyxPageText "Nyx 安装环境检查（检查全部在本机完成，不会联网）$\r$\n"
  StrCpy $nyxPageText "$nyxPageText────────────────────────────────────────────$\r$\n"

  ; 系统版本
  StrCpy $0 $nyxOsStatus
  Call nyxMarker
  StrCpy $nyxMark $0
  StrCpy $nyxLine "系统版本：$nyxOsName（内部版本 $nyxOsBuild）"
  ${If} $nyxOsStatus == ${NYX_ST_BLOCK}
    StrCpy $nyxLine "$nyxLine — 需要 Windows 10 1809（内部版本 ${NYX_MIN_BUILD}）或更高"
  ${ElseIf} $nyxOsStatus == ${NYX_ST_WARN}
    StrCpy $nyxLine "$nyxLine — 低于推荐版本 ${NYX_REC_BUILD}，个别功能可能受限"
  ${EndIf}
  Call nyxAddLine

  ; 系统架构
  StrCpy $0 $nyxArchStatus
  Call nyxMarker
  StrCpy $nyxMark $0
  StrCpy $nyxLine "系统架构：$nyxArchText"
  Call nyxAddLine

  ; 目标目录写权限
  StrCpy $0 $nyxDirStatus
  Call nyxMarker
  StrCpy $nyxMark $0
  StrCpy $nyxLine "安装目录：$INSTDIR（可写入）"
  ${If} $nyxDirStatus == ${NYX_ST_BLOCK}
    StrCpy $nyxLine "安装目录：$INSTDIR（无法创建或没有写入权限）"
  ${EndIf}
  Call nyxAddLine

  ; 磁盘空间
  StrCpy $0 $nyxDiskStatus
  Call nyxMarker
  StrCpy $nyxMark $0
  StrCpy $nyxLine "目标盘剩余空间：$nyxDiskText"
  Call nyxAddLine

  ; 内核依赖
  StrCpy $0 $nyxKernelStatus
  Call nyxMarker
  StrCpy $nyxMark $0
!if /FileExists "${PROJECT_DIR}\vendor\mihomo\mihomo.exe"
  StrCpy $nyxLine "依赖内核：mihomo ${NYX_KERNEL_VERSION} 已随安装包附带，无需单独下载"
!else
  StrCpy $nyxLine "依赖内核：安装包内未找到 mihomo，请重新下载完整安装包"
!endif
  ${If} $nyxKernelStatus == ${NYX_ST_WARN}
    StrCpy $nyxLine "依赖内核：目标目录中的内核文件不完整，覆盖安装会自动补齐；若仍失败请重新下载完整安装包"
  ${EndIf}
  Call nyxAddLine

  ; 运行库说明
  StrCpy $nyxMark "✔"
  StrCpy $nyxLine "运行库：无需额外安装（Electron 自带 Chromium 与 Node.js 运行时）"
  Call nyxAddLine

  ; 正在运行的旧进程
  ${If} $nyxRunning == "1"
    StrCpy $nyxMark "⚠"
    StrCpy $nyxLine "检测到 Nyx 正在运行：继续安装会先关闭它，请提前保存工作"
    Call nyxAddLine
  ${EndIf}

  ; 安装类型（全新 / 升级 / 修复 / 降级）
  StrCpy $0 $nyxModeStatus
  Call nyxMarker
  StrCpy $nyxMark $0
  StrCpy $nyxLine "安装类型：$nyxMode$nyxModeDetail"
  Call nyxAddLine

  ; 个人数据说明
  StrCpy $nyxMark "✔"
  StrCpy $nyxLine "个人数据：$APPDATA\Nyx（升级与修复都不会删除，卸载时可选择保留）"
  Call nyxAddLine

  ; 汇总提醒
  StrCpy $nyxPageText "$nyxPageText────────────────────────────────────────────$\r$\n"
  ${If} $nyxBlockers > 0
    StrCpy $nyxPageText "$nyxPageText✘ 有 $nyxBlockers 项阻断问题，问题解决前无法继续安装，请先处理。$\r$\n"
    StrCpy $nyxPageText "$nyxPageText   处理完成后点击「重新检测」刷新结果。$\r$\n"
  ${EndIf}
  ${If} $nyxWarnings > 0
    StrCpy $nyxPageText "$nyxPageText⚠ 有 $nyxWarnings 项提醒，建议处理，但不影响安装。$\r$\n"
  ${EndIf}
  ${If} $nyxBlockers == 0
  ${AndIf} $nyxWarnings == 0
    StrCpy $nyxPageText "$nyxPageText✔ 未发现问题，可以继续安装。$\r$\n"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 检查页（目录页之后）
; ---------------------------------------------------------------------------

; 按阻断状态设置「下一步」按钮是否可用（阻断时不允许前进）
Function nyxApplyNextButton
  GetDlgItem $0 $HWNDPARENT 1
  ${If} $0 != 0
    ${If} $nyxBlockers > 0
      EnableWindow $0 0
    ${Else}
      EnableWindow $0 1
    ${EndIf}
  ${EndIf}
FunctionEnd

Function nyxEnvPageCreate
  ; 目录页选择的是「父目录」，模板要到 instFilesPre 才补上 ${APP_FILENAME} 子目录。
  ; 本页早于 instFilesPre，所以这里先自己补一次，保证审查的不是父目录。
  ${If} $INSTDIR != ""
    StrCpy $0 "$INSTDIR" "" -1
    ${If} $0 == "\"
      StrCpy $INSTDIR "$INSTDIR" -1
    ${EndIf}
    StrLen $1 "${APP_FILENAME}"
    StrCpy $2 "$INSTDIR" $1 -$1
    ${If} $2 != "${APP_FILENAME}"
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}

  Call nyxDetectAll
  Call nyxBuildPageText

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; 自定义页的标题与副标题（MUI 头部控件 ID 固定为 1037 / 1038）
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:环境检查"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:安装前自动检查本机环境，检查全部在本机完成"
  ${EndIf}

  ; 只读多行文本框显示检查结果
  nsDialogs::CreateControl "EDIT" ${DEFAULT_STYLES}|${WS_TABSTOP}|${ES_MULTILINE}|${ES_READONLY}|${WS_VSCROLL}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 0 100% 58% ""
  Pop $nyxTextCtrl
  ${If} $nyxTextCtrl == error
    StrCpy $nyxTextCtrl 0
  ${Else}
    ${NSD_SetText} $nyxTextCtrl "$nyxPageText"
  ${EndIf}

  ; 操作按钮
  ${NSD_CreateButton} 0 62% 62u 14u "重新检测"
  Pop $0
  ${NSD_OnClick} $0 nyxOnRecheck

  ${NSD_CreateButton} 68u 62% 96u 14u "打开依赖下载页"
  Pop $0
  ${NSD_OnClick} $0 nyxOnOpenPage

  ; 页脚固定说明
  ${NSD_CreateLabel} 0 80% 100% 28u "依赖清单：Windows 10 1809+ / x64 / 1.5 GB 磁盘空间；其余运行环境（mihomo 内核、Chromium 与 Node.js 运行时）随安装包附带。"
  Pop $0

  Call nyxApplyNextButton
  nsDialogs::Show
FunctionEnd

Function nyxEnvPageLeave
  ; 离开页面前再检测一次，避免页面停留期间环境发生变化（例如磁盘被写满）
  Call nyxDetectAll
  Call nyxBuildPageText
  ${If} $nyxTextCtrl != 0
    ${NSD_SetText} $nyxTextCtrl "$nyxPageText"
  ${EndIf}
  Call nyxApplyNextButton
FunctionEnd

; 「重新检测」按钮：重新跑一遍检测并刷新文本与按钮状态
Function nyxOnRecheck
  Pop $0
  Call nyxDetectAll
  Call nyxBuildPageText
  ${If} $nyxTextCtrl != 0
    ${NSD_SetText} $nyxTextCtrl "$nyxPageText"
  ${EndIf}
  Call nyxApplyNextButton
FunctionEnd

; 「打开依赖下载页」按钮：系统过旧时打开 Windows 更新页，否则打开内核下载页
Function nyxOnOpenPage
  Pop $0
  ${If} $nyxOsStatus == ${NYX_ST_BLOCK}
    ExecShell "open" "${NYX_URL_WINDOWS}"
  ${Else}
    ExecShell "open" "${NYX_URL_KERNEL}"
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; 安装报告
; ---------------------------------------------------------------------------
Function nyxWriteReport
  CreateDirectory "$APPDATA\Nyx"
  Call nyxTimestamp
  StrCpy $R0 $0

  ClearErrors
  FileOpen $R1 "$APPDATA\Nyx\install-report.txt" w
  ${If} ${Errors}
    DetailPrint "无法写入安装报告：$APPDATA\Nyx\install-report.txt"
    Return
  ${EndIf}
  FileWriteWord $R1 0xFEFF      ; UTF-16LE BOM，保证记事本正确识别中文
  StrCpy $R2 "Nyx 安装报告"
  Call nyxReportLine
  StrCpy $R2 "=============================="
  Call nyxReportLine
  StrCpy $R2 "生成时间：$R0"
  Call nyxReportLine
  StrCpy $R2 "安装器版本：${VERSION}"
  Call nyxReportLine
  StrCpy $R2 "安装模式：$nyxMode$nyxModeDetail"
  Call nyxReportLine
  StrCpy $R2 "安装目录：$INSTDIR"
  Call nyxReportLine
  StrCpy $R2 "系统版本：$nyxOsName（内部版本 $nyxOsBuild）"
  Call nyxReportLine
  StrCpy $R2 "系统架构：$nyxArchText"
  Call nyxReportLine
  StrCpy $R2 "目标盘剩余：$nyxDiskText"
  Call nyxReportLine
  ${If} $nyxOldVersion == ""
    StrCpy $R2 "旧版本：未检测到（全新安装）"
  ${Else}
    StrCpy $R2 "旧版本：$nyxOldVersion$nyxModeDetail"
  ${EndIf}
  Call nyxReportLine
  StrCpy $R2 "内核版本：${NYX_KERNEL_VERSION}（运行期核对：$nyxKernelPost）"
  Call nyxReportLine
  StrCpy $R2 "完整性检测：$nyxIntegrityText"
  Call nyxReportLine
  StrCpy $R2 "个人数据目录：$APPDATA\Nyx（升级与修复不会删除；卸载时可选择保留）"
  Call nyxReportLine
  StrCpy $R2 "静默安装：/S ；自定义目录 /D=目录（/D 必须是最后一个参数且不能加引号）"
  Call nyxReportLine
  StrCpy $R2 "静默卸载：/S ；如需同时删除个人数据再加 /DELETEAPPDATA"
  Call nyxReportLine
  StrCpy $R2 "卸载命令：$\"$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe$\" /S"
  Call nyxReportLine
  StrCpy $R2 "安装器路径：$EXEPATH"
  Call nyxReportLine
  StrCpy $R2 ""
  Call nyxReportLine
  StrCpy $R2 "说明：本报告由安装器自动生成，默认保留；不需要时可直接删除。"
  Call nyxReportLine
  FileClose $R1
FunctionEnd

!endif ; BUILD_UNINSTALLER 隔离结束

; ---------------------------------------------------------------------------
; 检查页挂载点：electron-builder 在目录页之后插入此宏
; ---------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom nyxEnvPageCreate nyxEnvPageLeave
!macroend

; ---------------------------------------------------------------------------
; 初始化：在页面出现之前采集旧版本信息（升级时注册表稍后会被旧卸载器清掉）
; ---------------------------------------------------------------------------
!macro customInit
  Call nyxDetectOs
  Call nyxDetectArch
  Call nyxDetectDisk
  Call nyxUpdateMode
!macroend

; ---------------------------------------------------------------------------
; 安装：写报告、内核核对、完整性自检、清理运行中的旧进程
; ---------------------------------------------------------------------------
!macro customInstall
  SetShellVarContext current

  ; 模板不会把 InstallLocation 写进卸载项，这里补上，便于卸载器与外部工具定位
  WriteRegStr SHELL_CONTEXT "${NYX_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"

  CreateDirectory "$APPDATA\Nyx"
  CreateDirectory "$APPDATA\Nyx\updates"
  CreateDirectory "$INSTDIR\updates"
  Delete "$APPDATA\Nyx\updates\*.exe"

  ; 兜底：关闭仍在运行的 Nyx（模板在复制文件前已处理过一次）
  Call nyxDetectRunning
  ${If} $nyxRunning == "1"
    DetailPrint "关闭正在运行的 ${PRODUCT_NAME}..."
    nsExec::ExecToStack 'cmd /c taskkill /F /IM "${PRODUCT_FILENAME}.exe"'
    Pop $0
    Pop $0
    Sleep 500
  ${EndIf}

  ; 内核文件核对（安装后）
  StrCpy $nyxKernelPost "已随包附带"
  ${IfNot} ${FileExists} "$INSTDIR\resources\vendor\mihomo\mihomo.exe"
    ${IfNot} ${FileExists} "$INSTDIR\vendor\mihomo\mihomo.exe"
      StrCpy $nyxKernelPost "缺失，请从依赖下载页重新获取完整安装包"
    ${EndIf}
  ${EndIf}

  ; 完整性自检：由 Nyx.exe --verify-integrity 完成，失败只记录，绝不中断安装
  StrCpy $nyxIntegrityExit "-2"
  StrCpy $nyxIntegrityText "未执行（安装包内没有 integrity.json）"
  ${If} ${FileExists} "$INSTDIR\resources\integrity.json"
    DetailPrint "正在校验程序文件完整性..."
    ; 防御：个别开发环境会设置 ELECTRON_RUN_AS_NODE，那样 Nyx.exe 会以纯 Node 模式
    ; 启动，把 --verify-integrity 当成未知的 Node 选项直接退出（退出码 9），导致误报。
    ; 这里只在安装器自己的进程里清掉该变量（只影响安装器启动的子进程），不改系统设置。
    ReadEnvStr $0 "ELECTRON_RUN_AS_NODE"
    ${If} $0 != ""
      DetailPrint "检测到 ELECTRON_RUN_AS_NODE，已为校验子进程临时清除"
      System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)i.r0'
    ${EndIf}
    Delete "$APPDATA\Nyx\integrity-check.txt"
    ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --verify-integrity --report="$APPDATA\Nyx\integrity-check.txt"' $nyxIntegrityExit
    ${If} $nyxIntegrityExit == 0
      StrCpy $nyxIntegrityText "通过（退出码 0，明细见 $APPDATA\Nyx\integrity-check.txt）"
    ${ElseIf} ${FileExists} "$APPDATA\Nyx\integrity-check.txt"
      StrCpy $nyxIntegrityText "未通过（退出码 $nyxIntegrityExit，明细见 $APPDATA\Nyx\integrity-check.txt）"
    ${Else}
      StrCpy $nyxIntegrityText "未通过/不可用（退出码 $nyxIntegrityExit，未生成校验报告，可能该版本不支持 --verify-integrity）"
    ${EndIf}
  ${EndIf}

  ; 刷新检测结果，写入安装报告
  Call nyxDetectOs
  Call nyxDetectArch
  Call nyxDetectDisk
  Call nyxWriteReport

  ; 只有「从更新目录里运行的安装包」才自删，避免误删用户下载的安装包
  ${GetParent} "$EXEPATH" $0
  ${If} $0 == "$INSTDIR\updates"
    Exec '"$SYSDIR\cmd.exe" /c ping -n 4 127.0.0.1 >nul & del /f /q "$EXEPATH"'
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------
; 卸载器：结束进程、清理快捷方式与缓存目录
; ---------------------------------------------------------------------------
!ifdef BUILD_UNINSTALLER
Function un.nyxKillApp
  nsExec::ExecToStack 'cmd /c taskkill /F /IM "${PRODUCT_FILENAME}.exe"'
  Pop $R0
  Pop $R0
  Sleep 400
FunctionEnd
!endif

!macro customUnInit
  ; un.onInit 里模板执行了 SetOutPath $INSTDIR，卸载器进程的当前目录因此停在安装目录，
  ; Windows 不允许删除「某个进程的当前目录」，卸载结束后会残留一个空的安装目录。
  ; 这里把当前目录挪到临时目录，让模板结束时的 RMDir /r $INSTDIR 能真正删干净。
  SetOutPath "$TEMP"

  ; 卸载开始前先关闭应用，避免文件占用导致残留
  Call un.nyxKillApp

  ; 是否同时删除个人数据：交互时询问（默认保留），静默时只认 /DELETEAPPDATA
  StrCpy $nyxDeleteUserData "0"
  ${If} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/DELETEAPPDATA" $R1
    ${IfNot} ${Errors}
      StrCpy $nyxDeleteUserData "1"
    ${EndIf}
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${IfNot} ${Errors}
      StrCpy $nyxDeleteUserData "1"
    ${EndIf}
    ClearErrors
  ${Else}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同时删除个人数据？$\r$\n$\r$\n包括书签、历史记录、设置与扩展，删除后无法恢复。$\r$\n选择「否」将保留这些数据，下次安装会自动沿用。" IDYES nyx_un_del_data IDNO nyx_un_keep_data
    nyx_un_del_data:
      StrCpy $nyxDeleteUserData "1"
      Goto nyx_un_choice_done
    nyx_un_keep_data:
      StrCpy $nyxDeleteUserData "0"
    nyx_un_choice_done:
  ${EndIf}
!macroend

!macro customUnInstall
  SetShellVarContext current

  ; 兜底：再关一次进程（卸载器复制自身后可能有残留）
  Call un.nyxKillApp

  ; 快捷方式与更新缓存（模板已处理大部分，这里兜底）
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  RMDir /r "$INSTDIR\updates"

  ; 按用户选择删除个人数据（默认保留，安装报告也一并保留）
  ${If} $nyxDeleteUserData == "1"
    RMDir /r "$APPDATA\Nyx"
    RMDir /r "$LOCALAPPDATA\Nyx"
  ${EndIf}
!macroend
