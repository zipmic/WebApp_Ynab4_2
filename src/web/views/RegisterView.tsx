import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, CheckCheck, ChevronLeft, Copy, Download, Filter, Flag as FlagIcon, Pencil, Plus, ScanLine, Search, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Combobox, cx, Dialog, Empty, Field, Input, Menu, Money } from '../components/ui';
import { get, post } from '../lib/api';
import { download, go, toast, toastError, useBudget, useIsMobile, useRoute } from '../lib/store';
import type { Account, Cleared, Flag, Txn, TxnChange } from '../../shared/types';
import { ClearedMark, FLAG_COLORS, TxnEditor, useCategoryOptions } from './TxnEditor';

type SortKey = 'date' | 'payee' | 'category' | 'amount' | 'cleared' | 'account';
type FilterKey = 'all' | 'uncleared' | 'unreconciled' | 'uncategorized' | 'flagged';
const FILTERS: Record<FilterKey, string> = { all: 'All transactions', uncleared: 'Uncleared', unreconciled: 'Not reconciled', uncategorized: 'Needs a category', flagged: 'Flagged' };

export function RegisterView({ accountId, onEditAccount }: { accountId: string | null; onEditAccount: (a: Account) => void }) {
  const b = useBudget(); const mobile = useIsMobile(); const route = useRoute();
  const account = accountId ? b.accountById.get(accountId) ?? null : null;
  const scope = accountId ?? 'all';
  const q = useQuery({ queryKey: ['b', b.bid, 'tx', scope], queryFn: () => get<Txn[]>(b.url(`/transactions${accountId ? `?accountId=${accountId}` : ''}`)), staleTime: 60_000 });
  const all = q.data ?? [];
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<FilterKey>('all'), [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState<Set<string>>(new Set()), [editing, setEditing] = useState<string | null>(null), [reconcile, setReconcile] = useState(false), [bulkCat, setBulkCat] = useState(false);
  const anchor = useRef<string | null>(null); const parentRef = useRef<HTMLDivElement>(null); const searchRef = useRef<HTMLInputElement>(null);
  // deep links: #/accounts/:id/new and #/accounts/:id/t/:txn
  useEffect(() => { if (route[2] === 'new') { setEditing('new'); go(`accounts/${scope}`); } else if (route[2] === 't' && route[3]) { setEditing(route[3]); setFilter('all'); setSearch(''); go(`accounts/${scope}`); } }, [route, scope]);

  const balances = useMemo(() => { const m = new Map<string, number>(); if (!accountId) return m; let run = 0; for (const t of all) { run += t.amount; m.set(t.id, run); } return m; }, [all, accountId]);
  const onBudgetAcc = useCallback((id: string) => !!b.accountById.get(id)?.onBudget, [b.accountById]);
  const needsCategory = useCallback((t: Txn) => onBudgetAcc(t.accountId) && (t.splits.length ? t.splits.some(s => !s.categoryId && !(s.transferAccountId && onBudgetAcc(s.transferAccountId))) : !t.categoryId && !(t.transferAccountId && onBudgetAcc(t.transferAccountId))), [onBudgetAcc]);
  const catText = useCallback((t: Txn) => (t.splits.length ? `Split (${t.splits.length})` : b.categoryLabel(t.categoryId)), [b]);
  const haystack = useMemo(() => { if (!search.trim()) return null; const m = new Map<string, string>();
    for (const t of all) m.set(t.id, [t.payeeName, t.memo, catText(t), ...t.splits.map(s => `${b.categoryLabel(s.categoryId)} ${s.memo}`), b.accountById.get(t.accountId)?.name, b.fmt(Math.abs(t.amount)), String(Math.abs(t.amount) / 100), b.date(t.date), t.date].join('\n').toLowerCase()); return m; }, [all, search, b, catText]);
  const rows = useMemo(() => {
    let r = all;
    if (filter !== 'all') r = r.filter(t => filter === 'uncleared' ? t.cleared === 'uncleared' : filter === 'unreconciled' ? t.cleared !== 'reconciled' : filter === 'flagged' ? !!t.flag : needsCategory(t));
    if (haystack) { const words = search.toLowerCase().split(/\s+/).filter(Boolean); r = r.filter(t => { const h = haystack.get(t.id)!; return words.every(w => h.includes(w)); }); }
    const k = sort.key; const val = (t: Txn): string | number => k === 'payee' ? t.payeeName.toLowerCase() : k === 'category' ? catText(t).toLowerCase() : k === 'amount' ? t.amount : k === 'cleared' ? t.cleared : k === 'account' ? (b.accountById.get(t.accountId)?.name ?? '') : t.date;
    if (k === 'date') return sort.dir === 1 ? r : [...r].reverse();
    return [...r].sort((x, y) => { const a = val(x), c = val(y); return (a < c ? -1 : a > c ? 1 : x.date < y.date ? -1 : x.date > y.date ? 1 : x.seq - y.seq) * sort.dir; });
  }, [all, filter, haystack, search, sort, needsCategory, catText, b.accountById]);

  const showAccount = !accountId;
  const grid = `28px 24px 118px ${showAccount ? '130px ' : ''}minmax(120px,1.25fr) minmax(130px,1.25fr) minmax(70px,1fr) 104px 104px 34px ${accountId ? '112px' : '0px'}`;
  const display = useMemo(() => (editing === 'new' ? ['new' as const, ...rows] : rows), [editing, rows]);
  const virt = useVirtualizer({ count: display.length, getScrollElement: () => parentRef.current, estimateSize: () => (mobile ? 60 : 34), overscan: 14, getItemKey: i => { const d = display[i]; return d === 'new' ? 'new' : d.id; } });
  useEffect(() => { if (editing && editing !== 'new') { const i = display.findIndex(d => d !== 'new' && d.id === editing); if (i >= 0) virt.scrollToIndex(i, { align: 'center' }); } else if (editing === 'new') parentRef.current?.scrollTo({ top: 0 }); }, [editing]); // eslint-disable-line

  const apply = (c: TxnChange) => b.applyChange(c);
  const run = async (fn: () => Promise<TxnChange>, done?: string) => { try { const c = await fn(); apply(c); if (done) toast(done, 'info', { label: 'Undo', run: b.undo }); return c; } catch (e) { toastError(e); } };
  const ids = [...selected];
  const remove = (list: string[]) => run(() => post(b.url('/transactions/delete'), { ids: list }), `Deleted ${list.length} transaction${list.length === 1 ? '' : 's'}`).then(() => { setSelected(new Set()); setEditing(null); });
  const bulk = (patch: object, msg?: string) => run(() => post(b.url('/transactions/bulk'), { ids, patch }), msg);
  const toggleCleared = (t: Txn) => { if (t.cleared === 'reconciled') { toast('Reconciled transactions are locked. Open the transaction to change it.'); return; } run(() => post(b.url('/transactions/bulk'), { ids: [t.id], patch: { cleared: t.cleared === 'cleared' ? 'uncleared' : 'cleared' } })); };
  const select = (t: Txn, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, viaBox = false) => {
    setSelected(prev => {
      if (e.shiftKey && anchor.current) { const i = rows.findIndex(r => r.id === anchor.current), j = rows.findIndex(r => r.id === t.id); if (i >= 0 && j >= 0) return new Set(rows.slice(Math.min(i, j), Math.max(i, j) + 1).map(r => r.id)); }
      anchor.current = t.id;
      if (viaBox || e.ctrlKey || e.metaKey) { const n = new Set(prev); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; }
      return prev.size === 1 && prev.has(t.id) ? prev : new Set([t.id]);
    });
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement; if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || editing || reconcile) return;
      if (e.key === 'n' || e.key === 'N' || e.key === 'Insert') { e.preventDefault(); setEditing('new'); }
      else if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'f')) { e.preventDefault(); searchRef.current?.focus(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); setSelected(new Set(rows.map(r => r.id))); }
      else if (e.key === 'Escape') setSelected(new Set());
      else if (!selected.size) return;
      else if (e.key === 'Enter' && selected.size === 1) { e.preventDefault(); setEditing(ids[0]); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(ids); }
      else if (e.key === 'c' || e.key === 'C') bulk({ cleared: all.find(t => t.id === ids[0])?.cleared === 'cleared' ? 'uncleared' : 'cleared' });
      else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(() => post(b.url('/transactions/duplicate'), { ids }), 'Duplicated'); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const i = rows.findIndex(r => r.id === (anchor.current ?? ids[0])); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) { anchor.current = n.id; setSelected(new Set([n.id])); virt.scrollToIndex(display.indexOf(n)); } }
    };
    window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f);
  });
  const catOptions = useCategoryOptions();
  const selTotal = useMemo(() => all.filter(t => selected.has(t.id)).reduce((s, t) => s + t.amount, 0), [all, selected]);
  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => <button onClick={() => setSort(s => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === 'date' ? -1 : 1 }))} className={cx('flex items-center gap-1 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3 hover:text-ink', right && 'justify-end')}>
    {children}{sort.key === k && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button>;
  if (accountId && !account) return <Empty title="Account not found" action={<Button onClick={() => go('accounts/all')}>All accounts</Button>} />;
  const total = account ? account.balance : b.boot.accounts.reduce((s, a) => s + a.balance, 0), clearedBal = account ? account.clearedBalance : b.boot.accounts.reduce((s, a) => s + a.clearedBalance, 0);
  const editTxn = editing && editing !== 'new' ? all.find(t => t.id === editing) ?? null : null;
  const done = (c: TxnChange, again: boolean) => { apply(c); setEditing(null); if (again) setTimeout(() => setEditing('new'), 0); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line bg-surface px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">{mobile && <a href="#/accounts" aria-label="Accounts" className="-ml-2 p-1 text-ink-2"><ChevronLeft size={20} /></a>}
            <h1 className="truncate text-[17px] font-semibold tracking-tight">{account?.name ?? 'All Accounts'}</h1>
            {account && <Button size="icon" variant="ghost" aria-label="Edit account" title="Edit account" onClick={() => onEditAccount(account)}><Pencil size={14} /></Button>}
            {account && !account.onBudget && <Badge>Tracking</Badge>}{account?.closed && <Badge>Closed</Badge>}</div>
          <div className="num flex items-center gap-2 text-[12.5px] text-ink-2 max-md:w-full">
            <span title="Cleared and reconciled transactions"><b className="font-semibold text-ink">{b.fmt(clearedBal)}</b> cleared</span><span>+</span><span><b className="font-semibold text-ink">{b.fmt(total - clearedBal)}</b> uncleared</span><span>=</span>
            <span className={cx('rounded-lg px-2 py-0.5 text-[14px] font-semibold', total < 0 ? 'bg-neg-soft text-neg' : 'bg-pos-soft text-pos')}>{b.fmt(total)}</span></div>
          <div className="ml-auto flex items-center gap-1.5 max-md:ml-0 max-md:w-full">
            <div className="relative min-w-0 flex-1 md:w-56 md:flex-none"><Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <Input ref={searchRef} aria-label="Search transactions" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search  ( / )" className="h-8 pl-8 pr-7" onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); (e.target as HTMLInputElement).blur(); } }} />
              {search && <button aria-label="Clear search" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3"><X size={14} /></button>}</div>
            <Menu trigger={p => <Button ref={p.ref as any} size="sm" onClick={p.onClick} className={cx(filter !== 'all' && 'border-accent text-accent')}><Filter size={14} /><span className="max-md:hidden">{FILTERS[filter]}</span></Button>}
              items={(Object.keys(FILTERS) as FilterKey[]).map(k => ({ label: FILTERS[k] + (k === filter ? '  ✓' : ''), onClick: () => setFilter(k) }))} />
            {account && <Button size="sm" onClick={() => setReconcile(true)} title="Reconcile with your bank balance"><CheckCheck size={14} /><span className="max-md:hidden">Reconcile</span></Button>}
            <Menu trigger={p => <Button ref={p.ref as any} size="sm" onClick={p.onClick} aria-label="More actions">···</Button>} items={[
              { label: 'Import from bank…', icon: <ScanLine size={14} />, onClick: () => go('import') }, { label: 'Export to CSV', icon: <Download size={14} />, onClick: () => download(b.url(`/export/register.csv${accountId ? `?accountId=${accountId}` : ''}`)) }]} />
            {!mobile && <Button size="sm" variant="primary" onClick={() => setEditing('new')} title="New transaction (N)"><Plus size={15} />Add transaction</Button>}
          </div>
        </div>
        {selected.size > 0 && !mobile && <div className="anim-in mt-2.5 flex flex-wrap items-center gap-1.5 rounded-xl bg-accent-soft px-3 py-1.5 text-[13px]">
          <b className="font-semibold">{selected.size} selected</b><span className="num text-ink-2">· {b.fmt(selTotal)}</span><span className="flex-1" />
          <Button size="sm" onClick={() => bulk({ cleared: 'cleared' })}>Mark cleared</Button><Button size="sm" onClick={() => bulk({ cleared: 'uncleared' })}>Unclear</Button>
          <Button size="sm" onClick={() => setBulkCat(true)}>Categorise</Button>
          <Menu trigger={p => <Button ref={p.ref as any} size="sm" onClick={p.onClick}><FlagIcon size={13} />Flag</Button>} items={[...(Object.keys(FLAG_COLORS) as Flag[]).map(f => ({ label: f[0].toUpperCase() + f.slice(1), icon: <FlagIcon size={13} fill={FLAG_COLORS[f]} color={FLAG_COLORS[f]} />, onClick: () => { bulk({ flag: f }); } })), 'sep', { label: 'No flag', onClick: () => { bulk({ flag: null }); } }]} />
          <Menu trigger={p => <Button ref={p.ref as any} size="sm" onClick={p.onClick}>Move to account</Button>} items={b.boot.accounts.filter(a => !a.closed).map(a => ({ label: a.name, onClick: () => { bulk({ accountId: a.id }, 'Moved'); setSelected(new Set()); } }))} />
          <Button size="sm" onClick={() => run(() => post(b.url('/transactions/duplicate'), { ids }), 'Duplicated')}><Copy size={13} />Duplicate</Button>
          <Button size="sm" className="text-neg" onClick={() => remove(ids)}><Trash2 size={13} />Delete</Button><Button size="icon" variant="ghost" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></Button></div>}
      </header>
      {!mobile && <div className="grid items-center gap-x-1.5 border-b border-line bg-bg px-2" style={{ gridTemplateColumns: grid }}>
        <input type="checkbox" aria-label="Select all" className="mx-auto accent-[var(--accent)]" checked={rows.length > 0 && selected.size === rows.length} onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} />
        <span /><Th k="date">Date</Th>{showAccount && <Th k="account">Account</Th>}<Th k="payee">Payee</Th><Th k="category">Category</Th><span className="py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Memo</span>
        <Th k="amount" right>Outflow</Th><Th k="amount" right>Inflow</Th><Th k="cleared"><span className="mx-auto">C</span></Th><span className="py-2 pr-2 text-right text-[11px] font-semibold uppercase tracking-wide text-ink-3">{accountId ? 'Balance' : ''}</span></div>}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="register">
        {q.isLoading ? <div className="p-8 text-ink-3">Loading transactions…</div> : !display.length ? <Empty title={all.length ? 'No transactions match' : 'No transactions yet'} action={all.length ? <Button onClick={() => { setSearch(''); setFilter('all'); }}>Clear search and filter</Button> : <Button variant="primary" onClick={() => setEditing('new')}><Plus size={15} />Add transaction</Button>}>
          {all.length ? 'Try a different search or filter.' : 'Add your first transaction, or import them from your bank.'}</Empty>
          : <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map(v => { const d = display[v.index]; const isEdit = !mobile && (d === 'new' || d.id === editing);
              return <div key={v.key} data-index={v.index} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>
                {isEdit ? <TxnEditor key={d === 'new' ? 'new' : d.id} txn={d === 'new' ? null : d} accountId={accountId} showAccount={showAccount} layout="row" grid={grid} onDone={done} onCancel={() => setEditing(null)} />
                  : d === 'new' ? <div className="h-0" /> : mobile ? <MobileRow t={d} fmt={b.fmt} date={b.date} category={catText(d)} account={showAccount ? b.accountById.get(d.accountId)?.name : undefined} warn={needsCategory(d)} onOpen={() => setEditing(d.id)} onClear={() => toggleCleared(d)} />
                  : <Row t={d} grid={grid} selected={selected.has(d.id)} fmt={b.fmt} date={b.date} category={catText(d)} account={showAccount ? b.accountById.get(d.accountId)?.name ?? '' : null} balance={accountId && sort.key === 'date' ? balances.get(d.id) : undefined}
                    warn={needsCategory(d)} onSelect={select} onEdit={() => setEditing(d.id)} onClear={() => toggleCleared(d)} />}</div>; })}</div>}
      </div>
      <footer className="num flex items-center justify-between border-t border-line bg-surface px-4 py-1.5 text-[12px] text-ink-3 md:px-6"><span>{rows.length === all.length ? `${all.length.toLocaleString()} transactions` : `${rows.length.toLocaleString()} of ${all.length.toLocaleString()} transactions`}</span>
        {rows.length !== all.length && <span>Shown total {b.fmt(rows.reduce((s, t) => s + t.amount, 0))}</span>}</footer>
      {mobile && <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing === 'new' ? 'New transaction' : 'Edit transaction'}>
        {editing && <><TxnEditor key={editing} txn={editTxn} accountId={accountId} showAccount layout="stack" onDone={done} onCancel={() => setEditing(null)} />
          {editTxn && !editTxn.splitTransferParent && <div className="mt-3 flex gap-2 border-t border-line pt-3"><Button className="flex-1" onClick={() => { run(() => post(b.url('/transactions/duplicate'), { ids: [editTxn.id] }), 'Duplicated'); setEditing(null); }}><Copy size={15} />Duplicate</Button><Button className="flex-1 text-neg" onClick={() => remove([editTxn.id])}><Trash2 size={15} />Delete</Button></div>}</>}</Dialog>}
      <Dialog open={bulkCat} onClose={() => setBulkCat(false)} title={`Categorise ${selected.size} transaction${selected.size === 1 ? '' : 's'}`}>
        <p className="mb-3 text-[13px] text-ink-2">Splits and transfers between budget accounts are left unchanged.</p>
        <Combobox aria-label="Category" autoFocus value={null} placeholder="Choose category" options={catOptions} onPick={o => { if (o) { bulk({ categoryId: o.id }, 'Categorised'); setBulkCat(false); } }} /></Dialog>
      {reconcile && account && <ReconcileDialog account={account} onClose={() => setReconcile(false)} onChange={apply} onShow={id => { setReconcile(false); setEditing(id); }} />}
    </div>);
}

