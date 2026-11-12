# Budget Reborn

A private, self-hosted budgeting app that works the way **YNAB4** did — zero-based envelope budgeting, the same
rollover and overspending rules, the same "Available to Budget" — in your browser on computer, tablet and phone.
It can import your existing YNAB4 budget with its full history, and it never sends your data anywhere.

> Budget Reborn is an independent project. It is not made by, affiliated with or endorsed by YNAB.

## What you get
- **Budget screen** with Budgeted / Activity / Available per category and month, YNAB4's overspending rules
  (including the "red arrow" that keeps a negative balance in the category), income for this or next month,
  budgeting into future months, quick budget, notes, hidden categories.
- **Account registers** for budget and tracking accounts: transfers, split transactions, cleared/reconciled,
  flags, search, bulk edit, scheduled transactions, undo/redo, and reconciliation that explains differences.
- **YNAB4 migration** from the original `.ynab4` budget folder (or a zip of it), or from YNAB4's CSV export, with a
  preview and an automatic audit that compares every record and every month with your original files.
- **Smart Bank Import**: screenshots of your banking app (read on your own device), bank CSV files, or JSON
  produced by any tool you like — always reviewed by you, with duplicate detection, before anything is saved.
- **Reports**: spending by category and over time, income vs. expenses, net worth, account balances, budget vs. actual.
- **Backups** every day the budget is used and before every import, one-click download, restore, CSV/JSON export.
- **Security**: one private login (Argon2id), optional two-factor codes and passkeys, HTTPS, no registration, no tracking.

## Try it on your computer
Requires [Node.js](https://nodejs.org) 20.11 or newer.
```bash
npm install
npm run dev
```
Open <http://localhost:5173>. The first visit asks you to create your login; then choose **Import YNAB4 budget**,
**Create new budget** or **Restore backup**. Your data is stored in the `data` folder.

To look around with invented demo data instead (login `demo` / `demo-password-123`):
```bash
BR_DATA_DIR=./demo-data npx tsx scripts/seed-demo.ts
BR_DATA_DIR=./demo-data npm run dev
```

## Moving from YNAB4
1. Find your budget folder (usually in `Documents/YNAB` or `Dropbox/YNAB`, named `My Budget~XXXXXXXX.ynab4`).
   Using the folder is best: it contains everything, including scheduled transactions, notes and settings that the
   CSV export leaves out. You can zip it first.
2. In Budget Reborn choose **Import YNAB4 budget** and drop the folder or zip. Nothing is changed until you confirm,
   and your original files are only read.
3. Check the preview and the **independent audit**. It compares every account, transaction, transfer, split,
   budgeted amount and every month's balances with your original files and shows PASS/FAIL per area.
4. Import. The budget opens in the current month.

For an extra check against YNAB4's own month figures, export the budget from YNAB4 (File → Export) and run
`npm run audit:ynab4 -- "<your .ynab4 folder or zip>" --budget-csv "<…-Budget.csv>"`. It prints counts only.

## Running it for real
Budget Reborn needs a machine that can keep a **Node.js** process running. Ordinary PHP-only web space cannot run it.
- **Home computer + Tailscale (recommended, Windows):** step-by-step guide in Danish:
  [docs/DEPLOYMENT_GUIDE.md](docs/DEPLOYMENT_GUIDE.md). Scripts in `deploy/windows/` install it as an automatic
  service with nightly backups; Tailscale gives your phone private HTTPS access without exposing anything to the internet.
- **Linux server / VPS:** `npm ci && npm run build`, then `node --env-file=<settings file> dist/server/index.mjs` behind an
  HTTPS reverse proxy (examples in `deploy/`). All settings are listed in `.env.example`; security details and off-site
  backups (`node dist/server/backup-now.mjs --copy-to <folder>`) are in
  [docs/SECURITY_AND_DEPLOYMENT.md](docs/SECURITY_AND_DEPLOYMENT.md).

## Your data
- Everything stays on your server: one SQLite file per budget in the data folder. Keep that folder out of any web folder.
- No telemetry, analytics or external requests. Screenshot text recognition runs in your browser.
- An optional external AI reader for difficult screenshots exists but is off unless the server owner configures it,
  and it asks for your consent each time.

## For developers
Start with [CLAUDE.md](CLAUDE.md) and [docs/](docs): architecture, the budget rules with their evidence, the YNAB4
file format, project status and the backlog. `npm test`, `npm run typecheck`, `npm run build && npm run test:e2e`.
