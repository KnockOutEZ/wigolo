import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent, getCachedContent } from '../../src/cache/store.js';
import { resetConfig } from '../../src/config.js';
import { handleFetch } from '../../src/tools/fetch.js';
import type { RawFetchResult, ExtractionResult, ContentCompleteness, FetchInput } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

// A shell-labeled cache row must be treated stale (a live refetch happens),
// EXCEPT in cache-only mode where no live path exists — there the shell row is
// served labeled. The refetched result is served + cached by the fresh path,
// which does NOT re-consult the cache → exactly one refetch, never a loop.

const ARTICLE_HTML =
  '<html><body><article><h1>Fresh Article</h1>' +
  '<p>' + 'Real rendered article body content here. '.repeat(20) + '</p>' +
  '<p>' + 'More real article prose to extract cleanly. '.repeat(20) + '</p>' +
  '</article></body></html>';

function makeRaw(url: string, completeness?: ContentCompleteness): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: ARTICLE_HTML,
    contentType: 'text/html',
    statusCode: 200,
    method: 'playwright',
    headers: {},
    ...(completeness ? { contentCompleteness: completeness } : {}),
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Fresh Article',
    markdown: '# Fresh Article\n\nReal rendered article body content here.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

// Seed a cache row directly with the given completeness label.
function seedCache(url: string, completeness?: ContentCompleteness): void {
  cacheContent(makeRaw(url, completeness), makeExtraction());
}

// A router whose fetch counts calls and returns a fresh (shell-again) result.
// contentCompleteness on the returned raw is a shell again — proving that even
// when the refetch is ALSO a shell, it is served + cached without re-entering
// the gate (no loop).
function countingRouter(freshCompleteness: ContentCompleteness): { router: SmartRouter; calls: () => number } {
  const fetch = vi.fn(async (url: string) => makeRaw(url, freshCompleteness));
  return {
    router: { fetch } as unknown as SmartRouter,
    calls: () => fetch.mock.calls.length,
  };
}

const SHELL: ContentCompleteness = { level: 'shell', reason: 'app_shell', settled_by: 'budget' };
const FULL: ContentCompleteness = { level: 'full', reason: 'content_verified', settled_by: 'probe' };
const PARTIAL: ContentCompleteness = { level: 'partial', reason: 'never_settled', settled_by: 'budget' };

// The extraction pipeline runs for real on the fresh path; stub it to a stable
// output so these tests exercise the CACHE GATE, not extractor internals.
vi.mock('../../src/extraction/pipeline.js', async (orig) => {
  const actual = await orig<typeof import('../../src/extraction/pipeline.js')>();
  return { ...actual, extractContent: vi.fn(async () => makeExtraction()) };
});

describe('fetch cache gate — shell captures are cache-stale', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
    vi.clearAllMocks();
  });

  it('shell-cached row is NOT served from cache → exactly ONE live refetch (no loop)', async () => {
    const url = 'https://example.com/shell';
    seedCache(url, SHELL);
    // Sanity: the seeded row really carries a shell label.
    expect(getCachedContent(url)!.contentCompleteness?.level).toBe('shell');

    const { router, calls } = countingRouter(SHELL);
    const input: FetchInput = { url };
    const r = await handleFetch(input, router);

    // A live fetch happened (fell through the shell-stale gate) …
    expect(calls()).toBe(1);
    // … and the fresh result was served (not the cached one), even though it is
    // shell again — and served exactly once with no re-entry into the gate.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.content_completeness?.level).toBe('shell');
  });

  it('full-cached row is served from cache (no refetch)', async () => {
    const url = 'https://example.com/full';
    seedCache(url, FULL);
    const { router, calls } = countingRouter(SHELL);
    const r = await handleFetch({ url }, router);
    expect(calls()).toBe(0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.cached).toBe(true);
      expect(r.data.content_completeness?.level).toBe('full');
    }
  });

  it('partial-cached row is served from cache (no refetch)', async () => {
    const url = 'https://example.com/partial';
    seedCache(url, PARTIAL);
    const { router, calls } = countingRouter(SHELL);
    const r = await handleFetch({ url }, router);
    expect(calls()).toBe(0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.cached).toBe(true);
  });

  it('force_refresh bypasses the cache entirely (one live fetch regardless of label)', async () => {
    const url = 'https://example.com/full-forced';
    seedCache(url, FULL);
    const { router, calls } = countingRouter(FULL);
    const r = await handleFetch({ url, force_refresh: true }, router);
    expect(calls()).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.cached).toBe(false);
  });

  it('mode:cache serves a SHELL-cached row LABELED (no live path in cache-only mode)', async () => {
    const url = 'https://example.com/shell-cache-only';
    seedCache(url, SHELL);
    const { router, calls } = countingRouter(SHELL);
    const r = await handleFetch({ url, mode: 'cache' }, router);
    // Cache-only mode has no live path — the shell row IS served, carrying its
    // label so the caller sees the warning rather than a cache_miss.
    expect(calls()).toBe(0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.cached).toBe(true);
      expect(r.data.content_completeness?.level).toBe('shell');
    }
  });
});
