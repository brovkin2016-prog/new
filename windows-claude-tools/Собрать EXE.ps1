# Собрать EXE.ps1  —  превращает программу в claude-session-manager.exe
# Запустить ОДИН раз на Windows. Нужен интернет (один раз качается модуль ps2exe).
$ErrorActionPreference = "Stop"

$dir = $PSScriptRoot
$src = Join-Path $dir "claude-session-manager.ps1"
$out = Join-Path $dir "claude-session-manager.exe"
$ico = Join-Path $dir "app.ico"   # если положите рядом иконку app.ico — подхватится

if (-not (Test-Path $src)) { Write-Host "Не найден $src"; pause; exit 1 }

# NuGet-провайдер и доверие галерее (чтобы Install-Module не задавал вопросов)
try { Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null } catch {}
try { Set-PSRepository -Name PSGallery -InstallationPolicy Trusted } catch {}

if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Устанавливаю модуль ps2exe (разово)..."
    Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber
}
Import-Module ps2exe

Write-Host "Собираю exe..."
$params = @{
    inputFile   = $src
    outputFile  = $out
    noConsole   = $true
    STA         = $true
    title       = "Claude Session Manager"
    product     = "Claude Session Manager"
    description = "Бэкап и восстановление сессий Claude Code"
}
if (Test-Path $ico) { $params.iconFile = $ico }
Invoke-ps2exe @params

Write-Host ""
if (Test-Path $out) { Write-Host "ГОТОВО: $out" } else { Write-Host "Сборка не удалась." }
pause
