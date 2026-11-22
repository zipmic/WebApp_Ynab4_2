// Sync cost for a large budget (10 years, ~51,000 transactions): sharing it, a new computer joining, one change.
// Run: npx tsx tests/perf/sync-perf.ts
import { mkdtempSync, readdirSync, statSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { loadConfig } from '../../src/server/config.ts';
import { Core } from '../../src/server/core.ts';
import { generateBudget } from '../fixtures/generate.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const time = async <T>(label: string, fn: () => T | Promise<T>, limit?: number) => {
  const t = performance.now(); const r = await fn(); const ms = performance.now() - t;
  console.log(`${limit === undefined || ms <= limit ? '✓' : '✗'} ${label.padEnd(58)} ${ms.toFixed(0).padStart(6)} ms${limit ? `   (limit ${limit} ms)` : ''}`);
  if (limit !== undefined && ms > limit) process.exitCode = 1;
  return r;
};
const A = new Core(loadConfig({ BR_DATA_DIR: tmp('br-pa-'), BR_DESKTOP: '1' }), { syncAuto: false });
const B = new Core(loadConfig({ BR_DATA_DIR: tmp('br-pb-'), BR_DESKTOP: '1' }), { syncAuto: false });
const svc = A.createBudget('Large');
await time('generate 10 years of history (one-off)', () => generateBudget(svc, { startMonth: '2017-01', months: 120, txPerMonth: 425, seed: 1 }));
const n = (svc.db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n;
console.log(`  ${n} transactions`);
const { folder } = await time('share the budget through a folder (complete snapshot)', () => A.sync!.publish(svc.id, tmp('br-ps-')), 15000);
const snap = readdirSync(join(folder, 'snapshots'))[0];
console.log(`  snapshot file: ${(statSync(join(folder, 'snapshots', snap)).size / 1024 / 1024).toFixed(1)} MB (compressed)`);
const { id: bid } = await time('a second computer opens it from the folder', () => B.sync!.join(folder), 30000);
const acc = svc.listAccounts()[0].id; const cat = svc.listCategories()[0].id;
await time('add a transaction (incl. recording the change)', () => svc.createTransaction({ accountId: acc, date: '2026-11-01', amount: -12_34, payeeName: 'Perf', categoryId: cat }), 150);
await time('write it to the folder (sync cycle on the first computer)', () => A.sync!.syncNow(svc.id), 2000);
await time('read and apply it on the second computer', () => B.sync!.syncNow(bid), 2000);
const same = JSON.stringify(A.service(svc.id).getBudget('2026-11')) === JSON.stringify(B.service(bid).getBudget('2026-11'));
console.log(`${same ? '✓' : '✗'} both computers compute the same budget`); if (!same) process.exitCode = 1;
A.close(); B.close();
