# Architecture

## Overview
```
Browser (React SPA, src/web)  ──HTTPS, cookie session──▶  Fastify server (src/server)  ──▶  SQLite files (data dir)
        │  local OCR (WASM, /ocr/*)                              │
        └────────────── shared pure domain code (src/shared) ────┘   used by server, browser and tests
```
A single Node process serves the built frontend (`dist/web`) and the JSON API. There is no other service.

## Layers and files
### `src/shared` — pure, no I/O
| File | Purpose |
|---|---|
| `money.ts` | parse/format amounts as integer minor units; arithmetic input (`500+250`) via BigInt |
| `dates.ts` | ISO date/month helpers, tolerant date parsing with ambiguity reporting |
| `engine.ts` | **the YNAB4 budget rules** (`computeBudget`) |
| `types.ts` | DTOs shared by API and UI |
| `schedule.ts` | next occurrence of scheduled transactions |
| `csv.ts` | CSV reader/writer, encoding detection |
| `importModel.ts` | source-independent description of a budget to import |
| `ynab4native.ts`, `ynab4csv.ts` | YNAB4 readers → `ImportModel` |
| `bankparse.ts` | OCR lines / bank CSV / JSON schema → transaction candidates with issue codes |
| `matching.ts` | payee normalisation, similarity, duplicate classification |

### `src/server`
| File | Purpose |
|---|---|
| `config.ts` | environment → `Config` (see `.env.example`) |
| `db.ts` | SQLite open, **migrations**, undo triggers |
| `budgetService.ts` | **all operations on one budget**: accounts, categories, payees, transactions (transfers/splits), budget, reconciliation, schedules, reports, undo/redo, revision, integrity check |
| `importService.ts` | write an `ImportModel` in one transaction + audit against the model's expectations |
| `migrationAudit.ts` | independent audit of a native YNAB4 import against the raw source |
| `bankImportService.ts` | suggestions, duplicate verdicts, atomic commit, learned rules |
| `vision.ts` | optional OpenAI-compatible vision provider (opt-in, server-side key) |
| `auth.ts` | Argon2id, sessions, TOTP, throttling, setup token |
| `core.ts` | system database, budget files, backups, restore, import fingerprints |
| `app.ts` | Fastify app: security hooks, zod validation, every route |
| `index.ts` | process entry |

### `src/web`
`App.tsx` (auth gate, budget selection) → `views/Shell.tsx` (sidebar / phone navigation) → views:
`BudgetView`, `RegisterView` + `TxnEditor`, `Reports` (`components/charts.tsx`), `Scheduled`, `BankImport` (`lib/ocr.ts`),
`Ynab4Import` (`lib/files.ts`), `Settings`, `Welcome`, `Auth`. `lib/api.ts` = fetch wrapper (CSRF, revision),
`lib/store.tsx` = hash router, toasts, theme, `BudgetProvider` (bootstrap data, formatters, cache patching).
`components/ui.tsx` = Button, Input, Dialog/sheet, Popover, Menu, Combobox, toasts.

## Data directory (never inside a web-served folder)
```
<BR_DATA_DIR>/system.sqlite            users, sessions, passkeys, budgets registry, audit log
<BR_DATA_DIR>/budgets/<id>.sqlite      one file per budget (+ -wal/-shm, + <file>.pre-v<N>.bak before a schema upgrade)
<BR_DATA_DIR>/backups/<id>/<UTC>-<reason>.sqlite
<BR_DATA_DIR>/tmp/                     upload staging, emptied at start
<BR_DATA_DIR>/setup-token.txt          exists only until the owner account is created
```

## Budget database schema (version 2, `BUDGET_MIGRATIONS` in `db.ts`)
- `accounts(id, name, type, on_budget, closed, sort_order, note, source_id)`
- `category_groups(id, name, sort_order, hidden, note, system)`; `categories(id, group_id, name, sort_order, hidden, note, kind)`
  — the two income categories are fixed rows `income:this` / `income:next` in system group `group:income`.
- `payees(id, name UNIQUE NOCASE, norm, auto_category_id)`
- `transactions(seq PK AUTOINCREMENT, id UNIQUE, account_id, date, payee_id, category_id, memo, amount INTEGER, cleared, flag,
  transfer_account_id, transfer_txn_id, parent_id, is_split, import_id, source, source_id, created_at)` with CHECK constraints
  (integer amount, date shape, split parent has no category, transfer columns both set or both null, no self-transfer).
  - Split = parent row (`is_split=1`, no category) + child rows (`parent_id`). Account balance sums rows with `parent_id IS NULL`;
    category activity sums rows with a category (children and unsplit rows).
  - Transfer = two top-level rows pointing at each other. A split line may be a transfer; its partner is a top-level row in the other account.
- `monthly_budgets(month, category_id, budgeted, overspending, note)`; `month_notes`
- `scheduled`, `reconciliations`, `imports(fingerprint, summary)`, `payee_rules`, `meta(key,value)`
- `undo_state`, `undo_groups`, `undo_log` — trigger-recorded inverse SQL per user action
- `revision(id=1, n)` — bumped inside every write transaction (v2)

## Key decisions and why
1. **Balances are never stored.** Everything is derived from transactions and budgeted amounts, so history can never drift; recalculation is fast enough (≈55 ms for 10 years).
2. **One SQLite file per budget.** Backup = `VACUUM INTO` copy; restore = validate + add as a new budget; import = new file, deleted on failure. No cross-budget damage is possible.
3. **Undo/redo by triggers** that log inverse SQL (the SQLite "undo/redo" pattern). Generic, covers every table, survives restarts. `mutate()` groups one user action. Bulk imports clear the log.
4. **Optimistic concurrency by a single revision per budget.** Clients send the revision they last saw (`X-Budget-Revision`); the service compares and increments it inside the write transaction → `409 STALE`. Coarse on purpose: a single-user app prefers a rare "please repeat" over any silent overwrite. The header is optional for API scripts; the web client always sends it.
5. **Shared TypeScript domain code** so parsing/validation is identical in server, browser and tests.
6. **OCR in the browser** (tesseract.js WASM served from `/ocr`): screenshots never leave the device; the server never stores images.
7. **Imports go through a neutral `ImportModel`** so both YNAB4 sources share the writer and audit.
8. **Hand-written UI primitives** instead of pulling a component framework; Tailwind tokens in `src/web/index.css` (light/dark).
9. **Single-user security model**: one owner account, no registration. See `SECURITY_AND_DEPLOYMENT.md`.

## Request flow for a write
`fetch` (CSRF + revision headers) → `app.ts` hooks (network allow-list, HTTPS, security headers, origin check, session, CSRF)
→ zod validation → `svcOf(req)` sets expected revision → `BudgetService.<op>` → `mutate()`:
`BEGIN IMMEDIATE` → compare/increment revision → undo group → changes → `COMMIT` → caches dropped → response with
`X-Budget-Revision`. Transaction mutations return `{changed, deleted}` so the client patches its cached registers
instead of reloading them.

## Known architectural limits
- One Node process; SQLite in WAL mode; not designed for multiple server instances.
- The register loads a whole account (or all accounts) into the browser and virtualises rendering; fine at 51k rows, would need paging far beyond that.
- Offline use: the PWA caches the app shell only; writing requires the server.
