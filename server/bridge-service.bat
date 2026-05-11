@echo off
title Browser Agent Bridge Server
cd /d "%~dp0"

:loop
echo [%date% %time%] Starting Bridge Server...
node bridge.js
echo [%date% %time%] Bridge exited (code: %ERRORLEVEL%). Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
