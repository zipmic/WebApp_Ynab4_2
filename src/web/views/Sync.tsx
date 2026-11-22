/** Desktop app: sync status indicator, sync settings and the conflict screen. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CloudOff, FolderOpen, FolderSync, HardDrive, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Confirm, cx, Dialog, Empty } from '../components/ui';
import { get, getRevision, post } from '../lib/api';
import { desktop } from '../lib/desktop';
import { go, toast, toastError, useBudget } from '../lib/store';

export interface SyncStatus {
  state: 'local' | 'synced' | 'syncing' | 'pending' | 'unavailable' | 'waiting' | 'conflict' | 'error';
  message: string | null; folder: string | null; deviceId: string; lastCheckAt: string | null; lastSyncedAt: string | null;
  pendingOwn: number; waiting: number; conflicts: number; warnings: { code: string; message: string; file?: string }[];
  devices: { id: string; name: string; isThis: boolean; lastSeen: string | null; app: string; hasAllMine: boolean }[]; revision: number;
}
interface ConflictView {
  id: number; kind: string; createdAt: string; otherDevice: string; otherAction: string; message: string;
  items: { what: string; fields: { name: string; mine: string; theirs: string }[] }[]; alsoAffected: number;
}
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : 'never');
const LABEL: Record<SyncStatus['state'], string> = {
  local: 'Only on this computer', synced: 'Synced', syncing: 'Syncing…', pending: 'Changes waiting', unavailable: 'Sync folder unavailable',
  waiting: 'Waiting for files', conflict: 'Needs your decision', error: 'Sync stopped',
};
const TONE: Record<SyncStatus['state'], string> = {
  local: 'bg-slate-500', synced: 'bg-emerald-400', syncing: 'bg-sky-400', pending: 'bg-amber-400', unavailable: 'bg-amber-400', waiting: 'bg-amber-400', conflict: 'bg-red-400', error: 'bg-red-400',
};

/** Polls the sync status; reloads the screen when changes from another computer arrived. */
export function useSyncStatus() {
  const b = useBudget(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['b', b.bid, 'sync'], queryFn: () => get<SyncStatus>(b.url('/sync')), refetchInterval: 4000, enabled: !!desktop });
  const rev = q.data?.revision;
  useEffect(() => {
    if (rev === undefined) return;
    const known = getRevision(b.bid);
    if (known !== undefined && rev > known) qc.invalidateQueries({ queryKey: ['b', b.bid, 'bootstrap'] });
  }, [rev, b.bid, qc]);
  return q;
}

/** Small status line in the sidebar (only for budgets that are synchronised through a folder). */
export function SyncIndicator({ collapsed }: { collapsed: boolean }) {
  const q = useSyncStatus(); const [open, setOpen] = useState(false);
  const s = q.data; if (!s || s.state === 'local') return null;
  const icon = s.state === 'syncing' ? <Loader2 size={13} className="animate-spin" /> : <span className={cx('h-2 w-2 rounded-full', TONE[s.state])} />;
  return <>
    <button data-testid="sync-indicator" onClick={() => setOpen(true)} title={`${LABEL[s.state]} — last checked ${time(s.lastCheckAt)}`}
      className={cx('mx-2 mb-1 flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] text-slate-400 hover:bg-side-hover hover:text-white', collapsed && 'mx-auto justify-center px-0')}>
      {icon}{!collapsed && <span className="min-w-0 flex-1 truncate">{LABEL[s.state]}{s.state === 'synced' && s.lastSyncedAt ? ` · ${new Date(s.lastSyncedAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}` : ''}{s.state === 'conflict' ? ` (${s.conflicts})` : ''}</span>}
    </button>
    <Dialog open={open} onClose={() => setOpen(false)} title="Synchronisation"><SyncDetails status={s} onClose={() => setOpen(false)} /></Dialog>
  </>;
}

