// Builds a ready-to-run package of Budget Reborn: no npm, no Git, no build step on the target computer —
// only Node.js (https://nodejs.org) must be installed there.
//   node scripts/package-windows.mjs                 → dist/BudgetReborn-windows-x64-<version>.zip
//   node scripts/package-windows.mjs --platform linux-x64 --dir <folder>   (unzipped, for testing on Linux)
// Run `npm run build` first. The package contains the built server and web app, the deploy scripts, the guide,
// and only the two runtime modules with native code (better-sqlite3, @node-rs/argon2) for the target platform.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const arg = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const platform = arg('--platform', 'windows-x64');
const PLATFORMS = {
  'windows-x64': { sqlite: ['win32-x64.node'], argon: ['@node-rs/argon2-win32-x64-msvc'] },
  'linux-x64': { sqlite: ['linux-x64.node'], argon: ['@node-rs/argon2-linux-x64-gnu'] },
};
const target = PLATFORMS[platform]; if (!target) { console.error(`unknown --platform ${platform}`); process.exit(2); }
if (!existsSync('dist/server/index.mjs') || !existsSync('dist/web/index.html')) { console.error('Run "npm run build" first.'); process.exit(1); }

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const outDir = arg('--dir', null);
const stage = outDir ?? join(mkdtempSync(join(tmpdir(), 'br-pkg-')), 'app');
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });

// app files
cpSync('dist/server', join(stage, 'dist/server'), { recursive: true, filter: f => !f.endsWith('.map') });
cpSync('dist/web', join(stage, 'dist/web'), { recursive: true });
cpSync('deploy/windows', join(stage, 'deploy/windows'), { recursive: true });
mkdirSync(join(stage, 'docs'), { recursive: true });
cpSync('docs/DEPLOYMENT_GUIDE.md', join(stage, 'docs/DEPLOYMENT_GUIDE.md'));
cpSync('README.md', join(stage, 'README.md'));
cpSync('.env.example', join(stage, '.env.example'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: pkg.engines,
  description: `${pkg.description} — prebuilt package (${platform}, commit ${commit}). Start: node dist/server/index.mjs` }, null, 2) + '\n');
writeFileSync(join(stage, 'VERSION.txt'), `Budget Reborn ${pkg.version}\r\ncommit ${commit}\r\nplatform ${platform}\r\nbuilt ${new Date().toISOString()}\r\n`);

// runtime modules with native code (everything else is bundled into dist/server/*.mjs)
const nm = join(stage, 'node_modules');
const sqliteSrc = 'node_modules/better-sqlite3';
mkdirSync(join(nm, 'better-sqlite3/prebuilds'), { recursive: true });
for (const f of ['package.json', 'LICENSE', 'README.md']) if (existsSync(join(sqliteSrc, f))) cpSync(join(sqliteSrc, f), join(nm, 'better-sqlite3', f));
cpSync(join(sqliteSrc, 'lib'), join(nm, 'better-sqlite3/lib'), { recursive: true });
for (const f of target.sqlite) cpSync(join(sqliteSrc, 'prebuilds', f), join(nm, 'better-sqlite3/prebuilds', f));
cpSync('node_modules/@node-rs/argon2', join(nm, '@node-rs/argon2'), { recursive: true });
const argonVersion = JSON.parse(readFileSync('node_modules/@node-rs/argon2/package.json', 'utf8')).version;
const tmp = mkdtempSync(join(tmpdir(), 'br-argon-'));
for (const name of target.argon) {
  const local = join('node_modules', name);
  if (existsSync(local)) { cpSync(local, join(nm, name), { recursive: true }); continue; }
  // the binary package for another platform is fetched from the npm registry with npm itself (same version, integrity-checked by npm)
  const tgz = execFileSync('npm', ['pack', `${name}@${argonVersion}`, '--pack-destination', tmp, '--silent'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim().split('\n').pop();
  mkdirSync(join(nm, name), { recursive: true });
  execFileSync('tar', ['xzf', join(tmp, tgz), '-C', join(nm, name), '--strip-components=1']);
}
rmSync(tmp, { recursive: true, force: true });

// zip (Windows) or leave unzipped (--dir)
const files = []; const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } }; walk(stage);
const size = files.reduce((s, f) => s + statSync(f).size, 0);
if (outDir) { console.log(`package (${platform}) written to ${stage}: ${files.length} files, ${(size / 1e6).toFixed(1)} MB`); process.exit(0); }
const entries = {}; for (const f of files) entries['BudgetReborn/app/' + relative(stage, f).replace(/\\/g, '/')] = [readFileSync(f), { level: /\.(png|wasm|gz|node|zip)$/.test(f) ? 0 : 6 }];
const zipFile = `dist/BudgetReborn-${platform}-${pkg.version}-${commit}.zip`;
writeFileSync(zipFile, zipSync(entries));
rmSync(join(stage, '..'), { recursive: true, force: true });
console.log(`${zipFile}: ${files.length} files, ${(size / 1e6).toFixed(1)} MB unpacked, ${(statSync(zipFile).size / 1e6).toFixed(1)} MB zipped`);
