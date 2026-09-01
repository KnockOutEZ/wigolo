/**
 * `AccountsClient` — the never-throw contract and the failure taxonomy.
 *
 * The point of these arms is NOT that the happy paths parse. It is that the
 * four things a caller branches on survive the transport:
 *
 *   - a service error CODE arrives intact, because `refresh.ts` treats
 *     `invalid_refresh` and `refresh_reused` completely differently;
 *   - `kind` separates "the service decided" from "we never heard back", so a
 *     network outage can never be read as a dead credential;
 *   - a 200 with the wrong body is a FAILURE, not a success carrying undefined;
 *   - nothing throws, ever — a tool path calls this.
 *
 * Every arm injects `fetchImpl`, so no socket is opened and the suite's net
 * fence is never in play.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AccountsClient,
  CLIENT_TIMEOUT,
  CLIENT_NETWORK,
  CLIENT_MALFORMED,
  type FetchLike,
} from '../../../src/account/client.js';

const BASE = 'http://127.0.0.1:8787';

function jsonRes(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientReturning(res: Response | (() => Promise<Response>)): {
  client: AccountsClient;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return typeof res === 'function' ? res() : res;
  };
  return { client: new AccountsClient({ baseUrl: BASE, fetchImpl }), calls };
}

const VERIFY_OK = {
  account: { id: 'acct_1', email: 'a@example.com', created_at: '2026-09-01T00:00:00.000Z' },
  access_token: 'access.jwt',
  access_expires_in_s: 900,
  refresh_token: 'refresh-1',
  refresh_expires_at: '2026-12-01T00:00:00.000Z',
  telemetry_disclosure: { text: 'We collect…', version: '1' },
};

describe('AccountsClient — success shapes', () => {
  it('verify parses the PX1 §2 endpoint-2 body', async () => {
    const { client, calls } = clientReturning(jsonRes(200, VERIFY_OK));
    const res = await client.verify({ email: 'a@example.com', code: '123456' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.refresh_token).toBe('refresh-1');
    expect(res.data.account.id).toBe('acct_1');
    expect(calls[0]!.url).toBe(`${BASE}/auth/verify`);
  });

  it('omits marketing_consent when the caller did not set it', async () => {
    // PX1 applies its creation-only consent default only when the FIELD IS
    // ABSENT. Sending `false` by default would silently unsubscribe an existing
    // account on every re-verify.
    const { client, calls } = clientReturning(jsonRes(200, VERIFY_OK));
    await client.verify({ email: 'a@example.com', code: '123456' });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      email: 'a@example.com',
      code: '123456',
    });

    const second = clientReturning(jsonRes(200, VERIFY_OK));
    await second.client.verify({ email: 'a@example.com', code: '123456', marketingConsent: false });
    expect(JSON.parse(String(second.calls[0]!.init!.body))).toMatchObject({ marketing_consent: false });
  });

  it('bearer endpoints send Authorization and public ones do not', async () => {
    const withToken = clientReturning(jsonRes(200, { token: 'v1.k.p.s', valid_until: 'x', kid: 'k' }));
    await withToken.client.entitlementsToken('access.jwt');
    expect((withToken.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer access.jwt');

    const publicCall = clientReturning(jsonRes(200, { keys: [] }));
    await publicCall.client.entitlementsKeys();
    expect((publicCall.calls[0]!.init!.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('DELETE /account accepts a bodyless 204', async () => {
    const { client } = clientReturning(jsonRes(204, null));
    const res = await client.deleteAccount('access.jwt');
    expect(res.ok).toBe(true);
    expect(res.ok && res.status).toBe(204);
  });

  it('normalises a trailing slash on the base URL', async () => {
    const calls: string[] = [];
    const client = new AccountsClient({
      baseUrl: `${BASE}///`,
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonRes(202, {});
      },
    });
    await client.requestCode('a@example.com');
    expect(calls[0]).toBe(`${BASE}/auth/request-code`);
  });
});

describe('AccountsClient — failure taxonomy', () => {
  it('carries a service error code through verbatim with kind=http', async () => {
    for (const code of ['invalid_refresh', 'refresh_reused', 'refresh_expired', 'invalid_token']) {
      const { client } = clientReturning(jsonRes(401, { error: { code, message: 'nope' } }));
      const res = await client.refresh('refresh-1');
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.kind).toBe('http');
      expect(res.code).toBe(code);
      expect(res.status).toBe(401);
    }
  });

  it('surfaces retry_after_s from a 429 envelope', async () => {
    const { client } = clientReturning(
      jsonRes(429, { error: { code: 'rate_limited', message: 'slow down', retry_after_s: 42 } }),
    );
    const res = await client.requestCode('a@example.com');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe('rate_limited');
    expect(res.retryAfterS).toBe(42);
  });

  it('classifies a non-envelope error body as malformed, never as a service code', async () => {
    // A proxy or load balancer answering 502 with HTML must not be readable as
    // any member of the credential taxonomy.
    const client = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });
    const res = await client.refresh('refresh-1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('malformed');
    expect(res.code).toBe(CLIENT_MALFORMED);
    expect(res.status).toBe(502);
  });

  it('treats a 200 with the wrong shape as malformed rather than success', async () => {
    // The dangerous alternative: `data.refresh_token` is undefined and the
    // refresh policy persists it, destroying the credential.
    const { client } = clientReturning(jsonRes(200, { access_token: 'a', access_expires_in_s: 900 }));
    const res = await client.refresh('refresh-1');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.kind).toBe('malformed');
  });

  it('classifies a timeout separately from a network failure', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    const timeoutClient = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => { throw timeoutErr; },
    });
    const t = await timeoutClient.refresh('refresh-1');
    expect(t.ok).toBe(false);
    if (t.ok) throw new Error('unreachable');
    expect(t.kind).toBe('timeout');
    expect(t.code).toBe(CLIENT_TIMEOUT);
    expect(t.status).toBeNull();

    const netClient = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    const n = await netClient.refresh('refresh-1');
    expect(n.ok).toBe(false);
    if (n.ok) throw new Error('unreachable');
    expect(n.kind).toBe('network');
    expect(n.code).toBe(CLIENT_NETWORK);
  });

  it('never throws — every method resolves even when the transport explodes', async () => {
    const client = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => { throw new Error('socket hang up'); },
    });
    const results = await Promise.all([
      client.requestCode('a@example.com'),
      client.verify({ email: 'a@example.com', code: '1' }),
      client.refresh('r'),
      client.entitlementsToken('a'),
      client.entitlementsKeys(),
      client.account('a'),
      client.accountExport('a'),
      client.deleteAccount('a'),
      client.telemetryDisclosure(),
      client.telemetryBatch('a', { events: [] }),
    ]);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });
});

describe('AccountsClient — timeouts', () => {
  it('gives the export a longer leash than the auth calls', async () => {
    // Asserted through the signal the client actually attaches, not by reading
    // the constants back: a call that forgot to pass one would still pass a
    // constants comparison.
    const seen: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const client = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => jsonRes(200, { text: 't', version: '1', updated_at: 'x' }),
    });
    await client.telemetryDisclosure();
    seen.push(spy.mock.calls.at(-1)![0]);

    const exportClient = new AccountsClient({
      baseUrl: BASE,
      fetchImpl: async () => jsonRes(200, { account: {} }),
    });
    await exportClient.accountExport('a');
    seen.push(spy.mock.calls.at(-1)![0]);
    spy.mockRestore();

    expect(seen[0]).toBe(5000);
    expect(seen[1]).toBe(10000);
  });
});
