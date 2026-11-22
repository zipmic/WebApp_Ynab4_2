# Desktop app and file-based sync

Budget Reborn 2.0 runs as a desktop application on Windows and macOS (and Linux) without a server, a network
port or a login. A budget can be shared between computers through any folder that a sync service keeps up to
date — Dropbox, OneDrive, Google Drive, iCloud Drive, Syncthing, a NAS share — using plain files only.

The self-hosted server version still exists in the same code base (`npm start`), and the last server-only state is
preserved in the branch `server-version`.

User guide (Danish): [DESKTOP_GUIDE.md](DESKTOP_GUIDE.md).

---

## 1. What was reused (repository analysis)

| Part | Where | Reused in the desktop app |
|---|---|---|
| Budget rules (YNAB4 engine) | `src/shared/engine.ts` | unchanged |
| Money, dates, YNAB4 readers, bank parser | `src/shared/*` | unchanged |
| Budget service (all writes via `mutate()`, undo/redo, integrity check) | `src/server/budgetService.ts` | unchanged API; a commit hook seals sync operations |
| SQLite schema + migrations | `src/server/db.ts` | + budget migration v3, system migration v3 |
| HTTP API (Fastify, zod validation) | `src/server/app.ts` | all routes; served **in memory** (no socket) |
| Backups (`VACUUM INTO`), restore as new budget, JSON export | `src/server/core.ts` | unchanged; + migration from a server data folder |
| YNAB4 import + audit, Smart Bank Import (local OCR) | `src/server/importService.ts`, … | unchanged |
| React UI | `src/web` | unchanged screens; + sync indicator, Sync settings tab, conflicts screen, desktop options on the welcome screen |
| Login (Argon2id, TOTP, passkeys, sessions, throttling) | `src/server/auth.ts` | not used by the desktop app (still used by the server version) |

## 2. Technology choice: Electron

| Criterion (in the requested order) | Electron | Tauri |
|---|---|---|
| 1. Code reuse | The whole Node back end (Fastify routes, better-sqlite3, services, engine, importers) runs unchanged in the main process. | The UI runs in the system web view, but the Node back end cannot run inside Tauri: it would have to be rewritten in Rust or shipped as a separate Node "sidecar" process (a local server again). |
| 2. Data integrity | Same SQLite driver, same transactions and migrations that the 51,770-cell YNAB4 verification and all tests were done with. | A Rust rewrite of the data layer would have to be verified again from scratch. |
| 3. Stability | One runtime (Chromium + Node) on all platforms; identical rendering. | Different web views per OS (WebView2, WKWebView, WebKitGTK) — layout/feature differences to test per platform. |
| 4. Maintenance | One language (TypeScript) end to end. | TypeScript + Rust. |
| 5. Platforms | Windows x64/arm64, macOS Apple Silicon + Intel, Linux. better-sqlite3 ships Node-API binaries for all of them (no compiler needed). | Same platforms. |
| 6. Resources | Larger download (~100 MB installed) and more memory. | Smaller. |

Electron wins on the four highest priorities; its only disadvantage is size and memory, which matter least here.

### How the app is put together
- **Main process** (`src/desktop/main.ts`): builds the existing Fastify application with `BR_DESKTOP=1` and registers
  the privileged scheme `app://`. Every request from the window (`app://budget/...`) is passed to `fastify.inject()`
  in memory. **No TCP port is opened** (verified by the packaged-app smoke test, which inspects the listening sockets of
  the app and all its helper processes).
- **Window**: `contextIsolation`, `sandbox`, no Node integration, navigation restricted to `app://budget/`, external links
  open in the system browser, all permission requests (camera, location, …) denied, Content-Security-Policy from the app.
- **Preload** (`src/desktop/preload.cts`): exposes exactly two functions — choose a folder in the system dialog, and
  show a known folder in Explorer/Finder. The page never sees or sends file paths: the main process registers a chosen
  folder and gives the page an opaque token (`Core.grantFolder`); API routes accept only tokens.
