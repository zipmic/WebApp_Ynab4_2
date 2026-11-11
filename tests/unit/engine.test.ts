import { describe, expect, it } from 'vitest';
import { computeBudget, INCOME_NEXT, INCOME_THIS } from '../../src/shared/engine.ts';
import { basicBudget } from './helpers.ts';

describe('budget engine (pure)', () => {
  it('income assignment: ATB = income − budgeted', () => {
    const r = computeBudget({ categoryIds: ['a'], through: '2026-01', activity: [{ month: '2026-01', categoryId: INCOME_THIS, amount: 100000 }], budgets: [{ month: '2026-01', categoryId: 'a', budgeted: 30000, overspending: null }] });
    const m = r.months.get('2026-01')!;
    expect(m.income).toBe(100000); expect(m.availableToBudget).toBe(70000); expect(m.categories.get('a')!.available).toBe(30000);
  });
  it('"income for next month" becomes available one month later, including across December → January', () => {
    const r = computeBudget({ categoryIds: [], through: '2026-02', activity: [{ month: '2025-12', categoryId: INCOME_NEXT, amount: 50000 }], budgets: [] });
    expect(r.months.get('2025-12')!.availableToBudget).toBe(0);
    expect(r.months.get('2026-01')!.income).toBe(50000);
    expect(r.months.get('2026-01')!.availableToBudget).toBe(50000);
    expect(r.months.get('2026-02')!.carriedAtb).toBe(50000);
  });
  it('positive balances roll over; overspending resets the category and reduces NEXT month ATB (YNAB4 default)', () => {
    const r = computeBudget({ categoryIds: ['a', 'b'], through: '2026-03', activity: [
      { month: '2026-01', categoryId: INCOME_THIS, amount: 100000 }, { month: '2026-01', categoryId: 'a', amount: -70000 }, { month: '2026-01', categoryId: 'b', amount: -1000 }],
      budgets: [{ month: '2026-01', categoryId: 'a', budgeted: 50000, overspending: null }, { month: '2026-01', categoryId: 'b', budgeted: 5000, overspending: null }] });
    const jan = r.months.get('2026-01')!, feb = r.months.get('2026-02')!;
    expect(jan.categories.get('a')!.available).toBe(-20000); expect(jan.overspent).toBe(20000);
    expect(jan.availableToBudget).toBe(45000); // overspending does not touch the month it happens in
    expect(feb.categories.get('a')!.available).toBe(0); expect(feb.categories.get('b')!.available).toBe(4000);
    expect(feb.overspentPrev).toBe(20000); expect(feb.availableToBudget).toBe(25000);
    expect(r.months.get('2026-03')!.availableToBudget).toBe(25000); // deducted once, not every month
  });
  it('red arrow (confined): negative balance stays in the category, ATB untouched; setting is sticky until changed', () => {
    const r = computeBudget({ categoryIds: ['a'], through: '2026-05', activity: [{ month: '2026-01', categoryId: 'a', amount: -20000 }, { month: '2026-03', categoryId: 'a', amount: -5000 }],
      budgets: [{ month: '2026-01', categoryId: 'a', budgeted: 0, overspending: 'confined' }, { month: '2026-02', categoryId: 'a', budgeted: 15000, overspending: null }, { month: '2026-04', categoryId: 'a', budgeted: 0, overspending: 'affects_buffer' }] });
    expect(r.months.get('2026-01')!.overspent).toBe(0);
    expect(r.months.get('2026-02')!.categories.get('a')!.available).toBe(-5000);
    expect(r.months.get('2026-02')!.availableToBudget).toBe(-15000);
    expect(r.months.get('2026-03')!.categories.get('a')!.available).toBe(-10000); // still confined (inherited)
    expect(r.months.get('2026-04')!.categories.get('a')!.handling).toBe('affects_buffer');
    expect(r.months.get('2026-04')!.overspent).toBe(10000);
    expect(r.months.get('2026-05')!.categories.get('a')!.available).toBe(0);
    expect(r.months.get('2026-05')!.availableToBudget).toBe(-25000);
  });
  it('overbudgeting carries a negative ATB forward', () => {
    const r = computeBudget({ categoryIds: ['a'], through: '2026-02', activity: [], budgets: [{ month: '2026-01', categoryId: 'a', budgeted: 10000, overspending: null }] });
    expect(r.months.get('2026-01')!.availableToBudget).toBe(-10000); expect(r.months.get('2026-02')!.carriedAtb).toBe(-10000);
  });
  it('budgeting a future month does not change the current month ATB (YNAB4, unlike subscription YNAB)', () => {
    const r = computeBudget({ categoryIds: ['a'], through: '2026-03', activity: [{ month: '2026-01', categoryId: INCOME_THIS, amount: 100000 }], budgets: [{ month: '2026-03', categoryId: 'a', budgeted: 60000, overspending: null }] });
    expect(r.months.get('2026-01')!.availableToBudget).toBe(100000); expect(r.months.get('2026-02')!.availableToBudget).toBe(100000); expect(r.months.get('2026-03')!.availableToBudget).toBe(40000);
  });
  it('red arrow toggled on and off repeatedly (the pattern found in a real 12-year budget): each setting holds until the next one', () => {
    const b = (month: string, overspending: any, budgeted = 0) => ({ month, categoryId: 'debt', budgeted, overspending });
    const r = computeBudget({ categoryIds: ['debt'], through: '2026-08', activity: [{ month: '2026-01', categoryId: 'debt', amount: -90000 }, { month: '2026-01', categoryId: INCOME_THIS, amount: 100000 }],
      budgets: [b('2026-01', 'confined', 10000), b('2026-02', null, 10000), b('2026-03', 'affects_buffer', 10000), b('2026-04', null, 10000), b('2026-05', 'confined'), b('2026-06', null, 5000)] });
    const at = (m: string) => [r.months.get(m)!.categories.get('debt')!.available, r.months.get(m)!.availableToBudget];
    expect(at('2026-01')).toEqual([-80000, 90000]); expect(at('2026-02')).toEqual([-70000, 80000]); // confined, inherited in February
    expect(at('2026-03')).toEqual([-60000, 70000]); // switched off in March: March's shortfall will hit April's Available to Budget
    expect(at('2026-04')).toEqual([10000, 0]); expect(r.months.get('2026-04')!.overspentPrev).toBe(60000); // category restarted from zero
    expect(at('2026-06')).toEqual([15000, -5000]); expect(r.months.get('2026-06')!.categories.get('debt')!.handling).toBe('confined'); // on again from May, inherited in June
  });
  it('income categorised straight to a spending category raises that category, not Available to Budget; refunds likewise', () => {
    const r = computeBudget({ categoryIds: ['a'], through: '2026-02', budgets: [], activity: [{ month: '2026-01', categoryId: 'a', amount: 25000 }, { month: '2026-02', categoryId: 'a', amount: -10000 }] });
    expect(r.months.get('2026-01')!).toMatchObject({ income: 0, availableToBudget: 0 }); expect(r.months.get('2026-01')!.categories.get('a')!.available).toBe(25000);
    expect(r.months.get('2026-02')!.categories.get('a')!.available).toBe(15000);
  });
  it('rejects non-integer money', () => {
    expect(() => computeBudget({ categoryIds: ['a'], through: '2026-01', activity: [{ month: '2026-01', categoryId: 'a', amount: 0.1 }], budgets: [] })).toThrow();
  });
});

