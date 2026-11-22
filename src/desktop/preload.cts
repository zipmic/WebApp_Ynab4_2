/**
 * Preload script of the desktop window (sandboxed, context-isolated). The page gets exactly these functions and
 * nothing else from the computer: choosing a folder in the system dialog (the page receives only an opaque token)
 * and showing a known folder in Explorer/Finder.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('budgetDesktop', {
  pickFolder: (purpose: string) => ipcRenderer.invoke('br:pick-folder', purpose),
  showFolder: (kind: string, budgetId?: string) => ipcRenderer.invoke('br:show-folder', kind, budgetId),
  platform: process.platform,
});
