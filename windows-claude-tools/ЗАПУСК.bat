@echo off
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0claude-session-manager.ps1"
if errorlevel 1 (
  echo.
  echo Program exited with an error. Please screenshot this window.
  pause
)
