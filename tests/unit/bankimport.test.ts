import { describe, expect, it } from 'vitest';
import { analyze, commit, saveRule } from '../../src/server/bankImportService.ts';
import { extractWithVision } from '../../src/server/vision.ts';
import { loadConfig } from '../../src/server/config.ts';
import { needsReview, parseBankCsv, parseBankText, parseImportJson, IMPORT_JSON_EXAMPLE, IMPORT_CSV_EXAMPLE } from '../../src/shared/bankparse.ts';
import { classifyDuplicates, normalizePayee, payeeSimilarity } from '../../src/shared/matching.ts';
import { parseAmount, parseAmountInput } from '../../src/shared/money.ts';
import { parseDate, detectDateStyle, parseMonthLabel } from '../../src/shared/dates.ts';
import { basicBudget } from './helpers.ts';

const TODAY = '2026-11-10';
const text = (s: string, conf?: number) => s.split('\n').map(t => ({ text: t, confidence: conf }));
const parse = (s: string, i = 0) => parseBankText(text(s), { today: TODAY, sourceIndex: i });
const brief = (c: { date: string | null; payee: string; amount: number | null }[]) => c.map(x => [x.date, x.payee, x.amount]);

describe('money and date parsing (Danish and other formats)', () => {
  it('amounts', () => {
    const m = (s: string, style: any = 'auto') => parseAmount(s, style)?.minor ?? null;
    expect(m('-428,50')).toBe(-42850); expect(m('+32.500,00')).toBe(3250000); expect(m('1.234,56 kr.')).toBe(123456); expect(m('kr. -25,00')).toBe(-2500);
    expect(m('428,50-')).toBe(-42850); expect(m('−212,95')).toBe(-21295); expect(m('DKK 1,234.56')).toBe(123456); expect(m('(12.00)')).toBe(-1200);
    expect(m('1 234,56')).toBe(123456); expect(m('0,5')).toBe(50); expect(m('12')).toBe(1200); expect(m('1.234.567,89')).toBe(123456789);
    expect(m('12,345')).toBe(1234500); expect(parseAmount('12,345')!.ambiguous).toBe(true);
    expect(m('1.234', 'comma')).toBe(123400); expect(m('1.234', 'dot')).toBeNull(); // three decimals are never silently rounded
    expect(m('1,2,3')).toBeNull(); expect(m('abc')).toBeNull(); expect(m('')).toBeNull(); expect(m('12,3456')).toBeNull(); expect(m('1.23.45')).toBeNull();
  });
  it('amount input with arithmetic never uses floats', () => {
    expect(parseAmountInput('0,1+0,2')).toBe(30); expect(parseAmountInput('1200/12')).toBe(10000); expect(parseAmountInput('100/3')).toBe(3333);
    expect(parseAmountInput('1.250,50')).toBe(125050); expect(parseAmountInput('-50')).toBe(-5000); expect(parseAmountInput('2*3,5')).toBe(700); expect(parseAmountInput('1/0')).toBeNull(); expect(parseAmountInput('x')).toBeNull();
  });
  it('dates', () => {
    expect(parseDate('08.11.2026')!.iso).toBe('2026-11-08'); expect(parseDate('31-12-2024')!.iso).toBe('2024-12-31'); expect(parseDate('2024-02-29')!.iso).toBe('2024-02-29');
    expect(parseDate('29-02-2025')).toBeNull(); expect(parseDate('8. november 2026')!.iso).toBe('2026-11-08'); expect(parseDate('1. maj 2026')!.iso).toBe('2026-05-01');
    expect(parseDate('03/04/2025')).toMatchObject({ iso: '2025-04-03', ambiguous: true }); expect(parseDate('03/04/2025', 'MDY')!.iso).toBe('2025-03-04'); expect(parseDate('13/04/2025')!.ambiguous).toBe(false);
    expect(parseDate('31.12.99')!.iso).toBe('1999-12-31'); expect(parseDate('01.01.26')!.iso).toBe('2026-01-01');
    expect(detectDateStyle(['01/02/2025', '13/02/2025']).style).toBe('DMY'); expect(detectDateStyle(['01/02/2025', '02/13/2025']).style).toBe('MDY'); expect(detectDateStyle(['01/02/2025']).ambiguous).toBe(true);
    expect(parseMonthLabel('December 2024')).toBe('2024-12'); expect(parseMonthLabel('januar 2025')).toBe('2025-01'); expect(parseMonthLabel('2025-03')).toBe('2025-03'); expect(parseMonthLabel('okt 2025')).toBe('2025-10');
  });
});

