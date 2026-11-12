@echo off
rem Starter Budget Reborn. Bruges af den planlagte opgave "Budget Reborn" (se install-windows.ps1).
rem Foerste argument: installationsmappen (standard C:\BudgetReborn).
setlocal
set "BR_HOME=%~1"
if "%BR_HOME%"=="" set "BR_HOME=C:\BudgetReborn"
cd /d "%BR_HOME%\app" || exit /b 1
if not exist "%BR_HOME%\logs" mkdir "%BR_HOME%\logs"
node --env-file="%BR_HOME%\budget-reborn.env" dist\server\index.mjs >> "%BR_HOME%\logs\server.log" 2>&1
exit /b %ERRORLEVEL%
