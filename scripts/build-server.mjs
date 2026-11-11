// Bundles the server into a single ESM file. Native modules stay external.
import { build } from 'esbuild';
// the server, plus the backup command so a cron job on a production install (no dev dependencies) can run it
await build({
  entryPoints: { index: 'src/server/index.ts', 'backup-now': 'scripts/backup-now.ts' },
  outdir: 'dist/server', outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: true,
  external: ['better-sqlite3', '@node-rs/argon2'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('server bundle written to dist/server/index.mjs (and dist/server/backup-now.mjs)');
