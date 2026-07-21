@echo off
setlocal
cd /d "%~dp0.."
echo Starting Blubber...
node server.js
pause
