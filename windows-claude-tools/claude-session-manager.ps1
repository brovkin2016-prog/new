param([switch]$Backup, [switch]$Reminder)

# =====================================================================
#  Claude Session Manager (Windows)
#  - Бэкап/восстановление сессий Claude Code
#  - Сбор экспорта чатов приложения Claude в бэкап
#  - Автозахват по расписанию, мгновенный захват (junction), примечания
#  Ключи: -Backup  = тихий бэкап (+сбор экспорта) для автозадачи
#         -Reminder= напоминание выгрузить чаты
#  Работает из ЛЮБОЙ папки (можно держать на диске E:).
# =====================================================================

# --- пути и конфиг ---
if ($PSScriptRoot) { $ScriptDir = $PSScriptRoot } else { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ScriptPath = $PSCommandPath
if (-not $ScriptPath) { $ScriptPath = Join-Path $ScriptDir "claude-session-manager.ps1" }
$CfgPath    = Join-Path $ScriptDir "claude-session-manager.config.json"
$ClaudeDir  = Join-Path $env:USERPROFILE ".claude"
$ProjSrc    = Join-Path $ClaudeDir "projects"

function Load-Cfg {
    $def = [ordered]@{
        Dest       = (Join-Path $env:USERPROFILE "OneDrive\Claude-Backup")
        Downloads  = (Join-Path $env:USERPROFILE "Downloads")
        Notes      = ""
        LastBackup = ""
    }
    if (Test-Path $CfgPath) {
        try {
            $j = Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.Dest)       { $def.Dest = $j.Dest }
            if ($j.Downloads)  { $def.Downloads = $j.Downloads }
            if ($null -ne $j.Notes) { $def.Notes = [string]$j.Notes }
            if ($j.LastBackup) { $def.LastBackup = $j.LastBackup }
        } catch {}
    }
    return $def
}
function Save-Cfg($cfg) {
    try { ($cfg | ConvertTo-Json) | Set-Content $CfgPath -Encoding UTF8 } catch {}
}

$cfg = Load-Cfg

function Count-Sessions {
    if (Test-Path $ProjSrc) { return (Get-ChildItem $ProjSrc -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue).Count }
    return 0
}

# --- бэкап сессий (синхронно, для тихого режима) ---
function Run-Backup($dest) {
    if (-not (Test-Path $ProjSrc)) { return "Нет папки сессий: $ProjSrc" }
    if ([string]::IsNullOrWhiteSpace($dest)) { return "Не указана папка бэкапа." }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    robocopy $ProjSrc (Join-Path $dest "projects") /MIR /R:1 /W:1 /MT:16 /NFL /NDL /NP /NJH /NJS | Out-Null
    $code = $LASTEXITCODE
    $s = Join-Path $ClaudeDir "settings.json"
    if (Test-Path $s) { Copy-Item $s (Join-Path $dest "settings.json") -Force }
    if ($code -lt 8) { return "OK: бэкап в $dest" } else { return "robocopy вернул код $code (ошибка)" }
}

# --- сбор скачанного экспорта чатов claude.ai из Загрузок в бэкап ---
function Collect-ChatExports($dest) {
    if ([string]::IsNullOrWhiteSpace($dest)) { return "Не указана папка бэкапа." }
    $dl = $cfg.Downloads
    if ([string]::IsNullOrWhiteSpace($dl) -or -not (Test-Path $dl)) { $dl = Join-Path $env:USERPROFILE "Downloads" }
    if (-not (Test-Path $dl)) { return "Папка Загрузок не найдена." }
    $out = Join-Path $dest "chat-exports"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    $patterns = @("conversations*.json","data-*.json","data-*.zip","claude*export*.zip","*anthropic*.zip")
    $since = (Get-Date).AddDays(-120)
    $existing = @(Get-ChildItem $out -File -ErrorAction SilentlyContinue)
    $n = 0
    foreach ($p in $patterns) {
        $files = @(Get-ChildItem -Path $dl -Filter $p -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $since })
        foreach ($f in $files) {
            $dup = $existing | Where-Object { $_.Name.EndsWith("__" + $f.Name) -and $_.Length -eq $f.Length }
            if ($dup) { continue }
            $dstName = "{0}__{1}" -f $f.LastWriteTime.ToString("yyyy-MM-dd_HHmmss"), $f.Name
            Copy-Item $f.FullName (Join-Path $out $dstName) -Force
            $n++
        }
    }
    return "Экспорт чатов: собрано новых файлов — $n (папка chat-exports)"
}

