import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { readTierOccupancy } from '../../../src/fetch/tier-occupancy.js';
import { resetBrowserTierAnnouncements, BROWSER_TIER_ENV } from '../../../src/fetch/browser-tier.js';

/**
 * D-S10-4's instrument, at the seam it actually has to live on.
 *
 * WHY THIS FILE EXISTS SEPARATELY from the unit tests: the classifier can be perfect and the
 * instrument still useless, because the failure D-S10-4 names is a PLACEMENT failure. The shipped
 * D10(a) counters classify correctly and answer nothing, since every increment sits in
 * `studio-bridge.ts` — on a host with no substrate they read zero forever, and zero there is
 * indistinguishable from no demand. So these cases drive a real `SmartRouter.fetch` on a host
 * where no substrate exists, and assert the counters move anyway. Point the increments back at
 * the bridge (spec probe P-9) and this file is what reds.
 */

const HTML = `<html><head><title>ok</title></head><body><article>${'ordinary content the extractor is happy with. '.repeat(6)}</article></body></html>`;

const BRIDGED: RawFetchResult = {
  url: 'https://walled.example/x',
  finalUrl: 'https://walled.example/x',
  html: `<html><body><article>${'the real article text that beats the empty-content threshold. '.repeat(5)}</article></body></html>`,
  contentType: 'text/html',
  statusCode: 200,
  // The bridge reports the browser method on purpose — see studio-bridge.ts. The router has to
  // distinguish the rungs anyway.
  method: 'browser',
  headers: {},
  escalated: true,
};

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

describe('SmartRouter — tier-occupancy counters on a host with no substrate', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-router-occupancy-'));
    // A linux box with neither DISPLAY nor WAYLAND_DISPLAY is the population D10(b) is about,
    // and it is the population the shipped bridge counters structurally cannot see. Forced via
    // the resolver's own documented override so the case does not depend on the test runner's
    // real machine.
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
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    resetBrowserTierAnnouncements();
    rmSync(dataDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const router = (bridge?: StudioBridgeFetchers) =>
    new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false, ...(bridge ? { studioBridge: bridge } : {}) });

  it('records browser-rung occupancy on a no-display host with no substrate anywhere', async () => {
    // THE assertion the D10(b) decision rests on. If this number is negligible in the field, the
    // companion path is not warranted and D-S10-4's reverses-if applies; if it is large, it is.
    // Either way the number has to be produced by a host in this state, which is precisely what
    // the shipped instrument cannot do.
    await router().fetch('https://spa.example/', { renderJs: 'always' });
    expect(readTierOccupancy(dataDir)['no-display'].browser).toBe(1);
    expect(readTierOccupancy(dataDir)['no-display'].substrate).toBe(0);
  });

  it('records HTTP-rung occupancy through the ordinary auto path', async () => {
    await router().fetch('https://ok.example/');
    const occ = readTierOccupancy(dataDir)['no-display'];
    expect(occ.http).toBe(1);
    expect(occ.browser).toBe(0);
  });

  it('records a fetch that returns from a completely different branch of the ladder', async () => {
    // WHY: `renderJs: 'never'` leaves the router at a return statement hundreds of lines from the
    // one the case above uses. If the recording were bolted onto individual call sites instead of
    // the single exit, this is the case that would silently go uncounted — and the first person to
    // add a branch would reintroduce the same hole.
    await router().fetch('https://ok.example/', { renderJs: 'never' });
    expect(readTierOccupancy(dataDir)['no-display'].http).toBe(1);
  });

  it('does not record anything for a navigation the exfil guard refused', async () => {
    // The guard returns before any fetcher runs. A request that never left must not appear in a
    // denominator that is about to be read as demand.
    await router().fetch('http://169.254.169.254/latest/meta-data/');
    const occ = readTierOccupancy(dataDir)['no-display'];
    expect(Object.values(occ).every((n) => n === 0)).toBe(true);
  });

  it('records unmet demand when the browser rung cannot be supplied', async () => {
    const { BrowserAcquirer } = await import('../../../src/fetch/browser-acquire.js');
    const unavailable = { ensureBrowser: vi.fn(async () => 'unavailable') } as unknown as InstanceType<typeof BrowserAcquirer>;
    // The companion rung is declined explicitly, because on a host that HAS an installed browser
    // this demand is no longer unmet — the rung serves it, and the counter would correctly read
    // `browser` instead. Left to the real seam the case would assert a falsehood on any developer
    // machine with Chrome (and spawn one, timing out at 20s). Declining states the host this case
    // is actually about: no bundled engine AND no installed browser.
    const r = new SmartRouter({
      httpClient,
      browserPool,
      pdfProbe: async () => false,
      browserAcquirer: unavailable,
      systemBrowserFetch: async () => null,
    });
    await r.fetch('https://spa.example/', { renderJs: 'always' });
    const occ = readTierOccupancy(dataDir)['no-display'];
    expect(occ.browserUnavailable).toBe(1);
    expect(occ.browser).toBe(0);
  });

  it('attributes a page served by the attended session to the substrate rung, not the browser rung', async () => {
    // The two rungs are indistinguishable by `method`, and this is the case that proves the
    // router — not the classifier — is what tells them apart.
    const { ChallengeBlockedError } = await import('../../../src/fetch/browser-pool.js');
    const blocked = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url); }),
    } as unknown as BrowserPoolInterface;
    const bridge = {
      studioBridgeAvailable: vi.fn(() => true),
      studioBridgeFetch: vi.fn(async () => BRIDGED),
    } as unknown as StudioBridgeFetchers;
    const r = new SmartRouter({ httpClient, browserPool: blocked, pdfProbe: async () => false, studioBridge: bridge });
    await r.fetch('https://walled.example/x', { renderJs: 'always' });
    const occ = readTierOccupancy(dataDir)['no-display'];
    expect(occ.substrate).toBe(1);
    expect(occ.browser).toBe(0);
  });

  it('records a terminal challenge block as unmet demand', async () => {
    const { ChallengeBlockedError } = await import('../../../src/fetch/browser-pool.js');
    const blocked = {
      fetchWithBrowser: vi.fn(async (url: string) => { throw new ChallengeBlockedError(url); }),
    } as unknown as BrowserPoolInterface;
    const r = new SmartRouter({ httpClient, browserPool: blocked, pdfProbe: async () => false });
    await r.fetch('https://walled.example/x', { renderJs: 'always' });
    expect(readTierOccupancy(dataDir)['no-display'].blocked).toBe(1);
  });
});
