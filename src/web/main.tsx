import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Toasts } from './components/ui';
import { applyTheme, currentTheme } from './lib/store';
import './index.css';

applyTheme(currentTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } } });
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={qc}><App /><Toasts /></QueryClientProvider></StrictMode>);
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => { /* optional */ });
