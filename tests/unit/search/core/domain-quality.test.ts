import { describe, it, expect } from 'vitest';
import { domainQualityScore } from '../../../../src/search/core/domain-quality.js';

describe('domainQualityScore', () => {
  it('penalises next.co.uk on a technical Next.js query', () => {
    const score = domainQualityScore(
      'https://www.next.co.uk/women',
      'general',
      'next.js 15 app router server actions caching rules',
    );
    expect(score).toBeLessThan(0.3);
  });

  it('penalises next.us on a technical Next.js query', () => {
    const score = domainQualityScore(
      'https://www.next.us/clearance',
      'general',
      'next.js 15 server actions',
    );
    expect(score).toBeLessThan(0.3);
  });

  it('penalises next.de on a technical Next.js query', () => {
    const score = domainQualityScore(
      'https://www.next.de/de',
      'general',
      'next.js 15 server actions',
    );
    expect(score).toBeLessThan(0.3);
  });

  it('penalises bestbuy.com on a generic short query', () => {
    const score = domainQualityScore(
      'https://www.bestbuy.com/site/best-deals',
      'general',
      'best deals',
    );
    expect(score).toBeLessThan(0.5);
  });

  it('penalises a commercial-TLD host (.shop) on a technical query', () => {
    const score = domainQualityScore(
      'https://example.shop/redis',
      'general',
      'redis cluster failover',
    );
    expect(score).toBeLessThan(0.5);
  });

  it('does not penalise a canonical docs domain', () => {
    const score = domainQualityScore(
      'https://nextjs.org/docs/app/api-reference',
      'general',
      'next.js 15 server actions',
    );
    expect(score).toBe(1.0);
  });

  it('does not penalise stackoverflow.com on a code query', () => {
    const score = domainQualityScore(
      'https://stackoverflow.com/questions/12345',
      'code',
      'pgvector HNSW ef_search',
    );
    expect(score).toBe(1.0);
  });

  it('does not penalise github.com on a general query', () => {
    const score = domainQualityScore(
      'https://github.com/anthropics/claude-code',
      'general',
      'claude code agent',
    );
    expect(score).toBe(1.0);
  });

  it('heavily penalises MDN /Web/HTML/Element/* on a database code query', () => {
    const score = domainQualityScore(
      'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/search',
      'code',
      'pgvector HNSW ef_search tuning',
    );
    expect(score).toBeLessThanOrEqual(0.15);
  });

  it('does not penalise MDN /Web/HTML/Element/* on a relevant HTML query', () => {
    const score = domainQualityScore(
      'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/search',
      'code',
      'html search element semantics',
    );
    expect(score).toBe(1.0);
  });

  it('returns 1.0 on a malformed URL', () => {
    const score = domainQualityScore('not-a-url', 'general', 'anything');
    expect(score).toBe(1.0);
  });

  // Dictionary/glossary demotion is a PER-RESULT hit/miss gate: it fires only
  // when the query carries an error token (an all-caps code like ERR_*/ENOENT)
  // AND the host is a dictionary domain. On an error-code query a dictionary
  // definition of an English word in the error string is never the answer;
  // the issue tracker / docs page is. It must NOT fire on a normal query
  // (proving the gate is per-result, not query-wide).
  describe('dictionary demotion on error-token queries', () => {
    it('leaves a dictionary host at full score on a non-error query', () => {
      const score = domainQualityScore(
        'https://www.merriam-webster.com/dictionary/reciprocal',
        'general',
        'reciprocal rank fusion explained',
      );
      expect(score).toBe(1.0);
    });

    it('demotes a dictionary host on an error-token query', () => {
      const score = domainQualityScore(
        'https://www.merriam-webster.com/dictionary/permission',
        'general',
        'EACCES permission denied listen',
      );
      expect(score).toBeLessThanOrEqual(0.25);
    });

    it('demotes a wiktionary host on an error-token query', () => {
      const score = domainQualityScore(
        'https://en.wiktionary.org/wiki/violation',
        'general',
        'SQLSTATE 23505 unique violation',
      );
      expect(score).toBeLessThanOrEqual(0.25);
    });

    it('does NOT demote a non-dictionary host on an error-token query', () => {
      const score = domainQualityScore(
        'https://github.com/nodejs/node/issues/1234',
        'general',
        'EACCES permission denied listen',
      );
      expect(score).toBe(1.0);
    });

    // A plain 5+ letter acronym (NGINX, GRAPHQL, HTTPS, SQLITE) is NOT an error
    // token, so a dictionary host on such a query keeps full score — the gate
    // must not fire on ordinary acronyms.
    it('does NOT demote a dictionary host on a plain-acronym query', () => {
      const score = domainQualityScore(
        'https://www.merriam-webster.com/dictionary/proxy',
        'general',
        'NGINX reverse proxy guide',
      );
      expect(score).toBe(1.0);
    });

    it('DOES demote a dictionary host when a numeric status code makes it an error', () => {
      const score = domainQualityScore(
        'https://en.wiktionary.org/wiki/violation',
        'general',
        'SQLSTATE 23505 unique violation',
      );
      expect(score).toBeLessThanOrEqual(0.25);
    });
  });
});
