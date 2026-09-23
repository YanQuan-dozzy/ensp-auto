@echo off
setlocal EnableExtensions

rem ============================================================
rem  ensp-auto Launcher (thin wrapper -> start.ps1)
rem
rem  default     : build if needed, create eNSPAuto.lnk shortcut
rem                and launch electron through it, so the taskbar
rem                shows "eNSPAuto" + project icon.
rem  --dev       : electron-vite dev (HMR).
rem  --visible   : keep the console open (debug).
rem  --no-install: skip npm install check.
rem
rem  All logic lives in start.ps1. This file only controls
rem  whether the console is hidden.
rem ============================================================

rem ---- self-hide: relaunch hidden (keep console when --visible) ----
if /i "%~1"=="--hidden" goto :run
echo %* | findstr /I /C:"--visible" >nul 2>&1 && goto :run
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%~f0' -ArgumentList '--hidden %*'"
exit /b 0

:run
rem ---- map flags for start.ps1 ----
set "PS_ARGS="
echo %* | findstr /I /C:"--dev"        >nul 2>&1 && set "PS_ARGS=%PS_ARGS% -Dev"
echo %* | findstr /I /C:"--visible"    >nul 2>&1 && set "PS_ARGS=%PS_ARGS% -Visible"
echo %* | findstr /I /C:"--no-install" >nul 2>&1 && set "PS_ARGS=%PS_ARGS% -NoInstall"

set "ROOT=%~dp0"

echo %* | findstr /I /C:"--visible" >nul 2>&1 && goto :visible_run

rem ---- hidden mode: no console, log to %LOCALAPPDATA%\ensp-auto\start.log ----
set "LOGDIR=%LOCALAPPDATA%\ensp-auto"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%ROOT%start.ps1" %PS_ARGS% >> "%LOGDIR%\start.log" 2>&1
exit /b %errorlevel%

:visible_run
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%start.ps1" %PS_ARGS%
exit /b %errorlevel%