# Budget Reborn på din computer — installation og synkronisering

Budget Reborn 2 er et almindeligt program til Windows og Mac. Der er ingen server, ingen åben port, intet login og
ingen opsætning i en terminal. Dine budgetter ligger på din egen computer, og hvis du vil bruge det samme budget på
flere computere, vælger du bare en mappe i Dropbox, OneDrive, Google Drive, iCloud Drive, Syncthing eller på et
netværksdrev.

## 1. Hent programmet
Installationsfilerne bygges automatisk af GitHub (fanen **Actions** → "Desktop app" → seneste kørsel → **Artifacts**):
- **Windows**: `BudgetReborn-windows` → `BudgetReborn-2.0.0-win-x64.exe` (installationsprogram) eller `…-win-x64.zip` (kan køres uden installation).
- **Mac**: `BudgetReborn-macos` → `BudgetReborn-2.0.0-mac-arm64.dmg` (Apple Silicon: M1/M2/M3/M4) eller `…-mac-x64.dmg` (Intel).

## 2. Installér
### Windows
1. Dobbeltklik på `BudgetReborn-2.0.0-win-x64.exe`.
2. Første gang viser Windows "Windows har beskyttet din pc" (programmet er ikke signeret med et betalt certifikat):
   klik **Flere oplysninger** → **Kør alligevel**.
3. Følg installationen. Du får en genvej i Startmenuen og på skrivebordet.

Den bærbare zip-udgave: pak den ud et sted (fx `Dokumenter\Budget Reborn`) og start **Budget Reborn.exe**.

### Mac
1. Åbn `.dmg`-filen og træk **Budget Reborn** over i **Programmer**.
2. Første gang siger macOS, at programmet ikke kan åbnes, fordi udvikleren ikke kan bekræftes (det er ikke notariseret hos Apple):
   åbn **Systemindstillinger → Anonymitet og sikkerhed**, rul ned og klik **Åbn alligevel**.
   (På macOS 14 og ældre kan du også ctrl-klikke på programmet → **Åbn** → **Åbn**.)

### Hvor ligger mine data?
- Windows: `%APPDATA%\BudgetReborn` (fx `C:\Users\<dig>\AppData\Roaming\BudgetReborn`)
- Mac: `~/Library/Application Support/BudgetReborn`

Programmet og dine data er adskilt. En opdatering eller afinstallation sletter **ikke** dine budgetter eller backups.
I programmet: **Indstillinger → Sync & this computer → Show data folder**.

## 3. Første start: åbn dit budget
Startskærmen viser dine budgetter og disse muligheder:
- **Import YNAB4 budget** — din YNAB4-mappe eller en zip af den (med kontrol mod originalen, som før).
- **Create new budget** — et tomt budget.
- **Restore backup** — en backup-fil (`.sqlite`/`.budgetreborn`) eller JSON-eksport. Åbnes altid som et *nyt* budget.
- **Open budget from a sync folder** — et budget som en anden computer deler gennem en mappe (se afsnit 5).
- **Move budgets from the server version** — hvis du har brugt server-udgaven (den med login i browseren).

### Fra server-udgaven
1. Stop den gamle server (fx `restart-windows.ps1`/opgaven i Opgavestyring, eller luk vinduet).
2. Vælg **Move budgets from the server version** og vælg serverens **data**-mappe (den der indeholder `system.sqlite` og
   mappen `budgets`).
3. Hvert budget kopieres, kontrolleres (integritet, sammenhæng og antal poster) og vises i en liste. Den gamle mappe
   bliver kun læst — intet ændres eller slettes der.

Programmet husker det senest åbnede budget, vinduets størrelse og placering.

## 4. Vælg en synkroniseringsmappe (første computer)
1. Åbn budgettet → **Indstillinger** (tandhjulet nederst til venstre) → fanen **Sync & this computer**.
2. Klik **Choose sync folder…** og vælg en mappe, som din synkroniseringstjeneste holder opdateret, fx
   `Dropbox`, `OneDrive\Dokumenter`, `iCloud Drive` eller `Google Drive\Min drev`.
3. Budget Reborn opretter mappen **"<budgetnavn> (Budget Reborn)"** derinde. Det er den, de andre computere skal åbne.

Selve databasen bliver på din computer — i synkroniseringsmappen ligger kun ændringer og kopier. Rør ikke filerne i mappen.

## 5. Åbn budgettet på den anden computer
1. Vent til synkroniseringstjenesten har hentet mappen **"<budgetnavn> (Budget Reborn)"** (i iCloud Drive/OneDrive: vælg
   "Behold altid på denne enhed" for mappen, så filerne ligger lokalt).
2. Start Budget Reborn → **Open budget from a sync folder** → vælg mappen **"<budgetnavn> (Budget Reborn)"**.
3. Budgettet åbnes med alle tal. Fra nu af udveksles ændringer automatisk — også selv om du har arbejdet offline.

