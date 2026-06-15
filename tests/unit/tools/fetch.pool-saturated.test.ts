import { describe, it, expect, vi } from 'vitest';

// No cache: force the router path so the browser-pool rejection reaches the
// fetch tool's error handling.
vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

// A router whose fetch rejects exactly as the bounded browser pool now does when
// the pool is saturated (see browser-pool.ts acquireForType / shutdown).
function rejectingRouter(message: string): SmartRouter {
  return {
    fetch: async () => {
      throw new Error(message);
    },
  } as unknown as SmartRouter;
}

/**
 * 0b.2 regression guard (load-bearing fetch path): the new bounded browser
 * queue can reject an acquire (timeout / backpressure / shutdown). An existing
 * `fetch` must surface that as a clean StageResult `{ok:false}` — never a throw
 * or an unhandled promise rejection.
 */
describe('fetch surfaces a saturated browser pool as a clean StageResult', () => {
  async function expectCleanStageResult(rejectionMessage: string) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const result = await handleFetch(
        { url: 'https://example.com/heavy-spa', force_refresh: true, render_js: 'always' },
        rejectingRouter(rejectionMessage),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_reason).toBeTruthy();
        expect(result.stage).toBe('fetch');
      }
      // Allow any stray microtask rejection to surface before asserting none did.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }

  it('acquire timeout → StageResult, not an unhandled rejection', async () => {
    await expectCleanStageResult(
      'browser_acquire_timeout: waited 30000ms for a chromium browser (pool saturated)',
    );
  });

  it('queue-full backpressure → StageResult, not an unhandled rejection', async () => {
    await expectCleanStageResult(
      'browser_acquire_queue_full: 100 callers already waiting for a chromium browser (max 100)',
    );
  });
});
