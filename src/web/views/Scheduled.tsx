import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Combobox, Dialog, Empty, Field, Input, Money, Select } from '../components/ui';
import { del, get, post } from '../lib/api';
import { toast, useBudget } from '../lib/store';
import { FREQUENCIES, type Scheduled, type TxnChange } from '../../shared/types';
import { useCategoryOptions, usePayeeOptions } from './TxnEditor';

export default function ScheduledView() {
  const b = useBudget(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['b', b.bid, 'aux', 'scheduled'], queryFn: () => get<Scheduled[]>(b.url('/scheduled')) });
  const [edit, setEdit] = useState<Scheduled | 'new' | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['b', b.bid, 'aux', 'scheduled'] });
  const list = q.data ?? [];
  const enter = async (s: Scheduled) => { const r = await b.mutate(() => post<TxnChange & { posted: number }>(b.url(`/scheduled/${s.id}/enter`))); if (r) { b.applyChange(r); reload(); toast(`Entered ${s.payeeName || 'transaction'} on ${b.date(s.nextDate)}`, 'info', { label: 'Undo', run: b.undo }); } };
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 md:px-6"><div><h1 className="text-[17px] font-semibold tracking-tight">Scheduled transactions</h1><p className="text-[12.5px] text-ink-2">Entered automatically into the register when their date arrives.</p></div>
      <Button variant="primary" size="sm" onClick={() => setEdit('new')}><Plus size={15} />Add</Button></header>
    {!list.length && !q.isLoading ? <Empty title="Nothing scheduled" action={<Button variant="primary" onClick={() => setEdit('new')}><CalendarClock size={16} />Schedule a transaction</Button>}>Rent, salary, subscriptions — anything that repeats.</Empty>
      : <div className="divide-y divide-line">{list.map(s => <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 md:px-6">
        <div className="num w-24 font-medium">{b.date(s.nextDate)}</div>
        <div className="min-w-0 flex-1"><div className="truncate font-medium">{s.payeeName || '(no payee)'} {s.nextDate <= b.boot.today && <Badge tone="warn">Due</Badge>}</div>
          <div className="truncate text-[12.5px] text-ink-3">{FREQUENCIES.find(f => f.value === s.frequency)?.label} · {b.accountById.get(s.accountId)?.name} · {s.splits.length ? `Split (${s.splits.length})` : b.categoryLabel(s.categoryId) || (s.transferAccountId ? 'Transfer' : 'No category')}{s.memo && ` · ${s.memo}`}</div></div>
        <Money value={s.amount} fmt={b.fmt} colored className="font-medium" />
        <div className="flex gap-1"><Button size="sm" onClick={() => enter(s)} title="Enter this occurrence into the register now"><Play size={13} />Enter now</Button><Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEdit(s)}><Pencil size={14} /></Button>
          <Button size="icon" variant="ghost" aria-label="Delete" className="text-neg" onClick={() => b.mutate(() => del(b.url(`/scheduled/${s.id}`))).then(reload)}><Trash2 size={14} /></Button></div></div>)}</div>}
    {edit && <ScheduleDialog item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
  </div>;
}
function ScheduleDialog({ item, onClose, onSaved }: { item: Scheduled | null; onClose: () => void; onSaved: () => void }) {
  const b = useBudget();
  const [accountId, setAccountId] = useState(item?.accountId ?? b.boot.accounts.find(a => a.onBudget && !a.closed)?.id ?? ''), [nextDate, setNextDate] = useState(item?.nextDate ?? b.boot.today), [frequency, setFrequency] = useState<string>(item?.frequency ?? 'monthly');
  const [payeeId, setPayeeId] = useState<string | null>(item?.payeeId ?? null), [payeeText, setPayeeText] = useState(item && !item.transferAccountId ? item.payeeName : ''), [transferTo, setTransferTo] = useState<string | null>(item?.transferAccountId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(item?.categoryId ?? null), [memo, setMemo] = useState(item?.memo ?? '');
  const [outflow, setOutflow] = useState(item && item.amount < 0 ? b.fmt(-item.amount) : ''), [inflow, setInflow] = useState(item && item.amount > 0 ? b.fmt(item.amount) : '');
  const payees = usePayeeOptions(accountId), cats = useCategoryOptions();
  const po = outflow.trim() ? b.parse(outflow) : 0, pi = inflow.trim() ? b.parse(inflow) : 0; const amount = po === null || pi === null ? null : pi - Math.abs(po);
  const account = b.accountById.get(accountId), target = transferTo ? b.accountById.get(transferTo) : null; const noCat = !account?.onBudget || !!target?.onBudget; const hasSplits = !!item?.splits.length;
  const save = async () => { const ok = await b.mutate(() => post(b.url('/scheduled'), { id: item?.id, accountId, nextDate, frequency, payeeId: transferTo ? null : payeeId, payeeName: transferTo || payeeId ? null : payeeText, categoryId: noCat || hasSplits ? null : categoryId, memo, amount, flag: item?.flag ?? null, transferAccountId: transferTo, splits: item?.splits ?? [] })); if (ok) onSaved(); };
  return <Dialog open onClose={onClose} title={item ? 'Edit scheduled transaction' : 'Schedule a transaction'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!accountId || amount === null || amount === 0} onClick={save}>Save</Button></>}>
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3"><Field label="Next date"><Input type="date" value={nextDate} onChange={e => setNextDate(e.target.value)} /></Field><Field label="Repeats"><Select className="w-full" value={frequency} onChange={setFrequency} options={FREQUENCIES.map(f => ({ value: f.value, label: f.label }))} /></Field></div>
      <Field label="Account"><Select className="w-full" value={accountId} onChange={setAccountId} options={b.boot.accounts.filter(a => !a.closed).map(a => ({ value: a.id, label: a.name }))} /></Field>
      <Field label="Payee"><Combobox className="h-9" value={transferTo ? 't:' + transferTo : payeeId ? 'p:' + payeeId : null} text={transferTo ? undefined : payeeText} options={payees} allowCreate placeholder="Payee or transfer"
        onText={t => { setPayeeText(t); setPayeeId(null); setTransferTo(null); }} onPick={o => { if (!o) { setPayeeId(null); setPayeeText(''); setTransferTo(null); } else if (o.id.startsWith('t:')) { setTransferTo(o.id.slice(2)); setPayeeId(null); } else { setTransferTo(null); setPayeeId(o.id.slice(2)); setPayeeText(o.label); } }} /></Field>
      <Field label="Category" hint={hasSplits ? 'This schedule is a split; its lines are kept as imported.' : undefined}><Combobox className="h-9" value={noCat || hasSplits ? null : categoryId} disabled={noCat || hasSplits} placeholder={hasSplits ? `Split (${item!.splits.length})` : noCat ? 'No category needed' : 'Category'} options={cats} onPick={o => setCategoryId(o?.id ?? null)} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Outflow"><Input className="num text-right" inputMode="decimal" value={outflow} disabled={hasSplits} onChange={e => { setOutflow(e.target.value); if (e.target.value) setInflow(''); }} /></Field><Field label="Inflow"><Input className="num text-right" inputMode="decimal" value={inflow} disabled={hasSplits} onChange={e => { setInflow(e.target.value); if (e.target.value) setOutflow(''); }} /></Field></div>
      <Field label="Memo"><Input value={memo} onChange={e => setMemo(e.target.value)} /></Field></div></Dialog>;
}