describe('reading bank screenshots (OCR text → candidates)', () => {
  it('desktop layout: date | text | amount (the example from the specification)', () => {
    const c = parse('08.11.2026 | NETTO | -428,50\n07.11.2026 | SPAR | -212,95\n01.11.2026 | LØN | +32.500,00');
    expect(brief(c)).toEqual([['2026-11-08', 'NETTO', -42850], ['2026-11-07', 'SPAR', -21295], ['2026-11-01', 'LØN', 3250000]]);
    expect(c.every(x => !needsReview(x))).toBe(true);
  });
  it('desktop layout with a balance column: verified amounts, and an OCR misread is caught by the balance chain', () => {
    const good = parse('Dato Tekst Beløb Saldo\n08.11.2026 Netto Vesterbro -428,50 12.071,50\n07.11.2026 Dankort-køb SPAR 4412 -212,95 12.500,00\n06.11.2026 MobilePay Anna 150,00 12.712,95\n05.11.2026 DSB -98,00 12.562,95');
    expect(brief(good)).toEqual([['2026-11-08', 'Netto Vesterbro', -42850], ['2026-11-07', 'Dankort-køb SPAR 4412', -21295], ['2026-11-06', 'MobilePay Anna', 15000], ['2026-11-05', 'DSB', -9800]]);
    expect(good.slice(0, 3).every(x => x.confidence > 0.9 && x.issues.length === 0)).toBe(true);
    // OCR reads 428,50 as 423,50 → the running balance no longer agrees → row is blocked for review
    const bad = parse('08.11.2026 Netto -423,50 12.071,50\n07.11.2026 SPAR -212,95 12.500,00\n06.11.2026 Anna 150,00 12.712,95\n05.11.2026 DSB -98,00 12.562,95');
    expect(bad[0].issues).toContain('balance_mismatch'); expect(needsReview(bad[0])).toBe(true); expect(needsReview(bad[1])).toBe(false);
  });
  it('mobile layout: date headers, "I dag" / "I går", payee and amount on one or two lines', () => {
    const c = parse('Lønkonto\nSaldo 12.071,50 kr.\nI dag\nNETTO\n-428,50 kr.\nI går\nCircle K Amager -350,00\nDagligvarer\n8. november\nLØN +32.500,00\n31. december\nGave -100,00');
    expect(brief(c)).toEqual([['2026-11-10', 'NETTO', -42850], ['2026-11-09', 'Circle K Amager', -35000], ['2026-11-08', 'LØN', 3250000], ['2025-12-31', 'Gave', -10000]]);
    expect(c[1].description).toBe('Dagligvarer'); expect(c[2].issues).toContain('year_assumed'); // "31. december" would be in the future → previous year
  });
  it('mobile layout with the date under each row', () => {
    const c = parse('REMA 1000 -89,95\n07.11.2026\nFøtex -412,00\n06.11.2026');
    expect(brief(c)).toEqual([['2026-11-07', 'REMA 1000', -8995], ['2026-11-06', 'Føtex', -41200]]);
  });
  it('cropped rows are never completed by guessing', () => {
    const c = parse('07.11.2026 SPAR -212,95\n06.11.2026 Føtex Østerbro\n05.11.2026 Matas -1');
    expect(brief(c)).toEqual([['2026-11-07', 'SPAR', -21295], ['2026-11-06', 'Føtex Østerbro', null], ['2026-11-05', 'Matas', -100]]);
    expect(c[1].issues).toContain('missing_amount'); expect(c[2].issues).toContain('amount_no_decimals'); expect(needsReview(c[1]) && needsReview(c[2])).toBe(true);
    expect(parse('…TTO -428,50').map(x => x.issues)).toEqual([expect.arrayContaining(['missing_date'])]);
    expect(parse('12.071,50\nDisponibelt beløb')).toEqual([]); // a lone balance line is not a transaction
  });
  it('direction of money: unsigned amounts are only accepted as inflows when the screenshot marks outflows with a minus', () => {
    const mixed = parse('08.11.2026 NETTO -428,50\n01.11.2026 LØN 32.500,00');
    expect(mixed[1].amount).toBe(3250000); expect(mixed[1].issues).toContain('sign_assumed'); expect(needsReview(mixed[1])).toBe(false);
    const unsigned = parse('08.11.2026 NETTO 428,50\n07.11.2026 SPAR 212,95');
    expect(unsigned.every(x => x.issues.includes('sign_ambiguous') && needsReview(x))).toBe(true);
    expect(parse('08.11.2026 NETTO 428,50-')[0].amount).toBe(-42850); // trailing minus
  });
  it('flags low OCR confidence, future dates, huge and zero amounts', () => {
    expect(parseBankText(text('08.11.2026 NETTO -428,50', 55), { today: TODAY })[0].issues).toContain('low_ocr_confidence');
    expect(parse('20.11.2026 NETTO -428,50')[0].issues).toContain('future_date');
    expect(parse('08.11.2026 BIL -1.250.000,00')[0].issues).toContain('large_amount');
    expect(parse('08.11.2026 GEBYR -0,00')[0].issues).toContain('zero_amount');
  });
  it('other layouts: ISO dates, English amounts, currency suffix, slashes', () => {
    expect(brief(parse('2026-11-08 Amazon -1,234.56\n2026-11-07 Refund +20.00'))).toEqual([['2026-11-08', 'Amazon', -123456], ['2026-11-07', 'Refund', 2000]]);
    expect(brief(parse('08/11/2026 Elgiganten A/S -2.499,00 DKK'))).toEqual([['2026-11-08', 'Elgiganten A/S', -249900]]);
    expect(brief(parse('8. nov. 2026 Tiger -45,00'))).toEqual([['2026-11-08', 'Tiger', -4500]]);
  });
});

