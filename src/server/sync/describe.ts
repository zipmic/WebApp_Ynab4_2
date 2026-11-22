/** Turns a stored conflict into something a person can decide on: what was changed, here and on the other computer. */
import type { BudgetService } from '../budgetService.ts';
import { formatMinor } from '../../shared/money.ts';
import { readRow, type Row, type Val } from './capture.ts';
import type { ConflictRecord } from './store.ts';

export interface ConflictView {
  id: number; kind: string; createdAt: string; otherDevice: string; otherAction: string; message: string;
  /** what the decision is about, e.g. "Transaction 14-01-2026 · Grocer · -123,45" */
  items: { what: string; fields: { name: string; mine: string; theirs: string }[] }[];
  /** further rows changed together with these (decided together) */ alsoAffected: number;
}
const FIELD_NAMES: Record<string, string> = {
  amount: 'Amount', date: 'Date', memo: 'Memo', payee_id: 'Payee', category_id: 'Category', account_id: 'Account', cleared: 'Cleared',
  flag: 'Flag', transfer_account_id: 'Transfer account', budgeted: 'Budgeted', overspending: 'Overspending', note: 'Note', name: 'Name',
  hidden: 'Hidden', closed: 'Closed', group_id: 'Group', next_date: 'Next date', frequency: 'Frequency', value: 'Settings', type: 'Type',
  on_budget: 'Budget account', splits: 'Split lines', statement_balance: 'Statement balance',
};
const MONEY = new Set(['amount', 'budgeted', 'statement_balance', 'cleared_before', 'adjustment']);
const REF: Record<string, string> = { payee_id: 'payees', category_id: 'categories', account_id: 'accounts', transfer_account_id: 'accounts', group_id: 'category_groups', auto_category_id: 'categories' };

export function describeConflict(svc: BudgetService, c: ConflictRecord, deviceName: (id: string) => string): ConflictView {
  const fmt = svc.getSettings().format;
  const name = (t: string, id: Val) => (typeof id === 'string' ? String(readRow(svc.db, t, id)?.name ?? '(deleted)') : '—');
  const show = (f: string, v: Val | undefined): string => {
    if (v === undefined) return '—';
    if (v === null) return '—';
    if (MONEY.has(f) && typeof v === 'number') return formatMinor(v, fmt);
    if (REF[f]) return name(REF[f], v);
    if (f === 'hidden' || f === 'closed' || f === 'on_budget') return v ? 'Yes' : 'No';
    return String(v).slice(0, 120);
  };
  const describeRow = (t: string, k: string, row: Row | null): string => {
    if (!row) return t;
    switch (t) {
      case 'transactions': return `Transaction ${row.date} · ${row.transfer_account_id ? 'Transfer: ' + name('accounts', row.transfer_account_id) : name('payees', row.payee_id)} · ${typeof row.amount === 'number' ? formatMinor(row.amount, fmt) : ''}`;
      case 'monthly_budgets': return `Budgeted for ${name('categories', row.category_id)} in ${row.month}`;
      case 'month_notes': return `Note for ${row.month}`;
      case 'accounts': return `Account ${row.name}`;
      case 'categories': return `Category ${row.name}`;
      case 'category_groups': return `Category group ${row.name}`;
      case 'payees': return `Payee ${row.name}`;
      case 'scheduled': return `Scheduled transaction ${name('payees', row.payee_id)} from ${row.next_date}`;
      case 'meta': return 'Budget settings';
      case 'payee_rules': return `Import rule "${row.pattern}"`;
      case 'reconciliations': return `Reconciliation of ${name('accounts', row.account_id)}`;
      default: return `${t} ${k.slice(0, 8)}`;
    }
  };
  const key = (t: string, k: string) => t + '\u0000' + k;
  const items: ConflictView['items'] = [];
  let also = 0;
  for (const r of c.rows) {
    const mine = readRow(svc.db, r.t, r.k);
    const changes = c.op.changes.filter(ch => ch.t === r.t && ch.k === r.k);
    if (!r.fields.length) { also++; continue; }
    let theirsRow: Row | null = mine ?? (c.local[key(r.t, r.k)] ? { ...c.local[key(r.t, r.k)]! } : null);
    let theirsDeleted = false;
    for (const ch of changes) { if (ch.d) { theirsDeleted = true; theirsRow = null; } else if (ch.a) theirsRow = { ...ch.a }; else theirsRow = { ...(theirsRow ?? {}), ...ch.f }; }
    const fields = r.fields.filter(f => !f.startsWith('#')).map(f => (f === 'splits'
      ? { name: 'Split lines', mine: 'Changed on this computer', theirs: 'Changed on the other computer' }
      : { name: FIELD_NAMES[f] ?? f, mine: mine ? show(f, mine[f]) : 'Deleted on this computer', theirs: theirsDeleted ? 'Deleted' : show(f, theirsRow?.[f]) }));
    if (r.fields.includes('splits')) fields.push({ name: 'Split lines', mine: 'Changed on this computer', theirs: 'Changed on the other computer' });
    items.push({ what: describeRow(r.t, r.k, mine ?? theirsRow ?? (c.local[key(r.t, r.k)] as Row | null)), fields: dedupe(fields) });
  }
  if (!items.length) items.push({ what: c.op.label, fields: [] });
  return {
    id: c.id, kind: c.kind, createdAt: c.createdAt, otherDevice: deviceName(c.opDevice), otherAction: c.op.label,
    message: c.kind === 'cannot_apply' ? `The other computer's change could not be applied here: ${c.message}`
      : c.kind === 'deleted_there_changed_here' ? 'The other computer deleted something you changed here.'
      : c.kind === 'changed_there_deleted_here' ? 'The other computer changed something you deleted here.'
      : 'The same thing was changed differently on both computers.',
    items, alsoAffected: also,
  };
}
function dedupe<T extends { name: string }>(xs: T[]): T[] { const seen = new Set<string>(); return xs.filter(x => (seen.has(x.name) ? false : (seen.add(x.name), true))); }
