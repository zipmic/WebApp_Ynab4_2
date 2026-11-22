/**
 * File-based sync between independent installations ("devices"), each with its own data folder and database.
 * The shared folder is a plain directory; a small "cloud" simulator copies files between per-device folders to
 * reproduce what sync services do: delays, files arriving out of order or half-written, duplicates and
 * "conflicted copy" files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { loadConfig } from '../../src/server/config.ts';
import { Core } from '../../src/server/core.ts';
import { SyncStore } from '../../src/server/sync/store.ts';
import { MANIFEST } from '../../src/server/sync/folder.ts';

const tmp = (p = 'br-sync-') => mkdtempSync(join(tmpdir(), p));
const cores: Core[] = [];
afterEach(() => { for (const c of cores.splice(0)) { try { c.close(); } catch { /* closed */ } } });
function device(dataDir = tmp()): Core { const c = new Core(loadConfig({ BR_DATA_DIR: dataDir, BR_DESKTOP: '1' }), { syncAuto: false }); cores.push(c); return c; }

/** Everything that must be identical on all devices: primary data and the budget numbers computed from it. */
function fingerprint(c: Core, id: string) {
  const s = c.service(id); const snap = new SyncStore(s, 'x').exportSnapshot();
  const tables: Record<string, string[]> = {};
  for (const [t, rows] of Object.entries(snap.tables)) tables[t] = rows.map(r => JSON.stringify(r)).sort();
  const months = ['2026-01', '2026-02', '2026-03'].map(m => s.getBudget(m));
  return { tables, months: JSON.stringify(months), accounts: JSON.stringify(s.listAccounts().map(a => ({ ...a }))) };
}
function setup() {
  const a = device(); const svc = a.createBudget('Household');
  const checking = svc.createAccount({ name: 'Checking', type: 'checking', balance: 1_000_00, date: '2026-01-01' });
  const savings = svc.createAccount({ name: 'Savings', type: 'savings', balance: 5_000_00, date: '2026-01-01' });
  const g = svc.createGroup('Everyday'); const food = svc.createCategory(g, 'Food'); const fun = svc.createCategory(g, 'Fun');
  svc.setBudget('2026-01', food, { budgeted: 400_00 });
  svc.createTransaction({ accountId: checking, date: '2026-01-14', amount: -123_45, payeeName: 'Grocer', categoryId: food });
  return { a, aid: svc.id, checking, savings, food, fun };
}
async function pair() {
  const x = setup(); const shared = tmp('br-shared-');
  const { folder } = await x.a.sync!.publish(x.aid, shared);
  const b = device(); const { id: bid } = await b.sync!.join(folder);
  return { ...x, b, bid, folder };
}
const sa = (c: Core, id: string) => c.service(id);
const sync = async (...ds: [Core, string][]) => { for (let i = 0; i < 2; i++) for (const [c, id] of ds) await c.sync!.syncNow(id); };

/** Per-device copies of the shared folder; `deliver` copies files like a cloud client would. */
function cloud() {
  const roots: string[] = [];
  return {
    add(root: string) { roots.push(root); },
    files(root: string): string[] {
      const out: string[] = [];
      const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (!n.startsWith('.tmp-')) out.push(relative(root, p)); } };
      walk(root); return out;
    },
    /** copy files from one device's folder to another's (optionally only some) */
    deliver(from: string, to: string, filter: (rel: string) => boolean = () => true) {
      for (const rel of this.files(from)) {
        if (!filter(rel)) continue;
        const target = join(to, rel);
        if (existsSync(target) && readFileSync(target).equals(readFileSync(join(from, rel)))) continue;
        mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(from, rel), target);
      }
    },
  };
}

