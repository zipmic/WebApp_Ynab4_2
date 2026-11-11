# YNAB4 data migration

Code: `src/shared/ynab4native.ts` (native reader), `src/shared/ynab4csv.ts` (CSV reader), `src/shared/importModel.ts`
(neutral model), `src/server/importService.ts` (write + first audit), `src/server/migrationAudit.ts` (independent audit),
`src/web/views/Ynab4Import.tsx` (wizard), `scripts/audit-ynab4.ts` (CLI).

## Status
| Source | Status |
|---|---|
| Native `.ynab4` folder / zip | **Validated on the owner's real budget**: overall PARTIAL, with every financial area PASS (details below) |
| YNAB4 CSV export (Register + Budget) | Works on synthetic exports written from memory of the format; **not validated against a real export** |

## Native format — as OBSERVED in a real budget (YNAB 4.3.843, data version 4.2)
```
<Name>.ynab4/
  Budget.ymeta                         {"formatVersion":"2","relativeDataFolderName":"data13-XXXXXXXX","TED":…}
  Budget (… conflicted copy <date>).ymeta   leftovers from file syncing — point to OLD data folders, must be ignored
  data1~XXXXXXXX/ … data12-XXXXXXXX/   old data folders, contain only a "ContentsCompacted_…txt" marker
  data13-XXXXXXXX/                     the live data folder named by Budget.ymeta
    devices/A.ydevice, B.ydevice       {shortDeviceId, deviceGUID, knowledge, knowledgeInFullBudgetFile, hasFullKnowledge, YNABVersion, …}
    <deviceGUID>/Budget.yfull          the complete budget as JSON (one per device)
    <deviceGUID>/budgetSettings.ybsettings   UI settings (not imported)
    <deviceGUID>/<startKnowledge>_<endVersion>.ydiff   incremental changes
```
- `knowledge` = `"A-29125,B-14196,…"`: per device short id, the highest change number known.
- Both device copies of the real budget had identical knowledge and identical content (different key order only).
- `.ydiff`: `{startVersion, endVersion, publishTime, deviceGUID, shortDeviceId, items:[entity…]}`. Items are full
  entities with explicit `null`s and extra bookkeeping keys (`madeWithKnowledge`, `isResolvedConflict`).
  `publishTime` is display text ("Mon Aug 31 21:53:01 GMT+0200 2026") and **does not sort chronologically**.
  Ordering diffs by the sum of their knowledge counters reproduced the full file's entity versions for all 646
  entities touched by 725 diffs (text ordering got 76 wrong).

`Budget.yfull` top-level keys: `budgetMetaData`, `fileMetaData{currentKnowledge}`, `accounts`, `masterCategories`
(each with `subCategories`, which may be `null`), `payees`, `transactions` (each may have `subTransactions`),
`monthlyBudgets` (each with `monthlySubCategoryBudgets`), `scheduledTransactions`, `accountMappings`.
Every entity has `entityId`, `entityType`, `entityVersion`; deleted ones have `isTombstone: true`.
The full list of field names seen is in `KNOWN` in `src/server/migrationAudit.ts`; the audit flags any other field.

Observed values: `accountType` ∈ Checking, Savings, CreditCard, OtherAsset, OtherLiability (others from documentation);
`cleared` ∈ Cleared, Uncleared, Reconciled; `flag` ∈ Red, Orange, Yellow, Green, Blue, Purple;
`overspendingHandling` ∈ null, Confined, AffectsBuffer; `frequency` ∈ Once, Weekly, Monthly, EveryOtherMonth,
Every3Months, TwiceAYear, Yearly. Amounts are JSON numbers in major units with at most 2 decimals; dates `YYYY-MM-DD`;
budget months `YYYY-MM-01`.

Special identifiers:
| Id | Meaning | Handling |
|---|---|---|
| `Category/__ImmediateIncome__` | Income for this month | `income:this` |
| `Category/__DeferredIncome__` | Income for next month | `income:next` |
| `Category/__Split__` | parent of a split | parent gets no category |
| `MasterCategory/__Internal__`, `MasterCategory/__Income__` | built-in, empty | not imported as groups |
| `MasterCategory/__Hidden__` | holds hidden categories named `"<group name> ` <category name> ` <group entityId>"` | category returns to that group if it is alive, otherwise to a hidden group with the original name |
| `MasterCategory/__PreYNABDebtMaster__`, `Category/PreYNABDebt/<id>` | Pre-YNAB debt | ordinary group/categories; their `Confined` setting is in the file |
| `Payee/Transfer:<accountId>` | transfer payee | not a payee; transfers are links |
| transaction id ending `_T_0` | far side of a transfer | imported like any transaction and linked via `transferTransactionId` |

## Selection rules (no silent merging)
1. Ignore `__MACOSX/` and `._*` files.
2. Data folder = the one named by the file called exactly `Budget.ymeta`.
3. Among `Budget.yfull` files in that folder, take the one whose `currentKnowledge` is largest. If another copy
   knows something it does not → warning `devices_diverged`.
4. Apply only `.ydiff` items whose version is not covered by that knowledge, in knowledge order → warning
   `diffs_applied` with the count. (Real budget: 0 applied — the full copy was complete.)

