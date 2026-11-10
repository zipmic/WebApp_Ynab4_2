/**
 * Turns bank data from outside the app into transaction *candidates*:
 *   - OCR text lines from bank screenshots (Danish layouts in particular)
 *   - bank CSV exports
 *   - the documented JSON schema (see docs/IMPORT-SCHEMA.md)
 * Nothing here ever invents a value: a field that cannot be read stays null and is reported in
 * `issues`. Blocking issues force a manual review before the row can be imported.
 */
import { parseCsv } from './csv.ts';
import { addDays, detectDateStyle, monthFromName, parseDate, todayISO, type DateStyle, type ISODate } from './dates.ts';
import { parseAmount, type DecimalStyle } from './money.ts';

export type IssueCode = 'missing_date' | 'missing_amount' | 'missing_payee' | 'amount_no_decimals' | 'amount_ambiguous' | 'sign_ambiguous'
  | 'sign_assumed' | 'year_assumed' | 'date_ambiguous' | 'future_date' | 'old_date' | 'large_amount' | 'zero_amount' | 'balance_mismatch'
  | 'low_ocr_confidence' | 'multiple_amounts' | 'unknown_category' | 'currency_mismatch' | 'ai_extracted';
/** Issues that require the user to confirm/correct the row before import. */
export const BLOCKING: ReadonlySet<IssueCode> = new Set(['missing_date', 'missing_amount', 'missing_payee', 'amount_no_decimals', 'amount_ambiguous',
  'sign_ambiguous', 'date_ambiguous', 'future_date', 'large_amount', 'zero_amount', 'balance_mismatch', 'low_ocr_confidence', 'currency_mismatch']);
export const ISSUE_TEXT: Record<IssueCode, string> = {
  missing_date: 'No date could be read', missing_amount: 'No amount could be read', missing_payee: 'No payee text could be read',
  amount_no_decimals: 'Amount has no decimals — digits may be cut off', amount_ambiguous: 'Amount format is ambiguous (thousands vs decimals)',
  sign_ambiguous: 'Cannot tell whether this is money in or out', sign_assumed: 'No sign shown; treated as money in',
  year_assumed: 'Year not shown; assumed', date_ambiguous: 'Day/month order is ambiguous', future_date: 'Date is in the future',
  old_date: 'Date is more than two years old', large_amount: 'Unusually large amount', zero_amount: 'Amount is zero',
  balance_mismatch: 'Amount does not agree with the running balance shown — likely a reading error',
  low_ocr_confidence: 'Text recognition was unsure about this row', multiple_amounts: 'Several amounts on the row; last one treated as balance',
  unknown_category: 'Category not found in this budget', ai_extracted: 'Read by an external AI service — compare with the screenshot', currency_mismatch: 'Currency differs from the budget currency',
};

export interface Candidate {
  date: ISODate | null; bookingDate: ISODate | null; payee: string; description: string;
  /** signed minor units: negative = money out */
  amount: number | null; currency: string | null; balanceAfter: number | null; accountHint: string | null;
  categoryName: string | null; importId: string | null;
  issues: IssueCode[]; confidence: number; sourceIndex: number; raw: string;
}
export interface OcrLine { text: string; confidence?: number }
export interface ParseOptions { today?: ISODate; sourceIndex?: number; decimal?: DecimalStyle; dateStyle?: DateStyle; currency?: string }

const blank = (sourceIndex: number, raw: string): Candidate => ({ date: null, bookingDate: null, payee: '', description: '', amount: null, currency: null,
  balanceAfter: null, accountHint: null, categoryName: null, importId: null, issues: [], confidence: 1, sourceIndex, raw });

