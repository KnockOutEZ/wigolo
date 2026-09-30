import { describe, it, expect } from 'vitest';
import { detectRareTerms, rareTermFactor, isRareTermMiss } from '../../../../src/search/core/rare-terms.js';

describe('detectRareTerms', () => {
  it('detects hyphenated, digit-suffix, and snake_case compound tokens', () => {
    const r = detectRareTerms('sqlite-vec vec0 vec_distance knn query');
    expect(r.compoundTokens).toEqual(expect.arrayContaining(['sqlite-vec', 'vec0', 'vec_distance']));
    expect(r.compoundTokens).not.toContain('knn'); // plain short token
    expect(r.compoundTokens).not.toContain('query');
  });

  it('does NOT treat dates or bare version tokens as compounds', () => {
    const r = detectRareTerms('release notes 2026-06-12 v18 update');
    expect(r.compoundTokens).toHaveLength(0); // date has no alpha segment; v18 prefix <2 letters
  });

  it('emits a concept phrase for multi-word lowercase queries with no compound', () => {
    const r = detectRareTerms('reciprocal rank fusion explained');
    expect(r.compoundTokens).toHaveLength(0);
    expect(r.conceptPhrase).toEqual(['reciprocal', 'rank', 'fusion', 'explained']);
  });

  it('suppresses concept phrase when a compound token dominates', () => {
    const r = detectRareTerms('sqlite-vec virtual table');
    expect(r.compoundTokens).toContain('sqlite-vec');
    expect(r.conceptPhrase).toBeNull();
  });

  it('returns empty for an empty or non-string query', () => {
    expect(detectRareTerms('')).toEqual({ compoundTokens: [], conceptPhrase: null });
    expect(detectRareTerms('   ')).toEqual({ compoundTokens: [], conceptPhrase: null });
    // @ts-expect-error guard against non-string input from untyped callers
    expect(detectRareTerms(null)).toEqual({ compoundTokens: [], conceptPhrase: null });
  });

  it('caps compound + phrase token counts so a pathological query cannot blow up longestRun', () => {
    const manyCompounds = Array.from({ length: 100 }, (_, i) => `aa-bb${i}`).join(' ');
    expect(detectRareTerms(manyCompounds).compoundTokens.length).toBeLessThanOrEqual(16);
    // all-word tokens, no compound shape => concept phrase, clamped to <= 32
    const phrase = detectRareTerms(Array.from({ length: 100 }, (_, i) => `term${i}word`).join(' ')).conceptPhrase;
    expect(phrase).not.toBeNull();
    expect(phrase!.length).toBeLessThanOrEqual(32);
  });

  it('emits a bounded concept phrase for an unsegmented CJK query', () => {
    const phrase = detectRareTerms('北京人工智能大会最新消息').conceptPhrase;

    expect(phrase).not.toBeNull();
    expect(phrase).toContain('人工');
    expect(phrase).toContain('智能');
    expect(phrase!.length).toBeLessThanOrEqual(32);
  });
});

describe('rareTermFactor', () => {
  const rareCompound = detectRareTerms('sqlite-vec vec0 knn query syntax');

  it('boosts a doc containing the verbatim compound above one missing it', () => {
    const hit = rareTermFactor(
      { title: 'sqlite-vec: vec0 virtual tables', url: 'https://alexgarcia.xyz/sqlite-vec', snippet: 'knn query' },
      rareCompound,
    );
    const miss = rareTermFactor(
      { title: 'SQLite Home Page', url: 'https://sqlite.org', snippet: 'small fast database' },
      rareCompound,
    );
    expect(hit).toBeGreaterThan(miss);
    expect(miss).toBeLessThan(1); // missing all compounds => damped (generic-filler signal)
  });

  it('grades phrase contiguity: longer in-order run scores higher', () => {
    const rare = detectRareTerms('reciprocal rank fusion explained');
    const phrasePage = rareTermFactor(
      { title: 'Reciprocal Rank Fusion', url: 'https://example.com/rrf', snippet: 'how RRF combines rankings' },
      rare,
    );
    const dictPage = rareTermFactor(
      { title: 'Reciprocal (mathematics)', url: 'https://en.wikipedia.org/wiki/Multiplicative_inverse', snippet: 'the reciprocal of a number' },
      rare,
    );
    expect(phrasePage).toBeGreaterThan(dictPage);
  });

  it('returns 1.0 for plain queries with no rare terms', () => {
    expect(rareTermFactor({ title: 'x', url: 'https://x.com', snippet: 'y' }, detectRareTerms('best laptop'))).toBe(1);
  });

  it('boosts a contiguous CJK topic match above unrelated calendar content', () => {
    const rare = detectRareTerms('北京人工智能大会最新消息');
    const relevant = rareTermFactor(
      { title: '北京人工智能大会发布最新成果', url: 'https://example.com/ai', snippet: '产业动态' },
      rare,
    );
    const irrelevant = rareTermFactor(
      { title: '今日黄历与北京天气预报', url: 'https://example.com/calendar', snippet: '出行指数' },
      rare,
    );

    expect(relevant).toBeGreaterThan(irrelevant);
  });
});

describe('isRareTermMiss', () => {
  const compound = detectRareTerms('sqlite-vec vec0 knn');
  const phrase = detectRareTerms('reciprocal rank fusion explained');

  it('is a miss when the query has compounds but the doc contains none', () => {
    expect(isRareTermMiss({ title: 'SQLite Home', url: 'https://sqlite.org', snippet: 'database' }, compound)).toBe(true);
    expect(isRareTermMiss({ title: 'sqlite-vec docs', url: 'https://x.io/sqlite-vec', snippet: 'vec0' }, compound)).toBe(false);
  });

  it('is a miss when a concept-phrase query result has phrase run < 2', () => {
    expect(isRareTermMiss({ title: 'Reciprocal (math)', url: 'https://w.org', snippet: 'the reciprocal of x' }, phrase)).toBe(true);
    expect(isRareTermMiss({ title: 'Reciprocal Rank Fusion', url: 'https://e.com', snippet: 'how RRF works' }, phrase)).toBe(false);
  });

  it('distinguishes a CJK topic hit from unrelated calendar content', () => {
    const cjk = detectRareTerms('北京人工智能大会最新消息');

    expect(isRareTermMiss(
      { title: '北京人工智能大会发布最新成果', url: 'https://e.com/ai', snippet: '产业动态' },
      cjk,
    )).toBe(false);
    expect(isRareTermMiss(
      { title: '今日黄历与北京天气预报', url: 'https://e.com/calendar', snippet: '出行指数' },
      cjk,
    )).toBe(true);
  });

  it('is never a miss for a single-token query with no rare terms', () => {
    // one token => no compound and no concept phrase => nothing to miss
    expect(isRareTermMiss({ title: 'x', url: 'https://x.com', snippet: 'y' }, detectRareTerms('laptop'))).toBe(false);
  });
});
