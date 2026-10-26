@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_extension.ps1"
echo.
pause
