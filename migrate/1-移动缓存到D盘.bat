@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title WorkBuddy 数据目录迁移 C -> D

set "SRC=C:\Users\wh\.workbuddy"
set "DSTROOT=D:\WorkBuddy-data"
set "DST=%DSTROOT%\.workbuddy"
set "BAK=C:\Users\wh\.workbuddy.bak"

echo ============================================================
echo   WorkBuddy 数据目录迁移
echo   从: %SRC%
echo   到: %DST%
echo ============================================================
echo.

rem ---------- 检查 1: 源目录存在 ----------
if not exist "%SRC%" (
  echo [错误] 找不到 %SRC%
  goto :abort
)
if not exist "%SRC%\settings.json" (
  echo [错误] %SRC% 看起来不是 WorkBuddy 数据目录
  goto :abort
)

rem ---------- 检查 2: 是否已经迁移过 ----------
dir /a:l "%SRC%" 2>nul | find /I "JUNCTION" >nul
if not errorlevel 1 (
  echo [提示] 这个目录已经是一个联接，说明迁移过了。
  echo        当前指向:
  dir "%SRC%" /a:l | find /I "JUNCTION"
  goto :abort
)

rem ---------- 检查 3: 上次的备份还在吗 ----------
if exist "%BAK%" (
  echo [错误] 发现上次留下的备份: %BAK%
  echo        请先确认新版本能正常使用，再运行 "2-确认无误后删除备份.bat"
  echo        或者手动删掉它再重来。
  goto :abort
)

rem ---------- 检查 4: WorkBuddy 必须完全关闭 ----------
tasklist /FI "IMAGENAME eq WorkBuddy.exe" 2>nul | find /I "WorkBuddy.exe" >nul
if not errorlevel 1 (
  echo [错误] WorkBuddy 还在运行。
  echo.
  echo        请先完全退出它:
  echo          1. 关闭主窗口
  echo          2. 右键任务栏右下角的托盘图标 - 退出
  echo          3. 任务管理器里确认没有 WorkBuddy.exe 残留
  echo.
  echo        然后重新运行本脚本。
  goto :abort
)

rem ---------- 检查 5: D 盘空间 ----------
for /f "tokens=3" %%a in ('dir /-c "%SRC%" ^| find "个文件"') do set "SRCBYTES=%%a"
if not defined SRCBYTES (
  for /f "tokens=3" %%a in ('dir /-c "%SRC%" ^| find "File(s)"') do set "SRCBYTES=%%a"
)
echo [检查] 源目录字节数: !SRCBYTES!
echo.

rem ---------- 清掉可能残留的半截副本 ----------
if exist "%DST%" (
  echo [清理] 发现上次未完成的副本，先删除: %DST%
  rd /s /q "%DST%"
)
if not exist "%DSTROOT%" mkdir "%DSTROOT%"

rem ---------- 步骤 1: 复制 ----------
echo [1/5] 正在复制文件（1GB 左右，可能要 1-3 分钟）...
echo.
robocopy "%SRC%" "%DST%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NP
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo.
  echo [错误] 复制失败，robocopy 返回 %RC%
  echo        源目录未做任何改动，你的数据是安全的。
  goto :abort
)
echo.

rem ---------- 步骤 2: 核对文件数量 ----------
echo [2/5] 核对文件数量...
set "CNT1=0"
set "CNT2=0"
for /f "usebackq" %%a in (`dir /b /s /a-d "%SRC%" ^| find /c /v ""`) do set "CNT1=%%a"
for /f "usebackq" %%a in (`dir /b /s /a-d "%DST%" ^| find /c /v ""`) do set "CNT2=%%a"
echo       源: !CNT1! 个文件
echo       新: !CNT2! 个文件
if not "!CNT1!"=="!CNT2!" (
  echo.
  echo [错误] 文件数量不一致，中止。
  echo        源目录未做任何改动，你的数据是安全的。
  echo        可以手动删除 %DST% 后重试。
  goto :abort
)
echo       一致，通过。
echo.

rem ---------- 步骤 3: 原目录改名备份 ----------
echo [3/5] 把原目录改名为备份...
move "%SRC%" "%BAK%" >nul
if errorlevel 1 (
  echo [错误] 改名失败。可能有程序占用文件。
  goto :abort
)
echo       完成: %BAK%
echo.

rem ---------- 步骤 4: 建立目录联接 ----------
echo [4/5] 建立目录联接...
mklink /J "%SRC%" "%DST%" >nul
if errorlevel 1 (
  echo [错误] 联接创建失败，正在回滚...
  move "%BAK%" "%SRC%" >nul
  echo        已回滚，一切如初。
  goto :abort
)
echo       完成: %SRC%  -^>  %DST%
echo.

rem ---------- 步骤 5: 验证 ----------
echo [5/5] 验证...
if not exist "%SRC%\settings.json" (
  echo [错误] 通过联接读不到 settings.json，正在回滚...
  rd "%SRC%" 2>nul
  move "%BAK%" "%SRC%" >nul
  echo        已回滚，一切如初。
  goto :abort
)
if not exist "%SRC%\workbuddy.db" (
  echo [错误] 通过联接读不到 workbuddy.db，正在回滚...
  rd "%SRC%" 2>nul
  move "%BAK%" "%SRC%" >nul
  echo        已回滚，一切如初。
  goto :abort
)
echo       通过，数据可正常读取。
echo.
echo ============================================================
echo   迁移完成
echo ============================================================
echo.
echo   现在请:
echo     1. 启动 WorkBuddy
echo     2. 确认对话记录、项目、设置都在
echo     3. 随便让我做一件事，确认能正常干活
echo     4. 一切正常后，运行 "2-确认无误后删除备份.bat"
echo        这一步会真正释放 C 盘的 1GB 空间
echo.
echo   注意: 备份没删之前，C 盘空间不会减少（只是换了个名字）。
echo.
pause
exit /b 0

:abort
echo.
pause
exit /b 1
