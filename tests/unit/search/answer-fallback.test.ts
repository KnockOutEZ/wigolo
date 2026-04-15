import { describe, it, expect } from 'vitest';
import type { SearchResultItem } from '../../../src/types.js';
import { buildStructuredFallback } from '../../../src/search/answer-synthesis.js';

describe('buildStructuredFallback', () => {
  it('returns an empty answer when no results have content', () => {
    const results: SearchResultItem[] = [];
    const out = buildStructuredFallback(results, 'q');
    expect(out.answer).toBe('');
    expect(out.citations).toEqual([]);
  });

  it('builds a bullet answer with numeric citations per source', () => {
    const results: SearchResultItem[] = [
      {
        title: 'Doc A', url: 'https://a.example/1', snippet: 'short A',
        relevance_score: 0.9,
        markdown_content: 'First sentence of A. Second sentence of A.',
      },
      {
        title: 'Doc B', url: 'https://b.example/2', snippet: 'short B',
        relevance_score: 0.8,
        markdown_content: 'Lead paragraph of B.\n\nMore details later.',
      },
    ];
    const out = buildStructuredFallback(results, 'what is x?');
    expect(out.answer).toContain('[1]');
    expect(out.answer).toContain('[2]');
    expect(out.answer).toContain('Doc A');
    expect(out.answer).toContain('Doc B');
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ index: 1, url: 'https://a.example/1', title: 'Doc A' });
    expect(out.citations[1]).toMatchObject({ index: 2, url: 'https://b.example/2', title: 'Doc B' });
  });

  it('falls back to snippet when markdown_content missing', () => {
    const results: SearchResultItem[] = [
      {
        title: 'S1', url: 'https://s.example/1', snippet: 'This is the snippet.',
        relevance_score: 0.7,
      },
    ];
    const out = buildStructuredFallback(results, 'q');
    expect(out.answer).toContain('This is the snippet.');
    expect(out.citations).toHaveLength(1);
  });

  it('caps the number of bullets at 5', () => {
    const results: SearchResultItem[] = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i + 1}`,
      url: `https://e.com/${i + 1}`,
      snippet: `snippet ${i + 1}`,
      relevance_score: 1 - i * 0.05,
      markdown_content: `content ${i + 1}`,
    }));
    const out = buildStructuredFallback(results, 'q');
    const bulletCount = (out.answer.match(/\n- /g) || []).length;
    expect(bulletCount).toBeLessThanOrEqual(5);
    expect(out.citations.length).toBeLessThanOrEqual(5);
  });

  it('skips sources with empty content and snippet', () => {
    const results: SearchResultItem[] = [
      { title: 'OK', url: 'https://ok.example/1', snippet: 'good', relevance_score: 0.9, markdown_content: 'ok body' },
      { title: 'Empty', url: 'https://x.example/2', snippet: '', relevance_score: 0.8, markdown_content: '' },
    ];
    const out = buildStructuredFallback(results, 'q');
    expect(out.answer).toContain('OK');
    expect(out.answer).not.toContain('Empty');
    expect(out.citations).toHaveLength(1);
  });
});
