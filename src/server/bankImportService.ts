/**
 * Smart Bank Import, server side: enrich candidates with payee/category suggestions and duplicate
 * verdicts, and commit approved rows atomically. Nothing is written until the user confirms, and
 * the commit re-validates everything (it does not trust the preview).
 */
import { newId } from './db.ts';
import type { BudgetService } from './budgetService.ts';
import { bad, conflict } from './errors.ts';
import { BLOCKING, type Candidate, type IssueCode } from '../shared/bankparse.ts';
import { classifyDuplicates, normalizePayee, payeeSimilarity, type DupExisting, type DupVerdict } from '../shared/matching.ts';
import { addDays, isValidISODate, todayISO } from '../shared/dates.ts';
import type { TxnInput } from '../shared/types.ts';

export interface AnalyzedRow extends Candidate {
  rawPayee: string;
  payeeMatch: 'rule' | 'exact' | 'normalized' | 'similar' | 'transfer' | 'none';
  payeeConfidence: number;
  categoryId: string | null; categoryConfidence: number; categorySource: 'rule' | 'history' | 'file' | 'none';
  transferAccountId: string | null;
  duplicate: DupVerdict; needsReview: boolean;
}
export interface CommitRow {
  date: string; payeeName: string; amount: number; categoryId?: string | null; memo?: string; transferAccountId?: string | null;
  importId?: string | null; rawPayee?: string; issues?: IssueCode[]; reviewed?: boolean; allowDuplicate?: boolean; sourceIndex?: number;
}
export interface Rule { id: string; matchType: 'exact' | 'contains' | 'regex'; pattern: string; payeeName: string | null; categoryId: string | null; transferAccountId: string | null; origin: 'user' | 'learned'; uses: number }

export function listRules(svc: BudgetService): Rule[] {
  return (svc.db.prepare(`SELECT * FROM payee_rules ORDER BY origin='learned', pattern`).all() as any[])
    .map(r => ({ id: r.id, matchType: r.match_type, pattern: r.pattern, payeeName: r.payee_name, categoryId: r.category_id, transferAccountId: r.transfer_account_id, origin: r.origin, uses: r.uses }));
}
export function saveRule(svc: BudgetService, r: Omit<Rule, 'id' | 'uses' | 'origin'> & { id?: string; origin?: 'user' | 'learned' }): string {
  const pattern = r.pattern.trim(); if (!pattern || pattern.length > 200) throw bad('Rule text is required (max 200 characters)');
  if (r.matchType === 'regex') { try { new RegExp(pattern, 'i'); } catch { throw bad('Invalid regular expression'); } }
  if (!r.payeeName?.trim() && !r.categoryId && !r.transferAccountId) throw bad('A rule must set a payee, a category or a transfer account');
  return svc.mutate('Save import rule', () => {
    const id = r.id ?? newId();
    svc.db.prepare(`INSERT INTO payee_rules(id,match_type,pattern,payee_name,category_id,transfer_account_id,origin) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET match_type=excluded.match_type, pattern=excluded.pattern, payee_name=excluded.payee_name, category_id=excluded.category_id, transfer_account_id=excluded.transfer_account_id`)
      .run(id, r.matchType, pattern, r.payeeName?.trim() || null, r.categoryId ?? null, r.transferAccountId ?? null, r.origin ?? 'user');
    return id;
  });
}
export function deleteRule(svc: BudgetService, id: string) { svc.mutate('Delete import rule', () => { svc.db.prepare('DELETE FROM payee_rules WHERE id=?').run(id); }); }