describe('payee normalisation and similarity', () => {
  it('strips card prefixes, store numbers and dates', () => {
    expect(normalizePayee('Dankort-køb NETTO 1234 Den 07.11')).toBe('netto'); expect(normalizePayee('REMA 1000 VESTERBRO')).toBe('rema vesterbro');
    expect(normalizePayee('MobilePay: Anna Jensen')).toBe('anna jensen'); expect(normalizePayee('Føtex Østerbro')).toBe('føtex østerbro');
    expect(payeeSimilarity(normalizePayee('NETTO VESTERBRO 2211'), normalizePayee('Netto'))).toBeGreaterThanOrEqual(0.6);
    expect(payeeSimilarity(normalizePayee('SPAR'), normalizePayee('Sparekassen'))).toBeLessThan(0.9); expect(payeeSimilarity(normalizePayee('Matas'), normalizePayee('DSB'))).toBe(0);
  });
});

describe('duplicate detection', () => {
  const ex = (id: string, date: string, amount: number, payee: string, extra: Partial<{ importId: string; isTransfer: boolean }> = {}) => ({ id, date, amount, payeeNorm: normalizePayee(payee), importId: extra.importId ?? null, isTransfer: extra.isTransfer ?? false });
  const cand = (date: string | null, amount: number | null, payee: string, sourceIndex = 0, importId?: string) => ({ date, amount, payeeNorm: normalizePayee(payee), sourceIndex, importId });
  it('classifies new / likely / possible / needs review', () => {
    const v = classifyDuplicates([cand('2026-11-08', -42850, 'NETTO 1234'), cand('2026-11-07', -21295, 'SPAR'), cand('2026-11-06', -5000, 'Kiosk'), cand('2026-11-05', -9900, 'Netflix'), cand(null, -100, 'x'), cand('2026-11-01', -700, 'Bager', 0, 'ref-9')],
      [ex('a', '2026-11-08', -42850, 'Netto'), ex('b', '2026-11-07', -21295, 'Superbrugsen'), ex('c', '2026-11-04', -9900, 'Netflix'), ex('d', '2026-10-01', -700, 'Bager', { importId: 'ref-9' })]);
    expect(v.map(x => x.status)).toEqual(['likely_duplicate', 'possible_duplicate', 'new', 'possible_duplicate', 'needs_review', 'likely_duplicate']);
    expect(v[3].reason).toMatch(/1 day/); expect(v[0].matchIds).toEqual(['a']);
  });
  it('overlapping screenshots: the shared rows count once, genuinely repeated purchases are kept', () => {
    const shot1 = [cand('2026-11-08', -3500, 'Kaffe'), cand('2026-11-08', -3500, 'Kaffe'), cand('2026-11-07', -21295, 'SPAR')];
    const shot2 = [cand('2026-11-08', -3500, 'Kaffe', 1), cand('2026-11-07', -21295, 'SPAR', 1), cand('2026-11-06', -9800, 'DSB', 1)];
    const v = classifyDuplicates([...shot1, ...shot2], []);
    expect(v.map(x => x.status)).toEqual(['new', 'new', 'new', 'likely_duplicate', 'likely_duplicate', 'new']);
    expect(v[3].reason).toMatch(/overlap/);
  });
  it('repeated transactions against existing data: two exist, three arrive → two duplicates and one for review', () => {
    const v = classifyDuplicates([cand('2026-11-08', -3500, 'Kaffe'), cand('2026-11-08', -3500, 'Kaffe'), cand('2026-11-08', -3500, 'Kaffe')], [ex('a', '2026-11-08', -3500, 'Kaffe'), ex('b', '2026-11-08', -3500, 'Kaffe')]);
    expect(v.map(x => x.status)).toEqual(['likely_duplicate', 'likely_duplicate', 'needs_review']);
  });
  it('a transfer already recorded from the other account is recognised', () => {
    const v = classifyDuplicates([cand('2026-11-03', -300000, 'Overførsel til Opsparing')], [ex('t', '2026-11-03', -300000, '', { isTransfer: true })]);
    expect(v[0].status).toBe('possible_duplicate'); expect(v[0].reason).toMatch(/transfer/);
  });
});

