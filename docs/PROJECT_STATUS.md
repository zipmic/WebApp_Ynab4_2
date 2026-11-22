# Project status

Last updated after the desktop conversion (Budget Reborn 2.0: Electron app with file-based sync, see DESKTOP_AND_SYNC.md). Test counts: 169 unit/integration tests (incl. 2- and 3-computer sync simulations; 600+ randomized sync scenarios run with `SYNC_SEEDS=300`), 19 browser steps, packaged desktop smoke test, benchmarks with limits — all passing in the Linux build environment.

## Completed and verified
| Area | Verified by |
|---|---|
| Budget engine (rollover, overspending, sticky red arrow, income this/next month, future budgeting) | unit tests + real 12-year budget (see BUDGET_ENGINE.md) |
| Accounts, transactions, transfers (incl. tracking accounts), splits, split-line transfers, bulk edits | unit tests incl. 300 random edits with invariants; browser test |
| Reconciliation with diagnostics and confirmation-only adjustments | unit + browser tests |
| Undo/redo (persistent) | unit + browser tests |
| Scheduled transactions (entered when due) | unit tests |
| **Native YNAB4 import** | real budget: every financial area PASS; synthetic regression tests |
| **YNAB4 CSV import** (M2) | owner's real Register + Budget export: identical to the native import field by field and month by month; synthetic regression tests |
| Independent migration audit + CLI (`npm run audit:ynab4`) | unit tests incl. deliberate damage detection; real budget |
| Readable budget names from zips made without the UTF-8 name flag (macOS), e.g. folder names with Æ/Ø/Å (M4) | unit tests; checked on the owner's real zip (booleans only) |
| Independent audit shown in the import wizard (verify + done steps) and Settings → Migration report; a FAIL verdict prevents the "verified" label (M3) | unit tests + browser step with a synthetic native budget |
| Comparison of an import with YNAB4's own Budget export (`--budget-csv`, M1) | 10 synthetic tests; **owner's real export: budgeted, activity and balance identical in all 51,770 category-months** |
| Import safety: preview without writing, new budget only, rollback on failure, duplicate-import guard | unit/API tests; real zip through the API |
| Concurrent-edit detection (revision, 409 STALE) and the client's reaction (message, refresh, retry; failed writes rolled back on screen) | unit + API tests incl. simultaneous requests; browser test with two devices (I1) |
| Atomic operations (failed step leaves nothing behind) | unit tests |
| Schema upgrade v1→v2 with safety copy; failed upgrade leaves the database untouched; newer database refused | unit tests |
| Backups, download, validated restore as a new budget, CSV/JSON export | unit + browser tests |
| Scheduled/off-site backups: `scripts/backup-now.ts` (bundled as `dist/server/backup-now.mjs`), safe next to a running server, retention per kind (D2) | unit tests: live server untouched, copies restorable, retention keeps manual/safety backups |
| Restore from the JSON export as a new budget (validated row by row, one transaction, consistency check; newer/foreign/damaged files refused) (I3) | unit/API tests: identical round trip, 8 rejection cases |
| Authentication: setup, Argon2id, TOTP, sessions, CSRF, throttling, HTTPS/VPN options, 401 on all private routes | unit tests |
| Open-port hardening: proxy trust limited to loopback (spoofed X-Forwarded-For fixed), required second factor (`BR_REQUIRE_2FA`), persistent lockouts (I2, system schema v2) | unit tests incl. spoofing, restart and "pretend to be local" cases; system v1→v2 upgrade test |
| Passkeys | browser test with a virtual authenticator (not with a physical device) |
| Smart Bank Import: local OCR, CSV, JSON schema, suggestions, duplicate detection, atomic commit, learned corrections | unit tests + browser test with real OCR on synthetic screenshots |
| UI: budget, register, reports, schedules, settings, wizards, phone layout, dark mode | browser test + screenshots |
| Performance at 51k transactions / 10 years | `npm run test:perf` (cold budget ≈55 ms, all-accounts register ≈150 ms) |

