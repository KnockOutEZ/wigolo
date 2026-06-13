import { describe, it, expect } from 'vitest';
import { applyAuthorityBoost } from '../../../src/search/reranker/authority-boost.js';

describe('applyAuthorityBoost capUrls', () => {
  it('caps generic-domain authority for a URL in the rare-term-miss set', () => {
    const results = [{ url: 'https://sqlite.org/', relevance_score: 0.5 }];
    const normal = applyAuthorityBoost('sqlite vec', results)[0].relevance_score;
    const capped = applyAuthorityBoost('sqlite vec', results, {
      capUrls: new Set(['https://sqlite.org/']),
    })[0].relevance_score;
    expect(capped).toBeLessThan(normal); // generic subj.org boost reduced ×0.25
  });

  it('does NOT cap a URL absent from the miss set (a rare-term hit)', () => {
    const results = [{ url: 'https://sqlite.org/', relevance_score: 0.5 }];
    const normal = applyAuthorityBoost('sqlite vec', results)[0].relevance_score;
    const uncapped = applyAuthorityBoost('sqlite vec', results, {
      capUrls: new Set(['https://other.example/']),
    })[0].relevance_score;
    expect(uncapped).toBe(normal); // hit keeps full authority
  });

  it('leaves a known-subject exact-match domain unaffected even when in the miss set', () => {
    const results = [{ url: 'https://react.dev/reference', relevance_score: 0.5 }];
    const normal = applyAuthorityBoost('react hooks', results)[0].relevance_score;
    const capped = applyAuthorityBoost('react hooks', results, {
      capUrls: new Set(['https://react.dev/reference']),
    })[0].relevance_score;
    expect(capped).toBe(normal); // known-subject mapping is preserved
  });
});
