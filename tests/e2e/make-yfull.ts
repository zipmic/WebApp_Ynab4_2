/** Writes a synthetic native YNAB4 Budget.yfull (invented data) for the browser test: npx tsx tests/e2e/make-yfull.ts <out-file> */
import { writeFileSync } from 'node:fs';
import { BudgetService } from '../../src/server/budgetService.ts';
import { openBudgetDb } from '../../src/server/db.ts';
import { generateBudget, toYfull } from '../fixtures/generate.ts';

const s = new BudgetService(openBudgetDb(':memory:'), 'e2e');
const g = generateBudget(s, { startMonth: '2025-01', months: 8, txPerMonth: 20, seed: 12 });
s.updateCategory(g.categories.Hobby, { hidden: true });
writeFileSync(process.argv[2], JSON.stringify(toYfull(s)));
