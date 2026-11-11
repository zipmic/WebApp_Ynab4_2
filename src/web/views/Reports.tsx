import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { BarList, ChartCard, ColumnChart, LineChart, OTHER, SERIES, type Series } from '../components/charts';
import { Button, Combobox, cx, Input, Menu, Money, Select } from '../components/ui';
import { get } from '../lib/api';
import { downloadText, MONTHS, useBudget } from '../lib/store';
import { addMonths, daysInMonth, monthOf, monthRange } from '../../shared/dates';
import { toCsv } from '../../shared/csv';
import { minorToPlain } from '../../shared/money';
import { DrillDialog } from './BudgetView';

const TABS = [['spending', 'Spending by category'], ['trend', 'Spending over time'], ['income', 'Income vs. expenses'], ['networth', 'Net worth'], ['balances', 'Account balances'], ['category', 'Category over time'], ['budget', 'Budget vs. actual']] as const;
type Tab = (typeof TABS)[number][0];
const short = (m: string) => `${MONTHS[+m.slice(5) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const lastDay = (m: string) => `${m}-${String(daysInMonth(+m.slice(0, 4), +m.slice(5))).padStart(2, '0')}`;

export default function Reports() {
  const b = useBudget(); const now = monthOf(b.boot.today);
  const [tab, setTab] = useState<Tab>('spending'), [from, setFrom] = useState(addMonths(now, -11)), [to, setTo] = useState(now);
  const [accountIds, setAccountIds] = useState<string[]>([]), [groupId, setGroupId] = useState(''), [categoryId, setCategoryId] = useState<string | null>(null), [level, setLevel] = useState<'category' | 'group'>('category');
  const [drill, setDrill] = useState<{ categoryId: string; title: string; from: string; to: string } | null>(null);
  const valid = /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) && from <= to;
  const months = useMemo(() => (valid ? monthRange(from, to) : []), [from, to, valid]);
  const act = useQuery({ enabled: valid, queryKey: ['b', b.bid, 'aux', 'r-activity', from, to, accountIds.join(',')], queryFn: () => get<{ month: string; categoryId: string; amount: number; count: number }[]>(b.url(`/reports/activity?from=${from}-01&to=${lastDay(to)}${accountIds.length ? `&accountIds=${accountIds.join(',')}` : ''}`)), placeholderData: p => p });
  const bal = useQuery({ enabled: tab === 'networth' || tab === 'balances', queryKey: ['b', b.bid, 'aux', 'r-balances'], queryFn: () => get<{ accountId: string; month: string; amount: number }[]>(b.url('/reports/balances')) });
  const bud = useQuery({ enabled: tab === 'budget' && valid, queryKey: ['b', b.bid, 'aux', 'r-budget', from, to], queryFn: () => get<{ month: string; categoryId: string; budgeted: number; activity: number; available: number }[]>(b.url(`/reports/budget?from=${from}&to=${to}`)) });
  const inScope = (cid: string) => { const c = b.categoryById.get(cid); if (!c) return false; return (!groupId || c.groupId === groupId) && (!categoryId || cid === categoryId); };
  const rows = useMemo(() => (act.data ?? []).filter(r => !r.categoryId.startsWith('income:') && inScope(r.categoryId)), [act.data, groupId, categoryId, b.categoryById]); // eslint-disable-line
  const preset = (k: string) => { const y = +now.slice(0, 4); if (k === 'ytd') { setFrom(`${y}-01`); setTo(now); } else if (k === '12') { setFrom(addMonths(now, -11)); setTo(now); } else if (k === 'last') { setFrom(`${y - 1}-01`); setTo(`${y - 1}-12`); } else if (k === '3') { setFrom(addMonths(now, -2)); setTo(now); } else { setFrom(b.boot.range.first <= now ? b.boot.range.first : now); setTo(now); } };
  const csv = (name: string, table: (string | number)[][]) => downloadText(`${name} ${from} to ${to}.csv`, '﻿' + toCsv(table));
  const Export = ({ name, table }: { name: string; table: (string | number)[][] }) => <Button size="sm" onClick={() => csv(name, table)}><Download size={14} />CSV</Button>;
  const money = (n: number) => minorToPlain(n);

  let body: ReactNode = null;
  if (tab === 'spending') {
    const totals = new Map<string, number>(); for (const r of rows) { const k = level === 'group' ? b.categoryById.get(r.categoryId)!.groupId : r.categoryId; totals.set(k, (totals.get(k) ?? 0) - r.amount); }
    const items = [...totals.entries()].map(([id, value]) => ({ id, value, label: level === 'group' ? b.groupById.get(id)?.name ?? '' : b.categoryById.get(id)?.name ?? '', sub: level === 'group' ? undefined : b.groupById.get(b.categoryById.get(id)!.groupId)?.name })).filter(i => i.value !== 0).sort((a, c) => c.value - a.value);
    const total = items.reduce((s, i) => s + i.value, 0);
    body = <ChartCard title="Spending by category" subtitle={<>Total <b className="num text-ink">{b.fmt(total)}</b> · {months.length} month{months.length === 1 ? '' : 's'} · average <span className="num">{b.fmt(Math.round(total / Math.max(1, months.length)))}</span> per month. Refunds reduce spending. {level === 'category' && 'Click a bar to see the transactions.'}</>}
      actions={<div className="flex gap-2"><Select aria-label="Level" className="h-7 text-[13px]" value={level} onChange={v => setLevel(v as any)} options={[{ value: 'category', label: 'By category' }, { value: 'group', label: 'By group' }]} /><Export name="Spending by category" table={[['Category', 'Group', 'Spending', 'Share %'], ...items.map(i => [i.label, i.sub ?? '', money(i.value), total ? ((i.value / total) * 100).toFixed(1) : '0'])]} /></div>}>
      {items.length ? <BarList items={items.map(i => ({ ...i, value: Math.max(0, i.value) }))} fmt={b.fmt} onPick={level === 'category' ? id => setDrill({ categoryId: id, title: `${b.categoryById.get(id)?.name} · ${short(from)} – ${short(to)}`, from: `${from}-01`, to: lastDay(to) }) : id => { setGroupId(id); setLevel('category'); }} /> : <NoData />}</ChartCard>;
  } else if (tab === 'trend') {
    const byGroup = new Map<string, number[]>(); for (const r of rows) { const g = b.categoryById.get(r.categoryId)!.groupId; const arr = byGroup.get(g) ?? byGroup.set(g, months.map(() => 0)).get(g)!; arr[months.indexOf(r.month)] -= r.amount; }
    // colour follows the group's position in the budget, not its rank, so a filter never repaints the others
    const order = b.boot.groups.filter(g => byGroup.has(g.id)); const keep = order.slice(0, 7), rest = order.slice(7);
    const series: Series[] = keep.map(g => ({ name: g.name, color: SERIES[b.boot.groups.indexOf(g) % 8 < 8 && b.boot.groups.indexOf(g) < 8 ? b.boot.groups.indexOf(g) : 7], values: byGroup.get(g.id)!.map(v => Math.max(0, v)) }));
    if (rest.length) series.push({ name: 'Other', color: OTHER, values: months.map((_, i) => rest.reduce((s, g) => s + Math.max(0, byGroup.get(g.id)![i]), 0)) });
    body = <ChartCard title="Spending over time" subtitle="Monthly spending by category group." actions={<Export name="Spending over time" table={[['Month', ...series.map(s => s.name), 'Total'], ...months.map((m, i) => [m, ...series.map(s => money(s.values[i])), money(series.reduce((s, x) => s + x.values[i], 0))])]} />}>
      {series.length ? <><ColumnChart labels={months.map(short)} series={series} fmt={b.fmt} /><DataTable head={['Month', ...series.map(s => s.name), 'Total']} rows={months.map((m, i) => [short(m), ...series.map(s => s.values[i]), series.reduce((s, x) => s + x.values[i], 0)])} fmt={b.fmt} /></> : <NoData />}</ChartCard>;
  } else if (tab === 'income') {
    const income = months.map(() => 0), expense = months.map(() => 0);
    for (const r of act.data ?? []) { const i = months.indexOf(r.month); if (i < 0) continue; if (r.categoryId.startsWith('income:')) income[i] += r.amount; else if (inScope(r.categoryId)) expense[i] -= r.amount; }
    const ti = income.reduce((s, v) => s + v, 0), te = expense.reduce((s, v) => s + v, 0);
    body = <ChartCard title="Income vs. expenses" subtitle={<>Income <b className="num text-ink">{b.fmt(ti)}</b> · Expenses <b className="num text-ink">{b.fmt(te)}</b> · Net <Money value={ti - te} fmt={b.fmt} colored className="font-semibold" />. Income is counted in the month it was received.</>}
      actions={<Export name="Income vs expenses" table={[['Month', 'Income', 'Expenses', 'Net'], ...months.map((m, i) => [m, money(income[i]), money(expense[i]), money(income[i] - expense[i])])]} />}>
      <ColumnChart mode="grouped" labels={months.map(short)} series={[{ name: 'Income', color: SERIES[0], values: income }, { name: 'Expenses', color: SERIES[1], values: expense }]} fmt={b.fmt} />
      <DataTable head={['Month', 'Income', 'Expenses', 'Net']} rows={months.map((m, i) => [short(m), income[i], expense[i], income[i] - expense[i]])} fmt={b.fmt} colorLast /></ChartCard>;
  } else if (tab === 'networth' || tab === 'balances') {
    const accounts = b.boot.accounts.filter(a => !accountIds.length || accountIds.includes(a.id));
    const per = new Map<string, Map<string, number>>(); for (const r of bal.data ?? []) (per.get(r.accountId) ?? per.set(r.accountId, new Map()).get(r.accountId)!).set(r.month, r.amount);
    const lines = accounts.map(a => { const mm = per.get(a.id) ?? new Map<string, number>(); let run = 0; for (const [m, v] of mm) if (m < from) run += v; return { a, values: months.map(m => (run += mm.get(m) ?? 0)) }; });
    if (tab === 'networth') {
      const assets = months.map((_, i) => lines.reduce((s, l) => s + Math.max(0, l.values[i]), 0)), debts = months.map((_, i) => lines.reduce((s, l) => s + Math.min(0, l.values[i]), 0)), net = months.map((_, i) => assets[i] + debts[i]);
      body = <ChartCard title="Net worth" subtitle={<>End of {short(to)}: <Money value={net[net.length - 1] ?? 0} fmt={b.fmt} colored className="font-semibold" /> · change over the period <Money value={(net[net.length - 1] ?? 0) - (net[0] ?? 0)} fmt={b.fmt} colored />. Month-end balances of all selected accounts, budget and tracking.</>}
        actions={<Export name="Net worth" table={[['Month', 'Assets', 'Debts', 'Net worth'], ...months.map((m, i) => [m, money(assets[i]), money(debts[i]), money(net[i])])]} />}>
        <LineChart labels={months.map(short)} series={[{ name: 'Net worth', color: SERIES[0], values: net }, { name: 'Assets', color: SERIES[2], values: assets }, { name: 'Debts', color: SERIES[1], values: debts }]} fmt={b.fmt} />
        <DataTable head={['Month', 'Assets', 'Debts', 'Net worth']} rows={months.map((m, i) => [short(m), assets[i], debts[i], net[i]])} fmt={b.fmt} colorLast /></ChartCard>;
    } else {
      const shown = lines.slice(0, 8);
      body = <ChartCard title="Account balance history" subtitle={lines.length > 8 ? 'Showing the first 8 accounts — use the account filter to choose others.' : 'Month-end balance of each account.'} actions={<Export name="Account balances" table={[['Month', ...lines.map(l => l.a.name)], ...months.map((m, i) => [m, ...lines.map(l => money(l.values[i]))])]} />}>
        <LineChart labels={months.map(short)} series={shown.map(l => ({ name: l.a.name, color: SERIES[b.boot.accounts.indexOf(l.a) % 8], values: l.values }))} fmt={b.fmt} height={300} />
        <DataTable head={['Month', ...shown.map(l => l.a.name)]} rows={months.map((m, i) => [short(m), ...shown.map(l => l.values[i])])} fmt={b.fmt} /></ChartCard>;
    }
  } else if (tab === 'category') {
    const cid = categoryId; const vals = months.map(() => 0); if (cid) for (const r of act.data ?? []) if (r.categoryId === cid) vals[months.indexOf(r.month)] -= r.amount;
    const total = vals.reduce((s, v) => s + v, 0);
    body = <ChartCard title="Category activity over time" subtitle={cid ? <>{b.categoryLabel(cid)} · total <b className="num text-ink">{b.fmt(total)}</b> · average <span className="num">{b.fmt(Math.round(total / Math.max(1, months.length)))}</span> per month. Click a bar for the transactions.</> : 'Choose a category in the filter row above.'}
      actions={cid ? <Export name={`Category ${b.categoryById.get(cid)?.name}`} table={[['Month', 'Spending'], ...months.map((m, i) => [m, money(vals[i])])]} /> : undefined}>
      {cid ? <><ColumnChart labels={months.map(short)} series={[{ name: b.categoryById.get(cid)?.name ?? '', color: SERIES[0], values: vals }]} fmt={b.fmt} onPick={i => setDrill({ categoryId: cid, title: `${b.categoryById.get(cid)?.name} · ${short(months[i])}`, from: `${months[i]}-01`, to: lastDay(months[i]) })} />
        <DataTable head={['Month', 'Spending']} rows={months.map((m, i) => [short(m), vals[i]])} fmt={b.fmt} /></> : <NoData text="No category selected." />}</ChartCard>;
  } else if (tab === 'budget') {
    const agg = new Map<string, { budgeted: number; activity: number }>(); for (const r of bud.data ?? []) { if (!inScope(r.categoryId)) continue; const a = agg.get(r.categoryId) ?? agg.set(r.categoryId, { budgeted: 0, activity: 0 }).get(r.categoryId)!; a.budgeted += r.budgeted; a.activity += r.activity; }
    const list = b.boot.categories.filter(c => agg.has(c.id)).map(c => ({ c, ...agg.get(c.id)!, spent: -agg.get(c.id)!.activity })).filter(x => x.budgeted || x.spent);
    const max = Math.max(1, ...list.flatMap(x => [x.budgeted, x.spent])); const tb = list.reduce((s, x) => s + x.budgeted, 0), ts = list.reduce((s, x) => s + x.spent, 0);
    body = <ChartCard title="Budget vs. actual" subtitle={<>Budgeted <b className="num text-ink">{b.fmt(tb)}</b> · Spent <b className="num text-ink">{b.fmt(ts)}</b> · Difference <Money value={tb - ts} fmt={b.fmt} colored className="font-semibold" /> over {months.length} month{months.length === 1 ? '' : 's'}.</>}
      actions={<Export name="Budget vs actual" table={[['Group', 'Category', 'Budgeted', 'Spent', 'Difference'], ...list.map(x => [b.groupById.get(x.c.groupId)?.name ?? '', x.c.name, money(x.budgeted), money(x.spent), money(x.budgeted - x.spent)])]} />}>
      {list.length ? <><div className="mb-2 flex gap-4 text-[12.5px] text-ink-2"><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: OTHER }} />Budgeted</span><span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[0] }} />Spent</span></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-[13px]"><thead className="text-left text-[11px] uppercase tracking-wide text-ink-3"><tr><th className="pb-1.5">Category</th><th className="w-[38%]" /><th className="text-right">Budgeted</th><th className="text-right">Spent</th><th className="text-right">Difference</th></tr></thead><tbody>
          {list.map(x => <tr key={x.c.id} className="cursor-pointer border-t border-line/70 hover:bg-sunken" onClick={() => setDrill({ categoryId: x.c.id, title: `${x.c.name} · ${short(from)} – ${short(to)}`, from: `${from}-01`, to: lastDay(to) })}>
            <td className="py-1.5 pr-3">{x.c.name}<span className="text-ink-3"> · {b.groupById.get(x.c.groupId)?.name}</span></td>
            <td className="pr-3"><div className="space-y-[2px]"><div className="h-1.5 rounded-r" style={{ width: `${Math.max(0, x.budgeted / max) * 100}%`, background: OTHER }} /><div className="h-1.5 rounded-r" style={{ width: `${Math.max(0, x.spent / max) * 100}%`, background: SERIES[0] }} /></div></td>
            <td className="num text-right">{b.fmt(x.budgeted)}</td><td className="num text-right">{b.fmt(x.spent)}</td><td className="text-right"><Money value={x.budgeted - x.spent} fmt={b.fmt} colored /></td></tr>)}</tbody></table></div></> : <NoData />}</ChartCard>;
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="border-b border-line bg-surface px-4 pt-3 md:px-6"><h1 className="text-[17px] font-semibold tracking-tight">Reports</h1>
      <div className="-mb-px mt-2 flex gap-1 overflow-x-auto" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px]', tab === k ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink')}>{l}</button>)}</div></header>
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-bg px-4 py-2.5 md:px-6">
      <Select aria-label="Period preset" className="h-8 text-[13px]" value="" onChange={preset} options={[{ value: '', label: 'Period…' }, { value: '3', label: 'Last 3 months' }, { value: '12', label: 'Last 12 months' }, { value: 'ytd', label: 'This year' }, { value: 'last', label: 'Last year' }, { value: 'all', label: 'All time' }]} />
      <Input type="month" aria-label="From month" className="h-8 w-[9.5rem]" value={from} onChange={e => setFrom(e.target.value)} /><span className="text-ink-3">–</span><Input type="month" aria-label="To month" className="h-8 w-[9.5rem]" value={to} onChange={e => setTo(e.target.value)} />
      <Menu align="start" trigger={p => <Button ref={p.ref as any} size="sm" className="h-8" onClick={p.onClick}>{accountIds.length ? `${accountIds.length} account${accountIds.length === 1 ? '' : 's'}` : 'All accounts'}</Button>}
        items={[{ label: 'All accounts', onClick: () => setAccountIds([]) }, 'sep', ...b.boot.accounts.map(a => ({ label: `${accountIds.includes(a.id) ? '☑' : '☐'} ${a.name}`, onClick: () => setAccountIds(l => (l.includes(a.id) ? l.filter(x => x !== a.id) : [...l, a.id])) }))]} />
      {tab !== 'networth' && tab !== 'balances' && <><Select aria-label="Category group" className="h-8 text-[13px]" value={groupId} onChange={v => { setGroupId(v); setCategoryId(null); }} options={[{ value: '', label: 'All groups' }, ...b.boot.groups.map(g => ({ value: g.id, label: g.name }))]} />
        <div className="w-52"><Combobox aria-label="Category" value={categoryId} placeholder="All categories" options={b.categoryOptions.filter(o => !o.id.startsWith('income:') && (!groupId || b.categoryById.get(o.id)?.groupId === groupId))} onPick={o => setCategoryId(o?.id ?? null)} /></div></>}
      {!valid && <span className="text-[12.5px] text-neg">Choose a valid period.</span>}</div>
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">{act.isLoading ? <p className="text-ink-3">Loading…</p> : body}</div>
    {drill && <DrillDialog {...drill} onClose={() => setDrill(null)} />}
  </div>;
}
const NoData = ({ text = 'No data for this period and filter.' }: { text?: string }) => <p className="py-10 text-center text-ink-3">{text}</p>;
function DataTable({ head, rows, fmt, colorLast }: { head: string[]; rows: (string | number)[][]; fmt: (n: number) => string; colorLast?: boolean }) {
  return <details className="mt-4"><summary className="cursor-pointer text-[13px] text-accent">Show as table</summary><div className="mt-2 max-h-80 overflow-auto rounded-xl border border-line"><table className="w-full text-[12.5px]"><thead className="sticky top-0 bg-sunken"><tr>{head.map((h, i) => <th key={h} className={cx('px-3 py-1.5 font-semibold', i ? 'text-right' : 'text-left')}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line/70">{r.map((c, j) => <td key={j} className={cx('px-3 py-1', j && 'num text-right', colorLast && j === r.length - 1 && typeof c === 'number' && (c < 0 ? 'text-neg' : 'text-pos'))}>{typeof c === 'number' ? fmt(c) : c}</td>)}</tr>)}</tbody></table></div></details>;
}
