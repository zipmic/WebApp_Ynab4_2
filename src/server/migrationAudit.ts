/**
 * Independent migration audit for native YNAB4 budgets.
 *
 * It re-reads the RAW source entities (not the importer's intermediate model) and compares them, record by
 * record and month by month, with what is in the imported database. The rollover check uses its own small
 * reference implementation of the YNAB4 rules, so an error in the main engine cannot hide itself.
 * Reports contain entity ids and counts only — never names, memos or amounts — so they are safe to share.
 */
import type { BudgetService } from './budgetService.ts';
import { addMonths } from '../shared/dates.ts';
import { loadYfull, type SourceFile } from '../shared/ynab4native.ts';

export type AreaStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'INFO';
export interface AuditArea { area: string; status: AreaStatus; source: number | null; imported: number | null; detail: string; examples: string[] }
export interface MigrationAudit { verdict: 'PASS' | 'FAIL' | 'PARTIAL'; areas: AuditArea[]; unrecognizedFields: Record<string, string[]>; skipped: { kind: string; count: number; reason: string }[] }

const KNOWN: Record<string, string[]> = {
  account: ['entityId', 'entityType', 'entityVersion', 'accountName', 'accountType', 'lastEnteredCheckNumber', 'sortableIndex', 'lastReconciledBalance', 'lastReconciledDate', 'onBudget', 'hidden', 'isTombstone', 'note', 'isResolvedConflict', 'madeWithKnowledge'],
  masterCategory: ['subCategories', 'entityId', 'entityType', 'entityVersion', 'name', 'sortableIndex', 'expanded', 'type', 'deleteable', 'isTombstone', 'note', 'isResolvedConflict', 'madeWithKnowledge'],
  category: ['entityId', 'entityType', 'entityVersion', 'cachedBalance', 'name', 'masterCategoryId', 'sortableIndex', 'type', 'note', 'isTombstone', 'isResolvedConflict', 'madeWithKnowledge'],
  payee: ['locations', 'entityId', 'entityType', 'entityVersion', 'name', 'enabled', 'autoFillCategoryId', 'autoFillAmount', 'autoFillMemo', 'targetAccountId', 'renameConditions', 'isTombstone', 'isResolvedConflict', 'madeWithKnowledge'],
  transaction: ['entityVersion', 'amount', 'cleared', 'date', 'categoryId', 'entityId', 'entityType', 'accountId', 'accepted', 'payeeId', 'isTombstone', 'memo', 'targetAccountId', 'transferTransactionId', 'flag', 'dateEnteredFromSchedule', 'subTransactions',
    'isResolvedConflict', 'madeWithKnowledge', 'FITID', 'YNABID', 'checkNumber', 'importedPayee', 'matchedTransactions', 'parentTransactionIdIfMatched', 'source'],
  subTransaction: ['entityId', 'entityType', 'entityVersion', 'amount', 'parentTransactionId', 'categoryId', 'memo', 'targetAccountId', 'transferTransactionId', 'isTombstone', 'isResolvedConflict', 'madeWithKnowledge', 'checkNumber'],
  monthlyBudget: ['entityId', 'entityType', 'entityVersion', 'monthlySubCategoryBudgets', 'month', 'note', 'isResolvedConflict', 'isTombstone', 'madeWithKnowledge'],
  monthlyCategoryBudget: ['entityId', 'isTombstone', 'entityType', 'entityVersion', 'parentMonthlyBudgetId', 'budgeted', 'categoryId', 'overspendingHandling', 'note', 'isResolvedConflict', 'madeWithKnowledge'],
  scheduledTransaction: ['isTombstone', 'entityVersion', 'amount', 'twiceAMonthStartDay', 'cleared', 'date', 'frequency', 'targetAccountId', 'categoryId', 'entityId', 'entityType', 'accountId', 'accepted', 'payeeId', 'flag', 'isResolvedConflict', 'memo',
    'dateEnteredFromSchedule', 'madeWithKnowledge', 'FITID', 'YNABID', 'checkNumber', 'importedPayee', 'matchedTransactions', 'parentTransactionIdIfMatched', 'source', 'subTransactions', 'transferTransactionId'],
};
const ENUMS: Record<string, string[]> = {
  accountType: ['Checking', 'Savings', 'CreditCard', 'Cash', 'LineOfCredit', 'Paypal', 'PayPal', 'MerchantAccount', 'InvestmentAccount', 'Mortgage', 'OtherAsset', 'OtherLiability'],
  cleared: ['Cleared', 'Uncleared', 'Reconciled'], flag: ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple'], overspendingHandling: ['Confined', 'AffectsBuffer'],
  frequency: ['Once', 'Never', 'Daily', 'Weekly', 'EveryOtherWeek', 'TwiceAMonth', 'Every4Weeks', 'Monthly', 'EveryOtherMonth', 'Every3Months', 'Every4Months', 'TwiceAYear', 'Yearly', 'EveryOtherYear'],
};
const TYPE: Record<string, string> = { Checking: 'checking', Savings: 'savings', CreditCard: 'credit_card', Cash: 'cash', LineOfCredit: 'line_of_credit', Paypal: 'paypal', PayPal: 'paypal', MerchantAccount: 'merchant',
  InvestmentAccount: 'investment', Mortgage: 'mortgage', OtherAsset: 'other_asset', OtherLiability: 'other_liability' };