function matchRule(rules: Rule[], raw: string, norm: string): Rule | null {
  const lower = raw.toLowerCase();
  for (const r of rules) {
    if (r.matchType === 'exact' && (normalizePayee(r.pattern) === norm || r.pattern.toLowerCase() === lower)) return r;
    if (r.matchType === 'contains' && (lower.includes(r.pattern.toLowerCase()) || norm.includes(normalizePayee(r.pattern)))) return r;
    if (r.matchType === 'regex') { try { if (new RegExp(r.pattern, 'i').test(raw)) return r; } catch { /* invalid stored pattern: ignore */ } }
  }
  return null;
}
function existingFor(svc: BudgetService, accountId: string, dates: string[]): DupExisting[] {
  if (!dates.length) return [];
  const min = addDays(dates.reduce((a, b) => (a < b ? a : b)), -4), max = addDays(dates.reduce((a, b) => (a > b ? a : b)), 4);
  return (svc.db.prepare(`SELECT t.id, t.date, t.amount, COALESCE(p.norm,'') payeeNorm, t.import_id importId, t.transfer_account_id IS NOT NULL isTransfer
    FROM transactions t LEFT JOIN payees p ON p.id=t.payee_id WHERE t.account_id=? AND t.parent_id IS NULL AND t.date BETWEEN ? AND ?`).all(accountId, min, max) as any[])
    .map(r => ({ ...r, isTransfer: !!r.isTransfer }));
}

export function analyze(svc: BudgetService, accountId: string, cands: Candidate[]): AnalyzedRow[] {
  const accounts = svc.listAccounts(); const account = accounts.find(a => a.id === accountId); if (!account) throw bad('Unknown account');
  const rules = listRules(svc).sort((a, b) => (a.origin === b.origin ? 0 : a.origin === 'user' ? -1 : 1));
  const payees = svc.db.prepare('SELECT id, name, norm, auto_category_id auto FROM payees').all() as { id: string; name: string; norm: string; auto: string | null }[];
  const byName = new Map(payees.map(p => [p.name.toLowerCase(), p])); const byNorm = new Map<string, typeof payees[0]>(); for (const p of payees) if (!byNorm.has(p.norm)) byNorm.set(p.norm, p);
  // category history per payee over the last two years (splits excluded: they say little about a single category)
  const hist = new Map<string, Map<string, number>>();
  for (const r of svc.db.prepare(`SELECT payee_id p, category_id c, COUNT(*) n FROM transactions WHERE payee_id IS NOT NULL AND category_id IS NOT NULL AND date>=? GROUP BY 1,2`).all(addDays(todayISO(), -730)) as { p: string; c: string; n: number }[])
    (hist.get(r.p) ?? hist.set(r.p, new Map()).get(r.p)!).set(r.c, r.n);
  const cats = svc.listCategories(); const groups = new Map(svc.listGroups().map(g => [g.id, g.name]));
  const catByName = new Map<string, string>();
  for (const c of cats) { catByName.set(`${groups.get(c.groupId)}: ${c.name}`.toLowerCase(), c.id); if (!catByName.has(c.name.toLowerCase())) catByName.set(c.name.toLowerCase(), c.id); }
  catByName.set('income', 'income:this'); catByName.set('available this month', 'income:this'); catByName.set('available next month', 'income:next');
  const validCat = new Set([...cats.map(c => c.id), 'income:this', 'income:next']);

  const rows: AnalyzedRow[] = cands.map(c => {
    const raw = c.payee; const norm = normalizePayee(raw);
    const row: AnalyzedRow = { ...c, issues: [...c.issues], rawPayee: raw, payeeMatch: 'none', payeeConfidence: 0, categoryId: null, categoryConfidence: 0, categorySource: 'none', transferAccountId: null,
      duplicate: { status: 'new', reason: '', matchIds: [] }, needsReview: false };
    let payeeId: string | null = null;
    const rule = raw ? matchRule(rules, raw, norm) : null;
    if (rule) {
      row.payeeMatch = 'rule'; row.payeeConfidence = rule.origin === 'user' ? 0.97 : 0.9;
      if (rule.transferAccountId && rule.transferAccountId !== accountId && accounts.some(a => a.id === rule.transferAccountId)) row.transferAccountId = rule.transferAccountId;
      if (rule.payeeName) { row.payee = rule.payeeName; payeeId = byName.get(rule.payeeName.toLowerCase())?.id ?? null; }
      if (rule.categoryId && validCat.has(rule.categoryId)) { row.categoryId = rule.categoryId; row.categoryConfidence = row.payeeConfidence; row.categorySource = 'rule'; }
    }
    if (!rule && raw) {
      const exact = byName.get(raw.toLowerCase()) ?? null, n = exact ? null : byNorm.get(norm) ?? null;
      if (exact) { row.payee = exact.name; payeeId = exact.id; row.payeeMatch = 'exact'; row.payeeConfidence = 0.95; }
      else if (n) { row.payee = n.name; payeeId = n.id; row.payeeMatch = 'normalized'; row.payeeConfidence = 0.85; }
      else {
        let best: typeof payees[0] | null = null, bs = 0;
        for (const p of payees) { const s = payeeSimilarity(norm, p.norm); if (s > bs) { bs = s; best = p; } }
        if (best && bs >= 0.6) { row.payee = best.name; payeeId = best.id; row.payeeMatch = 'similar'; row.payeeConfidence = Math.round(bs * 75) / 100; }
        else {
          // a transfer between own accounts: the bank text names another account of this budget
          const other = accounts.find(a => a.id !== accountId && !a.closed && a.name.length >= 3 && norm.includes(normalizePayee(a.name)));
          if (other) { row.transferAccountId = other.id; row.payeeMatch = 'transfer'; row.payeeConfidence = 0.6; }
        }
      }
    }
    if (c.categoryName) {
      const id = catByName.get(c.categoryName.toLowerCase());
      if (id) { row.categoryId = id; row.categoryConfidence = 1; row.categorySource = 'file'; } else row.issues.push('unknown_category');
    }
    if (!row.categoryId && payeeId && !row.transferAccountId) {
      const h = hist.get(payeeId);
      if (h?.size) {
        const total = [...h.values()].reduce((a, b) => a + b, 0); const [cid, n] = [...h.entries()].sort((a, b) => b[1] - a[1])[0];
        if (validCat.has(cid)) { row.categoryId = cid; row.categoryConfidence = Math.round((n / total) * row.payeeConfidence * 100) / 100; row.categorySource = 'history'; }
      } else { const auto = payees.find(p => p.id === payeeId)?.auto; if (auto && validCat.has(auto)) { row.categoryId = auto; row.categoryConfidence = Math.round(0.6 * row.payeeConfidence * 100) / 100; row.categorySource = 'history'; } }
    }
    if (!account.onBudget) { row.categoryId = null; row.categoryConfidence = 0; row.categorySource = 'none'; }
    return row;
  });
  const verdicts = classifyDuplicates(rows.map(r => ({ date: r.date, amount: r.amount, payeeNorm: normalizePayee(r.rawPayee || r.payee), importId: r.importId, sourceIndex: r.sourceIndex })),
    existingFor(svc, accountId, rows.map(r => r.date).filter((d): d is string => !!d)));
  rows.forEach((r, i) => { r.duplicate = verdicts[i]; r.needsReview = r.issues.some(x => BLOCKING.has(x)) || r.duplicate.status === 'needs_review'; });
  return rows;
}

