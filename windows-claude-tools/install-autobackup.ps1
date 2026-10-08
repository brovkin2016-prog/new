# install-autobackup.ps1  —  включить АВТОМАТИЧЕСКИЙ бэкап (Windows, Планировщик заданий)
# Запустить ОДИН раз: ПКМ по файлу -> "Выполнить с помощью PowerShell".
# После этого бэкап пойдёт сам: каждый день в 20:00 и при каждом входе в систему.
$ErrorActionPreference = "Stop"

$ps1 = Join-Path $PSScriptRoot "claude-backup.ps1"
if (-not (Test-Path $ps1)) { Write-Host "Нет файла: $ps1"; exit 1 }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`""

$trigDaily = New-ScheduledTaskTrigger -Daily -At 8:00PM
$trigLogon = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName "Claude sessions backup" `
    -Action $action -Trigger $trigDaily, $trigLogon `
    -Description "Автоматический бэкап сессий Claude Code" -Force | Out-Null

Write-Host "Готово. Автобэкап включён: ежедневно в 20:00 и при входе в систему."
Write-Host "Отключить позже: Планировщик заданий -> задача 'Claude sessions backup' -> Удалить."
