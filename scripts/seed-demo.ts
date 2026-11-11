/**
 * Creates a demo installation with invented data (for trying the app, screenshots and e2e tests).
 *   BR_DATA_DIR=./demo-data npx tsx scripts/seed-demo.ts [months] [txPerMonth]
 * Login: demo / demo-password-123
 */
import { loadConfig } from '../src/server/config.ts';
import { Core } from '../src/server/core.ts';
import { generateBudget } from '../tests/fixtures/generate.ts';
import { addMonths, monthOf, todayISO } from '../src/shared/dates.ts';

const months = Number(process.argv[2] ?? 26), per = Number(process.argv[3] ?? 45);
const core = new Core(loadConfig());
if (!core.auth.hasUser()) await core.auth.setup('demo', 'demo-password-123', undefined, true);
const svc = core.createBudget('Demo-husholdning');
const g = generateBudget(svc, { startMonth: addMonths(monthOf(todayISO()), -(months - 1)), months, txPerMonth: per, seed: 5 });
svc.saveScheduled({ accountId: g.accounts.checking, nextDate: addMonths(monthOf(todayISO()), 1) + '-01', frequency: 'monthly', payeeName: 'Boligforeningen', categoryId: g.categories.Husleje, memo: 'Husleje', amount: -9500_00, flag: null, transferAccountId: null, splits: [] });
console.log(`Seeded "${svc.getSettings().name}" with ${g.txCount} transactions over ${months} months in ${core.cfg.dataDir}`);
core.close();
