import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchEngine, RawSearchResult, ResearchInput, StageError } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// WHY: research reports coverage gaps. A source that was found and then REFUSED is a gap we
// know the cause of — materially different from "the web is thin here", which is all the
// sub-query heuristic can ever infer.
//
// Before this slice a refusal was not a gap at all. The router RETURNS a stage error rather
// than throwing, so it missed the catch block that builds `{fetched: false, fetch_error}` and
// took the success path instead: the source arrived marked `fetched: true` with empty content,
// asserting the page had been retrieved and had nothing in it.

const ON_TOPIC = Array.from(
  { length: 30 },
  () => 'SQLite FTS5 full text search versus a dedicated vector database tradeoffs for local semantic ranking',
).join('. ');

const embedAsyncMock = vi.fn();
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({ isAvailable: () => true, embedAsync: embedAsyncMock }),
}));

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

const BLOCKED: StageError = {
  error: 'blocked_by_challenge',
  error_reason: 'Bot protection challenge was not cleared',
  stage: 'fetch',
  http_status: 403,
};

const QUESTION = 'SQLite FTS5 vs dedicated vector database tradeoffs';

function stubEngine(results: RawSearchResult[]): SearchEngine {
  return { name: 'stub', search: vi.fn().mockResolvedValue(results) } as unknown as SearchEngine;
}

function okRaw(url: string) {
  return {
    url,
    finalUrl: url,
    html: '<html><body><p>content</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  };
}

function candidates(blockedHosts: string[], okCount: number): RawSearchResult[] {
  return [
    ...blockedHosts.map((h, i) => ({
      title: `Blocked source ${i}`,
      url: `https://${h}/articles/fts5-vs-vector-blocked-${i}`,
      snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
      relevance_score: 0.99 - i * 0.001,
      engine: 'stub' as const,
    })),
    ...Array.from({ length: okCount }, (_, i) => ({
      title: `FTS5 vs vector DB article ${i}`,
      url: `https://content${i}.example.com/articles/fts5-vs-vector-${i}`,
      snippet: 'SQLite FTS5 versus a dedicated vector database tradeoffs.',
      relevance_score: 0.9 - i * 0.01,
      engine: 'stub' as const,
    })),
  ];
}

function routerBlocking(hosts: string[]): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) =>
      hosts.some((h) => url.includes(h)) ? BLOCKED : okRaw(url),
    ),
  } as unknown as SmartRouter;
}

const INPUT: ResearchInput = { question: QUESTION, depth: 'quick' };

beforeEach(() => vi.clearAllMocks());

describe('research pipeline — a refused source is a known gap, not a fetched-but-empty one', () => {
  it('marks the refused source fetched:false with the stage CODE as the reason', async () => {
    const engine = stubEngine(candidates(['wall.example.com'], 6));
    const out = await runResearchPipeline(INPUT, [engine], routerBlocking(['wall.example.com']));

    const refused = out.sources.find((s) => s.url.includes('wall.example.com'));
    expect(refused).toBeDefined();
    // The claim that used to be false: this page was NOT retrieved.
    expect(refused?.fetched).toBe(false);
    // The bare code, so a caller can branch on it rather than parse a reason sentence.
    expect(refused?.fetch_error).toBe('blocked_by_challenge');
  });

  it('names the refused URL in brief.sections.gaps', async () => {
    // The whole point for this subsystem: research's contract is that gaps are reported. A
    // refusal that produced no gap entry left the brief implying full coverage.
    const engine = stubEngine(candidates(['wall.example.com'], 6));
    const out = await runResearchPipeline(INPUT, [engine], routerBlocking(['wall.example.com']));

    const gapText = (out.brief?.sections.gaps ?? [])
      .map((g) => (typeof g === 'string' ? g : `${g.entity} ${g.reason}`))
      .join(' | ');
    expect(gapText).toContain('wall.example.com');
    expect(gapText).toContain('blocked_by_challenge');
  });

  it('keeps the snippet as the only text it honestly has for a refused source', async () => {
    // Not a substitute for the page — the source stays `fetched: false` and out of the
    // evidence set. It is simply the one piece of real text we actually obtained.
    const engine = stubEngine(candidates(['wall.example.com'], 6));
    const out = await runResearchPipeline(INPUT, [engine], routerBlocking(['wall.example.com']));

    const refused = out.sources.find((s) => s.url.includes('wall.example.com'));
    expect(refused?.markdown_content).toContain('SQLite FTS5');
    expect(refused?.fetched).toBe(false);
  });

  it('does not manufacture gaps on a clean run', async () => {
    // The negative direction: if every source came back, no un-retrieved gap may appear.
    const engine = stubEngine(candidates([], 7));
    const out = await runResearchPipeline(INPUT, [engine], routerBlocking([]));

    const gapText = (out.brief?.sections.gaps ?? [])
      .map((g) => (typeof g === 'string' ? g : `${g.entity} ${g.reason}`))
      .join(' | ');
    expect(gapText).not.toContain('Source not retrieved');
  });

  it('never embeds a refused source into the vector index', async () => {
    // Vectors outlive the cache rows they came from, so anything embedded keeps answering
    // find_similar afterwards. This was previously stopped only by a NOT NULL constraint
    // firing on the undefined url — a database schema standing in for a decision.
    const engine = stubEngine(candidates(['wall.example.com'], 6));
    await runResearchPipeline(INPUT, [engine], routerBlocking(['wall.example.com']));

    const embedded = embedAsyncMock.mock.calls.map((c) => String(c[0]));
    expect(embedded.some((u) => u.includes('wall.example.com'))).toBe(false);
    // And the sources that DID come back were still indexed — the guard is not a blanket off.
    expect(embedded.length).toBeGreaterThan(0);
  });
});

describe('research pipeline — shell captures stay out of the vector index', () => {
  it('does not embed a shell-labeled capture, but still embeds the rest', async () => {
    // An undetected bot wall is not a stage error — it is an ordinary 200 whose content never
    // rendered. The pipeline already refuses to CITE those; embedding one anyway kept it
    // discoverable through find_similar, and vectors outlive the cache row they came from.
    const engine = stubEngine(candidates(['shell.example.com'], 6));
    const router = {
      fetch: vi.fn(async (url: string) => ({
        ...okRaw(url),
        method: url.includes('shell.example.com') ? ('browser' as const) : ('http' as const),
        ...(url.includes('shell.example.com')
          ? { contentCompleteness: { level: 'shell' as const, reason: 'app_shell' as const, settled_by: 'budget' as const } }
          : {}),
      })),
    } as unknown as SmartRouter;

    await runResearchPipeline(INPUT, [engine], router);

    const embedded = embedAsyncMock.mock.calls.map((c) => String(c[0]));
    expect(embedded.some((u) => u.includes('shell.example.com'))).toBe(false);
    // The other direction, and the one a one-sided test would miss: over-tightening here
    // would quietly empty the semantic index for every research run wigolo performs.
    expect(embedded.length).toBeGreaterThan(0);
  });

  it('still embeds an UNLABELED capture — a missing render verdict is not a shell verdict', async () => {
    // The HTTP and TLS tiers never produce a render verdict at all, so treating "no label" as
    // "shell" would exclude most of what wigolo fetches.
    const engine = stubEngine(candidates([], 7));
    await runResearchPipeline(INPUT, [engine], routerBlocking([]));

    expect(embedAsyncMock.mock.calls.length).toBeGreaterThan(0);
  });
});
