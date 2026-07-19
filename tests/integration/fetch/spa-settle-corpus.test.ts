import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { BrowserPool } from '../../../src/fetch/browser-pool.js';
import { SmartRouter, type BrowserPoolInterface, type HttpClient } from '../../../src/fetch/router.js';
import { httpFetch } from '../../../src/fetch/http-client.js';
import { handleFetch } from '../../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { resetConfig } from '../../../src/config.js';
import { startCorpusServer, type CorpusServer } from './spa-settle-corpus/server.js';
import { ARTICLE_MARKER, NAV_MARKER } from './spa-settle-corpus/fixtures.js';

// Wall-clock bounds: tight locally, generous on CI (loaded runners).
// Module-scope on purpose: tests/setup.ts deletes CI inside each test's beforeEach, so this must read the real CI env at import time.
const SLACK_MS = process.env.CI ? 6000 : 1500;

let srv: CorpusServer;
let pool: BrowserPool;

beforeAll(async () => {
  srv = await startCorpusServer();
});
afterAll(async () => {
  await srv.close();
});
beforeEach(() => {
  process.env.PLAYWRIGHT_NAV_TIMEOUT_MS = '10000';
  process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS = '5000';
  resetConfig();
  pool = new BrowserPool();
});
afterEach(async () => {
  await pool.shutdown();
});

describe('SPA settle corpus (real browser)', () => {
  it('captures article on fast delayed-mount SPA (300ms)', async () => {
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/delayed?ms=300`);
    expect(r.html).toContain(ARTICLE_MARKER);
  }, 30000);

  it('captures article on medium delayed-mount SPA (1500ms)', async () => {
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/delayed?ms=1500`);
    expect(r.html).toContain(ARTICLE_MARKER);
  }, 30000);

  // CURRENT BUG: with PLAYWRIGHT_NAV_TIMEOUT_MS=10000 the current hydration
  // budget is min(8000, max(1500, 10000/4)) = 2500ms — probe gives up at ~3s
  // while the article mounts at 5s. After settle.ts the 6s shared cap covers it.
  it('captures article on slow delayed-mount SPA (5000ms) within budget', async () => {
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/delayed?ms=5000`);
    expect(r.html).toContain(ARTICLE_MARKER);
  }, 30000);

  it('returns bounded on nav-shell-forever (no hang)', async () => {
    const t0 = Date.now();
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/nav-shell`);
    const elapsed = Date.now() - t0;
    expect(r.html).toContain(NAV_MARKER); // best-available capture is fine…
    // …but the wait must be bounded: nav(≈0 local) + settle cap + slack.
    expect(elapsed).toBeLessThan(10000 + SLACK_MS);
  }, 30000);

  // CURRENT BUG (mode B): networkidle never fires → burns the full load timeout.
  // Current behavior is *bounded* by loadTimeoutMs but wastes it entirely; after
  // settle.ts, stability exits in ~1s. Tight bound expected to FAIL today.
  it('never-networkidle page with instant article settles fast', async () => {
    const t0 = Date.now();
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/never-idle`);
    const elapsed = Date.now() - t0;
    expect(r.html).toContain(ARTICLE_MARKER);
    expect(elapsed).toBeLessThan(3500 + SLACK_MS);
  }, 30000);

  it('instant static page settles fast (latency regression guard)', async () => {
    const t0 = Date.now();
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/instant`);
    const elapsed = Date.now() - t0;
    expect(r.html).toContain(ARTICLE_MARKER);
    expect(elapsed).toBeLessThan(3500 + SLACK_MS);
  }, 30000);

  it('ticker page settles despite perpetual small mutations', async () => {
    const t0 = Date.now();
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/ticker`);
    expect(r.html).toContain(ARTICLE_MARKER);
    expect(Date.now() - t0).toBeLessThan(10000 + SLACK_MS);
  }, 30000);

  it('code-heavy docs page captures pre/code content', async () => {
    const r = await pool.fetchWithBrowser(`${srv.baseUrl}/code-docs`);
    expect(r.html).toContain(ARTICLE_MARKER);
  }, 30000);
});

// End-to-end through the REAL handleFetch pipeline (router → browser pool →
// extraction), proving the completeness label threads all the way onto the
// public FetchOutput.content_completeness. render_js:'always' forces the
// browser tier — a static shell would not self-escalate from the HTTP tier.
describe('SPA settle corpus → handleFetch content_completeness', () => {
  let hfSrv: CorpusServer;
  let hfPool: BrowserPool;
  let router: SmartRouter;

  beforeAll(async () => {
    hfSrv = await startCorpusServer();
  });
  afterAll(async () => {
    await hfSrv.close();
  });
  beforeEach(() => {
    process.env.PLAYWRIGHT_NAV_TIMEOUT_MS = '10000';
    process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS = '5000';
    resetConfig();
    initDatabase(':memory:');
    hfPool = new BrowserPool();
    const httpClient: HttpClient = { fetch: (url, options) => httpFetch(url, options) };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: (url, options) => hfPool.fetchWithBrowser(url, options),
    };
    router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
  });
  afterEach(async () => {
    await hfPool.shutdown();
    closeDatabase();
  });

  it('nav-shell page → content_completeness shell/app_shell (has #root → genuine shell stays excluded)', async () => {
    const r = await handleFetch({ url: `${hfSrv.baseUrl}/nav-shell`, render_js: 'always' }, router);
    const out = r.ok ? r.data : ({ ...r } as never);
    expect(out.content_completeness?.level).toBe('shell');
    expect(out.content_completeness?.reason).toBe('app_shell');
  }, 30000);

  it('instant static page → content_completeness.level === "full"', async () => {
    const r = await handleFetch({ url: `${hfSrv.baseUrl}/instant`, render_js: 'always' }, router);
    const out = r.ok ? r.data : ({ ...r } as never);
    expect(out.content_completeness?.level).toBe('full');
  }, 30000);

  it('thin FRAMELESS page → content_completeness partial/thin_content (NOT shell)', async () => {
    // The refinement: a rendered-but-thin page with no frame (example.com / HN
    // shape) must NOT be labeled shell — it is not an un-rendered shell.
    const r = await handleFetch({ url: `${hfSrv.baseUrl}/thin-frameless`, render_js: 'always' }, router);
    const out = r.ok ? r.data : ({ ...r } as never);
    expect(out.content_completeness?.level).toBe('partial');
    expect(out.content_completeness?.reason).toBe('thin_content');
  }, 30000);
});
