import { describe, it, expect } from 'vitest';
import { classifyHost, guardNavigation } from '../../../src/security/ssrf.js';

describe('classifyHost', () => {
  it('classifies public / loopback / private / link-local', () => {
    expect(classifyHost('example.com')).toBe('public');
    expect(classifyHost('8.8.8.8')).toBe('public');
    expect(classifyHost('localhost')).toBe('loopback');
    expect(classifyHost('127.0.0.1')).toBe('loopback');
    expect(classifyHost('0.0.0.0')).toBe('loopback');
    expect(classifyHost('10.0.0.5')).toBe('private');
    expect(classifyHost('192.168.1.1')).toBe('private');
    expect(classifyHost('172.16.0.1')).toBe('private');
    expect(classifyHost('172.15.0.1')).toBe('public'); // just outside 172.16/12
    expect(classifyHost('169.254.169.254')).toBe('link_local'); // cloud metadata
    expect(classifyHost('metadata.google.internal')).toBe('link_local');
    expect(classifyHost('[::1]')).toBe('loopback');
    expect(classifyHost('fe80::1')).toBe('link_local');
    expect(classifyHost('fc00::1')).toBe('private');
    expect(classifyHost('[::ffff:127.0.0.1]')).toBe('loopback'); // IPv4-mapped
    expect(classifyHost('[::808:808]')).toBe('public'); // 8.8.8.8 embedded — must not over-reject
  });
});

describe('guardNavigation — human policy', () => {
  it('allows localhost and RFC1918 (co-browsing a local dev server is a primary use case)', () => {
    expect(guardNavigation('http://localhost:3000/', { source: 'human' }).ok).toBe(true);
    expect(guardNavigation('http://127.0.0.1/', { source: 'human' }).ok).toBe(true);
    expect(guardNavigation('http://10.0.0.5/', { source: 'human' }).ok).toBe(true);
    expect(guardNavigation('http://192.168.1.50:8080/', { source: 'human' }).ok).toBe(true);
  });

  it('ALWAYS blocks cloud-metadata / link-local, even for the human', () => {
    expect(guardNavigation('http://169.254.169.254/latest/meta-data/', { source: 'human' }).ok).toBe(false);
    expect(guardNavigation('http://metadata.google.internal/', { source: 'human' }).ok).toBe(false);
  });

  it('blocks non-http(s) schemes', () => {
    expect(guardNavigation('file:///etc/passwd', { source: 'human' }).ok).toBe(false);
    expect(guardNavigation('javascript:alert(1)', { source: 'human' }).ok).toBe(false);
  });

  it('allows public', () => {
    expect(guardNavigation('https://example.com/', { source: 'human' }).ok).toBe(true);
  });
});

describe('guardNavigation — agent policy (blocked-by-default; ready to wire in Phase 2)', () => {
  it('blocks all private/loopback/link-local for the agent by default', () => {
    expect(guardNavigation('http://localhost/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://10.0.0.5/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://169.254.169.254/', { source: 'agent' }).ok).toBe(false);
  });

  it('allows public for the agent', () => {
    expect(guardNavigation('https://example.com/', { source: 'agent' }).ok).toBe(true);
  });

  it('an explicit allowPrivate grant relaxes loopback/RFC1918 but NEVER cloud-metadata', () => {
    expect(guardNavigation('http://localhost:3000/', { source: 'agent', allowPrivate: true }).ok).toBe(true);
    expect(guardNavigation('http://10.0.0.5/', { source: 'agent', allowPrivate: true }).ok).toBe(true);
    expect(guardNavigation('http://169.254.169.254/', { source: 'agent', allowPrivate: true }).ok).toBe(false);
  });

  it('allowPrivate:false overrides the human default (explicit deny)', () => {
    expect(guardNavigation('http://127.0.0.1/', { source: 'human', allowPrivate: false }).ok).toBe(false);
  });
});

