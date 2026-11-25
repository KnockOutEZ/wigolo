import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import {
  cdpDirectFetch,
  _setCdpDirectFetchDepsForTests,
  _setProcessKillForTests,
  type CdpDirectFetchDeps,
  type CdpTransport,
} from '../../../src/fetch/cdp-direct.js';
import type { LookupAll } from '../../../src/watch/ssrf.js';

/**
 * The raw-CDP rung spawns its own browser, which means it bypasses BOTH of the
 * egress controls the rest of the fetch path honours unless it is wired to
 * respect them explicitly:
 *
 *  H1 — it launched with a proxy-stripped env and no `--proxy-server`, so with a
 *       proxy configured it egressed DIRECT on the operator's real IP, unlogged.
 *  H2 — the SSRF guard ran on the REQUESTED url only. `Page.navigate` follows
 *       redirects inside the browser, so a public host redirecting to cloud
 *       metadata / RFC-1918 had its content read and returned, and `finalUrl`
 *       was hardcoded to the requested url so the hop was invisible downstream.
 */

const REAL_HTML = '<html><head><title>Real</title></head><body>' + 'x'.repeat(2000) + '</body></html>';

interface Harness {
  spawnedArgs: string[];
  navigatedTo: string[];
  locationHref: string;
}

function harness(h: Harness): CdpDirectFetchDeps {
  const transport: CdpTransport = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.navigate') {
        h.navigatedTo.push(String(params?.url));
        return { frameId: 'F1' };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        const expr = String(params?.expression ?? '');
        // The final-URL read must go through the same isolated world.
        if (expr.includes('location')) return { result: { type: 'string', value: h.locationHref } };
        return { result: { type: 'string', value: REAL_HTML } };
      }
      if (method === 'Browser.getVersion') return { userAgent: 'Mozilla/5.0 Chrome/151.0.7922.72' };
      return {};
    }),
    close: vi.fn(async () => {}),
  };
  return {
    resolveChrome: () => '/fake/chrome',
    spawn: (_cmd, args) => {
      h.spawnedArgs = args;
      return { pid: 4242, on: vi.fn(), kill: vi.fn(), exitCode: 0, signalCode: null } as never;
    },
    isReachable: async () => true,
    mkdtemp: async (p: string) => p + 'tmp',
    rm: async () => {},
    connectTransport: async () => transport,
  };
}

describe('cdp-direct honours the configured egress policy (H1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = { spawnedArgs: [], navigatedTo: [], locationHref: 'https://example.com/' };
    _setProcessKillForTests(() => {});
    _setCdpDirectFetchDepsForTests(harness(h));
    resetConfig();
  });
  afterEach(() => {
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    delete process.env.USE_PROXY;
    delete process.env.PROXY_URL;
    resetConfig();
  });

  it('passes the configured proxy to the spawned browser rather than egressing direct', async () => {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://proxy.example.com:8080';
    resetConfig();

    const res = await cdpDirectFetch('https://example.com/', { lookup: publicLookup });

    expect(res).not.toBeNull();
    expect(h.spawnedArgs).toContain('--proxy-server=http://proxy.example.com:8080');
  });

  it('REFUSES to run rather than leak past a proxy it cannot authenticate', async () => {
    // Chrome's --proxy-server takes no inline credentials. Egressing direct
    // would defeat the proxy, so the rung declines and the caller falls back.
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://user:pass@proxy.example.com:8080';
    resetConfig();

    const res = await cdpDirectFetch('https://example.com/', { lookup: publicLookup });

    expect(res).toBeNull();
    expect(h.navigatedTo).toEqual([]);
  });

  it('adds no proxy flag when none is configured', async () => {
    const res = await cdpDirectFetch('https://example.com/', { lookup: publicLookup });
    expect(res).not.toBeNull();
    expect(h.spawnedArgs.some((a) => a.startsWith('--proxy-server'))).toBe(false);
  });
});

describe('cdp-direct guards the POST-redirect landing url (H2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = { spawnedArgs: [], navigatedTo: [], locationHref: 'https://example.com/' };
    _setProcessKillForTests(() => {});
    _setCdpDirectFetchDepsForTests(harness(h));
    resetConfig();
  });
  afterEach(() => {
    _setCdpDirectFetchDepsForTests(undefined);
    _setProcessKillForTests(undefined);
    resetConfig();
  });

  it('refuses to return content when the page landed on a blocked address', async () => {
    // Public host, allowed at request time, redirects in-browser to metadata.
    h.locationHref = 'http://169.254.169.254/latest/meta-data/';

    const res = await cdpDirectFetch('https://public.example/', { lookup: publicLookup });

    expect(res).toBeNull();
  });

  it('reports the real landing url, not the requested one', async () => {
    h.locationHref = 'https://example.com/after-redirect';

    const res = await cdpDirectFetch('https://example.com/start', { lookup: publicLookup });

    expect(res).not.toBeNull();
    expect(res!.finalUrl).toBe('https://example.com/after-redirect');
    expect(res!.url).toBe('https://example.com/start');
  });

  it('falls back to the requested url when the landing url cannot be read', async () => {
    h.locationHref = '';
    const res = await cdpDirectFetch('https://example.com/start', { lookup: publicLookup });
    expect(res).not.toBeNull();
    expect(res!.finalUrl).toBe('https://example.com/start');
  });
});

/** Resolves every host to a public address so only the URL under test decides.
 *  Callback-shaped, matching Node's `dns.lookup(host, {all:true}, cb)`. */
const publicLookup: LookupAll = (_host, _opts, cb) => {
  cb(null, [{ address: '93.184.216.34', family: 4 }]);
};
