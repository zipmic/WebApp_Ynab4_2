/**
 * Deterministic synthetic household budget used by tests and the performance benchmark.
 * All names and amounts are invented; no real financial data is used anywhere in this repository.
 */
import type { BudgetService } from '../../src/server/budgetService.ts';
import { addMonths, daysInMonth, pad2 } from '../../src/shared/dates.ts';
import type { TxnInput } from '../../src/shared/types.ts';

export function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export interface Generated { accounts: Record<string, string>; categories: Record<string, string>; groups: Record<string, string>; firstMonth: string; lastMonth: string; txCount: number }

export function generateBudget(svc: BudgetService, opts: { startMonth: string; months: number; txPerMonth: number; seed?: number }): Generated {
  const r = rng(opts.seed ?? 42); const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const day = (m: string) => `${m}-${pad2(1 + Math.floor(r() * daysInMonth(+m.slice(0, 4), +m.slice(5, 7))))}`;
  const accounts: Record<string, string> = {}, groups: Record<string, string> = {}, categories: Record<string, string> = {};
  const start = `${opts.startMonth}-01`;
  accounts.checking = svc.createAccount({ name: 'Lønkonto', type: 'checking', balance: 25_000_00, date: start });
  accounts.savings = svc.createAccount({ name: 'Opsparing', type: 'savings', balance: 80_000_00, date: start });
  accounts.cash = svc.createAccount({ name: 'Kontanter', type: 'cash', balance: 500_00, date: start });
  accounts.card = svc.createAccount({ name: 'Kreditkort', type: 'credit_card', balance: 0, date: start });
  accounts.invest = svc.createAccount({ name: 'Aktiedepot', type: 'investment', balance: 150_000_00, date: start });
  accounts.mortgage = svc.createAccount({ name: 'Realkreditlån', type: 'mortgage', balance: -1_200_000_00, date: start });
  const layout: Record<string, string[]> = { 'Faste udgifter': ['Husleje', 'El og varme', 'Forsikringer', 'Internet og mobil', 'Realkredit'], Hverdag: ['Dagligvarer', 'Transport', 'Husholdning', 'Tøj', 'Personligt'],
    Fornøjelser: ['Restaurant', 'Ferie', 'Gaver', 'Hobby'], Opsparingsmål: ['Buffer', 'Bil', 'Vedligeholdelse'] };
  for (const [g, cs] of Object.entries(layout)) { groups[g] = svc.createGroup(g); for (const c of cs) categories[c] = svc.createCategory(groups[g], c); }
  const payees: Record<string, string[]> = { Dagligvarer: ['Netto', 'Rema 1000', 'Føtex', 'SPAR', 'Lidl', 'Irma'], Transport: ['Circle K', 'DSB', 'Rejsekort', 'OK Benzin'], Husholdning: ['Matas', 'IKEA', 'Silvan', 'Jysk'],
    Tøj: ['H&M', 'Zalando', 'Magasin'], Personligt: ['Frisør Saks', 'Apoteket', 'Normal'], Restaurant: ['Café Smagløs', 'Sticks n Sushi', 'Pizzeria Roma'], Ferie: ['SAS', 'Booking.com'], Gaver: ['Bog & Idé', 'Imerco'], Hobby: ['Sport24', 'Panduro'] };
  const spendCats = Object.keys(payees); const budgets: Record<string, number> = { Husleje: 9500_00, 'El og varme': 1400_00, Forsikringer: 900_00, 'Internet og mobil': 550_00, Realkredit: 4200_00, Dagligvarer: 6000_00, Transport: 1500_00,
    Husholdning: 800_00, Tøj: 700_00, Personligt: 500_00, Restaurant: 900_00, Ferie: 1500_00, Gaver: 400_00, Hobby: 400_00, Buffer: 1000_00, Bil: 1500_00, Vedligeholdelse: 600_00 };
  let txCount = 6; let month = opts.startMonth; const batch: TxnInput[] = [];
  const flush = () => { if (batch.length) { svc.createTransactions(batch.splice(0)); } };
  for (let i = 0; i < opts.months; i++, month = addMonths(month, 1)) {
    // income: salary for next month (deferred) every month, child benefit quarterly for this month
    batch.push({ accountId: accounts.checking, date: `${month}-28`.replace(/-(\d{2})$/, (_, d) => '-' + pad2(Math.min(+d, daysInMonth(+month.slice(0, 4), +month.slice(5, 7))))), payeeName: 'Arbejdsgiver A/S', categoryId: 'income:next', amount: 34_500_00 + Math.floor(r() * 500) * 100, cleared: 'reconciled' });
    if (i % 3 === 0) batch.push({ accountId: accounts.checking, date: `${month}-20`, payeeName: 'Udbetaling Danmark', categoryId: 'income:this', amount: 2_800_00, cleared: 'reconciled' });
    // fixed bills
    batch.push({ accountId: accounts.checking, date: `${month}-01`, payeeName: 'Boligforeningen', categoryId: categories.Husleje, amount: -9500_00, cleared: 'reconciled' });
    batch.push({ accountId: accounts.checking, date: `${month}-05`, payeeName: 'Energiselskabet', categoryId: categories['El og varme'], amount: -(1100_00 + Math.floor(r() * 600_00)), cleared: 'reconciled' });
    batch.push({ accountId: accounts.checking, date: `${month}-03`, payeeName: 'Telefonselskabet', categoryId: categories['Internet og mobil'], amount: -549_00, cleared: 'reconciled' });
    // mortgage payment: budget → tracking account transfer, categorised on the budget side
    batch.push({ accountId: accounts.checking, date: `${month}-02`, transferAccountId: accounts.mortgage, categoryId: categories.Realkredit, amount: -4200_00, cleared: 'reconciled' });
    // savings transfer between budget accounts (no category) and credit card payment
    batch.push({ accountId: accounts.checking, date: `${month}-01`, transferAccountId: accounts.savings, amount: -3000_00, cleared: 'reconciled' });
    if (i > 0) batch.push({ accountId: accounts.checking, date: `${month}-10`, transferAccountId: accounts.card, amount: -(800_00 + Math.floor(r() * 400_00)), cleared: 'cleared' });
    if (i % 12 === 5) batch.push({ accountId: accounts.checking, date: `${month}-15`, payeeName: 'Forsikringsselskabet', categoryId: categories.Forsikringer, amount: -10_400_00, cleared: 'reconciled' });
    const n = Math.max(0, opts.txPerMonth - 8);
    for (let k = 0; k < n; k++) {
      const cat = pick(spendCats); const payee = pick(payees[cat]); const amount = -(15_00 + Math.floor(r() * (cat === 'Ferie' ? 3000_00 : 450_00)));
      const acct = r() < 0.2 ? accounts.card : r() < 0.05 ? accounts.cash : accounts.checking;
      if (r() < 0.04) { // split across two categories
        const other = pick(spendCats.filter(c => c !== cat)); const a = Math.floor(amount * 0.7);
        batch.push({ accountId: acct, date: day(month), payeeName: payee, amount, splits: [{ amount: a, categoryId: categories[cat], memo: 'del 1' }, { amount: amount - a, categoryId: categories[other], memo: 'del 2' }], cleared: 'cleared' });
      } else batch.push({ accountId: acct, date: day(month), payeeName: payee, categoryId: categories[cat], amount, cleared: r() < 0.9 ? 'cleared' : 'uncleared', memo: r() < 0.1 ? `Bon ${Math.floor(r() * 9999)}` : '' });
    }
    txCount += batch.length; flush();
    for (const [c, b] of Object.entries(budgets)) svc.setBudget(month, categories[c], { budgeted: b + (r() < 0.15 ? Math.floor(r() * 10) * 50_00 : 0) });
    if (i === 3) svc.setBudget(month, categories.Ferie, { overspending: 'confined' });
    if (i === 9) svc.setBudget(month, categories.Ferie, { overspending: 'affects_buffer' });
  }
  return { accounts, categories, groups, firstMonth: opts.startMonth, lastMonth: addMonths(opts.startMonth, opts.months - 1), txCount };
}

