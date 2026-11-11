import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ChevronRight, FileUp, FolderOpen, Plus } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { BudgetInfo } from '../App';
import { Button, Dialog, Field, Input } from '../components/ui';
import { api, post } from '../lib/api';
import { go, toast, toastError } from '../lib/store';
import { Logo } from './Auth';

export function Welcome({ budgets, onOpen, canClose }: { budgets: BudgetInfo[]; onOpen: (id: string) => void; canClose: boolean }) {
  const qc = useQueryClient(); const [creating, setCreating] = useState(false), [name, setName] = useState('My Budget'), [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const create = async () => { setBusy(true); try { const r = await post('/budgets', { name }); await qc.invalidateQueries({ queryKey: ['budgets'] }); onOpen(r.id); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const restore = async (f: File | undefined) => {
    if (!f) return; setBusy(true);
    try { const r = await api<{ id: string; name: string }>('POST', '/restore', undefined, { raw: f, headers: { 'content-type': 'application/octet-stream' } }); await qc.invalidateQueries({ queryKey: ['budgets'] }); toast(`Restored “${r.name}”`, 'success'); onOpen(r.id); }
    catch (e) { toastError(e); } finally { setBusy(false); if (file.current) file.current.value = ''; }
  };
  const Card = ({ icon, title, text, onClick, primary }: { icon: ReactNode; title: string; text: string; onClick: () => void; primary?: boolean }) => (
    <button onClick={onClick} disabled={busy} className={`group flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition-colors ${primary ? 'border-accent bg-accent-soft hover:brightness-[.98]' : 'border-line bg-surface hover:border-line-strong hover:bg-sunken'}`}>
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${primary ? 'bg-accent text-accent-ink' : 'bg-sunken text-ink-2'}`}>{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{title}</span><span className="block text-[13px] text-ink-2">{text}</span></span>
      <ChevronRight size={18} className="text-ink-3 transition-transform group-hover:translate-x-0.5" /></button>);
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="anim-in w-full max-w-xl">
        <div className="mb-7 flex items-center gap-3.5"><Logo size={48} /><div><h1 className="text-2xl font-semibold tracking-tight">Welcome to Budget Reborn</h1><p className="text-ink-2">Give every krone a job — the YNAB4 way, on your own server.</p></div></div>
        <div className="space-y-3">
          <Card primary icon={<FileUp size={20} />} title="Import YNAB4 budget" text="Bring your accounts, transactions, categories and budget history with you." onClick={() => go('ynab4-import')} />
          <Card icon={<Plus size={20} />} title="Create new budget" text="Start fresh with empty accounts and categories." onClick={() => setCreating(true)} />
          <Card icon={<ArchiveRestore size={20} />} title="Restore backup" text="Open a .budgetreborn backup file. Existing budgets are never overwritten." onClick={() => file.current?.click()} />
        </div>
        <input ref={file} type="file" hidden accept=".budgetreborn,.sqlite,application/octet-stream" onChange={e => restore(e.target.files?.[0])} />
        {budgets.length > 0 && <div className="mt-8"><div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Your budgets</div>
          <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{budgets.map(b => (
            <button key={b.id} onClick={() => onOpen(b.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken"><FolderOpen size={17} className="text-ink-3" /><span className="flex-1 truncate font-medium">{b.name}</span>
              <span className="text-[12px] text-ink-3">{b.lastOpened ? 'opened ' + b.lastOpened.slice(0, 10) : 'new'}</span></button>))}</div></div>}
        {canClose && <div className="mt-5 text-center"><Button variant="ghost" onClick={() => go('budget')}>Back to budget</Button></div>}
      </div>
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create new budget" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={create}>Create budget</Button></>}>
        <Field label="Budget name"><Input value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter' && name.trim()) create(); }} /></Field>
        <p className="mt-3 text-[13px] text-ink-2">Currency and number format (default: Danish kroner, 1.234,56) can be changed in Settings.</p>
      </Dialog>
    </div>);
}
