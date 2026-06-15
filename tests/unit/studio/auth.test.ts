import { describe, it, expect } from 'vitest';
import { mintHostToken, checkAuth, checkOriginHost, resolveHostToken } from '../../../src/studio/auth.js';

describe('studio/auth', () => {
  describe('mintHostToken', () => {
    it('returns a url-safe token of at least 32 chars, unique per call', () => {
      const a = mintHostToken();
      const b = mintHostToken();
      expect(a.length).toBeGreaterThanOrEqual(32);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(a).not.toBe(b);
    });
  });

  describe('checkAuth', () => {
    const token = 'studio-token-abc123';

    it('rejects a missing Authorization header', () => {
      expect(checkAuth({ headers: {} }, token)).toMatchObject({ ok: false });
    });

    it('rejects a non-bearer scheme', () => {
      expect(checkAuth({ headers: { authorization: token } }, token)).toMatchObject({ ok: false });
    });

    it('rejects a wrong bearer token', () => {
      expect(checkAuth({ headers: { authorization: 'Bearer wrong' } }, token)).toMatchObject({ ok: false });
    });

    it('rejects a bearer token of a different length without throwing', () => {
      // timingSafeEqual throws on length mismatch — the guard must handle it.
      expect(() => checkAuth({ headers: { authorization: 'Bearer x' } }, token)).not.toThrow();
      expect(checkAuth({ headers: { authorization: 'Bearer x' } }, token)).toMatchObject({ ok: false });
    });

    it('accepts a matching bearer token', () => {
      expect(checkAuth({ headers: { authorization: `Bearer ${token}` } }, token)).toEqual({ ok: true });
    });

    it('rejects when the expected token is empty (misconfiguration self-defense)', () => {
      // An empty expected token must never authenticate, even with `Bearer ` (empty provided).
      expect(checkAuth({ headers: { authorization: 'Bearer ' } }, '')).toMatchObject({ ok: false });
      expect(checkAuth({ headers: { authorization: 'Bearer anything' } }, '')).toMatchObject({ ok: false });
    });
  });

  describe('resolveHostToken', () => {
    it('uses an operator-supplied token verbatim (stable across restarts), minted=false', () => {
      expect(resolveHostToken('operator-pinned-token')).toEqual({ token: 'operator-pinned-token', minted: false });
    });

    it('trims surrounding whitespace on a supplied token', () => {
      expect(resolveHostToken('  pinned  ')).toEqual({ token: 'pinned', minted: false });
    });

    it('mints a fresh token when none is supplied (null/empty/whitespace), minted=true', () => {
      for (const supplied of [null, undefined, '', '   ']) {
        const r = resolveHostToken(supplied);
        expect(r.minted).toBe(true);
        expect(r.token).toHaveLength(43);
      }
    });
  });

  describe('checkOriginHost', () => {
    const expected = { host: '127.0.0.1', port: 7777 };

    it('allows a request with no Origin (non-browser client like the proxy)', () => {
      expect(checkOriginHost({ headers: { host: '127.0.0.1:7777' } }, expected)).toEqual({ ok: true });
    });

    it('allows a loopback Origin', () => {
      expect(
        checkOriginHost({ headers: { origin: 'http://127.0.0.1:7777', host: '127.0.0.1:7777' } }, expected),
      ).toEqual({ ok: true });
    });

    it('allows a localhost Host header when bound to 127.0.0.1', () => {
      expect(checkOriginHost({ headers: { host: 'localhost:7777' } }, expected)).toEqual({ ok: true });
    });

    it('rejects a cross-origin request (DNS-rebinding defense)', () => {
      expect(
        checkOriginHost({ headers: { origin: 'http://evil.com', host: '127.0.0.1:7777' } }, expected),
      ).toMatchObject({ ok: false });
    });

    it('rejects a foreign Host header', () => {
      expect(checkOriginHost({ headers: { host: 'evil.com' } }, expected)).toMatchObject({ ok: false });
    });
  });
});
