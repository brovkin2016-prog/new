# Remote desktop, another Windows laptop that connects to the owner's one: the official portable RustDesk, named so
# that it uses the family server and its key (RustDesk reads "host=…,key=…," from its own file name), defaults for a
# quick response on a weak line, a desktop shortcut straight to the owner's laptop and the password on the clipboard
# for the first connection. Windows PowerShell 5.1, no administrator rights. The family server fills in its values and
# hands the script out for the owner's one-line command (see README.md). Safe to run again.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { } }

# filled in by the server (each inside '...': it refuses values with a quote or a line break)
$RdHost = '{{HOST}}'
$RdKey = '{{KEY}}'
$RdPassword = '{{PASSWORD}}'
$LaptopId = '{{ID}}'

$Version = '1.5.0'
$ExeUrl = "https://github.com/rustdesk/rustdesk/releases/download/$Version/rustdesk-$Version-x86_64.exe"
$ExeSha256 = '8555777215510D83D2D61C9DC984E4FCC838BD7E79F9D18A42585431F5E8BB47'
$Signer = 'PURSLANE'  # the Authenticode signer of RustDesk's official Windows builds
$ShortcutName = 'Ноутбук (удалённо)'
# "Optimize reaction time" for every new connection (RustDesk_default.toml holds the defaults for new peers)
$Defaults = [ordered]@{
    'image_quality'        = 'low'
    'custom_image_quality' = '30'  # these two count only when "custom" is picked in a session
    'custom-fps'           = '15'
    'show_quality_monitor' = 'Y'   # speed, delay and frames per second in a corner of the session
}

function Say([string]$Text, [string]$Color) {
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}

function Fail([string]$Text) {
    Say $Text 'Red'
    exit 1
}

function Test-Sha([string]$Path, [string]$Sha256) {
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256 } catch { return $false }
}

function Test-Signer([string]$Path) {
    try {
        $sig = Get-AuthenticodeSignature -FilePath $Path
        if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate) { return $false }
        $name = $sig.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        return $name -eq $Signer
    } catch { return $false }
}

function Save-Download([string]$Url, [string]$Path, [string]$Sha256) {
    # "ok", "net" (could not fetch it) or "bad" (fetched, but not the file it must be).
    if (Test-Sha $Path $Sha256) { return 'ok' }
    $part = $Path + '.part'
    $why = 'net'
    for ($try = 1; $try -le 4; $try++) {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        try {
            if ($try -lt 4) {
                Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing -TimeoutSec 60
            } elseif (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
                Start-BitsTransfer -Source $Url -Destination $part -ErrorAction Stop  # resumes over a broken line
            } else {
                break
            }
            if (Test-Sha $part $Sha256) {
                Move-Item -LiteralPath $part -Destination $Path -Force
                return 'ok'
            }
            if (Test-Path -LiteralPath $part) { $why = 'bad' }  # (gone at once: an antivirus took it)
        } catch {
        }
        Start-Sleep -Seconds (5 * $try)
    }
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    return $why
}

function Set-TomlOptions([string]$Path, $Values) {
    # Sets keys in the [options] table of a RustDesk .toml file and keeps everything else in it as it was.
    $lines = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $Path) {
        foreach ($l in [IO.File]::ReadAllLines($Path)) { $lines.Add($l) }
    }
    $start = -1
    $end = $lines.Count
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].Trim()
        if ($t -match '^\[') {
            if ($start -ge 0) { $end = $i; break }
            if ($t -match '^\[\s*options\s*\]') { $start = $i }
        }
    }
    if ($start -lt 0) {
        if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim()) { $lines.Add('') }
        $lines.Add('[options]')
        $start = $lines.Count - 1
        $end = $lines.Count
    }
    $left = [ordered]@{}
    foreach ($k in $Values.Keys) { $left[$k] = $Values[$k] }
    for ($i = $start + 1; $i -lt $end; $i++) {
        if ($lines[$i] -match '^\s*"?([A-Za-z0-9_-]+)"?\s*=') {
            $k = $Matches[1]
            if ($left.Contains($k)) {
                $lines[$i] = $k + " = '" + $left[$k] + "'"
                $left.Remove($k)
            }
        }
    }
    $at = $end
    while ($at -gt $start + 1 -and -not $lines[$at - 1].Trim()) { $at-- }  # right after the table's last line
    foreach ($k in @($left.Keys)) {
        $lines.Insert($at, $k + " = '" + $left[$k] + "'")
        $at++
    }
    [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path))
    [IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
}

function Test-Port([string]$HostName, [int]$Port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $r = $c.BeginConnect($HostName, $Port, $null, $null)
        if (-not $r.AsyncWaitHandle.WaitOne(5000)) { return $false }
        $c.EndConnect($r)
        return $true
    } catch {
        return $false
    } finally {
        $c.Close()
    }
}

