import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
function proxyTrust(v: string | undefined): false | string {
  const t = (v ?? '').trim();
  if (!t || /^(0|false|no|off)$/i.test(t)) return false;
  if (/^(1|true|yes|on)$/i.test(t)) return 'loopback';
  if (!/^[0-9a-fA-F.:/,\s]+$|^(loopback|linklocal|uniquelocal)(\s*,\s*[0-9a-zA-Z.:/]+)*$/.test(t)) throw new Error(`BR_TRUST_PROXY must be 1 (proxy on this machine) or a list of proxy addresses, not "${t}"`);
  return t;
}
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export interface Config {
  production: boolean; host: string; port: number; dataDir: string; webDir: string;
  /** redirect/deny plain HTTP and mark cookies Secure */
  requireHttps: boolean;
  /** trust X-Forwarded-* from a reverse proxy (needed for HTTPS detection and client IPs behind nginx/Apache/Caddy) */
  /**
   * Which proxy addresses may set X-Forwarded-*: false, or a proxy-addr list such as 'loopback' or '10.0.0.5,10.0.0.0/8'.
   * BR_TRUST_PROXY=1 means a reverse proxy on THIS machine ('loopback'). Never trust every hop: a client could then
   * choose its own address by sending X-Forwarded-For and slip past the per-IP login throttle.
   */
  trustProxy: false | string;
  /** login only with a second factor (TOTP code or passkey) — for servers reachable from the internet */
  require2fa: boolean;
  /** if set, only these client addresses/prefixes may connect (VPN-only deployments), e.g. "10.8.0.,127.0.0.1,100.64." */
  allowedNetworks: string[];
  sessionIdleMinutes: number; sessionMaxDays: number;
  /** public origin, e.g. https://budget.example.com — required for passkeys behind a proxy */
  publicOrigin: string | null;
  vision: { baseUrl: string; apiKey: string; model: string } | null;
  backupKeep: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const dataDir = resolve(env.BR_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    production, host: env.BR_HOST ?? '127.0.0.1', port: int(env.BR_PORT ?? env.PORT, 8787), dataDir,
    webDir: resolve(env.BR_WEB_DIR ?? './dist/web'),
    requireHttps: bool(env.BR_REQUIRE_HTTPS, false), trustProxy: proxyTrust(env.BR_TRUST_PROXY), require2fa: bool(env.BR_REQUIRE_2FA, false),
    allowedNetworks: (env.BR_ALLOWED_NETWORKS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    sessionIdleMinutes: int(env.BR_SESSION_IDLE_MINUTES, 60 * 24 * 7), sessionMaxDays: int(env.BR_SESSION_MAX_DAYS, 30),
    publicOrigin: env.BR_PUBLIC_ORIGIN?.replace(/\/$/, '') || null,
    vision: env.BR_VISION_API_KEY || env.BR_VISION_BASE_URL ? { baseUrl: (env.BR_VISION_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''), apiKey: env.BR_VISION_API_KEY ?? '', model: env.BR_VISION_MODEL ?? 'gpt-4o-mini' } : null,
    backupKeep: int(env.BR_BACKUP_KEEP, 30),
  };
}
