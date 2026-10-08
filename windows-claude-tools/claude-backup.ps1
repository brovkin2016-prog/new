# claude-backup.ps1  —  бэкап сессий Claude Code (Windows)
# Копирует ~/.claude/projects и settings.json в папку-назначение (можно OneDrive/Google Drive).
$ErrorActionPreference = "Stop"

# ===== НАСТРОЙКА: куда складывать копию (поменяйте при желании) =====
$Dest = "$env:USERPROFILE\OneDrive\Claude-Backup"
# Если OneDrive не используете, напр.: $Dest = "D:\Claude-Backup"
# ====================================================================

$Src = "$env:USERPROFILE\.claude"
$log = "$env:USERPROFILE\claude-backup.log"

if (-not (Test-Path "$Src\projects")) {
    Write-Host "Не найдено: $Src\projects  — Claude Code не установлен или сессий ещё нет."
    exit 1
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# Зеркалим транскрипты. /MIR = копия точно повторяет оригинал (robocopy — штатный в Windows).
robocopy "$Src\projects" "$Dest\projects" /MIR /R:2 /W:2 /NFL /NDL /NP /LOG+:$log | Out-Null

# Настройки (если есть)
if (Test-Path "$Src\settings.json") { Copy-Item "$Src\settings.json" "$Dest\settings.json" -Force }

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $log "[$stamp] backup OK -> $Dest"
Write-Host "Готово: сессии скопированы в  $Dest   ($stamp)"
