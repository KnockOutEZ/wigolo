import { describe, it, expect, vi } from 'vitest';
import type { ResearchSource } from '../../../src/types.js';

vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'mock',
    rerank: vi.fn().mockRejectedValue(new Error('reranker disabled in test')),
  })),
}));
vi.mock('../../../src/config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/config.js')>();
  return { ...actual, getConfig: () => ({ reranker: 'none', rerankerModel: 'bge-reranker-v2-m3' }) };
});

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

  it('flattens inline markdown links so truncation cannot chop mid-link', async () => {
    const md = [
      'Body text describing how the linked author [Pavlo Stetsiuk](https://medium.com/?source=post_page-----abc123--------------------------------) wrote about Postgres 18 release notes covering wal segment rotation and pg_dump improvements that arrived in May 2026 with the latest cumulative update.',
    ].join('\n');
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).not.toContain('](');
    expect(brief.key_findings[0]).not.toContain('?source=post_page');
    expect(brief.key_findings[0]).toContain('Pavlo Stetsiuk');
  });

  it('drops bare angle-bracket urls from key_findings', async () => {
    const md = 'Long paragraph that includes a reference <https://example.com/long-tracking-url-that-otherwise-leaks-into-output-and-pollutes-key-findings-with-noise-bytes> mid-text and then continues with more substantive prose to push past the eighty-character minimum threshold for a finding.';
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).not.toContain('https://');
  });

  // `](http://...)` artifacts can leak into
  // key_findings text even after the existing inline-link strip. Reference-
  // style links (`[label][1]`), bare URLs, and HTML anchors are additional
  // hyperlink shapes that must be flattened to plain text before the finding
  // is sliced. WHY: a finding is meant to be prose evidence, not a link
  // pointer.
  it('flattens reference-style markdown links so [label][1] becomes label', async () => {
    const md = 'A substantial paragraph that talks about how the documentation [Postgres replication guide][1] describes streaming and logical replication choices, with notes on backpressure and lag handling in production deployments today.\n\n[1]: https://example.com/repl';
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).not.toMatch(/\]\[\d+\]/);
    expect(brief.key_findings[0]).toContain('Postgres replication guide');
  });

  it('drops bare http/https URLs from key_findings text', async () => {
    const md = 'A long paragraph documenting how the SDK https://example.com/sdk/install?utm_source=blog&utm_medium=referral&utm_campaign=launch handles retries with exponential backoff plus jitter and reports outcomes to a metrics endpoint that scrapes counters once per minute.';
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).not.toContain('https://');
    expect(brief.key_findings[0]).not.toContain('utm_');
  });

  it('strips HTML anchor tags from key_findings', async () => {
    const md = 'Some prose describing how the runtime handles errors and surfaces them through the <a href="https://example.com/errors">error reporting dashboard</a> with stable identifiers and source-map resolution that points back to the original line numbers.';
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).not.toContain('<a ');
    expect(brief.key_findings[0]).not.toContain('</a>');
    expect(brief.key_findings[0]).toContain('error reporting dashboard');
  });

  it('skips image-only leading paragraphs and surfaces real prose', async () => {
    const md = [
      '![hero image with very long alt text describing the visual content of this page topic comparison chart deluxe edition](https://cdn.example.com/hero.webp)',
      '',
      'Real substantive prose about JavaScript runtimes that should appear in key_findings because it has actual content meaningful to the reader and not just marketing imagery.',
    ].join('\n');
    const sources = [mkSource({ markdown_content: md })];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings.length).toBe(1);
    expect(brief.key_findings[0]).not.toContain('![');
    expect(brief.key_findings[0]).toContain('Real substantive prose');
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

  // The comparison section must capture the actual
  // source SENTENCE that pairs an entity with a comparison term, plus the
  // index of the source it came from — not just a bare keyword. WHY: the
  // template renderer quotes these as cited tradeoffs ("[1] React is faster
  // than Vue …"). A bare keyword like "faster" has no directionality, so a
  // verdict built from it would be a fabricated claim, not evidence.
  it('captures source-sentence + source-index tradeoffs for the verdict', async () => {
    const sources = [
      mkSource({ url: 'https://a.com', markdown_content: 'React is faster than Vue for large applications because its reconciler batches updates.' }),
      mkSource({ url: 'https://b.com', markdown_content: 'Vue has a simpler API than React and is easier to learn for beginners.' }),
    ];
    const brief = await buildResearchBrief('React vs Vue', sources, [], 3000, 40000, 'comparison', ['React', 'Vue']);
    const tradeoffs = brief.sections.comparison!.tradeoffs;
    expect(tradeoffs.length).toBeGreaterThan(0);
    // Each tradeoff quotes a real sentence containing an entity, with a source index.
    const fasterTradeoff = tradeoffs.find((t) => t.term === 'faster');
    expect(fasterTradeoff).toBeDefined();
    expect(fasterTradeoff!.text).toContain('React is faster than Vue');
    expect(fasterTradeoff!.source_index).toBe(0);
    // A tradeoff from the second source must carry its own index, not source 0's.
    const vueTradeoff = tradeoffs.find((t) => t.text.includes('simpler API'));
    expect(vueTradeoff).toBeDefined();
    expect(vueTradeoff!.source_index).toBe(1);
  });

  // WHY: comparison tradeoffs are built against the fetched-only view but the
  // renderer cites `[source_index + 1]` against the FULL ### Sources list. With
  // a leading UNfetched source the fetched-view index was one low, so the
  // verdict cited the wrong source. source_index must be remapped to the full
  // array so `sources[tradeoff.source_index]` is the doc the sentence came from.
  it('remaps tradeoff source_index to the full sources array when a leading source is unfetched (M5)', async () => {
    const sources = [
      // index 0 — UNfetched. Pre-fix the fetched-view index for the real source
      // was 0, so the verdict cited [1] (this failed row) instead of the doc.
      mkSource({ url: 'https://failed.com', markdown_content: '', fetched: false }),
      mkSource({ url: 'https://react.com', markdown_content: 'React is faster than Vue for large applications because its reconciler batches updates efficiently.' }),
      mkSource({ url: 'https://vue.com', markdown_content: 'Vue has a simpler API than React and is easier to learn for beginners just starting out.' }),
    ];
    const brief = await buildResearchBrief('React vs Vue', sources, [], 3000, 40000, 'comparison', ['React', 'Vue']);
    const tradeoffs = brief.sections.comparison!.tradeoffs;
    expect(tradeoffs.length).toBeGreaterThan(0);
    const fasterTradeoff = tradeoffs.find((t) => t.term === 'faster')!;
    expect(fasterTradeoff).toBeDefined();
    // The React sentence lives at full index 1 (fetched-view index 0 pre-remap).
    expect(fasterTradeoff.source_index).toBe(1);
    expect(sources[fasterTradeoff.source_index].url).toBe('https://react.com');
    // The Vue sentence at full index 2 (fetched-view index 1 pre-remap).
    const vueTradeoff = tradeoffs.find((t) => t.text.includes('simpler API'))!;
    expect(vueTradeoff.source_index).toBe(2);
    expect(sources[vueTradeoff.source_index].url).toBe('https://vue.com');
  });

  it('keeps comparison_points keywords alongside the enriched tradeoffs', async () => {
    const sources = [
      mkSource({ url: 'https://a.com', markdown_content: 'React is faster than Vue for large applications and has better performance characteristics overall.' }),
      mkSource({ url: 'https://b.com', markdown_content: 'Vue has a simpler API than React and is easier to learn for beginners.' }),
    ];
    const brief = await buildResearchBrief('React vs Vue', sources, [], 3000, 40000, 'comparison', ['React', 'Vue']);
    expect(brief.sections.comparison!.comparison_points.length).toBeGreaterThan(0);
    expect(brief.sections.comparison!.comparison_points).toContain('faster');
  });

  it('populates citation_graph when synthesisText is provided', async () => {
    const sources = [
      mkSource({ url: 'https://a.com', markdown_content: 'server components render efficiently on server' }),
      mkSource({ url: 'https://b.com', markdown_content: 'streaming SSR flushes chunks progressively' }),
    ];
    const brief = await buildResearchBrief(
      'q',
      sources,
      [],
      3000,
      40000,
      'general',
      [],
      'Server components are fast [1]. Streaming is great [2].',
    );
    expect(brief.citation_graph).toBeDefined();
    expect(brief.citation_graph!.length).toBeGreaterThan(0);
    expect(brief.citation_graph![0].source_indices).toEqual([0]);
    expect(brief.citation_graph![0].confidence).toBe('high');
  });

  it('omits citation_graph when synthesisText is empty', async () => {
    const brief = await buildResearchBrief('q', [mkSource()], [], 3000, 40000, 'general', [], '');
    expect(brief.citation_graph).toBeUndefined();
  });

  // citation_graph source_indices must align with the output
  // `sources` array (0-based, full list — including unfetched). The
  // graph was indexed against the `fetched` subset, so when the first source
  // failed to fetch, source_indices=[0] silently pointed to the wrong row.
  // WHY: a caller who reads `sources[graph[0].source_indices[0]]` should get
  // the document that the claim actually came from.
  it('citation_graph source_indices align with the full sources array (M5)', async () => {
    const sources = [
      // index 0 — UNfetched. Pre-fix the graph treated index 0 as the next
      // fetched source, hiding the misalignment.
      mkSource({ url: 'https://failed.com', markdown_content: '', fetched: false }),
      // index 1 — fetched, this is what synthesis citation [1] refers to.
      mkSource({ url: 'https://a.com', markdown_content: 'server components render efficiently on server' }),
      mkSource({ url: 'https://b.com', markdown_content: 'streaming SSR flushes chunks progressively' }),
    ];
    const brief = await buildResearchBrief(
      'q',
      sources,
      [],
      3000,
      40000,
      'general',
      [],
      'Server components are fast [1]. Streaming is great [2].',
    );
    expect(brief.citation_graph).toBeDefined();
    expect(brief.citation_graph!.length).toBeGreaterThan(0);
    // Synthesis marker [1] maps to citation index 0 within the synthesizer's
    // fetched-only view (synthesize.ts emits 1-based markers over fetched
    // sources). When remapped to the output `sources` array, that's index 1
    // (since sources[0] failed). The graph must report 1, not 0.
    expect(brief.citation_graph![0].source_indices).toEqual([1]);
  });

  // WHY: a caller indexing sources[key_finding_sources[i]] must land on the
  // document the finding was extracted from — the same invariant citation_graph
  // enforces (M5). The parallel array is index-aligned to key_findings and
  // remapped from the fetched-only view to the FULL sources array, so a leading
  // UNfetched source can't produce an off-by-one citation.
  it('populates key_finding_sources index-aligned to key_findings, remapped to the full sources array (M5)', async () => {
    const sources = [
      // index 0 — UNfetched. buildKeyFindings iterates the fetched subset, so
      // a naive fetched-index would collide with this row.
      mkSource({ url: 'https://failed.com', markdown_content: '', fetched: false }),
      mkSource({ url: 'https://a.com', markdown_content: 'Server components render efficiently on the server before shipping to the client, which reduces the JavaScript bundle a browser must download and parse.' }),
      mkSource({ url: 'https://b.com', markdown_content: 'Streaming server-side rendering flushes HTML chunks progressively as each part of the tree finishes rendering, improving time-to-first-byte for large pages.' }),
    ];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_finding_sources).toBeDefined();
    expect(brief.key_finding_sources!.length).toBe(brief.key_findings.length);
    // Every entry indexes into the FULL sources array and never points at the
    // unfetched leading row (index 0).
    for (const idx of brief.key_finding_sources!) {
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThan(sources.length);
      expect(sources[idx].fetched).toBe(true);
    }
  });

  // WHY: key_finding_sources must stay index-aligned to key_findings, which are
  // ordered by relevance. The first finding's source must be the highest-
  // relevance fetched source so sources[key_finding_sources[0]] is correct.
  it('orders key_finding_sources by relevance to match key_findings ordering', async () => {
    const sources = [
      mkSource({ url: 'https://low.com', relevance_score: 0.4, markdown_content: 'A lower relevance paragraph about topic ALPHA that is substantive enough to survive the eighty character minimum length filter for a key finding entry.' }),
      mkSource({ url: 'https://high.com', relevance_score: 0.95, markdown_content: 'A higher relevance paragraph about topic BETA that is clearly substantive and long enough to be included as the first finding in the ordered list.' }),
    ];
    const brief = await buildResearchBrief('q', sources, [], 3000, 40000);
    expect(brief.key_findings[0]).toContain('topic BETA');
    // The first finding came from the high-relevance source (index 1).
    expect(brief.key_finding_sources![0]).toBe(1);
    expect(sources[brief.key_finding_sources![0]].url).toBe('https://high.com');
  });

  it('detects gaps when sub-queries have no source coverage', async () => {
    const sources = [
      mkSource({ markdown_content: 'This source talks about Python and Django web development exclusively.' }),
    ];
    const brief = await buildResearchBrief('q', sources, ['quantum computing applications', 'blockchain scalability'], 3000, 40000);
    expect(brief.sections.gaps.length).toBeGreaterThan(0);
    expect(brief.sections.gaps.some(g => typeof g === 'string' && g.includes('quantum'))).toBe(true);
  });

  it('surfaces named entities not represented by any sub-query in sections.gaps', async () => {
    const sources = [mkSource()];
    const brief = await buildResearchBrief(
      'tradeoffs between MCP, OpenAPI tool schemas, and A2A for agent interop in 2026',
      sources,
      ['MCP comparison for agent interop', 'OpenAPI tool schema overview'],
      3000,
      40000,
    );
    const entityGaps = brief.sections.gaps.filter(
      (g): g is { entity: string; reason: string } => typeof g === 'object',
    );
    expect(entityGaps).toContainEqual({ entity: 'A2A', reason: 'no sub-query planned' });
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
