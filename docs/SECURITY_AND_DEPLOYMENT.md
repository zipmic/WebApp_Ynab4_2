# Security and deployment

## Server requirements
- **Node.js ≥ 20.11** with the ability to keep one process running, and a writable private data directory.
- Native modules: `better-sqlite3` and `@node-rs/argon2` (prebuilt binaries for Linux/macOS/Windows x64 and arm64 are installed by npm).
- HTTPS in front (reverse proxy or the host's TLS). ~150 MB disk for the app, plus data.
- No database server, no other services, no outbound internet access needed.

**Static hosting alone is not possible**: the browser part is static files, but all data, authentication and
calculations live in the backend. **PHP-only hosting cannot run it.**

## Hosting decision — home Windows computer + Tailscale (owner's choice)
The owner's web space (Gigahost, PHP 8.2 on Apache) was probed with `deploy/hostcheck.php`: no Node.js, no Passenger,
no writable folder outside the web root — it cannot run this backend. The owner chose an always-on Windows computer at
home, reached from phone and other devices through Tailscale. Guide (Danish): `docs/DEPLOYMENT_GUIDE.md`; files:
`deploy/windows/` (settings template, start/backup scripts, installer registering two scheduled tasks as SYSTEM, restart script).

How that setup stays private and safe:
- The app listens on `127.0.0.1` only; nothing is reachable from the LAN or the internet. `tailscale serve` (tailnet-only,
  never `funnel`) terminates HTTPS and forwards to it.
- `BR_TRUST_PROXY` is **not** set: forwarded headers are ignored, so nothing depends on which headers Tailscale sends.
  `BR_PUBLIC_ORIGIN` = the tailnet HTTPS name makes the origin check and passkeys work whether or not the Host header is
  rewritten (covered by a test in `tests/unit/security.test.ts`).
- Consequences accepted for a single-user tailnet: all requests appear to come from 127.0.0.1, so per-IP throttling is
  shared (per-account throttling still applies); the session cookie is not marked `Secure` because the app itself sees
  plain HTTP (the browser only ever uses it over Tailscale's HTTPS or on localhost); first-run setup without token works
  only for a request addressed to `localhost` — the guide does setup on the computer before Tailscale is configured.
- Recommended in the guide: BitLocker, a Windows password, two-factor authentication or a passkey in the app.

Other options remain valid for later: a VPS with a reverse proxy (`deploy/budget-reborn.service`,
`deploy/nginx.conf.example`) or a host with a Node.js app feature. A PHP rewrite is not planned.

## Running in production
```bash
npm ci && npm run build
BR_DATA_DIR=/var/lib/budget-reborn BR_TRUST_PROXY=1 BR_REQUIRE_HTTPS=1 BR_PUBLIC_ORIGIN=https://budget.example.com npm start
# or put the settings in a file outside the app folder:  node --env-file=/etc/budget-reborn.env dist/server/index.mjs
```
All settings: `.env.example`. First start prints a setup token (also in `<data>/setup-token.txt`); the first visit creates the single owner account.

## Backups off the machine
Automatic backups (daily on use, before imports/restores) stay in `<data>/backups`. For a copy elsewhere, schedule:
```bash
# production install (after npm run build) — safe while the server runs
BR_DATA_DIR=/var/lib/budget-reborn node dist/server/backup-now.mjs --copy-to /mnt/offsite/budget-reborn
# development checkout
BR_DATA_DIR=./data npm run backup -- --copy-to /mnt/offsite/budget-reborn
```
Example cron line (daily 03:17): `17 3 * * * cd /opt/budget-reborn && BR_DATA_DIR=/var/lib/budget-reborn node dist/server/backup-now.mjs --copy-to /mnt/offsite/budget-reborn`.
The newest `BR_BACKUP_KEEP` scheduled backups per budget are kept in the data folder; copies in `--copy-to` are never
deleted by the app. Each copy is a complete budget that *Restore backup* accepts. The copies contain all financial
data unencrypted: the target must be private (encrypted disk or encrypted sync).

## Authentication and session model
- **Single owner, no registration.** `POST /api/auth/setup` works only while no user exists. Without the setup token it works only for a request that comes from loopback, is addressed to `localhost`/`127.0.0.1`, carries no proxy headers, and only when neither `BR_TRUST_PROXY` nor `BR_REQUIRE_HTTPS` is set. Everywhere else the token is required.
- Passwords: Argon2id (19 MiB, t=3), minimum 10 characters, uniform timing for unknown users.
- Optional TOTP (RFC 6238, replay-protected) and passkeys (WebAuthn via `@simplewebauthn`, user verification required). Passkeys need HTTPS (or localhost) and `BR_PUBLIC_ORIGIN` behind a proxy.
- Sessions: random 256-bit token in an `HttpOnly; SameSite=Strict` cookie (`__Host-` prefix and `Secure` over HTTPS); only its SHA-256 is stored. Idle timeout 7 days, absolute 30 days (configurable). "Sign out on all devices" deletes all sessions; changing the password does too.
- CSRF: per-session token required in `X-CSRF-Token` on every non-GET request, plus an Origin check.
- Throttling: per IP (10 failures / 15 min) and per account (5 failures → lock with exponential back-off up to 15 min), in memory.
- Every `/api` route is behind the session check except the five in `PUBLIC_ROUTES`; unknown `/api` paths also answer 401.

## Other controls
- Security headers on every response: CSP (`default-src 'self'`, scripts self + `wasm-unsafe-eval` for OCR, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS over HTTPS; API responses `no-store`.
- `BR_REQUIRE_HTTPS=1`: plain HTTP GET → 308 to HTTPS, other methods → 403.
- `BR_ALLOWED_NETWORKS`: address prefixes allowed to connect at all (VPN-only mode).
- `BR_TRUST_PROXY=1` must be set **only** behind a reverse proxy you control (it makes the server believe `X-Forwarded-*`).
- Uploads: backups are validated (SQLite header, schema, integrity and foreign-key checks, financial consistency) in a private temp folder before being added as a new budget; JSON exports are loaded row by row through the schema's constraints in one transaction and must pass the same consistency check, otherwise the new budget is discarded; images for the optional vision provider are checked by magic bytes, limited to 12 MB, held in memory only; JSON bodies are size-limited per route (2 MB default; 512 MB for YNAB4 import and restore, which need it).
- Only `dist/web` is served as static files. The data directory must be outside it and outside any web root.
- Logs contain error messages and an audit trail of authentication events (IP, event) — never request bodies or financial data.
- SQL is parameterised throughout; request bodies are validated with zod; amounts must be safe integers.

## Verified by tests
`tests/unit/security.test.ts` (setup token and proxy cases, Argon2id storage, 401 on the whole route table, CSRF/origin,
cookie flags, brute-force lockout, TOTP incl. replay, session expiry, sign-out everywhere, input validation, backup/restore,
traversal), `tests/e2e/run.mjs` (login, wrong password, passkey registration and sign-in with a virtual authenticator).

## Not done / to consider
- Throttle state is in memory (reset on restart). Acceptable for one user; persist if exposed publicly for long.
- No database encryption at rest; rely on disk encryption of the host. No PIN lock in the UI.
- 512 MB JSON bodies are buffered in memory (authenticated owner only).
- External vision provider: tested only against a mock; leave unconfigured unless wanted.
