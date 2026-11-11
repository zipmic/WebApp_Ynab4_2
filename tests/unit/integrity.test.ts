import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import type { App } from '../../src/server/app.ts';
import { BudgetService } from '../../src/server/budgetService.ts';
import { BUDGET_MIGRATIONS, BUDGET_SCHEMA_VERSION, openBudgetDb } from '../../src/server/db.ts';
import { applyImport } from '../../src/server/importService.ts';
import { auditNativeImport, compareWithBudgetCsv, verdictOf } from '../../src/server/migrationAudit.ts';
import { exportYnab4Csv } from '../fixtures/ynab4csv.ts';
import { parseYnab4Native } from '../../src/shared/ynab4native.ts';
import { generateBudget, toYfull } from '../fixtures/generate.ts';
import { basicBudget, login, memBudget, testApp } from './helpers.ts';

const dump = (s: BudgetService) => JSON.stringify(['accounts', 'categories', 'payees', 'transactions', 'monthly_budgets', 'scheduled', 'reconciliations'].map(t => s.db.prepare(`SELECT * FROM ${t}`).all()));

describe('concurrent editing: a change made elsewhere is never silently overwritten', () => {
  it('service: compare-and-increment happens inside the write transaction', () => {
    const { s, checking, groceries } = basicBudget(); const r0 = s.revision();
    s.expectRevision(r0).setBudget('2026-01', groceries, { budgeted: 100 }); expect(s.revision()).toBe(r0 + 1);
    const before = dump(s);
    expect(() => s.expectRevision(r0).setBudget('2026-01', groceries, { budgeted: 999 })).toThrow(/another device/); // stale writer
    expect(() => s.expectRevision(r0).createTransaction({ accountId: checking, date: '2026-01-01', amount: -1 })).toThrow(/another device/);
    expect(dump(s)).toBe(before); expect(s.revision()).toBe(r0 + 1); // nothing written, revision untouched
    s.setBudget('2026-01', groceries, { budgeted: 5 }); expect(s.revision()).toBe(r0 + 2); // an expectation never leaks into the next write
    s.undo(); expect(s.revision()).toBe(r0 + 3); // undo is a change too: other devices must notice it
    expect(() => s.expectRevision(r0 + 2).undo()).toThrow(/another device/);
    expect(() => s.expectRevision(r0 + 2).redo()).toThrow(/another device/);
  });
  describe('HTTP: two devices', () => {
    let app: App, h: Record<string, string>, bid: string, acc: string;
    beforeAll(async () => { ({ app } = await testApp()); h = await login(app); bid = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'B' }, headers: h })).json().id;
      acc = (await app.inject({ method: 'POST', url: `/api/b/${bid}/accounts`, headers: h, payload: { name: 'Bank', type: 'checking', balance: 100000, date: '2026-01-01' } })).json().id; });
    afterAll(async () => { await app.close(); });
    it('the second writer gets 409 STALE, sees the new revision, and succeeds after refreshing', async () => {
      const boot = async () => (await app.inject({ method: 'GET', url: `/api/b/${bid}/bootstrap`, headers: h })).json();
      const rev = (await boot()).revision as number;
      const write = (device: number, amount: number) => app.inject({ method: 'POST', url: `/api/b/${bid}/transactions`, headers: { ...h, 'x-budget-revision': String(device) }, payload: { accountId: acc, date: '2026-01-02', amount, payeeName: 'P' } });
      const a = await write(rev, -100); expect(a.statusCode).toBe(200); expect(Number(a.headers['x-budget-revision'])).toBe(rev + 1);
      const b = await write(rev, -200); // device B still believes in the old revision
      expect(b.statusCode).toBe(409); expect(b.json().error).toMatchObject({ code: 'STALE', details: { revision: rev + 1 } });
      expect((await boot()).accounts[0].balance).toBe(100000 - 100);
      expect((await write(rev + 1, -200)).statusCode).toBe(200); expect((await boot()).accounts[0].balance).toBe(100000 - 300);
      // simultaneous requests carrying the same revision: exactly one wins
      const cur = (await boot()).revision; const both = await Promise.all([write(cur, -1), write(cur, -2), write(cur, -4)]);
      expect(both.map(r => r.statusCode).sort()).toEqual([200, 409, 409]);
      // a stale expectation must not leak into an unrelated later request
      expect((await app.inject({ method: 'POST', url: `/api/b/${bid}/transactions`, headers: h, payload: { accountId: acc, date: '2026-01-03', amount: -8 } })).statusCode).toBe(200);
    });
  });
});

