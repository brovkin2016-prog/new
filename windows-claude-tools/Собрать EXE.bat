@echo off
rem Сборка claude-session-manager.exe (запустить на Windows, один раз)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Собрать EXE.ps1"
