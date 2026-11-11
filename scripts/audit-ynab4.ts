/**
 * Migration audit for a native YNAB4 budget. Imports into a throw-away in-memory database (nothing on disk is
 * touched, the source is only read) and prints a PASS / PARTIAL / FAIL table with counts and entity ids only.
 *   npm run audit:ynab4 -- "/path/to/My Budget~XXXX.ynab4"      (folder, .zip of it, or a Budget.yfull)
 *   npm run audit:ynab4 -- <path> --json /somewhere/outside/the/repo/report.json
 *   npm run audit:ynab4 -- <path> --budget-csv "/path/to/My Budget as of …-Budget.csv"
 *     additionally compares every category-month with YNAB4's own figures from its Budget export
 */
import { unzipSync } from 'fflate';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { BudgetService } from '../src/server/budgetService.ts';
import { openBudgetDb } from '../src/server/db.ts';
import { applyImport } from '../src/server/importService.ts';
import { auditNativeImport, compareWithBudgetCsv, verdictOf } from '../src/server/migrationAudit.ts';
import { decodeBytes } from '../src/shared/csv.ts';
import { parseYnab4Native, type SourceFile } from '../src/shared/ynab4native.ts';

const args = process.argv.slice(2); let input: string | undefined, jsonOut: string | null = null, budgetCsv: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') jsonOut = args[++i] ?? null; else if (args[i] === '--budget-csv') budgetCsv = args[++i] ?? null; else if (!input) input = args[i];
  else { console.error(`unexpected argument: ${args[i]}`); process.exit(2); }
}
if (!input || (args.includes('--json') && !jsonOut) || (args.includes('--budget-csv') && !budgetCsv)) { console.error('usage: npm run audit:ynab4 -- <.ynab4 folder | zip | Budget.yfull> [--budget-csv <Budget.csv>] [--json <file>]'); process.exit(2); }
const RELEVANT = /\.(yfull|ydiff|ydevice|ymeta)$/i; const files: SourceFile[] = [];
const st = statSync(input);
if (st.isDirectory()) { const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (RELEVANT.test(n)) files.push({ path: 'budget.ynab4/' + relative(input, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }); } }; walk(input); }
else if (/\.zip$/i.test(input)) { for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(input)), { filter: e => RELEVANT.test(e.name) }))) files.push({ path: name, text: decodeBytes(bytes).text }); }
else files.push({ path: 'Budget.yfull', text: readFileSync(input, 'utf8') });

const model = parseYnab4Native(files);
const svc = new BudgetService(openBudgetDb(':memory:'), 'audit');
const result = applyImport(svc, model, 'audit');
const audit = auditNativeImport(files, svc);
if (budgetCsv) { audit.areas.push(...compareWithBudgetCsv(svc, decodeBytes(new Uint8Array(readFileSync(budgetCsv))).text)); audit.verdict = verdictOf(audit.areas); }
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`\nYNAB4 migration audit — ${files.length} source file(s) read, import status: ${result.status}\n`);
console.log(pad('AREA', 66) + pad('RESULT', 9) + pad('SOURCE', 9) + pad('IMPORTED', 10) + 'DETAIL');
for (const a of audit.areas) { console.log(pad(a.area, 66) + pad(a.status, 9) + pad(a.source === null ? '' : String(a.source), 9) + pad(a.imported === null ? '' : String(a.imported), 10) + a.detail); for (const e of a.status === 'PASS' ? [] : a.examples) console.log('      · ' + e); }
console.log('\nNot imported (by design):'); for (const s of audit.skipped) console.log(`  ${String(s.count).padStart(6)}  ${s.kind} — ${s.reason}`);
console.log('\nImporter notes:'); for (const w of result.warnings) console.log(`  [${w.level}] ${w.code}${w.count ? ` (${w.count})` : ''}`);
console.log(`\nOVERALL: ${audit.verdict}\n`);
if (jsonOut) { const out = resolve(jsonOut); if (out.startsWith(resolve('.') + '/')) console.warn('WARNING: writing the report inside the repository. It contains only ids and counts, but do not commit it.'); writeFileSync(out, JSON.stringify({ importStatus: result.status, counts: result.counts, ...audit }, null, 2)); console.log('report written to ' + out); }
svc.db.close(); process.exit(audit.verdict === 'FAIL' ? 1 : 0);
