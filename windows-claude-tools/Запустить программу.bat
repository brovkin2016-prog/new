@echo off
rem Запасной запуск (если .vbs заблокирован). Консоль свернётся, откроется окно программы.
powershell.exe -sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0claude-session-manager.ps1"
