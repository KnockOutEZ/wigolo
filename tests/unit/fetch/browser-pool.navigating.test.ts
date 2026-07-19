import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// React Router (and other client-side routers) trigger pushState navigations
// during initial hydration. Playwright's page.content() throws "Execution
// context was destroyed" / "Page is navigating" when called mid-transition.
// We need to retry on those errors instead of bubbling them up as fetch_failed.

const state = { contentCallCount: 0 };

vi.mock('playwright', () => {
  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockImplementation(() => ({
        goto: vi.fn().mockResolvedValue({
          status: () => 200,
          url: () => 'https://react.dev/',
          headers: () => ({ 'content-type': 'text/html' }),
        }),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        // settlePage's hybrid gate: probe resolves immediately so settle exits
        // fast, then the content()-retry path under test runs on capture.
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
        content: vi.fn().mockImplementation(() => {
          state.contentCallCount += 1;
          if (state.contentCallCount === 1) {
            return Promise.reject(
              new Error(
                'page.content: Execution context was destroyed, most likely because of a navigation',
              ),
            );
          }
          return Promise.resolve('<html><body>stable hydrated content</body></html>');
        }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool retries content() on navigation race', () => {
  beforeEach(() => {
    resetConfig();
    state.contentCallCount = 0;
  });
  afterEach(() => resetConfig());

  it('recovers when first page.content() throws "Execution context destroyed"', async () => {
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://react.dev/');
    expect(res.html).toContain('stable hydrated content');
    expect(state.contentCallCount).toBeGreaterThanOrEqual(2);
    await pool.shutdown();
  });
});
