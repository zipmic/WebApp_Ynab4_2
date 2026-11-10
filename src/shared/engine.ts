/**
 * YNAB4-compatible budget engine. Pure functions, integer minor units only.
 *
 * Rules implemented (see docs/YNAB4-RULES.md for sources and decisions):
 *  - Category Available(M) = carry-in + Budgeted(M) + Activity(M).
 *  - A positive Available rolls into the same category next month.
 *  - A negative Available (overspending) is, by default, NOT carried in the category: the category
 *    restarts at zero and the amount is deducted from NEXT month's Available to Budget
 *    ("Overspent in <prev month>"). This is YNAB4 behaviour for cash AND credit overspending alike —
 *    YNAB4 has no credit-card payment categories.
 *  - "Red arrow": a category may instead be set to carry its negative balance forward
 *    ("Subtract it from next month's category balance" = `confined`). The choice is stored on a
 *    category-month and stays in force for later months until changed.
 *  - Available to Budget(M) = ATB(M-1) [may be negative: "overbudgeted"] − Overspent(M-1)
 *                             + Income for M − Budgeted in M.
 *  - Income for M = inflows categorised "Available this month" dated in M
 *                 + inflows categorised "Available next month" dated in M-1.
 *  - Budgeting in a future month reduces only that month's (and later) Available to Budget,
 *    never the current month's (unlike subscription YNAB).
 */
import { type Month, nextMonth } from './dates.ts';

export const INCOME_THIS = 'income:this';
export const INCOME_NEXT = 'income:next';
export type OverspendingHandling = 'affects_buffer' | 'confined';

export interface EngineInput {
  /** budgetable category ids (hidden ones included; income categories excluded) */
  categoryIds: string[];
  /** activity aggregated per month+category from on-budget transactions (income categories included) */
  activity: { month: Month; categoryId: string; amount: number }[];
  budgets: { month: Month; categoryId: string; budgeted: number; overspending: OverspendingHandling | null }[];
  /** compute at least through this month */
  through: Month;
}

export interface CategoryMonth {
  budgeted: number; activity: number; carryIn: number; available: number;
  /** effective handling in this month */
  handling: OverspendingHandling;
  /** explicitly set on this month (vs inherited) */
  handlingExplicit: boolean;
}
export interface MonthResult {
  month: Month;
  /** ATB carried from the previous month ("Not budgeted in <prev>", negative = overbudgeted) */
  carriedAtb: number;
  /** overspending of the previous month deducted here (>= 0) */
  overspentPrev: number;
  income: number;
  budgeted: number;
  activity: number;
  availableToBudget: number;
  /** this month's overspending that will hit next month's ATB (>= 0) */
  overspent: number;
  /** sum of category available balances */
  totalAvailable: number;
  categories: Map<string, CategoryMonth>;
}
export interface EngineResult { first: Month; last: Month; months: Map<Month, MonthResult> }

export function computeBudget(input: EngineInput): EngineResult {
  const catSet = new Set(input.categoryIds);
  const act = new Map<Month, Map<string, number>>();
  const incomeThis = new Map<Month, number>(), incomeNext = new Map<Month, number>();
  let first: Month | null = null, last: Month = input.through;
  const see = (m: Month) => { if (first === null || m < first) first = m; if (m > last) last = m; };
  for (const a of input.activity) {
    if (!Number.isSafeInteger(a.amount)) throw new Error('Non-integer activity amount');
    if (a.categoryId === INCOME_THIS) { incomeThis.set(a.month, (incomeThis.get(a.month) ?? 0) + a.amount); see(a.month); }
    else if (a.categoryId === INCOME_NEXT) { incomeNext.set(a.month, (incomeNext.get(a.month) ?? 0) + a.amount); see(a.month); see(nextMonth(a.month)); }
    else if (catSet.has(a.categoryId)) {
      let mm = act.get(a.month); if (!mm) act.set(a.month, (mm = new Map()));
      mm.set(a.categoryId, (mm.get(a.categoryId) ?? 0) + a.amount); see(a.month);
    }
  }
  const bud = new Map<Month, Map<string, { budgeted: number; overspending: OverspendingHandling | null }>>();
  for (const b of input.budgets) {
    if (!catSet.has(b.categoryId)) continue;
    if (!Number.isSafeInteger(b.budgeted)) throw new Error('Non-integer budget amount');
    if (b.budgeted === 0 && b.overspending === null) continue;
    let mm = bud.get(b.month); if (!mm) bud.set(b.month, (mm = new Map()));
    mm.set(b.categoryId, b); see(b.month);
  }
  if (first === null) first = input.through;
  if (first > last) last = first;

  const months = new Map<Month, MonthResult>();
  const carry = new Map<string, number>();
  const handling = new Map<string, OverspendingHandling>();
  let atb = 0, overspentPrev = 0;
  for (let m: Month = first; m <= last; m = nextMonth(m)) {
    const mAct = act.get(m), mBud = bud.get(m);
    const cats = new Map<string, CategoryMonth>();
    let budgeted = 0, activity = 0, overspent = 0, totalAvailable = 0;
    for (const id of input.categoryIds) {
      const b = mBud?.get(id);
      const explicit = b?.overspending ?? null;
      if (explicit) handling.set(id, explicit);
      const h = handling.get(id) ?? 'affects_buffer';
      const carryIn = carry.get(id) ?? 0;
      const cb = b?.budgeted ?? 0, ca = mAct?.get(id) ?? 0;
      const available = carryIn + cb + ca;
      budgeted += cb; activity += ca; totalAvailable += available;
      if (available < 0 && h === 'affects_buffer') { overspent += -available; carry.set(id, 0); }
      else carry.set(id, available);
      cats.set(id, { budgeted: cb, activity: ca, carryIn, available, handling: h, handlingExplicit: explicit !== null });
    }
    const prev = prevOf(m);
    const income = (incomeThis.get(m) ?? 0) + (incomeNext.get(prev) ?? 0);
    const carriedAtb = atb;
    atb = carriedAtb - overspentPrev + income - budgeted;
    months.set(m, { month: m, carriedAtb, overspentPrev, income, budgeted, activity, availableToBudget: atb, overspent, totalAvailable, categories: cats });
    overspentPrev = overspent;
  }
  return { first, last, months };
}

function prevOf(m: Month): Month {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7);
  return mo === 1 ? `${String(y - 1).padStart(4, '0')}-12` : `${m.slice(0, 4)}-${String(mo - 1).padStart(2, '0')}`;
}

/**
 * Global identity of the engine, used as an invariant check:
 *   on-budget cash (through end of M, counting only categorised transactions and counting
 *   "income next month" only once it becomes available)
 *     = Available to Budget(M) + Σ category Available(M) [positive and confined-negative as-is]
 * Unconfined overspending is "unfunded" until next month, hence it stays inside Σ Available here.
 */
export function checkMonthIdentity(r: MonthResult, budgetCashThroughMonth: number): { ok: boolean; expected: number; actual: number } {
  const actual = r.availableToBudget + r.totalAvailable;
  return { ok: actual === budgetCashThroughMonth, expected: budgetCashThroughMonth, actual };
}
