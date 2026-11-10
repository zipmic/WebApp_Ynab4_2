/**
 * Exact money handling. All amounts are integers in minor currency units (øre/cents).
 * No floating-point arithmetic is ever performed on money; parsing works on digit strings.
 */
export type Minor = number;
export type DecimalStyle = 'auto' | 'comma' | 'dot';

export interface ParsedAmount { minor: Minor; ambiguous: boolean; hadSign: boolean }

const MINUS = /[−‒–—﹣－]/g;

/** Parse a human-formatted amount ("1.234,56 kr.", "-428,50", "(12.00)", "428,50-", "DKK 1,234.56"). */
export function parseAmount(input: string, style: DecimalStyle = 'auto', decimals = 2): ParsedAmount | null {
  if (input == null) return null;
  let s = String(input).replace(MINUS, '-').replace(/[\s  ']/g, '');
  if (!s) return null;
  let neg = false, hadSign = false;
  if (/^\(.*\)$/.test(s)) { neg = true; hadSign = true; s = s.slice(1, -1); }
  // strip currency words/symbols ("kr.", "DKK", "$") wherever they sit
  s = s.replace(/(?:kr\.?|dkk|eur|usd|sek|nok|gbp|chf|cad|aud|[$€£¥])/gi, '');
  if (/^[+-]/.test(s)) { hadSign = true; if (s[0] === '-') neg = !neg; s = s.slice(1); }
  if (/[+-]$/.test(s)) { hadSign = true; if (s.endsWith('-')) neg = !neg; s = s.slice(0, -1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  let intPart = s, frac = '', ambiguous = false;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  const split = (i: number) => { intPart = s.slice(0, i); frac = s.slice(i + 1); };
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    if ((style === 'comma' && dec !== ',') || (style === 'dot' && dec !== '.')) return null;
    split(Math.max(lastDot, lastComma));
    if (frac.includes('.') || frac.includes(',')) return null;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const count = s.split(sep).length - 1;
    const idx = s.lastIndexOf(sep);
    const after = s.length - idx - 1;
    const isDecimalStyle = (style === 'comma' && sep === ',') || (style === 'dot' && sep === '.');
    const isThousandStyle = (style === 'comma' && sep === '.') || (style === 'dot' && sep === ',');
    if (count > 1) {
      if (isDecimalStyle) return null; // several decimal separators
    } else if (isThousandStyle) {
      if (after !== 3) return null;
    } else if (isDecimalStyle) {
      split(idx);
    } else if (after === 3 && idx >= 1 && idx <= 3) {
      ambiguous = true; // "1.234" — thousands (assumed) or three decimals
    } else {
      split(idx);
    }
  }
  if (!validGrouping(intPart)) return null;
  intPart = intPart.replace(/[.,]/g, '');
  if (frac.length > decimals) {
    if (/^0*$/.test(frac.slice(decimals))) frac = frac.slice(0, decimals); else return null;
  }
  frac = frac.padEnd(decimals, '0');
  const digits = (intPart || '0') + frac;
  if (digits.length > 15) return null;
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return null;
  return { minor: neg ? -minor : minor, ambiguous, hadSign };
}

function validGrouping(intPart: string): boolean {
  if (!/[.,]/.test(intPart)) return true;
  if (/\./.test(intPart) && /,/.test(intPart)) return false;
  const parts = intPart.split(/[.,]/);
  if (parts[0].length < 1 || parts[0].length > 3) return false;
  return parts.slice(1).every(p => p.length === 3);
}

/** Convert a JSON number of major units (as stored by YNAB4, e.g. -12.34) to exact minor units. */
export function majorNumberToMinor(n: number, decimals = 2): Minor {
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${n}`);
  // Go through the shortest round-trip decimal string to avoid binary float artefacts.
  const fixed = n.toFixed(decimals + 3);
  const [i, f] = fixed.replace('-', '').split('.');
  const main = Number(i + f.slice(0, decimals));
  const rest = Number(f.slice(decimals));
  const rounded = rest >= 500 ? main + 1 : main;
  return n < 0 ? -rounded : rounded;
}

export interface MoneyFormat { decimalSep: ',' | '.'; groupSep: string; symbol: string; symbolFirst: boolean; decimals: number }
export const DKK_FORMAT: MoneyFormat = { decimalSep: ',', groupSep: '.', symbol: 'kr.', symbolFirst: false, decimals: 2 };

export function formatMinor(minor: Minor, f: MoneyFormat = DKK_FORMAT, withSymbol = false): string {
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(f.decimals + 1, '0');
  const int = abs.slice(0, abs.length - f.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, f.groupSep);
  const frac = f.decimals ? f.decimalSep + abs.slice(-f.decimals) : '';
  const body = int + frac;
  const out = withSymbol && f.symbol ? (f.symbolFirst ? f.symbol + body : `${body} ${f.symbol}`) : body;
  return neg ? '-' + out : out;
}

/** Plain machine format "-1234.56" used in exports and JSON schema. */
export function minorToPlain(minor: Minor, decimals = 2): string {
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(decimals + 1, '0');
  return (neg ? '-' : '') + abs.slice(0, abs.length - decimals) + (decimals ? '.' + abs.slice(-decimals) : '');
}

/** Parse user input in an amount cell. Supports simple arithmetic like "500+250" or "1200/12". */
export function parseAmountInput(input: string, f: MoneyFormat = DKK_FORMAT): Minor | null {
  const style: DecimalStyle = f.decimalSep === ',' ? 'comma' : 'dot';
  const s = input.replace(MINUS, '-').replace(/\s/g, '');
  if (!s) return null;
  // tokenise: numbers and + - * /
  const tokens: (string | number)[] = [];
  let i = 0, expectNumber = true;
  while (i < s.length) {
    const ch = s[i];
    if (expectNumber) {
      let j = i;
      if (s[j] === '-' || s[j] === '+') j++;
      while (j < s.length && /[\d.,]/.test(s[j])) j++;
      if (j === i) return null;
      const tok = s.slice(i, j);
      const lenient = parseAmount(tok, style, 6) ?? parseAmount(tok, 'auto', 6);
      if (!lenient) return null;
      tokens.push(lenient.minor); // scaled by 1e6 below
      i = j; expectNumber = false;
    } else {
      if (!'+-*/'.includes(ch)) return null;
      tokens.push(ch); i++; expectNumber = true;
    }
  }
  if (expectNumber) return null;
  // Evaluate with BigInt rational arithmetic at 6 decimals of precision, then round half away from zero.
  const SCALE = 1000000n;
  const vals: bigint[] = [BigInt(tokens[0] as number)];
  const ops: string[] = [];
  for (let k = 1; k < tokens.length; k += 2) {
    const op = tokens[k] as string, v = BigInt(tokens[k + 1] as number);
    if (op === '*') vals[vals.length - 1] = (vals[vals.length - 1] * v) / SCALE;
    else if (op === '/') { if (v === 0n) return null; vals[vals.length - 1] = (vals[vals.length - 1] * SCALE) / v; }
    else { ops.push(op); vals.push(v); }
  }
  let total = vals[0];
  ops.forEach((op, k) => { total = op === '+' ? total + vals[k + 1] : total - vals[k + 1]; });
  const unit = 10n ** BigInt(6 - f.decimals);
  const neg = total < 0n; const abs = neg ? -total : total;
  const q = (abs + unit / 2n) / unit;
  const n = Number(neg ? -q : q);
  return Number.isSafeInteger(n) ? n : null;
}
