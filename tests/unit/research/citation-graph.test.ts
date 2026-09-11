import { describe, it, expect } from 'vitest';
import { buildCitationGraph } from '../../../src/research/citation-graph.js';
import type { CitationGraphSource } from '../../../src/research/citation-graph.js';

function mkSource(overrides: Partial<CitationGraphSource> = {}): CitationGraphSource {
  return {
    url: 'https://example.com/a',
    title: 'Example',
    markdown: 'Server components render on the server and reduce bundle size for clients.',
    ...overrides,
  };
}

describe('buildCitationGraph', () => {
  it('extracts citation markers and maps to 0-based source indices', () => {
    const sources = [mkSource({ url: 'https://a.com' }), mkSource({ url: 'https://b.com' })];
    const graph = buildCitationGraph('AI is rapidly evolving these days [1][2].', sources);
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices).toEqual([0, 1]);
    expect(graph[0].confidence).toBe('high');
    expect(graph[0].claim).toContain('AI is rapidly evolving');
  });

  it('drops citation indices that are out of range', () => {
    const sources = [mkSource()];
    const graph = buildCitationGraph('Something interesting happened [99] last week.', sources);
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices).toEqual([]);
    // No markers in range and Jaccard insufficient -> low confidence
    expect(graph[0].confidence).toBe('low');
  });

  it('uses Jaccard overlap when no markers present', () => {
    const sources = [
      mkSource({
        markdown: 'server components render server side reduce bundle size client browser',
      }),
    ];
    const graph = buildCitationGraph(
      'Server components render server side and reduce bundle size client browser apps.',
      sources,
    );
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices).toEqual([0]);
    expect(graph[0].confidence).toBe('medium');
  });

  it('returns low confidence with empty indices when overlap insufficient', () => {
    const sources = [mkSource({ markdown: 'completely different topic about cooking recipes' })];
    const graph = buildCitationGraph(
      'Quantum computing uses superposition for parallel computation states.',
      sources,
    );
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices).toEqual([]);
    expect(graph[0].confidence).toBe('low');
  });

  it('returns empty array for empty synthesis text', () => {
    const sources = [mkSource()];
    const graph = buildCitationGraph('', sources);
    expect(graph).toEqual([]);
  });

  it('marks all sentences low confidence when sources are empty', () => {
    const graph = buildCitationGraph('This is sentence one. This is sentence two.', []);
    expect(graph.length).toBe(2);
    for (const entry of graph) {
      expect(entry.source_indices).toEqual([]);
      expect(entry.confidence).toBe('low');
    }
  });

  it('skips sentences shorter than 10 characters', () => {
    const graph = buildCitationGraph('Hi. This is a longer sentence about something meaningful.', []);
    expect(graph.length).toBe(1);
    expect(graph[0].claim).toContain('longer sentence');
  });

  it('ignores stopwords when computing Jaccard similarity', () => {
    // Only stopwords overlap -- should NOT yield medium confidence
    const sources = [mkSource({ markdown: 'the and or but with for from this that' })];
    const graph = buildCitationGraph(
      'The orchestration platform manages container deployments effectively.',
      sources,
    );
    expect(graph[0].confidence).toBe('low');
  });

  it('handles multiple sentences producing multiple entries', () => {
    const sources = [mkSource()];
    const graph = buildCitationGraph(
      'First sentence here [1]. Second sentence elsewhere [1].',
      sources,
    );
    expect(graph.length).toBe(2);
    expect(graph[0].source_indices).toEqual([0]);
    expect(graph[1].source_indices).toEqual([0]);
  });

  // Regression: decimal points must not truncate claim text (issue #274).
  it('preserves decimal numbers inside citation claim text', () => {
    const sources = Array.from({ length: 7 }, (_, i) =>
      mkSource({ url: `https://example.com/${i}` }),
    );
    const graph = buildCitationGraph(
      'Revenue reached $62.3 billion in Q4 FY2026, up 75 percent [7].',
      sources,
    );
    expect(graph.length).toBe(1);
    expect(graph[0].claim).toContain('$62.3 billion');
    expect(graph[0].claim).not.toMatch(/^3 billion/);
    expect(graph[0].source_indices).toEqual([6]);
    expect(graph[0].confidence).toBe('high');
  });

  it('preserves multiple decimals in one sentence and still splits multi-sentence text', () => {
    const sources = [mkSource(), mkSource()];
    const graph = buildCitationGraph(
      'Revenue hit $62.3 billion with 27.7 percent growth [1]. Margin improved to $5.8 billion [2].',
      sources,
    );
    expect(graph.length).toBe(2);
    expect(graph[0].claim).toContain('$62.3 billion');
    expect(graph[0].claim).toContain('27.7 percent');
    expect(graph[0].source_indices).toEqual([0]);
    expect(graph[1].claim).toContain('$5.8 billion');
    expect(graph[1].source_indices).toEqual([1]);
  });

  it('caps output at 50 entries', () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence ${i} contains enough words to pass the length check.`).join(' ');
    const graph = buildCitationGraph(sentences, []);
    expect(graph.length).toBeLessThanOrEqual(50);
  });

  it('falls back to whole text when no sentence delimiters found', () => {
    const sources = [mkSource()];
    const graph = buildCitationGraph('a clause without punctuation [1]', sources);
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices).toEqual([0]);
    expect(graph[0].confidence).toBe('high');
  });

  it('caps source_indices at 3 when many sources overlap', () => {
    const md = 'kubernetes container orchestration platform handles deployment scaling reliably';
    const sources: CitationGraphSource[] = [
      mkSource({ url: 'a', markdown: md }),
      mkSource({ url: 'b', markdown: md }),
      mkSource({ url: 'c', markdown: md }),
      mkSource({ url: 'd', markdown: md }),
      mkSource({ url: 'e', markdown: md }),
    ];
    const graph = buildCitationGraph(
      'Kubernetes container orchestration platform handles deployment scaling reliably here.',
      sources,
    );
    expect(graph.length).toBe(1);
    expect(graph[0].source_indices.length).toBeLessThanOrEqual(3);
    expect(graph[0].confidence).toBe('medium');
  });
});
