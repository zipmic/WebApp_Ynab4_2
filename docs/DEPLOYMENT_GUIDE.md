# Budget Reborn på din computer derhjemme (Windows)

Budget Reborn kører på en Windows-computer, der altid er tændt. Dine data forlader aldrig computeren (bortset fra de
backup-kopier, du selv vælger). Udefra kommer du ind på én af to måder (trin 6):

- **A. Åben port med dit eget domæne** (fx `https://budget.ditdomæne.dk`): virker fra enhver browser. Login kræver
  adgangskode **og** en 6-cifret kode fra din telefon (eller en passkey), så en gættet eller stjålet adgangskode ikke er nok.
- **B. Tailscale**: et privat netværk kun for dine egne enheder. Intet er synligt på internettet, men telefonen skal
  have Tailscale-appen.

Det tager ca. 30–45 minutter første gang. Kommandoerne skrives i **PowerShell**. Højreklik på Start-knappen, og vælg
**Terminal (administrator)** eller **Windows PowerShell (administrator)**.

> Status: appens opførsel bag Caddy og Tailscale er dækket af automatiske tests, men selve Windows-scriptene, Caddy og
> Tailscale er endnu ikke kørt på en rigtig Windows-computer. Skriv, hvis et trin ikke opfører sig som beskrevet.

## 0. Før du starter
- Windows 10 eller 11, 64-bit.
- Computeren må ikke gå i dvale: **Indstillinger → System → Strøm → Sæt computeren i dvale: Aldrig** (skærmen må gerne slukke).
- Anbefalet: slå **BitLocker** til (Indstillinger → Privatliv og sikkerhed → Enhedskryptering/BitLocker), så dine
  økonomidata er krypteret, hvis computeren bliver stjålet. Og hav en adgangskode på din Windows-bruger.

## 1. Installer Node.js
1. Hent **Node.js LTS** (version 20.11 eller nyere) fra <https://nodejs.org> → "Windows Installer (.msi)". Brug standardvalgene.
2. Luk og åbn PowerShell (administrator) igen, og tjek: `node -v` skal vise v20.11 eller højere.

## 2. Hent appen
**Nemmest: den færdige pakke** (kræver hverken npm, Git eller at bygge noget):
1. Pak zip-filen `BudgetReborn-windows-x64-….zip` ud direkte i `C:\`, så mappen hedder `C:\BudgetReborn\app`.
   (I zip-filen ligger den allerede som `BudgetReborn\app`.)
2. Tjek, at filen `C:\BudgetReborn\app\dist\server\index.mjs` findes. Gå så videre til trin 3.

**Eller: hent kildekoden og byg selv** (kræver også Git for Windows fra <https://git-scm.com/download/win>; npm
følger med Node.js):
```powershell
New-Item -ItemType Directory -Force C:\BudgetReborn
git clone -b main https://github.com/zipmic/WebApp_Ynab4_2.git C:\BudgetReborn\app
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
Du behøver ikke ændre noget nu. Adgangen udefra (trin 6) og backup-placeringen (trin 7) skrives ind senere.
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
5. **Slå tofaktor til nu:** Indstillinger → Sikkerhed → **Set up two-factor authentication**. Scan QR-koden med en
   Authenticator-app på telefonen (fx Microsoft Authenticator eller Google Authenticator), og skriv koden ind.
   Ved åben port (6A) er det påkrævet, ved Tailscale (6B) stærkt anbefalet.

## 6A. Adgang udefra med åben port og dit eget domæne
Du skal bruge: din faste IP-adresse, et af dine domæner hos Gigahost og adgang til din router.
Gør trinene i denne rækkefølge: **porten åbnes først til sidst**, når alt andet er på plads.

