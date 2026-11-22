/**
 * Database side of file-based sync (no file access here — see folder.ts / manager.ts).
 *
 * Model
 * - Every device has a permanent id and numbers its own operations 1, 2, 3 … An operation (`Op`) is the set of row
 *   changes of one committed user action. It carries a version vector (`deps`) of everything its device had
 *   processed when it was made, so every device can tell whether two operations were made independently.
 * - An incoming operation is applied only after everything it depends on (causal order), exactly once (the version
 *   vector `sync_vv` records what has been processed), and atomically (one SQLite transaction).
 * - For every field we remember which operation wrote it last (`sync_writers`). An incoming change to a field is
 *   applied when that writer is in the incoming operation's history. If the field was changed independently on this
 *   device to a different value, nothing is overwritten: the whole operation becomes a conflict for the user, both
 *   versions are kept, and the other device detects the same conflict. Equal values are never a conflict.
 * - A resolution is a new operation that writes the chosen rows with a history covering both versions, so it is
 *   applied everywhere and closes the matching conflict on every device.
 */
import { BUDGET_SCHEMA_VERSION, type DB, nowIso } from '../db.ts';
import { AppError } from '../errors.ts';
import type { BudgetService } from '../budgetService.ts';
import { type Change, deleteRow, type Val, drainChanges, insertRow, keyOf, type Op, orderChanges, readRow, type Row, setCapture, SYNC_TABLES, syncColumns, TABLE_ORDER, updateRow } from './capture.ts';

export const SYNC_PROTOCOL = 1;
export const DEVICE_RE = /^[0-9a-f]{32}$/;
/** an operation that wrote a field; `v`: the value it wrote (kept only for last-writer-wins columns) */
interface Writer { dev: string; seq: number; v?: Val }
/** A row involved in a conflict; `fields` lists the fields that were changed differently on both sides (empty: the row is involved only because one side changed it together with a conflicting row). */
export interface ConflictRow { t: string; k: string; fields: string[] }
export interface ConflictRecord {
  id: number; opDevice: string; opSeq: number; kind: string; rows: ConflictRow[]; op: Op; local: Record<string, Row | null>;
  message: string; createdAt: string; resolvedAt: string | null; resolution: string | null;
}
export interface Snapshot {
  vv: Record<string, number>; tables: Record<string, Row[]>;
  writers: [string, string, string, string][]; oplog: [string, number, string, string][];
}
class Conflicting extends Error { constructor(public kind: string, public rows: ConflictRow[], public against: Writer[], message = '') { super(message || kind); } }
const rowKey = (t: string, k: string) => t + '\u0000' + k;
/** foreign keys of the synchronised tables: column → referenced table */
const REFERENCES: Record<string, [string, string][]> = {
  categories: [['group_id', 'category_groups']], payees: [['auto_category_id', 'categories']],
  transactions: [['account_id', 'accounts'], ['payee_id', 'payees'], ['category_id', 'categories'], ['transfer_account_id', 'accounts'], ['parent_id', 'transactions']],
  monthly_budgets: [['category_id', 'categories']], scheduled: [['account_id', 'accounts'], ['payee_id', 'payees'], ['category_id', 'categories'], ['transfer_account_id', 'accounts']],
  reconciliations: [['account_id', 'accounts']], payee_rules: [['category_id', 'categories'], ['transfer_account_id', 'accounts']],
};
/** tables whose rows other rows refer to */
const REFERENCED = new Set(['accounts', 'category_groups', 'categories', 'payees']);
/** pseudo-field: the set of lines of a split transaction */
const CHILDREN = '#children';

export class SyncStore {
  constructor(public readonly svc: BudgetService, public readonly device: string) {}
  get db(): DB { return this.svc.db; }

