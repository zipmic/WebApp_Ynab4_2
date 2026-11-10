import { describe, expect, it } from 'vitest';
import { INCOME_THIS } from '../../src/shared/engine.ts';
import { basicBudget, memBudget } from './helpers.ts';
import { generateBudget, rng } from '../fixtures/generate.ts';

const bal = (s: ReturnType<typeof memBudget>, id: string) => s.listAccounts().find(a => a.id === id)!;

describe('accounts and balances', () => {
  it('account balance = sum of its transactions (starting balance is a transaction, as in YNAB4)', () => {
    const s = memBudget(); const a = s.createAccount({ name: 'A', type: 'checking', balance: 1234_56, date: '2026-01-01' });
    s.createTransaction({ accountId: a, date: '2026-01-02', payeeName: 'X', amount: -34_56 });
    expect(bal(s, a).balance).toBe(1200_00);
    expect(s.getBudget('2026-01').income).toBe(1234_56); // starting balance of a budget account is income
    expect(s.listTransactions({ accountId: a })[0].payeeName).toBe('Starting Balance');
  });
  it('rejects floating point and absurd amounts', () => {
    const { s, checking } = basicBudget();
    expect(() => s.createTransaction({ accountId: checking, date: '2026-01-02', amount: 10.5 })).toThrow();
    expect(() => s.createTransaction({ accountId: checking, date: '2026-02-30', amount: 100 })).toThrow(/date/i);
    expect(() => s.setBudget('2026-01', 'nope', { budgeted: 1 })).toThrow();
  });
  it('remembers the last category used for a payee', () => {
    const { s, checking, groceries } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'Netto', categoryId: groceries, amount: -100 });
    expect(s.listPayees().find(p => p.name === 'Netto')!.autoCategoryId).toBe(groceries);
  });
});

describe('transfers', () => {
  it('between budget accounts: moves money, no category, no budget effect, both registers updated', () => {
    const { s, checking, savings } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00 });
    const before = s.getBudget('2026-01');
    const t = s.createTransaction({ accountId: checking, date: '2026-01-05', transferAccountId: savings, categoryId: 'income:this', amount: -400_00 });
    expect(t.changed).toHaveLength(2);
    expect(bal(s, checking).balance).toBe(600_00); expect(bal(s, savings).balance).toBe(400_00);
    const other = s.listTransactions({ accountId: savings })[0];
    expect(other.amount).toBe(400_00); expect(other.categoryId).toBeNull(); expect(other.payeeName).toBe('Transfer : Checking'); expect(other.transferTxnId).toBe(t.id);
    const after = s.getBudget('2026-01');
    expect(after.availableToBudget).toBe(before.availableToBudget); expect(after.income).toBe(before.income); expect(after.activity).toBe(before.activity);
    // edit from the far side
    s.updateTransaction(other.id, { amount: 250_00, date: '2026-01-06' });
    expect(bal(s, checking).balance).toBe(750_00); expect(s.listTransactions({ accountId: checking }).find(x => x.id === t.id)!.date).toBe('2026-01-06');
    // retarget
    const { invest } = { invest: s.listAccounts().find(a => a.name === 'Invest')!.id };
    s.updateTransaction(t.id, { transferAccountId: invest });
    expect(bal(s, savings).balance).toBe(0); expect(bal(s, invest).balance).toBe(250_00);
    // convert to an ordinary payment
    s.updateTransaction(t.id, { payeeName: 'Shop', transferAccountId: null });
    expect(bal(s, invest).balance).toBe(0); expect(s.listTransactions({ accountId: checking }).find(x => x.id === t.id)!.transferAccountId).toBeNull();
    expect(s.checkIntegrity()).toEqual([]);
    s.deleteTransactions([t.id]); expect(bal(s, checking).balance).toBe(1000_00);
  });
  it('budget → tracking account is spending and needs a category; tracking → budget is categorised on the budget side', () => {
    const { s, checking, invest, fun, row } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00 });
    s.createTransaction({ accountId: checking, date: '2026-01-03', transferAccountId: invest, categoryId: fun, amount: -300_00 });
    expect(row('2026-01', fun).activity).toBe(-300_00);
    expect(s.listTransactions({ accountId: invest })[0].categoryId).toBeNull();
    // entered from the tracking side: category lands on the budget side
    const t = s.createTransaction({ accountId: invest, date: '2026-01-10', transferAccountId: checking, categoryId: INCOME_THIS, amount: -100_00 });
    expect(s.getBudget('2026-01').income).toBe(1100_00);
    expect(s.listTransactions({ accountId: invest }).find(x => x.id === t.id)!.categoryId).toBeNull();
    s.updateTransaction(t.id, { memo: 'dividend' }); // editing from the tracking side keeps the budget-side category
    expect(s.getBudget('2026-01').income).toBe(1100_00);
    expect(s.getBudget('2026-01').uncategorizedCount).toBe(0);
    expect(s.checkIntegrity()).toEqual([]);
  });
  it('transfer to the same account is rejected', () => {
    const { s, checking } = basicBudget();
    expect(() => s.createTransaction({ accountId: checking, date: '2026-01-01', transferAccountId: checking, amount: 1 })).toThrow();
  });
});

