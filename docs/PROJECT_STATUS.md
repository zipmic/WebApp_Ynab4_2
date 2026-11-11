# Project status

Last updated after backlog item M1 (tool part). Test counts: 106 unit/integration tests, 17 browser steps, benchmark with limits — all passing.

## Completed and verified
| Area | Verified by |
|---|---|
| Budget engine (rollover, overspending, sticky red arrow, income this/next month, future budgeting) | unit tests + real 12-year budget (see BUDGET_ENGINE.md) |
| Accounts, transactions, transfers (incl. tracking accounts), splits, split-line transfers, bulk edits | unit tests incl. 300 random edits with invariants; browser test |
| Reconciliation with diagnostics and confirmation-only adjustments | unit + browser tests |
| Undo/redo (persistent) | unit + browser tests |
| Scheduled transactions (entered when due) | unit tests |
| **Native YNAB4 import** | real budget: every financial area PASS; synthetic regression tests |
| Independent migration audit + CLI (`npm run audit:ynab4`) | unit tests incl. deliberate damage detection; real budget |
| Comparison of an import with YNAB4's own Budget export (`--budget-csv`, M1) | 8 synthetic tests (faithful import passes; wrong cell, unknown category, unreadable row, missing row detected; hidden categories and both Outflows sign conventions); **not yet run on the owner's real export** |
| Import safety: preview without writing, new budget only, rollback on failure, duplicate-import guard | unit/API tests; real zip through the API |
| Concurrent-edit detection (revision, 409 STALE) | unit + API tests incl. simultaneous requests |
| Atomic operations (failed step leaves nothing behind) | unit tests |
| Schema upgrade v1→v2 with safety copy; failed upgrade leaves the database untouched; newer database refused | unit tests |
| Backups, download, validated restore as a new budget, CSV/JSON export | unit + browser tests |
| Authentication: setup, Argon2id, TOTP, sessions, CSRF, throttling, HTTPS/VPN options, 401 on all private routes | unit tests |
| Passkeys | browser test with a virtual authenticator (not with a physical device) |
| Smart Bank Import: local OCR, CSV, JSON schema, suggestions, duplicate detection, atomic commit, learned corrections | unit tests + browser test with real OCR on synthetic screenshots |
| UI: budget, register, reports, schedules, settings, wizards, phone layout, dark mode | browser test + screenshots |
| Performance at 51k transactions / 10 years | `npm run test:perf` (cold budget ≈55 ms, all-accounts register ≈150 ms) |

## Implemented but not verified
| Item | What is missing |
|---|---|
| YNAB4 **CSV** import | never run against a real YNAB4 export (headers/formatting from memory) |
| Month balances vs. YNAB4's own figures | tool ready (`npm run audit:ynab4 -- <zip> --budget-csv <Budget.csv>`); waiting for the owner's YNAB4 export |
| `.ydiff` merging when the full copy is behind | only synthetic tests; the real budget needed no merge |
| Account types / frequencies not present in the real budget | mapping from documentation only |
| Uncategorised-transaction rule, reconciliation-adjustment category | assumed YNAB4 behaviour |
| External vision provider | mock only |
| Passkeys on real devices, TOTP with a real authenticator app | not tried |
| Deployment behind a real reverse proxy | configuration examples only; never deployed |
| Service worker / installable PWA | registered in production builds; not tested on phones |
| Report figures | not compared with YNAB4's reports |
| Client handling of 409 STALE (refresh + message) | implemented; no browser test with two devices |

## Known bugs and rough edges
1. Budget name suggested from a zip with non-ASCII folder name is garbled (editable in the wizard).
2. Hidden categories are appended to the end of their group after import (original position inside the group is not stored by YNAB4 for hidden ones).
3. OCR misreads bold text on dark-mode screenshots; affected rows are blocked for review, not imported wrongly.
4. Scheduled-transaction dialog cannot edit split lines (imported splits are preserved).
5. Date inputs follow the browser locale, not the budget's date format.
6. `listPayees` counts uses with a correlated subquery; fine at 2,400 payees, watch if it grows.
7. Reports "spending" clamps net-positive categories to zero in charts (tables show the real value).

## Missing features (not started)
Multi-month budget view · drag-and-drop reordering · configurable keyboard shortcuts · PIN lock · database encryption ·
restore from the JSON export · offline writes · payee rename rules · entering scheduled transactions ahead of time ·
payee management screen (merge/delete) · README for end users · deployment guide beyond the examples.

## Architectural risks
1. **Hosting is undecided.** The probed web space cannot run Node. See SECURITY_AND_DEPLOYMENT.md.
2. Single process, single SQLite writer: fine for one household; do not run two server instances on one data directory.
3. Coarse concurrency control: any change elsewhere rejects the next write from a stale device (by design).
4. The engine's reference twin in `migrationAudit.ts` must be kept in step deliberately.
5. Dependencies are recent major versions (Vite 8, TypeScript 7, zod 4, Fastify 5, React 19); pin via `package-lock.json`, upgrade deliberately.
