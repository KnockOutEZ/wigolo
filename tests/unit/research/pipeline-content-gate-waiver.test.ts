import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

/**
 * The content gate can reject EVERY fetched source. The pipeline then fails open and reinstates
 * them, because returning nothing is worse than returning weak evidence. That substitution used to
 * be invisible: the rejects were dropped on the floor, so the audit trail vanished at exactly the
 * moment everything had failed.
 *
 * These tests pin the resolution. A waived rejection must be *stated*, and the two lists must not
 * contradict each other — a source being reported as evidence cannot simultaneously be reported as
 * rejected, or a reader has no way to tell which claim is true.
 */

// The extract stub answers per URL, so one file can drive an all-reject run, a healthy run and a
// partial-rejection run without the parallel fetches racing over shared state.
const hoisted = vi.hoisted(() => ({ pick: (_url: string): string => '' }));

// Thin AND off-topic: under the 50-word floor with no query-term overlap, so gateContent rejects it.
const REJECTABLE = 'Accept cookies. Manage preferences. Continue to site.';
// Substantial on-topic prose — comfortably over the word floor, so the gate never fires.
const HEALTHY = Array.from(
  { length: 30 },
  () => 'SQLite FTS5 full text search versus a dedicated vector database tradeoffs for local semantic ranking',
).join('. ');

vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: vi.fn(async (_html: string, url: string) => ({
      title: `Title for ${url}`,
      markdown: hoisted.pick(url),
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

function plainRouter(): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: '<html><body><p>content</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    })),
  } as unknown as SmartRouter;
}

const QUESTION = 'SQLite FTS5 vs dedicated vector database tradeoffs';

function candidates(): RawSearchResult[] {
  return Array.from({ length: 6 }, (_, i) => ({
    title: `FTS5 vs vector DB article ${i}`,
    url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
    snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
    relevance_score: 0.9 - i * 0.01,
    engine: 'stub' as const,
  }));
}

const input: ResearchInput = { question: QUESTION, depth: 'quick' };

const run = () => runResearchPipeline(input, [createStubEngine(candidates())], plainRouter());

describe('research content-gate waiver', () => {
  beforeEach(() => vi.clearAllMocks());

  it('states the waiver in `warning` when the gate rejected every fetched source', async () => {
    hoisted.pick = () => REJECTABLE;
    const result = await run();

    // The waiver actually fired — the reinstated sources are what the caller gets.
    expect(result.sources.length).toBeGreaterThan(0);
    // …and the caller is told, rather than being handed weak evidence that looks clean.
    expect(result.warning).toBeTypeOf('string');
    expect(result.warning).toMatch(/waived/i);
  });

  it('never lists a reinstated source as rejected — `sources` and `rejected_sources` cannot contradict', async () => {
    hoisted.pick = () => REJECTABLE;
    const result = await run();

    const rejectedUrls = new Set((result.rejected_sources ?? []).map((r) => r.url));
    expect(result.sources.map((s) => s.url).filter((u) => rejectedUrls.has(u))).toEqual([]);
    expect((result.rejected_sources ?? []).filter((r) => r.stage === 'content-gate')).toEqual([]);
  });

  it('stays silent on a healthy run — no warning when the gate rejected nothing', async () => {
    hoisted.pick = () => HEALTHY;
    const result = await run();

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.warning).toBeUndefined();
  });

  it('still records content-gate rejects when SOME sources survive — the waiver is the all-or-nothing case only', async () => {
    const rejectUrl = 'https://content0.example.com/articles/fts5-vs-vector-0';
    hoisted.pick = (url) => (url === rejectUrl ? REJECTABLE : HEALTHY);
    const result = await run();

    expect(result.warning).toBeUndefined();
    expect(result.sources.map((s) => s.url)).not.toContain(rejectUrl);
    expect(
      (result.rejected_sources ?? []).some((r) => r.url === rejectUrl && r.stage === 'content-gate'),
    ).toBe(true);
  });
});
