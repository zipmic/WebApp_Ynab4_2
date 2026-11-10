import { addDays, daysInMonth, pad2, type ISODate } from './dates.ts';
import type { Frequency } from './types.ts';

function addMonthsClamped(d: ISODate, n: number, anchorDay?: number): ISODate {
  const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, day = anchorDay ?? +d.slice(8, 10);
  const yy = y + Math.floor(m / 12), mm = (((m % 12) + 12) % 12) + 1;
  return `${yy}-${pad2(mm)}-${pad2(Math.min(day, daysInMonth(yy, mm)))}`;
}
/** Next occurrence after `d`. Returns null for one-off schedules. `anchorDay` keeps month-end schedules stable. */
export function nextOccurrence(d: ISODate, f: Frequency, anchorDay?: number): ISODate | null {
  switch (f) {
    case 'once': return null;
    case 'daily': return addDays(d, 1);
    case 'weekly': return addDays(d, 7);
    case 'every_other_week': return addDays(d, 14);
    case 'every_4_weeks': return addDays(d, 28);
    case 'twice_a_month': { // YNAB4: the start day and 15 days later, each month
      const day = +d.slice(8, 10), a = anchorDay && anchorDay <= 15 ? anchorDay : Math.min(day, 15) === day ? day : day - 15;
      const first = Math.max(1, Math.min(a, 15));
      return day < first + 15 && day >= first ? `${d.slice(0, 8)}${pad2(Math.min(first + 15, daysInMonth(+d.slice(0, 4), +d.slice(5, 7))))}`
        : addMonthsClamped(d, 1, first);
    }
    case 'monthly': return addMonthsClamped(d, 1, anchorDay);
    case 'every_other_month': return addMonthsClamped(d, 2, anchorDay);
    case 'every_3_months': return addMonthsClamped(d, 3, anchorDay);
    case 'every_4_months': return addMonthsClamped(d, 4, anchorDay);
    case 'twice_a_year': return addMonthsClamped(d, 6, anchorDay);
    case 'yearly': return addMonthsClamped(d, 12, anchorDay);
    case 'every_other_year': return addMonthsClamped(d, 24, anchorDay);
  }
}
