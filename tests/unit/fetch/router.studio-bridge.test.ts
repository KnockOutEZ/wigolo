import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

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
import type { HttpClient, BrowserPoolInterface, StudioBridgeFetchers } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';

/**
 * S9 slice 1 — the Studio escalation rung inside SmartRouter.
 *
 * The rung exists because of one measured loss: on a Cloudflare-fronted page the C0 referee recorded
 * wigolo returning `blocked_by_challenge`, 0 chars, where a competitor returned the article. These tests
 * hold it to the two properties that make adding a rung safe — it fires ONLY after the normal ladder has
 * terminally failed on a challenge, and a bridge that declines leaves the honest error exactly as it was.
 */

const originalEnv = process.env;

const BRIDGED: RawFetchResult = {
  url: 'https://walled.example/x',
  finalUrl: 'https://walled.example/x',
  html: `<html><body><article>${'the real article text that beats the empty-content threshold. '.repeat(5)}</article></body></html>`,
  contentType: 'text/html',
  statusCode: 200,
  method: 'browser',
  headers: {},
  escalated: true,
};

const CLEAN_HTML = `<html><head><title>ok</title></head><body><article>${'ordinary content the extractor is happy with. '.repeat(5)}</article></body></html>`;

describe('SmartRouter — the Studio bridge rung', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let studioBridgeFetch: ReturnType<typeof vi.fn>;
  let studioBridgeAvailable: ReturnType<typeof vi.fn>;
  let studioBridge: StudioBridgeFetchers;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    httpClient = { fetch: vi.fn() };
    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url); }),
    } as unknown as BrowserPoolInterface;
    studioBridgeFetch = vi.fn(async () => null);
    studioBridgeAvailable = vi.fn(() => true);
    studioBridge = {
      studioBridgeAvailable: studioBridgeAvailable as unknown as StudioBridgeFetchers['studioBridgeAvailable'],
      studioBridgeFetch: studioBridgeFetch as unknown as StudioBridgeFetchers['studioBridgeFetch'],
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  const router = (pool = browserPool) =>
    new SmartRouter({ httpClient, browserPool: pool, pdfProbe: async () => false, studioBridge });

  it('serves the page off the live session when the browser tier terminally hits a challenge', async () => {
    studioBridgeFetch.mockResolvedValueOnce(BRIDGED);
    const result = await router().fetch('https://walled.example/x', { renderJs: 'always' });
    expect(studioBridgeFetch).toHaveBeenCalledOnce();
    expect((result as RawFetchResult).html).toContain('the real article text');
  });

  it('leaves blocked_by_challenge intact when no session is live and none can be started', async () => {
    // The bridge itself owns the "is there a session, can one be started" decision (amended-D4 lets it start
    // one), so from the router's side an unavailable bridge simply declines. The rung adds a path; it never
    // converts a real failure into something else.
    studioBridgeAvailable.mockReturnValue(false);
    studioBridgeFetch.mockResolvedValueOnce(null);
    const result = await router().fetch('https://walled.example/x', { renderJs: 'always' });
    expect((result as { error?: string }).error).toBe('blocked_by_challenge');
  });

  it('leaves blocked_by_challenge intact when the live session declines (login page, human holding, dead host)', async () => {
    studioBridgeFetch.mockResolvedValueOnce(null);
    const result = await router().fetch('https://walled.example/x', { renderJs: 'always' });
    expect(studioBridgeFetch).toHaveBeenCalledOnce();
    expect((result as { error?: string }).error).toBe('blocked_by_challenge');
  });

  it('is NOT consulted on a clean page — a working fetch must never be re-driven through the human browser', async () => {
    (httpClient.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      url: 'https://ok.example/', finalUrl: 'https://ok.example/', html: CLEAN_HTML,
      contentType: 'text/html', statusCode: 200, headers: {},
    });
    const result = await router().fetch('https://ok.example/');
    expect(studioBridgeFetch).not.toHaveBeenCalled();
    expect((result as RawFetchResult).html).toContain('ordinary content');
  });

  it('also fires when the browser RETURNS a still-challenge shell rather than throwing', async () => {
    // guardChallengeShell maps an uncleared interstitial to blocked_by_challenge with no exception; that
    // path must reach the rung too, or the bridge covers only half the ways a wall actually presents.
    const shellPool = {
      fetchWithBrowser: vi.fn(async (): Promise<RawFetchResult> => ({
        url: 'https://walled.example/x', finalUrl: 'https://walled.example/x',
        html: '<html><head><title>Just a moment...</title></head><body><div id="challenge-running"></div></body></html>',
        contentType: 'text/html', statusCode: 403, method: 'browser', headers: { 'cf-mitigated': 'challenge' },
      })),
    } as unknown as BrowserPoolInterface;
    studioBridgeFetch.mockResolvedValueOnce(BRIDGED);
    const result = await router(shellPool).fetch('https://walled.example/x', { renderJs: 'always' });
    expect(studioBridgeFetch).toHaveBeenCalledOnce();
    expect((result as RawFetchResult).html).toContain('the real article text');
  });
});
