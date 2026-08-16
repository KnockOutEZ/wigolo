import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cache behaviour is per-test: the CACHE-HIT path is the highest-frequency
// requested-but-absent case, so it must be exercised, not mocked away.
const getCachedContent = vi.fn();
const isCacheUsable = vi.fn();
vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: (...a: unknown[]) => getCachedContent(...a),
  cacheContent: vi.fn(),
  isCacheUsable: (...a: unknown[]) => isCacheUsable(...a),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { RawFetchResult, ScreenshotOmittedReason } from '../../../src/types.js';

beforeEach(() => {
  getCachedContent.mockReset().mockReturnValue(null);
  isCacheUsable.mockReset().mockReturnValue({ usable: false, stale: false });
});

/** A cached row good enough for formatCachedResponse to serve. */
function cachedRow() {
  return {
    url: 'https://example.com/gallery',
    title: 'Gallery',
    markdown: '# Gallery\n\nSome real body text here.',
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchedAt: new Date().toISOString(),
    contentHash: 'abc123',
    httpStatus: 200,
  };
}

function routerReturning(extra: Partial<RawFetchResult>): SmartRouter {
  return {
    fetch: async (): Promise<RawFetchResult> => ({
      url: 'https://example.com/gallery',
      finalUrl: 'https://example.com/gallery',
      html: '<html><body><main><h1>Gallery</h1><p>Some real body text here.</p></main></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'browser',
      headers: {},
      ...extra,
    }),
  } as unknown as SmartRouter;
}

/**
 * A screenshot is CALLER-REQUESTED. Bounding it is correct, but a caller who asked for
 * an image and receives a response with no image and no explanation has been silently
 * degraded — the failure mode this bound exists to avoid becoming.
 *
 * The marker rides the envelope only (like `fetch_failed` / `js_required`, neither of
 * which appears in the tool description), so it announces the drop at zero cost to the
 * description budget. These assertions are at the TOOL boundary because that is where a
 * caller actually reads it — a unit test on the capture helper cannot show the field
 * survives response assembly.
 */
describe('fetch announces a suppressed screenshot on the envelope', () => {
  it('surfaces size_limit when the capture exceeded the byte cap', async () => {
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ screenshotOmitted: 'size_limit' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.screenshot).toBeUndefined();
      expect(result.data.screenshot_omitted).toBe('size_limit');
    }
  });

  it('surfaces capture_failed distinctly, so the caller can tell them apart', async () => {
    // size_limit is retryable with a smaller window; capture_failed is not.
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ screenshotOmitted: 'capture_failed' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.screenshot_omitted).toBe('capture_failed');
  });

  it('does NOT mark a delivered screenshot (must-not-fire control)', async () => {
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ screenshot: 'aGVsbG8=' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.screenshot).toBe('aGVsbG8=');
      expect(result.data.screenshot_omitted).toBeUndefined();
    }
  });

  it('does NOT mark a response where no screenshot was requested (must-not-fire control)', async () => {
    const result = await handleFetch(
      { url: 'https://example.com/gallery', force_refresh: true },
      routerReturning({}),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.screenshot_omitted).toBeUndefined();
  });

  it('marks a CACHE HIT that cannot carry a screenshot', async () => {
    // THE regression. The cache branch gates on force_refresh / mode / actions and never
    // consults `input.screenshot`, and formatCachedResponse sets neither screenshot
    // field — so every repeat `fetch(url, {screenshot:true})` returned no image and,
    // before this, no marker. Highest-frequency requested-but-absent path of the four.
    getCachedContent.mockReturnValue(cachedRow());
    isCacheUsable.mockReturnValue({ usable: true, stale: false });

    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true },
      routerReturning({}),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(true);
      expect(result.data.screenshot).toBeUndefined();
      expect(result.data.screenshot_omitted).toBe('cache_hit');
    }
  });

  it('does NOT mark a cache hit when no screenshot was asked for (must-not-fire control)', async () => {
    getCachedContent.mockReturnValue(cachedRow());
    isCacheUsable.mockReturnValue({ usable: true, stale: false });

    const result = await handleFetch({ url: 'https://example.com/gallery' }, routerReturning({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cached).toBe(true);
      expect(result.data.screenshot_omitted).toBeUndefined();
    }
  });

  it('marks a live response served by a tier that cannot rasterise', async () => {
    // The PDF content-type probe and the static stealth paths return without ever
    // reaching the browser, discarding the screenshot request. They set no reason of
    // their own, so the seam predicate has to name one.
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ method: 'http' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.screenshot).toBeUndefined();
      expect(result.data.screenshot_omitted).toBe('not_captured');
    }
  });

  it('lets a precise capture reason win over the generic seam verdict', async () => {
    // The seam must not overwrite size_limit with the vaguer not_captured — the caller
    // loses the retry hint if it does.
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ screenshotOmitted: 'size_limit' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.screenshot_omitted).toBe('size_limit');
  });

  it('keeps the page body intact — a dropped image never degrades the content', async () => {
    // Suppressing the image must cost the caller the image and nothing else.
    const result = await handleFetch(
      { url: 'https://example.com/gallery', screenshot: true, force_refresh: true },
      routerReturning({ screenshotOmitted: 'size_limit' as ScreenshotOmittedReason }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.markdown).toContain('Gallery');
      expect(result.data.http_status).toBe(200);
    }
  });
});
