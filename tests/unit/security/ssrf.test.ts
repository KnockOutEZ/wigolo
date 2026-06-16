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
