import { startRegistration } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, LogOut, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { BudgetInfo, Status } from '../App';
import { Badge, Button, Combobox, Confirm, cx, Dialog, Field, Input, Select } from '../components/ui';
import { api, del, get, post, put, setCsrf } from '../lib/api';
import { applyTheme, currentTheme, download, go, toast, toastError, useBudget, type Theme } from '../lib/store';
import { useCategoryOptions } from './TxnEditor';

const TABS = [['budget', 'Budget'], ['security', 'Security'], ['backups', 'Backups & export'], ['rules', 'Import rules'], ['app', 'Appearance & shortcuts']] as const;
export default function Settings({ status, budgets, onSwitch }: { status: Status; budgets: BudgetInfo[]; onSwitch: (id: string | null, path?: string) => void }) {
  const [tab, setTab] = useState<string>('budget');
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="border-b border-line bg-surface px-4 pt-3 md:px-6"><h1 className="text-[17px] font-semibold tracking-tight">Settings</h1>
      <div className="-mb-px mt-2 flex gap-1 overflow-x-auto" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px]', tab === k ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink')}>{l}</button>)}</div></header>
    <div className="mx-auto w-full max-w-3xl space-y-5 p-4 md:p-6">
      {tab === 'budget' && <BudgetTab budgets={budgets} onSwitch={onSwitch} />}{tab === 'security' && <SecurityTab status={status} />}{tab === 'backups' && <BackupsTab onSwitch={onSwitch} />}{tab === 'rules' && <RulesTab />}{tab === 'app' && <AppTab />}</div></div>;
}
const Card = ({ title, children, desc }: { title: string; children: ReactNode; desc?: ReactNode }) => <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="text-[15px] font-semibold">{title}</h2>{desc && <p className="mt-0.5 text-[13px] text-ink-2">{desc}</p>}<div className="mt-4">{children}</div></section>;