describe('atomic financial operations: all or nothing', () => {
  it('a failing step inside transfers, splits, bulk edits, reconciliation and bank imports leaves no trace', async () => {
    const { s, checking, savings, groceries } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: 'income:this', amount: 1000_00, cleared: 'cleared' });
    const t = s.createTransaction({ accountId: checking, date: '2026-01-05', transferAccountId: savings, amount: -50_00 });
    s.setBudget('2026-01', groceries, { budgeted: 10_00 }); // the category is in use, so deleting it needs a valid target
    const before = dump(s), rev = s.revision(), undo = s.undoStatus().undo;
    const attempts: (() => unknown)[] = [
      () => s.createTransaction({ accountId: checking, date: '2026-01-06', payeeName: 'A brand new payee', amount: -30_00, splits: [{ amount: -10_00, categoryId: groceries }, { amount: -20_00, transferAccountId: 'no-such-account' }] }),
      () => s.createTransaction({ accountId: checking, date: '2026-01-06', payeeName: 'Another new payee', amount: -30_00, splits: [{ amount: -10_00, categoryId: groceries }, { amount: -20_00, categoryId: 'no-such-category' }] }),
      () => s.createTransactions([{ accountId: checking, date: '2026-01-06', payeeName: 'Ok', amount: -1 }, { accountId: checking, date: '2026-01-06', amount: 0.5 }]),
      () => s.updateTransaction(t.id, { transferAccountId: checking }),
      () => s.updateTransaction(t.id, { amount: -70_00, splits: [{ amount: -1, categoryId: groceries }] }),
      () => s.bulkUpdate([t.id, 'does-not-exist'], { cleared: 'cleared' }),
      () => s.deleteTransactions([t.changed[1].id, 'x']).deleted.length === 0 && (() => { throw new Error('nothing deleted'); })(),
      () => s.reconcile(checking, 12345),
      () => s.moveMoney('2026-01', groceries, 'no-such-category', 100),
      () => s.deleteCategory(groceries, 'no-such-category'),
    ];
    for (const a of attempts.slice(0, 6).concat(attempts.slice(7))) { expect(a).toThrow(); expect(dump(s)).toBe(before); expect(s.revision()).toBe(rev); expect(s.undoStatus().undo).toBe(undo); }
    const { commit } = await import('../../src/server/bankImportService.ts');
    expect(() => commit(s, checking, [{ date: '2026-01-07', payeeName: 'Good', amount: -5_00 }, { date: '2026-01-07', payeeName: 'Transfer', amount: -6_00, transferAccountId: 'no-such-account' }])).toThrow();
    expect(dump(s)).toBe(before); expect(s.checkIntegrity()).toEqual([]);
  });
  it('a migration that fails halfway creates no budget and leaves existing budgets untouched', async () => {
    const { app, dir } = await testApp(); const h = await login(app);
    const keep = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'Keep' }, headers: h })).json().id;
    const src = memBudget(); generateBudget(src, { startMonth: '2025-06', months: 2, txPerMonth: 10 });
    const y = toYfull(src); y.transactions[y.transactions.length - 1].cleared = 'Cleared'; y.transactions[y.transactions.length - 1].flag = 'Purple';
    y.monthlyBudgets[0].month = '2025-06-01'; y.monthlyBudgets[0].monthlySubCategoryBudgets[0].budgeted = 1e300; // cannot be stored: the database rejects it after thousands of rows were inserted
    const r = await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files: [{ path: 'Budget.yfull', text: JSON.stringify(y) }] } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().map((b: any) => b.id)).toEqual([keep]);
    expect(readdirSync(join(dir, 'budgets')).filter(f => f.endsWith('.sqlite'))).toEqual([keep + '.sqlite']);
    await app.close();
  });
});

