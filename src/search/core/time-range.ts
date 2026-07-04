import type { DateHint } from './intent-router.js';

export type TimeRange = 'day' | 'week' | 'month' | 'year';

const MS_PER_DAY = 86_400_000;

const RANGE_DAYS: Record<TimeRange, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function resolveTimeRange(
  range: TimeRange | undefined,
  now: Date = new Date(),
): DateHint | undefined {
  if (!range) return undefined;
  const days = RANGE_DAYS[range];
  if (!days) return undefined;
  return { fromDate: isoDate(new Date(now.getTime() - days * MS_PER_DAY)) };
}

// Parse a bound (from/to date string) to a calendar-day boundary in ms.
// `atEnd` extends a date-only bound to the last instant of that day so the
// whole day is inside the window — a full-ISO timestamp at 15:44 on the toDate
// day must not be excluded. A full ISO timestamp bound is honoured as-is.
function boundMs(bound: string | undefined, atEnd: boolean): number | undefined {
  if (!bound) return undefined;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(bound.trim());
  const t = new Date(isDateOnly && atEnd ? `${bound.trim()}T23:59:59.999Z` : bound).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Robust per-result window predicate: is a DATED result provably outside the
 * requested [fromDate, toDate] window?
 *
 * Returns true ONLY when `publishedDate` parses to a real calendar time that
 * falls before `fromDate` (day start) or after `toDate` (day end). Undated or
 * unparseable dates return false (kept — conservative, mirrors the pre-existing
 * "no parseable date -> survive" behaviour). Unparseable bounds are ignored so a
 * malformed filter never windows results out.
 *
 * Keys on parsed calendar time, NOT a string compare: the old
 * `published_date >= fromDate` form leaked any dated result whose format was not
 * lexically ISO-ordered (e.g. "Jan 15, 2026", "2026/01/15") — those compared
 * greater than "2026-06-27" and survived a week window despite being months old.
 */
export function isDatedOutOfWindow(
  publishedDate: string | undefined,
  fromDate: string | undefined,
  toDate: string | undefined,
): boolean {
  if (!publishedDate) return false;
  const t = new Date(publishedDate).getTime();
  if (Number.isNaN(t)) return false;

  const from = boundMs(fromDate, false);
  if (from !== undefined && t < from) return true;

  const to = boundMs(toDate, true);
  if (to !== undefined && t > to) return true;

  return false;
}
