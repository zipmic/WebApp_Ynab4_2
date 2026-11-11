import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, Eye, EyeOff, FolderPlus, Plus, StickyNote, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Combobox, cx, Dialog, Field, Input, Menu, Money, Popover } from '../components/ui';
import { get, post, put, patch as apiPatch } from '../lib/api';
import { go, monthLabel, MONTHS, toast, useBudget, useIsMobile } from '../lib/store';
import { addMonths, isValidMonth, monthOf, todayISO } from '../../shared/dates';
import type { BudgetCategoryRow, BudgetMonth, Category, CategoryGroup, Txn } from '../../shared/types';

export function BudgetView({ month: routeMonth }: { month?: string }) {
  const b = useBudget(); const qc = useQueryClient(); const mobile = useIsMobile();
  const thisMonth = monthOf(b.boot.today);
  const month = routeMonth && isValidMonth(routeMonth) ? routeMonth : thisMonth;
  const key = ['b', b.bid, 'budget', month];
  const q = useQuery({ queryKey: key, queryFn: () => get<BudgetMonth>(b.url(`/budget/${month}`)), placeholderData: p => p });
  const prev = useQuery({ queryKey: ['b', b.bid, 'budget', addMonths(month, -1)], queryFn: () => get<BudgetMonth>(b.url(`/budget/${addMonths(month, -1)}`)) });
  useEffect(() => { for (const m of [addMonths(month, 1)]) qc.prefetchQuery({ queryKey: ['b', b.bid, 'budget', m], queryFn: () => get<BudgetMonth>(b.url(`/budget/${m}`)) }); }, [month, b, qc]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('br-collapsed') ?? '[]')));
  const [selected, setSelected] = useState<string | null>(null), [showHidden, setShowHidden] = useState(false), [sheet, setSheet] = useState(false);
  const [prompt, setPrompt] = useState<{ title: string; label: string; initial?: string; run: (v: string) => Promise<unknown> } | null>(null);
  const [drill, setDrill] = useState<{ categoryId?: string; uncategorized?: boolean; title: string } | null>(null);
  const [del, setDel] = useState<Category | null>(null);
  const toggle = (id: string) => setCollapsed(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); localStorage.setItem('br-collapsed', JSON.stringify([...n])); return n; });
  const data = q.data;
  const rows = useMemo(() => new Map((data?.rows ?? []).map(r => [r.categoryId, r])), [data]);
  const prevRows = useMemo(() => new Map((prev.data?.rows ?? []).map(r => [r.categoryId, r])), [prev.data]);
  const nav = (n: number) => go(`budget/${addMonths(month, n)}`);
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.key === '[' || (e.altKey && e.key === 'ArrowLeft')) nav(-1); else if (e.key === ']' || (e.altKey && e.key === 'ArrowRight')) nav(1); else if (e.key.toLowerCase() === 't') go(`budget/${thisMonth}`); };
    window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f);
  });
  /** Save a budgeted amount with an optimistic cache update so typing never waits for the server. */
  const setBudgeted = async (categoryId: string, value: number) => {
    const cur = qc.getQueryData<BudgetMonth>(key); const row = cur?.rows.find(r => r.categoryId === categoryId); if (!cur || !row || row.budgeted === value) return;
    const d = value - row.budgeted;
    qc.setQueryData<BudgetMonth>(key, { ...cur, budgeted: cur.budgeted + d, availableToBudget: cur.availableToBudget - d, rows: cur.rows.map(r => r === row ? { ...r, budgeted: value, available: r.available + d } : r) });
    await b.mutate(() => put(b.url(`/budget/${month}/categories/${categoryId}`), { budgeted: value }));
  };
  const act = (fn: () => Promise<unknown>) => b.mutate(fn);
  if (!data) return <div className="p-8 text-ink-3">Loading…</div>;
  const visibleCats = (g: CategoryGroup) => b.boot.categories.filter(c => c.groupId === g.id && (showHidden || !c.hidden));
  const groups = b.boot.groups.filter(g => showHidden || !g.hidden);
  const hiddenCount = b.boot.categories.filter(c => c.hidden).length;
  const selCat = selected ? b.categoryById.get(selected) ?? null : null;
  const reorder = (cat: Category, dir: -1 | 1) => {
    const order = b.boot.groups.map(g => ({ groupId: g.id, categoryIds: b.boot.categories.filter(c => c.groupId === g.id).map(c => c.id) }));
    const g = order.find(o => o.groupId === cat.groupId)!; const i = g.categoryIds.indexOf(cat.id), j = i + dir; if (j < 0 || j >= g.categoryIds.length) return;
    [g.categoryIds[i], g.categoryIds[j]] = [g.categoryIds[j], g.categoryIds[i]]; act(() => post(b.url('/categories/reorder'), { order }));
  };
  const reorderGroup = (gid: string, dir: -1 | 1) => {
    const order = b.boot.groups.map(g => ({ groupId: g.id, categoryIds: b.boot.categories.filter(c => c.groupId === g.id).map(c => c.id) }));
    const i = order.findIndex(o => o.groupId === gid), j = i + dir; if (j < 0 || j >= order.length) return; [order[i], order[j]] = [order[j], order[i]]; act(() => post(b.url('/categories/reorder'), { order }));
  };
  const inspector = <Inspector month={month} data={data} cat={selCat} row={selCat ? rows.get(selCat.id) ?? null : null} prevRow={selCat ? prevRows.get(selCat.id) ?? null : null}
    setBudgeted={setBudgeted} act={act} onRename={c => setPrompt({ title: 'Rename category', label: 'Name', initial: c.name, run: v => apiPatch(b.url(`/categories/${c.id}`), { name: v }) })}
    onDelete={setDel} reorder={reorder} onDrill={setDrill} showHidden={showHidden} setShowHidden={setShowHidden} hiddenCount={hiddenCount}
    addGroup={() => setPrompt({ title: 'New category group', label: 'Group name', run: v => post(b.url('/groups'), { name: v }) })} />;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line bg-surface px-4 py-3 md:px-6">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={() => nav(-1)} aria-label="Previous month" title="Previous month ( [ )"><ChevronLeft size={18} /></Button>
            <MonthPicker month={month} />
            <Button variant="ghost" size="icon" onClick={() => nav(1)} aria-label="Next month" title="Next month ( ] )"><ChevronRight size={18} /></Button>
            {month !== thisMonth && <Button size="sm" variant="ghost" onClick={() => go(`budget/${thisMonth}`)}>Today</Button>}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-x-6 gap-y-2">
            {!mobile && <dl className="num grid grid-cols-[auto_auto] gap-x-3 text-[12.5px] leading-[1.45] text-ink-2">
              <dd className="text-right">{b.fmt(data.carriedAtb)}</dd><dt>{data.carriedAtb < 0 ? 'Overbudgeted' : 'Not budgeted'} in {MONTHS[+addMonths(month, -1).slice(5) - 1].slice(0, 3)}</dt>
              <dd className={cx('text-right', data.overspentPrev > 0 && 'text-neg')}>{b.fmt(-data.overspentPrev)}</dd><dt>Overspent in {MONTHS[+addMonths(month, -1).slice(5) - 1].slice(0, 3)}</dt>
              <dd className="text-right">{b.fmt(data.income)}</dd><dt>Income for {MONTHS[+month.slice(5) - 1].slice(0, 3)}</dt>
              <dd className="text-right">{b.fmt(-data.budgeted)}</dd><dt>Budgeted in {MONTHS[+month.slice(5) - 1].slice(0, 3)}</dt></dl>}
            <div className={cx('rounded-xl px-4 py-2 text-right', data.availableToBudget < 0 ? 'bg-neg-soft' : data.availableToBudget > 0 ? 'bg-pos-soft' : 'bg-sunken')} data-testid="atb">
              <div className={cx('num text-[22px] font-semibold leading-tight tracking-tight', data.availableToBudget < 0 ? 'text-neg' : data.availableToBudget > 0 ? 'text-pos' : 'text-ink-2')}>{b.fmt(data.availableToBudget)}</div>
              <div className="text-[11.5px] font-medium text-ink-2">{data.availableToBudget < 0 ? 'Overbudgeted' : 'Available to Budget'}</div></div>
          </div>
        </header>
        {mobile && <div className="num flex justify-between gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-1.5 text-[11.5px] text-ink-2">
          <span>Income {b.fmt(data.income)}</span><span>Budgeted {b.fmt(data.budgeted)}</span>{data.overspentPrev > 0 && <span className="text-neg">Overspent last mo. {b.fmt(-data.overspentPrev)}</span>}<button className="text-accent" onClick={() => { setSelected(null); setSheet(true); }}>Month…</button></div>}
        {data.uncategorizedCount > 0 && <button onClick={() => setDrill({ uncategorized: true, title: `Uncategorised transactions in ${monthLabel(month)}` })} className="flex items-center gap-2 border-b border-line bg-warn-soft px-4 py-1.5 text-left text-[12.5px] text-warn md:px-6">
          {data.uncategorizedCount} transaction{data.uncategorizedCount === 1 ? '' : 's'} this month {data.uncategorizedCount === 1 ? 'has' : 'have'} no category and {data.uncategorizedCount === 1 ? 'is' : 'are'} not counted in the budget. Review →</button>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full border-collapse" onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
            <thead className="sticky top-0 z-10 bg-bg text-[11px] uppercase tracking-wide text-ink-3">
              <tr><th className="py-2 pl-4 text-left font-semibold md:pl-6">Category</th><th className="hidden w-36 px-3 text-right font-semibold md:table-cell">Budgeted</th><th className="hidden w-32 px-3 text-right font-semibold md:table-cell">Activity</th><th className="w-36 pr-4 text-right font-semibold md:pr-6">Available</th></tr></thead>
            <tbody>
              {groups.map((g, gi) => { const cats = visibleCats(g); const sum = (k: 'budgeted' | 'activity' | 'available') => cats.reduce((s, c) => s + (rows.get(c.id)?.[k] ?? 0), 0); const open = !collapsed.has(g.id);
                return [<tr key={g.id} className="group border-y border-line bg-sunken/70 text-[13px] font-semibold">
                  <td className="py-1.5 pl-2 md:pl-4"><div className="flex items-center gap-1"><button onClick={() => toggle(g.id)} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}`} className="flex h-6 w-6 items-center justify-center rounded hover:bg-line">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                    <span className={cx('truncate', g.hidden && 'text-ink-3 line-through')}>{g.name}</span>
                    <span className="ml-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
                      <Button size="icon" variant="ghost" className="h-6 w-6" title="Add category" aria-label={`Add category to ${g.name}`} onClick={() => setPrompt({ title: `New category in ${g.name}`, label: 'Category name', run: v => post(b.url('/categories'), { groupId: g.id, name: v }) })}><Plus size={14} /></Button>
                      <Menu align="start" trigger={p => <Button ref={p.ref as any} onClick={p.onClick} size="icon" variant="ghost" className="h-6 w-6 text-ink-3" aria-label={`Group actions for ${g.name}`}>···</Button>}
                        items={[{ label: 'Rename group', onClick: () => setPrompt({ title: 'Rename group', label: 'Name', initial: g.name, run: v => apiPatch(b.url(`/groups/${g.id}`), { name: v }) }) },
                          { label: 'Move up', disabled: gi === 0, onClick: () => reorderGroup(g.id, -1) }, { label: 'Move down', disabled: gi === groups.length - 1, onClick: () => reorderGroup(g.id, 1) },
                          { label: g.hidden ? 'Unhide group' : 'Hide group', onClick: () => act(() => apiPatch(b.url(`/groups/${g.id}`), { hidden: !g.hidden })) }, 'sep',
                          { label: 'Delete group', danger: true, onClick: () => act(() => fetchDelete(b.url(`/groups/${g.id}`))) }]} /></span></div></td>
                  <td className="num hidden px-3 text-right text-ink-2 md:table-cell">{b.fmt(sum('budgeted'))}</td><td className="num hidden px-3 text-right text-ink-2 md:table-cell">{b.fmt(sum('activity'))}</td>
                  <td className="num pr-4 text-right text-ink-2 md:pr-6">{b.fmt(sum('available'))}</td></tr>,
                  ...(open ? cats.map(c => <CategoryRow key={c.id} cat={c} row={rows.get(c.id)} selected={selected === c.id} mobile={mobile} fmt={b.fmt} parse={b.parse}
                    onSelect={() => { setSelected(c.id); if (mobile) setSheet(true); }} onBudget={v => setBudgeted(c.id, v)} onDrill={() => setDrill({ categoryId: c.id, title: `${c.name} · ${monthLabel(month)}` })}
                    onHandling={h => act(() => put(b.url(`/budget/${month}/categories/${c.id}`), { overspending: h }))} />) : [])]; })}
            </tbody>
          </table>
          {!b.boot.groups.length && <div className="mx-auto max-w-md px-6 py-14 text-center"><div className="text-[15px] font-semibold">Set up your categories</div><p className="mt-1 text-ink-2">Create groups such as “Monthly bills” or “Everyday expenses”, then add the categories you want to give money to.</p>
            <Button variant="primary" className="mt-4" onClick={() => setPrompt({ title: 'New category group', label: 'Group name', run: v => post(b.url('/groups'), { name: v }) })}><FolderPlus size={16} />Add category group</Button></div>}
          <div className="flex flex-wrap gap-2 px-4 py-4 md:px-6">
            {b.boot.groups.length > 0 && <Button size="sm" variant="ghost" onClick={() => setPrompt({ title: 'New category group', label: 'Group name', run: v => post(b.url('/groups'), { name: v }) })}><FolderPlus size={15} />Add category group</Button>}
            {hiddenCount > 0 && <Button size="sm" variant="ghost" onClick={() => setShowHidden(s => !s)}>{showHidden ? <EyeOff size={15} /> : <Eye size={15} />}{showHidden ? 'Hide' : 'Show'} {hiddenCount} hidden</Button>}
          </div>
        </div>
      </div>
      {!mobile && <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-line bg-surface lg:block">{inspector}</aside>}
      {mobile && <Dialog open={sheet} onClose={() => setSheet(false)} title={selCat ? selCat.name : monthLabel(month)}>{inspector}</Dialog>}
      {prompt && <PromptDialog {...prompt} onClose={() => setPrompt(null)} onRun={async v => { const ok = await b.mutate(() => prompt.run(v)); if (ok !== undefined) setPrompt(null); }} />}
      {drill && <DrillDialog month={month} {...drill} onClose={() => setDrill(null)} />}
      {del && <DeleteCategoryDialog cat={del} onClose={() => setDel(null)} onDone={() => { setDel(null); setSelected(null); }} />}
    </div>);
}
const fetchDelete = (url: string) => import('../lib/api').then(m => m.del(url));

const CategoryRow = memo(function CategoryRow({ cat, row, selected, mobile, fmt, parse, onSelect, onBudget, onDrill, onHandling }: { cat: Category; row?: BudgetCategoryRow; selected: boolean; mobile: boolean;
  fmt: (n: number) => string; parse: (s: string) => number | null; onSelect: () => void; onBudget: (v: number) => void; onDrill: () => void; onHandling: (h: 'confined' | 'affects_buffer') => void }) {
  const r = row ?? { budgeted: 0, activity: 0, available: 0, carryIn: 0, handling: 'affects_buffer' as const, handlingExplicit: false, note: '', categoryId: cat.id };
  return <tr onClick={onSelect} data-cat={cat.id} className={cx('cursor-default border-b border-line/70 transition-colors', selected ? 'bg-accent-soft' : 'hover:bg-sunken/60')}>
    <td className="py-1 pl-9 md:pl-11"><div className="flex items-center gap-1.5 py-1"><span className={cx('truncate', cat.hidden && 'text-ink-3 line-through')}>{cat.name}</span>{(r.note || cat.note) && <StickyNote size={12} className="shrink-0 text-warn" aria-label="Has note" />}</div>
      {mobile && <div className="num -mt-1 pb-1 text-[11.5px] text-ink-3">Budgeted {fmt(r.budgeted)} · Activity {fmt(r.activity)}</div>}</td>
    <td className="hidden px-2 md:table-cell"><BudgetInput value={r.budgeted} fmt={fmt} parse={parse} onCommit={onBudget} label={`Budgeted for ${cat.name}`} onFocus={onSelect} /></td>
    <td className="hidden px-3 text-right md:table-cell"><button onClick={e => { e.stopPropagation(); onDrill(); }} className={cx('num rounded px-1 hover:underline', r.activity === 0 && 'text-ink-3')} title="Show transactions">{fmt(r.activity)}</button></td>
    <td className="pr-4 text-right md:pr-6"><AvailablePill r={r} fmt={fmt} onHandling={onHandling} /></td>
  </tr>;
});

function AvailablePill({ r, fmt, onHandling }: { r: BudgetCategoryRow; fmt: (n: number) => string; onHandling: (h: 'confined' | 'affects_buffer') => void }) {
  const cls = cx('num inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[13px] font-medium', r.available < 0 ? 'bg-neg-soft text-neg' : r.available > 0 ? 'bg-pos-soft text-pos' : 'text-ink-3');
  if (r.available >= 0 && r.handling !== 'confined') return <span className={cls}>{fmt(r.available)}</span>;
  return <Menu trigger={p => <button ref={p.ref as any} onClick={e => { e.stopPropagation(); p.onClick(); }} className={cx(cls, 'hover:brightness-95')} title={r.handling === 'confined' ? 'Negative balance carries forward in this category' : 'Overspending is taken from next month’s Available to Budget'}>
      {fmt(r.available)}{r.handling === 'confined' ? <ArrowRight size={12} /> : <CornerDownRight size={12} />}</button>}
    items={[{ label: <span><b className="font-medium">Subtract from next month’s Available to Budget</b><br /><span className="text-[12px] text-ink-3">Category starts next month at zero (YNAB4 default){r.handling === 'affects_buffer' ? ' ✓' : ''}</span></span>, onClick: () => onHandling('affects_buffer') },
      { label: <span><b className="font-medium">Subtract from next month’s category balance</b><br /><span className="text-[12px] text-ink-3">The negative balance stays in this category{r.handling === 'confined' ? ' ✓' : ''}</span></span>, onClick: () => onHandling('confined') }]} />;
}

function BudgetInput({ value, fmt, parse, onCommit, label, onFocus }: { value: number; fmt: (n: number) => string; parse: (s: string) => number | null; onCommit: (v: number) => void; label: string; onFocus?: () => void }) {
  const [text, setText] = useState<string | null>(null); const ref = useRef<HTMLInputElement>(null);
  const commit = () => { if (text === null) return true; const v = text.trim() === '' ? 0 : parse(text); if (v === null) { toast('Not a valid amount', 'error'); return false; } setText(null); onCommit(v); return true; };
  const move = (dir: 1 | -1) => { const all = [...document.querySelectorAll<HTMLInputElement>('input[data-budget]')]; all[all.indexOf(ref.current!) + dir]?.focus(); };
  return <input ref={ref} data-budget aria-label={label} inputMode="decimal" value={text ?? (value === 0 ? '' : fmt(value))} placeholder="0,00"
    onFocus={e => { onFocus?.(); e.target.select(); }} onChange={e => setText(e.target.value)} onBlur={() => { if (!commit()) setText(null); }} onClick={e => e.stopPropagation()}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); if (commit()) move(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); if (commit()) move(-1); } else if (e.key === 'Escape') { setText(null); ref.current?.blur(); } }}
    className="num h-7 w-full rounded-md border border-transparent bg-transparent px-2 text-right placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/25" />;
}

function MonthPicker({ month }: { month: string }) {
  const [el, setEl] = useState<HTMLElement | null>(null), [open, setOpen] = useState(false), [year, setYear] = useState(+month.slice(0, 4));
  useEffect(() => setYear(+month.slice(0, 4)), [month]);
  return <><button ref={setEl} onClick={() => setOpen(o => !o)} className="min-w-[9.5rem] rounded-lg px-2 py-1 text-center text-[17px] font-semibold tracking-tight hover:bg-sunken" aria-label="Choose month">{monthLabel(month)}</button>
    <Popover anchor={el} open={open} onClose={() => setOpen(false)} width={250}><div className="p-2">
      <div className="mb-2 flex items-center justify-between"><Button size="icon" variant="ghost" onClick={() => setYear(y => y - 1)} aria-label="Previous year"><ChevronLeft size={16} /></Button><span className="num font-semibold">{year}</span><Button size="icon" variant="ghost" onClick={() => setYear(y => y + 1)} aria-label="Next year"><ChevronRight size={16} /></Button></div>
      <div className="grid grid-cols-4 gap-1">{MONTHS.map((n, i) => { const m = `${year}-${String(i + 1).padStart(2, '0')}`; return <button key={n} onClick={() => { go(`budget/${m}`); setOpen(false); }}
        className={cx('rounded-lg py-1.5 text-[13px] hover:bg-sunken', m === month && 'bg-accent text-accent-ink hover:bg-accent', m === monthOf(todayISO()) && m !== month && 'font-semibold text-accent')}>{n.slice(0, 3)}</button>; })}</div></div></Popover></>;
}

function Inspector({ month, data, cat, row, prevRow, setBudgeted, act, onRename, onDelete, reorder, onDrill, showHidden, setShowHidden, hiddenCount, addGroup }: { month: string; data: BudgetMonth; cat: Category | null; row: BudgetCategoryRow | null; prevRow: BudgetCategoryRow | null;
  setBudgeted: (id: string, v: number) => void; act: (fn: () => Promise<unknown>) => Promise<unknown>; onRename: (c: Category) => void; onDelete: (c: Category) => void; reorder: (c: Category, d: -1 | 1) => void;
  onDrill: (d: { categoryId?: string; uncategorized?: boolean; title: string }) => void; showHidden: boolean; setShowHidden: (f: (s: boolean) => boolean) => void; hiddenCount: number; addGroup: () => void }) {
  const b = useBudget(); const [moveTo, setMoveTo] = useState<string | null>(null), [moveAmt, setMoveAmt] = useState('');
  const quick = (action: string, categoryIds?: string[], onlyEmpty?: boolean) => act(() => post(b.url(`/budget/${month}/quick`), { action, categoryIds, onlyEmpty }).then(r => { toast(r.changed ? `Updated ${r.changed} categor${r.changed === 1 ? 'y' : 'ies'}` : 'Nothing to change'); }));
  const Row = ({ label, value, strong }: { label: string; value: number; strong?: boolean }) => <div className={cx('flex justify-between py-0.5', strong ? 'border-t border-line pt-1.5 font-semibold' : 'text-ink-2')}><span>{label}</span><Money value={value} fmt={b.fmt} colored={strong} /></div>;
  const QuickBtn = ({ label, value, onClick }: { label: string; value?: number; onClick: () => void }) => <button onClick={onClick} className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-1.5 text-left text-[13px] hover:border-accent hover:bg-accent-soft"><span>{label}</span>{value !== undefined && <span className="num text-ink-2">{b.fmt(value)}</span>}</button>;
  if (!cat || !row) return <div className="space-y-5 p-5">
    <div><h3 className="text-[15px] font-semibold">{monthLabel(month)}</h3><p className="text-[12.5px] text-ink-3">Select a category to see details and quick-budget options.</p></div>
    <div className="text-[13px]"><Row label="Total budgeted" value={data.budgeted} /><Row label="Total activity" value={data.activity} /><Row label="Total in categories" value={data.totalAvailable} /><Row label="Available to Budget" value={data.availableToBudget} strong /></div>
    <div className="space-y-1.5"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Quick budget · whole month</div>
      <QuickBtn label="Copy last month’s budget (empty categories)" onClick={() => quick('budgeted_last_month', undefined, true)} /><QuickBtn label="Copy last month’s budget (all)" onClick={() => quick('budgeted_last_month')} />
      <QuickBtn label="Last month’s outflows (empty categories)" onClick={() => quick('outflows_last_month', undefined, true)} /><QuickBtn label="Average outflows, last 3 months (empty)" onClick={() => quick('average_outflows_3', undefined, true)} /></div>
    <NoteBox label={`Note for ${monthLabel(month)}`} value={data.note} onSave={note => act(() => put(b.url(`/budget/${month}/note`), { note }))} />
    <div className="flex flex-wrap gap-2"><Button size="sm" onClick={addGroup}><FolderPlus size={15} />Category group</Button>{hiddenCount > 0 && <Button size="sm" onClick={() => setShowHidden(s => !s)}>{showHidden ? 'Hide hidden' : `Show ${hiddenCount} hidden`}</Button>}</div>
  </div>;
  const amt = moveAmt.trim() ? b.parse(moveAmt) : null;
  return <div className="space-y-5 p-5">
    <div><div className="flex items-start justify-between gap-2"><h3 className="text-[15px] font-semibold leading-snug">{cat.name}</h3>{cat.hidden && <Badge>Hidden</Badge>}</div><p className="text-[12.5px] text-ink-3">{b.groupById.get(cat.groupId)?.name}</p></div>
    <div className="text-[13px]"><Row label="Carried from last month" value={row.carryIn} /><Row label="Budgeted this month" value={row.budgeted} />
      <div className="flex justify-between py-0.5 text-ink-2"><button className="hover:underline" onClick={() => onDrill({ categoryId: cat.id, title: `${cat.name} · ${monthLabel(month)}` })}>Activity this month →</button><Money value={row.activity} fmt={b.fmt} /></div><Row label="Available" value={row.available} strong />
      {row.available < 0 && <p className="mt-1.5 rounded-lg bg-neg-soft px-2.5 py-1.5 text-[12px] text-neg">{row.handling === 'confined' ? 'This negative balance carries into next month in the same category.' : `Overspent. ${b.fmt(-row.available)} will be taken from next month’s Available to Budget.`}</p>}</div>
    <div className="md:hidden"><Field label="Budgeted this month"><MobileBudget value={row.budgeted} onCommit={v => setBudgeted(cat.id, v)} /></Field></div>
    <div className="space-y-1.5"><div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Quick budget</div>
      <QuickBtn label="Budgeted last month" value={prevRow?.budgeted ?? 0} onClick={() => setBudgeted(cat.id, prevRow?.budgeted ?? 0)} /><QuickBtn label="Outflows last month" value={Math.max(0, -(prevRow?.activity ?? 0))} onClick={() => setBudgeted(cat.id, Math.max(0, -(prevRow?.activity ?? 0)))} />
      <QuickBtn label="Average outflows (3 months)" onClick={() => quick('average_outflows_3', [cat.id])} /><QuickBtn label="Balance to 0,00" value={row.budgeted - row.available} onClick={() => setBudgeted(cat.id, row.budgeted - row.available)} /></div>
    <div><div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Move money to</div>
      <div className="flex gap-1.5"><div className="min-w-0 flex-1"><Combobox aria-label="Move to category" value={moveTo} placeholder="Category" options={b.categoryOptions.filter(o => !o.id.startsWith('income:') && o.id !== cat.id && !o.hidden)} onPick={o => setMoveTo(o?.id ?? null)} /></div>
        <Input aria-label="Amount to move" className="num h-8 w-24 text-right" placeholder={row.available > 0 ? b.fmt(row.available) : '0,00'} value={moveAmt} onChange={e => setMoveAmt(e.target.value)} inputMode="decimal" />
        <Button size="sm" className="h-8" disabled={!moveTo || !((amt ?? (row.available > 0 ? row.available : 0)) > 0)} onClick={() => act(() => post(b.url(`/budget/${month}/move`), { from: cat.id, to: moveTo, amount: amt ?? row.available })).then(() => { setMoveAmt(''); setMoveTo(null); })}>Move</Button></div></div>
    <NoteBox key={cat.id + month} label={`Note for ${monthLabel(month, true)}`} value={row.note} onSave={note => act(() => put(b.url(`/budget/${month}/categories/${cat.id}`), { note }))} />
    <NoteBox key={cat.id} label="Category note (all months)" value={cat.note} onSave={note => act(() => apiPatch(b.url(`/categories/${cat.id}`), { note }))} />
    <div className="flex flex-wrap gap-1.5 border-t border-line pt-4"><Button size="sm" onClick={() => onRename(cat)}>Rename</Button><Button size="sm" onClick={() => act(() => apiPatch(b.url(`/categories/${cat.id}`), { hidden: !cat.hidden }))}>{cat.hidden ? 'Unhide' : 'Hide'}</Button>
      <Button size="icon" title="Move up" aria-label="Move category up" onClick={() => reorder(cat, -1)}><ArrowUp size={15} /></Button><Button size="icon" title="Move down" aria-label="Move category down" onClick={() => reorder(cat, 1)}><ArrowDown size={15} /></Button>
      <Menu trigger={p => <Button ref={p.ref as any} size="sm" onClick={p.onClick}>Move to group</Button>} items={b.boot.groups.filter(g => g.id !== cat.groupId).map(g => ({ label: g.name, onClick: () => act(() => apiPatch(b.url(`/categories/${cat.id}`), { groupId: g.id })) }))} />
      <Button size="icon" variant="ghost" className="text-neg" title="Delete category" aria-label="Delete category" onClick={() => onDelete(cat)}><Trash2 size={15} /></Button></div>
  </div>;
}
function MobileBudget({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const b = useBudget(); const [t, setT] = useState<string | null>(null);
  const commit = () => { if (t === null) return; const v = t.trim() ? b.parse(t) : 0; if (v === null) toast('Not a valid amount', 'error'); else onCommit(v); setT(null); };
  return <Input className="num h-11 text-right text-lg" inputMode="decimal" value={t ?? (value ? b.fmt(value) : '')} placeholder="0,00" onFocus={e => e.target.select()} onChange={e => setT(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}
function NoteBox({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [t, setT] = useState(value); useEffect(() => setT(value), [value]);
  return <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</span>
    <textarea value={t} onChange={e => setT(e.target.value)} onBlur={() => { if (t !== value) onSave(t); }} rows={2} placeholder="Add a note…" className="w-full resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] placeholder:text-ink-3 focus:border-accent focus:outline-none" /></label>;
}
export function PromptDialog({ title, label, initial, onRun, onClose }: { title: string; label: string; initial?: string; onRun: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(initial ?? '');
  return <Dialog open onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onRun(v.trim())}>Save</Button></>}>
    <Field label={label}><Input value={v} onChange={e => setV(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onRun(v.trim()); }} /></Field></Dialog>;
}
function DeleteCategoryDialog({ cat, onClose, onDone }: { cat: Category; onClose: () => void; onDone: () => void }) {
  const b = useBudget(); const [to, setTo] = useState<string | null>(null), [needs, setNeeds] = useState(false);
  const run = async () => { try { await post(b.url(`/categories/${cat.id}/delete`), { reassignTo: to }); b.refresh(); toast(`Deleted ${cat.name}`); onDone(); } catch (e: any) { if (e.code === 'CATEGORY_IN_USE') setNeeds(true); else toast(e.message, 'error'); } };
  return <Dialog open onClose={onClose} title={`Delete “${cat.name}”?`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={needs && !to} onClick={run}>Delete category</Button></>}>
    {!needs ? <p className="text-ink-2">If this category has transactions or budgeted money you will be asked where to move them. Tip: hiding keeps history untouched.</p>
      : <div className="space-y-3"><p className="text-ink-2">This category has transactions or budgeted amounts. Choose the category that should take over its history. Totals and Available to Budget stay the same.</p>
        <Combobox aria-label="Move history to" autoFocus value={to} placeholder="Move everything to…" options={b.categoryOptions.filter(o => !o.id.startsWith('income:') && o.id !== cat.id)} onPick={o => setTo(o?.id ?? null)} /></div>}
  </Dialog>;
}
/** Drill-down: the actual transactions behind a number. */
export function DrillDialog({ month, categoryId, uncategorized, title, from, to, onClose }: { month?: string; categoryId?: string; uncategorized?: boolean; title: string; from?: string; to?: string; onClose: () => void }) {
  const b = useBudget(); const f = from ?? `${month}-01`, t = to ?? `${month}-31`;
  const q = useQuery({ queryKey: ['b', b.bid, 'aux', 'drill', categoryId, uncategorized, f, t], queryFn: () => get<Txn[]>(b.url(`/transactions?from=${f}&to=${t}${categoryId ? `&categoryId=${categoryId}` : ''}${uncategorized ? '&uncategorized=1' : ''}`)) });
  const list = q.data ?? [];
  const amountFor = (x: Txn) => categoryId && x.splits.length ? x.splits.filter(s => s.categoryId === categoryId).reduce((s, k) => s + k.amount, 0) : x.amount;
  return <Dialog open onClose={onClose} title={title} wide>
    {q.isLoading ? <p className="text-ink-3">Loading…</p> : !list.length ? <p className="text-ink-2">No transactions.</p> : <table className="w-full text-[13px]"><tbody>
      {list.map(x => <tr key={x.id} className="cursor-pointer border-b border-line/70 hover:bg-sunken" onClick={() => { onClose(); go(`accounts/${x.accountId}/t/${x.id}`); }}>
        <td className="num whitespace-nowrap py-1.5 pr-3 text-ink-2">{b.date(x.date)}</td><td className="py-1.5 pr-3 text-ink-3">{b.accountById.get(x.accountId)?.name}</td><td className="py-1.5 pr-3">{x.payeeName}{x.splits.length > 0 && <span className="text-ink-3"> (split)</span>}</td>
        <td className="max-w-[12rem] truncate py-1.5 pr-3 text-ink-3">{x.memo}</td><td className="py-1.5 text-right"><Money value={amountFor(x)} fmt={b.fmt} colored /></td></tr>)}
      <tr><td colSpan={4} className="py-2 text-right font-semibold">Total</td><td className="py-2 text-right font-semibold"><Money value={list.reduce((s, x) => s + amountFor(x), 0)} fmt={b.fmt} /></td></tr></tbody></table>}
  </Dialog>;
}
