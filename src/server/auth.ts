/**
 * Authentication for a private single-user installation: Argon2id passwords, optional TOTP and
 * passkeys, server-side sessions (only a SHA-256 of the token is stored), CSRF tokens, and
 * brute-force throttling per IP and per account.
 */
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { type DB, newId, nowIso } from './db.ts';
import { AppError, bad } from './errors.ts';

const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 6 digits, 30 s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
/** Returns the matching time step (for replay protection) or null. */
export function totpVerify(secret: string, code: string, now = Date.now(), lastStep = 0): number | null {
  const c = code.replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(now / 30000);
  for (const s of [cur, cur - 1, cur + 1]) if (s > lastStep && safeEqual(totpCode(secret, s), c)) return s;
  return null;
}

// ------------------------------------------------------------------ throttling
interface Bucket { fails: number; first: number; lockedUntil: number; strikes: number }
export class Throttle {
  private buckets = new Map<string, Bucket>();
  constructor(private maxFails: number, private windowMs: number, private baseLockMs: number, private maxLockMs: number) {}
  /** ms until the key may try again (0 = allowed) */
  retryAfter(key: string, now = Date.now()): number { const b = this.buckets.get(key); return b && b.lockedUntil > now ? b.lockedUntil - now : 0; }
  fail(key: string, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || now - b.first > this.windowMs) { b = { fails: 0, first: now, lockedUntil: 0, strikes: b?.strikes ?? 0 }; this.buckets.set(key, b); }
    b.fails++;
    if (b.fails >= this.maxFails) { b.lockedUntil = now + Math.min(this.maxLockMs, this.baseLockMs * 2 ** b.strikes); b.strikes++; b.fails = 0; b.first = now; }
    if (this.buckets.size > 10000) for (const [k, v] of this.buckets) if (v.lockedUntil < now && now - v.first > this.windowMs * 4) this.buckets.delete(k);
  }
  success(key: string) { this.buckets.delete(key); }
}

export interface SessionInfo { tokenHash: string; userId: string; csrf: string; createdAt: number; lastSeen: number; ip: string | null; userAgent: string | null }
export interface UserRow { id: string; username: string; password_hash: string; totp_secret: string | null; totp_enabled: number; totp_last_step: number }

export class Auth {
  readonly ipThrottle = new Throttle(10, 15 * 60_000, 60_000, 60 * 60_000);
  readonly userThrottle = new Throttle(5, 15 * 60_000, 30_000, 15 * 60_000);
  private setupTokenFile: string;
  /** short-lived WebAuthn challenges and pending-2FA tickets, keyed by an opaque id */
  private pending = new Map<string, { kind: string; value: string; userId?: string; expires: number }>();
  constructor(private sys: DB, private cfg: Config) {
    this.setupTokenFile = join(cfg.dataDir, 'setup-token.txt');
    if (!this.hasUser() && !existsSync(this.setupTokenFile)) writeFileSync(this.setupTokenFile, randomBytes(18).toString('base64url') + '\n', { mode: 0o600 });
  }
  audit(event: string, ip: string | null, detail = '') { this.sys.prepare('INSERT INTO audit(at,event,ip,detail) VALUES(?,?,?,?)').run(nowIso(), event, ip, detail.slice(0, 300)); }
  hasUser(): boolean { return !!this.sys.prepare('SELECT 1 FROM users LIMIT 1').get(); }
  setupToken(): string | null { try { return readFileSync(this.setupTokenFile, 'utf8').trim(); } catch { return null; } }
  user(id: string): UserRow | undefined { return this.sys.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined; }
  userByName(name: string): UserRow | undefined { return this.sys.prepare('SELECT * FROM users WHERE username=?').get(name) as UserRow | undefined; }

