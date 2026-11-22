/**
 * Change capture for file-based sync.
 *
 * Triggers on every table that holds primary budget data record each row change (before/after image) into
 * `sync_changes` while capture is switched on. At the end of every write transaction (`BudgetService.mutate`,
 * `bulk`, undo/redo) the recorded changes are sealed into ONE operation in `sync_outbox` — in the same SQLite
 * transaction as the change itself, so an operation exists if and only if the change was committed.
 *
 * Only primary data is synchronised. Derived values (balances, Available, Available to Budget …) are always
 * recomputed by src/shared/engine.ts from this data, so every device computes identical numbers.
 */
import type { DB } from '../db.ts';

export type Val = string | number | null;
export type Row = Record<string, Val>;
export interface Change {
  /** table */ t: string;
  /** primary key: the id, or a JSON array for composite keys */ k: string;
  /** full row: an insert (or, in a conflict resolution, "make the row exactly this") */ a?: Row;
  /** changed fields of an update */ f?: Row;
  /** the values those fields (or the deleted row) had before, for display and diagnostics */ b?: Row | null;
  /** row deleted */ d?: 1;
  /** with `a`: only make sure the row exists (insert it if missing, never change an existing one) */ e?: 1;
}
export interface Op {
  id: string; dev: string; seq: number;
  /** version vector: for every other device, the highest of its operations this one had processed */
  deps: Record<string, number>;
  at: string; label: string; schema: number; changes: Change[];
  /** set on operations that resolve conflicts */ resolves?: string[];
}

interface TableSpec { key: string[]; exclude: string[]; lww: string[]; linked?: string[][] }
/**
 * Tables with primary data. `exclude`: device-local columns (never synchronised). `lww`: bookkeeping columns where
 * two devices changing them at the same time is not worth asking the user about (sort order, "last category used",
 * a usage counter, a creation timestamp); a deterministic rule picks the same winner on every device.
 * `linked`: fields that only make sense together; independent changes to different fields of one group conflict.
 */
export const SYNC_TABLES: Record<string, TableSpec> = {
  meta: { key: ['key'], exclude: [], lww: [] },
  accounts: { key: ['id'], exclude: [], lww: ['sort_order'] },
  category_groups: { key: ['id'], exclude: [], lww: ['sort_order'] },
  categories: { key: ['id'], exclude: [], lww: ['sort_order'] },
  payees: { key: ['id'], exclude: [], lww: ['auto_category_id'] },
  // amount, cleared/reconciled state and account together make up a reconciled balance: changing one of them on
  // one computer while another computer changes a different one of them is a conflict, not a merge
  transactions: { key: ['id'], exclude: ['seq'], lww: ['created_at'], linked: [['amount', 'cleared', 'account_id']] },
  monthly_budgets: { key: ['month', 'category_id'], exclude: [], lww: [] },
  month_notes: { key: ['month'], exclude: [], lww: [] },
  scheduled: { key: ['id'], exclude: [], lww: [] },
  reconciliations: { key: ['id'], exclude: [], lww: [] },
  imports: { key: ['id'], exclude: [], lww: [] },
  payee_rules: { key: ['id'], exclude: [], lww: ['uses'] },
};
/** Parents before children: inserts run in this order, deletes in reverse (foreign keys are checked immediately). */
export const TABLE_ORDER = ['meta', 'accounts', 'category_groups', 'categories', 'payees', 'transactions', 'monthly_budgets', 'month_notes', 'scheduled', 'reconciliations', 'imports', 'payee_rules'];

const columnCache = new WeakMap<DB, Map<string, string[]>>();
/** Synchronised columns of a table, as the database actually has them. */
export function syncColumns(db: DB, table: string): string[] {
  let m = columnCache.get(db); if (!m) { m = new Map(); columnCache.set(db, m); }
  let cols = m.get(table);
  if (!cols) {
    const spec = SYNC_TABLES[table]; if (!spec) throw new Error('not a synchronised table');
    cols = (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name).filter(c => !spec.exclude.includes(c));
    m.set(table, cols);
  }
  return cols;
}
export const hasSyncSchema = (db: DB) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_ctl'`).get();
export const captureOn = (db: DB) => (db.prepare('SELECT capture FROM sync_ctl WHERE id=1').get() as { capture: number } | undefined)?.capture === 1;
export const setCapture = (db: DB, on: boolean) => { db.prepare('UPDATE sync_ctl SET capture=? WHERE id=1').run(on ? 1 : 0); };

