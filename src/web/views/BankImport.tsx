import { AlertTriangle, CheckCircle2, ClipboardPaste, Download, FileJson, ImageUp, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Combobox, cx, Dialog, Empty, Input, Money, Select } from '../components/ui';
import { api, ApiError, post } from '../lib/api';
import { ocrImage, sniffImage } from '../lib/ocr';
import { download, go, toast, toastError, useBudget, useIsMobile } from '../lib/store';
import { decodeBytes } from '../../shared/csv';
import { BLOCKING, IMPORT_SCHEMA_ID, ISSUE_TEXT, type Candidate, type IssueCode, type OcrLine } from '../../shared/bankparse';
import { useCategoryOptions, usePayeeOptions } from './TxnEditor';

interface Source { id: number; name: string; kind: 'image' | 'csv' | 'json'; status: 'working' | 'done' | 'error'; progress: number; url?: string; blob?: Blob; message?: string;
  payload?: { kind: 'ocr'; lines: OcrLine[] } | { kind: 'csv' | 'json'; content: string } | { kind: 'candidates'; candidates: Candidate[] }; found?: number; ai?: boolean }
interface Row { key: string; sourceIndex: number; date: string; payee: string; rawPayee: string; description: string; amount: number | null; outflow: string; inflow: string; categoryId: string | null; transferAccountId: string | null;
  importId: string | null; issues: IssueCode[]; confidence: number; payeeMatch: string; payeeConfidence: number; categoryConfidence: number; categorySource: string;
  duplicate: { status: 'new' | 'possible_duplicate' | 'likely_duplicate' | 'needs_review'; reason: string }; selected: boolean; reviewed: boolean; allowDuplicate: boolean; removed: boolean; edited: boolean }
const MAX_IMAGE = 10 * 1024 * 1024;
const CHATGPT_PROMPT = `Read the attached bank screenshot(s) and return ONLY a JSON document in this exact format, with no commentary:

{"schema":"${IMPORT_SCHEMA_ID}","currency":"DKK","transactions":[{"date":"YYYY-MM-DD","payee":"text exactly as shown","amount":"-123.45","memo":""}]}

Rules:
- One entry per transaction row that is completely visible. Skip rows that are cut off. Never invent rows or values.
- "amount" is a string with a dot as decimal separator and exactly two decimals. NEGATIVE for money leaving the account (purchases, payments), positive for money coming in.
- Convert Danish numbers: "1.234,56" becomes "1234.56". Do not include running balances.
- "date" is the transaction date in ISO format. If the year is not shown, use the current year.
- If the same row appears in more than one screenshot, include it only once.`;

