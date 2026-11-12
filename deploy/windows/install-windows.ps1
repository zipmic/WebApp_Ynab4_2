# Budget Reborn - installer som automatisk tjeneste på Windows.
# Kør i PowerShell SOM ADMINISTRATOR fra app-mappen:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
# Opretter to planlagte opgaver:
#   "Budget Reborn"        starter appen når Windows starter (også uden at nogen er logget ind) og genstarter den ved fejl
#   "Budget Reborn backup" laver hver nat kl. 03:17 en backup af alle budgetter
# Kan køres igen: eksisterende opgaver overskrives.
param([string]$BrHome = 'C:\BudgetReborn')
$ErrorActionPreference = 'Stop'

$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Start PowerShell som administrator (højreklik > Kør som administrator) og prøv igen.' }

$app = Join-Path $BrHome 'app'
$envFile = Join-Path $BrHome 'budget-reborn.env'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js blev ikke fundet. Installer Node.js LTS fra https://nodejs.org og prøv igen.' }
$version = [version]((& node -v).TrimStart('v'))
if ($version -lt [version]'20.11.0') { throw "Node.js $version er for gammel. Installer Node.js 20.11 eller nyere (LTS)." }
if (-not (Test-Path (Join-Path $app 'dist\server\index.mjs'))) { throw "Appen er ikke bygget. Kør 'npm ci' og 'npm run build' i $app først." }
if (-not (Test-Path $envFile)) { throw "Indstillingsfilen mangler: kopier deploy\windows\budget-reborn.env.example til $envFile og ret den." }
New-Item -ItemType Directory -Force -Path (Join-Path $BrHome 'logs') | Out-Null

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

$serverAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$app\deploy\windows\start-budget-reborn.cmd`" `"$BrHome`"`""
$serverSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Budget Reborn' -Action $serverAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $serverSettings -Force | Out-Null

$backupAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$app\deploy\windows\backup-budget-reborn.cmd`" `"$BrHome`"`""
$backupSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Budget Reborn backup' -Action $backupAction -Trigger (New-ScheduledTaskTrigger -Daily -At '03:17') -Principal $principal -Settings $backupSettings -Force | Out-Null

Start-ScheduledTask -TaskName 'Budget Reborn'
Start-Sleep -Seconds 4
try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/auth/status' -TimeoutSec 10; Write-Host 'Budget Reborn kører: http://localhost:8787' -ForegroundColor Green; if ($status.setupRequired) { Write-Host 'Åbn adressen i en browser på denne computer og opret dit login.' } }
catch { Write-Warning "Appen svarer ikke endnu. Se loggen: $BrHome\logs\server.log" }
