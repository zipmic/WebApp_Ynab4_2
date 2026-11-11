import { Flag as FlagIcon, Plus, Split, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Button, Combobox, cx, Input, Menu, type Option } from '../components/ui';
import { ApiError, patch, post } from '../lib/api';
import { toast, toastError, useBudget } from '../lib/store';
import { FLAGS, type Cleared, type Flag, type Txn, type TxnChange } from '../../shared/types';

export const FLAG_COLORS: Record<Flag, string> = { red: '#e5484d', orange: '#f76b15', yellow: '#e2a200', green: '#30a46c', blue: '#3e63dd', purple: '#8e4ec6' };
interface Line { categoryId: string | null; transferAccountId: string | null; memo: string; outflow: string; inflow: string }

export function usePayeeOptions(excludeAccountId: string | null): Option[] {
  const b = useBudget();
  return useMemo(() => {
    const transfers = b.boot.accounts.filter(a => a.id !== excludeAccountId && !a.closed).map(a => ({ id: 't:' + a.id, label: `Transfer : ${a.name}`, group: 'Transfer to / from' }));
    const frequent = [...b.boot.payees].filter(p => p.uses >= 3).sort((x, y) => y.uses - x.uses).slice(0, 6);
    const fset = new Set(frequent.map(p => p.id));
    return [...frequent.map(p => ({ id: 'p:' + p.id, label: p.name, group: 'Frequent' })), ...transfers, ...b.boot.payees.filter(p => !fset.has(p.id)).map(p => ({ id: 'p:' + p.id, label: p.name, group: 'Payees' }))];
  }, [b.boot.accounts, b.boot.payees, excludeAccountId]);
}
export function useCategoryOptions(withHidden = false): Option[] {
  const b = useBudget();
  return useMemo(() => b.categoryOptions.filter(o => withHidden || !o.hidden).map(o => ({ id: o.id, label: o.label, group: o.group })), [b.categoryOptions, withHidden]);
}