describe('split transactions', () => {
  it('NETTO 850: 650 groceries + 150 fun + 50 rent; lines must equal the total', () => {
    const { s, checking, groceries, fun, rent, row } = basicBudget();
    expect(() => s.createTransaction({ accountId: checking, date: '2026-03-01', payeeName: 'NETTO', amount: -850_00, splits: [{ amount: -650_00, categoryId: groceries }, { amount: -150_00, categoryId: fun }] })).toThrow(/add up/);
    const t = s.createTransaction({ accountId: checking, date: '2026-03-01', payeeName: 'NETTO', amount: -850_00, splits: [{ amount: -650_00, categoryId: groceries, memo: 'food' }, { amount: -150_00, categoryId: fun }, { amount: -50_00, categoryId: rent }] });
    expect(bal(s, checking).balance).toBe(-850_00); expect(bal(s, checking).txCount).toBe(1);
    expect(row('2026-03', groceries).activity).toBe(-650_00); expect(row('2026-03', fun).activity).toBe(-150_00); expect(row('2026-03', rent).activity).toBe(-50_00);
    expect(s.getBudget('2026-03').activity).toBe(-850_00);
    // changing only the total without the lines is refused
    expect(() => s.updateTransaction(t.id, { amount: -900_00 })).toThrow(/add up/);
    s.updateTransaction(t.id, { amount: -900_00, splits: [{ amount: -700_00, categoryId: groceries }, { amount: -200_00, categoryId: fun }] });
    expect(row('2026-03', rent).activity).toBe(0); expect(row('2026-03', groceries).activity).toBe(-700_00);
    s.updateTransaction(t.id, { date: '2026-04-02' }); // lines follow the parent's date
    expect(row('2026-03', groceries).activity).toBe(0); expect(row('2026-04', groceries).activity).toBe(-700_00);
    s.updateTransaction(t.id, { splits: [], categoryId: groceries }); // un-split
    expect(row('2026-04', groceries).activity).toBe(-900_00);
    expect(s.checkIntegrity()).toEqual([]);
  });
  it('a split line can be a transfer; its far side is protected', () => {
    const { s, checking, savings, groceries } = basicBudget();
    const t = s.createTransaction({ accountId: checking, date: '2026-03-01', payeeName: 'ATM', amount: -500_00, splits: [{ amount: -300_00, categoryId: groceries }, { amount: -200_00, transferAccountId: savings }] });
    expect(bal(s, savings).balance).toBe(200_00);
    const far = s.listTransactions({ accountId: savings })[0];
    expect(far.splitTransferParent).toBe(true);
    expect(() => s.updateTransaction(far.id, { amount: 1 })).toThrow(/split/i);
    expect(() => s.deleteTransactions([far.id])).toThrow(/split/i);
    s.updateTransaction(far.id, { cleared: 'cleared' });
    s.deleteTransactions([t.id]); expect(bal(s, savings).balance).toBe(0); expect(bal(s, savings).txCount).toBe(0);
    expect(s.checkIntegrity()).toEqual([]);
  });
});

