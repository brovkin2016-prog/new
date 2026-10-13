# Remote desktop, the laptop to be reached: installs the official RustDesk as a Windows service (so it is there even at
# the sign-in screen after a reboot), points it at the family server (its own ID and relay servers and their key), sets
# a long permanent password and safe options, keeps the laptop awake on mains power and tells the server this laptop's
# RustDesk ID. Windows PowerShell 5.1. The family server fills in its values and hands the script out for the owner's
# one-line command (see README.md); it asks Windows for administrator rights by itself. Safe to run again.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ([Console]::IsOutputRedirected) { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { } }

# filled in by the server (each inside '...': it refuses values with a quote or a line break)
$Api = '{{API}}'
$Token = '{{TOKEN}}'
$RdHost = '{{HOST}}'
$RdKey = '{{KEY}}'
$RdPassword = '{{PASSWORD}}'

$Version = '1.5.0'
$MsiUrl = "https://github.com/rustdesk/rustdesk/releases/download/$Version/rustdesk-$Version-x86_64.msi"
$MsiSha256 = '624FE792AB1D76B35134DAB84BFF97A6BCD14043FFD090A2C6A2800F77580495'
$Signer = 'PURSLANE'  # the Authenticode signer of RustDesk's official Windows builds
$ServiceName = 'RustDesk'
$PipeName = 'RustDesk\query'  # the service's own channel that rustdesk.exe --config/--password/--option talk through
# where the service keeps its settings (the SYSTEM profile, which RustDesk maps to LocalService)
$ServiceConfig = "$env:windir\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml"
$Options = [ordered]@{
    'approve-mode'                     = 'password'                # in by the password only, no "accept?" on screen
    'verification-method'              = 'use-permanent-password'  # no one-time password
    'enable-lan-discovery'             = 'N'
    'direct-server'                    = 'N'                       # no direct connections bypassing our server
    'allow-remote-config-modification' = 'N'
    'enable-tunnel'                    = 'N'
    'enable-terminal'                  = 'N'
    'enable-camera'                    = 'N'
    'enable-remote-printer'            = 'N'
    'allow-auto-disconnect'            = 'Y'
    'auto-disconnect-timeout'          = '30'                      # minutes without input
    'allow-remove-wallpaper'           = 'Y'                       # a lighter picture on a weak line
}

function Say([string]$Text, [string]$Color) {
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}

