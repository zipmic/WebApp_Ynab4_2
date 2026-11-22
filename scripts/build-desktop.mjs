// Builds the desktop app's files into dist/desktop-app (the folder electron-builder packages):
//   main.cjs (main process + the whole application), preload.cjs, web/ (the built frontend), package.json
// Run after `vite build`. Native modules (better-sqlite3) are installed for the target by electron-builder.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const out = 'dist/desktop-app';
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, legalComments: 'none' };
await build({ ...common, entryPoints: ['src/desktop/main.ts'], outfile: `${out}/main.cjs`, external: ['electron', 'better-sqlite3', '@node-rs/argon2'] });
await build({ ...common, entryPoints: ['src/desktop/preload.cts'], outfile: `${out}/preload.cjs`, external: ['electron'] });
if (!existsSync('dist/web/index.html')) throw new Error('dist/web is missing: run `vite build` first');
cpSync('dist/web', `${out}/web`, { recursive: true });
// SQLite: better-sqlite3 ships ready-made Node-API binaries for Windows, macOS and Linux (x64 and arm64) inside the
// package. Node-API binaries work unchanged in Electron, so nothing is compiled; only the runtime files are copied.
const sq = 'node_modules/better-sqlite3';
for (const f of ['LICENSE', 'lib', 'prebuilds']) cpSync(`${sq}/${f}`, `${out}/${sq}/${f}`, { recursive: true });
{ const p = JSON.parse(readFileSync(`${sq}/package.json`, 'utf8')); delete p.dependencies; delete p.devDependencies; delete p.scripts; writeFileSync(`${out}/${sq}/package.json`, JSON.stringify(p, null, 2)); }
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(`${out}/package.json`, JSON.stringify({
  name: 'budget-reborn', productName: 'Budget Reborn', version: pkg.version, description: 'Budget Reborn — a private successor to YNAB4',
  main: 'main.cjs', author: 'Budget Reborn', license: 'UNLICENSED', private: true,
  dependencies: { 'better-sqlite3': JSON.parse(readFileSync(`${sq}/package.json`, 'utf8')).version },
}, null, 2));
console.log(`desktop app files written to ${out}`);
