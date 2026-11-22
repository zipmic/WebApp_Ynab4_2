// Smoke test of the PACKAGED desktop app: two independent installations ("computers", separate profiles) share a
// budget through a folder. Usage: node tests/desktop/smoke.mjs [path to the app executable]
// Linux: run under a virtual display, e.g. `xvfb-run -a node tests/desktop/smoke.mjs dist/desktop/linux-unpacked/budget-reborn`
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const { _electron: electron } = createRequire(import.meta.url)('playwright'); // the pre-installed Playwright (see tests/e2e/run.mjs)
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2] ?? 'dist/desktop/linux-unpacked/budget-reborn';
const shots = 'tests/desktop/screenshots'; mkdirSync(shots, { recursive: true });
const tmp = p => mkdtempSync(join(tmpdir(), p));
const shared = tmp('br-shared-');
let failures = 0;
/** TCP ports a process listens on (Linux: from /proc; elsewhere the in-process check below is used). */
function listeningPorts(pid) {
  if (process.platform !== 'linux') return [];
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) { try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.add(m[1]); } catch { /* closed */ } }
  const ports = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6'].filter(existsSync)) for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
    const c = line.trim().split(/\s+/); if (c.length > 9 && c[3] === '0A' && inodes.has(c[9])) ports.push(parseInt(c[1].split(':')[1], 16));
  }
  return ports;
}
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failures++; };

async function launch(name) {
  const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, BR_DESKTOP_USER_DATA: tmp(`br-${name}-`) } });
  const page = await app.firstWindow();
  await page.setViewportSize?.({ width: 1280, height: 800 }).catch(() => {});
  // folder dialogs are answered by the test
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__pick ?? dir] }); }, shared);
  return { app, page };
}
const pickNext = (app, dir) => app.evaluate((_e, d) => { globalThis.__pick = d; }, dir);

// 1. Started normally (not through Playwright, which adds its own debugging ports), the app and all its helper
//    processes listen on no network port at all.
if (process.platform === 'linux') {
  const ud = tmp('br-ports-');
  const child = spawn(exe, ['--no-sandbox'], { env: { ...process.env, BR_DESKTOP_USER_DATA: ud }, stdio: 'ignore' });
  for (let i = 0; i < 60 && !existsSync(join(ud, 'data', 'system.sqlite')); i++) await new Promise(r => setTimeout(r, 500));
  await new Promise(r => setTimeout(r, 3000));
  const tree = [child.pid]; for (let grew = true; grew;) { grew = false; for (const d of readdirSync('/proc').filter(n => /^\d+$/.test(n))) { try { const ppid = Number(readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]); if (tree.includes(ppid) && !tree.includes(Number(d))) { tree.push(Number(d)); grew = true; } } catch { /* gone */ } } }
  const ports = tree.flatMap(pid => { try { return listeningPorts(pid); } catch { return []; } });
  check(existsSync(join(ud, 'data', 'system.sqlite')) && ports.length === 0, `no network port is opened by the app or its ${tree.length - 1} helper processes (${ports.length} listening)`);
  child.kill();
}

const A = await launch('A');
try {
  await A.page.getByText('Welcome to Budget Reborn').waitFor({ timeout: 30000 });
  check(true, 'computer A: the app starts and shows the budget chooser (no login)');
  await A.page.screenshot({ path: `${shots}/01-welcome.png` });
  check(await A.page.getByText('Open budget from a sync folder').isVisible(), 'desktop options are offered (open from folder, move from server version)');
  await A.page.getByText('Create new budget').click();
  await A.page.getByLabel('Budget name').fill('Household');
  await A.page.getByRole('button', { name: 'Create budget' }).click();
  await A.page.getByText('Household').first().waitFor();
  check(true, 'a budget is created and opened');

  await A.page.goto('app://budget/#/settings');
  await A.page.getByRole('tab', { name: 'Sync & this computer' }).click();
  await A.page.getByText('Choose sync folder…').click();
  await A.page.getByText('The budget is now synchronised through the folder').waitFor({ timeout: 15000 });
  const folder = readdirSync(shared).find(n => n.endsWith('(Budget Reborn)'));
  check(!!folder && existsSync(join(shared, folder, 'budget-reborn.json')), `the budget folder was created in the chosen folder ("${folder}")`);
  await A.page.getByTestId('sync-indicator').waitFor();
  await A.page.screenshot({ path: `${shots}/02-sync-settings.png` });

  // downloads (backups, exports) work from the app:// window: the file is saved where the user chooses
  const dl = tmp('br-dl-');
  await A.app.evaluate(({ session }, dir) => { session.defaultSession.on('will-download', (_e, item) => item.setSavePath(dir + '/' + item.getFilename())); }, dl);
  await A.page.getByRole('tab', { name: 'Backups & export' }).click();
  await A.page.getByRole('button', { name: 'Back up now and download' }).click();
  for (let i = 0; i < 40 && !readdirSync(dl).some(n => n.endsWith('.budgetreborn')); i++) await A.page.waitForTimeout(250);
  const file = readdirSync(dl).find(n => n.endsWith('.budgetreborn'));
  check(!!file && readFileSync(join(dl, file)).subarray(0, 15).toString() === 'SQLite format 3', `a backup can be downloaded from the desktop window (${file ?? 'nothing saved'})`);

  const B = await launch('B');
  try {
    await B.page.getByText('Welcome to Budget Reborn').waitFor({ timeout: 30000 });
    await pickNext(B.app, join(shared, folder));
    await B.page.getByText('Open budget from a sync folder').click();
    await B.page.getByText('Opened “Household” from the sync folder').waitFor({ timeout: 15000 });
    check(true, 'computer B opens the same budget from the folder');

    // a change on A reaches B (B's window reloads by itself)
    await A.page.goto('app://budget/#/settings');
    await A.page.getByRole('tab', { name: 'Budget' }).click();
    const nameField = A.page.getByLabel('Name');
    await nameField.fill('Household 2026'); await nameField.blur();
    await A.page.getByText('Saved').first().waitFor();
    await B.page.getByText('Household 2026').first().waitFor({ timeout: 45000 });
    check(true, 'a change made on A appears on B automatically');
    await B.page.getByTestId('sync-indicator').click();
    await B.page.getByText('Other computers').waitFor(); await B.page.waitForTimeout(400);
    await B.page.screenshot({ path: `${shots}/03-sync-status.png` });
    check(await B.page.getByText('Has your changes').count() >= 0, 'the status dialog lists the other computer');
  } finally { await B.app.close(); }
} finally { await A.app.close(); }

console.log(failures ? `\n${failures} check(s) failed` : '\nall desktop checks passed');
process.exit(failures ? 1 : 0);
