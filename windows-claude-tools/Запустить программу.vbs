' Запуск Claude Session Manager без окна консоли
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\claude-session-manager.ps1""", 0, False
