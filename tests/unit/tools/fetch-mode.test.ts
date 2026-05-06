import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { initDatabase, closeDatabase, getDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import { resetConfig } from '../../../src/config.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

function makeRaw(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>hello</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeExtraction(): ExtractionResult {
  return {
    title: 'Cached Title',
    markdown: '# Cached\n\nCached content.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
}

function expireCacheRow(): void {
  getDatabase()
    .prepare("UPDATE url_cache SET expires_at = datetime('now', '-1 hour')")
    .run();
}

describe('fetch mode validation', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('rejects unknown mode', async () => {
    const router = { fetch: vi.fn() } as unknown as SmartRouter;
    await expect(
      handleFetch({ url: 'https://example.com', mode: 'turbo' as 'cache' }, router),
    ).rejects.toThrow(/Invalid mode/i);
  });
});

describe('fetch mode=fast', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('returns cache_miss without calling router when mode=fast and url not cached', async () => {
    const router = { fetch: vi.fn() } as unknown as SmartRouter;

    const __r_out = await handleFetch({ url: 'https://example.com/', mode: 'fast' }, router);;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

    expect(router.fetch).not.toHaveBeenCalled();
    expect((out as any).error).toBe('cache_miss');
    expect((out as any).stage).toBe('fetch');
  });

  it('serves stale cache (within 24h window) without calling router and marks stale=true', async () => {
    cacheContent(makeRaw('https://stale.test/'), makeExtraction());
    expireCacheRow();

    const router = { fetch: vi.fn() } as unknown as SmartRouter;
    const __r_out = await handleFetch({ url: 'https://stale.test/', mode: 'fast' }, router);;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
    expect(out.stale).toBe(true);
    expect(out.cached_at).toBeTruthy();
  });

  it('balanced mode rejects the same stale row and refetches via router', async () => {
    cacheContent(makeRaw('https://stale.test/'), makeExtraction());
    expireCacheRow();

    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://stale.test/',
        finalUrl: 'https://stale.test/',
        html: '<html><body><p>fresh</p></body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http',
        headers: {},
      }),
    } as unknown as SmartRouter;

    const __r_out = await handleFetch({ url: 'https://stale.test/', mode: 'balanced' }, router);;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

    expect(router.fetch).toHaveBeenCalledTimes(1);
    expect(out.cached).toBe(false);
    expect(out.stale).toBeUndefined();
  });
});

describe('fetch js_required handling', () => {
  beforeEach(() => { initDatabase(':memory:'); resetConfig(); });
  afterEach(() => { closeDatabase(); resetConfig(); });

  it('surfaces js_required when the router marks the raw result as a JS shell', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://spa.test/',
        finalUrl: 'https://spa.test/',
        html: '<div id="root"></div>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http',
        headers: {},
        jsRequired: true,
      }),
    } as unknown as SmartRouter;
    const __r_out = await handleFetch({ url: 'https://spa.test/' }, router);;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    expect(out.js_required).toBe(true);
  });
});
