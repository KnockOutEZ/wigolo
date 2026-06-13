import { describe, it, expect } from 'vitest';
import { applyAuthorityBoost } from '../../../src/search/reranker/authority-boost.js';

describe('applyAuthorityBoost capWhenRare', () => {
  it('caps generic-domain authority when capWhenRare is set', () => {
    const results = [{ url: 'https://sqlite.org/', relevance_score: 0.5 }];
    const normal = applyAuthorityBoost('sqlite vec', results)[0].relevance_score;
    const capped = applyAuthorityBoost('sqlite vec', results, { capWhenRare: true })[0].relevance_score;
    expect(capped).toBeLessThan(normal); // generic subj.org boost capped
  });

  it('leaves a known-subject exact-match domain unaffected by the cap', () => {
    const results = [{ url: 'https://react.dev/reference', relevance_score: 0.5 }];
    const normal = applyAuthorityBoost('react hooks', results)[0].relevance_score;
    const capped = applyAuthorityBoost('react hooks', results, { capWhenRare: true })[0].relevance_score;
    expect(capped).toBe(normal); // known-subject mapping is preserved
  });
});
