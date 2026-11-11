import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, useIsMobile, useToasts } from '../lib/store';

/** class names with later Tailwind utilities overriding earlier conflicting ones */
export const cx = (...a: ClassValue[]) => twMerge(clsx(a));
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' | 'icon' };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(({ variant = 'secondary', size = 'md', className, ...p }, ref) => (
  <button ref={ref} type="button" {...p} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none select-none whitespace-nowrap',
    size === 'sm' && 'h-7 px-2.5 text-[13px]', size === 'md' && 'h-9 px-3.5', size === 'lg' && 'h-11 px-5 text-[15px]', size === 'icon' && 'h-8 w-8',
    variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110', variant === 'secondary' && 'border border-line-strong bg-surface hover:bg-sunken',
    variant === 'ghost' && 'hover:bg-sunken text-ink-2 hover:text-ink', variant === 'danger' && 'bg-neg text-white hover:brightness-110', className)} />
));
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} {...p} className={cx('h-9 w-full rounded-lg border border-line-strong bg-surface px-2.5 placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25', className)} />
));
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div><label className="block"><span className="mb-1 block text-[12px] font-medium text-ink-2">{label}</span>{children}</label>{hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}</div>;
}
export function Select({ value, onChange, options, className, ...rest }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; 'aria-label'?: string; disabled?: boolean }) {
  return <select {...rest} value={value} onChange={e => onChange(e.target.value)} className={cx('h-9 rounded-lg border border-line-strong bg-surface px-2 focus:border-accent focus:outline-none', className)}>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'pos' | 'neg' | 'warn' | 'accent'; children: ReactNode; title?: string }) {
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium leading-4 whitespace-nowrap',
    tone === 'neutral' && 'bg-sunken text-ink-2', tone === 'pos' && 'bg-pos-soft text-pos', tone === 'neg' && 'bg-neg-soft text-neg', tone === 'warn' && 'bg-warn-soft text-warn', tone === 'accent' && 'bg-accent-soft text-accent')}>{children}</span>;
}

