import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../src/fetch/router.js';
import { ChallengeBlockedError } from '../../src/fetch/browser-pool.js';
import { httpFetch } from '../../src/fetch/http-client.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'extraction', 'article.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf-8');

let server: Server;
let baseUrl: string;
let router: SmartRouter;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      } else if (req.url === '/empty') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body></body></html>');
      } else if (req.url === '/challenge') {
        // A hard bot-protection interstitial: 403 + challenge markers, near-empty body.
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification"></div></body></html>');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(`http://localhost:${addr.port}`);
      }
    });
  });
}

function createRouter(): SmartRouter {
  const httpClient: HttpClient = {
    fetch: (url, options) => httpFetch(url, options),
  };

  const mockBrowserPool = {
    fetchWithBrowser: async () => {
      throw new Error('Browser not needed');
    },
  };

  return new SmartRouter(httpClient, mockBrowserPool);
}

describe('e2e: fetch tool', () => {
  beforeAll(async () => {
    baseUrl = await startServer();
  });

  afterAll(() => {
    closeDatabase();
    server.close();
  });

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
    router = createRouter();
  });

  it('full fetch returns title, markdown, metadata, and links', async () => {
    const __r_result = await handleFetch({ url: `${baseUrl}/article`, include_full_markdown: true }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.cached).toBe(false);
    expect(result.title).toContain('Building Modern Web Scrapers');
    expect(result.markdown).toBeTruthy();
    expect(result.markdown.length).toBeGreaterThan(100);
    expect(result.markdown).toContain('TypeScript');
    expect(result.url).toContain('/article');
    expect(result.links).toBeInstanceOf(Array);
  });

  it('second fetch returns cached: true', async () => {
    const url = `${baseUrl}/article`;
    const __r_first = await handleFetch({ url }, router);;
    const first = __r_first.ok ? __r_first.data : ({ ...__r_first } as any);
    expect(first.cached).toBe(false);
    expect(first.error).toBeUndefined();

    const __r_second = await handleFetch({ url, include_full_markdown: true }, router);;
    const second = __r_second.ok ? __r_second.data : ({ ...__r_second } as any);
    expect(second.cached).toBe(true);
    expect(second.title).toBe(first.title);
    expect(second.markdown).toContain('TypeScript');
  });

  it('section extraction returns only the requested section', async () => {
    const __r_result = await handleFetch(
      { url: `${baseUrl}/article`, section: 'Conclusion', include_full_markdown: true },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.markdown).toContain('start simple');
    expect(result.markdown).not.toContain('Why TypeScript for Web Scraping');
  });

  it('section extraction from cache returns only the requested section', async () => {
    const url = `${baseUrl}/article`;
    await handleFetch({ url }, router);

    const __r_result = await handleFetch({ url, section: 'Conclusion', include_full_markdown: true }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(true);
    expect(result.markdown).toContain('start simple');
  });

  it('max_chars limits markdown length', async () => {
    const __r_result = await handleFetch(
      { url: `${baseUrl}/article`, max_chars: 150 },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.markdown.length).toBeLessThanOrEqual(150);
  });

  it('non-existent URL returns error response without throwing', async () => {
    const __r_result = await handleFetch(
      { url: 'http://localhost:1/nonexistent' },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('invalid URL returns error response without throwing', async () => {
    const __r_result = await handleFetch(
      { url: 'not-a-valid-url' },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('render_js=never skips browser fallback', async () => {
    const __r_result = await handleFetch(
      { url: `${baseUrl}/article`, render_js: 'never' },
      router,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.title).toContain('Building Modern Web Scrapers');
  });

  it('metadata includes extracted description', async () => {
    const __r_result = await handleFetch({ url: `${baseUrl}/article` }, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.metadata).toBeDefined();
  });

  it('challenged page fast-fails with a blocked_by_challenge error object', async () => {
    // The HTTP tier gets a 403 challenge interstitial and escalates to the
    // browser tier, which fast-fails (ChallengeBlockedError). The tool surfaces
    // a structured blocked_by_challenge error the caller can branch on — the
    // same shape a `--json` invocation emits (ok:false → error object on stdout).
    const httpClient: HttpClient = { fetch: (url, options) => httpFetch(url, options) };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: async (url) => { throw new ChallengeBlockedError(url); },
    };
    const challengeRouter = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    const res = await handleFetch({ url: `${baseUrl}/challenge` }, challengeRouter);
    expect(res.ok).toBe(false);
    const err = res as { ok: false; error: string; error_reason: string; stage: string; hint?: string };
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.stage).toBe('fetch');
    expect(err.error_reason.toLowerCase()).toMatch(/bot protection|challenge page/);
    expect(err.hint).toMatch(/use_auth/);
  });
});
