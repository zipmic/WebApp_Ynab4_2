/**
 * Reader for native YNAB4 budgets (the "<Name>~<id>.ynab4" folder).
 *
 * Layout (verified against the open-source envelope-zero YNAB4 parser and community documentation):
 *   Budget.ymeta                         {"relativeDataFolderName": "data1~XXXXXXXX", ...}
 *   data1~X/devices/<A>.ydevice          {"deviceGUID", "shortDeviceId", "hasFullKnowledge", "knowledge", ...}
 *   data1~X/<deviceGUID>/Budget.yfull    complete budget as JSON
 *   data1~X/<deviceGUID>/*.ydiff         incremental changes published by that device
 * Amounts are JSON numbers in major units; dates are YYYY-MM-DD; deleted entities carry isTombstone.
 */
import { isValidISODate } from './dates.ts';
import { majorNumberToMinor } from './money.ts';
import { SID_INCOME_NEXT, SID_INCOME_THIS, type ImportModel, type ImportWarning, type ImSplit, type ImTxn } from './importModel.ts';
import type { AccountType, Cleared, Flag, Frequency } from './types.ts';
import { FLAGS } from './types.ts';

export interface SourceFile { path: string; text: string }

const ACCOUNT_TYPES: Record<string, AccountType> = { Checking: 'checking', Savings: 'savings', CreditCard: 'credit_card', Cash: 'cash', LineOfCredit: 'line_of_credit',
  Paypal: 'paypal', PayPal: 'paypal', MerchantAccount: 'merchant', InvestmentAccount: 'investment', Mortgage: 'mortgage', OtherAsset: 'other_asset', OtherLiability: 'other_liability' };
const FREQ: Record<string, Frequency> = { Once: 'once', Never: 'once', Daily: 'daily', Weekly: 'weekly', EveryOtherWeek: 'every_other_week', TwiceAMonth: 'twice_a_month',
  Every4Weeks: 'every_4_weeks', Monthly: 'monthly', EveryOtherMonth: 'every_other_month', Every3Months: 'every_3_months', Every4Months: 'every_4_months',
  TwiceAYear: 'twice_a_year', Yearly: 'yearly', EveryOtherYear: 'every_other_year' };
const CAT_IMMEDIATE = 'Category/__ImmediateIncome__', CAT_DEFERRED = 'Category/__DeferredIncome__', CAT_SPLIT = 'Category/__Split__';
const MASTER_INTERNAL = 'MasterCategory/__Internal__', MASTER_HIDDEN = 'MasterCategory/__Hidden__', MASTER_INCOME = 'MasterCategory/__Income__';

const base = (p: string) => p.replace(/\\/g, '/').split('/').pop()!;
const norm = (p: string) => p.replace(/\\/g, '/');
function parseKnowledge(k: string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const part of (k ?? '').split(',')) { const [d, v] = part.trim().split('-'); if (d && v && /^\d+$/.test(v)) m.set(d, Math.max(m.get(d) ?? 0, +v)); }
  return m;
}
const versionOf = (v: string | undefined): [string, number] | null => { const m = /^([A-Za-z0-9]+)-(\d+)$/.exec(v ?? ''); return m ? [m[1], +m[2]] : null; };

export function isYnab4Native(files: SourceFile[]): boolean {
  return files.some(f => /\.(yfull|ymeta)$/i.test(f.path));
}

/** Pick the most complete Budget.yfull and fold in newer .ydiff changes from other devices. */
/** AppleDouble resource forks ("._name") and __MACOSX folders in Mac-made zips are not budget data. */
const isJunk = (p: string) => /(^|\/)__MACOSX\//.test(norm(p)) || base(p).startsWith('._');
const knowledgeSum = (k: Map<string, number>) => [...k.values()].reduce((a, b) => a + b, 0);
const covers = (a: Map<string, number>, b: Map<string, number>) => [...b].every(([d, v]) => (a.get(d) ?? 0) >= v);