// An amount token: optional sign, digits with Danish or English grouping, optional trailing minus and currency.
const CUR = '(?:kr\\.?|dkk|eur|usd|sek|nok|gbp|€|\\$|£)';
const NUM = '(?:\\d{1,3}(?:[. ]\\d{3})+|\\d+),\\d{2}|(?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2}';
const AMOUNT_RE = new RegExp(`(?:${CUR}\\s?)?([+\\-]\\s?)?(${NUM})(\\s?-)?(?:\\s?${CUR})?(?![\\d,.])`, 'gi');
const INT_AMOUNT_END = new RegExp(`(?:^|\\s)([+\\-]\\s?)?(\\d{1,3}(?:[. ]\\d{3})*|\\d+)(?:\\s?${CUR})?$`, 'i');
const DATE_PREFIX = /^(\d{1,2}[./-]\d{1,2}(?:[./-](?:\d{4}|\d{2}))?|\d{4}-\d{2}-\d{2}|\d{1,2}\.?\s+[a-zæøå]{3,9}\.?(?:\s+\d{4})?)(?=\s|$)\.?\s*/i;
const RELATIVE: Record<string, number> = { 'i dag': 0, 'idag': 0, 'today': 0, 'i går': -1, 'igår': -1, 'i gar': -1, 'yesterday': -1, 'i forgårs': -2 };

