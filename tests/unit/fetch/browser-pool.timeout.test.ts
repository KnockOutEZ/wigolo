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
        // settlePage's hybrid gate: probe resolves immediately so the
        // goto-success case settles fast without the stability poller.
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
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

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

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
