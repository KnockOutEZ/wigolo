/**
 * The refresh policy (A-212-13 + PX1 §2 ep3).
 *
 * Every time decision here runs on an INJECTED clock — no `vi.useFakeTimers`,
 * no sleeping — so the 24 h throttle is asserted at its real boundary rather
 * than at a scaled-down stand-in.
 *
 * The client is a REAL `AccountsClient` over a scripted `fetchImpl`, not a
 * stub: the branches under test key off `kind`/`code`, and those are produced
 * by the client's classifier. A hand-rolled stub would let this file agree with
 * itself while the classifier drifted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/security/keychain.js', () => {
  const store = new Map<string, string>();
  return {
    WIGOLO_SERVICE: 'wigolo',
    keychainAvailable: vi.fn(() => true),
    keychainSet: vi.fn((service: string, user: string, value: string) => { store.set(`${service}:${user}`, value); }),
    keychainGet: vi.fn((service: string, user: string) => store.get(`${service}:${user}`) ?? null),
    keychainDelete: vi.fn((service: string, user: string) => { store.delete(`${service}:${user}`); }),
    _store: store,
  };
});

const keychainMod = await import('../../../src/security/keychain.js');
const { _store } = keychainMod as typeof keychainMod & { _store: Map<string, string> };

const { AccountsClient } = await import('../../../src/account/client.js');
const { AccountStateStore } = await import('../../../src/account/state.js');
const { storeRefreshToken, readRefreshToken, getAccessToken, _resetAccessTokenCache } =
  await import('../../../src/account/token-store.js');
const { maybeRefresh, REFRESH_THROTTLE_MS } = await import('../../../src/account/refresh.js');

const BASE = 'http://127.0.0.1:8787';
const T0 = Date.parse('2026-09-01T12:00:00.000Z');

type Handler = (body: unknown) => Response;

/** Scripted transport. Each path holds a queue; the last handler repeats. */
function transport(routes: Record<string, Handler[]>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  hits: string[];
} {
  const hits: string[] = [];
  const queues: Record<string, Handler[]> = { ...routes };
  return {
    hits,
    fetchImpl: async (url, init) => {
      const path = url.slice(BASE.length);
      hits.push(path);
      const q = queues[path];
      if (!q || q.length === 0) throw new Error(`unscripted path: ${path}`);
      const handler = q.length === 1 ? q[0]! : q.shift()!;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return handler(body);
    },
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const errJson = (status: number, code: string): Response =>
  json(status, { error: { code, message: code } });

const refreshOk = (next: string, expires = '2026-12-01T00:00:00.000Z'): Handler => () =>
  json(200, {
    access_token: `access-for-${next}`,
    access_expires_in_s: 900,
    refresh_token: next,
    refresh_expires_at: expires,
  });

const entitlementOk = (token = 'v1.kid.payload.sig'): Handler => () =>
  json(200, { token, valid_until: '2026-09-08T12:00:00.000Z', kid: 'kid' });

let dataDir: string;

beforeEach(() => {
  _store.clear();
  _resetAccessTokenCache();
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-acct-refresh-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('throttle', () => {
  it('makes no request when the last attempt was inside 24h', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({
      last_refresh_attempt_at: new Date(T0).toISOString(),
    });

    const t = transport({ '/auth/refresh': [refreshOk('refresh-2')] });
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0 + REFRESH_THROTTLE_MS - 1,
    });

    expect(out).toEqual({ status: 'throttled', nextEligibleAtMs: T0 + REFRESH_THROTTLE_MS });
    expect(t.hits).toEqual([]);
  });

  it('attempts again one millisecond past the 24h boundary', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({ last_refresh_attempt_at: new Date(T0).toISOString() });

    const t = transport({
      '/auth/refresh': [refreshOk('refresh-2')],
      '/entitlements/token': [entitlementOk()],
    });
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0 + REFRESH_THROTTLE_MS,
    });

    expect(out.status).toBe('refreshed');
    expect(t.hits).toContain('/auth/refresh');
  });

  it('force bypasses the throttle for the explicit verbs', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({ last_refresh_attempt_at: new Date(T0).toISOString() });

    const t = transport({
      '/auth/refresh': [refreshOk('refresh-2')],
      '/entitlements/token': [entitlementOk()],
    });
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0 + 1000,
      force: true,
    });
    expect(out.status).toBe('refreshed');
  });

  it('stamps the attempt BEFORE the request, so an outage still burns the window', async () => {
    // If the stamp landed only on a response, every process start during an
    // outage would retry and the 24h throttle would exist only on paper.
    await storeRefreshToken('refresh-1', { dataDir });
    const t = transport({ '/auth/refresh': [() => { throw new Error('ECONNREFUSED'); }] });

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });
    expect(out.status).toBe('transient');
    expect(new AccountStateStore(dataDir).read().last_refresh_attempt_at).toBe(new Date(T0).toISOString());

    // The very next process start is throttled.
    const second = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0 + 60_000,
    });
    expect(second.status).toBe('throttled');
  });

  it('the stamp is already on disk WHILE the request is in flight', async () => {
    // The stronger form of the arm above, and the one a request that never
    // returns depends on: a crash or a hang mid-request must still have burnt
    // the window. Asserting the stamp only after the call returns is satisfied
    // by a stamp written on the way out, which is exactly the ordering bug.
    await storeRefreshToken('refresh-1', { dataDir });
    let stampDuringFlight: string | null = 'unset';
    const fetchImpl = async (): Promise<Response> => {
      stampDuringFlight = new AccountStateStore(dataDir).read().last_refresh_attempt_at;
      throw new Error('process killed mid-request');
    };

    await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });
    expect(stampDuringFlight).toBe(new Date(T0).toISOString());
  });

  it('reports no_credential without stamping an attempt', async () => {
    const t = transport({});
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });
    expect(out).toEqual({ status: 'no_credential' });
    expect(new AccountStateStore(dataDir).read().last_refresh_attempt_at).toBeNull();
  });
});

