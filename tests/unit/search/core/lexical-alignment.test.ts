import { describe, it, expect } from 'vitest';
import { lexicalAlignment } from '../../../../src/search/core/lexical-alignment.js';

describe('lexicalAlignment', () => {
  it('returns 0 when title and snippet share no query tokens', () => {
    expect(lexicalAlignment('next.js server actions caching', "Women's Clothing", 'Shop dresses')).toBe(0);
  });
  it('returns 1 when title fully covers the query tokens', () => {
    expect(lexicalAlignment('pgvector hnsw ef_search', 'pgvector hnsw ef_search tuning guide', '')).toBe(1);
  });
  it('returns a partial fraction when only some tokens match', () => {
    const a = lexicalAlignment('next.js 15 app router server actions', 'Next.js 15 App Router release notes', '');
    expect(a).toBeGreaterThan(0.5); expect(a).toBeLessThan(1);
  });
  it('ignores stopwords in the query', () => {
    expect(lexicalAlignment('what is the best', 'doc title', 'snippet')).toBe(0);
  });
  it('handles empty title and snippet', () => { expect(lexicalAlignment('pgvector', '', '')).toBe(0); });
  it('handles empty query', () => { expect(lexicalAlignment('', 'pgvector docs', 'lorem ipsum')).toBe(0); });
  it('combines title + snippet for token coverage', () => {
    expect(lexicalAlignment('pgvector hnsw', 'database tuning', 'pgvector hnsw index configuration')).toBe(1);
  });
  it('treats tokens case-insensitively and strips punctuation', () => {
    expect(lexicalAlignment('Next.js', 'NEXT-JS Docs', '')).toBe(1);
  });
  it('supports Arabic Unicode tokens', () => {
    expect(lexicalAlignment('الذكاء الاصطناعي في مصر', 'الذكاء الاصطناعي في مصر', '')).toBe(1);
  });
  it('normalizes Arabic alef variants and ignores Arabic question words', () => {
    expect(lexicalAlignment('ما أحدث أخبار الذكاء الاصطناعي في مصر؟', 'احدث اخبار الذكاء الاصطناعي في مصر', '')).toBe(1);
  });

  it('filters normalized Arabic stopwords', () => {
    expect(lexicalAlignment('إلى مصر', 'مصر', '')).toBe(1);
  });
  it('supports mixed Arabic and English queries', () => {
    expect(lexicalAlignment('آخر أخبار OpenAI في مصر', 'OpenAI أخبار مصر', '')).toBe(1);
  });
});
