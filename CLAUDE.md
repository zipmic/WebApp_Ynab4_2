# Budget Reborn — entry point for Claude sessions

**Read `docs/OPUS_HANDOFF.md` before changing anything.** It lists what is verified, what must not be broken, and the next task.

## What this is
A private, self-hosted, browser-based successor to YNAB4 for one household's real finances. It must reproduce
YNAB4's budgeting behaviour exactly and import the owner's existing YNAB4 budget without loss.

## Stack
- Shared pure TypeScript domain code: `src/shared` (money, dates, budget engine, YNAB4 readers, bank-text parser, matching)
- Backend: Node.js ≥ 20.11, Fastify 5, SQLite (better-sqlite3), one database file per budget: `src/server`
- Frontend: React 19 + TypeScript + Vite + Tailwind 4, TanStack Query/Virtual, hand-written shadcn-style components: `src/web`
- Tests: Vitest (`tests/unit`), Playwright script (`tests/e2e/run.mjs`), benchmark (`tests/perf/perf.ts`)

## Commands
```bash
npm install            # also copies the local OCR engine into public/ocr
npm run dev            # API on :8787 + Vite on :5173
npm test               # unit + integration (must stay green)
npm run typecheck
npm run build && npm run test:e2e   # browser test against the production build
npm run test:perf      # 51k-transaction benchmark with time limits
npm run audit:ynab4 -- <.ynab4 folder | zip | Budget.yfull>   # migration audit, prints ids/counts only
npm run backup -- --copy-to <folder>                       # back up every budget now (cron-safe)
npm start              # production (after build); settings via `node --env-file=<file> dist/server/index.mjs`
```

## Rules that are not negotiable
1. **Money is integer minor units (øre) everywhere.** Never parse, add or store money as floating point. Use `src/shared/money.ts`.
2. **The budget rules live only in `src/shared/engine.ts`** and are verified against a real 12-year YNAB4 budget
   (`docs/BUDGET_ENGINE.md`). Do not "modernise" them towards subscription-YNAB behaviour. Any change needs a test and a re-run of the audit.
3. **Every write goes through `BudgetService.mutate()`** (one SQLite transaction + undo group + revision bump). Never write to a budget database from a route or another module directly.
4. **Never adjust balances to make numbers match.** Discrepancies are reported, not hidden. Reconciliation adjustments only after explicit user confirmation.
5. **Imports create a new budget and are all-or-nothing.** Source files are read-only.
6. **Every `/api` route requires a session** unless listed in `PUBLIC_ROUTES` (`src/server/app.ts`); a test enumerates the route table and fails if a new route is open.
7. **Privacy:** no telemetry, no external requests (OCR is local). Never commit real financial data, exported budgets, backups or audit reports with details. Test fixtures are synthetic (`tests/fixtures/generate.ts`).
8. Keep the UI and existing behaviour; do not redesign or refactor broadly without a reason tied to a backlog item.

## Conventions
- TypeScript strict; ES modules; relative imports with `.ts` extension in server/shared code.
- Dates are `YYYY-MM-DD` strings, months `YYYY-MM`; no `Date` arithmetic on calendar values except in `src/shared/dates.ts`.
- Validation of request bodies with zod in `src/server/app.ts`; domain validation in services; errors via `AppError`.
- New schema changes = append a migration string to `BUDGET_MIGRATIONS` in `src/server/db.ts` (never edit an existing one) and add an upgrade test in `tests/unit/integrity.test.ts`.
- Do not put a `//` comment at the end of a long single-line statement when editing with scripts; it has swallowed code three times in this project.

## Documents
- `docs/OPUS_HANDOFF.md` — status, backlog, acceptance criteria, next task
- `docs/PROJECT_STATUS.md` — verified / unverified / missing
- `docs/ARCHITECTURE.md` — modules, data flow, schema, decisions
- `docs/BUDGET_ENGINE.md` — financial rules and invariants, with evidence
- `docs/YNAB4_COMPATIBILITY.md` — feature-by-feature comparison with YNAB4
- `docs/DATA_MIGRATION.md` — YNAB4 file format as observed, mapping, audit
- `docs/SECURITY_AND_DEPLOYMENT.md` — authentication, hosting, deployment
- `docs/DEPLOYMENT_GUIDE.md` — the owner's installation: home Windows computer + Tailscale (Danish)
