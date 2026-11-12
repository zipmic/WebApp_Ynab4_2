/**
 * End-to-end test against the production build (run `npm run build` first).
 * Drives a real browser through first-run setup, budgeting, the register, YNAB4 migration,
 * Smart Bank Import with real local OCR, reconciliation, backup and the phone layout.
 * Screenshots are written to tests/e2e/screenshots.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const PORT = 8911, BASE = `http://localhost:${PORT}`, // "localhost" (not an IP) so that passkeys have a valid relying-party id
  PROBE = `http://127.0.0.1:${PORT}`, shots = 'tests/e2e/screenshots';
if (!existsSync('dist/server/index.mjs')) { console.error('Run "npm run build" first.'); process.exit(1); }
mkdirSync(shots, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'br-e2e-'));
const server = spawn('node', ['dist/server/index.mjs'], { env: { ...process.env, NODE_ENV: 'production', BR_DATA_DIR: dataDir, BR_PORT: String(PORT) }, stdio: 'pipe' });
let serverLog = ''; server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 50; i++) { try { if ((await fetch(PROBE + '/api/auth/status')).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 200)); }

let passed = 0; const failures = [];
let bail = false;
const step = async (name, fn) => { if (bail) return; const t = Date.now(); try { await fn(); passed++; console.log(`  ✓ ${name} (${Date.now() - t} ms)`); } catch (e) { failures.push(name); bail = !!process.env.BAIL; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); try { await page.screenshot({ path: `${shots}/FAILED-${name.replace(/\W+/g, '-')}.png` }); } catch { /* ignore */ } } };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true, locale: 'da-DK' });
ctx.setDefaultTimeout(12000); let page = await ctx.newPage(); const errors = [];
page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
const shot = name => page.screenshot({ path: `${shots}/${name}.png` });
const text = sel => page.locator(sel).innerText();
const atb = async () => (await text('[data-testid=atb]')).split('\n')[0].trim();

// synthetic YNAB4 CSV export (Danish formatting)
const kr = n => 'kr' + (n / 100).toLocaleString('da-DK', { minimumFractionDigits: 2 });
const REG = ['"Account","Flag","Check Number","Date","Payee","Category","Master Category","Sub Category","Memo","Outflow","Inflow","Cleared","Running Balance"',
  `"Lønkonto","","","31-12-2025","Starting Balance","Income: Available this month","Income","Available this month","","kr0,00","${kr(2000000)}","R","${kr(2000000)}"`,
  `"Lønkonto","","","02-01-2026","Boligforeningen","Faste: Husleje","Faste","Husleje","januar","${kr(950000)}","kr0,00","R","${kr(1050000)}"`,
  `"Lønkonto","Red","","05-01-2026","Netto","Hverdag: Dagligvarer","Hverdag","Dagligvarer","(Split 1/2) mad","${kr(65000)}","kr0,00","C","${kr(985000)}"`,
  `"Lønkonto","Red","","05-01-2026","Netto","Hverdag: Husholdning","Hverdag","Husholdning","(Split 2/2) ","${kr(20000)}","kr0,00","C","${kr(965000)}"`,
  `"Lønkonto","","","10-01-2026","Transfer : Opsparing","","","","","${kr(300000)}","kr0,00","C","${kr(665000)}"`,
  `"Opsparing","","","10-01-2026","Transfer : Lønkonto","","","","","kr0,00","${kr(300000)}","C","${kr(300000)}"`,
  `"Lønkonto","","","03-02-2026","Føtex","Hverdag: Dagligvarer","Hverdag","Dagligvarer","","${kr(120000)}","kr0,00","U","${kr(545000)}"`].join('\r\n') + '\r\n';
