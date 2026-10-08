@echo off
chcp 65001 >nul
title Claude Session Manager
rem Надёжный запуск: обходит политику скриптов. Это окно можно свернуть.
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0claude-session-manager.ps1"
if errorlevel 1 (
  echo.
  echo === Программа завершилась с ошибкой. Сделайте скрин этого окна. ===
  pause
)
