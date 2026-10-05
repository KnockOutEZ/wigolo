import { describe, it, expect } from 'vitest';
import { detectRareTerms, rareTermFactor, isRareTermMiss } from '../../../../src/search/core/rare-terms.js';

describe('detectRareTerms', () => {
  it('detects Latin compound shapes', () => {
    const r = detectRareTerms('sqlite-vec vec0 vec_distance knn query');
    expect(r.compoundTokens).toEqual(expect.arrayContaining(['sqlite-vec', 'vec0', 'vec_distance']));
  });
  it('does NOT treat dates or bare version tokens as compounds', () => {
    expect(detectRareTerms('release notes 2026-06-12 v18 update').compoundTokens).toHaveLength(0);
  });
  it('emits a concept phrase for multi-word lowercase queries with no compound', () => {
    const r = detectRareTerms('reciprocal rank fusion explained');
    expect(r.conceptPhrase).toEqual(['reciprocal', 'rank', 'fusion', 'explained']);
  });
  it('suppresses concept phrase when a compound token dominates', () => {
    const r = detectRareTerms('sqlite-vec virtual table');
    expect(r.compoundTokens).toContain('sqlite-vec'); expect(r.conceptPhrase).toBeNull();
  });
  it('returns empty for an empty or non-string query', () => {
    expect(detectRareTerms('')).toEqual({ compoundTokens: [], conceptPhrase: null });
    expect(detectRareTerms('   ')).toEqual({ compoundTokens: [], conceptPhrase: null });
    // @ts-expect-error guard against non-string input from untyped callers
    expect(detectRareTerms(null)).toEqual({ compoundTokens: [], conceptPhrase: null });
  });
  it('caps pathological query sizes', () => {
    const manyCompounds = Array.from({ length: 100 }, (_, i) => `aa-bb${i}`).join(' ');
    expect(detectRareTerms(manyCompounds).compoundTokens.length).toBeLessThanOrEqual(16);
    const phrase = detectRareTerms(Array.from({ length: 100 }, (_, i) => `term${i}word`).join(' ')).conceptPhrase;
    expect(phrase).not.toBeNull(); expect(phrase!.length).toBeLessThanOrEqual(32);
  });
  it('supports Arabic concept phrases and filters Arabic function words', () => {
    const r = detectRareTerms('ما أحدث أخبار الذكاء الاصطناعي في مصر خلال عام 2026');
    expect(r.compoundTokens).toHaveLength(0);
    expect(r.conceptPhrase).toEqual(['اخبار', 'الذكاء', 'الاصطناعي', 'مصر']);
  });

  it('matches Arabic concept phrases across stopwords in the document', () => {
    const rare = detectRareTerms('أخبار مصر');
    expect(isRareTermMiss({
      title: 'أخبار في مصر',
      url: 'https://example.com',
      snippet: '',
    }, rare)).toBe(false);
  });
});

describe('rareTermFactor', () => {
  it('boosts a doc containing a Latin compound', () => {
    const rare = detectRareTerms('sqlite-vec vec0 knn query syntax');
    const hit = rareTermFactor({ title: 'sqlite-vec: vec0 virtual tables', url: 'https://alexgarcia.xyz/sqlite-vec', snippet: 'knn query' }, rare);
    const miss = rareTermFactor({ title: 'SQLite Home Page', url: 'https://sqlite.org', snippet: 'small fast database' }, rare);
    expect(hit).toBeGreaterThan(miss); expect(miss).toBeLessThan(1);
  });
  it('grades phrase contiguity', () => {
    const rare = detectRareTerms('reciprocal rank fusion explained');
    const phrasePage = rareTermFactor({ title: 'Reciprocal Rank Fusion', url: 'https://example.com/rrf', snippet: 'how RRF combines rankings' }, rare);
    const dictPage = rareTermFactor({ title: 'Reciprocal (mathematics)', url: 'https://en.wikipedia.org/wiki/Multiplicative_inverse', snippet: 'the reciprocal of a number' }, rare);
    expect(phrasePage).toBeGreaterThan(dictPage);
  });
  it('returns 1.0 for plain queries with no rare terms', () => {
    expect(rareTermFactor({ title: 'x', url: 'https://x.com', snippet: 'y' }, detectRareTerms('best laptop'))).toBe(1);
  });
  it('boosts Arabic phrase matches', () => {
    const rare = detectRareTerms('آخر أخبار الذكاء الاصطناعي في مصر');
    const hit = rareTermFactor({ title: 'آخر أخبار الذكاء الاصطناعي في مصر', url: 'https://example.com', snippet: 'تطورات الذكاء الاصطناعي' }, rare);
    const miss = rareTermFactor({ title: 'أنواع ما في اللغة العربية', url: 'https://example.com', snippet: 'شرح لغوي' }, rare);
    expect(hit).toBeGreaterThan(miss);
  });
});

describe('isRareTermMiss', () => {
  it('detects Latin compound misses', () => {
    const rare = detectRareTerms('sqlite-vec vec0 knn');
    expect(isRareTermMiss({ title: 'SQLite Home', url: 'https://sqlite.org', snippet: 'database' }, rare)).toBe(true);
    expect(isRareTermMiss({ title: 'sqlite-vec docs', url: 'https://x.io/sqlite-vec', snippet: 'vec0' }, rare)).toBe(false);
  });
  it('detects concept phrase misses', () => {
    const rare = detectRareTerms('reciprocal rank fusion explained');
    expect(isRareTermMiss({ title: 'Reciprocal (math)', url: 'https://w.org', snippet: 'the reciprocal of x' }, rare)).toBe(true);
    expect(isRareTermMiss({ title: 'Reciprocal Rank Fusion', url: 'https://e.com', snippet: 'how RRF works' }, rare)).toBe(false);
  });
  it('never misses a single-token query', () => {
    expect(isRareTermMiss({ title: 'x', url: 'https://x.com', snippet: 'y' }, detectRareTerms('laptop'))).toBe(false);
  });
});
