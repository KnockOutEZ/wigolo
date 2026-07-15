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
 * WHY: D3 — every browser-tier escalation must flow through the acquiring
 * wrapper so a missing browser lazily installs instead of hard-failing, and no
 * HTTP-only fetch ever touches the installer. These tests pin the threading
 * (call-site sweep), the wait-budget fallback-to-lower-tier behaviour, and the
 * negative: HTTP success never invokes acquisition.
 */

const FULL_HTML = `
<html><head><title>Test</title></head>
<body><p>${'Real content long enough to pass the empty check. '.repeat(5)}</p></body></html>
`.trim();

const SPA_SHELL_HTML = `<html><head></head><body><div id="root"></div></body></html>`;

function makeHttpResult(html = FULL_HTML, statusCode = 200): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html,
    contentType: 'text/html',
    statusCode,
    headers: {},
  };
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'playwright', headers: {} };
}

/** A test double for the acquirer whose outcome + call count we control. */
function makeAcquirer(outcome: AcquireOutcome): { acquirer: BrowserAcquirer; ensure: ReturnType<typeof vi.fn> } {
  const ensure = vi.fn(async () => outcome);
  const acquirer = { ensureBrowser: ensure } as unknown as BrowserAcquirer;
  return { acquirer, ensure };
}

describe('SmartRouter — lazy browser acquisition threading (D3)', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
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

  it('NEGATIVE: an HTTP-tier-success fetch never invokes the acquirer', async () => {
    const { acquirer, ensure } = makeAcquirer('ready');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/page');

    expect(result.method).toBe('http');
    expect(ensure).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('NEGATIVE: renderJs:never (HTTP-only) never invokes the acquirer even when HTTP fails', async () => {
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('boom'));
    const { acquirer, ensure } = makeAcquirer('ready');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    await expect(router.fetch('https://x.example/', { renderJs: 'never' })).rejects.toThrow('boom');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('NEGATIVE: mode:cache (HTTP-only) never invokes the acquirer', async () => {
    const { acquirer, ensure } = makeAcquirer('ready');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    await router.fetch('https://example.com/page', { mode: 'cache' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('proceeds to the browser tier when acquisition returns ready (render_js:always)', async () => {
    const { acquirer, ensure } = makeAcquirer('ready');
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

    const result = await router.fetch('https://example.com/page', { renderJs: 'always' });
    expect(ensure).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });

  describe('call-site sweep: every escalation path routes through the acquirer', () => {
    it('render_js:always path', async () => {
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      await router.fetch('https://example.com/page', { renderJs: 'always' });
      expect(ensure).toHaveBeenCalledOnce();
    });

    it('useAuth path', async () => {
      vi.mocked(getAuthOptions).mockResolvedValue({ storageStatePath: '/tmp/s.json' });
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      await router.fetch('https://example.com/protected', { useAuth: true });
      expect(ensure).toHaveBeenCalledOnce();
    });

    it('actions path', async () => {
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      await router.fetch('https://example.com/page', { actions: [{ type: 'click', selector: '.b' }] });
      expect(ensure).toHaveBeenCalledOnce();
    });

    it('preferPlaywright (known-SPA marked) path via browserOrHttpForBinary', async () => {
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://react.dev/learn'));
      await router.fetch('https://react.dev/learn');
      expect(ensure).toHaveBeenCalledOnce();
    });

    it('SPA-shell detection path', async () => {
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      await router.fetch('https://spa.example/page');
      expect(ensure).toHaveBeenCalledOnce();
    });

    it('anti-bot challenge-body (tls disabled) escalation path', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();
      // 403 + challenge body → escalates to browser (tls tier disabled).
      vi.mocked(httpClient.fetch).mockResolvedValue(
        makeHttpResult('<html><body>Just a moment... checking your browser cf-challenge</body></html>', 403),
      );
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      await router.fetch('https://blocked.example/');
      expect(ensure).toHaveBeenCalledOnce();
      delete process.env.WIGOLO_TLS_TIER;
      resetConfig();
    });

    it('failure-threshold escalation path', async () => {
      vi.mocked(httpClient.fetch).mockRejectedValue(new Error('refused'));
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });
      for (let i = 0; i < 2; i++) {
        await expect(router.fetch(`https://fail.example/${i}`)).rejects.toThrow();
      }
      await router.fetch('https://fail.example/final');
      expect(ensure).toHaveBeenCalledOnce();
    });
  });

  describe('acquisition unavailable (budget exceeded / failed)', () => {
    it('returns the lower-tier HTTP content with an actionable note when a fallback exists (SPA-shell path)', async () => {
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));
      const { acquirer } = makeAcquirer('unavailable');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

      const result = await router.fetch('https://spa.example/page') as RawFetchResult;

      // Never hit the browser — it's not installed.
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      // Returned the lower-tier HTTP shell (best available).
      expect(result.method).toBe('http');
      expect(result.html).toBe(SPA_SHELL_HTML);
      // With the actionable, capability-language note.
      expect(result.warning).toMatch(/browser engine installing/);
      expect(result.warning).toMatch(/wigolo warmup --browser/);
    });

    it('fails with an actionable error naming `wigolo warmup --browser` when no lower-tier content exists (render_js:always)', async () => {
      const { acquirer } = makeAcquirer('unavailable');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

      const result = await router.fetch('https://example.com/page', { renderJs: 'always' });

      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect('error' in result).toBe(true);
      const err = result as { error: string; error_reason: string; stage: string; hint?: string };
      expect(err.stage).toBe('fetch');
      expect(err.hint ?? err.error_reason).toMatch(/wigolo warmup --browser/);
      // Capability language — never leak the library name.
      expect(`${err.error_reason} ${err.hint ?? ''}`.toLowerCase()).not.toMatch(/playwright|chromium/);
    });

    it('stealth-mode escalation goes through the acquirer and, when unavailable, returns the static content with the note', async () => {
      // Stealth: static fetch is thin → escalates. When the browser can't be
      // acquired in time, the static content is the best lower tier and must be
      // returned with the actionable note (never a hard playwright_not_installed).
      const thinHtml = '<html><body>x</body></html>';
      const httpFetcher = vi.fn(async () => ({ url: 'https://s.example/', html: thinHtml, text: 'x' }));
      const playwrightFetcher = vi.fn(async () => ({ html: FULL_HTML, text: 'full' }));
      const { acquirer, ensure } = makeAcquirer('unavailable');
      const router = new SmartRouter({
        httpFetcher,
        browserPool,
        pdfProbe: async () => false,
        browserAcquirer: acquirer,
        playwrightFetcher,
      });

      const result = await router.fetch('https://s.example/', { mode: 'stealth' }) as RawFetchResult;

      expect(ensure).toHaveBeenCalledOnce();
      // Never launched the browser tier — it's not installed.
      expect(playwrightFetcher).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
      expect(result.html).toBe(thinHtml);
      expect(result.warning).toMatch(/browser engine installing/);
    });

    it('stealth-mode escalation proceeds to the browser tier when acquisition is ready', async () => {
      const httpFetcher = vi.fn(async () => ({ url: 'https://s.example/', html: '<html><body>x</body></html>', text: 'x' }));
      const playwrightFetcher = vi.fn(async () => ({ html: FULL_HTML, text: 'full' }));
      const { acquirer, ensure } = makeAcquirer('ready');
      const router = new SmartRouter({
        httpFetcher,
        browserPool,
        pdfProbe: async () => false,
        browserAcquirer: acquirer,
        playwrightFetcher,
      });

      const result = await router.fetch('https://s.example/', { mode: 'stealth' }) as RawFetchResult;

      expect(ensure).toHaveBeenCalledOnce();
      expect(playwrightFetcher).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
      expect(result.escalated).toBe(true);
    });

    it('fails with an actionable error on the failure-threshold path (no fallback in hand)', async () => {
      vi.mocked(httpClient.fetch).mockRejectedValue(new Error('refused'));
      const { acquirer } = makeAcquirer('unavailable');
      const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: acquirer });

      for (let i = 0; i < 2; i++) {
        await expect(router.fetch(`https://fail.example/${i}`)).rejects.toThrow();
      }
      const result = await router.fetch('https://fail.example/final');
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect('error' in result).toBe(true);
      expect((result as { hint?: string; error_reason: string }).hint ?? '').toMatch(/wigolo warmup --browser/);
    });
  });
});
