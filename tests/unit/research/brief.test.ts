import { describe, it, expect, vi } from 'vitest';
import type { ResearchSource } from '../../../src/types.js';

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn().mockResolvedValue(false),
  flashRankRerank: vi.fn(),
}));

const { buildResearchBrief } = await import('../../../src/research/brief.js');

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
});