function BudgetTab({ budgets, onSwitch }: { budgets: BudgetInfo[]; onSwitch: (id: string | null, path?: string) => void }) {
  const b = useBudget(); const s = b.boot.settings; const [name, setName] = useState(s.name), [currency, setCurrency] = useState(s.currency), [symbol, setSymbol] = useState(s.format.symbol);
  const [delOpen, setDelOpen] = useState(false), [confirmName, setConfirmName] = useState(''); const [problems, setProblems] = useState<string[] | null>(null);
  const save = (patch: object) => b.mutate(() => put(b.url('/settings'), patch)).then(r => { if (r) toast('Saved', 'success'); });
  const last = useMemo(() => { try { return b.boot.lastImport ? JSON.parse(b.boot.lastImport) : null; } catch { return null; } }, [b.boot.lastImport]);
  return <>
    <Card title="This budget">
      <div className="grid gap-3 md:grid-cols-3"><Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== s.name && save({ name: name.trim() })} /></Field>
        <Field label="Currency code"><Input value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} onBlur={() => /^[A-Z]{3}$/.test(currency) && currency !== s.currency && save({ currency })} /></Field>
        <Field label="Currency symbol"><Input value={symbol} maxLength={6} onChange={e => setSymbol(e.target.value)} onBlur={() => symbol !== s.format.symbol && save({ format: { ...s.format, symbol } })} /></Field>
        <Field label="Number format"><Select className="w-full" value={s.format.decimalSep} onChange={v => save({ format: { ...s.format, decimalSep: v, groupSep: v === ',' ? '.' : ',' } })} options={[{ value: ',', label: '1.234,56 (Danish)' }, { value: '.', label: '1,234.56' }]} /></Field>
        <Field label="Date format"><Select className="w-full" value={s.dateFormat} onChange={v => save({ dateFormat: v })} options={['DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].map(v => ({ value: v, label: v }))} /></Field></div></Card>
    <Card title="Data check" desc="Verifies that transfers match, splits add up, and every month satisfies: budget cash = Available to Budget + category balances.">
      <Button onClick={async () => { try { setProblems((await get(b.url('/integrity'))).problems); } catch (e) { toastError(e); } }}><ShieldCheck size={16} />Check financial consistency</Button>
      {problems && (problems.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-neg">{problems.map(p => <li key={p}>{p}</li>)}</ul> : <p className="mt-3 text-[13px] text-pos">Everything is consistent.</p>)}</Card>
    {last && <Card title="Migration report" desc={`This budget was imported from ${last.kind === 'ynab4-native' ? 'a native YNAB4 budget' : 'YNAB4 CSV exports'}.`}>
      <div className="mb-2"><Badge tone={last.status === 'verified' ? 'pos' : 'warn'}>{last.status === 'verified' ? 'Verified against source' : 'Needs attention'}</Badge></div>
      <ul className="space-y-1 text-[13px]">{last.checks.map((c: any) => <li key={c.name} className={cx(c.status === 'fail' && 'text-neg')}><b className="font-medium">{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '·'} {c.name}:</b> <span className="text-ink-2">{c.detail}</span></li>)}</ul></Card>}
    <Card title="Budgets" desc="Each budget is a separate file on your server.">
      <ul className="divide-y divide-line rounded-xl border border-line">{budgets.map(x => <li key={x.id} className="flex items-center gap-3 px-3 py-2"><span className="flex-1 truncate font-medium">{x.name}</span>{x.id === b.bid ? <Badge tone="accent">Open</Badge> : <Button size="sm" onClick={() => onSwitch(x.id)}>Open</Button>}</li>)}</ul>
      <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => go('welcome')}><Plus size={15} />New, import or restore…</Button><Button className="text-neg" onClick={() => { setConfirmName(''); setDelOpen(true); }}><Trash2 size={15} />Delete this budget…</Button></div></Card>
    <Dialog open={delOpen} onClose={() => setDelOpen(false)} title={`Delete “${s.name}”?`} footer={<><Button onClick={() => setDelOpen(false)}>Cancel</Button><Button variant="danger" disabled={confirmName.trim() !== s.name} onClick={async () => { try { await post(`/budgets/${b.bid}/delete`, { confirmName }); toast('Budget deleted. A final backup was kept on the server.'); onSwitch(null); } catch (e) { toastError(e); } }}>Delete budget</Button></>}>
      <p className="mb-3 text-ink-2">The budget is removed from the app. A final backup file stays in the server’s backups folder. Type the budget name to confirm.</p><Input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={s.name} autoFocus /></Dialog></>;
}

function SecurityTab({ status }: { status: Status }) {
  const qc = useQueryClient(); const refresh = () => qc.invalidateQueries({ queryKey: ['status'] });
  const [cur, setCur] = useState(''), [next, setNext] = useState(''), [totp, setTotp] = useState<{ secret: string; uri: string } | null>(null), [code, setCode] = useState(''), [disable, setDisable] = useState(false), [pw, setPw] = useState('');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<any[]>('/auth/sessions') }); const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: () => get<any[]>('/auth/passkeys') });
  const qr = useMemo(() => { if (!totp) return ''; const q = qrcode(0, 'M'); q.addData(totp.uri); q.make(); return q.createDataURL(5, 8); }, [totp]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok, 'success'); refresh(); return true; } catch (e) { toastError(e); return false; } };
  const addPasskey = () => run(async () => { const { options, ticket } = await post('/auth/passkey/register-options'); const response = await startRegistration({ optionsJSON: options }); await post('/auth/passkey/register', { ticket, response, name: navigator.platform || 'Passkey' }); passkeys.refetch(); }, 'Passkey added');
  return <>
    <Card title="Password" desc={`Signed in as ${status.user?.username}. Passwords are stored only as Argon2id hashes.`}>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end"><Field label="Current password"><Input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} /></Field><Field label="New password (min. 10 characters)"><Input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></Field>
        <Button disabled={!cur || next.length < 10} onClick={async () => { try { const r = await post('/auth/password', { current: cur, next }); setCsrf(r.csrf); setCur(''); setNext(''); toast('Password changed. Other devices were signed out.', 'success'); refresh(); sessions.refetch(); } catch (e) { toastError(e); } }}>Change password</Button></div></Card>
    <Card title="Two-factor authentication (TOTP)" desc="A 6-digit code from an authenticator app is required at sign-in.">
      {status.user?.totpEnabled ? <div className="flex items-center gap-3"><Badge tone="pos">Enabled</Badge><Button size="sm" onClick={() => setDisable(true)}>Turn off…</Button></div>
        : totp ? <div className="flex flex-wrap items-start gap-5"><img src={qr} alt="QR code for your authenticator app" className="rounded-lg border border-line bg-white" width={180} height={180} />
          <div className="min-w-0 flex-1 space-y-3"><p className="text-[13px] text-ink-2">Scan the code with your authenticator app, or enter this key by hand:</p><code className="block break-all rounded-lg bg-sunken px-2 py-1.5 text-[12.5px]">{totp.secret}</code>
            <div className="flex gap-2"><Input aria-label="6-digit code" className="num w-32 text-center tracking-widest" inputMode="numeric" placeholder="000000" value={code} onChange={e => setCode(e.target.value)} /><Button variant="primary" disabled={code.replace(/\s/g, '').length !== 6} onClick={() => run(() => post('/auth/totp/enable', { code }), 'Two-factor authentication is on').then(ok => { if (ok) { setTotp(null); setCode(''); } })}>Verify and turn on</Button></div></div></div>
        : <Button onClick={() => run(async () => setTotp(await post('/auth/totp/begin')))}><ShieldCheck size={16} />Set up two-factor authentication</Button>}</Card>
    <Card title="Passkeys" desc="Sign in with your fingerprint, face or device PIN instead of the password. Requires HTTPS (or localhost).">
      <ul className="mb-3 divide-y divide-line">{(passkeys.data ?? []).map(p => <li key={p.id} className="flex items-center gap-3 py-2"><KeyRound size={15} className="text-ink-3" /><span className="flex-1">{p.name} <span className="text-[12px] text-ink-3">added {p.createdAt.slice(0, 10)}</span></span><Button size="icon" variant="ghost" aria-label="Remove passkey" onClick={() => run(() => del(`/auth/passkeys/${encodeURIComponent(p.id)}`)).then(() => passkeys.refetch())}><Trash2 size={14} /></Button></li>)}</ul>
      <Button onClick={addPasskey} disabled={!window.PublicKeyCredential}><KeyRound size={16} />Add a passkey</Button></Card>
    <Card title="Signed-in devices" desc="Sessions end automatically after 7 days without use and after 30 days at the latest.">
      <ul className="mb-3 divide-y divide-line text-[13px]">{(sessions.data ?? []).map(s => <li key={s.id} className="flex items-center gap-3 py-2"><span className="min-w-0 flex-1 truncate">{(s.userAgent ?? 'Unknown device').replace(/Mozilla\/5\.0 \(([^)]+)\).*/, '$1')}<span className="text-ink-3"> · {s.ip} · last used {new Date(s.lastSeen).toLocaleString()}</span></span>{s.current && <Badge tone="accent">This device</Badge>}</li>)}</ul>
      <div className="flex flex-wrap gap-2"><Button onClick={() => run(() => post('/auth/logout'))}><LogOut size={15} />Sign out</Button><Button className="text-neg" onClick={() => run(() => post('/auth/logout-all'))}>Sign out on all devices</Button></div></Card>
    <Dialog open={disable} onClose={() => setDisable(false)} title="Turn off two-factor authentication" footer={<><Button onClick={() => setDisable(false)}>Cancel</Button><Button variant="danger" disabled={!pw} onClick={() => run(() => post('/auth/totp/disable', { password: pw }), 'Two-factor authentication is off').then(ok => { if (ok) { setDisable(false); setPw(''); } })}>Turn off</Button></>}>
      <Field label="Confirm with your password"><Input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus /></Field></Dialog></>;
}