/** Serialise a budget into the native YNAB4 Budget.yfull structure (for import round-trip tests). */
export function toYfull(svc: BudgetService): any {
  const db = svc.db; const major = (n: number) => n / 100;
  const cat = (id: string | null) => (id === 'income:this' ? 'Category/__ImmediateIncome__' : id === 'income:next' ? 'Category/__DeferredIncome__' : id);
  const groups = svc.listGroups(), cats = svc.listCategories(); const payees = svc.listPayees(); const accounts = svc.listAccounts();
  const typeMap: Record<string, string> = { checking: 'Checking', savings: 'Savings', cash: 'Cash', credit_card: 'CreditCard', investment: 'InvestmentAccount', mortgage: 'Mortgage' };
  const rows = db.prepare('SELECT * FROM transactions ORDER BY seq').all() as any[];
  const kids = new Map<string, any[]>(); for (const r of rows) if (r.parent_id) (kids.get(r.parent_id) ?? kids.set(r.parent_id, []).get(r.parent_id)!).push(r);
  const mbs = new Map<string, any[]>();
  for (const b of db.prepare('SELECT * FROM monthly_budgets').all() as any[]) (mbs.get(b.month) ?? mbs.set(b.month, []).get(b.month)!).push({ entityType: 'monthlyCategoryBudget', categoryId: b.category_id, budgeted: major(b.budgeted),
    overspendingHandling: b.overspending === 'confined' ? 'Confined' : b.overspending === 'affects_buffer' ? 'AffectsBuffer' : null, note: b.note || null, entityId: `MCB/${b.month}/${b.category_id}`, parentMonthlyBudgetId: `MB/${b.month}`, entityVersion: 'A-1' });
  return {
    budgetMetaData: { entityType: 'budgetMetaData', currencyLocale: 'da_DK', dateLocale: 'da_DK', budgetType: 'Personal', entityVersion: 'A-0' },
    fileMetaData: { entityType: 'fileMetaData', budgetDataVersion: '4.2', currentKnowledge: 'A-100' },
    accounts: accounts.map((a, i) => ({ entityType: 'account', entityId: a.id, accountName: a.name, accountType: typeMap[a.type] ?? 'Checking', onBudget: a.onBudget, hidden: a.closed, sortableIndex: i, note: a.note || null, entityVersion: 'A-1' })),
    masterCategories: [
      // as in real files: the built-in masters exist but are empty; income/split category ids appear only on transactions
      { entityType: 'masterCategory', entityId: 'MasterCategory/__Internal__', name: '__Internal__', type: 'OUTFLOW', deleteable: false, sortableIndex: -100, subCategories: null },
      { entityType: 'masterCategory', entityId: 'MasterCategory/__Income__', name: 'Income', type: 'INFLOW', deleteable: false, sortableIndex: -99, subCategories: null },
      ...groups.map((g, i) => ({ entityType: 'masterCategory', entityId: g.id, name: g.name, type: 'OUTFLOW', sortableIndex: i * 10, note: g.note || null, entityVersion: 'A-1',
        subCategories: cats.filter(c => c.groupId === g.id && !c.hidden).map((c, j) => ({ entityType: 'category', entityId: c.id, name: c.name, masterCategoryId: g.id, sortableIndex: j * 10, note: c.note || null, entityVersion: 'A-1' })) })),
      { entityType: 'masterCategory', entityId: 'MasterCategory/__Hidden__', name: 'Hidden Categories', type: 'OUTFLOW', sortableIndex: 99999,
        subCategories: cats.filter(c => c.hidden).map((c, j) => ({ entityType: 'category', entityId: c.id, name: `${groups.find(g => g.id === c.groupId)!.name} \` ${c.name} \` ${c.groupId}`, masterCategoryId: 'MasterCategory/__Hidden__', sortableIndex: j })) },
    ],
    payees: [...payees.map(p => ({ entityType: 'payee', entityId: p.id, name: p.name, enabled: true, autoFillCategoryId: cat(p.autoCategoryId), entityVersion: 'A-1' })),
      ...accounts.map(a => ({ entityType: 'payee', entityId: `Payee/Transfer:${a.id}`, name: `Transfer : ${a.name}`, targetAccountId: a.id, enabled: true }))],
    transactions: rows.filter(r => !r.parent_id).map(r => ({ entityType: 'transaction', entityId: r.id, date: r.date, amount: major(r.amount), accountId: r.account_id,
      payeeId: r.transfer_account_id ? `Payee/Transfer:${r.transfer_account_id}` : r.payee_id, categoryId: r.is_split ? 'Category/__Split__' : cat(r.category_id), memo: r.memo || null,
      cleared: r.cleared === 'reconciled' ? 'Reconciled' : r.cleared === 'cleared' ? 'Cleared' : 'Uncleared', accepted: true, flag: r.flag ? r.flag[0].toUpperCase() + r.flag.slice(1) : null,
      targetAccountId: r.transfer_account_id, transferTransactionId: r.transfer_txn_id, entityVersion: 'A-1',
      subTransactions: (kids.get(r.id) ?? []).map(k => ({ entityType: 'subTransaction', entityId: k.id, parentTransactionId: r.id, amount: major(k.amount), categoryId: cat(k.category_id), memo: k.memo || null, targetAccountId: k.transfer_account_id, transferTransactionId: k.transfer_txn_id })) })),
    monthlyBudgets: [...new Set([...mbs.keys(), ...(db.prepare('SELECT month FROM month_notes').all() as any[]).map(x => x.month)])].map(m => [m, mbs.get(m) ?? []] as const).map(([m, list]) => ({ entityType: 'monthlyBudget', entityId: `MB/${m}`, month: `${m}-01`, note: (db.prepare('SELECT note FROM month_notes WHERE month=?').get(m) as any)?.note ?? null, monthlySubCategoryBudgets: list, entityVersion: 'A-1' })),
    scheduledTransactions: svc.listScheduled().map(s => ({ entityType: 'scheduledTransaction', entityId: s.id, date: s.nextDate, frequency: 'Monthly', amount: major(s.amount), accountId: s.accountId, payeeId: s.payeeId, categoryId: cat(s.categoryId), memo: s.memo, targetAccountId: s.transferAccountId })),
  };
}