# --- тихий режим: напоминание ---
if ($Reminder) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
        "Пора сохранить чаты Claude.`n`nОткройте: claude.ai -> Settings -> Privacy -> Export data.`nСкачайте архив — программа сама заберёт его в бэкап.",
        "Напоминание: экспорт чатов Claude",
        [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    try { Start-Process "https://claude.ai/settings" } catch {}
    exit 0
}

# --- тихий режим: бэкап + сбор экспорта (для автозадачи) ---
if ($Backup) {
    Run-Backup $cfg.Dest | Out-Null
    Collect-ChatExports $cfg.Dest | Out-Null
    $cfg.LastBackup = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    Save-Cfg $cfg
    exit 0
}

# =========================  GUI  =========================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# если что-то упадёт при запуске — покажем текст ошибки и запишем в файл рядом
trap {
    $msg = ($_ | Out-String) + "`r`n--- где ---`r`n" + $_.ScriptStackTrace
    try { Set-Content -LiteralPath (Join-Path $ScriptDir "ОШИБКА-запуска.txt") -Value $msg -Encoding UTF8 } catch {}
    try { [System.Windows.Forms.MessageBox]::Show($msg, "Ошибка запуска программы") } catch {}
    exit 1
}

$clrBg    = [System.Drawing.Color]::FromArgb(243,244,249)
$clrCard  = [System.Drawing.Color]::White
$clrAcc   = [System.Drawing.Color]::FromArgb(67,56,202)
$clrAcc2  = [System.Drawing.Color]::FromArgb(79,70,229)
$clrGreen = [System.Drawing.Color]::FromArgb(5,150,105)
$clrText  = [System.Drawing.Color]::FromArgb(31,41,55)
$clrGrey  = [System.Drawing.Color]::FromArgb(107,114,128)
$fontUI   = New-Object System.Drawing.Font("Segoe UI",9.5)
$fontB    = New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)
$fontSm   = New-Object System.Drawing.Font("Segoe UI",8.5,[System.Drawing.FontStyle]::Bold)
$fontSec  = New-Object System.Drawing.Font("Segoe UI",10.5,[System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Claude Session Manager"
$form.Size = New-Object System.Drawing.Size(702,728)
$form.StartPosition = "CenterScreen"
$form.BackColor = $clrBg
$form.Font = $fontUI
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false

function Add-Label($text,$x,$y,$w,$h,$font,$color) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x,$y)
    $l.Size = New-Object System.Drawing.Size($w,$h)
    if ($font) { $l.Font = $font }
    if ($color) { $l.ForeColor = $color }
    $form.Controls.Add($l); return $l
}
function New-Btn($text,$x,$y,$w,$h,$font,$accent) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x,$y)
    $b.Size = New-Object System.Drawing.Size($w,$h)
    $b.FlatStyle = "Flat"; $b.Font = $font
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    if ($accent) {
        $b.BackColor = $clrAcc; $b.ForeColor = [System.Drawing.Color]::White
        $b.FlatAppearance.BorderSize = 0
        $b.FlatAppearance.MouseOverBackColor = $clrAcc2
    } else {
        $b.BackColor = $clrCard; $b.ForeColor = $clrText
        $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(209,213,219)
        $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(236,238,246)
    }
    $form.Controls.Add($b); return $b
}

# --- шапка ---
Add-Label "Claude Session Manager" 18 14 664 28 (New-Object System.Drawing.Font("Segoe UI",14,[System.Drawing.FontStyle]::Bold)) $clrAcc | Out-Null
$lblStatus = Add-Label "" 18 46 664 18 $null $clrGrey

# --- Раздел 1: сессии Claude Code ---
Add-Label "1. Сессии Claude Code  —  бэкап и восстановление" 18 76 664 18 $fontSec $clrAcc | Out-Null

