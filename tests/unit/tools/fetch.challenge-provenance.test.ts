import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawFetchResult, StageError } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(() => undefined),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn(() => ({ usable: false, stale: false })),
}));

const extractMock = vi.fn(async () => ({
  title: 'Real Page',
  markdown: 'Real article content that cleared the challenge and rendered fully.',
  metadata: {},
  links: [],
  images: [],
}));
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: extractMock })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/cache/change-detector.js', () => ({ detectChange: vi.fn(() => ({ changed: false })) }));

import { handleFetch } from '../../../src/tools/fetch.js';

/** A router whose fetch resolves to a canned RawFetchResult or StageError. */
function routerReturning(result: RawFetchResult | StageError) {
  return { fetch: vi.fn(async () => result), getDomainStats: vi.fn() } as never;
}

describe('fetch tool — solve-ladder provenance surfacing', () => {
  beforeEach(() => { extractMock.mockClear(); });

  it('honest behavioral block: challenge_class:behavioral + solve_method:null on the stage error', async () => {
    // The router maps a ChallengeBlockedError to a blocked_by_challenge stage
    // error carrying the classifier's verdict.
    const blocked: StageError = {
      error: 'blocked_by_challenge',
      error_reason: "The site's bot protection served a challenge page that could not be cleared automatically",
      stage: 'fetch',
      http_status: 403,
      challenge_class: 'behavioral',
      solve_method: null,
    };
    const res = await handleFetch({ url: 'https://blocked.example/x' }, routerReturning(blocked));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a stage error');
    expect(res.error).toBe('blocked_by_challenge');
    expect(res.challenge_class).toBe('behavioral');
    expect(res.solve_method).toBeNull();
    expect(res.http_status).toBe(403);
  });

  it('cleared via auto-pass: challenge_class:interactive + solve_method:auto-pass on the success result', async () => {
    const cleared: RawFetchResult = {
      url: 'https://cleared.example/x',
      finalUrl: 'https://cleared.example/x',
      html: '<html><body><article>Real content</article></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'browser',
      headers: {},
      challenge_class: 'interactive',
      solve_method: 'auto-pass',
    };
    const res = await handleFetch({ url: 'https://cleared.example/x' }, routerReturning(cleared));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.challenge_class).toBe('interactive');
    expect(res.data.solve_method).toBe('auto-pass');
    expect(res.data.fetch_method).toBe('browser');
  });

  it('plain fetch (no challenge): challenge_class / solve_method absent', async () => {
    const plain: RawFetchResult = {
      url: 'https://plain.example/x',
      finalUrl: 'https://plain.example/x',
      html: '<html><body><article>Ordinary page</article></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http',
      headers: {},
    };
    const res = await handleFetch({ url: 'https://plain.example/x' }, routerReturning(plain));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.challenge_class).toBeUndefined();
    expect(res.data.solve_method).toBeUndefined();
  });
});
