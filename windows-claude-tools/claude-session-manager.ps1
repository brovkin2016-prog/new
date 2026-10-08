param([switch]$Backup)

# =====================================================================
#  Claude Session Manager  —  GUI для бэкапа/восстановления сессий
#  Claude Code (Windows). Кнопки + личные примечания.
#  Запуск с ключом -Backup = тихий бэкап без окна (для автозадачи).
# =====================================================================

# --- пути и конфиг ---
if ($PSScriptRoot) { $ScriptDir = $PSScriptRoot } else { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ScriptPath = $PSCommandPath
if (-not $ScriptPath) { $ScriptPath = Join-Path $ScriptDir "claude-session-manager.ps1" }
$CfgPath    = Join-Path $ScriptDir "claude-session-manager.config.json"
$ClaudeDir  = Join-Path $env:USERPROFILE ".claude"
$ProjSrc    = Join-Path $ClaudeDir "projects"

function Load-Cfg {
    $def = [ordered]@{ Dest = (Join-Path $env:USERPROFILE "OneDrive\Claude-Backup"); Notes = ""; LastBackup = "" }
    if (Test-Path $CfgPath) {
        try {
            $j = Get-Content $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.Dest) { $def.Dest = $j.Dest }
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

# --- ядро бэкапа/восстановления (возвращает текст статуса) ---
function Run-Backup($dest) {
    if (-not (Test-Path $ProjSrc)) { return "Нет папки сессий: $ProjSrc" }
    if ([string]::IsNullOrWhiteSpace($dest)) { return "Не указана папка бэкапа." }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    robocopy $ProjSrc (Join-Path $dest "projects") /MIR /R:2 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
    $code = $LASTEXITCODE
    $s = Join-Path $ClaudeDir "settings.json"
    if (Test-Path $s) { Copy-Item $s (Join-Path $dest "settings.json") -Force }
    if ($code -lt 8) { return "OK: бэкап в $dest" } else { return "robocopy вернул код $code (ошибка)" }
}
function Run-Restore($src) {
    $srcProj = Join-Path $src "projects"
    if (-not (Test-Path $srcProj)) { return "Бэкап не найден: $srcProj" }
    New-Item -ItemType Directory -Force -Path $ProjSrc | Out-Null
    robocopy $srcProj $ProjSrc /E /R:2 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
    $code = $LASTEXITCODE
    $s = Join-Path $src "settings.json"
    if (Test-Path $s) { Copy-Item $s (Join-Path $ClaudeDir "settings.json") -Force }
    if ($code -lt 8) { return "OK: восстановлено в $ClaudeDir  (затем: claude --resume)" } else { return "robocopy код $code (ошибка)" }
}

# --- тихий режим для автозадачи ---
if ($Backup) {
    $r = Run-Backup $cfg.Dest
    $cfg.LastBackup = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    Save-Cfg $cfg
    exit 0
}

# =====================  GUI  =====================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$clrBg   = [System.Drawing.Color]::FromArgb(245,246,250)
$clrCard = [System.Drawing.Color]::White
$clrAcc  = [System.Drawing.Color]::FromArgb(67,56,202)
$clrGreen= [System.Drawing.Color]::FromArgb(5,150,105)
$fontUI  = New-Object System.Drawing.Font("Segoe UI",9.5)
$fontB   = New-Object System.Drawing.Font("Segoe UI",10,[System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Claude Session Manager"
$form.Size = New-Object System.Drawing.Size(640,640)
$form.StartPosition = "CenterScreen"
$form.BackColor = $clrBg
$form.Font = $fontUI
$form.FormBorderStyle = "FixedSingle"
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = "Сессии Claude Code — бэкап и восстановление"
$title.Font = New-Object System.Drawing.Font("Segoe UI",13,[System.Drawing.FontStyle]::Bold)
$title.ForeColor = $clrAcc
$title.Location = New-Object System.Drawing.Point(18,14)
$title.Size = New-Object System.Drawing.Size(600,28)
$form.Controls.Add($title)

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(18,44)
$lblStatus.Size = New-Object System.Drawing.Size(600,20)
$lblStatus.ForeColor = [System.Drawing.Color]::FromArgb(75,85,99)
$form.Controls.Add($lblStatus)

# --- папка бэкапа ---
$lblDest = New-Object System.Windows.Forms.Label
$lblDest.Text = "Папка бэкапа (копировать сюда / восстанавливать отсюда):"
$lblDest.Location = New-Object System.Drawing.Point(18,76)
$lblDest.Size = New-Object System.Drawing.Size(600,18)
$form.Controls.Add($lblDest)

$txtDest = New-Object System.Windows.Forms.TextBox
$txtDest.Location = New-Object System.Drawing.Point(18,96)
$txtDest.Size = New-Object System.Drawing.Size(488,24)
$txtDest.Text = $cfg.Dest
$form.Controls.Add($txtDest)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = "Обзор…"
$btnBrowse.Location = New-Object System.Drawing.Point(512,95)
$btnBrowse.Size = New-Object System.Drawing.Size(96,26)
$form.Controls.Add($btnBrowse)

# --- кнопки действий ---
function New-Btn($text,$x,$y,$w,$accent) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x,$y)
    $b.Size = New-Object System.Drawing.Size($w,40)
    $b.FlatStyle = "Flat"
    $b.Font = $fontB
    if ($accent) { $b.BackColor = $clrAcc; $b.ForeColor = [System.Drawing.Color]::White; $b.FlatAppearance.BorderSize = 0 }
    else { $b.BackColor = $clrCard }
    return $b
}
$btnBackup  = New-Btn "⬆  Сделать бэкап" 18 134 290 $true
$btnRestore = New-Btn "⬇  Восстановить сессии" 318 134 290 $true
$form.Controls.Add($btnBackup); $form.Controls.Add($btnRestore)

$btnOpenSess = New-Btn "Папка сессий" 18 182 190 $false
$btnOpenBak  = New-Btn "Папка бэкапа" 218 182 190 $false
$btnAuto     = New-Btn "Автобэкап: вкл." 418 182 190 $false
$form.Controls.Add($btnOpenSess); $form.Controls.Add($btnOpenBak); $form.Controls.Add($btnAuto)

# --- лог ---
$log = New-Object System.Windows.Forms.TextBox
$log.Multiline = $true; $log.ScrollBars = "Vertical"; $log.ReadOnly = $true
$log.Location = New-Object System.Drawing.Point(18,234)
$log.Size = New-Object System.Drawing.Size(590,96)
$log.BackColor = [System.Drawing.Color]::FromArgb(249,250,251)
$form.Controls.Add($log)
function Log($m) { $log.AppendText(("[{0}] {1}`r`n" -f (Get-Date -Format "HH:mm:ss"), $m)) }

# --- примечания ---
$lblNotes = New-Object System.Windows.Forms.Label
$lblNotes.Text = "Мои примечания (хранятся локально, только для вас):"
$lblNotes.Font = $fontB
$lblNotes.Location = New-Object System.Drawing.Point(18,344)
$lblNotes.Size = New-Object System.Drawing.Size(590,20)
$form.Controls.Add($lblNotes)

$txtNotes = New-Object System.Windows.Forms.TextBox
$txtNotes.Multiline = $true; $txtNotes.ScrollBars = "Vertical"
$txtNotes.AcceptsReturn = $true
$txtNotes.Location = New-Object System.Drawing.Point(18,366)
$txtNotes.Size = New-Object System.Drawing.Size(590,170)
$txtNotes.Text = $cfg.Notes
$form.Controls.Add($txtNotes)

$btnSaveNotes = New-Btn "💾  Сохранить примечания" 18 544 290 $false
$btnSaveNotes.ForeColor = $clrGreen
$form.Controls.Add($btnSaveNotes)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = "Примечания и путь сохраняются автоматически при закрытии."
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(107,114,128)
$lblHint.Location = New-Object System.Drawing.Point(318,554)
$lblHint.Size = New-Object System.Drawing.Size(290,34)
$form.Controls.Add($lblHint)

# --- логика ---
function Update-Status {
    $n = Count-Sessions
    $lblStatus.Text = "Сессий на диске: $n    |    последний бэкап: " + ($(if ($cfg.LastBackup) { $cfg.LastBackup } else { "—" }))
}
function Sync-Cfg { $cfg.Dest = $txtDest.Text; $cfg.Notes = $txtNotes.Text; Save-Cfg $cfg }

$btnBrowse.Add_Click({
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($fb.ShowDialog() -eq "OK") { $txtDest.Text = $fb.SelectedPath }
})
$btnBackup.Add_Click({
    Log "Бэкап…"; $r = Run-Backup $txtDest.Text
    if ($r -like "OK*") { $cfg.LastBackup = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") }
    Log $r; Sync-Cfg; Update-Status
})
$btnRestore.Add_Click({
    $ans = [System.Windows.Forms.MessageBox]::Show(
        "Восстановить сессии из`n$($txtDest.Text)`nв ваш профиль? Существующие файлы обновятся, лишние не удалятся.",
        "Восстановление", "YesNo", "Question")
    if ($ans -eq "Yes") { Log "Восстановление…"; Log (Run-Restore $txtDest.Text); Sync-Cfg; Update-Status }
})
$btnOpenSess.Add_Click({ if (Test-Path $ClaudeDir) { Start-Process explorer.exe $ClaudeDir } else { Log "Папка $ClaudeDir не найдена" } })
$btnOpenBak.Add_Click({ if (Test-Path $txtDest.Text) { Start-Process explorer.exe $txtDest.Text } else { Log "Папка бэкапа ещё не создана" } })
$btnAuto.Add_Click({
    try {
        $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`" -Backup"
        $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
        $t1 = New-ScheduledTaskTrigger -Daily -At 8:00PM
        $t2 = New-ScheduledTaskTrigger -AtLogOn
        Register-ScheduledTask -TaskName "Claude sessions backup" -Action $act -Trigger $t1,$t2 -Description "Автобэкап сессий Claude Code" -Force | Out-Null
        Sync-Cfg
        Log "Автобэкап включён: ежедневно в 20:00 и при входе. (Отключить — в Планировщике заданий.)"
    } catch { Log ("Не удалось создать задачу: " + $_.Exception.Message) }
})
$btnSaveNotes.Add_Click({ Sync-Cfg; Log "Примечания сохранены." })
$form.Add_FormClosing({ Sync-Cfg })

Update-Status
Log "Готово к работе. Проверьте путь бэкапа и нажмите нужную кнопку."
[void]$form.ShowDialog()
