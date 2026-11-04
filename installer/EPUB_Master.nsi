; =====================================================================
; EPUB Master 1.0.0 —— Windows 安装程序（NSIS 3.11 / Modern UI 2）
;
; 为什么是 NSIS 而不是 Inno Setup：
;   这台构建机装不上 Inno Setup（官方站与 GitHub 下载都被网络挡住），
;   NSIS 从 SourceForge 拿到了完整发行包，能力覆盖需求里的每一条：
;   产品名/图标/版本号、开始菜单快捷方式、可选桌面快捷方式、卸载项、
;   免管理员安装、安装目录与用户数据分离。
;
; 安装位置：%LOCALAPPDATA%\Programs\EPUB Master（当前用户，不需要管理员）
; 用户数据：%APPDATA%\epub-master（Electron 默认）、输出书稿：下载\EPUB_Master
;           这两处都在安装目录之外，卸载不会碰。
;
; 编译： makensis installer\EPUB_Master.nsi
; =====================================================================

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!define APP_NAME        "EPUB Master"
!define APP_NAME_CN     "EPUB 排版与压缩大师"
!define APP_VER         "1.2"
!define APP_VER4        "1.2.0.0"
!define APP_PUBLISHER   "virdemon"
!define APP_EXE         "EPUB Master.exe"
!define APP_ID          "EPUBMaster"
!define APP_KEY         "Software\EPUB Master"
!define UNINST_KEY      "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"

; 载荷：tools/make_release.py 产出的绿色目录（与便携版同一套文件）
!define PAYLOAD         "..\release\portable\EPUB_Master_Portable"
!define ICON_FILE       "..\dist\icon.ico"

Name "${APP_NAME} ${APP_VER}"
BrandingText "${APP_NAME} ${APP_VER} · ${APP_PUBLISHER}"

OutFile "..\release\EPUB_Master_v${APP_VER}_Windows_x64_Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VER4}"
VIAddVersionKey /LANG=2052 "ProductName"     "${APP_NAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME} 安装程序（${APP_NAME_CN}）"
VIAddVersionKey /LANG=2052 "FileVersion"     "${APP_VER}"
VIAddVersionKey /LANG=2052 "ProductVersion"  "${APP_VER}"
VIAddVersionKey /LANG=2052 "CompanyName"     "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "LegalCopyright"  "© ${APP_PUBLISHER}. 基于 Electron（MIT）与开源组件。"
VIAddVersionKey /LANG=2052 "OriginalFilename" "EPUB_Master_v${APP_VER}_Windows_x64_Setup.exe"

; ------------------------------------------------------------------ 界面
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define MUI_ICON   "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ------------------------------------------------------------------ 文案
LangString DESC_MAIN     ${LANG_SIMPCHINESE} "程序本体：主程序、Electron 运行时、界面与图标（约 258 MB）。这一项不能取消。"
LangString DESC_MAIN     ${LANG_ENGLISH}     "Application files, Electron runtime, UI and icons (~258 MB). Required."
LangString DESC_DESKTOP  ${LANG_SIMPCHINESE} "在桌面上放一个 ${APP_NAME} 的快捷方式。不需要可以取消勾选，之后随时可以手动创建。"
LangString DESC_DESKTOP  ${LANG_ENGLISH}     "Create a ${APP_NAME} shortcut on the Desktop."

; ------------------------------------------------------------------ 安装
Section "!${APP_NAME} 主程序" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; 绿色目录整份铺进去：主程序 + DLL + locales + resources/app
  File /r "${PAYLOAD}\*.*"

  ; 卸载程序与注册信息
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0

  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "Version" "${APP_VER}"

  ; 控制面板「程序和功能」里的条目：当前用户安装，不碰 HKLM
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME} ${APP_VER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayVersion"  "${APP_VER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\icon.ico"
  WriteRegStr   HKCU "${UNINST_KEY}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr   HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr   HKCU "${UNINST_KEY}" "Comments"        "${APP_NAME_CN}"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "桌面快捷方式" SEC_DESKTOP
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MAIN}    $(DESC_MAIN)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} $(DESC_DESKTOP)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInit
  ; 已经装过：默认沿用上次的目录，直接覆盖升级，不产生第二份。
  ; 但命令行显式给了 /D= 时必须听命令行的（静默部署、装到 U 盘），
  ; 否则 /D 会被这里覆盖掉，静默安装永远落回注册表里的旧路径。
  ; 判断依据：NSIS 在执行 .onInit 之前就把 /D 的值写进了 $INSTDIR，
  ; 所以只要它不等于默认路径，就说明用户自己指定过，不能再改。
  ${If} $INSTDIR == "$LOCALAPPDATA\Programs\${APP_NAME}"
    ReadRegStr $0 HKCU "${APP_KEY}" "InstallDir"
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
FunctionEnd

; ------------------------------------------------------------------ 卸载
Section "Uninstall"
  ; 只删自己装进去的东西。用户数据一个都不碰：
  ;   %APPDATA%\epub-master（配置/缓存）、下载\EPUB_Master（生成的 epub）
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"

  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\*.log"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"

  ; 用 MessageBox 而不是 WriteUninstLog：让用户明确知道书和设置还在
  ; 静默卸载（/S）不弹窗，否则脚本化卸载会卡住
  IfSilent +2
  MessageBox MB_OK|MB_ICONINFORMATION "卸载完成。$\r$\n$\r$\n已生成的书稿（默认在「下载\EPUB_Master」）和程序设置（%APPDATA%\epub-master）都保留着，需要的话请手动删除。"
SectionEnd
