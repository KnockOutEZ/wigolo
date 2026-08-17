import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SearchResultItem,
  RawFetchResult,
  StageError,
  ExtractionResult,
  ContentCompleteness,
} from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// WHY: search enrichment fetches several candidate pages. A page the origin REFUSES carries no
// html at all, and the extractor returns empty markdown instead of throwing — so before this
// slice a blocked source landed in the response as a result with no content, no flag and no log
// at the call site. Indistinguishable from a page that genuinely had nothing to say.
//
// The decision for this subsystem: a refusal is one result among many, so the run continues and
// deeper candidates back-fill the slot — but the slot is FLAGGED with the refusal's code so the
// caller can tell "declined" from "empty" and from "timed out". No new field was needed:
// `fetch_failed` already carries flags of exactly this kind.

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
}));

const embedAsyncMock = vi.fn();
let embeddingAvailable = true;
vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => embeddingAvailable,
    embedAsync: embedAsyncMock,
  }),
}));

const extractMock =
  vi.fn<(html: string, url: string, options?: unknown) => Promise<ExtractionResult>>();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
}));

const { fetchContentForResults } = await import('../../../src/search/content-fetch.js');

const BLOCKED: StageError = {
  error: 'blocked_by_challenge',
  error_reason: 'Bot protection challenge was not cleared',
  stage: 'fetch',
  http_status: 403,
};

function makeRaw(url: string, completeness?: ContentCompleteness): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>real page body</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: completeness ? 'browser' : 'http',
    headers: {},
    ...(completeness ? { contentCompleteness: completeness } : {}),
  };
}

function makeResult(url: string): SearchResultItem {
  return { title: `T-${url}`, url, snippet: 'snippet evidence', relevance_score: 1 };
}

function baseCtx() {
  return {
    contentMaxChars: 1000,
    maxTotalChars: 100000,
    fetchTimeoutMs: 5000,
    totalDeadline: Date.now() + 60000,
    forceRefresh: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  embeddingAvailable = true;
  extractMock.mockImplementation(async (_html, url) => ({
    title: `T-${url}`,
    markdown: `# Body for ${url}`,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }));
});

describe('search content enrichment — a refused source is flagged, not silently empty', () => {
  it('records the refusal CODE in fetch_failed rather than leaving the result blank', async () => {
    const router = { fetch: vi.fn(async () => BLOCKED) } as unknown as SmartRouter;
    const results = [makeResult('https://blocked.example.com/a')];

    await fetchContentForResults(results, router, { ...baseCtx(), maxFetches: 1 });

    // The load-bearing assertion: the caller can SEE that this source was declined. Were the
    // guard removed, markdown_content would be '' and fetch_failed undefined — a result that
    // looks like a page with no text.
    expect(results[0].fetch_failed).toBe('blocked_by_challenge');
    expect(results[0].markdown_content).toBeUndefined();
  });

  it('keeps a refusal distinguishable from a timeout', async () => {
    // Both end with no content, but only one is worth retrying and only one is the origin's
    // choice. Collapsing them to a single "failed" flag is the loss this test prevents.
    const router = {
      fetch: vi.fn(async (url: string) => {
        if (url.includes('/blocked')) return BLOCKED;
        throw new Error('timeout');
      }),
    } as unknown as SmartRouter;
    const results = [makeResult('https://x.example.com/blocked'), makeResult('https://x.example.com/slow')];

    await fetchContentForResults(results, router, { ...baseCtx(), maxFetches: 2 });

    expect(results[0].fetch_failed).toBe('blocked_by_challenge');
    expect(results[1].fetch_failed).toBe('timeout');
    expect(results[0].fetch_failed).not.toBe(results[1].fetch_failed);
  });

  it('does NOT promote the snippet into content for a refusal (only timeouts earn that)', async () => {
    // The snippet fallback exists because a page that TIMED OUT was probably fine and the
    // snippet is real evidence from it. A refusal is the origin declining — passing its
    // snippet off as retrieved content would be the same silent-substitution problem in a
    // new place.
    const router = { fetch: vi.fn(async () => BLOCKED) } as unknown as SmartRouter;
    const results = [makeResult('https://blocked.example.com/a')];

    await fetchContentForResults(results, router, {
      ...baseCtx(),
      maxFetches: 1,
      snippetFallback: true,
    });

    expect(results[0].fetch_failed).toBe('blocked_by_challenge');
    expect(results[0].markdown_content).toBeUndefined();
    expect(results[0].content_from_snippet).toBeUndefined();
  });

  it('lets other results carry: a deeper candidate back-fills the refused slot', async () => {
    // "Skip and continue" is only acceptable because the run still delivers content. Assert
    // the recovery actually happens rather than trusting it.
    const router = {
      fetch: vi.fn(async (url: string) => (url.includes('/blocked') ? BLOCKED : makeRaw(url))),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.example.com/blocked'),
      makeResult('https://b.example.com/ok'),
      makeResult('https://c.example.com/backup'),
    ];

    await fetchContentForResults(results, router, { ...baseCtx(), maxFetches: 2 });

    expect(results[0].fetch_failed).toBe('blocked_by_challenge');
    expect(results[1].markdown_content).toBeDefined();
    expect(results[2].markdown_content).toBeDefined();
  });

  it('never embeds a refusal into the vector index', async () => {
    // Vectors outlive the cache rows they came from, so anything embedded here keeps
    // answering find_similar afterwards. Until now this was prevented only by a NOT NULL
    // constraint firing on the undefined url — a database schema standing in for a decision.
    const router = { fetch: vi.fn(async () => BLOCKED) } as unknown as SmartRouter;

    await fetchContentForResults([makeResult('https://blocked.example.com/a')], router, {
      ...baseCtx(),
      maxFetches: 1,
    });

    expect(embedAsyncMock).not.toHaveBeenCalled();
  });
});