Add-Label "Папка бэкапа (копировать сюда / восстанавливать отсюда):" 18 100 664 16 $null $clrText | Out-Null
$txtDest = New-Object System.Windows.Forms.TextBox
$txtDest.Location = New-Object System.Drawing.Point(18,120)
$txtDest.Size = New-Object System.Drawing.Size(548,24)
$txtDest.Text = $cfg.Dest
$form.Controls.Add($txtDest)

$btnBrowse = New-Btn "Обзор…" 574 119 108 26 $fontUI $false

$btnBackup  = New-Btn "⬆  Сделать бэкап" 18 154 325 42 $fontB $true
$btnRestore = New-Btn "⬇  Восстановить сессии" 357 154 325 42 $fontB $true

$btnOpenSess = New-Btn "Папка сессий" 18 204 160 34 $fontSm $false
$btnOpenBak  = New-Btn "Папка бэкапа" 186 204 160 34 $fontSm $false
$btnAuto     = New-Btn "Автозахват: вкл." 354 204 160 34 $fontSm $false
$btnJunc     = New-Btn "Мгновенно: вкл." 522 204 160 34 $fontSm $false

# --- Раздел 2: чаты приложения Claude ---
Add-Label "2. Чаты приложения Claude  —  экспорт в бэкап" 18 250 664 18 $fontSec $clrAcc | Out-Null

$btnExport  = New-Btn "Открыть экспорт на claude.ai" 18 274 215 34 $fontSm $false
$btnCollect = New-Btn "Собрать экспорт в бэкап" 241 274 215 34 $fontSm $false
$btnRemind  = New-Btn "Напоминание 1×мес: вкл." 464 274 218 34 $fontSm $false

Add-Label ("Нажмите «Экспорт», запросите архив на claude.ai и скачайте его — он сам попадёт в бэкап " +
           "(при автозахвате или кнопкой «Собрать»).") 18 312 664 30 $null $clrGrey | Out-Null

# --- лог ---
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ScrollBars = "Vertical"; $log.ReadOnly = $true
$log.Location = New-Object System.Drawing.Point(18,348)
$log.Size = New-Object System.Drawing.Size(664,84)
$log.BackColor = [System.Drawing.Color]::FromArgb(249,250,251)
$form.Controls.Add($log)
function Log($m) { $log.AppendText(("[{0}] {1}`r`n" -f (Get-Date -Format "HH:mm:ss"), $m)) }

# --- примечания ---
Add-Label "Мои примечания (хранятся локально рядом с программой, только для вас):" 18 442 664 18 $fontB $clrText | Out-Null
$txtNotes = New-Object System.Windows.Forms.TextBox
$txtNotes.Multiline = $true; $txtNotes.ScrollBars = "Vertical"; $txtNotes.AcceptsReturn = $true
$txtNotes.Location = New-Object System.Drawing.Point(18,464)
$txtNotes.Size = New-Object System.Drawing.Size(664,142)
$txtNotes.Text = $cfg.Notes
$form.Controls.Add($txtNotes)

$btnSaveNotes = New-Btn "Сохранить примечания" 18 616 300 40 $fontB $false
$btnSaveNotes.ForeColor = $clrGreen
Add-Label "Примечания и путь сохраняются автоматически при закрытии." 330 626 352 30 $null $clrGrey | Out-Null

# --- подсказки ---
$tip = New-Object System.Windows.Forms.ToolTip
$tip.SetToolTip($btnAuto,   "Задача: копировать все сессии + собирать экспорт чатов каждый час и при входе")
$tip.SetToolTip($btnJunc,   "Папка сессий станет ссылкой на бэкап — всё из Claude Code попадает туда сразу")
$tip.SetToolTip($btnExport, "Открыть claude.ai: Settings -> Privacy -> Export data")
$tip.SetToolTip($btnCollect,"Найти скачанный архив экспорта в Загрузках и скопировать в бэкап")
$tip.SetToolTip($btnRemind, "Напоминать примерно раз в месяц выгрузить чаты Claude")

