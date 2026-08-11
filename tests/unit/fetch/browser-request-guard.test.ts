import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import {
  assertNavigationChainAllowed,
  evaluateBrowserRequestUrl,
  installBrowserRequestGuard,
  type BrowserGuardVerdict,
} from '../../../src/fetch/browser-request-guard.js';
import type { LookupAll } from '../../../src/watch/ssrf.js';

/**
 * WHY this file exists: the browser tier was the only fetch tier that checked
 * the target host ONCE, before navigating, and then let Chromium follow the
 * redirect chain unattended — so a public URL that 302s to cloud metadata or a
 * private address was reached. These tests pin the per-hop decision to the SAME
 * fence the HTTP/TLS/cdp-direct tiers call, case by case, so the browser tier
 * cannot silently regress to a weaker policy than its siblings.
 */

const PUBLIC_ONLY = { allowPrivate: false, resolve: false } as const;

/** A DNS stub: every host answers with the given addresses. */
function lookupReturning(addresses: { address: string; family: number }[]): LookupAll {
  return (_host, _o, cb) => cb(null, addresses);
}

describe('evaluateBrowserRequestUrl — fails closed on unusable information', () => {
  it('refuses a request with no URL, because "we could not read the target" is not a reason to issue it', async () => {
    await expect(evaluateBrowserRequestUrl(undefined, PUBLIC_ONLY)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('refuses an empty-string URL rather than treating it as harmless', async () => {
    await expect(evaluateBrowserRequestUrl('   ', PUBLIC_ONLY)).resolves.toMatchObject({ allowed: false });
  });

  it('refuses an unparseable URL — an unclassifiable target must not default to allow', async () => {
    const v = await evaluateBrowserRequestUrl('http://[not a url', PUBLIC_ONLY);
    expect(v.allowed).toBe(false);
  });

  it('refuses file:// so a redirect cannot turn a web fetch into a local-disk read', async () => {
    const v = await evaluateBrowserRequestUrl('file:///etc/passwd', PUBLIC_ONLY);
    expect(v).toMatchObject({ allowed: false });
    if (!v.allowed) expect(v.reason).toMatch(/protocol/i);
  });

  it('refuses an unknown scheme, because the scheme rule is an allow-list not a deny-list', async () => {
    const v = await evaluateBrowserRequestUrl('gopher://example.com/', PUBLIC_ONLY);
    expect(v.allowed).toBe(false);
  });

  it('allows data: — it carries no host, so there is no network target to fence', async () => {
    await expect(
      evaluateBrowserRequestUrl('data:text/html,<p>hi</p>', PUBLIC_ONLY),
    ).resolves.toEqual({ allowed: true });
  });

  it('allows blob: for the same reason — in-process, hostless', async () => {
    await expect(
      evaluateBrowserRequestUrl('blob:http://example.com/abc-123', PUBLIC_ONLY),
    ).resolves.toEqual({ allowed: true });
  });

  it('allows about:blank so a normal page lifecycle is not broken by the fence', async () => {
    await expect(evaluateBrowserRequestUrl('about:blank', PUBLIC_ONLY)).resolves.toEqual({
      allowed: true,
    });
  });
});

describe('evaluateBrowserRequestUrl — parity with the fence the other tiers enforce', () => {
  // Each case below is a class the shared fence (watch/ssrf.ts guardFetchUrl)
  // names. The browser tier must reach the SAME verdict, not merely block the
  // one case that was reproduced.
  const blocked: [label: string, url: string][] = [
    ['cloud metadata IPv4 (169.254.169.254)', 'http://169.254.169.254/latest/meta-data/'],
    ['cloud metadata alias (metadata.google.internal)', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['unspecified IPv4 (0.0.0.0)', 'http://0.0.0.0:8080/'],
    ['RFC1918 10/8', 'http://10.0.0.1/admin'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/'],
    ['CGN 100.64/10', 'http://100.64.0.1/'],
    ['IPv6 unique-local fc00::/7', 'http://[fc00::1]/'],
    ['IPv6 link-local fe80::/10', 'http://[fe80::1]/'],
    ['IPv4-mapped metadata (::ffff:169.254.169.254)', 'http://[::ffff:169.254.169.254]/'],
    // The URL parser normalises the deprecated ::a.b.c.d form to a hex pair,
    // which is the shape that actually reaches a guard — assert the shape, not
    // the one a human would type.
    ['IPv4-compatible hex form (::7f00:1)', 'http://[::7f00:1]/'],
    ['6to4 gateway embedding metadata (2002:a9fe:a9fe::)', 'http://[2002:a9fe:a9fe::]/'],
    ['NAT64 embedding metadata (64:ff9b::a9fe:a9fe)', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['IPv6 unspecified (::)', 'http://[::]/'],
  ];

  for (const [label, url] of blocked) {
    it(`blocks ${label}`, async () => {
      const v = await evaluateBrowserRequestUrl(url, PUBLIC_ONLY);
      expect(v.allowed).toBe(false);
    });
  }

  // Must-not-fire. A fence that blocks everything passes every positive test;
  // these pin the reachability the fetch/crawl contract promises.
  const allowed: [label: string, url: string][] = [
    ['loopback 127.0.0.1 (documented local-dev promise)', 'http://127.0.0.1:3000/'],
    ['the localhost alias', 'http://localhost:3000/'],
    ['IPv6 loopback ::1', 'http://[::1]:3000/'],
    ['an ordinary public host', 'https://example.com/docs'],
  ];

  for (const [label, url] of allowed) {
    it(`still allows ${label}`, async () => {
      await expect(evaluateBrowserRequestUrl(url, PUBLIC_ONLY)).resolves.toEqual({ allowed: true });
    });
  }

  it('honours WIGOLO_FETCH_ALLOW_PRIVATE for RFC1918, matching the other tiers', async () => {
    await expect(
      evaluateBrowserRequestUrl('http://10.0.0.1/', { allowPrivate: true, resolve: false }),
    ).resolves.toEqual({ allowed: true });
  });

  it('still blocks cloud metadata even with allowPrivate — it is never a legitimate target', async () => {
    const v = await evaluateBrowserRequestUrl('http://169.254.169.254/', {
      allowPrivate: true,
      resolve: false,
    });
    expect(v.allowed).toBe(false);
  });
});

describe('evaluateBrowserRequestUrl — DNS-resolved arm', () => {
  it('blocks a public hostname whose A record points at cloud metadata', async () => {
    const v = await evaluateBrowserRequestUrl('http://evil.example.com/', {
      allowPrivate: false,
      resolve: true,
      lookup: lookupReturning([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(v.allowed).toBe(false);
  });

  it('skips the lookup when resolve is false, which is why subresources stay off the DNS path', async () => {
    const lookup = vi.fn(lookupReturning([{ address: '169.254.169.254', family: 4 }]));
    // Deliberate: this documents the cost/coverage trade — only document
    // (navigation) requests pay a lookup. If someone makes every subresource
    // resolve, this test tells them they changed the hot path on purpose.
    await expect(
      evaluateBrowserRequestUrl('http://evil.example.com/logo.png', {
        allowPrivate: false,
        resolve: false,
        lookup,
      }),
    ).resolves.toEqual({ allowed: true });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never resolves an IP literal — it is already the final answer', async () => {
    const lookup = vi.fn(lookupReturning([{ address: '93.184.216.34', family: 4 }]));
    await evaluateBrowserRequestUrl('http://93.184.216.34/', {
      allowPrivate: false,
      resolve: true,
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('resolves a given host once per fetch, so a multi-hop chain is not N lookups', async () => {
    const lookup = vi.fn(lookupReturning([{ address: '93.184.216.34', family: 4 }]));
    const resolvedCache = new Map<string, BrowserGuardVerdict>();
    const opts = { allowPrivate: false, resolve: true, resolvedCache, lookup };
    await evaluateBrowserRequestUrl('https://example.com/a', opts);
    await evaluateBrowserRequestUrl('https://example.com/b', opts);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not block a host that fails to resolve — there is no address to reach', async () => {
    const lookup: LookupAll = (_h, _o, cb) => cb(new Error('ENOTFOUND') as NodeJS.ErrnoException, []);
    await expect(
      evaluateBrowserRequestUrl('https://nxdomain.invalid/', {
        allowPrivate: false,
        resolve: true,
        lookup,
      }),
    ).resolves.toEqual({ allowed: true });
  });
});

/** A CDP session stub that records what the guard sends back for each pause. */
function makeSessionStub() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  let handler: ((ev: unknown) => void) | null = null;
  const session = {
    on(event: string, fn: (ev: unknown) => void) {
      if (event === 'Fetch.requestPaused') handler = fn;
      return session;
    },
    async send(method: string, params: Record<string, unknown>) {
      sent.push({ method, params });
      return {};
    },
    async detach() {
      sent.push({ method: 'detach', params: {} });
    },
  };
  return {
    session,
    sent,
    fire(ev: unknown) {
      handler?.(ev);
    },
    get attached() {
      return handler !== null;
    },
  };
}

function pageWithSession(stub: ReturnType<typeof makeSessionStub>): Page {
  return {
    context: () => ({ newCDPSession: async () => stub.session }),
  } as unknown as Page;
}

/** Let the guard's async handler settle — it runs detached from the emit. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('installBrowserRequestGuard', () => {
  it('enables interception at the REQUEST stage, the only stage that re-pauses on redirect hops', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), { allowPrivate: false });
    expect(guard.intercepting).toBe(true);
    const enable = stub.sent.find((s) => s.method === 'Fetch.enable');
    expect(enable).toBeDefined();
    expect(enable?.params).toMatchObject({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  });

  it('continues an allowed request so ordinary browsing is untouched', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), {
      allowPrivate: false,
      lookup: lookupReturning([{ address: '93.184.216.34', family: 4 }]),
    });
    stub.fire({ requestId: '1', request: { url: 'https://example.com/' }, resourceType: 'Document' });
    await settle();
    expect(stub.sent.some((s) => s.method === 'Fetch.continueRequest')).toBe(true);
    expect(stub.sent.some((s) => s.method === 'Fetch.failRequest')).toBe(false);
    expect(guard.blockedReason()).toBeNull();
  });

  it('fails a blocked hop with BlockedByClient, so the request is never issued', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), { allowPrivate: false });
    stub.fire({
      requestId: '7',
      request: { url: 'http://169.254.169.254/latest/meta-data/' },
      resourceType: 'Document',
    });
    await settle();
    expect(stub.sent).toContainEqual({
      method: 'Fetch.failRequest',
      params: { requestId: '7', errorReason: 'BlockedByClient' },
    });
    expect(stub.sent.some((s) => s.method === 'Fetch.continueRequest')).toBe(false);
    expect(guard.blockedReason()).toMatch(/link-local|metadata/i);
  });

  it('keeps the FIRST block reason, so the reported cause is the fence verdict not a later cascade', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), { allowPrivate: false });
    stub.fire({ requestId: '1', request: { url: 'http://169.254.169.254/' }, resourceType: 'Document' });
    await settle();
    stub.fire({ requestId: '2', request: { url: 'http://10.0.0.1/' }, resourceType: 'Image' });
    await settle();
    expect(guard.blockedReason()).toMatch(/link-local|metadata/i);
    expect(guard.blockedReason()).not.toMatch(/10\.0\.0\.1/);
  });

  it('answers every pause even when evaluation throws — an unanswered pause hangs the page', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), { allowPrivate: false });
    // A CDP payload the guard cannot read. The property under test is that
    // "we could not tell what this request is" resolves to REFUSE, and that the
    // pause is still answered so the page does not hang to the nav timeout.
    stub.fire({
      requestId: '9',
      resourceType: 'Document',
      get request(): { url: string } {
        throw new Error('malformed CDP payload');
      },
    });
    await settle();
    const replies = stub.sent.filter(
      (s) => s.method === 'Fetch.failRequest' || s.method === 'Fetch.continueRequest',
    );
    expect(replies).toHaveLength(1);
    // Fail CLOSED: not knowing whether a target is safe is not a reason to reach it.
    expect(replies[0].method).toBe('Fetch.failRequest');
    expect(guard.blockedReason()).toMatch(/could not evaluate/i);
  });

  it('reports intercepting:false when the engine has no CDP, so callers do not assume a fence that is absent', async () => {
    const page = { context: () => ({}) } as unknown as Page;
    const guard = await installBrowserRequestGuard(page, { allowPrivate: false });
    expect(guard.intercepting).toBe(false);
    expect(guard.blockedReason()).toBeNull();
  });

  it('is inert for a page stub with no context() at all', async () => {
    const guard = await installBrowserRequestGuard({} as unknown as Page, { allowPrivate: false });
    expect(guard.intercepting).toBe(false);
  });

  it('degrades to inert instead of throwing when Fetch.enable fails', async () => {
    // WHY not a throw: the install runs BEFORE fetchWithBrowser's try/finally,
    // so rejecting here would strand the page, the pooled context slot and the
    // throwaway stealth browser — a CDP hiccup would become a resource leak on
    // every fetch. The post-navigation chain assertion still refuses blocked
    // content, so degrading costs coverage, not the security property.
    const stub = makeSessionStub();
    const failing = {
      ...stub.session,
      on: stub.session.on.bind(stub.session),
      send: async (method: string) => {
        if (method === 'Fetch.enable') throw new Error('Target closed');
        return {};
      },
      detach: async () => {},
    };
    const page = {
      context: () => ({ newCDPSession: async () => failing }),
    } as unknown as Page;
    const guard = await installBrowserRequestGuard(page, { allowPrivate: false });
    expect(guard.intercepting).toBe(false);
  });

  it('detaches on dispose so a pooled browser does not accumulate interceptors', async () => {
    const stub = makeSessionStub();
    const guard = await installBrowserRequestGuard(pageWithSession(stub), { allowPrivate: false });
    await guard.dispose();
    expect(stub.sent.some((s) => s.method === 'detach')).toBe(true);
  });
});

describe('assertNavigationChainAllowed — the every-engine backstop', () => {
  it('accepts an all-public chain', () => {
    expect(() =>
      assertNavigationChainAllowed(['https://a.example/', 'https://b.example/'], false),
    ).not.toThrow();
  });

  it('refuses a chain whose FINAL url is blocked', () => {
    expect(() =>
      assertNavigationChainAllowed(['https://a.example/', 'http://169.254.169.254/'], false),
    ).toThrow(/link-local|metadata/i);
  });

  it('refuses a chain with a blocked INTERMEDIATE hop, even when it lands somewhere public', () => {
    // The hop itself is the leak: the request was issued and its response
    // steered the navigation, so landing public afterwards is not a pass.
    expect(() =>
      assertNavigationChainAllowed(['https://a.example/', 'http://10.0.0.1/', 'https://c.example/'], false),
    ).toThrow(/private/i);
  });

  it('refuses a hop with no URL rather than skipping it', () => {
    expect(() => assertNavigationChainAllowed(['https://a.example/', undefined], false)).toThrow(
      /no URL/i,
    );
  });

  it('leaves the local-dev loopback promise intact', () => {
    expect(() => assertNavigationChainAllowed(['http://127.0.0.1:3000/'], false)).not.toThrow();
  });
});
