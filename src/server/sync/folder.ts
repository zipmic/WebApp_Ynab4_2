/**
 * The shared budget folder. Plain files only, so it works with any sync service (Dropbox, OneDrive, Google Drive,
 * iCloud Drive, Syncthing, a NAS share or a USB disk) and with none.
 *
 *   <folder>/budget-reborn.json                  manifest: protocol version, budget id, name (written once)
 *   <folder>/devices/<deviceId>.json             each device's own status: what it has processed, app version
 *   <folder>/ops/<deviceId>/<from>-<to>.json     operations of one device, immutable, numbered, with checksum
 *   <folder>/snapshots/<deviceId>-<n>-<time>.json.gz   complete state, for new devices
 *
 * Every file is written by exactly one device and never changed afterwards (except that device's own status file),
 * so two devices never write the same file. Writes go to a temporary file in the same folder, are flushed to disk
 * and then renamed into place, so a reader sees either nothing or the complete file. Everything read from the
 * folder is treated as untrusted input: size limits, strict validation, checksums, no paths taken from file contents.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Change, Op, Row, Val } from './capture.ts';
import { SYNC_TABLES } from './capture.ts';
import { DEVICE_RE, type Snapshot, SYNC_PROTOCOL } from './store.ts';

export const MANIFEST = 'budget-reborn.json';
export const OPS_FILE_RE = /^(\d{10})-(\d{10})\.json$/;
export const SNAPSHOT_RE = /^([0-9a-f]{32})-(\d{10})-(\d{8}T\d{6}Z)\.json\.gz$/;
const BUDGET_ID_RE = /^[0-9a-f]{24}$/;
const MAX_OPS_FILE = 256 * 1024 * 1024;
const MAX_SNAPSHOT = 512 * 1024 * 1024;
const MAX_SMALL = 1024 * 1024;

export interface Manifest { format: 'budget-reborn-budget'; protocol: number; budgetId: string; name: string; createdAt: string }
export interface DeviceFile { format: 'budget-reborn-device'; protocol: number; deviceId: string; name: string; app: string; schema: number; vv: Record<string, number>; ownSeq: number; at: string }

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const pad = (n: number) => String(n).padStart(10, '0');
export class FolderError extends Error { constructor(public code: string, message: string) { super(message); } }

/** Write a complete file atomically: temporary file in the same folder → flush → rename. */
export async function atomicWrite(path: string, data: string | Buffer) {
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  const fh = await fsp.open(tmp, 'wx', 0o600);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  try { await fsp.rename(tmp, path); } catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
  // make the rename itself durable where the platform allows it (not on Windows, where directories cannot be opened)
  try { const d = await fsp.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* best effort */ }
}
/** Reads a regular file (never a link) up to a size limit. */
export async function readLimited(path: string, max: number): Promise<Buffer> {
  const st = await fsp.lstat(path);
  if (!st.isFile()) throw new FolderError('NOT_A_FILE', 'not a regular file');
  if (st.size > max) throw new FolderError('TOO_LARGE', 'file too large');
  return fsp.readFile(path);
}
export async function listDir(path: string): Promise<string[]> { try { return await fsp.readdir(path); } catch { return []; } }
export async function exists(path: string) { try { await fsp.stat(path); return true; } catch { return false; } }