# --- логика ---
function Update-Status {
    $n = Count-Sessions
    $ce = 0
    $out = Join-Path $txtDest.Text "chat-exports"
    if (Test-Path $out) { $ce = @(Get-ChildItem $out -File -ErrorAction SilentlyContinue).Count }
    $lblStatus.Text = "Сессий Code: $n    |    экспортов чатов: $ce    |    последний бэкап: " + ($(if ($cfg.LastBackup) { $cfg.LastBackup } else { "—" }))
}
function Sync-Cfg { $cfg.Dest = $txtDest.Text; $cfg.Notes = $txtNotes.Text; Save-Cfg $cfg }

# --- фоновое копирование (чтобы окно не зависало) ---
$script:proc = $null
$script:kind = ""
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400

function Set-Busy($on) {
    foreach ($b in @($btnBackup,$btnRestore,$btnAuto,$btnJunc)) { $b.Enabled = -not $on }
    if ($on) { $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor }
    else     { $form.Cursor = [System.Windows.Forms.Cursors]::Default }
}
function Start-Copy($kind) {
    $dest = $txtDest.Text
    if ([string]::IsNullOrWhiteSpace($dest)) { Log "Сначала укажите папку бэкапа."; return }
    if ($kind -eq "backup") {
        if (-not (Test-Path $ProjSrc)) { Log "Нет папки сессий: $ProjSrc"; return }
        $src = $ProjSrc; $dst = (Join-Path $dest "projects"); $mir = $true
    } else {
        $src = (Join-Path $dest "projects"); $dst = $ProjSrc; $mir = $false
        if (-not (Test-Path $src)) { Log "Бэкап не найден: $src"; return }
    }
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    $a = @($src, $dst, "/R:1", "/W:1", "/MT:16", "/NFL", "/NDL", "/NP", "/NJH", "/NJS")
    if ($mir) { $a += "/MIR" } else { $a += "/E" }
    Set-Busy $true
    Log ($(if ($kind -eq "backup") { "Бэкап" } else { "Восстановление" }) + "… идёт копирование, окно активно.")
    $script:kind = $kind
    $script:proc = Start-Process robocopy -ArgumentList $a -WindowStyle Hidden -PassThru
    $timer.Start()
}
$timer.Add_Tick({
    if ($null -eq $script:proc) { $timer.Stop(); return }
    if (-not $script:proc.HasExited) { return }
    $timer.Stop()
    $code = $script:proc.ExitCode
    $script:proc = $null
    $dest = $txtDest.Text
    try {
        if ($script:kind -eq "backup") {
            $s = Join-Path $ClaudeDir "settings.json"
            if (Test-Path $s) { Copy-Item $s (Join-Path $dest "settings.json") -Force }
            if ($code -lt 8) { $cfg.LastBackup = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); Log "OK: бэкап готов -> $dest" }
            else { Log "robocopy вернул код $code (возможна ошибка)" }
        } else {
            $s = Join-Path $dest "settings.json"
            if (Test-Path $s) { Copy-Item $s (Join-Path $ClaudeDir "settings.json") -Force }
            if ($code -lt 8) { Log "OK: восстановлено. В папке проекта выполните: claude --resume" }
            else { Log "robocopy вернул код $code (возможна ошибка)" }
        }
    } catch { Log ("Ошибка после копирования: " + $_.Exception.Message) }
    Sync-Cfg; Update-Status; Set-Busy $false
})

function Register-UserTask($name, $arg, $triggers, $desc) {
    $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
    $pr  = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $st  = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $act -Trigger $triggers -Principal $pr -Settings $st -Description $desc -Force -ErrorAction Stop | Out-Null
}

