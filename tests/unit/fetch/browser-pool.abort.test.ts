import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// State shared between test cases and the mock. Each test case controls whether
// goto resolves immediately or hangs indefinitely (simulating a slow navigation
// that should be cancelled by an AbortSignal).
const state = {
  mode: 'hang' as 'hang' | 'ok',
  // When true, page.goto resolves fast but the post-goto networkidle wait
  // hangs forever — simulating an SPA that never reaches networkidle. Used to
  // pin that an abort DURING the post-goto waits is honored deterministically.
  loadHang: false,
  pageCloseCalls: 0,
  ctxCloseCalls: 0,
};

let _pageRef: { close: ReturnType<typeof vi.fn> } | null = null;
let _ctxRef: { close: ReturnType<typeof vi.fn>; newPage: ReturnType<typeof vi.fn> } | null = null;

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => ({
    newContext: vi.fn().mockImplementation(() => {
      const page = {
        goto: vi.fn().mockImplementation(() => {
          if (state.mode === 'hang') {
            // Never resolves — simulates an in-flight navigation
            return new Promise<never>(() => {});
          }
          return Promise.resolve({
            status: () => 200,
            url: () => 'https://example.com',
            headers: () => ({ 'content-type': 'text/html' }),
          });
        }),
        waitForLoadState: vi.fn().mockImplementation(() => {
          if (state.loadHang) return new Promise<never>(() => {});
          return Promise.resolve(undefined);
        }),
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockImplementation(() => {
          state.pageCloseCalls++;
          return Promise.resolve(undefined);
        }),
      };
      const ctx = {
        close: vi.fn().mockImplementation(() => {
          state.ctxCloseCalls++;
          return Promise.resolve(undefined);
        }),
        newPage: vi.fn().mockResolvedValue(page),
      };
      _pageRef = page;
      _ctxRef = ctx;
      return Promise.resolve(ctx);
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }));

  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool abort signal handling', () => {
  beforeEach(() => {
    resetConfig();
    state.mode = 'hang';
    state.loadHang = false;
    state.pageCloseCalls = 0;
    state.ctxCloseCalls = 0;
    _pageRef = null;
    _ctxRef = null;
  });
  afterEach(() => {
    resetConfig();
  });

  it('closes the page (only) when the signal aborts mid-goto, freeing the slot', async () => {
    const pool = new MultiBrowserPool();
    const ac = new AbortController();

    // Spy on the slot-return hook so we can assert the slot is actually freed
    // on the abort path — not merely that the shared context wasn't closed.
    // releaseForType is protected; reach it via the prototype to stay typed.
    const proto = Object.getPrototypeOf(pool) as {
      releaseForType: (...args: unknown[]) => void;
    };
    const releaseSpy = vi.spyOn(proto, 'releaseForType');

    // Start a fetch that will hang on page.goto
    const p = pool.fetchWithBrowser('https://slow.example.com', { signal: ac.signal });

    // Give the pool time to reach page.goto (it's async)
    await new Promise<void>((r) => setTimeout(r, 10));

    // Abort mid-navigation
    ac.abort(new DOMException('stage_timeout', 'AbortError'));

    // Fetch must reject (not hang)
    await expect(p).rejects.toBeTruthy();

    // The PAGE was closed to free the browser slot
    expect(state.pageCloseCalls).toBeGreaterThanOrEqual(1);
    // The shared CONTEXT was never closed (pooled, not owned per-fetch)
    expect(state.ctxCloseCalls).toBe(0);
    // The slot was returned to the pool — the core "freed immediately" guarantee
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    releaseSpy.mockRestore();
    await pool.shutdown();
  });

  it('honors abort during the post-goto hydration waits, freeing the slot', async () => {
    // goto resolves fast, but networkidle never settles (SPA that never idles).
    // An abort fired during that window must reject promptly and free the slot,
    // not depend on page.close-propagation timing.
    state.mode = 'ok';
    state.loadHang = true;

    const pool = new MultiBrowserPool();
    const ac = new AbortController();

    const proto = Object.getPrototypeOf(pool) as {
      releaseForType: (...args: unknown[]) => void;
    };
    const releaseSpy = vi.spyOn(proto, 'releaseForType');

    const p = pool.fetchWithBrowser('https://spa.example.com', { signal: ac.signal });

    // Let goto resolve and the flow reach the hanging waitForLoadState.
    await new Promise<void>((r) => setTimeout(r, 10));

    // Abort during the post-goto wait.
    ac.abort(new DOMException('stage_timeout', 'AbortError'));

    // Must reject promptly rather than hang on the never-idling wait.
    await expect(p).rejects.toBeTruthy();

    expect(state.pageCloseCalls).toBeGreaterThanOrEqual(1);
    expect(state.ctxCloseCalls).toBe(0);
    expect(releaseSpy).toHaveBeenCalledTimes(1);

    releaseSpy.mockRestore();
    await pool.shutdown();
  });

  it('already-aborted signal throws before acquiring a page', async () => {
    const pool = new MultiBrowserPool();
    const ac = new AbortController();
    // Pre-abort before calling fetchWithBrowser
    ac.abort(new DOMException('stage_timeout', 'AbortError'));

    await expect(
      pool.fetchWithBrowser('https://example.com', { signal: ac.signal }),
    ).rejects.toBeTruthy();

    // newPage should never have been called because we bailed out early
    // (no context was even acquired)
    expect(_ctxRef).toBeNull();

    await pool.shutdown();
  });
});
