/** Small dependency-free SVG charts with hover/focus tooltips. Colours come from the validated palette in index.css. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const OTHER = 'var(--s-other)';
export interface Series { name: string; color: string; values: number[] }
type Tip = { x: number; y: number; title: string; rows: { name: string; color?: string; value: string }[] } | null;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null); const [w, setW] = useState(640);
  useEffect(() => { if (!ref.current) return; const ro = new ResizeObserver(e => setW(Math.max(280, Math.floor(e[0].contentRect.width)))); ro.observe(ref.current); return () => ro.disconnect(); }, []);
  return [ref, w];
}
function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  const left = Math.min(window.innerWidth - 230, tip.x + 14), top = Math.max(8, tip.y - 12);
  return createPortal(<div role="tooltip" style={{ left, top }} className="pointer-events-none fixed z-[80] w-[215px] rounded-lg border border-line bg-raised px-3 py-2 text-[12.5px] shadow-xl">
    <div className="mb-1 text-ink-2">{tip.title}</div>{tip.rows.map(r => <div key={r.name} className="flex items-center gap-2"><span className="h-0.5 w-3 shrink-0 rounded" style={{ background: r.color ?? 'transparent' }} /><span className="num font-semibold">{r.value}</span><span className="truncate text-ink-2">{r.name}</span></div>)}</div>, document.body);
}
export function Legend({ series }: { series: { name: string; color: string }[] }) {
  return <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">{series.map(s => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}</div>;
}
function niceMax(v: number) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function ticks(min: number, max: number) { const lead = Number(String(Math.round(max)).replace(/0+$/, '')) ; const n = lead === 2 && min === 0 ? 4 : 5; const out: number[] = []; const step = (max - min) / n; for (let i = 0; i <= n; i++) out.push(min + step * i); return out; }
const compact = (minor: number) => { const v = minor / 100, a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)); };

/** Vertical bars per label: stacked or side-by-side. Values in minor units, all >= 0 for stacked. */
export function ColumnChart({ labels, series, fmt, mode = 'stacked', height = 260, onPick }: { labels: string[]; series: Series[]; fmt: (n: number) => string; mode?: 'stacked' | 'grouped'; height?: number; onPick?: (labelIndex: number, seriesIndex: number) => void }) {
  const [ref, w] = useWidth(); const [tip, setTip] = useState<Tip>(null); const [hot, setHot] = useState<number | null>(null);
  const m = { l: 44, r: 8, t: 8, b: 24 }, iw = w - m.l - m.r, ih = height - m.t - m.b; const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i]), 0));
  const lo = Math.min(0, ...series.flatMap(s => s.values)); const hi = niceMax(Math.max(1, ...(mode === 'stacked' ? totals : series.flatMap(s => s.values))));
  const min = lo < 0 ? -niceMax(-lo) : 0; const y = (v: number) => m.t + ih - ((v - min) / (hi - min)) * ih;
  const band = iw / Math.max(1, n), bw = Math.min(44, Math.max(3, band - (band > 14 ? 6 : 2)));
  const every = Math.ceil(n / Math.max(1, Math.floor(iw / 54)));
  const show = (e: React.PointerEvent | React.FocusEvent, i: number) => { const r = (e.currentTarget as Element).getBoundingClientRect(); setHot(i);
    setTip({ x: 'clientX' in e ? e.clientX : r.right, y: 'clientY' in e ? e.clientY : r.top, title: labels[i], rows: [...series.map(s => ({ name: s.name, color: s.color, value: fmt(s.values[i]) })), ...(mode === 'stacked' && series.length > 1 ? [{ name: 'Total', value: fmt(totals[i]) }] : [])] }); };
  return <div ref={ref}>{series.length > 1 && <Legend series={series} />}
    <svg width={w} height={height} role="img" aria-label="Bar chart; the same figures are in the table below">
      {ticks(min, hi).map(t => <g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={t === 0 ? 1.5 : 1} /><text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)" className="num">{compact(t)}</text></g>)}
      {labels.map((l, i) => { const x0 = m.l + band * i + (band - bw) / 2; let acc = 0;
        return <g key={l} tabIndex={0} onPointerMove={e => show(e, i)} onPointerLeave={() => { setTip(null); setHot(null); }} onFocus={e => show(e, i)} onBlur={() => { setTip(null); setHot(null); }} style={{ outline: 'none' }} opacity={hot === null || hot === i ? 1 : 0.55}>
          <rect x={m.l + band * i} y={m.t} width={band} height={ih} fill="transparent" />
          {series.map((s, k) => { const v = s.values[i]; if (!v) return null;
            if (mode === 'grouped') { const gw = Math.max(2, (bw - (series.length - 1) * 2) / series.length); const yy = Math.min(y(v), y(0)), hh = Math.max(1, Math.abs(y(v) - y(0)));
              return <rect key={k} x={x0 + k * (gw + 2)} y={yy} width={gw} height={hh} rx={Math.min(3, gw / 2)} fill={s.color} onClick={() => onPick?.(i, k)} style={{ cursor: onPick ? 'pointer' : undefined }} />; }
            const top = y(acc + Math.max(0, v)), bottom = y(acc); acc += Math.max(0, v); const hh = Math.max(0, bottom - top - (k > 0 ? 2 : 0));
            return hh > 0 ? <rect key={k} x={x0} y={top} width={bw} height={hh} rx={Math.min(3, bw / 2, hh / 2)} fill={s.color} onClick={() => onPick?.(i, k)} style={{ cursor: onPick ? 'pointer' : undefined }} /> : null; })}
          {i % every === 0 && <text x={m.l + band * i + band / 2} y={height - 7} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{l}</text>}</g>; })}
    </svg><Tooltip tip={tip} /></div>;
}

