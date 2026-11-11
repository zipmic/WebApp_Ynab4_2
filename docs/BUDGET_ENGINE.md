# Budget engine — rules, invariants and evidence

Code: `src/shared/engine.ts` (pure, ~120 lines). Fed by `BudgetService.engine()` in `src/server/budgetService.ts`.
All amounts are integers in minor units (øre). The engine throws on a non-integer.

## Strongest evidence: YNAB4's own figures
The owner exported the real budget from YNAB4 (Budget.csv: budgeted, outflows and category balance for every category
in every month). Comparing it with a native import of the same budget (`npm run audit:ynab4 -- <zip> --budget-csv …`):
**budgeted, activity and category balance are identical in all 51,770 category-months, 2014-03 – 2028-01**, and the
import has no values the export lacks. Every rule that influences a category balance (1–10, 12–15 below) is therefore
confirmed against YNAB4 itself. Available to Budget is not in the export; it remains confirmed by the zero test below.

## Evidence levels used below
- **VERIFIED-REAL** — confirmed against the owner's real YNAB4 budget (12 years, 7,208 live transactions, 180 budget months).
- **VERIFIED-FILE** — confirmed from the structure of the real file (field values/patterns), not from computed balances.
- **ASSUMED** — from knowledge of YNAB4; no independent evidence available. Listed in "Open points".

### How the rules were verified against real data
A YNAB4 user budgets until *Available to Budget* shows exactly 0,00. YNAB4 does not store computed balances in
its file (`cachedBalance` is 0 for every category), so the test is: with a candidate rule set, in how many of the
149 fully budgeted months (2014-06 … 2026-10) does our calculation give exactly zero?

| Rule set | Months with Available to Budget = 0,00 |
|---|---|
| **Implemented rules** | **120 of 149, including the latest 19 in a row** |
| Red arrow applies only in the month it is set | 8 |
| Red arrow ignored | 6 |
| All overspending stays in the category | 5 |
| "Income for next month" counted in its own month | 7 |
| Overspending deducted in the same month | 66 |

An exact-zero result needs every earlier month, every category rollover and every income assignment to be
right to the øre, so 120 exact hits (and a collapse for every alternative) is strong confirmation. The 29
non-zero months are consistent with months the owner did not budget to zero; they are not proven either way.

## Definitions
For a budget month M and a category c (only transactions in **budget accounts** count):
- `activity(M,c)` = Σ amounts of transactions/split lines dated in M with category c.
- `available(M,c) = carryIn(M,c) + budgeted(M,c) + activity(M,c)`.
- `handling(M,c)` = the most recent explicit overspending setting stored on (m ≤ M, c), default `affects_buffer`.
- Carry to next month:
  - `available ≥ 0` → carries in full.
  - `available < 0` and handling `affects_buffer` → category restarts at 0; the shortfall is added to `overspent(M)`.
  - `available < 0` and handling `confined` ("red arrow: subtract from next month's category balance") → the negative carries in the category; ATB is not touched.
- `income(M)` = Σ "Income for this month" dated in M + Σ "Income for next month" dated in M−1.
- `ATB(M) = ATB(M−1) − overspent(M−1) + income(M) − Σ budgeted(M)`. ATB may be negative ("overbudgeted") and carries.

## Rules and their status
| # | Rule | Status |
|---|---|---|
| 1 | Positive category balances roll over | VERIFIED-REAL |
| 2 | Overspending (cash or credit — YNAB4 does not distinguish) is deducted from **next** month's ATB and the category restarts at 0 | VERIFIED-REAL |
| 3 | Red-arrow setting (`Confined` / `AffectsBuffer`) is **sticky**: it holds for later months until another setting is stored | VERIFIED-REAL (zero test) and VERIFIED-FILE (settings are toggled on/off over years; one category has 8 `Confined` and 6 `AffectsBuffer` entries in 154 months — meaningless unless they persist) |
| 4 | "Income for next month" becomes available one month after its date | VERIFIED-REAL |
| 5 | Inflows categorised to a normal category raise that category, not ATB (457 such transactions in the real budget) | VERIFIED-REAL |
| 6 | Budgeting in a future month reduces only that month's ATB, never the current month's | VERIFIED-REAL (future months exist in the file up to 2028) |
| 7 | Negative ATB carries forward | VERIFIED-REAL |
| 8 | Transfers between two budget accounts have no category and no budget effect | VERIFIED-FILE (0 categorised on↔on transfers) |
| 9 | Transfers budget → tracking account are spending and carry a category on the budget side (412 of 413 in the real file) | VERIFIED-REAL |
| 10 | Tracking-account transactions never carry a category (0 in the real file) | VERIFIED-FILE |
| 11 | Uncategorised transactions in budget accounts change the account balance but are invisible to the budget | ASSUMED (2 such rows exist; too few to prove) — the app shows a warning banner with a link |
| 12 | Starting balance of a budget account = inflow categorised "Income for this month"; tracking accounts' starting balances have no category | VERIFIED-FILE |
| 13 | Pre-YNAB Debt categories are ordinary categories whose first month stores `Confined` | VERIFIED-FILE — no special case in the engine |
| 14 | Future-dated transactions count in the month of their date | VERIFIED-REAL (36 future rows are part of the zero test) |
| 15 | Split lines count individually; the parent has no category | VERIFIED-REAL |
| 16 | Reconciliation adjustment = visible transaction, "Income for this month" in a budget account | ASSUMED (YNAB4 behaviour from memory) |

## Invariants (checked by `BudgetService.checkIntegrity()` and by tests)
1. Account balance = Σ its top-level transactions (starting balance is a transaction).
2. Every transfer row has exactly one partner that points back, in the other account, same date, opposite amount; all transfer rows sum to 0.
3. Every split parent's amount = Σ its lines; lines share the parent's account and date.
4. No category on tracking-account rows or on transfers between budget accounts.
5. **Budget identity, every month:** categorised budget cash through M (with "income next month" counted from M+1) = `ATB(M) + Σ available(M,c)`.
6. Reconciling changes only the cleared state. Editing amount/date/account of a reconciled transaction requires an explicit flag.

## Recalculation and performance
Nothing is stored except transactions and budgeted amounts; balances are always derived. One SQL aggregate
(`GROUP BY month, category`) feeds the engine, which walks all months. The result is cached per service and
dropped on every write. Cold recalculation of 120 months × 51k transactions ≈ 55 ms; warm month navigation < 1 ms
(`npm run test:perf`). Editing an old transaction therefore updates every later month by construction.

## Independent cross-check
`src/server/migrationAudit.ts` contains a second, separately written implementation of the same rules and
compares it with the engine for every category in every month of an imported budget. If you change the engine
you must change the reference deliberately as well — a disagreement fails the audit.

## Open points
- Rules 11 and 16 are assumptions.
- Month balances: settled — identical to YNAB4's own export in all 51,770 category-months (see top of this file).
- Rounding: quick-budget averages round half away from zero; YNAB4's rounding there is unverified (does not affect imported data).
