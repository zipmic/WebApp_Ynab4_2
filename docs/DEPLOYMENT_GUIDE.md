# Budget Reborn på din computer derhjemme (Windows + Tailscale)

Budget Reborn kører på en Windows-computer, der altid er tændt. Du bruger den fra computeren selv og fra din
telefon og andre enheder via **Tailscale**: et gratis privat netværk, hvor kun dine egne enheder er med. Appen er ikke
synlig på internettet, og dine data forlader aldrig computeren (bortset fra de backup-kopier, du selv vælger).

Det tager ca. 30–45 minutter første gang. Kommandoerne skrives i **PowerShell**. Højreklik på Start-knappen, og vælg
**Terminal (administrator)** eller **Windows PowerShell (administrator)**.

> Status: scriptene og indstillingerne er testet så langt det kan lade sig gøre uden en Windows-maskine (appens
> opførsel bag Tailscale er dækket af automatiske tests). Selve Windows-scriptene er endnu ikke kørt på en rigtig
> Windows-computer. Skriv, hvis et trin ikke opfører sig som beskrevet.

## 0. Før du starter
- Windows 10 eller 11, 64-bit.
- Computeren må ikke gå i dvale: **Indstillinger → System → Strøm → Sæt computeren i dvale: Aldrig** (skærmen må gerne slukke).
- Anbefalet: slå **BitLocker** til (Indstillinger → Privatliv og sikkerhed → Enhedskryptering/BitLocker), så dine
  økonomidata er krypteret, hvis computeren bliver stjålet. Og hav en adgangskode på din Windows-bruger.

## 1. Installer Node.js og Git
1. Hent **Node.js LTS** (version 20.11 eller nyere) fra <https://nodejs.org> → "Windows Installer (.msi)". Brug standardvalgene.
2. Hent **Git for Windows** fra <https://git-scm.com/download/win>. Brug standardvalgene.
3. Luk og åbn PowerShell (administrator) igen, og tjek:
   ```powershell
   node -v
   git --version
   ```
   `node -v` skal vise v20.11 eller højere.

## 2. Hent og byg appen
```powershell
New-Item -ItemType Directory -Force C:\BudgetReborn
git clone -b claude/compassionate-knuth-trbgex https://github.com/zipmic/WebApp_Ynab4_2.git C:\BudgetReborn\app
cd C:\BudgetReborn\app
npm ci
npm run build
```
Git beder dig måske logge ind på GitHub i browseren første gang. `npm run build` skal slutte med
`server bundle written to dist/server/index.mjs`.

## 3. Indstillinger
```powershell
Copy-Item C:\BudgetReborn\app\deploy\windows\budget-reborn.env.example C:\BudgetReborn\budget-reborn.env
notepad C:\BudgetReborn\budget-reborn.env
```
Du behøver ikke ændre noget nu. Tailscale-adressen (trin 6) og backup-placeringen (trin 7) skrives ind senere.
Filen ligger med vilje **uden for** app-mappen, så en opdatering aldrig overskriver den.

## 4. Start appen som en tjeneste
```powershell
cd C:\BudgetReborn\app
powershell -ExecutionPolicy Bypass -File deploy\windows\install-windows.ps1
```
Det opretter to planlagte opgaver i Windows' Opgavestyring:
- **Budget Reborn** starter appen, når Windows starter, også selvom ingen er logget ind, og genstarter den, hvis den stopper.
- **Budget Reborn backup** laver en backup af alle budgetter hver nat kl. 03:17.

Til sidst skal der stå **"Budget Reborn kører: http://localhost:8787"**.

## 5. Opret dit login og importér dit YNAB4-budget
1. Åbn <http://localhost:8787> i en browser **på denne computer**.
2. Opret dit brugernavn og en lang adgangskode (mindst 10 tegn). Der kan kun være én bruger, og ingen andre kan oprette sig.
3. Vælg **Importér YNAB4-budget** og træk din nyeste `.ynab4`-mappe (eller en zip af den) ind.
4. Tjek forhåndsvisningen og den uafhængige kontrol, og tryk **Importér**.
5. Anbefalet: **Indstillinger → Sikkerhed → Tofaktorgodkendelse**.

## 6. Adgang fra telefonen med Tailscale
1. Opret en gratis konto på <https://tailscale.com> og installer Tailscale på **computeren** og på **telefonen**.
   Log ind med samme konto på begge.