interface Tok { value: number; signed: boolean; start: number; end: number; ambiguous: boolean }
function findAmounts(line: string, decimal: DecimalStyle): Tok[] {
  const out: Tok[] = []; AMOUNT_RE.lastIndex = 0; let m: RegExpExecArray | null;
  while ((m = AMOUNT_RE.exec(line))) {
    if (m.index > 0 && /[\d.,/]/.test(line[m.index - 1])) continue; // part of a longer number/date
    const neg = !!(m[1]?.includes('-')) !== !!m[3];
    const p = parseAmount(m[2].replace(/ /g, ''), decimal);
    if (!p) continue;
    out.push({ value: neg ? -p.minor : p.minor, signed: !!m[1] || !!m[3], start: m.index, end: m.index + m[0].length, ambiguous: p.ambiguous });
  }
  return out;
}
function resolveDate(text: string, today: ISODate, style: DateStyle): { iso: ISODate; issues: IssueCode[] } | null {
  const t = text.trim().toLowerCase().replace(/^(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|man|tir|ons|tor|fre|lør|søn|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\.?,?\s+(den\s+|d\.\s*)?/, '');
  if (t in RELATIVE) return { iso: addDays(today, RELATIVE[t]), issues: [] };
  const year = +today.slice(0, 4);
  const hasYear = /\d{4}|\d{1,2}[./-]\d{1,2}[./-]\d{2}$/.test(t);
  let p = parseDate(t, style === 'auto' ? 'DMY' : style, year);
  if (!p) return null;
  const issues: IssueCode[] = [];
  if (!hasYear) { if (p.iso > addDays(today, 7)) p = parseDate(t, style === 'auto' ? 'DMY' : style, year - 1) ?? p; issues.push('year_assumed'); }
  return { iso: p.iso, issues };
}
const cleanText = (s: string) => s.replace(new RegExp(`\\s${CUR}$`, 'i'), '').replace(/^[\s|·•:;,.\-–—>]+|[\s|·•:;,\-–—>]+$/g, '').replace(/\s+/g, ' ').trim();
const isNoise = (s: string) => !/[a-zæøå0-9]{2,}/i.test(s);
/** balance / total lines that look like "text + amount" but are not transactions */
const SUMMARY = /^(saldo|disponib|til rådighed|rådighedsbeløb|balance|available|i alt|total|sum\b|beløb\b|bogført saldo|kontosaldo|primo|ultimo)/i;

/** Parse OCR'd text of one screenshot into candidates. */
export function parseBankText(lines: OcrLine[], opts: ParseOptions = {}): Candidate[] {
  const today = opts.today ?? todayISO(), src = opts.sourceIndex ?? 0, decimal = opts.decimal ?? 'auto', style = opts.dateStyle ?? 'auto';
  const out: Candidate[] = [];
  let headerDate: { iso: ISODate; issues: IssueCode[] } | null = null;
  let pendingText: { text: string; conf: number; line: number } | null = null;
  let lastRowLine = -10, sawRowBeforeDate = false, headerMode: boolean | null = null;
  const norm = lines.map(l => ({ text: l.text.replace(/[−‒–—]/g, '-').replace(/[\t ]+/g, ' ').replace(/\s+/g, ' ').trim(), conf: l.confidence ?? 100 })).filter(l => l.text);

  norm.forEach((ln, idx) => {
    let text = ln.text;
    // --- date-only line: either a group header or the date printed beneath a row
    const whole = resolveDate(text, today, style);
    if (whole && !findAmounts(text, decimal).length) {
      if (headerMode === null) headerMode = !sawRowBeforeDate;
      if (headerMode) headerDate = whole;
      else { const prev = out[out.length - 1]; if (prev && prev.date === null && idx - lastRowLine <= 2) { prev.date = whole.iso; prev.issues = [...prev.issues.filter(i => i !== 'missing_date'), ...whole.issues]; } }
      pendingText = null; return;
    }
    // --- leading date(s) on the row (second one is treated as booking/value date)
    let rowDate: { iso: ISODate; issues: IssueCode[] } | null = null, booking: ISODate | null = null;
    const dm = DATE_PREFIX.exec(text);
    if (dm) {
      const d = resolveDate(dm[1], today, style);
      if (d && !(/^\d{1,2}[.,]\d{2}$/.test(dm[1]) && text.length === dm[0].trim().length)) {
        const rest = text.slice(dm[0].length);
        // "12.50" alone is an amount, not a date; a date prefix must be followed by text
        if (rest && !/^[.,]?\d/.test(rest.slice(0, 2)) || /[a-zæøå]/i.test(dm[1]) || /\d{4}/.test(dm[1])) {
          rowDate = d; text = rest;
          const dm2 = DATE_PREFIX.exec(text);
          if (dm2 && /\d[./-]\d/.test(dm2[1])) { const d2 = resolveDate(dm2[1], today, style); if (d2 && text.slice(dm2[0].length).trim()) { booking = d2.iso; text = text.slice(dm2[0].length); } }
        }
      }
    }
    const amts = findAmounts(text, decimal);
    const mk = (payee: string, conf: number): Candidate => {
      const c = blank(src, ln.text); c.payee = cleanText(payee);
      const d = rowDate ?? headerDate;
      if (d) { c.date = d.iso; c.issues.push(...d.issues); } else c.issues.push('missing_date');
      c.bookingDate = booking;
      if (!c.payee || isNoise(c.payee)) { c.payee = c.payee && !isNoise(c.payee) ? c.payee : ''; c.issues.push('missing_payee'); }
      if (conf < 70) c.issues.push('low_ocr_confidence');
      c.confidence = conf / 100;
      return c;
    };
    if (amts.length) {
      const before = text.slice(0, amts[0].start);
      let payee = cleanText(before), conf = ln.conf;
      if (SUMMARY.test(payee) && !rowDate) { pendingText = null; return; }
      if ((!payee || isNoise(payee)) && pendingText && idx - pendingText.line === 1) { payee = pendingText.text; conf = Math.min(conf, pendingText.conf); }
      else if (!payee || isNoise(payee)) {
        // amount-only line with nothing to attach to: a balance/total line → ignore, never guess a payee
        if (!rowDate) { pendingText = null; return; }
      }
      const c = mk(payee, conf);
      const main = amts[0];
      c.amount = main.value;
      if (main.ambiguous) c.issues.push('amount_ambiguous');
      if (!main.signed) c.issues.push('sign_assumed'); // refined after the whole batch is known
      if (amts.length >= 2) { c.balanceAfter = amts[amts.length - 1].value; if (amts.length > 2) c.issues.push('multiple_amounts'); }
      const cur = new RegExp(CUR, 'i').exec(text.slice(amts[0].start > 6 ? amts[0].start - 6 : 0)); if (cur) c.currency = normCurrency(cur[0]);
      out.push(c); lastRowLine = idx; pendingText = null; sawRowBeforeDate ||= !rowDate && !headerDate;
      return;
    }
    // --- no well-formed amount. A trailing integer after a date+text is a row whose decimals were lost.
    const im = rowDate ? INT_AMOUNT_END.exec(text) : null;
    if (im && cleanText(text.slice(0, im.index))) {
      const c = mk(text.slice(0, im.index), ln.conf);
      const p = parseAmount(im[2].replace(/ /g, ''), 'comma');
      c.amount = p ? (im[1]?.includes('-') ? -p.minor : p.minor) : null;
      c.issues.push(c.amount === null ? 'missing_amount' : 'amount_no_decimals'); if (!im[1]) c.issues.push('sign_assumed');
      out.push(c); lastRowLine = idx; pendingText = null; return;
    }
    if (rowDate && cleanText(text)) { // date + text but the amount is cropped/unreadable
      const c = mk(text, ln.conf); c.issues.push('missing_amount'); out.push(c); lastRowLine = idx; pendingText = null; return;
    }
    // --- plain text line: payee for an amount on the next line, or sub-text of the previous row
    const t = cleanText(text);
    if (!t || isNoise(t)) return;
    const prev = out[out.length - 1];
    if (prev && idx - lastRowLine === 1 && !prev.description && pendingText === null) { prev.description = t; pendingText = { text: t, conf: ln.conf, line: idx }; }
    else pendingText = { text: t, conf: ln.conf, line: idx };
  });
  // a text line consumed as the payee of the following amount must not also stay as the previous row's description
  for (let i = 1; i < out.length; i++) if (out[i - 1].description && out[i - 1].description === out[i].payee) out[i - 1].description = '';
  return finalize(out, today);
}

function normCurrency(s: string): string {
  const t = s.toLowerCase().replace('.', '');
  return ({ kr: 'DKK', dkk: 'DKK', '€': 'EUR', eur: 'EUR', '$': 'USD', usd: 'USD', '£': 'GBP', gbp: 'GBP', sek: 'SEK', nok: 'NOK' } as Record<string, string>)[t] ?? t.toUpperCase();
}

/** Batch-level checks: sign plausibility, balance-chain verification, date sanity. */
export function finalize(cands: Candidate[], today: ISODate = todayISO(), budgetCurrency?: string): Candidate[] {
  const anyExplicitMinus = cands.some(c => c.amount !== null && c.amount < 0 && !c.issues.includes('sign_assumed'));
  const bySource = new Map<number, Candidate[]>();
  for (const c of cands) (bySource.get(c.sourceIndex) ?? bySource.set(c.sourceIndex, []).get(c.sourceIndex)!).push(c);
  for (const list of bySource.values()) {
    // Running balance check. Lists are newest-first (bal[i] - amt[i] = bal[i+1]) or oldest-first (bal[i] + amt[i+1] = bal[i+1]).
    const withBal = list.filter(c => c.balanceAfter !== null && c.amount !== null);
    if (withBal.length >= 2) {
      let newest = 0, oldest = 0;
      for (let i = 0; i + 1 < withBal.length; i++) {
        if (withBal[i].balanceAfter! - withBal[i].amount! === withBal[i + 1].balanceAfter!) newest++;
        if (withBal[i].balanceAfter! + withBal[i + 1].amount! === withBal[i + 1].balanceAfter!) oldest++;
      }
      const newestFirst = newest >= oldest;
      if (Math.max(newest, oldest) > 0) {
        const ok = withBal.map(() => false), checked = withBal.map(() => false);
        for (let i = 0; i + 1 < withBal.length; i++) {
          // each link verifies the amount of one specific row
          const row = newestFirst ? i : i + 1;
          const good = newestFirst ? withBal[i].balanceAfter! - withBal[i].amount! === withBal[i + 1].balanceAfter! : withBal[i].balanceAfter! + withBal[i + 1].amount! === withBal[i + 1].balanceAfter!;
          checked[row] = true; ok[row] = good;
        }
        withBal.forEach((c, i) => {
          if (checked[i] && ok[i]) { c.confidence = Math.max(c.confidence, 0.99); c.issues = c.issues.filter(x => x !== 'sign_assumed' && x !== 'sign_ambiguous' && x !== 'amount_ambiguous'); (c as any)._verified = true; }
          else if (checked[i]) c.issues.push('balance_mismatch');
        });
      }
    }
  }
  for (const c of cands) {
    if (c.amount === null && !c.issues.includes('missing_amount')) c.issues.push('missing_amount');
    if (c.amount === 0) c.issues.push('zero_amount');
    if (c.amount !== null && Math.abs(c.amount) >= 100_000_00 && !(c as any)._verified) c.issues.push('large_amount');
    // Unsigned amounts are only trusted as inflows when the same source clearly marks outflows with a minus.
    if (c.issues.includes('sign_assumed') && !anyExplicitMinus) { c.issues = c.issues.filter(x => x !== 'sign_assumed'); c.issues.push('sign_ambiguous'); }
    if (c.date && c.date > addDays(today, 1)) c.issues.push('future_date');
    if (c.date && c.date < addDays(today, -731)) c.issues.push('old_date');
    if (budgetCurrency && c.currency && c.currency !== budgetCurrency) c.issues.push('currency_mismatch');
    delete (c as any)._verified;
    c.issues = [...new Set(c.issues)];
    const penalty = c.issues.reduce((p, i) => p + (BLOCKING.has(i) ? 0.35 : 0.08), 0);
    c.confidence = Math.max(0.05, Math.round(Math.min(c.confidence, 0.97) * (1 - Math.min(0.9, penalty)) * 100) / 100);
  }
  return cands;
}
export const needsReview = (c: { issues: IssueCode[] }) => c.issues.some(i => BLOCKING.has(i));

// ------------------------------------------------------------------------------------------- CSV
const HEADERS: Record<string, string[]> = {
  date: ['dato', 'date', 'transaktionsdato', 'transaction date', 'posteringsdato', 'købsdato'],
  booking: ['bogført', 'bogføringsdato', 'bogført dato', 'booking date', 'booked', 'valør', 'valørdato', 'rentedato', 'value date'],
  payee: ['tekst', 'text', 'payee', 'modtager', 'navn', 'name', 'beskrivelse', 'description', 'posteringstekst', 'merchant', 'afsender'],
  memo: ['memo', 'note', 'notes', 'besked', 'kommentar', 'reference', 'egen note'],
  amount: ['beløb', 'amount', 'beløb i dkk', 'belob', 'sum'],
  outflow: ['outflow', 'udbetaling', 'debit', 'hævet', 'udgift', 'ud'],
  inflow: ['inflow', 'indbetaling', 'credit', 'indsat', 'indtægt', 'ind'],
  balance: ['saldo', 'balance', 'running balance'],
  category: ['category', 'kategori'], currency: ['valuta', 'currency'], importId: ['import_id', 'id', 'reference id', 'transaktions-id'], account: ['konto', 'account'],
};
export interface CsvParseResult { candidates: Candidate[]; columns: Record<string, number>; dateStyle: DateStyle; dateAmbiguous: boolean; hasHeader: boolean; delimiter?: string }

export function parseBankCsv(text: string, opts: ParseOptions = {}): CsvParseResult {
  const today = opts.today ?? todayISO(), src = opts.sourceIndex ?? 0;
  const rows = parseCsv(text);
  if (!rows.length) return { candidates: [], columns: {}, dateStyle: 'auto', dateAmbiguous: false, hasHeader: false };
  const col: Record<string, number> = {};
  const head = rows[0].map(h => h.trim().toLowerCase());
  for (const [key, names] of Object.entries(HEADERS)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[key] = i; }
  let hasHeader = col.date !== undefined || col.amount !== undefined || col.payee !== undefined;
  let body = hasHeader ? rows.slice(1) : rows;
  if (!hasHeader) { // guess by content
    const width = Math.max(...rows.map(r => r.length));
    for (let i = 0; i < width; i++) {
      const vals = body.slice(0, 20).map(r => (r[i] ?? '').trim()).filter(Boolean);
      if (!vals.length) continue;
      if (col.date === undefined && vals.every(v => parseDate(v, 'auto'))) { col.date = i; continue; }
      if (vals.every(v => /\d/.test(v) && parseAmount(v, opts.decimal ?? 'auto'))) { if (col.amount === undefined) col.amount = i; else if (col.balance === undefined) col.balance = i; continue; }
      if (col.payee === undefined && vals.some(v => /[a-zæøå]{2}/i.test(v))) col.payee = i;
    }
  }
  const det = col.date !== undefined ? detectDateStyle(body.map(r => r[col.date] ?? '')) : { style: 'auto' as DateStyle, ambiguous: false };
  const style: DateStyle = opts.dateStyle && opts.dateStyle !== 'auto' ? opts.dateStyle : det.style === 'auto' ? 'DMY' : det.style;
  const dateAmbiguous = det.ambiguous && (!opts.dateStyle || opts.dateStyle === 'auto') && body.some(r => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test((r[col.date] ?? '').trim())); // dd-mm / dd.mm are day-first by convention; only slashes are truly ambiguous
  const decimal = opts.decimal ?? 'auto';
  const get = (r: string[], k: string) => (col[k] !== undefined ? (r[col[k]] ?? '').trim() : '');
  const candidates: Candidate[] = [];
  for (const r of body) {
    if (r.every(v => !v.trim())) continue;
    const c = blank(src, r.join(' | '));
    const d = get(r, 'date'); const pd = d ? parseDate(d, style) : null;
    if (pd) { c.date = pd.iso; if (dateAmbiguous) c.issues.push('date_ambiguous'); } else c.issues.push('missing_date');
    const b = get(r, 'booking'); if (b) c.bookingDate = parseDate(b, style)?.iso ?? null;
    c.payee = get(r, 'payee'); if (!c.payee) c.issues.push('missing_payee');
    c.description = get(r, 'memo'); c.categoryName = get(r, 'category') || null; c.importId = get(r, 'importId') || null;
    c.accountHint = get(r, 'account') || null; const cur = get(r, 'currency'); if (cur) c.currency = cur.toUpperCase();
    const amt = get(r, 'amount'), outf = get(r, 'outflow'), inf = get(r, 'inflow');
    if (amt) { const p = parseAmount(amt, decimal); if (p) { c.amount = p.minor; if (p.ambiguous) c.issues.push('amount_ambiguous'); } }
    else if (outf || inf) {
      const po = outf ? parseAmount(outf, decimal) : null, pi = inf ? parseAmount(inf, decimal) : null;
      if ((outf && !po) || (inf && !pi)) c.amount = null; else { c.amount = (pi?.minor ?? 0) - Math.abs(po?.minor ?? 0); if (po?.ambiguous || pi?.ambiguous) c.issues.push('amount_ambiguous'); }
    }
    const bal = get(r, 'balance'); if (bal) c.balanceAfter = parseAmount(bal, decimal)?.minor ?? null;
    candidates.push(c);
  }
  return { candidates: finalize(candidates, today, opts.currency), columns: col, dateStyle: style, dateAmbiguous, hasHeader };
}

// ------------------------------------------------------------------------------------------- JSON schema
export const IMPORT_SCHEMA_ID = 'budget-reborn.transactions.v1';
export const IMPORT_JSON_EXAMPLE = {
  schema: IMPORT_SCHEMA_ID, account: 'Lønkonto', currency: 'DKK',
  transactions: [
    { date: '2026-11-08', payee: 'NETTO', amount: '-428.50', memo: '', category: 'Groceries' },
    { date: '2026-11-07', payee: 'SPAR', amount: '-212.95' },
    { date: '2026-11-01', booking_date: '2026-11-02', payee: 'LØN', amount: '32500.00', import_id: 'bank-ref-0001' },
  ],
};
export const IMPORT_CSV_EXAMPLE = 'date,payee,amount,memo,category\r\n2026-11-08,NETTO,-428.50,,Groceries\r\n2026-11-07,SPAR,-212.95,,\r\n2026-11-01,LØN,32500.00,Monthly salary,\r\n';

/** Strictly validates the documented JSON document. Structural errors reject the whole file. */
export function parseImportJson(text: string, opts: ParseOptions = {}): { candidates: Candidate[]; account: string | null; errors: string[] } {
  const errors: string[] = []; let doc: any;
  try { doc = JSON.parse(text); } catch (e) { return { candidates: [], account: null, errors: ['Not valid JSON: ' + (e as Error).message] }; }
  if (Array.isArray(doc)) doc = { schema: IMPORT_SCHEMA_ID, transactions: doc };
  if (!doc || typeof doc !== 'object') return { candidates: [], account: null, errors: ['Top level must be an object'] };
  if (doc.schema !== IMPORT_SCHEMA_ID) errors.push(`"schema" must be "${IMPORT_SCHEMA_ID}"`);
  if (!Array.isArray(doc.transactions)) errors.push('"transactions" must be an array');
  if (doc.currency != null && !/^[A-Z]{3}$/.test(doc.currency)) errors.push('"currency" must be a 3-letter ISO code');
  if (errors.length) return { candidates: [], account: null, errors };
  if (doc.transactions.length > 5000) return { candidates: [], account: null, errors: ['At most 5000 transactions per file'] };
  const allowed = new Set(['date', 'booking_date', 'payee', 'amount', 'memo', 'description', 'category', 'import_id', 'currency']);
  const cands: Candidate[] = [];
  doc.transactions.forEach((t: any, i: number) => {
    const at = `transactions[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) { errors.push(`${at} must be an object`); return; }
    for (const k of Object.keys(t)) if (!allowed.has(k)) errors.push(`${at}: unknown field "${k}"`);
    const c = blank(opts.sourceIndex ?? 0, JSON.stringify(t));
    if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !parseDate(t.date)) errors.push(`${at}.date must be an ISO date YYYY-MM-DD`); else c.date = t.date;
    if (t.booking_date != null) { if (typeof t.booking_date !== 'string' || !parseDate(t.booking_date, 'YMD')) errors.push(`${at}.booking_date must be YYYY-MM-DD`); else c.bookingDate = t.booking_date; }
    if (typeof t.payee !== 'string' || !t.payee.trim()) errors.push(`${at}.payee must be a non-empty string`); else c.payee = t.payee.trim().slice(0, 200);
    // amount: decimal string or number with at most 2 decimals, dot as decimal separator, negative = money out
    const a = typeof t.amount === 'number' ? String(t.amount) : t.amount;
    if (typeof a !== 'string' || !/^[+-]?\d+(\.\d{1,2})?$/.test(a.trim())) errors.push(`${at}.amount must be a decimal like "-428.50" (negative = money out)`);
    else c.amount = parseAmount(a.trim(), 'dot')!.minor;
    for (const k of ['memo', 'description', 'category', 'import_id', 'currency']) if (t[k] != null && typeof t[k] !== 'string') errors.push(`${at}.${k} must be a string`);
    c.description = String(t.memo ?? t.description ?? '').slice(0, 500); c.categoryName = t.category?.trim() || null; c.importId = t.import_id?.trim() || null;
    c.currency = t.currency ?? doc.currency ?? null;
    cands.push(c);
  });
  if (errors.length) return { candidates: [], account: null, errors: errors.slice(0, 50) };
  return { candidates: finalize(cands, opts.today, opts.currency), account: typeof doc.account === 'string' ? doc.account : null, errors: [] };
}
export { monthFromName };
