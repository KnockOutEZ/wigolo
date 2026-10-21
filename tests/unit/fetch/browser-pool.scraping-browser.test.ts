import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Shared mock state across the mocked `playwright` + `scraping-browser` modules
// so tests can assert WHICH connect path a fetch took: a local launch, the
// pinned-CDP `connectOverCDP`, or the hosted `connectScrapingBrowser` rung.
interface SbState {
  launchCalls: number;
  connectOverCdpCalls: string[];
  // Args seen by the mocked connectScrapingBrowser (the hosted rung).
  scrapingConnectCalls: Array<{ wss: string | null | undefined }>;
  // When set, the mocked connectScrapingBrowser returns null (off / bad
  // scheme / connect failure) → the pool must fall back to the local tier.
  scrapingReturnsNull: boolean;
}

const state: SbState = {
  launchCalls: 0,
  connectOverCdpCalls: [],
  scrapingConnectCalls: [],
  scrapingReturnsNull: false,
};

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
    content: vi.fn().mockResolvedValue('<html><body>ok</body></html>'),
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
  const connectOverCDP = vi.fn().mockImplementation((wss: string) => {
    state.connectOverCdpCalls.push(wss);
    return Promise.resolve(makeBrowser());
  });
  const stub = { launch, connectOverCDP };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('../../../src/fetch/scraping-browser.js', () => ({
  connectScrapingBrowser: vi.fn().mockImplementation((opts: { wss: string | null | undefined }) => {
    state.scrapingConnectCalls.push({ wss: opts.wss });
    if (state.scrapingReturnsNull) return Promise.resolve(null);
    return Promise.resolve({ browser: makeBrowser(), close: vi.fn().mockResolvedValue(undefined) });
  }),
}));

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

function resetState() {
  state.launchCalls = 0;
  state.connectOverCdpCalls = [];
  state.scrapingConnectCalls = [];
  state.scrapingReturnsNull = false;
}

describe('hosted scraping-browser wiring (opt-in, OFF by default)', () => {
  beforeEach(() => {
    resetState();
    delete process.env.WIGOLO_SCRAPING_BROWSER_WSS;
    resetConfig();
  });
  afterEach(() => {
    delete process.env.WIGOLO_SCRAPING_BROWSER_WSS;
    resetConfig();
  });

  it('OFF by default: a normal fetch NEVER calls the scraping-browser connector (default acquire/launch path unchanged)', async () => {
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://plain.example', {});
    expect(result.method).toBe('browser');

    // The hosted rung was never reached; the fetch launched locally.
    expect(state.scrapingConnectCalls.length).toBe(0);
    expect(state.connectOverCdpCalls.length).toBe(0);
    expect(state.launchCalls).toBe(1);

    await pool.shutdown();
  });

  it('when scrapingBrowserWss is set, the fetch routes the wss through the connector (no local launch)', async () => {
    process.env.WIGOLO_SCRAPING_BROWSER_WSS = 'wss://user:pass@hosted.example/cdp';
    resetConfig();
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', {});
    expect(result.method).toBe('browser');

    // The configured wss was handed to the hosted connector...
    expect(state.scrapingConnectCalls.length).toBe(1);
    expect(state.scrapingConnectCalls[0].wss).toBe('wss://user:pass@hosted.example/cdp');
    // ...and no local browser was launched (the hosted browser drove the fetch).
    expect(state.launchCalls).toBe(0);

    await pool.shutdown();
  });

  it('graceful fallback: connector returns null (bad scheme / connect failure) → falls back to the local browser tier', async () => {
    process.env.WIGOLO_SCRAPING_BROWSER_WSS = 'wss://hosted.example/cdp';
    resetConfig();
    state.scrapingReturnsNull = true;
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', {});
    // The fetch still succeeds via the local tier — never hard-fails.
    expect(result.method).toBe('browser');

    expect(state.scrapingConnectCalls.length).toBe(1);
    // Fell back to a local launch.
    expect(state.launchCalls).toBe(1);

    await pool.shutdown();
  });

  it('an explicit cdpUrl takes precedence over scrapingBrowserWss (hosted rung not reached)', async () => {
    process.env.WIGOLO_SCRAPING_BROWSER_WSS = 'wss://hosted.example/cdp';
    resetConfig();
    const pool = new MultiBrowserPool();

    const result = await pool.fetchWithBrowser('https://blocked.example', {
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    });
    expect(result.method).toBe('browser');

    // The pinned CDP endpoint was used; the hosted rung was never consulted.
    expect(state.connectOverCdpCalls.length).toBe(1);
    expect(state.connectOverCdpCalls[0]).toBe('ws://127.0.0.1:9222/devtools/browser/abc');
    expect(state.scrapingConnectCalls.length).toBe(0);

    await pool.shutdown();
  });
});
