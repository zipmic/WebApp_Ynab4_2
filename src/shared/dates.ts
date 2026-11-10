/** Dates are ISO strings: 'YYYY-MM-DD' for days, 'YYYY-MM' for budget months. No timezone math. */
export type ISODate = string;
export type Month = string;
export type DateStyle = 'auto' | 'DMY' | 'MDY' | 'YMD';

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const monthOf = (d: ISODate): Month => d.slice(0, 7);
export function addMonths(m: Month, n: number): Month {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(mo / 12), mm = ((mo % 12) + 12) % 12;
  return `${String(yy).padStart(4, '0')}-${pad2(mm + 1)}`;
}
export const nextMonth = (m: Month) => addMonths(m, 1);
export const prevMonth = (m: Month) => addMonths(m, -1);
export function monthsBetween(a: Month, b: Month): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}
export function monthRange(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}
export function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function isValidISODate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
export const isValidMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export function todayISO(now = new Date()): ISODate {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
export function addDays(d: ISODate, n: number): ISODate {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n));
  return t.toISOString().slice(0, 10);
}
export function dayDiff(a: ISODate, b: ISODate): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}

const MONTH_NAMES: Record<string, number> = {};
[['jan', 'januar', 'january'], ['feb', 'februar', 'february'], ['mar', 'marts', 'march', 'mrz'], ['apr', 'april'],
 ['maj', 'may'], ['jun', 'juni', 'june'], ['jul', 'juli', 'july'], ['aug', 'august'], ['sep', 'sept', 'september'],
 ['okt', 'oct', 'oktober', 'october'], ['nov', 'november'], ['dec', 'december', 'dez']]
  .forEach((names, i) => names.forEach(n => { MONTH_NAMES[n] = i + 1; }));
export function monthFromName(name: string): number | null {
  return MONTH_NAMES[name.toLowerCase().replace(/\.$/, '')] ?? null;
}

export interface ParsedDate { iso: ISODate; ambiguous: boolean }
const mk = (y: number, m: number, d: number): ISODate | null => {
  const iso = `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
  return isValidISODate(iso) ? iso : null;
};
const fullYear = (y: number) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/**
 * Parse a date in common formats. Ambiguity (e.g. 03/04/2015 could be 3 April or 4 March) is reported,
 * never silently guessed without flagging; `style` forces an interpretation.
 */
export function parseDate(input: string, style: DateStyle = 'auto', defaultYear?: number): ParsedDate | null {
  const s = input.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) { const iso = mk(+m[1], +m[2], +m[3]); return iso ? { iso, ambiguous: false } : null; }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) { const iso = mk(+m[1], +m[2], +m[3]); return iso ? { iso, ambiguous: false } : null; }
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4}|\d{2})$/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    const dmy = mk(y, b, a), mdy = mk(y, a, b);
    if (style === 'DMY') return dmy ? { iso: dmy, ambiguous: false } : null;
    if (style === 'MDY') return mdy ? { iso: mdy, ambiguous: false } : null;
    if (style === 'YMD') return null;
    if (dmy && mdy && dmy !== mdy) return { iso: s.includes('/') ? dmy : dmy, ambiguous: s.includes('/') };
    const iso = dmy ?? mdy; return iso ? { iso, ambiguous: false } : null;
  }
  // "8. november 2026", "8 nov 2026", "8. nov." (year optional), "November 8, 2026"
  m = /^(?:[a-zæøå]+\.?,?\s+)?(\d{1,2})\.?\s+([a-zæøå]+)\.?,?(?:\s+(\d{4}))?$/i.exec(s);
  if (m) {
    const mo = monthFromName(m[2]); const y = m[3] ? +m[3] : defaultYear;
    if (mo && y) { const iso = mk(y, mo, +m[1]); return iso ? { iso, ambiguous: !m[3] } : null; }
  }
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) { const mo = monthFromName(m[1]); if (mo) { const iso = mk(+m[3], mo, +m[2]); return iso ? { iso, ambiguous: false } : null; } }
  m = /^(\d{1,2})[-/.](\d{1,2})\.?$/.exec(s); // "08.11" without year
  if (m && defaultYear && style !== 'MDY') { const iso = mk(defaultYear, +m[2], +m[1]); return iso ? { iso, ambiguous: true } : null; }
  return null;
}

/** Decide DMY vs MDY for a whole column of dates: any value with a component > 12 settles it. */
export function detectDateStyle(samples: string[]): { style: DateStyle; ambiguous: boolean } {
  let dmy = 0, mdy = 0, ymd = 0;
  for (const s of samples) {
    const t = s.trim();
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(t)) { ymd++; continue; }
    const m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(t);
    if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dmy++; else if (+m[2] > 12 && +m[1] <= 12) mdy++;
  }
  if (ymd && !dmy && !mdy) return { style: 'YMD', ambiguous: false };
  if (dmy && !mdy) return { style: 'DMY', ambiguous: false };
  if (mdy && !dmy) return { style: 'MDY', ambiguous: false };
  return { style: 'auto', ambiguous: true };
}

/** Parse a budget month label: "2014-01", "January 2014", "jan 2014", "01/2014", "2014/01". */
export function parseMonthLabel(input: string): Month | null {
  const s = input.trim();
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad2(+m[2])}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad2(+m[1])}`;
  m = /^([a-zæøå]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m) { const mo = monthFromName(m[1]); if (mo) return `${m[2]}-${pad2(mo)}`; }
  m = /^(\d{4})\s+([a-zæøå]+)\.?$/i.exec(s);
  if (m) { const mo = monthFromName(m[2]); if (mo) return `${m[1]}-${pad2(mo)}`; }
  return null;
}
