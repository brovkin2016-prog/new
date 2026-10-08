@echo off
chcp 65001 >nul
title Восстановление сессий Claude Code
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-restore.ps1"
echo.
pause
