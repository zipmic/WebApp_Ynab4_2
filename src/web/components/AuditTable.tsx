import { Check, CircleSlash, Info, TriangleAlert, XCircle } from 'lucide-react';
import { cx } from './ui';

export interface AuditArea { area: string; status: 'PASS' | 'FAIL' | 'PARTIAL' | 'INFO'; source: number | null; imported: number | null; detail: string; examples: string[] }
export interface MigrationAudit { verdict: 'PASS' | 'FAIL' | 'PARTIAL'; areas: AuditArea[]; skipped: { kind: string; count: number; reason: string }[]; unrecognizedFields: Record<string, string[]> }

const ICON = { PASS: <Check size={16} className="text-pos" />, FAIL: <XCircle size={16} className="text-neg" />, PARTIAL: <TriangleAlert size={16} className="text-warn" />, INFO: <Info size={16} className="text-ink-3" /> };
const VERDICT = { PASS: 'Every area matches the source', PARTIAL: 'All financial areas match; some non-financial details differ', FAIL: 'Differences found — do not rely on the numbers until they are explained' };

/** Independent record-by-record audit of a native YNAB4 import (see src/server/migrationAudit.ts). */
export function AuditTable({ audit }: { audit: MigrationAudit }) {
  return <section className="rounded-2xl border border-line bg-surface p-5" data-testid="migration-audit">
    <div className="mb-1 flex flex-wrap items-center gap-2"><h2 className="text-[15px] font-semibold">Independent audit against the original files</h2>
      <span className={cx('rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold', audit.verdict === 'PASS' ? 'bg-pos-soft text-pos' : audit.verdict === 'FAIL' ? 'bg-neg-soft text-neg' : 'bg-warn-soft text-warn')}>{audit.verdict}</span></div>
    <p className="mb-3 text-[12.5px] text-ink-3">{VERDICT[audit.verdict]}. Every record of the YNAB4 file was compared with the imported budget, and every month was recalculated by a separate reference calculation.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-[13px]">
      <thead className="text-left text-[11px] uppercase tracking-wide text-ink-3"><tr><th className="w-7 pb-1.5" /><th className="pb-1.5">Area</th><th className="whitespace-nowrap pl-3 text-right">In file</th><th className="whitespace-nowrap pl-3 text-right">Imported</th><th className="pl-4">Result</th></tr></thead>
      <tbody>{audit.areas.map(a => <tr key={a.area} className="border-t border-line/70 align-top" data-status={a.status}>
        <td className="py-1.5">{a.status === 'INFO' && a.source === null && a.imported === null ? <CircleSlash size={15} className="text-ink-3" /> : ICON[a.status]}</td>
        <td className="py-1.5 pr-3 font-medium">{a.area}</td>
        <td className="num py-1.5 text-right text-ink-2">{a.source?.toLocaleString() ?? ''}</td><td className="num py-1.5 text-right text-ink-2">{a.imported?.toLocaleString() ?? ''}</td>
        <td className={cx('py-1.5 pl-4', a.status === 'FAIL' ? 'text-neg' : 'text-ink-2')}>{a.detail}
          {a.status !== 'PASS' && a.examples.length > 0 && <details className="mt-0.5"><summary className="cursor-pointer text-[12px] text-accent">Show {a.examples.length} reference(s)</summary>
            <ul className="mt-1 space-y-0.5 text-[12px] text-ink-3">{a.examples.map(e => <li key={e} className="break-all">{e}</li>)}</ul></details>}</td></tr>)}</tbody></table></div>
    {audit.skipped.length > 0 && <p className="mt-3 text-[12.5px] text-ink-3">Not imported by design: {audit.skipped.map(s => `${s.count.toLocaleString()} ${s.kind}${s.count === 1 ? '' : 's'} (${s.reason})`).join('; ')}.</p>}
  </section>;
}
