/** Neutral, source-independent description of a budget to be migrated. Produced by the YNAB4 parsers. */
import type { ISODate, Month } from './dates.ts';
import type { OverspendingHandling } from './engine.ts';
import type { AccountType, Cleared, Flag, Frequency } from './types.ts';

export interface ImportWarning { level: 'info' | 'warning' | 'error'; code: string; message: string; count?: number }
export interface ImSplit { sid: string; amount: number; categorySid: string | null; memo: string; transferAccountSid: string | null; transferSid: string | null }
export interface ImTxn {
  sid: string; accountSid: string; date: ISODate; payeeName: string | null; categorySid: string | null; memo: string; amount: number;
  cleared: Cleared; flag: Flag | null; transferAccountSid: string | null; transferSid: string | null; splits: ImSplit[];
}
export interface ImportModel {
  kind: 'ynab4-native' | 'ynab4-csv';
  budgetName: string;
  currency: string | null;
  accounts: { sid: string; name: string; type: AccountType; onBudget: boolean; closed: boolean; note: string; typeKnown: boolean }[];
  groups: { sid: string; name: string; hidden: boolean; note: string }[];
  categories: { sid: string; groupSid: string; name: string; hidden: boolean; note: string }[];
  payees: { name: string; autoCategorySid: string | null }[];
  transactions: ImTxn[];
  budgets: { month: Month; categorySid: string; budgeted: number; overspending: OverspendingHandling | null; note: string }[];
  monthNotes: { month: Month; note: string }[];
  scheduled: { sid: string; accountSid: string; nextDate: ISODate; frequency: Frequency; payeeName: string | null; categorySid: string | null; memo: string; amount: number;
    flag: Flag | null; transferAccountSid: string | null; splits: { amount: number; categorySid: string | null; memo: string; transferAccountSid: string | null }[] }[];
  warnings: ImportWarning[];
  /** what the source lets us verify against */
  expected: {
    accountBalances: { accountSid: string; balance: number; basis: string }[];
    monthly: { month: Month; categorySid: string; budgeted: number; activity: number; balance: number }[];
    transactionCount: number;
    categoryBalances: { categorySid: string; balance: number }[];
  };
  /** explicit statement of what this source can and cannot provide */
  coverage: { item: string; status: 'full' | 'partial' | 'none'; note: string }[];
}
/** Special category sids understood by the importer. */
export const SID_INCOME_THIS = 'income:this';
export const SID_INCOME_NEXT = 'income:next';