const IMMEDIATE = 'Category/__ImmediateIncome__', DEFERRED = 'Category/__DeferredIncome__', SPLIT = 'Category/__Split__';

/** exact øre from a source number; null when the source value is not a whole number of øre */
function cents(n: unknown): number | null { if (typeof n !== 'number' || !Number.isFinite(n)) return null; const c = Math.round(n * 100); return Math.abs(n * 100 - c) < 1e-6 ? c : null; }

export function auditNativeImport(files: SourceFile[], svc: BudgetService): MigrationAudit {
  const { budget: src } = loadYfull(files, []);
  const db = svc.db; const areas: AuditArea[] = []; const skipped: MigrationAudit['skipped'] = []; const unrecognized: Record<string, Set<string>> = {};
  const add = (area: string, source: number | null, imported: number | null, problems: string[], okDetail: string, partial = false) =>
    areas.push({ area, source, imported, status: problems.length ? (partial ? 'PARTIAL' : 'FAIL') : 'PASS', detail: problems.length ? `${problems.length} difference(s)` : okDetail, examples: problems.slice(0, 12) });
  const note = (type: string, e: any) => { for (const k of Object.keys(e)) if (!KNOWN[type].includes(k)) (unrecognized[type] ??= new Set()).add(k); };
  const badEnum: string[] = []; const en = (field: string, v: unknown, id: string) => { if (v != null && !ENUMS[field].includes(String(v))) badEnum.push(`${field}=${String(v).slice(0, 20)} on ${id}`); };
  const q = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as any[];

  // ---------------------------------------------------------------- accounts
  const sAcc = (src.accounts as any[]).filter(a => { note('account', a); en('accountType', a.accountType, a.entityId); return !a.isTombstone; });
  skipped.push({ kind: 'account', count: src.accounts.length - sAcc.length, reason: 'deleted in YNAB4 (tombstone)' });
  const dAcc = new Map(q('SELECT * FROM accounts').map(a => [a.source_id, a])); const onBudget = new Map(sAcc.map(a => [a.entityId, a.onBudget !== false]));
  { const p: string[] = [];
    for (const a of sAcc) { const d = dAcc.get(a.entityId); if (!d) { p.push(`missing account ${a.entityId}`); continue; }
      if (d.type !== (TYPE[a.accountType] ?? 'checking')) p.push(`type of ${a.entityId}`); if (!!d.on_budget !== (a.onBudget !== false)) p.push(`budget/off-budget of ${a.entityId}`); if (!!d.closed !== !!a.hidden) p.push(`closed state of ${a.entityId}`);
      if (String(d.name).replace(/ \(\d+\)$/, '') !== String(a.accountName ?? '').trim() && d.name !== a.accountName) p.push(`name of ${a.entityId}`); }
    add('Accounts (count, type, budget/tracking, closed)', sAcc.length, dAcc.size, p.concat(dAcc.size !== sAcc.length ? [`count ${dAcc.size} vs ${sAcc.length}`] : []), 'every account matches'); }

  // ---------------------------------------------------------------- categories
  const masters = (src.masterCategories ?? []) as any[]; const sCat = new Map<string, { tomb: boolean; hidden: boolean }>();
  for (const m of masters) { note('masterCategory', m); for (const s of (m.subCategories ?? []) as any[]) { note('category', s); sCat.set(s.entityId, { tomb: !!s.isTombstone || (!!m.isTombstone && m.entityId !== 'MasterCategory/__Hidden__'), hidden: m.entityId === 'MasterCategory/__Hidden__' }); } }
  const dCat = new Map(q(`SELECT * FROM categories WHERE kind='normal'`).map(c => [c.source_id, c]));
  const mapCat = (id: string | null | undefined): string | null => (!id || id === SPLIT ? null : id === IMMEDIATE ? 'income:this' : id === DEFERRED ? 'income:next' : dCat.get(id)?.id ?? `?${id}`);
  { const p: string[] = []; const live = [...sCat].filter(([, c]) => !c.tomb);
    for (const [id, c] of live) { const d = dCat.get(id); if (!d) p.push(`missing category ${id}`); else if (!!d.hidden !== c.hidden) p.push(`hidden state of ${id}`); }
    const revived = [...dCat.keys()].filter(id => sCat.get(id)?.tomb).length, invented = [...dCat.keys()].filter(id => !sCat.has(id)).length;
    add('Categories (live, hidden, deleted-but-used)', live.length, dCat.size, p.concat(invented ? [`${invented} categories not present in the source`] : []), `all live categories imported; ${live.filter(([, c]) => c.hidden).length} hidden; ${revived} deleted categories kept because history still uses them`);
    skipped.push({ kind: 'category', count: [...sCat.values()].filter(c => c.tomb).length - revived, reason: 'deleted in YNAB4 and not referenced by any live record' }); }

  // ---------------------------------------------------------------- transactions
  const payeeName = new Map((src.payees as any[] ?? []).map(p => { note('payee', p); return [p.entityId, p]; }));
  const all = src.transactions as any[]; const live = all.filter(t => { note('transaction', t); en('cleared', t.cleared, t.entityId); en('flag', t.flag, t.entityId); return !t.isTombstone; });
  skipped.push({ kind: 'transaction', count: all.length - live.length, reason: 'deleted in YNAB4 (tombstone)' });
  const dTx = new Map<string, any>(); const dup: string[] = [];
  for (const r of q('SELECT t.*, p.name payee_name FROM transactions t LEFT JOIN payees p ON p.id=t.payee_id')) { if (r.source_id && dTx.has(r.source_id)) dup.push(`duplicate ${r.source_id}`); if (r.source_id) dTx.set(r.source_id, r); }
  const accId = (sid: string) => dAcc.get(sid)?.id; const state = (c: string) => (c === 'Reconciled' ? 'reconciled' : c === 'Cleared' ? 'cleared' : 'uncleared');
  const pField: string[] = [], pMissing: string[] = [], pCat: string[] = [], pPayee: string[] = [], pState: string[] = [], pSplit: string[] = [], pXfer: string[] = [], pAmount: string[] = [];
  let splitParents = 0, splitLines = 0, transfers = 0, payeeRefs = 0, catRefs = 0;
  const sums = new Map<string, { n: number; bal: number; cleared: number; reconciled: number; states: Record<string, number> }>();
  for (const t of live) {
    const d = dTx.get(t.entityId); const a = cents(t.amount);
    const s = sums.get(t.accountId) ?? sums.set(t.accountId, { n: 0, bal: 0, cleared: 0, reconciled: 0, states: { uncleared: 0, cleared: 0, reconciled: 0 } }).get(t.accountId)!;
    s.n++; s.bal += a ?? 0; if (t.cleared !== 'Uncleared') s.cleared += a ?? 0; if (t.cleared === 'Reconciled') s.reconciled += a ?? 0; s.states[state(t.cleared)]++;
    if (a === null) pAmount.push(`amount of ${t.entityId} is not a whole number of minor units`);
    if (!d || d.parent_id) { pMissing.push(`missing ${t.entityId}`); continue; }
    if (d.date !== String(t.date).slice(0, 10)) pField.push(`date of ${t.entityId}`); if (d.amount !== a) pAmount.push(`amount of ${t.entityId}`); if (d.account_id !== accId(t.accountId)) pField.push(`account of ${t.entityId}`);
    if (d.cleared !== state(t.cleared)) pState.push(`cleared state of ${t.entityId}`); if ((d.flag ?? null) !== (t.flag ? String(t.flag).toLowerCase() : null)) pState.push(`flag of ${t.entityId}`);
    const memo = `${t.checkNumber ? '#' + t.checkNumber + (t.memo ? ' ' : '') : ''}${t.memo ?? ''}`; if (d.memo !== memo) pField.push(`memo of ${t.entityId}`);
    const subs = ((t.subTransactions ?? []) as any[]).filter(x => { note('subTransaction', x); return !x.isTombstone; });
    if (t.transferTransactionId) {
      transfers++; const o = dTx.get(t.transferTransactionId);
      if (!d.transfer_txn_id || !o || d.transfer_txn_id !== o.id || o.transfer_txn_id !== d.id || d.transfer_account_id !== accId(t.targetAccountId)) pXfer.push(`transfer link of ${t.entityId}`);
    } else {
      if (d.transfer_txn_id) pXfer.push(`unexpected transfer link on ${t.entityId}`);
      const name = t.payeeId ? payeeName.get(t.payeeId)?.name ?? null : null; if (name) payeeRefs++;
      if ((d.payee_name ? String(d.payee_name).toLowerCase() : null) !== (name ? String(name).trim().replace(/\s+/g, ' ').toLowerCase() : null)) pPayee.push(`payee of ${t.entityId}`);
    }
    if (subs.length) {
      splitParents++; splitLines += subs.length; if (!d.is_split || d.category_id) pSplit.push(`split flag of ${t.entityId}`);
      let sum = 0; for (const x of subs) { const k = dTx.get(x.entityId); const xa = cents(x.amount); sum += xa ?? 0; if (!k || k.parent_id !== d.id || k.amount !== xa || k.date !== d.date || (k.category_id ?? null) !== (onBudget.get(t.accountId) ? mapCat(x.categoryId) : null) || k.memo !== String(x.memo ?? '')) pSplit.push(`split line ${x.entityId}`); }
      if (sum !== a) pSplit.push(`split ${t.entityId} does not add up in the source`);
    } else {
      // a category survives only where YNAB4 allows one: budget-account rows that are not transfers between two budget accounts
      const allowed = onBudget.get(t.accountId) && !(t.targetAccountId && onBudget.get(t.targetAccountId)); const want = allowed ? mapCat(t.categoryId) : null; if (want) catRefs++;
      if ((d.category_id ?? null) !== want) pCat.push(`category of ${t.entityId}`); if (d.is_split) pSplit.push(`unexpected split flag on ${t.entityId}`);
    }
  }
  const dTop = q('SELECT COUNT(*) n FROM transactions WHERE parent_id IS NULL')[0].n as number;
  add('Transactions (every live source record present exactly once)', live.length, dTop, [...pMissing, ...dup, ...(dTop !== live.length ? [`${dTop} imported vs ${live.length} in source`] : [])], 'no record missing, none duplicated, none invented');
  add('Transaction dates, accounts and memos', live.length, live.length - pField.length, pField, 'identical for every transaction');
  add('Transaction amounts (exact minor units)', live.length, live.length - pAmount.length, pAmount, 'identical for every transaction');
  add('Cleared / reconciled states and flags', live.length, live.length - pState.length, pState, 'identical for every transaction');
  add('Payee assignments', payeeRefs, payeeRefs - pPayee.length, pPayee, 'identical for every transaction');
  add('Category assignments', catRefs, catRefs - pCat.length, pCat, 'identical for every transaction');
  add('Split transactions and their lines', splitLines, q('SELECT COUNT(*) n FROM transactions WHERE parent_id IS NOT NULL')[0].n, pSplit, `${splitParents} splits, every line and total identical`);
  add('Transfers (both sides linked to each other)', transfers, q('SELECT COUNT(*) n FROM transactions WHERE transfer_txn_id IS NOT NULL AND parent_id IS NULL')[0].n, pXfer, `${transfers / 2} transfer pairs linked exactly as in the source`);
  { const p: string[] = [];
    for (const a of sAcc) { const s = sums.get(a.entityId) ?? { n: 0, bal: 0, cleared: 0, reconciled: 0, states: { uncleared: 0, cleared: 0, reconciled: 0 } }; const id = accId(a.entityId);
      const d = q(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) bal, COALESCE(SUM(CASE WHEN cleared<>'uncleared' THEN amount END),0) cl, COALESCE(SUM(CASE WHEN cleared='reconciled' THEN amount END),0) rec FROM transactions WHERE account_id=? AND parent_id IS NULL`, id)[0];
      if (d.n !== s.n) p.push(`transaction count of account ${a.entityId}`); if (d.bal !== s.bal) p.push(`final balance of account ${a.entityId}`); if (d.cl !== s.cleared) p.push(`cleared balance of account ${a.entityId}`); if (d.rec !== s.reconciled) p.push(`reconciled balance of account ${a.entityId}`); }
    add('Account balances (final, cleared and reconciled)', sAcc.length, sAcc.length, p, 'all balances identical, recomputed from the raw source amounts'); }

  // ---------------------------------------------------------------- monthly budgets
  const sBud = new Map<string, { budgeted: number; handling: string | null }>(); let tombCells = 0, budNotes = 0;
  for (const mb of (src.monthlyBudgets ?? []) as any[]) { note('monthlyBudget', mb); if (mb.isTombstone) continue; const month = String(mb.month).slice(0, 7);
    for (const c of (mb.monthlySubCategoryBudgets ?? []) as any[]) { note('monthlyCategoryBudget', c); en('overspendingHandling', c.overspendingHandling, c.entityId); if (c.isTombstone) { tombCells++; continue; }
      if ([IMMEDIATE, DEFERRED, SPLIT].includes(c.categoryId)) continue; const b = cents(c.budgeted ?? 0) ?? NaN; if (c.note) budNotes++;
      if (b !== 0 || c.overspendingHandling) sBud.set(`${month}|${c.categoryId}`, { budgeted: b, handling: c.overspendingHandling === 'Confined' ? 'confined' : c.overspendingHandling === 'AffectsBuffer' ? 'affects_buffer' : null }); } }
  skipped.push({ kind: 'monthlyCategoryBudget', count: tombCells, reason: 'deleted in YNAB4 (tombstone)' });
  const catSid = new Map([...dCat].map(([sid, c]) => [c.id, sid]));
  { const p: string[] = []; const dBud = q('SELECT * FROM monthly_budgets WHERE budgeted<>0 OR overspending IS NOT NULL'); const seen = new Set<string>();
    for (const d of dBud) { const k = `${d.month}|${catSid.get(d.category_id)}`; seen.add(k); const s = sBud.get(k); if (!s) p.push(`budget cell ${k} not in source`); else { if (s.budgeted !== d.budgeted) p.push(`budgeted amount ${k}`); if (s.handling !== (d.overspending ?? null)) p.push(`overspending setting ${k}`); } }
    for (const k of sBud.keys()) if (!seen.has(k)) p.push(`budget cell ${k} missing`);
    add('Monthly budgeted amounts and overspending (red arrow) settings', sBud.size, dBud.length, p, `every category-month identical (${[...sBud.values()].filter(b => b.handling).length} explicit overspending settings)`); }

  // ---------------------------------------------------------------- reference rollover (independent of the engine)
  { const act = new Map<string, number>(), incomeThis = new Map<string, number>(), incomeNext = new Map<string, number>(); let first = '9999-99', last = '0000-00';
    const see = (m: string) => { if (m < first) first = m; if (m > last) last = m; };
    const post = (accountId: string, date: string, categoryId: string | null | undefined, amount: number, target?: string | null) => {
      if (!categoryId || categoryId === SPLIT || !onBudget.get(accountId) || (target && onBudget.get(target))) return; const m = date.slice(0, 7); see(m);
      if (categoryId === IMMEDIATE) incomeThis.set(m, (incomeThis.get(m) ?? 0) + amount); else if (categoryId === DEFERRED) { incomeNext.set(m, (incomeNext.get(m) ?? 0) + amount); see(addMonths(m, 1)); }
      else act.set(`${m}|${categoryId}`, (act.get(`${m}|${categoryId}`) ?? 0) + amount); };
    for (const t of live) { const subs = ((t.subTransactions ?? []) as any[]).filter(x => !x.isTombstone);
      if (subs.length) for (const x of subs) post(t.accountId, t.date, x.categoryId, cents(x.amount) ?? 0, x.targetAccountId); else post(t.accountId, t.date, t.categoryId, cents(t.amount) ?? 0, t.targetAccountId); }
    for (const k of sBud.keys()) see(k.slice(0, 7));
    const cats = [...dCat.keys()]; const carry = new Map<string, number>(), mode = new Map<string, string>(); let atb = 0, overspentPrev = 0;
    const pAct: string[] = [], pAvail: string[] = [], pAtb: string[] = [], pInc: string[] = []; let months = 0, cells = 0;
    if (first <= last) for (let m = first; m <= last; m = addMonths(m, 1)) {
      months++; const eng = svc.getBudget(m); const rows = new Map(eng.rows.map(r => [catSid.get(r.categoryId), r])); let budgeted = 0, overspent = 0;
      for (const c of cats) {
        const b = sBud.get(`${m}|${c}`); if (b?.handling) mode.set(c, b.handling);
        const a = act.get(`${m}|${c}`) ?? 0, avail = (carry.get(c) ?? 0) + (b?.budgeted ?? 0) + a; budgeted += b?.budgeted ?? 0; cells++;
        if (avail < 0 && mode.get(c) !== 'confined') { overspent -= avail; carry.set(c, 0); } else carry.set(c, avail);
        const r = rows.get(c); if (!r) { pAvail.push(`category ${c} missing in ${m}`); continue; }
        if (r.activity !== a) pAct.push(`activity ${m}|${c}`); if (r.available !== avail) pAvail.push(`balance ${m}|${c}`);
      }
      const income = (incomeThis.get(m) ?? 0) + (incomeNext.get(addMonths(m, -1)) ?? 0); atb = atb - overspentPrev + income - budgeted; overspentPrev = overspent;
      if (eng.income !== income) pInc.push(`income ${m}`); if (eng.availableToBudget !== atb) pAtb.push(`available to budget ${m}`);
    }
    add('Category activity per month (from raw source transactions)', cells, cells - pAct.length, pAct, `identical in all ${months} months`);
    add('Income for this month / next month, per month', months, months - pInc.length, pInc, `identical in all ${months} months`);
    add('Category balances and rollover, every category in every month', cells, cells - pAvail.length, pAvail, `engine and independent reference calculation agree in all ${months} months`);
    add('Available to Budget, every month', months, months - pAtb.length, pAtb, `engine and independent reference calculation agree in all ${months} months`); }

  // ---------------------------------------------------------------- scheduled, payees, notes
  { const sS = ((src.scheduledTransactions ?? []) as any[]).filter(s => { note('scheduledTransaction', s); en('frequency', s.frequency, s.entityId); return !s.isTombstone; });
    skipped.push({ kind: 'scheduledTransaction', count: (src.scheduledTransactions ?? []).length - sS.length, reason: 'deleted in YNAB4 (tombstone)' });
    const dS = new Map(q('SELECT * FROM scheduled').map(s => [s.source_id, s])); const p: string[] = [];
    for (const s of sS) { const d = dS.get(s.entityId); if (!d) { p.push(`missing schedule ${s.entityId}`); continue; } if (d.next_date !== String(s.date).slice(0, 10) || d.amount !== cents(s.amount) || d.account_id !== accId(s.accountId)) p.push(`schedule ${s.entityId}`);
      if ((d.category_id ?? null) !== mapCat(s.categoryId) && !(s.subTransactions ?? []).length) p.push(`category of schedule ${s.entityId}`); }
    add('Scheduled transactions', sS.length, dS.size, p.concat(dS.size !== sS.length ? [`count ${dS.size} vs ${sS.length}`] : []), 'date, amount, account and category identical'); }
  { const sP = [...payeeName.values()].filter(p => !p.isTombstone && !String(p.entityId).startsWith('Payee/Transfer:') && !p.targetAccountId && p.name); const names = new Set(sP.map(p => String(p.name).trim().replace(/\s+/g, ' ').toLowerCase()));
    const dP = new Set(q('SELECT name FROM payees').map(p => String(p.name).toLowerCase())); const missing = [...names].filter(n => !dP.has(n)).length;
    skipped.push({ kind: 'payee', count: payeeName.size - sP.length, reason: 'deleted payees and built-in transfer payees (transfers are links, not payees)' });
    areas.push({ area: 'Payees', source: sP.length, imported: dP.size, status: missing ? 'FAIL' : names.size !== sP.length ? 'PARTIAL' : 'PASS', examples: [],
      detail: missing ? `${missing} payee name(s) missing` : names.size !== sP.length ? `${sP.length - names.size} payee(s) differ only in letter case/spacing and were merged` : 'every payee name imported' });
    const rules = sP.filter(p => (p.renameConditions ?? []).length).length; if (rules) areas.push({ area: 'Payee rename rules', source: rules, imported: 0, status: 'PARTIAL', examples: [], detail: 'not imported (Budget Reborn has its own import rules); transactions keep the payee they already have' }); }
  { const sNotes = ((src.monthlyBudgets ?? []) as any[]).filter(m => !m.isTombstone && m.note).length, dNotes = q('SELECT COUNT(*) n FROM month_notes')[0].n;
    const sC = [...masters].flatMap(m => (m.subCategories ?? []) as any[]).filter(s => !s.isTombstone && s.note && dCat.has(s.entityId)).length, dC = q(`SELECT COUNT(*) n FROM categories WHERE note<>''`)[0].n;
    add('Notes (month notes, category notes)', sNotes + sC, dNotes + dC, sNotes !== dNotes || sC !== dC ? [`month notes ${dNotes}/${sNotes}, category notes ${dC}/${sC}`] : [], 'all imported'); }
  add('Field values YNAB4 documents as enumerations', null, null, badEnum, 'no unknown account types, states, flags, frequencies or overspending settings', true);
  const integrity = svc.checkIntegrity();
  add('Internal consistency of the imported database', null, null, integrity.map(x => x.replace(/-?\d{3,}/g, '#')), 'transfers net to zero, splits add up, budget identity holds every month');
  const unrec = Object.fromEntries(Object.entries(unrecognized).map(([k, v]) => [k, [...v].sort()]));
  areas.push({ area: 'Unrecognised fields in the source', source: null, imported: null, status: Object.keys(unrec).length ? 'PARTIAL' : 'PASS', examples: Object.entries(unrec).map(([k, v]) => `${k}: ${v.join(', ')}`),
    detail: Object.keys(unrec).length ? 'fields this version does not know about (listed by name only) — investigate before relying on the import' : 'every field in the file is known' });
  const verdict = areas.some(a => a.status === 'FAIL') ? 'FAIL' : areas.some(a => a.status === 'PARTIAL') ? 'PARTIAL' : 'PASS';
  return { verdict, areas, unrecognizedFields: unrec, skipped: skipped.filter(s => s.count > 0) };
}
