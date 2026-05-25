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