/**
 * Pick the authoritative Budget.yfull and fold in sync diffs it has not seen. Rules, all verified on a real
 * multi-device budget:
 *  - "Budget.ymeta" (exactly that name) names the live data folder; Dropbox "conflicted copy" .ymeta files and
 *    old data folders are ignored.
 *  - Each device folder holds a Budget.yfull whose fileMetaData.currentKnowledge ("A-123,B-45,…") says which
 *    changes of every device it already contains. The copy with the most knowledge wins.
 *  - A .ydiff item is applied only when its entityVersion is NOT covered by that knowledge. Diffs are applied in
 *    causal order = ascending sum of their knowledge counters (publishTime is display text and does not sort).
 */
export function loadYfull(input: SourceFile[], warnings: ImportWarning[]): { budget: any; name: string } {
  const files = input.filter(f => !isJunk(f.path));
  const allYfull = files.filter(f => /\.yfull$/i.test(f.path));
  if (!allYfull.length) throw new Error('No Budget.yfull file found. Select the whole .ynab4 folder (or a zip of it), or the Budget.yfull file itself.');
  let name = 'Imported YNAB4 budget';
  const folder = /([^/]+?)(?:~[0-9A-F]{6,})?\.ynab4\//i.exec(norm(allYfull[0].path)); if (folder) name = folder[1];
  let dataFolder: string | null = null;
  const metas = files.filter(f => /\.ymeta$/i.test(f.path));
  const meta = metas.find(f => base(f.path).toLowerCase() === 'budget.ymeta') ?? (metas.length === 1 ? metas[0] : undefined);
  if (metas.length > 1) warnings.push({ level: 'info', code: 'ymeta_conflicted_copies', message: `${metas.length - 1} leftover "conflicted copy" metadata file(s) from file syncing were ignored; ${meta ? 'Budget.ymeta decides which data folder is current' : 'no plain Budget.ymeta was found'}.`, count: metas.length - 1 });
  if (meta) { try { dataFolder = JSON.parse(meta.text).relativeDataFolderName ?? null; } catch { warnings.push({ level: 'warning', code: 'ymeta_unreadable', message: 'Budget.ymeta could not be read; using the most complete Budget.yfull found.' }); } }
  else if (metas.length > 1) warnings.push({ level: 'warning', code: 'ymeta_missing', message: 'Only conflicted copies of Budget.ymeta exist; using the most complete Budget.yfull found. Check that the newest data was imported.' });
  const inData = (p: string) => !dataFolder || norm(p).includes('/' + dataFolder + '/') || norm(p).startsWith(dataFolder + '/');
  let yfulls = allYfull.filter(f => inData(f.path));
  if (!yfulls.length) { yfulls = allYfull; warnings.push({ level: 'warning', code: 'data_folder_missing', message: `The data folder named in Budget.ymeta (${dataFolder}) contains no Budget.yfull; using the most complete copy found elsewhere.` }); dataFolder = null; }
  const parsed = yfulls.map(f => { try { const budget = JSON.parse(f.text); return budget && Array.isArray(budget.transactions) && Array.isArray(budget.accounts) ? { f, budget, known: parseKnowledge(budget.fileMetaData?.currentKnowledge) } : null; } catch { return null; } })
    .filter((x): x is { f: SourceFile; budget: any; known: Map<string, number> } => !!x);
  if (!parsed.length) {
    try { JSON.parse(yfulls[0].text); } catch (e) { throw new Error('Budget.yfull is not valid JSON: ' + (e as Error).message); }
    throw new Error('Budget.yfull does not look like a YNAB4 budget (no accounts/transactions).');
  }
  parsed.sort((a, b) => knowledgeSum(b.known) - knowledgeSum(a.known) || b.f.text.length - a.f.text.length);
  const chosen = parsed[0]; const budget = chosen.budget, known = chosen.known;
  if (parsed.length > 1) {
    const diverged = parsed.slice(1).filter(o => !covers(known, o.known));
    warnings.push(diverged.length
      ? { level: 'warning', code: 'devices_diverged', message: `${parsed.length} device copies of the budget exist and ${diverged.length} of them contain changes the most complete copy has not seen. The most complete copy is used and unseen changes are merged from the sync files below — compare recent entries with YNAB4.` }
      : { level: 'info', code: 'multiple_devices', message: `Found ${parsed.length} device copies of the budget; they agree, and the most complete one is used.` });
  }
  // Sync diffs: only changes the chosen full copy has not seen, in causal order.
  const diffs = files.filter(f => /\.ydiff$/i.test(f.path) && inData(f.path)).map(f => { try { return JSON.parse(f.text); } catch { return null; } }).filter(d => d && Array.isArray(d.items)) as any[];
  const diffOrder = (d: any) => { const k = parseKnowledge(d.startVersion); for (const [dev, v] of parseKnowledge(d.endVersion)) k.set(dev, Math.max(k.get(dev) ?? 0, v)); return knowledgeSum(k); };
  diffs.sort((a, b) => diffOrder(a) - diffOrder(b));
  let applied = 0, unknown = 0;
  const upsert = (list: any[], item: any) => { const i = list.findIndex(x => x.entityId === item.entityId); if (i < 0) list.push(item); else list[i] = { ...list[i], ...item }; return true; };
  for (const d of diffs) for (const item of d.items) {
    const v = versionOf(item.entityVersion); if (!v || (known.get(v[0]) ?? 0) >= v[1]) continue;
    let ok = false;
    switch (item.entityType) {
      case 'transaction': ok = upsert(budget.transactions, item); break;
      case 'account': ok = upsert(budget.accounts, item); break;
      case 'payee': ok = upsert((budget.payees ??= []), item); break;
      case 'scheduledTransaction': ok = upsert((budget.scheduledTransactions ??= []), item); break;
      case 'masterCategory': { const cur = (budget.masterCategories ??= []).find((m: any) => m.entityId === item.entityId); ok = upsert(budget.masterCategories, { ...item, subCategories: item.subCategories ?? cur?.subCategories ?? [] }); break; }
      case 'category': { const m = (budget.masterCategories ?? []).find((x: any) => x.entityId === item.masterCategoryId);
        for (const o of budget.masterCategories ?? []) if (o !== m && o.subCategories) o.subCategories = o.subCategories.filter((s: any) => s.entityId !== item.entityId);
        if (m) ok = upsert((m.subCategories ??= []), item); break; }
      case 'monthlyBudget': { const cur = (budget.monthlyBudgets ??= []).find((m: any) => m.entityId === item.entityId); ok = upsert(budget.monthlyBudgets, { ...item, monthlySubCategoryBudgets: item.monthlySubCategoryBudgets ?? cur?.monthlySubCategoryBudgets ?? [] }); break; }
      case 'monthlyCategoryBudget': { let mb = (budget.monthlyBudgets ??= []).find((m: any) => m.entityId === item.parentMonthlyBudgetId);
        if (!mb && /^MB\/\d{4}-\d{2}$/.test(item.parentMonthlyBudgetId ?? '')) { mb = { entityType: 'monthlyBudget', entityId: item.parentMonthlyBudgetId, month: item.parentMonthlyBudgetId.slice(3) + '-01', monthlySubCategoryBudgets: [] }; budget.monthlyBudgets.push(mb); }
        if (mb) ok = upsert((mb.monthlySubCategoryBudgets ??= []), item); break; }
      // known kinds that carry nothing Budget Reborn imports
      case 'budgetMetaData': case 'fileMetaData': case 'accountMapping': case 'payeeLocation': case 'payeeRenameCondition': case 'payeeStringCondition': case 'setting': break;
      default: unknown++;
    }
    if (ok) applied++;
  }
  if (applied) warnings.push({ level: 'warning', code: 'diffs_applied', message: `${applied} change(s) from sync files (.ydiff) were newer than the full budget copy and were merged into it. Open the budget in YNAB4 once (so it saves a complete copy) for a migration without merging, or compare the most recent entries afterwards.`, count: applied });
  if (unknown) warnings.push({ level: 'warning', code: 'diff_unknown_entities', message: `${unknown} change(s) in sync files were of an unknown kind and were skipped.`, count: unknown });
  return { budget, name };
}