/** (Re)creates the capture triggers. Idempotent; regenerated on open so they always follow the current columns. */
export function installSyncTriggers(db: DB) {
  if (!hasSyncSchema(db)) return;
  db.transaction(() => {
    for (const t of Object.keys(SYNC_TABLES)) {
      const spec = SYNC_TABLES[t]; const cols = syncColumns(db, t);
      const K = (r: string) => (spec.key.length === 1 ? `${r}.${spec.key[0]}` : `json_array(${spec.key.map(k => `${r}.${k}`).join(',')})`);
      const J = (r: string) => `json_object(${cols.map(c => `'${c}',${r}.${c}`).join(',')})`;
      const when = 'WHEN (SELECT capture FROM sync_ctl) = 1';
      db.exec(`DROP TRIGGER IF EXISTS _sync_${t}_i; DROP TRIGGER IF EXISTS _sync_${t}_u; DROP TRIGGER IF EXISTS _sync_${t}_d;`);
      db.exec(`CREATE TRIGGER _sync_${t}_i AFTER INSERT ON ${t} ${when} BEGIN
        INSERT INTO sync_changes(tbl,pk,before,after) VALUES('${t}', ${K('NEW')}, NULL, ${J('NEW')}); END;`);
      db.exec(`CREATE TRIGGER _sync_${t}_u AFTER UPDATE ON ${t} ${when} BEGIN
        INSERT INTO sync_changes(tbl,pk,before,after) SELECT '${t}', ${K('OLD')}, ${J('OLD')}, NULL WHERE ${K('OLD')} IS NOT ${K('NEW')};
        INSERT INTO sync_changes(tbl,pk,before,after) SELECT '${t}', ${K('NEW')}, CASE WHEN ${K('OLD')} IS ${K('NEW')} THEN ${J('OLD')} END, ${J('NEW')}
          WHERE ${K('OLD')} IS NOT ${K('NEW')} OR ${J('OLD')} IS NOT ${J('NEW')}; END;`);
      db.exec(`CREATE TRIGGER _sync_${t}_d AFTER DELETE ON ${t} ${when} BEGIN
        INSERT INTO sync_changes(tbl,pk,before,after) VALUES('${t}', ${K('OLD')}, ${J('OLD')}, NULL); END;`);
    }
  })();
}

// ------------------------------------------------------------------ row access by key
const keyWhere = (t: string) => SYNC_TABLES[t].key.map(k => `${k}=?`).join(' AND ');
export const keyArgs = (t: string, k: string): Val[] => (SYNC_TABLES[t].key.length === 1 ? [k] : (JSON.parse(k) as Val[]));
export function keyOf(t: string, row: Row): string {
  const spec = SYNC_TABLES[t];
  return spec.key.length === 1 ? String(row[spec.key[0]]) : JSON.stringify(spec.key.map(c => row[c]));
}
export function readRow(db: DB, t: string, k: string): Row | null {
  const cols = syncColumns(db, t);
  return (db.prepare(`SELECT ${cols.join(',')} FROM ${t} WHERE ${keyWhere(t)}`).get(...keyArgs(t, k)) as Row | undefined) ?? null;
}
export function insertRow(db: DB, t: string, row: Row) {
  // only the columns the row carries: a column added by a later version keeps its default
  const cols = syncColumns(db, t).filter(c => c in row);
  db.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c] ?? null));
}
export function updateRow(db: DB, t: string, k: string, fields: Row) {
  const f = Object.keys(fields); if (!f.length) return;
  db.prepare(`UPDATE ${t} SET ${f.map(c => `${c}=?`).join(',')} WHERE ${keyWhere(t)}`).run(...f.map(c => fields[c]), ...keyArgs(t, k));
}
export function deleteRow(db: DB, t: string, k: string) { db.prepare(`DELETE FROM ${t} WHERE ${keyWhere(t)}`).run(...keyArgs(t, k)); }

/** Sort changes so that they can be applied with immediate foreign-key checks: parents first, deletes children first. */
export function orderChanges(changes: Change[]): Change[] {
  const rank = (c: Change) => TABLE_ORDER.indexOf(c.t);
  const child = (c: Change) => (c.t === 'transactions' ? ((c.a ?? c.b ?? {}).parent_id ? 1 : 0) : 0);
  const ups = changes.filter(c => !c.d).sort((x, y) => rank(x) - rank(y) || child(x) - child(y));
  const dels = changes.filter(c => c.d).sort((x, y) => rank(y) - rank(x) || child(y) - child(x));
  return [...ups, ...dels];
}

/**
 * Turns the captured row changes of the current transaction into a list of changes, one per row (several edits of
 * the same row inside one action are merged), and clears the capture table. Must run inside the write transaction.
 */
export function drainChanges(db: DB): Change[] {
  const rows = db.prepare('SELECT tbl, pk, before, after FROM sync_changes ORDER BY seq').all() as { tbl: string; pk: string; before: string | null; after: string | null }[];
  if (!rows.length) return [];
  db.prepare('DELETE FROM sync_changes').run();
  const byKey = new Map<string, { t: string; k: string; before: string | null; after: string | null }>();
  for (const r of rows) {
    const id = r.tbl + '\u0000' + r.pk; const ex = byKey.get(id);
    if (ex) ex.after = r.after; else byKey.set(id, { t: r.tbl, k: r.pk, before: r.before, after: r.after });
  }
  const out: Change[] = [];
  for (const { t, k, before, after } of byKey.values()) {
    if (before === after) continue;
    const b = before === null ? null : (JSON.parse(before) as Row), a = after === null ? null : (JSON.parse(after) as Row);
    if (!b && !a) continue;
    if (!a) out.push({ t, k, d: 1, b });
    else if (!b) out.push({ t, k, a });
    else {
      const f: Row = {}, prev: Row = {};
      for (const c of Object.keys(a)) if (a[c] !== b[c]) { f[c] = a[c]; prev[c] = b[c]; }
      if (Object.keys(f).length) out.push({ t, k, f, b: prev });
    }
  }
  return out;
}