## Mapping
| YNAB4 | Budget Reborn |
|---|---|
| account (`onBudget`, `hidden`, `accountType`) | account (`on_budget`, `closed`, type); tombstoned accounts skipped |
| master category / sub category, `sortableIndex`, notes | group / category in the same order |
| transaction | top-level row in `transactions`; `source_id` = YNAB4 `entityId` |
| sub transaction | row with `parent_id`; `source_id` = its `entityId` |
| `transferTransactionId` + `targetAccountId` | `transfer_txn_id` + `transfer_account_id`, only if both sides agree on account, date and opposite amount; otherwise imported unlinked as payee "Transfer : <account>" with a warning |
| `checkNumber` | memo prefix `#<number>` |
| monthly category budget (`budgeted`, `overspendingHandling`, note) | `monthly_budgets` row |
| month note | `month_notes` |
| scheduled transaction (`date` = next occurrence, `frequency`) | `scheduled` |
| payee `autoFillCategoryId` | payee's remembered category |
| tombstones | not imported; a deleted category still referenced by live data is kept as hidden |

Not imported: payee rename rules and locations, `accepted`, `dateEnteredFromSchedule`, `lastReconciledBalance/Date`
(observed to disagree with the sum of reconciled transactions, so unusable), UI settings, account mappings.
Payee names differing only in letter case/spacing are merged (15 of 2,350 in the real budget).

## Real-budget result (aggregates only)
`npm run audit:ynab4 -- <zip>` on the real budget: 13 accounts, 310 categories (224 hidden), 7,208 transactions,
52 split lines, 413 transfer pairs, 8,112 budget cells with 244 overspending settings, 180 months, 28 schedules, 110 notes.

| Area | Result |
|---|---|
| Accounts, categories, transactions present exactly once | PASS |
| Dates, accounts, memos, amounts, cleared/reconciled, flags | PASS |
| Payee and category assignments, splits, transfers | PASS |
| Final, cleared and reconciled balance of every account | PASS |
| Budgeted amounts and overspending settings | PASS |
| Activity, income, category balances, Available to Budget — every month | PASS (engine = independent reference) |
| Scheduled transactions, notes, enumerations, unknown fields, internal consistency | PASS |
| Payees | PARTIAL — 15 case/spacing variants merged |
| Payee rename rules | PARTIAL — 48 not imported |
| **Against YNAB4's own Budget export** (`--budget-csv`): budgeted, activity, category balance | **PASS — identical in all 51,770 category-months**, 2014-03 – 2028-01; nothing extra in the import |

Not imported by design (tombstones): 12 accounts, 128 categories, 553 transactions, 197 budget cells, 57 schedules.
Through the HTTP API (as the wizard sends it, including zip junk): preview 0.9 s, commit 1.0 s, second import refused (`ALREADY_IMPORTED`).

## Checking against YNAB4's own month figures
YNAB4 does not store computed balances in its budget file, so the strongest check is against its own Budget export:
```bash
npm run audit:ynab4 -- "<.ynab4 folder or zip>" --budget-csv "<…-Budget.csv>" [--json <file outside the repo>]
```
This adds five areas: rows matched to imported categories (by group + category name; hidden categories by their
original names), budgeted amounts, activity (Outflows column — its sign convention is detected from the data and
stated), category balances, and imported values the export does not list. Examples name CSV line numbers and months
only. Code: `readYnab4BudgetCsv` (`src/shared/ynab4csv.ts`), `compareWithBudgetCsv` (`src/server/migrationAudit.ts`).
Observed in a real export (YNAB 4.3, Danish locale): tab-separated, UTF-8 with BOM, month labels like "marts 2014",
amounts "kr1.234,56" / "-kr12,00", Outflows positive for money out, one row per category per month including zero
rows. Hidden categories appear under master "Hidden Categories" with the Sub Category "<group name when hidden> `
<name> ` <group entity id>" — identical to the name in the .ynab4 file, so with the source files they are matched by
that full name (the group may have been renamed or deleted since). A category group without categories appears as a
row with an empty Sub Category and zero values; such rows are accepted only while all values are zero.

## Safeguards
- Preview = the real import into a throw-away in-memory database, so the user sees the real audit before anything is written.
- Commit creates a **new** budget file; on any error the file is deleted. Existing budgets are backed up first and never modified.
- Fingerprint (SHA-256 of the yfull/ydiff or CSV contents) is stored; importing the same files again needs explicit confirmation.
- The first audit (`importService.ts`) refuses the label "verified" if any check fails or any source row was unreadable.
- Native imports also run the independent audit (`migrationAudit.ts`) in preview and commit; the wizard and Settings → Migration report show it, and a FAIL verdict also prevents "verified".

## CSV route (unvalidated against real exports)
Header-driven; expects Register columns `Account, Flag, Check Number, Date, Payee, Category, Master Category, Sub Category,
Memo, Outflow, Inflow, Cleared, Running Balance` and Budget columns `Month, Category, Master Category, Sub Category, Budgeted,
Outflows, Category Balance`. Transfers are re-paired by account/date/amount, splits re-assembled from `(Split n/m)` memos,
budget/tracking inferred (overridable in the wizard), red-arrow settings inferred from how negative balances continue.
Every category-month is compared with the Budget export.

## Remaining risks
1. `.ydiff` merging is exercised by synthetic tests and by an ordering check on real diffs, but no real budget needing a merge has been imported.
2. Account types Cash, LineOfCredit, PayPal, MerchantAccount, InvestmentAccount, Mortgage and frequencies not in the list above were never seen in real data.
3. Split-line transfers and scheduled splits do not occur in the real budget; only synthetic tests cover them.
