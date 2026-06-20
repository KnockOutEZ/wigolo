import { describe, it, expect } from 'vitest';
import {
  recencyMultiplier,
  recencyDemotion,
  hasTemporalIntent,
} from '../../../../src/search/core/recency-boost.js';

const NOW = new Date('2026-05-21T12:00:00.000Z');

function isoDaysAgo(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

describe('recencyMultiplier', () => {
  it('returns ~2.0 for today', () => {
    const m = recencyMultiplier(isoDaysAgo(0), NOW);
    expect(m).toBeGreaterThan(1.95);
    expect(m).toBeLessThanOrEqual(2.0);
  });

  it('returns ~1.97 for yesterday', () => {
    const m = recencyMultiplier(isoDaysAgo(1), NOW);
    expect(m).toBeGreaterThan(1.9);
    expect(m).toBeLessThan(2.0);
  });

  it('returns ~1.79 at 7 days', () => {
    const m = recencyMultiplier(isoDaysAgo(7), NOW);
    expect(m).toBeGreaterThan(1.7);
    expect(m).toBeLessThan(1.85);
  });

  it('returns ~1.37 at 30 days', () => {
    const m = recencyMultiplier(isoDaysAgo(30), NOW);
    expect(m).toBeGreaterThan(1.3);
    expect(m).toBeLessThan(1.45);
  });

  it('returns close to 1.0 at 180 days', () => {
    const m = recencyMultiplier(isoDaysAgo(180), NOW);
    expect(m).toBeGreaterThanOrEqual(1.0);
    expect(m).toBeLessThan(1.01);
  });

  it('returns 1.0 for 2 years ago', () => {
    const m = recencyMultiplier(isoDaysAgo(730), NOW);
    expect(m).toBeCloseTo(1.0, 5);
  });

  it('returns 1.0 for undefined', () => {
    expect(recencyMultiplier(undefined, NOW)).toBe(1.0);
  });

  it('returns 1.0 for invalid date string', () => {
    expect(recencyMultiplier('not-a-date', NOW)).toBe(1.0);
  });

  it('returns 1.0 for empty string', () => {
    expect(recencyMultiplier('', NOW)).toBe(1.0);
  });

  it('is monotonically decreasing for older dates', () => {
    const m0 = recencyMultiplier(isoDaysAgo(0), NOW);
    const m7 = recencyMultiplier(isoDaysAgo(7), NOW);
    const m30 = recencyMultiplier(isoDaysAgo(30), NOW);
    const m180 = recencyMultiplier(isoDaysAgo(180), NOW);
    expect(m0).toBeGreaterThan(m7);
    expect(m7).toBeGreaterThan(m30);
    expect(m30).toBeGreaterThan(m180);
  });

  it('clamps future dates to 2.0', () => {
    // ageDays = max(0, ...) means future date gives ageDays=0 → multiplier=2.0
    const future = new Date(NOW.getTime() + 86_400_000 * 7).toISOString();
    const m = recencyMultiplier(future, NOW);
    expect(m).toBe(2.0);
  });

  it('clamps lower bound to 1.0 for very old dates', () => {
    const m = recencyMultiplier('1995-01-01T00:00:00.000Z', NOW);
    expect(m).toBe(1.0);
  });

  it('accepts YYYY-MM-DD date strings', () => {
    const m = recencyMultiplier('2026-05-21', NOW);
    expect(m).toBeGreaterThan(1.95);
  });
});

describe('recencyDemotion', () => {
  // Unlike recencyMultiplier (a boost in [1.0, 2.0]), recencyDemotion is a
  // penalty in (0, 1] that actively pushes STALE results DOWN. Fresh/recent
  // and undated results are unaffected (factor = 1.0); old dated results
  // drop below 1.0 so they lose top-N slots on temporal-intent queries.
  it('returns 1.0 for a fresh (today) result — no penalty', () => {
    expect(recencyDemotion(isoDaysAgo(0), NOW)).toBe(1.0);
  });

  it('returns 1.0 for an undefined date — undated results are not penalized', () => {
    expect(recencyDemotion(undefined, NOW)).toBe(1.0);
  });

  it('returns 1.0 for an invalid date string', () => {
    expect(recencyDemotion('not-a-date', NOW)).toBe(1.0);
  });

  it('returns 1.0 for a recent result inside the grace window', () => {
    expect(recencyDemotion(isoDaysAgo(7), NOW)).toBe(1.0);
  });

  it('demotes a clearly stale result below 1.0', () => {
    expect(recencyDemotion(isoDaysAgo(365), NOW)).toBeLessThan(1.0);
  });

  it('demotes a 2-year-old result harder than a 6-month-old one (monotonic)', () => {
    const m180 = recencyDemotion(isoDaysAgo(180), NOW);
    const m730 = recencyDemotion(isoDaysAgo(730), NOW);
    expect(m730).toBeLessThan(m180);
  });

  it('never returns a non-positive factor (clamped floor)', () => {
    const m = recencyDemotion(isoDaysAgo(36500), NOW); // ~100 years
    expect(m).toBeGreaterThan(0);
  });
});

describe('hasTemporalIntent', () => {
  it('matches "latest"', () => {
    expect(hasTemporalIntent('latest iphone release')).toBe(true);
  });

  it('matches "today"', () => {
    expect(hasTemporalIntent('stock market today')).toBe(true);
  });

  it('matches "yesterday"', () => {
    expect(hasTemporalIntent('what happened yesterday')).toBe(true);
  });

  it('matches "this week"', () => {
    expect(hasTemporalIntent('top stories this week')).toBe(true);
  });

  it('matches "this month"', () => {
    expect(hasTemporalIntent('best films this month')).toBe(true);
  });

  it('matches "this year"', () => {
    expect(hasTemporalIntent('biggest events this year')).toBe(true);
  });

  it('matches "breaking"', () => {
    expect(hasTemporalIntent('breaking news on layoffs')).toBe(true);
  });

  it('matches "recent"', () => {
    expect(hasTemporalIntent('recent developments in AI')).toBe(true);
  });

  it('matches "current"', () => {
    expect(hasTemporalIntent('current state of quantum')).toBe(true);
  });

  it('matches a recent year', () => {
    expect(hasTemporalIntent('results from 2024')).toBe(true);
  });

  it('matches "last 30 days"', () => {
    expect(hasTemporalIntent('articles in the last 30 days')).toBe(true);
  });

  it('matches "past 2 weeks"', () => {
    expect(hasTemporalIntent('news past 2 weeks')).toBe(true);
  });

  it('rejects "how to use python"', () => {
    expect(hasTemporalIntent('how to use python')).toBe(false);
  });

  it('rejects "learn rust"', () => {
    expect(hasTemporalIntent('learn rust')).toBe(false);
  });

  it('rejects "best pizza in new york"', () => {
    expect(hasTemporalIntent('best pizza in new york')).toBe(false);
  });

  it('rejects "past two weeks" (non-numeric)', () => {
    expect(hasTemporalIntent('past two weeks')).toBe(false);
  });

  it('rejects year outside 2020-2030 range', () => {
    expect(hasTemporalIntent('history in 1999')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasTemporalIntent('LATEST news')).toBe(true);
    expect(hasTemporalIntent('Breaking Story')).toBe(true);
  });
});
