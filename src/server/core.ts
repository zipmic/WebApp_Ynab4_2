/** Application core: system database, budget files, backups and restore. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Auth } from './auth.ts';
import { BudgetService } from './budgetService.ts';
import type { Config } from './config.ts';
import { BUDGET_SCHEMA_VERSION, type DB, newId, nowIso, openBudgetDb, openSystemDb } from './db.ts';
import { AppError, bad, notFound } from './errors.ts';
import { hasSyncSchema } from './sync/capture.ts';
import { SyncManager } from './sync/manager.ts';
import { SyncStore } from './sync/store.ts';

export const BACKUP_FORMAT = 'budget-reborn-sqlite';
const ID_RE = /^[0-9a-f]{24}$/;
const BACKUP_RE = /^\d{8}T\d{6}Z-[a-z-]{1,24}\.sqlite$/;

export class Core {
  readonly sys: DB; readonly auth: Auth;
  /** file-based synchronisation between computers (desktop app only) */
  readonly sync: SyncManager | null;
  /** folders the user picked in a system dialog (desktop app): routes accept only these, by token, never raw paths */
  private granted = new Map<string, string>();
  private services = new Map<string, BudgetService>();
  private budgetsDir: string; private backupsDir: string; private tmpDir: string;
  /**
   * `maintenance`: for command-line tools that run next to a live server (e.g. scripts/backup-now.ts). Nothing the
   * server owns is touched: the upload temp folder is not emptied, "last opened" is not updated, no automatic backup.
   */
  constructor(public readonly cfg: Config, private readonly opts: { maintenance?: boolean; syncAuto?: boolean } = {}) {
    this.budgetsDir = join(cfg.dataDir, 'budgets'); this.backupsDir = join(cfg.dataDir, 'backups'); this.tmpDir = join(cfg.dataDir, 'tmp');
    for (const d of [this.budgetsDir, this.backupsDir, this.tmpDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    if (!opts.maintenance) for (const f of readdirSync(this.tmpDir)) { try { unlinkSync(join(this.tmpDir, f)); } catch { /* ignore */ } }
    this.sys = openSystemDb(join(cfg.dataDir, 'system.sqlite'));
    this.auth = new Auth(this.sys, cfg);
    this.sync = cfg.desktop && !opts.maintenance ? new SyncManager(this, { auto: opts.syncAuto ?? true }) : null;
  }
  close() { this.sync?.stopAll(); for (const s of this.services.values()) s.db.close(); this.services.clear(); this.sys.close(); }
  /** Registers a folder chosen by the user in a system dialog and returns an opaque token for it. */
  grantFolder(path: string): string { const t = newId(); this.granted.set(t, path); return t; }
  folderOf(token: string): string { const p = this.granted.get(token); if (!p) throw new AppError(403, 'FOLDER_NOT_GRANTED', 'Choose the folder again.'); return p; }

  listBudgets() { return this.sys.prepare('SELECT id, name, created_at createdAt, last_opened lastOpened, sync_folder syncFolder FROM budgets ORDER BY COALESCE(last_opened, created_at) DESC').all() as { id: string; name: string; createdAt: string; lastOpened: string | null; syncFolder: string | null }[]; }
  private file(id: string) { if (!ID_RE.test(id)) throw notFound('Budget'); return join(this.budgetsDir, id + '.sqlite'); }
  service(id: string): BudgetService {
    let s = this.services.get(id);
    if (!s) {
      if (!ID_RE.test(id) || !this.sys.prepare('SELECT 1 FROM budgets WHERE id=?').get(id) || !existsSync(this.file(id))) throw notFound('Budget');
      s = new BudgetService(openBudgetDb(this.file(id)), id); this.services.set(id, s);
      if (!this.opts.maintenance) { this.sys.prepare('UPDATE budgets SET last_opened=? WHERE id=?').run(nowIso(), id); this.autoBackup(id); }
      this.sync?.attach(s);
    }
    return s;
  }
  createBudget(name: string, settings: Record<string, unknown> = {}): BudgetService {
    name = name.trim().slice(0, 100); if (!name) throw bad('Budget name is required');
    const id = newId(); const svc = new BudgetService(openBudgetDb(this.file(id)), id);
    svc.setMeta('settings', JSON.stringify({ ...svc.getSettings(), ...settings, name }));
    svc.setMeta('format', BACKUP_FORMAT);
    this.sys.prepare('INSERT INTO budgets(id,name,created_at,last_opened) VALUES(?,?,?,?)').run(id, name, nowIso(), nowIso());
    this.services.set(id, svc); return svc;
  }
  renameBudget(id: string, name: string) { this.sys.prepare('UPDATE budgets SET name=? WHERE id=?').run(name.trim().slice(0, 100), id); }
  /** Removes a budget from the app. A final backup is always kept in the backups folder. */
  deleteBudget(id: string) {
    const svc = this.service(id); this.backup(id, 'before-delete');
    this.sync?.detach(id); svc.db.close(); this.services.delete(id);
    for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(this.file(id) + ext); } catch { /* not present */ } }
    this.sys.prepare('DELETE FROM budgets WHERE id=?').run(id);
  }
  /** Discard a budget that was created by an import which then failed (no backup needed: nothing existed before). */
  discardBudget(id: string) {
    this.sync?.detach(id); const svc = this.services.get(id); svc?.db.close(); this.services.delete(id);
    for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(this.file(id) + ext); } catch { /* not present */ } }
    this.sys.prepare('DELETE FROM budgets WHERE id=?').run(id);
  }

  // ---------------------------------------------------------------- backups
  private backupDir(id: string) { if (!ID_RE.test(id)) throw notFound('Budget'); const d = join(this.backupsDir, id); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
  /** Consistent snapshot of the whole budget database (VACUUM INTO), safe while the app is running. */
  backup(id: string, reason = 'manual'): string {
    const svc = this.service(id);
    const name = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}-${reason.replace(/[^a-z-]/g, '').slice(0, 24) || 'manual'}.sqlite`;
    const target = join(this.backupDir(id), name);
    if (existsSync(target)) return name;
    svc.db.prepare('VACUUM INTO ?').run(target);
    // retention: keep the newest N automatic backups; manual and safety backups are kept
    // retention: the newest N of each automatic kind ('auto' = daily on use, 'scheduled' = scripts/backup-now.ts)
    const all = this.listBackups(id); const autos = [...all.filter(b => b.reason === 'auto').slice(this.cfg.backupKeep), ...all.filter(b => b.reason === 'scheduled').slice(this.cfg.backupKeep)];
    for (const b of autos) { try { unlinkSync(join(this.backupDir(id), b.name)); } catch { /* ignore */ } }
    return name;
  }
  listBackups(id: string) {
    return readdirSync(this.backupDir(id)).filter(f => BACKUP_RE.test(f)).sort().reverse().map(name => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-(.+)\.sqlite$/.exec(name)!;
      return { name, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, reason: m[7], size: statSync(join(this.backupDir(id), name)).size };
    });
  }
  backupPath(id: string, name: string): string {
    if (!BACKUP_RE.test(name)) throw notFound('Backup');
    const p = join(this.backupDir(id), name); if (!existsSync(p)) throw notFound('Backup'); return p;
  }
  private autoBackup(id: string) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (!this.listBackups(id).some(b => b.reason === 'auto' && b.at.startsWith(today)) && (this.services.get(id)!.db.prepare('SELECT COUNT(*) n FROM transactions').get() as { n: number }).n > 0) this.backup(id, 'auto');
    } catch { /* a failed automatic backup must never block opening the budget */ }
  }
  backupAll(reason: string) { for (const b of this.listBudgets()) { try { this.backup(b.id, reason); } catch { /* keep going */ } } }

  /** Validate an uploaded backup and add it as a NEW budget. Existing budgets are never overwritten. */
  restore(bytes: Buffer, name?: string): { id: string; name: string } {
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new AppError(415, 'NOT_A_BACKUP', 'This file is not a Budget Reborn backup.');
    const id = newId(); const tmp = join(this.tmpDir, id + '.sqlite');
    writeFileSync(tmp, bytes, { mode: 0o600 });
    try {
      const db = new Database(tmp, { readonly: true });
      try {
        const version = db.pragma('user_version', { simple: true }) as number;
        const tables = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(t => t.name));
        for (const t of ['meta', 'accounts', 'categories', 'transactions', 'monthly_budgets']) if (!tables.has(t)) throw new AppError(415, 'NOT_A_BACKUP', 'This file is not a Budget Reborn backup.');
        if (version < 1) throw new AppError(415, 'NOT_A_BACKUP', 'This file is not a Budget Reborn backup.');
        if (version > BUDGET_SCHEMA_VERSION) throw new AppError(409, 'BACKUP_TOO_NEW', 'This backup was made by a newer version of Budget Reborn. Update the application first.');
        if ((db.pragma('integrity_check', { simple: true }) as string) !== 'ok') throw new AppError(422, 'BACKUP_CORRUPT', 'The backup file is damaged (integrity check failed).');
        if ((db.pragma('foreign_key_check') as unknown[]).length) throw new AppError(422, 'BACKUP_CORRUPT', 'The backup file is inconsistent (foreign key check failed).');
      } finally { db.close(); }
      renameSync(tmp, this.file(id));
    } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } throw e; }
    const svc = new BudgetService(openBudgetDb(this.file(id)), id);
    // a restored copy is a new, local-only budget: it must never continue a synchronised budget's history
    if (hasSyncSchema(svc.db)) new SyncStore(svc, '').reset();
    const problems = svc.checkIntegrity();
    if (problems.length) { svc.db.close(); unlinkSync(this.file(id)); throw new AppError(422, 'BACKUP_INCONSISTENT', 'The backup failed the financial consistency check: ' + problems[0]); }
    const finalName = (name?.trim() || `${svc.getSettings().name} (restored)`).slice(0, 100);
    svc.bulk(() => svc.setMeta('settings', JSON.stringify({ ...svc.getSettings(), name: finalName })));
    this.sys.prepare('INSERT INTO budgets(id,name,created_at,last_opened) VALUES(?,?,?,?)').run(id, finalName, nowIso(), nowIso());
    this.services.set(id, svc);
    return { id, name: finalName };
  }
  /**
   * Migration from the server version: copies every budget of a server data folder (the folder that holds
   * `system.sqlite` and `budgets/`) into this app as NEW budgets. The source folder is only read — its files are
   * copied to a temporary folder first and opened there — and each copy is verified (integrity, consistency and
   * row counts per table) before it is kept. A budget that fails is skipped and reported; nothing else changes.
   */
  importServerData(dir: string): { imported: { id: string; name: string; transactions: number }[]; failed: { name: string; reason: string }[] } {
    const sysFile = join(dir, 'system.sqlite'); const bdir = join(dir, 'budgets');
    if (!existsSync(bdir)) throw new AppError(404, 'NOT_SERVER_DATA', 'This folder does not look like a Budget Reborn data folder (it has no "budgets" folder).');
    const names = new Map<string, string>();
    if (existsSync(sysFile)) {
      const work = join(this.tmpDir, newId()); mkdirSync(work, { mode: 0o700 });
      try {
        for (const ext of ['', '-wal']) if (existsSync(sysFile + ext)) writeFileSync(join(work, 'system.sqlite' + ext), readFileSync(sysFile + ext));
        const db = new Database(join(work, 'system.sqlite'));
        try { for (const r of db.prepare('SELECT id, name FROM budgets').all() as { id: string; name: string }[]) names.set(r.id, r.name); } finally { db.close(); }
      } catch { /* names are optional */ } finally { rmSync(work, { recursive: true, force: true }); }
    }
    const imported: { id: string; name: string; transactions: number }[] = []; const failed: { name: string; reason: string }[] = [];
    for (const f of readdirSync(bdir).filter(n => /^[0-9a-f]{24}\.sqlite$/.test(n)).sort()) {
      const srcId = f.slice(0, 24); const label = names.get(srcId) ?? srcId.slice(0, 8);
      const work = join(this.tmpDir, newId()); mkdirSync(work, { mode: 0o700 });
      try {
        for (const ext of ['', '-wal']) if (existsSync(join(bdir, f + ext))) writeFileSync(join(work, 'b.sqlite' + ext), readFileSync(join(bdir, f + ext)));
        const src = new Database(join(work, 'b.sqlite'));
        const counts = new Map<string, number>();
        try {
          for (const t of ['accounts', 'category_groups', 'categories', 'payees', 'transactions', 'monthly_budgets', 'scheduled', 'reconciliations'])
            counts.set(t, (src.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
          src.prepare('VACUUM INTO ?').run(join(work, 'copy.sqlite'));
        } finally { src.close(); }
        const r = this.restore(readFileSync(join(work, 'copy.sqlite')), label);
        const svc = this.service(r.id);
        for (const [t, n] of counts) {
          const m = (svc.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
          if (m !== n) { this.discardBudget(r.id); throw new Error(`verification failed (${t})`); }
        }
        imported.push({ id: r.id, name: r.name, transactions: counts.get('transactions') ?? 0 });
      } catch (e) { failed.push({ name: label, reason: (e as Error).message.slice(0, 200) }); }
      finally { rmSync(work, { recursive: true, force: true }); }
    }
    if (!imported.length && !failed.length) throw new AppError(404, 'NOT_SERVER_DATA', 'No budgets were found in this folder.');
    return { imported, failed };
  }
  /**
   * Restore from the open JSON export (GET /api/b/:bid/export/json) as a NEW budget. Every row is validated by the
   * schema's own constraints (integer amounts, dates, links), the whole load is one transaction, and the result
   * must pass the financial consistency check — otherwise nothing is kept.
   */
  restoreJson(text: string, name?: string): { id: string; name: string } {
    let doc: any;
    try { doc = JSON.parse(text); } catch { throw new AppError(415, 'NOT_A_BACKUP', 'This file is not a Budget Reborn backup or export.'); }
    if (doc?.format !== 'budget-reborn-export' || typeof doc.tables !== 'object' || doc.tables === null) throw new AppError(415, 'NOT_A_BACKUP', 'This file is not a Budget Reborn export.');
    if (doc.version !== 1) throw new AppError(409, 'BACKUP_TOO_NEW', 'This export was made by a different version of Budget Reborn and cannot be read by this one.');
    // parents before children; the transaction table's own links are checked at commit (deferred)
    const ORDER = ['meta', 'accounts', 'category_groups', 'categories', 'payees', 'transactions', 'monthly_budgets', 'month_notes', 'scheduled', 'reconciliations', 'payee_rules', 'imports'];
    for (const t of Object.keys(doc.tables)) if (!ORDER.includes(t)) throw new AppError(409, 'BACKUP_TOO_NEW', `The export contains data this version does not know ("${t.slice(0, 40)}").`);
    for (const t of ORDER) if (doc.tables[t] !== undefined && !Array.isArray(doc.tables[t])) throw new AppError(422, 'BACKUP_CORRUPT', `The export is damaged ("${t}" is not a list).`);
    const svc = this.createBudget('Restoring…');
    try {
      svc.bulk(() => {
        svc.db.pragma('defer_foreign_keys = ON');
        // a new budget file starts with the built-in income categories; the export carries its own copy of them
        svc.db.exec('DELETE FROM meta; DELETE FROM categories; DELETE FROM category_groups;');
        for (const t of ORDER) {
          const rows = (doc.tables[t] ?? []) as Record<string, unknown>[];
          if (!rows.length) continue;
          const cols = new Set((svc.db.pragma(`table_info(${t})`) as { name: string }[]).map(c => c.name));
          for (const r of rows) {
            if (!r || typeof r !== 'object' || Array.isArray(r)) throw new AppError(422, 'BACKUP_CORRUPT', `The export is damaged (a row of "${t}" is not an object).`);
            const keys = Object.keys(r);
            for (const k of keys) if (!cols.has(k)) throw new AppError(409, 'BACKUP_TOO_NEW', `The export contains a field this version does not know ("${t}.${k.slice(0, 40)}").`);
            for (const k of keys) { const v = r[k]; if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new AppError(422, 'BACKUP_CORRUPT', `The export is damaged (${t}.${k} has an invalid value).`); }
            svc.db.prepare(`INSERT INTO ${t}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(k => r[k] as string | number | null));
          }
        }
      });
      const problems = svc.checkIntegrity();
      if (problems.length) throw new AppError(422, 'BACKUP_INCONSISTENT', 'The export failed the financial consistency check: ' + problems[0]);
      const finalName = (name?.trim() || `${svc.getSettings().name} (restored)`).slice(0, 100);
      svc.bulk(() => svc.setMeta('settings', JSON.stringify({ ...svc.getSettings(), name: finalName })));
      this.renameBudget(svc.id, finalName);
      return { id: svc.id, name: finalName };
    } catch (e) {
      this.discardBudget(svc.id);
      if (e instanceof AppError) throw e;
      throw new AppError(422, 'BACKUP_CORRUPT', 'The export could not be restored: ' + String((e as Error).message).slice(0, 200) + '. Nothing was changed.');
    }
  }
  /** Budgets that were created from the same source files (duplicate-import guard). */
  findImports(fingerprint: string) {
    const out: { id: string; name: string; at: string }[] = [];
    for (const b of this.listBudgets()) {
      try { const r = this.service(b.id).db.prepare('SELECT at FROM imports WHERE fingerprint=? LIMIT 1').get(fingerprint) as { at: string } | undefined; if (r) out.push({ id: b.id, name: b.name, at: r.at }); } catch { /* unreadable budget: skip */ }
    }
    return out;
  }
  static fingerprint(parts: string[]): string { const h = createHash('sha256'); for (const p of [...parts].sort()) h.update(createHash('sha256').update(p).digest()); return h.digest('hex'); }
}
