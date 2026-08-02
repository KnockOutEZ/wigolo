import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';
import { extractContent } from '../../src/extraction/pipeline.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent, getCachedContent, isExpired } from '../../src/cache/store.js';
import { resetConfig } from '../../src/config.js';
import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../src/fetch/router.js';
import { ChallengeBlockedError } from '../../src/fetch/browser-pool.js';
import { handleFetch } from '../../src/tools/fetch.js';
import type { RawFetchResult } from '../../src/types.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'extraction', 'article.html');
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, 'utf-8');

let server: Server;
let baseUrl: string;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/article') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(FIXTURE_HTML);
      } else if (req.url === '/not-found') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>404 Not Found</h1></body></html>');
      } else {
        res.writeHead(404);
        res.end('Not Found');
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

describe('integration: fetch pipeline', () => {
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
  });

  it('fetches HTML from local server and extracts markdown', async () => {
    const url = `${baseUrl}/article`;
    const result = await httpFetch(url);

    expect(result.statusCode).toBe(200);
    expect(result.html).toContain('Building Modern Web Scrapers');
    expect(result.contentType).toContain('text/html');

    const extraction = await extractContent(result.html, url);

    expect(extraction.title).toContain('Building Modern Web Scrapers');
    expect(extraction.markdown).toBeTruthy();
    expect(extraction.markdown.length).toBeGreaterThan(100);
    expect(extraction.markdown).toContain('TypeScript');
  });

  it('full pipeline: fetch → extract → cache → retrieve', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    const raw: RawFetchResult = {
      url: fetchResult.url,
      finalUrl: fetchResult.finalUrl,
      html: fetchResult.html,
      contentType: fetchResult.contentType,
      statusCode: fetchResult.statusCode,
      method: 'http',
      headers: fetchResult.headers,
    };

    cacheContent(raw, extraction);

    const cached = getCachedContent(url);
    expect(cached).not.toBeNull();
    expect(cached!.title).toContain('Building Modern Web Scrapers');
    expect(cached!.markdown).toContain('TypeScript');
    expect(isExpired(cached!)).toBe(false);
  });

  it('second fetch for same URL returns cached content', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    const raw: RawFetchResult = {
      url: fetchResult.url,
      finalUrl: fetchResult.finalUrl,
      html: fetchResult.html,
      contentType: fetchResult.contentType,
      statusCode: fetchResult.statusCode,
      method: 'http',
      headers: fetchResult.headers,
    };

    cacheContent(raw, extraction);

    const firstLookup = getCachedContent(url);
    expect(firstLookup).not.toBeNull();

    const secondLookup = getCachedContent(url);
    expect(secondLookup).not.toBeNull();
    expect(secondLookup!.title).toBe(firstLookup!.title);
    expect(secondLookup!.markdown).toBe(firstLookup!.markdown);
    expect(secondLookup!.contentHash).toBe(firstLookup!.contentHash);
  });

  it('extraction produces links from the article', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url);

    expect(extraction.links.length).toBeGreaterThan(0);
  });

  it('extraction with section option returns only that section', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url, {
      section: 'Conclusion',
    });

    expect(extraction.markdown).toContain('start simple');
    expect(extraction.markdown).not.toContain('Why TypeScript for Web Scraping');
  });

  it('extraction with maxChars truncates output', async () => {
    const url = `${baseUrl}/article`;
    const fetchResult = await httpFetch(url);
    const extraction = await extractContent(fetchResult.html, url, {
      maxChars: 200,
    });

    expect(extraction.markdown.length).toBeLessThanOrEqual(200);
  });

  it('handles 404 response without crashing', async () => {
    const url = `${baseUrl}/not-found`;
    const result = await httpFetch(url);

    expect(result.statusCode).toBe(404);
    expect(result.html).toContain('404');
  });
});

describe('integration: anti-bot challenge fast-fail (router → fetch tool)', () => {
  const CHALLENGE_BODY =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<div class="cf-browser-verification"></div></body></html>';

  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('surfaces a blocked_by_challenge stage error end-to-end when the browser tier fast-fails', async () => {
    // HTTP tier returns a 403 challenge body → router escalates to the browser
    // tier, which fast-fails with ChallengeBlockedError. The router maps that to
    // a blocked_by_challenge stage error and handleFetch surfaces it as ok:false.
    const httpClient: HttpClient = {
      fetch: async (url) => ({
        url,
        finalUrl: url,
        html: CHALLENGE_BODY,
        contentType: 'text/html',
        statusCode: 403,
        headers: {},
      }),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: async (url) => { throw new ChallengeBlockedError(url); },
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    const result = await handleFetch({ url: 'https://blocked.example/' }, router);

    expect(result.ok).toBe(false);
    const err = result as { ok: false; error: string; error_reason: string; stage: string; hint?: string };
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.stage).toBe('fetch');
    // Capability language + actionable use_auth suggestion.
    expect(err.error_reason.toLowerCase()).toMatch(/bot protection|challenge page/);
    expect(err.hint).toMatch(/use_auth/);
  });

  it('does not fast-fail a normal 200 page whose PROSE quotes challenge markers', async () => {
    // A real article that merely mentions the marker strings must fetch + extract
    // normally — no escalation, no blocked_by_challenge.
    const articleHtml =
      '<html><head><title>How bot challenges work</title></head><body><article>' +
      ('An interstitial shows "Just a moment" and injects a cf-turnstile widget. ' +
        'This article explains that flow in depth for engineers. ').repeat(20) +
      '</article></body></html>';
    let browserCalled = false;
    const httpClient: HttpClient = {
      fetch: async (url) => ({
        url,
        finalUrl: url,
        html: articleHtml,
        contentType: 'text/html',
        statusCode: 200,
        headers: {},
      }),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: async (url) => {
        browserCalled = true;
        throw new ChallengeBlockedError(url);
      },
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    const result = await handleFetch({ url: 'https://news.example/how-challenges-work' }, router);

    expect(result.ok).toBe(true);
    // No escalation to the browser tier → the gate never fired on prose markers.
    expect(browserCalled).toBe(false);
    const data = (result as { ok: true; data: { markdown: string } }).data;
    expect(data.markdown.toLowerCase()).toContain('this article explains that flow in depth');
  });
});
