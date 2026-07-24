import { describe, expect, it, afterEach } from 'vitest';
import { guardResolvedHost, guardResolvedServeTarget, type LookupAll } from '../../src/watch/ssrf.js';

// A `dns.lookup(host, {all:true}, cb)` stub returning fixed addresses.
function mockLookup(addrs: { address: string; family: number }[]): LookupAll {
  return (_host, _opts, cb) => cb(null, addrs);
}

describe('guardResolvedServeTarget (fetch-time SSRF re-check, serve mode)', () => {
  afterEach(() => {
    delete process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS;
  });

  it('blocks a hostname that resolves to a cloud-metadata IP (169.254.169.254)', async () => {
    const r = await guardResolvedServeTarget('metadata.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_metadata');
  });

  it('blocks a hostname that resolves to an RFC-1918 private IP by default', async () => {
    const r = await guardResolvedServeTarget('internal.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_private_target');
  });

  it('allows the same private IP when allowPrivate is set (parity with guardFetchUrl)', async () => {
    const r = await guardResolvedServeTarget('nas.home.example', 'url', {
      bindIsLoopback: false,
      allowPrivate: true,
      lookup: mockLookup([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('blocks metadata even when allowPrivate is set (parity with guardFetchUrl)', async () => {
    const r = await guardResolvedServeTarget('metadata.evil.example', 'url', {
      bindIsLoopback: false,
      allowPrivate: true,
      lookup: mockLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(r.ok).toBe(false);
  });

  it('allows a hostname that resolves to an ordinary public IP', async () => {
    const r = await guardResolvedServeTarget('example.com', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '93.184.216.34', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a hostname that resolves to loopback (127.0.0.1) under a non-loopback bind', async () => {
    const r = await guardResolvedServeTarget('sneaky.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_private_target');
  });

  it('refuses a hostname that resolves to IPv6 loopback (::1) under a non-loopback bind', async () => {
    const r = await guardResolvedServeTarget('sneaky6.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '::1', family: 6 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_private_target');
  });

  it('allows a hostname that resolves to loopback when the server itself is bound to loopback', async () => {
    const r = await guardResolvedServeTarget('localhost.evil.example', 'url', {
      bindIsLoopback: true,
      lookup: mockLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('allows a resolved loopback under a non-loopback bind when WIGOLO_SERVE_ALLOW_LOCAL_TARGETS=1', async () => {
    process.env.WIGOLO_SERVE_ALLOW_LOCAL_TARGETS = '1';
    const r = await guardResolvedServeTarget('sneaky.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when ANY resolved address is blocked (multi-record DNS)', async () => {
    const r = await guardResolvedServeTarget('mixed.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: mockLookup([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    });
    expect(r.ok).toBe(false);
  });

  it('falls through (ok:true) for a name that does not resolve — no IP to connect to, not a bypass', async () => {
    const r = await guardResolvedServeTarget('nx.evil.example', 'url', {
      bindIsLoopback: false,
      lookup: (_h, _o, cb) => cb(new Error('ENOTFOUND'), []),
    });
    expect(r.ok).toBe(true);
  });
});

describe('guardResolvedHost — loopback allowance (plain fetch/crawl policy)', () => {
  it('allows a hostname that resolves to loopback (127.0.0.1) — local dev servers keep working', async () => {
    const r = await guardResolvedHost('devserver.evil.example', 'target', {
      lookup: mockLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });
});