1. **Tofaktor skal være slået til** (trin 5.5). Uden den nægter installationsscriptet at åbne for internettet.
2. **Indstillinger:** åbn `C:\BudgetReborn\budget-reborn.env`, og ret/fjern `#` foran disse tre linjer:
   ```
   BR_PUBLIC_ORIGIN=https://budget.ditdomæne.dk
   BR_TRUST_PROXY=1
   BR_REQUIRE_2FA=1
   ```
   `BR_HOST` skal blive ved med at være `127.0.0.1`. Genstart appen:
   ```powershell
   cd C:\BudgetReborn\app
   powershell -ExecutionPolicy Bypass -File deploy\windows\restart-windows.ps1
   ```
3. **Domæne (Gigahost):** i Gigahosts kontrolcenter → **Domæner** → dit domæne → DNS: opret en **A-record** med navnet
   `budget` (eller hvad du vil kalde den), der peger på din faste IP-adresse. Det kan tage op til en time, før den virker.
4. **Caddy (HTTPS):** hent Caddy til **Windows amd64** fra <https://caddyserver.com/download>, og læg filen som
   `C:\BudgetReborn\caddy\caddy.exe`. Kopier skabelonen og ret domænet:
   ```powershell
   Copy-Item C:\BudgetReborn\app\deploy\windows\Caddyfile.example C:\BudgetReborn\Caddyfile
   notepad C:\BudgetReborn\Caddyfile
   ```
   Erstat `budget.DITDOMAENE.dk` med dit domæne, præcis som i `BR_PUBLIC_ORIGIN` (uden `https://`).
5. **Routeren:** giv computeren en fast lokal IP-adresse (ofte "DHCP-reservation"), og videresend **TCP 443 og TCP 80**
   til den. Port 80 bruges kun til at hente certifikatet og sende besøgende videre til https. **Åbn aldrig port 8787.**
