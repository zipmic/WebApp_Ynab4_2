# Handoff to Claude Opus

Read this whole file first, then `CLAUDE.md`. Everything you need is in the repository; do not rely on earlier conversations.

## 1. Objective
Budget Reborn is a private, self-hosted, browser-based replacement for YNAB4 for one household. The owner must be
able to import their real YNAB4 budget and continue budgeting with identical numbers, on desktop and phone.

## 2. Non-negotiable requirements
- Financial correctness over everything; integer minor units only; YNAB4 behaviour, not subscription-YNAB behaviour.
- The owner's history must import without loss; discrepancies are reported, never hidden or "balanced away".
- Private single-user system: every API route authenticated; no telemetry; no external requests (OCR is local).
- Never commit real financial data. Fixtures are synthetic. Audit reports with details stay outside the repository.
- Preserve existing functionality and UI. No broad refactors or redesigns.

## 3. Verified state
See `docs/PROJECT_STATUS.md` for the full table. In short: engine, register, reconciliation, undo, native YNAB4
import (validated on the owner's real 12-year budget), migration audit, concurrency/atomicity/schema-upgrade safety,
authentication (incl. passkeys with a virtual authenticator), backups, Smart Bank Import and the UI all pass their tests:
98 unit/integration tests, 17 browser steps, benchmark within limits.

## 4. Architecture decisions (do not re-litigate without new evidence)
Details and reasons: `docs/ARCHITECTURE.md`. Summary: Node + Fastify + one SQLite file per budget; balances derived,
never stored; all writes through `BudgetService.mutate()`; trigger-based undo; one revision per budget for conflict
detection; shared TypeScript domain code; browser-side OCR; imports via a neutral `ImportModel`; one owner account.

## 5. Where things are
| Topic | Files |
|---|---|
| Budget rules | `src/shared/engine.ts`, tests `tests/unit/engine.test.ts`, doc `docs/BUDGET_ENGINE.md` |
| All budget operations | `src/server/budgetService.ts`, tests `tests/unit/service.test.ts`, `tests/unit/integrity.test.ts` |
| Schema and migrations | `src/server/db.ts` |
| YNAB4 import | `src/shared/ynab4native.ts`, `src/shared/ynab4csv.ts`, `src/server/importService.ts`, tests `tests/unit/ynab4.test.ts` |
| Migration audit | `src/server/migrationAudit.ts`, `scripts/audit-ynab4.ts` |
| HTTP API, security hooks | `src/server/app.ts`, `src/server/auth.ts`, tests `tests/unit/security.test.ts` |
| Budget files, backups, restore | `src/server/core.ts` |
| Bank import | `src/shared/bankparse.ts`, `src/shared/matching.ts`, `src/server/bankImportService.ts`, `src/web/views/BankImport.tsx`, `src/web/lib/ocr.ts`, tests `tests/unit/bankimport.test.ts` |
| UI | `src/web/views/*`, `src/web/components/*`, `src/web/lib/*` |
| Synthetic data | `tests/fixtures/generate.ts` (budget generator, `toYfull`), `tests/fixtures/make-screens.mjs`, `scripts/seed-demo.ts` |
| Deployment helpers | `deploy/*`, `.env.example` |

## 6. Critical financial logic
`docs/BUDGET_ENGINE.md` is the specification, with the evidence for each rule. The two things most easily broken:
1. The **sticky** red-arrow setting and next-month deduction of overspending (`computeBudget`).
2. Category rules on transfers (`BudgetService.transferCategories`): none between budget accounts, none on tracking rows, budget-side only for budget↔tracking.

## 7. YNAB4 import compatibility
`docs/DATA_MIGRATION.md` records the format as observed in a real file and the audit result. The native import of
the owner's budget is PARTIAL only for two non-financial items (15 payee case-variants merged; 48 payee rename rules not imported).

## 8. Security and deployment
`docs/SECURITY_AND_DEPLOYMENT.md`. **Hosting is a pending owner decision**: the web space they probed is PHP-only and
cannot run this backend. Do **not** start a PHP rewrite; ask the owner which Node-capable option they choose (D1 below).

## 9. Known bugs and limitations
`docs/PROJECT_STATUS.md` → "Known bugs and rough edges", "Missing features", "Implemented but not verified".

## 10–12. Backlog (priority order, with dependencies and acceptance criteria)
Work top to bottom unless the owner says otherwise. Each task is small; finish, test and commit one before the next.

### M — Migration confidence (highest priority)
**M1. Compare a native import with YNAB4's own Budget.csv** — *done*: on the owner's real export all 51,770 category-months are identical (budgeted, activity, balance). The real export showed two things the first version did not handle, both fixed with tests: hidden categories whose group was renamed after hiding (now matched by full YNAB4 name via the source files) and empty-group rows.
- Add `--budget-csv <file>` to `scripts/audit-ynab4.ts`: parse the Budget export with the existing code in `ynab4csv.ts` (reuse its month/amount parsing; categories match by group name + category name, hidden categories by their original names), and compare budgeted, outflows and balance for every category-month with `svc.getBudget(month)`.
- Accept: a new audit area "Month values vs. YNAB4 export" with PASS/FAIL, counts and (ids/names only in a `--json` file outside the repo); synthetic test using `exportYnab4Csv` from `tests/unit/ynab4.test.ts` (move it to `tests/fixtures`); one deliberately wrong cell is detected.
- If the real comparison shows differences: stop and report to the owner with the affected months and categories before changing `engine.ts`.

**M2. Validate the CSV importer against the same real export** *(depends on M1's files)*
- Run the wizard/API with the real Register + Budget CSV in a temp data dir; fix header/format mismatches; add synthetic regression tests for each.
- Accept: preview status `verified`; account balances equal those of the native import.

**M3. Show the migration audit in the wizard** — *done*
- Implemented differently from the first plan, on purpose: instead of a second endpoint that receives the YNAB4 files again (≈20 MB for the owner's budget), `applyImport` takes an optional audit callback; the preview and commit routes pass `auditNativeImport` for native imports. The audit travels in `result.audit`, is stored with the import report (`imports.summary`), and is rendered by `src/web/components/AuditTable.tsx` on the verify and done steps and in Settings → Migration report. A FAIL verdict forces `needs_attention`. No new route.

**M4. Budget name from zip folders with non-ASCII names** — *done*
- `fixZipName` in `src/web/lib/files.ts`: names decoded by fflate as Latin-1 are re-decoded as UTF-8 when their bytes are valid multi-byte UTF-8 (the macOS case, confirmed on the owner's zip). No CP437 fallback: a correctly decoded "Ø" cannot be distinguished from a CP437 byte, and guessing would damage correct names.

### D — Deployment (needs owner decision first)
**D1. Ask the owner which Node-capable host they will use**, then write `docs/DEPLOYMENT_GUIDE.md` with exact steps for that host (install, env file, reverse proxy, first-run token, backups off-site, updates).
- Accept: the owner can follow it start to finish; `curl -I` shows the security headers; setup requires the token from outside.

**D2. Off-site backup routine** — *done*: `scripts/backup-now.ts` (`npm run backup`, bundled as `dist/server/backup-now.mjs`), `--copy-to <folder>`, `Core` maintenance mode, retention per backup kind (also fixed: the old retention loop pruned with a double slice). Documented in SECURITY_AND_DEPLOYMENT.md; the cron/timer setup for the chosen host belongs in D1.

**D3. End-user README.md** — *done* (`README.md`; quick-start and demo commands checked). Update its "Running it for real" section with the host chosen in D1.

### I — Integrity follow-ups
**I1. Browser test for two devices** — *done*: step "two devices" in `tests/e2e/run.mjs`. It also found and fixed a bug: a failed write left its optimistic value on screen; `mutate()` in `src/web/lib/store.tsx` now reloads after a failure.
**I2. Persist login throttling** in `system.sqlite` (table `throttle(key, fails, first, locked_until, strikes)`), same behaviour as `Throttle`. Accept: lockout survives a restart (unit test).
**I3. Restore from JSON export** — *done*: `Core.restoreJson` (`src/server/core.ts`); `POST /api/restore` accepts either a `.budgetreborn` backup or the JSON export (detected by content). Unknown tables/fields are refused as "newer version" rather than dropped.

### U — UI and features (routine)
**U1. Multi-month budget view** on wide screens (2–3 months side by side; reuse `BudgetMonth` queries). Accept: editing any month updates the others' Available to Budget.
**U2. Drag-and-drop reordering** of categories and groups (calls existing `/categories/reorder`). Keep the buttons for touch/keyboard.
**U3. Scheduled transactions: edit split lines; option to enter N days ahead** (setting per budget, default 0).
**U4. Payee management screen** (rename/merge exists in the API: `PATCH /payees/:id`; add list, search, delete unused).
**U5. Date inputs in the budget's date format** (currently browser locale).
**U6. OCR preprocessing for dark-mode screenshots** (adaptive threshold after inversion); keep blocking of low-confidence rows. Accept: `tests/fixtures/screens/mobile-dark.png` yields the same rows as the light one in the browser test.
**U7. Configurable keyboard shortcuts; PIN lock** (client-side lock screen on top of the session; not a security boundary).
**U8. Reports**: compare figures with YNAB4 on the real budget when the owner can check; add "spending by payee".
**U9. PWA check on phones** (install, icon, offline message).

### Dependencies
M2 ← M1 (owner's export). D1 ← owner's hosting choice. I1, I2, I3, M3, M4, U* are independent.

## 13. Commands
```bash
npm install
npm test                      # 98 tests, a few seconds
npm run typecheck
npm run build && npm run test:e2e    # 17 browser steps, ~40 s
npm run test:perf             # ~30 s, enforces time limits
npm run audit:ynab4 -- "<path to .ynab4 folder or zip>"   # on real data: keep output/JSON outside the repo
BR_DATA_DIR=./demo-data npx tsx scripts/seed-demo.ts && BR_DATA_DIR=./demo-data npm run dev   # demo login: demo / demo-password-123
```

## 14. Do not break
- `npm test`, `npm run typecheck`, `npm run test:e2e`, `npm run test:perf` must pass before every commit that touches code.
- `src/shared/engine.ts` and the reference in `src/server/migrationAudit.ts`: change only with evidence, a test, and a fresh audit run.
- Never edit an existing entry of `BUDGET_MIGRATIONS`; append and add an upgrade test.
- Never bypass `mutate()`; never write SQL against a budget database from `app.ts`.
- Keep every route behind the session check (the route-table test will fail otherwise — do not weaken that test).
- Do not weaken: review-before-import for uncertain bank rows, duplicate confirmation, confirmation for reconciliation adjustments, new-budget-only imports and restores.
- Do not add network calls, analytics, CDNs or fonts from other origins (CSP is `default-src 'self'`).
- Do not commit anything under the ignore rules for financial data; do not paste real names, payees or amounts into tests, docs or commit messages.

## 15. Exact next task
**M2**: validate the CSV importer against the owner's real Register.csv + Budget.csv (structure observed: see DATA_MIGRATION.md).
Run them through the import preview in a temporary data directory, compare account balances and the audit with the native
import, fix mismatches with synthetic regression tests, report counts only. Owner's answers so far: hosting = the
owner's own web space, where other npm/Node apps have worked (D1: ask for its control-panel type when writing the
guide); I2 = no opinion from the owner (leave it, it is low priority for a single user); the earlier test-name slip in
Git history = owner says leave it.
