import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CachedContent, RawFetchResult } from '../../../src/types.js';

const getCachedContentMock = vi.fn<() => CachedContent | undefined>(() => undefined);
vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: () => getCachedContentMock(),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn(() => ({ usable: true, stale: false })),
}));

const BLOCK_MARKDOWN = "You've been blocked by network security.";
const extractMock = vi.fn(async () => ({
  title: 'Blocked',
  markdown: BLOCK_MARKDOWN,
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

const REDDIT_403 = readFileSync(join(__dirname, '../../fixtures/blocked-pages/reddit-403.html'), 'utf-8');
const SHORT_OK = readFileSync(join(__dirname, '../../fixtures/blocked-pages/short-ok.html'), 'utf-8');

function routerReturning(result: RawFetchResult) {
  return { fetch: vi.fn(async () => result), getDomainStats: vi.fn() } as never;
}

function raw(html: string, statusCode: number): RawFetchResult {
  return {
    url: 'https://www.reddit.com/r/x',
    finalUrl: 'https://www.reddit.com/r/x',
    html,
    contentType: 'text/html',
    statusCode,
    method: 'browser',
    headers: {},
  };
}

describe('fetch tool — blocked flag', () => {
  beforeEach(() => {
    extractMock.mockClear();
    getCachedContentMock.mockReset();
    getCachedContentMock.mockReturnValue(undefined);
  });

  it('flags a block page but keeps it as a successful result with its content', async () => {
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, routerReturning(raw(REDDIT_403, 403)));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.blocked).toEqual({ reason: 'block_page' });
    expect(res.data.markdown).toBe(BLOCK_MARKDOWN);
    expect(res.data.http_status).toBe(403);
  });

  it('flags a block banner from a tier that reports a placeholder status (stealth mode)', async () => {
    const stealth = { ...raw(REDDIT_403, 200), statusUnknown: true };
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, routerReturning(stealth));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.blocked).toEqual({ reason: 'block_page' });
  });

  it('does not flag the same banner when the 200 is the origin\'s real status', async () => {
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, routerReturning(raw(REDDIT_403, 200)));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.blocked).toBeUndefined();
  });

  it('leaves blocked absent on a normal page', async () => {
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, routerReturning(raw(SHORT_OK, 200)));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.blocked).toBeUndefined();
  });

  it('flags a cached block page served from the cache', async () => {
    getCachedContentMock.mockReturnValue({
      id: 1,
      url: 'https://www.reddit.com/r/x',
      normalizedUrl: 'https://www.reddit.com/r/x',
      title: 'Blocked',
      markdown: BLOCK_MARKDOWN,
      rawHtml: REDDIT_403,
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'browser',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: '2026-10-27T00:00:00Z',
      expiresAt: null,
      httpStatus: 403,
    } as CachedContent);
    const router = routerReturning(raw(SHORT_OK, 200));
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, router);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.cached).toBe(true);
    expect(res.data.blocked).toEqual({ reason: 'block_page' });
  });

  it('does not take a missing status on an old cache row for a placeholder status', async () => {
    getCachedContentMock.mockReturnValue({
      id: 2,
      url: 'https://www.reddit.com/r/x',
      normalizedUrl: 'https://www.reddit.com/r/x',
      title: 'Blocked',
      markdown: BLOCK_MARKDOWN,
      rawHtml: REDDIT_403,
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'browser',
      extractorUsed: 'defuddle',
      contentHash: 'def',
      fetchedAt: '2026-10-27T00:00:00Z',
      expiresAt: null,
      // a row from before the status column existed
      httpStatus: null,
    } as CachedContent);
    const res = await handleFetch({ url: 'https://www.reddit.com/r/x' }, routerReturning(raw(SHORT_OK, 200)));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected success');
    expect(res.data.cached).toBe(true);
    expect(res.data.blocked).toBeUndefined();
  });
});