const BUD = ['"Month","Category","Master Category","Sub Category","Budgeted","Outflows","Category Balance"',
  `"December 2025","Faste: Husleje","Faste","Husleje","kr0,00","kr0,00","kr0,00"`,
  `"January 2026","Faste: Husleje","Faste","Husleje","${kr(950000)}","${kr(950000)}","kr0,00"`, `"January 2026","Hverdag: Dagligvarer","Hverdag","Dagligvarer","${kr(100000)}","${kr(65000)}","${kr(35000)}"`,
  `"January 2026","Hverdag: Husholdning","Hverdag","Husholdning","${kr(10000)}","${kr(20000)}","-${kr(10000)}"`,
  `"February 2026","Hverdag: Dagligvarer","Hverdag","Dagligvarer","${kr(100000)}","${kr(120000)}","${kr(15000)}"`, `"February 2026","Hverdag: Husholdning","Hverdag","Husholdning","kr0,00","kr0,00","kr0,00"`].join('\r\n') + '\r\n';
writeFileSync(join(dataDir, 'Mit budget as of 2026-02-10 1200 PM-Register.csv'), '﻿' + REG); writeFileSync(join(dataDir, 'Mit budget as of 2026-02-10 1200 PM-Budget.csv'), '﻿' + BUD);

console.log('Budget Reborn end-to-end');
await step('first run shows the one-time setup and rejects a weak password', async () => {
  await page.goto(BASE); await page.getByText('Create your private login').waitFor();
  await page.getByLabel('Username').fill('owner'); await page.getByLabel('Password', { exact: true }).fill('short'); await page.getByLabel('Repeat password').fill('short');
  await page.getByRole('button', { name: 'Create login' }).click(); await page.waitForTimeout(300); expect(await page.getByText('Create your private login').count(), 'weak password accepted');
  await page.getByLabel('Password', { exact: true }).fill('a-very-long-e2e-password'); await page.getByLabel('Repeat password').fill('a-very-long-e2e-password'); await page.getByRole('button', { name: 'Create login' }).click();
  await page.getByText('Welcome to Budget Reborn').waitFor(); await shot('01-welcome');
  for (const t of ['Import YNAB4 budget', 'Create new budget', 'Restore backup']) expect(await page.getByText(t).count(), `missing option ${t}`);
});
await step('create a budget, an account with a starting balance and categories', async () => {
  await page.getByText('Create new budget').click(); await page.getByLabel('Budget name').fill('E2E-budget'); await page.getByRole('button', { name: 'Create budget' }).click();
  await page.getByText('Set up your categories').waitFor();
  await page.getByRole('button', { name: 'Add account' }).click(); await page.getByLabel('Name').fill('Lønkonto'); await page.getByLabel('Current balance').fill('10.000,00'); await page.getByRole('button', { name: 'Add account', exact: true }).last().click();
  await page.getByText('Starting Balance').waitFor(); await page.getByRole('link', { name: 'Budget', exact: true }).click();
  await page.getByRole('button', { name: 'Add category group' }).first().click(); await page.getByLabel('Group name').fill('Hverdag'); await page.getByRole('button', { name: 'Save' }).click();
  for (const c of ['Dagligvarer', 'Transport']) { await page.getByRole('button', { name: 'Add category to Hverdag' }).click(); await page.getByLabel('Category name').fill(c); await page.getByRole('button', { name: 'Save' }).click(); await page.getByText(c, { exact: true }).first().waitFor(); }
  expect((await atb()) === '10.000,00', `ATB should be 10.000,00, is ${await atb()}`);
});
await step('budgeting: typing amounts (with arithmetic) updates Available to Budget instantly; keyboard moves down', async () => {
  const cell = page.getByLabel('Budgeted for Dagligvarer'); await cell.click(); await cell.fill('2000+500'); await cell.press('Enter');
  await page.waitForTimeout(300); expect((await atb()) === '7.500,00', `ATB after budgeting is ${await atb()}`);
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Budgeted for Transport', 'Enter did not move to the next category');
  await page.keyboard.type('800'); await page.keyboard.press('Enter'); await page.waitForTimeout(300); expect((await atb()) === '6.700,00', `ATB is ${await atb()}`);
});
await step('two devices: a stale edit is refused with a clear message, the newer data is shown, nothing is lost', async () => {
  const other = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: await ctx.storageState(), locale: 'da-DK' });
  const p2 = await other.newPage(); p2.on('pageerror', e => errors.push('device 2: ' + e.message));
  await p2.goto(BASE + '/#/budget'); await p2.locator('[data-testid=atb]').waitFor();
  const cell = (p, name) => p.getByLabel(`Budgeted for ${name}`);
  await cell(p2, 'Transport').fill('1000'); await cell(p2, 'Transport').press('Enter'); await p2.waitForTimeout(500);
  expect((await atb()) === '6.700,00', 'device 1 should still show its old view');
  // device 1 has not seen that change: its edit must be refused, not silently applied on top
  await cell(page, 'Dagligvarer').fill('3000'); await cell(page, 'Dagligvarer').press('Enter');
  await page.getByText(/changed from another device/).waitFor();
  await page.waitForTimeout(600);
  expect(await cell(page, 'Transport').inputValue() === '1.000,00', `device 1 not refreshed: ${await cell(page, 'Transport').inputValue()}`);
  expect(await cell(page, 'Dagligvarer').inputValue() === '2.500,00', 'the refused edit is still shown');
  expect((await atb()) === '6.500,00', `ATB after refresh: ${await atb()}`);
  // after the refresh the same device can edit again
  await cell(page, 'Transport').fill('800'); await cell(page, 'Transport').press('Enter'); await page.waitForTimeout(500);
  expect((await atb()) === '6.700,00', `ATB after retry: ${await atb()}`);
  await p2.reload(); await p2.locator('[data-testid=atb]').waitFor(); expect(await cell(p2, 'Transport').inputValue() === '800,00', 'device 2 does not see the retry');
  // a write that fails for another reason (simulated server error) is rolled back on screen too
  const before = errors.length;
  await page.route('**/api/b/*/budget/*/categories/*', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Simulated failure. No changes were saved.' } }) }));
  await cell(page, 'Transport').fill('1234'); await cell(page, 'Transport').press('Enter'); await page.getByText('Simulated failure').waitFor(); await page.waitForTimeout(600);
  await page.unroute('**/api/b/*/budget/*/categories/*');
  for (let i = errors.length - 1; i >= before; i--) if (/status of 500/.test(errors[i])) errors.splice(i, 1); // the simulated failure only
  expect(await cell(page, 'Transport').inputValue() === '800,00', `failed edit left on screen: ${await cell(page, 'Transport').inputValue()}`);
  expect((await atb()) === '6.700,00', `ATB after failed edit: ${await atb()}`);
  await other.close();
});
await step('register: add a transaction with payee/category autocomplete; budget activity follows', async () => {
  await page.getByRole('link', { name: /Lønkonto/ }).click(); await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByLabel('Payee').fill('Netto'); await page.getByLabel('Category', { exact: true }).fill('Dagl'); await page.keyboard.press('Enter');
  await page.getByLabel('Outflow').fill('428,50'); await page.getByLabel('Memo').fill('e2e'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Netto', { exact: true }).first().waitFor(); await page.waitForTimeout(300);
  expect((await page.locator('header').first().innerText()).includes('9.571,50'), 'account balance not 9.571,50');
  await page.getByRole('link', { name: 'Budget', exact: true }).click(); await page.waitForTimeout(400);
  const row = await page.locator('tr[data-cat]', { hasText: 'Dagligvarer' }).innerText(); expect(row.includes('-428,50') && row.includes('2.071,50'), `category row wrong: ${row.replace(/\s+/g, ' ')}`);
  await shot('02-budget-desktop');
});
await step('split transaction must add up; overspending shows up and undo/redo work', async () => {
  await page.getByRole('link', { name: /Lønkonto/ }).click(); await page.getByText('Starting Balance').waitFor(); await page.keyboard.press('n'); await page.locator('[data-testid=txn-editor]').waitFor();
  await page.getByLabel('Payee').fill('Føtex'); await page.getByLabel('Outflow').fill('1000'); await page.getByRole('button', { name: 'Split transaction' }).click();
  await page.getByLabel('Split 1 category').fill('Dagl'); await page.keyboard.press('Enter'); await page.getByLabel('Split 1 outflow').fill('700');
  await page.getByText('Remaining to assign').waitFor(); expect(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'unbalanced split could be saved');
  await page.getByLabel('Split 2 category').fill('Transp'); await page.keyboard.press('Enter'); await page.getByLabel('Split 2 outflow').fill('300'); await page.getByText('Fully assigned').waitFor();
  await shot('03-register-split-editor'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByText('Split (2)').waitFor();
  await page.keyboard.press('Control+z'); await page.getByText('Undid: Add transaction').waitFor(); expect(!(await page.getByText('Split (2)').count()), 'undo did not remove the split');
  await page.keyboard.press('Control+y'); await page.getByText('Split (2)').waitFor();
});
await step('search, selection and bulk actions in the register', async () => {
  await page.getByLabel('Search transactions').fill('netto'); await page.waitForTimeout(200); expect((await page.locator('footer').innerText()).includes('1 of 3'), 'search did not filter');
  await page.getByLabel('Search transactions').fill(''); await page.getByText('Netto', { exact: true }).first().click(); await page.getByRole('button', { name: 'Mark cleared' }).click(); await page.waitForTimeout(300);
  expect((await page.locator('header').first().innerText()).replace(/\s+/g, ' ').includes('9.571,50 cleared'), 'bulk clear failed');
});
await step('reconciliation: mismatch is explained, nothing is adjusted silently, matching balance reconciles', async () => {
  await page.getByRole('button', { name: 'Reconcile' }).click(); await page.getByRole('button', { name: 'No', exact: true }).click();
  await page.getByLabel('What is the balance at your bank?').fill('8.571,50'); await page.getByRole('button', { name: 'Compare' }).click();
  await page.getByText('An uncleared transaction equals the difference').waitFor(); await shot('04-reconcile-difference');
  expect(await page.getByRole('button', { name: /Create adjustment of -1.000,00/ }).count(), 'explicit adjustment button missing');
  await page.getByRole('button', { name: 'Close' }).click(); expect((await page.locator('footer').innerText()).includes('3 transactions'), 'reconcile changed the register without confirmation');
  await page.getByRole('button', { name: 'Reconcile' }).click(); await page.getByRole('button', { name: 'Yes, it matches' }).click(); await page.getByText(/Reconciled 2 transactions/).waitFor();
});
await step('Smart Bank Import: real local OCR of two overlapping screenshots, duplicate detection, atomic import', async () => {
  await page.getByRole('link', { name: 'Import Transactions' }).click();
  const external = []; page.on('request', r => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  await page.locator('input[type=file]').setInputFiles(['tests/fixtures/screens/mobile-light-1.png', 'tests/fixtures/screens/mobile-light-2.png']);
  await page.locator('[data-testid=import-row]').first().waitFor({ timeout: 120000 }); await page.waitForTimeout(1500);
  const rows = await page.$$eval('[data-testid=import-row]', trs => trs.map(tr => ({ v: [...tr.querySelectorAll('input:not([type=checkbox])')].map(i => i.value), status: tr.querySelector('td:nth-child(7)').innerText, checked: tr.querySelector('input[type=checkbox]').checked })));
  expect(rows.length === 11, `expected 11 rows from the two screenshots, got ${rows.length}`);
  expect(rows[0].v[0] === '2026-11-08' && /netto/i.test(rows[0].v[1]) && rows[0].v[3] === '428,50', `first row misread: ${rows[0].v.join('|')}`);
  expect(rows.filter(r => /Likely duplicate/.test(r.status)).length === 2 && rows.filter(r => /overlap/.test(r.status)).length === 2, 'overlapping rows were not flagged as duplicates');
  expect(rows.filter(r => /Kaffe/.test(r.v[1]) && r.checked).length === 2, 'two genuine identical purchases must both be kept');
  expect(rows.find(r => r.v[1] === 'LØN')?.v[4] === '32.500,00', 'salary must be an inflow');
  expect(/netto/i.test(rows[0].v[1]) && rows[0].v[2] === 'Dagligvarer', 'category should be suggested from history');
  expect(external.length === 0, `OCR made external requests: ${external[0]}`);
  // the Netto purchase typed in by hand three days "later" has the same amount: flagged, not pre-selected, never silently doubled
  // the Netto purchase typed in by hand earlier is dated today; it counts as a possible duplicate only within 3 days
  const today = new Date(); const gap = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(2026, 10, 8)) / 86400000);
  const nearby = gap >= 0 && gap <= 3;
  expect(/Possible duplicate/.test(rows[0].status) === nearby && rows[0].checked === !nearby, `Netto row (gap ${gap} days) should ${nearby ? '' : 'not '}be flagged: ${rows[0].status}`);
  const expected = nearby ? 8 : 9;
  await shot('05-bank-import-review');
  await page.getByRole('button', { name: new RegExp(`Import ${expected} into Lønkonto`) }).click(); await page.getByText(`${expected} transactions imported`).waitFor(); await shot('06-bank-import-done');
  // the same screenshot again: every row is now a duplicate and nothing is pre-selected
  await page.locator('input[type=file]').setInputFiles(['tests/fixtures/screens/mobile-light-1.png']); await page.locator('[data-testid=import-row]').first().waitFor({ timeout: 120000 }); await page.waitForTimeout(1200);
  const again = await page.$$eval('[data-testid=import-row]', trs => trs.map(tr => tr.querySelector('input[type=checkbox]').checked));
  expect(again.length === 6 && again.every(c => !c), 're-imported screenshot rows were pre-selected');
  expect(await page.getByRole('button', { name: /Import 0 into/ }).isDisabled(), 'import button enabled with only duplicates');
});
await step('JSON (ChatGPT-assisted) import validates the schema', async () => {
  await page.getByRole('button', { name: 'Start over' }).click(); await page.getByRole('button', { name: 'Paste JSON / CSV text' }).click();
  await page.locator('textarea').fill('{"schema":"budget-reborn.transactions.v1","transactions":[{"date":"12/11/2026","payee":"X","amount":"-1,50"}]}'); await page.getByRole('button', { name: 'Preview' }).click();
  await page.getByText(/does not match the import schema/).waitFor();
  await page.getByRole('button', { name: 'Start over' }).click(); await page.getByRole('button', { name: 'Paste JSON / CSV text' }).click();
  await page.locator('textarea').fill('{"schema":"budget-reborn.transactions.v1","transactions":[{"date":"2026-11-09","payee":"Matas","amount":"-89.95"}]}'); await page.getByRole('button', { name: 'Preview' }).click();
  await page.locator('[data-testid=import-row]').first().waitFor(); expect((await page.locator('[data-testid=import-row]').first().innerText()).includes('Likely new'), 'valid JSON row not shown as new');
});
await step('reports render from real data with a table view', async () => {
  await page.getByRole('link', { name: 'Reports' }).click(); await page.getByText('Spending by category').first().waitFor(); await page.getByRole('button', { name: /Dagligvarer/ }).first().waitFor();
  await shot('07-report-spending'); await page.getByRole('tab', { name: 'Net worth' }).click(); await page.locator('svg[role=img]').waitFor(); await shot('08-report-networth');
});
await step('YNAB4 migration wizard: detect, preview, verify against the source, import, open', async () => {
  await page.evaluate(() => { location.hash = '#/ynab4-import'; }); await page.getByText('Drop your YNAB4 budget here').waitFor(); await shot('09-ynab4-select');
  await page.locator('input[type=file]').nth(1).setInputFiles([join(dataDir, 'Mit budget as of 2026-02-10 1200 PM-Register.csv'), join(dataDir, 'Mit budget as of 2026-02-10 1200 PM-Budget.csv')]);
  await page.getByText('YNAB4 Register export').waitFor(); expect(await page.getByLabel('Budget name').inputValue() === 'Mit budget', 'budget name not detected'); await shot('10-ynab4-preview');
  await page.getByRole('button', { name: 'Continue to verification' }).click(); await page.getByText('Verification against your source files').waitFor();
  const checks = await page.locator('section', { hasText: 'Verification against your source files' }).innerText();
  expect(/All 5 category-month values/.test(checks.replace(/\s+/g, ' ')) || /category-month values across/.test(checks), `monthly verification missing: ${checks.slice(0, 300)}`); expect(/All 2 account balance/.test(checks), 'account balances not verified');
  await shot('11-ynab4-verify'); await page.getByRole('button', { name: /Import 6 transactions/ }).click(); await page.getByText('Migration complete and verified').waitFor(); await shot('12-ynab4-done');
  await page.getByRole('button', { name: 'Open my budget' }).click(); await page.locator('[data-testid=atb]').waitFor();
  await page.evaluate(() => { location.hash = '#/budget/2026-02'; }); await page.waitForTimeout(600);
  const feb = (await page.locator('header').first().innerText()).replace(/\s+/g, ' ');
  expect(feb.includes('-100,00 Overspent in Jan') && (await atb()) === '8.300,00', `February header wrong: ${feb}`); // 20000 − 10600 budgeted in Jan − 100 overspent − 1000 budgeted in Feb
  expect((await page.locator('aside').first().innerText()).includes('Opsparing'), 'imported account missing from the sidebar');
});
await step('backup download is a complete SQLite file; security settings are present', async () => {
  await page.evaluate(() => { location.hash = '#/settings'; }); await page.getByRole('tab', { name: 'Backups & export' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Back up now and download' }).click()]);
  const p = await dl.path(); const { readFileSync } = await import('node:fs'); expect(readFileSync(p).subarray(0, 15).toString() === 'SQLite format 3', 'backup is not a SQLite file'); expect(/\.budgetreborn$/.test(dl.suggestedFilename()), 'backup file name');
  await page.getByRole('tab', { name: 'Security' }).click(); for (const t of ['Two-factor authentication (TOTP)', 'Passkeys', 'Sign out on all devices']) expect(await page.getByText(t).count(), `missing: ${t}`);
  await shot('13-settings-security');
});
await step('dark mode', async () => {
  await page.getByRole('tab', { name: 'Appearance & shortcuts' }).click(); await page.getByRole('button', { name: 'Dark' }).click(); await page.evaluate(() => { location.hash = '#/budget/2026-01'; }); await page.waitForTimeout(500);
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark class missing'); await shot('14-budget-dark');
  await page.evaluate(() => { location.hash = '#/accounts/all'; }); await page.waitForTimeout(500); await shot('15-register-dark');
  await page.evaluate(() => { localStorage.setItem('br-theme', 'light'); });
});
await step('passkey: register with a (virtual) authenticator, sign out, sign in with the passkey', async () => {
  const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.evaluate(() => { location.hash = '#/settings'; }); await page.getByRole('tab', { name: 'Security' }).click();
  await page.getByRole('button', { name: 'Add a passkey' }).click(); await page.getByText('Passkey added').waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.getByRole('tab', { name: 'Security' }).waitFor(); expect((await page.request.get(BASE + '/api/budgets')).status() === 200, 'not signed in after passkey login');
});
await step('sign out, wrong password is refused, sign in again', async () => {
  await page.evaluate(() => { location.hash = '#/settings'; }); await page.getByRole('tab', { name: 'Security' }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('Sign in to your budget').waitFor(); const r = await page.request.get(BASE + '/api/budgets'); expect(r.status() === 401, 'API reachable after sign-out');
  await page.getByLabel('Username').fill('owner'); await page.getByLabel('Password').fill('wrong-password-1'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByText('Wrong username or password.').waitFor(); await shot('16-login');
  await page.getByLabel('Password').fill('a-very-long-e2e-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('tab', { name: 'Security' }).waitFor(); await page.evaluate(() => { location.hash = '#/budget'; }); await page.locator('[data-testid=atb]').waitFor();
});
await step('native YNAB4 import shows the independent audit in the wizard and in Settings', async () => {
  const dir = join(dataDir, 'Native E2E~1A2B3C4D.ynab4'); mkdirSync(dir, { recursive: true }); const yfull = join(dir, 'Budget.yfull');
  execFileSync('npx', ['tsx', 'tests/e2e/make-yfull.ts', yfull], { stdio: 'pipe' });
  await page.evaluate(() => { location.hash = '#/ynab4-import'; }); await page.getByText('Drop your YNAB4 budget here').waitFor();
  await page.locator('input[type=file]').nth(1).setInputFiles(yfull); await page.getByText('YNAB4 full budget (Budget.yfull)').waitFor();
  await page.getByRole('button', { name: 'Continue to verification' }).click();
  const audit = page.locator('[data-testid=migration-audit]'); await audit.waitFor();
  const rows = async () => ({ pass: await audit.locator('tr[data-status=PASS]').count(), fail: await audit.locator('tr[data-status=FAIL]').count() });
  let r = await rows(); expect(r.pass >= 15 && r.fail === 0, `audit on verify step: ${JSON.stringify(r)}`);
  expect((await audit.innerText()).includes('PASS'), 'verdict PASS not shown'); await audit.screenshot({ path: `${shots}/23-ynab4-native-audit.png` });
  await page.getByRole('button', { name: /Import [\d,.]+ transactions/ }).click(); await page.getByText('Migration complete and verified').waitFor();
  r = await rows(); expect(r.pass >= 15 && r.fail === 0, `audit on done step: ${JSON.stringify(r)}`);
  await page.getByRole('button', { name: 'Open my budget' }).click(); await page.locator('[data-testid=atb]').waitFor();
  await page.evaluate(() => { location.hash = '#/settings'; }); await audit.waitFor();
  r = await rows(); expect(r.pass >= 15 && r.fail === 0, `audit in Settings: ${JSON.stringify(r)}`);
});
await step('phone layout: bottom navigation, account switching, budget sheet and fast transaction entry', async () => {
  const state = await ctx.storageState(); const m = await browser.newContext({ ...devices['iPhone 13'], storageState: state, locale: 'da-DK' }); page = await m.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/#/welcome'); await page.getByRole('button', { name: /E2E-budget/ }).click(); await page.locator('[data-testid=atb]').waitFor(); await page.evaluate(() => { location.hash = '#/budget/2026-11'; }); await page.waitForTimeout(500);
  expect(await page.locator('nav').getByText('Accounts').count(), 'bottom navigation missing'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page scrolls horizontally on a phone');
  await shot('17-mobile-budget'); await page.locator('tr[data-cat]', { hasText: 'Transport' }).click(); await page.getByRole('dialog').getByText('Quick budget').waitFor(); await shot('18-mobile-category-sheet');
  await page.getByRole('button', { name: 'Close' }).click(); await page.locator('nav').getByText('Accounts').click(); await page.getByText('Budget accounts').waitFor(); await shot('19-mobile-accounts');
  await page.getByLabel('Add transaction').click(); await page.getByRole('dialog').getByLabel('Outflow').fill('45'); await page.getByRole('dialog').getByLabel('Payee').fill('Kiosk'); await shot('20-mobile-add-transaction');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click(); await page.getByText('Kiosk').first().waitFor(); await shot('21-mobile-register');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'register scrolls horizontally on a phone');
  await page.locator('nav').getByText('Reports').click(); await page.getByText('Spending by category').first().waitFor(); await shot('22-mobile-reports'); await m.close();
});
await step('no JavaScript errors were logged in the browser', async () => { expect(errors.length === 0, errors.slice(0, 3).join(' | ')); });

await browser.close(); server.kill(); rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`); if (failures.length) { console.log(serverLog.split('\n').filter(l => /error/i.test(l)).slice(0, 5).join('\n')); process.exit(1); }
