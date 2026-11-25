import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../src/fetch/router.js';
import type { BrowserAcquirer, AcquireOutcome } from '../../src/fetch/browser-acquire.js';
import { BROWSER_INSTALLING_NOTE } from '../../src/fetch/browser-acquire.js';

/**
 * WHY: when the browser engine is still installing, the router deliberately
 * returns the best lower-tier body it already has plus an advisory note, rather
 * than blocking the call for minutes. handleFetch rebuilt the response field by
 * field and never copied `raw.warning`, so that degraded capture reached the
 * caller as a plain 200. An agent then trusted a JS shell as real content. These
 * tests pin the end-to-end contract: the note survives to FetchOutput, a shell
 * body is labelled `js_required`, and an ordinary fetch gains no such fields.
 */

const FULL_HTML = `
<html><head><title>Article</title></head>
<body>
  <main>
    <h1>Real Content</h1>
    <p>${'This page has substantial article content to clear the empty-content threshold. '.repeat(8)}</p>
  </main>
</body></html>
`.trim();

// Visible text is empty and no noscript hint exists, so the router treats this
// as an SPA shell and escalates to the browser tier.
const SPA_SHELL_HTML = `<html><head></head><body><div id="root"></div></body></html>`;

// Short but complete: no shell markers, no scripts, real prose. The router
// still escalates on length, but the body does not need JavaScript.
const SHORT_COMPLETE_HTML = `<html><head><title>Status</title></head><body><h1>Service status</h1><p>All systems operational.</p></body></html>`;

function makeHttpResult(html: string, url: string): Awaited<ReturnType<HttpClient['fetch']>> {
  return { url, finalUrl: url, html, contentType: 'text/html; charset=utf-8', statusCode: 200, headers: {} };
}

function makeAcquirer(outcome: AcquireOutcome): BrowserAcquirer {
  return { ensureBrowser: vi.fn(async () => outcome) } as unknown as BrowserAcquirer;
}

describe('handleFetch: router warning visibility', () => {
  const originalEnv = process.env;
  let browserPool: BrowserPoolInterface;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();
    initDatabase(':memory:');
    browserPool = {
      fetchWithBrowser: vi.fn(async () => {
        throw new Error('should not call browser');
      }),
    };
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('surfaces the router note and js_required when a shell is served before the browser is ready', async () => {
    const url = 'https://warning-test.example/app';
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult(SPA_SHELL_HTML, url)) };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: makeAcquirer('unavailable'),
    });

    const out = await handleFetch({ url, force_refresh: true } as any, router);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The note is what tells the caller the body is a placeholder.
    expect(out.data.warning).toBe(BROWSER_INSTALLING_NOTE);
    // And the flag lets a caller branch without parsing the note text.
    expect(out.data.js_required).toBe(true);
    // It is still an honest success: the bytes are the best available.
    expect(out.data.fetch_method).toBe('http');
    expect(out.data.markdown).not.toContain('Real Content');
  });

  it('does not label a short but complete page as js_required', async () => {
    // Regression guard for the false positive that a length-only check causes:
    // contentAppearsEmpty() is a routing predicate, and a short body is enough
    // to escalate. That is not enough to claim the page needs JavaScript.
    const url = 'https://warning-test.example/status';
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult(SHORT_COMPLETE_HTML, url)) };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: makeAcquirer('unavailable'),
    });

    const out = await handleFetch({ url, force_refresh: true } as any, router);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The advisory still applies: the browser was wanted and is not ready.
    expect(out.data.warning).toBe(BROWSER_INSTALLING_NOTE);
    // But the body is complete, so it must not be flagged as a JS shell.
    expect('js_required' in out.data).toBe(false);
    expect(out.data.markdown).toContain('All systems operational');
  });

  it('omits warning and js_required on an ordinary HTTP fetch', async () => {
    const url = 'https://warning-test.example/plain';
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult(FULL_HTML, url)) };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: makeAcquirer('ready'),
    });

    const out = await handleFetch({ url, force_refresh: true } as any, router);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Absent, not empty string: callers branch on presence.
    expect('warning' in out.data).toBe(false);
    expect('js_required' in out.data).toBe(false);
  });

  it('does not replay a warning on a later cache hit', async () => {
    const url = 'https://warning-test.example/cached';
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult(SPA_SHELL_HTML, url)) };
    const router = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: makeAcquirer('unavailable'),
    });

    const first = await handleFetch({ url, force_refresh: true } as any, router);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.warning).toBe(BROWSER_INSTALLING_NOTE);

    // A cached capture is a different response shape; the note describes the
    // live routing decision, so it must not be resurrected from the cache row.
    const second = await handleFetch({ url } as any, router);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.cached).toBe(true);
    expect('warning' in second.data).toBe(false);
  });
});