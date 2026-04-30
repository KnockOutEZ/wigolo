import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentInput,
  CrawlInput,
  FetchInput,
  FindSimilarInput,
  RawSearchResult,
  ResearchInput,
  SearchEngine,
  SearchInput,
} from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { countTokens } from '../../../src/search/tokens.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';

const TOLERANCE = 50;

const longParagraph = (
  '# Async Programming Deep Dive\n\n' +
  'Asynchronous programming is a fundamental technique used in modern software ' +
  'engineering to handle concurrency without blocking threads. It allows applications ' +
  'to remain responsive while waiting for IO, network requests, or long-running ' +
  'computations to complete. The async/await pattern emerged across many languages ' +
  'including JavaScript, Rust, Python, and C# as an ergonomic alternative to raw ' +
  'callbacks or promise chains.\n\n' +
  'In Rust, async functions return futures that are evaluated lazily. The compiler ' +
  'transforms each async function into a state machine that can be polled by an ' +
  'executor. Tokio is the most widely used async runtime in the Rust ecosystem, ' +
  'providing a multi-threaded scheduler that integrates tightly with the futures ' +
  'crate. Tasks are spawned with tokio::spawn and run cooperatively until they yield ' +
  'at an await point. This cooperative model means a single misbehaving task can ' +
  'starve others, so CPU-bound work should be moved off the runtime via spawn_blocking.\n\n' +
  'Channels and synchronization primitives are essential for coordinating async ' +
  'tasks. tokio::sync::mpsc, oneshot, and broadcast channels each suit different ' +
  'fan-in or fan-out patterns. Mutexes, RwLocks, and Notify give explicit control ' +
  'when shared mutable state cannot be avoided. Pinning ensures that the futures ' +
  'state machine remains at a stable address while it is being polled.\n\n' +
  'Error handling in async Rust borrows from synchronous Rust: results are ' +
  'propagated with the question-mark operator, anyhow and thiserror help compose ' +
  'application and library errors respectively, and select! lets you race futures ' +
  'against cancellation tokens. Structured concurrency patterns from libraries like ' +
  'tokio::task::JoinSet make it easier to wait for groups of tasks while propagating ' +
  'their failures.\n\n' +
  'Performance tuning relies on understanding the runtime model: the Tokio multi-' +
  'thread runtime steals work between threads, so a future executing on one worker ' +
  'may resume on another. Holding non-Send types across an await point is a common ' +
  'pitfall. Tracing-based instrumentation via tokio-console exposes long-running ' +
  'tasks, contention, and busy workers in real time.\n\n'
).repeat(3);

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Async Deep Dive',
    markdown: longParagraph,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => false,
    isSubprocessReady: () => false,
    embedAsync: vi.fn(),
  }),
}));

vi.mock('../../../src/cache/store.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cache/store.js')>(
    '../../../src/cache/store.js',
  );
  return {
    ...actual,
    cacheContent: vi.fn(),
    getCachedContent: vi.fn().mockReturnValue(null),
    isExpired: vi.fn().mockReturnValue(false),
    cacheSearchResults: vi.fn(),
    getCachedSearchResults: vi.fn().mockReturnValue(null),
  };
});

const { handleSearch } = await import('../../../src/tools/search.js');
const { handleFetch } = await import('../../../src/tools/fetch.js');
const { handleCrawl } = await import('../../../src/tools/crawl.js');
const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');
const { handleResearch } = await import('../../../src/tools/research.js');
const { handleAgent } = await import('../../../src/tools/agent.js');

const stubEngine: SearchEngine = {
  name: 'budget-stub',
  search: vi.fn().mockResolvedValue([
    {
      title: 'Async Deep Dive',
      url: 'https://rust.example.com/async',
      snippet: 'Async functions return lazy futures evaluated by an executor.',
      relevance_score: 0.95,
      engine: 'budget-stub',
    },
    {
      title: 'Tokio Internals',
      url: 'https://tokio.example.com/internals',
      snippet: 'Tokio provides a multi-threaded scheduler for async tasks.',
      relevance_score: 0.85,
      engine: 'budget-stub',
    },
  ] satisfies RawSearchResult[]),
};