  static checkPasswordStrength(pw: string) {
    if (typeof pw !== 'string' || pw.length < 10) throw bad('Password must be at least 10 characters long.');
    if (pw.length > 256) throw bad('Password is too long.');
    if (/^(.)\1+$/.test(pw) || ['password123', '1234567890', 'qwertyuiop'].includes(pw.toLowerCase())) throw bad('Choose a less predictable password.');
  }
  /** One-time creation of the single user. There is no public registration: once a user exists this always fails. */
  async setup(username: string, password: string, token: string | undefined, isLoopback: boolean): Promise<string> {
    if (this.hasUser()) throw new AppError(403, 'SETUP_DONE', 'This installation is already set up.');
    const expected = this.setupToken();
    if (!isLoopback && (!expected || !token || !safeEqual(token.trim(), expected))) throw new AppError(403, 'SETUP_TOKEN', 'A valid setup token is required. It is in the file "setup-token.txt" in the data directory on the server.');
    username = username.trim(); if (!/^[\w.@-]{2,64}$/.test(username)) throw bad('Username must be 2–64 letters, digits, or . _ @ -');
    Auth.checkPasswordStrength(password);
    const id = newId(); const h = await hash(password, ARGON);
    const done = this.sys.transaction(() => { if (this.hasUser()) return false; this.sys.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)').run(id, username, h, nowIso()); return true; }).immediate();
    if (!done) throw new AppError(403, 'SETUP_DONE', 'This installation is already set up.');
    try { unlinkSync(this.setupTokenFile); } catch { /* already gone */ }
    return id;
  }
  private dummyHash: Promise<string> | null = null;
  /** Password check with uniform timing whether or not the user exists. */
  async verifyPassword(username: string, password: string): Promise<UserRow | null> {
    const u = this.userByName(username.trim());
    this.dummyHash ??= hash('not-the-password', ARGON);
    const ok = await verify(u?.password_hash ?? (await this.dummyHash), password.slice(0, 512)).catch(() => false);
    return u && ok ? u : null;
  }
  async changePassword(userId: string, current: string, next: string) {
    const u = this.user(userId)!;
    if (!(await verify(u.password_hash, current).catch(() => false))) throw new AppError(403, 'WRONG_PASSWORD', 'Current password is incorrect.');
    Auth.checkPasswordStrength(next);
    this.sys.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hash(next, ARGON), userId);
  }

  // sessions
  createSession(userId: string, ip: string | null, ua: string | null): { token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url'), now = Date.now();
    this.sys.prepare('INSERT INTO sessions(token_hash,user_id,csrf,created_at,last_seen,ip,user_agent) VALUES(?,?,?,?,?,?,?)').run(sha256(token), userId, csrf, now, now, ip, ua?.slice(0, 200) ?? null);
    this.sys.prepare('DELETE FROM sessions WHERE created_at<?').run(now - this.cfg.sessionMaxDays * 86400_000);
    return { token, csrf };
  }
  session(token: string | undefined): SessionInfo | null {
    if (!token || token.length > 200) return null;
    const h = sha256(token);
    const s = this.sys.prepare('SELECT token_hash tokenHash, user_id userId, csrf, created_at createdAt, last_seen lastSeen, ip, user_agent userAgent FROM sessions WHERE token_hash=?').get(h) as SessionInfo | undefined;
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > this.cfg.sessionIdleMinutes * 60_000 || now - s.createdAt > this.cfg.sessionMaxDays * 86400_000) { this.sys.prepare('DELETE FROM sessions WHERE token_hash=?').run(h); return null; }
    if (now - s.lastSeen > 60_000) this.sys.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(now, h);
    return s;
  }
  destroySession(tokenHash: string) { this.sys.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }
  destroyAllSessions(userId: string) { this.sys.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }
  listSessions(userId: string, currentHash: string) {
    return (this.sys.prepare('SELECT token_hash h, created_at createdAt, last_seen lastSeen, ip, user_agent userAgent FROM sessions WHERE user_id=? ORDER BY last_seen DESC').all(userId) as any[])
      .map(s => ({ id: s.h.slice(0, 12), current: s.h === currentHash, createdAt: s.createdAt, lastSeen: s.lastSeen, ip: s.ip, userAgent: s.userAgent }));
  }

  // pending tickets (2FA step, WebAuthn challenges)
  putPending(kind: string, value: string, userId?: string, ttlMs = 5 * 60_000): string {
    const id = randomBytes(18).toString('base64url'); const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(id, { kind, value, userId, expires: now + ttlMs }); return id;
  }
  takePending(id: string | undefined, kind: string, consume = true) {
    const p = id ? this.pending.get(id) : undefined;
    if (!p || p.kind !== kind || p.expires < Date.now()) return null;
    if (consume) this.pending.delete(id!); return p;
  }

  // TOTP
  totpBegin(userId: string): { secret: string; uri: string } {
    const u = this.user(userId)!; const secret = base32Encode(randomBytes(20));
    this.sys.prepare('UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?').run(secret, userId);
    return { secret, uri: `otpauth://totp/${encodeURIComponent('Budget Reborn:' + u.username)}?secret=${secret}&issuer=${encodeURIComponent('Budget Reborn')}&algorithm=SHA1&digits=6&period=30` };
  }
  totpCheck(u: UserRow, code: string): boolean {
    if (!u.totp_secret) return false;
    const step = totpVerify(u.totp_secret, code, Date.now(), u.totp_last_step);
    if (step === null) return false;
    this.sys.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(step, u.id); return true;
  }
  totpEnable(userId: string, code: string) {
    const u = this.user(userId)!; if (!this.totpCheck(u, code)) throw new AppError(403, 'TOTP_INVALID', 'That code is not valid. Check the time on your device and try again.');
    this.sys.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(userId);
  }
  totpDisable(userId: string) { this.sys.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(userId); }
}
