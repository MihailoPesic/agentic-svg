@echo off
rem Creates a desktop shortcut to agentic-svg with an icon. Run once.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=(Get-Location).Path; $d=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $d 'agentic-svg.lnk')); $s.TargetPath='C:\Windows\System32\wscript.exe'; $s.Arguments=('\"'+(Join-Path $root 'launch-hidden.vbs')+'\"'); $s.WorkingDirectory=$root; $s.IconLocation=((Join-Path $root 'assets\agentic-svg.ico')+',0'); $s.Description='agentic-svg'; $s.Save()"
echo.
echo Desktop shortcut "agentic-svg" created. Double-click it to launch the app.
pause
