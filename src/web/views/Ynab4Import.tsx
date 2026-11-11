import { AlertTriangle, ArrowLeft, Check, CheckCircle2, CircleSlash, FileArchive, FolderOpen, Info, Upload, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, cx, Field, Input, Select } from '../components/ui';
import { ApiError, post } from '../lib/api';
import { readDrop, readFileList, type TextFile } from '../lib/files';
import { toastError } from '../lib/store';
import { formatMinor, DKK_FORMAT } from '../../shared/money';
import { ACCOUNT_TYPES } from '../../shared/types';
import { Logo } from './Auth';
import { AuditTable, type MigrationAudit } from '../components/AuditTable';

interface Check { name: string; status: 'pass' | 'fail' | 'info' | 'skipped'; detail: string; mismatches?: { where: string; expected: string; actual: string; hint?: string }[]; mismatchCount?: number }
interface Result { ok: boolean; status: 'verified' | 'needs_attention'; kind: string; counts: Record<string, number>; range: Record<string, string | null>; checks: Check[];
  warnings: { level: 'info' | 'warning' | 'error'; code: string; message: string }[]; coverage: { item: string; status: 'full' | 'partial' | 'none'; note: string }[]; audit?: MigrationAudit }
interface Preview { detected: { path: string; kind: string }[]; result: Result; previousImports: { id: string; name: string; at: string }[];
  summary: { budgetName: string; currency: string | null; kind: string; accounts: { name: string; type: string; onBudget: boolean; closed: boolean; typeKnown: boolean; transactions: number; balance: number }[];
    groups: { name: string; hidden: boolean; categories: { name: string; hidden: boolean }[] }[]; sample: { date: string; account: string; payee: string; category: string; amount: number; cleared: string }[]; budgetMonths: string[]; scheduled: number } }
const STEPS = ['Select files', 'Preview', 'Verify', 'Import', 'Done'];
const fmt = (n: number) => formatMinor(n, DKK_FORMAT);

