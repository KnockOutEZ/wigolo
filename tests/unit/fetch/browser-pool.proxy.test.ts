import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const launchCalls: Array<Record<string, unknown>> = [];

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><body>ok content long enough to pass</body></html>'),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
    addCookies: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockResolvedValue(makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    launchCalls.push(opts);
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

const originalEnv = process.env;

describe('browser-pool proxy launch option', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    launchCalls.length = 0;
    resetConfig();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('does NOT pass a proxy launch option when useProxy is off (default)', async () => {
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    expect(launchCalls.length).toBeGreaterThan(0);
    for (const c of launchCalls) expect(c.proxy).toBeUndefined();
  });

  it('threads a structured proxy launch option (creds NOT inline in server) when configured', async () => {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://alice:s3cret@proxy.example.com:8080';
    resetConfig();
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://example.com', {});
    const withProxy = launchCalls.find((c) => c.proxy !== undefined);
    expect(withProxy).toBeDefined();
    const proxy = withProxy!.proxy as { server: string; username?: string; password?: string };
    expect(proxy.username).toBe('alice');
    expect(proxy.password).toBe('s3cret');
    expect(proxy.server).not.toContain('s3cret');
    expect(proxy.server).toContain('proxy.example.com:8080');
  });
});