function BackupsTab({ onSwitch }: { onSwitch: (id: string | null, path?: string) => void }) {
  const b = useBudget(); const qc = useQueryClient(); const file = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['b', b.bid, 'aux', 'backups'], queryFn: () => get<{ name: string; at: string; reason: string; size: number }[]>(b.url('/backups')) });
  const restore = async (f?: File) => { if (!f) return; try { const r = await api<{ id: string; name: string }>('POST', '/restore', undefined, { raw: f, headers: { 'content-type': 'application/octet-stream' } }); await qc.invalidateQueries({ queryKey: ['budgets'] }); toast(`Restored as “${r.name}”`, 'success'); onSwitch(r.id); } catch (e) { toastError(e); } finally { if (file.current) file.current.value = ''; } };
  return <>
    <Card title="Backups" desc="A backup is a complete copy of this budget: accounts, transactions, categories, budget history, schedules, rules and settings. An automatic backup is made each day the budget is used, and before every import or restore.">
      <div className="mb-3 flex flex-wrap gap-2"><Button variant="primary" onClick={async () => { try { const r = await post(b.url('/backups')); await q.refetch(); download(b.url(`/backups/${r.name}`)); toast('Backup created and downloaded', 'success'); } catch (e) { toastError(e); } }}><Download size={16} />Back up now and download</Button>
        <Button onClick={() => file.current?.click()}><Upload size={16} />Restore from a backup file…</Button><input ref={file} type="file" hidden accept=".budgetreborn,.sqlite" onChange={e => restore(e.target.files?.[0])} /></div>
      <p className="mb-2 text-[12.5px] text-ink-3">Restoring opens the backup as a new budget next to the current one — nothing is overwritten. Keep downloaded backups somewhere other than the server.</p>
      <div className="max-h-72 overflow-y-auto rounded-xl border border-line"><table className="w-full text-[13px]"><tbody>{(q.data ?? []).map(x => <tr key={x.name} className="border-b border-line/70 last:border-0"><td className="num px-3 py-1.5">{x.at.replace('T', ' ').replace('Z', '')}</td><td><Badge>{x.reason}</Badge></td><td className="num text-right text-ink-3">{(x.size / 1024 / 1024).toFixed(1)} MB</td>
        <td className="px-2 text-right"><Button size="sm" variant="ghost" onClick={() => download(b.url(`/backups/${x.name}`))}><Download size={13} />Download</Button></td></tr>)}{!q.data?.length && <tr><td className="px-3 py-3 text-ink-3">No backups yet.</td></tr>}</tbody></table></div></Card>
    <Card title="Export" desc="Open formats you can read without Budget Reborn.">
      <div className="flex flex-wrap gap-2"><Button onClick={() => download(b.url('/export/register.csv'))}><Download size={15} />All transactions (CSV)</Button><Button onClick={() => download(b.url('/export/budget.csv'))}><Download size={15} />Budget by month (CSV)</Button><Button onClick={() => download(b.url('/export/json'))}><Download size={15} />Everything (JSON)</Button></div></Card></>;
}

