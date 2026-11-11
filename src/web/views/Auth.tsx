import { startAuthentication } from '@simplewebauthn/browser';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Status } from '../App';
import { Button, Field, Input } from '../components/ui';
import { ApiError, post, setCsrf } from '../lib/api';

export function Logo({ size = 36 }: { size?: number }) { return <img src="/icon.svg" width={size} height={size} alt="" className="rounded-xl" />; }

export function AuthScreen({ status, onDone }: { status: Status; onDone: () => void }) {
  const setup = status.setupRequired;
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [token, setToken] = useState(''), [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const finish = (r: { csrf: string }) => { setCsrf(r.csrf); onDone(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    if (setup && password !== confirm) { setError('The two passwords are not the same.'); return; }
    setBusy(true);
    try { finish(await post(setup ? '/auth/setup' : '/auth/login', setup ? { username, password, token: token || undefined } : { username, password, totp: needTotp ? totp : undefined })); }
    catch (err) { if (err instanceof ApiError && err.code === 'TOTP_REQUIRED') setNeedTotp(true); else setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const passkey = async () => {
    setError(null); setBusy(true);
    try { const { options, ticket } = await post('/auth/passkey/login-options'); const response = await startAuthentication({ optionsJSON: options }); finish(await post('/auth/passkey/login', { ticket, response })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Passkey sign-in was cancelled or failed.'); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <form onSubmit={submit} className="anim-in w-full max-w-sm rounded-2xl border border-line bg-surface p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-3"><Logo /><div><div className="text-[17px] font-semibold tracking-tight">Budget Reborn</div><div className="text-[12.5px] text-ink-3">{setup ? 'Create your private login' : 'Sign in to your budget'}</div></div></div>
        {setup && <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-[12.5px] text-ink-2"><ShieldCheck size={14} className="mr-1 inline text-accent" />This installation has one owner. After this step nobody else can register.</p>}
        <div className="space-y-3.5">
          {!needTotp && <>
            <Field label="Username"><Input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoFocus required /></Field>
            <Field label="Password" hint={setup ? 'At least 10 characters. A long passphrase is best.' : undefined}><Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required minLength={setup ? 10 : 1} /></Field>
            {setup && <Field label="Repeat password"><Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>}
            {setup && status.setupNeedsToken && <Field label="Setup token" hint='Found in the file "setup-token.txt" in the data folder on the server (also printed when the server starts).'><Input value={token} onChange={e => setToken(e.target.value)} required autoComplete="off" /></Field>}
          </>}
          {needTotp && <Field label="6-digit code from your authenticator app"><Input value={totp} onChange={e => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus pattern="[0-9 ]{6,7}" required className="num text-center text-lg tracking-[0.3em]" /></Field>}
          {error && <div role="alert" className="rounded-lg bg-neg-soft px-3 py-2 text-[13px] text-neg">{error}</div>}
          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>{setup ? 'Create login' : needTotp ? 'Verify' : 'Sign in'}</Button>
          {!setup && !needTotp && status.passkeyLogin && <Button size="lg" className="w-full" onClick={passkey} disabled={busy}><KeyRound size={16} />Sign in with a passkey</Button>}
        </div>
        <p className="mt-5 text-center text-[11.5px] text-ink-3">Your data stays on your own server. No tracking, no cloud.</p>
      </form>
    </div>);
}
