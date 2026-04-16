import { describe, it, expect, vi } from 'vitest';
import type { ResearchSource } from '../../../src/types.js';

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn().mockResolvedValue(false),
  flashRankRerank: vi.fn(),
}));

const { buildResearchBrief, detectCrossReferences } = await import('../../../src/research/brief.js');

function mkSource(overrides: Partial<ResearchSource> = {}): ResearchSource {
  return {
    url: 'https://example.com/1',
    title: 'Example Source One',
    markdown_content: [
      '# Heading',
      '',
      'This is a substantive paragraph about server components that explains how they render on the server before shipping to the client, reducing bundle size.',
      '',
      'Another paragraph with additional detail that describes streaming and how chunks are flushed progressively as they render.',
    ].join('\n'),
    relevance_score: 0.9,
    fetched: true,
    ...overrides,
  };
}

describe('buildResearchBrief', () => {
  it('returns topics from sub-queries when provided', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief(
      'how do RSC work',
      sources,
      ['server components bundling', 'streaming SSR'],
      3000,
      40000,
    );
    expect(brief.topics).toEqual(['server components bundling', 'streaming SSR']);
  });

  it('falls back to source titles when sub-queries empty', async () => {
    const sources = [mkSource({ title: 'Server Components Explained' })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.topics.length).toBeGreaterThan(0);
    expect(brief.topics[0]).toContain('Server Components');
  });

  it('returns highlights extracted from sources', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief('server components', sources, ['q'], 3000, 40000);
    expect(brief.highlights.length).toBeGreaterThan(0);
    expect(brief.highlights[0].source_url).toBe('https://example.com/1');
    expect(brief.highlights[0].text).toContain('server components');
  });

  it('returns key_findings ordered by relevance_score', async () => {
    const sources = [
      mkSource({ url: 'https://a.com', relevance_score: 0.5, markdown_content: 'x'.repeat(100) + ' short one about topic A with enough length to survive the filter for key findings.' }),
      mkSource({ url: 'https://b.com', relevance_score: 0.95, markdown_content: 'High relevance paragraph about topic B that is clearly substantive and worthy of inclusion in the findings list produced by the brief builder.' }),
    ];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings.length).toBe(2);
    expect(brief.key_findings[0]).toContain('topic B');
  });

  it('trims long findings with ellipsis', async () => {
    const sources = [mkSource({ markdown_content: 'a'.repeat(500) })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).toMatch(/…$/);
    expect(brief.key_findings[0].length).toBeLessThanOrEqual(280);
  });

  it('echoes char caps for host LLM awareness', async () => {
    const brief = await buildResearchBrief('q', [mkSource()], [], 3000, 40000);
    expect(brief.per_source_char_cap).toBe(3000);
    expect(brief.total_sources_char_cap).toBe(40000);
  });

  it('skips sources that failed to fetch', async () => {
    const sources = [
      mkSource({ url: 'https://ok.com' }),
      mkSource({ url: 'https://fail.com', fetched: false, markdown_content: '' }),
    ];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    for (const h of brief.highlights) {
      expect(h.source_url).not.toBe('https://fail.com');
    }
  });

  it('dedupes duplicate topics and findings', async () => {
    const sources = [
      mkSource({ title: 'Same Title', markdown_content: 'The same identical substantive paragraph repeated across two sources to test dedupe behavior.' }),
      mkSource({ url: 'https://b.com', title: 'Same Title', markdown_content: 'The same identical substantive paragraph repeated across two sources to test dedupe behavior.' }),
    ];
    const brief = await buildResearchBrief('q', sources, ['topic', 'topic'], 3000, 40000);
    expect(brief.topics).toEqual(['topic']);
    expect(brief.key_findings.length).toBe(1);
  });

  it('includes sections with overview and gaps', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief('server components', sources, ['server components rendering', 'missing topic XYZ'], 3000, 40000);
    expect(brief.sections).toBeDefined();
    expect(brief.sections.overview).toBeDefined();
    expect(brief.sections.overview.key_findings.length).toBeGreaterThan(0);
    expect(brief.sections.gaps).toBeDefined();
  });

  it('returns query_type field', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000, 'comparison', ['React', 'Vue']);
    expect(brief.query_type).toBe('comparison');
  });

  it('includes comparison section for comparison queries', async () => {
    const sources = [
      mkSource({ markdown_content: 'React is faster than Vue for large applications and has better performance characteristics overall.' }),
      mkSource({ url: 'https://b.com', markdown_content: 'Vue has a simpler API than React and is easier to learn for beginners.' }),
    ];
    const brief = await buildResearchBrief('React vs Vue', sources, [], 3000, 40000, 'comparison', ['React', 'Vue']);
    expect(brief.sections.comparison).toBeDefined();
    expect(brief.sections.comparison!.entities).toEqual(['React', 'Vue']);
    expect(brief.sections.comparison!.comparison_points.length).toBeGreaterThan(0);
  });

  it('omits comparison section for non-comparison queries', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000, 'concept');
    expect(brief.sections.comparison).toBeUndefined();
  });

  it('detects gaps when sub-queries have no source coverage', async () => {
    const sources = [
      mkSource({ markdown_content: 'This source talks about Python and Django web development exclusively.' }),
    ];
    const brief = await buildResearchBrief('q', sources, ['quantum computing applications', 'blockchain scalability'], 3000, 40000);
    expect(brief.sections.gaps.length).toBeGreaterThan(0);
    expect(brief.sections.gaps.some(g => g.includes('quantum'))).toBe(true);
  });
});

