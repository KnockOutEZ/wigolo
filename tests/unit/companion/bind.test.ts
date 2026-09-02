import { describe, it, expect } from 'vitest';
import { checkBindHost, isLoopbackHost } from '../../../src/companion/bind.js';

describe('studio/bind', () => {
  describe('isLoopbackHost', () => {
    it('recognizes loopback addresses (case-insensitive)', () => {
      for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
        expect(isLoopbackHost(h)).toBe(true);
      }
    });

    it('treats wildcard + routable addresses as non-loopback', () => {
      for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1', 'example.com']) {
        expect(isLoopbackHost(h)).toBe(false);
      }
    });
  });

  describe('checkBindHost', () => {
    it('allows a loopback bind without requiring auth', () => {
      expect(checkBindHost('127.0.0.1', { allowRemote: false })).toEqual({ ok: true, requireAuth: false });
    });

    it('refuses a non-loopback bind without allowRemote, with a warning message', () => {
      const decision = checkBindHost('0.0.0.0', { allowRemote: false });
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe('remote_bind_forbidden');
        expect(decision.message).toMatch(/allow-remote/i);
      }
    });

    it('allows a non-loopback bind WITH allowRemote but forces auth on', () => {
      expect(checkBindHost('0.0.0.0', { allowRemote: true })).toEqual({ ok: true, requireAuth: true });
    });
  });
});
