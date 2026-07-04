import { describe, it, expect } from 'vitest';
import { isDatedOutOfWindow } from '../../../../src/search/core/time-range.js';

// isDatedOutOfWindow is the robust per-result window predicate that replaced a
// fragile string comparison (r.published_date >= fromDate). WHY it matters: the
// string form leaked any DATED result whose published_date was not lexically
// ISO-ordered — a 5-month-old "Jan 15, 2026" / "2026/01/15" article compared
// TRUE against a "2026-06-27" week window and survived. The predicate must key
// on parsed calendar time, treat undated / unparseable as "not out of window"
// (kept, mirroring the pre-existing conservative behaviour), and honour full-day
// boundaries so a same-day full-ISO timestamp is never wrongly excluded.

const FROM = '2026-06-27';
const TO = '2026-07-01';

describe('isDatedOutOfWindow', () => {
  it('returns false with no bounds (gate does not fire)', () => {
    expect(isDatedOutOfWindow('2020-01-01T00:00:00.000Z', undefined, undefined)).toBe(false);
  });

  it('returns false for an undated result', () => {
    expect(isDatedOutOfWindow(undefined, FROM, TO)).toBe(false);
  });

  it('returns false for an unparseable date (treated as undated)', () => {
    expect(isDatedOutOfWindow('not a date', FROM, undefined)).toBe(false);
    expect(isDatedOutOfWindow('2 months ago', FROM, undefined)).toBe(false);
  });

  it('drops an ISO date before the fromDate window start', () => {
    expect(isDatedOutOfWindow('2026-01-15T00:00:00.000Z', FROM, undefined)).toBe(true);
  });

  it('drops a NON-ISO Date-parseable date before the window (the leak this fixes)', () => {
    // These all lexically compare TRUE vs "2026-06-27" (would survive the old
    // string filter) but are calendar-months older than the window start.
    expect(isDatedOutOfWindow('Jan 15, 2026', FROM, undefined)).toBe(true);
    expect(isDatedOutOfWindow('2026/01/15', FROM, undefined)).toBe(true);
    expect(isDatedOutOfWindow('2026-1-15', FROM, undefined)).toBe(true);
    expect(isDatedOutOfWindow('Wed, 15 Jan 2026 00:00:00 GMT', FROM, undefined)).toBe(true);
  });

  it('keeps an in-window ISO date', () => {
    expect(isDatedOutOfWindow('2026-06-28T10:00:00.000Z', FROM, undefined)).toBe(false);
  });

  it('keeps a full-ISO timestamp on the fromDate boundary day', () => {
    // "2026-06-27T00:34:11.000Z" is within the day that starts the window.
    expect(isDatedOutOfWindow('2026-06-27T00:34:11.000Z', FROM, undefined)).toBe(false);
  });

  it('keeps a full-ISO timestamp on the toDate boundary day (whole day is in window)', () => {
    // A same-day 15:44 timestamp on the toDate day must NOT be excluded — the
    // old string compare "...T15:44:...Z" <= "2026-07-01" was false (over-filter).
    expect(isDatedOutOfWindow('2026-07-01T15:44:13.000Z', FROM, TO)).toBe(false);
  });

  it('drops a date after the toDate window end', () => {
    expect(isDatedOutOfWindow('2026-07-05T00:00:00.000Z', FROM, TO)).toBe(true);
  });

  it('ignores an unparseable bound (no false window)', () => {
    // A malformed fromDate must not window anything out.
    expect(isDatedOutOfWindow('2020-01-01T00:00:00.000Z', 'garbage', undefined)).toBe(false);
  });
});
