import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput, ContentCompleteness } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// Every fetched page extracts to substantial on-topic prose so the CONTENT gate
// never fires — this isolates the SHELL-completeness exclusion (which keys on
// the render-completeness label, not the extracted text).
const ON_TOPIC = Array.from(
  { length: 30 },
  () => 'SQLite FTS5 full text search versus a dedicated vector database tradeoffs for local semantic ranking',
).join('. ');

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(async (_html: string, url: string) => ({
      title: `Title for ${url}`,
      markdown: ON_TOPIC,
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    })),
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

const { runResearchPipeline } = await import('../../../src/research/pipeline.js');

function createStubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) } as unknown as SearchEngine;
}

// Router labels the fetch result by URL: /shell → shell, /full → full, and any
// other URL is UNLABELED (an HTTP-tier result with no contentCompleteness).
function labelingRouter(): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => {
      let completeness: ContentCompleteness | undefined;
      if (url.includes('/shell')) completeness = { level: 'shell', reason: 'app_shell', settled_by: 'budget' };
      else if (url.includes('/full')) completeness = { level: 'full', reason: 'content_verified', settled_by: 'probe' };
      else if (url.includes('/thin')) completeness = { level: 'partial', reason: 'thin_content', settled_by: 'stability' };
      return {
        url,
        finalUrl: url,
        html: '<html><body><p>content</p></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: completeness ? ('browser' as const) : ('http' as const),
        headers: {},
        ...(completeness ? { contentCompleteness: completeness } : {}),
      };
    }),
  } as unknown as SmartRouter;
}

const QUESTION = 'SQLite FTS5 vs dedicated vector database tradeoffs';

describe('research pipeline shell-completeness exclusion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes a shell-labeled source and records it in rejected_sources (stage shell-content)', async () => {
    const results: RawSearchResult[] = [
      { title: 'Shell capture', url: 'https://example.com/articles/shell-page', snippet: 'x', relevance_score: 0.99, engine: 'stub' },
      { title: 'Full article', url: 'https://example.com/articles/full-page', snippet: 'x', relevance_score: 0.98, engine: 'stub' },
      ...Array.from({ length: 6 }, (_, i) => ({
        title: `FTS5 vs vector DB article ${i}`,
        url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
        snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
        relevance_score: 0.9 - i * 0.01,
        engine: 'stub' as const,
      })),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], labelingRouter());

    // The shell source is NOT a citable source …
    const urls = result.sources.map((s) => s.url);
    expect(urls).not.toContain('https://example.com/articles/shell-page');
    // … but the full source and the unlabeled ones ARE kept.
    expect(urls).toContain('https://example.com/articles/full-page');

    // … and the shell is surfaced in rejected_sources tagged shell-content.
    const shellReject = (result.rejected_sources ?? []).find(
      (r) => r.url === 'https://example.com/articles/shell-page',
    );
    expect(shellReject).toBeDefined();
    expect(shellReject?.stage).toBe('shell-content');
  });

  it('does NOT exclude UNLABELED (non-browser) sources — only an explicit shell level filters', async () => {
    // Guards against over-filtering: an HTTP-tier source has no completeness
    // label; it must survive (undefined is not shell).
    const results: RawSearchResult[] = Array.from({ length: 6 }, (_, i) => ({
      title: `Plain HTTP article ${i}`,
      url: `https://plain${i}.example.com/articles/topic-${i}`,
      snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
      relevance_score: 0.9 - i * 0.01,
      engine: 'stub' as const,
    }));
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], labelingRouter());

    // No source was excluded for shell-content, and all unlabeled sources kept.
    const shellRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'shell-content');
    expect(shellRejects).toHaveLength(0);
    expect(result.sources.length).toBeGreaterThanOrEqual(6);
  });

  it('does NOT exclude a partial/thin_content source — only level shell filters', async () => {
    // The refinement guard: a thin-but-rendered page is partial, not shell, and
    // must survive into the evidence set (regression guard against a future
    // change broadening the gate from level==='shell' to include partial).
    const results: RawSearchResult[] = [
      { title: 'Thin page', url: 'https://example.com/articles/thin-page', snippet: 'x', relevance_score: 0.99, engine: 'stub' },
      ...Array.from({ length: 5 }, (_, i) => ({
        title: `FTS5 vs vector DB article ${i}`,
        url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
        snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
        relevance_score: 0.9 - i * 0.01,
        engine: 'stub' as const,
      })),
    ];
    const input: ResearchInput = { question: QUESTION, depth: 'quick' };

    const result = await runResearchPipeline(input, [createStubEngine(results)], labelingRouter());

    expect(result.sources.map((s) => s.url)).toContain('https://example.com/articles/thin-page');
    const shellRejects = (result.rejected_sources ?? []).filter((r) => r.stage === 'shell-content');
    expect(shellRejects).toHaveLength(0);
  });
});
