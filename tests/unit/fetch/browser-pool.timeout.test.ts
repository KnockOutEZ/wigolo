import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const state = { mode: 'timeout' as 'ok' | 'timeout' };

vi.mock('playwright', () => {
  const makeTimeoutErr = () => {
    const err = new Error('page.goto: Timeout 10000ms exceeded.') as Error & { name: string };
    err.name = 'TimeoutError';
    return err;
  };

  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockImplementation(() => ({
        goto: vi.fn().mockImplementation(() => {
          if (state.mode === 'timeout') return Promise.reject(makeTimeoutErr());
          return Promise.resolve({
            status: () => 200,
            url: () => 'https://example.com',
            headers: () => ({ 'content-type': 'text/html' }),
          });
        }),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        content: vi.fn().mockResolvedValue('<html><body>partial shell content</body></html>'),
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

import { MultiBrowserPool, BrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool goto timeout handling', () => {
  beforeEach(() => {
    resetConfig();
    state.mode = 'timeout';
  });
  afterEach(() => {
    resetConfig();
  });

  it('returns partial content with warning when page.goto times out', async () => {
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://react.dev/');
    expect(res.html).toContain('partial shell content');
    expect(res.warning).toBe('goto_timeout_partial_content');
    await pool.shutdown();
  });

  it('does not flag warning when goto succeeds', async () => {
    state.mode = 'ok';
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://example.com');
    expect(res.warning).toBeUndefined();
    await pool.shutdown();
  });
});

describe('PLAYWRIGHT_NAV_TIMEOUT_MS default', () => {
  beforeEach(() => {
    delete process.env.PLAYWRIGHT_NAV_TIMEOUT_MS;
    resetConfig();
  });
  afterEach(() => {
    resetConfig();
  });

  it('defaults to 30000ms (was 10000, too short for SPA hydration)', async () => {
    const { getConfig } = await import('../../../src/config.js');
    const cfg = getConfig();
    expect(cfg.playwrightNavTimeoutMs).toBe(30000);
  });
});

describe('browser-pool bounded acquire queue', () => {
  beforeEach(() => {
    resetConfig();
  });
  afterEach(() => {
    delete process.env.MAX_BROWSERS;
    delete process.env.BROWSER_ACQUIRE_TIMEOUT_MS;
    delete process.env.BROWSER_ACQUIRE_QUEUE_MAX;
    resetConfig();
  });

  it('rejects an acquire that waits past browserAcquireTimeoutMs instead of hanging forever', async () => {
    process.env.MAX_BROWSERS = '2';
    process.env.BROWSER_ACQUIRE_TIMEOUT_MS = '50';
    resetConfig();
    const pool = new BrowserPool();
    await pool.acquire();
    await pool.acquire(); // both slots now held (never released)
    // Third acquire has nowhere to go — it must reject on the timeout, not hang.
    await expect(pool.acquire()).rejects.toThrow(/browser_acquire_timeout/);
    await pool.shutdown();
  });

  it('rejects immediately with backpressure when the wait queue is full', async () => {
    process.env.MAX_BROWSERS = '1';
    process.env.BROWSER_ACQUIRE_QUEUE_MAX = '1';
    process.env.BROWSER_ACQUIRE_TIMEOUT_MS = '5000';
    resetConfig();
    const pool = new BrowserPool();
    await pool.acquire(); // fills the single slot
    const queued = pool.acquire(); // occupies the only queue slot
    queued.catch(() => {}); // will reject at shutdown; pre-attach to avoid unhandled rejection
    // Queue is full (max 1) → the next acquire must reject immediately.
    await expect(pool.acquire()).rejects.toThrow(/browser_acquire_queue_full/);
    await pool.shutdown();
    await expect(queued).rejects.toThrow(/browser_pool_shutdown/);
  });

  it('shutdown rejects dangling acquire waiters so no caller hangs', async () => {
    process.env.MAX_BROWSERS = '1';
    process.env.BROWSER_ACQUIRE_TIMEOUT_MS = '5000';
    resetConfig();
    const pool = new BrowserPool();
    await pool.acquire(); // fill
    const waiting = pool.acquire(); // queued
    await pool.shutdown();
    await expect(waiting).rejects.toThrow(/browser_pool_shutdown/);
  });

  it('release hands the freed slot to a waiter and cancels its acquire timeout', async () => {
    process.env.MAX_BROWSERS = '1';
    process.env.BROWSER_ACQUIRE_TIMEOUT_MS = '100';
    resetConfig();
    const pool = new BrowserPool();
    const first = await pool.acquire(); // fill
    const waiting = pool.acquire(); // queued
    pool.release(first); // hand the freed slot to the waiter
    const ctx = await waiting; // must resolve (not reject)
    expect(ctx).toBeDefined();
    // Wait past the original acquire timeout to prove the timer was cancelled
    // (no late rejection on the already-resolved waiter).
    await new Promise((r) => setTimeout(r, 150));
    await pool.shutdown();
  });
});
