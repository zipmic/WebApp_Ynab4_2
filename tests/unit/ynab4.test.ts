import { describe, expect, it } from 'vitest';
import { applyImport } from '../../src/server/importService.ts';
import { decodeBytes, parseCsv, toCsv } from '../../src/shared/csv.ts';
import { detectYnab4Csv, parseYnab4Csv } from '../../src/shared/ynab4csv.ts';
import { parseYnab4Native } from '../../src/shared/ynab4native.ts';
import { generateBudget, toYfull } from '../fixtures/generate.ts';
import { exportYnab4Csv } from '../fixtures/ynab4csv.ts';
import { memBudget } from './helpers.ts';
import type { BudgetService } from '../../src/server/budgetService.ts';

function compareBudgets(a: BudgetService, b: BudgetService, first: string, last: string) {
  const name = (s: BudgetService) => new Map(s.listCategories().map(c => [c.id, c.name]));
  const na = name(a), nb = name(b);
  const key = (s: BudgetService, n: Map<string, string>) => s.reportBudget(first, last).map(r => `${r.month}|${n.get(r.categoryId)}|${r.budgeted}|${r.activity}|${r.available}`).sort();
  expect(key(b, nb)).toEqual(key(a, na));
  for (let m = first; m <= last; m = m.slice(5) === '12' ? `${+m.slice(0, 4) + 1}-01` : `${m.slice(0, 5)}${String(+m.slice(5) + 1).padStart(2, '0')}`)
    expect([m, b.getBudget(m).availableToBudget, b.getBudget(m).income]).toEqual([m, a.getBudget(m).availableToBudget, a.getBudget(m).income]);
  const bal = (s: BudgetService) => s.listAccounts().map(x => [x.name, x.balance, x.clearedBalance, x.txCount, x.onBudget]).sort();
  expect(bal(b)).toEqual(bal(a));
}

describe('CSV reader', () => {
  it('handles quotes, embedded newlines/delimiters, CRLF, BOM and delimiter detection', () => {
    expect(parseCsv('﻿"a","b ""q"" x","multi\r\nline"\r\n1;2,"3,4"\r\n')).toEqual([['a', 'b "q" x', 'multi\r\nline'], ['1;2', '3,4']]);
    expect(parseCsv('Dato;Tekst;Beløb\n01-02-2026;"A; B";-1.234,50\n')).toEqual([['Dato', 'Tekst', 'Beløb'], ['01-02-2026', 'A; B', '-1.234,50']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv(toCsv([['x,y', 'he said "hi"', null, 5]]))).toEqual([['x,y', 'he said "hi"', '', '5']]);
  });
  it('decodes UTF-8, UTF-8 BOM, UTF-16 and legacy Windows-1252 (æøå)', () => {
    expect(decodeBytes(new TextEncoder().encode('Føtex')).text).toBe('Føtex');
    expect(decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])).text).toBe('A');
    expect(decodeBytes(Uint8Array.from([0x46, 0xf8, 0x74, 0x65, 0x78, 0x20, 0xe6, 0xe5])).text).toBe('Føtex æå'); // cp1252 bytes
    expect(decodeBytes(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0xf8, 0x00])).text).toBe('Aø');
  });
});

