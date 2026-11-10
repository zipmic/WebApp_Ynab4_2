/**
 * Reader for YNAB4 "Export" CSV files: "<Budget> as of <date>-Register.csv" and "...-Budget.csv".
 * Columns are located by header name. Register: Account, Flag, Check Number, Date, Payee, Category,
 * Master Category, Sub Category, Memo, Outflow, Inflow, Cleared, Running Balance.
 * Budget: Month, Category, Master Category, Sub Category, Budgeted, Outflows, Category Balance.
 *
 * CSV exports carry no identifiers, so transfers are re-paired and splits re-assembled from their
 * textual form; everything that had to be inferred is reported in `warnings`/`coverage`.
 */
import { parseCsv } from './csv.ts';
import { detectDateStyle, parseDate, parseMonthLabel, type DateStyle, type Month } from './dates.ts';
import { parseAmount, type DecimalStyle } from './money.ts';
import { SID_INCOME_NEXT, SID_INCOME_THIS, type ImportModel, type ImportWarning, type ImTxn } from './importModel.ts';
import type { AccountType, Cleared, Flag } from './types.ts';
import { FLAGS } from './types.ts';

export type Ynab4CsvKind = 'register' | 'budget' | null;
export function detectYnab4Csv(text: string): Ynab4CsvKind {
  const first = parseCsv(text.slice(0, 4000))[0]?.map(h => h.trim().toLowerCase()) ?? [];
  const has = (...n: string[]) => n.every(x => first.includes(x));
  if (has('account', 'payee', 'outflow', 'inflow')) return 'register';
  if (has('month', 'budgeted') && (first.includes('category balance') || first.includes('outflows'))) return 'budget';
  return null;
}
export interface Ynab4CsvOptions { dateStyle?: DateStyle; decimal?: DecimalStyle; budgetName?: string;
  /** user corrections from the preview step, keyed by account name */
  accounts?: Record<string, { type?: AccountType; onBudget?: boolean; closed?: boolean }> }

const TRANSFER_RE = /^Transfer\s*:\s*(.+)$/i;
const SPLIT_RE = /^\(Split (\d+)\/(\d+)\)\s?/i;