function SyncDetails({ status: s, onClose }: { status: SyncStatus; onClose?: () => void }) {
  const b = useBudget(); const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  const now = async () => { setBusy(true); try { const r = await post<SyncStatus>(b.url('/sync/now')); qc.setQueryData(['b', b.bid, 'sync'], r); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const others = s.devices.filter(d => !d.isThis);
  return <div className="space-y-4 text-[13.5px]">
    <div className="flex items-start gap-3">
      <span className={cx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', TONE[s.state])} />
      <div><div className="font-semibold">{LABEL[s.state]}</div>{s.message && <p className="text-ink-2">{s.message}</p>}
        <p className="mt-1 text-[12.5px] text-ink-3">Last checked {time(s.lastCheckAt)} · this computer was last fully up to date {time(s.lastSyncedAt)}</p></div>
    </div>
    {s.pendingOwn > 0 && <p className="rounded-lg bg-sunken px-3 py-2 text-ink-2">{s.pendingOwn} change{s.pendingOwn === 1 ? '' : 's'} saved on this computer, not yet written to the folder.</p>}
    {others.length > 0 && <div><div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Other computers</div>
      <ul className="divide-y divide-line rounded-xl border border-line">{others.map(d => <li key={d.id} className="flex items-center gap-3 px-3 py-2">
        <HardDrive size={15} className="text-ink-3" /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{d.name}</span><span className="block text-[12px] text-ink-3">last active {time(d.lastSeen)}{d.app ? ` · version ${d.app}` : ''}</span></span>
        {d.hasAllMine ? <Badge tone="pos">Has your changes</Badge> : <Badge tone="warn">Not yet received</Badge>}</li>)}</ul>
      <p className="mt-1 text-[12px] text-ink-3">"Has your changes" is shown only when that computer has confirmed it in the sync folder.</p></div>}
    {s.warnings.length > 0 && <ul className="space-y-1">{s.warnings.map((w, i) => <li key={i} className="flex gap-2 text-warn"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span>{w.message}{w.file && <span className="block text-[12px] text-ink-3">{w.file}</span>}</span></li>)}</ul>}
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" disabled={busy} onClick={now}><RefreshCw size={15} className={cx(busy && 'animate-spin')} />Sync now</Button>
      {s.conflicts > 0 && <Button onClick={() => { onClose?.(); go('conflicts'); }}><AlertTriangle size={15} />Resolve {s.conflicts} conflict{s.conflicts === 1 ? '' : 's'}</Button>}
      {onClose && <Button variant="ghost" onClick={() => { onClose(); go('settings'); }}>Sync settings</Button>}
    </div>
  </div>;
}

/** Settings → Sync: the folder, status, moving, stopping, and where the data lives on this computer. */
export function SyncSettings() {
  const b = useBudget(); const qc = useQueryClient(); const q = useSyncStatus(); const s = q.data;
  const info = useQuery({ queryKey: ['desktop-info'], queryFn: () => get<{ deviceName: string; dataDir: string; version: string }>('/desktop/info') });
  const [busy, setBusy] = useState(false); const [unlink, setUnlink] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['b', b.bid, 'sync'] }); qc.invalidateQueries({ queryKey: ['budgets'] }); };
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok, 'success'); refresh(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const pick = async (purpose: 'sync-parent' | 'move') => (desktop ? desktop.pickFolder(purpose) : null);
  if (!s) return null;
  return <>
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-[15px] font-semibold">Sync between computers</h2>
      {s.state === 'local' ? <>
        <p className="mt-0.5 text-[13px] text-ink-2">This budget is stored only on this computer. To use it on another computer too, choose a folder that your sync service keeps up to date (Dropbox, OneDrive, Google Drive, iCloud Drive, Syncthing, a network drive …). Budget Reborn creates a folder for the budget there; your working copy stays on this computer.</p>
        <Button className="mt-4" variant="primary" disabled={busy} onClick={async () => { const f = await pick('sync-parent'); if (f) await act(() => post(b.url('/sync/publish'), { folder: f.token }), 'The budget is now synchronised through the folder'); }}><FolderSync size={16} />Choose sync folder…</Button>
      </> : <>
        <div className="mt-3"><SyncDetails status={s} /></div>
        <div className="mt-4 rounded-xl bg-sunken px-3 py-2 text-[13px]"><div className="text-[12px] text-ink-3">Sync folder</div><div className="break-all font-medium">{s.folder}</div></div>
        <div className="mt-3 flex flex-wrap gap-2">
          {desktop && <Button onClick={() => desktop!.showFolder('sync', b.bid)}><FolderOpen size={15} />Show folder</Button>}
          <Button disabled={busy} onClick={async () => { const f = await pick('move'); if (f) await act(() => post(b.url('/sync/relink'), { folder: f.token }), 'The budget now uses the new folder'); }}><FolderSync size={15} />Change folder…</Button>
          <Button className="text-neg" disabled={busy} onClick={() => setUnlink(true)}><Unlink size={15} />Stop syncing</Button>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">Change folder: choose either the folder where this budget now is (for example after moving your Dropbox folder) or an empty folder — the budget is then copied there and the old folder is left as it is. Other computers must be pointed to the new folder as well.</p>
      </>}
    </section>
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-[15px] font-semibold">This computer</h2>
      <p className="mt-0.5 text-[13px] text-ink-2">Your budgets are stored in a private database on this computer{info.data ? ` (${info.data.deviceName})` : ''}. The sync folder only receives changes and copies — the database itself is never kept in a cloud folder.</p>
      {info.data && <div className="mt-3 rounded-xl bg-sunken px-3 py-2 text-[13px]"><div className="text-[12px] text-ink-3">Local data folder</div><div className="break-all font-medium">{info.data.dataDir}</div></div>}
      <div className="mt-3 flex flex-wrap gap-2">{desktop && <Button onClick={() => desktop!.showFolder('data')}><FolderOpen size={15} />Show data folder</Button>}{info.data && <span className="self-center text-[12.5px] text-ink-3">Budget Reborn {info.data.version}</span>}</div>
    </section>
    <Confirm open={unlink} title="Stop syncing this budget?" confirmLabel="Stop syncing" danger onClose={() => setUnlink(false)}
      onConfirm={() => act(() => post(b.url('/sync/unlink')), 'This budget is now only on this computer')}>
      The budget stays on this computer with all its data. The sync folder and the other computers are not changed; they simply no longer receive this computer's changes. You can choose a sync folder again later (that creates a new shared copy).
    </Confirm>
  </>;
}

