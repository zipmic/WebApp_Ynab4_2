// Copies the OCR engine (worker, WASM core, language data) into public/ocr so that
// OCR runs entirely from this app's own origin — no CDN, no external requests.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const nm = 'node_modules', out = 'public/ocr';
if (!existsSync(join(nm, 'tesseract.js'))) process.exit(0); // production install without dev deps
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });
cpSync(join(nm, 'tesseract.js/dist/worker.min.js'), join(out, 'worker.min.js'));
for (const f of readdirSync(join(nm, 'tesseract.js-core')))
  if (/^tesseract-core.*\.(js|wasm)$/.test(f)) cpSync(join(nm, 'tesseract.js-core', f), join(out, 'core', f));
for (const l of ['dan', 'eng'])
  cpSync(join(nm, `@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`), join(out, 'lang', `${l}.traineddata.gz`));
