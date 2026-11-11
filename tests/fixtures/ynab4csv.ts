/** Synthetic YNAB4 CSV exports (Register + Budget), written from a Budget Reborn budget. Test-only. */
import type { BudgetService } from '../../src/server/budgetService.ts';
import { DKK_FORMAT, formatMinor } from '../../src/shared/money.ts';

/** Reproduce YNAB4's export files from a budget, in Danish formatting ("kr1.234,56", "31-12-2024"). */
export function exportYnab4Csv(s: BudgetService, months: { first: string; last: string }) {
  const kr = (n: number) => 'kr' + formatMinor(n, DKK_FORMAT);
  const dk = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  const accounts = new Map(s.listAccounts().map(a => [a.id, a])); const groups = new Map(s.listGroups().map(g => [g.id, g.name]));
  const cats = new Map(s.listCategories().map(c => [c.id, { name: c.name, group: groups.get(c.groupId)! }]));
  cats.set('income:this', { name: 'Available this month', group: 'Income' }); cats.set('income:next', { name: 'Available next month', group: 'Income' });
  const reg: string[][] = [['Account', 'Flag', 'Check Number', 'Date', 'Payee', 'Category', 'Master Category', 'Sub Category', 'Memo', 'Outflow', 'Inflow', 'Cleared', 'Running Balance']];
  for (const a of accounts.values()) {
    let run = 0;
    for (const t of s.listTransactions({ accountId: a.id })) {
      const line = (amount: number, cid: string | null, memo: string, payee: string, running: number) => { const c = cid ? cats.get(cid) : null;
        reg.push([a.name, t.flag ?? '', '', dk(t.date), payee, c ? `${c.group}: ${c.name}` : '', c?.group ?? '', c?.name ?? '', memo, kr(amount < 0 ? -amount : 0), kr(amount > 0 ? amount : 0), t.cleared === 'reconciled' ? 'R' : t.cleared === 'cleared' ? 'C' : 'U', kr(running)]); };
      if (t.splits.length) t.splits.forEach((sp, i) => { run += sp.amount; line(sp.amount, sp.categoryId, `(Split ${i + 1}/${t.splits.length}) ${sp.memo}`, sp.transferAccountId ? `Transfer : ${accounts.get(sp.transferAccountId)!.name}` : t.payeeName, run); });
      else { run += t.amount; line(t.amount, t.categoryId, t.memo, t.payeeName, run); }
    }
  }
  const bud: string[][] = [['Month', 'Category', 'Master Category', 'Sub Category', 'Budgeted', 'Outflows', 'Category Balance']];
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (const r of s.reportBudget(months.first, months.last)) { const c = cats.get(r.categoryId)!; bud.push([`${names[+r.month.slice(5) - 1]} ${r.month.slice(0, 4)}`, `${c.group}: ${c.name}`, c.group, c.name, kr(r.budgeted), kr(-r.activity), kr(r.available)]); }
  // YNAB4 quotes every field
  const q = (rows: string[][]) => rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
  return { register: q(reg), budget: q(bud) };
}
