import { describe, it, expect } from 'vitest';
import { Session } from '../../../src/studio/session.js';

describe('studio/Session', () => {
  it('creates an active session with token, endpoint, timestamps, and zero clients', () => {
    const s = new Session({ endpoint: 'http://127.0.0.1:7777', now: () => 1000 });
    expect(s.id).toBeTruthy();
    expect(s.token).toHaveLength(43); // base64url of 32 random bytes
    expect(s.endpoint).toBe('http://127.0.0.1:7777');
    expect(s.status).toBe('active');
    expect(s.clients).toBe(0);
    expect(s.createdAt).toBe(1000);
    expect(s.lastActiveAt).toBe(1000);
  });

  it('attach/detach track the client count and refresh lastActiveAt', () => {
    let t = 1000;
    const s = new Session({ endpoint: 'e', now: () => t });
    t = 2000;
    s.attach();
    expect(s.clients).toBe(1);
    expect(s.lastActiveAt).toBe(2000);
    t = 3000;
    s.attach();
    expect(s.clients).toBe(2);
    t = 4000;
    s.detach();
    expect(s.clients).toBe(1);
    expect(s.lastActiveAt).toBe(4000);
  });

  it('detach never drops the client count below zero', () => {
    const s = new Session({ endpoint: 'e' });
    s.detach();
    expect(s.clients).toBe(0);
  });

  it('markIdle parks the session; touch reactivates it; close is terminal', () => {
    let t = 1000;
    const s = new Session({ endpoint: 'e', now: () => t });
    s.markIdle();
    expect(s.status).toBe('idle');
    t = 5000;
    s.touch();
    expect(s.status).toBe('active');
    expect(s.lastActiveAt).toBe(5000);
    s.close();
    expect(s.status).toBe('closed');
  });

  it('accepts an injected id and token (for handle restore)', () => {
    const s = new Session({ endpoint: 'e', id: 'fixed-id', token: 'fixed-token' });
    expect(s.id).toBe('fixed-id');
    expect(s.token).toBe('fixed-token');
  });

  it('snapshot() returns a plain serializable view', () => {
    const s = new Session({ endpoint: 'e', id: 'sid', token: 'tok', now: () => 42 });
    expect(s.snapshot()).toEqual({
      id: 'sid',
      token: 'tok',
      endpoint: 'e',
      status: 'active',
      clients: 0,
      createdAt: 42,
      lastActiveAt: 42,
    });
  });
});
