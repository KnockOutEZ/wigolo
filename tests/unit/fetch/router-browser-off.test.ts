import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import type { BrowserAcquirer, AcquireOutcome } from '../../../src/fetch/browser-acquire.js';
import { getAuthOptions } from '../../../src/fetch/auth.js';

/**
 * WHY (PR #724, CodeRabbit 4710534120): under WIGOLO_BROWSER=off an external
 * route (options.cdpUrl injected via useAuth, or scrapingBrowserWss) connects
 * to a browser this process never launches — the local readiness gate must not
 * block dispatch, so the fetch has to reach the pool (connectOverCDP / hosted
 * connector). Local-only requests must still fail with browser_disabled and
 * must never touch the pool.
 */

const FULL_HTML = `
<html><head><title>Test</title></head>
<body><p>${'Real content long enough to pass the empty check. '.repeat(5)}</p></body></html>
`.trim();

function makeHttpResult(): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html: FULL_HTML,
    contentType: 'text/html',
    statusCode: 200,
    headers: {},
  };
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'browser', headers: {} };
}

function makeAcquirer(outcome: AcquireOutcome): { acquirer: BrowserAcquirer; ensure: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(async () => outcome);
  const acquirer = { ensureBrowser: ensure } as unknown as BrowserAcquirer;
  return { acquirer, ensure };
}

describe('SmartRouter — WIGOLO_BROWSER=off vs external CDP route', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, WIGOLO_BROWSER: 'off' };
    resetConfig();
    httpClient = { fetch: vi.fn(async () => makeHttpResult()) };
    browserPool = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
    vi.mocked(getAuthOptions).mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('off + useAuth + external cdpUrl reaches the pool (not-ready gate skipped)', async () => {
    vi.mocked(getAuthOptions).mockResolvedValue({ cdpUrl: 'http://127.0.0.1:9222' });
    // Never ready — under off the acquirer can never report ready, so this
    // outcome proves the fetch skipped the not-ready block entirely.
    const { acquirer, ensure } = makeAcquirer('unavailable');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/protected', { useAuth: true });

    expect(ensure).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    const opts = vi.mocked(browserPool.fetchWithBrowser).mock.calls[0][1] as
      | { cdpUrl?: string }
      | undefined;
    expect(opts?.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(result.method).toBe('browser');
    expect('error' in result).toBe(false);
  });

  it('off + useAuth without cdpUrl (local route) fails with browser_disabled, pool untouched', async () => {
    const { acquirer } = makeAcquirer('unavailable');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/protected', { useAuth: true });

    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    const err = result as { error?: string; error_reason?: string; stage?: string; hint?: string };
    expect(err.error).toBe('browser_disabled');
    expect(err.stage).toBe('fetch');
    expect(`${err.error_reason ?? ''} ${err.hint ?? ''}`).toMatch(/WIGOLO_BROWSER/);
  });

  it('off + render_js:always (local escalation) fails with browser_disabled, pool untouched', async () => {
    const { acquirer } = makeAcquirer('unavailable');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/page', { renderJs: 'always' });

    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    const err = result as { error?: string; stage?: string };
    expect(err.error).toBe('browser_disabled');
    expect(err.stage).toBe('fetch');
  });

  it('off + external route where the pool throws bare browser_disabled -> structured stage error', async () => {
    vi.mocked(getAuthOptions).mockResolvedValue({ cdpUrl: 'http://127.0.0.1:9222' });
    // Simulates the CDP-fallback local launch (CodeRabbit 4712165809): the
    // not-ready gate was skipped for the external route, but the pool's own
    // off-guard threw a bare Error(code=browser_disabled) out of fetchWithBrowser.
    vi.mocked(browserPool.fetchWithBrowser).mockRejectedValue(
      Object.assign(new Error('browser tier is off on this host (WIGOLO_BROWSER=off)'), {
        code: 'browser_disabled',
      }),
    );
    const { acquirer } = makeAcquirer('unavailable');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/protected', { useAuth: true });

    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    const err = result as { error?: string; error_reason?: string; stage?: string; hint?: string };
    expect(err.error).toBe('browser_disabled');
    expect(err.stage).toBe('fetch');
    expect(err.error_reason).toMatch(/WIGOLO_BROWSER/);
    expect(`${err.hint ?? ''}`).toMatch(/WIGOLO_BROWSER/);
  });
});
