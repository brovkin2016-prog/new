# claude-restore.ps1  —  восстановить сессии на другом/новом ПК (Windows)
# Переносит транскрипты из бэкапа в ~/.claude. НЕ трогает авторизацию (~/.claude.json),
# поэтому подходит и для той же, и для другой учётной записи Claude.
$ErrorActionPreference = "Stop"

# ===== НАСТРОЙКА: откуда брать бэкап (та же папка, что в claude-backup.ps1) =====
$Src = "$env:USERPROFILE\OneDrive\Claude-Backup"
# ===============================================================================

$Dest = "$env:USERPROFILE\.claude"

if (-not (Test-Path "$Src\projects")) {
    Write-Host "Бэкап не найден: $Src\projects"
    exit 1
}

New-Item -ItemType Directory -Force -Path "$Dest\projects" | Out-Null

# /E = копируем всё, существующие файлы обновляем, свои НЕ удаляем (безопасно).
robocopy "$Src\projects" "$Dest\projects" /E /R:2 /W:2 /NFL /NDL /NP | Out-Null
if (Test-Path "$Src\settings.json") { Copy-Item "$Src\settings.json" "$Dest\settings.json" -Force }

Write-Host "Восстановлено в $Dest"
Write-Host "Проверьте: откройте папку проекта и выполните  claude --resume"
