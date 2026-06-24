import { describe, it, expect, vi } from 'vitest';
import { readNonce, exchangeNonceForToken, buildStreamConnect } from './handshake.js';

describe('Studio token handshake (S2 client)', () => {
  it('reads the one-time nonce from the tab URL', () => {
    expect(readNonce('?n=abc123')).toBe('abc123');
    expect(readNonce('?other=x')).toBeNull();
  });

  it('redeems the nonce for the bearer over POST /studio/token and scrubs the nonce', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/studio/token');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ nonce: 'NONCE-1' });
      return { ok: true, status: 200, json: async () => ({ token: 'SESSION-BEARER' }) } as Response;
    });
    const stripNonce = vi.fn();
    const token = await exchangeNonceForToken('NONCE-1', { fetch: fetchMock as unknown as typeof fetch, stripNonce });
    expect(token).toBe('SESSION-BEARER');
    expect(stripNonce).toHaveBeenCalledOnce();
  });

  it('throws (no token) when the exchange is rejected', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    await expect(exchangeNonceForToken('bad', { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/401/);
  });

  // PIN-S2a (CLIENT): the bearer rides the WS SUBPROTOCOL only — never the URL/query. NAMED mutation that
  // REDs: append `?token=${token}` (or otherwise put the bearer in the URL) in buildStreamConnect → the
  // token then appears in `.url` and this assertion fails.
  it('PIN-S2a: the stream URL carries NO bearer — the token rides the subprotocol only', () => {
    const conn = buildStreamConnect('sess-9', 'SUPER-SECRET-BEARER', 'http://127.0.0.1:7777');
    expect(conn.url).toBe('ws://127.0.0.1:7777/studio/sess-9/stream');
    expect(conn.url).not.toContain('SUPER-SECRET-BEARER');
    expect(conn.url).not.toContain('token');
    expect(conn.protocols).toContain('wigolo.bearer.SUPER-SECRET-BEARER');
    expect(conn.protocols).toContain('wigolo.stream');
  });

  it('maps https origin → wss', () => {
    expect(buildStreamConnect('s', 't', 'https://host:8443').url).toBe('wss://host:8443/studio/s/stream');
  });
});