function Main {
    try { $Host.UI.RawUI.WindowTitle = 'Удалённый доступ: этот ноутбук подключается' } catch { }
    $stale = 'Команда повреждена или устарела. Скопируйте её в приложении заново («Управление» → «Сервер» → «Удалённый доступ») и запустите ещё раз.'
    # the key goes into a file name: no "/" there (the server's own keys never have one)
    if ($RdHost -notmatch '^[A-Za-z0-9.-]+$' -or $RdKey -notmatch '^[A-Za-z0-9+=]{40,64}$' -or $RdPassword -notmatch '^[A-Za-z0-9]{8,64}$') { Fail $stale }
    if (-not $LaptopId) {
        Fail 'Сначала настройте сам ноутбук: в приложении «Управление» → «Сервер» → «Удалённый доступ» → «Этот ноутбук». Потом скопируйте эту команду заново и запустите её ещё раз.'
    }
    if ($LaptopId -notmatch '^[0-9a-zA-Z_-]{6,16}$') { Fail $stale }
    if ([Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem) {
        Fail 'Нужна 64-битная Windows 10 или 11 — на этом компьютере настроить не получится.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Say 'Настраиваю подключение к вашему ноутбуку…' 'Cyan'

    # 1. RustDesk, portable, under a name that carries our server and its key
    $dir = Join-Path $env:LOCALAPPDATA 'FamilyRemote'
    [void](New-Item -ItemType Directory -Force -Path $dir)
    $name = 'rustdesk-host=' + $RdHost + ',key=' + $RdKey + ',.exe'
    $exe = Join-Path $dir $name
    if (Test-Sha $exe $ExeSha256) {
        Say "1/4 RustDesk $Version уже скачан."
    } else {
        Say "1/4 Скачиваю RustDesk $Version (около 25 МБ)…"
        $file = Join-Path $dir "rustdesk-$Version-x86_64.exe"
        $got = Save-Download $ExeUrl $file $ExeSha256
        if ($got -eq 'net') {
            Fail 'Не удалось скачать RustDesk. Проверьте интернет (или включите Winger) и запустите команду ещё раз. Если повторится — возможно, файл убирает антивирус: разрешите RustDesk.'
        }
        if ($got -ne 'ok' -or -not (Test-Signer $file)) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            Fail 'Скачанный файл не прошёл проверку (повреждён или подменён). Запустите команду ещё раз, лучше через другой интернет.'
        }
        try {
            Move-Item -LiteralPath $file -Destination $exe -Force
        } catch {
            Fail 'RustDesk сейчас открыт. Закройте его окно и запустите команду ещё раз.'
        }
    }
    # copies named for another server or key (the server was moved) are of no use any more
    Get-ChildItem -LiteralPath $dir -Filter 'rustdesk-host=*.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne $name } | Remove-Item -Force -ErrorAction SilentlyContinue

    # 2. a quick response over a picture's quality
    Say '2/4 Включаю «Лучшее время отклика» — для слабого интернета.'
    try {
        Set-TomlOptions (Join-Path $env:APPDATA 'RustDesk\config\RustDesk_default.toml') $Defaults
    } catch {
        Say '    Не вышло — можно выбрать это в окне подключения (значок экрана).' 'Yellow'
    }

    # 3. the shortcut
    Say "3/4 Создаю ярлык «$ShortcutName» на рабочем столе…"
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($ShortcutName + '.lnk')
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath = $exe
        $sc.Arguments = '--connect ' + $LaptopId
        $sc.WorkingDirectory = $dir
        $sc.IconLocation = $exe + ',0'
        $sc.Description = 'Подключиться к ноутбуку'
        $sc.Save()
    } catch {
        Fail 'Не получилось создать ярлык на рабочем столе. Запустите команду ещё раз.'
    }

    # 4. the password for the first connection (RustDesk then remembers it)
    try {
        Set-Clipboard -Value $RdPassword
        Say '4/4 Пароль в буфере: при первом подключении вставьте его и отметьте «Запомнить пароль».'
    } catch {
        Say '4/4 Пароль в буфер положить не вышло: возьмите его в приложении («Удалённый доступ» → «Показать») и при первом подключении отметьте «Запомнить пароль».' 'Yellow'
    }

    $far = @(21116, 21117) | Where-Object { -not (Test-Port $RdHost $_) }
    if ($far) {
        Say 'Сейчас этот ноутбук не достаёт до сервера удалённого доступа. Проверьте интернет (или включите Winger).' 'Yellow'
    }
    Say ''
    Say "Готово! Откройте ярлык «$ShortcutName» на рабочем столе — и вы на своём ноутбуке." 'Green'
    Say 'Качество или отклик — переключатель в окне подключения (значок экрана).'
    exit 0
}

try {
    Main
} catch {
    Fail ('Что-то пошло не так: ' + $_.Exception.Message + ' Запустите команду ещё раз.')
}
