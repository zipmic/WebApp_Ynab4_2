/**
 * Budget Reborn desktop app (Electron main process).
 *
 * The existing application (Fastify routes, budget engine, SQLite) runs inside this process. There is NO network
 * listener: the window loads app://budget/ and every request is handed to the application in memory
 * (`fastify.inject`). Nothing else on the computer or the network can reach it, so there is no login.
 *
 * Data lives in the user's own app-data folder (%APPDATA%\BudgetReborn on Windows,
 * ~/Library/Application Support/BudgetReborn on macOS), separate from the program, so updating or uninstalling the
 * program never touches it. Budgets can be synchronised through a folder chosen by the user (see src/server/sync).
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp, type App } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://budget`;
const BUDGET_ID_RE = /^[0-9a-f]{24}$/;

// must happen before the app is ready: app:// behaves like https (secure context, fetch, streaming, storage)
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);
app.setName('Budget Reborn');
app.setPath('userData', join(app.getPath('appData'), 'BudgetReborn'));
if (process.env.BR_DESKTOP_USER_DATA) app.setPath('userData', process.env.BR_DESKTOP_USER_DATA); // tests only: an isolated profile

let server: App | null = null;
let win: BrowserWindow | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// ------------------------------------------------------------------ window size and position, remembered per computer
interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }
const stateFile = () => join(app.getPath('userData'), 'window.json');
function loadWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    if (typeof s.width !== 'number' || typeof s.height !== 'number') throw new Error('invalid');
    // only reuse a position that is still on a connected screen
    const visible = s.x !== undefined && s.y !== undefined && screen.getAllDisplays().some(d => {
      const a = d.workArea; return s.x! >= a.x - 50 && s.y! >= a.y - 50 && s.x! < a.x + a.width - 100 && s.y! < a.y + a.height - 100;
    });
    return { width: Math.max(420, Math.min(s.width, 4000)), height: Math.max(500, Math.min(s.height, 3000)), maximized: !!s.maximized, ...(visible ? { x: s.x, y: s.y } : {}) };
  } catch { return { width: 1280, height: 820, maximized: false }; }
}
function saveWindowState(w: BrowserWindow) {
  try { const b = w.getNormalBounds(); writeFileSync(stateFile(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() })); } catch { /* not important */ }
}

function createWindow() {
  const st = loadWindowState();
  win = new BrowserWindow({
    ...(st.x !== undefined ? { x: st.x, y: st.y } : {}), width: st.width, height: st.height, minWidth: 420, minHeight: 500, show: false,
    title: 'Budget Reborn', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f172a' : '#f8fafc',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true, devTools: !app.isPackaged || !!process.env.BR_DESKTOP_DEVTOOLS },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win?.show());
  let t: NodeJS.Timeout | null = null;
  const later = () => { if (t) clearTimeout(t); t = setTimeout(() => win && saveWindowState(win), 400); };
  win.on('resize', later); win.on('move', later); win.on('close', () => win && saveWindowState(win));
  win.on('closed', () => { win = null; });
  // the window only ever shows the app itself; web links open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN + '/')) e.preventDefault(); });
  void win.loadURL(ORIGIN + '/');
}

// ------------------------------------------------------------------ app://budget → the application, in memory
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== 'budget' || !server) return new Response('Not found', { status: 404 });
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { if (k !== 'accept-encoding' && k !== 'content-length') headers[k] = v; }); // no compression needed in memory
  headers.host = 'budget';
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
  const res = await server.inject({ method: request.method as 'GET', url: url.pathname + url.search, headers, ...(body ? { payload: body } : {}) });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
    for (const x of Array.isArray(v) ? v : [v]) out.append(k, String(x));
  }
  const empty = request.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
  return new Response(empty ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}

// ------------------------------------------------------------------ the few things the page may ask the main process
const fromApp = (e: Electron.IpcMainInvokeEvent) => !!e.senderFrame?.url.startsWith(ORIGIN + '/');
const PICK_TITLES: Record<string, string> = {
  'sync-parent': 'Choose the folder to keep this budget in (for example in Dropbox, OneDrive, iCloud Drive or on a network drive)',
  'open-budget': 'Choose the budget folder ("… (Budget Reborn)")',
  move: 'Choose the new sync folder (an empty folder, or the folder that already contains this budget)',
  'server-data': 'Choose the Budget Reborn server data folder (it contains "system.sqlite" and "budgets")',
};
ipcMain.handle('br:pick-folder', async (e, purpose: unknown) => {
  if (!fromApp(e) || typeof purpose !== 'string' || !PICK_TITLES[purpose] || !server) return null;
  const opts: Electron.OpenDialogOptions = { title: PICK_TITLES[purpose], message: PICK_TITLES[purpose], properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { token: server.core.grantFolder(p), path: p };
});
ipcMain.handle('br:show-folder', async (e, kind: unknown, budgetId: unknown) => {
  if (!fromApp(e) || !server) return;
  if (kind === 'data') { await shell.openPath(server.core.cfg.dataDir); return; }
  if (kind === 'sync' && typeof budgetId === 'string' && BUDGET_ID_RE.test(budgetId)) {
    const f = server.core.listBudgets().find(b => b.id === budgetId)?.syncFolder;
    if (f && existsSync(f)) await shell.openPath(f);
  }
});

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [mac ? { role: 'close' as const } : { role: 'quit' as const }] },
    // no undo/redo items: Ctrl/Cmd+Z and Ctrl+Y are the budget's own undo/redo (handled by the page)
    { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : [])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // the web files ship next to this file (unpacked from the archive so they can be served as ordinary files)
  const webDir = [join(__dirname, 'web').replace('app.asar', 'app.asar.unpacked'), join(__dirname, 'web')].find(p => existsSync(join(p, 'index.html'))) ?? join(__dirname, 'web');
  const cfg = loadConfig({ BR_DATA_DIR: dataDir, BR_WEB_DIR: webDir, BR_DESKTOP: '1', NODE_ENV: 'production' });
  try { server = await buildApp(cfg); await server.ready(); }
  catch (e) {
    dialog.showErrorBox('Budget Reborn could not start', `${(e as Error).message}\n\nYour data has not been changed. Data folder:\n${dataDir}`);
    app.exit(1); return;
  }
  // no permissions for the page (camera, microphone, location, notifications …); reading what is typed is all it needs
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  // downloads (backups, exports) ask where to save, starting in the Downloads folder
  session.defaultSession.on('will-download', (_e, item) => { item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) }); });
  protocol.handle(SCHEME, handle);
  buildMenu();
  createWindow();
  // daily housekeeping, as the server version did: due scheduled transactions and an automatic backup
  const housekeeping = () => { for (const b of server!.core.listBudgets()) { try { server!.core.service(b.id).postScheduled(); server!.core.backup(b.id, 'auto'); } catch { /* next time */ } } };
  setInterval(housekeeping, 6 * 3600_000).unref();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// before quitting, write this computer's last changes to the sync folders (briefly; they are safe locally anyway)
app.on('before-quit', e => {
  if (quitting || !server) return;
  e.preventDefault(); quitting = true;
  const s = server;
  const flush = Promise.all(s.core.listBudgets().filter(b => b.syncFolder).map(b => s.core.sync?.engine(b.id)?.cycle()));
  void Promise.race([flush, new Promise(r => setTimeout(r, 4000))]).finally(() => { void s.close().finally(() => app.exit(0)); });
});
