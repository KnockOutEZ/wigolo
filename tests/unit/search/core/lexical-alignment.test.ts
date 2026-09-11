import { describe, it, expect } from 'vitest';
import { lexicalAlignment } from '../../../../src/search/core/lexical-alignment.js';

describe('lexicalAlignment', () => {
  it('returns 0 when title and snippet share no query tokens', () => {
    const a = lexicalAlignment('next.js server actions caching', "Women's Clothing", 'Shop dresses');
    expect(a).toBe(0);
  });

  it('returns 1 when title fully covers the query tokens', () => {
    const a = lexicalAlignment(
      'pgvector hnsw ef_search',
      'pgvector hnsw ef_search tuning guide',
      '',
    );
    expect(a).toBe(1);
  });

  it('returns a partial fraction when only some tokens match', () => {
    const a = lexicalAlignment(
      'next.js 15 app router server actions',
      'Next.js 15 App Router release notes',
      '',
    );
    expect(a).toBeGreaterThan(0.5);
    expect(a).toBeLessThan(1);
  });

  it('ignores stopwords in the query', () => {
    // Query stopwords-only after filtering => alignment 0 (empty query set).
    const a = lexicalAlignment('what is the best', 'doc title', 'snippet');
    expect(a).toBe(0);
  });

  it('handles empty title and snippet', () => {
    const a = lexicalAlignment('pgvector', '', '');
    expect(a).toBe(0);
  });

  it('handles empty query', () => {
    const a = lexicalAlignment('', 'pgvector docs', 'lorem ipsum');
    expect(a).toBe(0);
  });

  it('combines title + snippet for token coverage', () => {
    const a = lexicalAlignment(
      'pgvector hnsw',
      'database tuning',
      'pgvector hnsw index configuration',
    );
    expect(a).toBe(1);
  });

  it('treats tokens case-insensitively and strips punctuation', () => {
    const a = lexicalAlignment('Next.js', 'NEXT-JS Docs', '');
    expect(a).toBe(1);
  });

  it('scores a topically aligned CJK result above unrelated fresh content', () => {
    const query = '北京人工智能大会最新消息';
    const relevant = lexicalAlignment(query, '北京人工智能大会发布最新成果', '大模型产业动态');
    const irrelevant = lexicalAlignment(query, '今日黄历与北京天气预报', '出行和生活指数');

    expect(relevant).toBeGreaterThan(0);
    expect(relevant).toBeGreaterThan(irrelevant);
  });
});
