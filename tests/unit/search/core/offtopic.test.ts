import { describe, it, expect } from 'vitest';
import {
  isForeignScriptBatch,
  demoteUnalignedResults,
} from '../../../../src/search/core/offtopic.js';
import { lexicalAlignment, hasContentTokens } from '../../../../src/search/core/lexical-alignment.js';
import { tokenizeRankingText } from '../../../../src/search/core/text-tokenizer.js';

// WHY these tests exist
// The ranking gates are lexical, and the shared ranking tokenizer used to
// cover only Latin + CJK. An Arabic query therefore produced NO tokens, so
// every alignment-based gate was inert for Arabic: a single misbehaving
// engine could answer an Arabic query with an unrelated English payload,
// and that payload was then cached and replayed for the whole TTL.
//
// The fix is script-agnostic, and the gate is script-aware: a payload
// answered entirely outside the query's script is noise. Latin-script
// queries are deliberately untouched.

const chromePage = {
  title: 'Google Chrome - The Fast & Secure Web Browser Built to be Yours',
  snippet: 'Chrome is the official web browser from Google. Download now.',
  url: 'https://www.google.com/chrome/',
};

const hamamaPage = {
  title: 'فاتن حمامة - ويكيبيديا',
  snippet: 'سيدة الشاشة العربية سعاد حسني',
  url: 'https://ar.wikipedia.org/wiki/فاتن_حمامة',
};

describe('tokenizeRankingText', () => {
  it('keeps Latin and CJK behaviour intact', () => {
    expect(tokenizeRankingText('pgvector hnsw tuning')).toContain('pgvector');
    expect(tokenizeRankingText('日本語テキスト').length).toBeGreaterThan(0);
  });

  it('emits whole Arabic words (folded, diacritics stripped)', () => {
    const tokens = tokenizeRankingText('مُحَمَّد علي باشا');
    expect(tokens).toContain('محمد');
    expect(tokens).toContain('علي');
    expect(tokens).toContain('باشا');
  });

  it('folds the Arabic orthographic variants onto one token', () => {
    const folded = tokenizeRankingText('أحمد');
    expect(folded).toEqual(tokenizeRankingText('احمد'));
    expect(folded).toEqual(tokenizeRankingText('ٱحمد'));
  });
});

describe('lexicalAlignment', () => {
  it('aligns Arabic queries against Arabic results', () => {
    const a = lexicalAlignment(
      'سيدة الشاشة العربية',
      'فاتن حمامة - ويكيبيديا',
      'سيدة الشاشة العربية سعاد حسني',
    );
    expect(a).toBeGreaterThan(0);
  });

  it('scores an off-language page as 0 for an Arabic query', () => {
    const a = lexicalAlignment(
      'سيدة الشاشة العربية',
      'Google Chrome - The Fast & Secure Web Browser',
      'Download now and make it yours.',
    );
    expect(a).toBe(0);
  });

  it('still scores English queries as before', () => {
    expect(lexicalAlignment('pgvector hnsw ef_search', 'pgvector hnsw ef_search tuning guide', '')).toBe(1);
    expect(lexicalAlignment('next.js server actions caching', "Women's Clothing", 'Shop dresses')).toBe(0);
  });
});

describe('hasContentTokens', () => {
  it('is true for a query with real content words', () => {
    expect(hasContentTokens('سيدة الشاشة العربية')).toBe(true);
    expect(hasContentTokens('pgvector hnsw')).toBe(true);
  });

  it('is false for a stopword-only query', () => {
    expect(hasContentTokens('what is the')).toBe(false);
  });
});

describe('isForeignScriptBatch', () => {
  it('flags a payload answered entirely in another script', () => {
    expect(isForeignScriptBatch('سيدة الشاشة العربية', [chromePage])).toBe(true);
  });

  it('keeps a payload that contains the query script', () => {
    expect(isForeignScriptBatch('سيدة الشاشة العربية', [hamamaPage])).toBe(false);
  });

  it('keeps a MIXED payload (one in-script row is enough)', () => {
    expect(isForeignScriptBatch('سيدة الشاشة العربية', [chromePage, hamamaPage])).toBe(false);
  });

  it('never fires for a Latin-script query (existing gates own that)', () => {
    expect(isForeignScriptBatch('pgvector hnsw tuning', [chromePage])).toBe(false);
  });

  it('never fires for a stopword-only query or an empty payload', () => {
    expect(isForeignScriptBatch('من في على', [chromePage])).toBe(false);
    expect(isForeignScriptBatch('سيدة الشاشة العربية', [])).toBe(false);
  });

  it('never fires for a MIXED-script query (Arabic + a Latin term)', () => {
    // "تثبيت docker" is a technical query whose answers are legitimately in
    // English — the query's language does not pin the answer's language.
    expect(isForeignScriptBatch('تثبيت docker', [chromePage])).toBe(false);
  });
});

describe('demoteUnalignedResults', () => {
  it('sinks rows that share no token with a non-Latin query', () => {
    const rows = [
      { title: 'فاتن حمامة - ويكيبيديا', snippet: 'سيدة الشاشة العربية', url: 'u1', relevance_score: 1 },
      { title: 'Mayo Clinic', snippet: 'Diseases and Conditions', url: 'u2', relevance_score: 0.6 },
    ];
    const out = demoteUnalignedResults('سيدة الشاشة العربية', rows);
    expect(out[0].relevance_score).toBe(1);
    expect(out[1].relevance_score).toBeLessThan(0.6);
  });

  it('never touches a Latin-script query (existing gates own that)', () => {
    const rows = [
      { title: "Women's Clothing", snippet: 'Shop dresses', url: 'u1', relevance_score: 0.6 },
    ];
    expect(demoteUnalignedResults('pgvector hnsw tuning', rows)[0].relevance_score).toBe(0.6);
  });

  it('never touches a mixed-script query (Arabic + a Latin term)', () => {
    const rows = [
      { title: 'Docker', snippet: 'Install Docker', url: 'u1', relevance_score: 0.6 },
    ];
    expect(demoteUnalignedResults('تثبيت docker', rows)[0].relevance_score).toBe(0.6);
  });

  it('never touches a CJK query (the tokenizer already covers it)', () => {
    const rows = [
      { title: '日本語', snippet: 'テスト', url: 'u1', relevance_score: 0.6 },
    ];
    expect(demoteUnalignedResults('日本語 テスト', rows)[0].relevance_score).toBe(0.6);
  });
});