- **No login**: the app is only reachable from its own window inside the user's own OS account. The window gets a
  per-launch session and CSRF token; the sign-in routes return 404 in desktop mode.
- **Data location**: `%APPDATA%\BudgetReborn` (Windows), `~/Library/Application Support/BudgetReborn` (macOS),
  `~/.config/BudgetReborn` (Linux): `data/system.sqlite`, `data/budgets/<id>.sqlite`, `data/backups/…`, `window.json`.
  Program files and data are separate; installing, updating and uninstalling never touch the data.

## 3. Sync protocol (version 1)

### Principles
- Every computer keeps its **own** SQLite database in its app-data folder. The active database is never placed in the
  sync folder (two computers never write the same SQLite file).
- Only **primary data** is exchanged (accounts, groups, categories, payees, transactions, budgeted amounts, month notes,
  scheduled transactions, reconciliations, imports, import rules, budget settings). Everything derived — balances,
  Activity, Available, Available to Budget, rollover, overspending — is recomputed by `src/shared/engine.ts` from that data,
  so two computers with the same data compute identical numbers. Local-only: the register order key
  (`transactions.seq`), undo history, the revision counter, the sync bookkeeping itself.
- Plain files only. Every file is written by exactly one computer and (except that computer's own status file) never
  changed afterwards, so two computers never write the same file.

### Folder layout
```
<Budget name> (Budget Reborn)/
  budget-reborn.json                         manifest: format, protocol version, budget id, name (written once, last)
  devices/<deviceId>.json                    each computer's status: what it has processed, app + schema version
  ops/<deviceId>/<from>-<to>.json            that computer's operations <from>..<to> (10-digit numbers), immutable
  snapshots/<deviceId>-<n>-<time>.json.gz    complete state + bookkeeping, for computers that join later
```

### Identities
- **Device id**: 32 hex characters, random, created once per installation and stored in `system.sqlite`.
- **Budget id**: 24 hex characters, random, created when a budget is first shared; stored in the manifest and in the
  budget's `sync_state`. A computer refuses to open the same shared budget twice and refuses to read files of another
  budget (`budgetId` is checked in every file).
- **Operation id**: `<deviceId>:<n>`, where `n` counts that device's operations 1, 2, 3 … without gaps.

### Operations
One committed user action = one operation, recorded **in the same SQLite transaction** as the change itself
(`BudgetService.onCommit` → `SyncStore.seal`): an operation exists if and only if the change was committed.
Triggers on the primary-data tables capture before/after images of each row while capture is on; sealing merges
several edits of one row into one change:

```json
{ "id": "<dev>:42", "dev": "<dev>", "seq": 42, "deps": { "<other dev>": 17 }, "at": "2026-11-22T21:00:00Z",
  "label": "Edit transaction", "schema": 3,
  "changes": [ { "t": "transactions", "k": "<id>", "f": { "amount": -12345 }, "b": { "amount": -10000 } } ] }
```
Change kinds: `a` (complete row: insert, or "make it exactly this" in a resolution), `f` (changed fields), `d` (delete,
with the row before), `e` with `a` ("make sure this row exists": inserted only where missing, never changes an existing row).

### Causal order, idempotence, exactly once
- `deps` is a **version vector**: for every other device, the highest of its operations this device had processed.
- An incoming operation is applied only when it is that device's next one and everything in `deps` has been processed
  here. Operations that arrive early simply wait (out-of-order and delayed delivery are safe).
- The version vector `sync_vv` records what has been processed; anything already processed is ignored (duplicates,
  re-delivered files, conflicted copies with identical content).
- Each operation is applied in one SQLite transaction: completely or not at all.

### Conflict detection (never a silent choice)
For every field the store keeps the set of operations that wrote it last (`sync_writers`; normally one, several when
computers wrote it independently). For an incoming operation:
- a field whose last writers are all in the operation's history is simply updated;
- a field that was changed here **independently** to a different value is a **conflict**; equal values are not;
- deleting a row that was changed here independently, or changing a row that was deleted here, is a conflict;
- linked fields: a transaction's amount, cleared/reconciled state and account belong together — independent changes to
  different ones of them (e.g. reconciling on one computer while the amount is changed on the other) are a conflict;
- the lines of a split belong to the split: independent changes to the lines on two computers are a conflict;
- a change that would violate the database's own rules here (for example it refers to a category deleted here) is a
  conflict (`cannot_apply`), never an error that stops sync;
- bookkeeping columns where a decision is pointless (sort order, "last category used for this payee", an import
  rule's usage counter, a creation timestamp) use a deterministic last-writer rule that picks the same winner everywhere.

When anything conflicts, **nothing of that operation is applied here**; it is stored in `sync_conflicts` together with
this computer's version of every involved row. Both computers detect the same conflict. Each keeps showing its own
version until the user decides.

**Resolution** ("keep this computer's version" / "use the other computer's version") is a new operation that writes the
chosen version of every involved row (from both sides), with a history that includes both versions, so every computer
applies it and closes its matching conflict automatically. To make it applicable everywhere it also carries "make sure it
exists" copies of the rows it refers to; keeping "my version" never deletes an account, category, group or payee that the
other computer still has (it is restored instead); a decision about a split covers the whole split; and a decision that
would leave the budget inconsistent (e.g. a split whose lines do not add up) is refused with an explanation. A local
backup is taken before every decision.

The required situations and the tests that show them (`tests/unit/sync.test.ts`, "the required situations A–G"):

| | Situation | Result |
|---|---|---|
| A | Transaction created on Windows while the Mac is offline | appears on the Mac when it syncs |
| B | Different transactions on both | both kept |
| C | Same transaction's amount changed on both while offline | conflict on both; nothing chosen silently |
| D | Deleted on Windows, edited on the Mac | conflict on both; nothing deleted until decided |
| E | Money moved between categories on Windows while the budget is changed on the Mac | merged when different cells, conflict when the same cell; identical figures and integrity afterwards |
| F | Reconciled on one computer while the other has unsynchronised changes to a reconciled transaction | conflict (linked fields); compatible changes still arrive |
| G | "Conflicted copy" made by the sync service | identical copies ignored; different ones reported, never deleted, never applied by guessing |

### Deterministic ids where two computers create "the same" thing
Payees get an id derived from their name, and the transactions created when a scheduled transaction is entered get ids
derived from the schedule and date. Two computers that add the same payee or enter the same scheduled occurrence while
offline therefore produce the same rows instead of duplicates. (The payee name index is no longer `UNIQUE`, so two
computers renaming different payees to the same name offline cannot block each other; the app still reuses/merges by name.)

### Files: writing, reading, damage
- **Atomic writes**: temporary file in the same folder → flush (`fsync`) → rename; then the folder is flushed where the OS
  allows. A reader sees either nothing or the complete file. Temporary files (`.tmp-*`) are ignored; this device's own
  stale ones are removed after an hour.
- **Validation**: every file is untrusted input: size limits, JSON parsing only, strict schema validation (tables and
  columns from a whitelist, values only `null`, strings and safe integers, ids by pattern), SHA-256 checksum of the
  content, file name must match the content, budget id must match, links/non-regular files are skipped. Nothing in a file
  is ever executed or used as a path.
- **Incomplete files** (still being copied by the sync service) are retried on the next cycle; a file that stays invalid for
  10 minutes is reported as damaged and never applied. Gaps in a device's numbering are waited for.
- **Conflicted copies** (`… (conflicted copy).json`, `… (1).json`, `…-DESKTOP-xyz.json`): compared with the original; identical
  ones are ignored, different ones are reported. If a copy contains a *different* version of an operation that was already
  seen, that device's operations are not applied until it is cleared up (reported). Budget Reborn never deletes them.
- **Identity clash** (e.g. a copied app-data folder): a file in this device's own folder with numbers this device never wrote
  stops synchronisation with an explanation; a copied budget database is detected and must be opened from the folder again.

### Snapshots and new computers
When the budget is shared, a complete snapshot (all primary data + the writer sets and operation log needed for conflict
detection + version vector) is written. A computer that joins loads the newest valid snapshot and then applies only the
operations after it — it never replays an unlimited history. A computer writes a new snapshot when at least 500 operations
were processed since its last one, or a week has passed with changes, and only when it has no open conflicts and is not
waiting for files (a consistent state). Each computer keeps its own two newest snapshots and deletes only its own older ones.

### Old operations
Operation files are **not pruned** in this version. They are small (one line per change; a typical day is a few KB), and
keeping them is what makes it safe for a computer that was offline for months to come back. Pruning would only be safe
when every known device has acknowledged an operation *and* a snapshot covers it *and* no device can still be offline
with older changes — this is documented as future work, not implemented.

### Status shown to the user
`Only on this computer` · `Changes waiting` (saved locally, not yet written) · `Syncing…` · `Synced` (this computer has
written all its changes and applied everything it found) · `Waiting for files` (files from another computer have not
arrived completely) · `Sync folder unavailable` (changes are kept locally) · `Needs your decision` (conflicts) ·
`Sync stopped` (incompatible version, identity clash …, with explanation). With time of the last check and of the last
fully-up-to-date state. For each other computer: last activity, version, and **"Has your changes" only when that
computer's own status file in the folder confirms it has processed this computer's latest operation** — the app never
claims "all devices synced" from the mere presence of a file.

Synchronisation runs automatically: shortly after every change, when the folder changes (file watcher) and every 30
seconds (missed watcher events, network shares and cloud clients that do not report changes), and once more when the
app quits. "Sync now" runs a cycle immediately.

### Versions and compatibility
- `protocol` in every file; a newer protocol stops synchronisation with an explanation ("Update Budget Reborn on this
  computer"); nothing is written.
- `schema` in every operation; an operation from a newer database schema, or one with tables/columns this version does
  not know, stops synchronisation instead of being applied partially. An older version can therefore never damage data
  written by a newer one; the user's own changes stay safe locally until the app is updated.
- Database migrations stay append-only; before an existing database is upgraded a complete copy is written next to it
  (`<file>.pre-vN.bak`); every migration runs in one transaction.

## 4. Backups, restore, migration
- Built-in backups as before: `VACUUM INTO` (consistent while the app runs) into `data/backups/<budget>/`; automatically
  once a day when the budget is used, before imports, before a larger batch of incoming changes (≥ 20 operations,
  `before-sync`), before every conflict decision (`before-conflict`), before deleting a budget, and manually. The newest 30
  of each automatic kind are kept. Backups are local and separate from the sync folder; sync can never damage them.
- **Restore** always creates a **new, local-only budget** (its sync history is removed). It can never roll back other
  computers. To share a restored budget, choose a sync folder for it — that creates a new shared budget (new budget id).
- **Moving from the server version**: welcome screen → "Move budgets from the server version" → choose the server's data
  folder (with `system.sqlite` and `budgets/`). Each budget file (and its WAL) is copied to a temporary folder, a consistent
  copy is made there, restored as a new budget (validated: SQLite integrity, foreign keys, financial consistency check)
  and verified by record counts per table; a budget that fails is discarded and reported. The source folder is only read —
  a test hashes every file before and after. Older schema versions are upgraded with the usual safety copy.

## 5. Security model (desktop)
- No network listener; nothing else can talk to the app. Requests carry a per-launch CSRF token and must be same-origin.
- Folders only by token from the OS dialog; the sync code builds paths only from validated ids/patterns.
- Sync files are untrusted data (see validation above) and are written with owner-only permissions where the OS supports it.
- The login code (Argon2id, TOTP, passkeys) remains for the server version; the desktop build does not ship the
  native Argon2 module (it is loaded only when a password is checked).
- **Not done (optional future work)**: encryption of the sync folder contents or of the local database. The local database
  is protected by the OS account; files in a cloud folder are readable by the cloud provider. Encryption would need key
  management (a passphrase on each computer) and is deliberately not mandatory in this version.

## 6. Builds and distribution
```bash
npm run desktop:start      # build and run the desktop app from source (developer)
npm run desktop:dist       # build installers for the current OS into dist/desktop
npm run test:desktop -- <path to executable>   # packaged-app smoke test (Linux: under xvfb-run)
npm run test:perf:sync     # sync timings for a 55,000-transaction budget
```
- Pinned: Electron 45.2.3, electron-builder 26.18.1; `npm ci` from `package-lock.json` → reproducible builds.
- SQLite: better-sqlite3 13 ships Node-API binaries for every platform inside the npm package; they work unchanged in
  Electron, so nothing is compiled during packaging.
- **Windows**: NSIS installer (`BudgetReborn-<v>-win-x64.exe`; choose folder, Start-menu and desktop shortcut, uninstaller
  that keeps `%APPDATA%\BudgetReborn`) and a portable zip. **macOS**: `.dmg` for Apple Silicon (arm64) and Intel (x64).
  **Linux**: unpacked folder (used for the automated smoke test).
- CI: `.github/workflows/desktop.yml` runs the tests on Windows, macOS and Linux, the browser e2e and the packaged-app
  smoke test on Linux, and builds the Windows installer + zip and the macOS dmgs on real Windows/macOS machines.

### Code signing, SmartScreen, Gatekeeper (no paid certificates)
- **Windows**: the installer and program are not signed. SmartScreen shows "Windows protected your PC" on the first run →
  "More info" → "Run anyway". Removing the warning needs a code-signing certificate (OV/EV, paid; the reputation of an OV
  certificate builds up over downloads) or Microsoft's Trusted/Artifact Signing service. Configure it with
  electron-builder's `win.signtoolOptions`/`azureSignOptions` and remove `signAndEditExecutable: false`.
- **macOS**: the app has only an ad-hoc signature (`identity: "-"`, required for Apple Silicon, no certificate needed) and
  is not notarised. Gatekeeper blocks the first start of a downloaded copy: System Settings → Privacy & Security →
  "Open Anyway" (on macOS 14 and older also: Control-click the app → Open → Open). Removing this needs an Apple Developer
  Program membership (paid, yearly), a "Developer ID Application" certificate and notarisation (electron-builder
  `mac.notarize` with an App Store Connect API key).

### What was built and tested in this environment (Linux container)
| Artifact / test | Status |
|---|---|
| Linux unpacked app | built; packaged-app smoke test passed (two installations, shared folder, change propagates, no listening port) |
| Windows portable zip (`BudgetReborn-2.0.0-win-x64.zip`) | built here (contains the PE executable, the Windows SQLite binary and the web files); **not started on Windows here** |
| Windows NSIS installer | **not built here**: NSIS needs Wine on Linux, and Wine crashes in this sandbox. Built by CI on `windows-latest`. |
| macOS dmg (arm64 + x64) | **not built here** (needs macOS). Built by CI on `macos-latest`. |
| Unit tests on Windows/macOS file systems | configured in CI; **not yet run** |

## 7. Limits of file-based sync (be aware)
- Budget Reborn can only see what the sync service has already delivered to this computer. "Synced" means this computer is
  up to date with *its copy* of the folder; whether another computer has received your changes is shown per computer only
  once that computer has confirmed it.
- Cloud placeholders ("files on demand" in OneDrive, "Optimise Mac storage" in iCloud Drive, Google Drive streaming) may
  delay files until they are downloaded; Budget Reborn waits and says so ("Waiting for files"). Marking the budget folder
  as "Always keep on this device" avoids the delay.
- Services that are not running, paused, or out of space simply delay sync; nothing is lost locally.
- A folder on a network share needs the share to be mounted; otherwise the status is "Sync folder unavailable".
- Do not let two installations share one app-data folder or copy it between computers (detected and stopped).