interface RowProps { t: Txn; grid: string; selected: boolean; fmt: (n: number) => string; date: (s: string) => string; category: string; account: string | null; balance?: number; warn: boolean;
  onSelect: (t: Txn, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, viaBox?: boolean) => void; onEdit: () => void; onClear: () => void }
const Row = memo(function Row({ t, grid, selected, fmt, date, category, account, balance, warn, onSelect, onEdit, onClear }: RowProps) {
  return <div role="row" aria-selected={selected} onClick={e => onSelect(t, e)} onDoubleClick={onEdit} style={{ gridTemplateColumns: grid }}
    className={cx('grid h-[34px] cursor-default items-center gap-x-1.5 border-b border-line/60 px-2 text-[13px]', selected ? 'bg-accent-soft' : 'hover:bg-sunken/70', t.cleared === 'reconciled' && !selected && 'text-ink-2')}>
    <input type="checkbox" aria-label="Select transaction" className="mx-auto accent-[var(--accent)]" checked={selected} onClick={e => e.stopPropagation()} onChange={() => onSelect(t, { shiftKey: false, ctrlKey: false, metaKey: false }, true)} />
    <span className="flex justify-center">{t.flag && <FlagIcon size={13} fill={FLAG_COLORS[t.flag]} color={FLAG_COLORS[t.flag]} />}</span>
    <span className="num truncate">{date(t.date)}</span>{account !== null && <span className="truncate text-ink-2">{account}</span>}
    <span className={cx('truncate', t.transferAccountId && 'text-ink-2')}>{t.payeeName}</span>
    <span className="truncate">{warn ? <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[12px] text-warn">Needs a category</span> : <span className={cx(t.splits.length > 0 && 'italic text-ink-2')}>{category}</span>}</span>
    <span className="truncate text-ink-3">{t.memo}</span>
    <span className="num truncate text-right">{t.amount < 0 ? fmt(-t.amount) : ''}</span><span className="num truncate text-right text-pos">{t.amount > 0 ? fmt(t.amount) : ''}</span>
    <button className="flex justify-center" aria-label={`Status ${t.cleared}; toggle cleared`} onClick={e => { e.stopPropagation(); onClear(); }} onDoubleClick={e => e.stopPropagation()}><ClearedMark state={t.cleared} /></button>
    <span className={cx('num truncate pr-2 text-right', balance !== undefined && balance < 0 ? 'text-neg' : 'text-ink-2')}>{balance !== undefined ? fmt(balance) : ''}</span>
  </div>;
});
const MobileRow = memo(function MobileRow({ t, fmt, date, category, account, warn, onOpen, onClear }: { t: Txn; fmt: (n: number) => string; date: (s: string) => string; category: string; account?: string; warn: boolean; onOpen: () => void; onClear: () => void }) {
  return <div className="flex h-[60px] items-center gap-3 border-b border-line/70 px-4 active:bg-sunken" onClick={onOpen}>
    <button aria-label="Toggle cleared" className="-m-2 p-2" onClick={e => { e.stopPropagation(); onClear(); }}><ClearedMark state={t.cleared} /></button>
    <div className="min-w-0 flex-1"><div className="flex items-center gap-1.5"><span className="truncate font-medium">{t.payeeName || '(no payee)'}</span>{t.flag && <FlagIcon size={11} fill={FLAG_COLORS[t.flag]} color={FLAG_COLORS[t.flag]} />}</div>
      <div className="truncate text-[12px] text-ink-3">{date(t.date)}{account && ` · ${account}`} · {warn ? <span className="text-warn">Needs a category</span> : category || (t.transferAccountId ? 'Transfer' : '—')}</div></div>
    <Money value={t.amount} fmt={fmt} className={cx('text-[15px] font-medium', t.amount > 0 && 'text-pos')} /></div>;
});

function ReconcileDialog({ account, onClose, onChange, onShow }: { account: Account; onClose: () => void; onChange: (c: TxnChange) => void; onShow: (id: string) => void }) {
  const b = useBudget(); const [step, setStep] = useState<'ask' | 'enter'>('ask'), [text, setText] = useState(''), [statement, setStatement] = useState<number | null>(null), [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: ['b', b.bid, 'aux', 'reconcile', account.id, statement, account.clearedBalance], queryFn: () => get<any>(b.url(`/accounts/${account.id}/reconcile${statement !== null ? `?statement=${statement}` : ''}`)) });
  const txq = useQuery({ queryKey: ['b', b.bid, 'tx', account.id], queryFn: () => get<Txn[]>(b.url(`/transactions?accountId=${account.id}`)), staleTime: 60_000 });
  const byId = useMemo(() => new Map((txq.data ?? []).map(t => [t.id, t])), [txq.data]);
  const diff: number | undefined = info.data?.difference;
  const finish = async (balance: number, createAdjustment: boolean) => { setBusy(true); try { const r = await post<any>(b.url(`/accounts/${account.id}/reconcile`), { statementBalance: balance, createAdjustment }); onChange(r); toast(`Reconciled ${r.reconciledCount} transaction${r.reconciledCount === 1 ? '' : 's'}${r.adjustment ? ` with an adjustment of ${b.fmt(r.adjustment)}` : ''}`, 'success'); onClose(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const parsed = text.trim() ? b.parse(text) : null;
  return <Dialog open onClose={onClose} title={`Reconcile ${account.name}`} wide={step === 'enter' && diff !== undefined && diff !== 0}>
    {step === 'ask' ? <div className="space-y-4 text-center">
      <p className="text-ink-2">Is your bank balance for this account right now</p><div className="num text-3xl font-semibold tracking-tight">{b.fmt(account.clearedBalance, true)}</div>
      <p className="text-[12.5px] text-ink-3">This is the sum of your cleared and reconciled transactions. {account.unclearedBalance !== 0 && `Uncleared transactions (${b.fmt(account.unclearedBalance)}) are not included.`}</p>
      <div className="flex justify-center gap-2"><Button size="lg" onClick={() => setStep('enter')}>No</Button><Button size="lg" variant="primary" disabled={busy} onClick={() => finish(account.clearedBalance, false)}>Yes, it matches</Button></div>
      {info.data?.history?.length > 0 && <details className="pt-2 text-left text-[12.5px] text-ink-2"><summary className="cursor-pointer">Reconciliation history ({info.data.history.length})</summary>
        <table className="num mt-2 w-full"><tbody>{info.data.history.map((h: any) => <tr key={h.id} className="border-t border-line"><td className="py-1">{h.at.slice(0, 10)}</td><td className="text-right">{b.fmt(h.statementBalance)}</td><td className="text-right">{h.txCount} txns</td><td className="text-right">{h.adjustment ? `adj. ${b.fmt(h.adjustment)}` : ''}</td></tr>)}</tbody></table></details>}
    </div> : <div className="space-y-4">
      <Field label="What is the balance at your bank?"><div className="flex gap-2"><Input autoFocus value={text} onChange={e => setText(e.target.value)} inputMode="decimal" placeholder={b.fmt(account.clearedBalance)} className="num text-right text-lg" onKeyDown={e => { if (e.key === 'Enter' && parsed !== null) setStatement(parsed); }} />
        <Button variant="primary" disabled={parsed === null} onClick={() => setStatement(parsed)}>Compare</Button></div></Field>
      {statement !== null && diff !== undefined && (diff === 0 ? <div className="rounded-xl bg-pos-soft p-4 text-center"><p className="font-medium text-pos">The balances match.</p><Button variant="primary" className="mt-3" disabled={busy} onClick={() => finish(statement, false)}>Finish reconciling</Button></div> : <>
        <div className="num grid grid-cols-3 gap-2 text-center text-[13px]">{[['Bank balance', statement], ['Cleared here', info.data.clearedBalance], ['Difference', diff]].map(([l, v]) => <div key={l as string} className={cx('rounded-xl border border-line p-2.5', l === 'Difference' && 'border-neg bg-neg-soft text-neg')}><div className="text-[11px] uppercase tracking-wide opacity-70">{l}</div><div className="text-[15px] font-semibold">{b.fmt(v as number)}</div></div>)}</div>
        <p className="text-[13px] text-ink-2">{diff > 0 ? `Your bank has ${b.fmt(diff)} more than your cleared transactions.` : `Your bank has ${b.fmt(-diff)} less than your cleared transactions.`} Find the cause below, fix it in the register, and reconcile again.</p>
        <div className="space-y-2">{info.data.hints.length === 0 && <p className="rounded-xl border border-line p-3 text-[13px] text-ink-2">No obvious cause found. Compare the cleared transactions with your bank statement line by line; a missing or mistyped transaction is the usual reason.</p>}
          {info.data.hints.map((h: any, i: number) => <div key={i} className="rounded-xl border border-line p-3"><p className="text-[13px] font-medium">{h.message}</p>
            {h.txnIds.slice(0, 6).map((id: string) => { const t = byId.get(id); return t && <button key={id} onClick={() => onShow(id)} className="num mt-1 flex w-full justify-between gap-3 rounded-lg px-2 py-1 text-left text-[12.5px] hover:bg-sunken"><span>{b.date(t.date)} · {t.payeeName}</span><span>{b.fmt(t.amount)}</span></button>; })}</div>)}</div>
        <div className="rounded-xl border border-warn bg-warn-soft p-3"><p className="text-[13px] text-warn">If you cannot find the difference you may record it as a visible adjustment transaction of <b>{b.fmt(diff)}</b>{account.onBudget ? ' (categorised as income for this month)' : ''}. Nothing is adjusted unless you press this button.</p>
          <Button className="mt-2" disabled={busy} onClick={() => finish(statement, true)}>Create adjustment of {b.fmt(diff)} and finish</Button></div></>)}
    </div>}
  </Dialog>;
}
