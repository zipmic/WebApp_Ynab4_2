import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_ROUTES, type App } from '../../src/server/app.ts';
import { Throttle, totpCode, totpVerify, base32Encode, base32Decode } from '../../src/server/auth.ts';
import { generateBudget } from '../fixtures/generate.ts';
import { login, testApp } from './helpers.ts';

describe('authentication and authorisation', () => {
  let app: App, dir: string, h: Record<string, string>, bid: string;
  beforeAll(async () => { ({ app, dir } = await testApp()); });
  afterAll(async () => { await app.close(); });

  it('before setup: a remote visitor cannot claim the installation without the setup token', async () => {
    const token = readFileSync(join(dir, 'setup-token.txt'), 'utf8').trim();
    const remote = (payload: object) => app.inject({ method: 'POST', url: '/api/auth/setup', payload, remoteAddress: '203.0.113.9' });
    expect((await remote({ username: 'evil', password: 'a-long-test-password' })).statusCode).toBe(403);
    expect((await remote({ username: 'evil', password: 'a-long-test-password', token: 'wrong' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '203.0.113.9' })).json().setupNeedsToken).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'owner', password: 'short' }, remoteAddress: '127.0.0.1' })).statusCode).toBe(400);
    expect(token.length).toBeGreaterThan(20);
  });
  it('setup creates the single user with an Argon2id hash; there is no second registration', async () => {
    h = await login(app);
    const row = app.core.sys.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true); expect(row.password_hash).not.toContain('a-long-test-password');
    expect(existsSync(join(dir, 'setup-token.txt'))).toBe(false);
    const again = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'second', password: 'another-long-password' }, remoteAddress: '127.0.0.1' });
    expect(again.statusCode).toBe(403); expect((app.core.sys.prepare('SELECT COUNT(*) n FROM users').get() as any).n).toBe(1);
    bid = (await app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'Mine' }, headers: h })).json().id;
  });
  it('EVERY private API route answers 401 without a session (checked against the live route table)', async () => {
    expect(app.routeList.length).toBeGreaterThan(60);
    const open: string[] = [];
    for (const r of app.routeList) {
      if (PUBLIC_ROUTES.has(`${r.method} ${r.url}`)) continue;
      const url = r.url.replace(':bid', bid).replace(':month', '2026-01').replace(/:\w+/g, 'x');
      const res = await app.inject({ method: r.method as any, url, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      if (res.statusCode !== 401) open.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(open).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/does-not-exist' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/b/${bid}/bootstrap`, headers: { cookie: 'br_session=forged-token' } })).statusCode).toBe(401);
    expect([...PUBLIC_ROUTES].sort()).toEqual(['GET /api/auth/status', 'POST /api/auth/login', 'POST /api/auth/passkey/login', 'POST /api/auth/passkey/login-options', 'POST /api/auth/setup']);
  });
  it('state-changing requests need the CSRF token and a same-origin Origin', async () => {
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/budgets', payload: { name: 'X' }, headers });
    expect((await post({ cookie: h.cookie })).statusCode).toBe(403);
    expect((await post({ cookie: h.cookie, 'x-csrf-token': 'guess' })).statusCode).toBe(403);
    expect((await post({ ...h, origin: 'https://evil.example' })).json().error.code).toBe('BAD_ORIGIN');
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: { cookie: h.cookie } })).statusCode).toBe(200);
  });
  it('session cookie is HttpOnly + SameSite=Strict, only a hash of the token is stored, responses are not cacheable', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'a-long-test-password' } });
    const set = String(r.headers['set-cookie']); expect(set).toMatch(/HttpOnly/i); expect(set).toMatch(/SameSite=Strict/i);
    const token = r.cookies[0].value; const stored = (app.core.sys.prepare('SELECT token_hash FROM sessions').all() as any[]).map(x => x.token_hash);
    expect(stored).not.toContain(token); expect(stored.every(x => /^[0-9a-f]{64}$/.test(x))).toBe(true);
    expect(r.headers['cache-control']).toBe('no-store'); expect(r.headers['x-frame-options']).toBe('DENY'); expect(String(r.headers['content-security-policy'])).toContain("default-src 'self'");
  });
  it('brute force: repeated wrong passwords lock the account and the IP, even for the right password', async () => {
    const attempt = (password: string, ip = '198.51.100.7') => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password }, remoteAddress: ip });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong-' + i)).statusCode).toBe(401);
    const locked = await attempt('a-long-test-password');
    expect(locked.statusCode).toBe(429); expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await attempt('a-long-test-password', '198.51.100.99')).statusCode).toBe(429); // account lock applies from any address
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'x' }, remoteAddress: '198.51.100.8' })).json().error.code).toBe('INVALID_CREDENTIALS'); // no user enumeration
    app.core.auth.userThrottle.success('owner');
  });
  it('TOTP: enabling requires a valid code; login then requires it; codes cannot be replayed', async () => {
    const { secret } = (await app.inject({ method: 'POST', url: '/api/auth/totp/begin', headers: h })).json();
    expect((await app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: h, payload: { code: '000000' } })).statusCode).toBe(403);
    const step = Math.floor(Date.now() / 30000);
    expect((await app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: h, payload: { code: totpCode(secret, step - 1) } })).statusCode).toBe(200);
    const signIn = (totp?: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'a-long-test-password', totp }, remoteAddress: '192.0.2.1' });
    expect((await signIn()).json().error.code).toBe('TOTP_REQUIRED');
    expect((await signIn(totpCode(secret, step - 1))).json().error.code).toBe('TOTP_INVALID'); // replay of the code used to enable
    expect((await signIn(totpCode(secret, step))).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/totp/disable', headers: h, payload: { password: 'nope' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/totp/disable', headers: h, payload: { password: 'a-long-test-password' } })).statusCode).toBe(200);
    app.core.auth.userThrottle.success('owner');
  });
  it('sessions expire when idle, and "log out everywhere" revokes all of them', async () => {
    const other = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'a-long-test-password' }, remoteAddress: '192.0.2.50' });
    const otherCookie = `${other.cookies[0].name}=${other.cookies[0].value}`;
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: { cookie: otherCookie } })).statusCode).toBe(200);
    app.core.sys.prepare('UPDATE sessions SET last_seen=? WHERE ip=?').run(Date.now() - 8 * 86400_000, '192.0.2.50');
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: { cookie: otherCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: h })).json().length).toBeGreaterThan(1);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).statusCode).toBe(401);
    expect((app.core.sys.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n).toBe(0);
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password: 'a-long-test-password' }, remoteAddress: '192.0.2.77' });
    h = { cookie: `${r.cookies[0].name}=${r.cookies[0].value}`, 'x-csrf-token': r.json().csrf };
  });
  it('server-side validation rejects malformed financial input', async () => {
    const acc = (await app.inject({ method: 'POST', url: `/api/b/${bid}/accounts`, headers: h, payload: { name: 'Bank', type: 'checking', balance: 100000, date: '2026-01-01' } })).json().id;
    const tx = (payload: object) => app.inject({ method: 'POST', url: `/api/b/${bid}/transactions`, headers: h, payload });
    expect((await tx({ accountId: acc, date: '2026-01-02', amount: 12.5 })).statusCode).toBe(400);
    expect((await tx({ accountId: acc, date: '2026-02-31', amount: 100 })).statusCode).toBe(400);
    expect((await tx({ accountId: acc, date: '2026-01-02', amount: '100' })).statusCode).toBe(400);
    expect((await tx({ accountId: 'nope', date: '2026-01-02', amount: 100 })).statusCode).toBe(404);
    expect((await tx({ accountId: acc, date: '2026-01-02', amount: -500, flag: 'pink' })).statusCode).toBe(400);
    expect((await tx({ accountId: acc, date: '2026-01-02', amount: -500, payeeName: "Robert'); DROP TABLE transactions;--" })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/b/${bid}/transactions`, headers: h })).json()).toHaveLength(2); // parameterised: table intact
    expect((await app.inject({ method: 'PUT', url: `/api/b/${bid}/budget/2026-13/categories/x`, headers: h, payload: { budgeted: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/b/..%2F..%2Fsystem/bootstrap', headers: h })).statusCode).toBe(404);
  });
  it('backup → download → restore reproduces the budget exactly; non-backups and traversal are refused', async () => {
    const svc = app.core.service(bid); generateBudget(svc, { startMonth: '2025-01', months: 14, txPerMonth: 25 });
    const snap = (id: string) => { const s = app.core.service(id); return JSON.stringify([s.listAccounts().map(a => [a.name, a.balance, a.clearedBalance]), s.listTransactions().length, s.reportBudget('2025-01', '2026-06').map(r => [r.month, r.budgeted, r.activity, r.available]), s.listScheduled(), s.getSettings().currency]); };
    const name = (await app.inject({ method: 'POST', url: `/api/b/${bid}/backups`, headers: h })).json().name;
    const file = await app.inject({ method: 'GET', url: `/api/b/${bid}/backups/${name}`, headers: h });
    expect(file.statusCode).toBe(200); expect(file.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
    const restored = await app.inject({ method: 'POST', url: '/api/restore', headers: { ...h, 'content-type': 'application/octet-stream' }, payload: file.rawPayload });
    expect(restored.statusCode).toBe(200); expect(restored.json().id).not.toBe(bid);
    expect(snap(restored.json().id)).toBe(snap(bid)); expect(app.core.service(restored.json().id).checkIntegrity()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json()).toHaveLength(2); // the original is untouched
    const bad = await app.inject({ method: 'POST', url: '/api/restore', headers: { ...h, 'content-type': 'application/octet-stream' }, payload: Buffer.from('<?php system($_GET["c"]); ?>'.padEnd(200, ' ')) });
    expect(bad.statusCode).toBe(415);
    for (const evil of ['..%2F..%2Fsystem.sqlite', '%2e%2e%2fsystem.sqlite', 'system.sqlite']) expect((await app.inject({ method: 'GET', url: `/api/b/${bid}/backups/${evil}`, headers: h })).statusCode).toBe(404);
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]); // no upload residue
  });
  it('YNAB4 import via the API: preview writes nothing, commit creates a new budget, duplicates need confirmation, failures roll back', async () => {
    const reg = 'Account,Date,Payee,Category,Master Category,Sub Category,Memo,Outflow,Inflow,Cleared,Running Balance\nBank,31-12-2024,Job,Income: Available this month,Income,Available this month,,"kr0,00","kr5.000,00",R,"kr5.000,00"\nBank,13-01-2025,Netto,Hverdag: Mad,Hverdag,Mad,,"kr250,50","kr0,00",C,"kr4.749,50"\n';
    const bud = 'Month,Category,Master Category,Sub Category,Budgeted,Outflows,Category Balance\nJanuary 2025,Hverdag: Mad,Hverdag,Mad,"kr1.000,00","kr250,50","kr749,50"\n';
    const files = [{ path: 'Mit budget as of 2025-02-01 1200 PM-Register.csv', text: reg }, { path: 'Mit budget as of 2025-02-01 1200 PM-Budget.csv', text: bud }];
    const before = (await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().length;
    const prev = (await app.inject({ method: 'POST', url: '/api/import/ynab4/preview', headers: h, payload: { files } })).json();
    expect(prev.result.status).toBe('verified'); expect(prev.summary.budgetName).toBe('Mit budget'); expect(prev.detected.map((d: any) => d.kind)).toEqual(['YNAB4 Register export', 'YNAB4 Budget export']);
    expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().length).toBe(before);
    const done = (await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files } })).json();
    expect(done.result.status).toBe('verified');
    const boot = (await app.inject({ method: 'GET', url: `/api/b/${done.budgetId}/bootstrap`, headers: h })).json();
    expect(boot.accounts[0]).toMatchObject({ name: 'Bank', balance: 474950 }); expect(boot.settings.name).toBe('Mit budget');
    const again = await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files } });
    expect(again.statusCode).toBe(409); expect(again.json().error.code).toBe('ALREADY_IMPORTED');
    expect((await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files, confirmDuplicate: true } })).statusCode).toBe(200);
    const n = (await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().length;
    const junk = await app.inject({ method: 'POST', url: '/api/import/ynab4/commit', headers: h, payload: { files: [{ path: 'x.csv', text: 'a,b\n1,2\n' }] } });
    expect(junk.statusCode).toBe(422); expect((await app.inject({ method: 'GET', url: '/api/budgets', headers: h })).json().length).toBe(n);
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThan(0); // safety backups of existing budgets were taken
  });
  it('bank import API: the vision endpoint demands consent and a real image; analysis + commit work end to end', async () => {
    const acc = (await app.inject({ method: 'GET', url: `/api/b/${bid}/bootstrap`, headers: h })).json().accounts.find((a: any) => a.name === 'Bank').id;
    const v = (headers: object, payload: Buffer) => app.inject({ method: 'POST', url: `/api/b/${bid}/bank-import/vision`, headers: { ...h, 'content-type': 'image/png', ...headers }, payload });
    expect((await v({}, Buffer.alloc(64))).json().error.code).toBe('CONSENT_REQUIRED');
    expect((await v({ 'x-vision-consent': 'yes' }, Buffer.from('GIF89a not an accepted image'.padEnd(64)))).statusCode).toBe(415);
    const a = (await app.inject({ method: 'POST', url: `/api/b/${bid}/bank-import/analyze`, headers: h, payload: { accountId: acc, sources: [{ kind: 'ocr', lines: [{ text: '08.11.2026 NETTO -428,50' }, { text: '07.11.2026 SPAR -212,95' }] }, { kind: 'json', content: '{"schema":"budget-reborn.transactions.v1","transactions":[{"date":"2026-11-08","payee":"NETTO","amount":"-428.50"}]}' }] } })).json();
    expect(a.rows.map((r: any) => r.duplicate.status)).toEqual(['new', 'new', 'likely_duplicate']);
    const bad = await app.inject({ method: 'POST', url: `/api/b/${bid}/bank-import/analyze`, headers: h, payload: { accountId: acc, sources: [{ kind: 'json', content: '{"schema":"x"}' }] } });
    expect(bad.statusCode).toBe(422);
    const c = await app.inject({ method: 'POST', url: `/api/b/${bid}/bank-import/commit`, headers: h, payload: { accountId: acc, rows: a.rows.slice(0, 2).map((r: any) => ({ date: r.date, payeeName: r.payee, amount: r.amount, rawPayee: r.rawPayee, issues: r.issues })) } });
    expect(c.json().imported).toBe(2);
  });
});

describe('deployment hardening options', () => {
  it('HTTPS enforcement: plain HTTP is redirected (GET) or refused (POST); Secure __Host- cookie and HSTS over HTTPS', async () => {
    const { app } = await testApp({ BR_REQUIRE_HTTPS: '1', BR_TRUST_PROXY: '1' });
    const get = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: 'budget.example' } });
    expect(get.statusCode).toBe(308); expect(get.headers.location).toBe('https://budget.example/api/auth/status');
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {}, headers: { host: 'budget.example' } })).statusCode).toBe(403);
    const s = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { 'x-forwarded-proto': 'https', host: 'budget.example' }, payload: { username: 'owner', password: 'a-long-test-password', token: app.core.auth.setupToken() } });
    expect(s.statusCode).toBe(200); expect(String(s.headers['set-cookie'])).toMatch(/^__Host-br_session=.*Secure/); expect(s.headers['strict-transport-security']).toMatch(/max-age/);
    await app.close();
  });
  it('VPN-only mode refuses clients outside the allowed networks before anything else', async () => {
    const { app } = await testApp({ BR_ALLOWED_NETWORKS: '10.8.0.,127.0.0.1' });
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '203.0.113.5' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/', remoteAddress: '203.0.113.5' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/auth/status', remoteAddress: '10.8.0.4' })).statusCode).toBe(200);
    await app.close();
  });
  it('throttle backoff grows and TOTP helpers follow RFC 6238', () => {
    const t = new Throttle(3, 60_000, 1000, 8000); const now = 1_000_000;
    for (let i = 0; i < 3; i++) t.fail('k', now); expect(t.retryAfter('k', now)).toBe(1000);
    for (let i = 0; i < 3; i++) t.fail('k', now + 2000); expect(t.retryAfter('k', now + 2000)).toBe(2000);
    expect(t.retryAfter('other', now)).toBe(0);
    const secret = base32Encode(Buffer.from('12345678901234567890')); // RFC 6238 test secret
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082'); expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpVerify(secret, '287082', 59_000)).toBe(1); expect(totpVerify(secret, '287082', 59_000, 1)).toBeNull(); expect(totpVerify(secret, '000000', 59_000)).toBeNull();
  });
});
