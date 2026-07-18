import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Browser-acquire mock — report the engine "ready" without a real install so
// browser-tier paths reach the mocked browserPool. On a browserless CI runner
// the real ensureBrowser() attempts an install and hangs past the test timeout.
// Tests needing the "unavailable" branch spy on their own instance to override.
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import {
  SmartRouter,
  stealthForBrowser,
  type HttpClient,
  type BrowserPoolInterface,
  type BrowserFetchArgs,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { getConfig } from '../../../src/config.js';

// A body that is BOTH a challenge shell (markers + skeleton) so the router's
// anti-bot escalation fires. Mirrors the interstitials used elsewhere.
const CHALLENGE_SHELL =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div class="cf-browser-verification"></div><div class="cf-turnstile"></div></body></html>';

const FULL_HTML =
  '<html><head><title>Test</title></head><body><p>' +
  'Real article content long enough to clear the empty-content threshold. '.repeat(6) +
  '</p></body></html>';

// A near-empty SPA shell (no challenge markers) — trips the empty-content
// heuristic (benign SPA render), which must NOT request stealth under auto.
const SPA_SHELL = '<html><head></head><body><div id="root"></div></body></html>';

function makeHttpResult(
  url: string,
  opts: Partial<{ html: string; statusCode: number }> = {},
): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url,
    finalUrl: url,
    html: opts.html ?? FULL_HTML,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
    headers: {},
  };
}

describe('stealthForBrowser (pure predicate)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it("'off' never requests stealth (even for an anti-bot escalation)", () => {
    process.env.WIGOLO_STEALTH = 'off';
    resetConfig();
    const cfg = getConfig();
    expect(stealthForBrowser(cfg, { antiBotEscalation: true })).toBe(false);
    expect(stealthForBrowser(cfg, { antiBotEscalation: false })).toBe(false);
  });

  it("'on' always requests stealth (both escalation kinds)", () => {
    process.env.WIGOLO_STEALTH = 'on';
    resetConfig();
    const cfg = getConfig();
    expect(stealthForBrowser(cfg, { antiBotEscalation: true })).toBe(true);
    expect(stealthForBrowser(cfg, { antiBotEscalation: false })).toBe(true);
  });

  it("'auto' requests stealth ONLY for an anti-bot/challenge escalation", () => {
    process.env.WIGOLO_STEALTH = 'auto';
    resetConfig();
    const cfg = getConfig();
    expect(stealthForBrowser(cfg, { antiBotEscalation: true })).toBe(true);
    // MUST-NOT-OVER-FIRE: a benign (non-anti-bot) browser fetch stays unhardened.
    expect(stealthForBrowser(cfg, { antiBotEscalation: false })).toBe(false);
  });
});

// End-to-end through the router: prove the ACTUAL escalation call sites pass
// the right stealth flag, so a refactor of the predicate wiring can't silently
// regress the contract.
describe('router threads stealth per escalation kind (auto)', () => {
  const originalEnv = process.env;

  let browserCalls: Array<{ url: string; stealth?: boolean }>;

  function makeBrowserPool(): BrowserPoolInterface {
    return {
      fetchWithBrowser: vi.fn(async (url: string, opts?: BrowserFetchArgs): Promise<RawFetchResult> => {
        browserCalls.push({ url, stealth: opts?.stealth });
        return {
          url,
          finalUrl: url,
          html: FULL_HTML,
          contentType: 'text/html',
          statusCode: 200,
          method: 'browser',
          headers: {},
        };
      }),
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_STEALTH = 'auto';
    process.env.WIGOLO_TLS_TIER = 'off';
    resetConfig();
    browserCalls = [];
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('MUST-FIRE: a 2xx challenge-shell escalation requests stealth', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url: string) => makeHttpResult(url, { html: CHALLENGE_SHELL, statusCode: 200 })),
    };
    const router = new SmartRouter({ httpClient, browserPool: makeBrowserPool() });
    await router.fetch('https://challenge.example/');
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0].stealth).toBe(true);
  });

  it('MUST-NOT-OVER-FIRE: a benign SPA-shell escalation does NOT request stealth', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url: string) => makeHttpResult(url, { html: SPA_SHELL, statusCode: 200 })),
    };
    const router = new SmartRouter({ httpClient, browserPool: makeBrowserPool() });
    await router.fetch('https://spa.example/');
    expect(browserCalls).toHaveLength(1);
    // Benign SPA render — the page is thin, not hostile. No hardening.
    expect(browserCalls[0].stealth).toBe(false);
  });

  it('MUST-FIRE: an anti-bot challenge body (tls off) escalation requests stealth', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url: string) => makeHttpResult(url, { html: CHALLENGE_SHELL, statusCode: 403 })),
    };
    const router = new SmartRouter({ httpClient, browserPool: makeBrowserPool() });
    await router.fetch('https://blocked.example/');
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0].stealth).toBe(true);
  });
});

describe('router stealth under off / on', () => {
  const originalEnv = process.env;
  let browserCalls: Array<{ stealth?: boolean }>;

  function makeBrowserPool(): BrowserPoolInterface {
    return {
      fetchWithBrowser: vi.fn(async (url: string, opts?: BrowserFetchArgs): Promise<RawFetchResult> => {
        browserCalls.push({ stealth: opts?.stealth });
        return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'browser', headers: {} };
      }),
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WIGOLO_TLS_TIER = 'off';
    resetConfig();
    browserCalls = [];
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it("'off': a challenge escalation does NOT request stealth", async () => {
    process.env.WIGOLO_STEALTH = 'off';
    resetConfig();
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url: string) => makeHttpResult(url, { html: CHALLENGE_SHELL, statusCode: 403 })),
    };
    const router = new SmartRouter({ httpClient, browserPool: makeBrowserPool() });
    await router.fetch('https://blocked.example/');
    expect(browserCalls[0].stealth).toBe(false);
  });

  it("'on': even a benign SPA-shell escalation requests stealth", async () => {
    process.env.WIGOLO_STEALTH = 'on';
    resetConfig();
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url: string) => makeHttpResult(url, { html: SPA_SHELL, statusCode: 200 })),
    };
    const router = new SmartRouter({ httpClient, browserPool: makeBrowserPool() });
    await router.fetch('https://spa.example/');
    expect(browserCalls[0].stealth).toBe(true);
  });
});
