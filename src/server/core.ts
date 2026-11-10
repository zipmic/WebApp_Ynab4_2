/** Application core: system database, budget files, backups and restore. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Auth } from './auth.ts';
import { BudgetService } from './budgetService.ts';
import type { Config } from './config.ts';
import { BUDGET_SCHEMA_VERSION, type DB, newId, nowIso, openBudgetDb, openSystemDb } from './db.ts';
import { AppError, bad, notFound } from './errors.ts';

export const BACKUP_FORMAT = 'budget-reborn-sqlite';
const ID_RE = /^[0-9a-f]{24}$/;
const BACKUP_RE = /^\d{8}T\d{6}Z-[a-z-]{1,24}\.sqlite$/;

export class Core {
  readonly sys: DB; readonly auth: Auth;
  private services = new Map<string, BudgetService>();
  private budgetsDir: string; private backupsDir: string; private tmpDir: string;
  constructor(public readonly cfg: Config) {
    this.budgetsDir = join(cfg.dataDir, 'budgets'); this.backupsDir = join(cfg.dataDir, 'backups'); this.tmpDir = join(cfg.dataDir, 'tmp');
    for (const d of [this.budgetsDir, this.backupsDir, this.tmpDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(this.tmpDir)) { try { unlinkSync(join(this.tmpDir, f)); } catch { /* ignore */ } }
    this.sys = openSystemDb(join(cfg.dataDir, 'system.sqlite'));
    this.auth = new Auth(this.sys, cfg);
  }
  close() { for (const s of this.services.values()) s.db.close(); this.services.clear(); this.sys.close(); }

  listBudgets() { return this.sys.prepare('SELECT id, name, created_at createdAt, last_opened lastOpened FROM budgets ORDER BY COALESCE(last_opened, created_at) DESC').all() as { id: string; name: string; createdAt: string; lastOpened: string | null }[]; }
  private file(id: string) { if (!ID_RE.test(id)) throw notFound('Budget'); return join(this.budgetsDir, id + '.sqlite'); }
  service(id: string): BudgetService {
    let s = this.services.get(id);
    if (!s) {
      if (!ID_RE.test(id) || !this.sys.prepare('SELECT 1 FROM budgets WHERE id=?').get(id) || !existsSync(this.file(id))) throw notFound('Budget');
      s = new BudgetService(openBudgetDb(this.file(id)), id); this.services.set(id, s);
      this.sys.prepare('UPDATE budgets SET last_opened=? WHERE id=?').run(nowIso(), id);
      this.autoBackup(id);
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
    svc.db.close(); this.services.delete(id);
    for (const ext of ['', '-wal', '-shm']) { try { unlinkSync(this.file(id) + ext); } catch { /* not present */ } }
    this.sys.prepare('DELETE FROM budgets WHERE id=?').run(id);
  }
  /** Discard a budget that was created by an import which then failed (no backup needed: nothing existed before). */
  discardBudget(id: string) {
    const svc = this.services.get(id); svc?.db.close(); this.services.delete(id);
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
    const autos = this.listBackups(id).filter(b => b.reason === 'auto');
    for (const b of autos.slice(this.cfg.backupKeep)) { try { unlinkSync(join(this.backupDir(id), b.name)); } catch { /* ignore */ } }
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
    const problems = svc.checkIntegrity();
    if (problems.length) { svc.db.close(); unlinkSync(this.file(id)); throw new AppError(422, 'BACKUP_INCONSISTENT', 'The backup failed the financial consistency check: ' + problems[0]); }
    const finalName = (name?.trim() || `${svc.getSettings().name} (restored)`).slice(0, 100);
    svc.bulk(() => svc.setMeta('settings', JSON.stringify({ ...svc.getSettings(), name: finalName })));
    this.sys.prepare('INSERT INTO budgets(id,name,created_at,last_opened) VALUES(?,?,?,?)').run(id, finalName, nowIso(), nowIso());
    this.services.set(id, svc);
    return { id, name: finalName };
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
