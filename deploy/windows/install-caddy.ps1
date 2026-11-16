# Budget Reborn - gør appen tilgængelig fra internettet med HTTPS via Caddy (åben port 80 og 443).
# Kør i PowerShell SOM ADMINISTRATOR fra app-mappen, EFTER install-windows.ps1 og EFTER at tofaktor er slået til i appen:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-caddy.ps1
# Forudsætninger: C:\BudgetReborn\caddy\caddy.exe og C:\BudgetReborn\Caddyfile (se docs\DEPLOYMENT_GUIDE.md).
# Opretter den planlagte opgave "Budget Reborn HTTPS" (starter Caddy ved opstart) og en firewall-regel for port 80/443.
param([string]$BrHome = 'C:\BudgetReborn')
$ErrorActionPreference = 'Stop'

$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Start PowerShell som administrator og prøv igen.' }

$caddy = Join-Path $BrHome 'caddy\caddy.exe'
$caddyfile = Join-Path $BrHome 'Caddyfile'
$envFile = Join-Path $BrHome 'budget-reborn.env'
if (-not (Test-Path $caddy)) { throw "Caddy mangler: hent caddy.exe (Windows amd64) fra https://caddyserver.com/download og læg den i $caddy" }
if (-not (Test-Path $caddyfile)) { throw "Caddyfile mangler: kopier deploy\windows\Caddyfile.example til $caddyfile og ret domænet." }
if ((Get-Content $caddyfile -Raw -Encoding UTF8) -match 'DITDOMAENE') { throw "Ret domænet i $caddyfile (der står stadig budget.DITDOMAENE.dk)." }

# Sikkerhedstjek: appen må kun åbnes mod internettet med påkrævet tofaktor og den rigtige proxy-indstilling.
$settings = Get-Content $envFile -Encoding UTF8 -ErrorAction Stop | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object { $k, $v = $_ -split '=', 2; @{ $k.Trim() = $v.Trim() } }
$get = { param($name) ($settings | Where-Object { $_.ContainsKey($name) } | Select-Object -Last 1).$name }
if ((& $get 'BR_REQUIRE_2FA') -ne '1') { throw "Sæt BR_REQUIRE_2FA=1 i $envFile, før appen åbnes mod internettet." }
if ((& $get 'BR_TRUST_PROXY') -ne '1') { throw "Sæt BR_TRUST_PROXY=1 i $envFile (Caddy kører på denne computer)." }
if (-not ((& $get 'BR_PUBLIC_ORIGIN') -like 'https://*')) { throw "Sæt BR_PUBLIC_ORIGIN=https://<dit domæne> i $envFile." }
if ((& $get 'BR_HOST') -and (& $get 'BR_HOST') -ne '127.0.0.1') { throw 'BR_HOST skal være 127.0.0.1: kun Caddy må tale direkte med appen.' }
try { $status = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/auth/status' -TimeoutSec 10 } catch { throw 'Budget Reborn svarer ikke på http://127.0.0.1:8787. Kør install-windows.ps1 / restart-windows.ps1 først.' }
if (-not $status.twoFactorRequired) { throw 'Appen kører uden påkrævet tofaktor. Kør restart-windows.ps1, så den læser BR_REQUIRE_2FA=1, og prøv igen.' }
if ($status.setupRequired) { throw 'Opret dit login på http://localhost:8787 og slå tofaktor til, før appen åbnes mod internettet.' }

& $caddy validate --config $caddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw "Caddyfile indeholder en fejl (se ovenfor)." }
New-Item -ItemType Directory -Force -Path (Join-Path $BrHome 'logs') | Out-Null

Get-NetFirewallRule -DisplayName 'Budget Reborn HTTPS (Caddy)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'Budget Reborn HTTPS (Caddy)' -Direction Inbound -Program $caddy -Protocol TCP -LocalPort 80,443 -Action Allow -Profile Any | Out-Null

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$action = New-ScheduledTaskAction -Execute $caddy -Argument "run --config `"$caddyfile`" --adapter caddyfile" -WorkingDirectory $BrHome
$taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Budget Reborn HTTPS' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $taskSettings -Force | Out-Null
Stop-ScheduledTask -TaskName 'Budget Reborn HTTPS' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'Budget Reborn HTTPS'
Write-Host 'Caddy kører. Første certifikat kan tage op til et minut.' -ForegroundColor Green
Write-Host 'Test fra telefonen på mobildata (ikke wifi): https://<dit domæne>'
