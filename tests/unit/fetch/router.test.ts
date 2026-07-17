import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// We import SmartRouter dynamically after mocking auth to avoid real fs checks
// Auth mock — getAuthOptions returns null by default
vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Browser-acquire mock — every router (injected or the internal default) reports
// the engine "ready" without a real install. On a browserless CI runner the real
// BrowserAcquirer.ensureBrowser() attempts an install and hangs past the test
// timeout; here browser-tier paths reach the mocked browserPool instead. Tests
// that need the "unavailable" branch spy on their own instance to override this.
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface, TlsFetcher } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { getAuthOptions } from '../../../src/fetch/auth.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';
import { BrowserAcquirer, BROWSER_INSTALLING_NOTE } from '../../../src/fetch/browser-acquire.js';

const FULL_HTML = `
<html><head><title>Test</title></head>
<body>
  <p>${'This is real content that is long enough to pass the empty check. '.repeat(5)}</p>
</body></html>
`.trim();

// SPA shell that contentAppearsEmpty() detects as empty
const SPA_SHELL_HTML = `<html><head></head><body><div id="root"></div></body></html>`;

function makeHttpResult(html = FULL_HTML): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html,
    contentType: 'text/html',
    statusCode: 200,
    headers: {},
  };
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: FULL_HTML,
    contentType: 'text/html',
    statusCode: 200,
    method: 'playwright',
    headers: {},
  };
}

// A BrowserAcquirer stub that reports the engine is ready without touching the
// installer/launcher. The main-block tests inject this so the render_js:'always'
// path exercises the mocked browserPool.fetchWithBrowser rather than attempting
// a real browser acquire — which on a browserless CI runner installs/launches
// and times out.
function readyAcquirer(): BrowserAcquirer {
  const acquirer = new BrowserAcquirer();
  vi.spyOn(acquirer, 'ensureBrowser').mockResolvedValue('ready');
  return acquirer;
}