describe('success path', () => {
  it('persists the rotated credential, the expiry, the entitlement and the access token', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    const t = transport({
      '/auth/refresh': [refreshOk('refresh-2', '2026-11-30T00:00:00.000Z')],
      '/entitlements/token': [entitlementOk('v1.kid.NEW.sig')],
    });

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });

    expect(out).toEqual({ status: 'refreshed', entitlementUpdated: true, racedRetry: false });
    expect((await readRefreshToken({ dataDir }))!.value).toBe('refresh-2');

    const s = new AccountStateStore(dataDir).read();
    expect(s.refresh_expires_at).toBe('2026-11-30T00:00:00.000Z');
    expect(s.entitlement_token).toBe('v1.kid.NEW.sig');
    expect(s.last_refresh_at).toBe(new Date(T0).toISOString());
    expect(s.needs_relogin).toBe(false);

    expect(getAccessToken({ dataDir }, T0)).toBe('access-for-refresh-2');
  });

  it('clears needs_relogin once a refresh succeeds again', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({ needs_relogin: true });
    const t = transport({
      '/auth/refresh': [refreshOk('refresh-2')],
      '/entitlements/token': [entitlementOk()],
    });
    await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });
    expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(false);
  });

  it('does NOT stamp last_refresh_at when the entitlement fetch fails', async () => {
    // Grace is measured from the last time we actually learned the grants.
    // Stamping on the auth rotation alone would silently extend grace on an
    // install whose entitlements have not been read for weeks.
    await storeRefreshToken('refresh-1', { dataDir });
    new AccountStateStore(dataDir).write({
      last_refresh_at: '2026-08-01T00:00:00.000Z',
      entitlement_token: 'v1.kid.OLD.sig',
    });
    const t = transport({
      '/auth/refresh': [refreshOk('refresh-2')],
      '/entitlements/token': [() => errJson(500, 'internal')],
    });

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });

    expect(out).toEqual({ status: 'refreshed', entitlementUpdated: false, racedRetry: false });
    const s = new AccountStateStore(dataDir).read();
    expect(s.last_refresh_at).toBe('2026-08-01T00:00:00.000Z');
    expect(s.entitlement_token).toBe('v1.kid.OLD.sig');
    // The rotation itself still landed — losing it would strand the install.
    expect((await readRefreshToken({ dataDir }))!.value).toBe('refresh-2');
  });
});