/** Lines over an ordered x axis with a crosshair that reads every series at once. */
export function LineChart({ labels, series, fmt, height = 260 }: { labels: string[]; series: Series[]; fmt: (n: number) => string; height?: number }) {
  const [ref, w] = useWidth(); const [tip, setTip] = useState<Tip>(null); const [at, setAt] = useState<number | null>(null);
  const direct = series.length <= 4; const m = { l: 48, r: direct ? 96 : 10, t: 10, b: 24 }, iw = w - m.l - m.r, ih = height - m.t - m.b; const n = labels.length;
  const all = series.flatMap(s => s.values); const hiRaw = Math.max(0, ...all), loRaw = Math.min(0, ...all);
  const hi = niceMax(hiRaw || 1), lo = loRaw < 0 ? -niceMax(-loRaw) : 0;
  const x = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw), y = (v: number) => m.t + ih - ((v - lo) / (hi - lo)) * ih;
  const every = Math.ceil(n / Math.max(1, Math.floor(iw / 60)));
  const move = (cx: number, cy: number, left: number) => { const i = Math.max(0, Math.min(n - 1, Math.round(((cx - left - m.l) / iw) * (n - 1)))); setAt(i); setTip({ x: cx, y: cy, title: labels[i], rows: series.map(s => ({ name: s.name, color: s.color, value: fmt(s.values[i]) })) }); };
  // spread direct labels so they never overlap
  const ends = series.map((s, k) => ({ k, y: y(s.values[n - 1] ?? 0) })).sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  return <div ref={ref}>{series.length > 1 && <Legend series={series} />}
    <svg width={w} height={height} role="img" aria-label="Line chart; the same figures are in the table below" tabIndex={0} style={{ outline: 'none', touchAction: 'pan-y' }}
      onPointerMove={e => move(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect().left)} onPointerLeave={() => { setTip(null); setAt(null); }}
      onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, (at ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))); move(r.left + x(i), r.top + 20, r.left); } }} onBlur={() => { setTip(null); setAt(null); }}>
      {ticks(lo, hi).map(t => <g key={t}><line x1={m.l} x2={m.l + iw} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={t === 0 ? 1.5 : 1} /><text x={m.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)" className="num">{compact(t)}</text></g>)}
      {labels.map((l, i) => i % every === 0 && <text key={l} x={x(i)} y={height - 7} textAnchor="middle" fontSize="11" fill="var(--ink-3)">{l}</text>)}
      {at !== null && <line x1={x(at)} x2={x(at)} y1={m.t} y2={m.t + ih} stroke="var(--ink-3)" strokeWidth="1" />}
      {series.map((s, k) => <g key={s.name}><path d={s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {at !== null && <circle cx={x(at)} cy={y(s.values[at])} r="4" fill={s.color} stroke="var(--surface)" strokeWidth="2" />}
        {direct && <text x={m.l + iw + 8} y={ends.find(e => e.k === k)!.y + 4} fontSize="11.5" fill="var(--ink-2)">{s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name}</text>}</g>)}
    </svg><Tooltip tip={tip} /></div>;
}

/** Ranked horizontal bars (one hue: the job is magnitude). */
export function BarList({ items, fmt, onPick, color = SERIES[0] }: { items: { id: string; label: string; sub?: string; value: number }[]; fmt: (n: number) => string; onPick?: (id: string) => void; color?: string }) {
  const max = Math.max(1, ...items.map(i => i.value));
  return <div className="space-y-1">{items.map(i => <button key={i.id} onClick={() => onPick?.(i.id)} title={onPick ? 'Show transactions' : undefined} className="group grid w-full grid-cols-[minmax(110px,32%)_1fr_auto] items-center gap-3 rounded-lg px-1.5 py-1 text-left text-[13px] hover:bg-sunken">
    <span className="truncate">{i.label}{i.sub && <span className="text-ink-3"> · {i.sub}</span>}</span>
    <span className="h-3.5"><span className="block h-full rounded-r-[4px] group-hover:brightness-110" style={{ width: `${Math.max(0, (i.value / max) * 100)}%`, minWidth: i.value > 0 ? 2 : 0, background: color }} /></span>
    <span className="num w-24 text-right font-medium">{fmt(i.value)}</span></button>)}</div>;
}
export function ChartCard({ title, subtitle, children, actions }: { title: string; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="rounded-2xl border border-line bg-surface p-5"><div className="mb-4 flex flex-wrap items-start justify-between gap-2"><div><h2 className="text-[15px] font-semibold">{title}</h2>{subtitle && <p className="text-[12.5px] text-ink-2">{subtitle}</p>}</div>{actions}</div>{children}</section>;
}