export function parseYnab4Csv(input: { register: string; budget?: string | null }, opts: Ynab4CsvOptions = {}): ImportModel {
  const warnings: ImportWarning[] = [];
  const model: ImportModel = { kind: 'ynab4-csv', budgetName: opts.budgetName ?? 'Imported YNAB4 budget', currency: null, accounts: [], groups: [], categories: [], payees: [], transactions: [],
    budgets: [], monthNotes: [], scheduled: [], warnings, expected: { accountBalances: [], monthly: [], transactionCount: 0, categoryBalances: [] }, coverage: [] };
  const rows = parseCsv(input.register);
  if (rows.length < 1) throw new Error('Register file is empty.');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const ix = (n: string) => head.indexOf(n);
  const C = { account: ix('account'), flag: ix('flag'), check: ix('check number'), date: ix('date'), payee: ix('payee'), category: ix('category'), master: ix('master category'),
    sub: ix('sub category'), memo: ix('memo'), outflow: ix('outflow'), inflow: ix('inflow'), cleared: ix('cleared'), running: ix('running balance') };
  for (const k of ['account', 'date', 'payee', 'outflow', 'inflow'] as const) if (C[k] < 0) throw new Error(`Register file is missing the "${k}" column — is this a YNAB4 Register export?`);
  const body = rows.slice(1);

  // ---- formats
  const det = detectDateStyle(body.map(r => r[C.date] ?? ''));
  let style: DateStyle = opts.dateStyle && opts.dateStyle !== 'auto' ? opts.dateStyle : det.style;
  if (style === 'auto') {
    style = 'DMY';
    if (body.some(r => /^\d{1,2}[-/. ]\d{1,2}[-/. ]\d{2,4}$/.test((r[C.date] ?? '').trim())))
      warnings.push({ level: 'error', code: 'date_order_ambiguous', message: 'Every date in the file could be read as day/month or month/day. Choose the date order explicitly before importing.' });
  }
  let decimal: DecimalStyle = opts.decimal ?? 'auto';
  if (decimal === 'auto') {
    let comma = 0, dot = 0;
    for (const r of body) for (const i of [C.outflow, C.inflow]) { const v = (r[i] ?? '').replace(/[^\d.,]/g, ''); if (/,\d{1,2}$/.test(v)) comma++; else if (/\.\d{1,2}$/.test(v)) dot++; }
    if (comma && dot) warnings.push({ level: 'error', code: 'decimal_mixed', message: 'Amounts use both comma and dot as decimal separator. Choose the number format explicitly.' });
    decimal = comma >= dot && comma > 0 ? 'comma' : dot > 0 ? 'dot' : 'auto';
  }
  const money = (s: string | undefined): number | null => { const t = (s ?? '').trim(); if (!t) return 0; return parseAmount(t, decimal)?.minor ?? null; };
  const sym = /[^\d.,\-\s()+]+/.exec(body.find(r => /\d/.test(r[C.outflow] ?? ''))?.[C.outflow] ?? '')?.[0]?.trim().toLowerCase();
  model.currency = sym ? ({ 'kr': 'DKK', 'kr.': 'DKK', 'dkk': 'DKK', '$': 'USD', '€': 'EUR', '£': 'GBP' } as Record<string, string>)[sym] ?? null : null;

  // ---- categories
  const groupSid = new Map<string, string>(); const catSid = new Map<string, string>();
  const ensureGroup = (name: string) => { let s = groupSid.get(name); if (!s) { s = 'g:' + name; groupSid.set(name, s); model.groups.push({ sid: s, name, hidden: false, note: '' }); } return s; };
  const mapCat = (master: string, sub: string, full: string): string | null => {
    master = master.trim(); sub = sub.trim();
    if (!master && !sub && full.trim()) { const i = full.indexOf(':'); if (i > 0) { master = full.slice(0, i).trim(); sub = full.slice(i + 1).trim(); } else sub = full.trim(); }
    if (!master && !sub) return null;
    if (/^income$/i.test(master)) { if (/next month/i.test(sub)) return SID_INCOME_NEXT; if (/this month/i.test(sub) || !sub) return SID_INCOME_THIS; }
    let hidden = false;
    if (/^hidden categories$/i.test(master)) { const p = /^(.*) ` (.*) ` \d*$/.exec(sub) ?? /^(.*) ` (.*)$/.exec(sub); if (p) { master = p[1]; sub = p[2]; } hidden = true; }
    if (!master) master = 'Uncategorised group'; if (!sub) sub = master;
    const key = master + '\u0000' + sub; let s = catSid.get(key);
    if (!s) { s = 'c:' + master + ':' + sub; catSid.set(key, s); model.categories.push({ sid: s, groupSid: ensureGroup(master), name: sub, hidden, note: '' }); }
    return s;
  };
  // Budget.csv first so category order follows the budget screen
  interface BRow { month: Month; sid: string; budgeted: number; outflows: number; balance: number }
  const brows: BRow[] = [];
  if (input.budget) {
    const br = parseCsv(input.budget); const bh = br[0]?.map(h => h.trim().toLowerCase()) ?? [];
    const B = { month: bh.indexOf('month'), category: bh.indexOf('category'), master: bh.indexOf('master category'), sub: bh.indexOf('sub category'), budgeted: bh.indexOf('budgeted'), outflows: bh.indexOf('outflows'), balance: bh.indexOf('category balance') };
    if (B.month < 0 || B.budgeted < 0) throw new Error('Budget file is missing the "Month"/"Budgeted" columns — is this a YNAB4 Budget export?');
    let badMonth = 0, badNum = 0;
    for (const r of br.slice(1)) {
      const month = parseMonthLabel(r[B.month] ?? ''); if (!month) { badMonth++; continue; }
      const sid = mapCat(B.master >= 0 ? r[B.master] ?? '' : '', B.sub >= 0 ? r[B.sub] ?? '' : '', B.category >= 0 ? r[B.category] ?? '' : '');
      if (!sid || sid === SID_INCOME_THIS || sid === SID_INCOME_NEXT) continue;
      const budgeted = money(r[B.budgeted]), outflows = B.outflows >= 0 ? money(r[B.outflows]) : 0, balance = B.balance >= 0 ? money(r[B.balance]) : null;
      if (budgeted === null || outflows === null) { badNum++; continue; }
      brows.push({ month, sid, budgeted, outflows, balance: balance ?? NaN });
    }
    if (badMonth) warnings.push({ level: 'error', code: 'budget_month_unreadable', message: `${badMonth} budget row(s) have an unreadable month and were skipped.`, count: badMonth });
    if (badNum) warnings.push({ level: 'error', code: 'budget_amount_unreadable', message: `${badNum} budget row(s) have unreadable amounts and were skipped.`, count: badNum });
  }

  // ---- register rows
  interface Row { n: number; account: string; date: string; payee: string; cat: string | null; memo: string; amount: number; cleared: Cleared; flag: Flag | null; running: number | null; split: [number, number] | null }
  const parsed: Row[] = []; const accountOrder: string[] = [];
  let badDate = 0, badAmount = 0, badCleared = 0;
  body.forEach((r, n) => {
    const account = (r[C.account] ?? '').trim(); if (!account) return;
    if (!accountOrder.includes(account)) accountOrder.push(account);
    const d = parseDate(r[C.date] ?? '', style); if (!d) { badDate++; return; }
    const out = money(r[C.outflow]), inn = money(r[C.inflow]);
    if (out === null || inn === null) { badAmount++; return; }
    const cl = (C.cleared >= 0 ? r[C.cleared] ?? '' : '').trim().toUpperCase();
    if (cl && !['U', 'C', 'R'].includes(cl)) badCleared++;
    let memo = C.memo >= 0 ? r[C.memo] ?? '' : ''; let split: [number, number] | null = null;
    const sm = SPLIT_RE.exec(memo); if (sm) { split = [+sm[1], +sm[2]]; memo = memo.slice(sm[0].length); }
    const check = C.check >= 0 ? (r[C.check] ?? '').trim() : ''; if (check) memo = `#${check}${memo ? ' ' + memo : ''}`;
    const fl = (C.flag >= 0 ? r[C.flag] ?? '' : '').trim().toLowerCase();
    parsed.push({ n, account, date: d.iso, payee: (r[C.payee] ?? '').trim(), cat: mapCat(C.master >= 0 ? r[C.master] ?? '' : '', C.sub >= 0 ? r[C.sub] ?? '' : '', C.category >= 0 ? r[C.category] ?? '' : ''),
      memo, amount: inn - out, cleared: cl === 'R' ? 'reconciled' : cl === 'C' ? 'cleared' : 'uncleared', flag: (FLAGS as readonly string[]).includes(fl) ? fl as Flag : null,
      running: C.running >= 0 && (r[C.running] ?? '').trim() ? money(r[C.running]) : null, split });
  });
  if (badDate) warnings.push({ level: 'error', code: 'txn_bad_date', message: `${badDate} register row(s) have an unreadable date and were NOT imported.`, count: badDate });
  if (badAmount) warnings.push({ level: 'error', code: 'txn_bad_amount', message: `${badAmount} register row(s) have an unreadable amount and were NOT imported.`, count: badAmount });
  if (badCleared) warnings.push({ level: 'warning', code: 'cleared_unknown', message: `${badCleared} row(s) have an unknown cleared code and were imported as uncleared.`, count: badCleared });
  model.expected.transactionCount = parsed.length;

  // ---- accounts (type is not in the CSV; on/off-budget is inferred from category usage)
  const catUse = new Map<string, number>();
  for (const p of parsed) if (p.cat) catUse.set(p.account, (catUse.get(p.account) ?? 0) + 1);
  for (const name of accountOrder) { const o = opts.accounts?.[name];
    model.accounts.push({ sid: 'a:' + name, name, type: o?.type ?? 'checking', onBudget: o?.onBudget ?? (catUse.get(name) ?? 0) > 0, closed: o?.closed ?? false, note: '', typeKnown: !!o?.type }); }
  const accSid = new Map(model.accounts.map(a => [a.name, a.sid]));
  const onBudget = new Map(model.accounts.map(a => [a.sid, a.onBudget]));
  warnings.push({ level: 'warning', code: 'account_types_inferred', message: 'CSV exports do not contain account types or the budget/off-budget setting. Accounts whose transactions have no categories were assumed to be off-budget; all are typed "Checking". Review them in the preview.' });

  // ---- assemble splits
  const payeeSet = new Map<string, string | null>();
  const txns: (ImTxn & { _row: number })[] = [];
  let splitIncomplete = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const mkLine = (r: Row, idx: number) => {
      const tm = TRANSFER_RE.exec(r.payee); const target = tm ? accSid.get(tm[1].trim()) ?? null : null;
      return { sid: `r${r.n}`, amount: r.amount, categorySid: r.cat, memo: r.memo, transferAccountSid: target, transferSid: null as string | null, _payee: r.payee, _isTransferText: !!tm, _idx: idx };
    };
    if (p.split) {
      const group = [p]; const total = p.split[1];
      while (group.length < total && i + 1 < parsed.length) {
        const q = parsed[i + 1];
        if (q.split && q.split[1] === total && q.account === p.account && q.date === p.date && q.split[0] === group.length + 1) { group.push(q); i++; } else break;
      }
      if (group.length !== total || p.split[0] !== 1) splitIncomplete++;
      const lines = group.map(mkLine);
      const payee = lines.find(l => !l._isTransferText)?._payee ?? lines[0]._payee;
      const allSamePayeeTransfer = lines.every(l => l._isTransferText);
      txns.push({ sid: `t${p.n}`, accountSid: accSid.get(p.account)!, date: p.date, payeeName: allSamePayeeTransfer ? null : payee || null, categorySid: null, memo: '', amount: group.reduce((s, r) => s + r.amount, 0),
        cleared: p.cleared, flag: p.flag, transferAccountSid: null, transferSid: null, _row: p.n,
        splits: lines.map(l => ({ sid: l.sid, amount: l.amount, categorySid: l.categorySid, memo: l.transferAccountSid || !l._isTransferText ? l.memo : `${l._payee}${l.memo ? ' — ' + l.memo : ''}`, transferAccountSid: l.transferAccountSid, transferSid: null })) });
    } else {
      const l = mkLine(p, 0);
      txns.push({ sid: `t${p.n}`, accountSid: accSid.get(p.account)!, date: p.date, payeeName: l.transferAccountSid ? null : p.payee || null, categorySid: p.cat, memo: p.memo, amount: p.amount, cleared: p.cleared, flag: p.flag,
        transferAccountSid: l.transferAccountSid, transferSid: null, splits: [], _row: p.n });
    }
  }
  if (splitIncomplete) warnings.push({ level: 'warning', code: 'split_incomplete', message: `${splitIncomplete} split transaction(s) could not be fully re-assembled from "(Split n/m)" memos; their lines were grouped as found.`, count: splitIncomplete });

  // ---- pair transfers: (A → B, date, x) with (B → A, date, −x)
  interface Side { sid: string; from: string; to: string; date: string; amount: number; set: (other: string | null) => void; unlink: () => void }
  const sides: Side[] = [];
  for (const t of txns) {
    if (t.transferAccountSid) sides.push({ sid: t.sid, from: t.accountSid, to: t.transferAccountSid, date: t.date, amount: t.amount, set: o => { t.transferSid = o; },
      unlink: () => { t.payeeName = `Transfer : ${model.accounts.find(a => a.sid === t.transferAccountSid)!.name}`; t.transferAccountSid = null; } });
    for (const s of t.splits) if (s.transferAccountSid) sides.push({ sid: s.sid, from: t.accountSid, to: s.transferAccountSid, date: t.date, amount: s.amount, set: o => { s.transferSid = o; },
      unlink: () => { s.memo = `Transfer : ${model.accounts.find(a => a.sid === s.transferAccountSid)!.name}${s.memo ? ' — ' + s.memo : ''}`; s.transferAccountSid = null; } });
  }
  const open = new Map<string, Side[]>();
  let paired = 0, unpaired = 0;
  for (const s of sides) {
    const want = `${s.to}|${s.from}|${s.date}|${-s.amount}`; const q = open.get(want);
    if (q?.length) { const o = q.shift()!; s.set(o.sid); o.set(s.sid); paired++; }
    else { const k = `${s.from}|${s.to}|${s.date}|${s.amount}`; (open.get(k) ?? open.set(k, []).get(k)!).push(s); }
  }
  for (const q of open.values()) for (const s of q) { s.unlink(); unpaired++; }
  // A transfer line inside a split pairs with a top-level row on the far side; two split lines cannot be partners.
  const splitLineSids = new Set(txns.flatMap(t => t.splits.map(s => s.sid)));
  for (const t of txns) for (const s of t.splits) if (s.transferSid && splitLineSids.has(s.transferSid)) {
    const other = txns.flatMap(x => x.splits).find(x => x.sid === s.transferSid)!;
    for (const x of [s, other]) { x.memo = `Transfer : ${model.accounts.find(a => a.sid === x.transferAccountSid)!.name}${x.memo ? ' — ' + x.memo : ''}`; x.transferAccountSid = null; x.transferSid = null; }
    unpaired += 2; paired--;
  }
  if (unpaired) warnings.push({ level: 'warning', code: 'transfer_unlinked', message: `${unpaired} transfer row(s) had no matching row in the other account (same date, opposite amount) and were imported as ordinary transactions named "Transfer : <account>".`, count: unpaired });
  warnings.push({ level: 'info', code: 'transfers_paired', message: `${paired} transfer pair(s) were re-linked by account, date and amount (CSV files contain no transfer identifiers).`, count: paired });
  // budget rules: no category on tracking rows or on budget↔budget transfers
  for (const t of txns) {
    const on = onBudget.get(t.accountSid)!;
    const fix = (x: { categorySid: string | null; transferAccountSid: string | null }) => { if (!on || (x.transferAccountSid && onBudget.get(x.transferAccountSid))) x.categorySid = null; };
    fix(t); t.splits.forEach(fix);
    if (t.payeeName && !payeeSet.has(t.payeeName.toLowerCase()) && !TRANSFER_RE.test(t.payeeName)) payeeSet.set(t.payeeName.toLowerCase(), t.payeeName);
  }
  model.payees = [...payeeSet.values()].map(name => ({ name: name!, autoCategorySid: null }));
  model.transactions = txns.map(({ _row, ...t }) => t);

  // ---- expected balances from the Running Balance column (only when it is self-consistent)
  for (const name of accountOrder) {
    const rs = parsed.filter(p => p.account === name);
    if (!rs.length || rs.some(r => r.running === null)) continue;
    const total = rs.reduce((s, r) => s + r.amount, 0);
    let down = true, up = true, acc = 0;
    for (const r of rs) { acc += r.amount; if (acc !== r.running) { down = false; break; } }
    acc = 0; for (let i = rs.length - 1; i >= 0; i--) { acc += rs[i].amount; if (acc !== rs[i].running) { up = false; break; } }
    if (down || up) model.expected.accountBalances.push({ accountSid: 'a:' + name, balance: down ? rs[rs.length - 1].running! : rs[0].running!, basis: 'Running Balance column of the Register export' });
    else if (rs[0].running === total || rs[rs.length - 1].running === total) model.expected.accountBalances.push({ accountSid: 'a:' + name, balance: total, basis: 'final Running Balance of the Register export' });
  }

  // ---- budget history + inferred overspending handling
  if (brows.length) {
    const byCat = new Map<string, BRow[]>();
    for (const r of brows) (byCat.get(r.sid) ?? byCat.set(r.sid, []).get(r.sid)!).push(r);
    // sign convention of "Outflows": pick the one that explains the balances
    let pos = 0, neg = 0;
    for (const list of byCat.values()) { list.sort((a, b) => a.month.localeCompare(b.month)); const f = list[0]; if (Number.isNaN(f.balance) || f.outflows === 0) continue; if (f.balance === f.budgeted - f.outflows) pos++; if (f.balance === f.budgeted + f.outflows) neg++; }
    const sign = neg > pos ? 1 : -1; // activity = sign * outflows
    let inferred = 0, unexplained = 0;
    for (const [sid, list] of byCat) {
      let handling: 'affects_buffer' | 'confined' = 'affects_buffer';
      list.forEach((r, i) => {
        const activity = sign * r.outflows; let explicit: 'affects_buffer' | 'confined' | null = null;
        const next = list[i + 1];
        if (!Number.isNaN(r.balance) && r.balance < 0 && next && !Number.isNaN(next.balance)) {
          const nAct = sign * next.outflows;
          const confined = next.balance === r.balance + next.budgeted + nAct, reset = next.balance === next.budgeted + nAct;
          const want = confined && !reset ? 'confined' : reset && !confined ? 'affects_buffer' : null;
          if (want && want !== handling) { explicit = want; handling = want; inferred++; } else if (!confined && !reset) unexplained++;
        }
        if (r.budgeted !== 0 || explicit) model.budgets.push({ month: r.month, categorySid: sid, budgeted: r.budgeted, overspending: explicit, note: '' });
        if (!Number.isNaN(r.balance)) model.expected.monthly.push({ month: r.month, categorySid: sid, budgeted: r.budgeted, activity, balance: r.balance });
      });
    }
    if (inferred) warnings.push({ level: 'info', code: 'overspending_inferred', message: `The overspending ("red arrow") setting is not in the CSV. It was inferred for ${inferred} category-month(s) from how negative balances continue into the next month.`, count: inferred });
    if (unexplained) warnings.push({ level: 'warning', code: 'overspending_unexplained', message: `${unexplained} negative category balance(s) continue into the next month in a way neither overspending rule explains; they will show up in the verification step.`, count: unexplained });
  } else {
    warnings.push({ level: 'warning', code: 'no_budget_history', message: 'No Budget export was provided: budgeted amounts are NOT imported. Transactions and category activity are complete, but every month will show nothing budgeted and overspent categories. Add the "-Budget.csv" file to migrate your budget history.' });
  }
  model.coverage = [
    { item: 'Transactions, memos, flags, cleared/reconciled', status: 'full', note: 'Check numbers are kept as a "#123" prefix in the memo.' },
    { item: 'Split transactions', status: 'partial', note: 'Re-assembled from "(Split n/m)" memo markers.' },
    { item: 'Transfers (linked pairs)', status: 'partial', note: 'Re-paired by account, date and amount.' },
    { item: 'Accounts', status: 'partial', note: 'Names only. Type, on/off-budget, closed state and notes are not in the CSV.' },
    { item: 'Categories and groups', status: 'partial', note: 'Names (and order, when a Budget export is given). Category notes are not in the CSV.' },
    { item: 'Monthly budgeted amounts', status: input.budget ? 'full' : 'none', note: input.budget ? 'From the Budget export.' : 'Requires the Budget export.' },
    { item: 'Overspending (red arrow) settings', status: input.budget ? 'partial' : 'none', note: 'Inferred from category balances where possible.' },
    { item: 'Scheduled transactions, payee settings, month/category notes', status: 'none', note: 'Not part of the CSV export. Use the native .ynab4 folder to migrate these.' },
  ];
  return model;
}