describe('analysis and atomic commit against a real budget', () => {
  const setup = () => {
    const b = basicBudget(); const { s, checking, groceries, fun } = b;
    for (const d of ['2026-10-01', '2026-10-08', '2026-10-15']) s.createTransaction({ accountId: checking, date: d, payeeName: 'Netto', categoryId: groceries, amount: -100_00 });
    s.createTransaction({ accountId: checking, date: '2026-10-20', payeeName: 'Netto', categoryId: fun, amount: -20_00 });
    s.createTransaction({ accountId: checking, date: '2026-11-07', payeeName: 'SPAR', categoryId: groceries, amount: -212_95 });
    return b;
  };
  it('suggests payees and categories from history with confidence, flags duplicates, and suggests transfers to own accounts', () => {
    const { s, checking, groceries, savings } = setup();
    const rows = analyze(s, checking, parse('08.11.2026 Dankort-køb NETTO 4412 -428,50\n07.11.2026 SPAR -212,95\n06.11.2026 Ukendt Butik ApS -55,00\n05.11.2026 Overførsel Savings -1.000,00'));
    expect(rows[0]).toMatchObject({ payee: 'Netto', payeeMatch: 'normalized', categoryId: groceries, categorySource: 'history' });
    expect(rows[0].categoryConfidence).toBeGreaterThan(0.5); expect(rows[0].categoryConfidence).toBeLessThan(0.9); // 3 of 4 past uses
    expect(rows[0].duplicate.status).toBe('new');
    expect(rows[1].duplicate.status).toBe('likely_duplicate');
    expect(rows[2]).toMatchObject({ payeeMatch: 'none', categoryId: null, payee: 'Ukendt Butik ApS' }); // unknown merchant: no guess
    expect(rows[3]).toMatchObject({ payeeMatch: 'transfer', transferAccountId: savings });
  });
  it('user rules win; changing a rule never rewrites existing transactions', () => {
    const { s, checking, fun, groceries } = setup();
    saveRule(s, { matchType: 'contains', pattern: 'netto', payeeName: 'Netto', categoryId: fun, transferAccountId: null });
    const before = JSON.stringify(s.listTransactions());
    const rows = analyze(s, checking, parse('08.11.2026 NETTO CITY -42,00'));
    expect(rows[0]).toMatchObject({ payeeMatch: 'rule', categoryId: fun, categorySource: 'rule' });
    expect(JSON.stringify(s.listTransactions())).toBe(before); void groceries;
  });
  it('commit is atomic, refuses unreviewed/duplicate rows, and remembers corrections', () => {
    const { s, checking, groceries, fun } = setup();
    const n0 = s.listTransactions().length;
    const good = { date: '2026-11-08', payeeName: 'Netto', amount: -428_50, categoryId: groceries, rawPayee: 'Dankort-køb NETTO 4412' };
    // one bad row poisons the whole batch: nothing is written
    expect(() => commit(s, checking, [good, { date: '2026-11-07', payeeName: 'SPAR', amount: -212_95, rawPayee: 'SPAR' }])).toThrow(/duplicates/);
    expect(() => commit(s, checking, [good, { date: '2026-11-06', payeeName: 'X', amount: -10_00, issues: ['balance_mismatch'] }])).toThrow(/cannot be imported/);
    expect(() => commit(s, checking, [good, { date: '2026-11-06', payeeName: '', amount: -10_00 }])).toThrow();
    expect(() => commit(s, checking, [good, { date: '2026-13-06', payeeName: 'X', amount: -10_00 }])).toThrow();
    expect(() => commit(s, checking, [{ ...good, date: '2027-01-01' }])).toThrow(/cannot be imported/); // future date needs review even if the client did not flag it
    expect(s.listTransactions().length).toBe(n0);
    // explicit overrides
    const r = commit(s, checking, [good, { date: '2026-11-07', payeeName: 'SPAR', amount: -212_95, rawPayee: 'SPAR', allowDuplicate: true }, { date: '2026-11-06', payeeName: 'Biografen', amount: -120_00, categoryId: fun, rawPayee: 'NORDISK FILM BIO 77', issues: ['amount_ambiguous'], reviewed: true }]);
    expect(r).toMatchObject({ imported: 3, totalOutflow: 761_45, totalInflow: 0 });
    expect(s.listTransactions().length).toBe(n0 + 3);
    // the correction "NORDISK FILM BIO 77 → Biografen / Fun" is remembered
    const again = analyze(s, checking, parse('09.11.2026 Nordisk Film Bio 77 -95,00'));
    expect(again[0]).toMatchObject({ payee: 'Biografen', payeeMatch: 'rule', categoryId: fun });
    // importing the same screenshot again: everything is now a duplicate
    expect(analyze(s, checking, parse('08.11.2026 Dankort-køb NETTO 4412 -428,50')).map(x => x.duplicate.status)).toEqual(['likely_duplicate']);
    s.undo(); expect(s.listTransactions().length).toBe(n0); // one undo step removes the whole import
  });
  it('an OCR error cannot become a transaction without the user confirming it', () => {
    const { s, checking } = setup();
    const rows = analyze(s, checking, parse('08.11.2026 Netto -423,50 12.071,50\n07.11.2026 Kiosk -12,95 12.500,00\n06.11.2026 Anna 150,00 12.512,95\n05.11.2026 Cropped\n04.11.2026 Half -7'));
    const blocked = rows.filter(r => r.needsReview);
    expect(blocked.map(r => r.payee)).toEqual(['Netto', 'Cropped', 'Half']);
    for (const r of blocked) expect(() => commit(s, checking, [{ date: r.date ?? '', payeeName: r.payee, amount: r.amount as number, issues: r.issues }])).toThrow();
  });
});