function RulesTab() {
  const b = useBudget(); const qc = useQueryClient(); const cats = useCategoryOptions();
  const q = useQuery({ queryKey: ['b', b.bid, 'aux', 'rules'], queryFn: () => get<any[]>(b.url('/rules')) }); const reload = () => qc.invalidateQueries({ queryKey: ['b', b.bid, 'aux', 'rules'] });
  const [matchType, setMatchType] = useState('contains'), [pattern, setPattern] = useState(''), [payeeName, setPayeeName] = useState(''), [categoryId, setCategoryId] = useState<string | null>(null);
  return <Card title="Rules for Smart Bank Import" desc="Rules decide which payee and category are suggested for bank text. They only affect future imports — changing a rule never rewrites transactions you already have. Corrections you make during an import are remembered here automatically.">
    <div className="grid gap-2 md:grid-cols-[130px_1fr_1fr_1fr_auto] md:items-end"><Field label="When bank text"><Select className="w-full" value={matchType} onChange={setMatchType} options={[{ value: 'contains', label: 'contains' }, { value: 'exact', label: 'is exactly' }, { value: 'regex', label: 'matches regex' }]} /></Field>
      <Field label="Text"><Input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="e.g. netto" /></Field><Field label="Use payee"><Input value={payeeName} onChange={e => setPayeeName(e.target.value)} placeholder="Netto" /></Field>
      <Field label="and category"><Combobox className="h-9" value={categoryId} options={cats} placeholder="(optional)" onPick={o => setCategoryId(o?.id ?? null)} /></Field>
      <Button variant="primary" disabled={!pattern.trim() || (!payeeName.trim() && !categoryId)} onClick={() => b.mutate(() => post(b.url('/rules'), { matchType, pattern, payeeName: payeeName || null, categoryId, transferAccountId: null })).then(r => { if (r) { setPattern(''); setPayeeName(''); setCategoryId(null); reload(); } })}>Add rule</Button></div>
    <ul className="mt-4 divide-y divide-line text-[13px]">{(q.data ?? []).map(r => <li key={r.id} className="flex items-center gap-2 py-2"><Badge tone={r.origin === 'user' ? 'accent' : 'neutral'}>{r.origin === 'user' ? 'Rule' : 'Remembered'}</Badge>
      <span className="min-w-0 flex-1 truncate">{r.matchType === 'exact' ? 'is' : r.matchType} “<b className="font-medium">{r.pattern}</b>” → {r.transferAccountId ? `Transfer : ${b.accountById.get(r.transferAccountId)?.name}` : r.payeeName ?? '(same payee)'}{r.categoryId && <span className="text-ink-2"> · {b.categoryLabel(r.categoryId)}</span>}</span>
      <Button size="icon" variant="ghost" aria-label="Delete rule" onClick={() => b.mutate(() => del(b.url(`/rules/${r.id}`))).then(reload)}><Trash2 size={14} /></Button></li>)}{!q.data?.length && <li className="py-2 text-ink-3">No rules yet.</li>}</ul></Card>;
}

