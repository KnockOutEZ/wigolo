import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Async Article',
    markdown:
      '# Rust Async Guide\n\nRust async functions return futures that are evaluated lazily by an executor. ' +
      'The async/await syntax provides ergonomic concurrency without runtime overhead. Tokio is the most ' +
      'widely used async runtime in the Rust ecosystem and integrates with the futures crate.\n\n' +
      '## Tokio runtime\n\nTokio provides a multi-threaded scheduler and a single-threaded scheduler for IO. ' +
      'Tasks are spawned with tokio::spawn and run cooperatively until they yield at an await point.',
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

const { handleSearch } = await import('../../src/tools/search.js');

const stubResults: RawSearchResult[] = [
  { title: 'Rust Async Guide',  url: 'https://rust-lang.org/async',  snippet: 'Async returns lazy futures.', relevance_score: 0.95, engine: 'stub' },
  { title: 'Tokio Runtime',     url: 'https://tokio.rs/',            snippet: 'Tokio is an async runtime.',  relevance_score: 0.90, engine: 'stub' },
  { title: 'Futures Crate',     url: 'https://docs.rs/futures',      snippet: 'Future trait for async.',     relevance_score: 0.85, engine: 'stub' },
  { title: 'Async Book',        url: 'https://rust-lang.github.io/async-book', snippet: 'Comprehensive async guide.', relevance_score: 0.80, engine: 'stub' },
  { title: 'Pin and Unpin',     url: 'https://doc.rust-lang.org/std/pin/index.html', snippet: 'Pinning explained.', relevance_score: 0.75, engine: 'stub' },
  { title: 'Select macro',      url: 'https://docs.rs/tokio/latest/tokio/macro.select.html', snippet: 'Race futures.', relevance_score: 0.70, engine: 'stub' },
  { title: 'JoinSet API',       url: 'https://docs.rs/tokio/latest/tokio/task/struct.JoinSet.html', snippet: 'Group of tasks.', relevance_score: 0.65, engine: 'stub' },
  { title: 'Async traits',      url: 'https://blog.rust-lang.org/inside-rust/2022/11/17/async-fn-in-trait.html', snippet: 'Async trait support.', relevance_score: 0.60, engine: 'stub' },
  { title: 'Cancellation',      url: 'https://tokio.rs/tokio/topics/cancellation', snippet: 'Cancel futures.', relevance_score: 0.55, engine: 'stub' },
  { title: 'Tracing console',   url: 'https://github.com/tokio-rs/console', snippet: 'Diagnostics for async.', relevance_score: 0.50, engine: 'stub' },
];

const fakeEngines = (): SearchEngine[] => [{
  name: 'stub',
  search: vi.fn().mockResolvedValue(stubResults),
}];

const fakeRouter = (): SmartRouter => ({
  fetch: vi.fn().mockImplementation((url: string) => Promise.resolve({
    url,
    finalUrl: url,
    html: '<html><body><h1>Async</h1><p>Content.</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http' as const,
    headers: {},
  })),
} as unknown as SmartRouter);

describe('citation_id stability across pagination', () => {
  const originalEnv = process.env;

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

  it('same url + offset produces same citation_id when re-queried', async () => {
    const a = await handleSearch({ query: 'rust async', max_results: 10 }, fakeEngines(), fakeRouter());
    const b = await handleSearch({ query: 'rust async', max_results: 5 }, fakeEngines(), fakeRouter());
    const aById = new Map((a.evidence ?? []).map((e) => [e.citation_id, e]));
    let overlapCount = 0;
    for (const ev of b.evidence ?? []) {
      const same = aById.get(ev.citation_id);
      if (same) {
        overlapCount++;
        expect(same.url).toBe(ev.url);
        expect(same.source_span.start).toBe(ev.source_span.start);
      }
    }
    expect(overlapCount).toBeGreaterThan(0);
  });
});