  // ------------------------------------------------------------------ state
  get(key: string): string | null { return (this.db.prepare('SELECT value FROM sync_state WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null; }
  set(key: string, value: string | null) {
    if (value === null) this.db.prepare('DELETE FROM sync_state WHERE key=?').run(key);
    else this.db.prepare('INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  /** The folder this budget synchronises with, or null for a budget that only lives on this device. */
  folder(): string | null { return this.get('folder'); }
  vv(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT device, seq FROM sync_vv').all() as { device: string; seq: number }[]) out[r.device] = r.seq;
    return out;
  }
  ownSeq(): number { return this.vv()[this.device] ?? 0; }
  /** Makes this budget a synchronised one: from now on every committed change becomes an operation. */
  enable(folder: string, budgetId: string) {
    this.db.transaction(() => {
      this.set('folder', folder); this.set('budget_id', budgetId); this.set('device', this.device);
      this.db.prepare('DELETE FROM sync_changes').run(); setCapture(this.db, true);
    })();
  }
  /**
   * Forget everything about synchronisation (the budget becomes local-only, all data stays). Used for restored
   * backups and copies, which must never continue another budget's history.
   */
  reset() {
    this.db.transaction(() => {
      setCapture(this.db, false);
      this.db.exec('DELETE FROM sync_state; DELETE FROM sync_changes; DELETE FROM sync_outbox; DELETE FROM sync_vv; DELETE FROM sync_oplog; DELETE FROM sync_writers; DELETE FROM sync_conflicts;');
    })();
  }

  // ------------------------------------------------------------------ writers (who wrote a field last)
  // For every field we keep the set of operations that wrote it last: normally one, several when devices wrote it
  // independently (with the same value, or for last-writer-wins columns). Field '' stands for the row as a whole
  // (created, replaced or deleted); a field without its own entry falls back to it.
  private writers(t: string, k: string): Map<string, Writer[]> {
    return new Map((this.db.prepare('SELECT field, ws FROM sync_writers WHERE tbl=? AND pk=?').all(t, k) as { field: string; ws: string }[])
      .map(r => [r.field, (JSON.parse(r.ws) as [string, number, Val?][]).map(([dev, seq, v]) => (v === undefined ? { dev, seq } : { dev, seq, v }))]));
  }
  private setField(t: string, k: string, f: string, ws: Writer[]) {
    this.db.prepare('INSERT INTO sync_writers(tbl,pk,field,ws) VALUES(?,?,?,?) ON CONFLICT(tbl,pk,field) DO UPDATE SET ws=excluded.ws')
      .run(t, k, f, JSON.stringify(ws.map(w => (w.v === undefined ? [w.dev, w.seq] : [w.dev, w.seq, w.v]))));
  }
  /** The row as a whole was created, replaced or deleted. */
  private rowWriters(t: string, k: string, ws: Writer[]) {
    this.db.prepare('DELETE FROM sync_writers WHERE tbl=? AND pk=?').run(t, k);
    this.setField(t, k, '', ws);
  }
  private depsOf(w: Writer): Record<string, number> {
    const r = this.db.prepare('SELECT deps FROM sync_oplog WHERE device=? AND seq=?').get(w.dev, w.seq) as { deps: string } | undefined;
    return r ? JSON.parse(r.deps) : {};
  }
  /** Did the operation `w` know about operation `x` when it was made? */
  private sees(w: Writer, x: Writer): boolean { return w.dev === x.dev ? w.seq >= x.seq : (this.depsOf(w)[x.dev] ?? 0) >= x.seq; }
  /** Deterministic order for independent operations (used only for last-writer-wins columns). */
  private static later(a: Writer, b: Writer) { return a.dev === b.dev ? a.seq > b.seq : a.dev > b.dev; }

  private processed(op: Op) {
    this.db.prepare('INSERT INTO sync_vv(device,seq) VALUES(?,?) ON CONFLICT(device) DO UPDATE SET seq=excluded.seq').run(op.dev, op.seq);
    const keys = [...new Set(op.changes.map(c => rowKey(c.t, c.k)))];
    this.db.prepare('INSERT OR IGNORE INTO sync_oplog(device,seq,deps,keys) VALUES(?,?,?,?)').run(op.dev, op.seq, JSON.stringify(op.deps), JSON.stringify(keys));
  }

  // ------------------------------------------------------------------ local changes → operations
  /** Called inside every write transaction: seals what was changed into one operation in the outbox. */
  seal(label: string): Op | null {
    const changes = drainChanges(this.db);
    if (!changes.length) return null;
    return this.record(label, orderChanges(changes));
  }
  private record(label: string, changes: Change[], resolves?: string[]): Op {
    const seq = this.ownSeq() + 1; const deps = this.vv(); delete deps[this.device];
    const op: Op = { id: `${this.device}:${seq}`, dev: this.device, seq, deps, at: nowIso(), label: label.slice(0, 120), schema: BUDGET_SCHEMA_VERSION, changes, ...(resolves ? { resolves } : {}) };
    this.db.prepare('INSERT INTO sync_outbox(seq, op) VALUES(?,?)').run(seq, JSON.stringify(op));
    this.processed(op);
    const w = { dev: this.device, seq };
    const parents = new Set<string>();
    for (const c of changes) {
      const parent = this.parentOf(c);
      if (parent) parents.add(parent);
      if (c.e) continue; // "make sure it exists": nothing changed here
      if (c.a || c.d) this.rowWriters(c.t, c.k, [w]);
      else if (c.f) for (const f of Object.keys(c.f)) this.setField(c.t, c.k, f, [SYNC_TABLES[c.t].lww.includes(f) ? { ...w, v: c.f[f] } : w]);
    }
    for (const p of parents) if (readRow(this.db, 'transactions', p)) this.setField('transactions', p, CHILDREN, [w]);
    this.autoClose();
    return op;
  }
  unwritten(): Op[] { return (this.db.prepare('SELECT op FROM sync_outbox WHERE written=0 ORDER BY seq').all() as { op: string }[]).map(r => JSON.parse(r.op)); }
  ownOps(from: number, to: number): Op[] { return (this.db.prepare('SELECT op FROM sync_outbox WHERE seq BETWEEN ? AND ? ORDER BY seq').all(from, to) as { op: string }[]).map(r => JSON.parse(r.op)); }
  markWritten(to: number) { this.db.prepare('UPDATE sync_outbox SET written=1 WHERE seq<=?').run(to); }
  /** Captured changes that have not been sealed yet (a write that bypassed mutate()). Sealed before anything is applied. */
  sealStray() { this.db.transaction(() => { this.seal('Changes'); })(); }

  // ------------------------------------------------------------------ remote operations
  /** Has this operation already been processed here? */
  seen(op: Pick<Op, 'dev' | 'seq'>) { return (this.vv()[op.dev] ?? 0) >= op.seq; }
  /** Everything this operation depends on has been processed here (and it is the next one from its device). */
  ready(op: Op, vv = this.vv()) {
    if ((vv[op.dev] ?? 0) + 1 !== op.seq) return false;
    return Object.entries(op.deps).every(([d, s]) => (vv[d] ?? 0) >= s);
  }
  /**
   * Applies one operation from another device: completely, or not at all (then it is recorded as a conflict).
   * Returns 'applied' or 'conflict'. Idempotent: an operation that was already processed is ignored.
   */
  apply(op: Op): 'applied' | 'conflict' | 'seen' {
    if (this.seen(op)) return 'seen';
    if (op.dev === this.device) throw new Error('own operation');
    try {
      this.db.transaction(() => {
        setCapture(this.db, false);
        this.applyInner(op);
        this.processed(op);
        // undo history refers to rows by their local position and cannot be replayed safely after a remote change
        this.db.exec('UPDATE undo_state SET active=0; DELETE FROM undo_log; DELETE FROM undo_groups; UPDATE revision SET n=n+1 WHERE id=1;');
        setCapture(this.db, true);
      }).immediate();
      this.svc.version++;
      this.db.transaction(() => this.autoClose())();
      return 'applied';
    } catch (e: any) {
      const c = e instanceof Conflicting ? e
        : String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT') ? new Conflicting('cannot_apply', op.changes.map(ch => ({ t: ch.t, k: ch.k, fields: [] })), [], constraintMessage(e))
        : null;
      if (!c) throw e;
      this.db.transaction(() => { this.recordConflict(op, c); this.processed(op); this.db.prepare('UPDATE revision SET n=n+1 WHERE id=1').run(); })();
      this.svc.version++;
      return 'conflict';
    }
  }
  private applyInner(op: Op) {
    /** was writer w part of what this operation's device had seen? */
    const past = (w: Writer) => (w.dev === op.dev ? w.seq < op.seq : (op.deps[w.dev] ?? 0) >= w.seq);
    const me: Writer = { dev: op.dev, seq: op.seq };
    const conflicts: ConflictRow[] = []; const against: Writer[] = []; let kind = 'both_changed';
    const actions: (() => void)[] = [];
    for (const c of orderChanges(op.changes)) {
      const spec = SYNC_TABLES[c.t]; const cols = syncColumns(this.db, c.t);
      const cur = readRow(this.db, c.t, c.k); const W = this.writers(c.t, c.k);
      const eff = (f: string) => W.get(f) ?? W.get('') ?? [];
      const concurrent = (ws: Writer[]) => ws.filter(w => !past(w));
      if (c.d) {
        if (!cur) { const rest = concurrent(W.get('') ?? []); actions.push(() => this.rowWriters(c.t, c.k, [...rest, me])); continue; }
        // deleting a row that was changed here independently would throw that change away
        const blocking = cols.filter(f => !spec.lww.includes(f) && concurrent(eff(f)).length);
        if (blocking.length) { conflicts.push({ t: c.t, k: c.k, fields: blocking }); for (const f of blocking) against.push(...concurrent(eff(f))); kind = 'deleted_there_changed_here'; continue; }
        actions.push(() => {
          // a decision that removes a split removes all of it, including lines the deciding computer never had
          if (op.resolves && c.t === 'transactions' && cur.is_split) for (const kid of this.db.prepare('SELECT id FROM transactions WHERE parent_id=?').all(c.k) as { id: string }[]) { deleteRow(this.db, 'transactions', kid.id); this.rowWriters('transactions', kid.id, [me]); }
          deleteRow(this.db, c.t, c.k); this.rowWriters(c.t, c.k, [me]);
        });
        continue;
      }
      if (c.e) { if (!cur) actions.push(() => { insertRow(this.db, c.t, c.a!); this.rowWriters(c.t, c.k, [me]); }); continue; }
      const vals = (c.a ?? c.f)!;
      if (!cur) {
        const rest = concurrent(W.get('') ?? []);
        if (c.f || rest.length) { conflicts.push({ t: c.t, k: c.k, fields: Object.keys(vals) }); against.push(...(c.f ? W.get('') ?? [] : rest)); kind = 'changed_there_deleted_here'; continue; }
        actions.push(() => { insertRow(this.db, c.t, c.a!); this.rowWriters(c.t, c.k, [me]); });
        continue;
      }
      const set: Record<string, Val> = {}; const fields: [string, Writer[]][] = []; const clash: string[] = [];
      for (const f of Object.keys(vals)) {
        const v = vals[f]; const lww = spec.lww.includes(f); const C = concurrent(eff(f));
        if (!C.length) { if (cur[f] !== v) set[f] = v; fields.push([f, [lww ? { ...me, v } : me]]); continue; }
        if (lww) {
          // independent writes: every device keeps the same set of writers and shows the value of the same one
          const S = [...C.map(w => ({ ...w, v: w.v !== undefined ? w.v : cur[f] })), { ...me, v }];
          const win = S.reduce((m, w) => (SyncStore.later(w, m) ? w : m));
          if (win.v !== cur[f]) set[f] = win.v!;
          fields.push([f, S]); continue;
        }
        if (cur[f] === v) { fields.push([f, [...C, me]]); continue; }
        clash.push(f); against.push(...C);
      }
      if (clash.length) { conflicts.push({ t: c.t, k: c.k, fields: clash }); continue; }
      actions.push(() => { updateRow(this.db, c.t, c.k, set); for (const [f, ws] of fields) this.setField(c.t, c.k, f, ws); });
    }
    // The lines of a split belong to the split: changing them on two computers independently would otherwise
    // merge into a split whose lines no longer add up. Any real change to a line counts as a change of its split.
    const touched = new Set<string>();
    for (const c of op.changes) {
      const parent = this.parentOf(c); if (!parent) continue;
      const cur = readRow(this.db, c.t, c.k);
      const effective = c.a ? !cur || Object.keys(c.a).some(f => cur[f] !== c.a![f]) : c.d ? !!cur : !!cur && Object.keys(c.f!).some(f => cur[f] !== c.f![f]);
      if (effective) touched.add(parent);
    }
    for (const p of touched) {
      if (!readRow(this.db, 'transactions', p)) continue;
      const W = this.writers('transactions', p);
      const C = (W.get(CHILDREN) ?? W.get('') ?? []).filter(w => !past(w));
      if (C.length) { conflicts.push({ t: 'transactions', k: p, fields: ['splits'] }); against.push(...C); }
      else actions.push(() => this.setField('transactions', p, CHILDREN, [me]));
    }
    if (conflicts.length) throw new Conflicting(kind, conflicts, against);
    for (const a of actions) a();
  }
  /** The split a transaction row belongs to (for a split line), else null. */
  private parentOf(c: Change): string | null {
    if (c.t !== 'transactions') return null;
    const p = c.a?.parent_id ?? c.b?.parent_id ?? (c.f ? readRow(this.db, 'transactions', c.k)?.parent_id : null) ?? (c.d ? readRow(this.db, 'transactions', c.k)?.parent_id : null);
    return typeof p === 'string' ? p : null;
  }
  private recordConflict(op: Op, c: Conflicting) {
    // Every row of the incoming operation AND of the operations here it collided with is part of the conflict: the
    // other device has applied its whole operation and not ours, so a decision must settle all of these rows.
    const rows = new Map<string, ConflictRow>();
    for (const r of c.rows) rows.set(rowKey(r.t, r.k), { ...r });
    const add = (key: string) => { if (rows.has(key)) return; const i = key.indexOf('\u0000'); rows.set(key, { t: key.slice(0, i), k: key.slice(i + 1), fields: [] }); };
    for (const ch of op.changes) add(rowKey(ch.t, ch.k));
    const seen = new Set<string>();
    for (const w of c.against) {
      const id = `${w.dev}:${w.seq}`; if (seen.has(id)) continue; seen.add(id);
      const r = this.db.prepare('SELECT keys FROM sync_oplog WHERE device=? AND seq=?').get(w.dev, w.seq) as { keys: string } | undefined;
      for (const key of r ? (JSON.parse(r.keys) as string[]) : []) add(key);
    }
    const local: Record<string, Row | null> = {};
    for (const [key, r] of rows) local[key] = readRow(this.db, r.t, r.k) ?? this.lastImage(r.t, r.k);
    this.db.prepare('INSERT INTO sync_conflicts(op_device, op_seq, kind, rows, op, local, message, created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(op.dev, op.seq, c.kind, JSON.stringify([...rows.values()]), JSON.stringify(op), JSON.stringify(local), c.kind === 'cannot_apply' ? c.message : '', nowIso());
  }
  /** The last complete version of a row that no longer exists here, from this device's own history (for "deleted here" conflicts). */
  private lastImage(t: string, k: string): Row | null {
    const ops = this.db.prepare('SELECT op FROM sync_outbox ORDER BY seq DESC LIMIT 500').all() as { op: string }[];
    for (const r of ops) {
      const o = JSON.parse(r.op) as Op;
      for (const c of o.changes) if (c.t === t && c.k === k && c.d && c.b) return { ...c.b, __deleted: 1 };
    }
    return null;
  }

  // ------------------------------------------------------------------ conflicts
  conflicts(open = true): ConflictRecord[] {
    return (this.db.prepare(`SELECT * FROM sync_conflicts ${open ? 'WHERE resolved_at IS NULL' : ''} ORDER BY id`).all() as any[]).map(r => ({
      id: r.id, opDevice: r.op_device, opSeq: r.op_seq, kind: r.kind, rows: JSON.parse(r.rows), op: JSON.parse(r.op), local: JSON.parse(r.local),
      message: r.message, createdAt: r.created_at, resolvedAt: r.resolved_at, resolution: r.resolution,
    }));
  }
  openConflictCount(): number { return (this.db.prepare('SELECT COUNT(*) n FROM sync_conflicts WHERE resolved_at IS NULL').get() as { n: number }).n; }
  /**
   * Closes conflicts that were settled elsewhere: every row involved has since been written completely by an
   * operation that knew the conflicting change (a resolution made on another computer, or here).
   */
  private autoClose() {
    const open = this.db.prepare('SELECT id, op_device, op_seq, rows FROM sync_conflicts WHERE resolved_at IS NULL').all() as { id: number; op_device: string; op_seq: number; rows: string }[];
    for (const c of open) {
      const x: Writer = { dev: c.op_device, seq: c.op_seq };
      const rows = JSON.parse(c.rows) as ConflictRow[];
      const done = rows.every(r => {
        const W = this.writers(r.t, r.k); const cur = readRow(this.db, r.t, r.k);
        const ok = (ws: Writer[] | undefined) => !!ws?.length && ws.every(w => this.sees(w, x));
        if (!cur) return ok(W.get(''));
        return syncColumns(this.db, r.t).every(f => ok(W.get(f) ?? W.get('')));
      });
      if (done) this.db.prepare(`UPDATE sync_conflicts SET resolved_at=?, resolution='superseded' WHERE id=?`).run(nowIso(), c.id);
    }
  }
  /**
   * The user's decision. `mine` keeps this device's version of every row the other device's change touched,
   * `theirs` takes the other device's version. Conflicts that share rows are decided together (in their order), so
   * "theirs" always means the newest version from the other device. The result is a new operation that every
   * device applies, which closes the conflict everywhere.
   */
  resolve(id: number, choice: 'mine' | 'theirs'): { resolved: number } {
    const open = this.conflicts(true);
    const start = open.find(c => c.id === id); if (!start) throw new AppError(404, 'NOT_FOUND', 'This conflict was already resolved.');
    const key = rowKey;
    const keysOf = (c: ConflictRecord) => new Set(c.rows.map(r => key(r.t, r.k)));
    const group = [start]; const keys = keysOf(start);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of open) if (!group.includes(c) && [...keysOf(c)].some(k => keys.has(k))) { group.push(c); for (const k of keysOf(c)) keys.add(k); grew = true; }
    }
    group.sort((a, b) => a.id - b.id);
    const rows = new Map<string, { t: string; k: string; row: Row | null }>();
    for (const c of group) for (const r of c.rows) if (!rows.has(key(r.t, r.k))) rows.set(key(r.t, r.k), { t: r.t, k: r.k, row: readRow(this.db, r.t, r.k) });
    if (choice === 'theirs') {
      for (const c of group) for (const ch of c.op.changes) {
        const r = rows.get(key(ch.t, ch.k))!;
        if (ch.d) r.row = null;
        else if (ch.a) r.row = { ...ch.a };
        else {
          const base = r.row ?? stripDeleted(c.local[key(ch.t, ch.k)]);
          if (!base) throw new AppError(409, 'CANNOT_RESOLVE', 'The other version cannot be used: the row it changes no longer exists anywhere on this device. Keep your version instead.');
          r.row = { ...base, ...ch.f };
        }
      }
    }
    const restored: { row: Row | null }[] = [];
    // What the other side has for a row: start from this computer's last version, apply their changes in order.
    const theirs = (kk: string): Row | null => {
      let st: Row | null = null;
      for (const c of group) { if (st === null && c.local[kk]) st = stripDeleted(c.local[kk]); }
      for (const c of group) for (const ch of c.op.changes) if (key(ch.t, ch.k) === kk) st = ch.d ? null : ch.a ? { ...ch.a } : st ? { ...st, ...ch.f } : null;
      return st;
    };
    if (choice === 'mine') {
      // Keeping "my version" never deletes an account, category, group or payee that the other computer still has:
      // its transactions may still use it. It is kept (restored here), which loses nothing.
      for (const [kk, r] of rows) if (!r.row && REFERENCED.has(r.t)) { const t = theirs(kk); if (t) { r.row = t; restored.push(r); } }
    }
    // A split and its lines are one unit: deciding about a line decides about the whole split.
    for (let grew = true; grew;) {
      grew = false;
      for (const r of [...rows.values()]) {
        if (r.t !== 'transactions') continue;
        const cur = readRow(this.db, 'transactions', r.k);
        const parent = (r.row?.parent_id ?? cur?.parent_id ?? theirs(key('transactions', r.k))?.parent_id) as string | null | undefined;
        const units = [parent, (r.row?.is_split || cur?.is_split) ? r.k : null].filter((x): x is string => typeof x === 'string');
        for (const p of units) {
          if (!rows.has(key('transactions', p))) { rows.set(key('transactions', p), { t: 'transactions', k: p, row: readRow(this.db, 'transactions', p) }); grew = true; }
          for (const kid of this.db.prepare('SELECT id FROM transactions WHERE parent_id=?').all(p) as { id: string }[])
            if (!rows.has(key('transactions', kid.id))) { rows.set(key('transactions', kid.id), { t: 'transactions', k: kid.id, row: readRow(this.db, 'transactions', kid.id) }); grew = true; }
        }
      }
    }
    // Make the decision self-contained: the rows the chosen rows refer to (account, category, group, payee, split)
    // are sent along as "make sure it exists", so other computers can apply the decision even if they removed one
    // of them meanwhile. Such a row is only inserted where it is missing; an existing one is never changed.
    const ensure = new Map<string, { t: string; k: string; row: Row }>();
    const queue = [...rows.values()].filter(r => r.row).map(r => ({ t: r.t, row: r.row! }));
    while (queue.length) {
      const r = queue.pop()!;
      for (const [col, tt] of REFERENCES[r.t] ?? []) {
        const id = r.row[col]; if (typeof id !== 'string') continue;
        const kk = key(tt, id); if (rows.has(kk) || ensure.has(kk)) continue;
        const ref = readRow(this.db, tt, id); if (!ref) continue;
        ensure.set(kk, { t: tt, k: id, row: ref }); queue.push({ t: tt, row: ref });
      }
    }
    const before = new Set(this.svc.checkIntegrity());
    const attempt = () => {
      const changes: Change[] = [...rows.values()].map(r => (r.row ? { t: r.t, k: r.k, a: r.row } : { t: r.t, k: r.k, d: 1 as const, b: null }));
      for (const r of ensure.values()) changes.push({ t: r.t, k: r.k, a: r.row, e: 1 });
      this.db.transaction(() => {
        setCapture(this.db, false);
        for (const c of orderChanges(changes)) {
          const cur = readRow(this.db, c.t, c.k);
          if (c.e) { if (!cur) insertRow(this.db, c.t, c.a!); continue; }
          if (c.d) { if (cur) deleteRow(this.db, c.t, c.k); }
          else if (cur) updateRow(this.db, c.t, c.k, c.a!);
          else insertRow(this.db, c.t, c.a!);
        }
        // a decision must never leave the budget inconsistent (for example a split whose lines no longer add up)
        const after = this.svc.checkIntegrity().filter(p => !before.has(p));
        if (after.length) throw new AppError(409, 'CANNOT_RESOLVE', `This version cannot be used: the budget would become inconsistent (${after[0]}). Choose the other version, then correct it by hand if needed.`);
        this.db.exec('UPDATE undo_state SET active=0; DELETE FROM undo_log; DELETE FROM undo_groups; UPDATE revision SET n=n+1 WHERE id=1;');
        setCapture(this.db, true);
        const st = this.db.prepare('UPDATE sync_conflicts SET resolved_at=?, resolution=? WHERE id=? AND resolved_at IS NULL');
        for (const c of group) st.run(nowIso(), choice, c.id);
        this.record(choice === 'mine' ? 'Resolve conflict: keep this version' : 'Resolve conflict: use the other version', changes, group.map(c => c.op.id));
      }).immediate();
    };
    try {
      try { attempt(); } catch (e: any) {
        // a restored row that cannot exist here (it refers to something deleted here): keep "my version" as it is
        if (!restored.length || !String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw e;
        for (const r of restored) r.row = null;
        attempt();
      }
    } catch (e: any) {
      if (String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw new AppError(409, 'CANNOT_RESOLVE', `This version cannot be used: ${constraintMessage(e)} Choose the other version, or fix the data first.`);
      throw e;
    }
    this.svc.version++;
    return { resolved: group.length };
  }

  // ------------------------------------------------------------------ snapshots
  /** Complete primary data + sync bookkeeping. Only meaningful when there are no open conflicts. */
  exportSnapshot(): Snapshot {
    const tables: Record<string, Row[]> = {};
    for (const t of TABLE_ORDER) {
      const cols = syncColumns(this.db, t);
      const order = t === 'transactions' ? 'ORDER BY (parent_id IS NOT NULL), seq' : 'ORDER BY rowid';
      tables[t] = this.db.prepare(`SELECT ${cols.join(',')} FROM ${t} ${order}`).all() as Row[];
    }
    return {
      vv: this.vv(), tables,
      writers: (this.db.prepare('SELECT tbl, pk, field, ws FROM sync_writers').raw().all() as [string, string, string, string][]),
      oplog: (this.db.prepare('SELECT device, seq, deps, keys FROM sync_oplog').raw().all() as [string, number, string, string][]),
    };
  }
  /** Replaces this (new, empty) budget's data with a snapshot. One transaction; validated by the schema's constraints. */
  importSnapshot(s: Snapshot) {
    this.svc.bulk(() => {
      setCapture(this.db, false);
      this.db.pragma('defer_foreign_keys = ON');
      for (const t of [...TABLE_ORDER].reverse()) { if (t === 'transactions') this.db.exec('DELETE FROM transactions WHERE parent_id IS NOT NULL'); this.db.exec(`DELETE FROM ${t}`); }
      for (const t of TABLE_ORDER) for (const row of s.tables[t] ?? []) insertRow(this.db, t, row);
      const w = this.db.prepare('INSERT INTO sync_writers(tbl,pk,field,ws) VALUES(?,?,?,?)');
      for (const x of s.writers) w.run(...x);
      const o = this.db.prepare('INSERT INTO sync_oplog(device,seq,deps,keys) VALUES(?,?,?,?)');
      for (const x of s.oplog) o.run(...x);
      const v = this.db.prepare('INSERT INTO sync_vv(device,seq) VALUES(?,?)');
      for (const [d, n] of Object.entries(s.vv)) v.run(d, n);
      this.db.prepare('DELETE FROM sync_changes').run();
    });
  }
}

const stripDeleted = (r: Row | null | undefined): Row | null => { if (!r) return null; const { __deleted, ...rest } = r; void __deleted; return rest; };
function constraintMessage(e: any): string {
  const m = String(e?.message ?? '');
  if (/FOREIGN KEY/i.test(m)) return 'it refers to an account, category, payee or transaction that was deleted on this device.';
  if (/UNIQUE/i.test(m)) return 'it would create a duplicate (for example two payees with the same name).';
  if (/CHECK/i.test(m)) return 'the combined result would not be valid.';
  return 'the data would become inconsistent.';
}
export { keyOf };