describe('SmartRouter', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();

    httpClient = {
      fetch: vi.fn(async () => makeHttpResult()),
    };

    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };

    // Inject a non-PDF probe so the shared router never issues a real network
    // HEAD when the browser-bound path runs (dedicated PDF tests inject their
    // own probe). Keeps these unit tests hermetic.
    router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, browserAcquirer: readyAcquirer() });

    vi.mocked(getAuthOptions).mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('routes to HTTP by default for unknown domains', async () => {
    const result = await router.fetch('https://example.com/page');

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('routes to Playwright when render_js is "always"', async () => {
    const result = await router.fetch('https://example.com/page', { renderJs: 'always' });

    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('routes to HTTP only when render_js is "never"', async () => {
    const result = await router.fetch('https://example.com/page', { renderJs: 'never' });

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('does not fall back to Playwright when render_js is "never" and HTTP fails', async () => {
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Network error'));

    await expect(router.fetch('https://example.com/page', { renderJs: 'never' })).rejects.toThrow('Network error');
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('falls back to Playwright after BROWSER_FALLBACK_THRESHOLD HTTP failures for a domain', async () => {
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Connection refused'));

    const threshold = 3;

    // First (threshold - 1) calls should fail with HTTP error
    for (let i = 0; i < threshold - 1; i++) {
      await expect(router.fetch(`https://failing.com/page${i}`)).rejects.toThrow();
    }

    // threshold-th call should trigger fallback to Playwright
    const result = await router.fetch('https://failing.com/final');
    expect(result.method).toBe('playwright');
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
  });

  it('routes to Playwright for SPA shell content — content-based detection', async () => {
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));

    const result = await router.fetch('https://spa.com/page');

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });

  it('marks domain for Playwright after SPA shell detection', async () => {
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));

    // First call triggers detection and marks domain
    await router.fetch('https://spa-domain.com/page1');

    // Reset mock to return real content — but domain is already marked
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(FULL_HTML));
    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://spa-domain.com/page2'));

    const result = await router.fetch('https://spa-domain.com/page2');

    // Second call should go straight to Playwright without HTTP
    expect(result.method).toBe('playwright');
    // httpClient was only used on first call (SPA detection)
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('render_js "auto" triggers full detection logic', async () => {
    // With good content, HTTP should be used
    const result = await router.fetch('https://example.com/page', { renderJs: 'auto' });

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('routes auth requests to Playwright', async () => {
    const result = await router.fetch('https://example.com/protected', { useAuth: true });

    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  describe('binary-download pre-sniff (PDF routing)', () => {
    function makePdfHttpResult(url: string): Awaited<ReturnType<HttpClient['fetch']>> {
      return {
        url,
        finalUrl: url,
        html: '',
        contentType: 'application/pdf',
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        rawBuffer: Buffer.from('%PDF-1.4 stub'),
      };
    }

    it('routes a .pdf URL to HTTP even on a preferPlaywright (known-SPA) domain', async () => {
      // WHY: a binary download must be buffered by the byte-tier, never handed
      // to a browser that treats a PDF response as a download and hard-errors.
      // react.dev is in KNOWN_SPA_DOMAINS → starts preferPlaywright=true.
      const url = 'https://react.dev/whitepaper.pdf';
      vi.mocked(httpClient.fetch).mockResolvedValue(makePdfHttpResult(url));

      const result = await router.fetch(url);

      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('render_js:"always" on a .pdf URL still goes to the browser (explicit override wins)', async () => {
      // The pre-sniff must not hijack an explicit browser request.
      const url = 'https://example.com/report.pdf';

      const result = await router.fetch(url, { renderJs: 'always' });

      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('playwright');
    });

    it('an extensionless PDF (application/pdf, empty html + rawBuffer) does NOT escalate to the browser as an SPA shell', async () => {
      // WHY: extensionless PDF URLs (e.g. arxiv.org/pdf/1706.03762) slip past
      // the extension pre-sniff and reach the HTTP tier, which returns an empty
      // html + rawBuffer. The old SPA-shell check saw empty html and escalated
      // to the browser, which hard-errors with "Download is starting". A PDF
      // response must be recognised by its content-type and returned as-is.
      const url = 'https://arxiv-clone.test/pdf/1706.03762';
      vi.mocked(httpClient.fetch).mockResolvedValue({
        url,
        finalUrl: url,
        html: '',
        contentType: 'application/pdf',
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        rawBuffer: Buffer.from('%PDF-1.7 real pdf bytes'),
      });

      const result = await router.fetch(url);

      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
      expect(result.rawBuffer).toBeDefined();
      expect(result.contentType).toBe('application/pdf');
    });

    it('recognises a PDF by magic bytes when the server omits the content-type', async () => {
      // Some servers return octet-stream / no content-type for a PDF. A
      // %PDF- magic-bytes body must still be treated as a completed byte-tier
      // result, never re-routed to the browser as thin content.
      const url = 'https://files.test/download/doc-12345';
      vi.mocked(httpClient.fetch).mockResolvedValue({
        url,
        finalUrl: url,
        html: '',
        contentType: 'application/octet-stream',
        statusCode: 200,
        headers: { 'content-type': 'application/octet-stream' },
        rawBuffer: Buffer.from('%PDF-1.4 octet stream pdf'),
      });

      const result = await router.fetch(url);

      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('probes content-type before the browser tier so an extensionless PDF on a preferPlaywright domain routes to HTTP', async () => {
      // WHY: a preferPlaywright domain (known-SPA / prior escalation) sends the
      // extensionless PDF URL straight to the browser, which hard-errors. A
      // cheap content-type probe before the browser dispatch reroutes any PDF
      // — extension or not — to the byte tier.
      const url = 'https://react.dev/papers/whitepaper-2024';
      const pdfProbe = vi.fn(async () => true);
      const probingRouter = new SmartRouter({ httpClient, browserPool, pdfProbe });
      vi.mocked(httpClient.fetch).mockResolvedValue({
        url,
        finalUrl: url,
        html: '',
        contentType: 'application/pdf',
        statusCode: 200,
        headers: { 'content-type': 'application/pdf' },
        rawBuffer: Buffer.from('%PDF-1.5 spa domain pdf'),
      });

      const result = await probingRouter.fetch(url);

      expect(pdfProbe).toHaveBeenCalledOnce();
      expect(pdfProbe.mock.calls[0][0]).toBe(url);
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('does NOT probe or reroute a normal HTML fetch on a preferPlaywright domain', async () => {
      // Regression guard: the content-type probe must only run on the browser
      // dispatch path and, when it reports non-PDF, the browser tier is used
      // unchanged. A normal known-SPA HTML page still renders in the browser.
      const url = 'https://react.dev/learn';
      const pdfProbe = vi.fn(async () => false);
      const probingRouter = new SmartRouter({ httpClient, browserPool, pdfProbe });
      vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult(url));

      const result = await probingRouter.fetch(url);

      expect(result.method).toBe('playwright');
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    });
  });

  it('records domain routing decisions', async () => {
    await router.fetch('https://stats.com/page');

    const stats = router.getDomainStats('stats.com');
    expect(stats).toBeDefined();
  });

  it('handles HTTP failure → Playwright fallback in a single call', async () => {
    // Pre-mark the domain by hitting the threshold
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Unreachable'));

    const threshold = 3;

    // Build up failure count to threshold - 1
    for (let i = 0; i < threshold - 1; i++) {
      await expect(router.fetch('https://fallback.com/pre')).rejects.toThrow();
    }

    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://fallback.com/final'));

    // This call should hit threshold, mark domain, and return playwright result
    const result = await router.fetch('https://fallback.com/final');

    expect(result.method).toBe('playwright');
    expect(result.url).toBe('https://fallback.com/final');
  });
});

describe('SmartRouter --- actions routing', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();

    httpClient = {
      fetch: vi.fn(async () => makeHttpResult()),
    };

    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };

    router = new SmartRouter(httpClient, browserPool);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('routes to Playwright when actions are present, even with renderJs=auto', async () => {
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('routes to Playwright when actions are present, even with renderJs=never', async () => {
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { renderJs: 'never', actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('does not force Playwright when actions array is empty', async () => {
    const result = await router.fetch('https://example.com/page', { actions: [] });
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('does not force Playwright when actions is undefined', async () => {
    const result = await router.fetch('https://example.com/page', { actions: undefined });
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('passes actions through to fetchWithBrowser', async () => {
    const actions = [
      { type: 'wait_for' as const, selector: '.loaded', timeout: 3000 },
      { type: 'click' as const, selector: '.btn' },
    ];
    await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ actions }),
    );
  });

  it('routes to Playwright for actions + useAuth combined', async () => {
    vi.mocked(getAuthOptions).mockResolvedValue({ storageStatePath: '/tmp/state.json' });
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { useAuth: true, actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('passes actions alongside screenshot option', async () => {
    const actions = [{ type: 'screenshot' as const }];
    await router.fetch('https://example.com/page', { actions, screenshot: true });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ actions, screenshot: true }),
    );
  });

  it('handles multiple action types in a single call', async () => {
    const actions = [
      { type: 'wait_for' as const, selector: '.banner' },
      { type: 'click' as const, selector: '.dismiss' },
      { type: 'wait' as const, ms: 500 },
      { type: 'scroll' as const, direction: 'down' as const, amount: 200 },
      { type: 'screenshot' as const },
    ];
    const result = await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });

  it('routes known-SPA domains straight to Playwright on first visit', async () => {
    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(
      makeBrowserResult('https://react.dev/learn'),
    );
    const result = await router.fetch('https://react.dev/learn');
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });

  it('routes SPA subdomains (docs.react.dev) the same way', async () => {
    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(
      makeBrowserResult('https://docs.react.dev/intro'),
    );
    const result = await router.fetch('https://docs.react.dev/intro');
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('does NOT pre-mark unrelated domains', async () => {
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult());
    const result = await router.fetch('https://example.com/page');
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(result.method).toBe('http');
  });
});

describe('SmartRouter --- signal forwarding', () => {
  it('forwards signal to the HTTP client', async () => {
    const sig = new AbortController().signal;
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult()) };
    const browserPool: BrowserPoolInterface = { fetchWithBrowser: vi.fn() };
    const router = new SmartRouter(httpClient, browserPool);
    await router.fetch('https://example.com', { renderJs: 'never', signal: sig });
    expect(httpClient.fetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ signal: sig }));
  });

  it('forwards signal to the browser pool', async () => {
    const sig = new AbortController().signal;
    const httpClient: HttpClient = { fetch: vi.fn() };
    const browserPool: BrowserPoolInterface = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
    const router = new SmartRouter(httpClient, browserPool);
    await router.fetch('https://example.com', { renderJs: 'always', signal: sig });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ signal: sig }));
  });

  it('forwards signal to the TLS-impersonation tier (tls-first path)', async () => {
    // WIGOLO_TLS_TIER=on makes the auto path try the TLS tier before HTTP,
    // so the injected tlsFetcher receives the request directly. Asserting the
    // signal reaches it closes the abandoned-socket leak on the TLS tier.
    const originalTlsTier = process.env.WIGOLO_TLS_TIER;
    process.env.WIGOLO_TLS_TIER = 'on';
    resetConfig();
    try {
      const sig = new AbortController().signal;
      const tlsFetcher: TlsFetcher = vi.fn(async (url: string) => ({
        url, finalUrl: url, html: '<html></html>', contentType: 'text/html', statusCode: 200, headers: {},
      }));
      const httpClient: HttpClient = { fetch: vi.fn() };
      const browserPool: BrowserPoolInterface = { fetchWithBrowser: vi.fn() };
      const router = new SmartRouter({ httpClient, browserPool, tlsFetcher });
      await router.fetch('https://example.com', { signal: sig });
      expect(tlsFetcher).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ signal: sig }));
    } finally {
      if (originalTlsTier === undefined) delete process.env.WIGOLO_TLS_TIER;
      else process.env.WIGOLO_TLS_TIER = originalTlsTier;
      resetConfig();
    }
  });
});

describe('SmartRouter: browser-tier challenge → blocked_by_challenge StageError', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  function build(browserFetcher: BrowserPoolInterface['fetchWithBrowser']) {
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult()) };
    const browserPool: BrowserPoolInterface = { fetchWithBrowser: vi.fn(browserFetcher) };
    return new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
  }

  it('maps a ChallengeBlockedError from the render_js:always path to a blocked_by_challenge stage error', async () => {
    const router = build(async (url: string) => {
      throw new ChallengeBlockedError(url);
    });
    const result = await router.fetch('https://blocked.example/', { renderJs: 'always' });
    expect('error' in result).toBe(true);
    const err = result as { error: string; error_reason: string; stage: string; hint?: string };
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.stage).toBe('fetch');
    // Capability language — names the site's bot protection.
    expect(err.error_reason.toLowerCase()).toMatch(/bot protection|challenge page/);
    expect(err.hint).toMatch(/use_auth/);
  });

  it('maps a ChallengeBlockedError from the auto/SPA-shell escalation path', async () => {
    // HTTP returns an empty SPA shell → escalates to the browser, which throws.
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(SPA_SHELL_HTML)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url); }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example/');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('blocked_by_challenge');
  });

  it('does NOT swallow non-challenge browser errors (they still throw)', async () => {
    const router = build(async () => { throw new Error('some other browser crash'); });
    await expect(router.fetch('https://x.example/', { renderJs: 'always' })).rejects.toThrow('some other browser crash');
  });

  it('SUCCESS-RETURN GUARD: fetchWithBrowser returning a still-challenge result (403 + cf-mitigated) → blocked_by_challenge, never content', async () => {
    // The browser pool can return (not throw) a still-challenge result — e.g. a
    // modern-CF interstitial that reports 403 + cf-mitigated + a challenge body.
    // The success-return guard must map it to blocked_by_challenge so the shell
    // never leaks as content.
    const modernCfShell =
      '<html><head><title>Verify</title></head><body>' +
      '<div id="challenge-running">Verifying you are human.</div>' +
      '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=x"></script>' +
      '</body></html>';
    const router = build(async (url: string): Promise<RawFetchResult> => ({
      url,
      finalUrl: url,
      html: modernCfShell,
      contentType: 'text/html',
      statusCode: 403,
      method: 'playwright',
      headers: { 'cf-mitigated': 'challenge' },
    }));
    const result = await router.fetch('https://blocked.example/', { renderJs: 'always' });
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('blocked_by_challenge');
  });

  it('SUCCESS-RETURN GUARD: a CLEARED modern-CF result (browser normalised to 200, cf-mitigated dropped) passes through as content', async () => {
    // After the challenge clears, the browser pool normalises the result to 200
    // and drops the stale cf-mitigated header. The guard must NOT fire on it.
    const router = build(async (url: string): Promise<RawFetchResult> => ({
      url,
      finalUrl: url,
      html: FULL_HTML,
      contentType: 'text/html',
      statusCode: 200,
      method: 'playwright',
      headers: { server: 'cloudflare' },
    }));
    const result = await router.fetch('https://blocked.example/', { renderJs: 'always' });
    expect('error' in result).toBe(false);
    expect((result as RawFetchResult).method).toBe('playwright');
    expect((result as RawFetchResult).html).toContain('real content');
  });

  it('SUCCESS-RETURN GUARD: a normal 200 content result passes through unchanged', async () => {
    const router = build(async (url: string) => makeBrowserResult(url));
    const result = await router.fetch('https://ok.example/', { renderJs: 'always' });
    expect('error' in result).toBe(false);
    expect((result as RawFetchResult).method).toBe('playwright');
  });
});

// A DataDome-style interstitial served at HTTP 200: challenge markers PLUS a
// near-empty challenge skeleton. Must NEVER be returned as fetch content.
const DATADOME_SHELL_200 =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div class="dd-loader"></div><script>window._dd_s = 1;</script></body></html>';
// A 200 article whose prose merely quotes challenge marker strings.
const ARTICLE_QUOTING_MARKERS_200 =
  '<html><head><title>How bot walls work</title></head><body><article>' +
  ('The interstitial sets _cfChlOpt and shows "Just a moment" while the ' +
    'dd-loader sensor runs. This is a full explanation for engineers. ').repeat(30) +
  '</article></body></html>';

describe('SmartRouter: 200 challenge shell (P0 long-tail #5)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3', WIGOLO_TLS_TIER: 'off' };
    resetConfig();
    vi.mocked(getAuthOptions).mockResolvedValue(null);
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('MUST-FIRE: auto mode, HTTP 200 shell escalates to the browser (does not fail at HTTP tier)', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(DATADOME_SHELL_200)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example/');
    // Escalated to the browser and returned the browser's real content.
    expect(browserPool.fetchWithBrowser).toHaveBeenCalled();
    expect('error' in result).toBe(false);
    expect((result as RawFetchResult).method).toBe('playwright');
  });

  it('MUST-FIRE: auto mode, HTTP 200 shell that persists in the browser → blocked_by_challenge', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(DATADOME_SHELL_200)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url); }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example/');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('blocked_by_challenge');
  });

  it('MUST-FIRE: render_js:never, HTTP 200 shell → blocked_by_challenge StageError, never the shell markdown', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(DATADOME_SHELL_200)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example/', { renderJs: 'never' });
    // http-only path must never touch the browser AND must not return the shell.
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect('error' in result).toBe(true);
    const err = result as { error: string; error_reason: string; stage: string; hint?: string };
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.stage).toBe('fetch');
    expect(err.error_reason.toLowerCase()).toMatch(/bot protection|challenge page/);
  });

  it('MUST-NOT-FIRE: auto mode, 200 article quoting markers returns content, no escalation', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(ARTICLE_QUOTING_MARKERS_200)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://news.example/article');
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect('error' in result).toBe(false);
    expect((result as RawFetchResult).html).toContain('How bot walls work');
  });

  it('MUST-NOT-FIRE: auto mode, plain 200 SPA shell (no markers) uses the SPA path, not the challenge error', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(SPA_SHELL_HTML)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://spa.example/');
    // SPA escalation returns the browser's real content, NOT a challenge error.
    expect(browserPool.fetchWithBrowser).toHaveBeenCalled();
    expect('error' in result).toBe(false);
    expect((result as RawFetchResult).method).toBe('playwright');
  });
});

