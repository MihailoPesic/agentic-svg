@echo off
rem Stops the agentic-svg app (the local server on port 5173).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5173" ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>nul
echo agentic-svg stopped.
timeout /t 2 >nul