describe('credit cards (YNAB4 semantics: an account with a negative balance, no payment category)', () => {
  it('spending on the card uses the category; paying the card is a plain transfer', () => {
    const { s, checking, card, groceries, row } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 2000_00 });
    s.setBudget('2026-01', groceries, { budgeted: 500_00 });
    s.createTransaction({ accountId: card, date: '2026-01-10', payeeName: 'Netto', categoryId: groceries, amount: -300_00 });
    expect(bal(s, card).balance).toBe(-300_00); expect(row('2026-01', groceries).available).toBe(200_00);
    const atb = s.getBudget('2026-01').availableToBudget;
    s.createTransaction({ accountId: checking, date: '2026-01-20', transferAccountId: card, amount: -300_00 });
    expect(bal(s, card).balance).toBe(0); expect(s.getBudget('2026-01').availableToBudget).toBe(atb); expect(row('2026-01', groceries).available).toBe(200_00);
  });
  it('credit overspending behaves exactly like cash overspending: deducted from next month ATB', () => {
    const { s, checking, card, fun, row } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00 });
    s.createTransaction({ accountId: card, date: '2026-01-10', payeeName: 'Cinema', categoryId: fun, amount: -120_00 });
    expect(row('2026-01', fun).available).toBe(-120_00); expect(s.getBudget('2026-01').availableToBudget).toBe(1000_00);
    expect(s.getBudget('2026-02').availableToBudget).toBe(880_00); expect(row('2026-02', fun).available).toBe(0);
  });
  it('pre-existing card debt as a confined (red arrow) category carries its negative balance until paid down', () => {
    const s = memBudget(); const chk = s.createAccount({ name: 'C', type: 'checking', balance: 5000_00, date: '2026-01-01' });
    const card = s.createAccount({ name: 'Card', type: 'credit_card' }); const g = s.createGroup('Pre-YNAB Debt'); const debt = s.createCategory(g, 'Card');
    s.createTransaction({ accountId: card, date: '2026-01-01', payeeName: 'Starting Balance', categoryId: debt, amount: -3000_00 });
    s.setBudget('2026-01', debt, { budgeted: 1000_00, overspending: 'confined' }); s.setBudget('2026-02', debt, { budgeted: 1000_00 });
    const row = (m: string) => s.getBudget(m).rows.find(r => r.categoryId === debt)!;
    expect(row('2026-01').available).toBe(-2000_00); expect(row('2026-02').available).toBe(-1000_00);
    expect(s.getBudget('2026-02').availableToBudget).toBe(3000_00); expect(s.getBudget('2026-03').overspentPrev).toBe(0);
    void chk;
  });
});

describe('cleared / reconciled state and reconciliation', () => {
  it('reconciles when the statement matches and never changes amounts', () => {
    const { s, checking } = basicBudget();
    const a = s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00, cleared: 'cleared' });
    const b = s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'Shop', amount: -100_00 });
    expect(bal(s, checking).clearedBalance).toBe(1000_00); expect(bal(s, checking).unclearedBalance).toBe(-100_00);
    expect(() => s.reconcile(checking, 900_00)).toThrow(/does not match/);
    const info = s.reconcileInfo(checking, 900_00);
    expect(info.difference).toBe(-100_00); expect(info.hints.find((h: any) => h.kind === 'uncleared_match').txnIds).toEqual([b.id]);
    s.updateTransaction(b.id, { cleared: 'cleared' });
    const r = s.reconcile(checking, 900_00);
    expect(r.adjustment).toBe(0); expect(r.reconciledCount).toBe(2);
    const txns = s.listTransactions({ accountId: checking });
    expect(txns.every(t => t.cleared === 'reconciled')).toBe(true); expect(txns.map(t => t.amount)).toEqual([1000_00, -100_00]);
    expect(bal(s, checking).lastReconciledAt).not.toBeNull(); expect(s.reconcileInfo(checking).history).toHaveLength(1);
    // reconciled transactions are protected against silent amount changes
    expect(() => s.updateTransaction(a.id, { amount: 1 })).toThrow(/reconciled/i);
    s.updateTransaction(a.id, { memo: 'ok' }); s.updateTransaction(a.id, { amount: 999_00 }, { allowReconciledEdit: true });
  });
  it('creates an adjustment only when explicitly confirmed, and it is a visible transaction', () => {
    const { s, checking } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00, cleared: 'cleared' });
    expect(() => s.reconcile(checking, 990_00, false)).toThrow();
    expect(bal(s, checking).txCount).toBe(1);
    const r = s.reconcile(checking, 990_00, true, '2026-01-31');
    expect(r.adjustment).toBe(-10_00);
    const adj = s.listTransactions({ accountId: checking }).find(t => t.payeeName === 'Reconciliation Balance Adjustment')!;
    expect(adj.amount).toBe(-10_00); expect(adj.cleared).toBe('reconciled'); expect(bal(s, checking).clearedBalance).toBe(990_00);
    s.undo(); expect(bal(s, checking).txCount).toBe(1); expect(s.listTransactions({ accountId: checking })[0].cleared).toBe('cleared');
  });
  it('diagnostics: possible duplicates and wrong sign', () => {
    const { s, checking } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2026-01-01', payeeName: 'Job', categoryId: INCOME_THIS, amount: 1000_00, cleared: 'cleared' });
    s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'Shop', amount: -50_00, cleared: 'cleared' });
    s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'Shop', amount: -50_00, cleared: 'cleared' });
    s.createTransaction({ accountId: checking, date: '2026-01-03', payeeName: 'Refund', amount: -20_00, cleared: 'cleared' }); // should have been +20
    const kinds = (st: number) => s.reconcileInfo(checking, st).hints.map((h: any) => h.kind);
    expect(kinds(880_00 + 50_00)).toContain('cleared_by_mistake'); expect(kinds(880_00 + 50_00)).toContain('possible_duplicates');
    expect(kinds(880_00 + 40_00)).toContain('wrong_sign');
  });
});