// ------------------------------------------------------------------ validation of untrusted content
const isVal = (v: unknown): v is Val => v === null || (typeof v === 'string' && v.length <= 1_000_000) || (typeof v === 'number' && Number.isSafeInteger(v));
function isRow(r: unknown): r is Row {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return false;
  const keys = Object.keys(r); if (keys.length > 64) return false;
  return keys.every(k => /^[a-z_]{1,40}$/.test(k) && isVal((r as Record<string, unknown>)[k]));
}
function validChange(c: any): c is Change {
  if (typeof c !== 'object' || c === null || !SYNC_TABLES[c.t] || typeof c.k !== 'string' || !c.k || c.k.length > 512) return false;
  const n = (c.a !== undefined ? 1 : 0) + (c.f !== undefined ? 1 : 0) + (c.d !== undefined ? 1 : 0);
  if (n !== 1) return false;
  if (c.d !== undefined && c.d !== 1) return false;
  if (c.e !== undefined && (c.e !== 1 || c.a === undefined)) return false;
  if (c.a !== undefined && !isRow(c.a)) return false;
  if (c.f !== undefined && (!isRow(c.f) || !Object.keys(c.f).length)) return false;
  if (c.b !== undefined && c.b !== null && !isRow(c.b)) return false;
  if (SYNC_TABLES[c.t].key.length > 1) { try { const k = JSON.parse(c.k); if (!Array.isArray(k) || k.length !== SYNC_TABLES[c.t].key.length || !k.every(isVal)) return false; } catch { return false; } }
  return true;
}
export function validOp(o: any, dev: string): o is Op {
  return typeof o === 'object' && o !== null && o.dev === dev && Number.isSafeInteger(o.seq) && o.seq > 0 && o.id === `${dev}:${o.seq}`
    && typeof o.deps === 'object' && o.deps !== null && !Array.isArray(o.deps)
    && Object.entries(o.deps).every(([d, s]) => DEVICE_RE.test(d) && d !== dev && Number.isSafeInteger(s) && (s as number) >= 0)
    && typeof o.at === 'string' && o.at.length <= 40 && typeof o.label === 'string' && o.label.length <= 200 && Number.isSafeInteger(o.schema)
    && Array.isArray(o.changes) && o.changes.length <= 2_000_000 && o.changes.every(validChange)
    && (o.resolves === undefined || (Array.isArray(o.resolves) && o.resolves.length <= 10_000 && o.resolves.every((r: unknown) => typeof r === 'string' && r.length <= 80)));
}

function validWriters(ws: unknown): boolean {
  if (typeof ws !== 'string' || ws.length > 1_000_000) return false;
  try { const a = JSON.parse(ws); return Array.isArray(a) && a.length > 0 && a.length <= 1000 && a.every(x => Array.isArray(x) && (x.length === 2 || x.length === 3) && DEVICE_RE.test(x[0]) && Number.isSafeInteger(x[1]) && (x.length === 2 || isVal(x[2]))); } catch { return false; }
}

// ------------------------------------------------------------------ operation batches
export function opsFileContent(budgetId: string, dev: string, ops: Op[]): string {
  const from = ops[0].seq, to = ops[ops.length - 1].seq;
  return JSON.stringify({ format: 'budget-reborn-ops', protocol: SYNC_PROTOCOL, budgetId, dev, from, to, sha256: sha256(JSON.stringify(ops)), ops });
}
/** Parses and verifies an operation batch. Throws FolderError('INCOMPLETE' | 'CORRUPT' | 'FOREIGN' | 'TOO_NEW'). */
export function parseOpsFile(buf: Buffer, budgetId: string, dev: string, from: number, to: number): Op[] {
  let doc: any;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new FolderError('INCOMPLETE', 'the file is incomplete or not valid JSON'); }
  if (doc?.format !== 'budget-reborn-ops') throw new FolderError('CORRUPT', 'not an operations file');
  if (!Number.isSafeInteger(doc.protocol) || doc.protocol > SYNC_PROTOCOL) throw new FolderError('TOO_NEW', 'written by a newer version of Budget Reborn');
  if (doc.budgetId !== budgetId) throw new FolderError('FOREIGN', 'belongs to a different budget');
  if (doc.dev !== dev || doc.from !== from || doc.to !== to || !Array.isArray(doc.ops) || doc.ops.length !== to - from + 1) throw new FolderError('CORRUPT', 'the file does not match its name');
  if (doc.sha256 !== sha256(JSON.stringify(doc.ops))) throw new FolderError('CORRUPT', 'checksum mismatch');
  doc.ops.forEach((o: any, i: number) => { if (!validOp(o, dev) || o.seq !== from + i) throw new FolderError('CORRUPT', 'invalid operation'); });
  return doc.ops as Op[];
}