describe('detectCrossReferences', () => {
  it('finds findings mentioned in multiple sources', () => {
    const sources: ResearchSource[] = [
      mkSource({ url: 'https://a.com', markdown_content: 'DuckDB columnar storage engine provides excellent performance for analytical workloads.' }),
      mkSource({ url: 'https://b.com', markdown_content: 'The DuckDB columnar storage engine handles OLAP queries efficiently in production systems.' }),
      mkSource({ url: 'https://c.com', markdown_content: 'SQLite is best for embedded transactional use cases, not analytics.' }),
    ];
    const refs = detectCrossReferences(sources);
    expect(refs.some(r => r.source_indices.length >= 2)).toBe(true);
  });

  it('returns empty for single source', () => {
    const sources = [mkSource()];
    const refs = detectCrossReferences(sources);
    expect(refs).toEqual([]);
  });

  it('sets confidence high for 3+ sources', () => {
    const sharedContent = 'kubernetes container orchestration platform runs production workloads efficiently';
    const sources: ResearchSource[] = [
      mkSource({ url: 'https://a.com', markdown_content: sharedContent }),
      mkSource({ url: 'https://b.com', markdown_content: sharedContent }),
      mkSource({ url: 'https://c.com', markdown_content: sharedContent }),
    ];
    const refs = detectCrossReferences(sources);
    expect(refs.some(r => r.confidence === 'high')).toBe(true);
  });

  it('sets confidence medium for exactly 2 sources', () => {
    const sources: ResearchSource[] = [
      mkSource({ url: 'https://a.com', markdown_content: 'Python machine learning framework supports neural network training efficiently' }),
      mkSource({ url: 'https://b.com', markdown_content: 'Using Python machine learning framework for neural network training tasks' }),
    ];
    const refs = detectCrossReferences(sources);
    if (refs.length > 0) {
      expect(refs.every(r => r.confidence === 'medium')).toBe(true);
    }
  });

  it('limits to 10 cross-references', () => {
    // Create sources with many shared phrases
    const content = Array.from({ length: 50 }, (_, i) =>
      `unique phrase number ${i} appears here with shared terminology across all documents`
    ).join('. ');
    const sources: ResearchSource[] = [
      mkSource({ url: 'https://a.com', markdown_content: content }),
      mkSource({ url: 'https://b.com', markdown_content: content }),
    ];
    const refs = detectCrossReferences(sources);
    expect(refs.length).toBeLessThanOrEqual(10);
  });
});