function AppTab() {
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const keys: [string, string][] = [['Ctrl/⌘ + Z', 'Undo'], ['Ctrl/⌘ + Shift + Z, Ctrl + Y', 'Redo'], ['[  and  ]', 'Budget: previous / next month'], ['T', 'Budget: go to current month'], ['Enter, ↓, ↑', 'Budget: save amount and move between categories'], ['500+250, 1200/12', 'Amounts accept simple arithmetic'],
    ['N', 'Register: new transaction'], ['Enter', 'Register: edit selected / save'], ['Ctrl/⌘ + Enter', 'Register: save and add another'], ['Esc', 'Cancel edit / clear selection'], ['C', 'Register: toggle cleared'], ['Delete', 'Register: delete selected (with undo)'],
    ['Ctrl/⌘ + D', 'Register: duplicate selected'], ['/', 'Register: search'], ['↑ ↓, Shift + click, Ctrl/⌘ + A', 'Register: move and select']];
  return <><Card title="Appearance"><div className="flex gap-2">{(['system', 'light', 'dark'] as Theme[]).map(t => <Button key={t} variant={theme === t ? 'primary' : 'secondary'} onClick={() => { setTheme(t); applyTheme(t); }}>{t[0].toUpperCase() + t.slice(1)}</Button>)}</div></Card>
    <Card title="Keyboard shortcuts"><table className="w-full text-[13px]"><tbody>{keys.map(([k, d]) => <tr key={k} className="border-b border-line/70 last:border-0"><td className="w-64 py-1.5"><kbd className="rounded bg-sunken px-1.5 py-0.5 text-[12px]">{k}</kbd></td><td className="text-ink-2">{d}</td></tr>)}</tbody></table></Card>
    <Card title="About"><p className="text-[13px] text-ink-2">Budget Reborn is an independent, self-hosted budgeting application that follows the YNAB4 method. It is not affiliated with or endorsed by YNAB. It sends no data to anyone: no telemetry, no analytics, no external requests.</p></Card></>;
}