describe('search content enrichment — shell captures stay out of the vector index', () => {
  it('does not embed a shell-level capture', async () => {
    // A bot wall the challenge classifier never flagged arrives as a perfectly ordinary
    // result — no StageError to catch — labelled `shell` because nothing rendered. Embedding
    // it puts the wall's own text in the index under the real page's URL.
    const router = {
      fetch: vi.fn(async (url: string) =>
        makeRaw(url, { level: 'shell', reason: 'app_shell', settled_by: 'budget' }),
      ),
    } as unknown as SmartRouter;

    await fetchContentForResults([makeResult('https://wall.example.com/a')], router, {
      ...baseCtx(),
      maxFetches: 1,
    });

    expect(embedAsyncMock).not.toHaveBeenCalled();
  });

  it('STILL embeds ordinary content — the guard must not suppress everything', async () => {
    // The other direction, and the one a one-sided test would miss: over-tightening here
    // would quietly empty the semantic index for every search wigolo runs.
    const router = { fetch: vi.fn(async (url: string) => makeRaw(url)) } as unknown as SmartRouter;

    await fetchContentForResults([makeResult('https://good.example.com/a')], router, {
      ...baseCtx(),
      maxFetches: 1,
    });

    expect(embedAsyncMock).toHaveBeenCalledTimes(1);
    expect(embedAsyncMock).toHaveBeenCalledWith('https://good.example.com/a', expect.any(String));
  });

  it('STILL embeds a partial capture — partial is a real page that lost part of itself', async () => {
    // `shell` is the only level that means "the content never arrived". Treating `partial` as
    // unindexable would drop legitimate long pages that merely lost a section.
    const router = {
      fetch: vi.fn(async (url: string) =>
        makeRaw(url, { level: 'partial', reason: 'thin_content', settled_by: 'stability' }),
      ),
    } as unknown as SmartRouter;

    await fetchContentForResults([makeResult('https://thin.example.com/a')], router, {
      ...baseCtx(),
      maxFetches: 1,
    });

    expect(embedAsyncMock).toHaveBeenCalledTimes(1);
  });

  it('treats an extraction-side shell verdict as a shell even when the render verdict says full', async () => {
    // The two producers answer different questions and the pessimistic one wins. A caller
    // that consulted only the render verdict would embed a page whose body demonstrably did
    // not survive extraction.
    extractMock.mockImplementation(async (_html, url) => ({
      title: `T-${url}`,
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
      contentCompleteness: { level: 'shell', reason: 'no_content_extracted', settled_by: 'extraction' },
    }));
    const router = {
      fetch: vi.fn(async (url: string) =>
        makeRaw(url, { level: 'full', reason: 'content_verified', settled_by: 'probe' }),
      ),
    } as unknown as SmartRouter;

    await fetchContentForResults([makeResult('https://mixed.example.com/a')], router, {
      ...baseCtx(),
      maxFetches: 1,
    });

    expect(embedAsyncMock).not.toHaveBeenCalled();
  });
});