function Stop-Here([int]$Code) {
    # the window opened with administrator rights closes on exit: let the owner read it first
    if ($FamilyRemoteRelaunched) { try { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') } catch { } }
    exit $Code
}

function Fail([string]$Text) {
    Say $Text 'Red'
    Stop-Here 1
}

function Test-Admin {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-Elevated([string]$Stale) {
    # The same one-line command again, in a 64-bit Windows PowerShell with administrator rights (Windows asks). That
    # window fetches the script once more: on a weak line it tries a few times, and when it still cannot (or the server
    # says no) it says why and waits for Enter. Without that a failed fetch would close the new window at once.
    $ps = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        $ps = Join-Path $env:windir 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    }
    $url = $Api + '/api/remote/host.ps1?t=' + $Token
    # one line inside "..." on the command line: no double quotes in it (and the values put in have no single ones)
    $lines = @'
$FamilyRemoteRelaunched = 1
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$s = $null; $code = 0
foreach ($i in 1..4) { try { $s = irm '<url>' -TimeoutSec 60 -ErrorAction Stop; break } catch { $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch { }; if ($code -ge 400 -and $code -lt 500) { break }; if ($i -lt 4) { Start-Sleep -Seconds (5 * $i) } } }
if ($s) { $s | iex } else { if ($code -eq 403) { $t = '<stale>' } elseif ($code -eq 429) { $t = 'Слишком много попыток. Подождите 10 минут и запустите команду ещё раз.' } else { $t = 'Не удалось скачать настройку. Проверьте интернет (или включите Winger) и запустите команду ещё раз.' }; Write-Host $t -ForegroundColor Red; [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
'@
    $cmd = (($lines -split "`r?`n" | Where-Object { $_.Trim() }) -join '; ').Replace('<url>', $url).Replace('<stale>', $Stale)
    Say 'Windows сейчас спросит разрешение — нажмите «Да». Настройка продолжится в новом окне.' 'Yellow'
    try {
        Start-Process -FilePath $ps -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -Command "' + $cmd + '"')
    } catch {
        Fail 'Без разрешения Windows настроить не получится. Запустите команду ещё раз и нажмите «Да».'
    }
    exit 0
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
    # "ok", "net" (could not fetch it) or "bad" (fetched, but not the file it must be). A whole file already there is
    # used as is: a weak line need not fetch it twice.
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
            $why = 'bad'  # a whole file, but another one: that is what gets said, whatever the later tries do
        } catch {
        }
        Start-Sleep -Seconds (5 * $try)
    }
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    return $why
}

function Invoke-Wait([string]$File, [string]$Arguments) {
    # Runs a program and waits for it alone (not for what it leaves running); its exit code.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $p = [Diagnostics.Process]::Start($psi)
    $p.WaitForExit()
    return $p.ExitCode
}

function Invoke-Tool([string]$File, [string]$Arguments, [int]$Seconds = 60) {
    # A program run out of sight: @{ Code = its exit code; Text = what it printed }, or $null when it could not be
    # started or hung. (Not "& tool 2>&1": with $ErrorActionPreference Stop, Windows PowerShell 5.1 ends the whole
    # script on the first line a tool writes to its error output.)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    try { $p = [Diagnostics.Process]::Start($psi) } catch { return $null }
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($Seconds * 1000)) {
        try { $p.Kill() } catch { }
        return $null
    }
    [void]$out.Wait(5000)
    [void]$err.Wait(5000)
    $text = ''
    if ($out.IsCompleted) { $text += $out.Result }
    if ($err.IsCompleted) { $text += $err.Result }
    return @{ Code = $p.ExitCode; Text = $text.Trim() }
}

function Invoke-Rd([string]$Exe, [string[]]$Arguments, [int]$Seconds = 60) {
    # rustdesk.exe with a command line setting; what it printed ($null when it hung). Its values are checked to have
    # no spaces or quotes before they get here.
    $r = Invoke-Tool $Exe ($Arguments -join ' ') $Seconds
    if ($r) { return $r.Text }
    return $null
}

function Get-RdExe {
    # The installed rustdesk.exe: where the service runs it from, else the usual place.
    $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    if ($svc -and $svc.PathName -match '^\s*"([^"]+)"') {
        $path = $Matches[1]
        if (Test-Path -LiteralPath $path) { return $path }
    }
    foreach ($base in @($env:ProgramW6432, $env:ProgramFiles)) {
        if ($base) {
            $path = Join-Path $base 'RustDesk\rustdesk.exe'
            if (Test-Path -LiteralPath $path) { return $path }
        }
    }
    return $null
}

function Get-RdVersion([string]$Exe) {
    if (-not $Exe) { return $null }
    $out = Invoke-Rd $Exe @('--version') 30
    if ($out -match '(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    return $null
}

function Wait-RdService([int]$Seconds) {
    $until = (Get-Date).AddSeconds($Seconds)
    do {
        $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($s -and $s.Status -eq 'Running') { return $true }
        if ($s -and $s.Status -eq 'Stopped') { try { Start-Service -Name $ServiceName -ErrorAction Stop } catch { } }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $until)
    return $false
}

function Wait-RdPipe([int]$Seconds) {
    # The service's settings channel answers: only then do --config/--password/--option reach the service (when it
    # does not answer, rustdesk.exe quietly keeps them for this Windows user instead).
    $until = (Get-Date).AddSeconds($Seconds)
    do {
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect(2000)
            return $true
        } catch {
        } finally {
            $pipe.Dispose()
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $until)
    return $false
}

function Read-TomlOptions([string]$Path) {
    # The [options] table of a RustDesk .toml file; $null when the file cannot be read, "missing" when it is not there.
    try {
        $lines = [IO.File]::ReadAllLines($Path)
    } catch [System.IO.FileNotFoundException] {
        return 'missing'
    } catch [System.IO.DirectoryNotFoundException] {
        return 'missing'
    } catch {
        return $null
    }
    $opts = @{}
    $inside = $false
    foreach ($line in $lines) {
        $t = $line.Trim()
        if ($t -match '^\[') {
            $inside = $t -match '^\[\s*options\s*\]'
            continue
        }
        if ($inside -and $t -match '^"?([A-Za-z0-9_-]+)"?\s*=\s*(.*)$') {
            $k = $Matches[1]
            $v = $Matches[2].Trim()
            if ($v -match "^'(.*)'$") {
                $v = $Matches[1]
            } elseif ($v -match '^"(.*)"$') {
                $v = $Matches[1].Replace('\"', '"').Replace('\\', '\')
            }
            $opts[$k] = $v
        }
    }
    return $opts
}

function Test-RdSettings {
    # $true when the service's own settings file has our server and options, $false when it has not, $null when
    # Windows does not let it be read (then the settings are taken on trust).
    $want = [ordered]@{ 'custom-rendezvous-server' = $RdHost; 'relay-server' = ($RdHost + ':21117'); 'key' = $RdKey; 'stop-service' = '' }
    foreach ($k in $Options.Keys) { $want[$k] = $Options[$k] }
    $until = (Get-Date).AddSeconds(15)
    do {
        $have = Read-TomlOptions $ServiceConfig
        if ($null -eq $have) { return $null }
        $ok = $have -is [hashtable]
        if ($ok) { foreach ($k in $want.Keys) { if ([string]$have[$k] -cne $want[$k]) { $ok = $false; break } } }
        if ($ok) { return $true }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $until)
    return $false
}

function Set-RdSettings([string]$Exe) {
    # --config sends the service this Windows user's own copy of the options with the server put in, so it goes
    # first; a "stop-service" an earlier RustDesk may have left in that copy is taken out again right after it
    $cfg = 'host=' + $RdHost + ',relay=' + $RdHost + ':21117,key=' + $RdKey + ','
    [void](Invoke-Rd $Exe @('--config', $cfg))
    [void](Invoke-Rd $Exe @('--option', 'stop-service', '""'))
    foreach ($k in $Options.Keys) { [void](Invoke-Rd $Exe @('--option', $k, $Options[$k])) }
}

function Get-RdId([string]$Exe) {
    # This laptop's ID once it holds still: on its first sign-up the server may hand out a new one.
    $last = $null
    $until = (Get-Date).AddSeconds(40)
    do {
        $out = Invoke-Rd $Exe @('--get-id') 30
        $id = if ($out) { ($out -split '\s+')[-1] } else { '' }
        if ($id -match '^[0-9a-zA-Z_-]{6,16}$') {
            if ($id -eq $last) { return $id }
            $last = $id
        }
        Start-Sleep -Seconds 4
    } while ((Get-Date) -lt $until)
    return $null
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

function Send-Hello([string]$Id) {
    # 200, or the server's answer (403 an old command, 429 too many tries), or 0 when it could not be reached.
    $body = @{ t = $Token; id = $Id } | ConvertTo-Json -Compress
    for ($try = 1; $try -le 4; $try++) {
        try {
            [void](Invoke-RestMethod -Method Post -Uri ($Api + '/api/remote/hello') -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 30)
            return 200
        } catch {
            $code = 0
            try { $code = [int]$_.Exception.Response.StatusCode } catch { }
            if ($code -ge 400 -and $code -lt 500) { return $code }
        }
        Start-Sleep -Seconds (3 * $try)
    }
    return 0
}

function Set-AwakeOnPower {
    # On mains power: never sleep, and a closed lid does nothing. $false when Windows did not take it.
    $powercfg = Join-Path $env:windir 'System32\powercfg.exe'
    $ok = $true
    $r = Invoke-Tool $powercfg '/change standby-timeout-ac 0'
    if (-not $r -or $r.Code -ne 0) { $ok = $false }
    [void](Invoke-Tool $powercfg '/change hibernate-timeout-ac 0')  # may be off altogether: then nothing to change
    $r = Invoke-Tool $powercfg '/setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0'
    if (-not $r -or $r.Code -ne 0) { $ok = $false }
    $r = Invoke-Tool $powercfg '/setactive SCHEME_CURRENT'
    if (-not $r -or $r.Code -ne 0) { $ok = $false }
    return $ok
}

function Main {
    try { $Host.UI.RawUI.WindowTitle = 'Удалённый доступ к ноутбуку' } catch { }
    $stale = 'Команда повреждена или устарела. Скопируйте её в приложении заново («Управление» → «Сервер» → «Удалённый доступ») и запустите ещё раз.'
    if ($Api -notmatch '^https?://[A-Za-z0-9.:-]+$' -or $Token -notmatch '^[0-9a-f]{32}$') { Fail $stale }
    if ($RdHost -notmatch '^[A-Za-z0-9.-]+$' -or $RdKey -notmatch '^[A-Za-z0-9+/=]{40,64}$' -or $RdPassword -notmatch '^[A-Za-z0-9]{8,64}$') { Fail $stale }
    if ([Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem) {
        Fail 'Нужна 64-битная Windows 10 или 11 — на этом компьютере настроить не получится.'
    }
    if (-not (Test-Admin) -or -not [Environment]::Is64BitProcess) { Start-Elevated $stale }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    Say 'Настраиваю удалённый доступ к этому ноутбуку…' 'Cyan'

    # 1. RustDesk itself
    $exe = Get-RdExe
    $have = Get-RdVersion $exe
    if ($have -and $have -ge [version]$Version) {
        Say "1/5 RustDesk $have уже установлен."
    } else {
        $work = Join-Path $env:TEMP 'FamilyRemote'
        [void](New-Item -ItemType Directory -Force -Path $work)
        $msi = Join-Path $work "rustdesk-$Version-x86_64.msi"
        Say "1/5 Скачиваю RustDesk $Version (около 25 МБ)…"
        $got = Save-Download $MsiUrl $msi $MsiSha256
        if ($got -eq 'net') { Fail 'Не удалось скачать RustDesk. Проверьте интернет (или включите Winger) и запустите команду ещё раз.' }
        if ($got -ne 'ok' -or -not (Test-Signer $msi)) {
            Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
            Fail 'Скачанный файл не прошёл проверку (повреждён или подменён). Запустите команду ещё раз, лучше через другой интернет.'
        }
        Say '    Устанавливаю…'
        $log = Join-Path $work 'rustdesk-install.log'
        $msiexec = Join-Path $env:windir 'System32\msiexec.exe'
        $code = -1
        for ($try = 1; $try -le 3; $try++) {
            $code = Invoke-Wait $msiexec ('/i "' + $msi + '" /qn /norestart CREATEDESKTOPSHORTCUTS=N INSTALLPRINTER=N /l*v "' + $log + '"')
            if ($code -ne 1618) { break }  # another installation is running: wait for it
            Start-Sleep -Seconds 30
        }
        if ($code -eq 1618) { Fail 'Windows сейчас занята другой установкой. Подождите пару минут и запустите команду ещё раз.' }
        if ($code -eq 1602) { Fail 'Установку отменили. Запустите команду ещё раз.' }
        if ($code -ne 0 -and $code -ne 3010 -and $code -ne 1641) {
            Fail "Не получилось установить RustDesk (код $code). Если на ноутбуке уже есть другой RustDesk — удалите его в «Параметры» → «Приложения» и запустите команду ещё раз."
        }
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        $exe = Get-RdExe
        if (-not $exe) { Fail 'RustDesk не установился. Перезагрузите ноутбук и запустите команду ещё раз.' }
    }

    # 2. the service: starts with Windows, before anyone signs in
    Say '2/5 Запускаю службу RustDesk…'
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        [void](Invoke-Wait $exe '--install-service')
    }
    try { Set-Service -Name $ServiceName -StartupType Automatic -ErrorAction Stop } catch { }
    [void](Invoke-Tool (Join-Path $env:windir 'System32\sc.exe') "failure $ServiceName reset= 86400 actions= restart/10000/restart/10000/restart/60000")
    $restartHint = 'Служба RustDesk не отвечает. Перезагрузите ноутбук и запустите команду ещё раз.'
    if (-not (Wait-RdService 90)) { Fail $restartHint }
    if (-not (Wait-RdPipe 90)) { Fail $restartHint }

    # 3. our server, the password and safe options
    Say '3/5 Подключаю к нашему серверу и включаю защиту…'
    Set-RdSettings $exe
    $out = Invoke-Rd $exe @('--password', $RdPassword)
    if ($out -notmatch 'Done') {
        Start-Sleep -Seconds 3
        [void](Wait-RdPipe 30)
        $out = Invoke-Rd $exe @('--password', $RdPassword)
        if ($out -notmatch 'Done') { Fail 'Не получилось задать пароль. Перезагрузите ноутбук и запустите команду ещё раз.' }
    }
    $ok = Test-RdSettings
    if ($ok -eq $false) {
        [void](Wait-RdPipe 30)
        Set-RdSettings $exe
        $ok = Test-RdSettings
    }
    if ($ok -eq $false) { Fail 'RustDesk не принял настройки. Перезагрузите ноутбук и запустите команду ещё раз.' }
    $id = Get-RdId $exe
    if (-not $id) { Fail 'Не удалось узнать номер ноутбука в RustDesk. Перезагрузите ноутбук и запустите команду ещё раз.' }

    # 4. awake on mains power
    if (Set-AwakeOnPower) {
        Say '4/5 Питание: когда ноутбук подключён к сети, он не засыпает, даже с закрытой крышкой — так он всегда на связи.'
    } else {
        Say '4/5 Настройки питания поменять не вышло: проверьте сами, чтобы от сети ноутбук не засыпал.' 'Yellow'
    }

    # 5. the app learns this laptop's ID
    Say '5/5 Сообщаю номер ноутбука приложению…'
    $code = Send-Hello $id
    if ($code -eq 403) { Fail $stale }
    if ($code -eq 429) { Fail 'Слишком много попыток. Подождите 10 минут и запустите команду ещё раз.' }
    if ($code -ne 200) { Fail 'Ноутбук настроен, но приложение не узнало его номер. Проверьте интернет и запустите команду ещё раз.' }

    $far = @(21116, 21117) | Where-Object { -not (Test-Port $RdHost $_) }
    if ($far) {
        Say 'Сейчас ноутбук не достаёт до сервера удалённого доступа. Настройки сохранены — подключение заработает, когда связь появится.' 'Yellow'
    }
    Say ''
    Say 'Готово! К этому ноутбуку можно подключаться удалённо — даже к экрану входа после перезагрузки.' 'Green'
    Say "Номер ноутбука в RustDesk: $id"
    Say 'Подключаться — из приложения: «Управление» → «Сервер» → «Удалённый доступ».'
    Say 'Совет: для ещё большей защиты можно включить код из приложения-аутентификатора — RustDesk → «Настройки» → «Безопасность» → «Использовать двухфакторную аутентификацию».' 'DarkGray'
    Stop-Here 0
}

try {
    Main
} catch {
    Fail ('Что-то пошло не так: ' + $_.Exception.Message + ' Запустите команду ещё раз.')
}
