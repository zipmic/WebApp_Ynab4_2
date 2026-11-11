/**
 * Migration engine: writes an ImportModel into a budget database (one transaction) and audits the
 * result against what the source file says. The audit never "fixes" anything — it only reports.
 */
import { newId, nowIso } from './db.ts';
import type { BudgetService } from './budgetService.ts';
import type { MigrationAudit } from './migrationAudit.ts';
import { normalizePayee } from '../shared/matching.ts';
import type { ImportModel, ImportWarning } from '../shared/importModel.ts';
import { monthOf, todayISO } from '../shared/dates.ts';

export interface AuditCheck { name: string; status: 'pass' | 'fail' | 'info' | 'skipped'; detail: string; mismatches?: { where: string; expected: string; actual: string; hint?: string }[]; mismatchCount?: number }
export interface ImportResult {
  ok: boolean; status: 'verified' | 'needs_attention';
  counts: { accounts: number; groups: number; categories: number; payees: number; transactions: number; splitLines: number; transferPairs: number; budgetCells: number; budgetMonths: number; scheduled: number };
  range: { firstTransaction: string | null; lastTransaction: string | null; firstBudgetMonth: string | null; lastBudgetMonth: string | null };
  checks: AuditCheck[]; warnings: ImportWarning[]; coverage: ImportModel['coverage']; kind: ImportModel['kind']; openMonth: string;
  /** independent record-by-record audit against the raw source (native YNAB4 imports only) */
  audit?: MigrationAudit;
}

/**
 * `audit`, when given, runs after the import against the raw source; a FAIL verdict means the import is never
 * labelled verified. Its result is stored with the import report so Settings can show it later.
 */