6. **Start Caddy:**
   ```powershell
   cd C:\BudgetReborn\app
   powershell -ExecutionPolicy Bypass -File deploy\windows\install-caddy.ps1
   ```
   Scriptet tjekker først, at tofaktor er påkrævet og slået til, at appen kun lytter på computeren selv, og at domænet
   er rettet. Derefter opretter det opgaven **Budget Reborn HTTPS** (starter Caddy ved opstart) og en firewall-regel for
   port 80 og 443. Caddy henter selv et gratis certifikat (Let's Encrypt) og fornyer det automatisk.
7. **Test fra telefonen på mobildata** (slå wifi fra): åbn `https://budget.ditdomæne.dk`. Log ind med adgangskode +
   kode. Mange routere kan ikke vise din egen adresse indefra hjemmenetværket; virker den på mobildata, er alt i orden.
   Tilføj derefter gerne en **passkey** (Indstillinger → Sikkerhed), så du kan logge ind med fingeraftryk/ansigt.
   I browserens menu kan du vælge **Føj til hjemmeskærm**, så den ligner en app.

**Hvad er åbent mod internettet?** Kun Caddy på port 80/443, og kun for dit domæne (besøg direkte på IP-adressen får
intet svar). Appen selv kan ikke nås udefra. Login kræver adgangskode + kode eller en passkey. Efter 5 forkerte
forsøg låses kontoen i stigende tid, og efter 10 forkerte forsøg fra samme adresse låses adressen. Spærringerne
gælder også efter en genstart. Hold Windows, Node.js og Caddy opdateret.

## 6B. Alternativ: adgang med Tailscale (intet åbent mod internettet)
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
4. Skriv adressen ind i indstillingsfilen: `BR_PUBLIC_ORIGIN=https://din-pc.tailXXXX.ts.net`.
   **Ikke** `BR_TRUST_PROXY` (den er kun til Caddy i 6A). Genstart med `restart-windows.ps1`.
5. Åbn adressen på telefonen, når Tailscale er tændt på den, og log ind.

**Brug aldrig `tailscale funnel`.** Funnel gør appen offentlig uden de ekstra tjek fra 6A.

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
- [ ] 6A: `https://budget.ditdomæne.dk` virker på telefonen på mobildata, login beder om koden, og du kan rette et
      budgetbeløb derfra. `http://budget.ditdomæne.dk` sender videre til https. Din IP-adresse direkte i browseren giver intet svar.
- [ ] 6A: login udefra beder altid om den 6-cifrede kode, og en forkert kode afvises.
- [ ] 6B: Tailscale-adressen virker på telefonen, men **ikke** når Tailscale er slået fra.
- [ ] `C:\BudgetReborn\logs\backup.log` viser en backup fra i nat, og kopien ligger på den anden disk.
- [ ] Tofaktorgodkendelse er slået til, og du har gemt QR-koden/nøglen et sikkert sted eller tilføjet en passkey som reserve.

## Opdatering til en ny version
**Med den færdige pakke:** stop appen, læg den gamle app-mappe til side, pak den nye zip ud i `C:\`, og start igen:
```powershell
Stop-ScheduledTask -TaskName 'Budget Reborn'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist\server\index.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Rename-Item C:\BudgetReborn\app app-gammel
# pak den nye zip ud i C:\ (så C:\BudgetReborn\app findes igen)
powershell -ExecutionPolicy Bypass -File C:\BudgetReborn\app\deploy\windows\restart-windows.ps1
```
Virker alt, kan `C:\BudgetReborn\app-gammel` slettes.

**Med kildekoden (Git):**
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
| "address already in use" i loggen | Et andet program bruger port 8787: sæt `BR_PORT=8788` i indstillingsfilen, ret `127.0.0.1:8787` i Caddyfile (6A) eller kør `tailscale serve --bg 8788` (6B), og genstart begge. |
| Domænet virker ikke udefra (6A) | Tjek i rækkefølge: A-recorden peger på din IP (`nslookup budget.ditdomæne.dk`), routeren videresender 80 og 443 til computerens lokale IP, opgaven **Budget Reborn HTTPS** kører, og se `C:\BudgetReborn\logs\caddy.log`. |
| "Two-factor sign-in is required" (6A) | Tofaktor er ikke slået til på kontoen. Log ind på computeren selv via <http://localhost:8787>, og slå det til under Indstillinger → Sikkerhed. |
| Mistet telefonen med koden | Har du en passkey på en anden enhed, så log ind med den. Ellers: samme fremgangsmåde som "Glemt adgangskode" herunder, og slå tofaktor til igen med den nye telefon. |
| Telefonen får "Cross-site request blocked" | `BR_PUBLIC_ORIGIN` mangler eller er ikke præcis den adresse, telefonen bruger (med `https://`, uden `/` til sidst). |
| Opgaven kører ikke | `Get-ScheduledTask 'Budget Reborn'`, og se fanen **Historik** i Opgavestyring. Kør `install-windows.ps1` igen. |
| Glemt adgangskode | Der findes ingen nulstilling udefra (med vilje). 1) Kør `Start-ScheduledTask -TaskName 'Budget Reborn backup'`: den laver komplette kopier af alle budgetter uden login. 2) Stop appen, og flyt `C:\BudgetReborn\data\system.sqlite` (login og listen over budgetter) til en anden mappe. 3) Start appen igen, opret et nyt login på <http://localhost:8787>, og vælg **Gendan backup** med den nyeste `…-scheduled.sqlite` for hvert budget fra `C:\BudgetReborn\data\backups\`. |

## Fjern igen
```powershell
Unregister-ScheduledTask -TaskName 'Budget Reborn' -Confirm:$false
Unregister-ScheduledTask -TaskName 'Budget Reborn backup' -Confirm:$false
Unregister-ScheduledTask -TaskName 'Budget Reborn HTTPS' -Confirm:$false            # 6A
Get-NetFirewallRule -DisplayName 'Budget Reborn HTTPS (Caddy)' | Remove-NetFirewallRule   # 6A
tailscale serve reset                                                                # 6B
```
Fjern også port-videresendelsen i routeren og A-recorden hos Gigahost (6A).
Dine data ligger stadig i `C:\BudgetReborn\data`, indtil du selv sletter mappen.