describe('schema upgrades', () => {
  const v1Budget = (file: string) => { // a database exactly as version 1 of the application left it
    const db = new Database(file); db.pragma('journal_mode = WAL'); db.exec(BUDGET_MIGRATIONS[0]); db.pragma('user_version = 1');
    db.exec(`INSERT INTO accounts(id,name,type,on_budget) VALUES('a1','Bank','checking',1); INSERT INTO category_groups(id,name) VALUES('g1','Hverdag'); INSERT INTO categories(id,group_id,name) VALUES('c1','g1','Mad');
      INSERT INTO transactions(id,account_id,date,category_id,amount,cleared,created_at) VALUES('t1','a1','2025-12-31','income:this',500000,'reconciled','x'),('t2','a1','2026-01-05','c1',-12345,'cleared','x');
      INSERT INTO monthly_budgets(month,category_id,budgeted,overspending) VALUES('2026-01','c1',10000,'confined');`); db.close(); };
  it('a version-1 budget is upgraded in place with every figure preserved, after a safety copy was written', () => {
    expect(BUDGET_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
    const file = join(mkdtempSync(join(tmpdir(), 'br-mig-')), 'b.sqlite'); v1Budget(file);
    const s = new BudgetService(openBudgetDb(file), 'x');
    expect(s.db.pragma('user_version', { simple: true })).toBe(BUDGET_SCHEMA_VERSION); expect(s.revision()).toBe(1);
    expect(s.listAccounts()[0]).toMatchObject({ balance: 487655, clearedBalance: 487655 });
    expect(s.getBudget('2026-01').rows[0]).toMatchObject({ budgeted: 10000, activity: -12345, available: -2345, handling: 'confined' }); expect(s.getBudget('2026-01').availableToBudget).toBe(490000);
    expect(s.checkIntegrity()).toEqual([]); s.db.close();
    const copy = `${file}.pre-v${BUDGET_SCHEMA_VERSION}.bak`; expect(existsSync(copy)).toBe(true);
    const old = new Database(copy, { readonly: true }); expect(old.pragma('user_version', { simple: true })).toBe(1); expect((old.prepare('SELECT COUNT(*) n FROM transactions').get() as any).n).toBe(2); old.close();
  });
  it('a failing upgrade changes nothing: same version, same data, and the budget still opens with the old code path', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'br-mig-')), 'b.sqlite'); v1Budget(file);
    const broken = [BUDGET_MIGRATIONS[0], `CREATE TABLE half_done(x); INSERT INTO half_done VALUES(1); UPDATE transactions SET amount = amount * 100; SELECT no_such_function();`];
    expect(() => openBudgetDb(file, broken)).toThrow();
    const db = new Database(file, { readonly: true });
    expect(db.pragma('user_version', { simple: true })).toBe(1); expect((db.prepare('SELECT SUM(amount) s FROM transactions').get() as any).s).toBe(487655);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='half_done'`).get()).toBeUndefined(); expect(db.pragma('integrity_check', { simple: true })).toBe('ok'); db.close();
    const ok = new BudgetService(openBudgetDb(file), 'x'); expect(ok.listAccounts()[0].balance).toBe(487655); ok.db.close(); // the real upgrade still works afterwards
  });
  it('a database from a NEWER application version is refused instead of being damaged', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'br-mig-')), 'b.sqlite'); v1Budget(file);
    const db = new Database(file); db.pragma('user_version = 99'); db.close();
    expect(() => openBudgetDb(file)).toThrow(/newer/);
  });
});

describe('independent migration audit (the tool run against the real budget)', () => {
  const build = () => { const src = memBudget(); const g = generateBudget(src, { startMonth: '2024-10', months: 16, txPerMonth: 30, seed: 21 }); src.updateCategory(g.categories.Hobby, { hidden: true });
    src.saveScheduled({ accountId: g.accounts.checking, nextDate: '2099-01-01', frequency: 'monthly', payeeName: 'Boligforeningen', categoryId: g.categories.Husleje, memo: '', amount: -9500_00, flag: null, transferAccountId: null, splits: [] });
    const y = toYfull(src); y.transactions.push({ ...y.transactions[5], entityId: 'deleted-1', isTombstone: true }); y.accounts.push({ entityId: 'gone', accountName: 'Gone', accountType: 'Savings', onBudget: true, isTombstone: true });
    const files = [{ path: 'b.ynab4/Budget.yfull', text: JSON.stringify(y) }]; const dst = memBudget(); applyImport(dst, parseYnab4Native(files), 'fp'); return { files, dst, y }; };
  it('passes on a faithful import and reports what was deliberately not imported', () => {
    const { files, dst } = build(); const a = auditNativeImport(files, dst);
    expect(a.areas.filter(x => x.status === 'FAIL')).toEqual([]); expect(a.verdict).toBe('PASS');
    expect(a.skipped).toEqual(expect.arrayContaining([{ kind: 'transaction', count: 1, reason: expect.any(String) }, { kind: 'account', count: 1, reason: expect.any(String) }]));
    expect(a.areas.find(x => x.area.startsWith('Category balances and rollover'))!.detail).toMatch(/agree in all \d+ months/);
  });
  it('detects every kind of damage: a changed amount, a lost record, a duplicate, a broken link, a changed budget cell, a wrong rollover', () => {
    const failing = (damage: (s: BudgetService) => void) => { const { files, dst } = build(); dst.db.pragma('foreign_keys = OFF'); damage(dst); dst.version++; return auditNativeImport(files, dst).areas.filter(x => x.status === 'FAIL').map(x => x.area).join(' | '); };
    expect(failing(s => s.db.exec(`UPDATE transactions SET amount = amount + 1 WHERE seq = (SELECT MIN(seq) FROM transactions WHERE parent_id IS NULL AND transfer_txn_id IS NULL AND is_split = 0 AND category_id IS NOT NULL)`))).toMatch(/Transaction amounts.*Account balances/);
    expect(failing(s => s.db.exec(`DELETE FROM transactions WHERE seq = (SELECT MAX(seq) FROM transactions WHERE parent_id IS NULL AND transfer_txn_id IS NULL AND is_split = 0)`))).toMatch(/every live source record present exactly once/);
    expect(failing(s => s.db.exec(`INSERT INTO transactions(id,account_id,date,amount,cleared,created_at,source_id) SELECT 'dup', account_id, date, amount, cleared, created_at, source_id FROM transactions WHERE parent_id IS NULL AND transfer_txn_id IS NULL LIMIT 1`))).toMatch(/exactly once/);
    expect(failing(s => s.db.exec(`UPDATE transactions SET transfer_txn_id = 'nowhere' WHERE seq = (SELECT MIN(seq) FROM transactions WHERE transfer_txn_id IS NOT NULL)`))).toMatch(/Transfers/);
    expect(failing(s => s.db.exec(`UPDATE monthly_budgets SET budgeted = budgeted + 100 WHERE rowid = (SELECT MIN(rowid) FROM monthly_budgets)`))).toMatch(/Monthly budgeted amounts.*Category balances and rollover/);
    expect(failing(s => s.db.exec(`UPDATE monthly_budgets SET overspending = NULL WHERE overspending = 'confined'`))).toMatch(/overspending \(red arrow\) settings.*Category balances and rollover/);
    expect(failing(s => s.db.exec(`UPDATE transactions SET cleared = 'uncleared' WHERE seq = (SELECT MIN(seq) FROM transactions WHERE cleared = 'reconciled' AND parent_id IS NULL)`))).toMatch(/Cleared \/ reconciled.*Account balances/);
    expect(failing(s => s.db.exec(`UPDATE transactions SET category_id = 'income:this' WHERE seq = (SELECT MIN(seq) FROM transactions WHERE category_id = 'income:next')`))).toMatch(/Category assignments.*Income for this month/);
  });
  it('reports fields and values it has never seen instead of ignoring them', () => {
    const { y } = build(); y.transactions[0].someNewField = 1; y.accounts[0].accountType = 'CryptoWallet';
    const files = [{ path: 'Budget.yfull', text: JSON.stringify(y) }]; const dst = memBudget(); applyImport(dst, parseYnab4Native(files), 'fp'); const a = auditNativeImport(files, dst);
    expect(a.unrecognizedFields).toEqual({ transaction: ['someNewField'] }); expect(a.areas.find(x => x.area.startsWith('Field values'))!.status).toBe('PARTIAL'); expect(a.verdict).toBe('PARTIAL');
  });
});

describe('comparison with YNAB4\'s own Budget export (M1)', () => {
  const setup = () => {
    const src = memBudget(); const g = generateBudget(src, { startMonth: '2024-10', months: 14, txPerMonth: 30, seed: 33 });
    const { budget } = exportYnab4Csv(src, { first: g.firstMonth, last: g.lastMonth });
    const dst = memBudget(); applyImport(dst, parseYnab4Native([{ path: 'b.ynab4/Budget.yfull', text: JSON.stringify(toYfull(src)) }]), 'fp');
    return { src, dst, budget, g };
  };
  const lines = (csv: string) => csv.split('\r\n').filter(Boolean);
  const failing = (areas: ReturnType<typeof compareWithBudgetCsv>) => areas.filter(a => a.status === 'FAIL').map(a => a.area);
  it('a faithful native import matches every category-month of the export', () => {
    const { dst, budget } = setup(); const areas = compareWithBudgetCsv(dst, budget);
    expect(failing(areas)).toEqual([]); expect(verdictOf(areas)).toBe('PASS');
    expect(areas.find(a => a.area.includes('category balances'))!.source).toBe(lines(budget).length - 1);
    expect(areas.find(a => a.area.includes('Outflows'))!.detail).toMatch(/positive = money out/);
  });
  it('one wrong cell is found and pinpointed by CSV line and month only', () => {
    const { dst, budget } = setup(); const rows = lines(budget);
    const i = rows.findIndex((r, k) => k > 0 && /"Dagligvarer"/.test(r));
    const cols = rows[i].split('","'); cols[6] = 'kr1,00"'; rows[i] = cols.join('","'); // Category Balance off
    const areas = compareWithBudgetCsv(dst, rows.join('\r\n') + '\r\n');
    expect(failing(areas)).toEqual(['YNAB4 export: category balances (rollover)']);
    const bal = areas.find(a => a.area.includes('category balances'))!;
    expect(bal.examples).toEqual([expect.stringMatching(new RegExp(`^CSV line ${i + 1} \\(\\d{4}-\\d{2}\\)$`))]);
    expect(JSON.stringify(areas)).not.toMatch(/Dagligvarer|Hverdag|kr\d/); // nothing private in the result
  });
  it('a different budgeted amount (with the export\'s own balance unchanged) fails only budgeted', () => {
    const { dst, budget } = setup(); const rows = lines(budget);
    const i = rows.findIndex((r, k) => k > 0 && /"Husleje"/.test(r)); const cols = rows[i].split('","'); cols[4] = 'kr1,00'; rows[i] = cols.join('","');
    expect(failing(compareWithBudgetCsv(dst, rows.join('\r\n')))).toEqual(['YNAB4 export: budgeted amounts']);
  });
  it('a category missing after import and an unreadable row are failures, never skipped silently', () => {
    const { dst, budget } = setup(); const rows = lines(budget);
    rows.push('"January 2025","Ukendt: Ting","Ukendt","Ting","kr0,00","kr0,00","kr0,00"', '"Smarch 2025","Hverdag: Tøj","Hverdag","Tøj","kr0,00","kr0,00","kr0,00"');
    const a = compareWithBudgetCsv(dst, rows.join('\r\n'))[0];
    expect(a.status).toBe('FAIL'); expect(a.detail).toMatch(/1 row\(s\) name a category that does not exist.*1 unreadable/);
  });
  it('values the import has but the export lacks are reported', () => {
    const { dst, budget } = setup(); const rows = lines(budget); const head = rows[0];
    const drop = rows.findIndex((r, k) => k > 0 && /"Transport"/.test(r));
    const areas = compareWithBudgetCsv(dst, [head, ...rows.slice(1).filter((_, k) => k + 1 !== drop)].join('\r\n'));
    expect(failing(areas)).toEqual(['YNAB4 export: imported values the export does not list']);
  });
  it('hidden categories in the export ("Hidden Categories" / "Group ` Name ` id") match their original category', () => {
    const { dst, budget } = setup(); const rows = lines(budget);
    const out = rows.map((r, k) => { if (k === 0 || !/"Hobby"/.test(r)) return r; const c = r.split('","'); c[1] = 'Hidden Categories: Fornøjelser ` Hobby ` 1A2B'; c[2] = 'Hidden Categories'; c[3] = 'Fornøjelser ` Hobby ` 1A2B'; return c.join('","'); });
    const areas = compareWithBudgetCsv(dst, out.join('\r\n')); expect(failing(areas)).toEqual([]);
  });
  it('an export that writes Outflows as negative numbers is recognised, and the convention is stated', () => {
    const { dst, budget } = setup();
    const flipped = lines(budget).map((r, k) => { if (k === 0) return r; const c = r.split('","'); c[5] = c[5] === 'kr0,00' ? c[5] : c[5].startsWith('-') ? c[5].slice(1) : '-' + c[5]; return c.join('","'); });
    const areas = compareWithBudgetCsv(dst, flipped.join('\r\n'));
    expect(failing(areas)).toEqual([]); expect(areas.find(a => a.area.includes('Outflows'))!.detail).toMatch(/negative = money out/);
  });
  it('rejects a file that is not a Budget export', () => {
    expect(() => compareWithBudgetCsv(memBudget(), '"Account","Date","Payee"\r\n')).toThrow(/not a YNAB4 Budget export/);
  });
});

describe('independent audit shown with every native import (M3)', () => {
  it('preview and commit return the audit; it is stored with the import report; CSV imports have none', async () => {
    const { app } = await testApp(); const h = await login(app);
    const src = memBudget(); generateBudget(src, { startMonth: '2025-01', months: 6, txPerMonth: 15, seed: 4 });
    const files = [{ path: 'Mit budget~1A2B3C4D.ynab4/Budget.yfull', text: JSON.stringify(toYfull(src)) }];
    const p = (await app.inject({ method: 'POST', url: '/api/import/ynab4/preview', headers: h, payload: { files } })).json();
    expect(p.result.audit.verdict).toBe('PASS'); expect(p.result.audit.areas.length).toBeGreaterThan(15); expect(p.result.status).toBe('verified');
    const c = (await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files } })).json();
    expect(c.result.audit.verdict).toBe('PASS');
    const boot = (await app.inject({ method: 'GET', url: `/api/b/${c.budgetId}/bootstrap`, headers: h })).json();
    expect(JSON.parse(boot.lastImport).audit.verdict).toBe('PASS'); // what Settings → Migration report shows
    const csv = exportYnab4Csv(src, { first: '2025-01', last: '2025-06' });
    const pc = (await app.inject({ method: 'POST', url: '/api/import/ynab4/preview', headers: h, payload: { files: [{ path: 'x-Register.csv', text: csv.register }, { path: 'x-Budget.csv', text: csv.budget }] } })).json();
    expect(pc.result.audit).toBeUndefined();
    await app.close();
  });
  it('an import whose independent audit fails is never labelled verified', () => {
    const src = memBudget(); generateBudget(src, { startMonth: '2025-01', months: 2, txPerMonth: 10 });
    const r = applyImport(memBudget(), parseYnab4Native([{ path: 'Budget.yfull', text: JSON.stringify(toYfull(src)) }]), 'fp',
      () => ({ verdict: 'FAIL', areas: [{ area: 'x', status: 'FAIL', source: 1, imported: 0, detail: 'd', examples: [] }], skipped: [], unrecognizedFields: {} }));
    expect(r.checks.filter(c => c.status === 'fail')).toEqual([]); // the importer's own checks all pass…
    expect(r.status).toBe('needs_attention'); expect(r.ok).toBe(false); // …but the audit's FAIL decides
  });
});

describe('restore from the JSON export (I3)', () => {
  let app: App, h: Record<string, string>, bid: string;
  const restore = (body: string | Buffer) => app.inject({ method: 'POST', url: '/api/restore', headers: { ...h, 'content-type': 'application/octet-stream' }, payload: Buffer.isBuffer(body) ? body : Buffer.from(body) });
  const budgets = async () => (await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().length as number;
  beforeAll(async () => {
    ({ app } = await testApp()); h = await login(app); bid = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'Original' }, headers: h })).json().id;
    const s = app.core.service(bid); const g = generateBudget(s, { startMonth: '2025-01', months: 10, txPerMonth: 25, seed: 8 });
    s.updateCategory(g.categories.Hobby, { hidden: true }); s.setMonthNote('2025-03', 'note'); s.setBudget('2025-04', g.categories.Bil, { note: 'cat note' });
    s.saveScheduled({ accountId: g.accounts.checking, nextDate: '2099-01-01', frequency: 'monthly', payeeName: 'Boligforeningen', categoryId: g.categories.Husleje, memo: '', amount: -9500_00, flag: 'red', transferAccountId: null, splits: [] });
    s.reconcile(g.accounts.savings, s.listAccounts().find(a => a.id === g.accounts.savings)!.clearedBalance);
  });
  afterAll(async () => { await app.close(); });
  it('round trip: export → restore gives a new budget identical to the original', async () => {
    const exp = await app.inject({ method: 'GET', url: `/api/b/${bid}/export/json`, headers: h }); expect(exp.statusCode).toBe(200);
    const n = await budgets(); const r = await restore('﻿' + exp.body); expect(r.statusCode).toBe(200);
    const { id, name } = r.json(); expect(id).not.toBe(bid); expect(name).toBe('Original (restored)'); expect(await budgets()).toBe(n + 1);
    const a = app.core.service(bid), b = app.core.service(id);
    expect(dump(b)).toBe(dump(a));
    for (const m of ['2025-01', '2025-06', '2025-10', '2026-03']) expect(JSON.stringify(b.getBudget(m))).toBe(JSON.stringify(a.getBudget(m)));
    expect(b.checkIntegrity()).toEqual([]); expect(b.undoStatus().undo).toBeNull();
    // the restored budget is fully usable
    b.createTransaction({ accountId: b.listAccounts()[0].id, date: '2025-11-02', payeeName: 'Ny', amount: -100 }); expect(b.checkIntegrity()).toEqual([]);
  });
  it('rejects damaged, foreign or newer exports and leaves no budget behind', async () => {
    const good = JSON.parse((await app.inject({ method: 'GET', url: `/api/b/${bid}/export/json`, headers: h })).body);
    const n = await budgets();
    const bad = async (doc: any, status: number, code: string) => { const r = await restore(JSON.stringify(doc)); expect([r.statusCode, r.json().error.code]).toEqual([status, code]); expect(await budgets()).toBe(n); };
    const clone = () => JSON.parse(JSON.stringify(good));
    await bad({ hello: 1 }, 415, 'NOT_A_BACKUP');
    await bad({ ...clone(), version: 2 }, 409, 'BACKUP_TOO_NEW');
    { const d = clone(); d.tables.transactions[0].someNewField = 1; await bad(d, 409, 'BACKUP_TOO_NEW'); }
    { const d = clone(); d.tables.newTable = []; await bad(d, 409, 'BACKUP_TOO_NEW'); }
    { const d = clone(); d.tables.transactions[3].amount = 12.5; await bad(d, 422, 'BACKUP_CORRUPT'); }                       // float money
    { const d = clone(); d.tables.transactions[3].account_id = 'nowhere'; await bad(d, 422, 'BACKUP_CORRUPT'); }             // broken link
    { const d = clone(); const t = d.tables.transactions.find((x: any) => x.transfer_txn_id); t.amount += 1; await bad(d, 422, 'BACKUP_INCONSISTENT'); } // transfer creates money
    { const d = clone(); d.tables.transactions[3].memo = { evil: true }; await bad(d, 422, 'BACKUP_CORRUPT'); }
    expect((await restore('{not json')).statusCode).toBe(415);
    expect(readdirSync(join(app.core.cfg.dataDir, 'budgets')).filter(f => f.endsWith('.sqlite')).length).toBe(n);
  });
});

describe('scheduled backups (D2)', () => {
  it('backs up every budget while the server is running, copies off-site, touches nothing the server owns', async () => {
    const { app, dir } = await testApp(); const h = await login(app);
    const ids: string[] = [];
    for (const name of ['Første', 'Second']) { const id = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name }, headers: h })).json().id; ids.push(id); generateBudget(app.core.service(id), { startMonth: '2025-01', months: 3, txPerMonth: 10, seed: ids.length }); }
    const upload = join(dir, 'tmp', 'upload-in-progress.sqlite'); writeFileSync(upload, 'partial');
    const opened = JSON.stringify(app.core.listBudgets());
    const offsite = mkdtempSync(join(tmpdir(), 'br-offsite-'));
    const run = spawnSync('npx', ['tsx', 'scripts/backup-now.ts', '--copy-to', offsite], { env: { ...process.env, BR_DATA_DIR: dir }, encoding: 'utf8' });
    expect(run.status).toBe(0); expect(run.stdout).toMatch(/2 of 2 budget\(s\) backed up/);
    expect(existsSync(upload)).toBe(true); expect(JSON.stringify(app.core.listBudgets())).toBe(opened); // tmp untouched, "last opened" unchanged
    for (const id of ids) expect(app.core.listBackups(id).filter(b => b.reason === 'scheduled')).toHaveLength(1);
    const copies = readdirSync(offsite); expect(copies).toHaveLength(2); expect(copies.every(f => f.endsWith('.budgetreborn'))).toBe(true);
    const restored = app.core.restore(readFileSync(join(offsite, copies.find(f => f.startsWith('Second'))!)));
    expect(dump(app.core.service(restored.id))).toBe(dump(app.core.service(ids[1])));
    expect(spawnSync('npx', ['tsx', 'scripts/backup-now.ts', '--copy-to'], { env: { ...process.env, BR_DATA_DIR: dir } }).status).toBe(2);
    await app.close();
  });
  it('keeps the newest N scheduled and N daily backups; manual and safety backups are never pruned', async () => {
    const { app, dir } = await testApp({ BR_BACKUP_KEEP: '2' }); const h = await login(app);
    const id = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'B' }, headers: h })).json().id;
    const folder = join(dir, 'backups', id); mkdirSync(folder, { recursive: true });
    for (const n of ['20200101T000000Z-scheduled', '20200102T000000Z-scheduled', '20200103T000000Z-scheduled', '20200101T000000Z-auto', '20200102T000000Z-auto', '20200103T000000Z-auto', '20200101T000000Z-manual', '20200101T000000Z-before-import'])
      copyFileSync(join(dir, 'budgets', id + '.sqlite'), join(folder, n + '.sqlite'));
    app.core.backup(id, 'scheduled');
    const left = app.core.listBackups(id).map(b => b.reason + ' ' + b.at.slice(0, 10)).sort();
    expect(left.filter(x => x.startsWith('scheduled'))).toHaveLength(2); expect(left).toContain('scheduled 2020-01-03'); // newest two of four
    expect(left.filter(x => x.startsWith('auto'))).toEqual(['auto 2020-01-02', 'auto 2020-01-03']);
    expect(left).toContain('manual 2020-01-01'); expect(left).toContain('before-import 2020-01-01');
    await app.close();
  });
});
