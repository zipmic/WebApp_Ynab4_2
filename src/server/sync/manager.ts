/**
 * Runs synchronisation for the budgets of one device: a cycle writes this device's new operations to the shared
 * folder, reads the other devices' operations, applies them in causal order and reports an honest status.
 * A cycle runs after every local change (shortly after), when the folder changes (file watcher) and every
 * 30 seconds (in case the watcher misses something — cloud clients and network shares often do).
 */
import { watch, type FSWatcher, promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { BudgetService } from '../budgetService.ts';
import type { Core } from '../core.ts';
import { BUDGET_SCHEMA_VERSION, newId, nowIso } from '../db.ts';
import { AppError } from '../errors.ts';
import { APP_VERSION } from '../version.ts';
import { hasSyncSchema, type Op, SYNC_TABLES, syncColumns } from './capture.ts';
import {
  atomicWrite, type DeviceFile, exists, FolderError, folderNameFor, listDir, MANIFEST, MAX_OPS_BYTES, MAX_SMALL_BYTES, OPS_FILE_RE, opsFileContent, pad,
  parseDeviceFile, parseOpsFile, readLimited, readManifest, readSnapshotFile, SNAPSHOT_RE, snapshotContent,
} from './folder.ts';
import { DEVICE_RE, SyncStore, SYNC_PROTOCOL } from './store.ts';

export type SyncState = 'local' | 'synced' | 'syncing' | 'pending' | 'unavailable' | 'waiting' | 'conflict' | 'error';
export interface SyncWarning { code: string; message: string; file?: string }
export interface SyncDevice { id: string; name: string; isThis: boolean; lastSeen: string | null; app: string; hasAllMine: boolean }
export interface SyncStatus {
  state: SyncState; message: string | null; folder: string | null; deviceId: string;
  /** last time the folder was checked */ lastCheckAt: string | null;
  /** last time a check found this computer fully up to date with the folder (everything written and applied) */ lastSyncedAt: string | null;
  pendingOwn: number; waiting: number; conflicts: number; warnings: SyncWarning[]; devices: SyncDevice[];
}
const SNAPSHOT_EVERY_OPS = 500;
const SNAPSHOT_MAX_AGE_MS = 7 * 86400_000;
const DEVICE_HEARTBEAT_MS = 10 * 60_000;
const DAMAGED_AFTER_MS = 10 * 60_000;

export class SyncManager {
  private engines = new Map<string, BudgetSync>();
  readonly deviceId: string; readonly deviceName: string;
  constructor(readonly core: Core, readonly opts: { auto: boolean } = { auto: true }) {
    let id = (core.sys.prepare(`SELECT value FROM settings WHERE key='device_id'`).get() as { value: string } | undefined)?.value;
    if (!id || !DEVICE_RE.test(id)) { id = newId() + newId().slice(0, 8); core.sys.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('device_id',?)`).run(id); }
    this.deviceId = id; this.deviceName = hostname().slice(0, 60) || 'Computer';
  }
  /** Called when a budget is opened: starts synchronising it if it belongs to a folder. */
  attach(svc: BudgetService) {
    if (!hasSyncSchema(svc.db) || this.engines.has(svc.id)) return;
    const store = new SyncStore(svc, this.deviceId);
    if (!store.folder()) return;
    if (store.get('device') && store.get('device') !== this.deviceId) {
      // the database file was copied from another computer: continuing would mix two devices' histories
      store.set('copied_from', store.get('device')!);
    }
    const e = new BudgetSync(this, svc, store); this.engines.set(svc.id, e);
    svc.onCommit = label => { store.seal(label); e.kick(1500); };
    if (this.opts.auto) e.start();
  }
  detach(id: string) { this.engines.get(id)?.stop(); this.engines.delete(id); }
  stopAll() { for (const e of this.engines.values()) e.stop(); this.engines.clear(); }
  engine(id: string) { return this.engines.get(id) ?? null; }
  store(id: string) { return new SyncStore(this.core.service(id), this.deviceId); }

  async status(id: string): Promise<SyncStatus> {
    this.core.service(id); const e = this.engines.get(id);
    if (!e) return { state: 'local', message: null, folder: null, deviceId: this.deviceId, lastCheckAt: null, lastSyncedAt: null, pendingOwn: 0, waiting: 0, conflicts: 0, warnings: [], devices: [] };
    return e.status;
  }
  async syncNow(id: string): Promise<SyncStatus> {
    this.core.service(id); const e = this.engines.get(id);
    if (!e) throw new AppError(409, 'NOT_SYNCED', 'This budget is only stored on this computer. Choose a sync folder first.');
    return e.cycle();
  }

  /** Makes a local budget synchronised: creates "<name> (Budget Reborn)" in `parent` with a complete snapshot. */
  async publish(id: string, parent: string): Promise<{ folder: string }> {
    const svc = this.core.service(id);
    if (!hasSyncSchema(svc.db)) throw new AppError(409, 'OLD_SCHEMA', 'This budget must be upgraded first.');
    const store = new SyncStore(svc, this.deviceId);
    if (store.folder()) throw new AppError(409, 'ALREADY_SYNCED', 'This budget is already synchronised with a folder.');
    if (!(await exists(parent))) throw new AppError(404, 'FOLDER_MISSING', 'The chosen folder does not exist.');
    const base = folderNameFor(svc.getSettings().name);
    let dir = join(parent, base);
    for (let i = 2; (await listDir(dir)).length || (await exists(join(dir, MANIFEST))); i++) dir = join(parent, base.replace(/ \(Budget Reborn\)$/, ` ${i} (Budget Reborn)`));
    const budgetId = newId();
    await fsp.mkdir(join(dir, 'ops', this.deviceId), { recursive: true });
    await fsp.mkdir(join(dir, 'devices'), { recursive: true }); await fsp.mkdir(join(dir, 'snapshots'), { recursive: true });
    store.enable(dir, budgetId);
    try {
      await writeSnapshot(store, dir, budgetId);
      await atomicWrite(join(dir, 'devices', this.deviceId + '.json'), deviceFile(this, store));
      // the manifest is written last: a folder without it is not (yet) a budget
      await atomicWrite(join(dir, MANIFEST), JSON.stringify({ format: 'budget-reborn-budget', protocol: SYNC_PROTOCOL, budgetId, name: svc.getSettings().name, createdAt: nowIso() }, null, 2));
    } catch (e) { store.reset(); throw new AppError(500, 'PUBLISH_FAILED', `The budget could not be written to the folder (${(e as Error).message}). Nothing was changed.`); }
    this.core.sys.prepare('UPDATE budgets SET sync_budget_id=?, sync_folder=? WHERE id=?').run(budgetId, dir, id);
    this.attach(svc);
    await this.engines.get(id)?.cycle();
    return { folder: dir };
  }

  /** Opens a budget from a shared folder on this computer: a new local copy from the newest snapshot, then the operations after it. */
  async join(dir: string): Promise<{ id: string; name: string }> {
    let m; try { m = await readManifest(dir); } catch (e) { throw folderError(e); }
    const already = this.core.sys.prepare('SELECT id FROM budgets WHERE sync_budget_id=?').get(m.budgetId) as { id: string } | undefined;
    if (already) throw new AppError(409, 'ALREADY_OPEN', 'This budget is already on this computer. Open it from the list of budgets.', { id: already.id });
    const snaps = (await listDir(join(dir, 'snapshots'))).map(n => ({ n, m: SNAPSHOT_RE.exec(n) })).filter(x => x.m).sort((a, b) => Number(b.m![2]) - Number(a.m![2]) || (b.n < a.n ? -1 : 1));
    let snap = null; let tooNew = false;
    for (const s of snaps) {
      try { const r = await readSnapshotFile(join(dir, 'snapshots', s.n), m.budgetId); if (r.schema > BUDGET_SCHEMA_VERSION) { tooNew = true; continue; } snap = r.snapshot; break; }
      catch (e) { if ((e as FolderError).code === 'TOO_NEW') tooNew = true; }
    }
    if (!snap) throw tooNew ? new AppError(409, 'TOO_NEW', 'This budget was saved by a newer version of Budget Reborn. Update Budget Reborn on this computer first.')
      : new AppError(409, 'NO_SNAPSHOT', 'The folder does not contain a complete copy of the budget yet. If it was just created on another computer, wait until your sync service has finished copying it and try again.');
    const svc = this.core.createBudget(m.name);
    try {
      const store = new SyncStore(svc, this.deviceId);
      store.importSnapshot(snap);
      const problems = svc.checkIntegrity();
      if (problems.length || (svc.db.pragma('foreign_key_check') as unknown[]).length) throw new AppError(422, 'SNAPSHOT_INCONSISTENT', 'The copy of the budget in the folder failed the consistency check. Nothing was added.');
      store.enable(dir, m.budgetId);
    } catch (e) { this.core.discardBudget(svc.id); throw e instanceof AppError ? e : new AppError(422, 'SNAPSHOT_INVALID', 'The copy of the budget in the folder could not be read. Nothing was added.'); }
    this.core.sys.prepare('UPDATE budgets SET sync_budget_id=?, sync_folder=? WHERE id=?').run(m.budgetId, dir, svc.id);
    this.attach(svc);
    await this.engines.get(svc.id)?.cycle();
    return { id: svc.id, name: m.name };
  }

  /**
   * Point a budget at another folder. Either the folder already holds this budget (it was moved, or the sync
   * service keeps it somewhere else on this computer), or it is empty and the current folder's files are copied
   * there first. The old folder is never changed or deleted.
   */
  async relink(id: string, dir: string): Promise<{ folder: string; copied: number }> {
    const svc = this.core.service(id); const store = new SyncStore(svc, this.deviceId);
    const old = store.folder(); const budgetId = store.get('budget_id');
    if (!old || !budgetId) throw new AppError(409, 'NOT_SYNCED', 'This budget is not synchronised with a folder.');
    let copied = 0;
    if (await exists(join(dir, MANIFEST))) {
      let m; try { m = await readManifest(dir); } catch (e) { throw folderError(e); }
      if (m.budgetId !== budgetId) throw new AppError(409, 'OTHER_BUDGET', 'That folder contains a different budget.');
    } else {
      if ((await listDir(dir)).length) throw new AppError(409, 'FOLDER_NOT_EMPTY', 'Choose an empty folder, or the folder that already contains this budget.');
      if (!(await exists(join(old, MANIFEST)))) throw new AppError(409, 'OLD_FOLDER_UNAVAILABLE', 'The current folder is not available, so it cannot be copied. Choose the folder that contains this budget.');
      copied = await copyBudgetFolder(old, dir);
      try { const m = await readManifest(dir); if (m.budgetId !== budgetId) throw new Error('copy mismatch'); } catch { throw new AppError(500, 'COPY_FAILED', 'Copying the budget folder could not be verified. The budget still uses the old folder.'); }
    }
    this.detach(id);
    svc.db.transaction(() => store.set('folder', dir))();
    this.core.sys.prepare('UPDATE budgets SET sync_folder=? WHERE id=?').run(dir, id);
    this.attach(svc);
    await this.engines.get(id)?.cycle();
    return { folder: dir, copied };
  }
  /** Stop synchronising: the budget stays on this computer with all its data; the folder is not touched. */
  unlink(id: string) {
    const svc = this.core.service(id); this.detach(id); svc.onCommit = null;
    new SyncStore(svc, this.deviceId).reset();
    this.core.sys.prepare('UPDATE budgets SET sync_budget_id=NULL, sync_folder=NULL WHERE id=?').run(id);
  }
}

function folderError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const f = e as FolderError;
  return new AppError(f.code === 'TOO_NEW' ? 409 : 422, f.code ?? 'FOLDER_ERROR', f.message ?? 'The folder could not be read.');
}
function deviceFile(m: SyncManager, store: SyncStore): string {
  const d: DeviceFile = { format: 'budget-reborn-device', protocol: SYNC_PROTOCOL, deviceId: m.deviceId, name: m.deviceName, app: APP_VERSION, schema: BUDGET_SCHEMA_VERSION, vv: store.vv(), ownSeq: store.ownSeq(), at: nowIso() };
  return JSON.stringify(d, null, 1);
}
async function writeSnapshot(store: SyncStore, dir: string, budgetId: string) {
  const snap = store.exportSnapshot();
  const total = Object.values(snap.vv).reduce((a, b) => a + b, 0);
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\.\d+/, '');
  await atomicWrite(join(dir, 'snapshots', `${store.device}-${pad(total)}-${stamp}.json.gz`), snapshotContent(budgetId, store.device, BUDGET_SCHEMA_VERSION, snap));
  store.db.transaction(() => { store.set('snapshot_total', String(total)); store.set('snapshot_at', nowIso()); })();
  // keep this device's two newest snapshots; never touch other devices' files
  const own = (await listDir(join(dir, 'snapshots'))).filter(n => SNAPSHOT_RE.exec(n)?.[1] === store.device).sort().reverse();
  for (const n of own.slice(2)) await fsp.unlink(join(dir, 'snapshots', n)).catch(() => {});
}
/** Copies only files that belong to a budget folder (by name), verifying sizes. */
async function copyBudgetFolder(from: string, to: string): Promise<number> {
  let n = 0;
  const copy = async (rel: string) => { const buf = await readLimited(join(from, rel), MAX_OPS_BYTES * 2); await atomicWrite(join(to, rel), buf); n++; };
  await fsp.mkdir(join(to, 'devices'), { recursive: true }); await fsp.mkdir(join(to, 'snapshots'), { recursive: true });
  for (const d of await listDir(join(from, 'ops'))) {
    if (!DEVICE_RE.test(d)) continue;
    await fsp.mkdir(join(to, 'ops', d), { recursive: true });
    for (const f of await listDir(join(from, 'ops', d))) if (OPS_FILE_RE.test(f)) await copy(join('ops', d, f));
  }
  for (const f of await listDir(join(from, 'snapshots'))) if (SNAPSHOT_RE.test(f)) await copy(join('snapshots', f));
  for (const f of await listDir(join(from, 'devices'))) if (/^[0-9a-f]{32}\.json$/.test(f)) await copy(join('devices', f));
  await copy(MANIFEST);
  return n;
}

export class BudgetSync {
  status: SyncStatus;
  private running: Promise<SyncStatus> | null = null;
  private again = false;
  /** operations read from the folder that cannot be applied yet (waiting for others they depend on) */
  private pending = new Map<string, { op: Op; json: string }>();
  /** files already consumed (or found invalid) at a given size+time: not read again until they change */
  private seenFiles = new Map<string, string>();
  private firstBad = new Map<string, number>();
  private watcher: FSWatcher | null = null; private timer: NodeJS.Timeout | null = null; private kickTimer: NodeJS.Timeout | null = null;
  private lastDeviceFile = ''; private lastDeviceWrite = 0;
  constructor(private readonly mgr: SyncManager, private readonly svc: BudgetService, readonly store: SyncStore) {
    const folder = store.folder();
    this.status = { state: 'pending', message: null, folder, deviceId: mgr.deviceId, lastCheckAt: null, lastSyncedAt: store.get('last_synced_at'), pendingOwn: store.unwritten().length, waiting: 0, conflicts: store.openConflictCount(), warnings: [], devices: [] };
  }
  start() {
    this.stop();
    const dir = this.store.folder()!;
    try { this.watcher = watch(dir, { recursive: true }, () => this.kick(1000)); this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; }); } catch { this.watcher = null; }
    this.timer = setInterval(() => { void this.cycle(); }, 30_000); this.timer.unref?.();
    this.kick(200);
  }
  stop() { this.watcher?.close(); this.watcher = null; if (this.timer) clearInterval(this.timer); if (this.kickTimer) clearTimeout(this.kickTimer); this.timer = this.kickTimer = null; }
  kick(ms: number) {
    if (!this.mgr.opts.auto) return;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => { this.kickTimer = null; void this.cycle(); }, ms); this.kickTimer.unref?.();
  }
  /** One complete synchronisation pass. Never throws: problems end up in the status. */
  cycle(): Promise<SyncStatus> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      let r: SyncStatus;
      do { this.again = false; r = await this.pass().catch(e => this.fail('error', `Synchronisation failed: ${(e as Error).message}`)); } while (this.again);
      this.running = null; return r;
    })();
    return this.running;
  }
  private fail(state: SyncState, message: string): SyncStatus {
    this.status = { ...this.status, state, message, lastCheckAt: nowIso(), pendingOwn: this.store.unwritten().length, conflicts: this.store.openConflictCount() };
    return this.status;
  }

  private async pass(): Promise<SyncStatus> {
    const store = this.store; const me = this.mgr.deviceId; const dir = store.folder()!; const budgetId = store.get('budget_id')!;
    this.status = { ...this.status, state: 'syncing', folder: dir };
    if (store.get('copied_from')) return this.fail('error', 'This budget file was copied from another computer. To keep both computers safe, open the budget again from the sync folder on this computer (Settings → Sync → stop and open from folder).');
    // ---- the folder must be there and be this budget
    try { await fsp.stat(dir); } catch { return this.fail('unavailable', 'The sync folder is not available. Your changes are saved on this computer and will be written when the folder is back.'); }
    let manifest;
    try { manifest = await readManifest(dir); } catch (e) {
      const f = e as FolderError;
      if (f.code === 'TOO_NEW') return this.fail('error', f.message);
      return this.fail('unavailable', f.code === 'NO_MANIFEST' ? 'The sync folder does not contain this budget (budget-reborn.json is missing). Your changes are saved on this computer.' : f.message);
    }
    if (manifest.budgetId !== budgetId) return this.fail('error', 'The sync folder now contains a different budget. Nothing was read or written. Choose the right folder under Settings → Sync.');
    store.sealStray();
    const warnings: SyncWarning[] = [];
    // ---- write this device's new operations
    const ownDir = join(dir, 'ops', me);
    await fsp.mkdir(ownDir, { recursive: true });
    const ownFiles = await listDir(ownDir);
    const ownSeq = store.ownSeq();
    for (const f of ownFiles) {
      const m = OPS_FILE_RE.exec(f);
      if (m && Number(m[2]) > ownSeq) return this.fail('error', 'Another installation is using this computer\'s identity in the sync folder (for example a copied app-data folder). Synchronisation is stopped to keep both safe; nothing was written.');
      if (f.startsWith('.tmp-')) { const st = await fsp.lstat(join(ownDir, f)).catch(() => null); if (st && Date.now() - st.mtimeMs > 3600_000) await fsp.unlink(join(ownDir, f)).catch(() => {}); }
    }
    const unwritten = store.unwritten();
    if (unwritten.length) {
      const name = `${pad(unwritten[0].seq)}-${pad(unwritten[unwritten.length - 1].seq)}.json`;
      const content = opsFileContent(budgetId, me, unwritten);
      const target = join(ownDir, name);
      if (await exists(target)) {
        const cur = await readLimited(target, MAX_OPS_BYTES).catch(() => null);
        if (!cur || cur.toString('utf8') !== content) return this.fail('error', 'A file in the sync folder has this computer\'s name but different content. Synchronisation is stopped; nothing was overwritten.');
      } else {
        try { await atomicWrite(target, content); } catch (e) { return this.fail('unavailable', `Your changes could not be written to the sync folder (${(e as Error).message}). They are saved on this computer and will be written later.`); }
      }
      store.db.transaction(() => store.markWritten(unwritten[unwritten.length - 1].seq))();
    }
    // ---- read the other devices' operations
    const vv = store.vv();
    const devDirs = (await listDir(join(dir, 'ops'))).filter(d => d !== me);
    const devFiles = new Map<string, DeviceFile>();
    for (const f of await listDir(join(dir, 'devices'))) {
      const m = /^([0-9a-f]{32})\.json$/.exec(f);
      if (!m) continue;
      const buf = await readLimited(join(dir, 'devices', f), MAX_SMALL_BYTES).catch(() => null);
      const d = buf && parseDeviceFile(buf, m[1]); if (d) devFiles.set(m[1], d);
    }
    const inconsistent = new Set<string>();
    const addOps = (ops: Op[]) => {
      for (const op of ops) {
        if ((vv[op.dev] ?? 0) >= op.seq) continue;
        const json = JSON.stringify(op); const ex = this.pending.get(op.id);
        if (ex && ex.json !== json) inconsistent.add(op.dev); else this.pending.set(op.id, { op, json });
      }
    };
    for (const d of devDirs) {
      if (!DEVICE_RE.test(d)) continue;
      const files = await listDir(join(dir, 'ops', d));
      const canonical = new Set(files.filter(f => OPS_FILE_RE.test(f)));
      for (const f of files) {
        if (f.startsWith('.tmp-') || f.startsWith('.')) continue;
        const path = join(dir, 'ops', d, f);
        const m = OPS_FILE_RE.exec(f) ?? /^(\d{10})-(\d{10})\b.*\.json$/i.exec(f);
        if (!m) continue;
        const from = Number(m[1]), to = Number(m[2]);
        const isCopy = !OPS_FILE_RE.test(f);
        if (!isCopy && to <= (vv[d] ?? 0)) continue;
        const st = await fsp.lstat(path).catch(() => null); if (!st?.isFile()) continue;
        const sig = `${st.size}:${st.mtimeMs}`;
        if (this.seenFiles.get(path) === sig) continue;
        try {
          const buf = await readLimited(path, MAX_OPS_BYTES);
          const ops = parseOpsFile(buf, budgetId, d, from, to);
          if (isCopy) {
            const orig = `${m[1]}-${m[2]}.json`;
            const same = canonical.has(orig) && (await readLimited(join(dir, 'ops', d, orig), MAX_OPS_BYTES).catch(() => null))?.equals(buf);
            if (!same) warnings.push({ code: 'CONFLICTED_COPY', message: 'Your sync service made a copy of a file ("conflicted copy"). Its content was checked and used; the copy was left in place.', file: `ops/${d}/${f}` });
          }
          addOps(ops); this.seenFiles.set(path, sig); this.firstBad.delete(path);
        } catch (e) {
          const fe = e as FolderError;
          if (fe.code === 'TOO_NEW') return this.fail('error', 'Another computer uses a newer version of Budget Reborn. Update Budget Reborn on this computer to continue synchronising. Your changes are saved here.');
          if (fe.code === 'FOREIGN') { warnings.push({ code: 'FOREIGN_FILE', message: 'A file from a different budget is in this folder and was ignored.', file: `ops/${d}/${f}` }); this.seenFiles.set(path, sig); continue; }
          const first = this.firstBad.get(path) ?? Date.now(); this.firstBad.set(path, first);
          if (Date.now() - first > DAMAGED_AFTER_MS || Date.now() - st.mtimeMs > DAMAGED_AFTER_MS) warnings.push({ code: 'DAMAGED_FILE', message: `A file in the sync folder is damaged (${fe.message}) and was not used.`, file: `ops/${d}/${f}` });
        }
      }
    }
    // other kinds of copies made by sync services: never deleted, only reported if they differ
    for (const f of await listDir(dir)) if (f !== MANIFEST && /^budget-reborn.*\.json$/i.test(f)) {
      const a = await readLimited(join(dir, f), MAX_SMALL_BYTES).catch(() => null); const b = await readLimited(join(dir, MANIFEST), MAX_SMALL_BYTES).catch(() => null);
      if (!a || !b || !a.equals(b)) warnings.push({ code: 'CONFLICTED_COPY', message: 'Your sync service made a copy of the budget description. The original is used; the copy was left in place.', file: f });
    }
    if (inconsistent.size) warnings.push({ code: 'INCONSISTENT', message: 'Another computer wrote two different versions of the same change. Its changes are not applied until this is cleared up (for example two installations sharing one identity).' });
    // ---- apply in causal order: an operation only after everything it depends on, each exactly once
    let applied = 0;
    for (let progress = true; progress;) {
      progress = false;
      const cur = store.vv();
      const list = [...this.pending.values()].map(p => p.op).sort((a, b) => (a.dev === b.dev ? a.seq - b.seq : a.dev < b.dev ? -1 : 1));
      for (const op of list) {
        if (store.seen(op)) { this.pending.delete(op.id); continue; }
        if (inconsistent.has(op.dev) || !store.ready(op, cur)) continue;
        const problem = this.incompatible(op);
        if (problem) return this.fail('error', problem);
        store.apply(op); this.pending.delete(op.id); applied++; progress = true;
        break; // re-read the version vector after every operation
      }
    }
    // ---- status
    const vvNow = store.vv();
    let waiting = 0; const waitingFrom = new Set<string>();
    for (const p of this.pending.values()) if (!store.seen(p.op)) { waiting++; waitingFrom.add(p.op.dev); }
    for (const [d, f] of devFiles) if (d !== me && f.ownSeq > (vvNow[d] ?? 0)) { waitingFrom.add(d); waiting = Math.max(waiting, 1); }
    const conflicts = store.openConflictCount();
    // ---- snapshot for new devices (only from a consistent state)
    if (!conflicts && !waiting) {
      const total = Object.values(vvNow).reduce((a, b) => a + b, 0);
      const last = Number(store.get('snapshot_total') ?? 0); const at = Date.parse(store.get('snapshot_at') ?? '') || 0;
      if (total - last >= SNAPSHOT_EVERY_OPS || (total > last && Date.now() - at > SNAPSHOT_MAX_AGE_MS)) await writeSnapshot(store, dir, budgetId).catch(() => {});
    }
    // ---- this device's status file (only when something changed, or as a heartbeat)
    const df = deviceFile(this.mgr, store); const dfKey = df.replace(/"at": "[^"]*"/, '');
    if (dfKey !== this.lastDeviceFile || Date.now() - this.lastDeviceWrite > DEVICE_HEARTBEAT_MS) {
      await atomicWrite(join(dir, 'devices', me + '.json'), df).then(() => { this.lastDeviceFile = dfKey; this.lastDeviceWrite = Date.now(); }).catch(() => {});
    }
    const mySeq = store.ownSeq();
    const devices: SyncDevice[] = [{ id: me, name: this.mgr.deviceName, isThis: true, lastSeen: nowIso(), app: APP_VERSION, hasAllMine: true }];
    for (const [d, f] of devFiles) if (d !== me) devices.push({ id: d, name: f.name || 'Computer', isThis: false, lastSeen: f.at || null, app: f.app, hasAllMine: (f.vv[me] ?? 0) >= mySeq });
    const pendingOwn = store.unwritten().length;
    const state: SyncState = conflicts ? 'conflict' : pendingOwn ? 'pending' : waiting ? 'waiting' : 'synced';
    const now = nowIso();
    if (state === 'synced' || state === 'conflict') store.db.transaction(() => store.set('last_synced_at', now))();
    this.status = {
      state, deviceId: me, folder: dir, lastCheckAt: now, lastSyncedAt: state === 'synced' || state === 'conflict' ? now : this.status.lastSyncedAt,
      message: state === 'conflict' ? `${conflicts} change${conflicts === 1 ? '' : 's'} made on two computers at the same time need${conflicts === 1 ? 's' : ''} your decision.`
        : state === 'waiting' ? `Waiting for files from ${waitingFrom.size === 1 ? 'another computer' : `${waitingFrom.size} computers`} — your sync service may still be copying them.`
        : state === 'pending' ? 'Your changes are saved on this computer and waiting to be written to the sync folder.' : null,
      pendingOwn, waiting, conflicts, warnings, devices,
    };
    if (applied) this.svc.version++;
    return this.status;
  }
  /** An operation this version cannot apply without guessing (made by a newer version with other tables or columns). */
  private incompatible(op: Op): string | null {
    const msg = 'Another computer uses a newer version of Budget Reborn. Update Budget Reborn on this computer to continue synchronising. Your changes are saved here.';
    if (op.schema > BUDGET_SCHEMA_VERSION) return msg;
    for (const c of op.changes) {
      if (!SYNC_TABLES[c.t]) return msg;
      const cols = syncColumns(this.svc.db, c.t);
      for (const r of [c.a, c.f, c.b]) if (r) for (const k of Object.keys(r)) if (!cols.includes(k)) return msg;
    }
    return null;
  }
}