describe('SmartRouter: browser-unavailable fallback must not leak a challenge shell', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3', WIGOLO_TLS_TIER: 'off' };
    resetConfig();
    vi.mocked(getAuthOptions).mockResolvedValue(null);
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  // A BrowserAcquirer stub that always reports the engine is not ready, so the
  // browserFetch fallback branch is exercised.
  function unavailableAcquirer(): BrowserAcquirer {
    const acquirer = new BrowserAcquirer();
    vi.spyOn(acquirer, 'ensureBrowser').mockResolvedValue('unavailable');
    return acquirer;
  }

  it('MUST-FIRE: 200 shell escalates, browser unavailable → blocked_by_challenge (never the shell html)', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(DATADOME_SHELL_200)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: unavailableAcquirer(),
    });
    const result = await router.fetch('https://blocked.example/');
    // The browser could not be acquired, so the shell would have been the
    // fallback — the guard must convert it to a structured error instead.
    expect('error' in result).toBe(true);
    const err = result as { error: string; stage: string; error_reason: string };
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.stage).toBe('fetch');
    // The interstitial markdown must never surface.
    expect(JSON.stringify(result)).not.toContain('dd-loader');
  });

  it('MUST-FIRE: 403 challenge-body escalation, browser unavailable → blocked_by_challenge (pre-existing site, new contract)', async () => {
    const CHALLENGE_403 =
      '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification"></div></body></html>';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => ({
        url: 'https://blocked.example/',
        finalUrl: 'https://blocked.example/',
        html: CHALLENGE_403,
        contentType: 'text/html',
        statusCode: 403,
        headers: {},
      })),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: unavailableAcquirer(),
    });
    const result = await router.fetch('https://blocked.example/');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toBe('blocked_by_challenge');
    expect(JSON.stringify(result)).not.toContain('cf-browser-verification');
  });

  it('MUST-NOT-FIRE: browser unavailable + legit lower-tier content → content returned WITH installing warning', async () => {
    // A known-SPA domain returns thin-but-legit content (empty SPA shell, no
    // challenge markers): the SPA escalation fires, the browser is unavailable,
    // and the fallback (the lower-tier content) must pass through untouched
    // with the installing note — the guard must not intercept it.
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeHttpResult(SPA_SHELL_HTML)),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: unavailableAcquirer(),
    });
    const result = await router.fetch('https://spa.example/');
    expect('error' in result).toBe(false);
    const raw = result as RawFetchResult;
    expect(raw.html).toBe(SPA_SHELL_HTML);
    expect(raw.warning).toBe(BROWSER_INSTALLING_NOTE);
  });
});
