/** Payee normalisation, similarity and duplicate classification. Pure; shared by server and tests. */
import { dayDiff, type ISODate } from './dates.ts';

const NOISE = [
  /\b(visa\/?dankort|dankort|mastercard|visa|maestro|debitcard|kortk[øo]b|k[øo]b|nota|betalingsservice|pbs|mobilepay|mobile pay|apple pay|google pay|overf[øo]rsel|overforsel|bgs|lsk|ref\.?|kontaktl[øo]s|contactless|pos|www|aps|a\/s|as|ivs|dk|den)\b/g,
];
/** Lower-case, strip card/payment prefixes, dates, store numbers and punctuation. Keeps æøå. */
export function normalizePayee(raw: string): string {
  let s = raw.toLowerCase().normalize('NFKC');
  s = s.replace(/\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?/g, ' ').replace(/[*#]+/g, ' ');
  for (const re of NOISE) s = s.replace(re, ' ');
  s = s.replace(/[^a-z0-9æøåäöüéè& ]+/g, ' ').replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  return s || raw.toLowerCase().replace(/\s+/g, ' ').trim();
}
const tokens = (s: string) => s.split(' ').filter(t => t.length > 1 || /\d/.test(t));
/** 0..1 similarity of two *normalised* payee strings (token containment with a prefix bonus). */
export function payeeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb); const common = ta.filter(t => sb.has(t)).length;
  const containment = common / Math.min(ta.length, tb.length);
  const jaccard = common / (new Set([...ta, ...tb]).size);
  let score = 0.6 * containment + 0.4 * jaccard;
  const ca = a.replace(/ /g, ''), cb = b.replace(/ /g, '');
  if (ca.length >= 4 && cb.length >= 4 && (ca.startsWith(cb) || cb.startsWith(ca))) score = Math.max(score, 0.85);
  if (score < 0.5 && ta[0] === tb[0] && ta[0].length >= 4) score = Math.max(score, 0.6);
  return Math.min(1, score);
}

export type DuplicateStatus = 'new' | 'possible_duplicate' | 'likely_duplicate' | 'needs_review';
export interface DupCandidate { date: ISODate | null; amount: number | null; payeeNorm: string; importId?: string | null; sourceIndex: number }
export interface DupExisting { id: string; date: ISODate; amount: number; payeeNorm: string; importId: string | null; isTransfer: boolean }
export interface DupVerdict { status: DuplicateStatus; reason: string; matchIds: string[] }

const SIM = 0.5;
/**
 * Classify each candidate. Multiset semantics throughout: two identical coffees on one day are two
 * transactions, but the same row appearing in two overlapping screenshots is one.
 */
export function classifyDuplicates(cands: DupCandidate[], existing: DupExisting[], dayWindow = 3): DupVerdict[] {
  const out: DupVerdict[] = cands.map(() => ({ status: 'new', reason: '', matchIds: [] }));
  const byImportId = new Map(existing.filter(e => e.importId).map(e => [e.importId!, e]));
  const active: number[] = [];
  cands.forEach((c, i) => {
    if (c.date === null || c.amount === null) { out[i] = { status: 'needs_review', reason: 'Date or amount is missing', matchIds: [] }; return; }
    const hit = c.importId ? byImportId.get(c.importId) : undefined;
    if (hit) { out[i] = { status: 'likely_duplicate', reason: 'Already imported (same import id)', matchIds: [hit.id] }; return; }
    active.push(i);
  });
  // 1. overlap between sources (screenshots) in this batch
  const groups = new Map<string, number[]>();
  for (const i of active) { const c = cands[i]; const k = `${c.date}|${c.amount}|${c.payeeNorm}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); }
  const survivors: number[] = [];
  for (const idxs of groups.values()) {
    const bySource = new Map<number, number[]>();
    for (const i of idxs) (bySource.get(cands[i].sourceIndex) ?? bySource.set(cands[i].sourceIndex, []).get(cands[i].sourceIndex)!).push(i);
    let kept = 0;
    for (const s of [...bySource.keys()].sort((a, b) => a - b)) {
      const list = bySource.get(s)!;
      const dupCount = Math.min(kept, list.length);
      list.slice(0, dupCount).forEach(i => { out[i] = { status: 'likely_duplicate', reason: 'Same transaction appears in another screenshot/file of this import (overlap)', matchIds: [] }; });
      survivors.push(...list.slice(dupCount));
      kept = Math.max(kept, list.length);
    }
  }
  // 2. against existing transactions
  const byAmount = new Map<number, DupExisting[]>();
  for (const e of existing) (byAmount.get(e.amount) ?? byAmount.set(e.amount, []).get(e.amount)!).push(e);
  const used = new Set<string>();
  const take = (c: DupCandidate, pred: (e: DupExisting) => boolean) => {
    const e = (byAmount.get(c.amount!) ?? []).find(x => !used.has(x.id) && pred(x)); if (e) used.add(e.id); return e;
  };
  survivors.sort((a, b) => a - b);
  const pending: number[] = [];
  for (const i of survivors) { // pass 1: strong matches first so they are not stolen by weaker ones
    const c = cands[i];
    const e = take(c, x => x.date === c.date && !x.isTransfer && payeeSimilarity(c.payeeNorm, x.payeeNorm) >= SIM);
    if (e) out[i] = { status: 'likely_duplicate', reason: 'Same date, amount and payee already exist in this account', matchIds: [e.id] };
    else pending.push(i);
  }
  for (const i of pending) {
    const c = cands[i];
    let e = take(c, x => x.date === c.date);
    if (e) { out[i] = { status: 'possible_duplicate', reason: e.isTransfer ? 'A transfer with the same date and amount already exists in this account' : 'Same date and amount exist with a different payee', matchIds: [e.id] }; continue; }
    e = take(c, x => Math.abs(dayDiff(c.date!, x.date)) <= dayWindow && (x.isTransfer || !c.payeeNorm || !x.payeeNorm || payeeSimilarity(c.payeeNorm, x.payeeNorm) >= SIM));
    if (e) { out[i] = { status: 'possible_duplicate', reason: `Same amount and similar payee ${Math.abs(dayDiff(c.date!, e.date))} day(s) apart (booking date difference?)`, matchIds: [e.id] }; continue; }
    // identical rows of which only some matched existing transactions: a human has to decide
    const k = `${c.date}|${c.amount}|${c.payeeNorm}`;
    const siblings = groups.get(k)!.filter(j => out[j].status === 'likely_duplicate' && out[j].matchIds.length);
    if (siblings.length) out[i] = { status: 'needs_review', reason: `Repeated transaction: ${siblings.length} identical one(s) already exist, this one may be new`, matchIds: siblings.flatMap(j => out[j].matchIds) };
  }
  return out;
}
