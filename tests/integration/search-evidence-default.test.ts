import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { handleSearch } from '../../src/tools/search.js';
import { countTokens } from '../../src/search/tokens.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown:
      '# Rust Async Guide\n\nRust async functions return futures that are evaluated lazily. The async/await syntax provides ergonomic concurrency without runtime overhead. Tokio is the most widely used async runtime in the Rust ecosystem and integrates with the futures crate.\n\n## Tokio runtime\n\nTokio provides a multi-threaded scheduler and a single-threaded scheduler suitable for IO-bound workloads. Tasks are spawned with tokio::spawn and run cooperatively until they yield at an await point.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => false,
    isSubprocessReady: () => false,
    embedAsync: vi.fn(),
  }),
}));

const stubEngine: SearchEngine = {
  name: 'stub',
  search: vi.fn().mockResolvedValue([
    {
      title: 'Rust Async Guide',
      url: 'https://rust-lang.org/async',
      snippet: 'Rust async functions return futures evaluated lazily.',
      relevance_score: 0.95,
      engine: 'stub',
    },
    {
      title: 'Tokio Runtime',
      url: 'https://tokio.rs/',
      snippet: 'Tokio is an async runtime for the Rust programming language.',
      relevance_score: 0.85,
      engine: 'stub',
    },
  ] satisfies RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockResolvedValue({
    url: 'https://rust-lang.org/async',
    finalUrl: 'https://rust-lang.org/async',
    html: '<html><body><p>Content</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  }),
} as unknown as SmartRouter;

describe('search default → evidence shape', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('returns evidence list with non-empty excerpts under 2000 tokens', async () => {
    const out = await handleSearch(
      { query: 'rust async', max_tokens_out: 2000 },
      [stubEngine],
      stubRouter,
    );
    expect(out.evidence).toBeDefined();
    expect(out.evidence!.length).toBeGreaterThan(0);
    for (const ev of out.evidence!) {
      expect(ev.excerpt.length).toBeGreaterThan(0);
      expect(ev.citation_id).toMatch(/^[a-f0-9]{12}$/);
      expect(ev.source_span.end).toBeGreaterThan(ev.source_span.start);
    }
    const totalTokens = out.evidence!.reduce((s, e) => s + countTokens(e.excerpt), 0);
    expect(totalTokens).toBeLessThanOrEqual(2000);
  });

  it('strips markdown_content by default (include_full_markdown=false)', async () => {
    const out = await handleSearch(
      { query: 'rust async' },
      [stubEngine],
      stubRouter,
    );
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) {
      expect(r.markdown_content).toBeUndefined();
    }
  });

  it('preserves markdown_content when include_full_markdown=true', async () => {
    const out = await handleSearch(
      { query: 'rust async', include_full_markdown: true },
      [stubEngine],
      stubRouter,
    );
    expect(out.results.length).toBeGreaterThan(0);
    const anyHasMarkdown = out.results.some((r) => typeof r.markdown_content === 'string' && r.markdown_content.length > 0);
    expect(anyHasMarkdown).toBe(true);
  });

  it('citation_format=numbered (default) appends citation_id to numeric citations', async () => {
    const out = await handleSearch(
      { query: 'rust async' },
      [stubEngine],
      stubRouter,
    );
    expect(out.citations).toBeDefined();
    expect(out.citations!.length).toBeGreaterThan(0);
    for (const c of out.citations!) {
      expect(c.index).toBeGreaterThanOrEqual(1);
      expect(c.citation_id).toMatch(/^[a-f0-9]{12}$/);
    }
    expect(out.citations_xml).toBeUndefined();
  });

  it('citation_format=json emits citations[] with citation_id', async () => {
    const out = await handleSearch(
      { query: 'rust async', citation_format: 'json' },
      [stubEngine],
      stubRouter,
    );
    expect(out.citations).toBeDefined();
    expect(out.citations![0].citation_id).toBeTruthy();
    expect(out.citations![0].citation_id).toMatch(/^[a-f0-9]{12}$/);
    expect(out.citations_xml).toBeUndefined();
  });

  it('citation_format=anthropic_tags emits citations_xml string of <source> tags', async () => {
    const out = await handleSearch(
      { query: 'rust async', citation_format: 'anthropic_tags' },
      [stubEngine],
      stubRouter,
    );
    expect(out.citations).toBeDefined();
    expect(out.citations!.length).toBeGreaterThan(0);
    expect(out.citations_xml).toBeDefined();
    expect(out.citations_xml!).toMatch(/<source id="[a-f0-9]{12}">/);
    expect(out.citations_xml!).toMatch(/<\/source>/);
  });

  it('citation_id is stable for same url+passage start across calls', async () => {
    const out1 = await handleSearch({ query: 'rust async' }, [stubEngine], stubRouter);
    const out2 = await handleSearch({ query: 'rust async' }, [stubEngine], stubRouter);
    const ids1 = (out1.evidence ?? []).map((e) => e.citation_id).sort();
    const ids2 = (out2.evidence ?? []).map((e) => e.citation_id).sort();
    expect(ids1).toEqual(ids2);
  });
});
