/**
 * The desktop app's HTTP layer (requests come only from the app's own window, through an in-process protocol
 * handler): no login, a per-launch CSRF token, folders only by token, sync and conflict routes; and the migration
 * of budgets from the server version, which must never change the source folder.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { Core } from '../../src/server/core.ts';
import { testApp } from './helpers.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
describe('desktop mode HTTP layer', () => {
  let app: App; let h: Record<string, string>;
  beforeAll(async () => {
    ({ app } = await testApp({ BR_DESKTOP: '1' }));
    const st = (await app.inject({ method: 'GET', url: '/api/auth/status' })).json();
    h = { 'x-csrf-token': st.csrf };
  });
  afterAll(async () => { await app.close(); });
  it('there is no login: the window is signed in, and the sign-in routes do not exist', async () => {
    const st = (await app.inject({ method: 'GET', url: '/api/auth/status' })).json();
    expect(st).toMatchObject({ authenticated: true, desktop: true, setupRequired: false }); expect(st.csrf).toMatch(/^[0-9a-f]{48}$/);
    for (const url of ['/api/auth/setup', '/api/auth/login', '/api/auth/logout', '/api/auth/totp/begin', '/api/auth/passkey/login-options'])
      expect((await app.inject({ method: 'POST', url, headers: h, payload: {} })).statusCode).toBe(404);
  });
  it("every change still needs this launch's CSRF token, and requests from another origin are refused", async () => {
    expect((await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/budgets', headers: { 'x-csrf-token': 'wrong' }, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/budgets', headers: { ...h, origin: 'https://evil.example' }, payload: { name: 'X' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/budgets', headers: h, payload: { name: 'X' } })).statusCode).toBe(200);
  });
  it('folders are accepted only as tokens for folders the user picked in the system dialog (no paths from the page)', async () => {
    const bid = (await app.inject({ method: 'POST', url: '/api/budgets', headers: h, payload: { name: 'Home' } })).json().id;
    const parent = tmp('br-pick-');
    const raw = await app.inject({ method: 'POST', url: `/api/b/${bid}/sync/publish`, headers: h, payload: { folder: parent } });
    expect(raw.statusCode).toBe(403); expect(raw.json().error.code).toBe('FOLDER_NOT_GRANTED');
    expect(readdirSync(parent)).toEqual([]);
    const token = app.core.grantFolder(parent);
    const ok = await app.inject({ method: 'POST', url: `/api/b/${bid}/sync/publish`, headers: h, payload: { folder: token } });
    expect(ok.statusCode).toBe(200); expect(ok.json().status.state).toBe('synced');
    const st = (await app.inject({ method: 'GET', url: `/api/b/${bid}/sync`, headers: h })).json();
    expect(st).toMatchObject({ state: 'synced', conflicts: 0 }); expect(typeof st.revision).toBe('number');
    expect((await app.inject({ method: 'GET', url: `/api/b/${bid}/sync/conflicts`, headers: h })).json()).toEqual([]);
    expect([400, 403]).toContain((await app.inject({ method: 'POST', url: '/api/desktop/open-folder', headers: h, payload: { folder: join(parent, '..', '..', 'etc') } })).statusCode);
    expect((await app.inject({ method: 'POST', url: '/api/desktop/open-folder', headers: h, payload: { folder: '../../../etc' } })).statusCode).toBe(403);
  });
  it('a conflict is shown with both versions in words, and the decision is applied', async () => {
    const A = app.core; const shared = tmp('br-conf-');
    const svc = A.createBudget('Shared'); const acc = svc.createAccount({ name: 'Bank', type: 'checking', balance: 100_00, date: '2026-01-01' });
    const g = svc.createGroup('G'); const cat = svc.createCategory(g, 'Food');
    const { folder } = await A.sync!.publish(svc.id, shared);
    const B = new Core(loadConfig({ BR_DATA_DIR: tmp('br-b-'), BR_DESKTOP: '1' }), { syncAuto: false });
    try {
      const { id: bid } = await B.sync!.join(folder);
      svc.setBudget('2026-01', cat, { budgeted: 1_00 }); B.service(bid).setBudget('2026-01', cat, { budgeted: 2_00 });
      for (let i = 0; i < 2; i++) { await A.sync!.syncNow(svc.id); await B.sync!.syncNow(bid); }
      const list = (await app.inject({ method: 'GET', url: `/api/b/${svc.id}/sync/conflicts`, headers: h })).json();
      expect(list).toHaveLength(1);
      expect(list[0].items[0].what).toContain('Budgeted for Food in 2026-01');
      expect(list[0].items[0].fields[0]).toEqual({ name: 'Budgeted', mine: '1,00', theirs: '2,00' });
      const r = await app.inject({ method: 'POST', url: `/api/b/${svc.id}/sync/conflicts/${list[0].id}`, headers: h, payload: { choice: 'theirs' } });
      expect(r.statusCode).toBe(200);
      expect(svc.getBudget('2026-01').rows.find(x => x.categoryId === cat)!.budgeted).toBe(2_00);
      void acc;
    } finally { B.close(); }
  });
});

describe('server mode is unchanged', () => {
  it('the desktop routes do not exist on a server', async () => {
    const { app } = await testApp();
    try { expect((await app.inject({ method: 'GET', url: '/api/desktop/info' })).statusCode).toBe(401); expect(app.core.sync).toBeNull(); }
    finally { await app.close(); }
  });
});

describe('moving budgets from the server version', () => {
  it('copies every budget as a new local budget, verified, and leaves the server data folder byte-for-byte unchanged', () => {
    // a server installation with two budgets
    const serverDir = tmp('br-server-');
    const server = new Core(loadConfig({ BR_DATA_DIR: serverDir }));
    const s1 = server.createBudget('Household'); const a = s1.createAccount({ name: 'Bank', type: 'checking', balance: 5_000_00, date: '2026-01-01' });
    const g = s1.createGroup('G'); const c = s1.createCategory(g, 'Food'); s1.setBudget('2026-01', c, { budgeted: 300_00 });
    s1.createTransaction({ accountId: a, date: '2026-01-10', amount: -45_50, payeeName: 'Grocer', categoryId: c });
    const s2 = server.createBudget('Holiday'); s2.createAccount({ name: 'Savings', type: 'savings', balance: 1_00, date: '2026-01-01' });
    const before1 = JSON.stringify(s1.getBudget('2026-01')); server.close(); // the server is stopped before moving
    const hashes = () => { const out: Record<string, string> = {}; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex'); } }; walk(serverDir); return out; };
    const before = hashes();
    const desktop = new Core(loadConfig({ BR_DATA_DIR: tmp('br-desk-'), BR_DESKTOP: '1' }), { syncAuto: false });
    try {
      const r = desktop.importServerData(serverDir);
      expect(r.failed).toEqual([]);
      expect(r.imported.map(x => x.name).sort()).toEqual(['Holiday', 'Household']);
      const home = r.imported.find(x => x.name === 'Household')!;
      expect(home.transactions).toBe(2);
      expect(JSON.stringify(desktop.service(home.id).getBudget('2026-01'))).toBe(before1);
      expect(desktop.service(home.id).checkIntegrity()).toEqual([]);
      expect(hashes()).toEqual(before); // nothing in the server folder was changed or added
      expect(() => desktop.importServerData(tmp('br-empty-'))).toThrow(/does not look like/);
    } finally { desktop.close(); }
  });
});