/** The conflicts screen: one card per decision, both versions side by side. Nothing changes until the user decides. */
export function ConflictsView() {
  const b = useBudget(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['b', b.bid, 'conflicts'], queryFn: () => get<ConflictView[]>(b.url('/sync/conflicts')) });
  const [busy, setBusy] = useState<number | null>(null);
  const decide = async (id: number, choice: 'mine' | 'theirs') => {
    setBusy(id);
    try { await post(b.url(`/sync/conflicts/${id}`), { choice }); toast('Decision saved. It is sent to your other computers.', 'success'); }
    catch (e) { toastError(e); } finally { setBusy(null); q.refetch(); qc.invalidateQueries({ queryKey: ['b', b.bid] }); }
  };
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="border-b border-line bg-surface px-4 py-3 md:px-6"><h1 className="text-[17px] font-semibold tracking-tight">Sync conflicts</h1>
      <p className="text-[13px] text-ink-2">These things were changed differently on two computers while they could not see each other's changes. Both versions are kept until you choose. Your decision is applied on every computer.</p></header>
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-6">
      {q.data && !q.data.length && <Empty title="No conflicts" action={<Button onClick={() => go('budget')}>Back to budget</Button>}>Everything that arrived from your other computers could be combined automatically.</Empty>}
      {q.data?.map(c => <section key={c.id} data-testid="conflict" className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-start gap-2"><AlertTriangle size={17} className="mt-0.5 shrink-0 text-warn" /><div><div className="font-semibold">{c.message}</div>
          <div className="text-[12.5px] text-ink-3">On {c.otherDevice}: “{c.otherAction}” · noticed {time(c.createdAt)}</div></div></div>
        {c.items.map((it, i) => <div key={i} className="mt-3">
          <div className="text-[13.5px] font-medium">{it.what}</div>
          {it.fields.length > 0 && <table className="mt-1 w-full text-[13px]"><thead><tr className="text-left text-[12px] text-ink-3"><th className="py-1 pr-2 font-medium" /><th className="py-1 pr-2 font-medium">This computer</th><th className="py-1 font-medium">{c.otherDevice}</th></tr></thead>
            <tbody>{it.fields.map(f => <tr key={f.name} className="border-t border-line"><td className="py-1.5 pr-2 text-ink-2">{f.name}</td><td className="py-1.5 pr-2 font-medium">{f.mine}</td><td className="py-1.5 font-medium">{f.theirs}</td></tr>)}</tbody></table>}
        </div>)}
        {c.alsoAffected > 0 && <p className="mt-2 text-[12.5px] text-ink-3">{c.alsoAffected} related item{c.alsoAffected === 1 ? '' : 's'} changed together with this will follow your choice.</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy !== null} onClick={() => decide(c.id, 'mine')}><Check size={15} />Keep this computer's version</Button>
          <Button disabled={busy !== null} onClick={() => decide(c.id, 'theirs')}><Check size={15} />Use {c.otherDevice}'s version</Button>
        </div>
      </section>)}
    </div></div>;
}

