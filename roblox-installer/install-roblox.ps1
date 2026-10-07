# Установщик Roblox для Windows 10/11.
# Скачивает официальный RobloxPlayerInstaller.exe с roblox.com, проверяет цифровую
# подпись Roblox Corporation и запускает установку. Права администратора не нужны.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$DownloadUrl = 'https://www.roblox.com/download/client?os=win'
$StoreId     = '9NBLGGGZM6WM'   # Roblox в Microsoft Store
$Installer   = Join-Path $env:TEMP 'RobloxPlayerInstaller.exe'

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }

function Test-RobloxInstalled {
    $versions = Join-Path $env:LOCALAPPDATA 'Roblox\Versions'
    return [bool](Get-ChildItem $versions -Recurse -Filter 'RobloxPlayerBeta.exe' -ErrorAction SilentlyContinue)
}

function Install-FromSite {
    Say 'Скачиваю установщик с roblox.com...' Cyan
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $Installer -UseBasicParsing `
        -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

    $sig = Get-AuthenticodeSignature $Installer
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Roblox Corporation') {
        Remove-Item $Installer -Force -ErrorAction SilentlyContinue
        throw "Подпись файла не прошла проверку ($($sig.Status)). Файл удалён."
    }
    Say 'Подпись Roblox Corporation подтверждена. Запускаю установку...' Green
    Start-Process -FilePath $Installer -Wait
    Remove-Item $Installer -Force -ErrorAction SilentlyContinue
}

function Install-FromStore {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget не найден.' }
    Say 'Пробую установить через Microsoft Store (winget)...' Cyan
    winget install --id $StoreId --source msstore --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget завершился с кодом $LASTEXITCODE." }
}

Say '=== Установка Roblox ===' Yellow

if (Test-RobloxInstalled) {
    $answer = Read-Host 'Roblox уже установлен. Переустановить? (y/n)'
    if ($answer -notmatch '^[yYдД]') { Say 'Отменено.'; Read-Host 'Нажмите Enter для выхода'; exit 0 }
}

try {
    Install-FromSite
} catch {
    Say "Не удалось установить с сайта: $($_.Exception.Message)" Red
    try {
        Install-FromStore
    } catch {
        Say "Не удалось установить через Store: $($_.Exception.Message)" Red
        Say 'Открываю страницу загрузки в браузере — скачайте вручную.' Yellow
        Start-Process 'https://www.roblox.com/download'
        Read-Host 'Нажмите Enter для выхода'
        exit 1
    }
}

if (Test-RobloxInstalled) {
    Say 'Готово! Roblox установлен. Ярлык "Roblox Player" — на рабочем столе и в меню Пуск.' Green
} else {
    Say 'Установка завершена. Если ярлыка нет — откройте roblox.com, войдите и нажмите «Играть».' Yellow
}
Read-Host 'Нажмите Enter для выхода'
