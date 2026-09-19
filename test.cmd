@echo off
rem Run the full test suite (no Electron / no eNSP needed)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0'; npm test"
exit /b %errorlevel%