## 6. Synkroniseringsstatus
Nederst i venstre side står en lille status. Klik på den for detaljer og **Sync now**.

| Status | Betydning |
|---|---|
| **Synced · 14:32** | Denne computer har skrevet alle sine ændringer i mappen og hentet alt, den har fundet. |
| **Changes waiting** | Dine ændringer er gemt på computeren og bliver skrevet til mappen om et øjeblik. |
| **Syncing…** | Udveksler lige nu. |
| **Waiting for files** | Filer fra en anden computer er ikke kommet helt frem endnu (tjenesten kopierer stadig). |
| **Sync folder unavailable** | Mappen kan ikke ses (drev ikke tilsluttet, tjenesten stoppet …). Dine ændringer er gemt lokalt og skrives senere. |
| **Needs your decision** | Noget er ændret forskelligt på to computere. Se afsnit 7. |
| **Sync stopped** | Fx en nyere version på den anden computer — opdatér Budget Reborn. Forklaringen står i detaljerne. |

Under **Other computers** står **Has your changes** kun, når den anden computer selv har bekræftet det i mappen.
Budget Reborn kan ikke se, om Dropbox/OneDrive har overført en fil til andre computere, og påstår det derfor aldrig.

## 7. Konflikter
Hvis det samme er ændret forskelligt på to computere, mens de ikke kunne se hinanden (fx beløbet på samme transaktion,
eller den ene har slettet en postering som den anden har rettet), vælger Budget Reborn **aldrig** selv.
Statusfeltet viser **Needs your decision** → **Resolve conflicts**. For hver konflikt ser du begge versioner:
- **Keep this computer's version** eller **Use <anden computer>'s version**.

Indtil du vælger, beholder hver computer sin egen version. Dit valg sendes til alle computere. Før hvert valg tages en
backup. Forskellige ændringer (fx en ny postering på hver computer, eller et beløb på den ene og et notat på den anden)
flettes automatisk uden konflikt.

## 8. Backup og gendannelse
- Automatisk: én gang dagligt når budgettet bruges, før import, før større synkroniseringer og før konfliktvalg.
- Manuelt: **Indstillinger → Backups & export → Back up now and download**.
- Gendannelse: **Restore backup** på startskærmen. En gendannet backup bliver altid et *nyt* budget, der kun ligger på
  denne computer — den kan aldrig rulle de andre computeres ændringer tilbage. Vil du dele den, vælger du en ny
  synkroniseringsmappe til den.

## 9. Flyt eller stop synkronisering
- **Change folder…**: vælg enten den mappe, hvor budgettet nu ligger (fx efter du har flyttet din Dropbox-mappe), eller en
  tom mappe — så kopieres budgetmappen derover. Den gamle mappe røres ikke. De andre computere skal også vælge den nye mappe.
- **Stop syncing**: budgettet bliver kun på denne computer med alle data. Mappen og de andre computere ændres ikke.

## 10. Opdatering og afinstallation
- Opdatering: installér den nye version oven i den gamle. Dine data bliver liggende; før en databaseopgradering gemmes
  en kopi (`….pre-vN.bak`). Kør gerne samme version på alle computere — en ældre version stopper synkroniseringen med en
  forklaring i stedet for at ødelægge noget.
- Afinstallation (Windows: Indstillinger → Apps; Mac: træk programmet til papirkurven) sletter **ikke** dine data. Vil du
  også fjerne dem, så slet mappen fra afsnit 2 manuelt.

## 11. Fejlsøgning
- **"Waiting for files" bliver ved**: kontrollér at tjenesten kører og er færdig, og at budgetmappen ligger lokalt
  ("Behold altid på denne enhed"). Klik **Sync now**.
- **"Sync folder unavailable"**: er drevet/tjenesten tilgængeligt? Er mappen flyttet? Brug **Change folder…** og vælg den
  nye placering.
- **"Your sync service made a copy of a file"**: Dropbox/OneDrive har lavet en "conflicted copy". Budget Reborn har tjekket
  den og bruger originalen; kopien kan du lade ligge.
- **"Another installation is using this computer's identity"**: programdata er kopieret fra en anden computer. Stop
  synkronisering for budgettet på denne computer og åbn det igen fra mappen.

## 12. Begrænsninger
- Synkronisering er kun så hurtig og pålidelig som din synkroniseringstjeneste. Budget Reborn mister ikke data, hvis
  tjenesten er langsom eller laver kopier, men det kan ikke se filer, før tjenesten har leveret dem.
- Filerne i en cloud-mappe er ikke krypteret af Budget Reborn; de er beskyttet som dine øvrige filer hos tjenesten.
- Programmet er ikke signeret med betalte certifikater — derfor advarslerne ved første start (afsnit 2).
