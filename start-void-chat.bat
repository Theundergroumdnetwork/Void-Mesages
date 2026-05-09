@echo off
cd /d "%~dp0"
echo Starting VOID CHAT...
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else (
  "C:\Users\Jase Scott\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
)
pause