export default function Ynab4Import({ onOpen, onCancel }: { onOpen: (id: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState(0), [files, setFiles] = useState<TextFile[]>([]), [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null), [done, setDone] = useState<{ budgetId: string; result: Result } | null>(null);
  const [name, setName] = useState(''), [dateStyle, setDateStyle] = useState('auto'), [decimal, setDecimal] = useState('auto'), [accounts, setAccounts] = useState<Record<string, { type?: string; onBudget?: boolean }>>({});
  const [confirmDup, setConfirmDup] = useState(false), [over, setOver] = useState(false);
  const folder = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  const options = (extra: object = {}) => ({ budgetName: name || undefined, dateStyle, decimal, accounts, ...extra });
  const payloadFiles = (list: TextFile[]) => list.map(f => ({ path: f.path, text: f.text }));
  const runPreview = async (list = files, opts = options()) => {
    setBusy('Reading and checking your budget…'); setError(null);
    try { const p = await post<Preview>('/import/ynab4/preview', { files: payloadFiles(list), options: opts }); setPreview(p); if (!name) setName(p.summary.budgetName); setStep(s => Math.max(s, 1)); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'The files could not be read.'); setPreview(null); setStep(0); } finally { setBusy(null); }
  };
  const take = async (reader: () => Promise<TextFile[]>) => {
    setBusy('Reading files…'); setError(null);
    try {
      let list = (await reader()).filter(f => /\.(yfull|ydiff|ydevice|ymeta|csv)$/i.test(f.path));
      if (!list.length) { setError('No YNAB4 files found. Choose the “.ynab4” folder of your budget (or a zip of it), or the Register and Budget CSV files exported from YNAB4.'); setBusy(null); return; }
      const diffs = list.filter(f => /\.ydiff$/i.test(f.path));
      if (diffs.length > 1500) list = list.filter(f => !/\.ydiff$/i.test(f.path)).concat(diffs.sort((a, b) => a.path.localeCompare(b.path)).slice(-1500));
      setFiles(list); setAccounts({}); await runPreview(list, { budgetName: undefined, dateStyle: 'auto', decimal: 'auto', accounts: {} } as any);
    } catch (e) { setError('Could not read the selected files: ' + (e as Error).message); setBusy(null); }
  };
  const commit = async () => {
    setBusy('Importing — this is a single all-or-nothing operation…'); setError(null); setStep(3);
    try { const r = await post<{ budgetId: string; result: Result }>('/import/ynab4/commit', { files: payloadFiles(files), options: options(), confirmDuplicate: confirmDup }); setDone(r); setStep(4); }
    catch (e) { setStep(2); if (e instanceof ApiError) setError(e.message + (e.code === 'ALREADY_IMPORTED' ? ' Tick the confirmation below to import it again as a separate budget.' : ' Nothing was imported.')); else toastError(e); }
    finally { setBusy(null); }
  };
  const r = preview?.result; const isCsv = preview?.summary.kind === 'ynab4-csv';
  const blocking = r?.warnings.filter(w => w.code === 'date_order_ambiguous' || w.code === 'decimal_mixed') ?? [];

  return <div className="mx-auto flex min-h-full max-w-4xl flex-col px-4 py-6">
    <div className="mb-5 flex items-center gap-3"><Logo size={32} /><div className="flex-1"><h1 className="text-xl font-semibold tracking-tight">Import YNAB4 budget</h1><p className="text-[13px] text-ink-2">Your original files are only read, never changed. The import creates a new budget; existing budgets stay untouched.</p></div>
      {step < 4 && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}</div>
    <ol className="mb-6 flex gap-1.5">{STEPS.map((s, i) => <li key={s} className={cx('flex-1 rounded-full py-1 text-center text-[11.5px] font-medium', i < step ? 'bg-accent-soft text-accent' : i === step ? 'bg-accent text-accent-ink' : 'bg-sunken text-ink-3')}>{i + 1}. {s}</li>)}</ol>
    {error && <div role="alert" className="mb-4 flex gap-2 rounded-xl bg-neg-soft px-4 py-3 text-neg"><XCircle size={18} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
    {busy && <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-6 text-center text-ink-2"><div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-line-strong border-t-accent" />{busy}</div>}

    {step === 0 && !busy && <div className="space-y-4">
      <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const dt = e.dataTransfer; take(() => readDrop(dt)); }}
        className={cx('rounded-2xl border-2 border-dashed p-10 text-center transition-colors', over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface')}>
        <Upload size={28} className="mx-auto mb-3 text-ink-3" /><p className="text-[15px] font-medium">Drop your YNAB4 budget here</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">The whole <b>“My Budget~….ynab4”</b> folder (best: keeps everything), a zip of it, or the exported <b>Register.csv</b> and <b>Budget.csv</b> files.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={() => folder.current?.click()}><FolderOpen size={16} />Choose .ynab4 folder</Button><Button onClick={() => file.current?.click()}><FileArchive size={16} />Choose files (CSV, zip, Budget.yfull)</Button></div>
        <input ref={folder} type="file" hidden {...({ webkitdirectory: '', directory: '' } as any)} multiple onChange={e => { const l = e.target.files; if (l?.length) take(() => readFileList(l)); }} />
        <input ref={file} type="file" hidden multiple accept=".csv,.zip,.yfull,.ydiff,.ymeta,.ydevice" onChange={e => { const l = e.target.files; if (l?.length) take(() => readFileList(l)); }} /></div>
      <div className="grid gap-3 text-[13px] text-ink-2 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4"><b className="text-ink">Where is my .ynab4 folder?</b><p className="mt-1">Usually in <code>Documents/YNAB</code> or <code>Dropbox/YNAB</code>. On a Mac it looks like a single file — it can be dropped here directly or zipped first.</p></div>
        <div className="rounded-xl border border-line bg-surface p-4"><b className="text-ink">Using CSV instead</b><p className="mt-1">In YNAB4: File → Export. Select both the <i>Register</i> and the <i>Budget</i> file. CSV has no account types, schedules or notes; the native folder has everything.</p></div></div></div>}

    {step >= 1 && step <= 2 && preview && r && !busy && <div className="space-y-5">
      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-semibold">Detected</h2><Badge tone="accent">{preview.summary.kind === 'ynab4-native' ? 'Native YNAB4 budget' : 'YNAB4 CSV export'}</Badge>
          {preview.detected.filter(d => /yfull|Register|Budget export/.test(d.kind)).map(d => <Badge key={d.path} title={d.path}>{d.kind}</Badge>)}{files.filter(f => /ydiff$/i.test(f.path)).length > 0 && <Badge>{files.filter(f => /ydiff$/i.test(f.path)).length} sync diffs</Badge>}
          {preview.detected.some(d => d.kind === 'not recognised') && <Badge tone="warn">{preview.detected.filter(d => d.kind === 'not recognised').length} file(s) ignored</Badge>}</div>
        <div className="mt-4 grid gap-3 md:grid-cols-3"><Field label="Budget name"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
          {isCsv && <Field label="Date order in the file"><Select className="w-full" value={dateStyle} onChange={v => { setDateStyle(v); runPreview(files, options({ dateStyle: v })); }} options={[{ value: 'auto', label: 'Detect automatically' }, { value: 'DMY', label: 'Day / Month / Year' }, { value: 'MDY', label: 'Month / Day / Year' }, { value: 'YMD', label: 'Year-Month-Day' }]} /></Field>}
          {isCsv && <Field label="Number format"><Select className="w-full" value={decimal} onChange={v => { setDecimal(v); runPreview(files, options({ decimal: v })); }} options={[{ value: 'auto', label: 'Detect automatically' }, { value: 'comma', label: '1.234,56 (decimal comma)' }, { value: 'dot', label: '1,234.56 (decimal point)' }]} /></Field>}</div>
        <dl className="num mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] md:grid-cols-4">{[['Accounts', r.counts.accounts], ['Categories', r.counts.categories], ['Transactions', r.counts.transactions], ['Split lines', r.counts.splitLines], ['Transfer pairs', r.counts.transferPairs], ['Payees', r.counts.payees], ['Months with budget', r.counts.budgetMonths], ['Scheduled', r.counts.scheduled]]
          .map(([l, v]) => <div key={l as string} className="flex justify-between border-b border-line/70 py-1"><dt className="text-ink-2">{l}</dt><dd className="font-semibold">{(v as number).toLocaleString()}</dd></div>)}</dl>
        <p className="mt-2 text-[12.5px] text-ink-3">Transactions {r.range.firstTransaction ?? '—'} → {r.range.lastTransaction ?? '—'} · Budget history {r.range.firstBudgetMonth ?? 'none'}{r.range.lastBudgetMonth ? ` → ${r.range.lastBudgetMonth}` : ''}</p>
      </section>

      {step === 1 && <>
        <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-3 text-[15px] font-semibold">Accounts</h2>
          {isCsv && <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">CSV exports do not say what kind of account each one is. Check the type and whether it is a budget or tracking (off-budget) account — this affects the budget.</p>}
          <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead className="text-left text-[11px] uppercase tracking-wide text-ink-3"><tr><th className="pb-1.5">Account</th><th>Type</th><th>Budget?</th><th className="text-right">Transactions</th><th className="text-right">Balance</th></tr></thead><tbody>
            {preview.summary.accounts.map(a => <tr key={a.name} className="border-t border-line/70"><td className="py-1.5 pr-3 font-medium">{a.name}{a.closed && <span className="ml-2 text-ink-3">(closed)</span>}</td>
              <td className="pr-3">{isCsv ? <Select aria-label={`Type of ${a.name}`} className="h-8" value={accounts[a.name]?.type ?? a.type} onChange={v => { const n = { ...accounts, [a.name]: { ...accounts[a.name], type: v } }; setAccounts(n); runPreview(files, options({ accounts: n })); }} options={ACCOUNT_TYPES.map(t => ({ value: t.value, label: t.label }))} /> : ACCOUNT_TYPES.find(t => t.value === a.type)?.label}</td>
              <td className="pr-3">{isCsv ? <Select aria-label={`Budget setting of ${a.name}`} className="h-8" value={String(accounts[a.name]?.onBudget ?? a.onBudget)} onChange={v => { const n = { ...accounts, [a.name]: { ...accounts[a.name], onBudget: v === 'true' } }; setAccounts(n); runPreview(files, options({ accounts: n })); }} options={[{ value: 'true', label: 'Budget account' }, { value: 'false', label: 'Tracking (off-budget)' }]} /> : a.onBudget ? 'Budget' : 'Tracking'}</td>
              <td className="num text-right">{a.transactions.toLocaleString()}</td><td className={cx('num text-right', a.balance < 0 && 'text-neg')}>{fmt(a.balance)}</td></tr>)}</tbody></table></div></section>
        <div className="grid gap-5 md:grid-cols-2">
          <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-3 text-[15px] font-semibold">Categories</h2><div className="max-h-72 space-y-2 overflow-y-auto text-[13px]">
            {preview.summary.groups.map(g => <div key={g.name}><div className="font-semibold">{g.name}</div><div className="text-ink-2">{g.categories.map(c => c.name + (c.hidden ? ' (hidden)' : '')).join(' · ') || '—'}</div></div>)}</div></section>
          <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-3 text-[15px] font-semibold">Most recent transactions</h2><div className="max-h-72 overflow-y-auto"><table className="w-full text-[12.5px]"><tbody>
            {preview.summary.sample.map((t, i) => <tr key={i} className="border-b border-line/60"><td className="num whitespace-nowrap py-1 pr-2 text-ink-2">{t.date}</td><td className="max-w-[9rem] truncate pr-2">{t.payee}</td><td className="max-w-[8rem] truncate pr-2 text-ink-3">{t.category}</td><td className={cx('num text-right', t.amount < 0 ? '' : 'text-pos')}>{fmt(t.amount)}</td></tr>)}</tbody></table></div></section></div>
        <Coverage list={r.coverage} />
        <div className="flex justify-between"><Button onClick={() => { setStep(0); setPreview(null); setFiles([]); }}><ArrowLeft size={15} />Choose other files</Button><Button variant="primary" size="lg" onClick={() => setStep(2)}>Continue to verification</Button></div></>}

      {step === 2 && <>
        <Warnings list={r.warnings} />
        <Checks result={r} />
        {r.audit && <AuditTable audit={r.audit} />}
        {preview.previousImports.length > 0 && <label className="flex items-start gap-2.5 rounded-xl border border-warn bg-warn-soft px-4 py-3 text-warn"><input type="checkbox" className="mt-1" checked={confirmDup} onChange={e => setConfirmDup(e.target.checked)} />
          <span>These exact files were already imported as <b>“{preview.previousImports[0].name}”</b> on {preview.previousImports[0].at.slice(0, 10)}. Tick to import them again as a second, separate budget.</span></label>}
        <div className="flex flex-wrap items-center justify-between gap-3"><Button onClick={() => setStep(1)}><ArrowLeft size={15} />Back</Button>
          <div className="flex items-center gap-3">{r.status === 'needs_attention' && !blocking.length && <span className="max-w-xs text-right text-[12.5px] text-warn">Differences were found (see above). You can still import; they will be shown again afterwards.</span>}
            <Button variant="primary" size="lg" disabled={blocking.length > 0 || (preview.previousImports.length > 0 && !confirmDup)} onClick={commit}>{blocking.length ? 'Choose formats first' : `Import ${r.counts.transactions.toLocaleString()} transactions`}</Button></div></div></>}
    </div>}

    {step === 4 && done && <div className="space-y-5">
      <div className={cx('flex items-start gap-3 rounded-2xl p-5', done.result.status === 'verified' ? 'bg-pos-soft' : 'bg-warn-soft')}>
        {done.result.status === 'verified' ? <CheckCircle2 size={26} className="shrink-0 text-pos" /> : <AlertTriangle size={26} className="shrink-0 text-warn" />}
        <div><h2 className="text-[16px] font-semibold">{done.result.status === 'verified' ? 'Migration complete and verified' : 'Imported — some points need your attention'}</h2>
          <p className="text-[13.5px] text-ink-2">{done.result.counts.transactions.toLocaleString()} transactions in {done.result.counts.accounts} accounts, {done.result.counts.categories} categories and {done.result.counts.budgetMonths} months of budget history were imported.
            {done.result.status === 'verified' ? ' Every comparison against your source files matched.' : ' The import is saved, but it is not declared verified: review the failed checks below before relying on the numbers.'}</p></div></div>
      <Checks result={done.result} />{done.result.audit && <AuditTable audit={done.result.audit} />}<Warnings list={done.result.warnings} /><Coverage list={done.result.coverage} />
      <div className="flex justify-end"><Button variant="primary" size="lg" onClick={() => onOpen(done.budgetId)}>Open my budget</Button></div></div>}
  </div>;
}
function Warnings({ list }: { list: Result['warnings'] }) {
  if (!list.length) return null; const order = { error: 0, warning: 1, info: 2 };
  return <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-3 text-[15px] font-semibold">Notes and warnings</h2><ul className="space-y-2">
    {[...list].sort((a, b) => order[a.level] - order[b.level]).map((w, i) => <li key={i} className="flex gap-2.5 text-[13px]">{w.level === 'error' ? <XCircle size={16} className="mt-0.5 shrink-0 text-neg" /> : w.level === 'warning' ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" /> : <Info size={16} className="mt-0.5 shrink-0 text-ink-3" />}<span className={cx(w.level === 'error' && 'text-neg')}>{w.message}</span></li>)}</ul></section>;
}
function Checks({ result }: { result: Result }) {
  return <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-1 text-[15px] font-semibold">Verification against your source files</h2>
    <p className="mb-3 text-[12.5px] text-ink-3">Budget Reborn recalculated everything with its own engine and compared the results with what the source says.</p><ul className="divide-y divide-line/70">
    {result.checks.map(c => <li key={c.name} className="py-2.5"><div className="flex gap-2.5">{c.status === 'pass' ? <Check size={17} className="mt-0.5 shrink-0 text-pos" /> : c.status === 'fail' ? <XCircle size={17} className="mt-0.5 shrink-0 text-neg" /> : c.status === 'skipped' ? <CircleSlash size={16} className="mt-0.5 shrink-0 text-ink-3" /> : <Info size={16} className="mt-0.5 shrink-0 text-ink-3" />}
      <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{c.name}{c.status === 'skipped' && <span className="ml-2 font-normal text-ink-3">not possible</span>}</div><div className={cx('text-[13px]', c.status === 'fail' ? 'text-neg' : 'text-ink-2')}>{c.detail}</div>
        {c.mismatches && c.mismatches.length > 0 && <details className="mt-1.5" open={c.mismatches.length <= 5}><summary className="cursor-pointer text-[12.5px] text-accent">Show {c.mismatches.length}{c.mismatchCount && c.mismatchCount > c.mismatches.length ? ` of ${c.mismatchCount}` : ''} difference(s)</summary>
          <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-line"><table className="w-full text-[12px]"><thead className="bg-sunken text-left"><tr><th className="px-2 py-1">Where</th><th className="px-2">Source says</th><th className="px-2">Calculated</th></tr></thead><tbody>
            {c.mismatches.map((m, i) => <tr key={i} className="border-t border-line/70 align-top"><td className="px-2 py-1">{m.where}{m.hint && <div className="text-ink-3">{m.hint}</div>}</td><td className="num px-2">{m.expected}</td><td className="num px-2">{m.actual}</td></tr>)}</tbody></table></div></details>}</div></div></li>)}</ul></section>;
}
function Coverage({ list }: { list: Result['coverage'] }) {
  return <section className="rounded-2xl border border-line bg-surface p-5"><h2 className="mb-3 text-[15px] font-semibold">What this source contains</h2><ul className="space-y-1.5 text-[13px]">
    {list.map(c => <li key={c.item} className="flex gap-2.5"><Badge tone={c.status === 'full' ? 'pos' : c.status === 'partial' ? 'warn' : 'neg'}>{c.status === 'full' ? 'Imported' : c.status === 'partial' ? 'Partly' : 'Not available'}</Badge><span>{c.item}{c.note && <span className="text-ink-3"> — {c.note}</span>}</span></li>)}</ul></section>;
}
