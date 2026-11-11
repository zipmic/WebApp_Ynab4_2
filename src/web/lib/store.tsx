import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { formatMinor, parseAmountInput, type MoneyFormat } from '../../shared/money';
import type { Account, BudgetSettings, Category, CategoryGroup, Payee, Txn, TxnChange } from '../../shared/types';
import { ApiError, get, post } from './api';

// ------------------------------------------------------------------ hash router
const subscribe = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
export function useRoute(): string[] { const h = useSyncExternalStore(subscribe, () => window.location.hash); return h.replace(/^#\/?/, '').split('/').filter(Boolean); }
export const go = (path: string) => { window.location.hash = '#/' + path.replace(/^\//, ''); };

// ------------------------------------------------------------------ toasts
export interface Toast { id: number; kind: 'info' | 'error' | 'success'; text: string; action?: { label: string; run: () => void } }
let toasts: Toast[] = []; const listeners = new Set<() => void>(); let nextId = 1;
const emit = () => listeners.forEach(l => l());
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const t = { id: nextId++, kind, text, action }; toasts = [...toasts.slice(-3), t]; emit();
  setTimeout(() => { toasts = toasts.filter(x => x.id !== t.id); emit(); }, kind === 'error' ? 8000 : 4500);
}
export const toastError = (e: unknown) => toast(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong', 'error');
export function useToasts() { return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => toasts); }
export const dismissToast = (id: number) => { toasts = toasts.filter(t => t.id !== id); emit(); };

// ------------------------------------------------------------------ theme
export type Theme = 'light' | 'dark' | 'system';
export function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark); localStorage.setItem('br-theme', t);
}
export const currentTheme = (): Theme => (localStorage.getItem('br-theme') as Theme) || 'system';

export function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return m;
}
export const useIsMobile = () => useMedia('(max-width: 767px)');

// ------------------------------------------------------------------ budget context
export interface Bootstrap {
  id: string; settings: BudgetSettings; accounts: Account[]; groups: CategoryGroup[]; categories: Category[]; payees: Payee[];
  undo: { undo: string | null; redo: string | null }; range: { first: string; last: string }; scheduledPosted: number; today: string; lastImport: string | null;
}
export interface CategoryOption { id: string; label: string; group: string; hidden: boolean }
interface Ctx {
  bid: string; boot: Bootstrap; fmt: (n: number, symbol?: boolean) => string; parse: (s: string) => number | null; date: (iso: string) => string;
  accountById: Map<string, Account>; categoryById: Map<string, Category>; groupById: Map<string, CategoryGroup>; payeeById: Map<string, Payee>;
  categoryLabel: (id: string | null) => string; categoryOptions: CategoryOption[];
  url: (p: string) => string; refresh: () => void; applyChange: (c: TxnChange) => void; mutate: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  undo: () => void; redo: () => void;
}
const BudgetCtx = createContext<Ctx | null>(null);
export const useBudget = () => { const c = useContext(BudgetCtx); if (!c) throw new Error('No budget open'); return c; };

export function formatDate(iso: string, f: BudgetSettings['dateFormat']): string {
  const [y, m, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
  return f.replace('YYYY', y).replace('MM', m).replace('DD', d);
}
export const INCOME_OPTIONS: CategoryOption[] = [
  { id: 'income:this', label: 'Income for this month', group: 'Income', hidden: false }, { id: 'income:next', label: 'Income for next month', group: 'Income', hidden: false }];

function patchTxCaches(qc: QueryClient, bid: string, c: TxnChange) {
  const gone = new Set([...c.deleted, ...c.changed.map(t => t.id)]);
  for (const [key, data] of qc.getQueriesData<Txn[]>({ queryKey: ['b', bid, 'tx'] })) {
    if (!data) continue; const scope = key[3] as string;
    const next = data.filter(t => !gone.has(t.id)).concat(c.changed.filter(t => scope === 'all' || t.accountId === scope));
    next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
    qc.setQueryData(key, next);
  }
}

export function BudgetProvider({ bid, children, fallback }: { bid: string; children: ReactNode; fallback: (error: unknown) => ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['b', bid, 'bootstrap'], queryFn: () => get<Bootstrap>(`/b/${bid}/bootstrap`), staleTime: 15_000 });
  const refresh = useCallback(() => { qc.invalidateQueries({ queryKey: ['b', bid, 'bootstrap'] }); qc.invalidateQueries({ queryKey: ['b', bid, 'budget'] }); qc.invalidateQueries({ queryKey: ['b', bid, 'aux'] }); }, [qc, bid]);
  const boot = q.data;
  const value = useMemo<Ctx | null>(() => {
    if (!boot) return null;
    const f: MoneyFormat = boot.settings.format;
    const accountById = new Map(boot.accounts.map(a => [a.id, a])), categoryById = new Map(boot.categories.map(c => [c.id, c])), groupById = new Map(boot.groups.map(g => [g.id, g])), payeeById = new Map(boot.payees.map(p => [p.id, p]));
    const categoryOptions: CategoryOption[] = [...INCOME_OPTIONS, ...boot.categories.map(c => ({ id: c.id, label: c.name, group: groupById.get(c.groupId)?.name ?? '', hidden: c.hidden || !!groupById.get(c.groupId)?.hidden }))];
    const applyChange = (c: TxnChange) => { patchTxCaches(qc, bid, c); refresh(); };
    const mutate = async <T,>(fn: () => Promise<T>) => { try { const r = await fn(); refresh(); return r; } catch (e) { toastError(e); return undefined; } };
    const replay = (kind: 'undo' | 'redo') => async () => {
      try { const r = await post(`/b/${bid}/${kind}`); if (r.label) { toast(`${kind === 'undo' ? 'Undid' : 'Redid'}: ${r.label}`); qc.invalidateQueries({ queryKey: ['b', bid] }); } else toast(`Nothing to ${kind}`); } catch (e) { toastError(e); }
    };
    return { bid, boot, fmt: (n, symbol) => formatMinor(n, f, symbol), parse: s => parseAmountInput(s, f), date: iso => formatDate(iso, boot.settings.dateFormat),
      accountById, categoryById, groupById, payeeById, categoryOptions,
      categoryLabel: id => (!id ? '' : id === 'income:this' ? 'Income for this month' : id === 'income:next' ? 'Income for next month' : (() => { const c = categoryById.get(id); return c ? `${groupById.get(c.groupId)?.name ?? ''}: ${c.name}` : ''; })()),
      url: p => `/b/${bid}${p}`, refresh, applyChange, mutate, undo: replay('undo'), redo: replay('redo') };
  }, [boot, bid, qc, refresh]);
  if (q.error) return <>{fallback(q.error)}</>;
  if (!value) return <div className="flex h-full items-center justify-center text-ink-3">Opening budget…</div>;
  return <BudgetCtx.Provider value={value}>{children}</BudgetCtx.Provider>;
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (m: string, short = false) => `${short ? MONTHS[+m.slice(5) - 1].slice(0, 3) : MONTHS[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
export function download(url: string) { const a = document.createElement('a'); a.href = '/api' + url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8') {
  const u = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
}
