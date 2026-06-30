@echo off
rem Double-click launcher for agentic-svg. Starts the local app and opens it
rem in your browser. Keep this window open while using it; close it to stop.
cd /d "%~dp0"
title agentic-svg  (close this window to stop)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First-time setup: installing dependencies. This happens once and may take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo Setup failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

set AGENTIC_OPEN=1
echo.
echo   agentic-svg is starting at http://localhost:5173
echo   Your browser will open automatically. Keep this window open while you use it.
echo.
node src/server/server.js
if errorlevel 1 (
  echo.
  echo The server stopped unexpectedly.
  pause
)