export function parseYnab4Native(files: SourceFile[]): ImportModel {
  const warnings: ImportWarning[] = [];
  const { budget: b, name } = loadYfull(files, warnings);
  const count = (code: string, message: (n: number) => string, level: ImportWarning['level'] = 'warning') => {
    let n = 0; return { hit: () => { n++; }, done: () => { if (n) warnings.push({ level, code, message: message(n), count: n }); } };
  };
  const model: ImportModel = { kind: 'ynab4-native', budgetName: name, currency: null, accounts: [], groups: [], categories: [], payees: [], transactions: [], budgets: [], monthNotes: [], scheduled: [], warnings,
    expected: { accountBalances: [], monthly: [], transactionCount: 0, categoryBalances: [] }, coverage: [] };
  const locale: string | undefined = b.budgetMetaData?.currencyLocale;
  model.currency = ({ da_DK: 'DKK', en_US: 'USD', en_GB: 'GBP', sv_SE: 'SEK', nb_NO: 'NOK', de_DE: 'EUR', fr_FR: 'EUR', nl_NL: 'EUR', en_CA: 'CAD', en_AU: 'AUD' } as Record<string, string>)[locale ?? ''] ?? null;
  const decimals = 2;
  const minor = (n: unknown) => majorNumberToMinor(typeof n === 'number' ? n : Number(n ?? 0), decimals);

  // accounts
  const accounts = new Map<string, any>();
  for (const a of [...b.accounts].sort((x: any, y: any) => (x.sortableIndex ?? 0) - (y.sortableIndex ?? 0))) {
    if (a.isTombstone) continue;
    accounts.set(a.entityId, a);
    const type = ACCOUNT_TYPES[a.accountType];
    if (!type) warnings.push({ level: 'warning', code: 'account_type_unknown', message: `Account "${a.accountName}" has unknown type "${a.accountType}"; imported as Checking.` });
    model.accounts.push({ sid: a.entityId, name: String(a.accountName ?? 'Unnamed account'), type: type ?? 'checking', onBudget: a.onBudget !== false, closed: !!a.hidden, note: a.note ?? '', typeKnown: !!type });
  }
  // categories
  const catMap = new Map<string, string>([[CAT_IMMEDIATE, SID_INCOME_THIS], [CAT_DEFERRED, SID_INCOME_NEXT]]);
  const tombCats = new Map<string, any>();
  const masters = [...(b.masterCategories ?? [])].sort((x: any, y: any) => (x.sortableIndex ?? 0) - (y.sortableIndex ?? 0));
  const groupByName = new Map<string, string>();
  for (const m of masters) {
    if (m.entityId === MASTER_INTERNAL || m.entityId === MASTER_INCOME || m.entityId === MASTER_HIDDEN || m.name === 'Hidden Categories') continue;
    const subs = (m.subCategories ?? []) as any[];
    if (m.isTombstone) { subs.forEach(s => tombCats.set(s.entityId, { ...s, _master: m.name })); continue; }
    model.groups.push({ sid: m.entityId, name: String(m.name), hidden: false, note: m.note ?? '' }); groupByName.set(String(m.name), m.entityId);
    for (const s of [...subs].sort((x, y) => (x.sortableIndex ?? 0) - (y.sortableIndex ?? 0))) {
      if (s.isTombstone) { tombCats.set(s.entityId, { ...s, _master: m.name }); continue; }
      model.categories.push({ sid: s.entityId, groupSid: m.entityId, name: String(s.name), hidden: false, note: s.note ?? '' }); catMap.set(s.entityId, s.entityId);
      if (typeof s.cachedBalance === 'number') model.expected.categoryBalances.push({ categorySid: s.entityId, balance: minor(s.cachedBalance) });
    }
  }
  const ensureGroup = (gname: string, hidden = false) => {
    let sid = groupByName.get(gname);
    if (!sid) { sid = 'group:' + gname; model.groups.push({ sid, name: gname, hidden, note: '' }); groupByName.set(gname, sid); }
    return sid;
  };
  // Hidden categories live under MasterCategory/__Hidden__ and are named
  //   "<original group name> ` <category name> ` <original group entityId>"
  // (observed in a real budget; the original group may itself be deleted). They return to their original group when it
  // still exists, otherwise to a hidden group carrying the original group's name.
  const masterById = new Map<string, any>(masters.map((m: any) => [m.entityId, m]));
  const hiddenGroups = new Map<string, string>(); const liveGroupIds = new Set(model.groups.map(g => g.sid));
  for (const m of masters) {
    if (m.entityId !== MASTER_HIDDEN && m.name !== 'Hidden Categories') continue;
    for (const s of (m.subCategories ?? []) as any[]) {
      if (s.isTombstone) { tombCats.set(s.entityId, { ...s, _master: 'Hidden Categories' }); continue; }
      const parts = String(s.name).split(' ` ');
      let gsid: string, cname = String(s.name);
      if (parts.length >= 3) {
        const origId = parts[parts.length - 1], orig = masterById.get(origId); cname = parts.slice(1, -1).join(' ` ');
        if (orig && !orig.isTombstone && liveGroupIds.has(origId)) gsid = origId;
        else {
          const gname = String(orig?.name ?? parts[0]) || 'Hidden Categories'; const key = orig ? origId : 'name:' + gname;
          gsid = hiddenGroups.get(key) ?? ''; if (!gsid) { gsid = 'hidden-group:' + key; hiddenGroups.set(key, gsid); model.groups.push({ sid: gsid, name: gname, hidden: true, note: '' }); }
        }
      } else if (parts.length === 2) { cname = parts[1]; gsid = groupByName.get(parts[0]) ?? ensureGroup(parts[0], true); }
      else gsid = ensureGroup('Hidden Categories', true);
      model.categories.push({ sid: s.entityId, groupSid: gsid, name: cname || String(s.name), hidden: true, note: s.note ?? '' }); catMap.set(s.entityId, s.entityId);
      if (typeof s.cachedBalance === 'number') model.expected.categoryBalances.push({ categorySid: s.entityId, balance: minor(s.cachedBalance) });
    }
  }
  const revived = count('deleted_category_in_use', n => `${n} deleted categor${n === 1 ? 'y is' : 'ies are'} still referenced by transactions or budgets and were kept as hidden categories.`);
  const unknownCat = count('category_unknown', n => `${n} reference(s) to categories that do not exist in the file were placed in "Unknown (from YNAB4)".`);
  const mapCat = (id: string | null | undefined): string | null => {
    if (!id || id === CAT_SPLIT) return null;
    const hit = catMap.get(id); if (hit) return hit;
    const t = tombCats.get(id);
    if (t) { const g = ensureGroup(t._master ?? 'Deleted categories'); model.categories.push({ sid: id, groupSid: g, name: String(t.name ?? 'Deleted category'), hidden: true, note: t.note ?? '' }); revived.hit(); }
    else { const g = ensureGroup('Unknown (from YNAB4)'); model.categories.push({ sid: id, groupSid: g, name: id.replace(/^Category\//, '').slice(0, 60), hidden: false, note: '' }); unknownCat.hit(); }
    catMap.set(id, id); return id;
  };
  // payees
  const payees = new Map<string, any>();
  for (const p of b.payees ?? []) {
    payees.set(p.entityId, p);
    if (p.isTombstone || String(p.entityId).startsWith('Payee/Transfer:') || p.targetAccountId || !p.name) continue;
    model.payees.push({ name: String(p.name), autoCategorySid: p.autoFillCategoryId && catMap.has(p.autoFillCategoryId) ? catMap.get(p.autoFillCategoryId)! : null });
  }
  const payeeName = (id: string | null | undefined) => { const p = id ? payees.get(id) : null; return p?.name ? String(p.name) : null; };

  // transactions
  const live = (b.transactions as any[]).filter(t => !t.isTombstone);
  const sideIds = new Set<string>(); // every id that can be the far side of a transfer
  for (const t of live) { sideIds.add(t.entityId); for (const s of t.subTransactions ?? []) if (!s.isTombstone) sideIds.add(s.entityId); }
  const cleared = (c: string): Cleared => (c === 'Reconciled' ? 'reconciled' : c === 'Cleared' ? 'cleared' : 'uncleared');
  const flag = (f: string | null | undefined): Flag | null => { const v = f?.toLowerCase(); return v && (FLAGS as readonly string[]).includes(v) ? (v as Flag) : null; };
  const badAccount = count('txn_account_missing', n => `${n} transaction(s) belong to accounts that no longer exist in the file and were skipped.`, 'error');
  const badDate = count('txn_bad_date', n => `${n} transaction(s) have an unreadable date and were skipped.`, 'error');
  const brokenTransfer = count('transfer_unlinked', n => `${n} transfer(s) have no matching other side in the file; imported as ordinary transactions with the payee "Transfer : <account>".`);
  const splitMismatch = count('split_mismatch', n => `${n} split transaction(s) have lines that do not add up to the total; an "(unallocated split remainder)" line was added so account balances stay exact.`);
  const sums = new Map<string, bigint>();
  for (const t of live) {
    if (!accounts.has(t.accountId)) { badAccount.hit(); continue; }
    if (!isValidISODate(String(t.date).slice(0, 10))) { badDate.hit(); continue; }
    const amount = minor(t.amount);
    sums.set(t.accountId, (sums.get(t.accountId) ?? 0n) + BigInt(Math.round(Number(t.amount) * 100)));
    const transferOk = (acc: string | null | undefined, other: string | null | undefined) => !!acc && accounts.has(acc) && !!other && sideIds.has(other);
    let memo = String(t.memo ?? ''); if (t.checkNumber) memo = `#${t.checkNumber}${memo ? ' ' + memo : ''}`;
    const tx: ImTxn = { sid: t.entityId, accountSid: t.accountId, date: String(t.date).slice(0, 10), payeeName: null, categorySid: null, memo, amount, cleared: cleared(t.cleared), flag: flag(t.flag), transferAccountSid: null, transferSid: null, splits: [] };
    const subs = ((t.subTransactions ?? []) as any[]).filter(s => !s.isTombstone);
    if (t.targetAccountId || t.transferTransactionId) {
      if (transferOk(t.targetAccountId, t.transferTransactionId)) { tx.transferAccountSid = t.targetAccountId; tx.transferSid = t.transferTransactionId; }
      else { brokenTransfer.hit(); tx.payeeName = `Transfer : ${accounts.get(t.targetAccountId)?.accountName ?? payeeName(t.payeeId) ?? 'unknown account'}`; }
    } else tx.payeeName = payeeName(t.payeeId);
    if (subs.length) {
      let sum = 0;
      for (const s of subs) {
        const sp: ImSplit = { sid: s.entityId, amount: minor(s.amount), categorySid: mapCat(s.categoryId), memo: String(s.memo ?? ''), transferAccountSid: null, transferSid: null };
        if (s.targetAccountId || s.transferTransactionId) {
          if (transferOk(s.targetAccountId, s.transferTransactionId)) { sp.transferAccountSid = s.targetAccountId; sp.transferSid = s.transferTransactionId; }
          else { brokenTransfer.hit(); sp.memo = `Transfer : ${accounts.get(s.targetAccountId)?.accountName ?? 'unknown account'}${sp.memo ? ' — ' + sp.memo : ''}`; }
        }
        sum += sp.amount; tx.splits.push(sp);
      }
      if (sum !== amount) { splitMismatch.hit(); tx.splits.push({ sid: t.entityId + ':remainder', amount: amount - sum, categorySid: null, memo: '(unallocated split remainder)', transferAccountSid: null, transferSid: null }); }
    } else tx.categorySid = mapCat(t.categoryId);
    model.transactions.push(tx);
  }
  [badAccount, badDate, brokenTransfer, splitMismatch].forEach(c => c.done());
  model.expected.transactionCount = live.length;
  if (model.expected.categoryBalances.every(c => c.balance === 0)) model.expected.categoryBalances = []; // YNAB4 writes cachedBalance 0 for every category: not usable as evidence
  for (const a of model.accounts) model.expected.accountBalances.push({ accountSid: a.sid, balance: Number(sums.get(a.sid) ?? 0n), basis: 'sum of the source file amounts, computed independently of the import' });

  // monthly budgets
  for (const mb of b.monthlyBudgets ?? []) {
    if (mb.isTombstone) continue;
    const month = String(mb.month ?? '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(month)) continue;
    if (mb.note) model.monthNotes.push({ month, note: String(mb.note) });
    for (const c of mb.monthlySubCategoryBudgets ?? []) {
      if (c.isTombstone) continue;
      const budgeted = minor(c.budgeted ?? 0);
      const overspending = c.overspendingHandling === 'Confined' ? 'confined' as const : c.overspendingHandling === 'AffectsBuffer' ? 'affects_buffer' as const : null;
      const note = String(c.note ?? '');
      if (budgeted === 0 && !overspending && !note) continue;
      if (c.categoryId === CAT_IMMEDIATE || c.categoryId === CAT_DEFERRED || c.categoryId === CAT_SPLIT) continue;
      const sid = mapCat(c.categoryId); if (!sid) continue;
      model.budgets.push({ month, categorySid: sid, budgeted, overspending, note });
    }
  }
  revived.done(); unknownCat.done();
  // scheduled
  const freqUnknown = count('schedule_frequency_unknown', n => `${n} scheduled transaction(s) use an unknown frequency and were imported as one-off.`);
  for (const s of b.scheduledTransactions ?? []) {
    if (s.isTombstone || !accounts.has(s.accountId) || !isValidISODate(String(s.date).slice(0, 10))) continue;
    const f = FREQ[s.frequency]; if (!f) freqUnknown.hit();
    const subs = ((s.subTransactions ?? []) as any[]).filter(x => !x.isTombstone);
    model.scheduled.push({ sid: s.entityId, accountSid: s.accountId, nextDate: String(s.date).slice(0, 10), frequency: f ?? 'once', payeeName: s.targetAccountId ? null : payeeName(s.payeeId),
      categorySid: subs.length ? null : mapCat(s.categoryId), memo: String(s.memo ?? ''), amount: minor(s.amount), flag: flag(s.flag),
      transferAccountSid: s.targetAccountId && accounts.has(s.targetAccountId) ? s.targetAccountId : null,
      splits: subs.map(x => ({ amount: minor(x.amount), categorySid: mapCat(x.categoryId), memo: String(x.memo ?? ''), transferAccountSid: x.targetAccountId && accounts.has(x.targetAccountId) ? x.targetAccountId : null })) });
  }
  freqUnknown.done();
  model.coverage = [
    { item: 'Accounts, types, on/off-budget, closed state, notes', status: 'full', note: '' },
    { item: 'Categories, groups, order, hidden categories, notes', status: 'full', note: '' },
    { item: 'Transactions, splits, memos, flags, cleared/reconciled', status: 'full', note: 'Check numbers are kept as a "#123" prefix in the memo.' },
    { item: 'Transfers (linked pairs)', status: 'full', note: 'Links are taken from the file, not guessed.' },
    { item: 'Monthly budgeted amounts, overspending (red arrow) settings, notes', status: 'full', note: '' },
    { item: 'Scheduled transactions', status: 'full', note: '' },
    { item: 'Payees and remembered categories', status: 'partial', note: 'Payee rename rules and map locations are not imported.' },
    { item: 'Reconciliation history', status: 'none', note: 'YNAB4 stores only the reconciled state of each transaction, which is preserved.' },
    { item: 'Account-to-bank import mappings, file-based (QIF/OFX) import settings', status: 'none', note: 'Not applicable in Budget Reborn.' },
  ];
  return model;
}