export function applyImport(svc: BudgetService, model: ImportModel, fingerprint: string, audit?: (svc: BudgetService) => MigrationAudit): ImportResult {
  const warnings = [...model.warnings];
  const maps = svc.bulk(() => {
    const db = svc.db;
    svc.setMeta('settings', JSON.stringify({ ...svc.getSettings(), name: model.budgetName, ...(model.currency ? { currency: model.currency } : {}) }));
    const acc = new Map<string, string>(), onBudget = new Map<string, boolean>(), accName = new Map<string, string>();
    const insA = db.prepare('INSERT INTO accounts(id,name,type,on_budget,closed,sort_order,note,source_id) VALUES(?,?,?,?,?,?,?,?)');
    const usedNames = new Set<string>();
    model.accounts.forEach((a, i) => {
      let name = a.name.trim() || 'Unnamed account'; let n = 2; while (usedNames.has(name.toLowerCase())) name = `${a.name} (${n++})`; usedNames.add(name.toLowerCase());
      const id = newId(); acc.set(a.sid, id); onBudget.set(a.sid, a.onBudget); accName.set(a.sid, name);
      insA.run(id, name, a.type, a.onBudget ? 1 : 0, a.closed ? 1 : 0, i, a.note, a.sid);
    });
    const grp = new Map<string, string>();
    const insG = db.prepare('INSERT INTO category_groups(id,name,sort_order,hidden,note,source_id) VALUES(?,?,?,?,?,?)');
    model.groups.forEach((g, i) => { const id = newId(); grp.set(g.sid, id); insG.run(id, g.name || 'Unnamed group', i, g.hidden ? 1 : 0, g.note, g.sid); });
    const cat = new Map<string, string>([['income:this', 'income:this'], ['income:next', 'income:next']]);
    const insC = db.prepare('INSERT INTO categories(id,group_id,name,sort_order,hidden,note,source_id) VALUES(?,?,?,?,?,?,?)');
    model.categories.forEach((c, i) => { const id = newId(); cat.set(c.sid, id); insC.run(id, grp.get(c.groupSid)!, c.name || 'Unnamed category', i, c.hidden ? 1 : 0, c.note, c.sid); });
    const payee = new Map<string, string>();
    const insP = db.prepare('INSERT INTO payees(id,name,norm,auto_category_id) VALUES(?,?,?,?)');
    const ensurePayee = (name: string | null, auto: string | null = null): string | null => {
      const n = name?.trim().replace(/\s+/g, ' '); if (!n) return null;
      const k = n.toLowerCase(); let id = payee.get(k);
      if (!id) { id = newId(); payee.set(k, id); insP.run(id, n, normalizePayee(n), auto ? cat.get(auto) ?? null : null); }
      return id;
    };
    for (const p of model.payees) ensurePayee(p.name, p.autoCategorySid);

    // --- transfers: verify every link before trusting it
    interface Side { accountSid: string; target: string | null; other: string | null; amount: number; date: string; top: boolean }
    const sides = new Map<string, Side>();
    for (const t of model.transactions) {
      sides.set(t.sid, { accountSid: t.accountSid, target: t.transferAccountSid, other: t.transferSid, amount: t.amount, date: t.date, top: true });
      for (const s of t.splits) sides.set(s.sid, { accountSid: t.accountSid, target: s.transferAccountSid, other: s.transferSid, amount: s.amount, date: t.date, top: false });
    }
    const linkOk = (sid: string): boolean => {
      const a = sides.get(sid)!; if (!a.target || !a.other) return false;
      const b = sides.get(a.other); if (!b) return false;
      return b.other === sid && b.accountSid === a.target && b.target === a.accountSid && b.amount === -a.amount && b.date === a.date && (a.top || b.top) && a.accountSid !== a.target;
    };
    const ids = new Map<string, string>();
    for (const sid of sides.keys()) ids.set(sid, newId());
    let unlinked = 0, catDropped = 0, pairs = 0, splitLines = 0;
    const ins = db.prepare(`INSERT INTO transactions(id,account_id,date,payee_id,category_id,memo,amount,cleared,flag,transfer_account_id,transfer_txn_id,parent_id,is_split,source,source_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const now = nowIso(); const source = model.kind;
    for (const t of model.transactions) {
      const id = ids.get(t.sid)!; const on = onBudget.get(t.accountSid)!; const isSplit = t.splits.length > 0;
      const resolve = (x: { sid: string; categorySid: string | null; transferAccountSid: string | null; transferSid: string | null }) => {
        let transferAcc: string | null = null, transferTxn: string | null = null, label: string | null = null;
        if (x.transferAccountSid) {
          if (linkOk(x.sid)) { transferAcc = acc.get(x.transferAccountSid)!; transferTxn = ids.get(x.transferSid!)!; pairs++; }
          else { unlinked++; label = `Transfer : ${accName.get(x.transferAccountSid) ?? 'unknown account'}`; }
        }
        let c = x.categorySid ? cat.get(x.categorySid) ?? null : null;
        if (c && (!on || (transferAcc && onBudget.get(x.transferAccountSid!)))) { c = null; catDropped++; }
        return { transferAcc, transferTxn, label, c };
      };
      if (isSplit) {
        ins.run(id, acc.get(t.accountSid)!, t.date, ensurePayee(t.payeeName), null, t.memo, t.amount, t.cleared, t.flag, null, null, null, 1, source, t.sid, now);
        for (const s of t.splits) {
          const r = resolve(s); splitLines++;
          ins.run(ids.get(s.sid)!, acc.get(t.accountSid)!, t.date, null, r.c, r.label ? `${r.label}${s.memo ? ' — ' + s.memo : ''}` : s.memo, s.amount, t.cleared, null, r.transferAcc, r.transferTxn, id, 0, source, s.sid, now);
        }
      } else {
        const r = resolve(t);
        ins.run(id, acc.get(t.accountSid)!, t.date, r.transferAcc ? null : ensurePayee(r.label ?? t.payeeName), r.c, t.memo, t.amount, t.cleared, t.flag, r.transferAcc, r.transferTxn, null, 0, source, t.sid, now);
      }
    }
    if (unlinked) warnings.push({ level: 'warning', code: 'transfer_link_invalid', message: `${unlinked} transfer side(s) did not match their counterpart exactly (account, date, opposite amount) and were imported as ordinary transactions named "Transfer : <account>". Amounts and account balances are unaffected.`, count: unlinked });
    if (catDropped) warnings.push({ level: 'info', code: 'category_dropped', message: `${catDropped} categor${catDropped === 1 ? 'y was' : 'ies were'} removed from tracking-account rows or transfers between budget accounts, which never carry a category in YNAB4.`, count: catDropped });
    const insB = db.prepare(`INSERT INTO monthly_budgets(month,category_id,budgeted,overspending,note) VALUES(?,?,?,?,?)
      ON CONFLICT(month,category_id) DO UPDATE SET budgeted=budgeted+excluded.budgeted, overspending=COALESCE(excluded.overspending, overspending), note=CASE WHEN note='' THEN excluded.note ELSE note END`);
    let cells = 0;
    for (const b of model.budgets) { const c = cat.get(b.categorySid); if (!c || c.startsWith('income:')) continue; insB.run(b.month, c, b.budgeted, b.overspending, b.note); cells++; }
    const insN = db.prepare('INSERT OR REPLACE INTO month_notes(month,note) VALUES(?,?)');
    for (const n of model.monthNotes) insN.run(n.month, n.note);
    const insS = db.prepare('INSERT INTO scheduled(id,account_id,next_date,frequency,anchor_day,payee_id,category_id,memo,amount,flag,transfer_account_id,splits,source_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const s of model.scheduled) {
      insS.run(newId(), acc.get(s.accountSid)!, s.nextDate, s.frequency, Number(s.nextDate.slice(8, 10)), ensurePayee(s.payeeName), s.categorySid ? cat.get(s.categorySid) ?? null : null, s.memo, s.amount, s.flag,
        s.transferAccountSid ? acc.get(s.transferAccountSid) ?? null : null,
        JSON.stringify(s.splits.map(x => ({ amount: x.amount, categoryId: x.categorySid ? cat.get(x.categorySid) ?? null : null, memo: x.memo, transferAccountId: x.transferAccountSid ? acc.get(x.transferAccountSid) ?? null : null }))), s.sid);
    }
    return { acc, cat, counts: { pairs: pairs / 2, splitLines, cells } };
  });

  // ------------------------------------------------------------------ audit
  const db = svc.db; const checks: AuditCheck[] = [];
  const fmt = (n: number) => (n / 100).toFixed(2);
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as any;
  const accounts = svc.listAccounts(); const byId = new Map(accounts.map(a => [a.id, a]));
  const txCount = one('SELECT COUNT(*) n FROM transactions WHERE parent_id IS NULL').n as number;
  const skipped = model.warnings.filter(w => ['txn_account_missing', 'txn_bad_date', 'txn_bad_amount'].includes(w.code)).reduce((s, w) => s + (w.count ?? 0), 0);
  {
    const expected = model.transactions.length;
    checks.push({ name: 'Transaction count', status: txCount === expected && skipped === 0 ? 'pass' : 'fail',
      detail: skipped ? `${txCount} imported; ${skipped} source row(s) could not be read and were skipped (see warnings).` : `${txCount} transactions imported (source: ${expected}${model.kind === 'ynab4-csv' ? ` from ${model.expected.transactionCount} register rows incl. split lines` : ''}).` });
  }
  checks.push({ name: 'Account count', status: accounts.length === model.accounts.length ? 'pass' : 'fail', detail: `${accounts.length} of ${model.accounts.length} accounts.` });
  const catCount = one(`SELECT COUNT(*) n FROM categories WHERE kind='normal'`).n as number;
  checks.push({ name: 'Category count', status: catCount === model.categories.length ? 'pass' : 'fail', detail: `${catCount} of ${model.categories.length} categories.` });
  {
    const mm: AuditCheck['mismatches'] = [];
    for (const e of model.expected.accountBalances) {
      const a = byId.get(maps.acc.get(e.accountSid)!); if (!a) continue;
      if (a.balance !== e.balance) mm.push({ where: a.name, expected: fmt(e.balance), actual: fmt(a.balance), hint: 'Rows that could not be read (see warnings) change the balance.' });
    }
    const n = model.expected.accountBalances.length;
    checks.push(n ? { name: 'Account balances', status: mm.length ? 'fail' : 'pass', detail: mm.length ? `${mm.length} of ${n} account balance(s) differ from the source.` : `All ${n} account balance(s) match the source (${model.expected.accountBalances[0].basis}).`, mismatches: mm }
      : { name: 'Account balances', status: 'skipped', detail: 'The source contains no balance information to compare against.' });
    const missing = model.accounts.length - n;
    if (n && missing > 0) checks.push({ name: 'Account balances (unverifiable)', status: 'info', detail: `${missing} account(s) have no usable running balance in the source and could not be compared.` });
  }
  checks.push({ name: 'Total on-budget money', status: 'info', detail: `${fmt(accounts.filter(a => a.onBudget).reduce((s, a) => s + a.balance, 0))} across ${accounts.filter(a => a.onBudget).length} budget account(s); ${fmt(accounts.filter(a => !a.onBudget).reduce((s, a) => s + a.balance, 0))} in ${accounts.filter(a => !a.onBudget).length} tracking account(s).` });
  {
    const exp = model.expected.monthly;
    if (exp.length) {
      const mm: NonNullable<AuditCheck['mismatches']> = []; let bad = 0; const months = new Set<string>(); const badMonths = new Set<string>();
      const names = new Map(model.categories.map(c => [c.sid, c.name]));
      const cache = new Map<string, Map<string, { budgeted: number; activity: number; available: number }>>();
      for (const e of exp) {
        months.add(e.month);
        let m = cache.get(e.month); if (!m) { m = new Map(svc.getBudget(e.month).rows.map(r => [r.categoryId, r])); cache.set(e.month, m); }
        const r = m.get(maps.cat.get(e.categorySid)!); if (!r) continue;
        const diffs: string[] = [];
        if (r.budgeted !== e.budgeted) diffs.push('budgeted'); if (r.activity !== e.activity) diffs.push('activity'); if (r.available !== e.balance) diffs.push('balance');
        if (diffs.length) {
          bad++; badMonths.add(e.month);
          if (mm.length < 200) mm.push({ where: `${e.month} · ${names.get(e.categorySid)} (${diffs.join(', ')})`, expected: `budgeted ${fmt(e.budgeted)}, activity ${fmt(e.activity)}, balance ${fmt(e.balance)}`,
            actual: `budgeted ${fmt(r.budgeted)}, activity ${fmt(r.activity)}, balance ${fmt(r.available)}`,
            hint: diffs.includes('activity') ? 'Activity differs: check unlinked transfers, unreadable rows or the account budget/off-budget setting.' : diffs.length === 1 && diffs[0] === 'balance' ? 'Only the balance differs: an earlier month or the overspending (red arrow) setting for this category differs.' : undefined });
        }
      }
      const sorted = [...months].sort(); const recent = sorted.slice(-2); const recentBad = recent.filter(m => badMonths.has(m));
      checks.push({ name: 'Monthly budgeted, activity and category balances', status: bad ? 'fail' : 'pass', mismatches: mm, mismatchCount: bad,
        detail: bad ? `${bad} of ${exp.length} category-month values differ from the Budget export, in ${badMonths.size} of ${months.size} month(s). First affected month: ${[...badMonths].sort()[0]}.`
          : `All ${exp.length} category-month values across ${months.size} month(s) (${sorted[0]} – ${sorted[sorted.length - 1]}) match the Budget export exactly.` });
      checks.push({ name: `Most recent months (${recent.join(', ')})`, status: recentBad.length ? 'fail' : 'pass', detail: recentBad.length ? `Differences remain in ${recentBad.join(', ')}.` : 'Budgeted, activity and balances match for every category.' });
    } else checks.push({ name: 'Monthly budget values', status: 'skipped', detail: model.kind === 'ynab4-native' ? 'The native file stores budgeted amounts (imported exactly) but not YNAB4\'s computed balances. The independent audit recalculates every month separately; to compare with YNAB4\'s own figures, run npm run audit:ynab4 with --budget-csv and a Budget export from YNAB4.' : 'No Budget export was provided.' });
  }
  if (model.expected.categoryBalances.length) {
    const cur = new Map(svc.getBudget(monthOf(todayISO())).rows.map(r => [r.categoryId, r.available])); let diff = 0;
    for (const e of model.expected.categoryBalances) if (cur.get(maps.cat.get(e.categorySid)!) !== e.balance) diff++;
    checks.push({ name: 'Category balances cached by YNAB4', status: 'info', detail: diff ? `${diff} of ${model.expected.categoryBalances.length} differ from the balance YNAB4 last cached. The cache reflects the month that was open when YNAB4 last saved, so differences are expected unless that was the current month.` : `All ${model.expected.categoryBalances.length} match the balances YNAB4 last cached.` });
  }
  const problems = svc.checkIntegrity();
  checks.push({ name: 'Internal consistency (transfers, splits, budget identity)', status: problems.length ? 'fail' : 'pass', detail: problems.length ? problems.slice(0, 5).join('; ') : 'Transfers net to zero, every split adds up, and each month satisfies: budget cash = Available to Budget + category balances.' });
  const uncategorized = one(`SELECT COUNT(*) n FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN accounts ta ON ta.id=t.transfer_account_id
    WHERE a.on_budget=1 AND t.is_split=0 AND t.category_id IS NULL AND (t.transfer_account_id IS NULL OR ta.on_budget=0)`).n as number;
  if (uncategorized) checks.push({ name: 'Uncategorised budget transactions', status: 'info', detail: `${uncategorized} transaction(s) in budget accounts have no category. As in YNAB4 they change account balances but are invisible to the budget until categorised.` });

  const range = one('SELECT MIN(date) a, MAX(date) b FROM transactions'); const brange = one('SELECT MIN(month) a, MAX(month) b, COUNT(DISTINCT month) n FROM monthly_budgets WHERE budgeted<>0');
  const independent = audit ? audit(svc) : undefined;
  const failed = checks.some(c => c.status === 'fail') || warnings.some(w => w.level === 'error') || independent?.verdict === 'FAIL';
  const result: ImportResult = {
    ok: !failed, status: failed ? 'needs_attention' : 'verified', kind: model.kind, checks, warnings, coverage: model.coverage, openMonth: monthOf(todayISO()),
    counts: { accounts: accounts.length, groups: model.groups.length, categories: catCount, payees: one('SELECT COUNT(*) n FROM payees').n, transactions: txCount, splitLines: maps.counts.splitLines,
      transferPairs: maps.counts.pairs, budgetCells: maps.counts.cells, budgetMonths: brange.n ?? 0, scheduled: model.scheduled.length },
    range: { firstTransaction: range.a, lastTransaction: range.b, firstBudgetMonth: brange.a, lastBudgetMonth: brange.b },
    ...(independent ? { audit: independent } : {}),
  };
  db.prepare('INSERT INTO imports(id,kind,fingerprint,at,summary) VALUES(?,?,?,?,?)').run(newId(), model.kind, fingerprint, nowIso(), JSON.stringify(result));
  return result;
}