/** Modal dialog; becomes a bottom sheet on phones. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const mobile = useIsMobile();
  useEffect(() => { if (!open) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }; window.addEventListener('keydown', f, true); return () => window.removeEventListener('keydown', f, true); }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 md:items-center md:p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true">
      <div className={cx('flex max-h-[92dvh] w-full flex-col bg-raised shadow-2xl', mobile ? 'sheet-in rounded-t-2xl safe-b' : 'anim-in rounded-2xl border border-line', wide ? 'md:max-w-3xl' : 'md:max-w-md')}>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5"><h2 className="text-[15px] font-semibold">{title}</h2><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X size={16} /></Button></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>, document.body);
}

/** Anchored floating panel rendered in a portal (so it is never clipped by scrolling tables). */
export function Popover({ anchor, open, onClose, children, align = 'start', width }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null); const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect(); const w = width ?? Math.max(r.width, 220); const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
      const up = below < 200 && above > below; const maxH = Math.min(360, up ? above : below);
      const h = Math.min(ref.current?.offsetHeight ?? maxH, maxH);
      setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, align === 'end' ? r.right - w : r.left)), top: up ? r.top - h - 4 : r.bottom + 4, maxH });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, anchor, align, width, children]);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f);
  }, [open, anchor, onClose]);
  if (!open || !anchor) return null;
  return createPortal(<div ref={ref} style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: width ?? Math.max(anchor.getBoundingClientRect().width, 220), maxHeight: pos?.maxH, zIndex: 60 }}
    className="anim-in overflow-y-auto rounded-xl border border-line bg-raised p-1 shadow-xl">{children}</div>, document.body);
}
export function Menu({ trigger, items, align = 'end' }: { trigger: (p: { onClick: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode; align?: 'start' | 'end';
  items: ({ label: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; icon?: ReactNode } | 'sep' | false | null)[] }) {
  const [el, setEl] = useState<HTMLElement | null>(null); const [open, setOpen] = useState(false);
  return <>{trigger({ onClick: () => setOpen(o => !o), ref: setEl })}
    <Popover anchor={el} open={open} onClose={() => setOpen(false)} align={align} width={230}>
      {items.filter(Boolean).map((it, i) => it === 'sep' ? <div key={i} className="my-1 h-px bg-line" /> : (
        <button key={i} disabled={(it as any).disabled} onClick={() => { setOpen(false); (it as any).onClick(); }}
          className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-sunken disabled:opacity-40', (it as any).danger && 'text-neg')}>{(it as any).icon}{(it as any).label}</button>))}
    </Popover></>;
}

export interface Option { id: string; label: string; group?: string; hint?: string; muted?: boolean }
/** Autocomplete text box. Free text is allowed when `allowCreate`; otherwise the value snaps to an option or empty. */
export function Combobox({ value, text, options, onPick, onText, placeholder, allowCreate, autoFocus, className, onKeyDown, inputRef, 'aria-label': ariaLabel, disabled }: {
  value: string | null; text?: string; options: Option[]; onPick: (o: Option | null) => void; onText?: (t: string) => void; placeholder?: string; allowCreate?: boolean; autoFocus?: boolean;
  className?: string; onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void; inputRef?: React.Ref<HTMLInputElement>; 'aria-label'?: string; disabled?: boolean }) {
  const selected = useMemo(() => options.find(o => o.id === value) ?? null, [options, value]);
  const [q, setQ] = useState<string | null>(null); const [open, setOpen] = useState(false); const [hi, setHi] = useState(0);
  const [el, setEl] = useState<HTMLInputElement | null>(null); const listRef = useRef<HTMLDivElement>(null);
  const shown = q ?? text ?? selected?.label ?? '';
  const matches = useMemo(() => {
    const s = (q ?? '').trim().toLowerCase(); if (!s) return options.slice(0, 200);
    const starts: Option[] = [], contains: Option[] = [];
    for (const o of options) { const l = o.label.toLowerCase(); if (l.startsWith(s)) starts.push(o); else if (l.includes(s) || o.group?.toLowerCase().includes(s)) contains.push(o); if (starts.length > 200) break; }
    return [...starts, ...contains].slice(0, 200);
  }, [options, q]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[data-hi="1"]')?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);
  const commit = (o: Option | null) => { onPick(o); setQ(null); setOpen(false); };
  const settle = () => {
    if (q === null) { setOpen(false); return; }
    const exact = options.find(o => o.label.toLowerCase() === q.trim().toLowerCase());
    if (exact) commit(exact); else if (!q.trim()) commit(null); else if (allowCreate) { onText?.(q.trim()); setQ(null); setOpen(false); } else if (matches.length && open) commit(matches[hi] ?? matches[0]); else { setQ(null); setOpen(false); }
  };
  let lastGroup: string | undefined;
  return <>
    <input ref={n => { setEl(n); if (typeof inputRef === 'function') inputRef(n); else if (inputRef) (inputRef as any).current = n; }} aria-label={ariaLabel} disabled={disabled} autoFocus={autoFocus} value={shown} placeholder={placeholder} autoComplete="off" spellCheck={false}
      className={cx('h-8 w-full rounded-md border border-line-strong bg-surface px-2 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25', className)}
      onFocus={e => { e.target.select(); setOpen(true); }} onChange={e => { setQ(e.target.value); setOpen(true); }} onBlur={() => settle()}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(matches.length - 1, h + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
        else if ((e.key === 'Enter' || e.key === 'Tab') && open && q !== null && q.trim() && matches.length && !(allowCreate && !matches.some(m => m.label.toLowerCase().startsWith(q.trim().toLowerCase())))) { commit(matches[hi] ?? matches[0]); if (e.key === 'Enter') { e.preventDefault(); return; } }
        else if (e.key === 'Escape' && open && q !== null) { e.stopPropagation(); setQ(null); setOpen(false); return; }
        onKeyDown?.(e);
      }} />
    <Popover anchor={el} open={open && !disabled && (matches.length > 0 || (!!allowCreate && !!q?.trim()))} onClose={() => setOpen(false)}>
      <div ref={listRef}>
        {allowCreate && q?.trim() && !options.some(o => o.label.toLowerCase() === q.trim().toLowerCase()) && <div className="px-2.5 py-1.5 text-[12px] text-ink-3">Press Enter to use “{q.trim()}”</div>}
        {matches.map((o, i) => { const head = o.group !== lastGroup ? o.group : undefined; lastGroup = o.group;
          return <div key={o.id}>{head && <div className="px-2.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{head}</div>}
            <div data-hi={i === hi ? 1 : 0} onMouseDown={e => { e.preventDefault(); commit(o); }} onMouseEnter={() => setHi(i)}
              className={cx('flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5', i === hi && 'bg-accent-soft', o.muted && 'text-ink-3')}><span className="truncate">{o.label}</span>{o.hint && <span className="num shrink-0 text-[12px] text-ink-3">{o.hint}</span>}</div></div>; })}
      </div>
    </Popover></>;
}

export function Toasts() {
  const list = useToasts();
  return createPortal(<div className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-3 md:bottom-6">
    {list.map(t => <div key={t.id} role="status" className={cx('anim-in pointer-events-auto flex max-w-lg items-center gap-3 rounded-xl px-4 py-2.5 text-[13.5px] shadow-xl', t.kind === 'error' ? 'bg-neg text-white' : 'bg-ink text-bg')}>
      <span>{t.text}</span>{t.action && <button className="font-semibold underline" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
      <button aria-label="Dismiss" className="opacity-70 hover:opacity-100" onClick={() => dismissToast(t.id)}><X size={14} /></button></div>)}
  </div>, document.body);
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-16 text-center"><div className="text-[15px] font-semibold">{title}</div>{children && <p className="text-ink-2">{children}</p>}{action && <div className="mt-3">{action}</div>}</div>;
}
export function Money({ value, fmt, colored, className }: { value: number; fmt: (n: number) => string; colored?: boolean; className?: string }) {
  return <span className={cx('num', colored && value < 0 && 'text-neg', colored && value > 0 && 'text-pos', className)}>{fmt(value)}</span>;
}
export function Confirm({ open, title, children, confirmLabel = 'Confirm', danger, onConfirm, onClose }: { open: boolean; title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button></>}><div className="text-ink-2">{children}</div></Dialog>;
}