/** Welcome screen additions in the desktop app. */
export function DesktopWelcomeCards({ Card, onOpen }: { Card: (p: { icon: ReactNode; title: string; text: string; onClick: () => void }) => ReactNode; onOpen: (id: string) => void }) {
  const qc = useQueryClient(); const busy = useRef(false);
  const [report, setReport] = useState<{ imported: { id: string; name: string; transactions: number }[]; failed: { name: string; reason: string }[] } | null>(null);
  if (!desktop) return null;
  const run = async (fn: () => Promise<void>) => { if (busy.current) return; busy.current = true; try { await fn(); } catch (e) { toastError(e); } finally { busy.current = false; } };
  return <>
    {Card({ icon: <FolderSync size={20} />, title: 'Open budget from a sync folder', text: 'Use a budget that another computer shares through Dropbox, OneDrive, iCloud Drive, a network drive …', onClick: () => run(async () => {
      const f = await desktop!.pickFolder('open-budget'); if (!f) return;
      const r = await post<{ id: string; name: string }>('/desktop/open-folder', { folder: f.token });
      await qc.invalidateQueries({ queryKey: ['budgets'] }); toast(`Opened “${r.name}” from the sync folder`, 'success'); onOpen(r.id);
    }) })}
    {Card({ icon: <CloudOff size={20} />, title: 'Move budgets from the server version', text: 'Copy the budgets from a Budget Reborn server data folder. The folder is only read.', onClick: () => run(async () => {
      const f = await desktop!.pickFolder('server-data'); if (!f) return;
      const r = await post<NonNullable<typeof report>>('/desktop/import-server-data', { folder: f.token });
      await qc.invalidateQueries({ queryKey: ['budgets'] }); setReport(r);
    }) })}
    <Dialog open={!!report} onClose={() => setReport(null)} title="Budgets copied from the server version" footer={<Button variant="primary" onClick={() => { const first = report?.imported[0]; setReport(null); if (first) onOpen(first.id); }}>Done</Button>}>
      <ul className="space-y-1 text-[13.5px]">{report?.imported.map(x => <li key={x.id} className="text-pos">✓ {x.name} — {x.transactions} transactions, verified</li>)}
        {report?.failed.map(x => <li key={x.name} className="text-neg">✗ {x.name}: {x.reason}</li>)}</ul>
      <p className="mt-3 text-[12.5px] text-ink-3">The server data folder was not changed. Each budget was checked (consistency and record counts) before it was added.</p>
    </Dialog>
  </>;
}
