@echo off
rem Creates a desktop shortcut to agentic-svg with an icon. Run once.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=(Get-Location).Path; $d=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $d 'agentic-svg.lnk')); $s.TargetPath=(Join-Path $root 'agentic-svg.cmd'); $s.WorkingDirectory=$root; $s.IconLocation=((Join-Path $root 'assets\agentic-svg.ico')+',0'); $s.Description='agentic-svg'; $s.Save()"
echo.
echo Desktop shortcut "agentic-svg" created.
pause
