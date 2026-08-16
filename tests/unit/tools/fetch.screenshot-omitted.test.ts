import { describe, it, expect, vi } from 'vitest';

// No cache: force the live router path so the browser-pool's screenshot verdict
// reaches the fetch tool's response assembly.
vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { RawFetchResult, ScreenshotOmittedReason } from '../../../src/types.js';

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
