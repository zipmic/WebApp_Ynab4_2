/**
 * Application service for one budget file. All writes go through `mutate()` which wraps them in a
 * single SQLite transaction and an undo group. Financial rules live in src/shared/engine.ts; this
 * layer validates input, maintains transfer/split integrity and feeds aggregates to the engine.
 */
import { type DB, newId, nowIso } from './db.ts';
import { AppError, bad, conflict, notFound } from './errors.ts';
import { computeBudget, INCOME_NEXT, INCOME_THIS, type EngineResult, type OverspendingHandling } from '../shared/engine.ts';
import { addMonths, isValidISODate, isValidMonth, monthOf, prevMonth, todayISO, type ISODate, type Month } from '../shared/dates.ts';
import { DKK_FORMAT } from '../shared/money.ts';
import { nextOccurrence } from '../shared/schedule.ts';
import { normalizePayee } from '../shared/matching.ts';
import { ACCOUNT_TYPES, FLAGS, FREQUENCIES } from '../shared/types.ts';
import type { Account, AccountType, BudgetMonth, BudgetSettings, Category, CategoryGroup, Cleared, Flag, Frequency, Payee, Scheduled, SubTxn, Txn, TxnChange, TxnInput } from '../shared/types.ts';

interface AccountRow { id: string; name: string; type: AccountType; on_budget: number; closed: number; sort_order: number; note: string }
interface TxRow {
  seq: number; id: string; account_id: string; date: string; payee_id: string | null; category_id: string | null; memo: string;
  amount: number; cleared: Cleared; flag: Flag | null; transfer_account_id: string | null; transfer_txn_id: string | null;
  parent_id: string | null; is_split: number; import_id: string | null; source: string | null;
}
export interface TxnFilter {
  accountId?: string; from?: ISODate; to?: ISODate; categoryId?: string; groupId?: string; payeeId?: string;
  search?: string; uncategorized?: boolean; ids?: string[]; limit?: number; onBudgetOnly?: boolean;
}
export const STARTING_BALANCE_PAYEE = 'Starting Balance';
export const RECONCILE_PAYEE = 'Reconciliation Balance Adjustment';
const DEFAULT_SETTINGS: BudgetSettings = { name: 'My Budget', currency: 'DKK', format: DKK_FORMAT, dateFormat: 'DD-MM-YYYY' };

export class BudgetService {
  version = 0;
  private engineCache: { version: number; result: EngineResult } | null = null;
  private accountsCache: { version: number; list: Account[] } | null = null;
  private inMutation = false;
  /** Revision the caller last saw; when set, the next write fails with 409 STALE unless it is still current. */
  private expected: number | null = null;
  constructor(public readonly db: DB, public readonly id: string) {}

  /** Monotonic revision of this budget, bumped by every committed write (including undo/redo and imports). */
  revision(): number { return (this.db.prepare('SELECT n FROM revision WHERE id=1').get() as { n: number }).n; }
  /** Optimistic concurrency: the next write on this service must find the budget at exactly this revision. */
  expectRevision(rev: number | null) { this.expected = rev; return this; }
  /** Called INSIDE the write transaction: compare-and-increment is atomic with the change itself. */
  private bumpRevision() {
    const want = this.expected; this.expected = null;
    if (want !== null) {
      const cur = this.revision();
      if (cur !== want) throw new AppError(409, 'STALE', 'This budget was changed from another device or window. Your view has been refreshed — check the latest data and repeat your change.', { revision: cur });
    }
    this.db.prepare('UPDATE revision SET n=n+1 WHERE id=1').run();
  }

  // ---------------------------------------------------------------- transactions & undo plumbing
  /** Run a write as one atomic, undoable user action. */
  mutate<T>(label: string, fn: () => T): T {
    if (this.inMutation) return fn();
    this.inMutation = true;
    try {
      const out = this.db.transaction(() => {
        this.bumpRevision();
        const grp = (this.db.prepare('SELECT COALESCE(MAX(grp),0)+1 g FROM undo_groups').get() as { g: number }).g;
        // a new action invalidates the redo stack
        this.db.exec(`DELETE FROM undo_log WHERE grp IN (SELECT grp FROM undo_groups WHERE kind='redo'); DELETE FROM undo_groups WHERE kind='redo'`);
        this.db.prepare('INSERT INTO undo_groups(grp, kind, label, at) VALUES(?,?,?,?)').run(grp, 'undo', label, nowIso());
        this.db.prepare('UPDATE undo_state SET active=1, grp=?').run(grp);
        const r = fn();
        this.db.prepare('UPDATE undo_state SET active=0').run();
        if (!(this.db.prepare('SELECT 1 FROM undo_log WHERE grp=? LIMIT 1').get(grp))) this.db.prepare('DELETE FROM undo_groups WHERE grp=?').run(grp);
        // keep the 200 most recent undo steps
        const cut = this.db.prepare(`SELECT grp FROM undo_groups WHERE kind='undo' ORDER BY grp DESC LIMIT 1 OFFSET 200`).get() as { grp: number } | undefined;
        if (cut) { this.db.prepare('DELETE FROM undo_log WHERE grp<=?').run(cut.grp); this.db.prepare('DELETE FROM undo_groups WHERE grp<=?').run(cut.grp); }
        return r;
      }).immediate();
      this.version++;
      return out;
    } finally { this.inMutation = false; this.expected = null; }
  }
  /** Atomic write without undo recording (bulk imports). Clears undo history since it can no longer be replayed safely. */
  bulk<T>(fn: () => T): T {
    this.inMutation = true;
    try {
      const out = this.db.transaction(() => {
        this.db.exec('UPDATE undo_state SET active=0; DELETE FROM undo_log; DELETE FROM undo_groups;');
        this.bumpRevision();
        return fn();
      }).immediate();
      this.version++;
      return out;
    } finally { this.inMutation = false; this.version++; }
  }
  private replay(kind: 'undo' | 'redo'): string | null {
    const g = this.db.prepare(`SELECT grp, label FROM undo_groups WHERE kind=? ORDER BY grp DESC LIMIT 1`).get(kind) as { grp: number; label: string } | undefined;
    if (!g) { this.expected = null; return null; }
    try { this.db.transaction(() => {
      this.bumpRevision();
      this.db.pragma('defer_foreign_keys = ON');
      const stmts = this.db.prepare('SELECT sql FROM undo_log WHERE grp=? ORDER BY seq DESC').all(g.grp) as { sql: string }[];
      const ng = (this.db.prepare('SELECT COALESCE(MAX(grp),0)+1 g FROM undo_groups').get() as { g: number }).g;
      this.db.prepare('INSERT INTO undo_groups(grp, kind, label, at) VALUES(?,?,?,?)').run(ng, kind === 'undo' ? 'redo' : 'undo', g.label, nowIso());
      this.db.prepare('UPDATE undo_state SET active=1, grp=?').run(ng);
      for (const s of stmts) this.db.exec(s.sql);
      this.db.prepare('UPDATE undo_state SET active=0').run();
      this.db.prepare('DELETE FROM undo_log WHERE grp=?').run(g.grp);
      this.db.prepare('DELETE FROM undo_groups WHERE grp=?').run(g.grp);
    }).immediate(); } finally { this.expected = null; }
    this.version++;
    return g.label;
  }
  undo() { return this.replay('undo'); }
  redo() { return this.replay('redo'); }
  undoStatus() {
    const top = (k: string) => (this.db.prepare(`SELECT label FROM undo_groups WHERE kind=? ORDER BY grp DESC LIMIT 1`).get(k) as { label: string } | undefined)?.label ?? null;
    return { undo: top('undo'), redo: top('redo') };
  }

