@echo off
setlocal
cd /d "%~dp0.."
echo Starting DameOS...
node server.js
pause
