import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

// The built server (dist/server/index.mjs) always runs in production mode, also when started without NODE_ENV
// (e.g. on Windows, where "NODE_ENV=production node …" does not work). `npm run dev` runs the sources and is unaffected.
declare const __PRODUCTION_BUNDLE__: boolean | undefined;
if (typeof __PRODUCTION_BUNDLE__ !== 'undefined' && __PRODUCTION_BUNDLE__) process.env.NODE_ENV = 'production';

const cfg = loadConfig();
const app = await buildApp(cfg);
await app.listen({ host: cfg.host, port: cfg.port });
console.log(`Budget Reborn listening on http://${cfg.host}:${cfg.port}  (data: ${cfg.dataDir})`);
if (!app.core.auth.hasUser()) console.log(`First run: open the app to create your login. Setup token (needed when not on localhost): ${app.core.auth.setupToken()}`);
if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && !cfg.requireHttps) console.warn('WARNING: listening on a network interface without BR_REQUIRE_HTTPS=1. Put the app behind HTTPS before exposing it.');
// daily maintenance: automatic backups and scheduled transactions even if nobody opens the app
setInterval(() => { for (const b of app.core.listBudgets()) { try { app.core.service(b.id).postScheduled(); app.core.backup(b.id, 'auto'); } catch { /* next time */ } } }, 6 * 3600_000).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.close().finally(() => process.exit(0)); });
