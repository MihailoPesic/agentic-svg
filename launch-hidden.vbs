' agentic-svg - start the local app with no console window, then the server
' opens it in your browser. Double-clicking again just re-opens the tab.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = dir

If Not fso.FolderExists(dir & "node_modules") Then
  ' first run: show the visible launcher so the one-time dependency install is visible
  sh.Run "cmd /c """ & dir & "agentic-svg.cmd""", 1, False
Else
  ' normal run: start the server hidden; it opens the browser itself
  sh.Run "cmd /c set AGENTIC_OPEN=1 && node ""src\server\server.js"" > ""%TEMP%\agentic-svg.log"" 2>&1", 0, False
End If