describe('categories', () => {
  it('changing a transaction category moves the activity', () => {
    const { s, checking, groceries, fun, row } = basicBudget();
    const t = s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'X', categoryId: groceries, amount: -10_00 });
    s.updateTransaction(t.id, { categoryId: fun });
    expect(row('2026-01', groceries).activity).toBe(0); expect(row('2026-01', fun).activity).toBe(-10_00);
    s.bulkUpdate([t.id], { categoryId: null }); expect(s.getBudget('2026-01').uncategorizedCount).toBe(1); expect(row('2026-01', fun).activity).toBe(0);
  });
  it('deleting a used category requires reassignment and merges budget history', () => {
    const { s, checking, groceries, fun, row } = basicBudget();
    s.setBudget('2026-01', groceries, { budgeted: 100_00 }); s.setBudget('2026-01', fun, { budgeted: 50_00 });
    s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'X', categoryId: groceries, amount: -10_00 });
    const atb = s.getBudget('2026-01').availableToBudget;
    expect(() => s.deleteCategory(groceries)).toThrow(/move them/);
    s.deleteCategory(groceries, fun);
    expect(row('2026-01', fun)).toMatchObject({ budgeted: 150_00, activity: -10_00, available: 140_00 });
    expect(s.getBudget('2026-01').availableToBudget).toBe(atb);
  });
  it('hiding keeps balances; reordering and moving between groups persists', () => {
    const { s, g, groceries, fun, rent } = basicBudget(); const g2 = s.createGroup('Other');
    s.updateCategory(fun, { hidden: true }); expect(s.listCategories().find(c => c.id === fun)!.hidden).toBe(true);
    s.reorderCategories([{ groupId: g2, categoryIds: [rent] }, { groupId: g, categoryIds: [fun, groceries] }]);
    expect(s.listGroups().map(x => x.id)).toEqual([g2, g]); expect(s.listCategories().map(c => c.id)).toEqual([rent, fun, groceries]);
  });
  it('quick budget and move money', () => {
    const { s, checking, groceries, fun, row } = basicBudget();
    s.setBudget('2026-01', groceries, { budgeted: 100_00 }); s.createTransaction({ accountId: checking, date: '2026-01-02', payeeName: 'X', categoryId: fun, amount: -30_00 });
    s.quickBudget('2026-02', 'budgeted_last_month'); expect(row('2026-02', groceries).budgeted).toBe(100_00);
    s.quickBudget('2026-02', 'outflows_last_month', [fun]); expect(row('2026-02', fun).budgeted).toBe(30_00);
    const before = s.getBudget('2026-02').availableToBudget;
    s.moveMoney('2026-02', groceries, fun, 25_00);
    expect(row('2026-02', groceries).budgeted).toBe(75_00); expect(row('2026-02', fun).budgeted).toBe(55_00); expect(s.getBudget('2026-02').availableToBudget).toBe(before);
    s.quickBudget('2026-02', 'balance_to_zero', [groceries]); expect(row('2026-02', groceries).available).toBe(0);
  });
});