describe('classifyHost — 6to4 (2002::/16) embedded IPv4 (Finding B)', () => {
  // Inputs are the WHATWG-normalized forms `new URL().hostname` actually produces.
  it('decodes the embedded IPv4 and blocks private/loopback/metadata', () => {
    expect(classifyHost('[2002:7f00:1::]')).toBe('loopback'); // 127.0.0.1
    expect(classifyHost('[2002:a00:1::]')).toBe('private'); // 10.0.0.1
    expect(classifyHost('[2002:c0a8:1::]')).toBe('private'); // 192.168.0.1
    expect(classifyHost('[2002:a9fe:a9fe::]')).toBe('link_local'); // 169.254.169.254
  });
  it('leaves a public embedded IPv4 public (no over-rejection)', () => {
    expect(classifyHost('[2002:808:808::]')).toBe('public'); // 8.8.8.8
    // leading-zero form normalizes to the canonical zero-stripped hostname the regex matches
    expect(new URL('http://[2002:0808:0808::]/').hostname).toBe('[2002:808:808::]');
    expect(classifyHost('[2002:808:808::]')).toBe('public');
  });
  it('decodes x.y.0.0 embeddings where the low hextet compresses away (regression: trailing-zero bypass)', () => {
    // 2002:7f00:0:: normalizes to [2002:7f00::] — one hextet — and must still decode.
    expect(classifyHost('[2002:7f00::]')).toBe('loopback'); // 127.0.0.0
    expect(classifyHost('[2002:a00::]')).toBe('private'); // 10.0.0.0
    expect(classifyHost('[2002:c0a8::]')).toBe('private'); // 192.168.0.0
    expect(classifyHost('[2002:a9fe::]')).toBe('link_local'); // 169.254.0.0 (metadata range)
    expect(classifyHost('[2002:808::]')).toBe('public'); // 8.8.0.0 — still public, no over-block
  });
  it('decodes a 172.16/12 embedding and is case-insensitive', () => {
    expect(classifyHost('[2002:ac10:1::]')).toBe('private'); // 172.16.0.1
    expect(classifyHost('[2002:AC10:1::]')).toBe('private'); // uppercase hex normalizes
  });
});

describe('classifyHost — NAT64 (64:ff9b::/96) embedded IPv4 (Finding B)', () => {
  it('decodes the embedded IPv4 and blocks private/loopback/metadata', () => {
    expect(classifyHost('[64:ff9b::a9fe:a9fe]')).toBe('link_local'); // 169.254.169.254
    expect(classifyHost('[64:ff9b::7f00:1]')).toBe('loopback'); // 127.0.0.1
    expect(classifyHost('[64:ff9b::a00:1]')).toBe('private'); // 10.0.0.1
    expect(classifyHost('[64:ff9b::c0a8:1]')).toBe('private'); // 192.168.0.1
  });
  it('leaves a public embedded IPv4 public (no over-rejection)', () => {
    expect(classifyHost('[64:ff9b::808:808]')).toBe('public'); // 8.8.8.8
  });
  it('decodes a trailing dotted-quad NAT64 form too (non-normalized caller defense)', () => {
    expect(classifyHost('[64:ff9b::169.254.169.254]')).toBe('link_local');
  });
  it('decodes a 172.16/12 embedding and an x.y.0.0 (trailing-zero) embedding', () => {
    expect(classifyHost('[64:ff9b::ac10:1]')).toBe('private'); // 172.16.0.1
    expect(classifyHost('[64:ff9b::7f00:0]')).toBe('loopback'); // 127.0.0.0 (NAT64 keeps the trailing :0)
  });
});

describe('guardNavigation — 6to4/NAT64 metadata blocked for BOTH parties (Finding B)', () => {
  it('blocks 6to4/NAT64 cloud-metadata regardless of source/allowPrivate', () => {
    expect(guardNavigation('http://[2002:a9fe:a9fe::]/latest/meta-data/', { source: 'human' }).ok).toBe(false);
    expect(guardNavigation('http://[64:ff9b::a9fe:a9fe]/', { source: 'human' }).ok).toBe(false);
    expect(guardNavigation('http://[64:ff9b::a9fe:a9fe]/', { source: 'agent', allowPrivate: true }).ok).toBe(false);
  });
  it('blocks a 6to4/NAT64 loopback embedding for the agent (allowPrivate:false default)', () => {
    expect(guardNavigation('http://[2002:7f00:1::]/', { source: 'agent' }).ok).toBe(false);
    expect(guardNavigation('http://[64:ff9b::7f00:1]/', { source: 'agent' }).ok).toBe(false);
  });
  it('still allows a public 6to4/NAT64 embedding', () => {
    expect(guardNavigation('http://[2002:808:808::]/', { source: 'agent' }).ok).toBe(true);
    expect(guardNavigation('http://[64:ff9b::808:808]/', { source: 'agent' }).ok).toBe(true);
  });
});