describe('YNAB4 CSV migration', () => {
  it('detects Register vs Budget exports (and rejects other CSVs)', () => {
    expect(detectYnab4Csv('"Account","Flag","Check Number","Date","Payee","Category","Master Category","Sub Category","Memo","Outflow","Inflow","Cleared","Running Balance"\r\n')).toBe('register');
    expect(detectYnab4Csv('"Month","Category","Master Category","Sub Category","Budgeted","Outflows","Category Balance"\r\n')).toBe('budget');
    expect(detectYnab4Csv('Dato;Tekst;Beløb\n')).toBeNull();
  });
  it('round-trips a 3-year budget through Danish-formatted Register + Budget exports with a fully verified audit', () => {
    const src = memBudget(); const g = generateBudget(src, { startMonth: '2023-10', months: 37, txPerMonth: 45, seed: 3 });
    const files = exportYnab4Csv(src, { first: g.firstMonth, last: g.lastMonth });
    const model = parseYnab4Csv(files, { budgetName: 'Husholdning', accounts: { Aktiedepot: { type: 'investment' }, Realkreditlån: { type: 'mortgage' } } });
    expect(model.warnings.filter(w => w.level === 'error')).toEqual([]);
    expect(model.currency).toBe('DKK');
    expect(model.accounts.find(a => a.name === 'Aktiedepot')!.onBudget).toBe(false); // inferred: no categories used
    expect(model.accounts.find(a => a.name === 'Kreditkort')!.onBudget).toBe(true);
    const dst = memBudget(); const result = applyImport(dst, model, 'fp');
    expect(result.checks.filter(c => c.status === 'fail')).toEqual([]);
    expect(result.status).toBe('verified');
    expect(result.checks.find(c => c.name.startsWith('Monthly budgeted'))!.status).toBe('pass');
    expect(result.checks.find(c => c.name === 'Account balances')!.detail).toMatch(/All 6/);
    expect(result.warnings.find(w => w.code === 'overspending_inferred')).toBeTruthy(); // the confined Ferie months were recovered from balances
    compareBudgets(src, dst, g.firstMonth, g.lastMonth);
    // transfers are linked again and splits re-assembled
    const count = (s: BudgetService, sql: string) => (s.db.prepare(sql).get() as { n: number }).n;
    for (const sql of ['SELECT COUNT(*) n FROM transactions WHERE transfer_txn_id IS NOT NULL', 'SELECT COUNT(*) n FROM transactions WHERE is_split=1', 'SELECT COUNT(*) n FROM transactions WHERE parent_id IS NOT NULL', `SELECT COUNT(*) n FROM transactions WHERE cleared='reconciled'`])
      expect(count(dst, sql)).toBe(count(src, sql));
    expect(dst.getSettings().name).toBe('Husholdning');
  });
  it('without a Budget export: transactions are complete, budget history is reported as missing, nothing is invented', () => {
    const src = memBudget(); const g = generateBudget(src, { startMonth: '2025-01', months: 6, txPerMonth: 20 });
    const model = parseYnab4Csv({ register: exportYnab4Csv(src, { first: g.firstMonth, last: g.lastMonth }).register });
    expect(model.budgets).toEqual([]); expect(model.warnings.some(w => w.code === 'no_budget_history')).toBe(true);
    expect(model.coverage.find(c => c.item === 'Monthly budgeted amounts')!.status).toBe('none');
    const dst = memBudget(); const r = applyImport(dst, model, 'fp');
    expect(r.counts.budgetCells).toBe(0); expect(r.checks.find(c => c.name === 'Monthly budget values')!.status).toBe('skipped');
    expect(dst.listAccounts().map(a => a.balance).sort()).toEqual(src.listAccounts().map(a => a.balance).sort());
  });
  it('US-formatted export ($1,234.56, MM/DD/YYYY) and ambiguous dates', () => {
    const reg = 'Account,Flag,Check Number,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared,Running Balance\n' +
      'Bank,,101,12/31/2024,Shop,Everyday: Food,Everyday,Food,,"$1,234.56",$0.00,C,"-$1,234.56"\nBank,Red,,01/02/2025,Job,Income: Available this month,Income,Available this month,pay,$0.00,"$2,000.00",R,$765.44\n';
    const m = parseYnab4Csv({ register: reg });
    expect(m.transactions.map(t => [t.date, t.amount, t.cleared, t.flag, t.memo])).toEqual([['2024-12-31', -123456, 'cleared', null, '#101'], ['2025-01-02', 200000, 'reconciled', 'red', 'pay']]);
    expect(m.transactions[1].categorySid).toBe('income:this');
    expect(m.expected.accountBalances[0].balance).toBe(76544);
    const amb = parseYnab4Csv({ register: reg.replace('12/31/2024', '03/04/2024') });
    expect(amb.warnings.some(w => w.code === 'date_order_ambiguous' && w.level === 'error')).toBe(true);
    expect(parseYnab4Csv({ register: reg.replace('12/31/2024', '03/04/2024') }, { dateStyle: 'MDY' }).transactions[0].date).toBe('2024-03-04');
    expect(parseYnab4Csv({ register: reg.replace('12/31/2024', '03/04/2024') }, { dateStyle: 'DMY' }).transactions[0].date).toBe('2024-04-03');
  });
  it('reports unreadable rows instead of guessing, and the audit then refuses to call the import verified', () => {
    const reg = 'Account,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared\nBank,31-12-2024,Shop,A: B,A,B,,"kr12,50","kr0,00",C\nBank,99-99-2024,Shop,A: B,A,B,,"kr1,00","kr0,00",C\nBank,30-12-2024,Shop,A: B,A,B,,"twelve","kr0,00",C\n';
    const m = parseYnab4Csv({ register: reg });
    expect(m.transactions).toHaveLength(1);
    expect(m.warnings.filter(w => w.level === 'error').map(w => w.code).sort()).toEqual(['txn_bad_amount', 'txn_bad_date']);
    const r = applyImport(memBudget(), m, 'fp'); expect(r.status).toBe('needs_attention'); expect(r.ok).toBe(false);
  });
  it('unmatched transfers are imported as plain transactions so balances stay exact; hidden categories are restored', () => {
    const reg = 'Account,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared\n' +
      'A,01-01-2025,Transfer : B,,,,,"kr100,00","kr0,00",C\nB,01-01-2025,Transfer : A,,,,,"kr0,00","kr100,00",C\n' +
      'A,02-01-2025,Transfer : B,,,,,"kr50,00","kr0,00",C\nA,03-01-2025,Transfer : Closed account,,,,,"kr7,00","kr0,00",C\n' +
      'A,04-01-2025,Shop,"Hidden Categories: Old ` Gym ` 3",Hidden Categories,"Old ` Gym ` 3",,"kr9,00","kr0,00",U\n';
    const m = parseYnab4Csv({ register: reg });
    const dst = memBudget(); applyImport(dst, m, 'fp');
    expect(dst.listAccounts().map(a => [a.name, a.balance])).toEqual([['A', -16600], ['B', 10000]]);
    expect(dst.listTransactions().filter(t => t.transferTxnId)).toHaveLength(2);
    expect(dst.listTransactions().filter(t => !t.transferTxnId).map(t => t.payeeName).sort()).toEqual(['Shop', 'Transfer : B', 'Transfer : Closed account']);
    expect(m.warnings.find(w => w.code === 'transfer_unlinked')!.count).toBe(1); // "Closed account" is not an account in the file: stays a payee
    expect(dst.listCategories().map(c => [c.name, c.hidden])).toEqual([['Gym', true]]); expect(dst.listGroups()[0].name).toBe('Old');
    expect(dst.checkIntegrity()).toEqual([]);
  });
});

