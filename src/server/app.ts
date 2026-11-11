/**
 * HTTP layer. Every /api route requires a valid session unless it is listed in PUBLIC_ROUTES;
 * state-changing requests additionally require the session's CSRF token and a same-origin Origin.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { createReadStream, existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import type { SessionInfo } from './auth.ts';
import { analyze, commit as commitBankImport, deleteRule, listRules, recheck, saveRule } from './bankImportService.ts';
import { BudgetService } from './budgetService.ts';
import type { Config } from './config.ts';
import { Core } from './core.ts';
import { nowIso, openBudgetDb } from './db.ts';
import { AppError, bad } from './errors.ts';
import { applyImport } from './importService.ts';
import { extractWithVision, sniffImage } from './vision.ts';
import { IMPORT_CSV_EXAMPLE, IMPORT_JSON_EXAMPLE, parseBankCsv, parseBankText, parseImportJson, finalize, type Candidate } from '../shared/bankparse.ts';
import { toCsv } from '../shared/csv.ts';
import { monthOf, todayISO } from '../shared/dates.ts';
import type { ImportModel } from '../shared/importModel.ts';
import { formatMinor } from '../shared/money.ts';
import { ACCOUNT_TYPES, FLAGS, FREQUENCIES } from '../shared/types.ts';
import { detectYnab4Csv, parseYnab4Csv } from '../shared/ynab4csv.ts';
import { isYnab4Native, parseYnab4Native } from '../shared/ynab4native.ts';

declare module 'fastify' { interface FastifyRequest { session: SessionInfo | null; } }

export const PUBLIC_ROUTES = new Set(['GET /api/auth/status', 'POST /api/auth/setup', 'POST /api/auth/login', 'POST /api/auth/passkey/login-options', 'POST /api/auth/passkey/login']);

const money = z.number().int().refine(n => Number.isSafeInteger(n) && Math.abs(n) <= 1e13, 'amount out of range');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const id = z.string().min(1).max(64);
const cleared = z.enum(['uncleared', 'cleared', 'reconciled']);
const flag = z.enum(FLAGS).nullable();
const accountType = z.enum(ACCOUNT_TYPES.map(t => t.value) as [string, ...string[]]);
const split = z.object({ amount: money, categoryId: id.nullish(), memo: z.string().max(2000).optional(), transferAccountId: id.nullish() });
const txnInput = z.object({ accountId: id, date: isoDate, payeeId: id.nullish(), payeeName: z.string().max(200).nullish(), categoryId: id.nullish(), memo: z.string().max(2000).optional(),
  amount: money, cleared: cleared.optional(), flag: flag.optional(), transferAccountId: id.nullish(), splits: z.array(split).max(100).optional() });
const candidate = z.object({ date: isoDate.nullable(), bookingDate: isoDate.nullable().optional(), payee: z.string().max(300), description: z.string().max(1000).optional(), amount: money.nullable(),
  currency: z.string().max(8).nullable().optional(), balanceAfter: money.nullable().optional(), accountHint: z.string().max(200).nullable().optional(), categoryName: z.string().max(200).nullable().optional(),
  importId: z.string().max(200).nullable().optional(), issues: z.array(z.string().max(40)).max(30), confidence: z.number().min(0).max(1), sourceIndex: z.number().int().min(0).max(1000), raw: z.string().max(2000).optional() });

export type App = FastifyInstance & { core: Core; routeList: { method: string; url: string }[] };
export async function buildApp(cfg: Config, core = new Core(cfg)): Promise<App> {
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy, bodyLimit: 2 * 1024 * 1024 }) as unknown as App;
  app.decorate('core', core);
  const routeList: { method: string; url: string }[] = []; app.decorate('routeList', routeList);
  app.addHook('onRoute', r => { for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (r.url.startsWith('/api/') && m !== 'HEAD') routeList.push({ method: m, url: r.url }); });
  await app.register(cookie);
  await app.register(compress, { threshold: 2048 });
  app.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.decorateRequest('session', null);
  const auth = core.auth;
  const secure = (req: FastifyRequest) => req.protocol === 'https';
  const cookieName = (req: FastifyRequest) => (secure(req) ? '__Host-br_session' : 'br_session');
  const isLoopback = (req: FastifyRequest) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) && !req.headers['x-forwarded-for'];

  app.addHook('onRequest', async (req, reply) => {
    // --- network allow-list (VPN-only deployments)
    if (cfg.allowedNetworks.length && !cfg.allowedNetworks.some(p => req.ip === p || req.ip.startsWith(p) || req.ip === '::ffff:' + p || req.ip.startsWith('::ffff:' + p)))
      return reply.code(403).send({ error: { code: 'NETWORK_NOT_ALLOWED', message: 'Access is restricted to the private network.' } });
    // --- HTTPS enforcement
    if (cfg.requireHttps && !secure(req)) {
      if (req.method === 'GET' || req.method === 'HEAD') return reply.redirect(`https://${req.host}${req.url}`, 308);
      return reply.code(403).send({ error: { code: 'HTTPS_REQUIRED', message: 'HTTPS is required.' } });
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()').header('Cross-Origin-Opener-Policy', 'same-origin')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (secure(req)) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    // --- same-origin check for anything that changes state
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      const origin = req.headers.origin;
      if (origin) {
        let host = ''; try { host = new URL(origin).host; } catch { /* malformed */ }
        const ok = host === req.host || (cfg.publicOrigin && origin === cfg.publicOrigin) || (!cfg.production && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host));
        if (!ok) return reply.code(403).send({ error: { code: 'BAD_ORIGIN', message: 'Cross-site request blocked.' } });
      }
    }
    // --- authentication + CSRF. The route table is consulted so unknown URLs also answer 401, never leaking structure.
    req.session = auth.session(req.cookies[cookieName(req)] ?? req.cookies['br_session']);
    const routeKey = `${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`;
    if (PUBLIC_ROUTES.has(routeKey)) return;
    if (!req.session) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
    if (unsafe && req.headers['x-csrf-token'] !== req.session.csrf) return reply.code(403).send({ error: { code: 'CSRF', message: 'Security token missing or expired. Reload the page.' } });
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'Invalid request: ' + err.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || String(err?.code).startsWith('SQLITE_CONSTRAINT')) return reply.code(409).send({ error: { code: 'CONSTRAINT', message: 'The change conflicts with existing data.' } });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.statusCode === 413 ? 'Upload too large.' : 'Bad request.' } });
    console.error(`[${nowIso()}] internal error:`, err?.message); // message only: never log request bodies or financial data
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on the server. No changes were saved.' } });
  });

  const setSession = (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const s = auth.createSession(userId, req.ip, req.headers['user-agent'] ?? null);
    reply.setCookie(cookieName(req), s.token, { httpOnly: true, sameSite: 'strict', secure: secure(req), path: '/', maxAge: cfg.sessionMaxDays * 86400 });
    return s.csrf;
  };
  const clearCookie = (req: FastifyRequest, reply: FastifyReply) => { reply.clearCookie(cookieName(req), { path: '/' }); reply.clearCookie('br_session', { path: '/' }); };
  const rp = (req: FastifyRequest) => { const origin = cfg.publicOrigin ?? `${req.protocol}://${req.host}`; return { origin, rpID: new URL(origin).hostname }; };
  const uid = (req: FastifyRequest) => req.session!.userId;

  // ================================================================= auth
  app.get('/api/auth/status', async req => {
    const u = req.session ? auth.user(req.session.userId) : null;
    return { setupRequired: !auth.hasUser(), setupNeedsToken: !auth.hasUser() && !isLoopback(req), authenticated: !!u, csrf: req.session?.csrf ?? null,
      user: u ? { username: u.username, totpEnabled: !!u.totp_enabled, passkeys: (core.sys.prepare('SELECT COUNT(*) n FROM passkeys WHERE user_id=?').get(u.id) as { n: number }).n } : null,
      passkeyLogin: !!core.sys.prepare('SELECT 1 FROM passkeys LIMIT 1').get(), visionConfigured: !!cfg.vision, version: 1 };
  });
  app.post('/api/auth/setup', async (req, reply) => {
    const b = z.object({ username: z.string().max(64), password: z.string().max(256), token: z.string().max(100).optional() }).parse(req.body);
    const wait = auth.ipThrottle.retryAfter(req.ip); if (wait) throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`);
    try { const userId = await auth.setup(b.username, b.password, b.token, isLoopback(req)); auth.audit('setup', req.ip); return { ok: true, csrf: setSession(req, reply, userId) }; }
    catch (e) { if (e instanceof AppError && e.code === 'SETUP_TOKEN') auth.ipThrottle.fail(req.ip); throw e; }
  });
  app.post('/api/auth/login', async (req, reply) => {
    const b = z.object({ username: z.string().max(64), password: z.string().max(512), totp: z.string().max(12).optional() }).parse(req.body);
    const key = b.username.trim().toLowerCase();
    const wait = Math.max(auth.ipThrottle.retryAfter(req.ip), auth.userThrottle.retryAfter(key));
    if (wait) { reply.header('Retry-After', Math.ceil(wait / 1000)); throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`); }
    const u = await auth.verifyPassword(b.username, b.password);
    const fail = (event: string) => { auth.ipThrottle.fail(req.ip); auth.userThrottle.fail(key); auth.audit(event, req.ip, key); };
    if (!u) { fail('login_failed'); throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password.'); }
    if (u.totp_enabled) {
      if (!b.totp) return reply.code(401).send({ error: { code: 'TOTP_REQUIRED', message: 'Enter the 6-digit code from your authenticator app.' } });
      if (!auth.totpCheck(u, b.totp)) { fail('login_totp_failed'); throw new AppError(401, 'TOTP_INVALID', 'That code is not valid.'); }
    }
    auth.userThrottle.success(key); auth.audit('login', req.ip, key);
    return { ok: true, csrf: setSession(req, reply, u.id) };
  });
  app.post('/api/auth/logout', async (req, reply) => { auth.destroySession(req.session!.tokenHash); clearCookie(req, reply); return { ok: true }; });
  app.post('/api/auth/logout-all', async (req, reply) => { auth.destroyAllSessions(uid(req)); auth.audit('logout_all', req.ip); clearCookie(req, reply); return { ok: true }; });
  app.get('/api/auth/sessions', async req => auth.listSessions(uid(req), req.session!.tokenHash));
  app.post('/api/auth/password', async (req, reply) => {
    const b = z.object({ current: z.string().max(512), next: z.string().max(256) }).parse(req.body);
    await auth.changePassword(uid(req), b.current, b.next); auth.destroyAllSessions(uid(req)); auth.audit('password_changed', req.ip);
    return { ok: true, csrf: setSession(req, reply, uid(req)) };
  });
  app.post('/api/auth/totp/begin', async req => auth.totpBegin(uid(req)));
  app.post('/api/auth/totp/enable', async req => { auth.totpEnable(uid(req), z.object({ code: z.string().max(12) }).parse(req.body).code); auth.audit('totp_enabled', req.ip); return { ok: true }; });
  app.post('/api/auth/totp/disable', async req => {
    const b = z.object({ password: z.string().max(512) }).parse(req.body); const u = auth.user(uid(req))!;
    if (!(await auth.verifyPassword(u.username, b.password))) throw new AppError(403, 'WRONG_PASSWORD', 'Password is incorrect.');
    auth.totpDisable(u.id); auth.audit('totp_disabled', req.ip); return { ok: true };
  });
  // --- passkeys (WebAuthn)
  app.get('/api/auth/passkeys', async req => core.sys.prepare('SELECT id, name, created_at createdAt FROM passkeys WHERE user_id=?').all(uid(req)));
  app.delete('/api/auth/passkeys/:id', async req => { core.sys.prepare('DELETE FROM passkeys WHERE id=? AND user_id=?').run((req.params as any).id, uid(req)); return { ok: true }; });
  app.post('/api/auth/passkey/register-options', async req => {
    const u = auth.user(uid(req))!; const { rpID } = rp(req);
    const existing = core.sys.prepare('SELECT id FROM passkeys WHERE user_id=?').all(u.id) as { id: string }[];
    const options = await generateRegistrationOptions({ rpName: 'Budget Reborn', rpID, userName: u.username, userID: new TextEncoder().encode(u.id), attestationType: 'none',
      excludeCredentials: existing.map(c => ({ id: c.id })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' } });
    return { options, ticket: auth.putPending('passkey-register', options.challenge, u.id) };
  });
  app.post('/api/auth/passkey/register', async req => {
    const b = z.object({ ticket: z.string().max(64), name: z.string().max(60).optional(), response: z.any() }).parse(req.body);
    const p = auth.takePending(b.ticket, 'passkey-register'); if (!p || p.userId !== uid(req)) throw bad('Registration expired, try again.');
    const { origin, rpID } = rp(req);
    const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: p.value, expectedOrigin: origin, expectedRPID: rpID }).catch(() => null);
    if (!v?.verified || !v.registrationInfo) throw bad('The passkey could not be verified.');
    const c = v.registrationInfo.credential;
    core.sys.prepare('INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id, uid(req), Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), b.name?.trim() || 'Passkey', nowIso());
    auth.audit('passkey_added', req.ip); return { ok: true };
  });
  app.post('/api/auth/passkey/login-options', async req => {
    const { rpID } = rp(req);
    const creds = core.sys.prepare('SELECT id, transports FROM passkeys').all() as { id: string; transports: string }[];
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: creds.map(c => ({ id: c.id, transports: JSON.parse(c.transports || '[]') })) });
    return { options, ticket: auth.putPending('passkey-login', options.challenge) };
  });
  app.post('/api/auth/passkey/login', async (req, reply) => {
    const b = z.object({ ticket: z.string().max(64), response: z.any() }).parse(req.body);
    const wait = auth.ipThrottle.retryAfter(req.ip); if (wait) throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    const p = auth.takePending(b.ticket, 'passkey-login');
    const cred = core.sys.prepare('SELECT * FROM passkeys WHERE id=?').get(String(b.response?.id ?? '')) as any;
    const { origin, rpID } = rp(req);
    const v = p && cred ? await verifyAuthenticationResponse({ response: b.response, expectedChallenge: p.value, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports || '[]') } }).catch(() => null) : null;
    if (!v?.verified) { auth.ipThrottle.fail(req.ip); auth.audit('passkey_login_failed', req.ip); throw new AppError(401, 'INVALID_CREDENTIALS', 'Passkey sign-in failed.'); }
    core.sys.prepare('UPDATE passkeys SET counter=? WHERE id=?').run(v.authenticationInfo.newCounter, cred.id);
    auth.audit('passkey_login', req.ip); return { ok: true, csrf: setSession(req, reply, cred.user_id) };
  });

  // ================================================================= budgets (files)
  app.get('/api/budgets', async () => core.listBudgets());
  app.post('/api/budgets', async req => { const b = z.object({ name: z.string().min(1).max(100), currency: z.string().length(3).optional() }).parse(req.body); const s = core.createBudget(b.name, b.currency ? { currency: b.currency.toUpperCase() } : {}); return { id: s.id }; });
  app.post('/api/budgets/:bid/delete', async req => {
    const { bid } = req.params as { bid: string }; const b = z.object({ confirmName: z.string() }).parse(req.body);
    const cur = core.listBudgets().find(x => x.id === bid); if (!cur) throw new AppError(404, 'NOT_FOUND', 'Budget not found');
    if (b.confirmName.trim() !== cur.name) throw bad('Type the budget name exactly to confirm deletion.');
    core.deleteBudget(bid); return { ok: true };
  });
  app.post('/api/restore', { bodyLimit: 512 * 1024 * 1024 }, async req => {
    if (!Buffer.isBuffer(req.body)) throw bad('Send the backup file as application/octet-stream.');
    core.backupAll('before-restore');
    return core.restore(req.body, (req.query as any).name);
  });

  // ================================================================= YNAB4 migration
  const ynabBody = z.object({
    files: z.array(z.object({ path: z.string().max(500), text: z.string() })).min(1).max(2000),
    options: z.object({ dateStyle: z.enum(['auto', 'DMY', 'MDY', 'YMD']).optional(), decimal: z.enum(['auto', 'comma', 'dot']).optional(), budgetName: z.string().max(100).optional(),
      accounts: z.record(z.string(), z.object({ type: accountType.optional(), onBudget: z.boolean().optional(), closed: z.boolean().optional() })).optional() }).optional(),
    confirmDuplicate: z.boolean().optional(),
  });
  const buildModel = (b: z.infer<typeof ynabBody>): { model: ImportModel; fingerprint: string; detected: { path: string; kind: string }[] } => {
    const detected: { path: string; kind: string }[] = []; let model: ImportModel;
    if (isYnab4Native(b.files)) {
      for (const f of b.files) detected.push({ path: f.path, kind: /\.yfull$/i.test(f.path) ? 'YNAB4 full budget (Budget.yfull)' : /\.ydiff$/i.test(f.path) ? 'YNAB4 sync diff' : /\.ydevice$/i.test(f.path) ? 'YNAB4 device info' : /\.ymeta$/i.test(f.path) ? 'YNAB4 budget metadata' : 'ignored' });
      const relevant = b.files.filter(f => /\.(yfull|ydiff|ydevice|ymeta)$/i.test(f.path));
      model = parseYnab4Native(relevant);
      if (b.options?.budgetName) model.budgetName = b.options.budgetName;
      return { model, detected, fingerprint: Core.fingerprint(relevant.filter(f => /\.(yfull|ydiff)$/i.test(f.path)).map(f => f.text)) };
    }
    let register: string | null = null, budget: string | null = null, name = b.options?.budgetName;
    for (const f of b.files) {
      const kind = detectYnab4Csv(f.text); detected.push({ path: f.path, kind: kind === 'register' ? 'YNAB4 Register export' : kind === 'budget' ? 'YNAB4 Budget export' : 'not recognised' });
      if (kind === 'register') { if (register !== null) throw bad('More than one Register export was selected. Select one Register and (optionally) its Budget export.'); register = f.text; name ??= /([^/\\]+?)\s+as of\s/i.exec(f.path)?.[1]; }
      if (kind === 'budget') { if (budget !== null) throw bad('More than one Budget export was selected.'); budget = f.text; }
    }
    if (register === null) throw new AppError(422, 'FORMAT_NOT_RECOGNISED', budget !== null ? 'Only a Budget export was found. The Register export (all transactions) is required as well.'
      : 'None of the selected files is a YNAB4 budget. Select the .ynab4 folder (or a zip of it), or the "-Register.csv" and "-Budget.csv" files exported from YNAB4.', { detected });
    model = parseYnab4Csv({ register, budget }, { dateStyle: b.options?.dateStyle, decimal: b.options?.decimal, budgetName: name, accounts: b.options?.accounts as any });
    return { model, detected, fingerprint: Core.fingerprint([register, budget ?? '']) };
  };
  const summarize = (model: ImportModel) => ({
    budgetName: model.budgetName, currency: model.currency, kind: model.kind,
    accounts: model.accounts.map(a => ({ name: a.name, type: a.type, onBudget: a.onBudget, closed: a.closed, typeKnown: a.typeKnown, transactions: model.transactions.filter(t => t.accountSid === a.sid).length,
      balance: model.transactions.filter(t => t.accountSid === a.sid).reduce((s, t) => s + t.amount, 0) })),
    groups: model.groups.map(g => ({ name: g.name, hidden: g.hidden, categories: model.categories.filter(c => c.groupSid === g.sid).map(c => ({ name: c.name, hidden: c.hidden })) })),
    sample: [...model.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40).map(t => ({ date: t.date, account: model.accounts.find(a => a.sid === t.accountSid)?.name,
      payee: t.transferAccountSid ? `Transfer : ${model.accounts.find(a => a.sid === t.transferAccountSid)?.name}` : t.payeeName ?? '',
      category: t.splits.length ? `Split (${t.splits.length})` : t.categorySid?.startsWith('income:') ? 'Income' : model.categories.find(c => c.sid === t.categorySid)?.name ?? '', amount: t.amount, cleared: t.cleared })),
    budgetMonths: [...new Set(model.budgets.map(x => x.month))].sort(), scheduled: model.scheduled.length,
  });
  app.post('/api/import/ynab4/preview', { bodyLimit: 512 * 1024 * 1024 }, async req => {
    const b = ynabBody.parse(req.body);
    let built; try { built = buildModel(b); } catch (e) { if (e instanceof AppError) throw e; throw new AppError(422, 'IMPORT_UNREADABLE', (e as Error).message); }
    // dry run in a throw-away in-memory database: the real audit, without touching anything on disk
    const mem = new BudgetService(openBudgetDb(':memory:'), 'preview');
    try { const result = applyImport(mem, built.model, built.fingerprint); return { detected: built.detected, summary: summarize(built.model), result, previousImports: core.findImports(built.fingerprint) }; }
    finally { mem.db.close(); }
  });
  app.post('/api/import/ynab4/commit', { bodyLimit: 512 * 1024 * 1024 }, async req => {
    const b = ynabBody.parse(req.body);
    let built; try { built = buildModel(b); } catch (e) { if (e instanceof AppError) throw e; throw new AppError(422, 'IMPORT_UNREADABLE', (e as Error).message); }
    if (built.model.warnings.some(w => w.code === 'date_order_ambiguous' || w.code === 'decimal_mixed')) throw new AppError(422, 'IMPORT_AMBIGUOUS', 'Choose the date order / number format before importing.');
    const previous = core.findImports(built.fingerprint);
    if (previous.length && !b.confirmDuplicate) throw new AppError(409, 'ALREADY_IMPORTED', `These files were already imported as "${previous[0].name}".`, { previous });
    core.backupAll('before-import'); // existing budgets are never modified by an import, but keep a safety copy anyway
    const svc = core.createBudget(built.model.budgetName);
    try { const result = applyImport(svc, built.model, built.fingerprint); core.renameBudget(svc.id, built.model.budgetName); return { budgetId: svc.id, result }; }
    catch (e) { core.discardBudget(svc.id); throw e; } // roll back completely: no half-imported budget is left behind
  });

  // ================================================================= per-budget API
  const svcOf = (req: FastifyRequest) => core.service((req.params as { bid: string }).bid);
  const P = '/api/b/:bid';
  app.get(`${P}/bootstrap`, async req => {
    const s = svcOf(req); const posted = s.postScheduled();
    return { id: s.id, settings: s.getSettings(), accounts: s.listAccounts(), groups: s.listGroups(), categories: s.listCategories(), payees: s.listPayees(), undo: s.undoStatus(), range: s.budgetRange(),
      scheduledPosted: posted.posted, today: todayISO(), lastImport: (s.db.prepare('SELECT summary FROM imports ORDER BY at DESC LIMIT 1').get() as { summary: string } | undefined)?.summary ?? null };
  });
  app.put(`${P}/settings`, async req => {
    const b = z.object({ name: z.string().min(1).max(100).optional(), currency: z.string().length(3).optional(), dateFormat: z.enum(['DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY']).optional(),
      format: z.object({ decimalSep: z.enum([',', '.']), groupSep: z.string().max(1), symbol: z.string().max(6), symbolFirst: z.boolean(), decimals: z.literal(2) }).optional() }).parse(req.body);
    const s = svcOf(req).updateSettings(b as any); if (b.name) core.renameBudget(svcOf(req).id, b.name); return s;
  });
  app.post(`${P}/undo`, async req => ({ label: svcOf(req).undo(), ...svcOf(req).undoStatus() }));
  app.post(`${P}/redo`, async req => ({ label: svcOf(req).redo(), ...svcOf(req).undoStatus() }));
  app.get(`${P}/integrity`, async req => ({ problems: svcOf(req).checkIntegrity() }));
  // accounts
  app.post(`${P}/accounts`, async req => { const b = z.object({ name: z.string().min(1).max(100), type: accountType, onBudget: z.boolean().optional(), balance: money.optional(), date: isoDate.optional(), note: z.string().max(2000).optional() }).parse(req.body); return { id: svcOf(req).createAccount(b as any) }; });
  app.patch(`${P}/accounts/:id`, async req => { const b = z.object({ name: z.string().min(1).max(100).optional(), type: accountType.optional(), closed: z.boolean().optional(), note: z.string().max(2000).optional(), onBudget: z.boolean().optional() }).parse(req.body); svcOf(req).updateAccount((req.params as any).id, b as any); return { ok: true }; });
  app.delete(`${P}/accounts/:id`, async req => { svcOf(req).deleteAccount((req.params as any).id); return { ok: true }; });
  app.post(`${P}/accounts/reorder`, async req => { svcOf(req).reorderAccounts(z.object({ ids: z.array(id).max(500) }).parse(req.body).ids); return { ok: true }; });
  app.get(`${P}/accounts/:id/reconcile`, async req => { const q = (req.query as any).statement; return svcOf(req).reconcileInfo((req.params as any).id, q !== undefined && /^-?\d+$/.test(q) ? Number(q) : undefined); });
  app.post(`${P}/accounts/:id/reconcile`, async req => { const b = z.object({ statementBalance: money, createAdjustment: z.boolean().optional(), date: isoDate.optional() }).parse(req.body); return svcOf(req).reconcile((req.params as any).id, b.statementBalance, b.createAdjustment === true, b.date); });
  // categories
  app.post(`${P}/groups`, async req => ({ id: svcOf(req).createGroup(z.object({ name: z.string().min(1).max(100) }).parse(req.body).name) }));
  app.patch(`${P}/groups/:id`, async req => { svcOf(req).updateGroup((req.params as any).id, z.object({ name: z.string().min(1).max(100).optional(), hidden: z.boolean().optional(), note: z.string().max(2000).optional() }).parse(req.body)); return { ok: true }; });
  app.delete(`${P}/groups/:id`, async req => { svcOf(req).deleteGroup((req.params as any).id); return { ok: true }; });
  app.post(`${P}/categories`, async req => { const b = z.object({ groupId: id, name: z.string().min(1).max(100) }).parse(req.body); return { id: svcOf(req).createCategory(b.groupId, b.name) }; });
  app.patch(`${P}/categories/:id`, async req => { svcOf(req).updateCategory((req.params as any).id, z.object({ name: z.string().min(1).max(100).optional(), hidden: z.boolean().optional(), note: z.string().max(2000).optional(), groupId: id.optional() }).parse(req.body)); return { ok: true }; });
  app.post(`${P}/categories/:id/delete`, async req => { svcOf(req).deleteCategory((req.params as any).id, z.object({ reassignTo: id.nullish() }).parse(req.body ?? {}).reassignTo); return { ok: true }; });
  app.post(`${P}/categories/reorder`, async req => { svcOf(req).reorderCategories(z.object({ order: z.array(z.object({ groupId: id, categoryIds: z.array(id).max(1000) })).max(500) }).parse(req.body).order); return { ok: true }; });
  app.patch(`${P}/payees/:id`, async req => { svcOf(req).renamePayee((req.params as any).id, z.object({ name: z.string().min(1).max(200) }).parse(req.body).name); return { ok: true }; });
  // transactions
  app.get(`${P}/transactions`, async req => {
    const q = z.object({ accountId: id.optional(), from: isoDate.optional(), to: isoDate.optional(), categoryId: id.optional(), groupId: id.optional(), payeeId: id.optional(), search: z.string().max(100).optional(),
      uncategorized: z.string().optional(), limit: z.string().regex(/^\d+$/).optional() }).parse(req.query);
    return svcOf(req).listTransactions({ ...q, uncategorized: q.uncategorized === '1', limit: q.limit ? Number(q.limit) : undefined });
  });
  app.post(`${P}/transactions`, async req => svcOf(req).createTransaction(txnInput.parse(req.body) as any));
  app.patch(`${P}/transactions/:id`, async req => { const b = txnInput.partial().extend({ allowReconciledEdit: z.boolean().optional() }).parse(req.body); const { allowReconciledEdit, ...patch } = b; return svcOf(req).updateTransaction((req.params as any).id, patch as any, { allowReconciledEdit }); });
  app.post(`${P}/transactions/delete`, async req => svcOf(req).deleteTransactions(z.object({ ids: z.array(id).min(1).max(5000) }).parse(req.body).ids));
  app.post(`${P}/transactions/duplicate`, async req => svcOf(req).duplicateTransactions(z.object({ ids: z.array(id).min(1).max(500) }).parse(req.body).ids));
  app.post(`${P}/transactions/bulk`, async req => { const b = z.object({ ids: z.array(id).min(1).max(5000), patch: z.object({ cleared: cleared.optional(), categoryId: id.nullable().optional(), flag: flag.optional(), accountId: id.optional(), payeeName: z.string().min(1).max(200).optional() }) }).parse(req.body); return svcOf(req).bulkUpdate(b.ids, b.patch as any); });
  // budget
  app.get(`${P}/budget/:month`, async req => svcOf(req).getBudget(month.parse((req.params as any).month)));
  app.put(`${P}/budget/:month/categories/:cid`, async req => { const p = req.params as any; const b = z.object({ budgeted: money.optional(), overspending: z.enum(['affects_buffer', 'confined']).nullable().optional(), note: z.string().max(2000).optional() }).parse(req.body); svcOf(req).setBudget(month.parse(p.month), p.cid, b); return { ok: true }; });
  app.put(`${P}/budget/:month/note`, async req => { svcOf(req).setMonthNote(month.parse((req.params as any).month), z.object({ note: z.string().max(5000) }).parse(req.body).note); return { ok: true }; });
  app.post(`${P}/budget/:month/quick`, async req => { const b = z.object({ action: z.enum(['budgeted_last_month', 'outflows_last_month', 'average_outflows_3', 'average_budgeted_3', 'balance_to_zero', 'zero']), categoryIds: z.array(id).max(2000).optional(), onlyEmpty: z.boolean().optional() }).parse(req.body); return { changed: svcOf(req).quickBudget(month.parse((req.params as any).month), b.action, b.categoryIds, b.onlyEmpty) }; });
  app.post(`${P}/budget/:month/move`, async req => { const b = z.object({ from: id, to: id, amount: money }).parse(req.body); svcOf(req).moveMoney(month.parse((req.params as any).month), b.from, b.to, b.amount); return { ok: true }; });
  // scheduled
  const sched = z.object({ id: id.optional(), accountId: id, nextDate: isoDate, frequency: z.enum(FREQUENCIES.map(f => f.value) as [string, ...string[]]), payeeName: z.string().max(200).nullish(), payeeId: id.nullish(), categoryId: id.nullable(), memo: z.string().max(2000),
    amount: money, flag, transferAccountId: id.nullable(), splits: z.array(z.object({ amount: money, categoryId: id.nullable(), memo: z.string().max(2000), transferAccountId: id.nullable() })).max(100) });
  app.get(`${P}/scheduled`, async req => svcOf(req).listScheduled());
  app.post(`${P}/scheduled`, async req => ({ id: svcOf(req).saveScheduled(sched.parse(req.body) as any) }));
  app.delete(`${P}/scheduled/:id`, async req => { svcOf(req).deleteScheduled((req.params as any).id); return { ok: true }; });
  app.post(`${P}/scheduled/:id/enter`, async req => svcOf(req).postScheduled(todayISO(), (req.params as any).id));
  // reports
  const csvIds = (v: unknown) => (typeof v === 'string' && v ? v.split(',').slice(0, 2000) : undefined);
  app.get(`${P}/reports/activity`, async req => { const q = req.query as any; return svcOf(req).reportActivity({ from: isoDate.parse(q.from), to: isoDate.parse(q.to), accountIds: csvIds(q.accountIds), categoryIds: csvIds(q.categoryIds) }); });
  app.get(`${P}/reports/balances`, async req => svcOf(req).reportBalances());
  app.get(`${P}/reports/budget`, async req => { const q = req.query as any; return svcOf(req).reportBudget(month.parse(q.from), month.parse(q.to)); });
  // backups & export
  app.get(`${P}/backups`, async req => core.listBackups(svcOf(req).id));
  app.post(`${P}/backups`, async req => ({ name: core.backup(svcOf(req).id, 'manual') }));
  app.get(`${P}/backups/:name`, async (req, reply) => {
    const s = svcOf(req); const name = (req.params as any).name as string; const path = core.backupPath(s.id, name);
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${s.getSettings().name.replace(/[^\w .-]/g, '_')}-${name.replace('.sqlite', '')}.budgetreborn"`).send(createReadStream(path));
  });
  app.get(`${P}/export/json`, async (req, reply) => {
    const s = svcOf(req); const tables: Record<string, unknown[]> = {};
    for (const t of ['meta', 'accounts', 'category_groups', 'categories', 'payees', 'transactions', 'monthly_budgets', 'month_notes', 'scheduled', 'reconciliations', 'payee_rules', 'imports']) tables[t] = s.db.prepare(`SELECT * FROM ${t}`).all();
    return reply.header('Content-Disposition', 'attachment; filename="budget-reborn-export.json"').send({ format: 'budget-reborn-export', version: 1, exportedAt: nowIso(), amountsIn: 'minor units (integer)', tables });
  });
  app.get(`${P}/export/register.csv`, async (req, reply) => {
    const s = svcOf(req); const f = s.getSettings().format; const accounts = new Map(s.listAccounts().map(a => [a.id, a.name]));
    const groups = new Map(s.listGroups().map(g => [g.id, g.name])); const cats = new Map(s.listCategories().map(c => [c.id, { name: c.name, group: groups.get(c.groupId) ?? '' }]));
    cats.set('income:this', { name: 'Available this month', group: 'Income' }); cats.set('income:next', { name: 'Available next month', group: 'Income' });
    const rows: (string | number)[][] = [['Account', 'Flag', 'Date', 'Payee', 'Category', 'Master Category', 'Sub Category', 'Memo', 'Outflow', 'Inflow', 'Cleared']];
    const line = (t: any, amount: number, categoryId: string | null, memo: string, payee: string) => { const c = categoryId ? cats.get(categoryId) : null;
      rows.push([accounts.get(t.accountId) ?? '', t.flag ?? '', t.date, payee, c ? `${c.group}: ${c.name}` : '', c?.group ?? '', c?.name ?? '', memo, amount < 0 ? formatMinor(-amount, f) : formatMinor(0, f), amount > 0 ? formatMinor(amount, f) : formatMinor(0, f), t.cleared === 'reconciled' ? 'R' : t.cleared === 'cleared' ? 'C' : 'U']); };
    for (const t of s.listTransactions((req.query as any).accountId ? { accountId: (req.query as any).accountId } : {})) {
      if (t.splits.length) t.splits.forEach((sp, i) => line(t, sp.amount, sp.categoryId, `(Split ${i + 1}/${t.splits.length}) ${sp.memo}`, sp.transferAccountId ? `Transfer : ${accounts.get(sp.transferAccountId)}` : t.payeeName));
      else line(t, t.amount, t.categoryId, t.memo, t.payeeName);
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="Register.csv"').send('﻿' + toCsv(rows));
  });
  app.get(`${P}/export/budget.csv`, async (req, reply) => {
    const s = svcOf(req); const f = s.getSettings().format; const { first } = s.budgetRange(); const last = monthOf(todayISO());
    const groups = new Map(s.listGroups().map(g => [g.id, g.name])); const cats = s.listCategories();
    const rows: (string | number)[][] = [['Month', 'Category', 'Master Category', 'Sub Category', 'Budgeted', 'Outflows', 'Category Balance']];
    const byMonth = new Map<string, Map<string, { budgeted: number; activity: number; available: number }>>();
    for (const r of s.reportBudget(first <= last ? first : last, last)) (byMonth.get(r.month) ?? byMonth.set(r.month, new Map()).get(r.month)!).set(r.categoryId, r);
    for (const [m, map] of byMonth) for (const c of cats) { const r = map.get(c.id); if (!r) continue; const g = groups.get(c.groupId) ?? ''; rows.push([m, `${g}: ${c.name}`, g, c.name, formatMinor(r.budgeted, f), formatMinor(-r.activity, f), formatMinor(r.available, f)]); }
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="Budget.csv"').send('﻿' + toCsv(rows));
  });
  // import rules
  const rule = z.object({ id: id.optional(), matchType: z.enum(['exact', 'contains', 'regex']), pattern: z.string().min(1).max(200), payeeName: z.string().max(200).nullable(), categoryId: id.nullable(), transferAccountId: id.nullable() });
  app.get(`${P}/rules`, async req => listRules(svcOf(req)));
  app.post(`${P}/rules`, async req => ({ id: saveRule(svcOf(req), rule.parse(req.body)) }));
  app.delete(`${P}/rules/:id`, async req => { deleteRule(svcOf(req), (req.params as any).id); return { ok: true }; });

  // ================================================================= Smart Bank Import
  app.get('/api/bank-import/template.json', async (_req, reply) => reply.header('Content-Disposition', 'attachment; filename="budget-reborn-transactions.example.json"').send(IMPORT_JSON_EXAMPLE));
  app.get('/api/bank-import/template.csv', async (_req, reply) => reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="budget-reborn-transactions.example.csv"').send(IMPORT_CSV_EXAMPLE));
  app.post(`${P}/bank-import/analyze`, { bodyLimit: 20 * 1024 * 1024 }, async req => {
    const b = z.object({ accountId: id, decimal: z.enum(['auto', 'comma', 'dot']).optional(), dateStyle: z.enum(['auto', 'DMY', 'MDY', 'YMD']).optional(),
      sources: z.array(z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('ocr'), name: z.string().max(200).optional(), lines: z.array(z.object({ text: z.string().max(500), confidence: z.number().min(0).max(100).optional() })).max(2000) }),
        z.object({ kind: z.literal('csv'), name: z.string().max(200).optional(), content: z.string() }),
        z.object({ kind: z.literal('json'), name: z.string().max(200).optional(), content: z.string() }),
        z.object({ kind: z.literal('candidates'), name: z.string().max(200).optional(), candidates: z.array(candidate).max(5000) }),
      ])).min(1).max(40) }).parse(req.body);
    const s = svcOf(req); const today = todayISO(); const currency = s.getSettings().currency;
    const all: Candidate[] = []; const notes: { source: number; name: string; found: number; message?: string }[] = [];
    b.sources.forEach((src, i) => {
      const opts = { today, sourceIndex: i, decimal: b.decimal, dateStyle: b.dateStyle, currency };
      let c: Candidate[] = [], message: string | undefined;
      if (src.kind === 'ocr') c = parseBankText(src.lines, opts);
      else if (src.kind === 'csv') { const r = parseBankCsv(src.content, opts); c = r.candidates; if (r.dateAmbiguous) message = 'Day/month order could not be determined from this file — choose the date format.'; if (!r.candidates.length) message = 'No transaction rows were recognised in this CSV.'; }
      else if (src.kind === 'json') { const r = parseImportJson(src.content, opts); if (r.errors.length) throw new AppError(422, 'IMPORT_SCHEMA', `${src.name ?? 'JSON'} does not match the import schema.`, { errors: r.errors }); c = r.candidates; }
      else c = finalize(src.candidates.map(x => ({ bookingDate: null, description: '', currency: null, balanceAfter: null, accountHint: null, categoryName: null, importId: null, raw: '', ...x, sourceIndex: i })) as Candidate[], today, currency);
      if (src.kind === 'ocr' && !c.length) message = 'No transaction rows could be read from this image.';
      notes.push({ source: i, name: src.name ?? `Source ${i + 1}`, found: c.length, message }); all.push(...c);
    });
    return { rows: analyze(s, b.accountId, all), sources: notes };
  });
  app.post(`${P}/bank-import/check`, async req => {
    const b = z.object({ accountId: id, rows: z.array(z.object({ date: isoDate.nullable(), amount: money.nullable(), payee: z.string().max(300), importId: z.string().max(200).nullish(), sourceIndex: z.number().int().optional() })).max(5000) }).parse(req.body);
    return recheck(svcOf(req), b.accountId, b.rows);
  });
  app.post(`${P}/bank-import/commit`, { bodyLimit: 10 * 1024 * 1024 }, async req => {
    const b = z.object({ accountId: id, rows: z.array(z.object({ date: isoDate, payeeName: z.string().max(200), amount: money, categoryId: id.nullish(), memo: z.string().max(500).optional(), transferAccountId: id.nullish(),
      importId: z.string().max(200).nullish(), rawPayee: z.string().max(300).optional(), issues: z.array(z.string().max(40)).max(30).optional(), reviewed: z.boolean().optional(), allowDuplicate: z.boolean().optional(), sourceIndex: z.number().int().optional() })).min(1).max(5000) }).parse(req.body);
    return commitBankImport(svcOf(req), b.accountId, b.rows as any);
  });
  /** Optional external vision extraction. The image is processed in memory only and never stored or logged. */
  app.post(`${P}/bank-import/vision`, { bodyLimit: 12 * 1024 * 1024 }, async req => {
    svcOf(req);
    if ((req.headers['x-vision-consent'] ?? '') !== 'yes') throw new AppError(400, 'CONSENT_REQUIRED', 'Explicit consent is required before an image is sent to an external provider.');
    if (!Buffer.isBuffer(req.body) || !sniffImage(req.body)) throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Only PNG, JPEG and WebP images are accepted.');
    const idx = Number((req.query as any).sourceIndex ?? 0);
    return { candidates: await extractWithVision(cfg, req.body, Number.isInteger(idx) ? idx : 0, todayISO()) };
  });

  // ================================================================= static frontend (only dist/web is ever served)
  if (existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false, index: ['index.html'],
      setHeaders: (res: any, path: string) => { (res.setHeader ? res.setHeader.bind(res) : res.header.bind(res))('Cache-Control', /[\\/]assets[\\/]/.test(path) || /[\\/]ocr[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || !existsSync(cfg.webDir) || req.method !== 'GET' || /\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0])) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
  app.addHook('onClose', async () => core.close());
  return app;
}