describe('sync: publish and join', () => {
  it('a second computer opens the budget from the folder with identical data and numbers', async () => {
    const p = await pair();
    expect(existsSync(join(p.folder, MANIFEST))).toBe(true);
    expect(readdirSync(join(p.folder, 'snapshots')).length).toBe(1);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
    expect((await p.a.sync!.syncNow(p.aid)).state).toBe('synced');
    expect((await p.b.sync!.syncNow(p.bid)).state).toBe('synced');
    // joining the same budget twice on one computer is refused
    await expect(p.b.sync!.join(p.folder)).rejects.toThrow(/already on this computer/);
    // a folder without a budget is refused clearly
    await expect(p.b.sync!.join(tmp())).rejects.toThrow(/does not contain a Budget Reborn budget/);
  });
  it('changes on both computers (different data) merge without conflicts; both compute the same budget', async () => {
    const p = await pair();
    const A = sa(p.a, p.aid), B = sa(p.b, p.bid);
    A.createTransaction({ accountId: p.checking, date: '2026-01-15', amount: -50_00, payeeName: 'Cafe', categoryId: p.fun });
    A.setBudget('2026-01', p.fun, { budgeted: 100_00 });
    B.createTransaction({ accountId: p.checking, date: '2026-01-16', amount: -20_00, payeeName: 'Kiosk', categoryId: p.food });
    B.setBudget('2026-02', p.food, { budgeted: 380_00 });
    B.createTransaction({ accountId: p.checking, date: '2026-01-17', amount: -300_00, transferAccountId: p.savings });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
    expect(A.listTransactions({}).length).toBe(B.listTransactions({}).length);
    expect(A.checkIntegrity()).toEqual([]); expect(B.checkIntegrity()).toEqual([]);
    const st = await p.a.sync!.syncNow(p.aid);
    expect(st.state).toBe('synced'); expect(st.conflicts).toBe(0);
    expect(st.devices.find(d => !d.isThis)?.hasAllMine).toBe(true); // provable: the other device's status file says so
  });
  it('the same change on both computers is not a conflict', async () => {
    const p = await pair();
    sa(p.a, p.aid).setBudget('2026-02', p.food, { budgeted: 250_00 });
    sa(p.b, p.bid).setBudget('2026-02', p.food, { budgeted: 250_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect((await p.a.sync!.syncNow(p.aid)).conflicts).toBe(0);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('a payee typed on both computers while offline, and a scheduled transaction entered on both, are not duplicated', async () => {
    const p = await pair();
    const A = sa(p.a, p.aid), B = sa(p.b, p.bid);
    A.saveScheduled({ accountId: p.checking, nextDate: '2026-02-01', frequency: 'monthly', amount: -99_00, categoryId: p.fun, memo: 'Streaming', payeeName: 'Streamer', splits: [], flag: null, transferAccountId: null });
    await sync([p.a, p.aid], [p.b, p.bid]);
    A.createTransaction({ accountId: p.checking, date: '2026-01-20', amount: -10_00, payeeName: 'Bakery', categoryId: p.food });
    B.createTransaction({ accountId: p.checking, date: '2026-01-21', amount: -12_00, payeeName: 'Bakery', categoryId: p.food });
    expect(A.postScheduled('2026-03-15').posted).toBe(2); expect(B.postScheduled('2026-03-15').posted).toBe(2);
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect((await p.a.sync!.syncNow(p.aid)).conflicts).toBe(0); expect((await p.b.sync!.syncNow(p.bid)).conflicts).toBe(0);
    expect(A.listPayees().filter(x => x.name === 'Bakery').length).toBe(1);
    expect(A.listTransactions({}).filter(t => t.memo === 'Streaming').length).toBe(2);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('undo on one computer reaches the other', async () => {
    const p = await pair();
    const A = sa(p.a, p.aid);
    A.setBudget('2026-01', p.fun, { budgeted: 77_00 }); await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).getBudget('2026-01').rows.find(c => c.categoryId === p.fun)!.budgeted).toBe(77_00);
    A.undo(); await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).getBudget('2026-01').rows.find(c => c.categoryId === p.fun)!.budgeted).toBe(0);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
});

describe('sync: conflicts are never resolved silently', () => {
  it('the same field changed differently on both computers → a conflict on both; the user decides; both converge', async () => {
    const p = await pair();
    sa(p.a, p.aid).setBudget('2026-01', p.food, { budgeted: 450_00 });
    sa(p.b, p.bid).setBudget('2026-01', p.food, { budgeted: 500_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    const sA = await p.a.sync!.syncNow(p.aid), sB = await p.b.sync!.syncNow(p.bid);
    expect(sA.state).toBe('conflict'); expect(sB.state).toBe('conflict');
    // both versions are kept until the user decides: each computer still shows its own
    expect(sa(p.a, p.aid).getBudget('2026-01').rows.find(c => c.categoryId === p.food)!.budgeted).toBe(450_00);
    expect(sa(p.b, p.bid).getBudget('2026-01').rows.find(c => c.categoryId === p.food)!.budgeted).toBe(500_00);
    const cA = p.a.sync!.store(p.aid).conflicts();
    expect(cA.length).toBe(1); expect(cA[0].rows[0].fields).toEqual(['budgeted']);
    p.a.sync!.store(p.aid).resolve(cA[0].id, 'theirs');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(0);
    expect(p.b.sync!.store(p.bid).openConflictCount()).toBe(0); // closed on the other computer too
    expect(sa(p.a, p.aid).getBudget('2026-01').rows.find(c => c.categoryId === p.food)!.budgeted).toBe(500_00);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('different fields of the same transaction merge; edit vs delete is a conflict', async () => {
    const p = await pair();
    const t = sa(p.a, p.aid).listTransactions({}).find(x => x.amount === -123_45)!;
    sa(p.a, p.aid).updateTransaction(t.id, { memo: 'weekly shop' });
    sa(p.b, p.bid).updateTransaction(t.id, { cleared: 'cleared' });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect((await p.a.sync!.syncNow(p.aid)).conflicts).toBe(0);
    const merged = sa(p.b, p.bid).listTransactions({ ids: [t.id] })[0];
    expect(merged.memo).toBe('weekly shop'); expect(merged.cleared).toBe('cleared');
    // now: A deletes it while B changes the amount
    sa(p.a, p.aid).deleteTransactions([t.id]);
    sa(p.b, p.bid).updateTransaction(t.id, { amount: -130_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(1);
    expect(p.b.sync!.store(p.bid).openConflictCount()).toBe(1);
    // B keeps the edited transaction → it comes back on A
    const c = p.b.sync!.store(p.bid).conflicts()[0];
    p.b.sync!.store(p.bid).resolve(c.id, 'mine');
    await sync([p.b, p.bid], [p.a, p.aid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(0);
    expect(sa(p.a, p.aid).listTransactions({ ids: [t.id] })[0]?.amount).toBe(-130_00);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
    expect(sa(p.a, p.aid).checkIntegrity()).toEqual([]);
  });
  it('two computers resolving the same conflict differently get a new conflict instead of swapping values', async () => {
    const p = await pair();
    sa(p.a, p.aid).setBudget('2026-01', p.fun, { budgeted: 10_00 });
    sa(p.b, p.bid).setBudget('2026-01', p.fun, { budgeted: 20_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    p.a.sync!.store(p.aid).resolve(p.a.sync!.store(p.aid).conflicts()[0].id, 'mine');
    p.b.sync!.store(p.bid).resolve(p.b.sync!.store(p.bid).conflicts()[0].id, 'mine');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(1); expect(p.b.sync!.store(p.bid).openConflictCount()).toBe(1);
    p.b.sync!.store(p.bid).resolve(p.b.sync!.store(p.bid).conflicts()[0].id, 'theirs');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(0); expect(p.b.sync!.store(p.bid).openConflictCount()).toBe(0);
    expect(sa(p.b, p.bid).getBudget('2026-01').rows.find(c => c.categoryId === p.fun)!.budgeted).toBe(10_00);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('a change that cannot be applied (its category was deleted here) becomes a conflict, not an error', async () => {
    const p = await pair();
    const B = sa(p.b, p.bid);
    sa(p.a, p.aid).deleteCategory(p.fun, p.food);
    B.createTransaction({ accountId: p.checking, date: '2026-01-22', amount: -5_00, payeeName: 'Arcade', categoryId: p.fun });
    await sync([p.a, p.aid], [p.b, p.bid]);
    const cs = p.a.sync!.store(p.aid).conflicts();
    expect(cs.some(c => c.kind === 'cannot_apply' && /deleted/.test(c.message))).toBe(true);
    expect(sa(p.a, p.aid).checkIntegrity()).toEqual([]); expect(B.checkIntegrity()).toEqual([]);
  });
});

describe('sync: unreliable folders', () => {
  it('files arriving out of order, half-written, duplicated or as "conflicted copies" are handled safely', async () => {
    const x = setup(); const fa = tmp('br-cloudA-'); const fb = tmp('br-cloudB-');
    const net = cloud();
    const { folder: rootA } = await x.a.sync!.publish(x.aid, fa);
    const rootB = join(fb, 'copy'); net.deliver(rootA, rootB);
    const b = device(); const { id: bid } = await b.sync!.join(rootB);
    const B = sa(b, bid);
    // three separate cycles on B → three operation files
    for (const amt of [1, 2, 3]) { B.createTransaction({ accountId: x.checking, date: '2026-01-2' + amt, amount: -amt * 100, payeeName: 'Shop ' + amt, categoryId: x.food }); await b.sync!.syncNow(bid); }
    const opsDir = (root: string) => join(root, 'ops', b.sync!.deviceId);
    const files = readdirSync(opsDir(rootB)).filter(f => f.endsWith('.json')).sort();
    expect(files.length).toBe(3);
    // the newest file arrives first → A waits, applies nothing
    net.deliver(rootB, rootA, r => r.endsWith(files[2]));
    let st = await x.a.sync!.syncNow(x.aid);
    expect(st.state).toBe('waiting'); expect(sa(x.a, x.aid).listTransactions({}).length).toBe(3);
    // the first file arrives half-written → still waiting, nothing applied
    mkdirSync(opsDir(rootA), { recursive: true });
    const full = readFileSync(join(opsDir(rootB), files[0]));
    writeFileSync(join(opsDir(rootA), files[0]), full.subarray(0, full.length >> 1));
    st = await x.a.sync!.syncNow(x.aid);
    expect(st.state).toBe('waiting'); expect(sa(x.a, x.aid).listTransactions({}).length).toBe(3);
    // the rest arrives (and the first file is completed) → all applied, exactly once
    net.deliver(rootB, rootA);
    st = await x.a.sync!.syncNow(x.aid);
    expect(sa(x.a, x.aid).listTransactions({}).length).toBe(6);
    // a duplicate delivery under a "conflicted copy" name with identical content: ignored quietly
    copyFileSync(join(opsDir(rootA), files[1]), join(opsDir(rootA), files[1].replace('.json', ' (conflicted copy 2026-11-22).json')));
    st = await x.a.sync!.syncNow(x.aid);
    expect(st.warnings).toEqual([]); expect(sa(x.a, x.aid).listTransactions({}).length).toBe(6);
    // a conflicted copy of the manifest that differs is reported, never deleted
    writeFileSync(join(rootA, 'budget-reborn (Laptop\'s conflicted copy).json'), '{"other":true}');
    st = await x.a.sync!.syncNow(x.aid);
    expect(st.warnings.some(w => w.code === 'CONFLICTED_COPY')).toBe(true);
    expect(existsSync(join(rootA, 'budget-reborn (Laptop\'s conflicted copy).json'))).toBe(true);
    // back to B: both converge
    net.deliver(rootA, rootB); await b.sync!.syncNow(bid);
    expect(fingerprint(b, bid)).toEqual(fingerprint(x.a, x.aid));
  });
  it('a damaged file (checksum mismatch) is never applied and is reported once it is clearly not still arriving', async () => {
    const p = await pair();
    sa(p.b, p.bid).createTransaction({ accountId: p.checking, date: '2026-01-25', amount: -1_00, payeeName: 'X', categoryId: p.food });
    await p.b.sync!.syncNow(p.bid);
    const dir = join(p.folder, 'ops', p.b.sync!.deviceId); const f = readdirSync(dir).find(n => n.endsWith('.json'))!;
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); doc.ops[0].changes[0].a.amount = -999_999_00;
    writeFileSync(join(dir, f), JSON.stringify(doc)); const old = new Date(Date.now() - 3600_000); utimesSync(join(dir, f), old, old);
    const st = await p.a.sync!.syncNow(p.aid);
    expect(st.warnings.some(w => w.code === 'DAMAGED_FILE')).toBe(true);
    expect(sa(p.a, p.aid).listTransactions({}).some(t => t.amount === -999_999_00)).toBe(false);
  });
  it('a folder or operation from a newer version stops synchronisation with an explanation and writes nothing', async () => {
    const p = await pair();
    const m = JSON.parse(readFileSync(join(p.folder, MANIFEST), 'utf8')); m.protocol = 99; writeFileSync(join(p.folder, MANIFEST), JSON.stringify(m));
    sa(p.a, p.aid).setBudget('2026-01', p.fun, { budgeted: 1_00 });
    const st = await p.a.sync!.syncNow(p.aid);
    expect(st.state).toBe('error'); expect(st.message).toMatch(/newer version/);
    expect(st.pendingOwn).toBe(1); // kept safely on this computer
    expect(readdirSync(join(p.folder, 'ops', p.a.sync!.deviceId)).length).toBe(0);
  });
  it('an unavailable folder keeps changes locally and writes them later; a restart loses nothing', async () => {
    const p = await pair();
    const realFolder = p.folder; const moved = realFolder + '-offline';
    (await import('node:fs')).renameSync(realFolder, moved);
    sa(p.a, p.aid).setBudget('2026-03', p.food, { budgeted: 333_00 });
    expect((await p.a.sync!.syncNow(p.aid)).state).toBe('unavailable');
    // restart computer A before the folder is back
    const dataDir = p.a.cfg.dataDir; p.a.close(); cores.splice(cores.indexOf(p.a), 1);
    const a2 = device(dataDir);
    (await import('node:fs')).renameSync(moved, realFolder);
    await sync([a2, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).getBudget('2026-03').rows.find(c => c.categoryId === p.food)!.budgeted).toBe(333_00);
  });
  it('an operation exists exactly when its change was committed', async () => {
    const p = await pair();
    const A = sa(p.a, p.aid); const store = p.a.sync!.store(p.aid);
    const before = store.ownSeq();
    expect(() => A.mutate('boom', () => { A.setBudget('2026-01', p.food, { budgeted: 1 }); throw new Error('boom'); })).toThrow('boom');
    expect(store.ownSeq()).toBe(before); expect(store.unwritten().length).toBe(0);
    A.setBudget('2026-01', p.food, { budgeted: 2 });
    expect(store.ownSeq()).toBe(before + 1);
  });
  it('another installation using this computer\'s identity is detected and synchronisation stops', async () => {
    const p = await pair();
    const dir = join(p.folder, 'ops', p.a.sync!.deviceId);
    writeFileSync(join(dir, '0000000005-0000000006.json'), '{}');
    const st = await p.a.sync!.syncNow(p.aid);
    expect(st.state).toBe('error'); expect(st.message).toMatch(/identity/);
  });
});

describe('sync: new devices, backups, restore', () => {
  it('a third computer that joins later starts from a snapshot and ends up identical', async () => {
    const p = await pair();
    sa(p.a, p.aid).createTransaction({ accountId: p.checking, date: '2026-02-02', amount: -42_00, payeeName: 'Late', categoryId: p.fun });
    sa(p.b, p.bid).setBudget('2026-02', p.fun, { budgeted: 60_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    const c = device(); const { id: cid } = await c.sync!.join(p.folder);
    await sync([c, cid]);
    expect(fingerprint(c, cid)).toEqual(fingerprint(p.a, p.aid));
    sa(c, cid).setBudget('2026-03', p.fun, { budgeted: 5_00 });
    await sync([c, cid], [p.a, p.aid], [p.b, p.bid]);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(c, cid));
  });
  it('restoring a backup creates a separate local budget and never rolls back the other computers', async () => {
    const p = await pair();
    const name = p.a.backup(p.aid, 'manual');
    const bytes = readFileSync(p.a.backupPath(p.aid, name));
    const r = p.a.restore(bytes, 'Restored copy');
    expect(r.id).not.toBe(p.aid);
    expect((await p.a.sync!.status(r.id)).state).toBe('local');
    sa(p.a, r.id).setBudget('2026-01', p.food, { budgeted: 1_00 }); // a change in the restored copy …
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).getBudget('2026-01').rows.find(c => c.categoryId === p.food)!.budgeted).toBe(400_00); // … never reaches the shared budget
  });
  it('moving to another folder copies the budget there and leaves the old folder untouched', async () => {
    const p = await pair();
    const before = new Set(cloud().files(p.folder));
    const target = join(tmp('br-move-'), 'Budget');
    mkdirSync(target);
    const r = await p.a.sync!.relink(p.aid, target);
    expect(r.copied).toBeGreaterThan(2);
    expect(new Set(cloud().files(p.folder))).toEqual(before);
    sa(p.a, p.aid).setBudget('2026-01', p.fun, { budgeted: 3_00 });
    expect((await p.a.sync!.syncNow(p.aid)).state).toBe('synced');
    // B follows by choosing the new folder (it contains the same budget)
    await p.b.sync!.relink(p.bid, target);
    await sync([p.b, p.bid]);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
    await expect(p.b.sync!.relink(p.bid, tmp())).resolves.toBeTruthy(); // an empty folder: copy
    const other = await (async () => { const q = setup(); return (await q.a.sync!.publish(q.aid, tmp())).folder; })();
    await expect(p.b.sync!.relink(p.bid, other)).rejects.toThrow(/different budget/);
  });
});

describe('sync: randomized two- and three-computer sessions converge', () => {
  // deterministic pseudo-random generator so a failure can be reproduced
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const seeds = process.env.SYNC_SEEDS ? Array.from({ length: Number(process.env.SYNC_SEEDS) }, (_, i) => i + 1) : [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) it(`seed ${seed}`, async () => {
    const rnd = rng(seed); const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const p = await pair();
    const devs: [Core, string][] = [[p.a, p.aid], [p.b, p.bid]];
    if (seed % 2) { const c = device(); devs.push([c, (await c.sync!.join(p.folder)).id]); }
    for (let step = 0; step < 60; step++) {
      const [c, id] = pick(devs); const s = sa(c, id);
      const txns = s.listTransactions({}).filter(t => !t.transferAccountId);
      const cats = s.listCategories().filter(x => !x.hidden);
      const r = rnd();
      try {
        if (r < 0.25) s.createTransaction({ accountId: p.checking, date: `2026-0${1 + Math.floor(rnd() * 3)}-1${Math.floor(rnd() * 9)}`, amount: -Math.floor(rnd() * 10000), payeeName: pick(['A', 'B', 'C', 'Shop']), categoryId: pick(cats).id });
        else if (r < 0.4 && txns.length) s.updateTransaction(pick(txns).id, { amount: -Math.floor(rnd() * 10000) });
        else if (r < 0.5 && txns.length) s.updateTransaction(pick(txns).id, { memo: pick(['x', 'y', 'z']) });
        else if (r < 0.58 && txns.length) s.deleteTransactions([pick(txns).id]);
        else if (r < 0.75) s.setBudget(`2026-0${1 + Math.floor(rnd() * 3)}`, pick(cats).id, { budgeted: Math.floor(rnd() * 5) * 10000 });
        else if (r < 0.8) s.createTransaction({ accountId: p.checking, date: '2026-02-11', amount: -Math.floor(rnd() * 5000), transferAccountId: p.savings });
        else if (r < 0.85) s.createCategory(cats[0].groupId, pick(['New', 'Other']));
        else if (r < 0.9 && cats.length) s.updateCategory(pick(cats).id, { name: pick(['Renamed', 'Food', 'Fun2']) });
        else await c.sync!.syncNow(id);
      } catch (e) { if (!/not found|NOT_FOUND|reconciled/i.test(String((e as Error).message))) throw e; }
    }
    // settle: synchronise everything, resolve every conflict with a random choice, until quiet
    for (let round = 0; round < 40; round++) {
      for (const [c, id] of devs) await c.sync!.syncNow(id);
      for (const [c, id] of devs) await c.sync!.syncNow(id);
      const withConflict = devs.find(([c, id]) => c.sync!.store(id).openConflictCount() > 0);
      if (!withConflict) break;
      const st = withConflict[0].sync!.store(withConflict[1]); const cf = st.conflicts()[0];
      try { st.resolve(cf.id, rnd() < 0.5 ? 'mine' : 'theirs'); } catch { st.resolve(cf.id, 'mine'); }
    }
    for (const [c, id] of devs) { expect(c.sync!.store(id).openConflictCount()).toBe(0); expect(sa(c, id).checkIntegrity()).toEqual([]); }
    const f0 = fingerprint(devs[0][0], devs[0][1]);
    for (const [c, id] of devs.slice(1)) {
      const f = fingerprint(c, id);
      if (process.env.SYNC_DEBUG) for (const t of Object.keys(f0.tables)) { const x = f0.tables[t].filter(r => !f.tables[t].includes(r)), y = f.tables[t].filter(r => !f0.tables[t].includes(r)); if (x.length || y.length) console.log(t, '\nA:', x, '\nB:', y); }
      expect(f).toEqual(f0);
    }
  });
});

describe('sync: randomized sessions through a slow, unreliable cloud (separate folder per computer)', () => {
  const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const seeds = process.env.SYNC_SEEDS ? Array.from({ length: Number(process.env.SYNC_SEEDS) }, (_, i) => i + 1000) : [1001, 1002, 1003, 1004];
  for (const seed of seeds) it(`seed ${seed}`, async () => {
    const rnd = rng(seed); const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const x = setup(); const net = cloud();
    const { folder: rootA } = await x.a.sync!.publish(x.aid, tmp());
    const devs: { c: Core; id: string; root: string }[] = [{ c: x.a, id: x.aid, root: rootA }];
    for (let i = 0; i < 1 + (seed % 2); i++) {
      const root = join(tmp(), 'copy'); net.deliver(rootA, root);
      const c = device(); devs.push({ c, id: (await c.sync!.join(root)).id, root });
    }
    const sched = sa(x.a, x.aid).saveScheduled({ accountId: x.checking, nextDate: '2026-01-05', frequency: 'weekly', amount: -15_00, categoryId: x.fun, memo: 'Weekly', payeeName: 'Club', splits: [], flag: null, transferAccountId: null });
    void sched;
    for (let step = 0; step < 80; step++) {
      const d = pick(devs); const s = sa(d.c, d.id);
      const txns = s.listTransactions({}).filter(t => !t.transferAccountId);
      const cats = s.listCategories().filter(c => !c.hidden);
      const r = rnd();
      try {
        if (r < 0.18) s.createTransaction({ accountId: x.checking, date: `2026-0${1 + Math.floor(rnd() * 3)}-1${Math.floor(rnd() * 9)}`, amount: -Math.floor(rnd() * 10000), payeeName: pick(['A', 'B', 'Shop']), categoryId: pick(cats).id });
        else if (r < 0.24) s.createTransaction({ accountId: x.checking, date: '2026-02-03', amount: -10000, payeeName: 'Split shop', splits: [{ amount: -6000, categoryId: pick(cats).id }, { amount: -4000, categoryId: pick(cats).id }] });
        else if (r < 0.34 && txns.length) s.updateTransaction(pick(txns).id, { amount: -Math.floor(rnd() * 10000) });
        else if (r < 0.40 && txns.length) s.bulkUpdate([pick(txns).id], { cleared: pick(['cleared', 'uncleared'] as const) });
        else if (r < 0.46 && txns.length) s.deleteTransactions([pick(txns).id]);
        else if (r < 0.58) s.setBudget(`2026-0${1 + Math.floor(rnd() * 3)}`, pick(cats).id, { budgeted: Math.floor(rnd() * 5) * 10000 });
        else if (r < 0.62) s.undo();
        else if (r < 0.65) { const p = s.listPayees().filter(p => p.name !== 'Starting Balance'); if (p.length) s.renamePayee(pick(p).id, pick(['A', 'B', 'Market'])); }
        else if (r < 0.67 && cats.length > 3) { const del = pick(cats); s.deleteCategory(del.id, pick(cats.filter(c => c.id !== del.id)).id); }
        else if (r < 0.70) s.postScheduled(`2026-0${1 + Math.floor(rnd() * 3)}-15`);
        else if (r < 0.73) s.createCategory(cats[0].groupId, pick(['New', 'Other']));
        else if (r < 0.88) { const from = pick(devs), to = pick(devs); if (from !== to) net.deliver(from.root, to.root, () => rnd() < 0.5); }
        else await d.c.sync!.syncNow(d.id);
      } catch (e) { if (!/not found|NOT_FOUND|reconciled|nothing to undo|required|cannot|Split lines/i.test(String((e as Error).message))) throw e; }
    }
    for (let round = 0; round < 60; round++) {
      for (const a of devs) for (const b of devs) if (a !== b) net.deliver(a.root, b.root);
      for (const d of devs) await d.c.sync!.syncNow(d.id);
      for (const a of devs) for (const b of devs) if (a !== b) net.deliver(a.root, b.root);
      for (const d of devs) await d.c.sync!.syncNow(d.id);
      const withConflict = devs.find(d => d.c.sync!.store(d.id).openConflictCount() > 0);
      if (!withConflict) break;
      const st = withConflict.c.sync!.store(withConflict.id); const cf = st.conflicts()[0];
      const choice = rnd() < 0.5 ? 'mine' : 'theirs';
      if (process.env.SYNC_DEBUG) console.log('ROUND', round, devs.indexOf(withConflict), devs.map(d => d.c.sync!.store(d.id).openConflictCount()).join('/'), cf.id, cf.kind, choice, cf.message, cf.op.label, JSON.stringify(cf.op.changes.map(c => [c.t, c.k.slice(0, 4), c.d ? 'del' : c.a ? 'ins' : Object.keys(c.f!).join(',')])).slice(0, 400));
      try { st.resolve(cf.id, choice); } catch (e) { if (process.env.SYNC_DEBUG) console.log('  resolve failed:', (e as Error).message); st.resolve(cf.id, 'mine'); }
    }
    for (const d of devs) {
      expect(d.c.sync!.store(d.id).openConflictCount()).toBe(0);
      expect(sa(d.c, d.id).checkIntegrity()).toEqual([]);
      expect((await d.c.sync!.syncNow(d.id)).state).toBe('synced');
    }
    const f0 = fingerprint(devs[0].c, devs[0].id);
    for (const d of devs.slice(1)) {
      const f = fingerprint(d.c, d.id);
      if (process.env.SYNC_DEBUG) for (const t of Object.keys(f0.tables)) { const a = f0.tables[t].filter(r => !f.tables[t].includes(r)), b = f.tables[t].filter(r => !f0.tables[t].includes(r)); if (a.length || b.length) console.log(t, '\nA:', a, '\nB:', b); }
      expect(f).toEqual(f0);
    }
  });
});

// The situations named in the requirements, one test each (Windows = computer A, Mac = computer B).
describe('sync: the required situations A–G', () => {
  const budgeted = (c: Core, id: string, m: string, cat: string) => sa(c, id).getBudget(m).rows.find(r => r.categoryId === cat)!.budgeted;
  it('A: a transaction made on Windows while the Mac is offline appears on the Mac when it comes back', async () => {
    const p = await pair();
    const t = sa(p.a, p.aid).createTransaction({ accountId: p.checking, date: '2026-01-18', amount: -77_00, payeeName: 'Pharmacy', categoryId: p.food });
    await p.a.sync!.syncNow(p.aid); // the Mac does nothing meanwhile (offline)
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })).toHaveLength(0);
    await p.b.sync!.syncNow(p.bid); // back online
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })[0]).toMatchObject({ amount: -77_00, payeeName: 'Pharmacy' });
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('B: different transactions created on both computers are both kept', async () => {
    const p = await pair();
    const a = sa(p.a, p.aid).createTransaction({ accountId: p.checking, date: '2026-01-19', amount: -1_00, payeeName: 'On Windows', categoryId: p.food });
    const b = sa(p.b, p.bid).createTransaction({ accountId: p.checking, date: '2026-01-19', amount: -2_00, payeeName: 'On Mac', categoryId: p.food });
    await sync([p.a, p.aid], [p.b, p.bid]);
    for (const [c, id] of [[p.a, p.aid], [p.b, p.bid]] as [Core, string][]) expect(sa(c, id).listTransactions({ ids: [a.id, b.id] })).toHaveLength(2);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('C: the same transaction\'s amount changed on both while offline → a conflict for the user, never a silent choice', async () => {
    const p = await pair();
    const t = sa(p.a, p.aid).listTransactions({}).find(x => x.amount === -123_45)!;
    sa(p.a, p.aid).updateTransaction(t.id, { amount: -100_00 }); sa(p.b, p.bid).updateTransaction(t.id, { amount: -150_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.a, p.aid).listTransactions({ ids: [t.id] })[0].amount).toBe(-100_00); // each keeps its own until decided
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })[0].amount).toBe(-150_00);
    const ca = p.a.sync!.store(p.aid).conflicts(); expect(ca).toHaveLength(1); expect(ca[0].rows[0].fields).toEqual(['amount']);
    expect(p.b.sync!.store(p.bid).openConflictCount()).toBe(1);
    p.b.sync!.store(p.bid).resolve(p.b.sync!.store(p.bid).conflicts()[0].id, 'mine');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.a, p.aid).listTransactions({ ids: [t.id] })[0].amount).toBe(-150_00);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(0);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('D: deleted on Windows and edited on the Mac → the conflict is detected on both computers', async () => {
    const p = await pair();
    const t = sa(p.a, p.aid).listTransactions({}).find(x => x.amount === -123_45)!;
    sa(p.a, p.aid).deleteTransactions([t.id]); sa(p.b, p.bid).updateTransaction(t.id, { memo: 'still needed' });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).conflicts()[0].kind).toBe('changed_there_deleted_here');
    expect(p.b.sync!.store(p.bid).conflicts()[0].kind).toBe('deleted_there_changed_here');
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })).toHaveLength(1); // nothing deleted until decided
    p.a.sync!.store(p.aid).resolve(p.a.sync!.store(p.aid).conflicts()[0].id, 'mine'); // keep it deleted
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })).toHaveLength(0);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('E: moving money between categories on Windows while changing the budget on the Mac keeps the budget rules correct', async () => {
    const p = await pair();
    sa(p.a, p.aid).moveMoney('2026-01', p.food, p.fun, 50_00);           // Windows: Food → Fun
    sa(p.b, p.bid).setBudget('2026-02', p.food, { budgeted: 410_00 });   // Mac: another month
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(0);
    expect(budgeted(p.b, p.bid, '2026-01', p.food)).toBe(350_00); expect(budgeted(p.b, p.bid, '2026-01', p.fun)).toBe(50_00);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid)); // identical figures, incl. Available to Budget and rollover
    // the same cell on both: Windows moves money out of Food, the Mac sets Food's amount → a decision, not a guess
    sa(p.a, p.aid).moveMoney('2026-01', p.food, p.fun, 10_00); sa(p.b, p.bid).setBudget('2026-01', p.food, { budgeted: 500_00 });
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(p.a.sync!.store(p.aid).openConflictCount()).toBe(1);
    p.a.sync!.store(p.aid).resolve(p.a.sync!.store(p.aid).conflicts()[0].id, 'theirs');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
    for (const [c, id] of [[p.a, p.aid], [p.b, p.bid]] as [Core, string][]) expect(sa(c, id).checkIntegrity()).toEqual([]);
  });
  it('F: reconciling on one computer while the other has unsynchronised changes to a reconciled transaction is a conflict', async () => {
    const p = await pair();
    const t = sa(p.a, p.aid).listTransactions({}).find(x => x.amount === -123_45)!;
    sa(p.a, p.aid).updateTransaction(t.id, { cleared: 'cleared' }); await sync([p.a, p.aid], [p.b, p.bid]);
    const statement = sa(p.a, p.aid).listAccounts().find(a => a.id === p.checking)!.clearedBalance;
    sa(p.a, p.aid).reconcile(p.checking, statement);                         // Windows: reconciles (t becomes "reconciled")
    sa(p.b, p.bid).updateTransaction(t.id, { amount: -124_45 });              // Mac, not yet synchronised: changes its amount
    sa(p.b, p.bid).createTransaction({ accountId: p.checking, date: '2026-01-29', amount: -5_00, payeeName: 'New', categoryId: p.food, cleared: 'cleared' }); // compatible
    await sync([p.a, p.aid], [p.b, p.bid]);
    // the reconciled transaction was not silently given another amount on either computer
    expect(sa(p.a, p.aid).listTransactions({ ids: [t.id] })[0]).toMatchObject({ amount: -123_45, cleared: 'reconciled' });
    expect(p.a.sync!.store(p.aid).conflicts().some(c => c.rows.some(r => r.k === t.id))).toBe(true);
    expect(p.b.sync!.store(p.bid).conflicts().some(c => c.rows.some(r => r.k === t.id))).toBe(true);
    expect(sa(p.a, p.aid).listTransactions({}).some(x => x.payeeName === 'New')).toBe(true); // the compatible change arrived
    p.a.sync!.store(p.aid).resolve(p.a.sync!.store(p.aid).conflicts()[0].id, 'mine');
    await sync([p.a, p.aid], [p.b, p.bid]);
    expect(sa(p.b, p.bid).listTransactions({ ids: [t.id] })[0]).toMatchObject({ amount: -123_45, cleared: 'reconciled' });
    expect(fingerprint(p.b, p.bid)).toEqual(fingerprint(p.a, p.aid));
  });
  it('G: a "conflicted copy" made by the sync service is neither ignored nor allowed to lose or corrupt data', async () => {
    const p = await pair();
    sa(p.b, p.bid).createTransaction({ accountId: p.checking, date: '2026-01-26', amount: -9_00, payeeName: 'Real', categoryId: p.food });
    await p.b.sync!.syncNow(p.bid);
    const dir = join(p.folder, 'ops', p.b.sync!.deviceId); const f = readdirSync(dir).find(n => n.endsWith('.json'))!;
    // the service produced a second, different version of the same file
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    doc.ops[0].changes = doc.ops[0].changes.map((c: any) => (c.t === 'transactions' && c.a ? { ...c, a: { ...c.a, amount: -9_999_00 } } : c));
    doc.sha256 = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(doc.ops)).digest('hex');
    const copy = f.replace('.json', ' (MacBook\'s conflicted copy 2026-11-22).json');
    writeFileSync(join(dir, copy), JSON.stringify(doc));
    const st = await p.a.sync!.syncNow(p.aid);
    expect(st.warnings.length).toBeGreaterThan(0);                      // reported …
    expect(existsSync(join(dir, copy)) && existsSync(join(dir, f))).toBe(true); // … nothing deleted …
    expect(sa(p.a, p.aid).listTransactions({}).some(t => t.amount === -9_999_00)).toBe(false); // … nothing guessed
  });
});
