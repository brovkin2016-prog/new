Set fso = CreateObject("Scripting.FileSystemObject")
d = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -sta -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & d & "\claude-session-manager.ps1""", 0, False
