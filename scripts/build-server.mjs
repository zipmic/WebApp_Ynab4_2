// Bundles the server into a single ESM file. Native modules stay external.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: true,
  external: ['better-sqlite3', '@node-rs/argon2'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('server bundle written to dist/server/index.mjs');
