; Nyx 安装脚本自定义片段（由 electron-builder 的 nsis.include 引入）
;
; 三件事：
;   1. 把安装位置写进注册表，升级时安装程序读到同一目录，原地覆盖；
;   2. 准备升级收件目录（用户数据目录 + 旧版安装目录各一个）；
;   3. 补建桌面快捷方式。非 oneClick 安装器在静默安装（自动升级走的就是静默）
;      时不会初始化「创建桌面快捷方式」那一页的变量，桌面图标会丢，这里显式建。
;
; 安装目录本身交给 electron-builder 的默认逻辑（%LOCALAPPDATA%\Programs\Nyx），
; 不硬编码盘符：用户可用安装向导改到任意位置，也能在无 D 盘的机器上安装。

!macro customInstall
  SetShellVarContext current

  ; 记录本次实际安装位置。升级时安装程序优先读它，保证覆盖到同一目录，
  ; 不会出现「新版装到默认目录、旧版残留在别处」的两份并存。
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"

  ; 升级收件目录：新版安装包与 latest.json 丢进这里即可被「检查更新」发现。
  ; 注意必须放用户数据目录（%APPDATA%\Nyx\updates），不能只放 $INSTDIR\updates——
  ; 覆盖安装会清理安装目录，放里面会被一并删掉，下一轮就检不到清单。
  CreateDirectory "$APPDATA\Nyx\updates"
  ; 兼容旧安装：老版本读的是 $INSTDIR\updates
  CreateDirectory "$INSTDIR\updates"

  CreateShortCut "$DESKTOP\Nyx 隐私浏览器.lnk" "$INSTDIR\Nyx.exe" "" "$INSTDIR\Nyx.exe" 0

  ; ===== 安装完成后自动清理安装包 =====
  ; 1) 清理两个升级收件目录下的旧安装包：仅删除 *.exe，
  ;    保留 latest.json 等非 exe 文件（下次检查更新仍需读清单）
  Delete "$APPDATA\Nyx\updates\*.exe"
  Delete "$INSTDIR\updates\*.exe"

  ; 2) 延迟删除安装程序自身：$EXEPATH 正在运行无法直接删除，
  ;    交由 cmd 短暂延时后执行删除（ping 仅作延时，不实际发包），
  ;    不阻塞安装流程，安装程序退出后由该后台进程完成删除
  Exec '"$SYSDIR\cmd.exe" /c ping -n 4 127.0.0.1 >nul & del /f /q "$EXEPATH"'
!macroend