/** Create/edit form for one transaction. `layout="row"` renders inside the register grid; "stack" is the touch form. */
export function TxnEditor({ txn, accountId, showAccount, layout, grid, onDone, onCancel }: { txn: Txn | null; accountId: string | null; showAccount: boolean; layout: 'row' | 'stack'; grid?: string;
  onDone: (c: TxnChange, again: boolean) => void; onCancel: () => void }) {
  const b = useBudget();
  const [acct, setAcct] = useState<string | null>(txn?.accountId ?? accountId ?? b.boot.accounts.find(a => !a.closed)?.id ?? null);
  const [date, setDate] = useState(txn?.date ?? (sessionStorage.getItem('br-last-date') || b.boot.today));
  const [payeeId, setPayeeId] = useState<string | null>(txn?.payeeId ?? null), [payeeText, setPayeeText] = useState(txn && !txn.transferAccountId ? txn.payeeName : '');
  const [transferTo, setTransferTo] = useState<string | null>(txn?.transferAccountId ?? null);
  const [categoryId, setCategoryId] = useState<string | null>(txn?.categoryId ?? null), [memo, setMemo] = useState(txn?.memo ?? '');
  const [outflow, setOutflow] = useState(txn && txn.amount < 0 ? b.fmt(-txn.amount) : ''), [inflow, setInflow] = useState(txn && txn.amount > 0 ? b.fmt(txn.amount) : '');
  const [cleared, setCleared] = useState<Cleared>(txn?.cleared ?? 'uncleared'), [flag, setFlag] = useState<Flag | null>(txn?.flag ?? null);
  const [lines, setLines] = useState<Line[] | null>(txn?.splits.length ? txn.splits.map(s => ({ categoryId: s.categoryId, transferAccountId: s.transferAccountId, memo: s.memo, outflow: s.amount < 0 ? b.fmt(-s.amount) : '', inflow: s.amount > 0 ? b.fmt(s.amount) : '' })) : null);
  const [busy, setBusy] = useState(false); const firstRef = useRef<HTMLInputElement>(null);
  const account = acct ? b.accountById.get(acct) : undefined; const target = transferTo ? b.accountById.get(transferTo) : undefined;
  const payeeOptions = usePayeeOptions(acct); const catOptions = useCategoryOptions(!!txn);
  const splitCatOptions = useMemo(() => [...catOptions, ...b.boot.accounts.filter(a => a.id !== acct && !a.closed).map(a => ({ id: 't:' + a.id, label: `Transfer : ${a.name}`, group: 'Transfer' }))], [catOptions, b.boot.accounts, acct]);
  const far = !!txn?.splitTransferParent;
  const noCategory = !account?.onBudget ? 'Off-budget account' : target?.onBudget ? 'Transfer — no category' : null;
  const num = (o: string, i: string): number | null => { const po = o.trim() ? b.parse(o) : 0, pi = i.trim() ? b.parse(i) : 0; return po === null || pi === null ? null : pi - Math.abs(po); };
  const amount = num(outflow, inflow);
  const lineAmounts = lines?.map(l => num(l.outflow, l.inflow)) ?? [];
  const remaining = lines && amount !== null && lineAmounts.every(x => x !== null) ? amount - (lineAmounts as number[]).reduce((s, x) => s + x, 0) : null;
  const valid = !!acct && /^\d{4}-\d{2}-\d{2}$/.test(date) && amount !== null && (!lines || remaining === 0);

  const pickPayee = (o: Option | null) => {
    if (!o) { setPayeeId(null); setPayeeText(''); setTransferTo(null); return; }
    if (o.id.startsWith('t:')) { setTransferTo(o.id.slice(2)); setPayeeId(null); setPayeeText(''); return; }
    const p = b.payeeById.get(o.id.slice(2)); setTransferTo(null); setPayeeId(o.id.slice(2)); setPayeeText(o.label);
    if (p?.autoCategoryId && !categoryId && !lines && !txn) setCategoryId(p.autoCategoryId); // remember the payee's last category
  };
  const save = async (again: boolean, allowReconciledEdit = false) => {
    if (!valid || busy) { if (lines && remaining !== 0) toast('Split lines must add up to the transaction total', 'error'); else if (amount === null) toast('Not a valid amount', 'error'); return; }
    setBusy(true);
    const body: any = far ? { memo, cleared, flag } : { accountId: acct, date, amount, memo, cleared, flag, transferAccountId: transferTo,
      ...(transferTo ? {} : payeeId ? { payeeId } : { payeeName: payeeText.trim() }), categoryId: lines ? null : categoryId,
      splits: lines ? lines.map((l, i) => ({ amount: lineAmounts[i], categoryId: l.categoryId, memo: l.memo, transferAccountId: l.transferAccountId })) : [] };
    if (!txn && !lines) delete body.splits;
    try {
      const c = txn ? await patch<TxnChange>(b.url(`/transactions/${txn.id}`), { ...body, allowReconciledEdit }) : await post<TxnChange>(b.url('/transactions'), body);
      sessionStorage.setItem('br-last-date', date); onDone(c, again);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RECONCILED') { if (window.confirm('This transaction is reconciled. Changing it alters a balance you already confirmed against your bank. Change it anyway?')) { setBusy(false); return save(again, true); } }
      else toastError(e);
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); save(e.ctrlKey || e.metaKey || !txn); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
  const setLine = (i: number, p: Partial<Line>) => setLines(ls => ls!.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const startSplit = () => { setLines([{ categoryId, transferAccountId: null, memo: '', outflow, inflow }, { categoryId: null, transferAccountId: null, memo: '', outflow: '', inflow: '' }]); setCategoryId(null); };

  const fDate = <Input type="date" aria-label="Date" value={date} onChange={e => setDate(e.target.value)} disabled={far} className="h-8 px-1.5" ref={layout === 'stack' ? undefined : firstRef} autoFocus={layout === 'row' && !txn} />;
  const fAccount = <Combobox aria-label="Account" value={acct} disabled={far} options={b.boot.accounts.filter(a => !a.closed || a.id === acct).map(a => ({ id: a.id, label: a.name, group: a.onBudget ? 'Budget' : 'Tracking' }))} onPick={o => { if (o) { setAcct(o.id); if (transferTo === o.id) setTransferTo(null); } }} />;
  const fPayee = <Combobox aria-label="Payee" disabled={far} value={transferTo ? 't:' + transferTo : payeeId ? 'p:' + payeeId : null} text={transferTo ? undefined : payeeText} options={payeeOptions} allowCreate placeholder="Payee"
    onPick={pickPayee} onText={t => { setPayeeText(t); setPayeeId(null); setTransferTo(null); }} autoFocus={layout === 'row' && !!txn} />;
  const fCategory = lines ? <div className="flex h-8 items-center gap-1 rounded-md border border-dashed border-line-strong px-2 text-ink-2"><Split size={13} />Split<button className="ml-auto text-[12px] text-accent" onClick={() => { setCategoryId(lines[0]?.categoryId ?? null); setLines(null); }}>remove</button></div>
    : <div className="flex gap-1"><div className="min-w-0 flex-1"><Combobox aria-label="Category" value={noCategory ? null : categoryId} disabled={!!noCategory} placeholder={noCategory ?? 'Category'} options={catOptions} onPick={o => setCategoryId(o?.id ?? null)} /></div>
      {!noCategory && !far && <Button size="icon" variant="ghost" title="Split into several categories" aria-label="Split transaction" onClick={startSplit}><Split size={14} /></Button>}</div>;
  const fMemo = <Input aria-label="Memo" value={memo} onChange={e => setMemo(e.target.value)} placeholder="Memo" className="h-8 px-2" />;
  const fOut = <Input aria-label="Outflow" value={outflow} disabled={far} onChange={e => { setOutflow(e.target.value); if (e.target.value) setInflow(''); }} placeholder="Outflow" inputMode="decimal" className="num h-8 px-2 text-right" />;
  const fIn = <Input aria-label="Inflow" value={inflow} disabled={far} onChange={e => { setInflow(e.target.value); if (e.target.value) setOutflow(''); }} placeholder="Inflow" inputMode="decimal" className="num h-8 px-2 text-right" />;
  const fFlag = <Menu align="start" trigger={p => <button ref={p.ref as any} onClick={p.onClick} aria-label="Flag" title="Flag" className="flex h-8 w-6 items-center justify-center"><FlagIcon size={14} fill={flag ? FLAG_COLORS[flag] : 'none'} color={flag ? FLAG_COLORS[flag] : 'var(--ink-3)'} /></button>}
    items={[...FLAGS.map(f => ({ label: f[0].toUpperCase() + f.slice(1), icon: <FlagIcon size={13} fill={FLAG_COLORS[f]} color={FLAG_COLORS[f]} />, onClick: () => setFlag(f) })), 'sep', { label: 'No flag', onClick: () => setFlag(null) }]} />;
  const fCleared = <button aria-label={`Status: ${cleared}`} title={cleared === 'reconciled' ? 'Reconciled' : 'Toggle cleared'} disabled={cleared === 'reconciled'} onClick={() => setCleared(c => (c === 'cleared' ? 'uncleared' : 'cleared'))}><ClearedMark state={cleared} /></button>;
  const splitRows = lines && <div className={cx(layout === 'row' ? 'col-span-full mt-1 space-y-1 border-t border-line pt-2' : 'space-y-2')}>
    {lines.map((l, i) => <div key={i} className={cx('grid items-center gap-1.5', layout === 'row' ? 'grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_104px_104px_28px] pl-[30%]' : 'grid-cols-[1fr_1fr_28px] rounded-xl border border-line p-2')}>
      <Combobox aria-label={`Split ${i + 1} category`} value={l.transferAccountId ? 't:' + l.transferAccountId : l.categoryId} placeholder="Category or transfer" options={account?.onBudget ? splitCatOptions : splitCatOptions.filter(o => o.id.startsWith('t:'))}
        onPick={o => setLine(i, o?.id.startsWith('t:') ? { transferAccountId: o.id.slice(2), categoryId: null } : { categoryId: o?.id ?? null, transferAccountId: null })} />
      <Input aria-label={`Split ${i + 1} memo`} value={l.memo} onChange={e => setLine(i, { memo: e.target.value })} placeholder="Memo" className={cx('h-8 px-2', layout === 'stack' && 'col-span-1')} />
      {layout === 'stack' && <span />}
      <Input aria-label={`Split ${i + 1} outflow`} value={l.outflow} onChange={e => setLine(i, { outflow: e.target.value, inflow: e.target.value ? '' : l.inflow })} placeholder="Outflow" inputMode="decimal" className="num h-8 px-2 text-right" />
      <Input aria-label={`Split ${i + 1} inflow`} value={l.inflow} onChange={e => setLine(i, { inflow: e.target.value, outflow: e.target.value ? '' : l.outflow })} placeholder="Inflow" inputMode="decimal" className="num h-8 px-2 text-right" />
      <Button size="icon" variant="ghost" aria-label={`Remove split ${i + 1}`} onClick={() => setLines(ls => (ls!.length > 1 ? ls!.filter((_, j) => j !== i) : ls))}><X size={14} /></Button></div>)}
    <div className={cx('flex items-center gap-3 text-[12.5px]', layout === 'row' && 'pl-[30%]')}><Button size="sm" variant="ghost" onClick={() => setLines(ls => [...ls!, { categoryId: null, transferAccountId: null, memo: '', outflow: remaining && remaining < 0 ? b.fmt(-remaining) : '', inflow: remaining && remaining > 0 ? b.fmt(remaining) : '' }])}><Plus size={14} />Add line</Button>
      <span className={cx('num', remaining === 0 ? 'text-pos' : 'text-neg')}>{remaining === null ? 'Enter valid amounts' : remaining === 0 ? 'Fully assigned' : `Remaining to assign: ${b.fmt(remaining)}`}</span></div></div>;
  const actions = <div className={cx('flex items-center gap-2', layout === 'row' ? 'col-span-full justify-end pt-1.5' : 'pt-2')}>
    {far && <span className="mr-auto text-[12px] text-ink-3">Part of a split transfer — amount and date are edited in {b.accountById.get(txn!.transferAccountId!)?.name}.</span>}
    <Button size={layout === 'row' ? 'sm' : 'lg'} onClick={onCancel} className={cx(layout === 'stack' && 'flex-1')}>Cancel</Button>
    {!txn && layout === 'row' && <Button size="sm" disabled={!valid || busy} onClick={() => save(true)} title="Enter">Save and add another</Button>}
    <Button size={layout === 'row' ? 'sm' : 'lg'} variant="primary" disabled={!valid || busy} onClick={() => save(false)} className={cx(layout === 'stack' && 'flex-1')}>{txn ? 'Save' : 'Save'}</Button></div>;

  if (layout === 'row') return <div onKeyDown={onKey} className="grid items-center gap-x-1.5 gap-y-1 border-y border-accent bg-accent-soft/60 px-2 py-2" style={{ gridTemplateColumns: grid }} data-testid="txn-editor">
    <span />{fFlag}{fDate}{showAccount && fAccount}{fPayee}{fCategory}{fMemo}{fOut}{fIn}<span className="flex justify-center">{fCleared}</span><span />
    {splitRows}{actions}</div>;
  const L = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="block"><span className="mb-1 block text-[12px] font-medium text-ink-2">{label}</span>{children}</label>;
  return <div onKeyDown={e => { if (e.key === 'Escape') onCancel(); }} className="space-y-3 [&_input]:h-11 [&_input]:text-[16px]" data-testid="txn-editor">
    <div className="grid grid-cols-2 gap-2"><L label="Outflow">{fOut}</L><L label="Inflow">{fIn}</L></div>
    <L label="Payee">{fPayee}</L><L label="Category">{fCategory}</L>{splitRows}
    <div className="grid grid-cols-2 gap-2"><L label="Date">{fDate}</L><L label="Account">{fAccount}</L></div>
    <L label="Memo">{fMemo}</L>
    <div className="flex items-center gap-4"><label className="flex items-center gap-2">{fCleared}<span>{cleared === 'uncleared' ? 'Not cleared' : cleared === 'cleared' ? 'Cleared' : 'Reconciled'}</span></label><span className="flex items-center">{fFlag}<span className="text-ink-2">Flag</span></span></div>
    {actions}</div>;
}
export function ClearedMark({ state }: { state: Cleared }) {
  return <span className={cx('flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold', state === 'uncleared' && 'border border-line-strong text-ink-3', state === 'cleared' && 'bg-pos text-white', state === 'reconciled' && 'bg-ink-2 text-bg')}>{state === 'reconciled' ? 'R' : 'C'}</span>;
}
