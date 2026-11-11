/** Performance benchmark on a synthetic 10-year budget with > 50,000 transactions. Run: npm run test:perf */
import { mkdtempSync, rmSync, statSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { openBudgetDb } from '../../src/server/db.ts';
import { BudgetService } from '../../src/server/budgetService.ts';
import { applyImport } from '../../src/server/importService.ts';
import { parseYnab4Native } from '../../src/shared/ynab4native.ts';
import { generateBudget, toYfull } from '../fixtures/generate.ts';

const dir = mkdtempSync(join(tmpdir(), 'br-perf-')); const file = join(dir, 'perf.sqlite');
const svc = new BudgetService(openBudgetDb(file), 'perf');
const results: [string, number, number | null][] = [];
const time = <T>(label: string, fn: () => T, budgetMs: number | null = null, runs = 1): T => {
  let out!: T; const times: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); out = fn(); times.push(performance.now() - t); }
  const med = times.sort((a, b) => a - b)[Math.floor(times.length / 2)]; results.push([label, med, budgetMs]); return out;
};
const g = time('generate 10 years of history (one-off)', () => generateBudget(svc, { startMonth: '2017-01', months: 120, txPerMonth: 425, seed: 1 }));
const count = (svc.db.prepare('SELECT COUNT(*) n FROM transactions WHERE parent_id IS NULL').get() as { n: number }).n;
const rows = (svc.db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n;
console.log(`\n${count.toLocaleString()} transactions (${rows.toLocaleString()} rows incl. split lines), 120 months, ${(statSync(file).size / 1e6).toFixed(1)} MB database\n`);
const bump = () => { svc.version++; };
time('budget month, cold (recompute all 120+ months from SQL)', () => { bump(); return svc.getBudget('2026-06'); }, 150, 7);
time('budget month, warm (navigate to another month)', () => svc.getBudget('2024-03'), 5, 25);
time('sidebar balances for all accounts, cold', () => { bump(); return svc.listAccounts(); }, 100, 7);
time('open one account register (largest account)', () => svc.listTransactions({ accountId: g.accounts.checking }), 400, 5);
time('open All Accounts register (every transaction)', () => svc.listTransactions(), 600, 5);
time('full-text search across all transactions', () => svc.listTransactions({ search: 'netto' }), 250, 5);
const t0 = svc.listTransactions({ from: '2017-03-01', to: '2017-03-31', accountId: g.accounts.checking }).find(t => !t.transferAccountId && !t.splits.length && t.cleared !== 'reconciled')!;
let amt = -1000;
time('edit a 2017 transaction + recompute every later month', () => { svc.updateTransaction(t0.id, { amount: amt-- }); return svc.getBudget('2026-12'); }, 150, 9);
time('add a transaction + recompute budget', () => { svc.createTransaction({ accountId: g.accounts.checking, date: '2019-05-05', payeeName: 'Netto', categoryId: g.categories.Dagligvarer, amount: -12345 }); return svc.getBudget('2026-12'); }, 150, 9);
time('change a budgeted amount in 2018 + recompute', () => { svc.setBudget('2018-02', g.categories.Transport, { budgeted: 1500_00 + (amt-- % 7) * 100 }); return svc.getBudget('2026-12'); }, 150, 9);
time('undo', () => svc.undo(), 100, 5);
time('report: activity by month and category, 10 years', () => svc.reportActivity({ from: '2017-01-01', to: '2026-12-31' }), 200, 5);
time('report: account balance history', () => svc.reportBalances(), 200, 5);
time('integrity check (all invariants, all months)', () => svc.checkIntegrity(), 2000, 3);
const yfull = time('serialise to YNAB4 Budget.yfull (test helper)', () => JSON.stringify(toYfull(svc)));
console.log(`Budget.yfull size: ${(yfull.length / 1e6).toFixed(1)} MB`);
const model = time('parse native YNAB4 budget', () => parseYnab4Native([{ path: 'Budget.yfull', text: yfull }]), 5000);
const mem = new BudgetService(openBudgetDb(':memory:'), 'import');
const res = time('import + full audit of 10 years', () => applyImport(mem, model, 'perf'), 15000);
console.log(`Import audit: ${res.status}\n`);
let failed = 0;
for (const [label, ms, budget] of results) { const ok = budget === null || ms <= budget; if (!ok) failed++; console.log(`${ok ? '✓' : '✗'} ${label.padEnd(62)} ${ms.toFixed(1).padStart(9)} ms${budget ? `   (limit ${budget} ms)` : ''}`); }
if (svc.checkIntegrity().length || res.status !== 'verified') { console.log('INTEGRITY FAILURE'); failed++; }
svc.db.close(); mem.db.close(); rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