2. I Tailscales administrationsside (<https://login.tailscale.com/admin/dns>): sørg for, at **MagicDNS** er slået til,
   og slå **HTTPS Certificates** til.
3. På computeren, i PowerShell (administrator):
   ```powershell
   tailscale serve --bg 8787
   ```
   Kommandoen skriver en adresse som `https://din-pc.tailXXXX.ts.net`. Den virker kun for enheder i dit Tailscale-netværk.
   Afviser kommandoen formatet (ældre/nyere Tailscale), så kør `tailscale serve --help`. Målet er: HTTPS på port 443,
   videresendt til `http://127.0.0.1:8787`, kørende i baggrunden. `tailscale serve status` viser, hvad der er sat op.
4. Skriv adressen ind i indstillingsfilen. Fjern `#` foran linjen og ret den:
   ```
   BR_PUBLIC_ORIGIN=https://din-pc.tailXXXX.ts.net
   ```
   Uden den linje afviser appen ændringer, der kommer fra telefonen.
5. Genstart appen:
   ```powershell
   cd C:\BudgetReborn\app
   powershell -ExecutionPolicy Bypass -File deploy\windows\restart-windows.ps1
   ```
6. Åbn adressen på telefonen, når Tailscale er tændt på den, og log ind. I browserens menu kan du vælge
   **Føj til hjemmeskærm**, så den ligner en app. Passkeys (fingeraftryk/ansigt) kan nu slås til under
   **Indstillinger → Sikkerhed**.

**Brug aldrig `tailscale funnel`.** Funnel gør appen offentlig på internettet. `serve` er kun for dine egne enheder.

## 7. Backup et andet sted
Appen gemmer selv daglige backups i `C:\BudgetReborn\data\backups`. De ligger dog på samme disk. Læg en ekstra kopi et
andet sted, fx en USB-disk eller en anden intern disk:
1. I `C:\BudgetReborn\budget-reborn.env`: fjern `#` foran `BR_BACKUP_COPY_TO`, og skriv stien, fx `E:\BudgetReborn-backup`.
2. Test backuppen med det samme:
   ```powershell
   Start-ScheduledTask -TaskName 'Budget Reborn backup'
   Get-Content C:\BudgetReborn\logs\backup.log -Tail 5
   ```
   Der skal stå `ok …` for hvert budget og `… budget(s) backed up`.

Kopierne er komplette og **ukrypterede** budgetter. Læg dem kun et privat sted. Hvis du bruger OneDrive eller Dropbox,
ligger dine økonomidata hos dem. Gendannelse: **Gendan backup** på startsiden eller under Indstillinger → Backups.

## 8. Tjekliste
- [ ] <http://localhost:8787> virker på computeren efter en genstart af Windows (uden at logge ind først).
- [ ] Tailscale-adressen virker på telefonen, og du kan rette et budgetbeløb derfra.
- [ ] Adressen virker **ikke** på telefonen, når Tailscale er slået fra (den skal være privat).
- [ ] `C:\BudgetReborn\logs\backup.log` viser en backup fra i nat, og kopien ligger på den anden disk.
- [ ] Tofaktorgodkendelse eller passkey er slået til.

## Opdatering til en ny version
```powershell
cd C:\BudgetReborn\app
git pull
npm ci
npm run build
powershell -ExecutionPolicy Bypass -File deploy\windows\restart-windows.ps1
```
Dine data og indstillinger ligger uden for app-mappen og røres ikke. Før en opdatering af databasens format gemmer appen
automatisk en kopi (`*.pre-vN.bak`) ved siden af budgetfilen.

## Fejlfinding
| Problem | Gør dette |
|---|---|
| Appen svarer ikke | Se `C:\BudgetReborn\logs\server.log` (nederst). Kør `restart-windows.ps1`. |
| "address already in use" i loggen | Et andet program bruger port 8787: sæt `BR_PORT=8788` i indstillingsfilen, kør `tailscale serve --bg 8788`, og genstart. |
| Telefonen får "Cross-site request blocked" | `BR_PUBLIC_ORIGIN` mangler eller er ikke præcis den adresse, telefonen bruger (med `https://`, uden `/` til sidst). |
| Opgaven kører ikke | `Get-ScheduledTask 'Budget Reborn'`, og se fanen **Historik** i Opgavestyring. Kør `install-windows.ps1` igen. |
| Glemt adgangskode | Der findes ingen nulstilling udefra (med vilje). 1) Kør `Start-ScheduledTask -TaskName 'Budget Reborn backup'`: den laver komplette kopier af alle budgetter uden login. 2) Stop appen, og flyt `C:\BudgetReborn\data\system.sqlite` (login og listen over budgetter) til en anden mappe. 3) Start appen igen, opret et nyt login på <http://localhost:8787>, og vælg **Gendan backup** med den nyeste `…-scheduled.sqlite` for hvert budget fra `C:\BudgetReborn\data\backups\`. |

## Fjern igen
```powershell
Unregister-ScheduledTask -TaskName 'Budget Reborn' -Confirm:$false
Unregister-ScheduledTask -TaskName 'Budget Reborn backup' -Confirm:$false
tailscale serve reset
```
Dine data ligger stadig i `C:\BudgetReborn\data`, indtil du selv sletter mappen.