# --- обработчики ---
$btnBrowse.Add_Click({
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($fb.ShowDialog() -eq "OK") { $txtDest.Text = $fb.SelectedPath; Update-Status }
})
$btnBackup.Add_Click({ Start-Copy "backup" })
$btnRestore.Add_Click({
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "Восстановить сессии из`n$($txtDest.Text)`nв ваш профиль? Существующие файлы обновятся, лишние не удалятся.",
        "Восстановление", "YesNo", "Question")
    if ($ans -eq "Yes") { Start-Copy "restore" }
})
$btnOpenSess.Add_Click({ if (Test-Path $ClaudeDir) { Start-Process explorer.exe $ClaudeDir } else { Log "Папка $ClaudeDir не найдена" } })
$btnOpenBak.Add_Click({ if (Test-Path $txtDest.Text) { Start-Process explorer.exe $txtDest.Text } else { Log "Папка бэкапа ещё не создана" } })
$btnAuto.Add_Click({
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Backup"
    $t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
    $t2 = New-ScheduledTaskTrigger -AtLogOn
    try {
        Register-UserTask "ClaudeSessionsBackup" $arg @($t1,$t2) "Автозахват сессий и экспорта Claude"
        Sync-Cfg
        Log "Автозахват включён (планировщик): сессии и экспорт чатов — каждый час и при входе."
    } catch {
        Log "Планировщик отказал ($($_.Exception.Message)). Включаю автозапуск при входе…"
        try {
            $startup = [Environment]::GetFolderPath('Startup')
            $cmd = "@echo off`r`npowershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Backup`r`n"
            Set-Content -LiteralPath (Join-Path $startup "ClaudeBackup.cmd") -Value $cmd -Encoding OEM
            Sync-Cfg
            Log "Готово: бэкап будет выполняться при каждом входе в систему (ежечасно без прав админа нельзя)."
        } catch { Log ("Не удалось включить автозахват: " + $_.Exception.Message) }
    }
})
$btnJunc.Add_Click({
    $dest = $txtDest.Text
    if ([string]::IsNullOrWhiteSpace($dest)) { Log "Сначала укажите папку бэкапа."; return }
    $target = Join-Path $dest "projects"
    $item = Get-Item $ProjSrc -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Log "Папка сессий уже связана с бэкапом — всё попадает туда само."; return }
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "Папка сессий станет ссылкой на:`n$target`n`nПосле этого ВСЁ из Claude Code будет сразу попадать в папку бэкапа.`n`nВАЖНО: сначала ЗАКРОЙТЕ Claude Code. Продолжить?",
        "Мгновенный захват", "OKCancel", "Warning")
    if ($ans -ne "OK") { return }
    try {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        if (Test-Path $ProjSrc) {
            robocopy $ProjSrc $target /E /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
            Remove-Item $ProjSrc -Recurse -Force
        }
        $mk = 'mklink /J "{0}" "{1}"' -f $ProjSrc, $target
        cmd /c $mk | Out-Null
        $item2 = Get-Item $ProjSrc -ErrorAction SilentlyContinue
        if ($item2 -and ($item2.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Log "Готово: теперь всё из Claude Code сразу попадает в $target" }
        else { Log "Не удалось создать ссылку. Закройте Claude Code и попробуйте снова." }
        Sync-Cfg; Update-Status
    } catch { Log ("Ошибка: " + $_.Exception.Message) }
})
$btnExport.Add_Click({
    try { Start-Process "https://claude.ai/settings" } catch { Log "Не удалось открыть браузер." }
    Log "Открыл claude.ai. Дальше: Settings -> Privacy -> Export data. Архив придёт на почту."
})
$btnCollect.Add_Click({
    Log "Ищу скачанный экспорт в Загрузках…"
    Log (Collect-ChatExports $txtDest.Text)
    Sync-Cfg; Update-Status
})
$btnRemind.Add_Click({
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Reminder"
    $tr  = New-ScheduledTaskTrigger -Weekly -WeeksInterval 4 -DaysOfWeek Monday -At 12:00PM
    try {
        Register-UserTask "ClaudeChatExportReminder" $arg @($tr) "Напоминание выгрузить чаты Claude"
        Log "Напоминание включено: примерно раз в месяц (пн, 12:00) всплывёт подсказка выгрузить чаты."
    } catch { Log ("Не удалось создать напоминание (нужны права планировщика): " + $_.Exception.Message) }
})
$btnSaveNotes.Add_Click({ Sync-Cfg; Log "Примечания сохранены." })
$form.Add_FormClosing({ Sync-Cfg })

Update-Status
Log "Готово. Программу можно держать в любой папке (например на диске E:)."
Log "Если перенесёте её после включения Автозахвата/Напоминания — нажмите их заново (обновят путь)."
[void]$form.ShowDialog()
