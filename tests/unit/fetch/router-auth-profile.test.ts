import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { resetConfig } from '../../../src/config.js';

// Issue #161 regression: the WIGOLO_CHROME_PROFILE_PATH temp copy must be
// (a) handed to the browser tier as userDataDir and (b) removed once the fetch
// settles — success, failure, and challenge-block alike. auth.js is
// deliberately NOT mocked here so the REAL copy is made and cleaned up.

// Browser-acquire mock — report the engine "ready" without a real install
// (same rationale as router.test.ts).
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
import type { BrowserPoolInterface, BrowserFetchArgs } from '../../../src/fetch/router.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';
import type { RawFetchResult } from '../../../src/types.js';

const FULL_HTML = `<html><body><p>${'real content long enough. '.repeat(20)}</p></body></html>`;

function makeBrowserResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: FULL_HTML,
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
  };
}

describe('SmartRouter useAuth with WIGOLO_CHROME_PROFILE_PATH (issue #161)', () => {
  const originalEnv = process.env;
  let profileDir: string;
  // Captured by the pool mock at fetch time.
  let seenOptions: BrowserFetchArgs | undefined;
  let dirExistedDuringFetch: boolean;

  function makeRouter(pool: BrowserPoolInterface): SmartRouter {
    return new SmartRouter({
      httpClient: { fetch: vi.fn(async () => { throw new Error('http tier must not run'); }) },
      browserPool: pool,
      pdfProbe: async () => false,
    });
  }

  function capturingPool(
    respond: (url: string) => Promise<RawFetchResult>,
  ): BrowserPoolInterface {
    return {
      fetchWithBrowser: vi.fn(async (url: string, options?: BrowserFetchArgs) => {
        seenOptions = options;
        dirExistedDuringFetch = options?.userDataDir ? existsSync(options.userDataDir) : false;
        return respond(url);
      }),
    };
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_AUTH_STATE_PATH;
    delete process.env.WIGOLO_CDP_URL;
    profileDir = mkdtempSync(join(tmpdir(), 'wigolo-profile-src-'));
    writeFileSync(join(profileDir, 'Cookies'), 'cookie-bytes');
    process.env.WIGOLO_CHROME_PROFILE_PATH = profileDir;
    resetConfig();
    seenOptions = undefined;
    dirExistedDuringFetch = false;
  });

  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
    // Belt-and-braces: never leave a temp copy behind even on test failure.
    if (seenOptions?.userDataDir) {
      rmSync(seenOptions.userDataDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('passes the temp profile copy to the browser tier and removes it after a successful fetch', async () => {
    const router = makeRouter(capturingPool(async (url) => makeBrowserResult(url)));

    const result = await router.fetch('https://intranet.example/page', { useAuth: true });
    expect(result.method).toBe('browser');

    // (a) the copy was consumed: passed to fetchWithBrowser and alive at fetch time.
    expect(seenOptions?.userDataDir).toBeDefined();
    expect(seenOptions?.userDataDir).not.toBe(profileDir);
    expect(basename(seenOptions!.userDataDir!)).toContain('wigolo-chrome-');
    expect(dirExistedDuringFetch).toBe(true);

    // (b) the copy is gone once the fetch settled; the source profile is untouched.
    expect(existsSync(seenOptions!.userDataDir!)).toBe(false);
    expect(existsSync(join(profileDir, 'Cookies'))).toBe(true);
  });

  it('removes the temp profile copy when the browser fetch fails', async () => {
    const router = makeRouter(capturingPool(async () => { throw new Error('browser boom'); }));

    await expect(
      router.fetch('https://intranet.example/page', { useAuth: true }),
    ).rejects.toThrow(/browser boom/);

    expect(seenOptions?.userDataDir).toBeDefined();
    expect(dirExistedDuringFetch).toBe(true);
    expect(existsSync(seenOptions!.userDataDir!)).toBe(false);
  });

  it('removes the temp profile copy when the fetch is aborted', async () => {
    const router = makeRouter(capturingPool(async () => {
      throw new DOMException('stage_timeout', 'AbortError');
    }));

    await expect(
      router.fetch('https://intranet.example/page', { useAuth: true }),
    ).rejects.toBeTruthy();

    expect(seenOptions?.userDataDir).toBeDefined();
    expect(existsSync(seenOptions!.userDataDir!)).toBe(false);
  });

  it('removes the temp profile copy on a challenge-block (structured stage error path)', async () => {
    const router = makeRouter(capturingPool(async () => {
      throw new ChallengeBlockedError('https://intranet.example/page');
    }));

    const result = await router.fetch('https://intranet.example/page', { useAuth: true });
    expect((result as { error?: string }).error).toBe('blocked_by_challenge');

    expect(seenOptions?.userDataDir).toBeDefined();
    expect(existsSync(seenOptions!.userDataDir!)).toBe(false);
  });

  it('removes the temp profile copy on the actions path too', async () => {
    const router = makeRouter(capturingPool(async (url) => makeBrowserResult(url)));

    const result = await router.fetch('https://intranet.example/page', {
      useAuth: true,
      actions: [{ type: 'wait_for', selector: 'body' }],
    });
    expect(result.method).toBe('browser');

    expect(seenOptions?.userDataDir).toBeDefined();
    expect(existsSync(seenOptions!.userDataDir!)).toBe(false);
  });
});
