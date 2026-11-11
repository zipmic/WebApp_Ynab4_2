import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { get, setCsrf, setUnauthenticatedHandler } from './lib/api';
import { BudgetProvider, go, useRoute } from './lib/store';
import { AuthScreen } from './views/Auth';
import { Shell } from './views/Shell';
import { Welcome } from './views/Welcome';
import { Button, Empty } from './components/ui';

const Ynab4Import = lazy(() => import('./views/Ynab4Import'));
export interface Status { setupRequired: boolean; setupNeedsToken: boolean; authenticated: boolean; csrf: string | null; passkeyLogin: boolean; visionConfigured: boolean;
  user: { username: string; totpEnabled: boolean; passkeys: number } | null }
export interface BudgetInfo { id: string; name: string; createdAt: string; lastOpened: string | null }

export function App() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['status'], queryFn: () => get<Status>('/auth/status'), staleTime: 0 });
  useEffect(() => { setUnauthenticatedHandler(() => qc.invalidateQueries({ queryKey: ['status'] })); }, [qc]);
  if (status.data) setCsrf(status.data.csrf);
  if (status.isLoading) return <div className="flex h-full items-center justify-center text-ink-3">Loading…</div>;
  if (status.error || !status.data) return <Empty title="Cannot reach the server" action={<Button onClick={() => status.refetch()}>Try again</Button>}>Budget Reborn stores your data on your own server. Check that it is running and that you are connected to it.</Empty>;
  if (!status.data.authenticated) return <AuthScreen status={status.data} onDone={() => { qc.clear(); status.refetch(); }} />;
  return <Signed status={status.data} />;
}

function Signed({ status }: { status: Status }) {
  const qc = useQueryClient(); const route = useRoute();
  const budgets = useQuery({ queryKey: ['budgets'], queryFn: () => get<BudgetInfo[]>('/budgets') });
  const [bid, setBidState] = useState<string | null>(() => localStorage.getItem('br-budget'));
  const setBid = useCallback((id: string | null, path = 'budget') => { if (id) localStorage.setItem('br-budget', id); else localStorage.removeItem('br-budget'); setBidState(id); qc.invalidateQueries({ queryKey: ['budgets'] }); go(id ? path : ''); }, [qc]);
  if (budgets.isLoading || !budgets.data) return <div className="flex h-full items-center justify-center text-ink-3">Loading…</div>;
  const list = budgets.data; const current = list.find(b => b.id === bid) ?? null;
  if (route[0] === 'ynab4-import') return <Suspense fallback={null}><Ynab4Import onOpen={id => setBid(id)} onCancel={() => go(current ? 'budget' : '')} /></Suspense>;
  if (!current || route[0] === 'welcome') return <Welcome budgets={list} onOpen={id => setBid(id)} canClose={!!current} />;
  return <BudgetProvider key={current.id} bid={current.id} fallback={() => <Empty title="This budget could not be opened" action={<Button onClick={() => setBid(null)}>Choose another budget</Button>} />}>
    <Shell status={status} budgets={list} onSwitch={setBid} />
  </BudgetProvider>;
}
