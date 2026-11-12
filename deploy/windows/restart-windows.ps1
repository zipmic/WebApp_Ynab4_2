# Genstart Budget Reborn efter en opdatering eller ændring af budget-reborn.env.
# Kør i PowerShell SOM ADMINISTRATOR:  powershell -ExecutionPolicy Bypass -File deploy\windows\restart-windows.ps1
$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'Budget Reborn' -ErrorAction SilentlyContinue
# stop kun Budget Reborns egen node-proces (ikke andre node-programmer)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\server\index.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'Budget Reborn'
Start-Sleep -Seconds 4
try { Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/auth/status' -TimeoutSec 10 | Out-Null; Write-Host 'Budget Reborn kører igen.' -ForegroundColor Green }
catch { Write-Warning 'Appen svarer ikke. Se C:\BudgetReborn\logs\server.log' }
