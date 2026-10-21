import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Shared mock state: how many local launches happened + how the cdp-direct rung
// was invoked, so a test can assert WHICH path a fetch took (rung vs fall-through).
interface State {
  launchCalls: number;
  cdpDirectCalls: Array<{ url: string }>;
  // When set, the mocked cdpDirectFetch returns null (rung absent/failed) →
  // the pool must fall back to the local browser tier.
  cdpDirectReturnsNull: boolean;
}

const state: State = { launchCalls: 0, cdpDirectCalls: [], cdpDirectReturnsNull: false };

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue({
      status: () => 200,
      url: () => 'https://example.com',
      headers: () => ({ 'content-type': 'text/html' }),
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((src: string) =>
      typeof src === 'string' && src.includes('hasContent')
        ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
        : Promise.resolve({ textLen: 1000, nodes: 8 })),
    content: vi.fn().mockResolvedValue('<html><body>local-tier</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext() {
  return {
    addInitScript: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(makePage()),
    cookies: vi.fn().mockResolvedValue([]),
  };
}

function makeBrowser() {
  return {
    version: vi.fn().mockReturnValue('142.0.7444.0'),
    contexts: vi.fn().mockReturnValue([]),
    newContext: vi.fn().mockResolvedValue(makeContext()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(() => {
    state.launchCalls += 1;
    return Promise.resolve(makeBrowser());
  });
  const connectOverCDP = vi.fn().mockImplementation(() => Promise.resolve(makeBrowser()));
  const stub = { launch, connectOverCDP };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('../../../src/fetch/cdp-direct.js', () => ({
  cdpDirectFetch: vi.fn().mockImplementation((url: string) => {
    state.cdpDirectCalls.push({ url });
    if (state.cdpDirectReturnsNull) return Promise.resolve(null);
    return Promise.resolve({
      url,
      finalUrl: url,
      html: '<html><body>cdp-direct-rung</body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'browser',
      headers: {},
    });
  }),
}));

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.launchCalls = 0;
  state.cdpDirectCalls = [];
  state.cdpDirectReturnsNull = false;
}

describe('cdp-direct escalation rung wiring (OFF by default)', () => {
  beforeEach(() => {
    resetState();
    delete process.env.WIGOLO_CDP_DIRECT;
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_CDP_DIRECT;
    resetConfig();
  });

  it('OFF by default: the rung is NEVER attempted; the normal path is byte-unchanged', async () => {
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', { stealth: true });
    // Local tier served it.
    expect(result.html).toContain('local-tier');
    expect(state.cdpDirectCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('auto + escalation (stealth:true): tries the rung FIRST; on success returns it (no local launch)', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'auto';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://blocked.example', { stealth: true });
    expect(result.html).toContain('cdp-direct-rung');
    expect(state.cdpDirectCalls.length).toBe(1);
    // The rung served content — no local browser launched.
    expect(state.launchCalls).toBe(0);
    await pool.shutdown();
  });

  it('auto WITHOUT escalation (no stealth): the rung is NOT attempted (benign fetch stays on the pool)', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'auto';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.html).toContain('local-tier');
    expect(state.cdpDirectCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('on: the rung is attempted for a plain content fetch even without stealth', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.html).toContain('cdp-direct-rung');
    expect(state.cdpDirectCalls.length).toBe(1);
    expect(state.launchCalls).toBe(0);
    await pool.shutdown();
  });

  it('graceful fallback: rung returns null → falls back to the local browser tier (never hard-fails)', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    state.cdpDirectReturnsNull = true;
    const pool = new MultiBrowserPool();
    const result = await pool.fetchWithBrowser('https://blocked.example', {});
    expect(result.html).toContain('local-tier');
    expect(state.cdpDirectCalls.length).toBe(1);
    // Fell back to a local launch.
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('content-fetch-only: a fetch with actions SKIPS the rung and uses the normal tier', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://plain.example', {
      actions: [{ type: 'click', selector: '#x' }],
    });
    expect(state.cdpDirectCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('content-fetch-only: a fetch with use_auth (storageStatePath) SKIPS the rung', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://plain.example', {
      storageStatePath: '/tmp/state.json',
    });
    expect(state.cdpDirectCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('content-fetch-only: a screenshot fetch SKIPS the rung (needs a real tab)', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://plain.example', { screenshot: true });
    expect(state.cdpDirectCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);
    await pool.shutdown();
  });

  it('content-fetch-only: a pinned cdpUrl SKIPS the rung (external browser owns the channel)', async () => {
    process.env.WIGOLO_CDP_DIRECT = 'on';
    resetConfig();
    const pool = new MultiBrowserPool();
    await pool.fetchWithBrowser('https://plain.example', {
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    });
    expect(state.cdpDirectCalls.length).toBe(0);
    await pool.shutdown();
  });
});
