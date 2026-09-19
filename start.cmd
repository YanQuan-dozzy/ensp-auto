@echo off
rem ensp-auto launcher - forwards to start.ps1 (all messages live there)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
exit /b %errorlevel%