describe('native YNAB4 (.ynab4 folder) migration', () => {
  const layout = (yfull: any, extra: { path: string; text: string }[] = []) => [
    { path: 'Husholdning~1A2B3C4D.ynab4/Budget.ymeta', text: JSON.stringify({ formatVersion: '1.2', relativeDataFolderName: 'data1~ABCDEF12', TED: 0 }) },
    { path: 'Husholdning~1A2B3C4D.ynab4/data1~ABCDEF12/devices/A.ydevice', text: JSON.stringify({ deviceGUID: 'DEV-A', shortDeviceId: 'A', hasFullKnowledge: true, knowledge: 'A-100' }) },
    { path: 'Husholdning~1A2B3C4D.ynab4/data1~ABCDEF12/DEV-A/Budget.yfull', text: JSON.stringify(yfull) }, ...extra];

  it('imports a full multi-year budget exactly: balances, every month of budget values, transfers, splits, flags, schedules, hidden categories', () => {
    const src = memBudget(); const g = generateBudget(src, { startMonth: '2022-11', months: 40, txPerMonth: 40, seed: 11 });
    src.updateCategory(g.categories.Hobby, { hidden: true });
    src.saveScheduled({ accountId: g.accounts.checking, nextDate: '2099-01-01', frequency: 'monthly', payeeName: 'Boligforeningen', categoryId: g.categories.Husleje, memo: 'husleje', amount: -9500_00, flag: null, transferAccountId: null, splits: [] });
    src.setBudget('2024-05', g.categories.Bil, { note: 'ny bil 2027' }); src.setMonthNote('2024-05', 'ferie i juli');
    const t = src.listTransactions({ accountId: g.accounts.card })[3]; src.updateTransaction(t.id, { flag: 'purple' });
    const model = parseYnab4Native(layout(toYfull(src)));
    expect(model.budgetName).toBe('Husholdning'); expect(model.currency).toBe('DKK');
    expect(model.warnings.filter(w => w.level !== 'info')).toEqual([]);
    const dst = memBudget(); const r = applyImport(dst, model, 'fp');
    expect(r.checks.filter(c => c.status === 'fail')).toEqual([]); expect(r.status).toBe('verified');
    compareBudgets(src, dst, g.firstMonth, '2026-12');
    expect(dst.listAccounts().map(a => [a.name, a.type, a.onBudget])).toEqual(src.listAccounts().map(a => [a.name, a.type, a.onBudget]));
    const catKey = (s: BudgetService) => s.listCategories().map(c => `${s.listGroups().find(g => g.id === c.groupId)!.name}/${c.name}/${c.hidden}`).sort();
    expect(catKey(dst)).toEqual(catKey(src)); // the hidden category returns to its original group
    expect(dst.listGroups().map(g => g.name)).toEqual(src.listGroups().map(g => g.name)); // no stray "Income"/"Hidden Categories" groups
    expect(dst.listScheduled().map(s => [s.nextDate, s.amount, s.payeeName, s.frequency])).toEqual([['2099-01-01', -9500_00, 'Boligforeningen', 'monthly']]);
    expect(dst.getBudget('2024-05').note).toBe('ferie i juli');
    expect(dst.getBudget('2024-05').rows.find(x => x.note)!.note).toBe('ny bil 2027');
    expect(dst.listTransactions().filter(x => x.flag === 'purple')).toHaveLength(1);
    const strip = (s: BudgetService) => s.listTransactions().map(x => [x.date, x.amount, x.payeeName, x.cleared, x.memo, x.splits.map(k => k.amount)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(strip(dst)).toEqual(strip(src));
    expect(r.counts.transferPairs).toBe((src.db.prepare('SELECT COUNT(*)/2 n FROM transactions WHERE transfer_txn_id IS NOT NULL').get() as any).n);
  });
  it('skips tombstones, keeps deleted categories that are still used, converts float amounts exactly', () => {
    const y: any = { budgetMetaData: { currencyLocale: 'da_DK' }, fileMetaData: { currentKnowledge: 'A-5' },
      accounts: [{ entityId: 'acc1', accountName: 'Bank', accountType: 'Checking', onBudget: true }, { entityId: 'acc2', accountName: 'Gone', accountType: 'Savings', onBudget: true, isTombstone: true }],
      masterCategories: [{ entityId: 'm1', name: 'Hverdag', subCategories: [{ entityId: 'c1', name: 'Mad', masterCategoryId: 'm1' }, { entityId: 'c2', name: 'Slettet', masterCategoryId: 'm1', isTombstone: true }] }],
      payees: [{ entityId: 'p1', name: 'Netto', autoFillCategoryId: 'c1' }],
      transactions: [
        { entityId: 't1', accountId: 'acc1', date: '2024-12-31', amount: -0.1, payeeId: 'p1', categoryId: 'c1', cleared: 'Cleared' },
        { entityId: 't2', accountId: 'acc1', date: '2025-01-01', amount: -0.2, payeeId: 'p1', categoryId: 'c2', cleared: 'Uncleared' },
        { entityId: 't3', accountId: 'acc1', date: '2025-01-01', amount: 1234567.89, payeeId: 'p1', categoryId: 'Category/__DeferredIncome__', cleared: 'Reconciled', checkNumber: '77' },
        { entityId: 't4', accountId: 'acc1', date: '2025-01-02', amount: -999, payeeId: 'p1', categoryId: 'c1', isTombstone: true },
        { entityId: 't5', accountId: 'acc1', date: '2025-01-03', amount: -19.99, payeeId: 'p1', categoryId: 'Category/__Split__', subTransactions: [
          { entityId: 's1', amount: -10.1, categoryId: 'c1' }, { entityId: 's2', amount: -9.89, categoryId: 'c1', memo: 'x' }, { entityId: 's3', amount: -5, categoryId: 'c1', isTombstone: true }] }],
      monthlyBudgets: [{ entityId: 'MB/2025-01', month: '2025-01-01', monthlySubCategoryBudgets: [{ categoryId: 'c1', budgeted: 100.3, overspendingHandling: 'Confined' }, { categoryId: 'c1', budgeted: 5, isTombstone: true }] }] };
    const m = parseYnab4Native([{ path: 'Budget.yfull', text: JSON.stringify(y) }]);
    expect(m.accounts).toHaveLength(1); expect(m.transactions.map(t => t.amount)).toEqual([-10, -20, 123456789, -1999]);
    expect(m.transactions[2].memo).toBe('#77'); expect(m.transactions[2].categorySid).toBe('income:next');
    expect(m.transactions[3].splits.map(s => s.amount)).toEqual([-1010, -989]);
    expect(m.categories.find(c => c.name === 'Slettet')!.hidden).toBe(true);
    expect(m.budgets).toEqual([{ month: '2025-01', categorySid: 'c1', budgeted: 10030, overspending: 'confined', note: '' }]);
    const dst = memBudget(); const r = applyImport(dst, m, 'fp'); expect(r.status).toBe('verified');
    expect(dst.listAccounts()[0].balance).toBe(-10 - 20 + 123456789 - 1999);
  });
  it('folds in newer .ydiff changes from another device and reports it', () => {
    const src = memBudget(); const g = generateBudget(src, { startMonth: '2025-06', months: 3, txPerMonth: 12 });
    const y = toYfull(src); const victim = y.transactions.find((t: any) => !t.transferTransactionId && !t.subTransactions.length && t.categoryId && !t.categoryId.startsWith('Category/__'));
    const diff = { startVersion: 'B-0', endVersion: 'B-3', deviceGUID: 'DEV-B', shortDeviceId: 'B', publishTime: '2025-09-01', items: [
      { ...victim, amount: -42.42, entityVersion: 'B-1' },
      { entityType: 'transaction', entityId: 'new-1', accountId: g.accounts.checking, date: '2025-08-30', amount: -10, payeeId: null, categoryId: g.categories.Dagligvarer, cleared: 'Uncleared', entityVersion: 'B-2' },
      { entityType: 'monthlyCategoryBudget', entityId: `MCB/2025-08/${g.categories.Gaver}`, parentMonthlyBudgetId: 'MB/2025-08', categoryId: g.categories.Gaver, budgeted: 777, entityVersion: 'B-3' },
      { ...y.transactions[0], amount: 5, entityVersion: 'A-50' }] }; // already known (A-50 ≤ A-100): ignored
    const m = parseYnab4Native(layout(y, [{ path: 'Husholdning~1A2B3C4D.ynab4/data1~ABCDEF12/DEV-B/B-0_B-3.ydiff', text: JSON.stringify(diff) }]));
    expect(m.warnings.find(w => w.code === 'diffs_applied')!.count).toBe(3);
    expect(m.transactions.find(t => t.sid === victim.entityId)!.amount).toBe(-4242);
    expect(m.transactions.some(t => t.sid === 'new-1')).toBe(true);
    expect(m.budgets.find(b => b.month === '2025-08' && b.categorySid === g.categories.Gaver)!.budgeted).toBe(77700);
    expect(m.transactions.find(t => t.sid === y.transactions[0].entityId)!.amount).not.toBe(500);
  });
  it('a transfer whose other side is missing is imported unlinked with a warning, never dropped', () => {
    const src = memBudget(); const a = src.createAccount({ name: 'A', type: 'checking' }); const b = src.createAccount({ name: 'B', type: 'savings' });
    src.createTransaction({ accountId: a, date: '2025-01-01', transferAccountId: b, amount: -100_00 });
    const y = toYfull(src); y.transactions = y.transactions.filter((t: any) => t.accountId === a);
    const m = parseYnab4Native([{ path: 'x/Budget.yfull', text: JSON.stringify(y) }]);
    expect(m.warnings.find(w => w.code === 'transfer_unlinked')!.count).toBe(1);
    const dst = memBudget(); applyImport(dst, m, 'fp');
    expect(dst.listAccounts().find(x => x.name === 'A')!.balance).toBe(-100_00); expect(dst.listTransactions()[0].payeeName).toBe('Transfer : B');
  });
  it('real-world folder layout: conflicted .ymeta copies, old data folders, AppleDouble junk and two device copies', () => {
    const src = memBudget(); generateBudget(src, { startMonth: '2025-06', months: 2, txPerMonth: 10 });
    const good = toYfull(src); const stale = { ...toYfull(src), transactions: [], fileMetaData: { currentKnowledge: 'A-1' } };
    const D = 'My Budget~1A2B3C4D.ynab4/';
    const files = [
      { path: D + 'Budget (somebody\'s conflicted copy 2019-02-03).ymeta', text: JSON.stringify({ relativeDataFolderName: 'data1~OLD' }) },
      { path: D + 'Budget.ymeta', text: JSON.stringify({ formatVersion: '2', relativeDataFolderName: 'data13-NEW' }) },
      { path: D + 'data1~OLD/DEV-A/Budget.yfull', text: JSON.stringify({ ...stale, fileMetaData: { currentKnowledge: 'A-999999' } }) }, // old folder: must not win even with "more" knowledge
      { path: D + 'data13-NEW/devices/A.ydevice', text: JSON.stringify({ deviceGUID: 'DEV-A', shortDeviceId: 'A', hasFullKnowledge: true, knowledge: 'A-100,B-7' }) },
      { path: D + 'data13-NEW/DEV-A/Budget.yfull', text: JSON.stringify({ ...good, fileMetaData: { currentKnowledge: 'A-100,B-7' } }) },
      { path: D + 'data13-NEW/DEV-B/Budget.yfull', text: JSON.stringify({ ...stale, fileMetaData: { currentKnowledge: 'A-90,B-7' } }) },
      { path: '__MACOSX/' + D + 'data13-NEW/DEV-A/._Budget.yfull', text: '\u0000\u0005\u0016\u0007binary resource fork' },
      { path: D + 'data13-NEW/DEV-A/._A-1_A-2.ydiff', text: '\u0000junk' }];
    const m = parseYnab4Native(files);
    expect(m.transactions.length).toBe(good.transactions.length); expect(m.budgetName).toBe('My Budget');
    expect(m.warnings.map(w => w.code).sort()).toEqual(['multiple_devices', 'ymeta_conflicted_copies']);
    // two device copies that each know something the other does not: reported, never silently merged
    files[5] = { path: D + 'data13-NEW/DEV-B/Budget.yfull', text: JSON.stringify({ ...stale, fileMetaData: { currentKnowledge: 'A-90,B-9' } }) };
    expect(parseYnab4Native(files).warnings.find(w => w.code === 'devices_diverged')!.level).toBe('warning');
  });
  it('sync diffs are applied in causal (knowledge) order, not by their publish-time text', () => {
    const src = memBudget(); const a = src.createAccount({ name: 'A', type: 'checking' });
    src.createTransaction({ accountId: a, date: '2025-01-01', payeeName: 'X', amount: -100 });
    const y = toYfull(src); y.fileMetaData.currentKnowledge = 'A-10'; const t = y.transactions[0];
    const diff = (start: string, end: string, publishTime: string, amount: number, version: string) => ({ path: `b.ynab4/data/DEV/${end}.ydiff`, text: JSON.stringify({ startVersion: start, endVersion: end, publishTime, items: [{ ...t, amount, entityVersion: version, isTombstone: null }] }) });
    // "Wed Sep 9" sorts after "Mon Aug 31" as text only by luck; here the later change has the alphabetically EARLIER publish time
    const m = parseYnab4Native([{ path: 'b.ynab4/data/DEV/Budget.yfull', text: JSON.stringify(y) }, diff('A-11', 'A-11,B-2', 'Fri Jan 2 10:00:00 GMT+0100 2026', -3, 'B-2'), diff('A-10', 'A-11', 'Mon Dec 1 10:00:00 GMT+0100 2025', -2, 'A-11')]);
    expect(m.transactions[0].amount).toBe(-300); expect(m.warnings.find(w => w.code === 'diffs_applied')!.count).toBe(2);
  });
  it('hidden categories ("Group ` Name ` groupId"): back to a live group, or to a hidden group named after a deleted one; built-in Income master is not a group', () => {
    const y: any = { fileMetaData: { currentKnowledge: 'A-5' }, accounts: [{ entityId: 'acc', accountName: 'Bank', accountType: 'Checking', onBudget: true }], transactions: [{ entityId: 't1', accountId: 'acc', date: '2025-01-01', amount: -5, categoryId: 'h2', cleared: 'Cleared' }],
      masterCategories: [
        { entityId: 'MasterCategory/__Hidden__', name: 'Hidden Categories', type: 'OUTFLOW', subCategories: [
          { entityId: 'h1', name: 'Hverdag ` Avis ` LIVE-1', cachedBalance: 0 }, { entityId: 'h2', name: 'Gammel gruppe ` Fitness ` med backtick ` DEAD-1', cachedBalance: 0 }, { entityId: 'h3', name: 'Gammel gruppe ` Tv ` DEAD-1' }, { entityId: 'h4', name: 'Ukendt ` Ting ` GONE-9' }] },
        { entityId: 'MasterCategory/__Income__', name: 'Income', type: 'INFLOW', subCategories: null }, { entityId: 'MasterCategory/__Internal__', name: '__Internal__', type: 'OUTFLOW', subCategories: null },
        { entityId: 'LIVE-1', name: 'Hverdag', type: 'OUTFLOW', subCategories: [{ entityId: 'c1', name: 'Mad', cachedBalance: 0 }] }, { entityId: 'DEAD-1', name: 'Gammel gruppe', type: 'OUTFLOW', isTombstone: true, subCategories: null }] };
    const m = parseYnab4Native([{ path: 'Budget.yfull', text: JSON.stringify(y) }]);
    expect(m.groups.map(g => [g.name, g.hidden])).toEqual([['Hverdag', false], ['Gammel gruppe', true], ['Ukendt', true]]);
    const where = (sid: string) => { const c = m.categories.find(x => x.sid === sid)!; return [m.groups.find(g => g.sid === c.groupSid)!.name, c.name, c.hidden]; };
    expect(where('h1')).toEqual(['Hverdag', 'Avis', true]); expect(where('h2')).toEqual(['Gammel gruppe', 'Fitness ` med backtick', true]); expect(where('h3')).toEqual(['Gammel gruppe', 'Tv', true]); expect(where('h4')).toEqual(['Ukendt', 'Ting', true]);
    expect(m.expected.categoryBalances).toEqual([]); // cachedBalance is 0 everywhere in real files: never treated as evidence
    const dst = memBudget(); expect(applyImport(dst, m, 'fp').status).toBe('verified'); expect(dst.listGroups().map(g => [g.name, g.hidden])).toEqual([['Hverdag', false], ['Gammel gruppe', true], ['Ukendt', true]]);
  });
  it('rejects files that are not a YNAB4 budget', () => {
    expect(() => parseYnab4Native([{ path: 'Budget.yfull', text: '{"hello":1}' }])).toThrow(/does not look like/);
    expect(() => parseYnab4Native([{ path: 'Budget.yfull', text: 'not json' }])).toThrow(/not valid JSON/);
    expect(() => parseYnab4Native([{ path: 'a.ymeta', text: '{}' }])).toThrow(/No Budget.yfull/);
  });
});

describe('zip entry names (M4)', () => {
  it('recovers UTF-8 names written without the UTF-8 flag and leaves everything else alone', async () => {
    const { fixZipName } = await import('../../src/web/lib/files.ts');
    const latin1 = (bytes: number[]) => String.fromCharCode(...bytes); // how fflate decodes unflagged names
    const utf8 = (s: string) => latin1([...new TextEncoder().encode(s)]);
    expect(fixZipName(utf8('ØkonomiKonto LATEST.ynab4/Budget.ymeta'))).toBe('ØkonomiKonto LATEST.ynab4/Budget.ymeta');
    expect(fixZipName(utf8('Husholdning æøå ÆØÅ.ynab4/x'))).toBe('Husholdning æøå ÆØÅ.ynab4/x');
    expect(fixZipName(latin1([0x42, 0x9b, 0x72, 0x73]))).toBe(latin1([0x42, 0x9b, 0x72, 0x73])); // not UTF-8: no code page is guessed
    expect(fixZipName('Plain ASCII.ynab4/Budget.yfull')).toBe('Plain ASCII.ynab4/Budget.yfull');
    expect(fixZipName('Økonomi.ynab4')).toBe('Økonomi.ynab4'); // flagged zip already decoded correctly: unchanged
  });
  it('the budget name suggested from a real-style Mac zip is readable', async () => {
    const { fixZipName } = await import('../../src/web/lib/files.ts');
    const src = memBudget(); generateBudget(src, { startMonth: '2025-01', months: 1, txPerMonth: 5 });
    const garbled = String.fromCharCode(...new TextEncoder().encode('ØkonomiKonto LATEST.ynab4/data1~ABCDEF12/DEV/Budget.yfull'));
    expect(parseYnab4Native([{ path: garbled, text: JSON.stringify(toYfull(src)) }]).budgetName).not.toBe('ØkonomiKonto LATEST');
    expect(parseYnab4Native([{ path: fixZipName(garbled), text: JSON.stringify(toYfull(src)) }]).budgetName).toBe('ØkonomiKonto LATEST');
  });
});