describe('CSV and JSON (ChatGPT-assisted) imports', () => {
  it('Danish bank CSV with semicolons, decimal comma and a balance column', () => {
    const r = parseBankCsv('Dato;Tekst;Beløb;Saldo\r\n08-11-2026;NETTO;-428,50;12.071,50\r\n07-11-2026;"SPAR; Nørrebro";-212,95;12.500,00\r\n01-11-2026;LØN;32.500,00;12.712,95\r\n', { today: TODAY });
    expect(brief(r.candidates)).toEqual([['2026-11-08', 'NETTO', -42850], ['2026-11-07', 'SPAR; Nørrebro', -21295], ['2026-11-01', 'LØN', 3250000]]);
    expect(r.candidates[0].balanceAfter).toBe(1207150); expect(r.candidates.every(c => !needsReview(c))).toBe(true);
  });
  it('outflow/inflow columns, ambiguous dates, unreadable values', () => {
    const r = parseBankCsv('Date,Payee,Outflow,Inflow\n03/04/2026,Shop,12.50,\n05/06/2026,Job,,100.00\n', { today: TODAY });
    expect(r.candidates.map(c => c.amount)).toEqual([-1250, 10000]); expect(r.dateAmbiguous).toBe(true); expect(r.candidates.every(c => c.issues.includes('date_ambiguous'))).toBe(true);
    const bad = parseBankCsv('date,payee,amount\nnot a date,Shop,12 dollars-ish\n', { today: TODAY });
    expect(bad.candidates[0]).toMatchObject({ date: null, amount: null }); expect(needsReview(bad.candidates[0])).toBe(true);
    expect(parseBankCsv(IMPORT_CSV_EXAMPLE, { today: TODAY }).candidates).toHaveLength(3);
  });
  it('JSON schema: the template validates; malformed documents are rejected as a whole with precise errors', () => {
    const ok = parseImportJson(JSON.stringify(IMPORT_JSON_EXAMPLE), { today: TODAY });
    expect(ok.errors).toEqual([]); expect(brief(ok.candidates)).toEqual([['2026-11-08', 'NETTO', -42850], ['2026-11-07', 'SPAR', -21295], ['2026-11-01', 'LØN', 3250000]]);
    expect(ok.candidates[2].importId).toBe('bank-ref-0001'); expect(ok.account).toBe('Lønkonto');
    const bad = parseImportJson(JSON.stringify({ schema: 'budget-reborn.transactions.v1', transactions: [{ date: '08-11-2026', payee: 'A', amount: '-1,50' }, { date: '2026-11-08', payee: '', amount: 12.345 }, { date: '2026-11-08', payee: 'B', amount: '1.00', evil: 1 }] }));
    expect(bad.candidates).toEqual([]); expect(bad.errors.join('\n')).toMatch(/transactions\[0\]\.date/); expect(bad.errors.join('\n')).toMatch(/transactions\[0\]\.amount/);
    expect(bad.errors.join('\n')).toMatch(/transactions\[1\]\.payee/); expect(bad.errors.join('\n')).toMatch(/unknown field "evil"/);
    expect(parseImportJson('{"schema":"other","transactions":[]}').errors[0]).toMatch(/schema/); expect(parseImportJson('nope').errors[0]).toMatch(/JSON/);
    expect(parseImportJson(JSON.stringify({ schema: 'budget-reborn.transactions.v1', transactions: [{ date: '2026-11-08', payee: 'A', amount: 0.1 }] })).candidates[0].amount).toBe(10);
  });
});

