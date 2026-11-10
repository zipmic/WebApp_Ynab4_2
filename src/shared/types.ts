import type { ISODate, Month } from './dates.ts';
import type { OverspendingHandling } from './engine.ts';
import type { MoneyFormat } from './money.ts';

export type AccountType = 'checking' | 'savings' | 'cash' | 'credit_card' | 'line_of_credit' | 'paypal' | 'merchant'
  | 'investment' | 'mortgage' | 'other_asset' | 'other_liability';
export const ACCOUNT_TYPES: { value: AccountType; label: string; defaultOnBudget: boolean; liability: boolean }[] = [
  { value: 'checking', label: 'Checking', defaultOnBudget: true, liability: false },
  { value: 'savings', label: 'Savings', defaultOnBudget: true, liability: false },
  { value: 'cash', label: 'Cash', defaultOnBudget: true, liability: false },
  { value: 'credit_card', label: 'Credit Card', defaultOnBudget: true, liability: true },
  { value: 'line_of_credit', label: 'Line of Credit', defaultOnBudget: true, liability: true },
  { value: 'paypal', label: 'PayPal', defaultOnBudget: true, liability: false },
  { value: 'merchant', label: 'Merchant Account', defaultOnBudget: true, liability: false },
  { value: 'investment', label: 'Investment Account', defaultOnBudget: false, liability: false },
  { value: 'mortgage', label: 'Mortgage', defaultOnBudget: false, liability: true },
  { value: 'other_asset', label: 'Other Asset', defaultOnBudget: false, liability: false },
  { value: 'other_liability', label: 'Other Liability', defaultOnBudget: false, liability: true },
];
export type Cleared = 'uncleared' | 'cleared' | 'reconciled';
export const FLAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type Flag = (typeof FLAGS)[number];

export interface Account {
  id: string; name: string; type: AccountType; onBudget: boolean; closed: boolean; sortOrder: number; note: string;
  balance: number; clearedBalance: number; unclearedBalance: number; lastReconciledAt: string | null; txCount: number;
}
export interface CategoryGroup { id: string; name: string; sortOrder: number; hidden: boolean; note: string }
export interface Category { id: string; groupId: string; name: string; sortOrder: number; hidden: boolean; note: string }
export interface Payee { id: string; name: string; autoCategoryId: string | null; uses: number }

export interface SubTxn {
  id: string; amount: number; categoryId: string | null; memo: string;
  transferAccountId: string | null; transferTxnId: string | null;
}
export interface Txn {
  id: string; accountId: string; date: ISODate; payeeId: string | null; payeeName: string;
  categoryId: string | null; memo: string; amount: number; cleared: Cleared; flag: Flag | null;
  transferAccountId: string | null; transferTxnId: string | null;
  /** set when this row is the far side of a transfer that belongs to a split in another account */
  splitTransferParent: boolean;
  splits: SubTxn[]; seq: number; source: string | null;
}
export interface TxnInput {
  accountId: string; date: ISODate; payeeId?: string | null; payeeName?: string | null; categoryId?: string | null;
  memo?: string; amount: number; cleared?: Cleared; flag?: Flag | null; transferAccountId?: string | null;
  splits?: { amount: number; categoryId?: string | null; memo?: string; transferAccountId?: string | null }[];
  importId?: string | null; source?: string | null;
}
export interface TxnChange { changed: Txn[]; deleted: string[] }

export interface BudgetCategoryRow {
  categoryId: string; budgeted: number; activity: number; available: number; carryIn: number;
  handling: OverspendingHandling; handlingExplicit: boolean; note: string;
}
export interface BudgetMonth {
  month: Month; carriedAtb: number; overspentPrev: number; income: number; budgeted: number; activity: number;
  availableToBudget: number; overspent: number; totalAvailable: number; note: string;
  rows: BudgetCategoryRow[]; uncategorizedCount: number;
}
export interface BudgetSettings { name: string; currency: string; format: MoneyFormat; dateFormat: 'DD-MM-YYYY' | 'DD/MM/YYYY' | 'DD.MM.YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY' }

export type Frequency = 'once' | 'daily' | 'weekly' | 'every_other_week' | 'twice_a_month' | 'every_4_weeks' | 'monthly'
  | 'every_other_month' | 'every_3_months' | 'every_4_months' | 'twice_a_year' | 'yearly' | 'every_other_year';
export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' },
  { value: 'every_other_week', label: 'Every other week' }, { value: 'twice_a_month', label: 'Twice a month' },
  { value: 'every_4_weeks', label: 'Every 4 weeks' }, { value: 'monthly', label: 'Monthly' },
  { value: 'every_other_month', label: 'Every other month' }, { value: 'every_3_months', label: 'Every 3 months' },
  { value: 'every_4_months', label: 'Every 4 months' }, { value: 'twice_a_year', label: 'Twice a year' },
  { value: 'yearly', label: 'Yearly' }, { value: 'every_other_year', label: 'Every other year' },
];
export interface Scheduled {
  id: string; accountId: string; nextDate: ISODate; frequency: Frequency; payeeId: string | null; payeeName: string;
  categoryId: string | null; memo: string; amount: number; flag: Flag | null; transferAccountId: string | null;
  splits: { amount: number; categoryId: string | null; memo: string; transferAccountId: string | null }[];
}