  // ---------------------------------------------------------------- settings / meta
  getMeta(key: string): string | null { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  getSettings(): BudgetSettings {
    const raw = this.getMeta('settings');
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  }
  updateSettings(patch: Partial<BudgetSettings>) {
    return this.mutate('Change settings', () => { const s = { ...this.getSettings(), ...patch }; this.setMeta('settings', JSON.stringify(s)); return s; });
  }

  // ---------------------------------------------------------------- accounts
  private accountRow(id: string): AccountRow {
    const a = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as AccountRow | undefined;
    if (!a) throw notFound('Account');
    return a;
  }
  listAccounts(): Account[] {
    if (this.accountsCache?.version === this.version) return this.accountsCache.list;
    const sums = new Map((this.db.prepare(`SELECT account_id id, SUM(amount) bal, SUM(CASE WHEN cleared<>'uncleared' THEN amount ELSE 0 END) clr, COUNT(*) n
      FROM transactions WHERE parent_id IS NULL GROUP BY account_id`).all() as { id: string; bal: number; clr: number; n: number }[]).map(r => [r.id, r]));
    const rec = new Map((this.db.prepare('SELECT account_id id, MAX(at) at FROM reconciliations GROUP BY account_id').all() as { id: string; at: string }[]).map(r => [r.id, r.at]));
    const list = (this.db.prepare('SELECT * FROM accounts ORDER BY on_budget DESC, sort_order, name').all() as AccountRow[]).map(a => {
      const s = sums.get(a.id);
      return { id: a.id, name: a.name, type: a.type, onBudget: !!a.on_budget, closed: !!a.closed, sortOrder: a.sort_order, note: a.note,
        balance: s?.bal ?? 0, clearedBalance: s?.clr ?? 0, unclearedBalance: (s?.bal ?? 0) - (s?.clr ?? 0), txCount: s?.n ?? 0, lastReconciledAt: rec.get(a.id) ?? null };
    });
    this.accountsCache = { version: this.version, list };
    return list;
  }
  createAccount(input: { name: string; type: AccountType; onBudget?: boolean; balance?: number; date?: ISODate; note?: string }): string {
    const type = ACCOUNT_TYPES.find(t => t.value === input.type);
    if (!type) throw bad('Unknown account type');
    const name = input.name.trim(); if (!name) throw bad('Account name is required');
    const balance = input.balance ?? 0; assertMoney(balance);
    return this.mutate(`Add account ${name}`, () => {
      if (this.db.prepare('SELECT 1 FROM accounts WHERE name=? COLLATE NOCASE').get(name)) throw conflict('An account with this name already exists');
      const id = newId(); const onBudget = input.onBudget ?? type.defaultOnBudget;
      const order = (this.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM accounts').get() as { n: number }).n;
      this.db.prepare('INSERT INTO accounts(id,name,type,on_budget,sort_order,note) VALUES(?,?,?,?,?,?)').run(id, name, input.type, onBudget ? 1 : 0, order, input.note ?? '');
      if (balance !== 0) {
        // YNAB4: the starting balance of a budget account is income for the month it is dated in.
        this.createTxnInner({ accountId: id, date: input.date ?? todayISO(), payeeName: STARTING_BALANCE_PAYEE, amount: balance,
          categoryId: onBudget ? INCOME_THIS : null, cleared: 'cleared', source: 'starting_balance' }, false);
      }
      return id;
    });
  }
  updateAccount(id: string, patch: { name?: string; type?: AccountType; closed?: boolean; note?: string; sortOrder?: number; onBudget?: boolean }) {
    return this.mutate('Edit account', () => {
      const a = this.accountRow(id);
      if (patch.type && !ACCOUNT_TYPES.some(t => t.value === patch.type)) throw bad('Unknown account type');
      if (patch.onBudget !== undefined && !!a.on_budget !== patch.onBudget) {
        if (this.db.prepare('SELECT 1 FROM transactions WHERE account_id=? OR transfer_account_id=? LIMIT 1').get(id, id))
          throw conflict('An account with transactions cannot be moved between budget and off-budget (as in YNAB4). Create a new account instead.');
      }
      const name = patch.name?.trim();
      if (name !== undefined) {
        if (!name) throw bad('Account name is required');
        if (this.db.prepare('SELECT 1 FROM accounts WHERE name=? COLLATE NOCASE AND id<>?').get(name, id)) throw conflict('An account with this name already exists');
      }
      this.db.prepare('UPDATE accounts SET name=?, type=?, closed=?, note=?, sort_order=?, on_budget=? WHERE id=?')
        .run(name ?? a.name, patch.type ?? a.type, (patch.closed ?? !!a.closed) ? 1 : 0, patch.note ?? a.note, patch.sortOrder ?? a.sort_order, (patch.onBudget ?? !!a.on_budget) ? 1 : 0, id);
    });
  }
  deleteAccount(id: string) {
    return this.mutate('Delete account', () => {
      this.accountRow(id);
      if (this.db.prepare('SELECT 1 FROM transactions WHERE account_id=? OR transfer_account_id=? LIMIT 1').get(id, id))
        throw conflict('This account has transactions. Close it instead of deleting it so history is preserved.');
      this.db.prepare('DELETE FROM scheduled WHERE account_id=? OR transfer_account_id=?').run(id, id);
      this.db.prepare('DELETE FROM reconciliations WHERE account_id=?').run(id);
      this.db.prepare('UPDATE payee_rules SET transfer_account_id=NULL WHERE transfer_account_id=?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    });
  }
  reorderAccounts(ids: string[]) {
    return this.mutate('Reorder accounts', () => { const st = this.db.prepare('UPDATE accounts SET sort_order=? WHERE id=?'); ids.forEach((id, i) => st.run(i, id)); });
  }

  // ---------------------------------------------------------------- categories
  listGroups(): CategoryGroup[] {
    return (this.db.prepare('SELECT * FROM category_groups WHERE system=0 ORDER BY sort_order, name').all() as any[])
      .map(g => ({ id: g.id, name: g.name, sortOrder: g.sort_order, hidden: !!g.hidden, note: g.note }));
  }
  listCategories(): Category[] {
    return (this.db.prepare(`SELECT c.* FROM categories c JOIN category_groups g ON g.id=c.group_id WHERE c.kind='normal' ORDER BY g.sort_order, c.sort_order, c.name`).all() as any[])
      .map(c => ({ id: c.id, groupId: c.group_id, name: c.name, sortOrder: c.sort_order, hidden: !!c.hidden, note: c.note }));
  }
  createGroup(name: string): string {
    name = name.trim(); if (!name) throw bad('Name is required');
    return this.mutate(`Add category group ${name}`, () => {
      const id = newId(); const n = (this.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM category_groups').get() as { n: number }).n;
      this.db.prepare('INSERT INTO category_groups(id,name,sort_order) VALUES(?,?,?)').run(id, name, n); return id;
    });
  }
  updateGroup(id: string, patch: { name?: string; hidden?: boolean; note?: string }) {
    return this.mutate('Edit category group', () => {
      const g = this.db.prepare('SELECT * FROM category_groups WHERE id=? AND system=0').get(id) as any; if (!g) throw notFound('Category group');
      const name = patch.name?.trim(); if (name === '') throw bad('Name is required');
      this.db.prepare('UPDATE category_groups SET name=?, hidden=?, note=? WHERE id=?').run(name ?? g.name, (patch.hidden ?? !!g.hidden) ? 1 : 0, patch.note ?? g.note, id);
    });
  }
  deleteGroup(id: string) {
    return this.mutate('Delete category group', () => {
      if (!this.db.prepare('SELECT 1 FROM category_groups WHERE id=? AND system=0').get(id)) throw notFound('Category group');
      if (this.db.prepare('SELECT 1 FROM categories WHERE group_id=? LIMIT 1').get(id)) throw conflict('Move or delete the categories in this group first.');
      this.db.prepare('DELETE FROM category_groups WHERE id=?').run(id);
    });
  }
  createCategory(groupId: string, name: string): string {
    name = name.trim(); if (!name) throw bad('Name is required');
    return this.mutate(`Add category ${name}`, () => {
      if (!this.db.prepare('SELECT 1 FROM category_groups WHERE id=? AND system=0').get(groupId)) throw notFound('Category group');
      const id = newId(); const n = (this.db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM categories WHERE group_id=?').get(groupId) as { n: number }).n;
      this.db.prepare('INSERT INTO categories(id,group_id,name,sort_order) VALUES(?,?,?,?)').run(id, groupId, name, n); return id;
    });
  }
  private normalCategory(id: string) {
    const c = this.db.prepare(`SELECT * FROM categories WHERE id=? AND kind='normal'`).get(id) as any; if (!c) throw notFound('Category'); return c;
  }
  updateCategory(id: string, patch: { name?: string; hidden?: boolean; note?: string; groupId?: string }) {
    return this.mutate('Edit category', () => {
      const c = this.normalCategory(id);
      const name = patch.name?.trim(); if (name === '') throw bad('Name is required');
      if (patch.groupId && !this.db.prepare('SELECT 1 FROM category_groups WHERE id=? AND system=0').get(patch.groupId)) throw notFound('Category group');
      this.db.prepare('UPDATE categories SET name=?, hidden=?, note=?, group_id=? WHERE id=?').run(name ?? c.name, (patch.hidden ?? !!c.hidden) ? 1 : 0, patch.note ?? c.note, patch.groupId ?? c.group_id, id);
    });
  }
  /** Delete a category. If it is used, its transactions and budget history must be reassigned to another category (as YNAB4 does). */
  deleteCategory(id: string, reassignTo?: string | null) {
    return this.mutate('Delete category', () => {
      this.normalCategory(id);
      const used = this.db.prepare('SELECT 1 FROM transactions WHERE category_id=? LIMIT 1').get(id) || this.db.prepare('SELECT 1 FROM monthly_budgets WHERE category_id=? AND budgeted<>0 LIMIT 1').get(id);
      if (used) {
        if (!reassignTo || reassignTo === id) throw conflict('This category has transactions or budgeted amounts. Choose a category to move them to.', 'CATEGORY_IN_USE');
        this.normalCategory(reassignTo);
        this.db.prepare('UPDATE transactions SET category_id=? WHERE category_id=?').run(reassignTo, id);
        const rows = this.db.prepare('SELECT month, budgeted FROM monthly_budgets WHERE category_id=? AND budgeted<>0').all(id) as { month: string; budgeted: number }[];
        const up = this.db.prepare(`INSERT INTO monthly_budgets(month,category_id,budgeted) VALUES(?,?,?) ON CONFLICT(month,category_id) DO UPDATE SET budgeted=budgeted+excluded.budgeted`);
        for (const r of rows) up.run(r.month, reassignTo, r.budgeted);
      }
      this.db.prepare('DELETE FROM monthly_budgets WHERE category_id=?').run(id);
      this.db.prepare('UPDATE payees SET auto_category_id=NULL WHERE auto_category_id=?').run(id);
      this.db.prepare('UPDATE scheduled SET category_id=NULL WHERE category_id=?').run(id);
      this.db.prepare('UPDATE payee_rules SET category_id=NULL WHERE category_id=?').run(id);
      this.db.prepare('DELETE FROM categories WHERE id=?').run(id);
    });
  }
  /** Persist a full ordering: groups in order, each with its categories in order (categories may move between groups). */
  reorderCategories(order: { groupId: string; categoryIds: string[] }[]) {
    return this.mutate('Reorder categories', () => {
      const g = this.db.prepare('UPDATE category_groups SET sort_order=? WHERE id=? AND system=0');
      const c = this.db.prepare(`UPDATE categories SET sort_order=?, group_id=? WHERE id=? AND kind='normal'`);
      order.forEach((o, i) => { g.run(i, o.groupId); o.categoryIds.forEach((id, j) => c.run(j, o.groupId, id)); });
    });
  }

  // ---------------------------------------------------------------- payees
  listPayees(): Payee[] {
    return (this.db.prepare(`SELECT p.id, p.name, p.auto_category_id, (SELECT COUNT(*) FROM transactions t WHERE t.payee_id=p.id) uses FROM payees p ORDER BY p.name COLLATE NOCASE`).all() as any[])
      .map(p => ({ id: p.id, name: p.name, autoCategoryId: p.auto_category_id, uses: p.uses }));
  }
  ensurePayee(name: string): string {
    name = name.trim().replace(/\s+/g, ' ');
    if (!name) throw bad('Payee name is required');
    const ex = this.db.prepare('SELECT id FROM payees WHERE name=? COLLATE NOCASE').get(name) as { id: string } | undefined;
    if (ex) return ex.id;
    const id = newId();
    this.db.prepare('INSERT INTO payees(id,name,norm) VALUES(?,?,?)').run(id, name, normalizePayee(name));
    return id;
  }
  renamePayee(id: string, name: string) {
    name = name.trim(); if (!name) throw bad('Payee name is required');
    return this.mutate('Rename payee', () => {
      const other = this.db.prepare('SELECT id FROM payees WHERE name=? COLLATE NOCASE AND id<>?').get(name, id) as { id: string } | undefined;
      if (other) { // merge into the existing payee
        this.db.prepare('UPDATE transactions SET payee_id=? WHERE payee_id=?').run(other.id, id);
        this.db.prepare('UPDATE scheduled SET payee_id=? WHERE payee_id=?').run(other.id, id);
        this.db.prepare('DELETE FROM payees WHERE id=?').run(id);
      } else this.db.prepare('UPDATE payees SET name=?, norm=? WHERE id=?').run(name, normalizePayee(name), id);
    });
  }

  // ---------------------------------------------------------------- transactions: read
  listTransactions(f: TxnFilter = {}): Txn[] {
    const where: string[] = ['t.parent_id IS NULL']; const p: unknown[] = [];
    if (f.accountId) { where.push('t.account_id=?'); p.push(f.accountId); }
    if (f.onBudgetOnly) where.push('a.on_budget=1');
    if (f.from) { where.push('t.date>=?'); p.push(f.from); }
    if (f.to) { where.push('t.date<=?'); p.push(f.to); }
    if (f.payeeId) { where.push('t.payee_id=?'); p.push(f.payeeId); }
    if (f.categoryId) { where.push('(t.category_id=? OR EXISTS(SELECT 1 FROM transactions c WHERE c.parent_id=t.id AND c.category_id=?))'); p.push(f.categoryId, f.categoryId); }
    if (f.groupId) {
      where.push(`(t.category_id IN (SELECT id FROM categories WHERE group_id=?) OR EXISTS(SELECT 1 FROM transactions c WHERE c.parent_id=t.id AND c.category_id IN (SELECT id FROM categories WHERE group_id=?)))`);
      p.push(f.groupId, f.groupId);
    }
    if (f.uncategorized) where.push(`a.on_budget=1 AND ((t.is_split=0 AND t.category_id IS NULL AND (t.transfer_account_id IS NULL OR ta.on_budget=0))
      OR EXISTS(SELECT 1 FROM transactions c LEFT JOIN accounts ca ON ca.id=c.transfer_account_id WHERE c.parent_id=t.id AND c.category_id IS NULL AND (c.transfer_account_id IS NULL OR ca.on_budget=0)))`);
    if (f.ids) { if (!f.ids.length) return []; where.push(`t.id IN (${f.ids.map(() => '?').join(',')})`); p.push(...f.ids); }
    if (f.search) {
      const q = `%${f.search.replace(/[%_\\]/g, m => '\\' + m)}%`;
      where.push(`(t.memo LIKE ? ESCAPE '\\' OR py.name LIKE ? ESCAPE '\\' OR ta.name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM transactions c WHERE c.parent_id=t.id AND c.memo LIKE ? ESCAPE '\\')
        OR t.category_id IN (SELECT id FROM categories WHERE name LIKE ? ESCAPE '\\'))`);
      p.push(q, q, q, q, q);
    }
    const rows = this.db.prepare(`SELECT t.*, py.name payee_name, ta.name transfer_name, (o.parent_id IS NOT NULL) far_split
      FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN payees py ON py.id=t.payee_id
      LEFT JOIN accounts ta ON ta.id=t.transfer_account_id LEFT JOIN transactions o ON o.id=t.transfer_txn_id
      WHERE ${where.join(' AND ')} ORDER BY t.date, t.seq ${f.limit ? 'LIMIT ' + Math.floor(f.limit) : ''}`).all(...p) as (TxRow & { payee_name: string | null; transfer_name: string | null; far_split: number })[];
    const splitIds = rows.filter(r => r.is_split).map(r => r.id);
    const kids = new Map<string, SubTxn[]>();
    for (let i = 0; i < splitIds.length; i += 500) {
      const chunk = splitIds.slice(i, i + 500);
      const ks = this.db.prepare(`SELECT * FROM transactions WHERE parent_id IN (${chunk.map(() => '?').join(',')}) ORDER BY seq`).all(...chunk) as TxRow[];
      for (const k of ks) {
        let arr = kids.get(k.parent_id!); if (!arr) kids.set(k.parent_id!, (arr = []));
        arr.push({ id: k.id, amount: k.amount, categoryId: k.category_id, memo: k.memo, transferAccountId: k.transfer_account_id, transferTxnId: k.transfer_txn_id });
      }
    }
    return rows.map(r => ({
      id: r.id, accountId: r.account_id, date: r.date, payeeId: r.payee_id,
      payeeName: r.transfer_account_id ? `Transfer : ${r.transfer_name}` : (r.payee_name ?? ''),
      categoryId: r.category_id, memo: r.memo, amount: r.amount, cleared: r.cleared, flag: r.flag,
      transferAccountId: r.transfer_account_id, transferTxnId: r.transfer_txn_id, splitTransferParent: !!r.far_split,
      splits: kids.get(r.id) ?? [], seq: r.seq, source: r.source,
    }));
  }
  private row(id: string): TxRow {
    const r = this.db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as TxRow | undefined;
    if (!r) throw notFound('Transaction'); return r;
  }
  private change(ids: Iterable<string>, deleted: Iterable<string> = []): TxnChange {
    const del = [...new Set(deleted)]; const set = new Set(ids); for (const d of del) set.delete(d);
    return { changed: this.listTransactions({ ids: [...set] }), deleted: del };
  }

  // ---------------------------------------------------------------- transactions: write
  private insertRow(r: Omit<TxRow, 'seq'>) {
    this.db.prepare(`INSERT INTO transactions(id,account_id,date,payee_id,category_id,memo,amount,cleared,flag,transfer_account_id,transfer_txn_id,parent_id,is_split,import_id,source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, r.account_id, r.date, r.payee_id, r.category_id, r.memo, r.amount, r.cleared, r.flag,
      r.transfer_account_id, r.transfer_txn_id, r.parent_id, r.is_split, r.import_id, r.source, nowIso());
  }
  private checkCategory(id: string | null | undefined): string | null {
    if (!id) return null;
    if (!this.db.prepare('SELECT 1 FROM categories WHERE id=?').get(id)) throw bad('Unknown category');
    return id;
  }
  /**
   * Category rules (YNAB4): tracking-account rows carry no category; a transfer between two budget
   * accounts carries no category; a transfer between a budget and a tracking account is categorised
   * on the budget side. Returns [category for row in `acct`, category for the far side].
   */
  private transferCategories(acct: AccountRow, target: AccountRow | null, categoryId: string | null): [string | null, string | null] {
    if (!target) return [acct.on_budget ? categoryId : null, null];
    if (acct.on_budget && target.on_budget) return [null, null];
    if (acct.on_budget && !target.on_budget) return [categoryId, null];
    if (!acct.on_budget && target.on_budget) return [null, categoryId];
    return [null, null];
  }
  private validateInput(input: TxnInput) {
    if (!isValidISODate(input.date)) throw bad('Invalid date');
    assertMoney(input.amount);
    if (input.flag != null && !FLAGS.includes(input.flag)) throw bad('Invalid flag');
    if (input.cleared && !['uncleared', 'cleared', 'reconciled'].includes(input.cleared)) throw bad('Invalid cleared state');
    if ((input.memo?.length ?? 0) > 2000) throw bad('Memo too long');
    const acct = this.accountRow(input.accountId);
    const target = input.transferAccountId ? this.accountRow(input.transferAccountId) : null;
    if (target && target.id === acct.id) throw bad('A transfer needs two different accounts');
    const splits = input.splits?.length ? input.splits : null;
    if (splits) {
      if (target) throw bad('A split transaction cannot itself be a transfer; make one of the split lines a transfer instead');
      let sum = 0;
      for (const s of splits) {
        assertMoney(s.amount); sum += s.amount;
        if (s.transferAccountId) { const t = this.accountRow(s.transferAccountId); if (t.id === acct.id) throw bad('A transfer needs two different accounts'); }
        this.checkCategory(s.categoryId);
      }
      if (sum !== input.amount) throw bad(`Split lines add up to ${sum} but the transaction total is ${input.amount}`, 'SPLIT_MISMATCH', { sum, amount: input.amount });
    }
    this.checkCategory(input.categoryId);
    return { acct, target, splits };
  }
  /** Inserts a transaction with its transfer counterpart / split children. Returns ids of all top-level rows touched. */
  private createTxnInner(input: TxnInput, remember = true, forcedId?: string, partnerState?: Map<string, { cleared: Cleared }>): string[] {
    const { acct, target, splits } = this.validateInput(input);
    const id = forcedId ?? newId(); const touched = [id];
    const payeeId = target ? null : input.payeeId
      ? ((this.db.prepare('SELECT id FROM payees WHERE id=?').get(input.payeeId) as { id: string } | undefined)?.id ?? null)
      : input.payeeName?.trim() ? this.ensurePayee(input.payeeName) : null;
    const [catHere, catThere] = this.transferCategories(acct, target, splits ? null : input.categoryId ?? null);
    const partnerId = target ? newId() : null;
    this.insertRow({ id, account_id: acct.id, date: input.date, payee_id: target ? null : payeeId, category_id: splits ? null : catHere, memo: input.memo ?? '', amount: input.amount,
      cleared: input.cleared ?? 'uncleared', flag: input.flag ?? null, transfer_account_id: target?.id ?? null, transfer_txn_id: partnerId, parent_id: null,
      is_split: splits ? 1 : 0, import_id: input.importId ?? null, source: input.source ?? null });
    if (target) {
      this.insertRow({ id: partnerId!, account_id: target.id, date: input.date, payee_id: null, category_id: catThere, memo: input.memo ?? '', amount: -input.amount,
        cleared: partnerState?.get(`${target.id}|${-input.amount}`)?.cleared ?? 'uncleared', flag: null, transfer_account_id: acct.id, transfer_txn_id: id, parent_id: null, is_split: 0, import_id: null, source: input.source ?? null });
      touched.push(partnerId!);
    }
    for (const s of splits ?? []) {
      const st = s.transferAccountId ? this.accountRow(s.transferAccountId) : null;
      const cid = newId(), pid = st ? newId() : null;
      const [ch, ct] = this.transferCategories(acct, st, s.categoryId ?? null);
      this.insertRow({ id: cid, account_id: acct.id, date: input.date, payee_id: null, category_id: ch, memo: s.memo ?? '', amount: s.amount, cleared: input.cleared ?? 'uncleared', flag: null,
        transfer_account_id: st?.id ?? null, transfer_txn_id: pid, parent_id: id, is_split: 0, import_id: null, source: null });
      if (st) {
        this.insertRow({ id: pid!, account_id: st.id, date: input.date, payee_id: null, category_id: ct, memo: s.memo ?? '', amount: -s.amount,
          cleared: partnerState?.get(`${st.id}|${-s.amount}`)?.cleared ?? 'uncleared', flag: null, transfer_account_id: acct.id, transfer_txn_id: cid, parent_id: null, is_split: 0, import_id: null, source: null });
        touched.push(pid!);
      }
    }
    if (remember && payeeId && !target && !splits && catHere) this.db.prepare('UPDATE payees SET auto_category_id=? WHERE id=?').run(catHere, payeeId);
    return touched;
  }
  createTransaction(input: TxnInput): TxnChange & { id: string } {
    return this.mutate('Add transaction', () => { const ids = this.createTxnInner(input); return { id: ids[0], ...this.change(ids) }; });
  }
  createTransactions(inputs: TxnInput[], label = 'Add transactions'): TxnChange & { ids: string[] } {
    return this.mutate(label, () => { const all: string[] = [], ids: string[] = []; for (const i of inputs) { const t = this.createTxnInner(i); ids.push(t[0]); all.push(...t); } return { ids, ...this.change(all) }; });
  }
  /** Removes children (and their transfer partners) and this row's own partner. Returns removed top-level ids and the cleared state of removed partners. */
  private detach(r: TxRow, keepPartner: boolean) {
    const removed: string[] = []; const state = new Map<string, { cleared: Cleared }>();
    const kids = this.db.prepare('SELECT * FROM transactions WHERE parent_id=?').all(r.id) as TxRow[];
    const drop = (partnerId: string) => {
      const p = this.db.prepare('SELECT * FROM transactions WHERE id=?').get(partnerId) as TxRow | undefined;
      if (p) { state.set(`${p.account_id}|${p.amount}`, { cleared: p.cleared }); this.db.prepare('DELETE FROM transactions WHERE id=?').run(partnerId); removed.push(partnerId); }
    };
    for (const k of kids) { this.db.prepare('DELETE FROM transactions WHERE id=?').run(k.id); if (k.transfer_txn_id) drop(k.transfer_txn_id); }
    if (r.transfer_txn_id && !keepPartner) drop(r.transfer_txn_id);
    return { removed, state };
  }
  private farSideOfSplit(r: TxRow): boolean {
    if (!r.transfer_txn_id) return false;
    const o = this.db.prepare('SELECT parent_id FROM transactions WHERE id=?').get(r.transfer_txn_id) as { parent_id: string | null } | undefined;
    return !!o?.parent_id;
  }
  updateTransaction(id: string, patch: Partial<TxnInput>, opts: { allowReconciledEdit?: boolean } = {}): TxnChange {
    return this.mutate('Edit transaction', () => this.updateTxnInner(id, patch, opts));
  }
  private updateTxnInner(id: string, patch: Partial<TxnInput>, opts: { allowReconciledEdit?: boolean }): TxnChange {
    const r = this.row(id);
    if (r.parent_id) throw bad('Edit the split transaction this line belongs to');
    const structural = (patch.amount !== undefined && patch.amount !== r.amount) || (patch.date !== undefined && patch.date !== r.date)
      || (patch.accountId !== undefined && patch.accountId !== r.account_id)
      || (patch.transferAccountId !== undefined && (patch.transferAccountId ?? null) !== r.transfer_account_id) || patch.splits !== undefined;
    if (this.farSideOfSplit(r)) {
      if (structural || patch.payeeId !== undefined || patch.payeeName !== undefined)
        throw conflict('This is one side of a transfer inside a split transaction. Change amount, date or accounts from the split transaction in the other account.', 'SPLIT_TRANSFER_SIDE');
      const acct = this.accountRow(r.account_id), other = this.accountRow(r.transfer_account_id!);
      const cat = patch.categoryId !== undefined ? this.transferCategories(acct, other, this.checkCategory(patch.categoryId))[0] : r.category_id;
      this.db.prepare('UPDATE transactions SET memo=?, cleared=?, flag=?, category_id=? WHERE id=?').run(patch.memo ?? r.memo, patch.cleared ?? r.cleared, patch.flag === undefined ? r.flag : patch.flag, cat, id);
      return this.change([id]);
    }
    if (r.cleared === 'reconciled' && structural && !opts.allowReconciledEdit)
      throw conflict('This transaction is reconciled. Changing it will alter a reconciled balance.', 'RECONCILED');
    // Rebuild the full description of the transaction from the stored row + patch.
    const oldKids = this.db.prepare('SELECT * FROM transactions WHERE parent_id=? ORDER BY seq').all(id) as TxRow[];
    let existingCategory = r.category_id;
    if (r.transfer_txn_id && !existingCategory) existingCategory = (this.db.prepare('SELECT category_id c FROM transactions WHERE id=?').get(r.transfer_txn_id) as { c: string | null } | undefined)?.c ?? null;
    const farCat = (k: TxRow) => k.category_id ?? (k.transfer_txn_id ? (this.db.prepare('SELECT category_id c FROM transactions WHERE id=?').get(k.transfer_txn_id) as { c: string | null } | undefined)?.c ?? null : null);
    const transferAccountId = patch.transferAccountId !== undefined ? patch.transferAccountId : (patch.payeeId || patch.payeeName) ? null : r.transfer_account_id;
    const spec: TxnInput = {
      accountId: patch.accountId ?? r.account_id, date: patch.date ?? r.date, amount: patch.amount ?? r.amount, memo: patch.memo ?? r.memo,
      cleared: patch.cleared ?? r.cleared, flag: patch.flag === undefined ? r.flag : patch.flag, transferAccountId,
      payeeId: transferAccountId ? null : patch.payeeName !== undefined ? null : patch.payeeId !== undefined ? patch.payeeId : r.payee_id,
      payeeName: transferAccountId ? null : patch.payeeName,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : existingCategory,
      splits: patch.splits !== undefined ? patch.splits : oldKids.map(k => ({ amount: k.amount, categoryId: farCat(k), memo: k.memo, transferAccountId: k.transfer_account_id })),
      importId: r.import_id, source: r.source,
    };
    if (spec.splits?.length) { spec.categoryId = null; }
    const { acct, target, splits } = this.validateInput(spec);
    const touched = new Set<string>([id]);
    const samePartner = !!r.transfer_txn_id && !!target && target.id === r.transfer_account_id && !splits;
    const { removed, state } = this.detach(r, samePartner);
    const payeeId = target ? null : spec.payeeId ? ((this.db.prepare('SELECT id FROM payees WHERE id=?').get(spec.payeeId) as { id: string } | undefined)?.id ?? null)
      : spec.payeeName?.trim() ? this.ensurePayee(spec.payeeName) : null;
    const [catHere, catThere] = this.transferCategories(acct, target, splits ? null : spec.categoryId ?? null);
    let partnerId: string | null = null;
    if (target) {
      if (samePartner) {
        partnerId = r.transfer_txn_id!;
        this.db.prepare('UPDATE transactions SET date=?, amount=?, category_id=? WHERE id=?').run(spec.date, -spec.amount, catThere, partnerId);
        if (patch.memo !== undefined) this.db.prepare('UPDATE transactions SET memo=? WHERE id=?').run(spec.memo, partnerId);
      } else {
        partnerId = newId();
      }
    }
    // Clear the link first so the CHECK constraints hold while rows are rewritten.
    this.db.prepare(`UPDATE transactions SET account_id=?, date=?, payee_id=?, category_id=?, memo=?, amount=?, cleared=?, flag=?, transfer_account_id=?, transfer_txn_id=?, is_split=? WHERE id=?`)
      .run(acct.id, spec.date, payeeId, splits ? null : catHere, spec.memo ?? '', spec.amount, spec.cleared, spec.flag ?? null, target?.id ?? null, partnerId, splits ? 1 : 0, id);
    if (target && !samePartner) {
      this.insertRow({ id: partnerId!, account_id: target.id, date: spec.date, payee_id: null, category_id: catThere, memo: spec.memo ?? '', amount: -spec.amount,
        cleared: state.get(`${target.id}|${-spec.amount}`)?.cleared ?? 'uncleared', flag: null, transfer_account_id: acct.id, transfer_txn_id: id, parent_id: null, is_split: 0, import_id: null, source: r.source });
    }
    if (partnerId) { touched.add(partnerId); if (samePartner && acct.id !== r.account_id) this.db.prepare('UPDATE transactions SET transfer_account_id=? WHERE id=?').run(acct.id, partnerId); }
    for (const s of splits ?? []) {
      const st = s.transferAccountId ? this.accountRow(s.transferAccountId) : null;
      const cid = newId(), pid = st ? newId() : null;
      const [ch, ct] = this.transferCategories(acct, st, s.categoryId ?? null);
      this.insertRow({ id: cid, account_id: acct.id, date: spec.date, payee_id: null, category_id: ch, memo: s.memo ?? '', amount: s.amount, cleared: spec.cleared!, flag: null,
        transfer_account_id: st?.id ?? null, transfer_txn_id: pid, parent_id: id, is_split: 0, import_id: null, source: null });
      if (st) {
        this.insertRow({ id: pid!, account_id: st.id, date: spec.date, payee_id: null, category_id: ct, memo: s.memo ?? '', amount: -s.amount,
          cleared: state.get(`${st.id}|${-s.amount}`)?.cleared ?? 'uncleared', flag: null, transfer_account_id: acct.id, transfer_txn_id: cid, parent_id: null, is_split: 0, import_id: null, source: null });
        touched.add(pid!);
      }
    }
    if (payeeId && !splits && catHere && (patch.categoryId !== undefined || patch.payeeId !== undefined || patch.payeeName !== undefined))
      this.db.prepare('UPDATE payees SET auto_category_id=? WHERE id=?').run(catHere, payeeId);
    return this.change(touched, removed);
  }
  deleteTransactions(ids: string[]): TxnChange {
    return this.mutate(ids.length === 1 ? 'Delete transaction' : `Delete ${ids.length} transactions`, () => {
      const deleted: string[] = [];
      for (const id of ids) {
        const r = this.db.prepare('SELECT * FROM transactions WHERE id=?').get(id) as TxRow | undefined;
        if (!r) continue; // already removed as the partner of an earlier one
        if (r.parent_id) throw bad('Delete the split transaction this line belongs to');
        if (this.farSideOfSplit(r)) throw conflict('This is one side of a transfer inside a split transaction. Delete or edit the split transaction in the other account.', 'SPLIT_TRANSFER_SIDE');
        deleted.push(...this.detach(r, false).removed, id);
        this.db.prepare('DELETE FROM transactions WHERE id=?').run(id);
      }
      return this.change([], deleted);
    });
  }
  bulkUpdate(ids: string[], patch: { cleared?: Cleared; categoryId?: string | null; flag?: Flag | null; accountId?: string; payeeName?: string }): TxnChange {
    return this.mutate(`Edit ${ids.length} transactions`, () => {
      const changed = new Set<string>(), deleted: string[] = [];
      for (const id of ids) {
        const r = this.row(id);
        const p: Partial<TxnInput> = {};
        if (patch.cleared !== undefined) p.cleared = patch.cleared;
        if (patch.flag !== undefined) p.flag = patch.flag;
        if (patch.categoryId !== undefined && !r.is_split) p.categoryId = patch.categoryId;
        if (patch.accountId !== undefined) p.accountId = patch.accountId;
        if (patch.payeeName !== undefined && !r.transfer_account_id) p.payeeName = patch.payeeName;
        const c = this.updateTxnInner(id, p, { allowReconciledEdit: false });
        c.changed.forEach(t => changed.add(t.id)); deleted.push(...c.deleted);
      }
      return this.change(changed, deleted);
    });
  }
  duplicateTransactions(ids: string[]): TxnChange {
    return this.mutate('Duplicate transaction', () => {
      const out: string[] = [];
      for (const t of this.listTransactions({ ids })) {
        if (t.splitTransferParent) continue;
        let cat = t.categoryId;
        if (t.transferTxnId && !cat) cat = (this.db.prepare('SELECT category_id c FROM transactions WHERE id=?').get(t.transferTxnId) as { c: string | null } | undefined)?.c ?? null;
        out.push(...this.createTxnInner({ accountId: t.accountId, date: t.date, payeeId: t.payeeId, categoryId: cat, memo: t.memo, amount: t.amount, cleared: 'uncleared', flag: t.flag,
          transferAccountId: t.transferAccountId, splits: t.splits.map(s => ({ amount: s.amount, categoryId: s.categoryId, memo: s.memo, transferAccountId: s.transferAccountId })) }, false));
      }
      return this.change(out);
    });
  }

  // ---------------------------------------------------------------- budget
  private engine(through?: Month): EngineResult {
    const need = through ?? addMonths(monthOf(todayISO()), 12);
    if (this.engineCache?.version === this.version && this.engineCache.result.last >= need) return this.engineCache.result;
    const categoryIds = (this.db.prepare(`SELECT id FROM categories WHERE kind='normal'`).all() as { id: string }[]).map(c => c.id);
    const activity = this.db.prepare(`SELECT substr(t.date,1,7) month, t.category_id categoryId, SUM(t.amount) amount
      FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.category_id IS NOT NULL AND a.on_budget=1 GROUP BY 1,2`).all() as { month: string; categoryId: string; amount: number }[];
    const budgets = this.db.prepare('SELECT month, category_id categoryId, budgeted, overspending FROM monthly_budgets').all() as { month: string; categoryId: string; budgeted: number; overspending: OverspendingHandling | null }[];
    const horizon = addMonths(monthOf(todayISO()), 12);
    const result = computeBudget({ categoryIds, activity, budgets, through: need > horizon ? need : horizon });
    this.engineCache = { version: this.version, result };
    return result;
  }
  budgetRange() { const e = this.engine(); return { first: e.first, last: e.last }; }
  getBudget(month: Month): BudgetMonth {
    if (!isValidMonth(month)) throw bad('Invalid month');
    const e = this.engine(month);
    const r = e.months.get(month);
    const notes = new Map((this.db.prepare(`SELECT category_id id, note FROM monthly_budgets WHERE month=? AND note<>''`).all(month) as { id: string; note: string }[]).map(n => [n.id, n.note]));
    const note = (this.db.prepare('SELECT note FROM month_notes WHERE month=?').get(month) as { note: string } | undefined)?.note ?? '';
    const uncategorizedCount = (this.db.prepare(`SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN accounts ta ON ta.id=t.transfer_account_id
      WHERE a.on_budget=1 AND t.is_split=0 AND t.category_id IS NULL AND (t.transfer_account_id IS NULL OR ta.on_budget=0) AND t.date>=? AND t.date<=?`).get(month + '-01', month + '-31') as { n: number }).n;
    const cats = this.listCategories();
    if (!r) return { month, carriedAtb: 0, overspentPrev: 0, income: 0, budgeted: 0, activity: 0, availableToBudget: 0, overspent: 0, totalAvailable: 0, note, uncategorizedCount,
      rows: cats.map(c => ({ categoryId: c.id, budgeted: 0, activity: 0, available: 0, carryIn: 0, handling: 'affects_buffer', handlingExplicit: false, note: notes.get(c.id) ?? '' })) };
    return { month, carriedAtb: r.carriedAtb, overspentPrev: r.overspentPrev, income: r.income, budgeted: r.budgeted, activity: r.activity, availableToBudget: r.availableToBudget,
      overspent: r.overspent, totalAvailable: r.totalAvailable, note, uncategorizedCount,
      rows: cats.map(c => { const m = r.categories.get(c.id)!; return { categoryId: c.id, ...m, note: notes.get(c.id) ?? '' }; }) };
  }
  private upsertBudget(month: Month, categoryId: string, set: { budgeted?: number; overspending?: OverspendingHandling | null; note?: string }) {
    const cur = this.db.prepare('SELECT budgeted, overspending, note FROM monthly_budgets WHERE month=? AND category_id=?').get(month, categoryId) as { budgeted: number; overspending: string | null; note: string } | undefined;
    const next = { budgeted: set.budgeted ?? cur?.budgeted ?? 0, overspending: set.overspending === undefined ? cur?.overspending ?? null : set.overspending, note: set.note ?? cur?.note ?? '' };
    if (next.budgeted === 0 && next.overspending === null && next.note === '') { if (cur) this.db.prepare('DELETE FROM monthly_budgets WHERE month=? AND category_id=?').run(month, categoryId); return; }
    if (cur) this.db.prepare('UPDATE monthly_budgets SET budgeted=?, overspending=?, note=? WHERE month=? AND category_id=?').run(next.budgeted, next.overspending, next.note, month, categoryId);
    else this.db.prepare('INSERT INTO monthly_budgets(month,category_id,budgeted,overspending,note) VALUES(?,?,?,?,?)').run(month, categoryId, next.budgeted, next.overspending, next.note);
  }
  setBudget(month: Month, categoryId: string, set: { budgeted?: number; overspending?: OverspendingHandling | null; note?: string }) {
    if (!isValidMonth(month)) throw bad('Invalid month');
    if (set.budgeted !== undefined) assertMoney(set.budgeted);
    if (set.overspending != null && !['affects_buffer', 'confined'].includes(set.overspending)) throw bad('Invalid overspending handling');
    return this.mutate(set.budgeted !== undefined ? 'Change budgeted amount' : 'Edit budget', () => { this.normalCategory(categoryId); this.upsertBudget(month, categoryId, set); });
  }
  setMonthNote(month: Month, note: string) {
    if (!isValidMonth(month)) throw bad('Invalid month');
    return this.mutate('Edit month note', () => {
      if (note) this.db.prepare('INSERT INTO month_notes(month,note) VALUES(?,?) ON CONFLICT(month) DO UPDATE SET note=excluded.note').run(month, note);
      else this.db.prepare('DELETE FROM month_notes WHERE month=?').run(month);
    });
  }
  /** Move money between two categories in a month by adjusting both budgeted amounts (net zero). */
  moveMoney(month: Month, fromId: string, toId: string, amount: number) {
    assertMoney(amount); if (amount <= 0) throw bad('Amount must be positive'); if (fromId === toId) throw bad('Choose two different categories');
    return this.mutate('Move money', () => {
      this.normalCategory(fromId); this.normalCategory(toId);
      const get = (id: string) => (this.db.prepare('SELECT budgeted FROM monthly_budgets WHERE month=? AND category_id=?').get(month, id) as { budgeted: number } | undefined)?.budgeted ?? 0;
      this.upsertBudget(month, fromId, { budgeted: get(fromId) - amount }); this.upsertBudget(month, toId, { budgeted: get(toId) + amount });
    });
  }
  quickBudget(month: Month, action: 'budgeted_last_month' | 'outflows_last_month' | 'average_outflows_3' | 'average_budgeted_3' | 'balance_to_zero' | 'zero', categoryIds?: string[], onlyEmpty = false) {
    if (!isValidMonth(month)) throw bad('Invalid month');
    return this.mutate('Quick budget', () => {
      const cur = this.getBudget(month);
      const prev = [1, 2, 3].map(n => new Map(this.getBudget(addMonths(month, -n)).rows.map(r => [r.categoryId, r])));
      const hidden = new Set(this.listCategories().filter(c => c.hidden).map(c => c.id));
      const ids = new Set(categoryIds ?? cur.rows.map(r => r.categoryId).filter(id => !hidden.has(id)));
      const avg = (vals: number[]) => { const s = vals.reduce((a, b) => a + b, 0); return Math.sign(s) * Math.round(Math.abs(s) / vals.length); };
      let n = 0;
      for (const r of cur.rows) {
        if (!ids.has(r.categoryId) || (onlyEmpty && r.budgeted !== 0)) continue;
        const p = prev.map(m => m.get(r.categoryId));
        let v: number;
        switch (action) {
          case 'budgeted_last_month': v = p[0]?.budgeted ?? 0; break;
          case 'outflows_last_month': v = Math.max(0, -(p[0]?.activity ?? 0)); break;
          case 'average_outflows_3': v = Math.max(0, avg(p.map(x => -(x?.activity ?? 0)))); break;
          case 'average_budgeted_3': v = avg(p.map(x => x?.budgeted ?? 0)); break;
          case 'balance_to_zero': v = r.budgeted - r.available; break;
          case 'zero': v = 0; break;
          default: throw bad('Unknown quick budget action');
        }
        if (v !== r.budgeted) { this.upsertBudget(month, r.categoryId, { budgeted: v }); n++; }
      }
      return n;
    });
  }

  // ---------------------------------------------------------------- reconciliation
  reconcileInfo(accountId: string, statementBalance?: number) {
    this.accountRow(accountId);
    const a = this.listAccounts().find(x => x.id === accountId)!;
    const history = this.db.prepare('SELECT id, at, statement_balance statementBalance, cleared_before clearedBefore, adjustment, tx_count txCount FROM reconciliations WHERE account_id=? ORDER BY at DESC LIMIT 50').all(accountId);
    const out: any = { clearedBalance: a.clearedBalance, unclearedBalance: a.unclearedBalance, balance: a.balance, history };
    if (statementBalance === undefined) return out;
    assertMoney(statementBalance);
    const diff = statementBalance - a.clearedBalance; // amount missing from the cleared side
    out.difference = diff;
    const hints: { kind: string; message: string; txnIds: string[] }[] = [];
    if (diff !== 0) {
      const top = `parent_id IS NULL AND account_id=?`;
      const ids = (sql: string, ...p: unknown[]) => (this.db.prepare(sql).all(...p) as { id: string }[]).map(r => r.id);
      const unc = ids(`SELECT id FROM transactions WHERE ${top} AND cleared='uncleared' AND amount=? ORDER BY date DESC LIMIT 20`, accountId, diff);
      if (unc.length) hints.push({ kind: 'uncleared_match', message: 'An uncleared transaction equals the difference — it has probably cleared at the bank.', txnIds: unc });
      const clr = ids(`SELECT id FROM transactions WHERE ${top} AND cleared='cleared' AND amount=? ORDER BY date DESC LIMIT 20`, accountId, -diff);
      if (clr.length) hints.push({ kind: 'cleared_by_mistake', message: 'A cleared (not yet reconciled) transaction equals the difference — it may have been cleared by mistake or entered twice.', txnIds: clr });
      if (diff % 2 === 0) {
        const sign = ids(`SELECT id FROM transactions WHERE ${top} AND cleared='cleared' AND amount=? ORDER BY date DESC LIMIT 20`, accountId, -diff / 2);
        if (sign.length) hints.push({ kind: 'wrong_sign', message: 'A cleared transaction is exactly half the difference — it may have been entered as an inflow instead of an outflow (or vice versa).', txnIds: sign });
      }
      if (diff % 9 === 0) hints.push({ kind: 'transposition', message: 'The difference is divisible by 9, which often means two digits were swapped in an amount (e.g. 54 vs 45).', txnIds: [] });
      const dup = this.db.prepare(`SELECT GROUP_CONCAT(id) ids FROM transactions WHERE ${top} AND cleared<>'reconciled' GROUP BY date, amount, COALESCE(payee_id, transfer_account_id, '') HAVING COUNT(*)>1 LIMIT 20`).all(accountId) as { ids: string }[];
      if (dup.length) hints.push({ kind: 'possible_duplicates', message: 'These unreconciled transactions share date, payee and amount and may be duplicates.', txnIds: dup.flatMap(d => d.ids.split(',')) });
      const brokenTransfers = ids(`SELECT t.id FROM transactions t LEFT JOIN transactions o ON o.id=t.transfer_txn_id WHERE t.account_id=? AND t.transfer_txn_id IS NOT NULL AND (o.id IS NULL OR o.amount<>-t.amount OR o.transfer_txn_id<>t.id) LIMIT 20`, accountId);
      if (brokenTransfers.length) hints.push({ kind: 'transfer_mismatch', message: 'These transfers do not match their other side.', txnIds: brokenTransfers });
      const last = (this.db.prepare('SELECT MAX(at) at FROM reconciliations WHERE account_id=?').get(accountId) as { at: string | null }).at;
      if (last) {
        const late = ids(`SELECT id FROM transactions WHERE ${top} AND cleared='reconciled' AND created_at>? LIMIT 20`, accountId, last);
        if (late.length) hints.push({ kind: 'inconsistent_status', message: 'These transactions are marked reconciled but were added after the last reconciliation (e.g. by an import).', txnIds: late });
      }
    }
    out.hints = hints;
    return out;
  }
  /**
   * Finish a reconciliation. Never adjusts silently: if the cleared balance differs from the statement
   * balance the call fails unless `createAdjustment` is explicitly true.
   */
  reconcile(accountId: string, statementBalance: number, createAdjustment = false, date: ISODate = todayISO()) {
    assertMoney(statementBalance);
    return this.mutate('Reconcile account', () => {
      const acct = this.accountRow(accountId);
      const cleared = (this.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE account_id=? AND parent_id IS NULL AND cleared<>'uncleared'`).get(accountId) as { s: number }).s;
      const diff = statementBalance - cleared;
      let adjId: string | null = null; const touched: string[] = [];
      if (diff !== 0) {
        if (!createAdjustment) throw conflict('Cleared balance does not match the statement balance.', 'RECONCILE_MISMATCH', { clearedBalance: cleared, statementBalance, difference: diff });
        adjId = this.createTxnInner({ accountId, date, payeeName: RECONCILE_PAYEE, amount: diff, categoryId: acct.on_budget ? INCOME_THIS : null, cleared: 'cleared',
          memo: 'Entered by reconciliation after explicit confirmation', source: 'reconciliation' }, false)[0];
      }
      const rows = this.db.prepare(`SELECT id FROM transactions WHERE account_id=? AND cleared='cleared'`).all(accountId) as { id: string }[];
      this.db.prepare(`UPDATE transactions SET cleared='reconciled' WHERE account_id=? AND cleared='cleared'`).run(accountId);
      this.db.prepare('INSERT INTO reconciliations(id,account_id,at,statement_balance,cleared_before,adjustment,adjustment_txn_id,tx_count) VALUES(?,?,?,?,?,?,?,?)')
        .run(newId(), accountId, nowIso(), statementBalance, cleared, diff, adjId, rows.length);
      touched.push(...rows.map(r => r.id));
      return { adjustment: diff, reconciledCount: rows.length, ...this.change((this.db.prepare(`SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?)) AND parent_id IS NULL`).all(JSON.stringify(touched)) as { id: string }[]).map(r => r.id)) };
    });
  }

  // ---------------------------------------------------------------- scheduled transactions
  listScheduled(): Scheduled[] {
    return (this.db.prepare(`SELECT s.*, p.name payee_name, ta.name transfer_name FROM scheduled s LEFT JOIN payees p ON p.id=s.payee_id LEFT JOIN accounts ta ON ta.id=s.transfer_account_id ORDER BY s.next_date`).all() as any[])
      .map(s => ({ id: s.id, accountId: s.account_id, nextDate: s.next_date, frequency: s.frequency, payeeId: s.payee_id,
        payeeName: s.transfer_account_id ? `Transfer : ${s.transfer_name}` : s.payee_name ?? '', categoryId: s.category_id, memo: s.memo, amount: s.amount, flag: s.flag,
        transferAccountId: s.transfer_account_id, splits: JSON.parse(s.splits) }));
  }
  saveScheduled(input: Omit<Scheduled, 'id' | 'payeeName' | 'payeeId'> & { id?: string; payeeName?: string | null; payeeId?: string | null }): string {
    if (!FREQUENCIES.some(f => f.value === input.frequency)) throw bad('Unknown frequency');
    if (!isValidISODate(input.nextDate)) throw bad('Invalid date');
    return this.mutate('Save scheduled transaction', () => {
      this.validateInput({ accountId: input.accountId, date: input.nextDate, amount: input.amount, categoryId: input.categoryId, transferAccountId: input.transferAccountId, splits: input.splits, flag: input.flag });
      const payeeId = input.transferAccountId ? null : input.payeeName?.trim() ? this.ensurePayee(input.payeeName) : input.payeeId ?? null;
      const id = input.id ?? newId();
      if (input.id && !this.db.prepare('SELECT 1 FROM scheduled WHERE id=?').get(id)) throw notFound('Scheduled transaction');
      const args = [input.accountId, input.nextDate, input.frequency, Number(input.nextDate.slice(8, 10)), payeeId, input.splits?.length ? null : input.categoryId ?? null, input.memo ?? '', input.amount, input.flag ?? null,
        input.transferAccountId ?? null, JSON.stringify(input.splits ?? [])];
      if (input.id) this.db.prepare('UPDATE scheduled SET account_id=?, next_date=?, frequency=?, anchor_day=?, payee_id=?, category_id=?, memo=?, amount=?, flag=?, transfer_account_id=?, splits=? WHERE id=?').run(...args, id);
      else this.db.prepare('INSERT INTO scheduled(account_id,next_date,frequency,anchor_day,payee_id,category_id,memo,amount,flag,transfer_account_id,splits,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...args, id);
      return id;
    });
  }
  deleteScheduled(id: string) { return this.mutate('Delete scheduled transaction', () => { this.db.prepare('DELETE FROM scheduled WHERE id=?').run(id); }); }
  /** Enter all scheduled transactions that are due (date <= today), advancing each schedule. `onlyId` enters one occurrence now regardless of date. */
  postScheduled(today: ISODate = todayISO(), onlyId?: string): TxnChange & { posted: number } {
    const due = (this.db.prepare(onlyId ? 'SELECT * FROM scheduled WHERE id=?' : 'SELECT * FROM scheduled WHERE next_date<=?').all(onlyId ?? today)) as any[];
    if (!due.length) return { posted: 0, changed: [], deleted: [] };
    return this.mutate('Enter scheduled transactions', () => {
      const ids: string[] = []; let posted = 0;
      for (const s of due) {
        let date: string | null = s.next_date, guard = 0;
        do {
          ids.push(...this.createTxnInner({ accountId: s.account_id, date: date!, payeeId: s.payee_id, categoryId: s.category_id, memo: s.memo, amount: s.amount, flag: s.flag,
            transferAccountId: s.transfer_account_id, splits: JSON.parse(s.splits), source: 'scheduled' }, false));
          posted++;
          date = nextOccurrence(date!, s.frequency as Frequency, s.anchor_day ?? undefined);
        } while (!onlyId && date && date <= today && ++guard < 400);
        if (date) this.db.prepare('UPDATE scheduled SET next_date=? WHERE id=?').run(date, s.id);
        else this.db.prepare('DELETE FROM scheduled WHERE id=?').run(s.id);
      }
      return { posted, ...this.change(ids) };
    });
  }

  // ---------------------------------------------------------------- reports (all derived from real transactions)
  reportActivity(f: { from: ISODate; to: ISODate; accountIds?: string[]; categoryIds?: string[] }) {
    const where = ['t.category_id IS NOT NULL', 'a.on_budget=1', 't.date>=?', 't.date<=?']; const p: unknown[] = [f.from, f.to];
    if (f.accountIds?.length) { where.push(`t.account_id IN (${f.accountIds.map(() => '?').join(',')})`); p.push(...f.accountIds); }
    if (f.categoryIds?.length) { where.push(`t.category_id IN (${f.categoryIds.map(() => '?').join(',')})`); p.push(...f.categoryIds); }
    return this.db.prepare(`SELECT substr(t.date,1,7) month, t.category_id categoryId, SUM(t.amount) amount, COUNT(*) count
      FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE ${where.join(' AND ')} GROUP BY 1,2 ORDER BY 1`).all(...p) as { month: string; categoryId: string; amount: number; count: number }[];
  }
  reportBalances() {
    return this.db.prepare(`SELECT account_id accountId, substr(date,1,7) month, SUM(amount) amount FROM transactions WHERE parent_id IS NULL GROUP BY 1,2 ORDER BY 2`).all() as { accountId: string; month: string; amount: number }[];
  }
  reportBudget(from: Month, to: Month) {
    if (!isValidMonth(from) || !isValidMonth(to) || to < from) throw bad('Invalid month range');
    const e = this.engine(to); const out: { month: string; categoryId: string; budgeted: number; activity: number; available: number }[] = [];
    for (let m = from; m <= to; m = addMonths(m, 1)) { const r = e.months.get(m); if (!r) continue; for (const [id, c] of r.categories) if (c.budgeted || c.activity || c.available) out.push({ month: m, categoryId: id, budgeted: c.budgeted, activity: c.activity, available: c.available }); }
    return out;
  }

  // ---------------------------------------------------------------- integrity
  /** Verifies structural and financial invariants. Returns human-readable problems (empty = consistent). */
  checkIntegrity(): string[] {
    const problems: string[] = [];
    const q = (sql: string) => this.db.prepare(sql).all() as any[];
    for (const r of q(`SELECT t.id FROM transactions t LEFT JOIN transactions o ON o.id=t.transfer_txn_id WHERE t.transfer_txn_id IS NOT NULL AND
      (o.id IS NULL OR o.transfer_txn_id IS NOT t.id OR o.amount<>-t.amount OR o.account_id<>t.transfer_account_id OR o.transfer_account_id<>t.account_id OR o.date<>t.date)`))
      problems.push(`Transfer ${r.id} does not match its other side`);
    for (const r of q(`SELECT p.id, p.amount, (SELECT COALESCE(SUM(amount),0) FROM transactions c WHERE c.parent_id=p.id) s FROM transactions p WHERE p.is_split=1`))
      if (r.amount !== r.s) problems.push(`Split ${r.id}: lines add up to ${r.s}, total is ${r.amount}`);
    for (const r of q(`SELECT c.id FROM transactions c JOIN transactions p ON p.id=c.parent_id WHERE c.account_id<>p.account_id OR c.date<>p.date`)) problems.push(`Split line ${r.id} differs from its parent in account or date`);
    for (const r of q(`SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.on_budget=0 AND t.category_id IS NOT NULL`)) problems.push(`Off-budget transaction ${r.id} has a category`);
    for (const r of q(`SELECT t.id FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN accounts b ON b.id=t.transfer_account_id WHERE a.on_budget=1 AND b.on_budget=1 AND t.category_id IS NOT NULL`))
      problems.push(`Transfer ${r.id} between budget accounts has a category`);
    if ((this.db.pragma('foreign_key_check') as unknown[]).length) problems.push('Foreign key violations found');
    const transfers = q(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE transfer_txn_id IS NOT NULL`)[0].s;
    if (transfers !== 0) problems.push(`Transfers do not net to zero (off by ${transfers})`);
    // Budget identity for every month: categorised budget cash == ATB + Σ category balances
    const e = this.engine();
    const cash = new Map(q(`SELECT substr(t.date,1,7) m, SUM(CASE WHEN t.category_id='${INCOME_NEXT}' THEN 0 ELSE t.amount END) now, SUM(CASE WHEN t.category_id='${INCOME_NEXT}' THEN t.amount ELSE 0 END) next
      FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN categories c ON c.id=t.category_id WHERE a.on_budget=1 GROUP BY 1`).map(r => [r.m, r]));
    let running = 0;
    for (const [m, r] of e.months) {
      running += (cash.get(m)?.now ?? 0) + (cash.get(prevMonth(m))?.next ?? 0);
      if (r.availableToBudget + r.totalAvailable !== running) { problems.push(`Budget identity broken in ${m}: ATB+balances=${r.availableToBudget + r.totalAvailable}, budget cash=${running}`); break; }
    }
    return problems;
  }
}

export function assertMoney(n: unknown): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || Math.abs(n) > 1e13) throw new AppError(400, 'BAD_AMOUNT', 'Amounts must be whole minor units (øre)');
}
