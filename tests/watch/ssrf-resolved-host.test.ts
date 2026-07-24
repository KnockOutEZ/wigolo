import { describe, expect, it } from 'vitest';
import { guardResolvedHost, type LookupAll } from '../../src/watch/ssrf.js';

// A `dns.lookup(host, {all:true}, cb)` stub returning fixed addresses.
function mockLookup(addrs: { address: string; family: number }[]): LookupAll {
  return (_host, _opts, cb) => cb(null, addrs);
}

describe('guardResolvedHost (fetch-time SSRF re-check)', () => {
  it('blocks a hostname that resolves to a cloud-metadata IP (169.254.169.254)', async () => {
    const r = await guardResolvedHost('metadata.evil.example', 'target', {
      lookup: mockLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_metadata');
  });

  it('blocks a hostname that resolves to an RFC-1918 private IP by default', async () => {
    const r = await guardResolvedHost('internal.evil.example', 'target', {
      lookup: mockLookup([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ssrf_private_target');
  });

  it('allows the same private IP when allowPrivate is set (parity with guardFetchUrl)', async () => {
    const r = await guardResolvedHost('nas.home.example', 'target', {
      allowPrivate: true,
      lookup: mockLookup([{ address: '10.0.0.5', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('blocks metadata even when allowPrivate is set (parity with guardFetchUrl)', async () => {
    const r = await guardResolvedHost('metadata.evil.example', 'target', {
      allowPrivate: true,
      lookup: mockLookup([{ address: '169.254.169.254', family: 4 }]),
    });
    expect(r.ok).toBe(false);
  });

  it('allows a hostname that resolves to a public IP', async () => {
    const r = await guardResolvedHost('example.com', 'target', {
      lookup: mockLookup([{ address: '93.184.216.34', family: 4 }]),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when ANY resolved address is blocked (multi-record DNS)', async () => {
    const r = await guardResolvedHost('mixed.evil.example', 'target', {
      lookup: mockLookup([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
    });
    expect(r.ok).toBe(false);
  });

  it('blocks an IPv6 unique-local resolution (fd00::/7)', async () => {
    const r = await guardResolvedHost('v6.evil.example', 'target', {
      lookup: mockLookup([{ address: 'fd00::1', family: 6 }]),
    });
    expect(r.ok).toBe(false);
  });

  it('falls through (ok:true) for a name that does not resolve — no IP to connect to, not a bypass', async () => {
    const r = await guardResolvedHost('nx.evil.example', 'target', {
      lookup: (_h, _o, cb) => cb(new Error('ENOTFOUND'), []),
    });
    expect(r.ok).toBe(true);
  });
});
