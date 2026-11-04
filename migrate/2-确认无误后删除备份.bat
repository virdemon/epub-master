@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title 删除迁移备份，释放 C 盘空间

set "SRC=C:\Users\wh\.workbuddy"
set "BAK=C:\Users\wh\.workbuddy.bak"

echo ============================================================
echo   删除迁移备份
echo ============================================================
echo.

if not exist "%BAK%" (
  echo [提示] 没有找到备份 %BAK%
  echo        可能已经删过了。
  goto :end
)

rem 确认现在是联接状态，否则删备份就等于删数据
dir /a:l "%SRC%" 2>nul | find /I "JUNCTION" >nul
if errorlevel 1 (
  echo [错误] %SRC% 不是目录联接，说明迁移没成功或已被还原。
  echo        此时删除备份会丢数据，已中止。
  goto :end
)

echo 当前联接指向:
dir "%SRC%" /a:l | find /I "JUNCTION"
echo.

tasklist /FI "IMAGENAME eq WorkBuddy.exe" 2>nul | find /I "WorkBuddy.exe" >nul
if not errorlevel 1 (
  echo [错误] WorkBuddy 还在运行，请完全退出后再试。
  goto :end
)

for /f "usebackq" %%a in (`dir /b /s /a-d "%BAK%" ^| find /c /v ""`) do set "CNT=%%a"
echo 备份里有 !CNT! 个文件，删除后 C 盘释放约 1GB。
echo.
set /p OK=确认删除? 输入 Y 回车:
if /I not "%OK%"=="Y" (
  echo 已取消。
  goto :end
)

echo 正在删除...
rd /s /q "%BAK%"
if exist "%BAK%" (
  echo [警告] 没有完全删除，可能有文件被占用。可以重启电脑后再运行一次。
) else (
  echo 完成，备份已删除。
)

:end
echo.
pause
exit /b 0
