import { describe, it, expect } from 'vitest';
import { applyAuthorityBoost } from '../../../src/search/reranker/authority-boost.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';

function r(url: string, score = 0.5): MergedSearchResult {
  return {
    url,
    title: 't',
    snippet: 's',
    relevance_score: score,
    engine: 'mock',
    citation_id: 'c1',
  } as MergedSearchResult;
}

describe('authority-boost aliases', () => {
  it('boosts postgresql.org and neon.tech when query uses "PG" abbreviation', () => {
    const results = [
      r('https://www.w3schools.com/sql/sql_uuid.asp'),
      r('https://www.postgresql.org/docs/18/release-18.html'),
      r('https://neon.tech/blog/pg18-async-io'),
    ];
    const out = applyAuthorityBoost('PG 18 features async I/O UUIDv7', results);
    const pgOrg = out.find(x => x.url.includes('postgresql.org'))!;
    const w3 = out.find(x => x.url.includes('w3schools'))!;
    const neon = out.find(x => x.url.includes('neon.tech'))!;
    expect(pgOrg.relevance_score).toBeGreaterThan(w3.relevance_score);
    expect(neon.relevance_score).toBeGreaterThan(w3.relevance_score);
  });

  it('matches numeric-suffix subject tokens to base alias (pg18 → pg)', () => {
    const results = [
      r('https://neon.tech/postgres-18-features'),
      r('https://random-blog.example.com/postgres-18'),
    ];
    const out = applyAuthorityBoost('what is new in pg18', results);
    const neon = out.find(x => x.url.includes('neon.tech'))!;
    const other = out.find(x => x.url.includes('random-blog'))!;
    expect(neon.relevance_score).toBeGreaterThan(other.relevance_score);
  });

  it('only applies generic TLD nudge on unrelated queries (no subject boost)', () => {
    const results = [r('https://www.postgresql.org/')];
    const baseline = applyAuthorityBoost('how to bake bread', results);
    const matched = applyAuthorityBoost('postgres replication', results);
    // unrelated query gets only the .org TLD nudge (~0.04)
    expect(baseline[0].relevance_score - 0.5).toBeLessThan(0.1);
    // subject-matched query gets a substantially larger boost
    expect(matched[0].relevance_score - baseline[0].relevance_score).toBeGreaterThan(0.1);
  });
});

describe('authority-boost: query words that name Object.prototype members', () => {
  // A plain-object lookup keyed by a query word returns inherited members for
  // "constructor", "toString", etc. — #683 crashed every search containing
  // "constructor" with "mapped is not iterable".
  it.each(['constructor', 'Java record constructor', 'toString', '__proto__ hasOwnProperty valueOf'])(
    'does not throw and leaves scores alone for %j',
    (query) => {
      const results = [r('https://example.com/a', 0.5), r('https://example.org/b', 0.4)];
      const out = applyAuthorityBoost(query, results);
      expect(out).toHaveLength(2);
      expect(out.every((x) => Number.isFinite(x.relevance_score))).toBe(true);
    },
  );

  it('still boosts a known subject when the query also says "constructor"', () => {
    const results = [r('https://www.w3schools.com/x'), r('https://redis.io/docs/x')];
    const out = applyAuthorityBoost('redis constructor', results);
    const redis = out.find((x) => x.url.includes('redis.io'))!;
    const w3 = out.find((x) => x.url.includes('w3schools'))!;
    expect(redis.relevance_score).toBeGreaterThan(w3.relevance_score);
  });
});
