@echo off
rem Run typecheck + production build
powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-Location -LiteralPath '%~dp0'; npm run verify"
exit /b %errorlevel%