import { describe, it, expect } from 'vitest';
import { mintHostToken, checkAuth, checkAuthSubprotocol, checkOriginHost, resolveHostToken } from '../../../src/companion/auth.js';

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

    it('rejects an opaque "null" Origin (a data:/sandboxed-iframe page in the studio browser) — closed-default, not a loopback allowance', () => {
      // A prompt-injected page served from data: or inside a sandboxed iframe sends `Origin: null`.
      // It must NOT slip through the loopback allowance — the approval-channel boundary (and the
      // whole DNS-rebind defense) depends on an unrecognized origin being rejected, never defaulted open.
      expect(checkOriginHost({ headers: { origin: 'null', host: '127.0.0.1:7777' } }, expected)).toMatchObject({ ok: false });
    });
  });

  describe('checkAuthSubprotocol', () => {
    // Browsers cannot set an Authorization header on a WebSocket, so the host
    // accepts the bearer via the WS subprotocol: new WebSocket(url, ['wigolo.bearer.<token>']).
    const token = 'studio-token-abc123';

    it('rejects a missing sec-websocket-protocol header', () => {
      expect(checkAuthSubprotocol({ headers: {} }, token)).toMatchObject({ ok: false });
    });

    it('rejects a subprotocol list without a wigolo.bearer entry', () => {
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': 'chat, superchat' } }, token)).toMatchObject({ ok: false });
    });

    it('rejects a wrong bearer token', () => {
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': 'wigolo.bearer.wrong' } }, token)).toMatchObject({ ok: false });
    });

    it('rejects a different-length token without throwing', () => {
      expect(() => checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': 'wigolo.bearer.x' } }, token)).not.toThrow();
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': 'wigolo.bearer.x' } }, token)).toMatchObject({ ok: false });
    });

    it('accepts a matching wigolo.bearer.<token> subprotocol', () => {
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': `wigolo.bearer.${token}` } }, token)).toEqual({ ok: true });
    });

    it('accepts when the bearer is one of several offered subprotocols', () => {
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': `chat, wigolo.bearer.${token}` } }, token)).toEqual({ ok: true });
    });

    it('rejects when the expected token is empty (misconfiguration self-defense)', () => {
      expect(checkAuthSubprotocol({ headers: { 'sec-websocket-protocol': 'wigolo.bearer.' } }, '')).toMatchObject({ ok: false });
    });

    it('does not accept a token supplied only via the Authorization header (WS uses the subprotocol channel)', () => {
      expect(checkAuthSubprotocol({ headers: { authorization: `Bearer ${token}` } }, token)).toMatchObject({ ok: false });
    });
  });
});

/**
 * The barrel is the only legal door: `exports` carries no wildcard, so a consumer outside core
 * cannot reach `src/companion/auth.js` deeply. Identity, not equivalence — a barrel that re-declared
 * a wrapper would pass a behavioural check while drifting from the daemon's own enforcement, which is
 * the single reason the trio is published rather than copied.
 */
describe('companion barrel publishes the daemon-route auth trio', () => {
  it('re-exports the same function objects the daemon imports directly', async () => {
    const barrel = await import('../../../src/companion/index.js');
    const direct = await import('../../../src/companion/auth.js');
    expect(barrel.checkAuth).toBe(direct.checkAuth);
    expect(barrel.checkAuthSubprotocol).toBe(direct.checkAuthSubprotocol);
    expect(barrel.checkOriginHost).toBe(direct.checkOriginHost);
  });
});