describe('the October / November scenario from the specification', () => {
  it('a forgotten October transaction immediately changes November and every later month', () => {
    const { s, checking, groceries, row } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2025-10-01', payeeName: 'Employer', categoryId: INCOME_THIS, amount: 10_000_00 });
    s.setBudget('2025-10', groceries, { budgeted: 5_000_00 });
    s.createTransaction({ accountId: checking, date: '2025-10-12', payeeName: 'Netto', categoryId: groceries, amount: -3_000_00 });
    expect(row('2025-10', groceries).available).toBe(2_000_00);
    expect(row('2025-11', groceries).available).toBe(2_000_00); // rolled over
    expect(row('2026-02', groceries).available).toBe(2_000_00);
    // forgotten October purchase
    const t = s.createTransaction({ accountId: checking, date: '2025-10-30', payeeName: 'SPAR', categoryId: groceries, amount: -500_00 });
    expect(row('2025-10', groceries).available).toBe(1_500_00);
    expect(row('2025-11', groceries).available).toBe(1_500_00);
    expect(row('2026-01', groceries).available).toBe(1_500_00); // across the year boundary
    // …and a bigger one that overspends October: November restarts at 0 and November's ATB pays for it
    s.createTransaction({ accountId: checking, date: '2025-10-31', payeeName: 'Føtex', categoryId: groceries, amount: -2_000_00 });
    expect(row('2025-10', groceries).available).toBe(-500_00);
    expect(row('2025-11', groceries).available).toBe(0);
    expect(s.getBudget('2025-10').availableToBudget).toBe(5_000_00);
    expect(s.getBudget('2025-11').availableToBudget).toBe(4_500_00);
    expect(s.getBudget('2025-11').overspentPrev).toBe(500_00);
    // editing the old transaction's amount, date and category recalculates again
    s.updateTransaction(t.id, { amount: -100_00 });
    expect(row('2025-10', groceries).available).toBe(-100_00);
    expect(s.getBudget('2025-12').availableToBudget).toBe(4_900_00);
    s.updateTransaction(t.id, { date: '2025-11-02' });
    expect(row('2025-10', groceries).available).toBe(0); expect(row('2025-11', groceries).activity).toBe(-100_00);
    expect(s.checkIntegrity()).toEqual([]);
  });
  it('changing a budget in a past month flows into later months', () => {
    const { s, checking, groceries, row } = basicBudget();
    s.createTransaction({ accountId: checking, date: '2025-12-01', payeeName: 'Employer', categoryId: INCOME_THIS, amount: 5_000_00 });
    s.setBudget('2025-12', groceries, { budgeted: 1_000_00 });
    expect(row('2026-01', groceries).available).toBe(1_000_00);
    s.setBudget('2025-12', groceries, { budgeted: 1_500_00 });
    expect(row('2026-01', groceries).available).toBe(1_500_00); expect(s.getBudget('2026-01').availableToBudget).toBe(3_500_00);
  });
});