describe('PX1 §2 ep3 failure taxonomy', () => {
  for (const code of ['refresh_reused', 'refresh_expired', 'invalid_token']) {
    it(`${code} sets needs_relogin and leaves the entitlement token untouched`, async () => {
      await storeRefreshToken('refresh-1', { dataDir });
      new AccountStateStore(dataDir).write({
        entitlement_token: 'v1.kid.PERPETUAL.sig',
        last_refresh_at: '2026-08-01T00:00:00.000Z',
      });

      const t = transport({ '/auth/refresh': [() => errJson(401, code)] });
      const out = await maybeRefresh({
        dataDir,
        client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
        nowMs: () => T0,
      });

      expect(out).toEqual({ status: 'needs_relogin', code });
      const s = new AccountStateStore(dataDir).read();
      expect(s.needs_relogin).toBe(true);
      // A dead credential is a re-login prompt, never a downgrade: a perpetual
      // grant keeps governing the gate (brief §3).
      expect(s.entitlement_token).toBe('v1.kid.PERPETUAL.sig');
      expect(s.last_refresh_at).toBe('2026-08-01T00:00:00.000Z');
      // Exactly one attempt — no retry on an unambiguous death.
      expect(t.hits).toEqual(['/auth/refresh']);
    });
  }

  it('a network failure is silent: no needs_relogin, nothing else persisted', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    const t = transport({ '/auth/refresh': [() => { throw new TypeError('fetch failed'); }] });
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });
    expect(out.status).toBe('transient');
    expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(false);
  });

  it('a 5xx and a 429 are transient, not credential deaths', async () => {
    for (const [status, code] of [[500, 'internal'], [429, 'rate_limited']] as const) {
      await storeRefreshToken('refresh-1', { dataDir });
      new AccountStateStore(dataDir).write({ last_refresh_attempt_at: null });
      const t = transport({ '/auth/refresh': [() => errJson(status, code)] });
      const out = await maybeRefresh({
        dataDir,
        client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
        nowMs: () => T0,
        force: true,
      });
      expect(out).toEqual({ status: 'transient', code });
      expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(false);
    }
  });

  it('a 502 with no error envelope is transient, never read as a service verdict', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    const t = transport({ '/auth/refresh': [() => new Response('<html>502</html>', { status: 502 })] });
    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });
    expect(out.status).toBe('transient');
    expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(false);
  });
});

describe('invalid_refresh — the 30-second race', () => {
  it('re-reads the store and retries once when another process rotated under us', async () => {
    await storeRefreshToken('refresh-1', { dataDir });

    const presented: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = url.slice(BASE.length);
      if (path === '/entitlements/token') return entitlementOk('v1.kid.RACED.sig')(undefined);

      const token = (JSON.parse(String(init!.body)) as { refresh_token: string }).refresh_token;
      presented.push(token);
      if (token === 'refresh-1') {
        // A sibling process rotated <30s ago and has already written its
        // replacement to the store. PX1 answers our now-revoked token with a
        // benign `invalid_refresh` and does NOT revoke the family.
        await storeRefreshToken('refresh-2', { dataDir });
        return errJson(401, 'invalid_refresh');
      }
      return refreshOk('refresh-3')(undefined);
    };

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });

    // The retry presented the token the SIBLING wrote, not the one we started with.
    expect(presented).toEqual(['refresh-1', 'refresh-2']);
    expect(out).toEqual({ status: 'refreshed', entitlementUpdated: true, racedRetry: true });
    expect((await readRefreshToken({ dataDir }))!.value).toBe('refresh-3');
    expect(new AccountStateStore(dataDir).read().entitlement_token).toBe('v1.kid.RACED.sig');
    expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(false);
  });

  it('retries at most once — a second invalid_refresh is a dead credential', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    const presented: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init!.body)) as { refresh_token: string };
      presented.push(body.refresh_token);
      if (body.refresh_token === 'refresh-1') {
        await storeRefreshToken('refresh-2', { dataDir });
      }
      return errJson(401, 'invalid_refresh');
    };

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });

    expect(presented).toEqual(['refresh-1', 'refresh-2']);
    expect(out).toEqual({ status: 'needs_relogin', code: 'invalid_refresh' });
    expect(new AccountStateStore(dataDir).read().needs_relogin).toBe(true);
  });

  it('does not retry when the store still holds the token the service rejected', async () => {
    // Nothing rotated, so there is nothing to retry WITH. PX1 answers an
    // unknown token with the same `invalid_refresh`, and an unknown token is
    // dead — a second presentation of the identical token could only fail again.
    await storeRefreshToken('refresh-1', { dataDir });
    const presented: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      presented.push((JSON.parse(String(init!.body)) as { refresh_token: string }).refresh_token);
      return errJson(401, 'invalid_refresh');
    };

    const out = await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl }),
      nowMs: () => T0,
    });

    expect(presented).toEqual(['refresh-1']);
    expect(out).toEqual({ status: 'needs_relogin', code: 'invalid_refresh' });
  });
});

describe('no secret reaches the state file', () => {
  it('state.json never contains the refresh or access token', async () => {
    await storeRefreshToken('refresh-1', { dataDir });
    const t = transport({
      '/auth/refresh': [refreshOk('refresh-SECRET-2')],
      '/entitlements/token': [entitlementOk()],
    });
    await maybeRefresh({
      dataDir,
      client: new AccountsClient({ baseUrl: BASE, fetchImpl: t.fetchImpl }),
      nowMs: () => T0,
    });

    const raw = readFileSync(new AccountStateStore(dataDir).path, 'utf8');
    expect(raw).not.toContain('refresh-SECRET-2');
    expect(raw).not.toContain('access-for-');
  });
});
