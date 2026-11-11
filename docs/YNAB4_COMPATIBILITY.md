# Compatibility with YNAB4

Legend: ✅ same behaviour, verified · ☑️ implemented, not verified against YNAB4 itself · ➖ different by design · ❌ missing

## Budgeting
| YNAB4 feature | State | Notes |
|---|---|---|
| Category groups / categories, order, hide, rename, notes | ☑️ | reorder by buttons/menus (no drag and drop yet) |
| Budgeted / Outflows(Activity) / Balance(Available) per month | ✅ | see BUDGET_ENGINE.md |
| Available to Budget with its four components | ✅ | header shows Not budgeted/Overbudgeted in prev, Overspent in prev, Income, Budgeted |
| Income for this month / next month | ✅ | |
| Overspending → next month's Available to Budget | ✅ | |
| Red arrow (carry negative balance in category), persistent | ✅ | click a negative balance |
| Budgeting future months | ✅ | |
| Quick budget (last month, average, balance to zero…) | ☑️ | rounding of averages unverified |
| Move money between categories | ➖ | convenience; adjusts both budgeted amounts |
| Multi-month side-by-side view | ❌ | one month + inspector |
| Month and category notes | ✅ | imported |
| Hidden categories | ✅ | "Show hidden" toggle; deleted-group categories land in hidden groups |
| Pre-YNAB Debt | ✅ | ordinary categories with the imported red-arrow setting |
| Uncategorised transactions ignored by the budget | ☑️ | warning banner added |

## Accounts and register
| Feature | State | Notes |
|---|---|---|
| Budget and off-budget (tracking) accounts, closed accounts | ✅ | on/off budget fixed once an account has transactions (as YNAB4) |
| Account types | ☑️ | all YNAB4 types mapped; 5 seen in real data |
| Register columns, inline edit, running balance, sort, search, filter | ☑️ | |
| Transfers incl. to/from tracking accounts | ✅ | |
| Split transactions, split-line transfers | ✅ / ☑️ | split-line transfers only synthetic-tested |
| Cleared / reconciled, reconciliation with adjustment on confirmation | ☑️ | adjustment categorised as income this month (assumed YNAB4 behaviour) |
| Flags (six colours) | ✅ | |
| Check numbers | ➖ | kept as `#123` memo prefix |
| Scheduled transactions, all frequencies | ☑️ | entered when due (YNAB4 can also enter ahead of time; imported future-dated entries are kept) |
| Payee autocomplete, remembered category | ✅ | |
| Payee rename rules | ❌ | not imported; Smart Bank Import has its own rules |
| Undo / redo | ➖ | persistent, 200 steps |
| Duplicate, bulk edit, move between accounts | ☑️ | |
| "Accept"/approve imported transactions | ➖ | replaced by the Smart Bank Import review screen |

## Reports
Spending by category, spending over time, income vs. expenses, net worth, account balances, category over time,
budget vs. actual — all from real data with drill-down and CSV export. ☑️ (figures not compared with YNAB4's reports).

## Files and sync
| Feature | State |
|---|---|
| Open a `.ynab4` budget (migration, one-way) | ✅ validated on a real budget |
| YNAB4 CSV export import | ✅ validated on a real export |
| Writing YNAB4 files / syncing back to YNAB4 | ❌ not planned |
| Multiple budgets | ✅ |
| Backups | ➖ SQLite snapshots, automatic daily + before imports |
| Multi-device use | ➖ central server; concurrent edits detected (409) instead of Dropbox sync |
| Currency/date formats | ☑️ Danish defaults; configurable symbol, separators, date format; two decimals only |

## Known differences that could surprise a YNAB4 user
1. Payees that differed only in capitalisation are one payee.
2. Scheduled transactions are not entered ahead of their date.
3. No multi-month view; no drag-and-drop reordering.
4. Reconciled transactions can be edited after an explicit confirmation (YNAB4 warns similarly).
5. Amount fields accept arithmetic.
