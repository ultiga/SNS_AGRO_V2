@echo off
title SNS Agro Real-Time Dashboard
cd /d "%~dp0"
echo Starting SNS Agro Real-Time Summary ^& Payroll Dashboard...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -OpenBrowser
pause