describe('optional vision provider', () => {
  const cfg = { ...loadConfig({ BR_DATA_DIR: '/tmp/br-vision-test' } as any), vision: { baseUrl: 'http://vision.invalid/v1', apiKey: 'server-side-secret', model: 'm' } };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  it('validates the provider answer against the schema and marks rows as AI-read; the key only travels server → provider', async () => {
    let seen: any; const fake = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(IMPORT_JSON_EXAMPLE) + '\n```' } }] })); }) as any;
    const c = await extractWithVision(cfg, png, 0, TODAY, fake);
    expect(c).toHaveLength(3); expect(c.every(x => x.issues.includes('ai_extracted') && x.confidence <= 0.7)).toBe(true);
    expect(seen.url).toBe('http://vision.invalid/v1/chat/completions'); expect(seen.init.headers.authorization).toBe('Bearer server-side-secret');
  });
  it('rejects invalid provider output and non-image uploads', async () => {
    const liar = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"schema":"budget-reborn.transactions.v1","transactions":[{"date":"yesterday","payee":"X","amount":"lots"}]}' } }] }))) as any;
    await expect(extractWithVision(cfg, png, 0, TODAY, liar)).rejects.toThrow(/failed validation/);
    await expect(extractWithVision(cfg, Buffer.from('<?php echo 1; ?>'), 0, TODAY, liar)).rejects.toThrow(/PNG, JPEG/);
    await expect(extractWithVision({ ...cfg, vision: null }, png, 0, TODAY, liar)).rejects.toThrow(/No vision provider/);
  });
});
