import { BarChart3, CalendarClock, ChevronsLeft, ChevronsRight, ChevronsUpDown, Landmark, LayoutList, MoreHorizontal, Plus, Redo2, ScanLine, Settings as SettingsIcon, Undo2, Wallet } from 'lucide-react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { BudgetInfo, Status } from '../App';
import { Button, cx, Dialog, Field, Input, Menu, Money, Select } from '../components/ui';
import { patch, post } from '../lib/api';
import { go, toast, useBudget, useIsMobile, useRoute } from '../lib/store';
import { ACCOUNT_TYPES, type Account } from '../../shared/types';
import { todayISO } from '../../shared/dates';
import { Logo } from './Auth';
import { BudgetView } from './BudgetView';
import { RegisterView } from './RegisterView';

const Reports = lazy(() => import('./Reports'));
const ScheduledView = lazy(() => import('./Scheduled'));
const BankImport = lazy(() => import('./BankImport'));
const Settings = lazy(() => import('./Settings'));

export function Shell({ status, budgets, onSwitch }: { status: Status; budgets: BudgetInfo[]; onSwitch: (id: string | null, path?: string) => void }) {
  const b = useBudget(); const route = useRoute(); const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('br-side') === '1');
  const [accountDialog, setAccountDialog] = useState<Account | 'new' | null>(null); const [more, setMore] = useState(false);
  useEffect(() => { localStorage.setItem('br-side', collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => { if (!route.length) go('budget'); }, [route.length]);
  useEffect(() => { if (b.boot.scheduledPosted) toast(`${b.boot.scheduledPosted} scheduled transaction${b.boot.scheduledPosted === 1 ? ' was' : 's were'} entered`); }, [b.boot.scheduledPosted]);
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) b.redo(); else b.undo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); b.redo(); }
    };
    window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f);
  }, [b]);
  const page = route[0] ?? 'budget';
  const onBudget = b.boot.accounts.filter(a => a.onBudget && !a.closed), tracking = b.boot.accounts.filter(a => !a.onBudget && !a.closed), closed = b.boot.accounts.filter(a => a.closed);
  const sum = (l: Account[]) => l.reduce((s, a) => s + a.balance, 0);

  const NavItem = ({ to, icon, label, right, active }: { to: string; icon?: ReactNode; label: string; right?: ReactNode; active: boolean }) => (
    <a href={'#/' + to} title={collapsed ? label : undefined} aria-current={active ? 'page' : undefined}
      className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors', active ? 'bg-white/12 font-medium text-white' : 'text-side-ink hover:bg-side-hover hover:text-white', collapsed && 'justify-center px-0')}>
      {icon}{!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}{!collapsed && right}</a>);
  const AccountLinks = ({ title, list }: { title: string; list: Account[] }) => !list.length || collapsed ? null : (
    <div className="mt-4"><div className="flex items-center justify-between px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500"><span>{title}</span><span className="num">{b.fmt(sum(list))}</span></div>
      {list.map(a => <NavItem key={a.id} to={`accounts/${a.id}`} label={a.name} active={page === 'accounts' && route[1] === a.id}
        right={<span className={cx('num text-[12.5px]', a.balance < 0 ? 'text-red-300' : 'text-slate-400')}>{b.fmt(a.balance)}</span>} />)}</div>);

  let content: ReactNode;
  if (page === 'budget') content = <BudgetView month={route[1]} />;
  else if (page === 'accounts' && route[1]) content = <RegisterView key={route[1]} accountId={route[1] === 'all' ? null : route[1]} onEditAccount={a => setAccountDialog(a)} />;
  else if (page === 'accounts') content = <AccountList onAdd={() => setAccountDialog('new')} />;
  else if (page === 'reports') content = <Reports />;
  else if (page === 'scheduled') content = <ScheduledView />;
  else if (page === 'import') content = <BankImport visionConfigured={status.visionConfigured} />;
  else if (page === 'settings') content = <Settings status={status} budgets={budgets} onSwitch={onSwitch} />;
  else content = <BudgetView />;

  return (
    <div className="flex h-full">
      {!mobile && <aside className={cx('flex shrink-0 flex-col bg-side transition-[width] duration-150', collapsed ? 'w-[52px]' : 'w-[248px]')}>
        <div className={cx('flex h-14 items-center gap-2.5 px-3', collapsed && 'justify-center px-0')}>
          <Logo size={28} />
          {!collapsed && <Menu align="start" trigger={p => <button ref={p.ref} onClick={p.onClick} className="flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 py-1 text-left text-white hover:bg-side-hover"><span className="truncate text-[14px] font-semibold">{b.boot.settings.name}</span><ChevronsUpDown size={13} className="shrink-0 text-slate-500" /></button>}
            items={[...budgets.filter(x => x.id !== b.bid).map(x => ({ label: x.name, onClick: () => onSwitch(x.id) })), budgets.length > 1 && 'sep', { label: 'New, import or restore…', onClick: () => go('welcome') }]} />}
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <NavItem to="budget" icon={<LayoutList size={16} />} label="Budget" active={page === 'budget'} />
          <NavItem to="accounts/all" icon={<Landmark size={16} />} label="All Accounts" active={page === 'accounts' && route[1] === 'all'} />
          <NavItem to="reports" icon={<BarChart3 size={16} />} label="Reports" active={page === 'reports'} />
          <NavItem to="scheduled" icon={<CalendarClock size={16} />} label="Scheduled" active={page === 'scheduled'} />
          <NavItem to="import" icon={<ScanLine size={16} />} label="Import Transactions" active={page === 'import'} />
          <AccountLinks title="Budget accounts" list={onBudget} /><AccountLinks title="Tracking accounts" list={tracking} /><AccountLinks title="Closed" list={closed} />
          {!collapsed && <button onClick={() => setAccountDialog('new')} className="mt-3 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-slate-400 hover:bg-side-hover hover:text-white"><Plus size={15} />Add account</button>}
        </nav>
        <div className={cx('flex items-center gap-1 border-t border-white/10 p-2', collapsed && 'flex-col')}>
          <IconBtn title={b.boot.undo.undo ? `Undo: ${b.boot.undo.undo} (Ctrl+Z)` : 'Nothing to undo'} disabled={!b.boot.undo.undo} onClick={b.undo}><Undo2 size={16} /></IconBtn>
          <IconBtn title={b.boot.undo.redo ? `Redo: ${b.boot.undo.redo} (Ctrl+Y)` : 'Nothing to redo'} disabled={!b.boot.undo.redo} onClick={b.redo}><Redo2 size={16} /></IconBtn>
          <IconBtn title="Settings" onClick={() => go('settings')} active={page === 'settings'}><SettingsIcon size={16} /></IconBtn>
          <span className="flex-1" />
          <IconBtn title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed(c => !c)}>{collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}</IconBtn>
        </div>
      </aside>}
      <main className={cx('flex min-w-0 flex-1 flex-col', mobile && 'pb-[calc(56px+env(safe-area-inset-bottom))]')}><Suspense fallback={<div className="p-8 text-ink-3">Loading…</div>}>{content}</Suspense></main>
      {mobile && <nav className="safe-b fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur">
        <div className="grid h-14 grid-cols-5 items-center">
          <Tab to="budget" active={page === 'budget'} icon={<LayoutList size={20} />} label="Budget" />
          <Tab to="accounts" active={page === 'accounts'} icon={<Wallet size={20} />} label="Accounts" />
          <a href={`#/accounts/${page === 'accounts' && route[1] && route[1] !== 'all' ? route[1] : (onBudget[0]?.id ?? 'all')}/new`} aria-label="Add transaction" className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-accent text-accent-ink shadow-lg"><Plus size={22} /></a>
          <Tab to="reports" active={page === 'reports'} icon={<BarChart3 size={20} />} label="Reports" />
          <button onClick={() => setMore(true)} className={cx('flex flex-col items-center gap-0.5 text-[10.5px]', ['scheduled', 'import', 'settings'].includes(page) ? 'text-accent' : 'text-ink-3')}><MoreHorizontal size={20} />More</button>
        </div></nav>}
      <Dialog open={more} onClose={() => setMore(false)} title={b.boot.settings.name}>
        <div className="-mx-2 space-y-0.5" onClick={() => setMore(false)}>
          {[['scheduled', 'Scheduled transactions', <CalendarClock size={18} />], ['import', 'Import transactions', <ScanLine size={18} />], ['settings', 'Settings, backups & security', <SettingsIcon size={18} />], ['welcome', 'Switch, create or restore budget', <ChevronsUpDown size={18} />]].map(([to, label, icon]) => (
            <a key={to as string} href={`#/${to}`} className="flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] hover:bg-sunken">{icon as ReactNode}{label as string}</a>))}
          <div className="flex gap-2 px-2 pt-3"><Button className="flex-1" disabled={!b.boot.undo.undo} onClick={b.undo}><Undo2 size={16} />Undo</Button><Button className="flex-1" disabled={!b.boot.undo.redo} onClick={b.redo}><Redo2 size={16} />Redo</Button></div>
        </div>
      </Dialog>
      {accountDialog && <AccountDialog account={accountDialog === 'new' ? null : accountDialog} onClose={() => setAccountDialog(null)} />}
    </div>);
}
function IconBtn({ children, active, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return <button {...p} aria-label={p.title} className={cx('flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-side-hover hover:text-white disabled:opacity-30 disabled:hover:bg-transparent', active && 'bg-white/12 text-white')}>{children}</button>;
}
function Tab({ to, icon, label, active }: { to: string; icon: ReactNode; label: string; active: boolean }) {
  return <a href={'#/' + to} aria-current={active ? 'page' : undefined} className={cx('flex flex-col items-center gap-0.5 text-[10.5px]', active ? 'text-accent' : 'text-ink-3')}>{icon}{label}</a>;
}

/** Phone account overview: quick switching between accounts with balances. */
function AccountList({ onAdd }: { onAdd: () => void }) {
  const b = useBudget();
  const sections: [string, Account[]][] = [['Budget accounts', b.boot.accounts.filter(a => a.onBudget && !a.closed)], ['Tracking accounts', b.boot.accounts.filter(a => !a.onBudget && !a.closed)], ['Closed accounts', b.boot.accounts.filter(a => a.closed)]];
  return <div className="flex-1 overflow-y-auto">
    <header className="flex items-center justify-between px-4 pb-2 pt-4"><h1 className="text-xl font-semibold tracking-tight">Accounts</h1><Button size="sm" onClick={onAdd}><Plus size={15} />Add</Button></header>
    <a href="#/accounts/all" className="mx-4 mb-3 flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3.5"><span className="font-medium">All Accounts</span><Money value={b.boot.accounts.reduce((s, a) => s + a.balance, 0)} fmt={b.fmt} colored className="text-[15px] font-semibold" /></a>
    {sections.map(([title, list]) => list.length > 0 && <section key={title} className="mb-4 px-4"><div className="mb-1.5 flex justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-3"><span>{title}</span><span className="num">{b.fmt(list.reduce((s, a) => s + a.balance, 0))}</span></div>
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{list.map(a => <a key={a.id} href={`#/accounts/${a.id}`} className="flex items-center justify-between px-4 py-3.5 active:bg-sunken"><span><span className="block font-medium">{a.name}</span>
        <span className="text-[12px] text-ink-3">{ACCOUNT_TYPES.find(t => t.value === a.type)?.label}{a.unclearedBalance !== 0 && ` · ${b.fmt(a.unclearedBalance)} uncleared`}</span></span><Money value={a.balance} fmt={b.fmt} colored className="text-[15px] font-semibold" /></a>)}</div></section>)}
    {!b.boot.accounts.length && <p className="px-6 py-10 text-center text-ink-2">No accounts yet. Add the accounts you actually have — bank, cash, credit cards — with their balance today.</p>}
  </div>;
}

export function AccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const b = useBudget();
  const [name, setName] = useState(account?.name ?? ''), [type, setType] = useState<string>(account?.type ?? 'checking'), [onBudget, setOnBudget] = useState(account?.onBudget ?? true);
  const [balance, setBalance] = useState(''), [date, setDate] = useState(todayISO()), [note, setNote] = useState(account?.note ?? ''), [closed, setClosed] = useState(account?.closed ?? false);
  const liability = ACCOUNT_TYPES.find(t => t.value === type)?.liability;
  const parsed = balance.trim() ? b.parse(balance) : 0;
  const save = async () => {
    const ok = await b.mutate(async () => account
      ? patch(b.url(`/accounts/${account.id}`), { name, type, note, closed })
      : post(b.url('/accounts'), { name, type, onBudget, balance: liability && parsed! > 0 ? -parsed! : parsed, date, note }));
    if (ok) { onClose(); if (!account && (ok as any).id) go(`accounts/${(ok as any).id}`); }
  };
  return <Dialog open onClose={onClose} title={account ? 'Edit account' : 'Add account'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || parsed === null} onClick={save}>{account ? 'Save' : 'Add account'}</Button></>}>
    <div className="space-y-3.5">
      <Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} autoFocus /></Field>
      <Field label="Type"><Select className="w-full" value={type} onChange={v => { setType(v); if (!account) setOnBudget(ACCOUNT_TYPES.find(t => t.value === v)!.defaultOnBudget); }} options={ACCOUNT_TYPES.map(t => ({ value: t.value, label: t.label }))} /></Field>
      {!account && <>
        <div className="grid grid-cols-2 gap-3">
          <Field label={liability ? 'Amount owed today' : 'Current balance'} hint={parsed === null ? 'Not a valid amount' : undefined}><Input value={balance} onChange={e => setBalance(e.target.value)} inputMode="decimal" placeholder="0,00" className="num text-right" /></Field>
          <Field label="As of"><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field></div>
        <fieldset className="rounded-xl border border-line p-3"><legend className="px-1 text-[12px] font-medium text-ink-2">Budget or tracking?</legend>
          {[[true, 'Budget account', 'Money you spend from. Its balance is available to budget.'], [false, 'Tracking (off-budget) account', 'Investments, mortgage, assets. Counts towards net worth only.']].map(([v, t, d]) => (
            <label key={String(v)} className="flex cursor-pointer gap-2.5 py-1.5"><input type="radio" className="mt-1 accent-[var(--accent)]" checked={onBudget === v} onChange={() => setOnBudget(v as boolean)} /><span><span className="block font-medium">{t as string}</span><span className="text-[12.5px] text-ink-2">{d as string}</span></span></label>))}
          <p className="mt-1 text-[12px] text-ink-3">As in YNAB4, this cannot be changed once the account has transactions.</p></fieldset></>}
      <Field label="Notes"><Input value={note} onChange={e => setNote(e.target.value)} /></Field>
      {account && <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--accent)]" checked={closed} onChange={e => setClosed(e.target.checked)} />Closed (hidden from the sidebar, history is kept)</label>}
    </div>
  </Dialog>;
}