export default function BankImport({ visionConfigured }: { visionConfigured: boolean }) {
  const b = useBudget(); const mobile = useIsMobile();
  const [accountId, setAccountId] = useState<string>(() => localStorage.getItem('br-import-account') && b.accountById.has(localStorage.getItem('br-import-account')!) ? localStorage.getItem('br-import-account')! : b.boot.accounts.find(a => a.onBudget && !a.closed)?.id ?? b.boot.accounts[0]?.id ?? '');
  const [sources, setSources] = useState<Source[]>([]), [rows, setRows] = useState<Row[]>([]), [busy, setBusy] = useState(false), [over, setOver] = useState(false);
  const [help, setHelp] = useState(false), [paste, setPaste] = useState<string | null>(null), [zoom, setZoom] = useState<Source | null>(null), [consent, setConsent] = useState<Source | null>(null), [result, setResult] = useState<{ imported: number; totalInflow: number; totalOutflow: number; learned: number } | null>(null);
  const nextId = useRef(1), fileRef = useRef<HTMLInputElement>(null), edits = useRef(new Map<string, Partial<Row>>());
  const account = b.accountById.get(accountId); const payeeOptions = usePayeeOptions(accountId); const catOptions = useCategoryOptions();
  useEffect(() => { localStorage.setItem('br-import-account', accountId); }, [accountId]);
  useEffect(() => () => { sources.forEach(s => s.url && URL.revokeObjectURL(s.url)); }, []); // eslint-disable-line
  const patchSource = (id: number, p: Partial<Source>) => setSources(l => l.map(s => (s.id === id ? { ...s, ...p } : s)));

  const add = useCallback(async (files: File[]) => {
    setResult(null);
    for (const f of files) {
      const id = nextId.current++; const lower = f.name.toLowerCase();
      if (f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(lower)) {
        if (f.size > MAX_IMAGE) { toast(`${f.name}: images up to 10 MB are accepted`, 'error'); continue; }
        if (!(await sniffImage(f))) { toast(`${f.name} is not a PNG, JPEG or WebP image`, 'error'); continue; }
        const src: Source = { id, name: f.name || 'Screenshot', kind: 'image', status: 'working', progress: 0, url: URL.createObjectURL(f), blob: f };
        setSources(l => [...l, src]);
        ocrImage(f, p => patchSource(id, { progress: p })).then(lines => patchSource(id, { status: 'done', progress: 1, payload: { kind: 'ocr', lines } }))
          .catch(e => patchSource(id, { status: 'error', message: 'Text recognition failed: ' + (e?.message ?? 'unknown error') }));
      } else if (/\.(csv|tsv|txt)$/.test(lower) || /\.json$/.test(lower) || f.type === 'application/json' || f.type === 'text/csv') {
        if (f.size > 8 * 1024 * 1024) { toast(`${f.name} is too large`, 'error'); continue; }
        const text = decodeBytes(new Uint8Array(await f.arrayBuffer())).text; const kind = /\.json$/.test(lower) || text.trimStart().startsWith('{') || text.trimStart().startsWith('[') ? 'json' : 'csv';
        setSources(l => [...l, { id, name: f.name, kind, status: 'done', progress: 1, payload: { kind, content: text } }]);
      } else toast(`${f.name}: unsupported file type. Use screenshots (PNG/JPEG/WebP), CSV or JSON.`, 'error');
    }
  }, []);
  // clipboard paste of screenshots
  useEffect(() => {
    const f = (e: ClipboardEvent) => { const t = e.target as HTMLElement; if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      const imgs = Array.from(e.clipboardData?.items ?? []).filter(i => i.kind === 'file' && i.type.startsWith('image/')).map((i, n) => { const file = i.getAsFile()!; return new File([file], `Pasted screenshot ${n + 1}.png`, { type: file.type }); });
      if (imgs.length) { e.preventDefault(); add(imgs); } };
    window.addEventListener('paste', f); return () => window.removeEventListener('paste', f);
  }, [add]);

  const ready = sources.filter(s => s.status === 'done' && s.payload); const working = sources.some(s => s.status === 'working');
  const signature = ready.map(s => `${s.id}:${s.ai ? 'ai' : ''}`).join(',') + '|' + accountId;
  // analyse whenever the set of sources (or the account) changes
  useEffect(() => {
    if (!ready.length || working || !accountId) { if (!ready.length) setRows([]); return; }
    let cancelled = false; setBusy(true);
    post<{ rows: any[]; sources: { source: number; found: number; message?: string }[] }>(b.url('/bank-import/analyze'), { accountId, sources: ready.map(s => ({ ...s.payload, name: s.name })) }).then(r => {
      if (cancelled) return;
      const counters = new Map<number, number>();
      setRows(r.rows.map(x => { const n = counters.get(x.sourceIndex) ?? 0; counters.set(x.sourceIndex, n + 1); const key = `${ready[x.sourceIndex].id}:${n}`;
        const base: Row = { key, sourceIndex: x.sourceIndex, date: x.date ?? '', payee: x.payee, rawPayee: x.rawPayee, description: x.description ?? '', amount: x.amount, outflow: x.amount !== null && x.amount < 0 ? b.fmt(-x.amount) : '', inflow: x.amount !== null && x.amount > 0 ? b.fmt(x.amount) : '',
          categoryId: x.categoryId, transferAccountId: x.transferAccountId, importId: x.importId, issues: x.issues, confidence: x.confidence, payeeMatch: x.payeeMatch, payeeConfidence: x.payeeConfidence, categoryConfidence: x.categoryConfidence, categorySource: x.categorySource,
          duplicate: x.duplicate, selected: x.duplicate.status === 'new' && !x.needsReview, reviewed: false, allowDuplicate: false, removed: false, edited: false };
        return { ...base, ...(edits.current.get(key) ?? {}) }; }));
      setSources(l => l.map(s => { const i = ready.findIndex(x => x.id === s.id); const note = r.sources.find(n => n.source === i); return note ? { ...s, found: note.found, message: note.message } : s; }));
    }).catch(e => { if (!cancelled) { if (e instanceof ApiError && e.code === 'IMPORT_SCHEMA') toast(`${e.message} ${(e.details?.errors ?? []).slice(0, 2).join(' · ')}`, 'error'); else toastError(e); } }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [signature, working]); // eslint-disable-line

  const visible = rows.filter(r => !r.removed);
  const blocking = (r: Row) => r.issues.filter(i => BLOCKING.has(i));
  const invalid = (r: Row) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.amount === null || r.amount === 0 || (!r.transferAccountId && !r.payee.trim());
  const canImport = (r: Row) => !invalid(r) && (blocking(r).length === 0 || r.reviewed) && (r.duplicate.status === 'new' || r.allowDuplicate);
  const update = (key: string, p: Partial<Row>) => { const merged = { ...(edits.current.get(key) ?? {}), ...p }; edits.current.set(key, merged); setRows(l => l.map(r => (r.key === key ? { ...r, ...p } : r))); };
  const setAmount = (r: Row, outflow: string, inflow: string) => { const po = outflow.trim() ? b.parse(outflow) : 0, pi = inflow.trim() ? b.parse(inflow) : 0; update(r.key, { outflow, inflow, amount: po === null || pi === null || (!outflow.trim() && !inflow.trim()) ? null : pi - Math.abs(po), edited: true }); };
  // re-check duplicates after edits to date / amount / payee
  const checkKey = visible.map(r => `${r.date}|${r.amount}|${r.payee}`).join(';');
  useEffect(() => {
    if (!visible.some(r => r.edited)) return;
    const t = setTimeout(() => { post<any[]>(b.url('/bank-import/check'), { accountId, rows: visible.map(r => ({ date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null, amount: r.amount, payee: r.rawPayee || r.payee, importId: r.importId, sourceIndex: r.sourceIndex })) })
      .then(v => setRows(l => { const m = new Map(visible.map((r, i) => [r.key, v[i]])); return l.map(r => { const d = m.get(r.key); return d && d.status !== r.duplicate.status ? { ...r, duplicate: d, selected: d.status === 'new' ? r.selected : r.allowDuplicate && r.selected } : r; }); })).catch(() => { /* next edit retries */ }); }, 450);
    return () => clearTimeout(t);
  }, [checkKey]); // eslint-disable-line

  const chosen = visible.filter(r => r.selected); const importable = chosen.filter(canImport);
  const totalOut = importable.filter(r => r.amount! < 0).reduce((s, r) => s - r.amount!, 0), totalIn = importable.filter(r => r.amount! > 0).reduce((s, r) => s + r.amount!, 0);
  const reset = () => { sources.forEach(s => s.url && URL.revokeObjectURL(s.url)); setSources([]); setRows([]); edits.current.clear(); };
  const doImport = async () => {
    setBusy(true);
    try {
      const r = await post<any>(b.url('/bank-import/commit'), { accountId, rows: importable.map(x => ({ date: x.date, payeeName: x.payee.trim(), amount: x.amount, categoryId: x.categoryId, memo: x.description, transferAccountId: x.transferAccountId, importId: x.importId, rawPayee: x.rawPayee, issues: x.issues, reviewed: x.reviewed, allowDuplicate: x.allowDuplicate, sourceIndex: x.sourceIndex })) });
      b.applyChange(r); setResult(r); reset(); // screenshots are released from memory as soon as the import is done
    } catch (e) { if (e instanceof ApiError && e.details?.problems) toast(`${e.message} (${e.details.problems.slice(0, 2).map((p: any) => `row ${p.index + 1}: ${p.message}`).join('; ')})`, 'error'); else toastError(e); }
    finally { setBusy(false); }
  };
  const runVision = async (s: Source) => {
    setConsent(null); patchSource(s.id, { status: 'working', progress: 0.5, message: 'Sent to the external AI provider…' });
    try { const r = await api<{ candidates: Candidate[] }>('POST', b.url(`/bank-import/vision`), undefined, { raw: s.blob!, headers: { 'content-type': s.blob!.type || 'image/png', 'x-vision-consent': 'yes' } });
      patchSource(s.id, { status: 'done', progress: 1, ai: true, message: undefined, payload: { kind: 'candidates', candidates: r.candidates } }); }
    catch (e) { patchSource(s.id, { status: 'done', progress: 1, message: (e as Error).message }); toastError(e); }
  };
  const statusBadge = (r: Row) => {
    const out: React.ReactNode[] = []; const d = r.duplicate.status;
    if (invalid(r)) out.push(<Badge key="inv" tone="neg">Incomplete</Badge>);
    if (d === 'likely_duplicate') out.push(<Badge key="d" tone="neg" title={r.duplicate.reason}>Likely duplicate</Badge>); else if (d === 'possible_duplicate') out.push(<Badge key="d" tone="warn" title={r.duplicate.reason}>Possible duplicate</Badge>);
    else if (d === 'needs_review') out.push(<Badge key="d" tone="warn" title={r.duplicate.reason}>Needs review</Badge>);
    if (blocking(r).length && d !== 'needs_review') out.push(<Badge key="b" tone="warn" title={blocking(r).map(i => ISSUE_TEXT[i]).join('\n')}>Needs review</Badge>);
    if (!out.length) out.push(<Badge key="ok" tone="pos">Likely new</Badge>);
    return out;
  };
  const detail = (r: Row) => [...r.issues.map(i => ISSUE_TEXT[i]), r.duplicate.reason].filter(Boolean).join(' · ');
  const rowControls = (r: Row) => <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
    {blocking(r).length > 0 && <label className="flex items-center gap-1 text-[12px] text-warn"><input type="checkbox" checked={r.reviewed} onChange={e => update(r.key, { reviewed: e.target.checked, selected: e.target.checked && (r.duplicate.status === 'new' || r.allowDuplicate) && !invalid(r) ? true : r.selected })} />I checked it</label>}
    {r.duplicate.status !== 'new' && <label className="flex items-center gap-1 text-[12px] text-neg"><input type="checkbox" checked={r.allowDuplicate} onChange={e => update(r.key, { allowDuplicate: e.target.checked, selected: e.target.checked ? !invalid(r) : false })} />Import anyway</label>}</span>;

  if (!b.boot.accounts.length) return <Empty title="Add an account first" action={<Button onClick={() => go('accounts')}>Accounts</Button>}>Bank transactions are imported into one of your accounts.</Empty>;
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
    <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 md:px-6">
      <div className="mr-auto"><h1 className="text-[17px] font-semibold tracking-tight">Smart Bank Import</h1><p className="text-[12.5px] text-ink-2">Screenshots are read on this device. Nothing is saved until you approve it.</p></div>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">Into account<Select aria-label="Destination account" value={accountId} onChange={setAccountId} options={b.boot.accounts.filter(a => !a.closed).map(a => ({ value: a.id, label: a.name }))} /></label>
      <Button size="sm" onClick={() => setHelp(true)}><FileJson size={14} />JSON / ChatGPT help</Button></header>
    <div className="space-y-4 p-4 md:p-6">
      {result && <div className="flex items-center gap-3 rounded-2xl bg-pos-soft px-4 py-3"><CheckCircle2 className="text-pos" size={22} /><div className="flex-1"><b>{result.imported} transaction{result.imported === 1 ? '' : 's'} imported</b> into {account?.name}. <span className="num text-ink-2">Outflow {b.fmt(result.totalOutflow)} · Inflow {b.fmt(result.totalInflow)}</span>
        {result.learned > 0 && <span className="text-ink-2"> · {result.learned} payee correction{result.learned === 1 ? '' : 's'} remembered</span>}</div><Button size="sm" onClick={b.undo}>Undo import</Button><Button size="sm" variant="primary" onClick={() => go(`accounts/${accountId}`)}>Open register</Button></div>}
      <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); add(Array.from(e.dataTransfer.files)); }}
        className={cx('rounded-2xl border-2 border-dashed px-4 text-center transition-colors', sources.length ? 'py-4' : 'py-10', over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-surface')}>
        {!sources.length && <><ImageUp size={28} className="mx-auto mb-2 text-ink-3" /><p className="text-[15px] font-medium">Drop bank screenshots, CSV or JSON here</p><p className="mx-auto mt-1 max-w-lg text-[13px] text-ink-2">Take screenshots of the transaction list in your banking app. Several overlapping screenshots are fine — repeated rows are detected.{!mobile && ' You can also paste an image with Ctrl+V.'}</p></>}
        <div className={cx('flex flex-wrap justify-center gap-2', !sources.length && 'mt-4')}><Button variant={sources.length ? 'secondary' : 'primary'} onClick={() => fileRef.current?.click()}><ImageUp size={16} />{sources.length ? 'Add more' : 'Choose screenshots or files'}</Button>
          <Button onClick={() => setPaste('')}><ClipboardPaste size={16} />Paste JSON / CSV text</Button>{sources.length > 0 && <Button variant="ghost" onClick={reset}><Trash2 size={15} />Start over</Button>}</div>
        <input ref={fileRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,.csv,.json,.txt" onChange={e => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></div>
      {sources.length > 0 && <div className="flex gap-3 overflow-x-auto pb-1">{sources.map((s, i) => <div key={s.id} className="w-40 shrink-0 rounded-xl border border-line bg-surface p-2 text-[12px]">
        <div className="relative mb-1.5 flex h-24 items-center justify-center overflow-hidden rounded-lg bg-sunken">{s.url ? <button onClick={() => setZoom(s)} aria-label={`Enlarge ${s.name}`} className="h-full w-full"><img src={s.url} alt="" className="h-full w-full object-cover object-top" /></button> : <FileJson size={26} className="text-ink-3" />}
          <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[11px] font-semibold text-white">{i + 1}</span>
          <button aria-label={`Remove ${s.name}`} onClick={() => { s.url && URL.revokeObjectURL(s.url); setSources(l => l.filter(x => x.id !== s.id)); }} className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white"><X size={12} /></button>
          {s.status === 'working' && <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20"><div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(s.progress * 100)}%` }} /></div>}</div>
        <div className="truncate font-medium" title={s.name}>{s.name}</div>
        <div className={cx('min-h-[1rem]', s.status === 'error' || s.message ? 'text-warn' : 'text-ink-3')}>{s.status === 'working' ? s.message ?? `Reading text… ${Math.round(s.progress * 100)}%` : s.status === 'error' ? s.message : s.message ?? (s.found !== undefined ? `${s.found} row${s.found === 1 ? '' : 's'} found${s.ai ? ' (AI)' : ''}` : 'Ready')}</div>
        {visionConfigured && s.kind === 'image' && s.status !== 'working' && !s.ai && <button onClick={() => setConsent(s)} className="mt-1 flex items-center gap-1 text-accent"><Sparkles size={12} />Read with external AI…</button>}</div>)}</div>}

      {busy && !visible.length && <p className="py-6 text-center text-ink-3">Analysing…</p>}
      {visible.length > 0 && <section className="rounded-2xl border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5"><h2 className="mr-auto text-[14px] font-semibold">Review {visible.length} transaction{visible.length === 1 ? '' : 's'}</h2>
          <Button size="sm" onClick={() => setRows(l => l.map(r => ({ ...r, selected: !r.removed && canImport(r) })))}>Select all verified</Button><Button size="sm" variant="ghost" onClick={() => setRows(l => l.map(r => ({ ...r, selected: false })))}>Select none</Button></div>
        {mobile ? <div className="divide-y divide-line">{visible.map(r => <div key={r.key} className={cx('space-y-2 p-3', !r.selected && 'bg-sunken/50')}>
          <div className="flex items-center gap-2"><input type="checkbox" aria-label="Select row" className="h-5 w-5 accent-[var(--accent)]" checked={r.selected} disabled={!canImport(r)} onChange={e => update(r.key, { selected: e.target.checked })} /><span className="flex flex-1 flex-wrap gap-1">{statusBadge(r)}</span>
            <Button size="icon" variant="ghost" aria-label="Remove row" onClick={() => update(r.key, { removed: true, selected: false })}><Trash2 size={15} /></Button></div>
          <div className="grid grid-cols-2 gap-2"><Input type="date" aria-label="Date" value={r.date} onChange={e => update(r.key, { date: e.target.value, edited: true })} />
            <Input aria-label="Amount (negative = outflow)" className="num text-right" inputMode="decimal" value={r.outflow ? '-' + r.outflow : r.inflow} onChange={e => { const v = e.target.value.trim(); if (v.startsWith('-')) setAmount(r, v.slice(1), ''); else setAmount(r, '', v.replace(/^\+/, '')); }} /></div>
          <Combobox aria-label="Payee" className="h-9" value={r.transferAccountId ? 't:' + r.transferAccountId : null} text={r.transferAccountId ? undefined : r.payee} options={payeeOptions} allowCreate onText={t => update(r.key, { payee: t, transferAccountId: null, edited: true })} onPick={o => update(r.key, o?.id.startsWith('t:') ? { transferAccountId: o.id.slice(2), edited: true } : { payee: o?.label ?? '', transferAccountId: null, edited: true })} />
          {account?.onBudget && !(r.transferAccountId && b.accountById.get(r.transferAccountId)?.onBudget) && <Combobox aria-label="Category" className="h-9" value={r.categoryId} placeholder="Category" options={catOptions} onPick={o => update(r.key, { categoryId: o?.id ?? null })} />}
          {(detail(r) || r.rawPayee !== r.payee) && <p className="text-[12px] text-ink-3">{r.rawPayee !== r.payee && <>Bank text: “{r.rawPayee}”. </>}{detail(r)}</p>}{rowControls(r)}</div>)}</div>
        : <div className="overflow-x-auto"><table className="w-full min-w-[940px] text-[13px]"><thead className="text-left text-[11px] uppercase tracking-wide text-ink-3"><tr><th className="w-12 py-2 pl-4"><span className="sr-only">Select</span></th><th className="w-[124px]">Date</th><th>Payee</th><th>Category</th><th className="w-[104px] text-right">Outflow</th><th className="w-[104px] text-right">Inflow</th><th className="pl-3">Status</th><th className="w-9" /></tr></thead>
          <tbody>{visible.map(r => <tr key={r.key} className={cx('border-t border-line/70 align-top', !r.selected && 'bg-sunken/40')} data-testid="import-row">
            <td className="py-2 pl-4"><input type="checkbox" aria-label="Select row" className="mt-2 accent-[var(--accent)]" checked={r.selected} disabled={!canImport(r)} title={canImport(r) ? '' : 'Complete or confirm this row first'} onChange={e => update(r.key, { selected: e.target.checked })} /></td>
            <td className="py-1.5 pr-1.5"><Input type="date" aria-label="Date" className={cx('h-8 px-1.5', !/^\d{4}-\d{2}-\d{2}$/.test(r.date) && 'border-neg')} value={r.date} onChange={e => update(r.key, { date: e.target.value, edited: true })} /></td>
            <td className="py-1.5 pr-1.5"><Combobox aria-label="Payee" value={r.transferAccountId ? 't:' + r.transferAccountId : null} text={r.transferAccountId ? undefined : r.payee} options={payeeOptions} allowCreate className={cx(!r.transferAccountId && !r.payee.trim() && 'border-neg')}
              onText={t => update(r.key, { payee: t, transferAccountId: null, edited: true })} onPick={o => update(r.key, o?.id.startsWith('t:') ? { transferAccountId: o.id.slice(2), edited: true } : { payee: o?.label ?? '', transferAccountId: null, edited: true })} />
              <div className="mt-0.5 truncate text-[11.5px] text-ink-3" title={r.rawPayee}>{r.payeeMatch === 'none' ? 'New payee' : r.payeeMatch === 'transfer' ? 'Looks like a transfer to your own account' : `“${r.rawPayee}” · ${r.payeeMatch === 'rule' ? 'rule' : r.payeeMatch} match ${Math.round(r.payeeConfidence * 100)}%`}{r.description && ` · ${r.description}`}</div></td>
            <td className="py-1.5 pr-1.5">{!account?.onBudget ? <span className="text-ink-3">—</span> : r.transferAccountId && b.accountById.get(r.transferAccountId)?.onBudget ? <span className="text-[12px] text-ink-3">Transfer — no category</span> : <>
              <Combobox aria-label="Category" value={r.categoryId} placeholder="Category" options={catOptions} onPick={o => update(r.key, { categoryId: o?.id ?? null, categorySource: 'manual' })} />
              {r.categoryId && r.categorySource !== 'manual' && r.categorySource !== 'none' && <div className="mt-0.5 text-[11.5px] text-ink-3">Suggested from {r.categorySource === 'history' ? 'your history' : r.categorySource === 'rule' ? 'a rule' : 'the file'} · {Math.round(r.categoryConfidence * 100)}%</div>}</>}</td>
            <td className="py-1.5 pr-1.5"><Input aria-label="Outflow" className={cx('num h-8 px-2 text-right', r.amount === null && 'border-neg')} inputMode="decimal" value={r.outflow} onChange={e => setAmount(r, e.target.value, e.target.value ? '' : r.inflow)} /></td>
            <td className="py-1.5 pr-1.5"><Input aria-label="Inflow" className={cx('num h-8 px-2 text-right text-pos', r.amount === null && 'border-neg')} inputMode="decimal" value={r.inflow} onChange={e => setAmount(r, e.target.value ? '' : r.outflow, e.target.value)} /></td>
            <td className="py-2 pl-3"><div className="flex flex-wrap items-center gap-1">{statusBadge(r)}<span className="text-[11.5px] text-ink-3" title="How sure the reader is about this row">{Math.round(r.confidence * 100)}%</span>{sources.length > 1 && <span className="text-[11.5px] text-ink-3">#{r.sourceIndex + 1}</span>}</div>
              {detail(r) && <div className="mt-0.5 max-w-[17rem] text-[11.5px] leading-snug text-ink-2">{detail(r)}</div>}{rowControls(r)}</td>
            <td className="py-1.5 pr-2"><Button size="icon" variant="ghost" aria-label="Remove row" title="Remove row" onClick={() => update(r.key, { removed: true, selected: false })}><Trash2 size={14} /></Button></td></tr>)}</tbody></table></div>}
        <div className="sticky bottom-0 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-b-2xl border-t border-line bg-surface px-4 py-3">
          <div className="num text-[13px]"><b>{importable.length}</b> of {visible.length} selected · Outflow <b>{b.fmt(totalOut)}</b> · Inflow <b className="text-pos">{b.fmt(totalIn)}</b> · Net <Money value={totalIn - totalOut} fmt={b.fmt} colored className="font-semibold" /></div>
          {visible.some(r => !canImport(r)) && <span className="flex items-center gap-1 text-[12.5px] text-warn"><AlertTriangle size={14} />{visible.filter(r => !canImport(r)).length} row(s) need a correction or your confirmation before they can be selected</span>}
          <Button variant="primary" size="lg" className="ml-auto" disabled={!importable.length || busy} onClick={doImport}>Import {importable.length} into {account?.name}</Button></div>
      </section>}
      {!visible.length && !busy && ready.length > 0 && !working && <p className="rounded-xl border border-line bg-surface p-5 text-center text-ink-2">No transactions could be read. Try a sharper screenshot that shows complete rows with date, text and amount — or use the JSON/CSV route.</p>}
    </div>
    <Dialog open={!!zoom} onClose={() => setZoom(null)} title={zoom?.name ?? ''} wide>{zoom?.url && <img src={zoom.url} alt="Screenshot" className="mx-auto max-h-[70vh]" />}</Dialog>
    <Dialog open={!!consent} onClose={() => setConsent(null)} title="Send this screenshot to an external AI service?" footer={<><Button onClick={() => setConsent(null)}>Cancel</Button><Button variant="primary" onClick={() => consent && runVision(consent)}>Yes, send this image</Button></>}>
      <div className="space-y-2 text-[13.5px] text-ink-2"><p>Local reading keeps everything on your device. If you continue, <b>this one image</b> — including every account detail visible in it — is sent from your server to the AI provider configured by the server owner.</p>
        <p>The image is not stored by Budget Reborn. What the provider does with it is governed by that provider’s terms. The result is validated and still needs your review before anything is imported.</p></div></Dialog>
    <Dialog open={paste !== null} onClose={() => setPaste(null)} title="Paste JSON or CSV" wide footer={<><Button onClick={() => setPaste(null)}>Cancel</Button><Button variant="primary" disabled={!paste?.trim()} onClick={() => { const t = paste!.trim().replace(/^```(?:json|csv)?\s*/i, '').replace(/```$/, '').trim(); const kind = t.startsWith('{') || t.startsWith('[') ? 'json' : 'csv';
      setSources(l => [...l, { id: nextId.current++, name: `Pasted ${kind.toUpperCase()}`, kind, status: 'done', progress: 1, payload: { kind, content: t } }]); setPaste(null); setResult(null); }}>Preview</Button></>}>
      <textarea autoFocus value={paste ?? ''} onChange={e => setPaste(e.target.value)} rows={12} spellCheck={false} placeholder={`{"schema":"${IMPORT_SCHEMA_ID}","transactions":[…]}`} className="num w-full rounded-lg border border-line-strong bg-surface p-2.5 text-[12.5px] focus:border-accent focus:outline-none" /></Dialog>
    <Dialog open={help} onClose={() => setHelp(false)} title="Import structured data (JSON, CSV, ChatGPT)" wide>
      <div className="space-y-4 text-[13.5px] text-ink-2"><p>If local text recognition struggles with a screenshot, any tool that can produce the format below works — for example uploading the screenshots to ChatGPT yourself. Budget Reborn never connects to such services; you paste or upload the result, and it goes through the same review and duplicate checks.</p>
        <div><div className="mb-1 flex items-center justify-between"><b className="text-ink">Prompt to use with your screenshots</b><Button size="sm" onClick={() => { navigator.clipboard.writeText(CHATGPT_PROMPT).then(() => toast('Prompt copied')); }}>Copy prompt</Button></div><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 text-[12px]">{CHATGPT_PROMPT}</pre></div>
        <div><b className="text-ink">JSON fields</b><ul className="mt-1 list-disc space-y-0.5 pl-5"><li><code>schema</code> — must be <code>{IMPORT_SCHEMA_ID}</code></li><li><code>date</code> — <code>YYYY-MM-DD</code> (required) · <code>booking_date</code> optional</li><li><code>payee</code> — text (required)</li>
          <li><code>amount</code> — decimal string, dot separator, negative = money out (required)</li><li><code>memo</code>, <code>category</code> (name of one of your categories), <code>import_id</code> (bank reference, prevents re-import) — optional</li></ul><p className="mt-1">Unknown fields or malformed values reject the whole file with an exact error, so a bad file can never be half-imported.</p></div>
        <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => download('/bank-import/template.json')}><Download size={14} />Example JSON</Button><Button size="sm" onClick={() => download('/bank-import/template.csv')}><Download size={14} />Example CSV</Button></div>
        <p>CSV files from your bank work too: columns such as <i>Dato, Tekst, Beløb, Saldo</i> are recognised automatically, with Danish number formats.</p></div></Dialog>
  </div>;
}
