import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

// Chromium treats a PDF (or other binary) response as a download: page.goto
// throws "Download is starting" AND/OR a `download` event fires. The browser
// tier must NOT hard-error — it must read the downloaded bytes into a Buffer
// and return a RawFetchResult with contentType application/pdf + rawBuffer so
// the tool layer extracts it exactly like the HTTP path.

const PDF_BYTES = Buffer.from('%PDF-1.4 hello world download body');

// A distinct temp file per test run so download.path() points at real bytes.
const dlDir = mkdtempSync(join(tmpdir(), 'wigolo-dl-'));
const dlPath = join(dlDir, 'downloaded.pdf');
writeFileSync(dlPath, PDF_BYTES);

const state = {
  // 'download'          → download event fires synchronously, then goto rejects
  // 'normal'            → plain HTML navigation
  // 'deferred-download' → goto rejects FIRST, download event only resolvable via
  //                       waitForEvent('download') (the real Chromium race)
  mode: 'download' as 'download' | 'normal' | 'deferred-download',
  downloadListeners: [] as Array<(dl: unknown) => void>,
};

function makeDownloadStub() {
  return {
    suggestedFilename: () => 'downloaded.pdf',
    path: async () => dlPath,
  };
}

vi.mock('playwright', () => {
  const makePage = () => {
    const page: Record<string, unknown> = {
      on: vi.fn((event: string, cb: (dl: unknown) => void) => {
        if (event === 'download') state.downloadListeners.push(cb);
      }),
      waitForEvent: vi.fn().mockImplementation((event: string) => {
        if (event === 'download' && state.mode === 'deferred-download') {
          return Promise.resolve(makeDownloadStub());
        }
        return Promise.reject(new Error(`no ${event} event`));
      }),
      goto: vi.fn().mockImplementation(() => {
        if (state.mode === 'download') {
          // Fire the download event as Chromium would, then reject goto.
          for (const cb of state.downloadListeners) cb(makeDownloadStub());
          return Promise.reject(new Error('page.goto: Download is starting'));
        }
        if (state.mode === 'deferred-download') {
          // goto rejects BEFORE the download event is captured — the download
          // is only obtainable by awaiting waitForEvent('download').
          return Promise.reject(new Error('page.goto: Download is starting'));
        }
        return Promise.resolve({
          status: () => 200,
          url: () => 'https://example.com/page',
          headers: () => ({ 'content-type': 'text/html' }),
        });
      }),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      // settlePage reads content metrics + the final DOM verdict via evaluate.
      evaluate: vi.fn().mockImplementation((src: string) =>
        typeof src === 'string' && src.includes('hasContent')
          ? Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false })
          : Promise.resolve({ textLen: 1000, nodes: 8 })),
      content: vi.fn().mockResolvedValue('<html><body>normal html content here</body></html>'),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
      setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return page;
  };

  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockImplementation(() => makePage()),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser-pool download interception', () => {
  beforeEach(() => {
    resetConfig();
    state.mode = 'download';
    state.downloadListeners = [];
  });
  afterEach(() => resetConfig());

  it('converts a "Download is starting" goto into a rawBuffer PDF result, not a thrown error', async () => {
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://example.com/report');
    expect(res.contentType).toBe('application/pdf');
    expect(res.rawBuffer).toBeDefined();
    expect(res.rawBuffer!.length).toBeGreaterThan(0);
    expect(res.rawBuffer!.toString()).toContain('hello world download body');
    expect(res.statusCode).toBe(200);
    expect(res.html).toBe('');
    await pool.shutdown();
  });

  it('recovers a deferred download: goto rejects first, bytes are read via waitForEvent', async () => {
    // WHY: the real Chromium race — page.goto rejects with "Download is
    // starting" BEFORE the download event handler captured the download.
    // The old backstop re-threw in this window. It must instead wait briefly
    // for the download event and return the buffered PDF bytes.
    state.mode = 'deferred-download';
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://example.com/deferred');
    expect(res.contentType).toBe('application/pdf');
    expect(res.rawBuffer).toBeDefined();
    expect(res.rawBuffer!.toString()).toContain('hello world download body');
    expect(res.html).toBe('');
    await pool.shutdown();
  });

  it('a normal (non-download) navigation is unchanged — no download event, HTML path', async () => {
    state.mode = 'normal';
    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://example.com/page');
    expect(res.contentType).toBe('text/html');
    expect(res.rawBuffer).toBeUndefined();
    expect(res.html).toContain('normal html content here');
    await pool.shutdown();
  });
});
