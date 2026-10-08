@echo off
chcp 65001 >nul
title Бэкап сессий Claude Code
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-backup.ps1"
echo.
pause