describe('undo / redo', () => {
  it('restores every kind of change exactly', () => {
    const { s, checking, savings, groceries } = basicBudget();
    const snapshot = () => JSON.stringify([s.listAccounts(), s.listTransactions(), s.getBudget('2026-01'), s.listCategories()]);
    const s0 = snapshot();
    s.createTransaction({ accountId: checking, date: '2026-01-02', transferAccountId: savings, amount: -5_00 }); const s1 = snapshot();
    s.setBudget('2026-01', groceries, { budgeted: 7_00 }); const s2 = snapshot();
    s.updateCategory(groceries, { name: 'Food' }); const s3 = snapshot();
    expect(s.undoStatus().undo).toBe('Edit category');
    s.undo(); expect(snapshot()).toBe(s2); s.undo(); expect(snapshot()).toBe(s1); s.undo(); expect(snapshot()).toBe(s0);
    s.redo(); expect(snapshot()).toBe(s1); s.redo(); s.redo(); expect(snapshot()).toBe(s3); expect(s.redo()).toBeNull();
    s.undo(); s.setBudget('2026-01', groceries, { budgeted: 9_00 }); expect(s.undoStatus().redo).toBeNull(); // new action clears redo
    expect(s.checkIntegrity()).toEqual([]);
  });
});

describe('scheduled transactions', () => {
  it('enters due occurrences and advances; December → January and month-end clamping', () => {
    const { s, checking, rent, row } = basicBudget();
    s.saveScheduled({ accountId: checking, nextDate: '2025-11-30', frequency: 'monthly', payeeName: 'Landlord', categoryId: rent, memo: '', amount: -5000_00, flag: null, transferAccountId: null, splits: [] });
    const r = s.postScheduled('2026-02-28');
    expect(r.posted).toBe(4);
    expect(s.listTransactions({ accountId: checking }).map(t => t.date)).toEqual(['2025-11-30', '2025-12-30', '2026-01-30', '2026-02-28']);
    expect(s.listScheduled()[0].nextDate).toBe('2026-03-30'); expect(row('2026-01', rent).activity).toBe(-5000_00);
    expect(s.postScheduled('2026-02-28').posted).toBe(0);
  });
});

describe('invariants hold under random operations on a multi-year budget', () => {
  it('3 years of generated history + 300 random edits stay consistent', () => {
    const s = memBudget(); const g = generateBudget(s, { startMonth: '2023-11', months: 38, txPerMonth: 40, seed: 7 });
    expect(s.checkIntegrity()).toEqual([]);
    const r = rng(99); const cats = Object.values(g.categories); const accts = Object.values(g.accounts);
    for (let i = 0; i < 300; i++) {
      const all = s.listTransactions({ from: '2024-01-01', to: '2024-03-31' }).filter(t => !t.splitTransferParent && t.cleared !== 'reconciled');
      const t = all[Math.floor(r() * all.length)]; const op = r();
      try {
        if (op < 0.3) s.updateTransaction(t.id, { amount: -Math.floor(r() * 500_00) - 1, ...(t.splits.length ? { splits: [] } : {}) });
        else if (op < 0.5) s.updateTransaction(t.id, { date: `2024-0${1 + Math.floor(r() * 9)}-15` });
        else if (op < 0.65) s.updateTransaction(t.id, { transferAccountId: accts[Math.floor(r() * accts.length)], splits: [] });
        else if (op < 0.8) s.updateTransaction(t.id, { categoryId: cats[Math.floor(r() * cats.length)], payeeName: 'Random', splits: [] });
        else if (op < 0.9) s.deleteTransactions([t.id]);
        else s.undo();
      } catch (e: any) { if (!/two different accounts|split/i.test(e.message)) throw e; }
    }
    expect(s.checkIntegrity()).toEqual([]);
    // account balances equal the sum of their transactions; transfers create no money
    for (const a of s.listAccounts()) expect(a.balance).toBe(s.listTransactions({ accountId: a.id }).reduce((x, t) => x + t.amount, 0));
  });
});
