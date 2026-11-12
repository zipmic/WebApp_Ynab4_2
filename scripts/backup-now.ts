/**
 * Back up every budget now — meant for cron / a systemd timer, and safe while the server is running
 * (SQLite snapshots via VACUUM INTO; nothing the server owns is touched).
 *
 *   BR_DATA_DIR=/var/lib/budget-reborn npx tsx scripts/backup-now.ts [--copy-to /mnt/offsite/budget-reborn]
 *
 * Backups are written to <data>/backups/<budget id>/<UTC time>-scheduled.sqlite; the newest BR_BACKUP_KEEP
 * scheduled backups per budget are kept. With --copy-to (or BR_BACKUP_COPY_TO in the environment), each new backup is also copied (as <budget name>-<time>.budgetreborn)
 * to a second location, e.g. a mounted disk or a folder synced off the machine. Exit code 1 if any budget failed.
 * Run it with the same version of the application as the server.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/server/config.ts';
import { Core } from '../src/server/core.ts';

const args = process.argv.slice(2); const i = args.indexOf('--copy-to');
// --copy-to on the command line wins over BR_BACKUP_COPY_TO from the env file
const copyTo = i >= 0 ? args[i + 1] : process.env.BR_BACKUP_COPY_TO?.trim() || null;
if ((i >= 0 && !copyTo) || args.some((a, k) => a !== '--copy-to' && k !== i + 1)) { console.error('usage: npx tsx scripts/backup-now.ts [--copy-to <folder>]'); process.exit(2); }
const core = new Core(loadConfig(), { maintenance: true });
let failed = 0; const budgets = core.listBudgets();
if (copyTo) mkdirSync(resolve(copyTo), { recursive: true, mode: 0o700 });
for (const b of budgets) {
  try {
    const name = core.backup(b.id, 'scheduled'); const path = core.backupPath(b.id, name);
    let line = `ok   ${b.id}  ${path}`;
    if (copyTo) { const target = join(resolve(copyTo), `${b.name.replace(/[^\w .-]/g, '_')}-${name.replace(/-scheduled\.sqlite$/, '')}.budgetreborn`); copyFileSync(path, target); line += `  → ${target}`; }
    console.log(line);
  } catch (e) { failed++; console.error(`FAIL ${b.id}  ${(e as Error).message}`); }
}
console.log(`${budgets.length - failed} of ${budgets.length} budget(s) backed up`);
core.close(); process.exit(failed ? 1 : 0);
