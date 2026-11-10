import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { buildApp, type App } from '../../src/server/app.ts';
import { loadConfig } from '../../src/server/config.ts';
import { openBudgetDb } from '../../src/server/db.ts';
import { BudgetService } from '../../src/server/budgetService.ts';

export const memBudget = () => new BudgetService(openBudgetDb(':memory:'), 'test');
export function basicBudget() {
  const s = memBudget();
  const checking = s.createAccount({ name: 'Checking', type: 'checking' });
  const savings = s.createAccount({ name: 'Savings', type: 'savings' });
  const card = s.createAccount({ name: 'Visa', type: 'credit_card' });
  const invest = s.createAccount({ name: 'Invest', type: 'investment' });
  const g = s.createGroup('Everyday');
  const groceries = s.createCategory(g, 'Groceries'), fun = s.createCategory(g, 'Fun'), rent = s.createCategory(g, 'Rent');
  const row = (m: string, c: string) => s.getBudget(m).rows.find(r => r.categoryId === c)!;
  return { s, checking, savings, card, invest, g, groceries, fun, rent, row };
}
export async function testApp(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'br-test-'));
  const app = await buildApp(loadConfig({ BR_DATA_DIR: dir, ...env } as any));
  return { app, dir };
}
export async function login(app: App, username = 'owner', password = 'a-long-test-password') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username, password }, remoteAddress: '127.0.0.1' });
  if (r.statusCode !== 200) throw new Error('setup failed: ' + r.body);
  const ck = r.cookies[0];
  return { cookie: `${ck.name}=${ck.value}`, 'x-csrf-token': r.json().csrf as string };
}
