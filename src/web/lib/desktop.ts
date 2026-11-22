/**
 * Bridge to the desktop app's main process (exposed by src/desktop/preload.cts). Undefined in a browser.
 * Folders are chosen in the system's own dialog; the page only ever receives an opaque token for them.
 */
export interface DesktopBridge {
  pickFolder(purpose: 'sync-parent' | 'open-budget' | 'move' | 'server-data'): Promise<{ token: string; path: string } | null>;
  showFolder(kind: 'data' | 'sync', budgetId?: string): Promise<void>;
  platform: string;
}
export const desktop: DesktopBridge | undefined = (window as unknown as { budgetDesktop?: DesktopBridge }).budgetDesktop;
