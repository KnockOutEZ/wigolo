import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter } from '../../../src/fetch/router.js';
import type {
  HttpClient,
  BrowserPoolInterface,
  SystemBrowserFetch,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { BrowserAcquirer } from '../../../src/fetch/browser-acquire.js';
import { resetBrowserTierAnnouncements, BROWSER_TIER_ENV } from '../../../src/fetch/browser-tier.js';
import { expectContent } from '../../helpers/fetch-result.js';
import { isStageError } from '../../../src/fetch/error-describe.js';

/**
 * D-S10-5's companion rung, at the ONE seam where it is reachable.
 *
 * WHY THIS FILE EXISTS. The rung that drives an already-installed browser needs no bundled
 * engine — it spawns its own. But its only call site sat inside `browserPool.fetchWithBrowser`,
 * which the router reaches only after `ensureBrowser()` returns 'ready'. So the rung that does
 * not need the engine was gated behind acquiring the engine, and a no-display host with a real
 * browser on disk still returned `browser_engine_unavailable`. Every case below drives a real
 * `SmartRouter.fetch` through the unavailable-engine branch; revert the wiring and this file reds.
 *
 * The companion fetcher is INJECTED throughout. That is not merely for speed: the production
 * default spawns a real browser, and a unit test that silently did so on a developer machine
 * with Chrome installed would be measuring the host rather than the branch.
 */

const BODY = 'ordinary article text that comfortably clears the extractor thresholds. '.repeat(6);
const HTML = `<html><head><title>ok</title></head><body><article>${BODY}</article></body></html>`;

function companionResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: `<html><head><title>from the installed browser</title></head><body><article>${BODY}</article></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
  } as RawFetchResult;
}

const originalEnv = process.env;
let dataDir: string;

function httpOk(url = 'https://ok.example/'): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url,
    finalUrl: url,
    html: HTML,
    contentType: 'text/html',
    statusCode: 200,
    headers: {},
  } as Awaited<ReturnType<HttpClient['fetch']>>;
}

/** An engine that never comes up — the branch every case here is about. */
function unavailableAcquirer(): BrowserAcquirer {
  return { ensureBrowser: vi.fn(async () => 'unavailable') } as unknown as BrowserAcquirer;
}

function readyAcquirer(): BrowserAcquirer {
  return { ensureBrowser: vi.fn(async () => 'ready') } as unknown as BrowserAcquirer;
}

describe('SmartRouter — the D-S10-5 companion rung', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let companion: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-companion-rung-'));
    // Forced through the resolver's own documented override so the population under test does
    // not depend on whether the runner happens to be a laptop or a headless CI box.
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, [BROWSER_TIER_ENV]: 'no-display' };
    resetConfig();
    resetBrowserTierAnnouncements();
    httpClient = { fetch: vi.fn(async () => httpOk()) } as unknown as HttpClient;
    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => ({
        url,
        finalUrl: url,
        html: HTML,
        contentType: 'text/html',
        statusCode: 200,
        method: 'browser' as const,
        headers: {},
      })),
    } as unknown as BrowserPoolInterface;
    companion = vi.fn(async (url: string) => companionResult(url));
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    resetBrowserTierAnnouncements();
    rmSync(dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const router = (opts: {
    acquirer?: BrowserAcquirer;
    systemBrowserFetch?: SystemBrowserFetch | null;
  } = {}) =>
    new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: opts.acquirer ?? unavailableAcquirer(),
      ...(opts.systemBrowserFetch === null
        ? {}
        : { systemBrowserFetch: (opts.systemBrowserFetch ?? companion) as SystemBrowserFetch }),
    });

  it('serves content from the installed browser when the bundled engine cannot be supplied', async () => {
    // THE case the slice exists for. Before the wiring this returned browser_engine_unavailable
    // on a host with a perfectly good browser sitting on disk.
    const result = expectContent(await router().fetch('https://spa.example/', { renderJs: 'always' }));

    expect(companion).toHaveBeenCalledTimes(1);
    expect(result.html).toContain('from the installed browser');
  });

  it('declares itself the companion rung to the fetcher, so the opt-in gate is bypassed by intent', async () => {
    // Without this flag `resolveAuthenticChrome` declines `chromium-pinned` on every default
    // install, and the rung is a silent no-op exactly where it is needed.
    await router().fetch('https://spa.example/', { renderJs: 'always' });

    expect(companion).toHaveBeenCalledWith(
      'https://spa.example/',
      expect.objectContaining({ companionRung: true }),
    );
  });

  it('does NOT fire when the bundled engine is healthy', async () => {
    // The guard that keeps this a fallback. A present system browser must never start winning
    // fetches on a host whose normal path works — that is a behaviour change nobody asked for.
    const result = await router({ acquirer: readyAcquirer() }).fetch('https://spa.example/', {
      renderJs: 'always',
    });

    expect(companion).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledTimes(1);
    expect(expectContent(result).html).not.toContain('from the installed browser');
  });

  it('does NOT fire on a desktop host, even when that host cannot supply the engine', async () => {
    // The population gate. A desktop whose engine merely failed to install has a stated remedy
    // (`wigolo warmup`); quietly driving the human's own browser instead is not this rung's job.
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, [BROWSER_TIER_ENV]: 'desktop' };
    resetConfig();

    const result = await router().fetch('https://spa.example/', { renderJs: 'always' });

    expect(companion).not.toHaveBeenCalled();
    // A desktop host with no engine may end as a stage error; either way the assertion that
    // matters is that the companion's bytes were not served.
    expect(isStageError(result) ? '' : (result.html ?? '')).not.toContain('from the installed browser');
  });

  it('does NOT fire for a fetch asking for actions, which the rung cannot honour', async () => {
    // Serving plain content for a request that asked for actions returns the WRONG thing
    // silently, which is worse than declining and is why the rung is content-only.
    await router().fetch('https://spa.example/', {
      renderJs: 'always',
      actions: [{ type: 'click', selector: '#more' }],
    } as Parameters<SmartRouter['fetch']>[1]);

    expect(companion).not.toHaveBeenCalled();
  });

  it('does NOT fire for a screenshot request, which the rung cannot honour', async () => {
    await router().fetch('https://spa.example/', {
      renderJs: 'always',
      screenshot: true,
    } as Parameters<SmartRouter['fetch']>[1]);

    expect(companion).not.toHaveBeenCalled();
  });

  it('leaves the existing unavailable-engine handling byte-identical when the rung declines', async () => {
    // No authentic browser, or the optional control dependency absent, or a failed launch: the
    // rung returns null and everything downstream must behave exactly as it did before it existed.
    const declining = vi.fn(async () => null) as unknown as SystemBrowserFetch;

    const result = await router({ systemBrowserFetch: declining }).fetch('https://spa.example/', {
      renderJs: 'always',
    });

    expect(declining).toHaveBeenCalledTimes(1);
    // A declining rung may end as a stage error OR as content carrying a warning — both are
    // acceptable degradations; what must never happen is the companion's bytes being served.
    expect(isStageError(result) ? result.error : (result.warning ?? '')).toBeTruthy();
    expect(isStageError(result) ? '' : (result.html ?? '')).not.toContain('from the installed browser');
  });

  it('never lets a throwing rung take down the fetch', async () => {
    // Instrumentation-grade discipline: a companion rung that blows up must degrade to the
    // previous behaviour, not surface its own failure as the fetch's.
    const throwing = vi.fn(async () => {
      throw new Error('chrome exploded');
    }) as unknown as SystemBrowserFetch;

    const result = await router({ systemBrowserFetch: throwing }).fetch('https://spa.example/', {
      renderJs: 'always',
    });

    expect(result).toBeDefined();
    expect(isStageError(result) ? '' : (result.html ?? '')).not.toContain('from the installed browser');
  });

  it('guards a still-challenge page from the companion rung instead of leaking the shell', async () => {
    // The rung returns whatever the installed browser rendered. An uncleared interstitial is
    // NOT content, and it must be labeled here exactly as it is on every other rung — otherwise
    // this becomes the one path that launders a challenge shell into the cache as an article.
    const challenge = vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: '<html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running">Checking your browser before accessing</div></body></html>',
      contentType: 'text/html',
      statusCode: 403,
      method: 'browser',
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    })) as unknown as SystemBrowserFetch;

    const result = await router({ systemBrowserFetch: challenge }).fetch('https://walled.example/', {
      renderJs: 'always',
    });

    expect(challenge).toHaveBeenCalledTimes(1);
    expect((result as unknown as { error?: string }).error).toBe('blocked_by_challenge');
  });
});
