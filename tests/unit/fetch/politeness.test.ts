import { describe, it, expect } from 'vitest';
import {
  parseRetryAfter,
  clampBackoffMs,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../../../src/fetch/politeness.js';

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-21T07:00:00Z');

  it('parses a delta-seconds integer to milliseconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
  });

  it('parses "0" delta-seconds to 0ms', () => {
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('parses an HTTP-date relative to the supplied now', () => {
    // 28 minutes past the fixed now.
    const result = parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', NOW);
    expect(result).toBe(28 * 60_000);
  });

  it('floors a past HTTP-date at 0 (never negative)', () => {
    const result = parseRetryAfter('Wed, 21 Oct 2026 06:00:00 GMT', NOW);
    expect(result).toBe(0);
  });

  it('returns null for garbage', () => {
    expect(parseRetryAfter('not-a-date', NOW)).toBeNull();
  });

  it('returns null for an empty / undefined header', () => {
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
  });

  it('returns null for a negative delta-seconds (not a valid Retry-After)', () => {
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });
});

describe('clampBackoffMs', () => {
  it('caps an absurd 99999s value at MAX_BACKOFF_MS (300s)', () => {
    expect(clampBackoffMs(99_999_000)).toBe(MAX_BACKOFF_MS);
    expect(MAX_BACKOFF_MS).toBe(300_000);
  });

  it('floors a negative value at 0', () => {
    expect(clampBackoffMs(-1_000)).toBe(0);
  });

  it('passes an in-range value through unchanged', () => {
    expect(clampBackoffMs(60_000)).toBe(60_000);
  });
});

describe('DEFAULT_BACKOFF_MS', () => {
  it('is 60 seconds', () => {
    expect(DEFAULT_BACKOFF_MS).toBe(60_000);
  });
});