const stubRouter = {
  fetch: vi.fn().mockImplementation((url: string) => Promise.resolve({
    url,
    finalUrl: url,
    html: `<html><body><h1>Async</h1><p>${longParagraph}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  })),
} as unknown as SmartRouter;

const originalEnv = process.env;

describe('max_tokens_out budget', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', LOG_LEVEL: 'error' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('search output never exceeds budget (sum of evidence excerpts + answer + warnings)', async () => {
    const input: SearchInput = { query: 'rust async', max_tokens_out: 500 };
    const out = await handleSearch(input, [stubEngine], stubRouter);
    const all = JSON.stringify(out);
    expect(countTokens(all)).toBeLessThanOrEqual(500 + TOLERANCE);
  });

  it('fetch: max_tokens_out wins over max_chars when both set', async () => {
    const input: FetchInput = {
      url: 'https://example.com',
      include_full_markdown: true,
      max_chars: 1_000_000,
      max_tokens_out: 200,
    };
    const out = await handleFetch(input, stubRouter);
    expect(countTokens(out.markdown ?? '')).toBeLessThanOrEqual(200 + TOLERANCE);
  });

  it('search: per-result markdown_content honours budget when include_full_markdown=true', async () => {
    const input: SearchInput = {
      query: 'rust async',
      max_tokens_out: 400,
      include_full_markdown: true,
    };
    const out = await handleSearch(input, [stubEngine], stubRouter);
    let perItemSum = 0;
    for (const r of out.results) {
      if (r.markdown_content) {
        const t = countTokens(r.markdown_content);
        expect(t).toBeLessThanOrEqual(400 + TOLERANCE);
        perItemSum += t;
      }
    }
    expect(perItemSum).toBeGreaterThan(0);
  });

  it('search: aggregate markdown_content across results stays within budget when include_full_markdown=true', async () => {
    const input: SearchInput = {
      query: 'rust async',
      max_tokens_out: 400,
      include_full_markdown: true,
    };
    const out = await handleSearch(input, [stubEngine], stubRouter);
    const total = out.results.reduce(
      (s, r) => s + (r.markdown_content ? countTokens(r.markdown_content) : 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(400 + TOLERANCE);
  });

  it('crawl: total page-body tokens stay under budget when include_full_markdown=true', async () => {
    const input: CrawlInput = {
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_pages: 3,
      max_tokens_out: 600,
      include_full_markdown: true,
    };
    const out = await handleCrawl(input, stubRouter);
    if ('pages' in out) {
      const total = out.pages.reduce(
        (s, p) => s + countTokens(p.markdown ?? ''),
        0,
      );
      expect(total).toBeLessThanOrEqual(600 + TOLERANCE);
    }
  });

  it('find_similar: per-result markdown stays under budget when include_full_markdown=true', async () => {
    const input: FindSimilarInput = {
      concept: 'rust async runtime',
      include_web: true,
      include_cache: false,
      max_tokens_out: 300,
      include_full_markdown: true,
    };
    const out = await handleFindSimilar(input, [stubEngine], stubRouter);
    let total = 0;
    for (const r of out.results) {
      if (r.markdown) total += countTokens(r.markdown);
    }
    expect(total).toBeLessThanOrEqual(300 + TOLERANCE);
  });

  it('research: report text honours max_tokens_out', async () => {
    const input: ResearchInput = {
      question: 'How does async work in rust?',
      depth: 'quick',
      max_tokens_out: 250,
    };
    const out = await handleResearch(input, [stubEngine], stubRouter);
    expect(countTokens(out.report ?? '')).toBeLessThanOrEqual(250 + TOLERANCE);
  });

  it('agent: result text honours max_tokens_out (no schema path)', async () => {
    const input: AgentInput = {
      prompt: 'Summarize rust async',
      max_pages: 2,
      max_tokens_out: 200,
    };
    const out = await handleAgent(input, [stubEngine], stubRouter);
    const text = typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
    expect(countTokens(text)).toBeLessThanOrEqual(200 + TOLERANCE);
  });
});
