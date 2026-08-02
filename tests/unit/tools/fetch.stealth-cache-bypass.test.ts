import { describe, it, expect, vi, beforeEach } from 'vitest';

// A cached row that carries a stale error body (e.g. a previously-cached 403
// challenge page). If stealth ever serves this, the retry-with-stealth escape
// hatch is useless — the whole point of stealth is to re-fetch live past an
// anti-bot block. So stealth MUST bypass the cache read entirely.
const CACHED_403: {
  url: string;
  title: string;
  markdown: string;
  metadata: string;
  links: string;
  images: string;
  fetchedAt: number;
  httpStatus: number;
} = {
  url: 'https://blocked.test/',
  title: 'Access Denied',
  markdown: '# 403 Forbidden\n\nYou are blocked.',
  metadata: '{}',
  links: '[]',
  images: '[]',
  fetchedAt: Date.now(),
  httpStatus: 403,
};

const getCachedContent = vi.fn();
const isCacheUsable = vi.fn();
const cacheContent = vi.fn();

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: (...args: unknown[]) => getCachedContent(...args),
  isCacheUsable: (...args: unknown[]) => isCacheUsable(...args),
  cacheContent: (...args: unknown[]) => cacheContent(...args),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

function liveRouter() {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://blocked.test/',
      finalUrl: 'https://blocked.test/',
      html: '<html><body><article><h1>Real content</h1><p>Fresh page fetched live past the block.</p></article></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

describe('fetch stealth mode bypasses the cache read', () => {
  beforeEach(() => {
    getCachedContent.mockReset();
    isCacheUsable.mockReset();
    cacheContent.mockReset();
    // The cache HAS a usable stale-403 row — this is what makes the bug real.
    getCachedContent.mockReturnValue(CACHED_403);
    isCacheUsable.mockReturnValue({ usable: true, stale: false });
  });

  it('does NOT serve the cached error body when mode=stealth — goes to live fetch', async () => {
    const router = liveRouter();
    const result = await handleFetch({ url: 'https://blocked.test/', mode: 'stealth' }, router);

    // Stealth must have hit the router (live fetch), never touched the cache read.
    expect(router.fetch).toHaveBeenCalledTimes(1);
    expect(getCachedContent).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).not.toBe(true);
      expect(result.data.markdown).toContain('Real content');
    }
  });

  it('negative: stealth never surfaces the cached 403 title/body', async () => {
    const router = liveRouter();
    const result = await handleFetch({ url: 'https://blocked.test/', mode: 'stealth' }, router);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).not.toBe('Access Denied');
      expect(result.data.markdown).not.toContain('403 Forbidden');
    }
  });

  it('no regression: mode=default (no force_refresh) STILL serves the same usable cached row', async () => {
    const router = liveRouter();
    const result = await handleFetch({ url: 'https://blocked.test/', mode: 'default' }, router);

    // Default is allowed to serve the usable cached row without a live fetch.
    expect(getCachedContent).toHaveBeenCalled();
    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(true);
      expect(result.data.title).toBe('Access Denied');
    }
  });
});
