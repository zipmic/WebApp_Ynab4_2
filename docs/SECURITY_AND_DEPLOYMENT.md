# Security and deployment

## Server requirements
- **Node.js ≥ 20.11** with the ability to keep one process running, and a writable private data directory.
- Native modules: `better-sqlite3` and `@node-rs/argon2` (prebuilt binaries for Linux/macOS/Windows x64 and arm64 are installed by npm).
- HTTPS in front (reverse proxy or the host's TLS). ~150 MB disk for the app, plus data.
- No database server, no other services, no outbound internet access needed.

**Static hosting alone is not possible**: the browser part is static files, but all data, authentication and
calculations live in the backend. **PHP-only hosting cannot run it.**

## Hosting decision — PENDING (owner)
The owner's current web space was probed with `deploy/hostcheck.php`: PHP 8.2 on Apache, HTTPS, pdo_sqlite and
pdo_mysql available; **no Node.js, no Passenger, no Argon2id in PHP, and no writable folder outside the web root**.
That host cannot run Budget Reborn as built. The owner has other hosting where Node apps have worked.

Options, in order of recommendation:
1. **A host/VPS where Node runs** (the place earlier Node apps worked, or any small VPS): nginx/Caddy/Apache as HTTPS reverse proxy → `127.0.0.1:8787`. Files: `deploy/budget-reborn.service`, `deploy/nginx.conf.example`.
2. **Home device (mini-PC, NAS, Raspberry Pi) reachable only through a VPN** (WireGuard/Tailscale). Most private; set `BR_ALLOWED_NETWORKS`.
3. **Shared host with a "Node.js app" feature** (cPanel/Passenger): works if native modules can be installed; see `deploy/apache.htaccess.example`.
4. **PHP rewrite of the backend** — not recommended and not started. It would mean re-implementing and re-verifying the engine, importers and audit in PHP (or keeping two implementations in sync), and on the probed host it would also mean weaker password hashing (bcrypt) and a database inside the web root protected only by `.htaccess`. Discuss with the owner before considering it.

## Running in production
```bash
npm ci && npm run build
BR_DATA_DIR=/var/lib/budget-reborn BR_TRUST_PROXY=1 BR_REQUIRE_HTTPS=1 BR_PUBLIC_ORIGIN=https://budget.example.com npm start
```
All settings: `.env.example`. First start prints a setup token (also in `<data>/setup-token.txt`); the first visit creates the single owner account.

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
- Uploads: backups are validated (SQLite header, schema, integrity and foreign-key checks, financial consistency) in a private temp folder before being added as a new budget; images for the optional vision provider are checked by magic bytes, limited to 12 MB, held in memory only; JSON bodies are size-limited per route (2 MB default; 512 MB for YNAB4 import and restore, which need it).
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
- Backups stay on the same machine unless the owner downloads them; add an off-site copy routine.