// ------------------------------------------------------------------ manifest, device files, snapshots
export function parseManifest(buf: Buffer): Manifest {
  let m: any; try { m = JSON.parse(buf.toString('utf8')); } catch { throw new FolderError('INCOMPLETE', 'The budget folder description (budget-reborn.json) is incomplete or damaged.'); }
  if (m?.format !== 'budget-reborn-budget' || !BUDGET_ID_RE.test(m.budgetId ?? '') || typeof m.name !== 'string') throw new FolderError('CORRUPT', 'This is not a Budget Reborn budget folder.');
  if (!Number.isSafeInteger(m.protocol) || m.protocol > SYNC_PROTOCOL) throw new FolderError('TOO_NEW', 'This budget folder was created by a newer version of Budget Reborn. Update Budget Reborn on this computer to keep synchronising.');
  return { format: m.format, protocol: m.protocol, budgetId: m.budgetId, name: m.name.slice(0, 100), createdAt: String(m.createdAt ?? '').slice(0, 40) };
}
export async function readManifest(dir: string): Promise<Manifest> {
  let buf: Buffer;
  try { buf = await readLimited(join(dir, MANIFEST), MAX_SMALL); } catch { throw new FolderError('NO_MANIFEST', 'This folder does not contain a Budget Reborn budget (budget-reborn.json is missing).'); }
  return parseManifest(buf);
}
export function parseDeviceFile(buf: Buffer, id: string): DeviceFile | null {
  try {
    const d = JSON.parse(buf.toString('utf8'));
    if (d?.format !== 'budget-reborn-device' || d.deviceId !== id || typeof d.vv !== 'object' || d.vv === null) return null;
    const vv: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.vv)) if (DEVICE_RE.test(k) && Number.isSafeInteger(v)) vv[k] = v as number;
    return { format: d.format, protocol: Number(d.protocol) || 0, deviceId: id, name: String(d.name ?? '').slice(0, 80), app: String(d.app ?? '').slice(0, 30),
      schema: Number(d.schema) || 0, vv, ownSeq: Number.isSafeInteger(d.ownSeq) ? d.ownSeq : 0, at: String(d.at ?? '').slice(0, 40) };
  } catch { return null; }
}
export function snapshotContent(budgetId: string, dev: string, schema: number, snap: Snapshot): Buffer {
  const body = JSON.stringify(snap);
  return gzipSync(JSON.stringify({ format: 'budget-reborn-snapshot', protocol: SYNC_PROTOCOL, schema, budgetId, dev, at: new Date().toISOString(), sha256: sha256(body), snapshot: body }));
}
export function parseSnapshot(buf: Buffer, budgetId: string): { schema: number; snapshot: Snapshot } {
  let doc: any;
  try { doc = JSON.parse(gunzipSync(buf, { maxOutputLength: 2 * MAX_SNAPSHOT }).toString('utf8')); } catch { throw new FolderError('INCOMPLETE', 'snapshot incomplete'); }
  if (doc?.format !== 'budget-reborn-snapshot' || typeof doc.snapshot !== 'string') throw new FolderError('CORRUPT', 'not a snapshot');
  if (!Number.isSafeInteger(doc.protocol) || doc.protocol > SYNC_PROTOCOL) throw new FolderError('TOO_NEW', 'snapshot from a newer version');
  if (doc.budgetId !== budgetId) throw new FolderError('FOREIGN', 'snapshot of another budget');
  if (doc.sha256 !== sha256(doc.snapshot)) throw new FolderError('CORRUPT', 'snapshot checksum mismatch');
  const s = JSON.parse(doc.snapshot);
  const ok = typeof s === 'object' && s && typeof s.vv === 'object' && typeof s.tables === 'object' && Array.isArray(s.writers) && Array.isArray(s.oplog)
    && Object.entries(s.vv).every(([d, n]) => DEVICE_RE.test(d) && Number.isSafeInteger(n))
    && Object.entries(s.tables).every(([t, rows]) => SYNC_TABLES[t] && Array.isArray(rows) && (rows as unknown[]).every(isRow))
    && s.writers.every((w: any) => Array.isArray(w) && w.length === 4 && SYNC_TABLES[w[0]] && typeof w[1] === 'string' && typeof w[2] === 'string' && w[2].length <= 40 && validWriters(w[3]))
    && s.oplog.every((o: any) => Array.isArray(o) && o.length === 4 && DEVICE_RE.test(o[0]) && Number.isSafeInteger(o[1]) && typeof o[2] === 'string' && o[2].length < 100_000 && typeof o[3] === 'string' && o[3].length < 50_000_000);
  if (!ok) throw new FolderError('CORRUPT', 'snapshot content invalid');
  return { schema: Number(doc.schema) || 0, snapshot: s as Snapshot };
}
export async function readSnapshotFile(path: string, budgetId: string) { return parseSnapshot(await readLimited(path, MAX_SNAPSHOT), budgetId); }
export const MAX_OPS_BYTES = MAX_OPS_FILE;
export const MAX_SMALL_BYTES = MAX_SMALL;

/** "<name> (Budget Reborn)" made safe as a folder name on Windows, macOS and Linux. */
export function folderNameFor(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'Budget';
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? `${clean}_ (Budget Reborn)` : `${clean} (Budget Reborn)`;
}
