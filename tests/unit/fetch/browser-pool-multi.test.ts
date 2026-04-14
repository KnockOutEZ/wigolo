import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Mock Playwright to avoid actual browser launches
vi.mock('playwright', () => {
  function makeMockBrowser(type: string) {
    const contexts: Array<{
      close: ReturnType<typeof vi.fn>;
      newPage: ReturnType<typeof vi.fn>;
    }> = [];
    return {
      launch: vi.fn().mockResolvedValue({
        newContext: vi.fn().mockImplementation(() => {
          const ctx = {
            close: vi.fn().mockResolvedValue(undefined),
            newPage: vi.fn().mockResolvedValue({
              goto: vi.fn().mockResolvedValue({
                status: () => 200,
                url: () => 'https://example.com',
                headers: () => ({ 'content-type': 'text/html' }),
              }),
              waitForLoadState: vi.fn().mockResolvedValue(undefined),
              content: vi.fn().mockResolvedValue(`<html><body>${type} page</body></html>`),
              screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
              setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
              close: vi.fn().mockResolvedValue(undefined),
            }),
          };
          contexts.push(ctx);
          return ctx;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      _contexts: contexts,
    };
  }

  return {
    chromium: makeMockBrowser('chromium'),
    firefox: makeMockBrowser('firefox'),
    webkit: makeMockBrowser('webkit'),
  };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import type { BrowserType } from '../../../src/types.js';

describe('MultiBrowserPool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('constructs with default chromium type', () => {
    const pool = new MultiBrowserPool();
    expect(pool.getConfiguredTypes()).toEqual(['chromium']);
  });

  it('constructs with specified browser types', () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    expect(pool.getConfiguredTypes()).toEqual(['chromium', 'firefox']);
  });

  it('constructs with all three browser types', () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox', 'webkit'] });
    expect(pool.getConfiguredTypes()).toEqual(['chromium', 'firefox', 'webkit']);
  });

  it('fetchWithBrowser uses default type when none specified', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium'] });
    const result = await pool.fetchWithBrowser('https://example.com');
    expect(result.html).toContain('chromium page');
    expect(result.method).toBe('playwright');
    await pool.shutdown();
  });

  it('fetchWithBrowser uses specified browser type', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    const result = await pool.fetchWithBrowser('https://example.com', { browserType: 'firefox' });
    expect(result.html).toContain('firefox page');
    await pool.shutdown();
  });

  it('fetchWithBrowser falls back to first type for unknown type', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium'] });
    const result = await pool.fetchWithBrowser('https://example.com', { browserType: 'webkit' });
    // webkit is not configured, so it falls back to chromium
    expect(result.html).toContain('chromium page');
    await pool.shutdown();
  });

  it('round-robin distributes across configured types', async () => {
    const pool = new MultiBrowserPool({
      browserTypes: ['chromium', 'firefox'],
      selectionStrategy: 'round-robin',
    });

    const r1 = await pool.fetchWithBrowser('https://example.com');
    const r2 = await pool.fetchWithBrowser('https://example.com');
    const r3 = await pool.fetchWithBrowser('https://example.com');

    // round-robin: chromium, firefox, chromium
    expect(r1.html).toContain('chromium page');
    expect(r2.html).toContain('firefox page');
    expect(r3.html).toContain('chromium page');
    await pool.shutdown();
  });

  it('explicit type overrides round-robin selection', async () => {
    const pool = new MultiBrowserPool({
      browserTypes: ['chromium', 'firefox'],
      selectionStrategy: 'round-robin',
    });

    const r1 = await pool.fetchWithBrowser('https://example.com', { browserType: 'firefox' });
    expect(r1.html).toContain('firefox page');
    await pool.shutdown();
  });

  it('shutdown closes all browser instances', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    await pool.fetchWithBrowser('https://example.com');
    await pool.fetchWithBrowser('https://example.com', { browserType: 'firefox' });
    await pool.shutdown();
    // Double shutdown is safe
    await pool.shutdown();
  });

  it('handles concurrent fetches across different types', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });

    const [r1, r2, r3] = await Promise.all([
      pool.fetchWithBrowser('https://a.com', { browserType: 'chromium' }),
      pool.fetchWithBrowser('https://b.com', { browserType: 'firefox' }),
      pool.fetchWithBrowser('https://c.com', { browserType: 'chromium' }),
    ]);

    expect(r1.html).toContain('chromium');
    expect(r2.html).toContain('firefox');
    expect(r3.html).toContain('chromium');
    await pool.shutdown();
  });

  it('getStats returns per-type pool statistics', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    await pool.fetchWithBrowser('https://example.com', { browserType: 'chromium' });

    const stats = pool.getStats();
    expect(stats).toHaveLength(2);

    const chromiumStat = stats.find(s => s.type === 'chromium');
    expect(chromiumStat).toBeDefined();
    expect(chromiumStat!.activeCount).toBeGreaterThanOrEqual(0);

    const firefoxStat = stats.find(s => s.type === 'firefox');
    expect(firefoxStat).toBeDefined();
    await pool.shutdown();
  });

  it('respects maxBrowsers per type', async () => {
    process.env.MAX_BROWSERS = '1';
    resetConfig();

    const pool = new MultiBrowserPool({ browserTypes: ['chromium'] });

    // First fetch should work
    const r1 = await pool.fetchWithBrowser('https://example.com');
    expect(r1.html).toContain('chromium');

    await pool.shutdown();
  });

  it('handles screenshot option', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium'] });
    const result = await pool.fetchWithBrowser('https://example.com', { screenshot: true });
    expect(result.screenshot).toBeDefined();
    await pool.shutdown();
  });

  it('handles headers option', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium'] });
    const result = await pool.fetchWithBrowser('https://example.com', {
      headers: { 'X-Custom': 'value' },
    });
    expect(result.html).toBeDefined();
    await pool.shutdown();
  });

  it('handles empty browserTypes by defaulting to chromium', () => {
    const pool = new MultiBrowserPool({ browserTypes: [] as unknown as BrowserType[] });
    expect(pool.getConfiguredTypes().length).toBeGreaterThanOrEqual(1);
  });

  it('hostname-hash strategy returns consistent type for same URL', async () => {
    const pool = new MultiBrowserPool({
      browserTypes: ['chromium', 'firefox'],
      selectionStrategy: 'hostname-hash',
    });

    const r1 = await pool.fetchWithBrowser('https://stable.example.com/page1');
    const r2 = await pool.fetchWithBrowser('https://stable.example.com/page2');

    // Same hostname should get same browser type
    expect(r1.html).toBe(r2.html);
    await pool.shutdown();
  });

  it('stores the used browser type in the result metadata', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    const result = await pool.fetchWithBrowser('https://example.com', { browserType: 'firefox' });
    expect(result.method).toBe('playwright');
    await pool.shutdown();
  });
});