/** Re-check duplicates for rows as edited in the preview. */
export function recheck(svc: BudgetService, accountId: string, rows: { date: string | null; amount: number | null; payee: string; importId?: string | null; sourceIndex?: number }[]): DupVerdict[] {
  return classifyDuplicates(rows.map(r => ({ date: r.date, amount: r.amount, payeeNorm: normalizePayee(r.payee), importId: r.importId ?? null, sourceIndex: r.sourceIndex ?? 0 })),
    existingFor(svc, accountId, rows.map(r => r.date).filter((d): d is string => !!d && isValidISODate(d))));
}

export function commit(svc: BudgetService, accountId: string, rows: CommitRow[]) {
  if (!rows.length) throw bad('Nothing selected to import');
  if (rows.length > 5000) throw bad('At most 5000 transactions per import');
  const accounts = svc.listAccounts(); const account = accounts.find(a => a.id === accountId); if (!account) throw bad('Unknown account');
  const today = todayISO(); const problems: { index: number; message: string }[] = [];
  rows.forEach((r, i) => {
    const issues = new Set<IssueCode>(r.issues ?? []);
    if (!isValidISODate(r.date)) { problems.push({ index: i, message: 'Invalid or missing date' }); return; }
    if (!Number.isSafeInteger(r.amount)) { problems.push({ index: i, message: 'Invalid or missing amount' }); return; }
    if (r.amount === 0) problems.push({ index: i, message: 'Amount is zero' });
    if (!r.transferAccountId && !r.payeeName?.trim()) problems.push({ index: i, message: 'Payee is missing' });
    if (r.transferAccountId && (r.transferAccountId === accountId || !accounts.some(a => a.id === r.transferAccountId))) problems.push({ index: i, message: 'Invalid transfer account' });
    // server-derived risk flags are added regardless of what the client sent
    if (r.date > addDays(today, 1)) issues.add('future_date');
    if (Math.abs(r.amount) >= 100_000_00) issues.add('large_amount');
    const blocking = [...issues].filter(x => BLOCKING.has(x) && x !== 'zero_amount' && x !== 'missing_date' && x !== 'missing_amount' && x !== 'missing_payee');
    if (blocking.length && !r.reviewed) problems.push({ index: i, message: `Needs review before import (${blocking.join(', ')})` });
  });
  if (problems.length) throw conflict('Some rows cannot be imported yet.', 'IMPORT_ROWS_INVALID', { problems });
  const verdicts = recheck(svc, accountId, rows.map(r => ({ date: r.date, amount: r.amount, payee: r.rawPayee || r.payeeName, importId: r.importId, sourceIndex: r.sourceIndex })));
  const dups = verdicts.map((v, index) => ({ index, status: v.status, message: v.reason })).filter(v => v.status !== 'new' && !rows[v.index].allowDuplicate);
  if (dups.length) throw conflict('Some rows look like duplicates. Deselect them or confirm each one explicitly.', 'IMPORT_DUPLICATES', { problems: dups });

  return svc.mutate(`Import ${rows.length} bank transaction${rows.length === 1 ? '' : 's'}`, () => {
    const inputs: TxnInput[] = rows.map(r => ({ accountId, date: r.date, amount: r.amount, memo: (r.memo ?? '').slice(0, 500), cleared: 'cleared', source: 'bank_import', importId: r.importId || null,
      ...(r.transferAccountId ? { transferAccountId: r.transferAccountId, categoryId: r.categoryId ?? null } : { payeeName: r.payeeName.trim().slice(0, 200), categoryId: account.onBudget ? r.categoryId ?? null : null }) }));
    const res = svc.createTransactions(inputs);
    // remember corrections: bank text → chosen payee/category, for next time (never touches existing transactions)
    let learned = 0;
    const find = svc.db.prepare(`SELECT id FROM payee_rules WHERE origin='learned' AND match_type='exact' AND pattern=?`);
    for (const r of rows) {
      const raw = r.rawPayee?.trim(); if (!raw) continue;
      const norm = normalizePayee(raw); if (!norm) continue;
      const target = r.transferAccountId ? null : r.payeeName.trim();
      if (!r.transferAccountId && normalizePayee(target!) === norm) continue; // nothing to learn: same name
      const ex = find.get(norm) as { id: string } | undefined;
      if (ex) svc.db.prepare('UPDATE payee_rules SET payee_name=?, category_id=?, transfer_account_id=?, uses=uses+1 WHERE id=?').run(target, r.transferAccountId ? null : r.categoryId ?? null, r.transferAccountId ?? null, ex.id);
      else { svc.db.prepare(`INSERT INTO payee_rules(id,match_type,pattern,payee_name,category_id,transfer_account_id,origin,uses) VALUES(?,?,?,?,?,?,'learned',1)`).run(newId(), 'exact', norm, target, r.transferAccountId ? null : r.categoryId ?? null, r.transferAccountId ?? null); learned++; }
    }
    return { imported: res.ids.length, learned, totalInflow: rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0), totalOutflow: rows.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0), changed: res.changed, deleted: res.deleted };
  });
}