### Desktop app and sync (2.0)
| Area | Verified by |
|---|---|
| Desktop app: existing API and UI served in memory through `app://` (no TCP port), no login, per-launch CSRF, folders only by token, window state | `tests/unit/desktop.test.ts`; packaged Linux app smoke test (`tests/desktop/smoke.mjs`): starts, creates a budget, shares it, a second installation opens it, a change propagates, **no listening socket in the app or its helper processes** |
| Sync engine: capture in the same transaction as every write, causal order, exactly-once, field-level merge, conflicts for the user (A–G), resolutions that close conflicts everywhere, snapshots for new computers | `tests/unit/sync.test.ts`: situations A–G one by one; out-of-order, half-written, duplicated, damaged files; conflicted copies; unavailable folder + restart; atomicity; identity clash; newer protocol/schema; restore isolation; moving folders; randomized 2–3-computer sessions through a shared folder and through an unreliable simulated cloud (identical primary data and budget figures, integrity check clean) |
| Budget schema v3 (sync tables, payee name index non-unique) and system schema v3 upgrades with safety copies | upgrade tests in `tests/unit/integrity.test.ts` |
| Moving budgets from the server version (source folder only read; verified copies) | unit test hashing every source file before/after; figures identical |
| Sync cost at 55,000 transactions | `npm run test:perf:sync`: share ≈4.5 s (snapshot 1.7 MB), join ≈5.6 s, one change written ≈10 ms, applied elsewhere ≈0.5 s |

## Implemented but not verified
| Item | What is missing |
|---|---|
| `.ydiff` merging when the full copy is behind | only synthetic tests; the real budget needed no merge |
| Account types / frequencies not present in the real budget | mapping from documentation only |
| Uncategorised-transaction rule, reconciliation-adjustment category | assumed YNAB4 behaviour |
| External vision provider | mock only |
| Passkeys on real devices, TOTP with a real authenticator app | not tried |
| Home Windows deployment (D1: `deploy/windows/*` incl. Caddy for the open port, `docs/DEPLOYMENT_GUIDE.md`) | app behaviour behind Caddy and Tailscale covered by unit tests; **Caddy itself not run** (download not permitted in the build environment); env-file parsing and the production bundle tested on Linux; **the PowerShell/batch scripts and Tailscale steps have not been run on a real Windows computer** (no Windows or tailscale.com access from the build environment) |
| Prebuilt Windows package (`npm run package:windows`) | Windows binaries verified as x86-64 PE DLLs; the identical linux-x64 package started from an isolated folder (login, database, web app, OCR assets, backup); **not started on Windows** |
| Deployment behind a real reverse proxy (VPS) | configuration examples only; never deployed |
| Service worker / installable PWA | registered in production builds; not tested on phones |
| Report figures | not compared with YNAB4's reports |
| Desktop app on **Windows** (portable zip built here; NSIS installer built only by CI) | **not started on Windows**: the build environment is Linux; Wine crashes in its sandbox, so the installer could not be produced or tried here |
| Desktop app on **macOS** (dmg arm64 + x64, ad-hoc signed) | built only by CI on a Mac; **not started on a Mac** |
| Sync through real Dropbox/OneDrive/iCloud/Google Drive/Syncthing clients | simulated (delays, partial files, conflicted copies, out-of-order delivery); **not tried with the real services** |
| Unit tests on Windows/macOS file systems | configured in `.github/workflows/desktop.yml`; not yet run |

## Known bugs and rough edges
1. Hidden categories are appended to the end of their group after import (original position inside the group is not stored by YNAB4 for hidden ones).
2. OCR misreads bold text on dark-mode screenshots; affected rows are blocked for review, not imported wrongly.
3. Scheduled-transaction dialog cannot edit split lines (imported splits are preserved).
4. Date inputs follow the browser locale, not the budget's date format.
5. `listPayees` counts uses with a correlated subquery; fine at 2,400 payees, watch if it grows.
6. Reports "spending" clamps net-positive categories to zero in charts (tables show the real value).

## Missing features (not started)
Multi-month budget view · drag-and-drop reordering · configurable keyboard shortcuts · PIN lock · database encryption ·
encryption of the sync folder · pruning of old sync operations · automatic program updates · payee rename rules · entering scheduled transactions ahead of time ·
payee management screen (merge/delete) · deployment guide beyond the examples.

## Architectural risks
0. **Desktop builds untried on the target machines.** Windows and macOS packages come from CI; the first real start on the owner's computers is still to be done (see OPUS_HANDOFF.md → next task).
1. **Server deployment untried on the target machine** (now secondary to the desktop app). The owner chose a home Windows computer with a fixed IP and an open port (Caddy, required 2FA); the scripts are written and partly tested but not yet run there.
2. Single process, single SQLite writer: fine for one household; do not run two server instances on one data directory.
3. Coarse concurrency control: any change elsewhere rejects the next write from a stale device (by design).
4. The engine's reference twin in `migrationAudit.ts` must be kept in step deliberately.
5. Dependencies are recent major versions (Vite 8, TypeScript 7, zod 4, Fastify 5, React 19); pin via `package-lock.json`, upgrade deliberately.
